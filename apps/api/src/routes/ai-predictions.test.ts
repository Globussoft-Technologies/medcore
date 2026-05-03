// Unit tests for the /api/v1/ai/predictions/* router.
//
// The logistic-regression model is exhaustively tested in
// services/ai/no-show-predictor.test.ts; this file pins the route layer:
// RBAC on both endpoints, the BOOKED-only filter on batch, the empty-day
// short-circuit, the appointment-not-found 404, the date YYYY-MM-DD guard,
// the validateUuidParams 400, and the response shape (descending risk
// sort + appointment enrichment).
//
// Honorable mention #12 from the 2026-05-03 test gaps audit.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";

const { predictNoShowMock, prismaMock } = vi.hoisted(() => ({
  predictNoShowMock: vi.fn(),
  prismaMock: {
    appointment: { findMany: vi.fn() },
    auditLog: { create: vi.fn(async () => ({ id: "al-1" })) },
  } as any,
}));

vi.mock("../services/ai/no-show-predictor", () => ({
  predictNoShow: predictNoShowMock,
}));
vi.mock("@medcore/db", () => ({ prisma: prismaMock }));
vi.mock("../services/tenant-prisma", () => ({ tenantScopedPrisma: prismaMock }));

import { aiPredictionsRouter } from "./ai-predictions";

function buildApp() {
  process.env.JWT_SECRET = "test-secret";
  process.env.NODE_ENV = "test";
  const app = express();
  app.use(express.json());
  app.use("/api/v1/ai/predictions", aiPredictionsRouter);
  // Minimal error middleware so Zod parse errors land as 400.
  app.use((err: any, _req: any, res: any, _next: any) => {
    if (err?.issues) {
      res.status(400).json({ success: false, data: null, error: err.issues });
      return;
    }
    res.status(500).json({ success: false, data: null, error: String(err?.message ?? err) });
  });
  return app;
}

function tokenFor(role: string): string {
  return jwt.sign({ userId: `u-${role}`, email: `${role}@t.local`, role }, "test-secret");
}

function makeAppointment(overrides: Partial<any> = {}) {
  return {
    id: overrides.id ?? "appt-1",
    patientId: overrides.patientId ?? "patient-1",
    doctorId: overrides.doctorId ?? "doctor-1",
    date: overrides.date ?? new Date("2026-06-01"),
    slotStart: overrides.slotStart ?? "09:00",
    slotEnd: overrides.slotEnd ?? "09:30",
    status: "BOOKED",
    patient: { user: { id: "u-pat", name: overrides.patientName ?? "P One" } },
    doctor: { user: { id: "u-doc", name: overrides.doctorName ?? "Dr Two" } },
    ...overrides,
  };
}

function makePrediction(appointmentId: string, riskScore: number) {
  return {
    appointmentId,
    riskScore,
    riskLevel: riskScore > 0.6 ? "high" : riskScore > 0.3 ? "medium" : "low",
    factors: ["lead time"],
    recommendation: "Call patient",
    source: "ml" as const,
  };
}

