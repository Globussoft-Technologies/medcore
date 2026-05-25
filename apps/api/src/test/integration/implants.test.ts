// Pearl §S2.2 row 92 — integration coverage for the Implant register MVP.
//
// What this exercises
// -------------------
// Three cases against `routes/implants.ts` (mounted at /api/v1/implants):
//
//   1) Happy path — ADMIN creates an implant against a surgery in their
//      own tenant, then GET ?surgeryId=... returns it.
//
//   2) Cross-tenant isolation — an implant created under tenant A is
//      NOT visible when an ADMIN from tenant B issues
//      GET ?lotNumber=<sharedLot>. The tenantScopedPrisma extension
//      auto-filters the read by req.tenantId, so even a known lot from
//      tenant A cannot leak into tenant B's recall sweep.
//
//   3) requireFeature("ot") gate — when an ADMIN in a tenant that has
//      `ot=false` hits any implant endpoint, the gate 404s before the
//      handler / authorize runs (matches the surgery feature-flag
//      contract codified in surgery-feature-flag.test.ts).
//
// Modules under test
// ------------------
//   - routes/implants.ts
//   - middleware/feature-flag.ts (requireFeature)
//   - services/tenant-prisma.ts + packages/db tenantScopedPrisma extension
//
// Why awaited audit
// -----------------
// The route uses `await auditLog(...)` (not safeAudit). The 201 response
// only resolves after the AuditLog row is written, so tests reading
// AuditLog immediately after the POST don't need waitForAuditFlush().

import { it, expect, beforeAll } from "vitest";
import request from "supertest";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { describeIfDB, resetDB, getPrisma } from "../setup";
import { __resetTenantValidationCacheForTests } from "../../middleware/tenant";
import { __resetFeatureFlagsCacheForTests } from "../../services/feature-flags";

const JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret-do-not-use-in-prod";

function signAdmin(userId: string, email: string, tenantId: string | null) {
  return jwt.sign(
    { userId, email, role: "ADMIN", tenantId: tenantId ?? null },
    JWT_SECRET,
    { expiresIn: "1h" }
  );
}

let app: any;
let tenantAId: string;
let tenantBId: string;
let adminAToken: string;
let adminBToken: string;
let surgeryAId: string;
const sharedLot = `LOT-RECALL-${Date.now()}`;

