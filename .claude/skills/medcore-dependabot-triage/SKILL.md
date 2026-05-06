---
name: medcore-dependabot-triage
description: Process the open dependabot PR backlog as a wave — auto-merge the patch+minor PRs that land green, leave the breaking-major PRs open with a clear note, distinguish stale CI failures from real ones, and unblock the workspace's known peer-dep ERESOLVE class via a root .npmrc. Use when the user says "look at the dependabot PRs", "merge what we can", "clear the dep backlog", or there are 3+ open `app/dependabot` PRs sitting on the queue. Codified from the 2026-05-05 evening wave (8 dependabot PRs triaged; #571 + #662 merged; 7 majors deferred; root .npmrc landed as the unblock).
---

# medcore-dependabot-triage

Codifies the playbook for processing the dependabot PR backlog. The backlog grows weekly and most of it is patch/minor noise that's safe to merge once CI is fresh — but a few traps eat hours: stale CI showing the old SHA's failures, dependabot's `recreate` command renaming the PR mid-flight, and the workspace's react/react-native peer-dep mismatch that always fails ERESOLVE in dependabot's lockfile-regenerate path.

## Why this skill exists

Three concrete failure modes from the 2026-05-05 wave that wasted ~30 min each before being recognized:

1. **#510 → #661 → #662**: dependabot's `@dependabot recreate` closes the old PR and opens a new one with a different number. Tracking PR-by-number breaks; track by `headRefName` (the dependabot/* branch name).
2. **`gh pr checks <N>` shows stale failures** from a SHA that's no longer the PR head. Always cross-check `gh run list --commit <head>` to see what actually ran on the current rebase.
3. **ERESOLVE during install** on every dependabot PR, even single-package patch bumps. Root cause: `apps/mobile` pulls `react-native@0.85` which peers `react@^19`, but the workspace pins `react@^18.3`. Main's lockfile silently accepts it; dependabot regenerates the lockfile from scratch and the strict peer-dep checker fails. **Fix**: a root `.npmrc` with `legacy-peer-deps=true` (commit `19dd6a0`).

This skill is the single source of truth so we don't re-derive the diagnosis each backlog cycle.

## When to invoke

Invoke when:
- The user says "look at the dependabot PRs", "merge the safe ones", "clear the dep backlog", or "rebase all the dependabots".
- 3+ open PRs from `app/dependabot` are sitting on the queue.
- A dep-bump PR is failing ERESOLVE and you suspect the peer-dep trap.

Do NOT invoke when:
- Only one PR is open and it's a clearly-tagged breaking-major (vitest 2 → 4, react 18 → 19, etc.) — those are dedicated migration sessions, not "triage" work.
- The user has explicitly asked to merge a specific PR; just merge that one.

## The triage decision tree

For each open dependabot PR:

```
Is the PR a patch or minor bump?           ── YES ──>  AUTO-MERGE candidate (gh pr merge --squash --auto)
   └── NO (major) ────────────────────────────────>   LEAVE OPEN — needs migration work
                                                       Document what's known to break:
                                                         - eslint 9→10: config format changes
                                                         - react 18→19: hook semantics, ref-as-prop, async transitions; pair with react-dom
                                                         - prisma 6→7: client API surface changes
                                                         - vitest 2→4: snapshot/runner changes
                                                         - express 4→5: middleware ordering, async handler semantics
                                                         - opentelemetry 1→2: SDK init API changes
```

For the auto-merge candidates, the workflow:

1. Fan out `@dependabot rebase` so they all pick up current main (including any CI-infra commits like the `.npmrc`).
2. Wait for fresh CI on each.
3. Auto-merge anything fully green or only-nightly-load-test-failing.
4. Report the verdict.

## Workflow

### 1. List the backlog

```bash
gh pr list --state open --author "app/dependabot" \
  --json number,title,headRefOid,headRefName,mergeStateStatus,updatedAt --limit 30
```

For each PR, note: number, title (the bumps), `mergeStateStatus`, `updatedAt`. **Treat `headRefName` as the stable identifier** — dependabot may close + recreate the PR with a new number on the same branch.

### 2. Categorize

By the title alone, slot each into:

- **Patch+minor group** — usually a single grouped PR titled `deps(deps): bump the patch-and-minor group across N directories with M updates`. Auto-merge candidate.
- **Single patch/minor** — same disposition as the group.
- **Single major** — leave open. Note in the report what migration work is known to be needed.
- **Workspace-internal** (e.g. `@medcore/*`) — should not appear from dependabot, but if it does, treat as suspicious; read first.

### 3. Pre-flight: ensure main can install

Before any rebase fan-out, confirm the workspace's known peer-dep traps are unblocked. Check:

```bash
test -f .npmrc && grep -E "legacy-peer-deps" .npmrc
```

