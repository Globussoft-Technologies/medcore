# MedCore vs Pearl ERP Stage 2 — Gap Analysis

**Source charter:** Synthesised from [`PEARL_STAGE1_GAP_ANALYSIS.md`](./PEARL_STAGE1_GAP_ANALYSIS.md) §10 "Out-of-scope (Pearl Stage 2+)" + [`PEARL-ERP-STAGE-1-SOW.md`](./PEARL-ERP-STAGE-1-SOW.md) §18 + scattered `(Stage 2)` / `(Stage 2 if budget allows)` mentions in §3/§4/§7/§8 of the same SoW. **No dedicated Stage-2 SoW exists at session start** — this doc is the working charter until one lands.

**MedCore state surveyed against:** `HEAD = 9456178` on `main` (post Stage-1 engineering-complete commit `0c0b722`), schema `packages/db/prisma/schema.prisma` (~150 models including Ward/Bed/Admission/Surgery/AnesthesiaRecord/OperatingTheater/TelemedicineSession/RadiologyStudy/RadiologyReport/Asset/LeaveBalance/StaffCertification/OvertimeRecord), API surface `apps/api/src/routes/` (~140 route files including all 18 `ai-*.ts` routes + `admissions.ts` 23 endpoints + `surgery.ts` 15 + `telemedicine.ts` 19 + `lab.ts` 20 + `hl7v2.ts` + `abdm.ts` 30 + `hr-ops.ts` 17 + `leaves.ts` 11 + `payroll` via `services/payroll.ts`), web surface `apps/web/src/app/dashboard/` (~100 dashboard routes including `/admissions`, `/operating-theaters` + `/operating-theatres`, `/telemedicine`, `/scribe`, `/ai-radiology`, `/ai-fraud`, `/ai-kpis`, `/ai-roster`, `/ai-followup`, `/predictions`, `/payroll`, `/leave-management`, `/assets`, `/wards`, `/medication`).

**Purpose:** Per-module coverage map for delivering a *Pearl ERP Stage 2* upgrade to a Stage-1-live tenant. Calls out (i) which Stage-2 deliverables already exist in MedCore but need productisation (feature-flag + plan-tier binding + upgrade UX), and (ii) which are genuinely greenfield builds.

**Author:** Senior-architect audit, no marketing varnish. Bucket-A/B split per §10 of the Stage-1 doc.

---

## 0. Stage-2 charter

Pearl Stage-2 is the **upsell ladder** the operator (Onviqa) walks each Stage-1 tenant up after the OPD shell goes live and is being used at ≥80% on PRD §16 criteria. It splits into two buckets:

