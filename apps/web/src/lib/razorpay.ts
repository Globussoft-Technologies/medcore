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

interface OpenModalOpts {
  /** Pre-created Razorpay order (orderId + keyId + amount + currency). */
  order: OrderResponse;
  /** Merchant name shown in the modal header. */
  name: string;
  description: string;
  prefill?: { name?: string; email?: string; contact?: string };
  notes?: Record<string, string>;
  /** Server-side verification step run on modal success (HMAC check). */
  onVerify: (resp: RazorpaySuccessResponse) => Promise<void>;
  onSuccess: () => void;
  onFailure?: (reason: string) => void;
}

/**
 * Low-level modal opener shared by every checkout flow: loads checkout.js,
 * opens the Razorpay overlay for a pre-created order, runs the caller's
 * `onVerify` on success, then `onSuccess`. The order-creation + verification
 * endpoints are the caller's responsibility — this keeps the modal UX
 * identical across hospital billing and platform billing while letting each
 * flow hit its own API surface.
 *
 * Throws if Razorpay isn't configured or the script never loaded — callers
 * should surface the error via toast.
 */
async function openRazorpayModal(opts: OpenModalOpts): Promise<void> {
  await ensureRazorpayLoaded();
  if (!window.Razorpay) {
    throw new Error("Razorpay checkout unavailable");
  }
  const { order } = opts;

  return new Promise((resolve, reject) => {
    let settled = false;

    const rzp = new window.Razorpay!({
      key: order.keyId,
      order_id: order.orderId,
      amount: order.amount,
      currency: order.currency,
      name: opts.name,
      description: opts.description,
      prefill: opts.prefill,
      notes: opts.notes,
      theme: { color: "#2563eb" },
      handler: async (response) => {
        try {
          await opts.onVerify(response);
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

/**
 * Hospital-billing Pay-Online flow:
 *   1. POST /billing/pay-online → Razorpay orderId + keyId
 *   2. Open Razorpay checkout modal
 *   3. On modal success → POST /billing/verify-payment (HMAC + amount check)
 *   4. Fire onSuccess so the page can refresh the invoice
 */
export async function openRazorpayCheckout(opts: OpenCheckoutOpts): Promise<void> {
  // Verify the checkout script is loadable BEFORE creating an order, so we
  // never leave a Razorpay order dangling for an unpayable page.
  await ensureRazorpayLoaded();

  const orderRes = await api.post<{ data: OrderResponse }>(
    "/billing/pay-online",
    {
      invoiceId: opts.invoiceId,
      // Pass amount through only when explicitly provided so the server keeps
      // its full-balance fallback for legacy callers.
      ...(opts.amount !== undefined ? { amount: opts.amount } : {}),
    }
  );

  const description = opts.invoiceNumber
    ? `Invoice ${opts.invoiceNumber}`
    : `Invoice ${opts.invoiceId.slice(0, 8)}`;

  return openRazorpayModal({
    order: orderRes.data,
    name: "MedCore Hospital",
    description,
    prefill: {
      name: opts.patient?.name,
      email: opts.patient?.email,
      contact: opts.patient?.phone,
    },
    notes: { invoiceId: opts.invoiceId },
    onVerify: async (response) => {
      await api.post("/billing/verify-payment", {
        razorpayOrderId: response.razorpay_order_id,
        razorpayPaymentId: response.razorpay_payment_id,
        razorpaySignature: response.razorpay_signature,
        invoiceId: opts.invoiceId,
      });
    },
    onSuccess: opts.onSuccess,
    onFailure: opts.onFailure,
  });
}

export interface OpenPlatformCheckoutOpts {
  /** PlatformInvoice id. */
  invoiceId: string;
  invoiceNumber?: string;
  contact?: { name?: string; email?: string };
  onSuccess: () => void;
  onFailure?: (reason: string) => void;
}

/**
 * Platform-billing (Pearl ↔ hospital subscription) Pay-Online flow — the same
 * embedded modal as hospital billing, but against the platform endpoints which
 * use Pearl's own Razorpay merchant account:
 *   1. POST /platform-billing/invoices/:id/pay-online → order + platform keyId
 *   2. Open Razorpay checkout modal
 *   3. On success → POST /platform-billing/invoices/:id/verify-payment
 *      (HMAC verify → markInvoicePaid)
 */
export async function openPlatformRazorpayCheckout(
  opts: OpenPlatformCheckoutOpts,
): Promise<void> {
  await ensureRazorpayLoaded();

  const orderRes = await api.post<{ data: OrderResponse }>(
    `/platform-billing/invoices/${opts.invoiceId}/pay-online`,
    {},
  );

  const description = opts.invoiceNumber
    ? `Subscription invoice ${opts.invoiceNumber}`
    : `Platform invoice ${opts.invoiceId.slice(0, 8)}`;

  return openRazorpayModal({
    order: orderRes.data,
    name: "Pearl ERP — Platform Billing",
    description,
    prefill: { name: opts.contact?.name, email: opts.contact?.email },
    notes: { platformInvoiceId: opts.invoiceId },
    onVerify: async (response) => {
      await api.post(
        `/platform-billing/invoices/${opts.invoiceId}/verify-payment`,
        {
          razorpayOrderId: response.razorpay_order_id,
          razorpayPaymentId: response.razorpay_payment_id,
          razorpaySignature: response.razorpay_signature,
        },
      );
    },
    onSuccess: opts.onSuccess,
    onFailure: opts.onFailure,
  });
}

/**
 * Tenant-facing subscription Pay-Online flow — a hospital ADMIN pays their OWN
 * platform invoice from the "My Subscription" page. Same modal as the operator
 * platform flow, but against the tenant-scoped /my-subscription endpoints (each
 * verifies the invoice belongs to the caller's tenant):
 *   1. POST /my-subscription/invoices/:id/pay-online → order + platform keyId
 *   2. Open Razorpay checkout modal
 *   3. On success → POST /my-subscription/invoices/:id/verify-payment
 */
export async function openMySubscriptionRazorpayCheckout(
  opts: OpenPlatformCheckoutOpts,
): Promise<void> {
  await ensureRazorpayLoaded();

  const orderRes = await api.post<{ data: OrderResponse }>(
    `/my-subscription/invoices/${opts.invoiceId}/pay-online`,
    {},
  );

  const description = opts.invoiceNumber
    ? `Subscription invoice ${opts.invoiceNumber}`
    : `Platform invoice ${opts.invoiceId.slice(0, 8)}`;

  return openRazorpayModal({
    order: orderRes.data,
    name: "MedCore — Subscription",
    description,
    prefill: { name: opts.contact?.name, email: opts.contact?.email },
    notes: { platformInvoiceId: opts.invoiceId },
    onVerify: async (response) => {
      await api.post(
        `/my-subscription/invoices/${opts.invoiceId}/verify-payment`,
        {
          razorpayOrderId: response.razorpay_order_id,
          razorpayPaymentId: response.razorpay_payment_id,
          razorpaySignature: response.razorpay_signature,
        },
      );
    },
    onSuccess: opts.onSuccess,
    onFailure: opts.onFailure,
  });
}
