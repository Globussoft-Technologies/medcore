---
name: medcore-release
description: Dispatch the MedCore release.yml validation workflow on origin/main, watch the run to completion, and on failure surface the exact failing tests + the first ~100 log lines so the next investigation step is obvious. Use when the user says "kick off release.yml", "validate this push", "run the e2e suite", "release-validate", "check if WebKit holds", or wants the full Playwright + integration suite to run on the current SHA. Replaces the manual `gh workflow run` + `gh run view` + `--log-failed | grep` ritual.
---

# medcore-release

The codified release.yml validate-and-diagnose loop. Dispatches the workflow, blocks on completion (~25-40 min for full Playwright + WebKit + API tests), and returns a structured report.

## When to invoke

- User asks for an explicit release validation: "kick off release.yml", "validate", "run the full e2e suite".
- After landing a fix that needs end-to-end verification (e.g. WebKit auth-race fix, schema migration, big route handler change).
- After a parallel-fanout batch lands several E2E specs at once and you want to confirm nothing regressed.

Do NOT invoke when:
- The user just pushed a small doc change. Per-push CI gates auto-deploy already.
- A release.yml run is already in flight on the same SHA — check first with `gh run list`.
- The user wants nightly AI eval / load test — those are different workflows (`AI eval (nightly)`, `Load test (nightly)`).

## Workflow

### 1. Confirm the target SHA

```bash
git -C "<repo root>" log --oneline -1 origin/main
```

Report what's about to be validated (commit SHA + title) so the user can abort if they meant a different commit.

### 2. Check for in-flight runs on the same SHA

```bash
gh run list --repo Globussoft-Technologies/medcore --workflow="Release validation" --limit 5 \
  --json databaseId,headSha,conclusion,status,createdAt \
  --jq '.[] | "\(.databaseId) | \(.headSha[:8]) | \(.conclusion // .status) | \(.createdAt)"'
```

If the latest run is on the current SHA and status is `in_progress` or `queued`, surface the existing run-id and ask the user whether to wait on it or dispatch a fresh one. Don't dispatch a duplicate.

### 3. Dispatch

```bash
gh workflow run "Release validation" --repo Globussoft-Technologies/medcore --ref main
```

The command prints a URL like `https://github.com/Globussoft-Technologies/medcore/actions/runs/<id>`. Capture the run-id.

If the URL isn't returned, fetch it:
```bash
sleep 3
gh run list --repo Globussoft-Technologies/medcore --workflow="Release validation" --limit 1 \
  --json databaseId,headSha --jq '.[0]'
```

Verify the `headSha` matches the SHA you intended (not a stale newer push).

### 4. Watch to completion

```bash
gh run watch <run-id> --repo Globussoft-Technologies/medcore --exit-status
```

`--exit-status` means the command exits non-zero if the run failed. Block on this. Estimated wall-clock: 25-40 min for the full release.yml suite.

If the user is impatient and asks for a status check before completion:
```bash
gh run view <run-id> --repo Globussoft-Technologies/medcore \
  --json status,conclusion,jobs \
  --jq '{status, conclusion, jobs: [.jobs[] | {name, conclusion, status}]}'
```

### 5. On success — report briefly and stop

```
✅ release.yml run <id> on <sha-8>: GREEN (<elapsed>min, all 6 jobs passed)
```

Note any flaky-looking jobs (jobs with retries, slow durations) for the user's situational awareness.

### 6. On failure — diagnose

Get the per-job summary:

```bash
gh run view <run-id> --repo Globussoft-Technologies/medcore --json jobs \
  --jq '.jobs[] | "\(.name) | \(.conclusion // "in_progress")"'
```

For each `failure` job, pull the failed-job logs and isolate the failing tests:

```bash
gh run view <run-id> --repo Globussoft-Technologies/medcore --log-failed 2>&1 | \
  grep -E "FAIL\s|Test Files .*failed|AssertionError|Error:|✗|✘" | head -40
```

For specific test failure context (Vitest):
```bash
gh run view <run-id> --repo Globussoft-Technologies/medcore --log-failed 2>&1 | \
  grep -A 8 "FAIL.*\.test\.ts" | head -100
```

For Playwright failures:
```bash
gh run view <run-id> --repo Globussoft-Technologies/medcore --log-failed 2>&1 | \
  grep -E "›|Error:|TimeoutError|Expected" | head -50
```

### 7. Triage report

Single message back to the user:

```
🔴 release.yml run <id> on <sha-8>: FAILED

Failed jobs:
  - <job-name>: <one-line: which test, which assertion>
  - <job-name>: <one-line>

Suspected category:
  [ ] Flake (no relevant code change since last green; rerun to confirm)
  [ ] Real regression in <commit-sha> (<commit-title>)
  [ ] Environment / infra (CI-only path, integration timing, etc.)

Next steps:
  1. Local repro: <exact command — e.g. `cd apps/api && npx vitest run src/test/integration/<x>.test.ts`>
  2. If flake: rerun via /medcore-release (or `gh workflow run "Release validation" --ref main`).
  3. If regression: <which file to git log -p; which sibling test to read>
```

Use the same structure for the full audit — see how the audit-phi flake was diagnosed in `docs/archive/SESSION_SNAPSHOT_2026-05-04.md` "Critical follow-ups status" for the in-repo reference.

## Recognizing flakes

If the same test failed on a prior release.yml run and passed on a rerun without code change in the relevant area, it's almost certainly a flake. Cross-reference with the archived session snapshots — known flakes:

- `audit-phi.test.ts > writes AI_SCRIBE_READ audit on GET /ai/scribe/:sessionId/soap` — confirmed flake on 2026-05-03 → 2026-05-04 rerun.

If a test newly fails AND there's no relevant code change: lean flake, suggest one rerun. If it fails again on rerun: lean regression.

## Common known-failures and their quick diagnoses

| Symptom | Likely cause | First check |
|---|---|---|
| WebKit-only failures on `/login` redirect / `/auth/me` | Auth-race regression | Was a new `page.goto("/dashboard/X")` added in test bodies without `gotoAuthed` helper? See `eb40604` |
| Visual regression diff on a single spec | Non-deterministic render (date / animation / font fallback) | Pin `Date.now()`, disable animations |
| Single integration test failing intermittently | Shared-state pollution between tests | Check `singleFork: true` in vitest config; inspect `beforeEach` cleanup |
| `next build` exits non-zero with no error | Missing `apps/web/node_modules/eslint` | `npm install` from repo root |

## Anti-patterns

- **Don't dispatch release.yml as part of a fanout.** It's a single coordination action, not parallel work.
- **Don't ignore an in-flight run on the same SHA.** Dispatching a duplicate wastes 25-40 min of CI minutes.
- **Don't assume green per-push CI means release.yml will be green.** release.yml runs the full Playwright suite + WebKit; per-push CI doesn't. The audit-phi flake from 2026-05-03 is the cautionary tale.
- **Don't dispatch on a stale checkout.** Pull first to confirm what's on origin/main, then dispatch.

## Composability

`/medcore-release` is the natural follow-up to:
- `/medcore-fanout` (after a parallel batch lands several specs/fixes)
- `/medcore-e2e-spec` (after a single new spec lands and you want to confirm it passes on Linux + WebKit)
- Any source fix that touches a route handler, schema, or middleware path

It pairs with (TBD) `/medcore-diagnose-flake` for deeper post-failure triage.
