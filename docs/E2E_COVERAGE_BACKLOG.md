# E2E Test Coverage Backlog

> Generated: 2026-05-02. **Status update 2026-05-03:** several
> top-priority routes called out as zero-coverage have since shipped
> dedicated specs — `e2e/bloodbank.spec.ts` (`9843648`),
> `e2e/ambulance.spec.ts` (`0c94cbb`), `e2e/pediatric.spec.ts`
> (`0715f27`) — and 5 brittle locator patterns across 8 specs got
> tightened in `e2ec599`. Companion non-e2e closure:
> [`archive/TEST_GAPS_2026-05-03.md`](archive/TEST_GAPS_2026-05-03.md).
> Re-verify any individual line below before picking up; counts are
> 2026-05-02-as-of, not refreshed wholesale.
>
> Scope: Playwright E2E suite under `e2e/` vs. app routes under `apps/web/src/app/`.
> Source audit: 40 existing spec files reviewed against 132 page.tsx routes.

This document is a living backlog of E2E coverage gaps and proposed work. Update the
status column as specs are added. Routes/flows referenced here are derived from
the current `apps/web/src/app/**/page.tsx` tree — re-verify before picking up an
item, since the route layout drifts.

## Closure log since this audit was generated (2026-05-02 → 2026-05-03)

| Item from §2 / §5 | Status | Commit |
|---|---|---|
| `/dashboard/pediatric` (§2.1, §5 P-list note) — full flow spec | ✅ Closed | `0715f27` (e2e/pediatric.spec.ts, 5 cases incl. growth-chart drilldown + UIP/IAP immunizations) |
| `/dashboard/bloodbank` — clinical-safety flow | ✅ Closed | `9843648` (e2e/bloodbank.spec.ts, 5 cases incl. ABO/Rh cross-match safety + expired-unit exclusion) |
| `/dashboard/ambulance` — dispatch lifecycle | ✅ Closed | `0c94cbb` (e2e/ambulance.spec.ts, 5 cases — full DISPATCHED → COMPLETED + fuel logs + RBAC) |
| `/dashboard/pediatric/[patientId]` — chart drilldown | ✅ Closed | included in `0715f27` |
| Brittle locator patterns (§3 across multiple specs) | ✅ Tightened | `e2ec599` (5 patterns across 8 specs/pages — preempts ambulance-style locator-drift bugs) |
| Visual regression baselines for 4 specs (§4.4) | ✅ Closed | `d150ab2` (Chromium) + `fb55fe6` (WebKit) |
| WebKit auth-race instability (cross-browser, §4 implicit) | ✅ Cleared | `8d7fa94` v1 → `1d204d7` v2 → `febe0aa` v3 (release.yml run 25257762655 fully green) |

Beyond the backlog: a parallel **non-e2e gap-closer pass** (Sessions 1, Wave A, Wave C, low-priority) shipped ~510 new test cases on 2026-05-03 across validation schemas, insurance-claims, AI services, controlled-substances, FHIR Bundle/search, HL7v2 parser/roundtrip/segments, bloodbank cross-match, ambulance state machine, pharmacy + Rx-rejection, patient-data-export, and 5 honorable mentions (forecast / predictions / audit-archival / notification orchestrator / Razorpay idempotency). See `archive/TEST_GAPS_2026-05-03.md`.

---

## 1. Suite snapshot

| Metric | Count |
|---|---|
| Spec files | 40 |
| App page.tsx routes | 132 |
| Routes with zero E2E coverage | ~40 |
| Roles exercised | 7 (admin, doctor, nurse, reception, patient, lab-tech, pharmacist) |
| Playwright projects | smoke, regression, full, full-webkit |

### Specs by area
- **Auth/RBAC:** auth, rbac-matrix, rbac-negative
- **Patient flow:** patient, patient-detail, reception, appointments, quick-actions
- **Clinical:** doctor, nurse, scribe-flow, emergency-er-flow, er-triage, ot-surgery, admissions-mar
- **Diagnostics:** lab-tech, lab-explainer
- **Pharmacy:** pharmacist, pharmacy-forecast, adherence
- **Finance:** billing-cycle, refunds-discounts, insurance-preauth
- **AI:** ai-smoke, ai-analytics, predictions, letters
- **Admin:** admin, admin-ops, calendar-roster, reports
- **Telemedicine:** telemedicine-patient
- **Compliance/Interop:** abdm-consent
- **Cross-cutting:** cross-cutting, edge-cases, marketing-pages
- **Quality bars:** a11y, visual

