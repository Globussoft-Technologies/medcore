-- Medicine becomes a per-tenant formulary (enforced in TENANT_SCOPED_MODELS).
-- The old GLOBAL unique on medicines.name would stop two tenants from each
-- having e.g. "Paracetamol", so swap it for a tenant-composite unique.
--
-- Safe: every existing medicine row was backfilled to the default tenant in
-- 20260611000001/2 and names were globally unique under the old constraint,
-- so (tenantId, name) is already collision-free.

DROP INDEX IF EXISTS "medicines_name_key";

CREATE UNIQUE INDEX IF NOT EXISTS "medicines_tenantId_name_key"
  ON "medicines" ("tenantId", "name");
