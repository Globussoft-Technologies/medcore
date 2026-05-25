-- ================================================================
-- 20260523000004_pearl_support_tickets
--
-- Pearl ERP Stage 1 §8.5 (gap row 223 closure, 2026-05-23):
-- "Support inbox (ticket lifecycle)" — orthogonal channel to the
-- existing patient→hospital Complaint flow. Tenant-ADMINs raise
-- support tickets against the Pearl operator (super-admin) team;
-- the operator triages, assigns, replies, and resolves via the
-- /super-admin/support UI.
--
-- Strictly additive: two new tables + two new enums. No existing
-- column is altered, no constraint dropped. Safe online.
-- ================================================================

-- ── enums ──
CREATE TYPE "SupportTicketStatus" AS ENUM (
    'OPEN',
    'AWAITING_TENANT',
    'IN_PROGRESS',
    'RESOLVED',
    'CLOSED'
);

CREATE TYPE "SupportTicketPriority" AS ENUM (
    'LOW',
    'NORMAL',
    'HIGH',
    'URGENT'
);

-- ── support_tickets table ──
CREATE TABLE "support_tickets" (
    "id"               TEXT NOT NULL,
    "tenantId"         TEXT,
    "openedByUserId"   TEXT NOT NULL,
    "subject"          TEXT NOT NULL,
    "body"             TEXT NOT NULL,
    "status"           "SupportTicketStatus" NOT NULL DEFAULT 'OPEN',
    "priority"         "SupportTicketPriority" NOT NULL DEFAULT 'NORMAL',
    "assignedToUserId" TEXT,
    "resolvedAt"       TIMESTAMP(3),
    "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"        TIMESTAMP(3) NOT NULL,

    CONSTRAINT "support_tickets_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "support_tickets_tenantId_status_idx"
    ON "support_tickets"("tenantId", "status");

CREATE INDEX "support_tickets_assignedToUserId_status_idx"
    ON "support_tickets"("assignedToUserId", "status");

CREATE INDEX "support_tickets_status_updatedAt_idx"
    ON "support_tickets"("status", "updatedAt");

ALTER TABLE "support_tickets"
    ADD CONSTRAINT "support_tickets_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "support_tickets"
    ADD CONSTRAINT "support_tickets_openedByUserId_fkey"
    FOREIGN KEY ("openedByUserId") REFERENCES "users"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "support_tickets"
    ADD CONSTRAINT "support_tickets_assignedToUserId_fkey"
    FOREIGN KEY ("assignedToUserId") REFERENCES "users"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- ── support_ticket_messages table ──
CREATE TABLE "support_ticket_messages" (
    "id"           TEXT NOT NULL,
    "ticketId"     TEXT NOT NULL,
    "authorUserId" TEXT NOT NULL,
    "body"         TEXT NOT NULL,
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "support_ticket_messages_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "support_ticket_messages_ticketId_createdAt_idx"
    ON "support_ticket_messages"("ticketId", "createdAt");

ALTER TABLE "support_ticket_messages"
    ADD CONSTRAINT "support_ticket_messages_ticketId_fkey"
    FOREIGN KEY ("ticketId") REFERENCES "support_tickets"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "support_ticket_messages"
    ADD CONSTRAINT "support_ticket_messages_authorUserId_fkey"
    FOREIGN KEY ("authorUserId") REFERENCES "users"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
