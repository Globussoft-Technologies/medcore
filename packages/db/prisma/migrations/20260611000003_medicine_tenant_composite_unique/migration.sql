-- Medicine becomes a per-tenant formulary (enforced in TENANT_SCOPED_MODELS).
-- The old GLOBAL unique on medicines.name would stop two tenants from each
-- having e.g. "Paracetamol", so swap it for a tenant-composite unique.
--
-- Safe: every existing medicine row was backfilled to the default tenant in
-- 20260611000001/2 and names were globally unique under the old constraint,
-- so (tenantId, name) is already collision-free.

-- Ensure the tenant column exists (added in 20260611000002; repeated here
-- defensively so this migration is self-sufficient even on a self-heal
-- re-apply). IF NOT EXISTS → no-op in the normal ordered run.
ALTER TABLE "medicines" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;

-- Drop the old GLOBAL unique on medicines.name. Prisma may have materialised
-- `@unique` as either a table CONSTRAINT or a bare unique INDEX depending on
-- the version that first created it. A constraint-backed index CANNOT be
-- removed with DROP INDEX (Postgres errors "cannot drop index ... because
-- constraint ... requires it"), which is exactly what made the original lone
-- `DROP INDEX` line fail and left this migration permanently P3009-blocked on
-- the deploy DB. Issue BOTH drops — each IF EXISTS, so whichever form does not
-- apply is a harmless no-op.
ALTER TABLE "medicines" DROP CONSTRAINT IF EXISTS "medicines_name_key";
DROP INDEX IF EXISTS "medicines_name_key";

-- Deduplicate any pre-existing (tenantId, name) collisions BEFORE adding the
-- composite unique index. The old global unique was just dropped above, and on
-- some DBs the medicines table already holds duplicate names within a tenant
-- (e.g. re-run pharmacy/controlled-register seeds), which would make the
-- CREATE UNIQUE INDEX below fail with 23505. We keep the earliest row's name
-- and suffix every later duplicate with its short id — a rename that is
-- guaranteed collision-free and deletes NO rows, so every prescription / stock
-- / Kanban reference to a medicine id stays intact. Idempotent: after the
-- rename names are unique, so re-running this finds no rn>1 rows.
WITH ranked AS (
  SELECT id,
         row_number() OVER (
           -- COALESCE so rows with a NULL tenantId (Main hospital) are treated
           -- as one group too — the composite index can then never hit 23505.
           PARTITION BY COALESCE("tenantId", '__null_tenant__'), "name"
           ORDER BY "id"
         ) AS rn
  FROM "medicines"
)
UPDATE "medicines" m
SET "name" = m."name" || ' [dup:' || m."id" || ']'
FROM ranked r
WHERE m."id" = r."id" AND r."rn" > 1;

CREATE UNIQUE INDEX IF NOT EXISTS "medicines_tenantId_name_key"
  ON "medicines" ("tenantId", "name");
