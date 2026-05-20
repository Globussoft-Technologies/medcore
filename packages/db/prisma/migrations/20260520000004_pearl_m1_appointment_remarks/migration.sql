-- ================================================================
-- 20260520000004_pearl_m1_appointment_remarks
--
-- Closes Pearl Stage 1 M1 §2.1.7 — Threaded remarks per appointment
-- (multi-role, visibility-scoped, pinnable, audited).
--
-- Replaces the single Appointment.notes string with a multi-author
-- conversation. Each remark carries an explicit visibility scope so
-- DOCTOR_ONLY notes don't leak to RECEPTION and vice versa. Threading
-- via parentRemarkId; pinning via isPinned; soft-edit tracking via
-- editedAt.
--
-- PATIENT role never sees AppointmentRemark rows — enforced at the
-- route handler with authorize(...) excluding Role.PATIENT.
--
-- Idempotent guards: CREATE TYPE IF NOT EXISTS via DO block (Postgres
-- has no native IF NOT EXISTS for CREATE TYPE), CREATE TABLE IF NOT
-- EXISTS for the table, CREATE INDEX IF NOT EXISTS for indexes.
-- ================================================================

-- Visibility enum
DO $$ BEGIN
  CREATE TYPE "AppointmentRemarkVisibility" AS ENUM (
    'ALL_STAFF', 'DOCTOR_ONLY', 'RECEPTION_ONLY', 'PRIVATE'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- Main table
CREATE TABLE IF NOT EXISTS "appointment_remarks" (
  "id"             TEXT PRIMARY KEY,
  "appointmentId"  TEXT NOT NULL,
  "authorUserId"   TEXT NOT NULL,
  "parentRemarkId" TEXT,
  "body"           TEXT NOT NULL,
  "visibility"     "AppointmentRemarkVisibility" NOT NULL DEFAULT 'ALL_STAFF',
  "isPinned"       BOOLEAN NOT NULL DEFAULT false,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,
  "editedAt"       TIMESTAMP(3),
  "tenantId"       TEXT,

  CONSTRAINT "appointment_remarks_appointmentId_fkey"
    FOREIGN KEY ("appointmentId") REFERENCES "appointments"("id") ON DELETE CASCADE,
  CONSTRAINT "appointment_remarks_authorUserId_fkey"
    FOREIGN KEY ("authorUserId") REFERENCES "users"("id") ON DELETE NO ACTION,
  CONSTRAINT "appointment_remarks_parentRemarkId_fkey"
    FOREIGN KEY ("parentRemarkId") REFERENCES "appointment_remarks"("id") ON DELETE SET NULL,
  CONSTRAINT "appointment_remarks_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "appointment_remarks_appointmentId_idx"
  ON "appointment_remarks"("appointmentId");
CREATE INDEX IF NOT EXISTS "appointment_remarks_authorUserId_idx"
  ON "appointment_remarks"("authorUserId");
CREATE INDEX IF NOT EXISTS "appointment_remarks_parentRemarkId_idx"
  ON "appointment_remarks"("parentRemarkId");
CREATE INDEX IF NOT EXISTS "appointment_remarks_tenantId_idx"
  ON "appointment_remarks"("tenantId");
