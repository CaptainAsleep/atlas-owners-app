// DRAFT TEMPLATES — NOT REVIEWED BY AN ATTORNEY. These need real legal
// review before this app relies on them in a real dispute. Bump
// CURRENT_TERMS_VERSION whenever the text changes meaningfully — that
// forces every existing owner to re-accept before they can keep using the
// app, the same way a first-time signup does. Separate from the player
// app's own legal text — owners agree to a version tailored to running a
// field, not to playing at one.
export const CURRENT_TERMS_VERSION = "2026-08-29";

export const TERMS_OF_USE = `Last updated: [DATE]

1. Acceptance of Terms
By creating a field-owner account or using the Atlas Field Owner app (the "App"), you agree to these Terms of Use. If you do not agree, do not use the App.

2. Eligibility & Authority
You must be authorized to act on behalf of any field you claim or manage. Claiming a field you do not have the authority to represent is a violation of these Terms.

3. What Atlas Is — and Isn't
Atlas is a platform that helps you list your field, manage events, and connect with players actively looking for games. Atlas is not a co-operator of your field, and does not supervise, staff, or assume any responsibility for events you create, run, or the actual conduct of play at your location. You remain solely responsible for your field's safety, rules, and legal compliance.

4. Your Listing & Content
You're responsible for the accuracy of your field's listing — hours, rules, amenities, pricing, and anything else you enter. You retain ownership of what you upload (photos, waiver text, event banners, etc.), but grant Atlas a license to store, display, and distribute it within the App as needed to provide the service.

5. Waivers You Create
Any waiver text you write or reuse across events is yours — Atlas provides the tool to collect e-signatures against it, but does not review, draft, or guarantee the legal sufficiency of your waiver language. You are responsible for ensuring your waiver actually protects you.

6. Player Data You Can See
Through the App, you can see real names and waiver signatures for players attending your own events, and real booking/check-in data. You agree to use this information only for operating your field, not for any other purpose, and not to share it beyond what's reasonably necessary to run your events.

7. Player Bans
The App lets you ban a player from your own field. This is a tool for your own field's safety and management — Atlas does not mediate or arbitrate disputes over a ban you issue.

8. Subscription & Billing
Paid plans renew automatically until canceled. Pricing, included usage, and any free trial period are as shown in the App at the time of signup. You can cancel anytime; cancellation takes effect at the end of your current billing period. Player booking fees are separate from your subscription and are paid by the player, not deducted from your own charges.

9. Prohibited Conduct
You agree not to impersonate another field or business, misrepresent your field's real status or authority to claim it, upload unlawful or infringing content, or interfere with the App's security or infrastructure.

10. Termination
Atlas may suspend or terminate accounts that violate these Terms. You may delete your account at any time from within the App.

11. Disclaimers
The App is provided "as is," without warranties of any kind. Atlas does not guarantee uninterrupted service or that your listing will drive any particular level of player interest.

12. Limitation of Liability
To the maximum extent permitted by law, Atlas is not liable for indirect, incidental, or consequential damages arising from your use of the App, including damages related to events you host.

13. Changes to These Terms
Material changes will require you to re-accept before continuing to use the App.

14. Governing Law
[FILL IN]

15. Contact
[CONTACT EMAIL] or the Atlas Discord.`;

export const PRIVACY_POLICY = `Last updated: [DATE]

1. What This Covers
This policy describes how Atlas collects, uses, and shares information when you use the Field Owner app.

2. Information We Collect
Account info (email, password, your name), field and event details you enter, and billing information handled by our payment processor (Atlas does not directly store your card details). We also collect real player activity tied to your events — bookings, check-ins, and waiver signatures — so you can manage your own field.

3. How We Use Information
To operate the app's core features, display your field's listing to players, and give you visibility into who's booked, checked in, or signed a waiver for your own events.

4. How Information Is Shared
Player names and waiver signatures tied to your events are shown to you as the field owner. Your field's public listing (name, hours, amenities, photos) is visible to all players using the Atlas player app. Atlas runs on Google Firebase and uses Stripe for payment processing — both process and store data as our infrastructure providers. We do not sell your personal information or your players' information.

5. Data Retention & Deletion
You can delete your account at any time. Waiver signatures collected for your events are not deleted even after account deletion — they're treated as permanent records for both you and the player who signed them.

6. Your Rights
Depending on where you live, you may have rights to access, correct, or delete your information — most of which you can do directly in the app.

7. Security
We use reasonable technical measures, including Firebase's security rules, to protect your information. No system is perfectly secure.

8. Changes to This Policy
Material changes will require you to re-acknowledge before continuing to use the app.

9. Contact
[CONTACT EMAIL] or the Atlas Discord.`;

