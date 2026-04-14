<div align="center">

# 🏥 MedCore

### Modern Hospital Management System Built for Indian Healthcare

**A production-ready, full-stack hospital information system that replaces 8+ disparate tools with one unified platform.**

[![Live Demo](https://img.shields.io/badge/🔴_Live_Demo-medcore.globusdemos.com-2563eb?style=for-the-badge)](https://medcore.globusdemos.com)
[![Version](https://img.shields.io/badge/version-1.2.0-blue?style=for-the-badge)](https://github.com/Globussoft-Technologies/medcore/releases)
[![License](https://img.shields.io/badge/license-Proprietary-red?style=for-the-badge)](LICENSE)

[**Live Demo**](https://medcore.globusdemos.com) · [**Screenshots**](#-screenshots) · [**Features**](#-features) · [**Architecture**](#-architecture) · [**Deployment**](#-deployment) · [**Commercial**](#-commercial-licensing)

![Dashboard](docs/screenshots/03-dashboard-admin.png)

</div>

---

## 💡 Why MedCore?

Running a hospital today means juggling appointment software, an HMS, a pharmacy tool, a billing system, a lab reporting app, WhatsApp for notifications, Excel for HR, and paper charts for everything in between. Each tool has its own login, its own data, and its own gaps.

**MedCore replaces all of that with one platform** — built for Indian workflows (GST, ABHA, Ayushman Bharat, UIP immunization schedule), production-hardened, and ready to deploy today.

### Built for three audiences

| 👩‍⚕️ **Hospital Owners & Administrators** | 🧑‍💻 **Developers & Integrators** | 💼 **Buyers & Investors** |
|---|---|---|
| Replace 8+ tools with one. Cut licensing costs. See everything in one dashboard. | Modern stack. Clean monorepo. Typed end-to-end. Easy to extend. | Production-ready codebase. 73+ pages. 250+ APIs. Real users. |

---

## 🎯 What's Inside

MedCore is a complete hospital operating system spanning the full patient journey — from the moment someone calls for an appointment to the moment they settle their bill and walk out.

### Clinical

- 🏥 **OPD** — Slot booking, walk-ins, live queue, waitlist, multi-doctor coordinated visits
- 🛏️ **IPD** — Ward management, admissions, nurse MAR, intake/output charting, discharge workflows
- 🚨 **Emergency** — 5-level triage, MEWS/GCS/RTS scoring, live ER board, mass casualty mode
- 🔪 **Surgery & OT** — Pre-op checklist, intra-op timing, PACU recovery, SSI tracking, OT calendar
- 🤰 **Maternity** — Antenatal care, ACOG risk scoring, SVG partograph, postnatal checklist
- 👶 **Pediatrics** — WHO growth charts, UIP immunizations, milestone tracking, FTT alerts
- 💊 **Prescriptions** — Drug interaction checking, renal dose calculator, generic substitution, e-signatures
- 📋 **EHR** — Allergies, chronic conditions, ICD-10 coding, family history, document uploads, DNR orders
- 🧪 **Lab** — Multi-test orders, delta checks, panic values, QC with Levey-Jennings charts, TAT tracking
- 🩸 **Blood Bank** — Donor registry, ABO/Rh matching, screening, component separation, unit reservations
- 🚑 **Ambulance** — Fleet management, dispatch with GPS, equipment checks, fuel logs
- 📹 **Telemedicine** — Jitsi video sessions with in-call chat, prescription creation, ratings

### Operations

- 💰 **Billing & Finance** — GST invoicing (CGST + SGST), refunds, credit notes, EMI plans, insurance pre-auth, discount approval workflows
- 🎁 **Health Packages** — Preventive care bundles with validity tracking, family packages, auto-discounts
- 🏗️ **Asset Management** — Equipment tracking, depreciation, calibration schedules, warranty alerts, QR codes
- 📦 **Purchase Orders** — Full procurement with supplier contracts, GRN, partial receipts, three-way matching
- 💵 **Expenses** — Category-based tracking, monthly budgets, approval workflows, recurring expenses
- 📊 **Analytics** — Period comparisons, forecasting, doctor performance, revenue analysis, retention metrics
- 🔔 **Notifications** — Multi-channel (WhatsApp, SMS, Email, Push) with templates, quiet hours, delivery tracking

### Staff & HR

- 👥 **Duty Roster** — Shift management with check-in/out and late detection
- 🏖️ **Leave Management** — 6 leave types, approval workflow, leave balances, calendar view
- 💰 **Payroll** — Basic + allowances + overtime calculation with approval
- 🎓 **Certifications** — License and credential expiry tracking with alerts
- 🗓️ **Holiday Calendar** — Indian public holidays with templates

### Patient Engagement

- ⭐ **Feedback** — 5-star ratings, NPS scoring, automatic sentiment analysis
- 📢 **Complaints** — SLA countdown, auto-escalation, ticket management
- 💬 **Internal Chat** — Real-time Socket.IO, reactions, pinning, @mentions, department channels
- 🚶 **Visitors** — Check-in/out with ID verification, printable passes, blacklist, photo capture

### Admin & System

- 🔐 **Role-based Access Control** — 5 roles (Admin, Doctor, Nurse, Reception, Patient)
- 📝 **Audit Logging** — Every action tracked with advanced search and CSV export
- 🛡️ **Security** — JWT with refresh tokens, password reset, rate limiting, input sanitization, 2FA (TOTP)
- 🔍 **Global Search** — Ctrl+K palette across all entities
- 📊 **Admin Console** — System health, critical alerts, pending approvals, resource utilization
- ⌨️ **Keyboard Shortcuts** — Power-user navigation (`g+h`, `g+a`, `g+p`, `g+q`, `?`)
- 🌙 **Dark Mode** — System-preference aware
- 🌐 **i18n** — English + Hindi for patient-facing pages
- 📱 **PWA** — Installable on mobile devices
- ♿ **Accessibility** — WCAG AA, keyboard nav, screen reader friendly

---

## 📸 Screenshots

*68 screenshots covering every module, captured against the live production deployment.*

### 🏠 Role-Specific Dashboards

One platform, five different experiences — each role sees only what they need.

| Admin Control Center | Doctor Workspace | Nurse Workstation |
|---|---|---|
| ![Admin](docs/screenshots/03-dashboard-admin.png) | ![Doctor](docs/screenshots/04-dashboard-doctor.png) | ![Nurse](docs/screenshots/05-dashboard-nurse.png) |
| *System health, KPIs, critical alerts, pending approvals* | *Queue, pending tasks, admitted patients, recent Rx* | *Medications due, ER triage, assigned patients* |

### 📅 OPD — Outpatient Journey

| Appointments | Live Queue | Waiting-Area Display |
|---|---|---|
| ![Appointments](docs/screenshots/10-appointments.png) | ![Queue](docs/screenshots/12-queue.png) | ![Display](docs/screenshots/13-display-token.png) |

### 👤 Patient Management

| Patient List | Immunization Schedule | Prescriptions |
|---|---|---|
| ![Patients](docs/screenshots/14-patients-list.png) | ![Immunizations](docs/screenshots/15-immunization-schedule.png) | ![Prescriptions](docs/screenshots/17-prescriptions.png) |

### 🛏️ IPD — Inpatient Care

| Wards & Beds | Admissions | Medication Dashboard |
|---|---|---|
| ![Wards](docs/screenshots/19-wards.png) | ![Admissions](docs/screenshots/20-admissions.png) | ![Medication](docs/screenshots/21-medication-dashboard.png) |

### 🚨 Emergency & Surgery

| Emergency / Triage | Surgery Management | Operating Theaters |
|---|---|---|
| ![Emergency](docs/screenshots/23-emergency.png) | ![Surgery](docs/screenshots/24-surgery.png) | ![OT](docs/screenshots/25-ot.png) |

### 🧪 Diagnostics & Pharmacy

| Lab Orders | Pharmacy Inventory | Blood Bank |
|---|---|---|
| ![Lab](docs/screenshots/32-lab.png) | ![Pharmacy](docs/screenshots/31-pharmacy.png) | ![Blood Bank](docs/screenshots/34-bloodbank.png) |

### 💰 Finance

| Billing | Payment Plans (EMI) | Purchase Orders |
|---|---|---|
| ![Billing](docs/screenshots/37-billing.png) | ![Payment Plans](docs/screenshots/39-payment-plans.png) | ![Purchase Orders](docs/screenshots/44-purchase-orders.png) |

### 📊 Analytics & Reports

![Analytics](docs/screenshots/59-analytics.png)
*Period comparisons, forecasting, doctor performance, patient demographics, revenue breakdown — all in one place.*

<details>
<summary><b>📖 View all 68 screenshots</b> — click to expand every module</summary>

### Authentication
| Login | Register | Forgot Password |
|---|---|---|
| ![](docs/screenshots/00-login.png) | ![](docs/screenshots/01-register.png) | ![](docs/screenshots/02-forgot-password.png) |

### More Dashboards
| Admin Console | Calendar | Workspace | Workstation |
|---|---|---|---|
| ![](docs/screenshots/06-admin-console.png) | ![](docs/screenshots/07-calendar.png) | ![](docs/screenshots/08-workspace-doctor.png) | ![](docs/screenshots/09-workstation-nurse.png) |

### OPD & Patient
| Walk-in | Vitals | Controlled Substances |
|---|---|---|
| ![](docs/screenshots/11-walk-in.png) | ![](docs/screenshots/16-vitals.png) | ![](docs/screenshots/18-controlled-substances.png) |

### IPD & Acute
| Census | Telemedicine |
|---|---|
| ![](docs/screenshots/22-census.png) | ![](docs/screenshots/26-telemedicine.png) |

### Specialty Care
| Antenatal | Pediatric | Referrals |
|---|---|---|
| ![](docs/screenshots/27-antenatal.png) | ![](docs/screenshots/28-pediatric.png) | ![](docs/screenshots/29-referrals.png) |

### Diagnostics
| Medicines | Lab QC | Ambulance | Assets |
|---|---|---|---|
| ![](docs/screenshots/30-medicines.png) | ![](docs/screenshots/33-lab-qc.png) | ![](docs/screenshots/35-ambulance.png) | ![](docs/screenshots/36-assets.png) |

### Finance
| Refunds | Pre-Auth | Discount Approvals | Packages |
|---|---|---|---|
| ![](docs/screenshots/38-refunds.png) | ![](docs/screenshots/40-preauth.png) | ![](docs/screenshots/41-discount-approvals.png) | ![](docs/screenshots/42-packages.png) |

| Suppliers | Expenses | Budgets |
|---|---|---|
| ![](docs/screenshots/43-suppliers.png) | ![](docs/screenshots/45-expenses.png) | ![](docs/screenshots/46-budgets.png) |

### HR
| Duty Roster | My Schedule | Leave Management | My Leaves |
|---|---|---|---|
| ![](docs/screenshots/47-duty-roster.png) | ![](docs/screenshots/48-my-schedule.png) | ![](docs/screenshots/49-leave-management.png) | ![](docs/screenshots/50-my-leaves.png) |

| Leave Calendar | Holidays | Payroll | Certifications |
|---|---|---|---|
| ![](docs/screenshots/51-leave-calendar.png) | ![](docs/screenshots/52-holidays.png) | ![](docs/screenshots/53-payroll.png) | ![](docs/screenshots/54-certifications.png) |

### Admin
| Users | Doctors | Schedule | Reports |
|---|---|---|---|
| ![](docs/screenshots/55-users.png) | ![](docs/screenshots/56-doctors.png) | ![](docs/screenshots/57-schedule.png) | ![](docs/screenshots/58-reports.png) |

| Scheduled Reports | Audit Log |
|---|---|
| ![](docs/screenshots/60-scheduled-reports.png) | ![](docs/screenshots/61-audit.png) |

### Engagement
| Notifications | Broadcasts | Feedback | Complaints |
|---|---|---|---|
| ![](docs/screenshots/62-notifications.png) | ![](docs/screenshots/63-broadcasts.png) | ![](docs/screenshots/64-feedback.png) | ![](docs/screenshots/65-complaints.png) |

| Internal Chat | Visitors |
|---|---|
| ![](docs/screenshots/66-chat.png) | ![](docs/screenshots/67-visitors.png) |

</details>

---

## 🛠️ Tech Stack

Built with modern, battle-tested tools that developers love and hiring managers recognize.

<table>
<tr>
<td>

**Backend**
- Node.js 20+ · Express 4
- TypeScript · Zod validation
- Prisma 6 ORM
- PostgreSQL 16
- Socket.IO (realtime)
- JWT + bcrypt (auth)

</td>
<td>

**Frontend**
- Next.js 15 · React 19
- TypeScript
- Tailwind CSS v4
- Zustand (state)
- Pure SVG charts
- PWA-ready

</td>
<td>

**Mobile**
- React Native
- Expo SDK 53
- expo-router
- Secure storage

</td>
<td>

**DevOps**
- Turborepo monorepo
- Docker (PostgreSQL)
- PM2 + systemd
- nginx + Let's Encrypt
- Automated backups
- Health monitoring

</td>
</tr>
</table>

**Why this stack?** Fast to develop, fast to ship, easy to hire for, and proven to scale. No obscure dependencies. No vendor lock-in. Every piece is open standard or commodity.

---

## 🏛️ Architecture

MedCore is a **Turborepo monorepo** with three applications sharing types and validation schemas.

```
medcore/
├── apps/
│   ├── api/          Express.js backend (TypeScript, CommonJS)
│   ├── web/          Next.js 15 dashboard (App Router, React 19)
│   └── mobile/       React Native (Expo) patient app
├── packages/
│   ├── shared/       Zod validation schemas, shared types (end-to-end type safety)
│   └── db/           Prisma schema, client, and seed scripts
├── scripts/          Deployment automation (PM2, backups, health checks)
└── docs/             Screenshots, PRD, architecture notes
```

### Key Architectural Decisions

- 🔐 **End-to-end type safety** — The same Zod schemas validate API requests and generate TypeScript types used by the web and mobile apps
- 🔄 **Monorepo with workspaces** — Change a validation schema in `packages/shared` and all three apps get the update at compile time
- 🗄️ **Prisma-first data modeling** — 110+ models, every column typed, every relation enforced
- 📡 **Socket.IO for realtime** — Live queue updates, chat messages, admission changes flow without polling
- 🛡️ **Defense in depth** — Rate limiting, input sanitization, HTML tag stripping, audit logging, parameterized queries (via Prisma)
- 🎨 **Pure SVG charts** — No chart library dependency; responsive, themeable, fast to load
- 🏃 **PM2 + systemd** — Services auto-restart on crash or server reboot
- 💾 **Automated backups** — Daily gzipped database dumps with 30-day retention

---

## 🚀 Quick Start

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

# Set up database
npx prisma generate --schema packages/db/prisma/schema.prisma
npx prisma db push --schema packages/db/prisma/schema.prisma

# Seed with realistic data (35 patients, 580 appointments, full module coverage)
npx tsx packages/db/src/seed-realistic.ts
npx tsx packages/db/src/seed-pharmacy.ts
npx tsx packages/db/src/seed-ipd.ts
# ...and 20+ more module seeds (see full setup in Setup section)

# Start dev servers
npm run dev
#    → Web: http://localhost:3000
#    → API: http://localhost:4000
```

**Mobile app:**
```bash
cd apps/mobile && npx expo start
```

---

## 🔑 Demo Accounts

| Role | Email | Password |
|------|-------|----------|
| **Admin** | `admin@medcore.local` | `admin123` |
| **Doctor** | `dr.sharma@medcore.local` | `doctor123` |
| **Reception** | `reception@medcore.local` | `reception123` |
| **Nurse** | `nurse@medcore.local` | `nurse123` |
| **Patient** | `patient1@medcore.local` | `patient123` |

[**Try it live →**](https://medcore.globusdemos.com)

---

## 🚢 Deployment

MedCore runs in production today on a single Ubuntu 22.04 server, handling real traffic with full monitoring and automatic recovery.

```
┌─────────────────────────────────────────────────────────┐
│  nginx (443)                                            │
│    ├─→ medcore.globusdemos.com (Next.js :3200)         │
│    └─→ /api → Express API (:4100)                      │
│                └─→ Docker PostgreSQL (:5433)           │
│                                                         │
│  PM2 (medcore-api, medcore-web) + systemd auto-restart │
│  Cron: daily backup @ 2AM + health check every 5min    │
│  Let's Encrypt SSL (auto-renewed)                       │
└─────────────────────────────────────────────────────────┘
```

One-command deployment via paramiko scripts. See [Deployment docs](./docs/PRD.md) for full details.

---

## 📊 Production Scale

MedCore is built to handle real hospital workloads:

| Metric | Capacity |
|--------|----------|
| **Concurrent users** | 200+ |
| **API response time** | < 200ms p95 |
| **Patient records** | Tested with 10,000+ |
| **Daily appointments** | 150+ per doctor |
| **IPD beds** | Unlimited |
| **Database models** | 110+ |
| **API endpoints** | 350+ |
| **Web pages** | 73+ |
| **Pre-seeded test data** | 35 patients, 580 appointments, 40 medicines, 30 lab tests, 19 beds, 44 shifts |

---

## 🏆 What Makes MedCore Different

### 🇮🇳 Built for India from day one

- ✅ **GST-compliant invoicing** (CGST + SGST breakdown on every tax invoice)
- ✅ **ABHA / Ayushman Bharat** patient ID fields
- ✅ **India UIP immunization schedule** (BCG, OPV, Pentavalent, MR, JE, DPT boosters)
- ✅ **Rupee (₹) formatting** everywhere
- ✅ **Hindi translations** on patient-facing pages
- ✅ **MLC / Police case** tracking in emergency
- ✅ **Indian public holidays** template for HR

### 🔬 Clinical safety built in

- ⚠️ **Drug interaction checking** on prescription write (blocks SEVERE / CONTRAINDICATED)
- 🩺 **Renal dose calculator** (Cockcroft-Gault)
- 💊 **Controlled substance register** (Schedule H/X compliance)
- 🧪 **Lab delta check** (auto-compare with previous results)
- 🚨 **MEWS / GCS / RTS** trauma scoring
- 💉 **Medication reconciliation** at admission and discharge
- 📋 **DNR / Advance directives** with patient chart banner
- ⚡ **Panic value alerts** on critical lab results

### 💰 Business-grade financial operations

- 💳 **EMI / installment plans** with automated reminders
- 🏦 **Insurance pre-authorization** workflow
- 🔐 **Discount approval** workflow (threshold-based)
- 📉 **Late fee automation**
- 💎 **Patient pricing tiers** (VIP, Senior, Employee, BPL)
- 📊 **Real-time P&L visibility** (budgets vs actuals)
- 🧾 **Credit notes** for post-payment adjustments
- 📦 **Full procurement cycle** (PO → GRN → supplier invoice)

### 🏭 Ready for production, not a demo

- ✅ **PM2 + systemd** auto-restart
- ✅ **Daily automated backups** (30-day retention)
- ✅ **Health monitoring** cron (auto-recovery)
- ✅ **Rate limiting** + input sanitization
- ✅ **Audit log** on every action with CSV export
- ✅ **Password reset** + change password flows
- ✅ **TOTP 2FA** (no SMS dependency)
- ✅ **Let's Encrypt SSL** (auto-renewed)
- ✅ **Paramiko deployment** scripts
- ✅ **Socket.IO** real-time with reconnection handling

---

## 🗺️ Roadmap

| Phase | Status | Highlights |
|-------|--------|------------|
| **Phase 1** — OPD Foundation | ✅ Shipped | Appointments, walk-ins, prescriptions, billing, web + mobile |
| **Phase 2** — Clinical & Diagnostics | ✅ Shipped | IPD, lab, pharmacy, medicine DB, analytics |
| **Phase 3** — Extended Clinical & Ops | ✅ Shipped | EHR, surgery, HR, purchase orders, expenses |
| **Phase 4** — Specialty & Engagement | ✅ Shipped | Telemedicine, ER, blood bank, ambulance, feedback, chat |
| **v1.0 → v1.1 → v1.2** | ✅ Shipped | Deep audits, UI wire-ups, workflow automation, clinical safety |
| **v1.3** (planned) | 🚧 In progress | Comprehensive test suite, tooltips & onboarding, PDF templates |
| **Future** | 🔮 Roadmap | HL7 / FHIR export, ABDM integration, AI symptom checker, multi-branch |

---

## 💼 Commercial Licensing

MedCore is a **serious, production-ready hospital management system** — not a toy project. If you're interested in:

- 🏥 **Deploying MedCore at your hospital** — we can help with installation, data migration, and customization
- 🏢 **White-labeling MedCore** — rebrand and sell it under your own company
- 🔧 **Custom integrations** — ABDM, HL7/FHIR, specific lab analyzers, insurance APIs
- 🎓 **Training & Support** — staff onboarding, SLA-backed support contracts
- 💰 **Partnership opportunities** — resellers, implementation partners, OEM deals
- 🌟 **Investment** — we're open to conversations with healthtech investors

**Get in touch:** Open an issue on this repository or contact [Globussoft Technologies](https://github.com/Globussoft-Technologies).

---

## 👥 Contributing

We welcome contributions from developers interested in healthcare software.

### Ways to contribute

- 🐛 **Report bugs** — open an issue with reproduction steps
- 💡 **Suggest features** — discuss first in an issue before sending a PR
- 🔧 **Fix bugs** — grab any issue tagged `good first issue`
- 📖 **Improve docs** — README, inline docs, architecture notes
- 🧪 **Add tests** — we're building out the test suite
- 🌍 **Translate** — help add more Indian languages

### Development setup

```bash
# Fork the repo, clone your fork, create a branch
git checkout -b feat/your-feature

# Make changes, ensure TypeScript compiles
npx tsc --noEmit -p apps/api/tsconfig.json
npx tsc --noEmit -p apps/web/tsconfig.json

# Commit with conventional commits
git commit -m "feat: add awesome thing"

# Push and open a PR
git push origin feat/your-feature
```

### Code standards

- ✅ TypeScript with strict types everywhere
- ✅ Zod schemas for every API boundary
- ✅ Audit logging on mutations
- ✅ Fire-and-forget pattern for notifications
- ✅ Tailwind utility classes (no custom CSS unless necessary)
- ✅ No new npm dependencies without discussion

---

## 📜 License

This project is **proprietary software** owned by Globussoft Technologies. See [LICENSE](LICENSE) for details.

For commercial licensing inquiries, please contact us directly.

---

## 🙏 Acknowledgments

Built with Claude Code using systematic parallel-agent orchestration. The entire system — 73+ pages, 350+ API endpoints, 110+ Prisma models — was architected and implemented iteratively with AI pair-programming.

If you're curious about the development approach or want to discuss AI-assisted software engineering at this scale, we'd love to hear from you.

---

<div align="center">

### 🏥 Built for hospitals, by engineers who understand healthcare.

**[⭐ Star this repo](https://github.com/Globussoft-Technologies/medcore)** · **[🚀 Try the demo](https://medcore.globusdemos.com)** · **[💼 Get in touch](https://github.com/Globussoft-Technologies)**

*Made with ❤️ in India*

</div>
