// Cross-patient BOLA regression suite — EHR sub-resources, issue #511.
//
// What this file covers
// ---------------------
// `apps/api/src/routes/ehr.ts` exposes a large surface of patient-keyed
// reads (`/patients/:patientId/<resource>`) plus one doc-keyed read
// (`/documents/:id`). The audit grep for #511 flagged 12 of these as
// candidate BOLA gaps.
//
// On inspection the file already had a hand-rolled `assertPatientAccess`
// helper with an identical signature to the canonical
// `assertPatientOwnsResource` from `middleware/patient-self-only.ts`,
// and every flagged handler called it. So the audit was a 12/12
// false-positive — the gate was already in place.
//
// The 2026-05-04 refactor (companion commit) replaces the local helper
// with the canonical one to prevent drift. This test file is the
// regression net that proves the substitution didn't change behaviour
// and that future refactors can't silently regress the BOLA gate.
//
// Why a separate file
// -------------------
// `cross-patient-rbac.test.ts` is the canonical IDOR/BOLA suite but the
// 2026-05-04 #511 fan-out has 4 other agents touching cross-patient
// test files concurrently. Per `/medcore-bola-sweep` the convention is
// per-route test files (no merge collision, no test-file race).
//
// Routes asserted (each gets cross-patient 403 / self 200 / doctor 200)
// --------------------------------------------------------------------
// - GET /api/v1/ehr/patients/:patientId/allergies
// - GET /api/v1/ehr/patients/:patientId/conditions
// - GET /api/v1/ehr/patients/:patientId/family-history
// - GET /api/v1/ehr/patients/:patientId/immunizations
// - GET /api/v1/ehr/patients/:patientId/immunizations/due
// - GET /api/v1/ehr/patients/:patientId/immunizations/schedule
// - GET /api/v1/ehr/patients/:patientId/immunizations/recommended
// - GET /api/v1/ehr/patients/:patientId/documents
// - GET /api/v1/ehr/documents/:id
// - GET /api/v1/ehr/patients/:patientId/summary
// - GET /api/v1/ehr/patients/:patientId/advance-directives
// - GET /api/v1/ehr/patients/:patientId/problem-list

import { it, expect, beforeAll } from "vitest";
import request from "supertest";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { describeIfDB, resetDB, getAuthToken, getPrisma } from "../setup";

let app: any;
let doctorToken: string;
let patientAToken: string;
let patientBToken: string;
let patientAId: string;
let patientBId: string;
// One canonical document per patient so the doc-keyed `/documents/:id`
// handler can be exercised for both PATIENT-A's own doc (200) and
// PATIENT-B's foreign doc (403).
let docAId: string;
let docBId: string;

