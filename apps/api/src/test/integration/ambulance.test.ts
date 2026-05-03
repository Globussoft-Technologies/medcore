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

  it("dispatch -> arrived -> enroute -> complete flow (frees ambulance)", async () => {
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

    const a = await request(app)
      .patch(`/api/v1/ambulance/trips/${trip.id}/arrived`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});
    expect(a.body.data?.status).toBe("ARRIVED_SCENE");

    const e = await request(app)
      .patch(`/api/v1/ambulance/trips/${trip.id}/enroute`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});
    expect(e.body.data?.status).toBe("EN_ROUTE_HOSPITAL");

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
    const tripId = tripRes.body.data.id;
    // Drive trip through the full state machine before completing — gap #10
    // (2026-05-03) added the transition guard so /complete can no longer be
    // called from REQUESTED.
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
    await request(app)
      .patch(`/api/v1/ambulance/trips/${tripId}/complete`)
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
  // The route handlers in apps/api/src/routes/ambulance.ts now read
  // the current trip status and call `assertValidTripTransition`
  // before writing — illegal moves return 409 with a message
  // containing "Invalid ambulance trip transition" and the prior
  // status is preserved.
  //
  // Note: there is no "set status to REQUESTED" endpoint — only
  // dispatch / arrived / enroute / complete / cancel. The closest
  // illegal rewind we can express via HTTP is ARRIVED_SCENE →
  // DISPATCHED (replayed POST /dispatch on an already-arrived trip).

  it("state-machine: REQUESTED → COMPLETED is rejected (409)", async () => {
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
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/Invalid ambulance trip transition/i);

    const prisma = await getPrisma();
    const row = await prisma.ambulanceTrip.findUnique({
      where: { id: tripId },
    });
    expect(row?.status).toBe("REQUESTED");
    expect(row?.completedAt).toBeNull();
  });

  it("state-machine: ARRIVED_SCENE → DISPATCHED (rewind) is rejected (409)", async () => {
    const { tripId } = await seedTrip(adminToken);
    await request(app)
      .patch(`/api/v1/ambulance/trips/${tripId}/dispatch`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});
    await request(app)
      .patch(`/api/v1/ambulance/trips/${tripId}/arrived`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});
    // Replayed POST /dispatch on an ARRIVED_SCENE trip is the closest
    // expressible rewind via the HTTP surface — must now 409.
    const res = await request(app)
      .patch(`/api/v1/ambulance/trips/${tripId}/dispatch`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/Invalid ambulance trip transition/i);

    const prisma = await getPrisma();
    const row = await prisma.ambulanceTrip.findUnique({
      where: { id: tripId },
    });
    expect(row?.status).toBe("ARRIVED_SCENE");
  });

  it("state-machine: COMPLETED → DISPATCHED is rejected (409, terminal-state guard)", async () => {
    const { tripId } = await seedTrip(adminToken);
    // Drive trip to COMPLETED via the legal path.
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
    await request(app)
      .patch(`/api/v1/ambulance/trips/${tripId}/complete`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        actualEndTime: new Date().toISOString(),
        finalDistance: 5,
        finalCost: 200,
        notes: "Done",
      });
    // Now try to revive the trip — must 409.
    const res = await request(app)
      .patch(`/api/v1/ambulance/trips/${tripId}/dispatch`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/Invalid ambulance trip transition/i);
    // Terminal-state guard error message lists "(none — terminal state)".
    expect(res.body.error).toMatch(/terminal state|COMPLETED -> DISPATCHED/i);

    const prisma = await getPrisma();
    const row = await prisma.ambulanceTrip.findUnique({
      where: { id: tripId },
    });
    expect(row?.status).toBe("COMPLETED");
  });

  it("state-machine: CANCELLED → DISPATCHED is rejected (409, terminal-state guard)", async () => {
    const { tripId } = await seedTrip(adminToken);
    await request(app)
      .patch(`/api/v1/ambulance/trips/${tripId}/cancel`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});

    const res = await request(app)
      .patch(`/api/v1/ambulance/trips/${tripId}/dispatch`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/Invalid ambulance trip transition/i);

    const prisma = await getPrisma();
    const row = await prisma.ambulanceTrip.findUnique({
      where: { id: tripId },
    });
    expect(row?.status).toBe("CANCELLED");
  });

  it("state-machine: COMPLETED → CANCELLED is rejected (409, no terminal cancellation)", async () => {
    const { tripId } = await seedTrip(adminToken);
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
    await request(app)
      .patch(`/api/v1/ambulance/trips/${tripId}/complete`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        actualEndTime: new Date().toISOString(),
        finalDistance: 7,
        finalCost: 280,
        notes: "Done",
      });

    const res = await request(app)
      .patch(`/api/v1/ambulance/trips/${tripId}/cancel`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});
    expect(res.status).toBe(409);

    const prisma = await getPrisma();
    const row = await prisma.ambulanceTrip.findUnique({
      where: { id: tripId },
    });
    expect(row?.status).toBe("COMPLETED");
  });

  it("state-machine: same-state /dispatch on a DISPATCHED trip is an idempotent 200 no-op", async () => {
    const { tripId } = await seedTrip(adminToken);
    const first = await request(app)
      .patch(`/api/v1/ambulance/trips/${tripId}/dispatch`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});
    expect(first.status).toBe(200);
    expect(first.body.data?.status).toBe("DISPATCHED");
    const firstDispatchedAt = first.body.data?.dispatchedAt;

    const second = await request(app)
      .patch(`/api/v1/ambulance/trips/${tripId}/dispatch`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});
    expect(second.status).toBe(200);
    expect(second.body.data?.status).toBe("DISPATCHED");
    // No-op: dispatchedAt should be untouched (not re-stamped).
    expect(second.body.data?.dispatchedAt).toBe(firstDispatchedAt);
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

  it("fuel-log: client-supplied future filledAt is rejected (400)", async () => {
    const amb = await createAmbulance(adminToken);
    const oneDayAhead = new Date(
      Date.now() + 24 * 60 * 60 * 1000
    ).toISOString();
    const res = await request(app)
      .post("/api/v1/ambulance/fuel-logs")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        ambulanceId: amb.id,
        litres: 10,
        costTotal: 1000,
        odometerKm: 11000,
        stationName: "Future Station",
        filledAt: oneDayAhead,
      });
    expect(res.status).toBe(400);
    const fields = (res.body.details || []).map((d: any) => d.field);
    expect(fields).toContain("filledAt");
  });

  it("fuel-log: client-supplied past filledAt is persisted (backdating allowed)", async () => {
    const amb = await createAmbulance(adminToken);
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const res = await request(app)
      .post("/api/v1/ambulance/fuel-logs")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        ambulanceId: amb.id,
        litres: 22,
        costTotal: 2200,
        odometerKm: 11500,
        stationName: "Backdated Station",
        filledAt: yesterday,
      });
    expect([200, 201]).toContain(res.status);

    // The row must reflect the client-supplied timestamp — Prisma's
    // @default(now()) must NOT silently overwrite it.
    const prisma = await getPrisma();
    const row = await prisma.ambulanceFuelLog.findUnique({
      where: { id: res.body.data.id },
    });
    expect(row).toBeTruthy();
    expect(new Date(row!.filledAt).toISOString()).toBe(yesterday);
  });

  it("fuel-log: omitted filledAt falls back to Prisma @default(now())", async () => {
    const amb = await createAmbulance(adminToken);
    const before = Date.now();
    const res = await request(app)
      .post("/api/v1/ambulance/fuel-logs")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        ambulanceId: amb.id,
        litres: 18,
        costTotal: 1800,
        odometerKm: 12000,
        stationName: "Default-Now Station",
      });
    expect([200, 201]).toContain(res.status);
    const after = Date.now();

    const prisma = await getPrisma();
    const row = await prisma.ambulanceFuelLog.findUnique({
      where: { id: res.body.data.id },
    });
    expect(row).toBeTruthy();
    const t = new Date(row!.filledAt).getTime();
    // Within the [before, after] window plus a generous fudge for clock skew.
    expect(t).toBeGreaterThanOrEqual(before - 5_000);
    expect(t).toBeLessThanOrEqual(after + 5_000);
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
