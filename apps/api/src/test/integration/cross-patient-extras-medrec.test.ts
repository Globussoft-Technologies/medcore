// Cross-patient BOLA regression suite — issue #511.
// Covers:
//   - apps/api/src/routes/patient-extras.ts  (CCDA export)
//   - apps/api/src/routes/med-reconciliation.ts  (clinical med-rec PHI)
//
// Why
// ---
// The 2026-05-05 long-tail BOLA wave audited two more files under the
// expanded #511 criterion (handlers with Role.PATIENT in authorize() OR
// no authorize() at all on patient-scoped data):
//
// patient-extras.ts
//   GET /patients/:id/ccda — authorize() included Role.PATIENT for the
//   self-service medical-record summary download, but the handler never
//   compared :id against the caller's own Patient row. PATIENT-A could
//   download PATIENT-B's CCDA bundle (full PHI: allergies, conditions,
//   immunisations, lab results, surgeries, prescriptions). Fix: added
//   assertPatientOwnsResource(req, res, patient.id) immediately after
//   the patient null-check.
//
// med-reconciliation.ts
//   GET /, GET /suggest, GET /:id all had only `authenticate` — any
//   PATIENT JWT could list/read clinical reconciliation rows for any
//   patientId. Fix: added authorize(DOCTOR, NURSE, ADMIN) to each (the
//   exact gating already on POST + PATCH in the same file).
//
// Per handler we assert up to three cases:
//   1. PATIENT-A → PATIENT-B's row → 403 (the bug)
//   2. PATIENT-A → PATIENT-A's own row → 200 (positive control)
//      [skipped for med-reconciliation — staff-only resource, no PATIENT
//       positive path]
//   3. DOCTOR → any row → 200 (staff RBAC unbroken)
//
// Why a separate file from cross-patient-rbac.test.ts
// ---------------------------------------------------
// The canonical file is a #474 regression suite. The #511 long-tail wave
// runs as a /medcore-fanout multi-agent batch — concurrent agents append
// races. Per-route files isolate writes.

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
let doctorUserId: string; // User.id of the doctor — performedBy FK is User-keyed

