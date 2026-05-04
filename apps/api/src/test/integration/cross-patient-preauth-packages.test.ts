// Cross-patient BOLA regression suite — preauth + packages PATIENT surfaces, issue #511.
//
// What this file covers
// ---------------------
// `apps/api/src/routes/preauth.ts` — insurance pre-authorization workflow that
// stores high-PHI fields on each row (diagnosis text, ICD-equivalent procedure
// name, insurance plan number, estimated cost). Before this commit:
//   - GET /api/v1/preauth could be hit by any PATIENT JWT and would return
//     EVERY preauth row across all patients (cross-tenant PHI list leak).
//   - GET /api/v1/preauth/:id had no per-row owner gate so any PATIENT could
//     read any other patient's pre-auth detail by id (BOLA / OWASP API1:2023).
// `apps/api/src/routes/packages.ts` — mixed surface. HealthPackage itself is
// catalog (no patientId FK — verified-safe to browse), but PackagePurchase IS
// patient-scoped (purchase number, amount, family member ids, services used).
// Before this commit:
//   - GET /api/v1/packages/purchases listed every patient's purchases including
//     name + phone (via the `patient.user` include).
//   - GET /api/v1/packages/purchases/:id had no per-row owner gate.
//   - GET /api/v1/packages/:id eagerly included up to 10 purchases.patient.user
//     records, leaking purchaser identities for whatever package was queried.
//
// Modules / routes asserted (each: cross-patient 403, self 200, doctor/admin 200)
// -------------------------------------------------------------------------------
// PREAUTH
// - GET    /api/v1/preauth                   (list — PATIENT self-scoped)
// - GET    /api/v1/preauth/:id               (BOLA — per-row owner check)
// - POST   /api/v1/preauth                   (PATIENT denied via authorize())
// - PATCH  /api/v1/preauth/:id/status        (PATIENT denied via authorize())
// PACKAGES
// - GET    /api/v1/packages                  (catalog — PATIENT may browse)
// - GET    /api/v1/packages/:id              (PATIENT does not see purchasers)
// - GET    /api/v1/packages/purchases        (list — PATIENT self-scoped)
// - GET    /api/v1/packages/purchases/:id    (BOLA — per-row owner check)
// - POST   /api/v1/packages/purchase         (PATIENT denied via authorize())
// - POST   /api/v1/packages/purchases/:id/consume (PATIENT denied via authorize())
//
// Why a separate file
// -------------------
// The 2026-05-05 #511 fanout has multiple agents writing concurrently;
// per-route test files (this one + cross-patient-<x>.test.ts siblings)
// avoid merge collisions on the canonical cross-patient-rbac.test.ts.

import { it, expect, beforeAll } from "vitest";
import request from "supertest";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { describeIfDB, resetDB, getAuthToken, getPrisma } from "../setup";

let app: any;
let doctorToken: string;
let adminToken: string;
let patientAToken: string;
let patientBToken: string;
let patientAId: string;
let patientBId: string;

// Preauth fixtures
let preauthAId: string;
let preauthBId: string;

// Packages fixtures
let healthPackageId: string;
let purchaseAId: string;
let purchaseBId: string;

