# Session snapshot — 2026-05-05 night (dep-bump triage marathon → home pickup)

End-of-session handoff for **home pickup**. Read this first, then [`/TODO.md`](../../TODO.md), then go. Replaces `SESSION_SNAPSHOT_2026-05-05-evening.md` as the most recent handoff.

## State at session end

- **HEAD on `main`** = `2edfbf1` (`Fixed/medcore/issue (#521)`).
- **Working tree:** clean.
- **Open GitHub issues: 1** — `#482` (JWT HS256 → RS256/EdDSA, blocked on operational key-rollover plan).
- **Open architectural follow-ups: 1** — A1 (page-level `VIEW_ALLOWED` policy decision — product call).
- **Open PRs: 3** (down from 9 at session start). **7 PRs merged tonight.** Remaining 3 are confirmed-red majors needing dedicated migration sessions.
- **Per-push CI on main:** green through `2edfbf1`. Auto-deploy operating; `medcore.globusdemos.com` is current.

## What this session shipped

**7 PRs merged + 1 new skill + 1 CI-infra fix.**

| Commit | What |
|---|---|
| `7fbc46e` | **#571** Sourav analysis — 7 fixes (AI radiology polling tight-loop, Sarvam API key, signed URLs for X-rays, EntityPicker for patient UUID input, MR-number support, double-`?` URL bug, AppointmentStatus enum). 5 files / 251 add / 65 del. |
| `19dd6a0` | **`.npmrc` with `legacy-peer-deps=true`** at repo root — unblocks every dependabot PR. Root cause was the react@18 ↔ react-native@0.85 (peers react@19) mismatch that the existing lockfile silently accepts but dependabot's lockfile-regenerate path strict-rejects. |
| `d9e3e97` | **#662** patch-and-minor group of 7 — turbo 2.9.7→2.9.9, @aws-sdk/client-s3 + s3-request-presigner 3.1041→3.1042, openai 6.35→6.36, react-native-gesture-handler 2.31.1→2.31.2, zustand 5.0.12→5.0.13. (Was originally #510 → recreated as #661 → recreated as #662 by `@dependabot recreate`.) |
| `6a17815` | **#464** @opentelemetry/sdk-trace-node 1.30.1 → 2.7.1 — major bump merged by user despite API tests failing on the rebased run. Worth watching for runtime regressions in observability. |
| `7fa540c` | **#466** express 4.22.1 → 5.2.1 — major bump that **passed all 9 CI jobs** on the rebased run. Surprising, but CI is the gate; if it deploys and runs, it's good. Watch for middleware-ordering surprises. |
| `ce13662` | **`/medcore-dependabot-triage`** new skill codifying tonight's playbook. Pairs with `/medcore-test-triage`. |
| `d02203e` | **#471** react 18.3.1 → 19.2.5 + @types/react. All 9 CI jobs green (paired with #467). |
| `98efa9e` | **#467** react-dom 18.3.1 → 19.2.5. Merged immediately after #471 — paired bump. All 9 CI jobs green. |
| `2edfbf1` | **#521** Subhadip's 5-bug fix PR (lab order from admission, medication order, notifications mark-all-as-read, appointment booking validation, available-slot disabled-state). I rebased the branch onto current main + fixed the 4 appointment-test fixtures: first cycle swapped UUID→HH:MM (`b3ffef3`), second cycle moved `date: today` → `date: tomorrow` to dodge the route's `#491` past-time guard (`37e3985`). All 12 CI jobs green. |

## Open PRs at session end (3 — all confirmed-red majors)

| # | Title | Reason left open |
|---|---|---|
| **#469** | vitest 2 → 4 | `TypeError: Cannot read properties of undefined (reading 'fetchCache')` — vitest 2→4 internal API change. Real migration: snapshot/runner format updates. |
| **#470** | @prisma/client 6 → 7 | 5 jobs fail (Lint + Type check + bundle + Web tests + API tests). Schema/client API surface changes. Real migration. |
| **#472** | eslint 9 → 10 | Lint job fails — config format changes between v9 and v10. Real migration: rewrite `.eslintrc` → `eslint.config.js` flat config. |

Each is a dedicated migration session. The order I'd suggest tackling them: **eslint** first (smallest blast radius, lint-only impact), then **prisma** (schema review, but all routes already use Prisma so the surface area is bounded), then **vitest** (largest — every test file may need updates, snapshots may need regeneration).

## What the dep-bump triage taught us (codified into the skill)

