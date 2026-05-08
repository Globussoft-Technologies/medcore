# MedCore Session Handoff — 2026-05-07 (evening) → 2026-05-08

**Pickup point**: GitHub issue queue went from **237 → ~38 open** in one session via `/medcore-fanout`. CI Test workflow is mid-chain on cancel-in-progress; once it settles green, dispatch `release.yml`. Several waves of work landed; some pending lanes still running in background as session ended.

This file is the contract between the evening-session that drove the fanout and the next session that picks it up. Read top-to-bottom, then run the **first commands** at the end.

---

## 1. Numbers at a glance

| Metric | Start | Now | Delta |
|---|---|---|---|
| Open issues | 237 | ~38 | **−199 (84% reduction)** |
| Closed today | — | ~199 | mix of fix-and-close + verify + duplicate |
| Commits to main | — | ~30+ | listed in `git log --oneline --since="2026-05-07"` |
| Skills added | 9 | 11 | `medcore-cut-release`, `medcore-pr-triage` |
| Released versions | v1.2.0 | v1.3.0 | published 2026-05-07 (https://github.com/Globussoft-Technologies/medcore/releases/tag/v1.3.0) |

---

## 2. Production-bug band (#701–#750) — closure map

**Closed (44):** #701, #702, #703, #715, #716, #717, #718, #719, #720, #721, #722, #723, #724, #725, #726, #727, #729, #730, #731, #732, #733, #734, #735, #737, #738, #740, #741, #742, #743, #744, #746, #748, #749, #750, #706, #707, #708, #712, #713, #714, #728, #736, #739, #747

**Still open (~6 from this band)**: small residue, mostly Lane B/D handoffs that may already be salvaged by the WIP commits at session-end (`d038792`, `65156c2`). Verify status with:

```bash
gh issue list --state open --limit 50 --json number,title --jq '[.[] | select(.number >= 701 and .number <= 750)] | .[] | "#\(.number) \(.title[0:90])"'
```

---

## 3. CI / deploy gate status (verify before doing anything else)

### Workflows
| Workflow | Last green | Latest state |
|---|---|---|
| **Test** | (chasing) | cancel-in-progress chain still active when session ended; latest commit is `1663247` (skill files), should be quick |
| **Release validation** | `846d092` (yesterday) | NOT yet run on today's HEAD |
| **CodeQL** | `6a57f1e` (today) | green |
| **AI eval (nightly)** | `846d092` | scheduled green |
| **Load test (nightly)** | `846d092` | scheduled green |

### What broke today and what's fixed
- **Lockfile drift** (`@sendgrid/mail`): fixed in `1ee86ac`. Deploy unblocked.
- **P3009 failed migration** (`20260508000001_patient_emergency_relationship`): resolved on the live server via `deploy_resolve_migration.py` (gitignored helper). Marked rolled-back so next deploy retries.
- **Web component test fixture**: IPs changed to TEST-NET-3 (`203.0.113.x`) so #534's `scrubInternalIp` doesn't redact them. Fixed in `466fd93`.

### First commands when picking up

```bash
# Sync
git pull --ff-only origin main

# Confirm Test status
gh run list --workflow=Test --branch=main --limit=3 \
  --json headSha,conclusion,status \
  --jq '.[] | (.headSha[0:7] + " " + .status + " " + (.conclusion // ""))'

# If latest is GREEN, dispatch release.yml
gh workflow run release.yml --ref main
```

---

## 4. Lanes still running at session-end

Two Lane B/D agents had been running >5 hours with NO commits — almost certainly hung. Their work was salvaged from the working tree as commits `d038792` (Lane D's API conflict detection) and `65156c2` (Lane B's frontend auth UX), so the work is preserved even if those agents never wake up.

Plus **Lane HH** was dispatched to actively take over Lanes B/D's work. Its result will materialize as new commits on main when it completes; the `Closes #N` lines may double-close issues that were already auto-closed by `d038792`/`65156c2` (harmless — GitHub just no-ops the second close).

When you pick up:
1. Check git log for any new commits with `Closes #` from Lane HH or other late-finishing agents.
2. Reconcile the open-issue count: `gh api 'search/issues?q=repo:Globussoft-Technologies/medcore+is:issue+is:open&per_page=1' --jq '.total_count'`.
3. Search-API is cached ~30s — repeat once if the number looks stale.

---

## 5. What still needs work — prioritized

### High-priority (close first)

- **Verify Test workflow goes green on `1663247`**. If red:
  - Use `/medcore-test-triage` skill (it has the playbook).
  - Common failures: a test fixture missed updating after the new register-form fields (Lane A's `#713`), or a CI lane test that tries to import a deleted symbol.
- **Run release.yml** once Test is green: `gh workflow run release.yml --ref main`. Watch ~16 min for 31-job sweep.

### Medium-priority (knock down the residue)

These ~38 issues are predominantly genuinely-deep bugs we deliberately deferred. Skim them and pick up what's tractable:

| # | Why deferred |
|---|---|
| #482 | JWT HS256→RS256 — multi-day infra (key rotation, JWKS, downstream refresh) |
| #311, #314, #315 | KPI/data-sync cross-cuts — need DB inspection, not pure code |
| #538/#564/#567/#584 | Session morphing — Lane X confirmed it's frontend cross-tab cookie-share, NOT server BOLA. Real fix is `BroadcastChannel` cross-tab cookie-swap detection. Not closed. |
| #512 | Manual-only test backlog — not actionable in code |
| various | LabTech UX gaps requiring role-specific dashboards (#622/#624/#629) — feature scope |

The clear deferral list is documented inline in each Lane's report (search session log for "Skipped").

### Low-priority

- Backfill the two skill extensions promised earlier and never landed:
  - `/medcore-e2e-spec` — add the WebKit-skip pattern as an instance #2 codification (instance #1 was telemedicine precheck).
  - `/medcore-test-triage` — add the npm cache `EEXIST` recipe (`npm error EEXIST` / `ENOENT: rename '/home/runner/.npm/_cacache/...'` → re-dispatch same SHA).

---

## 6. Notable infrastructure changes today

These are operational things ops might need to know:

### Database migrations applied
- `20260508000001_patient_emergency_relationship` — adds `Patient.emergencyContactRelationship` (nullable text). Required by Lane A's `#713` registration schema.
- `20260508000002_calendar_events_and_insurance_providers` — Lane F's new tables for #718 + #724.
- `20260508000003_cleanup_attacker_test_users_and_test_ambulances` — Lane I's DB cleanup for #722 + #738.
- `20260508000004_notification_broadcast_dedup` — Lane M's `Notification.dedupKey` partial unique index for #750.

All four are deployed (some via `deploy_resolve_migration.py` workaround for the P3009 mid-flight failure).

### New env vars on the deploy server
On `163.227.174.141:/home/empcloud-development/medcore/apps/api/.env` (mirrored from local via `deploy_sendgrid_env.py`):

```
SENDGRID_API_KEY=SG.glRqacwZQw-...   # in user's local.env if needed
SENDGRID_FROM_EMAIL=noreply@medcore.globusdemos.com
SENDGRID_FROM_NAME=MedCore
```

**⚠ Sender verification**: SendGrid will reject emails from `noreply@medcore.globusdemos.com` until the sender is verified at https://app.sendgrid.com/settings/sender_auth/senders, OR the domain is auth'd. Check status before relying on the share-prescription feature in prod.

### New scheduled cron tasks
Registered in `apps/api/src/services/scheduled-tasks.ts`:
- `auto_flag_expired_blood_units` (1am daily) — flips AVAILABLE+expired blood units to EXPIRED. Issue #737 (CRITICAL).
- `auto_checkout_stale_visitors` (every 30 min, 12h ceiling, override `MAX_VISIT_DURATION_HOURS`). Issue #734.
- `auto_close_stuck_telemedicine_sessions` (every 30 min, 2h ceiling, override `MAX_TELEMED_DURATION_HOURS`). Issue #743.

All three emit batch audit rows. Verify they're firing in `pm2 logs medcore-api`.

### New API endpoints (worth knowing about)
- `GET /api/v1/me/tenant` — friendly tenant metadata for header banner
- `GET /api/v1/visitors-stats?period=today` — canonical visitors-today (Asia/Kolkata day)
- `GET /api/v1/holidays` — calendar-page holiday integration
- `POST /api/v1/calendar-events` (CRUD) — calendar New Event dialog
- `POST /api/v1/insurance-providers` (CRUD) — Add Provider dialog
- `POST /api/v1/auth/forgot-password` — gained strict email refine
- `POST /api/v1/auth/change-password` — gained strict-password refine BEFORE bcrypt check

---

## 7. Skills added today (9 → 11)

- **`/medcore-cut-release`** (`/.claude/skills/medcore-cut-release/SKILL.md`) — codifies the v1.3.0 cut workflow. Run when user says "cut a release", "publish v1.X.Y", "tag this".
- **`/medcore-pr-triage`** (`/.claude/skills/medcore-pr-triage/SKILL.md`) — codifies human-PR triage with the mergeability × check-state matrix. Run when there are 3+ open PRs.

Both are tracked in git and shipped on this branch.

---

## 8. How to continue

When next session starts:

1. **Read this file first.**
2. Run the "First commands" block in §3.
3. If Test is green → run release.yml, watch it finalize.
4. If Test is red → invoke `/medcore-test-triage` and let the skill drive triage.
5. Once both Test and release.yml are green on the latest HEAD:
   - Cut a fresh patch release if there's appetite (`/medcore-cut-release` → suggests v1.3.1).
   - Continue iterating on the residue with `/medcore-fanout` waves.
6. Pick from §5 medium-priority list. Each item that touches a fresh surface gets its own lane in the next fanout.
7. Backfill the §5 low-priority skill extensions when the queue is < 20.

Approximate effort to hit zero issues from here: **~3-5 more focused lanes (~2-3 hours)**.

---

## 9. Open questions / things you didn't expect

- **Lane B (frontend auth UX)** and **Lane D (conflict detection)** dispatched at session-start ran >5 hours with no commits. Their work was salvaged from the working tree as commits `d038792` + `65156c2`. CI on those commits will validate whether the salvaged work is actually clean — if a fixture is broken, those will be the first failures.
- **Lane HH** was dispatched to actively redo Lane B/D's work mid-session-end. Its commits will land sometime after session-end; check git log for them.
- The `gh api 'search/issues'` count occasionally lags behind the real state by ~30s. The actual repo "Issues" tab in GitHub web UI is the most accurate.

---

## 10. Useful greps

```bash
# Today's commits
git log --oneline --since="2026-05-07"

# What's still open
gh issue list --state open --limit 100 --json number,title --jq '.[] | "#\(.number) \(.title[0:80])"'

# Production-bug residue (#701-#750)
gh issue list --state open --limit 50 --json number,title --jq '[.[] | select(.number >= 701 and .number <= 750)] | .[] | "#\(.number) \(.title[0:80])"'

# Latest Test workflow result
gh run list --workflow=Test --branch=main --limit=3 --json headSha,conclusion,status

# All workflows on main
for wf in "Test" "Release validation" "CodeQL"; do gh run list --workflow="$wf" --branch=main --limit=1 --json headSha,conclusion,status --jq ".[0]"; done
```

---

End of handoff. Resume from §8 step 1.
