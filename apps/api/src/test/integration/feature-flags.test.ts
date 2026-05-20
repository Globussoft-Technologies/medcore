// Integration tests for Pearl ERP Stage 1 §6 + §18 gap item #9 —
// per-tenant feature flags. Covers: default = all enabled; ADMIN can
// PATCH to disable a flag; disabled flag causes the gated route to
// 404; non-ADMIN cannot PATCH; AuditLog row written on update.
import { it, expect, beforeEach } from "vitest";
import request from "supertest";
import { describeIfDB, resetDB, getAuthToken, getPrisma } from "../setup";
import { __resetFeatureFlagsCacheForTests } from "../../services/feature-flags";

let app: any;
let adminToken: string;
let receptionToken: string;

describeIfDB("Feature Flags API (Pearl §6 + §18 — integration)", () => {
  beforeEach(async () => {
    await resetDB();
    __resetFeatureFlagsCacheForTests();
    adminToken = await getAuthToken("ADMIN");
    receptionToken = await getAuthToken("RECEPTION");
    const mod = await import("../../app");
    app = mod.app;
  });

  it("GET /feature-flags returns every key with defaults when nothing is stored", async () => {
    const res = await request(app)
      .get("/api/v1/feature-flags")
      .set("Authorization", `Bearer ${receptionToken}`);
    expect(res.status).toBe(200);
    // Default = all true.
    expect(res.body.data.ipd).toBe(true);
    expect(res.body.data.telemedicine).toBe(true);
    expect(res.body.data.aiRadiology).toBe(true);
  });

  it("PATCH /feature-flags as ADMIN disables a flag + writes AuditLog", async () => {
    const prisma = await getPrisma();
    const res = await request(app)
      .patch("/api/v1/feature-flags")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ flags: { telemedicine: false } });
    expect(res.status).toBe(200);
    expect(res.body.data.telemedicine).toBe(false);
    expect(res.body.data.ipd).toBe(true); // unrelated key untouched

    let audit: any = null;
    for (let i = 0; i < 30; i++) {
      audit = await prisma.auditLog.findFirst({
        where: { action: "TENANT_FEATURE_FLAGS_UPDATE", entity: "tenant" },
      });
      if (audit) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(audit).toBeTruthy();
  });

  it("PATCH /feature-flags rejects RECEPTION (403)", async () => {
    const res = await request(app)
      .patch("/api/v1/feature-flags")
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({ flags: { telemedicine: false } });
    expect(res.status).toBe(403);
  });

  it("disabling 'telemedicine' makes GET /telemedicine/sessions 404", async () => {
    // Before disable: route is reachable (200 or other non-404).
    const before = await request(app)
      .get("/api/v1/telemedicine/sessions")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(before.status).not.toBe(404);

    // Disable the feature.
    const patch = await request(app)
      .patch("/api/v1/feature-flags")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ flags: { telemedicine: false } });
    expect(patch.status).toBe(200);

    // After disable: 404.
    const after = await request(app)
      .get("/api/v1/telemedicine/sessions")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(after.status).toBe(404);
  });

  it("setting a flag to null clears the override (back to default)", async () => {
    // Disable.
    await request(app)
      .patch("/api/v1/feature-flags")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ flags: { ipd: false } });
    let resolved = await request(app)
      .get("/api/v1/feature-flags")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(resolved.body.data.ipd).toBe(false);

    // Null clears.
    await request(app)
      .patch("/api/v1/feature-flags")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ flags: { ipd: null } });
    resolved = await request(app)
      .get("/api/v1/feature-flags")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(resolved.body.data.ipd).toBe(true);
  });
});
