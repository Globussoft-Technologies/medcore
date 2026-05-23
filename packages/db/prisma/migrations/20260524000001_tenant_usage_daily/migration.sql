-- ================================================================
-- 20260524000001_tenant_usage_daily
--
-- Pearl ERP Stage 1 §8.3 (gap row 214 closure, 2026-05-24):
-- "Per-tenant subscription (Plan + usage components)" — the Plan
-- side already shipped via `Tenant.plan`; this migration closes
-- the usage-metering half by introducing one row per tenant per
-- day with per-channel notification counts (WhatsApp / SMS /
-- Email / Push).
--
-- The daily collector (`apps/api/src/services/tenant-usage-
-- collector.ts`) runs at ~01:00 host time, groups the prior UTC
-- day's `notifications` rows by `channel` per `tenantId` (filter
-- deliveryStatus in SENT/DELIVERED/READ), and upserts one row
-- per (tenantId, date). The super-admin UI consumer (plan-vs-
-- usage dashboards, billing line items) ships as a separate
-- piece.
--
-- Idempotent: `@@unique(tenantId, date)` means the collector can
-- safely re-run for the same date without duplicating rows.
--
-- Strictly additive: one new table. No existing column altered,
-- no constraint dropped. Safe online.
-- ================================================================

CREATE TABLE "tenant_usage_daily" (
    "id"            TEXT NOT NULL,
    "tenantId"      TEXT NOT NULL,
    "date"          DATE NOT NULL,
    "whatsappCount" INTEGER NOT NULL DEFAULT 0,
    "smsCount"      INTEGER NOT NULL DEFAULT 0,
    "emailCount"    INTEGER NOT NULL DEFAULT 0,
    "pushCount"     INTEGER NOT NULL DEFAULT 0,
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"     TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenant_usage_daily_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "tenant_usage_daily_tenantId_date_key"
    ON "tenant_usage_daily" ("tenantId", "date");

CREATE INDEX "tenant_usage_daily_tenantId_date_idx"
    ON "tenant_usage_daily" ("tenantId", "date");

ALTER TABLE "tenant_usage_daily" ADD CONSTRAINT "tenant_usage_daily_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
