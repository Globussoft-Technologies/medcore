// Cross-patient RBAC regression suite — issue #474.
//
// What this file covers
// ---------------------
// Issue #474 (Critical, OWASP API1:2023 BOLA / CWE-285) reported that a
// PATIENT-role JWT could read other patients' admissions, surgery
// records, lab orders, telemedicine sessions, prescriptions, plus a
// pile of operational endpoints (wards, ER, blood-bank inventory,
// medication MAR queue) that are clinical-staff only.
//
// The pre-existing `e2e/rbac-matrix.spec.ts` only inspected the page
// chrome the dashboard renders for each role (Playwright). The API
// integration tests covered "PATIENT cannot 401 / cannot escalate"
// but never asserted "PATIENT-A cannot fetch PATIENT-B's row by id."
// This file closes that exact gap.
//
// Modules / routes asserted
// -------------------------
// - GET /api/v1/admissions/:id            (BOLA: per-row owner check)
// - GET /api/v1/surgery/:id               (BOLA: per-row owner check)
// - GET /api/v1/lab/orders/:id            (BOLA: per-row owner check)
// - GET /api/v1/telemedicine/:id          (BOLA: per-row owner check)
// - GET /api/v1/prescriptions/:id         (BOLA: per-row owner check)
// - GET /api/v1/wards                     (operational: PATIENT denied)
// - GET /api/v1/wards/:id                 (operational: PATIENT denied)
// - GET /api/v1/emergency/cases           (operational: PATIENT denied)
// - GET /api/v1/emergency/cases/active    (operational: PATIENT denied)
// - GET /api/v1/emergency/cases/:id       (operational: PATIENT denied)
// - GET /api/v1/emergency/stats           (operational: PATIENT denied)
// - GET /api/v1/bloodbank/inventory/summary (operational: PATIENT denied)
// - GET /api/v1/medication/orders         (operational: PATIENT denied)
// - GET /api/v1/medication/administrations (operational: PATIENT denied)
// - GET /api/v1/medication/administrations/due (operational: PATIENT denied)
//
// Per cited route the suite asserts up to three cases:
//   1. PATIENT-A's token GETs PATIENT-B's resource → 403  (the bug)
//   2. PATIENT-A's token GETs PATIENT-A's own resource → 200  (positive control)
//   3. DOCTOR's token GETs the same resource → 200  (staff RBAC unbroken)
// For operational endpoints only (1) (PATIENT denied) and (3) apply.

import { it, expect, beforeAll } from "vitest";
import request from "supertest";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { describeIfDB, resetDB, getAuthToken, getPrisma } from "../setup";
import {
  createDoctorFixture,
  createWardFixture,
  createBedFixture,
  createAdmissionFixture,
  createOperatingTheaterFixture,
  createLabTestFixture,
  createLabOrderFixture,
  createAppointmentFixture,
  createPrescriptionFixture,
} from "../factories";

let app: any;
let doctorToken: string;
let patientAToken: string;
let patientBToken: string;
let patientAId: string;
let patientBId: string;
let doctorId: string;

