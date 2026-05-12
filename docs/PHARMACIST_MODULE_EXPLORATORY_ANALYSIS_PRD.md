# MedCore Pharmacist Module - Exploratory Analysis & Production-Grade PRD

**Document Status:** `v1.0` - Discovery + Architecture + Roadmap  
**Prepared by:** Senior Healthcare Product Analyst / Hospital Workflow Consultant / QA Architect / Clinical Systems Expert  
**System Inspected:** `medcore.globusdemos.com` (current build, 7 May 2026)  
**Scope:** Pharmacist Module + every cross-module surface that touches medication lifecycle

## Methodology Summary

I logged in as Pharmacist, Admin, Doctor, Nurse, and Reception (the Patient credentials in the brief were rejected by the server - `Invalid email or password` - so patient-side observations are derived from the schema, the doctor/admin views, and the patient-facing routes referenced in the SPA). I traversed every sidebar route, several hidden routes, intercepted REST traffic (`/api/v1/*`), inspected the live data model (`prescription`, `inventory`, `movements`, `medicines`, `audit`), and probed `RBAC` by hitting protected endpoints from each role.

## Table of Contents

- Current State Analysis (what actually exists today)
- Ideal Pharmacist Module - Full PRD
- Complete Feature List (catalog)
- Gap Analysis (existing vs ideal, severity-tagged)
- Risk & Patient Safety Analysis
- QA & Testing Strategy
- Pharmacy Workflow Diagrams (textual)
- Implementation Roadmap

## 1. Current State Analysis

### 1.1 What the Pharmacist Actually Sees Today

When `pharmacist@medcore.local` logs in, the sidebar exposes only generic items - Dashboard, Calendar, My Appointments, Telemedicine, Prescriptions, Bills, Notifications, AI Booking, Medication Reminders. None of these are pharmacy-specific. The pharmacist's own working tools (inventory, returns, transfers, suppliers, controlled register, purchase orders, dispensing queue) are either not linked from the sidebar or are flatly forbidden by the backend.

The pharmacist's dashboard shows tiles for `Today's Appointments`, `Total Patients`, `Beds Occupied`, `ER Waiting`, `Pending Invoices` - irrelevant to a pharmacist's daily job. There is no Dispensing Queue tile, no Low-Stock tile, no Expiring-Soon tile, no Controlled-Drug pending tile.

### 1.2 Page-by-Page Findings (Pharmacist Role)

`Dashboard` (`/dashboard`). Six skeleton tiles never load (perpetual loading state on first paint). The `Quick Actions` header appears with no buttons rendered beneath it. No pharmacy KPIs exist.

`Prescriptions` (`/dashboard/prescriptions`). `376` prescriptions are listed with patient, doctor, diagnosis, issue date. The Status filter only contains two values - `Issued` and `Printed` - there is no `Dispensed`, `Verified`, `Partially Dispensed`, `On-Hold`, `Cancelled`, `Refilled`, or `Returned` status. Clicking any prescription card does nothing for the pharmacist (whereas the doctor's view expands the same card to show items). The pharmacist therefore cannot view prescription detail, dispense a prescription, mark it as filled, request clarification, or substitute a medicine - the most fundamental pharmacist action is missing entirely.

`Bills` (`/dashboard/billing`). The sidebar advertises a Bills link. Clicking it routes to `/dashboard/not-authorized` with a hard `Access Denied - Your role (PHARMACIST) doesn't have access to this page.` This is a broken UX / permission contract: the menu lies to the user.

`Notifications` (`/dashboard/notifications`). Empty. No medication-related notifications, low-stock alerts, expiry alerts, refill requests, recall notices.

`Medication Reminders` (`/dashboard/adherence`). Loads but says `No patient profile found for your account.` - this page is patient-only, mistakenly exposed via the pharmacist's sidebar.

`AI Booking`, `Telemedicine`, `My Appointments`, `Calendar`. Loaded with no pharmacy context.

`Pharmacy module` (`/dashboard/pharmacy`) - the actual pharmacy page exists but is NOT linked in the pharmacist's sidebar. The pharmacist can reach it only by typing the URL. When opened, six tabs render: `Inventory`, `Low Stock`, `Expiring Soon`, `Movements`, `Returns`, `Transfers` (`Admin` additionally sees a seventh tab: `Valuation`). The Inventory table loads `42` batches with columns `Medicine`, `Batch #`, `Quantity`, `Expiry`, `Price`, `Location`, `Reorder`, `Actions`. The Actions column shows `Return` and `Transfer` buttons; an `Order from Supplier` chip appears on the one row where stock has reached the reorder level (`Amlodipine 5mg`, qty `10`).

