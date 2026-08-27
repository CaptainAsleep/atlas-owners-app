import { useEffect, useState } from "react";
import { collection, doc, getDoc, onSnapshot, orderBy, query, serverTimestamp, updateDoc } from "firebase/firestore";
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

// Parses the exact same "atlas:checkin:{eventId}:{uid}" payload the player
// app's QR code already generates, verifies it matches the event actually
// being scanned into, confirms a real booking exists for that uid, and
// marks it checked in. Returns a result object rather than throwing, so
// the scanner UI can show a clear message for every outcome without a
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
  const bookingRef = doc(db, "events", eventId, "bookings", uid);
  const snap = await getDoc(bookingRef);
  if (!snap.exists()) {
    return { ok: false, reason: "not-booked" };
  }
  const data = snap.data();
  if (data.checkedIn) {
    return { ok: false, reason: "already-checked-in", callsign: data.callsign };
  }
  await updateDoc(bookingRef, { checkedIn: true, checkedInAt: serverTimestamp() });
  return { ok: true, callsign: data.callsign };
}
