-- Patient contact email (per-tenant), decoupled from the global login identity.
-- Adds: patients."contactEmail" (nullable) + a (tenantId, contactEmail) index.
-- The patient email is NOT a login credential, so it lives on the patient row
-- and is unique only within a tenant (enforced at the app layer). Additive,
-- nullable, zero-data-loss. Idempotent + uses the @@map'd lowercase table name
-- ("patients") so `migrate deploy` / raw apply works cleanly.
ALTER TABLE "patients" ADD COLUMN IF NOT EXISTS "contactEmail" TEXT;

CREATE INDEX IF NOT EXISTS "patients_tenantId_contactEmail_idx"
  ON "patients" ("tenantId", "contactEmail");
