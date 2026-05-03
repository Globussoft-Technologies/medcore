// Session snapshot — 2026-05-04 (home pickup → office handoff)
//
// End-of-session handoff. Read this first, then [/TODO.md](../../TODO.md),
// then go. Replaces SESSION_SNAPSHOT_2026-05-03-late-night.md as the most
// recent handoff. The previous handoff's "critical follow-ups" are now
// resolved (see "Critical follow-ups status" below).

# Session snapshot — 2026-05-04

## State at session end

- **HEAD on `main`** = `4f9b4d3` (`docs: refresh TODO + CHANGELOG for 6-agent evening batch`).
- **Working tree:** clean.
- **Open GitHub issues: 0. Open PRs: 0.**
- **Per-push CI:** running on `4f9b4d3` at session end — last successful auto-deploy was through `9fd1360` earlier today; subsequent pushes triggering fresh runs.
- **release.yml:** previous run `25284590768` on `ee5f253` finished with 1 fail (audit-phi flake) + new WebKit regression. Audit-phi flake CONFIRMED on the rerun. WebKit regression diagnosed and fixed in `eb40604` (see Critical follow-ups below).

## What this session shipped

**14 commits beyond `794397f`** across two parallel-agent batches plus the morning's solo work. Roughly **~6,500 lines of test/fix code**.

### Morning wave — solo + 4-agent batch

| Commit | Title | Notes |
|---|---|---|
| `ca76961` | feat(billing): cumulative refund fraud guard via Payment.parentPaymentId | Closes late-night critical follow-up #2. Schema migration `20260504000001_payment_parent_for_refunds` (additive self-FK), 3rd fraud guard sums prior refunds + incoming, refund creates now stamp parentPaymentId. 3 new webhook tests. |
| `d1cac91` | test(web): vitest-axe component a11y regression suite (P3) | Closes TEST_COVERAGE_AUDIT §5 P3. New helper + 6 seed tests across DataTable/EmptyState/ConfirmDialog/EntityPicker. devDeps: vitest-axe ^0.1.0 + axe-core ^4.11.4. |
| `9fd1360` | docs(todo): release.yml 25284590768 outcome | audit-phi flake confirmed; WebKit regression flagged. |
| `e33ceea` | test(e2e): /dashboard/controlled-substances — Schedule-H register flow + RBAC | 10 cases × 6 roles. Read-only audit register (no add-entry form on this surface). |
| `eb40604` | fix(e2e): WebKit auth-race v4 — gotoAuthed helper + fixture settle guard | **Closes late-night critical follow-up #1.** v3 protected fixture-first goto only; v4 covers in-test page.goto via `gotoAuthed` + fixture settle retry. Applied surgically to admin-ops:144 / pharmacy-forecast:8 / predictions:128 / visual:65. |
| `86766bf` | test(api): snapshot regression for PDF / letter / invoice generators (P9) | Closes §5 P9. 8 file-based snapshots × 4 generators. Locale-dates pinned to null, QR PNG mocked to STUB_QR. |
| `6832a6f` | perf(api): vitest benchmarks for AI hot paths (P10) | Closes §5 P10. 13 bench tasks × 3 files (prompt-safety / er-triage MEWS / chart-search synthesizeAnswer). New `npm run bench`. |
| `ed6c2ad` | docs: refresh TODO + CHANGELOG for 4-agent parallel batch | Doc rollup. |

### Evening wave — 6-agent batch

| Commit | Title | Notes |
|---|---|---|
| `be36db6` | test(e2e): /dashboard/purchase-orders — PO lifecycle + approval + RBAC | 18 tests, 7 roles. Concurrent-stage race accidentally bundled `e2e/payment-plans.spec.ts` (also 18 tests) into this commit — content correct, just bundled. |
| `65b5e0a` | test(e2e): /dashboard/admissions — admit → MAR → discharge + RBAC | 11 tests × 5 roles. **Important route-shape correction**: page is fully accessible to all authenticated users; only "Admit Patient" CTA is role-gated. Discharge is a two-modal sequence. |
| `417066a` | ci(load-test): SLA gate fails PR on p95 / error-rate breach (P6) | Closes §5 P6. 167-line gate script + thresholds JSON + `--json-out=` flag on runner + nightly-and-PR triggers. Real e2e validation done locally with pass + breach fixtures. |
| `592a641` | test(e2e): /register + /forgot-password — public auth flows + anti-enumeration pin | 17 tests. **Anti-enumeration HOLDS** — unknown email returns identical 200 + same UI as known. Issue #15 rate-limit + Issue #167 age=0 covered. |
| `8d0765a` | test(db): tenant-scoping isolation regression suite (P4) | Closes §5 P4. 686 lines, 10 it / 29 expects × 7 tenant-scoped models. Self-skips without `DATABASE_URL_TEST`. **Surfaced 4 architectural findings — see below.** |
| `4f9b4d3` | docs: refresh TODO + CHANGELOG for 6-agent evening batch | Doc rollup + architectural-findings log. |

### Critical follow-ups status (from previous handoff)

