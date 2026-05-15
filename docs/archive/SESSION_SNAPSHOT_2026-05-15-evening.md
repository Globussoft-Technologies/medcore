# Session snapshot — 2026-05-15 evening (dep backlog cleared + deploy-blocker found + 4 STAGING guards)

End-of-session handoff. Read this first, then [`/TODO.md`](../../TODO.md), then go. Replaces `HANDOFF.md` (2026-05-14) as the most recent handoff.

## State at session end

- **HEAD on `main`** = `1d807b2` (`fix(api): 4 STAGING data-hygiene guards — #890 #892 #896 #897`).
- **Working tree:** clean.
- **Open PRs: 1** — #788 `@vitest/coverage-v8` 2→4 (deferred — paired with vitest core).
- **Open issues: ~115** — 104 STAGING + the pre-existing tail. **NEW: issue #908** (the deploy-blocker, see below).
- ⚠️ **Auto-deploy to `medcore.globusdemos.com` is BLOCKED** — see "Deploy blocker" below. The demo is frozen pre-2026-05-08.

## What this session shipped

**5 commits on main + 3 PRs merged + 1 ops issue filed.**

| Commit / PR | What |
|---|---|
| `2e8c23f` | **PR #906 merged** — `@opentelemetry/exporter-trace-otlp-http` 0.216→0.218. Cleared the npm-audit RED (7 protobufjs CVEs via the OTel exporter chain — NOT Next, as the 05-14 HANDOFF had guessed). |
| `6ee4b2e` | Fixed 6 zod-4 RFC-4122 UUID-strictness test failures (`validate-params` + `ai-predictions`) — placeholder UUIDs with non-compliant variant nibbles that slipped through PR #790's sweep. |
| `f84878f` | **PR #907 merged** — patch-minor group of 17. #883 was auto-recreated as #907; rebuilt its lockfile to fix the `Cannot find module 'react'` web-build break, verified the build compiles, force-pushed, CI went fully CLEAN. |
| `cd50553` | **Deploy-blocker fix** — `20260509000001` migration used `USING "User"` but the table is `@@map("users")`. See "Deploy blocker" below. |
| `1d807b2` | **4 STAGING data-hygiene guards** — #890 #892 #896 #897. See "STAGING fixes" below. |

## 🚨 Deploy blocker (issue #908 — needs ops, dev-DB access)

Auto-deploy has been **silently broken since ~2026-05-08**. Every `test.yml` run passes all CI jobs but the **`Deploy to dev server`** step fails P3009: migration `20260509000001_backfill_stale_visitors_and_misrouted_patient_notifications` used `USING "User" u` — Postgres quoted identifiers are case-sensitive and the table is `users` (lowercase, per `CREATE TABLE "users"` + `@@map("users")`). → `relation "User" does not exist` → migration aborts → all subsequent migrations blocked.

**The SQL is fixed in `cd50553`.** But the dev DB still holds the failed-migration record. **Ops must run ONCE on the dev server:**
```bash
npx prisma migrate resolve --rolled-back \
  20260509000001_backfill_stale_visitors_and_misrouted_patient_notifications
```
Then the next deploy applies the corrected migration and the demo catches up to a week of merges (#888, #905, #906, #907, Next 16, Zod 4).

**Also flagged in #908**: `20260508000003` has the SAME `DELETE FROM "User"` bug but the deploy got *past* it — it was likely force-marked `applied` without its SQL running, so the #722/#738 cleanups never executed. Ops should verify `_prisma_migrations` and re-do that cleanup as a fresh migration if confirmed. NOT edited (editing an applied migration = checksum mismatch).

## STAGING fixes — `1d807b2` (4 contained guards)

| Issue | Guard added |
|---|---|
| **#896** | `createPatientSchema` + `updatePatientSchema` cross-validate age ↔ dateOfBirth (DOB-derived age must be within ±1y of stated age). |
| **#897** | `POST /prescriptions/:id/share` 409s an unsigned (`signatureUrl=null`) or REJECTED/CANCELLED prescription before any channel delivery. |
| **#890** | `POST /billing/invoices` 409s when the linked appointment is NO_SHOW/CANCELLED — kills the phantom-revenue / insurance-fraud path. |
| **#892** | `POST /patients` adds a name + dateOfBirth exact-match duplicate guard (the phone/email checks missed cross-phone dupes; name-alone would false-positive on common names). |

2127/2127 apps/api + packages/shared unit tests pass; api typecheck clean. #890/#892/#897 integration tests are `DATABASE_URL_TEST`-gated → run in CI. **Issues #890/#892/#896/#897 left OPEN** — they're STAGING-tagged; verify on the demo once the deploy unblocks, then close.

## Top priority for next session

1. **Issue #908 — get the deploy unblocked** (ops `migrate resolve` on the dev DB). Until this is done the demo is stale and STAGING smoke-passes are impossible. **This is the gate on everything else STAGING-related.**
2. **Once deployed** — smoke-pass the demo, close the 5-6 already-fixed STAGING UI bugs (#877/#878/#884/#886/#887) + verify-close #890/#892/#896/#897.
3. **Continue the #890-#903 cluster** — remaining is deeper work, one dedicated session each:
   - **Data-cleanup migrations**: #891 placeholder emails, #900 `totalBillAmount` never accumulates, #902 `dueDate` null, #903 E2E seed-notes leaking into the ledger.
   - **Deep schema/correctness**: #895 `tenantId: null` leak on POST /patients, #898 `medicineId` FK on prescription items, #899 medicines-master regulatory metadata empty, #901 float currency + GST-after-discount sequence, #893 ER LWBS escalation, #894 GST line-item breakout.
4. **#788 vitest-coverage** — only after a paired vitest-core bump.
5. Carry-over: #599 PHARMACIST policy, A11 appointment UTC sweep, A12 payment-plans refactor, visual baseline regen, the 9 #772 user-blocked items.

## Reference

- **HEAD**: `1d807b2` on main
- **Issue #908**: the deploy-blocker — https://github.com/Globussoft-Technologies/medcore/issues/908
- [`HANDOFF.md`](../../HANDOFF.md) — 2026-05-14, superseded by this snapshot
- [`/TODO.md`](../../TODO.md) — banner reflects this session

## Net for the day

Dependency backlog **effectively cleared** — zod 4, Next 15→16, OTel exporter, the 17-package patch-minor group all merged; only the vitest-core-paired #788 remains. Found + fixed a week-old silent deploy outage (one-character SQL casing bug). Shipped 4 STAGING correctness guards. The single highest-leverage follow-up is the ops `migrate resolve` in #908 — it unfreezes the demo.
