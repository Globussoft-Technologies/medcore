-- Migration: abdm_insurance_jitsi_rag_models
-- Adds ABDM linking tables (abha_links, consent_artefacts, care_contexts),
-- richer insurance-claim tables (insurance_claims_v2, claim_documents,
-- claim_status_events), new Jitsi/tele-consult fields on the existing
-- telemedicine_sessions table, and a RAG ingest-log table (ingest_logs).
--
-- This migration is ADDITIVE ONLY — no existing columns are dropped or
-- renamed. Safe to run against production data.

-- ═══════════════════════════════════════════════════════
-- ABDM: ABHA LINKS / CONSENT / CARE CONTEXTS
-- ═══════════════════════════════════════════════════════

-- ─── CreateEnum: AbhaLinkStatus ─────────────────────────
CREATE TYPE "AbhaLinkStatus" AS ENUM ('PENDING', 'VERIFIED', 'LINKED', 'REVOKED', 'FAILED');

-- ─── CreateEnum: ConsentStatus ──────────────────────────
CREATE TYPE "ConsentStatus" AS ENUM ('REQUESTED', 'GRANTED', 'DENIED', 'REVOKED', 'EXPIRED');

-- ─── CreateEnum: CareContextType ────────────────────────
CREATE TYPE "CareContextType" AS ENUM ('OPConsultation', 'DischargeSummary', 'DiagnosticReport');

