# Test Coverage Audit (Non-E2E)

> Generated: 2026-05-02. **Status update 2026-05-03:** every priority
> item from §5 (Top 10 ROI-ranked recommendations) was closed in the
> 2026-05-03 gap-closer pass — see
> [`archive/TEST_GAPS_2026-05-03.md`](archive/TEST_GAPS_2026-05-03.md)
> for the closure log + commit refs. The §3 "Test types ABSENT" backlog
> remains the active future-direction list.
>
> Scope: All test types in the MedCore monorepo EXCEPT the Playwright E2E suite.
> Companion doc: [`E2E_COVERAGE_BACKLOG.md`](E2E_COVERAGE_BACKLOG.md) for the
> Playwright/E2E gap analysis.

This audit catalogs every test category present in the repo, what it covers,
what's missing, and which categories are entirely absent. Use it as input when
prioritizing test investments alongside the E2E backlog.

**Snapshot counts (§1, §2) reflect 2026-05-02 state.** As of 2026-05-03:
~510 new test cases shipped today across the four-wave gap-closer pass
(Session 1, Wave A, Wave C, low-priority). README total: ~2,700+ active
cases. Re-tally if you need fresh numbers.

---

## 1. Snapshot

| Metric | Count |
|---|---|
| Total test files (excluding `node_modules`) | 481 |
| Backend unit tests (`apps/api/src/services`) | 74 |
| API integration tests (`apps/api/src/test/integration`) | 133 |
| Frontend unit tests (`apps/web/src`) | 158 |
| Shared package unit tests (`packages/*`) | 17 |
| API route handler tests (`apps/api/src/routes`) | 16 |
| API middleware tests (`apps/api/src/middleware`) | 8 |
| Mobile tests (`apps/mobile/__tests__`) | 16 |
| Smoke tests | 1 |
| AI evaluation harness | 2 + fixtures |
| Load test scripts | 5 |
| Contract/schema validation | 17 |
| Playwright E2E (separate doc) | 40 |

Primary runner: **Vitest** (jsdom for web, node for API/services). Mobile uses
**Jest**. E2E uses **Playwright**. Static analysis is **CodeQL**.

---

## 2. Test types FOUND

### 2.1 Backend unit tests (services)
- **Path:** `apps/api/src/services/**/*.test.ts`
- **Count:** 74
- **Runner:** Vitest (node)
- **Coverage:** AI services (triage, scribe, letter generator, drug
  interactions, RAG, prompt safety, model routing); ABDM (ABHA, client, crypto,
  health records, JWKS); channels (email, SMS, WhatsApp, push); FHIR; HL7v2;
  payments (Razorpay, revenue); audit archival; consent; notifications; file
  magic; PDF processing; storage; signed URLs; vitals analysis; scheduled
  tasks; rate limiting; tenant provisioning.
- **Sample files:** `sarvam.test.ts`, `ocr.test.ts`, `consent.test.ts`,
  `storage.test.ts`, `razorpay.test.ts`, `hl7v2/messages.test.ts`,
  `abdm/client.test.ts`.
- **Notes:** External LLM/provider calls are mocked — keeps CI fast but
  defers real-world validation to AI evals + load tests.

### 2.2 Frontend unit tests
- **Path:** `apps/web/src/**/*.test.tsx`
- **Count:** 158
- **Runner:** Vitest (jsdom)
- **Coverage:** Dashboard pages (patients, admissions, appointments, lab,
  prescriptions, billing, etc.); auth flows; shared components (DataTable,
  Autocomplete, ConfirmDialog, Toast, Skeleton, EntityPicker, SearchPalette,
  LanguageDropdown); specialized modules (scribe voice-commands, lab
  range-hint-dedup).
- **Sample files:** `login.page.test.tsx`, `admissions.page.test.tsx`,
  `chat.page.test.tsx`, `emergency.detail.page.test.tsx`,
  `prescriptions.page.test.tsx`.
- **Notes:** No `jest-axe` integration — a11y only runs in Playwright via
  `@axe-core/playwright`. Hook testing thin; complex business-logic modals
  not exhaustively covered.

