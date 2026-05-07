// Cross-patient prescription RBAC regression suite — issue #511 long tail.
//
// What this file covers
// ---------------------
// `apps/api/src/routes/prescriptions.ts` is in the universe of route files
// where `authorize(...)` includes `Role.PATIENT`. The original #474 sweep
// patched GET `/:id` (the headline BOLA), but the per-handler audit under
// the EXPANDED #511 criterion surfaced two more handlers that were also
// reachable by PATIENT yet had no per-row owner check:
//
//   - GET    /:id/pdf       — printable HTML / actual application/pdf buffer
//   - GET    /:id/leaflets  — diagnosis + medicine leaflet payload
//
// Plus one handler with hand-rolled inline ownership logic that was
// refactored onto the canonical helper for drift-prevention:
//
//   - POST   /:id/share     — record share via WhatsApp/Email/SMS (#242)
//
// Per cited route the suite asserts three cases:
//   1. PATIENT-A's token GETs PATIENT-B's resource → 403  (the bug)
//   2. PATIENT-A's token GETs PATIENT-A's own resource → 200  (positive control)
//   3. DOCTOR's token GETs the same resource → 200  (staff RBAC unbroken)
//
// Why a per-route file
// --------------------
// The /medcore-fanout pattern dispatches multiple agents in parallel, each
// owning a unique route file. Per-route test files prevent race conditions
// on the canonical `cross-patient-rbac.test.ts` and keep the per-route
// regression suite locally diffable.

import { it, expect, beforeAll } from "vitest";
import request from "supertest";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { describeIfDB, resetDB, getAuthToken, getPrisma } from "../setup";
import {
  createDoctorFixture,
  createAppointmentFixture,
  createPrescriptionFixture,
} from "../factories";

let app: any;
let doctorToken: string;
let patientAToken: string;
let patientAId: string;
let patientBId: string;
let doctorId: string;

// Helper mirrors the one in cross-patient-rbac.test.ts: spin up two
// independent PATIENT users so we can assert the BOLA gap directly. The
// shared `getAuthToken("PATIENT")` only ever returns one canonical patient.
async function createPatientWithToken(
  label: string
): Promise<{ patientId: string; userId: string; token: string }> {
  const prisma = await getPrisma();
  const email = `patient_rx_${label}_${Date.now()}_${Math.random()
    .toString(36)
    .slice(2, 6)}@test.local`;
  const user = await prisma.user.create({
    data: {
      email,
      name: `Patient ${label}`,
      phone: "9000000000",
      passwordHash: await bcrypt.hash("MedCoreT3st-2026", 4),
      role: "PATIENT" as any,
    },
  });
  const patient = await prisma.patient.create({
    data: {
      userId: user.id,
      mrNumber: `MR-RX-${label}-${Date.now()}`,
      dateOfBirth: new Date("1990-01-01"),
      gender: "MALE" as any,
    },
  });
  const token = jwt.sign(
    { userId: user.id, email, role: "PATIENT" },
    process.env.JWT_SECRET || "test-jwt-secret-do-not-use-in-prod",
    { expiresIn: "1h" }
  );
  return { patientId: patient.id, userId: user.id, token };
}

