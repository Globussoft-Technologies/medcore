-- ================================================================
-- 20260520000008_pearl_rx_allergy_override
--
-- Pearl ERP Stage 1 §2.1.4 acceptance — drug-allergy block must be
-- overrideable with a clinical reason that is PERSISTED on the Rx
-- row (not just audited). Reviewers need to read the reason from
-- the prescription itself when validating prescribing decisions.
--
--  • Prescription.allergyOverrideReason TEXT NULL — free-text reason
--    the prescriber typed at override time (Zod enforces min 10 chars
--    at the route layer; column is wider for flexibility).
--  • Prescription.allergyOverrideAt TIMESTAMPTZ NULL — when override
--    fired. Lets the UI show "Overridden on <date>" + lets compliance
--    queries find any Rx where the safety check was bypassed.
--  • PatientAllergy.active BOOLEAN NOT NULL DEFAULT TRUE — soft-flag
--    so an erroneously logged allergy (typo, since-confirmed false
--    positive) can be deactivated without deleting the history. The
--    block-engine only cross-references allergies with active=true.
--    Existing rows are backfilled to TRUE on rollout — every logged
--    allergy is considered active until a clinician marks it false.
--
-- Additive + backward-compatible. Existing API consumers and PDF
-- renderers see no behavioural change unless an override is used.
-- ================================================================

ALTER TABLE "prescriptions" ADD COLUMN "allergyOverrideReason" TEXT;
ALTER TABLE "prescriptions" ADD COLUMN "allergyOverrideAt" TIMESTAMP(3);

ALTER TABLE "patient_allergies" ADD COLUMN "active" BOOLEAN NOT NULL DEFAULT TRUE;
