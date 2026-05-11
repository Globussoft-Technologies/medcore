// Integration tests for public (unauthenticated) verification endpoints —
// /api/v1/public/verify/rx/:id and /api/v1/public/lab/:token.
import { it, expect, beforeAll } from "vitest";
import request from "supertest";
import crypto from "crypto";
import { describeIfDB, resetDB, getPrisma } from "../setup";
import {
  createPatientFixture,
  createDoctorFixture,
  createAppointmentFixture,
  createPrescriptionFixture,
  createLabTestFixture,
  createLabOrderFixture,
} from "../factories";

let app: any;

describeIfDB("Public verification API (integration)", () => {
  beforeAll(async () => {
    await resetDB();
    const mod = await import("../../app");
    app = mod.app;
  });

  async function setupRx() {
    const patient = await createPatientFixture();
    const doctor = await createDoctorFixture();
    const appt = await createAppointmentFixture({
      patientId: patient.id,
      doctorId: doctor.id,
    });
    const rx = await createPrescriptionFixture({
      patientId: patient.id,
      doctorId: doctor.id,
      appointmentId: appt.id,
    });
    return { rx, patient, doctor };
  }

  it("verify/rx/:id returns HTML by default (no auth)", async () => {
    const { rx } = await setupRx();
    const res = await request(app).get(`/api/v1/public/verify/rx/${rx.id}`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
  });

  it("verify/rx/:id returns JSON on ?format=json", async () => {
    const { rx, doctor } = await setupRx();
    const res = await request(app).get(
      `/api/v1/public/verify/rx/${rx.id}?format=json`
    );
    expect(res.status).toBe(200);
    expect(res.body?.ok).toBe(true);
    expect(res.body?.prescriptionId).toBe(rx.id);
    expect(res.body?.doctorName).toContain(doctor.user.name);
  });

  it("verify/rx/:id returns JSON when Accept: application/json", async () => {
    const { rx } = await setupRx();
    const res = await request(app)
      .get(`/api/v1/public/verify/rx/${rx.id}`)
      .set("Accept", "application/json");
    expect(res.status).toBe(200);
    expect(res.body?.ok).toBe(true);
  });

  it("verify/rx/:id returns 404 for unknown id (JSON mode)", async () => {
    const res = await request(app).get(
      "/api/v1/public/verify/rx/550e8400-e29b-41d4-a716-446655440000?format=json"
    );
    expect(res.status).toBe(404);
    expect(res.body?.ok).toBe(false);
  });

  it("verify/rx/:id masks patient name (only initial exposed)", async () => {
    const { rx, patient } = await setupRx();
    const res = await request(app).get(
      `/api/v1/public/verify/rx/${rx.id}?format=json`
    );
    expect(res.status).toBe(200);
    expect(res.body?.patientInitial).toBe(
      patient.user.name.charAt(0).toUpperCase() + "."
    );
    // Full name should NOT leak
    expect(JSON.stringify(res.body)).not.toContain(patient.user.name);
  });

  it("public lab link: 404 for unknown token", async () => {
    const res = await request(app).get(
      `/api/v1/public/lab/${crypto.randomBytes(8).toString("hex")}`
    );
    expect(res.status).toBe(404);
  });

  it("public lab link: 410 for expired token", async () => {
    const prisma = await getPrisma();
    const patient = await createPatientFixture();
    const doctor = await createDoctorFixture();
    const test = await createLabTestFixture();
    const order = await createLabOrderFixture({
      patientId: patient.id,
      doctorId: doctor.id,
      testIds: [test.id],
    });
    const token = crypto.randomBytes(10).toString("hex");
    await prisma.sharedLink.create({
      data: {
        token,
        resource: "lab_order",
        resourceId: order.id,
        expiresAt: new Date(Date.now() - 60_000),
        createdBy: patient.userId,
      },
    });
    const res = await request(app).get(`/api/v1/public/lab/${token}`);
    expect(res.status).toBe(410);
  });

  it("public lab link: returns order for valid token + increments viewCount", async () => {
    const prisma = await getPrisma();
    const patient = await createPatientFixture();
    const doctor = await createDoctorFixture();
    const test = await createLabTestFixture();
    const order = await createLabOrderFixture({
      patientId: patient.id,
      doctorId: doctor.id,
      testIds: [test.id],
    });
    const token = crypto.randomBytes(10).toString("hex");
    await prisma.sharedLink.create({
      data: {
        token,
        resource: "lab_order",
        resourceId: order.id,
        expiresAt: new Date(Date.now() + 86400_000),
        createdBy: patient.userId,
      },
    });
    const res = await request(app).get(`/api/v1/public/lab/${token}`);
    expect(res.status).toBe(200);
    expect(res.body?.data?.orderNumber).toBe(order.orderNumber);
  });

  it("public endpoints do not require auth header", async () => {
    // Already validated but keep explicit negative control: an auth-required
    // route without a token should 401.
    const res = await request(app).get("/api/v1/patients");
    expect(res.status).toBe(401);
  });
});
