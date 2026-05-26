/**
 * Test-cron tick (2026-05-25) — patient-self-only BOLA guard tests.
 *
 * What / which modules / why
 * ──────────────────────────
 * - WHAT: lock the runtime contract of `assertPatientOwnsResource(req, res,
 *   patientId)` — the per-row ownership check called by patient-scoped
 *   route handlers after they load a resource (OWASP API1:2023 BOLA / IDOR
 *   guard introduced by issue #474). Covers:
 *     - missing `req.user` → 401 + false
 *     - non-PATIENT roles (DOCTOR, ADMIN, NURSE, …) always pass → true
 *     - PATIENT + null/undefined patientId → 403 + false (no Prisma call)
 *     - PATIENT + resource that doesn't exist in DB → 403 + false
 *     - PATIENT + resource owned by a DIFFERENT user → 403 + false
 *     - PATIENT + resource owned by the SAME userId → true
 *     - response envelope shape `{success:false, data:null, error}` on
 *       every rejection branch
 *
 * - MODULES: hoisted mock of `../services/tenant-prisma` (the helper's
 *   only external dependency); also mock `@medcore/db` because the
 *   re-export shim re-routes through it. Pure-unit — no Postgres touched.
 *
 * - WHY: this helper is the single line of defence stopping PATIENT-A
 *   from reading PATIENT-B records through 30+ `/:id` handlers across
 *   admissions, surgeries, lab orders, telemedicine, prescriptions, etc.
 *   A regression in any branch (e.g. accidentally short-circuiting to
 *   `true` when patientId is null, or comparing the wrong field) reopens
 *   the BOLA hole #474 closed. CLAUDE.md gotcha §12 + §14 directly
 *   reference its argument shape — pin both.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    patient: { findUnique: vi.fn() },
  } as any,
}));

vi.mock("../services/tenant-prisma", () => ({
  tenantScopedPrisma: prismaMock,
}));

vi.mock("@medcore/db", () => ({
  tenantScopedPrisma: prismaMock,
  getTenantId: () => undefined,
  runWithTenant: (_t: string, fn: () => unknown) => fn(),
  requireTenantId: () => {
    throw new Error("tenant ctx required");
  },
  prisma: prismaMock,
}));

import { assertPatientOwnsResource } from "./patient-self-only";

// ─── Helpers ──────────────────────────────────────────────────────────────

function makeRes() {
  const res: any = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

function makeReq(user: any): any {
  return { user } as any;
}

const PATIENT_USER = { userId: "user-pat-a", role: "PATIENT" };
const DOCTOR_USER = { userId: "user-doc-1", role: "DOCTOR" };
const ADMIN_USER = { userId: "user-admin-1", role: "ADMIN" };
const NURSE_USER = { userId: "user-nurse-1", role: "NURSE" };

beforeEach(() => {
  prismaMock.patient.findUnique.mockReset();
});

// ─── 401 branch — missing req.user ────────────────────────────────────────

describe("assertPatientOwnsResource — missing req.user", () => {
  it("returns false and writes 401 when req.user is undefined", async () => {
    const req = makeReq(undefined);
    const res = makeRes();

    const result = await assertPatientOwnsResource(req, res, "pat-1");

    expect(result).toBe(false);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      data: null,
      error: "Unauthorized",
    });
  });

  it("does NOT query Prisma when req.user is missing (short-circuits before DB)", async () => {
    const req = makeReq(undefined);
    const res = makeRes();

    await assertPatientOwnsResource(req, res, "pat-1");

    expect(prismaMock.patient.findUnique).not.toHaveBeenCalled();
  });

  it("rejects with 401 even when a valid patientId is supplied", async () => {
    // A populated patientId must NOT bypass the auth check.
    const req = makeReq(undefined);
    const res = makeRes();

    const result = await assertPatientOwnsResource(req, res, "pat-valid-uuid");

    expect(result).toBe(false);
    expect(res.status).toHaveBeenCalledWith(401);
  });
});

// ─── Non-PATIENT bypass — staff roles always pass ─────────────────────────

describe("assertPatientOwnsResource — non-PATIENT roles bypass", () => {
  it("returns true for DOCTOR without touching Prisma", async () => {
    const req = makeReq(DOCTOR_USER);
    const res = makeRes();

    const result = await assertPatientOwnsResource(req, res, "pat-any");

    expect(result).toBe(true);
    expect(prismaMock.patient.findUnique).not.toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });

  it("returns true for ADMIN even with a null patientId (staff bypass beats null-guard)", async () => {
    const req = makeReq(ADMIN_USER);
    const res = makeRes();

    const result = await assertPatientOwnsResource(req, res, null);

    expect(result).toBe(true);
    expect(prismaMock.patient.findUnique).not.toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("returns true for NURSE", async () => {
    const req = makeReq(NURSE_USER);
    const res = makeRes();

    const result = await assertPatientOwnsResource(req, res, "pat-any");

    expect(result).toBe(true);
  });

  it.each([
    ["DOCTOR"],
    ["ADMIN"],
    ["NURSE"],
    ["RECEPTION"],
    ["LAB_TECHNICIAN"],
    ["PHARMACIST"],
    ["RADIOLOGIST"],
  ])("returns true for %s role (broad staff-role bypass)", async (role) => {
    const req = makeReq({ userId: "u-1", role });
    const res = makeRes();

    const result = await assertPatientOwnsResource(req, res, "pat-any");

    expect(result).toBe(true);
    expect(prismaMock.patient.findUnique).not.toHaveBeenCalled();
  });
});

// ─── PATIENT + null/undefined patientId — 403 fast path ───────────────────

describe("assertPatientOwnsResource — PATIENT with null/undefined patientId", () => {
  it("returns false and writes 403 when patientId is null (no Prisma call)", async () => {
    const req = makeReq(PATIENT_USER);
    const res = makeRes();

    const result = await assertPatientOwnsResource(req, res, null);

    expect(result).toBe(false);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      data: null,
      error: "Forbidden",
    });
    expect(prismaMock.patient.findUnique).not.toHaveBeenCalled();
  });

  it("returns false and writes 403 when patientId is undefined", async () => {
    const req = makeReq(PATIENT_USER);
    const res = makeRes();

    const result = await assertPatientOwnsResource(req, res, undefined);

    expect(result).toBe(false);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(prismaMock.patient.findUnique).not.toHaveBeenCalled();
  });

  it("returns false and writes 403 when patientId is an empty string (falsy)", async () => {
    const req = makeReq(PATIENT_USER);
    const res = makeRes();

    const result = await assertPatientOwnsResource(req, res, "");

    expect(result).toBe(false);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(prismaMock.patient.findUnique).not.toHaveBeenCalled();
  });
});

// ─── PATIENT + cross-patient resource — the BOLA fix ──────────────────────

describe("assertPatientOwnsResource — PATIENT cross-patient access (the BOLA hole #474)", () => {
  it("returns false and writes 403 when the patient row does not exist", async () => {
    prismaMock.patient.findUnique.mockResolvedValue(null);
    const req = makeReq(PATIENT_USER);
    const res = makeRes();

    const result = await assertPatientOwnsResource(req, res, "pat-missing");

    expect(result).toBe(false);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      data: null,
      error: "Forbidden",
    });
  });

  it("returns false and writes 403 when the patient is owned by a DIFFERENT user", async () => {
    // PATIENT-A (userId=user-pat-a) trying to read PATIENT-B's resource
    // (patient.userId=user-pat-b). This is the literal BOLA scenario.
    prismaMock.patient.findUnique.mockResolvedValue({ userId: "user-pat-b" });
    const req = makeReq(PATIENT_USER);
    const res = makeRes();

    const result = await assertPatientOwnsResource(req, res, "pat-b");

    expect(result).toBe(false);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      data: null,
      error: "Forbidden",
    });
  });

  it("queries Prisma with the supplied patientId and selects only userId (least-privilege select)", async () => {
    prismaMock.patient.findUnique.mockResolvedValue({ userId: "user-pat-a" });
    const req = makeReq(PATIENT_USER);
    const res = makeRes();

    await assertPatientOwnsResource(req, res, "pat-a");

    expect(prismaMock.patient.findUnique).toHaveBeenCalledTimes(1);
    expect(prismaMock.patient.findUnique).toHaveBeenCalledWith({
      where: { id: "pat-a" },
      select: { userId: true },
    });
  });

  it("rejects when patient.userId is null (data inconsistency safe-default)", async () => {
    prismaMock.patient.findUnique.mockResolvedValue({ userId: null });
    const req = makeReq(PATIENT_USER);
    const res = makeRes();

    const result = await assertPatientOwnsResource(req, res, "pat-orphan");

    expect(result).toBe(false);
    expect(res.status).toHaveBeenCalledWith(403);
  });
});

// ─── PATIENT + own resource — happy path ──────────────────────────────────

describe("assertPatientOwnsResource — PATIENT own resource (happy path)", () => {
  it("returns true when the patient's userId matches req.user.userId", async () => {
    prismaMock.patient.findUnique.mockResolvedValue({ userId: "user-pat-a" });
    const req = makeReq(PATIENT_USER);
    const res = makeRes();

    const result = await assertPatientOwnsResource(req, res, "pat-a");

    expect(result).toBe(true);
  });

  it("does NOT write a response on the happy path (caller controls 200 envelope)", async () => {
    prismaMock.patient.findUnique.mockResolvedValue({ userId: "user-pat-a" });
    const req = makeReq(PATIENT_USER);
    const res = makeRes();

    await assertPatientOwnsResource(req, res, "pat-a");

    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });
});

// ─── Response envelope contract ───────────────────────────────────────────

describe("assertPatientOwnsResource — response envelope contract", () => {
  it("every rejection branch writes the {success:false, data:null, error} envelope", async () => {
    // 401 branch
    {
      const res = makeRes();
      await assertPatientOwnsResource(makeReq(undefined), res, "pat-1");
      const body = res.json.mock.calls[0][0];
      expect(body).toHaveProperty("success", false);
      expect(body).toHaveProperty("data", null);
      expect(body).toHaveProperty("error");
      expect(typeof body.error).toBe("string");
    }
    // 403 — null patientId branch
    {
      const res = makeRes();
      await assertPatientOwnsResource(makeReq(PATIENT_USER), res, null);
      const body = res.json.mock.calls[0][0];
      expect(body).toMatchObject({ success: false, data: null });
      expect(typeof body.error).toBe("string");
    }
    // 403 — cross-patient branch
    {
      prismaMock.patient.findUnique.mockResolvedValue({ userId: "user-other" });
      const res = makeRes();
      await assertPatientOwnsResource(makeReq(PATIENT_USER), res, "pat-other");
      const body = res.json.mock.calls[0][0];
      expect(body).toMatchObject({ success: false, data: null });
      expect(typeof body.error).toBe("string");
    }
  });
});