// Helper mirrors cross-patient-rbac.test.ts: spin up two PATIENT users
// with their own Patient row + JWT so we can assert PATIENT-A vs
// PATIENT-B per-row ownership behaviour.
async function createPatientWithToken(
  label: string
): Promise<{ patientId: string; userId: string; token: string }> {
  const prisma = await getPrisma();
  const email = `patient_ehr_${label}_${Date.now()}_${Math.random()
    .toString(36)
    .slice(2, 6)}@test.local`;
  const user = await prisma.user.create({
    data: {
      email,
      name: `Patient ${label}`,
      phone: "9000000002",
      passwordHash: await bcrypt.hash("MedCoreT3st-2026", 4),
      role: "PATIENT" as any,
    },
  });
  const patient = await prisma.patient.create({
    data: {
      userId: user.id,
      mrNumber: `MR-EHR-${label}-${Date.now()}`,
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

describeIfDB("Cross-patient BOLA — ehr.ts (issue #511)", () => {
  beforeAll(async () => {
    await resetDB();
    doctorToken = await getAuthToken("DOCTOR");

    const a = await createPatientWithToken("A");
    const b = await createPatientWithToken("B");
    patientAToken = a.token;
    patientBToken = b.token;
    patientAId = a.patientId;
    patientBId = b.patientId;

    // Stand up one document per patient so the doc-keyed
    // `/documents/:id` handler is testable.
    const prisma = await getPrisma();
    const docA = await prisma.patientDocument.create({
      data: {
        patientId: patientAId,
        type: "REPORT",
        title: "Doc-A",
        filePath: "uploads/ehr/doc-a.pdf",
        uploadedBy: a.userId,
      },
    });
    const docB = await prisma.patientDocument.create({
      data: {
        patientId: patientBId,
        type: "REPORT",
        title: "Doc-B",
        filePath: "uploads/ehr/doc-b.pdf",
        uploadedBy: b.userId,
      },
    });
    docAId = docA.id;
    docBId = docB.id;

    const mod = await import("../../app");
    app = mod.app;
  });

  // ───────────────────────────────────────────────────────
  // Patient-keyed list reads (12 endpoints × 3 cases each)
  // ───────────────────────────────────────────────────────

  // Each path is exercised three ways: foreign-PATIENT 403, self-PATIENT
  // 200, DOCTOR 200. The handlers always return 200 on empty lists, so
  // the self-PATIENT case is meaningful even without seeded children.
  const PATIENT_KEYED_PATHS: Array<{ name: string; suffix: string }> = [
    { name: "allergies", suffix: "/allergies" },
    { name: "conditions", suffix: "/conditions" },
    { name: "family-history", suffix: "/family-history" },
    { name: "immunizations", suffix: "/immunizations" },
    { name: "immunizations/due", suffix: "/immunizations/due" },
    { name: "immunizations/schedule", suffix: "/immunizations/schedule" },
    { name: "immunizations/recommended", suffix: "/immunizations/recommended" },
    { name: "documents", suffix: "/documents" },
    { name: "summary", suffix: "/summary" },
    { name: "advance-directives", suffix: "/advance-directives" },
    { name: "problem-list", suffix: "/problem-list" },
  ];

  for (const { name, suffix } of PATIENT_KEYED_PATHS) {
    it(`${name}: PATIENT-A cannot GET PATIENT-B's ${name} (403)`, async () => {
      const res = await request(app)
        .get(`/api/v1/ehr/patients/${patientBId}${suffix}`)
        .set("Authorization", `Bearer ${patientAToken}`);
      expect(res.status).toBe(403);
    });

    it(`${name}: PATIENT-A CAN GET own ${name} (200) [positive control]`, async () => {
      const res = await request(app)
        .get(`/api/v1/ehr/patients/${patientAId}${suffix}`)
        .set("Authorization", `Bearer ${patientAToken}`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it(`${name}: DOCTOR can GET any ${name} (200) [staff control]`, async () => {
      const res = await request(app)
        .get(`/api/v1/ehr/patients/${patientBId}${suffix}`)
        .set("Authorization", `Bearer ${doctorToken}`);
      expect(res.status).toBe(200);
    });
  }

  // ───────────────────────────────────────────────────────
  // Doc-keyed read — /api/v1/ehr/documents/:id
  //   Resolution path: Document → patientId → ownership check.
  // ───────────────────────────────────────────────────────

  it("documents/:id: PATIENT-A cannot GET PATIENT-B's document (403)", async () => {
    const res = await request(app)
      .get(`/api/v1/ehr/documents/${docBId}`)
      .set("Authorization", `Bearer ${patientAToken}`);
    expect(res.status).toBe(403);
  });

  it("documents/:id: PATIENT-A CAN GET own document (200) [positive control]", async () => {
    const res = await request(app)
      .get(`/api/v1/ehr/documents/${docAId}`)
      .set("Authorization", `Bearer ${patientAToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data?.id).toBe(docAId);
  });

  it("documents/:id: DOCTOR can GET any document (200) [staff control]", async () => {
    const res = await request(app)
      .get(`/api/v1/ehr/documents/${docBId}`)
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data?.id).toBe(docBId);
  });
});
