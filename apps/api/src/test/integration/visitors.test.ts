// Integration tests for the visitors router.
import { it, expect, beforeAll } from "vitest";
import request from "supertest";
import { describeIfDB, resetDB, getAuthToken, getPrisma } from "../setup";
import { createPatientFixture } from "../factories";

let app: any;
let adminToken: string;
let receptionToken: string;
let doctorToken: string;

async function checkinVisitor(overrides: Partial<any> = {}) {
  const payload = {
    name: overrides.name || "Jane Visitor",
    phone: overrides.phone || "9001234567",
    idProofType: overrides.idProofType || "AADHAAR",
    idProofNumber:
      overrides.idProofNumber ||
      `AAD${Date.now()}${Math.floor(Math.random() * 1000)}`,
    patientId: overrides.patientId,
    purpose: overrides.purpose || "PATIENT_VISIT",
    department: overrides.department || "Cardiology",
  };
  return request(app)
    .post("/api/v1/visitors")
    .set("Authorization", `Bearer ${receptionToken}`)
    .send(payload);
}

describeIfDB("Visitors API (integration)", () => {
  beforeAll(async () => {
    await resetDB();
    adminToken = await getAuthToken("ADMIN");
    receptionToken = await getAuthToken("RECEPTION");
    doctorToken = await getAuthToken("DOCTOR");
    const mod = await import("../../app");
    app = mod.app;
  });

  it("checks in a visitor and issues a VIS pass number", async () => {
    const patient = await createPatientFixture();
    const res = await checkinVisitor({ patientId: patient.id });
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.passNumber).toMatch(/^VIS\d+-\d+/);
    expect(res.body.data?.checkInAt).toBeTruthy();
  });

  it("lists visitors", async () => {
    await checkinVisitor();
    const res = await request(app)
      .get("/api/v1/visitors")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it("requires auth (401)", async () => {
    const res = await request(app).get("/api/v1/visitors");
    expect(res.status).toBe(401);
  });

  it("doctor cannot check in a visitor (403)", async () => {
    const res = await request(app)
      .post("/api/v1/visitors")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({
        name: "Forbidden",
        purpose: "PATIENT_VISIT",
      });
    expect(res.status).toBe(403);
  });

  it("rejects malformed payload (400)", async () => {
    const res = await request(app)
      .post("/api/v1/visitors")
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({ name: "", purpose: "INVALID" });
    expect(res.status).toBe(400);
  });

  it("enforces 2-visitor-per-patient limit (business rule)", async () => {
    const patient = await createPatientFixture();
    await checkinVisitor({ patientId: patient.id, name: "V1" });
    await checkinVisitor({ patientId: patient.id, name: "V2" });
    const res = await checkinVisitor({ patientId: patient.id, name: "V3" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/2 active visitors/);
  });

  it("checks a visitor out — checkOutAt stamped (side-effect)", async () => {
    const r1 = await checkinVisitor();
    const id = r1.body.data.id;
    const res = await request(app)
      .patch(`/api/v1/visitors/${id}/checkout`)
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({});
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.checkOutAt).toBeTruthy();

    const prisma = await getPrisma();
    const v = await prisma.visitor.findUnique({ where: { id } });
    expect(v?.checkOutAt).toBeTruthy();
  });

  it("cannot check out twice (400)", async () => {
    const r1 = await checkinVisitor();
    const id = r1.body.data.id;
    await request(app)
      .patch(`/api/v1/visitors/${id}/checkout`)
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({});
    const res = await request(app)
      .patch(`/api/v1/visitors/${id}/checkout`)
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({});
    expect(res.status).toBe(400);
  });

  it("daily stats include totalToday and byPurpose", async () => {
    await checkinVisitor({ purpose: "APPOINTMENT" });
    const res = await request(app)
      .get("/api/v1/visitors/stats/daily")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(typeof res.body.data?.totalToday).toBe("number");
    expect(res.body.data?.byPurpose).toBeTruthy();
  });

  it("blocks blacklisted visitors on check-in (403)", async () => {
    const blName = `BadActor-${Date.now()}`;
    await request(app)
      .post("/api/v1/visitors/blacklist")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: blName, reason: "Aggressive behavior" });
    const res = await checkinVisitor({ name: blName });
    expect(res.status).toBe(403);
  });

  it("active list excludes checked-out visitors", async () => {
    const r1 = await checkinVisitor();
    await request(app)
      .patch(`/api/v1/visitors/${r1.body.data.id}/checkout`)
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({});
    const res = await request(app)
      .get("/api/v1/visitors/active")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const ids = res.body.data.map((v: any) => v.id);
    expect(ids).not.toContain(r1.body.data.id);
  });

  // ───────────────────────────────────────────────────────────
  // PII redaction (#476): /api/v1/visitors/* must NEVER return
  // a raw Aadhaar / ID-proof number. The DB still holds the full
  // value (needed for blacklist matching), but every read path is
  // masked to `********<last4>`. These tests exist because the
  // original 11-case suite had zero response-body PII assertions
  // and the leak was invisible.
  // ───────────────────────────────────────────────────────────

  const FULL_AADHAAR = "123412341234"; // 12-digit Aadhaar
  const EXPECTED_MASK = "********1234";
  const MASK_RE = /^\*+\d{4}$/;

  it("POST /visitors response masks Aadhaar (#476)", async () => {
    const res = await checkinVisitor({ idProofNumber: FULL_AADHAAR });
    expect([200, 201]).toContain(res.status);
    expect(res.body.data.idProofNumber).toBe(EXPECTED_MASK);
    expect(res.body.data.idProofNumber).not.toBe(FULL_AADHAAR);
    expect(JSON.stringify(res.body)).not.toContain(FULL_AADHAAR);
  });

  it("GET /visitors/active never leaks raw Aadhaar (#476)", async () => {
    await checkinVisitor({ idProofNumber: FULL_AADHAAR });
    const res = await request(app)
      .get("/api/v1/visitors/active")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain(FULL_AADHAAR);
    for (const v of res.body.data) {
      if (v.idProofNumber !== null && v.idProofNumber !== undefined) {
        expect(v.idProofNumber).toMatch(MASK_RE);
      }
    }
    // and at least one of them is the seeded last-4
    const masked = res.body.data
      .map((v: any) => v.idProofNumber)
      .filter((x: any) => x);
    expect(masked).toContain(EXPECTED_MASK);
  });

  it("GET /visitors (list) masks Aadhaar (#476)", async () => {
    await checkinVisitor({ idProofNumber: FULL_AADHAAR });
    const res = await request(app)
      .get("/api/v1/visitors")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain(FULL_AADHAAR);
    for (const v of res.body.data) {
      if (v.idProofNumber) {
        expect(v.idProofNumber).toMatch(MASK_RE);
      }
    }
  });

  it("GET /visitors/:id masks Aadhaar (#476)", async () => {
    const r1 = await checkinVisitor({ idProofNumber: FULL_AADHAAR });
    const id = r1.body.data.id;
    const res = await request(app)
      .get(`/api/v1/visitors/${id}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.idProofNumber).toBe(EXPECTED_MASK);
    expect(JSON.stringify(res.body)).not.toContain(FULL_AADHAAR);
  });

  it("GET /visitors/patient/:patientId masks Aadhaar (#476)", async () => {
    const patient = await createPatientFixture();
    await checkinVisitor({
      patientId: patient.id,
      idProofNumber: FULL_AADHAAR,
    });
    const res = await request(app)
      .get(`/api/v1/visitors/patient/${patient.id}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain(FULL_AADHAAR);
    for (const v of res.body.data.items) {
      if (v.idProofNumber) expect(v.idProofNumber).toMatch(MASK_RE);
    }
  });

  it("PATCH /visitors/:id/checkout masks Aadhaar in response (#476)", async () => {
    const r1 = await checkinVisitor({ idProofNumber: FULL_AADHAAR });
    const res = await request(app)
      .patch(`/api/v1/visitors/${r1.body.data.id}/checkout`)
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({});
    expect([200, 201]).toContain(res.status);
    expect(res.body.data.idProofNumber).toBe(EXPECTED_MASK);
    expect(JSON.stringify(res.body)).not.toContain(FULL_AADHAAR);
  });

  it("DB still stores full Aadhaar — masking is API-layer only (#476)", async () => {
    const r1 = await checkinVisitor({ idProofNumber: FULL_AADHAAR });
    const prisma = await getPrisma();
    const row = await prisma.visitor.findUnique({
      where: { id: r1.body.data.id },
    });
    // Full value preserved at rest (needed for blacklist matching, audit).
    expect(row?.idProofNumber).toBe(FULL_AADHAAR);
  });
});
