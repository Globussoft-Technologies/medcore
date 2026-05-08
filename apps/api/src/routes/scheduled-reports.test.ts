/**
 * Unit tests for the scheduled-reports create handler.
 *
 * Modules under test:
 *   - apps/api/src/routes/scheduled-reports.ts (POST /api/v1/scheduled-reports)
 *   - packages/shared/src/validation/reports.ts (scheduledReportCreateSchema)
 *
 * Why these tests exist:
 *   Issue #735 — the Reports page Schedule-tab Save button was reported as
 *   "shows brief loader then nothing". The web fix surfaces a clearer
 *   success toast, but the underlying contract on the backend (recipient
 *   email validation, time-of-day format, frequency-axis defaults) had
 *   no dedicated route-level test until now. These pin both the happy
 *   path and the two most common 400 shapes (bad email, bad time) so a
 *   future regression in the Zod schema doesn't quietly break the
 *   client-side toast wiring.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";

const { prismaMock } = vi.hoisted(() => {
  const base: any = {
    scheduledReport: {
      create: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    reportRun: {
      create: vi.fn(),
      findMany: vi.fn(async () => []),
      count: vi.fn(async () => 0),
    },
    payment: { findMany: vi.fn(), aggregate: vi.fn() },
    admission: { count: vi.fn() },
    bed: { count: vi.fn() },
    appointment: { count: vi.fn() },
    patient: { count: vi.fn() },
    notification: { create: vi.fn() },
    auditLog: { create: vi.fn(async () => ({ id: "al-1" })) },
    $extends(_c: unknown) {
      return base;
    },
  };
  return { prismaMock: base };
});

vi.mock("@medcore/db", () => ({
  prisma: prismaMock,
  tenantScopedPrisma: prismaMock,
}));
vi.mock("../services/notification", () => ({
  sendEmail: vi.fn(async () => undefined),
}));

import { scheduledReportsRouter } from "./scheduled-reports";
import { errorHandler } from "../middleware/error";

function buildApp() {
  process.env.JWT_SECRET = "test-secret";
  const app = express();
  app.use(express.json());
  app.use("/api/v1/scheduled-reports", scheduledReportsRouter);
  app.use(errorHandler);
  return app;
}

function adminToken(): string {
  return jwt.sign(
    { userId: "u-admin", email: "a@test.local", role: "ADMIN" },
    "test-secret"
  );
}

describe("POST /api/v1/scheduled-reports — issue #735 Save Schedule", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a weekly schedule with valid inputs (happy path)", async () => {
    prismaMock.scheduledReport.create.mockResolvedValueOnce({
      id: "sr-1",
      name: "Weekly Revenue Summary",
      reportType: "WEEKLY_REVENUE",
      frequency: "WEEKLY",
      dayOfWeek: 1,
      timeOfDay: "09:00",
      recipients: ["ops@example.com"],
      active: true,
    });

    const app = buildApp();
    const res = await request(app)
      .post("/api/v1/scheduled-reports")
      .set("Authorization", `Bearer ${adminToken()}`)
      .send({
        name: "Weekly Revenue Summary",
        reportType: "WEEKLY_REVENUE",
        frequency: "WEEKLY",
        dayOfWeek: 1,
        timeOfDay: "09:00",
        recipients: ["ops@example.com"],
        active: true,
      });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.id).toBe("sr-1");
    expect(prismaMock.scheduledReport.create).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed recipient email with 400", async () => {
    const app = buildApp();
    const res = await request(app)
      .post("/api/v1/scheduled-reports")
      .set("Authorization", `Bearer ${adminToken()}`)
      .send({
        name: "Bad Email",
        reportType: "WEEKLY_REVENUE",
        frequency: "WEEKLY",
        dayOfWeek: 1,
        timeOfDay: "09:00",
        recipients: ["not-an-email"],
      });
    expect(res.status).toBe(400);
    expect(prismaMock.scheduledReport.create).not.toHaveBeenCalled();
  });

  it("rejects malformed timeOfDay with 400", async () => {
    const app = buildApp();
    const res = await request(app)
      .post("/api/v1/scheduled-reports")
      .set("Authorization", `Bearer ${adminToken()}`)
      .send({
        name: "Bad Time",
        reportType: "WEEKLY_REVENUE",
        frequency: "WEEKLY",
        dayOfWeek: 1,
        timeOfDay: "9am", // not HH:MM
        recipients: ["ops@example.com"],
      });
    expect(res.status).toBe(400);
    expect(prismaMock.scheduledReport.create).not.toHaveBeenCalled();
  });

  it("rejects non-ADMIN with 403", async () => {
    const nurseToken = jwt.sign(
      { userId: "u-nurse", email: "n@test.local", role: "NURSE" },
      "test-secret"
    );
    const app = buildApp();
    const res = await request(app)
      .post("/api/v1/scheduled-reports")
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({
        name: "Forbidden",
        reportType: "WEEKLY_REVENUE",
        frequency: "WEEKLY",
        dayOfWeek: 1,
        timeOfDay: "09:00",
        recipients: ["ops@example.com"],
      });
    expect(res.status).toBe(403);
    expect(prismaMock.scheduledReport.create).not.toHaveBeenCalled();
  });
});
