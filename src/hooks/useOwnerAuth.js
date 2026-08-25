import { useEffect, useState } from "react";
import {
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut as firebaseSignOut,
  updateProfile,
} from "firebase/auth";
import { doc, onSnapshot, serverTimestamp, setDoc, updateDoc } from "firebase/firestore";
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
      setProfile(snap.exists() ? snap.data() : null);
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
    await updateDoc(doc(db, "owners", auth.currentUser.uid), { name });
    await updateProfile(auth.currentUser, { displayName: name });
  }

  return { user, profile, authLoading, signUp, signIn, signOut, updateOwnerName };
}
