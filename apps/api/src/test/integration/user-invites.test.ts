// Integration tests for the Pearl §8.2 staff email-invite flow (gap row
// 213 closure, 2026-05-23).
//
// Covers:
//   - ADMIN POST mints an invite, persists ONLY the SHA-256 hash (not the
//     raw nonce), and lands a USER_INVITE_SENT audit row.
//   - GET with the raw token resolves to {email, role, tenantName};
//     unknown / expired / accepted tokens 410.
//   - POST /:token/accept materialises the User row with the role +
//     tenantId from the invite (NOT the request body), marks the invite
//     accepted, and lands a USER_INVITE_ACCEPTED audit row.
//   - A second accept attempt on the same token returns 410 (already used).
//   - Expired invites return 410 on both GET + POST accept.
//   - PATIENT / RECEPTION cannot send invites (403).
//   - Cross-tenant scope: each invite stays under the inviter's tenant.
//
// SendGrid is mocked at the messaging/email module so test runs never hit
// the real API. Like other DB-bound integration tests, the suite skips
// when DATABASE_URL_TEST is not set.

import { it, expect, beforeAll, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { describeIfDB, resetDB, getPrisma, getAuthToken } from "../setup";
import { errorHandler } from "../../middleware/error";
import { tenantContextMiddleware } from "../../middleware/tenant";
import { withTenantContext } from "../../services/tenant-context";
import { waitForAuditFlush } from "../helpers/audit-wait";

// Mock SendGrid so the POST handler doesn't make a real network call.
// The route still flows through sendEmail() — we just stub the result.
vi.mock("../../services/messaging/email", () => ({
  sendEmail: vi.fn(async () => ({ ok: true, messageId: "mock-msg-id" })),
}));

// userInvitesRouter import is deferred until after the mock is registered.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let userInvitesRouter: any;

let app: express.Express;

function buildTestApp(): express.Express {
  const a = express();
  a.use(express.json());
  a.use(tenantContextMiddleware);
  a.use(withTenantContext);
  a.use("/api/v1/user-invites", userInvitesRouter);
  a.use(errorHandler);
  return a;
}

function sha256(raw: string): string {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

async function ensureDefaultTenant(): Promise<string> {
  const prisma = await getPrisma();
  const existing = await prisma.tenant.findUnique({
    where: { subdomain: "default" },
  });
  if (existing) return existing.id;
  const t = await prisma.tenant.create({
    data: {
      name: "Default Tenant",
      subdomain: "default",
      plan: "BASIC",
      active: true,
    },
  });
  return t.id;
}

async function seedTenantWithAdmin(label: string): Promise<{
  tenantId: string;
  tenantName: string;
  userId: string;
  token: string;
}> {
  const prisma = await getPrisma();
  const name = `Invite Tenant ${label} ${Date.now()}`;
  const t = await prisma.tenant.create({
    data: {
      name,
      subdomain: `invite-${label}-${Math.random().toString(36).slice(2, 7)}`,
      plan: "BASIC",
      active: true,
    },
  });
  const user = await prisma.user.create({
    data: {
      email: `invite-admin-${label}-${Date.now()}@test.local`,
      name: `Invite ADMIN ${label}`,
      phone: `9${Math.floor(Math.random() * 1e9)
        .toString()
        .padStart(9, "0")}`,
      passwordHash: await bcrypt.hash("MedCoreT3st-2026", 4),
      role: "ADMIN",
      tenantId: t.id,
      isActive: true,
    },
  });
  const token = jwt.sign(
    {
      userId: user.id,
      email: user.email,
      role: user.role,
      tenantId: t.id,
    },
    process.env.JWT_SECRET || "test-jwt-secret-do-not-use-in-prod",
    { expiresIn: "1h" },
  );
  return { tenantId: t.id, tenantName: name, userId: user.id, token };
}

describeIfDB("Pearl §8.2 staff email-invite flow (integration)", () => {
  beforeAll(async () => {
    await resetDB();
    // Defer router import until after mock-registration so the SendGrid
    // stub wins. The route module captures sendEmail at import time.
    userInvitesRouter = (await import("../../routes/user-invites"))
      .userInvitesRouter;
    app = buildTestApp();
  });

  beforeEach(async () => {
    const prisma = await getPrisma();
    // Scrub only invite-related rows + the tenants/admins we seed. The
    // shared admin@test.local PATIENT seeds stay intact.
    await prisma.auditLog.deleteMany({
      where: {
        action: { in: ["USER_INVITE_SENT", "USER_INVITE_ACCEPTED"] },
      },
    });
    await prisma.userInvite.deleteMany({});
    await prisma.user.deleteMany({
      where: { email: { contains: "invite-" } },
    });
    await prisma.tenant.deleteMany({
      where: { subdomain: { startsWith: "invite-" } },
    });
    await ensureDefaultTenant();
  });

  // ── 1. End-to-end: invite → metadata → accept ───────────────────────
  it(
    "ADMIN invites; raw token resolves metadata; accept materialises User + audit rows",
    async () => {
      const prisma = await getPrisma();
      const tenantA = await seedTenantWithAdmin("e2e");
      const inviteeEmail = `invitee-e2e-${Date.now()}@test.local`;

      // ── 1a. ADMIN issues the invite ──
      const issueRes = await request(app)
        .post("/api/v1/user-invites")
        .set("Authorization", `Bearer ${tenantA.token}`)
        .send({ email: inviteeEmail, role: "NURSE" });
      expect(issueRes.status).toBe(201);
      expect(issueRes.body.success).toBe(true);
      expect(issueRes.body.data.email).toBe(inviteeEmail);
      expect(issueRes.body.data.role).toBe("NURSE");
      // Raw token is NEVER returned in the API response.
      expect(issueRes.body.data.token).toBeUndefined();
      const inviteId = issueRes.body.data.id as string;

      // Audit landed (awaited auditLog — resolves on first poll).
      const sentAudit = await waitForAuditFlush(prisma, {
        action: "USER_INVITE_SENT",
        entity: "user_invite",
        entityId: inviteId,
      });
      expect(sentAudit.action).toBe("USER_INVITE_SENT");

      // ── 1b. DB stored the HASH, not the raw token ──
      const inviteRow = await prisma.userInvite.findUnique({
        where: { id: inviteId },
      });
      expect(inviteRow).not.toBeNull();
      expect(inviteRow!.token).toMatch(/^[a-f0-9]{64}$/);
      // Recover the raw token from the SendGrid mock so the rest of the
      // test can call the public endpoints.
      const { sendEmail } = await import("../../services/messaging/email");
      const mock = sendEmail as unknown as ReturnType<typeof vi.fn>;
      const lastCall = mock.mock.calls[mock.mock.calls.length - 1]?.[0] as
        | { html: string }
        | undefined;
      const match = lastCall?.html.match(/token=([a-f0-9]{64})/);
      expect(match).not.toBeNull();
      const rawToken = match![1];
      expect(sha256(rawToken)).toBe(inviteRow!.token);

      // ── 1c. GET /:token returns metadata ──
      const lookupRes = await request(app).get(
        `/api/v1/user-invites/${rawToken}`,
      );
      expect(lookupRes.status).toBe(200);
      expect(lookupRes.body.data.email).toBe(inviteeEmail);
      expect(lookupRes.body.data.role).toBe("NURSE");
      expect(lookupRes.body.data.tenantName).toBe(tenantA.tenantName);

      // ── 1d. POST /:token/accept creates the User row ──
      const acceptRes = await request(app)
        .post(`/api/v1/user-invites/${rawToken}/accept`)
        .send({ password: "Br0nzeFalc0n!" });
      expect(acceptRes.status).toBe(200);
      expect(acceptRes.body.data.userId).toBeTruthy();
      expect(acceptRes.body.data.email).toBe(inviteeEmail);
      expect(acceptRes.body.data.role).toBe("NURSE");

      const newUser = await prisma.user.findUnique({
        where: { id: acceptRes.body.data.userId },
      });
      expect(newUser).not.toBeNull();
      expect(newUser!.role).toBe("NURSE");
      expect(newUser!.tenantId).toBe(tenantA.tenantId);
      expect(newUser!.isActive).toBe(true);
      // Password was hashed, not stored plaintext.
      expect(newUser!.passwordHash).not.toBe("Br0nzeFalc0n!");
      expect(
        await bcrypt.compare("Br0nzeFalc0n!", newUser!.passwordHash),
      ).toBe(true);

      // Invite row was marked accepted with the new userId.
      const acceptedInvite = await prisma.userInvite.findUnique({
        where: { id: inviteId },
      });
      expect(acceptedInvite!.acceptedAt).not.toBeNull();
      expect(acceptedInvite!.acceptedUserId).toBe(newUser!.id);

      const acceptAudit = await waitForAuditFlush(prisma, {
        action: "USER_INVITE_ACCEPTED",
        entity: "user_invite",
        entityId: inviteId,
      });
      expect(acceptAudit.action).toBe("USER_INVITE_ACCEPTED");
    },
  );

  // ── 2. Unknown raw-token shape → 410 (no DB hit) ────────────────────
  it("GET with a malformed or unknown token returns 410", async () => {
    const r1 = await request(app).get("/api/v1/user-invites/not-a-hex-token");
    expect(r1.status).toBe(410);
    const r2 = await request(app).get(
      `/api/v1/user-invites/${"a".repeat(64)}`,
    );
    expect(r2.status).toBe(410);
  });

  // ── 3. Second accept on same token → 410 ────────────────────────────
  it("re-accepting a token that's already been used returns 410", async () => {
    const prisma = await getPrisma();
    const tenant = await seedTenantWithAdmin("reuse");
    const raw = crypto.randomBytes(32).toString("hex");
    const invite = await prisma.userInvite.create({
      data: {
        tenantId: tenant.tenantId,
        email: `reuse-${Date.now()}@test.local`,
        role: "RECEPTION",
        token: sha256(raw),
        invitedByUserId: tenant.userId,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });

    const first = await request(app)
      .post(`/api/v1/user-invites/${raw}/accept`)
      .send({ password: "Br0nzeFalc0n!" });
    expect(first.status).toBe(200);

    const second = await request(app)
      .post(`/api/v1/user-invites/${raw}/accept`)
      .send({ password: "Br0nzeFalc0n!" });
    expect(second.status).toBe(410);
    // And we never created a duplicate User.
    const users = await prisma.user.findMany({
      where: {
        email: invite.email,
        tenantId: tenant.tenantId,
      },
    });
    expect(users).toHaveLength(1);
  });

  // ── 4. Expired invite → 410 on GET + accept ─────────────────────────
  it("expired invites return 410 on both GET and POST accept", async () => {
    const prisma = await getPrisma();
    const tenant = await seedTenantWithAdmin("expired");
    const raw = crypto.randomBytes(32).toString("hex");
    await prisma.userInvite.create({
      data: {
        tenantId: tenant.tenantId,
        email: `expired-${Date.now()}@test.local`,
        role: "DOCTOR",
        token: sha256(raw),
        invitedByUserId: tenant.userId,
        expiresAt: new Date(Date.now() - 60 * 1000), // 1 min ago
      },
    });
    const lookupRes = await request(app).get(`/api/v1/user-invites/${raw}`);
    expect(lookupRes.status).toBe(410);
    const acceptRes = await request(app)
      .post(`/api/v1/user-invites/${raw}/accept`)
      .send({ password: "Br0nzeFalc0n!" });
    expect(acceptRes.status).toBe(410);
  });

  // ── 5. Weak password → 400 BEFORE the token is consumed ─────────────
  it("rejects a denylisted password without consuming the invite", async () => {
    const prisma = await getPrisma();
    const tenant = await seedTenantWithAdmin("weak");
    const raw = crypto.randomBytes(32).toString("hex");
    const invite = await prisma.userInvite.create({
      data: {
        tenantId: tenant.tenantId,
        email: `weak-${Date.now()}@test.local`,
        role: "NURSE",
        token: sha256(raw),
        invitedByUserId: tenant.userId,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    const r = await request(app)
      .post(`/api/v1/user-invites/${raw}/accept`)
      .send({ password: "password1" });
    expect(r.status).toBe(400);
    // Invite is still active — caller can retry with a stronger password.
    const stillActive = await prisma.userInvite.findUnique({
      where: { id: invite.id },
    });
    expect(stillActive!.acceptedAt).toBeNull();
  });

  // ── 6. Non-ADMIN roles cannot send invites ──────────────────────────
  it("PATIENT and RECEPTION roles are 403'd from POST /", async () => {
    const patientToken = await getAuthToken("PATIENT");
    const receptionToken = await getAuthToken("RECEPTION");
    const r1 = await request(app)
      .post("/api/v1/user-invites")
      .set("Authorization", `Bearer ${patientToken}`)
      .send({ email: "x@test.local", role: "NURSE" });
    expect(r1.status).toBe(403);
    const r2 = await request(app)
      .post("/api/v1/user-invites")
      .set("Authorization", `Bearer ${receptionToken}`)
      .send({ email: "x@test.local", role: "NURSE" });
    expect(r2.status).toBe(403);
  });

  // ── 7. Cross-tenant scope ───────────────────────────────────────────
  it("invite is scoped to the inviter's tenant; cross-tenant emails are independent", async () => {
    const prisma = await getPrisma();
    const tenantA = await seedTenantWithAdmin("scope-a");
    const tenantB = await seedTenantWithAdmin("scope-b");
    const emailA = `scope-a-${Date.now()}@test.local`;
    const emailB = `scope-b-${Date.now()}@test.local`;

    const resA = await request(app)
      .post("/api/v1/user-invites")
      .set("Authorization", `Bearer ${tenantA.token}`)
      .send({ email: emailA, role: "DOCTOR" });
    expect(resA.status).toBe(201);

    const resB = await request(app)
      .post("/api/v1/user-invites")
      .set("Authorization", `Bearer ${tenantB.token}`)
      .send({ email: emailB, role: "PHARMACIST" });
    expect(resB.status).toBe(201);

    const rowA = await prisma.userInvite.findUnique({
      where: { id: resA.body.data.id },
    });
    const rowB = await prisma.userInvite.findUnique({
      where: { id: resB.body.data.id },
    });
    expect(rowA!.tenantId).toBe(tenantA.tenantId);
    expect(rowB!.tenantId).toBe(tenantB.tenantId);
  });
});
