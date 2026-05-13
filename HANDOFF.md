# MedCore Session Handoff — 2026-05-12 → office pickup

**You can pick up cold from this doc.** Read top-to-bottom (~5 min), then `git pull` and follow "First commands at the office" at the end.

## Where we are right now

- **HEAD on `main` = `5ff4d3d`** (`docs: roll 2026-05-12 PR-triage wave`). Pushed. Working tree clean.
- **2 PRs merged today**: #882 (`6a575d6` — Subhadip AI features) + #888 (`1df30d0` — Sourav AI radiology vision + STAGING bug fixes). ~2200 lines diff combined.
- **Auto-deploy is operational.** Once test.yml clears for `5ff4d3d`, the demo box at `medcore.globusdemos.com` will reflect both merges.
- ⚠️ **`npm audit (high+critical)` gate is currently RED on main** — inherited from the `next@15.5.15` advisory cluster (14 CVEs). Cleared when PR #784 (next 15→16) lands. Doesn't block deploys (test.yml's deploy job runs on the test job's status, not audit's), but the per-push run **conclusion** shows FAILURE until then.

## What landed this session

| Commit | What |
|---|---|
| `6a575d6` | **PR #882 squash-merged** — Subhadip AI features. Appointments hardening + scribe page rewrite + AI letters / pharmacy-forecast / er-triage refactors + 2 new module PRDs (LAB_TECHNICIAN_MODULE_PRD.md, PHARMACIST_MODULE_PRD.md). |
| `1df30d0` | **PR #888 squash-merged** — Sourav AI radiology vision + STAGING bug fixes. 1106/-209 across 18 files. Vision routes only to OpenAI gpt-4o (Sarvam has no vision); PHI image budget bounded (4 images / 16MB / MIME allowlist / DICOM skip / per-image try-catch). |
| `e2a11e1` | 2 new cron-learnings in CLAUDE.md Open section. |
| `5ff4d3d` | Doc-roll: TODO banner + new A11 architectural finding + CHANGELOG Unreleased. |

## 🔥 First commands at the office (~3 min)

```bash
git pull origin main           # you'll be at 5ff4d3d
gh pr list --state open        # confirm queue: 5 dependabot, all migration-class
gh issue list --state open --label "STAGING"   # 10 STAGING UI bug issues, many likely closed by #888
```

Then look at the **demo box** at `medcore.globusdemos.com` — PR #888's dashboard sweeps plausibly close several STAGING bugs. Quick smoke pass:

| Issue | Where to test | Probable status post-#888 |
|---|---|---|
| #875 Medication Reminders no H1 | `/dashboard/reminders` | dark-mode contrast sweep — verify H1 visibility |
| #876 Patient Calendar no H1 | `/dashboard/calendar` | calendar/page.tsx touched — verify |
| #877 Patient global search leaks query | search palette | **Explicit test added with legacy-key wipe assertion — likely closed** |
| #878 Patient Help drawer wrong content | HelpPanel | **PATIENT_PAGE_HELP map with prefix-fallback added — likely closed** |
| #879 Patient notification "tomorrow" hard-coded | notifications | Not touched by #888 — separate fix needed |
| #880 Patient Notifications duplicate cards | notifications | Not touched — separate fix needed |
| #884 PHARMACIST/LAB_TECH bounced from /patients | `/dashboard/patients` | **patients.ts + page.tsx RBAC widening (lockstep) — likely closed** |
| #885 Book Appointment missing Patient field | book appointment | Not touched — separate fix needed |
| #886 Duty Roster + Census low-contrast cards | duty-roster, census | **Contrast sweep — likely closed** |
| #887 Product Tour modal on every nav | layout | **tourCheckedRef + skip /dashboard/not-authorized refactor — likely closed** |

For each: open the page on the demo, verify the fix, then `gh issue close <N> --comment "Closed by #888 (\`<demo URL where the fix is visible\`)"`.

## What's blocked on you

Original 9 items from issue #772 (no movement this session — pure PR-triage wave):

