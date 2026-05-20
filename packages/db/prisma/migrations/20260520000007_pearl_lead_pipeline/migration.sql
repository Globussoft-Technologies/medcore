-- ================================================================
-- 20260520000007_pearl_lead_pipeline
--
-- Closes Pearl ERP Stage 1 gap item #3 (PRD §3.3) — CRM lead pipeline.
-- Six-stage state machine (NEW → QUALIFIED → ENGAGED → BOOKED →
-- CONVERTED → LOST), multi-source intake, activity log per lead,
-- optional MarketingEnquiry → Lead promotion, optional Lead →
-- Patient conversion.
--
-- Schema additive only. No existing data is touched.
-- ================================================================

-- ── enums ──
DO $$ BEGIN
  CREATE TYPE "LeadStatus" AS ENUM ('NEW','QUALIFIED','ENGAGED','BOOKED','CONVERTED','LOST');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "LeadSource" AS ENUM ('WEB','WALK_IN','PHONE','WHATSAPP','REFERRAL','OTHER');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "LeadActivityType" AS ENUM (
    'STATUS_CHANGE','NOTE','CALL','MESSAGE','EMAIL',
    'WHATSAPP_OUTBOUND','DOCTOR_ALLOCATION','CONVERSION'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── Lead ──
CREATE TABLE IF NOT EXISTS "leads" (
  "id"                 TEXT PRIMARY KEY,
  "name"               TEXT NOT NULL,
  "phone"              TEXT,
  "email"              TEXT,
  "source"             "LeadSource" NOT NULL DEFAULT 'WEB',
  "status"             "LeadStatus" NOT NULL DEFAULT 'NEW',
  "preferredDoctorId"  TEXT,
  "assignedToUserId"   TEXT,
  "notes"              TEXT,
  "convertedAt"        TIMESTAMP(3),
  "convertedPatientId" TEXT,
  "marketingEnquiryId" TEXT,
  "tenantId"           TEXT,
  "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"          TIMESTAMP(3) NOT NULL,

  CONSTRAINT "leads_preferredDoctorId_fkey"
    FOREIGN KEY ("preferredDoctorId") REFERENCES "doctors"("id") ON DELETE SET NULL,
  CONSTRAINT "leads_assignedToUserId_fkey"
    FOREIGN KEY ("assignedToUserId") REFERENCES "users"("id") ON DELETE SET NULL,
  CONSTRAINT "leads_convertedPatientId_fkey"
    FOREIGN KEY ("convertedPatientId") REFERENCES "patients"("id") ON DELETE SET NULL,
  CONSTRAINT "leads_marketingEnquiryId_fkey"
    FOREIGN KEY ("marketingEnquiryId") REFERENCES "marketing_enquiries"("id") ON DELETE SET NULL,
  CONSTRAINT "leads_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "leads_marketingEnquiryId_key"
  ON "leads"("marketingEnquiryId");
CREATE INDEX IF NOT EXISTS "leads_tenantId_idx"           ON "leads"("tenantId");
CREATE INDEX IF NOT EXISTS "leads_status_idx"             ON "leads"("status");
CREATE INDEX IF NOT EXISTS "leads_source_idx"             ON "leads"("source");
CREATE INDEX IF NOT EXISTS "leads_assignedToUserId_idx"   ON "leads"("assignedToUserId");
CREATE INDEX IF NOT EXISTS "leads_preferredDoctorId_idx"  ON "leads"("preferredDoctorId");

-- ── LeadActivity ──
CREATE TABLE IF NOT EXISTS "lead_activities" (
  "id"           TEXT PRIMARY KEY,
  "leadId"       TEXT NOT NULL,
  "authorUserId" TEXT,
  "type"         "LeadActivityType" NOT NULL,
  "data"         JSONB,
  "body"         TEXT,
  "tenantId"     TEXT,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "lead_activities_leadId_fkey"
    FOREIGN KEY ("leadId") REFERENCES "leads"("id") ON DELETE CASCADE,
  CONSTRAINT "lead_activities_authorUserId_fkey"
    FOREIGN KEY ("authorUserId") REFERENCES "users"("id") ON DELETE SET NULL,
  CONSTRAINT "lead_activities_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "lead_activities_leadId_idx"       ON "lead_activities"("leadId");
CREATE INDEX IF NOT EXISTS "lead_activities_authorUserId_idx" ON "lead_activities"("authorUserId");
CREATE INDEX IF NOT EXISTS "lead_activities_type_idx"         ON "lead_activities"("type");
CREATE INDEX IF NOT EXISTS "lead_activities_tenantId_idx"     ON "lead_activities"("tenantId");