Critical bugs in the Pharmacy page for the Pharmacist role:

- All tabs are inert. Clicking `Low Stock`, `Expiring Soon`, `Movements`, `Returns`, or `Transfers` does not change the rendered content. The URL changes (`?tab=low-stock`) but the same Inventory table remains.
- `+ Add Stock` button does nothing for Pharmacist - no dialog opens (yet for Admin the same button opens the Add Stock dialog).
- Row actions (`Return`, `Transfer`, `Order from Supplier`) all silently fail. No dialog opens, no API call, no toast.
- The Admin's Add Stock dialog (which is what the Pharmacist should be able to use) collects: Medicine (autocomplete), Batch #, Quantity, Unit Cost, Selling Price, Expiry Date, Supplier (free text!), Location, Reorder Level. Critical missing fields: `HSN` / `GST` class, manufacture date, pack size, units of measure, link to a Purchase Order / `GRN`, photo of label, barcode, controlled-drug schedule confirmation.

### 1.3 Cross-Module Observations

`Doctor` - prescription creation (`/dashboard/prescriptions` -> `Write Prescription`). The form has Patient (search), Appointment, Diagnosis (`ICD-10` search), Use Template, Medicines (Medicine name + Dosage + Frequency + Duration + Remove + `+ Add Medicine`), Advice/Notes, Follow-up Date, Save Prescription. The Medicine-name field autocompletes from the catalog but accepts free text - typing `RandomMed XYZ` shows `No matches` and yet the form allows save. The API confirms: `prescription.items[]` stores only `medicineName: string` with no `medicineId`, no batch link, no route of administration, no quantity to dispense, no max-daily-dose, no allergy / interaction check, no controlled-drug attestation. `refills: 0` is the default and there is no UI to set it. Two interacting drugs (`Warfarin 5mg + Metronidazole 400mg`) were saved on a single prescription (`e514f615-…`) with no warning surfaced anywhere - Metronidazole significantly potentiates warfarin and increases bleeding risk. This is a serious clinical decision support failure.

`Doctor` - prescription detail. Cards expand to show Medicine / Dosage / Frequency / Duration / Instructions plus Re-Print, Share via WhatsApp, Share via Email. Sharing buttons send the prescription externally; there is no consent flag, no audit of recipient phone / email, no `PHI` redaction step.

`Nurse` - Medication Administration (`/dashboard/medication-dashboard`). Page renders `No medications due`, with a single `All Wards` filter and a Refresh button. There is no schedule view, no `prn` (as-needed) handling, no missed-dose log, no double-check / second-nurse signoff for high-alert drugs, no link from a prescription to an `MAR` entry. The `/api/v1/medication-administration` endpoint returns `404` - the resource simply does not exist server-side.

`Reception` module. The sidebar lists `/dashboard/pharmacy`, `/dashboard/controlled-substances`, `/dashboard/purchase-orders`, `/dashboard/refunds`. The server denies access (`403` with role-specific toast), so the data is not actually exposed - but the menu being visible is an information-leak and a UX bug.

`Admin` module. Has the legitimate full set: Medicines (catalog with Add/Edit/Delete and Rx flag), Pharmacy (with Valuation tab), Purchase Orders (`Draft` / `Pending` / `Approved` / `Received` / `All`; `Submit` / `Cancel` / `Receive` actions), Suppliers (with `GST`, `Net-30/15/45` terms, `PO` count), Controlled Substance Register (`All Entries`, `Register by Medicine`, `Audit Report` tabs, `Export CSV`), Pharmacy Forecast (`90-day` demand prediction), Refunds, Insurance Claims, Audit Log (`4,928` entries, `1,095-day` retention, `IP`, free-text search). Many of these are functions a real pharmacist needs day-to-day but the system gates them behind `ADMIN`.

### 1.4 Data-Model Observations (from Intercepted APIs)

`medicines` row carries:

- `name`
- `genericName`
- `brand`
- `form`
- `strength`
- `category`
- `sideEffects`
- `contraindications`
- `prescriptionRequired`
- `pregnancyCategory`
- `isNarcotic`
- `schedule`
- `pediatricDoseMgPerKg`
- `maxDailyDoseMg`
- `scheduleClass`
- `requiresRegister`
- `patientInstructions`

