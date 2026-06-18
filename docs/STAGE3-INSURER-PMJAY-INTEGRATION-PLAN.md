# Stage 3 — Full Live Integration with Insurers & PMJAY — Implementation Plan

> Scope: SOW Stage 1 §4.2 line 156 — _"Full live integration with insurers and PMJAY is a Stage 3 deliverable."_
> Stage 1 ships the cashless **stub** (`coverage_status` field, stepper UI, manual "Move to next step"). This plan covers wiring the real **NHCX** (insurer cashless) and **PMJAY** (Ayushman Bharat TMS) rails.

---

## 1. What already exists (Stage 1–2)

Live claims are **architecturally ready** — only the real network rails are missing.

| Layer | Present today |
|---|---|
| Adapter pattern | `ClaimsAdapter` interface (`submitClaim` / `fetchStatus` / `uploadDocument` / `cancelClaim`) + a provider **registry** keyed on `TpaProvider` |
| Adapters | Real-ish: **Medi Assist**, **Paramount**; **MOCK**; **placeholders** (VIDAL / FHPL / ICICI Lombard / Star Health all alias Medi Assist) |
| Data model | `InsuranceClaim2` (`providerClaimRef`, `lastSyncedAt`, normalised status), `PreAuthRequest`, `ClaimStatusEvent`, `ClaimDocument`, `ClaimDenialHistory`, `InsuranceProvider` |
| Services | claim `store`, `reconciliation`, periodic **sync scheduler**, AI `ai-coder` (ICD/package coding), `denial-predictor` |
| Routes | insurance-claims, preauth, insurance-providers, ai-claims, billing |
| Prior art | **ABDM** module (ABHA / consent / HIP-HIU, `AbdmTransaction`) — same India-network gateway shape: encryption + async callbacks |
| UI | Billing detail **`coverage_status` stepper** (currently advanced by a manual admin button) |

**Gap:** no **NHCX** adapter, no **PMJAY** adapter, no real eligibility check, no inbound async callback handling, no per-tenant payer credentials.

---

## 2. Implementation phases

### Phase 0 — Discovery & credentials (de-risk first)
1. Confirm protocols: **NHCX = HCX protocol** (FHIR bundles wrapped in JWE, async request/callback) — reuse ABDM crypto/gateway patterns. **PMJAY = TMS REST APIs** (beneficiary search → pre-auth → claim → status).
2. Add a tenant-scoped **`PayerIntegrationConfig`** table: NHCX participant code + signing/encryption keys, PMJAY hospital ID + API creds. Secrets **encrypted at rest** (not plain columns).
3. Onboard NHCX participant + PMJAY UAT credentials. Gate everything behind a `liveClaimsEnabled` tenant feature flag (default **off**).

### Phase 1 — NHCX adapter (insurers / cashless)
4. New `adapters/nhcx.ts` implementing `ClaimsAdapter`, registered in the registry. Build the HCX envelope: FHIR `Claim` / `CoverageEligibilityRequest` bundle → JWE encrypt → signed POST to the NHCX gateway. Reuse ABDM crypto helpers.
5. **Eligibility / coverage check** — the billing `coverage_status` stepper's first step calls NHCX `coverage/eligibility` for real instead of the manual button.
6. **Async callback endpoint** — NHCX returns results via webhook. New callback route: verify signature → decrypt → map FHIR `ClaimResponse` to `NormalisedClaimStatus` → write a `ClaimStatusEvent` (`source: "NHCX"`). This is why `providerClaimRef` / `lastSyncedAt` already exist.

### Phase 2 — PMJAY adapter (government scheme)
7. New `adapters/pmjay.ts` (+ `PMJAY` value in the `TpaProvider` enum + registry). Implement beneficiary search (Ayushman card / ABHA), pre-auth submission, claim submission, and status polling against the PMJAY TMS REST API.
8. Map PMJAY package codes — wire `ai-coder` so suggested procedures resolve to PMJAY HBP package IDs where applicable.

### Phase 3 — Reconciliation, real TPAs, and UI
9. Point the existing **sync scheduler / reconciliation** at the new adapters' `fetchStatus` for claims awaiting async resolution (fallback when callbacks are missed).
10. Replace the **placeholder** VIDAL / FHPL / ICICI / Star adapters with real implementations (or leave them flagged until creds exist).
11. **Billing UI**: drive the `coverage_status` stepper from real adapter responses (eligibility → pre-auth → claim submitted → response → paid / denied); limit the manual "Move to next step" to non-live tenants; surface denial reasons + `QUERY_RAISED` handling.

### Phase 4 — Compliance, observability, tests
12. **Audit + consent**: stamp claim/AI-inference + PHI audit rows (existing `auditLog` convention) on every payer call; enforce ABDM consent where the payload carries clinical data.
13. **Security**: secrets via env/KMS; JWE + signature verification on callbacks; rate-limit + **idempotency keys** on submit (no double-claims); tenant-scope all new rows.
14. **Tests**: per-adapter unit tests with recorded sandbox fixtures (mirror `medi-assist.test.ts`); callback-handler tests (valid/invalid signature, status mapping); an end-to-end eligibility → preauth → claim → callback integration test behind the feature flag.

---

## 3. Sequencing & risks

- **Order:** Phase 0 → NHCX (most hospitals' cashless path) → PMJAY → reconciliation/UI → hardening.
- **Biggest unknowns:** sandbox credential turnaround (often weeks), NHCX JWE/FHIR conformance, PMJAY package mapping — **start Phase 0 immediately**.
- **Reuse, don't rebuild:** everything plugs into the existing `ClaimsAdapter` + registry + store + scheduler — **no schema rewrite**, mainly:
  - new adapter files (`nhcx.ts`, `pmjay.ts`),
  - new inbound callback route(s),
  - a per-tenant `PayerIntegrationConfig` table,
  - UI wiring of the existing stepper.

---

## 4. Key touch-points (where the work lands)

- `apps/api/src/services/insurance-claims/adapters/` — new `nhcx.ts`, `pmjay.ts` (+ tests).
- `apps/api/src/services/insurance-claims/registry.ts` — register the new adapters.
- `apps/api/src/services/insurance-claims/adapter.ts` — extend the interface if eligibility becomes a first-class method.
- `apps/api/src/routes/` — new payer callback route(s); extend insurance-claims / preauth for eligibility.
- `apps/api/src/services/insurance-claims/reconciliation.ts` + scheduler — include the new providers.
- `packages/db/prisma/schema.prisma` — `PayerIntegrationConfig` table; `PMJAY` on the `TpaProvider` enum.
- `apps/web/src/app/dashboard/billing/[id]/page.tsx` — drive the coverage stepper from live status.
- Reuse: ABDM crypto/gateway helpers for HCX JWE + signatures.