### Roles exercised (spec count)
- ADMIN: 18
- DOCTOR: 10
- PATIENT: 8
- RECEPTION: 6
- NURSE: 5
- LAB_TECH: 1
- PHARMACIST: 1

---

## 2. Routes with ZERO coverage

Grouped by domain. Each entry below should become a spec or be merged into an existing one.

### 2.1 Patient & Clinical
- `/dashboard/patients` — list page (search/filter/sort/bulk actions)
- `/dashboard/patients/[id]` — full chart from doctor's perspective (allergies, imaging, med history)
- `/dashboard/patients/[id]/problem-list` — add/edit/delete problems
- ~~`/dashboard/patients/register` — new patient registration form~~ ✅ closed (6 tests; `e2e/patients-register.spec.ts`)
- `/dashboard/prescriptions/new` — Rx creation form (only smoke-touched today)
- ~~`/dashboard/pediatric` — pediatric ward listing~~ ✅ closed `0715f27`
- ~~`/dashboard/pediatric/[patientId]` — pediatric chart (age-specific dosing, growth charts)~~ ✅ closed `0715f27`
- ~~`/dashboard/symptom-diary` — patient-reported symptom logging~~ ✅ closed (PATIENT happy path + 2 RBAC bounces + staff banner; `e2e/symptom-diary.spec.ts`)
- `/dashboard/telemedicine/waiting-room` — waiting-room UI (only mocked join tested)

### 2.2 Inventory & Supply Chain
- ~~`/dashboard/medicines` — medicine catalog~~ ✅ closed (ADMIN/DOCTOR/NURSE/PATIENT access matrix + ADMIN-only Add CTA + search re-fetch + ADMIN create round-trip; `e2e/medicines.spec.ts`)
- ~~`/dashboard/pharmacy` — stock levels, reorder, expiry alerts (only landing tested)~~ ✅ deepened (tabs/search/filter coverage; `e2e/pharmacy.spec.ts`)
- `/dashboard/purchase-orders` — PO list
- `/dashboard/purchase-orders/[id]` — PO detail / approval
- ~~`/dashboard/assets` — equipment register~~ ✅ closed (6 tests; `e2e/assets.spec.ts`)
- ~~`/dashboard/suppliers` — supplier directory~~ ✅ closed (ADMIN/RECEPTION happy paths + search re-fetch + Add-Supplier modal + DOCTOR/PATIENT 403 at GET /suppliers; `e2e/suppliers.spec.ts`)
- `/dashboard/controlled-substances` — substance log entries (only page-load tested)

### 2.3 Billing & Finance
- `/dashboard/billing/[id]` — line-item editing (only happy-path create tested)
- `/dashboard/billing/patient/[patientId]` — bulk patient billing
- `/dashboard/payment-plans` — installment plan setup
- `/dashboard/bill-explainer` — explanation workflow (only smoke-visited)
- ~~`/dashboard/budgets` — budget tracking~~ ✅ closed (6 tests; `e2e/budgets.spec.ts`)
- ~~`/dashboard/expenses` — expense entry~~ ✅ closed (6 tests; `e2e/expenses.spec.ts`)
- `/dashboard/discount-approvals` — request side (approval side covered)

### 2.4 HR, Payroll, Scheduling
- `/dashboard/users` — edit/deactivate/permission matrix (create only is covered)
- ~~`/dashboard/payroll` — salary, payslip, deductions~~ closed 2026-05-03 by `e2e/payroll.spec.ts` (7 tests; ADMIN chrome + edit + calculate + slip + overtime tab + DOCTOR/NURSE bounces)
- `/dashboard/my-leaves` — employee leave-request submission
- `/dashboard/my-activity` — personal activity log
- ~~`/dashboard/holidays` — holiday calendar~~ — closed 2026-05-03 by `e2e/holidays.spec.ts` (ADMIN calendar mgmt + non-ADMIN bounces)
- ~~`/dashboard/leave-calendar` — calendar view (approval side covered)~~ closed 2026-05-03 by `e2e/leave-calendar.spec.ts` (6 tests; ADMIN chrome + legend + month nav + DOCTOR/NURSE/PATIENT bounces)
- `/dashboard/schedule` — staff schedule
- ~~`/dashboard/doctors` — doctor directory~~ closed 2026-05-03 by `e2e/doctors.spec.ts` (6 tests; ADMIN happy/search/modal + DOCTOR/NURSE/PATIENT bounces)
- `/dashboard/doctors/[id]` — doctor profile/schedule

