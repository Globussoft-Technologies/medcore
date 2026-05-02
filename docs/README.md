# MedCore Documentation

Canonical reference docs for the MedCore monorepo. Dated handoff
snapshots and one-off audits are archived under [`archive/`](archive/)
to keep this index focused on living references.

## Start here

- [`ONBOARDING.md`](ONBOARDING.md) — 10-minute "get productive" guide for
  new contributors. Reads first.
- [`ARCHITECTURE.md`](ARCHITECTURE.md) — runtime shape of the monorepo
  (apps/api, apps/web, apps/mobile, packages/db, packages/shared) and
  how requests flow.
- [Repo root `README.md`](../README.md) — feature surface and product
  overview. The pitch.

## Operations

- [`DEPLOY.md`](DEPLOY.md) — auto-deploy via GitHub Actions is the
  default; manual fallback runbook is in here too. **Required reading
  before touching anything in `scripts/deploy.sh`.**
- [`DEPLOY_DATA_SCRIPTS.md`](DEPLOY_DATA_SCRIPTS.md) — appendix to
  `DEPLOY.md`. Catalogue of post-deploy fix / dedup / backfill scripts.
- [`DEPLOY_ENV_VARS.md`](DEPLOY_ENV_VARS.md) — appendix to `DEPLOY.md`.
  Every env var the runtime reads, with default and override semantics.
- [`OPERATIONS_FAQ.md`](OPERATIONS_FAQ.md) — short, opinionated answers
  for ops-style questions ("how do I roll a single user back to v1.2?").
- [`OBSERVABILITY.md`](OBSERVABILITY.md) — health endpoints, structured
  log schema, Sentry release tagging, OpenTelemetry, Langfuse.
- [`MIGRATIONS.md`](MIGRATIONS.md) — Prisma schema migration policy.
  Hand-craft only; don't `prisma migrate dev`.

## Testing & CI

- [`TEST_PLAN.md`](TEST_PLAN.md) — overall test strategy. Tier shape:
  unit (vitest) → integration (vitest + real Postgres) → component
  (vitest + jsdom + mocked fetch) → e2e (Playwright + real stack).
  Codifies the **e2e-explicit-invocation-only** policy (§3 Layer 5).
- [`LOCAL_TESTING.md`](LOCAL_TESTING.md) — `scripts/run-tests-locally.sh`,
  the unified runner that mirrors every per-push CI gate from `test.yml`
  in ~5-7 min instead of 25 via Actions. Default tier excludes
  integration; `--with-integration` opts in.
- [`LOCAL_E2E.md`](LOCAL_E2E.md) — `scripts/run-e2e-locally.sh`, the
  local Playwright runner that mirrors `release.yml`'s e2e jobs in
  ~5-10 min. Use this **before** invoking release.yml — Playwright is
  explicit-invocation only and never auto-runs.
- [`CI_HARDENING_PLAN.md`](CI_HARDENING_PLAN.md) — the 4-phase plan
  that hardened CI in 2026-05-01 → 2026-05-02. Records why each gate
  exists and the per-phase shipped status.
- [`TESTER_PROMPT.md`](TESTER_PROMPT.md) — paste-ready prompt for the
  autonomous QA agent that exercises every module by playing each role.
  Lists the 7 demo accounts with credentials.

### Status checks

`claude.bat` (Windows) / `claude.sh` (POSIX) / `claude.ps1` (PowerShell)
at the repo root print a one-screen "what's the deploy + CI doing right
now" summary — recent `git log`, latest `test.yml` and `release.yml`
runs, current branch state. Useful for picking up from a hand-off mid
session without re-deriving context manually. Sourced by the autonomous
QA agent and humans alike.

## AI substrate

- [`AI_ARCHITECTURE.md`](AI_ARCHITECTURE.md) — one-page reference for
  the AI substrate: providers (Sarvam primary, OpenAI fallback),
  prompt registry, retry semantics, HITL surfaces, cost guardrails.
- [`AI_EVAL.md`](AI_EVAL.md) — held-out clinical evaluation corpus +
  the `npm run test:ai-eval` runner. PRD §3.9 thresholds documented.
- [`PROMPT_ROLLOUT.md`](PROMPT_ROLLOUT.md) — authoring, versioning,
  rolling out, and rolling back LLM system prompts.

## Archive

[`archive/`](archive/) holds dated handoff snapshots and point-in-time
audits that no longer reflect the current repo. Kept for historical
context only — don't treat anything in `archive/` as canonical.

Currently archived:
- 8 `SESSION_SNAPSHOT_*` files (2026-04-27 through 2026-05-02 late-evening)
- `TODO_2026-04-29.md` (superseded by [`/TODO.md`](../TODO.md) at repo root)
- `RBAC_AUDIT_2026-04-30.md` (point-in-time RBAC audit; the e2e
  `rbac-matrix.spec.ts` now serves as the live source of truth)

## Top-level conventions

- Anything date-stamped (e.g. `*_2026-MM-DD.md`) belongs under
  `archive/` once the work it describes has shipped.
- Living references are name-only (no date in the filename) and are
  updated in place when the underlying behavior changes.
- Per-feature docs live next to the feature code, not here. This
  directory is for cross-cutting / operational references.
