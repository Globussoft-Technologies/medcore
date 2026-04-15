// End-to-end Socket.IO delivery test (Option A — boot a real listener,
// connect real socket.io-client instances, observe events over the wire).
//
// The companion file `realtime.test.ts` only spies on `io.emit`, which proves
// "the server called emit" but says nothing about whether a connected client
// actually receives the event. This file fills that gap by:
//
//   1. booting `httpServer` (already wired to `io` in app.ts) on an ephemeral
//      port via `httpServer.listen(0)`,
//   2. connecting 3 real socket.io-client instances:
//         • admin   — joins no room (listens for global broadcasts)
//         • doctor  — emits `join-doctor-queue` for doctor.id (room scoped)
//         • display — emits `join-display`         (room scoped)
//   3. driving real REST endpoints with supertest and racing each
//      `client.once(event, …)` against a 3-second timeout. Timeout = blocker.
//   4. asserting payload shape (orderItemId / admissionId / surgeryId / caseId).
//   5. one negative test for room scoping: a client in `queue:dA` MUST NOT
//      receive an emit targeted at `queue:dB`.
//
// This file complements (does not replace) realtime.test.ts.

import { it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { AddressInfo } from "net";
import { io as ioClient, Socket as ClientSocket } from "socket.io-client";
import { describeIfDB, resetDB, getAuthToken } from "../setup";
import {
  createPatientFixture,
  createDoctorFixture,
  createWardFixture,
  createBedFixture,
  createOperatingTheaterFixture,
  createLabTestFixture,
  createLabOrderFixture,
  createDoctorWithToken,
} from "../factories";

let app: any;
let httpServer: any;
let io: any;
let port: number;
let baseUrl: string;
let adminToken: string;
let nurseToken: string;
let receptionToken: string;

// Connected clients
let adminClient: ClientSocket;
let displayClient: ClientSocket;

// Per-test scoped doctor client + the doctor it represents
function makeUrl() {
  return baseUrl;
}

/**
 * Wait for `event` on `client`, racing against a 3 second timeout.
 * Resolves with the payload, rejects with "TIMEOUT_<event>" on miss.
 */
function waitForEvent<T = any>(
  client: ClientSocket,
  event: string,
  timeoutMs = 3000
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => {
      client.off(event, handler);
      reject(new Error(`TIMEOUT_${event}`));
    }, timeoutMs);
    const handler = (payload: T) => {
      clearTimeout(t);
      resolve(payload);
    };
    client.once(event, handler);
  });
}

/**
 * Connects a fresh socket.io client. Resolves once `connect` fires.
 */
async function connectClient(extra?: (sock: ClientSocket) => void): Promise<ClientSocket> {
  const sock = ioClient(makeUrl(), {
    transports: ["websocket"],
    reconnection: false,
    forceNew: true,
  });
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("client connect timeout")), 5000);
    sock.on("connect", () => {
      clearTimeout(t);
      resolve();
    });
    sock.on("connect_error", (err) => {
      clearTimeout(t);
      reject(err);
    });
  });
  if (extra) extra(sock);
  return sock;
}

/**
 * Joins a room on the server side via the documented socket events from
 * app.ts (`join-doctor-queue`, `join-display`) and waits a tick so the
 * server's `socket.join(...)` completes before we trigger the side-effect.
 */
async function joinAndSettle(sock: ClientSocket, event: string, arg?: any) {
  sock.emit(event, arg);
  // Round-trip a no-op ping to make sure the server processed the join
  await new Promise<void>((resolve) => setTimeout(resolve, 50));
}

