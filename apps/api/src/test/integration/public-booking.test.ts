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
  // The /chat endpoint calls runTriageTurn — mock it so the test doesn't need
  // a live Sarvam (CI has no SARVAM_API_KEY → real call would 502).
  runTriageTurn: vi.fn().mockResolvedValue({
    reply: "Could you tell me how long you've had these symptoms?",
    isEmergency: false,
  }),
}));

// Public booking now sends confirmations via the Meta Cloud sender
// (same module prescriptions use) — mock that so no real Meta API call
// fires during the test.
vi.mock("../../services/messaging/whatsapp", () => ({
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
        gender: "MALE",
        dateOfBirth: "1990-01-01",
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
      gender: "MALE",
      dateOfBirth: "1990-01-01",
      symptom: "cough",
    });
    // Second booking on a different slot.
    const res2 = await request(app).post("/api/v1/public/booking/book").send({
      name: "Repeat Booker",
      phone,
      doctorId,
      date: FUTURE_ISO,
      slotId: "09:30",
      gender: "MALE",
      dateOfBirth: "1990-01-01",
    });
    expect(res2.status).toBe(201);

    const prisma = await getPrisma();
    const users = await prisma.user.findMany({
      where: { phone, role: "PATIENT" },
    });
    expect(users).toHaveLength(1); // exactly one patient account for the phone
  });

  it("creates a SEPARATE patient when the same phone books under a DIFFERENT name", async () => {
    // Identity is keyed on (phone + name). A different name on the same phone
    // is a different person — e.g. a parent booking for themselves and then
    // for their child on the family number. Duplicate phones are allowed.
    const phone = "9123450095";
    await request(app).post("/api/v1/public/booking/book").send({
      name: "Parent Booker",
      phone,
      doctorId,
      date: FUTURE_ISO,
      slotId: "11:00",
      gender: "FEMALE",
      dateOfBirth: "1985-03-10",
    });
    const res2 = await request(app).post("/api/v1/public/booking/book").send({
      name: "Child Booker",
      phone,
      doctorId,
      date: FUTURE_ISO,
      slotId: "11:15",
      gender: "MALE",
      dateOfBirth: "2015-07-22",
    });
    expect(res2.status).toBe(201);

    const prisma = await getPrisma();
    const users = await prisma.user.findMany({
      where: { phone, role: "PATIENT" },
    });
    // Two distinct accounts share the phone — one per name.
    expect(users).toHaveLength(2);
    expect(users.map((u: { name: string }) => u.name).sort()).toEqual([
      "Child Booker",
      "Parent Booker",
    ]);
  });

  it("reuses the existing account on a case-insensitive name match (same phone)", async () => {
    const phone = "9123450094";
    await request(app).post("/api/v1/public/booking/book").send({
      name: "Asha Kumari",
      phone,
      doctorId,
      date: FUTURE_ISO,
      slotId: "12:00",
      gender: "FEMALE",
      dateOfBirth: "1991-01-01",
    });
    // Same name in a different case → still the SAME person → no duplicate.
    const res2 = await request(app).post("/api/v1/public/booking/book").send({
      name: "asha kumari",
      phone,
      doctorId,
      date: FUTURE_ISO,
      slotId: "12:15",
      gender: "FEMALE",
      dateOfBirth: "1991-01-01",
    });
    expect(res2.status).toBe(201);

    const prisma = await getPrisma();
    const users = await prisma.user.findMany({
      where: { phone, role: "PATIENT" },
    });
    expect(users).toHaveLength(1);
  });

  it("rejects a double-booking of the same doctor+date+slot (409)", async () => {
    await request(app).post("/api/v1/public/booking/book").send({
      name: "First Patient",
      phone: "9123450097",
      doctorId,
      date: FUTURE_ISO,
      slotId: "10:00",
      gender: "MALE",
      dateOfBirth: "1990-01-01",
    });
    const res = await request(app).post("/api/v1/public/booking/book").send({
      name: "Second Patient",
      phone: "9123450096",
      doctorId,
      date: FUTURE_ISO,
      slotId: "10:00",
      gender: "MALE",
      dateOfBirth: "1990-01-01",
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

  // POST /transcribe — voice symptom input (Sarvam STT-translate).
  it("transcribe rejects a missing audioBase64 (400)", async () => {
    const res = await request(app)
      .post("/api/v1/public/booking/transcribe")
      .send({});
    expect(res.status).toBe(400);
  });

  it("transcribe rejects oversized audio (413)", async () => {
    // > 1 MB of base64 → over the voice cap.
    const big = "A".repeat(1_500_000);
    const res = await request(app)
      .post("/api/v1/public/booking/transcribe")
      .send({ audioBase64: big });
    expect(res.status).toBe(413);
  });

  // POST /chat — multi-turn AI triage for the public booking flow.
  it("chat rejects an empty messages array (400)", async () => {
    const res = await request(app)
      .post("/api/v1/public/booking/chat")
      .send({ messages: [] });
    expect(res.status).toBe(400);
  });

  it("chat rejects a conversation with no user turn (400)", async () => {
    const res = await request(app)
      .post("/api/v1/public/booking/chat")
      .send({ messages: [{ role: "assistant", content: "Hi there" }] });
    expect(res.status).toBe(400);
  });

  it("chat returns an assistant reply for a valid user message (200)", async () => {
    const res = await request(app)
      .post("/api/v1/public/booking/chat")
      .send({
        messages: [{ role: "user", content: "I have fever and cough" }],
        name: "Asha",
      });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    // LLM output varies — assert shape, not content.
    expect(typeof res.body.data.reply).toBe("string");
    expect(typeof res.body.data.isEmergency).toBe("boolean");
  });
});
