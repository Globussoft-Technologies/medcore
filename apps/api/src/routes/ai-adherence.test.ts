// Unit-style tests for the /api/v1/ai/adherence router.
//
// These tests pin the route layer's audit contract: every successful /enroll
// call must write an AI_ADHERENCE_INFERENCE audit row with metadata only —
// never prompt content (PHI). The integration suite at
// apps/api/src/test/integration/ai-adherence.test.ts already covers the
// schedule-creation behaviour end-to-end against a real DB.
//
// security audit follow-up (2026-05-04-med): F-ADH-3.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    auditLog: { create: vi.fn(async () => ({ id: "al-1" })) },
    prescription: { findUnique: vi.fn() },
    patient: { findUnique: vi.fn() },
    adherenceSchedule: {
      upsert: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
    },
    adherenceDoseLog: { create: vi.fn(), findMany: vi.fn() },
  } as any,
}));

vi.mock("@medcore/db", () => ({
  getTenantId: () => undefined,
  runWithTenant: (_t: string, fn: () => unknown) => fn(),
  requireTenantId: () => { throw new Error("tenant ctx required"); }, prisma: prismaMock }));
vi.mock("../services/tenant-prisma", () => ({ tenantScopedPrisma: prismaMock }));

import { aiAdherenceRouter } from "./ai-adherence";

function buildApp() {
  process.env.JWT_SECRET = "test-secret";
  process.env.NODE_ENV = "test";
  const app = express();
  app.use(express.json());
  app.use("/api/v1/ai/adherence", aiAdherenceRouter);
  return app;
}

function tokenFor(role: string): string {
  return jwt.sign(
    { userId: `u-${role}`, email: `${role}@t.local`, role },
    "test-secret"
  );
}

describe("POST /api/v1/ai/adherence/enroll — audit contract (F-ADH-3)", () => {
  beforeEach(() => {
    prismaMock.prescription.findUnique.mockReset();
    prismaMock.adherenceSchedule.upsert.mockReset();
    prismaMock.auditLog.create.mockClear();
  });

  it("writes an AI_ADHERENCE_INFERENCE audit row on the success path", async () => {
    prismaMock.prescription.findUnique.mockResolvedValueOnce({
      id: "rx-1",
      patientId: "pat-1",
      patient: { user: { id: "u-pat" } },
      items: [
        {
          medicineName: "Paracetamol",
          dosage: "500mg",
          frequency: "TID",
          duration: "5 days",
        },
      ],
    });
    prismaMock.adherenceSchedule.upsert.mockResolvedValueOnce({
      id: "sched-1",
      patientId: "pat-1",
      prescriptionId: "rx-1",
      active: true,
      medications: [],
    });

    const res = await request(buildApp())
      .post("/api/v1/ai/adherence/enroll")
      .set("Authorization", `Bearer ${tokenFor("DOCTOR")}`)
      .send({ prescriptionId: "rx-1" });

    expect(res.status).toBe(200);

    const inferenceCalls = prismaMock.auditLog.create.mock.calls.filter(
      (c: any[]) => c[0]?.data?.action === "AI_ADHERENCE_INFERENCE"
    );
    expect(inferenceCalls.length).toBe(1);
    const details = inferenceCalls[0][0].data.details;
    expect(details.success).toBe(true);
    expect(details.model).toBe("sarvam-105b");
    expect(typeof details.latencyMs).toBe("number");
    expect(details.prescriptionId).toBe("rx-1");
    expect(details.medicationCount).toBe(1);
    // PHI safety: never log prompt or full medication content.
    expect(details).not.toHaveProperty("prompt");
    expect(details).not.toHaveProperty("medications");
    expect(inferenceCalls[0][0].data.entityId).toBe("sched-1");
  });
});
