// Integration tests for Pearl ERP Stage 1 §7.2 + §8.1 gap item #2
// piece 1 of 3 — per-tenant Branch CRUD API.
//
// What's covered:
//   1. POST creates a branch + first branch is auto-isDefault
//   2. POST a second branch with isDefault=true atomically transfers
//      the default away from the first
//   3. PATCH isDefault=true on an existing non-default branch
//      transfers the default
//   4. PATCH that tries to clear the default flag directly is 409
//   5. DELETE refuses to soft-delete the default (409)
//   6. DELETE succeeds on a non-default branch (sets active=false)
//   7. RBAC: RECEPTION cannot POST/PATCH/DELETE (403)
//   8. Multi-tenant isolation: Tenant A's branches are not visible
//      in Tenant B's list / GET-detail / PATCH / DELETE.
//   9. Unique constraint on (tenantId, code) → 409 on duplicate.
//
// Uses the same direct-prisma seeding pattern as cross-tenant.test.ts
// to mint two tenants + per-tenant ADMIN users, and signs JWTs by
// hand (same shape as services/jwt.ts) so both tenants are exercised
// in the same beforeAll block.
import { it, expect, beforeAll } from "vitest";
import request from "supertest";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { describeIfDB, resetDB, getPrisma, getAuthToken } from "../setup";
import { __resetTenantValidationCacheForTests } from "../../middleware/tenant";

const JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret-do-not-use-in-prod";

let app: any;
let tenantAId: string;
let tenantBId: string;
let adminAToken: string;
let adminBToken: string;
let receptionAToken: string;

function signAdmin(userId: string, email: string, tenantId: string | null) {
  return jwt.sign(
    { userId, email, role: "ADMIN", tenantId: tenantId ?? null },
    JWT_SECRET,
    { expiresIn: "1h" },
  );
}

function signReception(userId: string, email: string, tenantId: string | null) {
  return jwt.sign(
    { userId, email, role: "RECEPTION", tenantId: tenantId ?? null },
    JWT_SECRET,
    { expiresIn: "1h" },
  );
}

