// Operator platform-billing landing — Pearl ERP Stage 1 §8.3
// (gap rows 215-218 closure piece 3-UI, 2026-05-25).
//
// Two-tab landing under /super-admin/platform-billing:
//   - Subscriptions: cross-tenant TenantSubscription list (tenant name,
//     plan, status badge, trial-end, current-period-end).
//   - Invoices: cross-tenant PlatformInvoice list, default filtered to
//     ISSUED (the un-paid work queue). Each row has a "Mark Paid"
//     button (status === ISSUED) opening a modal that prompts for
//     `paymentReference` then calls POST /invoices/:id/mark-paid.
//
// API backing: /api/v1/platform-billing/{subscriptions,invoices,invoices/:id,
// invoices/:id/mark-paid} — gated PLATFORM_OPERATOR + PLATFORM_BILLING_OPERATOR
// (+ legacy super-admin shape for read-only; mark-paid is strict-op-only).
//
// Mobile-first: every chip + CTA `h-11` (44px) per Pearl §6.2 touch-target rule.
// Defence-in-depth: the layout (apps/web/src/app/super-admin/layout.tsx)
// already gates on Role.ADMIN + tenantId == null. PLATFORM_OPERATOR users
// reaching this page in future will need the layout gate widened. The API
// double-enforces.

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  AlertCircle,
  Building2,
  CheckCircle2,
  Clock,
  CreditCard,
  FileText,
  IndianRupee,
  Loader2,
  XCircle,
} from "lucide-react";

type SubscriptionStatus =
  | "trial"
  | "active"
  | "past_due"
  | "suspended"
  | "cancelled";

interface SubscriptionRow {
  id: string;
  tenantId: string;
  plan: "STARTER" | "GROWTH" | "ENTERPRISE";
  status: SubscriptionStatus;
  trialEndsAt: string | null;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  customPriceMonthlyInPaise: number | null;
  razorpaySubscriptionId: string | null;
  pastDueSince: string | null;
  cancelledAt: string | null;
  createdAt: string;
  tenant: {
    id: string;
    name: string;
    subdomain: string;
    active: boolean;
  } | null;
}

type InvoiceStatus = "DRAFT" | "ISSUED" | "PAID" | "VOID";

interface InvoiceRow {
  id: string;
  invoiceNumber: string;
  tenantId: string;
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
  paymentReference: string | null;
  createdAt: string;
  tenant: { id: string; name: string; subdomain: string } | null;
}

interface SubsResponse {
  success: boolean;
  data: { subscriptions: SubscriptionRow[] };
  error: string | null;
}
interface InvoicesResponse {
  success: boolean;
  data: { invoices: InvoiceRow[] };
  error: string | null;
}
interface MarkPaidResponse {
  success: boolean;
  data: {
    transition: "PAID" | "ALREADY_PAID";
    invoice: { id: string; status: string; paymentReference: string | null };
  } | null;
  error: string | null;
}

type Tab = "subscriptions" | "invoices";
type InvoiceFilter = "ISSUED" | "PAID" | "all";

const INVOICE_FILTER_CHIPS: Array<{ key: InvoiceFilter; label: string }> = [
  { key: "ISSUED", label: "Unpaid (ISSUED)" },
  { key: "PAID", label: "Paid" },
  { key: "all", label: "All" },
];

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

function subscriptionStatusBadge(s: SubscriptionStatus): {
  cls: string;
  Icon: typeof Clock;
  label: string;
} {
  switch (s) {
    case "trial":
      return { cls: "border-blue-200 bg-blue-50 text-blue-700", Icon: Clock, label: "Trial" };
    case "active":
      return { cls: "border-emerald-200 bg-emerald-50 text-emerald-700", Icon: CheckCircle2, label: "Active" };
    case "past_due":
      return { cls: "border-amber-200 bg-amber-50 text-amber-700", Icon: AlertCircle, label: "Past due" };
    case "suspended":
      return { cls: "border-rose-200 bg-rose-50 text-rose-700", Icon: XCircle, label: "Suspended" };
    case "cancelled":
      return { cls: "border-slate-200 bg-slate-50 text-slate-600", Icon: XCircle, label: "Cancelled" };
    default:
      return { cls: "border-slate-200 bg-slate-50 text-slate-600", Icon: Clock, label: s };
  }
}

