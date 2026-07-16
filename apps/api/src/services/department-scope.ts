// Department-membership scoping (2026-07) — enforces that non-admin staff only
// see and act on departments they are a member of.
//
// What: a small set of helpers that resolve the set of department ids a caller
//   may touch, and assert membership for a specific department.
// Which: reads DepartmentMember via the tenant-scoped Prisma client.
// Why: the DepartmentMember join table records who belongs where, but the
//   requisition picker/list/create endpoints previously ignored it — every
//   staff member saw every department. Product rule: an admin decides who is in
//   which department; a member of department A must NOT see or raise
//   requisitions against department B. ADMIN is the only unscoped role (they
//   configure departments); everyone else — including the store PHARMACIST — is
//   scoped to their memberships.

import { tenantScopedPrisma as prisma } from "@medcore/db";
import { Role } from "@medcore/shared";

/** ADMIN sees every department; all other roles are scoped to memberships. */
export function isUnscopedRole(role: Role | string | undefined): boolean {
  return role === Role.ADMIN;
}

/**
 * The department ids a caller may access.
 *
 *  - ADMIN → `null` (sentinel for "no restriction — all departments").
 *  - anyone else → the exact set of departmentIds from their DepartmentMember
 *    rows. An empty array means "not added to any department yet" and the
 *    caller should see nothing.
 */
export async function allowedDepartmentIds(
  userId: string | undefined,
  role: Role | string | undefined,
): Promise<string[] | null> {
  if (isUnscopedRole(role)) return null; // unrestricted
  if (!userId) return []; // no identity → nothing
  const rows = await prisma.departmentMember.findMany({
    where: { userId },
    select: { departmentId: true },
  });
  return rows.map((r) => r.departmentId);
}

/**
 * True when the caller may access `departmentId`. ADMIN always may; others must
 * have a DepartmentMember row for it.
 */
export async function isMemberOf(
  userId: string | undefined,
  role: Role | string | undefined,
  departmentId: string,
): Promise<boolean> {
  if (isUnscopedRole(role)) return true;
  if (!userId) return false;
  const row = await prisma.departmentMember.findFirst({
    where: { userId, departmentId },
    select: { id: true },
  });
  return !!row;
}
