import { useEffect, useState } from "react";
import { collection, collectionGroup, deleteDoc, doc, onSnapshot, query, serverTimestamp, where, writeBatch } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { auth, db, functions } from "../lib/firebase";
import { STAFF_AGREEMENT_VERSION } from "../legalText";

// Field Staff Logins (2026-10-27). Staff grants live at
// fields/{fieldId}/staff/{uid} (created only by the acceptStaffInvites Cloud
// Function); pending invites at fields/{fieldId}/staffInvites/{inviteId}
// (created only by inviteStaff). See firestore.rules and the project doc
// claude/atlas-staff-logins-scope.md.

export const STAFF_CAP = 20; // keep in sync with functions/staff.js

// This signed-in user's own staff grants, live — so an owner removing them
// takes effect on their screen right away. `loading` stays true until the
// first answer, so the app never flashes the owner role picker at staff.
export function useMyStaffGrants(uid) {
  const [grants, setGrants] = useState([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    if (!uid) {
      setGrants([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const unsub = onSnapshot(
      query(collectionGroup(db, "staff"), where("uid", "==", uid)),
      (snap) => {
        setGrants(snap.docs.map((d) => ({ id: d.id, fieldId: d.ref.parent.parent.id, ...d.data() })));
        setLoading(false);
      },
      (err) => {
        console.error("useMyStaffGrants error:", err);
        setGrants([]);
        setLoading(false);
      }
    );
    return unsub;
  }, [uid]);
  return { grants, grantsLoading: loading };
}

// Owner side: a field's staff and pending invites, live.
export function useFieldStaff(fieldId) {
  const [staff, setStaff] = useState([]);
  const [invites, setInvites] = useState([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    if (!fieldId) {
      setStaff([]);
      setInvites([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    let gotStaff = false;
    let gotInvites = false;
    const done = () => { if (gotStaff && gotInvites) setLoading(false); };
    const unsubStaff = onSnapshot(
      collection(db, "fields", fieldId, "staff"),
      (snap) => {
        const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        list.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
        setStaff(list);
        gotStaff = true;
        done();
      },
      (err) => { console.error("useFieldStaff staff error:", err); gotStaff = true; done(); }
    );
    const unsubInvites = onSnapshot(
      query(collection(db, "fields", fieldId, "staffInvites"), where("status", "==", "pending")),
      (snap) => {
        const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        list.sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0));
        setInvites(list);
        gotInvites = true;
        done();
      },
      (err) => { console.error("useFieldStaff invites error:", err); gotInvites = true; done(); }
    );
    return () => { unsubStaff(); unsubInvites(); };
  }, [fieldId]);
  return { staff, invites, staffLoading: loading };
}

export function staffErrorMessage(err) {
  const msg = err?.message || "";
  const code = err?.code || "";
  if (code.startsWith("functions/") && msg && !/^internal$/i.test(msg)) return msg;
  return "Something went wrong — try again, or reach out on Discord if it keeps happening.";
}

export async function inviteStaff(fieldId, name, email) {
  const res = await httpsCallable(functions, "inviteStaff")({ fieldId, name, email });
  return res.data;
}

export async function resendStaffInvite(fieldId, inviteId) {
  const res = await httpsCallable(functions, "inviteStaff")({ fieldId, resendInviteId: inviteId });
  return res.data;
}

export async function removeStaff(fieldId, staffUid) {
  await deleteDoc(doc(db, "fields", fieldId, "staff", staffUid));
}

export async function cancelStaffInvite(fieldId, inviteId) {
  await deleteDoc(doc(db, "fields", fieldId, "staffInvites", inviteId));
}

// Records acceptance of the current staff agreement on every grant that
// doesn't have it yet. Rules allow only these two fields, only by the staff
// member themselves, with the server's own timestamp.
export async function acceptStaffAgreement(grants) {
  const todo = grants.filter((g) => g.agreementVersion !== STAFF_AGREEMENT_VERSION);
  if (todo.length === 0) return;
  const batch = writeBatch(db);
  for (const g of todo) {
    batch.update(doc(db, "fields", g.fieldId, "staff", g.id), {
      agreementVersion: STAFF_AGREEMENT_VERSION,
      agreementAcceptedAt: serverTimestamp(),
    });
  }
  await batch.commit();
}

// Runs once per sign-in. { status: "none" | "verify" | "accepted", ... }.
// checkOnly: true for the "I've confirmed it" button — reloads the Auth user
// first (picks up a link clicked on another device) and never re-sends.
export async function runAcceptStaffInvites({ checkOnly = false } = {}) {
  if (checkOnly && auth.currentUser) {
    await auth.currentUser.reload();
    await auth.currentUser.getIdToken(true);
  }
  const res = await httpsCallable(functions, "acceptStaffInvites")(checkOnly ? { sendVerification: false } : {});
  return res.data || { status: "none" };
}