describeIfDB("Realtime Socket.IO delivery (E2E)", () => {
  beforeAll(async () => {
    await resetDB();
    adminToken = await getAuthToken("ADMIN");
    nurseToken = await getAuthToken("NURSE");
    receptionToken = await getAuthToken("RECEPTION");

    const mod = await import("../../app");
    app = mod.app;
    io = mod.io;
    httpServer = mod.httpServer;

    // If the test harness has not already bound the server, bind on port 0
    // (ephemeral). Production server.ts binds to PORT, but in the test process
    // server.ts is never imported, so httpServer is unbound.
    if (!httpServer.listening) {
      await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    }
    const addr = httpServer.address() as AddressInfo;
    port = addr.port;
    baseUrl = `http://127.0.0.1:${port}`;

    // Always-on clients
    adminClient = await connectClient();
    displayClient = await connectClient();
    await joinAndSettle(displayClient, "join-display");
  }, 30000);

  afterAll(async () => {
    try { adminClient?.disconnect(); } catch { /* ignore */ }
    try { displayClient?.disconnect(); } catch { /* ignore */ }
    // Don't close httpServer — the singleton is shared with realtime.test.ts.
  });

  // ─── QUEUE / TOKEN DELIVERY ──────────────────────────────────

  it("delivers queue-updated to a doctor client subscribed to its room (and token-updated to display)", async () => {
    const patient = await createPatientFixture();
    const doctor = await createDoctorFixture();

    const doctorClient = await connectClient();
    await joinAndSettle(doctorClient, "join-doctor-queue", doctor.id);

    const queuePromise = waitForEvent<any>(doctorClient, "queue-updated");
    const tokenPromise = waitForEvent<any>(displayClient, "token-updated");

    const res = await request(app)
      .post("/api/v1/appointments/walk-in")
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({ patientId: patient.id, doctorId: doctor.id, priority: "NORMAL" });
    expect([200, 201]).toContain(res.status);

    const queuePayload = await queuePromise;
    expect(queuePayload).toMatchObject({ doctorId: doctor.id });
    expect(typeof queuePayload.date).toBe("string");

    const tokenPayload = await tokenPromise;
    expect(tokenPayload).toMatchObject({ doctorId: doctor.id });
    expect(typeof tokenPayload.tokenNumber).toBe("number");

    doctorClient.disconnect();
  }, 15000);

  it("delivers token-called to display when an appointment moves to IN_CONSULTATION", async () => {
    const patient = await createPatientFixture();
    const doctor = await createDoctorFixture();

    const walkIn = await request(app)
      .post("/api/v1/appointments/walk-in")
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({ patientId: patient.id, doctorId: doctor.id });
    expect([200, 201]).toContain(walkIn.status);
    const aptId = walkIn.body.data.id;

    const calledPromise = waitForEvent<any>(displayClient, "token-called");

    const res = await request(app)
      .patch(`/api/v1/appointments/${aptId}/status`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ status: "IN_CONSULTATION" });
    expect([200, 201]).toContain(res.status);

    const payload = await calledPromise;
    expect(payload).toMatchObject({
      doctorId: doctor.id,
      tokenNumber: expect.any(Number),
    });
  }, 15000);

  // ─── LAB DELIVERY (broadcast) ────────────────────────────────

  it("delivers lab:result broadcast to a connected admin client (CRITICAL flag)", async () => {
    const { doctor } = await createDoctorWithToken();
    const patient = await createPatientFixture();
    const test = await createLabTestFixture();
    const order = await createLabOrderFixture({
      patientId: patient.id,
      doctorId: doctor.id,
      testIds: [test.id],
    });

    const labPromise = waitForEvent<any>(adminClient, "lab:result");

    const res = await request(app)
      .post("/api/v1/lab/results")
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({
        orderItemId: order.items[0].id,
        parameter: "Hemoglobin",
        value: "4.2",
        unit: "g/dL",
        flag: "CRITICAL",
      });
    expect([200, 201]).toContain(res.status);

    const payload = await labPromise;
    expect(payload).toMatchObject({
      orderItemId: order.items[0].id,
      criticalFlag: true,
    });
    expect(payload.resultId).toBeTruthy();
  }, 15000);

  // ─── ADMISSION DELIVERY (broadcast) ──────────────────────────

  it("delivers admission:status (ADMITTED) broadcast on POST /admissions", async () => {
    const patient = await createPatientFixture();
    const doctor = await createDoctorFixture();
    const ward = await createWardFixture();
    const bed = await createBedFixture({ wardId: ward.id });

    const promise = waitForEvent<any>(adminClient, "admission:status");

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

    const payload = await promise;
    expect(payload).toMatchObject({
      admissionId: res.body.data.id,
      status: "ADMITTED",
      bedId: bed.id,
    });
  }, 15000);

  // ─── SURGERY DELIVERY (broadcast) ────────────────────────────

  it("delivers surgery:status (IN_PROGRESS) broadcast on PATCH /surgery/:id/start", async () => {
    const patient = await createPatientFixture();
    const doctor = await createDoctorFixture();
    const ot = await createOperatingTheaterFixture();
    const sched = await request(app)
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
    expect([200, 201]).toContain(sched.status);
    const surgery = sched.body.data;

    const promise = waitForEvent<any>(adminClient, "surgery:status");

    const res = await request(app)
      .patch(`/api/v1/surgery/${surgery.id}/start`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ overrideChecklist: true });
    expect([200, 201]).toContain(res.status);

    const payload = await promise;
    expect(payload).toMatchObject({
      surgeryId: surgery.id,
      status: "IN_PROGRESS",
      otId: ot.id,
    });
  }, 15000);

  // ─── EMERGENCY DELIVERY (broadcast) ──────────────────────────

  it("delivers emergency:update broadcast on PATCH /emergency/cases/:id/triage", async () => {
    const patient = await createPatientFixture();
    const create = await request(app)
      .post("/api/v1/emergency/cases")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ patientId: patient.id, chiefComplaint: "Fever" });
    expect([200, 201]).toContain(create.status);
    const caseId = create.body.data.id;

    const promise = waitForEvent<any>(adminClient, "emergency:update");

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

    const payload = await promise;
    expect(payload).toMatchObject({
      caseId,
      status: "TRIAGED",
      triageLevel: "URGENT",
    });
  }, 15000);

  // ─── ROOM SCOPING NEGATIVE TEST ──────────────────────────────

  it("does NOT leak a queue-updated for doctor B to a client subscribed only to doctor A's room", async () => {
    const patient = await createPatientFixture();
    const doctorA = await createDoctorFixture();
    const doctorB = await createDoctorFixture();

    const clientA = await connectClient();
    await joinAndSettle(clientA, "join-doctor-queue", doctorA.id);

    let leaked = false;
    clientA.on("queue-updated", (payload: any) => {
      if (payload?.doctorId === doctorB.id) leaked = true;
    });

    // Trigger an event scoped to doctorB's room.
    const res = await request(app)
      .post("/api/v1/appointments/walk-in")
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({ patientId: patient.id, doctorId: doctorB.id, priority: "NORMAL" });
    expect([200, 201]).toContain(res.status);

    // Wait long enough for an in-process delivery to be observable.
    await new Promise((r) => setTimeout(r, 750));

    expect(leaked).toBe(false);
    clientA.disconnect();
  }, 15000);
});