1. **Stale CI after rebase**. `gh pr checks <N>` cached results from the old SHA fool you into thinking nothing's running. Cross-check `gh run list --commit <head>` whenever the timestamps look off.
2. **`@dependabot recreate` closes + reopens with a new number**. Tonight: #510 → #661 → #662. The branch name (`headRefName`) is stable; the PR number isn't.
3. **The peer-dep ERESOLVE wall**. Mobile-workspace + frontend-workspace pinning different React majors trips dependabot's strict regenerate. Root `.npmrc` with `legacy-peer-deps=true` is the canonical unblock. **Remove the flag once react@19 lands** (#471 + #467).
4. **`enablePullRequestAutoMerge` is OFF on this repo**. `gh pr merge --auto` returns "Auto merge is not allowed". Must merge manually after CI clears.
5. **Bundle-size soft-fail is a threshold check, not a regression gate**. PR #571 tripped it once and the next push cleared it.
6. **Express 4 → 5 is more compatible than the docs imply**. CI passed clean. Still worth watching the prod runtime for middleware-ordering surprises.

## Skills available (10 project-shared, all in `.claude/skills/`)

- `/medcore-fanout` — N parallel foreground agents, non-overlapping lanes (Mode A or Mode B).
- `/medcore-e2e-spec` — scaffold one Playwright route spec.
- `/medcore-route-test` — scaffold one Vitest route-handler unit test.
- `/medcore-release` — dispatch + watch + diagnose `release.yml`.
- `/medcore-doc-roll` — capture each wave's findings into TODO + CHANGELOG (idempotent).
- `/medcore-ai-route-audit` — apply the AI inference audit-row contract to any AI route.
- `/medcore-test-triage` — 5-category per-push Test failure diagnosis.
- `/medcore-bola-sweep` — per-route BOLA verify-or-patch playbook.
- `/medcore-dependabot-triage` — **NEW tonight** — dep-bump backlog wave triage with the rebase-fan-out + auto-merge-greens pattern.

**Pickup protocol**: `git pull origin main` BEFORE starting Claude (skill descriptions load at session start).

## Pickup commands (home)

```bash
cd "<medcore checkout>"
git pull origin main          # should fast-forward to 2edfbf1 or beyond

# Now-relevant first action: the legacy-peer-deps=true unblock in
# .npmrc is no longer strictly required (react@19 + react-dom@19 are
# now landed and react-native@0.85's peer is satisfied). To verify:
#   1. Open a fresh dependabot PR (e.g. comment `@dependabot rebase`
#      on #469, #470, or #472) AFTER removing the line and pushing.
#   2. If install passes → flag was overshooting and can stay removed.
#   3. If install fails ERESOLVE again → the workspace has another
#      hidden mismatch; restore the line and document the new conflict.
# Don't remove blindly — verify with one PR's CI first.

# Tackle the 3 remaining migration PRs as dedicated sessions:
#   #472 eslint 9→10  — smallest; flat-config migration only
#   #470 prisma 6→7   — bounded but touches every model query
#   #469 vitest 2→4   — largest; snapshot/runner format changes

# A1 (page-level VIEW_ALLOWED policy) still needs the product decision
# before code; ask user before starting.

# Smoke-test express 5 + otel 2 + react 19 on dev to make sure the
# 3 framework majors didn't break anything subtle:
#   - https://medcore.globusdemos.com/login (admin login + dashboard load)
#   - POST /api/v1/patients (express middleware path)
#   - any AI route (otel SDK init)
#   - any heavy interactive page (react 19 hydration)
```

## Outstanding session-level findings

1. **#464 was merged with API tests failing** — user merged manually past the gate. If observability runtime breaks (otel SDK init), that's the suspect. Dev-deploy auto-fired on the merge; check `medcore.globusdemos.com` logs if anything looks off.
2. **#466 express 4 → 5 passed CI but** the project's middleware ordering may not be exhaustively exercised by integration tests. Worth a manual smoke through key flows on dev: `/api/v1/auth/login`, `/api/v1/patients` POST, `/api/v1/billing/webhooks/razorpay`. If those return correctly, prod is safe.
3. **`tmp/` was created during a Drive-download attempt** for the new logo (folder requires sign-in; Playwright couldn't auth). Dir is removed; **we still need the actual logo file from the user** to swap into `apps/web/public/icon-{192,512}.png` + `apps/mobile/assets/{favicon,icon,adaptive-icon,notification-icon,splash}.png`. Currently the wordmark is text-only — there is no SVG/PNG brand mark in the codebase.
4. **GitHub Auto-merge disabled** — confirmed via `enablePullRequestAutoMerge: false` GraphQL error. If the team wants `gh pr merge --auto` to work, an admin needs to flip the repo setting.

## Reference quick-links

- [`/TODO.md`](../../TODO.md) — banner reflects this session.
- [`/CHANGELOG.md`](../../CHANGELOG.md) — `[Unreleased]` window has the wave-by-wave entries.
- `.claude/skills/medcore-dependabot-triage/SKILL.md` — tonight's new skill.
- `.npmrc` — newly added; remove once `react@19` (PRs #471 + #467) lands.