describeIfDB("Branches API (Pearl §7.2 + §8.1 — integration)", () => {
  beforeAll(async () => {
    await resetDB();
    __resetTenantValidationCacheForTests();

    const prisma = await getPrisma();
    const passwordHash = await bcrypt.hash("MedCoreT3st-2026", 4);

    // Two tenants
    const tenantA = await prisma.tenant.create({
      data: {
        name: "Tenant A Hospital",
        subdomain: `tenant-a-branch-${Date.now()}`,
        plan: "BASIC",
        active: true,
      },
    });
    const tenantB = await prisma.tenant.create({
      data: {
        name: "Tenant B Hospital",
        subdomain: `tenant-b-branch-${Date.now()}`,
        plan: "BASIC",
        active: true,
      },
    });
    tenantAId = tenantA.id;
    tenantBId = tenantB.id;

    // ADMIN user per tenant
    const adminA = await prisma.user.create({
      data: {
        email: `admin-a-branch-${Date.now()}@test.local`,
        name: "Admin A",
        phone: "9000000001",
        passwordHash,
        role: "ADMIN",
        tenantId: tenantAId,
      },
    });
    const adminB = await prisma.user.create({
      data: {
        email: `admin-b-branch-${Date.now()}@test.local`,
        name: "Admin B",
        phone: "9000000002",
        passwordHash,
        role: "ADMIN",
        tenantId: tenantBId,
      },
    });
    adminAToken = signAdmin(adminA.id, adminA.email, tenantAId);
    adminBToken = signAdmin(adminB.id, adminB.email, tenantBId);

    // RECEPTION user on Tenant A — for RBAC tests.
    const receptionA = await prisma.user.create({
      data: {
        email: `reception-a-branch-${Date.now()}@test.local`,
        name: "Reception A",
        phone: "9100000001",
        passwordHash,
        role: "RECEPTION",
        tenantId: tenantAId,
      },
    });
    receptionAToken = signReception(receptionA.id, receptionA.email, tenantAId);

    const mod = await import("../../app");
    app = mod.app;
  });

  it("POST creates the first branch and auto-flags it as isDefault", async () => {
    const res = await request(app)
      .post("/api/v1/branches")
      .set("Authorization", `Bearer ${adminAToken}`)
      .send({ name: "Main Branch", code: "MAIN", city: "Bangalore" });
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.name).toBe("Main Branch");
    expect(res.body.data.code).toBe("MAIN");
    expect(res.body.data.isDefault).toBe(true); // auto-promoted, even though body omitted it
    expect(res.body.data.tenantId).toBe(tenantAId);
  });

  it("POST a second branch with isDefault=true transfers the default atomically", async () => {
    const res = await request(app)
      .post("/api/v1/branches")
      .set("Authorization", `Bearer ${adminAToken}`)
      .send({ name: "Jayanagar Branch", code: "JKR", isDefault: true });
    expect(res.status).toBe(201);
    expect(res.body.data.isDefault).toBe(true);

    // Verify the old default is no longer default.
    const list = await request(app)
      .get("/api/v1/branches")
      .set("Authorization", `Bearer ${adminAToken}`);
    expect(list.status).toBe(200);
    const defaults = list.body.data.filter((b: any) => b.isDefault);
    expect(defaults).toHaveLength(1);
    expect(defaults[0].code).toBe("JKR");
  });

  it("POST a third branch without isDefault keeps the current default untouched", async () => {
    const res = await request(app)
      .post("/api/v1/branches")
      .set("Authorization", `Bearer ${adminAToken}`)
      .send({ name: "BTM Branch", code: "BTM" });
    expect(res.status).toBe(201);
    expect(res.body.data.isDefault).toBe(false);

    const list = await request(app)
      .get("/api/v1/branches")
      .set("Authorization", `Bearer ${adminAToken}`);
    const defaults = list.body.data.filter((b: any) => b.isDefault);
    expect(defaults).toHaveLength(1);
    expect(defaults[0].code).toBe("JKR");
  });

  it("PATCH isDefault=true on a non-default branch transfers the default", async () => {
    const list = await request(app)
      .get("/api/v1/branches")
      .set("Authorization", `Bearer ${adminAToken}`);
    const btm = list.body.data.find((b: any) => b.code === "BTM");
    expect(btm).toBeTruthy();

    const res = await request(app)
      .patch(`/api/v1/branches/${btm.id}`)
      .set("Authorization", `Bearer ${adminAToken}`)
      .send({ isDefault: true });
    expect(res.status).toBe(200);
    expect(res.body.data.isDefault).toBe(true);

    const after = await request(app)
      .get("/api/v1/branches")
      .set("Authorization", `Bearer ${adminAToken}`);
    const defaults = after.body.data.filter((b: any) => b.isDefault);
    expect(defaults).toHaveLength(1);
    expect(defaults[0].code).toBe("BTM");
  });

  it("PATCH that tries to flip the current default to isDefault=false is rejected (409)", async () => {
    const list = await request(app)
      .get("/api/v1/branches")
      .set("Authorization", `Bearer ${adminAToken}`);
    const currentDefault = list.body.data.find((b: any) => b.isDefault);
    expect(currentDefault).toBeTruthy();

    const res = await request(app)
      .patch(`/api/v1/branches/${currentDefault.id}`)
      .set("Authorization", `Bearer ${adminAToken}`)
      .send({ isDefault: false });
    expect(res.status).toBe(409);
  });

  it("DELETE refuses to soft-delete the default branch (409)", async () => {
    const list = await request(app)
      .get("/api/v1/branches")
      .set("Authorization", `Bearer ${adminAToken}`);
    const currentDefault = list.body.data.find((b: any) => b.isDefault);

    const res = await request(app)
      .delete(`/api/v1/branches/${currentDefault.id}`)
      .set("Authorization", `Bearer ${adminAToken}`);
    expect(res.status).toBe(409);
  });

  it("DELETE on a non-default branch sets active=false", async () => {
    const list = await request(app)
      .get("/api/v1/branches")
      .set("Authorization", `Bearer ${adminAToken}`);
    const nonDefault = list.body.data.find((b: any) => !b.isDefault);
    expect(nonDefault).toBeTruthy();

    const res = await request(app)
      .delete(`/api/v1/branches/${nonDefault.id}`)
      .set("Authorization", `Bearer ${adminAToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.active).toBe(false);
  });

  it("RBAC: RECEPTION cannot POST a branch (403)", async () => {
    const res = await request(app)
      .post("/api/v1/branches")
      .set("Authorization", `Bearer ${receptionAToken}`)
      .send({ name: "Sneaky Branch", code: "SNK" });
    expect(res.status).toBe(403);
  });

  it("RBAC: RECEPTION can GET list (any authed role)", async () => {
    const res = await request(app)
      .get("/api/v1/branches")
      .set("Authorization", `Bearer ${receptionAToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it("RBAC: RECEPTION cannot PATCH a branch (403)", async () => {
    const list = await request(app)
      .get("/api/v1/branches")
      .set("Authorization", `Bearer ${adminAToken}`);
    const any = list.body.data[0];

    const res = await request(app)
      .patch(`/api/v1/branches/${any.id}`)
      .set("Authorization", `Bearer ${receptionAToken}`)
      .send({ name: "Renamed Sneakily" });
    expect(res.status).toBe(403);
  });

  it("RBAC: RECEPTION cannot DELETE a branch (403)", async () => {
    const list = await request(app)
      .get("/api/v1/branches")
      .set("Authorization", `Bearer ${adminAToken}`);
    const nonDefault = list.body.data.find((b: any) => !b.isDefault && b.active);

    if (nonDefault) {
      const res = await request(app)
        .delete(`/api/v1/branches/${nonDefault.id}`)
        .set("Authorization", `Bearer ${receptionAToken}`);
      expect(res.status).toBe(403);
    }
  });

  it("Multi-tenant: Tenant A's branches are not in Tenant B's list", async () => {
    // Seed a branch on Tenant B so the list isn't trivially empty.
    const post = await request(app)
      .post("/api/v1/branches")
      .set("Authorization", `Bearer ${adminBToken}`)
      .send({ name: "Tenant B Main", code: "MAIN" });
    expect(post.status).toBe(201);

    const listA = await request(app)
      .get("/api/v1/branches")
      .set("Authorization", `Bearer ${adminAToken}`);
    expect(listA.status).toBe(200);
    for (const b of listA.body.data) {
      expect(b.tenantId).toBe(tenantAId);
    }

    const listB = await request(app)
      .get("/api/v1/branches")
      .set("Authorization", `Bearer ${adminBToken}`);
    expect(listB.status).toBe(200);
    for (const b of listB.body.data) {
      expect(b.tenantId).toBe(tenantBId);
    }
  });

  it("Multi-tenant: Tenant A cannot GET / PATCH / DELETE Tenant B's branch", async () => {
    const listB = await request(app)
      .get("/api/v1/branches")
      .set("Authorization", `Bearer ${adminBToken}`);
    const bBranch = listB.body.data[0];
    expect(bBranch).toBeTruthy();

    // GET — 404 (not 403; we don't even acknowledge it exists)
    const getRes = await request(app)
      .get(`/api/v1/branches/${bBranch.id}`)
      .set("Authorization", `Bearer ${adminAToken}`);
    expect(getRes.status).toBe(404);

    // PATCH — 404
    const patchRes = await request(app)
      .patch(`/api/v1/branches/${bBranch.id}`)
      .set("Authorization", `Bearer ${adminAToken}`)
      .send({ name: "Hijacked" });
    expect(patchRes.status).toBe(404);

    // DELETE — 404
    const delRes = await request(app)
      .delete(`/api/v1/branches/${bBranch.id}`)
      .set("Authorization", `Bearer ${adminAToken}`);
    expect(delRes.status).toBe(404);
  });

  it("POST with a duplicate (tenantId, code) returns 409", async () => {
    // The existing JKR branch on Tenant A — POST another with code=JKR.
    const res = await request(app)
      .post("/api/v1/branches")
      .set("Authorization", `Bearer ${adminAToken}`)
      .send({ name: "Dup Branch", code: "JKR" });
    expect(res.status).toBe(409);
  });

  it("Audit row written on POST (eventually consistent — safeAudit is fire-and-forget)", async () => {
    // Use the existing seed admin (admin@test.local from resetDB) via getAuthToken.
    // That admin has tenantId=null and will resolve to the default tenant; since
    // we don't have a 'default' subdomain seeded here, we explicitly use the
    // Tenant A admin which already worked above.
    const post = await request(app)
      .post("/api/v1/branches")
      .set("Authorization", `Bearer ${adminAToken}`)
      .send({ name: "Audit Probe Branch", code: "AUD" });
    expect(post.status).toBe(201);

    const prisma = await getPrisma();
    let audit: any = null;
    for (let i = 0; i < 40; i++) {
      audit = await prisma.auditLog.findFirst({
        where: { action: "BRANCH_CREATE", entity: "branch", entityId: post.body.data.id },
      });
      if (audit) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(audit).toBeTruthy();
    // Silence the unused-import linter for getAuthToken (kept for future tests).
    void getAuthToken;
  });
});
