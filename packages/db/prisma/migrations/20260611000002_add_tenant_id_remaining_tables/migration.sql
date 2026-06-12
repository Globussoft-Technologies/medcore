-- Add tenantId ownership column to the 17 tenant-ownable tables that were
-- still missing it. ADDITIVE + non-breaking:
--   * nullable "tenantId TEXT" column,
--   * FK to tenants(id) ON DELETE CASCADE (matches the other 162 scoped tables),
--   * btree index on "tenantId",
--   * data backfill so every existing row records its owning tenant.
--
-- Backfill sources:
--   * line-items / user-tied rows inherit their parent/user's tenantId,
--   * standalone catalogs (medicines, lab_tests, lab_test_reference_ranges)
--     are assigned to the default tenant (subdomain='default').
--
-- NOTE: these tables are intentionally NOT added to TENANT_SCOPED_MODELS in
-- this migration. Read/write enforcement requires the consuming routes to use
-- tenantScopedPrisma and handles edge cases (auth-time token lookups, FHIR/HL7
-- ingest on the base client, nested line-item writes, cross-tenant medicine
-- references). Those are per-table API-layer follow-ups. This migration only
-- records ownership in the schema + data.

ALTER TABLE "medicines" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "lab_tests" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "lab_test_reference_ranges" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "invoice_items" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "lab_order_items" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "prescription_items" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "purchase_order_items" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "grn_items" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "claim_documents" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "claim_status_events" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "platform_invoice_line_items" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "support_ticket_messages" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "refresh_tokens" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "password_reset_codes" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "two_factor_temp_tokens" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "notification_preferences" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "user_dashboard_preferences" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'medicines_tenantId_fkey') THEN
    ALTER TABLE "medicines" ADD CONSTRAINT "medicines_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lab_tests_tenantId_fkey') THEN
    ALTER TABLE "lab_tests" ADD CONSTRAINT "lab_tests_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lab_test_reference_ranges_tenantId_fkey') THEN
    ALTER TABLE "lab_test_reference_ranges" ADD CONSTRAINT "lab_test_reference_ranges_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invoice_items_tenantId_fkey') THEN
    ALTER TABLE "invoice_items" ADD CONSTRAINT "invoice_items_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lab_order_items_tenantId_fkey') THEN
    ALTER TABLE "lab_order_items" ADD CONSTRAINT "lab_order_items_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'prescription_items_tenantId_fkey') THEN
    ALTER TABLE "prescription_items" ADD CONSTRAINT "prescription_items_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'purchase_order_items_tenantId_fkey') THEN
    ALTER TABLE "purchase_order_items" ADD CONSTRAINT "purchase_order_items_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'grn_items_tenantId_fkey') THEN
    ALTER TABLE "grn_items" ADD CONSTRAINT "grn_items_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'claim_documents_tenantId_fkey') THEN
    ALTER TABLE "claim_documents" ADD CONSTRAINT "claim_documents_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'claim_status_events_tenantId_fkey') THEN
    ALTER TABLE "claim_status_events" ADD CONSTRAINT "claim_status_events_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'platform_invoice_line_items_tenantId_fkey') THEN
    ALTER TABLE "platform_invoice_line_items" ADD CONSTRAINT "platform_invoice_line_items_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'support_ticket_messages_tenantId_fkey') THEN
    ALTER TABLE "support_ticket_messages" ADD CONSTRAINT "support_ticket_messages_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'refresh_tokens_tenantId_fkey') THEN
    ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'password_reset_codes_tenantId_fkey') THEN
    ALTER TABLE "password_reset_codes" ADD CONSTRAINT "password_reset_codes_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'two_factor_temp_tokens_tenantId_fkey') THEN
    ALTER TABLE "two_factor_temp_tokens" ADD CONSTRAINT "two_factor_temp_tokens_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'notification_preferences_tenantId_fkey') THEN
    ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_dashboard_preferences_tenantId_fkey') THEN
    ALTER TABLE "user_dashboard_preferences" ADD CONSTRAINT "user_dashboard_preferences_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "medicines_tenantId_idx" ON "medicines"("tenantId");
