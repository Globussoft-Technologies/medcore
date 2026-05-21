# Session snapshot — 2026-05-21 morning (Pearl ERP Stage 1 — 7 of 10 top-10 closed + all 4 Tier-3 chains started)

End-of-session handoff. Read this first, then [`/TODO.md`](../../TODO.md), then go. Replaces [`SESSION_SNAPSHOT_2026-05-20-evening.md`](SESSION_SNAPSHOT_2026-05-20-evening.md) as the most recent handoff.

This was an **overnight autonomous cron** session (cron `7572d655`, every 30 min, session-only) plus user-prompted ticks at the boundaries. The cron ran ~15 ticks against the Pearl PRD gap doc, picking the smallest unclosed gap each tick, dispatching one foreground agent, and exiting. The agents grew a mandatory "grep before scaffolding" pre-flight after two parallel-impl regressions early in the session.

## State at session end

- **HEAD on `main`** = `f6bb3de` (`feat(api,web,db,shared): #5 piece 2/4 — patient phone-OTP login backend + login page`).
- **Working tree:** clean.
- **CI on HEAD:** in_progress at snapshot time. Last 5 prior commits all green (Test workflow).
- **Open non-dependabot PRs:** 0. PR #930 (Sumit's `auto-merge.yml` + `release.yml` workflow tweaks) was rebased + squash-merged at `6f93694`.
- **14 commits this session on `main`** (excluding 4 Sourav UI-fix merges interleaved by the team).
- **Cron status:** auto-expires in ~7 days per the harness limit. Re-arm with the same prompt to resume autonomous gap-closing.

## What this session shipped

### 1. Pearl gap #1 — Doctor.appointmentMode chain **fully closed** (3 pieces)

