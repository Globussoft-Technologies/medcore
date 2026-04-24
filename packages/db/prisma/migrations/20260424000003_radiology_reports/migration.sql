-- Migration: Radiology Report Drafting (PRD §7.2)
-- Additive-only. Creates 2 enums + 2 tables + FKs/indexes.
-- See .prisma-models-radiology.md for deferred sub-features (DICOM parse,
-- image preview, PACS integration, prior-study comparison).

-- ── 1. Enums ─────────────────────────────────────────────────────────────
CREATE TYPE "RadiologyModality" AS ENUM (
  'XRAY', 'CT', 'MRI', 'ULTRASOUND', 'MAMMOGRAPHY', 'PET'
);

CREATE TYPE "RadiologyReportStatus" AS ENUM (
  'DRAFT', 'RADIOLOGIST_REVIEW', 'FINAL', 'AMENDED'
);

-- ── 2. radiology_studies ─────────────────────────────────────────────────
CREATE TABLE "radiology_studies" (
  "id"        TEXT NOT NULL,
  "patientId" TEXT NOT NULL,
  "orderId"   TEXT,
  "modality"  "RadiologyModality" NOT NULL,
  "bodyPart"  TEXT NOT NULL,
  "images"    JSONB NOT NULL,
  "studyDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "notes"     TEXT,
  "tenantId"  TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "radiology_studies_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "radiology_studies_patientId_idx" ON "radiology_studies"("patientId");
CREATE INDEX "radiology_studies_modality_idx" ON "radiology_studies"("modality");
CREATE INDEX "radiology_studies_studyDate_idx" ON "radiology_studies"("studyDate");
CREATE INDEX "radiology_studies_tenantId_idx" ON "radiology_studies"("tenantId");

ALTER TABLE "radiology_studies"
  ADD CONSTRAINT "radiology_studies_patientId_fkey"
  FOREIGN KEY ("patientId") REFERENCES "patients"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "radiology_studies"
  ADD CONSTRAINT "radiology_studies_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "lab_orders"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "radiology_studies"
  ADD CONSTRAINT "radiology_studies_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- ── 3. radiology_reports ─────────────────────────────────────────────────
CREATE TABLE "radiology_reports" (
  "id"              TEXT NOT NULL,
  "studyId"         TEXT NOT NULL,
  "aiDraft"         TEXT NOT NULL,
  "aiFindings"      JSONB NOT NULL,
  "aiImpression"    TEXT NOT NULL,
  "radiologistId"   TEXT,
  "finalReport"     TEXT,
  "finalImpression" TEXT,
  "status"          "RadiologyReportStatus" NOT NULL DEFAULT 'DRAFT',
  "approvedAt"      TIMESTAMP(3),
  "approvedBy"      TEXT,
  "tenantId"        TEXT,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL,
  CONSTRAINT "radiology_reports_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "radiology_reports_studyId_key" ON "radiology_reports"("studyId");
CREATE INDEX "radiology_reports_status_idx" ON "radiology_reports"("status");
CREATE INDEX "radiology_reports_radiologistId_idx" ON "radiology_reports"("radiologistId");
CREATE INDEX "radiology_reports_tenantId_idx" ON "radiology_reports"("tenantId");

ALTER TABLE "radiology_reports"
  ADD CONSTRAINT "radiology_reports_studyId_fkey"
  FOREIGN KEY ("studyId") REFERENCES "radiology_studies"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "radiology_reports"
  ADD CONSTRAINT "radiology_reports_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
