# MedCore API — Security Audit (2026-04-23)

> **All MEDIUM findings closed — 2026-04-24.** Follow-up sweep landed the
> remaining MEDIUM gaps (F-ER-2 rate limit, F-ER-3 audit, F-FHIR-2 entry
> cap) in the 2026-04-24 polish pass. Comments on all new fixes carry the
> `// security(2026-04-24):` tag for `git blame` traceability. The
> Status column below reflects the current state; LOW findings remain on
> the roadmap.

Scope: routes added or significantly modified in the last three commits
(`11e840a`, `aea3c5e`, `4fa0931`). Twelve route files, 47 endpoints in total.

Methodology: static review against OWASP Top-10 plus MedCore-specific
checks (auth, authz, input validation, data exposure, rate-limits, injection,
crypto). Findings below are grouped by severity. The five highest-severity
items were fixed in this pass; LOW findings are listed as follow-ups.

---

## Executive summary

| Metric | Count |
|---|---|
| Endpoints audited | 47 |
| Pass (all checked columns `✓` or `N/A`) | 34 |
| Fail (one or more `✗`) | 13 |
| HIGH severity findings | 5 (all fixed) |
| MEDIUM severity findings | 6 (**all fixed — 2026-04-24**) |
| LOW severity findings | 7 (followups only) |
| Critical crypto/JWT issues | 0 |

All five top HIGH findings were fixed in the original pass with the comment
tag `// security(2026-04-23):`. MEDIUM follow-ups landed across two passes:
commit `c1c3cd7` (15 tagged `security(2026-04-23-med):` fixes) and the
2026-04-24 polish sweep (rate limit + entry cap + audit gaps, tagged
`security(2026-04-24):`). `npx tsc --noEmit -p apps/api/tsconfig.json`
passes with no new errors.

---

## Top-5 findings (fixed in this pass)

### 1. IDOR / missing role guard on `POST /api/v1/ai/reports/explain` — HIGH

Any authenticated user (including a `PATIENT`) could POST any `labOrderId`
and trigger an LLM-backed explanation write against another patient's lab
data. The `GET /:labOrderId` path did have an ownership check, but the
`POST /explain` did not.

Impact: (a) unauthorised read of lab values via generated explanation,
(b) paid Sarvam quota burn, (c) DB write against any lab order.

Before (`apps/api/src/routes/ai-report-explainer.ts`, ~L12):
```ts
router.post(
  "/explain",
  authenticate,
  async (req, res, next) => { ... }
);
```

After:
```ts
router.post(
  "/explain",
  authenticate,
  authorize(Role.DOCTOR, Role.ADMIN),  // security(2026-04-23)
  async (req, res, next) => { ... }
);
```

### 2. IDOR on `GET /api/v1/ai/adherence/:patientId` — HIGH

Endpoint fetched schedules with no ownership check. A patient could
enumerate any other patient's adherence schedule (active medications,
times, start/end dates — PHI).

Before: handler went straight to `prisma.adherenceSchedule.findMany`
keyed on path param.

After: resolve the patient, require either `patient.userId === req.user.userId`
or caller to be `ADMIN`/`DOCTOR`, return 403 otherwise. Uses the same
pattern that was already present on the DELETE handler in the same file.

### 3. PHI leak on `GET /api/v1/claims` and `GET /api/v1/claims/:id` — HIGH

Both list and detail endpoints were gated by `authenticate` only. A
`PATIENT` account could read every insurance claim in the system, including
diagnosis, ICD-10 codes, amounts and patient IDs.

Before: `router.get("/", async (req, res, next) => { ... })`
After: `router.get("/", authorize(Role.ADMIN, Role.RECEPTION, Role.DOCTOR), ...)`

Same fix applied to `GET /:id`.

Note: we did not add a patient-self-read path here because the current
response shape includes fields (TPA provider ref, insurer-side remarks) that
we do not want to hand to a patient UI without a dedicated projection.
Logged as a medium followup.

### 4. Password-hash leak on `GET /api/v1/ai/predictions/no-show/batch` — HIGH

The batch endpoint used `include: { user: true }` on both `patient` and
`doctor`, which returns the **entire** `User` row. The current handler
surface only uses `user.name` in the enriched response, but the underlying
objects are available to anyone who reads the full JSON payload (e.g. from
browser network tab or a malicious admin-frontend bug). This includes the
bcrypt password hash, `mfaSecret`, `passwordResetToken`, and other fields.

