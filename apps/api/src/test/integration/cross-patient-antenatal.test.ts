// Cross-patient BOLA regression suite for antenatal handlers — issue #511.
//
// What this file covers
// ---------------------
// Issue #511 (HIGH, OWASP API1:2023 BOLA / CWE-285) is the post-#474
// audit sweep: 112 candidate `/:id`-shaped handlers across the API
// surface that were never gated by `authorize(...)` and did not call
// `assertPatientOwnsResource(...)`. This file closes the antenatal
// slice — six handlers in `apps/api/src/routes/antenatal.ts` that all
// expose pregnancy / delivery / postnatal PHI keyed by an ANC case id
// (or a partograph id, which transitively belongs to an ANC case).
//
// Why a separate file from cross-patient-rbac.test.ts
// ---------------------------------------------------
// The #511 sweep is being done by multiple agents in parallel (one per
// route file). Putting all agents' regression cases in the single
// existing `cross-patient-rbac.test.ts` would create constant merge
// collisions. Each agent owns its own `cross-patient-<area>.test.ts`
// file; the runner picks them all up via the same `*.test.ts` glob.
//
// Modules / handlers asserted
// ---------------------------
// - GET /api/v1/antenatal/cases/:id                    (BOLA: full ANC case)
// - GET /api/v1/antenatal/cases/:id/trimester          (BOLA: gestational status)
// - GET /api/v1/antenatal/cases/:id/ultrasound         (BOLA: USG history)
// - GET /api/v1/antenatal/partograph/:id               (BOLA: labour observations)
// - GET /api/v1/antenatal/cases/:id/postnatal-visits   (BOLA: postpartum + baby)
// - GET /api/v1/antenatal/cases/:id/birth-certificate  (BOLA: HTML certificate)
//
// Per cited route the suite asserts three cases:
//   1. PATIENT-A's token GETs PATIENT-B's resource → 403  (the bug)
//   2. PATIENT-A's token GETs PATIENT-A's own resource → 200  (positive control)
//   3. DOCTOR's token GETs the same resource → 200  (staff RBAC unbroken)
//
// Note on AntenatalCase.patientId uniqueness
// ------------------------------------------
// The Prisma schema enforces `AntenatalCase.patientId @unique` (one
// active ANC per patient). To make the three-case matrix work for each
// route we re-use a single ANC case per patient: one for PATIENT-A and
// one for PATIENT-B. Each handler test then re-targets those two cases
// rather than creating fresh ones.

import { it, expect, beforeAll } from "vitest";
import request from "supertest";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { describeIfDB, resetDB, getAuthToken, getPrisma } from "../setup";
import { createDoctorFixture } from "../factories";

let app: any;
let doctorToken: string;
let patientAToken: string;
let patientBToken: string;
let patientAId: string;
let patientBId: string;
let doctorId: string;
let ancCaseAId: string;
let ancCaseBId: string;
let partographAId: string;
let partographBId: string;

// Same helper as cross-patient-rbac.test.ts but forces FEMALE so the
// patient is eligible for an AntenatalCase row. Re-implemented locally
// to avoid coupling this file to the shared one.
async function createFemalePatientWithToken(
  label: string
): Promise<{ patientId: string; userId: string; token: string }> {
  const prisma = await getPrisma();
  const email = `patient_anc_${label}_${Date.now()}_${Math.random()
    .toString(36)
    .slice(2, 6)}@test.local`;
  const user = await prisma.user.create({
    data: {
      email,
      name: `Patient ${label}`,
      phone: "9000000000",
      passwordHash: await bcrypt.hash("MedCoreT3st-2026", 4),
      role: "PATIENT" as any,
    },
  });
  const patient = await prisma.patient.create({
    data: {
      userId: user.id,
      mrNumber: `MR-ANC-${label}-${Date.now()}`,
      dateOfBirth: new Date("1995-01-01"),
      gender: "FEMALE" as any,
    },
  });
  const token = jwt.sign(
    { userId: user.id, email, role: "PATIENT" },
    process.env.JWT_SECRET || "test-jwt-secret-do-not-use-in-prod",
    { expiresIn: "1h" }
  );
  return { patientId: patient.id, userId: user.id, token };
}

