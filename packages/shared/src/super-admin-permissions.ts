// Seed-time BASELINE for the super-admin permission-grant catalog.
//
// At RUNTIME the catalog is DB-backed and dynamic: it lives in the
// `SuperAdminPermission` table, is served by
// `GET /api/v1/super-admin/users/permissions/catalog`, and the invite form +
// the API validation both read it from there — so a super-admin can add /
// edit / disable grants without a code change. This constant is used ONLY by
// the seed (`packages/db/src/seed.ts`) to populate the baseline rows, exactly
// like `PLAN_DEFINITIONS` seeds the dynamic `PlatformPlan` catalog. To ship a
// new default grant, add it here AND it will upsert on the next seed; existing
// installs can also add one live via the catalog table.

export interface SuperAdminPermission {
  key: string;
  label: string;
  description: string;
  /** Whether the invite form pre-checks this grant for a new super-admin. */
  defaultGranted: boolean;
}

export const SUPER_ADMIN_PERMISSIONS = [
  {
    key: "canManageTenants",
    label: "Manage tenants",
    description: "Create / suspend / restore / archive tenants",
    defaultGranted: true,
  },
  {
    key: "canOnboardTenant",
    label: "Onboard tenant",
    description: "Run the 8-step tenant onboarding wizard",
    defaultGranted: true,
  },
  {
    key: "canViewBilling",
    label: "View billing",
    description: "Platform billing dashboards + invoices",
    defaultGranted: false,
  },
  {
    key: "canTriggerJobs",
    label: "Trigger jobs",
    description: "Retry failed crons, manual archival",
    defaultGranted: false,
  },
  {
    key: "canDpdpWorkbench",
    label: "DPDP workbench",
    description: "Execute right-to-erasure requests",
    defaultGranted: false,
  },
  {
    key: "canViewAudit",
    label: "View audit trail",
    description: "Read the cross-tenant super-admin audit log",
    defaultGranted: true,
  },
] as const satisfies readonly SuperAdminPermission[];
