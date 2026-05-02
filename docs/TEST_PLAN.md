# MedCore Test Plan

This document describes the comprehensive test strategy for the MedCore monorepo.
It is intentionally pragmatic — we prioritise critical paths, validation contracts,
and business-rule-heavy services, and provide infrastructure that future tests can
easily extend.

---

## 1. Goals

1. Catch regressions in the most critical clinical/financial flows: auth, patient
   intake, appointment booking, prescriptions, billing, admissions, lab orders.
2. Lock down the public *contract* of the API by exhaustively testing every Zod
   validation schema in `packages/shared/src/validation/*`.
3. Provide a fast smoke test that proves the server boots and every top-level
   route returns a non-5xx response.
4. Keep test-time dependencies minimal. Only `vitest`, `supertest`, and
   `@faker-js/faker` are introduced.
5. Test coverage target: original goal was **150 - 200 test cases**; as of
   2026-05-03 the suite holds **~1,950+ active cases** across api
   (~2,860 raw `it/test(` declarations under `apps/api/src`), web (~990
   under `apps/web/src`), and shared/contract layers — netting out
   skips and parameterized fan-outs. e2e adds **40 specs / ~165 active
   cases** on top. The goal has shifted from headcount to
   risk-weighted coverage of the gaps in §7 below.

## 2. Tooling

| Concern               | Tool                  | Why                                              |
|-----------------------|-----------------------|--------------------------------------------------|
| Test runner           | **vitest**            | Native TypeScript, ESM friendly, watch mode.     |
| HTTP assertions       | **supertest**         | Industry standard for testing Express apps.     |
| Test data generation  | **@faker-js/faker**   | Realistic patient/doctor/appointment fixtures.  |
| Test database         | Existing Postgres + a separate schema (`medcore_test`) | No new infra. Reset with `prisma db push --force-reset`. |

> Testcontainers are intentionally **not** used — they add complexity and require
> Docker. Instead, tests assume a Postgres instance reachable via `DATABASE_URL_TEST`.

## 3. Layered test strategy

We organise tests into four layers:

### Layer 1 — Unit tests (no I/O)
Pure functions and small services. These run in milliseconds and are the
foundation of the suite.

| File                                            | What we test                              |
|-------------------------------------------------|-------------------------------------------|
| `apps/api/src/services/vitals-analysis.test.ts` | `computeVitalsFlags` against ~25 vital-signs edge cases (hypertensive crisis, fever, hypothermia, low SpO2, BMI categories, tachy/brady-cardia, severe pain). |
| `apps/api/src/services/vitals-baseline.test.ts` | `isBaselineDeviation` boundary tests.    |
| `apps/api/src/services/razorpay.test.ts`        | `createPaymentOrder` mock shape, `verifyPayment` HMAC roundtrip. |

### Layer 2 — Contract tests (Zod schemas)
Every Zod schema in `packages/shared/src/validation` gets at least one valid and
two invalid input cases. Validation tests are extremely fast and exercise the
public contract that all routes depend on.

Coverage by file:

| Validation file              | Schemas tested                                                             |
|------------------------------|----------------------------------------------------------------------------|
| `auth.ts`                    | login, register, changePassword, forgotPassword, resetPassword             |
| `patient.ts`                 | createPatient, updatePatient, mergePatient, recordVitals                   |
| `appointment.ts`             | bookAppointment, walkIn, reschedule, recurring, transfer, LWBS, waitlist   |
| `billing.ts`                 | createInvoice, recordPayment, refund, applyDiscount, bulkPayment           |
| `prescription.ts`            | createPrescription, copyPrescription, prescriptionTemplate                 |
| `ipd.ts`                     | createWard, createBed, admitPatient, discharge, recordIpdVitals, medicationOrder |
| `lab.ts`                     | createLabOrder, recordLabResult, labQC                                     |
| `clinical.ts`                | createReferral, scheduleSurgery                                            |
| `hr.ts`                      | createShift, createLeaveRequest                                            |
| `phase4-clinical.ts`         | createTelemedicine, createEmergencyCase, triage                            |
| `phase4-specialty.ts`        | createAncCase                                                              |
| `phase4-ops.ts`              | createDonor, createDonation, bloodRequest                                  |

### Layer 3 — Integration tests (supertest + real Prisma)
Each Express router gets one test file that exercises happy-path + key edge
cases. These tests require `DATABASE_URL_TEST` to point to an empty/disposable
schema. They are skipped automatically if the env is not set, so unit + contract
tests still run on a vanilla `npm test`.

We refactor `apps/api/src/index.ts` into:
- `apps/api/src/app.ts` — exports the configured `app` (no `listen`).
- `apps/api/src/server.ts` — imports app and calls `httpServer.listen`.

This separation lets supertest import `app` without spinning up a real socket.

Routes we cover (one file per router; each file 3-8 cases):

