import { useEffect, useState } from "react";
import {
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signOut as firebaseSignOut,
  updateProfile,
  EmailAuthProvider,
  reauthenticateWithCredential,
  updatePassword,
  deleteUser,
} from "firebase/auth";
import { collection, deleteDoc, doc, getDocs, onSnapshot, query, serverTimestamp, setDoc, updateDoc, where } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { auth, db, functions } from "../lib/firebase";

export function useOwnerAuth() {
  const [user, setUser] = useState(null);
  const [profile, setProfile] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => {
      setUser(u);
      setAuthLoading(false);
    });
    return unsub;
  }, []);

  useEffect(() => {
    if (!user) {
      setProfile(null);
      return;
    }
    const unsub = onSnapshot(doc(db, "owners", user.uid), (snap) => {
      if (snap.exists()) {
        setProfile(snap.data());
      } else {
        // Self-healing backfill, same pattern used for player profiles —
        // an owner account can end up here if it ever signed in without
        // going through the normal signUp doc-creation step (e.g. the
        // same email/password already existed as a Firebase Auth user
        // from another app). Creates a real doc with sensible defaults
        // instead of leaving every future save broken.
        const fallbackName = user.displayName || user.email?.split("@")[0] || "Owner";
        setDoc(doc(db, "owners", user.uid), {
          email: user.email,
          name: fallbackName,
          createdAt: serverTimestamp(),
        }).catch((err) => console.error("owner doc backfill failed:", err));
      }
    });
    return unsub;
  }, [user]);

  async function signUp(email, password, name) {
    const cred = await createUserWithEmailAndPassword(auth, email, password);
    if (name) await updateProfile(cred.user, { displayName: name });
    await setDoc(doc(db, "owners", cred.user.uid), {
      email,
      name: name || email.split("@")[0],
      createdAt: serverTimestamp(),
    });
    return cred.user;
  }

  async function signIn(email, password) {
    await signInWithEmailAndPassword(auth, email, password);
  }

  // "Forgot password?" on the login screen. Signed-out by design. Atlas-
  // branded via the sendPasswordReset Cloud Function (Resend, link to
  // airsoftatlas.app/reset-password.html); if the function is unreachable,
  // falls back to Firebase's own default reset email so the person still
  // gets a link. Never reveals whether an account exists — resolves the
  // same way for unknown emails; only a malformed address throws.
  async function sendPasswordReset(email) {
    try {
      await httpsCallable(functions, "sendPasswordReset")({ email, app: "owner" });
    } catch (err) {
      if (err?.code === "functions/invalid-argument") {
        const e = new Error(err.message);
        e.code = "auth/invalid-email";
        throw e;
      }
      console.warn("sendPasswordReset failed, using Firebase's default email:", err?.code || err);
      try {
        await sendPasswordResetEmail(auth, email, { url: "https://ownerapp.airsoftatlas.app/" });
      } catch (err2) {
        if (err2?.code === "auth/user-not-found" || err2?.code === "auth/too-many-requests") return;
        throw err2;
      }
    }
  }

  async function signOut() {
    await firebaseSignOut(auth);
  }

  async function updateOwnerName(name) {
    if (!auth.currentUser) return;
    // merge:true instead of updateDoc — self-healing even if the backfill
    // above somehow hasn't run yet by the time this fires.
    await setDoc(doc(db, "owners", auth.currentUser.uid), { name }, { merge: true });
    await updateProfile(auth.currentUser, { displayName: name });
  }

  async function acceptTerms(version) {
    if (!auth.currentUser) return;
    await setDoc(
      doc(db, "owners", auth.currentUser.uid),
      { acceptedTermsVersion: version, acceptedTermsAt: serverTimestamp() },
      { merge: true }
    );
  }

  // Organizer agreement is accepted under its OWN keys, separate from the
  // field-owner acceptedTermsVersion above — the two roles have different
  // terms and one person can hold both.
  async function acceptOrganizerTerms(version) {
    if (!auth.currentUser) return;
    await setDoc(
      doc(db, "owners", auth.currentUser.uid),
      { acceptedOrganizerTermsVersion: version, acceptedOrganizerTermsAt: serverTimestamp() },
      { merge: true }
    );
  }

  // Self-declared roles — { fieldOwner, organizer }. UX tailoring ONLY: the
  // server never reads this for permissions or fees (those come from field
  // ownership, hostOwnerId, and the event's own isMajor flag).
  async function setAccountRoles(roles) {
    if (!auth.currentUser) return;
    await setDoc(
      doc(db, "owners", auth.currentUser.uid),
      { accountRoles: { fieldOwner: !!roles.fieldOwner, organizer: !!roles.organizer } },
      { merge: true }
    );
  }

  async function changePassword(currentPassword, newPassword) {
    if (!auth.currentUser?.email) return;
    const credential = EmailAuthProvider.credential(auth.currentUser.email, currentPassword);
    await reauthenticateWithCredential(auth.currentUser, credential);
    await updatePassword(auth.currentUser, newPassword);
  }

  // Requires re-authentication for the same reason it does in the player
  // app — irreversible, so Firebase correctly won't allow it on a stale
  // session. Also releases any fields this owner had claimed back to
  // unclaimed, rather than leaving them permanently stuck pointing at an
  // owner account that no longer exists — nobody else could ever claim or
  // manage that field again otherwise.
  async function deleteAccount(currentPassword) {
    if (!auth.currentUser?.email) return;
    const credential = EmailAuthProvider.credential(auth.currentUser.email, currentPassword);
    await reauthenticateWithCredential(auth.currentUser, credential);

    const uid = auth.currentUser.uid;
    // Organizer events outlive the owner doc (players hold tickets for them),
    // so refuse to delete while any are still live. Cancel them first (which
    // issues vouchers) — the Settings screen turns this code into a message.
    const hostedSnap = await getDocs(query(collection(db, "events"), where("hostOwnerId", "==", uid)));
    const now = new Date();
    const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const hasLive = hostedSnap.docs.some((d) => {
      const e = d.data();
      return !e.draft && !e.deleted && !e.canceled && (e.endDate || e.date || "") >= todayStr;
    });
    if (hasLive) {
      const err = new Error("Upcoming organizer events");
      err.code = "atlas/upcoming-events";
      throw err;
    }
    const ownedFieldsSnap = await getDocs(query(collection(db, "fields"), where("ownerId", "==", uid)));
    await Promise.all(
      ownedFieldsSnap.docs.map((d) =>
        updateDoc(d.ref, { ownerId: null, claimed: false, ownerEmailDomain: null, claimPending: false, claimRequestedBy: null })
      )
    );

    await deleteDoc(doc(db, "owners", uid));
    await deleteUser(auth.currentUser);
  }

  return { user, profile, authLoading, signUp, signIn, sendPasswordReset, signOut, updateOwnerName, acceptTerms, acceptOrganizerTerms, setAccountRoles, changePassword, deleteAccount };
}
