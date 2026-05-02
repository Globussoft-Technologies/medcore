# Session snapshot — 2026-04-29

End-of-day handoff so the next session (possibly on another machine) can pick up cleanly.

## What landed today

| Commit | What |
|---|---|
| [`aa3ab9e`](https://github.com/Globussoft-Technologies/medcore/commit/aa3ab9e) | 17 prod-bug fixes (RBAC #382-#385, validation, display) |
| [`68cd765`](https://github.com/Globussoft-Technologies/medcore/commit/68cd765) | GHA auto-deploy workflow (push to main → tests → SSH → `scripts/deploy.sh --yes`) |
| [`66c6183`](https://github.com/Globussoft-Technologies/medcore/commit/66c6183) | DEPLOY.md TL;DR pointing at auto-deploy |

## Issue triage

- 96 open at start → closed 33 (29 fixed by `aa3ab9e`, 2 by `c45b1d8`, 2 dups of #235) → **63 open**.
- Tracking issue [`#414`](https://github.com/Globussoft-Technologies/medcore/issues/414) groups the remaining 61 real bugs by tier (security/money → workflow → validation → polish). Use it as the work queue.

## Open PRs (in flight when session ended)

| # | Title | State | Notes |
|---|---|---|---|
| [#391](https://github.com/Globussoft-Technologies/medcore/pull/391) | Hide invoice quick action for doctors (#176) | CI running (workflow approved) | Fork PR by alceops; merged-with-main verified clean locally — 12/12 patient-detail tests pass |
| [#412](https://github.com/Globussoft-Technologies/medcore/pull/412) | Derive invoice status from payments (#386) | CI running (workflow approved) | Fork PR by alceops; merged-with-main verified clean — 17/17 billing tests pass |
| [#410](https://github.com/Globussoft-Technologies/medcore/pull/410) | About section + remove demo creds | "Update branch" triggered → CI re-running | Same-repo branch by subhadipde-collab; against current main all 665 web + 1180 api+shared tests pass |
| [#413](https://github.com/Globussoft-Technologies/medcore/pull/413) | feat(api): #388 server-side auto-NO_SHOW cron | CI running (just opened) | Same-repo branch `feat/388-auto-noshow-cron`; 7/7 unit tests pass locally |

All four merge cleanly against current `main`. Once CI is green, squash-merge each. Auto-deploy will then pick up the merged commits and ship them to dev.

## CI/CD wiring

Auto-deploy is **on**. Push to `main` triggers `test` + `web-tests` + `typecheck` + `e2e` → on green, the `deploy` job SSHes into `empcloud-development@163.227.174.141` and runs `scripts/deploy.sh --yes`. Concurrency group `deploy-medcore-dev` queues overlapping deploys.

Required secrets (already configured in repo settings):
- `DEPLOY_HOST` = `163.227.174.141`
- `DEPLOY_USER` = `empcloud-development`
- `DEPLOY_SSH_KEY` = ed25519 private (matching pubkey is in `~/.ssh/authorized_keys` on the dev server)
- `DEPLOY_KNOWN_HOSTS` = scanned via `ssh-keyscan -H 163.227.174.141`

The CI keypair was generated on this machine at `~/medcore-ci-key` (private) + `~/medcore-ci-key.pub` (public). The pair is **not** stored in the repo. If the next machine needs to SSH into the dev server with the CI identity, copy these two files. Otherwise, normal SSH via the existing `.env` `SERVER_USER`/`SERVER_PASSWORD` still works.

## Local-only state to be aware of

- **`.env` contains a `GITHUB_TOKEN=ghp_…` line** added during this session for `gh` CLI auth. The `.env` is gitignored (line 5 of `.gitignore`), so it isn't on GitHub. **Rotate this PAT** at https://github.com/settings/tokens once you no longer need it — it was pasted in chat earlier and is in conversation logs.
- **CI keypair** at `~/medcore-ci-key` and `~/medcore-ci-key.pub` — see above. Local only; safe to leave or copy.
- **Agent worktree** at `.claude/worktrees/agent-ae9982f4dbfb24269` — still locked, but its work is fully pushed (PR #413). Can be removed with `git worktree remove --force .claude/worktrees/agent-ae9982f4dbfb24269 && git branch -D worktree-agent-ae9982f4dbfb24269`. Optional — harmless if left.
- **Triage cache** at `C:\temp\medcore-triage\` — disposable.

## How to resume

1. `git pull origin main` on the new machine (gets `aa3ab9e`, `68cd765`, `66c6183`).
2. Check the four PRs above — merge any that are green; investigate any that aren't.
3. Use issue [`#414`](https://github.com/Globussoft-Technologies/medcore/issues/414) as the work queue for the remaining 61 bugs. Tier 1 (#174, #202, #235/#236, #262, #241/#242, #272, #288, #180, #179) are the highest leverage.
4. The next push to `main` auto-deploys; no manual `scripts/deploy.sh` needed.
