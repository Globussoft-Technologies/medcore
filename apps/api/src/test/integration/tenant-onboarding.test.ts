// Integration tests for the super-admin onboarding wizard endpoint
// (Pearl ERP Stage 1 §8.1 — gap #6 piece 2 of 4).
//
// What's covered:
//   1. Happy path — super-admin (tenantId: null) POSTs a valid
//      payload → 201 + Tenant + Branch + User rows created + AuditLog
//      row written.
//   2. Subdomain uniqueness — a second POST with the same subdomain
//      returns 409 with `field: "tenant.subdomain"`.
//   3. Admin-email uniqueness — POST with an existing User.email
//      returns 409 with `field: "admin.email"`.
//   4. RBAC — tenant-bound admin (tenantId set, NOT on default tenant)
//      → 403; non-ADMIN role → 403; unauthenticated → 401.
//
// Uses the same in-memory express bootstrap as tenants.test.ts so we
// don't have to reach into the global app module.

import { it, expect, beforeAll, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { describeIfDB, resetDB, getPrisma } from "../setup";
import { tenantOnboardingRouter } from "../../routes/tenant-onboarding";
import { errorHandler } from "../../middleware/error";
import { tenantContextMiddleware } from "../../middleware/tenant";
import { withTenantContext } from "../../services/tenant-context";

const JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret-do-not-use-in-prod";

let app: express.Express;
let superAdminToken: string; // tenant-less Role.ADMIN

function buildTestApp(): express.Express {
  const a = express();
  a.use(express.json());
  a.use(tenantContextMiddleware);
  a.use(withTenantContext);
  a.use("/api/v1/tenant-onboarding", tenantOnboardingRouter);
  a.use(errorHandler);
  return a;
}

async function seedTenantlessSuperAdmin(): Promise<string> {
  const prisma = await getPrisma();
  const email = `super-admin-onboard-${Date.now()}@test.local`;
  const user = await prisma.user.create({
    data: {
      email,
      name: "Super Admin (tenantless)",
      phone: "9000000099",
      passwordHash: await bcrypt.hash("MedCoreT3st-2026", 4),
      role: "ADMIN",
      tenantId: null,
      isActive: true,
    },
  });
  return jwt.sign(
    { userId: user.id, email: user.email, role: "ADMIN", tenantId: null },
    JWT_SECRET,
    { expiresIn: "1h" },
  );
}

async function seedTenantBoundAdmin(): Promise<string> {
  const prisma = await getPrisma();
  // Create a non-default tenant so the requireSuperAdmin guard rejects.
  const tenant = await prisma.tenant.create({
    data: {
      name: "Other Tenant",
      subdomain: `other-${Date.now()}`,
      plan: "BASIC",
      active: true,
    },
  });
  const email = `tenant-admin-onboard-${Date.now()}@test.local`;
  const user = await prisma.user.create({
    data: {
      email,
      name: "Tenant Admin",
      phone: "9000000098",
      passwordHash: await bcrypt.hash("MedCoreT3st-2026", 4),
      role: "ADMIN",
      tenantId: tenant.id,
      isActive: true,
    },
  });
  return jwt.sign(
    { userId: user.id, email: user.email, role: "ADMIN", tenantId: tenant.id },
    JWT_SECRET,
    { expiresIn: "1h" },
  );
}

async function seedReceptionToken(): Promise<string> {
  const prisma = await getPrisma();
  const email = `reception-onboard-${Date.now()}@test.local`;
  const user = await prisma.user.create({
    data: {
      email,
      name: "Reception",
      phone: "9000000097",
      passwordHash: await bcrypt.hash("MedCoreT3st-2026", 4),
      role: "RECEPTION",
      tenantId: null,
      isActive: true,
    },
  });
  return jwt.sign(
    { userId: user.id, email: user.email, role: "RECEPTION", tenantId: null },
    JWT_SECRET,
    { expiresIn: "1h" },
  );
}

function validPayload(seed?: { subdomain?: string; adminEmail?: string }) {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  return {
    tenant: {
      name: "Test Hospital",
      subdomain: seed?.subdomain ?? `wizard-${stamp}`,
      plan: "BASIC" as const,
    },
    branch: {
      name: "Main Branch",
      code: "MAIN",
      address: "1 Demo Road",
      city: "Bengaluru",
      state: "Karnataka",
      pincode: "560001",
      phone: "+919876543210",
    },
    admin: {
      name: "Admin User",
      email: seed?.adminEmail ?? `wizard-admin-${stamp}@onboard.test`,
      phone: "+919876500000",
      password: "Wizard-Pass-1!",
    },
  };
}

describeIfDB("Tenant onboarding wizard (Pearl §8.1 — integration)", () => {
  beforeAll(async () => {
    await resetDB();
    app = buildTestApp();
  });

  beforeEach(async () => {
    // Wipe wizard-created rows between tests so subdomain/email
    // uniqueness assertions stay deterministic across re-runs.
    const prisma = await getPrisma();
    await prisma.auditLog.deleteMany({ where: { action: "TENANT_ONBOARD" } });
    await prisma.systemConfig.deleteMany({
      where: { key: { startsWith: "tenant:" } },
    });
    await prisma.user.deleteMany({
      where: {
        OR: [
          { email: { endsWith: "@onboard.test" } },
          { email: { startsWith: "super-admin-onboard-" } },
          { email: { startsWith: "tenant-admin-onboard-" } },
          { email: { startsWith: "reception-onboard-" } },
        ],
      },
    });
    await prisma.branch.deleteMany({
      where: { name: { in: ["Main Branch"] } },
    });
    await prisma.tenant.deleteMany({
      where: {
        OR: [
          { subdomain: { startsWith: "wizard-" } },
          { subdomain: { startsWith: "other-" } },
          { subdomain: { startsWith: "dup-" } },
        ],
      },
    });
    superAdminToken = await seedTenantlessSuperAdmin();
  });

  // ── 1. Happy path ────────────────────────────────────────
  it("provisions Tenant + first Branch + super-admin User atomically (happy path)", async () => {
    const body = validPayload();
    const res = await request(app)
      .post("/api/v1/tenant-onboarding")
      .set("Authorization", `Bearer ${superAdminToken}`)
      .send(body);

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.tenant.subdomain).toBe(body.tenant.subdomain);
    expect(res.body.data.branch.isDefault).toBe(true);
    expect(res.body.data.branch.name).toBe("Main Branch");
    expect(res.body.data.admin.email).toBe(body.admin.email);

    const prisma = await getPrisma();
    const newTenantId = res.body.data.tenant.id;

    // Real rows landed in the DB.
    const tenantRow = await prisma.tenant.findUnique({
      where: { id: newTenantId },
    });
    expect(tenantRow).toBeTruthy();
    expect(tenantRow!.subdomain).toBe(body.tenant.subdomain);

    const branchRows = await prisma.branch.findMany({
      where: { tenantId: newTenantId },
    });
    expect(branchRows).toHaveLength(1);
    expect(branchRows[0].isDefault).toBe(true);
    expect(branchRows[0].code).toBe("MAIN");

    const adminRow = await prisma.user.findUnique({
      where: { email: body.admin.email },
    });
    expect(adminRow).toBeTruthy();
    expect(adminRow!.role).toBe("ADMIN");
    expect(adminRow!.tenantId).toBe(newTenantId);
    // Password should be hashed, NOT stored in plaintext.
    expect(adminRow!.passwordHash).not.toBe(body.admin.password);
    expect(adminRow!.passwordHash.startsWith("$2")).toBe(true);

    // Hospital identity SystemConfig row written.
    const cfgRow = await prisma.systemConfig.findUnique({
      where: { key: `tenant:${newTenantId}:hospital_name` },
    });
    expect(cfgRow?.value).toBe(body.tenant.name);

    // AuditLog row written.
    const auditRow = await prisma.auditLog.findFirst({
      where: { action: "TENANT_ONBOARD", entityId: newTenantId },
    });
    expect(auditRow).toBeTruthy();
    expect(auditRow!.entity).toBe("tenant");
  });

  // ── 2. Subdomain uniqueness ──────────────────────────────
  it("returns 409 + field: 'tenant.subdomain' for duplicate subdomain", async () => {
    const body = validPayload();
    const first = await request(app)
      .post("/api/v1/tenant-onboarding")
      .set("Authorization", `Bearer ${superAdminToken}`)
      .send(body);
    expect(first.status).toBe(201);

    const second = await request(app)
      .post("/api/v1/tenant-onboarding")
      .set("Authorization", `Bearer ${superAdminToken}`)
      .send({
        ...body,
        admin: { ...body.admin, email: `dup-${Date.now()}@onboard.test` },
      });
    expect(second.status).toBe(409);
    expect(second.body.field).toBe("tenant.subdomain");
    expect(second.body.error).toMatch(/subdomain/i);
  });

  // ── 3. Admin-email uniqueness ────────────────────────────
  it("returns 409 + field: 'admin.email' when admin email is already in use", async () => {
    const first = validPayload();
    const created = await request(app)
      .post("/api/v1/tenant-onboarding")
      .set("Authorization", `Bearer ${superAdminToken}`)
      .send(first);
    expect(created.status).toBe(201);

    const second = validPayload({ adminEmail: first.admin.email });
    const res = await request(app)
      .post("/api/v1/tenant-onboarding")
      .set("Authorization", `Bearer ${superAdminToken}`)
      .send(second);
    expect(res.status).toBe(409);
    expect(res.body.field).toBe("admin.email");
  });

  // ── 4. RBAC ──────────────────────────────────────────────
  it("rejects tenant-bound admins (non-default tenant) with 403", async () => {
    const otherToken = await seedTenantBoundAdmin();
    const res = await request(app)
      .post("/api/v1/tenant-onboarding")
      .set("Authorization", `Bearer ${otherToken}`)
      .send(validPayload());
    expect(res.status).toBe(403);
  });

  it("rejects non-ADMIN roles with 403", async () => {
    const receptionToken = await seedReceptionToken();
    const res = await request(app)
      .post("/api/v1/tenant-onboarding")
      .set("Authorization", `Bearer ${receptionToken}`)
      .send(validPayload());
    expect(res.status).toBe(403);
  });

  it("rejects unauthenticated callers with 401", async () => {
    const res = await request(app)
      .post("/api/v1/tenant-onboarding")
      .send(validPayload());
    expect(res.status).toBe(401);
  });

  // ── 5. Zod surface — reserved subdomain ──────────────────
  it("rejects reserved subdomain with 400", async () => {
    const body = validPayload();
    body.tenant.subdomain = "admin"; // RESERVED
    const res = await request(app)
      .post("/api/v1/tenant-onboarding")
      .set("Authorization", `Bearer ${superAdminToken}`)
      .send(body);
    expect(res.status).toBe(400);
  });
});
