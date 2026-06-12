"use client";

// Tenant-facing "My Subscription" — a hospital ADMIN sees ONLY their own
// platform subscription (plan, ₹/mo, status, trial/period dates) and their own
// platform invoice history. Read-only mirror of the super-admin platform-
// billing surface, scoped server-side to the caller's tenant. Plan changes /
// payments stay operator-only.

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import {
  IndianRupee,
  FileText,
  CalendarRange,
  X,
  CreditCard,
  Printer,
  Download,
} from "lucide-react";
import { api, downloadFileEndpoint, printPdfEndpoint } from "@/lib/api";
import { useAuthStore } from "@/lib/store";
import { toast } from "@/lib/toast";
import { openMySubscriptionRazorpayCheckout } from "@/lib/razorpay";

type SubData = {
  tenant: { name: string; subdomain: string } | null;
  subscription: {
    plan: string;
    status: string;
    trialEndsAt: string | null;
    currentPeriodStart: string;
    currentPeriodEnd: string;
    customPriceMonthlyInPaise: number | null;
    cancelledAt: string | null;
    pastDueSince: string | null;
  } | null;
  plan: { key: string; name: string; monthlyPriceInPaise: number } | null;
  effectivePriceInPaise: number | null;
} | null;

type Invoice = {
  id: string;
  invoiceNumber: string;
  periodStart: string;
  periodEnd: string;
  totalInPaise: number;
  status: string;
  issuedAt: string | null;
  paidAt: string | null;
  paymentReference: string | null;
};

type LineItem = {
  id: string;
  description: string;
  unitPriceInPaise: number;
  quantity: number;
  amountInPaise: number;
};

type InvoiceDetail = {
  id: string;
  invoiceNumber: string;
  periodStart: string;
  periodEnd: string;
  subtotalInPaise: number;
  cgstInPaise: number;
  sgstInPaise: number;
  igstInPaise: number;
  totalInPaise: number;
  status: string;
  issuedAt: string | null;
  paidAt: string | null;
  paymentReference: string | null;
  hsnSacCode: string;
  tenant: { name: string; subdomain: string } | null;
  lineItems: LineItem[];
};

function formatRupees(paise: number | null | undefined): string {
  if (paise == null) return "—";
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 2,
  }).format(paise / 100);
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
    return "—";
  }
}

// Effective GST rate (%) derived from the stored amount vs subtotal — so the
// rate shown is whatever the invoice actually carries, not a hardcoded number.
function gstPct(gstPaise: number, subtotalPaise: number): number {
  if (!subtotalPaise) return 0;
  return Math.round((gstPaise / subtotalPaise) * 100);
}

const STATUS_BADGE: Record<string, string> = {
  active:
    "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300",
  trial:
    "border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-900 dark:bg-sky-950/40 dark:text-sky-300",
  past_due:
    "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300",
  suspended:
    "border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300",
  cancelled:
    "border-gray-200 bg-gray-50 text-gray-600 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300",
};

const INVOICE_BADGE: Record<string, string> = {
  PAID: "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300",
  ISSUED:
    "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300",
  VOID: "border-gray-200 bg-gray-50 text-gray-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400",
};

