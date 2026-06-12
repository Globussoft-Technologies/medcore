-- SOW §2.1.1 — add state + PIN to the patient registration address triplet.
-- Additive, nullable columns; zero-data-loss.
ALTER TABLE "Patient" ADD COLUMN "state" TEXT;
ALTER TABLE "Patient" ADD COLUMN "pincode" TEXT;
