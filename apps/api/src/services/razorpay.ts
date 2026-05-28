import crypto from "crypto";
import { prisma } from "@medcore/db";

const ENV_RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID;
const ENV_RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;

interface RazorpayCreds {
  keyId: string;
  keySecret: string;
  source: "tenant" | "env";
}

// Pearl gap #10b — per-tenant Razorpay credentials.
// Per-tenant instance cache + creds cache, both keyed by tenantId.
// Env fallback uses tenantId='__env__' so the single-tenant path keeps
// using a single cached instance.
let Razorpay: any = null;
const instanceByTenant = new Map<string, any>();
const credsByTenant = new Map<string, { creds: RazorpayCreds | null; expiresAt: number }>();
const CREDS_TTL_MS = 60_000;

async function getCreds(tenantId: string | null | undefined): Promise<RazorpayCreds | null> {
  const cacheKey = tenantId ?? "__env__";
  const cached = credsByTenant.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.creds;

  let creds: RazorpayCreds | null = null;
  if (tenantId) {
    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { razorpayKeyId: true, razorpayKeySecret: true },
    });
    if (tenant?.razorpayKeyId && tenant?.razorpayKeySecret) {
      creds = {
        keyId: tenant.razorpayKeyId,
        keySecret: tenant.razorpayKeySecret,
        source: "tenant",
      };
    }
  }
  if (!creds && ENV_RAZORPAY_KEY_ID && ENV_RAZORPAY_KEY_SECRET) {
    creds = {
      keyId: ENV_RAZORPAY_KEY_ID,
      keySecret: ENV_RAZORPAY_KEY_SECRET,
      source: "env",
    };
  }
  credsByTenant.set(cacheKey, { creds, expiresAt: Date.now() + CREDS_TTL_MS });
  return creds;
}

async function getRazorpayInstance(tenantId: string | null | undefined): Promise<any | null> {
  const cacheKey = tenantId ?? "__env__";
  if (instanceByTenant.has(cacheKey)) return instanceByTenant.get(cacheKey);

  const creds = await getCreds(tenantId);
  if (!creds) {
    console.warn(
      "[Razorpay] No credentials available (neither tenant override nor env). " +
        "Online payments will return mock data.",
    );
    instanceByTenant.set(cacheKey, null);
    return null;
  }

  try {
    Razorpay = require("razorpay");
    const inst = new Razorpay({ key_id: creds.keyId, key_secret: creds.keySecret });
    instanceByTenant.set(cacheKey, inst);
    return inst;
  } catch {
    console.warn("[Razorpay] razorpay package not installed. Using mock mode.");
    instanceByTenant.set(cacheKey, null);
    return null;
  }
}

/** Test-only reset. Also called by the PATCH endpoint when admin rotates creds. */
export function invalidateRazorpayCacheForTenant(tenantId: string): void {
  instanceByTenant.delete(tenantId);
  credsByTenant.delete(tenantId);
}
export function __resetRazorpayCacheForTests(): void {
  instanceByTenant.clear();
  credsByTenant.clear();
}

export interface RazorpayOrder {
  orderId: string;
  amount: number; // in paise
  currency: string;
  keyId: string;
}

/**
 * Creates a Razorpay payment order for the given invoice.
 *
 * - Production (NODE_ENV=production): if RAZORPAY_KEY_ID/SECRET aren't
 *   configured, throws. The mock-order fallback ran on staging earlier
 *   and left `razorpayOrderId: "order_mock_*"` tokens in the live
 *   billing ledger that can't be reconciled with Razorpay or refunded
 *   through the gateway (#903). Fail-closed in prod is the only safe
 *   move.
 * - Non-production: returns synthetic mock data so dev/test/CI can
 *   exercise the booking flow without Razorpay creds.
 */
