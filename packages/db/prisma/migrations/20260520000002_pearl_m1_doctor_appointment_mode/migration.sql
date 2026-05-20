-- ================================================================
-- 20260520000002_pearl_m1_doctor_appointment_mode
--
-- Pearl ERP Stage 1, Module 1 (PRD §2.1.2): three doctor modes —
-- Calling / Token / Slot — configurable per doctor in Settings.
--
-- Closes the largest M1 gap surfaced by the 2026-05-20 Pearl gap
-- analysis (docs/PEARL_STAGE1_GAP_ANALYSIS.md §1 build #1). Today
-- every Doctor implicitly behaves like TOKEN-mode: the booking
-- endpoint always mints a tokenNumber and (doctorId, date,
-- tokenNumber) carries a unique constraint.
--
-- This migration is additive and backward-compatible:
--   * Existing doctors get appointmentMode='TOKEN' — no observable
--     change in booking behaviour until the branching code lands.
--   * appointments.tokenNumber becomes nullable so CALLING/SLOT
--     bookings can omit it. Existing integer values are preserved;
--     Postgres allows multiple NULLs in a UNIQUE constraint so the
--     existing @@unique (doctorId, date, tokenNumber) still works
--     for TOKEN-mode rows and does not block null-token rows.
--   * appointments.arrivalSeq is added for CALLING-mode arrival
--     ordering (a counter scoped per doctor + date).
--   * A new UNIQUE constraint on (doctorId, date, slotStart)
--     enforces no-double-booking for SLOT mode. Walk-ins and
--     CALLING/TOKEN rows leave slotStart null and Postgres allows
--     multiple-NULL so this does NOT regress existing data.
--
-- The booking-endpoint branch-by-mode logic ships in a follow-up
-- commit; this migration only adds the data shape so the API +
-- web changes can layer on top.
-- ================================================================

-- ── new enums ──
CREATE TYPE "AppointmentMode" AS ENUM ('CALLING', 'TOKEN', 'SLOT');
CREATE TYPE "LastHourPolicy" AS ENUM ('ACCEPT_ALL', 'BLOCK_NEW', 'WALK_IN_ONLY');

-- ── Doctor: per-doctor appointment mode + Pearl knobs (§3.2 prefs) ──
ALTER TABLE "doctors"
  ADD COLUMN "appointmentMode" "AppointmentMode" NOT NULL DEFAULT 'TOKEN',
  ADD COLUMN "tokenPrefix" TEXT,
  ADD COLUMN "tokenStartNumber" INTEGER,
  ADD COLUMN "dailyAppointmentLimit" INTEGER,
  ADD COLUMN "nearTurnAlertThreshold" INTEGER,
  ADD COLUMN "lastHourPolicy" "LastHourPolicy";

-- ── Appointment: relax tokenNumber, add arrivalSeq, add slot uniqueness ──
ALTER TABLE "appointments" ALTER COLUMN "tokenNumber" DROP NOT NULL;
ALTER TABLE "appointments" ADD COLUMN "arrivalSeq" INTEGER;

-- New unique to enforce SLOT-mode no-double-booking. Postgres allows
-- multiple NULL slotStart values; this only enforces uniqueness on
-- non-null slot times, so existing walk-ins / null-slot rows do not
-- collide.
CREATE UNIQUE INDEX "appointments_doctorId_date_slotStart_key"
  ON "appointments" ("doctorId", "date", "slotStart");
