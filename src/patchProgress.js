// Owner-built field patches (2026-10-27) — owner-side progress + wording.
//
// MIRROR of the field-rule half of atlas-players-app/src/achievementEngine.js
// (compileFieldRule, fieldEventStreak, matchesFilter, maxConsecutiveWeekends,
// parseFirstHour24). The two apps are separate repos and can't share code, so
// if a rule's meaning changes there, change it here too — otherwise the
// owner's "N to go" will disagree with what actually unlocks for the player.
import { collection, doc, getDoc, getDocs } from "firebase/firestore";
import { db } from "./lib/firebase";

export const FIELD_RULE_TYPES = [
  { key: "checkins", label: "Check in to N games here" },
  { key: "event_streak", label: "Check in to N of our events in a row" },
  { key: "weekend_streak", label: "Play here N weekends in a row" },
  { key: "event_type", label: "Check in to N events of a game type" },
  { key: "night", label: "Check in to N night games" },
  { key: "keywords", label: "Check in to N themed events" },
  { key: "date_range", label: "Limited edition: check in between two dates" },
];

export const MAX_ACTIVE_FIELD_PATCHES = 10;

export function localTodayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function hourLabel(h) {
  const hour = Number(h);
  if (hour === 0) return "12 AM";
  if (hour === 12) return "12 PM";
  return hour > 12 ? `${hour - 12} PM` : `${hour} AM`;
}

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

// Plain-English wording for one rule — used for the builder preview and the
// patch's own summary line. gameTypes = [{ key, label }].
export function describeRule(rule, gameTypes = []) {
  const n = Number(rule.count) || 1;
  switch (rule.type) {
    case "checkins":
      return `checks in to ${plural(n, "game", "games")} here`;
    case "event_streak":
      return `checks in to ${n} of your events in a row`;
    case "weekend_streak":
      return `plays here ${n} weekends in a row`;
    case "event_type": {
      const t = gameTypes.find((g) => g.key === rule.eventType)?.label || rule.eventType || "?";
      return `checks in to ${plural(n, `${t} event`, `${t} events`)} here`;
    }
    case "night":
      return `checks in to ${plural(n, "night game", "night games")} here (starting ${hourLabel(rule.hour ?? 20)} or later)`;
    case "keywords":
      return `checks in to ${plural(n, "event", "events")} here with ${(rule.keywords || []).map((k) => `"${k}"`).join(" or ") || "?"} in the title`;
    case "date_range":
      return `checks in to ${plural(n, "game", "games")} here between ${rule.start || "?"} and ${rule.end || "?"}`;
    default:
      return "?";
  }
}

export function describeRules(rules, gameTypes) {
  if (!rules || rules.length === 0) return "Manual only — you give it out yourself.";
  return `Unlocks when a player ${rules.map((r) => describeRule(r, gameTypes)).join(", or ")}.`;
}

function parseFirstHour24(startTime) {
  if (!startTime) return null;
  const match = startTime.match(/(\d{1,2})(?::\d{2})?\s*(AM|PM)/i);
  if (!match) return null;
  let hour = parseInt(match[1], 10);
  const period = match[2].toUpperCase();
  if (period === "PM" && hour !== 12) hour += 12;
  if (period === "AM" && hour === 12) hour = 0;
  return hour;
}

function maxConsecutiveWeekends(dates) {
  const keys = new Set();
  dates.forEach((d) => {
    const date = new Date(d + "T00:00:00");
    const day = date.getDay();
    if (day === 0 || day === 6) {
      const sat = new Date(date);
      sat.setDate(sat.getDate() + (day === 0 ? -1 : 0));
      keys.add(sat.toISOString().slice(0, 10));
    }
  });
  const sorted = [...keys].sort();
  if (sorted.length === 0) return 0;
  let run = 1;
  let best = 1;
  for (let i = 1; i < sorted.length; i++) {
    const diff = Math.round((new Date(sorted[i]) - new Date(sorted[i - 1])) / 86400000);
    run = diff === 7 ? run + 1 : 1;
    if (run > best) best = run;
  }
  return best;
}

// Held = real (not canceled/deleted/draft) events at this field that have
// already happened, plus today's if the player already checked in — exactly
// fieldEventStreak's rule in the player app.
function heldEventsFor(fieldId, events, checkedIds, today) {
  return events
    .filter((e) => e.fieldId === fieldId && !e.canceled && !e.deleted && !e.draft)
    .filter((e) => (e.endDate || e.date) < today || (e.date <= today && checkedIds.has(e.id)))
    .sort((a, b) => (a.date === b.date ? (a.startTime || "").localeCompare(b.startTime || "") : a.date.localeCompare(b.date)));
}

