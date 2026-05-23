// Integration tests for Pearl §8.1 row 206 — tenant suspend / restore.
//
// What: Exercises the suspend (`POST /api/v1/tenants/:id/deactivate`) and
//       the new mirror restore (`POST /api/v1/tenants/:id/restore`) endpoints
//       against a live test DB. Asserts (a) Tenant.active flips, (b) the
//       super-admin guard rejects non-super-admin callers with 403, (c) an
//       unknown tenant id returns 404, and (d) the audit log records the
//       canonical TENANT_SUSPENDED / TENANT_RESTORED action pair.
//
// Which modules: routes/tenants.ts, services/tenant-provisioning.ts,
//                middleware/audit.ts, test/helpers/audit-wait.ts.
//
// Why: The pre-existing tenants.test.ts only covers create/update/deactivate.
//      The restore endpoint is brand-new (Pearl gap-doc row 206) and the
//      audit-action rename (TENANT_DEACTIVATE → TENANT_SUSPENDED) needs a
//      regression pin so we don't silently drop or rename the audit row.
//
// S3 archival of suspended tenants is OUT OF SCOPE for this piece — that
// 90-day cold-storage path is tracked separately and remains deferred.
import { it, expect, beforeAll, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { describeIfDB, resetDB, getPrisma } from "../setup";
import { tenantsRouter } from "../../routes/tenants";
import { errorHandler } from "../../middleware/error";
import { tenantContextMiddleware } from "../../middleware/tenant";
import { withTenantContext } from "../../services/tenant-context";
import { waitForAuditFlush } from "../helpers/audit-wait";

let app: express.Express;
let superAdminToken: string;
let superAdminUserId: string;

function buildTestApp(): express.Express {
  const a = express();
  a.use(express.json());
  a.use(tenantContextMiddleware);
  a.use(withTenantContext);
  a.use("/api/v1/tenants", tenantsRouter);
  a.use(errorHandler);
  return a;
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

async function seedSuperAdmin(
  tenantId: string,
): Promise<{ token: string; userId: string }> {
  const prisma = await getPrisma();
  const email = `super-admin-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 6)}@test.local`;
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
  const token = jwt.sign(
    { userId: user.id, email: user.email, role: user.role, tenantId },
    process.env.JWT_SECRET || "test-jwt-secret-do-not-use-in-prod",
    { expiresIn: "1h" },
  );
  return { token, userId: user.id };
}

async function seedTargetTenant(): Promise<string> {
  const prisma = await getPrisma();
  const t = await prisma.tenant.create({
    data: {
      name: "Target Hospital",
      subdomain: `target-${Math.random().toString(36).slice(2, 7)}`,
      plan: "BASIC",
      active: true,
    },
  });
  return t.id;
}

describeIfDB("Tenants Suspend/Restore API (Pearl §8.1 row 206)", () => {
  beforeAll(async () => {
    await resetDB();
    app = buildTestApp();
  });

  beforeEach(async () => {
    const prisma = await getPrisma();
    await prisma.auditLog.deleteMany({ where: { entity: "tenant" } });
    await prisma.refreshToken.deleteMany({});
    await prisma.user.deleteMany({
      where: { email: { startsWith: "super-admin-" } },
    });
    await prisma.user.deleteMany({
      where: { email: { startsWith: "reg-user-" } },
    });
    await prisma.tenant.deleteMany({
      where: { subdomain: { startsWith: "target-" } },
    });
    const defaultTenantId = await ensureDefaultTenant();
    const seeded = await seedSuperAdmin(defaultTenantId);
    superAdminToken = seeded.token;
    superAdminUserId = seeded.userId;
  });

  // ── Suspend (existing /:id/deactivate) — now audits TENANT_SUSPENDED ──
  it("super-admin POST /:id/deactivate flips active=false and audits TENANT_SUSPENDED", async () => {
    const prisma = await getPrisma();
    const tenantId = await seedTargetTenant();

    const res = await request(app)
      .post(`/api/v1/tenants/${tenantId}/deactivate`)
      .set("Authorization", `Bearer ${superAdminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toMatchObject({ id: tenantId, active: false });

    const after = await prisma.tenant.findUnique({ where: { id: tenantId } });
    expect(after?.active).toBe(false);

    // Audit row writes are fire-and-forget — wait for the row to land.
    const row = await waitForAuditFlush(prisma, {
      action: "TENANT_SUSPENDED",
      entity: "tenant",
      entityId: tenantId,
      userId: superAdminUserId,
    });
    expect(row.action).toBe("TENANT_SUSPENDED");
  });

  // ── Restore (new mirror endpoint) ─────────────────────────────────────
  it("super-admin POST /:id/restore flips active=true and audits TENANT_RESTORED", async () => {
    const prisma = await getPrisma();
    const tenantId = await seedTargetTenant();
    // Suspend first so restore has something to flip.
    await prisma.tenant.update({
      where: { id: tenantId },
      data: { active: false },
    });

    const res = await request(app)
      .post(`/api/v1/tenants/${tenantId}/restore`)
      .set("Authorization", `Bearer ${superAdminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toMatchObject({ id: tenantId, active: true });

    const after = await prisma.tenant.findUnique({ where: { id: tenantId } });
    expect(after?.active).toBe(true);

    const row = await waitForAuditFlush(prisma, {
      action: "TENANT_RESTORED",
      entity: "tenant",
      entityId: tenantId,
      userId: superAdminUserId,
    });
    expect(row.action).toBe("TENANT_RESTORED");
  });

  // ── Restore is idempotent on an already-active tenant ─────────────────
  it("restoring an already-active tenant returns 200 (idempotent no-op)", async () => {
    const tenantId = await seedTargetTenant();
    const res = await request(app)
      .post(`/api/v1/tenants/${tenantId}/restore`)
      .set("Authorization", `Bearer ${superAdminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.active).toBe(true);
  });

  // ── 403 — non-super-admin RECEPTION on default tenant ──────────────────
  it("rejects non-ADMIN callers with 403 on restore", async () => {
    const prisma = await getPrisma();
    const defaultTenantId = await ensureDefaultTenant();
    const tenantId = await seedTargetTenant();

    const reg = await prisma.user.create({
      data: {
        email: `reg-user-restore-${Date.now()}@test.local`,
        name: "Reception",
        phone: "9000000003",
        passwordHash: await bcrypt.hash("x", 4),
        role: "RECEPTION",
        tenantId: defaultTenantId,
        isActive: true,
      },
    });
    const regToken = jwt.sign(
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
      .post(`/api/v1/tenants/${tenantId}/restore`)
      .set("Authorization", `Bearer ${regToken}`);
    expect(res.status).toBe(403);
  });

  // ── 403 — ADMIN on a non-default tenant cannot restore other tenants ──
  it("rejects ADMIN of a non-default tenant with 403 on restore", async () => {
    const otherTenantId = await seedTargetTenant();
    const { token: otherAdminToken } = await seedSuperAdmin(otherTenantId);
    const targetTenantId = await seedTargetTenant();

    const res = await request(app)
      .post(`/api/v1/tenants/${targetTenantId}/restore`)
      .set("Authorization", `Bearer ${otherAdminToken}`);
    expect(res.status).toBe(403);
  });

  // ── 404 — unknown tenant id ───────────────────────────────────────────
  it("returns 404 for unknown tenant id on restore", async () => {
    const res = await request(app)
      .post("/api/v1/tenants/00000000-0000-0000-0000-000000000000/restore")
      .set("Authorization", `Bearer ${superAdminToken}`);
    expect(res.status).toBe(404);
  });

  it("returns 404 for unknown tenant id on suspend", async () => {
    const res = await request(app)
      .post("/api/v1/tenants/00000000-0000-0000-0000-000000000000/deactivate")
      .set("Authorization", `Bearer ${superAdminToken}`);
    expect(res.status).toBe(404);
  });
});
