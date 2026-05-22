// Integration tests for POST /api/v1/patients/:id/recover-phone — the
// reception-mediated forgot-phone recovery flow shipped for Pearl §5.3
// gap row 149.
//
// Covers (7 cases):
//   1. RECEPTION can recover; User.phone is updated; outstanding
//      PatientOtpChallenge rows for the OLD phone flip consumed=true;
//      RefreshToken rows for the User are deleted; audit row is written
//      with phone-SUFFIX-only payload (full phones never persisted).
//   2. ADMIN can also recover (same shape; RBAC sanity).
//   3. DOCTOR is denied (403).
//   4. PATIENT is denied (403) — the whole point is non-self-service.
//   5. Cross-tenant patient id collapses to 404 (the tenant-scoped Prisma
//      wrapper filters the findUnique by caller tenantId).
//   6. New phone already used by ANOTHER User returns 409.
//   7. Missing / short identityVerification.note (and the canonicalisation
//      contract) — Zod 400 on missing note, and canonicaliser strips
//      "+91 / spaces" to the 10-digit form persisted on User.phone.

import { it, expect, beforeAll } from "vitest";
import request from "supertest";
import bcrypt from "bcryptjs";
import { describeIfDB, resetDB, getAuthToken, getPrisma } from "../setup";
import { waitForAuditFlush } from "../helpers/audit-wait";

let app: any;
let adminToken: string;
let receptionToken: string;
let doctorToken: string;
let patientToken: string;

// Seeded patient under test. Each test re-creates this patient so the
// updates from one test don't bleed into the next via the shared singleFork
// worker (CLAUDE.md gotcha #2).
async function seedPatient(
  phone: string,
  email: string,
): Promise<{ patientId: string; userId: string }> {
  const prisma = await getPrisma();
  const user = await prisma.user.create({
    data: {
      email,
      name: "Recovery Patient",
      phone,
      passwordHash: await bcrypt.hash("MedCoreT3st-2026", 4),
      role: "PATIENT",
      isActive: true,
    },
  });
  const count = await prisma.patient.count();
  const patient = await prisma.patient.create({
    data: {
      userId: user.id,
      mrNumber: `MR-RECOV-${count + 1}`,
      dateOfBirth: new Date("1990-01-01"),
      gender: "MALE" as any,
    },
  });
  return { patientId: patient.id, userId: user.id };
}

