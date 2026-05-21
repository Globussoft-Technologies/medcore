-- ================================================================
-- 20260520000011_pearl_appointment_branchid
--
-- Closes Pearl ERP Stage 1 gap item #2 — piece 2a (PRD §7.2) —
-- adds the first transactional `branchId` column + FK so the new
-- `branchScopedPrisma` Prisma extension (packages/db/src/branch-prisma.ts)
-- has a real table to auto-stamp on create and auto-filter on read.
--
-- Scope cut: ONLY `Appointment` lands in piece 2a. The remaining
-- tables flagged by the original gap (`Invoice`, `Doctor`,
-- `DoctorSchedule`, `Patient`, ...) ship in piece 2b alongside the
-- branch-picker UI (piece 3). Keeping the surface tiny here means
-- the wrapper proves end-to-end value (header → ALS → extension →
-- DB) on the most-trafficked table without touching invoicing or
-- HR while the picker UI is still pending.
--
-- Additive only — `branchId` is NULLABLE on purpose:
--   - existing rows stay NULL (no backfill in this migration; we will
--     opportunistically default-branch backfill in piece 2b once the
--     picker UI ships and Reception/Admin have a way to retag).
--   - requests without an `X-Branch-Id` header skip the extension's
--     auto-stamp and inherit the legacy behaviour (NULL branchId).
--
-- ON DELETE SET NULL on the FK — the branch can be soft-deleted (or
-- hard-deleted on a tenant teardown) without cascading the loss to
-- historical appointment rows, which would corrupt audit + billing
-- history.
-- ================================================================

ALTER TABLE "appointments"
  ADD COLUMN IF NOT EXISTS "branchId" TEXT;

ALTER TABLE "appointments"
  ADD CONSTRAINT "appointments_branchId_fkey"
    FOREIGN KEY ("branchId") REFERENCES "branches"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX IF NOT EXISTS "appointments_branchId_idx"
  ON "appointments"("branchId");
