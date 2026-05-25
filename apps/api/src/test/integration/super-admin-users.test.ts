// Integration tests for the cross-tenant super-admin user roster —
// Pearl ERP Stage 1 §8.2 (gap row 208 closure, 2026-05-23).
//
// Covers GET / + PATCH /:id on /api/v1/super-admin/users:
//   - Super-admin (tenantId == null) sees the cross-tenant super-admin
//     set; tenant-bound ADMIN gets 403; PATIENT gets 403.
//   - Filter by active flag + free-text search on name/email.
//   - PATCH deactivate flips isActive and writes
//     SUPER_ADMIN_USER_UPDATED audit row.
//   - PATCH refuses to deactivate the LAST active super-admin (count
//     guard — returns 409).
//   - PATCH refuses to mutate a non-super-admin user (tenantId != null
//     OR role != ADMIN — returns 404 to avoid an oracle on existence).
//
// Like support-tickets.test.ts we mount only the router under test on a
// minimal Express app so global startup hooks aren't exercised, and we
// scope the `beforeEach` cleanup to ONLY the super-admin rows we seed
// (so shared seeds for other suites aren't disturbed).

import { it, expect, beforeAll, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { describeIfDB, resetDB, getPrisma, getAuthToken } from "../setup";
import { superAdminUsersRouter } from "../../routes/super-admin-users";
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
  a.use("/api/v1/super-admin/users", superAdminUsersRouter);
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
  isActive = true,
): Promise<SeedAdmin> {
  const prisma = await getPrisma();
  const email = `sa-roster-${label}-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 6)}@test.local`;
  const user = await prisma.user.create({
    data: {
      email,
      name: `SA Roster Admin (${label})`,
      phone: `9${Math.floor(Math.random() * 1e9)
        .toString()
        .padStart(9, "0")}`,
      passwordHash: await bcrypt.hash("MedCoreT3st-2026", 4),
      role: "ADMIN",
      tenantId: tenantId ?? null,
      isActive,
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

describeIfDB("Super-admin user roster (integration)", () => {
  beforeAll(async () => {
    await resetDB();
    app = buildTestApp();
  });

  beforeEach(async () => {
    const prisma = await getPrisma();
    // Scope cleanup ONLY to rows we seed below — we never touch the
    // global Patient/User table the way other shared seeds rely on it.
    await prisma.auditLog.deleteMany({
      where: { action: "SUPER_ADMIN_USER_UPDATED" },
    });
    await prisma.user.deleteMany({
      where: { email: { startsWith: "sa-roster-" } },
    });
    await ensureDefaultTenant();
  });

  // ── 1. Super-admin lists the cross-tenant set ───────────────────────
  it("super-admin GET / returns all tenantId-null ADMIN rows; supports `active` + `q` filters", async () => {
    const seedSuper = await seedAdmin(null, "seed-super");
    const otherSuper = await seedAdmin(null, "other-super");
    const inactiveSuper = await seedAdmin(null, "inactive-super", false);

    // Sanity: GET / returns all 3 super-admin rows.
    const listRes = await request(app)
      .get("/api/v1/super-admin/users")
      .set("Authorization", `Bearer ${seedSuper.token}`);
    expect(listRes.status).toBe(200);
    expect(listRes.body.success).toBe(true);
    const ids = (listRes.body.data.users as Array<{ id: string }>).map(
      (u) => u.id,
    );
    expect(ids).toContain(seedSuper.userId);
    expect(ids).toContain(otherSuper.userId);
    expect(ids).toContain(inactiveSuper.userId);

    // active=false → only the inactive row.
    const inactiveRes = await request(app)
      .get("/api/v1/super-admin/users?active=false")
      .set("Authorization", `Bearer ${seedSuper.token}`);
    expect(inactiveRes.status).toBe(200);
    const inactiveIds = (
      inactiveRes.body.data.users as Array<{ id: string }>
    ).map((u) => u.id);
    expect(inactiveIds).toContain(inactiveSuper.userId);
    expect(inactiveIds).not.toContain(seedSuper.userId);

    // q=<email-substring> filters; case-insensitive.
    const fragment = otherSuper.email.split("@")[0]!.slice(0, 16);
    const searchRes = await request(app)
      .get(`/api/v1/super-admin/users?q=${encodeURIComponent(fragment)}`)
      .set("Authorization", `Bearer ${seedSuper.token}`);
    expect(searchRes.status).toBe(200);
    const searchIds = (
      searchRes.body.data.users as Array<{ id: string }>
    ).map((u) => u.id);
    expect(searchIds).toContain(otherSuper.userId);
  });

  // ── 2. Tenant-bound ADMIN cannot access the roster ──────────────────
  it("tenant-bound ADMIN (non-default tenant) is 403'd by requireSuperAdmin", async () => {
    const prisma = await getPrisma();
    const t = await prisma.tenant.create({
      data: {
        name: "Tenant For SA Roster Test",
        subdomain: `sa-roster-t-${Math.random().toString(36).slice(2, 7)}`,
        plan: "BASIC",
        active: true,
      },
    });
    const tenantAdmin = await seedAdmin(t.id, "tenant-bound");
    const res = await request(app)
      .get("/api/v1/super-admin/users")
      .set("Authorization", `Bearer ${tenantAdmin.token}`);
    expect(res.status).toBe(403);
    // Cleanup the throwaway tenant so the next test's beforeEach can
    // delete its seed admin via the sa-roster- prefix.
    await prisma.user.deleteMany({ where: { tenantId: t.id } });
    await prisma.tenant.delete({ where: { id: t.id } });
  });

  // ── 3. PATIENT role 403'd ───────────────────────────────────────────
  it("PATIENT is 403'd at authorize(Role.ADMIN)", async () => {
    const patientToken = await getAuthToken("PATIENT");
    const res = await request(app)
      .get("/api/v1/super-admin/users")
      .set("Authorization", `Bearer ${patientToken}`);
    expect(res.status).toBe(403);
  });

  // ── 4. PATCH deactivate flips isActive + writes audit ───────────────
  it("PATCH /:id deactivates a super-admin and writes SUPER_ADMIN_USER_UPDATED audit row", async () => {
    const prisma = await getPrisma();
    const caller = await seedAdmin(null, "caller");
    const target = await seedAdmin(null, "to-deactivate");
    // Need ANOTHER active super-admin so the count-guard doesn't fire.
    await seedAdmin(null, "keep-active");

    const patchRes = await request(app)
      .patch(`/api/v1/super-admin/users/${target.userId}`)
      .set("Authorization", `Bearer ${caller.token}`)
      .send({ active: false });
    expect(patchRes.status).toBe(200);
    expect(patchRes.body.success).toBe(true);
    expect(patchRes.body.data.isActive).toBe(false);

    const audit = await waitForAuditFlush(prisma, {
      action: "SUPER_ADMIN_USER_UPDATED",
      entity: "user",
      entityId: target.userId,
    });
    expect(audit.action).toBe("SUPER_ADMIN_USER_UPDATED");

    // DB matches the response.
    const dbRow = await prisma.user.findUnique({
      where: { id: target.userId },
      select: { isActive: true },
    });
    expect(dbRow?.isActive).toBe(false);
  });

  // ── 5. Last-active count guard — 409 ────────────────────────────────
  it("refuses to deactivate the LAST active super-admin (409)", async () => {
    const prisma = await getPrisma();
    // Wipe ANY other tenantId-null ADMIN seeded by resetDB so this
    // test's "last active" claim is real. The beforeEach already
    // cleaned the sa-roster- prefix; here we additionally null-out
    // any pre-existing super-admins so the count guard fires
    // deterministically.
    await prisma.user.deleteMany({
      where: { tenantId: null, role: "ADMIN" },
    });
    const lone = await seedAdmin(null, "lone");

    const patchRes = await request(app)
      .patch(`/api/v1/super-admin/users/${lone.userId}`)
      .set("Authorization", `Bearer ${lone.token}`)
      .send({ active: false });
    expect(patchRes.status).toBe(409);
    expect(patchRes.body.error).toMatch(/last active super-admin/i);

    // Untouched in the DB.
    const dbRow = await prisma.user.findUnique({
      where: { id: lone.userId },
      select: { isActive: true },
    });
    expect(dbRow?.isActive).toBe(true);
  });

  // ── 6. PATCH refuses non-super-admin target ─────────────────────────
  it("PATCH /:id returns 404 when the target is not a super-admin (tenant-bound ADMIN)", async () => {
    const prisma = await getPrisma();
    const caller = await seedAdmin(null, "caller-2");
    await seedAdmin(null, "keep-active-2");
    const t = await prisma.tenant.create({
      data: {
        name: "Tenant For SA Roster Negative Test",
        subdomain: `sa-roster-neg-${Math.random().toString(36).slice(2, 7)}`,
        plan: "BASIC",
        active: true,
      },
    });
    const tenantAdmin = await seedAdmin(t.id, "neg-tenant-admin");

    const patchRes = await request(app)
      .patch(`/api/v1/super-admin/users/${tenantAdmin.userId}`)
      .set("Authorization", `Bearer ${caller.token}`)
      .send({ active: false });
    expect(patchRes.status).toBe(404);
    // Untouched.
    const dbRow = await prisma.user.findUnique({
      where: { id: tenantAdmin.userId },
      select: { isActive: true },
    });
    expect(dbRow?.isActive).toBe(true);

    await prisma.user.deleteMany({ where: { tenantId: t.id } });
    await prisma.tenant.delete({ where: { id: t.id } });
  });
});
