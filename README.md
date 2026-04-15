<div align="center">

# MedCore

### Hospital Information System for Indian Healthcare

A full-stack, monorepo HIS covering the patient journey from appointment to discharge — clinical, operational, financial, HR, and engagement workflows in one typed codebase.

[![Live Demo](https://img.shields.io/badge/live_demo-medcore.globusdemos.com-2563eb?style=for-the-badge)](https://medcore.globusdemos.com)
[![Tests](https://img.shields.io/badge/tests-1343_passing-16a34a?style=for-the-badge)](#testing)
[![E2E](https://img.shields.io/badge/playwright_e2e-29_passing-0ea5e9?style=for-the-badge)](#testing)
[![a11y](https://img.shields.io/badge/axe--core-12_passing-7c3aed?style=for-the-badge)](#accessibility)
[![Routers](https://img.shields.io/badge/api_routers-45-f59e0b?style=for-the-badge)](#architecture)
[![Models](https://img.shields.io/badge/prisma_models-110-0891b2?style=for-the-badge)](#architecture)
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
| **Tests passing** | 1,343 across 6 layers (unit, contract, smoke, web, integration, permissions) |
| **E2E** | 29 Playwright specs against the live demo URL |
| **Accessibility** | 12 axe-core tests, WCAG 2.1 AA, per-page contrast budgets |
| **API routers with integration coverage** | 45 |
| **Prisma models** | ~110 |
| **Prisma migrations (production)** | 4, all applied via `migrate deploy` |
| **CI workflows** | 4 (typecheck, API, web, Playwright E2E) |
| **Demo URL** | https://medcore.globusdemos.com |

---

## Feature Catalog

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
| **Database** | PostgreSQL 16, Prisma 6 (migrations, ~110 models) |
| **Web** | Next.js 15 (App Router), React 19, Tailwind CSS v4, Zustand, `socket.io-client` |
| **Mobile** | React Native, Expo SDK 53, `expo-router`, `expo-notifications`, `expo-constants` |
| **Auth** | JWT with refresh rotation, bcrypt, TOTP 2FA (pure Node `crypto`) |
| **Payments** | Razorpay SDK, raw-body HMAC-SHA256 webhook verification |
| **PDF / QR** | `pdfkit`, `qrcode`, `jsqr` (verification) |
| **Testing** | Jest, Supertest, Playwright, `axe-core` |
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
└── docs/             PRD, architecture notes, 68 Playwright screenshots
```

### Key decisions

- **End-to-end type safety.** The same Zod schemas validate API requests and generate TypeScript types consumed by the web and mobile apps.
- **Prisma-first data modeling.** Production uses `prisma migrate deploy` — no more `db push`. Four migrations applied to prod: initial, auth persistence tables, PHARMACIST/LAB_TECH roles, razorpay + push-token drift.
- **Socket.IO for realtime.** Live OPD queue, ER board, chat, admissions.
- **Fail-closed payments.** Razorpay signature mismatch returns 400 in production; webhooks use raw-body verification and idempotency on `Payment.transactionId`.
- **Row-level file ACLs** with HMAC-signed URLs and magic-byte sniffing.

---

## Testing

MedCore layers its tests so each tier tests a different boundary:

| Layer | Count | What it covers |
|---|---:|---|
| **Unit** | 309 | Helpers, validators, utilities, notification channel adapters |
| **Contract** | 121 | Zod request/response schemas between API and web |
| **Smoke** | 30 | Fast sanity pass across critical routes |
| **Web** | 151 | React component and page-level tests |
| **Integration** | 732 | Full HTTP through Express + Prisma against a real Postgres. Includes concurrency, realtime delivery, permissions matrix (178 assertions), auth edges, 2FA, notification channel shapes, Razorpay webhook |
| **Total** | **1,343** | |

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

- HIPAA / ABDM compliance has **not** been third-party audited. The codebase implements relevant controls (audit log, signed URLs, encryption at rest via Postgres) but the certifications are not in place.
- HL7 / FHIR export is planned, not built.
- Multi-tenant / multi-branch is roadmap.
- The mobile doctor-lite app is intentionally a subset of the web workspace.

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
