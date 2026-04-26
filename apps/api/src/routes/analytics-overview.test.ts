/**
 * Issue #78 — regression for the analytics overview's avg-consult math.
 *
 * Before this fix the average consult time was derived from
 * `Consultation.updatedAt - Consultation.createdAt`, which made the
 * dashboard return absurd values like 14,431 minutes (240 hrs) any time a
 * draft consult was reopened later. The fix switches the source to
 * `Appointment.consultationStartedAt` / `consultationEndedAt`, caps each
 * sample at 240 minutes, and returns `null` when there is no usable data.
 *
 * These tests pin the new behaviour with a mocked Prisma client.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";

const { prismaMock } = vi.hoisted(() => {
  const base: any = {
    patient: { count: vi.fn(async () => 0) },
    appointment: {
      count: vi.fn(async () => 0),
      groupBy: vi.fn(async () => []),
      findMany: vi.fn(async () => []),
    },
    payment: { findMany: vi.fn(async () => []) },
    invoice: { count: vi.fn(async () => 0) },
    admission: { count: vi.fn(async () => 0) },
    surgery: { count: vi.fn(async () => 0) },
    emergencyCase: { count: vi.fn(async () => 0) },
    consultation: { findMany: vi.fn(async () => []) },
    auditLog: { create: vi.fn(async () => ({ id: "al-1" })) },
  };
  return { prismaMock: base };
});

vi.mock("@medcore/db", () => ({ prisma: prismaMock }));

import { analyticsRouter } from "./analytics";

function buildApp() {
  process.env.JWT_SECRET = "test-secret";
  const app = express();
  app.use(express.json());
  app.use("/api/v1/analytics", analyticsRouter);
  return app;
}

function adminToken(): string {
  return jwt.sign(
    { userId: "u-test", email: "u@test.local", role: "ADMIN" },
    "test-secret"
  );
}

describe("Issue #78 — GET /api/v1/analytics/overview avg consult math", () => {
  beforeEach(() => {
    prismaMock.appointment.findMany.mockReset();
    prismaMock.appointment.findMany.mockResolvedValue([]);
  });

  it("returns null when there are no completed consults", async () => {
    prismaMock.appointment.findMany.mockResolvedValueOnce([]);
    const app = buildApp();
    const res = await request(app)
      .get("/api/v1/analytics/overview")
      .set("Authorization", `Bearer ${adminToken()}`);
    expect(res.status).toBe(200);
    expect(res.body.data.avgConsultationTime).toBeNull();
  });

  it("computes minutes from consultationStartedAt/EndedAt (not updatedAt)", async () => {
    // Two consults: 15 minutes and 25 minutes → average = 20 minutes
    const start1 = new Date("2026-04-01T09:00:00.000Z");
    const end1 = new Date("2026-04-01T09:15:00.000Z");
    const start2 = new Date("2026-04-01T10:00:00.000Z");
    const end2 = new Date("2026-04-01T10:25:00.000Z");
    prismaMock.appointment.findMany.mockResolvedValueOnce([
      { consultationStartedAt: start1, consultationEndedAt: end1 },
      { consultationStartedAt: start2, consultationEndedAt: end2 },
    ]);
    const app = buildApp();
    const res = await request(app)
      .get("/api/v1/analytics/overview")
      .set("Authorization", `Bearer ${adminToken()}`);
    expect(res.status).toBe(200);
    expect(res.body.data.avgConsultationTime).toBe(20);
  });

  it("caps a single runaway consult at 240 minutes so one stuck timer can't blow up the average", async () => {
    // One reasonable consult (10 min) + one runaway consult (24 hours) →
    // un-capped average would be ~725 min; capped average should be
    // (10 + 240) / 2 = 125 min.
    const start1 = new Date("2026-04-01T09:00:00.000Z");
    const end1 = new Date("2026-04-01T09:10:00.000Z");
    const start2 = new Date("2026-04-01T10:00:00.000Z");
    const end2 = new Date("2026-04-02T10:00:00.000Z");
    prismaMock.appointment.findMany.mockResolvedValueOnce([
      { consultationStartedAt: start1, consultationEndedAt: end1 },
      { consultationStartedAt: start2, consultationEndedAt: end2 },
    ]);
    const app = buildApp();
    const res = await request(app)
      .get("/api/v1/analytics/overview")
      .set("Authorization", `Bearer ${adminToken()}`);
    expect(res.status).toBe(200);
    // 10 + 240 = 250, /2 = 125
    expect(res.body.data.avgConsultationTime).toBe(125);
    // Sanity check: must not be the buggy 240+ hours figure.
    expect(res.body.data.avgConsultationTime).toBeLessThan(241);
  });

  it("ignores rows where end < start (defensive against bad data)", async () => {
    const start = new Date("2026-04-01T09:00:00.000Z");
    const earlierEnd = new Date("2026-04-01T08:55:00.000Z");
    const goodStart = new Date("2026-04-01T10:00:00.000Z");
    const goodEnd = new Date("2026-04-01T10:30:00.000Z");
    prismaMock.appointment.findMany.mockResolvedValueOnce([
      { consultationStartedAt: start, consultationEndedAt: earlierEnd },
      { consultationStartedAt: goodStart, consultationEndedAt: goodEnd },
    ]);
    const app = buildApp();
    const res = await request(app)
      .get("/api/v1/analytics/overview")
      .set("Authorization", `Bearer ${adminToken()}`);
    expect(res.status).toBe(200);
    expect(res.body.data.avgConsultationTime).toBe(30);
  });
});
