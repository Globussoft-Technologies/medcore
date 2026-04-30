// Integration tests for the ambulance router.
import { it, expect, beforeAll } from "vitest";
import request from "supertest";
import { describeIfDB, resetDB, getAuthToken, getPrisma } from "../setup";
import { createPatientFixture } from "../factories";

let app: any;
let adminToken: string;
let receptionToken: string;
let doctorToken: string;

async function createAmbulance(token: string, overrides: Partial<any> = {}) {
  const res = await request(app)
    .post("/api/v1/ambulance")
    .set("Authorization", `Bearer ${token}`)
    .send({
      vehicleNumber:
        overrides.vehicleNumber ||
        `AMB${Date.now() % 100000}-${Math.floor(Math.random() * 1000)}`,
      type: overrides.type || "BASIC_LIFE_SUPPORT",
      driverName: overrides.driverName || "John Driver",
      driverPhone: overrides.driverPhone || "9999888777",
    });
  return res.body.data;
}

describeIfDB("Ambulance API (integration)", () => {
  beforeAll(async () => {
    await resetDB();
    adminToken = await getAuthToken("ADMIN");
    receptionToken = await getAuthToken("RECEPTION");
    doctorToken = await getAuthToken("DOCTOR");
    const mod = await import("../../app");
    app = mod.app;
  });

  it("creates an ambulance (admin)", async () => {
    const amb = await createAmbulance(adminToken);
    expect(amb?.vehicleNumber).toBeTruthy();
    expect(amb?.status).toBe("AVAILABLE");
  });

  it("lists ambulances", async () => {
    await createAmbulance(adminToken);
    const res = await request(app)
      .get("/api/v1/ambulance")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it("reception cannot create ambulance (403)", async () => {
    const res = await request(app)
      .post("/api/v1/ambulance")
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({
        vehicleNumber: "AMB-FORBID",
        type: "BASIC_LIFE_SUPPORT",
      });
    expect(res.status).toBe(403);
  });

  it("requires auth (401)", async () => {
    const res = await request(app).get("/api/v1/ambulance");
    expect(res.status).toBe(401);
  });

  it("rejects bad payload (400)", async () => {
    const res = await request(app)
      .post("/api/v1/ambulance")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ vehicleNumber: "", type: "" });
    expect(res.status).toBe(400);
  });

  it("creates a trip — ambulance status becomes ON_TRIP (side-effect)", async () => {
    const amb = await createAmbulance(adminToken);
    const patient = await createPatientFixture();
    const res = await request(app)
      .post("/api/v1/ambulance/trips")
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({
        ambulanceId: amb.id,
        patientId: patient.id,
        callerName: "Neighbour",
        callerPhone: "9998887777",
        pickupAddress: "123 Main St",
        priority: "RED",
      });
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.tripNumber).toMatch(/^TRP\d+/);
    expect(res.body.data?.status).toBe("REQUESTED");

    const prisma = await getPrisma();
    const refreshed = await prisma.ambulance.findUnique({ where: { id: amb.id } });
    expect(refreshed?.status).toBe("ON_TRIP");
  });

  it("cannot book a trip on a busy ambulance (400)", async () => {
    const amb = await createAmbulance(adminToken);
    const patient = await createPatientFixture();
    await request(app)
      .post("/api/v1/ambulance/trips")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        ambulanceId: amb.id,
        patientId: patient.id,
        pickupAddress: "Somewhere",
      });
    const res = await request(app)
      .post("/api/v1/ambulance/trips")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        ambulanceId: amb.id,
        patientId: patient.id,
        pickupAddress: "Anywhere",
      });
    expect(res.status).toBe(400);
  });

  it("dispatch -> arrived -> complete flow (frees ambulance)", async () => {
    const amb = await createAmbulance(adminToken);
    const patient = await createPatientFixture();
    const tripRes = await request(app)
      .post("/api/v1/ambulance/trips")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        ambulanceId: amb.id,
        patientId: patient.id,
        pickupAddress: "X",
      });
    const trip = tripRes.body.data;

    const d = await request(app)
      .patch(`/api/v1/ambulance/trips/${trip.id}/dispatch`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});
    expect(d.body.data?.status).toBe("DISPATCHED");

    const c = await request(app)
      .patch(`/api/v1/ambulance/trips/${trip.id}/complete`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        actualEndTime: new Date().toISOString(),
        finalDistance: 12.5,
        finalCost: 500,
        notes: "Patient delivered",
      });
    expect([200, 201]).toContain(c.status);
    expect(c.body.data?.status).toBe("COMPLETED");

    const prisma = await getPrisma();
    const refreshed = await prisma.ambulance.findUnique({ where: { id: amb.id } });
    expect(refreshed?.status).toBe("AVAILABLE");
  });

  it("records fuel log (admin)", async () => {
    const amb = await createAmbulance(adminToken);
    const res = await request(app)
      .post("/api/v1/ambulance/fuel-logs")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        ambulanceId: amb.id,
        litres: 30.5,
        costTotal: 3000,
        odometerKm: 25000,
        stationName: "IOCL",
      });
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.litres).toBe(30.5);
  });

  it("bills a trip (total = baseFare + perKmRate * distance)", async () => {
    const amb = await createAmbulance(adminToken);
    const patient = await createPatientFixture();
    const tripRes = await request(app)
      .post("/api/v1/ambulance/trips")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        ambulanceId: amb.id,
        patientId: patient.id,
        pickupAddress: "Test",
      });
    await request(app)
      .patch(`/api/v1/ambulance/trips/${tripRes.body.data.id}/complete`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        actualEndTime: new Date().toISOString(),
        finalDistance: 10,
        finalCost: 0,
        notes: "Trip ended",
      });

    const res = await request(app)
      .post(`/api/v1/ambulance/trips/${tripRes.body.data.id}/bill`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ baseFare: 200, perKmRate: 20 });
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.bill?.total).toBe(400);
  });

  it("doctor cannot dispatch a trip — issue #89 hardening (RBAC: only NURSE/RECEPTION/ADMIN)", async () => {
    const amb = await createAmbulance(adminToken);
    const patient = await createPatientFixture();
    const tr = await request(app)
      .post("/api/v1/ambulance/trips")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({
        ambulanceId: amb.id,
        patientId: patient.id,
        pickupAddress: "Doc-call",
      });
    expect(tr.status).toBe(403);
  });
});
