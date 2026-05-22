-- ================================================================
-- 20260522000001_pearl_patient_source_tag
--
-- Pearl ERP Stage 1 §2.1.1 — patient registration source attribution
-- for marketing / CRM analytics. Adds a new enum `PatientSource` and
-- a `source` column on `patients` with a DEFAULT of WALK_IN so legacy
-- rows that pre-date the PWA + web-panel registration paths don't
-- need a per-row backfill.
--
-- Additive only:
--   * `PatientSource` enum is brand new — no existing dependency.
--   * `patients.source` is NOT NULL with DEFAULT 'WALK_IN' — Postgres
--     populates every existing row in a single rewrite, so the
--     migration is one-shot safe even on multi-million-row tenants.
--   * `patients_source_idx` covers the marketing-analytics query
--     "how many new patients came in via PWA last month".
--
-- Staff route layer (`apps/api/src/routes/patients.ts` POST /) sets
-- source = WEB when the request body omits it; the schema DEFAULT
-- WALK_IN remains in effect for any external code path that calls
-- prisma.patient.create() without an explicit value (legacy seeders,
-- e2e fixtures, future cron-driven walk-in imports).
-- ================================================================

-- ── Enum ──
CREATE TYPE "PatientSource" AS ENUM (
  'WEB',
  'PWA',
  'WALK_IN',
  'REFERRAL',
  'WHATSAPP',
  'PHONE',
  'OTHER'
);

-- ── Column + index ──
ALTER TABLE "patients"
  ADD COLUMN "source" "PatientSource" NOT NULL DEFAULT 'WALK_IN';

CREATE INDEX "patients_source_idx"
  ON "patients"("source");
