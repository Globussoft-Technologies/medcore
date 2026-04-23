-- AlterTable: add consent fields to ai_triage_sessions
ALTER TABLE "ai_triage_sessions" ADD COLUMN "consentGiven" BOOLEAN;
ALTER TABLE "ai_triage_sessions" ADD COLUMN "consentAt" TIMESTAMP(3);
