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

/**
 * Issue #48 (2026-05-09) — Today-Snapshot "Registered: 0" regression.
 *
 * The admin-console widget sends IST-anchored ISO bounds (e.g.
 * `2026-05-08T18:30:00.000Z` for IST midnight on the 9th). Before the
 * fix, parseRange() called `from.setHours(0,0,0,0)` after parsing the
 * client's ISO string — which on a UTC host stomped the IST midnight
 * back to UTC midnight, dropping every patient registered between
 * 18:30 IST and midnight IST out of the window.
 *
 * These tests pin the new behaviour: explicit ISO bounds are passed
 * through to Prisma verbatim. The newPatients alias on the response
 * surfaces the count via the Today-Snapshot tile path.
 */
describe("Issue #48 — GET /api/v1/analytics/overview honours IST-anchored bounds", () => {
  beforeEach(() => {
    prismaMock.patient.count.mockReset();
    prismaMock.patient.count.mockResolvedValue(0);
  });

  it("forwards client-supplied IST midnight ISO bounds to prisma without rounding", async () => {
    // What the admin-console actually sends on 2026-05-09 IST: midnight
    // local = 2026-05-08T18:30:00.000Z UTC.
    const fromIso = "2026-05-08T18:30:00.000Z";
    const toIso = "2026-05-09T18:29:59.999Z";

    // The second prisma.patient.count call is the "newPatientsInPeriod"
    // one with the user.createdAt range filter. The first is the
    // unconditional totalPatients count.
    let observedRange: { gte?: Date; lte?: Date } | null = null;
    prismaMock.patient.count.mockImplementationOnce(async () => 100); // totalPatients
    prismaMock.patient.count.mockImplementationOnce(async (args: any) => {
      observedRange = args?.where?.user?.createdAt ?? null;
      return 6;
    });

    const app = buildApp();
    const res = await request(app)
      .get(`/api/v1/analytics/overview?from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}`)
      .set("Authorization", `Bearer ${adminToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.data.newPatients).toBe(6);
    expect(res.body.data.newPatientsInPeriod).toBe(6);

    // The crux: the range Prisma saw must be the EXACT instants the
    // client supplied. Before the fix these were rounded to server-local
    // midnight, which on a UTC host produced 2026-05-08T00:00:00.000Z
    // — 18.5 hours earlier than the IST midnight the client meant.
    expect(observedRange).not.toBeNull();
    expect(observedRange!.gte!.toISOString()).toBe(fromIso);
    expect(observedRange!.lte!.toISOString()).toBe(toIso);
  });
});
