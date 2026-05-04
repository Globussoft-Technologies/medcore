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
- ~~`/dashboard/patients` — list page (search/filter/sort/bulk actions)~~ ✅ closed (7 tests; ADMIN/DOCTOR/NURSE/RECEPTION view + ADMIN|RECEPTION Register CTA + Issue #427 debounced-search refetch + DataTable sort/filter/CSV aria contract + PATIENT Issue #382 bounce; `e2e/patients.spec.ts`)
- ~~`/dashboard/patients/[id]` — full chart from doctor's perspective (allergies, imaging, med history)~~ ✅ closed (7 tests; DOCTOR header chrome + Start-Consultation CTA + Medical Records tab allergies/conditions/immunizations + SEVERE-allergy banner + Documents tab empty-state + Lab Results tab empty-state + ADMIN edit-button asymmetry (Issue #185) + PHARMACIST/LAB_TECH route-shape pin (no redirect, CTAs gated); `e2e/patients-id.spec.ts`)
- ~~`/dashboard/patients/[id]/problem-list` — add/edit/delete problems~~ ✅ closed (6 tests; DOCTOR chrome + empty-state + filter query-string contract (`activeOnly=false&type=condition`) + NURSE/LAB_TECH chrome + PATIENT cross-patient BOLA pin (API 4xx surfaces, page swallows to empty list — universally-accessible route shape) + bad-UUID empty render; `e2e/problem-list.spec.ts` — note: page is currently READ-ONLY aggregation, no write CTAs exist; backlog "add/edit/delete" framing reflects future intent)
- ~~`/dashboard/patients/register` — new patient registration form~~ ✅ closed (6 tests; `e2e/patients-register.spec.ts`)
- ~~`/dashboard/prescriptions/new` — Rx creation form (only smoke-touched today)~~ ✅ closed (6 tests; DOCTOR redirect-contract pin + happy path through EntityPicker patient/appointment + Zod-validation Issue #490 wording + ADMIN UX-asymmetry pin + RECEPTION/LAB_TECH bounces; `e2e/prescriptions-new.spec.ts`)
- ~~`/dashboard/pediatric` — pediatric ward listing~~ ✅ closed `0715f27`
- ~~`/dashboard/pediatric/[patientId]` — pediatric chart (age-specific dosing, growth charts)~~ ✅ closed `0715f27`
- ~~`/dashboard/symptom-diary` — patient-reported symptom logging~~ ✅ closed (PATIENT happy path + 2 RBAC bounces + staff banner; `e2e/symptom-diary.spec.ts`)
- ~~`/dashboard/telemedicine/waiting-room` — waiting-room UI (only mocked join tested)~~ ✅ closed (7 tests; PATIENT precheck → join → WAITING traversal + picker/precheck-gates-join + precheck-failure pills + deny-state stability + DOCTOR/NURSE no-redirect access-shape pin + cross-patient 403 API guard; `e2e/telemedicine-waiting-room.spec.ts`)

### 2.2 Inventory & Supply Chain
- ~~`/dashboard/medicines` — medicine catalog~~ ✅ closed (ADMIN/DOCTOR/NURSE/PATIENT access matrix + ADMIN-only Add CTA + search re-fetch + ADMIN create round-trip; `e2e/medicines.spec.ts`)
- ~~`/dashboard/pharmacy` — stock levels, reorder, expiry alerts (only landing tested)~~ ✅ deepened (tabs/search/filter coverage; `e2e/pharmacy.spec.ts`)
- ~~`/dashboard/purchase-orders` — PO list~~ ✅ closed `be36db6` (`e2e/purchase-orders.spec.ts` — full DRAFT → PENDING → APPROVED → RECEIVED state machine + DRAFT → CANCELLED, 7 roles, Issue #262 RBAC API-token assertions)
- ~~`/dashboard/purchase-orders/[id]` — PO detail / approval~~ ✅ closed `be36db6` (bundled in `e2e/purchase-orders.spec.ts` above)
- ~~`/dashboard/assets` — equipment register~~ ✅ closed (6 tests; `e2e/assets.spec.ts`)
- ~~`/dashboard/suppliers` — supplier directory~~ ✅ closed (ADMIN/RECEPTION happy paths + search re-fetch + Add-Supplier modal + DOCTOR/PATIENT 403 at GET /suppliers; `e2e/suppliers.spec.ts`)
- ~~`/dashboard/controlled-substances` — substance log entries (only page-load tested)~~ ✅ closed `e33ceea` (`e2e/controlled-substances.spec.ts` — 10 tests / 6 roles, PHARMACIST/DOCTOR/ADMIN allow + NURSE/RECEPTION/PATIENT deny → /not-authorized; read-only audit register, entries flow from dispense workflow)

### 2.3 Billing & Finance
- ~~`/dashboard/billing/[id]` — line-item editing (only happy-path create tested)~~ ✅ closed (6 tests; `e2e/billing-id.spec.ts`)
- ~~`/dashboard/billing/patient/[patientId]` — bulk patient billing~~ ✅ closed 2026-05-05 by `e2e/billing-patient.spec.ts` (6 cases; RECEPTION page-chrome (patient header + Total-Outstanding tile + unpaid-invoice table) + bulk-payment modal POST /payments/bulk round-trip oldest-first split + bulk-discount modal POST /invoices/:id/discount per-row loop + zero-outstanding empty-state with disabled action buttons + PATIENT/DOCTOR Issue #385 REDIRECT-BOUNCE archetype (page.tsx:55-60 useEffect router.replace("/dashboard") for non-ADMIN/RECEPTION, NOT /not-authorized — matches 6th cron-learning bullet redirect-target dominant /dashboard))
- ~~`/dashboard/payment-plans` — installment plan setup~~ ✅ closed `be36db6` (`e2e/payment-plans.spec.ts` — 18 tests, ADMIN+RECEPTION positive + 5 staff RBAC negatives, EntityPicker option-li selector for patient picker, HTML5-vs-React noValidate fix landed in `3decc91`)
- ~~`/dashboard/bill-explainer` — explanation workflow (only smoke-visited)~~ ✅ closed (7 tests; ADMIN chrome + empty-state + DRAFT card render-and-approve round-trip + Refresh GET re-fetch + non-DRAFT no-CTA + PATIENT/DOCTOR universally-accessible no-redirect pin (page has no client gate, /pending API authorize() enforces RBAC); `e2e/bill-explainer.spec.ts`)
- ~~`/dashboard/budgets` — budget tracking~~ ✅ closed (6 tests; `e2e/budgets.spec.ts`)
- ~~`/dashboard/expenses` — expense entry~~ ✅ closed (6 tests; `e2e/expenses.spec.ts`)
- ~~`/dashboard/discount-approvals` — request side (approval side covered)~~ ✅ closed (7 tests; ADMIN tab strip + PENDING row Approve/Reject CTAs + empty-state + tab-switch refetch contract (PENDING→APPROVED) + REJECTED inline-reason chrome + RECEPTION read-only chrome + DOCTOR/PATIENT Issue #509 VIEW_ALLOWED gate redirect to /not-authorized; `e2e/discount-approvals.spec.ts`)

### 2.4 HR, Payroll, Scheduling
- ~~`/dashboard/users` — edit/deactivate/permission matrix (create only is covered)~~ ✅ closed (6 tests; `e2e/users.spec.ts`)
- ~~`/dashboard/payroll` — salary, payslip, deductions~~ closed 2026-05-03 by `e2e/payroll.spec.ts` (7 tests; ADMIN chrome + edit + calculate + slip + overtime tab + DOCTOR/NURSE bounces)
- ~~`/dashboard/my-leaves` — employee leave-request submission~~ ✅ closed (6 tests; `e2e/my-leaves.spec.ts` — DOCTOR chrome + submit-flow + required-field guard + reversed-date inline error + NURSE chrome + PATIENT route-shape pin: universally accessible, no role redirect)
- ~~`/dashboard/my-activity` — personal activity log~~ ✅ closed (6 tests; DOCTOR chrome + stubbed empty-state + stubbed populated-feed action-filter contract (allActions memo + actionFilter predicate) + ADMIN/NURSE chrome (proves self-scoped, NOT all-user audit) + PATIENT route-shape pin: universally-accessible, no role redirect, feed scoped via `where: { userId: req.user.userId }` at auth.ts:1126; `e2e/my-activity.spec.ts`)
- ~~`/dashboard/holidays` — holiday calendar~~ — closed 2026-05-03 by `e2e/holidays.spec.ts` (ADMIN calendar mgmt + non-ADMIN bounces)
- ~~`/dashboard/leave-calendar` — calendar view (approval side covered)~~ closed 2026-05-03 by `e2e/leave-calendar.spec.ts` (6 tests; ADMIN chrome + legend + month nav + DOCTOR/NURSE/PATIENT bounces)
- ~~`/dashboard/schedule` — staff schedule~~ ✅ closed (7 tests; `e2e/schedule.spec.ts` — ADMIN/DOCTOR happy paths + Add-Slot reverse-time client guard + Add-Override Modify-Hours toggle + access-shape pinning for NURSE/RECEPTION/PATIENT, no role-gate redirect)
- ~~`/dashboard/doctors` — doctor directory~~ closed 2026-05-03 by `e2e/doctors.spec.ts` (6 tests; ADMIN happy/search/modal + DOCTOR/NURSE/PATIENT bounces)
- ~~`/dashboard/doctors/[id]` — doctor profile/schedule~~ ✅ closed (4 tests; `e2e/doctors-id.spec.ts` — ADMIN profile+schedule+Edit CTA + DOCTOR no-Edit-CTA + PATIENT route-shape pin: detail page universally accessible vs LIST page ADMIN-only + bad-UUID `doctor-detail-notfound` empty-state)

### 2.5 Communications
- ~~`/dashboard/notifications` — inbox~~ closed 2026-05-03 by `e2e/notifications.spec.ts` (6 tests; ADMIN/PATIENT/NURSE chrome + preferences toggle + LAB_TECH/PHARMACIST direct-URL accessibility)
- ~~`/dashboard/notifications/delivery` — delivery status~~ ✅ closed (7 tests; `e2e/notifications-delivery.spec.ts` — ADMIN heading + GET /delivery contract + 4 filter inputs + status=FAILED filter wiring + Refresh re-fetch + READ+PUSH empty/settled state + DOCTOR/NURSE/PATIENT bounces)
- ~~`/dashboard/broadcasts` — bulk announcement~~ closed 2026-05-03 by `e2e/broadcasts.spec.ts` (7 tests; ADMIN chrome + compose-send + audience picker + empty-form gate + DOCTOR/NURSE/PATIENT bounces)
- ~~`/dashboard/notification-templates` — template config~~ ✅ closed (7 tests; `e2e/notification-templates.spec.ts` — ADMIN matrix + 13 type rows + 4 channel headers + Add/Edit modal pre-fill + EMAIL Subject conditional + POST/PUT save round-trip + DOCTOR/NURSE/PATIENT bounces)
- ~~`/dashboard/complaints` — complaint workflow~~ closed 2026-05-03 by `e2e/complaints.spec.ts` (6 tests; ADMIN chrome + modal + validation toast + tab switch + RECEPTION reach + PATIENT/LAB_TECH 403 on list)
- ~~`/dashboard/chat` — inter-department messaging~~ closed 2026-05-04 by `e2e/chat.spec.ts` (7 tests; ADMIN inbox+picker+send round-trip + DOCTOR/RECEPTION sidebar reach + PATIENT/LAB_TECH direct-URL accessibility — page has no client-side role gate, only the staff filter on `/chat/users`)

### 2.6 Analytics & Reporting
- ~~`/dashboard/reports` — custom report creation (only crash-regression tested)~~ ✅ closed 2026-05-05 by `e2e/reports-custom.spec.ts` (7 cases; ADMIN page chrome + tab strip + GET /billing/reports/daily first-paint + History-tab GET /analytics/report-runs first-paint AND `?type=WEEKLY_REVENUE` filter refire query-string pin + Generate-modal POST /analytics/report-runs request-body shape pin (reportType + parameters.from/to + snapshot + SUCCESS status, page.route-stubbed so no seed pollution) + Schedule-modal POST /scheduled-reports body shape pin (recipients[], active=true, dayOfWeek=1 WEEKLY axis page.tsx:250) + per-row CSV Export `page.waitForEvent('download')` contract pinning the authed-fetch+blob+anchor pattern at page.tsx:279-298 (filename `report-weekly_revenue-stub-run-1.csv`, query-string from/to from run.parameters) + RECEPTION/PATIENT REDIRECT-TO-/dashboard archetype pin (page.tsx:127-132 useEffect router.push("/dashboard") for any role !== ADMIN per Issue #90, NOT /not-authorized — 8:1 cron-learning ratio, same archetype as tenants/insurance-claims/fhir-export); the existing `e2e/reports.spec.ts` Issues #3/#26 white-screen regression spec is preserved untouched. Recurring-schedule lifecycle (real persisted POST + run-now + delete) intentionally skipped to avoid polluting shared seed across runs — owned by route-handler unit tests at apps/api/src/routes/scheduled-reports.ts)
- ~~`/dashboard/reports/scheduled` — execution + delivery (only setup tested)~~ ✅ closed (7 tests; ADMIN deep-link → canonical redirect + GET /scheduled-reports first-paint + Run History tab GET /scheduled-reports/runs + 6-column delivery-visibility contract pin (stubbed SUCCESS+FAILED rows) + empty-name toast (Issue #458 noValidate path) + DOCTOR/PATIENT/RECEPTION bounces; `e2e/reports-scheduled.spec.ts` — also dedups `/dashboard/scheduled-reports` since `/reports/scheduled` is just a thin client-side redirect to the canonical page)
- ~~`/dashboard/scheduled-reports` — same; verify dedup vs above~~ ✅ closed (bundled in `e2e/reports-scheduled.spec.ts` above — dedup verified: `/dashboard/reports/scheduled` is a client-side redirect (Issue #80 compat shim) onto the canonical `/dashboard/scheduled-reports` page)
- ~~`/dashboard/analytics/reports` — analytics export~~ ✅ closed (6 tests; ADMIN heading + 5 type-tile matrix + first-paint analytics GET + type-switch contract pin (Revenue → Appointments re-fetches /analytics/appointments) + CSV download trigger contract (`<type>-report-<from>_<to>.csv` filename) + empty-state with disabled CSV/JSON buttons + DOCTOR/PATIENT bounces; `e2e/analytics-reports.spec.ts`)
- ~~`/dashboard/census` — bed census~~ closed 2026-05-03 by `e2e/census.spec.ts` (6 tests; ADMIN chrome + Daily/Weekly toggle + DOCTOR/NURSE reach + PATIENT/LAB_TECH 403-without-crash)
- ~~`/dashboard/queue` — queue priority/reassignment (page-load only)~~ ✅ deepened (priority/reassign + RBAC; `e2e/queue.spec.ts`)

### 2.7 Admissions & Wards
- ~~`/dashboard/admissions` — admit form (list-touched only)~~ ✅ closed `65b5e0a` (`e2e/admissions.spec.ts` — 11 tests across 5 roles; route-shape correction pinned: page is fully accessible, only the "Admit Patient" CTA is role-gated; discharge is a two-modal sequence)
- ~~`/dashboard/admissions/[id]` — admission detail, MAR progression, discharge~~ closed 2026-05-03 by `e2e/admissions-id.spec.ts` (6 tests; ADMIN chrome+running-bill + NURSE isolation/belongings + RECEPTION tab strip + PATIENT page-accessible + DOCTOR transfer-modal + ADMIN discharge two-modal force-flow)
- ~~`/dashboard/wards` — bed assignment, transfer~~ closed 2026-05-04 by `e2e/wards.spec.ts` (7 tests; ADMIN chrome/add-ward modal/forecast tab + NURSE/RECEPTION no-CTA + PATIENT/LAB_TECH page-accessible no-CTA)
- ~~`/dashboard/capacity-forecast` — forecast editing (smoke-visited)~~ ✅ closed 2026-05-05 by `e2e/capacity-forecast.spec.ts` (7 cases; ADMIN chrome + horizon×tab fan-out + summary/heatmap pin + NURSE allow + PATIENT page-accessible no-CTA + empty state + error banner)

### 2.8 AI features
- ~~`/dashboard/ai-kpis` — KPI dashboard configuration~~ ✅ closed 2026-05-05 by `e2e/ai-kpis.spec.ts` (7 cases; ADMIN chrome + Feature1 cards + Feature2 cards w/ unavailable card pin + CSV export tab + PATIENT/DOCTOR admin-gate + error banner)
- ~~`/dashboard/ai-booking` — AI-assisted booking~~ ✅ closed 2026-05-05 by `e2e/ai-booking.spec.ts` (5 cases; PATIENT pre-chat selector chrome + Child→dependent-id reveal + Start→POST /ai/triage/start with stubbed greeting + symptom-chips + DOCTOR universal-access pin (no VIEW_ALLOWED gate) + 400-error-envelope toast path)
- ~~`/dashboard/ai-fraud` — fraud-case investigation (smoke-visited)~~ ✅ closed 2026-05-05 by `e2e/ai-fraud.spec.ts` (6 cases; ADMIN chrome + filters + Run-Scan + scan-window + row/expand contract + RECEPTION-can-read-but-no-CTA + PATIENT/DOCTOR inline Restricted placeholder (admin-gate-placeholder archetype, page.tsx:478) + empty-state)
- ~~`/dashboard/agent-console` — AI agent monitoring~~ ✅ closed 2026-05-05 by `e2e/agent-console.spec.ts` (7 cases; ADMIN three-pane chrome + stubbed handoff row → composer/transcript/Suggest-this-doctor mount + Suggest-doctor POST + composer pre-fill + RECEPTION reach + PATIENT/DOCTOR REDIRECT-BOUNCE archetype (page.tsx:144-155 useEffect router.replace, NOT the admin-gate-placeholder shape — useEffect actively pushes to /dashboard) + empty-state)

### 2.9 Account & Profile
- ~~`/dashboard/profile` — profile view/edit~~ ✅ closed (6 tests; ADMIN/DOCTOR/PATIENT happy paths + universal-access route-shape pin (no VIEW_ALLOWED, no redirect) + Change-Password modal structural contract + Issue #458 React-owned noValidate "Passwords do not match" inline-error gate with no POST; `e2e/profile.spec.ts` — destructive password-mutation/2FA-enroll flows intentionally skipped to avoid poisoning shared seed)
- ~~`/dashboard/account` — email/password/2FA~~ ✅ closed (bundled in `e2e/profile.spec.ts` — `/dashboard/account` is a thin server-component `redirect("/dashboard/profile")` alias from Issue #303; redirect-contract test pins the alias)
- ~~`/dashboard/workspace` — workspace config (smoke-visited)~~ ✅ closed 2026-05-05 by `e2e/workspace.spec.ts` (7 cases; backlog phrasing turned out to be aspirational — actual surface is a DOCTOR-only personal cockpit (queue + tasks + appointments + recent prescriptions aggregator), not a config screen; DOCTOR chrome (heading + DOCTOR badge + 4 shortcut CTAs Start-Consultation/Write-Rx/Order-Labs/Add-Note) + three-column dashboard pin (My Queue / My Pending Tasks / Today's Appointments) + lower-row admitted/recent-Rx panels + Pending-Tasks 4-row TaskRow contract (page.tsx:204-228) + Write-Rx href contract (`?new=1`) + ADMIN/PATIENT/NURSE REDIRECT-BOUNCE archetype (page.tsx:43-46 useEffect router.replace("/dashboard"), 6:1 cron-learning split — target is `/dashboard`, NOT `/dashboard/not-authorized`); page has zero `data-testid` so anchors are heading-by-text + role=link/button)
- ~~`/dashboard/workstation` — task assignment (RBAC-only tested)~~ ✅ closed 2026-05-05 by `e2e/workstation.spec.ts` (7 cases; NURSE chrome + four quick-action buttons + meds-due card populated + Record-Vitals deep-link with CHECKED_IN appt (Issue #432 fix at page.tsx:147-156) + Record-Vitals fallback branch with empty queue + admissions/ER populated lower panels + PATIENT/DOCTOR REDIRECT-BOUNCE archetype (page.tsx:38-42 useEffect router.replace, NOT admin-gate-placeholder shape))

### 2.10 Public / Unauthenticated
- `/register` — public patient registration
- `/forgot-password` — password reset
- `/verify/rx/[id]` — valid Rx verification path (only invalid-id edge case tested)
- `/feedback/[patientId]` — anonymous patient feedback
- `/display` — public display board

### 2.11 Multi-tenant
- ~~`/dashboard/tenants` — tenant list (touched, no isolation verification)~~ ✅ closed 2026-05-05 by `e2e/tenants.spec.ts` (6 cases; ADMIN page-chrome + filter-cluster wiring (search/plan/active-filter) + Create-Tenant modal structural contract + RESERVED-subdomain inline-validation gate (page.tsx:64-83, no POST fired) + DOCTOR/PATIENT REDIRECT-BOUNCE archetype (page.tsx:124-128 useEffect router.push("/dashboard") for any role !== ADMIN, NOT /not-authorized) — actual create flow skipped to avoid polluting shared seed; deeper multi-tenant data-isolation verification is separate-spec territory)
- ~~`/dashboard/tenants/[id]/onboarding` — onboarding flow~~ ✅ closed 2026-05-05 by `e2e/tenants-onboarding.spec.ts` (5 cases; ADMIN page-chrome (heading + back-link + progress bar + 6 ordered step testids account_created/hospital_config/first_doctor/duty_roster/notification_templates/seed_test_patient) + per-step deep-link contract (6 link testids) + account_created Mark-complete CTA absent (page.tsx:279 guard, autoDetect always-true) + at-least-one Mark-complete CTA visible on remaining 5 steps + INVALID-uuid 404 no-crash pin (page shell still mounts, detail row absent) + DOCTOR/PATIENT REDIRECT-BOUNCE archetype (page.tsx:147 useEffect router.push("/dashboard") for any role !== ADMIN, NOT /not-authorized — same archetype as parent /dashboard/tenants per commit `d43be97`); seeded default-tenant id resolved at runtime via GET /api/v1/tenants; actual POST /onboarding/:step lifecycle skipped to avoid permanently mutating the shared default-tenant onboarding state across runs — owned by route-handler unit tests at apps/api/src/routes/tenants.ts)

### 2.12 Other
- ~~`/dashboard/referrals` — create/accept/reject (page-load only)~~ ✅ closed 2026-05-05 by `e2e/referrals.spec.ts` (7 cases; DOCTOR page-chrome + outgoing/incoming/all tab-cluster + tab-switch survives without crash + New-Referral modal structural contract (patient search input + Internal/External toggle + specialty picker + reason textarea + Create CTA) + Issue #10/#458 empty-form client-validation gate (no POST fired, "Select a patient" inline error) + ADMIN reach without doctor-tab cluster (page.tsx:284 isDoctor gate) + RECEPTION/PATIENT UNIVERSAL-ACCESS archetype (no VIEW_ALLOWED, no redirect — API gate at apps/api/src/routes/referrals.ts:35,93 is real truth, PATIENT sees empty-state)) — actual create/accept/reject lifecycle skipped because the form requires a /patients?search debounce + /doctors fetch and would pollute shared seed)
- ~~`/dashboard/calendar` — event creation, drag, conflict detection~~ ✅ closed 2026-05-05 by `e2e/calendar.spec.ts` (5 cases; ADMIN page-chrome + default-Month view + 3-tab view-toggle wiring (Issue #431 day/week/month panels mount-and-unmount via `viewMode === X &&` guards) + month-nav cursor state-machine round-trip (`cal-next` advances the en-IN long-month label, `cal-today` bounces back to live) + DOCTOR universal-access parity + PATIENT UNIVERSAL-ACCESS archetype (no `VIEW_ALLOWED`, no `router.push`/`router.replace` redirect — calendar is intentionally cross-role, server-side BOLA scoping at appointments/antenatal does the gating; ADMIN-only Shifts legend chip absent for PATIENT, page.tsx:348-350); event-creation/drag/conflict-detection framing in backlog title is aspirational — page is a read-only aggregator, creation lives on per-resource routes; drag-drop interaction not pinned because Playwright drag is fragile across renderers, popup-via-click contract pinned instead)
- ~~`/dashboard/my-schedule` — shift claim, unavailability~~ ✅ closed 2026-05-05 by `e2e/my-schedule.spec.ts` (5 cases; DOCTOR page-chrome + 7-day grid + Leaves card + Request-Leave CTA + NURSE staff-role parity + DOCTOR Request-Leave modal contract (heading + 6-option leave-type select scoped via `select:has(option[value="MATERNITY"])` to dodge LanguageDropdown gotcha #9 + From/To/Reason labelled inputs + Cancel teardown) + DOCTOR empty-form client-validation gate (page.tsx:131-138, no POST `/leaves` fires) + PATIENT UNIVERSAL-ACCESS archetype (no `VIEW_ALLOWED`, no `router.push`/`router.replace` redirect — `/shifts/my` and `/leaves/my` have no `authorize()` so PATIENT lands on the chrome but sees an empty 7-day grid because no `StaffShift` rows exist for PATIENT users, shifts.ts:196 #511 audit verdict VERIFIED-SAFE); page has NO `data-testid` attributes so we anchor on heading/button-role/labelled-input semantics; backlog phrasing "shift claim" is aspirational — current page surfaces today-only check-in/check-out CTAs (not a generic claim button) and the leave-request modal IS the unavailability flow)
- ~~`/dashboard/insurance-claims` — claim submission/appeal/reconciliation (smoke only)~~ ✅ closed (7 tests; ADMIN queue chrome + Submit-new/AI-Draft/filter cluster + status-filter `?status=SUBMITTED` query-string pin + row→side-drawer GET `/claims/:id` timeline+documents render + RECEPTION RBAC parity + Submit-new empty-form Issue #302/#458 client-guard (no POST fired) + DOCTOR/PATIENT redirect-bounce-to-/dashboard archetype pin (page.tsx:138, NOT /not-authorized); `e2e/insurance-claims.spec.ts` — full lifecycle/appeal/reconcile deferred until a TPA-stub helper lands, see backlog §5 P8)
- ~~`/dashboard/blood-bank` and `/dashboard/bloodbank`~~ ✅ flow covered `9843648` (still: verify route dedup; only requisition was touched in OT spec)
- ~~`/dashboard/operating-theaters` and `/dashboard/operating-theatres` — verify dedup~~ ✅ closed 2026-05-05 by `e2e/operating-theatres.spec.ts` (5 cases; both UK + US spellings confirmed as client-side redirect stubs to canonical `/dashboard/ot` per Issue #158, same alias pattern as `/account` → `/profile` Issue #303 / commit `8a869c8`; ADMIN UK + US redirect-and-land + DOCTOR parity + PATIENT redirect-fires-without-role-check + non-existent-sibling negative pin; functional OT/calendar/scheduling flow remains owned by `e2e/ot-surgery.spec.ts` — no overlap)
- ~~`/dashboard/medication`, `/dashboard/medication-dashboard` — overlap with admissions-mar; clarify scope~~ ✅ closed 2026-05-05 by `e2e/medication-dashboard.spec.ts` (5 cases; `/medication` confirmed as client-side redirect stub to canonical `/medication-dashboard` per Issue #136, same alias pattern as Issue #303 / commit `8a869c8`; redirect contract + NURSE chrome (heading + ward-filter `select` + Refresh button) + DOCTOR parity + Refresh-re-fires-/administrations/due wiring pin + PATIENT route-shape pin (no VIEW_ALLOWED — CLAUDE.md gotcha #7 archetype, chrome renders but /administrations/due is API-403'd → "No medications due." empty-state) — multi-role MAR FLOW (DOCTOR places order → NURSE marks ADMINISTERED) remains owned by `e2e/admissions-mar.spec.ts` (currently all-skipped pending bed-seeding fix, no overlap))
- ~~`/dashboard/lab-intel` — lab-intelligence dashboards (page-load only)~~ ✅ closed 2026-05-05 by `e2e/lab-intel.spec.ts` (7 cases; DOCTOR full-access page chrome (title testid + 4 KPI tiles + critical row testid + deviations section/row testid) + ADMIN parity (no read-only banner) + NURSE READ-ONLY banner + "View only" Action-cell branch (page.tsx:362-376) + filter-cluster wiring (date inputs + severity select + Refresh; severity=CRITICAL re-fires GET /ai/lab-intel/critical query-string pin) + empty-state pin (`lab-intel-empty` sr-only + `lab-intel-deviations-empty`) + LAB_TECH/PATIENT REDIRECT-TO-/dashboard/not-authorized archetype (page.tsx:230-239 useEffect router.replace, classic issue-#179 pattern, NOT the /dashboard variant); AI calls stubbed via `stubAi` for determinism)
- ~~`/dashboard/fhir-export` — full export workflow (smoke only)~~ ✅ closed 2026-05-05 by `e2e/fhir-export.spec.ts` (7 cases; ADMIN page chrome (heading + three ExportButton tiles, all disabled until patient pick) + Patient-resource happy path (search → autocomplete pick → click → preview pane + Copy/Download CTAs + fhir+json badge + endpoint hit pin) + $everything bundle (searchset type pin) + ABDM push bundle (transaction type pin) + 500 error-envelope inline banner + DOCTOR/PATIENT REDIRECT-TO-/dashboard archetype pin (page.tsx:58-62 router.push("/dashboard"), NOT /not-authorized — confirms 6th cron-learning bullet alignment with tenants.spec.ts + insurance-claims.spec.ts); FHIR endpoints stubbed via page.route so no real export payload generated)
- ~~`/dashboard/audit` — audit log filtering (light coverage)~~ ✅ closed (7 tests; ADMIN heading+Export-CSV+retention-banner+filter-cluster chrome + entity-filter `?entity=Patient` query-string pin + free-text filter `/audit` → `/audit/search` endpoint switch (page.tsx:146 / Issue #192-adjacent) + empty-state copy + Issue #79 entity canonicalisation (`patient` → `Patient`, `scheduled_report` → `ScheduledReport`) + Issue #192 entityLabel render via `audit-entity-${id}` testid + DOCTOR/PATIENT redirect-bounce-to-/dashboard (page.tsx:120, audit.ts:28 server-side gate); `e2e/audit.spec.ts` — deepens the existing single-case `admin-ops.spec.ts` audit pin)
- ~~`/dashboard/certifications` — staff certification tracking~~ ✅ closed 2026-05-05 by `e2e/certifications.spec.ts` (6 cases; ADMIN page-chrome (Award icon heading + Add-Certification CTA + 3-button filter cluster All/Expiring (<=30d)/Expired) + Expired-filter chip-active visual state-flip pin (client-side filter over loaded list, page.tsx:79-84) + Add-Certification modal structural contract (`cert-user-picker` EntityPicker testid + 6 labelled fields anchored via `#add-cert-*` ids dodging LanguageDropdown gotcha #9 + MEDICAL_LICENSE option pin + Cancel/Save) + Issue #458-pattern empty-form Save short-circuit (page.tsx:87 `if (!form.userId || !form.title) return;` no POST fired) + DOCTOR/PATIENT UNIVERSAL-ACCESS archetype pin (CLAUDE.md gotcha #7 archetype 3 — no `VIEW_ALLOWED`/router.replace, chrome renders, API self-scopes via hr-ops.ts:235 `where.userId = req.user.userId` for non-ADMIN, PATIENT empty-state); actual POST-create lifecycle skipped to avoid polluting shared admin seed across runs — that lifecycle is owned by hr-ops route-handler unit tests at apps/api/src/routes/hr-ops.ts)
- ~~`/dashboard/immunization-schedule` — vaccination schedule~~ ✅ closed 2026-05-05 by `e2e/immunization-schedule.spec.ts` (5 cases; DOCTOR page-chrome (heading + 3 filter chips week/month/overdue + populated stub-table with patient name + vaccine + dose) + Issue #426 filter-chip data-active state-flip + GET /ehr/immunizations/schedule?filter=overdue refire pin (closure-trap regression guard) + NURSE allow-set parity per ehr.ts:410 authorize(DOCTOR,NURSE,ADMIN) + empty-state copy with no column headers + PATIENT UNIVERSAL-ACCESS archetype (CLAUDE.md gotcha #7 archetype 3 — no `VIEW_ALLOWED`/router.replace, chrome renders, API 403 caught and rows=[] → empty-state); pediatric.spec.ts continues to own UIP/IAP per-patient immunization view, no overlap)
- ~~`/dashboard/antenatal`, `/dashboard/antenatal/[id]` — antenatal care~~ ✅ closed 2026-05-05 by `e2e/antenatal.spec.ts` (6 cases — DOCTOR list page chrome (heading + 4-tab cluster + 4 KPI tiles + New-ANC-Case CTA) + NURSE Issue #459-RBAC-drift CTA-visible pin (page.tsx:96-97 expanded canCreate to NURSE) + DOCTOR tab-flip query-string contract (`?isHighRisk=true&delivered=false` refire) + DOCTOR New-ANC-Case modal structural contract (anc-patient-search aria-required + anc-doctor select scoped to dodge LanguageDropdown gotcha #9 + anc-lmp-date `max=today` Issue #57 guard + anc-gravida `min=1` + anc-parity `min=0` + anc-blood-group select with A_POSITIVE option + High-Risk checkbox + Cancel teardown) + PATIENT/RECEPTION UNIVERSAL-ACCESS archetype pin (CLAUDE.md gotcha #7 archetype 3 — no `VIEW_ALLOWED`/router.replace, chrome renders, canCreate-false hides CTA)) and `e2e/antenatal-id.spec.ts` (5 cases, page-route stub fixtures — DOCTOR header chrome (caseNumber h1 + High-Risk pill + patient name/MR + Patient-Info + ANC-Summary cards + 4 always-on tabs Visits/Delivery/Partograph/ACOG-Risk) + DOCTOR ACOG-Risk tab structural pin (heading + Calculate-Score button + Hypertension/Diabetes labelled checkboxes) + DOCTOR delivered-fixture conditional surfaces (5th Postnatal-Visits tab + Print-Birth-Certificate CTA + Delivery-Details panel + Postnatal empty-state) + PATIENT BOLA-403 pass-through pin (server `assertPatientOwnsResource` antenatal.ts:355 → page sits in Loading without crash/bounce) + bad-UUID 404 no-crash pin); actual ANC-case create / visit-write / delivery-record / partograph-add lifecycle skipped because each requires a FEMALE patient + doctor + multi-step write that would pollute shared seed across runs — those write paths are owned by route-handler unit tests at apps/api/src/routes/antenatal.ts.
- ~~`/dashboard/ambulance` — dispatch (touched in ER flow only)~~ ✅ closed `0c94cbb` (full DISPATCHED → COMPLETED lifecycle + fuel logs + RBAC)
- ~~`/dashboard/visitors` — visitor log~~ ✅ closed 2026-05-05 by `e2e/visitors.spec.ts` (7 cases; RECEPTION page-chrome (heading + Check-In CTA testid + 3 KPI tiles Total-Today/Currently-Inside/By-Purpose + Active/All-Today tab buttons) + Active→Today tab-flip survives without crash (table-or-empty-state body, no Forbidden surface) + Check-In modal structural contract (visitor-name id + visitor-phone + id-type select scoped via `select:has(option[value="Aadhaar"])` to dodge LanguageDropdown gotcha #9 + purpose select scoped via PATIENT_VISIT option + visitor-id-number/department/patient-id/notes + Capture/Upload Photo buttons + Cancel/Check In CTAs) + Issue #458-pattern empty-form Check-In short-circuit (page.tsx:184-187 `if (!form.name) return`, no POST /visitors fires, modal stays open) + ADMIN allow-set parity per Issue #509 + PATIENT/PHARMACIST REDIRECT-TO-/dashboard/not-authorized archetype (page.tsx:65-72 useEffect router.replace, the rarer of the two redirect archetypes per the 6th cron-learning bullet, classic Issue #179/#509 pattern matching lab-intel.spec.ts; LAB_TECH skipped because the redirect logic is shared with PHARMACIST and one disallowed-role pin already exists — the spec covers both PATIENT (the canonical low-priv role) AND PHARMACIST (a staff-but-out-of-VIEW_ALLOWED role) for breadth); actual POST /visitors check-in lifecycle skipped because each call would create a permanent visitor pass row (no e2e teardown for /visitors) — owned by route-handler unit tests at apps/api/src/routes/visitors.ts)

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

### ~~P1 — Billing line-item editing & credit notes~~ ✅ closed (`e2e/billing-line-items.spec.ts`, 5 cases — UI delete-with-audit-row pin (INVOICE_ITEM_DELETE entityId+details.itemId match) + quantity-change-as-replace flow (delete-then-re-add; the only production path — there is NO PATCH /items endpoint) + partial-refund modal POST body shape pinned via page.route stub + Issue Refund CTA disabled-while-reason-empty assertion + POST /credit-notes against PAID invoice 201 with CN- noteNumber + over-credit 400 guard. Deferred — UI not shipped: (a) "edit line-item quantity" via dedicated PATCH endpoint — backend has no PATCH /items so quantity-change happens via delete+re-add, which IS covered; (b) "period-locked invoice → edit blocked" — no `lockedAt` field on Invoice model; the de-facto edit lock is `paymentStatus !== "PENDING"` which is already pinned in `e2e/billing-id.spec.ts` ("RECEPTION add-line-item is forbidden once the invoice is PAID"); (c) "overpayment → credit balance carry-forward" — no UI surface; `derivePaymentStatus` only returns REFUNDED/PAID/PARTIAL/PENDING with no advance-credit field for excess payment. There is also no `/dashboard/credit-notes` web surface today — credit notes are exercised as a pure API contract pin so the next person who builds the UI has a green baseline.)
- ~~**File:** `e2e/billing-line-items.spec.ts`~~
- ~~**Why:** Revenue-critical; line-item errors cascade to reconciliation, disputes, audits~~
- ~~**Scenarios:**
  - Edit line-item quantity → invoice total recomputes
  - Delete line-item → audit entry written
  - Add line-item to existing invoice (pre-payment vs. post-payment)
  - Issue credit-note against paid invoice → balance updates
  - Partial refund (amount < invoice total)
  - Overpayment → credit balance carry-forward
  - Period-locked invoice → edit blocked~~

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

### ~~P4 — Doctor full chart review~~ ✅ closed (`e2e/doctor-chart-review.spec.ts`, 6 cases — DOCTOR full 8-tab strip + Allergy WRITE flow with POST body shape pin via page.route stub + Allergy form NEGATIVE (empty allergen → toast, no POST) + Lab Results TrendSparkline `<svg>` rendering for HbA1c (stubs `/lab-orders` + `/lab/results/trends`) + Documents IMAGING-group heading + X-ray row when IMAGING-typed doc exists (stubbed) + Caregiver/family CRUD via FamilyLinksSection Add-Family-Member CTA opening LinkFamilyModal with relationship select. Deliberately disjoint from `e2e/patients-id.spec.ts` (which pins read-side empty-state paths + RBAC asymmetry). Deferred — UI not shipped: (a) "active medication list with start/stop dates" — the `prescription.items` type at page.tsx:98-105 carries dosage/frequency/duration only; no start/stop columns surface in the UI; (b) "medication reconciliation across encounters" — no encounter-spanning reconciliation surface exists in the chart today; (c) image-viewer interaction — the Documents IMAGING group exposes a Download CTA but no inline viewer.)
- ~~**File:** `e2e/doctor-chart-review.spec.ts`~~
- ~~**Why:** Diagnostic quality depends on complete chart visibility~~
- ~~**Scenarios:**
  - Doctor opens `/dashboard/patients/[id]` → sees demographics, allergies, problem list
  - Imaging panel shows prior X-rays / ultrasounds with viewer
  - Lab history with trend charts (e.g. HbA1c over time)
  - Active medication list with start/stop dates
  - Allergy entry: add severity, type, reaction
  - Medication reconciliation across encounters
  - Caregiver / family contact CRUD~~

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

### ~~P6 — Custom reports creation, scheduling, export~~ ✅ closed 2026-05-05 by `e2e/reports-custom.spec.ts` (7 cases — ADMIN forward-flow + RBAC redirect-bounce; recurring-schedule lifecycle deferred to route-handler unit tests)
- **File:** `e2e/reports-custom.spec.ts`
- **Why:** Hospital admins depend on reports for KPIs, compliance, budgeting
- **Scenarios:**
  - ~~Create report at `/dashboard/reports` with date range + department + metric filters~~ ✅ pinned via Generate modal + History-tab type-filter `?type=` query-string contract
  - ~~Save report definition for reuse~~ ✅ pinned via Schedule modal POST /scheduled-reports body-shape (page.route-stubbed so no seed pollution)
  - ~~Schedule recurring delivery (daily/weekly/monthly) with email recipients~~ ✅ pinned via Schedule modal (WEEKLY frequency, recipients[], dayOfWeek=1 axis)
  - ~~Execute report on demand → CSV / Excel / PDF export~~ ✅ pinned via per-row CSV Export `page.waitForEvent('download')` (Excel/PDF deferred — page only ships CSV per CSV_EXPORT_FOR_TYPE map at page.tsx:29-34)
  - View execution history + failures at `/dashboard/reports/scheduled` (already covered by `e2e/reports-scheduled.spec.ts` — see §2.6)
  - Re-run failed schedule (deferred — owned by `apps/api/src/routes/scheduled-reports.ts` unit tests; lifecycle skipped to avoid persisted ScheduledReport row pollution across e2e runs)

### ~~P7 — HR ops: leave requests, payroll, bulk user mgmt~~ ✅ closed 2026-05-05 by `e2e/hr-operations.spec.ts` (6 cases — ADMIN queue chrome with 4-status tab strip + filter cluster + stubbed PENDING row + Approve CTA pinning PATCH /api/v1/leaves/:id/approve body shape `{status:"APPROVED"}` via useConfirm dialog round-trip + Reject modal empty-reason gate (toast.error guard at page.tsx:88-90 short-circuits before PATCH) THEN reason-filled PATCH /api/v1/leaves/:id/reject body shape `{rejectionReason:"..."}` pin + tab-switch refetch contract Pending → Approved firing GET /api/v1/leaves?status=APPROVED with the page.tsx:54 querystring `?status=${tab}` lock + DOCTOR/PATIENT ACCESS-RESTRICTED IN-PAGE archetype pin (CLAUDE.md gotcha #7 archetype 3 distinct from /dashboard/users which router.push("/dashboard")s — leave-management page.tsx:67-73 renders an in-place "Access restricted to administrators." card branch with NO redirect, URL stays at /dashboard/leave-management, queue chrome doesn't render); page.route stubs short-circuit list GET + approve/reject PATCHes so request bodies are pinned without polluting the shared admin seed across runs. Original P7 framing's other scenarios deferred — bulk CSV staff import + fine-grained permission matrix UI are NOT shipped on the current /dashboard/users surface (no upload input, no POST /users/bulk endpoint); role-change-with-effective-DATE is shipped immediate-only (no effective-date field on PATCH /users/:id) and the basic role-change is already covered by users.spec.ts test 3; deactivation/reactivation lifecycle is already covered by users.spec.ts test 2; payroll-run is already closed by payroll.spec.ts (7 cases, 2026-05-03); shift-conflict UI not shipped (markOverlappingShifts at leaves.ts:53 is BACKEND-side post-approve, no client-facing collision warning yet))
- **File:** `e2e/hr-operations.spec.ts`
- **Why:** Operational continuity, payroll compliance, shift-hour tracking
- **Scenarios:**
  - ~~Employee submits leave request via `/dashboard/my-leaves`~~ already covered by `e2e/my-leaves.spec.ts` (6 tests, see §2.4 above)
  - ~~Manager approves/rejects → notification flow~~ ✅ pinned via approve PATCH body-shape stub + reject-with-reason modal stub (empty-reason gate + filled-reason round-trip)
  - ~~Bulk-import staff via CSV at `/dashboard/users`~~ deferred — feature not shipped (no upload input on page.tsx, no POST /users/bulk endpoint)
  - ~~Permission matrix assignment (fine-grained RBAC)~~ deferred — only the 7-role enum at packages/shared/Role exists, no per-action permission UI shipped
  - ~~Role change with effective date~~ deferred — shipped role-change is immediate (no effective-date field); already covered immediately by users.spec.ts test 3 with live PATCH round-trip
  - ~~Deactivation + reactivation~~ already covered by users.spec.ts test 2 (live disable round-trip with self-action guard)
  - ~~Payroll run at `/dashboard/payroll` → payslip generation~~ already closed by `e2e/payroll.spec.ts` (7 tests, see §2.4 above)
  - ~~Shift conflict detection during scheduling~~ deferred — markOverlappingShifts at leaves.ts:53 is BACKEND-side post-approve fire-and-forget, no client-facing collision warning UI shipped on /dashboard/schedule

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

### ~~P9 — ER reassessment & disposition pathing~~ ✅ closed 2026-05-05 by `e2e/er-disposition.spec.ts` (5 cases — NURSE reassessment URGENT→EMERGENT deterioration upgrade pins PATCH /triage body shape + DOCTOR disposition flip DISCHARGE→ADMIT pins close-panel body shape with status=ADMITTED triggering admission flow + DOCTOR discharge-with-summary modal contract pin (status select scoped via `select:has(option[value="LEFT_WITHOUT_BEING_SEEN"])` to dodge LanguageDropdown gotcha #9 + close-disposition input testid + close-outcome-notes textarea testid + close-case-btn CTA testid) + DOCTOR transfer-to-another-facility status=TRANSFERRED + referral packet outcome-notes pin + PATIENT/PHARMACIST UNIVERSAL-ACCESS archetype pin (CLAUDE.md gotcha #7 archetype 3 — no `VIEW_ALLOWED`, no useEffect router.push/replace anywhere in page.tsx, server-side authorize() at emergency.ts:181 omits PATIENT/PHARMACIST so /cases/active 403 surfaces as soft failure on the chrome, NOT a redirect — confirms 6th cron-learning bullet's archetype 3 case where there is no redirect target at all); page.route stubs short-circuit PATCH /triage and PATCH /close so request bodies are pinned without polluting the shared seed across runs; overflow/waitlist branching + fast-track-vs-standard path comparison from the original backlog framing turned out to be aspirational — current page surface is a 4-column kanban (Waiting / Triaged / In Treatment / Disposition Pending) with no fast-track lane and no overflow waitlist, so those scenarios are deferred until the underlying UI ships)
- **File:** `e2e/er-disposition.spec.ts`
- **Why:** Triage accuracy affects safety + ER throughput
- **Scenarios:**
  - ~~Reassess patient mid-wait → triage-level update + audit~~ ✅ pinned via NURSE URGENT→EMERGENT pill flip + PATCH /triage body capture
  - ~~Doctor changes disposition (discharge → admit) → admission flow triggered~~ ✅ pinned via close-panel status select flip + PATCH /close body shape (status: "ADMITTED")
  - ~~Discharge with summary + followup orders~~ ✅ pinned via close-panel modal contract + outcome-notes content carrying followup orders
  - ~~Transfer to another facility with referral packet~~ ✅ pinned via status: "TRANSFERRED" + outcome-notes referral packet text
  - Overflow → waitlist branching (deferred — backlog framing was aspirational; no overflow lane exists in current /dashboard/emergency surface)
  - Fast-track vs. standard path comparison (deferred — same reason, no fast-track lane in current kanban)

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
- ~~`/dashboard/antenatal/[id]` prenatal visit cadence~~ ✅ closed 2026-05-05 by `e2e/antenatal-id.spec.ts` (5 cases; structural skeleton + delivered-conditional surfaces + BOLA pass-through, paired with `e2e/antenatal.spec.ts` per §2.12)
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

- ~~**`bloodbank` vs `blood-bank`** and `operating-theaters` vs `operating-theatres` — duplicate routes? Confirm canonical and remove the other before writing specs to avoid double-coverage.~~ ✅ resolved 2026-05-05: `operating-theaters` + `operating-theatres` BOTH client-side redirect stubs to canonical `/dashboard/ot` (Issue #158); `e2e/operating-theatres.spec.ts` covers the alias contract.
- ~~**`medication` vs `medication-dashboard`** — clarify scope so admissions-mar coverage doesn't drift.~~ ✅ resolved 2026-05-05: `/medication` is a client-side redirect stub to canonical `/medication-dashboard` (Issue #136); `e2e/medication-dashboard.spec.ts` owns the dashboard CHROME + redirect contract, `e2e/admissions-mar.spec.ts` owns the multi-role ORDER FLOW — no overlap.
- **`reports/scheduled` vs `scheduled-reports`** — same content or different? Pick one.
- **Mobile app scope** — is `apps/mobile` shipping in the next release, or is it pre-alpha? Determines whether to invest in Detox/Maestro now or defer.
- **Razorpay / WhatsApp / Sarvam** — are sandbox creds available in CI for `E2E_FULL`? Without them, integration coverage stays mocked.
- **DB-reset strategy** — per-test transactional rollback vs. per-suite truncate. Affects flake rate at scale.
