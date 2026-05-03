-- Migration: Add witness signature to controlled-substance dispense + Prescription status enum (2026-05-03)
--
-- Two additive changes that close the backend gaps surfaced by
-- e2e/pharmacist.spec.ts (per `docs/TEST_GAPS_2026-05-03.md` gap #2):
--
-- 1. ControlledSubstanceEntry gains `witnessSignature` (free-text capture
--    of the witnessing person — pharmacist + witness co-signing is required
--    for Schedule-H/H1 dispense in India per Drugs and Cosmetics Rules
--    1945 §65) and `witnessUserId` (optional FK to User if the witness is
--    a staff member with an account; null if external).
--
-- 2. Prescription gains a `status` enum field: PENDING (default for new
--    rows + existing rows backfilled), DISPENSED (full Rx dispensed),
--    REJECTED (pharmacist rejected the Rx with a reason), CANCELLED
--    (doctor revoked).
--
-- Both columns/types are additive. No data loss. No existing column is
-- dropped or narrowed. Safe to roll forward without an
-- [allow-destructive-migration] marker.

-- ─── 1. Witness signature on controlled_substance_register ─────────────────

ALTER TABLE "controlled_substance_register"
  ADD COLUMN "witnessSignature" TEXT,
  ADD COLUMN "witnessUserId"    TEXT;

ALTER TABLE "controlled_substance_register"
  ADD CONSTRAINT "controlled_substance_register_witnessUserId_fkey"
  FOREIGN KEY ("witnessUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "controlled_substance_register_witnessUserId_idx"
  ON "controlled_substance_register"("witnessUserId");

-- ─── 2. Prescription status enum + column ──────────────────────────────────

CREATE TYPE "PrescriptionStatus" AS ENUM (
  'PENDING',
  'DISPENSED',
  'REJECTED',
  'CANCELLED'
);

ALTER TABLE "prescriptions"
  ADD COLUMN "status"          "PrescriptionStatus" NOT NULL DEFAULT 'PENDING',
  ADD COLUMN "rejectionReason" TEXT,
  ADD COLUMN "rejectedAt"      TIMESTAMP(3),
  ADD COLUMN "rejectedBy"      TEXT;

ALTER TABLE "prescriptions"
  ADD CONSTRAINT "prescriptions_rejectedBy_fkey"
  FOREIGN KEY ("rejectedBy") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "prescriptions_status_idx" ON "prescriptions"("status");
CREATE INDEX "prescriptions_rejectedBy_idx" ON "prescriptions"("rejectedBy");
