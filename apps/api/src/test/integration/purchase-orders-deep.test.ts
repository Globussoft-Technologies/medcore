// Deep branch-coverage tests for purchase-orders router.
import { it, expect, beforeAll } from "vitest";
import request from "supertest";
import { describeIfDB, resetDB, getAuthToken, getPrisma } from "../setup";
import { createMedicineFixture } from "../factories";

let app: any;
let adminToken: string;
let receptionToken: string;
let doctorToken: string;

async function createSupplier() {
  const prisma = await getPrisma();
  return prisma.supplier.create({
    data: {
      name: `Sup-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      phone: "9000000000",
    },
  });
}

async function createDraftPO(items?: any[]) {
  const sup = await createSupplier();
  const med = await createMedicineFixture();
  const res = await request(app)
    .post("/api/v1/purchase-orders")
    .set("Authorization", `Bearer ${adminToken}`)
    .send({
      supplierId: sup.id,
      items: items ?? [
        {
          description: "Paracetamol",
          medicineId: med.id,
          quantity: 100,
          unitPrice: 5,
        },
        { description: "Gloves", quantity: 50, unitPrice: 10 },
      ],
      taxPercentage: 5,
      expectedAt: "2026-12-31",
    });
  return { res, sup, med };
}

async function submitAndApprove(id: string) {
  await request(app)
    .post(`/api/v1/purchase-orders/${id}/submit`)
    .set("Authorization", `Bearer ${adminToken}`)
    .send({});
  await request(app)
    .post(`/api/v1/purchase-orders/${id}/approve`)
    .set("Authorization", `Bearer ${adminToken}`)
    .send({});
}

describeIfDB("Purchase Orders API — DEEP (integration)", () => {
  beforeAll(async () => {
    await resetDB();
    adminToken = await getAuthToken("ADMIN");
    receptionToken = await getAuthToken("RECEPTION");
    doctorToken = await getAuthToken("DOCTOR");
    const mod = await import("../../app");
    app = mod.app;
  });

  it("create PO with multi-item lines, correct subtotal & tax", async () => {
    const { res } = await createDraftPO();
    expect(res.status).toBe(201);
    // subtotal = 100*5 + 50*10 = 1000
    expect(res.body.data.subtotal).toBe(1000);
    // tax @ 5% = 50
    expect(res.body.data.taxAmount).toBe(50);
    expect(res.body.data.totalAmount).toBe(1050);
    expect(res.body.data.items.length).toBe(2);
    expect(res.body.data.status).toBe("DRAFT");
  });

  it("create PO with empty items (400)", async () => {
    const sup = await createSupplier();
    const res = await request(app)
      .post("/api/v1/purchase-orders")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ supplierId: sup.id, items: [] });
    expect(res.status).toBe(400);
  });

  it("create PO 404 unknown supplier", async () => {
    const res = await request(app)
      .post("/api/v1/purchase-orders")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        supplierId: "00000000-0000-0000-0000-000000000000",
        items: [{ description: "X", quantity: 1, unitPrice: 1 }],
      });
    expect(res.status).toBe(404);
  });

  it("DOCTOR forbidden to create PO (403)", async () => {
    const sup = await createSupplier();
    const res = await request(app)
      .post("/api/v1/purchase-orders")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({
        supplierId: sup.id,
        items: [{ description: "X", quantity: 1, unitPrice: 1 }],
      });
    expect(res.status).toBe(403);
  });

  it("full approval workflow DRAFT → PENDING → APPROVED", async () => {
    const { res } = await createDraftPO();
    const id = res.body.data.id;
    const sub = await request(app)
      .post(`/api/v1/purchase-orders/${id}/submit`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});
    expect(sub.status).toBe(200);
    expect(sub.body.data.status).toBe("PENDING");
    const app2 = await request(app)
      .post(`/api/v1/purchase-orders/${id}/approve`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});
    expect(app2.status).toBe(200);
    expect(app2.body.data.status).toBe("APPROVED");
  });

  it("submit fails if not DRAFT (400)", async () => {
    const { res } = await createDraftPO();
    await submitAndApprove(res.body.data.id);
    const again = await request(app)
      .post(`/api/v1/purchase-orders/${res.body.data.id}/submit`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});
    expect(again.status).toBe(400);
  });

  it("approve fails if not PENDING (400)", async () => {
    const { res } = await createDraftPO();
    const approve = await request(app)
      .post(`/api/v1/purchase-orders/${res.body.data.id}/approve`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});
    expect(approve.status).toBe(400);
  });

  it("approve requires ADMIN (403 for RECEPTION)", async () => {
    const { res } = await createDraftPO();
    await request(app)
      .post(`/api/v1/purchase-orders/${res.body.data.id}/submit`)
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({});
    const r = await request(app)
      .post(`/api/v1/purchase-orders/${res.body.data.id}/approve`)
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({});
    expect(r.status).toBe(403);
  });

  it("receive full auto-fills quantities and marks RECEIVED", async () => {
    const { res } = await createDraftPO();
    await submitAndApprove(res.body.data.id);
    const rec = await request(app)
      .post(`/api/v1/purchase-orders/${res.body.data.id}/receive`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});
    expect(rec.status).toBe(200);
    expect(rec.body.data.status).toBe("RECEIVED");
    expect(rec.body.data.receivedAt).toBeTruthy();
  });

  it("partial receive keeps APPROVED; second receive completes", async () => {
    const { res } = await createDraftPO();
    await submitAndApprove(res.body.data.id);
    const po = res.body.data;
    const firstItem = po.items[0];
    const secondItem = po.items[1];

    const r1 = await request(app)
      .post(`/api/v1/purchase-orders/${po.id}/receive`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        receivedItems: [
          { itemId: firstItem.id, receivedQuantity: Math.floor(firstItem.quantity / 2) },
        ],
      });
    expect(r1.status).toBe(200);
    expect(r1.body.data.status).toBe("APPROVED");

    const r2 = await request(app)
      .post(`/api/v1/purchase-orders/${po.id}/receive`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        receivedItems: [
          { itemId: firstItem.id, receivedQuantity: Math.ceil(firstItem.quantity / 2) },
          { itemId: secondItem.id, receivedQuantity: secondItem.quantity },
        ],
      });
    expect(r2.status).toBe(200);
    expect(r2.body.data.status).toBe("RECEIVED");
  });

  it("receive fails when PO not APPROVED (400)", async () => {
    const { res } = await createDraftPO();
    const r = await request(app)
      .post(`/api/v1/purchase-orders/${res.body.data.id}/receive`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});
    expect(r.status).toBe(400);
  });

  it("receive 404 unknown PO", async () => {
    const r = await request(app)
      .post("/api/v1/purchase-orders/00000000-0000-0000-0000-000000000000/receive")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});
    expect(r.status).toBe(404);
  });

  it("PATCH items allowed only on DRAFT (400 after approve)", async () => {
    const { res } = await createDraftPO();
    await submitAndApprove(res.body.data.id);
    const upd = await request(app)
      .patch(`/api/v1/purchase-orders/${res.body.data.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        items: [{ description: "Z", quantity: 1, unitPrice: 1 }],
      });
    expect(upd.status).toBe(400);
  });

  it("PATCH DRAFT recomputes totals", async () => {
    const { res } = await createDraftPO();
    const upd = await request(app)
      .patch(`/api/v1/purchase-orders/${res.body.data.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        items: [{ description: "Y", quantity: 2, unitPrice: 100 }],
        taxPercentage: 10,
      });
    expect(upd.status).toBe(200);
    expect(upd.body.data.subtotal).toBe(200);
    expect(upd.body.data.taxAmount).toBe(20);
    expect(upd.body.data.totalAmount).toBe(220);
  });

  it("cancel DRAFT PO", async () => {
    const { res } = await createDraftPO();
    const r = await request(app)
      .post(`/api/v1/purchase-orders/${res.body.data.id}/cancel`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});
    expect(r.status).toBe(200);
    expect(r.body.data.status).toBe("CANCELLED");
  });

  it("cancel RECEIVED → 400", async () => {
    const { res } = await createDraftPO();
    await submitAndApprove(res.body.data.id);
    await request(app)
      .post(`/api/v1/purchase-orders/${res.body.data.id}/receive`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});
    const cancel = await request(app)
      .post(`/api/v1/purchase-orders/${res.body.data.id}/cancel`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});
    expect(cancel.status).toBe(400);
  });

  it("cancel requires ADMIN (403 for RECEPTION)", async () => {
    const { res } = await createDraftPO();
    const r = await request(app)
      .post(`/api/v1/purchase-orders/${res.body.data.id}/cancel`)
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({});
    expect(r.status).toBe(403);
  });

  it("GET /:id 404 unknown", async () => {
    const r = await request(app)
      .get("/api/v1/purchase-orders/00000000-0000-0000-0000-000000000000")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(r.status).toBe(404);
  });

  it("GET / with status filter", async () => {
    const { res } = await createDraftPO();
    const r = await request(app)
      .get("/api/v1/purchase-orders?status=DRAFT&limit=10")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(r.status).toBe(200);
    expect(r.body.data.some((p: any) => p.id === res.body.data.id)).toBe(true);
  });

  it("GRN create rejects qty over ordered (400)", async () => {
    const { res } = await createDraftPO();
    await submitAndApprove(res.body.data.id);
    const firstItem = res.body.data.items[0];
    const grn = await request(app)
      .post(`/api/v1/purchase-orders/${res.body.data.id}/grns`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        items: [
          { poItemId: firstItem.id, quantity: firstItem.quantity + 100 },
        ],
      });
    expect(grn.status).toBe(400);
  });

  it("GRN create on DRAFT PO (400)", async () => {
    const { res } = await createDraftPO();
    const firstItem = res.body.data.items[0];
    const grn = await request(app)
      .post(`/api/v1/purchase-orders/${res.body.data.id}/grns`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        items: [{ poItemId: firstItem.id, quantity: 1 }],
      });
    expect(grn.status).toBe(400);
  });

  it("GRN partial receipt succeeds and lists via GET", async () => {
    const { res } = await createDraftPO();
    await submitAndApprove(res.body.data.id);
    const firstItem = res.body.data.items[0];
    const grn = await request(app)
      .post(`/api/v1/purchase-orders/${res.body.data.id}/grns`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        items: [{ poItemId: firstItem.id, quantity: 10 }],
      });
    expect(grn.status).toBe(201);
    const list = await request(app)
      .get(`/api/v1/purchase-orders/${res.body.data.id}/grns`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(list.status).toBe(200);
    expect(list.body.data.length).toBeGreaterThanOrEqual(1);
  });

  it("invoice record with variance calculation", async () => {
    const { res } = await createDraftPO();
    const inv = await request(app)
      .patch(`/api/v1/purchase-orders/${res.body.data.id}/invoice`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ invoiceAmount: 1100, invoiceNumber: "INV-001" });
    expect(inv.status).toBe(200);
    expect(inv.body.data.variance).toBe(50); // 1100 - 1050
  });

  it("invoice missing fields (400)", async () => {
    const { res } = await createDraftPO();
    const inv = await request(app)
      .patch(`/api/v1/purchase-orders/${res.body.data.id}/invoice`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});
    expect(inv.status).toBe(400);
  });

  it("regenerate-recurring on non-recurring PO (400)", async () => {
    const { res } = await createDraftPO();
    const r = await request(app)
      .post(`/api/v1/purchase-orders/${res.body.data.id}/regenerate-recurring`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});
    expect(r.status).toBe(400);
  });

  it("regenerate-recurring on recurring PO produces new DRAFT", async () => {
    const sup = await createSupplier();
    const parent = await request(app)
      .post("/api/v1/purchase-orders")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        supplierId: sup.id,
        items: [{ description: "Monthly", quantity: 1, unitPrice: 50 }],
        isRecurring: true,
        recurringFrequency: "MONTHLY",
      });
    const r = await request(app)
      .post(`/api/v1/purchase-orders/${parent.body.data.id}/regenerate-recurring`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});
    expect(r.status).toBe(201);
    expect(r.body.data.status).toBe("DRAFT");
    expect(r.body.data.parentPoId).toBe(parent.body.data.id);
  });

  it("variance report ADMIN-only (403 for DOCTOR)", async () => {
    const r = await request(app)
      .get("/api/v1/purchase-orders/reports/variance")
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(r.status).toBe(403);
  });

  it("tax percentage default 0 when omitted", async () => {
    const sup = await createSupplier();
    const r = await request(app)
      .post("/api/v1/purchase-orders")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        supplierId: sup.id,
        items: [{ description: "X", quantity: 2, unitPrice: 50 }],
      });
    expect(r.status).toBe(201);
    expect(r.body.data.taxAmount).toBe(0);
    expect(r.body.data.totalAmount).toBe(100);
  });
});
