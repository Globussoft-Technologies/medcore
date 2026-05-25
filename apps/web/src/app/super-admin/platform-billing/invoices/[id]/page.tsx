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

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import {
  ArrowLeft,
  CheckCircle2,
  Clock,
  FileText,
  IndianRupee,
  Loader2,
  XCircle,
} from "lucide-react";

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
      return { cls: "border-slate-200 bg-slate-50 text-slate-600", Icon: FileText, label: "Draft" };
    case "ISSUED":
      return { cls: "border-amber-200 bg-amber-50 text-amber-700", Icon: Clock, label: "Issued (unpaid)" };
    case "PAID":
      return { cls: "border-emerald-200 bg-emerald-50 text-emerald-700", Icon: CheckCircle2, label: "Paid" };
    case "VOID":
      return { cls: "border-rose-200 bg-rose-50 text-rose-700", Icon: XCircle, label: "Void" };
    default:
      return { cls: "border-slate-200 bg-slate-50 text-slate-600", Icon: FileText, label: s };
  }
}

export default function PlatformInvoiceDetailPage() {
  const params = useParams();
  const router = useRouter();
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
      const res = await fetch(
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
      <div className="flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={() => router.push("/super-admin/platform-billing")}
          data-testid="platform-billing-invoice-back"
          className="inline-flex h-11 items-center gap-2 rounded-md border border-slate-300 bg-white px-3 text-xs font-medium text-slate-700 hover:border-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-900"
        >
          <ArrowLeft size={14} aria-hidden="true" />
          Back to billing
        </button>
        {invoice ? (
          (() => {
            const badge = statusBadge(invoice.status);
            return (
              <span
                className={`inline-flex items-center gap-1 rounded-full border px-3 py-1 text-xs font-medium ${badge.cls}`}
                data-testid={`platform-billing-invoice-status-${invoice.id}`}
              >
                <badge.Icon size={14} aria-hidden="true" />
                {badge.label}
              </span>
            );
          })()
        ) : null}
      </div>

      {error ? (
        <div
          role="alert"
          data-testid="platform-billing-invoice-error"
          className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700"
        >
          {error}
        </div>
      ) : null}

      {loading && !invoice ? (
        <div
          className="flex items-center gap-2 text-sm text-slate-500"
          data-testid="platform-billing-invoice-loading"
        >
          <Loader2 size={14} className="animate-spin" aria-hidden="true" />
          Loading invoice…
        </div>
      ) : null}

      {invoice ? (
        <article className="space-y-6 rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <header className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 pb-4">
            <div className="space-y-1">
              <h1
                className="text-2xl font-semibold tracking-tight"
                data-testid="platform-billing-invoice-number"
              >
                {invoice.invoiceNumber}
              </h1>
              <p className="text-sm text-slate-600">
                Tenant:{" "}
                <span className="font-medium text-slate-900">
                  {invoice.tenant?.name ?? "(unknown)"}
                </span>{" "}
                <span className="text-xs text-slate-500">
                  ({invoice.tenant?.subdomain ?? "—"})
                </span>
              </p>
              <p className="text-xs text-slate-500">
                Billing period {formatDate(invoice.periodStart)} —{" "}
                {formatDate(invoice.periodEnd)}
              </p>
            </div>
            <div className="text-right text-xs text-slate-500">
              <div>Issued: {formatDate(invoice.issuedAt)}</div>
              <div>Paid: {formatDate(invoice.paidAt)}</div>
              {invoice.paymentReference ? (
                <div data-testid="platform-billing-invoice-payment-ref">
                  Ref:{" "}
                  <span className="font-mono text-slate-700">
                    {invoice.paymentReference}
                  </span>
                </div>
              ) : null}
            </div>
          </header>

          {/* Line items */}
          <div
            className="overflow-x-auto rounded-lg border border-slate-200"
            data-testid="platform-billing-invoice-lineitems-wrapper"
          >
            <table className="min-w-full text-left text-sm">
              <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th scope="col" className="px-4 py-2 font-medium">Description</th>
                  <th scope="col" className="px-4 py-2 font-medium">HSN/SAC</th>
                  <th scope="col" className="px-4 py-2 font-medium text-right">Unit price</th>
                  <th scope="col" className="px-4 py-2 font-medium text-right">Qty</th>
                  <th scope="col" className="px-4 py-2 font-medium text-right">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {invoice.lineItems.length === 0 ? (
                  <tr>
                    <td
                      colSpan={5}
                      className="px-4 py-6 text-center text-sm text-slate-500"
                    >
                      No line items.
                    </td>
                  </tr>
                ) : null}
                {invoice.lineItems.map((li) => (
                  <tr key={li.id}>
                    <td className="px-4 py-2 text-slate-700">{li.description}</td>
                    <td className="px-4 py-2 font-mono text-xs text-slate-600">
                      {li.hsnSacCode}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums text-slate-700">
                      {formatRupees(li.unitPriceInPaise)}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums text-slate-700">
                      {li.quantity}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums font-medium text-slate-900">
                      {formatRupees(li.amountInPaise)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Tax + total summary */}
          <div className="grid grid-cols-1 gap-2 rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm sm:grid-cols-2 sm:gap-1">
            <div className="text-slate-600">Subtotal</div>
            <div className="text-right tabular-nums font-medium text-slate-900">
              {formatRupees(invoice.subtotalInPaise)}
            </div>
            <div className="text-slate-600">CGST</div>
            <div className="text-right tabular-nums text-slate-700">
              {formatRupees(invoice.cgstInPaise)}
            </div>
            <div className="text-slate-600">SGST</div>
            <div className="text-right tabular-nums text-slate-700">
              {formatRupees(invoice.sgstInPaise)}
            </div>
            <div className="text-slate-600">IGST</div>
            <div className="text-right tabular-nums text-slate-700">
              {formatRupees(invoice.igstInPaise)}
            </div>
            <div className="col-span-2 my-2 border-t border-slate-200" />
            <div className="text-base font-semibold text-slate-900">Total</div>
            <div
              className="text-right text-base font-semibold tabular-nums text-slate-900"
              data-testid="platform-billing-invoice-total"
            >
              <span className="inline-flex items-center gap-1">
                <IndianRupee size={14} aria-hidden="true" />
                {formatRupees(invoice.totalInPaise).replace("₹", "")}
              </span>
            </div>
          </div>

          {/* Action row */}
          {invoice.status === "ISSUED" ? (
            <div className="flex justify-end">
              <button
                type="button"
                data-testid={`platform-billing-mark-paid-${invoice.id}`}
                onClick={openModal}
                className="inline-flex h-11 min-w-[160px] items-center justify-center gap-2 rounded-md border border-slate-900 bg-slate-900 px-4 text-sm font-medium text-white hover:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-slate-900"
              >
                <CheckCircle2 size={14} aria-hidden="true" />
                Mark Paid
              </button>
            </div>
          ) : null}

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

          <p className="text-xs text-slate-400">
            <Link
              href="/super-admin/platform-billing"
              className="underline-offset-2 hover:underline"
            >
              Return to invoice list
            </Link>
          </p>
        </article>
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
            className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h2
              id="platform-billing-mark-paid-title"
              className="text-lg font-semibold text-slate-900"
            >
              Record payment for {invoice.invoiceNumber}
            </h2>
            <p className="mt-1 text-xs text-slate-500">
              This action is audited. The recorded reference will appear on
              the invoice and in the platform audit log.
            </p>
            <label
              htmlFor="platform-billing-payment-reference-input"
              className="mt-4 block text-xs font-medium text-slate-700"
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
              className="mt-1 h-11 w-full rounded-md border border-slate-300 bg-white px-3 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900"
            />
            {markPaidError ? (
              <div
                role="alert"
                data-testid="platform-billing-mark-paid-error"
                className="mt-3 rounded-md border border-rose-200 bg-rose-50 p-2 text-xs text-rose-700"
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
                className="inline-flex h-11 items-center rounded-md border border-slate-300 bg-white px-4 text-sm font-medium text-slate-700 hover:border-slate-400 disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-slate-900"
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
