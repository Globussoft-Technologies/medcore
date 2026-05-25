// Integration tests for the per-tenant WhatsApp provider config —
// Pearl §6.1 (gap row 167 — piece 3j-i of 4).
//
// What's covered:
//   1. PUT with valid GUPSHUP creds → 200 + WhatsAppConfig row created
//      + AuditLog row written with only the metadata (no creds).
//   2. PUT with an INVALID discriminated-union shape (e.g. META payload
//      under provider="GUPSHUP") → 400 from the Zod schema layer.
//   3. GET on a configured tenant → returns the decrypted creds back
//      under `data.config.credentials` (round-trip works in stub mode
//      AND in real-key mode).
//   4. GET on an unconfigured tenant → `data.config === null`.
//   5. RBAC — non-ADMIN role gets 403.
//   6. Security regression: the AuditLog row for WHATSAPP_CONFIG_UPDATED
//      does NOT contain the credential string fields anywhere.
//
// The full app is loaded so the global tenant middleware participates
// (the route needs req.user.tenantId from the JWT).

import { it, expect, beforeAll, beforeEach } from "vitest";
import request from "supertest";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { describeIfDB, resetDB, getPrisma } from "../setup";
import { __resetTenantValidationCacheForTests } from "../../middleware/tenant";

const JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret-do-not-use-in-prod";

let app: any;
let tenantId: string;
let adminToken: string;
let receptionToken: string;

function signToken(
  userId: string,
  email: string,
  role: string,
  tid: string | null,
) {
  return jwt.sign(
    { userId, email, role, tenantId: tid ?? null },
    JWT_SECRET,
    { expiresIn: "1h" },
  );
}

