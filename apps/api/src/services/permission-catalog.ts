// Dynamic super-admin permission catalog.
//
// Single source of truth for the available super-admin permission GRANTS is the
// `SuperAdminPermission` table (seeded from @medcore/shared, editable at
// runtime). Mirrors plan-catalog.ts. The invite form reads this to render its
// checklist and the create/update routes read it to validate which grant keys
// are accepted — so a new grant can be added in the DB with no code change.
//
// NOTE: per-operator grant VALUES (which grants a given super-admin actually
// has) are stored separately as JSON in SystemConfig at
// `superadmin:<userId>:permissions`. This catalog only defines the keys + copy.
import type { SuperAdminPermission, PrismaClient } from "@prisma/client";

/** List catalog grants, ordered by sortOrder. `activeOnly` hides disabled rows. */
export async function listSuperAdminPermissions(
  prisma: PrismaClient,
  opts: { activeOnly?: boolean } = {},
): Promise<SuperAdminPermission[]> {
  return prisma.superAdminPermission.findMany({
    where: opts.activeOnly ? { active: true } : undefined,
    orderBy: [{ sortOrder: "asc" }, { label: "asc" }],
  });
}

/** The set of grant keys the catalog currently accepts (active only). */
export async function activePermissionKeys(
  prisma: PrismaClient,
): Promise<Set<string>> {
  const rows = await listSuperAdminPermissions(prisma, { activeOnly: true });
  return new Set(rows.map((r) => r.key));
}