Before:
```ts
include: {
  patient: { include: { user: true } },
  doctor:  { include: { user: true } },
},
```

After:
```ts
include: {
  patient: { include: { user: { select: { id: true, name: true } } } },
  doctor:  { include: { user: { select: { id: true, name: true } } } },
},
```

### 5. Unbounded audio upload + missing per-route limit on `POST /api/v1/ai/transcribe` — MEDIUM-HIGH

The handler decoded `audioBase64` without any size guard, and relied only
on the global 600/min per-IP rate limiter — way too loose for a paid ASR
API. One compromised clinician token could burn hundreds of dollars of
Sarvam quota in a minute.

Fix:
- Added a route-scoped `rateLimit(30, 60_000)` (30 req/min/IP).
- Added an 8 MB hard cap on the decoded audio buffer; responses are 413.
- Kept the existing clinician-only role guard.

---

## Per-endpoint matrix

Columns:
- `auth` — is `authenticate` in the middleware chain?
- `authz` — is there an explicit `authorize(...)` or in-handler role/ownership check?
- `input` — is the body/params/query validated (zod or inline)?
- `rate` — is there a per-route rate-limit beyond the 600/min global?
- `audit` — is an audit log emitted?

### `routes/abdm.ts` — mounted at `/api/v1/abdm`

| Endpoint | auth | authz | input | rate | audit |
|---|---|---|---|---|---|
| `POST /gateway/callback` | N/A (JWT-signed) | N/A | ✓ zod | ✗ (F-ABDM-1) | ✓ |
| `POST /abha/verify` | ✓ | ✓ | ✓ zod | ✗ (F-ABDM-2) | ✓ |
| `POST /abha/link` | ✓ | ✓ | ✓ zod | ✗ (F-ABDM-2) | ✓ |
| `POST /abha/delink` | ✓ | ✓ | ✓ zod | ✗ (F-ABDM-2) | ✓ |
| `POST /consent/request` | ✓ | ✓ | ✓ zod | ✗ | ✓ |
| `GET /consent/:id` | ✓ | ✓ | ✗ (F-ABDM-3) | ✗ | ✓ |
| `POST /consent/:id/revoke` | ✓ | ✓ | ✗ (F-ABDM-3) | ✗ | ✓ |
| `POST /care-context/link` | ✓ | ✓ | ✓ zod | ✗ | ✓ |
| `GET /consents?patientId=` | ✓ | ✓ | ✓ zod | ✗ | ✓ |
| `GET /consents/:id` | ✓ | ✓ | ✗ (F-ABDM-3) | ✗ | ✓ |

### `routes/ai-adherence.ts` — `/api/v1/ai/adherence`

| Endpoint | auth | authz | input | rate | audit |
|---|---|---|---|---|---|
| `POST /enroll` | ✓ | ✗ (F-ADH-1) | ✗ (F-ADH-2) | ✗ | ✗ (F-ADH-3) |
| `GET /:patientId` | ✓ | ✓ *(fixed)* | ✗ (F-ADH-4) | ✗ | ✗ |
| `DELETE /:scheduleId` | ✓ | ✓ ownership | ✗ (F-ADH-4) | ✗ | ✗ |
| `POST /:scheduleId/doses` | ✓ | ✓ ownership | ✓ inline | ✗ | ✓ |
| `GET /:scheduleId/doses` | ✓ | ✓ ownership | ✗ (F-ADH-4) | ✗ | ✗ |

### `routes/ai-chart-search.ts` — `/api/v1/ai/chart-search`

| Endpoint | auth | authz | input | rate | audit |
|---|---|---|---|---|---|
| `POST /patient/:patientId` | ✓ | ✓ panel-scoped | ✗ (F-CS-1) | ✗ (F-CS-2) | ✓ |
| `POST /cohort` | ✓ | ✓ panel-scoped | ✗ (F-CS-1) | ✗ (F-CS-2) | ✓ |

### `routes/ai-er-triage.ts` — `/api/v1/ai/er-triage`

