"use client";

// Patient PWA — Bill payment handoff (Pearl §6.1 + §6.3 — gap #5 piece 3h of 4).
//
// Resolves the placeholder "Pay now" CTA emitted by pieces 3d (bills list) and
// 3g (bill detail). Triggers the Razorpay browser-checkout handoff against the
// authed PATIENT's invoice and surfaces the success / failure / cancellation
// state back to the patient inline. Pearl §6.3 acceptance: "Bill payment via
// UPI completes within 5 s and updates the invoice status."
//
// Why this isn't just a redirect into the dashboard billing flow:
//   • The patient PWA route group is locked down to mobile-first chrome
//     (44px touch targets, no dashboard nav), and the staff billing detail
//     page hauls in ~30 KB of recordPaymentModal / addItem / refund /
//     packageSelect surface that PATIENT can't trigger anyway.
//   • The patient also needs the unauth/401 sign-in surface, NOT the staff
//     /login redirect — same shape as pieces 3a/3b/3c/3d/3e/3f/3g.
//
// Reuses the existing apps/web/src/lib/razorpay.ts wrapper:
//   • Loads checkout.js on-demand (8s timeout fallback) — never eagerly.
//   • POSTs to /billing/pay-online — the existing endpoint is BOLA-gated
//     server-side via assertPatientOwnsResource (billing.ts:903), enforces
//     "Invoice is already paid" (409-shape via 400), validates partial
//     amounts ≤ remaining (we don't pass amount — full balance).
//   • Opens the Razorpay modal with prefilled name/email/phone from /auth/me.
//   • On modal `handler` callback POSTs to /billing/verify-payment — also
//     PATIENT-self-scoped (billing.ts:1042) + HMAC-verified server-side.
//   • On modal dismiss without payment, the wrapper resolves with onFailure
//     "Payment cancelled" so we can render an inline retry surface.
//
// State machine: loading → ready → processing → success | error | cancelled
//   • loading   — fetching invoice + /auth/me + razorpay-config in parallel.
//   • unauth    — /auth/me returned 401 → sign-in nudge to /patient/login.
//   • not-found — invoice doesn't exist, or 403 (server collapses cross-
//                 patient access into 403 via assertPatientOwnsResource).
//   • not-payable — invoice is fully paid OR Razorpay isn't configured.
//   • ready     — summary card + primary "Pay ₹X" button.
//   • processing— wrapper is mid-flight (button disabled with spinner copy).
//   • success   — verify-payment came back 200 → green check + "view bills".
//   • cancelled — modal dismissed without payment → inline retry banner.
//   • error     — pay-online or verify-payment threw → red banner with
//                 message + retry button (reverts to ready on retry).
//
// 404 / 403 collapse: piece 3g (bill detail) does the same. We don't leak
// existence — a stranger's invoice id renders the same not-found surface as
// a deleted invoice.

import { useEffect, useState, useCallback, useMemo } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { api } from "@/lib/api";
import { fetchRazorpayConfig, openRazorpayCheckout } from "@/lib/razorpay";

// ─── API types ────────────────────────────────────────────────────────────

interface PaymentRow {
  id: string;
  amount: number;
  mode: string;
  status?: string;
}

interface InvoiceForPay {
  id: string;
  invoiceNumber: string;
  patientId: string;
  totalAmount: number;
  paymentStatus: "PENDING" | "PAID" | "PARTIAL" | "REFUNDED";
  payments?: PaymentRow[] | null;
}

interface ApiResponse<T> {
  success: boolean;
  data: T | null;
  error?: string | null;
}

interface MeResponse {
  success: boolean;
  data: {
    id?: string;
    name?: string | null;
    email?: string | null;
    phone?: string | null;
  } | null;
}

type LoadState =
  | "loading"
  | "ready"
  | "unauth"
  | "not-found"
  | "not-payable"
  | "processing"
  | "success"
  | "cancelled"
  | "error";

// ─── Helpers ──────────────────────────────────────────────────────────────