### 2.5 Communications
- ~~`/dashboard/notifications` — inbox~~ closed 2026-05-03 by `e2e/notifications.spec.ts` (6 tests; ADMIN/PATIENT/NURSE chrome + preferences toggle + LAB_TECH/PHARMACIST direct-URL accessibility)
- `/dashboard/notifications/delivery` — delivery status
- ~~`/dashboard/broadcasts` — bulk announcement~~ closed 2026-05-03 by `e2e/broadcasts.spec.ts` (7 tests; ADMIN chrome + compose-send + audience picker + empty-form gate + DOCTOR/NURSE/PATIENT bounces)
- `/dashboard/notification-templates` — template config
- ~~`/dashboard/complaints` — complaint workflow~~ closed 2026-05-03 by `e2e/complaints.spec.ts` (6 tests; ADMIN chrome + modal + validation toast + tab switch + RECEPTION reach + PATIENT/LAB_TECH 403 on list)
- `/dashboard/chat` — inter-department messaging

### 2.6 Analytics & Reporting
- `/dashboard/reports` — custom report creation (only crash-regression tested)
- `/dashboard/reports/scheduled` — execution + delivery (only setup tested)
- `/dashboard/scheduled-reports` — same; verify dedup vs above
- `/dashboard/analytics/reports` — analytics export
- ~~`/dashboard/census` — bed census~~ closed 2026-05-03 by `e2e/census.spec.ts` (6 tests; ADMIN chrome + Daily/Weekly toggle + DOCTOR/NURSE reach + PATIENT/LAB_TECH 403-without-crash)
- ~~`/dashboard/queue` — queue priority/reassignment (page-load only)~~ ✅ deepened (priority/reassign + RBAC; `e2e/queue.spec.ts`)

### 2.7 Admissions & Wards
- `/dashboard/admissions` — admit form (list-touched only)
- `/dashboard/admissions/[id]` — admission detail, MAR progression, discharge
- ~~`/dashboard/wards` — bed assignment, transfer~~ closed 2026-05-04 by `e2e/wards.spec.ts` (7 tests; ADMIN chrome/add-ward modal/forecast tab + NURSE/RECEPTION no-CTA + PATIENT/LAB_TECH page-accessible no-CTA)
- `/dashboard/capacity-forecast` — forecast editing (smoke-visited)

### 2.8 AI features
- `/dashboard/ai-kpis` — KPI dashboard configuration
- `/dashboard/ai-booking` — AI-assisted booking
- `/dashboard/ai-fraud` — fraud-case investigation (smoke-visited)
- `/dashboard/agent-console` — AI agent monitoring

### 2.9 Account & Profile
- `/dashboard/profile` — profile view/edit
- `/dashboard/account` — email/password/2FA
- `/dashboard/workspace` — workspace config (smoke-visited)
- `/dashboard/workstation` — task assignment (RBAC-only tested)

### 2.10 Public / Unauthenticated
- `/register` — public patient registration
- `/forgot-password` — password reset
- `/verify/rx/[id]` — valid Rx verification path (only invalid-id edge case tested)
- `/feedback/[patientId]` — anonymous patient feedback
- `/display` — public display board

### 2.11 Multi-tenant
- `/dashboard/tenants` — tenant list (touched, no isolation verification)
- `/dashboard/tenants/[id]/onboarding` — onboarding flow

### 2.12 Other
- `/dashboard/referrals` — create/accept/reject (page-load only)
- `/dashboard/calendar` — event creation, drag, conflict detection
- `/dashboard/my-schedule` — shift claim, unavailability
- `/dashboard/insurance-claims` — claim submission/appeal/reconciliation (smoke only)
- ~~`/dashboard/blood-bank` and `/dashboard/bloodbank`~~ ✅ flow covered `9843648` (still: verify route dedup; only requisition was touched in OT spec)
- `/dashboard/operating-theaters` and `/dashboard/operating-theatres` — verify dedup
- `/dashboard/medication`, `/dashboard/medication-dashboard` — overlap with admissions-mar; clarify scope
- `/dashboard/lab-intel` — lab-intelligence dashboards (page-load only)
- `/dashboard/fhir-export` — full export workflow (smoke only)
- `/dashboard/audit` — audit log filtering (light coverage)
- `/dashboard/certifications` — staff certification tracking
- `/dashboard/immunization-schedule` — vaccination schedule
- `/dashboard/antenatal`, `/dashboard/antenatal/[id]` — antenatal care
- ~~`/dashboard/ambulance` — dispatch (touched in ER flow only)~~ ✅ closed `0c94cbb` (full DISPATCHED → COMPLETED lifecycle + fuel logs + RBAC)
- `/dashboard/visitors` — visitor log