- **#1 Audit-phi flake on release.yml `25279367548`** — CONFIRMED FLAKE on rerun `25284590768`. Audit-phi test passed clean. No further action needed.
- **#2 Cumulative-refund detection gap** — CLOSED in `ca76961`. Schema migration + handler + tests all in.
- **#3 WebKit regression surfaced on rerun** — DIAGNOSED + FIXED in `eb40604`. v4 guard via `gotoAuthed` helper + fixture settle. Live verification still CI-only (WebKit binary not on dev host); next release.yml run on `4f9b4d3` is the verdict.

### Today's TEST_COVERAGE_AUDIT P-list closures

P3 ✅ + P6 ✅ + P9 ✅ + P10 ✅ + P4 ✅ — five P-items closed in one day.

### Today's E2E_COVERAGE_BACKLOG closures

`/dashboard/controlled-substances` ✅ + `/dashboard/admissions` ✅ + `/dashboard/purchase-orders` ✅ + `/dashboard/payment-plans` ✅ + `/register` ✅ + `/forgot-password` ✅.

## Architectural findings — UNFIXED, logged for future PR

P4's RLS suite surfaced 4 real codebase issues. All written up in `TODO.md` and in auto-memory at `~/.claude/projects/c--Users-Admin-gbs-projects-medcore/memory/project_architectural_findings_2026-05-04.md`.

1. **Tenant-scoping wrapper lives in `apps/api/src/services/tenant-prisma.ts`** — should be in `packages/db` so workers/cron/secondary services can consume it without crossing the `apps → packages` arrow. Test file currently uses runtime `import()` to work around this.
2. **`AuditLog` has NO `tenantId`** — `packages/db/prisma/schema.prisma` ~1299-1313. Operational consequence: T1 admin with raw DB access can read T2's audit log.
3. **Tenant FK is `onDelete: SetNull`** — orphaned-PHI rows survive Tenant deletion but become invisible to scoped clients. Consider `Cascade` or a "no orphans" invariant.
4. **`runWithTenant` does NOT validate tenantId** — just stuffs the string into AsyncLocalStorage. Single upstream middleware bypass exposes.

These are next-session pickup items, not regressions in today's work.

## CI / deploy state

- Per-push CI was green through `9fd1360`; auto-deploy operating; `medcore.globusdemos.com` updated continuously through that commit.
- The push of `ed6c2ad` triggered a new run; subsequent pushes (`be36db6` → `4f9b4d3`) will queue further runs.
- **release.yml:** run `25284590768` (most recent at session start) finished with a hard fail. The next release.yml on `4f9b4d3` (or whatever the latest push triggers) is the verification for the WebKit v4 fix and the new E2E specs. Expect:
  - WebKit hard fails on admin-ops:144 / pharmacy-forecast:8 / predictions:128 / visual:65 → should now be GREEN.
  - 4 new E2E specs (controlled-substances, admissions, purchase-orders, payment-plans, public-auth) running for the first time on CI's Linux env. Watch for unrelated env issues.
  - P4 RLS suite running for the first time — needs `DATABASE_URL_TEST` configured in CI; self-skips gracefully if absent.
  - P10 AI bench files NOT auto-run by `npm test` (they're under `*.bench.ts` not `*.test.ts`); only run via `npm run bench`.
  - P6 load-test SLA gate runs nightly + on-PR-touching-routes; not on every push.

## Next-session pickup queue

1. **Verify WebKit v4 holds** — check release.yml run on `4f9b4d3` (or later). 5-min task.
2. **P4 architectural follow-ups** — see "Architectural findings" above. Highest-leverage: adding `tenantId` to `AuditLog` (compliance-relevant) and switching tenant FK to `Cascade` (or enforcing no-orphan invariant).
3. **TEST_COVERAGE_AUDIT P-list residuals**:
   - **P2** — DB migration + seed verification (Testcontainers Postgres, walk forward / back) — ~3-4h
   - **P7** — AI eval dataset 3→50+ + Sarvam vs OpenAI compare harness — ~4h
   - **P8** — Consumer-driven contract tests (OpenAPI generated, or Pact for mobile↔API) — ~3-4h
   - **P5** — Mobile E2E (Detox/Maestro) — multi-day, needs mobile build env
4. **More zero-coverage E2E routes** (per `docs/E2E_COVERAGE_BACKLOG.md` §2):
   - HR/Payroll cluster: `/payroll`, `/users` edit/deactivate, `/leave-calendar`, `/schedule`, `/doctors/[id]`
   - Communications cluster: `/notifications` inbox, `/broadcasts`, `/chat`, `/complaints`
   - Analytics cluster: `/reports` custom-report creation, `/census`, `/queue`
   - Multi-tenant: `/tenants/[id]/onboarding` (no isolation verification today)
   - Patient/Clinical: `/patients` list, `/patients/[id]` full chart, `/prescriptions/new`
5. **`SYSTEM_TEST_PLAN.md` orthogonal residuals** — N (UI concurrency), O (audit-trail completeness), S (file uploads), U (security E2E).

## Suggested first move next session

Spin a 4-agent parallel batch (the user has explicitly endorsed this pattern twice now):

- Agent 1: P2 DB migration verification (Testcontainers Postgres walk forward/back).
- Agent 2: AuditLog tenantId migration + handler updates + tests (P4 architectural finding #2).
- Agent 3: HR/Payroll E2E cluster (1-2 specs).
- Agent 4: Communications E2E cluster (1-2 specs).

Or, if the WebKit v4 fix didn't hold, drop everything and chase that down first.
