/**
 * Department-scope service (2026-07) — unit tests for the membership-scoping
 * helpers used by the requisitions API + global search.
 *
 * What / which / why:
 *   - Pins the three helpers in services/department-scope.ts:
 *       isUnscopedRole  — only ADMIN is unscoped
 *       allowedDepartmentIds — null for ADMIN, [] for no-identity / no-member,
 *         else the caller's department ids
 *       isMemberOf — ADMIN always true; others require a DepartmentMember row
 *   - These encode the isolation rule "a member of department A must not see or
 *     act on department B". A regression here silently widens access, so the
 *     contract is worth a fast, DB-free test.
 *   - Mocked Prisma (no DB), hoisted-mock style.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Role } from "@medcore/shared";

const { prismaMock } = vi.hoisted(() => {
  const base: any = {
    departmentMember: {
      findMany: vi.fn(async () => []),
      findFirst: vi.fn(async () => null),
    },
  };
  return { prismaMock: base };
});

vi.mock("@medcore/db", () => ({
  getTenantId: () => undefined,
  runWithTenant: (_t: string, fn: () => unknown) => fn(),
  requireTenantId: () => {
    throw new Error("tenant ctx required");
  },
  prisma: prismaMock,
  tenantScopedPrisma: prismaMock,
}));

import {
  isUnscopedRole,
  allowedDepartmentIds,
  isMemberOf,
} from "./department-scope";

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.departmentMember.findMany.mockResolvedValue([]);
  prismaMock.departmentMember.findFirst.mockResolvedValue(null);
});

describe("isUnscopedRole", () => {
  it("only ADMIN is unscoped", () => {
    expect(isUnscopedRole(Role.ADMIN)).toBe(true);
    expect(isUnscopedRole(Role.NURSE)).toBe(false);
    expect(isUnscopedRole(Role.DOCTOR)).toBe(false);
    expect(isUnscopedRole(Role.PHARMACIST)).toBe(false);
    expect(isUnscopedRole(undefined)).toBe(false);
  });
});

describe("allowedDepartmentIds", () => {
  it("returns null (unrestricted) for ADMIN without querying memberships", async () => {
    const ids = await allowedDepartmentIds("u1", Role.ADMIN);
    expect(ids).toBeNull();
    expect(prismaMock.departmentMember.findMany).not.toHaveBeenCalled();
  });

  it("returns [] when there is no user identity", async () => {
    const ids = await allowedDepartmentIds(undefined, Role.NURSE);
    expect(ids).toEqual([]);
    expect(prismaMock.departmentMember.findMany).not.toHaveBeenCalled();
  });

  it("returns the caller's department ids for a scoped role", async () => {
    prismaMock.departmentMember.findMany.mockResolvedValueOnce([
      { departmentId: "dept-A" },
      { departmentId: "dept-C" },
    ]);
    const ids = await allowedDepartmentIds("u1", Role.NURSE);
    expect(ids).toEqual(["dept-A", "dept-C"]);
    expect(prismaMock.departmentMember.findMany).toHaveBeenCalledWith({
      where: { userId: "u1" },
      select: { departmentId: true },
    });
  });

  it("returns [] for a scoped role with no memberships", async () => {
    prismaMock.departmentMember.findMany.mockResolvedValueOnce([]);
    const ids = await allowedDepartmentIds("u1", Role.PHARMACIST);
    expect(ids).toEqual([]);
  });
});

describe("isMemberOf", () => {
  it("ADMIN is a member of any department (no query)", async () => {
    const ok = await isMemberOf("u1", Role.ADMIN, "dept-B");
    expect(ok).toBe(true);
    expect(prismaMock.departmentMember.findFirst).not.toHaveBeenCalled();
  });

  it("false when there is no user identity", async () => {
    const ok = await isMemberOf(undefined, Role.NURSE, "dept-B");
    expect(ok).toBe(false);
    expect(prismaMock.departmentMember.findFirst).not.toHaveBeenCalled();
  });

  it("true when the scoped caller has a membership row for the department", async () => {
    prismaMock.departmentMember.findFirst.mockResolvedValueOnce({ id: "dm-1" });
    const ok = await isMemberOf("u1", Role.NURSE, "dept-A");
    expect(ok).toBe(true);
    expect(prismaMock.departmentMember.findFirst).toHaveBeenCalledWith({
      where: { userId: "u1", departmentId: "dept-A" },
      select: { id: true },
    });
  });

  it("false when the scoped caller has no membership row (BOLA guard)", async () => {
    prismaMock.departmentMember.findFirst.mockResolvedValueOnce(null);
    const ok = await isMemberOf("u1", Role.NURSE, "dept-B");
    expect(ok).toBe(false);
  });
});
