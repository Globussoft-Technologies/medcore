// Integration tests for the public quick-appointment booking router
// (/api/v1/public/booking) — the unauthenticated marketing-site booking flow.
//
// Contract under test:
//   1. /suggest-doctors returns AVAILABLE doctors (with open slots) for a
//      symptom + date; doctors with no schedule that day are excluded.
//   2. /book auto-registers the caller as a PATIENT (by phone), books the
//      appointment, and is reachable with NO auth.
//   3. Re-booking with the SAME phone reuses the existing patient (no
//      duplicate User/Patient row).
//   4. A second booking on the same doctor+date+slot is rejected (409).
//
// The Sarvam LLM is mocked (no API key needed) to return a General-Medicine
// specialty so it matches the General-Medicine factory doctor. WhatsApp is
// mocked so the confirmation send is a no-op.

import { it, expect, beforeAll, vi } from "vitest";
import request from "supertest";
import { describeIfDB, resetDB, getPrisma } from "../setup";
import { createDoctorFixture } from "../factories";

vi.mock("../../services/ai/sarvam", () => ({
  extractSymptomSummary: vi.fn().mockResolvedValue({
    chiefComplaint: "Fever",
    specialties: [
      { specialty: "General Medicine", confidence: 0.8, reasoning: "Initial evaluation" },
    ],
    confidence: 0.8,
  }),
}));

vi.mock("../../services/channels/whatsapp", () => ({
  sendWhatsApp: vi.fn().mockResolvedValue({ ok: true, messageId: "wa-test" }),
}));

let app: any;

// A fixed FUTURE date so slots are never "in the past". We compute its weekday
// and seed the doctor's schedule for that day so /suggest-doctors yields slots.
const FUTURE = new Date();
FUTURE.setDate(FUTURE.getDate() + 7);
const FUTURE_ISO = `${FUTURE.getFullYear()}-${String(FUTURE.getMonth() + 1).padStart(2, "0")}-${String(FUTURE.getDate()).padStart(2, "0")}`;
const FUTURE_DOW = new Date(FUTURE_ISO).getDay();

describeIfDB("Public quick-booking API (integration)", () => {
  let doctorId: string;

  beforeAll(async () => {
    await resetDB();
    const mod = await import("../../app");
    app = mod.app;

    const prisma = await getPrisma();
    const doctor = await createDoctorFixture({
      specialization: "General Medicine",
    });
    doctorId = doctor.id;
    // 09:00–12:00, 15-min slots on the future date's weekday.
    await prisma.doctorSchedule.create({
      data: {
        doctorId,
        dayOfWeek: FUTURE_DOW,
        startTime: "09:00",
        endTime: "12:00",
        slotDurationMinutes: 15,
      },
    });
  });

  it("suggests available doctors with open slots (no auth)", async () => {
    const res = await request(app)
      .post("/api/v1/public/booking/suggest-doctors")
      .send({ symptom: "fever", date: FUTURE_ISO });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const doctors = res.body.data.doctors;
    expect(Array.isArray(doctors)).toBe(true);
    const found = doctors.find((d: any) => d.doctorId === doctorId);
    expect(found).toBeTruthy();
    expect(found.slots.length).toBeGreaterThan(0);
    expect(found.slots).toContain("09:00");
  });

  it("books an appointment AND auto-registers the patient by phone (no auth)", async () => {
    const phone = "9123450099";
    const res = await request(app)
      .post("/api/v1/public/booking/book")
      .send({
        name: "Quick Booker",
        phone,
        doctorId,
        date: FUTURE_ISO,
        slotId: "09:00",
        symptom: "fever",
      });
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.appointmentId).toBeTruthy();

    // The patient was auto-created and is keyed by the canonical phone.
    const prisma = await getPrisma();
    const user = await prisma.user.findFirst({
      where: { phone, role: "PATIENT" },
      include: { patient: true },
    });
    expect(user).toBeTruthy();
    expect(user?.patient).toBeTruthy();
    expect(user?.name).toBe("Quick Booker");
  });

  it("reuses the existing patient when the same phone books again (no duplicate)", async () => {
    const phone = "9123450098";
    // First booking creates the patient.
    await request(app).post("/api/v1/public/booking/book").send({
      name: "Repeat Booker",
      phone,
      doctorId,
      date: FUTURE_ISO,
      slotId: "09:15",
      symptom: "cough",
    });
    // Second booking on a different slot.
    const res2 = await request(app).post("/api/v1/public/booking/book").send({
      name: "Repeat Booker",
      phone,
      doctorId,
      date: FUTURE_ISO,
      slotId: "09:30",
    });
    expect(res2.status).toBe(201);

    const prisma = await getPrisma();
    const users = await prisma.user.findMany({
      where: { phone, role: "PATIENT" },
    });
    expect(users).toHaveLength(1); // exactly one patient account for the phone
  });

  it("rejects a double-booking of the same doctor+date+slot (409)", async () => {
    await request(app).post("/api/v1/public/booking/book").send({
      name: "First Patient",
      phone: "9123450097",
      doctorId,
      date: FUTURE_ISO,
      slotId: "10:00",
    });
    const res = await request(app).post("/api/v1/public/booking/book").send({
      name: "Second Patient",
      phone: "9123450096",
      doctorId,
      date: FUTURE_ISO,
      slotId: "10:00",
    });
    expect(res.status).toBe(409);
    expect(res.body.success).toBe(false);
  });

  it("rejects an invalid booking body (400)", async () => {
    const res = await request(app).post("/api/v1/public/booking/book").send({
      name: "Bad",
      phone: "123", // too short
      doctorId: "not-a-uuid",
      date: FUTURE_ISO,
      slotId: "09:00",
    });
    expect(res.status).toBe(400);
  });
});
