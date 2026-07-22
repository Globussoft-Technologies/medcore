/**
 * Department admin module (2026-07) — CRUD + RBAC + delete-policy unit tests.
 *
 * What / which / why:
 *   - Pins the admin department API (routes/departments.ts): ADMIN-only gating,
 *     the (tenant, code) uniqueness 409 on create/update, and the delete policy
 *     (soft-delete when the department has requisition history, hard-delete when
 *     it has none).
 *   - Mocked Prisma (no DB), same hoisted-mock style as requisitions.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { ZodError } from "zod";

const { prismaMock } = vi.hoisted(() => {
  const base: any = {
    department: {
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(async () => null),
      findFirst: vi.fn(async () => null),
      create: vi.fn(async () => ({ id: "d1" })),
      update: vi.fn(async () => ({})),
      delete: vi.fn(async () => ({})),
    },
    requisition: { findMany: vi.fn(async () => []) },
    departmentMaterialHolding: { findMany: vi.fn(async () => []) },
    departmentMember: {
      findMany: vi.fn(async () => []),
      findFirst: vi.fn(async () => null),
      findUnique: vi.fn(async () => null),
      upsert: vi.fn(async () => ({})),
      delete: vi.fn(async () => ({})),
    },
    user: { findUnique: vi.fn(async () => null), findMany: vi.fn(async () => []) },
    auditLog: { create: vi.fn(async () => ({ id: "al" })) },
  };
  return { prismaMock: base };
});

vi.mock("@medcore/db", () => ({
  getTenantId: () => undefined,
  tenantScopedPrisma: prismaMock,
  runWithTenant: (_t: string, fn: () => unknown) => fn(),
  requireTenantId: () => {
    throw new Error("tenant ctx required");
  },
  prisma: prismaMock,
}));

import { departmentsRouter } from "./departments";

function buildApp() {
  process.env.JWT_SECRET = "test-secret";
  const app = express();
  app.use(express.json());
  app.use("/api/v1/departments", departmentsRouter);
  app.use((err: any, _req: any, res: any, _next: any) => {
    // Mirror the real errorHandler: Zod validation failures are 400s.
    if (err instanceof ZodError) {
      res.status(400).json({ success: false, error: "Validation failed", issues: err.issues });
      return;
    }
    res.status(err?.statusCode ?? 500).json({ success: false, error: err?.message ?? String(err) });
  });
  return app;
}
function tok(role: string): string {
  return jwt.sign({ userId: "u1", email: "u@t.local", role }, "test-secret");
}

const D1 = "d93c8b27-4f78-4ee1-a7ac-298b5b4eb09d";

beforeEach(() => {
  Object.values(prismaMock).forEach((m: any) => {
    if (m && typeof m === "object") {
      Object.values(m).forEach((fn: any) => fn?.mockReset?.());
    }
  });
  prismaMock.auditLog.create.mockResolvedValue({ id: "al" });
  prismaMock.departmentMember.findMany.mockResolvedValue([{ departmentId: D1 }]);
  prismaMock.departmentMember.findFirst.mockResolvedValue({ id: "dm1" });
  prismaMock.departmentMaterialHolding.findMany.mockResolvedValue([]);
});

describe("Department RBAC", () => {
  it("ADMIN can list all departments; assigned NURSE sees only assigned departments", async () => {
    prismaMock.department.findMany.mockResolvedValue([]);
    const ok = await request(buildApp())
      .get("/api/v1/departments")
      .set("Authorization", `Bearer ${tok("ADMIN")}`);
    expect(ok.status).toBe(200);

    const assigned = await request(buildApp())
      .get("/api/v1/departments")
      .set("Authorization", `Bearer ${tok("NURSE")}`);
    expect(assigned.status).toBe(200);
    expect(prismaMock.department.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: { in: [D1] }, active: true }),
      }),
    );
  });

  it("unassigned staff list gets an empty result with notInAnyDepartment", async () => {
    prismaMock.departmentMember.findMany.mockResolvedValue([]);
    const res = await request(buildApp())
      .get("/api/v1/departments")
      .set("Authorization", `Bearer ${tok("NURSE")}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(res.body.meta?.notInAnyDepartment).toBe(true);
    expect(prismaMock.department.findMany).not.toHaveBeenCalled();
  });

  it("non-admin cannot create a department", async () => {
    const res = await request(buildApp())
      .post("/api/v1/departments")
      .set("Authorization", `Bearer ${tok("PHARMACIST")}`)
      .send({ name: "Radiology", code: "RAD" });
    expect(res.status).toBe(403);
    expect(prismaMock.department.create).not.toHaveBeenCalled();
  });
});

describe("Department create", () => {
  it("creates a department and uppercases the code", async () => {
    prismaMock.department.findFirst.mockResolvedValue(null);
    prismaMock.department.create.mockResolvedValue({ id: "d1", name: "Radiology", code: "RAD" });
    const res = await request(buildApp())
      .post("/api/v1/departments")
      .set("Authorization", `Bearer ${tok("ADMIN")}`)
      .send({ name: "Radiology", code: "rad" });
    expect(res.status).toBe(201);
    // Zod transform uppercases the code before the handler sees it.
    expect(prismaMock.department.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ code: "RAD" }) }),
    );
  });

  it("rejects a duplicate code with 409", async () => {
    prismaMock.department.findFirst.mockResolvedValue({ id: "existing" });
    const res = await request(buildApp())
      .post("/api/v1/departments")
      .set("Authorization", `Bearer ${tok("ADMIN")}`)
      .send({ name: "Radiology", code: "RAD" });
    expect(res.status).toBe(409);
    expect(prismaMock.department.create).not.toHaveBeenCalled();
  });

  it("rejects an invalid code (bad chars) with 400", async () => {
    const res = await request(buildApp())
      .post("/api/v1/departments")
      .set("Authorization", `Bearer ${tok("ADMIN")}`)
      .send({ name: "Radiology", code: "bad code!" });
    expect(res.status).toBe(400);
  });
});

describe("Department update", () => {
  it("updates name/active on an existing department", async () => {
    prismaMock.department.findUnique.mockResolvedValue({ id: D1 });
    prismaMock.department.update.mockResolvedValue({ id: D1, name: "New", active: false });
    const res = await request(buildApp())
      .patch(`/api/v1/departments/${D1}`)
      .set("Authorization", `Bearer ${tok("ADMIN")}`)
      .send({ name: "New", active: false });
    expect(res.status).toBe(200);
    expect(prismaMock.department.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: D1 }, data: { name: "New", active: false } }),
    );
  });

  it("404s when updating a missing department", async () => {
    prismaMock.department.findUnique.mockResolvedValue(null);
    const res = await request(buildApp())
      .patch(`/api/v1/departments/${D1}`)
      .set("Authorization", `Bearer ${tok("ADMIN")}`)
      .send({ name: "New" });
    expect(res.status).toBe(404);
  });

  it("409s when the new code clashes with another department", async () => {
    prismaMock.department.findUnique.mockResolvedValue({ id: D1 });
    prismaMock.department.findFirst.mockResolvedValue({ id: "other" });
    const res = await request(buildApp())
      .patch(`/api/v1/departments/${D1}`)
      .set("Authorization", `Bearer ${tok("ADMIN")}`)
      .send({ code: "TAKEN" });
    expect(res.status).toBe(409);
    expect(prismaMock.department.update).not.toHaveBeenCalled();
  });
});

describe("Department delete policy", () => {
  it("soft-deletes (deactivates) a department that has requisition history", async () => {
    prismaMock.department.findUnique.mockResolvedValue({
      id: D1,
      name: "Radiology",
      code: "RAD",
      _count: { requisitions: 3 },
    });
    prismaMock.department.update.mockResolvedValue({ id: D1, active: false });
    const res = await request(buildApp())
      .delete(`/api/v1/departments/${D1}`)
      .set("Authorization", `Bearer ${tok("ADMIN")}`);
    expect(res.status).toBe(200);
    expect(res.body.data.softDeleted).toBe(true);
    expect(prismaMock.department.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: D1 }, data: { active: false } }),
    );
    expect(prismaMock.department.delete).not.toHaveBeenCalled();
  });

  it("hard-deletes a department with no requisition history", async () => {
    prismaMock.department.findUnique.mockResolvedValue({
      id: D1,
      name: "Unused",
      code: "UNU",
      _count: { requisitions: 0 },
    });
    prismaMock.department.delete.mockResolvedValue({ id: D1 });
    const res = await request(buildApp())
      .delete(`/api/v1/departments/${D1}`)
      .set("Authorization", `Bearer ${tok("ADMIN")}`);
    expect(res.status).toBe(200);
    expect(res.body.data.hardDeleted).toBe(true);
    expect(prismaMock.department.delete).toHaveBeenCalledWith({ where: { id: D1 } });
  });

  it("404s when deleting a missing department", async () => {
    prismaMock.department.findUnique.mockResolvedValue(null);
    const res = await request(buildApp())
      .delete(`/api/v1/departments/${D1}`)
      .set("Authorization", `Bearer ${tok("ADMIN")}`);
    expect(res.status).toBe(404);
  });

  it("force-delete of a department WITH history is blocked (409)", async () => {
    prismaMock.department.findUnique.mockResolvedValue({
      id: D1,
      name: "Radiology",
      code: "RAD",
      _count: { requisitions: 2 },
    });
    const res = await request(buildApp())
      .delete(`/api/v1/departments/${D1}?force=true`)
      .set("Authorization", `Bearer ${tok("ADMIN")}`);
    expect(res.status).toBe(409);
    expect(prismaMock.department.delete).not.toHaveBeenCalled();
  });

  it("force-delete of a department with NO history hard-deletes", async () => {
    prismaMock.department.findUnique.mockResolvedValue({
      id: D1,
      name: "Unused",
      code: "UNU",
      _count: { requisitions: 0 },
    });
    prismaMock.department.delete.mockResolvedValue({ id: D1 });
    const res = await request(buildApp())
      .delete(`/api/v1/departments/${D1}?force=true`)
      .set("Authorization", `Bearer ${tok("ADMIN")}`);
    expect(res.status).toBe(200);
    expect(res.body.data.hardDeleted).toBe(true);
    expect(prismaMock.department.delete).toHaveBeenCalledWith({ where: { id: D1 } });
  });
});

describe("Department dashboard", () => {
  it("aggregates per-department request counts + issued units", async () => {
    prismaMock.department.findMany.mockResolvedValue([
      { id: D1, name: "Radiology", code: "RAD", active: true },
    ]);
    prismaMock.requisition.findMany.mockResolvedValue([
      { departmentId: D1, status: "SUBMITTED", items: [{ issuedQty: 0 }] },
      { departmentId: D1, status: "COMPLETED", items: [{ issuedQty: 5 }, { issuedQty: 3 }] },
    ]);
    const res = await request(buildApp())
      .get("/api/v1/departments/dashboard")
      .set("Authorization", `Bearer ${tok("ADMIN")}`);
    expect(res.status).toBe(200);
    expect(res.body.data.summary).toMatchObject({
      totalDepartments: 1,
      activeDepartments: 1,
      openRequests: 1,
      completedRequests: 1,
    });
    const dept = res.body.data.perDepartment[0];
    expect(dept).toMatchObject({ openRequests: 1, completedRequests: 1, issuedUnits: 8 });
  });
});

const U1 = "5f6cd0e0-e4ed-4284-9b92-92ef977b129e"; // a staff user id

describe("Department members", () => {
  it("adds a member (idempotent upsert) and audits it", async () => {
    prismaMock.department.findUnique.mockResolvedValue({ id: D1 });
    prismaMock.user.findUnique.mockResolvedValue({ id: U1, role: "DOCTOR" });
    prismaMock.departmentMember.upsert.mockResolvedValue({
      id: "dm1",
      userId: U1,
      user: { id: U1, name: "Dr X", email: "x@t.local", role: "DOCTOR" },
    });
    const res = await request(buildApp())
      .post(`/api/v1/departments/${D1}/members`)
      .set("Authorization", `Bearer ${tok("ADMIN")}`)
      .send({ userId: U1 });
    expect(res.status).toBe(201);
    expect(prismaMock.departmentMember.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { departmentId_userId: { departmentId: D1, userId: U1 } },
      }),
    );
  });

  it("400s when adding a member without a userId", async () => {
    const res = await request(buildApp())
      .post(`/api/v1/departments/${D1}/members`)
      .set("Authorization", `Bearer ${tok("ADMIN")}`)
      .send({});
    expect(res.status).toBe(400);
  });

  it("404s when adding a member to a missing department", async () => {
    prismaMock.department.findUnique.mockResolvedValue(null);
    prismaMock.user.findUnique.mockResolvedValue({ id: U1, role: "DOCTOR" });
    const res = await request(buildApp())
      .post(`/api/v1/departments/${D1}/members`)
      .set("Authorization", `Bearer ${tok("ADMIN")}`)
      .send({ userId: U1 });
    expect(res.status).toBe(404);
  });

  it("removes a member", async () => {
    prismaMock.departmentMember.findUnique.mockResolvedValue({ id: "dm1" });
    prismaMock.departmentMember.delete.mockResolvedValue({ id: "dm1" });
    const res = await request(buildApp())
      .delete(`/api/v1/departments/${D1}/members/${U1}`)
      .set("Authorization", `Bearer ${tok("ADMIN")}`);
    expect(res.status).toBe(200);
    expect(res.body.data.removed).toBe(true);
  });

  it("member search excludes existing members and non-staff", async () => {
    prismaMock.departmentMember.findMany.mockResolvedValue([{ userId: U1 }]);
    prismaMock.user.findMany.mockResolvedValue([
      { id: "u2", name: "Nurse A", email: "n@t.local", role: "NURSE" },
    ]);
    const res = await request(buildApp())
      .get(`/api/v1/departments/${D1}/members/search?q=nur`)
      .set("Authorization", `Bearer ${tok("ADMIN")}`);
    expect(res.status).toBe(200);
    // The already-member userId must be excluded from the candidate query.
    expect(prismaMock.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: { notIn: [U1] } }),
      }),
    );
  });
});

describe("Department detail", () => {
  it("aggregates info + stats + members + requisitions + consumed", async () => {
    prismaMock.department.findUnique.mockResolvedValue({
      id: D1,
      name: "OT",
      code: "OT",
      active: true,
      createdAt: new Date("2026-07-01"),
    });
    prismaMock.departmentMember.findMany.mockResolvedValue([
      { id: "dm1", userId: U1, user: { id: U1, name: "Dr X", email: "x@t.local", role: "DOCTOR" } },
    ]);
    prismaMock.requisition.findMany.mockResolvedValue([
      {
        id: "r1",
        requisitionNumber: "REQ000001",
        status: "COMPLETED",
        createdAt: new Date("2026-07-05"),
        requestedBy: { name: "Dr X" },
        items: [
          { requestedQty: 5, approvedQty: 5, issuedQty: 5, inventoryItem: null, material: { name: "Gloves", unit: "box" } },
        ],
      },
    ]);
    const res = await request(buildApp())
      .get(`/api/v1/departments/${D1}/detail`)
      .set("Authorization", `Bearer ${tok("ADMIN")}`);
    expect(res.status).toBe(200);
    expect(res.body.data.department.name).toBe("OT");
    expect(res.body.data.stats).toMatchObject({
      memberCount: 1,
      totalRequests: 1,
      completedRequests: 1,
      totalUnitsIssued: 5,
    });
    expect(res.body.data.consumed).toEqual([{ name: "Gloves", unit: "box", issued: 5 }]);
  });

  it("allows an assigned NURSE to read their department detail", async () => {
    prismaMock.department.findUnique.mockResolvedValue({
      id: D1,
      name: "OT",
      code: "OT",
      active: true,
      createdAt: new Date("2026-07-01"),
    });
    prismaMock.departmentMember.findFirst.mockResolvedValue({ id: "dm1" });
    prismaMock.departmentMember.findMany.mockResolvedValue([
      { id: "dm1", userId: U1, user: { id: U1, name: "Dr X", email: "x@t.local", role: "DOCTOR" } },
    ]);
    prismaMock.requisition.findMany.mockResolvedValue([]);
    prismaMock.departmentMaterialHolding.findMany.mockResolvedValue([]);

    const res = await request(buildApp())
      .get(`/api/v1/departments/${D1}/detail`)
      .set("Authorization", `Bearer ${tok("NURSE")}`);

    expect(res.status).toBe(200);
    expect(res.body.data.department.name).toBe("OT");
  });

  it("returns No assigned department for unassigned staff detail access", async () => {
    prismaMock.department.findUnique.mockResolvedValue({
      id: D1,
      name: "OT",
      code: "OT",
      active: true,
      createdAt: new Date("2026-07-01"),
    });
    prismaMock.departmentMember.findFirst.mockResolvedValue(null);
    prismaMock.departmentMember.findMany.mockResolvedValue([]);

    const res = await request(buildApp())
      .get(`/api/v1/departments/${D1}/detail`)
      .set("Authorization", `Bearer ${tok("NURSE")}`);

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("No assigned department");
  });

  it("404s for a missing department detail", async () => {
    prismaMock.department.findUnique.mockResolvedValue(null);
    const res = await request(buildApp())
      .get(`/api/v1/departments/${D1}/detail`)
      .set("Authorization", `Bearer ${tok("ADMIN")}`);
    expect(res.status).toBe(404);
  });
});
