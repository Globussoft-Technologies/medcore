// Cross-patient regression tests for AI Bill Explainer + AI Follow-up + AI
// Pre-visit routes — issue #511 (BOLA sweep, follow-up to #474).
//
// What this file covers
// ---------------------
// Issue #511 (HIGH) flagged three handlers under the EXPANDED audit
// criterion (handlers that have `Role.PATIENT` in `authorize(...)` AND a
// row-keyed param, but were missing per-row ownership):
//
//   - POST /api/v1/ai/bill-explainer/:invoiceId/generate
//     Already had an inline `invoice.patient?.userId !== req.user.userId`
//     check; the audit refactored it to the canonical
//     `assertPatientOwnsResource` helper for drift prevention.
//
//   - POST /api/v1/ai/followup/:consultationId/book
//     Real BOLA gap — `authorize(...)` allowed PATIENT for self-service
//     booking, but the handler never compared the consultation's
//     `appointment.patientId` against the caller. Fixed by inserting an
//     `assertPatientOwnsResource` call right after the consultation fetch.
//
//   - GET /api/v1/ai/previsit/:appointmentId
//     The handler's bespoke `authorizeAppointmentAccess` helper already
//     enforces per-row PATIENT ownership AND a stricter
//     attending-doctor-only check. Verified-safe in place; this file is the
//     regression fence so future drift on that helper fails CI.
//
// Per cited route we assert up to three cases:
//   1. PATIENT-A's token operates on PATIENT-B's resource → 403  (the bug)
//   2. PATIENT-A's token operates on PATIENT-A's own resource → 200/201
//      (positive control)
//   3. DOCTOR's token operates on the same resource → 200/201
//      (staff RBAC unbroken)
//
// Why a separate file from cross-patient-rbac.test.ts
// ---------------------------------------------------
// `cross-patient-rbac.test.ts` is the canonical fence for #474 (the
// original CRITICAL sweep). #511 is a HIGH follow-up audit pulling in
// dozens of additional handlers, closed via /medcore-fanout. Concurrent
// agents must not race on a single test file, so each fanout slice owns
// its own per-route test file.

import { it, expect, beforeAll, vi } from "vitest";
import request from "supertest";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { describeIfDB, resetDB, getAuthToken, getPrisma } from "../setup";
import {
  createDoctorWithToken,
  createAppointmentFixture,
  createInvoiceFixture,
} from "../factories";

// Mock the AI generators so the suite has no external dependency on
// SARVAM_API_KEY / OpenAI keys. We're testing access-control semantics,
// not the generator outputs.
vi.mock("../../services/ai/bill-explainer", () => ({
  generateBillExplanation: vi.fn().mockResolvedValue({
    content: "Mocked explanation",
    flaggedItems: [],
    language: "en",
  }),
}));
vi.mock("../../services/ai/previsit", () => ({
  generatePrevisitChecklist: vi.fn().mockResolvedValue({
    items: [
      {
        label: "Government photo ID",
        category: "ID",
        required: true,
        reason: "Required for registration.",
      },
    ],
  }),
}));
vi.mock("../../services/notification", () => ({
  sendNotification: vi.fn().mockResolvedValue(undefined),
}));

let app: any;
let doctorToken: string;
let doctorId: string;
let patientAToken: string;
let patientAId: string;
let patientAUserId: string;
let patientBId: string;
let patientBUserId: string;

