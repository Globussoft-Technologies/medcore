// Integration tests for Pearl ERP Stage 1 §5.1 gap item #4
// piece 1 of 4 — CampaignAudience CRUD API.
//
// What's covered:
//   1. POST/GET/GET-detail/PATCH happy path
//   2. PATCH active=false soft-deactivates (no DELETE endpoint exists)
//   3. RBAC sweep — RECEPTION cannot POST/GET/PATCH (403)
//   4. Multi-tenant isolation — tenant A's audiences are not in tenant B's list
//   5. The `rules` Json field round-trips
import { it, expect, beforeAll } from "vitest";
import request from "supertest";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { describeIfDB, resetDB, getPrisma } from "../setup";
import { __resetTenantValidationCacheForTests } from "../../middleware/tenant";

const JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret-do-not-use-in-prod";

let app: any;
let tenantAId: string;
let tenantBId: string;
let adminAToken: string;
let adminBToken: string;
let receptionAToken: string;

function signWith(role: string, userId: string, email: string, tenantId: string | null) {
  return jwt.sign({ userId, email, role, tenantId: tenantId ?? null }, JWT_SECRET, {
    expiresIn: "1h",
  });
}

describeIfDB("CampaignAudiences API (Pearl §5.1 piece 1 of 4 — integration)", () => {
  beforeAll(async () => {
    await resetDB();
    __resetTenantValidationCacheForTests();

    const prisma = await getPrisma();
    const passwordHash = await bcrypt.hash("MedCoreT3st-2026", 4);
    const ts = Date.now();

    const tenantA = await prisma.tenant.create({
      data: {
        name: "Tenant A Aud",
        subdomain: `tenant-a-aud-${ts}`,
        plan: "BASIC",
        active: true,
      },
    });
    const tenantB = await prisma.tenant.create({
      data: {
        name: "Tenant B Aud",
        subdomain: `tenant-b-aud-${ts}`,
        plan: "BASIC",
        active: true,
      },
    });
    tenantAId = tenantA.id;
    tenantBId = tenantB.id;

    const adminA = await prisma.user.create({
      data: {
        email: `admin-a-aud-${ts}@test.local`,
        name: "Admin A Aud",
        phone: "9200000010",
        passwordHash,
        role: "ADMIN",
        tenantId: tenantAId,
      },
    });
    const adminB = await prisma.user.create({
      data: {
        email: `admin-b-aud-${ts}@test.local`,
        name: "Admin B Aud",
        phone: "9200000011",
        passwordHash,
        role: "ADMIN",
        tenantId: tenantBId,
      },
    });
    const receptionA = await prisma.user.create({
      data: {
        email: `reception-a-aud-${ts}@test.local`,
        name: "Reception A Aud",
        phone: "9200000012",
        passwordHash,
        role: "RECEPTION",
        tenantId: tenantAId,
      },
    });
    adminAToken = signWith("ADMIN", adminA.id, adminA.email, tenantAId);
    adminBToken = signWith("ADMIN", adminB.id, adminB.email, tenantBId);
    receptionAToken = signWith("RECEPTION", receptionA.id, receptionA.email, tenantAId);

    const mod = await import("../../app");
    app = mod.app;
  });

  it("POST creates an audience with rules", async () => {
    const res = await request(app)
      .post("/api/v1/campaign-audiences")
      .set("Authorization", `Bearer ${adminAToken}`)
      .send({
        name: "HTN > 55, no visit 90d",
        description: "Re-engagement cohort",
        rules: {
          filters: [
            { field: "age", op: "gt", value: 55 },
            { field: "chronicConditions.code", op: "eq", value: "HTN" },
          ],
        },
      });
    expect(res.status).toBe(201);
    expect(res.body.data.name).toBe("HTN > 55, no visit 90d");
    expect(res.body.data.active).toBe(true);
    expect(res.body.data.rules).toMatchObject({
      filters: expect.arrayContaining([
        expect.objectContaining({ field: "age", op: "gt", value: 55 }),
      ]),
    });
    expect(res.body.data.tenantId).toBe(tenantAId);
  });

  it("GET / lists audiences for the tenant", async () => {
    const res = await request(app)
      .get("/api/v1/campaign-audiences")
      .set("Authorization", `Bearer ${adminAToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThan(0);
  });

  it("GET /:id returns one audience", async () => {
    const list = await request(app)
      .get("/api/v1/campaign-audiences")
      .set("Authorization", `Bearer ${adminAToken}`);
    const a = list.body.data[0];

    const res = await request(app)
      .get(`/api/v1/campaign-audiences/${a.id}`)
      .set("Authorization", `Bearer ${adminAToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(a.id);
  });

  it("PATCH updates description + rules", async () => {
    const list = await request(app)
      .get("/api/v1/campaign-audiences")
      .set("Authorization", `Bearer ${adminAToken}`);
    const a = list.body.data[0];

    const res = await request(app)
      .patch(`/api/v1/campaign-audiences/${a.id}`)
      .set("Authorization", `Bearer ${adminAToken}`)
      .send({
        description: "Updated description",
        rules: { filters: [{ field: "age", op: "gte", value: 60 }] },
      });
    expect(res.status).toBe(200);
    expect(res.body.data.description).toBe("Updated description");
    expect(res.body.data.rules).toMatchObject({
      filters: [{ field: "age", op: "gte", value: 60 }],
    });
  });

  it("PATCH active=false soft-deactivates", async () => {
    const list = await request(app)
      .get("/api/v1/campaign-audiences")
      .set("Authorization", `Bearer ${adminAToken}`);
    const a = list.body.data[0];

    const res = await request(app)
      .patch(`/api/v1/campaign-audiences/${a.id}`)
      .set("Authorization", `Bearer ${adminAToken}`)
      .send({ active: false });
    expect(res.status).toBe(200);
    expect(res.body.data.active).toBe(false);

    // Filtering with active=true should exclude it.
    const filtered = await request(app)
      .get("/api/v1/campaign-audiences?active=true")
      .set("Authorization", `Bearer ${adminAToken}`);
    expect(filtered.status).toBe(200);
    expect(filtered.body.data.find((x: any) => x.id === a.id)).toBeUndefined();
  });

  it("RBAC: RECEPTION cannot POST (403)", async () => {
    const res = await request(app)
      .post("/api/v1/campaign-audiences")
      .set("Authorization", `Bearer ${receptionAToken}`)
      .send({ name: "Sneaky", rules: {} });
    expect(res.status).toBe(403);
  });

  it("RBAC: RECEPTION cannot GET (403)", async () => {
    const res = await request(app)
      .get("/api/v1/campaign-audiences")
      .set("Authorization", `Bearer ${receptionAToken}`);
    expect(res.status).toBe(403);
  });

  it("RBAC: RECEPTION cannot PATCH (403)", async () => {
    const list = await request(app)
      .get("/api/v1/campaign-audiences")
      .set("Authorization", `Bearer ${adminAToken}`);
    const a = list.body.data[0];

    const res = await request(app)
      .patch(`/api/v1/campaign-audiences/${a.id}`)
      .set("Authorization", `Bearer ${receptionAToken}`)
      .send({ name: "Hijacked" });
    expect(res.status).toBe(403);
  });

  it("Multi-tenant: tenant A's audiences are not in tenant B's list", async () => {
    const post = await request(app)
      .post("/api/v1/campaign-audiences")
      .set("Authorization", `Bearer ${adminBToken}`)
      .send({ name: "Tenant B audience", rules: {} });
    expect(post.status).toBe(201);

    const listA = await request(app)
      .get("/api/v1/campaign-audiences")
      .set("Authorization", `Bearer ${adminAToken}`);
    for (const a of listA.body.data) expect(a.tenantId).toBe(tenantAId);

    const listB = await request(app)
      .get("/api/v1/campaign-audiences")
      .set("Authorization", `Bearer ${adminBToken}`);
    for (const a of listB.body.data) expect(a.tenantId).toBe(tenantBId);

    // GET-detail on tenant B's audience with tenant A's token → 404.
    const bId = listB.body.data[0].id;
    const cross = await request(app)
      .get(`/api/v1/campaign-audiences/${bId}`)
      .set("Authorization", `Bearer ${adminAToken}`);
    expect(cross.status).toBe(404);
  });
});
