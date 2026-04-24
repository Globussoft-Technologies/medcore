// Integration tests covering the RBAC-negative cases that shipped alongside
// GitHub issues #14, #29, #30. We assert:
//   * Doctors cannot POST /api/v1/lab/results (403) — separation of duties.
//   * Lab techs CAN POST /api/v1/lab/results (201) — regression guard.
//   * GET /api/v1/nurse-rounds without admissionId returns 400 (contract).
//   * GET /api/v1/nurse-rounds?admissionId=<valid> returns 200 + array.
import { it, expect, beforeAll } from "vitest";
import request from "supertest";
import { describeIfDB, resetDB, getAuthToken, getPrisma } from "../setup";
import {
  createPatientFixture,
  createDoctorWithToken,
  createLabTestFixture,
  createLabOrderFixture,
  createWardFixture,
  createBedFixture,
  createAdmissionFixture,
} from "../factories";

let app: any;
let adminToken: string;
let doctorToken: string;
let labTechToken: string;
let nurseToken: string;

describeIfDB("RBAC negatives (lab results + nurse rounds)", () => {
  beforeAll(async () => {
    await resetDB();
    adminToken = await getAuthToken("ADMIN");
    doctorToken = await getAuthToken("DOCTOR");
    labTechToken = await getAuthToken("LAB_TECH");
    nurseToken = await getAuthToken("NURSE");
    const mod = await import("../../app");
    app = mod.app;
  });

  // ─── Issue #14 — lab result entry RBAC ────────────────────

  it("doctor token cannot POST /lab/results (403)", async () => {
    const { doctor } = await createDoctorWithToken();
    const patient = await createPatientFixture();
    const test = await createLabTestFixture();
    const order = await createLabOrderFixture({
      patientId: patient.id,
      doctorId: doctor.id,
      testIds: [test.id],
    });

    const res = await request(app)
      .post("/api/v1/lab/results")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({
        orderItemId: order.items[0].id,
        parameter: "Hemoglobin",
        value: "13.5",
        unit: "g/dL",
      });

    expect(res.status).toBe(403);
  });

  it("nurse token cannot POST /lab/results (403)", async () => {
    const { doctor } = await createDoctorWithToken();
    const patient = await createPatientFixture();
    const test = await createLabTestFixture();
    const order = await createLabOrderFixture({
      patientId: patient.id,
      doctorId: doctor.id,
      testIds: [test.id],
    });

    const res = await request(app)
      .post("/api/v1/lab/results")
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({
        orderItemId: order.items[0].id,
        parameter: "Hemoglobin",
        value: "13.5",
      });

    expect(res.status).toBe(403);
  });

  it("lab tech can POST /lab/results (201)", async () => {
    const { doctor } = await createDoctorWithToken();
    const patient = await createPatientFixture();
    const test = await createLabTestFixture();
    const order = await createLabOrderFixture({
      patientId: patient.id,
      doctorId: doctor.id,
      testIds: [test.id],
    });

    const res = await request(app)
      .post("/api/v1/lab/results")
      .set("Authorization", `Bearer ${labTechToken}`)
      .send({
        orderItemId: order.items[0].id,
        parameter: "Hemoglobin",
        value: "14.0",
        unit: "g/dL",
        flag: "NORMAL",
      });

    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.parameter).toBe("Hemoglobin");
  });

  it("admin can POST /lab/results (201)", async () => {
    const { doctor } = await createDoctorWithToken();
    const patient = await createPatientFixture();
    const test = await createLabTestFixture();
    const order = await createLabOrderFixture({
      patientId: patient.id,
      doctorId: doctor.id,
      testIds: [test.id],
    });

    const res = await request(app)
      .post("/api/v1/lab/results")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        orderItemId: order.items[0].id,
        parameter: "WBC",
        value: "7.5",
        unit: "10^9/L",
      });

    expect([200, 201]).toContain(res.status);
  });

  // ─── Issues #29 / #30 — nurse rounds shape ────────────────

  it("GET /nurse-rounds without admissionId returns 400", async () => {
    const res = await request(app)
      .get("/api/v1/nurse-rounds")
      .set("Authorization", `Bearer ${nurseToken}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/admissionId/i);
  });

  it("GET /nurse-rounds?admissionId=<id> returns 200 array for nurse", async () => {
    const { doctor } = await createDoctorWithToken();
    const patient = await createPatientFixture();
    const ward = await createWardFixture();
    const bed = await createBedFixture({ wardId: ward.id });
    const admission = await createAdmissionFixture({
      patientId: patient.id,
      doctorId: doctor.id,
      bedId: bed.id,
    });

    // Create a round via the API so the nurse is set as performer.
    await request(app)
      .post("/api/v1/nurse-rounds")
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({ admissionId: admission.id, notes: "stable" });

    const res = await request(app)
      .get(`/api/v1/nurse-rounds?admissionId=${admission.id}`)
      .set("Authorization", `Bearer ${nurseToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeGreaterThanOrEqual(1);
    // Shape guard for the web workstation which reads performedAt+admission.
    expect(res.body.data[0]).toHaveProperty("performedAt");
    expect(res.body.data[0]).toHaveProperty("nurseId");
  });

  // avoid unused-import warning if a test case is dropped in future
  void getPrisma;
});
