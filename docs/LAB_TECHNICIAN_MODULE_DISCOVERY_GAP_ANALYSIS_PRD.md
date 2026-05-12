# Lab Technician Module - Discovery, Gap Analysis & PRD

**Application:** MedCore HMS (`medcore.globusdemos.com`)  
**Date:** 11 May 2026  
**HEAD:** `c52ce79`  
**Author role-pack:** Sr. Healthcare Product Analyst · Lab Ops Consultant · QA Architect · Clinical Diagnostics Expert · Hospital Systems Analyst

## Scope Note

I explored every reachable Lab surface as `LAB_TECH`, `ADMIN`, `DOCTOR`, `NURSE`, `RECEPTION`, and `PATIENT`, plus the underlying API. Findings below are evidence-based from live probes; quotes/screenshots cited are from this session.

## 1. Executive Summary

MedCore ships a partial Lab module that on paper covers Orders -> Sample Collected -> In Progress -> Completed and a Test Catalog of 46 tests across 11 clinical categories. In practice the module is a read-mostly UI bolted onto a half-wired permission matrix, with the `LAB_TECH` role itself being the least-empowered persona in the entire workflow.

The single most serious finding is structural: the `LAB_TECH` user has zero lab-specific navigation in their sidebar (only patient-persona entries: My Appointments, Telemedicine, Prescriptions, Bills, AI Booking, Medication Reminders). The `/dashboard/lab` route exists and works, but is unreachable without typing the URL manually. Compounding this, every state-transition API (`collect`, `process`, `complete`, `verify`, `reject`, `cancel`, `amend`) returned HTTP `403` to `LAB_TECH`, `ADMIN`, `DOCTOR`, `NURSE`, and `RECEPTION` in parallel probes, meaning the workflow has no authorized actor at all in the demo tenant, or the role check is mis-keyed and bypassed only by a missing `PATHOLOGIST` role.

The patient-safety blast radius is large: a sample Thyroid result of `35 uIU/mL` against a normal range of `0.4-4.0 uIU/mL` is flagged `NORMAL` on the live order detail page, confirming flag selection is a free dropdown, not derived from `panicLow` / `panicHigh`. This must be remediated before any production rollout.

Below is the complete current-state map, the ideal-state PRD, gap analysis, risk register, QA strategy, and eight workflow diagrams.

## 2. Current State Analysis

### 2.1 Module Routes and Surfaces (Observed)

| Surface | URL | Visible to | Sidebar entry? |
| --- | --- | --- | --- |
| Lab Orders list + Test Catalog tabs + STAT Only filter | `/dashboard/lab` | All roles tested | `ADMIN` ✓, `DOCTOR` ✓; `LAB_TECH` ✗, `NURSE` ✗, `RECEPTION` ✗, `PATIENT` ✗ |
| Lab Order detail (Print Report, status, items, Add Result) | `/dashboard/lab/:orderId` | All roles | Reached via View/Enter Results buttons |
| Lab QC (Levey-Jennings) | `/dashboard/lab/qc` | `ADMIN` ✓ | `ADMIN` sidebar ✓; `LAB_TECH` ✗ |
| Lab Explainer (AI) | `/dashboard/lab-explainer` | `ADMIN` ✓ | Confirmed in `ADMIN` sidebar |
| AI Radiology | `/dashboard/ai-radiology` | `ADMIN` ✓ | Confirmed |
| Catalog admin (create/edit tests) | No UI found | n/a | n/a |
| Sample/specimen tracking page | No UI found | n/a | n/a |
| Critical-result console / amendment workflow | No UI found | n/a | n/a |

### 2.2 Data Model Observed via `/api/v1/lab/orders` and `/api/v1/lab/tests`

Order entity exposes:

- `id`
- `orderNumber` (`LAB######`)
- `patientId`
- `doctorId`
- `admissionId`
- `status` (`ORDERED` / `SAMPLE_COLLECTED` / `IN_PROGRESS` / `COMPLETED`; schema also has `REJECTED` unused)
- `notes`
- `orderedAt`
- `collectedAt`
- `completedAt`
- `rejectedAt`
- `rejectionReason`
- `priority` (`ROUTINE` only; `STAT` / `URGENT` enums unused in data)
- `stat` (boolean; `0` records flagged)
- `tenantId`
- `items[]`
- `patient`
- `doctor`

Order item:

- `id`
- `orderId`
- `testId`
- `status`
- `test{}`

Items have an independent `status` field, but the UI surfaces only the order-level status.

Test catalog:

- `id`
- `code`
- `name`
- `category`
- `price`
- `sampleType`
- `normalRange`
- `unit`
- `panicLow`
- `panicHigh`
- `tatHours`
- `description`
- `createdAt`

Observed catalog coverage:

- 46 tests
- 11 categories: Cardiology, Immunology, Endocrinology, Microbiology, Biochemistry, Hematology, Coagulation, Serology, Electrolytes, Clinical Pathology, Radiology
- 27 / 46 have `normalRange`
- 18 / 46 have `tatHours`
- 11 / 46 have panic values

### 2.3 Critical Missing Fields in the Data Model

The order/item schema does not include:

- accession number
- barcode / QR
- specimen container or volume
- collector identity
- collected location
- sample condition flags (`hemolyzed` / `clotted` / `insufficient`)
- instrument / analyzer ID
- raw machine result
- verifier / approver identity
- result-entered-at timestamp
- verified-at timestamp
- amendment trail
- critical-callback log
- repeat-test linkage
- derived flag from panic thresholds
- units validation
- ICD / diagnosis context
- fasting status
- clinical notes from doctor
- billing / invoice linkage
- insurance pre-auth status
- `encounterId` for OPD (only `admissionId` for IPD)

### 2.4 Workflow Observations

The list view exposes three contextual buttons: `View` (always), `Process` (when `status = SAMPLE_COLLECTED`), and `Enter Results` (when `status = IN_PROGRESS`).

Observed behavior:

- `Process` clicked as `LAB_TECH` -> toast `Forbidden`. API call: `POST /api/v1/lab/orders/:id/process` -> `403`. The UI advertises a capability the API denies, which is a permission-bait defect.
- `Enter Results` navigates to the order detail with an `Add Result` form. Fields: `Parameter` (text), `Value` (number-only `<input type=number>`), `Unit` (text), `Normal Range` (text), `Flag` (dropdown: `Normal` / `Low` / `High` / `Critical`), `Notes` (text). Every field is non-required. Submitting an empty result is structurally possible.
- `Print Report` is present on every order detail, including `ORDERED` and `IN_PROGRESS`. It is shown before the result is even entered, much less verified.
- `STAT Only` filter pill is rendered but there are zero `STAT` orders in the dataset; the catalog `tatHours` field is also unused in any sorting / queue view.
- Order detail page suffers severe dark-mode contrast defects: patient name, doctor name, notes, test name, and `Recorded Results` rows are white text on near-white cards (`8` hardcoded `bg-white` elements per page). Patient-readable values become functionally invisible.

### 2.5 Cross-Role Exploration (Observed Lab Touchpoints)

| Role | Sidebar reaches Lab? | Order list scoped correctly? | Can order tests? | Can transition state? | Can view results? |
| --- | --- | --- | --- | --- | --- |
| `ADMIN` | ✓ Lab + Lab QC + Lab Explainer | ✓ all-tenant | `+ New Order` button visible | `403` on all transitions | ✓ |
| `DOCTOR` | ✓ Lab | ✓ all-tenant | Not confirmed (`404` on `POST /lab/orders` empty body returned `csrf_failed`) | `403` | ✓ |
| `NURSE` | ✗ | n/a (URL works) | n/a | `403` | ✓ via URL |
| `RECEPTION` | ✗ | n/a (URL works) | n/a | `403` | ✓ via URL |
| `PHARMACIST` | unconfirmed this session | reachable | n/a | not retested | ✓ |
| `LAB_TECH` | ✗, no lab nav at all | ✓ all-tenant | ✗ | `403` | ✓ via URL |
| `PATIENT` | ✗ but `/dashboard/lab` reachable | ✓ scoped to `MR000001` | ✗ | n/a | ✓ (no download, no signature, no PDF) |

