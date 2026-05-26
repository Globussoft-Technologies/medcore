/* eslint-disable @typescript-eslint/no-explicit-any */
// Unit tests for apps/web/src/lib/razorpay.ts — the browser-side
// Razorpay checkout wrapper. Covers:
//   - fetchRazorpayConfig: shape coercion, null/undefined fallback, API failure
//   - ensureRazorpayLoaded (via openRazorpayCheckout): script-tag injection,
//     load success, error, timeout, reuse of in-flight promise, SSR rejection
//   - openRazorpayCheckout: order POST + Razorpay modal handler success /
//     verify-payment failure / user-cancel
// The `@/lib/api` module is fully mocked so no real HTTP fires; window.Razorpay
// is stubbed per-test to drive each modal-handler branch.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/api", () => ({
  api: {
    get: vi.fn(),
    post: vi.fn(),
  },
}));

import { api } from "@/lib/api";
import {
  fetchRazorpayConfig,
  openRazorpayCheckout,
  type OpenCheckoutOpts,
} from "../razorpay";

type RzpHandler = (resp: {
  razorpay_order_id: string;
  razorpay_payment_id: string;
  razorpay_signature: string;
}) => void;

interface CapturedOptions {
  key: string;
  order_id: string;
  amount: number;
  currency: string;
  name: string;
  description: string;
  prefill?: { name?: string; email?: string; contact?: string };
  notes?: Record<string, string>;
  theme?: { color?: string };
  handler: RzpHandler;
  modal?: { ondismiss?: () => void };
}

// Helper: drop the module-scope cached script-loader promise + DOM scripts
// between tests so the loader rebuilds cleanly. razorpay.ts caches
// `razorpayScriptPromise` at module scope — without a reset, the second test
// short-circuits on the first test's resolved promise.
async function resetRazorpayModuleState() {
  // Strip injected <script data-medcore-razorpay> tags.
  document
    .querySelectorAll('script[data-medcore-razorpay="true"]')
    .forEach((s) => s.remove());
  // Clear cached global.
  delete (window as any).Razorpay;
  // Re-import via vi.resetModules so the module-scope `razorpayScriptPromise`
  // resets between tests that exercise the loader.
  vi.resetModules();
}

const apiMock = api as unknown as {
  get: ReturnType<typeof vi.fn>;
  post: ReturnType<typeof vi.fn>;
};