If absent and the project has the react/react-native peer-dep mismatch (`apps/mobile/package.json` pins `react-native@~0.85` AND the root pins `react@^18`), commit a root `.npmrc`:

```
# Legacy peer-deps resolution.
# Reason: apps/mobile pulls react-native@0.85 which peers react@^19, while
# the workspace pins react@^18.3. The existing root lockfile silently
# accepts this; dependabot's lockfile-regenerate path is strict and fails
# ERESOLVE on every bump. legacy-peer-deps=true makes both paths permissive.
# Remove once react@19 + react-dom@19 (paired PRs #471 + #467) land.
legacy-peer-deps=true
```

Push to main FIRST. Then proceed — every subsequent dependabot rebase will pick this up via the rebase merge-base.

### 4. Fan-out rebase

```bash
for n in <list of auto-merge candidate PR numbers>; do
  gh pr comment "$n" --body "@dependabot rebase" 2>&1 | tail -1
done
```

Dependabot typically responds in 1-3 min. If after 5 min there's no rebase, escalate to `@dependabot recreate` — but **be aware this closes the PR and opens a new one** with a different number on the same `headRefName`.

### 5. Arm auto-merge

For each candidate, set `--auto` so it merges the moment CI passes:

```bash
for n in <candidates>; do
  gh pr merge "$n" --squash --auto
done
```

**`--squash` is the repo convention** (every recent dep-bump merge is a squash; check `git log --merges --oneline -5` if unsure).

### 6. Wait + verify

Schedule a wakeup ~10-12 min out. On wake:

```bash
gh pr list --state open --author "app/dependabot" --json number,title,state
gh run list --branch main --workflow=Test --limit 3 --json conclusion,headSha,status
```

For each PR still open, check whether CI is finished and what failed:

```bash
gh pr checks <N> | head -15
# If checks look stale (timestamps older than the PR's updatedAt):
gh pr view <N> --json headRefOid
gh run list --commit <HEAD_OID> --limit 5 --json conclusion,workflowName,status
```

The `gh run list --commit` cross-check is the **stale-CI detector** — it shows what actually ran on the current SHA, regardless of what `gh pr checks` cached.

### 7. Distinguish stale failures from real ones

A failing job on a PR can be:

| Signal | Diagnosis | Action |
|---|---|---|
| The same job is failing on `main` for the last 2-3 runs | Pre-existing — not this PR's fault | Note in report; merge candidate stays a merge candidate |
| The failing run's SHA != the PR's current `headRefOid` | Stale; look for newer runs on the new SHA | Recheck via `gh run list --commit <head>` |
| Failure is at the `npm install` step in <30s with ERESOLVE | Peer-dep trap; ensure `.npmrc` was applied (step 3) and force a fresh rebase | If `.npmrc` is on main but the PR's branch predates it, `@dependabot rebase` to bring it in |
| Failure is in actual tests | Real breakage | Leave open, note the failing assertion |

### 8. Report

After the wave settles, report:

| PR | Outcome | Why |
|---|---|---|
| `#N` | ✅ merged at `<sha>` | All checks green |
| `#M` | ⏸ open | <one-line reason — failing test name, migration class, etc.> |

Include in the report:
- Total PRs touched
- How many merged
- The `.npmrc` commit (if landed this wave) — future sessions need to know it exists
- Any PR that **appeared green but the CI was stale** — explicitly flag because it's the highest-confusion case

## Anti-patterns

- **Don't blind-merge majors.** Each major bump in this repo has a known migration path; merging without reading release notes will break prod.
- **Don't track dependabot PRs by number alone.** Track by `headRefName`. `recreate` will rename the PR.
- **Don't trust `gh pr checks` after a recent rebase** — it can show the old SHA's results until GitHub catches up. Cross-reference `gh run list --commit <head>`.
- **Don't push a fix to a dependabot/* branch directly** unless you've confirmed dependabot won't overwrite. Manual force-push works but conflicts with dependabot's own rebases.
- **Don't comment `@dependabot rebase` AND `@dependabot recreate` on the same PR within minutes** — recreate supersedes rebase and you'll end up with a new PR number you weren't expecting.
- **Don't assume the bundle-size soft-fail is a real regression.** It's a threshold check; small bumps can cross the line transiently. Re-check on the next push.

## Cross-references

- Canonical run: 2026-05-05 evening wave — commits `7fbc46e` (PR #571), `19dd6a0` (root `.npmrc`), `<#662 squash sha>` (patch+minor group of 7 updates).
- Pairs naturally with `/medcore-test-triage` for the failing-test classification step.
- Project memory entry `feedback_dependabot_peer_deps_eresolve.md` (suggested) — codifies the react/react-native trap so a future session doesn't re-derive it.
