// Integration tests for Issue #87 — Ambulance validation tightening.
//
// Covers four bug classes from the ticket:
//   1. Phone numbers entered with no format validation (gibberish accepted).
//   2. Empty "Complete trip" form accepted by the API.
//   3. Negative distance / cost values silently saved.
//   4. Fleet view shows AVAILABLE while an in-progress trip exists.
//
// The fleet status logic flips an ambulance to ON_TRIP whenever any of its
// trips is in a non-terminal state, and back to AVAILABLE only once every
// trip is COMPLETED or CANCELLED — verified via `recomputeAmbulanceStatus`
// (called from every trip mutation path) being idempotent.
import { it, expect, beforeAll } from "vitest";
import request from "supertest";
import { describeIfDB, resetDB, getAuthToken, getPrisma } from "../setup";
import { createPatientFixture } from "../factories";

let app: any;
let adminToken: string;
let receptionToken: string;

async function createAmbulance(overrides: Partial<any> = {}) {
  const res = await request(app)
    .post("/api/v1/ambulance")
    .set("Authorization", `Bearer ${adminToken}`)
    .send({
      vehicleNumber:
        overrides.vehicleNumber ||
        `AMBV${Date.now() % 100000}-${Math.floor(Math.random() * 1000)}`,
      type: overrides.type || "BLS",
      driverName: overrides.driverName || "Driver",
      driverPhone: overrides.driverPhone || "9999888777",
    });
  return res.body.data;
}

async function startTrip(ambulanceId: string) {
  const patient = await createPatientFixture();
  const tr = await request(app)
    .post("/api/v1/ambulance/trips")
    .set("Authorization", `Bearer ${receptionToken}`)
    .send({
      ambulanceId,
      patientId: patient.id,
      pickupAddress: "123 Test Street",
    });
  return tr.body.data;
}

