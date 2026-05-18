/**
 * Issue #421 — Same patient appearing as ADMITTED in two different beds
 * simultaneously is a data-integrity bug.
 *
 * Layered defense:
 *   1) Service-layer pre-check: `findFirst({ patientId, status: ADMITTED })`
 *      → 409 (the common case, single-request).
 *   2) DB-layer partial unique index `one_active_admission_per_patient` on
 *      `admissions(patientId) WHERE status = 'ADMITTED'` (migration
 *      20260424000001) — wins the TOCTOU race when two concurrent POSTs
 *      both clear (1).
 *   3) Route translates the resulting Prisma `P2002` into a clean 409 so
 *      the second concurrent caller sees the same contract as the
 *      pre-check path (instead of a generic 500 from the global error
 *      handler).
 *
 * These tests pin (1) and (3).
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";

const { prismaMock } = vi.hoisted(() => {
  const base: any = {
    admission: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    bed: {
      findUnique: vi.fn(),
      update: vi.fn(),
      count: vi.fn(),
    },
    patient: { findUnique: vi.fn() },
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
  runWithTenant: (_t: string, fn: () => unknown) => fn(),
  requireTenantId: () => { throw new Error("tenant ctx required"); },
  prisma: prismaMock,
  // `apps/api/src/services/tenant-prisma.ts` re-exports
  // `tenantScopedPrisma` from this package; admissions.ts imports
  // both. The shim points at the same mock so create/findFirst/etc.
  // calls land on a single object the tests can drive.
  tenantScopedPrisma: prismaMock,
}));
vi.mock("../services/pdf", () => ({ generateDischargeSummaryHTML: vi.fn() }));
vi.mock("../services/pdf-generator", () => ({
  generateDischargeSummaryPDFBuffer: vi.fn(),
}));

import { admissionRouter } from "./admissions";
import { errorHandler } from "../middleware/error";

function buildApp() {
  process.env.JWT_SECRET = "test-secret";
  const app = express();
  app.use(express.json());
  app.use("/api/v1/admissions", admissionRouter);
  app.use(errorHandler);
  return app;
}

function doctorToken(): string {
  return jwt.sign(
    { userId: "u-doc", email: "d@test.local", role: "DOCTOR" },
    "test-secret"
  );
}

const baseAdmitBody = {
  patientId: "550e8400-e29b-41d4-a716-446655441111",
  doctorId: "550e8400-e29b-41d4-a716-446655442222",
  bedId: "550e8400-e29b-41d4-a716-446655443333",
  reason: "Acute appendicitis",
};

describe("Issue #421 — admission uniqueness (one-active-per-patient)", () => {
  beforeEach(() => {
    prismaMock.admission.findFirst.mockReset();
    prismaMock.admission.findUnique.mockReset();
    prismaMock.admission.create.mockReset();
    prismaMock.bed.findUnique.mockReset();
    prismaMock.bed.update.mockReset();
  });

  it("rejects with 409 when the patient already has an ACTIVE admission (pre-check path)", async () => {
    // Existing active admission found by the service-layer guard.
    prismaMock.admission.findFirst.mockResolvedValueOnce({
      id: "admission-existing",
      admissionNumber: "IPD000010",
      bedId: "bed-existing",
    });

    const res = await request(buildApp())
      .post("/api/v1/admissions")
      .set("Authorization", `Bearer ${doctorToken()}`)
      .send(baseAdmitBody);

    expect(res.status).toBe(409);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/already has an active admission/i);
    expect(res.body.existingAdmission).toMatchObject({
      id: "admission-existing",
      admissionNumber: "IPD000010",
      bedId: "bed-existing",
    });
    // Bed must not be touched in this branch.
    expect(prismaMock.bed.findUnique).not.toHaveBeenCalled();
    expect(prismaMock.admission.create).not.toHaveBeenCalled();
    expect(prismaMock.bed.update).not.toHaveBeenCalled();
  });

  it("rejects with 409 (not 500) when the partial unique index fires under a concurrent race (P2002 path)", async () => {
    // Pre-check passes — no existing active admission visible at this
    // snapshot. Models the TOCTOU window for two concurrent POSTs.
    prismaMock.admission.findFirst
      .mockResolvedValueOnce(null) // pre-check
      .mockResolvedValueOnce({
        id: "admission-winner",
        admissionNumber: "IPD000020",
        bedId: "bed-winner",
      }); // post-P2002 lookup
    // For nextAdmissionNumber()
    prismaMock.admission.findFirst.mockResolvedValueOnce(null);
    prismaMock.bed.findUnique
      // Outer pre-check (with ward include for #736 ward-cap guard).
      .mockResolvedValueOnce({
        id: baseAdmitBody.bedId,
        wardId: "ward-1",
        status: "AVAILABLE",
        ward: { id: "ward-1", name: "Ward A" },
      })
      // In-transaction re-read (#736 race-safe allocation) — still
      // available, so we proceed to the create that hits P2002.
      .mockResolvedValueOnce({ status: "AVAILABLE" });
    prismaMock.bed.count.mockResolvedValueOnce(2); // ward has free beds
    // The race-loser: Prisma surfaces the partial-unique-index violation
    // as a P2002 from inside $transaction → tx.admission.create.
    const p2002 = Object.assign(new Error("Unique constraint failed"), {
      code: "P2002",
      meta: { target: ["one_active_admission_per_patient"] },
    });
    prismaMock.admission.create.mockRejectedValueOnce(p2002);

    const res = await request(buildApp())
      .post("/api/v1/admissions")
      .set("Authorization", `Bearer ${doctorToken()}`)
      .send(baseAdmitBody);

    // Must be 409 (clean contract), not a generic 500.
    expect(res.status).toBe(409);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/already has an active admission/i);
  });

  it("succeeds (201) on the happy path when no other ACTIVE admission exists", async () => {
    prismaMock.admission.findFirst
      .mockResolvedValueOnce(null) // pre-check
      .mockResolvedValueOnce(null); // nextAdmissionNumber
    prismaMock.bed.findUnique
      // Outer pre-check (with ward include).
      .mockResolvedValueOnce({
        id: baseAdmitBody.bedId,
        wardId: "ward-1",
        status: "AVAILABLE",
        ward: { id: "ward-1", name: "Ward A" },
      })
      // In-transaction re-read for race-safe allocation (#736).
      .mockResolvedValueOnce({ status: "AVAILABLE" });
    prismaMock.bed.count.mockResolvedValueOnce(3); // ward has free beds
    prismaMock.admission.create.mockResolvedValueOnce({
      id: "new-admission",
      admissionNumber: "IPD000001",
      patientId: baseAdmitBody.patientId,
      doctorId: baseAdmitBody.doctorId,
      bedId: baseAdmitBody.bedId,
      status: "ADMITTED",
      patient: { user: { name: "Test", phone: "1" } },
      doctor: { user: { name: "Doc" } },
      bed: { ward: { name: "Ward A" } },
    });
    prismaMock.bed.update.mockResolvedValueOnce({});

    const res = await request(buildApp())
      .post("/api/v1/admissions")
      .set("Authorization", `Bearer ${doctorToken()}`)
      .send(baseAdmitBody);

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.id).toBe("new-admission");
  });
});

/**
 * Issue #736 — Admit Patient must not succeed when the requested ward
 * has 0 free beds. The per-bed `bed.status === AVAILABLE` check above
 * is necessary but not sufficient (stale-AVAILABLE rows, dropped
 * admissions). This test pins the explicit ward-capacity guard.
 */
