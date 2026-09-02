import { useEffect, useState } from "react";
import { collection, onSnapshot, query, where } from "firebase/firestore";
import { db } from "../lib/firebase";

// Real data: everyone who has actually signed the waiver for this event.
// Deliberately NOT called a "roster" or "attendance" — signing a waiver
// isn't the same as showing up, same distinction the player app maintains
// everywhere else. This is the closest honest thing we have until real
// RSVP/booking and check-in scanning exist.
export function useEventWaivers(eventId) {
  const [signatures, setSignatures] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!eventId) {
      setSignatures([]);
      setLoading(false);
      return;
    }
    const unsub = onSnapshot(
      query(collection(db, "waiverSignatures"), where("eventId", "==", eventId)),
      (snap) => {
        const list = snap.docs.map((d) => d.data());
        list.sort((a, b) => (b.signedAt?.toMillis?.() || 0) - (a.signedAt?.toMillis?.() || 0));
        setSignatures(list);
        setLoading(false);
      },
      (err) => {
        console.error("useEventWaivers error:", err);
        setLoading(false);
      }
    );
    return unsub;
  }, [eventId]);

  return { signatures, signaturesLoading: loading };
}

// Recent waiver signings across every field this owner has — genuinely
// real data for a "recent activity" feed, as opposed to fabricating one.
export function useRecentActivity(fieldIds) {
  const [activity, setActivity] = useState([]);
  const [totalSignatures, setTotalSignatures] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!fieldIds || fieldIds.length === 0) {
      setActivity([]);
      setTotalSignatures(0);
      setLoading(false);
      return;
    }
    const unsub = onSnapshot(
      query(collection(db, "waiverSignatures"), where("fieldId", "in", fieldIds.slice(0, 10))),
      (snap) => {
        const list = snap.docs.map((d) => d.data());
        list.sort((a, b) => (b.signedAt?.toMillis?.() || 0) - (a.signedAt?.toMillis?.() || 0));
        setTotalSignatures(list.length);
        setActivity(list.slice(0, 5));
        setLoading(false);
      },
      (err) => {
        console.error("useRecentActivity error:", err);
        setLoading(false);
      }
    );
    return unsub;
  }, [JSON.stringify(fieldIds)]);

  return { activity, totalSignatures, activityLoading: loading };
}
