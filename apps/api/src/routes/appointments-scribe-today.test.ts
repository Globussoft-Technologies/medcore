/**
 * Issue #156 — AI Scribe "Today's Patients" 500 regression.
 *
 * Root cause: the picker fetches
 * `/appointments?date=YYYY-MM-DD&status=CHECKED_IN,BOOKED`. The list
 * handler stuffed the raw "CHECKED_IN,BOOKED" string straight into
 * `where.status`, which is an enum column — Prisma threw a runtime
 * validation error and the request returned 500.
 *
 * The fix splits a comma-separated value into a Prisma `{ in: [...] }`
 * filter. This test pins both the single-value case (back-compat) and
 * the comma-list case (the new behaviour).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";

const { prismaMock } = vi.hoisted(() => {
  const base: any = {
    appointment: {
      findMany: vi.fn(),
      count: vi.fn(),
    },
    patient: { findUnique: vi.fn() },
    // PR #882: GET /appointments now self-scopes DOCTOR via prisma.doctor.findFirst
    // to ignore any ?doctorId= override. Stub it so the route can resolve
    // the doctor record for the test user.
    doctor: { findFirst: vi.fn().mockResolvedValue({ id: "doc-self" }) },
    auditLog: { create: vi.fn(async () => ({ id: "al-1" })) },
  };
  return { prismaMock: base };
});

vi.mock("@medcore/db", () => ({
  getTenantId: () => undefined,
  runWithTenant: (_t: string, fn: () => unknown) => fn(),
  requireTenantId: () => { throw new Error("tenant ctx required"); }, prisma: prismaMock }));
vi.mock("../services/tenant-prisma", () => ({
  tenantScopedPrisma: prismaMock,
}));
vi.mock("../services/notification-triggers", () => ({
  onAppointmentCancelled: vi.fn(),
  onTokenCalled: vi.fn(),
  notifyNextInWaitlist: vi.fn(),
  notifyQueuePosition: vi.fn(),
}));

import { appointmentRouter } from "./appointments";

function tokenFor(role: string): string {
  process.env.JWT_SECRET = "test-secret";
  return jwt.sign(
    { userId: "u-test", email: "u@test.local", role },
    "test-secret"
  );
}

function buildApp() {
  process.env.JWT_SECRET = "test-secret";
  process.env.NODE_ENV = "test";
  const app = express();
  app.use(express.json());
  app.use("/api/v1/appointments", appointmentRouter);
  return app;
}

describe("GET /api/v1/appointments — Issue #156", () => {
  beforeEach(() => {
    prismaMock.appointment.findMany.mockReset();
    prismaMock.appointment.count.mockReset();
    prismaMock.appointment.findMany.mockResolvedValue([]);
    prismaMock.appointment.count.mockResolvedValue(0);
  });

  it("accepts a comma-separated `status` query (CHECKED_IN,BOOKED) without 500", async () => {
    const app = buildApp();
    const res = await request(app)
      .get("/api/v1/appointments?date=2026-04-26&status=CHECKED_IN,BOOKED")
      .set("Authorization", `Bearer ${tokenFor("DOCTOR")}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    // Verify Prisma was called with the `{ in: [...] }` filter.
    const where = prismaMock.appointment.findMany.mock.calls[0][0].where;
    expect(where.status).toEqual({ in: ["CHECKED_IN", "BOOKED"] });
    // And `date` is a range that covers the whole calendar day.
    expect(where.date.gte).toBeInstanceOf(Date);
    expect(where.date.lte).toBeInstanceOf(Date);
  });

  it("preserves single-status equality for back-compat", async () => {
    const app = buildApp();
    const res = await request(app)
      .get("/api/v1/appointments?status=BOOKED")
      .set("Authorization", `Bearer ${tokenFor("DOCTOR")}`);
    expect(res.status).toBe(200);
    const where = prismaMock.appointment.findMany.mock.calls[0][0].where;
    expect(where.status).toBe("BOOKED");
  });

  it("returns 400 on a malformed `date` instead of 500", async () => {
    const app = buildApp();
    const res = await request(app)
      .get("/api/v1/appointments?date=not-a-date")
      .set("Authorization", `Bearer ${tokenFor("DOCTOR")}`);
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });
});
