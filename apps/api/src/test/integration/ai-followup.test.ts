// Integration tests for the AI Follow-up Scheduler router (/api/v1/ai/followup).
// follow-up service is NOT mocked end-to-end — we exercise the real
// parseFollowUpTimeline + slot finder to prove the scheduler works against
// a seeded doctor schedule. Notification sender is mocked.
// Skipped unless DATABASE_URL_TEST is set.
import { it, expect, beforeAll, vi } from "vitest";
import request from "supertest";
import { describeIfDB, resetDB, getPrisma, getAuthToken } from "../setup";
import {
  createPatientFixture,
  createDoctorWithToken,
  createAppointmentFixture,
} from "../factories";

vi.mock("../../services/notification", () => ({
  sendNotification: vi.fn().mockResolvedValue(undefined),
}));

let app: any;
let adminToken: string;
let patientToken: string;

// Seed a consultation with a SOAP-style notes block containing a
// follow-up timeline. We also seed a doctor schedule so the suggester can
// pick a real slot.
async function seedConsultationWithFollowUp(opts: {
  followUpText: string;
  patientId?: string;
  doctorId?: string;
  doctorToken?: string;
}): Promise<{
  consultationId: string;
  patientId: string;
  doctorId: string;
  appointmentId: string;
  doctorToken: string;
}> {
  const prisma = await getPrisma();
  const patient = opts.patientId
    ? { id: opts.patientId }
    : await createPatientFixture();

  let doctorId = opts.doctorId;
  let doctorToken = opts.doctorToken;
  if (!doctorId) {
    const d = await createDoctorWithToken();
    doctorId = d.doctor.id;
    doctorToken = d.token;
  }

  // Seed the doctor's weekly schedule — Mon-Sun, 09:00-17:00, 15-min slots.
  // (Upsert so repeated calls don't collide on the unique constraint.)
  for (let dow = 0; dow < 7; dow++) {
    await prisma.doctorSchedule.upsert({
      where: {
        doctorId_dayOfWeek_startTime: {
          doctorId: doctorId!,
          dayOfWeek: dow,
          startTime: "09:00",
        },
      },
      create: {
        doctorId: doctorId!,
        dayOfWeek: dow,
        startTime: "09:00",
        endTime: "17:00",
        slotDurationMinutes: 15,
      },
      update: {},
    });
  }

  const appt = await createAppointmentFixture({
    patientId: patient.id,
    doctorId: doctorId!,
  });

  const notes =
    `[AI Scribe — Doctor Approved]\n\n` +
    `Subjective: {"chiefComplaint":"Cough"}\n\n` +
    `Objective: {"vitals":"normal"}\n\n` +
    `Assessment: Viral URI\n\n` +
    `Plan: ${JSON.stringify({ followUpTimeline: opts.followUpText, patientInstructions: "Rest" })}`;

  const consultation = await prisma.consultation.create({
    data: {
      appointmentId: appt.id,
      doctorId: doctorId!,
      notes,
    },
  });

  return {
    consultationId: consultation.id,
    patientId: patient.id,
    doctorId: doctorId!,
    appointmentId: appt.id,
    doctorToken: doctorToken!,
  };
}

describeIfDB("AI Follow-up Scheduler API (integration)", () => {
  beforeAll(async () => {
    await resetDB();
    adminToken = await getAuthToken("ADMIN");
    patientToken = await getAuthToken("PATIENT");
    const mod = await import("../../app");
    app = mod.app;
  });

  // ─── POST /suggest/:consultationId ────────────────────────────────────

  it("suggests a follow-up slot parsed from 'follow up in 2 weeks'", async () => {
    const { consultationId, doctorId, doctorToken } = await seedConsultationWithFollowUp({
      followUpText: "follow up in 2 weeks for review",
    });

    const res = await request(app)
      .post(`/api/v1/ai/followup/suggest/${consultationId}`)
      .set("Authorization", `Bearer ${doctorToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const s = res.body.data.suggestion;
    expect(s).toBeTruthy();
    expect(s.doctorId).toBe(doctorId);
    expect(s.suggestedDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(s.slotStart).toMatch(/^\d{2}:\d{2}$/);
    // 14 days in the future
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const diff = Math.round(
      (new Date(s.suggestedDate + "T00:00:00").getTime() - today.getTime()) / 86400000
    );
    expect(diff).toBe(14);
  });

  it("returns suggestion=null when no follow-up timeline is documented", async () => {
    const prisma = await getPrisma();
    const patient = await createPatientFixture();
    const { doctor, token } = await createDoctorWithToken();
    const appt = await createAppointmentFixture({ patientId: patient.id, doctorId: doctor.id });
    const consult = await prisma.consultation.create({
      data: {
        appointmentId: appt.id,
        doctorId: doctor.id,
        notes: "No plan documented.",
      },
    });

    const res = await request(app)
      .post(`/api/v1/ai/followup/suggest/${consult.id}`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.suggestion).toBeNull();
    expect(res.body.data.reason).toMatch(/no follow-up/i);
  });

  it("returns 404 for a non-existent consultation", async () => {
    const res = await request(app)
      .post("/api/v1/ai/followup/suggest/550e8400-e29b-41d4-a716-446655440000")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
  });

  it("requires authentication", async () => {
    const res = await request(app).post("/api/v1/ai/followup/suggest/x");
    expect(res.status).toBe(401);
  });

  // ─── POST /:consultationId/book ───────────────────────────────────────

  it("books the suggested follow-up appointment and sends a notification", async () => {
    const { sendNotification } = await import("../../services/notification");
    vi.mocked(sendNotification).mockClear();

    const { consultationId, doctorId, doctorToken, patientId } = await seedConsultationWithFollowUp({
      followUpText: "follow up in 10 days",
    });

    const res = await request(app)
      .post(`/api/v1/ai/followup/${consultationId}/book`)
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({});

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.appointment.patientId).toBe(patientId);
    expect(res.body.data.appointment.doctorId).toBe(doctorId);
    expect(res.body.data.appointment.status).toBe("BOOKED");
    expect(vi.mocked(sendNotification)).toHaveBeenCalledOnce();
  });

  it("returns 400 when booking a consultation with no follow-up timeline", async () => {
    const prisma = await getPrisma();
    const patient = await createPatientFixture();
    const { doctor, token } = await createDoctorWithToken();
    const appt = await createAppointmentFixture({ patientId: patient.id, doctorId: doctor.id });
    const consult = await prisma.consultation.create({
      data: {
        appointmentId: appt.id,
        doctorId: doctor.id,
        notes: "No follow-up documented",
      },
    });

    const res = await request(app)
      .post(`/api/v1/ai/followup/${consult.id}/book`)
      .set("Authorization", `Bearer ${token}`)
      .send({});

    expect(res.status).toBe(400);
  });

  it("returns 404 for booking an unknown consultation", async () => {
    const res = await request(app)
      .post("/api/v1/ai/followup/550e8400-e29b-41d4-a716-446655440000/book")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});
    expect(res.status).toBe(404);
  });

  it("accepts an explicit date/slot/doctor override on booking", async () => {
    const { consultationId, doctorId, doctorToken } = await seedConsultationWithFollowUp({
      followUpText: "follow up in 7 days",
    });
    const target = new Date();
    target.setDate(target.getDate() + 20);
    const iso = target.toISOString().slice(0, 10);

    const res = await request(app)
      .post(`/api/v1/ai/followup/${consultationId}/book`)
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({ suggestedDate: iso, slotStart: "10:30", doctorId });

    expect(res.status).toBe(201);
    expect(res.body.data.appointment.slotStart).toBe("10:30");
  });
});
