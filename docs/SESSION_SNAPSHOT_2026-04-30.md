# Session snapshot — 2026-04-30 (cap-the-day)

End-of-day state for cross-machine resume. Read this file first on next pickup, then [`TODO.md`](../TODO.md), then go.

## State at session end

- HEAD on `main` = `41f905c` (Sprint 2 — 4 §7 dashboard scaffolds)
- Working tree clean, no unpushed commits
- **Open GitHub issues: 0**
- Auto-deploy currently **blocked by red CI** (see priority #1 in TODO.md)

## What the session shipped

| | Commit | What | Stats |
|---|---|---|---|
| Wave 1 | `41cdb32` | 10 issues — RBAC leaks + chart crashes + billing math | +2131/-227 |
| Wave 2 | `88ae5cf` | 8 issues — #174 RBAC sweep + UX polish | +2443/-142 |
| Wave 3 | `c5cf400` | 9 issues — session bleed + XSS + patient Rx + double-bed | +1626/-85 |
| Wave 4 | `34e8e79` | 26 issues — validation + UI polish | (large) |
| #213 | `ab318f0` | Doctor schedule overnight + detail page + KPI label | small |
| RBAC matrix | `fdd487e` | 63 (role × route) Playwright cases | new spec |
| e2e gate | `2f1f0ac` | Re-added Playwright (RBAC matrix only) to deploy `needs:` | workflow |
| Sprint 2 | `41f905c` | 4 dashboard scaffolds: symptom-diary, lab-intel, sentiment, ai-fraud workflow | 9 files |
| **Net** | | **~70 issues closed, 0 left** | |

Plus 4 PRs handled: #391/#412 closed-superseded, #413/#410 merged.

## Why CI is red

Two failure clusters on the latest runs:

1. **`E2E (RBAC matrix only)` — failing every run since `2f1f0ac`.**
   The new gating job has never gone green on CI. The matrix at
   `e2e/rbac-matrix.spec.ts` works locally but something's off in the CI
   environment (likely seeded fixtures or redirect-race timing).
   **Easy revert**: drop `e2e-rbac` from `deploy.needs:` in
   `.github/workflows/test.yml` to unblock auto-deploy while debugging.

2. **`API tests` — flaked on `42bd62f` only.** The prior commit (`2f1f0ac`)
   passed API tests; `42bd62f` only touched 2 web test files but API tests
   went red on it. Likely flake. Re-run from the GitHub UI; if green,
   ignore.

## Pickup checklist

1. `git pull origin main` — should fast-forward to `41f905c` cleanly.
2. Run `npm install` if package-lock changed.
3. Open [TODO.md](../TODO.md) — first item is the CI debug.
4. **Quick path back to green deploys**: revert `e2e-rbac` from the gate
   ([.github/workflows/test.yml#L155](../.github/workflows/test.yml#L155)),
   push, watch deploy fire on the next commit.
5. Once green, focus on either:
   - Fixing the RBAC matrix on CI properly (priority #3 in TODO)
   - Shipping the missing `lab-intel` list endpoints (priority #2)

## Test credentials

Full table in [docs/TESTER_PROMPT.md](TESTER_PROMPT.md). Quick reference:

| Role | Email | Password |
|---|---|---|
| ADMIN | admin@medcore.local | admin123 |
| DOCTOR | dr.sharma@medcore.local | doctor123 |
| NURSE | nurse@medcore.local | nurse123 |
| RECEPTION | reception@medcore.local | reception123 |
| LAB_TECH | labtech@medcore.local | labtech123 |
| PHARMACIST | pharmacist@medcore.local | pharmacist123 |
| PATIENT | patient1@medcore.local | patient123 |

## Local-only state

- `~/medcore-ci-key` + `.pub` — CI keypair (from earlier session)
- `.env` `GITHUB_TOKEN=ghp_…` — gitignored, **rotate at https://github.com/settings/tokens**

## Five new pages live on next deploy

Once CI is green and `41f905c` deploys:

- `/dashboard/symptom-diary` (PATIENT) — log symptoms over time
- `/dashboard/lab-intel` (DOCTOR) — critical values + baseline-deviation trends
- `/dashboard/sentiment` (ADMIN) — NPS, drivers, per-category sentiment
- `/dashboard/ai-fraud` (extended) — full resolution workflow with comments
- `/dashboard/doctors/[id]` (read-only doctor detail page)

## Deferred / known follow-ups

See [TODO.md priority list](../TODO.md). Highlights:

- Ship `GET /ai/lab-intel/{aggregates,critical,deviations}` list endpoints
  so the new lab-intel page lights up
- 9 LOW-severity security audit follow-ups from 2026-04-23
- 2 prescription-page tests still skipped (need rewrite for EntityPicker)
- `package-lock.json` Linux-vs-Windows drift root-cause investigation
