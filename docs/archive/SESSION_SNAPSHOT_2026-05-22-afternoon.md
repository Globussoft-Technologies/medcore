# Session snapshot — 2026-05-22 afternoon (Pearl PRD gap-close — 80 → 47 open after PRD rebuild)

End-of-session handoff. Read this first, then [`/TODO.md`](../../TODO.md), then go. Replaces [`SESSION_SNAPSHOT_2026-05-21-morning.md`](SESSION_SNAPSHOT_2026-05-21-morning.md) as the most recent handoff.

This session was driven entirely by the autonomous Pearl-gap-close **cron** (multiple iterations, finishing at 15-min cadence with fan-out-up-to-3-agents-per-tick). The cron was manually stopped at end-of-session per user request.

## State at session end

- **HEAD on `main`** = `162644e` — `test(web): mock /leads/by-patient/:id 404 in patients.detail.page tests` (fix-tick after the final wave).
- **Working tree:** clean.
- **CI on HEAD:** pending at snapshot time. Prior runs trended green (with 2 fix-ticks recovering from agent-shipped regressions).
- **Open PRs:** 0 non-dependabot. Sourav merged 4 unrelated UI-fix PRs interleaved (#931–#964 cluster).
- **Cron status:** stopped (`72a8d011` cancelled). Re-arm at next session with the same fan-out prompt to resume gap-close.

## What this session shipped

### 1. PRD source + gap-doc rebuild (foundation for everything after)

- **`8a89ec5`** — Saved Pearl ERP Stage 1 SoW v1.0 (633 LOC, 21 sections) in-repo at `docs/PEARL-ERP-STAGE-1-SOW.md`. Replaces the previously-untracked `Hardik's Req_pearl woman.txt` reference in the gap doc. Future sessions can grep the source PRD instead of reading a derived analysis.
- **`26cf219`** — Section-by-section rebuild of `docs/PEARL_STAGE1_GAP_ANALYSIS.md` against the in-repo PRD. Flipped 11 stale ❌/🟡 rows that had shipping code; added 4 new sections (§6 acceptance-criteria coverage, §7 NFR coverage, §8 compliance posture, §9 pilot success criteria); expanded §10 out-of-scope to fully mirror PRD §18. Top-10 list renumbered §7 → §11. Refreshed top-line coverage estimate ~65-70% → ~75-78%. Rebuild log appended at end.

### 2. Pearl PRD gap closures (~28 closures this session)

Organized by closure date / commit cluster:

**Tier-3 chain pieces — closures**:
- **#5 piece 3a-3h Patient PWA shell content** (10 closures): `/patient/dashboard` (`ad6a70a`), `/patient/appointments` (`f6d4d5c`), `/patient/prescriptions` (`02a4d75`), `/patient/bills` list (`d697979`), `/patient/profile` (`36b4fef`), `/patient/records` timeline (`e0dd0c9`), `/patient/bills/[id]` detail (`4f5ec68`), `/patient/bills/[id]/pay` Razorpay handoff (`bd39041`), plus offline SW cache piece 4 (`b28e695`). All mobile-first with 44px touch targets; reuse existing patient-self-scoped endpoints.
- **#6 piece 2 super-admin onboarding wizard MVP** (`4c9bf16`): 3-step wizard (tenant + first branch + super-admin user) + `POST /tenant-onboarding` atomic transaction. Remaining 5 PRD steps (HFR/HPR/WhatsApp/Razorpay/post-creation) deferred to piece 2b.

**Tier-3.5 quick-win closures** (small/medium matrix rows):
- §2.1.1 `Patient.source` enum (`b2a410b`) — WEB/PWA/WALK_IN/REFERRAL/WHATSAPP/PHONE/OTHER + migration + UI dropdown + chip on patient list.
- §2.1.4 `DoctorFavouriteMedicine` model (`f634812`) — per-doctor quick-add presets + 5 endpoints under `/doctors/me/favourites`.
- §3.1 row 71 booking-form per-doctor channel filter (`92f0099`) — `availableChannels = mode-valid ∩ enabledChannels[]`, auto-select single, hide picker.
- §3.1 row 74 bulk-edit dialog for ADMIN (`7c770f3`) — `POST /doctors/bulk-update` 100-doctor cap + tenant-scope probe + per-field "Apply" toggles. **Fix-tick `0ef60f7`** corrected tenant-probe to use unscoped client.
- §3.2 row 77 final 2 mode-knobs (`f2ab8d3`) — `Doctor.enabledChannels[]` AppointmentChannel enum + `Doctor.bufferMinutes` Int + UI in AppointmentModeCard.
- §4.1 row 101 referring-doctor commission auto-split (`cd72635`) — `Doctor.commissionPercent` + `Referral.commissionPercent` override + `ReferralCommission` model + invoice $transaction hook + 7 integration tests.
- §4.2 row 103 NHCX cashless stub stepper UI (`0cf8f5a`) — reusable 4-stage horizontal stepper component + ADMIN advance button + 13 tests.
- §4.3 row 104 Pharmacy dispensing Kanban (`f22ce10`) — `PrescriptionStatus` enum extended (DISPENSING+READY) + state-machine guards + 4-column drag-drop board.
- §4.4 row 114 commission ledger report (`ddcffcf`) — `GET /referral-commissions/ledger` per-doctor rollup + JSON/CSV.
- §4.4 row 115 lead-to-patient conversion funnel (`2d3e9ac` + fix-tick `5b0a324`) — `GET /analytics/lead-funnel-report` per-stage + per-source breakdown + JSON/CSV.
- §4.4 row 116 no-show rate by doctor / day-of-week (`28a2422`) — `GET /analytics/no-show-report` with embedded `byDow[7]` cross-pivot + JSON/CSV.
- §4.4 row 119 TDS on professional fees (`182eb91`) — `GET /billing/tds-report` per-doctor aggregation + JSON/CSV.
- §4.4 row 120 CSV `branchId` filter on the 3 new reports (`23a9b7d`) — extends TDS/no-show/commission-ledger with `?branchId=` cross-tenant-validated.
- §4 row 275 Twilio SMS adapter (`3e0c1e9`) — env-routed via `SMS_PROVIDER=twilio`; Messaging API + Basic Auth + stub-mode fallback.
- §5.3 row 149 reception-mediated forgot-phone recovery (`08ba0ae`) — `POST /patients/:id/recover-phone` RECEPTION+ADMIN gated, identity-method note + audit-suffix-only.
- §6.2 row 170 Lighthouse CI budget (`63f6d64`) — `.lighthouserc.json` Perf ≥85 + A11y ≥95 mobile budget on 4 patient PWA URLs + `.github/workflows/lighthouse.yml` triggered on push to main + apps/web changes.
- §7.1 row 183 CRM History on doctor's patient-detail page (`2ec88c3` + fix-tick `162644e`) — new `GET /leads/by-patient/:id` endpoint + read-only Lead+activities timeline + PATIENT-hidden.
- §8.4 row 222 background-job queue admin UI (`e9d6764`) — `ScheduledTaskRun` model + `runTaskWithAudit()` cron wrap + `GET /scheduled-jobs` + super-admin `/super-admin/jobs` page with status chips + retry button.

**Stale-annotation cleanup**:
- `8dbc378` — NMC reg row 54 (already in `704a5f5`) + Pharmacy Kanban row 184 (already in `f22ce10`).
- `aeb625a` — ⌘K command palette row 189 (already shipped in `apps/web/src/app/dashboard/_components/search-palette.tsx` 379 LOC, fully bound to Cmd+K + grouped search). Pre-flight grep saved a regression here.

### 3. Operational/infra changes

- **`6813910`** — release.yml fires on every push to main (per user request). 8 job-level `if:` clauses flipped from `(push && RELEASE_VALIDATION_PAUSED == 'true')` to `github.event_name == 'push'`. Schedule still skips when paused.
- **`99f42cc`** — getAuthToken JWT now carries `tenantId` claim (test infra fix).
- **`5814fb8`** — Reverted `3e3b34c` (parallel-impl regression on PatientAllergy block; Sumit had already shipped Pearl #7 in `954b141` with different contract).
- **`a8befca`** — Gap-doc annotation re-pointed Pearl #7 closure at `954b141`.
- **`87545db`** — Test assertion fix on Campaigns state-machine (`PATCH DRAFT→RUNNING` returns 409 not 400).
- **`15bc136`** — SSR-prerender fix on patient landing page (`<a onClick>` → `<button disabled>`).
- **`29f04f0`** — CI-only flake fix on complaints KPI test (`waitFor` text instead of element presence).
- **`79c171a`** — Fix-tick recovering 9 main-red failures from evening cron commits (branch-scoping fixture seeding + campaign test isolation).
- **`0ef60f7`** — Bulk-update tenant-probe fix (unscoped client + explicit per-row compare).
- **`5b0a324`** — Lead-funnel test assertion fix (count-the-seed reality).
- **`162644e`** — Patient-detail test mock-allowlist fix (route the new `/leads/by-patient/:id` fetch).

### 4. Process / cron infrastructure

- Cron `7572d655` (morning) → `83294808` → `397fcc31` → `f2e1d01d` → `72a8d011` (each replacement updated the prompt to fix-first-on-red, then fan-out-up-to-3-per-tick, then 15-min cadence). All session-only (harness drops `durable: true` per CLAUDE.md gotcha #17).
- Final cron `72a8d011` was at `7,22,37,52 * * * *` (every 15 min, off-minute) with up-to-3 parallel agents on non-overlapping files.
- **3 parallel agents-per-tick was the throughput unlock** — average 0.84 closures/tick (single-agent) → ~2.5/tick (3-agent fan-out) when CI keeps up. The cron's STOP-if-already-shipped pre-flight grep rule caught 5 misclassifications this session (would-have-been parallel-impl regressions).

## Pearl Top-10 status going into next session

| # | Item | Status |
|---|---|---|
| 1 | Doctor.appointmentMode | ✅ CLOSED (prior sessions) |
| 2 | Branch model + branchScopedPrisma + picker | ✅ CLOSED (prior sessions) |
| 3 | Lead pipeline | ✅ CLOSED (prior sessions) |
| 4 | Campaign engine | 🚧 6 of 7 pieces done — **only piece 4 UI remaining** (Campaigns list/create/audience-builder UI) |
| 5 | Patient PWA + phone-OTP | 🚧 11 of 13 pieces done — **only Book Appointment + WhatsApp Inbox + photo upload + ABHA-link-on-first-login remaining** |
| 6 | Super-admin host + Pearl-billing | 🚧 2 of 4 pieces done — **piece 2b wizard remaining 5 steps + piece 3 Pearl-billing schema/UI + piece 4 metrics/DPDP-workbench remaining** |
| 7 | Rx allergy-block | ✅ CLOSED (prior sessions) |
| 8 | Threaded remarks + quick-actions | ✅ CLOSED (prior sessions) |
| 9 | Tenant feature flags | ✅ CLOSED (prior sessions) |
| 10 | NMC reg + per-tenant Razorpay + ADMIN TOTP | ✅ CLOSED (prior sessions) |

**Net Stage-1 closure burn**: gap doc rebuild started at **80 open rows**; ended at **~47 open rows** (28-30 closures this session). Refreshed top-line coverage estimate after closures: **~82-85%**.

## Next-session pickup priorities

Remaining open rows, smallest first:

1. **§5.2 ChronicCare DSL bits** (rows 142-145) — auto-enrol cron + sequence stepper. ~200-400 LOC. Multiple matrix rows close together.
2. **§3.5 DPDP cross-tenant workbench** — backend (delete + audit + receipt) + super-admin UI. ~400-600 LOC.
3. **§6.2 row 168 PWA install prompt** — capture `beforeinstallprompt` + Install button in patient layout. Small.
4. **§6.2 row 172 44px touch-target audit** — codebase grep + fix non-conforming buttons + Tailwind utility class. Medium.
5. **§7.2 row 190 skeleton loaders universal** — codebase sweep + add skeletons to top-N untouched pages. Medium.
6. **#5 piece 3i Book Appointment patient PWA** — multi-step (specialty → doctor → channel-aware date picker). Large.
7. **#5 piece 3j WhatsApp Inbox** — needs inbound WhatsApp routing infra. Largest.
8. **#6 piece 2b wizard remaining 5 steps** — HFR/HPR/WhatsApp/Razorpay/post-creation. Each step = its own tick.
9. **#6 piece 3 Pearl-billing schema + UI** — `PearlSubscription` + `PearlInvoice` + state machine + proration. Multi-tick chain.
10. **#6 piece 4 cross-tenant metrics + Pearl-operator support inbox + compliance dashboard**. Multi-tick chain.
11. **#4 piece 4 Campaigns UI** — list / create / audience-builder UI. Multi-tick chain.

Plus M7 §8.1/§8.2/§8.3 rows (tenant KPIs, suspend-S3-archival, granular permissions, 2FA mandatory, idle timeout, email invite, per-tenant subscription metering, Pearl billing) — most are downstream of #6 chain pieces.

## Known issues

- **Test workflow paths-filter** skips Sourav's UI-only commits (e.g. `a1a15d0`, `bf6bb31`, `244456d`). Confirmed harmless — my commits trigger CI normally. Worth noting if a UI-only commit eventually ships a regression.
- **Stale TODO list** — the harness's TodoWrite reminder kept appearing throughout the session. The cron tracks naturally via gap doc + commit log; ignored.
- **Mandatory pre-flight grep** in every agent brief — non-negotiable rule. Caught 5 already-shipped misclassifications this session.

## Cron mechanics — re-arm at next session

Cron stopped (`72a8d011` cancelled). To resume autonomous gap-close at next session:
1. Verify CI on `162644e` (or current HEAD) is green.
2. Re-fire the same fan-out cron prompt — `CronCreate({cron: "7,22,37,52 * * * *", recurring: true, prompt: <same prompt as 72a8d011>})`.
3. Self-terminates when gap doc shows zero ❌/🟡 in §2/§3/§4/§6/§7/§8/§11.

## Read first next session

1. This file.
2. [`docs/PEARL_STAGE1_GAP_ANALYSIS.md`](../PEARL_STAGE1_GAP_ANALYSIS.md) — per-piece closure annotations + remaining open rows.
3. [`docs/PEARL-ERP-STAGE-1-SOW.md`](../PEARL-ERP-STAGE-1-SOW.md) — in-repo source PRD (the gap-doc rebuild was against this).
4. [`/TODO.md`](../../TODO.md) — banner updated alongside this snapshot.

---

End of session 2026-05-22 afternoon.
