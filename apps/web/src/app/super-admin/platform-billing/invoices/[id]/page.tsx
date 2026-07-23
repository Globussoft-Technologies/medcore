// Operator platform-invoice detail — Pearl ERP Stage 1 §8.3
// (gap rows 215-218 closure piece 3-UI, 2026-05-25).
//
// Renders one PlatformInvoice with line items + tax breakdown
// (CGST/SGST/IGST) + tenant info + "Mark Paid" modal.
//
// Backed by:
//   - GET  /api/v1/platform-billing/invoices/:id (read)
//   - POST /api/v1/platform-billing/invoices/:id/mark-paid (operator action)
//
// RBAC: API double-gates. Layout client gate denies non-super-admin
// users; mark-paid is additionally strict-platform-op-only server-side.
// Mobile-first: 44px touch targets on every CTA per Pearl §6.2.

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import {
  ArrowLeft,
  Bell,
  CheckCircle2,
  Clock,
  FileText,
  Globe,
  IndianRupee,
  Loader2,
  Percent,
  Printer,
  Receipt,
  XCircle,
} from "lucide-react";
import { csrfFetch } from "@/lib/csrf-fetch";
import { toast } from "@/lib/toast";
import { openPlatformRazorpayCheckout } from "@/lib/razorpay";

type InvoiceStatus = "DRAFT" | "ISSUED" | "PAID" | "VOID";

interface LineItem {
  id: string;
  description: string;
  unitPriceInPaise: number;
  quantity: number;
  amountInPaise: number;
  hsnSacCode: string;
  cgstRate: number;
  sgstRate: number;
  igstRate: number;
}

interface InvoiceDetail {
  id: string;
  invoiceNumber: string;
  tenantId: string;
  subscriptionId: string;
  periodStart: string;
  periodEnd: string;
  subtotalInPaise: number;
  cgstInPaise: number;
  sgstInPaise: number;
  igstInPaise: number;
  totalInPaise: number;
  status: InvoiceStatus;
  issuedAt: string | null;
  paidAt: string | null;
  paidByUserId: string | null;
  paymentReference: string | null;
  hsnSacCode: string;
  createdAt: string;
  updatedAt: string;
  tenant: {
    id: string;
    name: string;
    subdomain: string;
    active: boolean;
  } | null;
  lineItems: LineItem[];
}

interface DetailResponse {
  success: boolean;
  data: { invoice: InvoiceDetail } | null;
  error: string | null;
}
interface MarkPaidResponse {
  success: boolean;
  data: {
    transition: "PAID" | "ALREADY_PAID";
    invoice: unknown;
  } | null;
  error: string | null;
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString("en-IN", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    });
  } catch {
    return iso;
  }
}

function formatRupees(paise: number): string {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 2,
  }).format(paise / 100);
}

function statusBadge(s: InvoiceStatus): {
  cls: string;
  Icon: typeof Clock;
  label: string;
} {
  switch (s) {
    case "DRAFT":
      return { cls: "border-slate-200 bg-slate-50 text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300", Icon: FileText, label: "Draft" };
    case "ISSUED":
      return { cls: "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300", Icon: Clock, label: "Issued (unpaid)" };
    case "PAID":
      return { cls: "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300", Icon: CheckCircle2, label: "Paid" };
    case "VOID":
      return { cls: "border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300", Icon: XCircle, label: "Void" };
    default:
      return { cls: "border-slate-200 bg-slate-50 text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300", Icon: FileText, label: s };
  }
}