// Helper: create a PATIENT user + linked Patient row with a unique email,
// then mint a JWT for that user. We need TWO so we can assert PATIENT-A vs
// PATIENT-B ownership boundaries.
async function createPatientWithToken(
  label: string
): Promise<{ patientId: string; userId: string; token: string }> {
  const prisma = await getPrisma();
  const email = `aibfp_${label}_${Date.now()}_${Math.random()
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
      mrNumber: `MR-AIBFP-${label}-${Date.now()}`,
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

describeIfDB("Cross-patient AI bill-explainer + follow-up + previsit (#511)", () => {
  beforeAll(async () => {
    await resetDB();
    doctorToken = await getAuthToken("DOCTOR");

    const a = await createPatientWithToken("A");
    const b = await createPatientWithToken("B");
    patientAToken = a.token;
    patientAId = a.patientId;
    patientAUserId = a.userId;
    patientBId = b.patientId;
    patientBUserId = b.userId;

    const d = await createDoctorWithToken();
    doctorId = d.doctor.id;

    const mod = await import("../../app");
    app = mod.app;
  });

  // ────────────────────────────────────────────────────────────
  // POST /api/v1/ai/bill-explainer/:invoiceId/generate
  // ────────────────────────────────────────────────────────────

  it("ai/bill-explainer/:invoiceId/generate — PATIENT-A cannot generate explanation for PATIENT-B's invoice (403)", async () => {
    const apt = await createAppointmentFixture({ patientId: patientBId, doctorId });
    const invoice = await createInvoiceFixture({
      patientId: patientBId,
      appointmentId: apt.id,
    });

    const res = await request(app)
      .post(`/api/v1/ai/bill-explainer/${invoice.id}/generate`)
      .set("Authorization", `Bearer ${patientAToken}`);
    expect(res.status).toBe(403);
  });

  it("ai/bill-explainer/:invoiceId/generate — PATIENT-A CAN generate explanation for own invoice (201) [positive control]", async () => {
    const apt = await createAppointmentFixture({ patientId: patientAId, doctorId });
    const invoice = await createInvoiceFixture({
      patientId: patientAId,
      appointmentId: apt.id,
    });

    const res = await request(app)
      .post(`/api/v1/ai/bill-explainer/${invoice.id}/generate`)
      .set("Authorization", `Bearer ${patientAToken}`);
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
  });

  it("ai/bill-explainer/:invoiceId/generate — ADMIN can generate for any invoice (201) [staff control]", async () => {
    const adminToken = await getAuthToken("ADMIN");
    const apt = await createAppointmentFixture({ patientId: patientBId, doctorId });
    const invoice = await createInvoiceFixture({
      patientId: patientBId,
      appointmentId: apt.id,
    });

    const res = await request(app)
      .post(`/api/v1/ai/bill-explainer/${invoice.id}/generate`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(201);
  });

  // ────────────────────────────────────────────────────────────
  // POST /api/v1/ai/followup/:consultationId/book
  // ────────────────────────────────────────────────────────────

  // Helper: seed a consultation (with a follow-up timeline in its plan)
  // for a given patient, plus the doctor's weekly schedule so the suggester
  // can pick a real slot. Returns the consultation id.
  async function seedConsultationForPatient(patientId: string): Promise<string> {
    const prisma = await getPrisma();

    for (let dow = 0; dow < 7; dow++) {
      await prisma.doctorSchedule.upsert({
        where: {
          doctorId_dayOfWeek_startTime: {
            doctorId,
            dayOfWeek: dow,
            startTime: "09:00",
          },
        },
        create: {
          doctorId,
          dayOfWeek: dow,
          startTime: "09:00",
          endTime: "17:00",
          slotDurationMinutes: 15,
        },
        update: {},
      });
    }

    const appt = await createAppointmentFixture({ patientId, doctorId });
    const notes =
      `[AI Scribe — Doctor Approved]\n\n` +
      `Subjective: {"chiefComplaint":"Cough"}\n\n` +
      `Objective: {"vitals":"normal"}\n\n` +
      `Assessment: Viral URI\n\n` +
      `Plan: ${JSON.stringify({
        followUpTimeline: "follow up in 10 days",
        patientInstructions: "Rest",
      })}`;

    const consultation = await prisma.consultation.create({
      data: {
        appointmentId: appt.id,
        doctorId,
        notes,
      },
    });
    return consultation.id;
  }

  it("ai/followup/:consultationId/book — PATIENT-A cannot book follow-up against PATIENT-B's consultation (403)", async () => {
    const consultationId = await seedConsultationForPatient(patientBId);

    const res = await request(app)
      .post(`/api/v1/ai/followup/${consultationId}/book`)
      .set("Authorization", `Bearer ${patientAToken}`)
      .send({});
    expect(res.status).toBe(403);
  });

  it("ai/followup/:consultationId/book — PATIENT-A CAN book follow-up for own consultation (201) [positive control]", async () => {
    const consultationId = await seedConsultationForPatient(patientAId);

    const res = await request(app)
      .post(`/api/v1/ai/followup/${consultationId}/book`)
      .set("Authorization", `Bearer ${patientAToken}`)
      .send({});
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.appointment.patientId).toBe(patientAId);
  });

  it("ai/followup/:consultationId/book — DOCTOR can book follow-up for any consultation (201) [staff control]", async () => {
    const consultationId = await seedConsultationForPatient(patientBId);

    const res = await request(app)
      .post(`/api/v1/ai/followup/${consultationId}/book`)
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({});
    expect(res.status).toBe(201);
    expect(res.body.data.appointment.patientId).toBe(patientBId);
  });

  // ────────────────────────────────────────────────────────────
  // GET /api/v1/ai/previsit/:appointmentId
  // ────────────────────────────────────────────────────────────

  it("ai/previsit/:appointmentId — PATIENT-A cannot read PATIENT-B's checklist (403)", async () => {
    const apt = await createAppointmentFixture({ patientId: patientBId, doctorId });

    const res = await request(app)
      .get(`/api/v1/ai/previsit/${apt.id}`)
      .set("Authorization", `Bearer ${patientAToken}`);
    expect(res.status).toBe(403);
  });

  it("ai/previsit/:appointmentId — PATIENT-A CAN read own checklist (200) [positive control]", async () => {
    const apt = await createAppointmentFixture({ patientId: patientAId, doctorId });

    const res = await request(app)
      .get(`/api/v1/ai/previsit/${apt.id}`)
      .set("Authorization", `Bearer ${patientAToken}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it("ai/previsit/:appointmentId — ADMIN can read any checklist (200) [staff control]", async () => {
    const adminToken = await getAuthToken("ADMIN");
    const apt = await createAppointmentFixture({ patientId: patientBId, doctorId });

    const res = await request(app)
      .get(`/api/v1/ai/previsit/${apt.id}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
  });
});