export async function createPaymentOrder(
  invoiceId: string,
  amount: number,
  tenantId?: string | null,
): Promise<RazorpayOrder> {
  const instance = await getRazorpayInstance(tenantId);
  const creds = await getCreds(tenantId);

  // Amount in paise (Razorpay uses smallest currency unit)
  const amountPaise = Math.round(amount * 100);

  if (!instance) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "Razorpay not configured (no tenant override + no RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET env). " +
          "Refusing to create a mock order in production — see #903.",
      );
    }
    // Non-production mock mode
    const mockOrderId = `order_mock_${Date.now()}_${invoiceId.slice(0, 8)}`;
    console.warn(`[Razorpay] Mock order created: ${mockOrderId}`);
    return {
      orderId: mockOrderId,
      amount: amountPaise,
      currency: "INR",
      keyId: creds?.keyId || "rzp_test_mock",
    };
  }

  const order = await instance.orders.create({
    amount: amountPaise,
    currency: "INR",
    receipt: invoiceId,
    notes: { invoiceId },
  });

  return {
    orderId: order.id,
    amount: order.amount,
    currency: order.currency,
    keyId: creds!.keyId,
  };
}

export interface PlatformPaymentLink {
  paymentLinkId: string;
  shortUrl: string;
  amountInPaise: number;
}

/**
 * Pearl §8.3 — create a Razorpay Payment Link for a PlatformInvoice. The
 * platform always uses the env-level Razorpay credentials (the platform
 * operator's own merchant account), not any tenant's credentials, so we
 * pass `tenantId: null` to `getRazorpayInstance`.
 *
 * Returns a `short_url` the operator opens in a new tab — the customer
 * (the tenant's billing contact) sees a Razorpay-hosted payment page
 * pre-filled with the invoice amount + reference. On successful payment
 * Razorpay fires the platform webhook (routes/webhooks/platform-razorpay.ts)
 * which flips the PlatformInvoice to PAID via `markInvoicePaid`.
 *
 * Non-production with no creds: returns a synthetic mock link so the
 * UI flow can be exercised end-to-end without Razorpay configured.
 */
export async function createPlatformPaymentLink(args: {
  invoiceId: string;
  invoiceNumber: string;
  amountInPaise: number;
  contactName: string;
  contactEmail: string | null;
}): Promise<PlatformPaymentLink> {
  const instance = await getRazorpayInstance(null);

  if (!instance) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "Platform Razorpay not configured (RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET missing). " +
          "Set the env vars or pre-create the payment link in the Razorpay dashboard.",
      );
    }
    return {
      paymentLinkId: `plink_mock_${Date.now()}_${args.invoiceId.slice(0, 8)}`,
      shortUrl: `https://rzp.io/i/mock-${args.invoiceNumber}`,
      amountInPaise: args.amountInPaise,
    };
  }

  // Razorpay's `paymentLink.create()` accepts `amount` in paise. `notify`
  // toggles the built-in email/SMS reminder; we set both false because
  // the platform mailer already controls invoice notifications. The
  // `notes.invoiceId` is how the webhook correlates the payment back to
  // the PlatformInvoice row.
  const link = await instance.paymentLink.create({
    amount: args.amountInPaise,
    currency: "INR",
    description: `MedCore HMS — Platform Invoice ${args.invoiceNumber}`,
    customer: {
      name: args.contactName,
      ...(args.contactEmail ? { email: args.contactEmail } : {}),
    },
    notify: { sms: false, email: false },
    reminder_enable: false,
    notes: {
      invoiceId: args.invoiceId,
      invoiceNumber: args.invoiceNumber,
      source: "platform_billing",
    },
  });

  return {
    paymentLinkId: link.id,
    shortUrl: link.short_url,
    amountInPaise: args.amountInPaise,
  };
}

/**
 * Verifies the Razorpay payment signature.
 *
 * - Production: requires RAZORPAY_KEY_SECRET. Returns false (fail-closed)
 *   if missing — refusing to accept an unsigned payment is far safer
 *   than silently green-lighting one. Matches verifyWebhookSignature's
 *   prod-safe stance.
 * - Non-production: when the secret is unset, returns true so the
 *   dev/test flow can complete without real Razorpay creds.
 */
