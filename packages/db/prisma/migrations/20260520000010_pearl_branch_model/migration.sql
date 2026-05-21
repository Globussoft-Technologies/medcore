-- ================================================================
-- 20260520000010_pearl_branch_model
--
-- Closes Pearl ERP Stage 1 gap item #2 — piece 1 of 3 (PRD §7.2 +
-- §8.1) — per-tenant Branch model. Pearl explicitly requires
-- multi-branch hospitals: the onboarding wizard step 2 creates the
-- "first branch + super-admin user" and every transactional report
-- must filter by branch.
--
-- This migration is the foundation. Pieces 2 and 3 (branchScopedPrisma
-- extension + branchId columns on ~20 tables + branch picker UI +
-- branch filter on reports) ship in later commits.
--
-- Invariant: one Branch per tenant must have isDefault=true. Enforced
-- in the API layer (POST auto-defaults the first branch; PATCH that
-- sets isDefault=true atomically unsets the previous default; DELETE
-- refuses to soft-delete the default). Postgres has no first-class
-- partial-unique-index that Prisma can declare in schema for this
-- shape, so the invariant is API-enforced.
--
-- Schema additive only. No existing tables touched.
-- ================================================================

CREATE TABLE IF NOT EXISTS "branches" (
  "id"        TEXT PRIMARY KEY,
  "tenantId"  TEXT NOT NULL,
  "name"      TEXT NOT NULL,
  "code"      TEXT,
  "address"   TEXT,
  "city"      TEXT,
  "state"     TEXT,
  "pincode"   TEXT,
  "phone"     TEXT,
  "email"     TEXT,
  "gstin"     TEXT,
  "isDefault" BOOLEAN NOT NULL DEFAULT FALSE,
  "active"    BOOLEAN NOT NULL DEFAULT TRUE,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "branches_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "branches_tenantId_code_key"
  ON "branches"("tenantId", "code");

CREATE INDEX IF NOT EXISTS "branches_tenantId_idx"
  ON "branches"("tenantId");

CREATE INDEX IF NOT EXISTS "branches_tenantId_active_idx"
  ON "branches"("tenantId", "active");
