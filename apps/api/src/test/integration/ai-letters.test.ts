// Integration tests for the AI Letters router (/api/v1/ai/letters).
// letter-generator service is mocked — no SARVAM_API_KEY required.
// Skipped unless DATABASE_URL_TEST is set.
import { it, expect, beforeAll, vi } from "vitest";
import request from "supertest";
import { describeIfDB, resetDB, getAuthToken, getPrisma } from "../setup";
import {
  createPatientFixture,
  createDoctorWithToken,
  createAppointmentFixture,
  createWardFixture,
  createBedFixture,
  createAdmissionFixture,
} from "../factories";

vi.mock("../../services/ai/letter-generator", () => ({
  generateReferralLetter: vi.fn().mockResolvedValue(
    "REFERRAL LETTER\n\nDate: 01 January 2026\nFrom: Dr. Test\nTo: Cardiology\n\nMock referral letter body."
  ),
  generateDischargeSummary: vi.fn().mockResolvedValue(
    "DISCHARGE SUMMARY\n\nMock discharge summary body."
  ),
}));

const MOCK_SOAP_FINAL = {
  subjective: { chiefComplaint: "Chest pain", hpi: "3-day history of intermittent chest pain" },
  objective: { vitals: "BP 130/85", examinationFindings: "Unremarkable" },
  assessment: { impression: "Stable angina suspected", icd10Codes: [] },
  plan: {
    medications: [{ name: "Aspirin 75mg" }, { name: "Atorvastatin 10mg" }],
    investigations: [],
    followUpTimeline: "1 week",
  },
};

let app: any;
let adminToken: string;
let patientToken: string;

