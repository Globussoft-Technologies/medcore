/**
 * Issue #737 — Blood-bank expiry guard regression tests.
 *
 * Two prongs are tested here:
 *   1. POST /api/v1/bloodbank/requests/:id/issue rejects a unit whose
 *      `expiresAt` is in the past EVEN IF the unit's status column is
 *      still `AVAILABLE` (the daily auto-flag cron hasn't yet run, or
 *      the row slipped through a stale UI selection cache). Defence in
 *      depth on top of the read-side filter.
 *   2. POST /api/v1/bloodbank/requests/:id/match — assert the route's
 *      Prisma `where` clause carries `expiresAt: { gt: <Date> }` so
 *      the cross-match selection list NEVER includes an expired row.
 *      (This guard already exists in production code — the test pins
 *      it as a regression contract.)
 *
 * Mocks @medcore/db following the same pattern as
 * `apps/api/src/routes/bloodbank-cross-match.test.ts` so the SUT
 * imports cleanly.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";

const { prismaMock } = vi.hoisted(() => {
  const bloodRequest = {
    findUnique: vi.fn(),
    update: vi.fn(),
  };
  const bloodUnit = {
    findUnique: vi.fn(),
    findMany: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  };
  const auditLog = { create: vi.fn(async () => ({ id: "al-x" })) };
  const systemConfig = { findUnique: vi.fn(async () => null) };

  const base: any = {
    bloodRequest,
    bloodUnit,
    auditLog,
    systemConfig,
    $transaction: vi.fn(async (fn: (tx: any) => Promise<any>) =>
      fn({ bloodRequest, bloodUnit })
    ),
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

import { bloodbankRouter } from "./bloodbank";
import { errorHandler } from "../middleware/error";

function buildApp() {
  process.env.JWT_SECRET = "test-secret";
  const app = express();
  app.use(express.json());
  app.use("/api/v1/bloodbank", bloodbankRouter);
  app.use(errorHandler);
  return app;
}

function doctorToken(): string {
  return jwt.sign(
    { userId: "u-doc", email: "doc@test.local", role: "DOCTOR" },
    "test-secret"
  );
}

const REQUEST_ID = "11111111-1111-1111-1111-111111111111";
const UNIT_ID = "22222222-2222-2222-2222-222222222222";

beforeEach(() => {
  prismaMock.bloodRequest.findUnique.mockReset();
  prismaMock.bloodRequest.update.mockReset();
  prismaMock.bloodUnit.findUnique.mockReset();
  prismaMock.bloodUnit.findMany.mockReset();
  prismaMock.bloodUnit.update.mockReset();
  prismaMock.bloodUnit.updateMany.mockReset();
  prismaMock.$transaction.mockImplementation(async (fn: any) =>
    fn({
      bloodRequest: prismaMock.bloodRequest,
      bloodUnit: prismaMock.bloodUnit,
    })
  );
});

describe("Issue #737 — write-side expiry guard on POST /requests/:id/issue", () => {
  it("rejects a unit whose expiresAt is in the past even if status=AVAILABLE", async () => {
    // Recipient O+; donor unit is O+ and AVAILABLE — but expiresAt is
    // 1 day in the past. Without the guard the issue would proceed
    // (ABO/Rh ok, status=AVAILABLE), and an expired unit would be
    // marked ISSUED in the DB.
    prismaMock.bloodRequest.findUnique.mockResolvedValueOnce({
      id: REQUEST_ID,
      patientId: "p-1",
      bloodGroup: "O_POS",
      component: "PACKED_RED_CELLS",
      unitsRequested: 1,
      reason: "Anaemia",
      urgency: "ROUTINE",
      requestedBy: "u-doc",
      issuedAt: null,
      issuedBy: null,
      fulfilled: false,
      notes: null,
      createdAt: new Date(),
    });
    const past = new Date(Date.now() - 24 * 60 * 60 * 1000);
    prismaMock.bloodUnit.findMany.mockResolvedValueOnce([
      {
        id: UNIT_ID,
        unitNumber: "BU000042",
        bloodGroup: "O_POS",
        component: "PACKED_RED_CELLS",
        status: "AVAILABLE", // critically: not yet flagged EXPIRED
        expiresAt: past,
        volumeMl: 350,
        collectedAt: new Date(),
      },
    ]);

    const res = await request(buildApp())
      .post(`/api/v1/bloodbank/requests/${REQUEST_ID}/issue`)
      .set("Authorization", `Bearer ${doctorToken()}`)
      .send({ unitIds: [UNIT_ID] });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(String(res.body.error)).toMatch(/expired/i);
    expect(String(res.body.error)).toMatch(/cannot be issued/i);
    expect(String(res.body.error)).toContain("BU000042");

    // Critical contract: NO updateMany / no row mutation must occur
    // when the expiry guard fires.
    expect(prismaMock.bloodUnit.updateMany).not.toHaveBeenCalled();
    expect(prismaMock.bloodRequest.update).not.toHaveBeenCalled();
  });

  it("happily issues a unit whose expiresAt is in the future", async () => {
    // Same shape as above but expiresAt is 30 days out. Confirms the
    // new guard is targeted, not a blanket reject.
    prismaMock.bloodRequest.findUnique.mockResolvedValueOnce({
      id: REQUEST_ID,
      patientId: "p-1",
      bloodGroup: "O_POS",
      component: "PACKED_RED_CELLS",
      unitsRequested: 1,
      reason: "Anaemia",
      urgency: "ROUTINE",
      requestedBy: "u-doc",
      issuedAt: null,
      issuedBy: null,
      fulfilled: false,
      notes: null,
      createdAt: new Date(),
    });
    const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    prismaMock.bloodUnit.findMany.mockResolvedValueOnce([
      {
        id: UNIT_ID,
        unitNumber: "BU000043",
        bloodGroup: "O_POS",
        component: "PACKED_RED_CELLS",
        status: "AVAILABLE",
        expiresAt: future,
        volumeMl: 350,
        collectedAt: new Date(),
      },
    ]);
    prismaMock.bloodUnit.updateMany.mockResolvedValueOnce({ count: 1 });
    prismaMock.bloodRequest.update.mockResolvedValueOnce({
      id: REQUEST_ID,
      fulfilled: true,
      issuedAt: new Date(),
      units: [],
    });

    const res = await request(buildApp())
      .post(`/api/v1/bloodbank/requests/${REQUEST_ID}/issue`)
      .set("Authorization", `Bearer ${doctorToken()}`)
      .send({ unitIds: [UNIT_ID] });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(prismaMock.bloodUnit.updateMany).toHaveBeenCalledTimes(1);
  });
});

describe("Issue #737 — read-side expired filter on POST /requests/:id/match", () => {
  it("Prisma where-clause includes expiresAt > now so the picker never sees expired rows", async () => {
    prismaMock.bloodRequest.findUnique.mockResolvedValueOnce({
      id: REQUEST_ID,
      patientId: "p-1",
      bloodGroup: "A_POS",
      component: "PACKED_RED_CELLS",
      unitsRequested: 1,
    });
    prismaMock.bloodUnit.findMany.mockResolvedValueOnce([]);

    const res = await request(buildApp())
      .post(`/api/v1/bloodbank/requests/${REQUEST_ID}/match`)
      .set("Authorization", `Bearer ${doctorToken()}`)
      .send({});

    expect(res.status).toBe(200);
    const where = prismaMock.bloodUnit.findMany.mock.calls[0][0].where;
    expect(where.status).toBe("AVAILABLE");
    expect(where.expiresAt).toEqual({ gt: expect.any(Date) });
    // The `gt` Date should be very close to "now" — within 5 seconds
    // of the test wall-clock.
    const gtDate: Date = where.expiresAt.gt;
    expect(Math.abs(gtDate.getTime() - Date.now())).toBeLessThan(5000);
  });
});