1. auth: register/login/me/changePassword
2. patients: create/list/get/update/search
3. appointments: book/walk-in/reschedule/cancel
4. queue: get queue
5. doctors: list, slots
6. prescriptions: create, copy
7. billing: invoice CRUD, payment, refund
8. pharmacy: list/dispense
9. lab: create order, record result
10. admissions: admit/discharge
11. medication: order/administer
12. emergency: case intake/triage
13. surgery: schedule
14. ehr: allergies/conditions
15. bloodbank: donor/donation/request
16. shifts + leaves
17. feedback
18. notifications: prefs/list
19. analytics: overview
20. audit: search

### Layer 4 — Smoke tests
A single `apps/api/src/test/smoke.test.ts` file that:
- Boots the app via `app.ts` (no listen).
- Hits `/api/health` and asserts 200.
- Walks through every top-level route and asserts the response is < 500 (i.e.
  not crashing). Unauthenticated routes correctly return 401, public routes
  return 200.

### Layer 5 — E2E (Playwright) — added 2026-04-30+
Originally out of scope; now active. Specs live in `/e2e/` (40 files,
~165 active cases). Coverage spans 7 user roles (admin, doctor, nurse,
reception, patient, lab-tech, pharmacist) using worker-scoped role-token
caching to respect auth rate limits. Tiers configurable via `--project`:

- **smoke** (3 specs / ~18 cases): explicit invocation only.
- **regression** (~7 specs / ~50 cases): explicit invocation only.
- **full** (40 specs) × **Chromium + WebKit**: required gate on
  `release.yml` (`workflow_dispatch` — explicit invocation).

**Policy (codified 2026-05-02):** E2E runs only when explicitly invoked
— locally via `scripts/run-e2e-locally.sh` or
`npx playwright test --project=<name>`, or in CI via the
`release.yml` workflow_dispatch trigger. E2E is intentionally NOT in
the per-push deploy gate and NOT in any post-deploy smoke step.
Auto-deploy gates only on the non-e2e tests (typecheck, lint,
npm-audit, migration-safety, web-bundle, api-tests, web-tests).
Release validation (`release.yml`) is the e2e gate; treat it as the
"ready to declare a release" check, not as part of every deploy.

E2E does not contribute to lcov line/branch numbers (Playwright is not
instrumented for coverage). Treat E2E coverage as *flow* coverage and
unit/integration as *line* coverage; do not conflate them.

## 4. Test data strategy

Factory functions live in `apps/api/src/test/factories.ts`. They use faker for
realistic data and accept overrides:

```ts
const patient = await createPatientFixture({ gender: "FEMALE" });
const doctor = await createDoctorFixture();
const appt = await createAppointmentFixture({ patientId: patient.id, doctorId: doctor.id });
```

Auth helper `getAuthToken(role)` creates a User of the requested role and signs a
JWT identical to what the auth router would issue.

Setup helper `resetDB()` runs `prisma db push --force-reset` against
`DATABASE_URL_TEST` then seeds a minimal admin user.

## 5. Running the tests

```bash
# All tests (unit + contract + smoke if DB available)
npm test

# Watch mode while developing
npm run test:watch

# Only fast unit tests (no DB required)
npm run test:unit

# Validation contract tests only
npm run test:contract

# Integration tests against test DB
DATABASE_URL_TEST=postgresql://user:pass@localhost:5432/medcore_test \
  npm run test:api

# Smoke
npm run test:smoke

# Coverage report
npm run test:coverage
```

## 6. CI

`.github/workflows/test.yml` spins up a Postgres service container, exports
`DATABASE_URL_TEST`, runs `prisma db push --force-reset`, then runs `npm test`.

## 7. Known gaps / future work

This list reflects the post-Wave-3 audit (2026-05-02). Items in §7.1 are
the canonical "what's not yet tested" backlog and are mirrored in
[`/TODO.md`](../TODO.md) under "Coverage gaps from 2026-05-02 audit."

### 7.1 Real gaps (no test of any kind)

**API middleware — `apps/api/src/middleware/`:** ✅ closed 2026-05-02 (`d3fc8fb`).

All four previously-untested middleware now have co-located `.test.ts`:
`tenant.ts` (15 tests), `sanitize.ts` (15), `audit.ts` (11),
`error.ts` (9). Plus `services/tenant-context.ts` (14 — the
AsyncLocalStorage helpers backing tenant scope propagation).
`auth.ts`, `rate-limit.ts`, `validate.ts`, `validate-params.ts`
were already covered.

**API services — schedulers in `apps/api/src/services/`:** ✅ closed
2026-05-02 (`c12c5db` + `5845a4e`).

