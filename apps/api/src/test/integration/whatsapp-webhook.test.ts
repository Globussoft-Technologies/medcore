// Pearl ERP Stage 1 §6.1 (gap row 167 — piece 3j-ii of 4).
// Integration tests for the inbound WhatsApp webhook receivers.
//
// What / which modules / why:
//   - Drives POST /api/v1/wa/webhook/:provider end-to-end with the same
//     HMAC bytes the server verifies, so we exercise the real path
//     through services/whatsapp-providers.ts.
//   - Coverage:
//      1. Gupshup inbound with valid signature → 200, new conversation,
//         new message, unreadCount=1.
//      2. Second Gupshup inbound on the same convo → unreadCount=2.
//      3. Meta verify-token GET handshake → echoes hub.challenge.
//      4. Meta inbound with bad X-Hub-Signature-256 → 401.
//      5. Unknown provider in :provider path → 404.
//      6. Unknown destination phone → 200 with { ok:false }; no row.
//      7. Idempotency: same providerMessageId twice → second is no-op.
//      8. Audit row WHATSAPP_INBOUND_RECEIVED carries phoneSuffix only —
//         security regression test for PHI leak.

import { it, expect, beforeAll, beforeEach } from "vitest";
import request from "supertest";
import crypto from "crypto";
import { describeIfDB, resetDB, getPrisma } from "../setup";
import { __resetTenantValidationCacheForTests } from "../../middleware/tenant";
import { encryptCredentials } from "../../services/whatsapp-crypto";

let app: any;
let gupshupTenantId: string;
let metaTenantId: string;

// Sentinel test creds — picked so we can re-derive HMACs in the tests.
const GUPSHUP_API_KEY = "test-gupshup-shared-key";
const GUPSHUP_SOURCE = "+919811111111";
const META_APP_SECRET = "test-meta-app-secret";
const META_PHONE_NUMBER_ID = "1234567890";
const META_VERIFY_TOKEN = "test-meta-verify-token";

function gupshupSig(body: string): string {
  return crypto.createHmac("sha256", GUPSHUP_API_KEY).update(body).digest("hex");
}

function metaSig(body: string): string {
  return (
    "sha256=" +
    crypto.createHmac("sha256", META_APP_SECRET).update(body).digest("hex")
  );
}

