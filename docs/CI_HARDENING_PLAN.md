# CI Hardening Plan

> Drafted 2026-05-01, executed 2026-05-01 → 2026-05-02. **Status as of
> 2026-05-03: ALL GATING PHASES SHIPPED.** Phases 1, 2, 3, and 4.2 are
> live on `main`. Phase 4.1 + 4.3 are user-owned ops items tracked in
> [`/TODO.md`](../TODO.md). Owner: indianbill007. Companion to
> [`docs/DEPLOY.md`](DEPLOY.md) and [`docs/TEST_PLAN.md`](TEST_PLAN.md).

## Why

Pre-hardening CI caught **type errors**, **unit / contract / integration
tests**, and **RBAC matrix** (release-only). Big classes of bugs slipped
through: lint violations, untested code, dep CVEs, AI quality drift,
performance regressions, visual regressions, destructive migrations with
no backup, and bad deploys that stayed live until a human noticed.

This plan added the missing nets in priority order. **All Phase 1 items
are purely additive** — they do not change runtime behavior, only gate
it.

## Phase 1 — Quick wins (additive, low risk) — shipped

Goal: close the biggest unguarded surfaces.

| # | Item | Status | Commit / Notes |
|---|---|---|---|
| 1.1 | Add `lint` job | Shipped + gating | `5addd3c` bootstrapped apps/web ESLint (eslint v9 + eslint-config-next + FlatCompat) and added `lint` to `deploy.needs:`. |
| 1.2 | Coverage threshold | Shipped + bumped | Initial baseline 2026-04-15. Bumped 2026-05-02 (`cc01e36`) to `current_actual − 2pp`: api lines 24% / branches 68% / functions 68% / statements 24%; web lines 51% / branches 65% / functions 31% / statements 51%. |
| 1.3 | `npm audit` job | Shipped + in deploy gate | Scoped to apps/api + apps/web (excludes mobile expo CVEs). |
| 1.4 | Dependabot config | Shipped | First-run sweep on 2026-05-02: 5 PRs merged + 8 closed (deferred npm majors) + #445 (`actions/checkout` 4→6) merged in `bbdd6a7`. |
| 1.5 | CodeQL workflow | Shipped | Runs on push + PR + weekly cron, security-extended ruleset. |
| 1.6 | Codecov coverage uploads | Shipped 2026-05-02 (`b3b090b` + `350e74a`) | `codecov-action@v6` on api + web jobs in `test.yml`; `codecov.yml` config at repo root. Step is guarded by `if: hashFiles(...) != ''` so CI stays green pre-token. **User follow-up:** add `CODECOV_TOKEN` repo secret to enable PR coverage-delta comments. |

## Phase 2 — Deploy resilience — shipped

| # | Item | Status |
|---|---|---|
| 2.1 | `pg_dump` before `prisma migrate deploy` | Shipped in `scripts/deploy.sh`; bug fix in `49fcaa2` strips `?schema=public` from URL before passing to pg_dump. Recovery procedure: `docs/DEPLOY.md` "Recovery from a bad migration". |
| 2.2 | Auto-rollback on smoke-check failure | Shipped — `test.yml` post-deploy smoke + `deploy.sh --rollback` flag. |
| 2.3 | Migration destructive-op gate | Shipped — `test.yml` `migration-safety` job; in `deploy.needs:`. Override with `[allow-destructive-migration]` in commit message. |
| 2.4 | Bundle size budget | Shipped + tightened. Initial tripwire 25 MB; tightened to **7 MB** on 2026-05-02 (`1983f01`) based on avg 3.56 MB on last 8 green per-push runs + ~3 MB headroom. |

## Phase 3 — Scheduled quality coverage — shipped

