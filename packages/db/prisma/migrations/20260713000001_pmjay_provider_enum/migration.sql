-- PM-JAY (Ayushman Bharat) as a first-class TPA provider.
--
-- Stage A: extend the TpaProvider enum only. New PM-JAY tables
-- (PmjayBeneficiary, PmjayPackage, verification history, upload queue) plus the
-- PreAuthRequest / Admission field additions land in the Stage B migration.
--
-- Placed BEFORE 'MOCK' to match the value order in schema.prisma. Postgres
-- allows ALTER TYPE ... ADD VALUE outside an explicit transaction; `prisma
-- migrate deploy` runs each migration file on its own so this is safe.
ALTER TYPE "TpaProvider" ADD VALUE IF NOT EXISTS 'PMJAY' BEFORE 'MOCK';