describeIfDB("Cross-patient antenatal BOLA (issue #511)", () => {
  beforeAll(async () => {
    await resetDB();
    doctorToken = await getAuthToken("DOCTOR");

    const a = await createFemalePatientWithToken("A");
    const b = await createFemalePatientWithToken("B");
    patientAToken = a.token;
    patientBToken = b.token;
    patientAId = a.patientId;
    patientBId = b.patientId;

    const doctor = await createDoctorFixture();
    doctorId = doctor.id;

    const prisma = await getPrisma();

    // Build one ANC case per patient. AntenatalCase.patientId is @unique
    // so we can't have multiple ANC cases per patient — these two rows
    // back every handler test below.
    const lmpA = new Date("2025-08-01T00:00:00.000Z");
    const lmpB = new Date("2025-09-01T00:00:00.000Z");
    const eddA = new Date(lmpA.getTime() + 280 * 24 * 60 * 60 * 1000);
    const eddB = new Date(lmpB.getTime() + 280 * 24 * 60 * 60 * 1000);
    const ancA = await prisma.antenatalCase.create({
      data: {
        caseNumber: `ANC-XP-A-${Date.now()}`,
        patientId: patientAId,
        doctorId,
        lmpDate: lmpA,
        eddDate: eddA,
        gravida: 1,
        parity: 0,
        // Pre-mark delivery so postnatal-visits + birth-certificate
        // handlers can be exercised without a 400/404 on the precondition.
        deliveredAt: new Date(),
        deliveryType: "NORMAL",
        babyGender: "FEMALE",
        babyWeight: 3.1,
      },
    });
    const ancB = await prisma.antenatalCase.create({
      data: {
        caseNumber: `ANC-XP-B-${Date.now()}`,
        patientId: patientBId,
        doctorId,
        lmpDate: lmpB,
        eddDate: eddB,
        gravida: 2,
        parity: 1,
        deliveredAt: new Date(),
        deliveryType: "NORMAL",
        babyGender: "MALE",
        babyWeight: 3.4,
      },
    });
    ancCaseAId = ancA.id;
    ancCaseBId = ancB.id;

    const partA = await prisma.partograph.create({
      data: {
        ancCaseId: ancCaseAId,
        observations: [] as never,
        performedBy: doctor.userId,
      },
    });
    const partB = await prisma.partograph.create({
      data: {
        ancCaseId: ancCaseBId,
        observations: [] as never,
        performedBy: doctor.userId,
      },
    });
    partographAId = partA.id;
    partographBId = partB.id;

    const mod = await import("../../app");
    app = mod.app;
  });

  // ───────────────────────────────────────────────────────
  // GET /antenatal/cases/:id
  // ───────────────────────────────────────────────────────

  it("ANC case: PATIENT-A cannot GET PATIENT-B's case (403)", async () => {
    const res = await request(app)
      .get(`/api/v1/antenatal/cases/${ancCaseBId}`)
      .set("Authorization", `Bearer ${patientAToken}`);
    expect(res.status).toBe(403);
  });

  it("ANC case: PATIENT-A CAN GET own case (200) [positive control]", async () => {
    const res = await request(app)
      .get(`/api/v1/antenatal/cases/${ancCaseAId}`)
      .set("Authorization", `Bearer ${patientAToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data?.id).toBe(ancCaseAId);
  });

  it("ANC case: DOCTOR can GET any case (200) [staff control]", async () => {
    const res = await request(app)
      .get(`/api/v1/antenatal/cases/${ancCaseBId}`)
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(res.status).toBe(200);
  });

  // ───────────────────────────────────────────────────────
  // GET /antenatal/cases/:id/trimester
  // ───────────────────────────────────────────────────────

  it("trimester: PATIENT-A cannot GET PATIENT-B's trimester (403)", async () => {
    const res = await request(app)
      .get(`/api/v1/antenatal/cases/${ancCaseBId}/trimester`)
      .set("Authorization", `Bearer ${patientAToken}`);
    expect(res.status).toBe(403);
  });

  it("trimester: PATIENT-A CAN GET own trimester (200) [positive control]", async () => {
    const res = await request(app)
      .get(`/api/v1/antenatal/cases/${ancCaseAId}/trimester`)
      .set("Authorization", `Bearer ${patientAToken}`);
    expect(res.status).toBe(200);
    expect(typeof res.body.data?.weeks).toBe("number");
  });

  it("trimester: DOCTOR can GET any trimester (200) [staff control]", async () => {
    const res = await request(app)
      .get(`/api/v1/antenatal/cases/${ancCaseBId}/trimester`)
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(res.status).toBe(200);
  });

  // ───────────────────────────────────────────────────────
  // GET /antenatal/cases/:id/ultrasound
  // ───────────────────────────────────────────────────────

  it("ultrasound: PATIENT-A cannot GET PATIENT-B's USG list (403)", async () => {
    const res = await request(app)
      .get(`/api/v1/antenatal/cases/${ancCaseBId}/ultrasound`)
      .set("Authorization", `Bearer ${patientAToken}`);
    expect(res.status).toBe(403);
  });

  it("ultrasound: PATIENT-A CAN GET own USG list (200) [positive control]", async () => {
    const res = await request(app)
      .get(`/api/v1/antenatal/cases/${ancCaseAId}/ultrasound`)
      .set("Authorization", `Bearer ${patientAToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it("ultrasound: DOCTOR can GET any USG list (200) [staff control]", async () => {
    const res = await request(app)
      .get(`/api/v1/antenatal/cases/${ancCaseBId}/ultrasound`)
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(res.status).toBe(200);
  });

  // ───────────────────────────────────────────────────────
  // GET /antenatal/partograph/:id
  // ───────────────────────────────────────────────────────

  it("partograph: PATIENT-A cannot GET PATIENT-B's partograph (403)", async () => {
    const res = await request(app)
      .get(`/api/v1/antenatal/partograph/${partographBId}`)
      .set("Authorization", `Bearer ${patientAToken}`);
    expect(res.status).toBe(403);
  });

  it("partograph: PATIENT-A CAN GET own partograph (200) [positive control]", async () => {
    const res = await request(app)
      .get(`/api/v1/antenatal/partograph/${partographAId}`)
      .set("Authorization", `Bearer ${patientAToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data?.id).toBe(partographAId);
  });

  it("partograph: DOCTOR can GET any partograph (200) [staff control]", async () => {
    const res = await request(app)
      .get(`/api/v1/antenatal/partograph/${partographBId}`)
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(res.status).toBe(200);
  });

  // ───────────────────────────────────────────────────────
  // GET /antenatal/cases/:id/postnatal-visits
  // ───────────────────────────────────────────────────────

  it("postnatal visits: PATIENT-A cannot GET PATIENT-B's visits (403)", async () => {
    const res = await request(app)
      .get(`/api/v1/antenatal/cases/${ancCaseBId}/postnatal-visits`)
      .set("Authorization", `Bearer ${patientAToken}`);
    expect(res.status).toBe(403);
  });

  it("postnatal visits: PATIENT-A CAN GET own visits (200) [positive control]", async () => {
    const res = await request(app)
      .get(`/api/v1/antenatal/cases/${ancCaseAId}/postnatal-visits`)
      .set("Authorization", `Bearer ${patientAToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it("postnatal visits: DOCTOR can GET any visits (200) [staff control]", async () => {
    const res = await request(app)
      .get(`/api/v1/antenatal/cases/${ancCaseBId}/postnatal-visits`)
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(res.status).toBe(200);
  });

  // ───────────────────────────────────────────────────────
  // GET /antenatal/cases/:id/birth-certificate
  // ───────────────────────────────────────────────────────

  it("birth certificate: PATIENT-A cannot GET PATIENT-B's certificate (403)", async () => {
    const res = await request(app)
      .get(`/api/v1/antenatal/cases/${ancCaseBId}/birth-certificate`)
      .set("Authorization", `Bearer ${patientAToken}`);
    expect(res.status).toBe(403);
  });

  it("birth certificate: PATIENT-A CAN GET own certificate (200) [positive control]", async () => {
    const res = await request(app)
      .get(`/api/v1/antenatal/cases/${ancCaseAId}/birth-certificate`)
      .set("Authorization", `Bearer ${patientAToken}`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
  });

  it("birth certificate: DOCTOR can GET any certificate (200) [staff control]", async () => {
    const res = await request(app)
      .get(`/api/v1/antenatal/cases/${ancCaseBId}/birth-certificate`)
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(res.status).toBe(200);
  });

  // Suppress unused-var warning while keeping patientBToken in the file
  // for symmetry with cross-patient-rbac.test.ts (handy when adding
  // bidirectional cases later).
  it("smoke: patientBToken is non-empty (sanity)", () => {
    expect(typeof patientBToken).toBe("string");
    expect(patientBToken.length).toBeGreaterThan(10);
  });
});
