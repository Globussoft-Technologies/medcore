// Integration tests for the insurance providers router
// (apps/api/src/routes/insurance-providers.ts).
//
// Modules: routes/insurance-providers.ts (CRUD for admin-onboarded TPAs /
// insurers, Issue #724), middleware/validate.ts (Zod refines on the
// createInsuranceProviderSchema / updateInsuranceProviderSchema in
// packages/shared/src/validation/admin-calendar.ts — code uppercase regex,
// phone refine, name boundaries), middleware/auth.ts (ADMIN-only for
// mutations, ADMIN+RECEPTION for reads), middleware/audit.ts (every
// mutation writes an INSURANCE_PROVIDER_<ACTION> row via the
// fire-and-forget `auditLog(...).catch(console.error)` shape — reads MUST
// go through waitForAuditFlush per CLAUDE.md "safeAudit" gotcha).
//
// Why: insurance-providers.ts is a 173-line zero-coverage router that
// owns the admin onboarding flow for new insurance partners / TPAs. The
// schema-level rules are already covered in
// packages/shared/src/validation/__tests__/admin-calendar.test.ts; this
// file pins the wire contract:
//   - happy paths on GET (list+by-id), POST, PATCH,
//   - validation rejections at the router boundary (code lowercase →
//     toUpperCase normalisation, code regex violation, phone regex,
//     name min/max),
//   - 404 on missing :id (GET + PATCH),
//   - 409 on duplicate code (P2002),
//   - search + active filter on the list endpoint,
//   - RBAC matrix (NURSE/DOCTOR/PATIENT all 403 on list and on mutations;
//     RECEPTION can list/read but not write; missing token 401),
//   - cross-tenant isolation — Tenant A's provider does NOT leak into
//     Tenant B's list, since InsuranceProvider has a tenantId column and
//     the global tenantScopedPrisma extension auto-scopes findMany().
//   - audit-row writes for CREATE + UPDATE (entity=insuranceProvider).

import { it, expect, beforeAll } from "vitest";
import request from "supertest";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { describeIfDB, resetDB, getAuthToken, getPrisma } from "../setup";
import { waitForAuditFlush } from "../helpers/audit-wait";

const JWT_SECRET =
  process.env.JWT_SECRET || "test-jwt-secret-do-not-use-in-prod";

let app: any;
// ADMIN bound to tenantA — primary happy-path subject for mutations.
let adminAToken: string;
let adminAUserId: string;
let tenantAId: string;
// ADMIN bound to tenantB — used for cross-tenant isolation.
let adminBToken: string;
let tenantBId: string;
// Seed-admin token (tenantId=null) — confirmed authenticated but used only
// where tenant scoping is irrelevant.
let nurseToken: string;
let doctorToken: string;
let patientToken: string;
let receptionAToken: string;

// IDs created in earlier `it()` blocks and reused later.
let createdProviderId: string;

function signUser(
  userId: string,
  email: string,
  role: string,
  tenantId: string | null,
) {
  return jwt.sign(
    {
      userId,
      email,
      role,
      tenantId: tenantId ?? undefined,
    },
    JWT_SECRET,
    { expiresIn: "1h" },
  );
}