describeIfDB("WhatsApp inbound webhook (Pearl §6.1 — piece 3j-ii)", () => {
  beforeAll(async () => {
    await resetDB();
    __resetTenantValidationCacheForTests();

    const prisma = await getPrisma();

    const gupshupTenant = await prisma.tenant.create({
      data: {
        name: "WA-Webhook Gupshup Tenant",
        subdomain: `wa-wh-gs-${Date.now()}`,
        plan: "BASIC",
        active: true,
      },
    });
    gupshupTenantId = gupshupTenant.id;

    await prisma.whatsAppConfig.create({
      data: {
        tenantId: gupshupTenantId,
        provider: "GUPSHUP",
        credentialsEncrypted: encryptCredentials({
          apiKey: GUPSHUP_API_KEY,
          appName: "test-app",
          sourcePhone: GUPSHUP_SOURCE,
        }),
        active: true,
      },
    });

    const metaTenant = await prisma.tenant.create({
      data: {
        name: "WA-Webhook Meta Tenant",
        subdomain: `wa-wh-meta-${Date.now()}`,
        plan: "BASIC",
        active: true,
      },
    });
    metaTenantId = metaTenant.id;

    await prisma.whatsAppConfig.create({
      data: {
        tenantId: metaTenantId,
        provider: "META",
        credentialsEncrypted: encryptCredentials({
          accessToken: "meta-access-token",
          phoneNumberId: META_PHONE_NUMBER_ID,
          appSecret: META_APP_SECRET,
          verifyToken: META_VERIFY_TOKEN,
        }),
        active: true,
      },
    });

    const mod = await import("../../app");
    app = mod.app;
  });

  beforeEach(async () => {
    const prisma = await getPrisma();
    await prisma.whatsAppMessage.deleteMany({
      where: { tenantId: { in: [gupshupTenantId, metaTenantId] } },
    });
    await prisma.whatsAppConversation.deleteMany({
      where: { tenantId: { in: [gupshupTenantId, metaTenantId] } },
    });
    await prisma.auditLog.deleteMany({
      where: { action: "WHATSAPP_INBOUND_RECEIVED" },
    });
  });

  // ── 1. Happy-path Gupshup inbound ────────────────────────────────
  it("Gupshup inbound with valid signature creates conversation + message + unreadCount=1", async () => {
    const payload = {
      type: "message",
      payload: {
        id: "gs-msg-001",
        source: "919876543210", // patient phone, no +
        type: "text",
        destination: GUPSHUP_SOURCE.replace(/^\+/, ""),
        payload: { text: "Hello from a patient" },
        timestamp: Date.now(),
      },
    };
    const body = JSON.stringify(payload);
    const res = await request(app)
      .post("/api/v1/wa/webhook/gupshup")
      .set("Content-Type", "application/json")
      .set("x-gs-signature", gupshupSig(body))
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const prisma = await getPrisma();
    const conv = await prisma.whatsAppConversation.findFirst({
      where: { tenantId: gupshupTenantId, phone: "+919876543210" },
    });
    expect(conv).toBeTruthy();
    expect(conv!.unreadCount).toBe(1);

    const msgs = await prisma.whatsAppMessage.findMany({
      where: { conversationId: conv!.id },
    });
    expect(msgs.length).toBe(1);
    expect(msgs[0].direction).toBe("INBOUND");
    expect(msgs[0].body).toBe("Hello from a patient");
    expect(msgs[0].providerMessageId).toBe("gs-msg-001");
    expect(msgs[0].status).toBe("DELIVERED");
  });

  // ── 2. Same convo, second inbound → unreadCount=2 ────────────────
  it("Second Gupshup inbound on known convo increments unreadCount", async () => {
    const mk = (id: string, text: string) => ({
      type: "message",
      payload: {
        id,
        source: "919876543210",
        type: "text",
        destination: GUPSHUP_SOURCE.replace(/^\+/, ""),
        payload: { text },
        timestamp: Date.now(),
      },
    });
    for (const id of ["msg-a", "msg-b"]) {
      const body = JSON.stringify(mk(id, `body-${id}`));
      const res = await request(app)
        .post("/api/v1/wa/webhook/gupshup")
        .set("Content-Type", "application/json")
        .set("x-gs-signature", gupshupSig(body))
        .send(body);
      expect(res.status).toBe(200);
    }

    const prisma = await getPrisma();
    const conv = await prisma.whatsAppConversation.findFirst({
      where: { tenantId: gupshupTenantId, phone: "+919876543210" },
    });
    expect(conv!.unreadCount).toBe(2);
    const msgs = await prisma.whatsAppMessage.findMany({
      where: { conversationId: conv!.id },
    });
    expect(msgs.length).toBe(2);
  });

  // ── 3. Meta verify-token GET handshake ───────────────────────────
  it("Meta GET handshake echoes hub.challenge when verify_token matches", async () => {
    const res = await request(app).get(
      `/api/v1/wa/webhook/meta?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(META_VERIFY_TOKEN)}&hub.challenge=challenge-xyz`,
    );
    expect(res.status).toBe(200);
    expect(res.text).toBe("challenge-xyz");
  });

  it("Meta GET handshake returns 403 on verify_token mismatch", async () => {
    const res = await request(app).get(
      "/api/v1/wa/webhook/meta?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=c",
    );
    expect(res.status).toBe(403);
  });

  // ── 4. Meta inbound with bad signature → 401 ─────────────────────
  it("Meta inbound with invalid X-Hub-Signature-256 returns 401", async () => {
    const payload = {
      entry: [
        {
          changes: [
            {
              value: {
                metadata: {
                  display_phone_number: "+1000",
                  phone_number_id: META_PHONE_NUMBER_ID,
                },
                messages: [
                  {
                    from: "919876543210",
                    id: "wamid.bad-1",
                    timestamp: String(Math.floor(Date.now() / 1000)),
                    type: "text",
                    text: { body: "should be rejected" },
                  },
                ],
              },
            },
          ],
        },
      ],
    };
    const body = JSON.stringify(payload);
    const res = await request(app)
      .post("/api/v1/wa/webhook/meta")
      .set("Content-Type", "application/json")
      .set("x-hub-signature-256", "sha256=" + "0".repeat(64))
      .send(body);
    expect(res.status).toBe(401);

    // Confirm nothing got written.
    const prisma = await getPrisma();
    const msgs = await prisma.whatsAppMessage.findMany({
      where: { tenantId: metaTenantId },
    });
    expect(msgs.length).toBe(0);
  });

  // ── 5. Unknown provider in path → 404 ────────────────────────────
  it("returns 404 for an unknown provider path segment", async () => {
    const res = await request(app)
      .post("/api/v1/wa/webhook/bogus")
      .set("Content-Type", "application/json")
      .send("{}");
    expect(res.status).toBe(404);
  });

  // ── 6. Unknown destination → 200 { ok:false }, no row ────────────
  it("unknown destination phone returns 200 with ok:false and writes no row", async () => {
    const payload = {
      type: "message",
      payload: {
        id: "gs-orphan-1",
        source: "919999999999",
        type: "text",
        destination: "+910000000000", // not configured on any tenant
        payload: { text: "orphan" },
        timestamp: Date.now(),
      },
    };
    const body = JSON.stringify(payload);
    const res = await request(app)
      .post("/api/v1/wa/webhook/gupshup")
      .set("Content-Type", "application/json")
      .set("x-gs-signature", gupshupSig(body))
      .send(body);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.reason).toBe("unknown destination");

    const prisma = await getPrisma();
    const msgs = await prisma.whatsAppMessage.findMany({});
    expect(msgs.length).toBe(0);
  });

  // ── 7. Idempotency on providerMessageId ──────────────────────────
  it("same providerMessageId twice yields a single message row (idempotent)", async () => {
    const payload = {
      type: "message",
      payload: {
        id: "gs-dedup-1",
        source: "919876543210",
        type: "text",
        destination: GUPSHUP_SOURCE.replace(/^\+/, ""),
        payload: { text: "dup" },
        timestamp: Date.now(),
      },
    };
    const body = JSON.stringify(payload);
    const headers = {
      "Content-Type": "application/json",
      "x-gs-signature": gupshupSig(body),
    };

    const r1 = await request(app)
      .post("/api/v1/wa/webhook/gupshup")
      .set(headers)
      .send(body);
    expect(r1.status).toBe(200);

    const r2 = await request(app)
      .post("/api/v1/wa/webhook/gupshup")
      .set(headers)
      .send(body);
    expect(r2.status).toBe(200);
    expect(r2.body.duplicate).toBe(true);

    const prisma = await getPrisma();
    const conv = await prisma.whatsAppConversation.findFirst({
      where: { tenantId: gupshupTenantId, phone: "+919876543210" },
    });
    const msgs = await prisma.whatsAppMessage.findMany({
      where: { conversationId: conv!.id },
    });
    expect(msgs.length).toBe(1);
    // Idempotent: even though the upsert would have bumped unreadCount
    // twice, the dedup path reverses the second bump.
    expect(conv!.unreadCount).toBe(1);
  });

  // ── 8. PHI-safe audit row ────────────────────────────────────────
  it("WHATSAPP_INBOUND_RECEIVED audit row carries phoneSuffix only — never the body or full phone", async () => {
    const secretBody = "VERY_PRIVATE_PATIENT_COMPLAINT";
    const payload = {
      type: "message",
      payload: {
        id: "gs-phi-1",
        source: "919876500001", // last 4 = 0001
        type: "text",
        destination: GUPSHUP_SOURCE.replace(/^\+/, ""),
        payload: { text: secretBody },
        timestamp: Date.now(),
      },
    };
    const body = JSON.stringify(payload);
    await request(app)
      .post("/api/v1/wa/webhook/gupshup")
      .set("Content-Type", "application/json")
      .set("x-gs-signature", gupshupSig(body))
      .send(body)
      .expect(200);

    const prisma = await getPrisma();
    let row: any = null;
    for (let i = 0; i < 40 && !row; i++) {
      row = await prisma.auditLog.findFirst({
        where: { action: "WHATSAPP_INBOUND_RECEIVED" },
        orderBy: { createdAt: "desc" },
      });
      if (!row) await new Promise((r) => setTimeout(r, 50));
    }
    expect(row).toBeTruthy();
    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain(secretBody);
    expect(serialized).not.toContain("919876500001");
    const details = row.details as Record<string, unknown>;
    expect(details.phoneSuffix).toBe("0001");
    expect(details.provider).toBe("GUPSHUP");
  });
});
