/**
 * Issue #81 — regression for the ER Triage Assistant 500.
 *
 * Two distinct symptoms had to be fixed:
 *   1. The route's authorize() chain now allows DOCTOR, NURSE, and ADMIN
 *      (a NURSE was previously blocked even though the menu exposed the
 *      page to them by URL).
 *   2. When the upstream Sarvam call throws (missing API key, network
 *      error), the route now returns a friendly 503 with a human error
 *      string instead of a generic 500 + leaked "Unauthorized" body.
 *
 * These tests pin the new behaviour with a mocked Prisma client and a
 * mocked assessERPatient service.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";

const { prismaMock, assessMock } = vi.hoisted(() => ({
  prismaMock: {
    auditLog: { create: vi.fn(async () => ({ id: "al-1" })) },
    emergencyCase: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  } as any,
  assessMock: vi.fn(),
}));

vi.mock("@medcore/db", () => ({ prisma: prismaMock }));
vi.mock("../services/tenant-prisma", () => ({ tenantScopedPrisma: prismaMock }));
vi.mock("../services/ai/er-triage", () => ({ assessERPatient: assessMock }));

import { aiERTriageRouter } from "./ai-er-triage";

function buildApp() {
  process.env.JWT_SECRET = "test-secret";
  process.env.NODE_ENV = "test"; // disables rate limiter
  const app = express();
  app.use(express.json());
  app.use("/api/v1/ai/er-triage", aiERTriageRouter);
  return app;
}

function tokenFor(role: string): string {
  return jwt.sign(
    { userId: "u-test", email: "u@test.local", role },
    "test-secret"
  );
}

const happyAssessment = {
  suggestedTriageLevel: 2,
  triageLevelLabel: "Emergent",
  disposition: "Treatment room",
  immediateActions: ["ECG within 10 minutes"],
  suggestedInvestigations: ["ECG"],
  redFlags: [],
  calculatedMEWS: 3,
  aiReasoning: "Acute presentation",
  disclaimer: "AI-assisted triage suggestion only.",
};

describe("POST /api/v1/ai/er-triage/assess (Issue #81)", () => {
  beforeEach(() => {
    assessMock.mockReset();
    prismaMock.auditLog.create.mockClear();
  });

  it("permits a NURSE to run an assessment (Issue #81 — authorize chain fix)", async () => {
    assessMock.mockResolvedValueOnce(happyAssessment);
    const app = buildApp();
    const res = await request(app)
      .post("/api/v1/ai/er-triage/assess")
      .set("Authorization", `Bearer ${tokenFor("NURSE")}`)
      .send({ chiefComplaint: "Chest pain", vitals: {} });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.triageLevelLabel).toBe("Emergent");
  });

  it("permits a DOCTOR to run an assessment", async () => {
    assessMock.mockResolvedValueOnce(happyAssessment);
    const app = buildApp();
    const res = await request(app)
      .post("/api/v1/ai/er-triage/assess")
      .set("Authorization", `Bearer ${tokenFor("DOCTOR")}`)
      .send({ chiefComplaint: "Dyspnea", vitals: {} });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it("permits an ADMIN to run an assessment", async () => {
    assessMock.mockResolvedValueOnce(happyAssessment);
    const app = buildApp();
    const res = await request(app)
      .post("/api/v1/ai/er-triage/assess")
      .set("Authorization", `Bearer ${tokenFor("ADMIN")}`)
      .send({ chiefComplaint: "Headache", vitals: {} });
    expect(res.status).toBe(200);
  });

  it("rejects PATIENT role with 403 (not 500)", async () => {
    const app = buildApp();
    const res = await request(app)
      .post("/api/v1/ai/er-triage/assess")
      .set("Authorization", `Bearer ${tokenFor("PATIENT")}`)
      .send({ chiefComplaint: "Cough", vitals: {} });
    expect(res.status).toBe(403);
  });

  it("returns 401 with friendly error when no Authorization header is supplied", async () => {
    const app = buildApp();
    const res = await request(app)
      .post("/api/v1/ai/er-triage/assess")
      .send({ chiefComplaint: "Cough", vitals: {} });
    expect(res.status).toBe(401);
    expect(res.body.error).toBeDefined();
  });

  it("returns 503 (not 500 with 'Unauthorized') when the AI service throws", async () => {
    assessMock.mockRejectedValueOnce(new Error("Sarvam API key not configured"));
    const app = buildApp();
    const res = await request(app)
      .post("/api/v1/ai/er-triage/assess")
      .set("Authorization", `Bearer ${tokenFor("DOCTOR")}`)
      .send({ chiefComplaint: "Chest pain", vitals: {} });
    expect(res.status).toBe(503);
    expect(res.body.success).toBe(false);
    // The response must NOT bleed the auth middleware's "Unauthorized"
    // wording into the toast — that was Issue #81's other half.
    expect(res.body.error).not.toMatch(/unauthorized/i);
    expect(res.body.error).toMatch(/temporarily unavailable/i);
  });

  it("rejects empty chiefComplaint with 400 before calling assessERPatient", async () => {
    const app = buildApp();
    const res = await request(app)
      .post("/api/v1/ai/er-triage/assess")
      .set("Authorization", `Bearer ${tokenFor("DOCTOR")}`)
      .send({ chiefComplaint: "   ", vitals: {} });
    expect(res.status).toBe(400);
    expect(assessMock).not.toHaveBeenCalled();
  });
});