export default function PlatformInvoiceDetailPage() {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const invoiceId =
    typeof params?.id === "string"
      ? params.id
      : Array.isArray(params?.id)
        ? params!.id[0]
        : "";

  const [invoice, setInvoice] = useState<InvoiceDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Modal state for the Mark-Paid action.
  const [showModal, setShowModal] = useState(false);
  const [markPaidRef, setMarkPaidRef] = useState("");
  const [markPaidBusy, setMarkPaidBusy] = useState(false);
  const [markPaidError, setMarkPaidError] = useState<string | null>(null);

  // Apply-Discount modal (Pearl §8.3 — mirrors patient billing).
  const [discountOpen, setDiscountOpen] = useState(false);
  const [discountRupees, setDiscountRupees] = useState("");
  const [discountReason, setDiscountReason] = useState("");
  const [discountBusy, setDiscountBusy] = useState(false);
  const [discountError, setDiscountError] = useState<string | null>(null);

  // Send-Reminder one-shot busy flag (no modal — fires immediately).
  const [reminderBusy, setReminderBusy] = useState(false);

  // Pay-Online — POSTs to the payment-link endpoint, opens the returned
  // Razorpay short URL in a new tab. `payOnlineError` surfaces backend
  // failures (mis-configured merchant credentials, network) without an
  // ugly browser alert.
  const [payOnlineBusy, setPayOnlineBusy] = useState(false);
  const [payOnlineError, setPayOnlineError] = useState<string | null>(null);

  // ?print=1 query auto-fires the print dialog once the invoice loads.
  // (The earlier ?pay=1 auto-trigger was removed — the operator clicks
  // the Pay Online button explicitly so a stale link in chat history
  // can't pop up a Razorpay tab on revisit.)
  const printedOnceRef = useRef(false);

  const fetchDetail = useCallback(async () => {
    if (!invoiceId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/v1/platform-billing/invoices/${invoiceId}`,
        { credentials: "include" },
      );
      const body = (await res.json()) as DetailResponse;
      if (!res.ok || !body.success || !body.data) {
        throw new Error(body.error ?? `Request failed (${res.status})`);
      }
      setInvoice(body.data.invoice);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [invoiceId]);

  useEffect(() => {
    void fetchDetail();
  }, [fetchDetail]);

  // Auto-fire ?print=1 once the invoice is loaded.
  useEffect(() => {
    if (printedOnceRef.current) return;
    if (!invoice) return;
    if (searchParams?.get("print") !== "1") return;
    printedOnceRef.current = true;
    // Small delay so the browser paints the new layout before printing.
    const t = setTimeout(() => {
      if (typeof window !== "undefined") window.print();
    }, 250);
    return () => clearTimeout(t);
  }, [invoice, searchParams]);

  function handlePrint(): void {
    if (typeof window !== "undefined") window.print();
  }

  // Pay-Online (Pearl §8.3) — opens the embedded Razorpay checkout modal
  // (same UX as hospital billing) against the platform's own merchant
  // account. The helper POSTs /pay-online to create the order, opens the
  // modal, and on success POSTs /verify-payment which HMAC-verifies and flips
  // the invoice to PAID; we then refetch. A plain user-cancel is silent.
  async function handlePayOnline(): Promise<void> {
    if (payOnlineBusy || !invoice) return;
    setPayOnlineBusy(true);
    setPayOnlineError(null);
    try {
      await openPlatformRazorpayCheckout({
        invoiceId: invoice.id,
        invoiceNumber: invoice.invoiceNumber,
        onSuccess: () => {
          toast.success("Payment received — invoice marked paid");
          void fetchDetail();
        },
        onFailure: (reason) => {
          if (reason && reason !== "Payment cancelled") {
            setPayOnlineError(reason);
          }
        },
      });
    } catch (err) {
      setPayOnlineError(err instanceof Error ? err.message : String(err));
    } finally {
      setPayOnlineBusy(false);
    }
  }

  // Send-Reminder — re-email this invoice to the tenant's billing contact.
  async function handleSendReminder(): Promise<void> {
    if (reminderBusy) return;
    setReminderBusy(true);
    try {
      const res = await csrfFetch(
        `/api/v1/platform-billing/invoices/${invoiceId}/send-reminder`,
        { method: "POST" },
      );
      const body = (await res.json().catch(() => ({}))) as {
        success: boolean;
        error: string | null;
        data?: { sent: boolean; to: string | null };
      };
      if (!res.ok || !body.success) {
        throw new Error(body.error ?? `Request failed (${res.status})`);
      }
      const dest = body.data?.to ?? "the tenant billing contact";
      toast.success(`Reminder sent to ${dest}.`);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to send reminder";
      // 412 — billing contact missing. Route the operator to the
      // Tenants page where they can fix it inline.
      if (/billing contact/i.test(message)) {
        toast.error(
          `${message} — open the tenant in the Tenants page to set it.`,
          8000,
        );
      } else {
        toast.error(message);
      }
    } finally {
      setReminderBusy(false);
    }
  }

  // Apply-Discount handlers.
  function openDiscount(): void {
    setDiscountOpen(true);
    setDiscountRupees("");
    setDiscountReason("");
    setDiscountError(null);
  }
  function closeDiscount(): void {
    if (discountBusy) return;
    setDiscountOpen(false);
    setDiscountError(null);
  }
  async function submitDiscount(): Promise<void> {
    if (!invoice) return;
    const rupees = Number(discountRupees);
    if (!Number.isFinite(rupees) || rupees <= 0) {
      setDiscountError("Enter a positive discount amount in ₹.");
      return;
    }
    const paise = Math.round(rupees * 100);
    if (paise >= invoice.totalInPaise) {
      setDiscountError(
        "Discount cannot equal or exceed the invoice total. Mark Paid instead.",
      );
      return;
    }
    const reason = discountReason.trim();
    if (reason.length < 3) {
      setDiscountError("Reason is required (3-200 characters).");
      return;
    }
    setDiscountBusy(true);
    setDiscountError(null);
    try {
      const res = await csrfFetch(
        `/api/v1/platform-billing/invoices/${invoice.id}/apply-discount`,
        {
          method: "POST",
          body: JSON.stringify({ amountInPaise: paise, reason }),
        },
      );
      const body = (await res.json().catch(() => ({}))) as {
        success: boolean;
        error: string | null;
      };
      if (!res.ok || !body.success) {
        throw new Error(body.error ?? `Request failed (${res.status})`);
      }
      await fetchDetail();
      setDiscountOpen(false);
    } catch (err) {
      setDiscountError(err instanceof Error ? err.message : String(err));
    } finally {
      setDiscountBusy(false);
    }
  }

  function openModal(): void {
    setShowModal(true);
    setMarkPaidRef("");
    setMarkPaidError(null);
  }

  function closeModal(): void {
    if (markPaidBusy) return;
    setShowModal(false);
    setMarkPaidRef("");
    setMarkPaidError(null);
  }

  async function submitMarkPaid(): Promise<void> {
    const ref = markPaidRef.trim();
    if (ref.length === 0) {
      setMarkPaidError("Enter a payment reference (bank ref / Razorpay payment id)");
      return;
    }
    setMarkPaidBusy(true);
    setMarkPaidError(null);
    try {
      const res = await csrfFetch(
        `/api/v1/platform-billing/invoices/${invoiceId}/mark-paid`,
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ paymentReference: ref }),
        },
      );
      const body = (await res.json().catch(() => ({}))) as MarkPaidResponse;
      if (!res.ok || !body.success) {
        throw new Error(body.error ?? `Request failed (${res.status})`);
      }
      setShowModal(false);
      await fetchDetail();
    } catch (err) {
      setMarkPaidError(err instanceof Error ? err.message : String(err));
    } finally {
      setMarkPaidBusy(false);
    }
  }

  return (
    <section
      data-testid="platform-billing-invoice-detail"
      className="space-y-6 py-4"
    >
      {/* Top action bar — Apply Discount / Record Payment / Pay Online /
          Send Reminder / Print Invoice. Mirrors the patient-billing
          detail-page header. Action buttons are gated on status: only
          ISSUED invoices expose discount / payment / reminder; Print is
          always available. */}
      <div
        className="flex flex-wrap items-center justify-between gap-3 print:hidden"
        data-testid="platform-billing-invoice-actions"
      >
        <button
          type="button"
          onClick={() => router.push("/dashboard/platform-billing")}
          data-testid="platform-billing-invoice-back"
          className="inline-flex h-11 items-center gap-2 rounded-md text-sm font-medium text-slate-700 hover:text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-900 dark:text-slate-300 dark:hover:text-slate-100"
        >
          <ArrowLeft size={14} aria-hidden="true" />
          Back to Billing
        </button>
        {invoice ? (
          <div className="flex flex-wrap items-center gap-2">
            {invoice.status === "ISSUED" ? (
              <button
                type="button"
                onClick={openDiscount}
                data-testid="platform-billing-invoice-discount"
                className="inline-flex h-11 items-center gap-2 rounded-md border border-slate-300 bg-white px-3 text-sm font-medium text-slate-700 hover:border-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-900 dark:border-gray-600 dark:bg-gray-800 dark:text-slate-200 dark:hover:border-gray-500"
              >
                <Percent size={14} className="text-violet-600 dark:text-violet-400" />
                Apply Discount
              </button>
            ) : null}
            {invoice.status === "ISSUED" ? (
              <button
                type="button"
                onClick={openModal}
                data-testid="platform-billing-invoice-record"
                className="inline-flex h-11 items-center gap-2 rounded-md bg-emerald-600 px-3 text-sm font-medium text-white shadow-sm hover:bg-emerald-700 focus:outline-none focus:ring-2 focus:ring-emerald-600"
              >
                <Receipt size={14} aria-hidden="true" />
                Record Payment
              </button>
            ) : null}
            {invoice.status === "ISSUED" ? (
              <button
                type="button"
                onClick={handlePayOnline}
                disabled={payOnlineBusy}
                data-testid="platform-billing-invoice-payonline"
                className="inline-flex h-11 items-center gap-2 rounded-md bg-sky-600 px-3 text-sm font-medium text-white shadow-sm hover:bg-sky-700 focus:outline-none focus:ring-2 focus:ring-sky-600 disabled:opacity-60"
              >
                <Globe size={14} aria-hidden="true" />
                Pay Online
                <span className="ml-1 rounded bg-yellow-300 px-1 py-0.5 text-[10px] font-bold text-yellow-900">
                  TEST
                </span>
              </button>
            ) : null}
            {invoice.status === "ISSUED" ? (
              <button
                type="button"
                onClick={handleSendReminder}
                disabled={reminderBusy}
                data-testid="platform-billing-invoice-reminder"
                className="inline-flex h-11 items-center gap-2 rounded-md border border-slate-300 bg-white px-3 text-sm font-medium text-slate-700 hover:border-slate-400 disabled:cursor-wait disabled:opacity-60 focus:outline-none focus:ring-2 focus:ring-slate-900 dark:border-gray-600 dark:bg-gray-800 dark:text-slate-200 dark:hover:border-gray-500"
              >
                <Bell size={14} className="text-amber-600 dark:text-amber-400" />
                {reminderBusy ? "Sending…" : "Send Reminder"}
              </button>
            ) : null}
            <button
              type="button"
              onClick={handlePrint}
              data-testid="platform-billing-invoice-print"
              className="inline-flex h-11 items-center gap-2 rounded-md bg-primary px-3 text-sm font-semibold text-white shadow-sm hover:bg-primary-dark focus:outline-none focus:ring-2 focus:ring-primary"
            >
              <Printer size={14} aria-hidden="true" />
              Print Invoice
            </button>
          </div>
        ) : null}
      </div>

      {/* Status pill (no longer in the action bar — sits with the
          invoice metadata below so the top row stays for actions). */}
      {invoice ? (
        (() => {
          const badge = statusBadge(invoice.status);
          return (
            <div className="print:hidden">
              <span
                className={`inline-flex items-center gap-1 rounded-full border px-3 py-1 text-xs font-medium ${badge.cls}`}
                data-testid={`platform-billing-invoice-status-${invoice.id}`}
              >
                <badge.Icon size={14} aria-hidden="true" />
                {badge.label}
              </span>
            </div>
          );
        })()
      ) : null}

      {payOnlineError ? (
        <div
          role="alert"
          data-testid="platform-billing-invoice-payonline-error"
          className="flex items-start justify-between gap-3 rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700 print:hidden dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300"
        >
          <span>
            <strong>Pay Online failed.</strong> {payOnlineError}
          </span>
          <button
            type="button"
            onClick={() => setPayOnlineError(null)}
            className="text-xs font-medium text-rose-700 underline-offset-2 hover:underline dark:text-rose-300"
          >
            Dismiss
          </button>
        </div>
      ) : null}

      {error ? (
        <div
          role="alert"
          data-testid="platform-billing-invoice-error"
          className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300"
        >
          {error}
        </div>
      ) : null}

      {loading && !invoice ? (
        <div
          className="flex items-center gap-2 text-sm text-slate-500 dark:text-slate-400"
          data-testid="platform-billing-invoice-loading"
        >
          <Loader2 size={14} className="animate-spin" aria-hidden="true" />
          Loading invoice…
        </div>
      ) : null}

      {invoice ? (
        <article className="space-y-6 rounded-xl border border-slate-200 bg-white p-6 !text-slate-900 shadow-sm dark:border-slate-200 dark:bg-white dark:!text-slate-900">
          <header className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-200 pb-4">
            <div className="space-y-1">
              <h1
                className="text-2xl font-semibold tracking-tight !text-slate-950"
                data-testid="platform-billing-invoice-number"
              >
                {invoice.invoiceNumber}
              </h1>
              <p className="text-sm !text-slate-700">
                Tenant:{" "}
                <span className="font-medium !text-slate-950">
                  {invoice.tenant?.name ?? "(unknown)"}
                </span>{" "}
                <span className="text-xs !text-slate-600">
                  ({invoice.tenant?.subdomain ?? "—"})
                </span>
              </p>
              <p className="text-xs !text-slate-600">
                Billing period {formatDate(invoice.periodStart)} —{" "}
                {formatDate(invoice.periodEnd)}
              </p>
            </div>
            <div className="text-right text-xs !text-slate-600">
              <div>Issued: {formatDate(invoice.issuedAt)}</div>
              <div>Paid: {formatDate(invoice.paidAt)}</div>
              {invoice.paymentReference ? (
                <div data-testid="platform-billing-invoice-payment-ref">
                  Ref:{" "}
                  <span className="font-mono !text-slate-800">
                    {invoice.paymentReference}
                  </span>
                </div>
              ) : null}
            </div>
          </header>

          {/* Line items */}
          <div
            className="overflow-x-auto rounded-lg border border-slate-300 bg-white"
            data-testid="platform-billing-invoice-lineitems-wrapper"
          >
            <table className="min-w-full text-left text-sm !text-slate-900">
              <thead className="border-b border-slate-300 bg-slate-50 text-xs uppercase tracking-wide !text-slate-600">
                <tr>
                  <th scope="col" className="px-4 py-2 font-medium">Description</th>
                  <th scope="col" className="px-4 py-2 font-medium">HSN/SAC</th>
                  <th scope="col" className="px-4 py-2 font-medium text-right">Unit price</th>
                  <th scope="col" className="px-4 py-2 font-medium text-right">Qty</th>
                  <th scope="col" className="px-4 py-2 font-medium text-right">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {invoice.lineItems.length === 0 ? (
                  <tr>
                    <td
                      colSpan={5}
                      className="px-4 py-6 text-center text-sm !text-slate-600"
                    >
                      No line items.
                    </td>
                  </tr>
                ) : null}
                {invoice.lineItems.map((li) => (
                  <tr key={li.id}>
                    <td className="px-4 py-2 !text-slate-800">{li.description}</td>
                    <td className="px-4 py-2 font-mono text-xs !text-slate-700">
                      {li.hsnSacCode}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums !text-slate-800">
                      {formatRupees(li.unitPriceInPaise)}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums !text-slate-800">
                      {li.quantity}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums font-medium !text-slate-950">
                      {formatRupees(li.amountInPaise)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Tax + total summary */}
          <div className="grid grid-cols-1 gap-2 rounded-lg border border-slate-300 bg-slate-50 p-4 text-sm !text-slate-900 sm:grid-cols-2 sm:gap-1">
            <div className="!text-slate-700">Subtotal</div>
            <div className="text-right tabular-nums font-medium !text-slate-950">
              {formatRupees(invoice.subtotalInPaise)}
            </div>
            <div className="!text-slate-700">CGST</div>
            <div className="text-right tabular-nums !text-slate-800">
              {formatRupees(invoice.cgstInPaise)}
            </div>
            <div className="!text-slate-700">SGST</div>
            <div className="text-right tabular-nums !text-slate-800">
              {formatRupees(invoice.sgstInPaise)}
            </div>
            <div className="!text-slate-700">IGST</div>
            <div className="text-right tabular-nums !text-slate-800">
              {formatRupees(invoice.igstInPaise)}
            </div>
            <div className="col-span-2 my-2 border-t border-slate-300" />
            <div className="text-base font-semibold !text-slate-950">Total</div>
            <div
              className="text-right text-base font-semibold tabular-nums !text-slate-950"
              data-testid="platform-billing-invoice-total"
            >
              <span className="inline-flex items-center gap-1">
                <IndianRupee size={14} aria-hidden="true" />
                {formatRupees(invoice.totalInPaise).replace("₹", "")}
              </span>
            </div>
          </div>

          {/* Bottom Mark Paid button removed — promoted to the top
              action bar to match the patient-billing layout. */}

          {invoice.status === "PAID" ? (
            <p
              className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-700"
              data-testid="platform-billing-invoice-paid-banner"
            >
              This invoice has been recorded as paid.
              {invoice.paymentReference
                ? ` Payment reference: ${invoice.paymentReference}.`
                : ""}
            </p>
          ) : null}

          <p className="text-xs !text-slate-600">
            <Link
              href="/dashboard/platform-billing"
              className="underline-offset-2 hover:underline"
            >
              Return to invoice list
            </Link>
          </p>
        </article>
      ) : null}

      {/* APPLY-DISCOUNT MODAL */}
      {discountOpen && invoice ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4 print:hidden"
          role="dialog"
          aria-modal="true"
          aria-labelledby="platform-billing-discount-title"
          data-testid="platform-billing-invoice-discount-modal"
          onClick={closeDiscount}
        >
          <div
            className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-6 shadow-xl dark:border-gray-700 dark:bg-gray-900 dark:text-slate-100"
            onClick={(e) => e.stopPropagation()}
          >
            <h2
              id="platform-billing-discount-title"
              className="text-lg font-semibold text-slate-900 dark:text-slate-100"
            >
              Apply discount — {invoice.invoiceNumber}
            </h2>
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              Writes a negative line item on the invoice. Subtotal and GST
              are recomputed automatically.
            </p>
            <label
              htmlFor="platform-billing-invoice-discount-amount"
              className="mt-4 block text-xs font-medium text-slate-700 dark:text-slate-300"
            >
              Discount amount (₹)
            </label>
            <input
              id="platform-billing-invoice-discount-amount"
              data-testid="platform-billing-invoice-discount-amount"
              type="number"
              min={0}
              step="0.01"
              value={discountRupees}
              onChange={(e) => setDiscountRupees(e.target.value)}
              placeholder="e.g. 500"
              className="mt-1 h-11 w-full rounded-md border border-slate-300 bg-white px-3 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 dark:border-gray-600 dark:bg-gray-800 dark:text-slate-100 dark:placeholder:text-slate-500"
            />
            <label
              htmlFor="platform-billing-invoice-discount-reason"
              className="mt-3 block text-xs font-medium text-slate-700 dark:text-slate-300"
            >
              Reason
            </label>
            <textarea
              id="platform-billing-invoice-discount-reason"
              data-testid="platform-billing-invoice-discount-reason"
              value={discountReason}
              onChange={(e) => setDiscountReason(e.target.value)}
              rows={2}
              maxLength={200}
              placeholder="e.g. Goodwill credit for delayed onboarding"
              className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 dark:border-gray-600 dark:bg-gray-800 dark:text-slate-100 dark:placeholder:text-slate-500"
            />
            {discountError ? (
              <div
                role="alert"
                data-testid="platform-billing-invoice-discount-error"
                className="mt-3 rounded-md border border-rose-200 bg-rose-50 p-2 text-xs text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300"
              >
                {discountError}
              </div>
            ) : null}
            <div className="mt-6 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={closeDiscount}
                disabled={discountBusy}
                data-testid="platform-billing-invoice-discount-cancel"
                className="inline-flex h-11 items-center rounded-md border border-slate-300 bg-white px-4 text-sm font-medium text-slate-700 hover:border-slate-400 disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-slate-900 dark:border-gray-600 dark:bg-gray-800 dark:text-slate-200 dark:hover:border-gray-500"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={submitDiscount}
                disabled={discountBusy}
                data-testid="platform-billing-invoice-discount-submit"
                className="inline-flex h-11 items-center rounded-md bg-slate-900 px-4 text-sm font-semibold text-white shadow-sm hover:bg-slate-800 disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-slate-900"
              >
                {discountBusy ? "Saving…" : "Apply discount"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* MARK-PAID MODAL */}
      {showModal && invoice ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="platform-billing-mark-paid-title"
          data-testid="platform-billing-mark-paid-modal"
          onClick={closeModal}
        >
          <div
            className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-6 shadow-xl dark:border-gray-700 dark:bg-gray-900 dark:text-slate-100"
            onClick={(e) => e.stopPropagation()}
          >
            <h2
              id="platform-billing-mark-paid-title"
              className="text-lg font-semibold text-slate-900 dark:text-slate-100"
            >
              Record payment for {invoice.invoiceNumber}
            </h2>
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              This action is audited. The recorded reference will appear on
              the invoice and in the platform audit log.
            </p>
            <label
              htmlFor="platform-billing-payment-reference-input"
              className="mt-4 block text-xs font-medium text-slate-700 dark:text-slate-300"
            >
              Payment reference (bank ref / Razorpay payment id)
            </label>
            <input
              id="platform-billing-payment-reference-input"
              data-testid="platform-billing-payment-reference-input"
              type="text"
              value={markPaidRef}
              onChange={(e) => setMarkPaidRef(e.target.value)}
              maxLength={200}
              placeholder="e.g. pay_OZX9k2 or NEFT-2026042512345"
              className="mt-1 h-11 w-full rounded-md border border-slate-300 bg-white px-3 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 dark:border-gray-600 dark:bg-gray-800 dark:text-slate-100 dark:placeholder:text-slate-500"
            />
            {markPaidError ? (
              <div
                role="alert"
                data-testid="platform-billing-mark-paid-error"
                className="mt-3 rounded-md border border-rose-200 bg-rose-50 p-2 text-xs text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300"
              >
                {markPaidError}
              </div>
            ) : null}
            <div className="mt-6 flex items-center justify-end gap-2">
              <button
                type="button"
                data-testid="platform-billing-mark-paid-cancel"
                onClick={closeModal}
                disabled={markPaidBusy}
                className="inline-flex h-11 items-center rounded-md border border-slate-300 bg-white px-4 text-sm font-medium text-slate-700 hover:border-slate-400 disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-slate-900 dark:border-gray-600 dark:bg-gray-800 dark:text-slate-200 dark:hover:border-gray-500"
              >
                Cancel
              </button>
              <button
                type="button"
                data-testid="platform-billing-mark-paid-submit"
                onClick={submitMarkPaid}
                disabled={markPaidBusy}
                className="inline-flex h-11 items-center gap-2 rounded-md border border-slate-900 bg-slate-900 px-4 text-sm font-medium text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-slate-900"
              >
                {markPaidBusy ? (
                  <Loader2 size={14} className="animate-spin" aria-hidden="true" />
                ) : (
                  <CheckCircle2 size={14} aria-hidden="true" />
                )}
                {markPaidBusy ? "Recording…" : "Record payment"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
