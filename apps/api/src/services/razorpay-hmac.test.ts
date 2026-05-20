// Real HMAC-SHA256 signature-verify tests for the Razorpay integration.
// Covers: known-good signature, tampered signature, swapped order/payment ids,
// empty signature, and the documented mock-mode bypass.
//
// 2026-05-21 (Pearl #10b): verifyPayment is now async because creds may
// come from a per-tenant DB lookup. Every assertion awaits the result.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import crypto from "crypto";

const SECRET = "test_secret_known_good_42";
const ORDER_ID = "order_TestAbc12345";
const PAYMENT_ID = "pay_TestXyz67890";

function sign(secret: string, body: string): string {
  return crypto.createHmac("sha256", secret).update(body).digest("hex");
}

describe("razorpay verifyPayment — HMAC SHA256 truth table", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.RAZORPAY_KEY_SECRET = SECRET;
    process.env.RAZORPAY_KEY_ID = "rzp_test_keyid";
  });
  afterEach(() => {
    delete process.env.RAZORPAY_KEY_SECRET;
    delete process.env.RAZORPAY_KEY_ID;
  });

  it("accepts a correctly-signed (orderId|paymentId, key_secret) tuple", async () => {
    const { verifyPayment } = await import("./razorpay");
    const sig = sign(SECRET, `${ORDER_ID}|${PAYMENT_ID}`);
    expect(await verifyPayment(ORDER_ID, PAYMENT_ID, sig)).toBe(true);
  });

  it("rejects a tampered signature (single char flipped)", async () => {
    const { verifyPayment } = await import("./razorpay");
    const sig = sign(SECRET, `${ORDER_ID}|${PAYMENT_ID}`);
    const tampered = sig.slice(0, -1) + (sig.endsWith("a") ? "b" : "a");
    expect(await verifyPayment(ORDER_ID, PAYMENT_ID, tampered)).toBe(false);
  });

  it("rejects a signature where order_id and payment_id are swapped", async () => {
    const { verifyPayment } = await import("./razorpay");
    // Sign with the swapped order — caller passes the un-swapped values.
    const swappedSig = sign(SECRET, `${PAYMENT_ID}|${ORDER_ID}`);
    expect(await verifyPayment(ORDER_ID, PAYMENT_ID, swappedSig)).toBe(false);
  });

  it("rejects an empty signature string", async () => {
    const { verifyPayment } = await import("./razorpay");
    expect(await verifyPayment(ORDER_ID, PAYMENT_ID, "")).toBe(false);
  });

  it("rejects a signature signed with a different key secret", async () => {
    const { verifyPayment } = await import("./razorpay");
    const wrongSig = sign("some_other_secret", `${ORDER_ID}|${PAYMENT_ID}`);
    expect(await verifyPayment(ORDER_ID, PAYMENT_ID, wrongSig)).toBe(false);
  });
});

describe("razorpay verifyPayment — mock-mode bypass (DOCUMENTED RISK)", () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.RAZORPAY_KEY_SECRET;
    delete process.env.RAZORPAY_KEY_ID;
  });

  // RISK: when RAZORPAY_KEY_SECRET is not set AND no tenantId override
  // is supplied, the verify function returns true unconditionally so dev/
  // test can complete without real creds. Production fail-closed guards
  // (see razorpay.test.ts) prevent this in NODE_ENV=production.
  it("returns true unconditionally when key secret is missing (mock mode)", async () => {
    const { verifyPayment } = await import("./razorpay");
    expect(await verifyPayment("any_order", "any_payment", "garbage_sig")).toBe(true);
    expect(await verifyPayment("", "", "")).toBe(true);
  });
});
