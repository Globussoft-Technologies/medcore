# Session snapshot — 2026-05-21 evening (Pearl gap #4 closes 5 of 6 sub-pieces + #2 piece 2b)

End-of-session handoff. Read this first, then [`/TODO.md`](../../TODO.md), then go. Replaces [`SESSION_SNAPSHOT_2026-05-21-morning.md`](SESSION_SNAPSHOT_2026-05-21-morning.md) as the most recent handoff.

## State at session end

- **HEAD on `main`** = `a9b1e7a` (`feat(db): Pearl §7.2 piece 2b — branchId on Invoice + Doctor + Patient`).
- **Working tree:** clean for code. `Hardik's Req_pearl woman.txt` remains untracked at the repo root (intentional — source PRD).
- **4 Pearl gap commits this session on `main`** (interleaved with 2 Sourav UI-fix merges that didn't conflict).
- **CI status at end:** all 4 commits passed local typecheck pre-push; tests run on push per the existing workflow.

## What this session shipped

### 1. Pearl gap #4 — Campaign engine — pieces 2b + 3a + 3b + 3c all closed (4 commits)

Drove gap #4 from "pieces 1 + 2a done" (morning state) to **5 of 6 sub-pieces done end-to-end.** Only piece 4 (the Campaigns UI) remains for full M4 closure.

| Piece | Commit | Surface |
|---|---|---|
| 2b — sync dispatcher | `9f26e74` | `services/campaign-dispatcher.ts` (255 lines) + `POST /api/v1/campaigns/:id/dispatch` (ADMIN). Compiles audience × channels, calls the existing per-channel adapters directly (NOT services/notification.ts — operator chose channels explicitly), writes one CampaignSend row per (patient, channel) with status SENT/FAILED/SUPPRESSED. NotificationPreference opt-out → SUPPRESSED. IST send-window clamp via `isWithinSendWindow()` + `nextSendWindowStart()`. Token substitution: `{{patient.firstName\|lastName\|fullName\|mrNumber}}` + `{{tenant.name}}`, unknown tokens left verbatim. Full state machine: DRAFT/SCHEDULED → RUNNING → COMPLETED (or → PAUSED on thrown error; partial sends preserved). Guards: 409 if RUNNING (parallel-dispatch), 409 if COMPLETED/CANCELLED, 400 if no audience or no channels, 409 if outside window. 5 integration tests. |
| 3a+3b — A/B variants + stats | `8ed9d63` | `parseAbVariants()` runtime-validates the Json column; `pickVariant()` weighted random per recipient (consistent across channels for the same patient). Resolved `variantId` is persisted on all 4 CampaignSend outcomes. **`GET /api/v1/campaigns/:id/stats`** (ADMIN): 3 parallel groupBy queries pivoted into `{total, byStatus, byChannel matrix, byVariant matrix}` with zeroed status names so the UI gets a stable shape. Empty `byVariant: {}` when no A/B is configured. 4 integration tests (50/50 split over 20 trials lands both variants; stats endpoint shape; cross-tenant 404; RECEPTION 403). |
| 3c — click + conversion attribution | `18359bf` | Migration `20260521000001` adds `CampaignSend.{clickedAt, convertedAt, convertedRefId, convertedType}` + `Campaign.linkTargetUrl` + composite `(patientId, clickedAt)` index. **Dispatcher refactor**: CampaignSend row now created first (status=QUEUED) so its id can be embedded in the click URL; promoted to SENT/FAILED/SUPPRESSED after the adapter resolves. New `{{campaignClickUrl}}` token resolves to `${PUBLIC_API_URL}/api/v1/public/campaigns/click/${sendId}`. **Public click endpoint** (unauthenticated, mounted alongside Rx-QR verify router) — first tap stamps `clickedAt`; 302s to `linkTargetUrl` or 200 ack if unset. **Conversion service** (`services/campaign-conversion.ts`): `recordCampaignConversion(prisma, {patientId, type, refId, windowDays?})` does last-touch attribution within 7-day window (configurable). **Hook into POST /appointments/book** credits the conversion fire-and-forget. **Stats extended** with top-level `clicked` + `converted` counts and per-variant click/conversion counts so the operator can compare A/B arms end-to-end (impressions → clicks → conversions). 3 integration tests (click 302 + clickedAt; click 404; full conversion flow). |

### 2. Pearl gap #2 — piece 2b (deferred follow-up) closed

| Piece | Commit | Surface |
|---|---|---|
| 2b — branchId on 3 more tables | `a9b1e7a` | Migration `20260521000002` adds nullable `branchId` + FK (`ON DELETE SET NULL`) + index on Invoice/Doctor/Patient. Per-tenant backfill stamps existing rows to each tenant's `isDefault` branch (idempotent). Schema gets named relations (`InvoiceBranch`/`DoctorBranch`/`PatientBranch`) on Branch + reverse on the 3 models. **`BRANCH_SCOPED_MODELS`** grows from `{Appointment}` to `{Appointment, Invoice, Doctor, Patient}` — existing extension hooks immediately stamp/filter for the new entries. 7-test unit suite pinning the allow-list shape. |

**Documented scope cuts (next session's piece 2c):**
- Routes `patients.ts` / `doctors.ts` / `billing.ts` still import `tenantScopedPrisma` — the allow-list is dormant until those routes flip to `branchScopedPrisma`. The flip is safe (extension early-exits when no branch context) but invasive; deferred to 2c.
- JWT signing + auth-middleware `branchId` claim — branchId still header-only via `branchContextMiddleware`. Also deferred to 2c.

## Pearl gap progress at session end

**7 of top 10 fully closed; #2 has a deferred 2c carved out; #4 is 5/6 sub-pieces done; #5/#6 unchanged from morning.**

| # | Item | Status |
|---|---|---|
| 1 | Doctor.appointmentMode | ✅ closed (morning) |
| 2 | Branch model + scoping | ✅ pieces 1+2a+3 (morning) + ✅ piece 2b (this session). 2c pending — route flip + JWT claim. |
| 3 | Lead pipeline | ✅ closed (morning) |
| 4 | Campaign engine | 🚧 pieces 1+2a+2b+3a+3b+3c done; **only piece 4 (UI) remains**. |
| 5 | Patient PWA | 🚧 pieces 1+2 done (morning). Pieces 3 (shell pages) + 4 (offline cache) pending. |
| 6 | Super-admin | 🚧 piece 1 done (morning). Pieces 2 (onboarding wizard) + 3 (PearlSubscription) + 4 (cross-tenant metrics + DPDP) pending. |
| 7 | PatientAllergy block | ✅ closed (Sumit, 2026-05-20) |
| 8 | Threaded AppointmentRemark | ✅ closed (morning) |
| 9 | Tenant feature-flag | ✅ closed (morning) |
| 10 | nmcRegNumber + Razorpay + TOTP | ✅ closed (morning) |

## Top priority for next session

1. **Gap #4 piece 4 — Campaigns UI** (~1.5 wk). Closes gap #4 entirely. Pages: list, create, audience builder, tracking dashboard reading from the stats endpoint shipped this session. UI patterns mirror `/dashboard/leads` (gap #3's UI).
2. **Gap #5 piece 3 — Patient PWA shell pages** (~1.5 wk). Dashboard tiles (next appt / recent Rx / open bills) + my-appointments + my-prescriptions + my-bills. Backend ~90% reused; just new patient-scoped read endpoints under `/api/v1/patient-portal/*`. Piece 4 (offline cache) is gated on piece 3 having pages to cache.
3. **Gap #2 piece 2c** (~1 wk). Two sub-pieces:
   - Flip `patients.ts` / `doctors.ts` / `billing.ts` from `tenantScopedPrisma` → `branchScopedPrisma`. Safe (extension early-exits without context); each route file is its own commit if you want to bisect risk.
   - Add `branchId` to JWT signing in `services/jwt.ts` + read from claim in `auth.ts` middleware (header still wins; claim is the fallback after header).
4. **Gap #6 piece 2 — super-admin onboarding wizard** (~1.5 wk). Pearl §8.1 step-by-step tenant onboarding (tenant + first branch + super-admin user + HFR/HPR/WhatsApp/Razorpay config) + the deferred server-side `middleware.ts` gate.
5. **Gap #6 piece 3 — PearlSubscription + PearlInvoice schema + Pearl-billing surface** (~1 wk).

After #4 piece 4 + #5 piece 3 close, the gap-analysis "top 10" will be **9 of 10 fully closed** (gap #6 will still have pieces 2/3/4 outstanding). Pearl PRD §13's 18-week calendar still fits.

## Reference

- **HEAD**: `a9b1e7a` on main.
- Source PRD: `Hardik's Req_pearl woman.txt` (untracked, root).
- Gap analysis: [`docs/PEARL_STAGE1_GAP_ANALYSIS.md`](../PEARL_STAGE1_GAP_ANALYSIS.md).
- Morning's snapshot: [`SESSION_SNAPSHOT_2026-05-21-morning.md`](SESSION_SNAPSHOT_2026-05-21-morning.md).
- [`/TODO.md`](../../TODO.md) — banner reflects this session.

## Net for the day

Closed 4 sub-pieces of Pearl gap #4 in 3 commits (`9f26e74` → `8ed9d63` → `18359bf`) — campaign dispatcher, A/B variants, stats endpoint, and click + conversion attribution all shipped end-to-end and tested. Plus closed the deferred follow-up of gap #2 piece 2b (`a9b1e7a`) — branchId now on 4 transactional tables (was 1), backfilled, allow-listed in the extension. Pearl gap progress went from 7/10 + 2 in progress at morning to **7/10 + 4 closer to finish lines** at evening. Gap #4 needs only the UI to fully close; gap #2 needs only the route flip + JWT claim. Both are well-scoped for one focused session each.
