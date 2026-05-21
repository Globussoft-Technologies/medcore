# MedCore vs Pearl ERP Stage 1 — Gap Analysis

**Source PRD:** [`Hardik's Req_pearl woman.txt`](../Hardik%27s%20Req_pearl%20woman.txt) — Pearl ERP Stage 1 SoW v1.0, dated 2 May 2026 (632 lines, 7 modules + architecture + integrations + compliance).
**MedCore state surveyed against:** `HEAD = f23865c` on `main`, schema `packages/db/prisma/schema.prisma` (5,092 lines, ~150 models), API surface `apps/api/src/routes/` (~140 route files), web surface `apps/web/src/app/dashboard/` (~100 dashboard routes).
**Purpose:** Per-module coverage map for delivering a *Pearl ERP Stage 1* tenant on top of the existing MedCore codebase. Calls out true gaps, partials, surplus surface, and architectural divergence (most importantly: Prisma vs raw SQL, no Branch model, no Lead/Campaign engine, no separate super-admin host, RN app vs PWA).
**Author:** Senior-architect audit, no marketing varnish.

---

## 1. TL;DR — top-line gap summary

**Rough coverage of Pearl Stage 1 deliverables: ~65-70%.**

MedCore is broader than Pearl Stage 1 needs on the clinical, AI, IPD/OT, lab, and interop axes, but **narrower** on three of Pearl's seven modules: M2's lead-pipeline CRM, M4's campaign engine, and M7's super-admin panel. The biggest single architectural gap is structural — there is **no `Branch` model in the schema**, no separate super-admin URL surface, and no Lead/Campaign data model at all. Pearl's "patient PWA" is satisfied at the manifest level but MedCore's patient app is the RN/Expo `apps/mobile`, not a web-installable PWA UX. Pearl's spec mandates "raw SQL via pg" — MedCore uses Prisma; this is a stylistic mismatch that does NOT need to be resolved before a Pearl pilot.

**Top 5 missing things (build, in priority order):**
1. **Multi-doctor `appointmentMode` (Calling / Token / Slot) per doctor** — `Doctor` model + `appointments` flow only supports a single token-and-slot model. (~1 week, schema + UI)
2. **Per-tenant `Branch` model + branch scoping on every table** — Pearl is explicitly branch-aware (M6 §7.2). (~3-4 weeks)
3. **Lead pipeline (M2 §3.3) + Campaign engine (M4 §5.1)** — only a `MarketingEnquiry` sales-lead table exists today. (~4-5 weeks combined)
4. **Super-Admin panel on a separate URL (`admin.pearl-erp.in`)** — MedCore's `/dashboard/admin-console` + `/dashboard/tenants` is in-band; Pearl wants out-of-band + TOTP-mandatory + per-tenant onboarding wizard + Pearl-billing. (~3 weeks)
5. **True patient PWA surface** — manifest exists ([`apps/web/src/app/manifest.ts`](../apps/web/src/app/manifest.ts)) but there's no `/patient` route group, no offline service worker for the dashboard, and patient-flow is via the RN mobile app. (~3-4 weeks)

**Top 3 "MedCore already has this, Pearl doesn't strictly need it but it's a Stage 2/3 ready-today asset":**
1. **ABDM M2/M3 + ABHA linking + Consent artefacts + Care contexts** — Pearl Stage 1 only asks for M1 (ABHA create/link); MedCore has v2 claim flows, consent artefact lifecycle, and ABDM M2 HIP-push scaffolding at [`apps/api/src/routes/abdm.ts`](../apps/api/src/routes/abdm.ts) (668 lines) + [`apps/api/src/services/abdm/`](../apps/api/src/services/abdm/).
2. **AI Scribe + AI Triage + AI Radiology + Drug Safety + Bill/Lab Explainer + Adherence schedules** — Pearl Stage 1 explicitly defers voice-Rx, LLM clinical drafts, predictive CDS, and AI discharge. MedCore has all of them production-shipped.
3. **IPD + OT + Lab QC + Blood bank + Ambulance + Telemedicine + HL7v2 inbound + FHIR R4 export** — Pearl §18 lists these as out-of-scope for Stage 1, but they're already in production at MedCore. For a Pearl pilot, these need to be **feature-flag-hidden** in the role nav.

---

## 2. Per-module gap matrix

### Module 1 — OPD Management (PRD §2)

MedCore covers the OPD spine well — registration, vitals, consult, Rx writer, drug interaction CDSS, pharmacy dispense, token board. The notable Pearl-shaped gaps are the **three doctor modes (Calling / Token / Slot)**, **ABHA M1 link at registration** (the rails are there but not on the registration form), the **threaded remarks** per-appointment, and the **quick-action buttons** on every patient row.

