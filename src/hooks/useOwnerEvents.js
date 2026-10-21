import { useEffect, useState } from "react";
import { collection, doc, getDocs, onSnapshot, query, serverTimestamp, setDoc, updateDoc, where } from "firebase/firestore";
import { db } from "../lib/firebase";

// Every event this account runs: events at the owner's claimed field(s) AND
// Atlas Major events they host elsewhere (hostOwnerId === uid, fieldId null).
// Two listeners merged by id — the sets never overlap (a Major has no
// fieldId; a field event has no hostOwnerId). Events from several fields
// show up together, tagged by field name in the UI.
export function useOwnerEvents(fieldIds, hostOwnerId) {
  const [fieldEvents, setFieldEvents] = useState([]);
  const [hostEvents, setHostEvents] = useState([]);
  const [fieldLoading, setFieldLoading] = useState(true);
  const [hostLoading, setHostLoading] = useState(true);

  useEffect(() => {
    if (!fieldIds || fieldIds.length === 0) {
      setFieldEvents([]);
      setFieldLoading(false);
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
        setFieldEvents(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
        setFieldLoading(false);
      },
      (err) => {
        console.error("useOwnerEvents (fields) error:", err);
        setFieldLoading(false);
      }
    );
    return unsub;
  }, [JSON.stringify(fieldIds)]);

  useEffect(() => {
    if (!hostOwnerId) {
      setHostEvents([]);
      setHostLoading(false);
      return;
    }
    // Single equality filter: no composite index, no 10-item cap.
    const unsub = onSnapshot(
      query(collection(db, "events"), where("hostOwnerId", "==", hostOwnerId)),
      (snap) => {
        setHostEvents(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
        setHostLoading(false);
      },
      (err) => {
        console.error("useOwnerEvents (host) error:", err);
        setHostLoading(false);
      }
    );
    return unsub;
  }, [hostOwnerId]);

  const byId = new Map();
  [...fieldEvents, ...hostEvents].forEach((e) => byId.set(e.id, e));
  const events = [...byId.values()].sort((a, b) => (a.date || "").localeCompare(b.date || ""));
  return { events, eventsLoading: fieldLoading || hostLoading };
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

  // Atlas Major event (organizer hosting at a venue that isn't their claimed
  // field): no field (fieldId: null), hosted by the account (hostOwnerId),
  // venue carried inline on the event. fieldName mirrors venueName on purpose
  // — the player app and ~a dozen display sites already render ev.fieldName
  // as "where", so a Major shows up correctly without touching them.
  // firestore.rules requires exactly this shape on create (isMajor +
  // hostOwnerId == uid + no fieldId + an owners/{uid} account).
  async function createMajorEvent(ownerUid, data, explicitId) {
    const ref = explicitId ? doc(db, "events", explicitId) : doc(collection(db, "events"));
    await setDoc(ref, {
      ...data,
      isMajor: true,
      hostOwnerId: ownerUid,
      fieldId: null,
      fieldName: data.venueName,
      createdAt: serverTimestamp(),
    });
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
    // Field events keep the original behavior. A Major copy additionally drops
    // per-event state (bookedCount, createdAt) so the duplicate starts clean.
    if (original.isMajor) {
      const { bookedCount, createdAt, ...majorRest } = rest;
      const ref = doc(collection(db, "events"));
      await setDoc(ref, { ...majorRest, date: "", draft: true, title: `${original.title} (Copy)`, createdAt: serverTimestamp() });
      return ref.id;
    }
    const ref = doc(collection(db, "events"));
    await setDoc(ref, { ...rest, date: "", draft: true, title: `${original.title} (Copy)` });
    return ref.id;
  }

  return { createEvent, createMajorEvent, updateEvent, deleteEvent, restoreEvent, duplicateEvent, newEventId };
}

// Finds the one just-finished event to show on the Dashboard's
// After-Action Report banner - replaces the old usePayoutCelebration
// popup entirely (2026-09-28, per Michael: one richer touchpoint
// instead of two overlapping "your event just happened" surfaces).
//
// "Just finished" means (endDate||date) is exactly yesterday, UTC ISO
// date string - same convention usePayoutCelebration used, not
// localDateStr() (which the Dashboard's own upcoming-filter uses for a
// different purpose). The banner is a full-calendar-day window, not a
// literal 24-hour timer - startTime/endTime are owner-typed free text,
// not strict picker values, so a precise timestamp comparison would be
// fragile.
//
// Real edge case: two events sharing the same end date (e.g. a field
// running 9am-2pm then 3pm-8pm the same day). Per Michael: show exactly
// one banner, the newer event replaces the older. Since every eligible
// event here already shares the identical "yesterday" date by
// construction, this only ever matters for that same-day case - resolved
// by a best-effort compare of endTime/startTime free text, falling back
// to array order (stable but arbitrary, same order useOwnerEvents
// already returns) when unparseable.
//
// Zero reservations -> no banner at all (per Michael: don't want to
// highlight that nobody showed up). This is a different skip condition
// than the old usePayoutCelebration's zero-*revenue* skip - a free event
// with real signups but no money involved still gets a banner here.
function parseTimeToMinutes(str) {
  const m = (str || "").match(/(\d{1,2}):?(\d{2})?\s*(am|pm)?/i);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = m[2] ? parseInt(m[2], 10) : 0;
  const ampm = m[3]?.toLowerCase();
  if (Number.isNaN(h) || h > 23) return null;
  if (ampm === "pm" && h < 12) h += 12;
  if (ampm === "am" && h === 12) h = 0;
  return h * 60 + min;
}

export function useAfterActionCandidate(events) {
  const [banner, setBanner] = useState(null); // null | { event, reservedCount, checkedInCount, revenueCents }
  const [checking, setChecking] = useState(false);

  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const eligible = events.filter(
    (e) => !e.draft && !e.deleted && !e.canceled && (e.endDate || e.date) === yesterday
  );
  // Newest first: same-day tiebreak by end/start time text, else stable
  // array order (already date-sorted by useOwnerEvents, so a same-date
  // tie preserves whatever order Firestore returned them in).
  const sorted = [...eligible].sort((a, b) => {
    const aTime = parseTimeToMinutes(a.endTime || a.startTime);
    const bTime = parseTimeToMinutes(b.endTime || b.startTime);
    if (aTime != null && bTime != null) return bTime - aTime;
    return 0;
  });
  const candidate = sorted[0] || null;
  const candidateId = candidate?.id || null;

  useEffect(() => {
    if (!candidateId) {
      setBanner(null);
      return;
    }
    let cancelled = false;
    setChecking(true);
    getDocs(collection(db, "events", candidateId, "bookings"))
      .then((snap) => {
        if (cancelled) return;
        // isTest bookings (internal QR check-in rehearsals) don't count.
        const realDocs = snap.docs.filter((d) => !d.data().isTest);
        if (realDocs.length === 0) {
          // Zero reservations - suppress the banner entirely, per
          // Michael, rather than falling back to an older event still
          // inside its own visible window.
          setBanner(null);
          return;
        }
        let reservedCount = 0;
        let checkedInCount = 0;
        let revenueCents = 0;
        realDocs.forEach((d) => {
          const b = d.data();
          reservedCount += 1;
          if (b.checkedIn) checkedInCount += 1;
          if (b.paid && typeof b.amountPaidCents === "number") {
            revenueCents += b.amountPaidCents - (typeof b.bookingFeeCents === "number" ? b.bookingFeeCents : 0);
          }
        });
        setBanner({ event: candidate, reservedCount, checkedInCount, revenueCents });
      })
      .catch((err) => {
        console.error("useAfterActionCandidate bookings check failed:", err);
        if (!cancelled) setBanner(null);
      })
      .finally(() => {
        if (!cancelled) setChecking(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candidateId]);

  return { afterActionBanner: banner, afterActionChecking: checking };
}
