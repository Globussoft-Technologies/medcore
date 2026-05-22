-- ================================================================
-- 20260522000002_pearl_doctor_favourite_medicine
--
-- Pearl ERP Stage 1 §2.1.4 (gap item #50) — per-doctor favourite-
-- medicine quick-add list. Each doctor maintains a personal list of
-- frequently-prescribed medicines that surface as one-tap chips
-- above the medicine-search results in the Rx writer. Optional
-- per-favourite default dosage / frequency / duration load a full
-- preset ("Amoxicillin 500mg TID 5d") in a single click.
--
-- Additive only:
--   * Brand-new table `doctor_favourite_medicines` with no existing
--     dependency on app code.
--   * tenantId is denormalized (kept in sync by the per-tenant Prisma
--     extension on create) so per-tenant queries don't need a join
--     through `doctors`.
--   * @@unique([doctorId, medicineId]) prevents a doctor from
--     favouriting the same medicine twice — POST returns 409 on dup.
-- ================================================================

CREATE TABLE "doctor_favourite_medicines" (
  "id"                TEXT NOT NULL,
  "doctorId"          TEXT NOT NULL,
  "medicineId"        TEXT NOT NULL,
  "position"          INTEGER NOT NULL DEFAULT 0,
  "defaultDosage"     TEXT,
  "defaultFrequency"  TEXT,
  "defaultDuration"   TEXT,
  "tenantId"          TEXT NOT NULL,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3) NOT NULL,
  CONSTRAINT "doctor_favourite_medicines_pkey" PRIMARY KEY ("id")
);

-- ── Uniqueness + indexes ──
CREATE UNIQUE INDEX "doctor_favourite_medicines_doctorId_medicineId_key"
  ON "doctor_favourite_medicines"("doctorId", "medicineId");

CREATE INDEX "doctor_favourite_medicines_doctorId_idx"
  ON "doctor_favourite_medicines"("doctorId");

CREATE INDEX "doctor_favourite_medicines_tenantId_idx"
  ON "doctor_favourite_medicines"("tenantId");

-- ── Foreign keys ──
ALTER TABLE "doctor_favourite_medicines"
  ADD CONSTRAINT "doctor_favourite_medicines_doctorId_fkey"
  FOREIGN KEY ("doctorId") REFERENCES "doctors"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "doctor_favourite_medicines"
  ADD CONSTRAINT "doctor_favourite_medicines_medicineId_fkey"
  FOREIGN KEY ("medicineId") REFERENCES "medicines"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
