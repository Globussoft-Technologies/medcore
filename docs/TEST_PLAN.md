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
5. Test coverage target: **150 - 200 test cases** across the monorepo.

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

- Frontend (`apps/web`) tests are **out of scope** for this initial pass. A
  follow-up should add Vitest + React Testing Library for hooks/components.
- The integration test layer covers ~20 of ~50 routers. Lower-priority routers
  (visitors, suppliers, asset history, etc.) are exercised only by the smoke
  test (status code only).
- PDF service (`pdf.ts`) and `notification.ts` rely on Prisma; we test the pure
  helpers (`escapeHtml`, channel stubs) and rely on integration tests for the
  Prisma-touching paths.
- E2E browser tests (Playwright) are out of scope.
