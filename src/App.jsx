import React, { useState } from "react";
import {
  Shield, LogOut, ChevronLeft, ChevronRight, Search, Plus, Trash2, Check,
  ArrowRight, Calendar, MapPin, Copy, FileSignature, Image as ImageIcon, TrendingUp,
} from "lucide-react";
import { useOwnerAuth } from "./hooks/useOwnerAuth";
import { useAllFields, useMyFields, useMyPendingClaims, useFieldActions } from "./hooks/useOwnerFields";
import { useOwnerEvents, useOwnerEventActions } from "./hooks/useOwnerEvents";
import { useEventWaivers, useRecentActivity } from "./hooks/useEventWaivers";
import { storage } from "./lib/firebase";
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

function parsePrice(str) {
  const m = (str || "").match(/[\d.]+/);
  return m ? parseFloat(m[0]) : null;
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
function DashboardScreen({ profile, myFields, myFieldsLoading, pendingFields, pendingLoading, events, eventsLoading, activity, activityLoading, onOpenField, onOpenClaim, onOpenEventsList, onOpenEvent, onLogout }) {
  const today = localDateStr();
  const upcoming = events.filter((e) => !e.draft && e.date >= today).sort((a, b) => a.date.localeCompare(b.date));
  const totalInterest = events.reduce((sum, e) => sum + (e.interestCount || 0), 0);

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
          </>
        )}

        <div className="mb-4">
          <PrimaryButton onClick={onOpenEventsList} tone="ash">+ Create New Event</PrimaryButton>
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
                  {ev.interestCount > 0 && (
                    <span className="text-[11px] font-semibold" style={{ ...mono, color: T.accent }}>{ev.interestCount} interested</span>
                  )}
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
const PRESET_AMENITIES = ["Pro Shop", "Chrono Station", "HPA Refills", "Rentals Available", "Parking", "Restrooms", "Food/Drinks", "Accepts Credit/Debit Cards"];

