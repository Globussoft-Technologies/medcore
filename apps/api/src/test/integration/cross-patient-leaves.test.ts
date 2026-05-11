// Cross-patient BOLA regression suite — leaves, issue #511.
//
// What this file covers
// ---------------------
// `apps/api/src/routes/leaves.ts` is staff-self-service (DOCTOR/NURSE/etc.
// apply for own leaves; ADMIN approves). LeaveRequest.userId references a
// User row, NOT a Patient row, so the canonical assertPatientOwnsResource
// helper does not apply — ownership is User-vs-User, mirroring the
// `PATCH /:id/cancel` pattern that lived in this file.
//
// Surfaced gap (verdict A — patched in commit alongside this file):
//   - GET /api/v1/leaves/:id/letter — previously had NO role gate AND NO
//     ownership check, leaking a staff member's leave HTML letter (name,
//     role, dates, reason, rejectionReason) to any authed caller incl.
//     PATIENT. Patched to "owner OR ADMIN" identical to /cancel.
//
// All other handlers were verified-safe at audit time:
//   - GET / and GET /my self-scope the Prisma `where: { userId }` for non-ADMIN
//   - GET /pending, PATCH /:id/approve, PATCH /:id/reject, POST /balance,
//     GET /calendar all carry `authorize(...)` excluding PATIENT
//   - PATCH /:id/cancel does inline `existing.userId !== req.user.userId`
//   - GET /balance self-scopes for non-ADMIN
//
// Per cited route the suite asserts up to three cases:
//   1. PATIENT-A's token GETs the staff leave letter → 403 (the bug)
//   2. The owning DOCTOR's token GETs own leave letter → 200 (positive
//      control, ownership respected)
//   3. ADMIN's token GETs the same leave letter → 200 (staff control)

import { it, expect, beforeAll } from "vitest";
import request from "supertest";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { describeIfDB, resetDB, getAuthToken, getPrisma } from "../setup";

let app: any;
let adminToken: string;
let doctorToken: string;
let patientAToken: string;
let leaveRequestId: string;
let doctorUserId: string;

async function createPatientWithToken(
  label: string
): Promise<{ patientId: string; userId: string; token: string }> {
  const prisma = await getPrisma();
  const email = `patient_leaves_${label}_${Date.now()}_${Math.random()
    .toString(36)
    .slice(2, 6)}@test.local`;
  const user = await prisma.user.create({
    data: {
      email,
      name: `Patient ${label}`,
      phone: "9000000005",
      passwordHash: await bcrypt.hash("MedCoreT3st-2026", 4),
      role: "PATIENT" as any,
    },
  });
  const patient = await prisma.patient.create({
    data: {
      userId: user.id,
      mrNumber: `MR-LV-${label}-${Date.now()}`,
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

describeIfDB("Cross-patient BOLA — leaves (issue #511)", () => {
  beforeAll(async () => {
    await resetDB();
    const prisma = await getPrisma();
    adminToken = await getAuthToken("ADMIN");
    doctorToken = await getAuthToken("DOCTOR");

    // The DOCTOR seeded by getAuthToken is the leave's owner — fetch the row
    // so we can assert "owner can read own letter" later.
    const doctorUser = await prisma.user.findFirst({
      where: { role: "DOCTOR" as any },
    });
    if (!doctorUser) throw new Error("DOCTOR seed missing");
    doctorUserId = doctorUser.id;

    const a = await createPatientWithToken("A");
    patientAToken = a.token;

    // Seed a leave request owned by the DOCTOR.
    const leave = await prisma.leaveRequest.create({
      data: {
        userId: doctorUserId,
        type: "CASUAL",
        fromDate: new Date("2026-06-01T00:00:00.000Z"),
        toDate: new Date("2026-06-03T00:00:00.000Z"),
        totalDays: 3,
        reason: "Family event",
        status: "APPROVED",
        approvedBy: doctorUserId,
        approvedAt: new Date(),
      },
    });
    leaveRequestId = leave.id;

    const mod = await import("../../app");
    app = mod.app;
  });

  // ──────────────────────────────────────────────────────────
  // GET /api/v1/leaves/:id/letter — was BOLA, now ownership-gated
  // ──────────────────────────────────────────────────────────

  it("leaves/:id/letter: PATIENT cannot fetch staff leave letter (403)", async () => {
    const res = await request(app)
      .get(`/api/v1/leaves/${leaveRequestId}/letter`)
      .set("Authorization", `Bearer ${patientAToken}`);
    expect(res.status).toBe(403);
  });

  it("leaves/:id/letter: owning DOCTOR can fetch own leave letter (200)", async () => {
    const res = await request(app)
      .get(`/api/v1/leaves/${leaveRequestId}/letter`)
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
  });

  it("leaves/:id/letter: ADMIN can fetch any leave letter (200, staff control)", async () => {
    const res = await request(app)
      .get(`/api/v1/leaves/${leaveRequestId}/letter`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
  });

  it("leaves/:id/letter: nonexistent id → 404", async () => {
    const res = await request(app)
      .get(`/api/v1/leaves/550e8400-e29b-41d4-a716-446655440000/letter`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
  });
});
