# Session snapshot — 2026-05-03 late-night

End-of-session handoff for office pickup. Read this first, then
[`/TODO.md`](../../TODO.md), then go. Replaces `SESSION_SNAPSHOT_2026-05-03-night.md`
as the most recent handoff.

## State at session end

- **HEAD on `main`** = `ee5f253` (`test(e2e): /dashboard/symptom-diary —
  PATIENT capture flow + staff RBAC redirects`).
- **Working tree:** clean. `.claude/settings.local.json` was edited
  during the agent-stall debug pass (broader allowlist) but it's
  gitignored.
- **Open GitHub issues: 0. Open PRs: 0.**
- **Per-push CI**: green on every push through `ee5f253`. Auto-deploy
  is operating; `medcore.globusdemos.com` is on `ee5f253`.
- **release.yml**: ⚠️ run `25279367548` on `a8ab069` finished with **1
  integration test failure** — see "Critical follow-up #1" below.

## What this session shipped (post `b36a309`)

Six commits beyond the 2026-05-03 night snapshot:

| Commit | Title | New tests |
|---|---|---|
| `c127e6f` | fix(api/ambulance): state-machine guard + fuel-log timestamp validation | 3 (flipped TODOs) |
| `9486409` | fix(api/billing): Razorpay capture-side fraud guard | 4 |
| `eb85749` | test(e2e): un-skip 7 WebKit-conditional cases — auth-race v3 validated stable | 0 (un-skip) |
| `8888541` | docs: codify descriptive-headers convention for tests + feature entrypoints | 0 |
| `a8ab069` | fix(api/billing): Razorpay refund webhook fraud guards (analogous to capture-side) | 5 |
| `ee5f253` | test(e2e): /dashboard/symptom-diary — PATIENT capture flow + staff RBAC redirects | 7 |

**Subtotal: ~19 new test cases + 6 source surfaces hardened + 1 E2E
backlog item closed + 1 repo-wide convention codified.**

### Source fixes shipped

- `apps/api/src/routes/ambulance.ts` (`c127e6f`) — `ALLOWED_TRIP_TRANSITIONS`
  table + `assertValidTripTransition` helper; same-state writes are
  idempotent no-ops; illegal transitions return 409.
- `packages/shared/src/validation/ancillary-enhancements.ts` (`c127e6f`) —
  `fuelLogSchema.filledAt` `.refine()` rejects timestamps >60s in the future.
- `apps/web/src/app/dashboard/ambulance/page.tsx` (`c127e6f`) — Complete
  button gates on `EN_ROUTE_HOSPITAL` only.
- `apps/api/src/routes/billing.ts` (`9486409`) — `handlePaymentCaptured`
  fraud guard: "fresh transactionId on already-PAID invoice" → 409 +
  `INVOICE_ALREADY_PAID_DIFFERENT_TXN` + audit row.
- `apps/api/src/routes/billing.ts` (`a8ab069`) — `handleRefundProcessed`
  twin guards: `REFUND_AGAINST_NON_CAPTURED_PAYMENT` (original must be
  CAPTURED) and `REFUND_EXCEEDS_PAYMENT` (single refund ≤ original).

### Convention codified

`docs/README.md` gained a **"Tests & feature code — describe what you
wrote"** section. Tests + new entry-point files (route handler, service
module, top-level component) get a short header explaining what / which
modules / why. The one override to the global "default to no comments"
rule. The `/dashboard/symptom-diary` spec (`ee5f253`) is the first file
shipped under this convention — use it as the reference. Saved to memory
as `feedback_descriptive_tests_and_code` so future sessions apply it
automatically.

## Critical follow-ups for next session

### 🔴 #1 — release.yml `25279367548` integration test failure

**Run:** https://github.com/Globussoft-Technologies/medcore/actions/runs/25279367548

**Failure:** `apps/api/src/test/integration/audit-phi.test.ts > PHI read
audit logging (integration) > writes AI_SCRIBE_READ audit on GET
/ai/scribe/:sessionId/soap` — `AssertionError: expected +0 to be 1` (i.e.,
the test expected 1 audit row to exist, got 0).

