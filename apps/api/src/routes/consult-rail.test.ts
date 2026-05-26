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
    // Pearl §2.1.3 (2026-05-26) — /visits now merges signed
    // Consultation rows alongside Prescription rows so SOAP-only
    // visits surface in the right rail's "Last 3 visits" panel.
    consultation: {
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
    prismaMock.consultation.findMany.mockReset();
    // Default both to empty so tests not exercising one still resolve.
    prismaMock.prescription.findMany.mockResolvedValue([]);
    prismaMock.consultation.findMany.mockResolvedValue([]);
  });

  it("returns the prescriptions in the merged shape (consultations empty)", async () => {
    const now = new Date();
    const rows = [
      {
        id: "rx-1",
        appointmentId: "apt-1",
        createdAt: now,
        diagnosis: "A",
        advice: null,
        followUpDate: null,
        items: [],
      },
      {
        id: "rx-2",
        appointmentId: "apt-2",
        createdAt: now,
        diagnosis: "B",
        advice: null,
        followUpDate: null,
        items: [],
      },
    ];
    prismaMock.prescription.findMany.mockResolvedValueOnce(rows);

    const res = await request(buildApp())
      .get(`/api/v1/consult-rail/visits/${PAT_ID}`)
      .set("Authorization", `Bearer ${tokenFor("DOCTOR")}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveLength(2);
    // Over-fetch (depth * 2) to allow client-side dedupe and re-sort.
    const call = prismaMock.prescription.findMany.mock.calls[0][0];
    expect(call.take).toBe(6);
    expect(call.orderBy).toEqual({ createdAt: "desc" });
    expect(call.where).toEqual({ patientId: PAT_ID });
  });

  it("merges signed consultations alongside prescriptions, sorted by date desc, capped at 3", async () => {
    const older = new Date("2026-05-01T10:00:00Z");
    const newer = new Date("2026-05-20T10:00:00Z");
    const newest = new Date("2026-05-25T10:00:00Z");

    prismaMock.prescription.findMany.mockResolvedValueOnce([
      {
        id: "rx-old",
        appointmentId: "apt-old",
        createdAt: older,
        diagnosis: "Old Rx",
        advice: null,
        followUpDate: null,
        items: [],
      },
    ]);
    prismaMock.consultation.findMany.mockResolvedValueOnce([
      {
        id: "c-newest",
        appointmentId: "apt-newest",
        createdAt: newest,
        signedAt: newest,
        assessment: "Headache",
        plan: "Hydrate",
        icd10Codes: null,
      },
      {
        id: "c-newer",
        appointmentId: "apt-newer",
        createdAt: newer,
        signedAt: newer,
        assessment: "Cough",
        plan: null,
        icd10Codes: null,
      },
    ]);

    const res = await request(buildApp())
      .get(`/api/v1/consult-rail/visits/${PAT_ID}`)
      .set("Authorization", `Bearer ${tokenFor("DOCTOR")}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(3);
    // Date desc — newest signed consult first, then signed consult,
    // then older prescription.
    expect(res.body.data[0].id).toBe("c-newest");
    expect(res.body.data[1].id).toBe("c-newer");
    expect(res.body.data[2].id).toBe("rx-old");
  });

  it("suppresses a consultation whose appointmentId already has a prescription (Rx wins)", async () => {
    const t = new Date("2026-05-20T10:00:00Z");
    prismaMock.prescription.findMany.mockResolvedValueOnce([
      {
        id: "rx-1",
        appointmentId: "apt-shared",
        createdAt: t,
        diagnosis: "From Rx",
        advice: null,
        followUpDate: null,
        items: [{ medicineName: "Paracetamol" }],
      },
    ]);
    prismaMock.consultation.findMany.mockResolvedValueOnce([
      {
        id: "c-dup",
        appointmentId: "apt-shared", // SAME appointmentId as rx-1
        createdAt: t,
        signedAt: t,
        assessment: "Should not surface",
        plan: null,
        icd10Codes: null,
      },
    ]);

    const res = await request(buildApp())
      .get(`/api/v1/consult-rail/visits/${PAT_ID}`)
      .set("Authorization", `Bearer ${tokenFor("DOCTOR")}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].id).toBe("rx-1");
  });

  it("only fetches SIGNED consultations (DRAFT never leaks into visits)", async () => {
    await request(buildApp())
      .get(`/api/v1/consult-rail/visits/${PAT_ID}`)
      .set("Authorization", `Bearer ${tokenFor("DOCTOR")}`);

    const call = prismaMock.consultation.findMany.mock.calls[0][0];
    expect(call.where).toEqual({
      appointment: { patientId: PAT_ID },
      status: "SIGNED",
    });
    expect(call.orderBy).toEqual({ signedAt: "desc" });
  });

  it("derives a consultation diagnosis from the first ICD-10 code when present", async () => {
    prismaMock.consultation.findMany.mockResolvedValueOnce([
      {
        id: "c-icd",
        appointmentId: "apt-icd",
        createdAt: new Date(),
        signedAt: new Date(),
        assessment: "Free-text assessment",
        plan: null,
        icd10Codes: [
          { code: "I10", description: "Essential hypertension" },
        ],
      },
    ]);

    const res = await request(buildApp())
      .get(`/api/v1/consult-rail/visits/${PAT_ID}`)
      .set("Authorization", `Bearer ${tokenFor("DOCTOR")}`);

    expect(res.status).toBe(200);
    expect(res.body.data[0].diagnosis).toBe("Essential hypertension");
  });

  it("falls back to first non-header line of assessment when no ICD-10 codes", async () => {
    prismaMock.consultation.findMany.mockResolvedValueOnce([
      {
        id: "c-noicd",
        appointmentId: "apt-noicd",
        createdAt: new Date(),
        signedAt: new Date(),
        assessment: "## Clinical Impression / Diagnosis\nViral fever",
        plan: null,
        icd10Codes: null,
      },
    ]);

    const res = await request(buildApp())
      .get(`/api/v1/consult-rail/visits/${PAT_ID}`)
      .set("Authorization", `Bearer ${tokenFor("DOCTOR")}`);

    expect(res.body.data[0].diagnosis).toBe("Viral fever");
  });

  it("rejects a non-UUID :patientId with a 400", async () => {
    const res = await request(buildApp())
      .get("/api/v1/consult-rail/visits/not-a-uuid")
      .set("Authorization", `Bearer ${tokenFor("DOCTOR")}`);
    expect(res.status).toBe(400);
  });
});
