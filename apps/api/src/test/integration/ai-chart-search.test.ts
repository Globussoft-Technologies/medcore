// Integration tests for the AI chart search router.
// Sarvam generateText is mocked. Skipped unless DATABASE_URL_TEST is set.

import { it, expect, beforeAll, vi } from "vitest";
import request from "supertest";
import express from "express";
import jwt from "jsonwebtoken";
import { describeIfDB, resetDB, getPrisma } from "../setup";
import {
  createPatientFixture,
  createDoctorWithToken,
  createAppointmentFixture,
} from "../factories";

// Stub the LLM so we don't make network calls during integration.
vi.mock("../../services/ai/sarvam", () => ({
  generateText: vi.fn(async () => "The patient has a history of diabetes [1]."),
  runTriageTurn: vi.fn(),
  extractSymptomSummary: vi.fn(),
  generateSOAPNote: vi.fn(),
}));

let app: express.Express;

describeIfDB("AI Chart Search API (integration)", () => {
  beforeAll(async () => {
    await resetDB();
    // Build a minimal express app mounting only the chart-search router.
    // This is what app.ts would register under /api/v1/ai/chart-search.
    const { aiChartSearchRouter } = await import("../../routes/ai-chart-search");
    const { errorHandler } = await import("../../middleware/error");
    app = express();
    app.use(express.json());
    app.use("/api/v1/ai/chart-search", aiChartSearchRouter);
    app.use(errorHandler);
  });

  // Helper to seed a knowledge chunk tagged with a patient.
  async function seedChunk(args: {
    patientId: string;
    doctorId?: string;
    title: string;
    content: string;
    documentType?: string;
  }) {
    const prisma = await getPrisma();
    return prisma.knowledgeChunk.create({
      data: {
        documentType: args.documentType ?? "CONSULTATION",
        title: args.title,
        content: args.content,
        tags: [
          `patient:${args.patientId}`,
          args.doctorId ? `doctor:${args.doctorId}` : "",
          "date:2026-04-10",
        ].filter(Boolean),
      },
    });
  }

  it("POST /patient/:patientId returns ranked hits for the attending doctor", async () => {
    const patient = await createPatientFixture();
    const { doctor, token: doctorToken } = await createDoctorWithToken();
    // Establish the patient is in the doctor's panel via an appointment.
    await createAppointmentFixture({ patientId: patient.id, doctorId: doctor.id });

    await seedChunk({
      patientId: patient.id,
      doctorId: doctor.id,
      title: "Consultation 2026-04-10",
      content:
        "Patient reports polyuria and polydipsia. HbA1c 9.2 on recent labs. Started metformin 500mg BID.",
    });

    const res = await request(app)
      .post(`/api/v1/ai/chart-search/patient/${patient.id}`)
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({ query: "metformin", limit: 5 });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data.hits)).toBe(true);
    expect(res.body.data.hits.length).toBeGreaterThan(0);
    expect(res.body.data.hits[0].patientId).toBe(patient.id);
    expect(res.body.data.answer).toMatch(/diabetes|\[1\]/);
  });

  it("POST /patient/:patientId returns 403 when patient is outside the panel", async () => {
    const patient = await createPatientFixture();
    const { token: strangerToken } = await createDoctorWithToken();
    // No appointment between stranger doctor and this patient.

    const res = await request(app)
      .post(`/api/v1/ai/chart-search/patient/${patient.id}`)
      .set("Authorization", `Bearer ${strangerToken}`)
      .send({ query: "anything" });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/panel|forbid/i);
  });

  it("POST /cohort scopes results to the doctor's own patients only", async () => {
    const myPatient = await createPatientFixture();
    const otherPatient = await createPatientFixture();
    const { doctor: me, token: myToken } = await createDoctorWithToken();
    const { doctor: other } = await createDoctorWithToken();
    await createAppointmentFixture({ patientId: myPatient.id, doctorId: me.id });
    await createAppointmentFixture({ patientId: otherPatient.id, doctorId: other.id });

    await seedChunk({
      patientId: myPatient.id,
      doctorId: me.id,
      title: "My patient chunk",
      content: "Diabetic patient with recent CKD flag on creatinine rise.",
    });
    await seedChunk({
      patientId: otherPatient.id,
      doctorId: other.id,
      title: "Other patient chunk",
      content: "Diabetic patient with CKD — NOT in my panel.",
    });

    const res = await request(app)
      .post(`/api/v1/ai/chart-search/cohort`)
      .set("Authorization", `Bearer ${myToken}`)
      .send({ query: "diabetic CKD", limit: 10 });

    expect(res.status).toBe(200);
    expect(res.body.data.totalHits).toBeGreaterThan(0);
    // CRITICAL access-control assertion: no cross-doctor leakage.
    for (const hit of res.body.data.hits) {
      expect(hit.patientId).toBe(myPatient.id);
    }
    expect(res.body.data.patientIds).toEqual([myPatient.id]);
  });

  it("POST /patient rejects PATIENT role (requires DOCTOR or ADMIN)", async () => {
    const patient = await createPatientFixture();
    const patientToken = jwt.sign(
      { userId: patient.userId, email: "p@test.local", role: "PATIENT" },
      process.env.JWT_SECRET || "test-jwt-secret-do-not-use-in-prod",
      { expiresIn: "1h" }
    );

    const res = await request(app)
      .post(`/api/v1/ai/chart-search/patient/${patient.id}`)
      .set("Authorization", `Bearer ${patientToken}`)
      .send({ query: "anything" });

    expect(res.status).toBe(403);
  });

  it("POST /cohort returns 400 when query is missing", async () => {
    const { token: doctorToken } = await createDoctorWithToken();
    const res = await request(app)
      .post(`/api/v1/ai/chart-search/cohort`)
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Validation failed");
    expect(res.body.details?.[0]?.field).toBe("query");
  });
});