### 2.6 Patient Safety Surface

- `TSH = 35` against `Normal: TSH 0.4-4.0 uIU/ml` is flagged `NORMAL` on a `COMPLETED` order (`LAB000020`). The flag is set by the user, not derived. There is no system override even when `panicLow` / `panicHigh` are populated.
- No critical-value escalation, no doctor callback log, no SMS / email, no audit of who entered, who verified, who signed off.
- No sample-rejection workflow surfaced anywhere in UI even though `rejectedAt` / `rejectionReason` exist.
- No amendment flow even though `COMPLETED` reports may need correction, which is a hospital legal requirement.
- No two-person verification (maker / checker) gating.

## 3. Product Requirements Document - Ideal Lab Technician Module

### 3.1 Overview

Production-grade laboratory operations console for hospital and standalone diagnostic settings. Covers OPD, IPD, ER, referral, and home-collection workflows from order receipt through verified report delivery, including QC, inventory, machine integration, billing reconciliation, and statutory audit.

### 3.2 Business Goals

- Reduce average turnaround time by `>=30%` versus paper/email baseline.
- Eliminate sample-mismatch incidents through mandatory barcode scanning at every handoff.
- Achieve NABL / CAP audit readiness via immutable result-trail.
- Convert lab from cost center to revenue line through package pricing, insurance-claim auto-population, and inventory waste reduction.

### 3.3 User Roles

- `LAB_TECH` (sample receipt, accessioning, processing, result entry)
- `LAB_PHLEBOTOMIST` (collection only)
- `LAB_PATHOLOGIST` / `SR_LAB_TECH` (verification, sign-off, amendments, critical-callback)
- `LAB_MANAGER` (QC, roster, inventory, analytics, machine config)
- `DOCTOR` (order, view, acknowledge critical)
- `NURSE` (IPD collection, status follow-up)
- `RECEPTION` (OPD order intake, billing pre-check)
- `PHARMACIST` (read for drug-monitoring tests like `INR`, vancomycin trough)
- `ADMIN` (catalog, pricing, role grants, audit export)
- `PATIENT` (own results with PDF, download, share via OTP)

### 3.4 Functional Requirements

#### FR-1 Test Catalog Management

CRUD on tests with:

- code (`LOINC` mapping)
- name
- category
- `sampleType`
- container type
- volume required
- preservatives
- fasting required
- `normalRange` (per age / sex / pregnancy)
- unit
- `panicLow`
- `panicHigh`
- `criticalLow`
- `criticalHigh`
- `tatHours` (routine vs `STAT`)
- price
- taxonomy (`HSN`)
- description
- methodology
- accreditation status
- `machineId`
- `reagentSku`
- `isActive`
- `validFrom` / `validTo`

Bulk import via CSV. Soft-delete with audit.

#### FR-2 Packages & Profiles

Test bundles (for example `LFT`, `KFT`, `Lipid Profile`, `Diabetic Panel`) with bundle price and component visibility.

#### FR-3 Order Intake

`OPD`:

- from Doctor module via `Add Lab Order` on consultation
- from Reception via walk-in lab order form
- from AI Booking
- from Patient app (limited self-order)

`IPD`:

- from Doctor's IPD order set
- auto-link to `admissionId` and `wardId`

`ER`:

- `STAT` flag default
- bypass billing pre-check
- flagged red in queue

Recurring / standing orders for IPD (daily CBC every `0600`).