// Helper: create a PATIENT user + linked Patient row + JWT.
async function createPatientWithToken(
  label: string
): Promise<{ patientId: string; userId: string; token: string }> {
  const prisma = await getPrisma();
  const email = `patient_pkgpa_${label}_${Date.now()}_${Math.random()
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
      mrNumber: `MR-PKGPA-${label}-${Date.now()}`,
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

describeIfDB(
  "Cross-patient BOLA — preauth + packages PATIENT surfaces (issue #511)",
  () => {
    beforeAll(async () => {
      await resetDB();
      doctorToken = await getAuthToken("DOCTOR");
      adminToken = await getAuthToken("ADMIN");

      const a = await createPatientWithToken("A");
      const b = await createPatientWithToken("B");
      patientAToken = a.token;
      patientBToken = b.token;
      patientAId = a.patientId;
      patientBId = b.patientId;

      const prisma = await getPrisma();

      // ── Preauth fixtures ──
      const preauthA = await prisma.preAuthRequest.create({
        data: {
          requestNumber: `PA-A-${Date.now()}`,
          patientId: patientAId,
          insuranceProvider: "ACME-Care",
          policyNumber: "POL-AAA-001",
          procedureName: "Knee replacement",
          estimatedCost: 100000,
          diagnosis: "Osteoarthritis right knee, grade 4",
          createdBy: a.userId,
        },
      });
      preauthAId = preauthA.id;

      const preauthB = await prisma.preAuthRequest.create({
        data: {
          requestNumber: `PA-B-${Date.now()}`,
          patientId: patientBId,
          insuranceProvider: "BlueShield",
          policyNumber: "POL-BBB-001",
          procedureName: "Cataract surgery",
          estimatedCost: 60000,
          diagnosis: "Senile cataract left eye",
          createdBy: b.userId,
        },
      });
      preauthBId = preauthB.id;

      // ── Packages fixtures ──
      const healthPackage = await prisma.healthPackage.create({
        data: {
          name: `Annual Wellness ${Date.now()}`,
          description: "Comprehensive annual health checkup",
          services: "CBC, LFT, KFT, ECG, Consultation",
          price: 5000,
          validityDays: 365,
          category: "WELLNESS",
          isActive: true,
        },
      });
      healthPackageId = healthPackage.id;

      const purchaseA = await prisma.packagePurchase.create({
        data: {
          purchaseNumber: `PP-A-${Date.now()}`,
          packageId: healthPackageId,
          patientId: patientAId,
          purchasedAt: new Date(),
          expiresAt: new Date(Date.now() + 365 * 86400000),
          amountPaid: 5000,
        },
      });
      purchaseAId = purchaseA.id;

      const purchaseB = await prisma.packagePurchase.create({
        data: {
          purchaseNumber: `PP-B-${Date.now()}`,
          packageId: healthPackageId,
          patientId: patientBId,
          purchasedAt: new Date(),
          expiresAt: new Date(Date.now() + 365 * 86400000),
          amountPaid: 5000,
        },
      });
      purchaseBId = purchaseB.id;

      // patientBToken kept for future inverse cases; suppress unused-lint.
      void patientBToken;

      const mod = await import("../../app");
      app = mod.app;
    });

    // ────────────────────────────────────────────────────────
    // PREAUTH — GET / (list)
    // ────────────────────────────────────────────────────────

    it("preauth GET /: PATIENT-A listing returns ONLY own rows (never PATIENT-B's)", async () => {
      const res = await request(app)
        .get(`/api/v1/preauth`)
        .set("Authorization", `Bearer ${patientAToken}`);
      expect(res.status).toBe(200);
      const ids = (res.body.data || []).map((r: any) => r.id);
      expect(ids).toContain(preauthAId);
      expect(ids).not.toContain(preauthBId);
    });

    it("preauth GET /?patientId=B: PATIENT-A cannot bypass via query filter (still own only)", async () => {
      const res = await request(app)
        .get(`/api/v1/preauth?patientId=${patientBId}`)
        .set("Authorization", `Bearer ${patientAToken}`);
      expect(res.status).toBe(200);
      const ids = (res.body.data || []).map((r: any) => r.id);
      expect(ids).not.toContain(preauthBId);
    });

    it("preauth GET /: ADMIN sees all rows (staff RBAC unbroken)", async () => {
      const res = await request(app)
        .get(`/api/v1/preauth`)
        .set("Authorization", `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      const ids = (res.body.data || []).map((r: any) => r.id);
      expect(ids).toContain(preauthAId);
      expect(ids).toContain(preauthBId);
    });

    // ────────────────────────────────────────────────────────
    // PREAUTH — GET /:id (BOLA)
    // ────────────────────────────────────────────────────────

    it("preauth GET /:id: PATIENT-A cannot GET PATIENT-B's preauth (403)", async () => {
      const res = await request(app)
        .get(`/api/v1/preauth/${preauthBId}`)
        .set("Authorization", `Bearer ${patientAToken}`);
      expect(res.status).toBe(403);
    });

    it("preauth GET /:id: PATIENT-A CAN GET own preauth (200)", async () => {
      const res = await request(app)
        .get(`/api/v1/preauth/${preauthAId}`)
        .set("Authorization", `Bearer ${patientAToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data?.id).toBe(preauthAId);
    });

    it("preauth GET /:id: DOCTOR can GET any preauth (200)", async () => {
      const res = await request(app)
        .get(`/api/v1/preauth/${preauthBId}`)
        .set("Authorization", `Bearer ${doctorToken}`);
      expect(res.status).toBe(200);
    });

    // ────────────────────────────────────────────────────────
    // PREAUTH — POST / (PATIENT denied via authorize)
    // ────────────────────────────────────────────────────────

    it("preauth POST /: PATIENT denied (403, RBAC excludes PATIENT)", async () => {
      const res = await request(app)
        .post(`/api/v1/preauth`)
        .set("Authorization", `Bearer ${patientAToken}`)
        .send({
          patientId: patientAId,
          insuranceProvider: "X",
          policyNumber: "Y",
          procedureName: "Z",
          estimatedCost: 1000,
        });
      expect(res.status).toBe(403);
    });

    // ────────────────────────────────────────────────────────
    // PREAUTH — PATCH /:id/status (PATIENT denied via authorize)
    // ────────────────────────────────────────────────────────

    it("preauth PATCH /:id/status: PATIENT denied (403, RBAC excludes PATIENT)", async () => {
      const res = await request(app)
        .patch(`/api/v1/preauth/${preauthAId}/status`)
        .set("Authorization", `Bearer ${patientAToken}`)
        .send({ status: "APPROVED" });
      expect(res.status).toBe(403);
    });

    // ────────────────────────────────────────────────────────
    // PACKAGES — GET / (catalog browse, verified-safe)
    // ────────────────────────────────────────────────────────

    it("packages GET /: PATIENT can browse the catalog (200)", async () => {
      const res = await request(app)
        .get(`/api/v1/packages`)
        .set("Authorization", `Bearer ${patientAToken}`);
      expect(res.status).toBe(200);
      // The package created in beforeAll should appear.
      const ids = (res.body.data || []).map((r: any) => r.id);
      expect(ids).toContain(healthPackageId);
    });

    // ────────────────────────────────────────────────────────
    // PACKAGES — GET /:id (PATIENT must NOT receive purchasers list)
    // ────────────────────────────────────────────────────────

    it("packages GET /:id: PATIENT-A receives package detail WITHOUT purchases include (no PII leak)", async () => {
      const res = await request(app)
        .get(`/api/v1/packages/${healthPackageId}`)
        .set("Authorization", `Bearer ${patientAToken}`);
      expect(res.status).toBe(200);
      // The handler should strip the `purchases` include for PATIENT callers,
      // so cross-patient buyer names/phones are never returned.
      expect(res.body.data?.purchases).toBeUndefined();
    });

    it("packages GET /:id: ADMIN still sees purchases include (staff RBAC unbroken)", async () => {
      const res = await request(app)
        .get(`/api/v1/packages/${healthPackageId}`)
        .set("Authorization", `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data?.purchases)).toBe(true);
    });

    // ────────────────────────────────────────────────────────
    // PACKAGES — GET /purchases (list, PATIENT self-scoped)
    // ────────────────────────────────────────────────────────

    it("packages GET /purchases: PATIENT-A listing returns ONLY own purchases", async () => {
      const res = await request(app)
        .get(`/api/v1/packages/purchases`)
        .set("Authorization", `Bearer ${patientAToken}`);
      expect(res.status).toBe(200);
      const ids = (res.body.data || []).map((r: any) => r.id);
      expect(ids).toContain(purchaseAId);
      expect(ids).not.toContain(purchaseBId);
    });

    it("packages GET /purchases?patientId=B: PATIENT-A cannot bypass via query filter", async () => {
      const res = await request(app)
        .get(`/api/v1/packages/purchases?patientId=${patientBId}`)
        .set("Authorization", `Bearer ${patientAToken}`);
      expect(res.status).toBe(200);
      const ids = (res.body.data || []).map((r: any) => r.id);
      expect(ids).not.toContain(purchaseBId);
    });

    it("packages GET /purchases: ADMIN sees all purchases (staff RBAC unbroken)", async () => {
      const res = await request(app)
        .get(`/api/v1/packages/purchases`)
        .set("Authorization", `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      const ids = (res.body.data || []).map((r: any) => r.id);
      expect(ids).toContain(purchaseAId);
      expect(ids).toContain(purchaseBId);
    });

    // ────────────────────────────────────────────────────────
    // PACKAGES — GET /purchases/:id (BOLA)
    // ────────────────────────────────────────────────────────

    it("packages GET /purchases/:id: PATIENT-A cannot GET PATIENT-B's purchase (403)", async () => {
      const res = await request(app)
        .get(`/api/v1/packages/purchases/${purchaseBId}`)
        .set("Authorization", `Bearer ${patientAToken}`);
      expect(res.status).toBe(403);
    });

    it("packages GET /purchases/:id: PATIENT-A CAN GET own purchase (200)", async () => {
      const res = await request(app)
        .get(`/api/v1/packages/purchases/${purchaseAId}`)
        .set("Authorization", `Bearer ${patientAToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data?.id).toBe(purchaseAId);
    });

    it("packages GET /purchases/:id: ADMIN can GET any purchase (200)", async () => {
      const res = await request(app)
        .get(`/api/v1/packages/purchases/${purchaseBId}`)
        .set("Authorization", `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
    });

    // ────────────────────────────────────────────────────────
    // PACKAGES — POST /purchase (PATIENT denied via authorize)
    // ────────────────────────────────────────────────────────

    it("packages POST /purchase: PATIENT denied (403, RBAC excludes PATIENT)", async () => {
      const res = await request(app)
        .post(`/api/v1/packages/purchase`)
        .set("Authorization", `Bearer ${patientAToken}`)
        .send({
          packageId: healthPackageId,
          patientId: patientAId,
          amountPaid: 5000,
        });
      expect(res.status).toBe(403);
    });

    // ────────────────────────────────────────────────────────
    // PACKAGES — POST /purchases/:id/consume (PATIENT denied via authorize)
    // ────────────────────────────────────────────────────────

    it("packages POST /purchases/:id/consume: PATIENT denied (403, RBAC excludes PATIENT)", async () => {
      const res = await request(app)
        .post(`/api/v1/packages/purchases/${purchaseAId}/consume`)
        .set("Authorization", `Bearer ${patientAToken}`)
        .send({ service: "CBC" });
      expect(res.status).toBe(403);
    });
  }
);
