# Test Gap Audit — 2026-05-06

> Generated: 2026-05-06. Cross-references the 2026-05-02 baseline in
> [`TEST_COVERAGE_AUDIT.md`](TEST_COVERAGE_AUDIT.md) and
> [`E2E_COVERAGE_BACKLOG.md`](E2E_COVERAGE_BACKLOG.md) against the actual
> file tree as of HEAD `9b2291a`. Scope: every test category in the
> repo — backend unit, API integration, route handler, middleware,
> frontend, mobile, packages, contract, AI eval, load, and absent
> categories.
>
> Methodology: programmatic per-file enumeration. Every route file in
> `apps/api/src/routes/`, every service in `apps/api/src/services/`,
> every middleware, every page in `apps/web/src/app/`, every validator
> in `packages/shared/src/validation/`, every helper in `packages/db/`
> was checked for a test sibling. Cross-referenced against integration
> tests in `apps/api/src/test/integration/`.

---

## 1. Snapshot

| Slice | Source files | Tests | Notes |
|---|---|---|---|
| API routes (`apps/api/src/routes/*.ts`) | 84 | 26 co-located + 159 integration | 0 wholly untested; gaps are partial/shallow |
| API services (`apps/api/src/services/`) | ~78 | ~57 | 21 untested files |
| API middleware (`apps/api/src/middleware/`) | 11 | 8 | 3 untested — all security-critical |
| Web pages (`apps/web/src/app/**/page.tsx`) | 132 | 131+ | 1 truly uncovered (copy-paste bug) |
| Web components/lib | many | many | 4 specific gaps |
| Mobile (`apps/mobile/__tests__/`) | — | 16 render/smoke | No flow tests; Maestro YAML scaffolds exist but not wired to CI |
| Shared validators (`packages/shared/src/validation/`) | ~28 | ~17 | 6 large validators uncovered |
| `packages/db/` | — | 17 | Tenant scoping + RLS + immunization covered |
| E2E (`e2e/`) | — | 132 specs | Tracked separately in `E2E_COVERAGE_BACKLOG.md` |

---

## 2. Specific source-file gaps

### 2.1 API routes

**MISSING (no tests at all):** _none_. Every route has at least one
integration test. Zero blind-spot routes.

**UNIT-ONLY (no integration test — verify smoke is enough):**

- `apps/api/src/routes/ai-kpis.ts`
- `apps/api/src/routes/health.ts`
- `apps/api/src/routes/icd10.ts`

**PARTIAL (only feature-shard unit tests, no full handler matrix):**

| Route | Existing shard | Missing |
|---|---|---|
| `apps/api/src/routes/admissions.ts` | `admissions-concurrency.test.ts`, `admissions-vitals.test.ts` | RBAC matrix, Zod rejections, audit assertions across remaining handlers |
| `apps/api/src/routes/analytics.ts` | `analytics-ai-triage.test.ts`, `analytics-overview.test.ts` | Per-handler matrix |
| `apps/api/src/routes/appointments.ts` | `appointments-scribe-today.test.ts` | Per-handler matrix (reschedule, cancel, reminders) |
| `apps/api/src/routes/bloodbank.ts` | `bloodbank-cross-match.test.ts` | Per-handler matrix |
| `apps/api/src/routes/expenses.ts` | `expenses-approve.test.ts` | Create/reject/list/audit |
| `apps/api/src/routes/leaves.ts` | `leaves-approve.test.ts` | Submit/cancel/calendar |
| `apps/api/src/routes/medication.ts` | `medication-mar-patch.test.ts` | Order/dispense/audit |

**INTEGRATION-ONLY, security/PHI-sensitive — no unit-level RBAC/Zod matrix:**

AI surface (12):

- `apps/api/src/routes/ai-scribe.ts` ⚠ uses fire-and-forget `safeAudit` per CLAUDE.md
- `apps/api/src/routes/agent-console.ts` ⚠ uses fire-and-forget `safeAudit`
- `apps/api/src/routes/ai-doc-qa.ts`
- `apps/api/src/routes/ai-fraud.ts`
- `apps/api/src/routes/ai-bill-explainer.ts`
- `apps/api/src/routes/ai-claims.ts`
- `apps/api/src/routes/ai-radiology.ts`
- `apps/api/src/routes/ai-symptom-diary.ts`
- `apps/api/src/routes/ai-sentiment.ts`
- `apps/api/src/routes/ai-coaching.ts`
- `apps/api/src/routes/ai-followup.ts`
- `apps/api/src/routes/ai-previsit.ts`

