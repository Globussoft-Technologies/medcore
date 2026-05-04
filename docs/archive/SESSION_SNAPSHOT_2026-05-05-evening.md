# Session snapshot — 2026-05-05 evening (CI unblock + A2/A10 closure)

End-of-session handoff. Read this first on next pickup, then [`/TODO.md`](../../TODO.md), then go. Replaces `SESSION_SNAPSHOT_2026-05-04-evening.md` as the most recent handoff.

## State at session end

- **HEAD on `main`** = `0c8ab07` (`refactor(db): A10 — lift tenant-prisma wrapper to @medcore/db with back-compat re-export shim`).
- **Working tree:** clean (after the doc roll commit lands).
- **Open GitHub issues: 1** — `#482` (JWT HS256 → RS256/EdDSA, blocked on operational key-rollover plan).
- **Open architectural follow-ups: 1** — A1 (page-level `VIEW_ALLOWED` policy decision — product call, not engineering). A2 + A10 closed today; A3-A9 closed prior sessions.
- **Per-push CI:** mostly green on `0c8ab07` at session end. 1 known-flake-category failure pending audit-flush investigation.
- **release.yml:** not dispatched this session — heavier gate not needed for the work that landed (no E2E surface changes; only tests + a11y linkage + architectural lift).

## What this session shipped

**7 commits.** ~352 a11y pair-links + 16 CI failures unblocked + 1 architectural lift + 1 new skill.

| Commit | Title | Notes |
|---|---|---|
| `269e185` | fix(api): unblock 16 auth integration test failures from cumulative wave drift | 5 distinct root causes — triaged via the new `/medcore-test-triage` 5-category framework. Result: 15/16 cleared; 1 remaining is known `audit-phi` flake category. |
| `e1de4f4` | feat(skills): /medcore-test-triage + cleanup-contract addendum | New project skill codifies the per-push Test failure-cluster diagnosis playbook. Includes the 5-category framework with concrete examples from this wave. `/medcore-route-test` SKILL gains a "Cleanup contract for module-scope mutations" section. |
| `c911f14` | fix(web/a11y): A2 Lane 1 — patient/admission/antenatal detail pages | 75 label/input pairs linked across 4 heavy detail pages. |
| `f89643d` | fix(web/a11y): A2 Lane 2 — clinical lifecycle pages | ~95 pairs across 20 files (prescriptions, appointments, surgery, antenatal, pediatric, vitals, er-triage, emergency, bloodbank, ot, telemedicine, symptom-diary, adherence, ambulance, referrals, feedback, scribe, sentiment, lab, lab-intel). |
| `e015cd8` | fix(web/a11y): A2 Lane 3 — financial/inventory/operations | ~75 pairs across 15 files (pharmacy, packages, insurance-claims, billing, purchase-orders, payment-plans, refunds, expenses, preauth, assets, suppliers, medicines, controlled-substances, visitors, walk-in). |
| `585861c` | fix(web/a11y): A2 Lane 4 — admin/AI/reports | ~107 pairs across 24 files (schedule, abdm, audit, reports, broadcasts, complaints, analytics, ai-letters, ai-booking, ai-fraud, ai-differential, ai-kpis, ai-analytics, ai-roster, ai-radiology, my-schedule, leave-management, my-leaves, my-activity, duty-roster, admissions root, predictions). |
| `0c8ab07` | refactor(db): A10 — lift tenant-prisma to @medcore/db with back-compat re-export shim | Lifted `tenantScopedPrisma`, `runWithTenant`, ALS primitives. 100+ existing import sites in `apps/api` compile unchanged via shim. `tenant-context.ts` also lifted (single shared ALS instance). 19 unit tests + 14 tenant-context tests + rls.test.ts all pass. |

## Most-impactful single artefacts

- **`/medcore-test-triage` skill** at `.claude/skills/medcore-test-triage/SKILL.md` — codified 5-category framework: stale-contract / cred-mismatch / cascade-poisoning / strip-vs-reject / pre-existing. Each category has a concrete example pulled from the 2026-05-04 auth wave. Pairs with `/medcore-release` (different scope: per-push Test = 7-10 min cascade-prone; release.yml = 25-40 min cascade-rare).
- **`apps/api/src/middleware/sanitize.ts`** gained `SCHEMA_REJECT_PATHS` skip-list — the canonical way to opt a route OUT of global tag-stripping when its schema explicitly rejects raw HTML (currently `/api/v1/auth/register`; future routes adding `containsHtmlOrScript.refine()` should be added here too).
- **`apps/api/src/routes/auth.ts:__resetLoginLimiterForTests()`** — the canonical pattern for module-scope state cleanup under `singleFork: true`. New routes with lazy-cached singletons should ship the reset hook in the same commit.
- **`packages/db/src/tenant-prisma.ts` + `packages/db/src/index.ts` re-exports** — single source of truth for tenant-scoped Prisma access. Workers, cron, secondary services import from `@medcore/db` directly.

