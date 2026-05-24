// Integration tests for the operator-facing platform-billing API —
// Pearl ERP Stage 1 §8.3 (gap rows 215-218 closure piece 3-UI,
// 2026-05-25).
//
// Covers /api/v1/platform-billing/{subscriptions, invoices,
// invoices/:id, invoices/:id/mark-paid}:
//   - GET /subscriptions returns rows with tenant info; super-admin
//     (tenant-less ADMIN), PLATFORM_OPERATOR, PLATFORM_BILLING_OPERATOR
//     all see the list; DOCTOR/PATIENT 403.
//   - GET /invoices defaults to status=ISSUED; ?status=all surfaces
//     PAID rows too.
//   - GET /invoices/:id returns line items + tenant info; 404 on bogus id.
//   - POST /invoices/:id/mark-paid flips ISSUED→PAID + writes
//     PLATFORM_INVOICE_MARKED_PAID audit row; idempotent on re-call.
//   - POST /invoices/:id/mark-paid 400 on missing paymentReference; 404
//     on bogus invoice id; 403 for tenant-less ADMIN (legacy super-admin
//     can READ but not mark paid per PEARL_OPEN_DECISIONS.md #1).
//
// Mounts only the router under test on a minimal Express app so global
// startup hooks aren't exercised, and scopes the `beforeEach` cleanup
// to ONLY the rows this suite seeds.

import { it, expect, beforeAll, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import {
  describeIfDB,
  resetDB,
  getPrisma,
  getAuthToken,
} from "../setup";
import { platformBillingRouter } from "../../routes/platform-billing";
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
  a.use("/api/v1/platform-billing", platformBillingRouter);
  a.use(errorHandler);
  return a;
}

interface SeededInvoiceContext {
  tenantId: string;
  subscriptionId: string;
  invoiceId: string;
  invoiceNumber: string;
}

const SEED_PREFIX = "pb-test-";

async function ensurePlatformOpUser(role: "PLATFORM_OPERATOR" | "PLATFORM_BILLING_OPERATOR"): Promise<{
  token: string;
  userId: string;
}> {
  const prisma = await getPrisma();
  const email = `${SEED_PREFIX}${role.toLowerCase()}-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 6)}@test.local`;
  const user = await prisma.user.create({
    data: {
      email,
      name: `Test ${role}`,
      phone: `9${Math.floor(Math.random() * 1e9)
        .toString()
        .padStart(9, "0")}`,
      passwordHash: await bcrypt.hash("MedCoreT3st-2026", 4),
      role: role as any,
      tenantId: null,
      isActive: true,
    },
  });
  const token = jwt.sign(
    {
      userId: user.id,
      email: user.email,
      role: user.role,
    },
    process.env.JWT_SECRET || "test-jwt-secret-do-not-use-in-prod",
    { expiresIn: "1h" },
  );
  return { token, userId: user.id };
}

async function ensureTenantLessAdmin(): Promise<{ token: string; userId: string }> {
  const prisma = await getPrisma();
  const email = `${SEED_PREFIX}sa-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 6)}@test.local`;
  const user = await prisma.user.create({
    data: {
      email,
      name: "Test Super Admin",
      phone: `9${Math.floor(Math.random() * 1e9)
        .toString()
        .padStart(9, "0")}`,
      passwordHash: await bcrypt.hash("MedCoreT3st-2026", 4),
      role: "ADMIN" as any,
      tenantId: null,
      isActive: true,
    },
  });
  const token = jwt.sign(
    { userId: user.id, email: user.email, role: user.role },
    process.env.JWT_SECRET || "test-jwt-secret-do-not-use-in-prod",
    { expiresIn: "1h" },
  );
  return { token, userId: user.id };
}

