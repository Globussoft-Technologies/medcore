# MedCore — Hospital Operations Automation System

> A full-stack hospital management system covering OPD, IPD, emergency care, diagnostics, pharmacy, finance, HR, and patient engagement — built end-to-end with a modern stack.

**Live demo:** https://medcore.globusdemos.com
**Repository:** https://github.com/Globussoft-Technologies/medcore

---

## Highlights

- **45+ web pages** across 4 major phases of development
- **100+ API endpoints** with role-based access control
- **50+ Prisma models** covering every hospital workflow
- **Real-time WebSocket** for queue & chat updates
- **Mobile app** (React Native + Expo) for patients
- **Production-ready**: PM2 auto-restart, daily DB backups, health monitoring
- **Full audit trail** + rate limiting + input sanitization

---

## Table of Contents

1. [Feature Overview](#feature-overview)
2. [Tech Stack](#tech-stack)
3. [Project Structure](#project-structure)
4. [Roles & Permissions](#roles--permissions)
5. [Module Reference](#module-reference)
6. [Local Setup](#local-setup)
7. [Deployment](#deployment)
8. [Operations](#operations)
9. [Demo Accounts](#demo-accounts)
10. [Development History](#development-history)

---

## Feature Overview

### OPD / Outpatient (Phase 1)

- **Appointment booking** — slot-based scheduling with live availability
- **Walk-in registration** — quick intake with token assignment and priority flags
- **Queue management** — real-time live queue with WebSocket updates, waiting-area token display
- **Reschedule / Cancel** — with patient confirmation dialogs and audit trail
- **Recurring appointments** — daily / weekly / monthly up to 52 occurrences
- **Calendar view** — 7-day grid with status-colored appointment blocks
- **OPD vitals** — BP, temp, pulse, SpO2, weight, height, pain scale
- **Consultation workflow** — check-in → vitals → consultation → prescription → billing
- **Digital prescriptions** — with medicine items, advice, follow-up, e-sign
- **PDF generation** — printable prescriptions with hospital letterhead
- **Prescription templates** — reusable templates for common diagnoses
- **Refill tracking** — per-item refill count with refill endpoints

### Patient Management

- **Registration** — full demographics including Aadhaar, ABHA ID, marital status, occupation, religion, language, photo
- **MR Number** — auto-generated (MR######)
- **Search** — fuzzy matching across name, phone, MR number
- **Patient merge** — combine duplicate records
- **Unified timeline** — chronological feed of all appointments, consultations, prescriptions, vitals, admissions, labs, surgeries, invoices, emergency visits
- **Visit history** — expandable per-visit details
- **Quick actions** — Book appointment, Record vitals, Start consultation, Write prescription, Create invoice, Admit

### Electronic Health Records (EHR)

- **Allergies** — with severity (MILD / MODERATE / SEVERE / LIFE_THREATENING), reaction, notes
- **Alert banner** — severe allergies highlighted prominently on patient chart
- **Chronic conditions** — with ICD-10 codes, diagnosis date, status tracking
- **Family history** — relations, conditions, notes
- **Immunizations** — vaccine records with dose tracking and next-due dates
- **Immunization schedule** — overdue / due-soon dashboard
- **Document upload** — base64 files with types (LAB_REPORT, IMAGING, CONSENT, etc.)
- **Vitals trends** — SVG line charts for BP, temperature, pulse, SpO2, weight over time with abnormal-range bands

### IPD / Inpatient (Phase 2)

- **Wards & Beds** — ward types (GENERAL, PRIVATE, ICU, NICU, HDU, etc.), bed status tracking
- **Admissions** — admit / transfer / discharge workflow with transaction safety
- **IPD Vitals** — continuous monitoring records
- **Medication Orders** — with auto-generated administration schedule
- **Medication Administration Record (MAR)** — nurse dashboard of due meds with administer / miss / refuse actions
- **Nurse rounds** — rounding notes per admission
- **Discharge summary** — structured template with final diagnosis, treatment, medications, follow-up
- **Daily IPD bill** — auto-accumulating bed charges

### Emergency / Triage

- **Emergency case intake** — registered or unknown patients (John/Jane Doe)
- **5-level triage** (RESUSCITATION / EMERGENT / URGENT / LESS_URGENT / NON_URGENT) with color coding
- **MEWS & GCS scoring**
- **Live ER board** — column layout by status (Waiting / Triaged / In Treatment / Disposition Pending)
- **Wait-time tracking** — overdue highlighting against triage-level targets
- **Doctor assignment** — with seen-time tracking
- **Case closure** — with disposition (discharged / admitted / transferred / LWBS / deceased)
- **Mass casualty mode**

### Surgery / OT

- **Operating theater management** — multiple OTs with daily rates
- **Surgery scheduling** — with surgeon, OT, duration, anaesthetist, assistants
- **Pre-op checklist** — consent, NPO, allergies, antibiotics
- **Status workflow** — SCHEDULED → IN_PROGRESS → COMPLETED
- **OT calendar** — weekly view of scheduled surgeries
- **Post-op notes** — diagnosis, notes, complications
- **OT utilization analytics**

### Maternity / Antenatal

- **ANC case** — one active case per pregnancy
- **EDD auto-calculation** — LMP + 280 days
- **Trimester tracking**
- **Visit types** — FIRST_VISIT, ROUTINE, HIGH_RISK_FOLLOWUP, SCAN_REVIEW, DELIVERY, POSTNATAL
- **Per-visit data** — weeks gestation, weight, BP, fundal height, FHR, urine tests, hemoglobin
- **High-risk flagging** — risk factors and alerts
- **Delivery outcome** — delivery type, baby gender/weight, outcome notes
- **Visit timeline** — SVG visualization LMP → today → EDD

### Pediatric Growth

- **Growth records** — weight, height, head circumference, BMI
- **Percentiles** — WHO-style median lookup with linear interpolation
- **Growth charts** — SVG line charts with milestone markers at 2/4/6/9/12/18/24 months
- **Developmental notes** — per visit

### Diagnostics & Lab

- **Test catalog** — 30+ pre-seeded tests (CBC, LFT, KFT, Lipid Profile, etc.)
- **Lab orders** — multi-test orders with auto-generated order number
- **Sample tracking** — COLLECTED → IN_PROGRESS → COMPLETED
- **Result entry** — per-test parameter / value / unit / normal range / flag
- **Critical flagging** — NORMAL / LOW / HIGH / CRITICAL with color-coded display
- **Auto-completion** — order completes when all items have results
- **Turnaround time (TAT)** — ordered vs completed tracking
- **Result trends** — compare current with previous results for same test
- **Reference ranges by age/gender**

### Pharmacy

- **Medicine catalog** — 40+ pre-seeded medicines (generic names, brand, form, strength, category)
- **Drug interactions** — severity levels (MILD / MODERATE / SEVERE / CONTRAINDICATED)
- **Interaction check** — bulk-check endpoint for prescription safety
- **Inventory** — batch tracking with quantity, unit cost, selling price, expiry
- **Stock movements** — PURCHASE / DISPENSED / EXPIRED / RETURNED / DAMAGED / ADJUSTMENT
- **Low stock alerts**
- **Expiry tracking** — items expiring within 30/60/90 days
- **Dispense from prescription** — FEFO (First Expiry First Out) batch selection
- **Purchase orders** — DRAFT → PENDING → APPROVED → RECEIVED workflow
- **Supplier management** — contacts, GST numbers, payment terms

### Blood Bank

- **Donor registry** — with blood group, eligibility tracking
- **Donations** — unit numbers, approval workflow, screening notes
- **Blood units** — by component (WHOLE / PRBC / PLATELETS / FFP / CRYO)
- **Inventory** — by blood group + component with expiry
- **Blood requests** — with urgency (ROUTINE / URGENT / EMERGENCY)
- **ABO/Rh matching** — compatibility-aware unit allocation
- **Issue tracking** — transactional unit issuance

### Ambulance

- **Fleet management** — BLS / ALS / ICU / Patient Transport types
- **Trip lifecycle** — REQUESTED → DISPATCHED → ARRIVED_SCENE → EN_ROUTE_HOSPITAL → COMPLETED
- **Driver & paramedic tracking**
- **Distance & cost logging**
- **Trip history**

### Billing & Finance

- **Invoice generation** — line items with categories (Consultation, Procedure, Medicine, Lab, Other)
- **Tax calculation** — GST-aware
- **Discount application** — percentage or flat amount with reason
- **Payment recording** — CASH / CARD / UPI / ONLINE / INSURANCE
- **Partial payments**
- **Razorpay integration** — online payment order creation + verification
- **Refunds** — with reason tracking
- **Bulk payments** — across multiple invoices for patient reconciliation
- **Outstanding reports** — with days-overdue highlighting
- **Insurance claims** — SUBMITTED → APPROVED / REJECTED → SETTLED
- **Health packages** — Master Health Checkup, Diabetes Care, Cardiac Wellness, Pregnancy Care, Senior Citizen
- **Package purchases** — with validity tracking
- **Expenses** — 8 categories (Salary, Utilities, Equipment, etc.)
- **Purchase orders** — full procurement workflow

### Staff HR

- **Duty roster** — daily grid by shift type (Morning / Afternoon / Night / On-Call)
- **Shift management** — per-user scheduling
- **Check-in / Check-out** — with auto LATE detection (>15 min)
- **Leave requests** — 6 types (CASUAL, SICK, EARNED, MATERNITY, PATERNITY, UNPAID)
- **Approval workflow** — PENDING → APPROVED / REJECTED with reason
- **Leave balance** — per-type tracking
- **My Schedule** — 7-day forward view for staff
- **Bulk scheduling** — multi-staff multi-day assignment

### Patient Engagement

- **Notifications** — WhatsApp / SMS / Email / Push (stubs for real API integration)
- **Notification preferences** — per-channel toggles
- **Notification log** — full audit trail of all notifications sent
- **Feedback** — 5-star ratings per category (Doctor, Nurse, Food, Cleanliness, Overall)
- **NPS scoring** — 0-10 with promoter / detractor calculation
- **Public feedback link** — `/feedback/[patientId]` accessible via SMS/WhatsApp
- **Complaints** — ticket system with assignment, priority, resolution
- **Internal chat** — 1-on-1 and group rooms, real-time via Socket.IO
- **Visitor management** — check-in / check-out with ID proof, printable passes

### Telemedicine

- **Video sessions** — auto-generated Jitsi Meet URLs
- **Session workflow** — SCHEDULED → WAITING → IN_PROGRESS → COMPLETED
- **"Join Call" button** — active within 15 min of scheduled time
- **Session notes & ratings**
- **Integration with prescription creation**

### Referrals

- **Internal referrals** — doctor-to-doctor
- **External referrals** — to outside providers
- **Status workflow** — PENDING → ACCEPTED → COMPLETED / DECLINED
- **Inbox view** — for receiving doctor

### Asset Management

- **Asset registry** — medical equipment, IT, furniture, vehicles
- **Status tracking** — IN_USE / IDLE / UNDER_MAINTENANCE / RETIRED / LOST
- **Assignment history** — staff to asset linkage
- **Maintenance logs** — SCHEDULED / BREAKDOWN / CALIBRATION / INSPECTION
- **Warranty alerts** — expiring within 30 days
- **AMC tracking** — renewal alerts
- **Depreciation calculation**

### Analytics & Reports

- **Overview dashboard** — KPIs with period comparison (vs previous period / previous year)
- **Appointment trends** — daily / weekly / monthly time series
- **Revenue analytics** — by payment mode, by doctor, by category
- **Doctor performance** — sortable: appointments, completion rate, avg consultation time, revenue
- **Top diagnoses**
- **Patient demographics** — gender split, age groups (donut charts)
- **IPD occupancy** — per-ward bars
- **Pharmacy insights** — low stock, top dispensed
- **No-show analysis** — by doctor, day of week, hour
- **ER performance** — wait times, dispositions
- **Patient retention** — new vs returning, visit frequency distribution
- **Feedback trends** — NPS over time, rating by category
- **CSV exports** — revenue, appointments, patients
- **Report builder** — custom report creation with saved configurations
- **Audit log viewer** — admin-only full action trail with filters

### Admin & System

- **User management** — staff CRUD (Admin, Doctor, Reception, Nurse)
- **Role-based access control** — fine-grained per-endpoint
- **Audit logging** — all key actions with IP, user, entity
- **Rate limiting** — 100 req/min global, 10 req/min on auth endpoints
- **Input sanitization** — HTML tag stripping on all request bodies
- **Password reset** — forgot-password flow with 6-digit code
- **Change password** — for logged-in users
- **Session management** — JWT with refresh tokens

---

## Tech Stack

### Backend
- **Node.js 20+** + **Express.js 4** (TypeScript, CommonJS)
- **PostgreSQL 16** via **Prisma 6** ORM
- **JWT** + **bcryptjs** for auth
- **Socket.IO** for real-time queue & chat
- **Zod** for validation
- **Multer-less file upload** (base64)

### Web Frontend
- **Next.js 15** + **React 19** (App Router, TypeScript)
- **Tailwind CSS v4** with `@theme` CSS variables (no tailwind.config)
- **Zustand** for auth state
- **lucide-react** icons
- **socket.io-client**
- Pure SVG charts (no chart library dependency)

### Mobile
- **React Native** via **Expo SDK 53+**
- **expo-router** (file-based navigation)
- **expo-secure-store** for tokens

### DevOps
- **Turborepo** monorepo
- **npm workspaces**
- **PM2** process manager with systemd startup
- **Docker** for PostgreSQL
- **nginx** reverse proxy + **Certbot** SSL
- **Paramiko** (Python) for deployment

### Infrastructure
- **Ubuntu 22.04** server
- **Let's Encrypt** SSL
- **Cron jobs** — nightly backups (2 AM), 5-min health checks
- **Backup retention** — 30 days with gzip

---

## Project Structure

```
medcore/
├── apps/
│   ├── api/                    # Express.js backend
│   │   └── src/
│   │       ├── index.ts        # App entrypoint, router wiring
│   │       ├── middleware/
│   │       │   ├── auth.ts     # JWT authentication + RBAC
│   │       │   ├── audit.ts    # Action logging
│   │       │   ├── error.ts    # Error handler
│   │       │   ├── rate-limit.ts
│   │       │   ├── sanitize.ts
│   │       │   └── validate.ts # Zod schema validation
│   │       ├── routes/         # 40+ API route files
│   │       └── services/
│   │           ├── notification.ts    # Multi-channel notifications
│   │           ├── notification-triggers.ts
│   │           ├── pdf.ts             # Prescription PDF
│   │           └── razorpay.ts        # Online payments
│   ├── web/                    # Next.js frontend
│   │   └── src/
│   │       ├── app/
│   │       │   ├── dashboard/  # 45+ dashboard pages
│   │       │   ├── login/
│   │       │   ├── register/
│   │       │   ├── forgot-password/
│   │       │   ├── display/    # Waiting-area TV
│   │       │   └── feedback/   # Public patient feedback
│   │       └── lib/
│   │           ├── api.ts      # HTTP client
│   │           ├── store.ts    # Zustand auth store
│   │           └── socket.ts   # Socket.IO client
│   └── mobile/                 # React Native (Expo)
│       ├── app/
│       │   ├── (tabs)/         # Home, Appointments, Queue, Rx, Profile
│       │   ├── login.tsx
│       │   └── register.tsx
│       └── lib/
│           ├── api.ts
│           └── auth.tsx
├── packages/
│   ├── shared/                 # Shared types & Zod validation
│   │   └── src/
│   │       ├── types/          # Role, Appointment, Patient, etc.
│   │       └── validation/     # Zod schemas per domain
│   └── db/                     # Prisma schema + seeds
│       ├── prisma/
│       │   └── schema.prisma   # 50+ models
│       └── src/
│           ├── index.ts        # Prisma client export
│           └── seed-*.ts       # Seed scripts per module
├── scripts/
│   ├── pm2-setup.sh            # PM2 systemd startup
│   ├── backup-db.sh            # Daily PostgreSQL backup
│   ├── restore-db.sh           # Interactive restore
│   ├── deploy.sh               # One-command deployment
│   └── healthcheck.sh          # Cron health check
├── backups/                    # Gzipped SQL backups (gitignored)
├── docs/
│   └── PRD.md                  # Original product requirements
├── turbo.json
└── package.json
```

---

## Roles & Permissions

| Role | Access |
|------|--------|
| **ADMIN** | Full system access — users, schedules, reports, audit, analytics, all modules |
| **DOCTOR** | Consultations, prescriptions, queue, patient history, referrals, surgery, telemedicine, ANC |
| **NURSE** | Vitals, medication admin, IPD, emergency triage, blood bank, immunizations |
| **RECEPTION** | Appointments, walk-ins, billing, visitors, emergency intake, ambulance dispatch |
| **PATIENT** | Own appointments, prescriptions, bills, telemedicine, notifications |

---

## Module Reference

| # | Module | Routes | Web Page |
|---|--------|--------|----------|
| 1 | Auth | `/api/v1/auth/*` | `/login`, `/register`, `/forgot-password` |
| 2 | Appointments | `/api/v1/appointments/*` | `/dashboard/appointments` |
| 3 | Patients | `/api/v1/patients/*` | `/dashboard/patients`, `/patients/[id]` |
| 4 | Queue | `/api/v1/queue/*` | `/dashboard/queue`, `/display` |
| 5 | Walk-in | `/api/v1/appointments/walk-in` | `/dashboard/walk-in` |
| 6 | Doctors | `/api/v1/doctors/*` | `/dashboard/doctors` |
| 7 | Schedule | `/api/v1/doctors/:id/schedule` | `/dashboard/schedule` |
| 8 | Vitals | `/api/v1/patients/:id/vitals` | `/dashboard/vitals` |
| 9 | Prescriptions | `/api/v1/prescriptions/*` | `/dashboard/prescriptions` |
| 10 | Billing | `/api/v1/billing/*` | `/dashboard/billing`, `/billing/[id]`, `/billing/patient/[id]` |
| 11 | Refunds | `/api/v1/billing/refunds` | `/dashboard/refunds` |
| 12 | Notifications | `/api/v1/notifications/*` | `/dashboard/notifications` |
| 13 | Users | `/api/v1/users/*` | `/dashboard/users` |
| 14 | Reports | `/api/v1/billing/reports/*` | `/dashboard/reports` |
| 15 | Analytics | `/api/v1/analytics/*` | `/dashboard/analytics` |
| 16 | Audit | `/api/v1/audit/*` | `/dashboard/audit` |
| 17 | Wards | `/api/v1/wards/*`, `/beds/*` | `/dashboard/wards` |
| 18 | Admissions | `/api/v1/admissions/*` | `/dashboard/admissions`, `/admissions/[id]` |
| 19 | Medication | `/api/v1/medication/*` | `/dashboard/medication-dashboard` |
| 20 | Nurse Rounds | `/api/v1/nurse-rounds/*` | Integrated in admissions |
| 21 | Medicines | `/api/v1/medicines/*` | `/dashboard/medicines` |
| 22 | Pharmacy | `/api/v1/pharmacy/*` | `/dashboard/pharmacy` |
| 23 | Lab | `/api/v1/lab/*` | `/dashboard/lab`, `/lab/[id]` |
| 24 | EHR | `/api/v1/ehr/*` | Integrated in patient detail |
| 25 | Immunizations | `/api/v1/ehr/immunizations/*` | `/dashboard/immunization-schedule` |
| 26 | Referrals | `/api/v1/referrals/*` | `/dashboard/referrals` |
| 27 | Surgery | `/api/v1/surgery/*` | `/dashboard/surgery`, `/surgery/[id]` |
| 28 | OT | `/api/v1/surgery/ots/*` | `/dashboard/ot` |
| 29 | HR Shifts | `/api/v1/shifts/*` | `/dashboard/my-schedule`, `/duty-roster` |
| 30 | HR Leaves | `/api/v1/leaves/*` | `/dashboard/leave-management`, `/my-leaves` |
| 31 | Packages | `/api/v1/packages/*` | `/dashboard/packages` |
| 32 | Suppliers | `/api/v1/suppliers/*` | `/dashboard/suppliers` |
| 33 | Purchase Orders | `/api/v1/purchase-orders/*` | `/dashboard/purchase-orders`, `/[id]` |
| 34 | Expenses | `/api/v1/expenses/*` | `/dashboard/expenses` |
| 35 | Uploads | `/api/v1/uploads/*` | Via patient documents |
| 36 | Telemedicine | `/api/v1/telemedicine/*` | `/dashboard/telemedicine` |
| 37 | Emergency | `/api/v1/emergency/*` | `/dashboard/emergency`, `/emergency/[id]` |
| 38 | Blood Bank | `/api/v1/bloodbank/*` | `/dashboard/bloodbank` |
| 39 | Ambulance | `/api/v1/ambulance/*` | `/dashboard/ambulance` |
| 40 | Assets | `/api/v1/assets/*` | `/dashboard/assets` |
| 41 | Antenatal | `/api/v1/antenatal/*` | `/dashboard/antenatal`, `/antenatal/[id]` |
| 42 | Pediatric Growth | `/api/v1/growth/*` | `/dashboard/pediatric`, `/pediatric/[id]` |
| 43 | Feedback | `/api/v1/feedback/*` | `/dashboard/feedback`, `/feedback/[id]` (public) |
| 44 | Complaints | `/api/v1/complaints/*` | `/dashboard/complaints` |
| 45 | Chat | `/api/v1/chat/*` | `/dashboard/chat` |
| 46 | Visitors | `/api/v1/visitors/*` | `/dashboard/visitors` |

---

## Local Setup

### Prerequisites
- Node.js 20+
- npm 10+
- Docker (for PostgreSQL)
- Git

### Steps

```bash
# 1. Clone
git clone https://github.com/Globussoft-Technologies/medcore.git
cd medcore

# 2. Install dependencies
npm install

# 3. Start PostgreSQL via Docker
docker run -d --name medcore-postgres \
  -e POSTGRES_USER=medcore \
  -e POSTGRES_PASSWORD=medcore_dev \
  -e POSTGRES_DB=medcore \
  -p 5433:5432 \
  postgres:16-alpine

# 4. Set up environment
cp apps/api/.env.example apps/api/.env
# Edit apps/api/.env with your DATABASE_URL

# Also create root .env for Prisma
echo 'DATABASE_URL="postgresql://medcore:medcore_dev@localhost:5433/medcore?schema=public"' > .env

# 5. Push schema + seed
npx prisma generate --schema packages/db/prisma/schema.prisma
npx prisma db push --schema packages/db/prisma/schema.prisma

# Seed data
npx tsx packages/db/src/seed-realistic.ts       # Core OPD data
npx tsx packages/db/src/seed-pharmacy.ts         # Medicines, lab tests, inventory
npx tsx packages/db/src/seed-ipd.ts              # Wards, beds, admissions
npx tsx packages/db/src/seed-clinical.ts         # OTs, referrals, surgeries
npx tsx packages/db/src/seed-hr.ts               # Shifts, leaves
npx tsx packages/db/src/seed-finance.ts          # Packages, suppliers, POs, expenses
npx tsx packages/db/src/seed-phase4-ops.ts       # Blood bank, ambulances, assets
npx tsx packages/db/src/seed-phase4-specialty.ts # ANC cases, pediatric growth
npx tsx packages/db/src/seed-phase4-engagement.ts # Feedback, complaints, chat, visitors

# 6. Run dev servers
npm run dev
# Web: http://localhost:3000
# API: http://localhost:4000
```

### Mobile App

```bash
cd apps/mobile
npx expo start
# Scan QR with Expo Go app
```

---

## Deployment

Production runs on a single Ubuntu 22.04 server with:
- **nginx** reverse proxy at `medcore.globusdemos.com`
- **PM2** running `medcore-api` (port 4100) and `medcore-web` (port 3200)
- **Docker PostgreSQL** at port 5433
- **Let's Encrypt SSL** via Certbot
- **Cron jobs** for backups and health checks

### Deploy script (server-side)

```bash
cd ~/medcore
./scripts/deploy.sh            # Pull, install, migrate, build, restart
./scripts/deploy.sh --seed     # Plus re-seed DB
```

### Paramiko-based deploy (local)

```bash
python deploy_all.py           # Full deployment from local machine
```

*Note: `deploy_*.py` files are gitignored — they contain server credentials.*

---

## Operations

### Backups

- **Automatic** — daily at 2 AM via cron
- **Retention** — 30 days, gzipped
- **Location** — `/home/empcloud-development/medcore/backups/`

```bash
./scripts/backup-db.sh                                    # Manual backup
./scripts/restore-db.sh backups/medcore_YYYYMMDD.sql.gz   # Restore
```

### Health Monitoring

- Cron runs `healthcheck.sh` every 5 minutes
- Auto-restarts API / Web / Postgres if down
- Logs to `~/logs/medcore-health.log`

### PM2 Commands

```bash
pm2 list                            # Show all processes
pm2 logs medcore-api --lines 50     # Tail logs
pm2 restart medcore-api medcore-web # Restart services
pm2 save                            # Persist state
```

### Nightly Checklist

- [x] PostgreSQL container healthy (`docker ps`)
- [x] PM2 services online (`pm2 list`)
- [x] SSL certificate valid (`sudo certbot certificates`)
- [x] Latest backup exists (`ls -lht backups/ | head`)
- [x] Disk usage <80% (`df -h`)

---

## Demo Accounts

| Role | Email | Password |
|------|-------|----------|
| Admin | `admin@medcore.local` | `admin123` |
| Doctor | `dr.sharma@medcore.local` | `doctor123` |
| Doctor | `dr.patel@medcore.local` | `doctor123` |
| Doctor | `dr.khan@medcore.local` | `doctor123` |
| Reception | `reception@medcore.local` | `reception123` |
| Nurse | `nurse@medcore.local` | `nurse123` |
| Patient | `patient1@medcore.local` | `patient123` |

---

## Development History

Development proceeded in 4 phases:

### Phase 1 — OPD Foundation (Basic)
- Monorepo setup, auth, appointments, walk-ins, patient management
- OPD workflow, prescriptions, billing, notifications stubs
- Live queue with WebSocket
- Web app and mobile app

### Phase 2 — Clinical & Diagnostics (Advanced)
- IPD / inpatient management (wards, beds, admissions, medications)
- Nurse medication administration record (MAR)
- Lab ordering and results
- Pharmacy inventory and dispensing
- Medicine database with drug interactions
- Analytics dashboard

### Phase 3 — Extended Clinical & Ops
- Electronic Health Records (allergies, conditions, family history, immunizations)
- Document upload and management
- Doctor-to-doctor referrals
- Surgery and operating theater management
- Staff HR (shifts, leaves, duty roster)
- Purchase orders and supplier management
- Health packages
- Expense tracking

### Phase 4 — Specialty Care & Engagement
- Telemedicine with Jitsi Meet integration
- Emergency / triage dashboard
- Blood bank with donor management and ABO/Rh matching
- Ambulance fleet management
- Asset management with maintenance and warranty tracking
- Antenatal care (ANC) with visit tracking
- Pediatric growth charts
- Patient feedback + public feedback link
- Complaints management
- Internal chat with Socket.IO real-time
- Visitor management with pass printing

### Production Hardening
- Password reset flow
- Audit logging across all modules
- Rate limiting on auth and global
- Input sanitization
- PM2 systemd startup
- Automated daily backups
- Cron-based health checks

### Deepening Phase
- Dashboard rebuilt with all-module summary per role
- Appointments: calendar, reschedule, recurring, stats
- Patient detail: timeline, vitals trends, billing/lab tabs, quick actions
- Billing: refunds, bulk payments, discounts, outstanding reports
- Analytics: period comparison, drill-down, CSV exports, report builder

---

## License

This is a demonstration project. License file included in repository.

---

## Acknowledgments

Built end-to-end using Claude Code with systematic parallel agent orchestration for rapid feature delivery.
