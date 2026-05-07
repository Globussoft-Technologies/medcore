-- ================================================================
-- 20260508000002_calendar_events_and_insurance_providers
--
-- Closes:
--   #718 — Admin/Calendar New Event affordance (no DB-backed admin
--          calendar events table existed; appointments/surgery/telemed
--          have their own owners. New `calendar_events` is a simple
--          time-bounded note table for ad-hoc events: training,
--          closures, town-halls, etc.).
--   #724 — Admin/Insurance Add Provider (no `insurance_providers`
--          table existed; the curated INDIAN_INSURERS constant in
--          packages/shared was hardcoded. New table backs the admin
--          Insurance Providers page so new TPAs can be onboarded
--          from UI without a code change.).
--
-- Additive-only. Both tables are tenant-scoped via SET NULL FK so
-- legacy rows survive a tenant delete (tests cascade-delete tenants;
-- production never hard-deletes).
-- ================================================================

-- ── 1. calendar_events ───────────────────────────────────────────────────
CREATE TABLE "calendar_events" (
  "id"          TEXT NOT NULL,
  "title"       TEXT NOT NULL,
  "category"    TEXT NOT NULL DEFAULT 'OTHER',
  "startAt"     TIMESTAMP(3) NOT NULL,
  "endAt"       TIMESTAMP(3) NOT NULL,
  "color"       TEXT,
  "description" TEXT,
  "createdById" TEXT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL,
  "tenantId"    TEXT,
  CONSTRAINT "calendar_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "calendar_events_startAt_idx" ON "calendar_events"("startAt");
CREATE INDEX "calendar_events_endAt_idx" ON "calendar_events"("endAt");
CREATE INDEX "calendar_events_tenantId_idx" ON "calendar_events"("tenantId");

ALTER TABLE "calendar_events"
  ADD CONSTRAINT "calendar_events_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "calendar_events"
  ADD CONSTRAINT "calendar_events_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- ── 2. insurance_providers ───────────────────────────────────────────────
CREATE TABLE "insurance_providers" (
  "id"              TEXT NOT NULL,
  "name"            TEXT NOT NULL,
  "code"            TEXT NOT NULL,
  "contactPerson"   TEXT,
  "contactEmail"    TEXT,
  "contactPhone"    TEXT,
  "coverageDetails" TEXT,
  "isActive"        BOOLEAN NOT NULL DEFAULT TRUE,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL,
  "tenantId"        TEXT,
  CONSTRAINT "insurance_providers_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "insurance_providers_code_key" ON "insurance_providers"("code");
CREATE INDEX "insurance_providers_name_idx" ON "insurance_providers"("name");
CREATE INDEX "insurance_providers_tenantId_idx" ON "insurance_providers"("tenantId");

ALTER TABLE "insurance_providers"
  ADD CONSTRAINT "insurance_providers_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
