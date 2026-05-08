/**
 * Issues #595 / #596 / #599 — pin the patient registration / edit duplicate
 * checks (email + phone) and the GET /:id RBAC tightening.
 *
 * #595: POST /patients was returning 200 for a duplicate email even though
 *       User.email is `@unique`; users got a Prisma P2002 wrapped as a
 *       generic 500 instead of an actionable 409 with the existing MR
 *       number. Same for PATCH /patients/:id.
 * #596: POST already pre-checked phone — but PATCH didn't, so reception
 *       could blank-set a duplicate. Added a mirror pre-check.
 * #599: GET /patients/:id had no `authorize()` middleware. PHARMACIST
 *       (denied in the UI via /dashboard/patients) could fetch the full
 *       patient PII (address, blood group, insurance, emergency contacts)
 *       directly via the API. Added the same role gate as the list
 *       endpoint.
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
      findFirst: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    user: { create: vi.fn(), update: vi.fn(), findUnique: vi.fn() },
    appointment: { findMany: vi.fn(async () => []) },
    vitals: { findMany: vi.fn(async () => []) },
    prescription: { findMany: vi.fn(async () => []) },
    auditLog: { create: vi.fn(async () => ({ id: "al-1" })) },
    systemConfig: { findUnique: vi.fn(async () => null), upsert: vi.fn() },
    $transaction: vi.fn(async (fn: (tx: any) => Promise<any>) => fn(base)),
    $extends() {
      return base;
    },
  };
  return { prismaMock: base };
});

vi.mock("@medcore/db", () => ({
  prisma: prismaMock,
  tenantScopedPrisma: prismaMock,
}));

import { patientRouter } from "./patients";
import { errorHandler } from "../middleware/error";

function buildApp() {
  process.env.JWT_SECRET = "test-secret";
  const app = express();
  app.use(express.json());
  app.use("/api/v1/patients", patientRouter);
  app.use(errorHandler);
  return app;
}

function tokenFor(role: string, userId = "u-1") {
  return jwt.sign(
    { userId, email: `${role.toLowerCase()}@test.local`, role },
    "test-secret",
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /patients — Issue #595 (email duplicate pre-check)", () => {
  it("returns 409 when an active patient already uses the same email", async () => {
    prismaMock.patient.findFirst
      // phone pre-check — no match
      .mockResolvedValueOnce(null)
      // email pre-check — match
      .mockResolvedValueOnce({
        id: "p-existing",
        mrNumber: "MR000007",
        user: { name: "Aanya Sharma" },
      });

    const res = await request(buildApp())
      .post("/api/v1/patients")
      .set("Authorization", `Bearer ${tokenFor("RECEPTION")}`)
      .send({
        name: "Different Person",
        phone: "9000000000",
        email: "aanya@example.com",
        gender: "FEMALE",
        age: 30,
      });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/email is already registered/i);
    expect(res.body.details?.[0]?.field).toBe("email");
    expect(res.body.existingPatient?.mrNumber).toBe("MR000007");
    expect(prismaMock.user.create).not.toHaveBeenCalled();
    expect(prismaMock.patient.create).not.toHaveBeenCalled();
  });

  it("returns 409 when an active patient already uses the same phone (pre-existing #596 contract)", async () => {
    prismaMock.patient.findFirst.mockResolvedValueOnce({
      id: "p-existing",
      mrNumber: "MR000008",
      user: { name: "Ravi Patel" },
    });

    const res = await request(buildApp())
      .post("/api/v1/patients")
      .set("Authorization", `Bearer ${tokenFor("RECEPTION")}`)
      .send({
        name: "Different Person",
        phone: "9000000001",
        email: "new@example.com",
        gender: "MALE",
        age: 40,
      });

    expect(res.status).toBe(409);
    expect(res.body.details?.[0]?.field).toBe("phone");
  });
});

describe("PATCH /patients/:id — Issues #595 + #596 (edit-side dup checks)", () => {
  it("returns 409 when the new email is in use on a DIFFERENT active patient", async () => {
    prismaMock.patient.findUnique.mockResolvedValueOnce({
      id: "p-self",
      userId: "u-self",
      mrNumber: "MR000010",
    });
    prismaMock.patient.findFirst.mockResolvedValueOnce({
      mrNumber: "MR000099",
      user: { name: "Other Patient" },
    });

    const res = await request(buildApp())
      .patch("/api/v1/patients/p-self")
      .set("Authorization", `Bearer ${tokenFor("RECEPTION")}`)
      .send({ email: "duplicate@example.com" });

    expect(res.status).toBe(409);
    expect(res.body.details?.[0]?.field).toBe("email");
    expect(prismaMock.user.update).not.toHaveBeenCalled();
  });

  it("returns 409 when the new phone is in use on a DIFFERENT active patient", async () => {
    prismaMock.patient.findUnique.mockResolvedValueOnce({
      id: "p-self",
      userId: "u-self",
      mrNumber: "MR000010",
    });
    prismaMock.patient.findFirst
      // email pre-check skipped (no email in body)
      // phone pre-check returns a match
      .mockResolvedValueOnce({
        mrNumber: "MR000098",
        user: { name: "Phone Owner" },
      });

    const res = await request(buildApp())
      .patch("/api/v1/patients/p-self")
      .set("Authorization", `Bearer ${tokenFor("RECEPTION")}`)
      .send({ phone: "9876543210" });

    expect(res.status).toBe(409);
    expect(res.body.details?.[0]?.field).toBe("phone");
  });
});

describe("GET /patients/:id — Issue #599 (PHARMACIST RBAC lockdown)", () => {
  it("rejects PHARMACIST with 403 — full PII no longer leaks via direct API call", async () => {
    const res = await request(buildApp())
      .get("/api/v1/patients/p-1")
      .set("Authorization", `Bearer ${tokenFor("PHARMACIST")}`);

    expect(res.status).toBe(403);
    expect(prismaMock.patient.findUnique).not.toHaveBeenCalled();
  });

  it("still allows DOCTOR + RECEPTION to fetch the chart", async () => {
    prismaMock.patient.findUnique.mockResolvedValue({
      id: "p-1",
      userId: "u-pat",
      mrNumber: "MR000020",
      user: {
        id: "u-pat",
        name: "Test Patient",
        email: "p@example.com",
        phone: "9000000000",
      },
    });

    const docRes = await request(buildApp())
      .get("/api/v1/patients/p-1")
      .set("Authorization", `Bearer ${tokenFor("DOCTOR")}`);
    expect(docRes.status).toBe(200);

    const recRes = await request(buildApp())
      .get("/api/v1/patients/p-1")
      .set("Authorization", `Bearer ${tokenFor("RECEPTION")}`);
    expect(recRes.status).toBe(200);
  });
});