describeIfDB("Cross-patient prescription RBAC (issue #511 — expanded BOLA)", () => {
  beforeAll(async () => {
    await resetDB();
    doctorToken = await getAuthToken("DOCTOR");

    const a = await createPatientWithToken("A");
    const b = await createPatientWithToken("B");
    patientAToken = a.token;
    patientAId = a.patientId;
    patientBId = b.patientId;

    const doctor = await createDoctorFixture();
    doctorId = doctor.id;

    const mod = await import("../../app");
    app = mod.app;
  });

  // ───────────────────────────────────────────────────────
  // GET /:id/pdf — PDF / printable HTML render
  // ───────────────────────────────────────────────────────

  it("/:id/pdf: PATIENT-A cannot GET PATIENT-B's prescription PDF (403)", async () => {
    const apt = await createAppointmentFixture({ patientId: patientBId, doctorId });
    const rx = await createPrescriptionFixture({
      patientId: patientBId,
      doctorId,
      appointmentId: apt.id,
    });
    const res = await request(app)
      .get(`/api/v1/prescriptions/${rx.id}/pdf`)
      .set("Authorization", `Bearer ${patientAToken}`);
    expect(res.status).toBe(403);
  });

  it("/:id/pdf: PATIENT-A CAN GET own prescription PDF (200) [positive control]", async () => {
    const apt = await createAppointmentFixture({ patientId: patientAId, doctorId });
    const rx = await createPrescriptionFixture({
      patientId: patientAId,
      doctorId,
      appointmentId: apt.id,
    });
    const res = await request(app)
      .get(`/api/v1/prescriptions/${rx.id}/pdf`)
      .set("Authorization", `Bearer ${patientAToken}`);
    expect(res.status).toBe(200);
  });

  it("/:id/pdf: DOCTOR can GET any prescription PDF (200) [staff control]", async () => {
    const apt = await createAppointmentFixture({ patientId: patientBId, doctorId });
    const rx = await createPrescriptionFixture({
      patientId: patientBId,
      doctorId,
      appointmentId: apt.id,
    });
    const res = await request(app)
      .get(`/api/v1/prescriptions/${rx.id}/pdf`)
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(res.status).toBe(200);
  });

  // ───────────────────────────────────────────────────────
  // GET /:id/leaflets — medicine leaflet payload
  // ───────────────────────────────────────────────────────

  it("/:id/leaflets: PATIENT-A cannot GET PATIENT-B's leaflets (403)", async () => {
    const apt = await createAppointmentFixture({ patientId: patientBId, doctorId });
    const rx = await createPrescriptionFixture({
      patientId: patientBId,
      doctorId,
      appointmentId: apt.id,
    });
    const res = await request(app)
      .get(`/api/v1/prescriptions/${rx.id}/leaflets`)
      .set("Authorization", `Bearer ${patientAToken}`);
    expect(res.status).toBe(403);
  });

  it("/:id/leaflets: PATIENT-A CAN GET own leaflets (200) [positive control]", async () => {
    const apt = await createAppointmentFixture({ patientId: patientAId, doctorId });
    const rx = await createPrescriptionFixture({
      patientId: patientAId,
      doctorId,
      appointmentId: apt.id,
    });
    const res = await request(app)
      .get(`/api/v1/prescriptions/${rx.id}/leaflets`)
      .set("Authorization", `Bearer ${patientAToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data?.prescriptionId).toBe(rx.id);
  });

  it("/:id/leaflets: DOCTOR can GET any leaflets (200) [staff control]", async () => {
    const apt = await createAppointmentFixture({ patientId: patientBId, doctorId });
    const rx = await createPrescriptionFixture({
      patientId: patientBId,
      doctorId,
      appointmentId: apt.id,
    });
    const res = await request(app)
      .get(`/api/v1/prescriptions/${rx.id}/leaflets`)
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(res.status).toBe(200);
  });

  // ───────────────────────────────────────────────────────
  // POST /:id/share — share-channel marker (refactor regression)
  // The existing inline owner check (issue #242) was refactored onto the
  // canonical assertPatientOwnsResource helper. These assertions guard
  // against regression of the previously-correct behaviour now that the
  // implementation has moved.
  // ───────────────────────────────────────────────────────

  it("/:id/share: PATIENT-A cannot share PATIENT-B's prescription (403)", async () => {
    const apt = await createAppointmentFixture({ patientId: patientBId, doctorId });
    const rx = await createPrescriptionFixture({
      patientId: patientBId,
      doctorId,
      appointmentId: apt.id,
    });
    const res = await request(app)
      .post(`/api/v1/prescriptions/${rx.id}/share`)
      .set("Authorization", `Bearer ${patientAToken}`)
      .send({ channel: "WHATSAPP" });
    expect(res.status).toBe(403);
  });

  // RBAC positive control. We use the SMS channel because it's the only
  // channel still gated with a 501 (no provider integration yet). EMAIL and
  // WHATSAPP are now wired and would 502 in the test env where neither
  // SendGrid nor the Meta Cloud API are configured. The 501 here still
  // proves the RBAC + ownership checks passed (got past authorize() and
  // assertPatientOwnsResource()) — a real BOLA breach would 403/404.
  it("/:id/share: PATIENT-A reaches own-Rx share endpoint (501 = SMS unwired) [positive control]", async () => {
    const apt = await createAppointmentFixture({ patientId: patientAId, doctorId });
    const rx = await createPrescriptionFixture({
      patientId: patientAId,
      doctorId,
      appointmentId: apt.id,
    });
    const res = await request(app)
      .post(`/api/v1/prescriptions/${rx.id}/share`)
      .set("Authorization", `Bearer ${patientAToken}`)
      .send({ channel: "SMS" });
    expect(res.status).toBe(501);
    expect(res.body.error).toMatch(/not yet available/i);
  });

  // Staff (DOCTOR) bypasses the patient-owns check via authorize(). Same
  // 501-as-RBAC-pass pattern using SMS for the same reason as above.
  it("/:id/share: DOCTOR reaches any-Rx share endpoint (501 = SMS unwired) [staff control]", async () => {
    const apt = await createAppointmentFixture({ patientId: patientBId, doctorId });
    const rx = await createPrescriptionFixture({
      patientId: patientBId,
      doctorId,
      appointmentId: apt.id,
    });
    const res = await request(app)
      .post(`/api/v1/prescriptions/${rx.id}/share`)
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({ channel: "SMS" });
    expect(res.status).toBe(501);
  });
});
