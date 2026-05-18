-- ================================================================
-- 20260517000007_backfill_tenant_id_admissions_labs_rx_notifications
--
-- Closes: #895 part 2 of N — backfill tenantId on 4 more tables that
-- were leaking nulls per PRD evidence. Each derives tenantId from a
-- parent row via an existing FK.
--
-- Tables covered:
--   - admissions        — derive from patient.tenantId (FK: patientId)
--   - prescriptions     — derive from patient.tenantId (FK: patientId)
--   - lab_orders        — derive from patient.tenantId (FK: patientId)
--   - notifications     — derive from user.tenantId    (FK: userId)
--
-- Order matters: patients + users must be backfilled FIRST (done in
-- migration 20260517000006), since the derivations below read from
-- them.
--
-- Out of this migration (each needs separate review):
--   - inventory_items   — needs medicine/branch linkage; no single FK
--   - purchase_orders   — needs supplier/creator linkage; no single FK
--
-- Conservative everywhere: only updates rows where current tenantId
-- IS NULL AND the parent row's tenantId IS NOT NULL. Doesn't move
-- rows between tenants. Truly-orphan rows (parent has null too) get
-- a quarantine-tenant decision separate from this migration.
--
-- Idempotent: re-running matches zero rows once parents agree.
-- ================================================================

-- ── admissions.tenantId ← patient.tenantId ────────────────────────
UPDATE "admissions" a
   SET "tenantId" = p."tenantId"
  FROM "patients" p
 WHERE a."patientId" = p.id
   AND a."tenantId" IS NULL
   AND p."tenantId" IS NOT NULL;

-- ── prescriptions.tenantId ← patient.tenantId ────────────────────
UPDATE "prescriptions" rx
   SET "tenantId" = p."tenantId"
  FROM "patients" p
 WHERE rx."patientId" = p.id
   AND rx."tenantId" IS NULL
   AND p."tenantId" IS NOT NULL;

-- ── lab_orders.tenantId ← patient.tenantId ───────────────────────
UPDATE "lab_orders" lo
   SET "tenantId" = p."tenantId"
  FROM "patients" p
 WHERE lo."patientId" = p.id
   AND lo."tenantId" IS NULL
   AND p."tenantId" IS NOT NULL;

-- ── notifications.tenantId ← user.tenantId ───────────────────────
-- Notifications are addressed TO a user (the recipient), so deriving
-- from user.tenantId tags the row with the recipient's tenant — even
-- if the system actor that wrote the notification was cross-tenant
-- (a cron job, for example).
UPDATE "notifications" n
   SET "tenantId" = u."tenantId"
  FROM "users" u
 WHERE n."userId" = u.id
   AND n."tenantId" IS NULL
   AND u."tenantId" IS NOT NULL;