| PRD § | Pearl feature | Status | MedCore reference | Notes |
|---|---|---|---|---|
| 2.1.1 | Phone + name + DOB + gender + address + emergency contact + allergies + photo | ✅ Present | [`schema.prisma:820-916`](../packages/db/prisma/schema.prisma) `Patient`, [`routes/patients.ts`](../apps/api/src/routes/patients.ts) | All fields present. `photoUrl` lives on `User.photoUrl` AND `Patient.photoUrl`. |
| 2.1.1 | Unique `patient_code` per tenant | ✅ Present | `Patient.mrNumber @unique` | MR number is globally unique not per-tenant — minor schema-level deviation. |
| 2.1.1 | ABHA ID capture (optional; full M1 linking) | 🟡 Partial | `Patient.abhaId`, [`routes/abdm.ts`](../apps/api/src/routes/abdm.ts) + [`schema.prisma:4320` AbhaLink`](../packages/db/prisma/schema.prisma) | M1 backend wired (create, link, OTP verify, JWKS). Patient-registration form does NOT include an "Link ABHA" CTA today — separate flow. |
| 2.1.1 | Duplicate-phone detection + merge workflow | 🟡 Partial | [`patients-dup-checks.test.ts`](../apps/api/src/routes/patients-dup-checks.test.ts), `Patient.mergedIntoId` field | Dup detection exists, merge field on schema exists, no merge UI wired. |
| 2.1.1 | Source tagging (web / PWA / walk-in) | ❌ Missing | — | No `Patient.source` enum on the schema. |
| 2.1.2 | Visit creation tied to appointment or walk-in | ✅ Present | `Appointment.type = SCHEDULED | WALK_IN`, [`routes/appointments.ts`](../apps/api/src/routes/appointments.ts) | Walk-in route present. |
| 2.1.2 | Three doctor modes (Calling / Token / Slot) configurable per doctor | ✅ Present | `Doctor.appointmentMode` + 5 knobs in [`schema.prisma:936-941`](../packages/db/prisma/schema.prisma), [`routes/appointments.ts` branch-by-mode](../apps/api/src/routes/appointments.ts), [`PATCH /doctors/:id/appointment-mode`](../apps/api/src/routes/doctors.ts), [`/dashboard/doctors/[id]/page.tsx AppointmentModeCard`](../apps/web/src/app/dashboard/doctors/[id]/page.tsx), [`routes/queue.ts` mode-tagged feed](../apps/api/src/routes/queue.ts), [`/display/page.tsx DoctorCard variants`](../apps/web/src/app/display/page.tsx) | **All 3 pieces closed 2026-05-21**. Piece 1 (commits `bfd11a8` + `6913d62` + `e35081b` + `af48756`): schema + Zod + booking handler branching (TOKEN/SLOT/CALLING) + dailyAppointmentLimit cap + lastHourPolicy=BLOCK_NEW gate + tokenPrefix `displayToken` in response. Piece 2 (commit `fd58688`): per-doctor `AppointmentModeCard` on `/dashboard/doctors/:id` — admin can edit all 6 knobs (mode + tokenPrefix + tokenStartNumber + dailyAppointmentLimit + nearTurnAlertThreshold + lastHourPolicy), non-admins see read-only summary, form PATCHes the API endpoint. Piece 3 (commit `6febb54`): `routes/queue.ts` GET `/` returns per-doctor `appointmentMode` + per-mode payload (TOKEN: `nextToken`; CALLING: `currentArrivalSeq`; SLOT: `upcomingSlots[]` with `"First L."` redaction); `/display/page.tsx` `DoctorCard` branches its layout per mode with a mode badge + data-testid hooks. Plumbing-test asserts mode tagging + redaction (3 new `queue.test.ts` cases). |
| 2.1.2 | Branching UX (OPD header changes per mode) | ✅ Present | [`/display/page.tsx DoctorCard`](../apps/web/src/app/display/page.tsx), [`/dashboard/doctors/[id]/page.tsx AppointmentModeCard`](../apps/web/src/app/dashboard/doctors/[id]/page.tsx) | Closed 2026-05-21 via `6febb54` + `fd58688`. The mode is reflected in (a) the public display card's variant per doctor + an explicit `MODE` badge, and (b) the doctor profile's per-mode helper text on the AppointmentModeCard. The pure OPD-header chrome (per-mode subtitle on the consult screen) was not separately built — display board + profile card are treated as covering this row. |
| 2.1.3 | 3-column consult screen (patient card / SOAP / favourites) | 🟡 Partial | [`/dashboard/scribe/page.tsx`](../apps/web/src/app/dashboard/scribe/page.tsx), `routes/ai-scribe.ts` | Scribe is the closest analog (transcript + SOAP draft + ICD-10). Pure typed-SOAP 3-column canvas isn't separately built — patient card + center pane exists, "right rail with favourites / last 3 visits" is not the same as today. |
| 2.1.3 | Vitals inline (BP / pulse / temp / SpO2 / RR / weight / height) | ✅ Present | `Vitals` model `schema.prisma:1000-1030`, [`/dashboard/vitals/`](../apps/web/src/app/dashboard/vitals/) | All seven fields present + abnormal flagging. |
| 2.1.3 | Diagnosis coded against ICD-10 + SNOMED CT | ✅ Present | `Icd10Code`, `SnomedConcept`, [`routes/icd10.ts`](../apps/api/src/routes/icd10.ts), [`services/ai/snomed-mapping.test.ts`](../apps/api/src/services/ai/snomed-mapping.test.ts) | ICD-10 master + SNOMED mapping both shipped. |
| 2.1.4 | Structured Rx row (drug autocomplete + dose chips + freq segmented + duration + route + qty auto) | 🟡 Partial | [`/dashboard/prescriptions/new/`](../apps/web/src/app/dashboard/prescriptions/new/), [`schema.prisma:1108 PrescriptionItem`](../packages/db/prisma/schema.prisma) | Item-level fields exist (`medicineId`, `medicineName`, `dosage`, `frequency`, `duration`, `quantity`). Pearl's chip/segmented-control UX-grade is not equivalent; functional but not pixel-spec. |
| 2.1.4 | Favourite-medicine quick-add | ❌ Missing | — | No `DoctorFavouriteMedicine` model. |
| 2.1.4 | Per-doctor Rx templates ("URI starter pack") | ✅ Present | `PrescriptionTemplate` `schema.prisma:1150` | Wired. |
| 2.1.4 | Drug-allergy conflict block + duplicate-drug + DDI | ✅ Present | [`routes/prescriptions.ts:checkPatientAllergies`](../apps/api/src/routes/prescriptions.ts), `PatientAllergy` model | Closed 2026-05-20 via `954b141` (gap item #7). Allergy cross-ref + bidirectional substring match on (brand, generic) tokens; block returns 400 + `allergyConflicts[]`; override path requires `overrideAllergies:true` + `allergyOverrideReason` and writes `PRESCRIPTION_ALLERGY_OVERRIDE` AuditLog. DDI + duplicate-drug detection (NEW_VS_NEW + NEW_VS_EXISTING grouping) already present. |
| 2.1.4 | Schedule H / H1 / X gating | ✅ Present | `Medicine.schedule`, `Medicine.isNarcotic`, `Medicine.requiresRegister`, `ControlledSubstanceEntry`, [`routes/controlled-substances.ts`](../apps/api/src/routes/controlled-substances.ts) | Full controlled-substance register. |
| 2.1.4 | Print preview (A5 + letterhead + signature + NMC reg + QR) | 🟡 Partial | [`services/pdf-generator.ts`](../apps/api/src/services/pdf-generator.ts) (uses `qrcode` lib, scannable QR), [`/verify/`](../apps/web/src/app/verify/) | PDF + QR + signed-URL verify endpoint shipped. **NMC reg number is not on the `Doctor` schema** — Pearl mandates this on every Rx. Field needs adding. |
| 2.1.5 | Token board public-display mode | ✅ Present | [`/display/page.tsx`](../apps/web/src/app/display/page.tsx) | Fullscreen, offline-tolerant, websocket live. |
| 2.1.5 | Three layouts in one screen (Calling / Token / Slot) | ✅ Present | [`/display/page.tsx DoctorCard`](../apps/web/src/app/display/page.tsx), [`routes/queue.ts`](../apps/api/src/routes/queue.ts) | Closed 2026-05-21 via `6febb54`. Each doctor's column renders the variant matching `Doctor.appointmentMode`: TOKEN (Now Serving + Next + waiting count), CALLING (arrival #N + arrival queue size), SLOT (next 3 upcoming slots with HH:MM + redacted patient label). Mode badge top-right of each card. data-testid hooks (`display-card-token` / `display-card-calling` / `display-card-slot` + `display-slot-strip`) for e2e drive. |
| 2.1.5 | Multi-doctor side-by-side | ✅ Present | `/display/page.tsx` renders all doctors | Grid layout. |
| 2.1.5 | Patient name redaction on public displays | ✅ Present | [`/display/page.tsx`](../apps/web/src/app/display/page.tsx), [`routes/queue.ts` SLOT redaction](../apps/api/src/routes/queue.ts) | Closed 2026-05-21 via `6febb54`. TOKEN + CALLING layouts show no name at all (token/arrival #). SLOT layout uses Pearl's "first name + last initial" rule, applied server-side in `queue.ts` before serialisation so the wire never carries the full surname (`Priya Sharma` → `Priya S.`). |
| 2.1.6 | Receptionist marks arrived → doctor sees in queue → doctor calls next → routed to pharmacy/billing | ✅ Present | `Appointment.checkInAt`, `consultationStartedAt`, `consultationEndedAt`, [`routes/queue.ts`](../apps/api/src/routes/queue.ts) | All state transitions wired. |
| 2.1.7 | Threaded remarks per appointment (multi-role, visibility-scoped, pinnable, audited) | ✅ Present | `AppointmentRemark` model (migration `20260520000004`) + 5 endpoints in `routes/appointments.ts` + `AppointmentRemarksModal` | Closed 2026-05-21 via `02192a4` (gap item #8). Visibility ALL_STAFF / DOCTOR_ONLY / RECEPTION_ONLY / PRIVATE with reply-visibility-inheritance, pin/unpin (DOCTOR+ADMIN), author-only edit, author+ADMIN delete, audit on every mutation. 9 integration tests. |
| 2.1.8 | Quick-action buttons (WhatsApp / Email / Call / Add to CRM) on every patient row | ✅ Present | `apps/web/src/app/dashboard/patients/page.tsx` Actions column | Closed 2026-05-21 via `02192a4` (gap item #8). WhatsApp / Call / Email open native handlers via `wa.me` / `tel:` / `mailto:`. Add-to-Lead shows a "coming with Pearl M2 lead pipeline" toast until gap item #3 lands. |

---

### Module 2 — Appointment Management + CRM (PRD §3)

Booking + slot picker + cancel/reschedule/no-show + reminders cascade exists today and is solid. **The CRM half is essentially absent** — only the `MarketingEnquiry` sales-lead table (for marketing-site form submissions) is shipped. Pearl's stage-gated `New → Qualified → Engaged → Booked → Converted → Lost` pipeline + activity log per lead + conversion attribution is a fresh build.

| PRD § | Pearl feature | Status | MedCore reference | Notes |
|---|---|---|---|---|
| 3.1 | Booking form supports per-doctor channels (only enabled channels shown) | ❌ Missing | — | Follows from M1 §2.1.2 — no per-doctor mode. |
| 3.1 | Slot picker from `doctor_appointment_preferences` (hours / duration / buffer / last-hour) | 🟡 Partial | `DoctorSchedule.slotDurationMinutes`, `DoctorSchedule.bufferMinutes`, `ScheduleOverride` | Working hours + slot duration + buffer modelled. **No `lastHourPolicy` field**, no `dailyLimit`, no `nearTurnAlertThreshold`, no `tokenPrefix`. |
| 3.1 | Conflict prevention (unique `(doctorId, date, slotTime)`) | 🟡 Partial | `Appointment @@unique [doctorId, date, tokenNumber]` | Uniqueness is on tokenNumber not slotTime. Same end effect for token-mode, but slot-time uniqueness isn't enforced. |
| 3.1 | Bulk-edit dialog for admins (defaults across many doctors) | ❌ Missing | — | No bulk-edit surface. |
| 3.1 | Walk-in flow (token issued or arrival_seq incremented) | ✅ Present | `routes/appointments.ts /walk-in`, [`/dashboard/walk-in/`](../apps/web/src/app/dashboard/walk-in/) | Token mode only. |
| 3.1 | Cancel / reschedule / no-show flows with reasons | ✅ Present | `routes/appointments.ts` PATCH `/:id/reschedule`, `/cancel`, `services/auto-noshow.ts`, `lwbsReason` field | Reasons captured. |
| 3.2 | Per-doctor preference editor (channels / token prefix / token start / daily limit / slot duration / buffer / hours / near-turn alert / last-hour) | 🟡 Partial | [`/dashboard/duty-roster/`](../apps/web/src/app/dashboard/duty-roster/), [`/dashboard/schedule/`](../apps/web/src/app/dashboard/schedule/), [`/dashboard/doctors/[id]/page.tsx AppointmentModeCard`](../apps/web/src/app/dashboard/doctors/[id]/page.tsx) | Working hours + slot duration in admin schedule UI. 6 mode-knobs (mode + tokenPrefix + tokenStart + dailyLimit + nearTurnAlert + lastHourPolicy) now editable on doctor profile page (commit `fd58688`, 2026-05-21). Channels (per-doctor) + buffer (separate from slotDuration) still not exposed. |
| 3.2 | Reminders config (booked / 24h pre / 1h pre / no-show recovery +30m / bill-due +3d / lab-ready +24h) | ✅ Present | `NotificationTemplate` + `NotificationSchedule` + `services/notification-triggers.ts`, [`/dashboard/notification-templates/`](../apps/web/src/app/dashboard/notification-templates/) | Templates editable per type+channel. Cadence is hardcoded in `notification-triggers.ts` — not a tenant-editable rule DSL. |
| 3.2 | Holiday calendar (closes booking) | ✅ Present | `Holiday` model `schema.prisma:3356`, [`/dashboard/holidays/`](../apps/web/src/app/dashboard/holidays/) | Wired to booking checks. |
| 3.2 | Patient opt-in / opt-out enforcement | ✅ Present | `NotificationPreference` model `schema.prisma:1366` | Per-channel preference. |
| 3.3 | **Lead pipeline (New → Qualified → Engaged → Booked → Converted → Lost)** | ❌ Missing | — | **No `Lead` model.** Only `MarketingEnquiry` (a flat row from the marketing-site contact form). |
| 3.3 | Lead capture from web / walk-in / phone / WhatsApp / referral | 🟡 Partial | `MarketingEnquiry` (web only), `Referral` model (doctor-to-doctor) | Single-source lead. No multi-source lead. |
| 3.3 | Activity log per lead (calls / messages / doctor allocation / outcomes) | ❌ Missing | — | Follows from above. |
| 3.3 | Conversion attribution (source + CRM rep) | ❌ Missing | — | — |
| 3.3 | One-click "convert lead → patient" | ❌ Missing | — | — |

---

### Module 3 — OPD Billing + Reports (PRD §4)

This is one of MedCore's strongest modules. Pearl Stage 1 wants invoice list/detail, line items, GST, payments, refunds, outstanding, pharmacy dispensing Kanban, and ~12 standard operational reports — almost all of which exist. The two specific Pearl-shaped builds are **NHCX cashless stub stepper** (we have InsuranceClaim2 but the visual stepper UI isn't there) and **referring-doctor commission auto-split** (we have `Referral` but no commission split on invoice).

| PRD § | Pearl feature | Status | MedCore reference | Notes |
|---|---|---|---|---|
| 4.1 | Invoice list + detail layout | ✅ Present | [`/dashboard/billing/`](../apps/web/src/app/dashboard/billing/), [`/dashboard/bills/`](../apps/web/src/app/dashboard/bills/), [`routes/billing.ts`](../apps/api/src/routes/billing.ts) | Two surfaces (admin + patient). |
| 4.1 | Line items (consultation / procedure / medicine / investigation / package / misc) | ✅ Present | `InvoiceItem.category` | All 6 categories supported. |
| 4.1 | Per-line discount + tenant-wide GST | ✅ Present | `InvoiceItem.cgst`, `sgst`, `gstRate`, `hsnSac`, `Invoice.discountAmount`, `packageDiscount` | CGST/SGST split persisted per line. |
| 4.1 | Payment recording (cash / card / UPI / bank / insurance) | ✅ Present | `PaymentMode` enum has CASH/CARD/UPI/ONLINE/INSURANCE | Bank transfer = ONLINE. |
| 4.1 | Refunds + void with reason audit | ✅ Present | `CreditNote` model, [`/dashboard/refunds/`](../apps/web/src/app/dashboard/refunds/) | Audited. |
| 4.1 | Outstanding balance per patient + per visit | ✅ Present | `Invoice.paymentStatus`, `dueDate`, reports endpoint | Aging supported via `dueDate`. |
| 4.1 | Referring-doctor commission auto-split | 🟡 Partial | `Referral` model present, no commission split on invoice | Commission % not modeled on Doctor or Referral. |
| 4.1 | Printable GST-compliant invoice | ✅ Present | [`services/pdf-generator.ts`](../apps/api/src/services/pdf-generator.ts) | HSN/SAC + GST split. |
| 4.2 | NHCX cashless stub stepper (`coverage_status` lifecycle) | 🟡 Partial | `InsuranceClaim2.status` enum (SUBMITTED / IN_REVIEW / QUERY_RAISED / APPROVED / PARTIALLY_APPROVED / DENIED / SETTLED / CANCELLED), [`/dashboard/insurance-claims/`](../apps/web/src/app/dashboard/insurance-claims/) | Status lifecycle modelled at a richer level than Pearl asks; no horizontal stepper UI on the invoice detail. |
| 4.3 | Pharmacy dispensing Kanban (New Rx → Dispensing → Ready → Dispensed) | 🟡 Partial | `PrescriptionStatus` enum (PENDING / DISPENSED / REJECTED / CANCELLED), [`/dashboard/pharmacy/`](../apps/web/src/app/dashboard/pharmacy/) | Statuses are a 3-state subset; no Dispensing/Ready split. Kanban UI not built — it's a list view. |
| 4.3 | Batch + expiry tracking, expiring-batch warnings | ✅ Present | `InventoryItem.batchNumber`, `expiryDate`, [`/dashboard/pharmacy-forecast/`](../apps/web/src/app/dashboard/pharmacy-forecast/) | Wired. |
| 4.3 | Auto-deduct from `pharmacy_issues` on dispense | ✅ Present | `StockMovement`, `StockTransfer` | Wired. |
| 4.3 | Pricing flows to invoice as line items | ✅ Present | `routes/pharmacy.ts` | Wired. |
| 4.4 | Today's OPD count by doctor | ✅ Present | [`routes/analytics.ts`](../apps/api/src/routes/analytics.ts) | Live tile. |
| 4.4 | Doctor utilisation % (7/30d trend) | ✅ Present | `routes/analytics.ts` + `routes/budgets.ts` | — |
| 4.4 | Collections today (by mode) | ✅ Present | `routes/analytics.ts`, `routes/billing.ts` | — |
| 4.4 | Pending bills aging (0-30 / 31-60 / 61-90 / 90+) | ✅ Present | `routes/billing.ts` aging | — |
| 4.4 | Pharmacy turnover by item | ✅ Present | `routes/pharmacy.ts` | — |
| 4.4 | Expiring batches (30/60/90) | ✅ Present | `routes/pharmacy.ts` | — |
| 4.4 | Referring-doctor commission ledger | ❌ Missing | — | Follows from §4.1 commission gap. |
| 4.4 | Lead-to-patient conversion funnel | ❌ Missing | — | Follows from §3.3 lead gap. |
| 4.4 | No-show rate by doctor / day-of-week | 🟡 Partial | `Patient.noShowCount`, `services/auto-noshow.ts` | Per-patient count exists; the doctor/DOW pivot isn't a built report. |
| 4.4 | Revenue by service type | ✅ Present | `routes/analytics.ts` + `InvoiceItem.category` group-by | — |
| 4.4 | GST report (output / input / payable) | ✅ Present | Per-line `cgst`/`sgst` persisted (Issue #901 was specifically about exact-DECIMAL GST math) | GSTR-1 export. |
| 4.4 | TDS on professional fees | 🟡 Partial | `Doctor.consultationFee` + `InvoiceItem` "consultation" rows | Computable from existing data; no dedicated TDS report endpoint. |
| 4.4 | CSV download + branch filter | 🟡 Partial | Most reports support date-range + CSV; **no branch filter** (no Branch model) | — |

---

### Module 4 — CRM + Campaign Activation + Patient Login (PRD §5)

Pearl's M4 is the marketing-side complement to M2: campaign engine + audience builder + cohort enrolment + patient login. MedCore has **chronic-care cohorts** (a thinner version of "care cohorts") and **broadcast notifications** (a 1-shot send-to-audience), but no full campaign drip / A-B / tracking engine. Patient login via phone OTP is **not built today** — patient auth is email+password just like staff.

| PRD § | Pearl feature | Status | MedCore reference | Notes |
|---|---|---|---|---|
| 5.1 | One-off broadcast | 🟡 Partial | `NotificationBroadcast` model + [`/dashboard/broadcasts/`](../apps/web/src/app/dashboard/broadcasts/) | Single-shot send to an audience string. Not template-segmented. |
| 5.1 | Drip / sequence | ❌ Missing | — | — |
| 5.1 | Trigger-based (birthday + 10% discount) | ❌ Missing | — | Birthday isn't modeled as a trigger source. |
| 5.1 | Cohort-based audience | 🟡 Partial | `ChronicCarePlan` (auto-enrol by condition) | Limited to chronic conditions; no "all hypertensives over 55 not visited in 90 days" rule DSL builder. |
| 5.1 | Audience builder (demographic + clinical filters) | ❌ Missing | — | — |
| 5.1 | Channels (WhatsApp / SMS / email / push) | ✅ Present | `NotificationChannel` enum + `services/channels/` | All 4 channels shipped. |
| 5.1 | Send-window clamp (IST quiet-hour 09-21) | ✅ Present | `NotificationSchedule.quietHoursStart/End` + `services/notification-orchestrator.test.ts` | Tenant + patient overrides modelled. |
| 5.1 | Personalisation tokens ({{first_name}} etc) | 🟡 Partial | `NotificationTemplate.body` is a freetext template | Template substitution mechanism likely already there; no dedicated personalisation engine. |
| 5.1 | LLM-personalisation opt-in flag | ❌ Missing | — | Stage 2 per the PRD anyway. |
| 5.1 | Tracking (open / click / WhatsApp delivery+read / bounce / unsubscribe) | 🟡 Partial | `Notification.deliveredAt`, `readAt`, `bounceReason` field exist | Per-message yes; campaign-aggregate roll-ups no. |
| 5.1 | A/B testing on variants | ❌ Missing | — | — |
| 5.1 | Conversion attribution (campaign → booking/invoice) | ❌ Missing | — | Follows from "no Campaign model". |
| 5.2 | Care cohort with rule DSL | 🟡 Partial | `ChronicCarePlan.thresholds` (Json) | Per-patient plan, not a tenant-wide rule DSL. |
| 5.2 | Auto-enrol / auto-remove | 🟡 Partial | `ChronicCarePlan.active` | Manual today; no auto-enrol cron. |
| 5.2 | Sequence of touchpoints per cohort | 🟡 Partial | `services/chronic-care-scheduler.ts` | Single-frequency reminder; not a sequence. |
| 5.2 | On-visit auto-schedule next message | 🟡 Partial | Triggered via `notification-triggers.ts` for chronic-care alerts | — |
| 5.3 | Patient login via phone OTP | ❌ Missing | — | **Today's `Patient` logs in with email+password.** There's no phone-OTP login route. TOTP login exists for 2FA but not as the primary patient sign-in. |
| 5.3 | Optional ABHA link at first login | 🟡 Partial | ABDM M1 routes exist but no first-login hook | — |
| 5.3 | Patient JWT scope separate from staff | ✅ Present | `Role.PATIENT` is its own role; routes use `authorize(Role.PATIENT)` carefully (per CLAUDE.md gotcha §14) | — |
| 5.3 | Forgot-phone recovery via in-clinic identity verification | ❌ Missing | — | Email-based password reset exists; no phone-recovery flow. |

---

### Module 5 — Patient Web Panel / PWA (PRD §6)

This is the largest single delivery gap. Pearl wants `https://<hospital>.pearl-erp.in/patient` as an **installable PWA** (Android Chrome + iOS Safari) with offline-tolerant service-worker caching and Lighthouse mobile Performance ≥ 85 / Accessibility ≥ 95. MedCore's patient app is the **React Native / Expo project at [`apps/mobile/`](../apps/mobile/)** — different surface, different install story, currently mid-SDK-53→55 migration (per #920). Most of the *backend* needed for the PWA already exists (book/list/Rx/bills/profile/ABHA) — the build is the **frontend** at `apps/web/src/app/patient/` plus a service worker.

| PRD § | Pearl feature | Status | MedCore reference | Notes |
|---|---|---|---|---|
| 6.1 | Login (phone OTP, optional ABHA link) | ❌ Missing | — | See §5.3. |
| 6.1 | Dashboard (next appt / recent Rx / open bills) | 🟡 Partial | `apps/mobile/app/(tabs)/index.tsx`, but as RN not PWA | API endpoints all there. |
| 6.1 | Book appointment (channel-aware per doctor mode) | ❌ Missing | — | Follows from §2.1.2 + no patient web booking flow on `apps/web`. Mobile app has `appointments.tsx`. |
| 6.1 | My appointments (upcoming + past) | 🟡 Partial | `apps/mobile/app/(tabs)/appointments.tsx` | RN only. |
| 6.1 | My prescriptions (signed PDFs, download/share, QR verify) | 🟡 Partial | `apps/mobile/app/(tabs)/prescriptions.tsx`, [`/verify/`](../apps/web/src/app/verify/) | QR verify is a web route; mobile app lists Rx. |
| 6.1 | My bills (open + paid, pay via UPI/card/netbanking, GST download, NHCX stepper) | 🟡 Partial | `apps/mobile/app/(tabs)/billing.tsx`, Razorpay wired in `services/razorpay.ts` | RN only. |
| 6.1 | My profile (name, DOB, phone, address, language, reminder opt-in, ABHA link, photo) | 🟡 Partial | `apps/mobile/app/(tabs)/profile.tsx` | All fields modelled. |
| 6.1 | Records (ABHA-linked) | 🟡 Partial | `routes/patient-data-export.ts` + `routes/ehr.ts` + ABDM HIU scaffolding | Backend partial; not surfaced in PWA. |
| 6.1 | WhatsApp inbox (campaigns / reminders / replies → reception) | ❌ Missing | — | Inbound WhatsApp routing isn't built. |
| 6.2 | Installable PWA | 🟡 Partial | [`apps/web/src/app/manifest.ts`](../apps/web/src/app/manifest.ts) | Manifest present but `start_url: "/"` is the staff dashboard, not a patient surface. **No `/patient` route group on the web app.** No service worker (`apps/web/src/instrumentation.ts` is Sentry, not SW). |
| 6.2 | Offline-tolerant SW caching dashboard + recent records | ❌ Missing | — | — |
| 6.2 | Lighthouse mobile Performance ≥ 85, A11y ≥ 95 | 🟡 Partial | Project has Playwright + a11y conventions, no Lighthouse CI budget today | — |
| 6.2 | Languages — English + Hindi | ✅ Present | [`apps/web/src/lib/i18n.ts`](../apps/web/src/lib/i18n.ts), [`apps/web/src/lib/I18N.md`](../apps/web/src/lib/I18N.md) | Flat-dict EN+HI strategy. |
| 6.2 | Touch-friendly 44px targets | 🟡 Partial | Tailwind app, no global rule | Hit-target audit needed. |

---

### Module 6 — Doctor / Hospital Web Panel (PRD §7)

Closest fit to today's MedCore. Sidebar + topbar + role-scoped views are all there. The Pearl-shaped gaps are **⌘K command palette**, **per-role view definitions matching exactly** (Pearl's `Pharmacy` and `Billing` roles map to MedCore's `PHARMACIST` and `RECEPTION` but the page-set per role is different), and **branch-aware scoping** (no Branch model).

| PRD § | Pearl feature | Status | MedCore reference | Notes |
|---|---|---|---|---|
| 7.1 | Reception role view | ✅ Present | `Role.RECEPTION` + RBAC across routes | — |
| 7.1 | Doctor view (OPD queue, 3-col consult, Rx, templates, favourites, CRM activity) | 🟡 Partial | `/dashboard/queue/`, `/dashboard/scribe/`, `/dashboard/prescriptions/` | Each surface exists; "CRM activity on a patient" surface doesn't (no Lead/CRM data). |
| 7.1 | Pharmacy view (Kanban + master + inventory) | 🟡 Partial | `/dashboard/pharmacy/`, `/dashboard/medicines/` | List view, not Kanban. |
| 7.1 | Billing view | ✅ Present | `/dashboard/billing/`, `/dashboard/bills/` | — |
| 7.1 | Admin view (users / roles / branches / settings / audit / reports) | 🟡 Partial | `/dashboard/users/`, `/dashboard/settings/`, `/dashboard/audit/`, `/dashboard/reports/`, [`routes/branches.ts`](../apps/api/src/routes/branches.ts) | Branch CRUD API shipped 2026-05-21 (gap #2 piece 1 of 3); branch admin UI pending (piece 3). |
| 7.1 | Owner / SLT dashboard | ✅ Present | `/dashboard/admin-console/` (live tiles), `/dashboard/analytics/` | KPI tiles. |
| 7.2 | Design tokens (`design-tokens.ts`) | ✅ Present | Tailwind config + `globals.css` | Token-driven via Tailwind. |
| 7.2 | ⌘K command palette | ❌ Missing | — | — |
| 7.2 | Skeleton loaders on every fetch | 🟡 Partial | Many pages have skeletons | Not enforced universally. |
| 7.2 | Toast + EmptyState primitives | ✅ Present | [`apps/web/src/lib/toast.ts`](../apps/web/src/lib/toast.ts) + various EmptyState components | — |
| 7.2 | Quick-action buttons on every patient name | ✅ Present | See §2.1.8. | Closed 2026-05-21 via `02192a4`. |
| 7.2 | Multi-tenant + branch-aware scoping | 🟡 Partial | `tenantScopedPrisma` ([`services/tenant-prisma.ts`](../apps/api/src/services/tenant-prisma.ts)); `Branch` model + CRUD API in [`routes/branches.ts`](../apps/api/src/routes/branches.ts); `branchScopedPrisma` extension + `X-Branch-Id` middleware in [`packages/db/src/branch-prisma.ts`](../packages/db/src/branch-prisma.ts) | Tenant yes; **branch model + CRUD shipped 2026-05-21 (piece 1 of 3)**; **`branchScopedPrisma` + `branchId` on `Appointment` shipped 2026-05-21 (piece 2a of 3)**. Pending: piece 2b = `branchId` on Invoice/Doctor/Patient + backfill; piece 3 = branch picker UI + report filters. |
| 7.2 | i18n (EN + HI shell) | ✅ Present | `apps/web/src/lib/i18n.ts` | Flat dict, EN+HI shipped. |

---

### Module 7 — Super-Admin Panel (PRD §8)

Pearl wants this on a **separate URL** (`admin.pearl-erp.in`) with elevated `super_admin:*` RBAC, mandatory TOTP, 30-min idle timeout, and a Pearl-side billing surface for the hospital subscription (separate from the hospital's patient billing). MedCore's `/dashboard/tenants/` + `/dashboard/admin-console/` is **in-band** (same host as the tenant) and uses the regular `Role.ADMIN`. There's no separate route group, no mandatory TOTP for tenant operators, no Pearl-vs-hospital subscription billing surface.

| PRD § | Pearl feature | Status | MedCore reference | Notes |
|---|---|---|---|---|
| 8.1 | Tenant list with per-tenant KPIs | 🟡 Partial | [`/dashboard/tenants/`](../apps/web/src/app/dashboard/tenants/), [`routes/tenants.ts`](../apps/api/src/routes/tenants.ts) | Tenant list + create/update; KPI panel per tenant not built. |
| 8.1 | Onboarding wizard (8 steps) | 🟡 Partial | `services/tenant-provisioning.ts createTenant()` is a single atomic POST | One-shot create; not a wizard with HFR/HPR/WhatsApp/Razorpay steps. |
| 8.1 | Suspend / archive / restore + 90-day S3 archival | 🟡 Partial | `Tenant.active`, `services/tenant-provisioning.ts deactivateTenant()` | Suspend yes; archival to S3 not built. |
| 8.1 | Per-tenant feature flag overrides | ❌ Missing | — | `SystemConfig` is global, not per-tenant feature flag. |
| 8.2 | Cross-tenant super-admin list | 🟡 Partial | Admin users with `tenantId == null` is the current "super-admin" pattern (see `routes/tenants.ts:requireSuperAdmin`) | No dedicated `SuperAdmin` model; permissions are coarse. |
| 8.2 | Granular permission grants (per-tenant / per-module / can-onboard-tenant / can-view-billing / can-trigger-jobs) | ❌ Missing | — | Role-only RBAC today. |
| 8.2 | Audit trail per super-admin action | ✅ Present | `AuditLog` model + `services/tenant-context.ts` actor logging | Wired. |
| 8.2 | 2FA mandatory | 🟡 Partial | TOTP enrol exists ([`routes/auth.ts:2fa/setup`](../apps/api/src/routes/auth.ts)) | Optional today, not mandatory for ADMIN. |
| 8.2 | 30-min idle session timeout (configurable) | 🟡 Partial | JWT TTL is configurable globally | Not per-role / per-tenant configurable. |
| 8.2 | Invite via email → set password + TOTP → assign roles → first-login walkthrough | 🟡 Partial | Admin can create users via `routes/users.ts`; email invite flow is partial | — |
| 8.3 | Per-tenant subscription (Plan + usage components) | 🟡 Partial | `Tenant.plan` enum (BASIC / PRO / ENTERPRISE) | Plan modelled; usage metering (WhatsApp / SMS counts) not modelled. |
| 8.3 | Pearl-side invoice generation (monthly auto-email) | ❌ Missing | — | The `Invoice` model is for hospital → patient, not Pearl → hospital. |
| 8.3 | Pearl-side payment recording (bank transfer / auto-debit) | ❌ Missing | — | — |
| 8.3 | Subscription state machine (trial → active → past_due → suspended) | ❌ Missing | — | — |
| 8.3 | Upgrade / downgrade with proration | ❌ Missing | — | — |
| 8.4 | Aggregated cross-tenant metrics | 🟡 Partial | `/dashboard/admin-console/` has tenant-scoped metrics | Not cross-tenant aggregated; current super-admin operates within `default` tenant. |
| 8.4 | Per-tenant health (error rates / p95 / failed jobs) | 🟡 Partial | Sentry + OTel + `services/metrics.ts` | Cross-tenant rollup not built into UI. |
| 8.4 | Public status page | ❌ Missing | — | — |
| 8.4 | Background-job queue view + retry | 🟡 Partial | Cron jobs in `services/scheduled-tasks.ts`; no admin UI | — |
| 8.5 | Support inbox (ticket lifecycle) | 🟡 Partial | `Complaint` model exists (patient → hospital) | Not a Pearl-operator ticket inbox. |
| 8.6 | Cross-tenant DPDP request workbench | 🟡 Partial | `PatientDataExport`, `routes/patient-data-export.ts` | Export yes; cross-tenant purge workbench no. |
| 8.6 | Compliance dashboard per tenant | ❌ Missing | — | — |

---

## 3. Cross-cutting gaps

### 3.1 Multi-tenancy + branch-awareness (PRD §7.2)

MedCore has solid multi-tenancy: every Pearl-relevant table carries `tenantId`, and [`tenantScopedPrisma`](../packages/db/src/) auto-injects tenant on create and auto-filters on read. The `Branch` model + CRUD API shipped 2026-05-21 as **piece 1 of 3** ([`routes/branches.ts`](../apps/api/src/routes/branches.ts), migration `20260520000010_pearl_branch_model`).

**Piece 1 closed 2026-05-21** — `Branch` schema + 5-endpoint CRUD + RBAC + 15 integration tests. The Branch model is per-tenant with the "exactly one default per tenant" invariant API-enforced (POST auto-defaults the first branch, PATCH that sets isDefault=true atomically transfers, DELETE refuses to soft-delete the default).

**Piece 2a closed 2026-05-21** — `branchScopedPrisma` extension shipped ([`packages/db/src/branch-prisma.ts`](../packages/db/src/branch-prisma.ts)); applied to `Appointment` only — Invoice/Doctor/Patient pending in piece 2b. The extension chains on top of `tenantScopedPrisma` (so callers get BOTH stampings for free), reads from a new `branchAsyncStorage` ALS scope opened by `branchContextMiddleware` (header source: `X-Branch-Id`), and is wired globally in `apps/api/src/app.ts` so legacy requests pass through unchanged when the header is absent. Migration `20260520000011_pearl_appointment_branchid` adds the nullable `branchId` FK on `appointments` (no backfill — legacy rows stay NULL). 3 end-to-end integration tests cover auto-stamp on POST + auto-filter on GET + legacy passthrough when the header is omitted.

**Still pending** (pieces 2b + 3):
- piece 2b — `branchId` on Invoice / Doctor / DoctorSchedule / Patient? / InventoryItem / User + expand `BRANCH_SCOPED_MODELS` to match + opportunistic backfill of existing rows to each tenant's `isDefault` branch + JWT-claim / session-derived branch resolution (header is the only source today)
- piece 3 — branch filter on every report + branch picker in topbar + branch-aware nav

Estimate remaining: **1.5-2 engineer-weeks** for pieces 2b + 3 (was 3-4 weeks for all three).

### 3.2 i18n — EN + HI shell + clinical-content English (PRD §7.2)

Already shipped: [`apps/web/src/lib/i18n.ts`](../apps/web/src/lib/i18n.ts) + [`I18N.md`](../apps/web/src/lib/I18N.md) — flat-dict EN+HI architecture. Patient communication channel (WhatsApp / email / SMS template) is per-channel template via `NotificationTemplate`, and `Patient.preferredLanguage` is on the schema. This is one of the few places MedCore is fully Pearl-ready.

### 3.3 PWA vs React Native

Pearl Module 5 explicitly demands a **PWA** at `<hospital>.pearl-erp.in/patient` — installable on Android Chrome + iOS Safari, offline-tolerant via service worker, mirror to WhatsApp for non-PWA users. MedCore's `apps/mobile/` is RN/Expo (currently mid-SDK-53→55 migration tracked in #920) and ships through stores, not the web. This is a deliberate product divergence and is the **single biggest M5 gap**. The web app's `manifest.ts` exists but is registered against the staff dashboard, not a patient surface.

Recommendation: build `apps/web/src/app/patient/` as a route group (separate layout, separate auth via phone OTP, separate dashboard, separate service worker). The RN app can stay for power users / android-tray apps.

### 3.4 Super-admin host (`admin.pearl-erp.in`)

MedCore's super-admin surface lives at `/dashboard/tenants/` + `/dashboard/admin-console/`, same Next.js host as the tenant. Pearl wants a **separate host** under `/super-admin` route group with elevated RBAC. The simplest fix is a new route group `apps/web/src/app/super-admin/` gated by both `Role.ADMIN` AND `User.tenantId == null` (the existing "globally-tenant-less super-admin" pattern from [`routes/tenants.ts:requireSuperAdmin`](../apps/api/src/routes/tenants.ts)) plus a separate vhost/subdomain in deploy config. This is **not a hard rebuild** — it's a copy-cut of `/dashboard/` with elevated gates.

### 3.5 DPDP workbench (M7 §8.6)

We have `PatientDataExport` ([`routes/patient-data-export.ts`](../apps/api/src/routes/patient-data-export.ts)) and consent artefacts via ABDM. **The cross-tenant DPDP-delete workbench is not built** — there's no super-admin UI to trigger a per-patient erasure across all surfaces, no operator-runnable purge audit log, no compliance posture dashboard. Pearl §8.6 wants both.

---

## 4. Integration gaps (PRD §11)

| Integration | Pearl Stage 1 status | MedCore today | Verdict |
|---|---|---|---|
| **WhatsApp Business (Gupshup)** | Live | [`services/channels/whatsapp.ts`](../apps/api/src/services/channels/whatsapp.ts) — generic HTTP adapter, stub-mode when env unset. Templates per `NotificationTemplate`. | ✅ Compatible — Gupshup is a `WHATSAPP_API_URL` + `WHATSAPP_API_KEY` config. Templates are managed in-app. |
| **SMS + OTP (Twilio)** | Live | [`services/channels/sms.ts`](../apps/api/src/services/channels/sms.ts) — supports MSG91 (default for India) + generic adapter. **Twilio adapter not implemented** but it's the same generic-Bearer pattern, ~30 min to add. | 🟡 Partial — easily added. |
| **Email (SMTP / SES)** | Live | [`services/channels/email.ts`](../apps/api/src/services/channels/email.ts) | ✅ |
| **Razorpay payment gateway** | Live | [`services/razorpay.ts`](../apps/api/src/services/razorpay.ts) + [`routes/razorpay-webhook.test.ts`](../apps/api/src/routes/razorpay-webhook.test.ts) — HMAC-verified webhook | ✅ Production-grade. |
| **ABDM M1 (ABHA create + link)** | Live | [`routes/abdm.ts`](../apps/api/src/routes/abdm.ts) (668 lines) + [`services/abdm/`](../apps/api/src/services/abdm/) — ABHA create, link, consent, JWKS, health-records | ✅ Beyond M1 — M2 push scaffold also present (Pearl Stage 2 ready). |
| **Drug DB (Indian formulary)** | Seed only | `Medicine` model with `seedRegulatory` step in [`scripts/deploy.sh`](../scripts/deploy.sh) step 9f — 87 generics with Schedule/isNarcotic/maxDailyDoseMg | ✅ Matches Pearl's "seed only" Stage 1 expectation. |
| **SNOMED CT (C-DAC)** | Live | `SnomedConcept` model + [`services/ai/snomed-mapping.test.ts`](../apps/api/src/services/ai/snomed-mapping.test.ts) — mapping engine | ✅ |
| **ICD-10 (WHO)** | Live | `Icd10Code` model + [`routes/icd10.ts`](../apps/api/src/routes/icd10.ts) | ✅ |

**Pearl's explicit non-asks (Stage 2+):** Augnito ASR, DrugBank Clinical, Retell AI, Exotel, Daily.co, NHCX live, Aadhaar eSign, DSC. MedCore has Jitsi for telemed ([`services/jitsi.ts`](../apps/api/src/services/jitsi.ts)), Sarvam ASR scaffolding for AI scribe (sufficient for Stage 1 acceptance).

---

## 5. Architectural notes

### 5.1 Prisma vs raw SQL (PRD §10)

Pearl §10 specifies **"raw SQL via pg"**. MedCore uses **Prisma**. This is the largest stylistic divergence. **Recommendation: don't refactor.** Prisma is strictly more capable than raw `pg` for a hospital-grade multi-tenant app — typed clients, migrations, the `tenantScopedPrisma` extension that auto-injects `tenantId`, transactions. The Pearl PRD's "raw SQL" line is a stack-preference, not a functional requirement. If Pearl genuinely insists, that's a **multi-month rewrite** with no functional gain and a significant safety regression. Flag this to the product owner before any code touches it.

### 5.2 JWT + RBAC + module pattern (PRD §10)

MedCore matches: JWT auth (with refresh tokens), `Role`-enum-based RBAC via `authorize(...)` middleware, modular Express routes one-file-per-resource. The Pearl spec is satisfied as-is.

### 5.3 Zustand (PRD §10)

`apps/web/src/lib/store.ts` uses Zustand for auth + a few caches. The dashboard pages are mostly server-component-first with client-side useState; Zustand is used at the auth-store / i18n-store level. **Compatible.**

### 5.4 Tailwind + Radix UI + RHF + Zod (PRD §10)

MedCore uses Tailwind + headless components + RHF + Zod across the dashboard. **Compatible.**

### 5.5 Hosting + DPDP residency (PRD §10)

Demo is on a `163.227.174.141` host. Pearl mandates AWS Mumbai (ap-south-1) or DigitalOcean Bangalore. **This is a deploy-target gap, not a code gap.** Production tenant deployment for Pearl must move infra.

### 5.6 Observability (PRD §10)

OTel + structured logging + Sentry already wired (see `apps/web/instrumentation.ts`, `apps/api/src/services/metrics.ts`). Grafana dashboards aren't shipped but the OTel exporter is. **Compatible.**

---

## 6. Out-of-scope (Pearl Stage 2+) — MedCore surface to hide

Pearl PRD §18 explicitly excludes a long list of features that **MedCore already ships**. For a Pearl-branded tenant deployment, these need to be **hidden behind a tenant-feature-flag** (or per-role nav suppression) so the OPD-class scope stays clean and matches the SoW the hospital signed.

| Pearl-excluded feature | MedCore surface | Recommendation |
|---|---|---|
| IPD module (wards, beds, admissions, eMAR, vitals chart, IO chart, nursing notes) | `routes/admissions.ts`, `routes/medication.ts`, `Ward`/`Bed`/`Admission`/`MedicationOrder`/`MedicationAdministration`/`IpdVitals`/`IpdIntakeOutput`, `/dashboard/admissions/`, `/dashboard/wards/`, `/dashboard/medication/`, `/dashboard/nurse-rounds/` | Hide via tenant feature-flag. |
| OT scheduling + implants | `routes/surgery.ts`, `OperatingTheater`/`Surgery`/`AnesthesiaRecord`/`PostOpObservation`, `/dashboard/operating-theaters/` | Hide. |
| LIS / lab analyser HL7 | `routes/hl7v2.ts`, `services/hl7v2/`, `LabTest`/`LabOrder`/`LabResult`, `/dashboard/lab-orders/`, `/dashboard/lab/` | Lab orders + results are useful Stage 1; HL7v2 inbound analyser feed should be hidden. |
| Telemedicine + video | `routes/telemedicine.ts`, `services/jitsi.ts`, `TelemedicineSession`, `/dashboard/telemedicine/` | Hide. |
| Voice-Rx | AI scribe + ASR scaffolding | Hide AI scribe surface (or repurpose as a Stage 2 upsell). |
| Voice AI Receptionist | (build commitment from mykare PR #909, not yet shipped) | N/A — not in MedCore yet. |
| AI Discharge | (not built) | N/A. |
| Predictive CDS (sepsis / deterioration / no-show) | `routes/ai-predictions.ts`, `routes/ai-capacity.ts`, `routes/ai-followup.ts`, `routes/ai-fraud.ts`, `routes/ai-roster.ts`, `routes/ai-coaching.ts`, all the `ai-*` dashboard pages | Hide for Pearl Stage 1. Strong Stage 2 upsell. |
| Nurse-Call System | `services/notification-triggers.ts` has some hooks | N/A as a discrete product. |
| AI image triage (CXR / ECG / retinal) | `routes/ai-radiology.ts`, `RadiologyStudy`, `RadiologyReport`, `/dashboard/ai-radiology/` | Hide. |
| NABH Quality Dashboard | `routes/budgets.ts` + analytics | Hide as "NABH dashboard"; keep basic ops dashboards. |
| ABDM M2/M3/M4 + NHCX live | `routes/abdm.ts` HIP push, `InsuranceClaim2`, ABDM consent flow | Hide M2/M3 surfaces; keep M1 + the NHCX-stub stepper visible per Pearl §4.2. |
| LLM-personalised reminders | (Stage 2 in PRD) | Keep behind feature flag. |
| Agentic Revenue Cycle | (not built) | N/A. |
| HRMS / payroll | `routes/hr-ops.ts`, `routes/leaves.ts`, `routes/expenses.ts`, `payroll.ts`, `LeaveBalance`, `OvertimeRecord`, `StaffCertification`, `/dashboard/payroll/`, `/dashboard/leave-management/`, `/dashboard/duty-roster/` | Hide. **However** — staff shifts + leave + holiday calendar should stay (needed for doctor-mode scheduling). |
| Asset / biomed tracker | `routes/assets.ts`, `Asset`/`AssetMaintenance`/`AssetTransfer`/`AssetAssignment`, `/dashboard/assets/` | Hide. |

**Recommended mechanism:** add a `Tenant.featureFlags` Json column (already implied by the Pearl §8.1 "feature flag overrides per tenant" requirement) and gate route nav + API routes accordingly. This unifies the Pearl-Stage-1 hiding work with the Pearl-Stage-2 enable-when-paid work.

---

## 7. Top 10 recommended next moves to close Stage 1

Ordered by Pearl-criticality × MedCore-build-cost ratio. Effort is engineer-weeks (1 engineer FT).

| # | Move | Effort | Why |
|---|---|---|---|
| 1 | ~~**Add `Doctor.appointmentMode` + Calling/Token/Slot routing in `routes/appointments.ts` + token board variant rendering**~~ | ~~1 week~~ | ✅ **CLOSED 2026-05-21 — all 3 pieces shipped**. Piece 1 = schema + API foundation + dailyLimit/lastHour/tokenPrefix enforcement (commits `bfd11a8` + `6913d62` + `e35081b` + `af48756`). Piece 2 = doctor-profile mode-picker UI — all 6 knobs editable from `/dashboard/doctors/:id` (commit `fd58688`). Piece 3 = token-board variant rendering + Calling-mode arrival-queue feed + SLOT first-name-last-initial redaction + mode-tagged display-board API (commit `6febb54`, plus closure annotations + 3 `queue.test.ts` plumbing assertions). End-to-end Pearl M1 #1 now lands: admin sets mode → booking form branches → display board reflects it. |
| 2 | **Add `Branch` model + branchId on ~20 tables + `branchScopedPrisma` + branch picker in topbar** | 3-4 weeks | 🚧 **In progress — pieces 1 + 2a of 3 closed 2026-05-21**. Piece 1 = Branch model + CRUD API + 15 integration tests (migration `20260520000010`; `routes/branches.ts`). Piece 2a = `branchScopedPrisma` extension layered on `tenantScopedPrisma` + `branchContextMiddleware` (header source `X-Branch-Id`) wired globally + `branchId` (nullable) on `Appointment` only + 3 end-to-end integration tests (migration `20260520000011`; `packages/db/src/branch-prisma.ts`). Piece 2b pending = `branchId` on Invoice/Doctor/Patient + opportunistic backfill of existing rows to each tenant's `isDefault` branch (~1 wk). Piece 3 pending = branch picker UI in topbar + per-report branch filter (~1 wk). |
| 3 | ~~**Build Lead pipeline (`Lead` model + 6-stage state machine + activity log + convert-to-patient)**~~ | ~~1.5 weeks~~ | ✅ **CLOSED 2026-05-21**. Migration `20260520000007_pearl_lead_pipeline` (Lead + LeadActivity + 3 enums). 6 endpoints in `routes/leads.ts`: POST/GET/GET-detail/PATCH/POST-activities/POST-convert. Status changes + doctor allocation auto-log activities. POST /convert creates User+Patient in a transaction, mints MR, writes CONVERSION activity. Idempotent MarketingEnquiry → Lead promotion via @@unique. Web `/dashboard/leads` page with stage chips, source filter, search, status-dropdown, create modal. "Add to Lead" button on patient row wired live (was stub). 7 integration tests. |
| 4 | **Build Campaign engine (`Campaign`, `CampaignSend`, `CampaignAudience`, audience builder UI, 4-channel dispatcher, send-window respect, A/B variant)** | 2.5 weeks | Closes M4 §5.1 entirely. Reuses existing `services/channels/*`. |
| 5 | **Build patient PWA route group `apps/web/src/app/patient/` + service worker + phone-OTP login route** | 3 weeks | Closes M5 §6.1+6.2. Backend ~90% reused. |
| 6 | **Build super-admin route group `apps/web/src/app/super-admin/` on separate vhost + onboarding wizard + Pearl-billing surface (`PearlSubscription`, `PearlInvoice`)** | 2.5 weeks | Closes M7 §8.1+8.3. |
| 7 | ~~**Wire `PatientAllergy` into `routes/prescriptions.ts` allergy-block + override-with-reason path**~~ | ~~2 days~~ | ✅ **CLOSED 2026-05-20 via `954b141`** + test-fixture follow-up `a5a7a68`. `checkPatientAllergies()` resolves each Rx item's medicine to (brand, generic) tokens via the Medicine master + bidirectional substring-matches against active `PatientAllergy.allergen`. Conflict → POST/PATCH `/api/v1/prescriptions` returns `400` + `body.allergyConflicts:[{allergen, severity, ...}]`. Override path: `overrideAllergies:true` + `allergyOverrideReason` on the body → persisted + `PRESCRIPTION_ALLERGY_OVERRIDE` AuditLog row written (`entity:"patient"`). |
| 8 | ~~**Threaded `AppointmentRemark` model + per-row Quick-Action buttons (WhatsApp / Email / Call / Add-to-Lead) on patient lists**~~ | ~~1 week~~ | ✅ **CLOSED 2026-05-21 via `02192a4`** (M1 §2.1.7 + §2.1.8 both green). |
| 9 | ~~**Tenant feature-flag mechanism + hide Stage-2+ surfaces per §6 of this doc**~~ | ~~1 week~~ | ✅ **CLOSED 2026-05-21**. Migration `20260520000005_pearl_tenant_feature_flags` + `Tenant.featureFlags Json?` + shared `FEATURE_KEYS` constant (16 keys) + `services/feature-flags.ts` resolver with 60s LRU + `middleware/feature-flag.ts requireFeature(key)` returning 404 + `GET/PATCH /api/v1/feature-flags` (ADMIN-gated PATCH) + `useFeatureFlags()` hook + sidebar nav filter in `apps/web/src/app/dashboard/layout.tsx`. Applied to telemedicine + admissions + ai-radiology routers. 5 integration tests pin RBAC + 404-on-disable + null-clears-override. |
| 10 | ~~**Add `Doctor.nmcRegNumber` + render on Rx PDF + audit; add Razorpay live cred per tenant + mandatory-TOTP toggle for tenant ADMIN role**~~ | ~~1 week~~ | ✅ **CLOSED**. #10a (`704a5f5`): Doctor.nmcRegNumber + Rx PDF render. #10b (this commit): Migration `20260520000006_pearl_tenant_razorpay_and_admin_totp` adds Tenant.razorpayKeyId / razorpayKeySecret / razorpayMode / requireAdminTOTP. `services/razorpay.ts` rewritten to take optional tenantId; createPaymentOrder/verifyPayment/fetchOrderAmount(Paid)/getRazorpayInstance all per-tenant with 60s LRU + invalidate-on-write. Tenant PATCH extended + cache-bust on rotation. Login flow rejects ADMIN without 2FA on tenants with requireAdminTOTP=true (412 + enrolToken). 3 integration tests. |

**Cumulative estimate:** ~17-18 engineer-weeks for a single dedicated engineer, or **~8-9 calendar weeks with 2 engineers in parallel** (lanes 2/5/6 are mostly non-overlapping). Pearl PRD §13 budgets 18 weeks total Stage-1 calendar — so the gap-close fits comfortably inside Pearl's own timeline, with the existing MedCore depth covering the rest.

---

## Appendix A — quick model presence/absence reference

| Pearl-asked-for table | MedCore model | Notes |
|---|---|---|
| `tenants` | `Tenant` ✅ | `subdomain`-keyed |
| `branches` | ❌ MISSING | — |
| `users` | `User` ✅ | with Role enum |
| `doctor_appointment_preferences` | partial — `DoctorSchedule` + `ScheduleOverride` ✅ | no `appointmentMode` field |
| `patients` | `Patient` ✅ | + many extensions |
| `appointments` | `Appointment` ✅ | token-mode only |
| `appointment_remarks` | ❌ MISSING | only `Appointment.notes` freetext |
| `consultations` (SOAP) | `Consultation` ✅ + `AIScribeSession.soapDraft/soapFinal` Json | |
| `vitals` | `Vitals` + `IpdVitals` ✅ | |
| `prescriptions` | `Prescription` + `PrescriptionItem` ✅ | |
| `prescription_templates` | `PrescriptionTemplate` ✅ | |
| `medicines_master` | `Medicine` ✅ | Schedule + isNarcotic + leaflet |
| `drug_interactions` | `DrugInteraction` ✅ | |
| `patient_allergies` | `PatientAllergy` ✅ | not wired to Rx-block |
| `invoices` | `Invoice` + `InvoiceItem` + `Payment` ✅ | Decimal money |
| `coverage_status` (NHCX stub) | `InsuranceClaim2.status` ✅ | richer than Pearl stub |
| `pharmacy_issues` / dispense | `StockMovement` + pharmacy routes ✅ | |
| `inventory_batches` | `InventoryItem.batchNumber/expiryDate` ✅ | |
| `leads` | ❌ MISSING — only `MarketingEnquiry` | |
| `lead_activities` | ❌ MISSING | |
| `campaigns` | ❌ MISSING — `NotificationBroadcast` is closest | |
| `audience` | ❌ MISSING | |
| `care_cohorts` | partial — `ChronicCarePlan` ✅ | no DSL |
| `holidays` | `Holiday` ✅ | |
| `notification_templates` | `NotificationTemplate` ✅ | |
| `notification_schedules` (quiet hours) | `NotificationSchedule` ✅ | |
| `notification_preferences` (opt-in/out) | `NotificationPreference` ✅ | |
| `audit_logs` | `AuditLog` ✅ | tenant-scoped |
| `abha_links` | `AbhaLink` ✅ | |
| `consent_artefacts` | `ConsentArtefact` ✅ | |
| `care_contexts` (ABDM) | `CareContext` ✅ | |
| `feature_flags` (per tenant) | ❌ MISSING — only global `SystemConfig` | |
| `pearl_subscriptions` / `pearl_invoices` | ❌ MISSING | Stage 1 Pearl-billing surface |
| `support_tickets` | partial — `Complaint` ✅ (patient→hospital, not operator inbox) | |
| `super_admin_audit` | partial — `AuditLog` scoped to non-tenant actors | |

---

## Appendix B — files you'll want to read before scoping any individual M-build

- [`packages/db/prisma/schema.prisma`](../packages/db/prisma/schema.prisma) — all 150 models in one place
- [`apps/api/src/routes/appointments.ts`](../apps/api/src/routes/appointments.ts) — booking + walk-in + token assignment
- [`apps/api/src/routes/prescriptions.ts`](../apps/api/src/routes/prescriptions.ts) — Rx writer + DDI engine + share + verify
- [`apps/api/src/routes/billing.ts`](../apps/api/src/routes/billing.ts) — invoice + payment + GST
- [`apps/api/src/routes/tenants.ts`](../apps/api/src/routes/tenants.ts) — multi-tenant onboarding shape
- [`apps/api/src/services/tenant-prisma.ts`](../apps/api/src/services/tenant-prisma.ts) — auto-tenant-injection extension
- [`apps/api/src/services/notification-triggers.ts`](../apps/api/src/services/notification-triggers.ts) — every booked/checked-in/Rx-ready hook
- [`apps/api/src/services/channels/*.ts`](../apps/api/src/services/channels/) — WhatsApp / SMS / Email / Push adapters
- [`apps/api/src/services/abdm/`](../apps/api/src/services/abdm/) — M1 + M2 + JWKS + crypto
- [`apps/web/src/app/manifest.ts`](../apps/web/src/app/manifest.ts) — current PWA manifest (staff-dashboard scoped)
- [`apps/web/src/lib/i18n.ts`](../apps/web/src/lib/i18n.ts) — EN+HI flat dict
- [`apps/web/src/app/display/page.tsx`](../apps/web/src/app/display/page.tsx) — token board public display
- [`apps/web/src/app/dashboard/scribe/page.tsx`](../apps/web/src/app/dashboard/scribe/page.tsx) — closest analog to Pearl's 3-column consult screen
- [`docs/MYKARE_GAP_ANALYSIS.md`](./MYKARE_GAP_ANALYSIS.md) — companion analysis (Mykare voice-AI + outbound-agent + intl-patient build commitments)
- [`TODO.md`](../TODO.md) banner + [`docs/archive/SESSION_SNAPSHOT_2026-05-18-evening.md`](./archive/SESSION_SNAPSHOT_2026-05-18-evening.md) — current state of main + open follow-ups

---

End of Pearl Stage 1 gap analysis.
