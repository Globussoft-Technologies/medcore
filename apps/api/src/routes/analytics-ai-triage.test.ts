/**
 * Issue #83 — regression for the AI Analytics Triage 500.
 *
 * Two root causes were fixed:
 *   1. The router-level `authorize(ADMIN, RECEPTION)` guard short-circuited
 *      DOCTOR requests with a 403 before the per-route
 *      `authorize(ADMIN, RECEPTION, DOCTOR)` could even run. The web client
 *      surfaced that 403 as a generic "Internal server error" toast on
 *      the AI Analytics page.
 *   2. The handler iterated `s.messages` and `s.suggestedSpecialties`
 *      assuming both were always arrays. Older rows wrote stringified JSON
 *      and the current schema sometimes stores
 *      `Array<{ specialty: string }>` rather than `string[]` — both
 *      previously raised TypeErrors at runtime and produced a 500.
 *
 * These tests pin the new behaviour with a mocked Prisma client.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";

const { prismaMock } = vi.hoisted(() => {
  const base: any = {
    aITriageSession: { findMany: vi.fn() },
    aIScribeSession: { findMany: vi.fn(async () => []) },
    auditLog: { create: vi.fn(async () => ({ id: "al-1" })) },
  };
  return { prismaMock: base };
});

vi.mock("@medcore/db", () => ({
  getTenantId: () => undefined,
  tenantScopedPrisma: prismaMock,
  runWithTenant: (_t: string, fn: () => unknown) => fn(),
  requireTenantId: () => { throw new Error("tenant ctx required"); }, prisma: prismaMock }));

import { analyticsRouter } from "./analytics";

function buildApp() {
  process.env.JWT_SECRET = "test-secret";
  const app = express();
  app.use(express.json());
  app.use("/api/v1/analytics", analyticsRouter);
  return app;
}

function tokenFor(role: string): string {
  return jwt.sign(
    { userId: "u-test", email: "u@test.local", role },
    "test-secret"
  );
}

describe("GET /api/v1/analytics/ai/triage (Issue #83)", () => {
  beforeEach(() => {
    prismaMock.aITriageSession.findMany.mockReset();
    prismaMock.aIScribeSession.findMany.mockReset();
    prismaMock.aIScribeSession.findMany.mockResolvedValue([]);
  });

  it("permits a DOCTOR to fetch the triage analytics (no 403/500)", async () => {
    prismaMock.aITriageSession.findMany.mockResolvedValueOnce([]);
    const app = buildApp();
    const res = await request(app)
      .get("/api/v1/analytics/ai/triage")
      .set("Authorization", `Bearer ${tokenFor("DOCTOR")}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.totalSessions).toBe(0);
  });

  it("does not 500 when `messages` is a stringified JSON array", async () => {
    prismaMock.aITriageSession.findMany.mockResolvedValueOnce([
      {
        id: "s-1",
        status: "COMPLETED",
        redFlagDetected: false,
        appointmentId: "a-1",
        chiefComplaint: "fever",
        suggestedSpecialties: null,
        language: "en",
        confidence: 0.8,
        // String-encoded — the bug-trigger.
        messages: JSON.stringify([
          { role: "user", content: "I have a fever" },
          { role: "assistant", content: "How long?" },
          { role: "user", content: "2 days" },
        ]),
      },
    ]);
    const app = buildApp();
    const res = await request(app)
      .get("/api/v1/analytics/ai/triage")
      .set("Authorization", `Bearer ${tokenFor("ADMIN")}`);
    expect(res.status).toBe(200);
    expect(res.body.data.totalSessions).toBe(1);
    expect(res.body.data.avgTurnsToRecommendation).toBe(2);
  });

  it("flattens both `string[]` and `Array<{ specialty }>` shapes for suggestedSpecialties", async () => {
    prismaMock.aITriageSession.findMany.mockResolvedValueOnce([
      {
        id: "s-old",
        status: "COMPLETED",
        redFlagDetected: false,
        appointmentId: "a-1",
        chiefComplaint: "headache",
        // Older shape.
        suggestedSpecialties: ["General Physician", "Neurologist"],
        language: "en",
        confidence: 0.7,
        messages: [],
      },
      {
        id: "s-new",
        status: "COMPLETED",
        redFlagDetected: false,
        appointmentId: "a-2",
        chiefComplaint: "headache",
        // Newer shape.
        suggestedSpecialties: [{ specialty: "Neurologist", score: 0.9 }],
        language: "en",
        confidence: 0.8,
        messages: [],
      },
    ]);
    const app = buildApp();
    const res = await request(app)
      .get("/api/v1/analytics/ai/triage")
      .set("Authorization", `Bearer ${tokenFor("ADMIN")}`);
    expect(res.status).toBe(200);
    const dist = res.body.data.specialtyDistribution as Array<{
      specialty: string;
      count: number;
    }>;
    const neuro = dist.find((d) => d.specialty === "Neurologist");
    expect(neuro?.count).toBe(2);
    const gp = dist.find((d) => d.specialty === "General Physician");
    expect(gp?.count).toBe(1);
  });

  // Issue #157: any unexpected throw from inside the handler — including
  // a Prisma failure or a row shape we haven't seen yet — must NOT 500
  // the analytics tab. The handler now degrades to a 200 with
  // `data: null` and a `warning` so the UI can render an inline notice.
  it("Issue #157: degrades to 200 + warning when prisma throws", async () => {
    prismaMock.aITriageSession.findMany.mockRejectedValueOnce(
      new Error("connect ECONNREFUSED")
    );
    const app = buildApp();
    const res = await request(app)
      .get("/api/v1/analytics/ai/triage")
      .set("Authorization", `Bearer ${tokenFor("ADMIN")}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toBeNull();
    expect(res.body.warning).toMatch(/could not be parsed/i);
  });
});
