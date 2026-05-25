-- ================================================================
-- 20260523000003_pearl_whatsapp_inbox_schema
--
-- Pearl ERP Stage 1 §6.1 (gap row 167 — piece 3j-i of 4):
-- WhatsApp inbox schema groundwork. Adds three new tables + three
-- new enums; strictly additive — no existing column altered, no
-- existing row touched, so this is a safe online migration.
--
--   - WhatsAppProvider         (GUPSHUP / WATI / AISENSEI / INTERAKT / META)
--   - WhatsAppConversationStatus (OPEN / SNOOZED / CLOSED)
--   - MessageDirection         (INBOUND / OUTBOUND)
--   - MessageStatus            (QUEUED / SENT / DELIVERED / READ / FAILED)
--
--   - whatsapp_config          one-per-tenant provider config + encrypted creds
--   - whatsapp_conversations   one-per-(tenant, phone)
--   - whatsapp_messages        ordered bi-directional message log
--
-- Pieces 3j-ii (webhook + signature verify), 3j-iii (reception inbox UI),
-- and 3j-iv (reply endpoint via the existing notification orchestrator)
-- ship in follow-up commits. The legacy outbound adapter
-- (apps/api/src/services/channels/whatsapp.ts) is unchanged — it keeps
-- reading WHATSAPP_API_URL / WHATSAPP_API_KEY env vars until piece 3j-iv
-- flips it to per-tenant creds from this table.
-- ================================================================

-- ── enums ─────────────────────────────────────────────────────────
CREATE TYPE "WhatsAppProvider" AS ENUM (
  'GUPSHUP',
  'WATI',
  'AISENSEI',
  'INTERAKT',
  'META'
);

CREATE TYPE "WhatsAppConversationStatus" AS ENUM (
  'OPEN',
  'SNOOZED',
  'CLOSED'
);

CREATE TYPE "MessageDirection" AS ENUM (
  'INBOUND',
  'OUTBOUND'
);

CREATE TYPE "MessageStatus" AS ENUM (
  'QUEUED',
  'SENT',
  'DELIVERED',
  'READ',
  'FAILED'
);

-- ── whatsapp_config ───────────────────────────────────────────────
CREATE TABLE "whatsapp_config" (
  "id"                   TEXT PRIMARY KEY,
  "tenantId"             TEXT NOT NULL UNIQUE,
  "provider"             "WhatsAppProvider" NOT NULL DEFAULT 'GUPSHUP',
  "credentialsEncrypted" TEXT,
  "defaultProductId"     TEXT,
  "autoReply"            BOOLEAN NOT NULL DEFAULT TRUE,
  "active"               BOOLEAN NOT NULL DEFAULT TRUE,
  "createdAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"            TIMESTAMP(3) NOT NULL,
  CONSTRAINT "whatsapp_config_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE
);

-- ── whatsapp_conversations ────────────────────────────────────────
CREATE TABLE "whatsapp_conversations" (
  "id"               TEXT PRIMARY KEY,
  "tenantId"         TEXT NOT NULL,
  "patientId"        TEXT,
  "phone"            TEXT NOT NULL,
  "lastMessageAt"    TIMESTAMP(3),
  "lastInboundAt"    TIMESTAMP(3),
  "unreadCount"      INTEGER NOT NULL DEFAULT 0,
  "status"           "WhatsAppConversationStatus" NOT NULL DEFAULT 'OPEN',
  "assignedToUserId" TEXT,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL,
  CONSTRAINT "whatsapp_conversations_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE,
  CONSTRAINT "whatsapp_conversations_patientId_fkey"
    FOREIGN KEY ("patientId") REFERENCES "patients"("id") ON DELETE SET NULL
);

CREATE UNIQUE INDEX "whatsapp_conversations_tenantId_phone_key"
  ON "whatsapp_conversations" ("tenantId", "phone");

CREATE INDEX "whatsapp_conversations_tenantId_lastMessageAt_idx"
  ON "whatsapp_conversations" ("tenantId", "lastMessageAt");

-- ── whatsapp_messages ─────────────────────────────────────────────
CREATE TABLE "whatsapp_messages" (
  "id"                TEXT PRIMARY KEY,
  "conversationId"    TEXT NOT NULL,
  "tenantId"          TEXT NOT NULL,
  "direction"         "MessageDirection" NOT NULL,
  "body"              TEXT NOT NULL,
  "mediaUrl"          TEXT,
  "providerMessageId" TEXT,
  "status"            "MessageStatus" NOT NULL DEFAULT 'QUEUED',
  "sentAt"            TIMESTAMP(3),
  "deliveredAt"       TIMESTAMP(3),
  "readAt"            TIMESTAMP(3),
  "failedAt"          TIMESTAMP(3),
  "failureReason"     TEXT,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "whatsapp_messages_conversationId_fkey"
    FOREIGN KEY ("conversationId") REFERENCES "whatsapp_conversations"("id") ON DELETE CASCADE,
  CONSTRAINT "whatsapp_messages_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE
);

CREATE INDEX "whatsapp_messages_conversationId_createdAt_idx"
  ON "whatsapp_messages" ("conversationId", "createdAt");
