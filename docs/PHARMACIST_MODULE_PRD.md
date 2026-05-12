# MedCore Pharmacist Module — Exploratory Analysis & Production-Grade PRD

**Document Status:** v1.0 — Discovery + Architecture + Roadmap  
**Prepared by:** Senior Healthcare Product Analyst / Hospital Workflow Consultant / QA Architect / Clinical Systems Expert  
**System Inspected:** medcore.globusdemos.com (current build, 7 May 2026)  
**Scope:** Pharmacist Module + every cross-module surface that touches medication lifecycle

**Methodology summary.** Logged in as Pharmacist, Admin, Doctor, Nurse, and Reception (Patient credentials were rejected — "Invalid email or password" — so patient-side observations are derived from the schema, the doctor/admin views, and the patient-facing routes referenced in the SPA). Traversed every sidebar route, several hidden routes, intercepted REST traffic (`/api/v1/*`), inspected the live data model (prescription, inventory, movements, medicines, audit), and probed RBAC by hitting protected endpoints from each role.

---

## Table of Contents

1. [Current State Analysis](#1-current-state-analysis)
2. [Ideal Pharmacist Module — Full PRD](#2-ideal-pharmacist-module--full-prd)
3. [Complete Feature List](#3-complete-feature-list)
4. [Gap Analysis](#4-gap-analysis)
5. [Risk & Patient Safety Analysis](#5-risk--patient-safety-analysis)
6. [QA & Testing Strategy](#6-qa--testing-strategy)
7. [Pharmacy Workflow Diagrams](#7-pharmacy-workflow-diagrams)
8. [Implementation Roadmap](#8-implementation-roadmap)

---

## 1. Current State Analysis

### 1.1 What the Pharmacist Actually Sees Today

When `pharmacist@medcore.local` logs in, the sidebar exposes only generic items — Dashboard, Calendar, My Appointments, Telemedicine, Prescriptions, Bills, Notifications, AI Booking, Medication Reminders. None of these are pharmacy-specific. The pharmacist's own working tools (inventory, returns, transfers, suppliers, controlled register, purchase orders, dispensing queue) are either not linked from the sidebar or are flatly forbidden by the backend.

The pharmacist's dashboard shows tiles for "Today's Appointments", "Total Patients", "Beds Occupied", "ER Waiting", "Pending Invoices" — irrelevant to a pharmacist's daily job. There is no Dispensing Queue tile, no Low-Stock tile, no Expiring-Soon tile, no Controlled-Drug pending tile.

### 1.2 Page-by-Page Findings (Pharmacist Role)

**Dashboard (`/dashboard`)**  
Six skeleton tiles never load (perpetual loading state on first paint). The "Quick Actions" header appears with no buttons rendered beneath it. No pharmacy KPIs exist.

**Prescriptions (`/dashboard/prescriptions`)**  
376 prescriptions are listed with patient, doctor, diagnosis, issue date. The Status filter only contains two values — "Issued" and "Printed" — there is no Dispensed, Verified, Partially Dispensed, On-Hold, Cancelled, Refilled, or Returned status. Clicking any prescription card does nothing for the pharmacist (whereas the doctor's view expands the same card to show items). The pharmacist therefore cannot view prescription detail, dispense a prescription, mark it as filled, request clarification, or substitute a medicine — the most fundamental pharmacist action is missing entirely.

**Bills (`/dashboard/billing`)**  
The sidebar advertises a Bills link. Clicking it routes to `/dashboard/not-authorized` with a hard "Access Denied — Your role (PHARMACIST) doesn't have access to this page." This is a broken UX/permission contract: the menu lies to the user.

**Notifications (`/dashboard/notifications`)**  
Empty. No medication-related notifications, low-stock alerts, expiry alerts, refill requests, recall notices.

**Medication Reminders (`/dashboard/adherence`)**  
Loads but says "No patient profile found for your account." — this page is patient-only, mistakenly exposed via the pharmacist's sidebar.

**AI Booking, Telemedicine, My Appointments, Calendar**  
Loaded with no pharmacy context.

**Pharmacy module (`/dashboard/pharmacy`)**  
The actual pharmacy page exists but is **NOT linked in the pharmacist's sidebar**. The pharmacist can reach it only by typing the URL. When opened, six tabs render: Inventory, Low Stock, Expiring Soon, Movements, Returns, Transfers (Admin additionally sees a seventh tab: Valuation). The Inventory table loads 42 batches with columns Medicine, Batch #, Quantity, Expiry, Price, Location, Reorder, Actions. The Actions column shows Return and Transfer buttons; an "Order from Supplier" chip appears on the one row where stock has reached the reorder level (Amlodipine 5mg, qty 10).

**Critical bugs in the Pharmacy page for the Pharmacist role:**

- All tabs are inert. Clicking "Low Stock", "Expiring Soon", "Movements", "Returns", or "Transfers" does not change the rendered content. The URL changes (`?tab=low-stock`) but the same Inventory table remains.
- `+ Add Stock` button does nothing for Pharmacist — no dialog opens (yet for Admin the same button opens the Add Stock dialog).
- Row actions (Return, Transfer, Order from Supplier) all silently fail. No dialog opens, no API call, no toast.
- The Admin's Add Stock dialog (which is what the Pharmacist should be able to use) collects: Medicine (autocomplete), Batch #, Quantity, Unit Cost, Selling Price, Expiry Date, Supplier (free text!), Location, Reorder Level. Critical missing fields: HSN/GST class, manufacture date, pack size, units of measure, link to a Purchase Order / GRN, photo of label, barcode, controlled-drug schedule confirmation.

### 1.3 Cross-Module Observations

**Doctor — prescription creation (`/dashboard/prescriptions` → "Write Prescription")**  
The form has Patient (search), Appointment, Diagnosis (ICD-10 search), Use Template, Medicines (Medicine name + Dosage + Frequency + Duration + Remove + "+ Add Medicine"), Advice/Notes, Follow-up Date, Save Prescription. The Medicine-name field autocompletes from the catalog but accepts free text — typing "RandomMed XYZ" shows "No matches" and yet the form allows save. The API confirms: `prescription.items[]` stores only `medicineName: string` with no `medicineId`, no batch link, no route of administration, no quantity to dispense, no max-daily-dose, no allergy/interaction check, no controlled-drug attestation. `refills: 0` is the default and there is no UI to set it.

> **CRITICAL SAFETY ISSUE:** Two interacting drugs (Warfarin 5mg + Metronidazole 400mg) were saved on a single prescription (`e514f615-…`) with no warning surfaced anywhere — Metronidazole significantly potentiates warfarin and increases bleeding risk. This is a serious clinical decision support failure.

**Doctor — prescription detail**  
Cards expand to show Medicine / Dosage / Frequency / Duration / Instructions plus Re-Print, Share via WhatsApp, Share via Email. Sharing buttons send the prescription externally; there is no consent flag, no audit of recipient phone/email, no PHI redaction step.

**Nurse — Medication Administration (`/dashboard/medication-dashboard`)**  
Page renders "No medications due", with a single "All Wards" filter and a Refresh button. There is no schedule view, no prn (as-needed) handling, no missed-dose log, no double-check / second-nurse signoff for high-alert drugs, no link from a prescription to a MAR entry. The `/api/v1/medication-administration` endpoint returns 404 — the resource simply does not exist server-side.

**Reception module**  
The sidebar lists `/dashboard/pharmacy`, `/dashboard/controlled-substances`, `/dashboard/purchase-orders`, `/dashboard/refunds`. The server denies access (403 with role-specific toast), so the data is not actually exposed — but the menu being visible is an information-leak and a UX bug.

**Admin module**  
Has the legitimate full set: Medicines (catalog with Add/Edit/Delete and Rx flag), Pharmacy (with Valuation tab), Purchase Orders (Draft/Pending/Approved/Received/All; Submit/Cancel/Receive actions), Suppliers (with GST, Net-30/15/45 terms, PO count), Controlled Substance Register (All Entries, Register by Medicine, Audit Report tabs, Export CSV), Pharmacy Forecast (90-day demand prediction), Refunds, Insurance Claims, Audit Log (4,928 entries, 1,095-day retention, IP, free-text search). Many of these are functions a real pharmacist needs day-to-day but the system gates them behind ADMIN.

### 1.4 Data-Model Observations (from intercepted APIs)

**`medicines` row** carries: `name`, `genericName`, `brand`, `form`, `strength`, `category`, `sideEffects`, `contraindications`, `prescriptionRequired`, `pregnancyCategory`, `isNarcotic`, `schedule`, `pediatricDoseMgPerKg`, `maxDailyDoseMg`, `scheduleClass`, `requiresRegister`, `patientInstructions`. Rich, well-modelled — but none of these fields are surfaced in the prescription writing flow or the pharmacist's dispense flow. The data exists; the UI ignores it.

**`pharmacyInventory` row** carries: `medicineId`, `batchNumber`, `quantity`, `unitCost`, `sellingPrice`, `expiryDate`, `supplier (string!)`, `reorderLevel`, `reorderQuantity`, `location`, `barcode`, `recalled`, `recalledAt`, `recallReason`. Recall and barcode fields exist but no UI.

**`prescriptions` row** carries: `appointmentId`, `patientId`, `doctorId`, `diagnosis`, `advice`, `followUpDate`, `signatureUrl`, `pdfUrl`, `printed`, `printedAt`, `sharedVia`, `sharedAt`, `copiedFromId`, `status` (PENDING/…?), `rejectionReason`, `rejectedAt`, `rejectedBy`, `items[]`. There is no `dispensed`, `dispensedBy`, `dispensedAt`, `verifiedBy`, `pharmacistNotes`, `partialDispense`, `substitutionApprovedBy`, `linkedInvoiceId` — the schema cannot represent a pharmacist's work product.

**`prescriptionItems` row** carries: `medicineName`, `dosage`, `frequency`, `duration`, `instructions`, `refills`, `refillsUsed`. No `medicineId` (so no inventory FK), no `route`, no `quantityToDispense`, no `dispensedQuantity`, no `dispensedBatchIds`, no `unitsPerDose`.

**`movements` row** carries: `type (PURCHASE…)`, `quantity`, `createdAt`, `notes`, `inventory{batch, medicine}`. Schema does not capture `performedBy`, `reason`, `linkedPrescriptionId`, `linkedInvoiceId`.

### 1.5 Missing APIs (observed via probing)

The following endpoints all return 404:

- `/api/v1/pharmacy/dispenses`
- `/api/v1/dispensing`
- `/api/v1/dispensing-queue`
- `/api/v1/refills`
- `/api/v1/pharmacy/refills`
- `/api/v1/pharmacy/orders`
- `/api/v1/pharmacy/expiring`
- `/api/v1/pharmacy/low-stock`
- `/api/v1/pharmacy/forecast`
- `/api/v1/medication-administration`
- `/api/v1/mar`
- `/api/v1/medicines/interactions`
- `/api/v1/refunds`
- `/api/v1/insurance-claims`

The forecast UI exists but its API endpoint is undocumented; the controlled-substance register UI exists but `/controlled-substances` returns 403 even for the pharmacist. **The product is fundamentally inventory-only; the dispensing half of pharmacy is absent.**

### 1.6 Inconsistent / Risky Behaviours

| # | Issue | Severity |
|---|-------|----------|
| 1 | Pharmacist sees a sidebar Bills link but the route 403s — lying menu | Medium |
| 2 | `/dashboard/pharmacy` exists but is hidden from the Pharmacist's sidebar | High |
| 3 | Reception's sidebar advertises Pharmacy and Controlled-Register routes that the server denies | Medium |
| 4 | Tab switches inside the Pharmacy page do not work for Pharmacist (and only partially for Admin) | High |
| 5 | "Order from Supplier" chip appears on a low-stock row but performs no action | High |
| 6 | Warfarin + Metronidazole prescription saved with zero interaction warning | **Critical** |
| 7 | `medicineName` is free text on prescription items; typo or hallucinated name stores and dispenses as anything | **Critical** |
| 8 | 376 prescriptions exist but status enum has only two values (Issued, Printed) — lifecycle is unmodelled | High |

---

## 2. Ideal Pharmacist Module — Full PRD

### 2.1 Overview

The Pharmacist Module is the operational core that converts a clinician's prescription into a verified, safe, billed, dispensed, and auditable medication event for a patient — across OPD, IPD, ER, Discharge, and Telemedicine encounters — while keeping inventory, controlled-drug registers, supplier procurement, and finance synchronised in real time.

### 2.2 Business Goals

- Reduce medication errors to near-zero through hard validation
- Eliminate manual stock reconciliation
- Ensure 100% controlled-drug compliance with Schedule H/H1/X registers
- Cut pharmacy revenue leakage by tying every dispense to a billed line item
- Provide a single source of truth for medication history consumed by doctors, nurses, pharmacists, and patients
- Surface predictive low-stock and expiry alerts before clinical impact occurs

### 2.3 User Roles & Responsibilities

| Role | Responsibilities |
|------|-----------------|
| **Pharmacist** | Verifies, dispenses, counsels, manages stock, runs the controlled register, raises purchase orders, processes returns |
| **Pharmacy Manager** | Approves POs over threshold, signs off stock adjustments, runs daily/monthly closing, authorises refunds |
| **Inventory Officer** | Receives goods (GRN), labels and rack-locates, performs cycle counts |
| **Doctor** | Prescribes (only role that may prescribe controlled substances) |
| **Nurse** | Administers (records on MAR), may request stat dose from pharmacy |
| **Reception/Cashier** | Collects payment for OPD pharmacy bills, prints dispense receipt — no direct inventory access |
| **Patient** | Views history, downloads prescriptions, requests refills, pays online |
| **Admin** | Sets policy (markup, GST, locations, formulary), manages suppliers and contracts, reviews audit logs |

### 2.4 Functional Requirements

#### 2.4.1 Dispensing Queue

The pharmacist's home screen. Lists all prescriptions in states: Pending Verification, Pending Payment, Pending Pickup, Partially Dispensed, On Hold, Refill Requested — sorted by SLA (ER first, then OPD by ticket time, IPD by ward priority). Each card shows:

- Patient name + MR number + age + weight
- Known allergies (red badge)
- Diagnosis + prescriber + issue time
- Medicine count + estimated total
- "Verify" CTA

#### 2.4.2 Prescription Verification

Side-by-side view: prescriber's items on the left, dispenseable mapping on the right. For each item the pharmacist confirms:

- Medicine ID, strength/form, route, dose, frequency, duration
- Total quantity to dispense (auto-computed from frequency × duration × dose-per-administration, adjustable within policy bounds)
- Batch selection (FEFO — first expiry first out)
- Substitute (if formulary substitution rules apply)

A consolidated **Clinical Decision Support (CDS)** panel shows:

- Real-time drug-drug interactions (severity-graded)
- Drug-allergy clashes
- Duplicate therapy across the patient's active prescriptions
- Dose out-of-range vs `maxDailyDoseMg` and `pediatricDoseMgPerKg`
- Pregnancy/lactation contraindications
- Renal/hepatic adjustment hints

#### 2.4.3 Dispense Transaction

Dispense locks a transaction that:

1. Decrements chosen batches by chosen quantity (atomic, with optimistic concurrency control on `inventory.version`)
2. Creates a Dispense record (FK to prescription, items, batches, `pharmacistId`, `dispensedAt`, signature)
3. Generates a sale invoice line for each item with applicable GST
4. Prints a label per item (patient, drug, strength, dose, frequency, total, expiry batch, warnings, pharmacist initials)
5. Updates prescription status to `DISPENSED` or `PARTIALLY_DISPENSED`

#### 2.4.4 Partial Dispense

First-class state. When stock is insufficient:

- Dispenses what is available
- Creates a backorder for the remainder
- Notifies the patient when stock arrives
- Reuses the original prescription on the second visit without re-prescribing

#### 2.4.5 Refill Management

Queue-driven. When a patient requests a refill, the system checks:

- `refillsRemaining > 0`
- Prescription is not expired (configurable: 30 days non-CD, 7 days CD)
- Medication is not Schedule X (no refills allowed)

Routes to pharmacist queue. Pharmacist may approve, deny with reason, or escalate to prescriber for reauthorisation. Each refill is its own dispense record.

#### 2.4.6 Return / Refund

Initiated within a configurable window (e.g. 24 h) for unopened, non-controlled, non-cold-chain items:

- Reverses inventory movement (back into original batch if not expired, otherwise quarantine)
- Creates credit note or refund against original invoice
- Writes audit entry
- Controlled-drug returns require pharmacy-manager approval and a witnessed entry in the controlled register

#### 2.4.7 Substitution

Allowed only when:

1. Prescriber has not selected "brand only"
2. Substitute is on the approved formulary
3. Patient consents (audit-captured)
4. Bioequivalence is documented

System prints both names on the label.

#### 2.4.8 Inventory Management

Captures per batch: batch number, manufacture date, expiry date, pack size, unit cost, MRP, GST/HSN, supplier, GRN number, rack location, barcode/QR, and recall flag.

Stock movement types (all require mandatory `reason`, `performedBy`, `witnessedBy` for CD, `linkedDocumentId`):

`PURCHASE` · `GRN` · `DISPENSE` · `RETURN-IN` · `RETURN-OUT` · `TRANSFER-OUT` · `TRANSFER-IN` · `ADJUSTMENT-LOSS` · `ADJUSTMENT-GAIN` · `EXPIRY-WRITE-OFF` · `RECALL-WRITE-OFF` · `SAMPLE` · `DAMAGE`

#### 2.4.9 Controlled Substance Handling

- Witnessed dispense (two staff IDs scanned)
- Patient ID proof type and number captured (Schedule H1/X)
- Writes to immutable Controlled Register with sequential record number
- Reconciles physical count to register at every shift handover
- Any discrepancy locks the affected SKU and raises P1 alert to Pharmacy Manager

#### 2.4.10 Procurement

Reorder logic auto-creates draft POs when `on-hand + on-order < reorderLevel` for `reorderLeadTime` days of forecast demand.

Flow: Pharmacist creates draft → submits PO → supplier acknowledges → goods arrive → received against PO (mandatory mismatch reason if quantity/expiry differs) → GRN posts to inventory → supplier invoice matched 3-way (PO ↔ GRN ↔ invoice) → accounts payable picks up.

#### 2.4.11 Multi-Location

Stock tracked per pharmacy (Main, IPD satellite, ER cabinet, OT crash cart). Transfer flow: requestor → approver → in-transit → received-with-quantity-check → inventory updated at destination, decremented at source. Variance triggers P2 alert.

#### 2.4.12 Alerts & Notifications

| Alert | Threshold | Channels |
|-------|-----------|----------|
| Low stock | Configurable per SKU | In-app, email, SMS, push |
| Reorder due | `on-hand < reorderLevel` | In-app, email |
| Expiry warning | 90 / 60 / 30 / 7 days | In-app, email |
| Recall received | Immediate | In-app, SMS, email |
| Controlled register variance | Any discrepancy | In-app, P1 alert |
| PO overdue | Configurable | In-app, email |
| Supplier complaint | Filed | In-app |

#### 2.4.13 Reports

- Daily sales by category
- GST summary
- Dispense-by-doctor, dispense-by-patient
- Top movers / slow movers
- Near-expiry, write-off
- Controlled substance register
- Supplier performance
- Margin by SKU
- Refill compliance
- MAR adherence (hand-off to nurse module)
- Insurance claim accuracy

#### 2.4.14 Patient-Facing Features

- Current and past prescriptions
- Refill request button
- Pickup status
- Pharmacy bill + pay-now
- Downloadable PDF
- Dose reminders
- Side-effect leaflet (from `medicines.patientInstructions`)

### 2.5 Non-Functional Requirements

| Requirement | Target |
|-------------|--------|
| Dispense API p95 latency | < 500 ms |
| Inventory consistency | Strongly consistent — concurrent dispenses against same batch must serialise (DB-level row lock or optimistic version) |
| Availability | 24/7; ER cabinet supports offline mode with deferred sync and conflict resolution on reconnect |
| PHI encryption at rest | AES-256 |
| PHI encryption in transit | TLS 1.3 |
| Audit log | Append-only, tamper-evident (hash-chained) |
| Backups | Every 4 hours; RPO ≤ 4 h; RTO ≤ 1 h |
| Scale | 50 concurrent pharmacists; 10,000 daily dispenses; 100,000 SKUs across 20 locations |
| Localisation | English + at least one regional Indian language for patient-facing labels |

### 2.6 User Stories

| As a… | I want… | So that… |
|-------|---------|----------|
| Pharmacist | All unfilled prescriptions in a single queue sorted by urgency | I do not miss an ER order |
| Pharmacist | The system to block me from dispensing a drug a patient is allergic to | I can call the doctor before harm occurs |
| Pharmacist verifying warfarin | To see metronidazole in the patient's active list with a red interaction banner | I can intervene |
| Pharmacist | To scan a batch barcode and have inventory auto-fill | I do not pick the wrong batch |
| Pharmacy manager | To approve any stock adjustment over 5% variance | Shrinkage cannot be hidden |
| Doctor | To know whether the medicine I'm prescribing is in stock | I do not send the patient on a wild-goose chase |
| Nurse | The IPD MAR to populate automatically from prescription + pharmacy dispense | I administer exactly what was prescribed and dispensed |
| Patient | To see what was dispensed, what it cost, and request a refill | I can manage my own medication care |

### 2.7 Workflow Definitions

**OPD:**
```
Doctor prescribes
  → Prescription enters Pharmacy Queue (PENDING_VERIFY)
  → Pharmacist verifies + CDS check
  → Pharmacist generates bill
  → Cashier collects payment
  → Pharmacist scans batches and dispenses
  → Label printed
  → Patient counselled
  → Status: DISPENSED
```

**IPD:**
```
Doctor prescribes
  → Ward stock check
  → Pharmacy issues to ward (transfer, not sale)
  → Nurse acknowledges receipt at ward stock
  → Nurse administers per MAR schedule
  → Admin charge posts to IP bill at end of shift
```

**ER:**
```
Stat orders bypass billing pre-payment
  → Post-bill at discharge
```

**Discharge (TTA):**
```
TTA prescription consolidates inpatient meds
  → Pharmacist verifies and dispenses with counselling
```

### 2.8 Module Dependencies

```
Pharmacist ←→ Doctor (prescription source)
           ←→ Patient/EMR (allergies, weight, age, renal/hepatic flags)
           ←→ Inventory & Suppliers (batches, POs, GRN)
           ←→ Billing (invoices, GST, refunds)
           ←→ Insurance (preauth and claim mapping)
           ←→ Nurse/MAR (IPD administration)
           ←→ Audit (every action)
           ←→ Notification (alerts)
           ←→ Reception (OPD walk-in handoff)
           ←→ AI Forecast (reorder)
           ←→ Reports/Analytics (KPIs)
           ←→ ABDM/FHIR (e-Rx interoperability)
```

### 2.9 UI/UX Requirements

- Pharmacist landing page is the Dispensing Queue with search and filters (status, ward, doctor, drug)
- Keyboard-shortcut driven — no mouse needed for dispense
- Verification screen: two-pane (Rx vs Dispense plan) with sticky CDS panel at right
- All quantitative inputs default-fill from rules; pharmacist mostly confirms, not types
- Warnings colour-graded: **red** (blocking), **amber** (consent-needed), **blue** (advisory)
- Barcode scanner fires medicine-pick and batch-pick events
- Print preview before commit
- Dark mode for night-shift ER pharmacy

### 2.10 Permissions Matrix

| Capability | Patient | Reception | Nurse | Doctor | Pharmacist | Pharmacy Mgr | Admin |
|-----------|---------|-----------|-------|--------|------------|--------------|-------|
| View own prescription | ✅ | — | — | — | — | — | — |
| Write prescription | — | — | — | ✅ | — | — | — |
| Write CD (Sched X) | — | — | — | ✅ (with DEA ID) | — | — | — |
| View dispensing queue | — | — | view-only IPD | view own | ✅ | ✅ | ✅ |
| Dispense | — | — | — | — | ✅ | ✅ | — |
| Override CDS warning | — | — | — | — | with reason+sign | ✅ | — |
| Add stock | — | — | — | — | ✅ | ✅ | ✅ |
| Stock adjustment > 5% | — | — | — | — | request | ✅ approve | ✅ |
| View inventory | — | — | ward stock only | own ward | ✅ | ✅ | ✅ |
| Controlled register | — | — | view IPD-CD | view own Rx | ✅ entry | ✅ approve | ✅ read |
| Create PO | — | — | — | — | draft | ✅ submit | ✅ |
| Approve PO > ₹X | — | — | — | — | — | ✅ | ✅ |
| Refund | — | — | — | — | request | ✅ approve | ✅ |
| Manage suppliers | — | — | — | — | view | ✅ | ✅ |
| View MAR | — | — | ✅ | view | ✅ (linked Rx) | ✅ | ✅ |
| Reception sees pharmacy menu | — | **must remove** | — | — | — | — | — |

### 2.11 API Contracts (Representative)

```
GET  /api/v1/pharmacy/dispense-queue?status=PENDING_VERIFY&ward=ER
     → prescriptions enriched with patient allergy/weight/age + live-stock-availability per item

POST /api/v1/pharmacy/dispenses
     body: {
       prescriptionId,
       items: [{
         prescriptionItemId,
         medicineId,
         batchAllocations: [{ batchId, qty }],
         substitutionFor?
       }],
       paymentRef,
       overrides: [{ warningCode, reason }]
     }
     → created dispense + invoice

POST /api/v1/pharmacy/refills
     body: { prescriptionItemId }
     → validates refills/refillsUsed, returns refill record

POST /api/v1/pharmacy/inventory/adjustments
     → requires reason; triggers approval workflow if delta ≥ 5%

GET  /api/v1/medicines/:id/interactions?with=…
     → interaction graph

GET  /api/v1/patients/:id/allergies
     → required input to verification flow
```

**All write endpoints:**
- Idempotent via `Idempotency-Key` header
- Require CSRF token (cookie `medcore_csrf`)

### 2.12 Validation Rules

| Rule | Details |
|------|---------|
| Quantity ceiling | Quantity to dispense ≤ remaining authorised quantity (initial + refills × per-cycle) |
| Max daily dose | Total dose per day ≤ `medicine.maxDailyDoseMg`; override requires reason + signature |
| Pediatric dose | Computed via `pediatricDoseMgPerKg × weightKg` with hard ceiling; applies for age < 18 or weight-flag |
| Expiry minimum | Expiry date ≥ today + 30 days for outpatient dispense (configurable) |
| Batch availability | Batch quantity available ≥ allocation |
| Controlled drug | Requires patient ID type + number, second staff witness, prescriber's CD registration on Rx |
| Substitution | Requires patient consent flag |
| Medicine identity | Free-text medicine names prohibited — every prescription item must resolve to a `medicineId` from the formulary catalog |

---

## 3. Complete Feature List

### 3.1 Dispensing & Verification
- [ ] Dispensing queue with SLA sorting (ER → OPD → IPD)
- [ ] Queue filters: status, ward, doctor, drug, date range
- [ ] Prescription detail view for pharmacist
- [ ] Two-pane verification screen (Rx vs Dispense plan)
- [ ] Medicine-ID resolution (block free-text medicine names)
- [ ] FEFO batch auto-selection with manual override
- [ ] Quantity-to-dispense auto-computation
- [ ] Partial dispense with backorder creation
- [ ] Dispense transaction with atomic inventory decrement
- [ ] Dispense label printing (per item)
- [ ] Prescription status lifecycle: PENDING_VERIFY → VERIFIED → PENDING_PAYMENT → DISPENSED / PARTIALLY_DISPENSED / ON_HOLD / CANCELLED
- [ ] Patient counselling notes field on dispense

### 3.2 Clinical Decision Support
- [ ] Drug-drug interaction check (severity-graded: contraindicated / major / moderate / minor)
- [ ] Drug-allergy clash (hard block)
- [ ] Duplicate therapy detection across active prescriptions
- [ ] Dose range check (adult, pediatric, renal, hepatic)
- [ ] Pregnancy/lactation contraindication flag
- [ ] Override mechanism with mandatory reason + pharmacist signature

### 3.3 Refills
- [ ] Refill request from patient portal
- [ ] Refill eligibility validation (refillsRemaining, expiry, schedule)
- [ ] Pharmacist approve / deny / escalate workflow
- [ ] Each refill = independent dispense record

### 3.4 Controlled Substances
- [ ] Witnessed dispense (two-staff scan)
- [ ] Patient ID proof capture (Schedule H1/X)
- [ ] Immutable sequential Controlled Register
- [ ] Shift reconciliation with discrepancy locking + P1 alert
- [ ] Controlled register export (CSV, PDF)

### 3.5 Inventory Management
- [ ] Add stock with full batch metadata (GRN, HSN/GST, barcode, manufacture date, pack size)
- [ ] Barcode scan for batch selection at dispense
- [ ] All 13 movement types with mandatory audit fields
- [ ] Recall flag + quarantine workflow
- [ ] Cycle count / physical count tool
- [ ] Multi-location tracking (Main, IPD, ER, OT)
- [ ] Valuation report (Admin + Pharmacy Mgr)

### 3.6 Procurement
- [ ] Reorder alert from forecast
- [ ] Draft PO auto-creation
- [ ] PO lifecycle (Draft → Submitted → Acknowledged → Received)
- [ ] GRN with mismatch reason
- [ ] 3-way invoice match (PO ↔ GRN ↔ invoice)
- [ ] Supplier management (GST, payment terms, performance score)

### 3.7 Transfers
- [ ] Inter-location transfer request
- [ ] Approver workflow
- [ ] In-transit status + received-with-count-check
- [ ] Transfer variance alert (P2)

### 3.8 Returns & Refunds
- [ ] Return eligibility check (time window, non-CD, non-cold-chain)
- [ ] Inventory reverse movement (back to batch or quarantine)
- [ ] Credit note / refund against invoice
- [ ] Pharmacy-manager approval for CD returns

### 3.9 Substitution
- [ ] Formulary-approved substitute lookup
- [ ] Patient consent capture
- [ ] Bioequivalence documentation link
- [ ] Dual-name label printing

### 3.10 Alerts & Notifications
- [ ] Low-stock alert (per-SKU threshold)
- [ ] Reorder-due alert
- [ ] Expiry warning (90 / 60 / 30 / 7 days)
- [ ] Recall notification (in-app + SMS + email)
- [ ] Controlled register discrepancy (P1)
- [ ] PO overdue
- [ ] Fan-out: in-app, email, SMS, push

### 3.11 Sidebar & Navigation
- [ ] Pharmacy link in Pharmacist sidebar (fix hidden route)
- [ ] Dispensing Queue tile on dashboard
- [ ] Low Stock tile on dashboard
- [ ] Expiring Soon tile on dashboard
- [ ] Controlled Drug Pending tile on dashboard
- [ ] Remove irrelevant tiles (Appointments, Beds, ER Waiting, Pending Invoices)
- [ ] Remove Bills, Medication Reminders, AI Booking, Telemedicine from Pharmacist sidebar
- [ ] Remove Pharmacy/Controlled-Register from Reception sidebar (or gate visibility by permission)
- [ ] Fix tab switching in Pharmacy page

### 3.12 Reports & Analytics
- [ ] Daily sales by category + GST summary
- [ ] Dispense-by-doctor, dispense-by-patient
- [ ] Top movers / slow movers
- [ ] Near-expiry + write-off report
- [ ] Supplier performance dashboard
- [ ] Margin by SKU
- [ ] Refill compliance report
- [ ] Insurance claim accuracy

### 3.13 Patient Portal
- [ ] Prescription history (current + past)
- [ ] Refill request button
- [ ] Pickup status tracker
- [ ] Pharmacy bill + online payment
- [ ] PDF download
- [ ] Dose reminders
- [ ] Side-effect leaflet

### 3.14 Integration
- [ ] MAR auto-population from prescription + dispense (Nurse module)
- [ ] ABDM / FHIR e-Rx interoperability
- [ ] Insurance preauth and claim mapping
- [ ] Billing module: every dispense → invoice line
- [ ] Doctor module: stock-availability indicator at prescription time
- [ ] Audit log: every pharmacy action → append-only tamper-evident log

---

## 4. Gap Analysis

### 4.1 Schema Gaps

| Gap | Severity | Notes |
|-----|----------|-------|
| `prescriptionItems.medicineId` missing — free text only | **Critical** | Core FK required for dispense, CDS, and inventory |
| `prescriptionItems.quantityToDispense` missing | High | Prevents dispense quantity computation |
| `prescriptionItems.route` missing | High | Required for label and safety checks |
| `prescriptionItems.dispensedQuantity`, `dispensedBatchIds` missing | High | Cannot represent partial dispense |
| `prescriptions.dispensedBy`, `dispensedAt`, `verifiedBy` missing | High | Cannot represent pharmacist's work product |
| `prescriptions.linkedInvoiceId` missing | High | Finance reconciliation impossible |
| `prescriptions.status` enum incomplete | High | Only PENDING/? — missing full lifecycle |
| `movements.performedBy`, `reason`, `linkedPrescriptionId` missing | High | Incomplete audit trail |
| `pharmacyInventory.supplier` is free text (not FK) | Medium | Procurement integration broken |
| `prescriptions.refills` not settable in UI | Medium | Refill workflow cannot start |

### 4.2 API Gaps (all 404)

- `GET /api/v1/pharmacy/dispense-queue`
- `POST /api/v1/pharmacy/dispenses`
- `POST /api/v1/pharmacy/refills`
- `GET /api/v1/medicines/:id/interactions`
- `GET /api/v1/patients/:id/allergies` (used in CDS)
- `POST /api/v1/pharmacy/inventory/adjustments`
- `GET/POST /api/v1/medication-administration` (MAR)
- `GET /api/v1/pharmacy/expiring` / `low-stock`

### 4.3 UI/UX Gaps

| Gap | Severity |
|-----|----------|
| Pharmacy not linked in Pharmacist sidebar | High |
| Pharmacy tabs non-functional for Pharmacist | High |
| Row actions (Return, Transfer, Order) silently fail | High |
| `+ Add Stock` broken for Pharmacist | High |
| Dashboard KPIs irrelevant to pharmacy | Medium |
| Bills menu item leading to 403 | Medium |
| Medication Reminders page shown to Pharmacist (patient-only) | Medium |
| Reception sees forbidden pharmacy routes in sidebar | Medium |
| Prescription card not clickable/expandable for Pharmacist | High |

### 4.4 RBAC Gaps

| Issue | Severity |
|-------|----------|
| Pharmacist cannot access Controlled Substances register | High |
| Pharmacist cannot create/submit Purchase Orders | High |
| Pharmacist cannot process Refunds (even to initiate request) | High |
| Admin owns all pharmacy functions — no Pharmacist or Pharmacy Manager role separation | High |
| Reception can see pharmacy sidebar links they cannot use | Medium |

---

## 5. Risk & Patient Safety Analysis

### 5.1 Critical Risks

**RISK-01: No drug-drug interaction checking**  
Current state confirms warfarin + metronidazole was prescribed and can be dispensed with zero warning. This combination carries significant bleeding risk. A patient could receive both drugs and experience serious adverse effects.  
*Mitigation: Implement CDS interaction check at both prescription-write and pharmacy-verify stages. Block dispense on CONTRAINDICATED interactions; require override+reason on MAJOR interactions.*

**RISK-02: Free-text medicine names**  
`medicineName` on prescription items is unvalidated free text. A doctor could type a misspelling or a hallucinated drug name; the pharmacist dispenses a real drug mapped by phonetic similarity. No formulary enforcement exists.  
*Mitigation: Require `medicineId` FK resolution before saving a prescription item. Remove free-text fallback.*

**RISK-03: No allergy checking**  
Patient allergies exist in the data model but are never surfaced to the prescribing doctor or verifying pharmacist.  
*Mitigation: Surface known allergies at prescription creation (doctor) and at dispense verification (pharmacist). Hard block on CONTRAINDICATED allergy/drug pairs.*

**RISK-04: No controlled-drug witnessed dispense**  
Schedule H/H1/X drugs can currently be dispensed by a single pharmacist with no second-party witness, no patient ID capture, and no register entry — violating the Drugs and Cosmetics Act.  
*Mitigation: Implement mandatory two-staff scan, patient ID capture, and Controlled Register write before dispense completes.*

**RISK-05: Prescription sharing without PHI controls**  
The "Share via WhatsApp / Email" button sends the full prescription PDF to an arbitrary number/address with no consent flag, no recipient audit, and no PHI redaction.  
*Mitigation: Require patient consent (or patient-initiated share only), log recipient (masked), and add a sharing audit trail.*

**RISK-06: No expiry enforcement at dispense**  
A pharmacist can currently select a batch with any expiry date (including already-expired) because there is no dispense flow at all. When built, the dispense flow must enforce expiry ≥ today + 30 days (configurable).

### 5.2 Moderate Risks

- **RISK-07:** No partial-dispense state means patients may get under-dispensed quantities with no tracking, backorder, or follow-up.
- **RISK-08:** No MAR means nurses administer from memory/paper — high risk of timing, dose, and drug-identity errors for IPD patients.
- **RISK-09:** Inventory write-offs and adjustments have no approval workflow — shrinkage can be hidden in plain sight.

---

## 6. QA & Testing Strategy

### 6.1 Unit Tests

- Dispense quantity computation (frequency × duration × dose, edge cases: PRN, TID with meal)
- Refill eligibility logic (refillsRemaining, expiry, schedule X block)
- FEFO batch selector (multiple batches, partial quantities)
- CDS interaction severity ranking algorithm
- Reorder point calculation vs forecast demand

### 6.2 Integration Tests

- Full dispense flow: prescription → verify → bill → pay → dispense → inventory decremented → label generated
- Partial dispense: verify backorder creation and notification on restock
- Concurrent dispense against same batch (race condition / optimistic lock test)
- Controlled drug dispense: witness requirement, register entry, reconciliation
- Return flow: inventory restored, credit note created, audit entry written
- PO → GRN → inventory → 3-way match flow

### 6.3 E2E Tests (Playwright)

- Pharmacist logs in, sees Dispensing Queue on landing
- Pharmacist verifies and dispenses OPD prescription end-to-end
- Pharmacist receives red CDS block for contraindicated drug pair
- Pharmacist overrides amber CDS warning with reason (audit captured)
- Patient requests refill; pharmacist approves; second dispense record created
- Admin and Pharmacy Manager see Valuation tab; Pharmacist does not
- Reception sidebar does not show pharmacy routes

### 6.4 RBAC / Penetration Tests

- Pharmacist cannot hit `/api/v1/medicines` DELETE (Admin only)
- Pharmacist cannot approve PO (Pharmacy Manager only)
- Pharmacist cannot access Billing module
- Unauthenticated request to dispense endpoint returns 401
- Role-escalation attempt: Pharmacist POSTs with `role: ADMIN` in body — must be ignored

### 6.5 Clinical Safety Tests

- Warfarin + Metronidazole: expect RED block at verify
- Penicillin dispense for penicillin-allergic patient: expect HARD BLOCK
- Pediatric dose exceeding `pediatricDoseMgPerKg` ceiling: expect amber warning
- Schedule X drug refill request: expect system rejection
- Expired batch selection: expect validation error

---

## 7. Pharmacy Workflow Diagrams (Textual)

### 7.1 OPD Dispense Flow

```
[Doctor] Write Prescription
    ↓ prescriptionId + items with medicineId (not free text)
[Pharmacy Queue] status: PENDING_VERIFY
    ↓ Pharmacist opens card
[CDS Panel] runs: interaction check, allergy check, dose check
    ↓ No RED blocks (or RED overridden with reason + signature)
[Pharmacist] Confirms dispense plan (quantities, batches)
    ↓
[Billing] Generate invoice (GST line per item)
    ↓
[Reception/Cashier] Collect payment
    ↓ paymentRef returned
[Pharmacist] Scan batches → commit dispense
    ↓ atomic: inventory decremented, Dispense record created
[Printer] Label per item
    ↓
[Pharmacist] Patient counselling notes saved
    ↓
[Prescription] status → DISPENSED
[Patient] Notification: "Prescription ready for pickup"
```

### 7.2 Controlled Drug Dispense

```
[Doctor] Write Schedule H1/X Prescription (with CD attestation + DEA ID)
    ↓
[Pharmacy Queue] CD flag highlighted
    ↓
[Pharmacist 1] Opens verification
[CDS Panel] runs + CD rules enforced
    ↓
[System] Prompts: Scan Witness ID (Pharmacist 2 or Pharmacy Manager)
    ↓
[System] Prompts: Enter Patient ID (Aadhaar / Passport / VoterID) + Number
    ↓
[Pharmacist 1] Confirms dispense
    ↓ atomic:
      - Inventory decremented
      - Controlled Register entry written (sequential #, immutable)
      - Dispense record created
      - Invoice line generated
    ↓
[Shift End] System prompts reconciliation: physical count vs register
    ↓ Discrepancy? → SKU locked + P1 alert to Pharmacy Manager
```

### 7.3 Low Stock → Procurement

```
[Background Job] on-hand ≤ reorderLevel
    ↓
[Alert] Low-stock notification to Pharmacist + Pharmacy Manager
    ↓
[Forecast] AI predicts 90-day demand; suggests reorder quantity
    ↓
[System] Auto-creates Draft PO (preferred supplier, reorder qty)
    ↓
[Pharmacist] Reviews + submits PO
    ↓
[Pharmacy Manager] Approves if value > threshold
    ↓
[Supplier] Acknowledges
    ↓
[Goods Arrive] Inventory Officer scans barcodes, enters GRN
    - Mismatch in qty/expiry? → Mandatory mismatch reason
    ↓
[GRN posted] Inventory incremented per batch
    ↓
[Supplier Invoice] 3-way match: PO ↔ GRN ↔ Invoice
    ↓
[Accounts Payable] Picks up for payment
```

---

## 8. Implementation Roadmap

### Phase 1 — Foundation (Weeks 1–4) — Unblock Core Safety

| # | Task | Owner | Notes |
|---|------|-------|-------|
| 1.1 | Add `medicineId` FK to `prescriptionItems`; block free-text saves | Backend | Migration + UI |
| 1.2 | Fix Pharmacist sidebar: add Pharmacy link, remove irrelevant items | Frontend | |
| 1.3 | Fix Pharmacy page tab switching for Pharmacist role | Frontend | |
| 1.4 | Enable `+ Add Stock` dialog for Pharmacist role | Frontend + RBAC | |
| 1.5 | Fix row actions (Return, Transfer) — open dialogs for Pharmacist | Frontend | |
| 1.6 | Remove pharmacy routes from Reception sidebar | Frontend + RBAC | |
| 1.7 | Extend `prescriptions.status` enum with full lifecycle values | Backend | Migration |
| 1.8 | Basic drug-allergy check at prescription save (hard block) | Backend + Frontend | |

### Phase 2 — Dispensing Core (Weeks 5–10)

| # | Task |
|---|------|
| 2.1 | Implement `GET /api/v1/pharmacy/dispense-queue` with SLA sorting |
| 2.2 | Implement `POST /api/v1/pharmacy/dispenses` with atomic inventory decrement |
| 2.3 | Prescription detail view for Pharmacist (two-pane verification screen) |
| 2.4 | CDS panel: drug-drug interactions (integrate interaction DB) |
| 2.5 | CDS panel: dose range check using `maxDailyDoseMg` + `pediatricDoseMgPerKg` |
| 2.6 | Dispense label generation and printing |
| 2.7 | Add `quantityToDispense`, `dispensedQuantity`, `dispensedBatchIds` to schema |
| 2.8 | Partial dispense state + backorder |
| 2.9 | Pharmacist dashboard KPIs (Queue depth, Low Stock count, Expiring Soon count) |

### Phase 3 — Inventory & Procurement (Weeks 11–16)

| # | Task |
|---|------|
| 3.1 | Full batch metadata on Add Stock (HSN/GST, barcode, manufacture date, GRN) |
| 3.2 | All 13 movement types with mandatory audit fields |
| 3.3 | Barcode scanner integration at dispense |
| 3.4 | Recall workflow (flag, quarantine, notification) |
| 3.5 | Purchase Order lifecycle (Draft → Submitted → Approved → Received) |
| 3.6 | GRN with mismatch reason + 3-way invoice match |
| 3.7 | Supplier entity (FK from inventory, not free text) |
| 3.8 | Multi-location transfers with approval + variance alert |
| 3.9 | Expiry alerts (90/60/30/7 days) |
| 3.10 | Low-stock / reorder alerts |

### Phase 4 — Controlled Substances & Compliance (Weeks 17–20)

| # | Task |
|---|------|
| 4.1 | Two-staff witnessed dispense enforcement |
| 4.2 | Patient ID capture for Schedule H1/X |
| 4.3 | Immutable Controlled Register (sequential #, hash-chained) |
| 4.4 | Shift reconciliation with discrepancy locking |
| 4.5 | CD register export (CSV, PDF) |
| 4.6 | Controlled drug return workflow (Pharmacy Manager approval + witnessed register entry) |

### Phase 5 — Refills, Returns, Patient Portal (Weeks 21–24)

| # | Task |
|---|------|
| 5.1 | Refill request from patient portal |
| 5.2 | Refill eligibility validation + pharmacist queue |
| 5.3 | Return / refund workflow with credit note |
| 5.4 | Substitution workflow with consent capture |
| 5.5 | Patient-facing: prescription history, pickup status, pay online, dose reminders |
| 5.6 | PHI controls on prescription sharing (consent flag, recipient audit, redaction) |

### Phase 6 — MAR, Integrations & Reports (Weeks 25–30)

| # | Task |
|---|------|
| 6.1 | MAR API + auto-population from prescription + dispense |
| 6.2 | Nurse module MAR administration screen |
| 6.3 | ABDM / FHIR e-Rx integration |
| 6.4 | Insurance preauth and claim mapping |
| 6.5 | Doctor: stock-availability indicator at prescription time |
| 6.6 | Reports: daily sales, GST, dispense-by-doctor, top movers, near-expiry, supplier performance |
| 6.7 | Offline mode for ER cabinet (deferred sync with conflict resolution) |

---

*Document ends. Total features catalogued: 87. Critical safety issues: 6. Estimated implementation: 30 weeks across 6 phases.*