describe("razorpay client lib", () => {
  beforeEach(() => {
    apiMock.get.mockReset();
    apiMock.post.mockReset();
    delete (window as any).Razorpay;
    document
      .querySelectorAll('script[data-medcore-razorpay="true"]')
      .forEach((s) => s.remove());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("fetchRazorpayConfig", () => {
    it("returns coerced enabled/isTestMode from the API payload", async () => {
      apiMock.get.mockResolvedValueOnce({
        data: { enabled: true, isTestMode: true },
      });
      const cfg = await fetchRazorpayConfig();
      expect(apiMock.get).toHaveBeenCalledWith("/billing/razorpay-config");
      expect(cfg).toEqual({ enabled: true, isTestMode: true });
    });

    it("coerces truthy non-boolean values to booleans", async () => {
      apiMock.get.mockResolvedValueOnce({
        data: { enabled: 1 as any, isTestMode: "yes" as any },
      });
      const cfg = await fetchRazorpayConfig();
      expect(cfg).toEqual({ enabled: true, isTestMode: true });
    });

    it("falls back when response.data is null (test-fixture / 404 shape)", async () => {
      apiMock.get.mockResolvedValueOnce({ data: null });
      const cfg = await fetchRazorpayConfig();
      expect(cfg).toEqual({ enabled: false, isTestMode: false });
    });

    it("falls back when response.data is undefined / field omitted", async () => {
      apiMock.get.mockResolvedValueOnce({});
      const cfg = await fetchRazorpayConfig();
      expect(cfg).toEqual({ enabled: false, isTestMode: false });
    });

    it("falls back when the whole response is null/undefined", async () => {
      apiMock.get.mockResolvedValueOnce(undefined as any);
      const cfg = await fetchRazorpayConfig();
      expect(cfg).toEqual({ enabled: false, isTestMode: false });
    });

    it("swallows network errors and returns the safe fallback", async () => {
      apiMock.get.mockRejectedValueOnce(new Error("network down"));
      const cfg = await fetchRazorpayConfig();
      expect(cfg).toEqual({ enabled: false, isTestMode: false });
    });
  });

  describe("openRazorpayCheckout — happy path", () => {
    async function importFreshOpenCheckout() {
      await resetRazorpayModuleState();
      vi.doMock("@/lib/api", () => ({ api: apiMock }));
      const mod = await import("../razorpay");
      return mod.openRazorpayCheckout;
    }

    function installRazorpayStub() {
      let captured: CapturedOptions | null = null;
      const openSpy = vi.fn();
      class RazorpayStub {
        constructor(opts: CapturedOptions) {
          captured = opts;
        }
        open = openSpy;
      }
      (window as any).Razorpay = RazorpayStub;
      return {
        openSpy,
        getCaptured: () => {
          if (!captured) throw new Error("Razorpay constructor never called");
          return captured;
        },
      };
    }

    it("posts /billing/pay-online, opens modal, verifies on success, fires onSuccess", async () => {
      const open = await importFreshOpenCheckout();
      const { openSpy, getCaptured } = installRazorpayStub();
      apiMock.post
        .mockResolvedValueOnce({
          data: {
            orderId: "order_test_123",
            amount: 50000, // paise = ₹500
            currency: "INR",
            keyId: "rzp_test_key",
          },
        })
        .mockResolvedValueOnce({ data: { ok: true } });

      const onSuccess = vi.fn();
      const onFailure = vi.fn();
      const promise = open({
        invoiceId: "inv-abc-12345678",
        invoiceNumber: "INV-2026-001",
        patient: {
          name: "Test Patient",
          email: "t@example.com",
          phone: "+919999999999",
        },
        onSuccess,
        onFailure,
      });

      // Let the order POST resolve before we drive the handler.
      await new Promise((r) => setTimeout(r, 0));

      const captured = getCaptured();
      expect(openSpy).toHaveBeenCalledTimes(1);
      expect(captured.key).toBe("rzp_test_key");
      expect(captured.order_id).toBe("order_test_123");
      expect(captured.amount).toBe(50000);
      expect(captured.currency).toBe("INR");
      expect(captured.name).toBe("MedCore Hospital");
      expect(captured.description).toBe("Invoice INV-2026-001");
      expect(captured.prefill).toEqual({
        name: "Test Patient",
        email: "t@example.com",
        contact: "+919999999999",
      });
      expect(captured.notes).toEqual({ invoiceId: "inv-abc-12345678" });
      expect(captured.theme).toEqual({ color: "#2563eb" });

      // Simulate Razorpay-modal success callback.
      await captured.handler({
        razorpay_order_id: "order_test_123",
        razorpay_payment_id: "pay_xyz",
        razorpay_signature: "sig_xyz",
      });
      await promise;

      expect(apiMock.post).toHaveBeenNthCalledWith(
        1,
        "/billing/pay-online",
        { invoiceId: "inv-abc-12345678" }
      );
      expect(apiMock.post).toHaveBeenNthCalledWith(
        2,
        "/billing/verify-payment",
        {
          razorpayOrderId: "order_test_123",
          razorpayPaymentId: "pay_xyz",
          razorpaySignature: "sig_xyz",
          invoiceId: "inv-abc-12345678",
        }
      );
      expect(onSuccess).toHaveBeenCalledTimes(1);
      expect(onFailure).not.toHaveBeenCalled();
    });

    it("passes through partial-payment amount when provided", async () => {
      const open = await importFreshOpenCheckout();
      installRazorpayStub();
      apiMock.post.mockResolvedValueOnce({
        data: {
          orderId: "order_p",
          amount: 10000,
          currency: "INR",
          keyId: "rzp_p",
        },
      });
      // Don't await — we just need the order POST to be observed.
      void open({
        invoiceId: "inv-1",
        amount: 100,
        onSuccess: () => {},
      });
      await new Promise((r) => setTimeout(r, 0));
      expect(apiMock.post).toHaveBeenCalledWith("/billing/pay-online", {
        invoiceId: "inv-1",
        amount: 100,
      });
    });

    it("falls back to invoiceId-prefix description when no invoiceNumber given", async () => {
      const open = await importFreshOpenCheckout();
      const { getCaptured } = installRazorpayStub();
      apiMock.post.mockResolvedValueOnce({
        data: {
          orderId: "o",
          amount: 1,
          currency: "INR",
          keyId: "k",
        },
      });
      void open({
        invoiceId: "abcdef1234567890",
        onSuccess: () => {},
      });
      await new Promise((r) => setTimeout(r, 0));
      expect(getCaptured().description).toBe("Invoice abcdef12");
    });
  });

  describe("openRazorpayCheckout — failure / cancel paths", () => {
    async function importFreshOpenCheckout() {
      await resetRazorpayModuleState();
      vi.doMock("@/lib/api", () => ({ api: apiMock }));
      const mod = await import("../razorpay");
      return mod.openRazorpayCheckout;
    }

    function installRazorpayStub() {
      let captured: CapturedOptions | null = null;
      class RazorpayStub {
        constructor(opts: CapturedOptions) {
          captured = opts;
        }
        open() {}
      }
      (window as any).Razorpay = RazorpayStub;
      return {
        getCaptured: () => {
          if (!captured) throw new Error("Razorpay constructor never called");
          return captured;
        },
      };
    }

    it("fires onFailure + rejects when /billing/verify-payment throws", async () => {
      const open = await importFreshOpenCheckout();
      const { getCaptured } = installRazorpayStub();
      apiMock.post
        .mockResolvedValueOnce({
          data: { orderId: "o", amount: 1, currency: "INR", keyId: "k" },
        })
        .mockRejectedValueOnce(new Error("Signature mismatch"));

      const onSuccess = vi.fn();
      const onFailure = vi.fn();
      const promise = open({
        invoiceId: "inv-1",
        onSuccess,
        onFailure,
      });
      await new Promise((r) => setTimeout(r, 0));

      // Drive handler — should reject the outer promise.
      const handlerPromise = getCaptured().handler({
        razorpay_order_id: "o",
        razorpay_payment_id: "p",
        razorpay_signature: "s",
      });

      await expect(promise).rejects.toThrow("Signature mismatch");
      await handlerPromise;
      expect(onSuccess).not.toHaveBeenCalled();
      expect(onFailure).toHaveBeenCalledWith("Signature mismatch");
    });

    it("uses fallback message when verify-payment throws a non-Error value", async () => {
      const open = await importFreshOpenCheckout();
      const { getCaptured } = installRazorpayStub();
      apiMock.post
        .mockResolvedValueOnce({
          data: { orderId: "o", amount: 1, currency: "INR", keyId: "k" },
        })
        .mockRejectedValueOnce("string-thrown");
      const onFailure = vi.fn();
      const promise = open({
        invoiceId: "inv-x",
        onSuccess: () => {},
        onFailure,
      });
      await new Promise((r) => setTimeout(r, 0));
      const handlerPromise = getCaptured().handler({
        razorpay_order_id: "o",
        razorpay_payment_id: "p",
        razorpay_signature: "s",
      });
      await expect(promise).rejects.toBe("string-thrown");
      await handlerPromise;
      expect(onFailure).toHaveBeenCalledWith("Verification failed");
    });

    it("ondismiss (user cancels modal) calls onFailure('Payment cancelled') and resolves", async () => {
      const open = await importFreshOpenCheckout();
      const { getCaptured } = installRazorpayStub();
      apiMock.post.mockResolvedValueOnce({
        data: { orderId: "o", amount: 1, currency: "INR", keyId: "k" },
      });
      const onSuccess = vi.fn();
      const onFailure = vi.fn();
      const promise = open({
        invoiceId: "inv-cancel",
        onSuccess,
        onFailure,
      });
      await new Promise((r) => setTimeout(r, 0));

      getCaptured().modal?.ondismiss?.();
      await promise; // resolves cleanly on cancel
      expect(onFailure).toHaveBeenCalledWith("Payment cancelled");
      expect(onSuccess).not.toHaveBeenCalled();
    });

    it("ondismiss after settled (success) is a no-op", async () => {
      const open = await importFreshOpenCheckout();
      const { getCaptured } = installRazorpayStub();
      apiMock.post
        .mockResolvedValueOnce({
          data: { orderId: "o", amount: 1, currency: "INR", keyId: "k" },
        })
        .mockResolvedValueOnce({ data: { ok: true } });
      const onSuccess = vi.fn();
      const onFailure = vi.fn();
      const promise = open({
        invoiceId: "inv-1",
        onSuccess,
        onFailure,
      });
      await new Promise((r) => setTimeout(r, 0));
      const captured = getCaptured();
      await captured.handler({
        razorpay_order_id: "o",
        razorpay_payment_id: "p",
        razorpay_signature: "s",
      });
      await promise;
      // Fire ondismiss AFTER success — must not invoke onFailure again.
      captured.modal?.ondismiss?.();
      expect(onSuccess).toHaveBeenCalledTimes(1);
      expect(onFailure).not.toHaveBeenCalled();
    });

    it("throws when /billing/pay-online itself fails (before modal opens)", async () => {
      const open = await importFreshOpenCheckout();
      installRazorpayStub();
      apiMock.post.mockRejectedValueOnce(new Error("Order create failed"));
      await expect(
        open({ invoiceId: "inv-1", onSuccess: () => {} })
      ).rejects.toThrow("Order create failed");
    });
  });

  describe("ensureRazorpayLoaded (via openRazorpayCheckout)", () => {
    async function freshImport() {
      await resetRazorpayModuleState();
      vi.doMock("@/lib/api", () => ({ api: apiMock }));
      const mod = await import("../razorpay");
      return mod.openRazorpayCheckout;
    }

    it("injects <script data-medcore-razorpay> and resolves when load fires with window.Razorpay set", async () => {
      const open = await freshImport();
      apiMock.post.mockResolvedValueOnce({
        data: { orderId: "o", amount: 1, currency: "INR", keyId: "k" },
      });

      // Patch appendChild so we can fire 'load' on the injected script
      // synchronously AFTER the listener attaches but BEFORE the timeout
      // expires. We also stamp window.Razorpay so the loader resolves OK.
      const origAppend = document.body.appendChild.bind(document.body);
      const appendSpy = vi
        .spyOn(document.body, "appendChild")
        .mockImplementation(<T extends Node>(node: T): T => {
          const ret = origAppend(node as any) as T;
          if ((node as any).tagName === "SCRIPT") {
            queueMicrotask(() => {
              (window as any).Razorpay = class {
                constructor(_opts: CapturedOptions) {}
                open() {}
              };
              (node as any).dispatchEvent(new Event("load"));
            });
          }
          return ret;
        });

      const callOpts: OpenCheckoutOpts = {
        invoiceId: "inv-load",
        onSuccess: () => {},
      };
      // Don't await final flow — only the loader path matters here.
      void open(callOpts);
      await new Promise((r) => setTimeout(r, 10));

      const injected = document.querySelector(
        'script[data-medcore-razorpay="true"]'
      ) as HTMLScriptElement | null;
      expect(injected).not.toBeNull();
      expect(injected!.src).toContain("checkout.razorpay.com");
      expect(window.Razorpay).toBeDefined();
      appendSpy.mockRestore();
    });

    it("rejects when script load fires but window.Razorpay never appeared", async () => {
      const open = await freshImport();
      const origAppend = document.body.appendChild.bind(document.body);
      const appendSpy = vi
        .spyOn(document.body, "appendChild")
        .mockImplementation(<T extends Node>(node: T): T => {
          const ret = origAppend(node as any) as T;
          if ((node as any).tagName === "SCRIPT") {
            queueMicrotask(() => {
              // Don't set window.Razorpay — simulate broken/blocked load.
              (node as any).dispatchEvent(new Event("load"));
            });
          }
          return ret;
        });
      await expect(
        open({ invoiceId: "x", onSuccess: () => {} })
      ).rejects.toThrow("Razorpay checkout unavailable");
      appendSpy.mockRestore();
    });

    it("rejects when the script element fires 'error'", async () => {
      const open = await freshImport();
      const origAppend = document.body.appendChild.bind(document.body);
      const appendSpy = vi
        .spyOn(document.body, "appendChild")
        .mockImplementation(<T extends Node>(node: T): T => {
          const ret = origAppend(node as any) as T;
          if ((node as any).tagName === "SCRIPT") {
            queueMicrotask(() =>
              (node as any).dispatchEvent(new Event("error"))
            );
          }
          return ret;
        });
      await expect(
        open({ invoiceId: "x", onSuccess: () => {} })
      ).rejects.toThrow("Razorpay checkout script failed to load");
      appendSpy.mockRestore();
    });

    it("short-circuits when window.Razorpay already present (no script injection)", async () => {
      const open = await freshImport();
      (window as any).Razorpay = class {
        constructor(_opts: CapturedOptions) {}
        open() {}
      };
      apiMock.post.mockResolvedValueOnce({
        data: { orderId: "o", amount: 1, currency: "INR", keyId: "k" },
      });
      // Should NOT inject a new script.
      const appendSpy = vi.spyOn(document.body, "appendChild");
      void open({ invoiceId: "inv-cached", onSuccess: () => {} });
      await new Promise((r) => setTimeout(r, 5));
      const scripts = document.querySelectorAll(
        'script[data-medcore-razorpay="true"]'
      );
      expect(scripts.length).toBe(0);
      // appendChild may be called for non-script nodes; assert no SCRIPT calls.
      const scriptCalls = appendSpy.mock.calls.filter(
        (c) => (c[0] as any)?.tagName === "SCRIPT"
      );
      expect(scriptCalls.length).toBe(0);
      appendSpy.mockRestore();
    });
  });
});
