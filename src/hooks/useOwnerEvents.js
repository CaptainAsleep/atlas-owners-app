import { useEffect, useState } from "react";
import { collection, doc, getDocs, onSnapshot, query, serverTimestamp, setDoc, updateDoc, where } from "firebase/firestore";
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

// Finds the owner's oldest finished-but-not-yet-celebrated event that
// actually had real money change hands, and computes what they'll receive
// from Atlas for it — the data behind the one-time "congrats on a
// successful event" popup shown on next login. Deliberately surfaces one
// event at a time (oldest first) rather than dumping a pile of past
// events on someone who hasn't logged in for a while; dismissing marks
// that event's payoutNoticeShown so it never resurfaces, and whatever's
// next in line takes its place automatically on the next render.
export function usePayoutCelebration(events) {
  const [candidateId, setCandidateId] = useState(null);
  const [revenueCents, setRevenueCents] = useState(0);
  const [checking, setChecking] = useState(false);
  // Belt-and-suspenders against the live Firestore listener's write not
  // having round-tripped back into `events` yet the instant dismiss()
  // fires — without this, the same just-dismissed event could get picked
  // again as "next candidate" for one render before payoutNoticeShown
  // actually shows up on its doc.
  const [dismissedIds, setDismissedIds] = useState(() => new Set());

  // Today, UTC-based date string — same convention already used
  // elsewhere in this app (e.g. FieldOverviewScreen) for "is this event
  // in the past" comparisons.
  const today = new Date().toISOString().slice(0, 10);

  const candidates = events
    .filter(
      (e) =>
        !e.draft &&
        !e.deleted &&
        !e.canceled &&
        !e.payoutNoticeShown &&
        !dismissedIds.has(e.id) &&
        (e.endDate || e.date) &&
        (e.endDate || e.date) < today
    )
    .sort((a, b) => (a.endDate || a.date).localeCompare(b.endDate || b.date));
  const candidatesKey = candidates.map((e) => e.id).join(",");

  useEffect(() => {
    if (candidateId || candidates.length === 0) return;
    const next = candidates[0];
    let cancelled = false;
    setChecking(true);
    getDocs(collection(db, "events", next.id, "bookings"))
      .then((snap) => {
        if (cancelled) return;
        // Same formula as useOwnerBookingRevenue — the owner's own share
        // of each paid booking (full price minus Atlas's booking fee).
        let cents = 0;
        snap.docs.forEach((d) => {
          const b = d.data();
          if (!b.paid || typeof b.amountPaidCents !== "number") return;
          cents += b.amountPaidCents - (typeof b.bookingFeeCents === "number" ? b.bookingFeeCents : 0);
        });
        if (cents > 0) {
          setCandidateId(next.id);
          setRevenueCents(cents);
        } else {
          // Nothing was actually paid for this one (a free event, or
          // nobody booked) — silently mark it handled instead of showing
          // an anticlimactic "$0.00, congrats!" popup. Also added to
          // dismissedIds immediately, same as the real dismiss path below —
          // otherwise this same zero-revenue event could get re-picked as
          // "next candidate" on the next render, before the Firestore
          // listener's update round-trips back into `events`.
          setDismissedIds((prev) => new Set(prev).add(next.id));
          updateDoc(doc(db, "events", next.id), { payoutNoticeShown: true }).catch(() => {});
        }
      })
      .catch((err) => console.error("usePayoutCelebration revenue check failed:", err))
      .finally(() => {
        if (!cancelled) setChecking(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candidatesKey, candidateId]);

  const celebrationEvent = candidateId ? events.find((e) => e.id === candidateId) || null : null;

  async function dismissCelebration() {
    if (!candidateId) return;
    const id = candidateId;
    setDismissedIds((prev) => new Set(prev).add(id));
    setCandidateId(null);
    setRevenueCents(0);
    try {
      await updateDoc(doc(db, "events", id), { payoutNoticeShown: true });
    } catch (err) {
      console.error("usePayoutCelebration dismiss failed:", err);
    }
  }

  return {
    celebrationEvent,
    celebrationRevenueCents: revenueCents,
    celebrationChecking: checking,
    dismissCelebration,
  };
}
