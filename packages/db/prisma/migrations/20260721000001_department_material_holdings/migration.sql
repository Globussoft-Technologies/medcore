-- Department-held material inventory. Main inventory remains on materials.quantity;
-- this migration adds the per-department holding table plus its movement ledger
-- so issued/received stock and later adjustments stay auditable.

CREATE TABLE IF NOT EXISTS "department_material_holdings" (
    "id" TEXT NOT NULL,
    "departmentId" TEXT NOT NULL,
    "materialId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "tenantId" TEXT,
    CONSTRAINT "department_material_holdings_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "department_material_movements" (
    "id" TEXT NOT NULL,
    "departmentId" TEXT NOT NULL,
    "materialId" TEXT NOT NULL,
    "type" "StockMovementType" NOT NULL,
    "quantity" INTEGER NOT NULL,
    "referenceId" TEXT,
    "reason" TEXT,
    "performedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "tenantId" TEXT,
    CONSTRAINT "department_material_movements_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "department_material_holdings_departmentId_materialId_key"
ON "department_material_holdings"("departmentId", "materialId");

CREATE INDEX "department_material_holdings_tenantId_idx"
ON "department_material_holdings"("tenantId");

CREATE INDEX "department_material_holdings_departmentId_idx"
ON "department_material_holdings"("departmentId");

CREATE INDEX "department_material_holdings_materialId_idx"
ON "department_material_holdings"("materialId");

CREATE INDEX "department_material_movements_tenantId_idx"
ON "department_material_movements"("tenantId");

CREATE INDEX "department_material_movements_departmentId_idx"
ON "department_material_movements"("departmentId");

CREATE INDEX "department_material_movements_materialId_idx"
ON "department_material_movements"("materialId");

ALTER TABLE "department_material_holdings"
    ADD CONSTRAINT "department_material_holdings_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "department_material_holdings"
    ADD CONSTRAINT "department_material_holdings_departmentId_fkey"
    FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "department_material_holdings"
    ADD CONSTRAINT "department_material_holdings_materialId_fkey"
    FOREIGN KEY ("materialId") REFERENCES "materials"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "department_material_movements"
    ADD CONSTRAINT "department_material_movements_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "department_material_movements"
    ADD CONSTRAINT "department_material_movements_departmentId_fkey"
    FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "department_material_movements"
    ADD CONSTRAINT "department_material_movements_materialId_fkey"
    FOREIGN KEY ("materialId") REFERENCES "materials"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "department_material_movements"
    ADD CONSTRAINT "department_material_movements_performedBy_fkey"
    FOREIGN KEY ("performedBy") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
