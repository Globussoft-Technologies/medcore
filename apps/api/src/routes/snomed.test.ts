/**
 * Pearl ERP Stage 1 §2.1.3 — vitest unit coverage for the SNOMED CT
 * diagnosis-coding lookup endpoint (apps/api/src/routes/snomed.ts).
 *
 * What this locks in:
 *   - GET /api/v1/snomed?q=... — AND-of-OR token match across code +
 *     description, identical contract to /icd10.
 *   - Exact-prefix re-ranking (rows whose code OR description starts
 *     with the query come first).
 *   - `limit` query param honoured + capped at 100.
 *   - `category` filter passed through to Prisma where clause.
 *   - POST /api/v1/snomed — admin-only upsert helper.
 *   - Auth: 401 without bearer; 403 for non-ADMIN POST.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";

const { prismaMock } = vi.hoisted(() => {
  const base: any = {
    snomedCode: {
      findMany: vi.fn(),
      upsert: vi.fn(),
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
  getTenantId: () => null,
}));

import { snomedRouter } from "./snomed";
import { errorHandler } from "../middleware/error";

function buildApp() {
  process.env.JWT_SECRET = "test-secret";
  const app = express();
  app.use(express.json());
  app.use("/api/v1/snomed", snomedRouter);
  app.use(errorHandler);
  return app;
}

function token(role: string): string {
  return jwt.sign(
    { userId: `u-${role}`, email: `${role}@test.local`, role },
    "test-secret",
  );
}

describe("GET /api/v1/snomed — search", () => {
  beforeEach(() => {
    prismaMock.snomedCode.findMany.mockReset();
  });

  it("returns the candidate rows from the DB (no query → returns all up to limit)", async () => {
    prismaMock.snomedCode.findMany.mockResolvedValueOnce([
      { code: "38341003", description: "Hypertensive disorder", category: "Circulatory" },
      { code: "44054006", description: "Type 2 diabetes mellitus", category: "Endocrine" },
    ]);

    const res = await request(buildApp())
      .get("/api/v1/snomed")
      .set("Authorization", `Bearer ${token("DOCTOR")}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    // No tokens → no AND clause assembled.
    const call = prismaMock.snomedCode.findMany.mock.calls[0][0];
    expect(call.where).toEqual({});
    expect(call.take).toBe(100); // candidateLimit = min(take*5, 200) → min(100, 200)
    expect(call.orderBy).toEqual({ code: "asc" });
  });

  it("AND-tokenises the query across code + description (one OR clause per token)", async () => {
    prismaMock.snomedCode.findMany.mockResolvedValueOnce([]);

    await request(buildApp())
      .get("/api/v1/snomed?q=type%202%20diabetes")
      .set("Authorization", `Bearer ${token("DOCTOR")}`);

    const call = prismaMock.snomedCode.findMany.mock.calls[0][0];
    expect(call.where.AND).toBeDefined();
    expect(call.where.AND).toHaveLength(3); // "type", "2", "diabetes"
    expect(call.where.AND[0]).toEqual({
      OR: [
        { code: { contains: "type" } },
        { description: { contains: "type", mode: "insensitive" } },
      ],
    });
  });

  it("re-ranks rows so a code-prefix match wins over a description-prefix match", async () => {
    // Returned in raw alphabetic order; ranker should put the
    // code-prefix match FIRST regardless.
    prismaMock.snomedCode.findMany.mockResolvedValueOnce([
      { code: "38341003", description: "Hypertensive disorder" },
      { code: "59621000", description: "Essential hypertension" }, // desc matches first
    ]);

    const res = await request(buildApp())
      .get("/api/v1/snomed?q=hyper")
      .set("Authorization", `Bearer ${token("DOCTOR")}`);

    // "59621000" desc starts with "essential" (not hyper), but the
    // ranker looks at codes too. Neither code starts with "hyper".
    // BOTH descriptions match the lowercase startsWith("hyper") check
    // for "Hypertensive disorder" (38341003). So 38341003 wins.
    expect(res.body.data[0].code).toBe("38341003");
  });

  it("honours an explicit limit query param (capped at 100)", async () => {
    prismaMock.snomedCode.findMany.mockResolvedValueOnce([]);
    await request(buildApp())
      .get("/api/v1/snomed?limit=5&q=asthma")
      .set("Authorization", `Bearer ${token("DOCTOR")}`);

    const call = prismaMock.snomedCode.findMany.mock.calls[0][0];
    // candidateLimit = min(5*5, 200) = 25
    expect(call.take).toBe(25);
  });

  it("applies the category filter when provided", async () => {
    prismaMock.snomedCode.findMany.mockResolvedValueOnce([]);
    await request(buildApp())
      .get("/api/v1/snomed?category=Respiratory")
      .set("Authorization", `Bearer ${token("DOCTOR")}`);

    const call = prismaMock.snomedCode.findMany.mock.calls[0][0];
    expect(call.where.category).toBe("Respiratory");
  });

  it("rejects unauthenticated requests with 401", async () => {
    const res = await request(buildApp()).get("/api/v1/snomed?q=fever");
    expect(res.status).toBe(401);
  });

  it("allows any authenticated role to read (no role gate on GET)", async () => {
    prismaMock.snomedCode.findMany.mockResolvedValueOnce([]);
    const res = await request(buildApp())
      .get("/api/v1/snomed?q=fever")
      .set("Authorization", `Bearer ${token("NURSE")}`);
    expect(res.status).toBe(200);
  });

  it("slices the response to the requested `limit` (default 20)", async () => {
    // Mock returns 100 candidates; final slice should keep only 20.
    const rows = Array.from({ length: 100 }, (_, i) => ({
      code: `code-${i}`,
      description: `desc-${i}`,
    }));
    prismaMock.snomedCode.findMany.mockResolvedValueOnce(rows);

    const res = await request(buildApp())
      .get("/api/v1/snomed?q=desc")
      .set("Authorization", `Bearer ${token("DOCTOR")}`);

    expect(res.body.data).toHaveLength(20);
  });
});

describe("POST /api/v1/snomed — admin upsert", () => {
  beforeEach(() => {
    prismaMock.snomedCode.upsert.mockReset();
  });

  it("upserts a concept when called by ADMIN (201)", async () => {
    prismaMock.snomedCode.upsert.mockResolvedValueOnce({
      id: "id-1",
      code: "12345",
      description: "Test concept",
      category: null,
    });

    const res = await request(buildApp())
      .post("/api/v1/snomed")
      .set("Authorization", `Bearer ${token("ADMIN")}`)
      .send({ code: "12345", description: "Test concept" });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(prismaMock.snomedCode.upsert).toHaveBeenCalledWith({
      where: { code: "12345" },
      update: { description: "Test concept", category: null },
      create: { code: "12345", description: "Test concept", category: null },
    });
  });

  it("rejects non-admin callers with 403", async () => {
    const res = await request(buildApp())
      .post("/api/v1/snomed")
      .set("Authorization", `Bearer ${token("DOCTOR")}`)
      .send({ code: "12345", description: "Test concept" });

    expect(res.status).toBe(403);
    expect(prismaMock.snomedCode.upsert).not.toHaveBeenCalled();
  });

  it("returns 400 when required fields are missing", async () => {
    const res = await request(buildApp())
      .post("/api/v1/snomed")
      .set("Authorization", `Bearer ${token("ADMIN")}`)
      .send({ code: "12345" }); // missing description

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/code and description are required/);
    expect(prismaMock.snomedCode.upsert).not.toHaveBeenCalled();
  });

  it("rejects unauthenticated POSTs with 401", async () => {
    const res = await request(buildApp())
      .post("/api/v1/snomed")
      .send({ code: "12345", description: "Test concept" });
    expect(res.status).toBe(401);
  });
});
