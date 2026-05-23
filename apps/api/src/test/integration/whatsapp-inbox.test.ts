// Pearl ERP Stage 1 §6.1 (gap row 167 — pieces 3j-iii + 3j-iv of 4).
//
// Integration coverage for the reception inbox endpoints at
// /api/v1/wa/inbox. Asserts:
//   - GET /conversations defaults to OPEN status, returns 2 of 3 fixtures.
//   - GET /conversations?status=ALL returns all 3.
//   - GET /conversations/:id includes messages + 404s on a foreign id.
//   - POST /:id/read sets unreadCount=0 + writes WHATSAPP_CONVERSATION_READ.
//   - PATCH /:id status=CLOSED updates row + writes WHATSAPP_CONVERSATION_UPDATED.
//   - POST /:id/messages (piece 3j-iv) writes OUTBOUND row + audit
//     WHATSAPP_OUTBOUND_SENT, 503 when WhatsAppConfig absent, 502 on
//     provider failure (which still persists a FAILED row).
//   - PATIENT role gets 403 across the board (mirrors authorize set).
//   - Cross-tenant isolation: a conversation in tenant B is not visible
//     in tenant A's list (no IDOR, no row leak across tenants).
//
// Test creds: admin@test.local / MedCoreT3st-2026 (NOT the prod-seed
// admin@medcore.local). See CLAUDE.md §6.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import request from "supertest";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { describeIfDB, resetDB, getAuthToken, getPrisma } from "../setup";
import { waitForAuditFlush } from "../helpers/audit-wait";

let app: any;
let adminToken: string;
let patientToken: string;
let tenantAId: string;
let tenantBId: string;
let tenantAAdminToken: string;
let tenantBAdminToken: string;
let convA1Id: string;
let convA2Id: string;
let convA3Id: string;
let convBId: string;
let tenantAAdminUserId: string;

const JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret-do-not-use-in-prod";

function mintTokenFor(userId: string, role: string, tenantId: string | null) {
  return jwt.sign(
    { userId, email: `${userId}@x`, role, tenantId: tenantId ?? undefined },
    JWT_SECRET,
    { expiresIn: "1h" },
  );
}

