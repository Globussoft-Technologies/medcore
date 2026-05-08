/**
 * Issue #732 — `$everything` must emit a FHIR-native OperationOutcome on
 * server failure (not the generic MedCore-envelope 500).
 *
 * Modules under test:
 *   - apps/api/src/routes/fhir.ts (the GET /Patient/:id/$everything handler)
 *
 * The handler used to forward unexpected errors to next(err), which the
 * global errorHandler then returned as `{ success:false, error:"Internal
 * server error" }`. FHIR clients (ABDM HIU pulls, third-party gateways)
 * cannot parse that — they expect `{ resourceType:"OperationOutcome",
 * issue:[...] }` per FHIR R4 §3.1.6. This test forces the prisma layer
 * to throw and asserts the response is a well-formed OperationOutcome
 * with `code:"exception"` and a non-empty `diagnostics` field.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";

const { prismaMock } = vi.hoisted(() => {
  const base: any = {
    patient: {
      findUnique: vi.fn(),
    },
    consultation: {
      findMany: vi.fn(async () => []),
    },
    auditLog: { create: vi.fn(async () => ({ id: "al-1" })) },
    systemConfig: { findUnique: vi.fn(async () => null) },
    $extends(_c: unknown) {
      return base;
    },
  };
  return { prismaMock: base };
});

vi.mock("@medcore/db", async () => {
  const actual = await vi.importActual<any>("@medcore/db");
  return {
    ...actual,
    prisma: prismaMock,
    tenantScopedPrisma: prismaMock,
  };
});

import { fhirRouter } from "./fhir";
import { errorHandler } from "../middleware/error";

function buildApp() {
  process.env.JWT_SECRET = "test-secret";
  const app = express();
  app.use(express.json());
  app.use("/api/v1/fhir", fhirRouter);
  app.use(errorHandler);
  return app;
}

function adminToken(): string {
  return jwt.sign(
    { userId: "u-admin", email: "a@test.local", role: "ADMIN" },
    "test-secret"
  );
}

describe("Issue #732 — FHIR $everything emits OperationOutcome on 500", () => {
  beforeEach(() => {
    prismaMock.patient.findUnique.mockReset();
  });

  it("returns a FHIR OperationOutcome with severity=error code=exception when the DB fetch throws", async () => {
    prismaMock.patient.findUnique.mockRejectedValueOnce(
      new Error("Connection terminated unexpectedly")
    );

    const validUuid = "11111111-1111-4111-8111-111111111111";
    const res = await request(buildApp())
      .get(`/api/v1/fhir/Patient/${validUuid}/$everything`)
      .set("Authorization", `Bearer ${adminToken()}`);

    expect(res.status).toBe(500);

    const body = typeof res.body === "string" ? JSON.parse(res.body) : res.body;
    // Must be a FHIR OperationOutcome (NOT the MedCore envelope).
    expect(body.resourceType).toBe("OperationOutcome");
    expect(body).not.toHaveProperty("success");
    expect(body).not.toHaveProperty("data");

    // Issue must surface a useful diagnostics string so operators can trace
    // the failure without SSH-ing to logs.
    expect(Array.isArray(body.issue)).toBe(true);
    expect(body.issue[0].severity).toBe("error");
    expect(body.issue[0].code).toBe("exception");
    expect(body.issue[0].diagnostics).toEqual(
      expect.stringContaining("Connection terminated")
    );
    expect(body.issue[0].details?.text).toMatch(/everything/i);
  });

  it("still returns a 404 OperationOutcome with code=not-found when the patient is missing (not the 500 path)", async () => {
    // Sanity: regression guard so the new try/catch doesn't swallow the
    // existing not-found semantics.
    prismaMock.patient.findUnique.mockResolvedValueOnce(null);

    const validUuid = "22222222-2222-4222-8222-222222222222";
    const res = await request(buildApp())
      .get(`/api/v1/fhir/Patient/${validUuid}/$everything`)
      .set("Authorization", `Bearer ${adminToken()}`);

    expect(res.status).toBe(404);
    const body = typeof res.body === "string" ? JSON.parse(res.body) : res.body;
    expect(body.resourceType).toBe("OperationOutcome");
    expect(body.issue[0].code).toBe("not-found");
  });
});
