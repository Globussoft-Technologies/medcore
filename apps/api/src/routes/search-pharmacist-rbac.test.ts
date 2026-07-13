/**
 * Issue #612 — global search palette returned the full appointment history
 * (with every doctor + every status) to PHARMACIST users. Pharmacists only
 * need dispense-relevant info: patient (name + MR) and prescriptions.
 *
 * Pins:
 *   - When a PHARMACIST searches, the response NEVER contains hits of type
 *     `appointment`, `invoice`, `admission`, `surgery`, or `lab`.
 *   - Patient + prescription hits are still returned (the workflow surface
 *     pharmacists DO need).
 *   - The PHARMACIST patient hit redacts `meta` (phone) — paired with #599.
 *   - Other roles (ADMIN / DOCTOR / etc.) see the full result set as
 *     before — the per-role allowlist only activates for PHARMACIST.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";

const { prismaMock } = vi.hoisted(() => {
  const base: any = {
    patient: {
      findFirst: vi.fn(async () => null),
      findMany: vi.fn(async () => [
        {
          id: "p-1",
          mrNumber: "MR000020",
          gender: "FEMALE",
          age: 38,
          user: { name: "Fatima Sheikh", phone: "9876543229", email: null },
        },
      ]),
    },
    doctor: {
      findFirst: vi.fn(async () => null),
      findMany: vi.fn(async () => []),
    },
    // Catalog/operational models added with the 2026-07 search expansion.
    medicine: { findMany: vi.fn(async () => []) },
    ward: { findMany: vi.fn(async () => []) },
    bloodUnit: { findMany: vi.fn(async () => []) },
    ambulance: { findMany: vi.fn(async () => []) },
    user: { findMany: vi.fn(async () => []) },
    tenant: { findMany: vi.fn(async () => []) },
    appointment: {
      findMany: vi.fn(async () => [
        {
          id: "a-1",
          type: "FOLLOW_UP",
          date: new Date("2026-04-10"),
          status: "COMPLETED",
          patient: { user: { name: "Fatima" } },
          doctor: { user: { name: "Gupta" } },
        },
      ]),
    },
    invoice: { findMany: vi.fn(async () => []) },
    prescription: {
      findMany: vi.fn(async () => [
        {
          id: "rx-1",
          diagnosis: "Hypertension",
          createdAt: new Date("2026-04-10"),
          patient: { user: { name: "Fatima" } },
          doctor: { user: { name: "Gupta" } },
        },
      ]),
    },
    admission: { findMany: vi.fn(async () => []) },
    surgery: { findMany: vi.fn(async () => []) },
    labOrder: { findMany: vi.fn(async () => []) },
    $extends() {
      return base;
    },
  };
  return { prismaMock: base };
});

vi.mock("@medcore/db", () => ({
  getTenantId: () => undefined,
  runWithTenant: (_t: string, fn: () => unknown) => fn(),
  requireTenantId: () => { throw new Error("tenant ctx required"); },
  prisma: prismaMock,
  tenantScopedPrisma: prismaMock,
}));

import { searchRouter } from "./search";
import { errorHandler } from "../middleware/error";

function buildApp() {
  process.env.JWT_SECRET = "test-secret";
  const app = express();
  app.use(express.json());
  app.use("/api/v1/search", searchRouter);
  app.use(errorHandler);
  return app;
}

function tokenFor(role: string) {
  return jwt.sign(
    { userId: "u-1", email: `${role.toLowerCase()}@test.local`, role },
    "test-secret",
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /search — Issue #612 (PHARMACIST role allowlist)", () => {
  it("does NOT return appointment / invoice / admission / surgery / lab hits to PHARMACIST", async () => {
    const res = await request(buildApp())
      .get("/api/v1/search?q=Fatima")
      .set("Authorization", `Bearer ${tokenFor("PHARMACIST")}`)
      .expect(200);

    const types = (res.body.data as Array<{ type: string }>).map((h) => h.type);
    expect(types).not.toContain("appointment");
    expect(types).not.toContain("invoice");
    expect(types).not.toContain("admission");
    expect(types).not.toContain("surgery");
    expect(types).not.toContain("lab");
    // Sanity: the PHARMACIST does still get patient + prescription hits.
    expect(types).toContain("patient");
    expect(types).toContain("prescription");
  });

  it("redacts the patient phone from PHARMACIST search hits (paired with #599)", async () => {
    const res = await request(buildApp())
      .get("/api/v1/search?q=Fatima")
      .set("Authorization", `Bearer ${tokenFor("PHARMACIST")}`)
      .expect(200);

    const patientHit = (res.body.data as Array<any>).find(
      (h) => h.type === "patient",
    );
    expect(patientHit).toBeDefined();
    expect(patientHit.meta).toBe("");
  });

  it("does NOT call appointment / invoice / admission / surgery / lab queries for PHARMACIST", async () => {
    await request(buildApp())
      .get("/api/v1/search?q=Fatima")
      .set("Authorization", `Bearer ${tokenFor("PHARMACIST")}`)
      .expect(200);

    expect(prismaMock.appointment.findMany).not.toHaveBeenCalled();
    expect(prismaMock.invoice.findMany).not.toHaveBeenCalled();
    expect(prismaMock.admission.findMany).not.toHaveBeenCalled();
    expect(prismaMock.surgery.findMany).not.toHaveBeenCalled();
    expect(prismaMock.labOrder.findMany).not.toHaveBeenCalled();
    // PHARMACIST DOES get medicines (dispense-relevant), but NOT the
    // staff-only catalog surfaces (doctors / wards / blood / ambulances / users).
    expect(prismaMock.medicine.findMany).toHaveBeenCalled();
    expect(prismaMock.doctor.findMany).not.toHaveBeenCalled();
    expect(prismaMock.ward.findMany).not.toHaveBeenCalled();
    expect(prismaMock.bloodUnit.findMany).not.toHaveBeenCalled();
    expect(prismaMock.ambulance.findMany).not.toHaveBeenCalled();
    expect(prismaMock.user.findMany).not.toHaveBeenCalled();
  });

  it("ADMIN still sees the full surface incl. the new catalog entities", async () => {
    await request(buildApp())
      .get("/api/v1/search?q=Fatima")
      .set("Authorization", `Bearer ${tokenFor("ADMIN")}`)
      .expect(200);

    expect(prismaMock.appointment.findMany).toHaveBeenCalled();
    expect(prismaMock.invoice.findMany).toHaveBeenCalled();
    expect(prismaMock.doctor.findMany).toHaveBeenCalled();
    expect(prismaMock.medicine.findMany).toHaveBeenCalled();
    expect(prismaMock.ward.findMany).toHaveBeenCalled();
    expect(prismaMock.bloodUnit.findMany).toHaveBeenCalled();
    expect(prismaMock.ambulance.findMany).toHaveBeenCalled();
    expect(prismaMock.user.findMany).toHaveBeenCalled();
  });
});
