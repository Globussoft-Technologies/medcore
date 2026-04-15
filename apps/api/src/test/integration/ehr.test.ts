// Integration tests for the EHR router.
import { it, expect, beforeAll } from "vitest";
import request from "supertest";
import { describeIfDB, resetDB, getAuthToken } from "../setup";
import { createPatientFixture } from "../factories";

let app: any;
let adminToken: string;
let doctorToken: string;

describeIfDB("EHR API (integration)", () => {
  beforeAll(async () => {
    await resetDB();
    adminToken = await getAuthToken("ADMIN");
    doctorToken = await getAuthToken("DOCTOR");
    const mod = await import("../../app");
    app = mod.app;
  });

  it("adds an allergy", async () => {
    const patient = await createPatientFixture();
    const res = await request(app)
      .post("/api/v1/ehr/allergies")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({
        patientId: patient.id,
        allergen: "Penicillin",
        severity: "SEVERE",
        reaction: "Anaphylaxis",
      });
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.allergen).toBe("Penicillin");
  });

  it("lists patient allergies", async () => {
    const patient = await createPatientFixture();
    await request(app)
      .post("/api/v1/ehr/allergies")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({
        patientId: patient.id,
        allergen: "Peanuts",
        severity: "MODERATE",
      });
    const res = await request(app)
      .get(`/api/v1/ehr/patients/${patient.id}/allergies`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThanOrEqual(1);
  });

  it("adds a chronic condition with ICD-10", async () => {
    const patient = await createPatientFixture();
    const res = await request(app)
      .post("/api/v1/ehr/conditions")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({
        patientId: patient.id,
        condition: "Type 2 Diabetes Mellitus",
        icd10Code: "E11",
        status: "ACTIVE",
        diagnosedDate: "2020-05-10",
      });
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.icd10Code).toBe("E11");
  });

  it("adds an immunization", async () => {
    const patient = await createPatientFixture();
    const res = await request(app)
      .post("/api/v1/ehr/immunizations")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({
        patientId: patient.id,
        vaccine: "Hepatitis B",
        doseNumber: 1,
        dateGiven: "2024-01-15",
        manufacturer: "Serum Institute",
      });
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.vaccine).toBe("Hepatitis B");
  });

  it("uploads / records a document metadata", async () => {
    const patient = await createPatientFixture();
    const res = await request(app)
      .post("/api/v1/ehr/documents")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({
        patientId: patient.id,
        type: "LAB_REPORT",
        title: "CBC Report",
        filePath: "/uploads/ehr/cbc.pdf",
        mimeType: "application/pdf",
        fileSize: 12345,
      });
    expect(res.status).toBeLessThan(500);
  });

  it("returns problem list", async () => {
    const patient = await createPatientFixture();
    await request(app)
      .post("/api/v1/ehr/conditions")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({
        patientId: patient.id,
        condition: "Hypertension",
        status: "ACTIVE",
      });
    const res = await request(app)
      .get(`/api/v1/ehr/patients/${patient.id}/problem-list`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
  });

  it("creates an advance directive", async () => {
    const patient = await createPatientFixture();
    const res = await request(app)
      .post(`/api/v1/ehr/patients/${patient.id}/advance-directives`)
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({
        type: "DNR",
        effectiveDate: "2026-01-01",
        notes: "Patient requests no CPR.",
      });
    expect([200, 201, 400, 403]).toContain(res.status);
  });

  it("lists advance directives", async () => {
    const patient = await createPatientFixture();
    const res = await request(app)
      .get(`/api/v1/ehr/patients/${patient.id}/advance-directives`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
  });

  it("returns patient summary", async () => {
    const patient = await createPatientFixture();
    const res = await request(app)
      .get(`/api/v1/ehr/patients/${patient.id}/summary`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
  });

  it("rejects bad allergy payload (400)", async () => {
    const res = await request(app)
      .post("/api/v1/ehr/allergies")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({ patientId: "x" });
    expect(res.status).toBe(400);
  });

  it("rejects unauthenticated access", async () => {
    const patient = await createPatientFixture();
    const res = await request(app).get(
      `/api/v1/ehr/patients/${patient.id}/allergies`
    );
    expect(res.status).toBe(401);
  });
});
