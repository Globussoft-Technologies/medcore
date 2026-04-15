// Integration tests for the packages router.
import { it, expect, beforeAll } from "vitest";
import request from "supertest";
import { describeIfDB, resetDB, getAuthToken } from "../setup";
import { createPatientFixture } from "../factories";

let app: any;
let adminToken: string;
let receptionToken: string;
let nurseToken: string;

async function createPackage(overrides: Partial<any> = {}) {
  const res = await request(app)
    .post("/api/v1/packages")
    .set("Authorization", `Bearer ${adminToken}`)
    .send({
      name: overrides.name || `Master Health-${Date.now()}`,
      services: overrides.services || "CBC, ECG, Chest X-Ray",
      price: overrides.price ?? 2500,
      validityDays: overrides.validityDays ?? 90,
      category: overrides.category || "Master Health Checkup",
    });
  return res.body.data;
}

describeIfDB("Packages API (integration)", () => {
  beforeAll(async () => {
    await resetDB();
    adminToken = await getAuthToken("ADMIN");
    receptionToken = await getAuthToken("RECEPTION");
    nurseToken = await getAuthToken("NURSE");
    const mod = await import("../../app");
    app = mod.app;
  });

  it("creates a health package (admin)", async () => {
    const pkg = await createPackage();
    expect(pkg?.name).toBeTruthy();
    expect(pkg?.isActive).toBe(true);
  });

  it("lists active packages", async () => {
    await createPackage();
    const res = await request(app)
      .get("/api/v1/packages")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it("requires auth (401)", async () => {
    const res = await request(app).get("/api/v1/packages");
    expect(res.status).toBe(401);
  });

  it("nurse cannot create a package (403)", async () => {
    const res = await request(app)
      .post("/api/v1/packages")
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({ name: "N", services: "a", price: 100 });
    expect(res.status).toBe(403);
  });

  it("rejects malformed payload (400)", async () => {
    const res = await request(app)
      .post("/api/v1/packages")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "" });
    expect(res.status).toBe(400);
  });

  it("updates a package", async () => {
    const pkg = await createPackage();
    const res = await request(app)
      .patch(`/api/v1/packages/${pkg.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ price: 3000 });
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.price).toBe(3000);
  });

  it("soft-deletes a package (isActive -> false)", async () => {
    const pkg = await createPackage();
    const res = await request(app)
      .delete(`/api/v1/packages/${pkg.id}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data?.isActive).toBe(false);
  });

  it("purchases a package (sets expiresAt based on validityDays)", async () => {
    const pkg = await createPackage({ validityDays: 30 });
    const patient = await createPatientFixture();
    const res = await request(app)
      .post("/api/v1/packages/purchase")
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({ packageId: pkg.id, patientId: patient.id, amountPaid: 2500 });
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.purchaseNumber).toMatch(/^PKG\d+/);
    expect(res.body.data?.expiresAt).toBeTruthy();
  });

  it("purchase 404s on inactive/unknown package", async () => {
    const patient = await createPatientFixture();
    const res = await request(app)
      .post("/api/v1/packages/purchase")
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({
        packageId: "00000000-0000-0000-0000-000000000000",
        patientId: patient.id,
        amountPaid: 100,
      });
    expect(res.status).toBe(404);
  });

  it("consumes a service, recording servicesUsed (business-rule)", async () => {
    const pkg = await createPackage({ services: "CBC, ECG" });
    const patient = await createPatientFixture();
    const p = await request(app)
      .post("/api/v1/packages/purchase")
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({ packageId: pkg.id, patientId: patient.id, amountPaid: pkg.price });
    const purchaseId = p.body.data.id;
    const res = await request(app)
      .post(`/api/v1/packages/purchases/${purchaseId}/consume`)
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({ service: "CBC" });
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.servicesUsed).toContain("CBC");
  });

  it("consuming all services flips isFullyUsed", async () => {
    const pkg = await createPackage({ services: "CBC" });
    const patient = await createPatientFixture();
    const p = await request(app)
      .post("/api/v1/packages/purchase")
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({ packageId: pkg.id, patientId: patient.id, amountPaid: pkg.price });
    const res = await request(app)
      .post(`/api/v1/packages/purchases/${p.body.data.id}/consume`)
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({ service: "CBC" });
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.isFullyUsed).toBe(true);
  });

  it("analytics endpoint returns per-package rows", async () => {
    await createPackage();
    const res = await request(app)
      .get("/api/v1/packages/stats/analytics")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data?.rows).toBeTruthy();
    expect(res.body.data?.totals).toBeTruthy();
  });
});
