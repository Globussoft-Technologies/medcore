-- ================================================================
-- 20260423000005_tenant_scope_extended
--
-- Step 3 of the multi-tenant rollout (follow-up to
-- `20260423000004_tenant_foundation`).
--
-- Adds a NULLABLE `tenantId` column + index + FK (ON DELETE SET
-- NULL) to 37 additional PHI / clinical / operational tables that
-- the route-migration audit flagged as carrying per-tenant data
-- but that were not yet scoped.
--
-- Categories covered:
--   * Patient subtables (8)        — allergies, chronic conditions,
--                                    family history, immunizations,
--                                    documents, vitals, ipd vitals,
--                                    patient↔family links.
--   * Clinical (6)                 — medication administrations,
--                                    antenatal cases & visits, growth
--                                    records, med reconciliation,
--                                    pre-auth requests.
--   * AI artefacts (5)             — scribe / triage / explanation /
--                                    adherence / consent.
--   * Operational (10)             — waitlist, coordinated visits,
--                                    health packages & purchases,
--                                    payment plans & installments,
--                                    scheduled reports & runs,
--                                    feedback, complaints.
--   * HR (3)                       — staff certifications, overtime,
--                                    holidays.
--   * Infrastructure (5)           — beds, wards, chat rooms /
--                                    messages / participants.
--
-- This migration is ADDITIVE ONLY — no existing column is dropped
-- or re-typed, no existing row is rewritten. Backfill happens via
-- `scripts/backfill-default-tenant.ts` (already extended to cover
-- these tables). A later migration will flip each column to NOT
-- NULL once the backfill has run in all environments.
--
-- Deleting a tenant does NOT cascade to operational data. Rows
-- survive with `tenantId = NULL` so a recovery / merge workflow
-- can re-assign them.
-- ================================================================

-- ─── patient_allergies ───────────────────────────────────────────

ALTER TABLE "patient_allergies" ADD COLUMN "tenantId" TEXT;
CREATE INDEX "patient_allergies_tenantId_idx" ON "patient_allergies"("tenantId");
ALTER TABLE "patient_allergies"
    ADD CONSTRAINT "patient_allergies_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- ─── chronic_conditions ──────────────────────────────────────────

ALTER TABLE "chronic_conditions" ADD COLUMN "tenantId" TEXT;
CREATE INDEX "chronic_conditions_tenantId_idx" ON "chronic_conditions"("tenantId");
ALTER TABLE "chronic_conditions"
    ADD CONSTRAINT "chronic_conditions_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- ─── family_history ──────────────────────────────────────────────

ALTER TABLE "family_history" ADD COLUMN "tenantId" TEXT;
CREATE INDEX "family_history_tenantId_idx" ON "family_history"("tenantId");
ALTER TABLE "family_history"
    ADD CONSTRAINT "family_history_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- ─── immunizations ───────────────────────────────────────────────

ALTER TABLE "immunizations" ADD COLUMN "tenantId" TEXT;
CREATE INDEX "immunizations_tenantId_idx" ON "immunizations"("tenantId");
ALTER TABLE "immunizations"
    ADD CONSTRAINT "immunizations_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- ─── patient_documents ───────────────────────────────────────────

ALTER TABLE "patient_documents" ADD COLUMN "tenantId" TEXT;
CREATE INDEX "patient_documents_tenantId_idx" ON "patient_documents"("tenantId");
ALTER TABLE "patient_documents"
    ADD CONSTRAINT "patient_documents_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- ─── vitals ──────────────────────────────────────────────────────

ALTER TABLE "vitals" ADD COLUMN "tenantId" TEXT;
CREATE INDEX "vitals_tenantId_idx" ON "vitals"("tenantId");
ALTER TABLE "vitals"
    ADD CONSTRAINT "vitals_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- ─── ipd_vitals ──────────────────────────────────────────────────

ALTER TABLE "ipd_vitals" ADD COLUMN "tenantId" TEXT;
CREATE INDEX "ipd_vitals_tenantId_idx" ON "ipd_vitals"("tenantId");
ALTER TABLE "ipd_vitals"
    ADD CONSTRAINT "ipd_vitals_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- ─── patient_family_links ────────────────────────────────────────

ALTER TABLE "patient_family_links" ADD COLUMN "tenantId" TEXT;
CREATE INDEX "patient_family_links_tenantId_idx" ON "patient_family_links"("tenantId");
ALTER TABLE "patient_family_links"
    ADD CONSTRAINT "patient_family_links_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- ─── medication_administrations ──────────────────────────────────

ALTER TABLE "medication_administrations" ADD COLUMN "tenantId" TEXT;
CREATE INDEX "medication_administrations_tenantId_idx" ON "medication_administrations"("tenantId");
ALTER TABLE "medication_administrations"
    ADD CONSTRAINT "medication_administrations_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- ─── antenatal_cases ─────────────────────────────────────────────

