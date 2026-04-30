// Integration tests for the tenants router (multi-tenant onboarding).
//
// The tenants router is intentionally NOT registered in app.ts yet (operator
// rollout); see the task report for the exact `app.use(...)` line to add.
// These tests mount the router on a minimal Express app so we can exercise it
// end-to-end without touching the global app module.
import { it, expect, beforeAll, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { describeIfDB, resetDB, getPrisma } from "../setup";
import { tenantsRouter } from "../../routes/tenants";
import { authRouter } from "../../routes/auth";
import { errorHandler } from "../../middleware/error";
import { tenantContextMiddleware } from "../../middleware/tenant";
import { withTenantContext } from "../../services/tenant-context";

let app: express.Express;
let superAdminToken: string;

/**
 * Build a minimal express app that mounts only the tenants router. This
 * mirrors how the router will eventually be registered in app.ts
 * (`app.use("/api/v1/tenants", tenantsRouter)`) without having to modify the
 * real app module for the test.
 */
function buildTestApp(): express.Express {
  const a = express();
  a.use(express.json());
  a.use(tenantContextMiddleware);
  a.use(withTenantContext);
  // Mount auth too so we can assert that login succeeds / fails based on
  // the tenant's active flag (deactivation gate).
  a.use("/api/v1/auth", authRouter);
  a.use("/api/v1/tenants", tenantsRouter);
  a.use(errorHandler);
  return a;
}

/**
 * Seed the "default" tenant and return its id. Required because the tenants
 * router's requireSuperAdmin guard only lets callers from the default tenant
 * (or globally tenant-less admins) through.
 */
async function ensureDefaultTenant(): Promise<string> {
  const prisma = await getPrisma();
  const existing = await prisma.tenant.findUnique({
    where: { subdomain: "default" },
  });
  if (existing) return existing.id;
  const t = await prisma.tenant.create({
    data: {
      name: "Default Tenant",
      subdomain: "default",
      plan: "BASIC",
      active: true,
    },
  });
  return t.id;
}

async function seedSuperAdmin(tenantId: string): Promise<string> {
  const prisma = await getPrisma();
  const email = `super-admin-${Date.now()}@test.local`;
  const user = await prisma.user.create({
    data: {
      email,
      name: "Super Admin",
      phone: "9000000000",
      passwordHash: await bcrypt.hash("MedCoreT3st-2026", 4),
      role: "ADMIN",
      tenantId,
      isActive: true,
    },
  });
  return jwt.sign(
    { userId: user.id, email: user.email, role: user.role, tenantId },
    process.env.JWT_SECRET || "test-jwt-secret-do-not-use-in-prod",
    { expiresIn: "1h" },
  );
}

async function seedRegularAdmin(tenantId: string | null): Promise<string> {
  const prisma = await getPrisma();
  const email = `reg-admin-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@test.local`;
  const user = await prisma.user.create({
    data: {
      email,
      name: "Regular Admin",
      phone: "9000000001",
      passwordHash: await bcrypt.hash("MedCoreT3st-2026", 4),
      role: tenantId ? "ADMIN" : "RECEPTION",
      tenantId,
      isActive: true,
    },
  });
  return jwt.sign(
    {
      userId: user.id,
      email: user.email,
      role: user.role,
      tenantId,
    },
    process.env.JWT_SECRET || "test-jwt-secret-do-not-use-in-prod",
    { expiresIn: "1h" },
  );
}

const VALID_CREATE = () => ({
  name: "Sunrise Hospital",
  subdomain: `sunrise-${Math.random().toString(36).slice(2, 7)}`,
  plan: "BASIC" as const,
  adminEmail: `admin-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@sunrise.test`,
  adminPassword: "verysecurepw",
  adminName: "Sunrise Admin",
  hospitalConfig: {
    phone: "+91 22 1234 5678",
    email: "info@sunrise.test",
    gstin: "27AAACM1234Z1Z5",
    address: "1 Sunrise Rd, Mumbai",
  },
});

describeIfDB("Tenants API (integration)", () => {
  beforeAll(async () => {
    await resetDB();
    app = buildTestApp();
  });

  beforeEach(async () => {
    // Re-seed a fresh default tenant + super admin token for each test so
    // creates in one test don't bleed into another.
    const prisma = await getPrisma();
    await prisma.refreshToken.deleteMany({});
    await prisma.notificationPreference.deleteMany({});
    await prisma.notificationTemplate.deleteMany({});
    await prisma.leaveBalance.deleteMany({});
    await prisma.holiday.deleteMany({});
    await prisma.systemConfig.deleteMany({
      where: { key: { startsWith: "tenant:" } },
    });
    // Only wipe tenants OTHER than the default so the FK chain stays intact.
    await prisma.user.deleteMany({
      where: { email: { endsWith: "@sunrise.test" } },
    });
    await prisma.user.deleteMany({
      where: { email: { startsWith: "super-admin-" } },
    });
    await prisma.user.deleteMany({
      where: { email: { startsWith: "reg-admin-" } },
    });
    await prisma.tenant.deleteMany({
      where: { subdomain: { not: "default" } },
    });
    const defaultTenantId = await ensureDefaultTenant();
    superAdminToken = await seedSuperAdmin(defaultTenantId);
  });

  // ── 1. Happy path ────────────────────────────────────────
  it("creates a tenant (happy path)", async () => {
    const body = VALID_CREATE();
    const res = await request(app)
      .post("/api/v1/tenants")
      .set("Authorization", `Bearer ${superAdminToken}`)
      .send(body);
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.tenant.subdomain).toBe(body.subdomain);
    expect(res.body.data.adminUser.email).toBe(body.adminEmail);
    // Seed assertions: templates, preferences, leave balances, holidays,
    // and hospital-identity config rows were all persisted.
    expect(res.body.data.seeded.notificationTemplates).toBeGreaterThan(0);
    expect(res.body.data.seeded.notificationPreferences).toBe(4);
    expect(res.body.data.seeded.leaveBalances).toBe(6);
    expect(res.body.data.seeded.holidays).toBeGreaterThan(0);
    expect(res.body.data.seeded.systemConfigRows).toBe(6);

    // And verify the per-tenant SystemConfig actually landed in the DB.
    const prisma = await getPrisma();
    const tenantId = res.body.data.tenant.id;
    const cfg = await prisma.systemConfig.findMany({
      where: { key: { startsWith: `tenant:${tenantId}:` } },
    });
    expect(cfg.length).toBeGreaterThanOrEqual(6);
  });

  // ── 2. Duplicate subdomain → 409 ─────────────────────────
  it("returns 409 for duplicate subdomain", async () => {
    const body = VALID_CREATE();
    const first = await request(app)
      .post("/api/v1/tenants")
      .set("Authorization", `Bearer ${superAdminToken}`)
      .send(body);
    expect(first.status).toBe(201);

    const second = await request(app)
      .post("/api/v1/tenants")
      .set("Authorization", `Bearer ${superAdminToken}`)
      .send({ ...body, adminEmail: `dup-${Date.now()}@sunrise.test` });
    expect(second.status).toBe(409);
  });

  // ── 3. Invalid subdomain → 400 ───────────────────────────
  it("rejects invalid subdomain (400)", async () => {
    const res = await request(app)
      .post("/api/v1/tenants")
      .set("Authorization", `Bearer ${superAdminToken}`)
      .send({ ...VALID_CREATE(), subdomain: "xx" }); // too short
    expect(res.status).toBe(400);
  });

  it("rejects reserved subdomain (400)", async () => {
    const res = await request(app)
      .post("/api/v1/tenants")
      .set("Authorization", `Bearer ${superAdminToken}`)
      .send({ ...VALID_CREATE(), subdomain: "admin" });
    expect(res.status).toBe(400);
  });

  // ── 4. Non-admin → 403 ───────────────────────────────────
  it("rejects non-admin callers (403)", async () => {
    const defaultTenantId = await ensureDefaultTenant();
    const regToken = await seedRegularAdmin(defaultTenantId);
    // The seed helper creates a RECEPTION when tenantId is set but role
    // is implied ADMIN — let's force a non-admin by creating a reception
    // user directly.
    const prisma = await getPrisma();
    const reg = await prisma.user.create({
      data: {
        email: `nonadmin-${Date.now()}@test.local`,
        name: "Receptionist",
        phone: "9000000002",
        passwordHash: await bcrypt.hash("x", 4),
        role: "RECEPTION",
        tenantId: defaultTenantId,
      },
    });
    const regReceptionToken = jwt.sign(
      {
        userId: reg.id,
        email: reg.email,
        role: reg.role,
        tenantId: defaultTenantId,
      },
      process.env.JWT_SECRET || "test-jwt-secret-do-not-use-in-prod",
      { expiresIn: "1h" },
    );
    const res = await request(app)
      .get("/api/v1/tenants")
      .set("Authorization", `Bearer ${regReceptionToken}`);
    expect(res.status).toBe(403);
    // regToken is just there to exercise the seed helper paths.
    expect(regToken.length).toBeGreaterThan(0);
  });

  it("rejects admin of a non-default tenant (403)", async () => {
    // Create another tenant first via super admin.
    const body = VALID_CREATE();
    const created = await request(app)
      .post("/api/v1/tenants")
      .set("Authorization", `Bearer ${superAdminToken}`)
      .send(body);
    expect(created.status).toBe(201);

    const otherTenantId = created.body.data.tenant.id;
    const otherAdminToken = await seedSuperAdmin(otherTenantId); // seeds an ADMIN in that tenant

    const res = await request(app)
      .get("/api/v1/tenants")
      .set("Authorization", `Bearer ${otherAdminToken}`);
    expect(res.status).toBe(403);
  });

  // ── 5. List scoped appropriately ─────────────────────────
  it("lists tenants (super admin sees all)", async () => {
    const a = VALID_CREATE();
    const b = VALID_CREATE();
    await request(app)
      .post("/api/v1/tenants")
      .set("Authorization", `Bearer ${superAdminToken}`)
      .send(a);
    await request(app)
      .post("/api/v1/tenants")
      .set("Authorization", `Bearer ${superAdminToken}`)
      .send(b);

    const res = await request(app)
      .get("/api/v1/tenants?active=true")
      .set("Authorization", `Bearer ${superAdminToken}`);
    expect(res.status).toBe(200);
    // Default tenant is filtered out of "active=true" list too — and both
    // newly-created tenants should be present. Allow ≥ 2.
    const subdomains = (res.body.data as Array<{ subdomain: string }>).map(
      (t) => t.subdomain,
    );
    expect(subdomains).toContain(a.subdomain);
    expect(subdomains).toContain(b.subdomain);
    // Stats block should be populated even on zero-activity tenants.
    for (const t of res.body.data) {
      expect(t.stats).toBeDefined();
      expect(typeof t.stats.userCount).toBe("number");
    }
  });

  // ── 6. PATCH plan works ──────────────────────────────────
  it("PATCH updates plan", async () => {
    const body = VALID_CREATE();
    const created = await request(app)
      .post("/api/v1/tenants")
      .set("Authorization", `Bearer ${superAdminToken}`)
      .send(body);
    const id = created.body.data.tenant.id;

    const res = await request(app)
      .patch(`/api/v1/tenants/${id}`)
      .set("Authorization", `Bearer ${superAdminToken}`)
      .send({ plan: "PRO" });
    expect(res.status).toBe(200);
    expect(res.body.data.plan).toBe("PRO");
  });

  // ── 7. Deactivate + refresh fails ────────────────────────
  it("deactivates a tenant", async () => {
    const body = VALID_CREATE();
    const created = await request(app)
      .post("/api/v1/tenants")
      .set("Authorization", `Bearer ${superAdminToken}`)
      .send(body);
    const id = created.body.data.tenant.id;

    const res = await request(app)
      .post(`/api/v1/tenants/${id}/deactivate`)
      .set("Authorization", `Bearer ${superAdminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.active).toBe(false);

    // Confirm refresh tokens for the tenant's users were cleared.
    const prisma = await getPrisma();
    const remaining = await prisma.refreshToken.findMany({
      where: { user: { tenantId: id } },
    });
    expect(remaining.length).toBe(0);
  });

  it("refuses to deactivate the default tenant", async () => {
    const defaultTenantId = await ensureDefaultTenant();
    const res = await request(app)
      .post(`/api/v1/tenants/${defaultTenantId}/deactivate`)
      .set("Authorization", `Bearer ${superAdminToken}`);
    expect(res.status).toBe(400);
  });

  // ── 8. Create → login → deactivate → login fails ────────
  it("admin of a newly-created tenant can login; after deactivate, login fails", async () => {
    const body = VALID_CREATE();
    const created = await request(app)
      .post("/api/v1/tenants")
      .set("Authorization", `Bearer ${superAdminToken}`)
      .send(body);
    expect(created.status).toBe(201);
    const tenantId = created.body.data.tenant.id;

    // Login via /auth/login succeeds for the new admin.
    const login1 = await request(app).post("/api/v1/auth/login").send({
      email: body.adminEmail,
      password: body.adminPassword,
    });
    expect(login1.status).toBe(200);
    expect(login1.body.data.tokens?.accessToken).toBeTruthy();

    // Deactivate the tenant.
    await request(app)
      .post(`/api/v1/tenants/${tenantId}/deactivate`)
      .set("Authorization", `Bearer ${superAdminToken}`);

    // Second login is refused (401 with generic invalid-credentials to
    // prevent tenant enumeration via error message).
    const login2 = await request(app).post("/api/v1/auth/login").send({
      email: body.adminEmail,
      password: body.adminPassword,
    });
    expect(login2.status).toBe(401);
  });

  // ── 9. Onboarding step endpoints ─────────────────────────
  it("tracks onboarding step completion", async () => {
    const body = VALID_CREATE();
    const created = await request(app)
      .post("/api/v1/tenants")
      .set("Authorization", `Bearer ${superAdminToken}`)
      .send(body);
    const id = created.body.data.tenant.id;

    const before = await request(app)
      .get(`/api/v1/tenants/${id}/onboarding`)
      .set("Authorization", `Bearer ${superAdminToken}`);
    expect(before.status).toBe(200);
    expect(before.body.data.steps).toEqual({});

    const mark = await request(app)
      .post(`/api/v1/tenants/${id}/onboarding/first_doctor`)
      .set("Authorization", `Bearer ${superAdminToken}`);
    expect(mark.status).toBe(200);

    const after = await request(app)
      .get(`/api/v1/tenants/${id}/onboarding`)
      .set("Authorization", `Bearer ${superAdminToken}`);
    expect(after.body.data.steps.first_doctor).toBeTruthy();
  });
});