function invoiceStatusBadge(s: InvoiceStatus): {
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

export default function PlatformBillingPage() {
  const [tab, setTab] = useState<Tab>("subscriptions");
  const [invoiceFilter, setInvoiceFilter] = useState<InvoiceFilter>("ISSUED");

  const [subscriptions, setSubscriptions] = useState<SubscriptionRow[]>([]);
  const [invoices, setInvoices] = useState<InvoiceRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Modal state for the Mark-Paid action.
  const [markPaidForId, setMarkPaidForId] = useState<string | null>(null);
  const [markPaidRef, setMarkPaidRef] = useState("");
  const [markPaidBusy, setMarkPaidBusy] = useState(false);
  const [markPaidError, setMarkPaidError] = useState<string | null>(null);

  const fetchSubscriptions = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/v1/platform-billing/subscriptions", {
        credentials: "include",
      });
      const body = (await res.json()) as SubsResponse;
      if (!res.ok || !body.success) {
        throw new Error(body.error ?? `Request failed (${res.status})`);
      }
      setSubscriptions(body.data.subscriptions);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchInvoices = useCallback(async (status: InvoiceFilter) => {
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams({ status });
      const res = await fetch(
        `/api/v1/platform-billing/invoices?${qs.toString()}`,
        { credentials: "include" },
      );
      const body = (await res.json()) as InvoicesResponse;
      if (!res.ok || !body.success) {
        throw new Error(body.error ?? `Request failed (${res.status})`);
      }
      setInvoices(body.data.invoices);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (tab === "subscriptions") {
      void fetchSubscriptions();
    } else {
      void fetchInvoices(invoiceFilter);
    }
  }, [tab, invoiceFilter, fetchSubscriptions, fetchInvoices]);

  const openInvoiceCount = useMemo(
    () => invoices.filter((i) => i.status === "ISSUED").length,
    [invoices],
  );

  function openMarkPaid(invoiceId: string): void {
    setMarkPaidForId(invoiceId);
    setMarkPaidRef("");
    setMarkPaidError(null);
  }

  function closeMarkPaid(): void {
    if (markPaidBusy) return;
    setMarkPaidForId(null);
    setMarkPaidRef("");
    setMarkPaidError(null);
  }

  async function submitMarkPaid(): Promise<void> {
    if (!markPaidForId) return;
    const ref = markPaidRef.trim();
    if (ref.length === 0) {
      setMarkPaidError("Enter a payment reference (bank ref / Razorpay payment id)");
      return;
    }
    setMarkPaidBusy(true);
    setMarkPaidError(null);
    try {
      const res = await fetch(
        `/api/v1/platform-billing/invoices/${markPaidForId}/mark-paid`,
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
      // Refresh the invoice list with the same filter.
      await fetchInvoices(invoiceFilter);
      setMarkPaidForId(null);
      setMarkPaidRef("");
    } catch (err) {
      setMarkPaidError(err instanceof Error ? err.message : String(err));
    } finally {
      setMarkPaidBusy(false);
    }
  }

  return (
    <section
      data-testid="platform-billing-page"
      className="space-y-6 py-4"
    >
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">
          Pearl Billing
        </h1>
        <p className="text-sm text-slate-600">
          Operator surface for cross-tenant subscriptions and platform
          invoices (Onviqa → hospital). Mark-Paid requires{" "}
          <code className="rounded bg-slate-100 px-1 py-0.5 text-xs">
            PLATFORM_OPERATOR
          </code>{" "}
          or{" "}
          <code className="rounded bg-slate-100 px-1 py-0.5 text-xs">
            PLATFORM_BILLING_OPERATOR
          </code>
          .
        </p>
      </header>

      {/* Tab row */}
      <div
        className="flex flex-wrap gap-2 border-b border-slate-200"
        role="tablist"
        data-testid="platform-billing-tabs"
      >
        <button
          type="button"
          role="tab"
          aria-selected={tab === "subscriptions"}
          data-testid="platform-billing-tab-subscriptions"
          onClick={() => setTab("subscriptions")}
          className={`-mb-px inline-flex h-11 items-center gap-2 border-b-2 px-4 text-sm font-medium transition focus:outline-none focus:ring-2 focus:ring-slate-900 ${
            tab === "subscriptions"
              ? "border-slate-900 text-slate-900"
              : "border-transparent text-slate-500 hover:text-slate-700"
          }`}
        >
          <Building2 size={14} aria-hidden="true" />
          Subscriptions
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "invoices"}
          data-testid="platform-billing-tab-invoices"
          onClick={() => setTab("invoices")}
          className={`-mb-px inline-flex h-11 items-center gap-2 border-b-2 px-4 text-sm font-medium transition focus:outline-none focus:ring-2 focus:ring-slate-900 ${
            tab === "invoices"
              ? "border-slate-900 text-slate-900"
              : "border-transparent text-slate-500 hover:text-slate-700"
          }`}
        >
          <CreditCard size={14} aria-hidden="true" />
          Invoices
          {tab === "invoices" && openInvoiceCount > 0 ? (
            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-700">
              {openInvoiceCount}
            </span>
          ) : null}
        </button>
      </div>

      {error ? (
        <div
          role="alert"
          data-testid="platform-billing-error"
          className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700"
        >
          {error}
        </div>
      ) : null}

      {loading ? (
        <div
          className="flex items-center gap-2 text-sm text-slate-500"
          data-testid="platform-billing-loading"
        >
          <Loader2 size={14} className="animate-spin" aria-hidden="true" />
          Loading…
        </div>
      ) : null}

      {/* SUBSCRIPTIONS TAB */}
      {tab === "subscriptions" ? (
        <div
          className="overflow-x-auto rounded-lg border border-slate-200 bg-white shadow-sm"
          data-testid="platform-billing-subscriptions-table-wrapper"
        >
          <table
            className="min-w-full text-left text-sm"
            data-testid="platform-billing-subscriptions-table"
          >
            <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th scope="col" className="px-4 py-3 font-medium">Tenant</th>
                <th scope="col" className="px-4 py-3 font-medium">Plan</th>
                <th scope="col" className="px-4 py-3 font-medium">Status</th>
                <th scope="col" className="px-4 py-3 font-medium">Trial end</th>
                <th scope="col" className="px-4 py-3 font-medium">Period end</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {subscriptions.length === 0 && !loading ? (
                <tr>
                  <td
                    colSpan={5}
                    className="px-4 py-8 text-center text-sm text-slate-500"
                    data-testid="platform-billing-subscriptions-empty"
                  >
                    No subscriptions yet.
                  </td>
                </tr>
              ) : null}
              {subscriptions.map((s) => {
                const badge = subscriptionStatusBadge(s.status);
                return (
                  <tr
                    key={s.id}
                    data-testid={`platform-billing-subscription-row-${s.id}`}
                  >
                    <td className="px-4 py-3 font-medium text-slate-900">
                      <div className="flex flex-col">
                        <span>{s.tenant?.name ?? "(unknown tenant)"}</span>
                        <span className="text-xs text-slate-500">
                          {s.tenant?.subdomain ?? "—"}
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-slate-700">{s.plan}</td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${badge.cls}`}
                        data-testid={`platform-billing-subscription-status-${s.id}`}
                      >
                        <badge.Icon size={12} aria-hidden="true" />
                        {badge.label}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-slate-700">
                      {formatDate(s.trialEndsAt)}
                    </td>
                    <td className="px-4 py-3 text-slate-700">
                      {formatDate(s.currentPeriodEnd)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}

      {/* INVOICES TAB */}
      {tab === "invoices" ? (
        <>
          <div
            className="flex flex-wrap gap-2"
            data-testid="platform-billing-invoice-filters"
          >
            {INVOICE_FILTER_CHIPS.map((chip) => {
              const active = invoiceFilter === chip.key;
              return (
                <button
                  key={chip.key}
                  type="button"
                  data-testid={`platform-billing-invoice-filter-${chip.key}`}
                  aria-pressed={active}
                  onClick={() => setInvoiceFilter(chip.key)}
                  className={`inline-flex h-11 min-w-[120px] items-center justify-center rounded-full border px-4 text-sm font-medium transition focus:outline-none focus:ring-2 focus:ring-slate-900 ${
                    active
                      ? "border-slate-900 bg-slate-900 text-white"
                      : "border-slate-300 bg-white text-slate-700 hover:border-slate-400"
                  }`}
                >
                  {chip.label}
                </button>
              );
            })}
          </div>

          <div
            className="overflow-x-auto rounded-lg border border-slate-200 bg-white shadow-sm"
            data-testid="platform-billing-invoices-table-wrapper"
          >
            <table
              className="min-w-full text-left text-sm"
              data-testid="platform-billing-invoices-table"
            >
              <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th scope="col" className="px-4 py-3 font-medium">Invoice #</th>
                  <th scope="col" className="px-4 py-3 font-medium">Tenant</th>
                  <th scope="col" className="px-4 py-3 font-medium text-right">Amount</th>
                  <th scope="col" className="px-4 py-3 font-medium">Issued</th>
                  <th scope="col" className="px-4 py-3 font-medium">Status</th>
                  <th scope="col" className="px-4 py-3 font-medium text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {invoices.length === 0 && !loading ? (
                  <tr>
                    <td
                      colSpan={6}
                      className="px-4 py-8 text-center text-sm text-slate-500"
                      data-testid="platform-billing-invoices-empty"
                    >
                      No invoices match this filter.
                    </td>
                  </tr>
                ) : null}
                {invoices.map((inv) => {
                  const badge = invoiceStatusBadge(inv.status);
                  return (
                    <tr
                      key={inv.id}
                      data-testid={`platform-billing-invoice-row-${inv.id}`}
                    >
                      <td className="px-4 py-3 font-mono text-xs text-slate-700">
                        <Link
                          href={`/super-admin/platform-billing/invoices/${inv.id}`}
                          className="text-slate-900 underline-offset-2 hover:underline"
                          data-testid={`platform-billing-invoice-link-${inv.id}`}
                        >
                          {inv.invoiceNumber}
                        </Link>
                      </td>
                      <td className="px-4 py-3 text-slate-700">
                        <div className="flex flex-col">
                          <span>{inv.tenant?.name ?? "(unknown)"}</span>
                          <span className="text-xs text-slate-500">
                            {inv.tenant?.subdomain ?? "—"}
                          </span>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-right font-medium text-slate-900">
                        <span className="inline-flex items-center gap-1 tabular-nums">
                          <IndianRupee size={12} aria-hidden="true" />
                          {formatRupees(inv.totalInPaise).replace("₹", "")}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-slate-700">
                        {formatDate(inv.issuedAt ?? inv.createdAt)}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${badge.cls}`}
                        >
                          <badge.Icon size={12} aria-hidden="true" />
                          {badge.label}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right">
                        {inv.status === "ISSUED" ? (
                          <button
                            type="button"
                            data-testid={`platform-billing-mark-paid-${inv.id}`}
                            onClick={() => openMarkPaid(inv.id)}
                            className="inline-flex h-11 min-w-[100px] items-center justify-center gap-1.5 rounded-md border border-slate-900 bg-slate-900 px-3 text-xs font-medium text-white hover:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-slate-900"
                          >
                            <CheckCircle2 size={14} aria-hidden="true" />
                            Mark Paid
                          </button>
                        ) : (
                          <span className="text-xs text-slate-400">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      {/* MARK-PAID MODAL */}
      {markPaidForId ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="platform-billing-mark-paid-title"
          data-testid="platform-billing-mark-paid-modal"
          onClick={closeMarkPaid}
        >
          <div
            className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h2
              id="platform-billing-mark-paid-title"
              className="text-lg font-semibold text-slate-900"
            >
              Record payment
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
                onClick={closeMarkPaid}
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
