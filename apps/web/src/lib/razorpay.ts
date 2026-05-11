// Razorpay browser checkout wrapper.
// Loads window.Razorpay on demand,
// creates an order via our API, opens the Razorpay modal, then POSTs the
// signed result back for server-side HMAC verification.
// Mock-mode safe: when the API is in mock mode the order_mock_* id still
// flows through the modal handler — verifyPayment short-circuits server-side.

import { api } from "@/lib/api";

interface RazorpayConfig {
  enabled: boolean;
  isTestMode: boolean;
}

interface OrderResponse {
  orderId: string;
  amount: number; // paise
  currency: string;
  keyId: string;
}

interface RazorpaySuccessResponse {
  razorpay_order_id: string;
  razorpay_payment_id: string;
  razorpay_signature: string;
}

interface RazorpayOptions {
  key: string;
  order_id: string;
  amount: number;
  currency: string;
  name: string;
  description: string;
  prefill?: { name?: string; email?: string; contact?: string };
  notes?: Record<string, string>;
  theme?: { color?: string };
  handler: (response: RazorpaySuccessResponse) => void;
  modal?: { ondismiss?: () => void };
}

interface RazorpayInstance {
  open: () => void;
}

declare global {
  interface Window {
    Razorpay?: new (opts: RazorpayOptions) => RazorpayInstance;
  }
}

let razorpayScriptPromise: Promise<void> | null = null;

export async function fetchRazorpayConfig(): Promise<RazorpayConfig> {
  const FALLBACK: RazorpayConfig = { enabled: false, isTestMode: false };
  try {
    const res = await api.get<{ data: RazorpayConfig | null | undefined }>(
      "/billing/razorpay-config"
    );
    // Test fixtures and 404-ish responses can return `{ data: null }` or
    // omit the field entirely; coerce to the safe default rather than
    // letting consumers crash on `config.enabled` when config is null.
    if (!res?.data) return FALLBACK;
    return {
      enabled: Boolean(res.data.enabled),
      isTestMode: Boolean(res.data.isTestMode),
    };
  } catch {
    return FALLBACK;
  }
}

/**
 * Load the Razorpay checkout script only when a payment flow actually needs
 * it. This keeps non-billing pages from eagerly pulling Razorpay's many
 * internal feature chunks.
 */
function ensureRazorpayLoaded(timeoutMs = 8000): Promise<void> {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("Razorpay checkout is only available in the browser"));
  }
  if (window.Razorpay) return Promise.resolve();
  if (razorpayScriptPromise) return razorpayScriptPromise;

  razorpayScriptPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(
      'script[data-medcore-razorpay="true"]',
    );
    const script =
      existing ??
      Object.assign(document.createElement("script"), {
        src: "https://checkout.razorpay.com/v1/checkout.js",
        async: true,
        defer: true,
      });

    script.dataset.medcoreRazorpay = "true";

    const cleanup = () => {
      script.removeEventListener("load", onLoad);
      script.removeEventListener("error", onError);
      window.clearTimeout(timer);
    };

    const onLoad = () => {
      cleanup();
      if (window.Razorpay) {
        resolve();
      } else {
        razorpayScriptPromise = null;
        reject(new Error("Razorpay checkout unavailable"));
      }
    };

    const onError = () => {
      cleanup();
      razorpayScriptPromise = null;
      reject(new Error("Razorpay checkout script failed to load"));
    };

    const timer = window.setTimeout(() => {
      cleanup();
      razorpayScriptPromise = null;
      reject(new Error("Razorpay checkout script failed to load"));
    }, timeoutMs);

    script.addEventListener("load", onLoad, { once: true });
    script.addEventListener("error", onError, { once: true });

    if (!existing) {
      document.body.appendChild(script);
    }
  });

  return razorpayScriptPromise;
}

export interface OpenCheckoutOpts {
  invoiceId: string;
  /**
   * Optional partial-payment amount (rupees). When set, Razorpay charges
   * exactly this amount and the invoice stays PARTIAL afterward. Server
   * enforces 0 < amount ≤ remaining-balance; mismatches return 400. When
   * omitted, the server charges the full remaining (legacy behaviour).
   */
  amount?: number;
  patient?: { name?: string; email?: string; phone?: string };
  invoiceNumber?: string;
  /** Fires after the server confirms the payment is captured. */
  onSuccess: () => void;
  /** Fires when Razorpay reports failure OR the user closes the modal. */
  onFailure?: (reason: string) => void;
}

/**
 * Full Pay-Online flow:
 *   1. POST /billing/pay-online → Razorpay orderId + keyId
 *   2. Open Razorpay checkout modal
 *   3. On modal success → POST /billing/verify-payment (HMAC + amount check)
 *   4. Fire onSuccess so the page can refresh the invoice
 *
 * Throws if Razorpay isn't configured or the script never loaded — callers
 * should surface the error via toast.
 */
export async function openRazorpayCheckout(opts: OpenCheckoutOpts): Promise<void> {
  await ensureRazorpayLoaded();
  if (!window.Razorpay) {
    throw new Error("Razorpay checkout unavailable");
  }

  const orderRes = await api.post<{ data: OrderResponse }>(
    "/billing/pay-online",
    {
      invoiceId: opts.invoiceId,
      // Pass amount through only when explicitly provided so the server keeps
      // its full-balance fallback for legacy callers.
      ...(opts.amount !== undefined ? { amount: opts.amount } : {}),
    }
  );
  const order = orderRes.data;

  const description = opts.invoiceNumber
    ? `Invoice ${opts.invoiceNumber}`
    : `Invoice ${opts.invoiceId.slice(0, 8)}`;

  return new Promise((resolve, reject) => {
    let settled = false;

    const rzp = new window.Razorpay!({
      key: order.keyId,
      order_id: order.orderId,
      amount: order.amount,
      currency: order.currency,
      name: "MedCore Hospital",
      description,
      prefill: {
        name: opts.patient?.name,
        email: opts.patient?.email,
        contact: opts.patient?.phone,
      },
      notes: { invoiceId: opts.invoiceId },
      theme: { color: "#2563eb" },
      handler: async (response) => {
        try {
          await api.post("/billing/verify-payment", {
            razorpayOrderId: response.razorpay_order_id,
            razorpayPaymentId: response.razorpay_payment_id,
            razorpaySignature: response.razorpay_signature,
            invoiceId: opts.invoiceId,
          });
          settled = true;
          opts.onSuccess();
          resolve();
        } catch (err) {
          settled = true;
          const msg = err instanceof Error ? err.message : "Verification failed";
          opts.onFailure?.(msg);
          reject(err);
        }
      },
      modal: {
        ondismiss: () => {
          if (settled) return;
          settled = true;
          opts.onFailure?.("Payment cancelled");
          resolve();
        },
      },
    });

    rzp.open();
  });
}