export const EULA = `Last updated: [DATE]

1. License Grant
Atlas grants you a limited, non-exclusive, non-transferable, revocable license to install and use the Atlas Field Owner app to manage your own field's listing and events.

2. Restrictions
You may not copy, modify, reverse engineer, decompile, resell, or sublicense the app, or remove proprietary notices from it.

3. Ownership
Atlas and its licensors retain all right, title, and interest in the app itself. This does not affect your ownership of content you personally upload, including your field's photos and waiver text.

4. Updates
Atlas may release updates and may require you to install them to continue using the app.

5. Termination
This license terminates automatically if you violate this Agreement or delete your account.

6. Disclaimer of Warranties
The app is provided "as is" and "as available," without warranty of any kind.

7. Limitation of Liability
To the maximum extent permitted by law, Atlas is not liable for damages arising from your use or inability to use the app.

8. Governing Law
[FILL IN]

9. Entire Agreement
This Agreement, together with the Terms of Use and Privacy Policy, constitutes the entire agreement between you and Atlas.`;

// ---------------------------------------------------------------------------
// ORGANIZER AGREEMENT (added 2026-10-19) — for accounts that run events at
// venues they don't own via Atlas Major. DRAFT, NOT REVIEWED BY AN ATTORNEY:
// no real organizer should onboard until someone qualified reviews it,
// especially the sections on venue permission, insurance, fees, and what
// happens to a player's money when an event is canceled. Accepted under its
// OWN key (acceptedOrganizerTermsVersion on owners/{uid}) — separate from the
// field-owner acceptedTermsVersion above, because one person can hold both
// roles and each has different terms. Bump ORGANIZER_TERMS_VERSION whenever
// this text changes meaningfully.
// ---------------------------------------------------------------------------
export const ORGANIZER_TERMS_VERSION = "2026-10-18-organizer-draft";

export const ORGANIZER_TERMS_OF_USE = `DRAFT — pending legal review. Last updated: [DATE]

1. Acceptance of Terms
By creating an organizer account or using the Atlas for Organizers app (the "App"), you agree to these Terms of Use. If you do not agree, do not use the App.

2. Eligibility & Authority
You must be at least 18 and authorized to act for the organization or group you run events for. You are responsible for having the right to hold each event at the venue you list, including the permission of the venue's owner or operator.

3. What Atlas Is — and Isn't
Atlas is a platform that helps you list your events, sell tickets, and connect with players looking for games. Atlas is not a co-organizer, host, or operator of your events or of any venue, and does not supervise, staff, or assume any responsibility for the events you create, run, or the conduct of play at your venue. You remain solely responsible for safety, rules, insurance, permits, and legal compliance for every event you run.

4. Your Events & Content
You're responsible for the accuracy of your event listings — dates, venue, address, pricing, rules, and anything else you enter. You retain ownership of what you upload (photos, waiver text, event banners, etc.), but grant Atlas a license to store, display, and distribute it within Atlas as needed to provide the service.

5. Waivers You Create
Any waiver text you write is yours — Atlas provides the tool to collect e-signatures against it, but does not review, draft, or guarantee the legal sufficiency of your waiver language. You are responsible for ensuring your waiver actually protects you.

6. Player Data You Can See
Through the App, you can see real names and waiver signatures for players attending your own events, and real booking/check-in data. You agree to use this information only for operating your events, not for any other purpose, and not to share it beyond what's reasonably necessary to run them.

7. Tickets, Fees & Payouts
Ticket payments are processed by Stripe. Atlas charges a fee of 3.5% of the ticket price plus $1.30 per ticket, with no per-ticket cap, which is deducted from your payout — players pay the ticket price you set. Payouts require you to complete Stripe's account setup, and you agree to Stripe's own terms. Fee terms may change with notice.

8. Canceled Events
If you cancel an event, players who already paid receive an Atlas voucher for the amount of their ticket, redeemable on your other events, rather than a refund through Stripe. You are responsible for any additional refund obligations that apply to you under the law or your own policies.

9. Prohibited Conduct
You agree not to impersonate another person or organization, misrepresent your events or your authority to hold them, upload unlawful or infringing content, or interfere with the App's security or infrastructure.

10. Termination
Atlas may suspend or terminate accounts that violate these Terms. You may delete your account at any time from within the App.

11. Disclaimers
The App is provided "as is," without warranties of any kind. Atlas does not guarantee uninterrupted service or that your events will draw any particular level of player interest.

12. Limitation of Liability
To the maximum extent permitted by law, Atlas is not liable for indirect, incidental, or consequential damages arising from your use of the App, including damages related to events you host.

13. Changes to These Terms
Material changes will require you to re-accept before continuing to use the App.

14. Governing Law
[FILL IN]

15. Contact
[CONTACT EMAIL] or the Atlas Discord.`;

