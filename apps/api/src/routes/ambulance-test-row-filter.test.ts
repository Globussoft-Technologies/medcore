/**
 * Issue #738 — Test/dummy ambulance rows hidden in production.
 *
 * `apps/api/src/routes/ambulance.ts` GET / runs in two modes:
 *   • dev/test: returns the full row set (so seed data renders for
 *     local dev + CI).
 *   • production: filters out rows whose `vehicleNumber` starts with
 *     TEST- / DEMO / AMB-DEMO- and rows whose `driverName` is exactly
 *     "Demo Driver".
 *
 * The runtime filter is defence in depth on top of the
 * 20260508000003 cleanup migration that removes the rows at rest.
 *
 * We test the route HANDLER level by checking the Prisma `where`
 * clause that the route assembles, gated on `process.env.NODE_ENV`.
 * No real Postgres is required.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";

const { prismaMock } = vi.hoisted(() => {
  const base: any = {
    ambulance: {
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    ambulanceTrip: {
      findFirst: vi.fn(),
      findMany: vi.fn(async () => []),
      create: vi.fn(),
      update: vi.fn(),
    },
    ambulanceFuelLog: {
      findMany: vi.fn(async () => []),
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

vi.mock("@medcore/db", () => ({ prisma: prismaMock }));

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

function adminToken(): string {
  return jwt.sign(
    { userId: "u-admin", email: "a@test.local", role: "ADMIN" },
    "test-secret"
  );
}

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

beforeEach(() => {
  prismaMock.ambulance.findMany.mockReset();
  prismaMock.ambulance.findMany.mockResolvedValue([]);
});

afterEach(() => {
  process.env.NODE_ENV = ORIGINAL_NODE_ENV;
});

describe("Issue #738 — GET /api/v1/ambulance test-row filter", () => {
  it("in NODE_ENV=production, where-clause excludes TEST-/DEMO/AMB-DEMO/Demo Driver rows", async () => {
    process.env.NODE_ENV = "production";
    prismaMock.ambulance.findMany.mockResolvedValueOnce([]);

    const res = await request(buildApp())
      .get("/api/v1/ambulance")
      .set("Authorization", `Bearer ${adminToken()}`);

    expect(res.status).toBe(200);
    const where = prismaMock.ambulance.findMany.mock.calls[0][0].where;
    // The route adds an `AND` array of `NOT` clauses gated on prod.
    expect(Array.isArray(where.AND)).toBe(true);
    const flat = JSON.stringify(where.AND);
    expect(flat).toContain("TEST-");
    expect(flat).toContain("DEMO");
    expect(flat).toContain("AMB-DEMO-");
    expect(flat).toContain("Demo Driver");
  });

  it("in NODE_ENV=test, where-clause does NOT add the prod filter (seed data renders for dev/CI)", async () => {
    process.env.NODE_ENV = "test";
    prismaMock.ambulance.findMany.mockResolvedValueOnce([]);

    const res = await request(buildApp())
      .get("/api/v1/ambulance")
      .set("Authorization", `Bearer ${adminToken()}`);

    expect(res.status).toBe(200);
    const where = prismaMock.ambulance.findMany.mock.calls[0][0].where;
    // No AND-of-NOT gate in dev/test.
    expect(where.AND).toBeUndefined();
  });

  it("in NODE_ENV=development, where-clause does NOT add the prod filter", async () => {
    process.env.NODE_ENV = "development";
    prismaMock.ambulance.findMany.mockResolvedValueOnce([]);

    await request(buildApp())
      .get("/api/v1/ambulance")
      .set("Authorization", `Bearer ${adminToken()}`);

    const where = prismaMock.ambulance.findMany.mock.calls[0][0].where;
    expect(where.AND).toBeUndefined();
  });
});