export async function verifyPayment(
  razorpayOrderId: string,
  razorpayPaymentId: string,
  signature: string,
  tenantId?: string | null,
): Promise<boolean> {
  const creds = await getCreds(tenantId);
  if (!creds) {
    if (process.env.NODE_ENV === "production") {
      console.error(
        "[Razorpay] No credentials in production — refusing payment verification (#903).",
      );
      return false;
    }
    console.warn(
      "[Razorpay] No key secret — skipping signature verification (mock mode, non-production only).",
    );
    return true;
  }

  const body = `${razorpayOrderId}|${razorpayPaymentId}`;
  const expectedSignature = crypto
    .createHmac("sha256", creds.keySecret)
    .update(body)
    .digest("hex");

  return expectedSignature === signature;
}

/**
 * Verifies a Razorpay webhook signature.
 *
 * Razorpay computes HMAC-SHA256 over the raw JSON request body using the
 * webhook secret (configured per webhook in the Razorpay dashboard) and sends
 * the hex digest in the `x-razorpay-signature` header.
 *
 * IMPORTANT: callers MUST pass the **raw** request body bytes, not a JSON
 * re-serialization. Even key-order differences will break the signature. The
 * webhook route mounts `express.raw({type:'application/json'})` so `req.body`
 * is a Buffer when this is called.
 *
 * Fail-closed in production when the secret is missing — refusing to ack a
 * webhook is far safer than blindly trusting an unsigned one.
 */
export function verifyWebhookSignature(
  payload: string | Buffer,
  signature: string | undefined,
  secret: string | undefined
): boolean {
  if (!secret) {
    if (process.env.NODE_ENV === "production") {
      console.error(
        "[Razorpay] RAZORPAY_WEBHOOK_SECRET is unset in production — refusing webhook."
      );
      return false;
    }
    console.warn(
      "[Razorpay] No webhook secret — accepting webhook (mock mode, non-production only)."
    );
    return true;
  }
  if (!signature) return false;

  const expected = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  // Length-safe constant-time compare to avoid timing leaks.
  let a: Buffer;
  let b: Buffer;
  try {
    a = Buffer.from(expected, "hex");
    b = Buffer.from(signature, "hex");
  } catch {
    return false;
  }
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Fetch an order from Razorpay so we can cross-check `amount_paid`. Returns
 * `null` when Razorpay isn't configured (mock mode) so the caller can fall
 * back to local invoice math instead of failing closed in dev.
 */
export async function fetchOrderAmountPaid(
  orderId: string,
  tenantId?: string | null,
): Promise<number | null> {
  const instance = await getRazorpayInstance(tenantId);
  if (!instance) return null;
  try {
    const order = await instance.orders.fetch(orderId);
    if (!order || typeof order.amount_paid !== "number") return null;
    return order.amount_paid; // paise
  } catch (e) {
    console.error("[Razorpay] orders.fetch failed", e);
    return null;
  }
}

/**
 * Fetch an order's STATED amount (what we asked Razorpay to charge), not what
 * was actually paid. Used at /pay-online to detect "stale order" — an existing
 * razorpayOrderId stamped on the invoice for the wrong rupee total, e.g.
 * because the invoice totals changed after the order was created. Returns
 * `null` in mock mode or when Razorpay can't be reached.
 */
export async function fetchOrderAmount(
  orderId: string,
  tenantId?: string | null,
): Promise<number | null> {
  const instance = await getRazorpayInstance(tenantId);
  if (!instance) return null;
  try {
    const order = await instance.orders.fetch(orderId);
    if (!order || typeof order.amount !== "number") return null;
    return order.amount; // paise
  } catch (e) {
    console.error("[Razorpay] orders.fetch failed", e);
    return null;
  }
}
