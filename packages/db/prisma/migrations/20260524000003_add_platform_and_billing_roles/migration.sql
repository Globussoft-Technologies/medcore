-- ================================================================
-- 20260524000003_add_platform_and_billing_roles
--
-- Pearl ERP Stage 1 §8.2 (gap row 209 scope-reduced) + OPEN_DECISIONS
-- item #4 (BILLING role on shared TS enum), closed 2026-05-24.
--
-- Stage-1 scope reduction (per PEARL_OPEN_DECISIONS.md item #3): instead
-- of the full per-tenant / per-module `Permission` + `Grant` tables
-- (deferred to Stage 2), we add three new values to the existing `Role`
-- enum to cover the ~80% of Pearl Stage 1 needs:
--
--   - BILLING                     — finance staff inside a tenant; gets
--                                   the four §4.4 reports (TDS, no-show,
--                                   referring-doctor commission ledger,
--                                   lead-to-patient funnel) alongside
--                                   ADMIN.
--   - PLATFORM_OPERATOR           — Onviqa platform staff running the
--                                   MedCore platform; tenantId=null in
--                                   the JWT; tenantContextMiddleware
--                                   short-circuits tenant-scope filter
--                                   for these users via the new
--                                   PLATFORM_ROLES allow-list export
--                                   from `@medcore/db`.
--   - PLATFORM_BILLING_OPERATOR   — Onviqa finance staff; billing-only
--                                   subset of PLATFORM_OPERATOR. Also
--                                   tenant-less; also bypasses the
--                                   tenant filter.
--
-- Strictly additive: 3 new enum values on an existing enum. No existing
-- column altered, no constraint dropped. Safe online — Postgres ALTER
-- TYPE ... ADD VALUE only takes a brief AccessExclusiveLock on the
-- type catalog, not on any table that references it.
-- ================================================================

ALTER TYPE "Role" ADD VALUE 'BILLING';
ALTER TYPE "Role" ADD VALUE 'PLATFORM_OPERATOR';
ALTER TYPE "Role" ADD VALUE 'PLATFORM_BILLING_OPERATOR';