describeIfDB("Implant register API (Pearl §S2.2 row 92 — integration)", () => {
  beforeAll(async () => {
    await resetDB();
    __resetTenantValidationCacheForTests();
    __resetFeatureFlagsCacheForTests();

    const prisma = await getPrisma();
    const passwordHash = await bcrypt.hash("MedCoreT3st-2026", 4);

    // Two tenants, each with an ADMIN user.
    const tenantA = await prisma.tenant.create({
      data: {
        name: "Implant Tenant A",
        subdomain: `implant-a-${Date.now()}`,
        plan: "BASIC",
        active: true,
      },
    });
    const tenantB = await prisma.tenant.create({
      data: {
        name: "Implant Tenant B",
        subdomain: `implant-b-${Date.now()}`,
        plan: "BASIC",
        active: true,
      },
    });
    tenantAId = tenantA.id;
    tenantBId = tenantB.id;

    const adminAEmail = `implant-admin-a-${Date.now()}@test.local`;
    const adminBEmail = `implant-admin-b-${Date.now()}@test.local`;
    const adminA = await prisma.user.create({
      data: {
        email: adminAEmail,
        name: "Implant Admin A",
        phone: "9200000001",
        passwordHash,
        role: "ADMIN",
        tenantId: tenantAId,
      },
    });
    const adminB = await prisma.user.create({
      data: {
        email: adminBEmail,
        name: "Implant Admin B",
        phone: "9200000002",
        passwordHash,
        role: "ADMIN",
        tenantId: tenantBId,
      },
    });
    adminAToken = signAdmin(adminA.id, adminAEmail, tenantAId);
    adminBToken = signAdmin(adminB.id, adminBEmail, tenantBId);

    // Per-tenant Surgery row needs Patient + Doctor + OT scaffolds, all
    // stamped with the same tenantId so tenantScopedPrisma can find
    // them on the route side. We build the minimal chain here for
    // tenant A only (the cross-tenant case is asserted via the recall
    // GET, not by trying to create from tenant B).
    const patientUserA = await prisma.user.create({
      data: {
        email: `implant-patient-a-${Date.now()}@test.local`,
        name: "Implant Patient A",
        phone: "9300000001",
        passwordHash,
        role: "PATIENT",
        tenantId: tenantAId,
      },
    });
    const patientA = await prisma.patient.create({
      data: {
        userId: patientUserA.id,
        mrNumber: `MR-IMPLANT-A-${Date.now()}`,
        dateOfBirth: new Date("1990-01-01"),
        gender: "MALE",
        tenantId: tenantAId,
      },
    });
    const doctorUserA = await prisma.user.create({
      data: {
        email: `implant-doc-a-${Date.now()}@test.local`,
        name: "Implant Doctor A",
        phone: "9400000001",
        passwordHash,
        role: "DOCTOR",
        tenantId: tenantAId,
      },
    });
    const doctorA = await prisma.doctor.create({
      data: {
        userId: doctorUserA.id,
        specialization: "ORTHOPAEDICS",
        nmcRegNumber: `NMC-A-${Date.now()}`,
        tenantId: tenantAId,
      },
    });
    const otA = await prisma.operatingTheater.create({
      data: {
        name: `OT-IMPLANT-A-${Date.now()}`,
        floor: "2",
        dailyRate: 5000,
        isActive: true,
        tenantId: tenantAId,
      },
    });
    const surgeryA = await prisma.surgery.create({
      data: {
        caseNumber: `SRG-IMPL-A-${Date.now()}`,
        patientId: patientA.id,
        surgeonId: doctorA.id,
        otId: otA.id,
        procedure: "Hip Replacement",
        scheduledAt: new Date(Date.now() + 86400000),
        status: "SCHEDULED",
        tenantId: tenantAId,
      },
    });
    surgeryAId = surgeryA.id;

    const mod = await import("../../app");
    app = mod.app;
  });

  it("POST /api/v1/implants creates a row and GET ?surgeryId=... returns it (happy path)", async () => {
    const createRes = await request(app)
      .post("/api/v1/implants")
      .set("Authorization", `Bearer ${adminAToken}`)
      .send({
        surgeryId: surgeryAId,
        category: "ORTHOPAEDIC",
        manufacturer: "Stryker",
        productName: "Trident II Acetabular Shell",
        lotNumber: sharedLot,
        modelNumber: "ASR-58",
        serialNumber: "SN-ABC-001",
        expiryDate: "2030-12-31",
        notes: "Left hip; cementless.",
      });
    expect(createRes.status).toBe(201);
    expect(createRes.body?.success).toBe(true);
    expect(createRes.body?.data?.id).toBeTruthy();
    expect(createRes.body?.data?.surgeryId).toBe(surgeryAId);
    expect(createRes.body?.data?.lotNumber).toBe(sharedLot);

    const listRes = await request(app)
      .get(`/api/v1/implants?surgeryId=${surgeryAId}`)
      .set("Authorization", `Bearer ${adminAToken}`);
    expect(listRes.status).toBe(200);
    const rows = listRes.body?.data ?? [];
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.length).toBe(1);
    expect(rows[0]?.manufacturer).toBe("Stryker");

    // Audit row was written (awaited path — no race).
    const prisma = await getPrisma();
    const audit = await prisma.auditLog.findFirst({
      where: { action: "IMPLANT_REGISTER", entityId: rows[0].id },
    });
    expect(audit).toBeTruthy();
    expect(audit?.entity).toBe("implant");
  });

  it("GET /api/v1/implants?lotNumber=... by Tenant B admin MUST NOT see Tenant A's implant — cross-tenant recall isolation", async () => {
    const res = await request(app)
      .get(`/api/v1/implants?lotNumber=${sharedLot}`)
      .set("Authorization", `Bearer ${adminBToken}`);
    expect(res.status).toBe(200);
    const rows = res.body?.data ?? [];
    expect(Array.isArray(rows)).toBe(true);
    // Tenant A's implant on the shared lot MUST NOT appear in Tenant B's
    // recall sweep — tenantScopedPrisma filters by req.tenantId.
    expect(rows.length).toBe(0);
  });

  it("with ot flag PATCHed to false in Tenant B every implant endpoint returns 404 (requireFeature gate)", async () => {
    // Flip the ot flag off for tenant B via the feature-flags route.
    const patch = await request(app)
      .patch("/api/v1/feature-flags")
      .set("Authorization", `Bearer ${adminBToken}`)
      .send({ flags: { ot: false } });
    expect(patch.status).toBe(200);
    expect(patch.body?.data?.ot).toBe(false);

    // GET — gated 404 (before authorize / handler).
    const listRes = await request(app)
      .get(`/api/v1/implants?lotNumber=${sharedLot}`)
      .set("Authorization", `Bearer ${adminBToken}`);
    expect(listRes.status).toBe(404);

    // POST — gated 404 too. Even a syntactically-valid payload doesn't
    // get past the feature-flag middleware.
    const postRes = await request(app)
      .post("/api/v1/implants")
      .set("Authorization", `Bearer ${adminBToken}`)
      .send({
        surgeryId: surgeryAId,
        category: "CARDIAC",
        manufacturer: "Medtronic",
        productName: "CoreValve Evolut",
        lotNumber: "LOT-B-001",
      });
    expect(postRes.status).toBe(404);
  });
});
