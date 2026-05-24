# Pearl PRD — Open Decisions (for the user when back at the keyboard)

**Last updated:** 2026-05-24 — all 6 HARD BLOCKERs + 4 soft blockers DECIDED by user-at-keyboard. Cron will now pick the previously-blocked pieces in priority order.

> **Naming convention (corrected 2026-05-24):** "Pearl" is the pilot tenant (Pearl Women's & Children's Hospital), NOT the product. The product is MedCore HMS; Onviqa is the platform operator. New schema models and role enum values MUST be tenant-agnostic. Use `TenantSubscription`, `PlatformInvoice`, `PLATFORM_OPERATOR`, `PLATFORM_BILLING_OPERATOR` — NEVER `Pearl*` in code. "Pearl" survives only as: (a) the tenant's actual data row name, (b) the deploy host URL `admin.pearl-erp.in`, (c) descriptive doc text where "Pearl-side" means "operator→tenant direction".

## How to read this doc

These are decisions the autonomous gap-close cron CANNOT make on its own. The cron will keep picking from the ~40 open gap-doc rows that DON'T require these decisions — it skips blocked pieces and picks others. None of these block overall progress; they just constrain which specific pieces get picked.

Each item lists: the gap-doc row(s) affected, the decision needed, the cron's current default (if any), and the agent-shippable scope if you pick a non-default answer.

---

## DECISIONS LANDED 2026-05-24

The user-at-keyboard answered all open product questions. Locked answers below; each "DECIDED" block authoritative for cron picks.

### 1. Pearl-side billing (rows 215-218) — DECIDED

- **a. Who marks Pearl invoice paid?** → **Onviqa operators only** (super-admin role). Tenant admins get a read-only invoice list under Settings → Billing. No countersign workflow.
- **b. Proration on plan upgrade?** → **Pro-rate immediately on current invoice** (charge the price difference for remaining days in the current billing cycle).
- **c. Auto-debit?** → **Razorpay Subscriptions API** (extends existing per-tenant Razorpay creds from `a7d1b12`). UPI Autopay + card mandates.
- **d. Trial-period end?** → **7-day grace (read-only), then suspend.** State machine: `trial → past_due (7-day read-only window with upgrade banner) → suspended (login blocked except for billing)`.

**Now-pickable 3-piece chain:**
- 3a — `TenantSubscription` + `PlatformInvoice` schemas + state machine.
- 3b — `PlatformInvoice` generation + monthly cron + email.
- 3c — Payment recording + Razorpay Subscriptions webhook + proration logic + grace-period transitions.

**Naming note:** Use `TenantSubscription` (the thing a tenant subscribes to) and `PlatformInvoice` (an invoice the platform operator sends a tenant). Do NOT create `Pearl*`-prefixed models. Existing patient-facing `Invoice` model stays as-is (hospital→patient billing); `PlatformInvoice` is platform→tenant billing.

**Implementation defaults for piece 3a (DECIDED 2026-05-24):**

- **Plan structure:** 3 fixed plans via `enum Plan { STARTER, GROWTH, ENTERPRISE }`. Each plan has a fixed monthly INR price + an included-features array. Custom Enterprise pricing handled via a `customPriceMonthlyInPaise Int?` override field on `TenantSubscription`. Self-serve pricing page can ship later without schema change.
- **Trial duration:** 30 days. `TenantSubscription.trialEndsAt = createdAt + 30d` at signup. State machine starts in `trial` status.
- **GST on `PlatformInvoice`:** 18% GST, full tax-invoice format. Same-state tenant → CGST 9% + SGST 9%; cross-state → IGST 18%. HSN/SAC code per line item (use the SaaS SAC code `998314` — Information Technology Software Services). Mirror the existing `Invoice` model's tax-invoice convention (per-line CGST/SGST/HSN persisted, commit `#901`).
- **Currency:** INR only for Stage 1. Store prices in paise (`Int`) following the existing `Invoice` convention.
- **Billing cycle:** Monthly. Invoice generated on the 1st of each month for the previous month's usage. Cron job in `apps/api/src/services/`.
- **Invoice number format:** `PI-YYYYMM-NNNN` (e.g. `PI-202605-0001`), monotonic per-month sequence across all tenants. `PI` = Platform Invoice (vs `INV-*` for the existing hospital-to-patient `Invoice`).