function FieldManageScreen({ field, onBack, updateFieldProfile, onOpenEvents }) {
  const [name, setName] = useState(field.name || "");
  const [address, setAddress] = useState(field.address || "");
  const [phone, setPhone] = useState(field.phone || "");
  const [email, setEmail] = useState(field.email || "");
  const [website, setWebsite] = useState(field.website || "");
  const [about, setAbout] = useState(field.about || "");
  const [hours, setHours] = useState(field.hours || "");
  const [amenities, setAmenities] = useState(field.amenities || []);
  const [customAmenity, setCustomAmenity] = useState("");
  const [rulesText, setRulesText] = useState((field.rules || []).join("\n"));
  const [chronoAeg, setChronoAeg] = useState(field.chrono?.aeg || "");
  const [chronoSniper, setChronoSniper] = useState(field.chrono?.sniper || "");
  const [chronoDmr, setChronoDmr] = useState(field.chrono?.dmr || "");
  const [rentals, setRentals] = useState(field.rentals || []);
  const [gallery, setGallery] = useState(field.galleryPhotos || []);
  const [galleryUploading, setGalleryUploading] = useState(false);
  const galleryInputRef = React.useRef(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

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
      await updateFieldProfile(field.id, {
        name, address, phone, email, website, about, hours, amenities, rules, chrono, rentals: cleanRentals,
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

        <Eyebrow>Basic Information</Eyebrow>
        <TextField label="Field Name" value={name} onChange={setName} />
        <TextField label="Street Address" value={address} onChange={setAddress} />
        {field.lat && (
          <p className="text-[10px] mb-3 -mt-2" style={{ ...body, color: T.ashFaint }}>
            Changing the address here won't move the map pin — that needs a separate re-geocoding pass. Contact support if the address changes significantly.
          </p>
        )}
        <TextField label="Contact Phone" value={phone} onChange={setPhone} placeholder="+1 (555) 000-0000" />
        <TextField label="Email Address" value={email} onChange={setEmail} placeholder="contact@yourfield.com" type="email" />
        <TextField label="Website" value={website} onChange={setWebsite} placeholder="https://yourfield.com" />

        <Eyebrow>About & Hours</Eyebrow>
        <TextField label="About" value={about} onChange={setAbout} rows={3} placeholder="Tell players about your field…" />
        <TextField label="Hours" value={hours} onChange={setHours} placeholder="e.g. Sat 9am–5pm, reservations required" />

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

        {error && <p className="text-[12px] mb-2" style={{ ...body, color: T.alert }}>{error}</p>}
        {saved && <p className="text-[12px] mb-2" style={{ ...body, color: T.good }}>Saved — live on the player app now.</p>}
        <div className="mb-6">
          <PrimaryButton onClick={handleSave} disabled={saving}>{saving ? "Saving…" : "Save Profile Changes"}</PrimaryButton>
        </div>
      </div>
    </div>
  );
}

/* ---------- Events list + edit ---------- */
function EventsListScreen({ field, events, eventsLoading, onBack, onNewEvent, onEditEvent, onOpenRoster, deleteEvent, duplicateEvent }) {
  const [tab, setTab] = useState("all"); // all | upcoming | past | drafts
  const today = localDateStr();

  const filtered = events.filter((ev) => {
    if (tab === "drafts") return ev.draft === true;
    if (ev.draft) return false; // drafts never show in All/Upcoming/Past
    if (tab === "upcoming") return (ev.endDate || ev.date) >= today;
    if (tab === "past") return (ev.endDate || ev.date) < today;
    return true;
  });

  const handleDuplicate = async (ev) => {
    const newId = await duplicateEvent(ev);
    onEditEvent({ ...ev, id: newId, title: `${ev.title} (Copy)`, date: "", draft: true });
  };

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
          <PrimaryButton onClick={onNewEvent}>+ Create New Event</PrimaryButton>
        </div>

        <div className="flex gap-1 mb-4" style={{ borderBottom: `1px solid ${T.line}` }}>
          {[["all", "All"], ["upcoming", "Upcoming"], ["past", "Past"], ["drafts", "Drafts"]].map(([key, label]) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className="px-3 py-2 text-[12px] font-semibold"
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
              <div className="flex items-start justify-between mb-1">
                <div className="flex items-center gap-2">
                  {ev.draft && (
                    <span className="text-[9px] font-semibold px-1.5 py-0.5" style={{ ...mono, color: T.ashFaint, border: `1px solid ${T.line}`, borderRadius: 2 }}>DRAFT</span>
                  )}
                  <div className="text-[14px] font-semibold" style={{ ...display, color: T.ash }}>{ev.title}</div>
                </div>
                {ev.price && <div className="text-[12px] font-semibold" style={{ ...mono, color: T.accent }}>{ev.price}</div>}
              </div>
              <div className="text-[12px] mb-2" style={{ ...body, color: T.ashFaint }}>
                {ev.date || "No date set"}{ev.endDate ? ` – ${ev.endDate}` : ""}{ev.startTime ? ` · ${ev.startTime}` : ""}
              </div>
              {ev.interestCount > 0 && (
                <div className="text-[11px] font-semibold mb-3" style={{ ...mono, color: T.accent }}>{ev.interestCount} interested</div>
              )}
              <div className="flex gap-2 flex-wrap">
                <button onClick={() => onEditEvent(ev)} className="flex-1 py-2 text-[12px] font-medium" style={{ ...body, border: `1px solid ${T.line}`, color: T.ashDim, borderRadius: 4 }}>
                  Edit
                </button>
                <button onClick={() => onOpenRoster(ev)} className="flex-1 py-2 text-[12px] font-medium flex items-center justify-center gap-1" style={{ ...body, border: `1px solid ${T.line}`, color: T.ashDim, borderRadius: 4 }}>
                  <FileSignature size={12} /> Waivers
                </button>
                <button onClick={() => handleDuplicate(ev)} className="px-3 py-2 text-[12px] font-medium flex items-center gap-1" style={{ ...body, border: `1px solid ${T.line}`, color: T.ashDim, borderRadius: 4 }}>
                  <Copy size={12} />
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

const GAME_TYPES = [
  { key: "OUTDOOR", label: "Outdoor Rec Play" },
  { key: "MILSIM", label: "MilSim" },
  { key: "INDOOR", label: "Indoor" },
  { key: "TOURNAMENT", label: "Tournament" },
];

function EventEditScreen({ field, existing, onBack, createEvent, updateEvent, newEventId }) {
  const [eventId] = useState(existing?.id || newEventId());
  const [title, setTitle] = useState(existing?.title || "");
  const [date, setDate] = useState(existing?.date || "");
  const [endDate, setEndDate] = useState(existing?.endDate || "");
  const [startTime, setStartTime] = useState(existing?.startTime || "");
  const [price, setPrice] = useState(existing?.price || "");
  const [maxCapacity, setMaxCapacity] = useState(existing?.maxCapacity || "");
  const [type, setType] = useState(existing?.type || "OUTDOOR");
  const [description, setDescription] = useState(existing?.description || "");
  const [imageUrl, setImageUrl] = useState(existing?.imageUrl || null);
  const [bannerUploading, setBannerUploading] = useState(false);
  const bannerInputRef = React.useRef(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

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

  const buildData = (draft) => ({
    title: title.trim(),
    date,
    endDate: endDate || null,
    startTime: startTime || null,
    price: price || null,
    maxCapacity: maxCapacity ? parseInt(maxCapacity, 10) : null,
    type,
    description: description.trim(),
    imageUrl: imageUrl || null,
    sourceUrl: field.website || "",
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
    <div className="h-full overflow-y-auto pb-10" style={flatBg}>
      <div className="px-6 pt-2 pb-4 flex items-center" style={{ borderBottom: `1px solid ${T.line}` }}>
        <button onClick={onBack} className="w-9 h-9 -ml-2 flex items-center justify-center">
          <ChevronLeft size={20} color={T.ash} />
        </button>
        <h1 className="flex-1 text-center text-[18px] font-semibold mr-9" style={{ ...display, color: T.ash }}>{existing ? "Edit Event" : "Create New Event"}</h1>
      </div>

      <div className="px-6 pt-4">
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
        <div className="flex gap-2">
          <div className="flex-1">
            <TextField label="Date" value={date} onChange={setDate} type="date" />
          </div>
          <div className="flex-1">
            <TextField label="End Date (optional)" value={endDate} onChange={setEndDate} type="date" />
          </div>
        </div>
        <TextField label="Start Time" value={startTime} onChange={setStartTime} placeholder="e.g. 9:00 AM (gates), 11:00 AM start" />

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
            <TextField label="Entry Cost" value={price} onChange={setPrice} placeholder="$25 or Price varies" />
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

        {error && <p className="text-[12px] mb-2" style={{ ...body, color: T.alert }}>{error}</p>}
        <div className="mb-2">
          <PrimaryButton onClick={() => handleSave(false)} disabled={saving}>{saving ? "Saving…" : "Publish Event"}</PrimaryButton>
        </div>
        <div className="mb-6">
          <button
            onClick={() => handleSave(true)}
            disabled={saving}
            className="w-full py-3 font-semibold text-[14px]"
            style={{ ...body, border: `1px solid ${T.line}`, color: T.ashDim, borderRadius: 4 }}
          >
            Save as Draft
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---------- Roster (real waiver signatures) ---------- */
function RosterScreen({ event, onBack }) {
  const { signatures, signaturesLoading } = useEventWaivers(event.id);

  return (
    <div className="h-full overflow-y-auto pb-10" style={flatBg}>
      <div className="px-6 pt-2 pb-4 flex items-center" style={{ borderBottom: `1px solid ${T.line}` }}>
        <button onClick={onBack} className="w-9 h-9 -ml-2 flex items-center justify-center">
          <ChevronLeft size={20} color={T.ash} />
        </button>
        <h1 className="flex-1 text-center text-[18px] font-semibold mr-9" style={{ ...display, color: T.ash }}>Waivers</h1>
      </div>

      <div className="px-6 pt-4">
        <div className="text-[13px] font-semibold mb-1" style={{ ...display, color: T.ash }}>{event.title}</div>
        <p className="text-[12px] mb-4" style={{ ...body, color: T.ashFaint }}>
          Everyone who's signed the waiver for this event. This isn't a confirmed attendance list — signing a waiver
          isn't the same as showing up. Real check-in tracking needs the QR scanner, which isn't built yet.
        </p>

        {signaturesLoading ? (
          <div className="text-[13px] py-6 text-center" style={{ ...body, color: T.ashFaint }}>Loading…</div>
        ) : signatures.length === 0 ? (
          <div className="p-6 flex flex-col items-center text-center" style={{ background: T.panel, borderRadius: 6, border: `1px solid ${T.line}` }}>
            <FileSignature size={22} color={T.ashDim} className="mb-2" />
            <div className="text-[13px] font-semibold" style={{ ...display, color: T.ash }}>No signatures yet</div>
          </div>
        ) : (
          signatures.map((s, i) => (
            <div key={i} className="mb-2 p-3 flex items-center justify-between" style={{ background: T.panel, borderRadius: 6, border: `1px solid ${T.line}` }}>
              <div className="text-[13px] font-medium" style={{ ...body, color: T.ash }}>{s.signedName}</div>
              <div className="text-[11px]" style={{ ...mono, color: T.ashFaint }}>
                {s.signedAt?.toDate ? s.signedAt.toDate().toLocaleDateString() : ""}
              </div>
            </div>
          ))
        )}
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

  const [screen, setScreen] = useState("dashboard"); // dashboard | claim | field | events | eventEdit | roster
  const [activeFieldId, setActiveFieldId] = useState(null);
  const [editingEvent, setEditingEvent] = useState(null); // null = new event
  const [rosterEvent, setRosterEvent] = useState(null);

  const activeField = myFields.find((f) => f.id === activeFieldId) || allFields.find((f) => f.id === activeFieldId);
  const myFieldIds = myFields.map((f) => f.id);
  const { events: allMyEvents, eventsLoading: allMyEventsLoading } = useOwnerEvents(myFieldIds);
  const { events: fieldEvents, eventsLoading: fieldEventsLoading } = useOwnerEvents(activeField ? [activeField.id] : []);
  const { createEvent, updateEvent, deleteEvent, duplicateEvent, newEventId } = useOwnerEventActions();
  const { activity, activityLoading } = useRecentActivity(myFieldIds);

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
        events={fieldEvents}
        eventsLoading={fieldEventsLoading}
        onBack={() => setScreen("field")}
        onNewEvent={() => { setEditingEvent(null); setScreen("eventEdit"); }}
        onEditEvent={(ev) => { setEditingEvent(ev); setScreen("eventEdit"); }}
        onOpenRoster={(ev) => { setRosterEvent(ev); setScreen("roster"); }}
        deleteEvent={deleteEvent}
        duplicateEvent={duplicateEvent}
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
        newEventId={newEventId}
      />
    );
  } else if (screen === "roster" && rosterEvent) {
    content = <RosterScreen event={rosterEvent} onBack={() => setScreen("events")} />;
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
        onOpenField={(fieldId) => { setActiveFieldId(fieldId); setScreen("field"); }}
        onOpenClaim={() => setScreen("claim")}
        onOpenEventsList={() => {
          if (myFields.length > 0) { setActiveFieldId(myFields[0].id); setScreen("events"); }
          else setScreen("claim");
        }}
        onOpenEvent={(ev) => { setActiveFieldId(ev.fieldId); setEditingEvent(ev); setScreen("eventEdit"); }}
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
