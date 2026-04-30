// Integration tests for the feedback router (which exports both the
// feedbackRouter mounted at /api/v1/feedback AND the complaintsRouter mounted
// at /api/v1/complaints — they share state so we test them together).
//
// The sentiment-ai service is mocked so triggerFeedbackAnalysis() can't blow
// up trying to hit Sarvam during CI.
//
// Skipped unless DATABASE_URL_TEST is set.
import { it, expect, beforeAll, vi } from "vitest";
import request from "supertest";
import { describeIfDB, resetDB, getAuthToken, getPrisma } from "../setup";
import { createPatientFixture } from "../factories";

vi.mock("../../services/ai/sentiment-ai", () => ({
  analyzeFeedback: vi.fn().mockResolvedValue(undefined),
  summarizeNpsDrivers: vi.fn().mockResolvedValue(undefined),
  triggerFeedbackAnalysis: vi.fn(),
}));

let app: any;
let adminToken: string;
let receptionToken: string;
let doctorToken: string;
let nurseToken: string;
let patientToken: string;

describeIfDB("Feedback + Complaints API (integration)", () => {
  beforeAll(async () => {
    await resetDB();
    adminToken = await getAuthToken("ADMIN");
    receptionToken = await getAuthToken("RECEPTION");
    doctorToken = await getAuthToken("DOCTOR");
    nurseToken = await getAuthToken("NURSE");
    patientToken = await getAuthToken("PATIENT");
    const mod = await import("../../app");
    app = mod.app;
  });

  // ═══ FEEDBACK ═══════════════════════════════════════════════════════
  // ─── POST /feedback (public; auth optional) ──────────────────────────
  it("POST /feedback accepts an unauthenticated submission (201)", async () => {
    const patient = await createPatientFixture();
    const res = await request(app)
      .post("/api/v1/feedback")
      .send({
        patientId: patient.id,
        category: "DOCTOR",
        rating: 5,
        nps: 9,
        comment: "Excellent care, friendly staff.",
      });
    expect(res.status).toBe(201);
    expect(res.body.data?.id).toBeTruthy();
    expect(res.body.data?.rating).toBe(5);
  });

  it("POST /feedback 404 when patientId is unknown", async () => {
    const res = await request(app)
      .post("/api/v1/feedback")
      .send({
        patientId: "00000000-0000-4000-8000-000000000000",
        category: "DOCTOR",
        rating: 4,
      });
    expect(res.status).toBe(404);
  });

  it("POST /feedback 400 on invalid payload (rating out of range)", async () => {
    const patient = await createPatientFixture();
    const res = await request(app).post("/api/v1/feedback").send({
      patientId: patient.id,
      category: "DOCTOR",
      rating: 99,
    });
    expect(res.status).toBe(400);
  });

  it("POST /feedback 403 if PATIENT submits for someone else", async () => {
    const otherPatient = await createPatientFixture();
    const res = await request(app)
      .post("/api/v1/feedback")
      .set("Authorization", `Bearer ${patientToken}`)
      .send({
        patientId: otherPatient.id,
        category: "DOCTOR",
        rating: 4,
      });
    expect(res.status).toBe(403);
  });

  // ─── GET /feedback ────────────────────────────────────────────────
  it("GET /feedback returns paginated list for ADMIN", async () => {
    const res = await request(app)
      .get("/api/v1/feedback?page=1&limit=10")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.meta).toBeTruthy();
  });

  it("GET /feedback 401 without auth", async () => {
    const res = await request(app).get("/api/v1/feedback");
    expect(res.status).toBe(401);
  });

  it("GET /feedback 403 for PATIENT", async () => {
    const res = await request(app)
      .get("/api/v1/feedback")
      .set("Authorization", `Bearer ${patientToken}`);
    expect(res.status).toBe(403);
  });

  // ─── GET /feedback/summary ────────────────────────────────────────
  it("GET /feedback/summary returns rollup metrics for RECEPTION", async () => {
    const res = await request(app)
      .get("/api/v1/feedback/summary")
      .set("Authorization", `Bearer ${receptionToken}`);
    expect(res.status).toBe(200);
    expect(typeof res.body.data?.overallAvg).toBe("number");
    expect(typeof res.body.data?.npsScore).toBe("number");
    expect(Array.isArray(res.body.data?.trend)).toBe(true);
  });

  it("GET /feedback/summary 403 for DOCTOR (only ADMIN+RECEPTION)", async () => {
    const res = await request(app)
      .get("/api/v1/feedback/summary")
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(res.status).toBe(403);
  });

  it("GET /feedback/summary 401 without auth", async () => {
    const res = await request(app).get("/api/v1/feedback/summary");
    expect(res.status).toBe(401);
  });

  // ─── POST /feedback/request ────────────────────────────────────────
  it("POST /feedback/request queues a notification (201)", async () => {
    const patient = await createPatientFixture();
    const res = await request(app)
      .post("/api/v1/feedback/request")
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({ patientId: patient.id, channel: "SMS" });
    expect(res.status).toBe(201);

    // Side-effect: a Notification row was queued for this patient's user.
    const prisma = await getPrisma();
    const notifs = await prisma.notification.findMany({
      where: { userId: patient.userId, channel: "SMS" },
    });
    expect(notifs.length).toBeGreaterThan(0);
  });

  it("POST /feedback/request 404 for unknown patient", async () => {
    const res = await request(app)
      .post("/api/v1/feedback/request")
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({
        patientId: "00000000-0000-4000-8000-000000000000",
        channel: "EMAIL",
      });
    expect(res.status).toBe(404);
  });

  it("POST /feedback/request 401 without auth", async () => {
    const res = await request(app)
      .post("/api/v1/feedback/request")
      .send({ patientId: "x", channel: "SMS" });
    expect(res.status).toBe(401);
  });

  it("POST /feedback/request 403 for DOCTOR (only ADMIN+RECEPTION)", async () => {
    const patient = await createPatientFixture();
    const res = await request(app)
      .post("/api/v1/feedback/request")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({ patientId: patient.id, channel: "SMS" });
    expect(res.status).toBe(403);
  });

  // ═══ COMPLAINTS ═════════════════════════════════════════════════════
  // ─── POST /complaints ─────────────────────────────────────────────
  it("POST /complaints creates a ticket with year-scoped number (201)", async () => {
    const patient = await createPatientFixture();
    const res = await request(app)
      .post("/api/v1/complaints")
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({
        patientId: patient.id,
        category: "BILLING",
        description: "Discrepancy in invoice total",
        priority: "HIGH",
      });
    expect(res.status).toBe(201);
    expect(res.body.data?.ticketNumber).toMatch(/^CMP-\d{4}-\d{5}$/);
    expect(res.body.data?.status).toBe("OPEN");
    expect(res.body.data?.slaDueAt).toBeTruthy();
  });

  it("POST /complaints 401 without auth", async () => {
    const res = await request(app)
      .post("/api/v1/complaints")
      .send({ category: "X", description: "Y" });
    expect(res.status).toBe(401);
  });

  it("POST /complaints 400 if neither patientId nor name supplied", async () => {
    const res = await request(app)
      .post("/api/v1/complaints")
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({ category: "BILLING", description: "Anonymous gripe" });
    expect(res.status).toBe(400);
  });

  // ─── GET /complaints ──────────────────────────────────────────────
  it("GET /complaints lists with pagination meta", async () => {
    const res = await request(app)
      .get("/api/v1/complaints?page=1&limit=10")
      .set("Authorization", `Bearer ${nurseToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.meta).toBeTruthy();
  });

  it("GET /complaints 403 for PATIENT", async () => {
    const res = await request(app)
      .get("/api/v1/complaints")
      .set("Authorization", `Bearer ${patientToken}`);
    expect(res.status).toBe(403);
  });

  it("GET /complaints 401 without auth", async () => {
    const res = await request(app).get("/api/v1/complaints");
    expect(res.status).toBe(401);
  });

  // ─── GET /complaints/stats ────────────────────────────────────────
  it("GET /complaints/stats — Critical-Open ⊆ Total-Open invariant (issue #92)", async () => {
    const res = await request(app)
      .get("/api/v1/complaints/stats")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(typeof res.body.data?.totalOpen).toBe("number");
    expect(typeof res.body.data?.criticalOpen).toBe("number");
    // The whole point of the rewrite — must hold by construction.
    expect(res.body.data.criticalOpen).toBeLessThanOrEqual(res.body.data.totalOpen);
  });

  it("GET /complaints/stats 403 for DOCTOR (only ADMIN+RECEPTION)", async () => {
    const res = await request(app)
      .get("/api/v1/complaints/stats")
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(res.status).toBe(403);
  });

  // ─── GET /complaints/:id ──────────────────────────────────────────
  it("GET /complaints/:id 200 for known id", async () => {
    const patient = await createPatientFixture();
    const created = await request(app)
      .post("/api/v1/complaints")
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({
        patientId: patient.id,
        category: "WAIT_TIME",
        description: "Waited 3h for OPD",
      });
    const id = created.body.data.id;
    const res = await request(app)
      .get(`/api/v1/complaints/${id}`)
      .set("Authorization", `Bearer ${nurseToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data?.id).toBe(id);
  });

  it("GET /complaints/:id 404 for unknown id", async () => {
    const res = await request(app)
      .get("/api/v1/complaints/00000000-0000-4000-8000-000000000000")
      .set("Authorization", `Bearer ${nurseToken}`);
    expect(res.status).toBe(404);
  });

  // ─── PATCH /complaints/:id ────────────────────────────────────────
  it("PATCH /complaints/:id sets resolvedAt when status=RESOLVED", async () => {
    const patient = await createPatientFixture();
    const created = await request(app)
      .post("/api/v1/complaints")
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({
        patientId: patient.id,
        category: "STAFF_BEHAVIOR",
        description: "Receptionist was rude",
      });
    const id = created.body.data.id;
    const res = await request(app)
      .patch(`/api/v1/complaints/${id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ status: "RESOLVED", resolution: "Apologised, retrained staff" });
    expect(res.status).toBe(200);
    expect(res.body.data?.status).toBe("RESOLVED");
    expect(res.body.data?.resolvedAt).toBeTruthy();
  });

  it("PATCH /complaints/:id 403 for NURSE (only ADMIN+RECEPTION)", async () => {
    const res = await request(app)
      .patch("/api/v1/complaints/00000000-0000-4000-8000-000000000000")
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({ status: "UNDER_REVIEW" });
    expect(res.status).toBe(403);
  });

  // ─── POST /complaints/:id/escalate ────────────────────────────────
  it("POST /complaints/:id/escalate marks status=ESCALATED", async () => {
    const patient = await createPatientFixture();
    const created = await request(app)
      .post("/api/v1/complaints")
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({
        patientId: patient.id,
        category: "CLINICAL",
        description: "Wrong medication dispensed",
        priority: "CRITICAL",
      });
    const id = created.body.data.id;
    const res = await request(app)
      .post(`/api/v1/complaints/${id}/escalate`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ reason: "Patient safety incident — needs senior review" });
    expect(res.status).toBe(200);
    expect(res.body.data?.status).toBe("ESCALATED");
    expect(res.body.data?.escalatedAt).toBeTruthy();
  });

  it("POST /complaints/:id/escalate 400 when complaint already RESOLVED", async () => {
    const patient = await createPatientFixture();
    const created = await request(app)
      .post("/api/v1/complaints")
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({
        patientId: patient.id,
        category: "BILLING",
        description: "test",
      });
    const id = created.body.data.id;
    await request(app)
      .patch(`/api/v1/complaints/${id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ status: "RESOLVED" });
    const res = await request(app)
      .post(`/api/v1/complaints/${id}/escalate`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ reason: "Trying to escalate after the fact" });
    expect(res.status).toBe(400);
  });

  it("POST /complaints/:id/escalate 404 for unknown id", async () => {
    const res = await request(app)
      .post(
        "/api/v1/complaints/00000000-0000-4000-8000-000000000000/escalate"
      )
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ reason: "any" });
    expect(res.status).toBe(404);
  });

  // ─── POST /complaints/auto-escalate ───────────────────────────────
  it("POST /complaints/auto-escalate returns escalated count", async () => {
    const res = await request(app)
      .post("/api/v1/complaints/auto-escalate")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(typeof res.body.data?.escalated).toBe("number");
  });

  it("POST /complaints/auto-escalate 403 for RECEPTION (ADMIN-only)", async () => {
    const res = await request(app)
      .post("/api/v1/complaints/auto-escalate")
      .set("Authorization", `Bearer ${receptionToken}`);
    expect(res.status).toBe(403);
  });

  // ─── GET /complaints/reports/dashboard ────────────────────────────
  it("GET /complaints/reports/dashboard returns stats + avgResponseHours", async () => {
    const res = await request(app)
      .get("/api/v1/complaints/reports/dashboard")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(typeof res.body.data?.stats?.total).toBe("number");
    expect(typeof res.body.data?.avgResponseHours).toBe("number");
  });

  it("GET /complaints/reports/dashboard 403 for DOCTOR", async () => {
    const res = await request(app)
      .get("/api/v1/complaints/reports/dashboard")
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(res.status).toBe(403);
  });
});
