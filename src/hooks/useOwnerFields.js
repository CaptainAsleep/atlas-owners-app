import { useEffect, useState } from "react";
import { collection, doc, onSnapshot, orderBy, query, updateDoc, where } from "firebase/firestore";
import { db } from "../lib/firebase";

// Every field, for the "claim a field" search/browse flow. Same public
// data the player app already reads — no separate owner-facing copy of
// this data exists, it's literally the same documents.
export function useAllFields() {
  const [fields, setFields] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const unsub = onSnapshot(
      query(collection(db, "fields"), orderBy("name")),
      (snap) => {
        setFields(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
        setLoading(false);
      },
      (err) => {
        console.error("useAllFields error:", err);
        setLoading(false);
      }
    );
    return unsub;
  }, []);

  return { fields, fieldsLoading: loading };
}

// Just the fields this owner has actually claimed.
export function useMyFields(uid) {
  const [fields, setFields] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!uid) {
      setFields([]);
      setLoading(false);
      return;
    }
    const unsub = onSnapshot(
      query(collection(db, "fields"), where("ownerId", "==", uid)),
      (snap) => {
        setFields(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
        setLoading(false);
      },
      (err) => {
        console.error("useMyFields error:", err);
        setLoading(false);
      }
    );
    return unsub;
  }, [uid]);

  return { fields, fieldsLoading: loading };
}

// Fields this owner has a pending, unreviewed claim request on — website-
// less fields route here instead of instant ownership, since there's
// nothing to verify the claim against automatically yet.
export function useMyPendingClaims(uid) {
  const [fields, setFields] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!uid) {
      setFields([]);
      setLoading(false);
      return;
    }
    const unsub = onSnapshot(
      query(collection(db, "fields"), where("claimRequestedBy", "==", uid), where("claimPending", "==", true)),
      (snap) => {
        setFields(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
        setLoading(false);
      },
      (err) => {
        console.error("useMyPendingClaims error:", err);
        setLoading(false);
      }
    );
    return unsub;
  }, [uid]);

  return { fields, pendingLoading: loading };
}

export function useFieldActions() {
  // Two real paths, matching the Firestore rules exactly:
  //  - Fields with a known ownerEmailDomain (a real website on file) claim
  //    instantly IF the claiming account's email matches that domain — the
  //    domain match IS the verification, no human review needed.
  //  - Fields with no domain to verify against (Facebook-only fields, the
  //    Atlas Field test fixture) file a pending request instead, which
  //    only becomes a real claim via manual approval in the Firestore
  //    console — same "no admin panel yet" pattern used everywhere else.
  // Returns "claimed" or "pending" so the UI can show the right message.
  async function claimField(field, ownerEmail, ownerId) {
    if (field.ownerEmailDomain) {
      const emailDomain = (ownerEmail || "").split("@")[1];
      if (emailDomain !== field.ownerEmailDomain) {
        throw new Error(`This field's claim requires an account email ending in @${field.ownerEmailDomain}.`);
      }
      await updateDoc(doc(db, "fields", field.id), { ownerId, claimed: true });
      return "claimed";
    }
    await updateDoc(doc(db, "fields", field.id), { claimPending: true, claimRequestedBy: ownerId });
    return "pending";
  }

  // Accepts any subset of the same fields the player app already knows how
  // to display — about, hours, amenities (array), rules (array), chrono
  // ({aeg, sniper, dmr}), rentals (array of {name, price, includes,
  // availability}). Nothing new to build on the player side; it already
  // renders these if present.
  async function updateFieldProfile(fieldId, fields) {
    await updateDoc(doc(db, "fields", fieldId), fields);
  }

  return { claimField, updateFieldProfile };
}
