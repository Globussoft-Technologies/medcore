-- Pearl ERP Stage 1 §8.1 wizard step 3 — relational role-permission catalog.
-- Replaces the prior `SystemConfig.role_permissions_v1` JSON blob with two
-- properly relational tables. The initial 10 roles + their starter
-- permissions are inserted at the bottom of this migration so a fresh DB
-- has the catalog populated without a separate seed step. Edits made via
-- /dashboard/tenants/[id]/role-permissions go straight to these rows.

-- ─── Tables ──────────────────────────────────────────────────────────

CREATE TABLE "role_catalog_entries" (
    "id" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "label" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "role_catalog_entries_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "role_catalog_entries_role_key" ON "role_catalog_entries"("role");

CREATE TABLE "role_permission_items" (
    "id" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "permission" TEXT NOT NULL,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "role_permission_items_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "role_permission_items_entryId_displayOrder_idx"
    ON "role_permission_items"("entryId", "displayOrder");

ALTER TABLE "role_permission_items"
    ADD CONSTRAINT "role_permission_items_entryId_fkey"
    FOREIGN KEY ("entryId") REFERENCES "role_catalog_entries"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── Initial data ────────────────────────────────────────────────────
-- 10 roles, one row each in role_catalog_entries with a deterministic id
-- so the inserts below can reference them without a sub-select. The ids
-- are stable plain strings (not UUIDs) — the column is TEXT so this is
-- legal, and it makes the migration self-contained / re-readable. New
-- rows created via the edit UI will use uuid() per the Prisma schema
-- default; mixing string ids and uuids in the same column is fine.

INSERT INTO "role_catalog_entries"
    ("id", "role", "label", "summary", "displayOrder", "updatedAt")
VALUES
    ('rce-admin', 'ADMIN', 'Hospital Admin',
     'Tenant owner — configures the hospital, invites staff and reviews everything.',
     1, CURRENT_TIMESTAMP),
    ('rce-doctor', 'DOCTOR', 'Doctor',
     'Sees patients, prescribes, signs consult notes.',
     2, CURRENT_TIMESTAMP),
    ('rce-nurse', 'NURSE', 'Nurse',
     'Ward + bedside operations: vitals, medication, admissions.',
     3, CURRENT_TIMESTAMP),
    ('rce-reception', 'RECEPTION', 'Receptionist',
     'Front desk: registration, check-in, basic billing.',
     4, CURRENT_TIMESTAMP),
    ('rce-pharmacist', 'PHARMACIST', 'Pharmacist',
     'Pharmacy floor: dispense, inventory, pharmacy bills.',
     5, CURRENT_TIMESTAMP),
    ('rce-lab-tech', 'LAB_TECH', 'Lab Technician',
     'Lab orders, sample collection, result entry.',
     6, CURRENT_TIMESTAMP),
    ('rce-billing', 'BILLING', 'Billing / Finance',
     'Finance back-office: TDS, commissions, no-show, lead funnel.',
     7, CURRENT_TIMESTAMP),
    ('rce-platform-operator', 'PLATFORM_OPERATOR', 'Platform Operator (Onviqa)',
     'Cross-tenant operations — onboard, suspend, restore, support.',
     8, CURRENT_TIMESTAMP),
    ('rce-platform-billing-operator', 'PLATFORM_BILLING_OPERATOR',
     'Platform Billing Operator (Onviqa)',
     'Platform-side billing: invoices, MRR, dunning.',
     9, CURRENT_TIMESTAMP),
    ('rce-super-admin', 'SUPER_ADMIN', 'Super Admin',
     'Onviqa-side root — every ADMIN permission, plus cross-tenant override.',
     10, CURRENT_TIMESTAMP);

-- Permissions per role. `id` is a uuid()-style synthetic; the displayOrder
-- column drives the rendered list order so an operator deleting an item
-- doesn't leave gaps that affect visible ordering (the API renumbers on
-- the fly when reading).

INSERT INTO "role_permission_items"
    ("id", "entryId", "permission", "displayOrder")
VALUES
    -- ADMIN
    ('rpi-admin-1', 'rce-admin', 'Manage users, roles and invitations', 1),
    ('rpi-admin-2', 'rce-admin', 'Edit hospital identity, branches and tax settings', 2),
    ('rpi-admin-3', 'rce-admin', 'Configure WhatsApp, payment gateway and ABDM credentials', 3),
    ('rpi-admin-4', 'rce-admin', 'Read every clinical record, prescription and audit log', 4),
    ('rpi-admin-5', 'rce-admin', 'Approve refunds, discounts and write-offs', 5),
    ('rpi-admin-6', 'rce-admin', 'Run finance and operational reports', 6),

    -- DOCTOR
    ('rpi-doctor-1', 'rce-doctor', 'View own queue and assigned patients', 1),
    ('rpi-doctor-2', 'rce-doctor', 'Create, sign and share prescriptions', 2),
    ('rpi-doctor-3', 'rce-doctor', 'Record SOAP notes, diagnoses and follow-up plans', 3),
    ('rpi-doctor-4', 'rce-doctor', 'Order lab tests and imaging', 4),
    ('rpi-doctor-5', 'rce-doctor', 'View own appointment calendar', 5),

    -- NURSE
    ('rpi-nurse-1', 'rce-nurse', 'Manage admissions, discharges and bed allocation', 1),
    ('rpi-nurse-2', 'rce-nurse', 'Record vitals, intake/output and observations', 2),
    ('rpi-nurse-3', 'rce-nurse', 'Administer medications per doctor''s chart', 3),
    ('rpi-nurse-4', 'rce-nurse', 'Update antenatal and postnatal visit logs', 4),
    ('rpi-nurse-5', 'rce-nurse', 'View assigned patients'' clinical history', 5),

    -- RECEPTION
    ('rpi-reception-1', 'rce-reception', 'Register new patients and update demographics', 1),
    ('rpi-reception-2', 'rce-reception', 'Book, reschedule and cancel appointments', 2),
    ('rpi-reception-3', 'rce-reception', 'Check patients in and manage the live queue', 3),
    ('rpi-reception-4', 'rce-reception', 'Collect consultation fees and issue receipts', 4),
    ('rpi-reception-5', 'rce-reception', 'Pick up AI-triage handoffs in Agent Console', 5),

    -- PHARMACIST
    ('rpi-pharmacist-1', 'rce-pharmacist', 'Dispense prescribed medicines and apply substitutions', 1),
    ('rpi-pharmacist-2', 'rce-pharmacist', 'Manage pharmacy stock, batches and expiry alerts', 2),
    ('rpi-pharmacist-3', 'rce-pharmacist', 'Raise and approve purchase orders for medicines', 3),
    ('rpi-pharmacist-4', 'rce-pharmacist', 'Issue pharmacy bills and process refunds', 4),
    ('rpi-pharmacist-5', 'rce-pharmacist', 'View controlled-substance ledger', 5),

    -- LAB_TECH
    ('rpi-lab-tech-1', 'rce-lab-tech', 'View pending lab orders for assigned department', 1),
    ('rpi-lab-tech-2', 'rce-lab-tech', 'Mark samples collected, in-progress, completed', 2),
    ('rpi-lab-tech-3', 'rce-lab-tech', 'Enter and validate lab result values', 3),
    ('rpi-lab-tech-4', 'rce-lab-tech', 'Upload imaging reports and attach to patient records', 4),
    ('rpi-lab-tech-5', 'rce-lab-tech', 'Flag critical values for doctor review', 5),

    -- BILLING
    ('rpi-billing-1', 'rce-billing', 'Run TDS, commission and no-show reports', 1),
    ('rpi-billing-2', 'rce-billing', 'Process insurance claims and reconciliations', 2),
    ('rpi-billing-3', 'rce-billing', 'Approve high-value refunds and discount exceptions', 3),
    ('rpi-billing-4', 'rce-billing', 'Reconcile payment-gateway settlements', 4),
    ('rpi-billing-5', 'rce-billing', 'Export accounting ledgers for upstream tools', 5),

    -- PLATFORM_OPERATOR
    ('rpi-platform-operator-1', 'rce-platform-operator', 'Onboard, suspend and restore tenants', 1),
    ('rpi-platform-operator-2', 'rce-platform-operator', 'Configure tenant feature flags and quotas', 2),
    ('rpi-platform-operator-3', 'rce-platform-operator', 'View cross-tenant observability and audit logs', 3),
    ('rpi-platform-operator-4', 'rce-platform-operator', 'Reset tenant admin credentials on request', 4),
    ('rpi-platform-operator-5', 'rce-platform-operator', 'Trigger seed and migration jobs', 5),

    -- PLATFORM_BILLING_OPERATOR
    ('rpi-platform-billing-operator-1', 'rce-platform-billing-operator', 'Issue and reconcile platform invoices', 1),
    ('rpi-platform-billing-operator-2', 'rce-platform-billing-operator', 'Manage plan upgrades, downgrades and add-ons', 2),
    ('rpi-platform-billing-operator-3', 'rce-platform-billing-operator', 'Run dunning campaigns for overdue tenants', 3),
    ('rpi-platform-billing-operator-4', 'rce-platform-billing-operator', 'View MRR, churn and LTV dashboards', 4),
    ('rpi-platform-billing-operator-5', 'rce-platform-billing-operator', 'Adjust per-tenant billing contacts', 5),

    -- SUPER_ADMIN
    ('rpi-super-admin-1', 'rce-super-admin', 'Everything an Admin can do, across every tenant', 1),
    ('rpi-super-admin-2', 'rce-super-admin', 'Override per-tenant feature flags', 2),
    ('rpi-super-admin-3', 'rce-super-admin', 'Impersonate tenant admins for support', 3),
    ('rpi-super-admin-4', 'rce-super-admin', 'Trigger emergency tenant data exports', 4),
    ('rpi-super-admin-5', 'rce-super-admin', 'Manage other super-admin invites and TOTP resets', 5);

-- Retire the legacy JSON blob written by the previous implementation so it
-- can't drift away from the relational truth. Idempotent — no-op on a
-- fresh DB that never had the old key.
DELETE FROM "system_config" WHERE "key" = 'role_permissions_v1';
DELETE FROM "system_config" WHERE "key" LIKE 'tenant:%:role_permissions_v1';
