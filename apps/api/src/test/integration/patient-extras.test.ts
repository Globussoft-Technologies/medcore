// Integration tests for patient-extras router (vitals baseline, id card,
// CCDA export, dashboard preferences, certificates).
import { it, expect, beforeAll } from "vitest";
import request from "supertest";
import { describeIfDB, resetDB, getAuthToken } from "../setup";
import { createPatientFixture } from "../factories";

let app: any;
let adminToken: string;
let doctorToken: string;
let nurseToken: string;

describeIfDB("Patient extras API (integration)", () => {
  beforeAll(async () => {
    await resetDB();
    adminToken = await getAuthToken("ADMIN");
    doctorToken = await getAuthToken("DOCTOR");
    nurseToken = await getAuthToken("NURSE");
    const mod = await import("../../app");
    app = mod.app;
  });

  it("returns vitals baseline (empty is OK)", async () => {
    const patient = await createPatientFixture();
    const res = await request(app)
      .get(`/api/v1/patients/${patient.id}/vitals-baseline`)
      .set("Authorization", `Bearer ${nurseToken}`);
    expect(res.status).toBe(200);
  });

  it("requires auth (401)", async () => {
    const patient = await createPatientFixture();
    const res = await request(app).get(
      `/api/v1/patients/${patient.id}/vitals-baseline`
    );
    expect(res.status).toBe(401);
  });

  it("renders patient ID card as HTML", async () => {
    const patient = await createPatientFixture();
    const res = await request(app)
      .get(`/api/v1/patients/${patient.id}/id-card`)
      .set("Authorization", `Bearer ${nurseToken}`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
  });

  it("id-card returns 404 for unknown patient", async () => {
    const res = await request(app)
      .get("/api/v1/patients/550e8400-e29b-41d4-a716-446655440000/id-card")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
  });

  it("fitness certificate: doctor allowed", async () => {
    const patient = await createPatientFixture();
    const res = await request(app)
      .get(
        `/api/v1/patients/${patient.id}/fitness-certificate?purpose=driving`
      )
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
  });

  it("fitness certificate: nurse forbidden (403)", async () => {
    const patient = await createPatientFixture();
    const res = await request(app)
      .get(`/api/v1/patients/${patient.id}/fitness-certificate`)
      .set("Authorization", `Bearer ${nurseToken}`);
    expect(res.status).toBe(403);
  });

  it("CCDA export contains patient MRN + demographics", async () => {
    const patient = await createPatientFixture();
    const res = await request(app)
      .get(`/api/v1/patients/${patient.id}/ccda`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const body = JSON.parse(res.text);
    expect(body.documentType).toBe("CCDA_SIMPLIFIED");
    expect(body.patient?.mrNumber).toBe(patient.mrNumber);
  });

  it("CCDA returns 404 for unknown patient", async () => {
    const res = await request(app)
      .get("/api/v1/patients/550e8400-e29b-41d4-a716-446655440000/ccda")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
  });

  it("returns empty dashboard preferences for fresh user", async () => {
    const res = await request(app)
      .get("/api/v1/users/me/dashboard-preferences")
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data?.layout).toBeTruthy();
  });

  it("upserts dashboard preferences (side-effect: saved)", async () => {
    const payload = {
      layout: { widgets: [{ type: "appointments", visible: true }] },
    };
    const res = await request(app)
      .put("/api/v1/users/me/dashboard-preferences")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send(payload);
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.layout).toBeTruthy();

    const check = await request(app)
      .get("/api/v1/users/me/dashboard-preferences")
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(check.body.data?.layout?.widgets?.length).toBe(1);
  });

  it("rejects malformed dashboard payload (400)", async () => {
    const res = await request(app)
      .put("/api/v1/users/me/dashboard-preferences")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({ layout: "not-an-object" });
    expect(res.status).toBe(400);
  });
});