**5/6 jobs green** including:
- E2E (full Playwright suite)
- E2E (full Playwright suite, WebKit) ← this is the headline
- Type check (api + web)
- Web component tests

**Per-push CI on the same SHA (`a8ab069`) was green** — otherwise
auto-deploy wouldn't have run. So this is either a flake or a release.yml-
specific environment timing issue (concurrent test isolation, slower DB,
different ordering, etc.).

**Investigation order:**

1. **Re-run release.yml on the same SHA** to test for flake:
   ```bash
   gh workflow run "Release validation" --repo Globussoft-Technologies/medcore --ref main
   # then watch run-id; compare conclusion
   ```
   If green on re-run, mark as flake and move on.
2. **If reproducible**, the suspects are:
   - Concurrent test isolation: another integration test running in the
     same vitest pool consuming the audit row first, or polluting state.
     Check whether `audit-phi.test.ts` uses `singleFork: true` and a
     fresh tenant scaffold.
   - Recent scribe-route logging change. Run
     `git log --oneline -10 apps/api/src/routes/ai-scribe.ts` and
     `git log --oneline -10 apps/api/src/middleware/audit.ts` for
     recent diffs since `b36a309`.
   - `e6c68e1` / `fd3bea6` (this session's pharmacy + controlled-
     substances changes) didn't touch ai-scribe but DID touch audit
     plumbing — worth ruling out.
3. **Local repro:**
   ```bash
   cd apps/api && npx vitest run src/test/integration/audit-phi.test.ts
   ```
   Requires `scripts/run-tests-locally.sh --with-integration` setup
   (one-shot Postgres on `:54322`).

### 🟡 #2 — Cumulative refund over-refund detection

`a8ab069`'s `REFUND_EXCEEDS_PAYMENT` only catches per-event over-refund.
Five sequential partial refunds totalling > the original payment still
slip through because refunds aren't FK-linked back to a specific original
payment. Needs a schema migration (e.g. `Payment.parentPaymentId` nullable
FK, or a separate `Refund` table). Low urgency — Razorpay itself prevents
this on their side; this is defence-in-depth.

### 🟡 #3 — Background sub-agents are broken on this VSCode harness

Memory: `~/.claude/projects/c--Users-Admin-gbs-projects-medcore/memory/reference_worktree_bg_agent_perms.md`.

VSCode Claude Code v2.1.126 silently doesn't honor `Read` / `Edit` /
`Write` / `Glob` / `Grep` allowlist entries for background agents. Every
Read fires an interactive permission popup the user must click; the 600s
watchdog kills the agent if no click. Diagnosed conclusively from agent
JSONL transcripts (see [`reference_worktree_bg_agent_perms.md`](../../../.claude/projects/c--Users-Admin-gbs-projects-medcore/memory/reference_worktree_bg_agent_perms.md)).

**Practical impact:** the parallel-agent pattern that worked yesterday
(spinning 4 worktree+bg agents to close test gaps simultaneously) is
not reliable on this build. Three approaches forward, in preference order:

1. **DIY in main session** — most reliable, no popups for the parent.
2. **Foreground Agent calls** (no `run_in_background`) — multiple Agent
   calls in a single message run concurrently; popups surface inline so
   they can be clicked in real time. Block until join. Best parallelism
   when a human is at the keyboard.
3. **Bash-only background agents** — Bash IS allowlisted and works in bg.
   Useful for "run test suite, report exit code" or fetch tasks.

Re-test bg+Read on next harness upgrade with a tiny verification agent
before relying on it.

### 🟢 #4 — TEST_COVERAGE_AUDIT.md P2-P10 still open

P1, P11, P12 closed earlier. P2 (DB migration forward/backward), P3
(vitest-axe a11y), P4 (RLS — likely a no-op for current arch), P5 (mobile
Detox/Maestro), P6 (load-test SLA gate), P7 (AI eval expansion), P8 (Pact
contracts), P9 (PDF/letter snapshots), P10 (AI perf benchmarks).