describe("Issue #736 — admit blocked when ward has 0 free beds", () => {
  beforeEach(() => {
    prismaMock.admission.findFirst.mockReset();
    prismaMock.admission.findUnique.mockReset();
    prismaMock.admission.create.mockReset();
    prismaMock.bed.findUnique.mockReset();
    prismaMock.bed.update.mockReset();
    prismaMock.bed.count.mockReset();
  });

  it("returns 400 with a clear ward-name error when bed.count(wardId, AVAILABLE) is 0", async () => {
    prismaMock.admission.findFirst.mockResolvedValueOnce(null); // no active admission
    prismaMock.bed.findUnique.mockResolvedValueOnce({
      id: baseAdmitBody.bedId,
      wardId: "ward-1",
      status: "AVAILABLE",
      ward: { id: "ward-1", name: "ICU North" },
    });
    // The crux: ward shows zero free beds even though the picked bed
    // momentarily reads AVAILABLE.
    prismaMock.bed.count.mockResolvedValueOnce(0);

    const res = await request(buildApp())
      .post("/api/v1/admissions")
      .set("Authorization", `Bearer ${doctorToken()}`)
      .send(baseAdmitBody);

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/no beds available in icu north/i);
    // Defensive: nothing was created or updated.
    expect(prismaMock.admission.create).not.toHaveBeenCalled();
    expect(prismaMock.bed.update).not.toHaveBeenCalled();
  });

  it("returns 409 when the bed status flips between pre-check and the transactional re-read (race loss)", async () => {
    prismaMock.admission.findFirst
      .mockResolvedValueOnce(null) // pre-check (no active admission)
      .mockResolvedValueOnce(null); // nextAdmissionNumber
    prismaMock.bed.findUnique
      // Outer pre-check sees AVAILABLE.
      .mockResolvedValueOnce({
        id: baseAdmitBody.bedId,
        wardId: "ward-1",
        status: "AVAILABLE",
        ward: { id: "ward-1", name: "Ward A" },
      })
      // In-transaction re-read: a concurrent admit grabbed it first.
      .mockResolvedValueOnce({ status: "OCCUPIED" });
    prismaMock.bed.count.mockResolvedValueOnce(1); // ward had a free slot

    const res = await request(buildApp())
      .post("/api/v1/admissions")
      .set("Authorization", `Bearer ${doctorToken()}`)
      .send(baseAdmitBody);

    expect(res.status).toBe(409);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/no longer available/i);
    expect(prismaMock.admission.create).not.toHaveBeenCalled();
  });
});
