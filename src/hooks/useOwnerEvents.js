import { useEffect, useState } from "react";
import { collection, doc, onSnapshot, query, serverTimestamp, setDoc, updateDoc, where } from "firebase/firestore";
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
    //
    // Sorting is done client-side below rather than via orderBy("date") in
    // the query itself — combining a where("fieldId", "in", ...) filter
    // with orderBy on a DIFFERENT field requires a Firestore composite
    // index that was never created, which made this query fail silently
    // (caught by the error handler, leaving events permanently empty) —
    // exactly the "created events don't show up" bug.
    const unsub = onSnapshot(
      query(collection(db, "events"), where("fieldId", "in", fieldIds.slice(0, 10))),
      (snap) => {
        const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        list.sort((a, b) => (a.date || "").localeCompare(b.date || ""));
        setEvents(list);
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
  // Pre-generates an id without writing anything — lets the event-edit
  // screen upload a banner image to Storage (which needs a real id for its
  // path) before the event document itself actually exists yet.
  function newEventId() {
    return doc(collection(db, "events")).id;
  }

  async function createEvent(fieldId, fieldName, data, explicitId) {
    const ref = explicitId ? doc(db, "events", explicitId) : doc(collection(db, "events"));
    await setDoc(ref, { ...data, fieldId, fieldName });
    return ref.id;
  }

  async function updateEvent(eventId, data) {
    await updateDoc(doc(db, "events", eventId), data);
  }

  // Soft delete — a real Firestore deleteDoc would also orphan this
  // event's bookings subcollection (Firestore never cascades a delete to
  // subcollections), which is exactly what made a deleted event's booking
  // fee revenue vanish from the admin portal: its revenue query only ever
  // looks at bookings under events still present in the top-level events
  // collection. Marking it deleted instead keeps the event doc (and its
  // real booking/revenue history) intact and queryable — same tradeoff
  // already made for cancel — while restoreEvent below gives the owner a
  // way back if it was a mistake.
  async function deleteEvent(eventId) {
    await updateDoc(doc(db, "events", eventId), { deleted: true, deletedAt: serverTimestamp() });
  }

  async function restoreEvent(eventId) {
    await updateDoc(doc(db, "events", eventId), { deleted: false, deletedAt: null });
  }

  // Copies an existing event as a new draft — same details, new id, no
  // date carried over (forces the owner to actually pick one rather than
  // accidentally publishing a duplicate with the original's old date).
  async function duplicateEvent(original) {
    const { id, interestCount, ...rest } = original;
    const ref = doc(collection(db, "events"));
    await setDoc(ref, { ...rest, date: "", draft: true, title: `${original.title} (Copy)` });
    return ref.id;
  }

  return { createEvent, updateEvent, deleteEvent, restoreEvent, duplicateEvent, newEventId };
}