This is rich and well-modelled, but none of these fields are surfaced in the prescription writing flow or the pharmacist's dispense flow. The data exists, the UI ignores it.

`pharmacyInventory` row carries:

- `medicineId`
- `batchNumber`
- `quantity`
- `unitCost`
- `sellingPrice`
- `expiryDate`
- `supplier` (string)
- `reorderLevel`
- `reorderQuantity`
- `location`
- `barcode`
- `recalled`
- `recalledAt`
- `recallReason`

Recall and barcode fields exist but no UI.

`prescriptions` row carries:

- `appointmentId`
- `patientId`
- `doctorId`
- `diagnosis`
- `advice`
- `followUpDate`
- `signatureUrl`
- `pdfUrl`
- `printed`
- `printedAt`
- `sharedVia`
- `sharedAt`
- `copiedFromId`
- `status` (`PENDING/…?`)
- `rejectionReason`
- `rejectedAt`
- `rejectedBy`
- `items[]`

There is no `dispensed`, `dispensedBy`, `dispensedAt`, `verifiedBy`, `pharmacistNotes`, `partialDispense`, `substitutionApprovedBy`, `linkedInvoiceId` - the schema cannot represent a pharmacist's work product.

`prescriptionItems` row carries:

- `medicineName`
- `dosage`
- `frequency`
- `duration`
- `instructions`
- `refills`
- `refillsUsed`

No `medicineId` (so no inventory `FK`), no route, no `quantityToDispense`, no `dispensedQuantity`, no `dispensedBatchIds`, no `unitsPerDose`.

`movements` row carries:

- `type` (`PURCHASE…`)
- `quantity`
- `createdAt`
- `notes`
- `inventory{batch, medicine}`

Schema does not capture `performedBy`, reason, `linkedPrescriptionId`, `linkedInvoiceId`.

### 1.5 Missing APIs (Observed via Probing)

`/api/v1/pharmacy/dispenses`, `/dispensing`, `/dispensing-queue`, `/refills`, `/pharmacy/refills`, `/pharmacy/orders`, `/pharmacy/expiring`, `/pharmacy/low-stock`, `/pharmacy/forecast`, `/medication-administration`, `/mar`, `/medicines/interactions`, `/refunds`, `/insurance-claims` - all return `404`. The forecast UI exists but its API endpoint is undocumented; the controlled-substance register UI exists but `/controlled-substances` returns `403` even for the pharmacist. The product is fundamentally inventory-only; the dispensing half of pharmacy is absent.

### 1.6 Inconsistent / Risky Behaviours

- Pharmacist sees a sidebar Bills link, but the route `403`s - the menu lies to the user.
- The Pharmacy URL exists but is hidden from the Pharmacist's sidebar - they can only reach it by typing it.
- Reception's sidebar advertises Pharmacy and Controlled-Register routes that the server then denies - same lying-menu pattern.
- Tab switches inside the Pharmacy page do not work for Pharmacist (and only partially for Admin via state, not URL).
- `Order from Supplier` chip appears on a low-stock row but performs no action.
- A prescription with two drugs that interact dangerously (`warfarin + metronidazole`) was saved with zero warning.
- The `medicineName` is free text on prescription items; a typo or hallucinated drug name will store and dispense as anything.
- `376` prescriptions exist but the status enum effectively has only two values (`Issued`, `Printed`) - the lifecycle is unmodelled.

## 2. Ideal Pharmacist Module - Product Requirements Document

### 2.1 Overview

The Pharmacist Module is the operational core that converts a clinician's prescription into a verified, safe, billed, dispensed, and auditable medication event for a patient - across `OPD`, `IPD`, `ER`, `Discharge`, and `Telemedicine` encounters - while keeping inventory, controlled-drug registers, supplier procurement, and finance synchronised in real time.

### 2.2 Business Goals

The module must reduce medication errors to near-zero through hard validation; eliminate manual stock reconciliation; ensure `100%` controlled-drug compliance with Schedule `H/H1/X` registers; cut pharmacy revenue leakage by tying every dispense to a billed line item; provide a single source of truth for medication history that doctors, nurses, pharmacists, and patients all consume; and surface predictive low-stock and expiry alerts before clinical impact occurs.

### 2.3 User Roles & Responsibilities

