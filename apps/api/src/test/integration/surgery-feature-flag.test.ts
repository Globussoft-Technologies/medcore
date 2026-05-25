// Pearl §S2.2 + PRD §18 — verifies the `requireFeature("ot")` gate
// on the surgery router (wired in `apps/api/src/routes/surgery.ts`).
// Two cases:
//   1) Default tenant (flag unset → defaults to true) — surgery endpoints reachable (not 404).
//   2) ADMIN PATCHes ot=false — every surgery endpoint must 404 before authorize runs.
import { it, expect, beforeEach } from "vitest";
import request from "supertest";
import { describeIfDB, resetDB, getAuthToken, getPrisma } from "../setup";
import { __resetFeatureFlagsCacheForTests } from "../../services/feature-flags";

let app: any;
let adminToken: string;

describeIfDB("Surgery feature-flag gate (Pearl §S2.2 — integration)", () => {
  beforeEach(async () => {
    await resetDB();
    __resetFeatureFlagsCacheForTests();
    // The PATCH /feature-flags handler's tenant-resolution chain needs a
    // Tenant row to attach overrides to. Mirror the feature-flags.test.ts
    // setup: create the default tenant and link the admin user to it so
    // req.tenantId resolves cleanly on subsequent calls.
    const prisma = await getPrisma();
    let tenant = await prisma.tenant.findUnique({ where: { subdomain: "default" } });
    if (!tenant) {
      tenant = await prisma.tenant.create({
        data: { name: "Default Test Tenant", subdomain: "default" },
      });
    }
    await prisma.user.update({
      where: { email: "admin@test.local" },
      data: { tenantId: tenant.id },
    });
    adminToken = await getAuthToken("ADMIN");
    const mod = await import("../../app");
    app = mod.app;
  });

  it("with ot flag at default (true) the surgery endpoints are reachable (not 404)", async () => {
    const res = await request(app)
      .get("/api/v1/surgery/ots")
      .set("Authorization", `Bearer ${adminToken}`);
    // Whatever the handler returns (200 / 400 / 500 etc.), it MUST NOT be a
    // feature-flag 404. The gate is the only thing this test asserts.
    expect(res.status).not.toBe(404);
  });

  it("with ot flag PATCHed to false every surgery endpoint returns 404", async () => {
    // Disable the OT feature for this tenant.
    const patch = await request(app)
      .patch("/api/v1/feature-flags")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ flags: { ot: false } });
    expect(patch.status).toBe(200);
    expect(patch.body.data.ot).toBe(false);

    // Hit a sampling of surgery endpoints — GET list, GET sub-resource list,
    // and POST create. All MUST 404 before authorize/handler runs.
    const listOts = await request(app)
      .get("/api/v1/surgery/ots")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(listOts.status).toBe(404);

    const listSurgeries = await request(app)
      .get("/api/v1/surgery")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(listSurgeries.status).toBe(404);

    const createOt = await request(app)
      .post("/api/v1/surgery/ots")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ name: "Should-not-create", floor: "3", dailyRate: 1000 });
    expect(createOt.status).toBe(404);
  });
});
