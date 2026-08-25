import React, { useState } from "react";
import {
  Shield, LogOut, ChevronLeft, ChevronRight, Search, Plus, Trash2, Check,
  ArrowRight, Calendar, MapPin,
} from "lucide-react";
import { useOwnerAuth } from "./hooks/useOwnerAuth";
import { useAllFields, useMyFields, useMyPendingClaims, useFieldActions } from "./hooks/useOwnerFields";
import { useOwnerEvents, useOwnerEventActions } from "./hooks/useOwnerEvents";

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
`;
const display = { fontFamily: "'Space Grotesk', sans-serif" };
const body = { fontFamily: "'Inter', sans-serif" };
const mono = { fontFamily: "'Inter', sans-serif", fontVariantNumeric: "tabular-nums" };
const flatBg = { background: T.void };

function Eyebrow({ children }) {
  return (
    <div className="text-[11px] font-semibold uppercase mb-2" style={{ ...mono, color: T.ashFaint, letterSpacing: "0.04em" }}>
      {children}
    </div>
  );
}

function TextField({ label, value, onChange, placeholder, type = "text", rows }) {
  const Tag = rows ? "textarea" : "input";
  return (
    <div className="mb-3">
      {label && <label className="text-[10px] font-semibold uppercase block mb-1" style={{ ...mono, color: T.ashFaint, letterSpacing: "0.04em" }}>{label}</label>}
      <Tag
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        type={rows ? undefined : type}
        rows={rows}
        className="w-full px-3 py-2.5 text-[14px] bg-transparent outline-none"
        style={{ ...body, background: T.panelAlt, border: `1px solid ${T.line}`, borderRadius: 4, color: T.ash, resize: rows ? "none" : undefined }}
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
        <div className="w-14 h-14 flex items-center justify-center mb-3" style={{ background: T.panelAlt, border: `1px solid ${T.line}`, borderRadius: 4 }}>
          <Shield color={T.ash} size={24} strokeWidth={1.6} />
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
function DashboardScreen({ profile, myFields, myFieldsLoading, pendingFields, pendingLoading, onOpenField, onOpenClaim, onLogout }) {
  return (
    <div className="h-full overflow-y-auto pb-10" style={flatBg}>
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
    <div className="h-full overflow-y-auto pb-10" style={flatBg}>
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
function FieldManageScreen({ field, onBack, updateFieldProfile, onOpenEvents }) {
  const [about, setAbout] = useState(field.about || "");
  const [hours, setHours] = useState(field.hours || "");
  const [amenitiesText, setAmenitiesText] = useState((field.amenities || []).join("\n"));
  const [rulesText, setRulesText] = useState((field.rules || []).join("\n"));
  const [chronoAeg, setChronoAeg] = useState(field.chrono?.aeg || "");
  const [chronoSniper, setChronoSniper] = useState(field.chrono?.sniper || "");
  const [chronoDmr, setChronoDmr] = useState(field.chrono?.dmr || "");
  const [rentals, setRentals] = useState(field.rentals || []);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  const addRental = () => setRentals([...rentals, { name: "", price: "", includes: "", availability: "" }]);
  const updateRental = (i, key, value) => {
    const next = [...rentals];
    next[i] = { ...next[i], [key]: value };
    setRentals(next);
  };
  const removeRental = (i) => setRentals(rentals.filter((_, idx) => idx !== i));

  const handleSave = async () => {
    setSaving(true);
    setSaved(false);
    setError("");
    try {
      const amenities = amenitiesText.split("\n").map((s) => s.trim()).filter(Boolean);
      const rules = rulesText.split("\n").map((s) => s.trim()).filter(Boolean);
      const chrono = (chronoAeg || chronoSniper || chronoDmr) ? { aeg: chronoAeg, sniper: chronoSniper, dmr: chronoDmr } : null;
      const cleanRentals = rentals.filter((r) => r.name.trim());
      await updateFieldProfile(field.id, { about, hours, amenities, rules, chrono, rentals: cleanRentals });
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (err) {
      setError("Couldn't save — try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="h-full overflow-y-auto pb-10" style={flatBg}>
      <div className="px-6 pt-2 pb-4 flex items-center" style={{ borderBottom: `1px solid ${T.line}` }}>
        <button onClick={onBack} className="w-9 h-9 -ml-2 flex items-center justify-center">
          <ChevronLeft size={20} color={T.ash} />
        </button>
        <h1 className="flex-1 text-center text-[18px] font-semibold mr-9" style={{ ...display, color: T.ash }}>{field.name}</h1>
      </div>

      <div className="px-6 pt-4">
        <button
          onClick={onOpenEvents}
          className="w-full mb-5 p-4 flex items-center gap-3 text-left"
          style={{ background: T.panel, borderRadius: 6, border: `1.5px solid ${T.accent}` }}
        >
          <Calendar size={18} color={T.accent} />
          <div className="flex-1 text-[14px] font-semibold" style={{ ...display, color: T.ash }}>Manage Events</div>
          <ChevronRight size={16} color={T.ashFaint} />
        </button>

        <Eyebrow>Field Profile</Eyebrow>
        <TextField label="About" value={about} onChange={setAbout} rows={3} placeholder="Tell players about your field…" />
        <TextField label="Hours" value={hours} onChange={setHours} placeholder="e.g. Sat 9am–5pm, reservations required" />
        <TextField label="Amenities (one per line)" value={amenitiesText} onChange={setAmenitiesText} rows={4} placeholder={"Pro Shop\nHPA Fill Station\nRentals Available"} />
        <TextField label="Field Rules (one per line)" value={rulesText} onChange={setRulesText} rows={5} placeholder="Full-seal eye protection required at all times…" />

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

        {error && <p className="text-[12px] mb-2" style={{ ...body, color: T.alert }}>{error}</p>}
        {saved && <p className="text-[12px] mb-2" style={{ ...body, color: T.good }}>Saved — live on the player app now.</p>}
        <div className="mb-6">
          <PrimaryButton onClick={handleSave} disabled={saving}>{saving ? "Saving…" : "Save Field Profile"}</PrimaryButton>
        </div>
      </div>
    </div>
  );
}

/* ---------- Events list + edit ---------- */
function EventsListScreen({ field, events, eventsLoading, onBack, onNewEvent, onEditEvent, deleteEvent }) {
  return (
    <div className="h-full overflow-y-auto pb-10" style={flatBg}>
      <div className="px-6 pt-2 pb-4 flex items-center" style={{ borderBottom: `1px solid ${T.line}` }}>
        <button onClick={onBack} className="w-9 h-9 -ml-2 flex items-center justify-center">
          <ChevronLeft size={20} color={T.ash} />
        </button>
        <h1 className="flex-1 text-center text-[18px] font-semibold mr-9" style={{ ...display, color: T.ash }}>Events — {field.name}</h1>
      </div>

      <div className="px-6 pt-4">
        <div className="mb-4">
          <PrimaryButton onClick={onNewEvent}>+ New Event</PrimaryButton>
        </div>

        {eventsLoading ? (
          <div className="text-[13px] py-6 text-center" style={{ ...body, color: T.ashFaint }}>Loading…</div>
        ) : events.length === 0 ? (
          <div className="text-[13px] py-6 text-center" style={{ ...body, color: T.ashFaint }}>No events yet for this field.</div>
        ) : (
          events.map((ev) => (
            <div key={ev.id} className="mb-3 p-4" style={{ background: T.panel, borderRadius: 6, border: `1px solid ${T.line}` }}>
              <div className="flex items-start justify-between mb-1">
                <div className="text-[14px] font-semibold" style={{ ...display, color: T.ash }}>{ev.title}</div>
                {ev.price && <div className="text-[12px] font-semibold" style={{ ...mono, color: T.accent }}>{ev.price}</div>}
              </div>
              <div className="text-[12px] mb-3" style={{ ...body, color: T.ashFaint }}>
                {ev.date}{ev.endDate ? ` – ${ev.endDate}` : ""}{ev.startTime ? ` · ${ev.startTime}` : ""}
              </div>
              <div className="flex gap-2">
                <button onClick={() => onEditEvent(ev)} className="flex-1 py-2 text-[12px] font-medium" style={{ ...body, border: `1px solid ${T.line}`, color: T.ashDim, borderRadius: 4 }}>
                  Edit
                </button>
                <button onClick={() => deleteEvent(ev.id)} className="px-3 py-2 text-[12px] font-medium" style={{ ...body, border: `1px solid ${T.alert}`, color: T.alert, borderRadius: 4 }}>
                  Delete
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function EventEditScreen({ field, existing, onBack, createEvent, updateEvent }) {
  const [title, setTitle] = useState(existing?.title || "");
  const [date, setDate] = useState(existing?.date || "");
  const [endDate, setEndDate] = useState(existing?.endDate || "");
  const [startTime, setStartTime] = useState(existing?.startTime || "");
  const [price, setPrice] = useState(existing?.price || "");
  const [type, setType] = useState(existing?.type || "OUTDOOR");
  const [description, setDescription] = useState(existing?.description || "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const handleSave = async () => {
    if (!title.trim() || !date) {
      setError("Title and date are required.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const data = {
        title: title.trim(),
        date,
        endDate: endDate || null,
        startTime: startTime || null,
        price: price || null,
        type,
        description: description.trim(),
        sourceUrl: field.website || "",
      };
      if (existing) {
        await updateEvent(existing.id, data);
      } else {
        await createEvent(field.id, field.name, data);
      }
      onBack();
    } catch (err) {
      setError("Couldn't save — try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="h-full overflow-y-auto pb-10" style={flatBg}>
      <div className="px-6 pt-2 pb-4 flex items-center" style={{ borderBottom: `1px solid ${T.line}` }}>
        <button onClick={onBack} className="w-9 h-9 -ml-2 flex items-center justify-center">
          <ChevronLeft size={20} color={T.ash} />
        </button>
        <h1 className="flex-1 text-center text-[18px] font-semibold mr-9" style={{ ...display, color: T.ash }}>{existing ? "Edit Event" : "New Event"}</h1>
      </div>

      <div className="px-6 pt-4">
        <TextField label="Title" value={title} onChange={setTitle} placeholder="Event name" />
        <div className="flex gap-2">
          <div className="flex-1">
            <TextField label="Date" value={date} onChange={setDate} type="date" />
          </div>
          <div className="flex-1">
            <TextField label="End Date (optional)" value={endDate} onChange={setEndDate} type="date" />
          </div>
        </div>
        <TextField label="Start Time" value={startTime} onChange={setStartTime} placeholder="e.g. 9:00 AM (gates), 11:00 AM start" />
        <TextField label="Price" value={price} onChange={setPrice} placeholder="e.g. $20 or Price varies" />

        <div className="mb-3">
          <label className="text-[10px] font-semibold uppercase block mb-1" style={{ ...mono, color: T.ashFaint, letterSpacing: "0.04em" }}>Type</label>
          <div className="flex gap-2 flex-wrap">
            {["OUTDOOR", "MILSIM", "INDOOR", "TOURNAMENT"].map((t) => (
              <button
                key={t}
                onClick={() => setType(t)}
                className="px-3 py-1.5 text-[12px] font-medium"
                style={{ ...body, border: `1px solid ${type === t ? T.accent : T.line}`, background: type === t ? T.accent : "transparent", color: type === t ? "#fff" : T.ashDim, borderRadius: 4 }}
              >
                {t}
              </button>
            ))}
          </div>
        </div>

        <TextField label="Description" value={description} onChange={setDescription} rows={4} placeholder="What players should know about this event…" />

        {error && <p className="text-[12px] mb-2" style={{ ...body, color: T.alert }}>{error}</p>}
        <div className="mb-6">
          <PrimaryButton onClick={handleSave} disabled={saving}>{saving ? "Saving…" : existing ? "Save Changes" : "Create Event"}</PrimaryButton>
        </div>
      </div>
    </div>
  );
}

/* ---------- App shell ---------- */
export default function App() {
  const { user, profile, authLoading, signUp, signIn, signOut } = useOwnerAuth();
  const { fields: allFields, fieldsLoading: allFieldsLoading } = useAllFields();
  const { fields: myFields, fieldsLoading: myFieldsLoading } = useMyFields(user?.uid);
  const { fields: pendingFields, pendingLoading } = useMyPendingClaims(user?.uid);
  const { claimField, updateFieldProfile } = useFieldActions();

  const [screen, setScreen] = useState("dashboard"); // dashboard | claim | field | events | eventEdit
  const [activeFieldId, setActiveFieldId] = useState(null);
  const [editingEvent, setEditingEvent] = useState(null); // null = new event

  const activeField = myFields.find((f) => f.id === activeFieldId) || allFields.find((f) => f.id === activeFieldId);
  const activeFieldOwnedIds = activeField ? [activeField.id] : [];
  const { events, eventsLoading } = useOwnerEvents(activeFieldOwnedIds);
  const { createEvent, updateEvent, deleteEvent } = useOwnerEventActions();

  const handleLogout = async () => {
    await signOut();
    setScreen("dashboard");
  };

  if (authLoading) {
    return (
      <div className="h-screen flex items-center justify-center" style={flatBg}>
        <style>{FONTS}</style>
        <p className="text-[13px]" style={{ ...body, color: T.ashDim }}>Loading…</p>
      </div>
    );
  }

  let content;
  if (!user) {
    content = <LoginScreen signIn={signIn} signUp={signUp} />;
  } else if (screen === "claim") {
    content = (
      <ClaimFieldScreen
        onBack={() => setScreen("dashboard")}
        allFields={allFields}
        allFieldsLoading={allFieldsLoading}
        ownerId={user.uid}
        ownerEmail={user.email}
        claimField={claimField}
        onClaimed={(fieldId) => { setActiveFieldId(fieldId); setScreen("field"); }}
      />
    );
  } else if (screen === "field" && activeField) {
    content = (
      <FieldManageScreen
        field={activeField}
        onBack={() => setScreen("dashboard")}
        updateFieldProfile={updateFieldProfile}
        onOpenEvents={() => setScreen("events")}
      />
    );
  } else if (screen === "events" && activeField) {
    content = (
      <EventsListScreen
        field={activeField}
        events={events}
        eventsLoading={eventsLoading}
        onBack={() => setScreen("field")}
        onNewEvent={() => { setEditingEvent(null); setScreen("eventEdit"); }}
        onEditEvent={(ev) => { setEditingEvent(ev); setScreen("eventEdit"); }}
        deleteEvent={deleteEvent}
      />
    );
  } else if (screen === "eventEdit" && activeField) {
    content = (
      <EventEditScreen
        field={activeField}
        existing={editingEvent}
        onBack={() => setScreen("events")}
        createEvent={createEvent}
        updateEvent={updateEvent}
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
        onOpenField={(fieldId) => { setActiveFieldId(fieldId); setScreen("field"); }}
        onOpenClaim={() => setScreen("claim")}
        onLogout={handleLogout}
      />
    );
  }

  return (
    <div className="w-full h-screen flex flex-col" style={{ background: T.void }}>
      <style>{FONTS}</style>
      <div className="flex-1 min-h-0 relative">{content}</div>
    </div>
  );
}
