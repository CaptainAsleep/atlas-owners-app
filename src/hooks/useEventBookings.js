import { useEffect, useState } from "react";
import { collection, onSnapshot, orderBy, query } from "firebase/firestore";
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
