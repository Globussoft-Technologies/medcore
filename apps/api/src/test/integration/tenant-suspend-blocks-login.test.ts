// Integration test for Pearl §6 acceptance row 349 (PRD §8.7 M7) —
// "Suspending tenant blocks all logins within 60 s + pauses background jobs."
//
// What this brackets: the gap doc said `deactivateTenant()` works
// synchronously but the SLO ("under 60 s end-to-end") was never asserted.
// This file pins the suspend → login-rejected latency with `Date.now()`
// and asserts a strict <60s delta. Because the production login handler
// reads `Tenant.active` live from Postgres on every request
// (apps/api/src/routes/auth.ts:893-906) there is no per-process cache to
// invalidate; the block is effectively instantaneous and the delta should
// be in the low tens-of-ms range. Asserting <60s pins the contract: no
// future regression (lazy cache, denormalised flag, etc.) may slip the
// SLO without this test screaming first.
//
// Which modules: routes/auth.ts (login + tenant.active gate),
//                routes/tenants.ts (super-admin /:id/deactivate + /:id/restore),
//                services/tenant-provisioning.ts (deactivateTenant / activateTenant),
//                middleware/audit.ts (audit row writes — fire-and-forget).
//
// Why: PRD M7 acceptance bullet — "Suspending tenant blocks all logins
// within 60 s." Without a measurement test, the SLO drifts silently.
// Pairs with the existing surface coverage in `tenants-suspend-restore.test.ts`
// (which covers the suspend/restore endpoints in isolation) and the
// tenant-deactivation gate test cases in `auth-edges.test.ts` (which
// cover the login-side rejection in isolation).
//
// Out of scope (deferred — separate piece): the second half of row 349
// "+ pauses background jobs". MedCore currently has no cross-job
// pause-on-suspend mechanism; that's a deeper architectural piece
// tracked separately. This file closes the LOGIN half of row 349.
import { it, expect, beforeAll, beforeEach } from "vitest";
import request from "supertest";
import bcrypt from "bcryptjs";
import { describeIfDB, resetDB, getPrisma } from "../setup";
import jwt from "jsonwebtoken";

let app: any;

const SUPER_ADMIN_EMAIL = "admin@test.local";
const SUPER_ADMIN_PASSWORD = "MedCoreT3st-2026";

function jwtFor(user: { id: string; email: string; role: string; tenantId: string | null }): string {
  return jwt.sign(
    {
      userId: user.id,
      email: user.email,
      role: user.role,
      tenantId: user.tenantId ?? undefined,
    },
    process.env.JWT_SECRET || "test-jwt-secret-do-not-use-in-prod",
    { expiresIn: "1h" },
  );
}

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

async function seedTargetTenant(label: string): Promise<string> {
  const prisma = await getPrisma();
  const t = await prisma.tenant.create({
    data: {
      name: `Target ${label}`,
      subdomain: `suspend-test-${label}-${Math.random().toString(36).slice(2, 7)}`,
      plan: "BASIC",
      active: true,
    },
  });
  return t.id;
}

async function seedAdminOnTenant(
  tenantId: string,
  label: string,
): Promise<{ id: string; email: string; password: string }> {
  const prisma = await getPrisma();
  const email = `tenant-admin-${label}-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 6)}@suspend-test.local`;
  const password = "TenantAdminPwd-2026";
  const user = await prisma.user.create({
    data: {
      email,
      name: `Admin ${label}`,
      phone: "9000000000",
      passwordHash: await bcrypt.hash(password, 4),
      role: "ADMIN",
      tenantId,
      isActive: true,
      // Pin twoFactorEnabled=false so the login responds 200 (not 412/200-with-2FA)
      // even if a parallel test toggled requireAdminTOTP at the tenant level.
      twoFactorEnabled: false,
      twoFactorSecret: null,
    },
  });
  // Also ensure the tenant has requireAdminTOTP=false so the
  // mandatory-TOTP gate (auth.ts:918) doesn't intercept.
  await prisma.tenant.update({
    where: { id: tenantId },
    data: { requireAdminTOTP: false },
  });
  return { id: user.id, email, password };
}

