import { useEffect, useState } from "react";
import { collection, onSnapshot, orderBy, query, where } from "firebase/firestore";
import { db } from "../lib/firebase";

export function useEvents(fieldId) {
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const base = collection(db, "events");
    const q = fieldId
      ? query(base, where("fieldId", "==", fieldId), orderBy("date"))
      : query(base, orderBy("date"));

    const unsub = onSnapshot(
      q,
      (snap) => {
        setEvents(snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((e) => !e.draft));
        setLoading(false);
      },
      (err) => {
        console.error("useEvents error:", err);
        setLoading(false);
      }
    );
    return unsub;
  }, [fieldId]);

  return { events, loading };
}
