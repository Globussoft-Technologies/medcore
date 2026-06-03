"use client";

// Patient PWA — Invoice detail (Pearl §6.1 + §4.1 + §4.2 — gap #5 piece 3g of 4).
//
// Resolves the placeholder "View detail" link the bills list (piece 3d at
// `apps/web/src/app/patient/bills/page.tsx`) emits per row. Stage 1 read-only
// surface of a SINGLE invoice the authed patient owns. Backed by the
// existing GET /api/v1/billing/invoices/:id (billing.ts:615) which is
// already PATIENT-self-scoped via `assertPatientOwnsResource` at
// billing.ts:642 (BOLA-gated server-side, #511 audit verified). The include
// block at billing.ts:622-634 already ships items[], payments[], patient,
// appointment, AND insuranceClaims[] — no scope-cut for piece 3g; no
// server-side change needed.
//
// Sections (vertical, mobile-first per Pearl §6.2):
//   1. Header — invoice number, status pill, issued + due dates, total ₹.
//   2. Line items — per row: description (+ category), HSN/SAC if present,
//      quantity, unit price, CGST/SGST split, line total. Footer:
//      subtotal + (packageDiscount + discountAmount) + advance applied +
//      total tax + grand total. Mirrors the GST shape the staff side
//      renders and what the PDF endpoint emits, so the patient's screen
//      matches the printed bill.
//   3. Payments — date, mode pill (CASH/CARD/UPI/ONLINE/INSURANCE), amount,
//      transaction reference if present. Empty state if none. REFUNDED
//      rows render with a "Refund" prefix on the amount and an amber pill.
//   4. Outstanding — paid-to-date + due. Primary "Pay now" CTA only when
//      due > 0; still a placeholder route to /patient/bills/[id]/pay
//      (Razorpay handoff is piece 3i). Hidden when due == 0.
//   5. NHCX cashless stub stepper — Pearl §4.2 "Stage 1 displays the stub
//      stepper; live insurer integration is Stage 3." Reuses the same
//      4-stage map as the list page (Coverage check → Pre-auth pending →
//      Claim submitted → Settled), driven by insuranceClaims[0].status.
//      Hidden when no claim row.
//   6. GST invoice download — single anchor → existing
//      /billing/invoices/:id/pdf?format=pdf endpoint.
//
// Page-shape conventions copied from pieces 3b/3c/3d/3e/3f:
//   • Loading / unauth / error / not-found / ready state machine.
//   • 404 surface renders when the API returns 404 (invoice doesn't exist
//     OR isn't owned by the authed patient — server collapses both into
//     404 via assertPatientOwnsResource).
//   • Sign-in nudge on 401.
//   • Back link "← Back to bills" at the top (44px touch target).
//   • All CTAs 44px+ touch target (h-11 + min-w-[44px]) per Pearl §6.2.

import { useEffect, useState, useCallback, useMemo } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { api } from "@/lib/api";

// ─── API types ────────────────────────────────────────────────────────────

interface InvoiceItemRow {
  id: string;
  description: string;
  category: string;
  quantity: number;
  unitPrice: number;
  amount: number;
  cgst?: number;
  sgst?: number;
  gstRate?: number;
  hsnSac?: string | null;
}

interface PaymentRow {
  id: string;
  amount: number;
  mode: "CASH" | "CARD" | "UPI" | "ONLINE" | "INSURANCE" | string;
  status?: "CAPTURED" | "REFUNDED" | "FAILED" | string;
  transactionId?: string | null;
  paidAt: string;
}

interface InsuranceClaimRow {
  id: string;
  status: string; // ClaimStatus: SUBMITTED / APPROVED / REJECTED / SETTLED
  insuranceProvider?: string | null;
  claimAmount?: number | null;
  approvedAmount?: number | null;
}

