// Integration tests for emergency router.
import { it, expect, beforeAll } from "vitest";
import request from "supertest";
import { describeIfDB, resetDB, getAuthToken } from "../setup";
import {
  createPatientFixture,
  createDoctorFixture,
} from "../factories";

let app: any;
let adminToken: string;
let nurseToken: string;

describeIfDB("Emergency API (integration)", () => {
  beforeAll(async () => {
    await resetDB();
    adminToken = await getAuthToken("ADMIN");
    nurseToken = await getAuthToken("NURSE");
    const mod = await import("../../app");
    app = mod.app;
  });

  it("registers an emergency case for an existing patient", async () => {
    const patient = await createPatientFixture();
    const res = await request(app)
      .post("/api/v1/emergency/cases")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        patientId: patient.id,
        chiefComplaint: "Chest pain",
        arrivalMode: "Walk-in",
      });
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.caseNumber).toMatch(/^ER\d+/);
    expect(res.body.data?.status).toBe("WAITING");
  });

  it("registers an unknown patient emergency case", async () => {
    const res = await request(app)
      .post("/api/v1/emergency/cases")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        unknownName: "John Doe",
        unknownAge: 45,
        unknownGender: "MALE",
        chiefComplaint: "Unresponsive",
        arrivalMode: "Ambulance",
      });
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.unknownName).toBe("John Doe");
  });

  it("rejects case without patientId AND unknownName", async () => {
    const res = await request(app)
      .post("/api/v1/emergency/cases")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ chiefComplaint: "Collapse" });
    expect(res.status).toBe(400);
  });

  it("triages a case (sets triageLevel, triagedAt)", async () => {
    const patient = await createPatientFixture();
    const createRes = await request(app)
      .post("/api/v1/emergency/cases")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ patientId: patient.id, chiefComplaint: "Fever" });
    const caseId = createRes.body.data.id;
    const res = await request(app)
      .patch(`/api/v1/emergency/cases/${caseId}/triage`)
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({
        triageLevel: "URGENT",
        vitalsBP: "130/80",
        vitalsPulse: 90,
        vitalsSpO2: 97,
      });
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.triageLevel).toBe("URGENT");
    expect(res.body.data?.triagedAt).toBeTruthy();
    expect(res.body.data?.status).toBe("TRIAGED");
  });

  it("assigns a doctor to a case", async () => {
    const patient = await createPatientFixture();
    const doctor = await createDoctorFixture();
    const createRes = await request(app)
      .post("/api/v1/emergency/cases")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ patientId: patient.id, chiefComplaint: "Fracture" });
    const caseId = createRes.body.data.id;
    const res = await request(app)
      .patch(`/api/v1/emergency/cases/${caseId}/assign`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ attendingDoctorId: doctor.id });
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.attendingDoctorId).toBe(doctor.id);
    expect(res.body.data?.status).toBe("IN_TREATMENT");
  });

  it("computes trauma score (RTS)", async () => {
    const patient = await createPatientFixture();
    const createRes = await request(app)
      .post("/api/v1/emergency/cases")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ patientId: patient.id, chiefComplaint: "RTA" });
    const caseId = createRes.body.data.id;
    const res = await request(app)
      .post(`/api/v1/emergency/cases/${caseId}/trauma-score`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ rtsRespiratory: 4, rtsSystolic: 4, rtsGCS: 4 });
    expect([200, 201]).toContain(res.status);
  });

  it("closes a case with disposition", async () => {
    const patient = await createPatientFixture();
    const createRes = await request(app)
      .post("/api/v1/emergency/cases")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ patientId: patient.id, chiefComplaint: "Headache" });
    const caseId = createRes.body.data.id;
    const res = await request(app)
      .patch(`/api/v1/emergency/cases/${caseId}/close`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ status: "DISCHARGED", disposition: "Home", outcomeNotes: "Stable" });
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.status).toBe("DISCHARGED");
    expect(res.body.data?.closedAt).toBeTruthy();
  });

  it("lists active cases", async () => {
    const res = await request(app)
      .get("/api/v1/emergency/cases/active")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it("returns stats", async () => {
    const res = await request(app)
      .get("/api/v1/emergency/stats")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
  });

  it("rejects unauthenticated access", async () => {
    const res = await request(app).get("/api/v1/emergency/cases");
    expect(res.status).toBe(401);
  });
});