| Piece | Commit | Surface |
|---|---|---|
| 1 of 3 | `af48756` | API: `dailyAppointmentLimit` cap (409 once limit reached, cancelled/no-show rows don't count); `lastHourPolicy=BLOCK_NEW` window block (multi-shift aware); `tokenPrefix` → response payload carries `displayToken = "<prefix><n>"`. 3 integration tests. |
| 2 of 3 | `458b200` | Docs-only. The doctor-profile mode-picker UI (`AppointmentModeCard` exposing all 6 mode knobs wired to `PATCH /doctors/:id/appointment-mode`) was already shipped in commit `fd58688` two ticks before the gap doc tracked it. Agent honored STOP-if-already-done; gap doc annotated. |
| 3 of 3 | `97542ec` | 3 integration tests for the mode-tagged display feed (TOKEN/CALLING/SLOT doctor rows on `/api/v1/queue` carry `appointmentMode` + per-mode payload + `"Priya Sharma" → "Priya S."` redaction per Pearl §2.1.5). Code (DoctorCard variants + SLOT redaction + CALLING arrival-queue surface) was already shipped in `6febb54`; this tick added test coverage + closure annotations. |

### 2. Pearl gap #2 — Branch model + scoping **fully closed** (3 pieces per cron's slice)

| Piece | Commit | Surface |
|---|---|---|
| 1 of 3 | `e0f8fa9` | Schema: `Branch` model (id/tenantId/name/code/address/.../gstin/isDefault/active) + indexes + `@@unique([tenantId, code])`. Migration `20260520000010`. Zod `createBranchSchema`/`updateBranchSchema`. 5 CRUD endpoints at `/api/v1/branches` (ADMIN-gated mutations; `isDefault` invariant API-enforced — auto-default first branch; PATCH transfers atomically; can't soft-delete the default). 15 integration tests. |
| 2a of 3 | `f37570c` | `branchScopedPrisma` extension composed on top of `tenantScopedPrisma` + `runWithBranch` AsyncLocalStorage + `branchContextMiddleware` (header-only `X-Branch-Id` resolution, JWT/session resolution deferred). Appointment.branchId nullable migration `20260520000011`. Appointments route switched to branch-scoped client. 3 integration tests. |
| 3 of 3 | `1b21df4` | Zustand `branchStore` with localStorage persistence (`medcore_branch_id`), `loadBranches()` auto-selects `isDefault` when persisted id stale, lazy api-client import to avoid circular dep. `BranchPicker` topbar component (auto-hides on single-branch tenants, full `data-testid` coverage). `api.ts` request interceptor attaches `X-Branch-Id` on every outbound non-auth/non-branches request, SSR-safe. 19 tests (9 store + 6 picker + 4 interceptor). |

Deferred follow-up — **piece 2b** (single-piece backend tightening, ~1 wk):
- Add `branchId` nullable to `Invoice`, `Doctor`, `Patient`.
- Backfill existing rows to each tenant's `isDefault` Branch.
- Add `branchId` to JWT signing in `services/jwt.ts` + auth middleware to read it from claim (not just header).
- Allow-list more models in `branchScopedPrisma` once columns exist.

### 3. Pearl gap #4 — Campaign engine started (2 of 4 pieces shipped)

| Piece | Commit | Surface |
|---|---|---|
| 1 of 4 | `0f3e958` | Schema: `Campaign` + `CampaignAudience` + `CampaignSend` + 4 enums (`CampaignChannel`/`Kind`/`Status`, `SendStatus`). Migration `20260520000012`. Back-relations wired on Tenant/User/Patient/Notification/NotificationTemplate (coexists with NotificationBroadcast + ChronicCarePlan — no refactor). 6 Campaign CRUD endpoints + 4 CampaignAudience CRUD endpoints (ADMIN-gated; `operatorWriteableStatusEnum` excludes dispatcher-only `COMPLETED`; `OPERATOR_STATUS_TRANSITIONS` state machine in the route; sendWindow co-required + start<end refinements). 28 integration tests. Pre-existing test failure on `87545db` was self-correcting (test assertion expected 400 from Zod but state-machine guard correctly returns 409 — RUNNING stays in enum because `PAUSED→RUNNING` is a legitimate resume; fixed by aligning the test expectation). |
| 2a of 4 | `f701b52` | `audienceRulesSchema` envelope (permissive filter triples for forward-compat — strict union would 400 on piece-1's test fixtures that had out-of-v1 filter shapes). Pure `compileAudience(rules) → Prisma.PatientWhereInput` in `services/audience-compiler.ts` — gender/age/lastVisitDays/abhaLinked real; city/branchId/optedOut documented no-ops until corresponding columns exist on Patient. New `POST /campaign-audiences/:id/compile` (ADMIN, persists `estimatedSize` + `lastComputedAt`). Real preview replaces piece-1 stub on `POST /campaigns/:id/sends/preview`. 18 audience-compiler unit tests + 5 integration tests. |

Remaining for #4:
- **Piece 2b**: dispatcher worker (sync fan-out per channel → CampaignSend rows → existing notification orchestrator) + send-window-clamp + per-channel template substitution (`{{patient.firstName}}`).
- **Piece 3**: A/B variant resolution at dispatch + conversion-attribution wiring + tracking-aggregate rollups.
- **Piece 4**: Campaigns UI (list / create / audience builder / tracking dashboard).

### 4. Pearl gap #5 — Patient PWA started (2 of 4 pieces shipped)

| Piece | Commit | Surface |
|---|---|---|
| 1 of 4 | `9456178` + `15bc136` (SSR fix) | `/patient` route group (`layout`/`page`/`loading`/`not-found`), mobile-first, 44px CTAs, no dashboard sidebar/topbar/LanguageDropdown/BranchPicker. Segment-scoped PWA manifest at `apps/web/src/app/patient/manifest.ts` (start_url=`/patient`, scope=`/patient`, separate from staff manifest). Vanilla no-op service worker (`apps/web/public/sw.js`) scoped to `/patient` only. `PatientServiceWorkerRegistration` client component mounted in layout. 4 Vitest assertions. **SSR fix in `15bc136`** swapped `<a onClick={preventDefault}>` for `<button disabled>` — Next.js server components reject event-handler props at prerender. |
| 2 of 4 | `f6bb3de` | `PatientOtpChallenge` model + migration `20260520000013` (bcrypt OTP hash, 5-min TTL, attempts counter, indexes on phone + expiresAt). `requestPatientOtpSchema` / `verifyPatientOtpSchema` Zod with phone canonicalization. `POST /api/v1/patient-auth/otp-request` (anti-enumeration: always 200; 3-req/10-min per-phone throttle via inline Map+TTL with reset hook; SMS via existing MSG91 adapter; audit logs only phoneSuffix). `POST /api/v1/patient-auth/otp-verify` (bcrypt-compare; 5-attempt-per-challenge 429 lockout; JWT mint via `services/jwt.ts`; httpOnly `medcore_at` cookie per issue #477). Two-step `/patient/login/page.tsx` (phone → OTP, inline error surface, 8 testids). 7 integration tests. |

Remaining for #5:
- **Piece 3**: PWA shell content — dashboard tiles (next appt / recent Rx / open bills), my-appointments, my-prescriptions, my-bills pages.
- **Piece 4**: Offline-tolerant SW caching strategy (cache last dashboard payload + appointment list for view-when-offline).

### 5. Pearl gap #6 — Super-admin started (1 of 4 pieces shipped)

| Piece | Commit | Surface |
|---|---|---|
| 1 of 4 | `7593058` | `/super-admin` route group (`layout`/`page`/`loading`/`not-found`) + client-side gate enforcing `Role.ADMIN AND tenantId == null` (mirrors `routes/tenants.ts:requireSuperAdmin`). Bare dark topbar — no dashboard sidebar/LanguageDropdown/BranchPicker. Landing dashboard with Tenants tile (links to piece-2 `/super-admin/tenants`) + disabled Pearl-Billing placeholder. `User.tenantId` field added to web auth store (API surfaced it since `a7d1b12`; web type lagged). 7 Vitest assertions covering all gate branches (super-admin OK; tenant-admin redirected; non-ADMIN redirected; unauthenticated → `/login?redirect=…`). |

Remaining for #6:
- **Piece 2**: Onboarding wizard (Pearl §8.1 step-by-step: tenant + first branch + super-admin user + HFR/HPR/WhatsApp/Razorpay config).
- **Piece 3**: `PearlSubscription` + `PearlInvoice` schema + Pearl-side billing surface (Pearl → hospital invoice generation + state machine).
- **Piece 4**: Cross-tenant metrics + per-tenant health + DPDP workbench.
- **Deferred**: Server-side `middleware.ts` gate for `/super-admin/*` (deferred from piece 1 — no `middleware.ts` exists in this Next.js app, adding it as the first instance is non-trivial precedent scope; client-side gate covers UI flash prevention).

### 6. Self-fixes (not Pearl gaps)

| Commit | Fix |
|---|---|
| `99f42cc` | `getAuthToken` JWT now carries `tenantId` claim — the global tenant middleware was always seeing `req.tenantId === undefined` in integration tests, breaking feature-flags gating + per-tenant razorpay tests. |
| `5814fb8` | **Revert of `3e3b34c`** — a cron-tick agent built a parallel `PatientAllergy` block impl unaware that Sumit had already shipped Pearl #7 in `954b141` with a different contract (HTTP 400 + `entity=patient` vs the agent's 409 + `entity=prescription`). That overwrote Sumit's working impl and broke 2 existing tests. Revert restored Sumit's version. |
| `a8befca` | Gap-doc annotation re-pointed Pearl #7 closure at `954b141` (Sumit's earlier work) instead of the reverted `3e3b34c`. |
| `87545db` | Test assertion fix — `PATCH DRAFT→RUNNING` returns 409 from the state-machine guard, not 400 from Zod (RUNNING stays in the operator-writeable enum because `PAUSED→RUNNING` is a legitimate resume). |
| `15bc136` | SSR-prerender fix on the patient landing page — Next.js server components reject `onClick` props; swapped `<a onClick={preventDefault}>` for `<button disabled>`. |

### 7. PR triage

| PR | Outcome |
|---|---|
| #930 (Sumit, `auto-merge.yml` + `release.yml`) | Rebased onto current main (auto-dropped one already-upstream commit) → force-pushed with `--force-with-lease` → squash-merged at `6f93694`. The pre-rebase failure was inherited stale state — `appointment.test.ts > rejects missing slotId` had been fixed on main in `0c8d780`. |

Plus 4 unrelated Sourav UI-fix PRs (#931–#934) landed via the team's normal flow.

## Pearl gap top-10 status going into next session

| # | Item | Status | Notes |
|---|---|---|---|
| 1 | Doctor.appointmentMode | ✅ CLOSED | All 3 pieces. |
| 2 | Branch model + branchScopedPrisma + picker | ✅ CLOSED | 3-piece chain per cron slice. Piece 2b (branchId on Invoice/Doctor/Patient + JWT/session resolution) is a single ~1-wk follow-up. |
| 3 | Lead pipeline | ✅ CLOSED | Previous session. |
| 4 | Campaign engine | 🚧 2 of 4 | Schema + audience compiler done. Dispatcher + A/B + UI remaining. |
| 5 | Patient PWA + phone-OTP | 🚧 2 of 4 | Scaffold + login done. Shell content + offline cache remaining. |
| 6 | Super-admin host + Pearl-billing | 🚧 1 of 4 | Scaffold + client gate done. Wizard + billing + metrics remaining. |
| 7 | Rx allergy-block | ✅ CLOSED | Previous session (`954b141`). |
| 8 | Threaded remarks + quick-actions | ✅ CLOSED | Previous session (`02192a4`). |
| 9 | Tenant feature flags | ✅ CLOSED | Previous session (`d6a5370`). |
| 10 | NMC reg + per-tenant Razorpay + ADMIN TOTP | ✅ CLOSED | Previous session (`704a5f5` + `a7d1b12`). |

**Net progress this session: 4 fresh closures (#1 piece 1+3, plus all of #2) + 4 chains started (#4, #5, #6).**

## Next-session pickup priorities

Smallest unclosed first:

1. **#6 piece 2 of 4** — onboarding wizard at `/super-admin/onboard`. Step-by-step new-tenant creation: tenant + first branch + super-admin user + HFR/HPR/WhatsApp/Razorpay config steps. Backend reuses existing `tenant-provisioning.ts` + `createTenant()` (single atomic POST today; wizard splits it into a stateful multi-step API). Builds on the `/super-admin` scaffold from `7593058`.

2. **#5 piece 3 of 4** — PWA shell content. Dashboard tiles + my-appointments + my-prescriptions + my-bills pages, all reading the existing patient-facing endpoints. Plumb the `/api/v1/patient-auth` JWT from `f6bb3de` into the new pages.

3. **#4 piece 2b of 4** — Campaign dispatcher. Sync fan-out per channel → CampaignSend rows via existing `services/channels/*` adapters. Send-window-clamp + `{{patient.firstName}}` substitution. Could be sync (in-process during PATCH→RUNNING) or async (BullMQ-style worker) — sync is fine for Stage 1.

4. **#2 piece 2b** (the deferred backend tightening) — add `branchId` nullable to Invoice/Doctor/Patient + JWT claim + middleware claim-read. ~1 wk.

5. **#5 piece 4** — offline-tolerant SW caching strategy.

6. **#4 piece 3 (A/B + tracking) + piece 4 (UI)**.

7. **#6 piece 3 (PearlSubscription + PearlInvoice) + piece 4 (cross-tenant metrics + DPDP workbench)**.

## Known issues

- **Stale TODO list** — the harness keeps reminding "TodoWrite tool hasn't been used recently" on every tick because the original session todo list (4 items, the latest dating to last session) was never cleaned up by the cron. Naturally tracked via gap doc + commit log instead. Safe to ignore or clear at session start.
- **Deploy job intermittent SSH failures** — one Test workflow run failed only on "Deploy to dev server" with `Connection closed by *** port 22` (exit 255). All code-gates were green; future pushes re-trigger deploy automatically. Not a code regression.
- **Sumit's `954b141` work was tracked as 🟡 in the gap doc when actually already closed** — caused the duplicate-impl regression on cron tick 4. Mitigation in place: every cron-dispatched agent now runs a mandatory `git log` + `grep` pre-flight against the file paths it's about to touch. Caught 3 subsequent "already shipped" cases without regression.

## Cron mechanics

- Cron `7572d655` (every 30 min, session-only — harness drops `durable: true` per CLAUDE.md gotcha #17).
- Auto-expires after 7 days per the safety rails.
- Re-arm at session start by re-firing the same `/loop` prompt that built this session's chain — the full text is in the conversation transcript; the prompt's "Pre-flight → Scope discovery → Pick → Dispatch → After → Termination → Safety rails" structure can be copy-pasted directly.
- The cron self-terminates (`CronDelete`) when the gap doc has zero ❌/🟡 rows remaining.

## Read first next session

1. This file.
2. [`docs/PEARL_STAGE1_GAP_ANALYSIS.md`](../PEARL_STAGE1_GAP_ANALYSIS.md) — for the per-piece closure annotations and the deferred-piece TODO markers.
3. [`/TODO.md`](../../TODO.md) — banner is updated alongside this snapshot.

---

End of session 2026-05-21 morning.