describeIfDB("Suspending a tenant blocks login within 60 s (Pearl §6 row 349)", () => {
  beforeAll(async () => {
    await resetDB();
    const mod = await import("../../app");
    app = mod.app;

    // Pin the seeded super-admin onto the default tenant so requireSuperAdmin
    // (routes/tenants.ts:108) lets it through the suspend / restore endpoints.
    const prisma = await getPrisma();
    const defaultTenantId = await ensureDefaultTenant();
    await prisma.user.update({
      where: { email: SUPER_ADMIN_EMAIL },
      data: { tenantId: defaultTenantId },
    });
  });

  beforeEach(async () => {
    // Hygiene: clear any tenants / users left by prior cases in this file
    // so each `it` gets a clean target. We do NOT call resetDB() here
    // because the suite-wide beforeAll already did, and resetDB drops the
    // super-admin token's underlying row.
    const prisma = await getPrisma();
    await prisma.refreshToken.deleteMany({});
    await prisma.user.deleteMany({
      where: { email: { contains: "@suspend-test.local" } },
    });
    await prisma.tenant.deleteMany({
      where: { subdomain: { startsWith: "suspend-test-" } },
    });
  });

  // ── Primary measurement: suspend → login-rejected, <60s end-to-end ──
  it("blocks login for the suspended tenant's admin within 60s of the deactivate call (observed: low-ms)", async () => {
    const prisma = await getPrisma();
    const defaultTenantId = await ensureDefaultTenant();

    // 1) Seed target tenant + admin; verify happy-path login works first.
    const tenantId = await seedTargetTenant("primary");
    const tenantAdmin = await seedAdminOnTenant(tenantId, "primary");

    const preSuspend = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: tenantAdmin.email, password: tenantAdmin.password });
    expect(preSuspend.status).toBe(200);
    expect(preSuspend.body.success).toBe(true);
    expect(typeof preSuspend.body.data?.tokens?.accessToken).toBe("string");

    // 2) Mint a super-admin JWT so the suspend call is authorized.
    const superAdmin = await prisma.user.findUnique({
      where: { email: SUPER_ADMIN_EMAIL },
    });
    expect(superAdmin).toBeTruthy();
    const superToken = jwtFor({
      id: superAdmin!.id,
      email: superAdmin!.email,
      role: superAdmin!.role,
      tenantId: defaultTenantId,
    });

    // 3) Start timer, suspend, attempt login, stop timer.
    const t0 = Date.now();
    const suspendRes = await request(app)
      .post(`/api/v1/tenants/${tenantId}/deactivate`)
      .set("Authorization", `Bearer ${superToken}`);
    expect(suspendRes.status).toBe(200);
    expect(suspendRes.body.data?.active).toBe(false);

    const postSuspend = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: tenantAdmin.email, password: tenantAdmin.password });
    const t1 = Date.now();

    // 4) Login MUST be rejected. The tenant-deactivation gate runs only after
    // the password is already verified, so the handler returns 403 with a
    // clear "your hospital account has been suspended" message (no enumeration
    // risk — the caller proved valid credentials) — see auth.ts.
    expect(postSuspend.status).toBe(403);
    expect(postSuspend.body.success).toBe(false);
    expect(postSuspend.body.data).toBeNull();
    expect(postSuspend.body.error).toMatch(/suspended/i);

    // 5) SLO assertion: under 60 seconds end-to-end (suspend → rejected login).
    const elapsedMs = t1 - t0;
    expect(elapsedMs).toBeLessThan(60_000);
    // Tighter sanity bracket: with no cache in the login path, this should
    // be in the low tens of ms. Allowing 5s headroom for slow CI / cold prisma.
    expect(elapsedMs).toBeLessThan(5_000);
  });

  // ── Negative control: non-suspended tenant's admin still logs in ──
  it("does NOT block other tenants — a separately-seeded admin on an active tenant still logs in 200", async () => {
    const prisma = await getPrisma();
    const defaultTenantId = await ensureDefaultTenant();

    const suspendedTenantId = await seedTargetTenant("scoped-A");
    const suspendedAdmin = await seedAdminOnTenant(suspendedTenantId, "scoped-A");

    const activeTenantId = await seedTargetTenant("scoped-B");
    const activeAdmin = await seedAdminOnTenant(activeTenantId, "scoped-B");

    // Suspend only tenant A.
    const superAdmin = await prisma.user.findUnique({
      where: { email: SUPER_ADMIN_EMAIL },
    });
    const superToken = jwtFor({
      id: superAdmin!.id,
      email: superAdmin!.email,
      role: superAdmin!.role,
      tenantId: defaultTenantId,
    });
    const suspendRes = await request(app)
      .post(`/api/v1/tenants/${suspendedTenantId}/deactivate`)
      .set("Authorization", `Bearer ${superToken}`);
    expect(suspendRes.status).toBe(200);

    // Suspended admin → 403 (clear suspended message).
    const suspendedLogin = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: suspendedAdmin.email, password: suspendedAdmin.password });
    expect(suspendedLogin.status).toBe(403);

    // Active admin (different tenant) → 200.
    const activeLogin = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: activeAdmin.email, password: activeAdmin.password });
    expect(activeLogin.status).toBe(200);
    expect(activeLogin.body.success).toBe(true);
    expect(typeof activeLogin.body.data?.tokens?.accessToken).toBe("string");
  });

  // ── Restore round-trip: relogin works once the tenant is reactivated ──
  it("restore re-enables login for the previously-suspended tenant's admin (round-trip)", async () => {
    const prisma = await getPrisma();
    const defaultTenantId = await ensureDefaultTenant();

    const tenantId = await seedTargetTenant("roundtrip");
    const tenantAdmin = await seedAdminOnTenant(tenantId, "roundtrip");

    const superAdmin = await prisma.user.findUnique({
      where: { email: SUPER_ADMIN_EMAIL },
    });
    const superToken = jwtFor({
      id: superAdmin!.id,
      email: superAdmin!.email,
      role: superAdmin!.role,
      tenantId: defaultTenantId,
    });

    // Suspend, confirm block, restore, confirm relogin.
    const suspend = await request(app)
      .post(`/api/v1/tenants/${tenantId}/deactivate`)
      .set("Authorization", `Bearer ${superToken}`);
    expect(suspend.status).toBe(200);

    const blocked = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: tenantAdmin.email, password: tenantAdmin.password });
    expect(blocked.status).toBe(403);

    const restore = await request(app)
      .post(`/api/v1/tenants/${tenantId}/restore`)
      .set("Authorization", `Bearer ${superToken}`);
    expect(restore.status).toBe(200);
    expect(restore.body.data?.active).toBe(true);

    const relogin = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: tenantAdmin.email, password: tenantAdmin.password });
    expect(relogin.status).toBe(200);
    expect(relogin.body.success).toBe(true);
    expect(typeof relogin.body.data?.tokens?.accessToken).toBe("string");
  });
});
