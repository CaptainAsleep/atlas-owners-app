import { useEffect, useState } from "react";
import { collection, onSnapshot, query, where } from "firebase/firestore";
import { db } from "../lib/firebase";

// Real data: everyone who has actually signed the waiver for this event.
// Deliberately NOT called a "roster" or "attendance" — signing a waiver
// isn't the same as showing up, same distinction the player app maintains
// everywhere else. This is the closest honest thing we have until real
// RSVP/booking and check-in scanning exist.
export function useEventWaivers(eventId, hostOwnerId, fieldId) {
  const [signatures, setSignatures] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!eventId) {
      setSignatures([]);
      setLoading(false);
      return;
    }
    // Atlas Major events (hostOwnerId set): the host's read access comes from
    // resource.data.hostOwnerId in firestore.rules, and Firestore only allows
    // a list query whose own filters prove the rule — so add that filter.
    // Field events keep the original eventId-only query, unchanged.
    // Field events also filter on fieldId (2026-10-27): the read rule for a
    // field event's signatures checks the field's owner (or its staff) via
    // resource.data.fieldId, and Firestore only allows a list query whose
    // own filters pin that field. The emulator showed the old eventId-only
    // query is DENIED for the owner, so this list was coming back empty.
    const q = hostOwnerId
      ? query(collection(db, "waiverSignatures"), where("eventId", "==", eventId), where("hostOwnerId", "==", hostOwnerId))
      : fieldId
        ? query(collection(db, "waiverSignatures"), where("eventId", "==", eventId), where("fieldId", "==", fieldId))
        : query(collection(db, "waiverSignatures"), where("eventId", "==", eventId));
    const unsub = onSnapshot(
      q,
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
  }, [eventId, hostOwnerId, fieldId]);

  return { signatures, signaturesLoading: loading };
}

// Recent waiver signings across every field this owner has, plus every
// Atlas Major event they host — genuinely real data for a "recent activity"
// feed, as opposed to fabricating one. Two listeners (field-keyed and
// host-keyed) merged client-side; a signature never matches both.
export function useRecentActivity(fieldIds, hostOwnerId) {
  const [fieldSigs, setFieldSigs] = useState([]);
  const [hostSigs, setHostSigs] = useState([]);
  const [fieldLoading, setFieldLoading] = useState(true);
  const [hostLoading, setHostLoading] = useState(true);

  useEffect(() => {
    if (!fieldIds || fieldIds.length === 0) {
      setFieldSigs([]);
      setFieldLoading(false);
      return;
    }
    const unsub = onSnapshot(
      query(collection(db, "waiverSignatures"), where("fieldId", "in", fieldIds.slice(0, 10))),
      (snap) => {
        setFieldSigs(snap.docs.map((d) => d.data()));
        setFieldLoading(false);
      },
      (err) => {
        console.error("useRecentActivity (fields) error:", err);
        setFieldLoading(false);
      }
    );
    return unsub;
  }, [JSON.stringify(fieldIds)]);

  useEffect(() => {
    if (!hostOwnerId) {
      setHostSigs([]);
      setHostLoading(false);
      return;
    }
    const unsub = onSnapshot(
      query(collection(db, "waiverSignatures"), where("hostOwnerId", "==", hostOwnerId)),
      (snap) => {
        setHostSigs(snap.docs.map((d) => d.data()));
        setHostLoading(false);
      },
      (err) => {
        console.error("useRecentActivity (host) error:", err);
        setHostLoading(false);
      }
    );
    return unsub;
  }, [hostOwnerId]);

  const list = [...fieldSigs, ...hostSigs];
  list.sort((a, b) => (b.signedAt?.toMillis?.() || 0) - (a.signedAt?.toMillis?.() || 0));
  return {
    activity: list.slice(0, 5),
    totalSignatures: list.length,
    activityLoading: fieldLoading || hostLoading,
  };
}