A Pharmacist verifies, dispenses, counsels, manages stock, runs the controlled register, raises purchase orders, and processes returns. A Pharmacy Manager approves `PO`s over a threshold, signs off on stock adjustments, runs daily / monthly closing, and authorises refunds. An Inventory Officer receives goods (`GRN`), labels and rack-locates, and performs cycle counts. A Doctor prescribes (and is the only role that may prescribe controlled substances). A Nurse administers (records on the `MAR`) and may request a stat dose from pharmacy. Reception / Cashier collects payment for `OPD` pharmacy bills and prints the dispense receipt - but never has direct inventory access. Patients view history, download prescriptions, request refills, and pay online. Admin sets policy (markup, `GST`, locations, formulary), manages suppliers and contracts, and reviews audit logs.

### 2.4 Functional Requirements

The Dispensing Queue is the pharmacist's home screen. It lists all prescriptions in states `Pending Verification`, `Pending Payment`, `Pending Pickup`, `Partially Dispensed`, `On Hold`, and `Refill Requested`, sorted by `SLA` (`ER` first, then `OPD` by ticket time, `IPD` by ward priority). Each card shows patient name + `MR` number + age + weight + known allergies (red badge) + diagnosis + prescriber + issue time + medicine count + estimated total + a `Verify` CTA.

Prescription verification opens a side-by-side view: prescriber's items on the left, dispenseable mapping on the right. For each item the pharmacist confirms `medicineId`, strength / form, route, dose, frequency, duration, total quantity to dispense, batch selection (`FEFO` - first expiry first out), and substitute (if formulary substitution rules apply). The system computes total quantity from frequency × duration × dose-per-administration and pre-fills it; the pharmacist may adjust within policy bounds. A consolidated clinical-decision-support panel shows real-time drug-drug interactions (severity-graded), drug-allergy clashes, duplicate therapy across the patient's active prescriptions, dose-out-of-range vs `maxDailyDoseMg` and `pediatricDoseMgPerKg`, pregnancy / lactation contraindications, and renal / hepatic adjustment hints.

Dispense locks a transaction: it decrements the chosen batches by the chosen quantity (atomic, with optimistic concurrency control on `inventory.version`), creates a Dispense record (`FK` to prescription, items, batches, `pharmacistId`, `dispensedAt`, signature), generates a sale invoice line for each item with applicable `GST`, prints a label per item (patient, drug, strength, dose, frequency, total, expiry batch, warnings, pharmacist initials), and updates prescription status to `Dispensed` or `Partially Dispensed`.

Partial dispense is a first-class state. When stock is insufficient, the pharmacist dispenses what is available, the system creates a backorder for the remainder, notifies the patient when stock arrives, and reuses the original prescription on the second visit without re-prescribing.

Refill management is queue-driven. When a patient requests a refill, the system checks `refillsRemaining > 0`, that the prescription is not expired (configurable validity, for example `30 days` non-`CD`, `7 days` `CD`), that the medication is not a Schedule `X` drug (no refills allowed), and routes to the pharmacist queue. The pharmacist may approve, deny with reason, or escalate to the prescriber for reauthorisation. Each refill is its own dispense record.

Return / refund is initiated within a configurable window (for example `24 h`) for unopened, non-controlled, non-cold-chain items. The system reverses the inventory movement (back into the original batch - only if not expired, otherwise quarantine), creates a credit note or refund against the original invoice, and writes an audit entry. Controlled-drug returns require pharmacy-manager approval and a witnessed entry in the controlled register.

Substitution is allowed only when:

- the prescriber has not selected `brand only`
- the substitute is on the approved formulary
- the patient consents (audit-captured)
- bioequivalence is documented

The system prints both names on the label.

Inventory management captures batch number, manufacture date, expiry date, pack size, unit cost, `MRP`, `GST` / `HSN`, supplier, `GRN` number, rack location, barcode / `QR`, and recall flag. Stock movements have explicit types (`PURCHASE`, `GRN`, `DISPENSE`, `RETURN-IN`, `RETURN-OUT`, `TRANSFER-OUT`, `TRANSFER-IN`, `ADJUSTMENT-LOSS`, `ADJUSTMENT-GAIN`, `EXPIRY-WRITE-OFF`, `RECALL-WRITE-OFF`, `SAMPLE`, `DAMAGE`) with mandatory reason, `performedBy`, `witnessedBy` (for `CD`), and `linkedDocumentId` (`PO` / `Rx` / `GRN`).

Controlled-substance handling enforces a witnessed dispense (two staff `ID`s scanned), captures patient `ID` proof type and number on Schedule `H1/X`, writes to the immutable Controlled Register with sequential record number, and reconciles physical count to register at every shift handover. Any discrepancy locks the affected `SKU` and raises a `P1` alert to the Pharmacy Manager.

