import React, { useState, useEffect, useRef } from "react";
import {
  Shield, LogOut, ChevronLeft, ChevronRight, Search, Plus, Trash2, Check, Ban,
  ArrowRight, Calendar, MapPin, Copy, FileSignature, Image as ImageIcon, TrendingUp,
  Settings, Users, LayoutDashboard, Pencil, QrCode, X,
} from "lucide-react";
import QRCode from "qrcode";
import { useOwnerAuth } from "./hooks/useOwnerAuth";
import { CURRENT_TERMS_VERSION, TERMS_OF_USE, PRIVACY_POLICY, EULA } from "./legalText";
import { useAllFields, useMyFields, useMyPendingClaims, useFieldActions, useBannedPlayers, useBanActions } from "./hooks/useOwnerFields";
import { useOwnerEvents, useOwnerEventActions } from "./hooks/useOwnerEvents";
import { useEventWaivers, useRecentActivity } from "./hooks/useEventWaivers";
import { useEventBookings, checkInFromScan, checkInPlayer } from "./hooks/useEventBookings";
import { db, storage, functions } from "./lib/firebase";
import { httpsCallable } from "firebase/functions";
import { collection, getDocs, query, serverTimestamp, where } from "firebase/firestore";
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

function displayPrice(price) {
  if (!price) return price;
  const trimmed = String(price).trim();
  return /^\d/.test(trimmed) ? `$${trimmed}` : trimmed;
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

function TextField({ label, value, onChange, placeholder, type = "text", rows }) {
  const Tag = rows ? "textarea" : "input";
  // Native date/time widgets render their internal segments (day/month/
  // year, hour/minute/AM-PM) at a size proportional to font-size — on some
  // mobile browsers that internal rendering can ignore width constraints
  // on the input itself entirely, so a smaller font is the one thing that
  // actually shrinks what the browser draws, not just what CSS allows.
  const isDateOrTime = type === "date" || type === "time";
  return (
    <div className="mb-3">
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
          borderRadius: 4,
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
        }}
      />
    </div>
  );
}

function PrimaryButton({ children, onClick, disabled, tone = "ash" }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="w-full py-3 font-semibold text-[14px]"
      style={{ ...display, background: T[tone], color: "#FFFFFF", borderRadius: 4, opacity: disabled ? 0.5 : 1 }}
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
        <span className="text-lg font-semibold" style={{ ...display, color: T.ash, letterSpacing: "0.1em" }}>ATLAS FOR FIELD OWNERS</span>
      </div>

      <form onSubmit={handleSubmit}>
        {mode === "signup" && (
          <TextField label="Your Name" value={name} onChange={setName} placeholder="Full name" />
        )}
        <TextField label="Email" value={email} onChange={setEmail} placeholder="you@field.com" type="email" />
        <TextField label="Password" value={password} onChange={setPassword} placeholder="••••••••" type="password" />
        {error && <p className="text-[12px] mb-3" style={{ ...body, color: T.alert }}>{error}</p>}
        <button
          type="submit"
          disabled={busy}
          className="w-full py-3.5 font-semibold text-[14px] flex items-center justify-center gap-2 mt-2"
          style={{ ...display, background: T.ash, color: "#FFFFFF", borderRadius: 4, opacity: busy ? 0.6 : 1 }}
        >
          {busy ? "Please wait…" : mode === "signup" ? "Create Account" : "Sign In"} <ArrowRight size={16} />
        </button>
      </form>

      <button
        onClick={() => { setMode(mode === "signin" ? "signup" : "signin"); setError(""); }}
        className="text-center text-[13px] mt-4"
        style={{ ...body, color: T.accent }}
      >
        {mode === "signin" ? "New field owner? Create an account" : "Already have an account? Sign in"}
      </button>
    </div>
  );
}

