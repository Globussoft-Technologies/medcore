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