---

## 3. Coverage gaps WITHIN existing specs

For each spec already in the suite, the flows below are not tested and should be added.

### billing-cycle.spec.ts
- Partial refund (only full refund covered)
- Invoice line-item edit/delete after creation
- Overpayment + credit balance handling
- Credit-note workflow
- GST audit / correction scenarios
- Aging report interaction (paid/unpaid filtering)

### lab-tech.spec.ts
- Result approval / sign-off workflow
- Out-of-range value flagging + escalation
- Repeat-test ordering
- Result history / amendment trail
- Batch result entry

### pharmacist.spec.ts
- Rx rejection workflows (contraindication, OOS)
- Substitution request handling
- Refill management
- Drug interaction warnings
- Inventory adjustments (count, expiry write-off)

### doctor.spec.ts
- Patient chart review depth (history, imaging, prior orders)
- Diagnosis / assessment entry
- Disposition / discharge from outpatient
- Clinical decision-support (allergy, DDI, dosing)
- Followup scheduling

### emergency-er-flow.spec.ts
- Reassessment + triage-level update
- Disposition changes (admit/discharge/transfer)
- Overflow / waitlist branching
- Fast-track vs. standard path
- ER discharge summary + referral

### ot-surgery.spec.ts
- Anesthesia notes / sign-off
- Operative report entry
- Post-op orders (meds, restrictions, followup)
- Swab / implant tracking (regulatory)
- OT resource conflict detection

### telemedicine-patient.spec.ts
- Call quality / reconnection
- Post-consult prescription fill / delivery
- Followup scheduling from call end
- Recording consent + archive
- Remote-consult payment / settlement

### admissions-mar.spec.ts
- Admit form (reason, type, bed assignment)
- Daily MAR (verify, dispense, skip, modify)
- Vitals charting integration
- Discharge planning + meds reconciliation
- Inter-ward transfer

### admin.spec.ts
- Bulk user import
- Fine-grained permission matrix assignment
- Role-change with effective date
- Deactivation + reactivation
- SSO/LDAP provisioning (if applicable)
- Password reset workflow

### patient-detail.spec.ts
- Allergy / intolerance entry + severity
- Medication reconciliation
- Advance directives
- Insurance details
- Caregiver / family contacts
- MRN merge / duplicate resolution

### admin-ops + calendar-roster
- Custom date-range + export
- Drill-down (summary → detail)
- Period-over-period comparison
- KPI threshold configuration

### rbac-matrix.spec.ts
- Attribute-based checks (doctor sees only own patients)
- Delegation / temporary role assumption
- Data ownership (patient sees only own records)
- Cross-tenant isolation (see §4.7)

### edge-cases.spec.ts
- Concurrent-edit conflict
- Network timeout retry
- Large-payload handling (bulk CSV, large file upload)
- Memory / perf under repeated ops

---

## 4. Cross-cutting gaps

### 4.1 Test infrastructure
- No seeders for: users, leave-requests, vendors, medicines, custom reports, holidays, insurance companies (only patient/appointment/admission/lab-order/telemedicine exist)
- No DB-reset fixture between tests — audit-log and financial state leak across runs
- No teardown for created records — seeded patients accumulate

### 4.2 Mobile / responsive
- `cross-cutting.spec.ts` tests mobile drawer on `/dashboard` only
- Missing: mobile viewport for appointments, billing, prescriptions
- Missing: touch events (tap, long-press, swipe)
- Missing: mobile-specific error states (network degradation)
- Missing: bottom-sheet vs. modal rendering

### 4.3 Accessibility
- `a11y.spec.ts` runs axe on 27 pages — strong baseline
- Missing: screen-reader interaction tests
- Missing: keyboard-only navigation for date-pickers, multi-step forms
- Missing: high-contrast mode
- Missing: font scaling (110%, 150%)