/* ---------- Dashboard ---------- */
function DashboardScreen({ profile, myFields, myFieldsLoading, pendingFields, pendingLoading, events, eventsLoading, activity, activityLoading, onOpenField, onOpenClaim, onOpenEventsList, onCreateEvent, onOpenEvent, onOpenPayouts, onLogout }) {
  const today = localDateStr();
  const upcoming = events.filter((e) => !e.draft && e.date >= today).sort((a, b) => a.date.localeCompare(b.date));
  const totalInterest = events.reduce((sum, e) => sum + (e.interestCount || 0), 0);
  // Highest-level rollup — every upcoming, non-canceled, published event
  // across every field this owner manages, not just one field or event.
  const totalProjectedRevenue = upcoming.reduce((sum, e) => {
    if (e.canceled) return sum;
    const p = parsePrice(e.price);
    const cap = typeof e.maxCapacity === "number" ? e.maxCapacity : parseInt(e.maxCapacity, 10);
    return sum + (p && cap ? p * cap : 0);
  }, 0);

  return (
    <div className="h-full overflow-y-auto pb-24" style={flatBg}>
      <div className="px-6 pt-6 pb-4 flex items-center justify-between">
        <div>
          <div className="text-[12px]" style={{ ...body, color: T.ashDim }}>Welcome back,</div>
          <div className="text-[20px] font-semibold" style={{ ...display, color: T.ash }}>{profile?.name || "Owner"}</div>
        </div>
        <button onClick={onLogout} className="w-9 h-9 flex items-center justify-center" style={{ background: T.panel, border: `1px solid ${T.line}`, borderRadius: 4 }}>
          <LogOut size={16} color={T.ashDim} />
        </button>
      </div>

      <div className="px-6">
        {myFields.length > 0 && !profile?.payoutsEnabled && (
          <button
            onClick={onOpenPayouts}
            className="w-full mb-5 p-4 flex items-center gap-3 text-left"
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
                <div key={f.id} className="p-3 flex items-center gap-3" style={{ background: T.panel, borderRadius: 6, border: `1px solid ${T.accent}` }}>
                  <div className="flex-1">
                    <div className="text-[13px] font-semibold" style={{ ...display, color: T.ash }}>{f.name}</div>
                    <div className="text-[11px]" style={{ ...body, color: T.ashFaint }}>Awaiting manual review — no website on file to verify against</div>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        {myFields.length > 0 && (
          <>
            <Eyebrow>Overview</Eyebrow>
            <div className="grid grid-cols-2 gap-3 mb-5">
              <div className="p-4" style={{ background: T.panel, borderRadius: 6, border: `1px solid ${T.line}` }}>
                <div className="flex items-center gap-1.5 mb-1">
                  <Calendar size={13} color={T.ashFaint} />
                  <span className="text-[10px] font-semibold uppercase" style={{ ...mono, color: T.ashFaint, letterSpacing: "0.04em" }}>Upcoming</span>
                </div>
                <div className="text-[22px] font-semibold" style={{ ...display, color: T.ash }}>{eventsLoading ? "…" : upcoming.length}</div>
              </div>
              <div className="p-4" style={{ background: T.panel, borderRadius: 6, border: `1px solid ${T.line}` }}>
                <div className="flex items-center gap-1.5 mb-1">
                  <TrendingUp size={13} color={T.ashFaint} />
                  <span className="text-[10px] font-semibold uppercase" style={{ ...mono, color: T.ashFaint, letterSpacing: "0.04em" }}>Total Interest</span>
                </div>
                <div className="text-[22px] font-semibold" style={{ ...display, color: T.ash }}>{eventsLoading ? "…" : totalInterest}</div>
                <div className="text-[9px] mt-0.5" style={{ ...body, color: T.ashFaint }}>Players who favorited your events — not confirmed bookings</div>
              </div>
            </div>

            {!eventsLoading && totalProjectedRevenue > 0 && (
              <div className="p-4 mb-5" style={{ background: T.panel, borderRadius: 6, border: `1px solid ${T.line}` }}>
                <div className="flex items-center gap-1.5 mb-1">
                  <TrendingUp size={13} color={T.ashFaint} />
                  <span className="text-[10px] font-semibold uppercase" style={{ ...mono, color: T.ashFaint, letterSpacing: "0.04em" }}>Projected Revenue (Gross, Upcoming)</span>
                </div>
                <div className="text-[22px] font-semibold" style={{ ...display, color: T.accent }}>${totalProjectedRevenue.toFixed(2)}</div>
                <div className="text-[9px] mt-0.5" style={{ ...body, color: T.ashFaint }}>Summed across every upcoming event at full capacity, across all your fields — not a real payment yet</div>
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
              <button onClick={onOpenEventsList} className="text-[11px] font-medium" style={{ ...body, color: T.accent }}>View All</button>
            </div>
            <div className="mb-5 flex flex-col gap-2">
              {upcoming.slice(0, 3).map((ev) => (
                <button key={ev.id} onClick={() => onOpenEvent(ev)} className="p-3 flex items-center justify-between text-left" style={{ background: T.panel, borderRadius: 6, border: `1px solid ${T.line}` }}>
                  <div>
                    <div className="text-[13px] font-semibold" style={{ ...display, color: T.ash }}>{ev.title}</div>
                    <div className="text-[11px]" style={{ ...body, color: T.ashFaint }}>{ev.fieldName} — {ev.date}</div>
                  </div>
                  <div className="text-right">
                    {typeof ev.maxCapacity === "number" && (
                      <div className="text-[12px] font-semibold" style={{ ...mono, color: T.good }}>{ev.bookedCount || 0} / {ev.maxCapacity} booked</div>
                    )}
                    {ev.interestCount > 0 && (
                      <span className="text-[10px]" style={{ ...mono, color: T.ashFaint }}>{ev.interestCount} interested</span>
                    )}
                  </div>
                </button>
              ))}
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
                  <div key={i} className="p-3 flex items-center gap-2" style={{ background: T.panel, borderRadius: 6, border: `1px solid ${T.line}` }}>
                    <FileSignature size={14} color={T.good} />
                    <div className="text-[12px]" style={{ ...body, color: T.ashDim }}>
                      <span style={{ fontWeight: 600, color: T.ash }}>{a.signedName}</span> signed the waiver for {ev?.title || "an event"}
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}

        <div className="mb-4 flex items-center justify-between">
          <Eyebrow>My Fields</Eyebrow>
          <button onClick={onOpenClaim} className="text-[12px] font-semibold" style={{ ...body, color: T.accent }}>
            + Claim a Field
          </button>
        </div>

        {myFieldsLoading ? (
          <div className="text-[13px] py-6 text-center" style={{ ...body, color: T.ashFaint }}>Loading…</div>
        ) : myFields.length === 0 ? (
          <div className="p-6 flex flex-col items-center text-center" style={{ background: T.panel, borderRadius: 6, border: `1px solid ${T.line}` }}>
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
              className="w-full mb-3 p-4 flex items-center gap-3 text-left"
              style={{ background: T.panel, borderRadius: 6, border: `1px solid ${T.line}` }}
            >
              <div className="flex-1">
                <div className="text-[15px] font-semibold" style={{ ...display, color: T.ash }}>{f.name}</div>
                <div className="text-[12px]" style={{ ...body, color: T.ashFaint }}>{f.city}</div>
              </div>
              <ChevronRight size={16} color={T.ashFaint} />
            </button>
          ))
        )}
      </div>
    </div>
  );
}

/* ---------- Claim a field ---------- */
function ClaimFieldScreen({ onBack, allFields, allFieldsLoading, ownerId, ownerEmail, claimField, onClaimed }) {
  const [search, setSearch] = useState("");
  const [claimingId, setClaimingId] = useState(null);
  const [error, setError] = useState("");
  const [pendingMsg, setPendingMsg] = useState("");

  const filtered = allFields.filter((f) => f.name.toLowerCase().includes(search.toLowerCase()));

  const handleClaim = async (field) => {
    setClaimingId(field.id);
    setError("");
    setPendingMsg("");
    try {
      const result = await claimField(field, ownerEmail, ownerId);
      if (result === "claimed") {
        onClaimed(field.id);
      } else {
        setPendingMsg(`Claim request submitted for ${field.name} — this field has no verifiable website on file, so it needs manual review before you get full access.`);
      }
    } catch (err) {
      setError(err.message || "Couldn't claim that field — try again.");
    } finally {
      setClaimingId(null);
    }
  };

  return (
    <div className="h-full overflow-y-auto pb-24" style={flatBg}>
      <div className="px-6 pt-2 pb-4 flex items-center" style={{ borderBottom: `1px solid ${T.line}` }}>
        <button onClick={onBack} className="w-9 h-9 -ml-2 flex items-center justify-center">
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
            placeholder="Search by field name"
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
              <div key={f.id} className="mb-3 p-4 flex items-center gap-3" style={{ background: T.panel, borderRadius: 6, border: `1px solid ${T.line}` }}>
                <div className="flex-1">
                  <div className="text-[14px] font-semibold" style={{ ...display, color: T.ash }}>{f.name}</div>
                  <div className="text-[12px]" style={{ ...body, color: T.ashFaint }}>{f.city}</div>
                  {!isClaimed && !isPending && (
                    <div className="text-[10px] mt-0.5" style={{ ...body, color: T.ashFaint }}>
                      {f.ownerEmailDomain ? `Verified instantly with an @${f.ownerEmailDomain} email` : "No website on file — claim goes to manual review"}
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
                    className="px-3 py-2 text-[12px] font-semibold flex-shrink-0"
                    style={{ ...display, background: T.ash, color: "#FFFFFF", borderRadius: 4, opacity: claimingId === f.id ? 0.6 : 1 }}
                  >
                    {claimingId === f.id ? "…" : "Claim"}
                  </button>
                )}
              </div>
            );
          })
        )}
      </div>
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

  const fieldEvents = events.filter((e) => e.fieldId === field.id);
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
        <button onClick={onBack} className="w-9 h-9 -ml-2 flex items-center justify-center">
          <ChevronLeft size={20} color={T.ash} />
        </button>
        <h1 className="flex-1 text-center text-[16px] font-semibold truncate px-2" style={{ ...display, color: T.ash }}>{field.name}</h1>
        <button onClick={onEdit} className="w-9 h-9 flex items-center justify-center">
          <Pencil size={16} color={T.ash} />
        </button>
      </div>

      <div className="px-6 pt-4">
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

        <div className="grid grid-cols-3 gap-2 mb-5">
          <div className="p-3 text-center" style={{ background: T.panel, borderRadius: 6, border: `1px solid ${T.line}` }}>
            <div className="text-[18px] font-semibold" style={{ ...display, color: T.ash }}>{eventsLoading ? "…" : upcoming.length}</div>
            <div className="text-[10px]" style={{ ...body, color: T.ashFaint }}>Upcoming</div>
          </div>
          <div className="p-3 text-center" style={{ background: T.panel, borderRadius: 6, border: `1px solid ${T.line}` }}>
            <div className="text-[18px] font-semibold" style={{ ...display, color: T.good }}>{eventsLoading ? "…" : totalBooked}</div>
            <div className="text-[10px]" style={{ ...body, color: T.ashFaint }}>Booked</div>
          </div>
          <div className="p-3 text-center" style={{ background: T.panel, borderRadius: 6, border: `1px solid ${T.line}` }}>
            <div className="text-[18px] font-semibold" style={{ ...display, color: T.ash }}>{eventsLoading ? "…" : totalInterest}</div>
            <div className="text-[10px]" style={{ ...body, color: T.ashFaint }}>Interested</div>
          </div>
        </div>

        {!eventsLoading && totalProjectedRevenue > 0 && (
          <div className="p-3 mb-5" style={{ background: T.panel, borderRadius: 6, border: `1px solid ${T.line}` }}>
            <div className="text-[12px]" style={{ ...body, color: T.ashDim }}>
              Projected Revenue (Gross, Upcoming): <span style={{ fontWeight: 600, color: T.accent }}>${totalProjectedRevenue.toFixed(2)}</span> — summed across this field's upcoming events at full capacity, not a real payment yet
            </div>
          </div>
        )}

        <div className="flex items-center justify-between mb-2">
          <Eyebrow>Upcoming Events</Eyebrow>
          <button onClick={() => onCreateEvent(field)} className="text-[12px] font-semibold" style={{ ...body, color: T.accent }}>+ New Event</button>
        </div>
        {eventsLoading ? (
          <p className="text-[13px] py-4 text-center" style={{ ...body, color: T.ashFaint }}>Loading…</p>
        ) : upcoming.length === 0 ? (
          <p className="text-[12px] mb-5" style={{ ...body, color: T.ashFaint }}>No upcoming published events.</p>
        ) : (
          <div className="flex flex-col gap-2 mb-5">
            {upcoming.map((ev) => (
              <button key={ev.id} onClick={() => onOpenEvent(ev)} className="p-3 flex items-center justify-between text-left" style={{ background: T.panel, borderRadius: 6, border: `1px solid ${T.line}` }}>
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
              <button onClick={handleShowDtbQr} className="w-full py-3 flex items-center justify-center gap-2" style={{ background: T.panel, borderRadius: 6, border: `1px solid ${T.line}` }}>
                <QrCode size={16} color={T.ashDim} />
                <span className="text-[13px] font-medium" style={{ ...body, color: T.ash }}>Show DTB QR</span>
              </button>
            ) : (
              <div className="p-4 flex flex-col items-center" style={{ background: T.panel, borderRadius: 6, border: `1px solid ${T.line}` }}>
                <button onClick={() => setShowDtbQr(false)} className="self-end -mt-1 -mr-1 w-7 h-7 flex items-center justify-center">
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
  const [chronoAeg, setChronoAeg] = useState(field.chrono?.aeg || "");
  const [chronoSniper, setChronoSniper] = useState(field.chrono?.sniper || "");
  const [chronoDmr, setChronoDmr] = useState(field.chrono?.dmr || "");
  const [rentals, setRentals] = useState(field.rentals || []);
  const [savedWaivers, setSavedWaivers] = useState(field.savedWaivers || []);
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
    city: (field.city || "").split(",")[0]?.trim() || "", state: (field.city || "").split(",")[1]?.trim() || "",
    phone: field.phone || "", email: field.email || "", website: field.website || "",
    about: field.about || "", amenities: field.amenities || [],
    rulesText: (field.rules || []).join("\n"), chronoAeg: field.chrono?.aeg || "",
    chronoSniper: field.chrono?.sniper || "", chronoDmr: field.chrono?.dmr || "", rentals: field.rentals || [],
    savedWaivers: field.savedWaivers || [],
  });
  const hasChanges =
    imageUrl !== snapshot.imageUrl || name !== snapshot.name || address !== snapshot.address ||
    city !== snapshot.city || state !== snapshot.state ||
    phone !== snapshot.phone || email !== snapshot.email || website !== snapshot.website ||
    about !== snapshot.about ||
    JSON.stringify(amenities) !== JSON.stringify(snapshot.amenities) ||
    rulesText !== snapshot.rulesText || chronoAeg !== snapshot.chronoAeg ||
    chronoSniper !== snapshot.chronoSniper || chronoDmr !== snapshot.chronoDmr ||
    JSON.stringify(rentals) !== JSON.stringify(snapshot.rentals) ||
    JSON.stringify(savedWaivers) !== JSON.stringify(snapshot.savedWaivers);

  const toggleAmenity = (a) => {
    setAmenities(amenities.includes(a) ? amenities.filter((x) => x !== a) : [...amenities, a]);
  };
  const addCustomAmenity = () => {
    const val = customAmenity.trim();
    if (val && !amenities.includes(val)) setAmenities([...amenities, val]);
    setCustomAmenity("");
  };
  const removeAmenity = (a) => setAmenities(amenities.filter((x) => x !== a));

  const addRental = () => setRentals([...rentals, { name: "", price: "", includes: "", availability: "" }]);
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
      const chrono = (chronoAeg || chronoSniper || chronoDmr) ? { aeg: chronoAeg, sniper: chronoSniper, dmr: chronoDmr } : null;
      const cleanRentals = rentals.filter((r) => r.name.trim());
      const combinedCity = state.trim() ? `${city.trim()}, ${state.trim()}` : city.trim();
      await updateFieldProfile(field.id, {
        name, address, city: combinedCity, phone, email, website, about, amenities, rules, chrono, rentals: cleanRentals, imageUrl,
        // Explicitly cleared, not just omitted — hours are per-event now,
        // not per-field, so this actively wipes any stale value already
        // sitting on a field's document rather than leaving it dangling.
        hours: null,
        savedWaivers: savedWaivers.filter((w) => w.name.trim() && w.text.trim()),
      });
      setSnapshot({ imageUrl, name, address, city, state, phone, email, website, about, amenities, rulesText, chronoAeg, chronoSniper, chronoDmr, rentals, savedWaivers });
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
        <button onClick={onBack} className="w-9 h-9 -ml-2 flex items-center justify-center">
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
          className="w-full h-32 mb-5 flex flex-col items-center justify-center gap-1 overflow-hidden"
          style={{ background: T.panelAlt, border: `1px dashed ${T.line}`, borderRadius: 6 }}
        >
          {imageUrl ? (
            <img src={imageUrl} alt="" className="w-full h-full" style={{ objectFit: "cover" }} />
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
          className="w-full mb-5 p-4 flex items-center gap-3 text-left"
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
        <TextField label="About" value={about} onChange={setAbout} rows={4} placeholder="Tell players about your field — atmosphere, general hours, what to expect…" />

        <Eyebrow>Field Amenities</Eyebrow>
        <div className="flex flex-wrap gap-2 mb-2">
          {PRESET_AMENITIES.map((a) => {
            const active = amenities.includes(a);
            return (
              <button
                key={a}
                onClick={() => toggleAmenity(a)}
                className="px-3 py-1.5 text-[12px] font-medium flex items-center gap-1"
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
              className="px-3 py-1.5 text-[12px] font-medium flex items-center gap-1"
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
          <button onClick={addCustomAmenity} className="px-3 py-2 text-[12px] font-semibold" style={{ ...body, border: `1px solid ${T.line}`, color: T.ashDim, borderRadius: 4 }}>
            Add
          </button>
        </div>

        <Eyebrow>Venue Gallery Photos</Eyebrow>
        <div className="flex flex-wrap gap-2 mb-4">
          {gallery.map((g) => (
            <div key={g.url} className="relative w-20 h-20">
              <img src={g.url} alt="" className="w-full h-full" style={{ objectFit: "cover", borderRadius: 4 }} />
              <button onClick={() => removeGalleryPhoto(g)} className="absolute -top-1.5 -right-1.5 w-5 h-5 flex items-center justify-center" style={{ background: T.alert, borderRadius: 999 }}>
                <span style={{ color: "#fff", fontSize: 11, lineHeight: 1 }}>×</span>
              </button>
            </div>
          ))}
          <input ref={galleryInputRef} type="file" accept="image/*" onChange={handleGallerySelected} className="hidden" />
          <button
            onClick={handleGalleryPick}
            disabled={galleryUploading}
            className="w-20 h-20 flex flex-col items-center justify-center gap-1"
            style={{ background: T.panelAlt, border: `1px dashed ${T.line}`, borderRadius: 4 }}
          >
            <ImageIcon size={16} color={T.ashDim} />
            <span className="text-[9px]" style={{ ...body, color: T.ashFaint }}>{galleryUploading ? "…" : "Add Photo"}</span>
          </button>
        </div>

        <Eyebrow>Field Rules (one per line)</Eyebrow>
        <TextField value={rulesText} onChange={setRulesText} rows={5} placeholder="Full-seal eye protection required at all times…" />

        <div className="mb-1">
          <label className="text-[10px] font-semibold uppercase block mb-1" style={{ ...mono, color: T.ashFaint, letterSpacing: "0.04em" }}>Chrono Limits</label>
        </div>
        <div className="grid grid-cols-1 gap-2 mb-3">
          <input value={chronoAeg} onChange={(e) => setChronoAeg(e.target.value)} placeholder="AEG — e.g. 400 FPS max (0.20g)"
            className="w-full px-3 py-2.5 text-[13px] bg-transparent outline-none" style={{ ...body, background: T.panelAlt, border: `1px solid ${T.line}`, borderRadius: 4, color: T.ash }} />
          <input value={chronoSniper} onChange={(e) => setChronoSniper(e.target.value)} placeholder="Sniper — e.g. 500 FPS max (0.20g)"
            className="w-full px-3 py-2.5 text-[13px] bg-transparent outline-none" style={{ ...body, background: T.panelAlt, border: `1px solid ${T.line}`, borderRadius: 4, color: T.ash }} />
          <input value={chronoDmr} onChange={(e) => setChronoDmr(e.target.value)} placeholder="DMR — optional"
            className="w-full px-3 py-2.5 text-[13px] bg-transparent outline-none" style={{ ...body, background: T.panelAlt, border: `1px solid ${T.line}`, borderRadius: 4, color: T.ash }} />
        </div>

        <div className="mb-2 flex items-center justify-between">
          <label className="text-[10px] font-semibold uppercase" style={{ ...mono, color: T.ashFaint, letterSpacing: "0.04em" }}>Rental Gear</label>
          <button onClick={addRental} className="text-[12px] font-semibold" style={{ ...body, color: T.accent }}>+ Add Item</button>
        </div>
        {rentals.map((r, i) => (
          <div key={i} className="mb-3 p-3" style={{ background: T.panel, border: `1px solid ${T.line}`, borderRadius: 6 }}>
            <div className="flex gap-2 mb-2">
              <input value={r.name} onChange={(e) => updateRental(i, "name", e.target.value)} placeholder="Item name"
                className="flex-1 px-2.5 py-2 text-[13px] bg-transparent outline-none" style={{ ...body, background: T.panelAlt, border: `1px solid ${T.line}`, borderRadius: 4, color: T.ash }} />
              <input value={r.price} onChange={(e) => updateRental(i, "price", e.target.value)} placeholder="$30"
                className="w-20 px-2.5 py-2 text-[13px] bg-transparent outline-none" style={{ ...body, background: T.panelAlt, border: `1px solid ${T.line}`, borderRadius: 4, color: T.ash }} />
              <button onClick={() => removeRental(i)} className="w-9 h-9 flex-shrink-0 flex items-center justify-center" style={{ background: T.panelAlt, borderRadius: 4 }}>
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
          <button onClick={addSavedWaiver} className="text-[12px] font-semibold" style={{ ...body, color: T.accent }}>+ Add Waiver</button>
        </div>
        <p className="text-[11px] mb-2 -mt-1" style={{ ...body, color: T.ashFaint }}>
          Save a waiver here once, then pick it from a list when creating an event instead of retyping it every time.
        </p>
        {savedWaivers.map((w, i) => (
          <div key={i} className="mb-3 p-3" style={{ background: T.panel, border: `1px solid ${T.line}`, borderRadius: 6 }}>
            <div className="flex gap-2 mb-2">
              <input value={w.name} onChange={(e) => updateSavedWaiver(i, "name", e.target.value)} placeholder="e.g. Standard Waiver, MilSim Waiver"
                className="flex-1 px-2.5 py-2 text-[13px] bg-transparent outline-none" style={{ ...body, background: T.panelAlt, border: `1px solid ${T.line}`, borderRadius: 4, color: T.ash }} />
              <button onClick={() => removeSavedWaiver(i)} className="w-9 h-9 flex-shrink-0 flex items-center justify-center" style={{ background: T.panelAlt, borderRadius: 4 }}>
                <Trash2 size={14} color={T.alert} />
              </button>
            </div>
            <textarea value={w.text} onChange={(e) => updateSavedWaiver(i, "text", e.target.value)} placeholder="Waiver text…" rows={5}
              className="w-full px-2.5 py-2 text-[12px] bg-transparent outline-none" style={{ ...body, background: T.panelAlt, border: `1px solid ${T.line}`, borderRadius: 4, color: T.ash, resize: "none" }} />
          </div>
        ))}

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
function EventOverviewScreen({ ev, onBack, onEdit, onOpenRoster }) {
  return (
    <div className="h-full overflow-y-auto pb-24" style={flatBg}>
      <div className="px-6 pt-2 pb-4 flex items-center" style={{ borderBottom: `1px solid ${T.line}` }}>
        <button onClick={onBack} className="w-9 h-9 -ml-2 flex items-center justify-center">
          <ChevronLeft size={20} color={T.ash} />
        </button>
        <h1 className="flex-1 text-center text-[16px] font-semibold truncate px-2" style={{ ...display, color: T.ash }}>{ev.title}</h1>
        <button onClick={onEdit} className="w-9 h-9 flex items-center justify-center">
          <Pencil size={16} color={T.ash} />
        </button>
      </div>

      <div className="px-6 pt-4">
        <div className="flex items-center gap-2 mb-1">
          {ev.canceled ? (
            <span className="text-[9px] font-semibold px-1.5 py-0.5" style={{ ...mono, color: T.alert, border: `1px solid ${T.alert}`, borderRadius: 2 }}>CANCELED</span>
          ) : ev.draft ? (
            <span className="text-[9px] font-semibold px-1.5 py-0.5" style={{ ...mono, color: T.ashFaint, border: `1px solid ${T.line}`, borderRadius: 2 }}>DRAFT</span>
          ) : (
            <span className="text-[9px] font-semibold px-1.5 py-0.5" style={{ ...mono, color: T.good, border: `1px solid ${T.good}`, borderRadius: 2 }}>PUBLISHED</span>
          )}
        </div>
        <div className="text-[18px] font-semibold mb-1" style={{ ...display, color: T.ash }}>{ev.title}</div>
        <div className="text-[12px] mb-4" style={{ ...body, color: T.ashFaint }}>
          {ev.fieldName} · {ev.date || "No date set"}{ev.endDate ? ` – ${ev.endDate}` : ""}{ev.startTime ? ` · ${ev.startTime}` : ""}
        </div>

        <div className="grid grid-cols-3 gap-2 mb-5">
          <div className="p-3 text-center" style={{ background: T.panel, borderRadius: 6, border: `1px solid ${T.line}` }}>
            <div className="text-[18px] font-semibold" style={{ ...display, color: T.good }}>{ev.bookedCount || 0}{typeof ev.maxCapacity === "number" ? `/${ev.maxCapacity}` : ""}</div>
            <div className="text-[10px]" style={{ ...body, color: T.ashFaint }}>Booked</div>
          </div>
          <div className="p-3 text-center" style={{ background: T.panel, borderRadius: 6, border: `1px solid ${T.line}` }}>
            <div className="text-[18px] font-semibold" style={{ ...display, color: T.ash }}>{ev.interestCount || 0}</div>
            <div className="text-[10px]" style={{ ...body, color: T.ashFaint }}>Interested</div>
          </div>
          <div className="p-3 text-center" style={{ background: T.panel, borderRadius: 6, border: `1px solid ${T.line}` }}>
            <div className="text-[18px] font-semibold" style={{ ...display, color: T.ash }}>{ev.price ? displayPrice(ev.price) : "—"}</div>
            <div className="text-[10px]" style={{ ...body, color: T.ashFaint }}>Price</div>
          </div>
        </div>

        {(() => {
          const p = parsePrice(ev.price);
          const cap = typeof ev.maxCapacity === "number" ? ev.maxCapacity : parseInt(ev.maxCapacity, 10);
          if (!p || !cap) return null;
          return (
            <div className="p-3 mb-5" style={{ background: T.panel, borderRadius: 6, border: `1px solid ${T.line}` }}>
              <div className="text-[12px]" style={{ ...body, color: T.ashDim }}>
                Projected Revenue (Gross): <span style={{ fontWeight: 600, color: T.accent }}>${(p * cap).toFixed(2)}</span> — entry cost × capacity, not a real payment yet
              </div>
            </div>
          );
        })()}

        <button onClick={() => onOpenRoster(ev)} className="w-full mb-5 py-3 flex items-center justify-center gap-2" style={{ background: T.panel, borderRadius: 6, border: `1px solid ${T.line}` }}>
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
            <div className="p-3 flex items-center gap-3 mb-5" style={{ background: T.panel, borderRadius: 6, border: `1px solid ${T.line}` }}>
              <img src={ev.checkInPatch.imageUrl} alt="" className="w-10 h-10" style={{ objectFit: "contain" }} />
              <div className="text-[13px] font-medium" style={{ ...body, color: T.ash }}>{ev.checkInPatch.name}</div>
            </div>
          </>
        )}

        {ev.waiver && (
          <>
            <Eyebrow>Waiver</Eyebrow>
            <div className="p-3 flex items-center gap-2 mb-5" style={{ background: T.panel, borderRadius: 6, border: `1px solid ${T.line}` }}>
              <FileSignature size={15} color={T.ashDim} />
              <span className="text-[13px]" style={{ ...body, color: T.ashDim }}>Required for this event</span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function EventEditScreen({ field, existing, onBack, createEvent, updateEvent, newEventId, allFields }) {
  const [eventId] = useState(existing?.id || newEventId());
  const [title, setTitle] = useState(existing?.title || "");
  const [date, setDate] = useState(existing?.date || "");
  const [endDate, setEndDate] = useState(existing?.endDate || "");
  const [startTime, setStartTime] = useState(existing?.startTime || "");
  const [briefingTime, setBriefingTime] = useState(existing?.briefingTime || "");
  const [price, setPrice] = useState(existing?.price || "$");
  const [maxCapacity, setMaxCapacity] = useState(existing?.maxCapacity || "");
  const [type, setType] = useState(existing?.type || "OUTDOOR");
  const [description, setDescription] = useState(existing?.description || "");
  const [imageUrl, setImageUrl] = useState(existing?.imageUrl || null);
  const [waiverText, setWaiverText] = useState(existing?.waiver?.text || "");
  const [patchName, setPatchName] = useState(existing?.checkInPatch?.name || "");
  const [patchImageUrl, setPatchImageUrl] = useState(existing?.checkInPatch?.imageUrl || null);
  const [patchUploading, setPatchUploading] = useState(false);
  const patchInputRef = React.useRef(null);
  const [bannerUploading, setBannerUploading] = useState(false);
  const bannerInputRef = React.useRef(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // Only meaningful when editing an existing event — a brand new one has
  // nothing to compare against, so it's always considered "changed."
  const [snapshot, setSnapshot] = useState({
    title: existing?.title || "", date: existing?.date || "", endDate: existing?.endDate || "",
    startTime: existing?.startTime || "", briefingTime: existing?.briefingTime || "", price: existing?.price || "$", maxCapacity: existing?.maxCapacity || "",
    type: existing?.type || "OUTDOOR", description: existing?.description || "", imageUrl: existing?.imageUrl || null,
  });
  const hasChanges = !existing ||
    title !== snapshot.title || date !== snapshot.date || endDate !== snapshot.endDate ||
    startTime !== snapshot.startTime || briefingTime !== snapshot.briefingTime || price !== snapshot.price || maxCapacity !== snapshot.maxCapacity ||
    type !== snapshot.type || description !== snapshot.description || imageUrl !== snapshot.imageUrl ||
    waiverText !== (existing?.waiver?.text || "") ||
    patchName !== (existing?.checkInPatch?.name || "") || patchImageUrl !== (existing?.checkInPatch?.imageUrl || null);
  // Publishing a currently-unchanged draft is still a real, meaningful
  // action (draft → published) even with zero content edits — Save as
  // Draft has no such case, since re-saving identical draft content really
  // is a no-op.
  const canPublish = hasChanges || existing?.draft;

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
    if (!date) {
      setCompetingEvents([]);
      return;
    }
    let cancelled = false;
    getDocs(query(collection(db, "events"), where("date", "==", date)))
      .then((snap) => {
        if (cancelled) return;
        const others = snap.docs
          .map((d) => ({ id: d.id, ...d.data() }))
          .filter((e) => e.fieldId !== field.id && !e.draft && e.id !== eventId)
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
      const storageRef = ref(storage, `eventBanners/${field.id}/${eventId}/banner.jpg`);
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
      const storageRef = ref(storage, `eventPatches/${field.id}/${eventId}/patch.jpg`);
      await uploadBytes(storageRef, resized, { contentType: "image/jpeg" });
      const url = await getDownloadURL(storageRef);
      setPatchImageUrl(url);
    } catch (err) {
      setError("Couldn't upload that patch — try again.");
    } finally {
      setPatchUploading(false);
    }
  };

  const buildData = (draft) => ({
    title: title.trim(),
    date,
    endDate: endDate || null,
    startTime: startTime || null,
    briefingTime: briefingTime || null,
    price: price || null,
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
    setSaving(true);
    setError("");
    try {
      const data = buildData(draft);
      if (existing) {
        await updateEvent(eventId, data);
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
        <button onClick={onBack} className="w-9 h-9 -ml-2 flex items-center justify-center">
          <ChevronLeft size={20} color={T.ash} />
        </button>
        <h1 className="flex-1 text-center text-[18px] font-semibold mr-9" style={{ ...display, color: T.ash }}>{existing ? "Edit Event" : "Create New Event"}</h1>
      </div>

      <div className="px-6 pt-4" style={{ maxWidth: "100%" }}>
        <Eyebrow>Event Banner</Eyebrow>
        <input ref={bannerInputRef} type="file" accept="image/*" onChange={handleBannerSelected} className="hidden" />
        <button
          onClick={handleBannerPick}
          disabled={bannerUploading}
          className="w-full h-32 mb-4 flex flex-col items-center justify-center gap-1 overflow-hidden"
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
          <div>
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

        <TextField label="Start Time" value={startTime} onChange={setStartTime} placeholder="e.g. 9:00 AM (gates), 11:00 AM start" />

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
              // Same defensive properties as TextField's date/time
              // handling — this input was built separately and never got
              // them, which is very likely the real gap here.
              boxSizing: "border-box",
              minWidth: 0,
              maxWidth: "100%",
              display: "block",
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
                className="px-3 py-1.5 text-[12px] font-medium"
                style={{ ...body, border: `1px solid ${type === t.key ? T.accent : T.line}`, background: type === t.key ? T.accent : "transparent", color: type === t.key ? "#fff" : T.ashDim, borderRadius: 4 }}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>

        <Eyebrow>Pricing & Capacity</Eyebrow>
        <div className="flex gap-2">
          <div className="flex-1">
            <TextField label="Entry Cost" value={price} onChange={setPrice} placeholder="25 (or clear and type 'Price varies')" />
          </div>
          <div className="flex-1">
            <TextField label="Max Capacity" value={maxCapacity} onChange={setMaxCapacity} placeholder="120" type="number" />
          </div>
        </div>
        {projectedRevenue && (
          <p className="text-[12px] mb-3 -mt-1" style={{ ...body, color: T.ashDim }}>
            Projected Revenue (Gross): <span style={{ fontWeight: 600, color: T.accent }}>${projectedRevenue}</span> — entry cost × capacity, not a real payment yet
          </p>
        )}

        <TextField label="Event Description" value={description} onChange={setDescription} rows={4} placeholder="Describe your event schedule, briefing instructions, game modes, and parking locations." />

        <Eyebrow>Waiver</Eyebrow>
        <p className="text-[11px] mb-2 -mt-1" style={{ ...body, color: T.ashFaint }}>
          Players will read and e-sign this text before the event. Leave blank if this event doesn't need one.
          Document upload isn't available yet — a real, complete document would need to be embedded and made
          signable in-app to actually work, which is a bigger piece; entering the text directly here works today.
        </p>
        {field.savedWaivers?.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-2">
            {field.savedWaivers.map((w, i) => (
              <button
                key={i}
                onClick={() => setWaiverText(w.text)}
                className="px-3 py-1.5 text-[12px] font-medium"
                style={{ ...body, border: `1px solid ${T.line}`, color: T.ashDim, borderRadius: 999 }}
              >
                {w.name}
              </button>
            ))}
          </div>
        )}
        <TextField value={waiverText} onChange={setWaiverText} rows={6} placeholder="Paste or write your field's waiver text here…" />

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
            className="w-16 h-16 flex-shrink-0 flex items-center justify-center"
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
        </div>

        {error && <p className="text-[12px] mb-2" style={{ ...body, color: T.alert }}>{error}</p>}
        <div className="mb-2">
          <PrimaryButton onClick={() => handleSave(false)} disabled={saving || !canPublish}>{saving ? "Saving…" : "Publish Event"}</PrimaryButton>
        </div>
        <div className="mb-6">
          <button
            onClick={() => handleSave(true)}
            disabled={saving || !hasChanges}
            className="w-full py-3 font-semibold text-[14px]"
            style={{ ...body, border: `1px solid ${T.line}`, color: T.ashDim, borderRadius: 4, opacity: saving || !hasChanges ? 0.5 : 1 }}
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
@keyframes loadingPulse {
  0%, 80%, 100% { transform: scale(0.6); opacity: 0.35; }
  40% { transform: scale(1); opacity: 1; }
}
`;

function LoadingScreen() {
  return (
    <div className="h-screen flex items-center justify-center" style={flatBg}>
      <style>{FONTS}</style>
      <style>{LOADING_KEYFRAMES}</style>
      <div className="flex gap-2">
        {[0, 0.15, 0.3].map((delay) => (
          <div
            key={delay}
            style={{
              width: 9,
              height: 9,
              borderRadius: 999,
              background: T.accent,
              animation: "loadingPulse 1.4s ease-in-out infinite",
              animationDelay: `${delay}s`,
            }}
          />
        ))}
      </div>
    </div>
  );
}

function LegalAgreementScreen({ onAccept }) {
  const [tab, setTab] = useState("terms");
  const [checked, setChecked] = useState(false);
  const [saving, setSaving] = useState(false);

  const TABS = [
    { key: "terms", label: "Terms of Use", text: TERMS_OF_USE },
    { key: "privacy", label: "Privacy Policy", text: PRIVACY_POLICY },
    { key: "eula", label: "EULA", text: EULA },
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
            className="px-2 py-2 text-[12px] font-semibold"
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
        <button onClick={() => setChecked(!checked)} className="w-full flex items-center gap-2 mb-3 text-left">
          <div className="w-5 h-5 flex-shrink-0 flex items-center justify-center" style={{ border: `1.5px solid ${checked ? T.ash : T.line}`, background: checked ? T.ash : "transparent", borderRadius: 4 }}>
            {checked && <Check size={13} color="#fff" strokeWidth={3} />}
          </div>
          <span className="text-[12px]" style={{ ...body, color: T.ashDim }}>I've read and agree to the Terms of Use, Privacy Policy, and EULA.</span>
        </button>
        <button
          onClick={handleAccept}
          disabled={!checked || saving}
          className="w-full py-3.5 font-semibold text-[14px]"
          style={{ ...display, background: T.ash, color: "#FFFFFF", borderRadius: 4, opacity: !checked || saving ? 0.5 : 1 }}
        >
          {saving ? "Continuing…" : "Agree & Continue"}
        </button>
      </div>
    </div>
  );
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
  const [status, setStatus] = useState(null); // { ok, message }
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
            if (result.ok) {
              setStatus({ ok: true, message: `${result.callsign} checked in` });
            } else if (result.reason === "already-checked-in") {
              setStatus({ ok: false, message: `${result.callsign} already checked in` });
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
            }, 2200);
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
        <button onClick={onBack} className="w-9 h-9 -ml-2 flex items-center justify-center">
          <ChevronLeft size={20} color={T.ash} />
        </button>
        <h1 className="flex-1 text-center text-[16px] font-semibold mr-9" style={{ ...display, color: T.ash }}>{event.title}</h1>
      </div>

      <div id="atlas-qr-reader" ref={containerRef} className="flex-1 min-h-0" />

      <div className="px-6 py-4" style={{ background: T.panel, borderTop: `1px solid ${T.line}` }}>
        {status ? (
          <div className="py-3 text-center font-semibold text-[14px]" style={{ ...display, color: status.ok ? T.good : T.alert }}>
            {status.message}
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
function RosterScreen({ event, onBack, onOpenCheckIn, banned, bannedLoading, banPlayer, unbanPlayer }) {
  const { signatures, signaturesLoading } = useEventWaivers(event.id);
  const { bookings, bookingsLoading } = useEventBookings(event.id);
  const bannedUids = new Set(banned.map((b) => b.uid));
  const [showManualCheckIn, setShowManualCheckIn] = useState(false);
  const [rosterFilter, setRosterFilter] = useState("all"); // all | checkedIn | notYet
  const [rosterSearch, setRosterSearch] = useState("");

  const renderPersonRow = (uid, name, dateValue, checkedIn) => {
    const isBanned = bannedUids.has(uid);
    // Cross-references by uid so the field owner sees a real, unambiguous
    // name to call out — callsigns alone aren't unique (multiple players
    // really could both be "Ghost"), and the real legal name already
    // exists here for anyone who signed a waiver, just not previously
    // connected to the callsign visually. Shows whichever of the two
    // wasn't already passed in as the primary name, so this works the
    // same way in both the Booked Players section (callsign primary) and
    // the Waiver Signatures section (real name primary) without needing
    // two different versions of this function.
    const matchingSignature = signatures.find((s) => s.uid === uid);
    const matchingBooking = bookings.find((b) => b.uid === uid);
    const secondaryName = [matchingSignature?.signedName, matchingBooking?.callsign].find((n) => n && n !== name);
    return (
      <div key={uid} className="mb-2 p-3 flex items-center justify-between" style={{ background: T.panel, borderRadius: 6, border: `1px solid ${isBanned ? T.alert : T.line}` }}>
        <div>
          <div className="flex items-center gap-2">
            <div className="text-[13px] font-medium" style={{ ...body, color: T.ash }}>{name}</div>
            {checkedIn && (
              <span className="text-[9px] font-semibold px-1.5 py-0.5 flex items-center gap-1" style={{ ...mono, color: T.good, border: `1px solid ${T.good}`, borderRadius: 2 }}>
                <Check size={9} /> CHECKED IN
              </span>
            )}
          </div>
          {secondaryName && (
            <div className="text-[11px]" style={{ ...body, color: T.ashFaint }}>{secondaryName}</div>
          )}
          {dateValue?.toDate && (
            <div className="text-[11px]" style={{ ...mono, color: T.ashFaint }}>{dateValue.toDate().toLocaleDateString()}</div>
          )}
        </div>
        {isBanned ? (
          <button onClick={() => unbanPlayer(event.fieldId, uid)} className="px-2.5 py-1.5 text-[11px] font-semibold" style={{ ...body, border: `1px solid ${T.line}`, color: T.ashDim, borderRadius: 4 }}>
            Unban
          </button>
        ) : (
          <button onClick={() => banPlayer(event.fieldId, uid, name)} className="px-2.5 py-1.5 text-[11px] font-semibold" style={{ ...body, border: `1px solid ${T.alert}`, color: T.alert, borderRadius: 4 }}>
            Ban
          </button>
        )}
      </div>
    );
  };

  return (
    <div className="h-full overflow-y-auto pb-24" style={flatBg}>
      <div className="px-6 pt-2 pb-4 flex items-center" style={{ borderBottom: `1px solid ${T.line}` }}>
        <button onClick={onBack} className="w-9 h-9 -ml-2 flex items-center justify-center">
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
            className="px-4 py-3 text-[13px] font-semibold flex items-center gap-2"
            style={{ ...display, border: `1px solid ${T.line}`, color: T.ash, borderRadius: 4 }}
          >
            <Search size={15} /> Manual
          </button>
        </div>

        {typeof event.maxCapacity === "number" ? (
          <div className="mb-2 p-3" style={{ background: T.panel, borderRadius: 6, border: `1px solid ${T.line}` }}>
            <div className="flex items-baseline justify-between mb-1.5">
              <span className="text-[20px] font-semibold" style={{ ...display, color: T.good }}>{event.bookedCount || 0}</span>
              <span className="text-[12px]" style={{ ...body, color: T.ashFaint }}>of {event.maxCapacity} booked</span>
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
          <Eyebrow>Booked Players ({bookings.length})</Eyebrow>
          {bookings.length > 0 && (
            <button
              onClick={() => downloadCsv(
                `${event.title} - Booked Players.csv`,
                ["Callsign", "Booked At", "Checked In", "Checked In At"],
                bookings.map((b) => [
                  b.callsign,
                  b.bookedAt?.toDate ? b.bookedAt.toDate().toLocaleString() : "",
                  b.checkedIn ? "Yes" : "No",
                  b.checkedInAt?.toDate ? b.checkedInAt.toDate().toLocaleString() : "",
                ])
              )}
              className="text-[11px] font-semibold"
              style={{ ...body, color: T.accent }}
            >
              Export CSV
            </button>
          )}
        </div>
        {bookingsLoading ? (
          <div className="text-[13px] py-4 text-center" style={{ ...body, color: T.ashFaint }}>Loading…</div>
        ) : bookings.length === 0 ? (
          <p className="text-[12px] mb-5" style={{ ...body, color: T.ashFaint }}>No one's booked yet.</p>
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
                      placeholder="Search booked players"
                      className="w-full pl-8 pr-3 py-2 text-[12px] bg-transparent outline-none"
                      style={{ ...body, background: T.panelAlt, border: `1px solid ${T.line}`, borderRadius: 4, color: T.ash, boxSizing: "border-box" }}
                    />
                  </div>
                  <div className="flex gap-1 mb-3 overflow-x-auto">
                    {FILTERS.map((f) => (
                      <button
                        key={f.key}
                        onClick={() => setRosterFilter(f.key)}
                        className="px-2.5 py-1.5 text-[11px] font-semibold flex-shrink-0"
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
              className="text-[11px] font-semibold"
              style={{ ...body, color: T.accent }}
            >
              Export CSV
            </button>
          )}
        </div>
        <p className="text-[11px] mb-3" style={{ ...body, color: T.ashFaint }}>
          Everyone who's signed the waiver, including anyone who signed without booking. Every booking above already
          required a signature, so this list will always be a superset of Booked Players.
        </p>
        {signaturesLoading ? (
          <div className="text-[13px] py-4 text-center" style={{ ...body, color: T.ashFaint }}>Loading…</div>
        ) : signatures.length === 0 ? (
          <p className="text-[12px] mb-5" style={{ ...body, color: T.ashFaint }}>No signatures yet.</p>
        ) : (
          <div className="mb-5">
            {signatures.map((s, i) => renderPersonRow(s.uid || `sig-${i}`, s.signedName, s.signedAt))}
          </div>
        )}

        {banned.length > 0 && (
          <>
            <Eyebrow>Banned From This Field</Eyebrow>
            <p className="text-[11px] mb-3" style={{ ...body, color: T.ashFaint }}>
              There's no enforcement mechanism yet (that needs real check-in), but this list is saved and ready for when there is.
            </p>
            {banned.map((b) => (
              <div key={b.uid} className="mb-2 p-3 flex items-center justify-between" style={{ background: T.panel, borderRadius: 6, border: `1px solid ${T.line}` }}>
                <div className="text-[13px] font-medium" style={{ ...body, color: T.ash }}>{b.name}</div>
                <button
                  onClick={() => unbanPlayer(event.fieldId, b.uid)}
                  className="px-2.5 py-1.5 text-[11px] font-semibold"
                  style={{ ...body, border: `1px solid ${T.line}`, color: T.ashDim, borderRadius: 4 }}
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
    </div>
  );
}

// The fallback for when QR scanning isn't an option — a dead phone, no
// signal to load the code, forgot it entirely. Deliberately searches only
// within this event's own real bookings, not all of Atlas — checking
// someone in only ever makes sense for someone who already has a real
// booking here, the same constraint the scanner itself enforces.
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
        setFeedback({ uid: booking.uid, ok: true, message: `${result.callsign} checked in` });
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
          <button onClick={onClose} className="w-8 h-8 flex items-center justify-center">
            <X size={18} color={T.ashDim} />
          </button>
        </div>

        <div className="px-5 pt-3">
          <div className="relative mb-3">
            <Search size={15} color={T.ashFaint} className="absolute left-3 top-1/2" style={{ transform: "translateY(-50%)" }} />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search booked players by name"
              autoFocus
              className="w-full pl-9 pr-3 py-2.5 text-[13px] bg-transparent outline-none"
              style={{ ...body, background: T.panel, border: `1px solid ${T.line}`, borderRadius: 6, color: T.ash, boxSizing: "border-box" }}
            />
          </div>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-5 pb-5">
          {bookings.length === 0 ? (
            <p className="text-[13px] py-6 text-center" style={{ ...body, color: T.ashFaint }}>No one's booked yet.</p>
          ) : matches.length === 0 ? (
            <p className="text-[13px] py-6 text-center" style={{ ...body, color: T.ashFaint }}>No booked player matches that name.</p>
          ) : (
            matches.map((b) => (
              <div key={b.uid} className="mb-2 p-3" style={{ background: T.panel, borderRadius: 6, border: `1px solid ${T.line}` }}>
                <div className="flex items-center justify-between mb-1">
                  <div>
                    <div className="text-[14px] font-medium" style={{ ...body, color: T.ash }}>{nameByUid.get(b.uid) || b.callsign}</div>
                    {nameByUid.get(b.uid) && (
                      <div className="text-[11px]" style={{ ...body, color: T.ashFaint }}>{b.callsign}</div>
                    )}
                  </div>
                  {b.checkedIn ? (
                    <span className="text-[10px] font-semibold px-1.5 py-0.5 flex items-center gap-1" style={{ ...mono, color: T.good, border: `1px solid ${T.good}`, borderRadius: 2 }}>
                      <Check size={9} /> CHECKED IN
                    </span>
                  ) : (
                    <button
                      onClick={() => handleCheckIn(b)}
                      disabled={busyUid === b.uid}
                      className="px-3 py-1.5 text-[11px] font-semibold"
                      style={{ ...display, background: T.ash, color: "#FFFFFF", borderRadius: 4, opacity: busyUid === b.uid ? 0.6 : 1 }}
                    >
                      {busyUid === b.uid ? "…" : "Check In"}
                    </button>
                  )}
                </div>
                <div className="text-[11px]" style={{ ...body, color: signedUids.has(b.uid) ? T.good : T.alert }}>
                  {signedUids.has(b.uid) ? "✓ Waiver signed" : "⚠ No waiver signature found"}
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
    <div className="absolute bottom-0 left-0 right-0 border-t" style={{ background: T.panel, borderColor: T.line, zIndex: 1000 }}>
      <div className="flex justify-between px-3 pt-2.5" style={{ paddingBottom: 20 }}>
        {tabs.map((t) => {
          const Icon = t.icon;
          const isActive = active === t.key;
          return (
            <button key={t.key} onClick={() => onNavigate(t.key)} className="flex flex-col items-center gap-1 flex-1">
              <Icon size={19} color={isActive ? T.accent : T.ashDim} strokeWidth={1.7} />
              <span className="text-[9px] font-medium" style={{ ...body, color: isActive ? T.accent : T.ashDim }}>{t.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ---------- Events hub (top-level tab — all events across every claimed field) ---------- */
function EventsHubScreen({ myFields, events, eventsLoading, onNewEvent, onEditEvent, onOpenOverview, onOpenRoster, deleteEvent, duplicateEvent, updateEvent }) {
  const [tab, setTab] = useState("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [pickerFieldId, setPickerFieldId] = useState(myFields[0]?.id || null);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [confirmPublish, setConfirmPublish] = useState(null);
  const [confirmCancel, setConfirmCancel] = useState(null);
  const [busy, setBusy] = useState(false);
  const today = localDateStr();

  const filtered = events
    .filter((ev) => {
      if (tab === "canceled") return ev.canceled === true;
      if (tab === "drafts") return ev.draft === true;
      if (tab === "all") return true; // genuinely all — drafts and canceled included
      if (ev.draft || ev.canceled) return false; // Upcoming/Past are date-based buckets; neither has a real confirmed slot anymore
      if (tab === "upcoming") return (ev.endDate || ev.date) >= today;
      if (tab === "past") return (ev.endDate || ev.date) < today;
      return true;
    })
    .filter((ev) => !searchQuery.trim() || ev.title.toLowerCase().includes(searchQuery.trim().toLowerCase()));

  const handleDuplicate = async (ev) => {
    const newId = await duplicateEvent(ev);
    onEditEvent(myFields.find((f) => f.id === ev.fieldId) || myFields[0], { ...ev, id: newId, title: `${ev.title} (Copy)`, date: "", draft: true });
  };

  const handleNew = () => {
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
  const handleConfirmCancel = async () => {
    setBusy(true);
    try {
      await updateEvent(confirmCancel.id, { canceled: true, canceledAt: serverTimestamp() });
      setConfirmCancel(null);
    } finally {
      setBusy(false);
    }
  };

  const handleConfirmPublish = async () => {
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
        {myFields.length === 0 ? (
          <div className="p-6 flex flex-col items-center text-center" style={{ background: T.panel, borderRadius: 6, border: `1px solid ${T.line}` }}>
            <Calendar size={22} color={T.ashDim} className="mb-2" />
            <div className="text-[13px] font-semibold" style={{ ...display, color: T.ash }}>Claim a field first</div>
            <p className="text-[12px]" style={{ ...body, color: T.ashDim }}>You'll need a field before you can create events.</p>
          </div>
        ) : (
          <>
            {myFields.length > 1 && (
              <div className="mb-3 flex gap-2 flex-wrap">
                {myFields.map((f) => (
                  <button
                    key={f.id}
                    onClick={() => setPickerFieldId(f.id)}
                    className="px-3 py-1.5 text-[12px] font-medium"
                    style={{ ...body, border: `1px solid ${pickerFieldId === f.id ? T.accent : T.line}`, background: pickerFieldId === f.id ? T.accent : "transparent", color: pickerFieldId === f.id ? "#fff" : T.ashDim, borderRadius: 4 }}
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
          {[["all", "All"], ["upcoming", "Upcoming"], ["past", "Past"], ["drafts", "Drafts"], ["canceled", "Canceled"]].map(([key, label]) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className="px-3 py-2 text-[12px] font-semibold flex-shrink-0"
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
            <div key={ev.id} className="mb-3 p-4" style={{ background: T.panel, borderRadius: 6, border: `1px solid ${T.line}` }}>
              <button onClick={() => onOpenOverview(myFields.find((f) => f.id === ev.fieldId) || myFields[0], ev)} className="w-full text-left">
                <div className="flex items-start justify-between mb-1">
                  <div className="flex items-center gap-2">
                    {ev.canceled ? (
                      <span className="text-[9px] font-semibold px-1.5 py-0.5" style={{ ...mono, color: T.alert, border: `1px solid ${T.alert}`, borderRadius: 2 }}>CANCELED</span>
                    ) : ev.draft ? (
                      <span className="text-[9px] font-semibold px-1.5 py-0.5" style={{ ...mono, color: T.ashFaint, border: `1px solid ${T.line}`, borderRadius: 2 }}>DRAFT</span>
                    ) : (
                      <span className="text-[9px] font-semibold px-1.5 py-0.5" style={{ ...mono, color: T.good, border: `1px solid ${T.good}`, borderRadius: 2 }}>PUBLISHED</span>
                    )}
                    <div className="text-[14px] font-semibold" style={{ ...display, color: T.ash }}>{ev.title}</div>
                  </div>
                  {ev.price && <div className="text-[12px] font-semibold" style={{ ...mono, color: T.accent }}>{displayPrice(ev.price)}</div>}
                </div>
                <div className="text-[12px] mb-2" style={{ ...body, color: T.ashFaint }}>
                  {ev.fieldName} · {ev.date || "No date set"}{ev.endDate ? ` – ${ev.endDate}` : ""}{ev.startTime ? ` · ${ev.startTime}` : ""}
                </div>
                {(typeof ev.maxCapacity === "number" || ev.interestCount > 0) && (
                  <div className="text-[11px] font-semibold mb-3 flex items-center gap-2">
                    {typeof ev.maxCapacity === "number" && (
                      <span style={{ ...mono, color: T.good }}>{ev.bookedCount || 0} / {ev.maxCapacity} booked</span>
                    )}
                    {ev.interestCount > 0 && <span style={{ ...mono, color: T.accent }}>{ev.interestCount} interested</span>}
                  </div>
                )}
              </button>
              <div className="flex gap-2 flex-wrap">
                <button onClick={() => onEditEvent(myFields.find((f) => f.id === ev.fieldId) || myFields[0], ev)} className="px-3 py-2 flex items-center justify-center" style={{ border: `1px solid ${T.line}`, color: T.ashDim, borderRadius: 4 }}>
                  <Pencil size={14} />
                </button>
                <button onClick={() => onOpenRoster(ev)} className="flex-1 py-2 text-[12px] font-medium flex items-center justify-center gap-1" style={{ ...body, border: `1px solid ${T.line}`, color: T.ashDim, borderRadius: 4 }}>
                  <Users size={12} /> Roster
                </button>
                <button onClick={() => handleDuplicate(ev)} className="px-3 py-2 text-[12px] font-medium flex items-center gap-1" style={{ ...body, border: `1px solid ${T.line}`, color: T.ashDim, borderRadius: 4 }}>
                  <Copy size={12} />
                </button>
                {ev.draft && (
                  <button onClick={() => setConfirmPublish(ev)} className="px-3 py-2 text-[12px] font-semibold" style={{ ...display, background: T.good, color: "#fff", borderRadius: 4 }}>
                    Publish
                  </button>
                )}
                {ev.canceled && (
                  <button onClick={() => updateEvent(ev.id, { canceled: false, canceledAt: null })} className="px-3 py-2 text-[12px] font-semibold" style={{ ...display, background: T.good, color: "#fff", borderRadius: 4 }}>
                    Reactivate
                  </button>
                )}
                {!ev.draft && !ev.canceled && (
                  <button onClick={() => setConfirmCancel(ev)} className="px-3 py-2 flex items-center justify-center" style={{ border: `1px solid ${T.line}`, color: T.ashDim, borderRadius: 4 }}>
                    <Ban size={14} />
                  </button>
                )}
                <button onClick={() => setConfirmDelete(ev)} className="px-3 py-2 flex items-center justify-center" style={{ border: `1px solid ${T.alert}`, color: T.alert, borderRadius: 4 }}>
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      {confirmCancel && (
        <div className="fixed inset-0 flex items-center justify-center px-6" style={{ background: "rgba(0,0,0,0.5)", zIndex: 2000 }} onClick={() => !busy && setConfirmCancel(null)}>
          <div onClick={(e) => e.stopPropagation()} className="w-full p-5" style={{ background: T.panel, borderRadius: 8, maxWidth: 340 }}>
            <div className="text-[15px] font-semibold mb-1" style={{ ...display, color: T.ash }}>Cancel this event?</div>
            <p className="text-[13px] mb-4" style={{ ...body, color: T.ashDim }}>
              "{confirmCancel.title}" will be marked canceled — anyone who booked or favorited it will see that. This keeps the real record, unlike delete, and can be reversed by editing the event again.
            </p>
            <div className="flex gap-2">
              <button onClick={() => setConfirmCancel(null)} disabled={busy} className="flex-1 py-2.5 text-[13px] font-medium" style={{ ...body, border: `1px solid ${T.line}`, color: T.ashDim, borderRadius: 4 }}>
                Never mind
              </button>
              <button onClick={handleConfirmCancel} disabled={busy} className="flex-1 py-2.5 text-[13px] font-semibold" style={{ ...display, background: T.alert, color: "#fff", borderRadius: 4, opacity: busy ? 0.6 : 1 }}>
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
              "{confirmDelete.title}" will be permanently deleted. This can't be undone.
            </p>
            <div className="flex gap-2">
              <button onClick={() => setConfirmDelete(null)} disabled={busy} className="flex-1 py-2.5 text-[13px] font-medium" style={{ ...body, border: `1px solid ${T.line}`, color: T.ashDim, borderRadius: 4 }}>
                Cancel
              </button>
              <button onClick={handleConfirmDelete} disabled={busy} className="flex-1 py-2.5 text-[13px] font-semibold" style={{ ...display, background: T.alert, color: "#fff", borderRadius: 4, opacity: busy ? 0.6 : 1 }}>
                {busy ? "Deleting…" : "Delete"}
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmPublish && (
        <div className="fixed inset-0 flex items-center justify-center px-6" style={{ background: "rgba(0,0,0,0.5)", zIndex: 2000 }} onClick={() => !busy && setConfirmPublish(null)}>
          <div onClick={(e) => e.stopPropagation()} className="w-full p-5" style={{ background: T.panel, borderRadius: 8, maxWidth: 340 }}>
            <div className="text-[15px] font-semibold mb-1" style={{ ...display, color: T.ash }}>Publish this event?</div>
            <p className="text-[13px] mb-4" style={{ ...body, color: T.ashDim }}>
              "{confirmPublish.title}" will become visible to players immediately.
            </p>
            <div className="flex gap-2">
              <button onClick={() => setConfirmPublish(null)} disabled={busy} className="flex-1 py-2.5 text-[13px] font-medium" style={{ ...body, border: `1px solid ${T.line}`, color: T.ashDim, borderRadius: 4 }}>
                Cancel
              </button>
              <button onClick={handleConfirmPublish} disabled={busy} className="flex-1 py-2.5 text-[13px] font-semibold" style={{ ...display, background: T.good, color: "#fff", borderRadius: 4, opacity: busy ? 0.6 : 1 }}>
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
  const sorted = [...events].filter((e) => !e.draft).sort((a, b) => (b.date || "").localeCompare(a.date || ""));

  return (
    <div className="h-full overflow-y-auto pb-24" style={flatBg}>
      <div className="px-6 pt-6 pb-4">
        <div className="text-[20px] font-semibold mb-1" style={{ ...display, color: T.ash }}>Roster</div>
        <p className="text-[12px]" style={{ ...body, color: T.ashDim }}>Pick an event to see who's booked and who's signed the waiver.</p>
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
              className="w-full mb-3 p-4 flex items-center justify-between text-left"
              style={{ background: T.panel, borderRadius: 6, border: `1px solid ${T.line}` }}
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

/* ---------- Analytics (top-level tab, real numbers only) ---------- */
function AnalyticsScreen({ events, eventsLoading, totalSignatures, activityLoading }) {
  const published = events.filter((e) => !e.draft);
  const totalInterest = published.reduce((sum, e) => sum + (e.interestCount || 0), 0);
  const totalBooked = published.reduce((sum, e) => sum + (e.bookedCount || 0), 0);
  const topEvents = [...published].filter((e) => e.interestCount > 0).sort((a, b) => (b.interestCount || 0) - (a.interestCount || 0)).slice(0, 5);

  return (
    <div className="h-full overflow-y-auto pb-24" style={flatBg}>
      <div className="px-6 pt-6 pb-4">
        <div className="text-[20px] font-semibold" style={{ ...display, color: T.ash }}>Analytics</div>
        <p className="text-[12px]" style={{ ...body, color: T.ashDim }}>Real numbers only — no revenue or ratings, since neither payments nor reviews exist yet.</p>
      </div>

      <div className="px-6">
        <div className="grid grid-cols-2 gap-3 mb-5">
          <div className="p-4" style={{ background: T.panel, borderRadius: 6, border: `1px solid ${T.line}` }}>
            <div className="text-[10px] font-semibold uppercase mb-1" style={{ ...mono, color: T.ashFaint, letterSpacing: "0.04em" }}>Published Events</div>
            <div className="text-[22px] font-semibold" style={{ ...display, color: T.ash }}>{eventsLoading ? "…" : published.length}</div>
          </div>
          <div className="p-4" style={{ background: T.panel, borderRadius: 6, border: `1px solid ${T.line}` }}>
            <div className="text-[10px] font-semibold uppercase mb-1" style={{ ...mono, color: T.ashFaint, letterSpacing: "0.04em" }}>Total Booked</div>
            <div className="text-[22px] font-semibold" style={{ ...display, color: T.good }}>{eventsLoading ? "…" : totalBooked}</div>
          </div>
          <div className="p-4" style={{ background: T.panel, borderRadius: 6, border: `1px solid ${T.line}` }}>
            <div className="text-[10px] font-semibold uppercase mb-1" style={{ ...mono, color: T.ashFaint, letterSpacing: "0.04em" }}>Total Interest</div>
            <div className="text-[22px] font-semibold" style={{ ...display, color: T.ash }}>{eventsLoading ? "…" : totalInterest}</div>
          </div>
          <div className="p-4" style={{ background: T.panel, borderRadius: 6, border: `1px solid ${T.line}` }}>
            <div className="text-[10px] font-semibold uppercase mb-1" style={{ ...mono, color: T.ashFaint, letterSpacing: "0.04em" }}>Waiver Signatures</div>
            <div className="text-[22px] font-semibold" style={{ ...display, color: T.ash }}>{activityLoading ? "…" : totalSignatures}</div>
          </div>
        </div>

        <Eyebrow>Most Interest</Eyebrow>
        {topEvents.length === 0 ? (
          <div className="text-[13px] py-4 text-center" style={{ ...body, color: T.ashFaint }}>No interest data yet.</div>
        ) : (
          topEvents.map((ev) => (
            <div key={ev.id} className="mb-2 p-3 flex items-center justify-between" style={{ background: T.panel, borderRadius: 6, border: `1px solid ${T.line}` }}>
              <div className="text-[13px] font-medium" style={{ ...body, color: T.ash }}>{ev.title}</div>
              <div className="text-[12px] font-semibold" style={{ ...mono, color: T.accent }}>{ev.interestCount} interested</div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

/* ---------- Settings ---------- */
const SUBSCRIPTION_TIERS = [
  { key: "starter", name: "Starter", price: "$100", desc: "For a single field running open plays every so often.", features: ["1 field", "Up to 4 published events / month", "Up to 75 players per event", "Live roster & QR check-in", "Saved waivers"] },
  { key: "pro", name: "Pro", price: "$200", desc: "For a field running events most weekends.", features: ["1 field", "Up to 10 published events / month", "Up to 300 players per event", "Live roster & QR check-in", "Saved waivers"], featured: true },
  { key: "enterprise", name: "Enterprise", price: "$500", desc: "For multi-location operators running at scale.", features: ["Unlimited fields", "Unlimited published events", "Unlimited players per event", "Live roster & QR check-in", "Saved waivers"] },
];

// The real subscription screen — first time this app calls an actual
// Cloud Function rather than talking to Firestore directly. Deliberately
// honest about states this doesn't fully handle yet: past_due has no
// self-serve "update payment method" flow (that's a separate Stripe
// billing-portal integration, not built), so it points to support instead
// of pretending to solve it.
function BillingScreen({ profile, onBack }) {
  const [loadingTier, setLoadingTier] = useState(null);
  const [error, setError] = useState("");

  const handleChoosePlan = async (tier) => {
    setLoadingTier(tier);
    setError("");
    try {
      const createCheckout = httpsCallable(functions, "createSubscriptionCheckout");
      const result = await createCheckout({ tier });
      // Opens in a genuinely separate tab rather than navigating this
      // app's own window away — the same real, confirmed WebKit bug that
      // broke the Payouts flow (corrupting this PWA's own rendering after
      // returning from an external site through the same tab) applies
      // here too, same redirect pattern. Opening separately means this
      // tab never actually leaves, so it never has the chance to hit it.
      window.open(result.data.url, "_blank");
      setLoadingTier(null);
    } catch (err) {
      console.error("createSubscriptionCheckout failed:", err);
      setError("Couldn't start checkout — try again, or reach out on Discord if it keeps happening.");
      setLoadingTier(null);
    }
  };

  // onBack is optional — this same screen doubles as a mandatory gate
  // (once an owner has claimed a real field, they need a real plan
  // before going further) as well as an ordinary Settings entry. A gate
  // has nowhere to go "back" to, so the back button and its explanatory
  // line only render when there's actually somewhere to return to.
  const header = (
    <div className="px-6 pt-2 pb-4" style={{ borderBottom: onBack ? `1px solid ${T.line}` : "none" }}>
      {onBack ? (
        <div className="flex items-center">
          <button onClick={onBack} className="w-9 h-9 -ml-2 flex items-center justify-center">
            <ChevronLeft size={20} color={T.ash} />
          </button>
          <h1 className="flex-1 text-center text-[16px] font-semibold mr-9" style={{ ...display, color: T.ash }}>Billing</h1>
        </div>
      ) : (
        <div className="pt-6">
          <h1 className="text-[18px] font-semibold mb-1" style={{ ...display, color: T.ash }}>Choose a plan to continue</h1>
          <p className="text-[12px]" style={{ ...body, color: T.ashDim }}>You're all set on your field — just pick a plan to start managing it. Every plan includes a real 30-day free trial.</p>
        </div>
      )}
    </div>
  );

  // Comped account (The Compound, as launch partner) — free forever, no
  // billing UI relevant to them at all.
  if (profile?.comped) {
    return (
      <div className="h-full overflow-y-auto" style={flatBg}>
        {header}
        <div className="px-6 pt-8 text-center">
          <div className="w-12 h-12 mx-auto mb-3 flex items-center justify-center" style={{ background: T.good, borderRadius: 999 }}>
            <Check size={22} color="#FFFFFF" strokeWidth={3} />
          </div>
          <div className="text-[15px] font-semibold mb-1" style={{ ...display, color: T.ash }}>Free, permanent access</div>
          <p className="text-[12px]" style={{ ...body, color: T.ashDim }}>As one of our launch partners, you'll never be billed for Atlas.</p>
        </div>
      </div>
    );
  }

  const status = profile?.subscriptionStatus;
  const currentTier = SUBSCRIPTION_TIERS.find((t) => t.key === profile?.subscriptionTier);

  if (status === "active" || status === "trialing") {
    return (
      <div className="h-full overflow-y-auto" style={flatBg}>
        {header}
        <div className="px-6 pt-6">
          <div className="p-4 mb-4" style={{ background: T.panel, borderRadius: 8, border: `1px solid ${T.good}` }}>
            <div className="flex items-center gap-2 mb-1">
              <span className="text-[9px] font-semibold px-1.5 py-0.5" style={{ ...mono, color: T.good, border: `1px solid ${T.good}`, borderRadius: 2 }}>{status === "trialing" ? "FREE TRIAL" : "ACTIVE"}</span>
            </div>
            <div className="text-[16px] font-semibold" style={{ ...display, color: T.ash }}>{currentTier?.name || profile.subscriptionTier} — {currentTier?.price || ""}/mo</div>
            {profile.currentPeriodEnd?.toDate && (
              <p className="text-[11px] mt-1" style={{ ...body, color: T.ashFaint }}>
                {status === "trialing" ? "Trial ends" : "Renews"} {profile.currentPeriodEnd.toDate().toLocaleDateString()}
              </p>
            )}
          </div>
          <p className="text-[11px] text-center" style={{ ...body, color: T.ashFaint }}>To change plans or cancel, reach out on Discord for now.</p>
        </div>
      </div>
    );
  }

  if (status === "past_due" || status === "unpaid") {
    return (
      <div className="h-full overflow-y-auto" style={flatBg}>
        {header}
        <div className="px-6 pt-6">
          <div className="p-4 mb-4" style={{ background: "rgba(188,51,39,0.08)", border: `1px solid ${T.alert}`, borderRadius: 8 }}>
            <div className="text-[14px] font-semibold mb-1" style={{ ...display, color: T.ash }}>Payment issue on your account</div>
            <p className="text-[12px]" style={{ ...body, color: T.ashDim }}>
              Your last payment didn't go through. Updating your card isn't self-serve here yet — reach out on Discord and we'll sort it out directly.
            </p>
          </div>
        </div>
      </div>
    );
  }

  // No subscription yet, or a previously canceled one — show the real
  // tier picker.
  return (
    <div className="h-full overflow-y-auto pb-24" style={flatBg}>
      {header}
      <div className="px-6 pt-6">
        {error && <p className="text-[12px] mb-3 text-center" style={{ ...body, color: T.alert }}>{error}</p>}
        <p className="text-[11px] mb-4 text-center" style={{ ...body, color: T.ashFaint }}>
          Checkout opens in a new browser tab. Once you're done on Stripe's page, just come back here — this updates on its own once it's confirmed.
        </p>
        <div className="flex flex-col gap-3">
          {SUBSCRIPTION_TIERS.map((tier) => (
            <div key={tier.key} className="p-4" style={{ background: T.panel, borderRadius: 8, border: `1px solid ${tier.featured ? T.accent : T.line}` }}>
              {tier.featured && (
                <span className="text-[9px] font-semibold px-1.5 py-0.5 mb-2 inline-block" style={{ ...mono, color: "#FFFFFF", background: T.accent, borderRadius: 2 }}>MOST POPULAR</span>
              )}
              <div className="flex items-baseline justify-between mb-1">
                <span className="text-[16px] font-semibold" style={{ ...display, color: T.ash }}>{tier.name}</span>
                <span className="text-[16px] font-semibold" style={{ ...display, color: T.accent }}>{tier.price}<span className="text-[11px]" style={{ color: T.ashFaint }}>/mo</span></span>
              </div>
              <p className="text-[11px] mb-3" style={{ ...body, color: T.ashDim }}>{tier.desc}</p>
              <ul className="mb-3">
                {tier.features.map((f) => (
                  <li key={f} className="text-[11px] flex items-center gap-1.5 mb-1" style={{ ...body, color: T.ashDim }}>
                    <Check size={11} color={T.good} /> {f}
                  </li>
                ))}
              </ul>
              <div className="text-[10px] font-semibold mb-2" style={{ ...body, color: T.good }}>First month free</div>
              <button
                onClick={() => handleChoosePlan(tier.key)}
                disabled={loadingTier !== null}
                className="w-full py-2.5 text-[13px] font-semibold"
                style={{ ...display, background: T.ash, color: "#FFFFFF", borderRadius: 4, opacity: loadingTier !== null && loadingTier !== tier.key ? 0.5 : 1 }}
              >
                {loadingTier === tier.key ? "Opening Stripe…" : "Choose Plan"}
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// The "get paid for player bookings" half — entirely separate from
// BillingScreen above, both conceptually and in what it actually calls.
// Same account architecture principle as subscriptions: this screen never
// asks for or sees a bank account number — the owner enters that directly
// with Stripe, on Stripe's own hosted page.
function PayoutsScreen({ profile, onBack, checking }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

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
      // bug at all. Its own live connection to your account data also
      // never drops, so "Payouts Active" should update here on its own
      // the moment Stripe confirms it — no manual refresh needed.
      window.open(result.data.url, "_blank");
      setLoading(false);
    } catch (err) {
      console.error("createConnectOnboardingLink failed:", err);
      setError("Couldn't start setup — try again, or reach out on Discord if it keeps happening.");
      setLoading(false);
    }
  };

  const header = (
    <div className="px-6 pt-2 pb-4 flex items-center" style={{ borderBottom: `1px solid ${T.line}` }}>
      <button onClick={onBack} className="w-9 h-9 -ml-2 flex items-center justify-center">
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
          <p className="text-[12px]" style={{ ...body, color: T.ashDim }}>Your Stripe account is set up to receive player booking payments directly.</p>
        </div>
      </div>
    );
  }

  const alreadyStarted = !!profile?.stripeConnectAccountId;

  return (
    <div className="h-full overflow-y-auto" style={flatBg}>
      {header}
      <div className="px-6 pt-8">
        <div className="p-4 mb-4" style={{ background: T.panel, borderRadius: 8, border: `1px solid ${T.line}` }}>
          <div className="text-[14px] font-semibold mb-2" style={{ ...display, color: T.ash }}>
            {alreadyStarted ? "Finish setting up payouts" : "Set up payouts"}
          </div>
          {checking && (
            <p className="text-[11px] mb-2" style={{ ...body, color: T.accent }}>Checking your status with Stripe…</p>
          )}
          <p className="text-[12px] mb-4" style={{ ...body, color: T.ashDim }}>
            When players book your events, their payment goes to you directly — Atlas only takes its own booking fee, never a cut of your entry price.
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
            className="w-full py-3 text-[13px] font-semibold"
            style={{ ...display, background: T.ash, color: "#FFFFFF", borderRadius: 4, opacity: loading ? 0.6 : 1 }}
          >
            {loading ? "Opening Stripe…" : alreadyStarted ? "Continue Setup" : "Set Up Payouts"}
          </button>
        </div>
      </div>
    </div>
  );
}

function SettingsScreen({ profile, user, updateOwnerName, changePassword, deleteAccount, onOpenBilling, onOpenPayouts, onLogout }) {
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
    return "Something went wrong — try again.";
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
    { key: "terms", label: "Terms of Use", text: TERMS_OF_USE },
    { key: "privacy", label: "Privacy Policy", text: PRIVACY_POLICY },
    { key: "eula", label: "EULA", text: EULA },
  ];

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

        <Eyebrow>Billing</Eyebrow>
        <button
          onClick={onOpenBilling}
          className="w-full mb-3 p-4 flex items-center justify-between"
          style={{ background: T.panel, borderRadius: 6, border: `1px solid ${T.line}` }}
        >
          <span className="text-[13px] font-medium" style={{ ...body, color: T.ash }}>
            {profile?.comped ? "Free, permanent access" : profile?.subscriptionStatus === "active" || profile?.subscriptionStatus === "trialing" ? "Manage Subscription" : "Choose a Plan"}
          </span>
          <ChevronRight size={16} color={T.ashFaint} />
        </button>
        <button
          onClick={onOpenPayouts}
          className="w-full mb-6 p-4 flex items-center justify-between"
          style={{ background: T.panel, borderRadius: 6, border: `1px solid ${profile?.payoutsEnabled ? T.good : T.line}` }}
        >
          <span className="text-[13px] font-medium flex items-center gap-1.5" style={{ ...body, color: profile?.payoutsEnabled ? T.good : T.ash }}>
            {profile?.payoutsEnabled && <Check size={14} strokeWidth={2.5} />}
            {profile?.payoutsEnabled ? "Payouts Active" : "Set Up Payouts"}
          </span>
          <ChevronRight size={16} color={T.ashFaint} />
        </button>

        <Eyebrow>Security</Eyebrow>
        <button
          onClick={() => { setShowPasswordForm(!showPasswordForm); setPasswordError(""); setPasswordSuccess(false); }}
          className="w-full flex items-center justify-between py-3 px-4 mb-2"
          style={{ background: T.panel, borderRadius: 6, border: `1px solid ${T.line}` }}
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
              className="w-full py-3 font-semibold text-[14px]"
              style={{ ...display, background: T.ash, color: "#FFFFFF", borderRadius: 4, opacity: passwordSaving || !currentPassword || !newPassword ? 0.6 : 1 }}
            >
              {passwordSaving ? "Updating…" : "Update Password"}
            </button>
          </form>
        )}

        <div className="mb-6" />

        <Eyebrow>Legal</Eyebrow>
        <button
          onClick={() => setShowLegal(true)}
          className="w-full mb-6 p-4 flex items-center justify-between"
          style={{ background: T.panel, borderRadius: 6, border: `1px solid ${T.line}` }}
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
          style={{ background: T.panel, borderRadius: 6, border: `1px solid ${T.line}`, textDecoration: "none" }}
        >
          <span className="text-[13px] font-medium" style={{ ...body, color: T.ash }}>Get help on Discord</span>
          <ChevronRight size={16} color={T.ashFaint} />
        </a>

        <div className="mb-4">
          <button
            onClick={onLogout}
            className="w-full py-3 font-medium text-[14px] flex items-center justify-center gap-2"
            style={{ ...body, border: `1px solid ${T.alert}`, color: T.alert, borderRadius: 4 }}
          >
            <LogOut size={15} /> Log Out
          </button>
        </div>

        {!showDelete ? (
          <button onClick={() => setShowDelete(true)} className="w-full text-center text-[13px] font-medium py-2 mb-4" style={{ ...body, color: T.alert }}>
            Delete Account
          </button>
        ) : (
          <div className="p-4 mb-4" style={{ background: "rgba(188,51,39,0.08)", border: `1px solid ${T.alert}`, borderRadius: 6 }}>
            <div className="text-[13px] font-semibold mb-1" style={{ ...display, color: T.ash }}>Delete your account?</div>
            <p className="text-[12px] mb-3" style={{ ...body, color: T.ashDim }}>
              This permanently deletes your owner account. Any fields you've claimed are released back to unclaimed — you or someone else would need to reclaim them. This can't be undone. Enter your password to confirm.
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
              <button onClick={() => { setShowDelete(false); setDeletePassword(""); setDeleteError(""); }} className="flex-1 py-2.5 text-[12px] font-medium" style={{ ...body, border: `1px solid ${T.line}`, color: T.ashDim, borderRadius: 4 }}>
                Cancel
              </button>
              <button
                onClick={submitDelete}
                disabled={deleting || !deletePassword}
                className="flex-1 py-2.5 text-[12px] font-semibold"
                style={{ ...display, background: T.alert, color: "#FFFFFF", borderRadius: 4, opacity: deleting || !deletePassword ? 0.6 : 1 }}
              >
                {deleting ? "Deleting…" : "Delete Permanently"}
              </button>
            </div>
          </div>
        )}

        <p className="text-[11px] text-center" style={{ ...body, color: T.ashFaint }}>Atlas Field Owner</p>
      </div>

      {showLegal && (
        <div onClick={() => setShowLegal(false)} className="fixed inset-0 flex items-end" style={{ background: "rgba(0,0,0,0.5)", zIndex: 1500 }}>
          <div onClick={(e) => e.stopPropagation()} className="w-full max-h-[85vh] flex flex-col" style={{ background: T.void, borderTopLeftRadius: 16, borderTopRightRadius: 16 }}>
            <div className="px-5 pt-4 pb-3 flex items-center justify-between" style={{ borderBottom: `1px solid ${T.line}` }}>
              <h2 className="text-[16px] font-semibold" style={{ ...display, color: T.ash }}>Legal</h2>
              <button onClick={() => setShowLegal(false)} className="w-8 h-8 flex items-center justify-center">
                <X size={18} color={T.ashDim} />
              </button>
            </div>
            <div className="px-5 flex gap-1" style={{ borderBottom: `1px solid ${T.line}` }}>
              {LEGAL_TABS.map((t) => (
                <button
                  key={t.key}
                  onClick={() => setLegalTab(t.key)}
                  className="px-2 py-2 text-[12px] font-semibold"
                  style={{ ...body, color: legalTab === t.key ? T.ash : T.ashFaint, borderBottom: legalTab === t.key ? `2px solid ${T.ash}` : "2px solid transparent" }}
                >
                  {t.label}
                </button>
              ))}
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4">
              <p className="text-[12px] whitespace-pre-wrap" style={{ ...body, color: T.ashDim, lineHeight: 1.6 }}>{LEGAL_TABS.find((t) => t.key === legalTab).text}</p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
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
          <div className="flex items-center gap-3 mb-3 p-3" style={{ background: T.panel, borderRadius: 6, border: `1px solid ${T.line}` }}>
            <span className="text-[16px] font-semibold" style={{ ...display, color: T.accent }}>1</span>
            <span className="text-[13px]" style={{ ...body, color: T.ash }}>Tap the Share button in Safari's toolbar</span>
          </div>
          <div className="flex items-center gap-3 p-3" style={{ background: T.panel, borderRadius: 6, border: `1px solid ${T.line}` }}>
            <span className="text-[16px] font-semibold" style={{ ...display, color: T.accent }}>2</span>
            <span className="text-[13px]" style={{ ...body, color: T.ash }}>Scroll down and tap "Add to Home Screen"</span>
          </div>
        </div>
      ) : deferredPrompt ? (
        <button
          onClick={handleInstallClick}
          disabled={installing}
          className="w-full py-3.5 font-semibold text-[14px]"
          style={{ ...display, background: T.ash, color: "#FFFFFF", borderRadius: 4, maxWidth: 320, opacity: installing ? 0.6 : 1 }}
        >
          {installing ? "Opening…" : "Install Atlas Owners"}
        </button>
      ) : (
        <div className="w-full text-left" style={{ maxWidth: 320 }}>
          <div className="flex items-center gap-3 p-3" style={{ background: T.panel, borderRadius: 6, border: `1px solid ${T.line}` }}>
            <span className="text-[16px] font-semibold" style={{ ...display, color: T.accent }}>1</span>
            <span className="text-[13px]" style={{ ...body, color: T.ash }}>Open your browser's menu and tap "Add to Home Screen" or "Install App"</span>
          </div>
        </div>
      )}

      <p className="text-[11px] mt-6" style={{ ...body, color: T.ashFaint }}>Already installed? Open Atlas Owners from your Home Screen instead of this browser tab.</p>
    </div>
  );
}

/* ---------- App shell ---------- */
export default function App() {
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
    const setRealHeight = () => {
      const current = window.visualViewport ? window.visualViewport.height : window.innerHeight;
      const cached = parseInt(sessionStorage.getItem("atlas-known-good-height") || "0", 10);
      const real = Math.max(current, cached);
      sessionStorage.setItem("atlas-known-good-height", String(real));
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

  const { user, profile, authLoading, signUp, signIn, signOut, updateOwnerName, acceptTerms, changePassword, deleteAccount } = useOwnerAuth();

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
    if (!profile?.stripeConnectAccountId || profile?.payoutsEnabled) return;
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
  }, [profile?.stripeConnectAccountId, profile?.payoutsEnabled]);

  const { fields: allFields, fieldsLoading: allFieldsLoading } = useAllFields();
  const { fields: myFields, fieldsLoading: myFieldsLoading } = useMyFields(user?.uid);
  const { fields: pendingFields, pendingLoading } = useMyPendingClaims(user?.uid);
  const { claimField, updateFieldProfile } = useFieldActions();

  const [activeTab, setActiveTab] = useState("dashboard"); // dashboard | events | analytics | roster | settings
  const [overlay, setOverlay] = useState(null); // null | claim | field | eventEdit | roster
  const [activeFieldId, setActiveFieldId] = useState(null);
  const [editingEvent, setEditingEvent] = useState(null); // null = new event
  const [rosterEvent, setRosterEvent] = useState(null);

  const activeField = myFields.find((f) => f.id === activeFieldId) || allFields.find((f) => f.id === activeFieldId);
  const myFieldIds = myFields.map((f) => f.id);
  const { events: allMyEvents, eventsLoading: allMyEventsLoading } = useOwnerEvents(myFieldIds);
  const { createEvent, updateEvent, deleteEvent, duplicateEvent, newEventId } = useOwnerEventActions();
  const { activity, totalSignatures, activityLoading } = useRecentActivity(myFieldIds);
  const { banned, bannedLoading } = useBannedPlayers(rosterEvent?.fieldId);
  const { banPlayer, unbanPlayer } = useBanActions();

  const openField = (fieldId) => { setActiveFieldId(fieldId); setOverlay("field"); };
  const openClaim = () => setOverlay("claim");
  const openEventEdit = (field, ev) => { setActiveFieldId(field.id); setEditingEvent(ev || null); setOverlay("eventEdit"); };
  const openEventOverview = (field, ev) => { setActiveFieldId(field.id); setEditingEvent(ev); setOverlay("eventOverview"); };
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
  } else if (profile.acceptedTermsVersion !== CURRENT_TERMS_VERSION) {
    content = <LegalAgreementScreen onAccept={() => acceptTerms(CURRENT_TERMS_VERSION)} />;
  } else if (
    myFields.length > 0 &&
    !profile.comped &&
    profile.subscriptionStatus !== "active" &&
    profile.subscriptionStatus !== "trialing"
  ) {
    // A real gate, not just a Settings entry — once an owner has actually
    // claimed a field (not before; claiming itself always stays open),
    // they can't go any further without a real plan. Reuses the exact
    // same BillingScreen used from Settings — no onBack here is what
    // turns it from an optional page into a hard block.
    content = <BillingScreen profile={profile} />;
  } else if (overlay === "claim") {
    content = (
      <ClaimFieldScreen
        onBack={closeOverlay}
        allFields={allFields}
        allFieldsLoading={allFieldsLoading}
        ownerId={user.uid}
        ownerEmail={user.email}
        claimField={claimField}
        onClaimed={(fieldId) => { setActiveFieldId(fieldId); setOverlay("field"); }}
      />
    );
  } else if (overlay === "billing") {
    content = <BillingScreen profile={profile} onBack={closeOverlay} />;
  } else if (overlay === "payouts") {
    content = <PayoutsScreen profile={profile} onBack={closeOverlay} checking={checkingPayouts} />;
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
  } else if (overlay === "eventOverview" && activeField && editingEvent) {
    content = (
      <EventOverviewScreen
        ev={editingEvent}
        onBack={closeOverlay}
        onEdit={() => openEventEdit(activeField, editingEvent)}
        onOpenRoster={openRoster}
      />
    );
  } else if (overlay === "eventEdit" && activeField) {
    content = (
      <EventEditScreen
        field={activeField}
        existing={editingEvent}
        onBack={closeOverlay}
        createEvent={createEvent}
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
          onNewEvent={(field) => openEventEdit(field, null)}
          onEditEvent={openEventEdit}
          onOpenOverview={openEventOverview}
          onOpenRoster={openRoster}
          deleteEvent={deleteEvent}
          duplicateEvent={duplicateEvent}
          updateEvent={updateEvent}
        />
      );
    } else if (activeTab === "analytics") {
      content = (
        <AnalyticsScreen
          events={allMyEvents}
          eventsLoading={allMyEventsLoading}
          totalSignatures={totalSignatures}
          activityLoading={activityLoading}
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
          onOpenBilling={() => setOverlay("billing")}
          onOpenPayouts={() => setOverlay("payouts")}
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
          onOpenEventsList={() => setActiveTab("events")}
          onCreateEvent={() => {
            if (myFields.length > 0) openEventEdit(myFields[0], null);
            else openClaim();
          }}
          onOpenEvent={(ev) => openEventOverview(myFields.find((f) => f.id === ev.fieldId) || myFields[0], ev)}
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
      </div>
    </div>
  );
}
