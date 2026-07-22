CREATE TYPE "MaterialAdjustmentRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

CREATE TABLE "material_adjustment_requests" (
  "id" TEXT NOT NULL,
  "materialId" TEXT NOT NULL,
  "departmentId" TEXT NOT NULL,
  "requestedById" TEXT NOT NULL,
  "reviewedById" TEXT,
  "delta" INTEGER NOT NULL,
  "reasonCode" TEXT NOT NULL,
  "reasonNote" TEXT,
  "status" "MaterialAdjustmentRequestStatus" NOT NULL DEFAULT 'PENDING',
  "reviewedNote" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "reviewedAt" TIMESTAMP(3),
  "tenantId" TEXT,

  CONSTRAINT "material_adjustment_requests_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "material_adjustment_requests_tenantId_idx" ON "material_adjustment_requests"("tenantId");
CREATE INDEX "material_adjustment_requests_departmentId_status_idx" ON "material_adjustment_requests"("departmentId", "status");
CREATE INDEX "material_adjustment_requests_materialId_status_idx" ON "material_adjustment_requests"("materialId", "status");
CREATE INDEX "material_adjustment_requests_requestedById_idx" ON "material_adjustment_requests"("requestedById");

ALTER TABLE "material_adjustment_requests"
ADD CONSTRAINT "material_adjustment_requests_tenantId_fkey"
FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "material_adjustment_requests"
ADD CONSTRAINT "material_adjustment_requests_materialId_fkey"
FOREIGN KEY ("materialId") REFERENCES "materials"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "material_adjustment_requests"
ADD CONSTRAINT "material_adjustment_requests_departmentId_fkey"
FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "material_adjustment_requests"
ADD CONSTRAINT "material_adjustment_requests_requestedById_fkey"
FOREIGN KEY ("requestedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "material_adjustment_requests"
ADD CONSTRAINT "material_adjustment_requests_reviewedById_fkey"
FOREIGN KEY ("reviewedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
