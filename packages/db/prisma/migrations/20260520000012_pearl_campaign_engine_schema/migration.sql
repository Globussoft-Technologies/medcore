-- ================================================================
-- 20260520000012_pearl_campaign_engine_schema
--
-- Closes Pearl ERP Stage 1 gap item #4 — piece 1 of 4 (PRD §5.1).
-- Pearl §5.1 demands a multi-stage Campaign engine richer than the
-- existing single-shot NotificationBroadcast: drip / trigger / cohort,
-- 4-channel fan-out, send-window clamp, A/B variants, per-recipient
-- tracking, conversion attribution. Pieces 2-4 ship the dispatcher,
-- A/B logic, and UI; this piece is the data model + CRUD foundation.
--
-- Coexists with NotificationBroadcast (NOT a replacement). Coexists
-- with ChronicCarePlan (which is the per-patient care plan; new
-- CampaignAudience is the tenant-wide DSL version).
--
-- Schema additive only. No existing tables touched.
-- ================================================================

-- ── Enums ────────────────────────────────────────────────────────
CREATE TYPE "CampaignChannel" AS ENUM ('WHATSAPP', 'SMS', 'EMAIL', 'PUSH');

CREATE TYPE "CampaignKind" AS ENUM ('BROADCAST', 'DRIP', 'TRIGGER', 'COHORT_REMINDER');

CREATE TYPE "CampaignStatus" AS ENUM ('DRAFT', 'SCHEDULED', 'RUNNING', 'PAUSED', 'COMPLETED', 'CANCELLED');

CREATE TYPE "SendStatus" AS ENUM ('QUEUED', 'SENT', 'DELIVERED', 'READ', 'BOUNCED', 'FAILED', 'SUPPRESSED');

-- ── campaign_audiences ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "campaign_audiences" (
  "id"             TEXT PRIMARY KEY,
  "tenantId"       TEXT NOT NULL,
  "name"           TEXT NOT NULL,
  "description"    TEXT,
  "rules"          JSONB NOT NULL,
  "estimatedSize"  INTEGER,
  "lastComputedAt" TIMESTAMP(3),
  "active"         BOOLEAN NOT NULL DEFAULT TRUE,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,

  CONSTRAINT "campaign_audiences_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "campaign_audiences_tenantId_idx"
  ON "campaign_audiences"("tenantId");

CREATE INDEX IF NOT EXISTS "campaign_audiences_tenantId_active_idx"
  ON "campaign_audiences"("tenantId", "active");

-- ── campaigns ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "campaigns" (
  "id"              TEXT PRIMARY KEY,
  "tenantId"        TEXT NOT NULL,
  "name"            TEXT NOT NULL,
  "description"     TEXT,
  "status"          "CampaignStatus" NOT NULL DEFAULT 'DRAFT',
  "kind"            "CampaignKind"   NOT NULL DEFAULT 'BROADCAST',
  "channels"        "CampaignChannel"[] NOT NULL DEFAULT ARRAY[]::"CampaignChannel"[],
  "templateId"      TEXT,
  "subject"         TEXT,
  "body"            TEXT,
  "audienceId"      TEXT,
  "scheduledAt"     TIMESTAMP(3),
  "startedAt"       TIMESTAMP(3),
  "completedAt"     TIMESTAMP(3),
  "cancelledAt"     TIMESTAMP(3),
  "cancelReason"    TEXT,
  "sendWindowStart" INTEGER,
  "sendWindowEnd"   INTEGER,
  "abVariants"      JSONB,
  "createdById"     TEXT,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL,

  CONSTRAINT "campaigns_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE,
  CONSTRAINT "campaigns_templateId_fkey"
    FOREIGN KEY ("templateId") REFERENCES "notification_templates"("id") ON DELETE SET NULL,
  CONSTRAINT "campaigns_audienceId_fkey"
    FOREIGN KEY ("audienceId") REFERENCES "campaign_audiences"("id") ON DELETE SET NULL,
  CONSTRAINT "campaigns_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS "campaigns_tenantId_idx"
  ON "campaigns"("tenantId");

CREATE INDEX IF NOT EXISTS "campaigns_tenantId_status_idx"
  ON "campaigns"("tenantId", "status");

CREATE INDEX IF NOT EXISTS "campaigns_scheduledAt_idx"
  ON "campaigns"("scheduledAt");

-- ── campaign_sends ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "campaign_sends" (
  "id"             TEXT PRIMARY KEY,
  "campaignId"     TEXT NOT NULL,
  "tenantId"       TEXT NOT NULL,
  "patientId"      TEXT NOT NULL,
  "channel"        "CampaignChannel" NOT NULL,
  "variantId"      TEXT,
  "status"         "SendStatus" NOT NULL DEFAULT 'QUEUED',
  "sentAt"         TIMESTAMP(3),
  "deliveredAt"    TIMESTAMP(3),
  "readAt"         TIMESTAMP(3),
  "failedAt"       TIMESTAMP(3),
  "failureReason"  TEXT,
  "notificationId" TEXT,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,

  CONSTRAINT "campaign_sends_campaignId_fkey"
    FOREIGN KEY ("campaignId") REFERENCES "campaigns"("id") ON DELETE CASCADE,
  CONSTRAINT "campaign_sends_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE,
  CONSTRAINT "campaign_sends_patientId_fkey"
    FOREIGN KEY ("patientId") REFERENCES "patients"("id") ON DELETE CASCADE,
  CONSTRAINT "campaign_sends_notificationId_fkey"
    FOREIGN KEY ("notificationId") REFERENCES "notifications"("id") ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "campaign_sends_notificationId_key"
  ON "campaign_sends"("notificationId");

CREATE INDEX IF NOT EXISTS "campaign_sends_campaignId_idx"
  ON "campaign_sends"("campaignId");

CREATE INDEX IF NOT EXISTS "campaign_sends_tenantId_idx"
  ON "campaign_sends"("tenantId");

CREATE INDEX IF NOT EXISTS "campaign_sends_campaignId_status_idx"
  ON "campaign_sends"("campaignId", "status");

CREATE INDEX IF NOT EXISTS "campaign_sends_patientId_idx"
  ON "campaign_sends"("patientId");