function formatRupees(n: number | undefined | null): string {
  const v = Number(n);
  const safe = Number.isFinite(v) ? v : 0;
  return `₹${safe.toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function sumCapturedPayments(payments: PaymentRow[] | null | undefined): number {
  return (payments ?? [])
    .filter((p) => (p.status ?? "CAPTURED") !== "FAILED")
    .reduce((sum, p) => {
      const sign = p.status === "REFUNDED" ? -1 : 1;
      return sum + sign * (Number(p.amount) || 0);
    }, 0);
}

// ─── Page component ──────────────────────────────────────────────────────

export default function PatientBillPayPage() {
  const params = useParams<{ id: string }>();
  const invoiceId = params?.id ?? "";

  const [state, setState] = useState<LoadState>("loading");
  const [invoice, setInvoice] = useState<InvoiceForPay | null>(null);
  const [me, setMe] = useState<MeResponse["data"] | null>(null);
  const [razorpayReady, setRazorpayReady] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Initial load — invoice + /auth/me + razorpay-config in parallel.
  const fetchInitial = useCallback(async (): Promise<void> => {
    if (!invoiceId) {
      setState("not-found");
      return;
    }
    setState("loading");
    setErrorMessage(null);
    try {
      const [invRes, meRes, configRes] = await Promise.allSettled([
        api.get<ApiResponse<InvoiceForPay>>(`/billing/invoices/${invoiceId}`, {
          skip401Redirect: true,
        }),
        api.get<MeResponse>("/auth/me", { skip401Redirect: true }),
        fetchRazorpayConfig(),
      ]);

      // 401 anywhere on the auth-bearing endpoints → unauth surface.
      const any401 = [invRes, meRes].some(
        (r) =>
          r.status === "rejected" &&
          (r.reason as { status?: number })?.status === 401,
      );
      if (any401) {
        setState("unauth");
        return;
      }

      // Invoice fetch — 404/403 → not-found (collapses cross-patient access).
      if (invRes.status === "rejected") {
        const status = (invRes.reason as { status?: number })?.status;
        if (status === 404 || status === 403) {
          setState("not-found");
          return;
        }
        setState("error");
        setErrorMessage("Couldn't load the invoice. Please try again.");
        return;
      }
      if (!invRes.value.success || !invRes.value.data) {
        setState("error");
        setErrorMessage("Couldn't load the invoice. Please try again.");
        return;
      }

      const inv = invRes.value.data;
      setInvoice(inv);
      setMe(meRes.status === "fulfilled" && meRes.value.success ? meRes.value.data : null);
      const razorpayConfig =
        configRes.status === "fulfilled" ? configRes.value : { enabled: false, isTestMode: false };
      setRazorpayReady(razorpayConfig.enabled);

      // Fully-paid invoice or Razorpay disabled → not-payable surface.
      const paid = sumCapturedPayments(inv.payments);
      const due = Math.max(0, Number(inv.totalAmount) - paid);
      if (due <= 0) {
        setState("not-payable");
        return;
      }
      if (!razorpayConfig.enabled) {
        setState("not-payable");
        return;
      }

      setState("ready");
    } catch (err) {
      const status = (err as { status?: number })?.status;
      if (status === 401) {
        setState("unauth");
        return;
      }
      setState("error");
      setErrorMessage(err instanceof Error ? err.message : "Something went wrong.");
    }
  }, [invoiceId]);

  useEffect(() => {
    void fetchInitial();
  }, [fetchInitial]);

  // Derived: outstanding amount.
  const due = useMemo(() => {
    if (!invoice) return 0;
    const paid = sumCapturedPayments(invoice.payments);
    return Math.max(0, Number(invoice.totalAmount) - paid);
  }, [invoice]);

  // Razorpay handoff — uses the shared lib wrapper (same code path the
  // dashboard billing surface runs through).
  const onPayClick = useCallback(async () => {
    if (!invoice) return;
    setState("processing");
    setErrorMessage(null);
    try {
      await openRazorpayCheckout({
        invoiceId: invoice.id,
        invoiceNumber: invoice.invoiceNumber,
        patient: {
          name: me?.name ?? undefined,
          email: me?.email ?? undefined,
          phone: me?.phone ?? undefined,
        },
        onSuccess: () => {
          setState("success");
        },
        onFailure: (reason) => {
          // "Payment cancelled" is the wrapper's dismiss signal — render
          // the cancelled banner inline so the patient knows nothing was
          // charged. Any other reason is a real verify-payment failure.
          if (reason === "Payment cancelled") {
            setState("cancelled");
          } else {
            setErrorMessage(reason);
            setState("error");
          }
        },
      });
    } catch (err) {
      // openRazorpayCheckout throws when /pay-online fails OR when
      // checkout.js itself didn't load. Both bail to the error surface
      // unless we already settled (in which case the inner handlers
      // already moved us off "processing").
      const msg = err instanceof Error ? err.message : "Payment failed";
      // Avoid clobbering a success/cancelled state if it already landed.
      setState((prev) => {
        if (prev === "success" || prev === "cancelled") return prev;
        return "error";
      });
      setErrorMessage((prev) => prev ?? msg);
    }
  }, [invoice, me]);

  // ─── State branches ────────────────────────────────────────────────────

  if (state === "loading") {
    return (
      <section
        data-testid="patient-bill-pay-loading"
        className="flex min-h-[40vh] items-center justify-center text-sm text-slate-500"
      >
        Loading payment…
      </section>
    );
  }

  if (state === "unauth") {
    return (
      <section
        data-testid="patient-bill-pay-unauth"
        className="space-y-4 py-6"
      >
        <h1 className="text-2xl font-semibold tracking-tight">Sign in</h1>
        <p className="text-base text-slate-600">
          Please sign in to pay this bill.
        </p>
        <Link
          href="/patient/login"
          data-testid="patient-bill-pay-signin-cta"
          className="inline-flex h-11 min-w-[44px] items-center justify-center rounded-md bg-slate-900 px-6 text-sm font-medium text-white"
        >
          Sign in
        </Link>
      </section>
    );
  }

  if (state === "not-found") {
    return (
      <section
        data-testid="patient-bill-pay-not-found"
        className="space-y-4 py-6"
      >
        <h1 className="text-2xl font-semibold tracking-tight">
          Invoice not found
        </h1>
        <p className="text-base text-slate-600">
          We couldn&apos;t find this invoice. It may have been removed, or you
          may not have access to it.
        </p>
        <Link
          href="/patient/bills"
          data-testid="patient-bill-pay-back-empty"
          className="inline-flex h-11 min-w-[44px] items-center justify-center rounded-md bg-slate-900 px-6 text-sm font-medium text-white"
        >
          Back to bills
        </Link>
      </section>
    );
  }

  if (state === "not-payable" && invoice) {
    const paid = sumCapturedPayments(invoice.payments);
    const totalDue = Math.max(0, Number(invoice.totalAmount) - paid);
    const fullyPaid = totalDue <= 0;
    return (
      <section
        data-testid="patient-bill-pay-not-payable"
        className="space-y-4 py-6"
      >
        <h1 className="text-2xl font-semibold tracking-tight">
          {fullyPaid ? "Invoice already paid" : "Online payment unavailable"}
        </h1>
        <p className="text-base text-slate-600">
          {fullyPaid
            ? `Invoice #${invoice.invoiceNumber} has no outstanding balance.`
            : "Online payment is not configured for this hospital right now. Please pay at the reception desk."}
        </p>
        <Link
          href={`/patient/bills/${invoice.id}`}
          data-testid="patient-bill-pay-back-detail"
          className="inline-flex h-11 min-w-[44px] items-center justify-center rounded-md bg-slate-900 px-6 text-sm font-medium text-white"
        >
          Back to invoice
        </Link>
      </section>
    );
  }

  if (state === "error" && !invoice) {
    return (
      <section
        data-testid="patient-bill-pay-error"
        role="alert"
        className="space-y-3 rounded-md border border-red-300 bg-red-50 p-4 text-sm text-red-800"
      >
        <p>{errorMessage ?? "Something went wrong. Please refresh."}</p>
        <button
          type="button"
          data-testid="patient-bill-pay-retry-cold"
          onClick={() => {
            void fetchInitial();
          }}
          className="inline-flex h-11 min-w-[44px] items-center justify-center rounded-md bg-slate-900 px-6 text-sm font-medium text-white"
        >
          Try again
        </button>
      </section>
    );
  }

  if (!invoice) {
    // Defensive — shouldn't reach here, but keeps the renderer total.
    return null;
  }

  // ready | processing | success | cancelled | error (with invoice loaded)
  const showPayButton = state === "ready" || state === "cancelled" || state === "error";
  const showSuccessBanner = state === "success";
  const showCancelledBanner = state === "cancelled";
  const showErrorBanner = state === "error" && Boolean(errorMessage);
  const buttonLabel = state === "processing" ? "Opening payment…" : `Pay ${formatRupees(due)} via Razorpay`;
  const buttonDisabled = state === "processing" || !razorpayReady;

  return (
    <section
      data-testid="patient-bill-pay"
      data-invoice-id={invoice.id}
      data-state={state}
      className="space-y-6 py-4"
    >
      {/* ─── Back link ─────────────────────────────────────────────────── */}
      <div>
        <Link
          href={`/patient/bills/${invoice.id}`}
          data-testid="patient-bill-pay-back"
          className="inline-flex h-11 min-w-[44px] items-center justify-center rounded-md border border-slate-300 px-4 text-sm font-medium text-slate-800"
        >
          ← Back to invoice
        </Link>
      </div>

      {/* ─── Summary card ─────────────────────────────────────────────── */}
      <header
        data-testid="patient-bill-pay-summary"
        className="space-y-2 rounded-lg border border-slate-200 bg-white p-4 shadow-sm"
      >
        <p
          data-testid="patient-bill-pay-number"
          className="text-xs font-medium uppercase tracking-wide text-slate-500"
        >
          Invoice #{invoice.invoiceNumber}
        </p>
        <p
          data-testid="patient-bill-pay-due"
          className="text-3xl font-semibold text-slate-900 tabular-nums"
        >
          {formatRupees(due)}
        </p>
        <p className="text-xs text-slate-600">
          Pay via UPI, card, or netbanking — secured by Razorpay.
        </p>
      </header>

      {/* ─── Status banners ───────────────────────────────────────────── */}
      {showSuccessBanner ? (
        <section
          data-testid="patient-bill-pay-success"
          role="status"
          className="space-y-3 rounded-md border border-emerald-300 bg-emerald-50 p-4 text-sm text-emerald-900"
        >
          <p className="text-base font-medium">Payment received.</p>
          <p>
            Bill #{invoice.invoiceNumber} has been updated. Thanks for paying
            online — a receipt is available on your bill detail page.
          </p>
          <Link
            href="/patient/bills"
            data-testid="patient-bill-pay-success-cta"
            className="inline-flex h-11 min-w-[44px] items-center justify-center rounded-md bg-emerald-700 px-6 text-sm font-medium text-white"
          >
            Back to bills
          </Link>
        </section>
      ) : null}

      {showCancelledBanner ? (
        <section
          data-testid="patient-bill-pay-cancelled"
          role="status"
          className="space-y-2 rounded-md border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900"
        >
          <p className="font-medium">Payment cancelled.</p>
          <p>
            No money was charged. You can try again when you&apos;re ready.
          </p>
        </section>
      ) : null}

      {showErrorBanner ? (
        <section
          data-testid="patient-bill-pay-error-banner"
          role="alert"
          className="space-y-2 rounded-md border border-red-300 bg-red-50 p-4 text-sm text-red-800"
        >
          <p className="font-medium">Payment didn&apos;t go through.</p>
          <p>{errorMessage}</p>
        </section>
      ) : null}

      {/* ─── Pay button ───────────────────────────────────────────────── */}
      {showPayButton ? (
        <button
          type="button"
          data-testid="patient-bill-pay-btn"
          onClick={onPayClick}
          disabled={buttonDisabled}
          className="inline-flex h-11 min-w-[44px] w-full items-center justify-center rounded-md bg-slate-900 px-6 text-sm font-medium text-white disabled:opacity-60"
        >
          {buttonLabel}
        </button>
      ) : state === "processing" ? (
        <button
          type="button"
          data-testid="patient-bill-pay-btn"
          disabled
          className="inline-flex h-11 min-w-[44px] w-full items-center justify-center rounded-md bg-slate-900 px-6 text-sm font-medium text-white disabled:opacity-60"
        >
          Opening payment…
        </button>
      ) : null}

      <p className="text-xs text-slate-500">
        You&apos;ll be charged exactly the amount above. Razorpay confirms
        within seconds; this page will update automatically.
      </p>
    </section>
  );
}
