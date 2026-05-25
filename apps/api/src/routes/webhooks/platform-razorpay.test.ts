/**
 * Pearl ERP Stage 1 §8.3 (gap rows 215-218 closure piece 3c, 2026-05-25) —
 * platform-side Razorpay-Subscriptions webhook unit tests.
 *
 * What / which modules / why
 * ──────────────────────────
 * - WHAT: pins the signature-verification gate (401 on missing /
 *   wrong / unsigned) and the happy paths for the five subscription
 *   events the handler maps to state-machine transitions
 *   (`subscription.charged`, `payment.failed`, `subscription.pending`,
 *   `subscription.halted`, `subscription.cancelled`).
 * - MODULES: mocks `@medcore/db`, the platform-invoice-generator's
 *   `markInvoicePaid`, and the platform-subscription-state transitions
 *   so the wire-up is tested in isolation from those modules' own
 *   unit tests (which live next to each module).
 * - WHY: webhooks are public-callable; a missing signature check OR a
 *   missing event dispatch is a customer-money-impacting bug. This
 *   suite is the unit gate before the integration suite (the
 *   integration suite for this handler will land alongside the
 *   first super-admin UI tile in piece 3d).
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import crypto from "crypto";

const WEBHOOK_SECRET = "platform_webhook_secret_unit";

// Hoist the mocks so they are visible to the `vi.mock` factory callbacks
// (which are themselves hoisted above the imports).
const {
  prismaMock,
  markInvoicePaidMock,
  transitionToActiveMock,
  transitionToPastDueMock,
  transitionToSuspendedMock,
  cancelSubscriptionMock,
} = vi.hoisted(() => {
  const base: any = {
    tenantSubscription: {
      findFirst: vi.fn(),
    },
    platformInvoice: {
      findFirst: vi.fn(),
    },
  };
  return {
    prismaMock: base,
    markInvoicePaidMock: vi.fn(async () => ({ status: "PAID", invoiceId: "inv-1" })),
    transitionToActiveMock: vi.fn(async () => ({
      changed: true,
      status: "active",
      subscriptionId: "sub-1",
    })),
    transitionToPastDueMock: vi.fn(async () => ({
      changed: true,
      status: "past_due",
      subscriptionId: "sub-1",
    })),
    transitionToSuspendedMock: vi.fn(async () => ({
      changed: true,
      status: "suspended",
      subscriptionId: "sub-1",
    })),
    cancelSubscriptionMock: vi.fn(async () => ({
      changed: true,
      status: "cancelled",
      subscriptionId: "sub-1",
    })),
  };
});

vi.mock("@medcore/db", () => ({ prisma: prismaMock }));

vi.mock("../../services/razorpay", () => ({
  // Real HMAC so signature behaviour is exercised, not stubbed.
  verifyWebhookSignature: (raw: Buffer, signature: string, secret: string | undefined) => {
    if (!secret) return false;
    const expected = crypto
      .createHmac("sha256", secret)
      .update(raw)
      .digest("hex");
    if (expected.length !== signature.length) return false;
    return crypto.timingSafeEqual(
      Buffer.from(expected, "hex"),
      Buffer.from(signature, "hex"),
    );
  },
}));

vi.mock("../../services/platform-invoice-generator", () => ({
  markInvoicePaid: markInvoicePaidMock,
}));

vi.mock("../../services/platform-subscription-state", () => ({
  transitionToActive: transitionToActiveMock,
  transitionToPastDue: transitionToPastDueMock,
  transitionToSuspended: transitionToSuspendedMock,
  cancelSubscription: cancelSubscriptionMock,
}));

import { platformRazorpayRouter } from "./platform-razorpay";

function buildApp() {
  const app = express();
  // No top-level express.json() — the inner express.raw() handles parsing.
  app.use("/api/v1/webhooks", platformRazorpayRouter);
  return app;
}

function signWebhook(body: string, secret = WEBHOOK_SECRET): string {
  return crypto.createHmac("sha256", secret).update(body).digest("hex");
}

function postWebhook(
  app: express.Express,
  event: object,
  opts: { signature?: string; secret?: string } = {},
) {
  const body = JSON.stringify(event);
  const r = request(app)
    .post("/api/v1/webhooks/platform-razorpay")
    .set("Content-Type", "application/json");
  const sig = opts.signature ?? signWebhook(body, opts.secret ?? WEBHOOK_SECRET);
  if (sig !== "__omit__") r.set("x-razorpay-signature", sig);
  return r.send(body);
}

const SUB_ROW = {
  id: "sub-1",
  tenantId: "t-1",
  status: "trial",
  currentPeriodStart: new Date("2026-05-01T00:00:00.000Z"),
  currentPeriodEnd: new Date("2026-06-01T00:00:00.000Z"),
};

describe("platform-razorpay-webhook — signature verification", () => {
  beforeEach(() => {
    process.env.RAZORPAY_PLATFORM_WEBHOOK_SECRET = WEBHOOK_SECRET;
    vi.clearAllMocks();
  });

  it("rejects requests with no x-razorpay-signature header (401)", async () => {
    const res = await postWebhook(
      buildApp(),
      { event: "subscription.charged" },
      { signature: "__omit__" },
    );
    expect(res.status).toBe(401);
    expect(prismaMock.tenantSubscription.findFirst).not.toHaveBeenCalled();
  });

  it("rejects requests with a wrong signature (401)", async () => {
    const res = await postWebhook(
      buildApp(),
      { event: "subscription.charged" },
      { signature: "deadbeef".repeat(8) },
    );
    expect(res.status).toBe(401);
    expect(prismaMock.tenantSubscription.findFirst).not.toHaveBeenCalled();
  });

  it("rejects requests when the env secret is unset in production-like config", async () => {
    delete process.env.RAZORPAY_PLATFORM_WEBHOOK_SECRET;
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const res = await postWebhook(buildApp(), { event: "subscription.charged" });
      expect(res.status).toBe(401);
    } finally {
      process.env.NODE_ENV = prev;
    }
  });

  it("returns 400 on a body whose JSON is malformed (after signature passes)", async () => {
    const rawText = "{not-json";
    const sig = signWebhook(rawText);
    const res = await request(buildApp())
      .post("/api/v1/webhooks/platform-razorpay")
      .set("Content-Type", "application/json")
      .set("x-razorpay-signature", sig)
      .send(rawText);
    expect(res.status).toBe(400);
  });
});

describe("platform-razorpay-webhook — subscription.charged", () => {
  beforeEach(() => {
    process.env.RAZORPAY_PLATFORM_WEBHOOK_SECRET = WEBHOOK_SECRET;
    vi.clearAllMocks();
  });

  it("marks the latest unpaid PlatformInvoice PAID and lifts trial → active", async () => {
    prismaMock.tenantSubscription.findFirst.mockResolvedValueOnce({
      ...SUB_ROW,
      status: "trial",
    });
    prismaMock.platformInvoice.findFirst.mockResolvedValueOnce({
      id: "inv-1",
      status: "ISSUED",
    });

    const event = {
      event: "subscription.charged",
      payload: {
        payment: { entity: { id: "pay_charge_1", amount: 499900, status: "captured" } },
        subscription: { entity: { id: "rzp_sub_abc" } },
      },
    };

    const res = await postWebhook(buildApp(), event);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true });
    expect(prismaMock.tenantSubscription.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { razorpaySubscriptionId: "rzp_sub_abc" },
      }),
    );
    expect(markInvoicePaidMock).toHaveBeenCalledWith(
      prismaMock,
      "inv-1",
      null,
      "pay_charge_1",
      expect.any(Date),
    );
    expect(transitionToActiveMock).toHaveBeenCalledWith(
      prismaMock,
      "sub-1",
      expect.any(Date),
    );
  });

  it("lifts past_due → active on a successful retry charge", async () => {
    prismaMock.tenantSubscription.findFirst.mockResolvedValueOnce({
      ...SUB_ROW,
      status: "past_due",
    });
    prismaMock.platformInvoice.findFirst.mockResolvedValueOnce({
      id: "inv-2",
      status: "ISSUED",
    });

    await postWebhook(buildApp(), {
      event: "subscription.charged",
      payload: {
        payment: { entity: { id: "pay_retry", amount: 100, status: "captured" } },
        subscription: { entity: { id: "rzp_sub_abc" } },
      },
    });

    expect(transitionToActiveMock).toHaveBeenCalled();
  });

  it("does NOT call transitionToActive when subscription is already active (idempotent)", async () => {
    prismaMock.tenantSubscription.findFirst.mockResolvedValueOnce({
      ...SUB_ROW,
      status: "active",
    });
    prismaMock.platformInvoice.findFirst.mockResolvedValueOnce({
      id: "inv-3",
      status: "ISSUED",
    });

    await postWebhook(buildApp(), {
      event: "subscription.charged",
      payload: {
        payment: { entity: { id: "pay_renew", amount: 100, status: "captured" } },
        subscription: { entity: { id: "rzp_sub_abc" } },
      },
    });

    expect(markInvoicePaidMock).toHaveBeenCalled();
    expect(transitionToActiveMock).not.toHaveBeenCalled();
  });

  it("acks 200 without DB writes when no matching TenantSubscription exists", async () => {
    prismaMock.tenantSubscription.findFirst.mockResolvedValueOnce(null);

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const res = await postWebhook(buildApp(), {
      event: "subscription.charged",
      payload: {
        payment: { entity: { id: "pay_orphan", amount: 100, status: "captured" } },
        subscription: { entity: { id: "rzp_sub_unknown" } },
      },
    });

    expect(res.status).toBe(200);
    expect(markInvoicePaidMock).not.toHaveBeenCalled();
    expect(transitionToActiveMock).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("still acks 200 + transitions when no unpaid PlatformInvoice exists", async () => {
    prismaMock.tenantSubscription.findFirst.mockResolvedValueOnce({
      ...SUB_ROW,
      status: "trial",
    });
    prismaMock.platformInvoice.findFirst.mockResolvedValueOnce(null);

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const res = await postWebhook(buildApp(), {
      event: "subscription.charged",
      payload: {
        payment: { entity: { id: "pay_first_ever", amount: 100, status: "captured" } },
        subscription: { entity: { id: "rzp_sub_abc" } },
      },
    });

    expect(res.status).toBe(200);
    expect(markInvoicePaidMock).not.toHaveBeenCalled();
    expect(transitionToActiveMock).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("platform-razorpay-webhook — failure / pending / halted / cancelled", () => {
  beforeEach(() => {
    process.env.RAZORPAY_PLATFORM_WEBHOOK_SECRET = WEBHOOK_SECRET;
    vi.clearAllMocks();
  });

  it("payment.failed → transitionToPastDue when active", async () => {
    prismaMock.tenantSubscription.findFirst.mockResolvedValueOnce({
      ...SUB_ROW,
      status: "active",
    });

    const res = await postWebhook(buildApp(), {
      event: "payment.failed",
      payload: { subscription: { entity: { id: "rzp_sub_abc" } } },
    });

    expect(res.status).toBe(200);
    expect(transitionToPastDueMock).toHaveBeenCalledWith(
      prismaMock,
      "sub-1",
      expect.any(Date),
    );
  });

  it("subscription.pending → transitionToPastDue when active", async () => {
    prismaMock.tenantSubscription.findFirst.mockResolvedValueOnce({
      ...SUB_ROW,
      status: "active",
    });

    const res = await postWebhook(buildApp(), {
      event: "subscription.pending",
      payload: { subscription: { entity: { id: "rzp_sub_abc" } } },
    });

    expect(res.status).toBe(200);
    expect(transitionToPastDueMock).toHaveBeenCalled();
  });

  it("payment.failed against already-past_due is a no-op (no second transition call)", async () => {
    prismaMock.tenantSubscription.findFirst.mockResolvedValueOnce({
      ...SUB_ROW,
      status: "past_due",
    });

    await postWebhook(buildApp(), {
      event: "payment.failed",
      payload: { subscription: { entity: { id: "rzp_sub_abc" } } },
    });

    expect(transitionToPastDueMock).not.toHaveBeenCalled();
  });

  it("subscription.halted on past_due → transitionToSuspended", async () => {
    prismaMock.tenantSubscription.findFirst.mockResolvedValueOnce({
      ...SUB_ROW,
      status: "past_due",
    });

    await postWebhook(buildApp(), {
      event: "subscription.halted",
      payload: { subscription: { entity: { id: "rzp_sub_abc" } } },
    });

    expect(transitionToSuspendedMock).toHaveBeenCalled();
  });

  it("subscription.halted on active → transitionToPastDue (preserve grace window)", async () => {
    prismaMock.tenantSubscription.findFirst.mockResolvedValueOnce({
      ...SUB_ROW,
      status: "active",
    });

    await postWebhook(buildApp(), {
      event: "subscription.halted",
      payload: { subscription: { entity: { id: "rzp_sub_abc" } } },
    });

    expect(transitionToPastDueMock).toHaveBeenCalled();
    expect(transitionToSuspendedMock).not.toHaveBeenCalled();
  });

  it("subscription.cancelled → cancelSubscription", async () => {
    prismaMock.tenantSubscription.findFirst.mockResolvedValueOnce({
      ...SUB_ROW,
      status: "active",
    });

    await postWebhook(buildApp(), {
      event: "subscription.cancelled",
      payload: { subscription: { entity: { id: "rzp_sub_abc" } } },
    });

    expect(cancelSubscriptionMock).toHaveBeenCalledWith(
      prismaMock,
      "sub-1",
      expect.any(Date),
    );
  });

  it("unknown event types ack 200 without any handler invocation", async () => {
    const res = await postWebhook(buildApp(), {
      event: "subscription.activated",
      payload: { subscription: { entity: { id: "rzp_sub_abc" } } },
    });

    expect(res.status).toBe(200);
    expect(prismaMock.tenantSubscription.findFirst).not.toHaveBeenCalled();
    expect(transitionToActiveMock).not.toHaveBeenCalled();
    expect(transitionToPastDueMock).not.toHaveBeenCalled();
    expect(transitionToSuspendedMock).not.toHaveBeenCalled();
    expect(cancelSubscriptionMock).not.toHaveBeenCalled();
  });

  it("handler errors are swallowed and the webhook still acks 200 (no infinite retry)", async () => {
    prismaMock.tenantSubscription.findFirst.mockRejectedValueOnce(new Error("db down"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await postWebhook(buildApp(), {
      event: "subscription.charged",
      payload: {
        payment: { entity: { id: "pay_x", amount: 100 } },
        subscription: { entity: { id: "rzp_sub_abc" } },
      },
    });

    expect(res.status).toBe(200);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});