ALTER TABLE "antenatal_cases" ADD COLUMN "tenantId" TEXT;
CREATE INDEX "antenatal_cases_tenantId_idx" ON "antenatal_cases"("tenantId");
ALTER TABLE "antenatal_cases"
    ADD CONSTRAINT "antenatal_cases_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- ─── anc_visits ──────────────────────────────────────────────────

ALTER TABLE "anc_visits" ADD COLUMN "tenantId" TEXT;
CREATE INDEX "anc_visits_tenantId_idx" ON "anc_visits"("tenantId");
ALTER TABLE "anc_visits"
    ADD CONSTRAINT "anc_visits_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- ─── growth_records ──────────────────────────────────────────────

ALTER TABLE "growth_records" ADD COLUMN "tenantId" TEXT;
CREATE INDEX "growth_records_tenantId_idx" ON "growth_records"("tenantId");
ALTER TABLE "growth_records"
    ADD CONSTRAINT "growth_records_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- ─── med_reconciliations ─────────────────────────────────────────

ALTER TABLE "med_reconciliations" ADD COLUMN "tenantId" TEXT;
CREATE INDEX "med_reconciliations_tenantId_idx" ON "med_reconciliations"("tenantId");
ALTER TABLE "med_reconciliations"
    ADD CONSTRAINT "med_reconciliations_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- ─── preauth_requests ────────────────────────────────────────────

ALTER TABLE "preauth_requests" ADD COLUMN "tenantId" TEXT;
CREATE INDEX "preauth_requests_tenantId_idx" ON "preauth_requests"("tenantId");
ALTER TABLE "preauth_requests"
    ADD CONSTRAINT "preauth_requests_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- ─── ai_scribe_sessions ──────────────────────────────────────────

ALTER TABLE "ai_scribe_sessions" ADD COLUMN "tenantId" TEXT;
CREATE INDEX "ai_scribe_sessions_tenantId_idx" ON "ai_scribe_sessions"("tenantId");
ALTER TABLE "ai_scribe_sessions"
    ADD CONSTRAINT "ai_scribe_sessions_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- ─── ai_triage_sessions ──────────────────────────────────────────

ALTER TABLE "ai_triage_sessions" ADD COLUMN "tenantId" TEXT;
CREATE INDEX "ai_triage_sessions_tenantId_idx" ON "ai_triage_sessions"("tenantId");
ALTER TABLE "ai_triage_sessions"
    ADD CONSTRAINT "ai_triage_sessions_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- ─── lab_report_explanations ─────────────────────────────────────

ALTER TABLE "lab_report_explanations" ADD COLUMN "tenantId" TEXT;
CREATE INDEX "lab_report_explanations_tenantId_idx" ON "lab_report_explanations"("tenantId");
ALTER TABLE "lab_report_explanations"
    ADD CONSTRAINT "lab_report_explanations_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- ─── adherence_schedules ─────────────────────────────────────────

ALTER TABLE "adherence_schedules" ADD COLUMN "tenantId" TEXT;
CREATE INDEX "adherence_schedules_tenantId_idx" ON "adherence_schedules"("tenantId");
ALTER TABLE "adherence_schedules"
    ADD CONSTRAINT "adherence_schedules_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- ─── consent_artefacts ───────────────────────────────────────────

ALTER TABLE "consent_artefacts" ADD COLUMN "tenantId" TEXT;
CREATE INDEX "consent_artefacts_tenantId_idx" ON "consent_artefacts"("tenantId");
ALTER TABLE "consent_artefacts"
    ADD CONSTRAINT "consent_artefacts_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- ─── waitlist_entries ────────────────────────────────────────────

ALTER TABLE "waitlist_entries" ADD COLUMN "tenantId" TEXT;
CREATE INDEX "waitlist_entries_tenantId_idx" ON "waitlist_entries"("tenantId");
ALTER TABLE "waitlist_entries"
    ADD CONSTRAINT "waitlist_entries_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- ─── coordinated_visits ──────────────────────────────────────────

ALTER TABLE "coordinated_visits" ADD COLUMN "tenantId" TEXT;
CREATE INDEX "coordinated_visits_tenantId_idx" ON "coordinated_visits"("tenantId");
ALTER TABLE "coordinated_visits"
    ADD CONSTRAINT "coordinated_visits_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- ─── health_packages ─────────────────────────────────────────────

ALTER TABLE "health_packages" ADD COLUMN "tenantId" TEXT;
CREATE INDEX "health_packages_tenantId_idx" ON "health_packages"("tenantId");
ALTER TABLE "health_packages"
    ADD CONSTRAINT "health_packages_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- ─── package_purchases ───────────────────────────────────────────