### 2.3 Shared package unit tests
- **Path:** `packages/shared/src/validation/__tests__`,
  `packages/db/src/lib/__tests__`
- **Count:** 17
- **Runner:** Vitest
- **Coverage:** Zod schemas for appointments, auth, billing,
  clinical/prescription, HR, patient data, security, finance, marketing,
  pharmacy ops; DB helpers (immunization schedules); ABO compatibility.
- **Sample files:** `appointment.test.ts`, `patient.test.ts`, `auth.test.ts`,
  `billing.test.ts`, `abo-compatibility.test.ts`,
  `validation-cluster-2026-04-26.test.ts`.

### 2.4 API integration tests
- **Path:** `apps/api/src/test/integration/**/*.test.ts`
- **Count:** 133
- **Runner:** Vitest + supertest + real PostgreSQL (forked process for
  isolation)
- **Coverage:** Multi-tenant scenarios, RBAC for all roles, AI endpoints
  (triage, scribe, chart search, bills, letters, fraud, knowledge QA, lab
  intel, previsit, sentiment, transcription); ABDM consent workflows;
  admissions (deep, unique constraints); billing cycles; insurance
  preauth/claims; lab tech workflows; prescriptions; appointments;
  telemedicine; referrals; surgery/OT; handoffs; pediatric care; adherence;
  leave management; notifications; pharmacy forecast; predictions; ER triage.
- **Sample files:** `ai-er-triage.test.ts`, `ai-scribe.test.ts`,
  `billing-cycle.test.ts`, `abdm-consents-list.test.ts`,
  `admissions-deep.test.ts`.
- **Gaps:** Concurrent multi-user stress thin; circuit breakers / retries
  thinly tested; long-running cron / scheduler workflows not formally
  integration-tested.

### 2.5 API route handler tests
- **Path:** `apps/api/src/routes/**/*.test.ts`
- **Count:** 16
- **Coverage:** Route handlers for admissions vitals, AI ER triage, AI KPIs,
  AI letters, analytics, appointments, budgets, complaints, health check,
  medication MAR patch, etc.
- **Gaps:** No OpenAPI conformance test; request/response schema drift
  undetected.

### 2.6 API middleware tests
- **Path:** `apps/api/src/middleware/**/*.test.ts`
- **Count:** 8
- **Coverage:** Auth middleware, rate limiting, request param validation,
  body/query validation.
- **Gaps:** Middleware composition order not verified; cascading-failure
  scenarios absent.

### 2.7 Mobile app tests
- **Path:** `apps/mobile/__tests__/**/*.test.tsx`
- **Count:** 16
- **Runner:** Jest (React Native / Expo render tests)
- **Coverage:** Screen smoke tests (login, register, appointments, billing,
  prescriptions, queue, doctor workspace, adherence, lab explanation, AI
  triage); auth context; `usePushRegistration` hook.
- **Sample files:** `login.smoke.test.tsx`, `auth.context.test.tsx`,
  `appointments.render.test.tsx`.
- **Gaps:** No E2E mobile automation (Detox / Maestro); gestures untested;
  iOS/Android platform divergence undetected; navigation stack untested;
  offline sync logic unverified.

### 2.8 Server smoke test
- **Path:** `apps/api/src/test/smoke.test.ts`
- **Count:** 1
- **Coverage:** Express boots without crash; 22+ top-level v1 route mounts
  exist; `/api/health` returns 200; bad auth payloads return 4xx, not 5xx.
- **Gaps:** Routes tested for existence, not behavior; middleware order not
  verified; error handler placement untested.

### 2.9 AI evaluation tests (live LLM)
- **Path:** `apps/api/src/test/ai-eval/eval.test.ts`,
  `eval-runner.test.ts`, fixtures: `triage-cases.ts`, `soap-cases.ts`,
  `drug-safety-cases.ts`
- **Gating:** Runs only if `SARVAM_API_KEY` or `OPENAI_API_KEY` is set;
  CI gate via `RUN_AI_EVAL=1`.
