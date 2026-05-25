// Integration tests for the tenant-settings router (apps/api/src/routes/settings.ts).
//
// Modules: routes/settings.ts (branding + integrations CRUD),
// services/tenant-provisioning.ts (tenantConfigKey namespacing helper),
// middleware/sanitize.ts (SCHEMA_REJECT_PATHS entry preventing the global
// HTML-stripper from laundering the #938 payload), middleware/validate.ts
// (Zod refines on hospitalName / logoUrl), middleware/auth.ts (ADMIN-only
// gate via authorize(Role.ADMIN)).
//
// Why: settings.ts is a 303-line zero-coverage router that owns two
// tenant-wide admin surfaces (Branding + Integrations). Per the existing
// XSS partial coverage in input-validation-xss.test.ts, only the two #938
// reject paths were hit. This file pins:
//   - happy path on each of the four endpoints,
//   - Zod validation rejections (empty hospital name, oversize, HTML/script,
//     bad hex color, javascript: scheme, http(s) requirement on logoUrl,
//     unknown integration key both via schema regex AND via the KNOWN list,
//     malformed integrations payload),
//   - RBAC matrix (NURSE/DOCTOR/PATIENT all 403; missing token 401),
//   - the requireTenantId(...) 400 path (admin without tenant context),
//   - cross-tenant isolation — Tenant A's branding write doesn't leak into
//     Tenant B's GET, and integration toggles are scoped via the
//     `tenant:<id>:integration_*` SystemConfig key prefix,
//   - audit-row writes for both PATCH paths (TENANT_BRANDING_UPDATE +
//     TENANT_INTEGRATION_UPDATE) — both routes use the fire-and-forget
//     `auditLog(...).catch(console.error)` shape, so reads MUST go through
//     waitForAuditFlush() per the CLAUDE.md "safeAudit" gotcha.

import { it, expect, beforeAll } from "vitest";
import request from "supertest";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { describeIfDB, resetDB, getAuthToken, getPrisma } from "../setup";
import { waitForAuditFlush } from "../helpers/audit-wait";
import { tenantConfigKey } from "../../services/tenant-provisioning";

const JWT_SECRET =
  process.env.JWT_SECRET || "test-jwt-secret-do-not-use-in-prod";

let app: any;
// Token for the seed admin (tenantId=null) — used for the
// requireTenantId(...) negative-path assertion.
let tenantlessAdminToken: string;
// Token for ADMIN bound to tenantA, primary happy-path subject.
let adminAToken: string;
let adminAUserId: string;
let tenantAId: string;
// Token for ADMIN bound to tenantB, used for cross-tenant isolation cases.
let adminBToken: string;
let tenantBId: string;
// Non-admin tokens for RBAC matrix.
let nurseToken: string;
let doctorToken: string;
let patientToken: string;

function signAdmin(userId: string, email: string, tenantId: string | null) {
  return jwt.sign(
    {
      userId,
      email,
      role: "ADMIN",
      tenantId: tenantId ?? null,
    },
    JWT_SECRET,
    { expiresIn: "1h" },
  );
}

