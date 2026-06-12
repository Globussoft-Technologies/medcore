-- Restore platform-level users to a NULL tenant.
--
-- Platform-level users (SUPER_ADMIN / PLATFORM_OPERATOR / PLATFORM_BILLING_OPERATOR)
-- are tenant-LESS by design: super-admin detection across the app keys on
-- `role === "ADMIN" (coerced) && tenantId == null`, and the API tenant
-- middleware bypasses scoping for them. The 20260611000001 null→default
-- backfill swept any tenant-less user into the default tenant, which
-- incorrectly demoted these accounts to "default-tenant admin" — hiding the
-- super-admin nav (Tenants / Platform Billing / Observability) and surfacing
-- the clinic onboarding banner.
--
-- This sets them back to NULL. Idempotent + safe: these accounts own no
-- tenant-scoped rows, and tenantScopedPrisma treats NULL-tenant callers as
-- platform-level (no filter).

UPDATE "users"
SET "tenantId" = NULL
WHERE "role"::text IN ('SUPER_ADMIN', 'PLATFORM_OPERATOR', 'PLATFORM_BILLING_OPERATOR');
