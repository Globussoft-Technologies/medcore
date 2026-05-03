# Changelog

All notable changes to MedCore are documented here. This project follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and adheres (loosely)
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Session window: 2026-04-30 → 2026-05-03. Focus: CI hardening Phases 1-4,
test-coverage closure across §A-§E gaps, Playwright stabilization
across Chromium + WebKit, and the local-first test workflow.

### Added
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