Fasting prompt if any item requires it.

#### FR-4 Billing Pre-Check

Order creation calls Billing for price tally, displays estimate, captures payment status (`PAID`, `UNPAID`, `INSURANCE_HOLD`, `PACKAGE_COVERED`). Lab UI shows a yellow `Payment pending` banner; `STAT` / `ER` overrides this with a manager-approval audit entry.

#### FR-5 Accessioning

On sample receipt, system generates accession number (date-based, for example `25-W19-LB-04827`), prints barcode + patient ID + collection time + container color. Scan-in at lab door, scan-at-instrument, scan-at-aliquot, and scan-at-storage are all logged with timestamps and operator.

#### FR-6 Sample Lifecycle States

`ORDERED -> SCHEDULED_COLLECTION -> COLLECTED -> IN_TRANSIT -> RECEIVED -> ACCESSIONED -> PROCESSING -> AWAITING_VERIFICATION -> VERIFIED -> REPORTED -> DELIVERED`

Side states:

- `REJECTED` (with reason taxonomy)
- `RECOLLECT_REQUESTED`
- `ON_HOLD`
- `REFERRED_OUT`
- `AMENDED`
- `CANCELLED`

#### FR-7 Result Entry

Field type per test:

- numeric
- text
- qualitative-enum (`Positive` / `Negative` / `Reactive`)
- structured (for example differential counts)

System behavior:

- auto-computes flag from value, `panicLow`, `panicHigh`, age / sex bracket
- user can override but override requires reason + audit
- delta-check against patient's most-recent same-test value, with configurable `Δ` thresholds
- sanity checks: unit must match catalog; numeric must be within plausible bounds (for example hemoglobin `0-30 g/dL` hard cap); empty submission blocked
- bulk entry view for high-volume hematology / biochem
- machine-integrated mode auto-populates `rawValue` plus QC tag

#### FR-8 Verification (Maker-Checker)

Result entry by `LAB_TECH` creates an `AWAITING_VERIFICATION` item. `LAB_PATHOLOGIST` verifies and signs. No PDF, no patient visibility, no doctor notification until `VERIFIED`. Verifier digital signature stored.

#### FR-9 Critical-Value Workflow

On `VERIFIED-AND-CRITICAL`, system creates a Critical Alert task:

- red banner on Doctor's dashboard
- SMS + push notification
- mandatory acknowledgement with read-back text logged
- escalates to ward-charge nurse if doctor unacknowledged in `15 min`
- escalates to medical director in `30 min`

#### FR-10 Sample Rejection

Reason taxonomy (`Hemolyzed`, `Clotted`, `Insufficient`, `Wrong container`, `Wrong patient label`, `Expired`, `Temperature breach`, etc.). Rejection notifies orderer + nurse, automatically creates a Recollect task on Nurse / Phlebotomist queue, and updates billing (no charge for rejected sample unless re-collected and processed).

#### FR-11 Amendment Workflow

Verified report can be amended with reason + dual sign-off; original immutable, amendment version chained. Notify all consumers (doctor, patient, insurance) with red `AMENDED v2` badge.

#### FR-12 Partial-Result Publishing

Multi-item order can publish completed items while others pend, marked `Partial - pending tests: X, Y`.

#### FR-13 Report Rendering

Branded PDF with hospital logo, NABL / CAP number, methodology, reference ranges, flags (color-coded), verifier digital signature, QR code linking to verification URL. Multi-language support.

#### FR-14 Patient Delivery

Patient portal Reports tab with download, share-by-OTP-link, email PDF (opt-in), DigiLocker push (India), and `ABDM` / `ABHA` push.

#### FR-15 STAT / Urgent Handling

`STAT` bypasses queue ordering, highlighted red, dedicated SLA timer, `ER` auto-`STAT`.

#### FR-16 External Referral

Refer-out workflow with external lab name, courier tracking, expected return, external accession capture, fee reconciliation.

