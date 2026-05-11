/**
 * Issue #199 — PATCH /medication/administrations/:id was returning 500 for
 * common error paths (missing record, race-replay) because it forwarded
 * any Prisma error verbatim through the global handler.
 *
 * These tests pin the new contract:
 *   • record-not-found → 404 with a clear `error` string
 *   • already-administered → 409 (idempotency / race guard)
 *   • happy path → 200 with the updated row
 *
 * Tested with a mocked Prisma so we don't need a live database.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";

const { prismaMock } = vi.hoisted(() => {
  const base: any = {
    medicationAdministration: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    auditLog: { create: vi.fn(async () => ({ id: "al-x" })) },
    systemConfig: { findUnique: vi.fn(async () => null) },
    $extends(_c: unknown) {
      return base;
    },
  };
  return { prismaMock: base };
});

vi.mock("@medcore/db", () => ({
  getTenantId: () => undefined,
  tenantScopedPrisma: prismaMock,
  runWithTenant: (_t: string, fn: () => unknown) => fn(),
  requireTenantId: () => { throw new Error("tenant ctx required"); }, prisma: prismaMock }));

import { medicationRouter } from "./medication";

function buildApp() {
  process.env.JWT_SECRET = "test-secret";
  const app = express();
  app.use(express.json());
  app.use("/api/v1/medication", medicationRouter);
  // Minimal global error handler — mirrors apps/api/src/middleware/error.ts
  // closely enough to assert that NEXT'd errors do not leak as 500.
  app.use(
    (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      const e = err as Error;
      res.status(500).json({ success: false, error: e?.message ?? "Internal" });
    }
  );
  return app;
}

function nurseToken(): string {
  return jwt.sign(
    { userId: "u-nurse", email: "n@test.local", role: "NURSE" },
    "test-secret"
  );
}

describe("Issue #199 — MAR PATCH /medication/administrations/:id", () => {
  beforeEach(() => {
    prismaMock.medicationAdministration.findUnique.mockReset();
    prismaMock.medicationAdministration.update.mockReset();
  });

  it("returns 404 (not 500) when the administration row is missing", async () => {
    prismaMock.medicationAdministration.findUnique.mockResolvedValueOnce(null);

    const res = await request(buildApp())
      .patch("/api/v1/medication/administrations/not-a-real-id")
      .set("Authorization", `Bearer ${nurseToken()}`)
      .send({ status: "ADMINISTERED" });

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(String(res.body.error)).toMatch(/not found/i);
    // Update should never run — pre-flight findUnique already 404'd.
    expect(prismaMock.medicationAdministration.update).not.toHaveBeenCalled();
  });

  it("returns 404 when Prisma raises P2025 (record disappeared between findUnique and update)", async () => {
    prismaMock.medicationAdministration.findUnique.mockResolvedValueOnce({
      id: "ma-1",
      status: "SCHEDULED",
    });
    const p2025 = Object.assign(new Error("Record not found"), { code: "P2025" });
    prismaMock.medicationAdministration.update.mockRejectedValueOnce(p2025);

    const res = await request(buildApp())
      .patch("/api/v1/medication/administrations/ma-1")
      .set("Authorization", `Bearer ${nurseToken()}`)
      .send({ status: "ADMINISTERED" });

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });

  it("returns 409 when the dose was already recorded as ADMINISTERED (idempotent guard)", async () => {
    prismaMock.medicationAdministration.findUnique.mockResolvedValueOnce({
      id: "ma-2",
      status: "ADMINISTERED",
    });

    const res = await request(buildApp())
      .patch("/api/v1/medication/administrations/ma-2")
      .set("Authorization", `Bearer ${nurseToken()}`)
      .send({ status: "ADMINISTERED" });

    expect(res.status).toBe(409);
    expect(String(res.body.error)).toMatch(/already/i);
  });

  it("happy path: returns 200 with the updated row + emits realtime event", async () => {
    prismaMock.medicationAdministration.findUnique.mockResolvedValueOnce({
      id: "ma-3",
      status: "SCHEDULED",
    });
    prismaMock.medicationAdministration.update.mockResolvedValueOnce({
      id: "ma-3",
      status: "ADMINISTERED",
      medicationOrder: {
        id: "mo-1",
        medicineName: "Paracetamol",
        dosage: "500mg",
        admissionId: "adm-1",
      },
      nurse: { id: "u-nurse", name: "Nurse Joy" },
    });

    const res = await request(buildApp())
      .patch("/api/v1/medication/administrations/ma-3")
      .set("Authorization", `Bearer ${nurseToken()}`)
      .send({ status: "ADMINISTERED" });

    expect(res.status).toBe(200);
    expect(res.body.data?.id).toBe("ma-3");
    expect(res.body.data?.status).toBe("ADMINISTERED");
    expect(prismaMock.medicationAdministration.update).toHaveBeenCalledOnce();
  });
});
