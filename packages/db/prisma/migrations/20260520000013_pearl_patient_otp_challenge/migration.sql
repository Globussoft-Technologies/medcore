-- ================================================================
-- 20260520000013_pearl_patient_otp_challenge
--
-- Closes Pearl ERP Stage 1 gap item #5 — piece 2 of 4 (PRD §5.3 + §6.1).
-- Pearl §5.3 demands patient login via phone OTP (separate auth surface
-- from staff /auth/login, which stays email + password ± TOTP). This
-- migration adds the OTP-challenge backing table used by
-- POST /api/v1/patient-auth/otp-request and /otp-verify.
--
-- Schema additive only. No existing tables touched. Patient.phone lookup
-- key already exists on User.phone (already indexed at line 974).
-- ================================================================

CREATE TABLE IF NOT EXISTS "patient_otp_challenges" (
  "id"        TEXT PRIMARY KEY,
  "phone"     TEXT NOT NULL,
  "otpHash"   TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "consumed"  BOOLEAN NOT NULL DEFAULT FALSE,
  "attempts"  INTEGER NOT NULL DEFAULT 0,
  "tenantId"  TEXT,
  "ipAddress" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "patient_otp_challenges_phone_idx"
  ON "patient_otp_challenges" ("phone");

CREATE INDEX IF NOT EXISTS "patient_otp_challenges_expiresAt_idx"
  ON "patient_otp_challenges" ("expiresAt");