// { current, target, label } for one rule against one player's check-ins at
// this field, or null when there's nothing to progress (a closed date range).
// For event_streak, `current` is the run still alive; `best` decides unlock.
export function ruleProgress(rule, fieldId, events, checkedIds, today = localTodayStr()) {
  const target = Number(rule.count) || 1;
  const mine = events.filter((e) => e.fieldId === fieldId && checkedIds.has(e.id));
  switch (rule.type) {
    case "checkins":
      return { current: mine.length, target, label: "games" };
    case "event_streak": {
      let run = 0;
      let best = 0;
      for (const e of heldEventsFor(fieldId, events, checkedIds, today)) {
        run = checkedIds.has(e.id) ? run + 1 : 0;
        if (run > best) best = run;
      }
      return { current: run, best, target, label: "events in a row" };
    }
    case "weekend_streak":
      return { current: maxConsecutiveWeekends(mine.map((e) => e.date)), target, label: "weekends in a row" };
    case "event_type":
      return { current: mine.filter((e) => e.type === rule.eventType).length, target, label: "games" };
    case "night": {
      const h = Number(rule.hour ?? 20);
      return { current: mine.filter((e) => { const x = parseFirstHour24(e.startTime); return x != null && x >= h; }).length, target, label: "night games" };
    }
    case "keywords": {
      const kws = (rule.keywords || []).map((k) => k.toLowerCase()).filter(Boolean);
      const hit = mine.filter((e) => { const s = `${e.title || ""} ${e.description || ""}`.toLowerCase(); return kws.some((k) => s.includes(k)); });
      return { current: hit.length, target, label: "themed events" };
    }
    case "date_range": {
      if (rule.end && rule.end < today) return null;
      return { current: mine.filter((e) => e.date >= (rule.start || "") && e.date <= (rule.end || "9999")).length, target, label: "games in the window" };
    }
    default:
      return null;
  }
}

// Every player with a checked-in booking at this field's events.
// Returns { [uid]: { uid, callsign, checkedIds: Set, proofEventId } }.
// Child-only bookings (guardianPlaying === false) don't count — the parent
// didn't play, same as the player app's isPlayedBooking.
export async function loadFieldCheckins(fieldId, events) {
  const relevant = events.filter((e) => e.fieldId === fieldId && !e.deleted && !e.draft && !e.canceled && e.date <= localTodayStr());
  const snaps = await Promise.all(relevant.map((e) => getDocs(collection(db, "events", e.id, "bookings")).catch(() => null)));
  const players = {};
  snaps.forEach((snap, i) => {
    if (!snap) return;
    snap.docs.forEach((d) => {
      const b = d.data();
      if (!b.checkedIn || b.guardianPlaying === false) return;
      const uid = d.id;
      if (!players[uid]) players[uid] = { uid, callsign: b.callsign || "Player", checkedIds: new Set(), proofEventId: relevant[i].id };
      players[uid].checkedIds.add(relevant[i].id);
    });
  });
  return players;
}

// Which of these players already own this patch (users/{uid}/patches is
// public read; the doc id is the patch's grantDocId).
export async function loadHolders(grantDocId, uids) {
  const snaps = await Promise.all(uids.map((u) => getDoc(doc(db, "users", u, "patches", grantDocId)).catch(() => null)));
  return new Set(uids.filter((u, i) => snaps[i]?.exists()));
}

// Progress rows for one field patch: players with ≥1 check-in here who don't
// hold it, closest first. Rules are OR'd: the closest path sets the sort.
export function patchProgressRows(patch, fieldId, events, players, holders) {
  const today = localTodayStr();
  const rows = [];
  for (const p of Object.values(players)) {
    if (holders.has(p.uid)) continue;
    const paths = (patch.rules || [])
      .map((r) => ruleProgress(r, fieldId, events, p.checkedIds, today))
      .filter(Boolean)
      .map((x) => ({ ...x, current: Math.min(x.current, x.target), remaining: Math.max(0, x.target - x.current) }));
    if (paths.length === 0) continue;
    const ratio = Math.max(...paths.map((x) => x.current / Math.max(1, x.target)));
    rows.push({ uid: p.uid, callsign: p.callsign, paths, ratio });
  }
  rows.sort((a, b) => b.ratio - a.ratio || a.callsign.localeCompare(b.callsign));
  return rows;
}
