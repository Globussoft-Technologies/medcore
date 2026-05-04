// Cross-patient PatientDataExport BOLA regression suite — issue #511.
//
// What this file covers
// ---------------------
// `apps/api/src/routes/patient-data-export.ts` exposes three handlers
// implementing the DPDP Act 2023 right-to-portability:
//
//   POST   /api/v1/patient-data-export                  create an export request
//   GET    /api/v1/patient-data-export/:requestId       status + downloadUrl
//   GET    /api/v1/patient-data-export/:requestId/download  stream the artefact
//
// All three are PATIENT-only by design — staff (DOCTOR/ADMIN) MUST NOT be
// able to read another patient's portability artefact. The route gates
// every handler with `authorize(Role.PATIENT)` (status / create) or an
// inline `req.user.role !== Role.PATIENT` check (download bearer
// fallback). The download endpoint also accepts a short-lived HMAC
// signed URL (verified by `verifySignature` against the request id),
// which is the authoritative access grant for that path.
//
// The original audit (#474) did NOT cover this route. The 2026-05-05
// long-tail wave (#511) refactored both the GET-status and download
// bearer-fallback paths to use the canonical `assertPatientOwnsResource`
// helper instead of hand-rolled inline ownership checks, and annotated
// the POST + signed-URL paths as VERIFIED-SAFE inline. This file locks
// those contracts in.
//
// Modules / routes asserted
// -------------------------
// - GET /api/v1/patient-data-export/:requestId            (BOLA: per-row owner check)
// - GET /api/v1/patient-data-export/:requestId/download   (BOLA bearer fallback)
//
// Per route the suite asserts:
//   1. PATIENT-A's token GETs PATIENT-B's export → 403  (the bug)
//   2. PATIENT-A's token GETs PATIENT-A's own export → 200/2xx  (positive control)
//   3. DOCTOR's token GETs PATIENT-A's export → 403  (PATIENT-self surface,
//      no staff bypass — this differs from the typical staff-200 pattern
//      because portability artefacts are self-only by DPDP design)
//
// Why a separate file from cross-patient-rbac.test.ts
// ---------------------------------------------------
// The original cross-patient sweep was issue #474; #511 is a follow-up
// agent fanout that touched a different family of routes. Keeping each
// route's regression coverage in its own file avoids races during
// /medcore-fanout multi-agent waves (each agent owns a unique file).

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

// Helper: create a PATIENT user + linked Patient row with a unique email,
// then mint a JWT for that user. Mirrors the pattern in
// cross-patient-rbac.test.ts so PATIENT-A vs PATIENT-B can be asserted
// without polluting the shared canonical PATIENT fixture.
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

describeIfDB("Cross-patient PatientDataExport (issue #511 — BOLA / CWE-285)", () => {
  beforeAll(async () => {
    await resetDB();
    doctorToken = await getAuthToken("DOCTOR");

    const a = await createPatientWithToken("XPDE-A");
    const b = await createPatientWithToken("XPDE-B");
    patientAToken = a.token;
    patientBToken = b.token;
    patientAId = a.patientId;
    patientBId = b.patientId;

    const mod = await import("../../app");
    app = mod.app;
  });

  // ──────────────────────────────────────────────────────────────────
  // GET /api/v1/patient-data-export/:requestId  (status endpoint)
  // ──────────────────────────────────────────────────────────────────

  it("GET /:requestId: PATIENT-A cannot GET PATIENT-B's export status (403)", async () => {
    const prisma = await getPrisma();
    const exportB = await prisma.patientDataExport.create({
      data: {
        patientId: patientBId,
        format: "JSON",
        status: "QUEUED",
      },
    });

    const res = await request(app)
      .get(`/api/v1/patient-data-export/${exportB.id}`)
      .set("Authorization", `Bearer ${patientAToken}`);
    expect(res.status).toBe(403);
  });

  it("GET /:requestId: PATIENT-A CAN GET own export status (200) [positive control]", async () => {
    const prisma = await getPrisma();
    const exportA = await prisma.patientDataExport.create({
      data: {
        patientId: patientAId,
        format: "JSON",
        status: "QUEUED",
      },
    });

    const res = await request(app)
      .get(`/api/v1/patient-data-export/${exportA.id}`)
      .set("Authorization", `Bearer ${patientAToken}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data?.requestId).toBe(exportA.id);
  });

  it("GET /:requestId: DOCTOR is denied PATIENT-A's export status (403) [PATIENT-self surface]", async () => {
    // Portability artefacts are PATIENT-only by DPDP design. The route
    // gates with `authorize(Role.PATIENT)` so DOCTOR's token fails the
    // role gate (403) — there is no legitimate staff read path.
    const prisma = await getPrisma();
    const exportA = await prisma.patientDataExport.create({
      data: {
        patientId: patientAId,
        format: "JSON",
        status: "QUEUED",
      },
    });

    const res = await request(app)
      .get(`/api/v1/patient-data-export/${exportA.id}`)
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(res.status).toBe(403);
  });

  it("GET /:requestId: unauthenticated request is denied (401)", async () => {
    const prisma = await getPrisma();
    const exportA = await prisma.patientDataExport.create({
      data: {
        patientId: patientAId,
        format: "JSON",
        status: "QUEUED",
      },
    });

    const res = await request(app).get(
      `/api/v1/patient-data-export/${exportA.id}`
    );
    expect(res.status).toBe(401);
  });

  // ──────────────────────────────────────────────────────────────────
  // GET /api/v1/patient-data-export/:requestId/download
  //   (bearer-fallback path; signed-URL path is contract-tested
  //    separately by signature-verification unit tests)
  // ──────────────────────────────────────────────────────────────────

  it("GET /:requestId/download: PATIENT-A cannot download PATIENT-B's export (403)", async () => {
    const prisma = await getPrisma();
    const exportB = await prisma.patientDataExport.create({
      data: {
        patientId: patientBId,
        format: "JSON",
        status: "QUEUED",
      },
    });

    const res = await request(app)
      .get(`/api/v1/patient-data-export/${exportB.id}/download`)
      .set("Authorization", `Bearer ${patientAToken}`);
    expect(res.status).toBe(403);
  });

  it("GET /:requestId/download: DOCTOR is denied PATIENT-A's export download (403)", async () => {
    // Same self-only DPDP contract as the status endpoint. The download
    // route's bearer-fallback explicitly checks `req.user.role !==
    // Role.PATIENT` → 403 before the ownership check.
    const prisma = await getPrisma();
    const exportA = await prisma.patientDataExport.create({
      data: {
        patientId: patientAId,
        format: "JSON",
        status: "QUEUED",
      },
    });

    const res = await request(app)
      .get(`/api/v1/patient-data-export/${exportA.id}/download`)
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(res.status).toBe(403);
  });

  it("GET /:requestId/download: PATIENT-A on own QUEUED export gets 409 (not yet READY) [ownership passes, status gates]", async () => {
    // Positive control: ownership check passes (caller IS the owner) so
    // the handler reaches `streamExport`, which 409s because the row is
    // not READY. A 200 would require seeding an actual artefact file on
    // disk — out of scope for the BOLA regression. The key assertion is
    // !== 403, i.e. the helper accepted the caller as owner.
    const prisma = await getPrisma();
    const exportA = await prisma.patientDataExport.create({
      data: {
        patientId: patientAId,
        format: "JSON",
        status: "QUEUED",
      },
    });

    const res = await request(app)
      .get(`/api/v1/patient-data-export/${exportA.id}/download`)
      .set("Authorization", `Bearer ${patientAToken}`);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/QUEUED/);
  });
});
