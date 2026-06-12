-- Dynamic, DB-backed super-admin permission-grant catalog. Mirrors the
-- PlatformPlan catalog (20260602000001): a new, empty reference table seeded
-- from @medcore/shared. The invite form + API validation read it at runtime so
-- grants can be added / edited / disabled without a code change.
--
-- The only flagged finding is UNIQUE_ADDITION on SuperAdminPermission(key),
-- which is SAFE: the table is created empty in this same migration, so
-- duplicate keys are impossible. [allow-unique]

CREATE TABLE "SuperAdminPermission" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "defaultGranted" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SuperAdminPermission_pkey" PRIMARY KEY ("id")
);

-- [allow-unique] new empty table — no existing rows, so no duplicate keys.
CREATE UNIQUE INDEX "SuperAdminPermission_key_key" ON "SuperAdminPermission"("key");

-- Seed the baseline grants inline so the catalog is usable the moment this
-- migration applies (no separate reseed needed). These mirror
-- SUPER_ADMIN_PERMISSIONS in @medcore/shared and stay editable at runtime; the
-- idempotent seed (packages/db/src/seed.ts) keeps them in sync on reseeds.
-- ON CONFLICT makes a re-apply / overlap with the seed a no-op.
INSERT INTO "SuperAdminPermission"
  ("id", "key", "label", "description", "defaultGranted", "active", "sortOrder", "updatedAt")
VALUES
  (gen_random_uuid(), 'canManageTenants', 'Manage tenants', 'Create / suspend / restore / archive tenants', true,  true, 1, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'canOnboardTenant', 'Onboard tenant', 'Run the 8-step tenant onboarding wizard',       true,  true, 2, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'canViewBilling',   'View billing',   'Platform billing dashboards + invoices',          false, true, 3, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'canTriggerJobs',   'Trigger jobs',   'Retry failed crons, manual archival',             false, true, 4, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'canDpdpWorkbench', 'DPDP workbench', 'Execute right-to-erasure requests',               false, true, 5, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'canViewAudit',     'View audit trail','Read the cross-tenant super-admin audit log',    true,  true, 6, CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO NOTHING;