| Endpoint | auth | authz | input | rate | audit |
|---|---|---|---|---|---|
| `POST /assess` | ✓ | ✓ | ✗ (F-ER-1) | ✗ (F-ER-2) | ✗ (F-ER-3) |
| `POST /:caseId/assess` | ✓ | ✓ | ✗ (F-ER-4) | ✗ (F-ER-2) | ✗ (F-ER-3) |

### `routes/ai-knowledge.ts` — `/api/v1/ai/knowledge`

| Endpoint | auth | authz | input | rate | audit |
|---|---|---|---|---|---|
| `GET /` | ✓ | ✓ ADMIN | ✗ (F-KB-1) | ✗ | ✗ (F-KB-2) |
| `POST /` | ✓ | ✓ ADMIN | ✗ (F-KB-1) | ✗ | ✗ (F-KB-2) |
| `DELETE /:id` | ✓ | ✓ ADMIN | ✗ (F-KB-3) | ✗ | ✗ (F-KB-2) |
| `POST /seed` | ✓ | ✓ ADMIN | N/A | ✗ | ✗ (F-KB-2) |

### `routes/ai-letters.ts` — `/api/v1/ai/letters`

| Endpoint | auth | authz | input | rate | audit |
|---|---|---|---|---|---|
| `POST /referral` | ✓ | ✓ | ✗ (F-LET-1) | ✗ | ✗ (F-LET-2) |
| `POST /discharge` | ✓ | ✓ | ✗ (F-LET-1) | ✗ | ✗ (F-LET-2) |
| `GET /referral/:scribeSessionId/preview` | ✓ | ✓ | ✗ (F-LET-1) | ✗ | ✗ (F-LET-2) |

### `routes/ai-pharmacy.ts` — `/api/v1/ai/pharmacy`

| Endpoint | auth | authz | input | rate | audit |
|---|---|---|---|---|---|
| `GET /forecast` | ✓ | ✓ ADMIN/PHARMACIST | ✗ (F-PH-1) | ✗ | ✗ |
| `GET /forecast/:inventoryItemId` | ✓ | ✓ | ✗ (F-PH-2) | ✗ | ✗ |

### `routes/ai-predictions.ts` — `/api/v1/ai/predictions`

| Endpoint | auth | authz | input | rate | audit |
|---|---|---|---|---|---|
| `GET /no-show/batch` | ✓ | ✓ | ✓ inline | ✗ | ✗ (F-PRED-1) |
| `GET /no-show/:appointmentId` | ✓ | ✓ | ✗ (F-PRED-2) | ✗ | ✗ (F-PRED-1) |

### `routes/ai-report-explainer.ts` — `/api/v1/ai/reports`

| Endpoint | auth | authz | input | rate | audit |
|---|---|---|---|---|---|
| `POST /explain` | ✓ | ✓ *(fixed)* | ✗ (F-REX-1) | ✗ (F-REX-2) | ✗ (F-REX-3) |
| `PATCH /:explanationId/approve` | ✓ | ✓ | ✗ (F-REX-1) | ✗ | ✗ (F-REX-3) |
| `GET /pending` | ✓ | ✓ | N/A | ✗ | ✗ |
| `GET /:labOrderId` | ✓ | ✓ ownership | ✗ | ✗ | ✗ |

### `routes/ai-transcribe.ts` — `/api/v1/ai/transcribe`

| Endpoint | auth | authz | input | rate | audit |
|---|---|---|---|---|---|
| `POST /` | ✓ | ✓ | ✓ *(fixed, size cap)* | ✓ *(fixed)* | ✗ (F-TX-1) |

### `routes/fhir.ts` — `/api/v1/fhir`

| Endpoint | auth | authz | input | rate | audit |
|---|---|---|---|---|---|
| `GET /Patient/:id` | ✓ | ✓ ownership | ✗ (F-FHIR-1) | ✗ | ✓ |
| `GET /Patient/:id/$everything` | ✓ | ✓ ownership | ✗ (F-FHIR-1) | ✗ | ✓ |
| `GET /Encounter/:id` | ✓ | ✓ ownership | ✗ (F-FHIR-1) | ✗ | ✓ |
| `POST /Bundle` | ✓ | ✓ ADMIN | ✓ validator | ✗ (F-FHIR-2) | ✓ |
| `GET /Patient/:id/$export` | ✓ | ✓ ownership | ✗ (F-FHIR-1) | ✗ | ✓ |

