-- ================================================================
-- 20260520000005_pearl_tenant_feature_flags
--
-- Closes Pearl ERP Stage 1 gap item #9 (PRD §6 + §18) — per-tenant
-- feature flags so a Pearl-branded tenant deployment can hide the
-- Stage 2+ surfaces (IPD, OT, telemedicine, voice-rx, AI-discharge,
-- predictive CDS, AI radiology, HRMS/payroll, ABDM M2/M3/M4,
-- NABH dashboard, HL7 inbound).
--
-- Schema additive only:
--   Tenant.featureFlags JSONB NULL — JSON object {<featureKey>: bool}.
--   NULL = "all features enabled" (current MedCore default, no
--   regression for non-Pearl tenants).
--
-- Resolution at runtime: packages/shared/src/feature-flags.ts defines
-- the canonical FEATURE_KEYS list + per-key defaults; the API uses
-- apps/api/src/services/feature-flags.ts to merge stored overrides
-- with defaults; the web mirrors via GET /api/v1/feature-flags.
-- ================================================================

ALTER TABLE "tenants"
  ADD COLUMN IF NOT EXISTS "featureFlags" JSONB;