- **Bucket A — Productise existing MedCore code (12 modules):** IPD, OT, LIS/HL7 inbound, Telemedicine + video, AI Scribe / Voice-Rx, Predictive CDS (6 separately-flagged AI surfaces), AI image triage (radiology), ABDM M2/M3/M4 + NHCX live, LLM-personalised reminders, HRMS/payroll, Asset/biomed tracker, NABH Quality Dashboard. **Engineering cost per module is small** — the code exists; the work is plan-tier mapping in `Tenant.featureFlags`, an upgrade-prompt UX on locked nav items, per-feature usage metering, and the operator-side "enable this for tenant X" action in the super-admin UI.
- **Bucket B — Greenfield builds (8 modules):** Voice AI Receptionist (Mykare PR #909 carries a build commitment), AI Discharge Summary, Nurse-Call System (as a discrete product, not just a notification trigger), Agentic Revenue Cycle, RIS/PACS/DICOM viewer, Self-service kiosk + Bluetooth thermal printer, Multi-language voice prompts (TTS asset pack), Pearl Agent Factory.

**Deferred to Stage 3 explicitly (PRD §4.2):** NHCX *live* insurer integration (Stage 2 ships ABDM M4 scaffolding; the actual go-live with insurers + PMJAY is Stage 3). **Deferred to Stage 3 effectively (size):** Pearl Agent Factory (an agent-DSL platform that is bigger than any Stage-2 module — held in scope below for visibility but marked "Stage 3 candidate" in §10).

**Expected calendar:** Stage 1 was 18 weeks per PRD §13. Stage 2 has more modules but most are productisation rather than greenfield. Starting point: **24-30 weeks for 2 engineers in parallel** (3 modules per month after the plan-tier + upgrade UX foundation lands in the first 4-6 weeks). The greenfield bucket (Voice AI Receptionist, AI Discharge, Nurse-Call as a product, DICOM viewer, kiosk) is the long tail and may push to 32-36 weeks if all five greenfield builds stay in Stage 2.

---

## 1. TL;DR — top-line gap summary

**Rough coverage of Stage-2 scope already in MedCore: ~55-60%.** Higher than it looks because (a) all 12 Bucket-A modules have working code today, gated for Pearl Stage 1 by `Tenant.featureFlags`; (b) the productisation surface (plan-tier table, upgrade UX, per-feature metering) is what Stage 2 actually needs to engineer for those modules — not the modules themselves. The remaining 40-45% is the greenfield builds (Bucket B: Voice AI Receptionist, AI Discharge, Nurse-Call System as a product, RIS/PACS/DICOM, Self-service kiosk + thermal printer, Multi-language TTS asset pack, Agentic Revenue Cycle).

### Bucket A vs B split

- **Bucket A — Productise existing code: 12 modules**, all surveyed as `✅ Code present`. Engineering work = plan-tier binding + upgrade UX + per-feature metering. Each is ~1-2 weeks not ~6-8.
- **Bucket B — Greenfield: 8 modules**, all surveyed as `❌ Missing`. Engineering work = full scoping → schema → service → API → UI → tests. Largest piece (Pearl Agent Factory) is a candidate for Stage 3 deferral.

### Top blockers — HARD BLOCKERs that need product/design decisions

Five HARD BLOCKERs surfaced (see [`PEARL_STAGE2_OPEN_DECISIONS.md`](./PEARL_STAGE2_OPEN_DECISIONS.md) for full text):

1. **Plan tier → feature-flag bundle mapping for Stage-2 modules.** Stage-1 OPEN_DECISIONS item #1 locked the 3-tier STARTER/GROWTH/ENTERPRISE skeleton + Stage-1 flags. Stage 2 needs the Stage-2 module → tier mapping (which flags unlock at GROWTH vs ENTERPRISE vs add-on SKU). Without this, the upgrade UX has nothing to show.
2. **À-la-carte vs bundled module strategy.** Pearl PRD §19 hints at "monthly subscription + usage-based components" but doesn't spell out whether (e.g.) Lab is a tier inclusion vs a separate per-module SKU. Critical for Razorpay subscription add-on plumbing.
3. **DICOM viewer library choice.** OHIF (web-based, MIT, heavy) vs Orthanc viewer (server-rendered, AGPL) vs Cornerstone.js (lightweight, custom build needed) vs commercial (Ambra/Visage). Affects schema (need a `DicomStudy` model? or layer on existing `RadiologyStudy.imageUrls`?) and licensing.
4. **ABDM M2/M3 sandbox creds + HFR/HPR onboarding completion.** Code-side M2 hooks exist (`apps/api/src/services/abdm/health-records.ts`, 26 HIP/HIU mentions) but no live ABDM sandbox tenant has been provisioned for testing. Pearl-operator action item.
5. **Voice AI Receptionist provider choice.** Retell vs Vapi vs Bland vs ElevenLabs Conversational vs in-house Sarvam + voice-LLM stack. Affects schema (call recording retention), pricing (per-minute pass-through?), latency contract.

### Top "ready Stage-2-ready-today" surface (productisation > greenfield work)

1. **AI Scribe** — `routes/ai-scribe.ts` (9 endpoints) + `services/ai/asr-providers.ts` + Sarvam ASR + SOAP draft/final on `AIScribeSession`. **Bigger than expected** — the voice-Rx loop is a few CTAs short of being a flippable Stage-2 SKU today. Flag: `voiceRx`.
2. **AI Radiology** — `routes/ai-radiology.ts` + `RadiologyStudy` + `RadiologyReport` + `services/ai/radiology-reports.ts`. CXR/ECG/retinal triage live behind `aiRadiology` flag; productisation is plan-tier + upgrade UX.
3. **All 6 predictive-CDS surfaces** — `ai-predictions.ts` (sepsis/no-show), `ai-capacity.ts` (bed/OT), `ai-followup.ts`, `ai-fraud.ts`, `ai-roster.ts`, `ai-coaching.ts`. Six separately-toggleable flags already in `packages/shared/src/feature-flags.ts`. Stage 2 = upsell ladder, not a build.
4. **IPD module** — `routes/admissions.ts` (23 endpoints) + `Ward`/`Bed`/`Admission`/`IpdVitals`/`MedicationOrder`/`MedicationAdministration`/`NurseRound`/`IpdIntakeOutput` + dashboards at `/dashboard/admissions`, `/wards`, `/medication`. Already feature-flag-gated by `requireFeature("ipd")` on `routes/admissions.ts`. Productisation only.
5. **OT module** — `routes/surgery.ts` (15 endpoints) + `OperatingTheater`/`Surgery`/`AnesthesiaRecord` + `/dashboard/operating-theaters` + `/operating-theatres` (typo'd duplicate is a doc-roll cleanup target). Gating is implicit (no `requireFeature("ot")` wiring yet — see Gap A row in §2).
6. **Lab + HL7v2 inbound** — `routes/lab.ts` (20 endpoints) + `services/hl7v2/` (7 service files including inbound + parser + roundtrip test) + `LabTest`/`LabOrder`/`LabOrderItem`/`LabResult` + `LabTestReferenceRange`. The HL7-inbound feed is exactly the Stage-2 deliverable for LIS module.
7. **Telemedicine + video** — `routes/telemedicine.ts` (19 endpoints) + `TelemedicineSession` + `services/jitsi.ts` + `/dashboard/telemedicine/waiting-room`. Flag wired.

### Current burn-down (session start, before any Stage-2 work)

Total `❌` + `🟡` markers across pickable sections (§2/§3/§4/§7/§8/§11): **~38 lines** at write time (most rows in §2 are `🟡 Productise` for Bucket A or `❌ Missing` for Bucket B). See §11 for the prioritised work list.

---

## 2. Per-module gap matrix

The matrix uses Stage-1 §10 row numbers as the canonical "S2 module" anchor. Status legend:

- `✅ Present` — code exists AND `requireFeature(<key>)` wired AND plan-tier binding decided.
- `🟡 Productise` — code exists but EITHER `requireFeature` not wired on the router OR no plan-tier binding decided yet. Engineering cost: small (1-2 weeks for the productisation surface, not the module).
- `❌ Missing` — no code at all (greenfield).
- `🛑 HARD BLOCKER` — needs a product/design decision in `PEARL_STAGE2_OPEN_DECISIONS.md` before anyone can pick the row.

### §S2.1 IPD — wards/beds/admissions/eMAR/vitals chart/IO chart/nursing notes

| Stage-2 deliverable | Status | MedCore reference | Notes |
|---|---|---|---|
| Ward + Bed master + occupancy view | 🟡 Productise | [`schema.prisma:2461`](../packages/db/prisma/schema.prisma) `Ward`, `:2478` `Bed`; [`/dashboard/wards/page.tsx`](../apps/web/src/app/dashboard/wards/page.tsx) | Code complete. Productisation work: confirm `ipd` flag is wired on `routes/admissions.ts` (it is, per the existing `requireFeature` grep) + add "Upgrade to ENTERPRISE for IPD" CTA on `/dashboard/wards` when flag is off. |
| Admission + discharge state machine | 🟡 Productise | `:2498` `Admission`; [`routes/admissions.ts`](../apps/api/src/routes/admissions.ts) (23 endpoints incl. `/discharge-summary-pdf`) | `admission.dischargeSummary` is a String? on the parent — see also §S2.14 AI Discharge for the LLM-drafted variant. |
| eMAR — Medication order + administration | 🟡 Productise | `:2576` `MedicationOrder`, `:2605` `MedicationAdministration`; [`routes/medication.ts`](../apps/api/src/routes/medication.ts); [`/dashboard/medication/page.tsx`](../apps/web/src/app/dashboard/medication/page.tsx) + [`/dashboard/medication-dashboard/page.tsx`](../apps/web/src/app/dashboard/medication-dashboard/page.tsx) | Two `/dashboard/medication*` dirs — dedupe in a doc-roll. |
| IPD vitals chart | 🟡 Productise | `:2551` `IpdVitals`; admissions sub-routes per `admissions-vitals.test.ts` | Charting UI lives under `/dashboard/admissions/[id]`. |
| Intake/Output chart | 🟡 Productise | `:2645` `IpdIntakeOutput` | Same admission sub-page. |
| Nursing notes / nurse rounds | 🟡 Productise | `:2626` `NurseRound`; admission sub-routes | — |
| Bed allocation policy + transfer | 🟡 Productise | `Bed.status` + admission transfer routes | — |

**Productisation gap for §S2.1**: Plan-tier binding for `ipd` flag → ENTERPRISE per the locked default in Stage-1 OPEN_DECISIONS item #1 plan-feature map. No engineering blocker.

### §S2.2 OT — scheduling + implants

| Stage-2 deliverable | Status | MedCore reference | Notes |
|---|---|---|---|
| OT theatre master | 🟡 Productise | `:3096` `OperatingTheater`; [`/dashboard/operating-theaters/page.tsx`](../apps/web/src/app/dashboard/operating-theaters/page.tsx) + duplicate [`/dashboard/operating-theatres/page.tsx`](../apps/web/src/app/dashboard/operating-theatres/page.tsx) + [`/dashboard/ot/`](../apps/web/src/app/dashboard/ot/) | Three-way route-dir duplicate (theaters / theatres / ot) — pre-Stage-2 cleanup target. |
| Surgery scheduling + booking | ✅ Closed 2026-05-25 | `:3113` `Surgery`; [`routes/surgery.ts`](../apps/api/src/routes/surgery.ts) (15 endpoints) | ✅ Closed 2026-05-25 (Pearl Stage-2 cron tick): `requireFeature("ot")` now wired at top of `routes/surgery.ts` right after `authenticate`; integration coverage at `apps/api/src/test/integration/surgery-feature-flag.test.ts` (default-on reachable + ADMIN-PATCHed-off → 404). |
| Anesthesia record | 🟡 Productise | `:3184` `AnesthesiaRecord` | — |
| Post-op observation | 🟡 Productise | `PostOpObservation` (referenced in Stage-1 doc §10) | — |
| Implant register / traceability | ✅ Partial — MVP closed 2026-05-25 | `Implant` model in `packages/db/prisma/schema.prisma` (added after `Surgery`) + [`routes/implants.ts`](../apps/api/src/routes/implants.ts) (POST register + GET recall lookup) + [`test/integration/implants.test.ts`](../apps/api/src/test/integration/implants.test.ts) | **MVP closed 2026-05-25 (Pearl Stage-2 cron tick)** — `Implant` schema (tenant-scoped, lot/serial/expiry capture, FKs on Surgery + User + Tenant), POST/GET routes gated by `requireFeature("ot")` + `authorize(ADMIN/DOCTOR/NURSE)`, awaited `IMPLANT_REGISTER` audit row, and 3 integration tests (happy path, cross-tenant recall isolation via `lotNumber`, `ot=false` gate). **Deferred to follow-up ticks**: PATCH/DELETE endpoints, tracker UI under `/dashboard/operating-theaters`, bulk recall workflow (per-lot notification fan-out), per-implant attachment uploads. |

**Productisation gap for §S2.2**: (a) wire `requireFeature("ot")` on `routes/surgery.ts`; (b) ship the missing Implant register; (c) consolidate the three route-dir duplicates.

### §S2.3 LIS / lab analyser HL7

| Stage-2 deliverable | Status | MedCore reference | Notes |
|---|---|---|---|
| Lab test master + reference ranges | ✅ Code present (Stage-1 visible) | `:2792` `LabTest`, `:2816` `LabTestReferenceRange` | Stays visible in Stage 1 per §10. |
| Lab order + items + results | ✅ Code present (Stage-1 visible) | `:2834` `LabOrder`, `:2867` `LabOrderItem`, `:2880` `LabResult`; [`routes/lab.ts`](../apps/api/src/routes/lab.ts) (20 endpoints) | — |
| HL7v2 inbound (lab analyser → MedCore) | 🟡 Productise | [`services/hl7v2/inbound.ts`](../apps/api/src/services/hl7v2/inbound.ts) + `messages.ts` + `parser.ts` + `segments.ts` + `roundtrip.ts`; [`routes/hl7v2.ts`](../apps/api/src/routes/hl7v2.ts) | Code is here including roundtrip tests. Productisation: `hl7Inbound` flag binding + per-tenant HL7 listener endpoint provisioning (operator side) + per-analyser-vendor message-template seed. |
| QC + Levey-Jennings + Westgard rules | ✅ Code present (Stage-1 visible per §10 carve-out for lab QC) | [`/dashboard/lab/qc/`](../apps/web/src/app/dashboard/lab/qc/) | — |
| Sample collection + barcode | ✅ Code present (Stage-1 visible) | `routes/lab.ts` sample sub-routes | — |

**Productisation gap for §S2.3**: ~~Wire `requireFeature("hl7Inbound")` on `routes/hl7v2.ts`~~ **Closed 2026-05-25 (verification-audit fix-up #3 tick)** — `requireFeature("hl7Inbound")` now wired at top of `routes/hl7v2.ts` right after `authenticate`; STARTER-tier Pearl tenants 404 on every `/api/v1/hl7v2/*` endpoint. Per-tenant HL7 listener URL provisioning + per-analyser-vendor message-template seed remain Stage-2 productisation work. Coverage at `apps/api/src/test/integration/feature-flag-coverage.test.ts`.

### §S2.4 Telemedicine + video

| Stage-2 deliverable | Status | MedCore reference | Notes |
|---|---|---|---|
| Telemedicine session model + scheduling | ✅ Present | `:3457` `TelemedicineSession`; [`routes/telemedicine.ts`](../apps/api/src/routes/telemedicine.ts) (19 endpoints, `requireFeature("telemedicine")` wired); [`/dashboard/telemedicine/`](../apps/web/src/app/dashboard/telemedicine/) + `/waiting-room` | Productisation already largely done — flag wired. Plan-tier binding decision pending. |
| Video via Jitsi | ✅ Present | [`services/jitsi.ts`](../apps/api/src/services/jitsi.ts) + tests | — |
| Auto-close stuck sessions | ✅ Present | [`services/auto-close-stuck-telemedicine.test.ts`](../apps/api/src/services/auto-close-stuck-telemedicine.test.ts) | — |
| e-Consent for telemed (per Telemedicine Practice Guidelines 2020) | 🟡 Productise | `services/consent.ts` exists but no telemed-specific consent artefact spelled out | Audit + add explicit consent capture before first session. Small. |
| Recording + retention | 🟡 Productise | `services/audio-retention.ts` exists; integration unclear | Verify recording → audio-retention → DPDP purge pipeline closes for telemed sessions specifically. |

### §S2.5 AI Scribe / Voice-Rx

| Stage-2 deliverable | Status | MedCore reference | Notes |
|---|---|---|---|
| ASR pipeline (Sarvam) | ✅ Present | [`services/ai/asr-providers.ts`](../apps/api/src/services/ai/asr-providers.ts), [`services/ai/sarvam.ts`](../apps/api/src/services/ai/sarvam.ts) | — |
| AIScribeSession + SOAP draft/final | ✅ Present | `AIScribeSession.soapDraft/soapFinal` Json; [`routes/ai-scribe.ts`](../apps/api/src/routes/ai-scribe.ts) (9 endpoints incl. transcribe + finalise) | — |
| Voice-Rx (ambient → CDSS → Aadhaar e-Sign) | 🟡 Productise | Scribe + Rx writer exist independently; ambient→Rx hand-off needs a single CTA | **Aadhaar e-Sign half is `❌ Missing`** — Stage-1 PRD §12.d notes "Full eSign with Aadhaar ESP is Stage 2". Engineering: integrate one Aadhaar ESP vendor (NSDL e-Gov / SureSign / Indxform). ~2-3 weeks. |
| 3-column consult screen integration | ✅ Present | [`/dashboard/scribe/page.tsx`](../apps/web/src/app/dashboard/scribe/page.tsx) (post Stage-1 §2.1.3 closure) + voice-commands.ts | — |
| Multilingual ASR (Hindi/Tamil/Bengali/etc.) | 🟡 Productise | Sarvam supports — confirm provider config | — |

**Productisation gap for §S2.5**: (a) Single "Start ambient consult" CTA on the OPD consult page → scribe session → SOAP → Rx draft → sign workflow. (b) Aadhaar ESP integration (greenfield within Bucket A).

### §S2.6 Predictive CDS (sepsis / no-show / capacity / fraud / roster / coaching)

| Stage-2 deliverable | Status | MedCore reference | Notes |
|---|---|---|---|
| Sepsis predictor | 🟡 Productise | [`routes/ai-predictions.ts`](../apps/api/src/routes/ai-predictions.ts) + [`/dashboard/predictions/`](../apps/web/src/app/dashboard/predictions/) | Flag: `predictiveCds`. Productisation work: ENTERPRISE-tier binding + upgrade CTA. |
| Deterioration / early-warning | 🟡 Productise | `routes/ai-predictions.ts` (same surface) | — |
| No-show prediction | 🟡 Productise | [`services/ai/no-show-predictor.ts`](../apps/api/src/services/ai/no-show-predictor.ts) + `routes/ai-predictions.ts` | — |
| Capacity forecast (bed + OT) | 🟡 Productise | [`routes/ai-capacity.ts`](../apps/api/src/routes/ai-capacity.ts); [`services/ai/capacity-forecast.ts`](../apps/api/src/services/ai/capacity-forecast.ts); [`/dashboard/capacity-forecast/`](../apps/web/src/app/dashboard/capacity-forecast/) | Flag: `aiCapacity`. |
| Fraud detection (claims / billing anomaly) | ✅ Closed 2026-05-25 | [`routes/ai-fraud.ts`](../apps/api/src/routes/ai-fraud.ts) (`requireFeature("aiFraud")` wired) + [`services/ai/fraud-detection.ts`](../apps/api/src/services/ai/fraud-detection.ts); [`/dashboard/ai-fraud/`](../apps/web/src/app/dashboard/ai-fraud/) | Flag: `aiFraud`. Gate enforced at router level — disabled tenants 404 before authorize ever runs. Tests: `apps/api/src/test/integration/ai-fraud-feature-flag.test.ts`. |
| Roster optimisation | 🟡 Productise | [`routes/ai-roster.ts`](../apps/api/src/routes/ai-roster.ts); [`services/ai/staff-scheduler.ts`](../apps/api/src/services/ai/staff-scheduler.ts); [`/dashboard/ai-roster/`](../apps/web/src/app/dashboard/ai-roster/) | Flag: `aiRoster`. |
| Coaching (chronic care) | 🟡 Productise | [`routes/ai-coaching.ts`](../apps/api/src/routes/ai-coaching.ts) | Flag: `aiCoaching`. No `/dashboard/ai-coaching/` dir today — UI gap. |
| Follow-up sequencing | 🟡 Productise | [`routes/ai-followup.ts`](../apps/api/src/routes/ai-followup.ts); [`/dashboard/ai-followup/`](../apps/web/src/app/dashboard/ai-followup/) | Flag: `aiFollowup`. |

**Productisation gap for §S2.6**: (a) Each of 6 sub-flags can be sold à la carte OR bundled as "Predictive CDS pack" — needs a HARD BLOCKER decision (`PEARL_STAGE2_OPEN_DECISIONS.md` item #2). (b) `/dashboard/ai-coaching/` page missing — small UI add.

### §S2.7 AI image triage (radiology)

| Stage-2 deliverable | Status | MedCore reference | Notes |
|---|---|---|---|
| CXR / ECG / retinal triage models | 🟡 Productise | [`routes/ai-radiology.ts`](../apps/api/src/routes/ai-radiology.ts) (`requireFeature("aiRadiology")` wired); [`services/ai/radiology-reports.ts`](../apps/api/src/services/ai/radiology-reports.ts) | Flag wired. Plan-tier binding decision pending. |
| Radiology study + report | ✅ Present | `:6105` `RadiologyStudy`, `:6133` `RadiologyReport` | — |
| AI-drafted report → radiologist sign-off | ✅ Present | [`services/ai/radiology-reports.ts`](../apps/api/src/services/ai/radiology-reports.ts) + tests | — |
| Inline DICOM preview in study detail | 🟡 Productise | UI today shows `imageUrls` (PDF/JPG fallback); no DICOM viewer | DICOM viewer is §S2.17 below — a discrete Bucket-B build. AI triage can ship without DICOM viewer (image URLs work today). |

### §S2.8 ABDM M2/M3/M4 + NHCX live

| Stage-2 deliverable | Status | MedCore reference | Notes |
|---|---|---|---|
| ABDM M1 (ABHA create/link/verify) | ✅ Present (Stage 1) | [`routes/abdm.ts`](../apps/api/src/routes/abdm.ts) (30 endpoints) + [`services/abdm/abha.ts`](../apps/api/src/services/abdm/abha.ts) | — |
| ABDM M2 — HIP push (push health records to ABDM gateway) | 🟡 Productise | [`services/abdm/health-records.ts`](../apps/api/src/services/abdm/health-records.ts) (`linkCareContext`, `handleHealthInformationRequest`); `:5463` `CareContext` model; 26 HIP/HIU/consent-init mentions in `services/abdm/*` | Code exists but not exposed under `abdmAdvanced` flag — current Stage-1 §10 carve-out hides M2/M3 surface. Productisation: gate behind `abdmAdvanced`. **Surfaced finding** — ABDM M2 routes are *more complete than expected*; ~80% of the wire is there. The blocker is sandbox creds (HARD BLOCKER #4 in OPEN_DECISIONS). |
| ABDM M3 — HIU pull (pull patient records from other HIPs via consent) | 🟡 Productise | Consent + health-records services support this; UI gap | Federated records timeline in patient PWA (cited in Stage-1 §6.1 as deferred to Stage 2). |
| ABDM M4 — NHCX cashless live | 🟡 Productise | Stage 1 ships NHCX *stub* stepper (`InsuranceClaim2.status` enum + `/dashboard/insurance-claims/` + UI stepper from Stage-1 §4.2 closure) | **Stage-3 deferral per PRD §4.2** — live insurer integration is Stage 3, not Stage 2. Stage 2 builds the M4 *protocol* scaffolding (claim submit/preauth via NHCX rails); Stage 3 wires real insurers. |
| Consent artefact lifecycle | ✅ Present | `:5438` `ConsentArtefact` + [`services/abdm/consent.ts`](../apps/api/src/services/abdm/consent.ts) | — |
| Care context registration | ✅ Present | `:5463` `CareContext` + `services/abdm/health-records.ts` | — |
| ABDM HFR + HPR onboarding | ✅ Present (Stage 1) | Wizard steps 5-6 shipped Stage 1 | Real ABDM-side enrolment requires sandbox creds per OPEN_DECISIONS #4. |

### §S2.9 LLM-personalised reminders

| Stage-2 deliverable | Status | MedCore reference | Notes |
|---|---|---|---|
| Template-with-tokens reminders (Stage 1) | ✅ Present (Stage 1) | `NotificationTemplate` + `services/notification-triggers.ts` | Stage 1 ships token substitution `{{first_name}}` etc. |
| LLM personalisation behind opt-in flag | ❌ Missing | (PRD §3.2 + §18: explicit Stage-2 deferral) | Greenfield. Add `Patient.llmPersonalisationOptIn` + LLM-rewrite step in template renderer + audit. ~1 week. |
| Per-patient channel preference (audit-grade) | ✅ Present | `NotificationPreference` model | — |
| Quiet-hours clamp | ✅ Present (Stage 1) | `Campaign.sendWindowStart/End` + dispatcher | — |

### §S2.10 HRMS / payroll

| Stage-2 deliverable | Status | MedCore reference | Notes |
|---|---|---|---|
| Leave balance + request + approval | 🟡 Productise | `:4422` `LeaveBalance`, `:3262` `LeaveRequest`; [`routes/leaves.ts`](../apps/api/src/routes/leaves.ts) (11 endpoints); [`/dashboard/leave-management/`](../apps/web/src/app/dashboard/leave-management/) | Flag: `hrmsPayroll`. Not wired on routes today per the grep — productisation gap. |
| Payroll computation (PF + ESI + TDS) | 🟡 Productise | [`services/payroll.ts`](../apps/api/src/services/payroll.ts) (production-grade — handles FY2026 PF/ESI ceilings + pro-rata Basic by days worked); [`routes/hr-ops.ts`](../apps/api/src/routes/hr-ops.ts) (17 endpoints incl. POST `/payroll`); [`/dashboard/payroll/`](../apps/web/src/app/dashboard/payroll/) | **Surfaced finding** — payroll service is *more complete than expected* (post-#701/#702 fixes). The salary-slip generator exists. No `PayrollRun`/`SalarySlip` Prisma model though — slips are generated on-demand. Productisation may need a persisted `PayrollRun` for audit. |
| Salary slip PDF | 🟡 Productise | `services/payroll.ts` generates slip data; `services/pdf-generator.ts` renders | — |
| Staff certification tracking | 🟡 Productise | `:4683` `StaffCertification`; [`/dashboard/certifications/`](../apps/web/src/app/dashboard/certifications/) | — |
| Overtime tracking | 🟡 Productise | `:4709` `OvertimeRecord` | — |
| Holiday calendar (per branch) | ✅ Present (stays in Stage 1 per §10 carve-out for scheduling) | `Holiday` model | — |
| Duty roster | ✅ Present (stays in Stage 1 per §10 carve-out) | `StaffShift` model + `/dashboard/duty-roster/` | — |
| Expense claims | 🟡 Productise | `:3422` `Expense`; [`routes/expenses.ts`](../apps/api/src/routes/expenses.ts); [`/dashboard/expenses/`](../apps/web/src/app/dashboard/expenses/) | Sits under HRMS productisation. |
| Expense budgets | 🟡 Productise | `:4406` `ExpenseBudget`; [`/dashboard/budgets/`](../apps/web/src/app/dashboard/budgets/) | — |

**Productisation gap for §S2.10**: ~~Wire `requireFeature("hrmsPayroll")` on `routes/{leaves,hr-ops,expenses}.ts`~~ **Closed 2026-05-25 (verification-audit fix-up #3 tick)** — `requireFeature("hrmsPayroll")` now wired at top of all three routers (`hr-ops.ts`, `leaves.ts`, `expenses.ts`); STARTER-tier Pearl tenants 404 on every HRMS/payroll surface. Bundling decision (split vs keep as one flag) deferred — current shape keeps the three routes coupled, matching the PRD §S2.10 "HRMS bundle" framing; if Stage-2 plan-tier mapping wants finer SKU control, split into `hrmsLeaves` + `hrmsExpenses` + `hrmsPayroll` then. Coverage at `apps/api/src/test/integration/feature-flag-coverage.test.ts`.

### §S2.11 Asset / biomed tracker

| Stage-2 deliverable | Status | MedCore reference | Notes |
|---|---|---|---|
| Asset master + categorisation | 🟡 Productise | `:3859` `Asset`; [`routes/assets.ts`](../apps/api/src/routes/assets.ts) (24 endpoints); [`/dashboard/assets/`](../apps/web/src/app/dashboard/assets/) | No `requireFeature` flag wired today (no `assetTracker` key in `FEATURE_KEYS`) — add the key + wire. |
| Asset transfer + assignment | 🟡 Productise | `:3903` `AssetTransfer`, `:3925` `AssetAssignment` | — |
| Maintenance schedule + history | 🟡 Productise | `:3946` `AssetMaintenance` | — |
| Calibration tracking | 🟡 Productise | `AssetMaintenance` covers this with `type` enum | — |
| Biomedical-specific fields (license/serial/warranty) | 🟡 Productise | `Asset` model has these | — |

**Productisation gap for §S2.11**: Add `assetTracker` feature-key to `packages/shared/src/feature-flags.ts` + wire `requireFeature("assetTracker")` on `routes/assets.ts` + plan-tier binding.

### §S2.12 NABH Quality Dashboard

| Stage-2 deliverable | Status | MedCore reference | Notes |
|---|---|---|---|
| NABH KPI calculation surface | 🟡 Productise | `nabh` mentioned in `services/ai/kpi-metrics.ts`; basic ops dashboards exist | The NABH-specific scoring layer is thin — needs a dedicated KPI-scoring service mapping ops data to NABH 5th-edition chapter scoring. ~2 weeks. |
| NABH quality-indicator metrics (1-21 standard set) | ❌ Missing | (no NABH-indicator-specific calculator) | Greenfield within Bucket A — the surfaces to derive from exist (admissions, surgeries, lab QC, infection control). Engineering: NABH-indicator definitions + metric calculators + dashboard. ~3 weeks. |
| NABH dashboard UI | ❌ Missing | (no `/dashboard/nabh/` route) | UI surface for the indicators. ~1 week. |
| Audit trail export per NABH reviewer ask | ✅ Present | `AuditLog` model + export | — |

**Productisation gap for §S2.12**: This is more greenfield than productisation. The Stage-1 §10 carve-out says "Hide as 'NABH dashboard'; keep basic ops dashboards" — meaning today there is no NABH dashboard to hide. Estimated ~6 weeks of build for full NABH-5th-edition coverage.

### §S2.13 Voice AI Receptionist — Bucket B greenfield

| Stage-2 deliverable | Status | MedCore reference | Notes |
|---|---|---|---|
| Inbound voice call → AI receptionist | ❌ Missing | (no Retell/Exotel/Vapi integration; grep returns 0 source files) | Build commitment in Mykare PR #909 per [`PEARL_STAGE1_GAP_ANALYSIS.md`](./PEARL_STAGE1_GAP_ANALYSIS.md) §10. ~4-6 weeks depending on provider. HARD BLOCKER #5 — provider choice. |
| Outbound voice call → follow-up / reminder / collection | ❌ Missing | (same as above) | — |
| Call recording + transcript persistence | ❌ Missing | (no model) | Schema add `VoiceCall { id, direction, durationSec, recordingUrl, transcript, ... }` — ~1 day once provider chosen. |
| Patient self-serve via phone (book / cancel / re-schedule) | ❌ Missing | (downstream of inbound AI) | — |

### §S2.14 AI Discharge — Bucket B greenfield

| Stage-2 deliverable | Status | MedCore reference | Notes |
|---|---|---|---|
| LLM-drafted discharge summary | ❌ Missing | `Admission.dischargeSummary` is just a String? field; no auto-draft pipeline | Greenfield. Reuses existing AI infra (`services/ai/*` + Sarvam). Per-admission "Generate discharge draft" CTA → LLM call → editable summary → sign. ~2 weeks. |
| Discharge summary PDF | ✅ Present | `GET /api/v1/admissions/:id/discharge-summary-pdf` (`routes/admissions.ts:1475`) | Renders the existing String field; will render the LLM-drafted variant once the draft pipeline lands. |
| Discharge medication reconciliation | 🟡 Productise | Med order surface exists; reconciliation flow doesn't | — |
| Patient-facing discharge instructions | ❌ Missing | (no surface) | Patient PWA gap. |

### §S2.15 Nurse-Call System (as a discrete product) — Bucket B greenfield

| Stage-2 deliverable | Status | MedCore reference | Notes |
|---|---|---|---|
| Nurse-call event capture (bedside button → nurse station) | ❌ Missing | `services/notification-triggers.ts` has some hooks per Stage-1 §10 row but no `NurseCall` model | Greenfield. Schema add `NurseCall`, `NurseCallEvent`, tiered escalation rules. ~3 weeks. |
| Tiered escalation (nurse → charge nurse → doctor) | ❌ Missing | — | — |
| Hardware integration (BLE button / nurse-station screen) | ❌ Missing | — | Hardware partner needed. |
| SLA breach alerts | ❌ Missing | — | — |

### §S2.16 Agentic Revenue Cycle — Bucket B greenfield

| Stage-2 deliverable | Status | MedCore reference | Notes |
|---|---|---|---|
| Auto-claim adjudication workflows | ❌ Missing | `InsuranceClaim2` exists; agent layer doesn't | — |
| Denial-prediction → re-submission | 🟡 Productise (partial) | [`services/insurance-claims/denial-predictor.ts`](../apps/api/src/services/insurance-claims/denial-predictor.ts) exists but no closed-loop agent | Predictor scaffolding is here. Greenfield = wiring the predictor → re-submission worker. |
| Patient-balance collection agent (voice / WhatsApp loop) | ❌ Missing | — | Heavy build. **Likely Stage-3 candidate.** |
| Coding (ICD/CPT) automation per encounter | ❌ Missing | ICD-10 master exists; auto-coder doesn't | — |

### §S2.17 RIS / PACS / DICOM viewer — Bucket B greenfield

| Stage-2 deliverable | Status | MedCore reference | Notes |
|---|---|---|---|
| DICOM study storage (DIMSE / DICOMweb) | ❌ Missing | `RadiologyStudy.imageUrls` is JPG/PDF today | HARD BLOCKER #3 — library choice (OHIF / Cornerstone / Orthanc / commercial). |
| Web DICOM viewer with windowing / MPR | ❌ Missing | — | — |
| RIS scheduling (modality worklist via DICOM Modality Worklist) | ❌ Missing | — | — |
| Per-study annotations + measurements | ❌ Missing | — | — |
| Integration with AI image triage (§S2.7) | 🟡 Productise once viewer lands | — | The triage models can run on JPG today; viewer is a UX upgrade. |

### §S2.18 Self-service kiosk + thermal printer — Bucket B greenfield

| Stage-2 deliverable | Status | MedCore reference | Notes |
|---|---|---|---|
| Kiosk route group (`/kiosk/...`) | ❌ Missing | (no `apps/web/src/app/kiosk/`) | Greenfield route group + lockdown UX + kiosk-only auth (PIN / barcode). ~2 weeks. |
| Self-registration + check-in | ❌ Missing | — | — |
| Bluetooth thermal printer (token / receipt) | ❌ Missing | (no Web Bluetooth adapter) | Web Bluetooth API + ESC/POS command set + per-printer-model template. ~1.5 weeks. |
| QR code scan for returning patients | 🟡 Productise | `qrcode` lib used Rx-side; reuse | — |

### §S2.19 Multi-language voice prompts (TTS asset pack) — Bucket B greenfield

| Stage-2 deliverable | Status | MedCore reference | Notes |
|---|---|---|---|
| TTS asset generation (12 Indian languages × N prompts) | ❌ Missing | Text-only i18n shipped (`apps/web/src/lib/i18n.ts` EN+HI flat dict) | Greenfield. Sarvam TTS (or chosen provider) + prompt-catalogue + asset-pack delivery to patient PWA + token board. ~2 weeks. |
| Voice prompts on token-board / kiosk / PWA | ❌ Missing | — | — |
| Provider abstraction (Sarvam / Google TTS / etc.) | 🟡 Productise | Sarvam abstraction already in `services/ai/sarvam.ts` for ASR; mirror for TTS | — |

### §S2.20 Pearl Agent Factory — Bucket B greenfield (Stage 3 candidate)

| Stage-2 deliverable | Status | MedCore reference | Notes |
|---|---|---|---|
| Agent DSL + runtime | ❌ Missing | (out-of-scope per PRD §18) | Bigger than any other Stage-2 module. **Recommended deferral to Stage 3.** |
| Per-tenant agent authoring UI | ❌ Missing | — | — |
| Agent → MedCore action bindings | ❌ Missing | — | — |

---

## 3. Cross-cutting gaps for Stage 2

These span multiple modules and need to be solved once, not per-module.

| Gap | Status | Notes |
|---|---|---|
| Plan-tier → feature-flag bundle resolution | 🟡 Partial | Stage 1 OPEN_DECISIONS #1 locked the 3 plans (STARTER/GROWTH/ENTERPRISE) + Stage-1 feature mappings. Stage 2 needs the *Stage-2 module* → tier mapping. HARD BLOCKER #1. |
| Upgrade-prompt UX on locked nav items | ❌ Missing | Today `requireFeature` returns 404 on the API side + sidebar nav filter hides the link. Stage 2 needs: show a *teaser tile* with "Upgrade to ENTERPRISE to unlock" CTA → links to operator contact / Razorpay subscription change flow. ~1.5 weeks. |
| Per-feature usage metering | ❌ Missing | Operator wants to surface "Hospital X used Telemedicine 12 times / IPD 4 admissions this month" to drive upsell conversations. Add `FeatureUsageMetric` model + counter hooks in each Stage-2 route + super-admin dashboard. ~2 weeks. |
| Per-module à-la-carte billing add-on SKU vs plan-tier-bundled | 🛑 HARD BLOCKER | OPEN_DECISIONS #2 — needs operator decision. |
| Razorpay Subscriptions add-on plumbing (Stage-2 SKUs) | 🟡 Productise | Razorpay Subscriptions API already wired Stage 1 for the base plan; add-on SKU support is incremental. ~1 week per add-on once SKU strategy decided. |
| Stage-2 module → audit-log entity name mapping | 🟡 Productise | New surfaces (Voice AI calls, DICOM views, kiosk sessions) need audit-log entity coverage. ~0.5 weeks per surface. |
| Per-tenant data export for Stage-2 modules | 🟡 Productise | Stage 1 DPDP purge covers 15 tables (Patient + 14 children + Admission/LabOrder etc. post-OPEN_DECISIONS #5). Stage 2 must extend to Voice AI call recordings, kiosk sessions, DICOM studies, payroll PII. ~1 week. |
| Multi-branch concurrency for Stage-2 modules | 🟡 Productise | `Branch` model + `branchScopedPrisma` shipped Stage 1. IPD beds, OT theatres, lab analysers, assets all need `branchId` confirmation. ~1 week sweep. |

---

## 4. Integration gaps

External systems Stage 2 must connect to.

| Integration | Status | Notes |
|---|---|---|
| ABDM M2 sandbox creds | 🛑 HARD BLOCKER #4 | Pearl-operator action — register HIP on ABDM sandbox + provision creds. |
| ABDM M3 HIU certificate + JWKS | 🛑 HARD BLOCKER #4 (same root cause) | — |
| NHCX sandbox creds | 🛑 HARD BLOCKER #4 (same root cause) | NHCX live insurer integration is Stage 3 per PRD §4.2 — Stage 2 ships the protocol. |
| Lab analyser HL7 endpoints per tenant | 🟡 Productise | Per-tenant HL7 listener URL provisioning needs operator-side infra + per-analyser-vendor message-template seed. |
| Razorpay Subscriptions add-on SKUs (Stage-2 plans) | 🟡 Productise | Razorpay account-side SKU creation + secret rotation. |
| Voice AI Receptionist provider | 🛑 HARD BLOCKER #5 | Retell / Vapi / Bland / ElevenLabs / Sarvam — provider + credentials. |
| Aadhaar e-Sign ESP (NSDL / SureSign / Indxform) | 🟡 Productise (needs vendor pick) | Required for Voice-Rx Stage 2 per PRD §12.d. |
| DICOM viewer library / PACS backend | 🛑 HARD BLOCKER #3 | OHIF / Cornerstone / Orthanc / commercial. |
| Hardware partner for nurse-call buttons | ❌ Missing | Vendor selection for §S2.15. |
| Bluetooth thermal printer test devices | ❌ Missing | Operator-side hardware procurement. |
| TTS provider (Sarvam vs Google) | 🟡 Productise | Likely extend existing Sarvam wiring. |

---

## 5. Architectural notes

Stage-2 decisions that constrain the engineering shape.

### 5.1 Feature-flag bundle model

Current `Tenant.featureFlags Json?` is a per-tenant override map (key→bool). Stage 2 adds a plan-tier resolution step: `resolveFlagsForTenant(tenant)` returns `defaultsForPlan(tenant.subscription.plan) merged with tenant.featureFlags overrides`. The Stage-1 `resolveAllFeatureFlags()` helper in `packages/shared/src/feature-flags.ts` is the natural extension point — add a second arg `plan?: Plan` that injects the plan's defaults before the tenant's overrides.

### 5.2 Module isolation pattern

Per OPEN_DECISIONS #2: can a tenant buy "Lab module" without "IPD"? Today flag-by-flag is independent (16 flags in `FEATURE_KEYS`). The mapping in OPEN_DECISIONS #1 bundles them by tier (Lab + Radiology + ABDM M1 = GROWTH; IPD + OT + ABDM M2 + AI Scribe = ENTERPRISE). Question for Stage 2: do we *also* support per-flag SKU sales (e.g. STARTER + "Lab add-on"), or is the tier-only model sufficient?

Recommended: **support à la carte for the AI-* flags only**, since those are the easiest upsells per-feature ("buy AI Roster for ₹X/month"). Keep IPD/OT/Lab as tier-bundled because they share infrastructure (ABDM, lab QC).

### 5.3 Stage-3 deferrals

The following are big enough that even Stage 2 won't realistically absorb them and should be flagged as Stage 3 candidates *upfront* so the operator can set expectations with the pilot tenant:

- **Pearl Agent Factory (§S2.20)** — bigger than any single module. Genuinely a Stage-3 platform.
- **NHCX *live* insurer integration (part of §S2.8)** — PRD §4.2 already calls this Stage 3.
- **Patient-balance collection agent (part of §S2.16)** — heavy outbound-voice + LLM-loop + compliance.
- **Full LLM-driven clinical decisioning beyond the current Predictive CDS surfaces** — separate from §S2.6, refers to LLM-as-doctor surfaces (treatment-plan generation, second-opinion AI).
- **Voice-AI on the doctor side (e.g. AI doctor for asynchronous consults)** — Stage 2 is Voice-AI Receptionist (reception/booking); doctor-side voice AI is a separate, more regulated build.

### 5.4 Schema growth budget

Stage 2 will add 6-10 new Prisma models (`PayrollRun`, `SalarySlip`, `Implant`, `NurseCall`, `NurseCallEvent`, `VoiceCall`, `VoiceCallTranscript`, `DicomStudy` if not reusing `RadiologyStudy`, `KioskSession`, `TtsAsset`). Each gets a tenant-scoped migration + `tenantScopedPrisma` extension entry. No structural refactor expected.

---

## 6. Acceptance-criteria coverage

Stage 2 has no formal PRD with acceptance bullets at session start. The following are the *expected* acceptance criteria mirroring Stage 1's §6 cadence; the operator may refine when the Stage-2 SoW is authored.

| Module | Proposed acceptance bullet | Status |
|---|---|---|
| §S2.1 IPD | Patient admission → bed allocation → vitals capture → eMAR administration → discharge summary in 3 days simulated | ❌ Not measured |
| §S2.2 OT | Surgery booking → anesthesia record → implant log → post-op observation cycle measured end-to-end | ❌ Not measured |
| §S2.3 LIS HL7 | Lab analyser HL7 message → LabResult row in **< 5 s** | ❌ Not measured |
| §S2.4 Telemedicine | Video session join + recording + e-consent capture | ❌ Not measured |
| §S2.5 Voice-Rx | Ambient consult → SOAP draft → Rx draft → Aadhaar e-Sign in **< 90 s** | ❌ Not measured |
| §S2.6 Predictive CDS | Sepsis alert fires within **< 60 s** of triggering vitals | ❌ Not measured |
| §S2.7 AI Radiology | CXR upload → AI draft report → radiologist sign in **< 5 min** | ❌ Not measured |
| §S2.8 ABDM M2 | HIP push to ABDM gateway acknowledged within **< 30 s** | ❌ Not measured |
| §S2.9 LLM reminders | LLM-personalised reminder generated + opted-in patient receives within quiet-hours window | ❌ Not measured |
| §S2.10 HRMS | Monthly payroll run for 100-staff tenant in **< 2 min** | ❌ Not measured |
| §S2.11 Asset | Asset transfer + maintenance schedule + breakdown alert cycle | ❌ Not measured |
| §S2.12 NABH | NABH 1-21 indicator export reproducible across two consecutive runs | ❌ Not measured |
| §S2.13 Voice AI | Inbound call answered + intent recognised + booking confirmed in **< 90 s** | ❌ Not measured |
| §S2.14 AI Discharge | LLM-drafted discharge summary in **< 30 s** + clinician edit + sign | ❌ Not measured |
| §S2.15 Nurse-Call | Call event → SLA tier breach alert escalation chain verified | ❌ Not measured |
| §S2.17 DICOM viewer | DICOM study first-paint **< 3 s** + windowing responsive | ❌ Not measured |
| §S2.18 Kiosk | Self-registration + token print in **< 45 s** | ❌ Not measured |

---

## 7. NFR coverage for Stage 2

| NFR | Target | Notes |
|---|---|---|
| Voice-prompt latency (TTS first-byte) | **< 800 ms** | Sarvam / Google TTS streaming. |
| ABDM HIP push response time | **< 2 s p95** | ABDM gateway SLA. |
| DICOM viewer first-paint | **< 3 s** on a 200MB study | OHIF achieves this with progressive load. |
| Voice AI Receptionist barge-in latency | **< 300 ms** | Real-time conversation NFR. |
| LLM discharge draft latency | **< 30 s** for a 7-day admission | Streaming reduces perceived latency. |
| NABH dashboard data freshness | **< 1 hour** lag | Materialised view refresh. |
| Per-feature usage-metric write throughput | **< 50 ms p95** added per Stage-2 route | Counter hook overhead bound. |
| Stage-2 module Lighthouse mobile Perf | **≥ 85** (mirror Stage-1) | Hard-gated via existing `lhci` flow. |

---

## 8. Compliance posture for Stage 2

| Clause | Stage-2 ask | Status / notes |
|---|---|---|
| DPDP — extend hard-purge coverage to Stage-2 entities | Voice call recordings + transcripts; DICOM studies; kiosk sessions; payroll PII; NABH-indicator snapshots | 🟡 Productise — `services/dpdp-purge.ts` covers 15 tables today (OPEN_DECISIONS #5); add 6-8 more in Stage 2. |
| DPDP-residency for Stage-2 surfaces (DICOM, voice recordings) | All blob storage in AP-South-1 / DO Bangalore | 🟡 Deploy-config — code is region-agnostic; operator picks region at deploy. |
| ABDM M2 consent artefact retention | Per ABDM spec | ✅ Code-side — `ConsentArtefact` model + lifecycle services. |
| Lab HL7 audit trail | Every HL7 message ingested → AuditLog | 🟡 Productise — service has logging; verify audit-row write. |
| NABH dashboard data lineage | Every indicator computation traceable to source rows | ❌ Missing — needs metric-derivation audit. |
| Aadhaar e-Sign (Stage-2 lift on Stage-1 SHA-256 baseline) | Per IT Act 2000 + ESP guidelines | ❌ Missing — vendor pick required (§S2.5). |
| Telemedicine recording consent (Telemedicine Practice Guidelines 2020) | Explicit consent before recording starts | 🟡 Productise — see §S2.4. |
| Voice AI call recording consent | Statutory + DPDP joint consent | ❌ Missing — Stage 2 build. |
| Payroll PII retention (statutory 7+ years) | Compliant retention policy on `PayrollRun`/`SalarySlip` | 🟡 Productise — confirm retention scheduler covers. |

---

## 9. Pilot success criteria (for reference)

These are measured at the Stage-2 pilot tenant's go-live + 90 days. **Document only** — operator picks the actual thresholds when Stage-2 SoW is signed.

| Criterion | Expected gate (proposed) |
|---|---|
| ≥ 60% of IPD admissions recorded in Pearl (not paper / parallel) | Measured during Stage-2 hyper-care |
| ≥ 60% of OT procedures booked + recorded in Pearl | — |
| ≥ 70% of lab orders flowing through HL7 inbound for analyser-equipped tests | — |
| Voice AI Receptionist handles ≥ 40% of inbound calls without escalation | — |
| AI Scribe used on ≥ 30% of OPD consults | — |
| ABDM M2 push success rate ≥ 95% over a 30-day window | — |
| HRMS payroll run-on-time for 3 consecutive months | — |
| NABH dashboard refresh accuracy ≥ 99% vs manual audit | — |
| Stage-2 module Lighthouse mobile Perf ≥ 85 on at-launch and at-pilot-end | — |

---

## 10. Out-of-scope (Pearl Stage 3+)

Even Stage 2 won't cover the following — synthesised from PRD §18 + the "Stage 3" mentions in Stage-1 SoW + scale-derived deferrals:

- **NHCX live insurer integration** — PRD §4.2 explicit Stage 3 deferral. Stage 2 ships the protocol scaffolding.
- **Pearl Agent Factory** — bigger than any Stage-2 module. The agent-DSL platform belongs to Stage 3.
- **Voice-AI doctor-side** — async AI doctor for routine OPD intake, second-opinion AI. Heavily regulated.
- **Full LLM-driven clinical decisioning** — beyond the current narrow Predictive CDS surfaces.
- **Patient-balance outbound voice agent (part of §S2.16)** — heavy compliance + voice-AI loop.
- **Robotic surgery integration / advanced surgical planning** — out of scope.
- **Multi-country (non-India) compliance pack** — GDPR / HIPAA / Saudi NPHIES / UAE etc.
- **Hospital chain / multi-property reporting (cross-tenant rollup)** — `Branch` covers single-org multi-site; chain-of-tenants rollup is Stage 3.
- **Insurance + TPA payer-side network** — full claim adjudication on the payer side.
- **DICOM AI screening at modality time (real-time during scan)** — Stage 2 is post-scan triage; modality-time is Stage 3.

---

## 11. Top-N recommended next moves to close Stage 2

Ordered by Pearl-criticality × engineering-cost ratio. Effort in engineer-weeks (1 engineer FT).

| # | Move | Effort | Why |
|---|---|---|---|
| 1 | **Decide HARD BLOCKERs #1-#5** in [`PEARL_STAGE2_OPEN_DECISIONS.md`](./PEARL_STAGE2_OPEN_DECISIONS.md) — Stage-2 plan-tier mapping + à-la-carte vs bundle + DICOM library + ABDM sandbox creds + Voice AI provider | 0 (operator) | Without these, ~70% of §2 rows can't be picked. |
| 2 | **Plan-tier resolution + upgrade-prompt UX + per-feature metering** (cross-cutting from §3) | 4 weeks | Foundation for all Bucket-A productisation. Without it the upsell ladder has no UX. |
| 3 | **Productise §S2.4 Telemedicine + §S2.7 AI Radiology + §S2.5 AI Scribe** (already flag-wired; just tier-binding + upgrade UX) | 2 weeks | First three SKUs to flip after foundation lands. Highest revenue-per-engineering-hour. |
| 4 | **Productise §S2.1 IPD + §S2.2 OT** (wire `requireFeature("ot")` + Implant register) | 3 weeks | Anchor ENTERPRISE-tier value prop. |
| 5 | **Productise §S2.3 Lab HL7 inbound** (wire `hl7Inbound` + per-tenant listener URL provisioning) | 2 weeks | Largest GROWTH-tier draw for diagnostics-heavy tenants. |
| 6 | **Productise §S2.6 Predictive CDS — all 6 sub-flags** (tier-binding + à-la-carte SKU support per OPEN_DECISIONS #2) | 2 weeks | Six SKUs at once if the upsell-foundation is in. |
| 7 | **§S2.8 ABDM M2 productisation** (sandbox creds in, expose HIP push surface, wire `abdmAdvanced` for all 3 sub-tiers) | 3 weeks | Highest compliance value-add. Blocked on HARD BLOCKER #4. |
| 8 | **§S2.10 HRMS / payroll productisation** (wire `hrmsPayroll` across `routes/{leaves,hr-ops,expenses}.ts` + persisted PayrollRun + slip retention) | 2 weeks | Stage-1 OPEN_DECISIONS landed `hrmsPayroll` flag in feature-keys; just needs wiring. |
| 9 | **§S2.11 Asset / biomed productisation** (add `assetTracker` feature-key + wire) | 1 week | Tiny lift — biggest "extras" pop for facility managers. |
| 10 | **§S2.14 AI Discharge greenfield** (LLM draft pipeline for `Admission.dischargeSummary`) | 2 weeks | Reuses Sarvam + LLM infra; high clinical value. |
| 11 | **§S2.9 LLM-personalised reminders greenfield** (opt-in + LLM-rewrite + audit) | 1.5 weeks | Reuses NotificationTemplate + Sarvam. |
| 12 | **§S2.12 NABH dashboard greenfield** (NABH 1-21 indicator calculator + UI) | 5-6 weeks | Largest "still-Bucket-A" build because there's literally no NABH-specific code today despite the schema being there for indicator-derivation. |
| 13 | **§S2.13 Voice AI Receptionist greenfield** (post-HARD BLOCKER #5 decision) | 4-6 weeks | Largest revenue swing for reception-heavy tenants. |
| 14 | **§S2.17 DICOM viewer greenfield** (post-HARD BLOCKER #3 decision) | 6-8 weeks | Largest single greenfield build (OHIF integration + DIMSE bridge + AI-triage layering). |
| 15 | **§S2.15 Nurse-Call System greenfield** | 4 weeks (software) + hardware partner timeline | Hardware-bound; software side moderate. |
| 16 | **§S2.18 Self-service kiosk + thermal printer greenfield** | 4 weeks | Web Bluetooth + ESC/POS + kiosk lockdown UX. |
| 17 | **§S2.19 Multi-language voice prompts (TTS asset pack)** | 2 weeks | Sarvam TTS + asset packaging. |
| 18 | **§S2.16 Agentic Revenue Cycle greenfield** (denial-prediction loop closure; defer collection agent to Stage 3) | 4 weeks (loop) + Stage 3 deferral note | Heavy but high ROI for billing-heavy tenants. |
| 19 | **§S2.20 Pearl Agent Factory** | **Recommend deferral to Stage 3** | Bigger than any Stage-2 module. |

**Cumulative estimate (excluding Stage-3 deferrals):** ~42-50 engineer-weeks for a single dedicated engineer, or **~24-30 calendar weeks with 2 engineers in parallel** (productisation lanes 3-9 are mostly non-overlapping, and greenfield lanes 10-18 can split). Matches the §0 charter "24-30 weeks for 2 engineers" budget.

---

## Appendix A — Stage-2 model / route presence reference

Mirror of Stage-1 Appendix A scoped to Stage-2 modules.

| Stage-2 module | Prisma model(s) | Route file(s) | Service / dashboard |
|---|---|---|---|
| §S2.1 IPD | `Ward` `Bed` `Admission` `IpdVitals` `MedicationOrder` `MedicationAdministration` `NurseRound` `IpdIntakeOutput` | `admissions.ts` (23 ep) + `medication.ts` | `/dashboard/admissions` `/wards` `/medication` `/medication-dashboard` |
| §S2.2 OT | `OperatingTheater` `Surgery` `AnesthesiaRecord` | `surgery.ts` (15 ep) | `/dashboard/operating-theaters` (+`-theatres` +`ot` — dedupe) |
| §S2.3 LIS HL7 | `LabTest` `LabOrder` `LabOrderItem` `LabResult` `LabTestReferenceRange` | `lab.ts` (20 ep) + `hl7v2.ts` | `services/hl7v2/` (7 files); `/dashboard/lab` `/lab/qc` |
| §S2.4 Telemedicine | `TelemedicineSession` | `telemedicine.ts` (19 ep, flag wired) | `services/jitsi.ts`; `/dashboard/telemedicine/waiting-room` |
| §S2.5 AI Scribe / Voice-Rx | `AIScribeSession` | `ai-scribe.ts` (9 ep) | `services/ai/{asr-providers,sarvam,prompt-registry}.ts`; `/dashboard/scribe` |
| §S2.6 Predictive CDS | (uses Patient/Appointment/Vitals/etc) | `ai-predictions.ts` `ai-capacity.ts` `ai-followup.ts` `ai-fraud.ts` `ai-roster.ts` `ai-coaching.ts` | `services/ai/{no-show-predictor,capacity-forecast,fraud-detection,staff-scheduler,follow-up}.ts`; `/dashboard/{predictions,capacity-forecast,ai-followup,ai-fraud,ai-roster}` (no `/ai-coaching` dir yet) |
| §S2.7 AI Radiology | `RadiologyStudy` `RadiologyReport` | `ai-radiology.ts` (flag wired) | `services/ai/radiology-reports.ts`; `/dashboard/ai-radiology` |
| §S2.8 ABDM M2/M3/M4 | `AbhaLink` `ConsentArtefact` `CareContext` `InsuranceClaim2` | `abdm.ts` (30 ep) + `insurance-claims.ts` | `services/abdm/{abha,client,consent,crypto,health-records,jwks}.ts`; `/dashboard/abdm` `/dashboard/insurance-claims` |
| §S2.9 LLM reminders | `NotificationTemplate` `NotificationPreference` `Patient` | `notifications.ts` | `services/notification-triggers.ts` (LLM step missing) |
| §S2.10 HRMS / payroll | `LeaveBalance` `LeaveRequest` `StaffShift` `Holiday` `StaffCertification` `OvertimeRecord` `Expense` `ExpenseBudget` | `leaves.ts` (11 ep) + `hr-ops.ts` (17 ep) + `expenses.ts` | `services/payroll.ts` (FY26-grade); `/dashboard/{payroll,leave-management,duty-roster,certifications,expenses,budgets}` |
| §S2.11 Assets | `Asset` `AssetTransfer` `AssetAssignment` `AssetMaintenance` | `assets.ts` (24 ep) | `/dashboard/assets` |
| §S2.12 NABH | (derive from existing surfaces) | ❌ no route | ❌ no `/dashboard/nabh` dir |
| §S2.13 Voice AI | ❌ no `VoiceCall` model | ❌ no route | ❌ no service / dashboard |
| §S2.14 AI Discharge | `Admission.dischargeSummary` (String?) | (lives on `admissions.ts:1475` for PDF) | ❌ no LLM draft service |
| §S2.15 Nurse-Call | ❌ no `NurseCall` model | ❌ no route | (hooks in `services/notification-triggers.ts`) |
| §S2.16 Agentic Revenue Cycle | `InsuranceClaim2` (partial) | `insurance-claims.ts` | `services/insurance-claims/denial-predictor.ts` (scaffolding); no closed-loop agent |
| §S2.17 RIS / DICOM | (none; would extend `RadiologyStudy`) | ❌ no route | ❌ no viewer |
| §S2.18 Kiosk | ❌ no `KioskSession` model | ❌ no route | ❌ no `/kiosk/` app route group |
| §S2.19 TTS asset pack | ❌ no `TtsAsset` model | ❌ no route | (Sarvam ASR exists; TTS not wired) |
| §S2.20 Agent Factory | ❌ none | ❌ none | ❌ none — Stage 3 candidate |

---

## Appendix B — files to read before scoping any individual Stage-2 build

- [`packages/db/prisma/schema.prisma`](../packages/db/prisma/schema.prisma) — all 150 models in one place; Stage-2 model anchors listed in Appendix A above
- [`packages/shared/src/feature-flags.ts`](../packages/shared/src/feature-flags.ts) — 16 Stage-1 feature keys; Stage 2 adds 4-6 more (`assetTracker`, possibly split `predictiveCds` into 6 keys for à-la-carte sales)
- [`apps/api/src/services/feature-flags.ts`](../apps/api/src/services/feature-flags.ts) + [`apps/api/src/middleware/feature-flag.ts`](../apps/api/src/middleware/feature-flag.ts) — Stage-1 enforcement layer; Stage 2 adds plan-tier resolution
- [`apps/api/src/routes/admissions.ts`](../apps/api/src/routes/admissions.ts) — biggest Stage-2 surface area (23 endpoints)
- [`apps/api/src/services/abdm/health-records.ts`](../apps/api/src/services/abdm/health-records.ts) — ABDM M2 push scaffolding (more complete than expected)
- [`apps/api/src/services/payroll.ts`](../apps/api/src/services/payroll.ts) — FY26 PF/ESI math (production-grade)
- [`docs/PEARL_STAGE1_GAP_ANALYSIS.md`](./PEARL_STAGE1_GAP_ANALYSIS.md) §10 — the canonical "out-of-scope for Stage 1" table this doc mirrors
- [`docs/PEARL_OPEN_DECISIONS.md`](./PEARL_OPEN_DECISIONS.md) — Stage-1 OPEN_DECISIONS for plan-tier/feature-flag baseline; Stage-2 builds on top
- [`docs/PEARL_STAGE2_OPEN_DECISIONS.md`](./PEARL_STAGE2_OPEN_DECISIONS.md) — companion to this doc, HARD BLOCKERs Stage 2 needs the operator to decide

---

End of Pearl Stage 2 gap analysis.

## Build log

**2026-05-25 — initial Stage-2 gap doc built.** Synthesised from Stage-1 §10 + PRD §18 + scattered "(Stage 2)" mentions. ~38 `❌`/`🟡` markers across pickable sections. 5 HARD BLOCKERs lifted into [`PEARL_STAGE2_OPEN_DECISIONS.md`](./PEARL_STAGE2_OPEN_DECISIONS.md). Surprises surfaced during the survey: (i) ABDM M2 HIP-push services are ~80% complete already; (ii) `services/payroll.ts` is production-grade FY26 PF/ESI math; (iii) AI Scribe is closer to "flip-on" than expected — 9 endpoints + Sarvam + 3-column UI already shipped. The largest still-greenfield build inside Bucket A is NABH dashboard despite the schema having all derivation data — no indicator-specific scoring code exists today.
