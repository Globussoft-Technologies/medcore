---
name: medcore-pr-triage
description: Process the open human-PR backlog (NOT dependabot — that's a separate skill) using the mergeability × check-state matrix to classify each PR into close / comment / rebase / merge. Use when the user says "check the open PRs", "merge what we can", "clear the PR queue", or there are 3+ open PRs sitting on the queue. Codified from the 2026-05-07 wave (6 open PRs → triaged to 0; 3 closed as superseded/major-bump, 1 rebased, 2 merged green, 1 commented for first-time-contributor workflow approval). Companion to /medcore-dependabot-triage.
---

# medcore-pr-triage

Codifies the human-PR backlog playbook. Distinct from `/medcore-dependabot-triage`
(which handles `app/dependabot` PRs — patch/minor noise auto-merge, breaking-major
deferral, the workspace ERESOLVE class). This skill is for human-authored PRs:
your own work, contributor PRs, supersede chains, conflicts.

## Why this skill exists

The 2026-05-07 wave had 6 open PRs and surfaced four distinct paths through
the queue, each with its own gotchas:

1. **Your own PR rebased and merged** (#663 — eslint 10 migration). The
   conflict was lockfile-only, resolved cleanly with `--ours` + `npm install
   --package-lock-only`. The pattern is reusable across any feature-branch
   rebase against a moved-forward main.
2. **Contributor PR with real test failures** (#679 — Sourav's email-share).
   The 3 failing tests pointed at a real PR-introduced contract change
   (WHATSAPP/SMS now 501 instead of 200). The right move was a triage
   comment, not a merge or close — the author then took Option A and pushed
   a fix, which then merged green.
3. **First-time-contributor PR with NO checks ran** (#664 — billing money
   overflow). GitHub blocks workflow runs from new fork contributors until
   a maintainer clicks "Approve and run workflows" in the UI. CLI can't
   trigger that approval — must be a human in the GitHub web UI.
4. **Stale dependabot superseded by a hand-crafted migration** (#472 → #663).
   Closing the superseded PR with a one-line explanation is correct; merging
   both creates duplicate commits in main.

The cumulative cost of re-deriving each path is ~15 min per PR. This skill
is the single pass-through.

## When to invoke

Invoke when:
- User says "check the open PRs", "merge what we can", "clear the PR queue", "triage the backlog".
- 3+ open PRs in `gh pr list --state open` (after filtering out dependabot, since `/medcore-dependabot-triage` covers those).
- User points at a specific PR and says "merge if no conflicts" — call this skill scoped to that PR.

Do NOT invoke when:
- Only one PR is open and the user wants a deep review of it specifically — use `/medcore-external-pr-review` (or the generic `security-review` skill) for that.
- The user wants to merge regardless of CI state — that's a `--admin`-flag override, ask for explicit confirmation.
- All open PRs are dependabot — use `/medcore-dependabot-triage`.

## The triage matrix

For each open PR, fetch:

```bash
gh pr view <N> --json mergeable,mergeStateStatus,statusCheckRollup,headRefOid,baseRefName,author,additions,deletions,files
```

Then classify by `mergeable` × `mergeStateStatus`:

| `mergeable` | `mergeStateStatus` | What it means | Action |
|---|---|---|---|
| `MERGEABLE` | `CLEAN` | All checks green, no conflicts | **Squash-merge** with explanatory body. |
| `MERGEABLE` | `UNSTABLE` | No conflicts, some checks failing | **Drill into failures.** Are they real PR bugs or stale CI? See "Failure-cluster classification" below. |
| `MERGEABLE` | `UNSTABLE` (no checks ran) | First-time-contributor — workflows blocked | **Comment** asking maintainer (`@indianbill007` or repo owner) to "Approve and run workflows" in GitHub UI. CLI can't trigger this. |
| `MERGEABLE` | `BLOCKED` | Required reviewer / branch-protection rule unmet | Surface what's missing and ask user how to proceed (rare on this repo). |
| `MERGEABLE` | `BEHIND` | Branch is behind base | **Rebase** the branch (if author or you have write access to it) or comment asking author to rebase. |
| `CONFLICTING` | `DIRTY` | Real git conflicts | If it's your own branch, **rebase** with the lockfile-conflict recipe (see below). If contributor's, **comment** asking for a rebase. |
| `MERGEABLE` | `HAS_HOOKS` | Pre-merge hooks pending | Wait or re-poll; not a real action state. |

Plus three orthogonal classifications independent of the matrix:

- **Superseded by another open PR** (e.g. dependabot eslint 9→10 closed by hand-crafted #663): **close** with a one-line "Closing as superseded by #N" comment.
- **Major-version dependabot bump that needs hand-crafted migration** (e.g. Prisma 6→7, vitest 2→4): **close** with "needs hand-crafted migration; reopen later" comment. Don't leave breaking-majors sitting.
- **PR's own changes are a breaking contract change with no test updates**: **comment** with the diagnosis + two fix options (matches /medcore-bola-sweep's "writes-gated, reads-bare" pattern).

## Failure-cluster classification

When `mergeStateStatus: UNSTABLE` with failing checks, you have to determine
if the failures are real PR bugs or stale-CI / infra flakes. Three buckets:

### Real PR bug (most common)

The failing tests touch the same files/surfaces the PR modifies. The
assertion failures correlate with the contract change. **Action:**
comment on the PR with:
1. A failure table (Test → Channel/Input → Expected → Got → Root cause).
2. The two fix paths (keep design + update tests, OR keep contract + revert design choice).
3. Offer to help with test scaffolding if useful.

Reference: 2026-05-07 PR #679 triage. The 3 prescription tests failed
because the PR returned 501 for WHATSAPP where tests expected 200, AND
because `email.ts` required `SENDGRID_API_KEY` at runtime which wasn't
in CI env. Comment on PR #679 with the diagnosis was the right move; the
author took Option A and pushed a fix that merged green.

### Stale CI (rebase to fix)

The failures are from an old SHA that's no longer the PR head, OR they're
infrastructure issues (e.g. `lightningcss.linux-x64-gnu.node missing`)
that have since been fixed on `main` (e.g. lockfile regen). **Action:**
rebase the branch and re-run CI. Most failures clear automatically.

Reference: 2026-05-07 PR #663 — 3 failing checks (API tests, Web component,
Web bundle size). The bundle-size error was `Cannot find module
'../lightningcss.linux-x64-gnu.node'` which `main`'s commit `d4f09e1`
fixed by regenerating package-lock.json. Rebase resolved it.

### Infra flake (re-dispatch)

The shard fails in <60s with no test output, log shows `npm error code
EEXIST` / `ENOENT: rename '/home/runner/.npm/_cacache/...'` — the
parallel-job npm cache race. **Action:** re-dispatch the same SHA, no
code change.

Reference: 2026-05-06 release run #25464525782 — Chromium shard 5/12
died in ~60s with `npm error EEXIST` during `npm ci`, no Playwright
process ever started. Re-dispatched the same SHA and ran green. (See
`/medcore-test-triage` for the full infra-flake catalog.)

## The lockfile-conflict rebase recipe (for own branches)

When rebasing your own feature branch against `main`, if `package-lock.json`
is the only conflict:

```bash
git checkout fix/<branch-name>
git rebase main
# git status shows: UU package-lock.json (the only conflict)
git checkout --ours package-lock.json   # take main's regenerated lockfile
npm install --package-lock-only --ignore-scripts --no-audit --no-fund
# ^ layers the feature's package.json deps onto main's lockfile
git add package-lock.json
git rebase --continue
git push origin fix/<branch-name> --force-with-lease
```

`--force-with-lease` is the safer cousin of `--force` — it refuses if
remote has new commits you haven't seen. Use it instead of `--force` for
contributor branches you don't own; for your own branches either is fine
but `--force-with-lease` costs nothing.

Reference: 2026-05-07 PR #663 rebase. Conflict was lockfile-only;
recipe ran cleanly; CI re-ran on the new SHA and went CLEAN.

## The squash-merge body template

When merging, use a structured body — it lands on `main`'s history and
becomes searchable later:

```bash
gh pr merge <N> --squash --delete-branch \
  --subject "<conventional-prefix>(<scope>): <what changed> (#<N>)" \
  --body "Closes #<linked-issue> [if any].

- <bullet 1>
- <bullet 2>
- <bullet 3>

<one-paragraph context about why this is safe / what was reviewed>.

<any operational follow-ups: env vars to add, deploys to verify, etc.>"
```

The conventional-prefix format is required by repo convention (CLAUDE.md
gotcha #12): `fix(...)`, `feat(...)`, `docs(...)`, `chore(...)`,
`refactor(...)`, `test(...)`, `perf(...)`, `ci(...)`. Pick the one that
matches the PR's purpose, not the PR's noisy filename touch (a PR that
adds a test for a new feature is `feat`, not `test`).

## Workflow

1. **Fetch the queue:**

   ```bash
   gh pr list --state open \
     --json number,title,mergeable,mergeStateStatus,statusCheckRollup,author,headRefOid \
     --jq '[.[] | select(.author.login | startswith("dependabot") | not)]'
   ```

   Filter out `dependabot[bot]` — `/medcore-dependabot-triage` handles those.

2. **For each PR, classify by the matrix.** Don't act yet — build the full
   table first so you can present a single decisive plan to the user.

3. **Present the plan as a table:**

   ```
   | PR | Title | Conflicts? | Checks | Recommended action |
   |---|---|---|---|---|
   ```

   Recommend per-row + ask the user "do everything" / "skip X" / "drill
   into Y first".

4. **Execute the approved plan in this order** (least-destructive first):

   - **a. Comments first** (zero state change, helpful for contributors).
   - **b. Closes second** (state change but reversible — closed PRs can be
     reopened).
   - **c. Rebases third** (force-pushes contributor branches; ask before
     touching anything you don't own).
   - **d. Merges last** (hardest to reverse; triggers auto-deploy on every
     merge to main; consecutive merges collapse via
     `cancel-in-progress: true` on `Test` workflow).

5. **Watch the post-merge `Test` workflow** for the final merged SHA. The
   `cancel-in-progress: true` means earlier deploys cancel, so only the
   last merge's deploy actually completes.

## Common pitfalls

- **Merging a PR with `mergeStateStatus: UNSTABLE` because tests "feel like
  flake"** — they almost never are flake; they're usually real PR bugs.
  Drill into the failure first.
- **Closing a stale dependabot when the user has a hand-crafted replacement
  open** — leave a comment in the close message linking the replacement
  PR so dependabot doesn't recreate the closed one immediately.
- **Force-pushing a contributor's branch you don't own without asking** —
  same as the global rule; `--force-with-lease` is still destructive in
  scope. Only force-push your own branches without confirmation.
- **Triggering workflow approval via CLI** — there's no `gh` command for
  the "Approve and run workflows" button. Always direct the user to the
  GitHub web UI for first-time contributor PRs.
- **Forgetting `--delete-branch` on `gh pr merge`** — leaves stale branches
  in the repo. Always pass it unless the contributor explicitly wants the
  branch kept.

## Output

End-of-turn summary in this shape:

```
PR queue triage complete: N PRs → 0 open.
- Closed: #X (reason), #Y (reason), #Z (reason).
- Commented: #A (why).
- Rebased: #B (force-pushed; CI re-running).
- Merged: #C (squash, SHA <abc1234>), #D (squash, SHA <def5678>).

Auto-deploy will fire for the last merge SHA. Watch with:
  gh run list --workflow=Test --branch=main --limit=3
```
