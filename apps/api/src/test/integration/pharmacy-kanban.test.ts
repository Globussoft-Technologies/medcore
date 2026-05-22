// Integration tests for Pearl §4.3 (gap row 104) — Pharmacy dispensing
// Kanban. Covers the new PATCH /pharmacy/prescriptions/:id/status
// endpoint that drives the Kanban board transitions:
//   PENDING → DISPENSING → READY → DISPENSED  (forward path)
//   READY → DISPENSING                         (step-back for re-mix)
//   * → REJECTED / CANCELLED                   (terminal, handled
//                                               elsewhere — not via
//                                               this endpoint)
//
// Asserts: (1) legal forward transitions return 200 + flip the row,
// (2) illegal jumps return 409 without mutating, (3) RBAC — PHARMACY
// and ADMIN can mutate, PATIENT cannot, (4) every successful move
// writes a PRESCRIPTION_KANBAN_TRANSITION audit row with the
// from/to/prescriptionId payload.
//
// Uses the project's resetDB() once-per-file pattern + the existing
// createPrescriptionFixture factory. Test creds per CLAUDE.md:
// admin@test.local / MedCoreT3st-2026.

import { it, expect, beforeAll } from "vitest";
import request from "supertest";
import { describeIfDB, resetDB, getAuthToken, getPrisma } from "../setup";
import {
  createPatientFixture,
  createAppointmentFixture,
  createDoctorWithToken,
  createPrescriptionFixture,
} from "../factories";
import { waitForAuditFlush } from "../helpers/audit-wait";

let app: any;
let adminToken: string;
let pharmacistToken: string;
let patientToken: string;
let prisma: any;

async function makeRx() {
  const { doctor } = await createDoctorWithToken();
  const patient = await createPatientFixture();
  const appt = await createAppointmentFixture({
    patientId: patient.id,
    doctorId: doctor.id,
  });
  return createPrescriptionFixture({
    patientId: patient.id,
    doctorId: doctor.id,
    appointmentId: appt.id,
  });
}

describeIfDB("Pharmacy Kanban — gap row 104 (Pearl §4.3)", () => {
  beforeAll(async () => {
    await resetDB();
    prisma = await getPrisma();
    adminToken = await getAuthToken("ADMIN");
    pharmacistToken = await getAuthToken("PHARMACIST");
    patientToken = await getAuthToken("PATIENT");
    const mod = await import("../../app");
    app = mod.app;
  });

  // Each test mints a fresh prescription via makeRx() so we can assert on
  // the single PRESCRIPTION_KANBAN_TRANSITION row for that Rx without
  // racing parallel tests in the same file.

  it("PENDING → DISPENSING transitions with 200 and flips the status", async () => {
    const rx = await makeRx();
    const res = await request(app)
      .patch(`/api/v1/pharmacy/prescriptions/${rx.id}/status`)
      .set("Authorization", `Bearer ${pharmacistToken}`)
      .send({ status: "DISPENSING" });
    expect(res.status).toBe(200);
    expect(res.body.data?.status).toBe("DISPENSING");
    const reloaded = await prisma.prescription.findUnique({ where: { id: rx.id } });
    expect(reloaded?.status).toBe("DISPENSING");
  });

  it("PENDING → DISPENSED (skipping intermediates) is rejected with 409", async () => {
    const rx = await makeRx();
    const res = await request(app)
      .patch(`/api/v1/pharmacy/prescriptions/${rx.id}/status`)
      .set("Authorization", `Bearer ${pharmacistToken}`)
      .send({ status: "DISPENSED" });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/Invalid transition/i);
    const reloaded = await prisma.prescription.findUnique({ where: { id: rx.id } });
    expect(reloaded?.status).toBe("PENDING");
  });

  it("DISPENSED → DISPENSING is rejected with 409 (terminal can't be un-dispensed)", async () => {
    const rx = await makeRx();
    // Set straight to DISPENSED via Prisma to avoid driving through the
    // full /pharmacy/dispense path (which mutates inventory).
    await prisma.prescription.update({
      where: { id: rx.id },
      data: { status: "DISPENSED" },
    });
    const res = await request(app)
      .patch(`/api/v1/pharmacy/prescriptions/${rx.id}/status`)
      .set("Authorization", `Bearer ${pharmacistToken}`)
      .send({ status: "DISPENSING" });
    expect(res.status).toBe(409);
  });

  it("READY → DISPENSING is allowed (pharmacist step-back for re-mix)", async () => {
    const rx = await makeRx();
    await prisma.prescription.update({
      where: { id: rx.id },
      data: { status: "READY" },
    });
    const res = await request(app)
      .patch(`/api/v1/pharmacy/prescriptions/${rx.id}/status`)
      .set("Authorization", `Bearer ${pharmacistToken}`)
      .send({ status: "DISPENSING" });
    expect(res.status).toBe(200);
    expect(res.body.data?.status).toBe("DISPENSING");
  });

  it("ADMIN can mutate", async () => {
    const rx = await makeRx();
    const res = await request(app)
      .patch(`/api/v1/pharmacy/prescriptions/${rx.id}/status`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ status: "DISPENSING" });
    expect(res.status).toBe(200);
  });

  it("PATIENT is rejected with 403", async () => {
    const rx = await makeRx();
    const res = await request(app)
      .patch(`/api/v1/pharmacy/prescriptions/${rx.id}/status`)
      .set("Authorization", `Bearer ${patientToken}`)
      .send({ status: "DISPENSING" });
    expect(res.status).toBe(403);
  });

  it("writes PRESCRIPTION_KANBAN_TRANSITION audit row with from/to payload on success", async () => {
    const rx = await makeRx();
    const res = await request(app)
      .patch(`/api/v1/pharmacy/prescriptions/${rx.id}/status`)
      .set("Authorization", `Bearer ${pharmacistToken}`)
      .send({ status: "DISPENSING" });
    expect(res.status).toBe(200);
    // The handler uses awaited auditLog (not safeAudit), so the row
    // is guaranteed present by the time the 200 returns — but use the
    // wait helper as belt + braces per CLAUDE.md gotcha #1.
    const row = await waitForAuditFlush(prisma, {
      action: "PRESCRIPTION_KANBAN_TRANSITION",
      entity: "prescription",
      entityId: rx.id,
    });
    expect(row).toBeTruthy();
    const details = (row as any).details ?? (row as any).payload;
    // AuditLog stores details as JSON; assert shape regardless of column name.
    const flat = typeof details === "string" ? JSON.parse(details) : details;
    expect(flat?.from).toBe("PENDING");
    expect(flat?.to).toBe("DISPENSING");
    expect(flat?.prescriptionId).toBe(rx.id);
  });

  it("GET /pharmacy/kanban groups Rx by status into columns", async () => {
    const rx = await makeRx();
    const res = await request(app)
      .get("/api/v1/pharmacy/kanban?todayOnly=true")
      .set("Authorization", `Bearer ${pharmacistToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data?.columns).toBeTruthy();
    expect(Array.isArray(res.body.data.columns.PENDING)).toBe(true);
    // Our just-created Rx should be visible in PENDING.
    const allIds = (Object.values(res.body.data.columns) as any[][])
      .flat()
      .map((r: any) => r.id);
    expect(allIds).toContain(rx.id);
  });
});
