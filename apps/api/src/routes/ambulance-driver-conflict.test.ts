/**
 * Issue #739 — Same driver assignable to multiple simultaneous active
 * dispatches. The Ambulance schema has `driverName` (string, no FK), so
 * two distinct ambulances may share a driverName. Without an explicit
 * guard, dispatching ambulance B for driver "Ravi Kumar" while
 * ambulance A is still mid-trip with the same driverName creates a
 * physically impossible double-booking.
 *
 * The fix queries for any active trip on a DIFFERENT ambulance whose
 * driverName matches the requested ambulance's driver and returns 400
 * with a clear conflict message that names the existing trip and
 * vehicle.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";

const { prismaMock } = vi.hoisted(() => {
  const base: any = {
    ambulance: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    ambulanceTrip: {
      findFirst: vi.fn(),
      findMany: vi.fn(async () => []),
      create: vi.fn(),
      update: vi.fn(),
    },
    auditLog: { create: vi.fn(async () => ({ id: "al-1" })) },
    systemConfig: { findUnique: vi.fn(async () => null) },
    $transaction: vi.fn(async (fn: (tx: any) => Promise<any>) => fn(base)),
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

import { ambulanceRouter } from "./ambulance";
import { errorHandler } from "../middleware/error";

function buildApp() {
  process.env.JWT_SECRET = "test-secret";
  const app = express();
  app.use(express.json());
  app.use("/api/v1/ambulance", ambulanceRouter);
  app.use(errorHandler);
  return app;
}

function nurseToken(): string {
  return jwt.sign(
    { userId: "u-nurse", email: "n@test.local", role: "NURSE" },
    "test-secret"
  );
}

const baseTripBody = {
  ambulanceId: "550e8400-e29b-41d4-a716-446655441111",
  pickupAddress: "12 MG Road, Bengaluru",
  callerName: "Asha",
  priority: "RED",
};

describe("Issue #739 — driver double-booking guard", () => {
  beforeEach(() => {
    prismaMock.ambulance.findUnique.mockReset();
    prismaMock.ambulance.update.mockReset();
    prismaMock.ambulanceTrip.findFirst.mockReset();
    prismaMock.ambulanceTrip.findMany.mockReset();
    prismaMock.ambulanceTrip.findMany.mockResolvedValue([]); // for tripNumber gen
    prismaMock.ambulanceTrip.create.mockReset();
    prismaMock.ambulanceTrip.update.mockReset();
  });

  it("returns 400 when the requested ambulance's driver is already on an active dispatch on a different vehicle", async () => {
    prismaMock.ambulance.findUnique.mockResolvedValueOnce({
      id: baseTripBody.ambulanceId,
      vehicleNumber: "AMB-101",
      status: "AVAILABLE",
      driverName: "Ravi Kumar",
    });
    prismaMock.ambulanceTrip.findFirst.mockResolvedValueOnce({
      id: "trip-existing",
      tripNumber: "TRP000042",
      ambulance: { vehicleNumber: "AMB-202" },
    });

    const res = await request(buildApp())
      .post("/api/v1/ambulance/trips")
      .set("Authorization", `Bearer ${nurseToken()}`)
      .send(baseTripBody);

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/Ravi Kumar/);
    expect(res.body.error).toMatch(/TRP000042/);
    expect(res.body.error).toMatch(/AMB-202/);
    // No write should have happened.
    expect(prismaMock.ambulanceTrip.create).not.toHaveBeenCalled();
    expect(prismaMock.ambulance.update).not.toHaveBeenCalled();
  });

  it("succeeds (201) when the driver has no active trip on any other ambulance", async () => {
    prismaMock.ambulance.findUnique.mockResolvedValueOnce({
      id: baseTripBody.ambulanceId,
      vehicleNumber: "AMB-101",
      status: "AVAILABLE",
      driverName: "Ravi Kumar",
    });
    // No conflict — driver is free.
    prismaMock.ambulanceTrip.findFirst.mockResolvedValueOnce(null);
    prismaMock.ambulanceTrip.create.mockResolvedValueOnce({
      id: "trip-new",
      tripNumber: "TRP000001",
      ambulance: { vehicleNumber: "AMB-101" },
      patient: null,
    });
    prismaMock.ambulance.update.mockResolvedValueOnce({});
    // recomputeAmbulanceStatus reads the ambulance again, then queries
    // active trips, then optionally updates status.
    prismaMock.ambulance.findUnique.mockResolvedValueOnce({
      id: baseTripBody.ambulanceId,
      status: "ON_TRIP",
    });
    prismaMock.ambulanceTrip.findFirst.mockResolvedValueOnce({ id: "trip-new" });

    const res = await request(buildApp())
      .post("/api/v1/ambulance/trips")
      .set("Authorization", `Bearer ${nurseToken()}`)
      .send(baseTripBody);

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.id).toBe("trip-new");
  });
});
