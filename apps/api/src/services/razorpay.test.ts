import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import crypto from "crypto";

describe("razorpay service - mock mode", () => {
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    vi.resetModules();
    delete process.env.RAZORPAY_KEY_ID;
    delete process.env.RAZORPAY_KEY_SECRET;
    // Default to test env for the existing mock-mode cases.
    process.env.NODE_ENV = "test";
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  it("creates a mock order with the correct shape and amount in paise", async () => {
    // Re-import to pick up cleared env
    const mod = await import("./razorpay");
    const order = await mod.createPaymentOrder("550e8400-e29b-41d4-a716-446655440001", 199.5);
    expect(order.orderId).toMatch(/^order_mock_/);
    expect(order.amount).toBe(19950); // 199.5 * 100
    expect(order.currency).toBe("INR");
    expect(order.keyId).toBeTruthy();
  });

  it("verifyPayment returns true in mock mode (no secret)", async () => {
    const mod = await import("./razorpay");
    expect(await mod.verifyPayment("o", "p", "garbage")).toBe(true);
  });
});

describe("razorpay service - production fail-closed guards (#903)", () => {
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    vi.resetModules();
    delete process.env.RAZORPAY_KEY_ID;
    delete process.env.RAZORPAY_KEY_SECRET;
    process.env.NODE_ENV = "production";
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  it("createPaymentOrder throws in production when Razorpay is not configured", async () => {
    const mod = await import("./razorpay");
    await expect(
      mod.createPaymentOrder("550e8400-e29b-41d4-a716-446655440002", 100)
    ).rejects.toThrow(/refusing to create a mock order in production/i);
  });

  it("verifyPayment returns false in production when RAZORPAY_KEY_SECRET is unset", async () => {
    const mod = await import("./razorpay");
    // Even a syntactically-valid HMAC fails because the secret is missing
    // — we don't trust ANY payment in production without the secret.
    expect(await mod.verifyPayment("o", "p", "a".repeat(64))).toBe(false);
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
    expect(await mod.verifyPayment(orderId, paymentId, expected)).toBe(true);
  });

  it("returns false for an invalid signature", async () => {
    const mod = await import("./razorpay");
    expect(await mod.verifyPayment("order_abc", "pay_xyz", "deadbeef")).toBe(false);
  });
});
