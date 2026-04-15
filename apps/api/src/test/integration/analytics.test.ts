// Integration tests for analytics router.
import { it, expect, beforeAll } from "vitest";
import request from "supertest";
import { describeIfDB, resetDB, getAuthToken } from "../setup";
import {
  createPatientFixture,
  createDoctorFixture,
  createAppointmentFixture,
  createInvoiceFixture,
} from "../factories";

let app: any;
let adminToken: string;

async function seedSomeData() {
  const patient = await createPatientFixture();
  const doctor = await createDoctorFixture();
  const appt = await createAppointmentFixture({
    patientId: patient.id,
    doctorId: doctor.id,
    overrides: { status: "COMPLETED" },
  });
  await createInvoiceFixture({
    patientId: patient.id,
    appointmentId: appt.id,
    overrides: { paymentStatus: "PAID" },
  });
}

describeIfDB("Analytics API (integration)", () => {
  beforeAll(async () => {
    await resetDB();
    adminToken = await getAuthToken("ADMIN");
    const mod = await import("../../app");
    app = mod.app;
    await seedSomeData();
  });

  it("returns overview", async () => {
    const res = await request(app)
      .get("/api/v1/analytics/overview")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toBeTruthy();
  });

  it("returns overview with period query (month)", async () => {
    const res = await request(app)
      .get("/api/v1/analytics/overview?period=month")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
  });

  it("returns revenue analytics", async () => {
    const res = await request(app)
      .get("/api/v1/analytics/revenue")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
  });

  it("returns revenue breakdown", async () => {
    const res = await request(app)
      .get("/api/v1/analytics/revenue/breakdown")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
  });

  it("returns appointments stats", async () => {
    const res = await request(app)
      .get("/api/v1/analytics/appointments")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
  });

  it("returns no-show analysis", async () => {
    const res = await request(app)
      .get("/api/v1/analytics/appointments/no-show-rate")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
  });

  it("returns patient retention metrics", async () => {
    const res = await request(app)
      .get("/api/v1/analytics/patients/retention")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
  });

  it("returns patient growth", async () => {
    const res = await request(app)
      .get("/api/v1/analytics/patients/growth")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
  });

  it("returns ER performance", async () => {
    const res = await request(app)
      .get("/api/v1/analytics/er/performance")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
  });

  it("returns IPD occupancy", async () => {
    const res = await request(app)
      .get("/api/v1/analytics/ipd/occupancy")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
  });

  it("exports revenue as CSV (text/csv)", async () => {
    const res = await request(app)
      .get("/api/v1/analytics/export/revenue.csv")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/csv/i);
  });

  it("exports appointments as CSV", async () => {
    const res = await request(app)
      .get("/api/v1/analytics/export/appointments.csv")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/csv/i);
  });

  it("exports patients as CSV", async () => {
    const res = await request(app)
      .get("/api/v1/analytics/export/patients.csv")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/csv/i);
  });

  it("rejects unauthenticated access", async () => {
    const res = await request(app).get("/api/v1/analytics/overview");
    expect(res.status).toBe(401);
  });
});
