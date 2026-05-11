// Integration tests for the wards + beds routers.
import { it, expect, beforeAll } from "vitest";
import request from "supertest";
import { describeIfDB, resetDB, getAuthToken, getPrisma } from "../setup";
import { createWardFixture, createBedFixture } from "../factories";

let app: any;
let adminToken: string;
let patientToken: string;
let nurseToken: string;

describeIfDB("Wards API (integration)", () => {
  beforeAll(async () => {
    await resetDB();
    adminToken = await getAuthToken("ADMIN");
    patientToken = await getAuthToken("PATIENT");
    nurseToken = await getAuthToken("NURSE");
    const mod = await import("../../app");
    app = mod.app;
  });

  it("401 without token on list wards", async () => {
    const res = await request(app).get("/api/v1/wards");
    expect(res.status).toBe(401);
  });

  it("lists wards with bed stats", async () => {
    await createWardFixture({ name: "Ward-A", type: "GENERAL" });
    const res = await request(app)
      .get("/api/v1/wards")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    const ward = res.body.data.find((w: any) => w.name === "Ward-A");
    expect(ward).toBeTruthy();
    expect(ward.bedStats).toBeDefined();
    expect(typeof ward.bedStats.total).toBe("number");
  });

  it("creates a ward (ADMIN happy path)", async () => {
    const res = await request(app)
      .post("/api/v1/wards")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: `W-${Date.now()}`, type: "ICU", floor: "3" });
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.type).toBe("ICU");
  });

  it("rejects ward creation with malformed payload (400)", async () => {
    const res = await request(app)
      .post("/api/v1/wards")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "", type: "BASEMENT" });
    expect(res.status).toBe(400);
  });

  it("rejects ward creation from PATIENT (403)", async () => {
    const res = await request(app)
      .post("/api/v1/wards")
      .set("Authorization", `Bearer ${patientToken}`)
      .send({ name: `W-${Date.now()}`, type: "GENERAL" });
    expect(res.status).toBe(403);
  });

  it("creates a bed for a ward and returns ward detail with beds", async () => {
    const ward = await createWardFixture({ name: `W-${Date.now()}` });
    const create = await request(app)
      .post(`/api/v1/wards/${ward.id}/beds`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ wardId: ward.id, bedNumber: "B101", dailyRate: 1500 });
    expect([200, 201]).toContain(create.status);
    const detail = await request(app)
      .get(`/api/v1/wards/${ward.id}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(detail.status).toBe(200);
    expect(detail.body.data?.beds?.length).toBeGreaterThan(0);
  });

  it("returns 404 for non-existent ward detail", async () => {
    const res = await request(app)
      .get("/api/v1/wards/550e8400-e29b-41d4-a716-446655440000")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
  });

  it("flips bed status from AVAILABLE to OCCUPIED (side-effect)", async () => {
    const ward = await createWardFixture({ name: `W-${Date.now()}` });
    const bed = await createBedFixture({ wardId: ward.id });
    const res = await request(app)
      .patch(`/api/v1/beds/${bed.id}/status`)
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({ status: "OCCUPIED", notes: "Admission" });
    expect([200, 201]).toContain(res.status);
    const prisma = await getPrisma();
    const updated = await prisma.bed.findUnique({ where: { id: bed.id } });
    expect(updated?.status).toBe("OCCUPIED");
  });

  it("rejects invalid bed status value (400)", async () => {
    const ward = await createWardFixture({ name: `W-${Date.now()}` });
    const bed = await createBedFixture({ wardId: ward.id });
    const res = await request(app)
      .patch(`/api/v1/beds/${bed.id}/status`)
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({ status: "EXPLODED" });
    expect(res.status).toBe(400);
  });

  // ── Issue #36 coverage ────────────────────────────────────────────────

  it("GET /wards returns flat bed counts that match bed rows (Issue #36)", async () => {
    const ward = await createWardFixture({ name: `WC-${Date.now()}` });
    const b1 = await createBedFixture({ wardId: ward.id });
    const b2 = await createBedFixture({ wardId: ward.id });
    await createBedFixture({ wardId: ward.id });

    const prisma = await getPrisma();
    await prisma.bed.update({
      where: { id: b1.id },
      data: { status: "OCCUPIED" },
    });
    await prisma.bed.update({
      where: { id: b2.id },
      data: { status: "CLEANING" },
    });

    const res = await request(app)
      .get("/api/v1/wards")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);

    const row = (res.body.data as any[]).find((w) => w.id === ward.id);
    expect(row).toBeTruthy();
    expect(row.totalBeds).toBe(3);
    expect(row.availableBeds).toBe(1);
    expect(row.occupiedBeds).toBe(1);
    expect(row.cleaningBeds).toBe(1);
    expect(Array.isArray(row.beds)).toBe(true);
    expect(row.beds.length).toBe(3);
    // Back-compat: bedStats still present.
    expect(row.bedStats.total).toBe(3);
  });

  it("POST /wards/:wardId/beds accepts UI body shape (bedNumber only, Issue #36)", async () => {
    const ward = await createWardFixture({ name: `WA-${Date.now()}` });
    const res = await request(app)
      .post(`/api/v1/wards/${ward.id}/beds`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ bedNumber: "UI-01" });
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.bedNumber).toBe("UI-01");
    expect(res.body.data?.wardId).toBe(ward.id);
  });

  it("POST /wards/:wardId/beds 400 surfaces field-level details", async () => {
    const ward = await createWardFixture({ name: `WB-${Date.now()}` });
    const res = await request(app)
      .post(`/api/v1/wards/${ward.id}/beds`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/validation/i);
    expect(Array.isArray(res.body.details)).toBe(true);
    const fields = (res.body.details as Array<{ field: string }>).map(
      (d) => d.field
    );
    expect(fields).toContain("bedNumber");
  });
});
