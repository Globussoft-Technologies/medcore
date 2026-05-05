# Changelog

All notable changes to MedCore are documented here. This project follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and adheres (loosely)
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Session window: 2026-04-30 → 2026-05-05. Focus: CI hardening Phases 1-4,
test-coverage closure across §A-§E gaps, Playwright stabilization
across Chromium + WebKit, the local-first test workflow, and the
2026-05-05 CI-unblock + A2/A10 architectural closure.

### Added
- **2026-05-05 cron-tick wave 27 — §3 deepening (lab-tech-deep + patient-detail-deep).**
  Lane A (`5c41e0c`) shipped `lab-tech-deep.spec.ts` (6 cases — heavy
  use of API-contract-pin pattern: 4 of 5 deepening items where API
  ships but UI doesn't (verify sign-off, repeat-test reorder, amendment
  trail, batch results)). Lane B (`ea23a8c`) shipped `patient-detail-
  deep.spec.ts` (6 cases — advance directives + DNR banner +
  LIFE_THREATENING severity tier + insurance read-only + MRN merge
  ADMIN-only + med-recon API-contract-pin). 12 new tests × 2 projects
  = 24 listed cases. **Concrete bug shadow surfaced**: `PatientDetail`
  TS interface declares `insuranceId` but Prisma schema field is
  `insurancePolicyNumber` — UI at `page.tsx:671` reads a field the
  API never returns. Real evidence of the discipline's value: the
  pre-flight grep surfaces issues beyond test scaffolding. Cumulative
  ~50+ deferred-or-contract-pinned sub-scenarios across 7 cron ticks.
- **2026-05-05 cron-tick wave 26 — §3 deepening (ot-surgery-deep + telemedicine-deep) + 7th cron-learning bullet refined with API-ahead-of-UI sub-pattern.**
  Lane A (`5ae09c4`) shipped `ot-surgery-deep.spec.ts` (6 cases —
  anesthesia + clinical-notes + complications + PACU + SSI + RBAC).
  Lane B (`da3b4c3`) shipped `telemedicine-deep.spec.ts` (7 cases —
  recording consent gate + recording archive URL + followup PATCH +
  post-consult Rx + payment fee + WebRTC quality proxy + cross-role/
  cross-patient RBAC + PATIENT chrome). 13 new tests × 2 projects =
  26 listed cases. **NEW meta-finding**: telemedicine route handler
  ships 4 fully-validated/authorized/audit-logged endpoints (recording-
  consent, followup, Rx, payment) with regulatory weight, yet ZERO
  UI surfaces them — the "API-ahead-of-UI" sub-pattern of the
  aspirational-framing recurrence. **7th cron-learning bullet
  refined** with an API-contract-pin escape valve: when backend ships
  but UI doesn't, write `page.route` stub + body-shape assertion to
  lock the contract for the future UI builder rather than fabricating
  selectors. Pattern: "test the wire, not the widget." Cumulative ~47
  deferred-with-evidence sub-scenarios across 6 cron ticks.
- **2026-05-05 cron-tick wave 25 — §4.2 mobile-responsive + §4.9 realtime.**
  Lane A (`40addd7`) shipped `mobile-responsive.spec.ts` (6 cases —
  ADMIN appointments + RECEPTION billing + DOCTOR prescriptions mobile
  drawer parity + PATIENT bottom-nav active-state + tap polyfill +
  DataTable mobile-card on /users). Lane B (`88dfabc`) shipped
  `realtime.spec.ts` (5 cases — Socket.IO queue handshake + Issue
  #430 poll-fallback + WS-block degradation + 2 structural-NOT pins
  for PATIENT-WS gate and audit-no-subscribe). 11 new tests × 2
  projects = 22 listed cases. **VERIFY-BEFORE-SCAFFOLD found 6 of 10
  sub-scenarios DEFERRED** with concrete evidence: long-press/swipe
  (zero hits in apps/web/src), mobile error states (no online/offline
  outside /display), bottom-sheet (no BottomSheet component, all
  modals render fixed inset-0 flex), in-app notification push (no
  `notification:*` socket event), audit-log streaming (audit.ts has
  zero io.emit), telemedicine WebRTC signaling (only admission/
  recording events). Cumulative 42 deferred-with-evidence across
  waves 21+22+23+24+25. **Architectural findings**: (1) mobile UX
  is Tailwind-class-only, no behavior layer for swipe/long-press/
  bottom-sheet; (2) Socket.IO is wired for queue/emergency/ot/wards/
  chat/agent-console but in-app notification push + audit streaming
  are NOT shipped — backlog framing was aspirational.
