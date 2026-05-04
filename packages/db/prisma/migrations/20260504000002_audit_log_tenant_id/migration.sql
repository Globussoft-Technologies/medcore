-- ================================================================
-- 20260504000002_audit_log_tenant_id
--
-- Issue #456 — AuditLog has no `tenantId`.
--
-- Until now `audit_logs` was the only operational table without a
-- tenantId column. That meant every cross-tenant admin reading
-- /api/v1/audit was implicitly a super-admin: any tenant's admin
-- could see (and CSV-export) every other tenant's audit history,
-- including PHI-bearing entityIds and free-form `details` blobs.
-- Worst-case this is a HIPAA / DPDP breach surface, day-one for
-- tenant T2 onboarding.
--
-- This migration is ADDITIVE ONLY:
--   * Add a NULLABLE `tenantId TEXT` column on `audit_logs`.
--   * Add an FK to `tenants(id)` with ON DELETE SET NULL — losing a
--     tenant should NEVER cascade-destroy its forensic trail.
--   * Backfill from `users.tenantId` for every row with a non-NULL
--     `userId`. System / cron rows where `userId IS NULL` (login
--     failures from unknown accounts, bootstrap jobs) stay NULL.
--   * Add a partial index on (tenantId, createdAt DESC) to power
--     the per-tenant Audit Log dashboard's most common query path.
--
-- Column stays NULLABLE in this migration. A follow-up migration
-- will tighten to NOT NULL after we confirm production backfill is
-- clean and after the writer in `apps/api/src/middleware/audit.ts`
-- has been deployed for at least one retention cycle (so any new
-- writes that DID stamp NULL — bootstrap-only — have aged out).
-- ================================================================

-- ─── 1. Add nullable column ──────────────────────────────────────

ALTER TABLE "audit_logs" ADD COLUMN "tenantId" TEXT;

-- ─── 2. FK to tenants — SET NULL on tenant delete ────────────────
-- Cascading the delete would erase the auditable record of what
-- happened *to* that tenant, which is exactly what we want
-- preserved for compliance review post-offboarding.

ALTER TABLE "audit_logs"
    ADD CONSTRAINT "audit_logs_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- ─── 3. Backfill from users.tenantId ─────────────────────────────
-- Pre-existing rows that have a `userId` get tagged with whatever
-- tenant that user currently belongs to. Rows where the user has
-- since been deleted or is cross-tenant (userId IS NULL on
-- users.tenantId) stay NULL — there's no defensible way to assign
-- them retroactively.

UPDATE "audit_logs" AS a
SET "tenantId" = u."tenantId"
FROM "users" AS u
WHERE a."userId" = u."id"
  AND a."tenantId" IS NULL
  AND u."tenantId" IS NOT NULL;

-- ─── 4. Partial index for the per-tenant dashboard ───────────────
-- The audit dashboard query is "give me this tenant's last N rows
-- ordered by createdAt DESC". A composite (tenantId, createdAt
-- DESC) index serves both the WHERE filter and the ORDER BY in a
-- single index scan. We make it partial on `tenantId IS NOT NULL`
-- so legacy / system NULL rows don't bloat the b-tree — they're
-- only readable through the un-scoped admin path which can fall
-- back to the existing single-column createdAt index.

CREATE INDEX "audit_logs_tenantId_createdAt_idx"
    ON "audit_logs" ("tenantId", "createdAt" DESC)
    WHERE "tenantId" IS NOT NULL;
