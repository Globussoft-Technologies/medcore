// Integration tests for the Pearl-operator support inbox — Pearl §8.5
// (gap row 223 closure, 2026-05-23).
//
// Covers POST / GET / GET-by-id / POST messages / PATCH on
// /api/v1/support-tickets, including:
//   - End-to-end lifecycle: tenant ADMIN opens → super-admin lists across
//     all tenants → super-admin replies + assigns themselves + flips
//     priority → tenant ADMIN sees the reply on detail → status flips
//     correctly on each reply direction.
//   - Cross-tenant isolation: tenant ADMIN on tenant A cannot read or
//     post to tenant B's ticket (403 on both surfaces).
//   - Role gating: PATIENT 403 on every surface.
//   - Audit rows landed for SUPPORT_TICKET_OPENED, SUPPORT_TICKET_MESSAGE_ADDED,
//     SUPPORT_TICKET_UPDATED — read via waitForAuditFlush (the safe poll
//     for `safeAudit` deferred writes; this router uses awaited
//     `auditLog` so the waits resolve immediately on the first poll, but
//     the helper is the canonical assertion shape and future-proofs us
//     against a fire-and-forget refactor).
//
// Like scheduled-jobs.test.ts + dpdp-workbench.test.ts, we mount only
// the router under test on a minimal Express app so global startup hooks
// aren't exercised.

