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

  // ─────────────────────────────────────────────────────────
  // Gap #10 (2026-05-03 audit) — trip state machine + fuel-log
  // append-only invariant + RBAC matrix at the HTTP boundary.
  // The complementary e2e at e2e/ambulance.spec.ts validates UI
  // flow; this suite exercises the route handlers directly.
  // ─────────────────────────────────────────────────────────

  // Helper: create a fresh ambulance + trip (REQUESTED) for a state-machine
  // test. Returns both ids so the test can drive transitions.
  async function seedTrip(token: string) {
    const amb = await createAmbulance(adminToken);
    const patient = await createPatientFixture();
    const res = await request(app)
      .post("/api/v1/ambulance/trips")
      .set("Authorization", `Bearer ${token}`)
      .send({
        ambulanceId: amb.id,
        patientId: patient.id,
        pickupAddress: "Seeded for state-machine test",
      });
    expect([200, 201]).toContain(res.status);
    return { ambulanceId: amb.id, tripId: res.body.data.id as string };
  }

  // ── State machine: valid forward transitions ─────────────

  it("state-machine: REQUESTED → DISPATCHED is accepted", async () => {
    const { tripId } = await seedTrip(adminToken);
    const res = await request(app)
      .patch(`/api/v1/ambulance/trips/${tripId}/dispatch`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.status).toBe("DISPATCHED");
    expect(res.body.data?.dispatchedAt).toBeTruthy();
  });

  it("state-machine: DISPATCHED → ARRIVED_SCENE is accepted", async () => {
    const { tripId } = await seedTrip(adminToken);
    await request(app)
      .patch(`/api/v1/ambulance/trips/${tripId}/dispatch`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});
    const res = await request(app)
      .patch(`/api/v1/ambulance/trips/${tripId}/arrived`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.status).toBe("ARRIVED_SCENE");
    expect(res.body.data?.arrivedAt).toBeTruthy();
  });

  it("state-machine: ARRIVED_SCENE → EN_ROUTE_HOSPITAL is accepted", async () => {
    const { tripId } = await seedTrip(adminToken);
    await request(app)
      .patch(`/api/v1/ambulance/trips/${tripId}/dispatch`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});
    await request(app)
      .patch(`/api/v1/ambulance/trips/${tripId}/arrived`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});
    const res = await request(app)
      .patch(`/api/v1/ambulance/trips/${tripId}/enroute`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.status).toBe("EN_ROUTE_HOSPITAL");
  });

  it("state-machine: EN_ROUTE_HOSPITAL → COMPLETED is accepted (frees ambulance)", async () => {
    const { ambulanceId, tripId } = await seedTrip(adminToken);
    await request(app)
      .patch(`/api/v1/ambulance/trips/${tripId}/dispatch`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});
    await request(app)
      .patch(`/api/v1/ambulance/trips/${tripId}/arrived`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});
    await request(app)
      .patch(`/api/v1/ambulance/trips/${tripId}/enroute`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});
    const res = await request(app)
      .patch(`/api/v1/ambulance/trips/${tripId}/complete`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        actualEndTime: new Date().toISOString(),
        finalDistance: 8.4,
        finalCost: 320,
        notes: "Delivered to ED",
      });
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.status).toBe("COMPLETED");
    expect(res.body.data?.completedAt).toBeTruthy();

    const prisma = await getPrisma();
    const refreshed = await prisma.ambulance.findUnique({
      where: { id: ambulanceId },
    });
    expect(refreshed?.status).toBe("AVAILABLE");
  });

  // ── State machine: out-of-order transitions ──────────────
  //
  // SOURCE BUG (gap-closer 2026-05-03): the route handlers in
  // apps/api/src/routes/ambulance.ts perform unconditional
  // `prisma.ambulanceTrip.update({ status: ... })` with NO guard
  // on the prior status. There is no state-machine enforcement at
  // the HTTP boundary — REQUESTED → COMPLETED, ARRIVED_SCENE →
  // REQUESTED (no endpoint exists for that), and COMPLETED →
  // DISPATCHED all silently succeed. The audit's claim that the
  // route "rejects out-of-order transitions" is aspirational.
  //
  // These tests assert *current* behaviour with TODO markers so
  // the fix shows up as a clean diff. When the fix lands (status
  // guard returning 409/422), flip these expectations.
  //
  // Note: there is no "set status to REQUESTED" endpoint — only
  // dispatch / arrived / enroute / complete / cancel. So
  // ARRIVED_SCENE → REQUESTED can't even be expressed via the
  // HTTP API. We exercise the closest analogue: post-arrival,
  // the only "rewind" surface is /dispatch which would re-stamp
  // dispatchedAt and revert status to DISPATCHED.

  it("state-machine: REQUESTED → COMPLETED is currently allowed (bug — should reject)", async () => {
    const { tripId } = await seedTrip(adminToken);
    const res = await request(app)
      .patch(`/api/v1/ambulance/trips/${tripId}/complete`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        actualEndTime: new Date().toISOString(),
        finalDistance: 5,
        finalCost: 200,
        notes: "Skipping the queue",
      });
    // TODO: when state-machine guard lands, expect 409 / 422.
    // Currently the route accepts the transition unconditionally.
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.status).toBe("COMPLETED");
  });

  it("state-machine: ARRIVED_SCENE → DISPATCHED (rewind) is currently allowed (bug — should reject)", async () => {
    const { tripId } = await seedTrip(adminToken);
    await request(app)
      .patch(`/api/v1/ambulance/trips/${tripId}/dispatch`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});
    await request(app)
      .patch(`/api/v1/ambulance/trips/${tripId}/arrived`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});
    // The "ARRIVED_SCENE → REQUESTED" rewind isn't expressible (no
    // endpoint resets to REQUESTED). The closest illegal rewind is
    // ARRIVED_SCENE → DISPATCHED, which the API currently accepts.
    const res = await request(app)
      .patch(`/api/v1/ambulance/trips/${tripId}/dispatch`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});
    // TODO: when state-machine guard lands, expect 409 / 422.
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.status).toBe("DISPATCHED");
  });

  it("state-machine: COMPLETED → DISPATCHED is currently allowed (bug — should reject)", async () => {
    const { tripId } = await seedTrip(adminToken);
    // Drive trip to COMPLETED.
    await request(app)
      .patch(`/api/v1/ambulance/trips/${tripId}/dispatch`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});
    await request(app)
      .patch(`/api/v1/ambulance/trips/${tripId}/complete`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        actualEndTime: new Date().toISOString(),
        finalDistance: 5,
        finalCost: 200,
        notes: "Done",
      });
    // Now try to revive it.
    const res = await request(app)
      .patch(`/api/v1/ambulance/trips/${tripId}/dispatch`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});
    // TODO: when state-machine guard lands, expect 409 / 422.
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.status).toBe("DISPATCHED");
  });

  // ── Cancel flow ──────────────────────────────────────────

  it("cancel: DISPATCHED → CANCELLED frees the vehicle (status = AVAILABLE)", async () => {
    const { ambulanceId, tripId } = await seedTrip(adminToken);
    const dispatched = await request(app)
      .patch(`/api/v1/ambulance/trips/${tripId}/dispatch`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});
    expect(dispatched.body.data?.status).toBe("DISPATCHED");

    // Mid-dispatch, the ambulance must read as ON_TRIP — the recompute
    // helper enforces this invariant.
    const prisma = await getPrisma();
    const beforeCancel = await prisma.ambulance.findUnique({
      where: { id: ambulanceId },
    });
    expect(beforeCancel?.status).toBe("ON_TRIP");

    const res = await request(app)
      .patch(`/api/v1/ambulance/trips/${tripId}/cancel`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});
    expect([200, 201]).toContain(res.status);
    expect(res.body.data?.status).toBe("CANCELLED");

    const afterCancel = await prisma.ambulance.findUnique({
      where: { id: ambulanceId },
    });
    expect(afterCancel?.status).toBe("AVAILABLE");
  });

  // ── Fuel log: append-only + (claimed) backdate rejection ─

  it("fuel-log: posting a new entry inserts an additional row (append-only)", async () => {
    const amb = await createAmbulance(adminToken);
    const prisma = await getPrisma();
    const before = await prisma.ambulanceFuelLog.count({
      where: { ambulanceId: amb.id },
    });

    const r1 = await request(app)
      .post("/api/v1/ambulance/fuel-logs")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        ambulanceId: amb.id,
        litres: 20.0,
        costTotal: 2000,
        odometerKm: 10000,
        stationName: "BPCL",
      });
    expect([200, 201]).toContain(r1.status);

    const r2 = await request(app)
      .post("/api/v1/ambulance/fuel-logs")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        ambulanceId: amb.id,
        litres: 15.5,
        costTotal: 1550,
        odometerKm: 10250,
        stationName: "HPCL",
      });
    expect([200, 201]).toContain(r2.status);

    const after = await prisma.ambulanceFuelLog.count({
      where: { ambulanceId: amb.id },
    });
    expect(after).toBe(before + 2);

    // The two rows must be distinct (append-only — no upsert behaviour).
    expect(r1.body.data.id).not.toBe(r2.body.data.id);
  });

  it("fuel-log: client-supplied future timestamp is silently ignored (validator gap — should reject)", async () => {
    // SOURCE BUG (gap-closer 2026-05-03): fuelLogSchema in
    // packages/shared/src/validation/ancillary-enhancements.ts has
    // NO timestamp field at all (no `filledAt`, no `timestamp`,
    // no `loggedAt`). The route at apps/api/src/routes/ambulance.ts
    // never reads any client timestamp. `filledAt` is set by
    // Prisma's `@default(now())`. As a result:
    //   1. Backdated entries can't be inserted via the API (good
    //      side-effect, but accidental).
    //   2. Any extra timestamp the client sends is silently
    //      dropped — no 400 is returned (bad — the audit's claim
    //      that backdated entries are "rejected" is aspirational).
    // The fix is to add a `filledAt` field to fuelLogSchema with a
    // refine() that rejects timestamps in the future, and have the
    // route honour it. Until then this test pins current behaviour.
    const amb = await createAmbulance(adminToken);
    const oneHourAhead = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const res = await request(app)
      .post("/api/v1/ambulance/fuel-logs")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        ambulanceId: amb.id,
        litres: 10,
        costTotal: 1000,
        odometerKm: 11000,
        stationName: "Future Station",
        // Extra field not in fuelLogSchema — currently silently ignored.
        timestamp: oneHourAhead,
        filledAt: oneHourAhead,
      });
    // TODO: when validator guards future timestamps, expect 400.
    expect([200, 201]).toContain(res.status);

    // The persisted row must use server time, NOT the client-supplied
    // future timestamp — i.e. `filledAt` is within ~5 minutes of now.
    const prisma = await getPrisma();
    const row = await prisma.ambulanceFuelLog.findUnique({
      where: { id: res.body.data.id },
    });
    expect(row).toBeTruthy();
    const rowTime = new Date(row!.filledAt).getTime();
    const skewMs = Math.abs(rowTime - Date.now());
    expect(skewMs).toBeLessThan(5 * 60 * 1000);
  });

  // ── RBAC matrix mirroring e2e/ambulance.spec.ts ──────────

  it("RBAC trips list: ADMIN, RECEPTION, NURSE, DOCTOR all read; PATIENT denied", async () => {
    const nurseToken = await getAuthToken("NURSE");
    const patientToken = await getAuthToken("PATIENT");

    for (const tok of [adminToken, receptionToken, nurseToken, doctorToken]) {
      const ok = await request(app)
        .get("/api/v1/ambulance/trips")
        .set("Authorization", `Bearer ${tok}`);
      expect(ok.status).toBe(200);
      expect(Array.isArray(ok.body.data)).toBe(true);
    }

    const denied = await request(app)
      .get("/api/v1/ambulance/trips")
      .set("Authorization", `Bearer ${patientToken}`);
    expect(denied.status).toBe(403);
  });

  it("RBAC fuel-logs POST: ADMIN + RECEPTION allowed; NURSE / DOCTOR / PATIENT denied", async () => {
    const nurseToken = await getAuthToken("NURSE");
    const patientToken = await getAuthToken("PATIENT");
    const amb = await createAmbulance(adminToken);
    const payload = {
      ambulanceId: amb.id,
      litres: 12.0,
      costTotal: 1200,
      odometerKm: 30000,
      stationName: "RBAC station",
    };

    for (const tok of [adminToken, receptionToken]) {
      const ok = await request(app)
        .post("/api/v1/ambulance/fuel-logs")
        .set("Authorization", `Bearer ${tok}`)
        .send(payload);
      expect([200, 201]).toContain(ok.status);
    }

    for (const tok of [nurseToken, doctorToken, patientToken]) {
      const denied = await request(app)
        .post("/api/v1/ambulance/fuel-logs")
        .set("Authorization", `Bearer ${tok}`)
        .send(payload);
      expect(denied.status).toBe(403);
    }
  });
});
