// Cross-patient BOLA regression suite — doctors, issue #511.
//
// What this file covers
// ---------------------
// `apps/api/src/routes/doctors.ts` was swept under the issue #511
// expanded audit criterion + the `3beeeaf` "eager-include leak in
// catalog endpoint" lens. PATIENTs need to read the doctor list for
// booking — that's intentional surface — but the previous projection
// returned each doctor's `user.email` and `user.phone` along with
// professional fields. Those are HR-class PII a patient does not need
// to pick a slot. The fix branches the projection by caller role:
// PATIENT → `id + name + isActive` only; staff (ADMIN, DOCTOR,
// RECEPTION, NURSE, PHARMACIST) keeps the full directory shape.
//
// Per cited route the suite asserts:
//   1. PATIENT GET /doctors → 200, but `email` + `phone` absent on every
//      row (the bug — info disclosure to PATIENT)
//   2. ADMIN GET /doctors → 200, `email` + `phone` present (staff
//      directory unbroken)

import { it, expect, beforeAll } from "vitest";
import request from "supertest";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { describeIfDB, resetDB, getAuthToken, getPrisma } from "../setup";
import { createDoctorFixture } from "../factories";

let app: any;
let adminToken: string;
let patientAToken: string;

async function createPatientWithToken(
  label: string
): Promise<{ patientId: string; userId: string; token: string }> {
  const prisma = await getPrisma();
  const email = `patient_doctors_${label}_${Date.now()}_${Math.random()
    .toString(36)
    .slice(2, 6)}@test.local`;
  const user = await prisma.user.create({
    data: {
      email,
      name: `Patient ${label}`,
      phone: "9000000006",
      passwordHash: await bcrypt.hash("MedCoreT3st-2026", 4),
      role: "PATIENT" as any,
    },
  });
  const patient = await prisma.patient.create({
    data: {
      userId: user.id,
      mrNumber: `MR-DOC-${label}-${Date.now()}`,
      dateOfBirth: new Date("1990-01-01"),
      gender: "MALE" as any,
    },
  });
  const token = jwt.sign(
    { userId: user.id, email, role: "PATIENT" },
    process.env.JWT_SECRET || "test-jwt-secret-do-not-use-in-prod",
    { expiresIn: "1h" }
  );
  return { patientId: patient.id, userId: user.id, token };
}

describeIfDB("Cross-patient BOLA — doctors (issue #511)", () => {
  beforeAll(async () => {
    await resetDB();
    adminToken = await getAuthToken("ADMIN");
    const a = await createPatientWithToken("A");
    patientAToken = a.token;

    // Seed a doctor with email + phone so we have something to strip
    await createDoctorFixture({ name: "Dr. Sample" });

    const mod = await import("../../app");
    app = mod.app;
  });

  // ──────────────────────────────────────────────────────────
  // GET /doctors — catalog projection-by-role
  // ──────────────────────────────────────────────────────────

  it("doctors GET /: PATIENT receives row WITHOUT email/phone (PII stripped)", async () => {
    const res = await request(app)
      .get(`/api/v1/doctors`)
      .set("Authorization", `Bearer ${patientAToken}`);
    expect(res.status).toBe(200);
    const rows = res.body?.data ?? [];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      // Doctor row's nested user must not leak HR-class PII to PATIENT callers.
      expect(row.user?.email).toBeUndefined();
      expect(row.user?.phone).toBeUndefined();
      // But name/id stay so the picker can render
      expect(typeof row.user?.name).toBe("string");
      expect(typeof row.user?.id).toBe("string");
    }
  });

  it("doctors GET /: ADMIN keeps email + phone (directory unbroken)", async () => {
    const res = await request(app)
      .get(`/api/v1/doctors`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const rows = res.body?.data ?? [];
    expect(rows.length).toBeGreaterThan(0);
    // At least one row should expose email + phone for ADMIN
    const hasFull = rows.some(
      (r: any) =>
        typeof r.user?.email === "string" && typeof r.user?.phone === "string"
    );
    expect(hasFull).toBe(true);
  });
});
