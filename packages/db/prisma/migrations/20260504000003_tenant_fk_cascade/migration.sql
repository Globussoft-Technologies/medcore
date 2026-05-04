-- ================================================================
-- 20260504000003_tenant_fk_cascade
--
-- Issue #457 — Tenant FK onDelete: SetNull orphan PHI risk.
--
-- Flips every tenant-scoped table's `<table>_tenantId_fkey` from
-- ON DELETE SET NULL to ON DELETE CASCADE so a tenant hard-delete
-- (only ever invoked from test cleanup; production soft-deactivates
-- via Tenant.active=false) cannot leave orphan PHI rows behind that
-- the tenant-scoped Prisma client cannot see.
--
-- Idempotent: each ALTER is wrapped in a DO block that drops the
-- constraint only when present, then re-adds with CASCADE. Safe to
-- re-run and tolerant of any single table that may have been
-- removed/renamed since the original FK was created.
-- ================================================================

-- ─── abha_links ───
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE table_name = 'abha_links' AND constraint_name = 'abha_links_tenantId_fkey'
    ) THEN
        ALTER TABLE "abha_links" DROP CONSTRAINT "abha_links_tenantId_fkey";
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'abha_links'
    ) THEN
        ALTER TABLE "abha_links"
            ADD CONSTRAINT "abha_links_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- ─── adherence_dose_logs ───
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE table_name = 'adherence_dose_logs' AND constraint_name = 'adherence_dose_logs_tenantId_fkey'
    ) THEN
        ALTER TABLE "adherence_dose_logs" DROP CONSTRAINT "adherence_dose_logs_tenantId_fkey";
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'adherence_dose_logs'
    ) THEN
        ALTER TABLE "adherence_dose_logs"
            ADD CONSTRAINT "adherence_dose_logs_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- ─── adherence_schedules ───
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE table_name = 'adherence_schedules' AND constraint_name = 'adherence_schedules_tenantId_fkey'
    ) THEN
        ALTER TABLE "adherence_schedules" DROP CONSTRAINT "adherence_schedules_tenantId_fkey";
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'adherence_schedules'
    ) THEN
        ALTER TABLE "adherence_schedules"
            ADD CONSTRAINT "adherence_schedules_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- ─── admissions ───
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE table_name = 'admissions' AND constraint_name = 'admissions_tenantId_fkey'
    ) THEN
        ALTER TABLE "admissions" DROP CONSTRAINT "admissions_tenantId_fkey";
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'admissions'
    ) THEN
        ALTER TABLE "admissions"
            ADD CONSTRAINT "admissions_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- ─── advance_directives ───
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE table_name = 'advance_directives' AND constraint_name = 'advance_directives_tenantId_fkey'
    ) THEN
        ALTER TABLE "advance_directives" DROP CONSTRAINT "advance_directives_tenantId_fkey";
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'advance_directives'
    ) THEN
        ALTER TABLE "advance_directives"
            ADD CONSTRAINT "advance_directives_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- ─── advance_payments ───
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE table_name = 'advance_payments' AND constraint_name = 'advance_payments_tenantId_fkey'
    ) THEN
        ALTER TABLE "advance_payments" DROP CONSTRAINT "advance_payments_tenantId_fkey";
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'advance_payments'
    ) THEN
        ALTER TABLE "advance_payments"
            ADD CONSTRAINT "advance_payments_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- ─── ai_scribe_sessions ───
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE table_name = 'ai_scribe_sessions' AND constraint_name = 'ai_scribe_sessions_tenantId_fkey'
    ) THEN
        ALTER TABLE "ai_scribe_sessions" DROP CONSTRAINT "ai_scribe_sessions_tenantId_fkey";
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'ai_scribe_sessions'
    ) THEN
        ALTER TABLE "ai_scribe_sessions"
            ADD CONSTRAINT "ai_scribe_sessions_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- ─── ai_triage_sessions ───
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE table_name = 'ai_triage_sessions' AND constraint_name = 'ai_triage_sessions_tenantId_fkey'
    ) THEN
        ALTER TABLE "ai_triage_sessions" DROP CONSTRAINT "ai_triage_sessions_tenantId_fkey";
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'ai_triage_sessions'
    ) THEN
        ALTER TABLE "ai_triage_sessions"
            ADD CONSTRAINT "ai_triage_sessions_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- ─── ambulance_fuel_logs ───
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE table_name = 'ambulance_fuel_logs' AND constraint_name = 'ambulance_fuel_logs_tenantId_fkey'
    ) THEN
        ALTER TABLE "ambulance_fuel_logs" DROP CONSTRAINT "ambulance_fuel_logs_tenantId_fkey";
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'ambulance_fuel_logs'
    ) THEN
        ALTER TABLE "ambulance_fuel_logs"
            ADD CONSTRAINT "ambulance_fuel_logs_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- ─── ambulance_trips ───
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE table_name = 'ambulance_trips' AND constraint_name = 'ambulance_trips_tenantId_fkey'
    ) THEN
        ALTER TABLE "ambulance_trips" DROP CONSTRAINT "ambulance_trips_tenantId_fkey";
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'ambulance_trips'
    ) THEN
        ALTER TABLE "ambulance_trips"
            ADD CONSTRAINT "ambulance_trips_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- ─── ambulances ───
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE table_name = 'ambulances' AND constraint_name = 'ambulances_tenantId_fkey'
    ) THEN
        ALTER TABLE "ambulances" DROP CONSTRAINT "ambulances_tenantId_fkey";
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'ambulances'
    ) THEN
        ALTER TABLE "ambulances"
            ADD CONSTRAINT "ambulances_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- ─── anc_visits ───
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE table_name = 'anc_visits' AND constraint_name = 'anc_visits_tenantId_fkey'
    ) THEN
        ALTER TABLE "anc_visits" DROP CONSTRAINT "anc_visits_tenantId_fkey";
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'anc_visits'
    ) THEN
        ALTER TABLE "anc_visits"
            ADD CONSTRAINT "anc_visits_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- ─── anesthesia_records ───
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE table_name = 'anesthesia_records' AND constraint_name = 'anesthesia_records_tenantId_fkey'
    ) THEN
        ALTER TABLE "anesthesia_records" DROP CONSTRAINT "anesthesia_records_tenantId_fkey";
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'anesthesia_records'
    ) THEN
        ALTER TABLE "anesthesia_records"
            ADD CONSTRAINT "anesthesia_records_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- ─── antenatal_cases ───
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE table_name = 'antenatal_cases' AND constraint_name = 'antenatal_cases_tenantId_fkey'
    ) THEN
        ALTER TABLE "antenatal_cases" DROP CONSTRAINT "antenatal_cases_tenantId_fkey";
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'antenatal_cases'
    ) THEN
        ALTER TABLE "antenatal_cases"
            ADD CONSTRAINT "antenatal_cases_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- ─── appointments ───
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE table_name = 'appointments' AND constraint_name = 'appointments_tenantId_fkey'
    ) THEN
        ALTER TABLE "appointments" DROP CONSTRAINT "appointments_tenantId_fkey";
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'appointments'
    ) THEN
        ALTER TABLE "appointments"
            ADD CONSTRAINT "appointments_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- ─── asset_assignments ───
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE table_name = 'asset_assignments' AND constraint_name = 'asset_assignments_tenantId_fkey'
    ) THEN
        ALTER TABLE "asset_assignments" DROP CONSTRAINT "asset_assignments_tenantId_fkey";
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'asset_assignments'
    ) THEN
        ALTER TABLE "asset_assignments"
            ADD CONSTRAINT "asset_assignments_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- ─── asset_maintenance ───
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE table_name = 'asset_maintenance' AND constraint_name = 'asset_maintenance_tenantId_fkey'
    ) THEN
        ALTER TABLE "asset_maintenance" DROP CONSTRAINT "asset_maintenance_tenantId_fkey";
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'asset_maintenance'
    ) THEN
        ALTER TABLE "asset_maintenance"
            ADD CONSTRAINT "asset_maintenance_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- ─── asset_transfers ───
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE table_name = 'asset_transfers' AND constraint_name = 'asset_transfers_tenantId_fkey'
    ) THEN
        ALTER TABLE "asset_transfers" DROP CONSTRAINT "asset_transfers_tenantId_fkey";
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'asset_transfers'
    ) THEN
        ALTER TABLE "asset_transfers"
            ADD CONSTRAINT "asset_transfers_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- ─── assets ───
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE table_name = 'assets' AND constraint_name = 'assets_tenantId_fkey'
    ) THEN
        ALTER TABLE "assets" DROP CONSTRAINT "assets_tenantId_fkey";
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'assets'
    ) THEN
        ALTER TABLE "assets"
            ADD CONSTRAINT "assets_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- ─── audit_logs ───
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE table_name = 'audit_logs' AND constraint_name = 'audit_logs_tenantId_fkey'
    ) THEN
        ALTER TABLE "audit_logs" DROP CONSTRAINT "audit_logs_tenantId_fkey";
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'audit_logs'
    ) THEN
        ALTER TABLE "audit_logs"
            ADD CONSTRAINT "audit_logs_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- ─── beds ───
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE table_name = 'beds' AND constraint_name = 'beds_tenantId_fkey'
    ) THEN
        ALTER TABLE "beds" DROP CONSTRAINT "beds_tenantId_fkey";
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'beds'
    ) THEN
        ALTER TABLE "beds"
            ADD CONSTRAINT "beds_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- ─── bill_explanations ───
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE table_name = 'bill_explanations' AND constraint_name = 'bill_explanations_tenantId_fkey'
    ) THEN
        ALTER TABLE "bill_explanations" DROP CONSTRAINT "bill_explanations_tenantId_fkey";
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'bill_explanations'
    ) THEN
        ALTER TABLE "bill_explanations"
            ADD CONSTRAINT "bill_explanations_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- ─── blood_cross_matches ───
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE table_name = 'blood_cross_matches' AND constraint_name = 'blood_cross_matches_tenantId_fkey'
    ) THEN
        ALTER TABLE "blood_cross_matches" DROP CONSTRAINT "blood_cross_matches_tenantId_fkey";
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'blood_cross_matches'
    ) THEN
        ALTER TABLE "blood_cross_matches"
            ADD CONSTRAINT "blood_cross_matches_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- ─── blood_donations ───
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE table_name = 'blood_donations' AND constraint_name = 'blood_donations_tenantId_fkey'
    ) THEN
        ALTER TABLE "blood_donations" DROP CONSTRAINT "blood_donations_tenantId_fkey";
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'blood_donations'
    ) THEN
        ALTER TABLE "blood_donations"
            ADD CONSTRAINT "blood_donations_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- ─── blood_donors ───
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE table_name = 'blood_donors' AND constraint_name = 'blood_donors_tenantId_fkey'
    ) THEN
        ALTER TABLE "blood_donors" DROP CONSTRAINT "blood_donors_tenantId_fkey";
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'blood_donors'
    ) THEN
        ALTER TABLE "blood_donors"
            ADD CONSTRAINT "blood_donors_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- ─── blood_requests ───
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE table_name = 'blood_requests' AND constraint_name = 'blood_requests_tenantId_fkey'
    ) THEN
        ALTER TABLE "blood_requests" DROP CONSTRAINT "blood_requests_tenantId_fkey";
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'blood_requests'
    ) THEN
        ALTER TABLE "blood_requests"
            ADD CONSTRAINT "blood_requests_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- ─── blood_screenings ───
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE table_name = 'blood_screenings' AND constraint_name = 'blood_screenings_tenantId_fkey'
    ) THEN
        ALTER TABLE "blood_screenings" DROP CONSTRAINT "blood_screenings_tenantId_fkey";
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'blood_screenings'
    ) THEN
        ALTER TABLE "blood_screenings"
            ADD CONSTRAINT "blood_screenings_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- ─── blood_temperature_logs ───
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE table_name = 'blood_temperature_logs' AND constraint_name = 'blood_temperature_logs_tenantId_fkey'
    ) THEN
        ALTER TABLE "blood_temperature_logs" DROP CONSTRAINT "blood_temperature_logs_tenantId_fkey";
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'blood_temperature_logs'
    ) THEN
        ALTER TABLE "blood_temperature_logs"
            ADD CONSTRAINT "blood_temperature_logs_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- ─── blood_units ───
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE table_name = 'blood_units' AND constraint_name = 'blood_units_tenantId_fkey'
    ) THEN
        ALTER TABLE "blood_units" DROP CONSTRAINT "blood_units_tenantId_fkey";
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'blood_units'
    ) THEN
        ALTER TABLE "blood_units"
            ADD CONSTRAINT "blood_units_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- ─── care_contexts ───
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE table_name = 'care_contexts' AND constraint_name = 'care_contexts_tenantId_fkey'
    ) THEN
        ALTER TABLE "care_contexts" DROP CONSTRAINT "care_contexts_tenantId_fkey";
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'care_contexts'
    ) THEN
        ALTER TABLE "care_contexts"
            ADD CONSTRAINT "care_contexts_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- ─── chat_messages ───
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE table_name = 'chat_messages' AND constraint_name = 'chat_messages_tenantId_fkey'
    ) THEN
        ALTER TABLE "chat_messages" DROP CONSTRAINT "chat_messages_tenantId_fkey";
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'chat_messages'
    ) THEN
        ALTER TABLE "chat_messages"
            ADD CONSTRAINT "chat_messages_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- ─── chat_participants ───
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE table_name = 'chat_participants' AND constraint_name = 'chat_participants_tenantId_fkey'
    ) THEN
        ALTER TABLE "chat_participants" DROP CONSTRAINT "chat_participants_tenantId_fkey";
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'chat_participants'
    ) THEN
        ALTER TABLE "chat_participants"
            ADD CONSTRAINT "chat_participants_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- ─── chat_rooms ───
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE table_name = 'chat_rooms' AND constraint_name = 'chat_rooms_tenantId_fkey'
    ) THEN
        ALTER TABLE "chat_rooms" DROP CONSTRAINT "chat_rooms_tenantId_fkey";
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'chat_rooms'
    ) THEN
        ALTER TABLE "chat_rooms"
            ADD CONSTRAINT "chat_rooms_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- ─── chronic_care_alerts ───
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE table_name = 'chronic_care_alerts' AND constraint_name = 'chronic_care_alerts_tenantId_fkey'
    ) THEN
        ALTER TABLE "chronic_care_alerts" DROP CONSTRAINT "chronic_care_alerts_tenantId_fkey";
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'chronic_care_alerts'
    ) THEN
        ALTER TABLE "chronic_care_alerts"
            ADD CONSTRAINT "chronic_care_alerts_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- ─── chronic_care_checkins ───
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE table_name = 'chronic_care_checkins' AND constraint_name = 'chronic_care_checkins_tenantId_fkey'
    ) THEN
        ALTER TABLE "chronic_care_checkins" DROP CONSTRAINT "chronic_care_checkins_tenantId_fkey";
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'chronic_care_checkins'
    ) THEN
        ALTER TABLE "chronic_care_checkins"
            ADD CONSTRAINT "chronic_care_checkins_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- ─── chronic_care_plans ───
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE table_name = 'chronic_care_plans' AND constraint_name = 'chronic_care_plans_tenantId_fkey'
    ) THEN
        ALTER TABLE "chronic_care_plans" DROP CONSTRAINT "chronic_care_plans_tenantId_fkey";
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'chronic_care_plans'
    ) THEN
        ALTER TABLE "chronic_care_plans"
            ADD CONSTRAINT "chronic_care_plans_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- ─── chronic_conditions ───
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE table_name = 'chronic_conditions' AND constraint_name = 'chronic_conditions_tenantId_fkey'
    ) THEN
        ALTER TABLE "chronic_conditions" DROP CONSTRAINT "chronic_conditions_tenantId_fkey";
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'chronic_conditions'
    ) THEN
        ALTER TABLE "chronic_conditions"
            ADD CONSTRAINT "chronic_conditions_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- ─── claim_denial_history ───
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE table_name = 'claim_denial_history' AND constraint_name = 'claim_denial_history_tenantId_fkey'
    ) THEN
        ALTER TABLE "claim_denial_history" DROP CONSTRAINT "claim_denial_history_tenantId_fkey";
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'claim_denial_history'
    ) THEN
        ALTER TABLE "claim_denial_history"
            ADD CONSTRAINT "claim_denial_history_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- ─── complaints ───
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE table_name = 'complaints' AND constraint_name = 'complaints_tenantId_fkey'
    ) THEN
        ALTER TABLE "complaints" DROP CONSTRAINT "complaints_tenantId_fkey";
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'complaints'
    ) THEN
        ALTER TABLE "complaints"
            ADD CONSTRAINT "complaints_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- ─── component_separations ───
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE table_name = 'component_separations' AND constraint_name = 'component_separations_tenantId_fkey'
    ) THEN
        ALTER TABLE "component_separations" DROP CONSTRAINT "component_separations_tenantId_fkey";
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'component_separations'
    ) THEN
        ALTER TABLE "component_separations"
            ADD CONSTRAINT "component_separations_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- ─── consent_artefacts ───
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE table_name = 'consent_artefacts' AND constraint_name = 'consent_artefacts_tenantId_fkey'
    ) THEN
        ALTER TABLE "consent_artefacts" DROP CONSTRAINT "consent_artefacts_tenantId_fkey";
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'consent_artefacts'
    ) THEN
        ALTER TABLE "consent_artefacts"
            ADD CONSTRAINT "consent_artefacts_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- ─── consultations ───
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE table_name = 'consultations' AND constraint_name = 'consultations_tenantId_fkey'
    ) THEN
        ALTER TABLE "consultations" DROP CONSTRAINT "consultations_tenantId_fkey";
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'consultations'
    ) THEN
        ALTER TABLE "consultations"
            ADD CONSTRAINT "consultations_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- ─── controlled_substance_register ───
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE table_name = 'controlled_substance_register' AND constraint_name = 'controlled_substance_register_tenantId_fkey'
    ) THEN
        ALTER TABLE "controlled_substance_register" DROP CONSTRAINT "controlled_substance_register_tenantId_fkey";
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'controlled_substance_register'
    ) THEN
        ALTER TABLE "controlled_substance_register"
            ADD CONSTRAINT "controlled_substance_register_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- ─── coordinated_visits ───
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE table_name = 'coordinated_visits' AND constraint_name = 'coordinated_visits_tenantId_fkey'
    ) THEN
        ALTER TABLE "coordinated_visits" DROP CONSTRAINT "coordinated_visits_tenantId_fkey";
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'coordinated_visits'
    ) THEN
        ALTER TABLE "coordinated_visits"
            ADD CONSTRAINT "coordinated_visits_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- ─── credit_notes ───
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE table_name = 'credit_notes' AND constraint_name = 'credit_notes_tenantId_fkey'
    ) THEN
        ALTER TABLE "credit_notes" DROP CONSTRAINT "credit_notes_tenantId_fkey";
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'credit_notes'
    ) THEN
        ALTER TABLE "credit_notes"
            ADD CONSTRAINT "credit_notes_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- ─── discount_approvals ───
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE table_name = 'discount_approvals' AND constraint_name = 'discount_approvals_tenantId_fkey'
    ) THEN
        ALTER TABLE "discount_approvals" DROP CONSTRAINT "discount_approvals_tenantId_fkey";
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'discount_approvals'
    ) THEN
        ALTER TABLE "discount_approvals"
            ADD CONSTRAINT "discount_approvals_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- ─── doc_qa_reports ───
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE table_name = 'doc_qa_reports' AND constraint_name = 'doc_qa_reports_tenantId_fkey'
    ) THEN
        ALTER TABLE "doc_qa_reports" DROP CONSTRAINT "doc_qa_reports_tenantId_fkey";
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'doc_qa_reports'
    ) THEN
        ALTER TABLE "doc_qa_reports"
            ADD CONSTRAINT "doc_qa_reports_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- ─── doctor_schedules ───
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE table_name = 'doctor_schedules' AND constraint_name = 'doctor_schedules_tenantId_fkey'
    ) THEN
        ALTER TABLE "doctor_schedules" DROP CONSTRAINT "doctor_schedules_tenantId_fkey";
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'doctor_schedules'
    ) THEN
        ALTER TABLE "doctor_schedules"
            ADD CONSTRAINT "doctor_schedules_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- ─── doctors ───
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE table_name = 'doctors' AND constraint_name = 'doctors_tenantId_fkey'
    ) THEN
        ALTER TABLE "doctors" DROP CONSTRAINT "doctors_tenantId_fkey";
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'doctors'
    ) THEN
        ALTER TABLE "doctors"
            ADD CONSTRAINT "doctors_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- ─── donor_deferrals ───
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE table_name = 'donor_deferrals' AND constraint_name = 'donor_deferrals_tenantId_fkey'
    ) THEN
        ALTER TABLE "donor_deferrals" DROP CONSTRAINT "donor_deferrals_tenantId_fkey";
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'donor_deferrals'
    ) THEN
        ALTER TABLE "donor_deferrals"
            ADD CONSTRAINT "donor_deferrals_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- ─── emergency_cases ───
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE table_name = 'emergency_cases' AND constraint_name = 'emergency_cases_tenantId_fkey'
    ) THEN
        ALTER TABLE "emergency_cases" DROP CONSTRAINT "emergency_cases_tenantId_fkey";
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'emergency_cases'
    ) THEN
        ALTER TABLE "emergency_cases"
            ADD CONSTRAINT "emergency_cases_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- ─── expense_budgets ───
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE table_name = 'expense_budgets' AND constraint_name = 'expense_budgets_tenantId_fkey'
    ) THEN
        ALTER TABLE "expense_budgets" DROP CONSTRAINT "expense_budgets_tenantId_fkey";
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'expense_budgets'
    ) THEN
        ALTER TABLE "expense_budgets"
            ADD CONSTRAINT "expense_budgets_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- ─── expenses ───
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE table_name = 'expenses' AND constraint_name = 'expenses_tenantId_fkey'
    ) THEN
        ALTER TABLE "expenses" DROP CONSTRAINT "expenses_tenantId_fkey";
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'expenses'
    ) THEN
        ALTER TABLE "expenses"
            ADD CONSTRAINT "expenses_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- ─── family_history ───
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE table_name = 'family_history' AND constraint_name = 'family_history_tenantId_fkey'
    ) THEN
        ALTER TABLE "family_history" DROP CONSTRAINT "family_history_tenantId_fkey";
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'family_history'
    ) THEN
        ALTER TABLE "family_history"
            ADD CONSTRAINT "family_history_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- ─── feedback_sentiment ───
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE table_name = 'feedback_sentiment' AND constraint_name = 'feedback_sentiment_tenantId_fkey'
    ) THEN
        ALTER TABLE "feedback_sentiment" DROP CONSTRAINT "feedback_sentiment_tenantId_fkey";
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'feedback_sentiment'
    ) THEN
        ALTER TABLE "feedback_sentiment"
            ADD CONSTRAINT "feedback_sentiment_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- ─── feeding_logs ───
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE table_name = 'feeding_logs' AND constraint_name = 'feeding_logs_tenantId_fkey'
    ) THEN
        ALTER TABLE "feeding_logs" DROP CONSTRAINT "feeding_logs_tenantId_fkey";
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'feeding_logs'
    ) THEN
        ALTER TABLE "feeding_logs"
            ADD CONSTRAINT "feeding_logs_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- ─── fraud_alerts ───
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE table_name = 'fraud_alerts' AND constraint_name = 'fraud_alerts_tenantId_fkey'
    ) THEN
        ALTER TABLE "fraud_alerts" DROP CONSTRAINT "fraud_alerts_tenantId_fkey";
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'fraud_alerts'
    ) THEN
        ALTER TABLE "fraud_alerts"
            ADD CONSTRAINT "fraud_alerts_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- ─── front_desk_calls ───
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE table_name = 'front_desk_calls' AND constraint_name = 'front_desk_calls_tenantId_fkey'
    ) THEN
        ALTER TABLE "front_desk_calls" DROP CONSTRAINT "front_desk_calls_tenantId_fkey";
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'front_desk_calls'
    ) THEN
        ALTER TABLE "front_desk_calls"
            ADD CONSTRAINT "front_desk_calls_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- ─── grns ───
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE table_name = 'grns' AND constraint_name = 'grns_tenantId_fkey'
    ) THEN
        ALTER TABLE "grns" DROP CONSTRAINT "grns_tenantId_fkey";
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'grns'
    ) THEN
        ALTER TABLE "grns"
            ADD CONSTRAINT "grns_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- ─── growth_records ───
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE table_name = 'growth_records' AND constraint_name = 'growth_records_tenantId_fkey'
    ) THEN
        ALTER TABLE "growth_records" DROP CONSTRAINT "growth_records_tenantId_fkey";
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'growth_records'
    ) THEN
        ALTER TABLE "growth_records"
            ADD CONSTRAINT "growth_records_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- ─── health_packages ───
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE table_name = 'health_packages' AND constraint_name = 'health_packages_tenantId_fkey'
    ) THEN
        ALTER TABLE "health_packages" DROP CONSTRAINT "health_packages_tenantId_fkey";
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'health_packages'
    ) THEN
        ALTER TABLE "health_packages"
            ADD CONSTRAINT "health_packages_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- ─── holidays ───
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE table_name = 'holidays' AND constraint_name = 'holidays_tenantId_fkey'
    ) THEN
        ALTER TABLE "holidays" DROP CONSTRAINT "holidays_tenantId_fkey";
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'holidays'
    ) THEN
        ALTER TABLE "holidays"
            ADD CONSTRAINT "holidays_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- ─── immunizations ───
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE table_name = 'immunizations' AND constraint_name = 'immunizations_tenantId_fkey'
    ) THEN
        ALTER TABLE "immunizations" DROP CONSTRAINT "immunizations_tenantId_fkey";
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'immunizations'
    ) THEN
        ALTER TABLE "immunizations"
            ADD CONSTRAINT "immunizations_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- ─── insurance_claims ───
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE table_name = 'insurance_claims' AND constraint_name = 'insurance_claims_tenantId_fkey'
    ) THEN
        ALTER TABLE "insurance_claims" DROP CONSTRAINT "insurance_claims_tenantId_fkey";
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'insurance_claims'
    ) THEN
        ALTER TABLE "insurance_claims"
            ADD CONSTRAINT "insurance_claims_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- ─── insurance_claims_v2 ───
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE table_name = 'insurance_claims_v2' AND constraint_name = 'insurance_claims_v2_tenantId_fkey'
    ) THEN
        ALTER TABLE "insurance_claims_v2" DROP CONSTRAINT "insurance_claims_v2_tenantId_fkey";
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'insurance_claims_v2'
    ) THEN
        ALTER TABLE "insurance_claims_v2"
            ADD CONSTRAINT "insurance_claims_v2_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- ─── inventory_items ───
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE table_name = 'inventory_items' AND constraint_name = 'inventory_items_tenantId_fkey'
    ) THEN
        ALTER TABLE "inventory_items" DROP CONSTRAINT "inventory_items_tenantId_fkey";
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'inventory_items'
    ) THEN
        ALTER TABLE "inventory_items"
            ADD CONSTRAINT "inventory_items_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- ─── invoices ───
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE table_name = 'invoices' AND constraint_name = 'invoices_tenantId_fkey'
    ) THEN
        ALTER TABLE "invoices" DROP CONSTRAINT "invoices_tenantId_fkey";
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'invoices'
    ) THEN
        ALTER TABLE "invoices"
            ADD CONSTRAINT "invoices_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- ─── ipd_intake_output ───
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE table_name = 'ipd_intake_output' AND constraint_name = 'ipd_intake_output_tenantId_fkey'
    ) THEN
        ALTER TABLE "ipd_intake_output" DROP CONSTRAINT "ipd_intake_output_tenantId_fkey";
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'ipd_intake_output'
    ) THEN
        ALTER TABLE "ipd_intake_output"
            ADD CONSTRAINT "ipd_intake_output_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- ─── ipd_vitals ───
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE table_name = 'ipd_vitals' AND constraint_name = 'ipd_vitals_tenantId_fkey'
    ) THEN
        ALTER TABLE "ipd_vitals" DROP CONSTRAINT "ipd_vitals_tenantId_fkey";
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'ipd_vitals'
    ) THEN
        ALTER TABLE "ipd_vitals"
            ADD CONSTRAINT "ipd_vitals_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- ─── lab_orders ───
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE table_name = 'lab_orders' AND constraint_name = 'lab_orders_tenantId_fkey'
    ) THEN
        ALTER TABLE "lab_orders" DROP CONSTRAINT "lab_orders_tenantId_fkey";
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'lab_orders'
    ) THEN
        ALTER TABLE "lab_orders"
            ADD CONSTRAINT "lab_orders_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- ─── lab_qc_entries ───
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE table_name = 'lab_qc_entries' AND constraint_name = 'lab_qc_entries_tenantId_fkey'
    ) THEN
        ALTER TABLE "lab_qc_entries" DROP CONSTRAINT "lab_qc_entries_tenantId_fkey";
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'lab_qc_entries'
    ) THEN
        ALTER TABLE "lab_qc_entries"
            ADD CONSTRAINT "lab_qc_entries_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- ─── lab_report_explanations ───
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE table_name = 'lab_report_explanations' AND constraint_name = 'lab_report_explanations_tenantId_fkey'
    ) THEN
        ALTER TABLE "lab_report_explanations" DROP CONSTRAINT "lab_report_explanations_tenantId_fkey";
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'lab_report_explanations'
    ) THEN
        ALTER TABLE "lab_report_explanations"
            ADD CONSTRAINT "lab_report_explanations_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- ─── lab_results ───
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE table_name = 'lab_results' AND constraint_name = 'lab_results_tenantId_fkey'
    ) THEN
        ALTER TABLE "lab_results" DROP CONSTRAINT "lab_results_tenantId_fkey";
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'lab_results'
    ) THEN
        ALTER TABLE "lab_results"
            ADD CONSTRAINT "lab_results_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- ─── leave_balances ───
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE table_name = 'leave_balances' AND constraint_name = 'leave_balances_tenantId_fkey'
    ) THEN
        ALTER TABLE "leave_balances" DROP CONSTRAINT "leave_balances_tenantId_fkey";
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'leave_balances'
    ) THEN
        ALTER TABLE "leave_balances"
            ADD CONSTRAINT "leave_balances_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- ─── leave_requests ───
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE table_name = 'leave_requests' AND constraint_name = 'leave_requests_tenantId_fkey'
    ) THEN
        ALTER TABLE "leave_requests" DROP CONSTRAINT "leave_requests_tenantId_fkey";
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'leave_requests'
    ) THEN
        ALTER TABLE "leave_requests"
            ADD CONSTRAINT "leave_requests_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- ─── med_reconciliations ───
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE table_name = 'med_reconciliations' AND constraint_name = 'med_reconciliations_tenantId_fkey'
    ) THEN
        ALTER TABLE "med_reconciliations" DROP CONSTRAINT "med_reconciliations_tenantId_fkey";
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'med_reconciliations'
    ) THEN
        ALTER TABLE "med_reconciliations"
            ADD CONSTRAINT "med_reconciliations_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- ─── medication_administrations ───
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE table_name = 'medication_administrations' AND constraint_name = 'medication_administrations_tenantId_fkey'
    ) THEN
        ALTER TABLE "medication_administrations" DROP CONSTRAINT "medication_administrations_tenantId_fkey";
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'medication_administrations'
    ) THEN
        ALTER TABLE "medication_administrations"
            ADD CONSTRAINT "medication_administrations_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- ─── medication_incidents ───
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE table_name = 'medication_incidents' AND constraint_name = 'medication_incidents_tenantId_fkey'
    ) THEN
        ALTER TABLE "medication_incidents" DROP CONSTRAINT "medication_incidents_tenantId_fkey";
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'medication_incidents'
    ) THEN
        ALTER TABLE "medication_incidents"
            ADD CONSTRAINT "medication_incidents_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- ─── medication_orders ───
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE table_name = 'medication_orders' AND constraint_name = 'medication_orders_tenantId_fkey'
    ) THEN
        ALTER TABLE "medication_orders" DROP CONSTRAINT "medication_orders_tenantId_fkey";
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'medication_orders'
    ) THEN
        ALTER TABLE "medication_orders"
            ADD CONSTRAINT "medication_orders_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- ─── milestone_records ───
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE table_name = 'milestone_records' AND constraint_name = 'milestone_records_tenantId_fkey'
    ) THEN
        ALTER TABLE "milestone_records" DROP CONSTRAINT "milestone_records_tenantId_fkey";
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'milestone_records'
    ) THEN
        ALTER TABLE "milestone_records"
            ADD CONSTRAINT "milestone_records_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- ─── notification_broadcasts ───
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE table_name = 'notification_broadcasts' AND constraint_name = 'notification_broadcasts_tenantId_fkey'
    ) THEN
        ALTER TABLE "notification_broadcasts" DROP CONSTRAINT "notification_broadcasts_tenantId_fkey";
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'notification_broadcasts'
    ) THEN
        ALTER TABLE "notification_broadcasts"
            ADD CONSTRAINT "notification_broadcasts_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- ─── notification_schedules ───
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE table_name = 'notification_schedules' AND constraint_name = 'notification_schedules_tenantId_fkey'
    ) THEN
        ALTER TABLE "notification_schedules" DROP CONSTRAINT "notification_schedules_tenantId_fkey";
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'notification_schedules'
    ) THEN
        ALTER TABLE "notification_schedules"
            ADD CONSTRAINT "notification_schedules_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- ─── notification_templates ───
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE table_name = 'notification_templates' AND constraint_name = 'notification_templates_tenantId_fkey'
    ) THEN
        ALTER TABLE "notification_templates" DROP CONSTRAINT "notification_templates_tenantId_fkey";
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'notification_templates'
    ) THEN
        ALTER TABLE "notification_templates"
            ADD CONSTRAINT "notification_templates_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- ─── notifications ───
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE table_name = 'notifications' AND constraint_name = 'notifications_tenantId_fkey'
    ) THEN
        ALTER TABLE "notifications" DROP CONSTRAINT "notifications_tenantId_fkey";
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'notifications'
    ) THEN
        ALTER TABLE "notifications"
            ADD CONSTRAINT "notifications_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- ─── nps_daily_rollup ───
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE table_name = 'nps_daily_rollup' AND constraint_name = 'nps_daily_rollup_tenantId_fkey'
    ) THEN
        ALTER TABLE "nps_daily_rollup" DROP CONSTRAINT "nps_daily_rollup_tenantId_fkey";
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'nps_daily_rollup'
    ) THEN
        ALTER TABLE "nps_daily_rollup"
            ADD CONSTRAINT "nps_daily_rollup_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- ─── nurse_rounds ───
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE table_name = 'nurse_rounds' AND constraint_name = 'nurse_rounds_tenantId_fkey'
    ) THEN
        ALTER TABLE "nurse_rounds" DROP CONSTRAINT "nurse_rounds_tenantId_fkey";
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'nurse_rounds'
    ) THEN
        ALTER TABLE "nurse_rounds"
            ADD CONSTRAINT "nurse_rounds_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- ─── operating_theaters ───
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE table_name = 'operating_theaters' AND constraint_name = 'operating_theaters_tenantId_fkey'
    ) THEN
        ALTER TABLE "operating_theaters" DROP CONSTRAINT "operating_theaters_tenantId_fkey";
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'operating_theaters'
    ) THEN
        ALTER TABLE "operating_theaters"
            ADD CONSTRAINT "operating_theaters_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- ─── overtime_records ───
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE table_name = 'overtime_records' AND constraint_name = 'overtime_records_tenantId_fkey'
    ) THEN
        ALTER TABLE "overtime_records" DROP CONSTRAINT "overtime_records_tenantId_fkey";
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'overtime_records'
    ) THEN
        ALTER TABLE "overtime_records"
            ADD CONSTRAINT "overtime_records_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- ─── package_purchases ───
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE table_name = 'package_purchases' AND constraint_name = 'package_purchases_tenantId_fkey'
    ) THEN
        ALTER TABLE "package_purchases" DROP CONSTRAINT "package_purchases_tenantId_fkey";
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'package_purchases'
    ) THEN
        ALTER TABLE "package_purchases"
            ADD CONSTRAINT "package_purchases_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- ─── partographs ───
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE table_name = 'partographs' AND constraint_name = 'partographs_tenantId_fkey'
    ) THEN
        ALTER TABLE "partographs" DROP CONSTRAINT "partographs_tenantId_fkey";
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'partographs'
    ) THEN
        ALTER TABLE "partographs"
            ADD CONSTRAINT "partographs_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- ─── patient_allergies ───
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE table_name = 'patient_allergies' AND constraint_name = 'patient_allergies_tenantId_fkey'
    ) THEN
        ALTER TABLE "patient_allergies" DROP CONSTRAINT "patient_allergies_tenantId_fkey";
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'patient_allergies'
    ) THEN
        ALTER TABLE "patient_allergies"
            ADD CONSTRAINT "patient_allergies_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- ─── patient_belongings ───
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE table_name = 'patient_belongings' AND constraint_name = 'patient_belongings_tenantId_fkey'
    ) THEN
        ALTER TABLE "patient_belongings" DROP CONSTRAINT "patient_belongings_tenantId_fkey";
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'patient_belongings'
    ) THEN
        ALTER TABLE "patient_belongings"
            ADD CONSTRAINT "patient_belongings_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- ─── patient_data_exports ───
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE table_name = 'patient_data_exports' AND constraint_name = 'patient_data_exports_tenantId_fkey'
    ) THEN
        ALTER TABLE "patient_data_exports" DROP CONSTRAINT "patient_data_exports_tenantId_fkey";
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'patient_data_exports'
    ) THEN
        ALTER TABLE "patient_data_exports"
            ADD CONSTRAINT "patient_data_exports_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- ─── patient_documents ───
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE table_name = 'patient_documents' AND constraint_name = 'patient_documents_tenantId_fkey'
    ) THEN
        ALTER TABLE "patient_documents" DROP CONSTRAINT "patient_documents_tenantId_fkey";
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'patient_documents'
    ) THEN
        ALTER TABLE "patient_documents"
            ADD CONSTRAINT "patient_documents_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- ─── patient_family_links ───
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE table_name = 'patient_family_links' AND constraint_name = 'patient_family_links_tenantId_fkey'
    ) THEN
        ALTER TABLE "patient_family_links" DROP CONSTRAINT "patient_family_links_tenantId_fkey";
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'patient_family_links'
    ) THEN
        ALTER TABLE "patient_family_links"
            ADD CONSTRAINT "patient_family_links_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- ─── patient_feedback ───
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE table_name = 'patient_feedback' AND constraint_name = 'patient_feedback_tenantId_fkey'
    ) THEN
        ALTER TABLE "patient_feedback" DROP CONSTRAINT "patient_feedback_tenantId_fkey";
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'patient_feedback'
    ) THEN
        ALTER TABLE "patient_feedback"
            ADD CONSTRAINT "patient_feedback_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- ─── patients ───
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE table_name = 'patients' AND constraint_name = 'patients_tenantId_fkey'
    ) THEN
        ALTER TABLE "patients" DROP CONSTRAINT "patients_tenantId_fkey";
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'patients'
    ) THEN
        ALTER TABLE "patients"
            ADD CONSTRAINT "patients_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- ─── payment_plan_installments ───
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE table_name = 'payment_plan_installments' AND constraint_name = 'payment_plan_installments_tenantId_fkey'
    ) THEN
        ALTER TABLE "payment_plan_installments" DROP CONSTRAINT "payment_plan_installments_tenantId_fkey";
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'payment_plan_installments'
    ) THEN
        ALTER TABLE "payment_plan_installments"
            ADD CONSTRAINT "payment_plan_installments_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- ─── payment_plans ───
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE table_name = 'payment_plans' AND constraint_name = 'payment_plans_tenantId_fkey'
    ) THEN
        ALTER TABLE "payment_plans" DROP CONSTRAINT "payment_plans_tenantId_fkey";
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'payment_plans'
    ) THEN
        ALTER TABLE "payment_plans"
            ADD CONSTRAINT "payment_plans_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- ─── payments ───
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE table_name = 'payments' AND constraint_name = 'payments_tenantId_fkey'
    ) THEN
        ALTER TABLE "payments" DROP CONSTRAINT "payments_tenantId_fkey";
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'payments'
    ) THEN
        ALTER TABLE "payments"
            ADD CONSTRAINT "payments_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- ─── pharmacy_returns ───
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE table_name = 'pharmacy_returns' AND constraint_name = 'pharmacy_returns_tenantId_fkey'
    ) THEN
        ALTER TABLE "pharmacy_returns" DROP CONSTRAINT "pharmacy_returns_tenantId_fkey";
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'pharmacy_returns'
    ) THEN
        ALTER TABLE "pharmacy_returns"
            ADD CONSTRAINT "pharmacy_returns_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- ─── post_op_observations ───
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE table_name = 'post_op_observations' AND constraint_name = 'post_op_observations_tenantId_fkey'
    ) THEN
        ALTER TABLE "post_op_observations" DROP CONSTRAINT "post_op_observations_tenantId_fkey";
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'post_op_observations'
    ) THEN
        ALTER TABLE "post_op_observations"
            ADD CONSTRAINT "post_op_observations_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- ─── postnatal_visits ───
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE table_name = 'postnatal_visits' AND constraint_name = 'postnatal_visits_tenantId_fkey'
    ) THEN
        ALTER TABLE "postnatal_visits" DROP CONSTRAINT "postnatal_visits_tenantId_fkey";
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'postnatal_visits'
    ) THEN
        ALTER TABLE "postnatal_visits"
            ADD CONSTRAINT "postnatal_visits_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- ─── preauth_requests ───
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE table_name = 'preauth_requests' AND constraint_name = 'preauth_requests_tenantId_fkey'
    ) THEN
        ALTER TABLE "preauth_requests" DROP CONSTRAINT "preauth_requests_tenantId_fkey";
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'preauth_requests'
    ) THEN
        ALTER TABLE "preauth_requests"
            ADD CONSTRAINT "preauth_requests_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- ─── prescription_templates ───
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE table_name = 'prescription_templates' AND constraint_name = 'prescription_templates_tenantId_fkey'
    ) THEN
        ALTER TABLE "prescription_templates" DROP CONSTRAINT "prescription_templates_tenantId_fkey";
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'prescription_templates'
    ) THEN
        ALTER TABLE "prescription_templates"
            ADD CONSTRAINT "prescription_templates_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- ─── prescriptions ───
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE table_name = 'prescriptions' AND constraint_name = 'prescriptions_tenantId_fkey'
    ) THEN
        ALTER TABLE "prescriptions" DROP CONSTRAINT "prescriptions_tenantId_fkey";
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'prescriptions'
    ) THEN
        ALTER TABLE "prescriptions"
            ADD CONSTRAINT "prescriptions_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- ─── previsit_checklists ───
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE table_name = 'previsit_checklists' AND constraint_name = 'previsit_checklists_tenantId_fkey'
    ) THEN
        ALTER TABLE "previsit_checklists" DROP CONSTRAINT "previsit_checklists_tenantId_fkey";
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'previsit_checklists'
    ) THEN
        ALTER TABLE "previsit_checklists"
            ADD CONSTRAINT "previsit_checklists_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- ─── purchase_orders ───
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE table_name = 'purchase_orders' AND constraint_name = 'purchase_orders_tenantId_fkey'
    ) THEN
        ALTER TABLE "purchase_orders" DROP CONSTRAINT "purchase_orders_tenantId_fkey";
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'purchase_orders'
    ) THEN
        ALTER TABLE "purchase_orders"
            ADD CONSTRAINT "purchase_orders_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- ─── radiology_reports ───
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE table_name = 'radiology_reports' AND constraint_name = 'radiology_reports_tenantId_fkey'
    ) THEN
        ALTER TABLE "radiology_reports" DROP CONSTRAINT "radiology_reports_tenantId_fkey";
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'radiology_reports'
    ) THEN
        ALTER TABLE "radiology_reports"
            ADD CONSTRAINT "radiology_reports_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- ─── radiology_studies ───
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE table_name = 'radiology_studies' AND constraint_name = 'radiology_studies_tenantId_fkey'
    ) THEN
        ALTER TABLE "radiology_studies" DROP CONSTRAINT "radiology_studies_tenantId_fkey";
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'radiology_studies'
    ) THEN
        ALTER TABLE "radiology_studies"
            ADD CONSTRAINT "radiology_studies_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- ─── referrals ───
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE table_name = 'referrals' AND constraint_name = 'referrals_tenantId_fkey'
    ) THEN
        ALTER TABLE "referrals" DROP CONSTRAINT "referrals_tenantId_fkey";
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'referrals'
    ) THEN
        ALTER TABLE "referrals"
            ADD CONSTRAINT "referrals_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- ─── report_runs ───
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE table_name = 'report_runs' AND constraint_name = 'report_runs_tenantId_fkey'
    ) THEN
        ALTER TABLE "report_runs" DROP CONSTRAINT "report_runs_tenantId_fkey";
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'report_runs'
    ) THEN
        ALTER TABLE "report_runs"
            ADD CONSTRAINT "report_runs_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- ─── schedule_overrides ───
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE table_name = 'schedule_overrides' AND constraint_name = 'schedule_overrides_tenantId_fkey'
    ) THEN
        ALTER TABLE "schedule_overrides" DROP CONSTRAINT "schedule_overrides_tenantId_fkey";
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'schedule_overrides'
    ) THEN
        ALTER TABLE "schedule_overrides"
            ADD CONSTRAINT "schedule_overrides_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- ─── scheduled_reports ───
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE table_name = 'scheduled_reports' AND constraint_name = 'scheduled_reports_tenantId_fkey'
    ) THEN
        ALTER TABLE "scheduled_reports" DROP CONSTRAINT "scheduled_reports_tenantId_fkey";
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'scheduled_reports'
    ) THEN
        ALTER TABLE "scheduled_reports"
            ADD CONSTRAINT "scheduled_reports_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- ─── shared_links ───
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE table_name = 'shared_links' AND constraint_name = 'shared_links_tenantId_fkey'
    ) THEN
        ALTER TABLE "shared_links" DROP CONSTRAINT "shared_links_tenantId_fkey";
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'shared_links'
    ) THEN
        ALTER TABLE "shared_links"
            ADD CONSTRAINT "shared_links_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- ─── staff_certifications ───
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE table_name = 'staff_certifications' AND constraint_name = 'staff_certifications_tenantId_fkey'
    ) THEN
        ALTER TABLE "staff_certifications" DROP CONSTRAINT "staff_certifications_tenantId_fkey";
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'staff_certifications'
    ) THEN
        ALTER TABLE "staff_certifications"
            ADD CONSTRAINT "staff_certifications_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- ─── staff_roster_proposals ───
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE table_name = 'staff_roster_proposals' AND constraint_name = 'staff_roster_proposals_tenantId_fkey'
    ) THEN
        ALTER TABLE "staff_roster_proposals" DROP CONSTRAINT "staff_roster_proposals_tenantId_fkey";
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'staff_roster_proposals'
    ) THEN
        ALTER TABLE "staff_roster_proposals"
            ADD CONSTRAINT "staff_roster_proposals_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- ─── staff_shifts ───
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE table_name = 'staff_shifts' AND constraint_name = 'staff_shifts_tenantId_fkey'
    ) THEN
        ALTER TABLE "staff_shifts" DROP CONSTRAINT "staff_shifts_tenantId_fkey";
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'staff_shifts'
    ) THEN
        ALTER TABLE "staff_shifts"
            ADD CONSTRAINT "staff_shifts_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- ─── stock_movements ───
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE table_name = 'stock_movements' AND constraint_name = 'stock_movements_tenantId_fkey'
    ) THEN
        ALTER TABLE "stock_movements" DROP CONSTRAINT "stock_movements_tenantId_fkey";
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'stock_movements'
    ) THEN
        ALTER TABLE "stock_movements"
            ADD CONSTRAINT "stock_movements_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- ─── stock_transfers ───
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE table_name = 'stock_transfers' AND constraint_name = 'stock_transfers_tenantId_fkey'
    ) THEN
        ALTER TABLE "stock_transfers" DROP CONSTRAINT "stock_transfers_tenantId_fkey";
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'stock_transfers'
    ) THEN
        ALTER TABLE "stock_transfers"
            ADD CONSTRAINT "stock_transfers_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- ─── supplier_catalog_items ───
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE table_name = 'supplier_catalog_items' AND constraint_name = 'supplier_catalog_items_tenantId_fkey'
    ) THEN
        ALTER TABLE "supplier_catalog_items" DROP CONSTRAINT "supplier_catalog_items_tenantId_fkey";
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'supplier_catalog_items'
    ) THEN
        ALTER TABLE "supplier_catalog_items"
            ADD CONSTRAINT "supplier_catalog_items_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- ─── supplier_payments ───
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE table_name = 'supplier_payments' AND constraint_name = 'supplier_payments_tenantId_fkey'
    ) THEN
        ALTER TABLE "supplier_payments" DROP CONSTRAINT "supplier_payments_tenantId_fkey";
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'supplier_payments'
    ) THEN
        ALTER TABLE "supplier_payments"
            ADD CONSTRAINT "supplier_payments_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- ─── suppliers ───
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE table_name = 'suppliers' AND constraint_name = 'suppliers_tenantId_fkey'
    ) THEN
        ALTER TABLE "suppliers" DROP CONSTRAINT "suppliers_tenantId_fkey";
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'suppliers'
    ) THEN
        ALTER TABLE "suppliers"
            ADD CONSTRAINT "suppliers_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- ─── surgeries ───
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE table_name = 'surgeries' AND constraint_name = 'surgeries_tenantId_fkey'
    ) THEN
        ALTER TABLE "surgeries" DROP CONSTRAINT "surgeries_tenantId_fkey";
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'surgeries'
    ) THEN
        ALTER TABLE "surgeries"
            ADD CONSTRAINT "surgeries_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- ─── symptom_diary_entries ───
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE table_name = 'symptom_diary_entries' AND constraint_name = 'symptom_diary_entries_tenantId_fkey'
    ) THEN
        ALTER TABLE "symptom_diary_entries" DROP CONSTRAINT "symptom_diary_entries_tenantId_fkey";
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'symptom_diary_entries'
    ) THEN
        ALTER TABLE "symptom_diary_entries"
            ADD CONSTRAINT "symptom_diary_entries_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- ─── telemedicine_sessions ───
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE table_name = 'telemedicine_sessions' AND constraint_name = 'telemedicine_sessions_tenantId_fkey'
    ) THEN
        ALTER TABLE "telemedicine_sessions" DROP CONSTRAINT "telemedicine_sessions_tenantId_fkey";
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'telemedicine_sessions'
    ) THEN
        ALTER TABLE "telemedicine_sessions"
            ADD CONSTRAINT "telemedicine_sessions_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- ─── ultrasound_records ───
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE table_name = 'ultrasound_records' AND constraint_name = 'ultrasound_records_tenantId_fkey'
    ) THEN
        ALTER TABLE "ultrasound_records" DROP CONSTRAINT "ultrasound_records_tenantId_fkey";
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'ultrasound_records'
    ) THEN
        ALTER TABLE "ultrasound_records"
            ADD CONSTRAINT "ultrasound_records_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- ─── users ───
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE table_name = 'users' AND constraint_name = 'users_tenantId_fkey'
    ) THEN
        ALTER TABLE "users" DROP CONSTRAINT "users_tenantId_fkey";
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'users'
    ) THEN
        ALTER TABLE "users"
            ADD CONSTRAINT "users_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- ─── visitor_blacklist ───
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE table_name = 'visitor_blacklist' AND constraint_name = 'visitor_blacklist_tenantId_fkey'
    ) THEN
        ALTER TABLE "visitor_blacklist" DROP CONSTRAINT "visitor_blacklist_tenantId_fkey";
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'visitor_blacklist'
    ) THEN
        ALTER TABLE "visitor_blacklist"
            ADD CONSTRAINT "visitor_blacklist_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- ─── visitors ───
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE table_name = 'visitors' AND constraint_name = 'visitors_tenantId_fkey'
    ) THEN
        ALTER TABLE "visitors" DROP CONSTRAINT "visitors_tenantId_fkey";
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'visitors'
    ) THEN
        ALTER TABLE "visitors"
            ADD CONSTRAINT "visitors_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- ─── vitals ───
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE table_name = 'vitals' AND constraint_name = 'vitals_tenantId_fkey'
    ) THEN
        ALTER TABLE "vitals" DROP CONSTRAINT "vitals_tenantId_fkey";
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'vitals'
    ) THEN
        ALTER TABLE "vitals"
            ADD CONSTRAINT "vitals_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- ─── waitlist_entries ───
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE table_name = 'waitlist_entries' AND constraint_name = 'waitlist_entries_tenantId_fkey'
    ) THEN
        ALTER TABLE "waitlist_entries" DROP CONSTRAINT "waitlist_entries_tenantId_fkey";
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'waitlist_entries'
    ) THEN
        ALTER TABLE "waitlist_entries"
            ADD CONSTRAINT "waitlist_entries_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

-- ─── wards ───
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE table_name = 'wards' AND constraint_name = 'wards_tenantId_fkey'
    ) THEN
        ALTER TABLE "wards" DROP CONSTRAINT "wards_tenantId_fkey";
    END IF;
    IF EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'wards'
    ) THEN
        ALTER TABLE "wards"
            ADD CONSTRAINT "wards_tenantId_fkey"
            FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;
