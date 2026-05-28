// Pearl ERP Stage 1 §8.2 row 211 — mandatory 2FA enforcement on login for
// the ADMIN role when tenant.requireAdminTOTP=true.
//
// What this covers (sister file `tenant-razorpay-totp.test.ts` proved the
// PATCH + the basic 412 / 200 surface; this file fills the role-matrix and
// audit-row gaps that row 211 specifically calls out):
//   - ADMIN in a tenant with requireAdminTOTP=true AND no twoFactorEnabled
//     → 412 + enrolToken AND a `LOGIN_BLOCKED_TOTP_REQUIRED` audit row
//   - ADMIN in a tenant with requireAdminTOTP=false → 200 + accessToken
//   - NURSE (non-ADMIN) in a tenant with requireAdminTOTP=true → 200 +
//     accessToken (mandatory TOTP is ADMIN-scoped, all other roles pass)
//   - ADMIN with twoFactorEnabled=true in a tenant with requireAdminTOTP=true
//     → existing 2FA-temp-token flow (twoFactorRequired:true), NOT blocked
import { it, expect, beforeEach } from "vitest";
import request from "supertest";
import bcrypt from "bcryptjs";
import { describeIfDB, resetDB, getPrisma } from "../setup";
import { waitForAuditFlush } from "../helpers/audit-wait";

let app: any;

describeIfDB("Mandatory ADMIN TOTP enforcement on login (Pearl §8.2 row 211)", () => {
  beforeEach(async () => {
    await resetDB();
    const mod = await import("../../app");
    app = mod.app;
  });

  async function getOrCreateTenant(requireAdminTOTP: boolean) {
    const prisma = await getPrisma();
    let tenant = await prisma.tenant.findFirst({ select: { id: true } });
    if (!tenant) {
      tenant = await prisma.tenant.create({
        data: { name: "Default Test Tenant", subdomain: "default" },
        select: { id: true },
      });
    }
    await prisma.tenant.update({
      where: { id: tenant.id },
      data: { requireAdminTOTP },
    });
    return tenant.id;
  }

  it("ADMIN sign-in blocked 412 when tenant.requireAdminTOTP=true and user not enrolled; emits LOGIN_BLOCKED_TOTP_REQUIRED audit row", async () => {
    const prisma = await getPrisma();
    const tenantId = await getOrCreateTenant(true);

    // Pin the seeded admin onto this tenant so the handler can see the toggle.
    const admin = await prisma.user.update({
      where: { email: "admin@test.local" },
      data: { tenantId, twoFactorEnabled: false, twoFactorSecret: null },
    });

    const res = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: "admin@test.local", password: "MedCoreT3st-2026" });

    expect(res.status).toBe(412);
    expect(res.body.success).toBe(false);
    expect(res.body.data?.totpEnrolmentRequired).toBe(true);
    expect(typeof res.body.data?.enrolToken).toBe("string");
    // 2026-05 — the user-facing message was rewritten to drop internal
    // jargon ("TOTP / enrolToken") in favour of plain language. The
    // regex now matches either the legacy keywords or "two-factor" /
    // "two factor authentication" so both eras of message pass.
    expect(res.body.error).toMatch(/TOTP|2FA|enroll|two[- ]factor/i);

    // Pre-auth login path doesn't have req.user set, so the audit row's
    // userId column is null. Only match on action+entity+entityId.
    const auditRow = await waitForAuditFlush(prisma, {
      action: "LOGIN_BLOCKED_TOTP_REQUIRED",
      entity: "user",
      entityId: admin.id,
    });
    expect(auditRow).toBeTruthy();
  });

  it("ADMIN sign-in succeeds (200 + accessToken) when tenant.requireAdminTOTP=false", async () => {
    const prisma = await getPrisma();
    const tenantId = await getOrCreateTenant(false);
    await prisma.user.update({
      where: { email: "admin@test.local" },
      data: { tenantId, twoFactorEnabled: false, twoFactorSecret: null },
    });

    const res = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: "admin@test.local", password: "MedCoreT3st-2026" });

    expect(res.status).toBe(200);
    // Login response nests tokens at data.tokens.accessToken (see auth.ts:1001).
    expect(typeof res.body.data?.tokens?.accessToken).toBe("string");
  });

  it("NURSE sign-in succeeds even when tenant.requireAdminTOTP=true (mandatory TOTP is ADMIN-scoped)", async () => {
    const prisma = await getPrisma();
    const tenantId = await getOrCreateTenant(true);

    // Seed a NURSE on this tenant; resetDB() only mints the ADMIN.
    await prisma.user.create({
      data: {
        email: "nurse-totp@test.local",
        name: "Test Nurse",
        phone: "9000000001",
        passwordHash: await bcrypt.hash("MedCoreT3st-2026", 4),
        role: "NURSE",
        tenantId,
        twoFactorEnabled: false,
      },
    });

    const res = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: "nurse-totp@test.local", password: "MedCoreT3st-2026" });

    expect(res.status).toBe(200);
    // Login response nests tokens at data.tokens.accessToken (see auth.ts:1001).
    expect(typeof res.body.data?.tokens?.accessToken).toBe("string");
  });

  it("ADMIN with twoFactorEnabled=true falls through to the existing 2FA prompt (not blocked)", async () => {
    const prisma = await getPrisma();
    const tenantId = await getOrCreateTenant(true);

    await prisma.user.update({
      where: { email: "admin@test.local" },
      data: {
        tenantId,
        twoFactorEnabled: true,
        // The handler's 2FA branch requires twoFactorSecret to be present;
        // a non-empty placeholder is enough for the routing decision here
        // (we are NOT verifying a real TOTP code in this test).
        twoFactorSecret: "JBSWY3DPEHPK3PXP",
      },
    });

    const res = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: "admin@test.local", password: "MedCoreT3st-2026" });

    expect(res.status).toBe(200);
    expect(res.body.data?.twoFactorRequired).toBe(true);
    expect(typeof res.body.data?.tempToken).toBe("string");
    // Critically: NOT the enrolment-required shape.
    expect(res.body.data?.totpEnrolmentRequired).toBeUndefined();
  });
});
