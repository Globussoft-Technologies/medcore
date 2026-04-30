// Integration tests for the med-reconciliation router.
// Skipped unless DATABASE_URL_TEST is set.
import { it, expect, beforeAll } from "vitest";
import request from "supertest";
import { describeIfDB, resetDB, getAuthToken, getPrisma } from "../setup";
import {
  createPatientFixture,
  createDoctorFixture,
  createWardFixture,
  createBedFixture,
  createAdmissionFixture,
  createAppointmentFixture,
  createPrescriptionFixture,
} from "../factories";

let app: any;
let doctorToken: string;
let nurseToken: string;
let patientToken: string;

async function setupAdmissionCase() {
  const patient = await createPatientFixture();
  const doctor = await createDoctorFixture();
  const ward = await createWardFixture();
  const bed = await createBedFixture({ wardId: ward.id });
  const admission = await createAdmissionFixture({
    patientId: patient.id,
    doctorId: doctor.id,
    bedId: bed.id,
  });
  return { patient, doctor, admission };
}

describeIfDB("Med-Reconciliation API (integration)", () => {
  beforeAll(async () => {
    await resetDB();
    doctorToken = await getAuthToken("DOCTOR");
    nurseToken = await getAuthToken("NURSE");
    patientToken = await getAuthToken("PATIENT");
    const mod = await import("../../app");
    app = mod.app;
  });

  // ─── POST /med-reconciliation ─────────────────────────────

  it("creates an ADMISSION reconciliation (201)", async () => {
    const { patient, admission } = await setupAdmissionCase();
    const res = await request(app)
      .post("/api/v1/med-reconciliation")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({
        patientId: patient.id,
        admissionId: admission.id,
        reconciliationType: "ADMISSION",
        homeMedications: [
          { name: "Atorvastatin", dosage: "20mg", frequency: "OD", route: "oral" },
        ],
        hospitalMedications: [],
        dischargeMedications: [],
        patientCounseled: false,
      });
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.patientId).toBe(patient.id);
    expect(res.body.data?.reconciliationType).toBe("ADMISSION");
  });

  it("auto-extracts home meds from prescriptions when omitted", async () => {
    const { patient, doctor, admission } = await setupAdmissionCase();
    const appt = await createAppointmentFixture({
      patientId: patient.id,
      doctorId: doctor.id,
    });
    await createPrescriptionFixture({
      patientId: patient.id,
      doctorId: doctor.id,
      appointmentId: appt.id,
    });
    const res = await request(app)
      .post("/api/v1/med-reconciliation")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({
        patientId: patient.id,
        admissionId: admission.id,
        reconciliationType: "ADMISSION",
        homeMedications: [],
      });
    expect([200, 201]).toContain(res.status);
    const home = res.body.data?.homeMedications as any[];
    expect(Array.isArray(home)).toBe(true);
    // Prescription factory creates a Paracetamol entry
    expect(home.some((m: any) => /paracetamol/i.test(m.name))).toBe(true);
  });

  it("rejects an unauthenticated POST (401)", async () => {
    const res = await request(app)
      .post("/api/v1/med-reconciliation")
      .send({
        patientId: "550e8400-e29b-41d4-a716-446655440099",
        reconciliationType: "ADMISSION",
      });
    expect(res.status).toBe(401);
  });

  it("rejects PATIENT role from creating (403)", async () => {
    const { patient, admission } = await setupAdmissionCase();
    const res = await request(app)
      .post("/api/v1/med-reconciliation")
      .set("Authorization", `Bearer ${patientToken}`)
      .send({
        patientId: patient.id,
        admissionId: admission.id,
        reconciliationType: "ADMISSION",
      });
    expect(res.status).toBe(403);
  });

  it("rejects invalid POST payload (400)", async () => {
    const res = await request(app)
      .post("/api/v1/med-reconciliation")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({
        patientId: "not-a-uuid",
        reconciliationType: "BOGUS_TYPE",
      });
    expect(res.status).toBe(400);
  });

  // ─── GET /med-reconciliation ──────────────────────────────

  it("lists reconciliations filtered by patientId", async () => {
    const { patient, admission } = await setupAdmissionCase();
    await request(app)
      .post("/api/v1/med-reconciliation")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({
        patientId: patient.id,
        admissionId: admission.id,
        reconciliationType: "ADMISSION",
        homeMedications: [
          { name: "Metformin", dosage: "500mg", frequency: "BID", route: "oral" },
        ],
      });
    const res = await request(app)
      .get(`/api/v1/med-reconciliation?patientId=${patient.id}`)
      .set("Authorization", `Bearer ${nurseToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeGreaterThanOrEqual(1);
    expect(res.body.data[0].patientId).toBe(patient.id);
  });

  it("rejects unauthenticated GET list (401)", async () => {
    const res = await request(app).get("/api/v1/med-reconciliation");
    expect(res.status).toBe(401);
  });

  // ─── GET /med-reconciliation/suggest ──────────────────────

  it("suggest returns home + hospital meds for an admission", async () => {
    const { patient, doctor, admission } = await setupAdmissionCase();
    const appt = await createAppointmentFixture({
      patientId: patient.id,
      doctorId: doctor.id,
    });
    await createPrescriptionFixture({
      patientId: patient.id,
      doctorId: doctor.id,
      appointmentId: appt.id,
    });
    const res = await request(app)
      .get(
        `/api/v1/med-reconciliation/suggest?patientId=${patient.id}&admissionId=${admission.id}`
      )
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toBeTruthy();
    expect(Array.isArray(res.body.data.homeMedications)).toBe(true);
    expect(Array.isArray(res.body.data.hospitalMedications)).toBe(true);
  });

  it("suggest returns 400 when patientId is missing", async () => {
    const res = await request(app)
      .get("/api/v1/med-reconciliation/suggest")
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/patientId/i);
  });

  it("rejects unauthenticated GET suggest (401)", async () => {
    const res = await request(app).get(
      "/api/v1/med-reconciliation/suggest?patientId=00000000-0000-0000-0000-000000000000"
    );
    expect(res.status).toBe(401);
  });

  // ─── GET /med-reconciliation/:id ──────────────────────────

  it("GET /:id returns the row with computed diff", async () => {
    const { patient, admission } = await setupAdmissionCase();
    const created = await request(app)
      .post("/api/v1/med-reconciliation")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({
        patientId: patient.id,
        admissionId: admission.id,
        reconciliationType: "DISCHARGE",
        homeMedications: [
          { name: "Aspirin", dosage: "75mg", frequency: "OD", route: "oral" },
        ],
        hospitalMedications: [
          { name: "Heparin", dosage: "5000U", frequency: "BID", route: "SC" },
        ],
        dischargeMedications: [
          { name: "Aspirin", dosage: "75mg", frequency: "OD", route: "oral" },
          { name: "Clopidogrel", dosage: "75mg", frequency: "OD", route: "oral" },
        ],
      });
    expect([200, 201]).toContain(created.status);
    const id = created.body.data.id;

    const res = await request(app)
      .get(`/api/v1/med-reconciliation/${id}`)
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.diff).toBeTruthy();
    expect(res.body.data.diff.homeContinuedOnDischarge).toContain("Aspirin");
    expect(res.body.data.diff.newOnDischarge).toContain("Clopidogrel");
  });

  it("GET /:id returns 404 when not found", async () => {
    const res = await request(app)
      .get("/api/v1/med-reconciliation/00000000-0000-0000-0000-000000000404")
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(res.status).toBe(404);
  });

  it("rejects unauthenticated GET /:id (401)", async () => {
    const res = await request(app).get(
      "/api/v1/med-reconciliation/00000000-0000-0000-0000-000000000000"
    );
    expect(res.status).toBe(401);
  });

  // ─── PATCH /med-reconciliation/:id ────────────────────────

  it("PATCH /:id updates patientCounseled + notes", async () => {
    const { patient, admission } = await setupAdmissionCase();
    const created = await request(app)
      .post("/api/v1/med-reconciliation")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({
        patientId: patient.id,
        admissionId: admission.id,
        reconciliationType: "ADMISSION",
        homeMedications: [
          { name: "Losartan", dosage: "50mg", frequency: "OD", route: "oral" },
        ],
      });
    expect([200, 201]).toContain(created.status);
    const id = created.body.data.id;

    const res = await request(app)
      .patch(`/api/v1/med-reconciliation/${id}`)
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({ patientCounseled: true, notes: "Patient briefed on side effects" });
    expect(res.status).toBe(200);
    expect(res.body.data?.patientCounseled).toBe(true);
    expect(res.body.data?.notes).toBe("Patient briefed on side effects");

    const prisma = await getPrisma();
    const refreshed = await prisma.medReconciliation.findUnique({ where: { id } });
    expect(refreshed?.patientCounseled).toBe(true);
  });

  it("rejects PATCH from PATIENT role (403)", async () => {
    const { patient, admission } = await setupAdmissionCase();
    const created = await request(app)
      .post("/api/v1/med-reconciliation")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({
        patientId: patient.id,
        admissionId: admission.id,
        reconciliationType: "ADMISSION",
      });
    const id = created.body.data.id;

    const res = await request(app)
      .patch(`/api/v1/med-reconciliation/${id}`)
      .set("Authorization", `Bearer ${patientToken}`)
      .send({ patientCounseled: true });
    expect(res.status).toBe(403);
  });

  it("rejects PATCH unauthenticated (401)", async () => {
    const res = await request(app)
      .patch("/api/v1/med-reconciliation/00000000-0000-0000-0000-000000000000")
      .send({ patientCounseled: true });
    expect(res.status).toBe(401);
  });

  it("rejects PATCH with invalid payload (400)", async () => {
    const { patient, admission } = await setupAdmissionCase();
    const created = await request(app)
      .post("/api/v1/med-reconciliation")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({
        patientId: patient.id,
        admissionId: admission.id,
        reconciliationType: "ADMISSION",
      });
    const id = created.body.data.id;

    const res = await request(app)
      .patch(`/api/v1/med-reconciliation/${id}`)
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({ reconciliationType: "NOT_A_VALID_TYPE" });
    expect(res.status).toBe(400);
  });
});
