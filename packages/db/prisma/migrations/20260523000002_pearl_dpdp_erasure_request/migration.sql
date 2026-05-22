-- ================================================================
-- 20260523000002_pearl_dpdp_erasure_request
--
-- Pearl ERP Stage 1 §8.6 (gap row 224 closure, 2026-05-23):
-- "Cross-tenant DPDP request workbench" — patient/DPO-initiated
-- right-to-erasure tickets per DPDP Act 2023 §17. Super-admins on
-- /super-admin/dpdp execute the purge across all surfaces, which
-- anonymizes Patient + User and hard-deletes child rows in a
-- transaction (services/dpdp-purge.ts).
--
-- This migration is strictly additive: a new enum + a new table. No
-- existing column is altered, no constraint dropped. Safe online.
-- ================================================================

-- ── enum ──
CREATE TYPE "ErasureStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'COMPLETED', 'FAILED', 'REJECTED');

-- ── table ──
CREATE TABLE "dpdp_erasure_requests" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "requestedBy" TEXT NOT NULL,
    "requestedByRole" TEXT NOT NULL,
    "reason" TEXT,
    "status" "ErasureStatus" NOT NULL DEFAULT 'PENDING',
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "executedAt" TIMESTAMP(3),
    "executedBy" TEXT,
    "executionReceipt" JSONB,
    "failureReason" TEXT,

    CONSTRAINT "dpdp_erasure_requests_pkey" PRIMARY KEY ("id")
);

-- ── indexes ──
CREATE INDEX "dpdp_erasure_requests_tenantId_idx"
    ON "dpdp_erasure_requests"("tenantId");

CREATE INDEX "dpdp_erasure_requests_status_idx"
    ON "dpdp_erasure_requests"("status");

CREATE INDEX "dpdp_erasure_requests_requestedAt_idx"
    ON "dpdp_erasure_requests"("requestedAt");

CREATE INDEX "dpdp_erasure_requests_patientId_idx"
    ON "dpdp_erasure_requests"("patientId");

-- ── foreign keys ──
ALTER TABLE "dpdp_erasure_requests"
    ADD CONSTRAINT "dpdp_erasure_requests_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "dpdp_erasure_requests"
    ADD CONSTRAINT "dpdp_erasure_requests_patientId_fkey"
    FOREIGN KEY ("patientId") REFERENCES "patients"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