### 2. Book Appointment patient PWA UX (row 161) — DECIDED

- **TOKEN-mode doctors:** Patient **picks a specific token number (T-15)** ahead. Backend assigns token at booking, not on arrival. Deterministic; patient sees "Token 15, ~10:30 AM ETA" on the booking confirmation.
- **CALLING-mode doctors:** **Pre-register with ETA window, then 'I've arrived' at the clinic.** Patient books a date + ETA window (e.g. "between 10–11 AM"). Doctor sees the expected queue; patient taps the existing 'I've arrived' button (commit `dc98bd5`) at the clinic to enter actual call-order.
- **SLOT-mode doctors:** Standard slot picker (mirrors mobile app pattern).

**Now-pickable:** Single-piece UI build (~400-600 LOC). Reuses existing `/api/v1/appointments/book` endpoint with the channel parameter from booking-form filter (`92f0099`). Cascades to unblock rows 337 (campaign self-book attribution), 339 (new-patient self-register <90s), 340 (returning-patient arrive flow).

### 3. Row 209 — granular super-admin permissions — DECIDED (Stage-1 scope reduced)

**Decision:** Add 2 new Roles to the existing `Role` enum (in BOTH `packages/db/prisma/schema.prisma` AND `packages/shared/src/types/roles.ts`):
- `PLATFORM_OPERATOR` — Onviqa staff running medcore; can onboard tenants, manage feature flags, run DPDP jobs, view billing.
- `PLATFORM_BILLING_OPERATOR` — Onviqa finance staff; billing-only (view tenants, view/mark-paid invoices, view payments). No tenant config access.

Route guards stay `authorize(Role.X)` pattern. ~1-day ship. Covers ~80% of Pearl Stage-1 need.

**Do NOT use `PEARL_*` naming** — these are platform-level roles, not tenant-specific.

**Out of scope for Stage 1:** Full per-tenant / per-module `Permission` / `Grant` tables — deferred to Stage 2. Row 209 will flip to ✅ once the new roles + route-guard updates land.

### 4. BILLING role on shared TS enum — DECIDED

**Decision:** Extend `packages/shared/src/types/roles.ts` `Role` enum with `BILLING`. ~4 route `authorize()` calls (TDS `182eb91`, no-show `28a2422`, commission `ddcffcf`, lead-funnel `2d3e9ac`) + test fixtures flip to also accept BILLING.

### 5. DPDP purge wider table scope — DECIDED

**Decision:** Extend `services/dpdp-purge.ts` to cover the 6 deferred tables now (Admission, LabOrder, Allergy, ChronicCondition, Surgery, RadiologyStudy + their sub-tables). ~50 LOC per table; single tick. Closes DPDP Act §17 compliance gap before pilot.

### 6. Lighthouse CI as deploy gate — DECIDED

**Decision:** Add `needs: lhci` to `deploy.yml`. Perf<85 / A11y<95 fail blocks the deploy. PRD §6.2 thresholds become hard requirements. Workflow file: `.github/workflows/lighthouse.yml` (`63f6d64`) + `.github/workflows/deploy.yml`.

### 7-10. Items unchanged (operational policy / not user-decided)

Items 7-10 below are operational items the cron handles via its defaults; they don't block any picks.

---

## 🛑 HARD BLOCKERS — ALL DECIDED 2026-05-24 (see "DECISIONS LANDED" section at top of doc)

### 1. Pearl-side billing business logic (#6 piece 3, gap row 215-218) — ✅ DECIDED

**Affects:** §2 rows 215, 216, 217, 218 (Pearl-side invoice generation, payment recording, subscription state machine, upgrade/downgrade proration). PRD §8.3.

**Why blocked:** The schema (`PearlSubscription` + `PearlInvoice`) is straightforward, but the business rules need your call:

- **a. Who can mark a Pearl invoice paid?** Only Onviqa operators (super-admin role), or also tenant admins viewing read-only with operator countersign?
- **b. Proration on plan upgrade?** Pro-rate to current month (charge the diff on the existing invoice), or charge full new-plan amount at next billing cycle (no proration)?
- **c. Auto-debit integration?** Razorpay subscriptions API, or separate corporate banking integration via NEFT/RTGS? (If Razorpay subscriptions: extends the existing per-tenant Razorpay creds from `a7d1b12`.)
- **d. Trial-period semantics?** Hard-stop access at end of trial (force upgrade), or grace period (e.g. 7 days read-only)?

**Cron default:** SKIP these pieces. Cron picks other Tier-3 work first.

**If you decide:** A 3-piece chain becomes pickable:
- 3a — `PearlSubscription` + `PearlInvoice` schemas + Pearl-side state machine (trial→active→past_due→suspended).
- 3b — Pearl invoice generation + email (monthly cron).
- 3c — Payment recording + auto-debit (or manual entry) + proration logic.

---

### 2. Book Appointment patient PWA UX (#5 piece 3i, gap row 161) — ✅ DECIDED

**Affects:** §2 row 161 (patient self-booking on the PWA).

**Why blocked:** PRD §6.1 says "channel-aware booking flow per doctor's configured mode (slot picker / token estimate / 'walk in any time' for calling-mode)." Three doctor modes (TOKEN/SLOT/CALLING) each need a distinct UX. You haven't picked the patient-side semantics:

- **For TOKEN-mode doctors:** Do patients book a specific token number (T-15) ahead, or get an ETA estimate ("you'll be ~T-15 if you arrive at 10am")?
- **For CALLING-mode doctors:** Just "I'll come" → adds to `arrivalSeq` on arrival, OR pre-register with an ETA (lets the doctor anticipate)?
- **For SLOT-mode doctors:** Standard slot picker (matches mobile app pattern). No decision needed here.

**Cron default:** SKIP this piece. Cron picks other #5 chain pieces first (WhatsApp 3j-i, ii, iii, iv).

**If you decide:** Single-piece UI build (~400-600 LOC). Reuses existing `/api/v1/appointments/book` endpoint with the channel parameter from the booking-form filter (`92f0099`).

---

## 🟡 SOFT BLOCKERS — cron has a sensible default, but you might prefer otherwise

### 3. VIEW_ALLOWED client-side gate on dashboard pages (CLAUDE.md A1)

**Affects:** Many dashboard pages today have NO client-side `VIEW_ALLOWED` gate. Non-allowlisted roles see a partial shell + empty list rather than `/dashboard/not-authorized`. Security depends entirely on the API's `authorize(...)`.

**Cron default:** Status quo — API-only gating, no client gates added. Picks happen as normal.

**If you decide we should add gates:** ~12-18 page-by-page gate additions, can be a single sweep tick.

---

### 4. `BILLING` role missing from `packages/shared/src/types/roles.ts` — ✅ DECIDED (add it)

**Affects:** Multiple recent reports (TDS `182eb91`, no-show `28a2422`, commission ledger `ddcffcf`, lead-funnel `2d3e9ac`) are ADMIN-only because the shared TS `Role` enum doesn't include `BILLING` even though Prisma's does. BILLING role users currently can't access these reports despite being natural consumers.

**Cron default:** Continue ADMIN-only. New reports follow the same pattern.

**If you decide we should add BILLING:** Single-piece edit — extend shared Role enum + 4 line edits in route authorize() calls + flip the test fixtures. Other ripple effects need a careful grep first.

---

### 5. DPDP purge wider table scope (just-shipped `0810b45`) — ✅ DECIDED (extend to 6 more tables)

**Affects:** `services/dpdp-purge.ts` currently hard-deletes 9 child tables (Appointment, Prescription, PrescriptionItem, Invoice, InvoiceItem, Payment, Vitals, Consultation, PatientDocument) + anonymizes Patient+User. Documented deferrals: Admission, LabOrder, Allergy, ChronicCondition, Surgery, RadiologyStudy + sub-tables.

**Question for DPDP Act 2023 §17 compliance:** Is the 9-table scope sufficient for Stage-1 pilot, or do you need fuller coverage before go-live?

**Cron default:** Ship the 9. Each added table = ~50 LOC follow-up tick.

