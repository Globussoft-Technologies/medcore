// Integration tests for the Insurance TPA Claims router.
// Uses the MOCK adapter (deterministic) so no real TPA credentials are needed.
// Skipped unless DATABASE_URL_TEST is set.
import { it, expect, beforeAll, beforeEach } from "vitest";
import request from "supertest";
import { describeIfDB, resetDB, getAuthToken } from "../setup";
import {
  createPatientFixture,
  createAppointmentFixture,
  createDoctorFixture,
  createInvoiceFixture,
} from "../factories";
import { resetStore } from "../../services/insurance-claims/store";
import {
  resetMockState,
  forceStatus,
  mockAdapter,
} from "../../services/insurance-claims/adapters/mock";
import {
  setAdapterOverride,
  clearAdapterOverrides,
} from "../../services/insurance-claims/registry";

let app: any;
let adminToken: string;
let receptionToken: string;
let patientToken: string;

async function makeBill() {
  const patient = await createPatientFixture({});
  const doctor = await createDoctorFixture({});
  const appt = await createAppointmentFixture({
    patientId: patient.id,
    doctorId: doctor.id,
  });
  const invoice = await createInvoiceFixture({
    patientId: patient.id,
    appointmentId: appt.id,
    overrides: { totalAmount: 50000 },
  });
  return { patient, invoice };
}

