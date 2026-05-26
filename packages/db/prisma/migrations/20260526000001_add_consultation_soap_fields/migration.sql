-- Pearl ERP Stage 1 §2.1.3 — extend Consultation row to back the
-- manual SOAP-tabbed consult screen. New columns:
--   subjective / objective / assessment / plan: SOAP free-text per tab
--   icd10Codes / snomedCodes: JSON arrays of `{ code, description }`
--   status / signedAt: lifecycle (DRAFT until doctor finalizes → SIGNED)
-- All new columns are nullable / have safe defaults so existing rows
-- (legacy `notes` + `findings`) keep working unchanged.

ALTER TABLE "consultations" ADD COLUMN "subjective" TEXT;
ALTER TABLE "consultations" ADD COLUMN "objective" TEXT;
ALTER TABLE "consultations" ADD COLUMN "assessment" TEXT;
ALTER TABLE "consultations" ADD COLUMN "plan" TEXT;
ALTER TABLE "consultations" ADD COLUMN "icd10Codes" JSONB;
ALTER TABLE "consultations" ADD COLUMN "snomedCodes" JSONB;
ALTER TABLE "consultations" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'DRAFT';
ALTER TABLE "consultations" ADD COLUMN "signedAt" TIMESTAMP(3);