// Mirrors cross-patient-rbac.test.ts: two PATIENT users + tokens so we
// can assert PATIENT-A vs PATIENT-B without polluting the shared
// canonical PATIENT fixture.
async function createPatientWithToken(
  label: string
): Promise<{ patientId: string; userId: string; token: string }> {
  const prisma = await getPrisma();
  const email = `patient_${label}_${Date.now()}_${Math.random()
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
      mrNumber: `MR-${label}-${Date.now()}`,
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

describeIfDB("Cross-patient BOLA: patient-extras + med-reconciliation (#511)", () => {
  beforeAll(async () => {
    await resetDB();
    doctorToken = await getAuthToken("DOCTOR");

    const a = await createPatientWithToken("XPEM-A");
    const b = await createPatientWithToken("XPEM-B");
    patientAToken = a.token;
    patientBToken = b.token;
    patientAId = a.patientId;
    patientBId = b.patientId;

    const doctor = await createDoctorFixture();
    doctorUserId = doctor.userId;

    const mod = await import("../../app");
    app = mod.app;
  });

  // ──────────────────────────────────────────────────────────────────
  // patient-extras.ts — GET /api/v1/patients/:id/ccda
  // (the only PATIENT-allowed handler in this file post-A6 refactor)
  // ──────────────────────────────────────────────────────────────────

  it("CCDA: PATIENT-A cannot GET PATIENT-B's CCDA bundle (403)", async () => {
    const res = await request(app)
      .get(`/api/v1/patients/${patientBId}/ccda`)
      .set("Authorization", `Bearer ${patientAToken}`);
    expect(res.status).toBe(403);
  });

  it("CCDA: PATIENT-A CAN GET own CCDA bundle (200) [positive control]", async () => {
    const res = await request(app)
      .get(`/api/v1/patients/${patientAId}/ccda`)
      .set("Authorization", `Bearer ${patientAToken}`);
    expect(res.status).toBe(200);
    // CCDA returns JSON (Content-Disposition: attachment) — body is a string.
    const parsed = JSON.parse(res.text);
    expect(parsed.patient?.id).toBe(patientAId);
  });

  it("CCDA: DOCTOR can GET any patient's CCDA bundle (200) [staff control]", async () => {
    const res = await request(app)
      .get(`/api/v1/patients/${patientAId}/ccda`)
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(res.status).toBe(200);
  });

  // ──────────────────────────────────────────────────────────────────
  // med-reconciliation.ts — staff-only across all 3 GET handlers
  // ──────────────────────────────────────────────────────────────────

  it("med-reconciliation list: PATIENT cannot GET / (403)", async () => {
    const res = await request(app)
      .get("/api/v1/med-reconciliation")
      .set("Authorization", `Bearer ${patientAToken}`);
    expect(res.status).toBe(403);
  });

  it("med-reconciliation list: PATIENT cannot GET /?patientId=<other> (403)", async () => {
    // The original gap let any PATIENT pass an arbitrary patientId in the
    // query string and pull every reconciliation for that patient. The
    // staff-only authorize() now blocks at the role gate before the
    // query is even built.
    const res = await request(app)
      .get(`/api/v1/med-reconciliation?patientId=${patientBId}`)
      .set("Authorization", `Bearer ${patientAToken}`);
    expect(res.status).toBe(403);
  });

  it("med-reconciliation list: DOCTOR can GET / (200) [staff control]", async () => {
    const res = await request(app)
      .get("/api/v1/med-reconciliation")
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(res.status).toBe(200);
  });

  it("med-reconciliation suggest: PATIENT cannot GET /suggest?patientId=<other> (403)", async () => {
    const res = await request(app)
      .get(`/api/v1/med-reconciliation/suggest?patientId=${patientBId}`)
      .set("Authorization", `Bearer ${patientAToken}`);
    expect(res.status).toBe(403);
  });

  it("med-reconciliation suggest: DOCTOR can GET /suggest (200) [staff control]", async () => {
    const res = await request(app)
      .get(`/api/v1/med-reconciliation/suggest?patientId=${patientAId}`)
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(res.status).toBe(200);
  });

  it("med-reconciliation /:id: PATIENT cannot GET another patient's reconciliation (403)", async () => {
    const prisma = await getPrisma();
    const rec = await prisma.medReconciliation.create({
      data: {
        patientId: patientBId,
        reconciliationType: "ADMISSION",
        performedBy: doctorUserId,
        homeMedications: [],
        hospitalMedications: [],
        dischargeMedications: [],
        changes: { added: [], removed: [], modified: [] },
        patientCounseled: false,
      },
    });
    const res = await request(app)
      .get(`/api/v1/med-reconciliation/${rec.id}`)
      .set("Authorization", `Bearer ${patientAToken}`);
    expect(res.status).toBe(403);
  });

  it("med-reconciliation /:id: PATIENT cannot GET own reconciliation either (403, staff-only)", async () => {
    // Confirms the verdict-C contract: PATIENT can't read their OWN
    // reconciliation either — clinical staff workflow surface, not a
    // patient-portal endpoint.
    const prisma = await getPrisma();
    const rec = await prisma.medReconciliation.create({
      data: {
        patientId: patientAId,
        reconciliationType: "ADMISSION",
        performedBy: doctorUserId,
        homeMedications: [],
        hospitalMedications: [],
        dischargeMedications: [],
        changes: { added: [], removed: [], modified: [] },
        patientCounseled: false,
      },
    });
    const res = await request(app)
      .get(`/api/v1/med-reconciliation/${rec.id}`)
      .set("Authorization", `Bearer ${patientAToken}`);
    expect(res.status).toBe(403);
  });

  it("med-reconciliation /:id: DOCTOR can GET any reconciliation (200) [staff control]", async () => {
    const prisma = await getPrisma();
    const rec = await prisma.medReconciliation.create({
      data: {
        patientId: patientBId,
        reconciliationType: "DISCHARGE",
        performedBy: doctorUserId,
        homeMedications: [],
        hospitalMedications: [],
        dischargeMedications: [],
        changes: { added: [], removed: [], modified: [] },
        patientCounseled: false,
      },
    });
    const res = await request(app)
      .get(`/api/v1/med-reconciliation/${rec.id}`)
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data?.id).toBe(rec.id);
  });
});
