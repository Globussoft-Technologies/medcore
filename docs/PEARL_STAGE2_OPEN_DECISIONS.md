# Pearl Stage-2 PRD — Open Decisions (for the operator at the keyboard)

**Last updated:** 2026-05-25 — **all 5 HARD BLOCKERs + 3 soft blockers DECIDED by user-at-keyboard**. Cron lanes unblock; productisation work picks up on next tick.

---

## DECISIONS LANDED 2026-05-25

The user-at-keyboard answered the Stage-2 product questions. Locked answers below; each "DECIDED" block authoritative for cron picks.

### 1. Plan-tier expansion — DECIDED (keep 3 tiers, suggested expansion)
- **STARTER**: OPD-only (Stage-1 baseline; unchanged)
- **GROWTH** adds: `hl7Inbound` (LIS), `telemedicine` (video), `hrmsPayroll` (HR), `assetTracker`
- **ENTERPRISE** adds: `abdmAdvanced` (M2/M3), `voiceRx` (Voice-Rx end-to-end including Aadhaar e-Sign), `aiDischarge`, `nabhDashboard`, `aiRadiology`, all 6 `ai*` predictive flags
- **Price bump**: STARTER ₹4,999/mo unchanged; GROWTH ₹14,999/mo unchanged; **ENTERPRISE bumps from ₹39,999 to ₹69,999** to reflect IPD/OT/AI bundle expansion
- Update `packages/shared/src/billing/plans.ts` `PLAN_DEFINITIONS` accordingly
- ~20 Bucket-A productisation rows unblock

### 2. À-la-carte SKUs — DECIDED (hybrid)
- **À-la-carte SKUs (8)**: `predictiveSepsis`, `predictiveNoShow`, `predictiveDeterioration`, `aiCapacity`, `aiRoster`, `aiCoaching`, `aiFollowup`, `aiFraud`, plus `assetTracker` and `nabhDashboard` as separate SKUs — buyable individually on top of tier subscriptions
- **Tier-bundled (not à-la-carte)**: `ipd`, `ot`, `hl7Inbound`, `telemedicine`, `voiceRx`, `abdmAdvanced` (share infrastructure; tier-bound makes more sense)
- **Razorpay strategy**: Each à-la-carte flag = one Razorpay add-on SKU (8-10 SKUs). Plumb via existing per-tenant Razorpay creds
- **UI**: Super-admin → Tenants → Tenant detail → "Add-ons" tab with SKU catalogue + toggle + price
- Adds ~8 weeks of parallelizable plumbing work

### 3. ABDM M2/M3 sandbox enrolment — DECIDED (operator drives)
- Onviqa team provisions ABDM sandbox creds for Pearl Women's & Children's Hospital + walks hospital admin through HFR + HPR enrolment via Stage-1 Settings → ABDM wizard
- **Target: complete within 2 weeks** of 2026-05-25
- §S2.8 productisation rows unblock once creds land

### 4. Voice AI Receptionist provider — DECIDED (Sarvam in-house)
- **Sarvam ASR + Sarvam-LLM + Sarvam TTS** (India-hosted, DPDP-friendly)
- Reuses the existing Sarvam abstraction in `services/ai/`
- ~6 weeks engineering (higher than US-hosted options but no Cross-Border Data Transfer assessment needed)
- §S2.13 4 greenfield rows now buildable

### 5. DICOM viewer / PACS backend — DECIDED (OHIF + Orthanc)
- **Frontend**: OHIF Viewer (open-source MIT, React, ~2-3 MB bundle)
- **Backend**: Self-hosted Orthanc DICOM server as the DICOMweb backend
- **Schema**: New `DicomStudy` model with FK to existing `RadiologyStudy` (do NOT extend `imageUrls` JSON — keep DICOM metadata first-class)
- **Modality worklist (MWL) integration**: Deferred to Stage 3
- ~6-8 engineer-weeks
- §S2.17 4 rows unblock

### 6. Aadhaar e-Sign vendor — DECIDED (NSDL e-Gov)
- Voice-Rx productisation (§S2.5 e-Sign sub-row) integrates NSDL e-Gov ESP
- ~2-3 weeks integration
- Voice-Rx end-to-end flow completes once e-Sign lands

### 7. Predictive CDS sub-flags — DECIDED (split into per-model flags)
- Add to `FEATURE_KEYS` constant: `predictiveSepsis`, `predictiveNoShow`, `predictiveDeterioration` (the existing `aiCapacity`, `aiRoster`, `aiCoaching`, `aiFollowup`, `aiFraud` stay as-is)
- Retire the single `predictiveCds` umbrella flag (or keep as a legacy alias that ORs the 3 new sub-flags)
- Per-route `requireFeature(...)` wiring updates accordingly
- Enables the à-la-carte SKU model from decision #2

