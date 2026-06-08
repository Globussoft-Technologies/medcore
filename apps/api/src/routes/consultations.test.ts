/**
 * Pearl ERP Stage 1 §2.1.3 — vitest unit coverage for the manual
 * SOAP-consult backend (apps/api/src/routes/consultations.ts).
 *
 * What this locks in:
 *   - GET /by-appointment/:appointmentId
 *       * 404 when the appointment doesn't exist
 *       * lazy-creates a DRAFT row for staff (DOCTOR/NURSE/ADMIN)
 *       * returns the existing row when one is already there
 *       * PATIENT self-scope: own appointment + SIGNED → 200
 *       * PATIENT self-scope: someone else's appointment → 403
 *       * PATIENT: no consultation row → 404 (never lazy-creates)
 *       * PATIENT: row exists but DRAFT → 404 ("not yet finalized")
 *
 *   - GET /by-patient/:patientId
 *       * Staff: returns all rows (DRAFT + SIGNED)
 *       * PATIENT self-scope: own id + filter to SIGNED-only
 *       * PATIENT cross-patient access → 403
 *
 *   - PATCH /:id
 *       * 404 when consultation missing
 *       * 409 when already SIGNED (no edits after sign)
 *       * Validates icd10Codes / snomedCodes JSON shape (400 on bad)
 *       * Happy-path persist of SOAP sub-fields + code arrays
 *
 *   - POST /:id/sign
 *       * Atomic: consultation → SIGNED AND appointment → COMPLETED
 *       * Idempotent: signing an already-SIGNED row is a no-op 200
 *       * Skips appointment-advance when appointment is already
 *         in a terminal state (CANCELLED / NO_SHOW / COMPLETED)
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";

const { prismaMock } = vi.hoisted(() => {
  const base: any = {
    appointment: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    patient: {
      findUnique: vi.fn(),
    },
    consultation: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    auditLog: { create: vi.fn(async () => ({ id: "al-1" })) },
    systemConfig: { findUnique: vi.fn(async () => null) },
    $transaction: vi.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
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

import { consultationsRouter } from "./consultations";
import { errorHandler } from "../middleware/error";

function buildApp() {
  process.env.JWT_SECRET = "test-secret";
  const app = express();
  app.use(express.json());
  app.use("/api/v1/consultations", consultationsRouter);
  app.use(errorHandler);
  return app;
}

function token(role: string, userId = "u-doc"): string {
  return jwt.sign(
    { userId, email: `${role.toLowerCase()}@test.local`, role },
    "test-secret",
  );
}

const APT_ID = "550e8400-e29b-41d4-a716-446655440001";
const DOC_ID = "550e8400-e29b-41d4-a716-446655440002";
const PAT_ID = "550e8400-e29b-41d4-a716-446655440003";
const CON_ID = "550e8400-e29b-41d4-a716-446655440004";

function resetAllMocks() {
  prismaMock.appointment.findUnique.mockReset();
  prismaMock.appointment.update.mockReset();
  prismaMock.patient.findUnique.mockReset();
  prismaMock.consultation.findUnique.mockReset();
  prismaMock.consultation.findMany.mockReset();
  prismaMock.consultation.create.mockReset();
  prismaMock.consultation.update.mockReset();
  prismaMock.$transaction.mockReset();
  // Default: $transaction passes through (await each op in array).
  prismaMock.$transaction.mockImplementation(async (ops: Promise<unknown>[]) =>
    Promise.all(ops),
  );
}

// ─── GET /by-appointment/:appointmentId ───────────────────────────────
describe("GET /api/v1/consultations/by-appointment/:appointmentId", () => {
  beforeEach(resetAllMocks);

  it("returns 404 when the appointment does not exist", async () => {
    prismaMock.appointment.findUnique.mockResolvedValueOnce(null);

    const res = await request(buildApp())
      .get(`/api/v1/consultations/by-appointment/${APT_ID}`)
      .set("Authorization", `Bearer ${token("DOCTOR")}`);

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/Appointment not found/);
  });

  it("lazy-creates a DRAFT consultation for staff when none exists", async () => {
    prismaMock.appointment.findUnique.mockResolvedValueOnce({
      id: APT_ID,
      doctorId: DOC_ID,
      tenantId: null,
      patientId: PAT_ID,
    });
    prismaMock.consultation.findUnique.mockResolvedValueOnce(null);
    prismaMock.consultation.create.mockResolvedValueOnce({
      id: CON_ID,
      appointmentId: APT_ID,
      doctorId: DOC_ID,
      status: "DRAFT",
    });

    const res = await request(buildApp())
      .get(`/api/v1/consultations/by-appointment/${APT_ID}`)
      .set("Authorization", `Bearer ${token("DOCTOR")}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toMatchObject({
      id: CON_ID,
      status: "DRAFT",
    });
    expect(prismaMock.consultation.create).toHaveBeenCalledWith({
      data: {
        appointmentId: APT_ID,
        doctorId: DOC_ID,
        tenantId: null,
      },
    });
  });

  it("returns the existing consultation without creating a new one", async () => {
    prismaMock.appointment.findUnique.mockResolvedValueOnce({
      id: APT_ID,
      doctorId: DOC_ID,
      tenantId: null,
      patientId: PAT_ID,
    });
    prismaMock.consultation.findUnique.mockResolvedValueOnce({
      id: CON_ID,
      appointmentId: APT_ID,
      doctorId: DOC_ID,
      status: "DRAFT",
      subjective: "fever",
    });

    const res = await request(buildApp())
      .get(`/api/v1/consultations/by-appointment/${APT_ID}`)
      .set("Authorization", `Bearer ${token("DOCTOR")}`);

    expect(res.status).toBe(200);
    expect(res.body.data.subjective).toBe("fever");
    expect(prismaMock.consultation.create).not.toHaveBeenCalled();
  });

  it("PATIENT: own appointment + SIGNED row → 200", async () => {
    prismaMock.appointment.findUnique.mockResolvedValueOnce({
      id: APT_ID,
      doctorId: DOC_ID,
      tenantId: null,
      patientId: PAT_ID,
    });
    prismaMock.patient.findUnique.mockResolvedValueOnce({ id: PAT_ID });
    prismaMock.consultation.findUnique.mockResolvedValueOnce({
      id: CON_ID,
      appointmentId: APT_ID,
      status: "SIGNED",
    });

    const res = await request(buildApp())
      .get(`/api/v1/consultations/by-appointment/${APT_ID}`)
      .set("Authorization", `Bearer ${token("PATIENT", "u-pat")}`);

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("SIGNED");
  });

  it("PATIENT: someone else's appointment → 403", async () => {
    prismaMock.appointment.findUnique.mockResolvedValueOnce({
      id: APT_ID,
      doctorId: DOC_ID,
      tenantId: null,
      patientId: PAT_ID,
    });
    // Caller's own patient row has a DIFFERENT id.
    prismaMock.patient.findUnique.mockResolvedValueOnce({ id: "other-pat" });

    const res = await request(buildApp())
      .get(`/api/v1/consultations/by-appointment/${APT_ID}`)
      .set("Authorization", `Bearer ${token("PATIENT", "u-pat")}`);

    expect(res.status).toBe(403);
  });

  it("PATIENT: no consultation row → 404 (never lazy-creates)", async () => {
    prismaMock.appointment.findUnique.mockResolvedValueOnce({
      id: APT_ID,
      doctorId: DOC_ID,
      tenantId: null,
      patientId: PAT_ID,
    });
    prismaMock.patient.findUnique.mockResolvedValueOnce({ id: PAT_ID });
    prismaMock.consultation.findUnique.mockResolvedValueOnce(null);

    const res = await request(buildApp())
      .get(`/api/v1/consultations/by-appointment/${APT_ID}`)
      .set("Authorization", `Bearer ${token("PATIENT", "u-pat")}`);

    expect(res.status).toBe(404);
    expect(prismaMock.consultation.create).not.toHaveBeenCalled();
  });

  it("PATIENT: row exists but DRAFT → 404 (not yet finalized)", async () => {
    prismaMock.appointment.findUnique.mockResolvedValueOnce({
      id: APT_ID,
      doctorId: DOC_ID,
      tenantId: null,
      patientId: PAT_ID,
    });
    prismaMock.patient.findUnique.mockResolvedValueOnce({ id: PAT_ID });
    prismaMock.consultation.findUnique.mockResolvedValueOnce({
      id: CON_ID,
      appointmentId: APT_ID,
      status: "DRAFT",
    });

    const res = await request(buildApp())
      .get(`/api/v1/consultations/by-appointment/${APT_ID}`)
      .set("Authorization", `Bearer ${token("PATIENT", "u-pat")}`);

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not yet finalized/);
  });
});

// ─── GET /by-patient/:patientId ───────────────────────────────────────
describe("GET /api/v1/consultations/by-patient/:patientId", () => {
  beforeEach(resetAllMocks);

  it("staff (DOCTOR) sees both DRAFT and SIGNED rows", async () => {
    prismaMock.consultation.findMany.mockResolvedValueOnce([
      { id: "c-1", status: "SIGNED" },
      { id: "c-2", status: "DRAFT" },
    ]);

    const res = await request(buildApp())
      .get(`/api/v1/consultations/by-patient/${PAT_ID}`)
      .set("Authorization", `Bearer ${token("DOCTOR")}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    // Staff: where clause must NOT include status filter.
    const call = prismaMock.consultation.findMany.mock.calls[0]?.[0] as any;
    expect(call.where.status).toBeUndefined();
  });

  it("PATIENT sees only SIGNED rows when fetching their own history", async () => {
    prismaMock.patient.findUnique.mockResolvedValueOnce({ id: PAT_ID });
    prismaMock.consultation.findMany.mockResolvedValueOnce([
      { id: "c-1", status: "SIGNED" },
    ]);

    const res = await request(buildApp())
      .get(`/api/v1/consultations/by-patient/${PAT_ID}`)
      .set("Authorization", `Bearer ${token("PATIENT", "u-pat")}`);

    expect(res.status).toBe(200);
    const call = prismaMock.consultation.findMany.mock.calls[0]?.[0] as any;
    expect(call.where.status).toBe("SIGNED");
  });

  it("PATIENT cross-patient access → 403", async () => {
    // Caller's own patient row has a different id from the URL param.
    prismaMock.patient.findUnique.mockResolvedValueOnce({ id: "other-pat" });

    const res = await request(buildApp())
      .get(`/api/v1/consultations/by-patient/${PAT_ID}`)
      .set("Authorization", `Bearer ${token("PATIENT", "u-pat")}`);

    expect(res.status).toBe(403);
    expect(prismaMock.consultation.findMany).not.toHaveBeenCalled();
  });
});

// ─── PATCH /:id ───────────────────────────────────────────────────────
describe("PATCH /api/v1/consultations/:id", () => {
  beforeEach(resetAllMocks);

  it("returns 404 when the consultation does not exist", async () => {
    prismaMock.consultation.findUnique.mockResolvedValueOnce(null);

    const res = await request(buildApp())
      .patch(`/api/v1/consultations/${CON_ID}`)
      .set("Authorization", `Bearer ${token("DOCTOR")}`)
      .send({ subjective: "fever" });

    expect(res.status).toBe(404);
  });

  it("returns 409 when the consultation is already SIGNED", async () => {
    prismaMock.consultation.findUnique.mockResolvedValueOnce({
      id: CON_ID,
      status: "SIGNED",
    });

    const res = await request(buildApp())
      .patch(`/api/v1/consultations/${CON_ID}`)
      .set("Authorization", `Bearer ${token("DOCTOR")}`)
      .send({ subjective: "fever" });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/signed/i);
    expect(prismaMock.consultation.update).not.toHaveBeenCalled();
  });

  it("rejects (400) icd10Codes that isn't an array of {code, description}", async () => {
    prismaMock.consultation.findUnique.mockResolvedValueOnce({
      id: CON_ID,
      status: "DRAFT",
    });

    const res = await request(buildApp())
      .patch(`/api/v1/consultations/${CON_ID}`)
      .set("Authorization", `Bearer ${token("DOCTOR")}`)
      .send({ icd10Codes: [{ code: "I10" }] }); // missing description

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/icd10Codes must be an array/);
  });

  it("persists SOAP fields + diagnosis code arrays", async () => {
    prismaMock.consultation.findUnique.mockResolvedValueOnce({
      id: CON_ID,
      status: "DRAFT",
    });
    prismaMock.consultation.update.mockResolvedValueOnce({
      id: CON_ID,
      subjective: "fever 3 days",
      icd10Codes: [{ code: "I10", description: "Hypertension" }],
      status: "DRAFT",
    });

    const res = await request(buildApp())
      .patch(`/api/v1/consultations/${CON_ID}`)
      .set("Authorization", `Bearer ${token("DOCTOR")}`)
      .send({
        subjective: "fever 3 days",
        icd10Codes: [{ code: "I10", description: "Hypertension" }],
      });

    expect(res.status).toBe(200);
    expect(prismaMock.consultation.update).toHaveBeenCalledWith({
      where: { id: CON_ID },
      data: {
        subjective: "fever 3 days",
        icd10Codes: [{ code: "I10", description: "Hypertension" }],
      },
    });
  });
});

// ─── POST /:id/sign ───────────────────────────────────────────────────
describe("POST /api/v1/consultations/:id/sign", () => {
  beforeEach(resetAllMocks);

  it("atomically signs the consultation AND completes the appointment", async () => {
    prismaMock.consultation.findUnique.mockResolvedValueOnce({
      id: CON_ID,
      status: "DRAFT",
      appointmentId: APT_ID,
      appointment: { status: "IN_CONSULTATION" },
    });
    prismaMock.consultation.update.mockReturnValue(
      Promise.resolve({ id: CON_ID, status: "SIGNED", signedAt: new Date() }),
    );
    prismaMock.appointment.update.mockReturnValue(
      Promise.resolve({ id: APT_ID, status: "COMPLETED" }),
    );

    const res = await request(buildApp())
      .post(`/api/v1/consultations/${CON_ID}/sign`)
      .set("Authorization", `Bearer ${token("DOCTOR")}`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("SIGNED");
    expect(prismaMock.$transaction).toHaveBeenCalled();
    // BOTH writes go through the same transaction call.
    expect(prismaMock.consultation.update).toHaveBeenCalledWith({
      where: { id: CON_ID },
      data: expect.objectContaining({ status: "SIGNED" }),
    });
    expect(prismaMock.appointment.update).toHaveBeenCalledWith({
      where: { id: APT_ID },
      data: expect.objectContaining({
        status: "COMPLETED",
        consultationEndedAt: expect.any(Date),
      }),
    });
  });

  it("does NOT touch the appointment when it is already in a terminal state", async () => {
    prismaMock.consultation.findUnique.mockResolvedValueOnce({
      id: CON_ID,
      status: "DRAFT",
      appointmentId: APT_ID,
      appointment: { status: "CANCELLED" },
    });
    prismaMock.consultation.update.mockReturnValue(
      Promise.resolve({ id: CON_ID, status: "SIGNED" }),
    );

    const res = await request(buildApp())
      .post(`/api/v1/consultations/${CON_ID}/sign`)
      .set("Authorization", `Bearer ${token("DOCTOR")}`)
      .send({});

    expect(res.status).toBe(200);
    expect(prismaMock.appointment.update).not.toHaveBeenCalled();
  });

  it("is idempotent on a re-sign (already SIGNED → 200 with the existing row)", async () => {
    prismaMock.consultation.findUnique
      // First read (with appointment join) shows already SIGNED.
      .mockResolvedValueOnce({
        id: CON_ID,
        status: "SIGNED",
        appointmentId: APT_ID,
        appointment: { status: "COMPLETED" },
      })
      // Re-read the full row to return in the body.
      .mockResolvedValueOnce({
        id: CON_ID,
        status: "SIGNED",
        signedAt: new Date(),
      });

    const res = await request(buildApp())
      .post(`/api/v1/consultations/${CON_ID}/sign`)
      .set("Authorization", `Bearer ${token("DOCTOR")}`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("SIGNED");
    expect(prismaMock.consultation.update).not.toHaveBeenCalled();
    expect(prismaMock.appointment.update).not.toHaveBeenCalled();
  });

  it("returns 404 when the consultation does not exist", async () => {
    prismaMock.consultation.findUnique.mockResolvedValueOnce(null);

    const res = await request(buildApp())
      .post(`/api/v1/consultations/${CON_ID}/sign`)
      .set("Authorization", `Bearer ${token("DOCTOR")}`)
      .send({});

    expect(res.status).toBe(404);
  });
});
