-- ================================================================
-- 20260517000006_backfill_patient_and_user_tenant_id
--
-- Closes: #895 part 1 of N — backfill patients.tenantId + users.tenantId
-- where they're NULL but the linked sibling row has it set.
--
-- The accompanying route fix (apps/api/src/routes/patients.ts on this
-- commit) does two things going forward:
--   1. 400-rejects POST /patients when req.tenantId is missing
--   2. Explicitly passes tenantId into BOTH tx.user.create and
--      tx.patient.create inside the transaction (defense-in-depth
--      because the $extends auto-inject may not propagate to tx
--      callbacks reliably in this Prisma version)
--
-- This migration cleans up the EXISTING orphan rows that PRD evidence
-- caught on staging (6/100 patients, plus equivalent shares on
-- admissions / lab_orders / prescriptions / etc.). We tackle patients
-- + users here because they're the primary identity surface that
-- gates everything else. Admissions / lab_orders / prescriptions etc.
-- get their own follow-up migrations once each table's correct
-- derivation logic is settled (most can derive tenantId from
-- patient.tenantId via patientId FK, but each is a separate review).
--
-- Two-pass:
--   1. Backfill users.tenantId from the patient's tenant (user is the
--      identity row; patient is the clinical row that already has the
--      tenant linkage via prior writes that DID stamp it).
--   2. Backfill patients.tenantId from the user's tenant (the inverse
--      case — covers patients where the User row had tenantId but the
--      Patient row didn't, e.g. older create paths that wrote to
--      different orderings).
--
-- Conservative: only updates NULL rows. Doesn't move rows between
-- tenants. Doesn't touch rows where neither sibling has a tenant
-- (truly-orphan pre-multi-tenant data; needs a quarantine tenant
-- decision separate from this migration).
--
-- Idempotent: re-running matches zero rows once siblings agree.
-- ================================================================

-- ── Pass 1: users.tenantId ← patient.tenantId ─────────────────────
-- For users that are PATIENT-role and whose Patient row has a tenant.
UPDATE "users" u
   SET "tenantId" = p."tenantId"
  FROM "patients" p
 WHERE p."userId" = u.id
   AND u."tenantId" IS NULL
   AND p."tenantId" IS NOT NULL;

-- ── Pass 2: patients.tenantId ← user.tenantId ─────────────────────
-- The inverse: patient row missing tenant but their User has one
-- (e.g. older walk-in paths that stamped User but not Patient).
UPDATE "patients" p
   SET "tenantId" = u."tenantId"
  FROM "users" u
 WHERE p."userId" = u.id
   AND p."tenantId" IS NULL
   AND u."tenantId" IS NOT NULL;
