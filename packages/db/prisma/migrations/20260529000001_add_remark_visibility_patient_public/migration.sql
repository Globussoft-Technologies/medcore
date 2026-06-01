-- ================================================================
-- 20260529000001_add_remark_visibility_patient_public
--
-- Pearl ERP Stage 1 §2.1.7 (gap closed 2026-05-29).
--
-- The SOW lists three visibility tiers for appointment remarks:
--   "staff-only · patient-visible · public"
--
-- The schema shipped with only the four staff-scoped values
-- (ALL_STAFF, DOCTOR_ONLY, RECEPTION_ONLY, PRIVATE). This migration
-- adds the two patient-facing tiers so:
--   - PATIENT_VISIBLE: readable by the appointment's patient + all
--     staff. Patients can author remarks at this level (the only
--     authorship path they have).
--   - PUBLIC: readable by anyone authenticated who can see the
--     appointment (staff + patient + future delegated viewers).
--     Staff-only authorship.
--
-- Postgres requires ALTER TYPE ... ADD VALUE outside a transaction
-- block; Prisma runs each statement separately so this is safe.
-- ================================================================

ALTER TYPE "AppointmentRemarkVisibility" ADD VALUE IF NOT EXISTS 'PATIENT_VISIBLE';
ALTER TYPE "AppointmentRemarkVisibility" ADD VALUE IF NOT EXISTS 'PUBLIC';
