import { useEffect, useState } from "react";
import { collection, deleteDoc, doc, getDocs, onSnapshot, orderBy, query, serverTimestamp, setDoc, updateDoc, where } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { db, functions } from "../lib/firebase";

// Every field, for the "claim a field" search/browse flow. Same public
// data the player app already reads — no separate owner-facing copy of
// this data exists, it's literally the same documents.
export function useAllFields() {
  const [fields, setFields] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const unsub = onSnapshot(
      query(collection(db, "fields"), orderBy("name")),
      (snap) => {
        setFields(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
        setLoading(false);
      },
      (err) => {
        console.error("useAllFields error:", err);
        setLoading(false);
      }
    );
    return unsub;
  }, []);

  return { fields, fieldsLoading: loading };
}

// Just the fields this owner has actually claimed.
export function useMyFields(uid) {
  const [fields, setFields] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!uid) {
      setFields([]);
      setLoading(false);
      return;
    }
    const unsub = onSnapshot(
      query(collection(db, "fields"), where("ownerId", "==", uid)),
      (snap) => {
        setFields(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
        setLoading(false);
      },
      (err) => {
        console.error("useMyFields error:", err);
        setLoading(false);
      }
    );
    return unsub;
  }, [uid]);

  return { fields, fieldsLoading: loading };
}

// Fields this owner has a pending, unreviewed claim request on — website-
// less fields route here instead of instant ownership, since there's
// nothing to verify the claim against automatically yet.
export function useMyPendingClaims(uid) {
  const [fields, setFields] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!uid) {
      setFields([]);
      setLoading(false);
      return;
    }
    const unsub = onSnapshot(
      query(collection(db, "fields"), where("claimRequestedBy", "==", uid), where("claimPending", "==", true)),
      (snap) => {
        setFields(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
        setLoading(false);
      },
      (err) => {
        console.error("useMyPendingClaims error:", err);
        setLoading(false);
      }
    );
    return unsub;
  }, [uid]);

  return { fields, pendingLoading: loading };
}

export function useFieldActions() {
  // Three real paths now, matching the Firestore rules and the new
  // website-verification Cloud Functions:
  //  - The claiming account's email matches the field's known
  //    ownerEmailDomain -> instant, verified claim, written directly here
  //    (Firestore rules enforce the domain match themselves too).
  //  - Email doesn't match (or the field has no domain on file at all) but
  //    the field DOES have a real website -> can't be verified client-side
  //    at all, so this returns "verify-website" instead of writing
  //    anything; the caller drives requestClaimCode/verifyWebsiteClaim
  //    below, which do the actual write server-side once the code is
  //    confirmed live on that site. This is the fix for "owners with a
  //    different email address than their domain name" — they're no
  //    longer stuck, they just prove it a different way.
  //  - No website on file at all (Facebook-only fields) -> nothing can be
  //    automatically verified, so this claims instantly anyway rather than
  //    stalling on manual review, flagged claimVerification: "unverified"
  //    for a possible later spot-check. A bad claim here can only affect
  //    listing content — Stripe's own KYC gates any real payout — so this
  //    is a low-risk default, not a security hole.
  // Returns "claimed", "verify-website", or "claimed-unverified" so the UI
  // can show the right next step.
  async function claimField(field, ownerEmail, ownerId) {
    const emailDomain = (ownerEmail || "").split("@")[1];
    if (field.ownerEmailDomain && emailDomain === field.ownerEmailDomain) {
      await updateDoc(doc(db, "fields", field.id), {
        ownerId,
        claimed: true,
        claimVerification: "domain",
      });
      return "claimed";
    }
    if (field.website) {
      return "verify-website";
    }
    await updateDoc(doc(db, "fields", field.id), {
      ownerId,
      claimed: true,
      claimVerification: "unverified",
    });
    return "claimed-unverified";
  }

  // Step 1 of the website-verification flow: ask the server for a short
  // code to paste somewhere on the field's own site. Returns { code,
  // website } — requesting a code grants nothing by itself.
  async function requestClaimCode(fieldId) {
    const requestCode = httpsCallable(functions, "requestFieldClaimCode");
    const res = await requestCode({ fieldId });
    return res.data;
  }

  // Step 2: tell the server to go fetch that site and look for the code.
  // Returns { verified: boolean } — only a true result means the field was
  // actually claimed (the Cloud Function does that write itself).
  async function verifyWebsiteClaim(fieldId) {
    const verify = httpsCallable(functions, "verifyWebsiteClaim");
    const res = await verify({ fieldId });
    return res.data;
  }

  // Accepts any subset of the same fields the player app already knows how
  // to display — about, hours, amenities (array), rules (array), chrono
  // ({aeg, sniper, dmr}), rentals (array of {name, price, includes,
  // availability}). Nothing new to build on the player side; it already
  // renders these if present.
  async function updateFieldProfile(fieldId, fields) {
    await updateDoc(doc(db, "fields", fieldId), fields);
    // Events store the field's name denormalized (fieldName) so the player
    // app can display it without a join — same tradeoff already made for
    // team names. That means a rename here needs to explicitly re-sync
    // every one of this field's events, or they'd keep showing the old
    // name forever. Same pattern already used for team renames.
    if (fields.name) {
      const eventsSnap = await getDocs(query(collection(db, "events"), where("fieldId", "==", fieldId)));
      await Promise.all(
        eventsSnap.docs.map((d) => updateDoc(doc(db, "events", d.id), { fieldName: fields.name }).catch(() => {}))
      );
    }
  }

  return { claimField, requestClaimCode, verifyWebsiteClaim, updateFieldProfile };
}

// Banned players for a specific field — private to that field's owner.
export function useBannedPlayers(fieldId) {
  const [banned, setBanned] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!fieldId) {
      setBanned([]);
      setLoading(false);
      return;
    }
    const unsub = onSnapshot(
      collection(db, "fields", fieldId, "bannedPlayers"),
      (snap) => {
        setBanned(snap.docs.map((d) => ({ uid: d.id, ...d.data() })));
        setLoading(false);
      },
      (err) => {
        console.error("useBannedPlayers error:", err);
        setLoading(false);
      }
    );
    return unsub;
  }, [fieldId]);

  return { banned, bannedLoading: loading };
}

export function useBanActions() {
  async function banPlayer(fieldId, uid, name) {
    await setDoc(doc(db, "fields", fieldId, "bannedPlayers", uid), { name, bannedAt: serverTimestamp() });
  }
  async function unbanPlayer(fieldId, uid) {
    await deleteDoc(doc(db, "fields", fieldId, "bannedPlayers", uid));
  }
  return { banPlayer, unbanPlayer };
}