describeIfDB("AI Letters API (integration)", () => {
  beforeAll(async () => {
    await resetDB();
    adminToken = await getAuthToken("ADMIN");
    patientToken = await getAuthToken("PATIENT");
    const mod = await import("../../app");
    app = mod.app;
  });

  // ─── POST /referral ───────────────────────────────────────────────────

  it("generates a referral letter for a scribe session with a finalised SOAP", async () => {
    const { generateReferralLetter } = await import("../../services/ai/letter-generator");
    vi.mocked(generateReferralLetter).mockClear();

    const patient = await createPatientFixture();
    const { doctor, token: doctorToken } = await createDoctorWithToken();
    const appt = await createAppointmentFixture({ patientId: patient.id, doctorId: doctor.id });

    const prisma = await getPrisma();
    const session = await prisma.aIScribeSession.create({
      data: {
        appointmentId: appt.id,
        doctorId: doctor.id,
        patientId: patient.id,
        consentObtained: true,
        status: "COMPLETED",
        soapFinal: MOCK_SOAP_FINAL as any,
      },
    });

    const res = await request(app)
      .post("/api/v1/ai/letters/referral")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({
        scribeSessionId: session.id,
        toSpecialty: "Cardiology",
        toDoctorName: "Sharma",
        urgency: "URGENT",
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.letter).toContain("REFERRAL LETTER");
    expect(res.body.data.generatedAt).toBeTruthy();
    expect(vi.mocked(generateReferralLetter)).toHaveBeenCalledOnce();
    // Arguments should include mapped medications from soapFinal.plan.medications
    const callArgs = vi.mocked(generateReferralLetter).mock.calls[0][0];
    expect(callArgs.toSpecialty).toBe("Cardiology");
    expect(callArgs.urgency).toBe("URGENT");
    expect(callArgs.currentMedications).toEqual(["Aspirin 75mg", "Atorvastatin 10mg"]);
  });

  it("requires authentication for POST /referral", async () => {
    const res = await request(app)
      .post("/api/v1/ai/letters/referral")
      .send({ scribeSessionId: "x", toSpecialty: "Cardiology" });

    expect(res.status).toBe(401);
  });

  it("rejects PATIENT role for POST /referral (403)", async () => {
    const res = await request(app)
      .post("/api/v1/ai/letters/referral")
      .set("Authorization", `Bearer ${patientToken}`)
      .send({ scribeSessionId: "x", toSpecialty: "Cardiology" });

    expect(res.status).toBe(403);
  });

  it("returns 400 when required fields are missing", async () => {
    const { token: doctorToken } = await createDoctorWithToken();

    const res = await request(app)
      .post("/api/v1/ai/letters/referral")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({ toSpecialty: "Cardiology" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/required/i);
  });

  it("returns 404 when scribe session is not found", async () => {
    const { token: doctorToken } = await createDoctorWithToken();

    const res = await request(app)
      .post("/api/v1/ai/letters/referral")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({
        scribeSessionId: "00000000-0000-0000-0000-000000000000",
        toSpecialty: "Cardiology",
      });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  it("returns 422 when SOAP is not yet finalised", async () => {
    const patient = await createPatientFixture();
    const { doctor, token: doctorToken } = await createDoctorWithToken();
    const appt = await createAppointmentFixture({ patientId: patient.id, doctorId: doctor.id });

    const prisma = await getPrisma();
    const session = await prisma.aIScribeSession.create({
      data: {
        appointmentId: appt.id,
        doctorId: doctor.id,
        patientId: patient.id,
        consentObtained: true,
        status: "ACTIVE",
        // soapFinal intentionally null
      },
    });

    const res = await request(app)
      .post("/api/v1/ai/letters/referral")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({ scribeSessionId: session.id, toSpecialty: "Cardiology" });

    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/SOAP/);
  });

  // ─── POST /discharge ──────────────────────────────────────────────────

  it("generates a discharge summary for an admission", async () => {
    const { generateDischargeSummary } = await import("../../services/ai/letter-generator");
    vi.mocked(generateDischargeSummary).mockClear();

    const patient = await createPatientFixture();
    const { doctor, token: doctorToken } = await createDoctorWithToken();
    const ward = await createWardFixture();
    const bed = await createBedFixture({ wardId: ward.id });
    const admission = await createAdmissionFixture({
      patientId: patient.id,
      doctorId: doctor.id,
      bedId: bed.id,
      overrides: {
        reason: "Acute appendicitis",
        finalDiagnosis: "Status post appendectomy",
        treatmentGiven: "IV antibiotics, Laparoscopic appendectomy",
        dischargeMedications: "Paracetamol 500mg TID, Cefixime 200mg BID",
        followUpInstructions: "Review in 7 days",
      },
    });

    const res = await request(app)
      .post("/api/v1/ai/letters/discharge")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({ admissionId: admission.id });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.summary).toContain("DISCHARGE SUMMARY");
    expect(vi.mocked(generateDischargeSummary)).toHaveBeenCalledOnce();
    const callArgs = vi.mocked(generateDischargeSummary).mock.calls[0][0];
    expect(callArgs.admittingDiagnosis).toBe("Acute appendicitis");
    expect(callArgs.dischargeDiagnosis).toBe("Status post appendectomy");
    expect(callArgs.proceduresPerformed.length).toBeGreaterThan(0);
    expect(callArgs.medicationsOnDischarge.length).toBeGreaterThan(0);
  });

  it("returns 400 when admissionId is missing from POST /discharge", async () => {
    const { token: doctorToken } = await createDoctorWithToken();

    const res = await request(app)
      .post("/api/v1/ai/letters/discharge")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/admissionId/);
  });

  it("returns 404 when admission is not found", async () => {
    const { token: doctorToken } = await createDoctorWithToken();

    const res = await request(app)
      .post("/api/v1/ai/letters/discharge")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({ admissionId: "00000000-0000-0000-0000-000000000000" });

    expect(res.status).toBe(404);
  });

  it("rejects PATIENT role for POST /discharge (403)", async () => {
    const res = await request(app)
      .post("/api/v1/ai/letters/discharge")
      .set("Authorization", `Bearer ${patientToken}`)
      .send({ admissionId: "00000000-0000-0000-0000-000000000000" });

    expect(res.status).toBe(403);
  });

  // ─── GET /referral/:scribeSessionId/preview ───────────────────────────

  it("previews a referral letter via GET with default urgency=ROUTINE", async () => {
    const { generateReferralLetter } = await import("../../services/ai/letter-generator");
    vi.mocked(generateReferralLetter).mockClear();

    const patient = await createPatientFixture();
    const { doctor, token: doctorToken } = await createDoctorWithToken();
    const appt = await createAppointmentFixture({ patientId: patient.id, doctorId: doctor.id });

    const prisma = await getPrisma();
    const session = await prisma.aIScribeSession.create({
      data: {
        appointmentId: appt.id,
        doctorId: doctor.id,
        patientId: patient.id,
        consentObtained: true,
        status: "COMPLETED",
        soapFinal: MOCK_SOAP_FINAL as any,
      },
    });

    const res = await request(app)
      .get(`/api/v1/ai/letters/referral/${session.id}/preview?toSpecialty=Neurology`)
      .set("Authorization", `Bearer ${doctorToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.letter).toContain("REFERRAL LETTER");
    const callArgs = vi.mocked(generateReferralLetter).mock.calls[0][0];
    expect(callArgs.toSpecialty).toBe("Neurology");
    expect(callArgs.urgency).toBe("ROUTINE");
  });

  it("returns 404 for GET preview on unknown scribe session", async () => {
    const { token: doctorToken } = await createDoctorWithToken();

    const res = await request(app)
      .get("/api/v1/ai/letters/referral/00000000-0000-0000-0000-000000000000/preview")
      .set("Authorization", `Bearer ${doctorToken}`);

    expect(res.status).toBe(404);
  });

  it("returns 422 on GET preview when SOAP not finalised", async () => {
    const patient = await createPatientFixture();
    const { doctor, token: doctorToken } = await createDoctorWithToken();
    const appt = await createAppointmentFixture({ patientId: patient.id, doctorId: doctor.id });

    const prisma = await getPrisma();
    const session = await prisma.aIScribeSession.create({
      data: {
        appointmentId: appt.id,
        doctorId: doctor.id,
        patientId: patient.id,
        consentObtained: true,
        status: "ACTIVE",
      },
    });

    const res = await request(app)
      .get(`/api/v1/ai/letters/referral/${session.id}/preview`)
      .set("Authorization", `Bearer ${doctorToken}`);

    expect(res.status).toBe(422);
  });

  it("allows ADMIN to generate a referral letter", async () => {
    const patient = await createPatientFixture();
    const { doctor } = await createDoctorWithToken();
    const appt = await createAppointmentFixture({ patientId: patient.id, doctorId: doctor.id });

    const prisma = await getPrisma();
    const session = await prisma.aIScribeSession.create({
      data: {
        appointmentId: appt.id,
        doctorId: doctor.id,
        patientId: patient.id,
        consentObtained: true,
        status: "COMPLETED",
        soapFinal: MOCK_SOAP_FINAL as any,
      },
    });

    const res = await request(app)
      .post("/api/v1/ai/letters/referral")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ scribeSessionId: session.id, toSpecialty: "Nephrology" });

    expect(res.status).toBe(200);
    expect(res.body.data.letter).toBeTruthy();
  });
});