CREATE INDEX IF NOT EXISTS "lab_tests_tenantId_idx" ON "lab_tests"("tenantId");
CREATE INDEX IF NOT EXISTS "lab_test_reference_ranges_tenantId_idx" ON "lab_test_reference_ranges"("tenantId");
CREATE INDEX IF NOT EXISTS "invoice_items_tenantId_idx" ON "invoice_items"("tenantId");
CREATE INDEX IF NOT EXISTS "lab_order_items_tenantId_idx" ON "lab_order_items"("tenantId");
CREATE INDEX IF NOT EXISTS "prescription_items_tenantId_idx" ON "prescription_items"("tenantId");
CREATE INDEX IF NOT EXISTS "purchase_order_items_tenantId_idx" ON "purchase_order_items"("tenantId");
CREATE INDEX IF NOT EXISTS "grn_items_tenantId_idx" ON "grn_items"("tenantId");
CREATE INDEX IF NOT EXISTS "claim_documents_tenantId_idx" ON "claim_documents"("tenantId");
CREATE INDEX IF NOT EXISTS "claim_status_events_tenantId_idx" ON "claim_status_events"("tenantId");
CREATE INDEX IF NOT EXISTS "platform_invoice_line_items_tenantId_idx" ON "platform_invoice_line_items"("tenantId");
CREATE INDEX IF NOT EXISTS "support_ticket_messages_tenantId_idx" ON "support_ticket_messages"("tenantId");
CREATE INDEX IF NOT EXISTS "refresh_tokens_tenantId_idx" ON "refresh_tokens"("tenantId");
CREATE INDEX IF NOT EXISTS "password_reset_codes_tenantId_idx" ON "password_reset_codes"("tenantId");
CREATE INDEX IF NOT EXISTS "two_factor_temp_tokens_tenantId_idx" ON "two_factor_temp_tokens"("tenantId");
CREATE INDEX IF NOT EXISTS "notification_preferences_tenantId_idx" ON "notification_preferences"("tenantId");
CREATE INDEX IF NOT EXISTS "user_dashboard_preferences_tenantId_idx" ON "user_dashboard_preferences"("tenantId");

-- ── Backfill ──────────────────────────────────────────────────────────
DO $$
DECLARE default_tenant_id TEXT;
BEGIN
  SELECT id INTO default_tenant_id FROM tenants WHERE subdomain='default' LIMIT 1;
  UPDATE "medicines" SET "tenantId" = default_tenant_id WHERE "tenantId" IS NULL;
  UPDATE "lab_tests" SET "tenantId" = default_tenant_id WHERE "tenantId" IS NULL;
  UPDATE "lab_test_reference_ranges" SET "tenantId" = default_tenant_id WHERE "tenantId" IS NULL;
  UPDATE "invoice_items" c SET "tenantId" = p."tenantId" FROM "invoices" p WHERE c."invoiceId" = p."id" AND c."tenantId" IS NULL;
  UPDATE "lab_order_items" c SET "tenantId" = p."tenantId" FROM "lab_orders" p WHERE c."orderId" = p."id" AND c."tenantId" IS NULL;
  UPDATE "prescription_items" c SET "tenantId" = p."tenantId" FROM "prescriptions" p WHERE c."prescriptionId" = p."id" AND c."tenantId" IS NULL;
  UPDATE "purchase_order_items" c SET "tenantId" = p."tenantId" FROM "purchase_orders" p WHERE c."poId" = p."id" AND c."tenantId" IS NULL;
  UPDATE "grn_items" c SET "tenantId" = p."tenantId" FROM "grns" p WHERE c."grnId" = p."id" AND c."tenantId" IS NULL;
  UPDATE "claim_documents" c SET "tenantId" = p."tenantId" FROM "insurance_claims_v2" p WHERE c."claimId" = p."id" AND c."tenantId" IS NULL;
  UPDATE "claim_status_events" c SET "tenantId" = p."tenantId" FROM "insurance_claims_v2" p WHERE c."claimId" = p."id" AND c."tenantId" IS NULL;
  UPDATE "platform_invoice_line_items" c SET "tenantId" = p."tenantId" FROM "platform_invoices" p WHERE c."invoiceId" = p."id" AND c."tenantId" IS NULL;
  UPDATE "support_ticket_messages" c SET "tenantId" = p."tenantId" FROM "support_tickets" p WHERE c."ticketId" = p."id" AND c."tenantId" IS NULL;
  UPDATE "refresh_tokens" c SET "tenantId" = p."tenantId" FROM "users" p WHERE c."userId" = p."id" AND c."tenantId" IS NULL;
  UPDATE "password_reset_codes" c SET "tenantId" = p."tenantId" FROM "users" p WHERE c."userId" = p."id" AND c."tenantId" IS NULL;
  UPDATE "two_factor_temp_tokens" c SET "tenantId" = p."tenantId" FROM "users" p WHERE c."userId" = p."id" AND c."tenantId" IS NULL;
  UPDATE "notification_preferences" c SET "tenantId" = p."tenantId" FROM "users" p WHERE c."userId" = p."id" AND c."tenantId" IS NULL;
  UPDATE "user_dashboard_preferences" c SET "tenantId" = p."tenantId" FROM "users" p WHERE c."userId" = p."id" AND c."tenantId" IS NULL;
END $$;