**P9 / P3 / P10 were attempted via parallel bg agents this session and
were blocked by the harness issue above.** When agents are reliable
again, dispatch them as 4 parallel agents in 4 isolated worktrees.
Until then, pick one and ship it foreground or DIY.

### 🟢 #5 — E2E coverage backlog (92 routes uncovered)

Symptom-diary closed today (`ee5f253`). 92 routes remain in
[`docs/E2E_COVERAGE_BACKLOG.md`](../E2E_COVERAGE_BACKLOG.md). High-value
next picks per §2:

- `/dashboard/medicines` — medicine catalog
- `/dashboard/purchase-orders` + `/dashboard/purchase-orders/[id]` — PO list + detail
- `/dashboard/suppliers` — supplier directory
- `/dashboard/controlled-substances` — only page-load tested today; needs full create-entry + register flow
- `/dashboard/telemedicine/waiting-room` — only mocked join tested
- `/dashboard/patients/[id]/problem-list` — add/edit/delete

The descriptive-headers convention is now mandatory for any new spec —
use `e2e/symptom-diary.spec.ts` as the reference template.

## Pickup commands (office)

```bash
cd "<medcore checkout>"
git pull origin main   # should fast-forward to ee5f253 or beyond

# 1) Re-run release.yml to test the audit-phi flake (most important first move)
gh workflow run "Release validation" --repo Globussoft-Technologies/medcore --ref main
# then watch:
gh run list --repo Globussoft-Technologies/medcore --workflow="Release validation" --limit 1 \
  --json headSha,status,conclusion,databaseId

# 2) Live status while picking up
.\claude.bat        # PowerShell / cmd
bash claude.sh      # Git Bash
```

## Convention reminders (still load-bearing)

- **E2E (Playwright) is explicit-invocation only** — never auto-runs on
  push, deploy, or post-deploy. See `docs/TEST_PLAN.md` §3 Layer 5.
- **Local test runner** (`scripts/run-tests-locally.sh`) excludes
  integration by default — use `--with-integration` only when you need
  it locally (~28 min on Windows + Docker Desktop).
- **Hand-craft schema migrations**; don't `prisma migrate dev`.
- **All commits this session follow conventional-commit format with no
  Co-Authored-By trailer** (per global CLAUDE.md).
- **NEW: Descriptive headers on tests + feature entrypoints.** Codified
  in `docs/README.md`. Reference: `e2e/symptom-diary.spec.ts`.
- **NEW: Living references update in-place with closure annotations**;
  only date-stamped artefacts get archived. Codified in `docs/README.md`.
- **NEW: Background Agent calls are unreliable on v2.1.126** — use
  foreground or DIY for parallelism. See critical follow-up #3.

## Reference quick-links

- [`docs/TEST_GAPS_2026-05-03.md`](../../docs/archive/TEST_GAPS_2026-05-03.md) — closed audit (archived).
- [`docs/CHANGELOG.md`](../../CHANGELOG.md) — `[Unreleased]` window covers
  2026-04-30 → 2026-05-03 late-night.
- [`docs/TEST_COVERAGE_AUDIT.md`](../TEST_COVERAGE_AUDIT.md) — P-list.
- [`docs/E2E_COVERAGE_BACKLOG.md`](../E2E_COVERAGE_BACKLOG.md) — route gaps.
- [`docs/TEST_PLAN.md`](../TEST_PLAN.md) — test strategy + e2e policy.
- [`docs/MIGRATIONS.md`](../MIGRATIONS.md) — Prisma migration policy.
- [`docs/DEPLOY.md`](../DEPLOY.md) §2 — migration history (19 entries).
- `claude.{bat,sh,ps1}` — repo-root status check.
- Memory: `~/.claude/projects/c--Users-Admin-gbs-projects-medcore/memory/`
  — three new entries today (`feedback_descriptive_tests_and_code`,
  `feedback_doc_management_pattern`, `reference_worktree_bg_agent_perms`).
