-- Medicine becomes a per-tenant formulary (enforced in TENANT_SCOPED_MODELS).
-- The old GLOBAL unique on medicines.name would stop two tenants from each
-- having e.g. "Paracetamol", so swap it for a tenant-composite unique.
--
-- Safe: every existing medicine row was backfilled to the default tenant in
-- 20260611000001/2 and names were globally unique under the old constraint,
-- so (tenantId, name) is already collision-free.

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
           PARTITION BY "tenantId", "name"
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
