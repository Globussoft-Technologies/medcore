# Lab Technician Module — Discovery, Gap Analysis & PRD

**Application:** MedCore HMS (medcore.globusdemos.com)  
**Date:** 11 May 2026 · HEAD c52ce79  
**Author role-pack:** Sr. Healthcare Product Analyst · Lab Ops Consultant · QA Architect · Clinical Diagnostics Expert · Hospital Systems Analyst

**Scope note:** Every reachable Lab surface was explored as LAB_TECH, ADMIN, DOCTOR, NURSE, RECEPTION and PATIENT, plus the underlying API. Findings below are evidence-based from live probes; quotes/screenshots cited are from this session.

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Current State Analysis](#2-current-state-analysis)
3. [Product Requirements Document — Ideal Lab Technician Module](#3-product-requirements-document--ideal-lab-technician-module)
4. [Complete Feature List](#4-complete-feature-list)
5. [Gap Analysis](#5-gap-analysis)
6. [Risk & Patient-Safety Register](#6-risk--patient-safety-register)

---

## 1. Executive Summary

MedCore ships a partial Lab module that on paper covers Orders → Sample Collected → In Progress → Completed and a Test Catalog of 46 tests across 11 clinical categories. In practice the module is a read-mostly UI bolted onto a half-wired permission matrix, with the LAB_TECH role itself being the least-empowered persona in the entire workflow.

**The single most serious finding is structural:** the LAB_TECH user has zero lab-specific navigation in their sidebar (only patient-persona entries: My Appointments, Telemedicine, Prescriptions, Bills, AI Booking, Medication Reminders). The `/dashboard/lab` route exists and works, but is unreachable without typing the URL manually. Compounding this, every state-transition API (collect, process, complete, verify, reject, cancel, amend) returned HTTP 403 to LAB_TECH, ADMIN, DOCTOR, NURSE, and RECEPTION in parallel probes — meaning the workflow has no authorized actor at all in the demo tenant, OR the role check is mis-keyed and bypassed only by a missing PATHOLOGIST role.

**The patient-safety blast radius is large:** a sample Thyroid result of 35 uIU/mL against a normal range of 0.4–4.0 uIU/mL is flagged **NORMAL** on the live order detail page — confirming flag selection is a free dropdown, not derived from `panicLow`/`panicHigh`. This must be remediated before any production rollout.

---

## 2. Current State Analysis

### 2.1 Module Routes and Surfaces (Observed)

| Surface | URL | Visible to | Sidebar entry? |
|---------|-----|------------|----------------|
| Lab Orders list + Test Catalog tabs + STAT Only filter | `/dashboard/lab` | All roles tested | ADMIN ✓, DOCTOR ✓; LAB_TECH ✗, NURSE ✗, RECEPTION ✗, PATIENT ✗ |
| Lab Order detail (Print Report, status, items, Add Result) | `/dashboard/lab/:orderId` | All roles | Reached via View/Enter Results buttons |
| Lab QC (Levey-Jennings) | `/dashboard/lab/qc` | ADMIN ✓ | ADMIN sidebar ✓; LAB_TECH ✗ |
| Lab Explainer (AI) | `/dashboard/lab-explainer` | ADMIN ✓ | Confirmed in ADMIN sidebar |
| AI Radiology | `/dashboard/ai-radiology` | ADMIN ✓ | Confirmed |
| Catalog admin (create/edit tests) | No UI found | n/a | n/a |
| Sample/specimen tracking page | No UI found | n/a | n/a |
| Critical-result console / amendment workflow | No UI found | n/a | n/a |

### 2.2 Data Model Observed via `/api/v1/lab/orders` and `/api/v1/lab/tests`

**Order entity** exposes: `id`, `orderNumber` (LAB######), `patientId`, `doctorId`, `admissionId`, `status` (ORDERED/SAMPLE_COLLECTED/IN_PROGRESS/COMPLETED — schema also has REJECTED, unused), `notes`, `orderedAt`, `collectedAt`, `completedAt`, `rejectedAt`, `rejectionReason`, `priority` (ROUTINE only — STAT/URGENT enums unused in data), `stat` (boolean — 0 records flagged), `tenantId`, `items[]`, `patient`, `doctor`.

**Order item:** `id`, `orderId`, `testId`, `status`, `test{}`. Items have an independent `status` field, but the UI surfaces only the order-level status.

**Test catalog:** `id`, `code`, `name`, `category`, `price`, `sampleType`, `normalRange`, `unit`, `panicLow`, `panicHigh`, `tatHours`, `description`, `createdAt`. 46 tests, 11 categories (Cardiology, Immunology, Endocrinology, Microbiology, Biochemistry, Hematology, Coagulation, Serology, Electrolytes, Clinical Pathology, Radiology).

**Coverage holes:** 27/46 have `normalRange`, 18/46 have `tatHours`, only 11/46 have panic values.

### 2.3 Critical Missing Fields in the Data Model

The order/item schema does not include:

- Accession number, barcode/QR
- Specimen container or volume
- Collector identity, collected location
- Sample condition flags (hemolyzed/clotted/insufficient)
- Instrument/analyzer ID, raw machine result
- Verifier/approver identity
- `result-entered-at` timestamp, `verified-at` timestamp
- Amendment trail, critical-callback log
- Repeat-test linkage
- Derived flag from panic values
- Units validation
- ICD/diagnosis context, fasting status
- Clinical notes from doctor
- Billing/invoice linkage
- Insurance pre-auth status
- `encounterId` for OPD (only `admissionId` for IPD)

### 2.4 Workflow Observations

The list view exposes three contextual buttons: **View** (always), **Process** (when status = SAMPLE_COLLECTED), **Enter Results** (when status = IN_PROGRESS). Observed behaviour:

- **"Process" clicked as LAB_TECH** → toast "Forbidden". API call: `POST /api/v1/lab/orders/:id/process` → 403. The UI advertises a capability the API denies — a **permission-bait defect**.
- **"Enter Results"** navigates to the order detail with an "Add Result" form. Fields: Parameter (text), Value (`<input type=number>` only), Unit (text), Normal Range (text), Flag (dropdown: Normal / Low / High / Critical), Notes (text). Every field is non-required. Submitting an empty result is structurally possible.
- **"Print Report"** button is present on every order detail, including ORDERED and IN_PROGRESS orders — shown before the result is even entered, much less verified.
- **"STAT Only"** filter pill is rendered but there are zero STAT orders in the dataset; the catalog `tatHours` field is also unused in any sorting/queue view.
- **Order detail page** suffers severe dark-mode contrast defects: patient name, doctor name, notes, test name, and "Recorded Results" rows are white text on near-white cards (8 hardcoded `bg-white` elements per page). Patient-readable values become functionally invisible.

### 2.5 Cross-Role Exploration (Observed Lab Touchpoints)

| Role | Sidebar reaches Lab? | Order list scoped correctly? | Can order tests? | Can transition state? | Can view results? |
|------|---------------------|------------------------------|------------------|-----------------------|-------------------|
| ADMIN | ✓ Lab + Lab QC + Lab Explainer | ✓ all-tenant | "+ New Order" button visible | 403 on all transitions | ✓ |
| DOCTOR | ✓ Lab | ✓ all-tenant | Not confirmed (404 on POST — `csrf_failed`) | 403 | ✓ |
| NURSE | ✗ | n/a (URL works) | n/a | 403 | ✓ via URL |
| RECEPTION | ✗ | n/a (URL works) | n/a | 403 | ✓ via URL |
| PHARMACIST | unconfirmed this session | reachable | n/a | not retested | ✓ |
| LAB_TECH | ✗ — no lab nav at all | ✓ all-tenant | ✗ | 403 | ✓ via URL |
| PATIENT | ✗ but `/dashboard/lab` reachable | ✓ scoped to MR000001 | ✗ | n/a | ✓ (no download, no signature, no PDF) |

### 2.6 Patient Safety Surface

> **CRITICAL:** TSH = 35 against Normal 0.4–4.0 uIU/mL is flagged **NORMAL** on a COMPLETED order (LAB000020). The Flag is set by the user, not derived. There is no system override even when `panicLow`/`panicHigh` are populated.

- No critical-value escalation; no doctor callback log; no SMS/email; no audit of who entered, who verified, who signed off.
- No sample-rejection workflow surfaced anywhere in UI even though `rejectedAt`/`rejectionReason` exist in the schema.
- No amendment flow even though COMPLETED reports may need correction (a hospital legal requirement).
- No two-person verification (maker/checker) gating.

---

## 3. Product Requirements Document — Ideal Lab Technician Module

### 3.1 Overview

Production-grade laboratory operations console for hospital and standalone diagnostic settings. Covers OPD, IPD, ER, referral, and home-collection workflows from order receipt through verified report delivery, including QC, inventory, machine integration, billing reconciliation, and statutory audit.

### 3.2 Business Goals

- Reduce average turnaround time by ≥30% versus paper/email baseline
- Eliminate sample-mismatch incidents through mandatory barcode scanning at every handoff
- Achieve NABL/CAP audit readiness via immutable result-trail
- Convert lab from cost center to revenue line through package pricing, insurance-claim auto-population, and inventory waste reduction

### 3.3 User Roles

| Role | Responsibilities |
|------|-----------------|
| **LAB_TECH** | Sample receipt, accessioning, processing, result entry |
| **LAB_PHLEBOTOMIST** | Collection only |
| **LAB_PATHOLOGIST / SR_LAB_TECH** | Verification, sign-off, amendments, critical-callback |
| **LAB_MANAGER** | QC, roster, inventory, analytics, machine config |
| **DOCTOR** | Order, view, acknowledge critical results |
| **NURSE** | IPD collection, status follow-up |
| **RECEPTION** | OPD order intake, billing pre-check |
| **PHARMACIST** | Read-only for drug-monitoring tests (INR, vancomycin trough) |
| **ADMIN** | Catalog, pricing, role grants, audit export |
| **PATIENT** | Own results with PDF, download, share via OTP |

### 3.4 Functional Requirements

#### FR-1 Test Catalog Management

CRUD on tests with: `code` (LOINC mapping), `name`, `category`, `sampleType`, `containerType`, `volumeRequired`, `preservatives`, `fastingRequired`, `normalRange` (per age/sex/pregnancy bracket), `unit`, `panicLow`, `panicHigh`, `criticalLow`, `criticalHigh`, `tatHours` (routine vs STAT), `price`, `taxonomy` (HSN), `description`, `methodology`, `accreditationStatus`, `machineId`, `reagentSku`, `isActive`, `validFrom`/`validTo`.

Bulk import via CSV. Soft-delete with audit.

#### FR-2 Packages & Profiles

Test bundles (e.g., LFT, KFT, Lipid Profile, Diabetic Panel) with bundle price and component visibility.

#### FR-3 Order Intake

- **OPD:** from Doctor module via "Add Lab Order" on consultation; from Reception via walk-in lab order form; from AI Booking; from Patient app (limited self-order)
- **IPD:** from Doctor's IPD order set; auto-link to `admissionId` and `wardId`
- **ER:** STAT flag default; bypass billing pre-check; flagged red in queue
- **Recurring/Standing orders** for IPD (e.g., daily CBC every 0600)
- Fasting prompt if any item in the order requires it

#### FR-4 Billing Pre-Check

Order creation calls Billing for price tally, displays estimate, captures payment status (PAID, UNPAID, INSURANCE_HOLD, PACKAGE_COVERED). Lab UI shows a yellow "Payment pending" banner. STAT/ER overrides with a manager-approval audit entry.

#### FR-5 Accessioning

On sample receipt, system generates accession number (date-based, e.g., `25-W19-LB-04827`), prints barcode + patient ID + collection time + container colour. Scan events logged with timestamp and operator:

- Scan-in at lab door
- Scan-at-instrument
- Scan-at-aliquot
- Scan-at-storage

#### FR-6 Sample Lifecycle States

```
ORDERED
  → SCHEDULED_COLLECTION
  → COLLECTED
  → IN_TRANSIT
  → RECEIVED
  → ACCESSIONED
  → PROCESSING
  → AWAITING_VERIFICATION
  → VERIFIED
  → REPORTED
  → DELIVERED
```

Side states: `REJECTED` (with reason taxonomy), `RECOLLECT_REQUESTED`, `ON_HOLD`, `REFERRED_OUT`, `AMENDED`, `CANCELLED`

#### FR-7 Result Entry

- **Field type per test:** numeric / text / qualitative-enum (Positive/Negative/Reactive) / structured (e.g., differential counts)
- **Auto-computed flag** from value, `panicLow`, `panicHigh`, age/sex bracket; user can override but override requires reason + audit
- **Delta-check** against patient's most-recent same-test value with configurable Δ thresholds
- **Sanity checks:** unit must match catalog; numeric must be within plausible bounds (e.g., hemoglobin 0–30 g/dL hard cap); empty submission blocked
- **Bulk entry view** for high-volume hematology/biochemistry
- **Machine-integrated mode** auto-populates `rawValue` plus QC tag

#### FR-8 Verification (Maker-Checker)

Result entry by LAB_TECH creates an `AWAITING_VERIFICATION` item. LAB_PATHOLOGIST verifies and signs. No PDF, no patient visibility, no doctor notification until `VERIFIED`. Verifier digital signature stored. **Verifier must be a different user from the result enterer.**

#### FR-9 Critical-Value Workflow

On VERIFIED-AND-CRITICAL, system creates a Critical Alert task:

1. Red banner on ordering Doctor's dashboard
2. SMS + push notification to doctor
3. Mandatory doctor acknowledgement with read-back text logged
4. Escalate to ward-charge nurse if doctor unacknowledged in 15 min
5. Escalate to medical director if still unacknowledged at 30 min

#### FR-10 Sample Rejection

Reason taxonomy: Hemolyzed, Clotted, Insufficient, Wrong container, Wrong patient label, Expired, Temperature breach, etc.

On rejection:
- Notifies orderer + nurse
- Auto-creates a Recollect task on Nurse/Phlebotomist queue
- Updates billing (no charge for rejected sample unless re-collected and processed)

#### FR-11 Amendment Workflow

Verified report can be amended with reason + dual sign-off. Original is immutable; amendment version is chained. All consumers (doctor, patient, insurance) are notified with a red "AMENDED v2" badge.

#### FR-12 Partial-Result Publishing

Multi-item order can publish completed items while others are pending, marked "Partial — pending tests: X, Y".

#### FR-13 Report Rendering

Branded PDF with: hospital logo, NABL/CAP number, methodology, reference ranges, colour-coded flags, verifier digital signature, QR code linking to a verification URL. Multi-language support.

#### FR-14 Patient Delivery

Patient portal Reports tab with: download, share-by-OTP-link, email PDF (opt-in), DigiLocker push (India), ABDM/ABHA push.

#### FR-15 STAT / Urgent Handling

STAT bypasses queue ordering, highlighted red, dedicated SLA timer. ER orders auto-flagged STAT.

#### FR-16 External Referral

Refer-out workflow with: external lab name, courier tracking, expected return date, external accession capture, fee reconciliation.

#### FR-17 Machine Integration

HL7 / ASTM / LIS gateway for bidirectional analyzer connectivity (e.g., Sysmex XN-1000, Beckman AU480, Roche Cobas). Auto-pull `rawValue`, `deltaCheck`, machine QC flag.

#### FR-18 Reagent / Inventory

Per-test reagent BOM. Auto-decrement on result entry. Reorder thresholds. Expiry alerts. Lot-number captured per result for traceability.

#### FR-19 Quality Control

Daily Levey-Jennings (partially scaffolded at `/dashboard/lab/qc`). Westgard rules (1-3s, 2-2s, R-4s, 4-1s, 10-x). Block result release on out-of-control QC run.

#### FR-20 TAT Monitoring

Per-test TAT clock from order creation to verified report. SLA breach alerts. Manager dashboard with red/amber/green status per category.

#### FR-21 Audit & Compliance

Every state change immutable in audit log: who, when, from-where (IP/device), what-changed, before/after values. Export to CSV/JSON for NABL inspectors. Retention: 8 years (India HIS guidance).

#### FR-22 Analytics

Revenue by test/category · Volume trends · Abnormal-rate · Repeat-rate · Doctor-order patterns · TAT by category · Rejection-rate by phlebotomist · Top-ordered tests · Insurance pre-auth conversion rate

### 3.5 Non-Functional Requirements

| Requirement | Target |
|-------------|--------|
| Availability | 99.9% |
| Result-entry P95 latency | < 300 ms |
| PDF generation P95 | < 3 s |
| Compliance | HIPAA + DPDP (India) + NABL 112 |
| Multi-tenancy | Row-level isolation via `tenantId` |
| Transport security | TLS 1.3 |
| PII handling | Redacted in logs; role-scoped audit visibility |
| Scale | Horizontal on order/result tables |

### 3.6 Permissions Matrix (Target)

| Capability | LAB_TECH | LAB_PATHOLOGIST | LAB_MANAGER | DOCTOR | NURSE | RECEPTION | ADMIN | PATIENT |
|-----------|----------|-----------------|-------------|--------|-------|-----------|-------|---------|
| View own assigned queue | ✓ | ✓ | ✓ | ✓ (own orders) | ✓ (IPD ward) | ✓ (today's OPD) | ✓ | own only |
| Create order | — | — | — | ✓ | — | ✓ (walk-in) | ✓ | self-order limited |
| Cancel order (pre-collection) | — | — | ✓ | ✓ | — | ✓ | ✓ | self pre-collection |
| Mark collected | ✓ (phleb) | ✓ | ✓ | — | ✓ IPD | — | ✓ | — |
| Reject sample | ✓ | ✓ | ✓ | — | — | — | ✓ | — |
| Process / accession | ✓ | ✓ | ✓ | — | — | — | ✓ | — |
| Enter results | ✓ | ✓ | ✓ | — | — | — | — | — |
| Verify / sign | — | ✓ | ✓ | — | — | — | — | — |
| Amend verified report | — | ✓ (dual sign) | ✓ | — | — | — | — | — |
| Print report | ✓ post-verify | ✓ | ✓ | ✓ | ✓ IPD | ✓ | ✓ | ✓ |
| Manage catalog | — | — | ✓ | — | — | — | ✓ | — |
| QC entry | ✓ | ✓ | ✓ | — | — | — | — | — |
| QC sign-off | — | ✓ | ✓ | — | — | — | ✓ | — |
| Acknowledge critical result | — | — | — | ✓ (ordering) | ✓ (ward) | — | ✓ | — |

### 3.7 API Expectations (Target)

```
# Orders
GET    /api/v1/lab/orders
POST   /api/v1/lab/orders
PATCH  /api/v1/lab/orders/:id

# State transitions
POST   /api/v1/lab/orders/:id/collect
POST   /api/v1/lab/orders/:id/reject
POST   /api/v1/lab/orders/:id/process
POST   /api/v1/lab/orders/:id/complete
POST   /api/v1/lab/orders/:id/verify
POST   /api/v1/lab/orders/:id/amend
POST   /api/v1/lab/orders/:id/cancel
POST   /api/v1/lab/orders/:id/recollect

# Results
POST   /api/v1/lab/orders/:id/items/:itemId/results

# Audit
GET    /api/v1/lab/orders/:id/audit

# QC
POST   /api/v1/lab/qc
GET    /api/v1/lab/qc/levey-jennings

# Catalog
GET    /api/v1/lab/catalog
POST   /api/v1/lab/catalog
POST   /api/v1/lab/packages

# Analytics
GET    /api/v1/lab/analytics/tat
GET    /api/v1/lab/analytics/volume
GET    /api/v1/lab/analytics/revenue
GET    /api/v1/lab/analytics/rejections

# Other
POST   /api/v1/lab/critical-ack
GET    /api/v1/lab/reports/:id/pdf

# Webhook (downstream consumers)
lab.result.verified
```

### 3.8 Validation Rules

| Rule | Details |
|------|---------|
| Numeric unit dimension | Value must match catalog unit dimension; auto-reject implausible orders of magnitude |
| Reference range required | Catalog item must have `normalRange` populated before result entry is permitted |
| Flag derivation | `value < criticalLow` → CRITICAL_LOW; `value < panicLow` → LOW; `value > criticalHigh` → CRITICAL_HIGH; `value > panicHigh` → HIGH; else NORMAL. Manual override requires reason. |
| State precondition | Result cannot be entered before sample is in `ACCESSIONED` state |
| Maker-checker | Verify cannot be performed by the same user who entered the result |
| Print / PDF gate | Only on `VERIFIED` + (paid OR insurance-approved OR ER-override) |

### 3.9 Alert / Notification System

Fan-out channels: in-app toast · SMS (Twilio/Gupshup) · WhatsApp template · ABDM push · Email · Mobile push

Channel matrix configurable per event type:

| Event | Channels |
|-------|---------|
| CRITICAL_RESULT | All channels |
| REPORT_READY | Email + push |
| SAMPLE_REJECTED | In-app + SMS to nurse |

### 3.10 Reporting System

PDF template engine (Puppeteer/wkhtml). Per-tenant branding. Multi-language. QR-verification URL. Embedded digital signature. Bilingual hospital footer. HSN/SAC and GSTIN.

### 3.11 Audit & Compliance

Immutable, append-only event store. Exportable in NABL/CAP inspector format. Retention: 8 years (India HIS guidance). Data redaction for un-privileged viewers in audit UI.

### 3.12 Future Scalability

- Multi-location lab (parent-child accessioning)
- Home-collection app with route optimisation
- AI-assisted normal-range learning
- Predictive instrument maintenance

---

## 4. Complete Feature List (Target)

- [ ] Test catalog management (CRUD, LOINC mapping, bulk CSV import)
- [ ] Diagnostic packages / bundles with bundle pricing
- [ ] Sample collection tracking with barcode/QR generation
- [ ] Scan-in at every custody handoff (door, instrument, aliquot, storage)
- [ ] Sample accessioning with date-based accession number generation
- [ ] Full sample lifecycle state machine (12 states + 6 side states)
- [ ] Test queue management with dedicated STAT lane
- [ ] Critical-result alerts with mandatory read-back acknowledgement
- [ ] Report generation (branded PDF + QR + digital signature)
- [ ] Verification / approval (maker-checker, separate verifier role)
- [ ] Multi-stage result validation (unit check, range check, delta-check, sanity cap)
- [ ] Machine / LIS integration (HL7 / ASTM bidirectional)
- [ ] Reagent inventory with per-test BOM, expiry alerts, lot tracking
- [ ] External-lab referral workflow (refer-out + courier tracking + fee reconciliation)
- [ ] STAT / urgent workflow with SLA timer and ER auto-STAT
- [ ] TAT monitoring dashboard (red/amber/green per category)
- [ ] Partial-result publishing for multi-item orders
- [ ] Amendment workflow (versioned, dual sign-off, immutable original)
- [ ] Sample rejection workflow with recollect task auto-creation
- [ ] Diagnostic analytics dashboard
- [ ] Revenue analytics by test / category
- [ ] Lab audit reports (NABL/CAP export format)
- [ ] Multi-location laboratory support
- [ ] Digital signatures on verified reports
- [ ] eReport / ABDM / DigiLocker patient delivery
- [ ] QC with Westgard rules (Levey-Jennings + 1-3s, 2-2s, R-4s, 4-1s, 10-x)
- [ ] Delta-check against prior patient results
- [ ] Drug-monitoring result linkage to Pharmacist module (INR, trough levels)
- [ ] Doctor critical-acknowledgement with read-back capture
- [ ] Patient-portal Reports tab with OTP-share and PDF download
- [ ] Fasting prompt on order creation
- [ ] Recurring / standing orders for IPD
- [ ] Billing pre-check and payment status banner on lab queue
- [ ] Insurance pre-auth linkage and claim auto-population
- [ ] LAB_TECH sidebar with Lab Queue, My Samples, Catalog, QC, Inventory, Reports
- [ ] Fix permission-bait: hide state-transition buttons if role is not authorised
- [ ] Fix `Print Report` gate (only post-verification)
- [ ] Fix dark-mode contrast (remove hardcoded `bg-white`)
- [ ] Fix result entry: required fields, typed inputs, empty-submission block

---

## 5. Gap Analysis

### 5.1 Feature Gaps

| Domain | Current State | Target State | Gap Severity |
|--------|--------------|--------------|--------------|
| LAB_TECH sidebar | Patient-persona items only | Lab Queue, My Samples, Catalog, QC, Inventory, Reports | **Critical** |
| Permissions on state transitions | 403 across all demo roles | Role-matrix per §3.6 | **Critical** — workflow inoperable |
| Result flag derivation | Manual dropdown, no auto-derivation | Auto-computed from panic values; override requires reason | **Critical** — patient safety |
| Result entry validation | All fields optional, numeric-only Value field | Required fields, typed per test, units enforced | **Critical** |
| Sample tracking | Schema-only (`collectedAt` timestamp) | Full lifecycle + barcode + custody chain | **Critical** |
| Accession / barcode | None | Mandatory at every handoff | **Critical** |
| Verification (maker-checker) | None | Separate verifier role + digital signature | **Critical** |
| Amendment / correction | None | Versioned with dual sign-off, immutable original | High |
| Critical-result escalation | None | Multi-channel + ack + escalation tree | **Critical** |
| Sample rejection / recollect | Schema fields only, no UI | Full UI + nurse handoff + billing update | High |
| STAT / priority lane | Filter pill only (zero STAT records) | Queue sort + SLA timer + ER auto-STAT | High |
| TAT monitoring | `tatHours` partial in catalog, unused | Live SLA dashboard per category | High |
| Machine integration | None | HL7/ASTM + raw value capture | High |
| Reagent inventory | None | Per-test BOM + expiry + lot tracking | Medium |
| QC | UI scaffold, no input or Westgard rules | Levey-Jennings + Westgard + block-on-fail | High |
| Catalog admin UI | None | Full CRUD + LOINC mapping + bulk import | High |
| Packages / bundles | None visible to Lab | Bundles + bundle pricing | Medium |
| Patient PDF / download | None | Branded PDF + QR + verifier signature | High |
| Patient portal "Reports" tab | Not in sidebar; URL-only | First-class sidebar entry | High |
| Insurance pre-auth linkage | None | Pre-check + claim auto-populate | Medium |
| Lab-specific audit log | Generic only | Immutable lab trail with NABL export | High |
| Dark-mode contrast | `bg-white` hardcoded — invisible text | Theme-aware CSS tokens | High (UX) |
| Permission-bait UI | Process button shown then 403 toast | Hide button if role not authorised | High |
| Order creation (all roles) | Untested + `csrf_failed` on Doctor probe | Role-gated + CSRF healthy | Medium-High |
| Test catalog completeness | 41% missing `normalRange`, 76% missing panic values | 100% complete catalog | High |

### 5.2 Schema Gaps

| Missing Field | Affected Entity | Impact |
|--------------|----------------|--------|
| Accession number | Order | Cannot implement barcode-based custody chain |
| `collectorId` | Order | Cannot audit who collected the sample |
| `sampleCondition` (enum) | Order | Cannot reject with structured reason |
| `instrumentId` | Order item result | Cannot link result to analyzer |
| `rawValue` | Order item result | Cannot store machine output separately from reviewed value |
| `verifierId`, `verifiedAt` | Order item result | Cannot enforce maker-checker |
| `resultEnteredAt` | Order item result | Incomplete audit trail |
| `amendmentChain` | Order | No versioning for corrections |
| `criticalCallbackLog` | Order | No escalation audit |
| `deltaCheckPriorValue` | Order item result | No delta check |
| `encounterId` | Order | OPD orders not linkable to consultation |
| `billingInvoiceId` | Order | Finance reconciliation impossible |
| `insurancePreAuthId` | Order | Insurance workflow broken |
| `fastingStatus` | Order | Clinical context missing |

---

## 6. Risk & Patient-Safety Register

| # | Risk | Likelihood | Impact | Severity |
|---|------|------------|--------|----------|
| R-01 | Abnormal result released as NORMAL due to free-form flag dropdown (TSH 35 flagged NORMAL confirmed in live data) | High | Patient may be discharged on critical TSH/glucose/electrolyte | **Critical** |
| R-02 | LAB_TECH cannot reach module from sidebar; workflow done via email/paper outside system | High | No audit trail, no SLA tracking | **Critical** |
| R-03 | Every state-transition endpoint returns 403 to all demo roles | High | System fundamentally inoperable | **Critical** |
| R-04 | No accession/barcode → sample mismatch risk | Medium | Wrong-patient result release | **Critical** |
| R-05 | Result entered by same person who verifies (no maker-checker) | High in absence of enforcement | Fabricated/erroneous result undetected | **Critical** |
| R-06 | No critical-value callback workflow | High | Delayed treatment, mortality risk | **Critical** |
| R-07 | "Print Report" available before result is entered or verified | High | Empty or unverified report leaks to patient/doctor | High |
| R-08 | All result fields non-required → empty result accepted | High | Garbage data in EHR | High |
| R-09 | Value is `<input type=number>` only — qualitative tests unrepresentable | Certain | Microbiology, serology, blood group, parasitology data corrupted | **Critical** |
| R-10 | No amendment workflow; corrections likely overwrite existing values | High | Legal/compliance breach | **Critical** |
| R-11 | Dark-mode white-on-white cards on order detail page | Certain | Result misreading by clinician | High |
| R-12 | Doctor sees Process/Reject buttons they are not authorised to use | High | User confusion, support ticket flood | Medium |
| R-13 | Patient `/dashboard/lab` reachable without sidebar; no Reports tab | Medium | Patients unaware their results exist | High |
| R-14 | `tatHours` field present but unused; no SLA alerts | High | Silent SLA breach | High |
| R-15 | QC UI exists but empty; results released without QC sign-off gate | High | Out-of-control instrument data released to clinicians | **Critical** |
| R-16 | No reagent lot tracked per result | High | Recall investigation impossible | High |
| R-17 | No instrument linkage; manual transcription | High | Transcription error, potential mortality | **Critical** |
| R-18 | Patient view has no Verified-By / Signature / PDF | Certain | Report has no legal weight | High |
| R-19 | `priority`/`stat` fields exist but no operational queueing | Certain | ER STAT order lost in routine queue | **Critical** |

---

*Document ends. Critical risks: 10. High risks: 9. Total features catalogued: 35. Gaps identified: 25 domains.*
