-- ================================================================
-- 20260529000002_add_appointment_action_reasons
--
-- Pearl ERP Stage 1 §3.1 (gaps closed 2026-05-29).
--
-- "Cancel / reschedule / no-show flows with reasons" — the SOW lists
-- reason capture on all three but the schema only had `lwbsReason`.
-- Adding three nullable columns so the Zod schemas can require the
-- reason at the boundary (status flip to CANCELLED, PATCH /reschedule,
-- status flip to NO_SHOW) while keeping pre-existing rows valid.
-- ================================================================

ALTER TABLE "appointments"
  ADD COLUMN IF NOT EXISTS "cancellationReason" TEXT,
  ADD COLUMN IF NOT EXISTS "rescheduleReason"   TEXT,
  ADD COLUMN IF NOT EXISTS "noShowReason"       TEXT;