#### FR-17 Machine Integration

`HL7` / `ASTM` / `LIS` gateway for bidirectional analyzer connectivity (for example `Sysmex XN-1000`, `Beckman AU480`, `Roche Cobas`). Auto pull `rawValue`, `deltaCheck`, machine QC flag.

#### FR-18 Reagent / Inventory

Per-test reagent BOM. Auto-decrement on result; reorder thresholds; expiry alerts; lot-number capture per result for traceability.

#### FR-19 QC

Daily Levey-Jennings (already partly scaffolded at `/dashboard/lab/qc`). Westgard rules (`1-3s`, `2-2s`, `R-4s`, `4-1s`, `10-x`). Block result release on out-of-control QC.

#### FR-20 TAT Monitoring

Per-test TAT clock, SLA breach alerts, manager dashboard with red / amber / green per category.

#### FR-21 Audit & Compliance

Every state change immutable in audit log: who, when, from-where (`IP` / device), what-changed, before / after. Export to CSV / JSON for NABL inspectors.

#### FR-22 Analytics

- Revenue by test / category
- volume trends
- abnormal-rate
- repeat-rate
- doctor-order patterns
- TAT by category
- rejection-rate by phlebotomist
- top-ordered tests
- insurance-pre-auth conversion

### 3.5 Non-Functional Requirements

- Availability `99.9%`
- result-entry `P95 < 300 ms`
- PDF generation `P95 < 3 s`
- `HIPAA` + `DPDP (India)` + `NABL 112` alignment
- row-level multi-tenant isolation via `tenantId`
- full `TLS 1.3`
- `PII` redaction in logs
- role-scoped audit visibility
- horizontal scale on order / result tables

### 3.6 Permissions Matrix (Target)