describeIfDB("Ambulance validation (Issue #87)", () => {
  beforeAll(async () => {
    await resetDB();
    adminToken = await getAuthToken("ADMIN");
    receptionToken = await getAuthToken("RECEPTION");
    const mod = await import("../../app");
    app = mod.app;
  });

  // ─────────────────────────────────────────────────────────────────────
  // Phone validation
  // ─────────────────────────────────────────────────────────────────────

  it("rejects an ambulance with a gibberish driver phone (400)", async () => {
    const res = await request(app)
      .post("/api/v1/ambulance")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        vehicleNumber: `AMBPHONE${Date.now()}`,
        type: "BLS",
        driverPhone: "not-a-phone",
      });
    expect(res.status).toBe(400);
    const fields = (res.body.details || []).map((d: any) => d.field);
    expect(fields).toContain("driverPhone");
  });

  it("rejects a trip request with a too-short caller phone (400)", async () => {
    const amb = await createAmbulance();
    const patient = await createPatientFixture();
    const res = await request(app)
      .post("/api/v1/ambulance/trips")
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({
        ambulanceId: amb.id,
        patientId: patient.id,
        callerPhone: "12",
        pickupAddress: "Where",
      });
    expect(res.status).toBe(400);
    const fields = (res.body.details || []).map((d: any) => d.field);
    expect(fields).toContain("callerPhone");
  });

  it("accepts a valid 10-digit phone with formatting", async () => {
    const res = await request(app)
      .post("/api/v1/ambulance")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        vehicleNumber: `AMBOK${Date.now()}`,
        type: "BLS",
        driverPhone: "+91 98765 43210",
      });
    expect([200, 201]).toContain(res.status);
  });

  // ─────────────────────────────────────────────────────────────────────
  // Negative distance / cost
  // ─────────────────────────────────────────────────────────────────────

  it("rejects a complete-trip with negative finalDistance (400)", async () => {
    const amb = await createAmbulance();
    const trip = await startTrip(amb.id);
    const res = await request(app)
      .patch(`/api/v1/ambulance/trips/${trip.id}/complete`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        actualEndTime: new Date().toISOString(),
        finalDistance: -5,
        finalCost: 100,
        notes: "neg distance",
      });
    expect(res.status).toBe(400);
    const fields = (res.body.details || []).map((d: any) => d.field);
    expect(fields).toContain("finalDistance");
  });

  it("rejects a complete-trip with negative finalCost (400)", async () => {
    const amb = await createAmbulance();
    const trip = await startTrip(amb.id);
    const res = await request(app)
      .patch(`/api/v1/ambulance/trips/${trip.id}/complete`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        actualEndTime: new Date().toISOString(),
        finalDistance: 5,
        finalCost: -100,
        notes: "neg cost",
      });
    expect(res.status).toBe(400);
    const fields = (res.body.details || []).map((d: any) => d.field);
    expect(fields).toContain("finalCost");
  });

  // ─────────────────────────────────────────────────────────────────────
  // Empty complete-trip
  // ─────────────────────────────────────────────────────────────────────

  it("rejects an empty complete-trip body (400) with field-level errors", async () => {
    const amb = await createAmbulance();
    const trip = await startTrip(amb.id);
    const res = await request(app)
      .patch(`/api/v1/ambulance/trips/${trip.id}/complete`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});
    expect(res.status).toBe(400);
    const fields = (res.body.details || []).map((d: any) => d.field);
    // All four required fields should have flagged.
    expect(fields).toEqual(
      expect.arrayContaining([
        "actualEndTime",
        "finalDistance",
        "finalCost",
        "notes",
      ])
    );
  });

  it("rejects a complete-trip with blank notes (400)", async () => {
    const amb = await createAmbulance();
    const trip = await startTrip(amb.id);
    const res = await request(app)
      .patch(`/api/v1/ambulance/trips/${trip.id}/complete`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        actualEndTime: new Date().toISOString(),
        finalDistance: 5,
        finalCost: 100,
        notes: "   ",
      });
    expect(res.status).toBe(400);
    const fields = (res.body.details || []).map((d: any) => d.field);
    expect(fields).toContain("notes");
  });

  it("rejects a complete-trip with finalDistance = 0 (must be > 0)", async () => {
    const amb = await createAmbulance();
    const trip = await startTrip(amb.id);
    const res = await request(app)
      .patch(`/api/v1/ambulance/trips/${trip.id}/complete`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        actualEndTime: new Date().toISOString(),
        finalDistance: 0,
        finalCost: 100,
        notes: "zero distance",
      });
    expect(res.status).toBe(400);
    const fields = (res.body.details || []).map((d: any) => d.field);
    expect(fields).toContain("finalDistance");
  });

  // ─────────────────────────────────────────────────────────────────────
  // Fleet status — IN_USE flip + AVAILABLE on complete
  // ─────────────────────────────────────────────────────────────────────

  it("flips fleet status to ON_TRIP when a trip is started", async () => {
    const amb = await createAmbulance();
    expect(amb.status).toBe("AVAILABLE");
    await startTrip(amb.id);
    const prisma = await getPrisma();
    const refreshed = await prisma.ambulance.findUnique({
      where: { id: amb.id },
    });
    // The schema uses ON_TRIP (no IN_USE enum value). This is the project's
    // canonical "in-use" marker for the fleet view.
    expect(refreshed?.status).toBe("ON_TRIP");
  });

  it("returns the fleet to AVAILABLE once the trip is completed", async () => {
    const amb = await createAmbulance();
    const trip = await startTrip(amb.id);
    // Drive through the full state machine — gap #10 (2026-05-03) blocks
    // REQUESTED → COMPLETED shortcuts.
    await request(app)
      .patch(`/api/v1/ambulance/trips/${trip.id}/dispatch`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});
    await request(app)
      .patch(`/api/v1/ambulance/trips/${trip.id}/arrived`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});
    await request(app)
      .patch(`/api/v1/ambulance/trips/${trip.id}/enroute`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});
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
    const prisma = await getPrisma();
    const refreshed = await prisma.ambulance.findUnique({
      where: { id: amb.id },
    });
    expect(refreshed?.status).toBe("AVAILABLE");
  });

  it("recomputeAmbulanceStatus is idempotent — repeated calls leave the row stable", async () => {
    const { recomputeAmbulanceStatus } = await import(
      "../../routes/ambulance"
    );
    const amb = await createAmbulance();
    // No active trip — should resolve to AVAILABLE no matter how many times.
    const a = await recomputeAmbulanceStatus(amb.id);
    const b = await recomputeAmbulanceStatus(amb.id);
    const c = await recomputeAmbulanceStatus(amb.id);
    expect(a).toBe("AVAILABLE");
    expect(b).toBe("AVAILABLE");
    expect(c).toBe("AVAILABLE");

    await startTrip(amb.id);
    const x = await recomputeAmbulanceStatus(amb.id);
    const y = await recomputeAmbulanceStatus(amb.id);
    expect(x).toBe("ON_TRIP");
    expect(y).toBe("ON_TRIP");
  });

  it("self-heals fleet status — direct DB drift is corrected by recompute", async () => {
    // Reproduce the bug: ambulance row says AVAILABLE while an active trip
    // exists. After recompute, fleet view must report ON_TRIP.
    const amb = await createAmbulance();
    await startTrip(amb.id);
    const prisma = await getPrisma();
    await prisma.ambulance.update({
      where: { id: amb.id },
      data: { status: "AVAILABLE" }, // simulate stale state
    });

    const { recomputeAmbulanceStatus } = await import(
      "../../routes/ambulance"
    );
    const fixed = await recomputeAmbulanceStatus(amb.id);
    expect(fixed).toBe("ON_TRIP");
    const refreshed = await prisma.ambulance.findUnique({
      where: { id: amb.id },
    });
    expect(refreshed?.status).toBe("ON_TRIP");
  });
});
