// Integration tests for the cross-tenant super-admin metrics endpoint —
// Pearl ERP Stage 1 §8.4 (gap rows 219 + 220 closure, 2026-05-23).
//
// Covers GET /api/v1/super-admin/metrics:
//   - Super-admin (tenantId == null) sees totals + perTenant rollup with
//     the expected shape and counts.
//   - Tenant-bound ADMIN (non-default subdomain) gets 403.
//   - PATIENT gets 403 at authorize(Role.ADMIN).
//   - perTenant is sorted by userCount desc and capped at 20.
//   - Audit row SUPER_ADMIN_METRICS_VIEWED is written.
//
// Like super-admin-users.test.ts we mount only the router under test on
// a minimal Express app so global startup hooks aren't exercised, and
// scope the cleanup to ONLY the rows we seed.

import { it, expect, beforeAll, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { describeIfDB, resetDB, getPrisma, getAuthToken } from "../setup";
import { superAdminMetricsRouter } from "../../routes/super-admin-metrics";
import { errorHandler } from "../../middleware/error";
import { tenantContextMiddleware } from "../../middleware/tenant";
import { withTenantContext } from "../../services/tenant-context";
import { waitForAuditFlush } from "../helpers/audit-wait";

let app: express.Express;

function buildTestApp(): express.Express {
  const a = express();
  a.use(express.json());
  a.use(tenantContextMiddleware);
  a.use(withTenantContext);
  a.use("/api/v1/super-admin/metrics", superAdminMetricsRouter);
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

interface SeedAdmin {
  token: string;
  userId: string;
  email: string;
}

async function seedAdmin(
  tenantId: string | null,
  label: string,
): Promise<SeedAdmin> {
  const prisma = await getPrisma();
  const email = `sa-metrics-${label}-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 6)}@test.local`;
  const user = await prisma.user.create({
    data: {
      email,
      name: `SA Metrics Admin (${label})`,
      phone: `9${Math.floor(Math.random() * 1e9)
        .toString()
        .padStart(9, "0")}`,
      passwordHash: await bcrypt.hash("MedCoreT3st-2026", 4),
      role: "ADMIN",
      tenantId: tenantId ?? null,
      isActive: true,
    },
  });
  const token = jwt.sign(
    {
      userId: user.id,
      email: user.email,
      role: user.role,
      tenantId: tenantId ?? undefined,
    },
    process.env.JWT_SECRET || "test-jwt-secret-do-not-use-in-prod",
    { expiresIn: "1h" },
  );
  return { token, userId: user.id, email };
}

describeIfDB("Super-admin metrics (integration)", () => {
  beforeAll(async () => {
    await resetDB();
    app = buildTestApp();
  });

  beforeEach(async () => {
    const prisma = await getPrisma();
    await prisma.auditLog.deleteMany({
      where: { action: "SUPER_ADMIN_METRICS_VIEWED" },
    });
    await prisma.user.deleteMany({
      where: { email: { startsWith: "sa-metrics-" } },
    });
    // Tenants seeded with the sa-metrics-t- subdomain prefix get cleaned
    // up at the end of each test that creates them (see below). We do
    // NOT mass-delete tenants here because the default tenant + any
    // other suite's seed tenants must stay.
    await ensureDefaultTenant();
  });

  // ── 1. Super-admin GET returns totals + perTenant shape ─────────────
  it("super-admin GET / returns totals + perTenant rollup with the expected shape", async () => {
    const prisma = await getPrisma();
    const seedSuper = await seedAdmin(null, "seed-super-1");

    // Seed one extra tenant so perTenant has at least 2 rows
    // (default + this one).
    const extra = await prisma.tenant.create({
      data: {
        name: "Metrics Test Tenant A",
        subdomain: `sa-metrics-t-${Math.random()
          .toString(36)
          .slice(2, 7)}`,
        plan: "PRO",
        active: true,
      },
    });

    try {
      const res = await request(app)
        .get("/api/v1/super-admin/metrics")
        .set("Authorization", `Bearer ${seedSuper.token}`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const { totals, perTenant } = res.body.data as {
        totals: Record<string, number>;
        perTenant: Array<{
          tenantId: string;
          tenantName: string;
          plan: string;
          active: boolean;
          userCount: number;
          patientCount: number;
          appointmentsLast7d: number;
          invoicesLast30d: number;
          createdAt: string;
        }>;
      };

      // Totals — full key shape.
      expect(totals).toMatchObject({
        tenants: expect.any(Number),
        activeTenants: expect.any(Number),
        users: expect.any(Number),
        patients: expect.any(Number),
        appointmentsLast7d: expect.any(Number),
        invoicesLast30d: expect.any(Number),
        campaignsActive: expect.any(Number),
      });
      expect(totals.tenants).toBeGreaterThanOrEqual(2);
      expect(totals.activeTenants).toBeGreaterThanOrEqual(2);
      expect(totals.users).toBeGreaterThanOrEqual(1);

      // perTenant — array of rows with the expected keys, contains the
      // extra tenant we just seeded.
      expect(Array.isArray(perTenant)).toBe(true);
      const extraRow = perTenant.find((r) => r.tenantId === extra.id);
      expect(extraRow).toBeDefined();
      expect(extraRow).toMatchObject({
        tenantName: "Metrics Test Tenant A",
        plan: "PRO",
        active: true,
        userCount: expect.any(Number),
        patientCount: expect.any(Number),
        appointmentsLast7d: expect.any(Number),
        invoicesLast30d: expect.any(Number),
        createdAt: expect.any(String),
      });

      // Audit row got written.
      const audit = await waitForAuditFlush(prisma, {
        action: "SUPER_ADMIN_METRICS_VIEWED",
        entity: "system",
        userId: seedSuper.userId,
      });
      expect(audit.action).toBe("SUPER_ADMIN_METRICS_VIEWED");
    } finally {
      await prisma.user.deleteMany({ where: { tenantId: extra.id } });
      await prisma.tenant.delete({ where: { id: extra.id } });
    }
  });

  // ── 2. Tenant-bound ADMIN gets 403 ──────────────────────────────────
  it("tenant-bound ADMIN (non-default tenant) is 403'd by requireSuperAdmin", async () => {
    const prisma = await getPrisma();
    const t = await prisma.tenant.create({
      data: {
        name: "SA Metrics Negative Tenant",
        subdomain: `sa-metrics-t-${Math.random()
          .toString(36)
          .slice(2, 7)}`,
        plan: "BASIC",
        active: true,
      },
    });
    const tenantAdmin = await seedAdmin(t.id, "tenant-bound");
    try {
      const res = await request(app)
        .get("/api/v1/super-admin/metrics")
        .set("Authorization", `Bearer ${tenantAdmin.token}`);
      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
    } finally {
      await prisma.user.deleteMany({ where: { tenantId: t.id } });
      await prisma.tenant.delete({ where: { id: t.id } });
    }
  });

  // ── 3. PATIENT role gets 403 at authorize(Role.ADMIN) ───────────────
  it("PATIENT is 403'd at authorize(Role.ADMIN)", async () => {
    const patientToken = await getAuthToken("PATIENT");
    const res = await request(app)
      .get("/api/v1/super-admin/metrics")
      .set("Authorization", `Bearer ${patientToken}`);
    expect(res.status).toBe(403);
  });

  // ── 4. perTenant sorted by userCount desc + capped at 20 ───────────
  it("perTenant is sorted by userCount desc and capped at 20", async () => {
    const seedSuper = await seedAdmin(null, "seed-super-cap");
    const res = await request(app)
      .get("/api/v1/super-admin/metrics")
      .set("Authorization", `Bearer ${seedSuper.token}`);
    expect(res.status).toBe(200);
    const perTenant = res.body.data.perTenant as Array<{
      userCount: number;
    }>;
    expect(perTenant.length).toBeLessThanOrEqual(20);
    for (let i = 1; i < perTenant.length; i += 1) {
      expect(perTenant[i - 1]!.userCount).toBeGreaterThanOrEqual(
        perTenant[i]!.userCount,
      );
    }
  });
});
