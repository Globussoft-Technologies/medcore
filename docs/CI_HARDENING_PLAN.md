# CI Hardening Plan

> Drafted 2026-05-01 to close the bug-catch gaps identified during a full CI
> audit. Owner: indianbill007. Companion to [`docs/DEPLOY.md`](DEPLOY.md) and
> [`docs/TEST_PLAN.md`](TEST_PLAN.md).

## Why

Current CI catches **type errors**, **unit / contract / integration tests**, and
**RBAC matrix** (release-only). Big classes of bugs slip through: lint
violations, untested code, dep CVEs, AI quality drift, performance
regressions, visual regressions, destructive migrations with no backup, and
bad deploys that stay live until a human notices.

This plan adds the missing nets in priority order. **All Phase 1 items are
purely additive** — they do not change runtime behavior, only gate it.

## Phase 1 — Quick wins (additive, low risk)

Goal: close the biggest unguarded surfaces. Ships in this session, one
commit per item so each is independently reverteable.

| # | Item | Where | Effort | Catches |
|---|---|---|---|---|
| 1.1 | Add `lint` job | `.github/workflows/test.yml` | 5 min | Unused vars, dead imports, anti-patterns |
| 1.2 | Coverage threshold | `apps/api/vitest.config.ts` + `apps/web/vitest.config.ts` | 15 min | Untested new code |
| 1.3 | `npm audit` job | `.github/workflows/test.yml` | 5 min | Known CVEs in deps |
| 1.4 | Dependabot config | `.github/dependabot.yml` | 5 min | Stale deps |
| 1.5 | CodeQL workflow | `.github/workflows/codeql.yml` | 10 min | SQL inject, XSS, regex DoS |

Acceptance: per-push CI on `main` lands green with all five new gates. No
existing test breaks. Lint-job is allowed to fail-soft on the first few
runs while we triage existing violations (set `continue-on-error: true`
initially, flip off after).

## Phase 2 — Deploy resilience (touches deploy path)

Goal: a bad deploy can't take prod down silently and a bad migration can't
delete data without recovery.

| # | Item | Where | Effort | Catches |
|---|---|---|---|---|
| 2.1 | DB backup before `prisma migrate deploy` | `scripts/deploy.sh` | 30 min | Data loss from bad migration |
| 2.2 | Auto-rollback on smoke-check failure | `.github/workflows/test.yml` (Smoke step) | 1 hr | Bad deploy stays live |
| 2.3 | Migration destructive-op lint (PR) | new GHA job | 1 hr | Schema regression slipping through review |
| 2.4 | Bundle size budget | `apps/web` build step | 30 min | JS bundle bloat |

Acceptance: a deliberately-broken deploy (e.g. set DB_URL wrong on a
branch, push) auto-rolls back to PREV_SHA and the smoke check still
reports the failure. A migration that drops a column is blocked on PR
unless explicitly labeled.

## Phase 3 — Scheduled quality coverage

Goal: regressions in AI quality, performance, and visual UX get caught
nightly so we know the next release-validation will be clean.

| # | Item | Where | Effort | Catches |
|---|---|---|---|---|
| 3.1 | AI eval nightly | new `.github/workflows/ai-eval.yml` | 1 hr | Sarvam model drift, prompt regression |
| 3.2 | Load test nightly | new `.github/workflows/load-test.yml` | 1 hr | API p95 regression |
| 3.3 | Visual regression | `release.yml` + Playwright `toHaveScreenshot()` | 2 hr | Silent UI breakage |
| 3.4 | Cross-browser (webkit) | `playwright.config.ts` | 30 min | Safari-specific bugs |

`test:ai-eval` and `test:load` scripts already exist in
[`package.json`](../package.json) — they're just never run.

## Phase 4 — Architecture (separate PRs / ops work)

Goal: real production parity + governance.

| # | Item | Type | Owner |
|---|---|---|---|
| 4.1 | Staging environment between dev and prod | Infra | indianbill007 |
| 4.2 | Sentry release tracking with deploy SHA | Code (small) | this plan |
| 4.3 | Branch protection on `main` (require PR + review + green checks) | GitHub UI | indianbill007 |

## Out of scope

- Mutation testing — low ROI for the noise it adds.
- Lighthouse CI — defer to Phase 3+ if perf becomes a complaint.
- Multi-region deploy — premature for a single-tenant dev demo.

## Sequencing

Phase 1 → Phase 2 → Phase 3, in order. Phase 4 items happen in parallel
ops work, not as part of this CI sweep. Each phase is its own commit
batch so a regression can be cleanly bisected.
