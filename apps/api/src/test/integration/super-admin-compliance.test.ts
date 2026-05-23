// Integration tests for the per-tenant compliance dashboard endpoint —
// Pearl ERP Stage 1 §8.6 (gap row 225 closure, 2026-05-23).
//
// Covers GET /api/v1/super-admin/compliance:
//   - Super-admin sees `tenants` array with the full posture shape +
//     snapshotAt.
//   - Tenant-bound ADMIN (non-default subdomain) gets 403.
//   - PATIENT gets 403 at authorize(Role.ADMIN).
//   - Mandatory-TOTP-violating tenants sort to the top.
//   - Audit row SUPER_ADMIN_COMPLIANCE_VIEWED is written.

import { it, expect, beforeAll, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { describeIfDB, resetDB, getPrisma, getAuthToken } from "../setup";
import { superAdminComplianceRouter } from "../../routes/super-admin-compliance";
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
  a.use("/api/v1/super-admin/compliance", superAdminComplianceRouter);
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
  const email = `sa-compliance-${label}-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 6)}@test.local`;
  const user = await prisma.user.create({
    data: {
      email,
      name: `SA Compliance Admin (${label})`,
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

describeIfDB("Super-admin compliance posture (integration)", () => {
  beforeAll(async () => {
    await resetDB();
    app = buildTestApp();
  });

  beforeEach(async () => {
    const prisma = await getPrisma();
    await prisma.auditLog.deleteMany({
      where: { action: "SUPER_ADMIN_COMPLIANCE_VIEWED" },
    });
    await prisma.user.deleteMany({
      where: { email: { startsWith: "sa-compliance-" } },
    });
    await ensureDefaultTenant();
  });

  // ── 1. Super-admin GET returns posture shape + snapshotAt ───────────
  it("super-admin GET / returns tenants array with the expected posture shape", async () => {
    const prisma = await getPrisma();
    const seedSuper = await seedAdmin(null, "seed-super-1");

    const extra = await prisma.tenant.create({
      data: {
        name: "Compliance Test Tenant A",
        subdomain: `sa-compliance-t-${Math.random()
          .toString(36)
          .slice(2, 7)}`,
        plan: "PRO",
        active: true,
        requireAdminTOTP: false,
      },
    });

    try {
      const res = await request(app)
        .get("/api/v1/super-admin/compliance")
        .set("Authorization", `Bearer ${seedSuper.token}`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const { tenants, snapshotAt } = res.body.data as {
        tenants: Array<{
          tenantId: string;
          tenantName: string;
          active: boolean;
          patientCount: number;
          abhaLinkedCount: number;
          abhaLinkedPct: number;
          dpdpRequestsLast30d: number;
          auditRowsLast30d: number;
          adminCount: number;
          totpEnrolledAdminCount: number;
          requireAdminTOTP: boolean;
          lastDpdpAt: string | null;
          lastAuditAt: string | null;
        }>;
        snapshotAt: string;
      };

      expect(typeof snapshotAt).toBe("string");
      expect(Array.isArray(tenants)).toBe(true);
      expect(tenants.length).toBeGreaterThanOrEqual(2);

      const extraRow = tenants.find((r) => r.tenantId === extra.id);
      expect(extraRow).toBeDefined();
      expect(extraRow).toMatchObject({
        tenantName: "Compliance Test Tenant A",
        active: true,
        requireAdminTOTP: false,
        patientCount: expect.any(Number),
        abhaLinkedCount: expect.any(Number),
        abhaLinkedPct: expect.any(Number),
        dpdpRequestsLast30d: expect.any(Number),
        auditRowsLast30d: expect.any(Number),
        adminCount: expect.any(Number),
        totpEnrolledAdminCount: expect.any(Number),
      });

      // Audit row got written.
      const audit = await waitForAuditFlush(prisma, {
        action: "SUPER_ADMIN_COMPLIANCE_VIEWED",
        entity: "system",
        userId: seedSuper.userId,
      });
      expect(audit.action).toBe("SUPER_ADMIN_COMPLIANCE_VIEWED");
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
        name: "SA Compliance Negative Tenant",
        subdomain: `sa-compliance-t-${Math.random()
          .toString(36)
          .slice(2, 7)}`,
        plan: "BASIC",
        active: true,
      },
    });
    const tenantAdmin = await seedAdmin(t.id, "tenant-bound");
    try {
      const res = await request(app)
        .get("/api/v1/super-admin/compliance")
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
      .get("/api/v1/super-admin/compliance")
      .set("Authorization", `Bearer ${patientToken}`);
    expect(res.status).toBe(403);
  });

  // ── 4. Mandatory-TOTP-violating tenants float to the top ────────────
  it("tenants violating requireAdminTOTP sort above compliant tenants", async () => {
    const prisma = await getPrisma();
    const seedSuper = await seedAdmin(null, "seed-super-sort");

    // Compliant tenant: requireAdminTOTP=false (trivially compliant) +
    // some patients so it would otherwise sort high.
    const compliantT = await prisma.tenant.create({
      data: {
        name: "Compliant Tenant",
        subdomain: `sa-compliance-t-${Math.random()
          .toString(36)
          .slice(2, 7)}`,
        plan: "BASIC",
        active: true,
        requireAdminTOTP: false,
      },
    });

    // Violating tenant: requireAdminTOTP=true + an ADMIN user with
    // twoFactorEnabled=false. Zero patients so patientCount tie-breaker
    // would otherwise rank it last.
    const violatingT = await prisma.tenant.create({
      data: {
        name: "Violating Tenant",
        subdomain: `sa-compliance-t-${Math.random()
          .toString(36)
          .slice(2, 7)}`,
        plan: "BASIC",
        active: true,
        requireAdminTOTP: true,
      },
    });
    await prisma.user.create({
      data: {
        email: `sa-compliance-violator-${Date.now()}@test.local`,
        name: "Violator Admin",
        phone: `9${Math.floor(Math.random() * 1e9)
          .toString()
          .padStart(9, "0")}`,
        passwordHash: await bcrypt.hash("MedCoreT3st-2026", 4),
        role: "ADMIN",
        tenantId: violatingT.id,
        twoFactorEnabled: false,
        isActive: true,
      },
    });

    try {
      const res = await request(app)
        .get("/api/v1/super-admin/compliance")
        .set("Authorization", `Bearer ${seedSuper.token}`);
      expect(res.status).toBe(200);
      const tenants = res.body.data.tenants as Array<{
        tenantId: string;
        tenantName: string;
        requireAdminTOTP: boolean;
        adminCount: number;
        totpEnrolledAdminCount: number;
      }>;

      const violatingIdx = tenants.findIndex(
        (r) => r.tenantId === violatingT.id,
      );
      const compliantIdx = tenants.findIndex(
        (r) => r.tenantId === compliantT.id,
      );
      expect(violatingIdx).toBeGreaterThanOrEqual(0);
      expect(compliantIdx).toBeGreaterThanOrEqual(0);
      expect(violatingIdx).toBeLessThan(compliantIdx);
    } finally {
      await prisma.user.deleteMany({
        where: { tenantId: { in: [compliantT.id, violatingT.id] } },
      });
      await prisma.tenant.delete({ where: { id: compliantT.id } });
      await prisma.tenant.delete({ where: { id: violatingT.id } });
    }
  });
});