export default function MySubscriptionPage() {
  const router = useRouter();
  const { user } = useAuthStore();
  const [data, setData] = useState<SubData>(null);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Invoice-detail drawer/modal state.
  const [detail, setDetail] = useState<InvoiceDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [paying, setPaying] = useState(false);

  // Tenant admins only. Super-admins use the cross-tenant platform-billing view.
  const isTenantAdmin =
    user?.role === "ADMIN" && (user?.tenantId ?? null) !== null;

  const loadInvoices = useCallback(async () => {
    const inv = await api.get<{ data: { invoices: Invoice[] } }>(
      "/my-subscription/invoices",
    );
    setInvoices(inv.data?.invoices ?? []);
  }, []);

  async function openInvoice(id: string) {
    setDetailLoading(true);
    setDetail(null);
    try {
      const res = await api.get<{ data: { invoice: InvoiceDetail } }>(
        `/my-subscription/invoices/${id}`,
      );
      setDetail(res.data?.invoice ?? null);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not load the invoice.");
    } finally {
      setDetailLoading(false);
    }
  }

  async function payInvoice(inv: { id: string; invoiceNumber: string }) {
    setPaying(true);
    try {
      await openMySubscriptionRazorpayCheckout({
        invoiceId: inv.id,
        invoiceNumber: inv.invoiceNumber,
        contact: { name: user?.name, email: user?.email },
        onSuccess: async () => {
          toast.success("Payment successful — invoice marked paid.");
          await loadInvoices();
          await openInvoice(inv.id);
        },
        onFailure: (reason) => {
          if (reason && reason !== "Payment cancelled") toast.error(reason);
        },
      });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Payment could not be started.");
    } finally {
      setPaying(false);
    }
  }

  useEffect(() => {
    if (!user) return;
    if (!isTenantAdmin) {
      router.replace("/dashboard");
    }
  }, [user, isTenantAdmin, router]);

  useEffect(() => {
    if (!isTenantAdmin) return;
    let cancelled = false;
    setLoading(true);
    Promise.all([
      api.get<{ data: SubData }>("/my-subscription"),
      api.get<{ data: { invoices: Invoice[] } }>("/my-subscription/invoices"),
    ])
      .then(([sub, inv]) => {
        if (cancelled) return;
        setData(sub.data ?? null);
        setInvoices(inv.data?.invoices ?? []);
      })
      .catch((e) => {
        if (!cancelled)
          setError(
            e instanceof Error ? e.message : "Could not load your subscription.",
          );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isTenantAdmin]);

  if (!isTenantAdmin) return null;

  const sub = data?.subscription;
  const planName = data?.plan?.name ?? sub?.plan ?? "—";

  return (
    <div data-testid="my-subscription-page" className="mx-auto max-w-5xl">
      {/* Header */}
      <div className="mb-6 flex items-center gap-3">
        <span className="inline-flex h-11 w-11 items-center justify-center rounded-xl bg-indigo-100 text-indigo-600 dark:bg-indigo-950/40 dark:text-indigo-300">
          <IndianRupee size={22} aria-hidden="true" />
        </span>
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
            My Subscription
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Your MedCore plan and platform invoices.
          </p>
        </div>
      </div>

      {error && (
        <div className="mb-4 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300">
          {error}
        </div>
      )}

      {loading ? (
        <div className="rounded-xl border border-gray-200 bg-white p-6 text-sm text-gray-500 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-400">
          Loading…
        </div>
      ) : !sub ? (
        <div className="rounded-xl border border-gray-200 bg-white p-6 text-sm text-gray-500 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-400">
          No subscription is set up for your hospital yet. Please contact MedCore
          support.
        </div>
      ) : (
        <>
          {/* Current plan card */}
          <section className="mb-6 rounded-xl border border-gray-200 bg-white p-6 shadow-sm dark:border-gray-700 dark:bg-gray-900">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-gray-400 dark:text-gray-500">
                  Current plan
                </p>
                <p className="mt-1 text-2xl font-bold text-gray-900 dark:text-gray-100">
                  {planName}
                </p>
                <p className="mt-1 text-lg font-semibold text-indigo-600 dark:text-indigo-400">
                  {formatRupees(data?.effectivePriceInPaise)}
                  <span className="text-sm font-normal text-gray-500 dark:text-gray-400">
                    {" "}
                    / month
                  </span>
                </p>
              </div>
              <span
                className={`inline-flex items-center rounded-full border px-3 py-1 text-xs font-medium capitalize ${
                  STATUS_BADGE[sub.status] ?? STATUS_BADGE.cancelled
                }`}
              >
                {sub.status.replace("_", " ")}
              </span>
            </div>

            <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
              <Stat
                icon={<CalendarRange size={14} aria-hidden="true" />}
                label="Trial ends"
                value={formatDate(sub.trialEndsAt)}
              />
              <Stat
                icon={<CalendarRange size={14} aria-hidden="true" />}
                label="Period start"
                value={formatDate(sub.currentPeriodStart)}
              />
              <Stat
                icon={<CalendarRange size={14} aria-hidden="true" />}
                label="Renews / period end"
                value={formatDate(sub.currentPeriodEnd)}
              />
            </div>
            <p className="mt-4 text-xs text-gray-400 dark:text-gray-500">
              To change your plan, contact MedCore support at{" "}
              <a
                href="mailto:support@medcore.software"
                className="font-medium text-indigo-600 hover:underline dark:text-indigo-400"
              >
                support@medcore.software
              </a>
              .
            </p>
          </section>

          {/* Invoices */}
          <section className="rounded-xl border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-900">
            <div className="flex items-center gap-2 border-b border-gray-200 px-6 py-4 dark:border-gray-700">
              <FileText
                size={16}
                className="text-gray-400 dark:text-gray-500"
                aria-hidden="true"
              />
              <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                Invoices
              </h2>
            </div>
            {invoices.length === 0 ? (
              <p className="px-6 py-6 text-sm text-gray-500 dark:text-gray-400">
                No invoices yet.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-b border-gray-200 text-xs uppercase tracking-wide text-gray-400 dark:border-gray-700 dark:text-gray-500">
                      <th className="px-6 py-3 font-medium">Invoice #</th>
                      <th className="px-4 py-3 font-medium">Period</th>
                      <th className="px-4 py-3 font-medium">Amount</th>
                      <th className="px-4 py-3 font-medium">Status</th>
                      <th className="px-4 py-3 font-medium">Issued</th>
                      <th className="px-4 py-3 font-medium">Paid</th>
                      <th className="px-4 py-3" />
                    </tr>
                  </thead>
                  <tbody>
                    {invoices.map((inv) => (
                      <tr
                        key={inv.id}
                        data-testid={`my-subscription-invoice-${inv.id}`}
                        onClick={() => openInvoice(inv.id)}
                        className="cursor-pointer border-b border-gray-100 last:border-0 hover:bg-gray-50 dark:border-gray-800 dark:hover:bg-gray-800/40"
                      >
                        <td className="px-6 py-3 font-mono text-xs text-indigo-600 underline-offset-2 hover:underline dark:text-indigo-400">
                          {inv.invoiceNumber}
                        </td>
                        <td className="px-4 py-3 text-xs text-gray-500 dark:text-gray-400">
                          {formatDate(inv.periodStart)} – {formatDate(inv.periodEnd)}
                        </td>
                        <td className="px-4 py-3 font-medium text-gray-900 dark:text-gray-100">
                          {formatRupees(inv.totalInPaise)}
                        </td>
                        <td className="px-4 py-3">
                          <span
                            className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${
                              INVOICE_BADGE[inv.status] ?? INVOICE_BADGE.VOID
                            }`}
                          >
                            {inv.status}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-xs text-gray-500 dark:text-gray-400">
                          {formatDate(inv.issuedAt)}
                        </td>
                        <td className="px-4 py-3 text-xs text-gray-500 dark:text-gray-400">
                          {formatDate(inv.paidAt)}
                        </td>
                        <td className="px-4 py-3 text-right">
                          {inv.status === "ISSUED" ? (
                            <button
                              type="button"
                              data-testid={`my-subscription-pay-${inv.id}`}
                              disabled={paying}
                              onClick={(e) => {
                                e.stopPropagation();
                                void payInvoice(inv);
                              }}
                              className="inline-flex items-center gap-1 rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-60"
                            >
                              <CreditCard size={12} aria-hidden="true" />
                              Pay now
                            </button>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}

      {/* Invoice detail modal — full printable bill + Pay action. */}
      {(detail || detailLoading) && (
        <div
          role="dialog"
          aria-modal="true"
          data-testid="my-subscription-invoice-modal"
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
          onClick={() => setDetail(null)}
        >
          <div
            className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-xl border border-gray-200 bg-white p-6 shadow-xl dark:border-gray-700 dark:bg-gray-900"
            onClick={(e) => e.stopPropagation()}
          >
            {detailLoading || !detail ? (
              <p className="py-8 text-center text-sm text-gray-500 dark:text-gray-400">
                Loading invoice…
              </p>
            ) : (
              <>
                <div className="mb-4 flex items-start justify-between">
                  <div>
                    <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                      Invoice {detail.invoiceNumber}
                    </h3>
                    <p className="text-xs text-gray-500 dark:text-gray-400">
                      {detail.tenant?.name} · Period{" "}
                      {formatDate(detail.periodStart)} –{" "}
                      {formatDate(detail.periodEnd)}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setDetail(null)}
                    className="rounded p-1 text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800"
                    aria-label="Close"
                  >
                    <X size={18} />
                  </button>
                </div>

                <div className="mb-4 flex items-center gap-3">
                  <span
                    className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${
                      INVOICE_BADGE[detail.status] ?? INVOICE_BADGE.VOID
                    }`}
                  >
                    {detail.status}
                  </span>
                  <span className="text-xs text-gray-500 dark:text-gray-400">
                    Issued {formatDate(detail.issuedAt)}
                    {detail.paidAt ? ` · Paid ${formatDate(detail.paidAt)}` : ""}
                  </span>
                </div>

                {/* Line items */}
                <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-700">
                  <table className="w-full text-left text-sm">
                    <thead>
                      <tr className="border-b border-gray-200 bg-gray-50 text-xs uppercase tracking-wide text-gray-400 dark:border-gray-700 dark:bg-gray-800/50 dark:text-gray-500">
                        <th className="px-4 py-2 font-medium">Description</th>
                        <th className="px-4 py-2 text-right font-medium">Qty</th>
                        <th className="px-4 py-2 text-right font-medium">Unit</th>
                        <th className="px-4 py-2 text-right font-medium">Amount</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.lineItems.map((li) => (
                        <tr
                          key={li.id}
                          className="border-b border-gray-100 last:border-0 dark:border-gray-800"
                        >
                          <td className="px-4 py-2 text-gray-700 dark:text-gray-300">
                            {li.description}
                          </td>
                          <td className="px-4 py-2 text-right text-gray-500 dark:text-gray-400">
                            {li.quantity}
                          </td>
                          <td className="px-4 py-2 text-right text-gray-500 dark:text-gray-400">
                            {formatRupees(li.unitPriceInPaise)}
                          </td>
                          <td className="px-4 py-2 text-right font-medium text-gray-900 dark:text-gray-100">
                            {formatRupees(li.amountInPaise)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* Totals — GST rates are derived dynamically from the stored
                    amounts (effective % of subtotal), so the breakdown reflects
                    whatever rate the invoice actually carries (CGST+SGST intra-
                    state vs IGST cross-state). */}
                <div className="mt-4 ml-auto w-full max-w-xs space-y-1 text-sm">
                  <Row label="Subtotal" value={formatRupees(detail.subtotalInPaise)} />
                  {detail.cgstInPaise > 0 && (
                    <Row
                      label={`CGST (${gstPct(detail.cgstInPaise, detail.subtotalInPaise)}%)`}
                      value={formatRupees(detail.cgstInPaise)}
                    />
                  )}
                  {detail.sgstInPaise > 0 && (
                    <Row
                      label={`SGST (${gstPct(detail.sgstInPaise, detail.subtotalInPaise)}%)`}
                      value={formatRupees(detail.sgstInPaise)}
                    />
                  )}
                  {detail.igstInPaise > 0 && (
                    <Row
                      label={`IGST (${gstPct(detail.igstInPaise, detail.subtotalInPaise)}%)`}
                      value={formatRupees(detail.igstInPaise)}
                    />
                  )}
                  <div className="flex items-center justify-between border-t border-gray-200 pt-1 text-base font-bold text-gray-900 dark:border-gray-700 dark:text-gray-100">
                    <span>Total</span>
                    <span>{formatRupees(detail.totalInPaise)}</span>
                  </div>
                </div>

                <p className="mt-3 text-[11px] text-gray-400 dark:text-gray-500">
                  HSN/SAC {detail.hsnSacCode}
                </p>

                {/* Actions */}
                <div className="mt-6 flex flex-wrap items-center justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setDetail(null)}
                    className="inline-flex h-10 items-center rounded-md border border-gray-300 bg-white px-4 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
                  >
                    Close
                  </button>
                  <button
                    type="button"
                    data-testid="my-subscription-invoice-download"
                    onClick={() =>
                      void downloadFileEndpoint(
                        `/my-subscription/invoices/${detail.id}/pdf`,
                        `${detail.invoiceNumber}.pdf`,
                      )
                    }
                    className="inline-flex h-10 items-center gap-1 rounded-md border border-gray-300 bg-white px-4 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
                  >
                    <Download size={14} aria-hidden="true" />
                    Download PDF
                  </button>
                  <button
                    type="button"
                    data-testid="my-subscription-invoice-print"
                    onClick={() =>
                      void printPdfEndpoint(
                        `/my-subscription/invoices/${detail.id}/pdf`,
                      )
                    }
                    className="inline-flex h-10 items-center gap-1 rounded-md border border-gray-300 bg-white px-4 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
                  >
                    <Printer size={14} aria-hidden="true" />
                    Print
                  </button>
                  {detail.status === "ISSUED" && (
                    <button
                      type="button"
                      data-testid="my-subscription-modal-pay"
                      disabled={paying}
                      onClick={() =>
                        void payInvoice({
                          id: detail.id,
                          invoiceNumber: detail.invoiceNumber,
                        })
                      }
                      className="inline-flex h-10 items-center gap-1 rounded-md bg-indigo-600 px-4 text-sm font-semibold text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      <CreditCard size={14} aria-hidden="true" />
                      {paying ? "Processing…" : `Pay ${formatRupees(detail.totalInPaise)}`}
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between text-gray-600 dark:text-gray-400">
      <span>{label}</span>
      <span className="font-medium text-gray-900 dark:text-gray-100">{value}</span>
    </div>
  );
}

function Stat({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-lg border border-gray-200 bg-gray-50 px-4 py-3 dark:border-gray-700 dark:bg-gray-800/50">
      <p className="flex items-center gap-1 text-xs font-medium uppercase tracking-wide text-gray-400 dark:text-gray-500">
        {icon}
        {label}
      </p>
      <p className="mt-1 text-sm font-semibold text-gray-900 dark:text-gray-100">
        {value}
      </p>
    </div>
  );
}
