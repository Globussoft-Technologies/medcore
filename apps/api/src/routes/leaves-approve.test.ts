/**
 * Issue #288 (2026-04-30) — Pin the contract for PATCH /leaves/:id/approve.
 *
 * The Admin Console "Pending Approvals" card was hitting the wrong URL
 * (`PATCH /leaves/:id` — which doesn't exist) and the silent toast hid
 * the underlying 404 from operators. After moving the FE to the real
 * route we want regression coverage that:
 *
 *   • Happy path: PENDING leave + `{ status: "APPROVED" }` → 200, marks
 *     the row APPROVED, and stamps approver / approvedAt.
 *   • Edge: a leave already in APPROVED state returns 400 "Cannot
 *     modify leave in status APPROVED" — the FE relies on this exact
 *     message via `topLineError` for the toast surfacing.
 *
 * Tests use a hoisted Prisma mock (no live DB).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";

const { prismaMock } = vi.hoisted(() => {
  const base: any = {
    leaveRequest: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    leaveBalance: {
      upsert: vi.fn(async () => ({ id: "lb-1" })),
    },
    staffShift: {
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    auditLog: { create: vi.fn(async () => ({ id: "al-x" })) },
    systemConfig: { findUnique: vi.fn(async () => null) },
    $extends(_c: unknown) {
      return base;
    },
  };
  return { prismaMock: base };
});

vi.mock("@medcore/db", () => ({ prisma: prismaMock }));

import { leaveRouter } from "./leaves";
import { errorHandler } from "../middleware/error";

function buildApp() {
  process.env.JWT_SECRET = "test-secret";
  const app = express();
  app.use(express.json());
  app.use("/api/v1/leaves", leaveRouter);
  app.use(errorHandler);
  return app;
}

function adminToken(): string {
  return jwt.sign(
    { userId: "u-admin", email: "a@test.local", role: "ADMIN" },
    "test-secret"
  );
}

describe("Issue #288 — PATCH /leaves/:id/approve", () => {
  beforeEach(() => {
    prismaMock.leaveRequest.findUnique.mockReset();
    prismaMock.leaveRequest.update.mockReset();
  });

  it("approves a PENDING leave (happy path used by Admin Console card)", async () => {
    prismaMock.leaveRequest.findUnique.mockResolvedValueOnce({
      id: "lr-1",
      status: "PENDING",
      userId: "u-emp",
      type: "CASUAL",
      fromDate: new Date("2026-05-01"),
      toDate: new Date("2026-05-02"),
      totalDays: 2,
    });
    prismaMock.leaveRequest.update.mockResolvedValueOnce({
      id: "lr-1",
      status: "APPROVED",
      userId: "u-emp",
      type: "CASUAL",
      fromDate: new Date("2026-05-01"),
      toDate: new Date("2026-05-02"),
      totalDays: 2,
      approvedBy: "u-admin",
      approvedAt: new Date(),
      user: { id: "u-emp", name: "Anita Pawar", role: "NURSE", email: "" },
      approver: { id: "u-admin", name: "Admin" },
    });

    const res = await request(buildApp())
      .patch("/api/v1/leaves/lr-1/approve")
      .set("Authorization", `Bearer ${adminToken()}`)
      .send({ status: "APPROVED" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data?.status).toBe("APPROVED");
    expect(prismaMock.leaveRequest.update).toHaveBeenCalledOnce();
  });

  it("returns 400 with a specific message when the leave is already APPROVED (prior-failing edge case the toast now surfaces)", async () => {
    prismaMock.leaveRequest.findUnique.mockResolvedValueOnce({
      id: "lr-2",
      status: "APPROVED",
      userId: "u-emp",
      type: "CASUAL",
      fromDate: new Date("2026-05-01"),
      toDate: new Date("2026-05-02"),
      totalDays: 2,
    });

    const res = await request(buildApp())
      .patch("/api/v1/leaves/lr-2/approve")
      .set("Authorization", `Bearer ${adminToken()}`)
      .send({ status: "APPROVED" });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(String(res.body.error)).toMatch(/cannot modify leave in status APPROVED/i);
    expect(prismaMock.leaveRequest.update).not.toHaveBeenCalled();
  });
});
