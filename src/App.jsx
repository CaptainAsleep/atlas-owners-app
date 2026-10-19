import React, { useState, useEffect, useRef, useMemo } from "react";
import {
  Shield, LogOut, ChevronLeft, ChevronRight, Search, Plus, Trash2, Check, Ban,
  ArrowRight, Calendar, MapPin, Copy, FileSignature, Image as ImageIcon, TrendingUp,
  Settings, Users, LayoutDashboard, Pencil, QrCode, X, RotateCcw, ExternalLink, PartyPopper, Ticket, Share2,
} from "lucide-react";
import QRCode from "qrcode";
import { useOwnerAuth } from "./hooks/useOwnerAuth";
import { CURRENT_TERMS_VERSION, TERMS_OF_USE, PRIVACY_POLICY, EULA, ORGANIZER_TERMS_VERSION, ORGANIZER_TERMS_OF_USE, ORGANIZER_PRIVACY_POLICY, ORGANIZER_EULA } from "./legalText";
import { useAllFields, useMyFields, useMyPendingClaims, useFieldActions, useBannedPlayers, useBanActions, useFieldShippingAddress, useShippingAddressActions } from "./hooks/useOwnerFields";
import { useOwnerEvents, useOwnerEventActions, useAfterActionCandidate } from "./hooks/useOwnerEvents";
import { useEventWaivers, useRecentActivity } from "./hooks/useEventWaivers";
import { useEventBookings, useAttendeeDetails, useEventInterestedCount, useOwnerFinancials, useOwnerReservationStats, checkInFromScan, checkInPlayer } from "./hooks/useEventBookings";
import { useSWUpdate } from "./hooks/useSWUpdate";
import { db, storage, functions } from "./lib/firebase";
import { httpsCallable } from "firebase/functions";
import { collection, doc, getDocs, query, serverTimestamp, updateDoc, where } from "firebase/firestore";
import { ref, uploadBytes, getDownloadURL, deleteObject } from "firebase/storage";

/* ---------- design tokens — same palette as the player app for immediate
   visual/brand consistency across both, even though this is a separate
   codebase and deployment ---------- */
const T = {
  void: "#F2F2ED",
  panel: "#FFFFFF",
  panelAlt: "#E7E7E1",
  line: "#D2D2CB",
  ash: "#002C48",
  ashDim: "#4E5257",
  ashFaint: "#686C72",
  accent: "#1554B8",
  good: "#0F7A52",
  alert: "#BC3327",

  // --- Elevation & shape (added for the aesthetic-upgrade pass) ---
  // Soft shadows replace the flat 1px border as the primary depth cue on
  // cards; borders stay only for hairline dividers and secondary/outline
  // buttons that need a visible edge with no fill.
  shadowSm: "0 1px 2px rgba(0,44,72,0.05)",
  shadowMd: "0 1px 2px rgba(0,44,72,0.05), 0 8px 20px -8px rgba(0,44,72,0.16)",
  shadowLg: "0 1px 2px rgba(0,44,72,0.06), 0 10px 28px -8px rgba(0,44,72,0.22)",
  shadowNav: "0 -8px 24px -8px rgba(0,44,72,0.14)", // bottom nav / sticky footer bars
  shadowFloat: "0 6px 14px rgba(0,44,72,0.16), 0 24px 48px -12px rgba(0,44,72,0.40)", // detached/floating bars (nav, booking bar)
  glassFill: "rgba(255,255,255,0.72)", // translucent fill for floating glass bars
  glassBlur: "blur(20px)", // backdrop blur amount for floating glass bars
  glassBorder: "1px solid rgba(255,255,255,0.6)", // edge highlight for floating glass bars
  // A single deliberate radius scale, replacing the mixed 2/4/6/8px values
  // that had been picked ad hoc per element.
  rTight: 10, // inputs, small chips
  rCard: 16, // standard cards
  rHero: 18, // feature/hero cards
  rFloat: 24, // floating detached bars (booking bar / sticky footer)
  rMedia: 14, // images inside cards
  rPill: 999, // pills, segmented controls, toggle chips, primary buttons
  // Soft tint washes for icon badges
  tint: "#EEF2F8",
  tintGood: "#EAF5EF",
};
const FONTS = `
@import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=Inter:wght@400;500;600&display=swap');
.app-shell-height {
  /* Confirmed real cause: a known WebKit bug (documented on Apple's own
     developer forums) where visiting an external site with its own
     "smart app banner" corrupts window.innerHeight/visualViewport.height
     for the site you return to — even with no banner ever visible there.
     Every previous attempt correctly trusted those values as ground
     truth; the browser itself was the one lying. --real-screen-height
     (set above) is the largest height genuinely observed this session,
     from before the bug had a chance to corrupt anything.
  */
  height: var(--real-screen-height, 100vh);
}
`;
const display = { fontFamily: "'Space Grotesk', sans-serif" };
const body = { fontFamily: "'Inter', sans-serif" };
const mono = { fontFamily: "'Inter', sans-serif", fontVariantNumeric: "tabular-nums" };
const flatBg = { background: T.void };