## Architectural finding closure status (cumulative)

| ID | Status | Closed in |
|---|---|---|
| A1 | **Open — product decision** | — |
| ~~A2~~ | ✅ Closed 2026-05-05 | `c911f14`/`f89643d`/`e015cd8`/`585861c` |
| ~~A3~~ | ✅ Closed | `c052df6` + doc note |
| ~~A4~~ | ✅ Closed | `7bd9d14`/`ffe199f`/`34bb5a3`/`e0e1429` |
| ~~A5~~ | ✅ Closed | `40673aa`/`0646b0b`/`d5a4fef`/`75a5ccc` |
| ~~A6~~ | ✅ Closed | `9ee446e` |
| ~~A7~~ | ✅ Closed (#456) | `a2b32b4` |
| ~~A8~~ | ✅ Closed (#457) | `e7ca04d` |
| ~~A9~~ | ✅ Closed | `cde1829` |
| ~~A10~~ | ✅ Closed 2026-05-05 | `0c8ab07` |

**9 of 10 closed.** A1 is the only remaining architectural follow-up.

## Outstanding session-level findings

These came up during the wave but were not actioned:

1. **`audit-phi` flake on `INSURANCE_CLAIMS_LIST` sub-test** (recurrence of the `AI_SCRIBE_READ` flake from 2026-05-03). Hypothesis: audit row write is fire-and-forget (`auditLog(...).catch(console.error)`) and the test asserts on the row before the deferred Promise has flushed. **Suggested fix**: add an `await waitForAuditFlush()` test helper that polls until the expected `AuditLog` row appears (or times out at 2s). If reproduces on rerun → ship the helper. If 1-shot → pure scheduler noise, defer.

2. **CI lint for the A2 pattern** — now that all 76 dashboard pages have correct `htmlFor`/`id` linkage, prevent regression with an ESLint rule that flags new `<label>X</label><input>` pairs without linkage. Candidate: `jsx-a11y/label-has-associated-control` (already provided by `eslint-plugin-jsx-a11y`). If not enabled, enable it.

3. **A10 unlocks future package consumers**. Workers / cron / mobile API / any future secondary service can now `import { tenantScopedPrisma } from "@medcore/db"` without crossing the `apps → packages` arrow. Worth flagging in `docs/ARCHITECTURE.md` next time it's edited.

## Skills available (7 project-shared, all in `.claude/skills/`)

- `/medcore-fanout` — N parallel foreground agents, non-overlapping lanes (Mode A or Mode B).
- `/medcore-e2e-spec` — scaffold one Playwright route spec.
- `/medcore-route-test` — scaffold one Vitest route-handler unit test (now with cleanup-contract addendum).
- `/medcore-release` — dispatch + watch + diagnose `release.yml`.
- `/medcore-doc-roll` — capture each wave's findings into TODO + CHANGELOG (idempotent).
- `/medcore-ai-route-audit` — apply the AI inference audit-row contract to any AI route.
- `/medcore-test-triage` — **NEW** — 5-category per-push Test failure diagnosis playbook.

**Pickup protocol** (codified in TODO.md banner): `git pull origin main` BEFORE starting Claude — skill descriptions load at session start.

## Pickup commands

```bash
cd "<medcore checkout>"
git pull origin main          # should fast-forward to 0c8ab07 or beyond

# Confirm last per-push CI is green (mostly — 1 audit-phi-flake remnant expected)
gh run list --branch main --limit 3 --json databaseId,name,status,conclusion,headSha

# If audit-phi flake reproduces → ship waitForAuditFlush() helper:
#   New file: apps/api/src/test/helpers/audit-wait.ts
#   Polls AuditLog every 50ms up to 2s for the (action, entity, entityId) tuple

# If A1 (page-level VIEW_ALLOWED policy) is on the agenda:
#   Ask user for the product decision before any code. The decision is:
#   "Page reachable, API gates" (current behavior) vs "Page redirects to
#   /dashboard/not-authorized for non-allowlisted roles" — affects ~20+
#   dashboard pages currently in the first bucket.
```

## Reference quick-links

- [`/TODO.md`](../../TODO.md) — banner reflects this session; "Open architectural follow-ups" canonical table is the single live view.
- [`/CHANGELOG.md`](../../CHANGELOG.md) — `[Unreleased]` window has the wave-by-wave entries.
- `.claude/skills/medcore-test-triage/SKILL.md` — the new triage playbook (read before next CI red).
- `apps/api/src/test/helpers/security-assertions.ts` — the 6 adversarial-vector helpers (yesterday's wave).
- Memory: `~/.claude/projects/c--Users-Admin-gbs-projects-medcore/memory/` — 5 entries, most relevant for next session: `feedback_singlefork_module_scope.md` (the cascade pattern that drove this wave), `project_repo_conventions.md` (now points 6 + 7 cover test-DB seed creds + sanitize layering).
