---
name: medcore-fanout
description: Dispatch multiple parallel foreground Agent calls to close non-overlapping MedCore gaps in one shot — closing several E2E backlog routes at once, writing several test files at once, fixing several bugs at once, or any "do these N things in parallel" request. Use when the user wants concurrent work on tasks that touch different files / directories. Do NOT use for sequential dependencies, single-task work, or tasks that need bg dispatch (this skill exists specifically because bg agents are broken on this VSCode harness build).
---

# medcore-fanout

The codified pattern for **actually-parallel** work in this MedCore session.

## Why this skill exists

`run_in_background: true` Agent calls are broken on Claude Code VSCode v2.1.126: every `Read`/`Edit`/`Write`/`Glob`/`Grep` fires an interactive permission popup, and the 600s watchdog kills the agent if no click. See [`reference_worktree_bg_agent_perms.md`](../../../../.claude/projects/c--Users-Admin-gbs-projects-medcore/memory/reference_worktree_bg_agent_perms.md) for the full diagnosis. **Foreground Agent calls in a single tool-use message DO run concurrently** — that's the only proven parallelism path right now. This skill codifies that pattern with the MedCore-specific guard rails.

## When to invoke

Invoke when:
- The user explicitly asks for parallel work ("close these 4 routes in parallel", "fan out", "spin agents on these").
- You are about to ship 2+ independent items and they touch non-overlapping directories.
- The user says "do these N things" and they are clearly independent (E2E specs for 4 different routes, snapshots for 4 different generators, etc.).

Do NOT invoke when:
- The work is sequential (dependency between steps).
- Only one task — just do it.
- Tasks touch the same file or the same `package.json` / lockfile (race risk).
- The user wants async / "fire and forget" work — bg agents are broken; explain that and suggest foreground or DIY.

## How to dispatch

**Single message, multiple Agent tool calls in parallel.** All foreground (no `run_in_background` parameter, no `isolation: "worktree"` — both have known issues).

Each Agent call must include:

1. **Strict file scope** — the directories/files this agent owns. Other agents touch nothing there.
2. **The MedCore commit discipline** (verbatim — paste this into every prompt):
   - Conventional commits (`test(...)`, `fix(...)`, `feat(...)`, `docs(...)`, `chore(...)`, `perf(...)`, `ci(...)`).
   - **NO `Co-Authored-By: Claude` trailer** (forbidden by user's global CLAUDE.md).
   - Stage with `git add <specific files>` — never `git add -A`.
   - Commit with `git commit -m "<msg>" -- <files>` (the trailing `-- <files>` scopes the commit even if other files are staged from concurrent agents).
   - Push with rebase-retry loop:
     ```bash
     for i in 1 2 3 4 5; do
       if git push origin main; then break; fi
       git fetch origin main
       git rebase origin/main
     done
     ```
3. **The descriptive-headers convention** for any new test or new entry-point file (per [`docs/README.md`](../../../../docs/README.md) "Tests & feature code"):
   - Top-of-file 2-4 line block comment: **what** / **which modules** / **why**.
   - `describe(...)` strings should be specific behaviour-and-surface descriptions, not single words.
4. **A short, concrete deliverable** the agent must report (commit SHA, test count, what was skipped + why). Cap final response at ~200 words.
5. **Time discipline** — "If a sub-task is hard to mock / blocked, skip it and move on. N solid items shipped > N+M items half-done."

## Lane-discipline checklist

Before dispatching, verify the lanes are non-overlapping:

| Risk | Mitigation |
|---|---|
| Two agents modify `apps/api/package.json` | Only one agent can touch each `package.json` per batch; route the script-entry change to that one. |
| Two agents touch root `package-lock.json` | Only one agent runs `npm install` in a batch. |
| Two agents add tests to the same dir | Pre-assign distinct test filenames; explicit "do NOT touch <X>" in each prompt. |
| Concurrent `git commit` clobbers staged files | The `git commit -m "<msg>" -- <files>` form scopes by file, not by index — safe under contention. |
| Concurrent `git push` rejects | Rebase-retry loop (above) is mandatory in every prompt. |

## Per-agent prompt template

Use this skeleton for each agent's prompt. Replace the `<…>` placeholders.

```
You are working in the MedCore HMS monorepo at `c:\Users\Admin\gbs-projects\medcore`. Goal: <one-sentence outcome>.

**This is a parallel-fanout run.** N other agents are working concurrently in the same repo, each in a different directory. Your scope:

- Files you may write to: <explicit list>
- Files you may NOT touch: <explicit list of others' lanes + lockfiles + shared package.json files>
- You may read anything.

## Steps
<3-7 concrete steps>

## Validate
- <test command(s) that must be green>
- `npx turbo run lint --filter=<scope>` must be green.

## Commit (concurrency-safe)
- Conventional commit, NO Co-Authored-By trailer.
- `git add <your files>` (never `-A`).
- `git commit -m "<msg>" -- <your files>` (the `--` scopes the commit).
- Push with rebase-retry:
  ```bash
  for i in 1 2 3 4 5; do
    if git push origin main; then break; fi
    git fetch origin main
    git rebase origin/main
  done
  ```

## Descriptive headers (mandatory for new test / entry-point files)
Top-of-file 2-4 line block comment: what / which modules / why. `describe(...)` strings should be specific. See `docs/README.md` "Tests & feature code".

## Deliverable
Single commit. Report under 200 words: commit SHA, what shipped, anything skipped + why. **Ship — don't narrate.**
```

## Post-launch

After the parallel batch completes:

1. Summarize each agent's commit in a single table for the user (commit SHA, what landed, any skips).
2. If any agent failed, surface the failure prominently and ask the user whether to retry, redirect, or skip.
3. If race-related rebase happened, note it (audit-friendly).
4. Recommend the next move (e.g., "all four E2E routes shipped — kick off release.yml to validate?").

## Common batches for MedCore

These bundles have been validated in past sessions. Use them as templates:

- **E2E backlog batch**: 3-4 agents, each closing one zero-coverage route. Lanes: `e2e/<route-1>.spec.ts`, `e2e/<route-2>.spec.ts`, etc. Each may also touch `docs/E2E_COVERAGE_BACKLOG.md` (the closure-annotation line is per-route, low race risk; rebase-retry handles it).
- **P-list test batch**: P9 (`apps/api/src/services/__snapshots__`), P3 (`apps/web/src/components/**/*.a11y.test.tsx`), P10 (`apps/api/src/services/ai/*.bench.ts`), P2 (`packages/db/src/__tests__/migrations.test.ts`).
- **Source-fix batch**: each agent owns one route handler. Lanes: `apps/api/src/routes/<a>.ts`, `apps/api/src/routes/<b>.ts`, etc.

## Anti-patterns observed

- **Don't dispatch with `isolation: "worktree"`.** Worktree paths under `.claude/worktrees/` trigger the same permission-popup gate; the harness needs the user to click for every Read.
- **Don't dispatch with `run_in_background: true` for file-write tasks.** Bash-only tasks ("run this test, report exit code") work in bg; anything that reads source files stalls.
- **Don't skip the rebase-retry loop.** Concurrent pushes WILL race; the second one fails with "rejected".
- **Don't let agents `git add -A`.** Concurrent staging will pull other agents' files into a single commit.
