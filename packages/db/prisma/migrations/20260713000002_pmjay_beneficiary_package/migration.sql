-- PM-JAY (Ayushman Bharat) Stage B: beneficiary eligibility, HBP package master,
-- eligibility-check history, async document-upload queue, plus PM-JAY fields on
-- pre-auth + admission. All additive — no existing column is altered/dropped.

-- ─── Enums ──────────────────────────────────────────────────────────────
CREATE TYPE "PmjayEligibility" AS ENUM ('PENDING', 'ELIGIBLE', 'NOT_ELIGIBLE');
CREATE TYPE "PmjayUploadStatus" AS ENUM ('PENDING', 'UPLOADING', 'SUCCESS', 'FAILED');

-- ─── pmjay_beneficiaries ────────────────────────────────────────────────
CREATE TABLE "pmjay_beneficiaries" (
    "id" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "ayushmanCardNumber" TEXT NOT NULL,
    "beneficiaryId" TEXT,
    "familyId" TEXT,
    "eligibilityStatus" "PmjayEligibility" NOT NULL DEFAULT 'PENDING',
    "verifiedAt" TIMESTAMP(3),
    "rawResponse" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "tenantId" TEXT,
    CONSTRAINT "pmjay_beneficiaries_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "pmjay_beneficiaries_patientId_ayushmanCardNumber_key" ON "pmjay_beneficiaries"("patientId", "ayushmanCardNumber");
CREATE INDEX "pmjay_beneficiaries_patientId_idx" ON "pmjay_beneficiaries"("patientId");
CREATE INDEX "pmjay_beneficiaries_eligibilityStatus_idx" ON "pmjay_beneficiaries"("eligibilityStatus");
CREATE INDEX "pmjay_beneficiaries_tenantId_idx" ON "pmjay_beneficiaries"("tenantId");

-- ─── pmjay_verification_history ─────────────────────────────────────────
CREATE TABLE "pmjay_verification_history" (
    "id" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "ayushmanCardNumber" TEXT,
    "beneficiaryId" TEXT,
    "eligibilityStatus" "PmjayEligibility" NOT NULL,
    "checkedBy" TEXT,
    "rawResponse" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "tenantId" TEXT,
    CONSTRAINT "pmjay_verification_history_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "pmjay_verification_history_patientId_createdAt_idx" ON "pmjay_verification_history"("patientId", "createdAt");
CREATE INDEX "pmjay_verification_history_tenantId_idx" ON "pmjay_verification_history"("tenantId");

-- ─── pmjay_packages ─────────────────────────────────────────────────────
CREATE TABLE "pmjay_packages" (
    "id" TEXT NOT NULL,
    "packageCode" TEXT NOT NULL,
    "packageName" TEXT NOT NULL,
    "specialty" TEXT,
    "amount" DECIMAL(12,2) NOT NULL,
    "hospitalType" TEXT,
    "documentsRequired" JSONB,
    "packageVersion" TEXT,
    "checksum" TEXT,
    "lastSyncedAt" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "tenantId" TEXT,
    CONSTRAINT "pmjay_packages_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "pmjay_packages_tenantId_packageCode_key" ON "pmjay_packages"("tenantId", "packageCode");
CREATE INDEX "pmjay_packages_packageCode_idx" ON "pmjay_packages"("packageCode");
CREATE INDEX "pmjay_packages_specialty_idx" ON "pmjay_packages"("specialty");
CREATE INDEX "pmjay_packages_tenantId_idx" ON "pmjay_packages"("tenantId");

-- ─── pmjay_document_uploads ─────────────────────────────────────────────
CREATE TABLE "pmjay_document_uploads" (
    "id" TEXT NOT NULL,
    "claimId" TEXT NOT NULL,
    "docType" TEXT NOT NULL,
    "fileKey" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "sizeBytes" INTEGER,
    "status" "PmjayUploadStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "providerDocId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "tenantId" TEXT,
    CONSTRAINT "pmjay_document_uploads_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "pmjay_document_uploads_claimId_idx" ON "pmjay_document_uploads"("claimId");
CREATE INDEX "pmjay_document_uploads_status_idx" ON "pmjay_document_uploads"("status");
CREATE INDEX "pmjay_document_uploads_tenantId_idx" ON "pmjay_document_uploads"("tenantId");

-- ─── PM-JAY fields on existing tables ───────────────────────────────────
ALTER TABLE "preauth_requests"
    ADD COLUMN "pmjayRequestId" TEXT,
    ADD COLUMN "pmjayTransactionId" TEXT,
    ADD COLUMN "packageCode" TEXT,
    ADD COLUMN "approvalNumber" TEXT;

ALTER TABLE "admissions"
    ADD COLUMN "pmjayAdmissionId" TEXT,
    ADD COLUMN "pmjayAdmissionDate" TIMESTAMP(3),
    ADD COLUMN "hospitalTransactionId" TEXT;

-- ─── Foreign keys ───────────────────────────────────────────────────────
ALTER TABLE "pmjay_beneficiaries"
    ADD CONSTRAINT "pmjay_beneficiaries_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "pmjay_beneficiaries"
    ADD CONSTRAINT "pmjay_beneficiaries_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "pmjay_verification_history"
    ADD CONSTRAINT "pmjay_verification_history_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "pmjay_verification_history"
    ADD CONSTRAINT "pmjay_verification_history_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "pmjay_packages"
    ADD CONSTRAINT "pmjay_packages_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "pmjay_document_uploads"
    ADD CONSTRAINT "pmjay_document_uploads_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "insurance_claims_v2"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "pmjay_document_uploads"
    ADD CONSTRAINT "pmjay_document_uploads_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