All four core schedulers now have unit tests via the per-tick
extraction pattern: `adherence-scheduler.ts` (13),
`chronic-care-scheduler.ts` (18), `insurance-claims-scheduler.ts` (6,
on top of the existing `insurance-claims/reconciliation.test.ts`).
The audio-retention worker that `retention-scheduler.ts` wraps now
has its own tests (5); the scheduler itself is a 10-line
setInterval wrapper covered transitively. The "also worth a pass"
extras have landed too: `waitlist.ts` (3), `jitsi.ts` (18),
`metrics.ts` (9, focused on the cardinality firewall in
`httpMetricsMiddleware`). `metrics-counters.ts` is pure prom-client
config and intentionally skipped.

`patient-data-export.ts` (22 KB HIPAA export) still has an
integration suite that is `describe.skip`-ed pending migration;
un-skip when the migration lands rather than write a parallel unit
suite.

**E2E flow gaps — `/e2e/`:**

- `/dashboard/bloodbank` — clinical safety domain; only RBAC matrix
  touches it.
- `/dashboard/ambulance` — only mentioned peripherally in
  `emergency-er-flow.spec.ts`.
- `/dashboard/pediatric` — no spec.
- `/dashboard/budget`, `/expense`, `/payroll` — no specs.
- `/dashboard/admin-console`, `/dashboard/tenants` — only RBAC negative
  checks; no flow coverage.
- `/dashboard/ai-fraud`, `/ai-doc-qa`, `/ai-differential`, `/ai-kpis`
  smoke-tested only via `ai-smoke.spec.ts`; no deep-flow specs.

(`/dashboard/operating-theaters` IS covered by `ot-surgery.spec.ts`.)

**Web auth pages — `apps/web/src/app/`:** ✅ closed.

`/login`, `/register`, `/forgot-password` all have page-level tests
under `apps/web/src/app/__tests__/`:

- `login.page.test.tsx` (193 lines) — status-aware error handling
  (#15) covering 401/403/429/500 + Remember Me (#1).
- `login.novalidate.test.tsx` (79 lines) — `noValidate` form attribute
  + inline `data-testid="error-email"` rendering on empty/malformed
  email (#102).
- `register.page.test.tsx` (89 lines) — form render, submit success,
  API failure, sign-in link, gender select.
- `register.novalidate.test.tsx` (164 lines) — full client-side
  validator coverage: noValidate, all-fields-empty (one inline error
  per field at once, #130), malformed email, short phone, short
  password, age=0 floor (#167), per-field error clears on edit.
- `forgot-password.page.test.tsx` (79 lines) — email-step render,
  forgot-password POST, reset-step transition, API error display,
  sign-in link.

`/verify` is not a separate auth page; the only `/verify` route is
`/verify/rx/[id]/page.tsx` (the public Rx QR-verify page, covered
by `apps/web/src/app/verify/rx/[id]/page.test.tsx`). The 2FA verify
step is embedded inline in the login page and exercised through
`login.page.test.tsx`'s status-aware paths.

### 7.2 Skips — currently parked

- **6 bed-seeding skips** in `admissions-mar.spec.ts` and
  `emergency-er-flow.spec.ts` — `seedAdmission()` cannot find an
  AVAILABLE bed in the realistic seed. Seeder/fixture fix.
- **4 ABDM consent skips** in `abdm-consent.spec.ts` — UI surface
  drifted; awaiting consent-flow stabilization.
- **~5 explicit + ~30 cascading WebKit-conditional skips** — auth-redirect
  residue. Partial fix in `a8230d1` (cut 121→55 fails); root-cause fix
  tracked in [`/TODO.md`](../TODO.md) item #5.
- **6 React-19 + jsdom Suspense skips** in
  `apps/web/src/app/dashboard/feedback/[patientId]/page.test.tsx` —
  upstream blocker; track until React 19 + jsdom integration stabilizes.
- **~13 API integration skips** (edge-cases, expenses, ai-claims,
  emergency-deep, growth, patient-data-export) — pending product or
  migration decisions; legitimate parking, not silent regressions.

### 7.3 Coverage tooling gaps (visibility, not scope)

- ✅ **Threshold bump 2026-05-02 (`cc01e36`).** Vitest floors raised
  to `current_actual − 2pp` on both projects: api lines **24%** /
  branches **68%** / functions **68%** / statements **24%**; web lines
  **51%** / branches **65%** / functions **31%** / statements **51%**.
  Up from the previous basement-level 11% / 10%. Per-push CI must
  remain green at the new floors.
- ✅ **Codecov wired 2026-05-02 (`b3b090b` + `350e74a`).** PR comments
  surface coverage delta + per-flag (api/web) breakdowns. Trend graphs
  at `https://codecov.io/gh/Globussoft-Technologies/medcore`. Config
  in `codecov.yml` at repo root. The `CODECOV_TOKEN` repo secret
  enables uploads — without it, the upload step no-ops gracefully via
  the `if: hashFiles(...) != ''` guard (CI stays green; PR comments
  silent until the token lands).
- Playwright is not instrumented for coverage; E2E flow coverage is
  not visible in lcov totals (intentional; see Layer 5 above).