- **Coverage:** Triage emergency detection (100% pass gate); specialty
  routing (>50% pass gate); SOAP generation; red-flag detection (1% FN
  threshold); drug-safety interaction check.
- **Gaps:** Limited dataset (3 fixtures); no per-model A/B; no latency SLA
  check; no token-cost tracking.

### 2.10 Load tests
- **Path:** `scripts/load-tests/`
- **Count:** 5 files (`run-load-test.ts`, `mock-server.ts`, `payloads.ts`,
  `auth-helper.ts`, `README.md`)
- **Framework:** Custom Node harness (native `fetch` + `perf_hooks`) — no
  k6 / Artillery.
- **Scenarios:** Triage (symptom input), scribe (audio transcription),
  chart-search (patient query).
- **Flags:** `--concurrency`, `--requests`, `--endpoint`, `--base-url`,
  `--mock-port`, `--verbose`. Baseline tracked in `BASELINE.md`.
- **Gaps:** No automatic SLA enforcement; results not persisted; no CI gate;
  mock server is for local dev, not production replay.

### 2.11 Contract / schema validation
- **Path:** `packages/shared/src/validation/**`
- **Count:** 17 (counted under §2.3)
- **Coverage:** Zod schemas for all major domain entities.
- **Gaps:** No Pact / consumer-driven contract testing; no OpenAPI
  conformance tests against runtime; Prisma migrations not formally tested.

### 2.12 Static analysis (CI gate)
- **Path:** `.github/workflows/codeql.yml`
- **Tool:** GitHub CodeQL (`security-extended` for JavaScript/TypeScript)
- **Schedule:** Push to `main`, PRs to `main`, weekly cron.
- **Findings:** GitHub Security tab.
- **Gaps:** No Semgrep, Snyk, or dependency-audit gate; secret scanning not
  explicitly enforced in CI.

### 2.13 Lint / typecheck (CI gate)
- **Tools:** ESLint, `tsc`
- **Enforcement:** Every push and PR.
- **Coverage thresholds (locked):**
  - Backend: 11% lines, 57% branches, 55% functions
  - Frontend: 10% lines, 61% branches, 28% functions
  - Growth enforced; lowering blocked.
- **Gap:** Line-coverage thresholds far below the global 80% target in
  `~/.claude/rules/common/testing.md`.

---

## 3. Test types ABSENT

Categories with zero presence in the repo today.

1. **Storybook / Chromatic / Percy / Loki** — no component-level visual
   regression
2. **Property-based testing** — no fast-check
3. **Mutation testing** — no Stryker config
4. **Performance benchmarks** — no `*.bench.ts`, no Vitest bench, no
   tinybench
5. **Testcontainers** — none, despite heavy real-DB integration tests
6. **Worker / queue / cron tests** — scheduled tasks (adherence, claims,
   chronic care) only have unit-level mocks
7. **DB migration tests** — Prisma migrations not forward/backward verified
8. **PostgreSQL RLS policy tests** — tenant isolation enforced at app layer
   only
9. **OpenAPI / Pact contract tests** — no consumer-driven contract
   verification with mobile / 3rd parties (ABDM, insurance gateways)
10. **i18n string completeness** — no missing-key detection
11. **jest-axe / vitest-axe** — a11y absent from unit suite
12. **FHIR conformance** — resources tested, but Bundle validation /
    search-parameter compliance not exercised
13. **Mobile E2E (Detox / Maestro)** — render/smoke only
14. **Snapshot regression for PDF/letter output** — AI-generated letters,
    discharge summaries, invoices not locked
15. **Dependency audit gate** — no `npm audit` or Snyk in CI

---

## 4. Strength assessment

### Strong
- Backend service unit coverage (74 files; AI, ABDM, channels, payments)
- API integration breadth (133 files; multi-tenant, RBAC, clinical)
- Frontend page coverage (158 files across dashboard + components)
- Schema validation (Zod) for major entities
- CI security gate (CodeQL `security-extended`)