describeIfDB("Pearl §6.1 piece 3j-iii — /api/v1/wa/inbox", () => {
  beforeAll(async () => {
    await resetDB();
    adminToken = await getAuthToken("ADMIN");
    patientToken = await getAuthToken("PATIENT");
    const mod = await import("../../app");
    app = mod.app;

    const prisma = await getPrisma();

    // Two tenants for cross-tenant isolation assertion.
    const tenantA = await prisma.tenant.upsert({
      where: { subdomain: "wa-inbox-a" },
      update: {},
      create: {
        name: "WA Inbox Tenant A",
        subdomain: "wa-inbox-a",
        plan: "BASIC",
        active: true,
      },
    });
    const tenantB = await prisma.tenant.upsert({
      where: { subdomain: "wa-inbox-b" },
      update: {},
      create: {
        name: "WA Inbox Tenant B",
        subdomain: "wa-inbox-b",
        plan: "BASIC",
        active: true,
      },
    });
    tenantAId = tenantA.id;
    tenantBId = tenantB.id;

    // Per-tenant admin users + tokens.
    const adminA = await prisma.user.upsert({
      where: { email: "wa-inbox-admin-a@test.local" },
      update: { tenantId: tenantAId, role: "ADMIN" as any },
      create: {
        email: "wa-inbox-admin-a@test.local",
        name: "Admin A",
        phone: "9000000111",
        passwordHash: await bcrypt.hash("MedCoreT3st-2026", 4),
        role: "ADMIN" as any,
        tenantId: tenantAId,
      },
    });
    tenantAAdminUserId = adminA.id;
    const adminB = await prisma.user.upsert({
      where: { email: "wa-inbox-admin-b@test.local" },
      update: { tenantId: tenantBId, role: "ADMIN" as any },
      create: {
        email: "wa-inbox-admin-b@test.local",
        name: "Admin B",
        phone: "9000000222",
        passwordHash: await bcrypt.hash("MedCoreT3st-2026", 4),
        role: "ADMIN" as any,
        tenantId: tenantBId,
      },
    });
    tenantAAdminToken = mintTokenFor(adminA.id, "ADMIN", tenantAId);
    tenantBAdminToken = mintTokenFor(adminB.id, "ADMIN", tenantBId);

    // Seed conversations. Tenant A gets 3 (2 OPEN unread, 1 CLOSED).
    // Tenant B gets 1 OPEN (used in the cross-tenant isolation test).
    const now = Date.now();
    const created: any[] = [];
    for (const seed of [
      {
        tenantId: tenantAId,
        phone: "+919876500001",
        status: "OPEN",
        unread: 2,
        offset: 0,
      },
      {
        tenantId: tenantAId,
        phone: "+919876500002",
        status: "OPEN",
        unread: 1,
        offset: 1000,
      },
      {
        tenantId: tenantAId,
        phone: "+919876500003",
        status: "CLOSED",
        unread: 0,
        offset: 2000,
      },
      {
        tenantId: tenantBId,
        phone: "+919876500099",
        status: "OPEN",
        unread: 1,
        offset: 500,
      },
    ]) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const row = await (prisma as any).whatsAppConversation.create({
        data: {
          tenantId: seed.tenantId,
          phone: seed.phone,
          status: seed.status,
          unreadCount: seed.unread,
          lastMessageAt: new Date(now - seed.offset),
          lastInboundAt: new Date(now - seed.offset),
        },
      });
      created.push(row);

      // Seed a single inbound message per convo so the thread test has
      // a row to render.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (prisma as any).whatsAppMessage.create({
        data: {
          conversationId: row.id,
          tenantId: seed.tenantId,
          direction: "INBOUND",
          body: `Hello from ${seed.phone}`,
          status: "DELIVERED",
          sentAt: new Date(now - seed.offset),
          deliveredAt: new Date(now - seed.offset),
        },
      });
    }
    convA1Id = created[0].id;
    convA2Id = created[1].id;
    convA3Id = created[2].id;
    convBId = created[3].id;
    // Silence "unused" lints — the IDs are used across the assertions
    // below.
    void convA2Id;
    void adminB;
  });

  beforeEach(() => {
    // No per-test reset; conversations are seeded once for the suite.
  });

  it("GET /conversations defaults to OPEN status and lists tenant A's 2 open convos", async () => {
    const res = await request(app)
      .get("/api/v1/wa/inbox/conversations")
      .set("Authorization", `Bearer ${tenantAAdminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data.conversations)).toBe(true);
    const phones = res.body.data.conversations.map((c: any) => c.phone).sort();
    expect(phones).toEqual(["+919876500001", "+919876500002"]);
    // CLOSED row is NOT in the default response.
    expect(phones).not.toContain("+919876500003");
  });

  it("GET /conversations?status=ALL returns all 3 of tenant A's convos", async () => {
    const res = await request(app)
      .get("/api/v1/wa/inbox/conversations?status=ALL")
      .set("Authorization", `Bearer ${tenantAAdminToken}`);
    expect(res.status).toBe(200);
    const phones = res.body.data.conversations.map((c: any) => c.phone).sort();
    expect(phones).toEqual([
      "+919876500001",
      "+919876500002",
      "+919876500003",
    ]);
  });

  it("GET /conversations/:id returns the conversation + messages", async () => {
    const res = await request(app)
      .get(`/api/v1/wa/inbox/conversations/${convA1Id}`)
      .set("Authorization", `Bearer ${tenantAAdminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.conversation.id).toBe(convA1Id);
    expect(res.body.data.messages.length).toBeGreaterThanOrEqual(1);
    expect(res.body.data.messages[0].direction).toBe("INBOUND");
  });

  it("GET /conversations/:id 404s when the conversation is in a different tenant", async () => {
    const res = await request(app)
      .get(`/api/v1/wa/inbox/conversations/${convBId}`)
      .set("Authorization", `Bearer ${tenantAAdminToken}`);
    expect(res.status).toBe(404);
  });

  it("POST /:id/read clears unreadCount and writes WHATSAPP_CONVERSATION_READ", async () => {
    const res = await request(app)
      .post(`/api/v1/wa/inbox/conversations/${convA1Id}/read`)
      .set("Authorization", `Bearer ${tenantAAdminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.conversation.unreadCount).toBe(0);

    // Verify in DB.
    const prisma = await getPrisma();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const row = await (prisma as any).whatsAppConversation.findUnique({
      where: { id: convA1Id },
    });
    expect(row.unreadCount).toBe(0);

    // safeAudit pattern → poll for the audit row (avoids the deferred-
    // write race documented in CLAUDE.md §1).
    const audit = await waitForAuditFlush(prisma, {
      action: "WHATSAPP_CONVERSATION_READ",
      entity: "whatsapp_conversation",
      entityId: convA1Id,
      userId: tenantAAdminUserId,
    });
    expect(audit).toBeTruthy();
  });

  it("PATCH /:id status=CLOSED updates the row + writes WHATSAPP_CONVERSATION_UPDATED", async () => {
    // Use convA1Id (currently OPEN since seed) to close.
    const res = await request(app)
      .patch(`/api/v1/wa/inbox/conversations/${convA1Id}`)
      .set("Authorization", `Bearer ${tenantAAdminToken}`)
      .send({ status: "CLOSED" });
    expect(res.status).toBe(200);
    expect(res.body.data.conversation.status).toBe("CLOSED");

    const prisma = await getPrisma();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const row = await (prisma as any).whatsAppConversation.findUnique({
      where: { id: convA1Id },
    });
    expect(row.status).toBe("CLOSED");

    const audit = await waitForAuditFlush(prisma, {
      action: "WHATSAPP_CONVERSATION_UPDATED",
      entity: "whatsapp_conversation",
      entityId: convA1Id,
      userId: tenantAAdminUserId,
    });
    expect(audit).toBeTruthy();
  });

  it("PATCH /:id rejects an empty body with 400", async () => {
    const res = await request(app)
      .patch(`/api/v1/wa/inbox/conversations/${convA3Id}`)
      .set("Authorization", `Bearer ${tenantAAdminToken}`)
      .send({});
    expect(res.status).toBe(400);
  });

  it("PATIENT role gets 403 on every wa/inbox endpoint", async () => {
    void patientToken;
    const list = await request(app)
      .get("/api/v1/wa/inbox/conversations")
      .set("Authorization", `Bearer ${patientToken}`);
    expect(list.status).toBe(403);

    const detail = await request(app)
      .get(`/api/v1/wa/inbox/conversations/${convA3Id}`)
      .set("Authorization", `Bearer ${patientToken}`);
    expect(detail.status).toBe(403);

    const read = await request(app)
      .post(`/api/v1/wa/inbox/conversations/${convA3Id}/read`)
      .set("Authorization", `Bearer ${patientToken}`);
    expect(read.status).toBe(403);

    const patch = await request(app)
      .patch(`/api/v1/wa/inbox/conversations/${convA3Id}`)
      .set("Authorization", `Bearer ${patientToken}`)
      .send({ status: "OPEN" });
    expect(patch.status).toBe(403);
  });

  it("unauthenticated → 401", async () => {
    const res = await request(app).get("/api/v1/wa/inbox/conversations");
    expect(res.status).toBe(401);
  });

  // ── Piece 3j-iv: reply / outbound send ────────────────────────────

  it("POST /:id/messages returns 503 when WhatsAppConfig is absent for the tenant", async () => {
    // Reuse convA3Id (CLOSED — but the route doesn't gate on convo status,
    // only on WhatsAppConfig presence). No config seeded for tenantA at
    // this point in the suite => 503 expected.
    const res = await request(app)
      .post(`/api/v1/wa/inbox/conversations/${convA3Id}/messages`)
      .set("Authorization", `Bearer ${tenantAAdminToken}`)
      .send({ body: "Hello back!" });
    expect(res.status).toBe(503);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/not configured/i);
  });

  it("POST /:id/messages rejects empty body with 400", async () => {
    const res = await request(app)
      .post(`/api/v1/wa/inbox/conversations/${convA3Id}/messages`)
      .set("Authorization", `Bearer ${tenantAAdminToken}`)
      .send({ body: "   " });
    expect(res.status).toBe(400);
  });

  it("POST /:id/messages PATIENT role gets 403", async () => {
    const res = await request(app)
      .post(`/api/v1/wa/inbox/conversations/${convA3Id}/messages`)
      .set("Authorization", `Bearer ${patientToken}`)
      .send({ body: "Hi" });
    expect(res.status).toBe(403);
  });

  it("POST /:id/messages writes OUTBOUND row + WHATSAPP_OUTBOUND_SENT audit (with WhatsAppConfig)", async () => {
    // Seed a per-tenant WhatsAppConfig so the route can dispatch. Stub
    // mode (no WHATSAPP_CREDS_KEY env) stores plaintext creds; the
    // provider call falls back to stub-mode in dev (non-prod) so the
    // happy path completes without a real Gupshup hit.
    const prisma = await getPrisma();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (prisma as any).whatsAppConfig.upsert({
      where: { tenantId: tenantAId },
      update: { active: true },
      create: {
        tenantId: tenantAId,
        provider: "GUPSHUP",
        active: true,
        // stub-mode envelope from whatsapp-crypto.ts
        credentialsEncrypted: JSON.stringify({
          __plaintext: true,
          value: {
            apiKey: "test-key",
            appName: "TestApp",
            sourcePhone: "+919000000000",
          },
        }),
      },
    });

    // Force the provider call to fail so we exercise the stub-fallback
    // branch deterministically (without a real HTTP). The send wraps any
    // error in stub mode (non-prod) → returns success with stub message id.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const origFetch = (globalThis as any).fetch;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = async () =>
      new Response(JSON.stringify({ error: "stub-network-down" }), {
        status: 503,
      });

    try {
      const res = await request(app)
        .post(`/api/v1/wa/inbox/conversations/${convA3Id}/messages`)
        .set("Authorization", `Bearer ${tenantAAdminToken}`)
        .send({ body: "Thanks for your message." });
      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.message.direction).toBe("OUTBOUND");
      expect(res.body.data.message.body).toBe("Thanks for your message.");
      expect(res.body.data.message.status).toBe("SENT");
      expect(res.body.data.message.providerMessageId).toMatch(/^stub-/);

      // Verify the row persisted with the right shape.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const persisted = await (prisma as any).whatsAppMessage.findUnique({
        where: { id: res.body.data.message.id },
      });
      expect(persisted.direction).toBe("OUTBOUND");
      expect(persisted.status).toBe("SENT");
      expect(persisted.tenantId).toBe(tenantAId);

      const audit = await waitForAuditFlush(prisma, {
        action: "WHATSAPP_OUTBOUND_SENT",
        entity: "whatsapp_message",
        entityId: res.body.data.message.id,
        userId: tenantAAdminUserId,
      });
      expect(audit).toBeTruthy();
      // PHI guard: audit row never logs the body or the full phone.
      const details = (audit.details ?? {}) as Record<string, unknown>;
      expect(JSON.stringify(details)).not.toContain("Thanks for your message");
      expect(details.phoneSuffix).toBe("0001");
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).fetch = origFetch;
    }
  });

  it("POST /:id/messages persists FAILED row + 502 in strict mode on provider failure", async () => {
    const prisma = await getPrisma();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const origFetch = (globalThis as any).fetch;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = async () =>
      new Response(
        JSON.stringify({ message: "Bad provider credentials" }),
        { status: 401 },
      );
    const prev = process.env.WHATSAPP_OUTBOUND_STRICT;
    process.env.WHATSAPP_OUTBOUND_STRICT = "true";
    try {
      const res = await request(app)
        .post(`/api/v1/wa/inbox/conversations/${convA3Id}/messages`)
        .set("Authorization", `Bearer ${tenantAAdminToken}`)
        .send({ body: "Should fail strictly." });
      expect(res.status).toBe(502);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toMatch(/Provider send failed/i);
      // Even on failure we persist a FAILED row so the operator sees it.
      expect(res.body.data.message.status).toBe("FAILED");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const row = await (prisma as any).whatsAppMessage.findUnique({
        where: { id: res.body.data.message.id },
      });
      expect(row.status).toBe("FAILED");
      expect(row.failureReason).toMatch(/Bad provider credentials/i);
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).fetch = origFetch;
      if (prev === undefined) delete process.env.WHATSAPP_OUTBOUND_STRICT;
      else process.env.WHATSAPP_OUTBOUND_STRICT = prev;
    }
  });

  it("POST /:id/messages 404s on a foreign-tenant conversation", async () => {
    const res = await request(app)
      .post(`/api/v1/wa/inbox/conversations/${convBId}/messages`)
      .set("Authorization", `Bearer ${tenantAAdminToken}`)
      .send({ body: "Foreign tenant probe." });
    expect(res.status).toBe(404);
  });

  it("cross-tenant isolation: tenant A cannot see tenant B's conversation in the list", async () => {
    const res = await request(app)
      .get("/api/v1/wa/inbox/conversations?status=ALL")
      .set("Authorization", `Bearer ${tenantAAdminToken}`);
    expect(res.status).toBe(200);
    const phones = res.body.data.conversations.map((c: any) => c.phone);
    expect(phones).not.toContain("+919876500099");

    // Tenant B sees its own row.
    const resB = await request(app)
      .get("/api/v1/wa/inbox/conversations?status=ALL")
      .set("Authorization", `Bearer ${tenantBAdminToken}`);
    expect(resB.status).toBe(200);
    const phonesB = resB.body.data.conversations.map((c: any) => c.phone);
    expect(phonesB).toContain("+919876500099");
    expect(phonesB).not.toContain("+919876500001");

    void adminToken;
    void tenantBId;
  });
});
