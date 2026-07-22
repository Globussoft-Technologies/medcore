/**
 * Material catalog module (2026-07) — CRUD + RBAC + guards unit tests.
 *
 * What / which / why:
 *   - Pins the materials API (routes/materials.ts): store-role gating,
 *     the duplicate-NAME and duplicate-SKU 409s on create/update, the
 *     adjust-stock guard (can't drop on-hand below reserved), and the delete
 *     policy (soft-delete when it has requisition history, else hard-delete).
 *   - Mocked Prisma (no DB), same hoisted-mock style as departments.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { ZodError } from "zod";

const { prismaMock } = vi.hoisted(() => {
  const base: any = {
    material: {
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(async () => null),
      findFirst: vi.fn(async () => null),
      create: vi.fn(async () => ({ id: "m1" })),
      update: vi.fn(async () => ({})),
      delete: vi.fn(async () => ({})),
    },
    materialMovement: { create: vi.fn(async () => ({})), deleteMany: vi.fn(async () => ({ count: 0 })) },
    departmentMember: { findMany: vi.fn(async () => []) },
    auditLog: { create: vi.fn(async () => ({ id: "al" })) },
    $transaction: vi.fn(async (fn: any) => fn(base)),
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

import { materialsRouter } from "./materials";

function buildApp() {
  process.env.JWT_SECRET = "test-secret";
  const app = express();
  app.use(express.json());
  app.use("/api/v1/materials", materialsRouter);
  app.use((err: any, _req: any, res: any, _next: any) => {
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

const M1 = "2c9b0a1e-7d3f-4a6b-9c2e-1f5a6b7c8d9e";

beforeEach(() => {
  Object.values(prismaMock).forEach((m: any) => {
    if (m && typeof m === "object") {
      Object.values(m).forEach((fn: any) => fn?.mockReset?.());
    }
  });
  prismaMock.$transaction.mockImplementation(async (fn: any) => fn(prismaMock));
  prismaMock.auditLog.create.mockResolvedValue({ id: "al" });
  prismaMock.departmentMember.findMany.mockResolvedValue([{ departmentId: "d1" }]);
});

describe("Material RBAC", () => {
  it("read roles (NURSE) can list; PATIENT cannot", async () => {
    prismaMock.material.findMany.mockResolvedValue([]);
    const ok = await request(buildApp())
      .get("/api/v1/materials")
      .set("Authorization", `Bearer ${tok("NURSE")}`);
    expect(ok.status).toBe(200);

    const denied = await request(buildApp())
      .get("/api/v1/materials")
      .set("Authorization", `Bearer ${tok("PATIENT")}`);
    expect(denied.status).toBe(403);
  });

  it("non-store roles cannot create — NURSE gets 403", async () => {
    const res = await request(buildApp())
      .post("/api/v1/materials")
      .set("Authorization", `Bearer ${tok("NURSE")}`)
      .send({ name: "Gloves", category: "CONSUMABLE", unit: "box" });
    expect(res.status).toBe(403);
    expect(prismaMock.material.create).not.toHaveBeenCalled();
  });

  it("requisition picker shows central-store stock to department roles", async () => {
    prismaMock.material.findMany.mockResolvedValue([
      {
        id: M1,
        name: "Surgical gloves",
        category: "CONSUMABLE",
        unit: "box",
        quantity: 100,
        reservedStock: 10,
        active: true,
        departmentHoldings: [],
      },
    ]);

    const res = await request(buildApp())
      .get("/api/v1/materials?active=true&forRequisition=true")
      .set("Authorization", `Bearer ${tok("NURSE")}`);

    expect(res.status).toBe(200);
    expect(prismaMock.material.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.not.objectContaining({
          departmentHoldings: expect.anything(),
        }),
      }),
    );
    expect(res.body.data[0]).toEqual(
      expect.objectContaining({
        id: M1,
        mainQuantity: 100,
        totalQuantity: 100,
      }),
    );
  });
});

describe("Material create", () => {
  it("creates a material and writes an opening-stock movement", async () => {
    prismaMock.material.findFirst.mockResolvedValue(null); // no name/sku clash
    prismaMock.material.create.mockResolvedValue({ id: M1, name: "Gloves", quantity: 50 });
    const res = await request(buildApp())
      .post("/api/v1/materials")
      .set("Authorization", `Bearer ${tok("PHARMACIST")}`)
      .send({ name: "Gloves", category: "CONSUMABLE", unit: "box", quantity: 50, reorderLevel: 10 });
    expect(res.status).toBe(201);
    expect(prismaMock.materialMovement.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ type: "PURCHASE", quantity: 50 }) }),
    );
  });

  it("rejects a duplicate NAME with 409", async () => {
    prismaMock.material.findFirst.mockResolvedValue({ id: "existing" }); // name clash
    const res = await request(buildApp())
      .post("/api/v1/materials")
      .set("Authorization", `Bearer ${tok("ADMIN")}`)
      .send({ name: "ors", category: "CONSUMABLE", unit: "unit", quantity: 1, reorderLevel: 1 });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already exists/i);
    expect(prismaMock.material.create).not.toHaveBeenCalled();
  });

  it("rejects an invalid category with 400", async () => {
    const res = await request(buildApp())
      .post("/api/v1/materials")
      .set("Authorization", `Bearer ${tok("ADMIN")}`)
      .send({ name: "Thing", category: "NONSENSE", unit: "unit" });
    expect(res.status).toBe(400);
  });
});

describe("Material update", () => {
  it("blocks renaming to a name another material uses (409)", async () => {
    prismaMock.material.findUnique.mockResolvedValue({ id: M1 });
    prismaMock.material.findFirst.mockResolvedValue({ id: "other" }); // name clash
    const res = await request(buildApp())
      .patch(`/api/v1/materials/${M1}`)
      .set("Authorization", `Bearer ${tok("ADMIN")}`)
      .send({ name: "Gloves" });
    expect(res.status).toBe(409);
    expect(prismaMock.material.update).not.toHaveBeenCalled();
  });

  it("404s when updating a missing material", async () => {
    prismaMock.material.findUnique.mockResolvedValue(null);
    const res = await request(buildApp())
      .patch(`/api/v1/materials/${M1}`)
      .set("Authorization", `Bearer ${tok("ADMIN")}`)
      .send({ name: "Whatever" });
    expect(res.status).toBe(404);
  });
});

describe("Material adjust-stock", () => {
  it("adds stock and writes a movement", async () => {
    prismaMock.material.findUnique.mockResolvedValue({ id: M1, quantity: 10, reservedStock: 0 });
    prismaMock.material.update.mockResolvedValue({ id: M1, quantity: 15 });
    const res = await request(buildApp())
      .post(`/api/v1/materials/${M1}/adjust-stock`)
      .set("Authorization", `Bearer ${tok("PHARMACIST")}`)
      .send({ delta: 5, reasonCode: "FOUND" });
    expect(res.status).toBe(200);
    expect(prismaMock.material.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: M1 }, data: { quantity: { increment: 5 } } }),
    );
    expect(prismaMock.materialMovement.create).toHaveBeenCalled();
  });

  it("rejects a reduction that would drop on-hand below reserved (409)", async () => {
    prismaMock.material.findUnique.mockResolvedValue({ id: M1, quantity: 10, reservedStock: 8 });
    const res = await request(buildApp())
      .post(`/api/v1/materials/${M1}/adjust-stock`)
      .set("Authorization", `Bearer ${tok("PHARMACIST")}`)
      .send({ delta: -5, reasonCode: "CORRECTION" }); // 10 - 5 = 5 < reserved 8
    expect(res.status).toBe(409);
    expect(prismaMock.material.update).not.toHaveBeenCalled();
  });
});

describe("Material delete policy", () => {
  it("soft-deletes a material that has requisition history", async () => {
    prismaMock.material.findUnique.mockResolvedValue({
      id: M1,
      name: "Gloves",
      _count: { requisitionItems: 2 },
    });
    prismaMock.material.update.mockResolvedValue({ id: M1, active: false });
    const res = await request(buildApp())
      .delete(`/api/v1/materials/${M1}`)
      .set("Authorization", `Bearer ${tok("ADMIN")}`);
    expect(res.status).toBe(200);
    expect(res.body.data.softDeleted).toBe(true);
    expect(prismaMock.material.delete).not.toHaveBeenCalled();
  });

  it("hard-deletes a material with no requisition history", async () => {
    prismaMock.material.findUnique.mockResolvedValue({
      id: M1,
      name: "Unused",
      _count: { requisitionItems: 0 },
    });
    prismaMock.material.delete.mockResolvedValue({ id: M1 });
    const res = await request(buildApp())
      .delete(`/api/v1/materials/${M1}`)
      .set("Authorization", `Bearer ${tok("ADMIN")}`);
    expect(res.status).toBe(200);
    expect(res.body.data.hardDeleted).toBe(true);
    expect(prismaMock.material.delete).toHaveBeenCalledWith({ where: { id: M1 } });
  });
});
