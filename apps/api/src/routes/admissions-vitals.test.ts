/**
 * Issue #198 — POST /admissions/:id/vitals silently 400'd because the
 * web form posted the short field names (`bpSystolic`, `pulse`) but the
 * shared zod schema (recordIpdVitalsSchema) declares the schema-canonical
 * names (`bloodPressureSystolic`, `pulseRate`) and the `admissionId` field
 * was required at the body even though the route already takes it from
 * the URL.
 *
 * The frontend now maps form keys → API keys and includes `admissionId`
 * explicitly. These tests pin the wire contract:
 *   • a body with the canonical names succeeds
 *   • a body without admissionId still 400s with a clear field-level
 *     error so the UI can render it next to the right input
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";

const { prismaMock } = vi.hoisted(() => {
  const base: any = {
    admission: {
      findUnique: vi.fn(),
      findFirst: vi.fn(async () => null),
    },
    ipdVitals: {
      create: vi.fn(),
      findMany: vi.fn(),
    },
    auditLog: { create: vi.fn(async () => ({ id: "al-1" })) },
    systemConfig: { findUnique: vi.fn(async () => null) },
    $extends(_c: unknown) {
      return base;
    },
  };
  return { prismaMock: base };
});

vi.mock("@medcore/db", () => ({ prisma: prismaMock }));
// Side-effect imports the route pulls in for PDF generation; stub them
// out so the test stays a pure unit test.
vi.mock("../services/pdf", () => ({
  generateDischargeSummaryHTML: vi.fn(),
}));
vi.mock("../services/pdf-generator", () => ({
  generateDischargeSummaryPDFBuffer: vi.fn(),
}));

import { admissionRouter } from "./admissions";
import { errorHandler } from "../middleware/error";

function buildApp() {
  process.env.JWT_SECRET = "test-secret";
  const app = express();
  app.use(express.json());
  app.use("/api/v1/admissions", admissionRouter);
  // Mount the real errorHandler so ZodError → 400 with `details`
  // (the wire contract that `extractFieldErrors` on the web side relies on).
  app.use(errorHandler);
  return app;
}

function nurseToken(): string {
  return jwt.sign(
    { userId: "u-nurse", email: "n@test.local", role: "NURSE" },
    "test-secret"
  );
}

describe("Issue #198 — POST /admissions/:id/vitals", () => {
  beforeEach(() => {
    prismaMock.admission.findUnique.mockReset();
    prismaMock.ipdVitals.create.mockReset();
  });

  it("accepts the canonical schema field names and returns 201", async () => {
    const admissionId = "550e8400-e29b-41d4-a716-446655441111";
    prismaMock.admission.findUnique.mockResolvedValueOnce({
      id: admissionId,
      status: "ADMITTED",
    });
    prismaMock.ipdVitals.create.mockResolvedValueOnce({
      id: "v-1",
      admissionId,
      bloodPressureSystolic: 120,
      bloodPressureDiastolic: 80,
      pulseRate: 72,
      recordedAt: new Date(),
    });

    const res = await request(buildApp())
      .post(`/api/v1/admissions/${admissionId}/vitals`)
      .set("Authorization", `Bearer ${nurseToken()}`)
      .send({
        // The Issue #198 fix: the frontend now sends the canonical names
        // and `admissionId` (the schema requires it even though the route
        // also takes it from the URL).
        admissionId,
        bloodPressureSystolic: 120,
        bloodPressureDiastolic: 80,
        pulseRate: 72,
      });

    expect(res.status).toBe(201);
    expect(prismaMock.ipdVitals.create).toHaveBeenCalledOnce();
    const callArg = prismaMock.ipdVitals.create.mock.calls[0][0];
    expect(callArg.data.bloodPressureSystolic).toBe(120);
    expect(callArg.data.pulseRate).toBe(72);
  });

  it("400s with field-level details when admissionId is missing — frontend can render per-field errors", async () => {
    const admissionId = "550e8400-e29b-41d4-a716-446655442222";
    // Pre-flight findUnique should never even run because zod fails first.
    const res = await request(buildApp())
      .post(`/api/v1/admissions/${admissionId}/vitals`)
      .set("Authorization", `Bearer ${nurseToken()}`)
      .send({
        // Intentionally omit `admissionId` to verify the validation
        // middleware surfaces a structured `details` array (the
        // `extractFieldErrors` helper on the web side relies on this).
        bloodPressureSystolic: 120,
      });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    // The shared validation middleware emits { details: [{ field, message }] }
    // — the web `extractFieldErrors` helper depends on this shape.
    expect(Array.isArray(res.body.details)).toBe(true);
    expect(prismaMock.ipdVitals.create).not.toHaveBeenCalled();
  });
});
