# MedCore — TODO

Next-session priority list. Full per-issue history lives in
[`docs/SESSION_SNAPSHOT_2026-04-30.md`](docs/SESSION_SNAPSHOT_2026-04-30.md);
this file is the short, actionable checklist.

> Updated: 2026-04-30 evening — end of cap-the-day session.
> HEAD on `main` = `41f905c` (Sprint 2 dashboards).
> **Open GitHub issues: 0.** Every QA-sweep item is closed.

---

## ⏭️ Pickup-from-home priority list

When you sit down at home, this is the order. Each item is independently
shippable.

### 1. CI is RED — auto-deploy is blocked (~30 min to triage)

Last 2 runs on `main` failed; auto-deploy hasn't shipped Sprint 2 yet.
Run [`25174112116`](https://github.com/Globussoft-Technologies/medcore/actions)
(or whichever is latest) on commit `41f905c`. Investigate the two clusters:

- **`E2E (RBAC matrix only)` — failing on every run since it landed**
  This is the new gating job from `2f1f0ac`. The 63-test RBAC matrix at
  `e2e/rbac-matrix.spec.ts` runs against `next start` (production bundle)
  but has never gone green on CI. Most likely cause: seeded fixture rows
  (e.g. an existing patient/doctor for the role assertions) are missing
  on the e2e database, or the access-denied page testid lookup is racing
  the redirect. Read the workflow log + the playwright-rbac-report
  artifact.

  **Easy revert** if you want auto-deploy unblocked while you fix:
  drop `e2e-rbac` from the `deploy.needs:` array in
  `.github/workflows/test.yml` (one-line revert). The job stays in the
  workflow as a non-gating signal.

- **`API tests` — failed on commit `42bd62f` only (one-off?)**
  `42bd62f` was the test-staleness fix that made `web-tests` pass.
  API tests passed on `2f1f0ac` (the prior commit) but regressed on
  `42bd62f`. Could be a flaky integration test, since `42bd62f` only
  touched 2 web test files. Re-run the job from the GitHub UI — if
  it goes green on retry, it was flake.

### 2. Ship the missing `lab-intel` list endpoints (~1 hr)

`/dashboard/lab-intel` (commit `41f905c` Sprint 2) was built to consume
three GET endpoints that don't yet exist:

- `GET /api/v1/ai/lab-intel/aggregates`  (KPI tile counts)
- `GET /api/v1/ai/lab-intel/critical?from=&to=&severity=`  (DataTable rows)
- `GET /api/v1/ai/lab-intel/deviations`  (baseline-deviation list)

The page degrades gracefully to empty state, so this isn't urgent — but
the dashboard isn't useful until they land. Existing
`apps/api/src/routes/ai-lab-intel.ts` has only `GET /:labResultId` and
`POST /:labResultId/persist`. Add the three list endpoints, mirror the
`authorize(...)` set used by the page (DOCTOR/ADMIN full, NURSE read).

### 3. Broaden e2e-rbac → full Playwright suite (~2 hr, AFTER #1)

Once the RBAC matrix runs green for ~5 pushes, drop the explicit spec
filter in `.github/workflows/test.yml` (currently `npx playwright test
e2e/rbac-matrix.spec.ts`) so the full 22-spec suite runs. Before that
you'll need:

- Fix the `/dashboard/admin-console` axe-core violation flagged in this
  TODO's prior versions. Real a11y work — pick up alongside any new
  admin-console feature.
- Bump `playwright.config.ts` for CI: `workers: process.env.CI ? 2 : 1`
  + `retries: process.env.CI ? 1 : 0` to absorb transient flake.

### 4. LOW security follow-ups (from 2026-04-23 audit)

Captured for the next security-hardening sprint. None blocking.

- **F-ABDM-1** — `POST /gateway/callback` has no rate limit.
- **F-ABDM-3** — `:id` paths on consent endpoints not zod-validated for
  UUID shape. Add `validateUuidParams(["id"])`.
- **F-ADH-3** — `POST /enroll` emits no audit event.
- **F-CS-1** — `ai-chart-search` body has no zod schema.
- **F-INJ-1** — extend prompt-safety sanitiser to `ai-er-triage.ts`,
  `ai-letters.ts`, `ai-chart-search.ts`, `ai-report-explainer.ts`.
- **F-PH-1 / F-PH-2 / F-PRED-2** — pharmacy + predictions query/path
  params not zod-validated.
- **F-REX-1** — body not zod-validated on `/explain` and `/approve`.
- AI-inference audit rows missing on 7 routes (F-ER-3 / F-KB-2 /
  F-LET-2 / F-PH-* / F-PRED-1 / F-REX-3 / F-TX-1).

### 5. Deferred housekeeping

- **Two prescription-page tests** in `prescriptions.page.test.tsx`
  remain skipped — they probed the old raw-UUID inputs replaced by
  `<EntityPicker>` in #120. ~30 min to write fresh tests against the
  picker dropdown.
- **`apps/api/src/app.ts` global `/auth/*` 30/min limiter** — outermost
  ceiling that occasionally bites demos. Per-route caps from #124 stack
  inside it. If demos continue to hit it, raise the global cap (one-line,
  needs user say-so).
- **`package-lock.json` drift on prod** — recurs every deploy; the deploy
  script runs `git checkout -- package-lock.json` as a workaround. Root
  cause is probably the `@tailwindcss/oxide` optional-dep pin flapping on
  Linux vs Windows.
- **`TenantConfig` first-class table** — the per-tenant `SystemConfig`
  key-prefix scheme works; replace with a dedicated `TenantConfig` table
  in the next schema-churn window.

### 6. Acoustic diarization re-evaluation

Was previously available via AssemblyAI; removed on 2026-04-25 (PRD §3.8 /
§4.8 data residency). Re-evaluate when an India-region diarizing provider
appears, gated behind `DEPLOYMENT_REGION`.

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

`e2e-rbac` is the new RBAC matrix spec. **Currently failing on CI** — see
priority #1 above.

To temporarily unblock auto-deploy while debugging, drop `e2e-rbac` from
the array. Single-line revert.

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
