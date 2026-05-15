// Integration test for the patients router. Skipped unless DATABASE_URL_TEST is set.
import { it, expect, beforeAll } from "vitest";
import request from "supertest";
import { describeIfDB, resetDB, getAuthToken, getPrisma } from "../setup";
import { createPatientFixture } from "../factories";

let app: any;
let token: string;
let doctorToken: string;
let nurseToken: string;
let adminToken: string;
let patientToken: string;

describeIfDB("Patients API (integration)", () => {
  beforeAll(async () => {
    await resetDB();
    token = await getAuthToken("RECEPTION");
    doctorToken = await getAuthToken("DOCTOR");
    nurseToken = await getAuthToken("NURSE");
    adminToken = await getAuthToken("ADMIN");
    patientToken = await getAuthToken("PATIENT");
    const mod = await import("../../app");
    app = mod.app;
  });

  it("creates a patient", async () => {
    const res = await request(app)
      .post("/api/v1/patients")
      .set("Authorization", `Bearer ${token}`)
      .send({
        name: "Integration Patient",
        gender: "FEMALE",
        phone: "9000000001",
      });
    expect(res.status).toBeLessThan(400);
  });

  it("lists patients", async () => {
    const res = await request(app)
      .get("/api/v1/patients")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
  });

  it("rejects unauthorised request", async () => {
    const res = await request(app).get("/api/v1/patients");
    expect(res.status).toBe(401);
  });

  it("rejects invalid create payload", async () => {
    const res = await request(app)
      .post("/api/v1/patients")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "" });
    expect(res.status).toBe(400);
  });

  // Issue #892: name + DOB exact match is a near-certain duplicate.
  it("rejects a duplicate patient with the same name + date of birth (409, #892)", async () => {
    const dob = "1990-06-15";
    const first = await request(app)
      .post("/api/v1/patients")
      .set("Authorization", `Bearer ${token}`)
      .send({
        name: "Rohan Duplicate Mehta",
        gender: "MALE",
        phone: "9100000011",
        dateOfBirth: dob,
      });
    expect(first.status).toBeLessThan(400);

    // Same name + same DOB, DIFFERENT phone — the exact gap #892 reports.
    const dup = await request(app)
      .post("/api/v1/patients")
      .set("Authorization", `Bearer ${token}`)
      .send({
        name: "Rohan Duplicate Mehta",
        gender: "MALE",
        phone: "9100000022",
        dateOfBirth: dob,
      });
    expect(dup.status).toBe(409);
    expect(dup.body.existingPatient?.mrNumber).toBeTruthy();
  });

  it("allows two distinct patients with the same name but different DOB (#892 — no false positive)", async () => {
    const a = await request(app)
      .post("/api/v1/patients")
      .set("Authorization", `Bearer ${token}`)
      .send({
        name: "Common Name Sharma",
        gender: "FEMALE",
        phone: "9100000033",
        dateOfBirth: "1985-03-10",
      });
    expect(a.status).toBeLessThan(400);
    const b = await request(app)
      .post("/api/v1/patients")
      .set("Authorization", `Bearer ${token}`)
      .send({
        name: "Common Name Sharma",
        gender: "FEMALE",
        phone: "9100000044",
        dateOfBirth: "2014-11-22",
      });
    // Different birth date → genuinely different people → must be allowed.
    expect(b.status).toBeLessThan(400);
  });

  // ─────────────────────────────────────────────────────────
  // PATCH /api/v1/patients/:id  (Issue #39)
  // ─────────────────────────────────────────────────────────

  it("PATCH: doctor can update patient demographics", async () => {
    const patient = await createPatientFixture();
    const res = await request(app)
      .patch(`/api/v1/patients/${patient.id}`)
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({
        name: "Updated Name",
        phone: "9999999999",
        address: "New Address",
        bloodGroup: "B+",
      });
    expect(res.status).toBe(200);
    expect(res.body.data.user.name).toBe("Updated Name");
    expect(res.body.data.user.phone).toBe("9999999999");
    expect(res.body.data.bloodGroup).toBe("B+");
    // MR number must be unchanged.
    expect(res.body.data.mrNumber).toBe(patient.mrNumber);
  });

  it("PATCH: nurse can update patient demographics", async () => {
    const patient = await createPatientFixture();
    const res = await request(app)
      .patch(`/api/v1/patients/${patient.id}`)
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({ address: "Corrected Street 12" });
    expect(res.status).toBe(200);
    expect(res.body.data.address).toBe("Corrected Street 12");
  });

  it("PATCH: reception can update patient demographics", async () => {
    const patient = await createPatientFixture();
    const res = await request(app)
      .patch(`/api/v1/patients/${patient.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Reception Edit" });
    expect(res.status).toBe(200);
    expect(res.body.data.user.name).toBe("Reception Edit");
  });

  it("PATCH: PATIENT role is forbidden (403)", async () => {
    const patient = await createPatientFixture();
    const res = await request(app)
      .patch(`/api/v1/patients/${patient.id}`)
      .set("Authorization", `Bearer ${patientToken}`)
      .send({ name: "Hacked" });
    expect(res.status).toBe(403);
  });

  it("PATCH: invalid payload returns 400", async () => {
    const patient = await createPatientFixture();
    const res = await request(app)
      .patch(`/api/v1/patients/${patient.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        // name too short, phone too short, gender invalid
        name: "x",
        phone: "123",
        gender: "INVALID",
      });
    expect(res.status).toBe(400);
  });

  it("PATCH: MR number cannot be changed even if passed in body", async () => {
    const patient = await createPatientFixture();
    const originalMr = patient.mrNumber;
    const res = await request(app)
      .patch(`/api/v1/patients/${patient.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        name: "Still Valid",
        mrNumber: "MR-HACKED",
      });
    expect(res.status).toBe(200);
    expect(res.body.data.mrNumber).toBe(originalMr);
  });

  it("PATCH: writes an audit log entry", async () => {
    const patient = await createPatientFixture();
    const prisma = await getPrisma();
    const before = await prisma.auditLog.count({
      where: { entity: "patient", entityId: patient.id, action: "PATIENT_UPDATE" },
    });
    await request(app)
      .patch(`/api/v1/patients/${patient.id}`)
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({ phone: "9000011111" })
      .expect(200);
    // auditLog is fire-and-forget; allow a brief window for the insert.
    await new Promise((r) => setTimeout(r, 50));
    const after = await prisma.auditLog.count({
      where: { entity: "patient", entityId: patient.id, action: "PATIENT_UPDATE" },
    });
    expect(after).toBeGreaterThan(before);
  });
});
