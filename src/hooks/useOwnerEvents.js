import { useEffect, useState } from "react";
import { collection, deleteDoc, doc, onSnapshot, orderBy, query, setDoc, updateDoc, where } from "firebase/firestore";
import { db } from "../lib/firebase";

// Every event across this owner's claimed field(s) — if they own more than
// one field, events from all of them show up together, tagged by field name
// in the UI so it's still clear which is which.
export function useOwnerEvents(fieldIds) {
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!fieldIds || fieldIds.length === 0) {
      setEvents([]);
      setLoading(false);
      return;
    }
    // Firestore's "in" filter caps at 10 values — plenty of headroom for
    // how many fields one owner realistically claims in this v1.
    const unsub = onSnapshot(
      query(collection(db, "events"), where("fieldId", "in", fieldIds.slice(0, 10)), orderBy("date")),
      (snap) => {
        setEvents(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
        setLoading(false);
      },
      (err) => {
        console.error("useOwnerEvents error:", err);
        setLoading(false);
      }
    );
    return unsub;
  }, [JSON.stringify(fieldIds)]);

  return { events, eventsLoading: loading };
}

export function useOwnerEventActions() {
  async function createEvent(fieldId, fieldName, data) {
    const ref = doc(collection(db, "events"));
    await setDoc(ref, { ...data, fieldId, fieldName });
    return ref.id;
  }

  async function updateEvent(eventId, data) {
    await updateDoc(doc(db, "events", eventId), data);
  }

  async function deleteEvent(eventId) {
    await deleteDoc(doc(db, "events", eventId));
  }

  return { createEvent, updateEvent, deleteEvent };
}
