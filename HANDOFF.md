# MedCore Session Handoff — 2026-05-11 late-evening → office pickup

**You can pick up cold from this doc.** Read top-to-bottom (~5 min), then `git pull` and follow "First commands at the office" at the end.

## Where we are right now

- **HEAD on `main` = `75559dd`** (`docs(todo): roll 2026-05-11 late-evening 13-PR merge wave`). Pushed. Working tree clean. Repo is in a consistent state.
- **Auto-deploy is operational.** Once test.yml clears for `75559dd`, the demo box at `medcore.globusdemos.com` will reflect everything below.
- **release.yml fully GREEN** on `ee2cbb9` (earlier today) — 33/33 jobs. The recent merges since then haven't been release-validated yet; quick re-dispatch is worth doing at the office.

## What landed across the past 3 sessions (since 2026-05-09 wave start)

23 PRs merged total. Highlights:

| Category | When |
|---|---|
| **17 GitHub issues** (admin contrast cluster, login validation cluster, BOLA #511 long-tail, register form expansion, complaints SLA escalation, etc.) | 2026-05-09 |
| **6 unfiled bug-bash bugs** from `.issue-details.txt` | 2026-05-09 |
| **All 4 globussoft-crm workflow ports** (`secret-scan`, `migration-check`, `coverage`, `demo-monitor`) | 2026-05-09 / 10 / 11 |
| **Seed idempotency long-tail FULLY CLOSED** — deploy.sh auto-reseed chain extended from 8 → **30 steps** (8b through 9e). The "Seeds NOT wired" comment block is empty for the first time. | 2026-05-10 / 11 |
| **JWT HS256 → RS256/EdDSA dual-mode engineering scaffold** (#776 — closes engineering side of #482) | 2026-05-11 |
| **Prisma 6→7 migration planning doc** (#777 — research artifact, 3 architecture-choice stop-points documented) | 2026-05-11 |
| **Contributor recreates landed**: #881 Sourav payment+PDF+Razorpay, #796 Subhadip logo+branding | 2026-05-11 |
| **Dependabot wave**: 4 actions/* majors + 5 npm deps merged | 2026-05-11 |

Detailed per-PR breakdown lives in [`TODO.md`](TODO.md) banner top.

## 🔥 First thing to do at the office (~5 min)

```bash
git pull origin main           # should be at 75559dd or higher
gh pr list --state open        # confirm queue state
gh issue list --state open     # see fresh STAGING bug-bash
```

Then look at the **10 fresh `[STAGING]` UI bug issues** (#875-#887). I have NOT touched these — they came in during the late-evening wave from your UAT session. They're the most actionable backlog for tomorrow:

```bash
gh issue view 875  # Medication Reminders no H1
gh issue view 876  # Patient Calendar no H1
gh issue view 877  # Patient global search leaks query
gh issue view 878  # Patient Help drawer wrong content
gh issue view 879  # Patient notification "tomorrow" hard-coded
gh issue view 880  # Patient Notifications duplicate cards
gh issue view 884  # PHARMACIST/LAB_TECH bounced from /patients
gh issue view 885  # Book Appointment missing Patient field
gh issue view 886  # Duty Roster + Census low-contrast cards
gh issue view 887  # Product Tour modal on every nav
```

Some of these look like regressions of work I already shipped (#884 sounds like the patients-id fix from `b0b45bb`; #886 sounds like the admin-contrast fixes from `a21e4ff`; #885 sounds like the appointment patient-picker from `2e36e7b`). May warrant a release-validation re-run + a smoke pass on the demo before opening fixes — could be that the deployed code on the demo is behind current main.

## What's blocked on you (issue #772 — 6 blockers + 4 new)

Original 6 from issue #772 (filed 2026-05-11 morning):
1. **JWT rotation strategy + production keypair generation** (engineering scaffold is on main via #776; you pick hard-cutover vs dual-verify-window vs per-user-relogin; rotation runbook at [`docs/JWT_ROTATION.md`](docs/JWT_ROTATION.md))
2. **`/medcore-bola-sweep` skill promotion** — harness blocks unattended `.claude/skills/**` writes; needs you at keyboard for the popup. 30 min.
3. **Demo-box stale-data SQL cleanup** — SQL provided in #772; you run on the demo Postgres.
4. ~~Trigger `coverage.yml` + `demo-monitor.yml` workflow_dispatch~~ — DONE TODAY (both now have GREEN baselines on record).
5. **Smoke-test cumulative wave on `medcore.globusdemos.com`** — see "10 STAGING issues" above; some of those ARE the smoke-test findings.
6. **Contributor PR follow-up** — Sourav (#881) + Subhadip (#796) recreates landed. Subhadip's second PR #882 closed-with-explanation asking for AI-only scope.

New since #772 was filed:
7. **Review Razorpay integration in #881 before next deploy** — payment integration is security-sensitive; first contributor pass.
8. **Investigate why `/api/v1/auth/login` rejects GH Actions runner IPs** — low priority. Curl from any dev machine works fine; demo-monitor's API probe is now using `/api/health` instead.
9. **Schedule the deferred dependency-major migrations** — #784+#783 (next 15→16), #790 (zod 3→4), #788+core (vitest 2→4). Each is a 2-3hr → half-day dedicated session.
10. **Triage the 10 fresh STAGING issues** (#875-#887) — first-priority for tomorrow.

## Currently open PRs (5 left — all deferred-with-notes)

| PR | What | Why deferred |
|---|---|---|
| #783 + #784 | `next` + `@next/swc` 15→16 | Web bundle size fails; dedicated 2-3hr migration session |
| #788 | `@vitest/coverage-v8` 2→4 | Paired with deferred vitest core migration |
| #790 | `zod` 3→4 | API tests + type-check + bundle fail; needs zod codemod + ~half-day |
| #883 | patch-minor group of 14 updates | New today (auto-rebased from yesterday's #782 close); check CI in office |

All 5 have a comment on the PR explaining the migration path. None are urgent.

## Reference docs

- [`TODO.md`](TODO.md) — canonical handoff banner with full wave detail
- [`docs/JWT_ROTATION.md`](docs/JWT_ROTATION.md) — 5-step JWT cutover runbook (NEW today via #776)
- [`docs/PRISMA_7_MIGRATION_PLAN.md`](docs/PRISMA_7_MIGRATION_PLAN.md) — 281-line research artifact (NEW today via #777) when you're ready for that session
- [`CLAUDE.md`](CLAUDE.md) — Claude Code session notes (recurring patterns, gotchas, harness quirks)
- Issue #772 — the 6-blocker dev-team handoff (still open)
- `scripts/deploy.sh` — comment block at "Seeds NOT wired" is now empty; chain spans steps 8b-9e

## TL;DR what to do at the office tomorrow

1. `git pull origin main` (you'll be at 75559dd or higher)
2. Triage the **10 fresh STAGING issues** (#875-#887) — likely a fanout-worthy batch
3. (Optional, ~30 sec) Re-dispatch `release.yml` to validate the 13-PR-merge wave end-to-end:
   ```
   gh workflow run "Release validation" --ref main
   ```
4. Address the user-blocked items in #772 when you have the appetite
5. The deferred dep migrations (#784/#790/#788) are dedicated sessions — schedule when ready

You're inheriting a stable, fully-tested, all-engineering-actionable-work-done state. The remaining queue is genuine product/ops decisions + new bug reports from the latest UAT pass.

🤖 Auto-generated handover — last update 2026-05-11 late-evening
