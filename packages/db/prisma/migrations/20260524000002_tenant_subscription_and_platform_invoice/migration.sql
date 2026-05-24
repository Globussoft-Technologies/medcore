-- ================================================================
-- 20260524000002_tenant_subscription_and_platform_invoice
--
-- Pearl ERP Stage 1 §8.3 (gap rows 215-218 closure piece 3a 2026-05-24):
-- platform-billing surface — the bills Onviqa (platform operator) sends
-- tenant hospitals for their MedCore subscription. Distinct from the
-- existing hospital → patient `Invoice` model.
--
-- This piece (3a of 3) lands schema only:
--   - `Plan` enum (STARTER / GROWTH / ENTERPRISE)
--   - `SubscriptionStatus` enum (trial / active / past_due / suspended /
--     cancelled)
--   - `tenant_subscriptions` table (one row per tenant)
--   - `platform_invoices` table (one row per tenant per month)
--   - `platform_invoice_line_items` table
--
-- Pieces 3b (monthly cron that generates invoices + emails the tenant)
-- and 3c (Razorpay Subscriptions webhook + proration logic + grace-
-- period state-machine transitions) ship in later commits.
--
-- Strictly additive: 2 new enums + 3 new tables. No existing column
-- altered, no constraint dropped. Safe online.
-- ================================================================

CREATE TYPE "Plan" AS ENUM ('STARTER', 'GROWTH', 'ENTERPRISE');

CREATE TYPE "SubscriptionStatus" AS ENUM ('trial', 'active', 'past_due', 'suspended', 'cancelled');

-- ── tenant_subscriptions ──────────────────────────────────────────
CREATE TABLE "tenant_subscriptions" (
    "id"                          TEXT NOT NULL,
    "tenantId"                    TEXT NOT NULL,
    "plan"                        "Plan" NOT NULL,
    "status"                      "SubscriptionStatus" NOT NULL DEFAULT 'trial',
    "trialEndsAt"                 TIMESTAMP(3),
    "currentPeriodStart"          TIMESTAMP(3) NOT NULL,
    "currentPeriodEnd"            TIMESTAMP(3) NOT NULL,
    "customPriceMonthlyInPaise"   INTEGER,
    "razorpaySubscriptionId"      TEXT,
    "pastDueSince"                TIMESTAMP(3),
    "cancelledAt"                 TIMESTAMP(3),
    "createdAt"                   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"                   TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenant_subscriptions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "tenant_subscriptions_tenantId_key"
    ON "tenant_subscriptions" ("tenantId");

ALTER TABLE "tenant_subscriptions" ADD CONSTRAINT "tenant_subscriptions_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants" ("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── platform_invoices ─────────────────────────────────────────────
CREATE TABLE "platform_invoices" (
    "id"                TEXT NOT NULL,
    "invoiceNumber"     TEXT NOT NULL,
    "tenantId"          TEXT NOT NULL,
    "subscriptionId"    TEXT NOT NULL,
    "periodStart"       TIMESTAMP(3) NOT NULL,
    "periodEnd"         TIMESTAMP(3) NOT NULL,
    "subtotalInPaise"   INTEGER NOT NULL,
    "cgstInPaise"       INTEGER NOT NULL DEFAULT 0,
    "sgstInPaise"       INTEGER NOT NULL DEFAULT 0,
    "igstInPaise"       INTEGER NOT NULL DEFAULT 0,
    "totalInPaise"      INTEGER NOT NULL,
    "status"            TEXT NOT NULL DEFAULT 'DRAFT',
    "issuedAt"          TIMESTAMP(3),
    "paidAt"            TIMESTAMP(3),
    "paidByUserId"      TEXT,
    "paymentReference"  TEXT,
    "hsnSacCode"        TEXT NOT NULL DEFAULT '998314',
    "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"         TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_invoices_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "platform_invoices_invoiceNumber_key"
    ON "platform_invoices" ("invoiceNumber");

CREATE INDEX "platform_invoices_tenantId_idx"
    ON "platform_invoices" ("tenantId");

CREATE INDEX "platform_invoices_subscriptionId_idx"
    ON "platform_invoices" ("subscriptionId");

CREATE INDEX "platform_invoices_status_idx"
    ON "platform_invoices" ("status");

CREATE INDEX "platform_invoices_periodStart_idx"
    ON "platform_invoices" ("periodStart");

ALTER TABLE "platform_invoices" ADD CONSTRAINT "platform_invoices_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "platform_invoices" ADD CONSTRAINT "platform_invoices_subscriptionId_fkey"
    FOREIGN KEY ("subscriptionId") REFERENCES "tenant_subscriptions" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── platform_invoice_line_items ───────────────────────────────────
CREATE TABLE "platform_invoice_line_items" (
    "id"                TEXT NOT NULL,
    "invoiceId"         TEXT NOT NULL,
    "description"       TEXT NOT NULL,
    "unitPriceInPaise"  INTEGER NOT NULL,
    "quantity"          INTEGER NOT NULL DEFAULT 1,
    "amountInPaise"     INTEGER NOT NULL,
    "hsnSacCode"        TEXT NOT NULL DEFAULT '998314',
    "cgstRate"          DOUBLE PRECISION NOT NULL DEFAULT 0,
    "sgstRate"          DOUBLE PRECISION NOT NULL DEFAULT 0,
    "igstRate"          DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_invoice_line_items_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "platform_invoice_line_items_invoiceId_idx"
    ON "platform_invoice_line_items" ("invoiceId");

ALTER TABLE "platform_invoice_line_items" ADD CONSTRAINT "platform_invoice_line_items_invoiceId_fkey"
    FOREIGN KEY ("invoiceId") REFERENCES "platform_invoices" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
