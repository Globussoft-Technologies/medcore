-- ABDM module completion (2026-06) — HIU records + transaction/upload tracking.
--
-- Adds three tables on top of the existing HIP-push / ABHA-link / consent
-- groundwork (abha_links, consent_artefacts, care_contexts):
--   • abdm_transactions  — one row per gateway interaction (dashboard feed).
--   • medical_records    — records fetched FROM ABDM via HIU (decrypted FHIR)
--                          + pointers to HIP-pushed local records.
--   • record_uploads     — doctor HIP upload tracking with a polled status.
--
-- All three tables are created EMPTY in this migration, so the new UNIQUE/
-- index additions carry no duplicate-collision risk. New enums are additive.
-- No existing column is dropped or altered — purely additive, zero-data-loss.
--
-- IDEMPOTENT: every CREATE is guarded (enums via DO/EXCEPTION, tables/indexes
-- via IF NOT EXISTS, FKs via NOT EXISTS lookups). A prior partial run that left
-- some objects behind (which triggered a P3009 failed-migration state on the
-- dev DB) can be `prisma migrate resolve --rolled-back`ed and re-applied
-- cleanly — re-running this file never errors on already-existing objects.

-- ─── Enums (guarded) ─────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE "AbdmTxnType" AS ENUM (
    'ABHA_VERIFY', 'ABHA_LINK', 'ABHA_DELINK', 'CONSENT_REQUEST', 'CONSENT_GRANT',
    'CONSENT_REVOKE', 'CARE_CONTEXT_LINK', 'HIP_PUSH', 'HIU_REQUEST', 'HIU_RECEIVE'
  );
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "AbdmTxnStatus" AS ENUM ('INITIATED', 'PENDING', 'SUCCESS', 'FAILED');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "MedicalRecordSource" AS ENUM ('HIP_LOCAL', 'HIU_EXTERNAL');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "RecordUploadStatus" AS ENUM ('QUEUED', 'BUNDLED', 'PUSHED', 'FAILED');
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- ─── abdm_transactions ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "abdm_transactions" (
    "id" TEXT NOT NULL,
    "type" "AbdmTxnType" NOT NULL,
    "status" "AbdmTxnStatus" NOT NULL DEFAULT 'INITIATED',
    "requestId" TEXT,
    "refId" TEXT,
    "patientId" TEXT,
    "summary" TEXT,
    "detail" JSONB,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "tenantId" TEXT,

    CONSTRAINT "abdm_transactions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "abdm_transactions_patientId_idx" ON "abdm_transactions"("patientId");
CREATE INDEX IF NOT EXISTS "abdm_transactions_type_idx" ON "abdm_transactions"("type");
CREATE INDEX IF NOT EXISTS "abdm_transactions_status_idx" ON "abdm_transactions"("status");
CREATE INDEX IF NOT EXISTS "abdm_transactions_requestId_idx" ON "abdm_transactions"("requestId");
CREATE INDEX IF NOT EXISTS "abdm_transactions_tenantId_createdAt_idx" ON "abdm_transactions"("tenantId", "createdAt" DESC);

DO $$ BEGIN
  ALTER TABLE "abdm_transactions"
    ADD CONSTRAINT "abdm_transactions_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "abdm_transactions"
    ADD CONSTRAINT "abdm_transactions_patientId_fkey"
    FOREIGN KEY ("patientId") REFERENCES "patients"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- ─── medical_records ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "medical_records" (
    "id" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "source" "MedicalRecordSource" NOT NULL DEFAULT 'HIU_EXTERNAL',
    "hiType" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "providerName" TEXT,
    "providerHipId" TEXT,
    "consentId" TEXT,
    "careContextRef" TEXT,
    "fhirBundle" JSONB,
    "fileKey" TEXT,
    "recordDate" TIMESTAMP(3),
    "fetchedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "tenantId" TEXT,

    CONSTRAINT "medical_records_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "medical_records_patientId_idx" ON "medical_records"("patientId");
CREATE INDEX IF NOT EXISTS "medical_records_source_idx" ON "medical_records"("source");
CREATE INDEX IF NOT EXISTS "medical_records_hiType_idx" ON "medical_records"("hiType");
CREATE INDEX IF NOT EXISTS "medical_records_consentId_idx" ON "medical_records"("consentId");
CREATE INDEX IF NOT EXISTS "medical_records_tenantId_idx" ON "medical_records"("tenantId");

DO $$ BEGIN
  ALTER TABLE "medical_records"
    ADD CONSTRAINT "medical_records_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "medical_records"
    ADD CONSTRAINT "medical_records_patientId_fkey"
    FOREIGN KEY ("patientId") REFERENCES "patients"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- ─── record_uploads ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "record_uploads" (
    "id" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" "RecordUploadStatus" NOT NULL DEFAULT 'QUEUED',
    "careContextRef" TEXT,
    "bundleId" TEXT,
    "fileKey" TEXT,
    "title" TEXT,
    "errorMessage" TEXT,
    "uploadedById" TEXT,
    "pushedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "tenantId" TEXT,

    CONSTRAINT "record_uploads_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "record_uploads_patientId_idx" ON "record_uploads"("patientId");
CREATE INDEX IF NOT EXISTS "record_uploads_status_idx" ON "record_uploads"("status");
CREATE INDEX IF NOT EXISTS "record_uploads_tenantId_idx" ON "record_uploads"("tenantId");

DO $$ BEGIN
  ALTER TABLE "record_uploads"
    ADD CONSTRAINT "record_uploads_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "record_uploads"
    ADD CONSTRAINT "record_uploads_patientId_fkey"
    FOREIGN KEY ("patientId") REFERENCES "patients"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "record_uploads"
    ADD CONSTRAINT "record_uploads_uploadedById_fkey"
    FOREIGN KEY ("uploadedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
