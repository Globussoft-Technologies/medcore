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
- [`SYSTEM_TEST_PLAN.md`](SYSTEM_TEST_PLAN.md) — companion to TEST_PLAN.
  Aspect-oriented (auth / clinical-safety / money paths / RBAC / etc.)
  rather than route-oriented; pairs with `E2E_COVERAGE_BACKLOG.md` to
  answer "what assertions belong in this spec."
- [`E2E_COVERAGE_BACKLOG.md`](E2E_COVERAGE_BACKLOG.md) — route-by-route
  e2e gap list against `apps/web/src/app/**/page.tsx`. Numbers from
  2026-05-02 — re-verify before picking up an item; the §C work
  (bloodbank/ambulance/pediatric) plus today's gap-closer pass cleared
  several entries.
- [`TEST_COVERAGE_AUDIT.md`](TEST_COVERAGE_AUDIT.md) — non-e2e test
  inventory + the "test types ABSENT" backlog (Storybook, Pact,
  property-based, mutation testing, mobile E2E, etc.) for future
  direction. The Top-10 priority section was closed in the
  `TEST_GAPS_2026-05-03` pass and is now archived.
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

[`archive/gaps/`](archive/gaps/) is a dedicated subfolder for **fully
closed gap-tracking docs** — files whose entire backlog has been worked
through. A gap-tracking doc moves here ONLY when every item it lists
is closed; if even one item is still open, it stays in `docs/` (e.g.,
[`E2E_COVERAGE_BACKLOG.md`](E2E_COVERAGE_BACKLOG.md) and
[`TEST_COVERAGE_AUDIT.md`](TEST_COVERAGE_AUDIT.md) are NOT eligible
yet — they have open items). Reading order on session start: this
`README.md` → root [`TODO.md`](../TODO.md) → the latest
`SESSION_SNAPSHOT_*` in `archive/`. The `archive/gaps/` subfolder is
reference-only — no need to read its contents to pick up work.

Currently archived in `archive/`:
- 10 `SESSION_SNAPSHOT_*` files (2026-04-27 through 2026-05-03 late-night).
  The most recent — `SESSION_SNAPSHOT_2026-05-03-late-night.md` — is the
  current handoff: read it first on next pickup. It supersedes the
  earlier `2026-05-03-night.md` snapshot.
- `TODO_2026-04-29.md` (superseded by [`/TODO.md`](../TODO.md) at repo root)
- `RBAC_AUDIT_2026-04-30.md` (point-in-time RBAC audit; the e2e
  `rbac-matrix.spec.ts` now serves as the live source of truth)

Currently archived in `archive/gaps/`:
- `TEST_GAPS_2026-05-03.md` — all 10 priority items + 5 honorable
  mentions closed; 510+ new tests shipped on 2026-05-03. Closure log
  preserved.

## Top-level conventions

- Anything date-stamped (e.g. `*_2026-MM-DD.md`) belongs under
  `archive/` once the work it describes has shipped.
- Living references are name-only (no date in the filename) and are
  updated **in place** when the underlying behavior changes — including
  when their backlog items get closed. Add a closure-log banner /
  strikethrough; do **not** archive a living reference just because its
  open items have all shipped, or the record of progress disappears with
  it.
- Per-feature docs live next to the feature code, not here. This
  directory is for cross-cutting / operational references.

## Tests & feature code — describe what you wrote

When adding a test file or a new feature entry-point (route handler,
service module, top-level component), lead with a short header that
answers three questions:

1. **What** does it do / assert (the behaviour, not just the symbol name).
2. **Which modules / surfaces** it touches (route paths, service files,
   schema tables, RBAC roles).
3. **Why** — only if the *why* isn't obvious from the code: regulation
   reference (e.g. "Drugs and Cosmetics Rules 1945 §65"), prior incident,
   RBAC matrix entry, or a non-obvious invariant.

For Vitest / Playwright, that means the top-level `describe(...)` string
should read like

```ts
describe("Pharmacy Rx rejection — POST /pharmacy/prescriptions/:id/reject (PHARMACIST/ADMIN, state-machine guard PENDING-only)", ...)
```

not just `describe("reject", ...)`. Inner `it(...)` strings are
behaviour-specific assertions ("rejects with 409 when status is already
DISPENSED"), not function names.

For new files, a 2-4 line block comment at the top is enough. This is
the **one override** to the global "default to no comments" rule —
entry-points get a header so an auditor can skim the directory and tell
what each file owns. Internal helpers still don't need comments unless
the *why* is non-obvious.