import { it, expect, beforeAll, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { describeIfDB, resetDB, getPrisma, getAuthToken } from "../setup";
import { supportTicketsRouter } from "../../routes/support-tickets";
import { errorHandler } from "../../middleware/error";
import { tenantContextMiddleware } from "../../middleware/tenant";
import { withTenantContext } from "../../services/tenant-context";
import { waitForAuditFlush } from "../helpers/audit-wait";

let app: express.Express;

function buildTestApp(): express.Express {
  const a = express();
  a.use(express.json());
  a.use(tenantContextMiddleware);
  a.use(withTenantContext);
  a.use("/api/v1/support-tickets", supportTicketsRouter);
  a.use(errorHandler);
  return a;
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

async function seedAdmin(
  tenantId: string | null,
  label = "support",
): Promise<{ token: string; userId: string }> {
  const prisma = await getPrisma();
  const email = `${label}-admin-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 6)}@test.local`;
  const user = await prisma.user.create({
    data: {
      email,
      name: `Support Admin (${label})`,
      phone: `9${Math.floor(Math.random() * 1e9)
        .toString()
        .padStart(9, "0")}`,
      passwordHash: await bcrypt.hash("MedCoreT3st-2026", 4),
      role: "ADMIN",
      tenantId: tenantId ?? null,
      isActive: true,
    },
  });
  const token = jwt.sign(
    {
      userId: user.id,
      email: user.email,
      role: user.role,
      tenantId: tenantId ?? undefined,
    },
    process.env.JWT_SECRET || "test-jwt-secret-do-not-use-in-prod",
    { expiresIn: "1h" },
  );
  return { token, userId: user.id };
}

async function seedTenantWithAdmin(label: string): Promise<{
  tenantId: string;
  token: string;
  userId: string;
}> {
  const prisma = await getPrisma();
  const t = await prisma.tenant.create({
    data: {
      name: `Support Tenant ${label} ${Date.now()}`,
      subdomain: `support-${label}-${Math.random().toString(36).slice(2, 7)}`,
      plan: "BASIC",
      active: true,
    },
  });
  const { token, userId } = await seedAdmin(t.id, label);
  return { tenantId: t.id, token, userId };
}

describeIfDB("Pearl support inbox (integration)", () => {
  beforeAll(async () => {
    await resetDB();
    app = buildTestApp();
  });

  beforeEach(async () => {
    const prisma = await getPrisma();
    // Clean only the support-relevant rows + the support-admins we seed.
    // Like dpdp-workbench.test.ts we deliberately do NOT wipe the global
    // Patient/User table — other shared seeds rely on it.
    await prisma.auditLog.deleteMany({
      where: {
        action: {
          in: [
            "SUPPORT_TICKET_OPENED",
            "SUPPORT_TICKET_MESSAGE_ADDED",
            "SUPPORT_TICKET_UPDATED",
          ],
        },
      },
    });
    await prisma.supportTicketMessage.deleteMany({});
    await prisma.supportTicket.deleteMany({});
    await prisma.user.deleteMany({
      where: { email: { startsWith: "support-admin-" } },
    });
    // Drop the per-tenant admin rows we seed for cross-tenant isolation
    // tests — match prefix on labels we use below.
    await prisma.user.deleteMany({
      where: {
        email: {
          contains: "support-",
        },
      },
    });
    await prisma.tenant.deleteMany({
      where: { subdomain: { startsWith: "support-" } },
    });
    await ensureDefaultTenant();
  });

  // ── 1. End-to-end lifecycle: open → list → reply → status flip ──────
  it(
    "tenant ADMIN opens, super-admin lists, replies, assigns; status flips correctly",
    async () => {
      const prisma = await getPrisma();
      const tenantA = await seedTenantWithAdmin("a");
      const superA = await seedAdmin(null, "super");

      // ── 1a. Tenant ADMIN opens a ticket ──
      const openRes = await request(app)
        .post("/api/v1/support-tickets")
        .set("Authorization", `Bearer ${tenantA.token}`)
        .send({
          subject: "Razorpay payouts not landing",
          body: "Yesterday's payouts haven't hit our bank account.",
          priority: "HIGH",
        });
      expect(openRes.status).toBe(201);
      expect(openRes.body.success).toBe(true);
      expect(openRes.body.data.status).toBe("OPEN");
      expect(openRes.body.data.priority).toBe("HIGH");
      expect(openRes.body.data.tenantId).toBe(tenantA.tenantId);
      const ticketId = openRes.body.data.id as string;

      const openedAudit = await waitForAuditFlush(prisma, {
        action: "SUPPORT_TICKET_OPENED",
        entity: "support_ticket",
        entityId: ticketId,
      });
      expect(openedAudit.action).toBe("SUPPORT_TICKET_OPENED");

      // ── 1b. Super-admin sees the ticket in cross-tenant list ──
      const superListRes = await request(app)
        .get("/api/v1/support-tickets")
        .set("Authorization", `Bearer ${superA.token}`);
      expect(superListRes.status).toBe(200);
      const visibleIds = (
        superListRes.body.data.tickets as Array<{ id: string }>
      ).map((t) => t.id);
      expect(visibleIds).toContain(ticketId);

      // ── 1c. Super-admin posts a reply — status flips to AWAITING_TENANT ──
      const replyRes = await request(app)
        .post(`/api/v1/support-tickets/${ticketId}/messages`)
        .set("Authorization", `Bearer ${superA.token}`)
        .send({
          body: "Looking into your Razorpay account now — give us 30 min.",
        });
      expect(replyRes.status).toBe(201);
      expect(replyRes.body.data.ticket.status).toBe("AWAITING_TENANT");

      const replyAudit = await waitForAuditFlush(prisma, {
        action: "SUPPORT_TICKET_MESSAGE_ADDED",
        entity: "support_ticket",
        entityId: ticketId,
      });
      expect(replyAudit.action).toBe("SUPPORT_TICKET_MESSAGE_ADDED");

      // ── 1d. Super-admin assigns self + bumps priority via PATCH ──
      const patchRes = await request(app)
        .patch(`/api/v1/support-tickets/${ticketId}`)
        .set("Authorization", `Bearer ${superA.token}`)
        .send({
          status: "IN_PROGRESS",
          assignedToUserId: superA.userId,
          priority: "URGENT",
        });
      expect(patchRes.status).toBe(200);
      expect(patchRes.body.data.status).toBe("IN_PROGRESS");
      expect(patchRes.body.data.priority).toBe("URGENT");
      expect(patchRes.body.data.assignedToUserId).toBe(superA.userId);

      const patchAudit = await waitForAuditFlush(prisma, {
        action: "SUPPORT_TICKET_UPDATED",
        entity: "support_ticket",
        entityId: ticketId,
      });
      expect(patchAudit.action).toBe("SUPPORT_TICKET_UPDATED");

      // ── 1e. Tenant ADMIN posts back — status flips to OPEN ──
      const tenantReplyRes = await request(app)
        .post(`/api/v1/support-tickets/${ticketId}/messages`)
        .set("Authorization", `Bearer ${tenantA.token}`)
        .send({ body: "Thanks — checking on our end too." });
      expect(tenantReplyRes.status).toBe(201);
      expect(tenantReplyRes.body.data.ticket.status).toBe("OPEN");

      // ── 1f. Tenant ADMIN sees thread via GET /:id ──
      const detailRes = await request(app)
        .get(`/api/v1/support-tickets/${ticketId}`)
        .set("Authorization", `Bearer ${tenantA.token}`);
      expect(detailRes.status).toBe(200);
      expect(detailRes.body.data.id).toBe(ticketId);
      // Messages array includes both the super-admin reply and the tenant reply.
      const msgs = detailRes.body.data.messages as Array<{
        body: string;
        author: { id: string };
      }>;
      expect(msgs.length).toBe(2);
      expect(msgs.map((m) => m.author.id)).toEqual([
        superA.userId,
        tenantA.userId,
      ]);
    },
  );

  // ── 2. Cross-tenant ADMIN cannot read another tenant's ticket ───────
  it("cross-tenant ADMIN cannot GET or POST messages on a foreign ticket", async () => {
    const tenantA = await seedTenantWithAdmin("a");
    const tenantB = await seedTenantWithAdmin("b");
    const prisma = await getPrisma();

    const ticket = await prisma.supportTicket.create({
      data: {
        tenantId: tenantA.tenantId,
        openedByUserId: tenantA.userId,
        subject: "Private to A",
        body: "Tenant A confidential",
        status: "OPEN",
        priority: "NORMAL",
      },
    });

    // Tenant B's ADMIN attempting to read tenant A's ticket → 403.
    const detailRes = await request(app)
      .get(`/api/v1/support-tickets/${ticket.id}`)
      .set("Authorization", `Bearer ${tenantB.token}`);
    expect(detailRes.status).toBe(403);

    // Tenant B's ADMIN attempting to post a message → 403.
    const msgRes = await request(app)
      .post(`/api/v1/support-tickets/${ticket.id}/messages`)
      .set("Authorization", `Bearer ${tenantB.token}`)
      .send({ body: "Hi from another tenant" });
    expect(msgRes.status).toBe(403);

    // Tenant B's list does NOT include tenant A's ticket.
    const listRes = await request(app)
      .get("/api/v1/support-tickets")
      .set("Authorization", `Bearer ${tenantB.token}`);
    expect(listRes.status).toBe(200);
    const ids = (listRes.body.data.tickets as Array<{ id: string }>).map(
      (t) => t.id,
    );
    expect(ids).not.toContain(ticket.id);
  });

  // ── 3. PATIENT role 403'd on every surface ──────────────────────────
  it("PATIENT role is 403'd on POST / GET / PATCH", async () => {
    const patientToken = await getAuthToken("PATIENT");
    const r1 = await request(app)
      .post("/api/v1/support-tickets")
      .set("Authorization", `Bearer ${patientToken}`)
      .send({ subject: "test", body: "test", priority: "NORMAL" });
    expect(r1.status).toBe(403);

    const r2 = await request(app)
      .get("/api/v1/support-tickets")
      .set("Authorization", `Bearer ${patientToken}`);
    expect(r2.status).toBe(403);

    const r3 = await request(app)
      .patch("/api/v1/support-tickets/does-not-matter")
      .set("Authorization", `Bearer ${patientToken}`)
      .send({ status: "RESOLVED" });
    expect(r3.status).toBe(403);
  });

  // ── 4. PATCH by tenant-scoped ADMIN (non-super) → 403 ───────────────
  it("tenant-scoped ADMIN cannot PATCH (status / priority / assignee is super-admin only)", async () => {
    const tenantA = await seedTenantWithAdmin("patch-a");
    const prisma = await getPrisma();
    const ticket = await prisma.supportTicket.create({
      data: {
        tenantId: tenantA.tenantId,
        openedByUserId: tenantA.userId,
        subject: "Want to mark resolved myself",
        body: "Tenant can't do this",
        status: "OPEN",
        priority: "NORMAL",
      },
    });
    const res = await request(app)
      .patch(`/api/v1/support-tickets/${ticket.id}`)
      .set("Authorization", `Bearer ${tenantA.token}`)
      .send({ status: "RESOLVED" });
    expect(res.status).toBe(403);
  });

  // ── 5. POST messages on RESOLVED ticket → 409 ───────────────────────
  it("POSTing a message to a RESOLVED ticket returns 409", async () => {
    const tenantA = await seedTenantWithAdmin("resolved-a");
    const prisma = await getPrisma();
    const ticket = await prisma.supportTicket.create({
      data: {
        tenantId: tenantA.tenantId,
        openedByUserId: tenantA.userId,
        subject: "Resolved already",
        body: "...",
        status: "RESOLVED",
        priority: "NORMAL",
        resolvedAt: new Date(),
      },
    });
    const res = await request(app)
      .post(`/api/v1/support-tickets/${ticket.id}/messages`)
      .set("Authorization", `Bearer ${tenantA.token}`)
      .send({ body: "trying to reply" });
    expect(res.status).toBe(409);
  });
});
