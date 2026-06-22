-- Ward names are unique PER TENANT, not globally. A global UNIQUE on
-- wards."name" previously blocked any tenant from creating a ward whose name
-- another tenant (or a tenant-less seed row) already used — surfacing as a
-- raw `prisma.ward.create()` P2002 500 in the UI.
--
-- This drops the global unique and adds a composite ("tenantId", "name")
-- unique so each hospital gets its own ward namespace. Idempotent + uses the
-- @@map'd lowercase table name ("wards") so `migrate deploy` / raw apply works
-- cleanly. NB: Postgres treats NULL "tenantId" as distinct, so tenant-less
-- rows never collide under the composite key — matching app behaviour.
DROP INDEX IF EXISTS "wards_name_key";

CREATE UNIQUE INDEX IF NOT EXISTS "wards_tenantId_name_key"
  ON "wards" ("tenantId", "name");