| Capability | LAB_TECH | LAB_PATHOLOGIST | LAB_MANAGER | DOCTOR | NURSE | RECEPTION | ADMIN | PATIENT |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| View own assigned queue | ✓ | ✓ | ✓ | ✓ (orders by self) | ✓ (IPD ward) | ✓ (today's OPD) | ✓ | own only |
| Create order | - | - | - | ✓ | - | ✓ (walk-in) | ✓ | self-order limited |
| Cancel order (pre-collection) | - | - | ✓ | ✓ | - | ✓ | ✓ | self pre-collection |
| Mark collected | ✓ (phleb) | ✓ | ✓ | - | ✓ IPD | - | ✓ | - |
| Reject sample | ✓ | ✓ | ✓ | - | - | - | ✓ | - |
| Process / accession | ✓ | ✓ | ✓ | - | - | - | ✓ | - |
| Enter results | ✓ | ✓ | ✓ | - | - | - | - | - |
| Verify / sign | - | ✓ | ✓ | - | - | - | - | - |
| Amend verified report | - | ✓ (with dual sign) | ✓ | - | - | - | - | - |
| Print report | ✓ post-verify | ✓ | ✓ | ✓ | ✓ IPD | ✓ | ✓ | ✓ |
| Manage catalog | - | - | ✓ | - | - | - | ✓ | - |
| QC entry | ✓ | ✓ | ✓ | - | - | - | - | - |
| QC sign-off | - | ✓ | ✓ | - | - | - | ✓ | - |
| Acknowledge critical | - | - | - | ✓ ordering | ✓ ward | - | ✓ | - |

### 3.7 API Expectations (Target)

- `GET /api/v1/lab/orders`
- `POST /api/v1/lab/orders`
- `PATCH /api/v1/lab/orders`
- `POST /lab/orders/:id/collect`
- `POST /lab/orders/:id/reject`
- `POST /lab/orders/:id/process`
- `POST /lab/orders/:id/complete`
- `POST /lab/orders/:id/verify`
- `POST /lab/orders/:id/amend`
- `POST /lab/orders/:id/cancel`
- `POST /lab/orders/:id/recollect`
- `POST /lab/orders/:id/items/:itemId/results`
- `GET /lab/orders/:id/audit`
- `POST /lab/qc`
- `GET /lab/qc/levey-jennings`
- `GET /lab/catalog`
- `POST /lab/catalog`
- `POST /lab/packages`
- `GET /lab/analytics/{tat,volume,revenue,rejections}`
- `POST /lab/critical-ack`
- `GET /lab/reports/:id/pdf`
- webhook `lab.result.verified` for downstream consumers

### 3.8 Validation Rules

- Numeric value must match unit dimension; auto-reject implausible orders of magnitude.
- Reference range must be present for catalog item or result entry is blocked.
- Flag derivation:
  - `value < criticalLow -> CRITICAL_LOW`
  - `value < panicLow -> LOW`
  - `value > criticalHigh -> CRITICAL_HIGH`
  - `value > panicHigh -> HIGH`
  - else `NORMAL`
- Manual override requires reason.
- Result cannot be entered before sample is in `ACCESSIONED` state.
- Verify cannot be performed by the same user who entered the result.
- Print / PDF only on `VERIFIED + (paid OR insurance approved OR ER-override)`.

### 3.9 Alert / Notification System

- Toast in-app
- SMS (`Twilio` / `Gupshup`)
- WhatsApp template
- `ABDM` push
- email
- mobile push

Channel matrix configurable per event (`CRITICAL_RESULT -> all channels`; `REPORT_READY -> email + push`; `SAMPLE_REJECTED -> in-app + SMS to nurse`).

### 3.10 Reporting System

PDF template engine (`Puppeteer` / `wkhtml`); per-tenant branding; multi-language; QR-verification URL; embedded digital signature; bilingual hospital footer; `HSN` / `SAC` and `GSTIN`.

### 3.11 Audit & Compliance

Immutable, append-only event store. Exportable per NABL / CAP inspector format. Retention `8 years` (India HIS guidance). Data redaction for un-privileged viewers in audit UI.

### 3.12 Future Scalability

- Multi-location lab (parent-child accessioning)
- home-collection app with route optimization
- AI-assisted normal-range learning
- predictive instrument maintenance

## 4. Complete Feature List (Target)

Test catalog management · Diagnostic packages · Sample collection tracking · Barcode / QR generation & scan-in · Sample accessioning · Sample status tracking · Test queue management with STAT lane · Critical-result alerts with read-back · Report generation (`PDF` / `HL7`) · Verification / approval (maker-checker) · Multi-stage result validation · Machine / `LIS` integration · Reagent inventory · External-lab referrals · STAT / urgent workflow · TAT monitoring · Partial-result publishing · Amendment workflow · Diagnostic analytics dashboard · Revenue analytics · Lab audit reports · Multi-location laboratory support · Digital signatures · eReport / `ABDM` / DigiLocker delivery · QC with Westgard rules · Delta-check · Drug-monitoring linkage to Pharmacist · Doctor critical-acknowledgement · Patient-portal report download with OTP-share

## 5. Gap Analysis (Existing vs Ideal)

| Domain | Current | Target | Gap |
| --- | --- | --- | --- |
| `LAB_TECH` sidebar | Patient-persona only | Lab Queue, My Samples, Catalog, QC, Inventory, Reports | Critical - module unreachable from nav |
| Permissions on state transitions | `403` across all demo roles | Role-matrix per section 3.6 | Critical - workflow inoperable |
| Result flag derivation | Manual dropdown, no derivation | Auto from panic + override with reason | Critical - patient safety |
| Result entry validation | All fields optional, numeric-only Value | Required, typed per test, units enforced | Critical |
| Sample tracking | Schema-only (`collectedAt`) | Full lifecycle + barcode + custody chain | Critical |
| Accession / barcode | None | Mandatory at every handoff | Critical |
| Verification (maker-checker) | None | Separate verifier role + signature | Critical |
| Amendment / correction | None | Versioned with dual sign-off | High |
| Critical-result escalation | None | Multi-channel + ack + escalation tree | Critical |
| Sample rejection / recollect | Schema only | Full UI + nurse handoff | High |
| `STAT` / priority lane | Filter pill only | Queue sort + SLA + ER auto-STAT | High |
| TAT monitoring | `tatHours` partial in catalog | Live SLA dashboard | High |
| Machine integration | None | `HL7` / `ASTM` + raw value capture | High |
| Reagent inventory | None | Per-test BOM + expiry | Medium |
| QC | UI scaffold, no input / rules | Levey-Jennings + Westgard | High |
| Catalog admin UI | None | Full CRUD + `LOINC` mapping | High |
| Packages | None visible to Lab | Bundles + bundle pricing | Medium |
| Patient PDF / download | None | Branded PDF + QR + sign | High |
| Patient portal `Reports` tab | Not in sidebar; URL only | First-class sidebar | High |
| Insurance pre-auth linkage | None | Pre-check + claim auto-populate | Medium |
| Audit log | Generic only | Lab-specific immutable trail | High |
| Dark-mode contrast | `bg-white` hardcoded - invisible text | Theme-aware tokens | High UX |
| Permission-bait UI | Process button shown then `403` toast | Hide button if not authorized | High |
| Order can be created by all roles? | Untested + `csrf_failed` | Role-gated + CSRF healthy | Medium-High |
| Test catalog completeness | `41%` no `normalRange`, `76%` no panic | `100%` complete catalog | High |

## 6. Risk & Patient-Safety Register

| # | Risk | Likelihood | Impact | Severity |
| --- | --- | --- | --- | --- |
| `R-01` | Abnormal result released as `NORMAL` due to free-form flag dropdown | High | Patient may be discharged on critical TSH / glucose / electrolyte | Critical |
| `R-02` | `LAB_TECH` cannot reach module from sidebar; workflow done via email / paper outside system | High | No audit trail, no SLA tracking | Critical |
| `R-03` | Every state-transition endpoint returns `403` to all demo roles | High | System fundamentally inoperable | Critical |
| `R-04` | No accession / barcode -> sample mismatch | Medium | Wrong patient result release | Critical |
| `R-05` | Result entered by same person who verifies | High in absence of maker-checker | Fabricated / erroneous result undetected | Critical |
| `R-06` | No critical-value callback workflow | High | Delayed treatment, mortality risk | Critical |
| `R-07` | `Print Report` available before result is entered / verified | High | Empty or unverified report leaks to patient / doctor | High |
| `R-08` | All result fields non-required -> empty result accepted | High | Garbage data in EHR | High |
| `R-09` | Value is `<input type=number>` only; qualitative tests unrepresentable | Certain | Microbiology, serology, blood-group, parasitology corrupted | Critical |
| `R-10` | No amendment workflow; corrections likely overwrite | High | Legal / compliance breach | Critical |
| `R-11` | Dark-mode white-on-white cards on order detail | Certain | Result misreading | High |
| `R-12` | Doctor sees Process / Reject not authorized to them but UI exposes | High | User confusion, ticket flood | Medium |
| `R-13` | Patient `/dashboard/lab` reachable without sidebar; no Reports tab | Medium | Patients unaware results exist | High |
| `R-14` | TAT field present but unused; no SLA alerts | High | Silent SLA breach | High |
| `R-15` | QC UI exists but empty; results released without QC sign-off gate | High | Out-of-control instrument data released | Critical |
| `R-16` | No reagent lot tracked per result | High | Recall impossible | High |
| `R-17` | No instrument linkage; manual transcription error | High | Transcription mortality | Critical |
| `R-18` | Patient view has no Verified-By / Signature / PDF | Certain | Report has no legal weight | High |
| `R-19` | `priority` / `stat` fields exist but no operational queueing | Certain | ER `STAT` lost in routine queue | Critical |
