import { useEffect, useState } from "react";
import { collection, onSnapshot, orderBy, query, where } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { db, functions } from "../lib/firebase";

// Gifted "free entry" vouchers (2026-10-24). The cap is enforced for real in
// giftFreeEntryVoucher (players-app functions/voucherGift.js); this copy is
// display-only. Same UTC calendar month as the server, so the "N left"
// count here always matches what the server will allow.
export const GIFT_MONTHLY_CAP = 10;

export function giftMonthStartUtc(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

// This month's gifts for one field, newest first. The ledger is
// Cloud-Function-written only; the owner can read their own field's.
export function useVoucherGifts(fieldId) {
  const [gifts, setGifts] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!fieldId) {
      setGifts([]);
      setLoading(false);
      return;
    }
    const q = query(
      collection(db, "fields", fieldId, "voucherGifts"),
      where("giftedAt", ">=", giftMonthStartUtc()),
      orderBy("giftedAt", "desc")
    );
    const unsub = onSnapshot(
      q,
      (snap) => {
        setGifts(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
        setLoading(false);
      },
      (err) => {
        console.error("useVoucherGifts error:", err);
        setLoading(false);
      }
    );
    return unsub;
  }, [fieldId]);

  return { gifts, giftsLoading: loading, remaining: Math.max(0, GIFT_MONTHLY_CAP - gifts.length) };
}

export async function searchPlayersForGift(fieldId, queryText) {
  const res = await httpsCallable(functions, "searchPlayersForGift")({ fieldId, query: queryText });
  return res.data?.results || [];
}

export async function giftFreeEntry({ fieldId, uid, expiresAtMs, note }) {
  const res = await httpsCallable(functions, "giftFreeEntryVoucher")({ fieldId, uid, expiresAtMs, note: note || null });
  return res.data || {};
}

// "YYYY-MM-DD" for a native date input, N days from today (owner's local time).
export function dateInputFromToday(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// End of the chosen day in the owner's local time, as epoch ms — what the
// server stores as expiresAt. Returns null for a blank/invalid/past date.
export function endOfLocalDayMs(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr || "");
  if (!m) return null;
  const ms = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59, 59).getTime();
  return ms > Date.now() ? ms : null;
}

export function formatShortDate(ts) {
  const d = ts?.toDate ? ts.toDate() : ts instanceof Date ? ts : null;
  return d ? d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "";
}

// Callable errors carry a user-safe message for the cases the server
// throws on purpose; anything else gets a generic line.
export function giftErrorMessage(err, fallback) {
  const safe = ["functions/invalid-argument", "functions/failed-precondition", "functions/resource-exhausted", "functions/not-found", "functions/permission-denied"];
  return safe.includes(err?.code) && err.message ? err.message : fallback;
}
