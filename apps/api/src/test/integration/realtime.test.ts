// Integration tests for realtime Socket.IO events.
//
// Approach: Option B (spy on io.emit + io.to). This avoids booting an HTTP
// listener on an ephemeral port + adding a socket.io-client dependency. We
// intercept every emit call and collect (room, event, payload) tuples, then
// trigger real routes via supertest and assert the expected events fired with
// the expected payload shape.
//
// Covered event families:
//   1. queue-updated / token-updated / token-called  (via io.to(room).emit)
//   2. lab:result                                    (via io.emit)
//   3. admission:status (ADMITTED / DISCHARGED)      (via io.emit)
//   4. surgery:status (IN_PROGRESS / COMPLETED)      (via io.emit)
//   5. emergency:update (triage + close)             (via io.emit)
//
// These are the actual event names wired up in the routes (see io.emit / io.to
// in apps/api/src/routes/*). Note — the task description lists event names
// like "queue:update", "admission:admit", "er:triage"; these do NOT match what
// the code actually emits. See the final report for the mismatch bug.

import { it, expect, beforeAll, beforeEach, vi } from "vitest";
import request from "supertest";
import { describeIfDB, resetDB, getAuthToken, getPrisma } from "../setup";
import {
  createPatientFixture,
  createDoctorFixture,
  createDoctorWithToken,
  createWardFixture,
  createBedFixture,
  createAdmissionFixture,
  createOperatingTheaterFixture,
  createLabTestFixture,
  createLabOrderFixture,
} from "../factories";

type Emitted = { room: string | null; event: string; payload: any };

let app: any;
let io: any;
let adminToken: string;
let nurseToken: string;
let receptionToken: string;

// Mutable ref the beforeEach resets per-test. Every io.emit and io.to(r).emit
// call inside routes appends to this list.
let emitted: Emitted[] = [];

function installEmitSpies(ioInstance: any) {
  const origEmit = ioInstance.emit.bind(ioInstance);
  const origTo = ioInstance.to.bind(ioInstance);

  // Top-level io.emit
  vi.spyOn(ioInstance, "emit").mockImplementation((...args: any[]) => {
    const [event, payload] = args;
    emitted.push({ room: null, event, payload });
    return origEmit(event, payload);
  });

  // io.to(room).emit — wrap the returned BroadcastOperator to capture the room
  vi.spyOn(ioInstance, "to").mockImplementation((room: any) => {
    const broadcast = origTo(room);
    const broadcastEmit = broadcast.emit.bind(broadcast);
    broadcast.emit = (...args: any[]) => {
      const [event, payload] = args;
      emitted.push({
        room: typeof room === "string" ? room : JSON.stringify(room),
        event,
        payload,
      });
      return broadcastEmit(event, payload);
    };
    return broadcast;
  });
}

function eventsNamed(name: string): Emitted[] {
  return emitted.filter((e) => e.event === name);
}