describeIfDB("Insurance TPA Claims API (integration)", () => {
  beforeAll(async () => {
    await resetDB();
    adminToken = await getAuthToken("ADMIN");
    receptionToken = await getAuthToken("RECEPTION");
    patientToken = await getAuthToken("PATIENT");
    const mod = await import("../../app");
    app = mod.app;
    // Force every TPA in the registry to resolve to the mock adapter so tests
    // never hit a real network, even if a test accidentally uses MEDI_ASSIST.
    setAdapterOverride("MEDI_ASSIST", mockAdapter);
    setAdapterOverride("PARAMOUNT", mockAdapter);
    setAdapterOverride("MOCK", mockAdapter);
  });

  beforeEach(() => {
    resetStore();
    resetMockState();
  });

  // ── 1 ─────────────────────────────────────────────────────────────────
  it("submits a claim against a valid bill and returns a providerClaimRef", async () => {
    const { patient, invoice } = await makeBill();

    const res = await request(app)
      .post("/api/v1/claims")
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({
        billId: invoice.id,
        patientId: patient.id,
        tpaProvider: "MOCK",
        insurerName: "Star Health",
        policyNumber: "POL-123",
        diagnosis: "Fever with dehydration",
        amountClaimed: 45000,
      });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe("SUBMITTED");
    expect(res.body.data.providerClaimRef).toMatch(/^MOCK-/);
    expect(res.body.data.tpaProvider).toBe("MOCK");
    expect(res.body.data.amountClaimed).toBe(45000);
  });

  // ── 2 ─────────────────────────────────────────────────────────────────
  it("rejects submission when the bill does not exist", async () => {
    const { patient } = await makeBill();
    const res = await request(app)
      .post("/api/v1/claims")
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({
        billId: "00000000-0000-0000-0000-000000000000",
        patientId: patient.id,
        tpaProvider: "MOCK",
        insurerName: "Star Health",
        policyNumber: "POL-123",
        diagnosis: "Test",
        amountClaimed: 1000,
      });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  // ── 3 ─────────────────────────────────────────────────────────────────
  it("surfaces a business-rule failure from the TPA adapter", async () => {
    const { patient, invoice } = await makeBill();
    const res = await request(app)
      .post("/api/v1/claims")
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({
        billId: invoice.id,
        patientId: patient.id,
        tpaProvider: "MOCK",
        insurerName: "Star Health",
        policyNumber: "DENY-ME", // mock adapter treats this as a lapsed policy
        diagnosis: "Fever",
        amountClaimed: 1000,
      });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe("BUSINESS_RULE");
    expect(res.body.error).toMatch(/lapsed/i);
  });

  // ── 4 ─────────────────────────────────────────────────────────────────
  it("returns the detail + timeline and reflects a forced APPROVED sync", async () => {
    const { patient, invoice } = await makeBill();
    const submit = await request(app)
      .post("/api/v1/claims")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        billId: invoice.id,
        patientId: patient.id,
        tpaProvider: "MOCK",
        insurerName: "Star Health",
        policyNumber: "POL-OK-1",
        diagnosis: "Appendicitis",
        amountClaimed: 80000,
      });
    expect(submit.status).toBe(201);
    const claimId = submit.body.data.id;
    const providerRef = submit.body.data.providerClaimRef;

    // Force the mock TPA to say APPROVED with a 75k approved amount.
    expect(
      forceStatus(providerRef, "APPROVED", {
        amountApproved: 75000,
        note: "Approved after review",
      })
    ).toBe(true);

    const detail = await request(app)
      .get(`/api/v1/claims/${claimId}?sync=1`)
      .set("Authorization", `Bearer ${adminToken}`);

    expect(detail.status).toBe(200);
    expect(detail.body.data.status).toBe("APPROVED");
    expect(detail.body.data.amountApproved).toBe(75000);
    expect(detail.body.data.approvedAt).toBeTruthy();
    expect(Array.isArray(detail.body.data.timeline)).toBe(true);
    // At least: initial SUBMITTED event + APPROVED event after sync.
    const statuses = detail.body.data.timeline.map((e: any) => e.status);
    expect(statuses).toContain("SUBMITTED");
    expect(statuses).toContain("APPROVED");
  });

  // ── 5 ─────────────────────────────────────────────────────────────────
  it("uploads a document against a submitted claim", async () => {
    const { patient, invoice } = await makeBill();
    const submit = await request(app)
      .post("/api/v1/claims")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        billId: invoice.id,
        patientId: patient.id,
        tpaProvider: "MOCK",
        insurerName: "Star Health",
        policyNumber: "POL-DOC-1",
        diagnosis: "Fracture",
        amountClaimed: 30000,
      });
    const claimId = submit.body.data.id;

    const docRes = await request(app)
      .post(`/api/v1/claims/${claimId}/documents`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        type: "DISCHARGE_SUMMARY",
        filename: "discharge.pdf",
        contentType: "application/pdf",
        content: Buffer.from("%PDF-1.4 fake").toString("base64"),
      });

    expect(docRes.status).toBe(201);
    expect(docRes.body.data.type).toBe("DISCHARGE_SUMMARY");
    expect(docRes.body.data.providerDocId).toMatch(/^DOC-/);
    expect(docRes.body.data.fileKey).toBeTruthy();
    expect(docRes.body.data.sizeBytes).toBeGreaterThan(0);
  });

  // ── 6 ─────────────────────────────────────────────────────────────────
  it("cancels a claim and records the event", async () => {
    const { patient, invoice } = await makeBill();
    const submit = await request(app)
      .post("/api/v1/claims")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        billId: invoice.id,
        patientId: patient.id,
        tpaProvider: "MOCK",
        insurerName: "Star Health",
        policyNumber: "POL-CANCEL-1",
        diagnosis: "Observation",
        amountClaimed: 5000,
      });
    const claimId = submit.body.data.id;

    const cancel = await request(app)
      .post(`/api/v1/claims/${claimId}/cancel`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ reason: "Patient switched insurer" });

    expect(cancel.status).toBe(200);
    expect(cancel.body.data.status).toBe("CANCELLED");
    expect(cancel.body.data.cancelledAt).toBeTruthy();

    const detail = await request(app)
      .get(`/api/v1/claims/${claimId}`)
      .set("Authorization", `Bearer ${adminToken}`);
    const statuses = detail.body.data.timeline.map((e: any) => e.status);
    expect(statuses).toContain("CANCELLED");
  });

  // ── 7 ─────────────────────────────────────────────────────────────────
  it("lists claims filtered by status and tpa", async () => {
    const a = await makeBill();
    const b = await makeBill();
    const c = await makeBill();

    const mk = (bill: any, pol: string) =>
      request(app)
        .post("/api/v1/claims")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({
          billId: bill.invoice.id,
          patientId: bill.patient.id,
          tpaProvider: "MOCK",
          insurerName: "Star Health",
          policyNumber: pol,
          diagnosis: "X",
          amountClaimed: 1000,
        });

    const r1 = await mk(a, "POL-A");
    const r2 = await mk(b, "POL-B");
    await mk(c, "POL-C");

    // Force r2 into APPROVED so the filter has something to match.
    forceStatus(r2.body.data.providerClaimRef, "APPROVED");
    // Trigger a sync so our store learns about the APPROVED status.
    await request(app)
      .get(`/api/v1/claims/${r2.body.data.id}?sync=1`)
      .set("Authorization", `Bearer ${adminToken}`);

    const listAll = await request(app)
      .get("/api/v1/claims")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(listAll.status).toBe(200);
    expect(listAll.body.data.length).toBe(3);

    const listApproved = await request(app)
      .get("/api/v1/claims?status=APPROVED")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(listApproved.body.data.length).toBe(1);
    expect(listApproved.body.data[0].id).toBe(r2.body.data.id);

    const listMock = await request(app)
      .get("/api/v1/claims?tpa=MOCK")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(listMock.body.data.length).toBe(3);

    // Unused to keep linter happy.
    void r1;
  });

  // ── 8 ─────────────────────────────────────────────────────────────────
  it("enforces authN + authZ", async () => {
    const { patient, invoice } = await makeBill();

    // No token → 401.
    const noAuth = await request(app).post("/api/v1/claims").send({});
    expect(noAuth.status).toBe(401);

    // PATIENT role cannot submit (only ADMIN / RECEPTION) → 403.
    const forbidden = await request(app)
      .post("/api/v1/claims")
      .set("Authorization", `Bearer ${patientToken}`)
      .send({
        billId: invoice.id,
        patientId: patient.id,
        tpaProvider: "MOCK",
        insurerName: "Star Health",
        policyNumber: "POL-Z",
        diagnosis: "X",
        amountClaimed: 1000,
      });
    expect(forbidden.status).toBe(403);
  });

  // Housekeeping — strictly not a test, just to exercise the teardown path.
  it("teardown: clears adapter overrides", () => {
    clearAdapterOverrides();
    expect(true).toBe(true);
  });
});