- **2026-05-05 cron-tick wave 24 — §4.8 file-operations + §4.13 i18n.**
  Lane A (`5dca914`) shipped `file-operations.spec.ts` (5 cases —
  patient document upload + ai-radiology X-ray + avatar upload + PATIENT
  canEdit gate + PATIENT VIEW_ALLOWED bounce). Lane B (`27149c4`)
  shipped `i18n.spec.ts` (5 cases — language-switcher interaction +
  localStorage persistence + PATCH /auth/me server sync (Issue #137) +
  `<html lang>` reflection + Devanagari UI re-translation + default
  state). 10 new tests × 2 projects = 20 listed cases. **VERIFY-
  BEFORE-SCAFFOLD found 11 of ~15 sub-scenarios DEFERRED** with
  concrete evidence: bulk patient/Rx CSV import (no UI), Excel export
  (CSV-only map), virus-scan UI (server sniffs only), inline
  attachment preview (window.open), RTL layout (Lang type =
  "en"|"hi", no dir-set call sites), locale-specific date/number
  formatting (every Intl.* call hard-coded en-IN). Cumulative 36
  deferred-with-evidence sub-scenarios across waves 21+22+23+24.
  **Architectural finding**: i18n is hand-rolled Zustand (not
  next-intl/react-i18next); no RTL plumbing; locale formatting fully
  hard-coded — would need an Intl.NumberFormat(lang, ...) /
  formatRelativeTime(lang, ...) wrapper lift. Worth a future story.
- **2026-05-05 cron-tick wave 23 — pivot to §4 cross-cutting (print-pdf + negative-paths).**
  Lane A (`611cbfc`) shipped `print-pdf.spec.ts` (5 cases — Rx + invoice +
  discharge-summary + lab-order PDF round-trips + PAID/CANCELLED/DRAFT
  watermark overlay). Lane B (`f19bf5c`) shipped `negative-paths.spec.ts`
  (6 cases — login 401 + register 5xx page-level retry + patients 409 +
  patients 400 + /display offline banner). 11 new tests × 2 projects =
  22 listed cases. **VERIFY-BEFORE-SCAFFOLD found 7 of 15 sub-scenarios
  DEFERRED** with concrete evidence: clinical watermark + batch print
  (no UI), 503 auto-retry (api.ts throws no retry), offline+sync-on-
  reconnect (no online/offline listeners outside /display kiosk),
  beforeunload mid-form warning (0 repo hits), file-size JS validation
  (only HTML `accept=` attr), AV-scan feedback (no UI). Cumulative
  25 deferred-with-evidence sub-scenarios across waves 21+22+23 —
  the 7th cron-learning bullet's discipline continues to surface real
  backlog-vs-shipped gaps. **Architectural finding**: codebase has NO
  generic retry/circuit-breaker/offline-sync infrastructure — every
  page that wants retry-on-error renders its own button (only /register
  today).
- **2026-05-05 cron-tick wave 22 — §5 P5 admission-discharge-flow + P8 insurance-claims-lifecycle.**
  Lane A (`02487e7`) shipped `admission-discharge-flow.spec.ts` (6 cases
  — RECEPTION admit-form + DOCTOR med-orders + NURSE MAR skip + Doctor
  transfer/discharge + inter-ward transfer + discharge-summary med-
  recon). Lane B (`5aeae12`) shipped `insurance-claims-lifecycle.spec.ts`
  (5 cases — Submit + reconciliation 2-branch + denied-reason banner +
  EntityPicker bill-picker contract). 11 new tests × 2 projects = 22
  listed cases. **VERIFY-BEFORE-SCAFFOLD audit found 8 of 14
  sub-scenarios DEFERRED** with concrete evidence: vitals frequency +
  diet (no UI), post-discharge followup auto-schedule (only free-text
  followUpInstructions persists, no /followups POST), LOS in /census
  (occupancy counts only), claim auto-polling (drawer ?sync=1 exists
  but no client poller), appeal flow (zero matches in page.tsx),
  multi-policy COB (single policyNumber field), aging report (no
  /aging route). **Cumulative 18 deferred-with-evidence sub-scenarios
  across waves 21+22** validates the 7th cron-learning bullet's
  VERIFY-BEFORE-SCAFFOLD discipline.
- **2026-05-05 cron-tick wave 21 — §5 P2 prescription-lifecycle + P3 pharmacy-inventory (first wave applying VERIFY-BEFORE-SCAFFOLD discipline).**
  Lane A (`4e847d5`) shipped `prescription-lifecycle.spec.ts` (5 cases —
  DDI warning + Share-via-Email + RBAC asymmetry). Lane B (`de555e0`)
  shipped `pharmacy-inventory.spec.ts` (5 cases — Low-Stock + Expiring-
  Soon + canManage gate). 10 new tests × 2 projects = 20 listed cases.
  **The 7th cron-learning bullet worked as designed**: 10 sub-scenarios
  across both lanes were DEFERRED with explicit evidence-citations
  (page.tsx line refs OR route-file absence proofs), preventing
  fabricated tests against ghost UI. P2 deferred: drug-allergy warning
  (no UI), edit-existing-Rx (no endpoint), cancel-Rx (no endpoint),
  patient refill request (excludes PATIENT in API), pharmacist
  rejection (no endpoint). P3 deferred: catalog (covered elsewhere),
  dispense-after-expiry (server-side only, no UI), stock-count-
  adjustment (POST exists, 0 UI consumers), PO+consumption (owned by
  other specs). Validates the verify-before-scaffold discipline from
  the 7th cron-learning bullet.
- **2026-05-05 cron-tick wave 20 — §5 P1 billing-line-items + P4 doctor-chart-review.**
  Lane A (`aaa9ad4`) shipped `doctor-chart-review.spec.ts` (6 cases —
  AllergyForm POST shape + TrendSparkline SVG + Documents IMAGING group
  + Caregiver/family CRUD). Lane B (`de0f396`) shipped
  `billing-line-items.spec.ts` (5 cases — UI delete + audit-row pin +
  quantity-change-as-replace + partial-refund + credit-note API contract
  + over-credit 400 guard). 11 new tests × 2 projects = 22 listed cases.
  **NEW 7th cron-learning bullet** (RIPE on first capture, 6+ wave
  instances): backlog framing in `docs/E2E_COVERAGE_BACKLOG.md` is
  sometimes aspirational — describes intended UX rather than shipped
  behaviour. Multiple §5 P-priorities (P1 quantity-edit/period-lock/
  credit-note-UI/overpayment, P4 med-start-stop/reconciliation/imaging-
  viewer, P7 bulk-CSV/permission-matrix, P9 ER-overflow/fast-track,
  workspace "config", reports "department+metric filters") describe
  features not shipped. Bullet recommends a "verify-before-scaffold"
  step in `/medcore-e2e-spec` to grep page.tsx + API route file before
  writing tests, with explicit "UI not shipped" evidence-citations.
- **2026-05-05 cron-tick wave 19 — pivot to §5 P-priorities after §2 closure (P7 + P9).**
  Lane A (`a809efa`) shipped `er-disposition.spec.ts` (5 cases — ER
  reassessment + 3 disposition paths via `page.route` stubs;
  universal-access archetype). Lane B (`ce747a3`) shipped
  `hr-operations.spec.ts` (6 cases — leave-management approval queue;
  inline "Access restricted" archetype; 6 of 8 backlog scenarios
  deferred — bulk CSV import / permission matrix / role-effective-date
  / shift-conflict UI not shipped, dedup with users.spec.ts +
  payroll.spec.ts already covering deactivation + payslips). 11 new
  tests × 2 projects = 22 listed cases. **5th cron-learning bullet
  RIPENED to 3 instances**: leave-management joined ai-kpis + ai-fraud
  as the 3rd inline-admin-gate-placeholder shape. Testid convention
  drift across the 3 instances is itself a meta-finding — bullet now
  recommends a normative `<route>-admin-gate` testid convention for
  new pages adopting this shape.
- **2026-05-05 cron-tick wave 18 — E2E coverage §2 backlog tail CLOSED + §5 P6.**
  Lane A (`0c0b2aa`) shipped `tenants-onboarding.spec.ts` (5 cases —
  redirect-bounce to /dashboard) + `visitors.spec.ts` (7 cases —
  redirect-bounce to **/dashboard/not-authorized** per page.tsx:65-72,
  the rare archetype variant joining lab-intel as the 2nd instance).
  Lane B (`3123eb2`) shipped `reports-custom.spec.ts` (7 cases —
  forward-flow deepening of the white-screen-regression-only
  `e2e/reports.spec.ts`; Generate modal POST shape + Schedule modal
  POST shape + CSV-Export `page.waitForEvent('download')` contract).
  19 new tests × 2 projects = 38 listed cases. **6th cron-learning
  bullet updated to 12 instances at 10:2 ratio**: redirect-bounce
  target `/dashboard` confirmed in 10 pages, `/dashboard/not-
  authorized` in 2 pages (visitors joined lab-intel). Bullet now
  solidly RIPE for promotion to `/medcore-e2e-spec`. **Notable**:
  /dashboard/reports backlog framing "department + metric filters"
  was aspirational — actual page is a Daily Collection / Report History
  2-tab surface with Generate + Schedule modals (Issue #301).
- **2026-05-05 cron-tick wave 17 — E2E coverage backlog (admin-config + clinical schedule + bulk billing).**
  Lane A (`504c48f`) shipped `workspace.spec.ts` (7 cases — DOCTOR-only
  personal cockpit; backlog phrasing was aspirational, actual surface
  is a queue+tasks aggregator) + `certifications.spec.ts` (6 cases —
  UNIVERSAL-ACCESS, hr-ops API self-scope). Lane B (`8179125`) shipped
  `billing-patient.spec.ts` (6 cases — REDIRECT-BOUNCE to `/dashboard`
  per Issue #385 + RECEPTION bulk-payment + bulk-discount flows) +
  `immunization-schedule.spec.ts` (5 cases — UNIVERSAL-ACCESS + Issue
  #426 closure-trap regression guard). 24 new tests × 2 projects = 48
  listed cases. **6th cron-learning bullet updated to 9 instances
  (8:1 ratio)**: redirect-target `/dashboard` confirmed in 8 pages,
  `/dashboard/not-authorized` remains 1 (lab-intel). Final §2 backlog
  tail: tenants/[id]/onboarding + visitors (next cron tick).
- **2026-05-05 cron-tick wave 16 — E2E coverage backlog (staff scheduling + antenatal clinical).**
  Lane A (`374bba9`) shipped `my-schedule.spec.ts` (5 cases) +
  `calendar.spec.ts` (5 cases) — both UNIVERSAL-ACCESS archetype.
  Lane B (`71bb3ff`) shipped `antenatal.spec.ts` (6 cases) +
  `antenatal-id.spec.ts` (5 cases) — both UNIVERSAL-ACCESS archetype
  with server-side `assertPatientOwnsResource` BOLA gating for
  /[id]. Notable: 1672-LOC chart-drilldown was tested via
  `page.route` stubs of `/api/v1/antenatal/cases/:id` to stay
  deterministic without polluting shared seed. PATIENT BOLA-403
  pass-through pinned: page sits in "Loading…" rather than
  crashing/bouncing — graceful UX. 21 new tests × 2 projects = 42
  listed cases. No new cron-learning bullet — all 4 pages confirmed
  the UNIVERSAL-ACCESS archetype already documented in CLAUDE.md
  gotcha #7.
- **2026-05-05 cron-tick wave 15 — E2E coverage backlog (dedup resolution + clinical/interop).**
  Lane A (`443d3af`) shipped `operating-theatres.spec.ts` (5 cases) +
  `medication-dashboard.spec.ts` (5 cases). **Two backlog dedup questions
  RESOLVED**: (1) `/operating-theaters` AND `/operating-theatres` are
  BOTH redirect aliases to `/dashboard/ot` (Issue #158); (2)
  `/medication` is a redirect alias to `/medication-dashboard`
  (Issue #136). 6 backlog items + 2 §9 Open Questions closed in one
  spec each. Lane B (`bfe9c58`) shipped `lab-intel.spec.ts` (7 cases)
  + `fhir-export.spec.ts` (7 cases). 24 new tests × 2 projects = 48
  listed cases. **6th cron-learning bullet RIPENED with nuance**:
  redirect-bounce target convention is now a 6:1 split — `/dashboard`
  is dominant; `/dashboard/not-authorized` is the rare explicit
  access-denied UX (Issue #179, only lab-intel). Skill extension
  recommendation: grep page.tsx for the actual `router.push/replace`
  target before writing the test assertion.
- **2026-05-05 cron-tick wave 14 — E2E coverage backlog (admin/staff workflows + multi-tenant + clinical).**
  Lane A (`e9e032a`) shipped `e2e/agent-console.spec.ts` (7 cases —
  3-pane chrome + Suggest-this-doctor round-trip) + `e2e/workstation
  .spec.ts` (7 cases — NURSE quick-actions + Record-Vitals deep-link +
  Issue #432 fallback). Lane B (`d43be97`) shipped `e2e/tenants.spec.ts`
  (6 cases — ADMIN-only multi-tenant admin) + `e2e/referrals.spec.ts`
  (7 cases — universal-access with API-side RBAC). 27 new tests × 2
  projects = 54 listed cases. **6th cron-learning bullet added**:
  redirect-bounce target convention is `/dashboard`, NOT `/dashboard/
  not-authorized` — confirmed across 5+ recently-audited pages
  (agent-console, workstation, tenants, insurance-claims, audit). Skill
  extension: add redirect-target sub-pattern to the 3-archetype page-
  shape decision matrix in `/medcore-e2e-spec`. **5th bullet stays at
  2 instances** — agent-console did not confirm a 3rd admin-gate-
  placeholder instance (uses redirect-bounce instead).
- **2026-05-05 cron-tick wave 13 — E2E coverage backlog (AI surfaces + compliance).**
  Lane A (`e8c648d`) shipped `e2e/ai-booking.spec.ts` (5 cases —
  universal-access pre-chat selector page) + `e2e/ai-fraud.spec.ts`
  (6 cases — inline admin-gate placeholder, allow-set {ADMIN,RECEPTION}).
  Lane B (`b155758`) shipped `e2e/insurance-claims.spec.ts` (7 cases —
  ADMIN queue + status-filter query-string contract + row→drawer
  timeline + RECEPTION parity + Issue #302/#458 client-guard) +
  `e2e/audit.spec.ts` (7 cases — Issue #79 entity-canonicalisation +
  Issue #192 entityLabel render). 25 new tests × 2 projects = 50 listed
  cases. **5th cron-learning bullet RIPENED**: admin-gate-placeholder
  archetype now has 2 confirmed instances (ai-kpis with dedicated
  gate-testid + ai-fraud with reused outer-wrapper testid). Worth
  promoting `/medcore-e2e-spec` with a 3-archetype page-shape decision
  matrix + a `<route>-admin-gate` testid-naming recommendation for
  new pages adopting this shape.
- **2026-05-05 cron-tick wave 12 — E2E coverage backlog (profile + capacity-forecast + ai-kpis).**
  Lane A (`8a869c8`) shipped `e2e/profile.spec.ts` covering BOTH
  `/dashboard/profile` and the `/dashboard/account` redirect alias
  (Issue #303). **Notable**: profile.tsx is NOT a tabbed surface
  despite backlog framing — only header card + Personal Details +
  Change-Password modal; 2FA/notifications/sessions live on
  `/dashboard/settings`. Universal-access (every authed role).
  Lane B (`36b6532`) shipped `e2e/capacity-forecast.spec.ts` (7 cases)
  + `e2e/ai-kpis.spec.ts` (7 cases). **Cron-learning bullet added**:
  ai-kpis surfaced a 3rd page-shape archetype — neither redirect-bounce
  nor universal-access, but an "admin-gate placeholder" rendered
  inline (data-testid="ai-kpis-admin-gate" replaces data panels for
  non-ADMIN). CLAUDE.md gotcha #7 had codified only 2 archetypes;
  the 5th cron-learning bullet recommends extending
  `/medcore-e2e-spec` with a 3-archetype decision matrix when 1 more
  instance recurs. 20 new tests × 2 projects = 40 listed cases.
- **2026-05-05 cron-tick wave 11 — E2E coverage backlog (communications + analytics-reports).**
  Lane A (`b921bca`) shipped `e2e/notifications-delivery.spec.ts`
  (7 cases) + `e2e/notification-templates.spec.ts` (7 cases) — both
  pages ADMIN-only via `useEffect` router.push redirect; same shape as
  `broadcasts.spec.ts`. Lane B (`342851c`) shipped
  `e2e/reports-scheduled.spec.ts` (7 cases) + `e2e/analytics-reports
  .spec.ts` (6 cases). **Notable find**: `/dashboard/reports/scheduled`
  vs `/dashboard/scheduled-reports` dedup question (open in the
  backlog since the audit was written) is RESOLVED — the former is a
  client-side redirect (Issue #80 compat shim) onto the latter. Plus
  `6ab4d4c` fixed an in-flight test regression in
  `cross-patient-ehr.test.ts` (`type: "REPORT"` in fixture data; the
  Prisma `DocumentType` enum has no `REPORT` member, only `LAB_REPORT`/
  IMAGING/DISCHARGE_SUMMARY/CONSENT/INSURANCE/REFERRAL_LETTER/ID_PROOF/
  OTHER; vitest was silently skipping all 36 tests because the beforeAll
  Prisma error coerced them to "skipped" while marking the test FILE
  as failed — masked in earlier-wave test.yml summaries). 27 new E2E
  tests × 2 projects = 54 listed cases.
- **2026-05-05 cron-tick wave 10 — E2E coverage backlog pivot (4 new specs, 26 new tests).**
  After #511 long-tail closed, the cron pivoted to `docs/E2E_COVERAGE_
  BACKLOG.md` §2 zero-coverage routes. Lane A (`9802de0`) shipped
  `e2e/problem-list.spec.ts` (6 cases) + `e2e/my-activity.spec.ts`
  (6 cases). Lane B (`be9bdf7`) shipped `e2e/bill-explainer.spec.ts`
  (7 cases) + `e2e/discount-approvals.spec.ts` (7 cases). Backlog
  annotated for the 4 closures. **Surprising finds**: (1) problem-list
  page is currently READ-ONLY despite backlog framing as "add/edit/
  delete" — annotated as future intent; (2) bill-explainer page renders
  Approve CTA for RECEPTION but the POST API gate is ADMIN-only (UI/API
  consistency gap, not a security issue). 26 new tests × 2 Playwright
  projects = 52 listed cases.
- **2026-05-05 cron-tick wave 9 — final long-tail BOLA closure (#511 long-tail CLOSED).**
  Lane A (`ee5dd4b` + `69086ab` + `e4a862b`) closed hr-ops + leaves +
  medicines. **1 real BOLA**: `leaves.ts GET /:id/letter` had ZERO
  gating — generated a downloadable leave letter (employee PII +
  manager name + dates) for ANY caller including PATIENT. Sibling
  `PATCH /:id/cancel` had the canonical "owner OR ADMIN" inline check
  but the letter handler missed it; fix mirrors the sibling. The bug
  was a paper-cut sibling-handler-inconsistency, not a new pattern —
  no cron-learning bullet warranted. hr-ops 100% verified-safe (User-
  keyed HR resources + per-handler `authorize(ADMIN)`). medicines 100%
  verified-safe (catalog with no patientId FK, eager-include only
  exposes `inventoryItems` SKU/price/expiry — no patient PII; eager-
  include lens applied + cleared). Lane B (`26a9ee5`) closed
  scheduled-reports + shifts + tenants — all 100% verified-safe via
  router-level `authorize(ADMIN)` mounts (scheduled-reports, tenants)
  or per-handler self-scope (shifts; HR resource keyed to staff
  User.id). 4 new tests in 1 new file. **Today's running totals across
  9 #511 waves**: 69 real BOLA fixes + 187 verified-safe across 36
  route files; ~246 new test cases. **#511 ready for closure** —
  0 long-tail routes remain.
- **2026-05-05 cron-tick wave 8 — long-tail BOLA closure (2-agent fanout, 6 routes).**
  Lane A (`81cf8b4`) closed agent-console + ai-admin + analytics — all
  37 handlers verified-safe via router-level `authorize()` mounts that
  exclude PATIENT (RECEPTION+ADMIN, ADMIN, ADMIN+RECEPTION+DOCTOR
  respectively). Lane B (`33b02c6`) closed chat + controlled-substances
  + doctors — 2 real BOLAs found: (1) **chat `POST /rooms/:id/typing`**
  was missing the participant + ADMIN-bypass check that every other
  `/rooms/:id/*` handler had; any authed user could spam typing events
  into rooms by guessing IDs. (2) **doctors `GET /` catalog** leaked
  `user.email + user.phone` for every doctor to PATIENT callers — 2nd
  instance of the eager-include leak pattern after `packages.ts` wave 5,
  fix branched the projection by role (staff get full include, PATIENT
  gets minimal `name + speciality` slot). controlled-substances was
  router-level safe (`authorize(ADMIN, PHARMACIST, DOCTOR)` excludes
  PATIENT). 5 new tests in 2 new files (cross-patient-chat,
  cross-patient-doctors). CLAUDE.md Cron Learnings: "eager-include
  leak in catalog endpoints" bullet bumped to 2 instances — **RIPE
  for promotion** (identical fix pattern across both finds).
- **2026-05-05 cron-tick CI-unblock wave — 3 regression fixes from today's BOLA waves.**
  `a5a6224` diagnosed `dbf45d4`'s `test.yml` (a docs-only commit, no code
  changed) failing 6 tests across 4 files. Three independent regressions:
  (1) **lab.ts route-shadow** — `GET /results/:orderItemId` declared at
  line 556 with the more-specific `GET /results/trends` and
  `GET /results/pending-verification` declared later; Express bound the
  literal strings 'trends' / 'pending-verification' to `:orderItemId`,
  the static handlers never ran (404 against the literal). Moved both
  before the dynamic route + added a route-ordering note to keep the
  invariant after future edits. (2) **patients.ts:134 helper-arg bug**
  introduced earlier today by `80c4b89` — called
  `assertPatientOwnsResource(req, res, patient.user?.id)` passing the
  User row id where the helper expects the Patient row id; helper found
  no Patient WHERE id=user.id and 403'd PATIENT-A on their own chart.
  Fixed to pass `patient.id`. Repo-wide grep confirmed no other call
  sites had the same shape. (3) **prescriptions test:417** asserted
  `/own/i` from a legacy hand-rolled error string; today's #511 sweep
  refactored the handler onto the canonical helper which emits
  'Forbidden'. Test updated to match canonical contract. CLAUDE.md
  Cron Learnings: bullet added for the Express route-shadow + helper-
  arg-shape mistakes (both are cheap grep checks a
  `/medcore-bola-sweep` post-fix-verification lane could add).
- **2026-05-05 cron-tick wave 6 — uploads + notifications + ai-knowledge (1 BOLA + 2 verified-safe).**
  Solo agent sweep. `c6ceca5` shipped 1 real BOLA in uploads
  `GET /:filename` (legacy filename endpoint): any PATIENT could fetch
  any file in UPLOAD_DIR by name including other patients' medical
  documents. **Subtle shape**: `checkDocumentAccess` helper already
  existed in the file (wired to `/document/:id`) but never extended
  to the legacy `/:filename` path. Fix reverse-looks up `PatientDocument`
  by `filePath endsWith basename` + runs the existing helper. Non-medical
  files (avatars, signed-URL artefacts) keep legacy behaviour to avoid
  regressing non-medical use. notifications.ts (16 handlers, all
  self-scoped by userId or per-row gated) and ai-knowledge.ts (router-
  level `authorize(Role.ADMIN)` — even DOCTOR denied) entirely
  verified-safe. 15 tests. CLAUDE.md Cron Learnings: "writes-gated,
  reads-bare" pattern bumped to 3 instances; new bullet for "eager-
  include leak in catalog endpoints" (single instance from packages
  wave 5; ripe-when-promoted on a 2nd instance).
- **2026-05-05 cron-tick wave 5 — preauth + packages (5 more real BOLA fixes).**
  Single-agent sweep on the next 2 long-tail files. `3beeeaf` shipped:
  preauth `GET /` (PATIENT could list all preauths via `?patientId=`
  query bypass — now hard-scoped server-side); preauth `GET /:id`
  (helper); packages `GET /purchases` + `GET /purchases/:id` (helper);
  and the **most subtle find of the day** — packages catalog
  `GET /:id` had an eager `include: { purchases: { patient: { user } } }`
  block exposing up-to-10 purchaser identities (name + phone) to any
  PATIENT hitting the catalog detail. Eager-include now stripped for
  PATIENT role, kept for staff. 19 tests. Cron Learnings bullet added
  to `CLAUDE.md` for the "writes-gated, reads-bare" inverse pattern
  (3 instances now: pharmacy GETs, med-reconciliation GETs, preauth
  list — skill-extension candidate after the next confirming cycle).
- **2026-05-05 cron-driven #511 wave (3-agent fanout) — 13 more real BOLA fixes across 5 route files.**
  First production firing of the post-restart cron with the no-skill-
  edit prompt. `a54606e` patient-data-export (PII export — 2 PATCHED
  via canonical helper + 2 VERIFIED-SAFE; DPDP Act 2023 portability
  surface, cross-patient test asserts DOCTOR → 403 since no staff
  read path; 8 tests). `585b757` patient-extras + med-reconciliation
  (1 BOLA on `GET /patients/:id/ccda` — full-PHI CCDA bundle was
  cross-patient readable; 3 staff-only closures on med-reconciliation
  bare GETs while POST/PATCH were gated — "writes-gated, reads-bare"
  pattern flagged for future grep; 11 tests). `4f02a2e` pharmacy +
  payment-plans (4 pharmacy staff-only closures: `/inventory/barcode/
  :barcode`, `/substitutes/:medicineId`, `/returns`, `/transfers`;
  **payment-plans worst find of the batch**: `GET /` honored client-
  supplied `?patientId=` unconditionally, server now auto-scopes to
  caller's own Patient row for PATIENT role; plus `/:id` patched +
  `/overdue` staff-only; 14 tests). Today's running totals across
  all 4 #511 waves: 60 real BOLA fixes + 81 verified-safe across 19
  route files; ~203 new test cases. Long tail down from ~21 to ~16
  routes.
- **2026-05-05 #511 expanded-criterion wave (4-agent fanout via `/medcore-bola-sweep`) — 13 more real BOLA fixes across 4 route files + harness defaultMode fix.**
  Cron-driven follow-up after the skill was updated with the
  "Expanded audit criterion" (handlers WITH `authorize()` containing
  `Role.PATIENT` but no per-row check). Surfaced after two extra-grep
  finds in the long-tail wave (appointments `PATCH /:id/reschedule`,
  growth `POST /:id/feeding`) showed the original audit pattern was
  incomplete. `27eb610` ai-bill-explainer + ai-followup + ai-previsit
  (1 real BOLA in ai-followup `POST /:consultationId/book` — PATIENT
  could book under another's consultation; 2 refactors). `5b31ee7`
  prescriptions (**2 real BOLAs in `GET /:id/pdf` and `GET /:id/leaflets`**
  — both leaked prescription PHI by id; original #474 sweep only
  caught headline `/:id`; 1 refactor). `c015bd5` coordinated-visits
  (1 real BOLA on `GET /:id`, strict-self semantic decision since
  schema is single-patient not multi-member). `1285c8f` lab + billing
  (**9 real BOLAs** including 4 in lab and 5 in billing; verify-payment
  ownership gate placed BEFORE signature verification so gate is
  payload-independent; surprise: `GET /billing/invoices/:id` claimed
  in brief to be #474-covered but actually wasn't, real open gap now
  patched). ~62 new test cases.
- **`permissions.defaultMode: "acceptEdits"`** in `.claude/settings.json`
  (`ad30920`). Auto-accepts Edit/Write/MultiEdit operations; Bash still
  goes through the allow list (where `Bash(*)` lives). Necessary for
  the unattended cron-driven autopilot pattern. Effective at next
  Claude Code restart.
- **2026-05-05 #511 long-tail wave (5-agent fanout via `/medcore-bola-sweep`) — 15 real BOLA fixes + 39 verified-safe refactors across 5 more route files.**
  Cron-driven follow-up to the morning's 5-agent fanout. Used the new
  `/medcore-bola-sweep` skill (built earlier this cycle) to standardize
  the verdict matrix + per-route test file isolation. `7bc72c7` ehr
  (12 handlers refactored from a parallel local `assertPatientAccess`
  helper onto the canonical `assertPatientOwnsResource`; 1 PATCHED
  `GET /documents/:id` resolves Document → patientId; 39 test cases).
  `3d501f0` surgery (4 fixes — 2 PATCHED A3 add-parent-fetch on
  `/:id/anesthesia-record` + `/:id/observations`; 2 STAFF-ONLY on
  OT analytics endpoints; 10 tests). `dafad04` referrals + growth
  (9 PATCHED + 2 STAFF-ONLY; **worst single finding of the day**:
  growth `POST /:id/feeding` had PATIENT in `authorize()` with NO
  per-row check — cross-tenant PHI **write** vector; 32 tests).
  `b183fab` telemedicine (4 PATCHED action handlers — `PATCH
  /:id/join`, `/tech-issues`, `GET /:id/messages`, `POST /:id/messages`
  — plus 5 refactors of correct hand-rolled checks onto canonical;
  12 tests). `95cdc13` appointments + waitlist (**second-worst**:
  `PATCH /:id/reschedule` was an undisclosed BOLA, PATIENT in
  `authorize()` with zero per-row check; any patient could reschedule
  any appointment; not in audit-flagged list — extra-grep find;
  `/group/:groupId` correctly given membership-of-group check rather
  than strict patient-self since group appointments are coordinated
  visits where co-members SHOULD see roster; 14 tests).
  Combined with the morning's wave (admissions / antenatal / ai-
  adherence-coaching / ai-scribe-triage-explainer / bloodbank): 34
  real BOLA fixes + 45 verified-safe across 10 route files,
  ~120 new test cases. Issue #511 substantially closed; long tail
  ~25 lower-priority routes for future cycle.
- **`/medcore-bola-sweep` skill** (`6dd9705`) — codified the BOLA
  audit + fix workflow from the morning's 5-agent wave. Verdict
  matrix (PATCHED A1 direct-FK / A2 user-via-Patient-relation /
  A3 must-add-parent-fetch / VERIFIED-SAFE / STAFF-ONLY-via-authorize),
  per-route test file isolation convention, anti-patterns observed.
  CLAUDE.md gotchas #12 + #13 added (parent-fetch-required for
  `:childId` URLs; non-patient resources use `authorize()` not the
  helper). Settings broadened with literal `.claude/skills/**`
  patterns matching the user-supplied screenshot.
- **2026-05-05 #511 BOLA-closure wave — 5-agent fanout, 19 real gaps patched + 6 verified-safe across 5 route files.**
  After Issue #511 was filed (112 candidate handlers from a naive
  audit grep), the cron-driven workflow dispatched 5 agents in
  parallel — one per route-file lane. Net: **19 real BOLA / IDOR /
  CWE-285 gaps closed + 6 verified-safe-or-refactored, ~62 new test
  cases.** `c87107e` admissions (8 sub-resource handlers patched —
  4 of which lacked any parent findUnique at all; 24 cross-patient
  tests). `bfb52ab` antenatal (6/6 real gaps incl. ultrasound +
  postnatal-visits which queried child tables directly without
  loading the parent AntenatalCase; 18 tests). `fbc898d` ai-adherence
  + ai-coaching (naive grep was a false-positive — handlers had inline
  ownership checks; refactored 4 handlers to use the canonical
  `assertPatientOwnsResource` helper for drift prevention; 9 tests).
  `96b9700` ai-scribe + ai-triage + ai-report-explainer (3 real
  vulnerabilities + 1 drift-prone refactor; **triage DELETE was the
  worst** — zero pre-update validation, silent success on bad UUIDs;
  **scribe DELETE was the most damaging** — JWT-only auth and wipes
  `transcript` + nulls `soapDraft`; 12 tests). `a7bfc8c` bloodbank
  (4/4 real gaps; `BloodRequest` patient-owned via helper; `BloodDonor`
  sub-resources staff-only via `authorize()` since donors don't link to
  Patient; 4 regression cases; bonus: flagged `GET /requests`
  collection as also un-authorized — cross-patient enumeration,
  scoped out for a future sweep). Issue #511 substantially closed;
  long tail (~80 handlers in less-trafficked routes like appointments
  / billing / ehr / immunization / lab / pharmacy / insurance-claims)
  remains for a future sweep.
- **2026-05-05 cron-driven E2E wave v2 (4-agent fanout) + emergency security fix.**
  Auto-pilot cron `56a0a2ec` fired again at "waiting-on-CI" and dispatched
  4-agent fanout shipping 4 more truly-uncovered routes. `531bf15`
  `/dashboard/patients/[id]` (7 cases — full chart from doctor's
  perspective, Medical Records / Documents / Lab Results panels,
  SEVERE-allergy banner from seeded POST /ehr/allergies, ADMIN
  edit-asymmetry Issue #185, PHARMACIST/LAB_TECH route-shape pins).
  `9d7391a` `/dashboard/prescriptions/new` (6 cases — DOCTOR happy
  via EntityPicker patient + appointment → POST /prescriptions 201 →
  row in history; Zod-validation Issue #490 wording asserted; ADMIN
  UX-asymmetry pinned [in `RX_ALLOWED` so chrome renders, but the
  in-page CTA is `user.role === "DOCTOR"`-gated]; RECEPTION/LAB_TECH
  bounces). Surprise: `/dashboard/prescriptions/new` is just a 42-line
  redirect stub to `/dashboard/prescriptions?new=1&patientId=...`;
  the actual form lives on the parent route. `7c1f48d`
  `/dashboard/telemedicine/waiting-room` (7 cases — PATIENT precheck
  → join → WAITING traversal with WebRTC stubbed via `addInitScript`
  fake `navigator.mediaDevices.getUserMedia` + DOCTOR/NURSE access-
  shape + cross-patient 403 API guard). `0ff2e2d`
  `/dashboard/doctors/[id]` (4 cases — ADMIN happy + DOCTOR no-Edit-CTA
  + PATIENT route-shape + bad-UUID not-found amber panel).
  **Critical security fix surfaced and shipped same wave**:
  `GET /api/v1/patients/:id` (`patients.ts:99`) had NO `authorize()`
  middleware AND NO `assertPatientOwnsResource` — any authenticated
  user (including PATIENT) could fetch any patient's chart by UUID.
  IDOR / BOLA / OWASP API1:2023. The earlier #474 cross-patient sweep
  patched 11 other `/:id` handlers but missed this specific one. Fix
  applied: `assertPatientOwnsResource(req, res, patient.user?.id)`
  call after the `findUnique`. PATIENT callers must own the row;
  staff roles always pass per the helper's contract. 3 new regression
  assertions in `cross-patient-rbac.test.ts` (PATIENT-A → PATIENT-B
  403, PATIENT-A → own 200, DOCTOR → any 200).
- **2026-05-05 cron-driven E2E wave (4-agent fanout, 74 new test cases).**
  Auto-pilot cron `56a0a2ec` (every 15 min, jittered :03 :18 :33 :48)
  fired at a "waiting-on-CI" tick and dispatched a 4-agent fanout to
  ship 4 truly-uncovered E2E routes. `70b7f7c` `/dashboard/schedule`
  (7 cases — ADMIN/DOCTOR weekly availability + Add-Slot reverse-time
  client guard + Add-Override Modify-Hours toggle + access-shape
  pinning for NURSE/RECEPTION/PATIENT, no role-gate redirect; uses
  `getByLabel` since the recent A2 a11y wave linked all htmlFor/id
  pairs). `419246c` `/dashboard/patients` (7 cases — registry list +
  DataTable accessible-name contract + Issue #382 PATIENT bounce +
  RBAC asymmetry pinned [view ADMIN/RECEPTION/DOCTOR/NURSE; Register
  CTA only ADMIN/RECEPTION] + bulk-actions-not-yet-wired contract
  flagged for next pass). `5b43356` `/dashboard/chat` (7 cases —
  ADMIN inbox + start-chat picker → POST /chat/rooms → type-and-Send
  → POST /rooms/:id/messages with bubble assertion + DOCTOR/RECEPTION
  sidebar reach + PATIENT/LAB_TECH direct-URL accessibility; surfaced
  that page has no client VIEW_ALLOWED gate at all — only server-side
  filter `role: { not: "PATIENT" }` on GET /chat/users, plus ADMIN
  bypass on participant gates flagged via Issue #189 reference).
  `cda00bc` `/dashboard/my-leaves` (6 cases — DOCTOR happy-path
  submit with timestamp-tagged unique reason + required-field client
  guard ref Issue #458 + reversed-date inline error ref Issue #32 +
  NURSE chrome + PATIENT route-shape pin since page is universally
  accessible). Plus stale-backlog cleanup: payment-plans / purchase-
  orders / purchase-orders-id / controlled-substances / admissions
  all annotated as already-shipped in `docs/E2E_COVERAGE_BACKLOG.md`
  (specs landed earlier but the backlog hadn't been refreshed).
- **2026-05-05 cleanup wave — `audit-phi` flake helper + jsx-a11y regression guard + project CLAUDE.md.**
  Three small high-leverage commits closing the outstanding session-
  level findings from the prior CI-unblock wave: `9c5d989` enables
  `jsx-a11y/label-has-associated-control` at `warn` on `apps/web`
  (also caught + fixed 3 missed labels on `/forgot-password` outside
  the original dashboard A2 sweep — bonus closure). Severity stayed
  `warn` rather than `error` because the rule's static analysis
  surfaces false-positives on custom-control wrappers (`EntityPicker`,
  `PasswordInput`); escalation path documented in the config comment
  (wire `controlComponents` or refactor to fieldset/legend). `d1488d7`
  ships `waitForAuditFlush()` + `waitForAuditRows()` helpers in
  `apps/api/src/test/helpers/audit-wait.ts` (poll AuditLog up to 2s
  for the matching tuple); retrofitted across 6 assertions in
  `audit-phi.test.ts` (`AI_CHART_SEARCH_PATIENT`, `AI_TRIAGE_SESSION_READ`,
  `AI_SCRIBE_READ`, `AI_NO_SHOW_BATCH`, `FHIR_SEARCH_PATIENT`,
  `INSURANCE_CLAIMS_LIST`). Schema correction made during build:
  AuditLog column is `entity`, not `entityType`. The fire-and-forget
  pattern lives in per-route `safeAudit()` wrappers (e.g.
  `ai-scribe.ts:35`, `ai-predictions.ts:26`, `agent-console.ts:43`),
  not the `auditLog()` middleware (which uses `await`). Plus new
  `/CLAUDE.md` at repo root captures 18 recurring patterns + gotchas
  from the last week of fanout waves (audit-flush gotcha, sanitize
  middleware schema-override, `singleFork` module-cache cleanup
  contract, test DB seed creds, LanguageDropdown `<select>` race,
  Next route announcer, `PATIENT_NAME_REGEX` digit-rejection,
  conventional-commit + file-scoped commit rules, harness gotchas
  including the bg-agent stall and `durable: true` silent drop) —
  auto-loaded into every Claude session. **Auto-pilot cron** armed:
  `3,18,33,48 * * * *` every 15 min running the wave-aware self-direction
  prompt (mid-wave ignore / waiting-on-CI pick parallel-safe / wave-
  done check learnings + ship gaps). Session-only on this harness
  build (durable not honored); re-arm command in TODO.md banner.
- **2026-05-05 CI unblock + A2/A10 closure + new triage skill (7 commits).**
  Per-push Test workflow on `main` was red on `0c30e23` and `63855a0` with
  16 auth-integration test failures. Triaged into 5 root causes via the
  new `/medcore-test-triage` playbook; fixed in `269e185`. Then a 5-agent
  fanout closed A2 (`<label>X</label><input>` `htmlFor` linkage across
  76 dashboard pages, ~352 pairs — `c911f14`/`f89643d`/`e015cd8`/`585861c`)
  and A10 (lift `tenantScopedPrisma` to `@medcore/db` with back-compat
  re-export shim, 100+ existing import sites unchanged — `0c8ab07`).
  `e1de4f4` ships the new `/medcore-test-triage` skill (5-category
  failure-cluster diagnosis playbook) + `/medcore-route-test`
  cleanup-contract addendum (any test that mutates module-scope state
  under `singleFork: true` MUST pair `beforeAll` with `afterAll` +
  `__resetXForTests()` reset hook). 9 of 10 architectural follow-ups now
  closed (only A1 page-level `VIEW_ALLOWED` policy decision remains —
  product call needed, not engineering). One remaining test failure on
  `269e185` is the known `audit-phi` flake category (now hitting
  `INSURANCE_CLAIMS_LIST` sub-test instead of `AI_SCRIBE_READ`) —
  pre-existing intermittent, not from this commit; deferred audit-flush
  helper queued for next session.
- **2026-05-04 architectural-closure session — 8 commits closing A3/A4/A7/A8/A9
  + #457 + 4 LOW security audit items + 1 new skill.** `e7ca04d` bundled the
  May 2026 audit follow-up: 133 tenant relations flipped from `onDelete: SetNull`
  to `Cascade` plus idempotent migration `20260504000003_tenant_fk_cascade`
  closing #457 (A8); per-IP rate limit (60/60s) on `POST /gateway/callback`
  (F-ABDM-1); `sanitizeUserInput` prompt-injection guard on `ai-er-triage`,
  `ai-letters`, `ai-chart-search`, `ai-report-explainer` (F-INJ-1); and
  `AI_<FEATURE>_INFERENCE` audit rows (model + sizes + latency, never PHI)
  on all 9 AI routes with PHI-hygiene-asserting tests (42 cases). `340dd38`
  added `/medcore-ai-route-audit` skill (canonical AI route audit pattern)
  and a Mode B (single-bundled-commit) section to `/medcore-fanout`.
  `cde1829` closed A9: `tenantContextMiddleware` now validates the resolved
  tenantId via cached `prisma.tenant.findUnique({ id, active: true })` (60s
  positive / 30s negative TTL, bounded at 256 entries); non-existent or
  deactivated tenants are silently dropped, DB blips fail closed; 6 new test
  cases (21/21 green). `7bd9d14`/`ffe199f`/`34bb5a3`/`e0e1429` closed A4 via
  4-agent fanout: every `<form onSubmit>` in the dashboard tree now uses
  `noValidate` + React-side validation across 24 pages / 30 forms (clinical,
  admin/scheduling, billing/pharmacy/lab, operations/inventory). `63855a0`
  closed A3 with a documenting comment at `e2e/helpers.ts:528` near
  `indianishName()` flagging the `PATIENT_NAME_REGEX` digits-rejection gotcha
  for spec authors, and rolled the TODO architectural table (A4/A7/A8/A9
  marked Closed with closing-commit references).
- **2026-05-05 waves C+D+E — 14 more GitHub issues closed across 3 fanouts.**
  Wave C (5 agents — UX/data integrity): `0903747` (#493 forgot/reset-password
  anti-enumeration parity + strongPassword on reset), `1ef5741` (#485 + #508
  theme toggle actually flips + aria-pressed updates; root cause was missing
  explicit `type="button"` causing form-submit reload before render), `39fc1b0`
  (#504 + #505 dashboard QuickAction tile + section-label contrast WCAG 2.1
  AA), `b1db706` (#487 + #490 form-error humanization — Zod codes mapped to
  human messages, "required" no longer fires for wrong-type, "valid UUID"
  jargon hidden), `43f8fe7` (#497 + #499 seed-data integrity — Aarav age
  3-days→5-years, MR numbering contiguous from MR000036 instead of MR009000
  jump, 13 seed-validity assertions). Wave D (5 agents — a11y/feedback):
  `f7ebcc3` (#486 sidebar Sign Out 2-row footer no longer overlaps Quick
  Actions), `25273ce` (#484 + #501 login distinguishes invalid-creds toast
  from session-expired; billing role-gate now redirects to
  `/dashboard/not-authorized?from=...` instead of silent /dashboard bounce),
  `2805b9a` (#492 + #495 Lab Order modal + Patient detail header contrast
  pass; bonus htmlFor on orphaned Notes label), `630183d` (#502 tour-skip
  persists via `medcore_tour_completed_v1` localStorage key; root cause was
  `markOnboardingSkipped(userId)` no-op when userId undefined at click-time),
  `9142824` (#494 self-register surfaces server validation errors via
  improved field-error helper from b1db706 + 502/network retry banner).
  Wave E (2 agents): `5252c57` (#507 wards bed-occupancy color matches
  numeric count; root cause was flexbox `flex-shrink: 1` collapsing declared
  width-percent values, plus missing MAINTENANCE segment), `5457ffb` (#509
  page-level VIEW_ALLOWED guards added to 11 routes — pharmacy, refunds,
  admissions, medicines, visitors, duty-roster, scribe, discount-approvals,
  preauth, purchase-orders, ai-radiology — with 49 new rbac-matrix.spec
  rows).
- **2026-05-05 next-issues 4-agent fanout — 6 more GitHub issues closed.**
  Wave-B closing the next-priority cluster after the wave-A criticals
  shipped: `74e28f6` (auth-hardening — #480 anti-enumeration on
  `/auth/register` so duplicate-email response is indistinguishable
  from new-email; #478 tightened login rate-limit from 20/IP/min to
  5/IP/min via existing project-local `rateLimit()` middleware,
  added an `enableInTests` opt-in so the regression test can fire
  the limiter; #489 XSS sanitization on register name + `age 1-150`
  bounds in `registerSchema`; uses the new `expectAntiEnumeration`
  helper), `fe5e805` (#479 — `GET /billing/invoices?status=PENDING,PARTIAL`
  no longer 500s; route now splits comma-separated status into a
  Prisma `in: [...]` filter), `51b395e` (#500 — profile PATCH
  regression tests covering empty Name + non-numeric Phone field
  validation surfaces; backend already enforced these via
  `updateMeSchema` so #500 was a missing-test gap not a source bug),
  `3308d8f` (#491 past-date booking — defence in depth across 4
  layers: `bookAppointmentSchema` + `rescheduleAppointmentSchema`
  Zod refines, route same-day past-time slot guard, doctors slots
  endpoint elapsed-time filter, UI date-picker `min={today}`).
  Surprising findings: `express-rate-limit` is NOT a project dep —
  custom `rateLimit()` middleware exists in
  `apps/api/src/middleware/rate-limit.ts`; module-scope construction
  required a lazy delegate pattern so test env-flips would land.
  `sanitizeUserInput()` already existed in
  `packages/shared/src/validation/security.ts` (used by PATCH
  `/auth/me` since #248/#265) — register handler now calls it too.
- **2026-05-05 critical-security fix wave + adversarial-vector test infra.**
  Five critical/high GitHub issues closed via 5-agent fanout: `b6601ad`
  (#473 mass-assignment in `/auth/register` — `registerSchema.role`
  optional + new `resolveRegistrationRole()` helper that requires an
  admin token to set non-PATIENT roles; preserves dashboard staff-
  creation flow; 3 new tests verify stored role via `/auth/me`),
  `66bb6d2` (#474 cross-patient row-level access — new
  `assertPatientOwnsResource` middleware applied to 11 handlers
  across 9 route files; 5 routes get per-row checks, 6 operational/
  staff routes deny PATIENT entirely; 29 cross-patient tests),
  `bd7785a` (#475 helmet@^8 mounted with strict CSP / HSTS /
  X-Frame-Options DENY / X-Content-Type-Options / Referrer-Policy;
  `X-Powered-By` removed; 7 header-assertion tests), `5f2fa2a`
  (#476 visitor PII redaction — new `pii-redact.ts` helper masks
  `idProofNumber` to `********1234` shape across 7 visitor response
  sites; DB still stores full value for blacklist matching; 7 tests
  with `JSON.stringify` raw-value needle check). #483 login wrong-
  user investigation: source code is correct (login does
  `findUnique` on unique email, bcrypts against that user, signs
  token with same row); production report likely stale localStorage.
  2 identity-binding tests added as defence in depth.
- **Adversarial-vector test infrastructure** to prevent the whole
  bug class from recurring silently. New
  `apps/api/src/test/helpers/security-assertions.ts` exports 6
  reusable assertions: `expectSecurityHeaders`, `expectNoRawPII` +
  `expectMaskedField`, `expectTokenIdentifies`,
  `expectFieldNotMassAssigned`, `expectAntiEnumeration`,
  `expectCrossRowDenied`. `docs/TEST_PLAN.md` §6.5 codifies the
  six adversarial-vector categories with a checklist comment
  template that every new authed-endpoint integration test should
  use. Closes the underlying habit of `expect(res.status).toBeLessThan(400)`
  as the only assertion (the pattern that let #473/#474/#475/#476/#483
  ship past existing tests).
- **2026-05-05 A4/A5 fix wave (5-agent fanout) — 18 forms modernized to noValidate + React-only validation; A5 RBAC drift effectively CLOSED.**
  Per Issue #458 audit recommendation, swept the top 3 most-affected
  files plus a 4-file cluster: `d76669d` (patients/[id] — 7 sub-forms:
  QuickVitalsModal, AllergyForm, ConditionForm, FamilyForm,
  ImmunizationForm, DocumentUploadForm, AdvanceDirectiveForm),
  `8f9807c` (admissions/[id] — 5 sub-forms: Vitals, MedOrder,
  NurseRound, LabOrder, I/O), `478325e` (pharmacy + insurance-claims
  + prescriptions + referrals — 6 sub-forms). Each form: `noValidate`
  on `<form>`, drop HTML5 constraints (`required`, `min`, `max`,
  `pattern`), keep `type="date"`/`type="number"` for native picker /
  numeric-keypad UX, ensure React `submit()` validates equivalently.
  Per Issue #459 audit, A5 RBAC drift effectively CLOSED in two
  commits: `d5a4fef` tightened `/dashboard/lab/[orderId] canAddResults`
  to LAB_TECH+ADMIN (the one true priority drift > server); the
  audit's claim about `/dashboard/medicines canEdit` turned out to
  be a FALSE POSITIVE — server actually allows ADMIN+DOCTOR matching
  the client. `75a5ccc` resolved all 5 client<server drifts:
  `/antenatal canCreate` + `/surgery/[id] canEdit` + `/lab canOrder`
  loosened to match server (clinical workflow intent); `/telemedicine
  canRate` kept hidden with a documenting comment (intentional —
  admins shouldn't fake patient ratings); `/holidays` GET tightened
  server-side to ADMIN (defence-in-depth). Audit-correction comment
  on #459 still TODO. ~19 less-trafficked A4 forms still affected
  per the audit; will batch in a future wave.
- **2026-05-05 next-wave 5-agent fanout — A2 sweep continuation + A6 closed + 2 GH issue audits + /admissions/[id] E2E.**
  Mixed-lane fanout shipping `a5bf725` (A2 — 10 more modals / 57 label-input pairs got `htmlFor`/`id` linkage; expenses, holidays, budgets, payment-plans, duty-roster, scheduled-reports, walk-in, PatientEditModal, notification-templates, certifications), `9ee446e` (A6 closed — `/users` PATCH handlers extracted from `patient-extras.ts` into a dedicated `apps/api/src/routes/users.ts`; byte-identical URLs preserve backward-compat), `aaadbeb` (`/dashboard/admissions/[id]` E2E — 6 cases × 2 = 12 tests, isolation panel + belongings + running bill + LOS + transfer modal + ADMIN force-discharge two-modal walk; closes §2.7 backlog entry).
  Plus 2 audit-only agents posted concrete drift reports as comments
  on Issues #458 and #459 — the H5-constraint and canX-drift audit
  reports went from "open issue, vague body" to "open issue, 37
  affected forms enumerated, 2 priority drift instances named".
  Tracked in TODO.md "Open architectural follow-ups" canonical table:
  A6 marked CLOSED → C6, A2/A4/A5 rows enriched with the new evidence
  + audit-comment URLs.
- **2026-05-05 round-2 fix-up wave (5-agent fanout) — cross-cutting helper fix, 2 root-cause spec fixes, 1 RBAC drift, 17 a11y label linkages.**
  Round-2 release.yml on `4d9423f` was still red on patients-register
  + payment-plans + ot-surgery WebKit. A 5-agent fanout closed all
  three plus 2 source-side fixes. `0e57b4a` tightened `expectNotForbidden`
  in `e2e/helpers.ts` (the `/forbidden|403/i` regex was matching '403'
  as a digit substring inside random strings — ot-surgery WebKit
  fails were OT-name timestamps containing '403'). `c052df6` found
  that the patients-register test failures were due to digit-bearing
  unique names (`E2eReg ${Date.now()}`) being rejected by
  `PATIENT_NAME_REGEX = /^[A-Za-zऀ-ॿ\s.\-']{1,100}$/` — POST never
  fired; new test asserts POST status before searching. `3decc91`
  found that payment-plans validation tests fail because native
  HTML5 `<input min/max>` constraints reject submit before the React
  `setError()` handler runs — fix uses `form.noValidate = true;
  form.requestSubmit()`. `0646b0b` tightened
  `apps/web/src/app/dashboard/expenses/page.tsx` `canAdd` gate to
  ADMIN-only (server is ADMIN-only; RECEPTION was seeing a POST-403
  CTA). `ab60593` added `htmlFor`/`id` linkage to 17 label/input
  pairs across AddMedicine + AddSupplier + AddWard modals (WCAG 2.1
  AA + Playwright `getByLabel` compatibility). Three more
  architectural findings logged in TODO.md as candidate PRs:
  PATIENT_NAME_REGEX digit-rejection (consider doc note for spec
  authors); HTML5 constraint validation racing React `setError`
  (forms-wide review); the `canX`-vs-`authorize()` drift pattern
  (audit pass on all client gates).
- **`docs/archive/gaps/` subfolder.** Dedicated location for fully
  closed gap-tracking docs (every item worked through). A gap doc
  moves there only when its entire backlog is closed; if even one
  item is still open it stays in `docs/`. Seeded with
  `TEST_GAPS_2026-05-03.md` (already fully closed). Active gap files
  (`E2E_COVERAGE_BACKLOG.md`, `TEST_COVERAGE_AUDIT.md`) stay in
  `docs/` until done. Policy noted in TODO.md banner so it's surfaced
  every session start.
- **2026-05-05 evening — fix-up wave + 7-agent Cluster 1+2 fanout + 5th project skill.**
  After release.yml `25287320476` surfaced 11 failing Playwright tests
  (8 from autopilot + 3 pre-existing from earlier sessions), three
  fanout passes closed every failure plus 4 more uncovered routes plus
  3 cross-cutting bug-pattern sweeps. Fix-up wave (`149b4db` `cdea823`
  `8d3f277` `71402e7` `1f3c99d` `7344857` `3628bf2` `49d829d` `f93f152`
  `2823d9c` `4d9423f`) tightened modal selectors, scoped strict-mode
  locators, dropped brittle assertions against the Next.js global route
  announcer, and replaced popup-URL matches with network-request
  observation. Cross-cutting sweeps (`b2e78d7` `f44c9a0` `e761a34`)
  systematized the same fixes across 9 other specs that hadn't tripped
  yet but would have. New E2E specs (`56d0acc` `ce856cf` `40673aa`
  `78feace`) closed `/billing/[id]` line-item edit, `/budgets`,
  `/expenses`, `/users` edit-deactivate-role-change. Surfaced 9
  architectural findings logged as candidate PRs in TODO.md (notably:
  LanguageDropdown injects `<select>` into every layout; Next renders
  `role="alert"` globally; multiple modals render bare `<label>`
  without `htmlFor`; EntityPicker rows are `<li role="option">` not
  buttons; openPrintEndpoint opens blank popup + fetches; client/server
  RBAC drift on `/dashboard/expenses`).
- **5th project skill: `/medcore-doc-roll`** (`94c3d55`) — codifies the
  end-of-wave doc rollup so architectural findings landing in commit
  bodies don't decay between waves. Idempotent (deduplicates against
  existing TODO entries on substring match), composable (intended to
  chain after every `/medcore-fanout`), and surfaces what would
  otherwise live only in `git log` once the next wave's context loads.
  `.claude/settings.json` un-ignored via `.gitignore` exception
  (`2b86721`) so project-shared skill-folder allowlist syncs to office
  on `git pull`.
- **2026-05-05 autopilot — 15-route E2E fanout via the new project skills.**
  Five 3-agent foreground-fanout batches closed 15 zero-coverage /
  undercovered dashboard routes in ~25 min wall-clock total: medicines,
  suppliers, holidays (batch 1, `3cececd` `dfeeb48` `29604e2`); pharmacy,
  assets, patients/register (batch 2, `b9dbe93` `db1df15` `b88a333`);
  payroll, leave-calendar, doctors (batch 3, `bdfd5e5` `d4b19f8`
  `484ee98`); notifications, broadcasts, complaints (batch 4, `ac7c338`
  `2c06fff` `430dc89`); queue, census, wards (batch 5, `45673c3`
  `0643349` `a6b5fe3`). ~94 new test cases × 2 Playwright projects =
  188 listed tests. Batches surfaced 6 architectural findings —
  multiple pages have no client-side `VIEW_ALLOWED` (security relies
  on API layer alone), several pages have zero `data-testid`,
  `POST /complaints` has no `authorize()`, `/holidays` API is open-auth
  while the UI gates ADMIN-only, `/notifications` is reachable by every
  authed role via direct URL despite the sidebar omitting it for
  PATIENT/LAB_TECH, and `/dashboard/patients/register` is a 35-line
  redirect shim. All findings logged in TODO.md as candidate PRs.
- **Project-shared skills under `.claude/skills/` (4 files).**
  `/medcore-fanout` codifies the foreground-fan-out pattern — the only
  proven parallelism path on VSCode harness v2.1.126 (bg agents stall
  on per-Read permission popups). `/medcore-e2e-spec` scaffolds one
  Playwright route spec under the descriptive-headers convention,
  validates via `playwright test --list`, annotates the backlog
  closure. `/medcore-route-test` scaffolds one Vitest route-handler
  unit test with hoisted Prisma mocks, RBAC matrix, Zod rejections,
  audit-log assertions. `/medcore-release` dispatches + watches +
  diagnoses release.yml runs. `.gitignore` tweaked to track
  `.claude/skills/` while keeping `settings.local.json` and
  `worktrees/` local-only — git can't otherwise unignore children of
  an excluded parent, so the contents-only pattern (`.claude/*` +
  selective negation) was needed.
- **P4 — Tenant-scoping isolation regression suite (`8d0765a`).** New
  `packages/db/src/__tests__/rls.test.ts` (686 lines, 10 it / 29
  expects) verifies the Prisma context-binding mechanism that's our
  actual production multi-tenant isolation (NOT Postgres RLS). Covers
  7 tenant-scoped models with: per-tenant scoped reads, cross-tenant
  findUnique returning null, cross-tenant write attempts (update /
  updateMany / delete / deleteMany) failing, count() aggregations
  scoped, raw un-scoped client seeing both tenants (proves data exists
  + filter is doing the work). Self-skips without `DATABASE_URL_TEST`.
  Surfaced 4 real architectural findings now logged in TODO.md:
  scoping wrapper in wrong package, AuditLog lacks tenantId, tenant FK
  is SetNull (orphan-PHI risk), runWithTenant doesn't validate the id.
- **P6 — Load-test SLA gate in CI (`417066a`).** `scripts/load-test-sla-gate.ts`
  parses load-test JSON output and fails the workflow on p95 / p99 /
  error-rate breach. Thresholds at `scripts/load-test-thresholds.json`:
  1% global error rate, p95 ≤ 3000ms triage / 6000ms scribe / 4000ms
  chart-search to match README targets. `run-load-test.ts` extended
  with `--json-out=` flag emitting `schemaVersion: 1` summary.
  Triggers: nightly cron + on-PR for routes/load-test path changes.
  Threshold-tuning workflow documented in
  `docs/CI_HARDENING_PLAN.md`. Closes
  `docs/TEST_COVERAGE_AUDIT.md` §5 P6.
- **`/dashboard/admissions` E2E (`65b5e0a`).** 11 cases across 5 roles
  covering admit → MAR → discharge lifecycle. Pins real route shape:
  the page is fully accessible to all authenticated users (no `/dashboard/not-authorized`
  redirect); only the "Admit Patient" CTA is role-gated. Discharge is
  a two-modal sequence (`DischargeReadinessModal` then discharge
  form); both legs walked.
- **`/dashboard/purchase-orders` + `/dashboard/payment-plans` E2E
  (`be36db6`).** 36 cases across both pages and 7 roles. Purchase-orders
  exercises full state machine (`DRAFT → PENDING → APPROVED → RECEIVED`
  + `DRAFT → CANCELLED`). Issue #262 RBAC restrictions verified by
  direct API token assertions. Both pages share an architectural pin:
  no client-side `canView` gate — non-authorized roles see API 403 →
  empty list, not a `/dashboard/not-authorized` redirect.
- **`/register` + `/forgot-password` E2E with anti-enumeration pin
  (`592a641`).** 17 cases. Anti-enumeration **CONFIRMED**: unknown email
  receives identical HTTP 200 + same UI step as known email. A future
  divergence will surface as a test failure. Issue #15 rate-limit-error
  mapping covered. Issue #167 age=0 client-side guard covered. Pinned
  minor UX gap: neither page bounces authenticated users to `/dashboard`.
- **WebKit auth-race v4 fix (`eb40604`).** `gotoAuthed(page, url)`
  helper in `e2e/helpers.ts` + fixture settle guard in
  `e2e/fixtures.ts` close the race that resurfaced on release.yml
  `25284590768` (3 hard fails on admin-ops:144 / pharmacy-forecast:8 /
  predictions:128 + visual:65 + 22 flaky retries). v3's layout retry
  protected the fixture's first `/dashboard` goto; subsequent
  `page.goto("/dashboard/X")` inside test bodies trigger a fresh App
  Router RSC render that re-arms the `/auth/me` race. Helper polls for
  `/login` bounce, re-writes tokens, retries with back-off.
- **`/dashboard/controlled-substances` E2E (`e33ceea`).** 10 cases
  across 6 roles (PHARMACIST/DOCTOR/ADMIN allow + NURSE/RECEPTION/PATIENT
  deny → `/dashboard/not-authorized`). Closes
  `docs/E2E_COVERAGE_BACKLOG.md` §2.2 entry. Page is read-only audit
  surface; entries flow from the dispense workflow.
- **PDF / letter / invoice snapshot regression (`86766bf`).** 8
  vitest file-based snapshots across 4 generators
  (`generatePrescriptionPDF`, `generateInvoicePDF`,
  `generateDischargeSummaryHTML`, `generateReferralLetter` prompt) at
  `apps/api/src/services/__snapshots__/pdf-snapshot.test.ts.snap`.
  Locale-dates pinned to `null`, QR PNG mocked to `STUB_QR` to avoid
  CI flake. Closes `docs/TEST_COVERAGE_AUDIT.md` §5 P9.
- **AI hot-path vitest benchmarks (`6832a6f`).** 13 `bench()` tasks
  across 3 files in `apps/api/src/services/ai/` — `prompt-safety` (5),
  `er-triage`'s `calculateMEWS` (5), `chart-search`'s `synthesizeAnswer`
  (3). New `npm run bench` script. Compare workflow:
  `vitest bench --run --outputJson` then `--compare`; `<0.9×` ops/sec
  trips a >10% regression alarm. Closes
  `docs/TEST_COVERAGE_AUDIT.md` §5 P10.
- **Component-level a11y regression suite (vitest-axe).** New helper
  `apps/web/src/test/a11y.ts` exports `expectNoA11yViolations(node, opts)`
  pinned to `wcag2a` + `wcag2aa` + `wcag21a` + `wcag21aa` (mirrors
  `e2e/a11y.spec.ts`'s `withTags` set), with an impact-level filter
  defaulting to `["moderate","serious","critical"]`. Seed test file
  `apps/web/src/components/__tests__/a11y.test.tsx` covers DataTable
  (rows / empty / loading), EmptyState, ConfirmDialog (portal), and
  EntityPicker (closed). Runs sub-second in the unit suite, surfaces
  WCAG 2.1 AA violations BEFORE the ~25-min Playwright e2e tier.
  Closes `docs/TEST_COVERAGE_AUDIT.md` §5 P3. devDeps: `vitest-axe
  ^0.1.0` + `axe-core ^4.11.4`.
- **CI Phase 1-4 hardened.** Lint job (eslint v9 + eslint-config-next on
  `apps/web`, gating in `deploy.needs:`), CodeQL weekly + push + PR,
  `npm audit` scoped to api+web in deploy gate, Dependabot config, AI
  eval nightly, load-test nightly, visual-regression workflow with
  Linux-rendered baselines committed (Chromium + WebKit), CodeQL
  security-extended ruleset, Sentry release tracking,
  `migration-safety` destructive-op gate (override via
  `[allow-destructive-migration]` in commit message), `pg_dump`
  pre-migrate backup with retention, auto-rollback on smoke fail, and
  workflow-level audit hardening (least-privilege tokens, SHA-pinned
  SSH action, per-job `timeout-minutes`, concurrency groups, `.nvmrc`
  + `node-version-file` single-source).
- **Codecov coverage uploads** (`b3b090b` + `350e74a`) on api + web
  jobs in `test.yml` via `codecov-action@v6`; `codecov.yml` config at
  repo root. Step is guarded by `if: hashFiles(...) != ''` so CI stays
  green pre-token. **User follow-up:** add `CODECOV_TOKEN` secret.
- **40-spec Playwright suite stabilized cross-browser.** Initial
  `injectAuth` rewrite to `addInitScript` (`a8230d1`) cut WebKit fail
  count 121 → 55; three further auth-race waves on 2026-05-02
  (`8d7fa94` v1, `1d204d7` v2, `febe0aa` v3) drove WebKit residual
  fails to **0**. Validated fully green in release.yml run
  `25257762655` and re-confirmed green on `25258173521`.
- **§C clinical-safety e2e flow specs** — `bloodbank.spec.ts` (5
  cases incl. ABO/Rh cross-match safety + expired-unit exclusion),
  `ambulance.spec.ts` (5 cases, full DISPATCHED → COMPLETED lifecycle
  + fuel logs), `pediatric.spec.ts` (5 cases, chart drilldown +
  growth-point plot + UIP/IAP immunization schedules). 1,611 lines /
  15 cases.
- **§A middleware + §B scheduler unit tests** — 136 new tests across
  middleware (`tenant`, `sanitize`, `audit`, `error`,
  `tenant-context`) and schedulers (`adherence`, `chronic-care`,
  `insurance-claims`, `audio-retention`, plus `waitlist`, `jitsi`,
  `metrics`).
- **§D web auth page tests** — `register.novalidate.test.tsx` mirrors
  `login.novalidate.test.tsx`; full client-side validator coverage
  (all-fields-empty, malformed email, short phone, short password,
  age=0 floor, per-field clear-on-edit).
- **Local-first test workflow.** `scripts/run-tests-locally.sh`
  mirrors every per-push CI gate from `test.yml` in ~5-7 min via a
  one-shot Postgres on `:54322` (full guide:
  [`docs/LOCAL_TESTING.md`](docs/LOCAL_TESTING.md)). Default tier
  excludes integration; `--with-integration`, `--with-e2e`, and
  `--with-e2e=both` opt in to heavier tiers.
  `scripts/run-e2e-locally.sh` mirrors `release.yml`'s e2e jobs in
  ~5-10 min ([`docs/LOCAL_E2E.md`](docs/LOCAL_E2E.md)).
- **`claude.{bat,sh,ps1}` status-check scripts** at repo root — print a
  one-screen "what's the deploy + CI doing right now" summary for
  hand-off pickup.
- **Visual regression baselines** committed for Chromium (`d150ab2`)
  and WebKit (`fb55fe6`); future release runs exercise visual specs
  unconditionally.
- **Admin-console color-contrast a11y debt closed** (`f7f1bdc`).
- **a11y heading-order budget raised 10 → 13 nodes** (`e6f6d24`) while
  shared-chrome consolidation is in flight.
- **Coverage thresholds bumped** (`cc01e36`) to `current_actual − 2pp`
  on both projects: api lines **24%** / branches **68%** / functions
  **68%** / statements **24%**; web lines **51%** / branches **65%** /
  functions **31%** / statements **51%**. Up from previous
  basement-level 11% / 10%.
- **2026-05-03 schema migration `20260503000001_witness_signature_and_prescription_status`** (`244b002`):
  - `ControlledSubstanceEntry.witnessSignature` (TEXT?) + `witnessUserId`
    (FK to users.id, ON DELETE SET NULL) for §65 Schedule-H/H1
    co-signing.
  - `Prescription.status` (PrescriptionStatus enum: PENDING / DISPENSED
    / REJECTED / CANCELLED) + `rejectionReason` / `rejectedAt` /
    `rejectedBy` for the lifecycle the pharmacist Rx-rejection workflow
    needs. Existing rows backfill to PENDING.
  - Both additive; no `[allow-destructive-migration]` marker.
- **Test-gap audit + Sessions 1-3 closure (2026-05-03, ~447 new test
  cases across 10 priority gaps).** New audit doc at
  [`docs/TEST_GAPS_2026-05-03.md`](docs/TEST_GAPS_2026-05-03.md)
  identified a top-10 priority queue. **All 10 closed in three waves:**
  - **Gap #6** (`c36fb23`) — 5 untested Zod schemas in
    `packages/shared/src/validation/__tests__/`: `finance` (31),
    `pharmacy` (25), `prescription` (20), `phase4-ops` (38),
    `phase4-clinical` (38). 152 cases.
  - **Gap #1** (`723b6fc`) — `apps/api/src/services/insurance-claims/`:
    `adapters.test.ts` (TPA submit/inquire JSON round-trip; 41),
    `denial-predictor.test.ts` (risk quantization, LLM-skip threshold;
    14), `store.test.ts` (createClaim → updateStatus state machine,
    ClaimStatusEvent audit row; 13). 68 cases. Sarvam + `@medcore/db`
    mocked.
  - **Gap #7** (`8302010`) — `apps/api/src/services/ai/`:
    `adherence-bot.test.ts` (9), `differential.test.ts` (9),
    `symptom-diary.test.ts` (12). 30 cases.

  Session 1 also surfaced three real source bugs (tests assert *current*
  behaviour with TODO comments so the fix shows up as a clean diff):
  `adherence-bot` empty-string nullish-coalesce, `store.ts` missing
  state-machine guard, `symptom-diary` missing prescription
  cross-reference (the third turned out to be a wrong audit assumption,
  not a real bug — the function does what it does).

  - **Wave A (parallel test-only, ~143 cases)**:
    - **Gap #4** (`89a6c40` + `6c47fad`) — HL7v2 parser/roundtrip/segments
      unit tests (59 cases). Pinned a parser quirk where field-level
      `unescapeField` runs BEFORE component split, causing escaped `^`
      to over-split downstream — flagged for follow-up.
    - **Gap #3** (`6c47fad`) — FHIR Bundle validation + search parameter
      parsing (32 cases). `_id` parameter not yet supported by `search.ts`
      — flagged as wider gap.
    - **Gap #9** (`690ffb1`) — Bloodbank cross-match safety matrix
      (40 cases). RBC compatibility, expired-unit exclusion, reservation
      transitions, override path with clinical-reason gating.
    - **Gap #10** (`cc64eff`) — Ambulance trip state machine + fuel-log
      + RBAC (12 cases). Surfaced two source bugs: route has NO
      state-machine guard on transitions; `fuelLogSchema` has no client
      timestamp field. Tests pin current behaviour with TODO markers.

  - **Wave B — schema migration `244b002`**:
    `20260503000001_witness_signature_and_prescription_status`. See the
    migration entry above for shape + rationale.

  - **Wave C (parallel, backend wiring + tests for newly-unblocked
    surfaces, 54 cases)**:
    - **Gap #8** (`fd3bea6`) — Pharmacy route. New endpoint `POST
      /pharmacy/prescriptions/:id/reject` (PHARMACIST/ADMIN, Zod
      `reason.min(10)`, state-machine guard PENDING-only, audit row).
      `/dispense` now flips `Prescription.status` to DISPENSED on full
      dispense. 30 RBAC + dispense + rejection cases.
    - **Gap #2** (`e6c68e1`) — Controlled substances. Schedule-H/H1/X
      dispense now requires `witnessSignature` (Zod min-3) at the route
      layer; returns 422 otherwise. `witnessUserId` FK-validated against
      users; null for external witnesses. Audit-log records both
      signers + `scheduleClass`. 12 new cases. **Surfaced a follow-up:**
      `routes/pharmacy.ts:491` (full-Rx dispense) auto-creates
      `ControlledSubstanceEntry` for `requiresRegister=true` items
      WITHOUT capturing `witnessSignature` — bypasses the new §65 gate.
      Tracked.
    - **Gap #5** (`65d7c96`) — Patient Data Export. 12 new cases:
      cross-tenant exclusion, `passwordHash` excluded from JSON+FHIR
      bundles, fullUrl uniqueness, JSON/FHIR/PDF roundtrip with magic-
      byte assertion, signed-URL TTL = documented 1 hour, ADMIN gets 403
      (route is PATIENT-only — audit's "ADMIN can export for any" was
      wrong; test pins actual behaviour).

  **Subtotal across the three waves: ~447 new test cases.**

  - **Low-priority Wave (parallel, 64 cases + 3 source fixes/features):**
    - **Honorable #11** (`b460095`) — Pharmacy forecast route: 11 cases.
    - **Honorable #12** (`2448273`) — No-show predictor route: 12 cases.
    - **Honorable #13** (`e340e07`) — Audit-archival orchestration: 6 cases.
    - **Honorable #14** (`90e28b0`) — Notification multi-channel orchestrator: 7 cases.
    - **Honorable #15** (`5ee6907`) — Razorpay webhook idempotency: 8 cases. Flagged a follow-up: no "different transactionId for same already-PAID invoice = fraud" guard.
    - **Source fix** (`f7853a7`) — HL7v2 parser unescape-then-split. parseSegment now stores raw escaped fields; unescape happens at component-split time. Closes the parser quirk pinned in `89a6c40`.
    - **Source fix** (`a1d0fc0`) — Full-Rx dispense Schedule-H witness-bypass. `/pharmacy/dispense` now requires `witnessSignature` for any Rx with `requiresRegister=true` items. 6 new test cases.
    - **Feature** (`7af63c1`) — FHIR `_id` SearchParameter on Patient/Encounter/AllergyIntolerance. 10 new test cases.

  **Total today: ~510 new test cases. README test count `~2,200+ → ~2,700+`.**

- **Late-evening / late-night Day 2 landings** (post `b36a309`):
  - **`c127e6f` — Ambulance state-machine guard + fuel-log timestamp validation.**
    Added `ALLOWED_TRIP_TRANSITIONS` table + `assertValidTripTransition`
    helper covering REQUESTED → DISPATCHED → ARRIVED_SCENE →
    EN_ROUTE_HOSPITAL → COMPLETED (and CANCELLED at every step).
    `apps/web/src/app/dashboard/ambulance/page.tsx` Complete-button
    gating updated. `fuelLogSchema` (`packages/shared`) now refuses
    `filledAt` timestamps >60s in the future. 3 TODO test cases flipped
    to assert 409 on illegal transitions.
  - **`9486409` — Razorpay capture-side fraud guard.** Webhook handler
    detects "fresh `transactionId` arriving against an already-PAID
    invoice", audits with `RAZORPAY_WEBHOOK_FRAUD_SUSPECT`, returns 409
    + `INVOICE_ALREADY_PAID_DIFFERENT_TXN`. 4 new test cases. Flagged
    that `handleRefundProcessed` had an analogous unfixed surface.
  - **`eb85749` — WebKit un-skip pass.** Removed 7 defensive
    `test.skip(({browserName}) => browserName === "webkit", ...)` from
    `476488a` now that auth-race v3 (`febe0aa`) made WebKit stable.
  - **`8888541` — Descriptive-headers convention codified.** `docs/README.md`
    "Top-level conventions" gained a "Tests & feature code" section:
    test files / new entry-point files (route handler, service module,
    top-level component) lead with a short header — what / which
    modules / why. Saved as `feedback_descriptive_tests_and_code`
    memory so future sessions apply automatically.
  - **`a8ab069` — Razorpay refund-side fraud guard** (analogous to
    9486409). Two new fraud branches in `handleRefundProcessed`:
    `REFUND_AGAINST_NON_CAPTURED_PAYMENT` (original payment must be
    CAPTURED, not FAILED/REFUNDED) and `REFUND_EXCEEDS_PAYMENT` (single
    refund amount must not exceed the payment it refunds). Audit +
    409 with structured codes. 5 new test cases. Cumulative-refund
    detection across multiple events is out of scope (would need a
    payment→refund FK) — tracked separately.
  - **`ee5f253` — `/dashboard/symptom-diary` E2E spec.** 7 cases:
    PATIENT happy path (open modal → fill → save → entry lands in
    history with unique tag), PATIENT empty-description blocked
    client-side (no POST fires), LAB_TECH/PHARMACIST bounce (outside
    VIEW_ALLOWED), NURSE without/with `?patientId=` (staff-needs-patient
    branch + read-only banner). Closes the §2.1 backlog entry.

  **Late-evening source surfaces fixed:** ambulance state machine,
  Razorpay capture+refund fraud guards. **Tests added:** ~12 new cases
  on top of the day's earlier ~510. **E2E backlog closed:** symptom-diary.

### Changed
- **Web-bundle budget tightened** 25 MB → **7 MB** (`1983f01`) based
  on avg 3.56 MB on last 8 green per-push runs + ~3 MB headroom.
- **Integration tests now opt-in** in the local runner (`84112dc`).
  CI still runs them on every push; locally on Windows + Docker
  Desktop the suite can take ~28 min, so `--with-integration` keeps
  the default tier in the feedback-loop range.
- **Playwright e2e is explicit-invocation only** (codified `406023d`).
  Auto-deploy gates only on the non-e2e tests
  `[test, web-tests, typecheck, lint, npm-audit, migration-safety,
  web-bundle]`; `release.yml` is the e2e gate.
- **5 brittle e2e locator patterns tightened** (`e2ec599`) across 8
  specs/pages — preempt ambulance-style locator-drift bugs elsewhere.

### Fixed
- **e2e/ambulance dispatch-modal locator** scoped via `data-testid`
  (`2c886f6`) — was the chromium hard fail in `dca70d3`.
- **`expect.poll` misuse** in ambulance flow (`abbf702`).
- **RSC console-warning filter** (`febe0aa`) — silences a harmless
  RSC dev warning that broke `reports.spec.ts:16`'s `console.error`
  listener.
- **leave-calendar test flake** (`8c790f0`) — `getByText("Mon")` was
  racing the page's loading guard.

### Security
- **CodeQL** security-extended ruleset on push + PR + weekly cron.
- **`npm audit`** scoped to apps/api + apps/web is in `deploy.needs:`.
- **`migration-safety` gate** blocks destructive Prisma migrations
  unless the commit message contains `[allow-destructive-migration]`.

### Infrastructure
- 6 GitHub Actions workflows: `test.yml` (per-push gate + auto-deploy),
  `release.yml` (full Playwright on `workflow_dispatch`),
  `codeql.yml`, `ai-eval-nightly.yml`, `load-test-nightly.yml`,
  `update-visual-baselines.yml`.
- `.test-local/` and `.e2e-local/` added to `.gitignore` for the local
  runner artifact dirs.
- `packageManager` bumped to npm@10.9.0 to close
  [`npm/cli#4828`](https://github.com/npm/cli/issues/4828)
  lockfile-drift root cause.

---

## [Unreleased - 2026-04-15]

Session window: `ff24ba7` (2026-04-14) -> `63a592c` (2026-04-15).
Focus: production hardening, test depth, accessibility, i18n, mobile scaffolding.

### Added
- **Test suite expansion**: 659 -> **1,343 tests** across 6 layers
  (unit, integration, page-level, e2e, concurrency, a11y). 587 new API
  integration/unit tests across 30 routers; 57 new web page-level tests
  across 10 dashboard pages.
- **45 routers** now have integration coverage with auth, validation, and
  error-path assertions.
- **Walk-in token race** concurrency test — hammers the queue allocator in
  parallel to prove the unique-per-day token invariant holds under contention.
- **Database migrations** — first-class Prisma migration history replacing
  ad-hoc `db push`. Initial baseline, auth-state persistence, role expansion,
  and schema drift reconciliation migrations.
- **Razorpay webhook handler** with signature verification, amount
  cross-check against the source invoice, and idempotency via webhook event
  IDs (fail-closed: any verification error rejects the payment).
- **Uploads security stack**: row-level ACL checks, server-side MIME sniffing
  (reject-by-magic-bytes, not just extension), per-mime size caps, signed
  short-lived download URLs, and a retention cron that purges expired blobs.
- **PDF generation** via `pdfkit` (server-side, deterministic, archival-safe)
  with real scannable QR codes embedded for prescription verify-flow.
  Includes Socket.IO realtime delivery + tests.
- **Mobile Phase 1** scaffolding: Expo SDK 53 + expo-router app shell, EAS
  build config, push-notification registration, billing screens,
  doctor-lite queue view, and realtime socket wiring.
- **Hindi (hi-IN) i18n** on 10 dashboard pages with locale switcher.
- **Accessibility gate**: WCAG 2.1 AA compliance with per-page budget
  overrides, enforced in CI via `@axe-core/playwright`.
- **TOTP 2FA**: enrolment, verify-login, backup codes. Temp tokens persisted
  to DB (not in-memory Map) for replica safety.
- **PHARMACIST** and **LAB_TECH** roles (5 -> 7) for least-privilege access.
- **Scheduled task registry** written to `system_config` table with last-run
  timestamps for observability (drainScheduled, retention, backup, etc.).
- **Backup restore rehearsal** — full round-trip (dump -> restore to scratch
  DB -> row-count verify across 8 critical tables). Verified 2026-04-15.
- **DataTable**, **Tooltip**, **Autocomplete**, **EmptyState** primitives,
  dark-mode sweep, toast migration, mobile bottom nav on web.
- **app/server split** in the API so tests can import the Express app
  without spinning up the HTTP listener or Socket.IO server.

### Changed
- Rate limits raised to **600 req/min global**, **30/min on /auth** for
  dashboard-friendly browsing.
- Prescription verify page upgraded to Next.js 15 async-params signature.
- 20 button-name + form-label fixes for screen-reader compliance.
- Queue events now room-scoped (`queue:<doctorId>`, `token-display`) rather
  than broadcast.
- JWTs are now `jti`-scoped so refresh-token rotation can detect replay.

### Fixed
- **Notification drain** now picks up rows with `scheduledFor = NULL`
  (previously stuck in QUEUED forever).
- **Lab order-number generator** correctly filters by `LAB` prefix — no more
  cross-prefix collisions.
- **Admin-console** handles the grouped roster response shape and stops
  calling the removed `/auth/users` endpoint.
- MR sequence upsert race on patient create.
- A11y: low-contrast text on admin-console darkened; aria-labels on
  DataTable page-size, admissions selects, and billing actions menu.
- Test brittleness: vitest positional paths (replacing deprecated `--dir`),
  asset enum values, queue endpoint URL, vulnerability rank neutralization
  in queue-ordering test, auth token shape in patients tests.

### Security
- **Razorpay fail-closed**: any signature or amount mismatch rejects the
  payment end-to-end; no silent retries.
- **Upload ACL** now enforced at the row level — users cannot fetch blobs
  they don't own even with a valid signed URL from a different tenant.
- **MIME sniffing** blocks spoofed `.pdf.exe` style uploads.
- **2FA state** moved out of process memory so a restart or second replica
  cannot bypass challenges.

### Infrastructure
- `packages/db` now the single source of truth for schema and migrations.
- Push-token drift migration added to unblock mobile rollout.
- Playwright e2e suite (30 specs) stabilized against prod rate limits.
- New devDeps: `pdfkit`, `qrcode`, `@axe-core/playwright`, `vitest`,
  `playwright`, `supertest`, `@faker-js/faker`.
- `.gitignore` expanded to exclude local investigation scripts.

---

## [v1.0.0] - 2026-04-13

Baseline snapshot of MedCore prior to the hardening session above.

### Included at baseline
- **Full-stack monorepo**: Next.js 15 web app, Express + Prisma API,
  Postgres, Socket.IO realtime, PM2 process manager.
- **Clinical modules**: OPD, IPD/Admissions, EHR, Prescriptions, Lab
  (orders + results), Pharmacy Inventory, Surgery/OT, Emergency/ER,
  Antenatal/Maternity, Pediatric, Immunizations, Telemedicine, Blood
  Bank, Ambulance, Referrals, Feedback, Chat, Visitor Pass.
- **Operational modules**: Appointments with queue, Billing + invoices
  (pending/partial states), Staff HR, Payroll, Leave Management, Assets,
  Purchase Orders, Suppliers, Wards, Notifications.
- **Auth**: password login with bcrypt, JWT access + refresh, 5 roles
  (SUPER_ADMIN, ADMIN, DOCTOR, NURSE, RECEPTIONIST), password reset.
- **Security**: rate limiting, audit logging, RBAC across routes.
- **Seed data**: 35 realistic patients, 14 days of history, full OPD flow
  across all modules for demo/dev use.
- **Deployment**: PM2 ecosystem config, `scripts/` for backup/restore/
  deploy/healthcheck/pm2-setup.
- **Docs**: PRD, TEST_PLAN, 68 Playwright screenshots (one per module)
  embedded in the README, full CONTRIBUTING guide with migration runbook.
- **500+ tests** at initial infrastructure commit (`a8f22e8`).

[Unreleased]: https://github.com/Globussoft-Technologies/medcore/compare/v1.0.0...HEAD
[v1.0.0]: https://github.com/Globussoft-Technologies/medcore/releases/tag/v1.0.0
