import crypto from "crypto";

const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID;
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;

let Razorpay: any = null;
let razorpayInstance: any = null;

function getRazorpayInstance(): any | null {
  if (razorpayInstance) return razorpayInstance;

  if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET) {
    console.warn(
      "[Razorpay] RAZORPAY_KEY_ID and/or RAZORPAY_KEY_SECRET not configured. " +
        "Online payments will return mock data."
    );
    return null;
  }

  try {
    // Dynamic import — razorpay may not be installed in all environments
    Razorpay = require("razorpay");
    razorpayInstance = new Razorpay({
      key_id: RAZORPAY_KEY_ID,
      key_secret: RAZORPAY_KEY_SECRET,
    });
    return razorpayInstance;
  } catch {
    console.warn("[Razorpay] razorpay package not installed. Using mock mode.");
    return null;
  }
}

export interface RazorpayOrder {
  orderId: string;
  amount: number; // in paise
  currency: string;
  keyId: string;
}

/**
 * Creates a Razorpay payment order for the given invoice.
 * If Razorpay is not configured, returns mock data so the app doesn't crash.
 */
export async function createPaymentOrder(
  invoiceId: string,
  amount: number
): Promise<RazorpayOrder> {
  const instance = getRazorpayInstance();

  // Amount in paise (Razorpay uses smallest currency unit)
  const amountPaise = Math.round(amount * 100);

  if (!instance) {
    // Mock mode
    const mockOrderId = `order_mock_${Date.now()}_${invoiceId.slice(0, 8)}`;
    console.warn(`[Razorpay] Mock order created: ${mockOrderId}`);
    return {
      orderId: mockOrderId,
      amount: amountPaise,
      currency: "INR",
      keyId: RAZORPAY_KEY_ID || "rzp_test_mock",
    };
  }

  const order = await instance.orders.create({
    amount: amountPaise,
    currency: "INR",
    receipt: invoiceId,
    notes: {
      invoiceId,
    },
  });

  return {
    orderId: order.id,
    amount: order.amount,
    currency: order.currency,
    keyId: RAZORPAY_KEY_ID!,
  };
}

/**
 * Verifies the Razorpay payment signature.
 * Returns true if the signature is valid.
 * In mock mode (no secret configured), always returns true.
 */
export function verifyPayment(
  razorpayOrderId: string,
  razorpayPaymentId: string,
  signature: string
): boolean {
  if (!RAZORPAY_KEY_SECRET) {
    console.warn("[Razorpay] No key secret — skipping signature verification (mock mode).");
    return true;
  }

  const body = `${razorpayOrderId}|${razorpayPaymentId}`;
  const expectedSignature = crypto
    .createHmac("sha256", RAZORPAY_KEY_SECRET)
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
  orderId: string
): Promise<number | null> {
  const instance = getRazorpayInstance();
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
