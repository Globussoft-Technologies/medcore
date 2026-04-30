// Integration tests for the purchase-orders router.
import { it, expect, beforeAll } from "vitest";
import request from "supertest";
import { describeIfDB, resetDB, getAuthToken, getPrisma } from "../setup";
import { createMedicineFixture } from "../factories";

let app: any;
let adminToken: string;
let patientToken: string;
let receptionToken: string;

async function createSupplier(overrides: Record<string, any> = {}) {
  const prisma = await getPrisma();
  return prisma.supplier.create({
    data: {
      name: overrides.name || `SupTest-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      isActive: overrides.isActive ?? true,
      outstandingAmount: overrides.outstandingAmount ?? 0,
    },
  });
}

async function createDraftPO(token: string, supplierId: string, medicineId?: string) {
  const res = await request(app)
    .post("/api/v1/purchase-orders")
    .set("Authorization", `Bearer ${token}`)
    .send({
      supplierId,
      items: [
        {
          description: "Paracetamol 500mg",
          medicineId,
          quantity: 100,
          unitPrice: 2,
        },
      ],
      taxPercentage: 18,
    });
  return res;
}

describeIfDB("Purchase Orders API (integration)", () => {
  beforeAll(async () => {
    await resetDB();
    adminToken = await getAuthToken("ADMIN");
    patientToken = await getAuthToken("PATIENT");
    receptionToken = await getAuthToken("RECEPTION");
    const mod = await import("../../app");
    app = mod.app;
  });

  it("401 without token", async () => {
    const res = await request(app).get("/api/v1/purchase-orders");
    expect(res.status).toBe(401);
  });

  it("creates a DRAFT PO (ADMIN)", async () => {
    const supplier = await createSupplier();
    const res = await createDraftPO(adminToken, supplier.id);
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.status).toBe("DRAFT");
    expect(res.body.data?.poNumber).toMatch(/^PO/);
    expect(res.body.data?.subtotal).toBe(200);
    expect(res.body.data?.taxAmount).toBeCloseTo(36, 1);
    expect(res.body.data?.totalAmount).toBeCloseTo(236, 1);
  });

  it("rejects PO with no items (400)", async () => {
    const supplier = await createSupplier();
    const res = await request(app)
      .post("/api/v1/purchase-orders")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ supplierId: supplier.id, items: [] });
    expect(res.status).toBe(400);
  });

  it("returns 404 for unknown supplier on create", async () => {
    const res = await request(app)
      .post("/api/v1/purchase-orders")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        supplierId: "00000000-0000-0000-0000-000000000000",
        items: [
          { description: "X", quantity: 1, unitPrice: 10 },
        ],
      });
    expect(res.status).toBe(404);
  });

  it("rejects PATIENT from creating PO (403)", async () => {
    const supplier = await createSupplier();
    const res = await request(app)
      .post("/api/v1/purchase-orders")
      .set("Authorization", `Bearer ${patientToken}`)
      .send({
        supplierId: supplier.id,
        items: [{ description: "X", quantity: 1, unitPrice: 10 }],
      });
    expect(res.status).toBe(403);
  });

  it("DRAFT -> PENDING via /submit", async () => {
    const supplier = await createSupplier();
    const created = await createDraftPO(adminToken, supplier.id);
    const res = await request(app)
      .post(`/api/v1/purchase-orders/${created.body.data.id}/submit`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.status).toBe("PENDING");
  });

  it("cannot submit a non-DRAFT PO (400)", async () => {
    const supplier = await createSupplier();
    const created = await createDraftPO(adminToken, supplier.id);
    await request(app)
      .post(`/api/v1/purchase-orders/${created.body.data.id}/submit`)
      .set("Authorization", `Bearer ${adminToken}`);
    const res = await request(app)
      .post(`/api/v1/purchase-orders/${created.body.data.id}/submit`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(400);
  });

  it("ADMIN approves PENDING -> APPROVED", async () => {
    const supplier = await createSupplier();
    const created = await createDraftPO(adminToken, supplier.id);
    await request(app)
      .post(`/api/v1/purchase-orders/${created.body.data.id}/submit`)
      .set("Authorization", `Bearer ${adminToken}`);
    const res = await request(app)
      .post(`/api/v1/purchase-orders/${created.body.data.id}/approve`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.status).toBe("APPROVED");
  });

  it("cannot approve a DRAFT PO (400)", async () => {
    const supplier = await createSupplier();
    const created = await createDraftPO(adminToken, supplier.id);
    const res = await request(app)
      .post(`/api/v1/purchase-orders/${created.body.data.id}/approve`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});
    expect(res.status).toBe(400);
  });

  it("cannot approve PO twice (business rule)", async () => {
    const supplier = await createSupplier();
    const created = await createDraftPO(adminToken, supplier.id);
    await request(app)
      .post(`/api/v1/purchase-orders/${created.body.data.id}/submit`)
      .set("Authorization", `Bearer ${adminToken}`);
    await request(app)
      .post(`/api/v1/purchase-orders/${created.body.data.id}/approve`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});
    const res = await request(app)
      .post(`/api/v1/purchase-orders/${created.body.data.id}/approve`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});
    expect(res.status).toBe(400);
  });

  it("receive flips to RECEIVED and creates inventory for medicine items (side-effect)", async () => {
    const supplier = await createSupplier();
    const med = await createMedicineFixture();
    const created = await createDraftPO(adminToken, supplier.id, med.id);
    await request(app)
      .post(`/api/v1/purchase-orders/${created.body.data.id}/submit`)
      .set("Authorization", `Bearer ${adminToken}`);
    await request(app)
      .post(`/api/v1/purchase-orders/${created.body.data.id}/approve`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});
    const res = await request(app)
      .post(`/api/v1/purchase-orders/${created.body.data.id}/receive`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ notes: "Full receipt" });
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.status).toBe("RECEIVED");
    const prisma = await getPrisma();
    const inv = await prisma.inventoryItem.findMany({
      where: { medicineId: med.id },
    });
    expect(inv.length).toBeGreaterThan(0);
  });

  it("lists POs with filter by status", async () => {
    const res = await request(app)
      .get("/api/v1/purchase-orders?status=RECEIVED")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    for (const row of res.body.data) {
      expect(row.status).toBe("RECEIVED");
    }
  });
});