### 8. NABH dashboard scope — DECIDED (pilot subset, 7-10 indicators, ~2 weeks)
- Stage-2 ships a focused subset of NABH 5th-edition indicators
- Suggested 7-10 highest-value indicators: mortality rate, hospital-acquired infection rate, medication-error rate, fall rate, surgical-site infection rate, blood-transfusion-reaction rate, patient-satisfaction score, return-to-OT rate, average length-of-stay, readmission-within-30-days rate
- Stage-3 extends to full 1-21 standard set based on pilot feedback

### Naming reminder
Per the Stage-1 naming-correction (locked 2026-05-24): NEW schema models and role enum values MUST be tenant-agnostic. New DICOM model name = `DicomStudy` (not `PearlDicomStudy`). New SKU model name (if needed for à-la-carte) = `TenantAddon` or `PlatformAddonSku` (not `Pearl*`).

> **Naming convention:** "Pearl" is the pilot tenant, NOT the product. The product is MedCore HMS; Onviqa is the platform operator. New schema models and role enum values MUST be tenant-agnostic. Do NOT create `Pearl*`-prefixed models. (Carries forward from Stage-1 OPEN_DECISIONS — see that doc for full rationale.)

## How to read this doc

These are decisions the autonomous gap-close cron (when re-pointed at [`PEARL_STAGE2_GAP_ANALYSIS.md`](./PEARL_STAGE2_GAP_ANALYSIS.md)) CANNOT make on its own. The cron will keep picking the ~38 open Stage-2 rows that DON'T require these decisions; these block specific lanes only.

Each item lists: the gap-doc row(s) affected, the decision needed, the cron's current default (if any), and the engineering scope unlocked once decided.

---

## STAGE-1 DECISIONS THAT CARRY FORWARD

Read [`PEARL_OPEN_DECISIONS.md`](./PEARL_OPEN_DECISIONS.md) first — its DECISIONS LANDED 2026-05-24 section locked the foundational pieces this doc builds on:

- 3 plans `STARTER` / `GROWTH` / `ENTERPRISE` + Stage-1 feature-flag map
- `TenantSubscription` + `PlatformInvoice` schema + state machine
- Razorpay Subscriptions auto-debit
- 30-day trial + 7-day grace → suspend
- 18% GST tax-invoice format
- `PLATFORM_OPERATOR` + `PLATFORM_BILLING_OPERATOR` + `BILLING` roles
- Per-feature `Tenant.featureFlags` JSON override layered on plan defaults

Stage 2 extends all of these — does NOT replace them.

---

## 🛑 HARD BLOCKERS — ALL DECIDED 2026-05-25 (see "DECISIONS LANDED" section at top of doc)

### 1. Stage-2 plan-tier → feature-flag bundle mapping

**Affects:** [`PEARL_STAGE2_GAP_ANALYSIS.md`](./PEARL_STAGE2_GAP_ANALYSIS.md) §2 — every Bucket A row (12 modules).

**Why blocked:** Stage-1 OPEN_DECISIONS #1 locked the *baseline* feature map (STARTER = OPD-only; GROWTH = +lab/radiology/abdm_m1; ENTERPRISE = +ipd/ot/abdm_m2/ai_scribe). Stage 2 adds 8+ new flag surfaces (`telemedicine`, `voiceRx`, `aiDischarge`, `predictiveCds` family, `aiRadiology`, `nabhDashboard`, `abdmAdvanced`, `hrmsPayroll`, `hl7Inbound`, `assetTracker`, plus à-la-carte AI sub-flags). Question: how do these layer onto STARTER/GROWTH/ENTERPRISE? Do you add a 4th tier (PLATINUM) for the AI-heavy bundle?