Procurement. Reorder logic auto-creates draft `PO`s when on-hand + on-order < `reorderLevel` for `reorderLeadTime` days of forecast demand. The Pharmacist can convert a draft to a submitted `PO`; supplier acknowledges; goods arrive and are received against the `PO` with mandatory mismatch reason if quantity / expiry differs; `GRN` posts to inventory; supplier invoice is matched 3-way (`PO` ↔ `GRN` ↔ invoice); accounts payable picks it up.

Multi-location. Stock is tracked per pharmacy (`Main`, `IPD` satellite, `ER` cabinet, `OT` crash cart). Transfer flow: requestor -> approver -> in-transit -> received-with-quantity-check -> inventory updated at destination, decremented at source. Variance triggers a `P2` alert.

Alerts and notifications. Low-stock (configurable per `SKU`), reorder-due, expiry-in-`90/60/30/7` days, recall received, controlled-register variance, `PO` overdue, supplier complaint. Notifications fan out to in-app, email, `SMS`, and push.

Reports. Daily sales by category, `GST` summary, dispense-by-doctor, dispense-by-patient, top movers, slow movers, near-expiry, write-off, controlled-substance register, supplier performance, margin by `SKU`, refill compliance, `MAR` adherence (hand-off to nurse module), insurance claim accuracy.

Patient-facing. The patient app shows current and past prescriptions, refill button, pickup status, pharmacy bill and pay-now, downloadable PDF, dose reminders, side-effect leaflet (from `medicines.patientInstructions`).

### 2.5 Non-Functional Requirements

The dispense API must commit in `< 500 ms p95`. Inventory deductions must be strongly consistent - concurrent dispenses against the same batch must serialise (`DB`-level row lock or optimistic version). The system must remain available `24/7` for `ER` cabinets (offline mode with deferred sync acceptable for `ER` cabinet only, with conflict resolution on reconnect). `PHI` must be encrypted at rest (`AES-256`) and in transit (`TLS 1.3`). Audit log entries must be append-only and tamper-evident (hash-chained). Backups every `4 hours`, `RPO <= 4 h`, `RTO <= 1 h`. Horizontal scalability to `50` concurrent pharmacists, `10,000` daily dispenses, `100,000` `SKU`s across `20` locations. Localisation: English + at least one regional Indian language for patient-facing labels.

### 2.6 User Stories (Representative)

As a pharmacist, I want all unfilled prescriptions to appear in a single queue sorted by urgency so I do not miss an `ER` order. As a pharmacist, I want the system to block me from dispensing a drug a patient is allergic to, even if the doctor wrote it, so I can call the doctor before harm occurs. As a pharmacist verifying warfarin, I want to see metronidazole in the patient's active list with a red interaction banner so I can intervene. As a pharmacist, I want to scan a batch barcode and have the inventory auto-fill, so I do not pick the wrong batch. As a pharmacy manager, I want to approve any stock adjustment over `5%` variance so shrinkage cannot be hidden. As a doctor, I want to know whether the medicine I'm about to prescribe is in stock so I do not send the patient on a wild-goose chase. As a nurse, I want the `IPD MAR` to populate automatically from the doctor's prescription and the pharmacy's dispense so I administer exactly what was prescribed and dispensed. As a patient, I want to see what was dispensed, what it cost, and request a refill from my phone.

### 2.7 Workflow Definitions

`OPD`: Doctor prescribes -> prescription enters Pharmacy Queue (status `PENDING_VERIFY`) -> pharmacist verifies + `CDS` check -> pharmacist generates bill -> cashier collects payment -> pharmacist scans batches and dispenses -> label printed -> patient counselled -> status `DISPENSED`.

`IPD`: Doctor prescribes -> ward stock check -> pharmacy issues to ward (transfer, not sale) -> nurse acknowledges receipt at ward stock -> nurse administers per `MAR` schedule -> admin charge posts to `IP` bill at end of shift.

`ER`: stat orders bypass billing pre-payment, post-bill at discharge.

`Discharge`: `TTA` (To Take Away) prescription consolidates inpatient meds, pharmacist verifies and dispenses with counselling.

### 2.8 Module Dependencies

Pharmacist depends on:

