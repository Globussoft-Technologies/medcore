-- ================================================================
-- 20260522000005_pearl_doctor_channels_buffer
--
-- Pearl ERP Stage 1 §3.2 — final 2 knobs of the per-doctor
-- preference editor (gap row 77 closure, 2026-05-22):
--
--   1. Doctor.enabledChannels  AppointmentChannel[] DEFAULT '{}'
--      Explicit allow-list of booking channels the doctor accepts.
--      Empty array = "all channels permitted" (back-compat default
--      so every existing doctor keeps working unchanged once the
--      migration lands).
--
--   2. Doctor.bufferMinutes    INTEGER DEFAULT 0
--      Doctor-level DEFAULT buffer (minutes) between consecutive
--      slots / tokens. Distinct from
--      doctor_schedules.bufferMinutes which can override per
--      weekday schedule. 0 preserves legacy MedCore behaviour.
--
-- Closes the last 2 of 8 knobs called out in docs/PEARL-ERP-STAGE-1-SOW.md
-- §3.2. Strictly additive — no data backfill, no existing column
-- altered, no constraint dropped, so this is a safe online migration.
-- ================================================================

-- ── new enum ──
CREATE TYPE "AppointmentChannel" AS ENUM ('CALLING', 'SLOT', 'TOKEN', 'WALKIN');

-- ── Doctor: add the 2 final preference-editor knobs ──
ALTER TABLE "doctors"
  ADD COLUMN "enabledChannels" "AppointmentChannel"[] NOT NULL DEFAULT '{}',
  ADD COLUMN "bufferMinutes" INTEGER NOT NULL DEFAULT 0;