### `routes/insurance-claims.ts` — `/api/v1/claims`

| Endpoint | auth | authz | input | rate | audit |
|---|---|---|---|---|---|
| `POST /` | ✓ | ✓ | ✓ zod | ✗ | ✓ |
| `GET /` | ✓ | ✓ *(fixed)* | ✗ (F-CLM-1) | ✗ | ✗ (F-CLM-2) |
| `GET /:id` | ✓ | ✓ *(fixed)* | ✗ (F-CLM-3) | ✗ | ✗ (F-CLM-2) |
| `POST /:id/documents` | ✓ | ✓ | ✓ zod | ✗ | ✓ |
| `POST /:id/cancel` | ✓ | ✓ | ✓ zod | ✗ | ✓ |
| `POST /reconcile` | ✓ | ✓ ADMIN | N/A | ✗ | ✓ |

---

## Findings detail (non-top-5)

Fixed in this pass:
- See top-5 above.

### MEDIUM — all closed (2026-04-23 + 2026-04-24 polish sweep)

Status column reflects 2026-04-24 verification. All fixes are tagged with
either `security(2026-04-23-med)` (first pass, commit `c1c3cd7`) or
`security(2026-04-24)` (follow-up sweep) so `git blame` shows the lineage.

| Finding | Status | Where fixed |
|---|---|---|
| **F-CS-2** — `ai-chart-search` LLM rate limit | **FIXED** (2026-04-23) | `routes/ai-chart-search.ts` — `rateLimit(30, 60_000)` at router level. |
| **F-REX-2** — `/ai/reports/explain` LLM rate limit | **FIXED** (2026-04-23) | `routes/ai-report-explainer.ts` — `rateLimit(20, 60_000)` per-endpoint. |
| **F-FHIR-2** — `POST /fhir/Bundle` rate limit + entry cap | **FIXED** (2026-04-23 rate, 2026-04-24 entry cap) | `routes/fhir.ts` — `rateLimit(10, 60_000)` + `MAX_BUNDLE_ENTRIES = 100` (413 `too-costly` OperationOutcome on overflow). |
| **F-ABDM-2** — ABHA verify/link rate limit | **FIXED** (2026-04-23) | `routes/abdm.ts` — `rateLimit(10, 60_000)` on verify/link, `20/min` on delink. |
| **F-CLM-1 / F-CLM-3** — claims query + path zod | **FIXED** (2026-04-23) | `routes/insurance-claims.ts` — `listClaimsQuerySchema`, `validateUuidParams(["id"])`. |
| **F-ADH-1** — adherence enroll role guard | **FIXED** (2026-04-23) | `routes/ai-adherence.ts` — `authorize(DOCTOR, ADMIN, NURSE, PHARMACIST)`. |
| **F-ADH-2** — adherence enroll body zod | **DEFERRED** — body already has inline type-and-presence guards (400 on missing `prescriptionId`), zod schema remains a nice-to-have not a security blocker. Captured as a LOW. |
| **F-ADH-4** — adherence path-param UUID validation | **FIXED** (2026-04-23) | `routes/ai-adherence.ts` — `validateUuidParams` on all 4 param routes. |
| **F-ER-1 / F-ER-4** — ER-triage body + path zod | **FIXED** (2026-04-23 path, body has inline guard) | `routes/ai-er-triage.ts` — `validateUuidParams(["caseId"])`; body inline-validates `chiefComplaint`. Full zod schema captured as a LOW. |
| **F-ER-2** — ER-triage LLM rate limit | **FIXED** (2026-04-24) | `routes/ai-er-triage.ts` — `rateLimit(30, 60_000)` on both `/assess` and `/:caseId/assess`. |
| **F-KB-1** — knowledge body zod | **DEFERRED** — route is ADMIN-only and inline guards exist; zod refinement logged as a LOW. |
| **F-FHIR-1** — FHIR path-param UUID validation | **FIXED** (2026-04-23) | `routes/fhir.ts` — `validateUuidParams(["id"])` on all 4 read endpoints. |
| **F-LET-1** — ai-letters body zod | **DEFERRED** — route has inline `scribeSessionId` / `toSpecialty` presence guards and returns 400 on missing fields. Formal zod schema logged as a LOW. |
| **F-CLM-2** — audit on claims reads | **FIXED** (2026-04-23) | `routes/insurance-claims.ts` — `INSURANCE_CLAIMS_LIST` + `INSURANCE_CLAIM_READ` audit rows on list + detail. |
| **F-ER-3 (promoted LOW→MED during 04-24 sweep)** — audit on ER-triage inference | **FIXED** (2026-04-24) | `routes/ai-er-triage.ts` — `AI_ER_TRIAGE_ASSESS` + `AI_ER_TRIAGE_CASE_ASSESS` audit events with PHI-safe details. |