Non-AI security/PHI surface (12):

- `apps/api/src/routes/auth.ts`
- `apps/api/src/routes/tenants.ts`
- `apps/api/src/routes/uploads.ts`
- `apps/api/src/routes/controlled-substances.ts`
- `apps/api/src/routes/patients.ts`
- `apps/api/src/routes/patient-data-export.ts`
- `apps/api/src/routes/users.ts`
- `apps/api/src/routes/insurance-claims.ts`
- `apps/api/src/routes/prescriptions.ts`
- `apps/api/src/routes/pharmacy.ts`
- `apps/api/src/routes/preauth.ts`
- `apps/api/src/routes/chat.ts`

**Orphan unit tests** (verify mount-path still resolves; otherwise dead test):

- `apps/api/src/routes/budgets-kpi.test.ts` (no `budgets.ts` source)
- `apps/api/src/routes/complaints-stats.test.ts` (no `complaints.ts` source)
- `apps/api/src/routes/razorpay-webhook.test.ts` (no `razorpay.ts` source — webhook lives inside `billing.ts`?)

### 2.2 Middleware — `apps/api/src/middleware/`

**3 of 11 untested. ALL THREE are security-critical:**

| File | LOC | Why it matters |
|---|---|---|
| `apps/api/src/middleware/patient-self-only.ts` | 85 | This is `assertPatientOwnsResource` — the BOLA defense referenced 4× in CLAUDE.md gotchas (#12, #13, #14) and the entire `/medcore-bola-sweep` skill. **Highest priority gap in the whole repo.** |
| `apps/api/src/middleware/csrf.ts` | 84 | CSRF protection. |
| `apps/api/src/middleware/auth-cookies.ts` | 100 | Cookie-based session handling. |

### 2.3 Services — `apps/api/src/services/` (21 untested)

By file size and risk, ordered top-down:

| File | LOC | Risk |
|---|---|---|
| `apps/api/src/services/patient-data-export.ts` | 687 | **Largest untested file in the repo. PHI export logic.** |
| `apps/api/src/services/ai/staff-scheduler.ts` | 591 | Scheduling algorithm |
| `apps/api/src/services/ai/fraud-detection.ts` | 536 | Fraud-case ranking |
| `apps/api/src/services/ai/capacity-forecast.ts` | 484 | Forecasting math |
| `apps/api/src/services/ai/sentiment-ai.ts` | 339 | Sentiment scoring |
| `apps/api/src/services/ai/doc-qa.ts` | 296 | RAG-adjacent |
| `apps/api/src/services/insurance-claims/ai-coder.ts` | 287 | ICD/CPT autocoder |
| `apps/api/src/services/ai/ml/feature-extractor.ts` | 270 | Feeds the LR model that IS tested |
| `apps/api/src/services/ai/previsit.ts` | 267 | |
| `apps/api/src/services/fhir/validator.ts` | 247 | FHIR resource validator while rest of `fhir/` is tested |
| `apps/api/src/services/ai/follow-up.ts` | 246 | |
| `apps/api/src/services/abdm/consent.ts` | 205 | ABDM consent state machine while rest of `abdm/` is tested |
| `apps/api/src/services/ai/lab-intel.ts` | 185 | |
| `apps/api/src/services/insurance-claims/adapter.ts` | 171 | Base shape (per-adapter tests exist) |
| `apps/api/src/services/ai/bill-explainer.ts` | 162 | |
| `apps/api/src/services/ai/sarvam-logging.ts` | 128 | |
| `apps/api/src/services/medicines/manufacturers.ts` | 111 | |
| `apps/api/src/services/insurance-claims/registry.ts` | 55 | |
| `apps/api/src/services/metrics-counters.ts` | 50 | |
| `apps/api/src/services/medicines/serialize.ts` | 43 | |
| `apps/api/src/services/pii-redact.ts` | 38 | Security-relevant redaction |
| `apps/api/src/services/retention-scheduler.ts` | 20 | |
| `apps/api/src/services/tenant-prisma.ts` | 21 | Likely shim (canonical lives in `@medcore/db`) |

### 2.4 Shared validators — `packages/shared/src/validation/`

Validators with no covering test under any naming:

- `packages/shared/src/validation/phase4-engagement.ts` (219 LOC)
- `packages/shared/src/validation/phase4-specialty.ts` (309 LOC)
- `packages/shared/src/validation/ehr.ts` (171 LOC)
- `packages/shared/src/validation/ancillary-enhancements.ts` (208 LOC)
- `packages/shared/src/validation/ai.ts` (76 LOC)
- `packages/shared/src/validation/reports.ts` (33 LOC)

### 2.5 Web app — `apps/web/`

**1 page truly uncovered (copy-paste bug):**

- `apps/web/src/app/dashboard/medication/page.tsx` is uncovered because
  `apps/web/src/app/dashboard/__tests__/medication.page.test.tsx:29`
  imports `../medication-dashboard/page` instead of `../medication/page`.
  Net: `/dashboard/medication-dashboard` is double-tested,
  `/dashboard/medication` is zero-tested. **5-minute fix.**

**4 components/lib helpers untested:**

- `apps/web/src/components/ErrorBoundary.tsx`
- `apps/web/src/components/HelpPanel.tsx`
- `apps/web/src/lib/appointments.ts`
- `apps/web/src/lib/socket.ts`

**Naming-convention drift to clean up later** (3 styles co-exist):

- `<group>/__tests__/<dotted-slug>.page.test.tsx` (most common)
- Co-located `page.test.tsx` (~14 routes)
- Hyphenated-flatten — `dashboard/__tests__/lab-qc.page.test.tsx` covers `dashboard/lab/qc/page.tsx` (one-off)

`/medcore-route-test` currently scaffolds style #1.

### 2.6 Mobile — `apps/mobile/`

- 16 render/smoke tests, **no flow tests**.
- Maestro YAML scaffolds exist under `apps/mobile/e2e/` but are NOT
  wired to CI.
- iOS/Android divergence undetected.
- Navigation stack untested.
- Offline-sync logic unverified.
- Gesture interactions untested.

---

## 3. Test categories ABSENT or under-built

| # | Category | Status | Why it matters here |
|---|---|---|---|
| 1 | Mobile E2E (Detox/Maestro) | scaffolds exist, not in CI | Render tests miss navigation, gestures, offline sync, iOS/Android divergence |
| 2 | DB migration tests | absent | Prisma schema changes ship unverified — RLS, unique constraints, defaults; rollback paths untested. TODO.md tracks porting `migration-check.yml` from globussoft-crm |
| 3 | PostgreSQL RLS policy tests | partial (`rls.test.ts` exists) | Tenant isolation enforced at app layer; verify scope of existing test |
| 4 | Property-based testing (`fast-check`) | absent | Validators, ABO compatibility, scheduler date math, ICD coder are textbook fits |
| 5 | Mutation testing (Stryker) | absent | API line coverage at 24%; mutation would surface assertion-of-existence-only tests (CLAUDE.md gotcha #3) |
| 6 | Performance benchmarks (`vitest bench`/`tinybench`) | absent | No regression alarm on AI hot paths |
| 7 | Load test SLA gate | runs nightly, no enforcement | Latency/error-rate regressions ship silently |
| 8 | OpenAPI / Pact contract tests | absent | Mobile, web, ABDM, insurance gateways consume API; schema drift undetected |
| 9 | Snapshot regression for PDFs | partial — `pdf-snapshot.test.ts` exists | Format drift in Rx, discharge, invoice, AI letters silent today |
| 10 | `jest-axe` / `vitest-axe` in unit suite | absent (only Playwright) | A11y feedback only at e2e — slow loop |
| 11 | Visual regression at component level (Storybook/Chromatic/Loki) | absent | Component-level visual drift only caught via 4 Playwright screenshots |
| 12 | i18n string completeness | absent | No missing-key detection; Hindi/Marathi i18n in scope |
| 13 | FHIR Bundle / search-parameter conformance | resource-level only | Production FHIR consumers will fail on conformance edges |
| 14 | Worker / queue / cron integration tests | unit-mock only | Schedulers (`adherence`, `chronic-care`, `insurance-claims`, `audio-retention`) — no real-Postgres run |
| 15 | Concurrent multi-user stress | thin | Optimistic concurrency / race conditions on appointments, MAR, dispense |
| 16 | Circuit breaker / retry / fallback | thin | External provider failure modes (Sarvam, Razorpay, ABDM, Jitsi) |
| 17 | Secret scanning in CI | absent | TODO.md tracks porting `secret-scan.yml` from globussoft-crm |
| 18 | Migration safety check in CI | absent | TODO.md tracks porting `migration-check.yml` from globussoft-crm |
| 19 | Demo monitor (synthetic prod check) | absent | TODO.md tracks porting `demo-monitor.yml` |
| 20 | Coverage gate at 80% | locked at API 24% / web 51% lines | Far below `~/.claude/rules/common/testing.md` 80% target — needs a staircase plan |

---

## 4. Recommended ordering

### Tier 1 — security/PHI critical, fast wins

1. **Unit-test `apps/api/src/middleware/patient-self-only.ts`** —
   the BOLA defense; CLAUDE.md gotchas #12–#14 are entirely about
   misuse of this helper. (~1 hr)
2. **Fix `apps/web/src/app/dashboard/__tests__/medication.page.test.tsx:29`**
   import — closes the only truly-uncovered web page. (~5 min)
3. **Unit-test `apps/api/src/middleware/csrf.ts` and
   `apps/api/src/middleware/auth-cookies.ts`** — security-critical. (~2 hr)
4. **Service tests for the 6 highest-risk untested services** via
   `/medcore-fanout`:
   - `apps/api/src/services/patient-data-export.ts`
   - `apps/api/src/services/insurance-claims/ai-coder.ts`
   - `apps/api/src/services/ai/fraud-detection.ts`
   - `apps/api/src/services/ai/ml/feature-extractor.ts`
   - `apps/api/src/services/abdm/consent.ts`
   - `apps/api/src/services/fhir/validator.ts`

### Tier 2 — coverage breadth

5. **Unit tests for the 12 PHI-sensitive INTEGRATION-ONLY routes** in
   §2.1 via `/medcore-route-test` — pairs with `/medcore-fanout` for
   parallel dispatch. Prioritise the 2 with `safeAudit` fire-and-forget
   first (`ai-scribe.ts`, `agent-console.ts`).
6. **Fill PARTIAL routes** in §2.1 (admissions, analytics, appointments,
   bloodbank, expenses, leaves, medication) with full handler matrices.
7. **Service tests for the remaining 15 untested services** in §2.3.

### Tier 3 — CI/infra parity

8. **Port `secret-scan.yml`** from globussoft-crm (~30 min, gitleaks
   Docker action + medcore-tuned `.gitleaks.toml`).
9. **Port `migration-check.yml`** from globussoft-crm (~2-3 hr,
   high-value safety gate).
10. **Wire `vitest-axe`** into `apps/web/vitest.config.ts`
    (TEST_COVERAGE_AUDIT P3).

### Tier 4 — quality bars

11. **Coverage staircase** — bump API thresholds 24% → 30% → 40% over
    next 3 sprints toward 80% target.
12. **Load-test SLA gate** in `test.yml` — parse JSON, fail on p95 /
    error-rate breach.
13. **PDF snapshot tests** for Rx, discharge, invoice, AI letters
    (extend existing `pdf-snapshot.test.ts`).
14. **`fast-check` property tests** for ABO compatibility, scheduler
    date math, ICD coder, validators.

### Tier 5 — strategic / longer horizon

15. **Mobile E2E** via Maestro (scaffolds exist).
16. **OpenAPI conformance** generated from existing spec (preferred
    over Pact).
17. **Vitest bench** for AI hot paths (triage, scribe, chart-search).
18. **Storybook + Loki/Chromatic** for component-level visual regression.

---

## 5. Cross-references

- E2E gaps (separate doc): `docs/E2E_COVERAGE_BACKLOG.md`
- Prior non-e2e baseline: `docs/TEST_COVERAGE_AUDIT.md` (2026-05-02)
- Test plan: `docs/TEST_PLAN.md`
- AI eval design: `docs/AI_EVAL.md`
- CI workflow parity tracking: `TODO.md` (workflow port checklist)
- Recurring patterns + gotchas: `CLAUDE.md` (esp. test infra §1-4 and
  BOLA gotchas #12-14)
