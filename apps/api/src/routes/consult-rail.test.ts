// Unit-style tests for the /api/v1/consult-rail router
// (Pearl ERP Stage 1 §2.1.3, gap row 46).
//
// What / which modules / why:
//   - Pins the derived-favourites contract: GET /favourites/:doctorId
//     samples the last 50 prescriptions and returns top-K diagnoses + top-K
//     medicine names sorted by frequency (ties broken by first-seen order).
//   - Pins the last-3-visits contract: GET /visits/:patientId returns at
//     most 3 prescription rows ordered by createdAt desc.
//   - Pins UUID validation on both `:doctorId` and `:patientId`.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    auditLog: { create: vi.fn(async () => ({ id: "al-1" })) },
    prescription: {
      findMany: vi.fn(async () => []),
    },
  } as any,
}));

vi.mock("@medcore/db", () => ({
  getTenantId: () => undefined,
  tenantScopedPrisma: prismaMock,
  runWithTenant: (_t: string, fn: () => unknown) => fn(),
  requireTenantId: () => {
    throw new Error("tenant ctx required");
  },
  prisma: prismaMock,
}));

import { consultRailRouter } from "./consult-rail";

function buildApp() {
  process.env.JWT_SECRET = "test-secret";
  process.env.NODE_ENV = "test";
  const app = express();
  app.use(express.json());
  app.use("/api/v1/consult-rail", consultRailRouter);
  return app;
}

function tokenFor(role: string): string {
  return jwt.sign(
    { userId: `u-${role}`, email: `${role}@t.local`, role },
    "test-secret",
  );
}

const DOC_ID = "11111111-1111-4111-8111-111111111111";
const PAT_ID = "22222222-2222-4222-8222-222222222222";

describe("GET /api/v1/consult-rail/favourites/:doctorId — derived favourites", () => {
  beforeEach(() => {
    prismaMock.prescription.findMany.mockReset();
    prismaMock.auditLog.create.mockClear();
  });

  it("returns top-K diagnoses and medicines sorted by frequency desc", async () => {
    prismaMock.prescription.findMany.mockResolvedValueOnce([
      { diagnosis: "Fever",     items: [{ medicineName: "Paracetamol" }] },
      { diagnosis: "Fever",     items: [{ medicineName: "Paracetamol" }] },
      { diagnosis: "Fever",     items: [{ medicineName: "ORS" }] },
      { diagnosis: "Diabetes",  items: [{ medicineName: "Metformin" }] },
      { diagnosis: "Diabetes",  items: [{ medicineName: "Metformin" }] },
      { diagnosis: "Hypertension", items: [{ medicineName: "Amlodipine" }] },
    ]);

    const res = await request(buildApp())
      .get(`/api/v1/consult-rail/favourites/${DOC_ID}`)
      .set("Authorization", `Bearer ${tokenFor("DOCTOR")}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    // Diagnoses: Fever(3), Diabetes(2), Hypertension(1)
    expect(res.body.data.diagnoses[0]).toEqual({ value: "Fever", count: 3 });
    expect(res.body.data.diagnoses[1]).toEqual({ value: "Diabetes", count: 2 });
    expect(res.body.data.diagnoses[2]).toEqual({ value: "Hypertension", count: 1 });
    // Medicines: Paracetamol(2), Metformin(2), ORS(1), Amlodipine(1)
    expect(res.body.data.medicines[0]).toEqual({ value: "Paracetamol", count: 2 });
    expect(res.body.data.medicines[1]).toEqual({ value: "Metformin", count: 2 });
    expect(res.body.data.sampledFrom).toBe(6);
  });

  it("rejects a non-UUID :doctorId with a 400", async () => {
    const res = await request(buildApp())
      .get("/api/v1/consult-rail/favourites/not-a-uuid")
      .set("Authorization", `Bearer ${tokenFor("DOCTOR")}`);
    expect(res.status).toBe(400);
  });

  it("requires authentication (401 without bearer)", async () => {
    const res = await request(buildApp()).get(
      `/api/v1/consult-rail/favourites/${DOC_ID}`,
    );
    expect(res.status).toBe(401);
  });

  it("rejects an unauthorized role (PATIENT) with a 403", async () => {
    const res = await request(buildApp())
      .get(`/api/v1/consult-rail/favourites/${DOC_ID}`)
      .set("Authorization", `Bearer ${tokenFor("PATIENT")}`);
    expect(res.status).toBe(403);
  });
});

describe("GET /api/v1/consult-rail/visits/:patientId — last 3 visits", () => {
  beforeEach(() => {
    prismaMock.prescription.findMany.mockReset();
  });

  it("returns the prescriptions as-is from the DB (caller passes them through)", async () => {
    const rows = [
      { id: "rx-1", createdAt: new Date(), diagnosis: "A", advice: null, followUpDate: null, items: [] },
      { id: "rx-2", createdAt: new Date(), diagnosis: "B", advice: null, followUpDate: null, items: [] },
    ];
    prismaMock.prescription.findMany.mockResolvedValueOnce(rows);

    const res = await request(buildApp())
      .get(`/api/v1/consult-rail/visits/${PAT_ID}`)
      .set("Authorization", `Bearer ${tokenFor("DOCTOR")}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveLength(2);
    // Caps at 3 — verify the take param.
    const call = prismaMock.prescription.findMany.mock.calls[0][0];
    expect(call.take).toBe(3);
    expect(call.orderBy).toEqual({ createdAt: "desc" });
    expect(call.where).toEqual({ patientId: PAT_ID });
  });

  it("rejects a non-UUID :patientId with a 400", async () => {
    const res = await request(buildApp())
      .get("/api/v1/consult-rail/visits/not-a-uuid")
      .set("Authorization", `Bearer ${tokenFor("DOCTOR")}`);
    expect(res.status).toBe(400);
  });
});