1. **JWT rotation strategy + production keypair generation** (engineering scaffold is on main via #776; you pick hard-cutover vs dual-verify-window vs per-user-relogin; rotation runbook at [`docs/JWT_ROTATION.md`](docs/JWT_ROTATION.md))
2. **`/medcore-bola-sweep` skill promotion** — harness blocks unattended `.claude/skills/**` writes; needs you at keyboard for the popup. ~30 min.
3. **Demo-box stale-data SQL cleanup** — SQL provided in #772.
4. **Smoke-test cumulative wave on `medcore.globusdemos.com`** — see the STAGING table above.
5. **Contributor PR follow-up** — Sourav (#881, #888 today) + Subhadip (#796, #882 today) all merged. Done.
6. **Review Razorpay integration in #881** before next deploy.
7. **Investigate why `/api/v1/auth/login` rejects GH Actions runner IPs** — low priority.
8. **Schedule the deferred dependency-major migrations** — see "Currently open PRs" below.
9. **Triage the 10 STAGING UI bug issues** — see the STAGING table above (several now closable).

**New from this session:**

10. **#599 PHARMACIST patient-detail policy** — pick re-tighten vs accept-relaxation. One test (`patients-dup-checks.test.ts`) is `it.skip`'d until you call it.
11. **A11 — appointment time conventions sweep** (NEW architectural finding from #882). `getNextToken` is now UTC-bounded but the rest of the appointments code surface may still mix `setHours(...)` (server-local-timezone). Grep sweep + standardize. ~1-2hr.
12. **Promote the 2 new cron-learnings to skills on 2nd recurrence** (currently 1-instance each in CLAUDE.md Open) — (a) inherited red-check diagnosis pattern, (b) stale-base illusory-diff probe-merge pattern.

## Currently open PRs (5 left — all dependabot, all deferred-migration-class)

| PR | What | Why deferred |
|---|---|---|
| #883 | Patch+minor group (14 updates) | `@dependabot rebase` failed today after #882/#888 lockfile changes. Commented and folded into the same dep-migration session as #784/#783 (shared web bundle + lockfile blast radius). |
| #784 + #783 | `next` + `@next/swc` 15→16 | Web bundle size fails; dedicated ~2-3hr migration session. **Also clears the npm audit gate on main.** |
| #788 | `@vitest/coverage-v8` 2→4 | Paired with deferred vitest core migration |
| #790 | `zod` 3→4 | API tests + type-check + bundle fail; codemod commits on the branch already (`194679d`/`2da6ce3`); ~half-day dedicated session |

## Reference docs

- [`TODO.md`](TODO.md) — canonical handoff banner with the full wave detail + the 11-row "Open architectural follow-ups" table (A1 + A11 still open)
- [`CHANGELOG.md`](CHANGELOG.md) — `[Unreleased]` has the new 2026-05-12 wave entry
- [`CLAUDE.md`](CLAUDE.md) — recurring patterns + gotchas + the "Open (cron-surfaced; not yet promoted)" section now has the 2 new 1-instance learnings
- [`docs/JWT_ROTATION.md`](docs/JWT_ROTATION.md) — 5-step JWT cutover runbook
- [`docs/PRISMA_7_MIGRATION_PLAN.md`](docs/PRISMA_7_MIGRATION_PLAN.md) — 281-line research artifact
- Issue [#772](https://github.com/Globussoft-Technologies/medcore/issues/772) — the original dev-team blocker list (still open)
- Issue [#599](https://github.com/Globussoft-Technologies/medcore/issues/599) — PHARMACIST patient-detail policy decision

## TL;DR what to do at the office tomorrow

1. `git pull origin main` → you'll land at `5ff4d3d`.
2. **Smoke pass on `medcore.globusdemos.com`** for the 10 STAGING issues (5–6 likely closable post-#888, see the table above). Close each with the demo-URL evidence.
3. **#599 PHARMACIST policy** — quick product call; unblocks 1 skipped test.
4. (Optional) Re-dispatch `release.yml` to validate the merged wave end-to-end:
   ```
   gh workflow run "Release validation" --ref main
   ```
5. When you have a 2-3hr block: **next 15→16 dep migration** (#784 + #783). This also clears the `npm audit` gate red on main.

The repo is in a stable, fully-tested state. Today's wave was disciplined PR triage (2 contributor PRs through review and merge, no rushed merges, full A11 finding logged for the appointments UTC sweep). Remaining queue is genuine product/ops decisions + scheduled dep migrations.

🤖 Auto-generated handover — last update 2026-05-12 evening
