<div align="center">

# MedCore

### Hospital Information System for Indian Healthcare

A full-stack, monorepo HIS covering the patient journey from appointment to discharge — clinical, operational, financial, HR, and engagement workflows in one typed codebase.

[![Live Demo](https://img.shields.io/badge/live_demo-medcore.globusdemos.com-2563eb?style=for-the-badge)](https://medcore.globusdemos.com)
[![Tests](https://img.shields.io/badge/tests-2583_passing-16a34a?style=for-the-badge)](#testing)
[![E2E](https://img.shields.io/badge/playwright_e2e-29_passing-0ea5e9?style=for-the-badge)](#testing)
[![a11y](https://img.shields.io/badge/axe--core-12_passing-7c3aed?style=for-the-badge)](#accessibility)
[![Routers](https://img.shields.io/badge/api_routers-78-f59e0b?style=for-the-badge)](#architecture)
[![Models](https://img.shields.io/badge/prisma_models-151-0891b2?style=for-the-badge)](#architecture)
[![License](https://img.shields.io/badge/license-Proprietary-dc2626?style=for-the-badge)](LICENSE)

[Live Demo](https://medcore.globusdemos.com) · [Features](#feature-catalog) · [Architecture](#architecture) · [Testing](#testing) · [Deployment](#deployment) · [Commercial](#commercial-licensing)

![Dashboard](docs/screenshots/03-dashboard-admin.png)

</div>

---

## Overview

MedCore is a hospital information system built as a TypeScript monorepo. It spans outpatient and inpatient care, emergency, surgery, pharmacy, lab, blood bank, billing with GST and Razorpay, HR and payroll, patient engagement, and a React Native patient app. The web dashboard, API, and mobile app share validation schemas and types end to end.

The project is under active development. A live demo instance runs at **[medcore.globusdemos.com](https://medcore.globusdemos.com)** and is exercised by the Playwright E2E suite on every push.

### At a glance

| | |
|---|---|
| **Tests passing** | ~2,583 across 6 layers (unit, contract, smoke, web, integration, permissions) plus mobile |
| **E2E** | 29 Playwright specs against the live demo URL |
| **Accessibility** | 12 axe-core tests, WCAG 2.1 AA, per-page contrast budgets |
| **API routers** | 78 (27+ AI routers plus ABDM, FHIR, HL7 v2 inbound, insurance claims, chart-search) |
| **Prisma models** | 151 |
| **Prisma migrations (production)** | 16, all applied via `migrate deploy` |
| **CI workflows** | 4 (typecheck, API, web, Playwright E2E) |
| **Demo URL** | https://medcore.globusdemos.com |

---

## Feature Catalog

### AI Features

All AI features run on **[Sarvam AI](https://sarvam.ai)** (`sarvam-105b`), an Indian LLM provider, ensuring data residency within India for DPDP Act compliance. Speech-to-text uses Sarvam ASR (`saaras:v3`). The AI layer is observable (every LLM call logged with latency, tokens, and truncated prompt), retry-resilient (`withRetry` with exponential back-off), and tested via a Vitest eval harness with gold-standard fixtures.

- **AI Triage Chatbot** (`/dashboard/ai-booking`) — multi-turn symptom collection supporting English and Hindi. Deterministic red-flag detection (cardiac, stroke, respiratory, bleeding, suicidal ideation, obstetric, neonatal, Hindi phrases) fires before the LLM, triggering an immediate emergency screen with call-112 instructions. After 4+ exchanges the LLM assesses the complaint, recommends specialties and matching doctors, and lets the patient book directly. Supports booking on behalf of a dependent (child, elderly parent). Patients can skip AI triage and go straight to manual booking. Live-agent handoff creates a chat room with the on-call doctor.
- **AI Scribe** (`/dashboard/scribe`) — ambient speech-to-text during consultation via Sarvam ASR or Web Speech API. Transcripts stream to the API every 5 final utterances; once 3+ entries accumulate, the LLM generates a structured SOAP draft (Subjective / Objective / Assessment / Plan) with ICD-10 code suggestions, CPT codes, and per-section confidence scores. Doctors can review by section (Accept / Edit / Reject) using voice commands ("accept subjective", "edit plan", etc.). On sign-off the note is written to the EHR consultation record, and draft lab orders and referrals are auto-created from the SOAP plan.
- **Drug Safety Check** — runs automatically inside the Scribe transcript endpoint on every SOAP draft. Two-layer architecture: fast deterministic layer checks ~15 curated high-risk pairs (warfarin + NSAIDs, SSRI + MAOI, sildenafil + nitrates, etc.), allergy cross-reactivity families, condition contraindications, paediatric contraindications, and renal/hepatic dosing flags. The LLM catches anything outside the curated list. Alerts are severity-coded CONTRAINDICATED → SEVERE → MODERATE → MILD with generic alternatives suggested. A `DrugAlertBanner` in the Scribe UI blocks sign-off on CONTRAINDICATED alerts until the doctor explicitly acknowledges.
- **Medication Adherence Bot** (`/dashboard/adherence`) — enroll a patient's prescription into a reminder schedule. A 15-minute background scheduler checks for due medications and sends AI-personalised WhatsApp/SMS reminders in the patient's preferred language.
- **AI Lab Report Explainer** (`/dashboard/lab-explainer`) — generates a plain-language explanation of lab results for the patient, flagging abnormal values. Explanations are held in a HITL approval queue; a doctor reviews and approves before the explanation is sent to the patient.
- **AI Letter Generator** (`/dashboard/letters`) — one-click generation of referral letters and discharge summaries from structured clinical data. Letters are editable and printable directly from the browser.
- **No-Show Prediction** (`/dashboard/predictions`) — rule-based model (7 features: historical no-show rate, lead time, day of week, hour of appointment, new-patient flag, recent no-show flag, appointment type) predicts per-appointment risk. Batch predictions run nightly; the dashboard shows high-risk appointments for proactive follow-up.
- **ER Triage Assist** (`/dashboard/er-triage`) — MEWS scoring (respiratory rate, O₂ sat, heart rate, systolic BP, temperature, consciousness) plus AI-suggested ESI triage level with clinical rationale.
- **Pharmacy Inventory Forecasting** (`/dashboard/pharmacy-forecast`) — forecasts stock requirements for the next 30/60/90 days based on dispensing history, with AI-generated procurement insights.
- **AI Analytics** (`/dashboard/ai-analytics`) — tabbed dashboard showing triage session volume and conversion rates, scribe session counts, sign-off rates, average edit counts, and doctor-edit heatmaps.
- **Knowledge Base (RAG)** — PostgreSQL full-text search (`to_tsvector` / `plainto_tsquery`) over a `KnowledgeChunk` table seeded from ICD-10 codes, medicine catalogue, and clinical protocols. Retrieved context is injected into every LLM prompt to ground responses in hospital-specific data without requiring pgvector.

### Shipped this sprint (April 2026)

- **Prompt registry with versioning + rollback** (`/api/v1/ai/admin/prompts`) — every LLM prompt (`TRIAGE_SYSTEM`, `SCRIBE_SYSTEM`, `DRUG_SAFETY`, etc.) lives in the `Prompt` table as a row per version. Admins can POST a new (inactive) version, activate it with a one-click API call, and one-shot roll back to the previous active version. `getActivePrompt()` reads through a 60-second in-memory cache so the hot path doesn't hit Postgres on every triage/scribe call, and falls back to the hardcoded `PROMPTS` constant if the DB is unreachable — registry failures degrade gracefully rather than take the triage endpoint down. Every mutation is audit-logged (`PROMPT_VERSION_CREATE`, `..._ACTIVATE`, `..._ROLLBACK`).
- **Claims auto-draft from SOAP** (`POST /api/v1/ai/claims/draft/:consultationId`) — takes the AI Scribe output (SOAP note + ICD-10 + CPT codes stored on `AIScribeSession`) and the consultation invoice, and emits a pre-filled `InsuranceClaim2` draft. Reception sees them in the `/pending-drafts` queue, reviews for 30 seconds, and fires to the TPA with one click instead of re-keying every field. Includes a denial-risk predictor (`GET /:claimId/denial-risk`) and a machine-replayable auto-fix endpoint (`POST /:claimId/auto-fix`) for predictor-identified issues.
- **Speaker diarization in Scribe transcripts** (`PATCH /api/v1/ai/scribe/:sessionId/transcript/:index/speaker`) — the live scribe UI assumes alternating speakers (good enough most of the time), but doctors can now relabel any utterance as DOCTOR / PATIENT / ATTENDANT post-hoc. The relabel feeds back into the SOAP regeneration so the generated note attributes symptoms to the right participant.
- **Extended prod smoke test** — `scripts/prod-smoke-test.ts` now exercises **20 dashboard pages** (7 original AI pages + 13 added in the Apr 2026 PRD batch) on every deploy.

> Deeper architecture, observability, retry, and HITL details live in [`docs/AI_ARCHITECTURE.md`](docs/AI_ARCHITECTURE.md).

### Compliance & Interoperability

- **ABDM / ABHA Gateway** (`/api/v1/abdm`) — ABHA address and 14-digit ABHA number verification, link / delink to MedCore patient records, consent-artefact creation (ABDM §5 CM flow), and CareContext discovery for Health Information Providers. Validates ABHA address format (`handle@domain`) and 14-digit ABHA numbers against the NN-NNNN-NNNN-NNNN pattern. Every gateway call is audit-logged.
- **FHIR R4 export** (`/api/v1/fhir`) — read-only export of `Patient`, `Encounter`, and `Patient/:id/$everything` bundles. Responses use `application/fhir+json` content type per FHIR R4 §3.1.6. Errors surface as `OperationOutcome` resources. Role-gated so that only clinicians and the patient themselves can read. Every resource read is audit-logged (`FHIR_PATIENT_READ`, `FHIR_PATIENT_EVERYTHING`, etc.).
- **Insurance / TPA Claims** (`/api/v1/claims`) — pre-authorisation lifecycle, claim submission, document attachments, and status-event timeline. Works alongside the existing `/api/v1/preauth` workflow; status events are persisted for audit and SLA tracking.
- **Jitsi deep integration** — the existing `/api/v1/telemedicine` router now supports a waiting-room lifecycle (`PATIENT_WAITING` → `ADMITTED` / `DENIED`), with dedicated join/admit endpoints and realtime state propagation.
- **Consent & retention** — `ConsentArtefact` model captures patient consent scope, purpose, and expiry. An `audio-retention` scheduler enforces consultation-audio retention windows.

### Intelligence Layer

A cross-cutting AI substrate that every feature above plugs into. The pieces:

- **Sarvam AI** (`sarvam-105b`, India region, DPDP-compliant) — single LLM vendor for every feature. ASR uses `saaras:v3`. All calls flow through `apps/api/src/services/ai/sarvam.ts`.
- **RAG + Postgres FTS** — `KnowledgeChunk` table with `to_tsvector` / `plainto_tsquery`. No pgvector required. Seeded from ICD-10, medicine catalogue, and clinical protocols; enriched by the ingest pipeline (below).
- **Fire-and-forget ingest pipeline** (`services/ai/rag-ingest.ts`) — SOAP notes, lab results, prescriptions, and uploaded patient documents are chunked (~800 chars, paragraph-aware) and upserted into `KnowledgeChunk` from the originating route handler. `tesseract.js` handles OCR for image uploads; `pdf-parse` handles text extraction from PDFs. Ingest failures never break the request path.
- **ML no-show predictor** (`services/ai/no-show-predictor.ts` + `services/ai/ml/logistic-regression.ts`) — 7-feature logistic-regression model over historical appointment data. Nightly batch prediction populates `/dashboard/predictions`.
- **Holt-Winters pharmacy forecast** (`services/ai/ml/holt-winters.ts`) — triple-exponential-smoothing time-series forecast of medicine demand with seasonality. Drives 30/60/90-day procurement insights on `/dashboard/pharmacy-forecast`.
- **Ambient chart search** (`/api/v1/ai/chart-search`) — free-text search over a patient's own ingested chart (notes, labs, prescriptions, uploaded docs) with LLM-synthesised answer. Currently ranked purely by Postgres FTS — see Known Follow-ups for the rerank roadmap.
- **Observability, retry, HITL** — every LLM call goes through `logAICall` (JSON logs with feature, tokens, latency) and `withRetry` (3 attempts, exponential back-off, degrades to `AIServiceUnavailableError` + HTTP 503 on exhaustion). Patient-facing AI output (lab explanations, adherence reminders) goes through a doctor-approval queue before reaching the patient.
- **Eval harness** — Vitest + gold-standard fixtures under `apps/api/src/test/ai-eval/`. Runs locally and gates regressions on triage red-flag recall, SOAP note accuracy, and drug-safety alerts.

### Clinical

- **OPD** — appointments, walk-in queue with token generation (DB unique constraint, race-tested), live queue updates over Socket.IO, vulnerability flagging for at-risk patients.
- **Prescriptions** — drug interaction checks, renal dose calculator, scannable QR codes (real PNG generated with `qrcode`, decodable via `jsqr`), public `/verify/rx/[id]` verification page, PDF export via pdfkit.
- **Lab** — multi-test orders, result entry, delta flag against previous values, CRITICAL panic-value alerts, QC with Levey-Jennings charts, TAT tracking.
- **Admissions / IPD** — ward and bed management, nurse MAR, isolation, bed occupancy, discharge summary PDF.
- **Emergency** — 5-level triage, MEWS/GCS/RTS scoring, live ER board via `ER:update` Socket.IO events, MLC tracking.
- **Surgery / OT** — pre-op checklist enforced server-side, intra-op timing, PACU, SSI tracking, OT calendar.
- **Maternity & Pediatrics** — antenatal workflow with ACOG risk scoring and SVG partograph, pediatric growth charts, India UIP immunization schedule.
- **Blood Bank** — donor registry, ABO/Rh matching, component separation, unit reservations.
- **Ambulance** — dispatch with status transitions, fleet and fuel logs.
- **Telemedicine** — Jitsi video sessions with in-call chat and prescription creation.

### Operations

- **Inventory** — reorder thresholds with scheduled auto-PO generation.
- **Purchase orders** — approve/receive workflow, partial GRN, three-way match.
- **Suppliers** — contracts, GST details, performance tracking.
- **Assets** — depreciation, calibration, warranty alerts, QR tags, dispose workflow.
- **Visitor management** — check-in with a 2-per-patient cap, printable passes, blacklist.
- **Health packages** — preventive bundles with validity and family sharing.

### Finance

- **GST-aware invoicing** with CGST + SGST split, amount-in-words, PDF via pdfkit.
- **Razorpay integration** — server-side `verifyPayment` (fail-closed in production) plus a real webhook handler at `POST /api/v1/billing/razorpay-webhook` with HMAC-SHA256 raw-body verification, idempotency via `Payment.transactionId @unique`, and amount cross-check against the Razorpay REST API.
- **Insurance / TPA** — pre-authorization and claim workflow.
- **Refunds, credit notes, discounts** (flat / percentage) with threshold-based approvals.
- **Expenses and budgets** with category tracking and monthly variance.

### HR and People

- **Shift roster** grouped by morning / afternoon / night.
- **Leaves** — balance tracking, approval workflow, 6 leave types, calendar view.
- **Payroll** — basic + allowances + overtime with approval and pay-slip generation.
- **Seven roles** — `ADMIN`, `DOCTOR`, `NURSE`, `RECEPTION`, `PATIENT`, `PHARMACIST`, `LAB_TECH`. A permissions matrix test exercises **178 role/endpoint assertions**.
- **Certifications and holiday calendar** (Indian public holidays template).

### Patient Engagement

- **Feedback** with 5-star ratings, NPS, sentiment analysis.
- **Complaints** with SLA due-at calculation and escalation.
- **Internal chat** over Socket.IO with reactions, pinning, mentions, department channels.
- **Notifications** — 13 notification types × 4 channels (WhatsApp / SMS / Email / Push) with templated messages, quiet-hours defer, `drainScheduled` cron that picks up both scheduled and NULL `scheduledFor` rows, and retry-once on failure.

### Mobile (React Native + Expo SDK 53)

- **Patient app** — appointments, live queue over Socket.IO, prescription viewer, billing tab with native Razorpay checkout or WebView fallback, push notifications via `expo-notifications`.
- **Patient AI screens** — AI triage chat, medication adherence tracker, and plain-language lab explanations on the mobile tab bar (`apps/mobile/app/ai/`), calling the same API endpoints as the web dashboard.
- **Doctor-lite app** — workspace, patients, prescriptions.
- 401 refresh interceptor, env-driven API URL via `expo-constants`, EAS build profiles for dev/preview/production.

### Security

- **Persistent auth state** — 2FA temp tokens and password-reset codes are stored in the database, not in-memory maps, so they survive restarts.
- **TOTP 2FA** implemented with pure Node `crypto` (no external library).
- **Refresh-token rotation** with replay detection; JWTs include `jti` to avoid same-second collisions.
- **File uploads** — row-level ACL, HMAC-signed URLs, magic-byte MIME sniffing that rejects an executable renamed to `.jpg`, 10 MB cap.
- **Audit log** on every mutation with CSV export.
- **Rate limits** — 600 req/min global, 30 req/min on auth endpoints.

### Accessibility and i18n

- WCAG 2.1 AA baseline; axe-core CI gate with per-page budget overrides. Hard-fails on `button-name`, `select-name`, `label`, and `image-alt`.
- English and Hindi translations across **374 keys** covering 10 dashboard pages. `<html lang>` switches reactively.

### PDF Generation

Server-side PDFs via pdfkit for prescriptions (with embedded PNG QR), invoices (GST breakdown, amount-in-words), and discharge summaries. Routes branch on `?format=pdf` so the HTML print flow still works for backward compatibility.

---

## Tech Stack

| Layer | Tools |
|---|---|
| **Runtime** | Node.js 20, TypeScript |
| **API** | Express 4, Zod validation, Socket.IO server |
| **Database** | PostgreSQL 16, Prisma 6 (migrations, 151 models) |
| **Web** | Next.js 15 (App Router), React 19, Tailwind CSS v4, Zustand, `socket.io-client` |
| **Mobile** | React Native, Expo SDK 53, `expo-router`, `expo-notifications`, `expo-constants`; patient AI screens (triage, lab explainer, adherence) |
| **Auth** | JWT with refresh rotation, bcrypt, TOTP 2FA (pure Node `crypto`) |
| **Payments** | Razorpay SDK, raw-body HMAC-SHA256 webhook verification |
| **AI / LLM** | Sarvam AI `sarvam-105b` (OpenAI-compatible, India region), Sarvam ASR `saaras:v3` |
| **Document ingest** | `tesseract.js` (OCR for image uploads), `pdf-parse` (text extraction from PDFs) |
| **Interop** | FHIR R4 export, ABDM / ABHA gateway client, Insurance / TPA claim workflow |
| **PDF / QR** | `pdfkit`, `qrcode`, `jsqr` (verification) |
| **Testing** | Jest, Supertest, Playwright, `axe-core`, Vitest (LLM eval harness) |
| **Monorepo** | Turborepo, npm workspaces |
| **Ops** | PM2, systemd, nginx, Let's Encrypt, Docker (Postgres), `pg_dump` backups |
| **CI** | GitHub Actions (typecheck, API tests with Postgres service, web tests, Playwright E2E) |

---

## Architecture

```
medcore/
├── apps/
│   ├── api/          Express API — routers, services, Socket.IO gateway
│   ├── web/          Next.js 15 dashboard (App Router, React 19)
│   └── mobile/       React Native (Expo) patient and doctor-lite apps
├── packages/
│   ├── shared/       Zod schemas, shared types (end-to-end type safety)
│   └── db/            Prisma schema, client, seeds, migrations
├── e2e/              Playwright specs (run against live URL)
├── scripts/          deploy.sh, backup, health-check, migration helpers
└── docs/             PRD, ARCHITECTURE, DEPLOYMENT, MIGRATIONS, AI_ARCHITECTURE, TEST_PLAN, 68 Playwright screenshots
```

### Key decisions

- **End-to-end type safety.** The same Zod schemas validate API requests and generate TypeScript types consumed by the web and mobile apps.
- **Prisma-first data modeling.** Production uses `prisma migrate deploy` — never `db push`. The current migration history covers initial schema, auth persistence tables, PHARMACIST/LAB_TECH roles, Razorpay + push-token drift, marketing enquiry, AI feature tables, triage consent fields, AI-feature model expansion, and the ABDM / insurance / Jitsi / RAG compliance layer. Full policy, hand-crafting rules, and the `.prisma-models*.md` proposal pattern live in [`docs/MIGRATIONS.md`](docs/MIGRATIONS.md).
- **Socket.IO for realtime.** Live OPD queue, ER board, chat, admissions.
- **Fail-closed payments.** Razorpay signature mismatch returns 400 in production; webhooks use raw-body verification and idempotency on `Payment.transactionId`.
- **Row-level file ACLs** with HMAC-signed URLs and magic-byte sniffing.
- **Sarvam AI for DPDP compliance.** All LLM calls route to Sarvam AI's India-region endpoint (`api.sarvam.ai`), satisfying the Digital Personal Data Protection Act's data-residency requirement. The `SARVAM_API_KEY` env var replaces any previous cloud LLM key.
- **RAG without pgvector.** The knowledge layer uses PostgreSQL full-text search (`to_tsvector`/`plainto_tsquery`) over a `KnowledgeChunk` table, avoiding the need for a Postgres extension and keeping the deployment footprint unchanged.
- **Human-in-the-loop for clinical output.** Lab explanations require doctor approval before reaching the patient. Scribe SOAP notes require explicit doctor sign-off. Drug CONTRAINDICATED alerts block sign-off until acknowledged.

---

## Testing

MedCore layers its tests so each tier tests a different boundary:

| Layer | Count | What it covers |
|---|---:|---|
| **Unit** | ~550 | Helpers, validators, utilities, notification channel adapters, red-flag detection (51 cases), ML primitives (Holt-Winters, logistic regression), ABDM client, FHIR resource builders, consent service |
| **Contract** | ~140 | Zod request/response schemas between API and web |
| **Smoke** | 30 | Fast sanity pass across critical routes |
| **Web** | ~420 | React component and page-level tests, including the new AI dashboard pages |
| **Integration** | ~900 | Full HTTP through Express + Prisma against a real Postgres. Includes concurrency, realtime delivery, permissions matrix, auth edges, 2FA, notification channel shapes, Razorpay webhook, AI triage / scribe / chart-search / letters / predictions / report-explainer / adherence / er-triage / pharmacy / knowledge / transcribe, insurance claims, and telemedicine-deep (waiting room) |
| **Mobile** | 30 | React Native render / logic tests across the patient AI screens |
| **AI eval** | Vitest harness | Gold-standard fixtures under `apps/api/src/test/ai-eval/`; gates regressions on triage red-flag recall and SOAP accuracy |
| **Total** | **~2,583** | |

In addition:

- **29 Playwright E2E tests** hit the live demo URL on every push (1 gated behind `E2E_FULL`).
- **12 axe-core accessibility tests** with per-page color-contrast budgets.

### Running tests locally

```bash
# API test tiers
npm --prefix apps/api run test:unit
npm --prefix apps/api run test:contract
npm --prefix apps/api run test:smoke
npm --prefix apps/api run test:integration   # requires Postgres

# Web tests
npm --prefix apps/web run test

# Playwright E2E (against local or live URL)
npx playwright test
E2E_FULL=1 npx playwright test               # include the gated spec
```

GitHub Actions runs four workflows on every push: typecheck, API tests with a Postgres service container, web tests, and Playwright E2E.

---

## Screenshots

All **68 Playwright screenshots** live in [`docs/screenshots/`](docs/screenshots/). A curated selection is below.

### Role dashboards

| Admin | Doctor | Nurse |
|---|---|---|
| ![Admin](docs/screenshots/03-dashboard-admin.png) | ![Doctor](docs/screenshots/04-dashboard-doctor.png) | ![Nurse](docs/screenshots/05-dashboard-nurse.png) |

### OPD and patient

| Appointments | Live queue | Prescriptions |
|---|---|---|
| ![Appointments](docs/screenshots/10-appointments.png) | ![Queue](docs/screenshots/12-queue.png) | ![Prescriptions](docs/screenshots/17-prescriptions.png) |

### Clinical

| Emergency / triage | Surgery | Lab |
|---|---|---|
| ![Emergency](docs/screenshots/23-emergency.png) | ![Surgery](docs/screenshots/24-surgery.png) | ![Lab](docs/screenshots/32-lab.png) |

### Operations and finance

| Billing | Purchase orders | Analytics |
|---|---|---|
| ![Billing](docs/screenshots/37-billing.png) | ![Purchase Orders](docs/screenshots/44-purchase-orders.png) | ![Analytics](docs/screenshots/59-analytics.png) |

<details>
<summary><b>View all 68 screenshots</b></summary>

Auth: [login](docs/screenshots/00-login.png) · [register](docs/screenshots/01-register.png) · [forgot password](docs/screenshots/02-forgot-password.png)

Dashboards: [admin console](docs/screenshots/06-admin-console.png) · [calendar](docs/screenshots/07-calendar.png) · [doctor workspace](docs/screenshots/08-workspace-doctor.png) · [nurse workstation](docs/screenshots/09-workstation-nurse.png)

OPD: [walk-in](docs/screenshots/11-walk-in.png) · [token display](docs/screenshots/13-display-token.png) · [patient list](docs/screenshots/14-patients-list.png) · [immunization schedule](docs/screenshots/15-immunization-schedule.png) · [vitals](docs/screenshots/16-vitals.png) · [controlled substances](docs/screenshots/18-controlled-substances.png)

IPD: [wards](docs/screenshots/19-wards.png) · [admissions](docs/screenshots/20-admissions.png) · [medication dashboard](docs/screenshots/21-medication-dashboard.png) · [census](docs/screenshots/22-census.png)

Acute: [OT](docs/screenshots/25-ot.png) · [telemedicine](docs/screenshots/26-telemedicine.png) · [antenatal](docs/screenshots/27-antenatal.png) · [pediatric](docs/screenshots/28-pediatric.png) · [referrals](docs/screenshots/29-referrals.png)

Diagnostics: [medicines](docs/screenshots/30-medicines.png) · [pharmacy](docs/screenshots/31-pharmacy.png) · [lab QC](docs/screenshots/33-lab-qc.png) · [blood bank](docs/screenshots/34-bloodbank.png) · [ambulance](docs/screenshots/35-ambulance.png) · [assets](docs/screenshots/36-assets.png)

Finance: [refunds](docs/screenshots/38-refunds.png) · [payment plans](docs/screenshots/39-payment-plans.png) · [pre-auth](docs/screenshots/40-preauth.png) · [discount approvals](docs/screenshots/41-discount-approvals.png) · [packages](docs/screenshots/42-packages.png) · [suppliers](docs/screenshots/43-suppliers.png) · [expenses](docs/screenshots/45-expenses.png) · [budgets](docs/screenshots/46-budgets.png)

HR: [duty roster](docs/screenshots/47-duty-roster.png) · [my schedule](docs/screenshots/48-my-schedule.png) · [leave management](docs/screenshots/49-leave-management.png) · [my leaves](docs/screenshots/50-my-leaves.png) · [leave calendar](docs/screenshots/51-leave-calendar.png) · [holidays](docs/screenshots/52-holidays.png) · [payroll](docs/screenshots/53-payroll.png) · [certifications](docs/screenshots/54-certifications.png)

Admin: [users](docs/screenshots/55-users.png) · [doctors](docs/screenshots/56-doctors.png) · [schedule](docs/screenshots/57-schedule.png) · [reports](docs/screenshots/58-reports.png) · [scheduled reports](docs/screenshots/60-scheduled-reports.png) · [audit log](docs/screenshots/61-audit.png)

Engagement: [notifications](docs/screenshots/62-notifications.png) · [broadcasts](docs/screenshots/63-broadcasts.png) · [feedback](docs/screenshots/64-feedback.png) · [complaints](docs/screenshots/65-complaints.png) · [chat](docs/screenshots/66-chat.png) · [visitors](docs/screenshots/67-visitors.png)

</details>

---

## Quick Start

```bash
# Clone
git clone https://github.com/Globussoft-Technologies/medcore.git
cd medcore

# Install dependencies
npm install

# Start Postgres via Docker
docker run -d --name medcore-postgres \
  -e POSTGRES_USER=medcore -e POSTGRES_PASSWORD=medcore_dev \
  -e POSTGRES_DB=medcore -p 5433:5432 postgres:16-alpine

# Configure environment
echo 'DATABASE_URL="postgresql://medcore:medcore_dev@localhost:5433/medcore?schema=public"' > .env
cp apps/api/.env.example apps/api/.env
# Add your Sarvam AI key (required for all AI features)
echo 'SARVAM_API_KEY=your_key_here' >> apps/api/.env

# Apply migrations (do not use db push)
npx prisma generate --schema packages/db/prisma/schema.prisma
npx prisma migrate deploy --schema packages/db/prisma/schema.prisma

# Seed realistic data
npx tsx packages/db/src/seed-realistic.ts

# Start dev servers
npm run dev
#   Web: http://localhost:3000
#   API: http://localhost:4000
```

Mobile app:

```bash
cd apps/mobile && npx expo start
```

---

## Demo Accounts

| Role | Email | Password |
|---|---|---|
| Admin | `admin@medcore.local` | `admin123` |
| Doctor | `dr.sharma@medcore.local` | `doctor123` |
| Nurse | `nurse@medcore.local` | `nurse123` |
| Reception | `reception@medcore.local` | `reception123` |
| Pharmacist | `pharmacist@medcore.local` | `pharmacist123` |
| Lab Tech | `labtech@medcore.local` | `labtech123` |
| Patient | `patient1@medcore.local` | `patient123` |

Try them on the [live demo](https://medcore.globusdemos.com).

---

## Deployment

Production runs on a single Ubuntu 22.04 host behind nginx with Let's Encrypt:

```
nginx (443)
  ├─ medcore.globusdemos.com    → Next.js (:3200)
  └─ /api                        → Express API (:4100)
                                    └─ Docker PostgreSQL (:5433)

PM2: medcore-api, medcore-web (systemd auto-restart)
Cron: daily pg_dump @ 02:00 + health check every 5 min
```

### `scripts/deploy.sh`

The deploy script ships code, runs `prisma migrate deploy`, restarts PM2, and runs a post-deploy health check. Seeding production is **gated behind an explicit opt-in**:

```bash
# Dangerous — only for a fresh environment. Wipes the database.
ALLOW_PROD_SEED_RESET=YES_I_WILL_WIPE_THE_HOSPITAL ./scripts/deploy.sh --seed
```

Without the exact magic string the script refuses to seed.

### Backups

Daily gzipped `pg_dump` with 30-day retention. Restore rehearsal has been verified — 8 sampled tables match the source dump byte-for-byte.

---

## Accessibility

- Axe-core CI gate with per-page color-contrast budgets.
- 12 passing a11y specs across key dashboard pages.
- Hard-fails on `button-name`, `select-name`, `label`, and `image-alt` rules.
- 20+ `aria-label`s added to icon-only controls.

---

## Internationalization

- English and Hindi across 374 translation keys.
- 10 dashboard pages wired to `useTranslation`.
- `<html lang>` switches reactively with the active locale.
- A dev-only `I18N.md` documents the "add both languages in the same PR" rule.

---

## Known Follow-ups

This is an honest list. Nothing below is hidden in a marketing footnote.

- HIPAA / ABDM compliance has **not** been third-party audited. The codebase implements relevant controls (audit log, signed URLs, encryption at rest via Postgres, consent artefacts, FHIR-native error envelopes) but the certifications are not in place.
- ~~ABHA/ABDM health ID linking is roadmap (GAP-T13).~~ **Shipped** — verify / link / delink / consent / CareContext endpoints at `/api/v1/abdm`.
- ~~HL7 / FHIR export is planned, not built.~~ **FHIR R4 shipped** at `/api/v1/fhir` (Patient, Encounter, `$everything`). HL7 v2 legacy export (for older lab analyzers and LIS gateways) is still not built.
- Multi-tenant / multi-branch is roadmap. Scaffolding (`middleware/tenant.ts`, `tenantAsyncStorage`) is in place; the full migration plan lives in `.prisma-models-tenant.md` and has **not** been applied — no `Tenant` table yet.
- The mobile doctor-lite app is intentionally a subset of the web workspace.
- ~~Jitsi tele-consult deep integration (screen share, waiting room) is deferred (GAP-S14).~~ **Waiting room shipped** (`PATIENT_WAITING` → `ADMITTED` / `DENIED`). Screen share and in-call recording remain deferred.
- ~~Insurance billing claims API integration is deferred (§7-8).~~ **Scaffold shipped** at `/api/v1/claims` (pre-auth lifecycle, document attachments, status-event timeline). Direct payer-specific connectors (Star, HDFC Ergo, etc.) are still partner-gated.
- **AI ambient chart search** is live at `/api/v1/ai/chart-search` but currently ranks purely on Postgres FTS `ts_rank`. A cross-encoder / LLM rerank layer on top of the top-K FTS hits would materially improve precision for long patient histories — not yet built.

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full guide, including the **Prisma migration policy** — all schema changes must ship as a `prisma migrate dev` migration file. `prisma db push` is not permitted against any shared environment.

Quick path:

```bash
git checkout -b feat/your-feature
npx tsc --noEmit -p apps/api/tsconfig.json
npx tsc --noEmit -p apps/web/tsconfig.json
npm --prefix apps/api run test:unit
git commit -m "feat: add awesome thing"
git push origin feat/your-feature
```

Standards:

- TypeScript strict mode, Zod at every API boundary.
- Audit logging on every mutation.
- Tailwind utilities; avoid new CSS files.
- No new runtime npm dependencies without discussion.
- Both English and Hindi keys added for any user-facing string.

---

## Commercial Licensing

MedCore is proprietary software owned by Globussoft Technologies. The repository is published for transparency and evaluation. For:

- Deploying MedCore at a hospital
- White-labeling or OEM arrangements
- Custom integrations (ABDM, HL7/FHIR, specific lab analyzers, insurance APIs)
- Training and SLA-backed support
- Reseller / implementation partnerships

open an issue or contact [Globussoft Technologies](https://github.com/Globussoft-Technologies).

---

## License

Proprietary. See [LICENSE](LICENSE). Commercial licensing inquiries welcome.

---

<div align="center">

**[Live Demo](https://medcore.globusdemos.com)** · **[GitHub](https://github.com/Globussoft-Technologies/medcore)** · **[Contact](https://github.com/Globussoft-Technologies)**

Built in India for Indian hospitals.

</div>
