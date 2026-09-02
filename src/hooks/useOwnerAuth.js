import { useEffect, useState } from "react";
import {
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut as firebaseSignOut,
  updateProfile,
  EmailAuthProvider,
  reauthenticateWithCredential,
  updatePassword,
  deleteUser,
} from "firebase/auth";
import { collection, deleteDoc, doc, getDocs, onSnapshot, query, serverTimestamp, setDoc, updateDoc, where } from "firebase/firestore";
import { auth, db } from "../lib/firebase";

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
    const ownedFieldsSnap = await getDocs(query(collection(db, "fields"), where("ownerId", "==", uid)));
    await Promise.all(
      ownedFieldsSnap.docs.map((d) =>
        updateDoc(d.ref, { ownerId: null, claimed: false, ownerEmailDomain: null, claimPending: false, claimRequestedBy: null })
      )
    );

    await deleteDoc(doc(db, "owners", uid));
    await deleteUser(auth.currentUser);
  }

  return { user, profile, authLoading, signUp, signIn, signOut, updateOwnerName, acceptTerms, changePassword, deleteAccount };
}