### 4.4 Visual regression
- `visual.spec.ts` has 4 baselines (login, dashboard, invoice, not-authorized)
- Missing: appointment booking, billing summary
- Missing: error states (form validation, API error banner)
- Missing: dark-mode variants
- Missing: cross-browser baselines (only Chromium baselines committed)

### 4.5 Backend / integration
- AI endpoints stubbed via `stubAi`
- Missing: real Sarvam transcribe, billing-explanation, fraud-detection, capacity-forecast
- Missing: real ABDM/FHIR export
- Missing: Razorpay, WhatsApp coverage clarity (gated by `E2E_FULL`)

### 4.6 Performance
- Zero performance specs
- Missing: page-load under 3G/4G throttling
- Missing: large-list rendering (1000+ patients, 500+ lab results)
- Missing: concurrent booking same slot
- Missing: long-session memory leak detection

### 4.7 Negative paths
- Most specs are happy-path
- Missing: API 500/503 retry verification
- Missing: offline + sync-on-reconnect
- Missing: form failure messaging (validation, duplicate, server error)
- Missing: file-upload failures (format, size, AV scan)
- Missing: navigate-away mid-form

### 4.8 File operations
- Zero coverage for upload/download
- Missing: patient document upload (reports, images, PDFs)
- Missing: imaging upload (X-ray, ultrasound)
- Missing: report export (PDF/Excel/CSV)
- Missing: bulk import (CSV patient, Rx templates)
- Missing: virus scan feedback
- Missing: attachment preview / watermarking

### 4.9 Real-time / WebSocket
- Telemedicine signaling is mocked, not real
- Missing: notification push (appointment reminder, new order alert)
- Missing: live queue updates
- Missing: audit-log streaming for admins

### 4.10 Print / PDF
- Zero coverage
- Missing: Rx print-to-PDF
- Missing: invoice/bill print layout
- Missing: medical certificate / discharge summary print
- Missing: batch print
- Missing: print watermarking ("TEST RESULT — NOT FOR CLINICAL USE")