describeIfDB("Insurance Providers API (integration)", () => {
  beforeAll(async () => {
    await resetDB();
    nurseToken = await getAuthToken("NURSE");
    doctorToken = await getAuthToken("DOCTOR");
    patientToken = await getAuthToken("PATIENT");

    const prisma = await getPrisma();

    // Two tenants for isolation cases.
    const tenantA = await prisma.tenant.create({
      data: {
        name: "Tenant A Insurance Hospital",
        subdomain: `ins-a-${Date.now()}`,
        plan: "BASIC",
        active: true,
      },
    });
    const tenantB = await prisma.tenant.create({
      data: {
        name: "Tenant B Insurance Hospital",
        subdomain: `ins-b-${Date.now()}`,
        plan: "BASIC",
        active: true,
      },
    });
    tenantAId = tenantA.id;
    tenantBId = tenantB.id;

    // Per-tenant ADMIN + RECEPTION users created directly so tenantId is
    // stamped on the row. The shared `getAuthToken("ADMIN")` user is
    // tenant-less and isn't useful for tenant-scoped writes here.
    const passwordHash = await bcrypt.hash("MedCoreT3st-2026", 4);
    const adminAEmail = `ins-admin-a-${Date.now()}@test.local`;
    const adminBEmail = `ins-admin-b-${Date.now()}@test.local`;
    const recAEmail = `ins-reception-a-${Date.now()}@test.local`;
    const adminA = await prisma.user.create({
      data: {
        email: adminAEmail,
        name: "Insurance Admin A",
        phone: "9300000001",
        passwordHash,
        role: "ADMIN",
        tenantId: tenantAId,
      },
    });
    const adminB = await prisma.user.create({
      data: {
        email: adminBEmail,
        name: "Insurance Admin B",
        phone: "9300000002",
        passwordHash,
        role: "ADMIN",
        tenantId: tenantBId,
      },
    });
    const receptionA = await prisma.user.create({
      data: {
        email: recAEmail,
        name: "Insurance Reception A",
        phone: "9300000003",
        passwordHash,
        role: "RECEPTION",
        tenantId: tenantAId,
      },
    });
    adminAUserId = adminA.id;
    adminAToken = signUser(adminAUserId, adminAEmail, "ADMIN", tenantAId);
    adminBToken = signUser(adminB.id, adminBEmail, "ADMIN", tenantBId);
    receptionAToken = signUser(
      receptionA.id,
      recAEmail,
      "RECEPTION",
      tenantAId,
    );

    const mod = await import("../../app");
    app = mod.app;
  });

  // ─── POST /insurance-providers ────────────────────────────

  it("POST / creates a provider, normalises code to uppercase, writes audit row", async () => {
    const prisma = await getPrisma();
    const res = await request(app)
      .post("/api/v1/insurance-providers")
      .set("Authorization", `Bearer ${adminAToken}`)
      .send({
        name: "Medi Assist TPA",
        code: "medi_assist", // lowercase — schema toUpperCase + handler toUpperCase
        contactPerson: "Ravi Kumar",
        contactEmail: "ravi@mediassist.in",
        contactPhone: "+91 9876543210",
        coverageDetails: "Cashless network across India",
      });
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.id).toBeTruthy();
    expect(res.body.data.code).toBe("MEDI_ASSIST");
    expect(res.body.data.name).toBe("Medi Assist TPA");
    expect(res.body.data.isActive).toBe(true);
    createdProviderId = res.body.data.id;

    const audit = await waitForAuditFlush(prisma, {
      action: "INSURANCE_PROVIDER_CREATE",
      entity: "insuranceProvider",
      entityId: createdProviderId,
      userId: adminAUserId,
    });
    expect(audit.action).toBe("INSURANCE_PROVIDER_CREATE");
  });

  it("POST / rejects code that fails the [A-Z][A-Z0-9_]{1,30} regex (starts with digit)", async () => {
    const res = await request(app)
      .post("/api/v1/insurance-providers")
      .set("Authorization", `Bearer ${adminAToken}`)
      .send({ name: "Bad Code Co", code: "1ABC" });
    expect(res.status).toBe(400);
  });

  it("POST / rejects code that is too short (single char after toUpperCase)", async () => {
    const res = await request(app)
      .post("/api/v1/insurance-providers")
      .set("Authorization", `Bearer ${adminAToken}`)
      .send({ name: "Short Code Co", code: "X" });
    expect(res.status).toBe(400);
  });

  it("POST / rejects name shorter than 2 chars", async () => {
    const res = await request(app)
      .post("/api/v1/insurance-providers")
      .set("Authorization", `Bearer ${adminAToken}`)
      .send({ name: "A", code: "VALIDCODE" });
    expect(res.status).toBe(400);
  });

  it("POST / rejects name longer than 200 chars", async () => {
    const res = await request(app)
      .post("/api/v1/insurance-providers")
      .set("Authorization", `Bearer ${adminAToken}`)
      .send({ name: "X".repeat(201), code: "VALIDCODE2" });
    expect(res.status).toBe(400);
  });

  it("POST / rejects malformed contactPhone (refine)", async () => {
    const res = await request(app)
      .post("/api/v1/insurance-providers")
      .set("Authorization", `Bearer ${adminAToken}`)
      .send({
        name: "Phone Bad Co",
        code: "PHONEBAD",
        contactPhone: "not-a-phone",
      });
    expect(res.status).toBe(400);
  });

  it("POST / rejects malformed contactEmail", async () => {
    const res = await request(app)
      .post("/api/v1/insurance-providers")
      .set("Authorization", `Bearer ${adminAToken}`)
      .send({
        name: "Email Bad Co",
        code: "EMAILBAD",
        contactEmail: "not-an-email",
      });
    expect(res.status).toBe(400);
  });

  it("POST / returns 409 on duplicate code (P2002)", async () => {
    // First create succeeds.
    const first = await request(app)
      .post("/api/v1/insurance-providers")
      .set("Authorization", `Bearer ${adminAToken}`)
      .send({ name: "Dup Insurer One", code: "DUPCODE" });
    expect(first.status).toBe(201);

    // Second create with the same code MUST be rejected.
    const second = await request(app)
      .post("/api/v1/insurance-providers")
      .set("Authorization", `Bearer ${adminAToken}`)
      .send({ name: "Dup Insurer Two", code: "DUPCODE" });
    expect(second.status).toBe(409);
    expect(second.body.success).toBe(false);
    expect(second.body.error).toMatch(/already exists/i);
  });

  it("POST / denies DOCTOR (403 — ADMIN-only for mutations)", async () => {
    const res = await request(app)
      .post("/api/v1/insurance-providers")
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({ name: "Doctor Insurer", code: "DOCINS" });
    expect(res.status).toBe(403);
  });

  it("POST / denies NURSE (403)", async () => {
    const res = await request(app)
      .post("/api/v1/insurance-providers")
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({ name: "Nurse Insurer", code: "NURSEINS" });
    expect(res.status).toBe(403);
  });

  it("POST / denies PATIENT (403)", async () => {
    const res = await request(app)
      .post("/api/v1/insurance-providers")
      .set("Authorization", `Bearer ${patientToken}`)
      .send({ name: "Patient Insurer", code: "PATIENTINS" });
    expect(res.status).toBe(403);
  });

  it("POST / denies RECEPTION (403 — read-only role for this resource)", async () => {
    const res = await request(app)
      .post("/api/v1/insurance-providers")
      .set("Authorization", `Bearer ${receptionAToken}`)
      .send({ name: "Reception Insurer", code: "RECINS" });
    expect(res.status).toBe(403);
  });

  it("POST / requires authentication (401)", async () => {
    const res = await request(app)
      .post("/api/v1/insurance-providers")
      .send({ name: "Anon Insurer", code: "ANONINS" });
    expect(res.status).toBe(401);
  });

  // ─── GET /insurance-providers ─────────────────────────────

  it("GET / lists providers for ADMIN, ordered by name asc", async () => {
    const res = await request(app)
      .get("/api/v1/insurance-providers")
      .set("Authorization", `Bearer ${adminAToken}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeGreaterThan(0);
    // At least one row should be the Medi Assist provider created above.
    const codes = res.body.data.map((p: any) => p.code);
    expect(codes).toContain("MEDI_ASSIST");
  });

  it("GET / allows RECEPTION (claims/preauth dropdown consumer)", async () => {
    const res = await request(app)
      .get("/api/v1/insurance-providers")
      .set("Authorization", `Bearer ${receptionAToken}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it("GET /?search=medi narrows the result set (case-insensitive name contains)", async () => {
    const res = await request(app)
      .get("/api/v1/insurance-providers?search=medi")
      .set("Authorization", `Bearer ${adminAToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThan(0);
    for (const provider of res.body.data) {
      const haystack = `${provider.name} ${provider.code} ${provider.contactPerson ?? ""}`.toLowerCase();
      expect(haystack).toMatch(/medi/);
    }
  });

  it("GET /?active=true returns only active providers", async () => {
    const res = await request(app)
      .get("/api/v1/insurance-providers?active=true")
      .set("Authorization", `Bearer ${adminAToken}`);
    expect(res.status).toBe(200);
    for (const provider of res.body.data) {
      expect(provider.isActive).toBe(true);
    }
  });

  it("GET / denies DOCTOR (403)", async () => {
    const res = await request(app)
      .get("/api/v1/insurance-providers")
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(res.status).toBe(403);
  });

  it("GET / denies PATIENT (403)", async () => {
    const res = await request(app)
      .get("/api/v1/insurance-providers")
      .set("Authorization", `Bearer ${patientToken}`);
    expect(res.status).toBe(403);
  });

  it("GET / requires authentication (401)", async () => {
    const res = await request(app).get("/api/v1/insurance-providers");
    expect(res.status).toBe(401);
  });

  // ─── GET /insurance-providers/:id ─────────────────────────

  it("GET /:id returns the provider by id", async () => {
    const res = await request(app)
      .get(`/api/v1/insurance-providers/${createdProviderId}`)
      .set("Authorization", `Bearer ${adminAToken}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.id).toBe(createdProviderId);
    expect(res.body.data.code).toBe("MEDI_ASSIST");
  });

  it("GET /:id returns 404 for an unknown id", async () => {
    const res = await request(app)
      .get("/api/v1/insurance-providers/00000000-0000-0000-0000-000000000000")
      .set("Authorization", `Bearer ${adminAToken}`);
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/not found/i);
  });

  it("GET /:id denies DOCTOR (403)", async () => {
    const res = await request(app)
      .get(`/api/v1/insurance-providers/${createdProviderId}`)
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(res.status).toBe(403);
  });

  // ─── PATCH /insurance-providers/:id ───────────────────────

  it("PATCH /:id updates contactPerson + isActive, writes audit row", async () => {
    const prisma = await getPrisma();
    const res = await request(app)
      .patch(`/api/v1/insurance-providers/${createdProviderId}`)
      .set("Authorization", `Bearer ${adminAToken}`)
      .send({
        contactPerson: "Anjali Sharma",
        isActive: false,
      });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.contactPerson).toBe("Anjali Sharma");
    expect(res.body.data.isActive).toBe(false);

    const audit = await waitForAuditFlush(prisma, {
      action: "INSURANCE_PROVIDER_UPDATE",
      entity: "insuranceProvider",
      entityId: createdProviderId,
      userId: adminAUserId,
    });
    expect(audit.action).toBe("INSURANCE_PROVIDER_UPDATE");
  });

  it("PATCH /:id normalises a lowercase code to uppercase", async () => {
    // Create a fresh provider so we don't pollute earlier assertions.
    const created = await request(app)
      .post("/api/v1/insurance-providers")
      .set("Authorization", `Bearer ${adminAToken}`)
      .send({ name: "Rename Me Co", code: "RENAMEME" });
    expect(created.status).toBe(201);
    const id = created.body.data.id;

    const res = await request(app)
      .patch(`/api/v1/insurance-providers/${id}`)
      .set("Authorization", `Bearer ${adminAToken}`)
      .send({ code: "renamed_v2" });
    expect(res.status).toBe(200);
    expect(res.body.data.code).toBe("RENAMED_V2");
  });

  it("PATCH /:id rejects a malformed phone number", async () => {
    const res = await request(app)
      .patch(`/api/v1/insurance-providers/${createdProviderId}`)
      .set("Authorization", `Bearer ${adminAToken}`)
      .send({ contactPhone: "phone?" });
    expect(res.status).toBe(400);
  });

  it("PATCH /:id rejects a malformed code (regex failure)", async () => {
    const res = await request(app)
      .patch(`/api/v1/insurance-providers/${createdProviderId}`)
      .set("Authorization", `Bearer ${adminAToken}`)
      .send({ code: "1bad" });
    expect(res.status).toBe(400);
  });

  it("PATCH /:id returns 404 for an unknown id", async () => {
    const res = await request(app)
      .patch("/api/v1/insurance-providers/00000000-0000-0000-0000-000000000000")
      .set("Authorization", `Bearer ${adminAToken}`)
      .send({ name: "Ghost Provider" });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  it("PATCH /:id returns 409 when renaming to an existing code (P2002)", async () => {
    // Seed a target provider whose code we'll collide with.
    const target = await request(app)
      .post("/api/v1/insurance-providers")
      .set("Authorization", `Bearer ${adminAToken}`)
      .send({ name: "Target Insurer", code: "TARGETCODE" });
    expect(target.status).toBe(201);

    // Try to rename the earlier createdProviderId onto TARGETCODE.
    const res = await request(app)
      .patch(`/api/v1/insurance-providers/${createdProviderId}`)
      .set("Authorization", `Bearer ${adminAToken}`)
      .send({ code: "TARGETCODE" });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already exists/i);
  });

  it("PATCH /:id denies DOCTOR (403)", async () => {
    const res = await request(app)
      .patch(`/api/v1/insurance-providers/${createdProviderId}`)
      .set("Authorization", `Bearer ${doctorToken}`)
      .send({ contactPerson: "Hacker" });
    expect(res.status).toBe(403);
  });

  it("PATCH /:id denies RECEPTION (403 — read-only role for this resource)", async () => {
    const res = await request(app)
      .patch(`/api/v1/insurance-providers/${createdProviderId}`)
      .set("Authorization", `Bearer ${receptionAToken}`)
      .send({ contactPerson: "Reception Edit" });
    expect(res.status).toBe(403);
  });

  it("PATCH /:id requires authentication (401)", async () => {
    const res = await request(app)
      .patch(`/api/v1/insurance-providers/${createdProviderId}`)
      .send({ contactPerson: "Anon Edit" });
    expect(res.status).toBe(401);
  });

  // ─── Cross-tenant isolation ───────────────────────────────

  it("Tenant B's list does NOT include Tenant A's providers (tenantScopedPrisma)", async () => {
    // Tenant A has created Medi Assist + Dup Insurer One + Rename Me + Target.
    // Tenant B should see none of them.
    const res = await request(app)
      .get("/api/v1/insurance-providers")
      .set("Authorization", `Bearer ${adminBToken}`);
    expect(res.status).toBe(200);
    const codes = res.body.data.map((p: any) => p.code);
    expect(codes).not.toContain("MEDI_ASSIST");
    expect(codes).not.toContain("DUPCODE");
    expect(codes).not.toContain("TARGETCODE");
  });

  // Silence unused-token lint — patientToken used in 403 cases above, but
  // pin once for clarity in case any case is removed later.
  void nurseToken;
  void doctorToken;
  void patientToken;
});