| # | Item | Status |
|---|---|---|
| 3.1 | AI eval nightly | Shipped — `ai-eval-nightly.yml`; needs `SARVAM_API_KEY` repo secret to actually run. |
| 3.2 | Load test nightly | Shipped — `load-test-nightly.yml`; runs against the existing `mock-server.ts`. |
| 3.3 | Visual regression in release.yml | Shipped — `e2e/visual.spec.ts` + `update-visual-baselines.yml`; baselines committed in `d150ab2` (Chromium) + `fb55fe6` (WebKit). Future release runs exercise visual specs unconditionally. |
| 3.4 | Cross-browser (WebKit) | Shipped + stabilized. `playwright.config.ts` `full-webkit` project + `release.yml` `e2e-webkit` job. Initial `addInitScript` fixture fix (`a8230d1`) cut WebKit fail count 121→55. Three further auth-race waves on 2026-05-02 (`8d7fa94` v1 → `1d204d7` v2 → `febe0aa` v3) drove residual fails to **0**, validated fully green in release.yml run `25257762655`. |

## Phase 4 — Architecture / ops

| # | Item | Status |
|---|---|---|
| 4.1 | Staging environment | User-owned (infra). Open. |
| 4.2 | Sentry release tracking | Shipped in `a07fef2` (deploy.sh exports `SENTRY_RELEASE` + `NEXT_PUBLIC_SENTRY_RELEASE`). |
| 4.3 | Branch protection on `main` | User-owned (GitHub UI). CODEOWNERS file already in repo; rule activates as soon as the toggle is flipped. |

Audit hardening (post-Phase-1 sweep, also shipped in this session):

- Workflow `permissions: contents: read` at top level on every workflow
  (CodeQL escalates per-job to `security-events: write`)
- `timeout-minutes` on every job (5-60 min sized per workload)
- `webfactory/ssh-agent` pinned to commit SHA, not the v0.9.0 tag
- Workflow-level `concurrency:` with cancel-in-progress on PR runs
- `.nvmrc` (`20`) + 13 `node-version` references replaced with
  `node-version-file: ".nvmrc"` for single-source-of-truth Node version
- `.github/CODEOWNERS` mapping high-risk paths to indianbill007
- `.github/pull_request_template.md` with Summary / Test plan / Risk /
  Screenshots sections
- `packageManager` bumped from npm@10.5.0 to npm@10.9.0 to close the
  npm/cli#4828 lockfile-drift root cause

## E2E policy — explicit invocation only

Codified 2026-05-02 in commit `406023d` and reflected in
[`TEST_PLAN.md` §3 Layer 5](TEST_PLAN.md#layer-5--e2e-playwright--added-2026-04-30).

Playwright e2e is **explicit-invocation only**. It never auto-runs on
push, deploy, or post-deploy. It runs only when:

- a developer invokes `scripts/run-e2e-locally.sh` (or
  `npx playwright test ...`) locally, **or**
- release validation is triggered via `release.yml` `workflow_dispatch`.

Auto-deploy (`test.yml`'s `deploy` job) gates on the **non-e2e** gates:
`[test, web-tests, typecheck, lint, npm-audit, migration-safety,
web-bundle]`. `release.yml` is the e2e gate. Treat it as the
"ready to declare a release" check, not as part of every deploy.

This policy is load-bearing for two reasons:

1. **Speed.** Per-push CI completes in ~7 min without e2e; adding the
   full Chromium + WebKit suite would push every deploy past 25 min.
2. **Failure isolation.** Browser-level flakes (auth-race, RSC console
   warnings, visual diff drift) shouldn't gate deploys. They gate
   _releases_, which is when human attention is already in the loop.

## Out of scope

- Mutation testing — low ROI for the noise it adds.
- Lighthouse CI — defer to Phase 3+ if perf becomes a complaint.
- Multi-region deploy — premature for a single-tenant dev demo.

## Sequencing

Phase 1 → Phase 2 → Phase 3, in order. Phase 4 items happen in parallel
ops work, not as part of this CI sweep. Each phase is its own commit
batch so a regression can be cleanly bisected.