- Doctor (prescription source)
- Patient / `EMR` (allergies, weight, age, renal / hepatic flags)
- Inventory & Suppliers (batches, `PO`s, `GRN`)
- Billing (invoices, `GST`, refunds)
- Insurance (preauth and claim mapping)
- Nurse / `MAR` (`IPD` administration)
- Audit (every action)
- Notification (alerts)
- Reception (`OPD` walk-in handoff)
- AI Forecast (reorder)
- Reports / Analytics (`KPI`s)
- `ABDM` / `FHIR` (e-Rx interoperability)

### 2.9 UI/UX Requirements

The pharmacist landing page is the Dispensing Queue with search, filters (status, ward, doctor, drug), keyboard-shortcut driven (no mouse needed for dispense). Verification screen is two-pane (`Rx` vs Dispense plan) with a sticky `CDS` panel at right. All quantitative inputs default-fill from rules so the pharmacist mostly confirms, not types. Warnings are colour-graded (red blocking, amber consent-needed, blue advisory). Barcode scanner fires medicine-pick and batch-pick events. Print preview before commit. Dark mode for night-shift `ER` pharmacy.

### 2.10 Permissions Matrix

| Capability | Patient | Reception | Nurse | Doctor | Pharmacist | Pharmacy Mgr | Admin |
| --- | --- | --- | --- | --- | --- | --- | --- |
| View own prescription | ✅ | - | - | - | - | - | - |
| Write prescription | - | - | - | ✅ | - | - | - |
| Write CD (Sched X) | - | - | - | ✅ (with DEA ID) | - | - | - |
| View dispensing queue | - | - | view-only IPD | view own | ✅ | ✅ | ✅ |
| Dispense | - | - | - | - | ✅ | ✅ | - |
| Override CDS warning | - | - | - | - | with reason+sign | ✅ | - |
| Add stock | - | - | - | - | ✅ | ✅ | ✅ |
| Stock adjustment > 5 % | - | - | - | - | request | ✅ approve | ✅ |
| View inventory | - | - | ward stock only | own ward | ✅ | ✅ | ✅ |
| Controlled register | - | - | view IPD-CD | view own Rx | ✅ entry | ✅ approve | ✅ read |
| Create PO | - | - | - | - | draft | ✅ submit | ✅ |
| Approve PO > ₹X | - | - | - | - | - | ✅ | ✅ |
| Refund | - | - | - | - | request | ✅ approve | ✅ |
| Manage suppliers | - | - | - | - | view | ✅ | ✅ |
| View MAR | - | - | ✅ | view | ✅ (linked Rx) | ✅ | ✅ |
| Reception sees pharmacy menu | - | must remove | - | - | - | - | - |

### 2.11 API Expectations (Representative Contracts)

`GET /api/v1/pharmacy/dispense-queue?status=PENDING_VERIFY&ward=ER` returns prescriptions enriched with patient allergy / weight / age and live-stock-availability per item.

`POST /api/v1/pharmacy/dispenses` accepts:

```json
{
  "prescriptionId": "...",
  "items": [
    {
      "prescriptionItemId": "...",
      "medicineId": "...",
      "batchAllocations": [
        {
          "batchId": "...",
          "qty": 0
        }
      ],
      "substitutionFor": "..."
    }
  ],
  "paymentRef": "...",
  "overrides": [
    {
      "warningCode": "...",
      "reason": "..."
    }
  ]
}
```

It returns the created dispense plus invoice.

`POST /api/v1/pharmacy/refills` accepts `{prescriptionItemId}` and validates against `refills` / `refillsUsed`.

`POST /api/v1/pharmacy/inventory/adjustments` requires reason and triggers approval if `delta >= 5 %`.

`GET /api/v1/medicines/:id/interactions?with=…` returns interaction graph.

`GET /api/v1/patients/:id/allergies` is required input to verification.

All write endpoints are idempotent via `Idempotency-Key` header. All require `CSRF` token (already present in cookie `medcore_csrf`).

### 2.12 Validation Rules

- Quantity to dispense must be `<=` remaining authorised quantity (`initial + refills × per-cycle`).
- Total dose per day must be `<= medicine.maxDailyDoseMg` unless an override with reason is recorded.
- Pediatric dose (`age < 18` or weight-flag) must compute via `pediatricDoseMgPerKg × weightKg` with a hard ceiling.
- Expiry date `>= today + 30 days` for outpatient dispense (configurable).
- Batch quantity available `>= allocation`.
- Controlled-drug dispense requires patient `ID` type + number, second staff witness, and prescriber's `CD` registration on the `Rx`.
- Substitution requires patient consent flag.
- Free-text medicine names are prohibited - every `presc`
