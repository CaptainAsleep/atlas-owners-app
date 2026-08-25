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

export function useFieldActions() {
  async function claimField(fieldId, ownerId) {
    await updateDoc(doc(db, "fields", fieldId), { ownerId, claimed: true });
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