describeIfDB("WhatsApp config API (Pearl §6.1 — piece 3j-i)", () => {
  beforeAll(async () => {
    await resetDB();
    __resetTenantValidationCacheForTests();

    const prisma = await getPrisma();
    const passwordHash = await bcrypt.hash("MedCoreT3st-2026", 4);

    const tenant = await prisma.tenant.create({
      data: {
        name: "WA Test Hospital",
        subdomain: `wa-cfg-${Date.now()}`,
        plan: "BASIC",
        active: true,
      },
    });
    tenantId = tenant.id;

    const admin = await prisma.user.create({
      data: {
        email: `admin-wa-${Date.now()}@test.local`,
        name: "Admin WA",
        phone: "9100000010",
        passwordHash,
        role: "ADMIN",
        tenantId,
      },
    });
    adminToken = signToken(admin.id, admin.email, "ADMIN", tenantId);

    const reception = await prisma.user.create({
      data: {
        email: `reception-wa-${Date.now()}@test.local`,
        name: "Reception WA",
        phone: "9100000011",
        passwordHash,
        role: "RECEPTION",
        tenantId,
      },
    });
    receptionToken = signToken(reception.id, reception.email, "RECEPTION", tenantId);

    const mod = await import("../../app");
    app = mod.app;
  });

  beforeEach(async () => {
    // Wipe any rows the prior test created so each assertion is deterministic.
    const prisma = await getPrisma();
    await prisma.whatsAppConfig.deleteMany({ where: { tenantId } });
    await prisma.auditLog.deleteMany({
      where: { action: "WHATSAPP_CONFIG_UPDATED", tenantId },
    });
  });

  // ── 1. Happy path PUT ──────────────────────────────────────
  it("PUT with valid GUPSHUP creds creates the config row and writes an audit row", async () => {
    const body = {
      credentials: {
        provider: "GUPSHUP",
        apiKey: "sk-gupshup-test-1",
        appName: "wa_test_app",
        sourcePhone: "+919876543210",
      },
      defaultProductId: "prod-1",
      autoReply: true,
      active: true,
    };
    const res = await request(app)
      .put("/api/v1/wa/config")
      .set("Authorization", `Bearer ${adminToken}`)
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.config.provider).toBe("GUPSHUP");
    expect(res.body.data.config.defaultProductId).toBe("prod-1");
    expect(res.body.data.config.autoReply).toBe(true);

    const prisma = await getPrisma();
    const row = await prisma.whatsAppConfig.findUnique({ where: { tenantId } });
    expect(row).toBeTruthy();
    expect(row!.provider).toBe("GUPSHUP");
    expect(row!.credentialsEncrypted).toBeTruthy();
    // The persisted blob must NOT contain the API key in cleartext UNLESS
    // we are in stub-mode (WHATSAPP_CREDS_KEY unset on CI) — in that mode
    // the route is allowed to store plaintext but it must mark itself.
    if (process.env.WHATSAPP_CREDS_KEY) {
      expect(row!.credentialsEncrypted).not.toContain("sk-gupshup-test-1");
    } else {
      expect(row!.credentialsEncrypted).toContain("__plaintext");
    }

    // Poll briefly for the (fire-and-forget) audit-row write — auditLog
    // here is awaited inline at the call site, but the route does
    // .catch(console.error) so we still poll for robustness across CI.
    let auditRow: any = null;
    for (let i = 0; i < 40 && !auditRow; i++) {
      auditRow = await prisma.auditLog.findFirst({
        where: { action: "WHATSAPP_CONFIG_UPDATED", tenantId },
        orderBy: { createdAt: "desc" },
      });
      if (!auditRow) await new Promise((r) => setTimeout(r, 50));
    }
    expect(auditRow).toBeTruthy();
    expect(auditRow.entity).toBe("whatsapp_config");
    const details = (auditRow.details ?? {}) as Record<string, unknown>;
    expect(details.provider).toBe("GUPSHUP");
  });

  // ── 2. Invalid discriminated-union shape ───────────────────
  it("PUT with provider=GUPSHUP but META-shaped payload → 400", async () => {
    const body = {
      credentials: {
        provider: "GUPSHUP",
        accessToken: "wrong-shape-token", // META field, not GUPSHUP
        phoneNumberId: "1234567890",
        appSecret: "shh",
        verifyToken: "v",
      },
    };
    const res = await request(app)
      .put("/api/v1/wa/config")
      .set("Authorization", `Bearer ${adminToken}`)
      .send(body);
    expect(res.status).toBe(400);
  });

  // ── 3. GET round-trip ──────────────────────────────────────
  it("GET on configured tenant returns the decrypted creds", async () => {
    const body = {
      credentials: {
        provider: "META",
        accessToken: "meta-token-xyz",
        phoneNumberId: "9876543210",
        appSecret: "meta-secret",
        verifyToken: "meta-verify",
      },
      autoReply: false,
    };
    const put = await request(app)
      .put("/api/v1/wa/config")
      .set("Authorization", `Bearer ${adminToken}`)
      .send(body);
    expect(put.status).toBe(200);

    const get = await request(app)
      .get("/api/v1/wa/config")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(get.status).toBe(200);
    expect(get.body.data.config.provider).toBe("META");
    expect(get.body.data.config.credentials.accessToken).toBe("meta-token-xyz");
    expect(get.body.data.config.credentials.phoneNumberId).toBe("9876543210");
    expect(get.body.data.config.autoReply).toBe(false);
  });

  // ── 4. GET on unconfigured tenant ──────────────────────────
  it("GET on unconfigured tenant returns config:null", async () => {
    const res = await request(app)
      .get("/api/v1/wa/config")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.config).toBeNull();
  });

  // ── 5. RBAC ────────────────────────────────────────────────
  it("non-ADMIN role is rejected with 403", async () => {
    const res = await request(app)
      .get("/api/v1/wa/config")
      .set("Authorization", `Bearer ${receptionToken}`);
    expect(res.status).toBe(403);
  });

  // ── 6. Security regression — audit row never logs creds ────
  it("the WHATSAPP_CONFIG_UPDATED audit row does NOT contain the credential string fields", async () => {
    const apiKey = "sk-super-secret-not-in-audit";
    await request(app)
      .put("/api/v1/wa/config")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        credentials: {
          provider: "GUPSHUP",
          apiKey,
          appName: "audit_check",
          sourcePhone: "+911234567890",
        },
      })
      .expect(200);

    const prisma = await getPrisma();
    let auditRow: any = null;
    for (let i = 0; i < 40 && !auditRow; i++) {
      auditRow = await prisma.auditLog.findFirst({
        where: { action: "WHATSAPP_CONFIG_UPDATED", tenantId },
        orderBy: { createdAt: "desc" },
      });
      if (!auditRow) await new Promise((r) => setTimeout(r, 50));
    }
    expect(auditRow).toBeTruthy();
    const serialized = JSON.stringify(auditRow);
    expect(serialized).not.toContain(apiKey);
    expect(serialized).not.toContain("audit_check"); // appName also stays out
  });
});
