-- SOW §2.1.1 — add state + PIN to the patient registration address triplet.
-- Additive, nullable columns; zero-data-loss. Idempotent (IF NOT EXISTS) so a
-- retried deploy after a P3009 recovery never errors on already-added columns.
ALTER TABLE "Patient" ADD COLUMN IF NOT EXISTS "state" TEXT;
ALTER TABLE "Patient" ADD COLUMN IF NOT EXISTS "pincode" TEXT;
