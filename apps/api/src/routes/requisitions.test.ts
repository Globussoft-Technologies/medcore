/**
 * Requisition module (2026-07) — workflow + RBAC + stock-guard unit tests.
 *
 * What / which / why:
 *   - Pins the store↔department requisition API (routes/requisitions.ts):
 *     role gating per workflow step, the approve-time stock-availability guard
 *     (can't reserve more than quantity - reservedStock), and the status-guard
 *     transitions (can't approve a non-SUBMITTED, can't issue a non-approved).
 *   - Mocked Prisma (no DB), same hoisted-mock style as
 *     analytics-departments.test.ts / analytics-overview.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { ZodError } from "zod";

const { prismaMock } = vi.hoisted(() => {
  const base: any = {
    department: { findMany: vi.fn(async () => []), findUnique: vi.fn(async () => null) },
    inventoryItem: { findMany: vi.fn(async () => []), update: vi.fn(async () => ({})) },
    material: { findMany: vi.fn(async () => []), update: vi.fn(async () => ({})) },
    materialMovement: { create: vi.fn(async () => ({})) },
    departmentMember: {
      findMany: vi.fn(async () => []),
      findFirst: vi.fn(async () => null),
    },
    requisition: {
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(async () => null),
      count: vi.fn(async () => 0),
      create: vi.fn(async () => ({ id: "r1" })),
      update: vi.fn(async () => ({})),
    },
    requisitionItem: { update: vi.fn(async () => ({})) },
    stockMovement: { create: vi.fn(async () => ({})) },
    systemConfig: { findUnique: vi.fn(async () => null), upsert: vi.fn(async () => ({})) },
    auditLog: { create: vi.fn(async () => ({ id: "al" })) },
    // $transaction runs the callback with the same mock as `tx`.
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

import { requisitionsRouter } from "./requisitions";

function buildApp() {
  process.env.JWT_SECRET = "test-secret";
  const app = express();
  app.use(express.json());
  app.use("/api/v1/requisitions", requisitionsRouter);
  // Surface handler errors as JSON so tests see the real cause, not a bare 500.
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

// Valid v4 UUIDs — the Zod schemas require itemId/inventoryItemId/departmentId
// to be UUIDs, so payloads must use real ones or `validate` 400s first.
const LI1 = "51a45df7-934e-41eb-a62d-71ecfe94567a";
const INV1 = "80b8246b-9ef1-4a0c-a003-2d9a2749b328";
const R1 = "65b19656-44e2-4621-a95b-0065b148f6ab";
const D1 = "d93c8b27-4f78-4ee1-a7ac-298b5b4eb09d";
const MAT1 = "2c9b0a1e-7d3f-4a6b-9c2e-1f5a6b7c8d9e"; // a Material id
const LI2 = "3d8c1b2f-8e4a-4b7c-8d3f-2a6b7c8d9e0f"; // a material-line RequisitionItem id

beforeEach(() => {
  Object.values(prismaMock).forEach((m: any) => {
    if (m && typeof m === "object") {
      Object.values(m).forEach((fn: any) => fn?.mockReset?.());
    }
  });
  prismaMock.$transaction.mockImplementation(async (fn: any) => fn(prismaMock));
  prismaMock.auditLog.create.mockResolvedValue({ id: "al" });
  prismaMock.systemConfig.upsert.mockResolvedValue({});
  // Department scoping (2026-07): the JWT fixture user "u1" is a member of D1,
  // so scoped roles (NURSE/DOCTOR/RECEPTION/PHARMACIST) pass the membership gate
  // for the D1 fixtures used throughout this suite. ADMIN is unscoped regardless.
  // Tests that assert the *denial* path override this mock explicitly.
  prismaMock.departmentMember.findMany.mockResolvedValue([{ departmentId: D1 }]);
  prismaMock.departmentMember.findFirst.mockResolvedValue({ id: "dm1" });
});

describe("Requisition RBAC", () => {
  it("department staff (NURSE) can list; PATIENT cannot", async () => {
    prismaMock.requisition.findMany.mockResolvedValue([]);
    prismaMock.requisition.count.mockResolvedValue(0);
    const ok = await request(buildApp())
      .get("/api/v1/requisitions")
      .set("Authorization", `Bearer ${tok("NURSE")}`);
    expect(ok.status).toBe(200);

    const denied = await request(buildApp())
      .get("/api/v1/requisitions")
      .set("Authorization", `Bearer ${tok("PATIENT")}`);
    expect(denied.status).toBe(403);
  });

  it("only store roles (PHARMACIST/ADMIN) can approve — NURSE gets 403", async () => {
    const res = await request(buildApp())
      .post("/api/v1/requisitions/r1/approve")
      .set("Authorization", `Bearer ${tok("NURSE")}`)
      .send({ items: [{ itemId: LI1, approvedQty: 1 }] });
    expect(res.status).toBe(403);
  });

  it("only department roles can create — PHARMACIST gets 403", async () => {
    const res = await request(buildApp())
      .post("/api/v1/requisitions")
      .set("Authorization", `Bearer ${tok("PHARMACIST")}`)
      .send({ departmentId: D1, items: [{ inventoryItemId: INV1, requestedQty: 1 }] });
    expect(res.status).toBe(403);
  });
});

// ── Department scoping (2026-07) — a non-admin staff member only sees and acts
// on departments they are a MEMBER of. A member of A must not see or raise
// requisitions against B; a staff member in no department sees nothing. ADMIN
// is the sole unscoped role.
describe("Requisition department scoping", () => {
  const D2 = "a1b2c3d4-e5f6-4789-a012-3456789abcde"; // a department u1 is NOT in

  it("picker returns only the caller's departments (NURSE member of D1)", async () => {
    prismaMock.departmentMember.findMany.mockResolvedValue([{ departmentId: D1 }]);
    prismaMock.department.findMany.mockResolvedValue([
      { id: D1, name: "Ward A", code: "WA" },
    ]);
    const res = await request(buildApp())
      .get("/api/v1/requisitions/departments")
      .set("Authorization", `Bearer ${tok("NURSE")}`);
    expect(res.status).toBe(200);
    // department.findMany was scoped to the allowed ids.
    expect(prismaMock.department.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: { in: [D1] } }),
      }),
    );
    expect(res.body.data).toEqual([
      { id: D1, name: "Ward A", code: "WA", isMine: true },
    ]);
  });

  it("picker returns empty + notInAnyDepartment when the caller has no memberships", async () => {
    prismaMock.departmentMember.findMany.mockResolvedValue([]);
    const res = await request(buildApp())
      .get("/api/v1/requisitions/departments")
      .set("Authorization", `Bearer ${tok("NURSE")}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(res.body.meta?.notInAnyDepartment).toBe(true);
    // Never queried departments at all — short-circuited.
    expect(prismaMock.department.findMany).not.toHaveBeenCalled();
  });

  it("ADMIN picker is unscoped (sees all departments)", async () => {
    prismaMock.department.findMany.mockResolvedValue([
      { id: D1, name: "Ward A", code: "WA" },
      { id: D2, name: "Ward B", code: "WB" },
    ]);
    const res = await request(buildApp())
      .get("/api/v1/requisitions/departments")
      .set("Authorization", `Bearer ${tok("ADMIN")}`);
    expect(res.status).toBe(200);
    // No id filter for admin.
    const call = (prismaMock.department.findMany as any).mock.calls[0][0];
    expect(call.where.id).toBeUndefined();
    expect(res.body.data.length).toBe(2);
  });

  it("create against a department the caller is NOT a member of → 403", async () => {
    prismaMock.departmentMember.findFirst.mockResolvedValue(null); // not a member
    prismaMock.department.findUnique.mockResolvedValue({ id: D2 });
    const res = await request(buildApp())
      .post("/api/v1/requisitions")
      .set("Authorization", `Bearer ${tok("NURSE")}`)
      .send({ departmentId: D2, items: [{ inventoryItemId: INV1, requestedQty: 1 }] });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/department you belong to/i);
    expect(prismaMock.requisition.create).not.toHaveBeenCalled();
  });

  it("list scopes the where clause to the caller's departments", async () => {
    prismaMock.departmentMember.findMany.mockResolvedValue([{ departmentId: D1 }]);
    prismaMock.requisition.findMany.mockResolvedValue([]);
    prismaMock.requisition.count.mockResolvedValue(0);
    const res = await request(buildApp())
      .get("/api/v1/requisitions")
      .set("Authorization", `Bearer ${tok("NURSE")}`);
    expect(res.status).toBe(200);
    expect(prismaMock.requisition.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ departmentId: { in: [D1] } }),
      }),
    );
  });

  it("reading a requisition from another department → 404 (no leak)", async () => {
    prismaMock.departmentMember.findFirst.mockResolvedValue(null); // not a member of its dept
    prismaMock.requisition.findUnique.mockResolvedValue({
      id: "r1",
      departmentId: D2,
      items: [],
    });
    const res = await request(buildApp())
      .get(`/api/v1/requisitions/${R1}`)
      .set("Authorization", `Bearer ${tok("NURSE")}`);
    expect(res.status).toBe(404);
  });

  it("approving a requisition from another department → 404", async () => {
    prismaMock.departmentMember.findFirst.mockResolvedValue(null);
    prismaMock.requisition.findUnique.mockResolvedValue({
      id: "r1",
      status: "SUBMITTED",
      departmentId: D2,
      items: [],
    });
    const res = await request(buildApp())
      .post("/api/v1/requisitions/r1/approve")
      .set("Authorization", `Bearer ${tok("PHARMACIST")}`)
      .send({ items: [{ itemId: LI1, approvedQty: 1 }] });
    expect(res.status).toBe(404);
  });
});

describe("Requisition approve — stock guard + status machine", () => {
  it("rejects approval when approvedQty exceeds available (quantity - reservedStock)", async () => {
    prismaMock.requisition.findUnique.mockResolvedValue({
      id: "r1",
      requisitionNumber: "REQ000001",
      status: "SUBMITTED",
      departmentId: D1,
      items: [
        {
          id: LI1,
          requestedQty: 20,
          approvedQty: 0,
          issuedQty: 0,
          inventoryItemId: INV1,
          inventoryItem: { id: INV1, batchNumber: "B1", quantity: 10, reservedStock: 5 }, // available = 5
        },
      ],
    });
    const res = await request(buildApp())
      .post("/api/v1/requisitions/r1/approve")
      .set("Authorization", `Bearer ${tok("ADMIN")}`)
      .send({ items: [{ itemId: LI1, approvedQty: 8 }] }); // 8 > available 5
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/insufficient stock/i);
    // No reservation written.
    expect(prismaMock.inventoryItem.update).not.toHaveBeenCalled();
  });

  it("approves within available stock and reserves the approved qty", async () => {
    prismaMock.requisition.findUnique
      .mockResolvedValueOnce({
        id: "r1",
        requisitionNumber: "REQ000001",
        status: "SUBMITTED",
        departmentId: D1,
        items: [
          {
            id: LI1,
            requestedQty: 5,
            approvedQty: 0,
            issuedQty: 0,
            inventoryItemId: INV1,
            inventoryItem: { id: INV1, batchNumber: "B1", quantity: 100, reservedStock: 0 },
          },
        ],
      })
      // second findUnique = the reload for the response
      .mockResolvedValueOnce({ id: "r1", status: "APPROVED", items: [] });

    const res = await request(buildApp())
      .post("/api/v1/requisitions/r1/approve")
      .set("Authorization", `Bearer ${tok("ADMIN")}`)
      .send({ items: [{ itemId: LI1, approvedQty: 5 }] });
    expect(res.status).toBe(200);
    // Reserved exactly 5 on the inventory item.
    expect(prismaMock.inventoryItem.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: INV1 },
        data: { reservedStock: { increment: 5 } },
      }),
    );
  });

  it("cannot approve a requisition that is not SUBMITTED/PENDING (409)", async () => {
    prismaMock.requisition.findUnique.mockResolvedValue({
      id: "r1",
      status: "COMPLETED",
      items: [],
    });
    const res = await request(buildApp())
      .post("/api/v1/requisitions/r1/approve")
      .set("Authorization", `Bearer ${tok("ADMIN")}`)
      .send({ items: [{ itemId: LI1, approvedQty: 1 }] });
    expect(res.status).toBe(409);
  });
});

describe("Requisition issue — deducts stock + writes ISSUE movement", () => {
  it("issuing deducts on-hand + reserved and writes a negative ISSUE StockMovement", async () => {
    prismaMock.requisition.findUnique
      .mockResolvedValueOnce({
        id: "r1",
        requisitionNumber: "REQ000001",
        status: "APPROVED",
        departmentId: D1,
        items: [
          {
            id: LI1,
            requestedQty: 5,
            approvedQty: 5,
            issuedQty: 0,
            inventoryItemId: INV1,
            inventoryItem: { id: INV1, batchNumber: "B1", quantity: 100, reservedStock: 5 },
          },
        ],
      })
      .mockResolvedValueOnce({ id: "r1", status: "ISSUED", items: [] });

    const res = await request(buildApp())
      .post("/api/v1/requisitions/r1/issue")
      .set("Authorization", `Bearer ${tok("PHARMACIST")}`)
      .send({ items: [{ itemId: LI1, issuedQty: 5 }] });

    expect(res.status).toBe(200);
    expect(prismaMock.inventoryItem.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: INV1 },
        data: { quantity: { decrement: 5 }, reservedStock: { decrement: 5 } },
      }),
    );
    expect(prismaMock.stockMovement.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ type: "ISSUE", quantity: -5, referenceId: "r1" }),
      }),
    );
  });

  it("cannot issue more than the remaining approved qty (400)", async () => {
    prismaMock.requisition.findUnique.mockResolvedValue({
      id: "r1",
      status: "APPROVED",
      departmentId: D1,
      requisitionNumber: "REQ000001",
      items: [
        {
          id: LI1,
          requestedQty: 5,
          approvedQty: 3,
          issuedQty: 0,
          inventoryItemId: INV1,
          inventoryItem: { id: INV1, batchNumber: "B1", quantity: 100, reservedStock: 3 },
        },
      ],
    });
    const res = await request(buildApp())
      .post("/api/v1/requisitions/r1/issue")
      .set("Authorization", `Bearer ${tok("PHARMACIST")}`)
      .send({ items: [{ itemId: LI1, issuedQty: 5 }] }); // 5 > approved 3
    expect(res.status).toBe(400);
    expect(prismaMock.stockMovement.create).not.toHaveBeenCalled();
  });
});

// ── Material-source lines (2026-07) — a requisition line can point at a
// Material instead of a pharmacy InventoryItem. Approve reserves on the
// Material row; issue deducts it and writes a MaterialMovement (not a
// StockMovement).
describe("Requisition — material-source lines", () => {
  it("creates a requisition with a material line", async () => {
    prismaMock.department.findUnique.mockResolvedValue({ id: D1 });
    prismaMock.material.findMany.mockResolvedValue([{ id: MAT1 }]);
    prismaMock.requisition.create.mockResolvedValue({ id: "r1", items: [] });

    const res = await request(buildApp())
      .post("/api/v1/requisitions")
      .set("Authorization", `Bearer ${tok("NURSE")}`)
      .send({ departmentId: D1, items: [{ materialId: MAT1, requestedQty: 3 }] });

    expect(res.status).toBe(201);
    // The line persisted with materialId (not inventoryItemId).
    expect(prismaMock.requisition.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          items: {
            create: [
              expect.objectContaining({ materialId: MAT1, inventoryItemId: null, requestedQty: 3 }),
            ],
          },
        }),
      }),
    );
  });

  it("rejects a line that sets BOTH inventoryItemId and materialId (400)", async () => {
    const res = await request(buildApp())
      .post("/api/v1/requisitions")
      .set("Authorization", `Bearer ${tok("NURSE")}`)
      .send({
        departmentId: D1,
        items: [{ inventoryItemId: INV1, materialId: MAT1, requestedQty: 1 }],
      });
    expect(res.status).toBe(400); // Zod "exactly one" refinement
    expect(prismaMock.requisition.create).not.toHaveBeenCalled();
  });

  it("approve reserves stock on the Material, not on inventory", async () => {
    prismaMock.requisition.findUnique
      .mockResolvedValueOnce({
        id: "r1",
        requisitionNumber: "REQ000001",
        status: "SUBMITTED",
        departmentId: D1,
        items: [
          {
            id: LI2,
            requestedQty: 3,
            approvedQty: 0,
            issuedQty: 0,
            inventoryItemId: null,
            inventoryItem: null,
            materialId: MAT1,
            material: { id: MAT1, name: "Gloves", quantity: 50, reservedStock: 0 },
          },
        ],
      })
      .mockResolvedValueOnce({ id: "r1", status: "APPROVED", items: [] });

    const res = await request(buildApp())
      .post("/api/v1/requisitions/r1/approve")
      .set("Authorization", `Bearer ${tok("ADMIN")}`)
      .send({ items: [{ itemId: LI2, approvedQty: 3 }] });

    expect(res.status).toBe(200);
    expect(prismaMock.material.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: MAT1 },
        data: { reservedStock: { increment: 3 } },
      }),
    );
    // Must NOT touch inventory for a material line.
    expect(prismaMock.inventoryItem.update).not.toHaveBeenCalled();
  });

  it("issue deducts the Material and writes a MaterialMovement", async () => {
    prismaMock.requisition.findUnique
      .mockResolvedValueOnce({
        id: "r1",
        requisitionNumber: "REQ000001",
        status: "APPROVED",
        departmentId: D1,
        items: [
          {
            id: LI2,
            requestedQty: 3,
            approvedQty: 3,
            issuedQty: 0,
            inventoryItemId: null,
            inventoryItem: null,
            materialId: MAT1,
            material: { id: MAT1, name: "Gloves", quantity: 50, reservedStock: 3 },
          },
        ],
      })
      .mockResolvedValueOnce({ id: "r1", status: "ISSUED", items: [] });

    const res = await request(buildApp())
      .post("/api/v1/requisitions/r1/issue")
      .set("Authorization", `Bearer ${tok("PHARMACIST")}`)
      .send({ items: [{ itemId: LI2, issuedQty: 3 }] });

    expect(res.status).toBe(200);
    expect(prismaMock.material.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: MAT1 },
        data: { quantity: { decrement: 3 }, reservedStock: { decrement: 3 } },
      }),
    );
    expect(prismaMock.materialMovement.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ materialId: MAT1, type: "ISSUE", quantity: -3, referenceId: "r1" }),
      }),
    );
    // Inventory ledger untouched for a material line.
    expect(prismaMock.stockMovement.create).not.toHaveBeenCalled();
  });
});

// ── Reject / Receive / Cancel — the rest of the workflow ──────────────────
describe("Requisition reject", () => {
  it("store role rejects a SUBMITTED requisition → REJECTED", async () => {
    prismaMock.requisition.findUnique
      .mockResolvedValueOnce({ id: "r1", requisitionNumber: "REQ000001", status: "SUBMITTED" })
      .mockResolvedValueOnce({ id: "r1", status: "REJECTED", items: [] });
    const res = await request(buildApp())
      .post("/api/v1/requisitions/r1/reject")
      .set("Authorization", `Bearer ${tok("PHARMACIST")}`)
      .send({ remarks: "out of budget" });
    expect(res.status).toBe(200);
    expect(prismaMock.requisition.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "REJECTED" }) }),
    );
  });

  it("cannot reject a requisition that is not SUBMITTED/PENDING (409)", async () => {
    prismaMock.requisition.findUnique.mockResolvedValue({ id: "r1", status: "APPROVED" });
    const res = await request(buildApp())
      .post("/api/v1/requisitions/r1/reject")
      .set("Authorization", `Bearer ${tok("ADMIN")}`)
      .send({ remarks: "too late" });
    expect(res.status).toBe(409);
  });

  it("requires a rejection reason (400)", async () => {
    const res = await request(buildApp())
      .post("/api/v1/requisitions/r1/reject")
      .set("Authorization", `Bearer ${tok("ADMIN")}`)
      .send({}); // no remarks
    expect(res.status).toBe(400);
  });
});

describe("Requisition receive", () => {
  it("department confirms receipt of an ISSUED requisition → COMPLETED", async () => {
    prismaMock.requisition.findUnique
      .mockResolvedValueOnce({
        id: "r1",
        requisitionNumber: "REQ000001",
        status: "ISSUED",
        items: [
          { id: LI1, issuedQty: 5, inventoryItemId: INV1, materialId: null },
        ],
      })
      .mockResolvedValueOnce({ id: "r1", status: "COMPLETED", items: [] });
    const res = await request(buildApp())
      .post("/api/v1/requisitions/r1/receive")
      .set("Authorization", `Bearer ${tok("NURSE")}`)
      .send({});
    expect(res.status).toBe(200);
    // A RECEIVE StockMovement is written for the inventory line.
    expect(prismaMock.stockMovement.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ type: "RECEIVE", quantity: 5 }) }),
    );
  });

  it("cannot receive a requisition that is not ISSUED (409)", async () => {
    prismaMock.requisition.findUnique.mockResolvedValue({ id: "r1", status: "APPROVED", items: [] });
    const res = await request(buildApp())
      .post("/api/v1/requisitions/r1/receive")
      .set("Authorization", `Bearer ${tok("NURSE")}`)
      .send({});
    expect(res.status).toBe(409);
  });
});

describe("Requisition cancel", () => {
  it("releases reservations on BOTH sources when cancelling", async () => {
    prismaMock.requisition.findUnique
      .mockResolvedValueOnce({
        id: "r1",
        requisitionNumber: "REQ000001",
        status: "APPROVED",
        items: [
          { approvedQty: 5, issuedQty: 0, inventoryItemId: INV1, materialId: null },
          { approvedQty: 3, issuedQty: 0, inventoryItemId: null, materialId: MAT1 },
        ],
      })
      .mockResolvedValueOnce({ id: "r1", status: "CANCELLED", items: [] });
    const res = await request(buildApp())
      .post("/api/v1/requisitions/r1/cancel")
      .set("Authorization", `Bearer ${tok("ADMIN")}`)
      .send({});
    expect(res.status).toBe(200);
    // Inventory reservation released for the inventory line...
    expect(prismaMock.inventoryItem.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: INV1 }, data: { reservedStock: { decrement: 5 } } }),
    );
    // ...and the material reservation released for the material line.
    expect(prismaMock.material.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: MAT1 }, data: { reservedStock: { decrement: 3 } } }),
    );
  });

  it("cannot cancel an already-ISSUED requisition (409)", async () => {
    prismaMock.requisition.findUnique.mockResolvedValue({ id: "r1", status: "ISSUED", items: [] });
    const res = await request(buildApp())
      .post("/api/v1/requisitions/r1/cancel")
      .set("Authorization", `Bearer ${tok("ADMIN")}`)
      .send({});
    expect(res.status).toBe(409);
  });
});
