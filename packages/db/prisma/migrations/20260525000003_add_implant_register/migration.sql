-- ================================================================
-- 20260525000003_add_implant_register
--
-- Pearl ERP Stage 2 §S2.2 row 92 closure — Implant register for OT
-- module traceability. Captures every implant (orthopaedic, cardiac,
-- ophthalmic, dental, etc.) USED in a Surgery so that:
--   - Per-surgery view : surgeon/admin sees every implant attached
--                        to a case (lookup by surgeryId).
--   - Recall lookup    : when a manufacturer issues a recall, ops
--                        sweeps the register by lotNumber to find
--                        every patient who received the affected lot.
--
-- Stage-2 only — gated by the `ot` feature flag at the route layer.
-- Strictly additive: new table + indices + FKs; no existing column
-- altered.
-- ================================================================

CREATE TABLE "implants" (
    "id"           TEXT NOT NULL,
    "tenantId"     TEXT,
    "surgeryId"    TEXT NOT NULL,
    "category"     TEXT NOT NULL,
    "manufacturer" TEXT NOT NULL,
    "productName"  TEXT NOT NULL,
    "modelNumber"  TEXT,
    "lotNumber"    TEXT NOT NULL,
    "serialNumber" TEXT,
    "expiryDate"   TIMESTAMP(3),
    "implantedAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notes"        TEXT,
    "createdById"  TEXT NOT NULL,
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"    TIMESTAMP(3) NOT NULL,

    CONSTRAINT "implants_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "implants_tenantId_idx"  ON "implants"("tenantId");
CREATE INDEX "implants_surgeryId_idx" ON "implants"("surgeryId");
CREATE INDEX "implants_lotNumber_idx" ON "implants"("lotNumber");

ALTER TABLE "implants"
    ADD CONSTRAINT "implants_tenantId_fkey"
        FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "implants"
    ADD CONSTRAINT "implants_surgeryId_fkey"
        FOREIGN KEY ("surgeryId") REFERENCES "surgeries"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "implants"
    ADD CONSTRAINT "implants_createdById_fkey"
        FOREIGN KEY ("createdById") REFERENCES "users"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE;
