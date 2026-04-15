import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import crypto from "crypto";

describe("razorpay service - mock mode", () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.RAZORPAY_KEY_ID;
    delete process.env.RAZORPAY_KEY_SECRET;
  });

  it("creates a mock order with the correct shape and amount in paise", async () => {
    // Re-import to pick up cleared env
    const mod = await import("./razorpay");
    const order = await mod.createPaymentOrder("00000000-0000-0000-0000-000000000001", 199.5);
    expect(order.orderId).toMatch(/^order_mock_/);
    expect(order.amount).toBe(19950); // 199.5 * 100
    expect(order.currency).toBe("INR");
    expect(order.keyId).toBeTruthy();
  });

  it("verifyPayment returns true in mock mode (no secret)", async () => {
    const mod = await import("./razorpay");
    expect(mod.verifyPayment("o", "p", "garbage")).toBe(true);
  });
});

describe("razorpay verifyPayment - signature verification", () => {
  const SECRET = "test_secret_123";

  beforeEach(() => {
    vi.resetModules();
    process.env.RAZORPAY_KEY_SECRET = SECRET;
  });

  afterEach(() => {
    delete process.env.RAZORPAY_KEY_SECRET;
  });

  it("returns true for a valid HMAC SHA256 signature", async () => {
    const mod = await import("./razorpay");
    const orderId = "order_abc";
    const paymentId = "pay_xyz";
    const expected = crypto
      .createHmac("sha256", SECRET)
      .update(`${orderId}|${paymentId}`)
      .digest("hex");
    expect(mod.verifyPayment(orderId, paymentId, expected)).toBe(true);
  });

  it("returns false for an invalid signature", async () => {
    const mod = await import("./razorpay");
    expect(mod.verifyPayment("order_abc", "pay_xyz", "deadbeef")).toBe(false);
  });
});