describeIfDB("Tenant Settings API (integration)", () => {
  beforeAll(async () => {
    await resetDB();
    // Seed-admin token (no tenant claim) — used for the 400 negative path.
    tenantlessAdminToken = await getAuthToken("ADMIN");
    nurseToken = await getAuthToken("NURSE");
    doctorToken = await getAuthToken("DOCTOR");
    patientToken = await getAuthToken("PATIENT");

    const prisma = await getPrisma();

    // Two tenants for isolation cases.
    const tenantA = await prisma.tenant.create({
      data: {
        name: "Tenant A Settings Hospital",
        subdomain: `settings-a-${Date.now()}`,
        plan: "BASIC",
        active: true,
      },
    });
    const tenantB = await prisma.tenant.create({
      data: {
        name: "Tenant B Settings Hospital",
        subdomain: `settings-b-${Date.now()}`,
        plan: "BASIC",
        active: true,
      },
    });
    tenantAId = tenantA.id;
    tenantBId = tenantB.id;

    // Per-tenant ADMIN users — written directly with raw Prisma so we can
    // stamp tenantId explicitly. The seed admin from resetDB() stays as the
    // tenant-less control.
    const passwordHash = await bcrypt.hash("MedCoreT3st-2026", 4);
    const adminAEmail = `settings-admin-a-${Date.now()}@test.local`;
    const adminBEmail = `settings-admin-b-${Date.now()}@test.local`;
    const adminA = await prisma.user.create({
      data: {
        email: adminAEmail,
        name: "Settings Admin A",
        phone: "9300000001",
        passwordHash,
        role: "ADMIN",
        tenantId: tenantAId,
      },
    });
    const adminB = await prisma.user.create({
      data: {
        email: adminBEmail,
        name: "Settings Admin B",
        phone: "9300000002",
        passwordHash,
        role: "ADMIN",
        tenantId: tenantBId,
      },
    });
    adminAUserId = adminA.id;
    adminAToken = signAdmin(adminAUserId, adminAEmail, tenantAId);
    adminBToken = signAdmin(adminB.id, adminBEmail, tenantBId);

    // Lazy import so the test JWT_SECRET is picked up.
    const mod = await import("../../app");
    app = mod.app;
  });

  // ─── GET /branding ─────────────────────────────────────────

  it("GET /branding returns the tenant's name + empty branding for a fresh tenant", async () => {
    const res = await request(app)
      .get("/api/v1/settings/branding")
      .set("Authorization", `Bearer ${adminAToken}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.hospitalName).toBe("Tenant A Settings Hospital");
    expect(res.body.data.primaryColor).toBe("");
    expect(res.body.data.logoUrl).toBe("");
  });

  it("GET /branding requires authentication (401)", async () => {
    const res = await request(app).get("/api/v1/settings/branding");
    expect(res.status).toBe(401);
  });

  it("GET /branding denies NURSE (403 — ADMIN-only)", async () => {
    const res = await request(app)
      .get("/api/v1/settings/branding")
      .set("Authorization", `Bearer ${nurseToken}`);
    expect(res.status).toBe(403);
  });

  it("GET /branding denies DOCTOR (403)", async () => {
    const res = await request(app)
      .get("/api/v1/settings/branding")
      .set("Authorization", `Bearer ${doctorToken}`);
    expect(res.status).toBe(403);
  });

  it("GET /branding denies PATIENT (403)", async () => {
    const res = await request(app)
      .get("/api/v1/settings/branding")
      .set("Authorization", `Bearer ${patientToken}`);
    expect(res.status).toBe(403);
  });

  it("GET /branding returns 400 when admin has no tenant context (requireTenantId)", async () => {
    const res = await request(app)
      .get("/api/v1/settings/branding")
      .set("Authorization", `Bearer ${tenantlessAdminToken}`);
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/tenant context/i);
  });

  // ─── PATCH /branding ───────────────────────────────────────

  it("PATCH /branding updates hospital name + persists into Tenant.name + writes audit", async () => {
    const prisma = await getPrisma();
    const res = await request(app)
      .patch("/api/v1/settings/branding")
      .set("Authorization", `Bearer ${adminAToken}`)
      .send({
        hospitalName: "Tenant A — Renamed Hospital",
        primaryColor: "#1e40af",
        logoUrl: "https://cdn.example.com/logo.png",
      });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.hospitalName).toBe("Tenant A — Renamed Hospital");
    expect(res.body.data.primaryColor).toBe("#1e40af");
    expect(res.body.data.logoUrl).toBe("https://cdn.example.com/logo.png");

    // Tenant.name is the canonical source — must be mirrored.
    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantAId },
      select: { name: true },
    });
    expect(tenant?.name).toBe("Tenant A — Renamed Hospital");

    // SystemConfig mirror under the tenant-namespaced key.
    const mirror = await prisma.systemConfig.findUnique({
      where: { key: tenantConfigKey(tenantAId, "hospital_name") },
    });
    expect(mirror?.value).toBe("Tenant A — Renamed Hospital");

    // Branding sub-keys.
    const colorRow = await prisma.systemConfig.findUnique({
      where: { key: tenantConfigKey(tenantAId, "branding_primary_color") },
    });
    expect(colorRow?.value).toBe("#1e40af");
    const logoRow = await prisma.systemConfig.findUnique({
      where: { key: tenantConfigKey(tenantAId, "branding_logo_url") },
    });
    expect(logoRow?.value).toBe("https://cdn.example.com/logo.png");

    // Fire-and-forget audit — use waitForAuditFlush per CLAUDE.md gotcha.
    const audit = await waitForAuditFlush(prisma, {
      action: "TENANT_BRANDING_UPDATE",
      entity: "tenant",
      entityId: tenantAId,
      userId: adminAUserId,
    });
    expect(audit.action).toBe("TENANT_BRANDING_UPDATE");
  });

  it("PATCH /branding rejects empty hospitalName (Issue #717)", async () => {
    const res = await request(app)
      .patch("/api/v1/settings/branding")
      .set("Authorization", `Bearer ${adminAToken}`)
      .send({ hospitalName: "" });
    expect(res.status).toBe(400);
  });

  it("PATCH /branding rejects whitespace-only hospitalName (trim + min(1))", async () => {
    const res = await request(app)
      .patch("/api/v1/settings/branding")
      .set("Authorization", `Bearer ${adminAToken}`)
      .send({ hospitalName: "   " });
    expect(res.status).toBe(400);
  });

  it("PATCH /branding rejects > 200-char hospitalName", async () => {
    const res = await request(app)
      .patch("/api/v1/settings/branding")
      .set("Authorization", `Bearer ${adminAToken}`)
      .send({ hospitalName: "X".repeat(201) });
    expect(res.status).toBe(400);
  });

  it("PATCH /branding rejects <script> in hospitalName (Issue #938)", async () => {
    const res = await request(app)
      .patch("/api/v1/settings/branding")
      .set("Authorization", `Bearer ${adminAToken}`)
      .send({ hospitalName: "Acme <script>alert(1)</script>" });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/HTML|script/i);
  });

  it("PATCH /branding rejects javascript: scheme logoUrl (Issue #938)", async () => {
    const res = await request(app)
      .patch("/api/v1/settings/branding")
      .set("Authorization", `Bearer ${adminAToken}`)
      .send({
        hospitalName: "Acme Hospital",
        logoUrl: "javascript:alert(1)",
      });
    expect(res.status).toBe(400);
  });

  it("PATCH /branding rejects non-http(s) logoUrl scheme (data: URI)", async () => {
    const res = await request(app)
      .patch("/api/v1/settings/branding")
      .set("Authorization", `Bearer ${adminAToken}`)
      .send({
        hospitalName: "Acme Hospital",
        logoUrl: "data:image/png;base64,AAA",
      });
    expect(res.status).toBe(400);
  });

  it("PATCH /branding rejects malformed primaryColor (not a hex)", async () => {
    const res = await request(app)
      .patch("/api/v1/settings/branding")
      .set("Authorization", `Bearer ${adminAToken}`)
      .send({
        hospitalName: "Acme Hospital",
        primaryColor: "blue",
      });
    expect(res.status).toBe(400);
  });

  it("PATCH /branding accepts empty primaryColor + empty logoUrl (z.literal('')) ", async () => {
    const res = await request(app)
      .patch("/api/v1/settings/branding")
      .set("Authorization", `Bearer ${adminAToken}`)
      .send({
        hospitalName: "Acme Minimal",
        primaryColor: "",
        logoUrl: "",
      });
    expect(res.status).toBe(200);
    expect(res.body.data.hospitalName).toBe("Acme Minimal");
    expect(res.body.data.primaryColor).toBe("");
    expect(res.body.data.logoUrl).toBe("");
  });

  it("PATCH /branding denies NURSE (403)", async () => {
    const res = await request(app)
      .patch("/api/v1/settings/branding")
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({ hospitalName: "Nurse Hospital" });
    expect(res.status).toBe(403);
  });

  it("PATCH /branding denies PATIENT (403)", async () => {
    const res = await request(app)
      .patch("/api/v1/settings/branding")
      .set("Authorization", `Bearer ${patientToken}`)
      .send({ hospitalName: "Patient Hospital" });
    expect(res.status).toBe(403);
  });

  it("PATCH /branding requires authentication (401)", async () => {
    const res = await request(app)
      .patch("/api/v1/settings/branding")
      .send({ hospitalName: "Anon Hospital" });
    expect(res.status).toBe(401);
  });

  // ─── GET /integrations ─────────────────────────────────────

  it("GET /integrations returns the KNOWN_INTEGRATIONS list with default-disabled", async () => {
    const res = await request(app)
      .get("/api/v1/settings/integrations")
      .set("Authorization", `Bearer ${adminAToken}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data.integrations)).toBe(true);
    const keys = res.body.data.integrations.map((i: any) => i.key);
    expect(keys).toEqual(
      expect.arrayContaining([
        "sendgrid",
        "twilio",
        "razorpay",
        "abdm",
        "fhir",
        "hl7v2",
        "sentry",
      ]),
    );
    // No config rows yet — every entry must be disabled + not configured.
    for (const entry of res.body.data.integrations) {
      expect(entry.enabled).toBe(false);
      expect(entry.configured).toBe(false);
    }
  });

  it("GET /integrations denies NURSE (403)", async () => {
    const res = await request(app)
      .get("/api/v1/settings/integrations")
      .set("Authorization", `Bearer ${nurseToken}`);
    expect(res.status).toBe(403);
  });

  it("GET /integrations requires authentication (401)", async () => {
    const res = await request(app).get("/api/v1/settings/integrations");
    expect(res.status).toBe(401);
  });

  // ─── PATCH /integrations ───────────────────────────────────

  it("PATCH /integrations enables an integration + writes audit + survives a GET round-trip", async () => {
    const prisma = await getPrisma();
    const res = await request(app)
      .patch("/api/v1/settings/integrations")
      .set("Authorization", `Bearer ${adminAToken}`)
      .send({
        integrations: [
          { key: "sendgrid", enabled: true },
          { key: "twilio", enabled: true },
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body.data.ok).toBe(true);

    // Confirm SystemConfig got the per-tenant rows.
    const sgRow = await prisma.systemConfig.findUnique({
      where: {
        key: tenantConfigKey(tenantAId, "integration_sendgrid_enabled"),
      },
    });
    expect(sgRow?.value).toBe("true");

    // Audit row.
    const audit = await waitForAuditFlush(prisma, {
      action: "TENANT_INTEGRATION_UPDATE",
      entity: "tenant",
      entityId: tenantAId,
      userId: adminAUserId,
    });
    expect(audit.action).toBe("TENANT_INTEGRATION_UPDATE");

    // Round-trip — GET /integrations now reflects enabled state.
    const round = await request(app)
      .get("/api/v1/settings/integrations")
      .set("Authorization", `Bearer ${adminAToken}`);
    expect(round.status).toBe(200);
    const sg = round.body.data.integrations.find(
      (i: any) => i.key === "sendgrid",
    );
    expect(sg?.enabled).toBe(true);
  });

  it("PATCH /integrations rejects unknown integration key via schema regex (uppercase)", async () => {
    // Regex /^[a-z0-9_-]{1,40}$/ rejects uppercase BEFORE the KNOWN_INTEGRATIONS
    // membership check runs, so the response is a 400 from validate().
    const res = await request(app)
      .patch("/api/v1/settings/integrations")
      .set("Authorization", `Bearer ${adminAToken}`)
      .send({
        integrations: [{ key: "SENDGRID", enabled: true }],
      });
    expect(res.status).toBe(400);
  });

  it("PATCH /integrations rejects an unknown-but-schema-valid integration key (post-validate guard)", async () => {
    // Lowercase + within regex — schema passes; KNOWN_INTEGRATIONS list rejects.
    const res = await request(app)
      .patch("/api/v1/settings/integrations")
      .set("Authorization", `Bearer ${adminAToken}`)
      .send({
        integrations: [{ key: "stripe", enabled: true }],
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/unknown integration/i);
  });

  it("PATCH /integrations rejects malformed payload (missing `integrations` array)", async () => {
    const res = await request(app)
      .patch("/api/v1/settings/integrations")
      .set("Authorization", `Bearer ${adminAToken}`)
      .send({ foo: "bar" });
    expect(res.status).toBe(400);
  });

  it("PATCH /integrations rejects an `enabled` field that isn't boolean", async () => {
    const res = await request(app)
      .patch("/api/v1/settings/integrations")
      .set("Authorization", `Bearer ${adminAToken}`)
      .send({
        integrations: [{ key: "twilio", enabled: "yes" }],
      });
    expect(res.status).toBe(400);
  });

  it("PATCH /integrations denies NURSE (403)", async () => {
    const res = await request(app)
      .patch("/api/v1/settings/integrations")
      .set("Authorization", `Bearer ${nurseToken}`)
      .send({ integrations: [{ key: "sendgrid", enabled: true }] });
    expect(res.status).toBe(403);
  });

  it("PATCH /integrations denies PATIENT (403)", async () => {
    const res = await request(app)
      .patch("/api/v1/settings/integrations")
      .set("Authorization", `Bearer ${patientToken}`)
      .send({ integrations: [{ key: "sendgrid", enabled: true }] });
    expect(res.status).toBe(403);
  });

  it("PATCH /integrations returns 400 when admin lacks tenant context", async () => {
    const res = await request(app)
      .patch("/api/v1/settings/integrations")
      .set("Authorization", `Bearer ${tenantlessAdminToken}`)
      .send({ integrations: [{ key: "sendgrid", enabled: true }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/tenant context/i);
  });

  // ─── Cross-tenant isolation ────────────────────────────────

  it("Tenant B's branding read does NOT leak Tenant A's renamed hospital name", async () => {
    // Pre-condition: an earlier test renamed Tenant A's hospitalName.
    // Tenant B's GET must show its ORIGINAL seeded name.
    const res = await request(app)
      .get("/api/v1/settings/branding")
      .set("Authorization", `Bearer ${adminBToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.hospitalName).toBe("Tenant B Settings Hospital");
    expect(res.body.data.hospitalName).not.toMatch(/Tenant A/);
  });

  it("Tenant A's enabled integration is NOT visible from Tenant B's GET", async () => {
    // Pre-condition: an earlier test enabled sendgrid+twilio for Tenant A.
    const res = await request(app)
      .get("/api/v1/settings/integrations")
      .set("Authorization", `Bearer ${adminBToken}`);
    expect(res.status).toBe(200);
    const sg = res.body.data.integrations.find(
      (i: any) => i.key === "sendgrid",
    );
    expect(sg?.enabled).toBe(false);
    const tw = res.body.data.integrations.find(
      (i: any) => i.key === "twilio",
    );
    expect(tw?.enabled).toBe(false);
  });

  it("Tenant B can independently enable its own integration without affecting Tenant A's state", async () => {
    const prisma = await getPrisma();
    const patchB = await request(app)
      .patch("/api/v1/settings/integrations")
      .set("Authorization", `Bearer ${adminBToken}`)
      .send({
        integrations: [{ key: "razorpay", enabled: true }],
      });
    expect(patchB.status).toBe(200);

    // Tenant B sees razorpay=true.
    const getB = await request(app)
      .get("/api/v1/settings/integrations")
      .set("Authorization", `Bearer ${adminBToken}`);
    const rzB = getB.body.data.integrations.find(
      (i: any) => i.key === "razorpay",
    );
    expect(rzB?.enabled).toBe(true);

    // Tenant A still sees razorpay=false.
    const getA = await request(app)
      .get("/api/v1/settings/integrations")
      .set("Authorization", `Bearer ${adminAToken}`);
    const rzA = getA.body.data.integrations.find(
      (i: any) => i.key === "razorpay",
    );
    expect(rzA?.enabled).toBe(false);

    // SystemConfig rows are physically separated by the `tenant:<id>:` prefix.
    const aRow = await prisma.systemConfig.findUnique({
      where: {
        key: tenantConfigKey(tenantAId, "integration_razorpay_enabled"),
      },
    });
    // Tenant A's row either doesn't exist or is explicitly false; assert
    // not-true so either shape passes (cross-tenant isolation is the
    // contract under test, not the absence of the row itself).
    expect(aRow?.value).not.toBe("true");
    const bRow = await prisma.systemConfig.findUnique({
      where: {
        key: tenantConfigKey(tenantBId, "integration_razorpay_enabled"),
      },
    });
    expect(bRow?.value).toBe("true");
  });

  // Silence unused-token lint — doctorToken used above; pin once for clarity.
  void doctorToken;
});
