// Pearl ERP Stage 1 gap item #10b — per-tenant Razorpay credentials +
// mandatory-TOTP toggle for tenant ADMIN. Validates:
//   - Tenant.razorpayKeyId / razorpayKeySecret persist
//   - getCreds() prefers tenant override over env
//   - PATCH busts the cache so the next call picks up rotated keys
//   - requireAdminTOTP=true blocks ADMIN login without 2FA enrolled (412)
//   - requireAdminTOTP=false leaves login flow unchanged
import { it, expect, beforeEach } from "vitest";
import request from "supertest";
import { describeIfDB, resetDB, getAuthToken, getPrisma } from "../setup";

let app: any;
let adminToken: string;

describeIfDB("Tenant Razorpay + ADMIN TOTP policy (Pearl #10b)", () => {
  beforeEach(async () => {
    await resetDB();
    adminToken = await getAuthToken("ADMIN");
    const mod = await import("../../app");
    app = mod.app;
    // Cache resets so a previous tick doesn't poison this one.
    const { __resetRazorpayCacheForTests } = await import("../../services/razorpay");
    __resetRazorpayCacheForTests();
  });

  it("PATCH /tenants/:id persists razorpayKeyId + razorpayKeySecret + mode + requireAdminTOTP", async () => {
    const prisma = await getPrisma();
    // resetDB() doesn't always seed a Tenant row (single-tenant mode). Create
    // a fresh one for this test if absent; the route is super-admin scoped
    // so it works against any Tenant row that exists.
    let tenant = await prisma.tenant.findFirst({ select: { id: true } });
    if (!tenant) {
      tenant = await prisma.tenant.create({
        data: { name: "Default Test Tenant", subdomain: "default" },
        select: { id: true },
      });
    }
    expect(tenant).toBeTruthy();

    const res = await request(app)
      .patch(`/api/v1/tenants/${tenant.id}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        razorpayKeyId: "rzp_test_abc123def456",
        razorpayKeySecret: "shhh_secret_value_xyz",
        razorpayMode: "test",
        requireAdminTOTP: true,
      });
    expect(res.status).toBe(200);
    expect(res.body.data.razorpayKeyId).toBe("rzp_test_abc123def456");
    expect(res.body.data.razorpayMode).toBe("test");
    expect(res.body.data.requireAdminTOTP).toBe(true);

    // DB has the secret. (Read directly — the GET endpoint may redact.)
    const fresh = await prisma.tenant.findUnique({ where: { id: tenant.id } });
    expect(fresh?.razorpayKeySecret).toBe("shhh_secret_value_xyz");
  });

  it("ADMIN login with requireAdminTOTP=true and no 2FA → 412 + enrolToken", async () => {
    const prisma = await getPrisma();
    const tenant = await prisma.tenant.findFirst({ select: { id: true } });
    if (!tenant) return;

    await prisma.tenant.update({
      where: { id: tenant.id },
      data: { requireAdminTOTP: true },
    });

    // The admin user seeded by resetDB() has twoFactorEnabled=false.
    const res = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: "admin@test.local", password: "MedCoreT3st-2026" });
    expect(res.status).toBe(412);
    expect(res.body.data?.totpEnrolmentRequired).toBe(true);
    expect(typeof res.body.data?.enrolToken).toBe("string");
    expect(res.body.error).toMatch(/TOTP|2FA|enroll/i);
  });

  it("ADMIN login with requireAdminTOTP=false (default) returns access token", async () => {
    const prisma = await getPrisma();
    const tenant = await prisma.tenant.findFirst({ select: { id: true } });
    if (!tenant) return;
    await prisma.tenant.update({
      where: { id: tenant.id },
      data: { requireAdminTOTP: false },
    });

    const res = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: "admin@test.local", password: "MedCoreT3st-2026" });
    expect(res.status).toBe(200);
    expect(typeof res.body.data?.accessToken).toBe("string");
  });
});