**If you decide we should add more tables:** I can dispatch a single-piece "extend purgePatient" tick that adds the 6 deferred tables + sub-tables.

---

### 6. NHCX cashless stepper "Move to next stage" RBAC (just-shipped `0cf8f5a`)

**Affects:** Staff invoice-detail page's stepper-advance button is currently ADMIN-only per PRD §4.2 wording ("admin button for testing"). The underlying PATCH endpoint also accepts RECEPTION.

**Cron default:** Stays ADMIN-only.

**If you decide RECEPTION should also advance the stepper:** One-line change to the UI's RBAC check.

---

### 7. Lighthouse CI budget — block deploy on fail? (just-shipped `63f6d64`) — ✅ DECIDED (make it a deploy gate)

**Affects:** `.github/workflows/lighthouse.yml` currently runs independently. Failing Perf ≥85 or A11y ≥95 doesn't block the deploy. PRD §6.2 wants the thresholds as hard requirements.

**Cron default:** Info-only (lenient). Test workflow stays the deploy gate.

**If you decide Lighthouse should gate deploys:** Add a `needs: lhci` to the deploy.yml job. Small change.

---

## 🔵 OPERATIONAL POLICY CHOICES — non-blocking, but worth your attention

### 8. Test workflow paths-filter skipping UI-only commits

**Affects:** Sourav's UI-only PRs (`a1a15d0` `bf6bb31` `244456d`) skip the Test workflow because of `paths:` filter. My commits trigger Test normally.

**Cron default:** No action — workflow filters are working as configured.

**If you decide UI-only commits should also run Test:** Tighten the `paths:` filter so anything under `apps/web/src/**` triggers Test.

---

### 9. Pre-pilot success criteria archive (gap doc §9)

**Affects:** §9 rows are measured DURING pilot, not built in code. Cron correctly ignores them per the prompt rule. They sit at 🟡/❌ until pilot.

**Cron default:** Leave them in the gap doc; they don't count toward termination.

**If you decide to archive them:** Move §9 to a separate `PEARL_STAGE1_PILOT_RUBRIC.md` so the gap-close burn-down "completes" cleanly when only-engineering rows hit zero.

---

### 10. Cron auto-expiry (harness limit)

**Affects:** Cron `927f94ca` auto-expires in 7 days from arming (~2026-05-30). After that, no autonomous progress until re-armed.

**Cron default:** Just expires. Nothing to lose — closures up to that point are all in git.

**If you decide to keep autonomy running longer:** Re-fire the same cron-create prompt at any time. The session-only nature means it dies if THIS Claude session ends regardless.

---

## ℹ️ STATUS AT WRITE TIME

- **Autonomous mode:** ✅ ON. Cron `927f94ca` armed at `7,22,37,52 * * * *` (every 15 min, up to 3 parallel agents per tick on non-overlapping files).
- **Open gap-doc rows:** ~40 remaining (down from 80 at the rebuild).
- **CI on HEAD `e9948e1`** (piece 3j-i): pending at write time.
- **Tier-3 chains active:** #4 piece 4 (Campaigns UI), #5 chain (book + whatsapp 3j-i+ii+iii+iv), #6 chain (wizard remaining steps + Pearl billing + metrics + DPDP).

## What the cron will pick while you sleep

Without you in the loop, the cron will work through these in priority order (lots of slack for picks):

1. **WhatsApp pieces 3j-ii, 3j-iii, 3j-iv** — webhook + inbox UI + reply (3 pieces).
2. **#6 piece 2b wizard remaining 5 steps** — HFR / HPR / WhatsApp / Razorpay / post-creation.
3. **§7.2 row 190 skeleton loaders universal sweep.**
4. **§6.2 row 172 44px touch-target audit.**
5. **Stage 2 prep tickets** — open issues/scope docs for Voice AI Receptionist, AI Discharge, NABH Dashboard, ABDM M2/M3/M4, etc. (not buildable Stage-1; cron defers).
6. Any other ❌/🟡 row that fits single-commit-cluster sizing.

The cron self-terminates when §2/§3/§4/§6/§7/§8/§11 hit zero ❌/🟡.

---

End of decisions doc. Add answers inline (or as separate commits) when back at the keyboard.
