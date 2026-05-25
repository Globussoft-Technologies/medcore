-- ================================================================
-- 20260523000001_pearl_chronic_care_cohort_dsl
--
-- Closes Pearl ERP Stage 1 §5.2 gap matrix rows 142-145.
--
-- Today:
--   - `chronic_care_plans` is a PER-PATIENT row (one row per patient
--     enrolled in chronic-care follow-ups). There is no tenant-level
--     cohort template, so "all diabetics" can't be expressed as data —
--     only as a query in route code.
--   - `chronic_care_scheduler.ts` fans out one fixed-cadence reminder
--     per active plan. No "sequence of touchpoints" model exists.
--   - No cron auto-enrols matching patients into a plan; staff have to
--     POST /chronic-care/plans manually for each patient.
--
-- This migration:
--   1. Adds `chronic_care_cohorts` — the TENANT-LEVEL cohort template
--      (name, condition, rule DSL JSON, active). Sibling of
--      `campaign_audiences.rules` (Pearl §5.1) — shape compatible with
--      `services/audience-compiler.ts` (shipped via f701b52).
--   2. Adds `cohort_sequence_steps` — the per-cohort sequence of
--      touchpoints. Each step has a delay-from-prior + a template key +
--      fan-out channels.
--   3. Extends `chronic_care_plans` with `cohortId` (FK back to the
--      template, NULL for manual plans — back-compat) and the per-
--      enrolment sequence pointer `lastStepSent` + `lastStepSentAt`.
--
-- Schema additive only. Existing chronic_care_plans rows continue to
-- function unchanged because every new column is NULL-default-able.
-- ================================================================

-- ── chronic_care_cohorts ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "chronic_care_cohorts" (
  "id"          TEXT PRIMARY KEY,
  "name"        TEXT NOT NULL,
  "description" TEXT,
  "condition"   "ChronicConditionCode",
  "cohortRule"  JSONB,
  "active"      BOOLEAN NOT NULL DEFAULT true,
  "createdBy"   TEXT NOT NULL,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL,
  "tenantId"    TEXT
);

ALTER TABLE "chronic_care_cohorts"
  ADD CONSTRAINT "chronic_care_cohorts_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX IF NOT EXISTS "chronic_care_cohorts_tenantId_active_idx"
  ON "chronic_care_cohorts" ("tenantId", "active");
CREATE INDEX IF NOT EXISTS "chronic_care_cohorts_condition_idx"
  ON "chronic_care_cohorts" ("condition");

-- ── cohort_sequence_steps ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "cohort_sequence_steps" (
  "id"                  TEXT PRIMARY KEY,
  "chronicCareCohortId" TEXT NOT NULL,
  "stepNumber"          INTEGER NOT NULL,
  "delayDays"           INTEGER NOT NULL DEFAULT 0,
  "templateKey"         TEXT NOT NULL,
  "channels"            "NotificationChannel"[] NOT NULL DEFAULT ARRAY[]::"NotificationChannel"[],
  "active"              BOOLEAN NOT NULL DEFAULT true,
  "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"           TIMESTAMP(3) NOT NULL,
  "tenantId"            TEXT
);

ALTER TABLE "cohort_sequence_steps"
  ADD CONSTRAINT "cohort_sequence_steps_chronicCareCohortId_fkey"
  FOREIGN KEY ("chronicCareCohortId") REFERENCES "chronic_care_cohorts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "cohort_sequence_steps"
  ADD CONSTRAINT "cohort_sequence_steps_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX IF NOT EXISTS "cohort_sequence_steps_chronicCareCohortId_stepNumber_key"
  ON "cohort_sequence_steps" ("chronicCareCohortId", "stepNumber");
CREATE INDEX IF NOT EXISTS "cohort_sequence_steps_chronicCareCohortId_active_idx"
  ON "cohort_sequence_steps" ("chronicCareCohortId", "active");
CREATE INDEX IF NOT EXISTS "cohort_sequence_steps_tenantId_idx"
  ON "cohort_sequence_steps" ("tenantId");

-- ── chronic_care_plans extension ─────────────────────────────────
ALTER TABLE "chronic_care_plans"
  ADD COLUMN IF NOT EXISTS "cohortId"       TEXT,
  ADD COLUMN IF NOT EXISTS "lastStepSent"   INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "lastStepSentAt" TIMESTAMP(3);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chronic_care_plans_cohortId_fkey'
  ) THEN
    ALTER TABLE "chronic_care_plans"
      ADD CONSTRAINT "chronic_care_plans_cohortId_fkey"
      FOREIGN KEY ("cohortId") REFERENCES "chronic_care_cohorts"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "chronic_care_plans_cohortId_active_idx"
  ON "chronic_care_plans" ("cohortId", "active");