### Moderate
- AI evaluation: live LLM gates exist but small dataset, no A/B
- Load testing: harness present but no SLA gate, no persistence
- Mobile: render/smoke only, no flow-level verification

### Weak
- Database layer: no migration verification, RLS tests, seed-correctness
- Background jobs / scheduler: only unit-level mocks
- Accessibility outside E2E
- Performance benchmarking / regression detection
- Consumer-driven contracts (mobile ↔ API ↔ ABDM)
- Coverage thresholds (10–11% lines, far below 80% target)
- Mobile E2E

---

## 5. Top recommendations (ROI-ranked)

> **Status (2026-05-03):** P11 and P12 closed; P1 closed without
> Testcontainers (per repo policy, see notes); P2–P10 remain open.
> Closure log lives in `archive/TEST_GAPS_2026-05-03.md` for the
> separate Top-10 priority pass that ran in parallel.

### P1 — Testcontainers integration tests for scheduled / background jobs ✅ CLOSED 2026-05-02 (without Testcontainers)
- **Status:** Schedulers got unit-level coverage with mocked Prisma in
  the §B audit closure (`c12c5db` + `5845a4e`): `adherence-scheduler`,
  `chronic-care-scheduler`, `insurance-claims-scheduler`,
  `audio-retention`. Plus the per-tick logic helpers (`evaluateThresholds`,
  `isCheckInDue`, `msUntilNextDailyTick`) were extracted and pure-tested.
  Testcontainers itself remains intentionally out (per `TEST_PLAN.md` §2:
  "Testcontainers are intentionally **not** used — they add complexity
  and require Docker"). Real integration coverage rides on
  `DATABASE_URL_TEST` against a shared Postgres in CI.
- **Why we accepted no-Testcontainers:** the unit + mocked-Prisma layer
  catches the bulk of business-logic regressions; real Postgres testing
  via `DATABASE_URL_TEST` covers the schema/SQL layer. The Testcontainers
  middle path was deemed not worth the Docker dependency for marginal
  signal.

### P2 — DB migration and seed verification
- **Why:** Schema changes (RLS, unique constraints, defaults) ship
  unverified. Rollback paths untested.
- **What:** New `packages/db/src/__tests__/migrations.test.ts`. Spin up a
  Postgres container, apply migrations forward, verify schema, then walk
  back to a known prior state. Add seed-idempotency tests.

### P3 — Add `jest-axe` / `vitest-axe` to component suite
- **Why:** Healthcare WCAG 2.1 AA is mandatory in many markets.
  Accessibility currently runs only in Playwright (which is paused per
  TODO.md per the audit).
- **What:** Wire axe into `apps/web/vitest.config.ts`. Cover DataTable,
  forms, modals, dialogs first. Target ≥90% of interactive components.

### P4 — RLS policy verification tests
- **Why:** Multi-tenant isolation is enforced via Prisma context, not
  PostgreSQL RLS. Any regression in scoping logic is a data-leak incident.
- **What:** `packages/db/src/__tests__/rls.test.ts`. Connect with two
  tenant contexts, verify each can only see its own rows across the
  tenant-scoped tables.

### P5 — Mobile E2E (Detox or Maestro)
- **Why:** Render tests miss navigation, gestures, offline sync, and
  iOS/Android divergence.
- **What:** Detox is more monorepo-friendly. Cover 5–10 critical journeys:
  login, appointment booking, prescription refill, telemedicine join,
  offline-then-sync.

### P6 — Load-test SLA gate in CI
- **Why:** Harness exists but results aren't enforced — regressions ship
  silently.
- **What:** Parse load-test results JSON; fail PR if p95 latency >
  threshold or error rate > 1%. Add as job in `test.yml`.

### P7 — Expand AI evaluation dataset and add per-model tracking
- **Why:** 3 fixtures is too thin for healthcare AI. No way to A/B new
  models or prompt versions.
- **What:** Grow `triage-cases.ts` to 50+ edge cases (rare presentations,
  language variants). Add Sarvam vs OpenAI comparison harness with cost +
  latency dimensions.

### P8 — Consumer-driven contract tests (OpenAPI / Pact)
- **Why:** Mobile, web, ABDM, insurance gateways all consume the API.
  Schema drift undetected today.
- **What:** Either generate from existing OpenAPI spec (preferred) or
  introduce Pact for mobile↔API. Run alongside integration tests in CI.

### P9 — Snapshot tests for PDF / letter generators
- **Why:** AI-generated letters, prescriptions, discharge summaries,
  invoices are untouched by snapshot regression — silent format drift.
- **What:** `apps/api/src/services/ai/__snapshots__/*.snap` with
  representative outputs. Update intentionally on release.

### P10 — Performance benchmarks for AI endpoints
- **Why:** Triage / scribe / chart-search latency drives UX. No
  regression alarm today.
- **What:** Vitest bench for hot paths. Set baseline from load-tests; flag
  PRs that regress >10%.

### P11 — Raise coverage thresholds toward 80% ✅ CLOSED 2026-05-02 (`cc01e36`)
- **Status:** Bumped to `current_actual − 2pp` floors. API: lines 11% →
  24%, branches 57% → 68%, functions 55% → 68%, statements 11% → 24%.
  Web: lines 10% → 51%, branches 61% → 65%, functions 28% → 31%,
  statements 10% → 51%. Not at 80% line yet — staircase further on
  subsequent releases as tests grow.

### P12 — Dependency audit gate ✅ CLOSED (CI Phase 1.3, deploy gate)
- **Status:** `npm audit --workspace=apps/api --workspace=apps/web
  --audit-level=high --omit=dev` is in `.github/workflows/test.yml`'s
  `deploy.needs:` array. Blocks deploy on high/critical CVEs. Mobile
  workspace excluded (Expo stack has known major-bump-blocked CVEs
  tracked separately).

---

## 6. Suggested rollout

| Phase | Items | Status |
|---|---|---|
| Now (1–2 sprints) | ~~P1, P2, P12~~ | P1 ✅ via mocked-Prisma units (`c12c5db`/`5845a4e`); P12 ✅ in CI Phase 1.3; **P2 still open** (DB migration + seed verification) |
| Next (2–4 sprints) | ~~P3~~, P4, ~~P11~~ | P11 ✅ (`cc01e36`); **P3 still open** (jest-axe in unit suite); **P4 still open** (RLS policy verification — multi-tenant covered via Prisma extension only, not PostgreSQL RLS) |
| Quarter | P5, P6, P9 | All still open. Mobile e2e via Maestro YAML scaffolds exist (`apps/mobile/e2e/`) but not wired to CI; load-test runs nightly with no SLA gate; PDF/letter snapshot tests not started. |
| Stretch | P7, P8, P10 | All still open. AI eval dataset grew to ~62 fixtures (`docs/AI_EVAL.md`) but no per-model A/B; no Pact/OpenAPI consumer tests; no Vitest bench for AI hot paths. |

---

## 7. Open questions / decisions

- **Coverage thresholds** — what's the path from 11% → 80%? Step or
  big-bang? Per-package or aggregate?
- **Testcontainers vs forked Postgres** — integration tests already use
  forked Postgres. Adopt Testcontainers project-wide or keep the existing
  mechanism for §2.4 and add Testcontainers only for scheduler/migration
  tests?
- **Mobile E2E tool** — Detox (good monorepo support, mature) vs Maestro
  (simpler YAML, less flake). Which fits CI cost budget?
- **AI eval cost** — RUN_AI_EVAL hits real LLM endpoints. Are we OK
  paying per-PR, or restrict to nightly + release?
- **Pact vs OpenAPI** — pick one for contract testing; running both is
  overhead.

---

## 8. Cross-references

- E2E gaps: [E2E_COVERAGE_BACKLOG.md](./E2E_COVERAGE_BACKLOG.md)
- Test plan / roadmap: [TEST_PLAN.md](./TEST_PLAN.md)
- AI eval design: [AI_EVAL.md](./AI_EVAL.md)
- Architecture: [ARCHITECTURE.md](./ARCHITECTURE.md)
