// Integration test for Pearl §S2.6 (gap row 138) — AI fraud detection routes
// must 404 for tenants whose `featureFlags.aiFraud` is explicitly false, and
// 200 (or any non-404) for tenants where the flag is unset / true.
//
// Modules: middleware/feature-flag.ts (requireFeature gate), routes/ai-fraud.ts
// (the gated router), services/feature-flags.ts (cache + resolution).
//
// Why: Pearl Stage-2 paywall enforcement — tenants without the aiFraud
// entitlement should not learn the route exists (404, not 403).
import { it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import express from "express";
import { describeIfDB, resetDB, getAuthToken, getPrisma } from "../setup";
import { __resetFeatureFlagsCacheForTests } from "../../services/feature-flags";

async function buildTestApp(): Promise<express.Express> {
  const a = express();
  a.use(express.json());
  const { aiFraudRouter } = await import("../../routes/ai-fraud");
  a.use("/api/v1/ai/fraud", aiFraudRouter);
  const { errorHandler } = await import("../../middleware/error");
  a.use(errorHandler);
  return a;
}

let app: express.Express;
let adminToken: string;

describeIfDB("AI Fraud feature-flag gate (Pearl §S2.6 — integration)", () => {
  beforeAll(async () => {
    await resetDB();
    __resetFeatureFlagsCacheForTests();
    // Materialize a tenant + bind the admin user to it so req.tenantId
    // is non-null (isFeatureEnabled short-circuits to `true` otherwise).
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
    // Refresh ADMIN token so it carries the new tenantId claim.
    adminToken = await getAuthToken("ADMIN");
    app = await buildTestApp();
  });

  afterAll(() => {
    __resetFeatureFlagsCacheForTests();
  });

  it("returns 200/2xx on POST /scan when tenant.featureFlags.aiFraud is true", async () => {
    const prisma = await getPrisma();
    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { subdomain: "default" } });
    await prisma.tenant.update({
      where: { id: tenant.id },
      data: { featureFlags: { aiFraud: true } },
    });
    __resetFeatureFlagsCacheForTests();

    const res = await request(app)
      .post("/api/v1/ai/fraud/scan")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ windowDays: 30 });
    // Handler may return 200 (scan ok) or 503 (FraudAlert model not migrated)
    // — both prove the feature gate let the request through. 404 would mean
    // the gate rejected, which is the failure mode this test catches.
    expect(res.status).not.toBe(404);
    expect([200, 503]).toContain(res.status);
  });

  it("returns 404 on POST /scan when tenant.featureFlags.aiFraud is false", async () => {
    const prisma = await getPrisma();
    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { subdomain: "default" } });
    await prisma.tenant.update({
      where: { id: tenant.id },
      data: { featureFlags: { aiFraud: false } },
    });
    __resetFeatureFlagsCacheForTests();

    const res = await request(app)
      .post("/api/v1/ai/fraud/scan")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ windowDays: 30 });
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ success: false, error: "Not found" });
  });
});