- **a. Tier inclusions:** Confirm which Stage-2 flags ship with which tier. Suggested defaults:
  - **GROWTH adds:** `hl7Inbound` (LIS), `telemedicine` (video), `hrmsPayroll` (HR), `assetTracker` (assets).
  - **ENTERPRISE adds:** `abdmAdvanced` (M2/M3), `voiceRx` (Voice-Rx end-to-end including Aadhaar e-Sign), `aiDischarge`, `nabhDashboard`, `aiRadiology`, all 6 `ai*` predictive flags.
  - **No new tier proposed** — keep 3 tiers, use à-la-carte add-on SKUs for granular sales (see HARD BLOCKER #2).
- **b. Pricing per tier:** Stage-1 OPEN_DECISIONS placeholder prices were ₹4,999 / ₹14,999 / ₹39,999. Stage 2 inclusion expansion → bump ENTERPRISE to (suggested) ₹69,999 to reflect the IPD/OT/AI bundle, or keep prices flat?

**Cron default:** SKIP every Bucket-A productisation row. Cron picks Bucket-B greenfield (where the build doesn't depend on tier-mapping) and tooling rows first.

**If you decide:** ~20 productisation rows unblock. Each is 1-2 weeks of engineering.

---

### 2. À-la-carte add-on SKUs vs tier-only bundling

**Affects:** §2 §S2.6 (Predictive CDS — 6 sub-flags); §S2.4 Telemedicine; §S2.11 Asset; §S2.10 HRMS sub-flags; §3 cross-cutting row "Per-module à-la-carte billing add-on".

**Why blocked:** Some Stage-2 features are natural à-la-carte upsells ("buy AI Roster for ₹X/month"). Others are part of larger tier bundles (IPD/OT/Lab). Question: does Stage 2 support per-flag SKU sales on top of tier subscriptions, or is the tier-only model sufficient?

- **a. Recommended pattern:** **Support à-la-carte for the 6 `ai*` flags + `assetTracker` + `nabhDashboard`** since those are individually marketable. Keep `ipd`/`ot`/`hl7Inbound`/`telemedicine`/`voiceRx`/`abdmAdvanced` as tier-bundled because they share infrastructure (ABDM, lab QC, scribe).
- **b. Razorpay subscription SKU strategy:** Each à-la-carte flag = one Razorpay add-on SKU? Or single "AI Pack" SKU that unlocks N flags?
- **c. UI shape:** Operator's super-admin sees a per-tenant "Add-ons" tab showing the SKU catalogue with toggle + price? Or only via operator-only flag overrides?

**Cron default:** Tier-only — no à-la-carte SKUs. Cron picks tier-only productisation lanes.

**If you decide à-la-carte ON:** Add ~1 week per à-la-carte SKU for the Razorpay add-on plumbing + super-admin SKU-catalogue UI. Initial estimate: 8 SKUs × 1 week = 8 weeks (but parallelizable).

---

### 3. DICOM viewer library / PACS backend choice

**Affects:** §2 §S2.17 RIS / PACS / DICOM viewer (all 4 sub-rows ❌ Missing).

**Why blocked:** Four credible options, each with different schema + licensing + ops implications:

- **OHIF Viewer** (open-source, MIT, React-based, heavy bundle ~2-3 MB) — best UX, easiest to layer on AI triage; needs DICOMweb backend (e.g. Orthanc or AWS HealthLake Imaging).
- **Cornerstone.js** (open-source, MIT, lightweight) — flexible primitives; we'd build the viewer chrome ourselves; smallest bundle.
- **Orthanc + Orthanc Web Viewer** (open-source GPL/AGPL) — full PACS server + viewer; licensing review needed for commercial deployment.
- **Commercial (Ambra Health, Visage, Sectra)** — turnkey + supported; per-study or per-tenant licensing fees that scale with hospital volume; longest procurement cycle.

Sub-decisions:
- **a. Storage backend:** Self-hosted Orthanc DICOM server, or AWS HealthLake Imaging (managed), or per-tenant S3 with custom DIMSE bridge?
- **b. Modality worklist (MWL) integration:** First-class Stage 2, or deferred? Affects RIS scheduling shape.
- **c. Where do DICOM studies live?** Extend `RadiologyStudy.imageUrls` JSON, or new `DicomStudy` model with FK to RadiologyStudy?

**Cron default:** SKIP all §S2.17 rows. Cron picks other Bucket-B greenfields first.

**If you decide:** ~6-8 engineer-weeks of build (with OHIF as the most likely pick).

---

### 4. ABDM M2/M3 + NHCX sandbox creds + HFR/HPR live enrolment

**Affects:** §2 §S2.8 (ABDM M2/M3/M4) — all 3 rows productisation-blocked; §4 integration table; §8 compliance row "ABDM M2 consent artefact retention" testing.

**Why blocked:** Code-side ABDM M2 hooks are ~80% complete (surprise from the survey — see §1 of gap doc). The blocker is that no live ABDM sandbox tenant has been provisioned for testing. Sub-decisions:

- **a. Pearl Women's & Children's Hospital ABDM sandbox enrolment:** Has Pearl been registered on the ABDM sandbox as a HIP (Health Information Provider)? If not, who drives the enrolment — operator or hospital admin?
- **b. HFR (Healthcare Facility Registry) ID + HPR (Health Professional Registry) IDs:** Stage-1 wizard captures these as drafts. The "first ADMIN finalises in Settings → ABDM" step is the moment ABDM-side enrolment happens. Has this been triggered against the live sandbox?
- **c. NHCX sandbox cred (for §S2.8 M4 protocol scaffolding):** Separate provisioning track. Stage-3 deferral for live insurer integration per PRD §4.2.

**Cron default:** SKIP all §S2.8 productisation rows. Code stays in `services/abdm/` unexposed.

**If you decide / once creds land:** Productisation rows become 1-2 weeks each (mostly wire flag + expose UI).

---

### 5. Voice AI Receptionist provider choice

**Affects:** §2 §S2.13 Voice AI Receptionist (all 4 rows greenfield).

**Why blocked:** Build commitment carried in Mykare PR #909 per Stage-1 gap doc §10. Five credible providers, very different cost / latency / India-presence profiles:

- **Retell AI** (US-based, OpenAI Realtime under the hood, ~$0.07/min) — best latency, no India POP, data residency concern.
- **Vapi** (US-based, similar pricing, more flexible LLM choice) — similar trade-offs.
- **Bland AI** (US-based, cheaper at ~$0.04/min, slower) — cost leader but UX trade-off.
- **ElevenLabs Conversational** (US/UK, premium TTS, ~$0.30/min) — best voice quality, expensive.
- **In-house stack: Sarvam ASR + Sarvam-LLM + Sarvam TTS** — India-hosted (DPDP-friendly), highest engineering cost, no canonical Stage-2 budget for this build.

Sub-decisions:
- **a. Data residency:** DPDP Act 2023 implications — call recordings + transcripts contain PII. US-hosted providers need a Cross-Border Data Transfer assessment. India-hosted (Sarvam) is the safer pick but the highest build cost.
- **b. Pricing model:** Pass-through per-minute to the tenant, or bundle into ENTERPRISE+ add-on SKU?
- **c. Call recording retention:** Default retention period + DPDP purge integration.
- **d. Inbound vs outbound vs both:** Stage 2 ships inbound first, outbound (follow-up/collection) in a later piece, or both at once?

**Cron default:** SKIP all §S2.13 rows. Cron picks other Bucket-B greenfields first.

**If you decide:** 4-6 engineer-weeks once provider locked in.

---

## 🟡 SOFT BLOCKERS — cron has a sensible default, but you might prefer otherwise

### 6. Aadhaar e-Sign ESP vendor (NSDL / SureSign / Indxform)

**Affects:** §2 §S2.5 Voice-Rx (Aadhaar e-Sign half) — PRD §12.d says "Full eSign with Aadhaar ESP is Stage 2".

**Cron default:** SKIP the e-Sign sub-row of §S2.5. Voice-Rx productisation proceeds without e-Sign integration; signed-PDF flow falls back to the Stage-1 NMC + SHA-256 baseline.

**If you decide:** 2-3 weeks for chosen ESP integration. NSDL e-Gov is the safe default (longest track record); SureSign / Indxform are competitive on pricing.

---

### 7. Predictive CDS — split `predictiveCds` flag into 6 sub-flags for à-la-carte

**Affects:** §2 §S2.6 — single `predictiveCds` flag today covers sepsis + no-show + deterioration. Split into per-model flags?

**Cron default:** Keep single `predictiveCds` flag. Stage-1 inheritance.

**If you decide split:** ~1 day to add 3 new flag keys (`predictiveSepsis`, `predictiveNoShow`, `predictiveDeterioration`) + per-route wiring. Enables granular à-la-carte sales per HARD BLOCKER #2 decision.

---

### 8. NABH dashboard scope — full 5th-edition or pilot subset?

**Affects:** §2 §S2.12 NABH Quality Dashboard.

**Cron default:** SKIP the row (no code to productise; pure greenfield).

**Question:** Full NABH 5th-edition 1-21 standard set (6-week build), or a pilot subset of 7-10 highest-value indicators (2-week build) that you extend later?

---

### 9. Nurse-Call hardware partner

**Affects:** §2 §S2.15 Nurse-Call System.

**Cron default:** SKIP all §S2.15 rows. Software-side build can proceed without hardware if test fixtures are stubbed, but no real-world pilot can begin without hardware.

**If you decide partner:** 4 weeks software (in parallel with hardware partner's timeline). Likely candidates: BLE button → ESP32 → MQTT broker → MedCore nurse-call event endpoint.

---

### 10. Thermal printer vendor + ESC/POS template depth

**Affects:** §2 §S2.18 Self-service kiosk + Bluetooth thermal printer.

**Cron default:** SKIP. Operator needs to procure 2-3 thermal printer models for testing.

**Likely test devices:** Bixolon SPP-R310 (Bluetooth, well-documented ESC/POS), Honeywell RP4, Epson TM-P20.

---

### 11. TTS provider for §S2.19

**Affects:** §S2.19 Multi-language voice prompts.

**Cron default:** Extend existing Sarvam abstraction (Sarvam TTS). Lowest engineering cost.

**If you prefer:** Google Cloud TTS (better multilingual quality but data leaves India unless using Google Cloud Mumbai region). Decision matters more if §S2.13 Voice AI also goes non-Sarvam.

---

### 12. Pearl Agent Factory — confirm Stage-3 deferral

**Affects:** §2 §S2.20 + §10 Stage-3 list.

**Cron default:** Deferred to Stage 3 per recommendation in gap doc §5.3.

**Question:** Confirm explicit deferral, or hold a spot in Stage 2 with a scoping-only piece?

---

## 🔵 OPERATIONAL POLICY CHOICES — non-blocking

### 13. Stage-2 SoW authoring

**Affects:** This doc + the gap doc both flag "no Stage-2 SoW exists" as their core caveat.

**Cron default:** No action — work happens against the synthesised charter in §0 of the gap doc.

**If you'd prefer:** Have the operator author a Stage-2 SoW mirroring `PEARL-ERP-STAGE-1-SOW.md` shape and check it into `docs/PEARL-ERP-STAGE-2-SOW.md`. Then the gap doc rebuilds against the actual PRD instead of the synthesised charter.

---

### 14. Dedupe `/dashboard/operating-theaters` + `/operating-theatres` + `/ot` route dirs

**Affects:** §S2.2 OT productisation row notes a three-way route-dir duplicate.

**Cron default:** Leave alone (pre-existing).

**If you'd prefer cleanup:** Single doc-roll commit during Stage-2 prep.

---

### 15. Add `/dashboard/ai-coaching/` page

**Affects:** §S2.6 row notes the page is missing (route exists, dashboard dir doesn't).

**Cron default:** Add when picking up §S2.6 productisation.

---

### 16. Move §9 pilot rubric to a standalone `PEARL_STAGE2_PILOT_RUBRIC.md`?

**Affects:** Cron burn-down — pilot rows don't ever flip ✅ pre-pilot, so they pollute the open-rows count.

**Cron default:** Leave in §9 of gap doc; cron correctly skips per the §0 termination criteria.

**If you'd prefer:** Move to separate file (mirror of `PEARL_STAGE1_PILOT_RUBRIC.md` if you ever pull the Stage-1 §9 out).

---

## ℹ️ STATUS AT WRITE TIME

- **Autonomous mode:** Not yet armed for Stage 2. Re-arm after HARD BLOCKERs land.
- **Open gap-doc rows:** ~38 across §2/§3/§4/§7/§8/§11.
- **Stage-1 OPEN_DECISIONS:** ALL DECIDED 2026-05-24 — Stage-2 OPEN_DECISIONS is the new operator inbox.
- **No Stage-2 SoW in-repo at write time** — see policy item #13.

## What the cron will pick while you decide

Without HARD BLOCKER resolutions, the cron will pick from these non-blocked lanes:

1. **Per-feature usage metering** (cross-cutting §3 row) — schema + counter hooks; no plan decision needed.
2. **Stage-2 module audit-log entity coverage extension** — pure productisation.
3. **DPDP-purge wider-table extension to Stage-2 entities** — pure productisation.
4. **§S2.11 Asset productisation** — wire `assetTracker` flag (small lift).
5. **§S2.14 AI Discharge LLM-draft greenfield** — reuses Sarvam, no provider decision needed.
6. **§S2.9 LLM-personalised reminders greenfield** — reuses Sarvam.
7. **§S2.10 HRMS productisation** — wire `hrmsPayroll` across routes; no plan-tier decision needed for the *wiring* (only for the marketing).
8. **`/dashboard/operating-theaters` route-dir cleanup** (policy #14).
9. **`/dashboard/ai-coaching/` page add** (policy #15).
10. **Stage-2 acceptance-spec scaffolds** — `e2e/stage-2-*.spec.ts` skeletons (timing brackets, skip-when-API-down posture mirroring Stage-1 patterns).

The cron self-terminates when §2/§3/§4/§7/§8/§11 hit zero ❌/🟡 (same termination rule as Stage 1).

---

End of Stage-2 decisions doc. Add answers inline (or as separate commits) when ready.
