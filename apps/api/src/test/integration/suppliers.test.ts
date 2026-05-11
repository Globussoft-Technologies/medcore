// Integration tests for the suppliers router.
import { it, expect, beforeAll } from "vitest";
import request from "supertest";
import { describeIfDB, resetDB, getAuthToken, getPrisma } from "../setup";

let app: any;
let adminToken: string;
let patientToken: string;
let receptionToken: string;

describeIfDB("Suppliers API (integration)", () => {
  beforeAll(async () => {
    await resetDB();
    adminToken = await getAuthToken("ADMIN");
    patientToken = await getAuthToken("PATIENT");
    receptionToken = await getAuthToken("RECEPTION");
    const mod = await import("../../app");
    app = mod.app;
  });

  it("401 without token", async () => {
    const res = await request(app).get("/api/v1/suppliers");
    expect(res.status).toBe(401);
  });

  it("creates a supplier (ADMIN)", async () => {
    const res = await request(app)
      .post("/api/v1/suppliers")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        name: `MediCorp-${Date.now()}`,
        contactPerson: "Alice",
        phone: "9900000000",
        email: "alice@medicorp.test",
        gstNumber: "22AAAAA0000A1Z5",
      });
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.name).toMatch(/^MediCorp-/);
  });

  it("rejects malformed payload (empty name 400)", async () => {
    const res = await request(app)
      .post("/api/v1/suppliers")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "" });
    expect(res.status).toBe(400);
  });

  it("rejects PATIENT from creating supplier (403)", async () => {
    const res = await request(app)
      .post("/api/v1/suppliers")
      .set("Authorization", `Bearer ${patientToken}`)
      .send({ name: "Foo" });
    expect(res.status).toBe(403);
  });

  it("lists active suppliers", async () => {
    const res = await request(app)
      .get("/api/v1/suppliers?active=true")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it("filters suppliers by search term", async () => {
    const prisma = await getPrisma();
    await prisma.supplier.create({
      data: { name: "UniqueSearchHit-1234", isActive: true, outstandingAmount: 0 },
    });
    const res = await request(app)
      .get("/api/v1/suppliers?search=UniqueSearchHit")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThan(0);
  });

  it("updates supplier (PATCH)", async () => {
    const prisma = await getPrisma();
    const sup = await prisma.supplier.create({
      data: { name: `Up-${Date.now()}`, isActive: true, outstandingAmount: 0 },
    });
    const res = await request(app)
      .patch(`/api/v1/suppliers/${sup.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ contactPerson: "Bob", rating: 4.5 });
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.contactPerson).toBe("Bob");
    expect(res.body.data?.rating).toBe(4.5);
  });

  it("returns 404 for non-existent supplier detail", async () => {
    const res = await request(app)
      .get("/api/v1/suppliers/550e8400-e29b-41d4-a716-446655440000")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
  });

  it("records a supplier payment and decrements outstanding (side-effect)", async () => {
    const prisma = await getPrisma();
    const sup = await prisma.supplier.create({
      data: { name: `Pay-${Date.now()}`, outstandingAmount: 1000, isActive: true },
    });
    const res = await request(app)
      .post(`/api/v1/suppliers/${sup.id}/payments`)
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({
        supplierId: sup.id,
        amount: 400,
        mode: "CASH",
      });
    expect([200, 201]).toContain(res.status);
    const after = await prisma.supplier.findUnique({ where: { id: sup.id } });
    expect(after?.outstandingAmount).toBeCloseTo(600, 1);
  });

  it("lists supplier catalog (empty by default)", async () => {
    const prisma = await getPrisma();
    const sup = await prisma.supplier.create({
      data: { name: `Cat-${Date.now()}`, outstandingAmount: 0, isActive: true },
    });
    const res = await request(app)
      .get(`/api/v1/suppliers/${sup.id}/catalog`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it("adds supplier catalog item (ADMIN)", async () => {
    const prisma = await getPrisma();
    const sup = await prisma.supplier.create({
      data: { name: `CatAdd-${Date.now()}`, outstandingAmount: 0, isActive: true },
    });
    const res = await request(app)
      .post(`/api/v1/suppliers/${sup.id}/catalog`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        itemName: "Surgical Gloves",
        unitPrice: 5.5,
        moq: 100,
        leadTimeDays: 3,
      });
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.itemName).toBe("Surgical Gloves");
  });
});
