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

  it("GET /wards exposes dailyRate on each bed (2026-06 — tariff surfaced in list)", async () => {
    // The GET /wards bed-select gained `dailyRate` so the ward board can show
    // per-bed tariff without a second round-trip. Seed a ward + a bed with a
    // known rate via the API, then assert the list endpoint returns it.
    const ward = await createWardFixture({ name: `W-RATE-${Date.now()}` });
    const created = await request(app)
      .post(`/api/v1/wards/${ward.id}/beds`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ wardId: ward.id, bedNumber: "RATE-01", dailyRate: 2750 });
    expect([200, 201]).toContain(created.status);

    const res = await request(app)
      .get("/api/v1/wards")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const row = res.body.data.find((w: any) => w.id === ward.id);
    expect(row).toBeTruthy();
    const bed = row.beds.find((b: any) => b.bedNumber === "RATE-01");
    expect(bed).toBeTruthy();
    expect(bed.dailyRate).toBe(2750);
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

  // ─── 2026-06: duplicate bed number → friendly 409 (not raw Prisma 500) ──
  it("POST /wards/:wardId/beds rejects a duplicate bed number with a clean 409", async () => {
    const ward = await createWardFixture({ name: `WDUP-${Date.now()}` });
    const first = await request(app)
      .post(`/api/v1/wards/${ward.id}/beds`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ bedNumber: "DUP-1", dailyRate: 1000 });
    expect([200, 201]).toContain(first.status);

    const dup = await request(app)
      .post(`/api/v1/wards/${ward.id}/beds`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ bedNumber: "DUP-1", dailyRate: 2000 });
    expect(dup.status).toBe(409);
    // Friendly, actionable message — NOT the raw "prisma.bed.create()" string.
    expect(dup.body.error).toMatch(/already exists/i);
    expect(dup.body.error).not.toMatch(/prisma/i);
  });

  // ─── 2026-06: PATCH /beds/:id — edit number + daily rate (CRUD) ─────────
  it("PATCH /beds/:id updates the daily rate (ADMIN)", async () => {
    const ward = await createWardFixture({ name: `WED-${Date.now()}` });
    const bed = await createBedFixture({
      wardId: ward.id,
      overrides: { bedNumber: "ED-1", dailyRate: 1000 },
    });

    const res = await request(app)
      .patch(`/api/v1/beds/${bed.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ dailyRate: 3455 });
    expect(res.status).toBe(200);
    expect(res.body.data.dailyRate).toBe(3455);
    expect(res.body.data.bedNumber).toBe("ED-1"); // unchanged
  });

  it("PATCH /beds/:id renames a bed (ADMIN)", async () => {
    const ward = await createWardFixture({ name: `WREN-${Date.now()}` });
    const bed = await createBedFixture({
      wardId: ward.id,
      overrides: { bedNumber: "REN-1", dailyRate: 1000 },
    });

    const res = await request(app)
      .patch(`/api/v1/beds/${bed.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ bedNumber: "REN-2" });
    expect(res.status).toBe(200);
    expect(res.body.data.bedNumber).toBe("REN-2");
  });

  it("PATCH /beds/:id rejects renaming onto an existing bed number with 409", async () => {
    const ward = await createWardFixture({ name: `WCOL-${Date.now()}` });
    await createBedFixture({
      wardId: ward.id,
      overrides: { bedNumber: "COL-A" },
    });
    const bedB = await createBedFixture({
      wardId: ward.id,
      overrides: { bedNumber: "COL-B" },
    });

    const res = await request(app)
      .patch(`/api/v1/beds/${bedB.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ bedNumber: "COL-A" });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already exists/i);
  });

  it("PATCH /beds/:id rejects an empty body (400)", async () => {
    const ward = await createWardFixture({ name: `WEMP-${Date.now()}` });
    const bed = await createBedFixture({ wardId: ward.id });
    const res = await request(app)
      .patch(`/api/v1/beds/${bed.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});
    expect(res.status).toBe(400);
  });

  it("PATCH /beds/:id 404 for an unknown bed", async () => {
    const res = await request(app)
      .patch("/api/v1/beds/550e8400-e29b-41d4-a716-446655440000")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ dailyRate: 500 });
    expect(res.status).toBe(404);
  });

  it("PATCH /beds/:id forbidden for NURSE (403 — ADMIN-only edit)", async () => {
    const ward = await createWardFixture({ name: `WNUR-${Date.now()}` });
    const bed = await createBedFixture({ wardId: ward.id });
    const res = await request(app)
      .patch(`/api/v1/beds/${bed.id}`)
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({ dailyRate: 500 });
    expect(res.status).toBe(403);
  });

  // ─── 2026-06: DELETE /beds/:id — remove a bed (CRUD) ────────────────────
  it("DELETE /beds/:id removes an AVAILABLE bed (ADMIN)", async () => {
    const prisma = await getPrisma();
    const ward = await createWardFixture({ name: `WDEL-${Date.now()}` });
    const bed = await createBedFixture({
      wardId: ward.id,
      overrides: { status: "AVAILABLE" },
    });

    const res = await request(app)
      .delete(`/api/v1/beds/${bed.id}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);

    const gone = await prisma.bed.findUnique({ where: { id: bed.id } });
    expect(gone).toBeNull();
  });

  it("DELETE /beds/:id refuses to delete an OCCUPIED bed (409)", async () => {
    const ward = await createWardFixture({ name: `WOCC-${Date.now()}` });
    const bed = await createBedFixture({
      wardId: ward.id,
      overrides: { bedNumber: "OCC-1", status: "OCCUPIED" },
    });

    const res = await request(app)
      .delete(`/api/v1/beds/${bed.id}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/occupied/i);
  });

  it("DELETE /beds/:id 404 for an unknown bed", async () => {
    const res = await request(app)
      .delete("/api/v1/beds/550e8400-e29b-41d4-a716-446655440000")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
  });

  it("DELETE /beds/:id forbidden for NURSE (403 — ADMIN-only delete)", async () => {
    const ward = await createWardFixture({ name: `WDN-${Date.now()}` });
    const bed = await createBedFixture({ wardId: ward.id });
    const res = await request(app)
      .delete(`/api/v1/beds/${bed.id}`)
      .set("Authorization", `Bearer ${nurseToken}`);
    expect(res.status).toBe(403);
  });
});