describe("GET /api/v1/ai/predictions/no-show/batch (honorable mention #12)", () => {
  beforeEach(() => {
    predictNoShowMock.mockReset();
    prismaMock.appointment.findMany.mockReset();
  });

  it("returns 401 with no auth header", async () => {
    const res = await request(buildApp()).get(
      "/api/v1/ai/predictions/no-show/batch?date=2026-06-01"
    );
    expect(res.status).toBe(401);
  });

  it("rejects DOCTOR with 403 (RBAC: ADMIN + RECEPTION only)", async () => {
    const res = await request(buildApp())
      .get("/api/v1/ai/predictions/no-show/batch?date=2026-06-01")
      .set("Authorization", `Bearer ${tokenFor("DOCTOR")}`);
    expect(res.status).toBe(403);
  });

  it("rejects PATIENT with 403", async () => {
    const res = await request(buildApp())
      .get("/api/v1/ai/predictions/no-show/batch?date=2026-06-01")
      .set("Authorization", `Bearer ${tokenFor("PATIENT")}`);
    expect(res.status).toBe(403);
  });

  it("rejects a missing or malformed `date` query (400 from Zod)", async () => {
    const res = await request(buildApp())
      .get("/api/v1/ai/predictions/no-show/batch")
      .set("Authorization", `Bearer ${tokenFor("ADMIN")}`);
    expect(res.status).toBe(400);
    expect(prismaMock.appointment.findMany).not.toHaveBeenCalled();

    const bad = await request(buildApp())
      .get("/api/v1/ai/predictions/no-show/batch?date=06-01-2026")
      .set("Authorization", `Bearer ${tokenFor("ADMIN")}`);
    expect(bad.status).toBe(400);
  });

  it("empty day: returns [] and does NOT call predictNoShow", async () => {
    prismaMock.appointment.findMany.mockResolvedValueOnce([]);
    const res = await request(buildApp())
      .get("/api/v1/ai/predictions/no-show/batch?date=2026-06-01")
      .set("Authorization", `Bearer ${tokenFor("RECEPTION")}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toEqual([]);
    expect(predictNoShowMock).not.toHaveBeenCalled();
  });

  it("RECEPTION: enriches predictions, sorts by riskScore desc, includes patient/doctor names", async () => {
    const a = makeAppointment({ id: "appt-low", patientName: "Alice" });
    const b = makeAppointment({ id: "appt-high", patientName: "Bob" });
    const c = makeAppointment({ id: "appt-mid", patientName: "Cara" });
    prismaMock.appointment.findMany.mockResolvedValueOnce([a, b, c]);
    predictNoShowMock
      .mockResolvedValueOnce(makePrediction("appt-low", 0.1))
      .mockResolvedValueOnce(makePrediction("appt-high", 0.9))
      .mockResolvedValueOnce(makePrediction("appt-mid", 0.5));

    const res = await request(buildApp())
      .get("/api/v1/ai/predictions/no-show/batch?date=2026-06-01")
      .set("Authorization", `Bearer ${tokenFor("RECEPTION")}`);

    expect(res.status).toBe(200);
    expect(res.body.data.map((d: any) => d.appointmentId)).toEqual([
      "appt-high",
      "appt-mid",
      "appt-low",
    ]);
    expect(res.body.data[0].appointment.patientName).toBe("Bob");
    expect(res.body.data[0].appointment.doctorName).toBe("Dr Two");
    // The findMany filter scopes to BOOKED appointments on the given date.
    const where = prismaMock.appointment.findMany.mock.calls[0][0].where;
    expect(where.status).toBe("BOOKED");
    expect(where.date).toBeInstanceOf(Date);
  });

  it("only narrows the User select to id + name (no PHI bleed via include)", async () => {
    prismaMock.appointment.findMany.mockResolvedValueOnce([]);
    await request(buildApp())
      .get("/api/v1/ai/predictions/no-show/batch?date=2026-06-01")
      .set("Authorization", `Bearer ${tokenFor("ADMIN")}`);

    const includeArg = prismaMock.appointment.findMany.mock.calls[0][0].include;
    expect(includeArg.patient.include.user.select).toEqual({ id: true, name: true });
    expect(includeArg.doctor.include.user.select).toEqual({ id: true, name: true });
  });
});

describe("GET /api/v1/ai/predictions/no-show/:appointmentId (honorable mention #12)", () => {
  beforeEach(() => {
    predictNoShowMock.mockReset();
  });

  it("rejects a non-UUID :appointmentId with 400", async () => {
    const res = await request(buildApp())
      .get("/api/v1/ai/predictions/no-show/not-a-uuid")
      .set("Authorization", `Bearer ${tokenFor("DOCTOR")}`);
    expect(res.status).toBe(400);
    expect(predictNoShowMock).not.toHaveBeenCalled();
  });

  it("rejects PATIENT with 403 (RBAC: DOCTOR + ADMIN + RECEPTION)", async () => {
    const res = await request(buildApp())
      .get("/api/v1/ai/predictions/no-show/00000000-0000-0000-0000-000000000001")
      .set("Authorization", `Bearer ${tokenFor("PATIENT")}`);
    expect(res.status).toBe(403);
  });

  it("DOCTOR: happy path returns the prediction shape", async () => {
    const id = "00000000-0000-0000-0000-0000000000aa";
    predictNoShowMock.mockResolvedValueOnce(makePrediction(id, 0.42));
    const res = await request(buildApp())
      .get(`/api/v1/ai/predictions/no-show/${id}`)
      .set("Authorization", `Bearer ${tokenFor("DOCTOR")}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.appointmentId).toBe(id);
    expect(res.body.data.riskScore).toBe(0.42);
    expect(res.body.data.riskLevel).toBe("medium");
  });

  it("returns 404 (not 500) when predictNoShow throws an Appointment-not-found error", async () => {
    const id = "00000000-0000-0000-0000-0000000000bb";
    predictNoShowMock.mockRejectedValueOnce(new Error(`Appointment ${id} not found`));
    const res = await request(buildApp())
      .get(`/api/v1/ai/predictions/no-show/${id}`)
      .set("Authorization", `Bearer ${tokenFor("ADMIN")}`);
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/not found/i);
  });

  it("propagates other thrown errors via next() (500-class)", async () => {
    const id = "00000000-0000-0000-0000-0000000000cc";
    predictNoShowMock.mockRejectedValueOnce(new Error("model file corrupt"));
    const res = await request(buildApp())
      .get(`/api/v1/ai/predictions/no-show/${id}`)
      .set("Authorization", `Bearer ${tokenFor("RECEPTION")}`);
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/model file corrupt/i);
  });
});
