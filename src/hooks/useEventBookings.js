import { useEffect, useState } from "react";
import { collection, doc, getDoc, onSnapshot, orderBy, query, serverTimestamp, writeBatch } from "firebase/firestore";
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
