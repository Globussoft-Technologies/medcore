# Pearl PRD — Open Decisions (for the user when back at the keyboard)

**Last updated:** 2026-05-23 (session-end while user sleeps; cron `927f94ca` continues autonomously).

## How to read this doc

These are decisions the autonomous gap-close cron CANNOT make on its own. The cron will keep picking from the ~40 open gap-doc rows that DON'T require these decisions — it skips blocked pieces and picks others. None of these block overall progress; they just constrain which specific pieces get picked.

Each item lists: the gap-doc row(s) affected, the decision needed, the cron's current default (if any), and the agent-shippable scope if you pick a non-default answer.

---

## 🛑 HARD BLOCKERS — cron skips these pieces until you decide

### 1. Pearl-side billing business logic (#6 piece 3, gap row 215-218)

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

### 2. Book Appointment patient PWA UX (#5 piece 3i, gap row 161)

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

### 4. `BILLING` role missing from `packages/shared/src/types/roles.ts`

**Affects:** Multiple recent reports (TDS `182eb91`, no-show `28a2422`, commission ledger `ddcffcf`, lead-funnel `2d3e9ac`) are ADMIN-only because the shared TS `Role` enum doesn't include `BILLING` even though Prisma's does. BILLING role users currently can't access these reports despite being natural consumers.

**Cron default:** Continue ADMIN-only. New reports follow the same pattern.

**If you decide we should add BILLING:** Single-piece edit — extend shared Role enum + 4 line edits in route authorize() calls + flip the test fixtures. Other ripple effects need a careful grep first.

---

### 5. DPDP purge wider table scope (just-shipped `0810b45`)

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

### 7. Lighthouse CI budget — block deploy on fail? (just-shipped `63f6d64`)

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