ALTER TABLE "package_purchases" ADD COLUMN "tenantId" TEXT;
CREATE INDEX "package_purchases_tenantId_idx" ON "package_purchases"("tenantId");
ALTER TABLE "package_purchases"
    ADD CONSTRAINT "package_purchases_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- ─── payment_plans ───────────────────────────────────────────────

ALTER TABLE "payment_plans" ADD COLUMN "tenantId" TEXT;
CREATE INDEX "payment_plans_tenantId_idx" ON "payment_plans"("tenantId");
ALTER TABLE "payment_plans"
    ADD CONSTRAINT "payment_plans_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- ─── payment_plan_installments ───────────────────────────────────

ALTER TABLE "payment_plan_installments" ADD COLUMN "tenantId" TEXT;
CREATE INDEX "payment_plan_installments_tenantId_idx" ON "payment_plan_installments"("tenantId");
ALTER TABLE "payment_plan_installments"
    ADD CONSTRAINT "payment_plan_installments_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- ─── scheduled_reports ───────────────────────────────────────────

ALTER TABLE "scheduled_reports" ADD COLUMN "tenantId" TEXT;
CREATE INDEX "scheduled_reports_tenantId_idx" ON "scheduled_reports"("tenantId");
ALTER TABLE "scheduled_reports"
    ADD CONSTRAINT "scheduled_reports_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- ─── report_runs ─────────────────────────────────────────────────

ALTER TABLE "report_runs" ADD COLUMN "tenantId" TEXT;
CREATE INDEX "report_runs_tenantId_idx" ON "report_runs"("tenantId");
ALTER TABLE "report_runs"
    ADD CONSTRAINT "report_runs_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- ─── patient_feedback ────────────────────────────────────────────

ALTER TABLE "patient_feedback" ADD COLUMN "tenantId" TEXT;
CREATE INDEX "patient_feedback_tenantId_idx" ON "patient_feedback"("tenantId");
ALTER TABLE "patient_feedback"
    ADD CONSTRAINT "patient_feedback_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- ─── complaints ──────────────────────────────────────────────────

ALTER TABLE "complaints" ADD COLUMN "tenantId" TEXT;
CREATE INDEX "complaints_tenantId_idx" ON "complaints"("tenantId");
ALTER TABLE "complaints"
    ADD CONSTRAINT "complaints_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- ─── staff_certifications ────────────────────────────────────────

ALTER TABLE "staff_certifications" ADD COLUMN "tenantId" TEXT;
CREATE INDEX "staff_certifications_tenantId_idx" ON "staff_certifications"("tenantId");
ALTER TABLE "staff_certifications"
    ADD CONSTRAINT "staff_certifications_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- ─── overtime_records ────────────────────────────────────────────

ALTER TABLE "overtime_records" ADD COLUMN "tenantId" TEXT;
CREATE INDEX "overtime_records_tenantId_idx" ON "overtime_records"("tenantId");
ALTER TABLE "overtime_records"
    ADD CONSTRAINT "overtime_records_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- ─── holidays ────────────────────────────────────────────────────

ALTER TABLE "holidays" ADD COLUMN "tenantId" TEXT;
CREATE INDEX "holidays_tenantId_idx" ON "holidays"("tenantId");
ALTER TABLE "holidays"
    ADD CONSTRAINT "holidays_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- ─── beds ────────────────────────────────────────────────────────

ALTER TABLE "beds" ADD COLUMN "tenantId" TEXT;
CREATE INDEX "beds_tenantId_idx" ON "beds"("tenantId");
ALTER TABLE "beds"
    ADD CONSTRAINT "beds_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- ─── wards ───────────────────────────────────────────────────────

ALTER TABLE "wards" ADD COLUMN "tenantId" TEXT;
CREATE INDEX "wards_tenantId_idx" ON "wards"("tenantId");
ALTER TABLE "wards"
    ADD CONSTRAINT "wards_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- ─── chat_rooms ──────────────────────────────────────────────────

ALTER TABLE "chat_rooms" ADD COLUMN "tenantId" TEXT;
CREATE INDEX "chat_rooms_tenantId_idx" ON "chat_rooms"("tenantId");
ALTER TABLE "chat_rooms"
    ADD CONSTRAINT "chat_rooms_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- ─── chat_messages ───────────────────────────────────────────────

ALTER TABLE "chat_messages" ADD COLUMN "tenantId" TEXT;
CREATE INDEX "chat_messages_tenantId_idx" ON "chat_messages"("tenantId");
ALTER TABLE "chat_messages"
    ADD CONSTRAINT "chat_messages_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- ─── chat_participants ───────────────────────────────────────────

ALTER TABLE "chat_participants" ADD COLUMN "tenantId" TEXT;
CREATE INDEX "chat_participants_tenantId_idx" ON "chat_participants"("tenantId");
ALTER TABLE "chat_participants"
    ADD CONSTRAINT "chat_participants_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