export const ORGANIZER_PRIVACY_POLICY = `DRAFT — pending legal review. Last updated: [DATE]

1. What This Covers
This policy describes how Atlas collects, uses, and shares information when you use the Atlas for Organizers app.

2. Information We Collect
Account info (email, password, your name), event and venue details you enter, and payout information handled by our payment processor (Atlas does not directly store your bank or card details). We also collect real player activity tied to your events — bookings, check-ins, and waiver signatures — so you can run your own events.

3. How We Use Information
To operate the app's core features, display your events to players, and give you visibility into who's booked, checked in, or signed a waiver for your own events.

4. How Information Is Shared
Player names and waiver signatures tied to your events are shown to you as the organizer. Your public event listings (title, date, venue, address, price, photos) are visible to all players using the Atlas player app. Atlas runs on Google Firebase and uses Stripe for payment processing — both process and store data as our infrastructure providers. We do not sell your personal information or your players' information.

5. Data Retention & Deletion
You can delete your account at any time. Waiver signatures collected for your events are not deleted even after account deletion — they're treated as permanent records for both you and the player who signed them.

6. Your Rights
Depending on where you live, you may have rights to access, correct, or delete your information — most of which you can do directly in the app.

7. Security
We use reasonable technical measures, including Firebase's security rules, to protect your information. No system is perfectly secure.

8. Changes to This Policy
Material changes will require you to re-acknowledge before continuing to use the app.

9. Contact
[CONTACT EMAIL] or the Atlas Discord.`;

export const ORGANIZER_EULA = `DRAFT — pending legal review. Last updated: [DATE]

1. License Grant
Atlas grants you a limited, non-exclusive, non-transferable, revocable license to install and use the Atlas for Organizers app to manage your own events.

2. Restrictions
You may not copy, modify, reverse engineer, decompile, resell, or sublicense the app, or remove proprietary notices from it.

3. Ownership
Atlas and its licensors retain all right, title, and interest in the app itself. This does not affect your ownership of content you personally upload, including your event photos and waiver text.

4. Updates
Atlas may release updates and may require you to install them to continue using the app.

5. Termination
This license terminates automatically if you violate this Agreement or delete your account.

6. Disclaimer of Warranties
The app is provided "as is" and "as available," without warranty of any kind.

7. Limitation of Liability
To the maximum extent permitted by law, Atlas is not liable for damages arising from your use or inability to use the app.

8. Governing Law
[FILL IN]

9. Entire Agreement
This Agreement, together with the Terms of Use and Privacy Policy, constitutes the entire agreement between you and Atlas.`;

// ── Field Staff Logins (2026-10-27) ──────────────────────────────────────
// DRAFT — written by Claude for Michael's review, not reviewed by an
// attorney. Covers minors' personal data, so worth a lawyer's read before
// relying on it. Bump STAFF_AGREEMENT_VERSION whenever the text changes
// meaningfully: every staff member then has to accept again before their
// next check-in (the staff grant's agreementVersion is checked on sign-in).
export const STAFF_AGREEMENT_VERSION = "2026-10-27-draft";
export const STAFF_SUPPORT_CONTACT = "Michael@airsoftatlas.app";

export function staffAgreementText(fieldNames) {
  const list = (fieldNames || []).filter(Boolean);
  const field = list.length === 0 ? "the field" : list.length === 1 ? list[0] : `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
  return `DRAFT — pending legal review.

Atlas Staff Agreement

${field} has added you as staff on Atlas so you can check players in at their events. Before you start, please read and agree to the following.

1. What you'll have access to
On event days, you'll be able to see that event's roster and check players in. This includes players' names and callsigns, whether they've paid and signed the waiver, and, for parties with children, each child's legal name, date of birth and their guardian's name and phone number.

2. Use it only for check-in
You'll use this information only to check players in and run the event for ${field}. You won't use it for anything else, including contacting players for your own reasons.

3. Don't copy or share it
You won't screenshot, copy, write down, export or share any player's information with anyone outside ${field}'s staff. That includes posting it anywhere.

4. Children's information needs extra care
Information about minors is especially sensitive. Only look at it when you need it to check a party in.

5. Keep your login to yourself
Your Atlas login is for you only. Don't share it or let anyone else check players in under your account. Every check-in records who did it.

6. Access can end at any time
${field} can remove your staff access at any time, and it ends immediately. Access also only works around event days.

7. Report problems
If you think player information has been seen or shared by someone who shouldn't have it, tell ${field} and Atlas right away at ${STAFF_SUPPORT_CONTACT}.

8. Atlas's terms still apply
This agreement is in addition to Atlas's Terms of Service and Privacy Policy.`;
}
