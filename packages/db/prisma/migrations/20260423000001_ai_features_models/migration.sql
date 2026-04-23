-- Migration: ai_features_models
-- Adds Doctor profile fields (consultationFee, experienceYears, languages,
-- averageRating, subSpecialty, bio) and three new AI-related tables:
-- knowledge_chunks, adherence_schedules, lab_report_explanations.
--
-- This migration is ADDITIVE ONLY — no existing columns are dropped or
-- renamed. Safe to run against production data.

-- ─── AlterTable: doctors ────────────────────────────────
ALTER TABLE "doctors" ADD COLUMN "consultationFee" DECIMAL(10,2);
ALTER TABLE "doctors" ADD COLUMN "experienceYears" INTEGER;
ALTER TABLE "doctors" ADD COLUMN "languages" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "doctors" ADD COLUMN "averageRating" DECIMAL(3,2);
ALTER TABLE "doctors" ADD COLUMN "subSpecialty" TEXT;
ALTER TABLE "doctors" ADD COLUMN "bio" TEXT;

-- ─── CreateTable: knowledge_chunks ──────────────────────
CREATE TABLE "knowledge_chunks" (
    "id" TEXT NOT NULL,
    "documentType" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "sourceId" TEXT,
    "tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "language" TEXT NOT NULL DEFAULT 'en',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "knowledge_chunks_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "knowledge_chunks_documentType_idx" ON "knowledge_chunks"("documentType");
CREATE INDEX "knowledge_chunks_active_idx" ON "knowledge_chunks"("active");

-- ─── CreateTable: adherence_schedules ───────────────────
CREATE TABLE "adherence_schedules" (
    "id" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "prescriptionId" TEXT NOT NULL,
    "medications" JSONB NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "remindersSent" INTEGER NOT NULL DEFAULT 0,
    "lastReminderAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "adherence_schedules_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "adherence_schedules_prescriptionId_key" ON "adherence_schedules"("prescriptionId");
CREATE INDEX "adherence_schedules_patientId_idx" ON "adherence_schedules"("patientId");
CREATE INDEX "adherence_schedules_active_idx" ON "adherence_schedules"("active");

-- ─── CreateTable: lab_report_explanations ───────────────
CREATE TABLE "lab_report_explanations" (
    "id" TEXT NOT NULL,
    "labOrderId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "explanation" TEXT NOT NULL,
    "flaggedValues" JSONB NOT NULL DEFAULT '[]',
    "language" TEXT NOT NULL DEFAULT 'en',
    "status" TEXT NOT NULL DEFAULT 'PENDING_REVIEW',
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lab_report_explanations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "lab_report_explanations_labOrderId_key" ON "lab_report_explanations"("labOrderId");
CREATE INDEX "lab_report_explanations_patientId_idx" ON "lab_report_explanations"("patientId");
CREATE INDEX "lab_report_explanations_status_idx" ON "lab_report_explanations"("status");