async function seedInvoiceFixture(): Promise<SeededInvoiceContext> {
  const prisma = await getPrisma();
  const subdomain = `${SEED_PREFIX}t-${Math.random().toString(36).slice(2, 8)}`;
  const tenant = await prisma.tenant.create({
    data: {
      name: `PB Test Tenant ${subdomain}`,
      subdomain,
      plan: "BASIC",
      active: true,
    },
  });
  // Subscription for that tenant. TenantSubscription.tenantId is @unique
  // so we never collide here.
  const sub = await prisma.tenantSubscription.create({
    data: {
      tenantId: tenant.id,
      plan: "GROWTH",
      status: "active",
      currentPeriodStart: new Date("2026-04-01T00:00:00Z"),
      currentPeriodEnd: new Date("2026-05-01T00:00:00Z"),
    },
  });
  // Unique invoiceNumber to avoid collisions across re-runs.
  const invoiceNumber = `PI-202604-${Math.floor(Math.random() * 9000 + 1000)
    .toString()
    .padStart(4, "0")}`;
  const invoice = await prisma.platformInvoice.create({
    data: {
      invoiceNumber,
      tenantId: tenant.id,
      subscriptionId: sub.id,
      periodStart: new Date("2026-04-01T00:00:00Z"),
      periodEnd: new Date("2026-05-01T00:00:00Z"),
      subtotalInPaise: 1499900,
      cgstInPaise: 134991,
      sgstInPaise: 134991,
      igstInPaise: 0,
      totalInPaise: 1769882,
      status: "ISSUED",
      issuedAt: new Date(),
      lineItems: {
        create: [
          {
            description: "MedCore HMS — Growth subscription April 2026",
            unitPriceInPaise: 1499900,
            quantity: 1,
            amountInPaise: 1499900,
            hsnSacCode: "998314",
            cgstRate: 9,
            sgstRate: 9,
            igstRate: 0,
          },
        ],
      },
    },
  });
  return {
    tenantId: tenant.id,
    subscriptionId: sub.id,
    invoiceId: invoice.id,
    invoiceNumber,
  };
}

async function cleanupSeed(): Promise<void> {
  const prisma = await getPrisma();
  // Audit rows first (no FK to invoice, but tied to invoiceIds by entityId).
  await prisma.auditLog.deleteMany({
    where: {
      action: { in: ["PLATFORM_INVOICE_MARKED_PAID", "PLATFORM_INVOICE_GENERATED"] },
    },
  });
  // PlatformInvoice (cascades line items via FK).
  await prisma.platformInvoice.deleteMany({
    where: { invoiceNumber: { startsWith: "PI-202604-" } },
  });
  // TenantSubscription rows.
  await prisma.tenantSubscription.deleteMany({
    where: { tenant: { subdomain: { startsWith: SEED_PREFIX } } },
  });
  // Test users.
  await prisma.user.deleteMany({
    where: { email: { startsWith: SEED_PREFIX } },
  });
  // Test tenants last.
  await prisma.tenant.deleteMany({
    where: { subdomain: { startsWith: SEED_PREFIX } },
  });
}

