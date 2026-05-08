/**
 * Issue #747 — Same doctor schedulable for overlapping shifts on the
 * same day. The DB unique on `staff_shifts(userId, date, type)` only
 * blocks duplicate (userId, date, type) tuples; two different shift
 * types on the same date with overlapping HH:MM windows pass the
 * unique and double-book a single human.
 *
 * The fix runs the standard half-open overlap test
 * (newStart < existingEnd AND newEnd > existingStart) in minutes-
 * since-midnight against every shift the user already has on the same
 * date and rejects with 400 + a clear message naming the existing
 * window.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";

const { prismaMock } = vi.hoisted(() => {
  const base: any = {
    user: { findUnique: vi.fn() },
    staffShift: {
      findMany: vi.fn(),
      create: vi.fn(),
    },
    auditLog: { create: vi.fn(async () => ({ id: "al-1" })) },
    systemConfig: { findUnique: vi.fn(async () => null) },
    $extends(_c: unknown) {
      return base;
    },
  };
  return { prismaMock: base };
});

vi.mock("@medcore/db", () => ({
  prisma: prismaMock,
  tenantScopedPrisma: prismaMock,
  // The auditLog middleware reads getTenantId() to scope its inserts.
  // Stub returns null (untenanted) so the audit write doesn't blow up
  // the post-success path (the route has already responded by then).
  getTenantId: () => null,
}));

import { shiftRouter } from "./shifts";
import { errorHandler } from "../middleware/error";

function buildApp() {
  process.env.JWT_SECRET = "test-secret";
  const app = express();
  app.use(express.json());
  app.use("/api/v1/shifts", shiftRouter);
  app.use(errorHandler);
  return app;
}

function adminToken(): string {
  return jwt.sign(
    { userId: "u-admin", email: "a@test.local", role: "ADMIN" },
    "test-secret"
  );
}

const userId = "11111111-1111-1111-1111-111111111111";

describe("Issue #747 — overlapping shift guard", () => {
  beforeEach(() => {
    prismaMock.user.findUnique.mockReset();
    prismaMock.staffShift.findMany.mockReset();
    prismaMock.staffShift.create.mockReset();
  });

  it("rejects (400) when a new MORNING 08:00-14:00 shift overlaps an existing 06:00-12:00 ON_CALL shift on the same date", async () => {
    prismaMock.user.findUnique.mockResolvedValueOnce({
      id: userId,
      name: "Anita Verma",
    });
    prismaMock.staffShift.findMany.mockResolvedValueOnce([
      {
        id: "shift-existing",
        type: "ON_CALL",
        startTime: "06:00",
        endTime: "12:00",
      },
    ]);

    const res = await request(buildApp())
      .post("/api/v1/shifts")
      .set("Authorization", `Bearer ${adminToken()}`)
      .send({
        userId,
        date: "2026-05-08",
        type: "MORNING",
        startTime: "08:00",
        endTime: "14:00",
      });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/Anita Verma/);
    expect(res.body.error).toMatch(/06:00-12:00/);
    expect(res.body.existingShift).toMatchObject({
      id: "shift-existing",
      type: "ON_CALL",
      startTime: "06:00",
      endTime: "12:00",
    });
    expect(prismaMock.staffShift.create).not.toHaveBeenCalled();
  });

  it("succeeds (201) when an AFTERNOON 14:00-20:00 shift sits exactly back-to-back with a MORNING 08:00-14:00 shift (no overlap)", async () => {
    prismaMock.user.findUnique.mockResolvedValueOnce({
      id: userId,
      name: "Anita Verma",
    });
    prismaMock.staffShift.findMany.mockResolvedValueOnce([
      {
        id: "shift-existing",
        type: "MORNING",
        startTime: "08:00",
        endTime: "14:00",
      },
    ]);
    prismaMock.staffShift.create.mockResolvedValueOnce({
      id: "shift-new",
      userId,
      type: "AFTERNOON",
      startTime: "14:00",
      endTime: "20:00",
      user: { id: userId, name: "Anita Verma", role: "DOCTOR" },
    });

    const res = await request(buildApp())
      .post("/api/v1/shifts")
      .set("Authorization", `Bearer ${adminToken()}`)
      .send({
        userId,
        date: "2026-05-08",
        type: "AFTERNOON",
        startTime: "14:00",
        endTime: "20:00",
      });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.id).toBe("shift-new");
  });
});
