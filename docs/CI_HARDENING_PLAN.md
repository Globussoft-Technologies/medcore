# CI Hardening Plan

> Drafted 2026-05-01, executed 2026-05-01 → 2026-05-02. Phases 1, 2, 3,
> and 4.2 all shipped to `main`. Phase 4.1 + 4.3 are user-owned ops items
> tracked in [`/TODO.md`](../TODO.md). Owner: indianbill007. Companion
> to [`docs/DEPLOY.md`](DEPLOY.md) and [`docs/TEST_PLAN.md`](TEST_PLAN.md).

## Why

Current CI catches **type errors**, **unit / contract / integration tests**, and
**RBAC matrix** (release-only). Big classes of bugs slip through: lint
violations, untested code, dep CVEs, AI quality drift, performance
regressions, visual regressions, destructive migrations with no backup, and
bad deploys that stay live until a human notices.

This plan adds the missing nets in priority order. **All Phase 1 items are
purely additive** — they do not change runtime behavior, only gate it.

## Phase 1 — Quick wins (additive, low risk) — ✅ shipped

Goal: close the biggest unguarded surfaces.

| # | Item | Status | Commit / Notes |
|---|---|---|---|
| 1.1 | Add `lint` job | ✅ shipped (non-gating) | Job runs on every push but apps/web has no eslint installed yet — see TODO #4 |
| 1.2 | Coverage threshold | ✅ already in place | Locked from 2026-04-15 baseline; bump after release.yml lands clean (TODO #8) |
| 1.3 | `npm audit` job | ✅ shipped, in deploy gate | Scoped to apps/api + apps/web (excludes mobile expo CVEs) |
| 1.4 | Dependabot config | ✅ shipped | 14 PRs auto-opened on first run; 5 merged + 8 closed (deferred npm majors) + 1 open (#445) |
| 1.5 | CodeQL workflow | ✅ shipped | Runs on push + PR + weekly cron, security-extended ruleset |

## Phase 2 — Deploy resilience — ✅ shipped

| # | Item | Status |
|---|---|---|
| 2.1 | `pg_dump` before `prisma migrate deploy` | ✅ scripts/deploy.sh; bug fix in `49fcaa2` strips `?schema=public` from URL before passing to pg_dump |
| 2.2 | Auto-rollback on smoke-check failure | ✅ test.yml; deploy.sh `--rollback` flag added |
| 2.3 | Migration destructive-op gate | ✅ test.yml `migration-safety` job; in `deploy.needs:` |
| 2.4 | Bundle size budget | ✅ test.yml `web-bundle` job; tripwire at 25 MB, tighten after baseline (TODO #9) |

## Phase 3 — Scheduled quality coverage — ✅ shipped

| # | Item | Status |
|---|---|---|
| 3.1 | AI eval nightly | ✅ ai-eval-nightly.yml; needs `SARVAM_API_KEY` repo secret to actually run |
| 3.2 | Load test nightly | ✅ load-test-nightly.yml; runs against the existing mock-server.ts |
| 3.3 | Visual regression in release.yml | ✅ e2e/visual.spec.ts shipped; baselines pending — TODO #3 |
| 3.4 | Cross-browser (WebKit) | ✅ playwright.config.ts `full-webkit` project + release.yml `e2e-webkit` job; `addInitScript` fixture fix in `a8230d1` cut WebKit fail count from 121→55 |

## Phase 4 — Architecture / ops

| # | Item | Status |
|---|---|---|
| 4.1 | Staging environment | 🟡 user-owned (infra) |
| 4.2 | Sentry release tracking | ✅ shipped in `a07fef2` (deploy.sh exports `SENTRY_RELEASE` + `NEXT_PUBLIC_SENTRY_RELEASE`) |
| 4.3 | Branch protection on `main` | 🟡 user-owned (GitHub UI). CODEOWNERS file already in repo |

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

## Out of scope

- Mutation testing — low ROI for the noise it adds.
- Lighthouse CI — defer to Phase 3+ if perf becomes a complaint.
- Multi-region deploy — premature for a single-tenant dev demo.

## Sequencing

Phase 1 → Phase 2 → Phase 3, in order. Phase 4 items happen in parallel
ops work, not as part of this CI sweep. Each phase is its own commit
batch so a regression can be cleanly bisected.