describeIfDB("Operator platform-billing API (integration)", () => {
  beforeAll(async () => {
    await resetDB();
    app = buildTestApp();
  });

  beforeEach(async () => {
    await cleanupSeed();
  });

  // ── 1. GET /subscriptions ──────────────────────────────────────────
  it("super-admin (tenant-less ADMIN) GET /subscriptions returns rows with tenant info", async () => {
    const seed = await seedInvoiceFixture();
    const { token } = await ensureTenantLessAdmin();
    const res = await request(app)
      .get("/api/v1/platform-billing/subscriptions")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const subs = res.body.data.subscriptions as Array<{
      tenantId: string;
      tenant: { name: string; subdomain: string };
      plan: string;
      status: string;
    }>;
    const mine = subs.find((s) => s.tenantId === seed.tenantId);
    expect(mine).toBeDefined();
    expect(mine?.plan).toBe("GROWTH");
    expect(mine?.status).toBe("active");
    expect(mine?.tenant?.name).toMatch(/PB Test Tenant/);
  });

  it("PLATFORM_OPERATOR GET /subscriptions returns rows", async () => {
    await seedInvoiceFixture();
    const { token } = await ensurePlatformOpUser("PLATFORM_OPERATOR");
    const res = await request(app)
      .get("/api/v1/platform-billing/subscriptions")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data.subscriptions)).toBe(true);
  });

  it("PATIENT is 403'd at the platform-operator/super-admin gate", async () => {
    const patientToken = await getAuthToken("PATIENT");
    const res = await request(app)
      .get("/api/v1/platform-billing/subscriptions")
      .set("Authorization", `Bearer ${patientToken}`);
    expect(res.status).toBe(403);
  });

  it("DOCTOR is 403'd at the platform-operator/super-admin gate", async () => {
    const docToken = await getAuthToken("DOCTOR");
    const res = await request(app)
      .get("/api/v1/platform-billing/subscriptions")
      .set("Authorization", `Bearer ${docToken}`);
    expect(res.status).toBe(403);
  });

  // ── 2. GET /invoices defaults to ISSUED ─────────────────────────────
  it("GET /invoices defaults to status=ISSUED and only returns ISSUED rows", async () => {
    const seed = await seedInvoiceFixture();
    const { token } = await ensurePlatformOpUser("PLATFORM_BILLING_OPERATOR");
    const res = await request(app)
      .get("/api/v1/platform-billing/invoices")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    const invoices = res.body.data.invoices as Array<{
      id: string;
      status: string;
      tenant: { id: string };
    }>;
    const mine = invoices.find((i) => i.id === seed.invoiceId);
    expect(mine).toBeDefined();
    expect(mine?.status).toBe("ISSUED");
    // Every row must be ISSUED (we asked for ISSUED).
    expect(invoices.every((i) => i.status === "ISSUED")).toBe(true);
  });

  it("GET /invoices?status=all surfaces PAID rows too", async () => {
    const seed = await seedInvoiceFixture();
    const prisma = await getPrisma();
    // Flip it to PAID directly in DB so the listing endpoint is
    // the unit under test (mark-paid is exercised below).
    await prisma.platformInvoice.update({
      where: { id: seed.invoiceId },
      data: { status: "PAID", paidAt: new Date(), paymentReference: "MANUAL-TEST" },
    });
    const { token } = await ensurePlatformOpUser("PLATFORM_BILLING_OPERATOR");
    const res = await request(app)
      .get("/api/v1/platform-billing/invoices?status=all")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    const invoices = res.body.data.invoices as Array<{
      id: string;
      status: string;
    }>;
    const mine = invoices.find((i) => i.id === seed.invoiceId);
    expect(mine).toBeDefined();
    expect(mine?.status).toBe("PAID");
  });

  // ── 3. GET /invoices/:id detail ────────────────────────────────────
  it("GET /invoices/:id returns line items + tenant info", async () => {
    const seed = await seedInvoiceFixture();
    const { token } = await ensurePlatformOpUser("PLATFORM_OPERATOR");
    const res = await request(app)
      .get(`/api/v1/platform-billing/invoices/${seed.invoiceId}`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    const invoice = res.body.data.invoice;
    expect(invoice.id).toBe(seed.invoiceId);
    expect(invoice.invoiceNumber).toBe(seed.invoiceNumber);
    expect(invoice.tenant?.id).toBe(seed.tenantId);
    expect(Array.isArray(invoice.lineItems)).toBe(true);
    expect(invoice.lineItems.length).toBe(1);
    expect(invoice.lineItems[0].hsnSacCode).toBe("998314");
  });

  it("GET /invoices/:id returns 404 on unknown id", async () => {
    const { token } = await ensurePlatformOpUser("PLATFORM_OPERATOR");
    const res = await request(app)
      .get("/api/v1/platform-billing/invoices/00000000-0000-0000-0000-000000000000")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });

  // ── 4. POST /invoices/:id/mark-paid ─────────────────────────────────
  it("PLATFORM_BILLING_OPERATOR POST mark-paid flips ISSUED→PAID + writes audit row", async () => {
    const seed = await seedInvoiceFixture();
    const { token, userId } = await ensurePlatformOpUser("PLATFORM_BILLING_OPERATOR");
    const res = await request(app)
      .post(`/api/v1/platform-billing/invoices/${seed.invoiceId}/mark-paid`)
      .set("Authorization", `Bearer ${token}`)
      .send({ paymentReference: "RZP-TEST-12345" });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.transition).toBe("PAID");
    expect(res.body.data.invoice.status).toBe("PAID");
    expect(res.body.data.invoice.paymentReference).toBe("RZP-TEST-12345");

    const prisma = await getPrisma();
    const audit = await waitForAuditFlush(prisma, {
      action: "PLATFORM_INVOICE_MARKED_PAID",
      entity: "platform_invoice",
      entityId: seed.invoiceId,
      userId,
    });
    expect(audit.action).toBe("PLATFORM_INVOICE_MARKED_PAID");

    // DB confirms.
    const row = await prisma.platformInvoice.findUnique({
      where: { id: seed.invoiceId },
      select: { status: true, paidByUserId: true, paymentReference: true },
    });
    expect(row?.status).toBe("PAID");
    expect(row?.paidByUserId).toBe(userId);
    expect(row?.paymentReference).toBe("RZP-TEST-12345");
  });

  it("POST mark-paid is idempotent: re-call on a PAID row returns ALREADY_PAID", async () => {
    const seed = await seedInvoiceFixture();
    const { token } = await ensurePlatformOpUser("PLATFORM_BILLING_OPERATOR");
    // First call flips it.
    await request(app)
      .post(`/api/v1/platform-billing/invoices/${seed.invoiceId}/mark-paid`)
      .set("Authorization", `Bearer ${token}`)
      .send({ paymentReference: "RZP-TEST-001" })
      .expect(200);
    // Second call — same invoice, different paymentReference.
    const res2 = await request(app)
      .post(`/api/v1/platform-billing/invoices/${seed.invoiceId}/mark-paid`)
      .set("Authorization", `Bearer ${token}`)
      .send({ paymentReference: "RZP-TEST-002" });
    expect(res2.status).toBe(200);
    expect(res2.body.data.transition).toBe("ALREADY_PAID");
    // Original paymentReference unchanged.
    const prisma = await getPrisma();
    const row = await prisma.platformInvoice.findUnique({
      where: { id: seed.invoiceId },
      select: { paymentReference: true },
    });
    expect(row?.paymentReference).toBe("RZP-TEST-001");
  });

  it("POST mark-paid returns 400 when paymentReference is missing/empty", async () => {
    const seed = await seedInvoiceFixture();
    const { token } = await ensurePlatformOpUser("PLATFORM_BILLING_OPERATOR");
    const res = await request(app)
      .post(`/api/v1/platform-billing/invoices/${seed.invoiceId}/mark-paid`)
      .set("Authorization", `Bearer ${token}`)
      .send({ paymentReference: "" });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it("POST mark-paid returns 404 on unknown invoice id", async () => {
    const { token } = await ensurePlatformOpUser("PLATFORM_BILLING_OPERATOR");
    const res = await request(app)
      .post("/api/v1/platform-billing/invoices/00000000-0000-0000-0000-000000000000/mark-paid")
      .set("Authorization", `Bearer ${token}`)
      .send({ paymentReference: "RZP-X" });
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });

  it("POST mark-paid 403s a tenant-less ADMIN (super-admin can READ but not mark paid)", async () => {
    const seed = await seedInvoiceFixture();
    const { token } = await ensureTenantLessAdmin();
    const res = await request(app)
      .post(`/api/v1/platform-billing/invoices/${seed.invoiceId}/mark-paid`)
      .set("Authorization", `Bearer ${token}`)
      .send({ paymentReference: "RZP-X" });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/PLATFORM_OPERATOR/);
    // DB row unchanged.
    const prisma = await getPrisma();
    const row = await prisma.platformInvoice.findUnique({
      where: { id: seed.invoiceId },
      select: { status: true },
    });
    expect(row?.status).toBe("ISSUED");
  });
});