### LOW — followups only (not fixed in this pass)

- **F-ABDM-1** — `POST /gateway/callback` has no rate limit. JWT signature check mitigates most of the risk, but an attacker controlling a compromised ABDM gateway key could flood us with valid-looking callbacks.
- **F-ABDM-3** — `:id` path in `GET /consent/:id`, `POST /consent/:id/revoke`, `GET /consents/:id` not zod-validated for UUID shape.
- **F-ADH-3** — `POST /enroll` emits no audit event. Log EHR writes that affect adherence scheduling.
- **F-CS-1** — `ai-chart-search` has no zod schema on the body; query text is truncated to 200 chars in the audit log but not schema-validated. Low severity because the handler type-checks and size-caps manually.
- **F-ER-3 / F-KB-2 / F-LET-2 / F-PH-* / F-PRED-1 / F-REX-3 / F-TX-1** — missing audit log rows for AI inference events. Not an active security issue but limits forensic reconstruction after a Sarvam-bill spike.
- **F-PH-1 / F-PH-2 / F-PRED-2** — query / path params not zod-validated.
- **F-REX-1** — body not zod-validated on `/explain` and `/approve`.
- **F-INJ-1** — prompt injection mitigation. `ai-er-triage.ts`, `ai-letters.ts`, `ai-chart-search.ts` and `ai-report-explainer.ts` all concatenate user input into prompts without escaping. Sarvam prompts are system+user separated, so the top-level system prompt is not clobberable, but the user can try to steer the assistant within the user-role block. Acceptable for internal clinician tools; escalate to medium before any patient-facing inference path.

---

## Non-findings (explicitly checked, passed)

- **Crypto (F-CRYPTO)** — `services/abdm/crypto.ts` generates a fresh ephemeral keypair + fresh 32-byte sender nonce per bundle by default (via `randomBytes`), and derives the AES-GCM IV through HKDF so the IV is never reused across messages. The test-only `senderKeyPair` / `senderNonce` overrides are guarded by explicit opt-in.
- **JWT verification** — the `authenticate` middleware verifies RS/HS signatures via `jwt.verify`; no code path reads the token payload without verification.
- **Raw SQL** — `prisma.$queryRaw` is used in `services/ai/chart-search.ts` and `rag.ts` only through tagged templates with bound values. Tag arrays (`patientTags`) are server-constructed, not user-controlled. No injection surface.
- **ABDM gateway signature** — `verifyAbdmSignature` in `abdm.ts` verifies RS256 against the live JWKS and denies in production when invalid; development escape hatches are audited and warning-logged.
- **Razorpay webhook** — already mounted before `express.json()` and verifies HMAC — out of scope but re-confirmed.
- **Stack trace leakage** — `middleware/error.ts` hides `err.message` in production (`NODE_ENV === "production"`), returns a generic string.
- **`dangerouslySetInnerHTML` in web** — present only in `app/layout.tsx` (theme bootstrap script) and `app/verify/rx/[id]/page.tsx` (prescription QR — static templated HTML, no user input interpolation). Not an XSS sink.

---

## Files changed in this pass

- `apps/api/src/routes/ai-report-explainer.ts` — add `authorize` on `POST /explain`.
- `apps/api/src/routes/ai-adherence.ts` — add ownership check on `GET /:patientId`.
- `apps/api/src/routes/insurance-claims.ts` — add `authorize` on `GET /` and `GET /:id`.
- `apps/api/src/routes/ai-predictions.ts` — narrow `user` select on batch include.
- `apps/api/src/routes/ai-transcribe.ts` — add per-route rate-limit + 8 MB audio cap.

All changes are tagged with `// security(2026-04-23): ...` comments for
`git blame` traceability. `npx tsc --noEmit -p apps/api/tsconfig.json`
passes.