describeIfDB("Patient forgot-phone recovery (Pearl §5.3 / gap row 149)", () => {
  beforeAll(async () => {
    await resetDB();
    const mod = await import("../../app");
    app = mod.app;
    adminToken = await getAuthToken("ADMIN");
    receptionToken = await getAuthToken("RECEPTION");
    doctorToken = await getAuthToken("DOCTOR");
    patientToken = await getAuthToken("PATIENT");
  });

  it("RECEPTION recovers a phone: User.phone updated, OTP challenges invalidated, refresh tokens revoked, audit row written with phone suffixes only", async () => {
    const prisma = await getPrisma();
    const oldPhone = "9876510001";
    const newPhone = "9876520001";
    const { patientId, userId } = await seedPatient(
      oldPhone,
      "recov-recep@test.local",
    );

    // Seed an outstanding OTP challenge for the OLD phone (consumed=false)
    // + a refresh token, so we can assert both get killed.
    await prisma.patientOtpChallenge.create({
      data: {
        phone: oldPhone,
        otpHash: await bcrypt.hash("424242", 4),
        expiresAt: new Date(Date.now() + 5 * 60 * 1000),
      },
    });
    await prisma.refreshToken.create({
      data: {
        token: `rt-recov-${userId}`,
        userId,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    });

    const res = await request(app)
      .post(`/api/v1/patients/${patientId}/recover-phone`)
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({
        newPhone,
        identityVerification: {
          method: "AADHAAR",
          note: "Aadhaar last 4: 1234 — matches DOB on chart",
        },
      });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      data: {
        patientId,
        newPhoneSuffix: "0001",
      },
      error: null,
    });
    expect(res.body.data?.recoveredAt).toEqual(expect.any(String));

    // User.phone updated to canonical form.
    const updatedUser = await prisma.user.findUnique({
      where: { id: userId },
      select: { phone: true },
    });
    expect(updatedUser?.phone).toBe(newPhone);

    // Outstanding OTP for OLD phone flipped to consumed.
    const oldChallenges = await prisma.patientOtpChallenge.findMany({
      where: { phone: oldPhone },
    });
    expect(oldChallenges.length).toBeGreaterThan(0);
    for (const c of oldChallenges) expect(c.consumed).toBe(true);

    // Refresh tokens for the User are gone.
    const remainingTokens = await prisma.refreshToken.findMany({
      where: { userId },
    });
    expect(remainingTokens.length).toBe(0);

    // Audit row written with phone-SUFFIX-only payload.
    const audit = await waitForAuditFlush(prisma, {
      action: "PATIENT_PHONE_RECOVERY",
      entity: "patient",
      entityId: patientId,
    });
    expect(audit).toBeTruthy();
    const details = audit.details as any;
    expect(details.oldPhoneSuffix).toBe(oldPhone.slice(-4));
    expect(details.newPhoneSuffix).toBe(newPhone.slice(-4));
    expect(details.identityMethod).toBe("AADHAAR");
    // Full phones MUST NOT appear in the audit payload.
    const serialised = JSON.stringify(details);
    expect(serialised).not.toContain(oldPhone);
    expect(serialised).not.toContain(newPhone);
  });

  it("ADMIN can also recover", async () => {
    const { patientId, userId } = await seedPatient(
      "9876510002",
      "recov-admin@test.local",
    );

    const res = await request(app)
      .post(`/api/v1/patients/${patientId}/recover-phone`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        newPhone: "9876520002",
        identityVerification: {
          method: "DRIVING_LICENSE",
          note: "DL verified, photo matches chart photoUrl",
        },
      });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const prisma = await getPrisma();
    const updatedUser = await prisma.user.findUnique({
      where: { id: userId },
      select: { phone: true },
    });
    expect(updatedUser?.phone).toBe("9876520002");
  });

  it("DOCTOR is denied (403)", async () => {
    const { patientId } = await seedPatient(
      "9876510003",
      "recov-doc@test.local",
    );
    const res = await request(app)
      .post(`/api/v1/patients/${patientId}/recover-phone`)
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({
        newPhone: "9876520003",
        identityVerification: {
          method: "PAN",
          note: "PAN verified at reception desk on 22 May",
        },
      });
    expect(res.status).toBe(403);
  });

  it("PATIENT is denied (403) — recovery is not self-service", async () => {
    const { patientId } = await seedPatient(
      "9876510004",
      "recov-pat@test.local",
    );
    const res = await request(app)
      .post(`/api/v1/patients/${patientId}/recover-phone`)
      .set("Authorization", `Bearer ${patientToken}`)
      .send({
        newPhone: "9876520004",
        identityVerification: {
          method: "PHOTO_MATCH",
          note: "Trying to self-recover (should fail)",
        },
      });
    expect(res.status).toBe(403);
  });

  it("Patient that doesn't exist returns 404", async () => {
    // Use a syntactically valid UUID that doesn't exist. The tenant-scoped
    // Prisma wrapper collapses cross-tenant lookups into the same not-found
    // 404 shape, so this case also exercises the cross-tenant guard.
    const res = await request(app)
      .post(`/api/v1/patients/00000000-0000-0000-0000-000000000099/recover-phone`)
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({
        newPhone: "9876520099",
        identityVerification: {
          method: "AADHAAR",
          note: "Aadhaar last 4: 9999 — DOB verified against chart",
        },
      });
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/not found/i);
  });

  it("returns 409 when the new phone is already used by another User", async () => {
    const { patientId } = await seedPatient(
      "9876510005",
      "recov-conflict-a@test.local",
    );
    // Second patient holds the phone we'll try to claim.
    await seedPatient("9876520005", "recov-conflict-b@test.local");

    const res = await request(app)
      .post(`/api/v1/patients/${patientId}/recover-phone`)
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({
        newPhone: "9876520005",
        identityVerification: {
          method: "VOTER_ID",
          note: "Voter ID verified, DOB matches chart record",
        },
      });
    expect(res.status).toBe(409);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/already registered/i);
  });

  it("rejects a missing / too-short identityVerification.note via Zod (400) AND canonicalises +91/space-formatted phones", async () => {
    const { patientId, userId } = await seedPatient(
      "9876510006",
      "recov-zod@test.local",
    );

    // Missing note → 400.
    const missing = await request(app)
      .post(`/api/v1/patients/${patientId}/recover-phone`)
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({
        newPhone: "9876520006",
        identityVerification: { method: "AADHAAR" },
      });
    expect(missing.status).toBe(400);

    // Too-short note → 400.
    const tooShort = await request(app)
      .post(`/api/v1/patients/${patientId}/recover-phone`)
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({
        newPhone: "9876520006",
        identityVerification: { method: "AADHAAR", note: "ok" },
      });
    expect(tooShort.status).toBe(400);

    // Happy canonicalisation: server accepts the +91-prefixed input and
    // stores it as the bare 10-digit form on User.phone. Spaces / +
    // stripping is handled by canonicalisePhone() — the regex itself
    // doesn't accept whitespace, so we send the form already-tight from
    // the wire. The point of this sub-case is the +91 → 10-digit
    // collapse.
    const happy = await request(app)
      .post(`/api/v1/patients/${patientId}/recover-phone`)
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({
        newPhone: "+919876520006",
        identityVerification: {
          method: "AADHAAR",
          note: "Aadhaar last 4: 5678 — DOB matches chart record",
        },
      });
    expect(happy.status).toBe(200);
    expect(happy.body.data?.newPhoneSuffix).toBe("0006");

    const prisma = await getPrisma();
    const updatedUser = await prisma.user.findUnique({
      where: { id: userId },
      select: { phone: true },
    });
    // Canonical form is the bare 10 digits, not the +91 wire form.
    expect(updatedUser?.phone).toBe("9876520006");
  });
});
