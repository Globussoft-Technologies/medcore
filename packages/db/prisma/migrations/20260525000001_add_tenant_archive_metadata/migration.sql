-- ================================================================
-- 20260525000001_add_tenant_archive_metadata
--
-- Pearl ERP Stage 1 §8.1 row 233 closure (2026-05-25): 90-day S3
-- archival metadata on the Tenant model.
--
-- Adds 5 nullable columns:
--   - deactivatedAt    — stamped by `deactivateTenant()` (suspend),
--                        cleared by `activateTenant()` (restore).
--                        The sweep cron uses this + `active=false` to
--                        detect tenants suspended >=90 days.
--   - archivedAt       — stamped once the export tarball is uploaded
--                        to S3. NULL means "live tenant" (suspended or
--                        not).
--   - archiveS3Key     — S3 object key, e.g.
--                        `tenant-archives/{tenantId}/{ts}.tar.gz`
--   - archiveSizeBytes — gzipped tarball size; useful for billing /
--                        storage-budget telemetry.
--   - archiveChecksum  — SHA-256 of the tarball, kept for integrity
--                        verification before any future
--                        `purgeArchivedTenant()` call deletes the
--                        live rows.
--
-- Strictly additive — all 5 columns nullable, no existing column
-- altered. Safe online.
-- ================================================================

ALTER TABLE "tenants"
    ADD COLUMN "deactivatedAt"    TIMESTAMP(3),
    ADD COLUMN "archivedAt"       TIMESTAMP(3),
    ADD COLUMN "archiveS3Key"     TEXT,
    ADD COLUMN "archiveSizeBytes" INTEGER,
    ADD COLUMN "archiveChecksum"  TEXT;
