import { useEffect, useState } from "react";
import { collection, doc, getDoc, getDocs, onSnapshot, orderBy, query, serverTimestamp, writeBatch } from "firebase/firestore";
import { db } from "../lib/firebase";

// Real bookings for one event — a genuine commitment to attend, not just
// interest. Every booking is guaranteed to already have a signed waiver if
// the event required one, since that's enforced at the Firestore rules
// level on the booking write itself, not just in the player app's UI.
export function useEventBookings(eventId) {
  const [bookings, setBookings] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!eventId) {
      setBookings([]);
      setLoading(false);
      return;
    }
    const unsub = onSnapshot(
      query(collection(db, "events", eventId, "bookings"), orderBy("bookedAt")),
      (snap) => {
        setBookings(snap.docs.map((d) => d.data()));
        setLoading(false);
      },
      (err) => {
        console.error("useEventBookings error:", err);
        setLoading(false);
      }
    );
    return unsub;
  }, [eventId]);

  return { bookings, bookingsLoading: loading };
}

// Shared by both the QR scanner and manual search-based check-in, so
// there's exactly one place that knows how a check-in actually gets
// written (both mirrored copies — see the comment below) rather than two
// copies of that logic that could quietly drift apart.
export async function checkInPlayer(eventId, uid) {
  const bookingRef = doc(db, "events", eventId, "bookings", uid);
  const snap = await getDoc(bookingRef);
  if (!snap.exists()) {
    return { ok: false, reason: "not-booked" };
  }
  const data = snap.data();
  if (data.checkedIn) {
    return { ok: false, reason: "already-checked-in", callsign: data.callsign };
  }
  // Both mirrored copies, not just the event's — a booking exists as two
  // documents (one under the event for the owner's roster, one under the
  // player for their own Schedule tab), and only the second one is what
  // the achievement engine and the player's own UI actually read. Missing
  // this was a real bug: check-in-based patches could never fire, since
  // the copy they check never learned a check-in happened at all.
  const batch = writeBatch(db);
  batch.update(bookingRef, { checkedIn: true, checkedInAt: serverTimestamp() });
  batch.update(doc(db, "users", uid, "bookings", eventId), { checkedIn: true, checkedInAt: serverTimestamp() });
  await batch.commit();
  return { ok: true, callsign: data.callsign };
}

// Parses the exact same "atlas:checkin:{eventId}:{uid}" payload the player
// app's QR code already generates, verifies it matches the event actually
// being scanned into, then delegates to the same check-in logic manual
// check-in uses. Returns a result object rather than throwing, so the
// scanner UI can show a clear message for every outcome without a
// try/catch around each distinct failure case.
export async function checkInFromScan(rawText, eventId) {
  const parts = (rawText || "").split(":");
  if (parts.length !== 4 || parts[0] !== "atlas" || parts[1] !== "checkin") {
    return { ok: false, reason: "not-atlas-code" };
  }
  const [, , scannedEventId, uid] = parts;
  if (scannedEventId !== eventId) {
    return { ok: false, reason: "wrong-event" };
  }
  return checkInPlayer(eventId, uid);
}


// Real booking-fee revenue across every one of this owner's events, for
// the Analytics screen. Same reasoning as the admin portal's version —
// each event's own bookings subcollection, fetched directly rather than
// a collectionGroup("bookings") query, which would double-count against
// the player app's separate per-user mirror copy (see useAdminData.js's
// comment for the full explanation of why that shape exists).
//
// One-shot per distinct set of event ids rather than a live listener per
// event — refetches whenever the owner's event list actually changes
// (new event created, one edited), which is "fresh enough" for a screen
// someone glances at, not something that needs to update mid-keystroke.
//
// Reports the owner's own share (amountPaidCents minus Atlas's
// bookingFeeCents) — the actual dollars that landed in their connected
// Stripe account via the destination charge — not Atlas's own cut, which
// wouldn't mean anything useful shown back to a field owner.
export function useOwnerBookingRevenue(events) {
  const [stats, setStats] = useState({ paidBookingsCount: 0, revenueCents: 0 });
  const [loading, setLoading] = useState(true);
  const eventIdsKey = events.map((e) => e.id).join(",");

  useEffect(() => {
    if (events.length === 0) {
      setStats({ paidBookingsCount: 0, revenueCents: 0 });
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    Promise.all(events.map((e) => getDocs(collection(db, "events", e.id, "bookings"))))
      .then((snaps) => {
        if (cancelled) return;
        let paidBookingsCount = 0;
        let revenueCents = 0;
        snaps.forEach((snap) => {
          snap.docs.forEach((d) => {
            const b = d.data();
            if (!b.paid) return;
            paidBookingsCount += 1;
            if (typeof b.amountPaidCents === "number") {
              revenueCents += b.amountPaidCents - (typeof b.bookingFeeCents === "number" ? b.bookingFeeCents : 0);
            }
          });
        });
        setStats({ paidBookingsCount, revenueCents });
        setLoading(false);
      })
      .catch((err) => {
        console.error("useOwnerBookingRevenue error:", err);
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
    // eventIdsKey, not events itself — events is a fresh array reference
    // on every parent render (from useOwnerEvents' onSnapshot), which
    // would otherwise refetch every single render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventIdsKey]);

  return { paidBookingsCount: stats.paidBookingsCount, revenueCents: stats.revenueCents, statsLoading: loading };
}