interface InvoiceDetail {
  id: string;
  invoiceNumber: string;
  patientId: string;
  subtotal: number;
  taxAmount: number;
  cgstAmount?: number;
  sgstAmount?: number;
  packageDiscount?: number;
  advanceApplied?: number;
  discountAmount: number;
  totalAmount: number;
  paymentStatus: "PENDING" | "PAID" | "PARTIAL" | "REFUNDED";
  dueDate?: string | null;
  createdAt: string;
  items?: InvoiceItemRow[] | null;
  payments?: PaymentRow[] | null;
  insuranceClaims?: InsuranceClaimRow[] | null;
}

interface ApiResponse<T> {
  success: boolean;
  data: T | null;
  error?: string | null;
}

type LoadState = "loading" | "ready" | "unauth" | "not-found" | "error";

// ─── Formatting helpers (mirrored from list page) ────────────────────────

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatRupees(n: number | undefined | null): string {
  const v = Number(n);
  const safe = Number.isFinite(v) ? v : 0;
  return `₹${safe.toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

// ─── NHCX stub stepper (kept in lock-step with the list page) ───────────

const CASHLESS_STAGES = [
  { key: "COVERAGE_CHECK", label: "Coverage check" },
  { key: "PRE_AUTH", label: "Pre-auth pending" },
  { key: "SUBMITTED", label: "Claim submitted" },
  { key: "SETTLED", label: "Settled" },
] as const;

function mapClaimStatusToStage(status: string | undefined | null): number {
  if (!status) return -1;
  switch (status) {
    case "SUBMITTED":
      return 2;
    case "APPROVED":
      return 2;
    case "SETTLED":
      return 3;
    case "REJECTED":
      return 2;
    default:
      return 0;
  }
}

// ─── Status pill (same colour-coding as the list page) ──────────────────

function isOverdue(inv: InvoiceDetail): boolean {
  if (inv.paymentStatus === "PAID" || inv.paymentStatus === "REFUNDED") return false;
  if (!inv.dueDate) return false;
  return new Date(inv.dueDate).getTime() < Date.now();
}

function statusPillClass(inv: InvoiceDetail): string {
  if (inv.paymentStatus === "PAID") return "bg-emerald-100 dark:bg-emerald-900/40 text-emerald-900 dark:text-emerald-200";
  if (inv.paymentStatus === "REFUNDED") return "bg-slate-200 dark:bg-gray-700 text-slate-700 dark:text-gray-200";
  if (isOverdue(inv)) return "bg-red-100 dark:bg-red-900/40 text-red-900 dark:text-red-200";
  if (inv.paymentStatus === "PARTIAL") return "bg-amber-100 dark:bg-amber-900/40 text-amber-900 dark:text-amber-200";
  return "bg-blue-100 dark:bg-blue-900/40 text-blue-900 dark:text-blue-200";
}

function statusPillLabel(inv: InvoiceDetail): string {
  if (isOverdue(inv)) return "OVERDUE";
  return inv.paymentStatus;
}

// Payment mode pill — colour by family (cash/card/upi/online/insurance).
function paymentModePillClass(mode: string): string {
  switch (mode) {
    case "CASH":
      return "bg-emerald-100 dark:bg-emerald-900/40 text-emerald-900 dark:text-emerald-200";
    case "CARD":
      return "bg-indigo-100 text-indigo-900";
    case "UPI":
      return "bg-violet-100 dark:bg-violet-900/40 text-violet-900 dark:text-violet-200";
    case "ONLINE":
      return "bg-sky-100 dark:bg-sky-900/40 text-sky-900 dark:text-sky-200";
    case "INSURANCE":
      return "bg-amber-100 dark:bg-amber-900/40 text-amber-900 dark:text-amber-200";
    default:
      return "bg-slate-100 dark:bg-gray-800 text-slate-700 dark:text-gray-200";
  }
}

// ─── Outstanding math (mirrors list page's outstandingFor) ──────────────

function sumCapturedPayments(payments: PaymentRow[] | null | undefined): number {
  return (payments ?? [])
    .filter((p) => (p.status ?? "CAPTURED") !== "FAILED")
    .reduce((sum, p) => {
      // REFUNDED rows reduce the captured balance — same sign as the
      // server uses for paymentStatus arithmetic.
      const sign = p.status === "REFUNDED" ? -1 : 1;
      return sum + sign * (Number(p.amount) || 0);
    }, 0);
}

const API_BASE =
  process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000/api/v1";

function buildGstPdfUrl(id: string): string {
  return `${API_BASE.replace(/\/$/, "")}/billing/invoices/${id}/pdf?format=pdf`;
}

// ─── Page component ──────────────────────────────────────────────────────

export default function PatientBillDetailPage() {
  const params = useParams<{ id: string }>();
  const invoiceId = params?.id ?? "";
  const [state, setState] = useState<LoadState>("loading");
  const [invoice, setInvoice] = useState<InvoiceDetail | null>(null);

  const fetchInvoice = useCallback(async (): Promise<void> => {
    if (!invoiceId) {
      setState("not-found");
      return;
    }
    setState("loading");
    try {
      const res = await api.get<ApiResponse<InvoiceDetail>>(
        `/billing/invoices/${invoiceId}`,
        { skip401Redirect: true },
      );
      if (res.success && res.data) {
        setInvoice(res.data);
        setState("ready");
      } else {
        // Defensive — the server normally returns a real HTTP status. Any
        // success:false here we treat as a generic error.
        setState("error");
      }
    } catch (err) {
      const status = (err as { status?: number })?.status;
      if (status === 401) {
        setState("unauth");
        return;
      }
      // 404 covers both "doesn't exist" AND "exists but not owned by you"
      // — assertPatientOwnsResource collapses cross-patient access into a
      // 404 to avoid leaking existence.
      if (status === 404 || status === 403) {
        setState("not-found");
        return;
      }
      setState("error");
    }
  }, [invoiceId]);

  useEffect(() => {
    void fetchInvoice();
  }, [fetchInvoice]);

  // ─── Derived values (called unconditionally — hook rules) ─────────────

  const items: InvoiceItemRow[] = useMemo(
    () => invoice?.items ?? [],
    [invoice],
  );
  const payments: PaymentRow[] = useMemo(
    () => invoice?.payments ?? [],
    [invoice],
  );
  const claim = invoice?.insuranceClaims?.[0] ?? null;
  const activeStageIdx = mapClaimStatusToStage(claim?.status);
  const showStepper = activeStageIdx >= 0;

  const paid = useMemo(() => sumCapturedPayments(payments), [payments]);
  const due = useMemo(() => {
    if (!invoice) return 0;
    return Math.max(0, Number(invoice.totalAmount) - paid);
  }, [invoice, paid]);

  const lineSubtotal = useMemo(
    () =>
      items.reduce(
        (sum, it) =>
          sum +
          (Number(it.amount) ||
            (Number(it.unitPrice) || 0) * (Number(it.quantity) || 0)),
        0,
      ),
    [items],
  );
  const lineTaxTotal = useMemo(
    () =>
      items.reduce(
        (sum, it) =>
          sum + (Number(it.cgst) || 0) + (Number(it.sgst) || 0),
        0,
      ),
    [items],
  );

  // ─── State branches ────────────────────────────────────────────────────

  if (state === "loading") {
    return (
      <section
        data-testid="patient-bill-detail-loading"
        className="flex min-h-[40vh] items-center justify-center text-sm text-slate-500 dark:text-gray-400"
      >
        Loading invoice…
      </section>
    );
  }

  if (state === "unauth") {
    return (
      <section
        data-testid="patient-bill-detail-unauth"
        className="space-y-4 py-6"
      >
        <h1 className="text-2xl font-semibold tracking-tight">Sign in</h1>
        <p className="text-base text-slate-600 dark:text-gray-300">
          Please sign in to view this invoice.
        </p>
        <Link
          href="/patient/login"
          className="inline-flex h-11 min-w-[44px] items-center justify-center rounded-md bg-slate-900 px-6 text-sm font-medium text-white"
          data-testid="patient-bill-detail-signin-cta"
        >
          Sign in
        </Link>
      </section>
    );
  }

  if (state === "not-found") {
    return (
      <section
        data-testid="patient-bill-detail-not-found"
        className="space-y-4 py-6"
      >
        <h1 className="text-2xl font-semibold tracking-tight">
          Invoice not found
        </h1>
        <p className="text-base text-slate-600 dark:text-gray-300">
          We couldn&apos;t find this invoice. It may have been removed, or
          you may not have access to it.
        </p>
        <Link
          href="/patient/bills"
          className="inline-flex h-11 min-w-[44px] items-center justify-center rounded-md bg-slate-900 px-6 text-sm font-medium text-white"
          data-testid="patient-bill-detail-back-empty"
        >
          Back to bills
        </Link>
      </section>
    );
  }

  if (state === "error" || !invoice) {
    return (
      <section
        data-testid="patient-bill-detail-error"
        role="alert"
        className="rounded-md border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-900/30 p-4 text-sm text-red-800 dark:text-red-200"
      >
        Something went wrong loading this invoice. Please refresh.
      </section>
    );
  }

  const gstPdfUrl = buildGstPdfUrl(invoice.id);
  const overdue = isOverdue(invoice);
  const headerDiscount =
    (Number(invoice.packageDiscount) || 0) + (Number(invoice.discountAmount) || 0);
  const headerAdvance = Number(invoice.advanceApplied) || 0;
  const headerSubtotal = Number(invoice.subtotal) || lineSubtotal;
  const headerTax = Number(invoice.taxAmount) || lineTaxTotal;

  return (
    <section
      data-testid="patient-bill-detail"
      data-invoice-id={invoice.id}
      className="space-y-6 py-4"
    >
      {/* ─── Back link ─────────────────────────────────────────────────── */}
      <div>
        <Link
          href="/patient/bills"
          data-testid="patient-bill-detail-back"
          className="inline-flex h-11 min-w-[44px] items-center justify-center rounded-md border border-slate-300 dark:border-gray-600 px-4 text-sm font-medium text-slate-800 dark:text-gray-100"
        >
          ← Back to bills
        </Link>
      </div>

      {/* ─── Header ────────────────────────────────────────────────────── */}
      <header
        data-testid="patient-bill-detail-header"
        className="space-y-3 rounded-lg border border-slate-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4 shadow-sm"
      >
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="space-y-1">
            <p
              data-testid="patient-bill-detail-number"
              className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-gray-400"
            >
              Invoice #{invoice.invoiceNumber}
            </p>
            <p
              data-testid="patient-bill-detail-total"
              className="text-2xl font-semibold text-slate-900 dark:text-gray-100"
            >
              {formatRupees(Number(invoice.totalAmount))}
            </p>
            <p className="text-xs text-slate-600 dark:text-gray-300">
              Issued {formatDate(invoice.createdAt)}
            </p>
            {invoice.dueDate ? (
              <p
                data-testid="patient-bill-detail-due"
                className={`text-xs font-medium ${
                  overdue ? "text-red-700 dark:text-red-300" : "text-slate-600 dark:text-gray-300"
                }`}
              >
                Due {formatDate(invoice.dueDate)}
                {overdue ? " — overdue" : ""}
              </p>
            ) : null}
          </div>
          <span
            data-testid="patient-bill-detail-status"
            className={`rounded-full px-2 py-1 text-xs font-medium ${statusPillClass(
              invoice,
            )}`}
          >
            {statusPillLabel(invoice)}
          </span>
        </div>
      </header>

      {/* ─── Line items ───────────────────────────────────────────────── */}
      <section
        data-testid="patient-bill-detail-items"
        aria-labelledby="items-heading"
        className="space-y-3 rounded-lg border border-slate-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4 shadow-sm"
      >
        <h2
          id="items-heading"
          className="text-sm font-medium uppercase tracking-wide text-slate-500 dark:text-gray-400"
        >
          Line items
        </h2>
        {items.length === 0 ? (
          <p
            data-testid="patient-bill-detail-items-empty"
            className="rounded-md border border-dashed border-slate-300 dark:border-gray-600 bg-slate-50 dark:bg-gray-900 p-4 text-sm text-slate-600 dark:text-gray-300"
          >
            No line items on this invoice.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead>
                <tr className="border-b border-slate-200 dark:border-gray-700 text-xs uppercase tracking-wide text-slate-500 dark:text-gray-400">
                  <th className="py-2 pr-3 font-medium">Description</th>
                  <th className="py-2 pr-3 font-medium">HSN/SAC</th>
                  <th className="py-2 pr-3 text-right font-medium">Qty</th>
                  <th className="py-2 pr-3 text-right font-medium">
                    Unit price
                  </th>
                  <th className="py-2 pr-3 text-right font-medium">CGST</th>
                  <th className="py-2 pr-3 text-right font-medium">SGST</th>
                  <th className="py-2 text-right font-medium">Line total</th>
                </tr>
              </thead>
              <tbody>
                {items.map((it) => {
                  const lineTotal =
                    Number(it.amount) ||
                    (Number(it.unitPrice) || 0) * (Number(it.quantity) || 0);
                  return (
                    <tr
                      key={it.id}
                      data-testid="patient-bill-detail-item-row"
                      data-item-id={it.id}
                      className="border-b border-slate-100 dark:border-gray-800 last:border-b-0 text-slate-800 dark:text-gray-100"
                    >
                      <td className="py-2 pr-3">
                        <div className="font-medium text-slate-900 dark:text-gray-100">
                          {it.description}
                        </div>
                        {it.category ? (
                          <div className="text-xs text-slate-500 dark:text-gray-400">
                            {it.category}
                          </div>
                        ) : null}
                      </td>
                      <td
                        data-testid="patient-bill-detail-item-hsn"
                        className="py-2 pr-3 text-xs text-slate-600 dark:text-gray-300"
                      >
                        {it.hsnSac || "—"}
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums">
                        {it.quantity}
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums">
                        {formatRupees(Number(it.unitPrice))}
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums">
                        {formatRupees(Number(it.cgst) || 0)}
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums">
                        {formatRupees(Number(it.sgst) || 0)}
                      </td>
                      <td className="py-2 text-right font-medium tabular-nums">
                        {formatRupees(lineTotal)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="text-slate-700 dark:text-gray-200">
                  <td colSpan={6} className="pt-3 pr-3 text-right text-xs uppercase tracking-wide text-slate-500 dark:text-gray-400">
                    Subtotal
                  </td>
                  <td
                    data-testid="patient-bill-detail-subtotal"
                    className="pt-3 text-right tabular-nums"
                  >
                    {formatRupees(headerSubtotal)}
                  </td>
                </tr>
                {headerDiscount > 0 ? (
                  <tr className="text-slate-700 dark:text-gray-200">
                    <td colSpan={6} className="pr-3 text-right text-xs uppercase tracking-wide text-slate-500 dark:text-gray-400">
                      Discount
                    </td>
                    <td
                      data-testid="patient-bill-detail-discount"
                      className="text-right tabular-nums text-emerald-700 dark:text-emerald-300"
                    >
                      − {formatRupees(headerDiscount)}
                    </td>
                  </tr>
                ) : null}
                {headerAdvance > 0 ? (
                  <tr className="text-slate-700 dark:text-gray-200">
                    <td colSpan={6} className="pr-3 text-right text-xs uppercase tracking-wide text-slate-500 dark:text-gray-400">
                      Advance applied
                    </td>
                    <td
                      data-testid="patient-bill-detail-advance"
                      className="text-right tabular-nums text-emerald-700 dark:text-emerald-300"
                    >
                      − {formatRupees(headerAdvance)}
                    </td>
                  </tr>
                ) : null}
                <tr className="text-slate-700 dark:text-gray-200">
                  <td colSpan={6} className="pr-3 text-right text-xs uppercase tracking-wide text-slate-500 dark:text-gray-400">
                    Total tax (CGST + SGST)
                  </td>
                  <td
                    data-testid="patient-bill-detail-tax"
                    className="text-right tabular-nums"
                  >
                    {formatRupees(headerTax)}
                  </td>
                </tr>
                <tr className="border-t border-slate-200 dark:border-gray-700 text-slate-900 dark:text-gray-100">
                  <td colSpan={6} className="pt-2 pr-3 text-right text-sm font-semibold uppercase tracking-wide">
                    Grand total
                  </td>
                  <td
                    data-testid="patient-bill-detail-grand-total"
                    className="pt-2 text-right text-base font-semibold tabular-nums"
                  >
                    {formatRupees(Number(invoice.totalAmount))}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </section>

      {/* ─── Payments ─────────────────────────────────────────────────── */}
      <section
        data-testid="patient-bill-detail-payments"
        aria-labelledby="payments-heading"
        className="space-y-3 rounded-lg border border-slate-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4 shadow-sm"
      >
        <h2
          id="payments-heading"
          className="text-sm font-medium uppercase tracking-wide text-slate-500 dark:text-gray-400"
        >
          Payments
        </h2>
        {payments.length === 0 ? (
          <p
            data-testid="patient-bill-detail-payments-empty"
            className="rounded-md border border-dashed border-slate-300 dark:border-gray-600 bg-slate-50 dark:bg-gray-900 p-4 text-sm text-slate-600 dark:text-gray-300"
          >
            No payments recorded yet.
          </p>
        ) : (
          <ul className="space-y-2">
            {payments.map((p) => {
              const refund = p.status === "REFUNDED";
              return (
                <li
                  key={p.id}
                  data-testid="patient-bill-detail-payment-row"
                  data-payment-id={p.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-slate-200 dark:border-gray-700 bg-slate-50 dark:bg-gray-900 px-3 py-2"
                >
                  <div className="space-y-0.5">
                    <p className="text-sm font-medium text-slate-900 dark:text-gray-100">
                      {refund ? "Refund " : ""}
                      {formatRupees(Number(p.amount))}
                    </p>
                    <p className="text-xs text-slate-600 dark:text-gray-300">
                      {formatDateTime(p.paidAt)}
                      {p.transactionId ? ` · Ref ${p.transactionId}` : ""}
                    </p>
                  </div>
                  <span
                    data-testid="patient-bill-detail-payment-mode"
                    className={`rounded-full px-2 py-1 text-xs font-medium ${paymentModePillClass(
                      p.mode,
                    )}`}
                  >
                    {p.mode}
                    {refund ? " (refunded)" : ""}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* ─── Outstanding + Pay-now CTA ─────────────────────────────────── */}
      <section
        data-testid="patient-bill-detail-outstanding"
        aria-labelledby="outstanding-heading"
        className="space-y-3 rounded-lg border border-slate-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4 shadow-sm"
      >
        <h2
          id="outstanding-heading"
          className="text-sm font-medium uppercase tracking-wide text-slate-500 dark:text-gray-400"
        >
          Outstanding
        </h2>
        <div className="grid grid-cols-2 gap-3 text-sm">
          <div>
            <p className="text-xs uppercase tracking-wide text-slate-500 dark:text-gray-400">
              Paid to date
            </p>
            <p
              data-testid="patient-bill-detail-paid"
              className="text-base font-semibold text-slate-900 dark:text-gray-100 tabular-nums"
            >
              {formatRupees(paid)}
            </p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-wide text-slate-500 dark:text-gray-400">
              Due
            </p>
            <p
              data-testid="patient-bill-detail-due-amount"
              className={`text-base font-semibold tabular-nums ${
                due > 0 ? "text-red-700 dark:text-red-300" : "text-slate-700 dark:text-gray-200"
              }`}
            >
              {formatRupees(due)}
            </p>
          </div>
        </div>
        {due > 0 ? (
          <Link
            href={`/patient/bills/${invoice.id}/pay`}
            data-testid="patient-bill-detail-pay-btn"
            className="inline-flex h-11 min-w-[44px] items-center justify-center rounded-md bg-slate-900 px-6 text-sm font-medium text-white"
          >
            Pay now
          </Link>
        ) : null}
      </section>

      {/* ─── NHCX cashless stub stepper ────────────────────────────────── */}
      {showStepper ? (
        <section
          data-testid="patient-bill-detail-stepper"
          aria-labelledby="nhcx-heading"
          className="space-y-3 rounded-lg border border-slate-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4 shadow-sm"
        >
          <h2
            id="nhcx-heading"
            className="text-sm font-medium uppercase tracking-wide text-slate-500 dark:text-gray-400"
          >
            Cashless claim status
          </h2>
          {claim?.insuranceProvider ? (
            <p
              data-testid="patient-bill-detail-stepper-provider"
              className="text-xs text-slate-600 dark:text-gray-300"
            >
              {claim.insuranceProvider}
              {claim?.claimAmount != null
                ? ` · Claimed ${formatRupees(claim.claimAmount)}`
                : ""}
              {claim?.approvedAmount != null
                ? ` · Approved ${formatRupees(claim.approvedAmount)}`
                : ""}
            </p>
          ) : null}
          <div
            aria-label="Cashless claim status"
            className="flex items-center gap-1 overflow-x-auto pb-1"
          >
            {CASHLESS_STAGES.map((stage, idx) => {
              const active = idx === activeStageIdx;
              const done = idx < activeStageIdx;
              const cls = active
                ? "bg-slate-900 text-white"
                : done
                  ? "bg-emerald-100 dark:bg-emerald-900/40 text-emerald-900 dark:text-emerald-200"
                  : "bg-slate-100 dark:bg-gray-800 text-slate-600 dark:text-gray-300";
              return (
                <span
                  key={stage.key}
                  data-testid={`patient-bill-detail-stepper-stage-${idx}`}
                  data-active={active ? "true" : "false"}
                  data-done={done ? "true" : "false"}
                  className={`whitespace-nowrap rounded-full px-3 py-1 text-xs font-medium ${cls}`}
                >
                  {idx + 1}. {stage.label}
                </span>
              );
            })}
          </div>
          <p className="text-xs text-slate-500 dark:text-gray-400">
            Stage 1 displays a stub stepper; live insurer integration is
            Stage 3.
          </p>
        </section>
      ) : null}

      {/* ─── GST invoice download ──────────────────────────────────────── */}
      <section
        data-testid="patient-bill-detail-gst"
        aria-labelledby="gst-heading"
        className="space-y-3 rounded-lg border border-slate-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4 shadow-sm"
      >
        <h2
          id="gst-heading"
          className="text-sm font-medium uppercase tracking-wide text-slate-500 dark:text-gray-400"
        >
          GST invoice
        </h2>
        <p className="text-xs text-slate-600 dark:text-gray-300">
          A printable GST-format invoice is available for your records.
        </p>
        <a
          href={gstPdfUrl}
          target="_blank"
          rel="noopener noreferrer"
          data-testid="patient-bill-detail-gst-btn"
          className="inline-flex h-11 min-w-[44px] items-center justify-center rounded-md border border-slate-300 dark:border-gray-600 px-4 text-sm font-medium text-slate-800 dark:text-gray-100"
        >
          Download GST invoice PDF
        </a>
      </section>
    </section>
  );
}