### 4.11 Multi-tenant isolation
- `admin-ops.spec.ts` touches tenants page; no isolation verification
- Missing: data leakage test (tenant A cannot see tenant B's patients)
- Missing: audit-log separation by tenant
- Missing: feature-flag / plan-based gating per tenant

### 4.12 Mobile app (apps/mobile)
- Zero E2E coverage
- Missing: mobile auth, patient portal, push notifications
- Missing: offline mode + sync-on-reconnect
- Missing: biometric auth (if implemented)

### 4.13 Internationalization
- Zero coverage
- Missing: language switching + persistence
- Missing: RTL layout (Arabic, Hindi if supported)
- Missing: locale-specific date/time/number formatting

---

## 5. Prioritized backlog (top 10)

Ranked by user-impact × current coverage gap. Each item lists a proposed spec
filename and the core scenarios it should cover.

### P1 — Billing line-item editing & credit notes
- **File:** `e2e/billing-line-items.spec.ts`
- **Why:** Revenue-critical; line-item errors cascade to reconciliation, disputes, audits
- **Scenarios:**
  - Edit line-item quantity → invoice total recomputes
  - Delete line-item → audit entry written
  - Add line-item to existing invoice (pre-payment vs. post-payment)
  - Issue credit-note against paid invoice → balance updates
  - Partial refund (amount < invoice total)
  - Overpayment → credit balance carry-forward
  - Period-locked invoice → edit blocked

### P2 — Prescription lifecycle (clinical safety)
- **File:** `e2e/prescription-lifecycle.spec.ts`
- **Why:** Clinical safety; Rx errors cause direct patient harm
- **Scenarios:**
  - Doctor creates Rx via `/dashboard/prescriptions/new` (full form)
  - Drug-allergy warning blocks contraindicated med
  - DDI warning surfaces interactions
  - Doctor edits active Rx → prior version preserved in history
  - Doctor cancels Rx → patient + pharmacist notified
  - Refill request from patient → doctor approval
  - Pharmacist rejects Rx with reason → patient sees status

### P3 — Pharmacy inventory & stock management
- **File:** `e2e/pharmacy-inventory.spec.ts`
- **Why:** Stockouts delay treatment; expired stock is patient safety + regulatory
- **Scenarios:**
  - View `/dashboard/medicines` catalog with stock levels
  - Low-stock threshold triggers reorder suggestion
  - Expiring-soon medicines surfaced on pharmacy dashboard
  - Dispense-after-expiry blocked at pharmacy
  - Stock count adjustment with reason + audit
  - Purchase order creation → receive → stock incremented
  - Consumption trend visible per medicine

### P4 — Doctor full chart review
- **File:** `e2e/doctor-chart-review.spec.ts`
- **Why:** Diagnostic quality depends on complete chart visibility
- **Scenarios:**
  - Doctor opens `/dashboard/patients/[id]` → sees demographics, allergies, problem list
  - Imaging panel shows prior X-rays / ultrasounds with viewer
  - Lab history with trend charts (e.g. HbA1c over time)
  - Active medication list with start/stop dates
  - Allergy entry: add severity, type, reaction
  - Medication reconciliation across encounters
  - Caregiver / family contact CRUD

### P5 — Admission → MAR → Discharge end-to-end
- **File:** `e2e/admission-discharge-flow.spec.ts`
- **Why:** Inpatient care drives major revenue + safety risk surface
- **Scenarios:**
  - Reception fills admit form → bed assignment from `/dashboard/wards`
  - Doctor enters admit orders (meds, vitals frequency, diet)
  - Nurse charts vitals + administers MAR (verify, dispense, skip with reason)
  - Doctor updates disposition (continue / transfer / discharge)
  - Inter-ward transfer with bed re-assignment
  - Discharge summary generation with meds reconciliation
  - Post-discharge followup auto-scheduled
  - Length-of-stay reflected in census + analytics

### P6 — Custom reports creation, scheduling, export
- **File:** `e2e/reports-custom.spec.ts`
- **Why:** Hospital admins depend on reports for KPIs, compliance, budgeting
- **Scenarios:**
  - Create report at `/dashboard/reports` with date range + department + metric filters
  - Save report definition for reuse
  - Schedule recurring delivery (daily/weekly/monthly) with email recipients
  - Execute report on demand → CSV / Excel / PDF export
  - View execution history + failures at `/dashboard/reports/scheduled`
  - Re-run failed schedule

### P7 — HR ops: leave requests, payroll, bulk user mgmt
- **File:** `e2e/hr-operations.spec.ts`
- **Why:** Operational continuity, payroll compliance, shift-hour tracking
- **Scenarios:**
  - Employee submits leave request via `/dashboard/my-leaves`
  - Manager approves/rejects → notification flow
  - Bulk-import staff via CSV at `/dashboard/users`
  - Permission matrix assignment (fine-grained RBAC)
  - Role change with effective date
  - Deactivation + reactivation
  - Payroll run at `/dashboard/payroll` → payslip generation
  - Shift conflict detection during scheduling

### P8 — Insurance claims (post-treatment)
- **File:** `e2e/insurance-claims.spec.ts`
- **Why:** Revenue realization; preauth is covered but claims aren't
- **Scenarios:**
  - Submit claim post-treatment from `/dashboard/insurance-claims`
  - Track claim number → insurer status updates
  - Reconcile billed vs. approved amounts
  - Appeal denied claim with attached docs
  - Patient with multiple policies → primary/secondary routing
  - Claim aging report / followup queue

### P9 — ER reassessment & disposition pathing
- **File:** `e2e/er-disposition.spec.ts`
- **Why:** Triage accuracy affects safety + ER throughput
- **Scenarios:**
  - Reassess patient mid-wait → triage-level update + audit
  - Doctor changes disposition (discharge → admit) → admission flow triggered
  - Discharge with summary + followup orders
  - Transfer to another facility with referral packet
  - Overflow → waitlist branching
  - Fast-track vs. standard path comparison

### P10 — Multi-tenant data isolation
- **File:** `e2e/tenant-isolation.spec.ts`
- **Why:** Regulatory; cross-tenant leak is a critical breach
- **Scenarios:**
  - User in tenant A logs in → patient list contains only tenant A patients
  - Direct URL to tenant B patient ID → 403/404
  - Audit log shows only tenant A actions
  - Feature flag enabled for tenant A but not B → gated behavior verified
  - Tenant-A user cannot list/discover tenant B's users
  - Tenant onboarding (`/dashboard/tenants/[id]/onboarding`) creates isolated dataset

---

## 6. Secondary backlog (after top 10)

Group by theme — write as time/budget allows.

### File operations & print
- Document upload on patient chart (formats, size limits, AV scan)
- Imaging upload (X-ray, ultrasound) with preview
- Bulk patient CSV import with error report
- Rx print-to-PDF with watermark
- Invoice/bill print (margins, header/footer)
- Discharge summary print
- Batch print queue

### Communications
- `/dashboard/notifications` inbox + delivery status
- `/dashboard/broadcasts` send + read receipt
- `/dashboard/notification-templates` CRUD
- `/dashboard/complaints` submission + resolution
- `/dashboard/chat` 1:1 + department channel

### Account & profile
- `/dashboard/profile` view/edit
- `/dashboard/account` email change, password change, 2FA enable/disable
- Public `/forgot-password` request → reset link → new password
- Public `/register` self-service patient registration

### Pediatric & specialty
- `/dashboard/pediatric/[patientId]` age-specific dosing, growth charts
- `/dashboard/antenatal/[id]` prenatal visit cadence
- `/dashboard/immunization-schedule` overdue alerts
- `/dashboard/symptom-diary` patient logging

### Real-time & WebSocket
- Live queue updates across browser tabs
- New-order push to nurse station
- Audit-log live stream for admins
- Real telemedicine WebRTC (un-mock signaling, validate ICE/SDP)

### Performance & resilience
- Page load under 3G throttling for top 10 routes
- 1000+ patient list rendering (virtualization, search, sort)
- Concurrent appointment booking same slot
- API 500/503 retry verification
- Offline mode + sync-on-reconnect
- Memory profile over 8-hour session

### Mobile app (apps/mobile)
- Mobile auth flow
- Patient portal: appointments, bills, prescriptions
- Push notifications
- Offline mode
- Biometric auth (if implemented)

### Visual regression expansion
- Add baselines for: appointment booking, billing summary, error states, dark mode, mobile viewport
- Cross-browser baselines (WebKit, Firefox)

### A11y deepening
- Screen-reader narration tests (NVDA, VoiceOver)
- Keyboard-only nav for date-pickers, multi-step forms
- High-contrast mode rendering
- Font-scale 110% / 150% layout integrity

### i18n
- Language switch + persistence
- RTL layout (if applicable)
- Locale-specific date/time/number formatting

---

## 7. Test infrastructure backlog

Independent of specific specs — invest here to make new specs faster and more reliable.

- Add seeders to `e2e/fixtures.ts` for: users, leave-requests, suppliers, medicines, custom reports, holidays, insurance providers, broadcasts, complaints
- Per-test DB reset or per-suite isolation namespace (audit-log + financial state leak today)
- Cleanup hooks for created records (drift accumulates)
- Helper for file upload with sample fixtures (PDF, JPG, CSV, large file)
- Helper for print/PDF assertion (intercept print dialog, snapshot PDF)
- Helper for WebSocket event listening + assertion
- Helper for tenant-scoped login (`loginAs(role, { tenantId })`)
- Network throttle profiles (3G, 4G, offline) reusable across specs
- Visual baseline workflow doc (when to update, who reviews)

---

## 8. How to use this backlog

1. **Pick from §5 first** — top 10 are ranked; don't skip ahead unless a release blocks.
2. **For each new spec**, follow the existing patterns: import fixtures from `e2e/fixtures.ts`, helpers from `e2e/helpers.ts`, RBAC role login via existing helpers.
3. **Add to the right Playwright project** — smoke (canary), regression (role flows), or just `full` for new specialty specs.
4. **Update §1 snapshot counts** when specs are added/removed.
5. **Move completed items to a "Done" section** with PR link rather than deleting — keeps history searchable.

### Status legend (use when updating)
- `[ ]` — not started
- `[~]` — in progress
- `[x]` — done (link PR)
- `[skip]` — explicitly out of scope (note reason)

---

## 9. Open questions / decisions needed

- **`bloodbank` vs `blood-bank`** and `operating-theaters` vs `operating-theatres` — duplicate routes? Confirm canonical and remove the other before writing specs to avoid double-coverage.
- **`medication` vs `medication-dashboard`** — clarify scope so admissions-mar coverage doesn't drift.
- **`reports/scheduled` vs `scheduled-reports`** — same content or different? Pick one.
- **Mobile app scope** — is `apps/mobile` shipping in the next release, or is it pre-alpha? Determines whether to invest in Detox/Maestro now or defer.
- **Razorpay / WhatsApp / Sarvam** — are sandbox creds available in CI for `E2E_FULL`? Without them, integration coverage stays mocked.
- **DB-reset strategy** — per-test transactional rollback vs. per-suite truncate. Affects flake rate at scale.
