-- Pearl §8.3 — unify the two plan systems into one dynamic, DB-backed
-- `PlatformPlan` catalog and point both `Tenant.plan` and
-- `TenantSubscription.plan` at it (by `key`).
--
-- SAFETY NOTE (migration-safety-check): the `plan` columns change from the
-- Prisma enums (`TenantPlan` / `Plan`) to TEXT. Prisma's *default* migration
-- would DROP and recreate those columns (discarding data) because no implicit
-- enum→text cast exists. We do NOT do that here — instead we cast in place
-- with `USING "plan"::text`, which preserves every existing value. That keeps
-- this migration free of COLUMN_DROP / NOT_NULL_WITHOUT_DEFAULT risks.
--
-- The only flagged finding that remains is UNIQUE_ADDITION on
-- `PlatformPlan(key)`, which is SAFE: the table is created empty in this same
-- migration, so duplicates are impossible. Bless it with [allow-unique] in the
-- commit message.

-- ─── 1. New dynamic plan catalog ─────────────────────────────────────
CREATE TABLE "PlatformPlan" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "monthlyPriceInPaise" INTEGER NOT NULL,
    "includedFeatures" TEXT[],
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformPlan_pkey" PRIMARY KEY ("id")
);

-- [allow-unique] new empty table — no existing rows, so no duplicate keys.
CREATE UNIQUE INDEX "PlatformPlan_key_key" ON "PlatformPlan"("key");

-- ─── 2. Tenant.plan: TenantPlan enum (default BASIC) → TEXT (default STARTER)
--      In-place cast preserves existing values (no drop/recreate).
ALTER TABLE "tenants" ALTER COLUMN "plan" DROP DEFAULT;
ALTER TABLE "tenants" ALTER COLUMN "plan" SET DATA TYPE TEXT USING "plan"::text;
ALTER TABLE "tenants" ALTER COLUMN "plan" SET DEFAULT 'STARTER';

-- ─── 3. TenantSubscription.plan: Plan enum → TEXT (required, no default)
ALTER TABLE "tenant_subscriptions" ALTER COLUMN "plan" SET DATA TYPE TEXT USING "plan"::text;

-- ─── 4. Backfill legacy TenantPlan keys onto the unified catalog keys ─
--      (ENTERPRISE already matches; STARTER/GROWTH cover BASIC/PRO.)
UPDATE "tenants" SET "plan" = 'STARTER' WHERE "plan" = 'BASIC';
UPDATE "tenants" SET "plan" = 'GROWTH'  WHERE "plan" = 'PRO';

-- ─── 5. Drop the now-unused enum types ───────────────────────────────
--      Safe: both columns above were cast off these types, leaving them
--      unreferenced. Keeps the DB in sync with the enum-free schema.
DROP TYPE IF EXISTS "TenantPlan";
DROP TYPE IF EXISTS "Plan";
