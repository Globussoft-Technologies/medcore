-- ================================================================
-- 20260528000001_add_care_cohorts
--
-- Closes SOW gap M4 row 2 — care cohorts (named patient groups).
-- Cohorts are tenant-scoped; CohortMember is an explicit many-to-many
-- join so per-membership metadata (note, addedBy) can grow without a
-- destructive migration.
--
-- Schema additive only. No existing data is touched.
-- ================================================================

-- ── Cohort ──
CREATE TABLE IF NOT EXISTS "cohorts" (
  "id"              TEXT PRIMARY KEY,
  "name"            TEXT NOT NULL,
  "description"     TEXT,
  "archivedAt"      TIMESTAMP(3),
  "createdByUserId" TEXT,
  "tenantId"        TEXT,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL,

  CONSTRAINT "cohorts_createdByUserId_fkey"
    FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE SET NULL,
  CONSTRAINT "cohorts_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "cohorts_tenantId_idx"        ON "cohorts"("tenantId");
CREATE INDEX IF NOT EXISTS "cohorts_createdByUserId_idx" ON "cohorts"("createdByUserId");
CREATE INDEX IF NOT EXISTS "cohorts_archivedAt_idx"      ON "cohorts"("archivedAt");

-- ── CohortMember ──
CREATE TABLE IF NOT EXISTS "cohort_members" (
  "id"            TEXT PRIMARY KEY,
  "cohortId"      TEXT NOT NULL,
  "patientId"     TEXT NOT NULL,
  "note"          TEXT,
  "addedByUserId" TEXT,
  "tenantId"      TEXT,
  "addedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "cohort_members_cohortId_fkey"
    FOREIGN KEY ("cohortId") REFERENCES "cohorts"("id") ON DELETE CASCADE,
  CONSTRAINT "cohort_members_patientId_fkey"
    FOREIGN KEY ("patientId") REFERENCES "patients"("id") ON DELETE CASCADE,
  CONSTRAINT "cohort_members_addedByUserId_fkey"
    FOREIGN KEY ("addedByUserId") REFERENCES "users"("id") ON DELETE SET NULL,
  CONSTRAINT "cohort_members_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "cohort_members_cohortId_patientId_key"
  ON "cohort_members"("cohortId", "patientId");
CREATE INDEX IF NOT EXISTS "cohort_members_cohortId_idx"  ON "cohort_members"("cohortId");
CREATE INDEX IF NOT EXISTS "cohort_members_patientId_idx" ON "cohort_members"("patientId");
CREATE INDEX IF NOT EXISTS "cohort_members_tenantId_idx"  ON "cohort_members"("tenantId");