// Helper: create a PATIENT user + linked Patient row with a unique email,
// then mint a JWT for that user. The shared `getAuthToken("PATIENT")`
// only ever returns a single canonical patient — we need TWO so we can
// assert PATIENT-A vs PATIENT-B.
async function createPatientWithToken(
  label: string
): Promise<{ patientId: string; userId: string; token: string }> {
  const prisma = await getPrisma();
  const email = `patient_${label}_${Date.now()}_${Math.random()
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
      mrNumber: `MR-${label}-${Date.now()}`,
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

describeIfDB("Cross-patient RBAC (issue #474 — BOLA / CWE-285)", () => {
  beforeAll(async () => {
    await resetDB();
    doctorToken = await getAuthToken("DOCTOR");

    const a = await createPatientWithToken("A");
    const b = await createPatientWithToken("B");
    patientAToken = a.token;
    patientBToken = b.token;
    patientAId = a.patientId;
    patientBId = b.patientId;

    const doctor = await createDoctorFixture();
    doctorId = doctor.id;

    const mod = await import("../../app");
    app = mod.app;
  });

  // ───────────────────────────────────────────────────────
  // Per-row BOLA cases (PATIENT-A ➜ PATIENT-B's row → 403)
  // ───────────────────────────────────────────────────────

  it("admissions: PATIENT-A cannot GET PATIENT-B's admission (403)", async () => {
    const ward = await createWardFixture();
    const bed = await createBedFixture({ wardId: ward.id });
    const admB = await createAdmissionFixture({
      patientId: patientBId,
      doctorId,
      bedId: bed.id,
    });

    const res = await request(app)
      .get(`/api/v1/admissions/${admB.id}`)
      .set("Authorization", `Bearer ${patientAToken}`);
    expect(res.status).toBe(403);
  });

  it("admissions: PATIENT-A CAN GET own admission (200) [positive control]", async () => {
    const ward = await createWardFixture();
    const bed = await createBedFixture({ wardId: ward.id });
    const admA = await createAdmissionFixture({
      patientId: patientAId,
      doctorId,
      bedId: bed.id,
    });

    const res = await request(app)
      .get(`/api/v1/admissions/${admA.id}`)
      .set("Authorization", `Bearer ${patientAToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data?.id).toBe(admA.id);
  });

  it("admissions: DOCTOR can GET any admission (200) [staff control]", async () => {
    const ward = await createWardFixture();
    const bed = await createBedFixture({ wardId: ward.id });
    const admB = await createAdmissionFixture({
      patientId: patientBId,
      doctorId,
      bedId: bed.id,
    });

    const res = await request(app)
      .get(`/api/v1/admissions/${admB.id}`)
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(res.status).toBe(200);
  });

  it("surgery: PATIENT-A cannot GET PATIENT-B's surgery (403)", async () => {
    const prisma = await getPrisma();
    const ot = await createOperatingTheaterFixture();
    const surgery = await prisma.surgery.create({
      data: {
        caseNumber: `SRG-XPB-${Date.now()}`,
        patientId: patientBId,
        surgeonId: doctorId,
        otId: ot.id,
        procedure: "Appendectomy",
        scheduledAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        durationMin: 60,
      },
    });
    const res = await request(app)
      .get(`/api/v1/surgery/${surgery.id}`)
      .set("Authorization", `Bearer ${patientAToken}`);
    expect(res.status).toBe(403);
  });

  it("surgery: PATIENT-A CAN GET own surgery (200) [positive control]", async () => {
    const prisma = await getPrisma();
    const ot = await createOperatingTheaterFixture();
    const surgery = await prisma.surgery.create({
      data: {
        caseNumber: `SRG-XPA-${Date.now()}`,
        patientId: patientAId,
        surgeonId: doctorId,
        otId: ot.id,
        procedure: "Appendectomy",
        scheduledAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        durationMin: 60,
      },
    });
    const res = await request(app)
      .get(`/api/v1/surgery/${surgery.id}`)
      .set("Authorization", `Bearer ${patientAToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data?.id).toBe(surgery.id);
  });

  it("surgery: DOCTOR can GET any surgery (200) [staff control]", async () => {
    const prisma = await getPrisma();
    const ot = await createOperatingTheaterFixture();
    const surgery = await prisma.surgery.create({
      data: {
        caseNumber: `SRG-DOC-${Date.now()}`,
        patientId: patientBId,
        surgeonId: doctorId,
        otId: ot.id,
        procedure: "Appendectomy",
        scheduledAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        durationMin: 60,
      },
    });
    const res = await request(app)
      .get(`/api/v1/surgery/${surgery.id}`)
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(res.status).toBe(200);
  });

  it("lab orders: PATIENT-A cannot GET PATIENT-B's lab order (403)", async () => {
    const test = await createLabTestFixture();
    const order = await createLabOrderFixture({
      patientId: patientBId,
      doctorId,
      testIds: [test.id],
    });
    const res = await request(app)
      .get(`/api/v1/lab/orders/${order.id}`)
      .set("Authorization", `Bearer ${patientAToken}`);
    expect(res.status).toBe(403);
  });

  it("lab orders: PATIENT-A CAN GET own lab order (200) [positive control]", async () => {
    const test = await createLabTestFixture();
    const order = await createLabOrderFixture({
      patientId: patientAId,
      doctorId,
      testIds: [test.id],
    });
    const res = await request(app)
      .get(`/api/v1/lab/orders/${order.id}`)
      .set("Authorization", `Bearer ${patientAToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data?.id).toBe(order.id);
  });

  it("lab orders: DOCTOR can GET any lab order (200) [staff control]", async () => {
    const test = await createLabTestFixture();
    const order = await createLabOrderFixture({
      patientId: patientBId,
      doctorId,
      testIds: [test.id],
    });
    const res = await request(app)
      .get(`/api/v1/lab/orders/${order.id}`)
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(res.status).toBe(200);
  });

  it("telemedicine: PATIENT-A cannot GET PATIENT-B's session (403)", async () => {
    const prisma = await getPrisma();
    const session = await prisma.telemedicineSession.create({
      data: {
        sessionNumber: `TMS-XPB-${Date.now()}`,
        patientId: patientBId,
        doctorId,
        scheduledAt: new Date(Date.now() + 60 * 60 * 1000),
        fee: 500,
      },
    });
    const res = await request(app)
      .get(`/api/v1/telemedicine/${session.id}`)
      .set("Authorization", `Bearer ${patientAToken}`);
    expect(res.status).toBe(403);
  });

  it("telemedicine: PATIENT-A CAN GET own session (200) [positive control]", async () => {
    const prisma = await getPrisma();
    const session = await prisma.telemedicineSession.create({
      data: {
        sessionNumber: `TMS-XPA-${Date.now()}`,
        patientId: patientAId,
        doctorId,
        scheduledAt: new Date(Date.now() + 60 * 60 * 1000),
        fee: 500,
      },
    });
    const res = await request(app)
      .get(`/api/v1/telemedicine/${session.id}`)
      .set("Authorization", `Bearer ${patientAToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data?.id).toBe(session.id);
  });

  it("telemedicine: DOCTOR can GET any session (200) [staff control]", async () => {
    const prisma = await getPrisma();
    const session = await prisma.telemedicineSession.create({
      data: {
        sessionNumber: `TMS-DOC-${Date.now()}`,
        patientId: patientBId,
        doctorId,
        scheduledAt: new Date(Date.now() + 60 * 60 * 1000),
        fee: 500,
      },
    });
    const res = await request(app)
      .get(`/api/v1/telemedicine/${session.id}`)
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(res.status).toBe(200);
  });

  it("prescriptions: PATIENT-A cannot GET PATIENT-B's prescription (403)", async () => {
    const apt = await createAppointmentFixture({
      patientId: patientBId,
      doctorId,
    });
    const rx = await createPrescriptionFixture({
      patientId: patientBId,
      doctorId,
      appointmentId: apt.id,
    });
    const res = await request(app)
      .get(`/api/v1/prescriptions/${rx.id}`)
      .set("Authorization", `Bearer ${patientAToken}`);
    expect(res.status).toBe(403);
  });

  it("prescriptions: PATIENT-A CAN GET own prescription (200) [positive control]", async () => {
    const apt = await createAppointmentFixture({
      patientId: patientAId,
      doctorId,
    });
    const rx = await createPrescriptionFixture({
      patientId: patientAId,
      doctorId,
      appointmentId: apt.id,
    });
    const res = await request(app)
      .get(`/api/v1/prescriptions/${rx.id}`)
      .set("Authorization", `Bearer ${patientAToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data?.id).toBe(rx.id);
  });

  it("prescriptions: DOCTOR can GET any prescription (200) [staff control]", async () => {
    const apt = await createAppointmentFixture({
      patientId: patientBId,
      doctorId,
    });
    const rx = await createPrescriptionFixture({
      patientId: patientBId,
      doctorId,
      appointmentId: apt.id,
    });
    const res = await request(app)
      .get(`/api/v1/prescriptions/${rx.id}`)
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(res.status).toBe(200);
  });

  // ───────────────────────────────────────────────────────
  // Operational endpoints — PATIENT denied entirely
  // ───────────────────────────────────────────────────────

  it("wards (cited): PATIENT cannot GET /wards (403)", async () => {
    const res = await request(app)
      .get("/api/v1/wards")
      .set("Authorization", `Bearer ${patientAToken}`);
    expect(res.status).toBe(403);
  });

  it("wards: DOCTOR can GET /wards (200)", async () => {
    const res = await request(app)
      .get("/api/v1/wards")
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(res.status).toBe(200);
  });

  it("wards: PATIENT cannot GET /wards/:id (403)", async () => {
    const ward = await createWardFixture();
    const res = await request(app)
      .get(`/api/v1/wards/${ward.id}`)
      .set("Authorization", `Bearer ${patientAToken}`);
    expect(res.status).toBe(403);
  });

  it("emergency (cited): PATIENT cannot GET /emergency/cases/active (403)", async () => {
    const res = await request(app)
      .get("/api/v1/emergency/cases/active")
      .set("Authorization", `Bearer ${patientAToken}`);
    expect(res.status).toBe(403);
  });

  it("emergency: DOCTOR can GET /emergency/cases/active (200)", async () => {
    const res = await request(app)
      .get("/api/v1/emergency/cases/active")
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(res.status).toBe(200);
  });

  it("emergency: PATIENT cannot GET /emergency/cases (403)", async () => {
    const res = await request(app)
      .get("/api/v1/emergency/cases")
      .set("Authorization", `Bearer ${patientAToken}`);
    expect(res.status).toBe(403);
  });

  it("emergency: PATIENT cannot GET /emergency/stats (403)", async () => {
    const res = await request(app)
      .get("/api/v1/emergency/stats")
      .set("Authorization", `Bearer ${patientAToken}`);
    expect(res.status).toBe(403);
  });

  it("emergency: PATIENT cannot GET /emergency/cases/:id (403)", async () => {
    const prisma = await getPrisma();
    const ecase = await prisma.emergencyCase.create({
      data: {
        caseNumber: `ER-XPB-${Date.now()}`,
        patientId: patientBId,
        chiefComplaint: "Chest pain",
        arrivedAt: new Date(),
        status: "WAITING" as any,
      },
    });
    const res = await request(app)
      .get(`/api/v1/emergency/cases/${ecase.id}`)
      .set("Authorization", `Bearer ${patientAToken}`);
    expect(res.status).toBe(403);
  });

  it("bloodbank (cited): PATIENT cannot GET /bloodbank/inventory/summary (403)", async () => {
    const res = await request(app)
      .get("/api/v1/bloodbank/inventory/summary")
      .set("Authorization", `Bearer ${patientAToken}`);
    expect(res.status).toBe(403);
  });

  it("bloodbank: DOCTOR can GET /bloodbank/inventory/summary (200)", async () => {
    const res = await request(app)
      .get("/api/v1/bloodbank/inventory/summary")
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(res.status).toBe(200);
  });

  it("medication (cited): PATIENT cannot GET /medication/administrations/due (403)", async () => {
    const res = await request(app)
      .get("/api/v1/medication/administrations/due")
      .set("Authorization", `Bearer ${patientAToken}`);
    expect(res.status).toBe(403);
  });

  it("medication: DOCTOR can GET /medication/administrations/due (200)", async () => {
    const res = await request(app)
      .get("/api/v1/medication/administrations/due")
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(res.status).toBe(200);
  });

  it("medication: PATIENT cannot GET /medication/orders (403)", async () => {
    const res = await request(app)
      .get("/api/v1/medication/orders?admissionId=any")
      .set("Authorization", `Bearer ${patientAToken}`);
    expect(res.status).toBe(403);
  });

  it("medication: PATIENT cannot GET /medication/administrations (403)", async () => {
    const res = await request(app)
      .get("/api/v1/medication/administrations?admissionId=any")
      .set("Authorization", `Bearer ${patientAToken}`);
    expect(res.status).toBe(403);
  });
});
