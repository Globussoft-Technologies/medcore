// Integration tests for the preauth (insurance pre-authorization) router.
// Skipped unless DATABASE_URL_TEST is set.
//
// NOTE: The current preauth.ts handler does NOT call any external IRDAI / TPA
// vendor — it persists the request locally and lets a human update the status
// via PATCH. There is therefore nothing to vi.mock at the module level. If a
// future PR wires in an external vendor client, mock it here.
import { it, expect, beforeAll } from "vitest";
import request from "supertest";
import { describeIfDB, resetDB, getAuthToken, getPrisma } from "../setup";
import { createPatientFixture } from "../factories";

let app: any;
let adminToken: string;
let receptionToken: string;
let doctorToken: string;
let patientToken: string;

async function submitRequest(patientId: string, overrides: Record<string, any> = {}) {
  return request(app)
    .post("/api/v1/preauth")
    .set("Authorization", `Bearer ${adminToken}`)
    .send({
      patientId,
      insuranceProvider: "Star Health",
      policyNumber: "STAR-12345",
      procedureName: "Appendectomy",
      estimatedCost: 75000,
      diagnosis: "Acute appendicitis",
      ...overrides,
    });
}

describeIfDB("Preauth API (integration)", () => {
  beforeAll(async () => {
    await resetDB();
    adminToken = await getAuthToken("ADMIN");
    receptionToken = await getAuthToken("RECEPTION");
    doctorToken = await getAuthToken("DOCTOR");
    patientToken = await getAuthToken("PATIENT");
    const mod = await import("../../app");
    app = mod.app;
  });

  // ─── POST /preauth ────────────────────────────────────────

  it("submits a preauth request (201) with a generated request number", async () => {
    const patient = await createPatientFixture();
    const res = await submitRequest(patient.id);
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.requestNumber).toMatch(/^PA\d{6}$/);
    expect(res.body.data?.patientId).toBe(patient.id);
    expect(res.body.data?.status).toBeDefined();
  });

  it("persists supportingDocs as JSON when provided", async () => {
    const patient = await createPatientFixture();
    const res = await submitRequest(patient.id, {
      supportingDocs: ["/uploads/doc1.pdf", "/uploads/doc2.pdf"],
      notes: "Prior authorization for urgent surgery",
    });
    expect([200, 201]).toContain(res.status);

    const prisma = await getPrisma();
    const stored = await prisma.preAuthRequest.findUnique({
      where: { id: res.body.data.id },
    });
    expect(stored?.supportingDocs).toBeTruthy();
    const parsed = JSON.parse(stored!.supportingDocs as string);
    expect(parsed).toContain("/uploads/doc1.pdf");
  });

  it("rejects POST with invalid payload (400 — missing required fields)", async () => {
    const res = await request(app)
      .post("/api/v1/preauth")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        patientId: "not-a-uuid",
        insuranceProvider: "",
        policyNumber: "",
        procedureName: "",
        estimatedCost: -100,
      });
    expect(res.status).toBe(400);
  });

  it("rejects POST from DOCTOR (403)", async () => {
    const patient = await createPatientFixture();
    const res = await request(app)
      .post("/api/v1/preauth")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({
        patientId: patient.id,
        insuranceProvider: "Star Health",
        policyNumber: "X",
        procedureName: "Y",
        estimatedCost: 1000,
      });
    expect(res.status).toBe(403);
  });

  it("rejects POST from PATIENT (403)", async () => {
    const patient = await createPatientFixture();
    const res = await request(app)
      .post("/api/v1/preauth")
      .set("Authorization", `Bearer ${patientToken}`)
      .send({
        patientId: patient.id,
        insuranceProvider: "Star Health",
        policyNumber: "X",
        procedureName: "Y",
        estimatedCost: 1000,
      });
    expect(res.status).toBe(403);
  });

  it("rejects POST without auth (401)", async () => {
    const res = await request(app).post("/api/v1/preauth").send({});
    expect(res.status).toBe(401);
  });

  it("issues sequential request numbers for back-to-back submissions", async () => {
    const patient = await createPatientFixture();
    const a = await submitRequest(patient.id, { procedureName: "MRI Brain" });
    const b = await submitRequest(patient.id, { procedureName: "MRI Spine" });
    expect([200, 201]).toContain(a.status);
    expect([200, 201]).toContain(b.status);
    const aNum = parseInt(a.body.data.requestNumber.replace(/^PA/, ""), 10);
    const bNum = parseInt(b.body.data.requestNumber.replace(/^PA/, ""), 10);
    expect(bNum).toBe(aNum + 1);
  });

  // ─── GET /preauth (list) ──────────────────────────────────

  it("lists preauth requests (200) including patient relation", async () => {
    const patient = await createPatientFixture();
    await submitRequest(patient.id);
    const res = await request(app)
      .get("/api/v1/preauth")
      .set("Authorization", `Bearer ${receptionToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeGreaterThanOrEqual(1);
    expect(res.body.data[0].patient).toBeTruthy();
    expect(res.body.data[0].patient.user).toBeTruthy();
  });

  it("filters list by patientId", async () => {
    const patient = await createPatientFixture();
    await submitRequest(patient.id);
    const res = await request(app)
      .get(`/api/v1/preauth?patientId=${patient.id}`)
      .set("Authorization", `Bearer ${receptionToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.every((r: any) => r.patientId === patient.id)).toBe(true);
  });

  it("filters list by status", async () => {
    const patient = await createPatientFixture();
    const created = await submitRequest(patient.id);
    // approve it
    await request(app)
      .patch(`/api/v1/preauth/${created.body.data.id}/status`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ status: "APPROVED", approvedAmount: 50000 });

    const res = await request(app)
      .get("/api/v1/preauth?status=APPROVED")
      .set("Authorization", `Bearer ${receptionToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.every((r: any) => r.status === "APPROVED")).toBe(true);
  });

  it("rejects list unauthenticated (401)", async () => {
    const res = await request(app).get("/api/v1/preauth");
    expect(res.status).toBe(401);
  });

  // ─── GET /preauth/:id ─────────────────────────────────────

  it("returns request detail by id", async () => {
    const patient = await createPatientFixture();
    const created = await submitRequest(patient.id);
    const id = created.body.data.id;
    const res = await request(app)
      .get(`/api/v1/preauth/${id}`)
      .set("Authorization", `Bearer ${receptionToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(id);
    expect(res.body.data.patient).toBeTruthy();
  });

  it("returns 404 when id is unknown", async () => {
    const res = await request(app)
      .get("/api/v1/preauth/00000000-0000-0000-0000-000000000404")
      .set("Authorization", `Bearer ${receptionToken}`);
    expect(res.status).toBe(404);
  });

  it("rejects GET /:id unauthenticated (401)", async () => {
    const res = await request(app).get(
      "/api/v1/preauth/00000000-0000-0000-0000-000000000000"
    );
    expect(res.status).toBe(401);
  });

  // ─── PATCH /preauth/:id/status ────────────────────────────

  it("approves a request (status APPROVED + approvedAmount + resolvedAt)", async () => {
    const patient = await createPatientFixture();
    const created = await submitRequest(patient.id);
    const id = created.body.data.id;

    const res = await request(app)
      .patch(`/api/v1/preauth/${id}/status`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        status: "APPROVED",
        approvedAmount: 60000,
        claimReferenceNumber: "CLM-XYZ",
      });
    expect(res.status).toBe(200);
    expect(res.body.data?.status).toBe("APPROVED");
    expect(res.body.data?.approvedAmount).toBe(60000);
    expect(res.body.data?.claimReferenceNumber).toBe("CLM-XYZ");
    expect(res.body.data?.resolvedAt).toBeTruthy();
  });

  it("rejects a request (status REJECTED + rejectionReason)", async () => {
    const patient = await createPatientFixture();
    const created = await submitRequest(patient.id);
    const id = created.body.data.id;

    const res = await request(app)
      .patch(`/api/v1/preauth/${id}/status`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        status: "REJECTED",
        rejectionReason: "Procedure not covered under policy",
      });
    expect(res.status).toBe(200);
    expect(res.body.data?.status).toBe("REJECTED");
    expect(res.body.data?.rejectionReason).toMatch(/not covered/i);
  });

  it("rejects PATCH with invalid status enum (400)", async () => {
    const patient = await createPatientFixture();
    const created = await submitRequest(patient.id);
    const id = created.body.data.id;

    const res = await request(app)
      .patch(`/api/v1/preauth/${id}/status`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ status: "BOGUS_STATUS" });
    expect(res.status).toBe(400);
  });

  it("rejects PATCH from DOCTOR (403)", async () => {
    const patient = await createPatientFixture();
    const created = await submitRequest(patient.id);
    const id = created.body.data.id;

    const res = await request(app)
      .patch(`/api/v1/preauth/${id}/status`)
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({ status: "APPROVED", approvedAmount: 100 });
    expect(res.status).toBe(403);
  });

  it("rejects PATCH from PATIENT (403)", async () => {
    const patient = await createPatientFixture();
    const created = await submitRequest(patient.id);
    const id = created.body.data.id;

    const res = await request(app)
      .patch(`/api/v1/preauth/${id}/status`)
      .set("Authorization", `Bearer ${patientToken}`)
      .send({ status: "APPROVED", approvedAmount: 100 });
    expect(res.status).toBe(403);
  });

  it("rejects PATCH unauthenticated (401)", async () => {
    const res = await request(app)
      .patch("/api/v1/preauth/00000000-0000-0000-0000-000000000000/status")
      .send({ status: "APPROVED" });
    expect(res.status).toBe(401);
  });
});
