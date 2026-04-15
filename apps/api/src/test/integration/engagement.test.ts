// Integration tests for feedback + complaints routers (engagement).
import { it, expect, beforeAll } from "vitest";
import request from "supertest";
import { describeIfDB, resetDB, getAuthToken } from "../setup";
import { createPatientFixture } from "../factories";

let app: any;
let adminToken: string;

describeIfDB("Engagement (feedback + complaints) API (integration)", () => {
  beforeAll(async () => {
    await resetDB();
    adminToken = await getAuthToken("ADMIN");
    const mod = await import("../../app");
    app = mod.app;
  });

  // ─── FEEDBACK ────────────────────────────────────────
  it("submits feedback with rating", async () => {
    const patient = await createPatientFixture();
    const res = await request(app)
      .post("/api/v1/feedback")
      .send({
        patientId: patient.id,
        category: "DOCTOR",
        rating: 5,
        nps: 10,
        comment: "Excellent care, very professional and kind.",
      });
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.rating).toBe(5);
    expect(res.body.data?.sentiment).toBeTruthy();
  });

  it("submits feedback without comment", async () => {
    const patient = await createPatientFixture();
    const res = await request(app)
      .post("/api/v1/feedback")
      .send({
        patientId: patient.id,
        category: "OVERALL",
        rating: 3,
      });
    expect([200, 201]).toContain(res.status);
  });

  it("lists feedback (admin)", async () => {
    const res = await request(app)
      .get("/api/v1/feedback")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it("returns feedback summary with NPS calculation", async () => {
    // Seed feedback
    const p1 = await createPatientFixture();
    const p2 = await createPatientFixture();
    await request(app)
      .post("/api/v1/feedback")
      .send({ patientId: p1.id, category: "DOCTOR", rating: 5, nps: 10 });
    await request(app)
      .post("/api/v1/feedback")
      .send({ patientId: p2.id, category: "DOCTOR", rating: 2, nps: 3 });

    const res = await request(app)
      .get("/api/v1/feedback/summary")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(typeof res.body.data?.npsScore).toBe("number");
    expect(res.body.data?.totalCount).toBeGreaterThanOrEqual(2);
  });

  it("rejects feedback with invalid patientId", async () => {
    const res = await request(app)
      .post("/api/v1/feedback")
      .send({
        patientId: "00000000-0000-0000-0000-000000000000",
        category: "DOCTOR",
        rating: 4,
      });
    expect(res.status).toBe(404);
  });

  // ─── COMPLAINTS ──────────────────────────────────────
  it("creates a complaint with auto ticket number", async () => {
    const res = await request(app)
      .post("/api/v1/complaints")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        name: "Jane Complainant",
        phone: "9123456700",
        category: "BILLING",
        description: "Overcharged for consultation",
        priority: "HIGH",
      });
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.ticketNumber).toMatch(/^CMP\d+/);
    expect(res.body.data?.slaDueAt).toBeTruthy();
  });

  it("lists complaints", async () => {
    const res = await request(app)
      .get("/api/v1/complaints")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it("returns complaint stats", async () => {
    const res = await request(app)
      .get("/api/v1/complaints/stats")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
  });

  it("resolves a complaint (RESOLVED status)", async () => {
    const createRes = await request(app)
      .post("/api/v1/complaints")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        name: "John Doe",
        category: "SERVICE",
        description: "Long wait time",
      });
    const id = createRes.body.data.id;
    const res = await request(app)
      .patch(`/api/v1/complaints/${id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ status: "RESOLVED", resolution: "Apologized, expedited queue" });
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.status).toBe("RESOLVED");
  });

  it("escalates a complaint", async () => {
    const createRes = await request(app)
      .post("/api/v1/complaints")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        name: "Angry Patient",
        category: "STAFF",
        description: "Rude behaviour",
      });
    const id = createRes.body.data.id;
    const res = await request(app)
      .post(`/api/v1/complaints/${id}/escalate`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ reason: "Requires management intervention" });
    expect([200, 201]).toContain(res.status);
  });

  it("auto-escalates overdue complaints", async () => {
    const res = await request(app)
      .post("/api/v1/complaints/auto-escalate")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});
    expect(res.status).toBeLessThan(500);
  });

  it("rejects bad complaint payload (400)", async () => {
    const res = await request(app)
      .post("/api/v1/complaints")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ category: "" });
    expect(res.status).toBe(400);
  });

  it("rejects unauthenticated complaint list", async () => {
    const res = await request(app).get("/api/v1/complaints");
    expect(res.status).toBe(401);
  });
});
