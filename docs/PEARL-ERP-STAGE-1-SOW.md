# Pearl ERP — Stage 1 Scope of Work

*Stage:* 1 of a planned multi-stage rollout
*Project:* Pearl ERP — OPD-class HMS with Patient & Doctor Web Panels
*Version:* 1.0
*Date:* 2 May 2026
*Prepared by:* Onviqa Inc — R&D
*Confidential*

---

## 0. Stage-1 charter — one paragraph

This Stage 1 Scope of Work covers Pearl ERP in its *OPD-class configuration: everything a single multi-doctor clinic (or a hospital's outpatient department) needs to run paperless from patient first contact through consultation, prescription, billing, and follow-up. The deliverables are seven modules across three surfaces (patient web panel, doctor/staff web panel, super-admin panel) plus a CRM and campaign engine. **IPD, OT, lab analyser integration, voice-AI receptionist, AI discharge, telemedicine and ABDM HIP/HIU pull are Stage 2+ — explicitly out of scope here.* The aim of Stage 1 is to get the foundation right so subsequent stages snap on cleanly.

---

## 1. Stage-1 deliverables — at a glance

| # | Module | Lives on | Primary user |
|---|---|---|---|
| 1 | *OPD Management* | Doctor / Reception Web Panel | Reception, doctor at desk |
| 2 | *Appointment Management + CRM* | Doctor / Reception Web Panel | Reception, sales/CRM staff |
| 3 | *OPD Billing + Reports* | Doctor / Reception Web Panel | Billing, accounts, owner |
| 4 | *CRM + Campaign Activation + Patient Login* | Patient Web Panel + Doctor Web Panel | Marketing, patients |
| 5 | *Patient Web Panel (PWA)* | https://<hospital>.pearl-erp.in/patient | Patients, family |
| 6 | *Doctor / Hospital Web Panel* | https://<hospital>.pearl-erp.in | Reception, doctor, pharmacy, billing, admin |
| 7 | *Super-Admin Panel* | https://admin.pearl-erp.in | Onviqa operator + franchise admins |

The same backend serves all three front-end surfaces.

---

## 2. Module 1 — OPD Management

The clinical heart of the OPD day. Covers patient registration through prescription dispatch.

### 2.1 Features

#### 2.1.1 Patient registration
- Phone + name + DOB + gender + address (city/state/pin) + emergency contact + allergies + photo (optional).
- Unique patient_code per tenant.
- ABHA ID capture (optional; full ABHA M1 linking included).
- Duplicate-phone detection with merge workflow.
- Source tagging: web-panel registration, patient-self-registration via PWA, walk-in.

#### 2.1.2 OPD visit
- Visit creation tied to an appointment (or stand-alone walk-in).
- Three doctor modes supported per doctor (configurable in Settings):
  - *Calling* — arrival-order queue, no token, no slot.
  - *Token* — sequential tokens (T-001, T-002…) per session.
  - *Slot* — fixed appointment times (10:00, 10:15…).
- Branching UX: the OPD screen header changes based on the doctor's active mode.

#### 2.1.3 Consult screen (doctor at desk)
- 3-column layout:
  - Left rail — patient card (photo, name, age, sex, phone, allergies as red pills, active medications, last vitals).
  - Centre — SOAP tabbed canvas (Subjective / Objective / Assessment / Plan), each tab a structured form (React Hook Form + Zod).
  - Right panel — favourite Rx templates and last 3 visits' notes.
- Vitals capture (BP / pulse / temp / SpO2 / RR / weight / height) inline at the top of Objective.
- Diagnosis coded against ICD-10 + SNOMED CT (free in India via C-DAC).

#### 2.1.4 Prescription writer (typed)
- Structured row per medicine: drug search-as-you-type from medicines_master, dose chips, frequency segmented control (OD / BD / TDS / QID / STAT / SOS), duration + unit chips (days/weeks), route segmented control, quantity auto-computed.
- Doctor's favourite-medicine quick-add list (one-tap insertion).
- Per-doctor templates (e.g. "URI starter pack").
- *Safety gate (basic CDSS for Stage 1)*: drug-allergy conflict block, duplicate-drug warning, top-200-Indian-DDIs warning. Schedule H/H1/X gating is included.
- Print preview (A5 prescription with hospital letterhead, doctor signature, NMC reg number, QR code linking to the signed Rx).

#### 2.1.5 Token board (waiting hall display)
- Public-display mode (?display=public) — fullscreen, no admin chrome.
- Three layouts in one screen — Calling mode shows arrival queue, Token mode shows Now / Next / Waiting, Slot mode shows next-3-slots strip.
- Multi-doctor side-by-side rendering.
- Patient name redaction on public displays (first name + last initial).

#### 2.1.6 OPD queue + flow
- Receptionist marks patient arrived → doctor sees them in their queue.
- Doctor marks "calling next" → token board updates.
- Visit completed → patient is routed to pharmacy (if Rx) or billing.

#### 2.1.7 Threaded remarks
- Every appointment carries a remarks thread.
- Author roles: reception · doctor · nurse · billing · admin · patient.
- Visibility: staff-only · patient-visible · public.
- Pinnable, sortable, audited.

#### 2.1.8 Quick-action buttons next to every patient name
WhatsApp · Email · Call · Add to CRM. Permission-gated per channel. Logged to patient_communications.

### 2.2 Acceptance for Module 1

- New patient registered + arrived + consulted + Rx signed + printed in *under 6 minutes* end-to-end (timed).
- All 3 doctor modes (calling / token / slot) render correctly on the same hospital with three different doctors.
- Drug-allergy block actually blocks Rx sign with override-with-reason path.
- WhatsApp share button on the printed Rx sends the patient a link to the signed PDF.

---

## 3. Module 2 — Appointment Management + CRM

### 3.1 Appointment booking

- Booking form supports per-doctor channels (calling / walkin / token / slot) — only enabled channels shown to receptionist.
- Slot picker pulls from doctor_appointment_preferences (working hours, slot duration, buffer, last-hour policy).
- Conflict prevention — slot-mode bookings honour unique constraint on (doctor_id, date, slot_time).
- Bulk-edit dialog for admins to set defaults across many doctors at once.
- Walk-in flow — receptionist taps "walk-in", chooses doctor, token issued or arrival_seq incremented.
- Cancel / reschedule / no-show flows with reasons.

### 3.2 Settings → Appointments

- Per-doctor preference editor: which channels enabled, token prefix, token start number, daily limit, slot duration, slot buffer, working hours (per day), near-turn alert threshold, last-hour policy.
- *Reminders config* — appointment-booked reminder rules at 24h + 1h pre-appointment via WhatsApp; no-show recovery at +30 min; bill-due at +3 days; lab-result-ready at +24h. Rules editable; channel + offset + template per rule.
- Holiday calendar — closes booking on declared holidays.
- Patient opt-in / opt-out enforcement.

### 3.3 CRM (basic)

The Stage-1 CRM is a *lead-pipeline + activity-tracker*, not a full marketing-automation suite (that's part of Module 4 below).

- Lead capture: web form, walk-in, phone, WhatsApp inquiry, referral.
- Lead pipeline stages: New → Qualified → Engaged → Booked → Converted → Lost.
- Activity log per lead (calls made, messages sent, doctor allocation, visit outcomes).
- Conversion attribution: which source brought the patient, which CRM rep closed the lead.
- One-click "convert lead to patient" → creates patients row, prefills appointment booking.

### 3.4 Acceptance for Module 2

- Receptionist books an appointment in < 30 s for a returning patient.
- Doctor with only "Calling" mode enabled: receptionist booking form hides the slot/token UI entirely.
- A patient booked for tomorrow morning receives WhatsApp confirmation within 60 s.
- Lead-to-patient conversion preserves activity history.

---

## 4. Module 3 — OPD Billing + Reports

### 4.1 Billing surface

- Invoice list (left rail) + detail (right pane) layout.
- Line items: consultation, procedure, medicine, investigation, package, miscellaneous.
- Per-line discount + tenant-wide tax (GST) handling.
- Payment recording across cash, card, UPI, bank transfer, insurance.
- Refunds + void with reason audit.
- Outstanding balance tracking per patient + per visit.
- Referring-doctor commission split (auto-computed if a referring doctor is set on the visit).
- Printable GST-compliant invoice with hospital letterhead.

### 4.2 Insurance / cashless (foundation)

Stage 1 sets up the *stub for NHCX cashless* — actual NHCX live integration is Stage 3. The stub provides:

- coverage_status field on every invoice (none / coverage_check / pre_auth_pending / claim_submitted / claim_response / paid / denied).
- Horizontal stepper visualises current state in the billing detail UI.
- Manual "Move to next step" admin button for testing.
- Full live integration with insurers and PMJAY is a Stage 3 deliverable.

### 4.3 Pharmacy dispensing (covered here as it sits between Rx and bill)

- Kanban dispensing board: New Rx → Dispensing → Ready → Dispensed.
- Drag-drop on desktop, swipe on mobile.
- Batch + expiry tracking; expiring-batch warnings.
- Auto-deduct from pharmacy_issues on dispense.
- Pricing flows automatically to the billing invoice as line items.

### 4.4 Reports

Stage-1 reports are operational dashboards + downloadable CSV exports. (NABH quality dashboard is Stage 2.)

| Report | Audience | Frequency |
|---|---|---|
| Today's OPD count by doctor | Owner / admin | Live |
| Doctor utilisation % | Owner / admin | Live + 7/30-day trend |
| Collections today (cash / card / UPI / bank / insurance breakdown) | Billing | Live + monthly |
| Pending bills aging (0-30 / 31-60 / 61-90 / 90+ days) | Billing | Live |
| Pharmacy turnover by item | Pharmacy / owner | Daily / weekly |
| Expiring batches (next 30 / 60 / 90 days) | Pharmacy | Daily |
| Referring-doctor commission ledger | Accounts | Monthly |
| Lead-to-patient conversion funnel | CRM / marketing | Weekly / monthly |
| No-show rate by doctor / by day-of-week | Operations | Monthly |
| Revenue by service type (consultation, procedure, pharmacy) | Owner | Monthly |
| GST report (output / input / payable) | Accounts | Monthly |
| TDS on professional fees | Accounts | Monthly |

All reports support: date-range picker (today, last 7, last 30, last 90, YTD, custom), CSV download, branch filter for multi-branch tenants.

### 4.5 Acceptance for Module 3

- Invoice creation + payment recording + receipt print in < 60 s.
- GST invoice format passes a chartered accountant's review.
- Outstanding bills report tallies to the AR aging sum.
- Pharmacy dispense auto-creates billing line item with correct price and tax.

---

## 5. Module 4 — CRM + Campaign Activation + Patient Login

This is the marketing-side companion to Module 2's lead pipeline. Module 4 is what runs *outreach + activations; Module 2 is what runs **the booking process* once a lead expresses interest.

### 5.1 Campaign engine

- *Campaign types*:
  - One-off broadcast (e.g. "Free Diabetes Camp on Saturday").
  - Drip / sequence (e.g. wellness-month 4-email/WhatsApp series).
  - Trigger-based (e.g. "Birthday wishes + 10% discount on annual health package").
  - Cohort-based (e.g. "All hypertensives over 55 not visited in 90 days").
- *Audience builder* — query by demographic + clinical filters (age band, gender, last visit, diagnosis codes, allergies, location). Audited.
- *Channels* — WhatsApp Business template, SMS, email, push to PWA installs. Channel preference respects patient opt-in.
- *Schedule + send-window clamp* — IST quiet-hour respect (09:00–21:00 default; tenant configurable; patient overrides win).
- *Personalisation* — token substitution ({{first_name}}, {{last_visit_date}}, {{doctor_name}}). LLM-personalisation behind an opt-in flag (Stage 2 if budget allows).
- *Tracking* — open / click / WhatsApp delivery + read receipts / bounce / unsubscribe rates per campaign.
- *A/B testing* — split-test message variants on the audience.
- *Conversion attribution* — campaign clicks that turn into bookings or invoices are credited to the campaign.

### 5.2 Care Cohorts (already in repo)

- Define a chronic-care cohort (e.g. all diabetics) with a rule DSL.
- Auto-enrol when a patient meets criteria; auto-remove when they no longer do.
- Sequence of touchpoints (visit reminder, lab reminder, education snippet) scheduled per cohort.
- On-visit action: when an enrolled patient is seen in OPD, the next message in the sequence schedules automatically.

### 5.3 Patient login

- Patient logs in to their own portal via phone OTP.
- Optional: link ABHA via Aadhaar OTP at f irst login.
- Patient session is *a separate JWT scope* from staff users — patients cannot access any staff endpoint.
- Forgot-phone recovery via in-clinic identity verification.
- Password-less by default (OTP every session is friction; we use refresh tokens with 30-day lifetime).

### 5.4 Acceptance for Module 4

- Marketing admin builds an audience of "all hypertensives over 55, not visited in 90 days, opted in to WhatsApp" in <60 s.
- Sends a campaign WhatsApp template; delivery rate ≥ 95% over a 1,000-patient pilot.
- A patient who clicks a campaign link can self-book an appointment in the patient portal — the booking is attributed to the campaign.
- Quiet-hour clamp prevents 22:00 sends.

---

## 6. Module 5 — Patient Web Panel (PWA)

*URL pattern:* https://<hospital>.pearl-erp.in/patient
*Surface:* Installable PWA (Android Chrome, iOS Safari) — no app-store dependency. Mirrored by WhatsApp for non-PWA users.

### 6.1 Stage-1 patient-panel screens

| Screen | Purpose |
|---|---|
| *Login* | Phone + OTP. Optional ABHA link on first login. |
| *Dashboard* | Next appointment card, recent prescriptions (3 most recent), open bills, recent lab reports (Stage 2). |
| *Book appointment* | Pick specialty → doctor → date → channel-aware booking flow per doctor's configured mode (slot picker / token estimate / "walk in any time" for calling-mode). |
| *My appointments* | Upcoming + past list with status, reschedule, cancel, "share location" link. |
| *My prescriptions* | List of signed Rx PDFs. Download / share via WhatsApp. QR-verifiable signature. |
| *My bills* | Open + paid bills. Pay via UPI / card / netbanking. GST invoice download. NHCX cashless status (Stage 1 displays the stub stepper; live insurer integration is Stage 3). |
| *My profile* | Name, DOB, phone, address, language preference, reminder opt-in, ABHA linking. Update photo. |
| *Records (ABHA-linked)* | Read-only view of own records (Stage 1: local Pearl records; Stage 2: federated via ABDM HIU). |
| *WhatsApp inbox* | Conversations from hospital (campaigns, reminders, OTP). Patient can reply; replies route to reception inbox. |

### 6.2 Non-functional requirements

- Installable as a PWA on Android Chrome + iOS Safari.
- Offline-tolerant — service worker caches the dashboard and recent records.
- Lighthouse mobile Performance ≥ 85 on Dashboard, Bills, Book Appointment.
- Lighthouse mobile Accessibility ≥ 95.
- Languages — English + Hindi at launch (Gujarati included in Sprint 3 in the bigger roadmap; included in Stage 1 only if pilot is in Gujarat).
- Touch-friendly — 44px minimum targets.

### 6.3 Acceptance for Module 5

- New patient self-registers and books their first appointment in < 90 s.
- Returning patient logs in (phone + OTP), sees today's appointment, taps "I've arrived" → reception sees them in the queue.
- Patient downloads a signed Rx PDF, scans the QR, confirms the signed hash matches.
- Bill payment via UPI completes within 5 s and updates the invoice status.

---

## 7. Module 6 — Doctor / Hospital Web Panel

*URL pattern:* https://<hospital>.pearl-erp.in
*Surface:* Desktop and tablet web app. Same Next.js codebase with full chrome (sidebar + topbar + ⌘K palette).

### 7.1 Roles & their views

| Role | What they see |
|---|---|
| *Receptionist* | Today's OPD list + patient row with quick-action buttons; Appointment booking; Token Board; Patient search/registration; Bills (read + collect payment); Threaded remarks |
| *Doctor* | OPD queue (their patients only); 3-column consult screen; Prescription writer; Templates + favourite-medicine list; CRM activity on a patient |
| *Pharmacy* | Dispensing Kanban; Medicines master; Inventory + batches |
| *Billing* | Invoice list + detail; Payments; Outstanding balances; Reports |
| *Admin (tenant)* | Users + roles + permissions; Branches; Settings → Appointments (incl. Doctor Modes + Reminders); Hospital profile; Audit logs; Reports |
| *Owner / SLT* | Dashboard with live tiles (today's OPD count, doctor utilisation, collections, pending bills, lead conversion); Reports |

### 7.2 Cross-cutting features

- *Design system* — colour, spacing, typography, elevation all token-driven (frontend/lib/design-tokens.ts).
- *⌘K command palette* — fast-navigate to any patient / OPD visit / billing / appointment; new Rx / new appointment shortcuts.
- *Skeleton loaders on every fetch* — no full-page spinners.
- *Toast + EmptyState primitives* — consistent across the app.
- *Quick-action buttons* (WhatsApp / Email / Call / Add to CRM) follow every patient name.
- *Multi-tenant + branch-aware* — every screen automatically scopes to the user's tenant + active branch.
- *i18n* — English + Hindi shell translations; clinical content stays English with patient communication in patient's preferred language.

### 7.3 Acceptance for Module 6

- Reception completes a patient registration + appointment book + arrived flow in < 60 s.
- Doctor opens an OPD visit, voices or types an Rx, signs in < 60 s.
- Pharmacy dispenses a 3-item Rx + collects payment in < 90 s.
- Admin onboards a new doctor (user + role + working hours + appointment mode) in < 5 min.
- The Lighthouse desktop score is ≥ 90 on Dashboard, OPD Consult, Rx Writer.

---

## 8. Module 7 — Super-Admin Panel + Super-Admin Management

*URL pattern:* https://admin.pearl-erp.in
*Surface:* Desktop-only web app under /super-admin route group with elevated RBAC (super_admin:*). Used by Onviqa operator team and franchise / multi-hospital chain admins.

### 8.1 Tenant management

- *Tenant list* with key metrics per tenant: code, name, active users, monthly OPD volume, MRR, last login, billing health.
- *Onboarding wizard* — guides through:
  1. Tenant code + name + region.
  2. First branch + super-admin user.
  3. Default permissions + roles.
  4. Default doctor modes (Calling / Token / Slot).
  5. ABDM HFR / HPR onboarding initiation (links + checklist).
  6. WhatsApp Business API setup (Gupshup app name + API key).
  7. Payment gateway (Razorpay / Cashfree) credentials.
  8. Goes live with one click.
- *Suspend / archive / restore* — immediate quarantine without data loss; 90-day archival to S3-compat after suspension.
- *Tenant configuration* — feature flag overrides per tenant (e.g. force-disable voice-Rx during pilot, enable LLM personalisation).

### 8.2 Super-admin management

- *List of super-admins* across all tenants — Onviqa operators + franchise admins + tenant super-admins.
- *Permission grants* — granular: per-tenant access, per-module access, can-onboard-tenant, can-view-billing, can-trigger-jobs.
- *Audit trail* — every super-admin action logged with actor / timestamp / IP / device.
- *Two-factor authentication* mandatory for any super-admin role.
- *Session timeout* — super-admin sessions expire after 30 min of inactivity (configurable down to 5 min for high-security tenants).
- *Onboarding flow* — invite via email → set password + TOTP → assign roles → first-login walkthrough.

### 8.3 Pearl ↔️ Hospital billing (separate from hospital ↔️ patient billing)

- Per-tenant subscription:
  - *Plan* (Starter / Growth / Enterprise — see §12 in the master SoW for plan details).
  - *Usage-based components* — WhatsApp messages sent, SMS sent, LLM tokens consumed (Stage 2+), ABDM messages.
- *Invoice generation* — monthly, automatic, emailed to tenant billing contact.
- *Payment recording* — Pearl receives subscription fees from hospitals via bank transfer or auto-debit; tracked here.
- *Subscription state machine* — trial → active → past_due → suspended.
- *Upgrade / downgrade flows* with proration.

### 8.4 Observability (cross-tenant)

- *Aggregated metrics* — total OPD across all tenants, total prescriptions signed, total appointments, total payments.
- *Per-tenant health* — error rates, slow endpoints (p95 > 1 s), failed background jobs.
- *System status page* — public-facing uptime + maintenance windows.
- *Background-job queue* — view + retry failed reminder dispatches, failed WhatsApp deliveries, failed campaign sends.

### 8.5 Support inbox

- Tenant admins can raise tickets from inside their own tenant panel.
- Onviqa operator sees the consolidated inbox in the Super-Admin panel.
- Ticket states: new → triaged → in-progress → resolved → closed.
- Per-tenant SLA visibility (depends on the tenant's plan).

### 8.6 Compliance + DPDP workbench

- *Cross-tenant DPDP request workbench* — patient (or DPO) initiated deletion requests; immediate purge across all surfaces with audit log.
- *Compliance dashboard* — which tenants have audit logging enabled, which have WhatsApp opt-in tracking, which have ABDM consent enforcement, retention policies per tenant.

### 8.7 Acceptance for Module 7

- Onviqa operator onboards a new tenant hospital (with first branch + super-admin + WhatsApp + payment gateway) in < 30 min using the wizard.
- Suspending a tenant blocks all user logins within 60 s and pauses every background job for that tenant.
- A super-admin's TOTP enrolment is mandatory and cannot be skipped.
- DPDP delete request executes in < 60 s and produces an auditable receipt.

---

## 9. Architecture summary — Stage 1

```
┌─────────────────────────────────────────────────────────────────────────┐
│   PATIENT PWA    │   DOCTOR / HOSPITAL    │   SUPER-ADMIN PANEL         │
│   (Next.js)      │   WEB PANEL (Next.js)  │   (Next.js, /super-admin)   │
└─────────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────────┐
│   EDGE: JWT + x-tenant-id + branch_id  ·  i18n (EN + HI)               │
└─────────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────────┐
│   APPLICATION SERVICES (Express + TS, raw SQL, RBAC, event bus)        │
│   patient · appointment · opd · prescription · pharmacy · billing       │
│   doctor-appointment-preference · queue-token · appointment-remarks     │
│   lead · crm-v2 · cohorts · reminders · communications strategies       │
│   admin · super-admin · tenants · branches · users · roles · audit      │
└─────────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────────┐
│   DATA + INTEGRATIONS                                                  │
│   PostgreSQL (multi-tenant, branch-aware)  ·  S3-compat (Rx PDFs)      │
│   Gupshup WhatsApp · Twilio SMS · SMTP/SES email · Razorpay payments    │
│   ABDM M1 (ABHA create + link)  ·  NHCX stub stepper                    │
└─────────────────────────────────────────────────────────────────────────┘
```

*Explicitly NOT in Stage 1:* voice-Rx pipeline, LLM clinical drafts, ABDM M2/M3/M4, NHCX live, IPD/OT/LIS, telemed video, kiosk hardware, nurse-call, AI discharge, voice receptionist.

---

## 10. Technology stack

| Layer | Stack |
|---|---|
| Backend | Node.js + Express + TypeScript, raw SQL via pg, JWT auth, RBAC, module pattern |
| Frontend | Next.js 14 App Router, Zustand, Tailwind, Radix UI, React Hook Form + Zod, Recharts |
| Database | PostgreSQL (managed or self-hosted), multi-tenant via tenant_id on every table |
| Object store | S3-compatible (AWS S3, MinIO, or Wasabi) for Rx PDFs, photos, attachments |
| Communications | Gupshup (WhatsApp) · Twilio (SMS / OTP) · SMTP or SES (email) · web-push (PWA notifications) |
| Payment gateway | Razorpay (or Cashfree as alternate) |
| Hosting | AWS Mumbai (ap-south-1) or DigitalOcean Bangalore — DPDP-compliant Indian residency |
| Observability | OpenTelemetry traces, structured pino logs, Grafana dashboards |
| CI/CD | GitHub Actions → staging → production |

---

## 11. External integrations (Stage 1)

| Integration | Provider | Purpose | Stage 1 status |
|---|---|---|---|
| WhatsApp Business | Gupshup | Patient messaging + reminders + campaigns | Live |
| SMS + OTP | Twilio | Patient OTP login, SMS fallback for reminders | Live |
| Email | SMTP / SES | Reminders, campaign emails | Live |
| Payment gateway | Razorpay | UPI, cards, net-banking | Live |
| ABDM M1 | NHA sandbox + production | ABHA create + link at registration | Live |
| Drug DB | Public Indian formulary (Stage 1 uses internal seed; Stage 2 upgrades to MedEx/Datarequisite) | Drug autocomplete + Schedule flags | Seed only |
| SNOMED CT | C-DAC (free for India) | Diagnosis coding | Live |
| ICD-10 | WHO (free) | Diagnosis coding | Live |

*Not yet wired in Stage 1 (Stage 2+):* Augnito ASR, DrugBank Clinical API, Retell AI, Exotel, Daily.co WebRTC, NHCX, Aadhaar e-Sign, DSC.

---

## 12. Compliance posture — Stage 1

- *DPDP Act 2023* — granular consent at registration; opt-in/out for WhatsApp + SMS + email; right to erasure with full audit; AP-South residency.
- *ABDM M1* — ABHA create / link / verify; HFR + HPR onboarding for the tenant.
- *Telemedicine Practice Guidelines 2020* — Stage 1 covers OPD only (no telemed); Schedule H/H1 prescriptions flagged in the writer; Schedule X prescriptions require manual review and override.
- *IT Act 2000* — digital signature on every Rx (basic implementation using NMC reg number + SHA-256 of canonical Rx JSON; full eSign with Aadhaar ESP is Stage 2).
- *GST* — invoices conform to GST format; HSN/SAC codes per line item where applicable.
- *TDS* — TDS on professional fees report for accountants.
- *Audit logging* — every clinical and admin action logged with actor + timestamp + IP.

---

## 13. Phased rollout — Stage 1 calendar

Assuming 18 weeks of calendar time (about 4.5 months) for end-to-end Stage 1 delivery on one pilot hospital.

| Week | Phase | Deliverable |
|---|---|---|
| 1–2 | *Setup* | Cloud infra, CI/CD, base repo, design system, login flow, tenant onboarding for pilot |
| 3–4 | *Identity + multi-tenancy* | Users, roles, permissions, branches, audit logs, super-admin scaffold |
| 5–8 | *Module 1 OPD + Module 2 Appointments* | Patient registration, OPD visit, prescription writer (typed), doctor modes, appointment booking, token board, reminders cascade |
| 9–10 | *Module 3 Billing* | Invoice, line items, payment recording, pharmacy dispensing Kanban, GST + TDS reports |
| 11–12 | *Module 4 CRM + Campaigns* | Lead pipeline, audience builder, campaign engine, patient login (phone OTP), care cohort foundation |
| 13–14 | *Module 5 Patient PWA* | Patient portal screens (dashboard, book, bills, Rx, profile) |
| 15 | *Module 6 polish* | Doctor / Hospital web panel polish, accessibility audit, mobile responsive pass on all role views |
| 16 | *Module 7 Super-Admin* | Tenant onboarding wizard, super-admin management, Pearl-billing |
| 17 | *UAT + training* | User-acceptance testing with pilot hospital, train-the-trainer, runbook handover |
| 18 | *Go-live + hyper-care* | Production deploy + 1 week intensive on-site support |

After Week 18: Pearl operator switches to *3-month hyper-care* (weekly check-ins, ticket SLA monitoring) before transitioning to standard support.

---

## 14. Team — Stage 1 minimum

| Role | FTE | Stage-1 work |
|---|---|---|
| Engineering lead | 1 | Architecture, code review, PR gating |
| Backend engineers (TS) | 2 | All 7 modules' APIs + integration |
| Frontend engineers (Next.js) | 2 | Doctor/hospital panel + patient PWA + super-admin |
| DevOps / SRE | 0.5 | Infra, CI/CD, observability |
| Clinical informaticist | 0.5 (PT) | OPD workflow, basic CDSS rules |
| UX designer | 0.5 (PT) | Design system, key screens |
| QA lead + automation | 1 | Manual UAT + Playwright e2e |
| Regulatory consultant | 0.25 (PT) | DPDP + ABDM + GST review |
| Customer success | 1 | Pilot hospital relationship + training |

*Total Stage-1 team:* ~7–9 FTE for 18 weeks.

---

## 15. Deliverables — Stage 1

1. *Pearl ERP web panel* (Next.js — desktop + tablet, all 4 staff roles, super-admin panel).
2. *Pearl ERP Patient PWA* (installable Android + iOS; 8 screens).
3. *Pearl ERP backend* (Express + TypeScript; 20+ modules; PostgreSQL schema with multi-tenant + branch isolation).
4. *WhatsApp Business templates* registered with Gupshup (appointment reminder, OTP, refill reminder, bill due, campaign blasts).
5. *Documentation*:
   - This Scope of Work
   - API reference (auto-generated)
   - Operational runbook (deploy, restart, backup, restore, common queries)
   - User manuals — one per role (reception, doctor, pharmacy, billing, admin)
   - Video tutorials per role
   - DPDP compliance posture
   - GST invoice format reference
6. *Training*:
   - 1 week on-site training at the pilot hospital.
   - Train-the-trainer for hospital's internal admin.
   - 24×7 ticket support during hyper-care.
7. *Demo tenant* (Pearl Demo Hospital) seeded with realistic data for sales demos.

---

## 16. Success criteria — Stage 1

The pilot hospital is considered *Stage-1 live* when all of the following are true for 2 consecutive weeks of production usage:

- [ ] ≥ 80% of OPD visits are recorded in Pearl (not on paper or in a parallel system).
- [ ] ≥ 80% of prescriptions are typed + signed in Pearl (and printed from Pearl).
- [ ] ≥ 90% of patients receive their appointment reminder via WhatsApp.
- [ ] Pharmacy dispensing happens through the Kanban; not on paper bill-books.
- [ ] All collections (cash + digital) are recorded in Pearl billing.
- [ ] GST + TDS monthly reports are downloadable and tally to the accountant's books.
- [ ] At least one campaign has been sent through Pearl with > 50 patients reached.
- [ ] Patient PWA has ≥ 25% adoption (measured as % of returning patients who log in within 30 days).
- [ ] Doctor + reception NPS ≥ +40 after 4 weeks of use.
- [ ] Zero data-loss incident; zero unauthorised cross-tenant data access.
- [ ] DPDP delete request executed at least once in test environment with full audit.

---

## 17. Risks & mitigations — Stage 1

| Risk | Impact | Mitigation |
|---|---|---|
| Hospital change-management resistance | Adoption stalls; staff revert to paper | 4 weeks of on-site support + shadow-mode for first 2 weeks (paper + Pearl in parallel) |
| WhatsApp template approval delays | Reminders + campaigns blocked | Submit templates in week 5 (8 weeks before go-live) |
| Razorpay onboarding delays | Online payments delayed | Cash + manual UPI recording fallback always works |
| PWA install friction on iOS | Lower patient adoption on Apple devices | WhatsApp-based flows mirror every PWA feature |
| Multi-tenant data leak bug | Catastrophic loss of trust | Tenant_id filter lint check + integration tests asserting cross-tenant isolation + pen-test before go-live |
| Slow doctor adoption of typed Rx | Continued paper Rx | Voice-Rx in Stage 2 fixes this; Stage-1 mitigation is favourite-medicine quick-add + per-doctor templates |
| GST format errors | Tax compliance issue | Chartered accountant reviews invoice format before go-live |
| Pilot hospital scope creep | Stage 1 timeline slips | Out-of-scope explicitly listed; change requests via formal change control with timeline impact assessment |

---

## 18. Explicitly OUT of Stage 1

The following are *Stage 2 or later* — explicitly not included in Stage 1 fees or timeline:

- IPD module (wards, beds, admissions, daily charges, eMAR, vitals chart, IO chart, nursing notes).
- OT scheduling + implant traceability.
- LIS / lab analyser HL7 integration.
- RIS / PACS / DICOM viewer.
- Telemedicine + video + e-consent.
- Voice-Rx (ambient recording + LLM draft + CDSS gate + Aadhaar e-Sign).
- Nurse-Call System with tiered escalation.
- Voice AI Receptionist (Retell / Exotel phone agent).
- AI Discharge Summary (LLM-drafted IPD discharge).
- Predictive CDS (sepsis, deterioration, no-show).
- Self-service kiosk + Bluetooth thermal printer.
- NABH Quality Dashboard.
- ABDM M2 (HIP push), M3 (HIU pull), M4 (NHCX cashless live).
- Multi-language voice prompts.
- LLM-personalised reminders.
- Agentic Revenue Cycle.
- Pearl Agent Factory.
- HRMS / payroll integration.
- Asset / biomed tracker.
- AI image triage (CXR / ECG / retinal).

Each of these is a Stage-2-or-later add-on with its own SoW and pricing.

---

## 19. Commercial (Stage 1 indicative)

Stage 1 typically prices as a *fixed implementation fee* + *monthly subscription*:

| Component | Indicative |
|---|---|
| Implementation fee (one-time, includes 4 weeks on-site go-live) | ₹X (per quote, function of beds / branches / doctors) |
| Monthly subscription (Growth plan equivalent) | ₹Y per month |
| Usage-based components (Stage 1: WhatsApp messages + SMS) | At cost + small margin |
| Hyper-care months 1–3 | Included |
| Hyper-care month 4+ | Included in monthly subscription |

Detailed pricing per pilot hospital is captured in a separate *Commercial Schedule* alongside this SoW and signed jointly.

---

## 20. Acceptance + sign-off

This Stage-1 SoW is signed when both parties (Pearl operator / Onviqa Inc + pilot hospital) confirm:

1. The seven modules listed in §1 are agreed as the Stage-1 deliverable set.
2. The acceptance criteria in each module's section are agreed.
3. The §16 Success criteria for going Stage-1 live are agreed.
4. The §18 Out-of-Scope list is acknowledged.
5. The commercial schedule (separate document) is signed.

*Stage-1 SoW signature page*

| Party | Name | Title | Date | Signature |
|---|---|---|---|---|
| Pearl (Onviqa Inc) | | | | |
| Pilot Hospital | | | | |

---

## 21. Next steps after sign-off

1. Kick-off workshop (half-day at pilot hospital): walk every staff role through Stage 1 screens, capture local workflow nuances.
2. Confirm pilot hospital's ABDM HFR ID + HPR IDs for all doctors.
3. Start the 18-week calendar in §13.
4. Schedule the Stage-2 scoping conversation for week 14 of Stage 1 (so Stage 2 can begin immediately after Stage 1 stabilises).

---

End of Stage 1 Scope of Work.

Companion documents:
- [PEARL-ERP-AI-VISION.md](./PEARL-ERP-AI-VISION.md) — full strategic vision (all stages)
- [PEARL-ERP-SCOPE-OF-WORK.md](./PEARL-ERP-SCOPE-OF-WORK.md) — full multi-stage SoW
- [MODULE-DOCTOR-APPT-MODES.md](./MODULE-DOCTOR-APPT-MODES.md), [MODULE-OPD-APPT-LIST.md](./MODULE-OPD-APPT-LIST.md) — module specs referenced in §2 and §3
- Stage 2+ SoWs to be drafted closer to the time, based on pilot learnings.