describeIfDB("Realtime Socket.IO events (integration)", () => {
  beforeAll(async () => {
    await resetDB();
    adminToken = await getAuthToken("ADMIN");
    nurseToken = await getAuthToken("NURSE");
    receptionToken = await getAuthToken("RECEPTION");
    const mod = await import("../../app");
    app = mod.app;
    io = mod.io;
    installEmitSpies(io);
  });

  beforeEach(() => {
    emitted = [];
  });

  // ─── QUEUE / APPOINTMENT EVENTS ────────────────────────

  it("emits queue-updated + token-updated when a walk-in is registered", async () => {
    const patient = await createPatientFixture();
    const doctor = await createDoctorFixture();
    const res = await request(app)
      .post("/api/v1/appointments/walk-in")
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({ patientId: patient.id, doctorId: doctor.id, priority: "NORMAL" });
    expect([200, 201]).toContain(res.status);

    const queueEvents = eventsNamed("queue-updated");
    expect(queueEvents.length).toBeGreaterThanOrEqual(1);
    const qe = queueEvents[0];
    expect(qe.room).toBe(`queue:${doctor.id}`);
    expect(qe.payload).toMatchObject({ doctorId: doctor.id });
    expect(typeof qe.payload.date).toBe("string");

    const tokenEvents = eventsNamed("token-updated");
    expect(tokenEvents.length).toBeGreaterThanOrEqual(1);
    expect(tokenEvents[0].room).toBe("token-display");
    expect(tokenEvents[0].payload).toMatchObject({ doctorId: doctor.id });
    expect(typeof tokenEvents[0].payload.tokenNumber).toBe("number");
  });

  it("emits queue-updated + token-called when an appointment transitions to IN_CONSULTATION", async () => {
    const patient = await createPatientFixture();
    const doctor = await createDoctorFixture();
    const walkInRes = await request(app)
      .post("/api/v1/appointments/walk-in")
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({ patientId: patient.id, doctorId: doctor.id });
    expect([200, 201]).toContain(walkInRes.status);
    const appointmentId = walkInRes.body.data.id;

    emitted = []; // reset — we only care about the status-change emits

    const res = await request(app)
      .patch(`/api/v1/appointments/${appointmentId}/status`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ status: "IN_CONSULTATION" });
    expect([200, 201]).toContain(res.status);

    const qe = eventsNamed("queue-updated");
    expect(qe.length).toBeGreaterThanOrEqual(1);
    expect(qe[0].room).toBe(`queue:${doctor.id}`);

    const called = eventsNamed("token-called");
    expect(called.length).toBeGreaterThanOrEqual(1);
    expect(called[0].room).toBe("token-display");
    expect(called[0].payload).toMatchObject({
      doctorId: doctor.id,
      tokenNumber: expect.any(Number),
    });
  });

  // ─── LAB EVENTS ────────────────────────────────────────

  it("emits lab:result with criticalFlag=false for a NORMAL result", async () => {
    const { doctor } = await createDoctorWithToken();
    const patient = await createPatientFixture();
    const test = await createLabTestFixture();
    const order = await createLabOrderFixture({
      patientId: patient.id,
      doctorId: doctor.id,
      testIds: [test.id],
    });
    // Use adminToken: POST /lab/results is LAB_TECH+ADMIN only post-#14
    // (separation of duties — the ordering doctor must not enter their own
     // results, and we don't seed a LAB_TECH role token here).
    const res = await request(app)
      .post("/api/v1/lab/results")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        orderItemId: order.items[0].id,
        parameter: "Hemoglobin",
        value: "14.5",
        unit: "g/dL",
        normalRange: "13-17",
        flag: "NORMAL",
      });
    expect([200, 201]).toContain(res.status);

    const labEvents = eventsNamed("lab:result");
    expect(labEvents.length).toBeGreaterThanOrEqual(1);
    const last = labEvents[labEvents.length - 1];
    expect(last.room).toBeNull(); // broadcast
    expect(last.payload).toMatchObject({
      orderItemId: order.items[0].id,
      criticalFlag: false,
    });
    expect(last.payload.resultId).toBeTruthy();
  });

  it("emits lab:result with criticalFlag=true for a CRITICAL result", async () => {
    const { doctor } = await createDoctorWithToken();
    const patient = await createPatientFixture();
    const test = await createLabTestFixture();
    const order = await createLabOrderFixture({
      patientId: patient.id,
      doctorId: doctor.id,
      testIds: [test.id],
    });
    const res = await request(app)
      .post("/api/v1/lab/results")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        orderItemId: order.items[0].id,
        parameter: "Hemoglobin",
        value: "4.2",
        unit: "g/dL",
        flag: "CRITICAL",
      });
    expect([200, 201]).toContain(res.status);

    const labEvents = eventsNamed("lab:result");
    expect(labEvents.length).toBeGreaterThanOrEqual(1);
    const last = labEvents[labEvents.length - 1];
    expect(last.payload.criticalFlag).toBe(true);
    expect(last.payload.orderItemId).toBe(order.items[0].id);
  });

  // ─── ADMISSION EVENTS ──────────────────────────────────

  it("emits admission:status with status=ADMITTED when a patient is admitted", async () => {
    const patient = await createPatientFixture();
    const doctor = await createDoctorFixture();
    const ward = await createWardFixture();
    const bed = await createBedFixture({ wardId: ward.id });
    const res = await request(app)
      .post("/api/v1/admissions")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        patientId: patient.id,
        doctorId: doctor.id,
        bedId: bed.id,
        reason: "Fever",
        admissionType: "ELECTIVE",
      });
    expect([200, 201]).toContain(res.status);

    const events = eventsNamed("admission:status");
    expect(events.length).toBeGreaterThanOrEqual(1);
    const ev = events[events.length - 1];
    expect(ev.room).toBeNull();
    expect(ev.payload).toMatchObject({
      admissionId: res.body.data.id,
      status: "ADMITTED",
      bedId: bed.id,
    });
  });

  it("emits admission:status with status=DISCHARGED on force discharge", async () => {
    const patient = await createPatientFixture();
    const doctor = await createDoctorFixture();
    const ward = await createWardFixture();
    const bed = await createBedFixture({ wardId: ward.id });
    const admission = await createAdmissionFixture({
      patientId: patient.id,
      doctorId: doctor.id,
      bedId: bed.id,
    });
    emitted = [];

    const res = await request(app)
      .patch(`/api/v1/admissions/${admission.id}/discharge`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        dischargeSummary: "Recovered.",
        forceDischarge: true,
        conditionAtDischarge: "STABLE",
        followUpInstructions: "F/U in 7 days",
        dischargeMedications: "Paracetamol",
      });
    expect([200, 201]).toContain(res.status);

    const events = eventsNamed("admission:status");
    expect(events.length).toBeGreaterThanOrEqual(1);
    const ev = events[events.length - 1];
    expect(ev.payload).toMatchObject({
      admissionId: admission.id,
      status: "DISCHARGED",
      bedId: bed.id,
    });
  });

  // ─── SURGERY EVENTS ────────────────────────────────────

  it("emits surgery:status with status=IN_PROGRESS when /start succeeds", async () => {
    const patient = await createPatientFixture();
    const doctor = await createDoctorFixture();
    const ot = await createOperatingTheaterFixture();
    const schedRes = await request(app)
      .post("/api/v1/surgery")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        patientId: patient.id,
        surgeonId: doctor.id,
        otId: ot.id,
        procedure: "Appendectomy",
        scheduledAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        durationMin: 90,
      });
    expect([200, 201]).toContain(schedRes.status);
    const surgery = schedRes.body.data;
    emitted = [];

    const res = await request(app)
      .patch(`/api/v1/surgery/${surgery.id}/start`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ overrideChecklist: true });
    expect([200, 201]).toContain(res.status);

    const events = eventsNamed("surgery:status");
    expect(events.length).toBeGreaterThanOrEqual(1);
    const ev = events[events.length - 1];
    expect(ev.payload).toMatchObject({
      surgeryId: surgery.id,
      status: "IN_PROGRESS",
      otId: ot.id,
    });
  });

  it("emits surgery:status with status=COMPLETED when /complete succeeds", async () => {
    const patient = await createPatientFixture();
    const doctor = await createDoctorFixture();
    const ot = await createOperatingTheaterFixture();
    const schedRes = await request(app)
      .post("/api/v1/surgery")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        patientId: patient.id,
        surgeonId: doctor.id,
        otId: ot.id,
        procedure: "Cholecystectomy",
        scheduledAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        durationMin: 60,
      });
    expect([200, 201]).toContain(schedRes.status);
    const surgery = schedRes.body.data;
    emitted = [];

    const res = await request(app)
      .patch(`/api/v1/surgery/${surgery.id}/complete`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        postOpNotes: "No complications. Counts correct.",
        spongeCountCorrect: true,
        instrumentCountCorrect: true,
      });
    expect([200, 201]).toContain(res.status);

    const events = eventsNamed("surgery:status");
    expect(events.length).toBeGreaterThanOrEqual(1);
    const ev = events[events.length - 1];
    expect(ev.payload).toMatchObject({
      surgeryId: surgery.id,
      status: "COMPLETED",
      otId: ot.id,
    });
  });

  // ─── EMERGENCY EVENTS ──────────────────────────────────

  it("emits emergency:update with triage data when a case is triaged", async () => {
    const patient = await createPatientFixture();
    const createRes = await request(app)
      .post("/api/v1/emergency/cases")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ patientId: patient.id, chiefComplaint: "Fever" });
    expect([200, 201]).toContain(createRes.status);
    const caseId = createRes.body.data.id;
    emitted = [];

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

    const events = eventsNamed("emergency:update");
    expect(events.length).toBeGreaterThanOrEqual(1);
    const ev = events[events.length - 1];
    expect(ev.payload).toMatchObject({
      caseId,
      status: "TRIAGED",
      triageLevel: "URGENT",
    });
  });

  it("emits emergency:update when a case is closed", async () => {
    const patient = await createPatientFixture();
    const createRes = await request(app)
      .post("/api/v1/emergency/cases")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ patientId: patient.id, chiefComplaint: "Headache" });
    const caseId = createRes.body.data.id;
    emitted = [];

    const res = await request(app)
      .patch(`/api/v1/emergency/cases/${caseId}/close`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        status: "DISCHARGED",
        disposition: "Home",
        outcomeNotes: "Stable",
      });
    expect([200, 201]).toContain(res.status);

    const events = eventsNamed("emergency:update");
    expect(events.length).toBeGreaterThanOrEqual(1);
    const ev = events[events.length - 1];
    expect(ev.payload).toMatchObject({
      caseId,
      status: "DISCHARGED",
    });
  });

  // ─── PAYLOAD SANITY ────────────────────────────────────

  it("every realtime payload carries at least one resource identifier", async () => {
    // After all prior tests have run in this file, emitted is reset per-test.
    // Run one small flow and check payload shape is never empty.
    const patient = await createPatientFixture();
    const doctor = await createDoctorFixture();
    const res = await request(app)
      .post("/api/v1/appointments/walk-in")
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({ patientId: patient.id, doctorId: doctor.id });
    expect([200, 201]).toContain(res.status);

    expect(emitted.length).toBeGreaterThan(0);
    for (const e of emitted) {
      expect(e.event).toBeTruthy();
      expect(e.payload).toBeTruthy();
      expect(Object.keys(e.payload).length).toBeGreaterThan(0);
    }
  });

  // Admin-only access to an existing DB confirms io singleton wired correctly
  it("io singleton is shared between tests and app.get('io')", async () => {
    const ioFromApp = app.get("io");
    expect(ioFromApp).toBe(io);
  });
});

// Silence unused-import warnings from factories we don't call in some branches
void getPrisma;
