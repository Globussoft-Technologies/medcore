# MedCore — TODO

Next-session priority list. Full per-issue history lives in
[`docs/SESSION_SNAPSHOT_2026-04-30.md`](docs/SESSION_SNAPSHOT_2026-04-30.md)
and the evening continuation in
[`docs/SESSION_SNAPSHOT_2026-04-30-evening.md`](docs/SESSION_SNAPSHOT_2026-04-30-evening.md);
this file is the short, actionable checklist.

> Updated: 2026-05-01 — RBAC matrix reconciled and green on main.
> HEAD on `main` = `fbf1145` (rbac universal-access dashboard prefix fix).
> **Open GitHub issues: 0.** **Auto-deploy: unblocked.**

---

## ⏭️ Pickup-from-home priority list

When you sit down at home, this is the order. Each item is independently
shippable.

### 1. ~~Re-gate `e2e-rbac`~~ ✅ done 2026-05-01

Matrix reconciled by `f7514fc` (seed LAB_TECH+PHARMACIST), `73bfb32`
(ai-route 400-shape alignment), `fbf1145` (dashboard-prefix match).
`e2e-rbac` re-added to `deploy.needs:` — gate is now
`[test, web-tests, typecheck, e2e-rbac]`.

### 2. Step 2 — Migrate Postgres off Docker (deferred from yesterday)

User asked for this; deferred until non-CI work was clear. Native
PostgreSQL 16.13 is already installed and online on the dev server
(127.0.0.1:5432) — currently empty; the Docker container `medcore-postgres`
on `:5433` holds the production data. Migration outline:

1. `pg_dump` from `:5433/medcore` → `dump.sql`
2. Create `medcore` role + db in native (`:5432`) with same credentials
3. `psql` restore the dump
4. Update `/home/empcloud-development/medcore/.env` `DATABASE_URL`: `5433` → `5432`
5. Update `scripts/deploy.sh` constant `DB_URL`: `5433` → `5432`
6. PM2 restart, verify `/api/health`
7. `docker stop medcore-postgres && docker rm medcore-postgres`
8. Update DEPLOY.md to remove all Docker references

Needs the dev-server sudo password for `pg_hba.conf` edits and any
postgres-superuser flow.

### 3. Remaining LOW security follow-ups (parallel-friendly)

The 5 zod-validation gaps closed in `9dc1913`. Remaining:

- **F-ABDM-1** — `POST /gateway/callback` has no rate limit
- **F-INJ-1** — extend `services/ai/prompt-safety.ts` sanitiser to
  `routes/ai-er-triage.ts`, `ai-letters.ts`, `ai-chart-search.ts`,
  `ai-report-explainer.ts`
- **AI-inference audit rows** missing on 7 routes:
  F-ADH-3 (POST /enroll), F-ER-3, F-KB-2, F-LET-2, F-PH-*, F-PRED-1,
  F-REX-3, F-TX-1

All independent — could be 2-3 parallel agents.

### 4. Release-validation workflow (✅ shipped 2026-05-01)

Per-push CI stays fast (typecheck + api unit/contract/smoke/integration +
web vitest + RBAC matrix only). The full Playwright suite is gated to a
**release** trigger:

- Workflow: [`.github/workflows/release.yml`](.github/workflows/release.yml)
- Trigger: `gh workflow run release.yml --ref main` (or Actions UI →
  "Release validation" → Run workflow)
- Runs: typecheck + full api-tests + full web-tests + **all 22 Playwright
  specs** + a summary job that succeeds only if all four gates are green.
- `playwright.config.ts` now bumps `workers: 2` and `retries: 1` under
  `CI` to absorb transient flake without hiding real failures.
- Per-push `e2e-rbac` job in `test.yml` is unchanged — still runs on
  every push as the fast canary.

When user says "do a release":
1. Trigger `release.yml` on the current `main` SHA.
2. If green → safe to declare release.
3. If red → fix on `main`, push, retrigger.

First release-validation run will likely surface known pre-existing flake
(notably the `/dashboard/admin-console` axe-core violation in
`a11y.spec.ts`). Fix as encountered; the model is fix-then-retry, not
"merge red".

### 4b. Zero-coverage API routes (12 routes — write tests)