function localDateStr(d = new Date()) {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

// Which calendar year "Year in Review" covers right now. During January,
// that's last year — just finished, still fresh. The rest of the year
// it's this year so far, which is what most of the year actually looks
// like and simply becomes the complete year by December — no special
// first-year case needed, and no year picker either. Identical to the
// player app's own version (no shared code between the two apps).
function reviewYear() {
  const now = new Date();
  return now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear();
}

// The unprompted dashboard banner only shows itself Dec 26 - Jan 31 —
// newsworthy right after the holidays, through most of January. The
// recap itself stays reachable year-round from Settings; this only gates
// the nudge, never access to the screen.
function isReviewWindow() {
  const now = new Date();
  const m = now.getMonth(); // 0-11
  const d = now.getDate();
  return (m === 11 && d >= 26) || (m === 0 && d <= 31);
}

// Classifies every booking as this player's "new" (their earliest-ever
// booking with this owner, across every field they run) or "returning"
// (any booking after that), using the owner's FULL booking history —
// never just the target year — since whether someone's a repeat player
// depends on their whole history with this owner, not just what happened
// this year. A standalone function rather than reusing AnalyticsScreen's
// inline returningStats logic: that logic already shipped and is
// verified, and duplicating this one small piece of it here avoids any
// risk of touching it. Returns a new array (original order) with each
// booking's isReturning flag attached; the caller filters by year after.
function classifyReturning(allBookings) {
  const byUid = {};
  allBookings.forEach((b) => {
    if (!b.bookedAt?.toDate) return;
    (byUid[b.uid] || (byUid[b.uid] = [])).push(b);
  });
  const returningIds = new Set();
  Object.values(byUid).forEach((list) => {
    const sorted = [...list].sort((a, b) => a.bookedAt.toDate() - b.bookedAt.toDate());
    sorted.forEach((b, i) => { if (i > 0) returningIds.add(b); });
  });
  return allBookings.map((b) => ({ ...b, isReturning: b.bookedAt?.toDate ? returningIds.has(b) : false }));
}

// Haversine formula — straight-line distance in miles between two points.
function distanceMiles(lat1, lng1, lat2, lng2) {
  const R = 3958.8;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function parsePrice(str) {
  const m = (str || "").match(/[\d.]+/);
  return m ? parseFloat(m[0]) : null;
}
// True when a price string carries no real information — unset,
// whitespace, or just a leftover currency symbol with nothing after it.
// Used to default the "Free event" checkbox for an existing event (one
// saved before that checkbox existed, or from before this field's default
// was fixed, can still have a literal "$" sitting in price) and, on the
// player side (same helper, ported to atlas-players-app/src/App.jsx), to
// show "Free" instead of a bare "$".
function isBlankPriceText(price) {
  return !price || !/[^\s$]/.test(price);
}

// Defensive display formatting — if a price was ever stored as a bare
// number (no $ prefix), show it with one rather than a confusing bare
// digit. Doesn't touch the stored value, just how it renders.
// Purely client-side — no backend needed for something this simple. Builds
// a real CSV string from data already loaded on screen (no extra Firestore
// reads) and triggers a normal browser download via a temporary link.
// Quotes any field containing a comma, quote, or newline, doubling internal
// quotes — the one real escaping rule CSV actually needs to stay valid.
function downloadCsv(filename, headers, rows) {
  const escape = (val) => {
    const s = val == null ? "" : String(val);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [headers.map(escape).join(","), ...rows.map((row) => row.map(escape).join(","))];
  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// Builds a player-app deep link to this field's public page and either
// hands it to the native share sheet (mobile) or copies it to the
// clipboard (desktop / no Web Share API) — same pattern the player app's
// own field-detail Share button uses, so behavior is consistent across
// both apps.
async function shareFieldLink(field) {
  if (!field?.id) return "unsupported";
  const url = `https://playerapp.airsoftatlas.app/?field=${field.id}`;
  const title = field.name || "Atlas field";
  const text = field.name ? `${field.name} on Atlas` : "This field on Atlas";
  if (navigator.share) {
    try {
      await navigator.share({ title, text, url });
      return "shared";
    } catch (err) {
      return "cancelled"; // owner backed out of the share sheet — not an error
    }
  }
  if (navigator.clipboard) {
    await navigator.clipboard.writeText(url);
    return "copied";
  }
  return "unsupported";
}

function displayPrice(price) {
  if (isBlankPriceText(price)) return "Free";
  const trimmed = String(price).trim();
  return /^\d/.test(trimmed) ? `$${trimmed}` : trimmed;
}

// Plain relative-time formatting for a Firestore Timestamp (or a real
// Date) — no date library in this project, and this is the only spot
// that's ever needed one. Falls back to a plain date once something is
// more than a week old, where "12d ago" stops being more useful than
// just the date.
function timeAgo(ts) {
  const date = ts?.toDate ? ts.toDate() : ts instanceof Date ? ts : null;
  if (!date) return "";
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: date.getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
}

// Mirrors the exact same real-vs-demo checks FieldFacts uses on the player
// app: amenities, rules, and chrono each independently fall back to
// placeholder content (visibly tagged "DEMO DATA" there) whenever a field
// hasn't provided its own. Used to nudge an owner that players are seeing
// that tag on their profile, not to gate or validate anything.
function fieldHasRealChrono(field) {
  const ch = field?.chrono;
  if (Array.isArray(ch)) return ch.some((item) => item?.value);
  return !!(ch?.aeg || ch?.sniper || ch?.dmr);
}
function fieldCompletenessGaps(field) {
  if (!field) return [];
  return [
    !field.imageUrl && "a banner photo",
    !field.about?.trim() && "a description",
    !(field.amenities?.length > 0) && "amenities",
    !(field.rules?.length > 0) && "field rules",
    !fieldHasRealChrono(field) && "chrono limits",
  ].filter(Boolean);
}

// Same client-side resize used throughout the player app — shrink before
// upload so nobody's waiting on a 12MB phone photo.
function resizeImageFile(file, maxSize = 800, quality = 0.85) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Couldn't read that file."));
    reader.onload = (e) => {
      const img = new Image();
      img.onerror = () => reject(new Error("That doesn't look like a valid image."));
      img.onload = () => {
        let { width, height } = img;
        if (width > height && width > maxSize) {
          height = Math.round((height * maxSize) / width);
          width = maxSize;
        } else if (height >= width && height > maxSize) {
          width = Math.round((width * maxSize) / height);
          height = maxSize;
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        canvas.getContext("2d").drawImage(img, 0, 0, width, height);
        canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Couldn't process that image."))), "image/jpeg", quality);
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}

function Eyebrow({ children }) {
  return (
    <div className="text-[11px] font-semibold uppercase mb-2" style={{ ...mono, color: T.ashFaint, letterSpacing: "0.04em" }}>
      {children}
    </div>
  );
}

// Native <input type="time"> stores/emits 24-hour "HH:MM". Older events
// (and anything hand-edited) may still carry a free-text value like
// "9:00 AM (gates)" from before the field was a time picker — that won't
// match the pattern below, so it's returned as-is rather than mangled.
function formatTimeStr(t) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(t || "");
  if (!m) return t || "";
  let h = parseInt(m[1], 10);
  const suffix = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${h}:${m[2]} ${suffix}`;
}

function TextField({ label, value, onChange, placeholder, type = "text", rows, showCount }) {
  const Tag = rows ? "textarea" : "input";
  // Native date/time widgets render their internal segments (day/month/
  // year, hour/minute/AM-PM) at a size proportional to font-size — on some
  // mobile browsers that internal rendering can ignore width constraints
  // on the input itself entirely, so a smaller font is the one thing that
  // actually shrinks what the browser draws, not just what CSS allows.
  const isDateOrTime = type === "date" || type === "time";
  return (
    // min-w-0 matters whenever this div lands directly inside a flex
    // container (e.g. the Date/End Date column below): a flex item's
    // default min-width is "auto", which for a native date/time input
    // resolves to its own intrinsic rendered width. Without min-w-0 the
    // box won't actually shrink/stretch to its assigned size — it holds
    // its intrinsic width instead and bleeds out one side (same bug as
    // the Start/End Time row, just on the cross axis of a column flex
    // instead of the main axis of a row flex). Harmless outside a flex
    // context.
    <div className="mb-3 min-w-0">
      {label && <label className="text-[10px] font-semibold uppercase block mb-1" style={{ ...mono, color: T.ashFaint, letterSpacing: "0.04em" }}>{label}</label>}
      <Tag
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        type={rows ? undefined : type}
        rows={rows}
        className={`w-full ${isDateOrTime ? "px-2" : "px-3"} py-2.5 ${isDateOrTime ? "text-[13px]" : "text-[14px]"} bg-transparent outline-none`}
        style={{
          ...body,
          background: T.panelAlt,
          border: `1px solid ${T.line}`,
          borderRadius: T.rTight,
          color: T.ash,
          resize: rows ? "none" : undefined,
          colorScheme: "light",
          // Defensive against a real Safari quirk we hit before: native
          // date inputs have a minimum content width that can silently
          // beat a plain width:100% and overflow their container. These
          // are harmless for every other input type too.
          boxSizing: "border-box",
          minWidth: 0,
          maxWidth: "100%",
          display: "block",
          // The font-size/min-width tricks above weren't enough on their
          // own — iOS Safari lays out a native date/time control's
          // segments using its own intrinsic sizing and can render past
          // whatever width we declare, regardless of box-sizing. Turning
          // off native appearance stops WebKit from using that special
          // layout path, so the control finally respects width like a
          // normal box; the tap-to-open native picker still works the
          // same either way, only the inline chrome's sizing changes.
          //
          // Side effect: native appearance was also what enforced a
          // touch-friendly minimum height — without it the box collapses
          // to just padding + line-height, visibly shorter than every
          // other field. An explicit height restores that (a plain
          // <input> vertically centers its text within a set height on
          // its own, so this doesn't need extra centering rules).
          ...(isDateOrTime ? { WebkitAppearance: "none", appearance: "none", height: "48px" } : {}),
        }}
      />
      {showCount && (
        <div className="text-[10px] mt-1 text-right" style={{ ...mono, color: (value || "").length > 500 ? T.alert : T.ashFaint }}>
          {(value || "").length} characters
        </div>
      )}
    </div>
  );
}

function PrimaryButton({ children, onClick, disabled, tone = "ash" }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="w-full py-3.5 font-semibold text-[14px] transition-transform duration-100 active:scale-[0.98]"
      style={{ ...display, background: T[tone], color: "#FFFFFF", borderRadius: T.rPill, opacity: disabled ? 0.5 : 1, boxShadow: disabled ? "none" : "0 8px 20px -6px rgba(0,44,72,0.4)" }}
    >
      {children}
    </button>
  );
}

/* ---------- Auth ---------- */
function LoginScreen({ signIn, signUp }) {
  const [mode, setMode] = useState("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const friendlyError = (code) => {
    if (code === "auth/email-already-in-use") return "That email already has an account — try signing in instead.";
    if (code === "auth/invalid-email") return "That doesn't look like a valid email address.";
    if (code === "auth/weak-password") return "Password needs to be at least 6 characters.";
    if (code === "auth/invalid-credential" || code === "auth/wrong-password") return "Incorrect email or password.";
    if (code === "auth/user-not-found") return "No account found with that email.";
    return "Something went wrong — try again.";
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      if (mode === "signup") {
        await signUp(email.trim(), password, name.trim());
      } else {
        await signIn(email.trim(), password);
      }
    } catch (err) {
      setError(friendlyError(err.code));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="h-full flex flex-col px-6 overflow-y-auto" style={flatBg}>
      <div className="flex flex-col items-center mt-12 mb-8">
        <div className="w-14 h-14 flex items-center justify-center mb-3 overflow-hidden" style={{ borderRadius: 8 }}>
          <img src={`${import.meta.env.BASE_URL}logo.jpg`} alt="Atlas" className="w-full h-full" style={{ objectFit: "cover" }} />
        </div>
        <span className="text-lg font-semibold" style={{ ...display, color: T.ash, letterSpacing: "0.1em" }}>ATLAS FOR HOSTS</span>
      </div>

      <form onSubmit={handleSubmit}>
        {mode === "signup" && (
          <TextField label="Your Name" value={name} onChange={setName} placeholder="Full name" />
        )}
        <TextField label="Email" value={email} onChange={setEmail} placeholder="you@yourfield.com" type="email" />
        <TextField label="Password" value={password} onChange={setPassword} placeholder="••••••••" type="password" />
        {error && <p className="text-[12px] mb-3" style={{ ...body, color: T.alert }}>{error}</p>}
        <button
          type="submit"
          disabled={busy}
          className="w-full py-3.5 font-semibold text-[14px] flex items-center justify-center gap-2 mt-2 transition-transform duration-100 active:scale-[0.98]"
          style={{ ...display, background: T.ash, color: "#FFFFFF", borderRadius: T.rPill, boxShadow: T.shadowMd, opacity: busy ? 0.6 : 1 }}
        >
          {busy ? "Please wait…" : mode === "signup" ? "Create Account" : "Sign In"} <ArrowRight size={16} />
        </button>
      </form>

      <button
        onClick={() => { setMode(mode === "signin" ? "signup" : "signin"); setError(""); }}
        className="text-center text-[13px] mt-4 transition-transform duration-100 active:scale-95"
        style={{ ...body, color: T.accent }}
      >
        {mode === "signin" ? "New here? Create an account" : "Already have an account? Sign in"}
      </button>
    </div>
  );
}

/* ---------- Dashboard ---------- */
function DashboardScreen({ profile, myFields, myFieldsLoading, pendingFields, pendingLoading, events, eventsLoading, activity, activityLoading, onOpenField, onOpenClaim, onOpenEventsList, onCreateEvent, onOpenEvent, onOpenPayouts, onOpenBilling, onOpenYearInReview, onLogout, isFieldOwner, isOrganizer }) {
  // Organizer-only accounts have no fields to list; everyone else sees
  // the original My Fields section exactly as before.
  const showFieldsSection = isFieldOwner || !isOrganizer;
  const today = localDateStr();
  const upcoming = events.filter((e) => !e.draft && !e.deleted && e.date >= today).sort((a, b) => a.date.localeCompare(b.date));
  const totalInterest = events.filter((e) => !e.deleted).reduce((sum, e) => sum + (e.interestCount || 0), 0);
  // Highest-level rollup — every upcoming, non-canceled, published event
  // across every field this owner manages, not just one field or event.
  const totalProjectedRevenue = upcoming.reduce((sum, e) => {
    if (e.canceled) return sum;
    const p = parsePrice(e.price);
    const cap = typeof e.maxCapacity === "number" ? e.maxCapacity : parseInt(e.maxCapacity, 10);
    return sum + (p && cap ? p * cap : 0);
  }, 0);

  const { afterActionBanner } = useAfterActionCandidate(events);
  const [selectedActivity, setSelectedActivity] = useState(null);

  return (
    <div className="h-full overflow-y-auto pb-24" style={flatBg}>
      <div className="px-6 pt-6 pb-4 flex items-center justify-between">
        <div>
          <div className="text-[12px]" style={{ ...body, color: T.ashDim }}>Welcome back,</div>
          <div className="text-[20px] font-semibold" style={{ ...display, color: T.ash }}>{profile?.name || "Owner"}</div>
        </div>
        <button onClick={onLogout} className="w-9 h-9 flex items-center justify-center transition-transform duration-100 active:scale-90" style={{ background: T.panel, borderRadius: T.rTight, boxShadow: T.shadowSm }}>
          <LogOut size={16} color={T.ashDim} />
        </button>
      </div>

      <div className="px-6">
        {afterActionBanner && (
          <button
            onClick={() => onOpenEvent(afterActionBanner.event)}
            className="w-full mb-5 p-4 flex items-center gap-3 text-left transition-transform duration-100 active:scale-[0.98]"
            style={{ background: "linear-gradient(135deg, #0F7A52, #0B5C3E)", borderRadius: T.rCard, boxShadow: T.shadowMd }}
          >
            <PartyPopper size={18} color="#FFFFFF" />
            <div className="flex-1">
              <div className="text-[13px] font-semibold" style={{ ...display, color: "#FFFFFF" }}>After-Action Report: {afterActionBanner.event.title}</div>
              <div className="text-[11px]" style={{ ...body, color: "rgba(255,255,255,0.75)" }}>
                {afterActionBanner.reservedCount} reserved · {afterActionBanner.checkedInCount} checked in
                {afterActionBanner.revenueCents > 0 ? ` · $${(afterActionBanner.revenueCents / 100).toFixed(2)}` : ""}
              </div>
            </div>
            <ChevronRight size={16} color="#FFFFFF" />
          </button>
        )}
        {isReviewWindow() && (
          <button
            onClick={onOpenYearInReview}
            className="w-full mb-5 p-4 flex items-center gap-3 text-left transition-transform duration-100 active:scale-[0.98]"
            style={{ background: "linear-gradient(135deg, #1554B8, #0B2E5C)", borderRadius: T.rCard, boxShadow: T.shadowMd }}
          >
            <div className="flex-1">
              <div className="text-[13px] font-semibold" style={{ ...display, color: "#FFFFFF" }}>Your {reviewYear()} Year in Review is ready</div>
              <div className="text-[11px]" style={{ ...body, color: "rgba(255,255,255,0.75)" }}>See what this year looked like across your fields — tap to open.</div>
            </div>
            <ChevronRight size={16} color="#FFFFFF" />
          </button>
        )}
        {(myFields.length > 0 || isOrganizer) && !profile?.payoutsEnabled && (
          <button
            onClick={onOpenPayouts}
            className="w-full mb-5 p-4 flex items-center gap-3 text-left transition-transform duration-100 active:scale-[0.98]"
            style={{ background: "rgba(21,84,184,0.08)", border: `1px solid ${T.accent}`, borderRadius: 6 }}
          >
            <TrendingUp size={18} color={T.accent} />
            <div className="flex-1">
              <div className="text-[13px] font-semibold" style={{ ...display, color: T.ash }}>Set up payouts</div>
              <div className="text-[11px]" style={{ ...body, color: T.ashDim }}>Players can't pay for bookings until this is done — takes a few minutes.</div>
            </div>
            <ChevronRight size={16} color={T.accent} />
          </button>
        )}
        {!pendingLoading && pendingFields.length > 0 && (
          <>
            <Eyebrow>Pending Review</Eyebrow>
            <div className="mb-5 flex flex-col gap-2">
              {pendingFields.map((f) => (
                <div key={f.id} className="p-3 flex items-center gap-3" style={{ background: T.panel, borderRadius: T.rCard, boxShadow: T.shadowMd, outline: `1.5px solid ${T.accent}`, outlineOffset: -1 }}>
                  <div className="flex-1">
                    <div className="text-[13px] font-semibold" style={{ ...display, color: T.ash }}>{f.name}</div>
                    <div className="text-[11px]" style={{ ...body, color: T.ashFaint }}>Awaiting manual review — no website on file to verify against</div>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        {(myFields.length > 0 || isOrganizer) && (
          <>
            <Eyebrow>Overview</Eyebrow>
            <div className="grid grid-cols-2 gap-3 mb-5">
              <div className="p-4" style={{ background: T.panel, borderRadius: T.rCard, boxShadow: T.shadowMd }}>
                <div className="flex items-center justify-center mb-2.5" style={{ width: 30, height: 30, borderRadius: T.rPill, background: T.tint }}>
                  <Calendar size={14} color={T.accent} />
                </div>
                <div className="text-[10px] font-semibold uppercase" style={{ ...mono, color: T.ashFaint, letterSpacing: "0.04em" }}>Upcoming</div>
                <div className="text-[24px] font-semibold" style={{ ...display, color: T.ash }}>{eventsLoading ? "…" : upcoming.length}</div>
              </div>
              <div className="p-4" style={{ background: T.panel, borderRadius: T.rCard, boxShadow: T.shadowMd }}>
                <div className="flex items-center justify-center mb-2.5" style={{ width: 30, height: 30, borderRadius: T.rPill, background: T.tintGood }}>
                  <TrendingUp size={14} color={T.good} />
                </div>
                <div className="text-[10px] font-semibold uppercase" style={{ ...mono, color: T.ashFaint, letterSpacing: "0.04em" }}>Total Interest</div>
                <div className="text-[24px] font-semibold" style={{ ...display, color: T.ash }}>{eventsLoading ? "…" : totalInterest}</div>
                <div className="text-[9px] mt-0.5" style={{ ...body, color: T.ashFaint }}>Players who favorited your events — not confirmed reservations</div>
              </div>
            </div>

            {!eventsLoading && totalProjectedRevenue > 0 && (
              <div className="p-4 mb-5" style={{ borderRadius: T.rHero, background: "linear-gradient(135deg,#0e2c47,#1c3f63)", boxShadow: "0 10px 24px -8px rgba(0,44,72,0.35)" }}>
                <div className="text-[10px] font-semibold uppercase mb-1" style={{ ...mono, color: "rgba(255,255,255,0.6)", letterSpacing: "0.04em" }}>Projected Revenue (Gross, Upcoming)</div>
                <div className="text-[26px] font-semibold" style={{ ...display, color: "#fff" }}>${totalProjectedRevenue.toFixed(2)}</div>
                <div className="text-[9px] mt-0.5" style={{ ...body, color: "rgba(255,255,255,0.55)" }}>Summed across every upcoming event at full capacity, {isOrganizer ? "across all your events" : "across all your fields"} — not a real payment yet</div>
              </div>
            )}
          </>
        )}

        <div className="mb-4">
          <PrimaryButton onClick={onCreateEvent} tone="ash">+ Create New Event</PrimaryButton>
        </div>

        {upcoming.length > 0 && (
          <>
            <div className="mb-3 flex items-center justify-between">
              <Eyebrow>Upcoming Events</Eyebrow>
              <button onClick={onOpenEventsList} className="text-[11px] font-medium transition-transform duration-100 active:scale-95" style={{ ...body, color: T.accent }}>View All</button>
            </div>
            <div className="mb-5 flex flex-col gap-2">
              {upcoming.slice(0, 3).map((ev) => {
                const pct = typeof ev.maxCapacity === "number" && ev.maxCapacity > 0
                  ? Math.min(100, Math.round(((ev.bookedCount || 0) / ev.maxCapacity) * 100))
                  : null;
                return (
                  <button key={ev.id} onClick={() => onOpenEvent(ev)} className="p-3.5 text-left w-full transition-transform duration-100 active:scale-[0.98]" style={{ background: T.panel, borderRadius: T.rCard, boxShadow: T.shadowMd }}>
                    <div className="flex items-center justify-between mb-1">
                      <div className="text-[13px] font-semibold" style={{ ...display, color: T.ash }}>{ev.title}</div>
                      {typeof ev.maxCapacity === "number" && (
                        <div className="text-[12px] font-semibold" style={{ ...mono, color: T.good }}>{ev.bookedCount || 0} / {ev.maxCapacity}</div>
                      )}
                    </div>
                    <div className="text-[11px] mb-2" style={{ ...body, color: T.ashFaint }}>{ev.fieldName} — {ev.date}{ev.interestCount > 0 ? ` · ${ev.interestCount} interested` : ""}</div>
                    {pct !== null && (
                      <div style={{ height: 5, borderRadius: T.rPill, background: T.panelAlt, overflow: "hidden" }}>
                        <div style={{ width: `${pct}%`, height: "100%", borderRadius: T.rPill, background: T.good }} />
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          </>
        )}

        {!activityLoading && activity.length > 0 && (
          <>
            <Eyebrow>Recent Activity</Eyebrow>
            <div className="mb-5 flex flex-col gap-2">
              {activity.map((a, i) => {
                const ev = events.find((e) => e.id === a.eventId);
                return (
                  <button
                    key={i}
                    type="button"
                    onClick={() => setSelectedActivity(a)}
                    className="w-full text-left p-3 flex items-center gap-2 transition-transform duration-100 active:scale-[0.98]"
                    style={{ background: T.panel, borderRadius: T.rCard, boxShadow: T.shadowMd }}
                  >
                    <FileSignature size={14} color={T.good} />
                    <div className="flex-1 min-w-0 text-[12px]" style={{ ...body, color: T.ashDim }}>
                      <span style={{ fontWeight: 600, color: T.ash }}>{a.signedName}</span> signed the waiver for {ev?.title || "an event"}
                    </div>
                    {a.signedAt && (
                      <div className="text-[10px] flex-shrink-0" style={{ ...mono, color: T.ashFaint }}>{timeAgo(a.signedAt)}</div>
                    )}
                  </button>
                );
              })}
            </div>
          </>
        )}

        {isOrganizer && !showFieldsSection && !eventsLoading && events.filter((e) => !e.deleted).length === 0 && (
          <div className="p-6 mb-5 flex flex-col items-center text-center" style={{ background: T.panel, borderRadius: T.rCard, boxShadow: T.shadowMd }}>
            <Calendar size={22} color={T.ashDim} className="mb-2" />
            <div className="text-[14px] font-semibold mb-1" style={{ ...display, color: T.ash }}>No events yet</div>
            <p className="text-[12px]" style={{ ...body, color: T.ashDim }}>Create your first event — add the venue, set the date and price, and publish when you're ready. Set up payouts first if it's a paid event.</p>
          </div>
        )}

        {showFieldsSection && (
        <>
        <div className="mb-4 flex items-center justify-between">
          <Eyebrow>My Fields</Eyebrow>
          <button onClick={onOpenClaim} className="text-[12px] font-semibold transition-transform duration-100 active:scale-95" style={{ ...body, color: T.accent }}>
            + Claim a Field
          </button>
        </div>

        {myFieldsLoading ? (
          <div className="text-[13px] py-6 text-center" style={{ ...body, color: T.ashFaint }}>Loading…</div>
        ) : myFields.length === 0 ? (
          <div className="p-6 flex flex-col items-center text-center" style={{ background: T.panel, borderRadius: T.rCard, boxShadow: T.shadowMd }}>
            <Shield size={22} color={T.ashDim} className="mb-2" />
            <div className="text-[14px] font-semibold mb-1" style={{ ...display, color: T.ash }}>No fields claimed yet</div>
            <p className="text-[12px] mb-4" style={{ ...body, color: T.ashDim }}>Find your field and claim it to start managing events.</p>
            <PrimaryButton onClick={onOpenClaim}>Claim a Field</PrimaryButton>
          </div>
        ) : (
          myFields.map((f) => (
            <button
              key={f.id}
              onClick={() => onOpenField(f.id)}
              className="w-full mb-3 p-4 flex items-center gap-3 text-left transition-transform duration-100 active:scale-[0.98]"
              style={{ background: T.panel, borderRadius: T.rCard, boxShadow: T.shadowMd }}
            >
              <div className="flex-1">
                <div className="text-[15px] font-semibold" style={{ ...display, color: T.ash }}>{f.name}</div>
                <div className="text-[12px]" style={{ ...body, color: T.ashFaint }}>{f.city}</div>
              </div>
              <ChevronRight size={16} color={T.ashFaint} />
            </button>
          ))
        )}
        </>
        )}
      </div>

      {selectedActivity && (
        <SignedWaiverModal
          activity={selectedActivity}
          event={events.find((e) => e.id === selectedActivity.eventId)}
          onClose={() => setSelectedActivity(null)}
        />
      )}
    </div>
  );
}

// Lowercase, trim, and collapse punctuation/whitespace so "Black Ops
// Paintball & Airsoft" and a differently-punctuated variant would be
// treated the same — used only to flag same-name-different-location
// collisions in the claim flow, not for search or display.
function normalizeFieldName(name) {
  return (name || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/* ---------- Claim a field ---------- */
function ClaimFieldScreen({ onBack, allFields, allFieldsLoading, ownerId, ownerEmail, claimField, requestClaimCode, verifyWebsiteClaim, requestEmailClaim, verifyEmailClaim, onClaimed }) {
  const [search, setSearch] = useState("");
  const [claimingId, setClaimingId] = useState(null);
  const [error, setError] = useState("");
  const [pendingMsg, setPendingMsg] = useState("");

  // Website-verification sub-flow — opened instead of claiming directly
  // when the claiming account's email doesn't match the field's domain
  // (or there's no domain on file at all) but the field does have a real
  // site to prove ownership of.
  const [verifyField, setVerifyField] = useState(null);
  const [verifyCode, setVerifyCode] = useState("");
  const [verifyWebsiteUrl, setVerifyWebsiteUrl] = useState("");
  const [verifyLoading, setVerifyLoading] = useState(false);
  const [verifyError, setVerifyError] = useState("");

  // Email-code sub-flow — for fields flagged emailClaimEnabled: the server
  // emails a 6-digit code to the invited address, and entering it claims
  // the field.
  const [emailField, setEmailField] = useState(null);
  const [emailSentTo, setEmailSentTo] = useState("");
  const [emailCode, setEmailCode] = useState("");
  const [emailLoading, setEmailLoading] = useState(false);
  const [emailError, setEmailError] = useState("");

  // Same exclusion the players app applies: a relocated, closed, or
  // airsoft-less field has nothing an owner could legitimately claim —
  // it either isn't the field's current home, doesn't exist as a business
  // anymore, or was never really an airsoft venue to begin with.
  const nameCounts = useMemo(() => {
    const counts = {};
    for (const f of allFields) {
      const key = normalizeFieldName(f.name);
      counts[key] = (counts[key] || 0) + 1;
    }
    return counts;
  }, [allFields]);

  const filtered = allFields
    .filter((f) => !["relocated", "closed", "no-airsoft"].includes(f.status))
    .filter((f) => {
      const q = search.trim().toLowerCase();
      if (!q) return true;
      return f.name.toLowerCase().includes(q) || (f.city || "").toLowerCase().includes(q);
    });

  const startWebsiteVerification = async (field) => {
    setVerifyError("");
    setVerifyCode("");
    setVerifyWebsiteUrl(field.website || "");
    setVerifyField(field);
    try {
      const codeRes = await requestClaimCode(field.id);
      setVerifyCode(codeRes.code);
      setVerifyWebsiteUrl(codeRes.website || field.website || "");
    } catch (err) {
      setVerifyError(err.message || "Couldn't start website verification — try again.");
    }
  };

  // Returns true if a code was sent (modal opened), false if this account's
  // email isn't the invited one. Real errors (rate limit, send failure)
  // surface in the claim screen's normal error line via the throw.
  const startEmailVerification = async (field) => {
    const res = await requestEmailClaim(field.id);
    if (!res?.eligible) return false;
    setEmailError("");
    setEmailCode("");
    setEmailSentTo(res.sentTo || ownerEmail || "");
    setEmailField(field);
    return true;
  };

  const handleResendEmailCode = async () => {
    if (!emailField) return;
    setEmailLoading(true);
    setEmailError("");
    try {
      const res = await requestEmailClaim(emailField.id);
      if (res?.eligible) setEmailSentTo(res.sentTo || emailSentTo);
    } catch (err) {
      setEmailError(err.message || "Couldn't resend the code — try again.");
    } finally {
      setEmailLoading(false);
    }
  };

  const handleVerifyEmail = async () => {
    if (!emailField) return;
    setEmailLoading(true);
    setEmailError("");
    try {
      const res = await verifyEmailClaim(emailField.id, emailCode);
      if (res.verified) {
        const fieldId = emailField.id;
        setEmailField(null);
        onClaimed(fieldId);
      } else if (res.reason === "expired") {
        setEmailError("That code expired — tap Send a new code.");
      } else if (res.reason === "too-many-attempts") {
        setEmailError("Too many tries — tap Send a new code.");
      } else {
        setEmailError("That code doesn't match — check the email and try again.");
      }
    } catch (err) {
      setEmailError(err.message || "Couldn't verify — try again.");
    } finally {
      setEmailLoading(false);
    }
  };

  const handleClaim = async (field) => {
    setClaimingId(field.id);
    setError("");
    setPendingMsg("");
    try {
      const hasCollision = nameCounts[normalizeFieldName(field.name)] > 1;
      const result = await claimField(field, ownerEmail, ownerId, hasCollision);
      if (result === "claimed" || result === "claimed-unverified") {
        onClaimed(field.id);
      } else if (result === "pending") {
        setPendingMsg("This field's name matches another listing elsewhere, so we're holding your claim for a quick check before it's activated.");
      } else if (result === "verify-own-email") {
        setPendingMsg(`We sent a verification link to ${ownerEmail}. Open it to confirm this address is yours, then tap Claim again.`);
      } else if (result === "verify-website") {
        await startWebsiteVerification(field);
      } else if (result === "verify-email") {
        const started = await startEmailVerification(field);
        if (!started) {
          // This account's email isn't the invited one — fall back to the
          // normal website route if the field has a site, else explain.
          if (field.website) {
            await startWebsiteVerification(field);
          } else {
            setError("This field was set up for a different email address. Sign in with the address it was sent to, or reach out and we'll sort it out.");
          }
        }
      }
    } catch (err) {
      setError(err.message || "Couldn't claim that field — try again.");
    } finally {
      setClaimingId(null);
    }
  };

  const handleVerifyWebsite = async () => {
    if (!verifyField) return;
    setVerifyLoading(true);
    setVerifyError("");
    try {
      const res = await verifyWebsiteClaim(verifyField.id);
      if (res.verified) {
        const fieldId = verifyField.id;
        setVerifyField(null);
        onClaimed(fieldId);
      } else {
        setVerifyError("Didn't find that code on your site yet — make sure the page is saved and live, then try again.");
      }
    } catch (err) {
      setVerifyError(err.message || "Couldn't verify — try again.");
    } finally {
      setVerifyLoading(false);
    }
  };

  return (
    <div className="h-full overflow-y-auto pb-24" style={flatBg}>
      <div className="px-6 pt-2 pb-4 flex items-center" style={{ borderBottom: `1px solid ${T.line}` }}>
        <button onClick={onBack} className="w-9 h-9 -ml-2 flex items-center justify-center transition-transform duration-100 active:scale-90">
          <ChevronLeft size={20} color={T.ash} />
        </button>
        <h1 className="flex-1 text-center text-[18px] font-semibold mr-9" style={{ ...display, color: T.ash }}>Claim a Field</h1>
      </div>

      <div className="px-6 pt-4">
        <div className="mb-4 flex items-center gap-2 px-3 py-2.5" style={{ border: `1px solid ${T.line}`, background: T.panel, borderRadius: 4 }}>
          <Search size={15} color={T.ashFaint} />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by field name or city"
            className="flex-1 text-[13px] bg-transparent outline-none"
            style={{ ...body, color: T.ash }}
          />
        </div>

        {error && <p className="text-[12px] mb-3" style={{ ...body, color: T.alert }}>{error}</p>}
        {pendingMsg && <p className="text-[12px] mb-3" style={{ ...body, color: T.good }}>{pendingMsg}</p>}

        {allFieldsLoading ? (
          <div className="text-[13px] py-6 text-center" style={{ ...body, color: T.ashFaint }}>Loading fields…</div>
        ) : (
          filtered.map((f) => {
            const isClaimed = f.claimed === true;
            const isPending = f.claimPending === true;
            return (
              <div key={f.id} className="mb-3 p-4 flex items-center gap-3" style={{ background: T.panel, borderRadius: T.rCard, boxShadow: T.shadowMd }}>
                <div className="flex-1">
                  <div className="text-[14px] font-semibold" style={{ ...display, color: T.ash }}>{f.name}</div>
                  <div className="text-[12px]" style={{ ...body, color: T.ashFaint }}>{f.city}</div>
                  {nameCounts[normalizeFieldName(f.name)] > 1 && !isClaimed && !isPending && (
                    <div className="text-[10px] mt-0.5" style={{ ...body, color: T.alert }}>
                      Another field elsewhere is also named "{f.name}" — double check this is {f.city}.
                    </div>
                  )}
                  {!isClaimed && !isPending && (
                    <div className="text-[10px] mt-0.5" style={{ ...body, color: T.ashFaint }}>
                      {f.emailClaimEnabled
                        ? `Claim with the email address you were invited with — we'll send a 6-digit code to confirm it's you${f.website ? " (or verify your site instead if that's not your address)" : ""}`
                        : f.ownerEmailDomain
                        ? `Verified instantly with an @${f.ownerEmailDomain} email${f.website ? " — or verify your site instead if that's not your address" : ""}`
                        : f.website
                        ? "No matching email on file — verify instantly by proving you control the field's website"
                        : nameCounts[normalizeFieldName(f.name)] > 1
                        ? "No website on file and the name matches another listing — claim will be held for a quick manual check"
                        : "No website on file — claims instantly, flagged for review if ever disputed"}
                    </div>
                  )}
                </div>
                {isClaimed ? (
                  <span className="text-[11px] font-medium" style={{ ...body, color: T.ashFaint }}>Already claimed</span>
                ) : isPending ? (
                  <span className="text-[11px] font-medium" style={{ ...body, color: T.accent }}>Pending Review</span>
                ) : (
                  <button
                    onClick={() => handleClaim(f)}
                    disabled={claimingId === f.id}
                    className="px-3 py-2 text-[12px] font-semibold flex-shrink-0 transition-transform duration-100 active:scale-95"
                    style={{ ...display, background: T.ash, color: "#FFFFFF", borderRadius: T.rPill, boxShadow: T.shadowMd, opacity: claimingId === f.id ? 0.6 : 1 }}
                  >
                    {claimingId === f.id ? "…" : "Claim"}
                  </button>
                )}
              </div>
            );
          })
        )}
      </div>

      {emailField && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center px-4 pb-4 sm:pb-0" style={{ background: "rgba(0,0,0,0.5)" }}>
          <div className="w-full sm:max-w-md p-6" style={{ background: T.panel, borderRadius: T.rCard, boxShadow: T.shadowMd }}>
            <h2 className="text-[16px] font-semibold mb-2" style={{ ...display, color: T.ash }}>Claim {emailField.name}</h2>
            <p className="text-[12px] mb-3" style={{ ...body, color: T.ashFaint }}>
              We emailed a 6-digit code to {emailSentTo}. Enter it below to confirm it's you. It expires in 15 minutes.
            </p>
            <input
              value={emailCode}
              onChange={(e) => setEmailCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="000000"
              className="w-full mb-3 px-3 py-2 text-center text-[20px] font-mono tracking-widest outline-none"
              style={{ background: T.bg, borderRadius: 4, border: `1px solid ${T.line}`, color: T.ash }}
            />
            {emailError && <p className="text-[12px] mb-3" style={{ ...body, color: T.alert }}>{emailError}</p>}
            <div className="flex gap-2 mb-2">
              <button
                onClick={() => setEmailField(null)}
                className="flex-1 px-3 py-2.5 text-[13px] font-semibold transition-transform duration-100 active:scale-95"
                style={{ ...display, background: "transparent", color: T.ashFaint, border: `1px solid ${T.line}`, borderRadius: T.rPill }}
              >
                Cancel
              </button>
              <button
                onClick={handleVerifyEmail}
                disabled={emailLoading || emailCode.length !== 6}
                className="flex-1 px-3 py-2.5 text-[13px] font-semibold transition-transform duration-100 active:scale-95"
                style={{ ...display, background: T.ash, color: "#FFFFFF", borderRadius: T.rPill, boxShadow: T.shadowMd, opacity: emailLoading || emailCode.length !== 6 ? 0.6 : 1 }}
              >
                {emailLoading ? "Checking…" : "Verify & claim"}
              </button>
            </div>
            <button
              onClick={handleResendEmailCode}
              disabled={emailLoading}
              className="w-full text-[12px] py-1.5"
              style={{ ...body, color: T.accent, background: "transparent" }}
            >
              Send a new code
            </button>
          </div>
        </div>
      )}

      {verifyField && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center px-4 pb-4 sm:pb-0" style={{ background: "rgba(0,0,0,0.5)" }}>
          <div className="w-full sm:max-w-md p-6" style={{ background: T.panel, borderRadius: T.rCard, boxShadow: T.shadowMd }}>
            <h2 className="text-[16px] font-semibold mb-2" style={{ ...display, color: T.ash }}>Verify {verifyField.name}</h2>
            <p className="text-[12px] mb-3" style={{ ...body, color: T.ashFaint }}>
              Paste the code below anywhere on your site's homepage ({verifyWebsiteUrl || verifyField.website}), save it live, then come back and tap Verify. No manual review needed once it's found.
            </p>
            {verifyCode ? (
              <div className="mb-3 px-3 py-2 text-center text-[15px] font-mono select-all" style={{ background: T.bg, borderRadius: 4, border: `1px solid ${T.line}`, color: T.ash }}>
                {verifyCode}
              </div>
            ) : (
              <div className="text-[12px] mb-3" style={{ ...body, color: T.ashFaint }}>Generating your code…</div>
            )}
            {verifyError && <p className="text-[12px] mb-3" style={{ ...body, color: T.alert }}>{verifyError}</p>}
            <div className="flex gap-2">
              <button
                onClick={() => setVerifyField(null)}
                className="flex-1 px-3 py-2.5 text-[13px] font-semibold transition-transform duration-100 active:scale-95"
                style={{ ...display, background: "transparent", color: T.ashFaint, border: `1px solid ${T.line}`, borderRadius: T.rPill }}
              >
                Cancel
              </button>
              <button
                onClick={handleVerifyWebsite}
                disabled={verifyLoading || !verifyCode}
                className="flex-1 px-3 py-2.5 text-[13px] font-semibold transition-transform duration-100 active:scale-95"
                style={{ ...display, background: T.ash, color: "#FFFFFF", borderRadius: T.rPill, boxShadow: T.shadowMd, opacity: verifyLoading || !verifyCode ? 0.6 : 1 }}
              >
                {verifyLoading ? "Checking…" : "I've added it — Verify"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------- Field profile editing ---------- */
const PRESET_AMENITIES = ["Pro Shop", "Chrono Station", "HPA Refills", "Rentals Available", "Parking", "Restrooms", "Food/Drinks", "Accepts Credit/Debit Cards"];

// The real landing page when an owner taps into one of their fields —
// a summary with real numbers, not straight into the edit form. Editing
// lives one tap away via the pencil icon in the header.
function FieldOverviewScreen({ field, events, eventsLoading, onBack, onEdit, onOpenEvent, onCreateEvent }) {
  const [showDtbQr, setShowDtbQr] = useState(false);
  const [dtbQrUrl, setDtbQrUrl] = useState(null);
  const [shareState, setShareState] = useState(null);
  const handleShare = async () => {
    const result = await shareFieldLink(field);
    if (result === "copied") {
      setShareState("copied");
      setTimeout(() => setShareState(null), 2000);
    }
  };

  const fieldEvents = events.filter((e) => e.fieldId === field.id && !e.deleted);
  const today = new Date().toISOString().slice(0, 10);
  const upcoming = fieldEvents.filter((e) => !e.draft && (e.endDate || e.date) >= today).sort((a, b) => a.date.localeCompare(b.date));
  const totalInterest = fieldEvents.reduce((sum, e) => sum + (e.interestCount || 0), 0);
  const totalBooked = fieldEvents.reduce((sum, e) => sum + (e.bookedCount || 0), 0);
  // Summed only across real upcoming, non-canceled events — counting a
  // canceled event's would-have-been revenue here would be genuinely
  // misleading, not just imprecise.
  const totalProjectedRevenue = upcoming.reduce((sum, e) => {
    if (e.canceled) return sum;
    const p = parsePrice(e.price);
    const cap = typeof e.maxCapacity === "number" ? e.maxCapacity : parseInt(e.maxCapacity, 10);
    return sum + (p && cap ? p * cap : 0);
  }, 0);

  const handleShowDtbQr = () => {
    if (!dtbQrUrl) {
      QRCode.toDataURL("atlas:redeem:dtb", { width: 280, margin: 4, color: { dark: T.ash, light: "#FFFFFF" } }).then(setDtbQrUrl);
    }
    setShowDtbQr(true);
  };

  return (
    <div className="h-full overflow-y-auto pb-24" style={flatBg}>
      <div className="px-6 pt-2 pb-4 flex items-center" style={{ borderBottom: `1px solid ${T.line}` }}>
        <button onClick={onBack} className="w-9 h-9 -ml-2 flex items-center justify-center transition-transform duration-100 active:scale-90">
          <ChevronLeft size={20} color={T.ash} />
        </button>
        <h1 className="flex-1 text-center text-[16px] font-semibold truncate px-2" style={{ ...display, color: T.ash }}>{field.name}</h1>
        <button onClick={handleShare} className="w-9 h-9 flex items-center justify-center transition-transform duration-100 active:scale-90" title="Copy this field's Atlas link">
          {shareState === "copied" ? <Check size={16} color={T.good} /> : <Share2 size={16} color={T.ash} />}
        </button>
      </div>
      {shareState === "copied" && (
        <div className="px-6 pt-2 text-[11px] text-center" style={{ ...body, color: T.good }}>
          Field link copied — paste it anywhere.
        </div>
      )}

      <div className="px-6 pt-4">
        {(() => {
          const gaps = fieldCompletenessGaps(field);
          if (gaps.length === 0) return null;
          const list = gaps.length > 1 ? `${gaps.slice(0, -1).join(", ")} and ${gaps[gaps.length - 1]}` : gaps[0];
          return (
            <button
              onClick={onEdit}
              className="w-full mb-4 p-3 flex items-center gap-3 text-left transition-transform duration-100 active:scale-[0.98]"
              style={{ background: "rgba(21,84,184,0.08)", border: `1px solid ${T.accent}`, borderRadius: 6 }}
            >
              <ImageIcon size={16} color={T.accent} style={{ flexShrink: 0 }} />
              <div className="text-[12px]" style={{ ...body, color: T.ashDim }}>
                <span style={{ fontWeight: 600, color: T.accent }}>{gaps.length} thing{gaps.length === 1 ? "" : "s"} left</span> to finish this field's profile — missing {list}. Amenities, rules, and chrono limits fall back to Atlas's own placeholder text (tagged as such) until you add your field's real info.
              </div>
            </button>
          );
        })()}
        <div className="flex items-center gap-3 mb-4">
          {field.imageUrl ? (
            <div className="w-12 h-12 flex-shrink-0" style={{ backgroundImage: `url("${field.imageUrl}")`, backgroundSize: "cover", backgroundPosition: "center", borderRadius: 8 }} />
          ) : (
            <div className="w-12 h-12 flex-shrink-0 flex items-center justify-center" style={{ background: T.panelAlt, borderRadius: 8 }}>
              <ImageIcon size={18} color={T.ashFaint} />
            </div>
          )}
          <div>
            <div className="text-[15px] font-semibold" style={{ ...display, color: T.ash }}>{field.name}</div>
            {field.city && <div className="text-[12px]" style={{ ...body, color: T.ashFaint }}>{field.city}</div>}
          </div>
        </div>

        <div className="flex gap-2 mb-5">
          <button
            onClick={onEdit}
            className="flex-1 py-2.5 flex items-center justify-center gap-2 transition-transform duration-100 active:scale-[0.98]"
            style={{ background: T.panel, borderRadius: T.rCard, boxShadow: T.shadowMd }}
          >
            <Pencil size={14} color={T.ash} />
            <span className="text-[13px] font-semibold" style={{ ...body, color: T.ash }}>Edit Field Profile</span>
          </button>
          <button
            onClick={() => window.open(`https://playerapp.airsoftatlas.app/?field=${field.id}`, "_blank", "noopener,noreferrer")}
            className="flex-1 py-2.5 flex items-center justify-center gap-2 transition-transform duration-100 active:scale-[0.98]"
            style={{ background: T.panel, borderRadius: T.rCard, boxShadow: T.shadowMd }}
            title="View this field the way a player sees it"
          >
            <ExternalLink size={14} color={T.ash} />
            <span className="text-[13px] font-semibold" style={{ ...body, color: T.ash }}>View as Player</span>
          </button>
        </div>

        <div className="grid grid-cols-3 gap-2 mb-5">
          <div className="p-3 text-center" style={{ background: T.panel, borderRadius: T.rCard, boxShadow: T.shadowMd }}>
            <div className="text-[18px] font-semibold" style={{ ...display, color: T.ash }}>{eventsLoading ? "…" : upcoming.length}</div>
            <div className="text-[10px]" style={{ ...body, color: T.ashFaint }}>Upcoming</div>
          </div>
          <div className="p-3 text-center" style={{ background: T.panel, borderRadius: T.rCard, boxShadow: T.shadowMd }}>
            <div className="text-[18px] font-semibold" style={{ ...display, color: T.good }}>{eventsLoading ? "…" : totalBooked}</div>
            <div className="text-[10px]" style={{ ...body, color: T.ashFaint }}>Reserved</div>
          </div>
          <div className="p-3 text-center" style={{ background: T.panel, borderRadius: T.rCard, boxShadow: T.shadowMd }}>
            <div className="text-[18px] font-semibold" style={{ ...display, color: T.ash }}>{eventsLoading ? "…" : totalInterest}</div>
            <div className="text-[10px]" style={{ ...body, color: T.ashFaint }}>Interested</div>
          </div>
        </div>

        {!eventsLoading && totalProjectedRevenue > 0 && (
          <div className="p-3 mb-5" style={{ background: T.panel, borderRadius: T.rCard, boxShadow: T.shadowMd }}>
            <div className="text-[12px]" style={{ ...body, color: T.ashDim }}>
              Projected Revenue (Gross, Upcoming): <span style={{ fontWeight: 600, color: T.accent }}>${totalProjectedRevenue.toFixed(2)}</span> — summed across this field's upcoming events at full capacity, not a real payment yet
            </div>
          </div>
        )}

        <div className="flex items-center justify-between mb-2">
          <Eyebrow>Upcoming Events</Eyebrow>
          <button onClick={() => onCreateEvent(field)} className="text-[12px] font-semibold transition-transform duration-100 active:scale-95" style={{ ...body, color: T.accent }}>+ New Event</button>
        </div>
        {eventsLoading ? (
          <p className="text-[13px] py-4 text-center" style={{ ...body, color: T.ashFaint }}>Loading…</p>
        ) : upcoming.length === 0 ? (
          <p className="text-[12px] mb-5" style={{ ...body, color: T.ashFaint }}>No upcoming published events.</p>
        ) : (
          <div className="flex flex-col gap-2 mb-5">
            {upcoming.map((ev) => (
              <button key={ev.id} onClick={() => onOpenEvent(ev)} className="p-3 flex items-center justify-between text-left transition-transform duration-100 active:scale-95" style={{ background: T.panel, borderRadius: T.rCard, boxShadow: T.shadowMd }}>
                <div>
                  <div className="text-[13px] font-semibold" style={{ ...display, color: T.ash }}>{ev.title}</div>
                  <div className="text-[11px]" style={{ ...body, color: T.ashFaint }}>{ev.date}</div>
                </div>
                <ChevronRight size={16} color={T.ashFaint} />
              </button>
            ))}
          </div>
        )}

        {field.id === "the-compound" && (
          <>
            <Eyebrow>DTB Patch</Eyebrow>
            <p className="text-[11px] mb-2 -mt-1" style={{ ...body, color: T.ashFaint }}>
              Real players earn this automatically after 3 real check-ins here — this QR is a special, faster way to hand it to someone in person.
            </p>
            {!showDtbQr ? (
              <button onClick={handleShowDtbQr} className="w-full py-3 flex items-center justify-center gap-2 transition-transform duration-100 active:scale-[0.98]" style={{ background: T.panel, borderRadius: T.rCard, boxShadow: T.shadowMd }}>
                <QrCode size={16} color={T.ashDim} />
                <span className="text-[13px] font-medium" style={{ ...body, color: T.ash }}>Show DTB QR</span>
              </button>
            ) : (
              <div className="p-4 flex flex-col items-center" style={{ background: T.panel, borderRadius: T.rCard, boxShadow: T.shadowMd }}>
                <button onClick={() => setShowDtbQr(false)} className="self-end -mt-1 -mr-1 w-7 h-7 flex items-center justify-center transition-transform duration-100 active:scale-90">
                  <X size={16} color={T.ashFaint} />
                </button>
                {dtbQrUrl ? (
                  <img src={dtbQrUrl} alt="DTB redemption code" className="w-56 h-56" />
                ) : (
                  <div className="w-56 h-56 flex items-center justify-center" style={{ color: T.ashFaint }}>Generating…</div>
                )}
                <p className="text-[11px] text-center mt-2" style={{ ...body, color: T.ashFaint }}>Have them scan this from their own Profile → Scan a Patch Code.</p>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function FieldManageScreen({ field, onBack, updateFieldProfile, onOpenEvents }) {
  const [imageUrl, setImageUrl] = useState(field.imageUrl || null);
  const [bannerUploading, setBannerUploading] = useState(false);
  const bannerInputRef = React.useRef(null);
  const [name, setName] = useState(field.name || "");
  // Whole years; blank = no minimum. Enforced for real server-side when a
  // parent books a child (resolveAttendees in the players app's functions).
  const [minimumAge, setMinimumAge] = useState(field.minimumAge ? String(field.minimumAge) : "");
  const [address, setAddress] = useState(field.address || "");
  // field.city is stored (and read by the player app) as a single combined
  // "City, ST" string — split it here just for a better editing experience.
  // Recombined back into that same format on save, so the player app's
  // existing display and state-filtering logic needs no changes at all.
  const [city, setCity] = useState((field.city || "").split(",")[0]?.trim() || "");
  const [state, setState] = useState((field.city || "").split(",")[1]?.trim() || "");
  const [phone, setPhone] = useState(field.phone || "");
  const [email, setEmail] = useState(field.email || "");
  const [website, setWebsite] = useState(field.website || "");
  const [about, setAbout] = useState(field.about || "");
  const [amenities, setAmenities] = useState(field.amenities || []);
  const [customAmenity, setCustomAmenity] = useState("");
  const [rulesText, setRulesText] = useState((field.rules || []).join("\n"));
  // A flexible list of { label, value } pairs (e.g. { label: "AEG", value:
  // "400 FPS max (0.20g)" }) instead of a fixed aeg/sniper/dmr shape, so an
  // owner can add or remove as many chrono limits as their field actually
  // needs. A field saved under the old fixed shape gets read in here as its
  // 3 named rows and upgraded to this list shape the next time it's saved;
  // FieldFacts on the player app reads both shapes.
  const initialChronoLimits = (() => {
    const ch = field.chrono;
    if (Array.isArray(ch)) return ch.map((item) => ({ label: item?.label || "", value: item?.value || "" }));
    return [
      { label: "AEG", value: ch?.aeg || "" },
      { label: "Sniper", value: ch?.sniper || "" },
      { label: "DMR", value: ch?.dmr || "" },
    ];
  })();
  const [chronoLimits, setChronoLimits] = useState(initialChronoLimits);
  // Rental items need a stable id (like priceOptions.choices already have
  // on events) so the checkout Cloud Function can safely re-validate a
  // player's selection against this field's real, current rental catalog
  // by id rather than trusting a client-sent price. Existing rentals saved
  // before this had no id — backfilled here on load, same
  // read-old-shape-then-upgrade-on-save approach already used for Chrono
  // Limits above.
  const [rentals, setRentals] = useState(
    (field.rentals || []).map((r, i) => ({ ...r, id: r.id || `rental_legacy_${i}` }))
  );
  const [savedWaivers, setSavedWaivers] = useState(field.savedWaivers || []);

  // Private shipping/mailing address — loaded separately (a different,
  // non-public doc) and hydrated into local state once, the first time it
  // loads. Not folded into the field.* defaults above like everything else
  // on this screen, since it isn't part of the field prop at all.
  const { shippingAddress, shippingAddressLoading } = useFieldShippingAddress(field.id);
  const { saveShippingAddress } = useShippingAddressActions();
  const [shipHydrated, setShipHydrated] = useState(false);
  const [shipRecipient, setShipRecipient] = useState("");
  const [shipLine1, setShipLine1] = useState("");
  const [shipLine2, setShipLine2] = useState("");
  const [shipCity, setShipCity] = useState("");
  const [shipState, setShipState] = useState("");
  const [shipZip, setShipZip] = useState("");
  const [shipNotes, setShipNotes] = useState("");

  useEffect(() => {
    if (shippingAddressLoading || shipHydrated) return;
    const a = shippingAddress || {};
    setShipRecipient(a.recipientName || "");
    setShipLine1(a.line1 || "");
    setShipLine2(a.line2 || "");
    setShipCity(a.city || "");
    setShipState(a.state || "");
    setShipZip(a.zip || "");
    setShipNotes(a.notes || "");
    setShipHydrated(true);
    // Also backfills the snapshot below with the real loaded values, once
    // — otherwise hasChanges would spuriously flip true the instant this
    // async load lands (local state moving from "" to a real value, with
    // nothing in snapshot yet to match it), even though the owner hasn't
    // touched anything.
    setSnapshot((prev) => ({
      ...prev,
      shipRecipient: a.recipientName || "", shipLine1: a.line1 || "", shipLine2: a.line2 || "",
      shipCity: a.city || "", shipState: a.state || "", shipZip: a.zip || "", shipNotes: a.notes || "",
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shippingAddressLoading, shipHydrated]);

  const [gallery, setGallery] = useState(field.galleryPhotos || []);
  const [galleryUploading, setGalleryUploading] = useState(false);
  const galleryInputRef = React.useRef(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  // Captured once, at mount — compared against current state to decide
  // whether Save should even be tappable. Updated after a successful save
  // so the button correctly disables again until something new changes.
  const [snapshot, setSnapshot] = useState({
    imageUrl: field.imageUrl || null, name: field.name || "", address: field.address || "",
    minimumAge: field.minimumAge ? String(field.minimumAge) : "",
    city: (field.city || "").split(",")[0]?.trim() || "", state: (field.city || "").split(",")[1]?.trim() || "",
    phone: field.phone || "", email: field.email || "", website: field.website || "",
    about: field.about || "", amenities: field.amenities || [],
    rulesText: (field.rules || []).join("\n"), chronoLimits: initialChronoLimits, rentals: field.rentals || [],
    savedWaivers: field.savedWaivers || [],
    shipRecipient: "", shipLine1: "", shipLine2: "", shipCity: "", shipState: "", shipZip: "", shipNotes: "",
  });
  const hasChanges =
    imageUrl !== snapshot.imageUrl || name !== snapshot.name || address !== snapshot.address || minimumAge !== snapshot.minimumAge ||
    city !== snapshot.city || state !== snapshot.state ||
    phone !== snapshot.phone || email !== snapshot.email || website !== snapshot.website ||
    about !== snapshot.about ||
    JSON.stringify(amenities) !== JSON.stringify(snapshot.amenities) ||
    rulesText !== snapshot.rulesText ||
    JSON.stringify(chronoLimits) !== JSON.stringify(snapshot.chronoLimits) ||
    JSON.stringify(rentals) !== JSON.stringify(snapshot.rentals) ||
    JSON.stringify(savedWaivers) !== JSON.stringify(snapshot.savedWaivers) ||
    shipRecipient !== snapshot.shipRecipient || shipLine1 !== snapshot.shipLine1 || shipLine2 !== snapshot.shipLine2 ||
    shipCity !== snapshot.shipCity || shipState !== snapshot.shipState || shipZip !== snapshot.shipZip || shipNotes !== snapshot.shipNotes;

  const toggleAmenity = (a) => {
    setAmenities(amenities.includes(a) ? amenities.filter((x) => x !== a) : [...amenities, a]);
  };
  const addCustomAmenity = () => {
    const val = customAmenity.trim();
    if (val && !amenities.includes(val)) setAmenities([...amenities, val]);
    setCustomAmenity("");
  };
  const removeAmenity = (a) => setAmenities(amenities.filter((x) => x !== a));

  const addChronoLimit = () => setChronoLimits([...chronoLimits, { label: "", value: "" }]);
  const updateChronoLimit = (i, key, value) => {
    const next = [...chronoLimits];
    next[i] = { ...next[i], [key]: value };
    setChronoLimits(next);
  };
  const removeChronoLimit = (i) => setChronoLimits(chronoLimits.filter((_, idx) => idx !== i));

  const addRental = () => setRentals([...rentals, { id: `rental_${Date.now()}_${rentals.length}`, name: "", price: "", includes: "", availability: "" }]);
  const updateRental = (i, key, value) => {
    const next = [...rentals];
    next[i] = { ...next[i], [key]: value };
    setRentals(next);
  };
  const removeRental = (i) => setRentals(rentals.filter((_, idx) => idx !== i));

  const addSavedWaiver = () => setSavedWaivers([...savedWaivers, { name: "", text: "" }]);
  const updateSavedWaiver = (i, key, value) => {
    const next = [...savedWaivers];
    next[i] = { ...next[i], [key]: value };
    setSavedWaivers(next);
  };
  const removeSavedWaiver = (i) => setSavedWaivers(savedWaivers.filter((_, idx) => idx !== i));

  const handleBannerPick = () => bannerInputRef.current?.click();
  const handleBannerSelected = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setBannerUploading(true);
    setError("");
    try {
      const resized = await resizeImageFile(file, 1200, 0.85);
      const storageRef = ref(storage, `fieldGallery/${field.id}/banner.jpg`);
      await uploadBytes(storageRef, resized, { contentType: "image/jpeg" });
      const url = await getDownloadURL(storageRef);
      setImageUrl(url);
      await updateFieldProfile(field.id, { imageUrl: url });
    } catch (err) {
      setError("Couldn't upload that image — try again.");
    } finally {
      setBannerUploading(false);
    }
  };

  const handleGalleryPick = () => galleryInputRef.current?.click();
  const handleGallerySelected = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setGalleryUploading(true);
    setError("");
    try {
      const resized = await resizeImageFile(file, 1000, 0.85);
      const fileName = `${Date.now()}.jpg`;
      const storageRef = ref(storage, `fieldGallery/${field.id}/${fileName}`);
      await uploadBytes(storageRef, resized, { contentType: "image/jpeg" });
      const url = await getDownloadURL(storageRef);
      const nextGallery = [...gallery, { url, path: `fieldGallery/${field.id}/${fileName}` }];
      setGallery(nextGallery);
      await updateFieldProfile(field.id, { galleryPhotos: nextGallery });
    } catch (err) {
      setError("Couldn't upload that photo — try again.");
    } finally {
      setGalleryUploading(false);
    }
  };
  const removeGalleryPhoto = async (photo) => {
    const nextGallery = gallery.filter((g) => g.url !== photo.url);
    setGallery(nextGallery);
    try {
      await deleteObject(ref(storage, photo.path));
    } catch {
      // file may already be gone — not worth failing the UI over
    }
    await updateFieldProfile(field.id, { galleryPhotos: nextGallery });
  };

  const handleSave = async () => {
    setSaving(true);
    setSaved(false);
    setError("");
    try {
      const rules = rulesText.split("\n").map((s) => s.trim()).filter(Boolean);
      const cleanChrono = chronoLimits
        .map((ch) => ({ label: ch.label.trim(), value: ch.value.trim() }))
        .filter((ch) => ch.label || ch.value);
      const chrono = cleanChrono.length > 0 ? cleanChrono : null;
      // priceCents is the trustworthy number checkout validates a player's
      // rental selection against server-side — the free-text `price` stays
      // exactly as typed for display/editing (e.g. "$30"), parsed the same
      // way priceOptionsChoices' price already is on events.
      const cleanRentals = rentals
        .filter((r) => r.name.trim())
        .map((r) => ({ ...r, priceCents: Math.round((parsePrice(r.price) || 0) * 100) }));
      const combinedCity = state.trim() ? `${city.trim()}, ${state.trim()}` : city.trim();
      const minAgeNum = parseInt(minimumAge, 10);
      const cleanMinAge = Number.isInteger(minAgeNum) && minAgeNum > 0 && minAgeNum <= 99 ? minAgeNum : null;
      await updateFieldProfile(field.id, {
        name, address, city: combinedCity, phone, email, website, about, amenities, rules, chrono, rentals: cleanRentals, imageUrl,
        minimumAge: cleanMinAge,
        // Explicitly cleared, not just omitted — hours are per-event now,
        // not per-field, so this actively wipes any stale value already
        // sitting on a field's document rather than leaving it dangling.
        hours: null,
        savedWaivers: savedWaivers.filter((w) => w.name.trim() && w.text.trim()),
      });
      // Separate write, separate (private) document — never goes anywhere
      // near the public fields/{id} doc above.
      await saveShippingAddress(field.id, {
        recipientName: shipRecipient.trim(),
        line1: shipLine1.trim(),
        line2: shipLine2.trim(),
        city: shipCity.trim(),
        state: shipState.trim(),
        zip: shipZip.trim(),
        notes: shipNotes.trim(),
      });
      setSnapshot({
        imageUrl, name, address, minimumAge, city, state, phone, email, website, about, amenities, rulesText, chronoLimits, rentals, savedWaivers,
        shipRecipient, shipLine1, shipLine2, shipCity, shipState, shipZip, shipNotes,
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (err) {
      setError("Couldn't save — try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="h-full overflow-y-auto pb-24" style={flatBg}>
      <div className="px-6 pt-2 pb-4 flex items-center" style={{ borderBottom: `1px solid ${T.line}` }}>
        <button onClick={onBack} className="w-9 h-9 -ml-2 flex items-center justify-center transition-transform duration-100 active:scale-90">
          <ChevronLeft size={20} color={T.ash} />
        </button>
        <h1 className="flex-1 text-center text-[18px] font-semibold mr-9" style={{ ...display, color: T.ash }}>{field.name}</h1>
      </div>

      <div className="px-6 pt-4">
        <Eyebrow>Field Banner</Eyebrow>
        <input ref={bannerInputRef} type="file" accept="image/*" onChange={handleBannerSelected} className="hidden" />
        <button
          onClick={handleBannerPick}
          disabled={bannerUploading}
          className="w-full h-44 mb-5 flex flex-col items-center justify-center gap-1 overflow-hidden transition-transform duration-100 active:scale-[0.98]"
          style={{ background: T.panelAlt, border: `1px dashed ${T.line}`, borderRadius: 6 }}
        >
          {imageUrl ? (
            // contain (not cover) so the owner always sees the whole banner here —
            // a cropped preview made it look like the upload was getting cut off.
            <img src={imageUrl} alt="" className="w-full h-full" style={{ objectFit: "contain" }} />
          ) : (
            <>
              <ImageIcon size={20} color={T.ashDim} />
              <span className="text-[12px] font-medium" style={{ ...body, color: T.accent }}>{bannerUploading ? "Uploading…" : "Upload field banner photo"}</span>
              <span className="text-[10px]" style={{ ...body, color: T.ashFaint }}>This is the main photo players see on your field's page</span>
            </>
          )}
        </button>

        <button
          onClick={onOpenEvents}
          className="w-full mb-5 p-4 flex items-center gap-3 text-left transition-transform duration-100 active:scale-[0.98]"
          style={{ background: T.panel, borderRadius: 6, border: `1.5px solid ${T.accent}` }}
        >
          <Calendar size={18} color={T.accent} />
          <div className="flex-1 text-[14px] font-semibold" style={{ ...display, color: T.ash }}>Manage Events</div>
          <ChevronRight size={16} color={T.ashFaint} />
        </button>

        <Eyebrow>Basic Information</Eyebrow>
        <TextField label="Field Name" value={name} onChange={setName} />
        <TextField label="Street Address" value={address} onChange={setAddress} />
        <div className="flex gap-2">
          <div className="flex-1">
            <TextField label="City" value={city} onChange={setCity} placeholder="Auburn" />
          </div>
          <div style={{ width: 90 }}>
            <TextField label="State" value={state} onChange={setState} placeholder="MI" />
          </div>
        </div>
        {field.lat && (
          <p className="text-[10px] mb-3 -mt-2" style={{ ...body, color: T.ashFaint }}>
            Changing the address here won't move the map pin — that needs a separate re-geocoding pass. Contact support if the address changes significantly.
          </p>
        )}
        <TextField label="Contact Phone" value={phone} onChange={setPhone} placeholder="+1 (555) 000-0000" />
        <TextField label="Email Address" value={email} onChange={setEmail} placeholder="contact@yourfield.com" type="email" />
        <TextField label="Website" value={website} onChange={setWebsite} placeholder="https://yourfield.com" />

        <Eyebrow>About & Hours</Eyebrow>
        <TextField label="About" value={about} onChange={setAbout} rows={4} placeholder="Tell players about your field — atmosphere, general hours, what to expect…" showCount />

        <Eyebrow>Field Amenities</Eyebrow>
        <div className="flex flex-wrap gap-2 mb-2">
          {PRESET_AMENITIES.map((a) => {
            const active = amenities.includes(a);
            return (
              <button
                key={a}
                onClick={() => toggleAmenity(a)}
                className="px-3 py-1.5 text-[12px] font-medium flex items-center gap-1 transition-transform duration-100 active:scale-95"
                style={{ ...body, border: `1px solid ${active ? T.good : T.line}`, background: active ? "rgba(15,122,82,0.1)" : "transparent", color: active ? T.good : T.ashDim, borderRadius: 999 }}
              >
                {active && <Check size={12} strokeWidth={3} />} {a}
              </button>
            );
          })}
          {amenities.filter((a) => !PRESET_AMENITIES.includes(a)).map((a) => (
            <button
              key={a}
              onClick={() => removeAmenity(a)}
              className="px-3 py-1.5 text-[12px] font-medium flex items-center gap-1 transition-transform duration-100 active:scale-95"
              style={{ ...body, border: `1px solid ${T.good}`, background: "rgba(15,122,82,0.1)", color: T.good, borderRadius: 999 }}
            >
              <Check size={12} strokeWidth={3} /> {a} ×
            </button>
          ))}
        </div>
        <div className="flex gap-2 mb-4">
          <input
            value={customAmenity}
            onChange={(e) => setCustomAmenity(e.target.value)}
            placeholder="Add a custom amenity…"
            className="flex-1 px-3 py-2 text-[12px] bg-transparent outline-none"
            style={{ ...body, background: T.panelAlt, border: `1px solid ${T.line}`, borderRadius: 4, color: T.ash }}
          />
          <button onClick={addCustomAmenity} className="px-3 py-2 text-[12px] font-semibold transition-transform duration-100 active:scale-95" style={{ ...body, border: `1px solid ${T.line}`, color: T.ashDim, borderRadius: T.rPill }}>
            Add
          </button>
        </div>

        <Eyebrow>Venue Gallery Photos</Eyebrow>
        <div className="flex flex-wrap gap-2 mb-4">
          {gallery.map((g) => (
            <div key={g.url} className="relative w-20 h-20">
              <img src={g.url} alt="" className="w-full h-full" style={{ objectFit: "cover", borderRadius: 4 }} />
              <button onClick={() => removeGalleryPhoto(g)} className="absolute -top-1.5 -right-1.5 w-5 h-5 flex items-center justify-center transition-transform duration-100 active:scale-95" style={{ background: T.alert, borderRadius: 999 }}>
                <span style={{ color: "#fff", fontSize: 11, lineHeight: 1 }}>×</span>
              </button>
            </div>
          ))}
          <input ref={galleryInputRef} type="file" accept="image/*" onChange={handleGallerySelected} className="hidden" />
          <button
            onClick={handleGalleryPick}
            disabled={galleryUploading}
            className="w-20 h-20 flex flex-col items-center justify-center gap-1 transition-transform duration-100 active:scale-95"
            style={{ background: T.panelAlt, border: `1px dashed ${T.line}`, borderRadius: 4 }}
          >
            <ImageIcon size={16} color={T.ashDim} />
            <span className="text-[9px]" style={{ ...body, color: T.ashFaint }}>{galleryUploading ? "…" : "Add Photo"}</span>
          </button>
        </div>

        <Eyebrow>Field Rules (one per line)</Eyebrow>
        <TextField value={rulesText} onChange={setRulesText} rows={5} placeholder="Full-seal eye protection required at all times…" />

        <Eyebrow>Minimum Age to Play</Eyebrow>
        <TextField value={minimumAge} onChange={setMinimumAge} type="number" placeholder="Leave blank for no minimum" />
        <p className="text-[11px] mb-4" style={{ ...body, color: T.ashFaint }}>
          Parents can bring children who meet this age, counted on the event's start date. Blank means no minimum.
        </p>

        <div className="mb-2 flex items-center justify-between">
          <label className="text-[10px] font-semibold uppercase" style={{ ...mono, color: T.ashFaint, letterSpacing: "0.04em" }}>Chrono Limits</label>
          <button onClick={addChronoLimit} className="text-[12px] font-semibold transition-transform duration-100 active:scale-95" style={{ ...body, color: T.accent }}>+ Add Item</button>
        </div>
        <div className="mb-3">
          {chronoLimits.map((ch, i) => (
            <div key={i} className="flex gap-2 mb-2">
              <input value={ch.label} onChange={(e) => updateChronoLimit(i, "label", e.target.value)} placeholder="e.g. AEG, Sniper, Pistol"
                className="w-28 flex-shrink-0 px-2.5 py-2 text-[13px] bg-transparent outline-none" style={{ ...body, background: T.panelAlt, border: `1px solid ${T.line}`, borderRadius: 4, color: T.ash }} />
              <input value={ch.value} onChange={(e) => updateChronoLimit(i, "value", e.target.value)} placeholder="e.g. 400 FPS max (0.20g)"
                className="flex-1 px-2.5 py-2 text-[13px] bg-transparent outline-none" style={{ ...body, background: T.panelAlt, border: `1px solid ${T.line}`, borderRadius: 4, color: T.ash }} />
              <button onClick={() => removeChronoLimit(i)} className="w-9 h-9 flex-shrink-0 flex items-center justify-center transition-transform duration-100 active:scale-90" style={{ background: T.panelAlt, borderRadius: T.rPill }}>
                <Trash2 size={14} color={T.alert} />
              </button>
            </div>
          ))}
          {chronoLimits.length === 0 && (
            <p className="text-[11px]" style={{ ...body, color: T.ashFaint }}>No chrono limits added yet.</p>
          )}
        </div>

        <div className="mb-2 flex items-center justify-between">
          <label className="text-[10px] font-semibold uppercase" style={{ ...mono, color: T.ashFaint, letterSpacing: "0.04em" }}>Rental Gear</label>
          <button onClick={addRental} className="text-[12px] font-semibold transition-transform duration-100 active:scale-95" style={{ ...body, color: T.accent }}>+ Add Item</button>
        </div>
        {rentals.map((r, i) => (
          <div key={i} className="mb-3 p-3" style={{ background: T.panel, borderRadius: T.rCard, boxShadow: T.shadowMd }}>
            <div className="flex gap-2 mb-2">
              <input value={r.name} onChange={(e) => updateRental(i, "name", e.target.value)} placeholder="Item name"
                className="flex-1 px-2.5 py-2 text-[13px] bg-transparent outline-none" style={{ ...body, background: T.panelAlt, border: `1px solid ${T.line}`, borderRadius: 4, color: T.ash }} />
              <input value={r.price} onChange={(e) => updateRental(i, "price", e.target.value)} placeholder="$30"
                className="w-20 px-2.5 py-2 text-[13px] bg-transparent outline-none" style={{ ...body, background: T.panelAlt, border: `1px solid ${T.line}`, borderRadius: 4, color: T.ash }} />
              <button onClick={() => removeRental(i)} className="w-9 h-9 flex-shrink-0 flex items-center justify-center transition-transform duration-100 active:scale-90" style={{ background: T.panelAlt, borderRadius: T.rPill }}>
                <Trash2 size={14} color={T.alert} />
              </button>
            </div>
            <input value={r.includes} onChange={(e) => updateRental(i, "includes", e.target.value)} placeholder="What's included"
              className="w-full mb-2 px-2.5 py-2 text-[12px] bg-transparent outline-none" style={{ ...body, background: T.panelAlt, border: `1px solid ${T.line}`, borderRadius: 4, color: T.ash }} />
            <input value={r.availability} onChange={(e) => updateRental(i, "availability", e.target.value)} placeholder="Availability note"
              className="w-full px-2.5 py-2 text-[12px] bg-transparent outline-none" style={{ ...body, background: T.panelAlt, border: `1px solid ${T.line}`, borderRadius: 4, color: T.ash }} />
          </div>
        ))}

        <div className="mb-2 flex items-center justify-between">
          <label className="text-[10px] font-semibold uppercase" style={{ ...mono, color: T.ashFaint, letterSpacing: "0.04em" }}>Saved Waivers</label>
          <button onClick={addSavedWaiver} className="text-[12px] font-semibold transition-transform duration-100 active:scale-95" style={{ ...body, color: T.accent }}>+ Add Waiver</button>
        </div>
        <p className="text-[11px] mb-2 -mt-1" style={{ ...body, color: T.ashFaint }}>
          Save a waiver here once, then pick it from a list when creating an event instead of retyping it every time.
        </p>
        {savedWaivers.map((w, i) => (
          <div key={i} className="mb-3 p-3" style={{ background: T.panel, borderRadius: T.rCard, boxShadow: T.shadowMd }}>
            <div className="flex gap-2 mb-2">
              <input value={w.name} onChange={(e) => updateSavedWaiver(i, "name", e.target.value)} placeholder="e.g. Standard Waiver, MilSim Waiver"
                className="flex-1 px-2.5 py-2 text-[13px] bg-transparent outline-none" style={{ ...body, background: T.panelAlt, border: `1px solid ${T.line}`, borderRadius: 4, color: T.ash }} />
              <button onClick={() => removeSavedWaiver(i)} className="w-9 h-9 flex-shrink-0 flex items-center justify-center transition-transform duration-100 active:scale-90" style={{ background: T.panelAlt, borderRadius: T.rPill }}>
                <Trash2 size={14} color={T.alert} />
              </button>
            </div>
            <textarea value={w.text} onChange={(e) => updateSavedWaiver(i, "text", e.target.value)} placeholder="Waiver text…" rows={5}
              className="w-full px-2.5 py-2 text-[12px] bg-transparent outline-none" style={{ ...body, background: T.panelAlt, border: `1px solid ${T.line}`, borderRadius: 4, color: T.ash, resize: "none" }} />
          </div>
        ))}

        <Eyebrow>Shipping Address</Eyebrow>
        <p className="text-[11px] mb-3 -mt-1" style={{ ...body, color: T.ashFaint }}>
          Where should we send your welcome package (stickers, a tablet stand, etc.)? This can be different from your field's public address above — handy for fields where no one's usually on-site to receive mail. Private: only you and the Atlas team can see this, it's never shown to players.
        </p>
        <TextField label="Recipient Name (optional)" value={shipRecipient} onChange={setShipRecipient} placeholder="Who should it be addressed to?" />
        <TextField label="Address Line 1" value={shipLine1} onChange={setShipLine1} placeholder="Street address or PO Box" />
        <TextField label="Address Line 2 (optional)" value={shipLine2} onChange={setShipLine2} placeholder="Apt, suite, unit, etc." />
        <div className="flex gap-2">
          <div className="flex-1">
            <TextField label="City" value={shipCity} onChange={setShipCity} />
          </div>
          <div style={{ width: 84 }}>
            <TextField label="State" value={shipState} onChange={setShipState} placeholder="MI" />
          </div>
          <div style={{ width: 110 }}>
            <TextField label="ZIP" value={shipZip} onChange={setShipZip} />
          </div>
        </div>
        <TextField label="Delivery Notes (optional)" value={shipNotes} onChange={setShipNotes} placeholder="Gate code, best drop-off spot, etc." rows={2} />

        {error && <p className="text-[12px] mb-2" style={{ ...body, color: T.alert }}>{error}</p>}
        {saved && <p className="text-[12px] mb-2" style={{ ...body, color: T.good }}>Saved — live on the player app now.</p>}
        <div className="mb-6">
          <PrimaryButton onClick={handleSave} disabled={saving || !hasChanges}>{saving ? "Saving…" : "Save Profile Changes"}</PrimaryButton>
        </div>
      </div>
    </div>
  );
}

const GAME_TYPES = [
  { key: "OUTDOOR", label: "Outdoor Rec Play" },
  { key: "MILSIM", label: "MilSim" },
  { key: "INDOOR", label: "Indoor" },
  { key: "TOURNAMENT", label: "Tournament" },
];

// The real landing page when an owner taps into one of their events — a
// summary with real stats, not straight into the edit form. Mirrors
// FieldOverviewScreen's exact pattern: view first, edit is one tap away
// via the pencil icon.
function EventOverviewScreen({ ev, onBack, onEdit, onOpenRoster, allMyEvents }) {
  const today = new Date().toISOString().slice(0, 10);
  const isPast = !ev.draft && !!(ev.endDate || ev.date) && (ev.endDate || ev.date) < today;

  // After-Action Report data - only fetched for a past, non-draft event
  // (each hook's own falsy-id/empty-events short-circuit makes this free
  // for an upcoming event's overview). New-vs-returning specifically is
  // the expensive one (the owner's entire multi-event booking history) -
  // deliberately gated the same way, per the 2026-09-28 scoping's
  // Decision #4, rather than fetched unconditionally.
  const { bookings: aarBookings, bookingsLoading: aarBookingsLoading } = useEventBookings(isPast ? ev.id : null);
  const { signatures: aarSignatures } = useEventWaivers(isPast ? ev.id : null, ev.hostOwnerId);
  const { interestedCount: aarInterestedCount } = useEventInterestedCount(isPast ? ev.id : null);
  const { reservationBookings: aarAllBookings } = useOwnerReservationStats(isPast ? (allMyEvents || []) : []);

  let aarStats = null;
  if (isPast && !aarBookingsLoading) {
    const reservedCount = aarBookings.length;
    const checkedInCount = aarBookings.filter((b) => b.checkedIn).length;
    const revenueCents = aarBookings.reduce((sum, b) => {
      if (!b.paid || typeof b.amountPaidCents !== "number") return sum;
      return sum + (b.amountPaidCents - (typeof b.bookingFeeCents === "number" ? b.bookingFeeCents : 0));
    }, 0);
    const rentalCounts = {};
    aarBookings.forEach((b) => {
      (b.selectedRentals || []).forEach((r) => {
        rentalCounts[r.name] = (rentalCounts[r.name] || 0) + 1;
      });
    });
    const choiceCounts = {};
    aarBookings.forEach((b) => {
      if (b.selectedChoiceLabel) choiceCounts[b.selectedChoiceLabel] = (choiceCounts[b.selectedChoiceLabel] || 0) + 1;
    });
    const classified = classifyReturning(aarAllBookings).filter((b) => b.eventId === ev.id);
    const returningCount = classified.filter((b) => b.isReturning).length;

    aarStats = {
      reservedCount,
      checkedInCount,
      noShowCount: reservedCount - checkedInCount,
      checkInRate: reservedCount > 0 ? (checkedInCount / reservedCount) * 100 : null,
      revenueCents,
      waiverCount: aarSignatures.length,
      interestedCount: aarInterestedCount,
      rentalCounts,
      choiceCounts,
      returningCount,
      newCount: classified.length - returningCount,
      classifiedCount: classified.length,
    };
  }

  return (
    <div className="h-full overflow-y-auto pb-24" style={flatBg}>
      <div className="px-6 pt-2 pb-4 flex items-center" style={{ borderBottom: `1px solid ${T.line}` }}>
        <button onClick={onBack} className="w-9 h-9 -ml-2 flex items-center justify-center transition-transform duration-100 active:scale-90">
          <ChevronLeft size={20} color={T.ash} />
        </button>
        <h1 className="flex-1 text-center text-[16px] font-semibold truncate px-2" style={{ ...display, color: T.ash }}>{ev.title}</h1>
        <button onClick={onEdit} className="w-9 h-9 flex items-center justify-center transition-transform duration-100 active:scale-90">
          <Pencil size={16} color={T.ash} />
        </button>
      </div>

      <div className="px-6 pt-4">
        <div className="flex items-center gap-2 mb-1">
          {ev.canceled ? (
            <span className="text-[9px] font-semibold px-1.5 py-0.5" style={{ ...mono, color: T.alert, border: `1px solid ${T.alert}`, borderRadius: T.rPill }}>CANCELED</span>
          ) : ev.draft ? (
            <span className="text-[9px] font-semibold px-1.5 py-0.5" style={{ ...mono, color: T.ashFaint, border: `1px solid ${T.line}`, borderRadius: T.rPill }}>DRAFT</span>
          ) : (
            <span className="text-[9px] font-semibold px-1.5 py-0.5" style={{ ...mono, color: T.good, border: `1px solid ${T.good}`, borderRadius: T.rPill }}>PUBLISHED</span>
          )}
        </div>
        <div className="text-[18px] font-semibold mb-1" style={{ ...display, color: T.ash }}>{ev.title}</div>
        <div className="text-[12px] mb-4" style={{ ...body, color: T.ashFaint }}>
          {ev.fieldName} · {ev.date || "No date set"}{ev.endDate ? ` – ${ev.endDate}` : ""}{ev.startTime ? ` · ${formatTimeStr(ev.startTime)}` : ""}{ev.endTime ? ` – ${formatTimeStr(ev.endTime)}` : ""}
        </div>
        {/* Organizer events have no field page to deep-link to. */}
        {!ev.isMajor && (
        <button
          onClick={() => window.open(`https://playerapp.airsoftatlas.app/?field=${ev.fieldId}`, "_blank", "noopener,noreferrer")}
          className="w-full mb-4 py-2.5 flex items-center justify-center gap-2 transition-transform duration-100 active:scale-[0.98]"
          style={{ background: T.panel, borderRadius: T.rCard, boxShadow: T.shadowMd }}
          title="There's no direct link to this one event yet, so it opens the field page"
        >
          <ExternalLink size={14} color={T.ash} />
          <span className="text-[13px] font-semibold" style={{ ...body, color: T.ash }}>View as Player</span>
        </button>
        )}

        <div className="grid grid-cols-3 gap-2 mb-5">
          <button
            onClick={() => onOpenRoster(ev)}
            className="p-3 text-center transition-transform duration-100 active:scale-95"
            style={{ background: T.panel, borderRadius: T.rCard, boxShadow: T.shadowMd }}
          >
            <div className="text-[18px] font-semibold" style={{ ...display, color: T.good }}>{ev.bookedCount || 0}{typeof ev.maxCapacity === "number" ? `/${ev.maxCapacity}` : ""}</div>
            <div className="text-[10px]" style={{ ...body, color: T.ashFaint }}>Reserved</div>
          </button>
          <div className="p-3 text-center" style={{ background: T.panel, borderRadius: T.rCard, boxShadow: T.shadowMd }}>
            <div className="text-[18px] font-semibold" style={{ ...display, color: T.ash }}>{ev.interestCount || 0}</div>
            <div className="text-[10px]" style={{ ...body, color: T.ashFaint }}>Interested</div>
          </div>
          <div className="p-3 text-center" style={{ background: T.panel, borderRadius: T.rCard, boxShadow: T.shadowMd }}>
            <div className="text-[18px] font-semibold" style={{ ...display, color: T.ash }}>{displayPrice(ev.price)}</div>
            <div className="text-[10px]" style={{ ...body, color: T.ashFaint }}>Price</div>
          </div>
        </div>

        {ev.priceOptions?.choices?.length > 0 && (
          // The "see Price Options above" note in the Projected Revenue
          // card below refers to this block — it used to point at nothing,
          // since the overview screen never actually rendered the choices
          // an owner set up in the event editor.
          <div className="p-3 mb-5" style={{ background: T.panel, borderRadius: T.rCard, boxShadow: T.shadowMd }}>
            <div className="text-[10px] font-semibold uppercase mb-2" style={{ ...mono, color: T.ashFaint, letterSpacing: "0.04em" }}>
              Price Options{ev.priceOptions.required ? "" : " (Optional)"}
            </div>
            <div className="text-[12px] font-medium mb-2" style={{ ...body, color: T.ash }}>{ev.priceOptions.label}</div>
            <div className="flex flex-col gap-1.5">
              {ev.priceOptions.choices.map((c) => (
                <div key={c.id} className="flex items-center justify-between text-[12px]" style={{ ...body, color: T.ashDim }}>
                  <span>{c.label}</span>
                  <span style={{ ...mono, color: T.accent, fontWeight: 600 }}>{c.priceCents ? `+$${(c.priceCents / 100).toFixed(2)}` : "Free"}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {(() => {
          // Price Options means the real per-player cost isn't one flat
          // number — a price × capacity estimate would just be wrong (or
          // misleadingly low, if it silently ignored the choices
          // entirely), so this shows a plain "varies" note instead of a
          // number, rather than guessing at a range.
          if (ev.priceOptions?.choices?.length) {
            return (
              <div className="p-3 mb-5" style={{ background: T.panel, borderRadius: T.rCard, boxShadow: T.shadowMd }}>
                <div className="text-[12px]" style={{ ...body, color: T.ashDim }}>
                  Projected Revenue: <span style={{ fontWeight: 600, color: T.accent }}>Price varies</span> — depends on what players choose, see Price Options above
                </div>
              </div>
            );
          }
          const p = parsePrice(ev.price);
          const cap = typeof ev.maxCapacity === "number" ? ev.maxCapacity : parseInt(ev.maxCapacity, 10);
          if (!p || !cap) return null;
          return (
            <div className="p-3 mb-5" style={{ background: T.panel, borderRadius: T.rCard, boxShadow: T.shadowMd }}>
              <div className="text-[12px]" style={{ ...body, color: T.ashDim }}>
                Projected Revenue (Gross): <span style={{ fontWeight: 600, color: T.accent }}>${(p * cap).toFixed(2)}</span> — entry cost × capacity, not a real payment yet
              </div>
            </div>
          );
        })()}

        <button onClick={() => onOpenRoster(ev)} className="w-full mb-5 py-3 flex items-center justify-center gap-2 transition-transform duration-100 active:scale-[0.98]" style={{ background: T.panel, borderRadius: T.rCard, boxShadow: T.shadowMd }}>
          <Users size={15} color={T.ashDim} />
          <span className="text-[13px] font-medium" style={{ ...body, color: T.ash }}>View Full Roster</span>
        </button>

        {ev.description && (
          <>
            <Eyebrow>Description</Eyebrow>
            <p className="text-[13px] leading-relaxed mb-5" style={{ ...body, color: T.ashDim }}>{ev.description}</p>
          </>
        )}

        {ev.checkInPatch?.imageUrl && (
          <>
            <Eyebrow>Check-In Reward Patch</Eyebrow>
            <div className="p-3 flex items-center gap-3 mb-5" style={{ background: T.panel, borderRadius: T.rCard, boxShadow: T.shadowMd }}>
              <img src={ev.checkInPatch.imageUrl} alt="" className="w-10 h-10" style={{ objectFit: "contain" }} />
              <div className="text-[13px] font-medium" style={{ ...body, color: T.ash }}>{ev.checkInPatch.name}</div>
            </div>
          </>
        )}

        {ev.waiver && (
          <>
            <Eyebrow>Waiver</Eyebrow>
            <div className="p-3 flex items-center gap-2 mb-5" style={{ background: T.panel, borderRadius: T.rCard, boxShadow: T.shadowMd }}>
              <FileSignature size={15} color={T.ashDim} />
              <span className="text-[13px]" style={{ ...body, color: T.ashDim }}>Required for this event</span>
            </div>
          </>
        )}

        {isPast && aarStats && (
          <>
            <Eyebrow>After-Action Report</Eyebrow>
            <div className="grid grid-cols-3 gap-2 mb-3">
              <div className="p-3 text-center" style={{ background: T.panel, borderRadius: T.rCard, boxShadow: T.shadowMd }}>
                <div className="text-[18px] font-semibold" style={{ ...display, color: T.ash }}>{aarStats.reservedCount}</div>
                <div className="text-[10px]" style={{ ...body, color: T.ashFaint }}>Reserved</div>
              </div>
              <div className="p-3 text-center" style={{ background: T.panel, borderRadius: T.rCard, boxShadow: T.shadowMd }}>
                <div className="text-[18px] font-semibold" style={{ ...display, color: T.good }}>{aarStats.checkedInCount}</div>
                <div className="text-[10px]" style={{ ...body, color: T.ashFaint }}>Checked In</div>
              </div>
              <div className="p-3 text-center" style={{ background: T.panel, borderRadius: T.rCard, boxShadow: T.shadowMd }}>
                <div className="text-[18px] font-semibold" style={{ ...display, color: T.alert }}>{aarStats.noShowCount}</div>
                <div className="text-[10px]" style={{ ...body, color: T.ashFaint }}>No-Shows</div>
              </div>
            </div>

            <div className="p-4 mb-3" style={{ borderRadius: T.rHero, background: "linear-gradient(135deg,#0e2c47,#1c3f63)", boxShadow: "0 10px 24px -8px rgba(0,44,72,0.35)" }}>
              <div className="text-[10px] font-semibold uppercase mb-1" style={{ ...mono, color: "rgba(255,255,255,0.6)", letterSpacing: "0.04em" }}>Real Revenue (Your Share)</div>
              <div className="text-[26px] font-semibold" style={{ ...display, color: "#fff" }}>${(aarStats.revenueCents / 100).toFixed(2)}</div>
              {aarStats.checkInRate != null && (
                <div className="text-[9px] mt-0.5" style={{ ...body, color: "rgba(255,255,255,0.55)" }}>{aarStats.checkInRate.toFixed(0)}% check-in rate</div>
              )}
            </div>

            <div className="grid grid-cols-2 gap-2 mb-3">
              <div className="p-3" style={{ background: T.panel, borderRadius: T.rCard, boxShadow: T.shadowMd }}>
                <div className="text-[16px] font-semibold" style={{ ...display, color: T.ash }}>{aarStats.waiverCount}</div>
                <div className="text-[10px]" style={{ ...body, color: T.ashFaint }}>Waiver Signatures</div>
              </div>
              <div className="p-3" style={{ background: T.panel, borderRadius: T.rCard, boxShadow: T.shadowMd }}>
                <div className="text-[16px] font-semibold" style={{ ...display, color: T.ash }}>
                  {aarStats.interestedCount}{aarStats.interestedCount > 0 ? ` → ${aarStats.reservedCount}` : ""}
                </div>
                <div className="text-[10px]" style={{ ...body, color: T.ashFaint }}>Interested → Reserved</div>
              </div>
            </div>

            {aarStats.classifiedCount > 0 && (
              <div className="p-3 mb-3" style={{ background: T.panel, borderRadius: T.rCard, boxShadow: T.shadowMd }}>
                <div className="text-[10px] font-semibold uppercase mb-2" style={{ ...mono, color: T.ashFaint, letterSpacing: "0.04em" }}>New vs. Returning</div>
                <div className="flex items-center justify-between text-[12px]" style={{ ...body, color: T.ashDim }}>
                  <span>{aarStats.newCount} new</span>
                  <span>{aarStats.returningCount} returning</span>
                </div>
              </div>
            )}

            {Object.keys(aarStats.choiceCounts).length > 0 && (
              <div className="p-3 mb-3" style={{ background: T.panel, borderRadius: T.rCard, boxShadow: T.shadowMd }}>
                <div className="text-[10px] font-semibold uppercase mb-2" style={{ ...mono, color: T.ashFaint, letterSpacing: "0.04em" }}>Price Options Chosen</div>
                <div className="flex flex-col gap-1.5">
                  {Object.entries(aarStats.choiceCounts).map(([label, count]) => (
                    <div key={label} className="flex items-center justify-between text-[12px]" style={{ ...body, color: T.ashDim }}>
                      <span>{label}</span>
                      <span style={{ ...mono, color: T.accent, fontWeight: 600 }}>{count}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {Object.keys(aarStats.rentalCounts).length > 0 && (
              <div className="p-3 mb-5" style={{ background: T.panel, borderRadius: T.rCard, boxShadow: T.shadowMd }}>
                <div className="text-[10px] font-semibold uppercase mb-2" style={{ ...mono, color: T.ashFaint, letterSpacing: "0.04em" }}>Rentals Selected</div>
                <div className="flex flex-col gap-1.5">
                  {Object.entries(aarStats.rentalCounts).map(([name, count]) => (
                    <div key={name} className="flex items-center justify-between text-[12px]" style={{ ...body, color: T.ashDim }}>
                      <span>{name}</span>
                      <span style={{ ...mono, color: T.accent, fontWeight: 600 }}>{count}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// Two modes. Field mode (venueMode false) is the original editor, tied to a
// claimed field. Venue mode is the organizer form: no field, the venue is
// typed in (or copied from an Atlas field) and lives on the event itself.
// The mode is fixed for an event's life — isMajor/fieldId/hostOwnerId are
// immutable in the Firestore rules.
function EventEditScreen({ field, venueMode = false, ownerUid, payoutsEnabled, existing, onBack, createEvent, createMajorEvent, updateEvent, newEventId, allFields }) {
  const [eventId] = useState(existing?.id || newEventId());
  const [title, setTitle] = useState(existing?.title || "");
  // Venue-mode fields (unused in field mode). lat/lng are only ever set by
  // copying an Atlas field's details; typing the address by hand has no
  // coordinates (geocoding is deferred), so those events just don't take part
  // in distance sorting.
  const [venueName, setVenueName] = useState(existing?.venueName || "");
  const [address, setAddress] = useState(existing?.address || "");
  const [venueCity, setVenueCity] = useState(existing?.venueCity || "");
  const [venueState, setVenueState] = useState(existing?.venueState || "");
  const [minimumAge, setMinimumAge] = useState(existing?.minimumAge != null ? String(existing.minimumAge) : "");
  const [venueLat, setVenueLat] = useState(typeof existing?.lat === "number" ? existing.lat : null);
  const [venueLng, setVenueLng] = useState(typeof existing?.lng === "number" ? existing.lng : null);
  const [prefillFrom, setPrefillFrom] = useState(null);
  const [venueSearch, setVenueSearch] = useState("");
  const venueSearchQ = venueSearch.trim().toLowerCase();
  const prefillMatches = venueMode && venueSearchQ.length >= 2
    ? (allFields || []).filter((f) => (f.name || "").toLowerCase().includes(venueSearchQ) || (f.city || "").toLowerCase().includes(venueSearchQ)).slice(0, 6)
    : [];
  // A hand-edited address no longer matches the copied pin, so drop it.
  const clearCoords = () => { setVenueLat(null); setVenueLng(null); };
  const applyPrefill = (f) => {
    const v = venueFromField(f);
    setVenueName(v.venueName);
    setAddress(v.address);
    setVenueCity(v.venueCity);
    setVenueState(v.venueState);
    setVenueLat(v.lat);
    setVenueLng(v.lng);
    setPrefillFrom(f.name || "that field");
    setVenueSearch("");
  };
  const bannerStoragePath = () => (venueMode ? `hostEventBanners/${ownerUid}/${eventId}/banner.jpg` : `eventBanners/${field.id}/${eventId}/banner.jpg`);
  const patchStoragePath = () => (venueMode ? `hostEventPatches/${ownerUid}/${eventId}/patch.jpg` : `eventPatches/${field.id}/${eventId}/patch.jpg`);
  const [date, setDate] = useState(existing?.date || "");
  const [endDate, setEndDate] = useState(existing?.endDate || "");
  const [startTime, setStartTime] = useState(existing?.startTime || "");
  const [endTime, setEndTime] = useState(existing?.endTime || "");
  const [briefingTime, setBriefingTime] = useState(existing?.briefingTime || "");
  const [price, setPrice] = useState(existing?.price || "");
  // Checkbox is the deliberate signal for "this event doesn't charge" —
  // reusing the existing blank-price-means-free behavior underneath
  // rather than adding a new persisted field. Defaults checked when
  // editing an event whose saved price is already blank-ish (covers
  // events saved with the old "$" default too), unchecked for a brand
  // new event so an owner has to consciously opt into free rather than
  // silently getting it by leaving a field untouched.
  const [isFreeEvent, setIsFreeEvent] = useState(!!existing && isBlankPriceText(existing?.price));
  const priceBeforeFreeToggle = React.useRef(price);
  const toggleFreeEvent = (checked) => {
    setIsFreeEvent(checked);
    if (checked) {
      priceBeforeFreeToggle.current = price;
      setPrice("");
    } else {
      setPrice(priceBeforeFreeToggle.current || "");
    }
  };
  const [maxCapacity, setMaxCapacity] = useState(existing?.maxCapacity || "");
  const [type, setType] = useState(existing?.type || "OUTDOOR");
  const [description, setDescription] = useState(existing?.description || "");
  const [imageUrl, setImageUrl] = useState(existing?.imageUrl || null);
  const [waiverText, setWaiverText] = useState(existing?.waiver?.text || "");
  const [patchName, setPatchName] = useState(existing?.checkInPatch?.name || "");
  const [patchImageUrl, setPatchImageUrl] = useState(existing?.checkInPatch?.imageUrl || null);
  const [patchUploading, setPatchUploading] = useState(false);
  // Price Options — for events where the real cost depends on what the
  // player picks (weapon class, BB weight, etc.) rather than one flat
  // number. Empty by default; a normal flat-price or free event never
  // touches this. Each choice's price is kept as a raw string here, same
  // as Rental Gear's price field below, and only converted to cents at
  // save time.
  const [priceOptionsLabel, setPriceOptionsLabel] = useState(existing?.priceOptions?.label || "");
  const [priceOptionsRequired, setPriceOptionsRequired] = useState(existing?.priceOptions?.required ?? true);
  const [priceOptionsChoices, setPriceOptionsChoices] = useState(
    (existing?.priceOptions?.choices || []).map((c) => ({ id: c.id, label: c.label, price: c.priceCents != null ? String(c.priceCents / 100) : "" }))
  );
  const patchInputRef = React.useRef(null);
  const [bannerUploading, setBannerUploading] = useState(false);
  const bannerInputRef = React.useRef(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // Only meaningful when editing an existing event — a brand new one has
  // nothing to compare against, so it's always considered "changed."
  const [snapshot, setSnapshot] = useState({
    title: existing?.title || "", date: existing?.date || "", endDate: existing?.endDate || "",
    startTime: existing?.startTime || "", endTime: existing?.endTime || "", briefingTime: existing?.briefingTime || "", price: existing?.price || "", maxCapacity: existing?.maxCapacity || "",
    type: existing?.type || "OUTDOOR", description: existing?.description || "", imageUrl: existing?.imageUrl || null,
  });
  const hasChanges = !existing ||
    title !== snapshot.title || date !== snapshot.date || endDate !== snapshot.endDate ||
    startTime !== snapshot.startTime || endTime !== snapshot.endTime || briefingTime !== snapshot.briefingTime || price !== snapshot.price || maxCapacity !== snapshot.maxCapacity ||
    type !== snapshot.type || description !== snapshot.description || imageUrl !== snapshot.imageUrl ||
    (venueMode && (
      venueName !== (existing?.venueName || "") || address !== (existing?.address || "") ||
      venueCity !== (existing?.venueCity || "") || venueState !== (existing?.venueState || "") ||
      minimumAge !== (existing?.minimumAge != null ? String(existing.minimumAge) : "") ||
      venueLat !== (typeof existing?.lat === "number" ? existing.lat : null) ||
      venueLng !== (typeof existing?.lng === "number" ? existing.lng : null)
    )) ||
    waiverText !== (existing?.waiver?.text || "") ||
    patchName !== (existing?.checkInPatch?.name || "") || patchImageUrl !== (existing?.checkInPatch?.imageUrl || null) ||
    priceOptionsLabel !== (existing?.priceOptions?.label || "") ||
    priceOptionsRequired !== (existing?.priceOptions?.required ?? true) ||
    JSON.stringify(priceOptionsChoices) !== JSON.stringify((existing?.priceOptions?.choices || []).map((c) => ({ id: c.id, label: c.label, price: c.priceCents != null ? String(c.priceCents / 100) : "" })));
  // Publishing a currently-unchanged draft is still a real, meaningful
  // action (draft → published) even with zero content edits — Save as
  // Draft has no such case, since re-saving identical draft content really
  // is a no-op.
  const canPublish = hasChanges || existing?.draft;

  const addPriceChoice = () => setPriceOptionsChoices([...priceOptionsChoices, { id: `choice_${Date.now()}_${priceOptionsChoices.length}`, label: "", price: "" }]);
  const updatePriceChoice = (i, key, value) => {
    const next = [...priceOptionsChoices];
    next[i] = { ...next[i], [key]: value };
    setPriceOptionsChoices(next);
  };
  const removePriceChoice = (i) => setPriceOptionsChoices(priceOptionsChoices.filter((_, idx) => idx !== i));

  // A lightweight, one-time heads-up (not a live listener — this is just
  // advisory, not something that needs to stay in sync while editing) —
  // shows other fields' events landing on the same date, so an owner isn't
  // accidentally scheduling head-to-head against a nearby field's big game.
  // Geofenced to 100 miles so this stays useful once there are thousands of
  // events nationally — a field in another state landing on the same date
  // is irrelevant noise, not a real conflict. Purely informational; never
  // blocks saving or publishing. If either field is missing coordinates,
  // that candidate is left out rather than guessed at — an unverifiable
  // distance is exactly the kind of noise this is meant to avoid.
  const [competingEvents, setCompetingEvents] = useState([]);
  useEffect(() => {
    // Venue mode has no field to measure from, so no nearby-conflict check.
    if (!date || venueMode) {
      setCompetingEvents([]);
      return;
    }
    let cancelled = false;
    getDocs(query(collection(db, "events"), where("date", "==", date)))
      .then((snap) => {
        if (cancelled) return;
        const others = snap.docs
          .map((d) => ({ id: d.id, ...d.data() }))
          .filter((e) => e.fieldId !== field.id && !e.draft && !e.deleted && e.id !== eventId)
          .filter((e) => {
            if (typeof field.lat !== "number" || typeof field.lng !== "number") return false;
            const otherField = allFields.find((f) => f.id === e.fieldId);
            if (!otherField || typeof otherField.lat !== "number" || typeof otherField.lng !== "number") return false;
            return distanceMiles(field.lat, field.lng, otherField.lat, otherField.lng) <= 100;
          });
        setCompetingEvents(others);
      })
      .catch((err) => console.error("competing events check failed:", err));
    return () => { cancelled = true; };
  }, [date]);

  const projectedRevenue = (() => {
    const p = parsePrice(price);
    const cap = parseInt(maxCapacity, 10);
    if (!p || !cap) return null;
    return (p * cap).toFixed(2);
  })();

  const handleBannerPick = () => bannerInputRef.current?.click();
  const handleBannerSelected = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setBannerUploading(true);
    setError("");
    try {
      const resized = await resizeImageFile(file, 1200, 0.85);
      const storageRef = ref(storage, bannerStoragePath());
      await uploadBytes(storageRef, resized, { contentType: "image/jpeg" });
      const url = await getDownloadURL(storageRef);
      setImageUrl(url);
    } catch (err) {
      setError("Couldn't upload that image — try again.");
    } finally {
      setBannerUploading(false);
    }
  };

  const handlePatchPick = () => patchInputRef.current?.click();
  const handlePatchSelected = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setPatchUploading(true);
    setError("");
    try {
      const resized = await resizeImageFile(file, 500, 0.9);
      const storageRef = ref(storage, patchStoragePath());
      await uploadBytes(storageRef, resized, { contentType: "image/jpeg" });
      const url = await getDownloadURL(storageRef);
      setPatchImageUrl(url);
    } catch (err) {
      setError("Couldn't upload that patch — try again.");
    } finally {
      setPatchUploading(false);
    }
  };
  // Clears both the name and image so Save writes checkInPatch: null (see
  // the ternary in handleSave's payload below) — an owner previously had
  // no way to remove a patch once attached, short of the non-obvious
  // "clear just the name text" side effect. Also tries to delete the
  // uploaded file itself, same "best-effort, not worth failing the UI
  // over" pattern as FieldManageScreen's removeGalleryPhoto — the upload
  // path is deterministic (one file per event), so a re-attach later just
  // overwrites it either way even if this delete silently no-ops.
  const removePatch = async () => {
    setPatchName("");
    setPatchImageUrl(null);
    try {
      await deleteObject(ref(storage, patchStoragePath()));
    } catch {
      // file may already be gone — not worth failing the UI over
    }
  };

  const buildData = (draft) => ({
    title: title.trim(),
    // Organizer events carry their venue on the event itself. fieldName
    // mirrors venueName: the player app and many display sites already render
    // ev.fieldName as "where", so a Major shows up right everywhere without
    // touching them. Kept in sync on every save. lat/lng only when copied
    // from an Atlas field.
    ...(venueMode ? {
      fieldName: venueName.trim(),
      venueName: venueName.trim(),
      address: address.trim(),
      venueCity: venueCity.trim(),
      venueState,
      minimumAge: minimumAge.trim() && Number.isFinite(parseInt(minimumAge, 10)) ? parseInt(minimumAge, 10) : null,
      lat: venueLat,
      lng: venueLng,
    } : {}),
    date,
    endDate: endDate || null,
    startTime: startTime || null,
    endTime: endTime || null,
    briefingTime: briefingTime || null,
    price: isFreeEvent ? null : (price || null),
    // One optional group of player-picked, differently-priced choices
    // (weapon class, BB weight, etc.) — null for a normal flat-price or
    // free event. Only choices with both a label and a price are kept;
    // a half-filled row just gets dropped rather than saved broken.
    priceOptions: venueMode ? null : (() => {
      const validChoices = priceOptionsChoices
        .filter((c) => c.label.trim() && c.price.trim())
        .map((c) => ({ id: c.id, label: c.label.trim(), priceCents: Math.round((parsePrice(c.price) || 0) * 100) }));
      return validChoices.length > 0
        ? { label: priceOptionsLabel.trim() || "Choose an option", required: priceOptionsRequired, choices: validChoices }
        : null;
    })(),
    maxCapacity: maxCapacity ? parseInt(maxCapacity, 10) : null,
    type,
    description: description.trim(),
    imageUrl: imageUrl || null,
    // Same shape the player app's waiver-signing flow already reads
    // (version/text/isDemo). isDemo: false since this is a real waiver an
    // owner actually wrote, not the app's placeholder showcase text.
    waiver: waiverText.trim() ? { text: waiverText.trim(), version: localDateStr(), isDemo: false } : null,
    // Attach a patch here and it's granted automatically the moment a
    // player is scanned in.
    checkInPatch: patchName.trim() && patchImageUrl ? { name: patchName.trim(), imageUrl: patchImageUrl } : null,
    // Explicitly cleared, not just omitted — removed as an owner-configurable
    // reward entirely; the equivalent (5+ registered teammates checking into
    // the same event) is now the app-wide "Squad Catalyst" achievement
    // instead, not something tied to any one field. Setting this to null on
    // save actively clears any leftover value from earlier testing, rather
    // than just leaving stale data sitting on the document untouched.
    teamCheckInReward: null,
    // Deliberately no sourceUrl here — an event created directly in the app
    // has no "original listing" elsewhere to link to. The player app only
    // shows that link when sourceUrl is genuinely set (scraped events).
    // Defaulting this to the field's homepage would be misleading — it'd
    // look like a specific event page exists when it doesn't.
    draft,
  });

  const handleSave = async (draft) => {
    if (!title.trim() || (!draft && !date)) {
      setError(draft ? "Give it a title before saving." : "Title and date are required to publish.");
      return;
    }
    if (venueMode && !draft && (!venueName.trim() || !address.trim() || !venueCity.trim() || !venueState)) {
      setError("Venue name, address, city and state are required to publish — players need to know where to go.");
      return;
    }
    // A paid event can't take payment until payouts are set up (the booking
    // function refuses to start checkout for a host with no connected
    // account), so publishing one would put a broken Reserve button in front
    // of players. Drafts are still fine. (Field events keep their existing
    // behavior; this gate is organizer events only.)
    if (venueMode && !draft && !isFreeEvent && parsePrice(price) !== null && !payoutsEnabled) {
      setError("Set up payouts first (Dashboard → Set up payouts) — players can't pay for a paid event until that's done. You can still save it as a draft.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const data = buildData(draft);
      if (existing) {
        await updateEvent(eventId, data);
      } else if (venueMode) {
        await createMajorEvent(ownerUid, data, eventId);
      } else {
        await createEvent(field.id, field.name, data, eventId);
      }
      onBack();
    } catch (err) {
      setError("Couldn't save — try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="h-full overflow-y-auto overflow-x-hidden pb-10" style={flatBg}>
      <div className="px-6 pt-2 pb-4 flex items-center" style={{ borderBottom: `1px solid ${T.line}` }}>
        <button onClick={onBack} className="w-9 h-9 -ml-2 flex items-center justify-center transition-transform duration-100 active:scale-90">
          <ChevronLeft size={20} color={T.ash} />
        </button>
        <h1 className="flex-1 text-center text-[18px] font-semibold mr-9" style={{ ...display, color: T.ash }}>{existing ? "Edit Event" : "Create New Event"}</h1>
      </div>

      <div className="px-6 pt-4" style={{ maxWidth: "100%" }}>
        {!venueMode && (
        <button
          onClick={() => window.open(`https://playerapp.airsoftatlas.app/?field=${field.id}`, "_blank", "noopener,noreferrer")}
          className="w-full mb-4 py-2.5 flex items-center justify-center gap-2 transition-transform duration-100 active:scale-[0.98]"
          style={{ background: T.panel, borderRadius: T.rCard, boxShadow: T.shadowMd }}
          title="Opens the field's page — there's no direct link to one specific event yet"
        >
          <ExternalLink size={14} color={T.ash} />
          <span className="text-[13px] font-semibold" style={{ ...body, color: T.ash }}>View as Player</span>
        </button>
        )}

        <Eyebrow>Event Banner</Eyebrow>
        <input ref={bannerInputRef} type="file" accept="image/*" onChange={handleBannerSelected} className="hidden" />
        <button
          onClick={handleBannerPick}
          disabled={bannerUploading}
          className="w-full h-32 mb-4 flex flex-col items-center justify-center gap-1 overflow-hidden transition-transform duration-100 active:scale-[0.98]"
          style={{ background: T.panelAlt, border: `1px dashed ${T.line}`, borderRadius: 6 }}
        >
          {imageUrl ? (
            <img src={imageUrl} alt="" className="w-full h-full" style={{ objectFit: "cover" }} />
          ) : (
            <>
              <ImageIcon size={20} color={T.ashDim} />
              <span className="text-[12px] font-medium" style={{ ...body, color: T.accent }}>{bannerUploading ? "Uploading…" : "Upload event poster or photo"}</span>
              <span className="text-[10px]" style={{ ...body, color: T.ashFaint }}>Recommended: 16:9, high resolution</span>
            </>
          )}
        </button>

        <Eyebrow>Event Details</Eyebrow>
        <TextField label="Event Name" value={title} onChange={setTitle} placeholder="e.g. Saturday Woods CQB Classic" />
        <div className="flex flex-col gap-2 mb-3">
          <TextField label="Date" value={date} onChange={setDate} type="date" />
          <div className="min-w-0">
            <TextField label="End Date (optional)" value={endDate} onChange={setEndDate} type="date" />
            <p className="text-[10px] -mt-2" style={{ ...body, color: T.ashFaint }}>Leave blank for a single-day event.</p>
          </div>
        </div>

        {competingEvents.length > 0 && (
          <div className="mb-3 p-3" style={{ background: "rgba(21,84,184,0.08)", border: `1px solid ${T.accent}`, borderRadius: 6 }}>
            <div className="text-[12px] font-semibold mb-1" style={{ ...display, color: T.ash }}>
              {competingEvents.length === 1 ? "A nearby field has an event this same day" : `${competingEvents.length} nearby events land on this same day`}
            </div>
            {competingEvents.map((ev) => (
              <div key={ev.id} className="text-[11px]" style={{ ...body, color: T.ashDim }}>{ev.title} — {ev.fieldName}</div>
            ))}
            <p className="text-[10px] mt-1" style={{ ...body, color: T.ashFaint }}>Within 100 miles — players can only be at one event at a time. Just a heads-up, not a blocker.</p>
          </div>
        )}

        {/* min-w-0 on both flex children is load-bearing: a flex item's
            default min-width is "auto", which for a native time/date
            control resolves to its own intrinsic rendered width (iOS's
            time widget needs room for hour:minute + AM/PM). Without
            min-w-0, neither box will actually shrink to its 50% share —
            they hold their intrinsic width instead, eating the gap and
            touching (or overlapping) each other. */}
        <div className="flex gap-2">
          <div className="flex-1 min-w-0">
            <TextField label="Start Time" value={startTime} onChange={setStartTime} type="time" />
          </div>
          <div className="flex-1 min-w-0">
            <TextField label="End Time (optional)" value={endTime} onChange={setEndTime} type="time" />
          </div>
        </div>

        <div className="mb-3">
          <label className="text-[10px] font-semibold uppercase block mb-1" style={{ ...mono, color: T.ashFaint, letterSpacing: "0.04em" }}>Safety Briefing Time (optional)</label>
          <input
            type="time"
            value={briefingTime}
            onChange={(e) => setBriefingTime(e.target.value)}
            className="w-full px-2 py-2.5 text-[13px] bg-transparent outline-none"
            style={{
              ...body,
              background: T.panelAlt,
              border: `1px solid ${T.line}`,
              borderRadius: 4,
              color: T.ash,
              colorScheme: "light",
              // Same fix as TextField's date/time handling — this
              // input was built separately and never got it: iOS Safari
              // lays out a native time control's segments using its own
              // intrinsic sizing that can beat a plain width:100%, so
              // appearance:none is needed to make it respect the box.
              // That same native appearance is also what enforces a
              // touch-friendly minimum height, so an explicit height
              // compensates for losing it (a plain <input> centers its
              // text within a set height on its own).
              boxSizing: "border-box",
              minWidth: 0,
              maxWidth: "100%",
              display: "block",
              WebkitAppearance: "none",
              appearance: "none",
              height: "48px",
            }}
          />
          <p className="text-[10px] mt-1" style={{ ...body, color: T.ashFaint }}>
            A real time, separate from the text above — powers the "Early Bird" patch (checking in 30+ minutes early). Leave blank if not applicable.
          </p>
        </div>

        <div className="mb-3">
          <label className="text-[10px] font-semibold uppercase block mb-1" style={{ ...mono, color: T.ashFaint, letterSpacing: "0.04em" }}>Game Type</label>
          <div className="flex gap-2 flex-wrap">
            {GAME_TYPES.map((t) => (
              <button
                key={t.key}
                onClick={() => setType(t.key)}
                className="px-3 py-1.5 text-[12px] font-medium transition-transform duration-100 active:scale-95"
                style={{ ...body, border: `1px solid ${type === t.key ? T.accent : T.line}`, background: type === t.key ? T.accent : "transparent", color: type === t.key ? "#fff" : T.ashDim, borderRadius: T.rPill }}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>

        {venueMode && (
          <>
            <Eyebrow>Venue</Eyebrow>
            <p className="text-[11px] mb-2 -mt-1" style={{ ...body, color: T.ashFaint }}>
              Where the event is happening. Players see this on the event page and use it to get directions.
            </p>
            <div className="mb-3">
              <label className="text-[10px] font-semibold uppercase block mb-1" style={{ ...mono, color: T.ashFaint, letterSpacing: "0.04em" }}>Copy from an Atlas field (optional)</label>
              <input
                value={venueSearch}
                onChange={(e) => setVenueSearch(e.target.value)}
                placeholder="Search by field name or city"
                className="w-full px-3 py-2.5 text-[14px] bg-transparent outline-none"
                style={{ ...body, background: T.panelAlt, border: `1px solid ${T.line}`, borderRadius: T.rTight, color: T.ash, boxSizing: "border-box" }}
              />
              {prefillMatches.length > 0 && (
                <div className="mt-1 flex flex-col" style={{ background: T.panel, borderRadius: T.rTight, boxShadow: T.shadowMd }}>
                  {prefillMatches.map((f) => (
                    <button key={f.id} onClick={() => applyPrefill(f)} className="px-3 py-2 text-left" style={{ borderBottom: `1px solid ${T.line}` }}>
                      <div className="text-[13px] font-semibold" style={{ ...display, color: T.ash }}>{f.name}</div>
                      <div className="text-[11px]" style={{ ...body, color: T.ashFaint }}>{f.city}</div>
                    </button>
                  ))}
                </div>
              )}
              {prefillFrom && (
                <p className="text-[10px] mt-1" style={{ ...body, color: T.ashFaint }}>
                  Copied from {prefillFrom} — check it's right. This is just a copy of the field's public details; it doesn't link your event to that field or mean its owner has agreed to host it.
                </p>
              )}
            </div>
            <TextField label="Venue Name" value={venueName} onChange={setVenueName} placeholder="e.g. Camp Ripley Training Site" />
            <TextField label="Street Address" value={address} onChange={(v) => { setAddress(v); clearCoords(); }} placeholder="123 County Rd 4" />
            <div className="flex gap-2">
              <div className="flex-1 min-w-0">
                <TextField label="City" value={venueCity} onChange={(v) => { setVenueCity(v); clearCoords(); }} placeholder="Little Falls" />
              </div>
              <div className="flex-1 min-w-0 mb-3">
                <label className="text-[10px] font-semibold uppercase block mb-1" style={{ ...mono, color: T.ashFaint, letterSpacing: "0.04em" }}>State</label>
                <select
                  value={venueState}
                  onChange={(e) => { setVenueState(e.target.value); clearCoords(); }}
                  className="w-full px-2 py-2.5 text-[14px] outline-none"
                  style={{ ...body, background: T.panelAlt, border: `1px solid ${T.line}`, borderRadius: T.rTight, color: venueState ? T.ash : T.ashFaint, height: 48, boxSizing: "border-box" }}
                >
                  <option value="">Select…</option>
                  {Object.entries(US_STATES).map(([code, name]) => (
                    <option key={code} value={code}>{name}</option>
                  ))}
                </select>
              </div>
            </div>
            <TextField label="Minimum Age (optional)" value={minimumAge} onChange={setMinimumAge} placeholder="e.g. 18" type="number" />
          </>
        )}

        <Eyebrow>Pricing & Capacity</Eyebrow>
        <label className="flex items-center gap-2 mb-3 text-[12px]" style={{ ...body, color: T.ashDim }}>
          <input type="checkbox" checked={isFreeEvent} onChange={(e) => toggleFreeEvent(e.target.checked)} />
          This is a free event (no entry fee)
        </label>
        <div className="flex gap-2">
          <div className="flex-1">
            {isFreeEvent ? (
              <div className="mb-3">
                <label className="text-[10px] font-semibold uppercase block mb-1" style={{ ...mono, color: T.ashFaint, letterSpacing: "0.04em" }}>Entry Cost</label>
                <div className="w-full px-3 py-2.5 text-[14px]" style={{ ...body, background: T.panelAlt, border: `1px solid ${T.line}`, borderRadius: T.rTight, color: T.ashFaint, opacity: 0.7 }}>
                  Free — players won't be charged an entry fee
                </div>
              </div>
            ) : (
              <TextField label="Entry Cost" value={price} onChange={setPrice} placeholder="25 (or clear and type 'Price varies')" />
            )}
          </div>
          <div className="flex-1">
            <TextField label="Max Capacity" value={maxCapacity} onChange={setMaxCapacity} placeholder="120" type="number" />
          </div>
        </div>
        {!isFreeEvent && projectedRevenue && (
          <p className="text-[12px] mb-3 -mt-1" style={{ ...body, color: T.ashDim }}>
            Projected Revenue (Gross): <span style={{ fontWeight: 600, color: T.accent }}>${projectedRevenue}</span> — entry cost × capacity, not a real payment yet
          </p>
        )}
        {!venueMode && !isFreeEvent && price.trim() && parsePrice(price) === null && priceOptionsChoices.filter((c) => c.label.trim() && c.price.trim()).length === 0 && (
          <p className="text-[11px] mb-3 -mt-1" style={{ ...body, color: T.alert }}>
            Heads up — since "{price.trim()}" isn't a plain number, this event won't collect any payment in the app right now. Use Price Options below if the real cost varies by player, or enter a plain number (e.g. 25) for a flat price.
          </p>
        )}

        {venueMode && !isFreeEvent && price.trim() && parsePrice(price) === null && (
          <p className="text-[11px] mb-3 -mt-1" style={{ ...body, color: T.alert }}>
            Heads up — since "{price.trim()}" isn't a plain number, this event won't collect any payment in the app. Enter a plain number (e.g. 25) for a flat ticket price.
          </p>
        )}
        {venueMode && !isFreeEvent && (
          <p className="text-[11px] mb-3 -mt-1" style={{ ...body, color: T.ashFaint }}>
            One flat price per ticket. Atlas's fee (3.5% + $1.30 per ticket, no cap) comes out of your payout — players pay exactly the price you set.
            {!payoutsEnabled && <span style={{ color: T.alert }}> Payouts aren't set up yet, so you can save a paid event as a draft but not publish it.</span>}
          </p>
        )}

        {!venueMode && (
        <>
        <div className="mb-2 flex items-center justify-between">
          <label className="text-[10px] font-semibold uppercase" style={{ ...mono, color: T.ashFaint, letterSpacing: "0.04em" }}>Price Options</label>
          <button onClick={addPriceChoice} className="text-[12px] font-semibold transition-transform duration-100 active:scale-95" style={{ ...body, color: T.accent }}>+ Add Choice</button>
        </div>
        <p className="text-[11px] mb-2 -mt-1" style={{ ...body, color: T.ashFaint }}>
          For events where the real price depends on what a player picks — weapon class, BB weight, that kind of thing. Leave empty for a normal flat-price (or free) event.
        </p>
        {priceOptionsChoices.length > 0 && (
          <>
            <TextField label="What are players choosing?" value={priceOptionsLabel} onChange={setPriceOptionsLabel} placeholder="e.g. Choose your class, BB Weight" />
            <label className="flex items-center gap-2 mb-3 text-[12px]" style={{ ...body, color: T.ashDim }}>
              <input type="checkbox" checked={priceOptionsRequired} onChange={(e) => setPriceOptionsRequired(e.target.checked)} />
              Players must choose one to book (uncheck for an optional add-on instead)
            </label>
          </>
        )}
        {priceOptionsChoices.map((c, i) => (
          <div key={c.id} className="mb-3 p-3" style={{ background: T.panel, borderRadius: T.rCard, boxShadow: T.shadowMd }}>
            <div className="flex gap-2">
              <input value={c.label} onChange={(e) => updatePriceChoice(i, "label", e.target.value)} placeholder="e.g. AR, LMG, .25g BBs"
                className="flex-1 px-2.5 py-2 text-[13px] bg-transparent outline-none" style={{ ...body, background: T.panelAlt, border: `1px solid ${T.line}`, borderRadius: 4, color: T.ash }} />
              <input value={c.price} onChange={(e) => updatePriceChoice(i, "price", e.target.value)} placeholder="$20"
                className="w-20 px-2.5 py-2 text-[13px] bg-transparent outline-none" style={{ ...body, background: T.panelAlt, border: `1px solid ${T.line}`, borderRadius: 4, color: T.ash }} />
              <button onClick={() => removePriceChoice(i)} className="w-9 h-9 flex-shrink-0 flex items-center justify-center transition-transform duration-100 active:scale-90" style={{ background: T.panelAlt, borderRadius: T.rPill }}>
                <Trash2 size={14} color={T.alert} />
              </button>
            </div>
          </div>
        ))}
        </>
        )}

        <TextField label="Event Description" value={description} onChange={setDescription} rows={4} placeholder="Describe your event schedule, briefing instructions, game modes, and parking locations." />

        <Eyebrow>Waiver</Eyebrow>
        <p className="text-[11px] mb-2 -mt-1" style={{ ...body, color: T.ashFaint }}>
          Players will read and e-sign this text before the event. Leave blank if this event doesn't need one.
          Document upload isn't available yet — a real, complete document would need to be embedded and made
          signable in-app to actually work, which is a bigger piece; entering the text directly here works today.
        </p>
        {!venueMode && field.savedWaivers?.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-2">
            {field.savedWaivers.map((w, i) => (
              <button
                key={i}
                onClick={() => setWaiverText(w.text)}
                className="px-3 py-1.5 text-[12px] font-medium transition-transform duration-100 active:scale-95"
                style={{ ...body, border: `1px solid ${T.line}`, color: T.ashDim, borderRadius: 999 }}
              >
                {w.name}
              </button>
            ))}
          </div>
        )}
        <TextField value={waiverText} onChange={setWaiverText} rows={6} placeholder={venueMode ? "Paste or write your event's waiver text here…" : "Paste or write your field's waiver text here…"} />

        <Eyebrow>Check-In Reward Patch</Eyebrow>
        <p className="text-[11px] mb-2 -mt-1" style={{ ...body, color: T.ashFaint }}>
          Attach a patch here and it's granted automatically the moment a player is scanned in. This is for
          attending THIS specific event — not a multi-event achievement like "attend 3 events at a field," which
          lives in the separate achievement system instead. Name it like an achievement: "[patch name]: [what earns
          it]" — e.g. "Across the Atlas: Awarded for attending the Across the Atlas {new Date().getFullYear()} event at Atlas Airsoft Arena."
        </p>
        <input ref={patchInputRef} type="file" accept="image/*" onChange={handlePatchSelected} className="hidden" />
        <div className="flex items-center gap-3 mb-4">
          <button
            onClick={handlePatchPick}
            disabled={patchUploading}
            className="w-16 h-16 flex-shrink-0 flex items-center justify-center transition-transform duration-100 active:scale-95"
            style={{ background: T.panelAlt, border: `1px dashed ${T.line}`, borderRadius: 4 }}
          >
            {patchImageUrl ? (
              <img src={patchImageUrl} alt="" className="w-full h-full" style={{ objectFit: "contain" }} />
            ) : (
              <ImageIcon size={16} color={patchUploading ? T.ashFaint : T.ashDim} />
            )}
          </button>
          <input
            value={patchName}
            onChange={(e) => setPatchName(e.target.value)}
            placeholder={`e.g. Across the Atlas: Awarded for attending the Across the Atlas ${new Date().getFullYear()} event at Atlas Airsoft Arena`}
            className="flex-1 px-3 py-2.5 text-[14px] bg-transparent outline-none"
            style={{ ...body, background: T.panelAlt, border: `1px solid ${T.line}`, borderRadius: 4, color: T.ash }}
          />
          {patchImageUrl && (
            <button
              onClick={removePatch}
              className="w-9 h-9 flex-shrink-0 flex items-center justify-center transition-transform duration-100 active:scale-90"
              style={{ background: T.panelAlt, borderRadius: T.rPill }}
            >
              <Trash2 size={14} color={T.alert} />
            </button>
          )}
        </div>

        {error && <p className="text-[12px] mb-2" style={{ ...body, color: T.alert }}>{error}</p>}
        <div className="mb-2">
          <PrimaryButton onClick={() => handleSave(false)} disabled={saving || !canPublish}>{saving ? "Saving…" : "Publish Event"}</PrimaryButton>
        </div>
        <div className="mb-6">
          <button
            onClick={() => handleSave(true)}
            disabled={saving || !hasChanges}
            className="w-full py-3 font-semibold text-[14px] transition-transform duration-100 active:scale-[0.98]"
            style={{ ...body, border: `1px solid ${T.line}`, color: T.ashDim, borderRadius: T.rPill, opacity: saving || !hasChanges ? 0.5 : 1 }}
          >
            Save as Draft
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---------- Roster (real waiver signatures) ---------- */
/* ---------- Check-in scanner ---------- */
const LOADING_KEYFRAMES = `
@keyframes atlasLoaderLegs {
  0% { stroke-dashoffset: 66; animation-timing-function: cubic-bezier(.55,0,1,1); }
  36% { stroke-dashoffset: 0; }
  74% { stroke-dashoffset: 0; animation-timing-function: cubic-bezier(.55,0,1,1); }
  90%, 100% { stroke-dashoffset: -66; }
}
@keyframes atlasLoaderSwoop {
  0%, 36% { stroke-dashoffset: 34; animation-timing-function: cubic-bezier(0,0,.45,1); }
  55%, 90% { stroke-dashoffset: 0; animation-timing-function: cubic-bezier(0,0,.45,1); }
  100% { stroke-dashoffset: -34; }
}
.atlasLoaderLegs { stroke-dasharray: 66 200; animation: atlasLoaderLegs 2.2s infinite; }
.atlasLoaderSwoop { stroke-dasharray: 34 200; animation: atlasLoaderSwoop 2.2s infinite; }
@media (prefers-reduced-motion: reduce) {
  .atlasLoaderLegs, .atlasLoaderSwoop { animation: none; stroke-dashoffset: 0; }
}
`;

// Loader mark: the Atlas "A" traced in stroke order -- up the right leg,
// over the apex, down the left leg, then out along the swoop -- then erased
// in the same direction, over a faint ghost of the full mark. A_MARK_D is
// the white-fill letterform traced from public/logo.jpg (1024px space).
// The swoop crosses the right leg, so it gets its own mask: the legs pass
// blacks out a band around the swoop, and the swoop pass is confined to
// that band, so the swoop never lights up early during the legs pass.
// pathLength 66/34 are proportional to the real lengths of the two strokes
// so the draw speed stays even across the hand-off.
const A_MARK_D = "M783.3 782.6C813.5 782.4 813.9 782.4 814.0 778.1C814.0 776.0 801.6 750.0 796.9 742.3C794.7 738.7 791.1 731.9 789.0 727.3C786.8 722.6 782.8 714.9 780.1 710.1C777.3 705.4 773.5 697.2 771.5 692.0C769.5 686.8 765.9 679.3 763.5 675.4C761.1 671.5 757.8 665.4 756.2 661.9C754.6 658.4 751.0 651.7 748.2 647.1C745.4 642.6 741.5 634.6 739.5 629.6C737.5 624.5 732.8 615.0 729.0 608.5C725.2 601.9 720.2 592.3 717.9 587.0C704.2 555.7 697.8 550.5 683.4 559.2C679.6 561.5 670.9 565.9 664.0 569.0C657.1 572.1 647.7 577.0 643.1 579.9C638.5 582.8 629.7 587.6 623.6 590.5C607.3 598.3 606.1 600.6 611.8 613.6C613.4 617.4 616.3 624.1 618.1 628.5C619.9 632.9 623.5 640.2 626.2 644.6C628.8 649.1 634.2 659.7 638.1 668.1C642.1 676.6 647.5 687.3 650.1 692.0C652.7 696.7 656.5 705.0 658.4 710.5C660.4 715.9 663.5 722.9 665.3 726.0C667.2 729.0 672.4 739.1 676.9 748.5C694.7 785.4 693.0 784.4 736.5 783.3C746.4 783.0 767.5 782.7 783.3 782.6Z M227.5 781.8C279.4 781.7 278.9 781.7 283.6 775.4C285.2 773.2 290.4 767.5 295.2 762.7C300.1 757.9 305.8 751.5 308.0 748.5C310.2 745.6 314.6 741.1 317.9 738.6C321.2 736.1 327.2 730.1 331.2 725.3C335.2 720.5 342.0 713.9 346.3 710.6C350.5 707.2 358.8 700.7 364.6 696.0C379.0 684.5 390.0 676.7 405.4 666.8C412.6 662.3 421.6 656.0 425.5 652.9C429.4 649.8 437.3 644.9 443.2 642.0C449.0 639.2 456.8 634.4 460.4 631.4C464.0 628.4 470.9 624.0 475.7 621.7C483.7 617.8 498.8 609.6 524.0 595.5C529.2 592.5 544.1 585.1 557.0 579.0C569.9 572.8 581.0 567.4 581.7 566.8C583.7 565.2 607.1 553.9 613.4 551.6C616.8 550.3 626.9 545.6 636.0 541.0C645.0 536.5 656.3 531.3 661.0 529.5C665.7 527.7 674.5 523.8 680.5 520.7C686.6 517.7 694.6 514.1 698.5 512.7C702.4 511.3 707.7 509.2 710.3 508.1C713.0 507.0 718.7 505.1 723.2 504.0C736.5 500.7 752.6 491.4 750.6 488.2C748.8 485.3 723.4 489.0 712.5 493.8C708.6 495.5 702.6 497.4 699.0 498.0C695.4 498.6 688.4 500.5 683.5 502.1C678.5 503.7 669.7 505.9 664.0 507.0C658.3 508.2 649.7 510.7 644.8 512.6C640.0 514.5 635.5 516.0 634.9 516.0C633.1 516.0 579.0 534.1 546.5 545.5C537.7 548.6 526.0 552.6 520.5 554.4C505.3 559.4 489.2 566.6 451.0 585.3C436.4 592.4 421.7 599.2 418.3 600.5C414.9 601.7 407.8 605.5 402.6 608.9C373.7 627.6 357.1 620.5 373.6 596.5C379.1 588.4 382.3 582.1 386.6 570.7C388.5 565.7 397.0 547.6 405.4 530.5C413.9 513.5 424.4 491.2 428.9 481.0C433.4 470.8 439.6 457.4 442.7 451.2C445.7 444.9 451.1 433.9 454.6 426.7C458.1 419.4 462.8 410.4 465.0 406.5C467.2 402.6 470.2 396.4 471.6 392.5C473.1 388.6 476.5 380.5 479.1 374.3C481.8 368.2 484.0 362.5 484.0 361.8C484.0 347.2 499.4 350.6 504.6 366.3C506.0 370.8 509.2 377.7 511.6 381.6C514.0 385.4 516.3 389.8 516.9 391.2C519.5 398.2 544.6 452.4 555.5 474.5C566.5 497.0 569.0 498.4 587.0 491.9C601.5 486.7 617.0 482.1 628.5 479.4C656.8 472.8 660.8 467.8 651.4 451.5C642.4 435.9 640.1 431.4 637.5 424.6C636.1 420.7 631.8 412.4 628.0 406.1C624.2 399.7 618.1 388.0 614.4 380.0C610.7 372.0 605.8 362.6 603.5 359.0C598.2 350.8 597.2 349.0 595.0 342.6C594.1 339.8 591.5 334.6 589.3 331.0C587.1 327.4 583.6 320.4 581.4 315.5C579.2 310.5 575.5 303.7 573.1 300.2C570.8 296.7 566.7 289.1 564.1 283.2C561.5 277.3 556.9 268.8 553.9 264.3C550.9 259.8 547.3 253.9 545.8 251.1C539.8 240.1 528.3 238.2 472.5 239.5C432.7 240.4 431.2 240.8 425.3 252.5C423.9 255.2 419.8 262.4 416.2 268.3C412.7 274.2 407.6 284.1 405.0 290.3C402.4 296.5 396.3 308.9 391.5 318.0C386.8 327.1 381.5 337.6 379.9 341.5C378.2 345.4 375.2 351.4 373.1 355.0C371.0 358.6 366.9 366.7 364.1 373.0C361.3 379.3 355.6 390.7 351.5 398.2C347.4 405.8 344.0 412.2 344.0 412.5C344.0 414.3 334.2 435.3 330.4 441.5C327.9 445.7 323.6 454.1 321.0 460.1C318.3 466.1 314.3 474.5 311.9 478.7C306.7 488.2 305.2 491.3 295.6 511.0C291.4 519.5 286.1 530.1 283.7 534.5C281.4 538.9 277.5 547.0 275.1 552.5C272.6 558.0 268.0 567.1 264.8 572.7C261.6 578.2 257.8 586.2 256.4 590.3C255.0 594.4 252.3 600.4 250.3 603.7C248.3 606.9 244.5 614.4 241.9 620.4C239.2 626.4 235.3 634.0 233.1 637.4C230.9 640.7 227.7 647.1 226.0 651.5C221.9 662.1 209.0 688.7 190.6 724.5C185.5 734.4 177.9 749.2 173.7 757.4C163.1 777.9 164.3 784.7 178.0 782.4C179.4 782.1 201.7 781.9 227.5 781.8Z";
const A_LEGS_D = "M753 800 L514 250 L468 250 L216 800";
const A_SWOOP_D = "M240 800 C370 640 560 540 806 474";

function AtlasALoader({ color, size = 56 }) {
  const m = { maskUnits: "userSpaceOnUse", x: 0, y: 0, width: 1024, height: 1024 };
  return (
    <svg width={size} height={size} viewBox="140 215 700 600" role="img" aria-label="Loading">
      <defs>
        <mask id="atlasLoaderLegsMask" {...m}>
          <path d={A_LEGS_D} pathLength="66" className="atlasLoaderLegs" fill="none" stroke="#fff" strokeWidth="178" strokeLinecap="round" strokeLinejoin="round" />
          <path d={A_SWOOP_D} fill="none" stroke="#000" strokeWidth="86" strokeLinecap="round" />
        </mask>
        <mask id="atlasLoaderSwoopZone" {...m}>
          <path d={A_SWOOP_D} fill="none" stroke="#fff" strokeWidth="96" strokeLinecap="round" />
        </mask>
        <mask id="atlasLoaderSwoopMask" {...m}>
          <path d={A_SWOOP_D} pathLength="34" className="atlasLoaderSwoop" fill="none" stroke="#fff" strokeWidth="120" strokeLinecap="round" />
        </mask>
      </defs>
      <path d={A_MARK_D} fill={color} fillRule="evenodd" opacity="0.14" />
      <g fill={color}>
        <g mask="url(#atlasLoaderLegsMask)"><path d={A_MARK_D} fillRule="evenodd" /></g>
        <g mask="url(#atlasLoaderSwoopZone)"><g mask="url(#atlasLoaderSwoopMask)"><path d={A_MARK_D} fillRule="evenodd" /></g></g>
      </g>
    </svg>
  );
}

// Ported from atlas-players-app's identical LoadingScreen after a real
// 2026-09-20 report there: a player got stuck on this screen forever with
// no crash, no error, just an auth/profile subscription that apparently
// never fired on their device. Whatever the underlying cause, a silent
// infinite wait with no recovery path is the real bug — this adds the
// same timeout so a stuck owner isn't left staring at three dots with no
// way out, regardless of what caused the hang.
function LoadingScreen() {
  const [showRetry, setShowRetry] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setShowRetry(true), 8000);
    return () => clearTimeout(t);
  }, []);

  return (
    <div className="h-screen flex flex-col items-center justify-center gap-5 px-8" style={flatBg}>
      <style>{FONTS}</style>
      <style>{LOADING_KEYFRAMES}</style>
      <AtlasALoader color={T.accent} />
      {showRetry && (
        <div className="flex flex-col items-center gap-3 text-center">
          <p className="text-[13px] leading-relaxed" style={{ ...body, color: T.ashDim }}>
            This is taking longer than expected.
          </p>
          <button
            onClick={() => window.location.reload()}
            className="px-5 py-2.5 text-[13px] font-semibold transition-transform duration-100 active:scale-95"
            style={{ ...display, background: T.panel, color: T.ash, borderRadius: T.rPill, border: `1px solid ${T.line}` }}
          >
            Retry
          </button>
        </div>
      )}
    </div>
  );
}

// `kind` picks the agreement set: "field" (field owners, the original text)
// or "organizer" (event organizers, DRAFT). App() passes a `key` per kind so
// the tab/checkbox state resets if both are ever needed back to back.
function LegalAgreementScreen({ onAccept, kind = "field" }) {
  const [tab, setTab] = useState("terms");
  const [checked, setChecked] = useState(false);
  const [saving, setSaving] = useState(false);

  const isOrganizerKind = kind === "organizer";
  const TABS = [
    { key: "terms", label: "Terms of Use", text: isOrganizerKind ? ORGANIZER_TERMS_OF_USE : TERMS_OF_USE },
    { key: "privacy", label: "Privacy Policy", text: isOrganizerKind ? ORGANIZER_PRIVACY_POLICY : PRIVACY_POLICY },
    { key: "eula", label: "EULA", text: isOrganizerKind ? ORGANIZER_EULA : EULA },
  ];
  const activeText = TABS.find((t) => t.key === tab).text;

  const handleAccept = async () => {
    setSaving(true);
    await onAccept();
    setSaving(false);
  };

  return (
    <div className="h-screen flex flex-col" style={flatBg}>
      <style>{FONTS}</style>
      <div className="px-6 pt-8 pb-3">
        <h1 className="text-[18px] font-semibold mb-1" style={{ ...display, color: T.ash }}>Before you continue</h1>
        <p className="text-[12px]" style={{ ...body, color: T.ashDim }}>Please read and agree to the following.</p>
      </div>
      <div className="px-6 flex gap-1" style={{ borderBottom: `1px solid ${T.line}` }}>
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className="px-2 py-2 text-[12px] font-semibold transition-transform duration-100 active:scale-95"
            style={{ ...body, color: tab === t.key ? T.ash : T.ashFaint, borderBottom: tab === t.key ? `2px solid ${T.ash}` : "2px solid transparent" }}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4">
        <p className="text-[12px] whitespace-pre-wrap" style={{ ...body, color: T.ashDim, lineHeight: 1.6 }}>{activeText}</p>
      </div>
      <div className="px-6 pt-3 pb-6" style={{ borderTop: `1px solid ${T.line}`, background: T.void }}>
        <button onClick={() => setChecked(!checked)} className="w-full flex items-center gap-2 mb-3 text-left transition-transform duration-100 active:scale-[0.98]">
          <div className="w-5 h-5 flex-shrink-0 flex items-center justify-center" style={{ border: `1.5px solid ${checked ? T.ash : T.line}`, background: checked ? T.ash : "transparent", borderRadius: 4 }}>
            {checked && <Check size={13} color="#fff" strokeWidth={3} />}
          </div>
          <span className="text-[12px]" style={{ ...body, color: T.ashDim }}>I've read and agree to the Terms of Use, Privacy Policy, and EULA.</span>
        </button>
        <button
          onClick={handleAccept}
          disabled={!checked || saving}
          className="w-full py-3.5 font-semibold text-[14px] transition-transform duration-100 active:scale-[0.98]"
          style={{ ...display, background: T.ash, color: "#FFFFFF", borderRadius: T.rPill, boxShadow: T.shadowMd, opacity: !checked || saving ? 0.5 : 1 }}
        >
          {saving ? "Continuing…" : "Agree & Continue"}
        </button>
      </div>
    </div>
  );
}

// One-time "what do you do?" screen for accounts that haven't said yet (new
// signups, or an owner account with no field). Multi-select: a field owner
// who also runs events elsewhere picks both. Purely tailors the app — the
// server never reads this for permissions or fees — and it can be changed
// any time under Settings > Account Type.
function RoleSelectionScreen({ onSave, onLogout }) {
  const [fieldOwner, setFieldOwner] = useState(false);
  const [organizer, setOrganizer] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const options = [
    {
      key: "fieldOwner",
      on: fieldOwner,
      toggle: () => setFieldOwner(!fieldOwner),
      title: "I own or manage a field",
      body: "Claim your field, manage its page, and run events there.",
    },
    {
      key: "organizer",
      on: organizer,
      toggle: () => setOrganizer(!organizer),
      title: "I organize events",
      body: "Run events at fields or sites you don't own. You add the venue details on each event.",
    },
  ];

  const handleContinue = async () => {
    setSaving(true);
    setError("");
    try {
      await onSave({ fieldOwner, organizer });
    } catch (err) {
      console.error("setAccountRoles failed:", err);
      setError("Couldn't save that — try again.");
      setSaving(false);
    }
  };

  return (
    <div className="h-screen flex flex-col px-6 overflow-y-auto" style={flatBg}>
      <style>{FONTS}</style>
      <div className="pt-10 pb-4">
        <h1 className="text-[20px] font-semibold mb-1" style={{ ...display, color: T.ash }}>What brings you to Atlas?</h1>
        <p className="text-[13px]" style={{ ...body, color: T.ashDim }}>
          Pick everything that fits — we'll set the app up around it. You can change this later in Settings.
        </p>
      </div>
      <div className="flex flex-col gap-3 mb-4">
        {options.map((o) => (
          <button
            key={o.key}
            onClick={o.toggle}
            className="w-full p-4 flex items-start gap-3 text-left transition-transform duration-100 active:scale-[0.98]"
            style={{ background: T.panel, borderRadius: T.rCard, boxShadow: T.shadowMd, outline: o.on ? `2px solid ${T.accent}` : "2px solid transparent", outlineOffset: -2 }}
          >
            <div className="w-5 h-5 mt-0.5 flex-shrink-0 flex items-center justify-center" style={{ border: `1.5px solid ${o.on ? T.accent : T.line}`, background: o.on ? T.accent : "transparent", borderRadius: 4 }}>
              {o.on && <Check size={13} color="#fff" strokeWidth={3} />}
            </div>
            <div>
              <div className="text-[14px] font-semibold" style={{ ...display, color: T.ash }}>{o.title}</div>
              <div className="text-[12px]" style={{ ...body, color: T.ashDim }}>{o.body}</div>
            </div>
          </button>
        ))}
      </div>
      {error && <p className="text-[12px] mb-3" style={{ ...body, color: T.alert }}>{error}</p>}
      <PrimaryButton onClick={handleContinue} disabled={saving || (!fieldOwner && !organizer)}>{saving ? "Saving…" : "Continue"}</PrimaryButton>
      <button onClick={onLogout} className="text-center text-[12px] mt-4 pb-8" style={{ ...body, color: T.ashFaint }}>Sign out</button>
    </div>
  );
}

// Venue state picker for Atlas Major events. Stored as the 2-letter code
// (venueState); the player app maps it back to a full name for its state
// selector (eventStateName in atlas-players-app).
const US_STATES = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California",
  CO: "Colorado", CT: "Connecticut", DE: "Delaware", FL: "Florida", GA: "Georgia",
  HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa",
  KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland",
  MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri",
  MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey",
  NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota", OH: "Ohio",
  OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina",
  SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont",
  VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
};

// Copies an Atlas field's details into venue-form values. A field stores
// city as "City, ST" (or occasionally just a state name); older scraped
// addresses can already include city/state — that's fine, the player app
// avoids repeating them. Returns a SNAPSHOT: no link to the field is kept.
function venueFromField(f) {
  let city = "";
  let state = "";
  const raw = (f.city || "").trim();
  const m = raw.match(/^(.*?),\s*([A-Z]{2})\s*$/);
  if (m) {
    city = m[1].trim();
    state = US_STATES[m[2]] ? m[2] : "";
  } else {
    const code = Object.keys(US_STATES).find((k) => US_STATES[k] === raw);
    if (code) state = code;
    else city = raw;
  }
  return {
    venueName: f.name || "",
    address: f.address || "",
    venueCity: city,
    venueState: state,
    lat: typeof f.lat === "number" ? f.lat : null,
    lng: typeof f.lng === "number" ? f.lng : null,
  };
}

// Generated tones, not an audio file — no asset to bundle or host, and it
// works identically everywhere. A single clean tone for success, two quick
// low ones for a miss — standard "good/bad" sound-design convention.
function playFeedbackSound(success) {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const beep = (freq, startTime, duration) => {
      const oscillator = ctx.createOscillator();
      const gainNode = ctx.createGain();
      oscillator.connect(gainNode);
      gainNode.connect(ctx.destination);
      oscillator.type = "sine";
      oscillator.frequency.value = freq;
      gainNode.gain.setValueAtTime(0.001, startTime);
      gainNode.gain.exponentialRampToValueAtTime(0.3, startTime + 0.01);
      gainNode.gain.exponentialRampToValueAtTime(0.001, startTime + duration);
      oscillator.start(startTime);
      oscillator.stop(startTime + duration);
    };
    if (success) {
      beep(880, ctx.currentTime, 0.18);
    } else {
      beep(220, ctx.currentTime, 0.12);
      beep(220, ctx.currentTime + 0.16, 0.12);
    }
  } catch (err) {
    // Audio unavailable for some reason — visual feedback still carries
    // the message, so this never blocks the actual check-in.
  }
}

function CheckInScreen({ event, onBack }) {
  const containerRef = useRef(null);
  const scannerRef = useRef(null);
  const [status, setStatus] = useState(null); // { ok, message, lines? } — lines = the party's children, shown under the message
  const [flash, setFlash] = useState(null); // "good" | "alert" — brief full-screen color pulse over the still-live camera
  const busyRef = useRef(false); // guards against handling the same frame twice while a scan is being processed

  useEffect(() => {
    let cancelled = false;
    import("html5-qrcode").then(({ Html5Qrcode }) => {
      if (cancelled || !containerRef.current) return;
      const scanner = new Html5Qrcode(containerRef.current.id);
      scannerRef.current = scanner;
      scanner
        .start(
          { facingMode: "environment" },
          {
            fps: 10,
            // A function, not a fixed size — this is the library's own
            // recommended pattern specifically because a fixed pixel box
            // can get unevenly constrained on devices with a different
            // camera aspect ratio than expected (this is exactly what was
            // happening on tablets — a real, different-shaped viewfinder
            // than a phone's, not something a bigger fixed number fixes).
            // Computing it from the real viewfinder size at runtime
            // guarantees a true square everywhere, every device shape.
            qrbox: (viewfinderWidth, viewfinderHeight) => {
              const minEdge = Math.min(viewfinderWidth, viewfinderHeight);
              const size = Math.floor(minEdge * 0.7);
              return { width: size, height: size };
            },
          },
          async (decodedText) => {
            if (busyRef.current) return;
            busyRef.current = true;
            const result = await checkInFromScan(decodedText, event.id);
            const partyLines = (result.attendees || []).map((a) => ({
              name: `${a.fullName} · ${a.callsign}`,
              sub: a.waiverSignatureId ? `Guardian has signed waiver${a.guardianName ? ` — ${a.guardianName}` : ""}${a.guardianPhone ? ` · ${a.guardianPhone}` : ""}` : `Minor — guardian ${a.guardianName || ""}${a.guardianPhone ? ` · ${a.guardianPhone}` : ""}`,
            }));
            if (result.ok) {
              setStatus({ ok: true, message: partyLines.length ? `${result.callsign} + ${partyLines.length} ${partyLines.length === 1 ? "child" : "children"} checked in` : `${result.callsign} checked in`, lines: partyLines });
            } else if (result.reason === "already-checked-in") {
              setStatus({ ok: false, message: `${result.callsign} already checked in`, lines: partyLines });
            } else if (result.reason === "wrong-event") {
              setStatus({ ok: false, message: "That code is for a different event" });
            } else if (result.reason === "not-booked") {
              setStatus({ ok: false, message: "No booking found for that code" });
            } else {
              setStatus({ ok: false, message: "Not a valid Atlas check-in code" });
            }
            // The real, reliable confirmation — works identically on every
            // device. navigator.vibrate() is a free bonus layered on top:
            // it does nothing at all on iPhone (iOS Safari has never
            // implemented the Vibration API), but it's a real, distinct
            // buzz on Android. Sound and the flash below are what this
            // actually depends on.
            playFeedbackSound(result.ok);
            setFlash(result.ok ? "good" : "alert");
            if (navigator.vibrate) navigator.vibrate(result.ok ? 120 : [80, 80, 80]);
            // Camera stays open the whole time — no need to close it just to
            // show this. Brief pause before the next scan can register, so
            // the same code held in frame doesn't fire repeatedly.
            setTimeout(() => {
              setStatus(null);
              setFlash(null);
              busyRef.current = false;
            }, partyLines.length ? 5000 : 2200); // a party gets longer on screen so the gate can read each child's line
          },
          () => {} // fires continuously while no code is in frame — nothing to do here
        )
        .catch((err) => {
          console.error("scanner start failed:", err);
          setStatus({ ok: false, message: "Couldn't access the camera — check permissions and try again." });
        });
    });
    return () => {
      cancelled = true;
      if (scannerRef.current) {
        scannerRef.current.stop().catch(() => {}).finally(() => scannerRef.current?.clear());
      }
    };
  }, [event.id]);

  return (
    <div className="h-full flex flex-col relative" style={{ background: "#000" }}>
      {flash && (
        <div
          className="absolute inset-0 pointer-events-none"
          style={{ background: flash === "good" ? "rgba(15,122,82,0.35)" : "rgba(188,51,39,0.35)", zIndex: 50, transition: "opacity 0.5s ease-out" }}
        />
      )}
      <div className="px-6 pt-2 pb-4 flex items-center" style={{ background: T.panel, borderBottom: `1px solid ${T.line}` }}>
        <button onClick={onBack} className="w-9 h-9 -ml-2 flex items-center justify-center transition-transform duration-100 active:scale-90">
          <ChevronLeft size={20} color={T.ash} />
        </button>
        <h1 className="flex-1 text-center text-[16px] font-semibold mr-9" style={{ ...display, color: T.ash }}>{event.title}</h1>
      </div>

      <div id="atlas-qr-reader" ref={containerRef} className="flex-1 min-h-0" />

      <div className="px-6 py-4" style={{ background: T.panel, borderTop: `1px solid ${T.line}` }}>
        {status ? (
          <div className="py-3 text-center">
            <div className="font-semibold text-[14px]" style={{ ...display, color: status.ok ? T.good : T.alert }}>{status.message}</div>
            {status.lines?.map((l, i) => (
              <div key={i} className="mt-2">
                <div className="text-[13px] font-medium" style={{ ...body, color: T.ash }}>{l.name}</div>
                <div className="text-[11px]" style={{ ...body, color: T.ashFaint }}>{l.sub}</div>
              </div>
            ))}
          </div>
        ) : (
          <div className="py-3 text-center text-[13px]" style={{ ...body, color: T.ashFaint }}>
            Point the camera at a player's check-in QR code
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------- Roster ---------- */
function RosterScreen({ event, onBack, onOpenCheckIn, banned, bannedLoading, banPlayer, unbanPlayer, profile }) {
  const { signatures, signaturesLoading } = useEventWaivers(event.id, event.hostOwnerId);
  const { bookings, bookingsLoading } = useEventBookings(event.id);
  const attendeeDetails = useAttendeeDetails(event.id, bookings);
  const bannedUids = new Set(banned.map((b) => b.uid));
  const [showManualCheckIn, setShowManualCheckIn] = useState(false);
  const [rosterFilter, setRosterFilter] = useState("all"); // all | checkedIn | notYet
  const [rosterSearch, setRosterSearch] = useState("");
  const [confirmGrant, setConfirmGrant] = useState(null); // { uid, name, booking }
  const [grantBusy, setGrantBusy] = useState(false);
  const [grantError, setGrantError] = useState("");
  const [selectedSignature, setSelectedSignature] = useState(null);

  // Display-only preview — the real amount is computed server-side in
  // grantVoucherToPlayer (resolveVoucherAmountCents, functions/index.js)
  // using the exact same math, so this will always match what actually
  // gets issued. Prefers the booking's own stored entryPriceCents (every
  // booking made since that field shipped) over reconstructing it from
  // amountPaidCents, the same fallback order the server uses.
  const previewGrantAmountCents = confirmGrant
    ? (typeof confirmGrant.booking.entryPriceCents === "number"
        ? confirmGrant.booking.entryPriceCents * Math.max(1, confirmGrant.booking.attendeeCount || 1)
        : Math.max(0, confirmGrant.booking.amountPaidCents
            - (confirmGrant.booking.selectedRentals || []).reduce((s, r) => s + (typeof r.priceCents === "number" ? r.priceCents : 0), 0)
            - (profile?.feeModel !== "absorb" && !event.isMajor ? (confirmGrant.booking.bookingFeeCents || 0) : 0)))
    : 0;

  const handleConfirmGrant = async () => {
    if (!confirmGrant) return;
    setGrantBusy(true);
    setGrantError("");
    try {
      const grantVoucher = httpsCallable(functions, "grantVoucherToPlayer");
      await grantVoucher({ eventId: event.id, uid: confirmGrant.uid });
      setConfirmGrant(null);
    } catch (err) {
      console.error("grantVoucherToPlayer failed:", err);
      setGrantError("Couldn't issue that voucher — try again, or reach out on Discord if it keeps happening.");
    } finally {
      setGrantBusy(false);
    }
  };

  const renderPersonRow = (uid, name, dateValue, checkedIn, onViewWaiver) => {
    const isBanned = bannedUids.has(uid);
    // Cross-references by uid so the field owner sees a real, unambiguous
    // name to call out — callsigns alone aren't unique (multiple players
    // really could both be "Ghost"), and the real legal name already
    // exists here for anyone who signed a waiver, just not previously
    // connected to the callsign visually. Shows whichever of the two
    // wasn't already passed in as the primary name, so this works the
    // same way in both the Reserved Players section (callsign primary) and
    // the Waiver Signatures section (real name primary) without needing
    // two different versions of this function.
    const matchingSignature = signatures.find((s) => s.uid === uid);
    const matchingBooking = bookings.find((b) => b.uid === uid);
    const secondaryName = [matchingSignature?.signedName, matchingBooking?.callsign].find((n) => n && n !== name);
    return (
      <div key={uid} className="mb-2 p-3 flex items-center justify-between" style={{ background: T.panel, borderRadius: 6, border: `1px solid ${isBanned ? T.alert : T.line}` }}>
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <div className="text-[13px] font-medium" style={{ ...body, color: T.ash }}>{name}</div>
            {checkedIn && (
              <span className="text-[9px] font-semibold px-1.5 py-0.5 flex items-center gap-1" style={{ ...mono, color: T.good, border: `1px solid ${T.good}`, borderRadius: T.rPill }}>
                <Check size={9} /> CHECKED IN
              </span>
            )}
            {matchingBooking?.paid && (
              <span className="text-[9px] font-semibold px-1.5 py-0.5" style={{ ...mono, color: T.accent, border: `1px solid ${T.accent}`, borderRadius: T.rPill }}>
                PAID{typeof matchingBooking.amountPaidCents === "number" ? ` $${(matchingBooking.amountPaidCents / 100).toFixed(2)}` : ""}
              </span>
            )}
            {(matchingBooking?.attendeeCount || 1) > 1 && (
              <span className="text-[9px] font-semibold px-1.5 py-0.5" style={{ ...mono, color: T.ashDim, border: `1px solid ${T.line}`, borderRadius: T.rPill }}>
                PARTY OF {matchingBooking.attendeeCount}
              </span>
            )}
            {matchingBooking?.selectedChoiceLabel && (
              <span className="text-[9px] font-semibold px-1.5 py-0.5" style={{ ...mono, color: T.ashDim, border: `1px solid ${T.line}`, borderRadius: T.rPill }}>
                {matchingBooking.selectedChoiceLabel}
              </span>
            )}
            {matchingBooking?.selectedRentals?.length > 0 && (
              <span className="text-[9px] font-semibold px-1.5 py-0.5" style={{ ...mono, color: T.ashDim, border: `1px solid ${T.line}`, borderRadius: T.rPill }}>
                Rented: {matchingBooking.selectedRentals.map((r) => r.name).join(", ")}
              </span>
            )}
          </div>
          {secondaryName && (
            <div className="text-[11px]" style={{ ...body, color: T.ashFaint }}>{secondaryName}</div>
          )}
          {(attendeeDetails[uid] || []).map((a) => (
            <div key={a.id} className="mt-1.5 pl-2" style={{ borderLeft: `2px solid ${T.line}` }}>
              <div className="text-[12px] font-medium" style={{ ...body, color: T.ash }}>{a.fullName} <span style={{ color: T.ashFaint, fontWeight: 400 }}>· {a.callsign}</span></div>
              <div className="text-[10px]" style={{ ...body, color: T.ashFaint }}>
                {a.waiverSignatureId ? "Guardian has signed waiver" : "Minor"}{a.guardianName ? ` — ${a.guardianName}` : ""}{a.guardianPhone ? ` · ${a.guardianPhone}` : ""}
              </div>
            </div>
          ))}
          {dateValue?.toDate && (
            <div className="text-[11px]" style={{ ...mono, color: T.ashFaint }}>{dateValue.toDate().toLocaleDateString()}</div>
          )}
        </div>
        <div className="flex flex-col items-end gap-1.5">
          {onViewWaiver && (
            <button
              onClick={onViewWaiver}
              className="px-2.5 py-1.5 text-[11px] font-semibold flex items-center gap-1 transition-transform duration-100 active:scale-95"
              style={{ ...body, border: `1px solid ${T.line}`, color: T.ashDim, borderRadius: T.rPill }}
            >
              <FileSignature size={12} /> View Waiver
            </button>
          )}
          {matchingBooking?.paid && typeof matchingBooking.amountPaidCents === "number" && matchingBooking.amountPaidCents > 0 && (
            <button
              onClick={() => setConfirmGrant({ uid, name, booking: matchingBooking })}
              className="px-2.5 py-1.5 text-[11px] font-semibold flex items-center gap-1 transition-transform duration-100 active:scale-95"
              style={{ ...body, border: `1px solid ${T.accent}`, color: T.accent, borderRadius: T.rPill }}
            >
              <Ticket size={12} /> Give Voucher
            </button>
          )}
          {/* Bans are per field — organizer events have no field to ban from. */}
          {event.fieldId && (isBanned ? (
            <button onClick={() => unbanPlayer(event.fieldId, uid)} className="px-2.5 py-1.5 text-[11px] font-semibold transition-transform duration-100 active:scale-95" style={{ ...body, border: `1px solid ${T.line}`, color: T.ashDim, borderRadius: T.rPill }}>
              Unban
            </button>
          ) : (
            <button onClick={() => banPlayer(event.fieldId, uid, name)} className="px-2.5 py-1.5 text-[11px] font-semibold transition-transform duration-100 active:scale-95" style={{ ...body, border: `1px solid ${T.alert}`, color: T.alert, borderRadius: T.rPill }}>
              Ban
            </button>
          ))}
        </div>
      </div>
    );
  };

  return (
    <div className="h-full overflow-y-auto pb-24" style={flatBg}>
      <div className="px-6 pt-2 pb-4 flex items-center" style={{ borderBottom: `1px solid ${T.line}` }}>
        <button onClick={onBack} className="w-9 h-9 -ml-2 flex items-center justify-center transition-transform duration-100 active:scale-90">
          <ChevronLeft size={20} color={T.ash} />
        </button>
        <h1 className="flex-1 text-center text-[18px] font-semibold mr-9" style={{ ...display, color: T.ash }}>Roster</h1>
      </div>

      <div className="px-6 pt-4">
        <div className="text-[13px] font-semibold mb-1" style={{ ...display, color: T.ash }}>{event.title}</div>

        <div className="mb-4 flex gap-2">
          <div className="flex-1"><PrimaryButton onClick={onOpenCheckIn}>Scan to Check In</PrimaryButton></div>
          <button
            onClick={() => setShowManualCheckIn(true)}
            className="px-4 py-3 text-[13px] font-semibold flex items-center gap-2 transition-transform duration-100 active:scale-95"
            style={{ ...display, border: `1px solid ${T.line}`, color: T.ash, borderRadius: T.rPill }}
          >
            <Search size={15} /> Manual
          </button>
        </div>

        {typeof event.maxCapacity === "number" ? (
          <div className="mb-2 p-3" style={{ background: T.panel, borderRadius: T.rCard, boxShadow: T.shadowMd }}>
            <div className="flex items-baseline justify-between mb-1.5">
              <span className="text-[20px] font-semibold" style={{ ...display, color: T.good }}>{event.bookedCount || 0}</span>
              <span className="text-[12px]" style={{ ...body, color: T.ashFaint }}>of {event.maxCapacity} reserved{(event.bookedCount || 0) > event.maxCapacity ? ` · ${event.bookedCount - event.maxCapacity} over` : ""}</span>
            </div>
            <div style={{ height: 6, background: T.panelAlt, borderRadius: 999, overflow: "hidden" }}>
              <div style={{ height: "100%", width: `${Math.min(100, ((event.bookedCount || 0) / event.maxCapacity) * 100)}%`, background: T.good }} />
            </div>
          </div>
        ) : (
          <p className="text-[12px] mb-2" style={{ ...body, color: T.ashFaint }}>No capacity limit set for this event.</p>
        )}
        {!bookingsLoading && bookings.length > 0 && (
          <p className="text-[12px] mb-4" style={{ ...body, color: T.ashDim }}>
            <span style={{ fontWeight: 600, color: T.good }}>{bookings.filter((b) => b.checkedIn).length}</span> of {bookings.length} checked in so far
          </p>
        )}

        <div className="flex items-center justify-between mb-1">
          <Eyebrow>Reserved Players ({bookings.length})</Eyebrow>
          {bookings.length > 0 && (
            <button
              onClick={() => downloadCsv(
                `${event.title} - Reserved Players.csv`,
                ["Callsign", "Selected Option", "Rentals", "Reserved At", "Checked In", "Checked In At", "Paid", "Amount Paid", "Refund Status", "Stripe Checkout Session ID"],
                bookings.map((b) => [
                  b.callsign,
                  b.selectedChoiceLabel || "",
                  (b.selectedRentals || []).map((r) => r.name).join(", "),
                  b.bookedAt?.toDate ? b.bookedAt.toDate().toLocaleString() : "",
                  b.checkedIn ? "Yes" : "No",
                  b.checkedInAt?.toDate ? b.checkedInAt.toDate().toLocaleString() : "",
                  b.paid ? "Yes" : "No",
                  typeof b.amountPaidCents === "number" ? `$${(b.amountPaidCents / 100).toFixed(2)}` : "",
                  b.refundStatus || "",
                  b.stripeCheckoutSessionId || "",
                ])
              )}
              className="text-[11px] font-semibold transition-transform duration-100 active:scale-95"
              style={{ ...body, color: T.accent }}
            >
              Export CSV
            </button>
          )}
        </div>
        {bookingsLoading ? (
          <div className="text-[13px] py-4 text-center" style={{ ...body, color: T.ashFaint }}>Loading…</div>
        ) : bookings.length === 0 ? (
          <p className="text-[12px] mb-5" style={{ ...body, color: T.ashFaint }}>No one's reserved yet.</p>
        ) : (
          <>
            {(() => {
              const checkedInCount = bookings.filter((b) => b.checkedIn).length;
              const notYetCount = bookings.length - checkedInCount;
              const FILTERS = [
                { key: "all", label: `All (${bookings.length})` },
                { key: "checkedIn", label: `Checked In (${checkedInCount})` },
                { key: "notYet", label: `Not Yet (${notYetCount})` },
              ];
              const filtered = bookings
                .filter((b) => rosterFilter === "all" || (rosterFilter === "checkedIn" ? b.checkedIn : !b.checkedIn))
                .filter((b) => {
                  const q = rosterSearch.trim().toLowerCase();
                  if (!q) return true;
                  const realName = signatures.find((s) => s.uid === b.uid)?.signedName || "";
                  return b.callsign.toLowerCase().includes(q) || realName.toLowerCase().includes(q);
                });

              return (
                <>
                  <div className="relative mb-2">
                    <Search size={14} color={T.ashFaint} className="absolute left-3 top-1/2" style={{ transform: "translateY(-50%)" }} />
                    <input
                      value={rosterSearch}
                      onChange={(e) => setRosterSearch(e.target.value)}
                      placeholder="Search reserved players"
                      className="w-full pl-8 pr-3 py-2 text-[12px] bg-transparent outline-none"
                      style={{ ...body, background: T.panelAlt, border: `1px solid ${T.line}`, borderRadius: 4, color: T.ash, boxSizing: "border-box" }}
                    />
                  </div>
                  <div className="flex gap-1 mb-3 overflow-x-auto">
                    {FILTERS.map((f) => (
                      <button
                        key={f.key}
                        onClick={() => setRosterFilter(f.key)}
                        className="px-2.5 py-1.5 text-[11px] font-semibold flex-shrink-0 transition-transform duration-100 active:scale-95"
                        style={{
                          ...body,
                          color: rosterFilter === f.key ? "#FFFFFF" : T.ashDim,
                          background: rosterFilter === f.key ? T.ash : T.panelAlt,
                          borderRadius: 999,
                        }}
                      >
                        {f.label}
                      </button>
                    ))}
                  </div>
                  {filtered.length === 0 ? (
                    <p className="text-[12px] mb-5" style={{ ...body, color: T.ashFaint }}>No one matches.</p>
                  ) : (
                    <div className="mb-5">
                      {filtered.map((b) => renderPersonRow(b.uid, signatures.find((s) => s.uid === b.uid)?.signedName || b.callsign, b.bookedAt, b.checkedIn))}
                    </div>
                  )}
                </>
              );
            })()}
          </>
        )}

        <div className="flex items-center justify-between mb-1">
          <Eyebrow>Waiver Signatures ({signatures.length})</Eyebrow>
          {signatures.length > 0 && (
            <button
              onClick={() => downloadCsv(
                `${event.title} - Waiver Signatures.csv`,
                ["Signed Name", "Signed At", "Waiver Version"],
                signatures.map((s) => [
                  s.signedName,
                  s.signedAt?.toDate ? s.signedAt.toDate().toLocaleString() : "",
                  s.waiverVersion || "",
                ])
              )}
              className="text-[11px] font-semibold transition-transform duration-100 active:scale-95"
              style={{ ...body, color: T.accent }}
            >
              Export CSV
            </button>
          )}
        </div>
        <p className="text-[11px] mb-3" style={{ ...body, color: T.ashFaint }}>
          Everyone who's signed the waiver, including anyone who signed without booking. Every booking above already
          required a signature, so this list will always be a superset of Reserved Players.
        </p>
        {signaturesLoading ? (
          <div className="text-[13px] py-4 text-center" style={{ ...body, color: T.ashFaint }}>Loading…</div>
        ) : signatures.length === 0 ? (
          <p className="text-[12px] mb-5" style={{ ...body, color: T.ashFaint }}>No signatures yet.</p>
        ) : (
          <div className="mb-5">
            {signatures.map((s, i) => renderPersonRow(s.uid || `sig-${i}`, s.signedName, s.signedAt, false, () => setSelectedSignature(s)))}
          </div>
        )}

        {banned.length > 0 && (
          <>
            <Eyebrow>Banned From This Field</Eyebrow>
            <p className="text-[11px] mb-3" style={{ ...body, color: T.ashFaint }}>
              There's no enforcement mechanism yet (that needs real check-in), but this list is saved and ready for when there is.
            </p>
            {banned.map((b) => (
              <div key={b.uid} className="mb-2 p-3 flex items-center justify-between" style={{ background: T.panel, borderRadius: T.rCard, boxShadow: T.shadowMd }}>
                <div className="text-[13px] font-medium" style={{ ...body, color: T.ash }}>{b.name}</div>
                <button
                  onClick={() => unbanPlayer(event.fieldId, b.uid)}
                  className="px-2.5 py-1.5 text-[11px] font-semibold transition-transform duration-100 active:scale-95"
                  style={{ ...body, border: `1px solid ${T.line}`, color: T.ashDim, borderRadius: T.rPill }}
                >
                  Unban
                </button>
              </div>
            ))}
          </>
        )}
      </div>

      {showManualCheckIn && (
        <ManualCheckInModal
          event={event}
          bookings={bookings}
          signatures={signatures}
          onClose={() => setShowManualCheckIn(false)}
        />
      )}

      {confirmGrant && (
        <div className="fixed inset-0 flex items-center justify-center px-6" style={{ background: "rgba(0,0,0,0.5)", zIndex: 2000 }} onClick={() => !grantBusy && (setConfirmGrant(null), setGrantError(""))}>
          <div onClick={(e) => e.stopPropagation()} className="w-full p-5" style={{ background: T.panel, borderRadius: 8, maxWidth: 340 }}>
            <div className="text-[15px] font-semibold mb-1" style={{ ...display, color: T.ash }}>Give {confirmGrant.name} a voucher?</div>
            <p className="text-[13px] mb-4" style={{ ...body, color: T.ashDim }}>
              This frees their spot on "{event.title}" and issues them a ${(previewGrantAmountCents / 100).toFixed(2)} voucher, good for a future event at this field — instead of a refund.
            </p>
            {grantError && (
              <p className="text-[12px] mb-3" style={{ ...body, color: T.alert }}>{grantError}</p>
            )}
            <div className="flex gap-2">
              <button onClick={() => { setConfirmGrant(null); setGrantError(""); }} disabled={grantBusy} className="flex-1 py-2.5 text-[13px] font-medium transition-transform duration-100 active:scale-95" style={{ ...body, border: `1px solid ${T.line}`, color: T.ashDim, borderRadius: T.rPill }}>
                Never mind
              </button>
              <button onClick={handleConfirmGrant} disabled={grantBusy} className="flex-1 py-2.5 text-[13px] font-semibold transition-transform duration-100 active:scale-95" style={{ ...display, background: T.accent, color: "#fff", borderRadius: T.rPill, boxShadow: T.shadowSm, opacity: grantBusy ? 0.6 : 1 }}>
                {grantBusy ? "Issuing…" : "Give Voucher"}
              </button>
            </div>
          </div>
        </div>
      )}

      {selectedSignature && (
        <SignedWaiverModal
          activity={selectedSignature}
          event={event}
          onClose={() => setSelectedSignature(null)}
        />
      )}
    </div>
  );
}

// The fallback for when QR scanning isn't an option — a dead phone, no
// signal to load the code, forgot it entirely. Deliberately searches only
// within this event's own real bookings, not all of Atlas — checking
// someone in only ever makes sense for someone who already has a real
// booking here, the same constraint the scanner itself enforces.
function SignedWaiverModal({ activity, event, onClose }) {
  const signedAtStr = activity.signedAt?.toDate ? activity.signedAt.toDate().toLocaleString() : "";
  const versionMismatch = event?.waiver?.version && activity.waiverVersion && event.waiver.version !== activity.waiverVersion;

  return (
    <div onClick={onClose} className="fixed inset-0 flex items-end" style={{ background: "rgba(0,0,0,0.5)", zIndex: 1600 }}>
      <div onClick={(e) => e.stopPropagation()} className="w-full max-h-[85vh] flex flex-col" style={{ background: T.void, borderTopLeftRadius: 16, borderTopRightRadius: 16 }}>
        <div className="px-5 pt-4 pb-3 flex items-center justify-between" style={{ borderBottom: `1px solid ${T.line}` }}>
          <div>
            <h2 className="text-[16px] font-semibold" style={{ ...display, color: T.ash }}>Signed Waiver</h2>
            <p className="text-[11px]" style={{ ...body, color: T.ashFaint }}>{event?.title || "an event"}</p>
          </div>
          <button onClick={onClose} className="w-8 h-8 flex items-center justify-center transition-transform duration-100 active:scale-90">
            <X size={18} color={T.ashDim} />
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4">
          <div className="mb-3 p-3" style={{ background: T.panel, borderRadius: T.rCard, boxShadow: T.shadowMd }}>
            <div className="text-[14px] font-medium" style={{ ...body, color: T.ash }}>{activity.signedName}</div>
            {signedAtStr && <div className="text-[11px] mt-0.5" style={{ ...mono, color: T.ashFaint }}>{signedAtStr}</div>}
          </div>

          <div className="mb-3 p-3" style={{ background: T.panel, borderRadius: T.rCard, boxShadow: T.shadowMd }}>
            <div className="flex items-center gap-1.5 mb-1">
              <Check size={13} color={T.good} />
              <div className="text-[12px] font-semibold" style={{ ...display, color: T.ash }}>Proof of signature</div>
            </div>
            <p className="text-[11px]" style={{ ...body, color: T.ashDim }}>
              {activity.signedName}'s name came straight from their own Atlas account, not typed in freehand, and this record only exists because they scrolled through the full waiver and checked an explicit agreement box before submitting. Once created, it can't be edited or deleted by anyone — not them, not Atlas. Under the U.S. ESIGN Act, that's a legally valid electronic signature. Whether a specific waiver's wording holds up is a separate question that depends on your state's law and the waiver's own terms — worth a quick check with your own attorney if it's ever actually tested.
            </p>
          </div>

          {versionMismatch && (
            <div className="mb-3 p-3" style={{ background: "rgba(21,84,184,0.08)", border: `1px solid ${T.accent}`, borderRadius: 6 }}>
              <div className="text-[12px] font-semibold mb-1" style={{ ...display, color: T.ash }}>Edited since this was signed</div>
              <div className="text-[11px]" style={{ ...body, color: T.ashDim }}>
                The waiver text below is the current version — it may not exactly match what {activity.signedName} agreed to at the time.
              </div>
            </div>
          )}

          {!event ? (
            <p className="text-[12px]" style={{ ...body, color: T.ashFaint }}>This event no longer exists.</p>
          ) : event.waiver?.text ? (
            <div className="p-3 text-[12px] whitespace-pre-wrap" style={{ ...body, background: T.panel, borderRadius: T.rCard, boxShadow: T.shadowMd, color: T.ashDim }}>
              {event.waiver.text}
            </div>
          ) : (
            <p className="text-[12px]" style={{ ...body, color: T.ashFaint }}>No waiver text is on file for this event.</p>
          )}
        </div>
      </div>
    </div>
  );
}

function ManualCheckInModal({ event, bookings, signatures, onClose }) {
  const [query, setQuery] = useState("");
  const [busyUid, setBusyUid] = useState(null);
  const [feedback, setFeedback] = useState(null); // { uid, ok, message }

  const signedUids = new Set(signatures.map((s) => s.uid).filter(Boolean));
  const nameByUid = new Map(signatures.filter((s) => s.uid).map((s) => [s.uid, s.signedName]));
  // Searches both callsign and real signed name — a field owner might be
  // handed a real name to look up just as often as a callsign, especially
  // since callsigns alone can't be trusted to be unique.
  const matches = bookings.filter((b) => {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return b.callsign.toLowerCase().includes(q) || (nameByUid.get(b.uid) || "").toLowerCase().includes(q);
  });

  const handleCheckIn = async (booking) => {
    setBusyUid(booking.uid);
    setFeedback(null);
    try {
      const result = await checkInPlayer(event.id, booking.uid);
      if (result.ok) {
        playFeedbackSound(true);
        const kids = (result.attendees || []).length;
        setFeedback({ uid: booking.uid, ok: true, message: kids ? `${result.callsign} + ${kids} ${kids === 1 ? "child" : "children"} checked in` : `${result.callsign} checked in` });
      } else {
        playFeedbackSound(false);
        setFeedback({ uid: booking.uid, ok: false, message: result.reason === "already-checked-in" ? "Already checked in" : "Couldn't check in — try again" });
      }
    } catch (err) {
      console.error("manual check-in failed:", err);
      playFeedbackSound(false);
      setFeedback({ uid: booking.uid, ok: false, message: "Couldn't check in — try again" });
    } finally {
      setBusyUid(null);
    }
  };

  return (
    <div onClick={onClose} className="fixed inset-0 flex items-end" style={{ background: "rgba(0,0,0,0.5)", zIndex: 1600 }}>
      <div onClick={(e) => e.stopPropagation()} className="w-full max-h-[85vh] flex flex-col" style={{ background: T.void, borderTopLeftRadius: 16, borderTopRightRadius: 16 }}>
        <div className="px-5 pt-4 pb-3 flex items-center justify-between" style={{ borderBottom: `1px solid ${T.line}` }}>
          <div>
            <h2 className="text-[16px] font-semibold" style={{ ...display, color: T.ash }}>Manual Check-In</h2>
            <p className="text-[11px]" style={{ ...body, color: T.ashFaint }}>{event.title}</p>
          </div>
          <button onClick={onClose} className="w-8 h-8 flex items-center justify-center transition-transform duration-100 active:scale-90">
            <X size={18} color={T.ashDim} />
          </button>
        </div>

        <div className="px-5 pt-3">
          <div className="relative mb-3">
            <Search size={15} color={T.ashFaint} className="absolute left-3 top-1/2" style={{ transform: "translateY(-50%)" }} />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search reserved players by name"
              autoFocus
              className="w-full pl-9 pr-3 py-2.5 text-[13px] bg-transparent outline-none"
              style={{ ...body, background: T.panel, border: `1px solid ${T.line}`, borderRadius: 6, color: T.ash, boxSizing: "border-box" }}
            />
          </div>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-5 pb-5">
          {bookings.length === 0 ? (
            <p className="text-[13px] py-6 text-center" style={{ ...body, color: T.ashFaint }}>No one's reserved yet.</p>
          ) : matches.length === 0 ? (
            <p className="text-[13px] py-6 text-center" style={{ ...body, color: T.ashFaint }}>No reserved player matches that name.</p>
          ) : (
            matches.map((b) => (
              <div key={b.uid} className="mb-2 p-3" style={{ background: T.panel, borderRadius: T.rCard, boxShadow: T.shadowMd }}>
                <div className="flex items-center justify-between mb-1">
                  <div>
                    <div className="text-[14px] font-medium" style={{ ...body, color: T.ash }}>{nameByUid.get(b.uid) || b.callsign}</div>
                    {nameByUid.get(b.uid) && (
                      <div className="text-[11px]" style={{ ...body, color: T.ashFaint }}>{b.callsign}</div>
                    )}
                  </div>
                  {b.checkedIn ? (
                    <span className="text-[10px] font-semibold px-1.5 py-0.5 flex items-center gap-1" style={{ ...mono, color: T.good, border: `1px solid ${T.good}`, borderRadius: T.rPill }}>
                      <Check size={9} /> CHECKED IN
                    </span>
                  ) : (
                    <button
                      onClick={() => handleCheckIn(b)}
                      disabled={busyUid === b.uid}
                      className="px-3 py-1.5 text-[11px] font-semibold transition-transform duration-100 active:scale-95"
                      style={{ ...display, background: T.ash, color: "#FFFFFF", borderRadius: T.rPill, boxShadow: T.shadowMd, opacity: busyUid === b.uid ? 0.6 : 1 }}
                    >
                      {busyUid === b.uid ? "…" : "Check In"}
                    </button>
                  )}
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  <div className="text-[11px]" style={{ ...body, color: signedUids.has(b.uid) ? T.good : T.alert }}>
                    {signedUids.has(b.uid) ? "✓ Waiver signed" : "⚠ No waiver signature found"}
                  </div>
                  {b.paid && (
                    <div className="text-[11px]" style={{ ...body, color: T.accent }}>
                      ✓ Paid{typeof b.amountPaidCents === "number" ? ` $${(b.amountPaidCents / 100).toFixed(2)}` : ""}
                    </div>
                  )}
                </div>
                {feedback?.uid === b.uid && (
                  <div className="text-[11px] font-medium mt-1" style={{ ...body, color: feedback.ok ? T.good : T.alert }}>{feedback.message}</div>
                )}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

/* ---------- Bottom nav ---------- */
function OwnerBottomNav({ active, onNavigate }) {
  const tabs = [
    { key: "dashboard", label: "Dashboard", icon: LayoutDashboard },
    { key: "events", label: "Events", icon: Calendar },
    { key: "analytics", label: "Analytics", icon: TrendingUp },
    { key: "roster", label: "Roster", icon: Users },
    { key: "settings", label: "Settings", icon: Settings },
  ];
  return (
    <div className="absolute bottom-4 left-4 right-4" style={{ background: T.glassFill, backdropFilter: T.glassBlur, WebkitBackdropFilter: T.glassBlur, border: T.glassBorder, borderRadius: T.rPill, boxShadow: T.shadowFloat, zIndex: 1000 }}>
      <div className="flex justify-between px-3 pt-2.5" style={{ paddingBottom: 12 }}>
        {tabs.map((t) => {
          const Icon = t.icon;
          const isActive = active === t.key;
          return (
            <button key={t.key} onClick={() => onNavigate(t.key)} className="flex flex-col items-center gap-1 flex-1 transition-transform duration-100 active:scale-90">
              <div className="flex items-center justify-center" style={{ width: 38, height: 26, borderRadius: T.rPill, background: isActive ? T.tint : "transparent" }}>
                <Icon size={18} color={isActive ? T.accent : T.ashDim} strokeWidth={1.7} />
              </div>
              <span className="text-[9px] font-medium" style={{ ...body, color: isActive ? T.accent : T.ashDim }}>{t.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ---------- Events hub (top-level tab — all events across every claimed field) ---------- */
function EventsHubScreen({ myFields, events, eventsLoading, onNewEvent, onStartNewEvent, onEditEvent, onOpenOverview, onOpenRoster, deleteEvent, restoreEvent, duplicateEvent, updateEvent, profile, isOrganizer }) {
  const [tab, setTab] = useState("upcoming");
  const [searchQuery, setSearchQuery] = useState("");
  const [pickerFieldId, setPickerFieldId] = useState(myFields[0]?.id || null);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [confirmPublish, setConfirmPublish] = useState(null);
  const [confirmCancel, setConfirmCancel] = useState(null);
  const [cancelError, setCancelError] = useState("");
  const [publishError, setPublishError] = useState("");
  const [expirationDays, setExpirationDays] = useState(365);
  const [busy, setBusy] = useState(false);
  const today = localDateStr();
  // An organizer (Major) event has no claimed field — null here is handled by
  // the open/edit handlers in App().
  const fieldFor = (ev) => (ev.isMajor ? null : (myFields.find((f) => f.id === ev.fieldId) || myFields[0]));

  const filtered = events
    .filter((ev) => {
      // A deleted event only ever lives under the Deleted tab, regardless
      // of whatever draft/canceled state it was in when it was deleted —
      // it shouldn't keep cluttering Drafts or Canceled too.
      if (tab === "deleted") return ev.deleted === true;
      if (ev.deleted) return false;
      if (tab === "canceled") return ev.canceled === true;
      if (tab === "drafts") return ev.draft === true;
      if (ev.draft || ev.canceled) return false; // Upcoming/Past are date-based buckets; neither has a real confirmed slot anymore
      if (tab === "upcoming") return (ev.endDate || ev.date) >= today;
      if (tab === "past") return (ev.endDate || ev.date) < today;
      return true;
    })
    .filter((ev) => !searchQuery.trim() || ev.title.toLowerCase().includes(searchQuery.trim().toLowerCase()));

  const handleDuplicate = async (ev) => {
    const newId = await duplicateEvent(ev);
    onEditEvent(fieldFor(ev), { ...ev, id: newId, title: `${ev.title} (Copy)`, date: "", draft: true, ...(ev.isMajor ? { bookedCount: 0 } : {}) });
  };

  const handleNew = () => {
    if (isOrganizer) { onStartNewEvent(); return; }
    const field = myFields.find((f) => f.id === pickerFieldId) || myFields[0];
    if (field) onNewEvent(field);
  };

  const handleConfirmDelete = async () => {
    setBusy(true);
    try {
      await deleteEvent(confirmDelete.id);
      setConfirmDelete(null);
    } finally {
      setBusy(false);
    }
  };

  // Distinct from delete — keeps the event as a real record (bookings,
  // waiver signatures, and history all stay intact), just marks it as no
  // longer actually happening. Players who booked or favorited it see a
  // real "canceled" state instead of the event just quietly vanishing.
  //
  // Routed through the cancelEventWithVouchers Cloud Function rather than
  // a plain updateEvent — canceling isn't just a flag flip anymore: any
  // player who already paid needs a real voucher issued (not a Stripe
  // refund — see cancelEventWithVouchers for why), and everyone who
  // reserved needs an in-app notice, both of which have to happen
  // server-side with the Admin SDK since they write into other players'
  // own data.
  const handleConfirmCancel = async () => {
    setBusy(true);
    setCancelError("");
    try {
      const cancelWithVouchers = httpsCallable(functions, "cancelEventWithVouchers");
      await cancelWithVouchers({ eventId: confirmCancel.id, voucherExpirationDays: Number(expirationDays) || 365 });
      setConfirmCancel(null);
    } catch (err) {
      console.error("cancelEventWithVouchers failed:", err);
      setCancelError("Couldn't cancel this event — try again, or reach out on Discord if it keeps happening.");
    } finally {
      setBusy(false);
    }
  };

  const handleConfirmPublish = async () => {
    // Organizer events: same gates as the Publish button inside the editor —
    // a draft saved before the venue was filled in (or before payouts were
    // set up) must not go live through this shortcut. Field events are
    // untouched.
    const pev = confirmPublish;
    if (pev.isMajor) {
      if (!pev.date || !pev.venueName || !pev.address || !pev.venueCity || !pev.venueState) {
        setPublishError("This draft is missing a date or venue details — open it with the pencil button and finish those first.");
        return;
      }
      if (!isBlankPriceText(pev.price) && parsePrice(pev.price) !== null && !profile?.payoutsEnabled) {
        setPublishError("Set up payouts first (Dashboard → Set up payouts) — players can't pay for a paid event until that's done.");
        return;
      }
    }
    setPublishError("");
    setBusy(true);
    try {
      await updateEvent(confirmPublish.id, { draft: false });
      setConfirmPublish(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="h-full overflow-y-auto pb-24" style={flatBg}>
      <div className="px-6 pt-6 pb-4">
        <div className="text-[20px] font-semibold" style={{ ...display, color: T.ash }}>Events</div>
      </div>

      <div className="px-6">
        {myFields.length === 0 && !isOrganizer ? (
          <div className="p-6 flex flex-col items-center text-center" style={{ background: T.panel, borderRadius: T.rCard, boxShadow: T.shadowMd }}>
            <Calendar size={22} color={T.ashDim} className="mb-2" />
            <div className="text-[13px] font-semibold" style={{ ...display, color: T.ash }}>Claim a field first</div>
            <p className="text-[12px]" style={{ ...body, color: T.ashDim }}>You'll need a field before you can create events.</p>
          </div>
        ) : (
          <>
            {myFields.length > 1 && !isOrganizer && (
              <div className="mb-3 flex gap-2 flex-wrap">
                {myFields.map((f) => (
                  <button
                    key={f.id}
                    onClick={() => setPickerFieldId(f.id)}
                    className="px-3 py-1.5 text-[12px] font-medium transition-transform duration-100 active:scale-95"
                    style={{ ...body, border: `1px solid ${pickerFieldId === f.id ? T.accent : T.line}`, background: pickerFieldId === f.id ? T.accent : "transparent", color: pickerFieldId === f.id ? "#fff" : T.ashDim, borderRadius: T.rPill }}
                  >
                    {f.name}
                  </button>
                ))}
              </div>
            )}
            <div className="mb-4">
              <PrimaryButton onClick={handleNew}>+ Create New Event</PrimaryButton>
            </div>
          </>
        )}

        <div className="relative mb-3">
          <Search size={15} color={T.ashFaint} className="absolute left-3 top-1/2" style={{ transform: "translateY(-50%)" }} />
          <input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search your events by name"
            className="w-full pl-9 pr-3 py-2.5 text-[13px] bg-transparent outline-none"
            style={{ ...body, background: T.panel, border: `1px solid ${T.line}`, borderRadius: 6, color: T.ash, boxSizing: "border-box" }}
          />
        </div>

        <div className="flex gap-1 mb-4 overflow-x-auto" style={{ borderBottom: `1px solid ${T.line}` }}>
          {[["upcoming", "Upcoming"], ["past", "Past"], ["drafts", "Drafts"], ["canceled", "Canceled"], ["deleted", "Deleted"]].map(([key, label]) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className="px-3 py-2 text-[12px] font-semibold flex-shrink-0 transition-transform duration-100 active:scale-95"
              style={{ ...body, color: tab === key ? T.ash : T.ashFaint, borderBottom: tab === key ? `2px solid ${T.ash}` : "2px solid transparent" }}
            >
              {label}
            </button>
          ))}
        </div>

        {eventsLoading ? (
          <div className="text-[13px] py-6 text-center" style={{ ...body, color: T.ashFaint }}>Loading…</div>
        ) : filtered.length === 0 ? (
          <div className="text-[13px] py-6 text-center" style={{ ...body, color: T.ashFaint }}>Nothing here yet.</div>
        ) : (
          filtered.map((ev) => (
            <div key={ev.id} className="mb-3 p-4" style={{ background: T.panel, borderRadius: T.rCard, boxShadow: T.shadowMd }}>
              <button onClick={() => onOpenOverview(fieldFor(ev), ev)} className="w-full text-left transition-transform duration-100 active:scale-[0.98]">
                <div className="flex items-start justify-between mb-1">
                  <div className="flex items-center gap-2">
                    {ev.deleted ? (
                      <span className="text-[9px] font-semibold px-1.5 py-0.5" style={{ ...mono, color: T.ashFaint, border: `1px solid ${T.ashFaint}`, borderRadius: T.rPill }}>DELETED</span>
                    ) : ev.canceled ? (
                      <span className="text-[9px] font-semibold px-1.5 py-0.5" style={{ ...mono, color: T.alert, border: `1px solid ${T.alert}`, borderRadius: T.rPill }}>CANCELED</span>
                    ) : ev.draft ? (
                      <span className="text-[9px] font-semibold px-1.5 py-0.5" style={{ ...mono, color: T.ashFaint, border: `1px solid ${T.line}`, borderRadius: T.rPill }}>DRAFT</span>
                    ) : (
                      <span className="text-[9px] font-semibold px-1.5 py-0.5" style={{ ...mono, color: T.good, border: `1px solid ${T.good}`, borderRadius: T.rPill }}>PUBLISHED</span>
                    )}
                    <div className="text-[14px] font-semibold" style={{ ...display, color: T.ash }}>{ev.title}</div>
                  </div>
                  <div className="text-[12px] font-semibold" style={{ ...mono, color: T.accent }}>{displayPrice(ev.price)}</div>
                </div>
                <div className="text-[12px] mb-2" style={{ ...body, color: T.ashFaint }}>
                  {ev.fieldName} · {ev.date || "No date set"}{ev.endDate ? ` – ${ev.endDate}` : ""}{ev.startTime ? ` · ${formatTimeStr(ev.startTime)}` : ""}{ev.endTime ? ` – ${formatTimeStr(ev.endTime)}` : ""}
                </div>
                {(typeof ev.maxCapacity === "number" || ev.interestCount > 0) && (
                  <div className="text-[11px] font-semibold mb-3 flex items-center gap-2">
                    {typeof ev.maxCapacity === "number" && (
                      <span style={{ ...mono, color: T.good }}>{ev.bookedCount || 0} / {ev.maxCapacity} reserved</span>
                    )}
                    {ev.interestCount > 0 && <span style={{ ...mono, color: T.accent }}>{ev.interestCount} interested</span>}
                  </div>
                )}
              </button>
              <div className="flex gap-2 flex-wrap">
                <button onClick={() => onEditEvent(fieldFor(ev), ev)} className="px-3 py-2 flex items-center justify-center transition-transform duration-100 active:scale-95" style={{ border: `1px solid ${T.line}`, color: T.ashDim, borderRadius: T.rPill }}>
                  <Pencil size={14} />
                </button>
                <button onClick={() => onOpenRoster(ev)} className="flex-1 py-2 text-[12px] font-medium flex items-center justify-center gap-1 transition-transform duration-100 active:scale-95" style={{ ...body, border: `1px solid ${T.line}`, color: T.ashDim, borderRadius: T.rPill }}>
                  <Users size={12} /> Roster
                </button>
                <button onClick={() => handleDuplicate(ev)} className="px-3 py-2 text-[12px] font-medium flex items-center gap-1 transition-transform duration-100 active:scale-95" style={{ ...body, border: `1px solid ${T.line}`, color: T.ashDim, borderRadius: T.rPill }}>
                  <Copy size={12} />
                </button>
                {ev.deleted ? (
                  <button onClick={() => restoreEvent(ev.id)} className="px-3 py-2 text-[12px] font-semibold flex items-center gap-1 transition-transform duration-100 active:scale-95" style={{ ...display, background: T.good, color: "#fff", borderRadius: T.rPill, boxShadow: T.shadowSm }}>
                    <RotateCcw size={12} /> Restore
                  </button>
                ) : (
                  <>
                    {ev.draft && (
                      <button onClick={() => setConfirmPublish(ev)} className="px-3 py-2 text-[12px] font-semibold transition-transform duration-100 active:scale-95" style={{ ...display, background: T.good, color: "#fff", borderRadius: T.rPill, boxShadow: T.shadowSm }}>
                        Publish
                      </button>
                    )}
                    {ev.canceled && (
                      <button onClick={() => updateEvent(ev.id, { canceled: false, canceledAt: null })} className="px-3 py-2 text-[12px] font-semibold transition-transform duration-100 active:scale-95" style={{ ...display, background: T.good, color: "#fff", borderRadius: T.rPill, boxShadow: T.shadowSm }}>
                        Reactivate
                      </button>
                    )}
                    {!ev.draft && !ev.canceled && (
                      <button onClick={() => { setConfirmCancel(ev); setExpirationDays(profile?.voucherExpirationDays || 365); }} className="px-3 py-2 flex items-center justify-center transition-transform duration-100 active:scale-95" style={{ border: `1px solid ${T.line}`, color: T.ashDim, borderRadius: T.rPill }}>
                        <Ban size={14} />
                      </button>
                    )}
                    <button onClick={() => setConfirmDelete(ev)} className="px-3 py-2 flex items-center justify-center transition-transform duration-100 active:scale-95" style={{ border: `1px solid ${T.alert}`, color: T.alert, borderRadius: T.rPill }}>
                      <Trash2 size={14} />
                    </button>
                  </>
                )}
              </div>
            </div>
          ))
        )}
      </div>

      {confirmCancel && (
        <div className="fixed inset-0 flex items-center justify-center px-6" style={{ background: "rgba(0,0,0,0.5)", zIndex: 2000 }} onClick={() => !busy && (setConfirmCancel(null), setCancelError(""))}>
          <div onClick={(e) => e.stopPropagation()} className="w-full p-5" style={{ background: T.panel, borderRadius: 8, maxWidth: 340 }}>
            <div className="text-[15px] font-semibold mb-1" style={{ ...display, color: T.ash }}>Cancel this event?</div>
            <p className="text-[13px] mb-4" style={{ ...body, color: T.ashDim }}>
              "{confirmCancel.title}" will be marked canceled — anyone who reserved or favorited it will see that. Any player who already paid for a ticket gets a digital voucher, good for a future event {confirmCancel.isMajor ? "you run" : "at this field"}, instead of a refund. This keeps the real record, unlike delete, and can be reversed by editing the event again.
            </p>
            <label className="block mb-4">
              <span className="block text-[11px] font-semibold uppercase mb-1" style={{ ...mono, color: T.ashFaint, letterSpacing: "0.04em" }}>Vouchers expire after (days)</span>
              <input
                type="number"
                min="1"
                max="3650"
                value={expirationDays}
                onChange={(e) => setExpirationDays(e.target.value)}
                disabled={busy}
                className="w-full px-3 py-2 text-[13px]"
                style={{ ...body, color: T.ash, background: T.panelAlt, border: `1px solid ${T.line}`, borderRadius: 6 }}
              />
            </label>
            {cancelError && (
              <p className="text-[12px] mb-3" style={{ ...body, color: T.alert }}>{cancelError}</p>
            )}
            <div className="flex gap-2">
              <button onClick={() => { setConfirmCancel(null); setCancelError(""); }} disabled={busy} className="flex-1 py-2.5 text-[13px] font-medium transition-transform duration-100 active:scale-95" style={{ ...body, border: `1px solid ${T.line}`, color: T.ashDim, borderRadius: T.rPill }}>
                Never mind
              </button>
              <button onClick={handleConfirmCancel} disabled={busy} className="flex-1 py-2.5 text-[13px] font-semibold transition-transform duration-100 active:scale-95" style={{ ...display, background: T.alert, color: "#fff", borderRadius: T.rPill, boxShadow: T.shadowSm, opacity: busy ? 0.6 : 1 }}>
                {busy ? "Canceling…" : "Cancel Event"}
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmDelete && (
        <div className="fixed inset-0 flex items-center justify-center px-6" style={{ background: "rgba(0,0,0,0.5)", zIndex: 2000 }} onClick={() => !busy && setConfirmDelete(null)}>
          <div onClick={(e) => e.stopPropagation()} className="w-full p-5" style={{ background: T.panel, borderRadius: 8, maxWidth: 340 }}>
            <div className="text-[15px] font-semibold mb-1" style={{ ...display, color: T.ash }}>Delete this event?</div>
            <p className="text-[13px] mb-4" style={{ ...body, color: T.ashDim }}>
              "{confirmDelete.title}" will move to the Deleted tab — bookings, revenue, and waiver history stay intact, and you can restore it later if this was a mistake.
            </p>
            <div className="flex gap-2">
              <button onClick={() => setConfirmDelete(null)} disabled={busy} className="flex-1 py-2.5 text-[13px] font-medium transition-transform duration-100 active:scale-95" style={{ ...body, border: `1px solid ${T.line}`, color: T.ashDim, borderRadius: T.rPill }}>
                Cancel
              </button>
              <button onClick={handleConfirmDelete} disabled={busy} className="flex-1 py-2.5 text-[13px] font-semibold transition-transform duration-100 active:scale-95" style={{ ...display, background: T.alert, color: "#fff", borderRadius: T.rPill, boxShadow: T.shadowSm, opacity: busy ? 0.6 : 1 }}>
                {busy ? "Deleting…" : "Delete Event"}
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmPublish && (
        <div className="fixed inset-0 flex items-center justify-center px-6" style={{ background: "rgba(0,0,0,0.5)", zIndex: 2000 }} onClick={() => !busy && (setConfirmPublish(null), setPublishError(""))}>
          <div onClick={(e) => e.stopPropagation()} className="w-full p-5" style={{ background: T.panel, borderRadius: 8, maxWidth: 340 }}>
            <div className="text-[15px] font-semibold mb-1" style={{ ...display, color: T.ash }}>Publish this event?</div>
            <p className="text-[13px] mb-4" style={{ ...body, color: T.ashDim }}>
              "{confirmPublish.title}" will become visible to players immediately.
            </p>
            {publishError && (
              <p className="text-[12px] mb-3" style={{ ...body, color: T.alert }}>{publishError}</p>
            )}
            <div className="flex gap-2">
              <button onClick={() => { setConfirmPublish(null); setPublishError(""); }} disabled={busy} className="flex-1 py-2.5 text-[13px] font-medium transition-transform duration-100 active:scale-95" style={{ ...body, border: `1px solid ${T.line}`, color: T.ashDim, borderRadius: T.rPill }}>
                Cancel
              </button>
              <button onClick={handleConfirmPublish} disabled={busy} className="flex-1 py-2.5 text-[13px] font-semibold transition-transform duration-100 active:scale-95" style={{ ...display, background: T.good, color: "#fff", borderRadius: T.rPill, boxShadow: T.shadowSm, opacity: busy ? 0.6 : 1 }}>
                {busy ? "Publishing…" : "Publish"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------- Roster hub (top-level tab — pick an event, then see who's signed) ---------- */
function RosterHubScreen({ events, eventsLoading, onOpenRoster }) {
  const today = localDateStr();
  const sorted = [...events].filter((e) => !e.draft && !e.deleted).sort((a, b) => (b.date || "").localeCompare(a.date || ""));

  return (
    <div className="h-full overflow-y-auto pb-24" style={flatBg}>
      <div className="px-6 pt-6 pb-4">
        <div className="text-[20px] font-semibold mb-1" style={{ ...display, color: T.ash }}>Roster</div>
        <p className="text-[12px]" style={{ ...body, color: T.ashDim }}>Pick an event to see who's reserved and who's signed the waiver.</p>
      </div>

      <div className="px-6">
        {eventsLoading ? (
          <div className="text-[13px] py-6 text-center" style={{ ...body, color: T.ashFaint }}>Loading…</div>
        ) : sorted.length === 0 ? (
          <div className="text-[13px] py-6 text-center" style={{ ...body, color: T.ashFaint }}>No published events yet.</div>
        ) : (
          sorted.map((ev) => (
            <button
              key={ev.id}
              onClick={() => onOpenRoster(ev)}
              className="w-full mb-3 p-4 flex items-center justify-between text-left transition-transform duration-100 active:scale-[0.98]"
              style={{ background: T.panel, borderRadius: T.rCard, boxShadow: T.shadowMd }}
            >
              <div>
                <div className="text-[14px] font-semibold" style={{ ...display, color: T.ash }}>{ev.title}</div>
                <div className="text-[12px]" style={{ ...body, color: T.ashFaint }}>{ev.fieldName} · {ev.date}{(ev.endDate || ev.date) >= today ? "" : " (past)"}</div>
              </div>
              <ChevronRight size={16} color={T.ashFaint} />
            </button>
          ))
        )}
      </div>
    </div>
  );
}

function TrendBarChart({ buckets, formatValue = (v) => `$${(v / 100).toFixed(0)}`, ariaLabel = "Trend" }) {
  // Small hand-rolled inline SVG bar chart — no charting dependency in
  // this project, and a handful of monthly bars doesn't need one. Thin
  // bars, 4px rounded top corners (the "data end"), flush square bottom
  // anchored to the baseline, direct value + month labels since there
  // are never more than 6 bars — no legend needed for a single series.
  // Generic over `formatValue` so the same chart shape serves both a
  // dollar series (revenue) and a plain-count series (reservations)
  // without duplicating this SVG for the second one.
  const W = 320, H = 118, padTop = 18, baseline = 88;
  const maxValue = Math.max(1, ...buckets.map((b) => b.value));
  const slotW = W / buckets.length;
  const barW = Math.min(40, slotW * 0.55);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img" aria-label={ariaLabel}>
      <line x1={0} y1={baseline} x2={W} y2={baseline} stroke={T.line} strokeWidth={1} />
      {buckets.map((b, i) => {
        const barH = Math.max(3, (b.value / maxValue) * (baseline - padTop));
        const x = i * slotW + (slotW - barW) / 2;
        const y = baseline - barH;
        return (
          <g key={b.label + i}>
            <rect x={x} y={y} width={barW} height={barH} rx={4} ry={4} fill={T.accent} />
            {barH > 6 && <rect x={x} y={baseline - 4} width={barW} height={4} fill={T.accent} />}
            <text x={x + barW / 2} y={y - 4} textAnchor="middle" style={{ ...mono, fontSize: 9, fill: T.ashDim }}>
              {formatValue(b.value)}
            </text>
            <text x={x + barW / 2} y={baseline + 14} textAnchor="middle" style={{ ...body, fontSize: 9, fill: T.ashFaint }}>
              {b.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

// Thin wrapper kept so the existing revenue call site (buckets shaped as
// {label, cents}) needs no changes at all — this just adapts to
// TrendBarChart's generic {label, value} shape.
function RevenueBarChart({ buckets }) {
  return (
    <TrendBarChart
      buckets={buckets.map((b) => ({ label: b.label, value: b.cents }))}
      formatValue={(v) => `$${(v / 100).toFixed(0)}`}
      ariaLabel="Revenue by month"
    />
  );
}

/* ---------- Analytics (top-level tab, real numbers only) ---------- */
function AnalyticsScreen({ events, eventsLoading, totalSignatures, activityLoading, myFields }) {
  const published = events.filter((e) => !e.draft && !e.deleted);
  const totalInterest = published.reduce((sum, e) => sum + (e.interestCount || 0), 0);
  const totalBooked = published.reduce((sum, e) => sum + (e.bookedCount || 0), 0);
  const topEvents = [...published].filter((e) => e.interestCount > 0).sort((a, b) => (b.interestCount || 0) - (a.interestCount || 0)).slice(0, 5);
  const { records, financialsLoading } = useOwnerFinancials(published);

  const today = localDateStr();
  const totalNetCents = records.reduce((sum, r) => sum + r.netCents, 0);
  const pastNetCents = records.filter((r) => (r.eventDate || "") < today).reduce((sum, r) => sum + r.netCents, 0);
  const upcomingNetCents = totalNetCents - pastNetCents;

  // Revenue by month, bucketed on bookedAt (when the money actually came
  // in, not when the event happens) — last 6 months present in the data,
  // oldest first so the chart reads left-to-right chronologically.
  const monthBuckets = (() => {
    const byMonth = {};
    records.forEach((r) => {
      if (!r.bookedAt?.toDate) return;
      const key = localDateStr(r.bookedAt.toDate()).slice(0, 7); // YYYY-MM
      byMonth[key] = (byMonth[key] || 0) + r.netCents;
    });
    return Object.keys(byMonth).sort().slice(-6).map((key) => ({
      label: new Date(`${key}-01T00:00:00`).toLocaleDateString(undefined, { month: "short" }),
      cents: byMonth[key],
    }));
  })();

  // Revenue by event — ranked by actual dollars, not interest/signups
  // (the existing "Most Interest" list below is signups, not money).
  const eventRevenue = (() => {
    const byEvent = {};
    records.forEach((r) => {
      if (!byEvent[r.eventId]) byEvent[r.eventId] = { id: r.eventId, title: r.eventTitle, cents: 0 };
      byEvent[r.eventId].cents += r.netCents;
    });
    return Object.values(byEvent).sort((a, b) => b.cents - a.cents).slice(0, 5);
  })();

  // Revenue by field — only meaningful once an owner runs more than one,
  // since Atlas Standard now allows unlimited fields per account.
  const fieldRevenue = (() => {
    const byField = {};
    records.forEach((r) => {
      // Organizer events have no field (fieldId null), and their fieldName is
      // a per-event venue — group them together rather than as "Unknown".
      const key = r.fieldId || "other-venues";
      if (!byField[key]) byField[key] = { id: key, name: r.fieldId ? (r.fieldName || "Unknown field") : "Other venues", cents: 0 };
      byField[key].cents += r.netCents;
    });
    return Object.values(byField).sort((a, b) => b.cents - a.cents);
  })();

  // Player-engagement metrics — reservations over time, check-in rate,
  // a real interest-to-booking conversion, and new-vs-returning players.
  // All four read from useOwnerReservationStats, not useOwnerFinancials,
  // since they need every booking (paid and free) plus uid, neither of
  // which that hook exposes (see its own comment for why it stays that
  // way rather than being extended).
  const { reservationBookings, reservationInterested, reservationStatsLoading } = useOwnerReservationStats(published);

  // Reservations over time — every booking (paid or free), bucketed by
  // when it was actually made (bookedAt), same last-6-months shape as
  // the revenue chart above so the two read the same way side by side.
  const reservationMonthBuckets = (() => {
    const byMonth = {};
    reservationBookings.forEach((b) => {
      if (!b.bookedAt?.toDate) return;
      const key = localDateStr(b.bookedAt.toDate()).slice(0, 7);
      byMonth[key] = (byMonth[key] || 0) + 1;
    });
    return Object.keys(byMonth).sort().slice(-6).map((key) => ({
      label: new Date(`${key}-01T00:00:00`).toLocaleDateString(undefined, { month: "short" }),
      value: byMonth[key],
    }));
  })();

  // Check-in / no-show rate — restricted to events whose date has already
  // passed. An upcoming event's bookings haven't had the chance to check
  // in yet; counting them would drag the rate down for no real reason.
  const pastReservationBookings = reservationBookings.filter((b) => (b.eventDate || "") < today);
  const checkedInCount = pastReservationBookings.filter((b) => b.checkedIn).length;
  const checkInRate = pastReservationBookings.length > 0 ? (checkedInCount / pastReservationBookings.length) * 100 : null;

  // Interest-to-booking conversion — a real uid-set intersection between
  // who favorited an event and who actually booked it, not
  // bookedCount/interestCount (two counters that are independent of each
  // other — favoriting was never a required step before booking, so that
  // ratio isn't a meaningful conversion rate and can run over 100%).
  const conversionStats = (() => {
    const bookedUidsByEvent = {};
    reservationBookings.forEach((b) => {
      (bookedUidsByEvent[b.eventId] || (bookedUidsByEvent[b.eventId] = new Set())).add(b.uid);
    });
    let interestedTotal = 0, convertedTotal = 0;
    reservationInterested.forEach((i) => {
      interestedTotal += 1;
      if (bookedUidsByEvent[i.eventId]?.has(i.uid)) convertedTotal += 1;
    });
    return { interestedTotal, rate: interestedTotal > 0 ? (convertedTotal / interestedTotal) * 100 : null };
  })();

  // New vs. returning players — a player's first-ever booking with this
  // owner (earliest bookedAt, across every field they run) counts as
  // "new," every booking after that as "returning." This is a per-booking
  // rate, not a per-player one — a player with 5 bookings contributes 1
  // new + 4 returning — which is the trade-off worth flagging: it weighs
  // toward whoever books most often, rather than answering "what fraction
  // of my distinct players have I seen twice."
  const returningStats = (() => {
    const byUid = {};
    reservationBookings.forEach((b) => {
      if (!b.bookedAt?.toDate) return;
      (byUid[b.uid] || (byUid[b.uid] = [])).push(b);
    });
    let newCount = 0, returningCount = 0;
    Object.values(byUid).forEach((list) => {
      const sorted = [...list].sort((a, b) => a.bookedAt.toDate() - b.bookedAt.toDate());
      sorted.forEach((_, i) => (i === 0 ? newCount++ : returningCount++));
    });
    const total = newCount + returningCount;
    return { total, returningRate: total > 0 ? (returningCount / total) * 100 : null };
  })();

  const exportFinancialsCsv = () => downloadCsv(
    "Atlas Financials.csv",
    ["Event", "Field", "Event Date", "Booked At", "Amount Paid", "Atlas Fee", "Net"],
    records.map((r) => [
      r.eventTitle,
      r.fieldName || "",
      r.eventDate || "",
      r.bookedAt?.toDate ? r.bookedAt.toDate().toLocaleString() : "",
      `$${(r.amountPaidCents / 100).toFixed(2)}`,
      `$${(r.bookingFeeCents / 100).toFixed(2)}`,
      `$${(r.netCents / 100).toFixed(2)}`,
    ])
  );

  return (
    <div className="h-full overflow-y-auto pb-24" style={flatBg}>
      <div className="px-6 pt-6 pb-4">
        <div className="text-[20px] font-semibold" style={{ ...display, color: T.ash }}>Analytics</div>
        <p className="text-[12px]" style={{ ...body, color: T.ashDim }}>Real numbers only — no ratings yet, since reviews don't exist.</p>
      </div>

      <div className="px-6">
        {!financialsLoading && records.length > 0 && (
          <div className="p-4 mb-5" style={{ background: T.panel, borderRadius: T.rCard, boxShadow: T.shadowMd }}>
            <div className="flex items-center justify-between mb-1">
              <div className="flex items-center gap-1.5">
                <TrendingUp size={13} color={T.ashFaint} />
                <span className="text-[10px] font-semibold uppercase" style={{ ...mono, color: T.ashFaint, letterSpacing: "0.04em" }}>Ticket Revenue (Real, Paid Bookings)</span>
              </div>
              <button onClick={exportFinancialsCsv} className="text-[11px] font-semibold transition-transform duration-100 active:scale-95" style={{ ...body, color: T.accent }}>Export CSV</button>
            </div>
            <div className="text-[22px] font-semibold" style={{ ...display, color: T.accent }}>${(totalNetCents / 100).toFixed(2)}</div>
            <div className="text-[9px] mt-0.5" style={{ ...body, color: T.ashFaint }}>${(pastNetCents / 100).toFixed(2)} already earned · ${(upcomingNetCents / 100).toFixed(2)} collected for upcoming events — your share after Atlas's booking fee, already sent to your connected Stripe account</div>
            {monthBuckets.length > 0 && (
              <div className="mt-3">
                <RevenueBarChart buckets={monthBuckets} />
              </div>
            )}
          </div>
        )}

        {!reservationStatsLoading && reservationMonthBuckets.length > 0 && (
          <div className="p-4 mb-5" style={{ background: T.panel, borderRadius: T.rCard, boxShadow: T.shadowMd }}>
            <div className="flex items-center gap-1.5 mb-1">
              <TrendingUp size={13} color={T.ashFaint} />
              <span className="text-[10px] font-semibold uppercase" style={{ ...mono, color: T.ashFaint, letterSpacing: "0.04em" }}>Reservations Over Time</span>
            </div>
            <div className="text-[22px] font-semibold" style={{ ...display, color: T.ash }}>{reservationBookings.length}</div>
            <div className="text-[9px] mt-0.5" style={{ ...body, color: T.ashFaint }}>Every booking, paid or free, by the month it was made</div>
            <div className="mt-3">
              <TrendBarChart buckets={reservationMonthBuckets} formatValue={(v) => String(v)} ariaLabel="Reservations by month" />
            </div>
          </div>
        )}
        <div className="grid grid-cols-2 gap-3 mb-5">
          <div className="p-4" style={{ background: T.panel, borderRadius: T.rCard, boxShadow: T.shadowMd }}>
            <div className="text-[10px] font-semibold uppercase mb-1" style={{ ...mono, color: T.ashFaint, letterSpacing: "0.04em" }}>Published Events</div>
            <div className="text-[22px] font-semibold" style={{ ...display, color: T.ash }}>{eventsLoading ? "…" : published.length}</div>
          </div>
          <div className="p-4" style={{ background: T.panel, borderRadius: T.rCard, boxShadow: T.shadowMd }}>
            <div className="text-[10px] font-semibold uppercase mb-1" style={{ ...mono, color: T.ashFaint, letterSpacing: "0.04em" }}>Total Reserved</div>
            <div className="text-[22px] font-semibold" style={{ ...display, color: T.good }}>{eventsLoading ? "…" : totalBooked}</div>
          </div>
          <div className="p-4" style={{ background: T.panel, borderRadius: T.rCard, boxShadow: T.shadowMd }}>
            <div className="text-[10px] font-semibold uppercase mb-1" style={{ ...mono, color: T.ashFaint, letterSpacing: "0.04em" }}>Total Interest</div>
            <div className="text-[22px] font-semibold" style={{ ...display, color: T.ash }}>{eventsLoading ? "…" : totalInterest}</div>
          </div>
          <div className="p-4" style={{ background: T.panel, borderRadius: T.rCard, boxShadow: T.shadowMd }}>
            <div className="text-[10px] font-semibold uppercase mb-1" style={{ ...mono, color: T.ashFaint, letterSpacing: "0.04em" }}>Waiver Signatures</div>
            <div className="text-[22px] font-semibold" style={{ ...display, color: T.ash }}>{activityLoading ? "…" : totalSignatures}</div>
          </div>
        </div>

        <Eyebrow>Player Engagement</Eyebrow>
        <div className="grid grid-cols-2 gap-3 mb-5">
          <div className="p-4" style={{ background: T.panel, borderRadius: T.rCard, boxShadow: T.shadowMd }}>
            <div className="text-[10px] font-semibold uppercase mb-1" style={{ ...mono, color: T.ashFaint, letterSpacing: "0.04em" }}>Check-In Rate</div>
            <div className="text-[22px] font-semibold" style={{ ...display, color: T.ash }}>{reservationStatsLoading ? "…" : checkInRate == null ? "—" : `${checkInRate.toFixed(0)}%`}</div>
            <div className="text-[9px] mt-0.5" style={{ ...body, color: T.ashFaint }}>{reservationStatsLoading ? "" : checkInRate == null ? "No past events with bookings yet" : `${checkedInCount} of ${pastReservationBookings.length}, past events only`}</div>
          </div>
          <div className="p-4" style={{ background: T.panel, borderRadius: T.rCard, boxShadow: T.shadowMd }}>
            <div className="text-[10px] font-semibold uppercase mb-1" style={{ ...mono, color: T.ashFaint, letterSpacing: "0.04em" }}>Interest → Booking</div>
            <div className="text-[22px] font-semibold" style={{ ...display, color: T.ash }}>{reservationStatsLoading ? "…" : conversionStats.rate == null ? "—" : `${conversionStats.rate.toFixed(0)}%`}</div>
            <div className="text-[9px] mt-0.5" style={{ ...body, color: T.ashFaint }}>{reservationStatsLoading ? "" : conversionStats.rate == null ? "No interest data yet" : `Of ${conversionStats.interestedTotal} interested, actually booked`}</div>
          </div>
          <div className="p-4 col-span-2" style={{ background: T.panel, borderRadius: T.rCard, boxShadow: T.shadowMd }}>
            <div className="text-[10px] font-semibold uppercase mb-1" style={{ ...mono, color: T.ashFaint, letterSpacing: "0.04em" }}>Returning Players</div>
            <div className="text-[22px] font-semibold" style={{ ...display, color: T.ash }}>{reservationStatsLoading ? "…" : returningStats.returningRate == null ? "—" : `${returningStats.returningRate.toFixed(0)}%`}</div>
            <div className="text-[9px] mt-0.5" style={{ ...body, color: T.ashFaint }}>{reservationStatsLoading ? "" : returningStats.returningRate == null ? "No booking history yet" : "Share of bookings made by someone who's booked with you before, across all your fields"}</div>
          </div>
        </div>

        {!financialsLoading && eventRevenue.length > 0 && (
          <>
            <Eyebrow>Revenue by Event</Eyebrow>
            {eventRevenue.map((ev) => (
              <div key={ev.id} className="mb-2 p-3 flex items-center justify-between" style={{ background: T.panel, borderRadius: T.rCard, boxShadow: T.shadowMd }}>
                <div className="text-[13px] font-medium" style={{ ...body, color: T.ash }}>{ev.title}</div>
                <div className="text-[12px] font-semibold" style={{ ...mono, color: T.accent }}>${(ev.cents / 100).toFixed(2)}</div>
              </div>
            ))}
          </>
        )}

        {!financialsLoading && myFields.length > 1 && fieldRevenue.length > 0 && (
          <>
            <Eyebrow>Revenue by Field</Eyebrow>
            {fieldRevenue.map((f) => (
              <div key={f.id} className="mb-2 p-3 flex items-center justify-between" style={{ background: T.panel, borderRadius: T.rCard, boxShadow: T.shadowMd }}>
                <div className="text-[13px] font-medium" style={{ ...body, color: T.ash }}>{f.name}</div>
                <div className="text-[12px] font-semibold" style={{ ...mono, color: T.accent }}>${(f.cents / 100).toFixed(2)}</div>
              </div>
            ))}
          </>
        )}

        <Eyebrow>Most Interest</Eyebrow>
        {topEvents.length === 0 ? (
          <div className="text-[13px] py-4 text-center" style={{ ...body, color: T.ashFaint }}>No interest data yet.</div>
        ) : (
          topEvents.map((ev) => (
            <div key={ev.id} className="mb-2 p-3 flex items-center justify-between" style={{ background: T.panel, borderRadius: T.rCard, boxShadow: T.shadowMd }}>
              <div className="text-[13px] font-medium" style={{ ...body, color: T.ash }}>{ev.title}</div>
              <div className="text-[12px] font-semibold" style={{ ...mono, color: T.accent }}>{ev.interestCount} interested</div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// A once-a-year recap, Wrapped-style: one full-screen card per stat,
// tapped or swiped through. Computes its own data on open (via the same
// useOwnerFinancials / useOwnerReservationStats hooks Analytics already
// uses) rather than a stored summary doc — reusing the exact trade-off
// already accepted there (a real Firestore-read cost each time this
// opens, paid once a year). Combined across every field this owner runs,
// not broken out per field, per Michael. No real drag-swipe gesture —
// tap zones plus visible arrow buttons, same idiom as the player app's
// own version of this screen (and PatchesScreen's lightbox before that).
// Same fixed blue treatment and animation set as the player app's
// identical recap (no shared code between the two apps, so duplicated
// rather than imported) — a deliberate special-occasion look, same
// reasoning as the dashboard banner's own fixed gradient.
const YEAR_IN_REVIEW_KEYFRAMES = `
@keyframes yirBgShift {
  0%, 100% { background-position: 0% 50%; }
  50% { background-position: 100% 50%; }
}
@keyframes yirCardIn {
  0% { opacity: 0; transform: translateY(14px); }
  100% { opacity: 1; transform: translateY(0); }
}
@keyframes yirNumberPop {
  0% { transform: scale(0.5); opacity: 0; }
  60% { transform: scale(1.08); opacity: 1; }
  100% { transform: scale(1); opacity: 1; }
}
@keyframes yirGlow {
  0%, 100% { text-shadow: 0 0 18px rgba(255,255,255,0.25); }
  50% { text-shadow: 0 0 34px rgba(255,255,255,0.55); }
}
@keyframes yirDotFill {
  0% { transform: scaleX(0); }
  100% { transform: scaleX(1); }
}
@keyframes yirSparkOut {
  0% { transform: translateY(0) scale(1); opacity: 1; }
  70% { opacity: 1; }
  100% { transform: translateY(-72px) scale(0.3); opacity: 0; }
}
@keyframes yirConfettiFall {
  0% { transform: translateY(0) rotate(0deg); opacity: 0; }
  10% { opacity: 1; }
  100% { transform: translateY(380px) rotate(320deg); opacity: 0; }
}
@keyframes yirTwinkle {
  0%, 100% { opacity: 0; transform: scale(0.6); }
  50% { opacity: 1; transform: scale(1.15); }
}
`;

// Three small, hand-rolled flourishes (no canvas, no new dependency) —
// sprinkled across cards rather than on every one, so the effect stays a
// surprise rather than becoming visual noise. Identical to the player
// app's own version (no shared code between the two apps). "fireworks"
// marks the two big moments (the open and the sendoff); "confetti" and
// "sparkle" alternate across the stat cards in between for variety.
function YearInReviewEffect({ kind }) {
  if (kind === "fireworks") {
    const sparks = 14;
    const colors = ["#FFFFFF", "#FFD54A", "#7EC8FF", "#FF8AC8"];
    return (
      <>
        {Array.from({ length: sparks }).map((_, i) => {
          const angle = (360 / sparks) * i;
          const color = colors[i % colors.length];
          const delay = 0.05 + (i % 4) * 0.05;
          return (
            <div key={i} className="absolute top-[38%] left-1/2" style={{ transform: `rotate(${angle}deg)` }}>
              <div
                style={{
                  width: 5, height: 5, borderRadius: 999, background: color,
                  boxShadow: `0 0 6px ${color}`,
                  animation: `yirSparkOut 1.1s ease-out ${delay}s both`,
                }}
              />
            </div>
          );
        })}
      </>
    );
  }
  if (kind === "confetti") {
    const pieces = 16;
    const colors = ["#FFD54A", "#7EC8FF", "#FF8AC8", "#8AFFC1", "#FFFFFF"];
    return (
      <>
        {Array.from({ length: pieces }).map((_, i) => {
          const left = (i * 61) % 100;
          const color = colors[i % colors.length];
          const duration = 2.4 + (i % 5) * 0.35;
          const delay = (i % 8) * 0.18;
          return (
            <div
              key={i}
              className="absolute -top-4"
              style={{ left: `${left}%`, width: 6, height: 10, background: color, borderRadius: 1, animation: `yirConfettiFall ${duration}s linear ${delay}s infinite` }}
            />
          );
        })}
      </>
    );
  }
  if (kind === "sparkle") {
    const spots = [
      { top: "18%", left: "20%" }, { top: "22%", left: "78%" },
      { top: "68%", left: "16%" }, { top: "72%", left: "82%" },
      { top: "10%", left: "50%" },
    ];
    return (
      <>
        {spots.map((pos, i) => (
          <div key={i} className="absolute" style={{ ...pos, fontSize: 16, color: "#FFFFFF", animation: `yirTwinkle 1.8s ease-in-out ${i * 0.3}s infinite` }}>
            ✦
          </div>
        ))}
      </>
    );
  }
  return null;
}

// intro/closing always get the big fireworks moment; everything in
// between alternates between the two lighter effects so no two adjacent
// stat cards look the same.
function effectForCard(card, index) {
  if (card.intro || card.closing) return "fireworks";
  return index % 2 === 1 ? "sparkle" : "confetti";
}

function OwnerYearInReviewScreen({ onBack, events, year }) {
  const [index, setIndex] = useState(0);
  const published = events.filter((e) => !e.draft && !e.deleted);
  const { records, financialsLoading } = useOwnerFinancials(published);
  const { reservationBookings, reservationStatsLoading } = useOwnerReservationStats(published);
  const loading = financialsLoading || reservationStatsLoading;

  const yearStr = String(year);
  const today = localDateStr();

  const eventsHosted = published.filter((e) => (e.endDate || e.date || "").slice(0, 4) === yearStr).length;

  const yearBookings = reservationBookings.filter((b) => b.bookedAt?.toDate && b.bookedAt.toDate().getFullYear() === year);
  const totalReservations = yearBookings.length;

  const yearRevenueCents = records
    .filter((r) => r.bookedAt?.toDate && r.bookedAt.toDate().getFullYear() === year)
    .reduce((sum, r) => sum + r.netCents, 0);

  const pastYearBookings = reservationBookings.filter(
    (b) => (b.eventDate || "").slice(0, 4) === yearStr && (b.eventDate || "") < today
  );
  const checkInRate = pastYearBookings.length > 0
    ? (pastYearBookings.filter((b) => b.checkedIn).length / pastYearBookings.length) * 100
    : null;

  // Classified against the owner's FULL booking history (see
  // classifyReturning's own comment), then narrowed down to just this
  // year's bookings for the year's returning-share.
  const classified = classifyReturning(reservationBookings).filter(
    (b) => b.bookedAt?.toDate && b.bookedAt.toDate().getFullYear() === year
  );
  const returningRate = classified.length > 0
    ? (classified.filter((b) => b.isReturning).length / classified.length) * 100
    : null;

  const cards = [
    { intro: true, title: String(year), subtitle: "Your Year in Review" },
    { big: eventsHosted, label: eventsHosted === 1 ? "Event Hosted" : "Events Hosted" },
    { big: totalReservations, label: totalReservations === 1 ? "Reservation" : "Reservations", sub: "Paid and free bookings combined" },
    { big: `$${(yearRevenueCents / 100).toFixed(2)}`, label: "Collected", sub: "Your share, after Atlas's booking fee" },
    checkInRate != null && { big: `${checkInRate.toFixed(0)}%`, label: "Check-In Rate", sub: "Across this year's past events" },
    returningRate != null && { big: `${returningRate.toFixed(0)}%`, label: "Returning Players", sub: "Of this year's reservations" },
    { closing: true, title: "See You Out There", subtitle: `Here's to an even bigger ${year + 1}.` },
  ].filter(Boolean);

  const isFirst = index === 0;
  const isLast = index === cards.length - 1;
  const goNext = () => (isLast ? onBack() : setIndex((i) => Math.min(i + 1, cards.length - 1)));
  const goPrev = () => { if (!isFirst) setIndex((i) => i - 1); };
  const card = cards[Math.min(index, cards.length - 1)];

  if (loading) {
    return (
      <div
        className="h-full w-full flex items-center justify-center"
        style={{ background: "linear-gradient(135deg, #1554B8, #0B2E5C, #1554B8)", backgroundSize: "200% 200%", animation: "yirBgShift 10s ease-in-out infinite" }}
      >
        <div className="text-[13px]" style={{ ...body, color: "rgba(255,255,255,0.7)" }}>Loading your year…</div>
      </div>
    );
  }

  return (
    <div
      className="h-full w-full relative overflow-hidden"
      style={{ background: "linear-gradient(135deg, #1554B8, #0B2E5C, #1554B8)", backgroundSize: "200% 200%", animation: "yirBgShift 10s ease-in-out infinite" }}
    >
      <style>{YEAR_IN_REVIEW_KEYFRAMES}</style>
      <div className="absolute top-6 left-6 right-16 flex gap-1.5 z-20">
        {cards.map((_, i) => (
          <div key={i} className="flex-1 h-1 overflow-hidden" style={{ borderRadius: 999, background: "rgba(255,255,255,0.25)" }}>
            <div
              key={i === index ? `active-${index}` : i < index ? "done" : "todo"}
              className="h-full w-full"
              style={{
                borderRadius: 999,
                background: "#FFFFFF",
                transformOrigin: "left",
                transform: i <= index ? "scaleX(1)" : "scaleX(0)",
                animation: i === index ? "yirDotFill 0.4s ease-out" : "none",
              }}
            />
          </div>
        ))}
      </div>
      <button
        onClick={onBack}
        className="absolute top-5 right-5 w-10 h-10 flex items-center justify-center z-20 transition-transform duration-100 active:scale-90"
        style={{ background: "rgba(255,255,255,0.12)", borderRadius: 999 }}
      >
        <X size={18} color="#FFFFFF" />
      </button>

      <button onClick={goPrev} className="absolute left-0 top-0 bottom-0 w-1/3 z-10" aria-label="Previous" style={{ background: "transparent" }} />
      <button onClick={goNext} className="absolute right-0 top-0 bottom-0 w-2/3 z-10" aria-label="Next" style={{ background: "transparent" }} />

      <div
        key={index}
        className="h-full w-full flex flex-col items-center justify-center px-8 text-center relative z-0"
        style={{ pointerEvents: "none", animation: "yirCardIn 0.4s ease-out" }}
      >
        <div className="absolute inset-0 overflow-hidden" style={{ zIndex: 0 }}>
          <YearInReviewEffect kind={effectForCard(card, index)} />
        </div>
        <div className="relative flex flex-col items-center" style={{ zIndex: 1 }}>
          {card.intro && (
            <>
              <div className="text-[15px] font-semibold uppercase mb-2" style={{ ...body, color: "rgba(255,255,255,0.6)", letterSpacing: "0.08em" }}>Atlas</div>
              <div className="text-[56px] font-bold leading-none mb-3" style={{ ...display, color: "#FFFFFF", animation: "yirNumberPop 0.55s cubic-bezier(0.34,1.56,0.64,1)" }}>{card.title}</div>
              <div className="text-[18px]" style={{ ...body, color: "rgba(255,255,255,0.85)" }}>{card.subtitle}</div>
            </>
          )}
          {card.closing && (
            <>
              <div className="text-[26px] font-bold mb-3" style={{ ...display, color: "#FFFFFF" }}>{card.title}</div>
              <div className="text-[16px]" style={{ ...body, color: "rgba(255,255,255,0.85)" }}>{card.subtitle}</div>
            </>
          )}
          {!card.intro && !card.closing && (
            <>
              <div
                className="text-[64px] font-bold leading-none mb-3"
                style={{ ...display, color: "#FFFFFF", animation: "yirNumberPop 0.55s cubic-bezier(0.34,1.56,0.64,1), yirGlow 2.4s ease-in-out infinite 0.55s" }}
              >
                {card.big}
              </div>
              <div className="text-[20px] font-semibold mb-2" style={{ ...display, color: "#FFFFFF" }}>{card.label}</div>
              {card.sub && <div className="text-[14px]" style={{ ...body, color: "rgba(255,255,255,0.7)" }}>{card.sub}</div>}
            </>
          )}
        </div>
      </div>

      {!isFirst && (
        <button
          onClick={goPrev}
          className="absolute left-3 w-11 h-11 flex items-center justify-center z-20 transition-transform duration-100 active:scale-90"
          style={{ background: "rgba(255,255,255,0.15)", borderRadius: 999, top: "50%", transform: "translateY(-50%)" }}
        >
          <ChevronLeft size={22} color="#FFFFFF" />
        </button>
      )}
      <button
        onClick={goNext}
        className="absolute right-3 w-11 h-11 flex items-center justify-center z-20 transition-transform duration-100 active:scale-90"
        style={{ background: "rgba(255,255,255,0.15)", borderRadius: 999, top: "50%", transform: "translateY(-50%)" }}
      >
        <ChevronRight size={22} color="#FFFFFF" />
      </button>
    </div>
  );
}

/* ---------- Settings ---------- */
// Ceil rather than floor/round — someone with 6 hours left on their trial
// should see "1 day left," not "0 days left" (which reads as "already
// over" and undersells how much notice they actually have).
function daysLeft(date) {
  return Math.max(0, Math.ceil((date.getTime() - Date.now()) / (1000 * 60 * 60 * 24)));
}

// Atlas Standard's fee model: how the platform fee (3.5% + $1.30, capped
// at $5.00) is handled at checkout — added on top for the player, or
// absorbed out of the field's own payout. Chosen once, right after an
// owner's first field claim, and locked in for good; firestore.rules
// enforces the lock server-side (owners/{ownerId} blocks any further
// client write that touches feeModel once it's set), this screen is just
// the one place it's ever set in the first place. No back button when
// used as the mandatory gate (no onBack passed, same pattern the old
// BillingScreen used); the read-only Settings entry passes onBack and
// shows whichever option was already picked instead of a picker.
function FeeModelScreen({ profile, user, onBack }) {
  const [savingOption, setSavingOption] = useState(null);
  const [error, setError] = useState("");

  const handleChoose = async (option) => {
    setSavingOption(option);
    setError("");
    try {
      await updateDoc(doc(db, "owners", user.uid), { feeModel: option });
    } catch (err) {
      console.error("Setting feeModel failed:", err);
      setError("Couldn't save your choice — try again, or reach out on Discord if it keeps happening.");
      setSavingOption(null);
    }
  };

  const header = (
    <div className="px-6 pt-2 pb-4" style={{ borderBottom: onBack ? `1px solid ${T.line}` : "none" }}>
      {onBack ? (
        <div className="flex items-center">
          <button onClick={onBack} className="w-9 h-9 -ml-2 flex items-center justify-center transition-transform duration-100 active:scale-90">
            <ChevronLeft size={20} color={T.ash} />
          </button>
          <h1 className="flex-1 text-center text-[16px] font-semibold mr-9" style={{ ...display, color: T.ash }}>Fee Model</h1>
        </div>
      ) : (
        <div className="pt-6">
          <h1 className="text-[18px] font-semibold mb-1" style={{ ...display, color: T.ash }}>Choose how Atlas's fee is handled</h1>
          <p className="text-[12px]" style={{ ...body, color: T.ashFaint }}>You're all set on your field — just pick one option to start booking players. This is a one-time choice, locked in once you pick.</p>
        </div>
      )}
    </div>
  );

  // Already chosen — read-only info view. Only reachable from Settings;
  // the mandatory gate below never renders this screen once feeModel is
  // actually set.
  if (profile?.feeModel) {
    const isAbsorb = profile.feeModel === "absorb";
    return (
      <div className="h-full overflow-y-auto pb-24" style={flatBg}>
        {header}
        <div className="px-6 pt-6">
          <div className="p-4 mb-4" style={{ background: T.panel, borderRadius: T.rCard, boxShadow: T.shadowMd, outline: `1.5px solid ${T.good}`, outlineOffset: -1 }}>
            <span className="text-[9px] font-semibold px-1.5 py-0.5 mb-2 inline-block" style={{ ...mono, color: T.good, border: `1px solid ${T.good}`, borderRadius: T.rPill }}>LOCKED IN</span>
            <div className="text-[15px] font-semibold mb-1" style={{ ...display, color: T.ash }}>
              {isAbsorb ? "Absorb Fee as Field" : "Pass Fee to Player"}
            </div>
            <p className="text-[12px]" style={{ ...body, color: T.ashDim }}>
              {isAbsorb
                ? "Players pay your exact listed price. Atlas's fee (3.5% + $1.30, capped at $5.00) comes out of your payout."
                : "Atlas's fee (3.5% + $1.30, capped at $5.00) is added at checkout. You keep 100% of your listed ticket price."}
            </p>
          </div>
          <p className="text-[11px] text-center" style={{ ...body, color: T.ashFaint }}>
            This is locked in for your account. Reach out on Discord if you genuinely need it changed.
          </p>
        </div>
      </div>
    );
  }

  // Not chosen yet — the real picker (also doubles as the mandatory gate,
  // rendered with no onBack in that case).
  return (
    <div className="h-full overflow-y-auto pb-24" style={flatBg}>
      {header}
      <div className="px-6 pt-6">
        {error && <p className="text-[12px] mb-3 text-center" style={{ ...body, color: T.alert }}>{error}</p>}
        <p className="text-[11px] mb-4 text-center" style={{ ...body, color: T.ashFaint }}>
          Atlas costs $0/month, always. Every ticket carries a small platform fee (3.5% + $1.30, capped at $5.00) — you choose who pays it.
        </p>
        <div className="flex flex-col gap-3">
          <div className="p-4" style={{ background: T.panel, borderRadius: T.rCard, boxShadow: T.shadowMd }}>
            <span className="text-[9px] font-semibold px-1.5 py-0.5 mb-2 inline-block" style={{ ...mono, color: "#FFFFFF", background: T.accent, borderRadius: T.rPill }}>DEFAULT</span>
            <div className="text-[15px] font-semibold mb-1" style={{ ...display, color: T.ash }}>Pass Fee to Player</div>
            <p className="text-[11px] mb-3" style={{ ...body, color: T.ashDim }}>The fee is added at checkout. You keep 100% of your listed ticket price.</p>
            <div className="p-3 mb-3" style={{ background: T.panelAlt, borderRadius: 6 }}>
              <div className="text-[10px] font-semibold mb-1" style={{ ...mono, color: T.ashFaint }}>ON A $20.00 TICKET</div>
              <div className="text-[11px]" style={{ ...body, color: T.ashDim }}>Player pays $22.00 · You keep $20.00</div>
            </div>
            <PrimaryButton onClick={() => handleChoose("pass_to_player")} disabled={savingOption !== null}>
              {savingOption === "pass_to_player" ? "Saving…" : "Choose This Option"}
            </PrimaryButton>
          </div>
          <div className="p-4" style={{ background: T.panel, borderRadius: T.rCard, boxShadow: T.shadowMd }}>
            <div className="text-[15px] font-semibold mb-1" style={{ ...display, color: T.ash }}>Absorb Fee as Field</div>
            <p className="text-[11px] mb-3" style={{ ...body, color: T.ashDim }}>Players pay your exact listed price, with zero added fees at checkout. The fee comes out of your payout instead.</p>
            <div className="p-3 mb-3" style={{ background: T.panelAlt, borderRadius: 6 }}>
              <div className="text-[10px] font-semibold mb-1" style={{ ...mono, color: T.ashFaint }}>ON A $20.00 TICKET</div>
              <div className="text-[11px]" style={{ ...body, color: T.ashDim }}>Player pays $20.00 · You net $18.00</div>
            </div>
            <button
              onClick={() => handleChoose("absorb")}
              disabled={savingOption !== null}
              className="w-full py-2.5 text-[13px] font-semibold transition-transform duration-100 active:scale-[0.98]"
              style={{ ...display, border: `1px solid ${T.line}`, color: T.ash, borderRadius: T.rPill, opacity: savingOption !== null && savingOption !== "absorb" ? 0.5 : 1 }}
            >
              {savingOption === "absorb" ? "Saving…" : "Choose This Option"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// The "get paid for player bookings" half — entirely separate from
// FeeModelScreen above, both conceptually and in what it actually calls.
// Same account architecture principle used throughout: this screen never
// asks for or sees a bank account number — the owner enters that directly
// with Stripe, on Stripe's own hosted page.
function PayoutsScreen({ profile, onBack, checking }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [manualChecking, setManualChecking] = useState(false);
  const [refreshingBalance, setRefreshingBalance] = useState(false);

  // Refreshes pending/available balance every time this screen opens —
  // separate from the onboarding-status effect further down (App itself),
  // which stops polling once payoutsEnabled flips true. This one exists
  // specifically so an already-set-up owner sees a current balance rather
  // than whatever checkPayoutsStatus last wrote, potentially days ago —
  // the whole point is answering "where's my money" without them having
  // to leave the app, so a stale number here defeats the purpose.
  useEffect(() => {
    if (!profile?.payoutsEnabled || !profile?.stripeConnectAccountId) return;
    setRefreshingBalance(true);
    const checkStatus = httpsCallable(functions, "checkPayoutsStatus");
    checkStatus()
      .catch((err) => console.error("checkPayoutsStatus (balance refresh) failed:", err))
      .finally(() => setRefreshingBalance(false));
    // Deliberately runs once per mount (i.e. each time the owner opens
    // Payouts), not on every profile change — profile updates as a side
    // effect of this same call landing, which would otherwise loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSetUpPayouts = async () => {
    setLoading(true);
    setError("");
    try {
      const createLink = httpsCallable(functions, "createConnectOnboardingLink");
      const result = await createLink();
      // Opens in a genuinely separate tab rather than navigating this
      // app's own window away — a real, confirmed WebKit bug corrupts
      // this specific PWA's rendering after returning from an external
      // site through the same tab. Opening separately means this tab
      // never actually leaves, so it never has the chance to hit that
      // bug at all.
      window.open(result.data.url, "_blank");
      setLoading(false);
    } catch (err) {
      console.error("createConnectOnboardingLink failed:", err);
      setError("Couldn't start setup — try again, or reach out on Discord if it keeps happening.");
      setLoading(false);
    }
  };

  // A manual fallback, not relying on the tab-visibility detection above
  // — that approach has proven unreliable in practice on iOS specifically
  // (a known quirk with that browser event), so this gives a direct way
  // to ask Stripe for the real, current status that doesn't depend on any
  // browser event firing correctly at all.
  const handleCheckStatus = async () => {
    setManualChecking(true);
    setError("");
    try {
      const checkStatus = httpsCallable(functions, "checkPayoutsStatus");
      await checkStatus();
    } catch (err) {
      console.error("checkPayoutsStatus failed:", err);
      setError("Couldn't check status — try again in a moment.");
    } finally {
      setManualChecking(false);
    }
  };

  const header = (
    <div className="px-6 pt-2 pb-4 flex items-center" style={{ borderBottom: `1px solid ${T.line}` }}>
      <button onClick={onBack} className="w-9 h-9 -ml-2 flex items-center justify-center transition-transform duration-100 active:scale-90">
        <ChevronLeft size={20} color={T.ash} />
      </button>
      <h1 className="flex-1 text-center text-[16px] font-semibold mr-9" style={{ ...display, color: T.ash }}>Payouts</h1>
    </div>
  );

  if (profile?.payoutsEnabled) {
    return (
      <div className="h-full overflow-y-auto" style={flatBg}>
        {header}
        <div className="px-6 pt-8 text-center">
          <div className="w-12 h-12 mx-auto mb-3 flex items-center justify-center" style={{ background: T.good, borderRadius: 999 }}>
            <Check size={22} color="#FFFFFF" strokeWidth={3} />
          </div>
          <div className="text-[15px] font-semibold mb-1" style={{ ...display, color: T.ash }}>Payouts active</div>
          <p className="text-[12px] mb-5" style={{ ...body, color: T.ashDim }}>Your Stripe account is set up to receive player booking payments directly.</p>
          {typeof profile?.balanceAvailableCents === "number" || typeof profile?.balancePendingCents === "number" ? (
            <div className="flex gap-2 mb-5">
              <div className="flex-1 p-3" style={{ background: T.panel, borderRadius: T.rCard }}>
                <div className="text-[18px] font-semibold" style={{ ...display, color: T.good }}>${((profile.balanceAvailableCents || 0) / 100).toFixed(2)}</div>
                <div className="text-[10px] mt-0.5" style={{ ...body, color: T.ashFaint }}>Available</div>
              </div>
              <div className="flex-1 p-3" style={{ background: T.panel, borderRadius: T.rCard }}>
                <div className="text-[18px] font-semibold" style={{ ...display, color: T.ash }}>${((profile.balancePendingCents || 0) / 100).toFixed(2)}</div>
                <div className="text-[10px] mt-0.5" style={{ ...body, color: T.ashFaint }}>Pending — clears with Stripe first</div>
              </div>
            </div>
          ) : (
            <p className="text-[11px] mb-5" style={{ ...body, color: T.ashFaint }}>{refreshingBalance ? "Checking your balance…" : "Balance unavailable right now."}</p>
          )}
          <button
            onClick={() => {
              // Standard Connect accounts have no login-link API (that's
              // an Express-only feature) — this is a plain, static URL,
              // not a deep link into this specific account. It opens in
              // a new tab for the same reason as every other Stripe
              // redirect in this app: see the WebKit viewport bug note
              // on the Connect onboarding button above.
              window.open("https://dashboard.stripe.com/", "_blank");
            }}
            className="mx-auto flex items-center gap-1.5 py-2 px-4 text-[12px] font-medium transition-transform duration-100 active:scale-95"
            style={{ ...body, color: T.accent }}
          >
            <ExternalLink size={13} strokeWidth={2} />
            View payouts on Stripe
          </button>
          <p className="text-[11px] mt-1" style={{ ...body, color: T.ashFaint }}>
            Opens Stripe's own login — sign in with the email you used to set up payouts.
          </p>
        </div>
      </div>
    );
  }

  const alreadyStarted = !!profile?.stripeConnectAccountId;

  return (
    <div className="h-full overflow-y-auto" style={flatBg}>
      {header}
      <div className="px-6 pt-8">
        <div className="p-4 mb-4" style={{ background: T.panel, borderRadius: T.rCard, boxShadow: T.shadowMd }}>
          <div className="text-[14px] font-semibold mb-2" style={{ ...display, color: T.ash }}>
            {alreadyStarted ? "Finish setting up payouts" : "Set up payouts"}
          </div>
          {checking && (
            <p className="text-[11px] mb-2" style={{ ...body, color: T.accent }}>Checking your status with Stripe…</p>
          )}
          <p className="text-[12px] mb-4" style={{ ...body, color: T.ashDim }}>
            When players reserve your events, their payment goes to you directly — Atlas only takes its own booking fee, never a cut of your entry price.
            You'll enter your bank details on Stripe's own secure page, not here — Atlas never sees or stores that information.
          </p>
          <p className="text-[11px] mb-4" style={{ ...body, color: T.ashFaint }}>
            This opens in a new browser tab, not inside this app. Once you finish on Stripe's page, just come back and close that tab — this screen will
            update on its own once it's confirmed.
          </p>
          {error && <p className="text-[12px] mb-3" style={{ ...body, color: T.alert }}>{error}</p>}
          <button
            onClick={handleSetUpPayouts}
            disabled={loading}
            className="w-full py-3 text-[13px] font-semibold transition-transform duration-100 active:scale-[0.98]"
            style={{ ...display, background: T.ash, color: "#FFFFFF", borderRadius: T.rPill, boxShadow: T.shadowMd, opacity: loading ? 0.6 : 1 }}
          >
            {loading ? "Opening Stripe…" : alreadyStarted ? "Continue Setup" : "Set Up Payouts"}
          </button>
          {alreadyStarted && (
            <button
              onClick={handleCheckStatus}
              disabled={manualChecking}
              className="w-full py-2.5 text-[12px] font-medium mt-2 transition-transform duration-100 active:scale-[0.98]"
              style={{ ...body, color: T.accent, opacity: manualChecking ? 0.6 : 1 }}
            >
              {manualChecking ? "Checking…" : "Already finished on Stripe? Check status"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function SettingsScreen({ profile, user, updateOwnerName, changePassword, deleteAccount, setAccountRoles, isFieldOwner, isOrganizer, hasFields, onOpenBilling, onOpenPayouts, onOpenYearInReview, onLogout }) {
  // Organizer-only accounts have no field fee model to show.
  const showFieldFee = isFieldOwner || !isOrganizer;
  const [rolesSaving, setRolesSaving] = useState(false);
  const [rolesError, setRolesError] = useState("");
  const [name, setName] = useState(profile?.name || "");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  const [showPasswordForm, setShowPasswordForm] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordSaving, setPasswordSaving] = useState(false);
  const [passwordError, setPasswordError] = useState("");
  const [passwordSuccess, setPasswordSuccess] = useState(false);

  const [showLegal, setShowLegal] = useState(false);
  const [legalTab, setLegalTab] = useState("terms");

  const [showDelete, setShowDelete] = useState(false);
  const [deletePassword, setDeletePassword] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");

  // profile arrives asynchronously — if it wasn't loaded yet at the exact
  // moment this screen first mounted, the useState initializer above would
  // have permanently locked "name" to an empty string. This keeps it in
  // sync whenever the real profile actually shows up or changes.
  useEffect(() => {
    if (profile?.name) setName(profile.name);
  }, [profile?.name]);

  const handleSave = async () => {
    if (!name.trim()) return;
    setSaving(true);
    setError("");
    try {
      await updateOwnerName(name.trim());
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      console.error("updateOwnerName failed:", err);
      setError(`Couldn't save: ${err.code || err.message || "unknown error"}`);
    } finally {
      setSaving(false);
    }
  };

  const friendlyAuthError = (code) => {
    if (code === "auth/invalid-credential" || code === "auth/wrong-password") return "Current password is incorrect.";
    if (code === "auth/weak-password") return "New password needs to be at least 6 characters.";
    if (code === "auth/too-many-requests") return "Too many attempts — wait a bit and try again.";
    if (code === "atlas/upcoming-events") return "You still have upcoming events people may have tickets for. Cancel them first (that issues vouchers to anyone who paid), then delete your account.";
    return "Something went wrong — try again.";
  };

  // Account type is UX tailoring only (it changes what the app shows you, not
  // what you're allowed to do or what you're charged). A field can't be
  // "un-owned" from here, and at least one type must stay on.
  const changeRole = async (key, value) => {
    const next = { fieldOwner: isFieldOwner, organizer: isOrganizer, [key]: value };
    if (!next.fieldOwner && !next.organizer) return;
    setRolesSaving(true);
    setRolesError("");
    try {
      await setAccountRoles(next);
    } catch (err) {
      console.error("setAccountRoles failed:", err);
      setRolesError("Couldn't save that — try again.");
    } finally {
      setRolesSaving(false);
    }
  };

  const submitPasswordChange = async (e) => {
    e.preventDefault();
    setPasswordError("");
    setPasswordSuccess(false);
    if (newPassword !== confirmPassword) {
      setPasswordError("New passwords don't match.");
      return;
    }
    setPasswordSaving(true);
    try {
      await changePassword(currentPassword, newPassword);
      setPasswordSuccess(true);
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
    } catch (err) {
      setPasswordError(friendlyAuthError(err.code));
    } finally {
      setPasswordSaving(false);
    }
  };

  const submitDelete = async () => {
    setDeleteError("");
    setDeleting(true);
    try {
      await deleteAccount(deletePassword);
    } catch (err) {
      setDeleteError(friendlyAuthError(err.code));
      setDeleting(false);
    }
  };

  const LEGAL_TABS = [
    ...(showFieldFee ? [
      { key: "terms", label: "Terms of Use", text: TERMS_OF_USE },
      { key: "privacy", label: "Privacy Policy", text: PRIVACY_POLICY },
      { key: "eula", label: "EULA", text: EULA },
    ] : []),
    ...(isOrganizer ? [
      { key: "o-terms", label: showFieldFee ? "Organizer Terms" : "Terms of Use", text: ORGANIZER_TERMS_OF_USE },
      { key: "o-privacy", label: showFieldFee ? "Organizer Privacy" : "Privacy Policy", text: ORGANIZER_PRIVACY_POLICY },
      { key: "o-eula", label: showFieldFee ? "Organizer EULA" : "EULA", text: ORGANIZER_EULA },
    ] : []),
  ];
  const activeLegal = LEGAL_TABS.find((t) => t.key === legalTab) || LEGAL_TABS[0];

  return (
    <div className="h-full overflow-y-auto pb-24" style={flatBg}>
      <div className="px-6 pt-6 pb-4">
        <div className="text-[20px] font-semibold" style={{ ...display, color: T.ash }}>Settings</div>
      </div>

      <div className="px-6">
        <Eyebrow>Account</Eyebrow>
        <TextField label="Your Name" value={name} onChange={setName} />
        <p className="text-[10px] font-semibold uppercase block mb-1" style={{ ...mono, color: T.ashFaint, letterSpacing: "0.04em" }}>Email</p>
        <p className="text-[13px] mb-3" style={{ ...body, color: T.ashDim }}>{user?.email}</p>
        {error && <p className="text-[12px] mb-2" style={{ ...body, color: T.alert }}>{error}</p>}
        {saved && <p className="text-[12px] mb-2" style={{ ...body, color: T.good }}>Saved.</p>}
        <div className="mb-6">
          <PrimaryButton onClick={handleSave} disabled={saving || !name.trim() || name.trim() === profile?.name}>{saving ? "Saving…" : "Save Name"}</PrimaryButton>
        </div>

        <Eyebrow>Account Type</Eyebrow>
        <p className="text-[11px] mb-2 -mt-1" style={{ ...body, color: T.ashFaint }}>
          Sets up the app around what you do. It doesn't change what you can access or what you're charged.
        </p>
        <div className="mb-3 flex flex-col gap-2">
          {[
            { key: "fieldOwner", label: "I own or manage a field", on: isFieldOwner, locked: hasFields, lockedNote: "You have a claimed field, so this stays on." },
            { key: "organizer", label: "I organize events", on: isOrganizer, locked: false },
          ].map((r) => (
            <label key={r.key} className="p-3 flex items-start gap-3" style={{ background: T.panel, borderRadius: T.rCard, boxShadow: T.shadowMd, opacity: rolesSaving ? 0.6 : 1 }}>
              <input
                type="checkbox"
                className="mt-0.5"
                checked={r.on}
                disabled={rolesSaving || (r.on && r.locked) || (r.on && !(r.key === "fieldOwner" ? isOrganizer : isFieldOwner))}
                onChange={(e) => changeRole(r.key, e.target.checked)}
              />
              <span>
                <span className="text-[13px] font-medium block" style={{ ...body, color: T.ash }}>{r.label}</span>
                {r.on && r.locked && <span className="text-[10px] block" style={{ ...body, color: T.ashFaint }}>{r.lockedNote}</span>}
              </span>
            </label>
          ))}
        </div>
        {rolesError && <p className="text-[12px] mb-2" style={{ ...body, color: T.alert }}>{rolesError}</p>}
        <div className="mb-3" />

        {showFieldFee && (
        <>
        <Eyebrow>Fee Model</Eyebrow>
        <button
          onClick={onOpenBilling}
          className="w-full mb-3 p-4 flex items-center justify-between transition-transform duration-100 active:scale-[0.98]"
          style={{ background: T.panel, borderRadius: T.rCard, boxShadow: T.shadowMd }}
        >
          <div className="text-left">
            <span className="text-[13px] font-medium block" style={{ ...body, color: T.ash }}>
              {profile?.feeModel === "absorb" ? "Absorb Fee as Field" : profile?.feeModel === "pass_to_player" ? "Pass Fee to Player" : "Choose a Fee Model"}
            </span>
            {profile?.feeModel && (
              <span className="text-[11px] block mt-0.5" style={{ ...body, color: T.ashFaint }}>
                Locked in
              </span>
            )}
          </div>
          <ChevronRight size={16} color={T.ashFaint} />
        </button>
        </>
        )}
        {isOrganizer && (
          <>
            <Eyebrow>Fees</Eyebrow>
            <div className="w-full mb-3 p-4" style={{ background: T.panel, borderRadius: T.rCard, boxShadow: T.shadowMd }}>
              <span className="text-[13px] font-medium block" style={{ ...body, color: T.ash }}>
                {showFieldFee ? "Organizer events: " : ""}3.5% + $1.30 per ticket
              </span>
              <span className="text-[11px] block mt-0.5" style={{ ...body, color: T.ashFaint }}>
                No cap. Comes out of your payout — players pay exactly the price you set.
              </span>
            </div>
          </>
        )}
        <button
          onClick={onOpenPayouts}
          className="w-full mb-6 p-4 flex items-center justify-between transition-transform duration-100 active:scale-[0.98]"
          style={{ background: T.panel, borderRadius: 6, border: `1px solid ${profile?.payoutsEnabled ? T.good : T.line}` }}
        >
          <span className="text-[13px] font-medium flex items-center gap-1.5" style={{ ...body, color: profile?.payoutsEnabled ? T.good : T.ash }}>
            {profile?.payoutsEnabled && <Check size={14} strokeWidth={2.5} />}
            {profile?.payoutsEnabled ? "Payouts Active" : "Set Up Payouts"}
          </span>
          <ChevronRight size={16} color={T.ashFaint} />
        </button>
        <button
          onClick={onOpenYearInReview}
          className="w-full mb-6 p-4 flex items-center justify-between transition-transform duration-100 active:scale-[0.98]"
          style={{ background: T.panel, borderRadius: T.rCard, boxShadow: T.shadowMd }}
        >
          <span className="text-[13px] font-medium" style={{ ...body, color: T.ash }}>Year in Review</span>
          <ChevronRight size={16} color={T.ashFaint} />
        </button>

        <Eyebrow>Security</Eyebrow>
        <button
          onClick={() => { setShowPasswordForm(!showPasswordForm); setPasswordError(""); setPasswordSuccess(false); }}
          className="w-full flex items-center justify-between py-3 px-4 mb-2 transition-transform duration-100 active:scale-[0.98]"
          style={{ background: T.panel, borderRadius: T.rCard, boxShadow: T.shadowMd }}
        >
          <span className="text-[14px] font-medium" style={{ ...body, color: T.ash }}>Change Password</span>
          <ChevronRight size={15} color={T.ashFaint} style={{ transform: showPasswordForm ? "rotate(90deg)" : "none" }} />
        </button>
        {showPasswordForm && (
          <form onSubmit={submitPasswordChange} className="flex flex-col gap-2.5 mb-2">
            <input
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              type="password"
              autoComplete="current-password"
              placeholder="Current password"
              className="px-4 py-3 text-[14px] bg-transparent outline-none"
              style={{ ...body, background: T.panel, border: `1px solid ${T.line}`, borderRadius: 4, color: T.ash }}
            />
            <input
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              type="password"
              autoComplete="new-password"
              placeholder="New password"
              className="px-4 py-3 text-[14px] bg-transparent outline-none"
              style={{ ...body, background: T.panel, border: `1px solid ${T.line}`, borderRadius: 4, color: T.ash }}
            />
            <input
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              type="password"
              autoComplete="new-password"
              placeholder="Confirm new password"
              className="px-4 py-3 text-[14px] bg-transparent outline-none"
              style={{ ...body, background: T.panel, border: `1px solid ${T.line}`, borderRadius: 4, color: T.ash }}
            />
            {passwordError && <p className="text-[12px]" style={{ ...body, color: T.alert }}>{passwordError}</p>}
            {passwordSuccess && <p className="text-[12px]" style={{ ...body, color: T.good }}>Password updated.</p>}
            <button
              type="submit"
              disabled={passwordSaving || !currentPassword || !newPassword}
              className="w-full py-3 font-semibold text-[14px] transition-transform duration-100 active:scale-[0.98]"
              style={{ ...display, background: T.ash, color: "#FFFFFF", borderRadius: T.rPill, boxShadow: T.shadowMd, opacity: passwordSaving || !currentPassword || !newPassword ? 0.6 : 1 }}
            >
              {passwordSaving ? "Updating…" : "Update Password"}
            </button>
          </form>
        )}

        <div className="mb-6" />

        <Eyebrow>Legal</Eyebrow>
        <button
          onClick={() => setShowLegal(true)}
          className="w-full mb-6 p-4 flex items-center justify-between transition-transform duration-100 active:scale-[0.98]"
          style={{ background: T.panel, borderRadius: T.rCard, boxShadow: T.shadowMd }}
        >
          <span className="text-[13px] font-medium" style={{ ...body, color: T.ash }}>Terms, Privacy & EULA</span>
          <ChevronRight size={16} color={T.ashFaint} />
        </button>

        <Eyebrow>Support</Eyebrow>
        <a
          href="https://discord.gg/hR8EntGsq"
          target="_blank"
          rel="noreferrer"
          className="w-full mb-6 p-4 flex items-center justify-between"
          style={{ background: T.panel, borderRadius: T.rCard, boxShadow: T.shadowMd, textDecoration: "none" }}
        >
          <span className="text-[13px] font-medium" style={{ ...body, color: T.ash }}>Get help on Discord</span>
          <ChevronRight size={16} color={T.ashFaint} />
        </a>

        <div className="mb-4">
          <button
            onClick={onLogout}
            className="w-full py-3 font-medium text-[14px] flex items-center justify-center gap-2 transition-transform duration-100 active:scale-[0.98]"
            style={{ ...body, border: `1px solid ${T.alert}`, color: T.alert, borderRadius: T.rPill }}
          >
            <LogOut size={15} /> Log Out
          </button>
        </div>

        {!showDelete ? (
          <button onClick={() => setShowDelete(true)} className="w-full text-center text-[13px] font-medium py-2 mb-4 transition-transform duration-100 active:scale-[0.98]" style={{ ...body, color: T.alert }}>
            Delete Account
          </button>
        ) : (
          <div className="p-4 mb-4" style={{ background: "rgba(188,51,39,0.08)", border: `1px solid ${T.alert}`, borderRadius: 6 }}>
            <div className="text-[13px] font-semibold mb-1" style={{ ...display, color: T.ash }}>Delete your account?</div>
            <p className="text-[12px] mb-3" style={{ ...body, color: T.ashDim }}>
              This permanently deletes your owner account. Any fields you've claimed are released back to unclaimed — you or someone else would need to reclaim them.{isOrganizer ? " If you have upcoming events, cancel them first — that issues vouchers to anyone who paid." : ""} This can't be undone. Enter your password to confirm.
            </p>
            <input
              value={deletePassword}
              onChange={(e) => setDeletePassword(e.target.value)}
              type="password"
              autoComplete="current-password"
              placeholder="Current password"
              className="w-full px-3 py-2.5 text-[14px] bg-transparent outline-none mb-3"
              style={{ ...body, background: T.panel, border: `1px solid ${T.line}`, borderRadius: 4, color: T.ash }}
            />
            {deleteError && <p className="text-[11px] mb-2" style={{ ...body, color: T.alert }}>{deleteError}</p>}
            <div className="flex gap-2">
              <button onClick={() => { setShowDelete(false); setDeletePassword(""); setDeleteError(""); }} className="flex-1 py-2.5 text-[12px] font-medium transition-transform duration-100 active:scale-95" style={{ ...body, border: `1px solid ${T.line}`, color: T.ashDim, borderRadius: T.rPill }}>
                Cancel
              </button>
              <button
                onClick={submitDelete}
                disabled={deleting || !deletePassword}
                className="flex-1 py-2.5 text-[12px] font-semibold transition-transform duration-100 active:scale-95"
                style={{ ...display, background: T.alert, color: "#FFFFFF", borderRadius: T.rPill, boxShadow: T.shadowSm, opacity: deleting || !deletePassword ? 0.6 : 1 }}
              >
                {deleting ? "Deleting…" : "Delete Permanently"}
              </button>
            </div>
          </div>
        )}

        <p className="text-[11px] text-center" style={{ ...body, color: T.ashFaint }}>{isOrganizer && !showFieldFee ? "Atlas Event Organizer" : isOrganizer ? "Atlas Field Owner · Event Organizer" : "Atlas Field Owner"}</p>
      </div>

      {showLegal && (
        <div onClick={() => setShowLegal(false)} className="fixed inset-0 flex items-end" style={{ background: "rgba(0,0,0,0.5)", zIndex: 1500 }}>
          <div onClick={(e) => e.stopPropagation()} className="w-full max-h-[85vh] flex flex-col" style={{ background: T.void, borderTopLeftRadius: 16, borderTopRightRadius: 16 }}>
            <div className="px-5 pt-4 pb-3 flex items-center justify-between" style={{ borderBottom: `1px solid ${T.line}` }}>
              <h2 className="text-[16px] font-semibold" style={{ ...display, color: T.ash }}>Legal</h2>
              <button onClick={() => setShowLegal(false)} className="w-8 h-8 flex items-center justify-center transition-transform duration-100 active:scale-90">
                <X size={18} color={T.ashDim} />
              </button>
            </div>
            <div className="px-5 flex gap-1" style={{ borderBottom: `1px solid ${T.line}` }}>
              {LEGAL_TABS.map((t) => (
                <button
                  key={t.key}
                  onClick={() => setLegalTab(t.key)}
                  className="px-2 py-2 text-[12px] font-semibold transition-transform duration-100 active:scale-95"
                  style={{ ...body, color: activeLegal.key === t.key ? T.ash : T.ashFaint, borderBottom: activeLegal.key === t.key ? `2px solid ${T.ash}` : "2px solid transparent" }}
                >
                  {t.label}
                </button>
              ))}
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4">
              <p className="text-[12px] whitespace-pre-wrap" style={{ ...body, color: T.ashDim, lineHeight: 1.6 }}>{activeLegal.text}</p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// iOS browsers other than Safari put their own token in the user agent
// (Chrome = CriOS, Firefox = FxiOS, Edge = EdgiOS, Opera = OPiOS), and
// their Share button lives in a different place than Safari's. In-app
// browsers (Facebook, Instagram, etc.) can't add to Home Screen at all.
// Returns the ordered install steps to show for the current browser.
function getIOSInstallSteps(ua) {
  if (/FBAN|FBAV|FB_IAB|Instagram|Snapchat|TikTok|musical_ly|Line\/|MicroMessenger|Twitter/i.test(ua)) {
    return [
      "This in-app browser can't install apps. Tap the \u2022\u2022\u2022 or Share icon and choose \"Open in Safari\"",
      "Then tap Share in Safari and choose \"Add to Home Screen\"",
    ];
  }
  if (/CriOS/i.test(ua)) {
    return [
      "Tap the Share icon at the top, on the right end of the address bar next to the URL",
      "In the menu that opens, tap \"Add to Home Screen\". If you don't see it, tap \"View More\" to find it",
    ];
  }
  if (/FxiOS|EdgiOS|OPiOS/i.test(ua)) {
    return [
      "Tap the Share icon (or open the browser's menu and choose Share)",
      "Tap \"Add to Home Screen\" (tap \"View More\" if you don't see it). Not there? Open this page in Safari instead",
    ];
  }
  // Safari only from here. Since iOS 26 the OS version in the user agent is
  // frozen (reports 18_6), but the Version/ token still tracks the Safari
  // major, which matches the iOS major. Share moved in 26 and again in 27.
  const vm = ua.match(/Version\/(\d+)/);
  const major = vm ? parseInt(vm[1], 10) : 0;
  if (major >= 27) {
    return [
      "Tap the menu icon (\u2630) on the left side of the address bar, then tap \"Share\" at the top of the menu",
      "Tap \"View More\", then scroll down and tap \"Add to Home Screen\"",
    ];
  }
  if (major === 26) {
    return [
      "Tap the \u2022\u2022\u2022 button on the right side of the address bar, then tap \"Share\"",
      "Scroll down and tap \"Add to Home Screen\" (tap \"View More\" first if you don't see it)",
    ];
  }
  return [
    "Tap the Share button in Safari's toolbar",
    "Scroll down and tap \"Add to Home Screen\"",
  ];
}

function InstallGateScreen({ platform, deferredPrompt }) {
  const [installing, setInstalling] = useState(false);

  const handleInstallClick = async () => {
    if (!deferredPrompt) return;
    setInstalling(true);
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    setInstalling(false);
  };

  return (
    <div className="h-screen flex flex-col items-center justify-center px-8 text-center" style={flatBg}>
      <style>{FONTS}</style>
      <div className="w-16 h-16 flex items-center justify-center mb-4 overflow-hidden" style={{ borderRadius: 12 }}>
        <img src={`${import.meta.env.BASE_URL}logo.jpg`} alt="Atlas" className="w-full h-full" style={{ objectFit: "cover" }} />
      </div>
      <h1 className="text-[20px] font-semibold mb-2" style={{ ...display, color: T.ash }}>Add Atlas Owners to your Home Screen</h1>
      <p className="text-[14px] mb-6" style={{ ...body, color: T.ashDim, maxWidth: 320 }}>
        This app works best installed — full screen and faster, especially for check-in on a tablet. Install it to continue.
      </p>

      {platform === "ios" ? (
        <div className="w-full text-left" style={{ maxWidth: 320 }}>
          {getIOSInstallSteps(navigator.userAgent).map((step, i, arr) => (
            <div key={i} className={"flex items-center gap-3 p-3" + (i < arr.length - 1 ? " mb-3" : "")} style={{ background: T.panel, borderRadius: T.rCard, boxShadow: T.shadowMd }}>
              <span className="text-[16px] font-semibold" style={{ ...display, color: T.accent }}>{i + 1}</span>
              <span className="text-[13px]" style={{ ...body, color: T.ash }}>{step}</span>
            </div>
          ))}
        </div>
      ) : deferredPrompt ? (
        <button
          onClick={handleInstallClick}
          disabled={installing}
          className="w-full py-3.5 font-semibold text-[14px] transition-transform duration-100 active:scale-[0.98]"
          style={{ ...display, background: T.ash, color: "#FFFFFF", borderRadius: T.rPill, boxShadow: T.shadowMd, maxWidth: 320, opacity: installing ? 0.6 : 1 }}
        >
          {installing ? "Opening…" : "Install Atlas Owners"}
        </button>
      ) : (
        <div className="w-full text-left" style={{ maxWidth: 320 }}>
          <div className="flex items-center gap-3 p-3" style={{ background: T.panel, borderRadius: T.rCard, boxShadow: T.shadowMd }}>
            <span className="text-[16px] font-semibold" style={{ ...display, color: T.accent }}>1</span>
            <span className="text-[13px]" style={{ ...body, color: T.ash }}>Open your browser's menu and tap "Add to Home Screen" or "Install App"</span>
          </div>
        </div>
      )}

      <p className="text-[11px] mt-6" style={{ ...body, color: T.ashFaint }}>Already installed? Open Atlas Owners from your Home Screen instead of this browser tab.</p>
    </div>
  );
}

// Turns a Stripe Connect account's payouts.schedule object into a plain
// sentence fragment for the post-event payout celebration ("Payouts are
// ___."). No schedule cached yet (owner never triggered a checkPayoutsStatus
// refresh, or it's genuinely null) falls back to Stripe's own general
// default rather than guessing a specific cadence that might be wrong.
function formatPayoutSchedule(schedule) {
  if (!schedule || !schedule.interval) {
    return "on Stripe's standard schedule (typically every couple of business days) — check your Stripe dashboard for your exact timing";
  }
  const delay = typeof schedule.delay_days === "number" ? schedule.delay_days : null;
  const delayPhrase = delay ? ` — expect it in your bank within about ${delay} business day${delay === 1 ? "" : "s"} after that` : "";
  if (schedule.interval === "manual") {
    return "released manually by Atlas — reach out on Discord if you're ever unsure when to expect it";
  }
  if (schedule.interval === "daily") {
    return `sent out daily${delayPhrase}`;
  }
  if (schedule.interval === "weekly") {
    const day = schedule.weekly_anchor ? schedule.weekly_anchor.charAt(0).toUpperCase() + schedule.weekly_anchor.slice(1) : "the same day each week";
    return `sent out every ${day}${delayPhrase}`;
  }
  if (schedule.interval === "monthly") {
    const anchor = typeof schedule.monthly_anchor === "number" ? schedule.monthly_anchor : null;
    return `sent out on day ${anchor || "\u2014"} of each month${delayPhrase}`;
  }
  return "on Stripe's standard schedule — check your Stripe dashboard for your exact timing";
}

// Deliberately a small dismissable-by-ignoring floating bar, not a modal
// — a new build being ready is never
// urgent enough to block whatever the owner is doing (managing a field,
// checking a player in at the gate), so this never force-reloads on its
// own. It only reloads when the owner themselves taps Refresh.
function UpdateAvailableToast({ onRefresh }) {
  return (
    <div
      className="fixed left-4 right-4 flex items-center justify-between gap-3 px-4 py-3"
      style={{
        bottom: 84,
        background: T.glassFill,
        backdropFilter: T.glassBlur,
        WebkitBackdropFilter: T.glassBlur,
        border: T.glassBorder,
        borderRadius: T.rFloat,
        boxShadow: T.shadowFloat,
        zIndex: 1800,
      }}
    >
      <p className="text-[13px] font-medium" style={{ ...body, color: T.ash }}>
        A new version of Atlas is ready.
      </p>
      <button
        onClick={onRefresh}
        className="flex items-center gap-1.5 px-3.5 py-2 text-[12px] font-semibold flex-shrink-0 transition-transform duration-100 active:scale-95"
        style={{ ...display, background: T.ash, color: "#FFFFFF", borderRadius: T.rPill }}
      >
        <RotateCcw size={13} />
        Refresh
      </button>
    </div>
  );
}

const WELCOME_KEYFRAMES = `
@keyframes welcomePop {
  0% { transform: scale(0.3); opacity: 0; }
  60% { transform: scale(1.08); opacity: 1; }
  100% { transform: scale(1); opacity: 1; }
}
@keyframes welcomeGlow {
  0%, 100% { filter: drop-shadow(0 0 24px rgba(255,255,255,0.3)); }
  50% { filter: drop-shadow(0 0 44px rgba(255,255,255,0.55)); }
}
@keyframes welcomeIn {
  0% { opacity: 0; }
  100% { opacity: 1; }
}
`;

// Shown once, right after an owner claims a field, before they land on
// that field's dashboard — same immersive full-bleed treatment as the
// player app's patch-unlock moment (same brand blue, #002C48 = T.ash)
// so the two apps feel like one product even though this is a separate
// codebase. Purely a UI beat: nothing is persisted, so it only ever
// appears in the instant right after a successful claim, never again
// on a later login for that same field.
function ClaimWelcomeScreen({ fieldName, onContinue }) {
  return (
    <div
      className="fixed inset-0 flex flex-col items-center justify-center px-8"
      style={{ background: "rgba(0,44,72,0.97)", zIndex: 3000, animation: "welcomeIn 0.3s ease-out" }}
    >
      <style>{WELCOME_KEYFRAMES}</style>

      <div className="relative mb-7" style={{ animation: "welcomeGlow 2.4s ease-in-out infinite" }}>
        <div style={{ position: "absolute", inset: -40, background: "radial-gradient(circle, rgba(255,255,255,0.22) 0%, transparent 70%)", borderRadius: "50%" }} />
        <div
          className="overflow-hidden"
          style={{ width: 110, height: 110, borderRadius: 16, position: "relative", animation: "welcomePop 0.55s cubic-bezier(0.34,1.56,0.64,1)" }}
        >
          <img src={`${import.meta.env.BASE_URL}logo.jpg`} alt="Atlas" className="w-full h-full" style={{ objectFit: "cover" }} />
        </div>
      </div>

      <div className="text-[24px] font-bold text-center px-2 mb-2" style={{ ...display, color: "#FFFFFF", lineHeight: 1.3 }}>
        Welcome to Atlas, {fieldName}!
      </div>
      <div className="text-[14px] text-center mb-9 px-6" style={{ ...body, color: "rgba(255,255,255,0.75)" }}>
        Your field is live. Let's get your events, waivers, and payouts set up.
      </div>

      <button
        onClick={onContinue}
        className="px-9 py-3.5 font-semibold text-[14px] transition-transform duration-100 active:scale-95"
        style={{ ...display, background: "#FFFFFF", color: T.ash, borderRadius: 999 }}
      >
        Let's get started
      </button>
    </div>
  );
}

/* ---------- App shell ---------- */
// Shown only to someone who is both a field owner and an organizer, when they
// start a new event: at one of their own fields (a regular field event), or
// at another venue (an Atlas Major, venue typed in or copied from the
// directory). Deliberately a plain choice — whether an own-field event can
// ALSO run as a Major is a Phase 2 decision.
function NewEventChoiceScreen({ myFields, onBack, onPickField, onPickVenue }) {
  return (
    <div className="h-screen flex flex-col" style={flatBg}>
      <div className="px-5 pt-5 pb-3 flex items-center gap-3">
        <button onClick={onBack} className="p-1" aria-label="Back"><ChevronLeft size={22} color={T.ash} /></button>
        <h1 className="text-[18px] font-semibold" style={{ ...display, color: T.ash }}>Where's this event?</h1>
      </div>
      <div className="flex-1 overflow-y-auto px-5 pb-8 flex flex-col gap-3">
        {myFields.map((f) => (
          <button
            key={f.id}
            onClick={() => onPickField(f)}
            className="w-full p-4 text-left transition-transform duration-100 active:scale-[0.98]"
            style={{ background: T.panel, borderRadius: T.rCard, boxShadow: T.shadowMd }}
          >
            <div className="text-[14px] font-semibold" style={{ ...display, color: T.ash }}>At {f.name}</div>
            <div className="text-[12px]" style={{ ...body, color: T.ashDim }}>Your field — a regular field event.</div>
          </button>
        ))}
        <button
          onClick={onPickVenue}
          className="w-full p-4 text-left transition-transform duration-100 active:scale-[0.98]"
          style={{ background: T.panel, borderRadius: T.rCard, boxShadow: T.shadowMd }}
        >
          <div className="text-[14px] font-semibold" style={{ ...display, color: T.ash }}>At another venue</div>
          <div className="text-[12px]" style={{ ...body, color: T.ashDim }}>You'll enter the venue's name and address — or copy it from an Atlas field.</div>
        </button>
      </div>
    </div>
  );
}

export default function App() {
  const { needRefresh, refreshNow } = useSWUpdate();
  // Sets the real, trustworthy height — but not from window.screen.height
  // alone, since that's the *physical* screen including the area behind
  // the status bar, and env(safe-area-inset-*) proved unreliable here for
  // subtracting that back out (a real, separately-documented quirk of
  // that CSS feature). Instead: remember the largest innerHeight ever
  // seen in this session. The WebKit bug above only ever *shrinks* the
  // reported height after a redirect — it never grows it — so the
  // largest value observed is always the one genuinely worth trusting,
  // and sessionStorage carries it across the round-trip to Stripe and
  // back, where the corruption actually happens.
  useEffect(() => {
    // 2026-10-06 (same fix as the player app, which hit it on desktop Opera
    // GX): the never-shrink cache is only right for the phone/tablet WebKit
    // bug. On desktop the viewport legitimately shrinks (resize, zoom,
    // leaving fullscreen, devtools or a browser sidebar), and html/body/#root
    // are position:fixed + overflow:hidden at this height, so a stale larger
    // value pushes the bottom of the app below the visible window with no way
    // to scroll to it. Desktop now always uses the live height.
    const isPhoneOrTablet = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
    const setRealHeight = () => {
      const current = window.visualViewport ? window.visualViewport.height : window.innerHeight;
      let real = current;
      try {
        if (isPhoneOrTablet) {
          const cached = parseInt(sessionStorage.getItem("atlas-known-good-height") || "0", 10);
          real = Math.max(current, cached);
          sessionStorage.setItem("atlas-known-good-height", String(real));
        } else {
          sessionStorage.removeItem("atlas-known-good-height");
        }
      } catch {
        // Storage blocked — fall back to the live height.
      }
      document.documentElement.style.setProperty("--real-screen-height", `${real}px`);
    };
    setRealHeight();
    // A tiny, deliberate scroll nudge — a known technique for exactly
    // this class of bug. The layout itself has been proven correct for a
    // couple of rounds now (every measured position and size checks out
    // exactly right), yet content still isn't actually painting on
    // screen — which points to the browser's own rendering surface being
    // stuck at the corrupted, smaller height, not a layout problem CSS
    // can fix. A real scroll (even 1px) can force Safari to fully
    // re-evaluate a genuinely stuck internal viewport in a way that CSS
    // and JS height variables alone don't.
    setTimeout(() => {
      window.scrollTo(0, 1);
      window.scrollTo(0, 0);
    }, 50);
    window.visualViewport?.addEventListener("resize", setRealHeight);
    window.addEventListener("resize", setRealHeight);
    return () => {
      window.visualViewport?.removeEventListener("resize", setRealHeight);
      window.removeEventListener("resize", setRealHeight);
    };
  }, []);

  // Same gating logic as the player app: only phones and tablets (iPad
  // matches the iOS check, Android tablets match the Android check) get
  // hard-gated — desktop browsers don't have the same "installed app vs.
  // browser tab" distinction. Tablets are deliberately included here, not
  // excluded, since check-in on a tablet was the whole reason this app
  // needs to work as a real installed app in the first place.
  const [installGate, setInstallGate] = useState(null);
  const [deferredInstallPrompt, setDeferredInstallPrompt] = useState(null);

  useEffect(() => {
    const isStandalone = window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
    const ua = navigator.userAgent;
    const isIOS = /iPhone|iPad|iPod/i.test(ua);
    const isAndroid = /Android/i.test(ua);

    if (isStandalone || (!isIOS && !isAndroid)) {
      setInstallGate(false);
      return;
    }
    setInstallGate(isIOS ? "ios" : "android");

    const handler = (e) => {
      e.preventDefault();
      setDeferredInstallPrompt(e);
    };
    window.addEventListener("beforeinstallprompt", handler);
    return () => window.removeEventListener("beforeinstallprompt", handler);
  }, []);

  const { user, profile, authLoading, signUp, signIn, signOut, updateOwnerName, acceptTerms, acceptOrganizerTerms, setAccountRoles, changePassword, deleteAccount } = useOwnerAuth();

  // App-level, not scoped to any one screen — a real gap in the earlier
  // version: mobile Safari can silently reload a backgrounded tab to free
  // memory while you're away on Stripe's separate tab, which resets React
  // state and lands you back on the Dashboard rather than wherever you
  // actually left off. A check scoped to the Payouts screen specifically
  // never got the chance to run in that case, since that screen no longer
  // existed. Living here means it runs regardless of which screen you
  // land back on.
  const [checkingPayouts, setCheckingPayouts] = useState(false);
  useEffect(() => {
    // Keeps checking until payouts are enabled AND a payout schedule is
    // cached — not just the former. Otherwise an owner whose payouts were
    // already enabled before payoutSchedule existed would never get one
    // backfilled (this effect would just never fire for them again), and
    // the post-event payout celebration would have no real schedule to
    // show.
    if (!profile?.stripeConnectAccountId || (profile?.payoutsEnabled && profile?.payoutSchedule)) return;
    const handleVisibility = async () => {
      if (document.visibilityState !== "visible") return;
      setCheckingPayouts(true);
      try {
        const checkStatus = httpsCallable(functions, "checkPayoutsStatus");
        await checkStatus();
      } catch (err) {
        console.error("checkPayoutsStatus failed:", err);
      } finally {
        setCheckingPayouts(false);
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, [profile?.stripeConnectAccountId, profile?.payoutsEnabled, profile?.payoutSchedule]);

  const { fields: allFields, fieldsLoading: allFieldsLoading } = useAllFields();
  const { fields: myFields, fieldsLoading: myFieldsLoading } = useMyFields(user?.uid);
  const { fields: pendingFields, pendingLoading } = useMyPendingClaims(user?.uid);
  const { claimField, requestClaimCode, verifyWebsiteClaim, requestEmailClaim, verifyEmailClaim, updateFieldProfile } = useFieldActions();

  const [activeTab, setActiveTab] = useState("dashboard"); // dashboard | events | analytics | roster | settings
  const [overlay, setOverlay] = useState(null); // null | claim | field | eventEdit | roster
  const [activeFieldId, setActiveFieldId] = useState(null);
  const [editingEvent, setEditingEvent] = useState(null); // null = new event
  const [rosterEvent, setRosterEvent] = useState(null);
  // Venue mode = the event editor in organizer form (typed-in venue, no
  // claimed field). Only meaningful for NEW events; an existing event's mode
  // comes from its own isMajor flag (fieldId/isMajor never change after create).
  const [newEventVenue, setNewEventVenue] = useState(false);

  const activeField = myFields.find((f) => f.id === activeFieldId) || allFields.find((f) => f.id === activeFieldId);
  const myFieldIds = myFields.map((f) => f.id);
  // Passing the uid always: organizer events (hostOwnerId == uid) are merged
  // in with field events. A field-only account simply matches none.
  const { events: allMyEvents, eventsLoading: allMyEventsLoading } = useOwnerEvents(myFieldIds, user?.uid);
  const { createEvent, createMajorEvent, updateEvent, deleteEvent, restoreEvent, duplicateEvent, newEventId } = useOwnerEventActions();
  const { activity, totalSignatures, activityLoading } = useRecentActivity(myFieldIds, user?.uid);
  const { banned, bannedLoading } = useBannedPlayers(rosterEvent?.fieldId);
  const { banPlayer, unbanPlayer } = useBanActions();

  // Role tailoring (UX only — never used for permissions or fees; the server
  // decides those from field ownership / the event's own hostOwnerId+isMajor).
  // Field owner = said so, or actually owns a field. Organizer = said so.
  const hasFields = myFields.length > 0;
  const isFieldOwner = !!profile?.accountRoles?.fieldOwner || hasFields;
  const isOrganizer = profile?.accountRoles?.organizer === true;
  // Still working out whether this account needs the picker (don't flash it
  // at an existing owner whose fields haven't loaded yet).
  const rolesUndetermined = !!profile && !profile.accountRoles && (myFieldsLoading || pendingLoading);
  const needsRolePicker = !!profile && !profile.accountRoles && !hasFields && pendingFields.length === 0 && !myFieldsLoading && !pendingLoading;
  // Organizer-only accounts don't owe the field-owner agreement. Anyone not
  // clearly organizer-only keeps the original gate, so existing owners see
  // exactly what they saw before.
  const organizerOnly = isOrganizer && !isFieldOwner;
  const needsFieldTerms = !organizerOnly && profile?.acceptedTermsVersion !== CURRENT_TERMS_VERSION;
  const needsOrganizerTerms = isOrganizer && profile?.acceptedOrganizerTermsVersion !== ORGANIZER_TERMS_VERSION;

  const openField = (fieldId) => { setActiveFieldId(fieldId); setOverlay("field"); };
  const openClaim = () => setOverlay("claim");
  // `field` is null for organizer (Major) events, which have no claimed field.
  const openEventEdit = (field, ev) => { setActiveFieldId(field ? field.id : null); setEditingEvent(ev || null); setNewEventVenue(false); setOverlay("eventEdit"); };
  const openVenueEventEdit = () => { setActiveFieldId(null); setEditingEvent(null); setNewEventVenue(true); setOverlay("eventEdit"); };
  const openEventOverview = (field, ev) => { setActiveFieldId(field ? field.id : null); setEditingEvent(ev); setOverlay("eventOverview"); };
  // One entry point for every "create event" button.
  //  - field owner only → straight into their field (unchanged behavior)
  //  - organizer only   → venue form
  //  - organizer who also owns a field → ask which
  //  - neither yet      → claim a field (unchanged behavior)
  const startNewEvent = () => {
    if (isOrganizer && hasFields) setOverlay("newEventChoice");
    else if (isOrganizer) openVenueEventEdit();
    else if (hasFields) openEventEdit(myFields[0], null);
    else openClaim();
  };
  const openRoster = (ev) => { setRosterEvent(ev); setOverlay("roster"); };
  const openCheckIn = () => setOverlay("checkIn");
  const closeOverlay = () => setOverlay(null);

  const handleLogout = async () => {
    await signOut();
    setActiveTab("dashboard");
    setOverlay(null);
  };

  if (installGate === null) {
    return null; // brief instant while the install check resolves — nothing flashes before it
  }
  if (installGate) {
    return <InstallGateScreen platform={installGate} deferredPrompt={deferredInstallPrompt} />;
  }

  if (authLoading) {
    return <LoadingScreen />;
  }

  let content;
  let showNav = false;

  if (!user) {
    content = <LoginScreen signIn={signIn} signUp={signUp} />;
  } else if (!profile) {
    content = <LoadingScreen />;
  } else if (rolesUndetermined) {
    content = <LoadingScreen />;
  } else if (needsRolePicker) {
    content = <RoleSelectionScreen onSave={setAccountRoles} onLogout={handleLogout} />;
  } else if (needsFieldTerms) {
    content = <LegalAgreementScreen key="field" kind="field" onAccept={() => acceptTerms(CURRENT_TERMS_VERSION)} />;
  } else if (needsOrganizerTerms) {
    content = <LegalAgreementScreen key="organizer" kind="organizer" onAccept={() => acceptOrganizerTerms(ORGANIZER_TERMS_VERSION)} />;
  } else if (myFields.length > 0 && !profile.comped && !profile.feeModel) {
    // A real gate, not just a Settings entry — once an owner has actually
    // claimed a field (not before; claiming itself always stays open),
    // they can't go any further without choosing a fee model. Reuses the
    // exact same FeeModelScreen used from Settings — no onBack here is
    // what turns it from an optional page into a hard block.
    content = <FeeModelScreen profile={profile} user={user} />;
  } else if (overlay === "claim") {
    content = (
      <ClaimFieldScreen
        onBack={closeOverlay}
        allFields={allFields}
        allFieldsLoading={allFieldsLoading}
        ownerId={user.uid}
        ownerEmail={user.email}
        claimField={claimField}
        requestClaimCode={requestClaimCode}
        verifyWebsiteClaim={verifyWebsiteClaim}
        requestEmailClaim={requestEmailClaim}
        verifyEmailClaim={verifyEmailClaim}
        onClaimed={(fieldId) => { setActiveFieldId(fieldId); setOverlay("claimWelcome"); }}
      />
    );
  } else if (overlay === "billing") {
    content = <FeeModelScreen profile={profile} user={user} onBack={closeOverlay} />;
  } else if (overlay === "payouts") {
    content = <PayoutsScreen profile={profile} onBack={closeOverlay} checking={checkingPayouts} />;
  } else if (overlay === "yearInReview") {
    content = <OwnerYearInReviewScreen onBack={closeOverlay} events={allMyEvents} year={reviewYear()} />;
  } else if (overlay === "claimWelcome" && activeField) {
    content = (
      <ClaimWelcomeScreen
        fieldName={activeField.name}
        onContinue={() => setOverlay("field")}
      />
    );
  } else if (overlay === "field" && activeField) {
    content = (
      <FieldOverviewScreen
        field={activeField}
        events={allMyEvents}
        eventsLoading={allMyEventsLoading}
        onBack={closeOverlay}
        onEdit={() => setOverlay("fieldEdit")}
        onOpenEvent={(ev) => openEventOverview(activeField, ev)}
        onCreateEvent={(field) => openEventEdit(field, null)}
      />
    );
  } else if (overlay === "fieldEdit" && activeField) {
    content = (
      <FieldManageScreen
        field={activeField}
        onBack={() => setOverlay("field")}
        updateFieldProfile={updateFieldProfile}
        onOpenEvents={() => { closeOverlay(); setActiveTab("events"); }}
      />
    );
  } else if (overlay === "newEventChoice") {
    content = (
      <NewEventChoiceScreen
        myFields={myFields}
        onBack={closeOverlay}
        onPickField={(f) => openEventEdit(f, null)}
        onPickVenue={openVenueEventEdit}
      />
    );
  } else if (overlay === "eventOverview" && editingEvent && (activeField || editingEvent.isMajor)) {
    content = (
      <EventOverviewScreen
        ev={editingEvent}
        onBack={closeOverlay}
        onEdit={() => openEventEdit(editingEvent.isMajor ? null : activeField, editingEvent)}
        onOpenRoster={openRoster}
        allMyEvents={allMyEvents}
      />
    );
  } else if (overlay === "eventEdit" && (activeField || (editingEvent ? editingEvent.isMajor : newEventVenue))) {
    const venueMode = editingEvent ? !!editingEvent.isMajor : newEventVenue;
    content = (
      <EventEditScreen
        key={editingEvent?.id || (venueMode ? "new-venue" : "new-field")}
        field={venueMode ? null : activeField}
        venueMode={venueMode}
        ownerUid={user.uid}
        payoutsEnabled={!!profile.payoutsEnabled}
        existing={editingEvent}
        onBack={closeOverlay}
        createEvent={createEvent}
        createMajorEvent={createMajorEvent}
        updateEvent={updateEvent}
        newEventId={newEventId}
        allFields={allFields}
      />
    );
  } else if (overlay === "roster" && rosterEvent) {
    content = (
      <RosterScreen
        event={rosterEvent}
        onBack={closeOverlay}
        onOpenCheckIn={openCheckIn}
        banned={banned}
        bannedLoading={bannedLoading}
        banPlayer={banPlayer}
        unbanPlayer={unbanPlayer}
        profile={profile}
      />
    );
  } else if (overlay === "checkIn" && rosterEvent) {
    content = <CheckInScreen event={rosterEvent} onBack={() => setOverlay("roster")} />;
  } else {
    showNav = true;
    if (activeTab === "events") {
      content = (
        <EventsHubScreen
          myFields={myFields}
          events={allMyEvents}
          eventsLoading={allMyEventsLoading}
          isFieldOwner={isFieldOwner}
          isOrganizer={isOrganizer}
          onNewEvent={(field) => (field ? openEventEdit(field, null) : startNewEvent())}
          onStartNewEvent={startNewEvent}
          onClaimField={openClaim}
          onEditEvent={openEventEdit}
          onOpenOverview={openEventOverview}
          onOpenRoster={openRoster}
          deleteEvent={deleteEvent}
          restoreEvent={restoreEvent}
          duplicateEvent={duplicateEvent}
          updateEvent={updateEvent}
          profile={profile}
        />
      );
    } else if (activeTab === "analytics") {
      content = (
        <AnalyticsScreen
          events={allMyEvents}
          eventsLoading={allMyEventsLoading}
          totalSignatures={totalSignatures}
          activityLoading={activityLoading}
          myFields={myFields}
        />
      );
    } else if (activeTab === "roster") {
      content = <RosterHubScreen events={allMyEvents} eventsLoading={allMyEventsLoading} onOpenRoster={openRoster} />;
    } else if (activeTab === "settings") {
      content = (
        <SettingsScreen
          profile={profile}
          user={user}
          updateOwnerName={updateOwnerName}
          changePassword={changePassword}
          deleteAccount={deleteAccount}
          setAccountRoles={setAccountRoles}
          isFieldOwner={isFieldOwner}
          isOrganizer={isOrganizer}
          hasFields={hasFields}
          onOpenBilling={() => setOverlay("billing")}
          onOpenPayouts={() => setOverlay("payouts")}
          onOpenYearInReview={() => setOverlay("yearInReview")}
          onLogout={handleLogout}
        />
      );
    } else {
      content = (
        <DashboardScreen
          profile={profile}
          myFields={myFields}
          myFieldsLoading={myFieldsLoading}
          pendingFields={pendingFields}
          pendingLoading={pendingLoading}
          events={allMyEvents}
          eventsLoading={allMyEventsLoading}
          activity={activity}
          activityLoading={activityLoading}
          onOpenField={openField}
          onOpenClaim={openClaim}
          onOpenPayouts={() => setOverlay("payouts")}
          onOpenBilling={() => setOverlay("billing")}
          onOpenYearInReview={() => setOverlay("yearInReview")}
          onOpenEventsList={() => setActiveTab("events")}
          isFieldOwner={isFieldOwner}
          isOrganizer={isOrganizer}
          onCreateEvent={startNewEvent}
          onOpenEvent={(ev) => openEventOverview(ev.isMajor ? null : (myFields.find((f) => f.id === ev.fieldId) || myFields[0]), ev)}
          onLogout={handleLogout}
        />
      );
    }
  }

  return (
    <div
      className="w-full flex flex-col app-shell-height"
      style={{ background: T.void }}
    >
      <style>{FONTS}</style>
      <div className="flex-1 min-h-0 relative">
        {content}
        {showNav && <OwnerBottomNav active={activeTab} onNavigate={setActiveTab} />}
        {needRefresh && <UpdateAvailableToast onRefresh={refreshNow} />}
      </div>
    </div>
  );
}