-- ─── CreateTable: abha_links ────────────────────────────
CREATE TABLE "abha_links" (
    "id" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "abhaAddress" TEXT NOT NULL,
    "abhaNumber" TEXT,
    "status" "AbhaLinkStatus" NOT NULL DEFAULT 'PENDING',
    "requestId" TEXT,
    "linkedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "abha_links_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "abha_links_requestId_key" ON "abha_links"("requestId");
CREATE INDEX "abha_links_patientId_idx" ON "abha_links"("patientId");
CREATE INDEX "abha_links_abhaAddress_idx" ON "abha_links"("abhaAddress");
CREATE INDEX "abha_links_status_idx" ON "abha_links"("status");

ALTER TABLE "abha_links" ADD CONSTRAINT "abha_links_patientId_fkey"
    FOREIGN KEY ("patientId") REFERENCES "patients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── CreateTable: consent_artefacts ─────────────────────
CREATE TABLE "consent_artefacts" (
    "id" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "hiuId" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "status" "ConsentStatus" NOT NULL DEFAULT 'REQUESTED',
    "artefact" JSONB NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "grantedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "consent_artefacts_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "consent_artefacts_patientId_idx" ON "consent_artefacts"("patientId");
CREATE INDEX "consent_artefacts_status_idx" ON "consent_artefacts"("status");
CREATE INDEX "consent_artefacts_expiresAt_idx" ON "consent_artefacts"("expiresAt");

ALTER TABLE "consent_artefacts" ADD CONSTRAINT "consent_artefacts_patientId_fkey"
    FOREIGN KEY ("patientId") REFERENCES "patients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── CreateTable: care_contexts ─────────────────────────
CREATE TABLE "care_contexts" (
    "id" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "abhaAddress" TEXT NOT NULL,
    "careContextRef" TEXT NOT NULL,
    "type" "CareContextType" NOT NULL,
    "lastPushedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "care_contexts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "care_contexts_careContextRef_key" ON "care_contexts"("careContextRef");
CREATE INDEX "care_contexts_patientId_idx" ON "care_contexts"("patientId");
CREATE INDEX "care_contexts_abhaAddress_idx" ON "care_contexts"("abhaAddress");

ALTER TABLE "care_contexts" ADD CONSTRAINT "care_contexts_patientId_fkey"
    FOREIGN KEY ("patientId") REFERENCES "patients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ═══════════════════════════════════════════════════════
-- INSURANCE TPA CLAIMS (v2)
-- ═══════════════════════════════════════════════════════

-- ─── CreateEnum: TpaProvider ────────────────────────────
CREATE TYPE "TpaProvider" AS ENUM (
    'MEDI_ASSIST',
    'PARAMOUNT',
    'VIDAL',
    'FHPL',
    'ICICI_LOMBARD',
    'STAR_HEALTH',
    'MOCK'
);

-- ─── CreateEnum: NormalisedClaimStatus ──────────────────
CREATE TYPE "NormalisedClaimStatus" AS ENUM (
    'SUBMITTED',
    'IN_REVIEW',
    'QUERY_RAISED',
    'APPROVED',
    'PARTIALLY_APPROVED',
    'DENIED',
    'SETTLED',
    'CANCELLED'
);

-- ─── CreateTable: insurance_claims_v2 ───────────────────
CREATE TABLE "insurance_claims_v2" (
    "id" TEXT NOT NULL,
    "billId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "tpaProvider" "TpaProvider" NOT NULL,
    "providerClaimRef" TEXT,
    "insurerName" TEXT NOT NULL,
    "policyNumber" TEXT NOT NULL,
    "memberId" TEXT,
    "preAuthRequestId" TEXT,
    "diagnosis" TEXT NOT NULL,
    "icd10Codes" JSONB,
    "procedureName" TEXT,
    "admissionDate" DATE,
    "dischargeDate" DATE,
    "amountClaimed" DOUBLE PRECISION NOT NULL,
    "amountApproved" DOUBLE PRECISION,
    "status" "NormalisedClaimStatus" NOT NULL DEFAULT 'SUBMITTED',
    "deniedReason" TEXT,
    "notes" TEXT,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedAt" TIMESTAMP(3),
    "settledAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "lastSyncedAt" TIMESTAMP(3),
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "insurance_claims_v2_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "insurance_claims_v2_providerClaimRef_key" ON "insurance_claims_v2"("providerClaimRef");
CREATE INDEX "insurance_claims_v2_billId_idx" ON "insurance_claims_v2"("billId");
CREATE INDEX "insurance_claims_v2_patientId_idx" ON "insurance_claims_v2"("patientId");
CREATE INDEX "insurance_claims_v2_tpaProvider_status_idx" ON "insurance_claims_v2"("tpaProvider", "status");
CREATE INDEX "insurance_claims_v2_providerClaimRef_idx" ON "insurance_claims_v2"("providerClaimRef");

ALTER TABLE "insurance_claims_v2" ADD CONSTRAINT "insurance_claims_v2_billId_fkey"
    FOREIGN KEY ("billId") REFERENCES "invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "insurance_claims_v2" ADD CONSTRAINT "insurance_claims_v2_patientId_fkey"
    FOREIGN KEY ("patientId") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "insurance_claims_v2" ADD CONSTRAINT "insurance_claims_v2_preAuthRequestId_fkey"
    FOREIGN KEY ("preAuthRequestId") REFERENCES "preauth_requests"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ─── CreateTable: claim_documents ───────────────────────
CREATE TABLE "claim_documents" (
    "id" TEXT NOT NULL,
    "claimId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "fileKey" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "providerDocId" TEXT,
    "uploadedBy" TEXT NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "claim_documents_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "claim_documents_claimId_idx" ON "claim_documents"("claimId");

ALTER TABLE "claim_documents" ADD CONSTRAINT "claim_documents_claimId_fkey"
    FOREIGN KEY ("claimId") REFERENCES "insurance_claims_v2"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── CreateTable: claim_status_events ───────────────────
CREATE TABLE "claim_status_events" (
    "id" TEXT NOT NULL,
    "claimId" TEXT NOT NULL,
    "status" "NormalisedClaimStatus" NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "note" TEXT,
    "source" TEXT NOT NULL DEFAULT 'API',
    "createdBy" TEXT,

    CONSTRAINT "claim_status_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "claim_status_events_claimId_timestamp_idx" ON "claim_status_events"("claimId", "timestamp");

ALTER TABLE "claim_status_events" ADD CONSTRAINT "claim_status_events_claimId_fkey"
    FOREIGN KEY ("claimId") REFERENCES "insurance_claims_v2"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ═══════════════════════════════════════════════════════
-- JITSI TELE-CONSULT DEEP FIELDS
-- ═══════════════════════════════════════════════════════

-- ─── AlterTable: telemedicine_sessions ──────────────────
ALTER TABLE "telemedicine_sessions" ADD COLUMN "waitingRoomState" TEXT DEFAULT 'IDLE';
ALTER TABLE "telemedicine_sessions" ADD COLUMN "admittedAt" TIMESTAMP(3);
ALTER TABLE "telemedicine_sessions" ADD COLUMN "deniedAt" TIMESTAMP(3);
ALTER TABLE "telemedicine_sessions" ADD COLUMN "denyReason" TEXT;
ALTER TABLE "telemedicine_sessions" ADD COLUMN "precheckPassed" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "telemedicine_sessions" ADD COLUMN "precheckAt" TIMESTAMP(3);
ALTER TABLE "telemedicine_sessions" ADD COLUMN "precheckDetails" JSONB;
ALTER TABLE "telemedicine_sessions" ADD COLUMN "recordingStartedAt" TIMESTAMP(3);
ALTER TABLE "telemedicine_sessions" ADD COLUMN "recordingStoppedAt" TIMESTAMP(3);
ALTER TABLE "telemedicine_sessions" ADD COLUMN "jitsiRoom" TEXT;
ALTER TABLE "telemedicine_sessions" ADD COLUMN "screenShareEvents" JSONB;

-- ═══════════════════════════════════════════════════════
-- RAG INGEST LOG
-- ═══════════════════════════════════════════════════════

-- ─── CreateTable: ingest_logs ───────────────────────────
CREATE TABLE "ingest_logs" (
    "id" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "patientId" TEXT,
    "doctorId" TEXT,
    "chunkCount" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ingest_logs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ingest_logs_sourceType_sourceId_idx" ON "ingest_logs"("sourceType", "sourceId");
CREATE INDEX "ingest_logs_patientId_idx" ON "ingest_logs"("patientId");
CREATE INDEX "ingest_logs_doctorId_idx" ON "ingest_logs"("doctorId");
CREATE INDEX "ingest_logs_status_idx" ON "ingest_logs"("status");