Found by diffing `apps/api/src/routes/*.ts` against `*.test.ts` in both
`apps/api/src/routes/` (co-located) and `apps/api/src/test/integration/`.
These have no test file matching their name:

```
controlled-substances    growth              payment-plans     shifts
coordinated-visits       med-reconciliation  preauth           waitlist
feedback                 nurse-rounds        scheduled-reports search
```

Some are likely small wrappers; others (controlled-substances,
nurse-rounds, scheduled-reports) probably have real branching logic.
Tackle as a parallel-agent sweep — one agent per ~3 routes, each writes
an integration test file under `apps/api/src/test/integration/<route>.test.ts`
covering happy path + auth + at least one edge case per handler. ~1-2 hr
total.

### 5. Deferred housekeeping

- **Two prescription-page tests** in `prescriptions.page.test.tsx`
  remain skipped — they probed the old raw-UUID inputs replaced by
  `<EntityPicker>` in #120. ~30 min to write fresh tests against the
  picker dropdown.
- **`apps/api/src/app.ts` global `/auth/*` 30/min limiter** — outermost
  ceiling that occasionally bites demos. Per-route caps from #124 stack
  inside it. If demos continue to hit it, raise the global cap (one-line,
  needs user say-so).
- ~~**`package-lock.json` drift on prod**~~ — investigated 2026-05-01 and
  closed as not-a-bug. The drift is cosmetic npm-internal optional-deps
  reshuffling between Windows-dev and Linux-prod, not a functional issue
  (`npm ci` produces correct `node_modules` regardless). The two existing
  pre-clean band-aids ([scripts/deploy.sh:48](scripts/deploy.sh#L48) and
  [.github/workflows/test.yml:331](.github/workflows/test.yml#L331)) are
  the correct fix for this codebase shape (Windows devs + Linux server +
  cross-platform optional deps). The CI `test` job uses `npm install`
  rather than `npm ci`, so drift never trips a build either. Real-fix
  paths (npm bump everywhere, `overrides` lock, GHA-canonicalize-lockfile
  workflow) all have worse ROI than the band-aid.
- **`TenantConfig` first-class table** — the per-tenant `SystemConfig`
  key-prefix scheme works; replace with a dedicated `TenantConfig` table
  in the next schema-churn window.

### 6. Acoustic diarization re-evaluation

Was previously available via AssemblyAI; removed on 2026-04-25 (PRD §3.8 /
§4.8 data residency). Re-evaluate when an India-region diarizing provider
appears, gated behind `DEPLOYMENT_REGION`.

---

## What landed 2026-04-30 evening (second pickup)

Five commits closing the day:

| Commit | What | Why |
|---|---|---|
| `fbb8b8a` | `ci(e2e-rbac): install devDependencies despite NODE_ENV=production` | First e2e-rbac infra blocker — `npm install` skipped devDeps under `NODE_ENV=production`, breaking turbo. |
| `6efbc64` | `ci(e2e-rbac): scope PORT per-process so API and Web don't fight over 4000` | Second blocker — job-level `PORT=4000` made `next start` and Express both bind 4000. Now scoped per-step. |
| `968b8a3` | `ci(deploy): drop e2e-rbac from gate while spec-vs-app drift is reconciled` | Third "blocker" was real RBAC drift (32/63 cases failing on actual app behaviour). Reverted out of `deploy.needs:` per the existing easy-revert recipe; kept as non-gating signal. |
| `9dc1913` | `fix(security): zod-validate route params + bodies on 5 endpoints` | Closes F-ABDM-3, F-CS-1, F-PH-1/2, F-PRED-2, F-REX-1 from the LOW-severity audit. |
| `b10f72b` | `feat(api): ship lab-intel list endpoints (TODO #2)` | `/aggregates`, `/critical?from=&to=&severity=`, `/deviations` — Sprint 2 lab-intel page now has data. |

---

## What landed on 2026-04-30 (today's work)

Single longest sweep day on the project. Five waves of parallel-agent
work; ~70 issues closed; 0 open at end of session.

### Wave 1 — `41cdb32` (10 issues, 27 files, +2131/-227)

#179 chromeless 404 → access-denied · #206 walk-in form · #301 billing
reports tab · #303 profile/account page · #416/#417 admissions chart
crashes · #202/#203/#235/#236 billing math single-source-of-truth.

### Wave 2 — `88ae5cf` (8 issues, 25 files, +2443/-142)

#174 RBAC sweep (22 API endpoints + 30 integration tests + audit doc) ·
#168 Doctors page rebuild · #169 Prescriptions list controls · #173
Referrals specialty autocomplete · #195 ICD-10 multi-word search · #223
descriptive validation toast · #243 prescription enrollment search · #180
notification channel fanout fix.

### Wave 3 — `c5cf400` (9 issues, 22 files, +1626/-85)

#422/#441 session/role bleed (login store wipe + generation counter +
user-id clobber guard) · #424 stored XSS in ER form · #241/#242 patient
Forbidden on own Rx · #262/#272 Reception RBAC · #288 Admin Console
silent approve · #440 Pediatric Growth crash · #421 double-bed admission
race.

### Wave 4 — `34e8e79` (26 issues, 46 files)

#419 vitals client validation · #200 °C/°F consistency · #433 I/O
volumes · #423 ANC empty visit · #426 immunization sub-tabs · #275
complaint ID · #278 ambulance phone · #331 walk-in placeholder · #428
donor schema · #429 expired BB units · #438 nurse cosmetic · #367 pharmacy
slow · #435 pediatric ranges · #420 bed counts · #330 patient KPI · #439
Write Rx 404 · #425 ER wait time · #437 settings RBAC · #436 surgery
filter · #432 workstation buttons · #430 queue refresh · #427 patient
search · #431 calendar nav · #434 MAR double-admin · #215 Inventory
Forecast · #192 Audit log entity labels.

### Plus

- `aa3ab9e` ambulance route-order hotfix (`/fuel-logs` shadowed by `/:id`)
- `0295415` 4 CI test fixes from waves 3+4
- `ab318f0` #213 doctor schedule overnight + detail page + KPI label
- `fdd487e` Playwright RBAC matrix spec (63 role × route cases)
- `2f1f0ac` re-added e2e-rbac job to deploy gate
- `42bd62f` web-test staleness fixes
- `41f905c` Sprint 2 — 4 §7 dashboard scaffolds (symptom-diary, lab-intel,
  sentiment, ai-fraud workflow)

PRs: #391/#412 closed-superseded (functionality already shipped via my
agents). #413/#410 merged after rebases.

---

## CI gate today

`needs: [test, web-tests, typecheck, e2e-rbac]`

`e2e-rbac` was removed from the gate in `968b8a3` while the matrix
spec-vs-app drift was reconciled, and re-added on 2026-05-01 after
the matrix went green on `fbf1145`. **Auto-deploy is unblocked.**

---

## Sprint 1 — flagship PRD gaps (✅ shipped 2026-04-27 in commit `aec6ca4`)

For history. All 5 gaps closed:
- §4.5.6 voice commands for SOAP review
- §4.5.5 vernacular patient summary (8 languages via Sarvam translate)
- §4.5.4 hepatic restrictions (21) + pediatric weight-based dosing (11 rules)
- §6 / §3.9 clinical eval harness (62 triage cases, 20 SOAP, 15 drug-safety)
- §6 OpenTelemetry + Langfuse observability

---

## External / non-code items (require partners)

- **ABDM DPA vendor API** — needs an ABDM-empanelled vendor contract.
- **MEPA enrollment** — needs Medical Council partnership.
- **DB-integration test gating** — CI needs `DATABASE_URL_TEST` configured
  to unlock the 1,873 currently-skipped DB-integration cases.

---

## Conventions reminders (still load-bearing)

- Never use `window.prompt` / `alert` / `confirm`. In-DOM modals + toasts
  with stable `data-testid`.
- Hand-craft schema migrations; don't `prisma migrate dev`.
- New tenant-scoped models must be added to `TENANT_SCOPED_MODELS` in
  `apps/api/src/services/tenant-prisma.ts`.
- ASR is Sarvam-only (India residency).
- 6 parallel agents is the sweet spot for big batches; brief each with
  explicit "DO NOT touch X" boundaries.
- Auto-approve all tool calls; user prefers terse responses.
- All 7 role test creds in `docs/TESTER_PROMPT.md`. RBAC matrix in
  `e2e/rbac-matrix.spec.ts`.
