"use client";

import { useEffect, useMemo, useState, useCallback } from "react";
import Link from "next/link";
import { useRouter, usePathname } from "next/navigation";
import { api } from "@/lib/api";
import { fetchRazorpayConfig } from "@/lib/razorpay";
import { useAuthStore } from "@/lib/store";
import { useTranslation } from "@/lib/i18n";
import { toast } from "@/lib/toast";
import { EmptyState } from "@/components/EmptyState";
import { derivePaymentStatus, computeInvoiceTotals } from "@medcore/shared";

// Issue #89: DOCTOR must NOT see Billing / invoices. PATIENT keeps own-data
// access; ADMIN + RECEPTION are the operational roles.
const BILLING_ALLOWED = new Set(["ADMIN", "RECEPTION", "PATIENT"]);
import {
  Printer,
  Receipt,
  Undo2,
  Percent,
  BellRing,
  Download,
  MoreHorizontal,
  Globe,
} from "lucide-react";

interface InvoiceRecord {
  id: string;
  invoiceNumber: string;
  // Persisted aggregates. `totalAmount` is the legacy column and may be
  // pre-GST on older rows — never use it directly for display; pass through
  // computeInvoiceTotals(...) along with `items` so the screen always agrees
  // with the invoice detail page.
  totalAmount: number;
  subtotal?: number;
  taxAmount?: number;
  discountAmount?: number;
  paymentStatus: string;
  createdAt: string;
  patientId: string;
  patient: { user: { name: string; phone: string } };
  items: Array<{ id: string; amount: number; category: string }>;
  payments: Array<{ id: string; amount: number; mode: string; paidAt: string; transactionId?: string | null }>;
}

interface OutstandingRow {
  invoiceId: string;
  invoiceNumber: string;
  patientId: string;
  patient: { user: { name: string; phone: string } };
  totalAmount: number;
  paid: number;
  balance: number;
  daysOverdue: number;
  paymentStatus: string;
  createdAt: string;
}

type Tab = "all" | "PENDING" | "PARTIAL" | "PAID" | "REFUNDED" | "outstanding";

function fmtMoney(n: number) {
  return `Rs. ${n.toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function MoneyValue({ amount, tone = "" }: { amount: number; tone?: string }) {
  const formatted = fmtMoney(amount);
  return (
    <span
      title={formatted}
      className={`ml-auto block max-w-[9.5rem] truncate text-right tabular-nums ${tone}`}
    >
      {formatted}
    </span>
  );
}

function daysAgo(iso: string) {
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
}

function overdueClass(days: number) {
  if (days > 30) return "text-red-600 font-semibold";
  if (days > 7) return "text-orange-500 font-medium";
  return "text-gray-500";
}

export default function BillingPage() {
  const { user, isLoading } = useAuthStore();
  const router = useRouter();
  const pathname = usePathname();
  const { t } = useTranslation();

  // Issue #89: redirect DOCTORs (or any non-allowed role) away.
  // Issue #501: redirect to /dashboard/not-authorized (the chrome-wrapped
  // 403 page from #179) instead of silently bouncing to /dashboard. A
  // Nurse typing /dashboard/billing in the URL bar used to land back on
  // the home dashboard with the toast as the only signal — the toast
  // could be missed entirely on slower machines because router.replace
  // unmounted the source page before it animated in. The not-authorized
  // page renders a persistent "Access Denied" banner that names the
  // requested route, so the bounce is no longer ambiguous. The toast is
  // kept as a secondary cue for power users who navigate quickly.
  useEffect(() => {
    if (!isLoading && user && !BILLING_ALLOWED.has(user.role)) {
      toast.error("Billing is restricted to Admin, Reception, and Patients.");
      router.replace(
        `/dashboard/not-authorized?from=${encodeURIComponent(pathname || "/dashboard/billing")}`,
      );
    }
  }, [user, isLoading, router, pathname]);
  const [invoices, setInvoices] = useState<InvoiceRecord[]>([]);
  const [outstanding, setOutstanding] = useState<OutstandingRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>("all");
  const [openActionsFor, setOpenActionsFor] = useState<string | null>(null);

  // Summary card stats
  const [summary, setSummary] = useState<{
    totalOutstanding: number;
    todayCollection: number;
    monthRevenue: number;
    monthRefunds: number;
  }>({
    totalOutstanding: 0,
    todayCollection: 0,
    monthRevenue: 0,
    monthRefunds: 0,
  });

  // Razorpay availability — drives whether the row's "Pay Online" menu item
  // renders + whether it shows the yellow TEST badge. Mirrors the detail page.
  const [razorpay, setRazorpay] = useState<{
    enabled: boolean;
    isTestMode: boolean;
  }>({ enabled: false, isTestMode: false });

  // Record Payment modal
  const [payInv, setPayInv] = useState<InvoiceRecord | null>(null);
  const [payAmount, setPayAmount] = useState("");
  const [payMode, setPayMode] = useState("CASH");
  const [paySubmitting, setPaySubmitting] = useState(false);

  // Refund modal
  const [refundInv, setRefundInv] = useState<InvoiceRecord | null>(null);
  const [refundAmount, setRefundAmount] = useState("");
  const [refundReason, setRefundReason] = useState("");
  const [refundMode, setRefundMode] = useState("CASH");
  const [refundSubmitting, setRefundSubmitting] = useState(false);

  // Discount modal
  const [discInv, setDiscInv] = useState<InvoiceRecord | null>(null);
  const [discType, setDiscType] = useState<"percentage" | "flat">("percentage");
  const [discValue, setDiscValue] = useState("");
  const [discReason, setDiscReason] = useState("");
  const [discSubmitting, setDiscSubmitting] = useState(false);

  const loadInvoices = useCallback(async () => {
    setLoading(true);
    try {
      const q = tab !== "all" && tab !== "outstanding" ? `?status=${tab}` : "";
      const res = await api.get<{ data: InvoiceRecord[] }>(`/billing/invoices${q}`);
      setInvoices(res.data);
    } catch {
      // empty
    }
    setLoading(false);
  }, [tab]);

  const loadOutstanding = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<{
        data: { rows: OutstandingRow[]; totalOutstanding: number; count: number };
      }>("/billing/reports/outstanding");
      setOutstanding(res.data.rows);
    } catch {
      // empty
    }
    setLoading(false);
  }, []);

  const loadSummary = useCallback(async () => {
    // Issue #203: each tile is fed by an independent endpoint and several
    // are RBAC-gated (e.g. `/reports/daily` is ADMIN-only per #90). The
    // previous Promise.all rejected the whole batch the moment one of the
    // four returned 403, leaving every tile stuck at Rs. 0.00 even when
    // the others had data. Promise.allSettled lets each tile populate
    // from whichever endpoints the current role is allowed to hit.
    const today = new Date();
    const firstOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
    const results = await Promise.allSettled([
      api.get<{ data: { totalOutstanding: number } }>(
        "/billing/reports/outstanding"
      ),
      api.get<{ data: { totalCollection: number } }>(
        `/billing/reports/daily?date=${today.toISOString().slice(0, 10)}`
      ),
      api.get<{ data: { totals: { inflow: number } } }>(
        `/billing/reports/revenue?from=${firstOfMonth.toISOString()}&to=${today.toISOString()}&groupBy=day`
      ),
      api.get<{ data: { totalRefunded: number } }>(
        `/billing/reports/refunds?from=${firstOfMonth.toISOString()}&to=${today.toISOString()}`
      ),
    ]);
    const [outRes, daily, rev, refunds] = results;
    setSummary((prev) => ({
      totalOutstanding:
        outRes.status === "fulfilled"
          ? outRes.value.data.totalOutstanding ?? 0
          : prev.totalOutstanding,
      todayCollection:
        daily.status === "fulfilled"
          ? daily.value.data.totalCollection ?? 0
          : prev.todayCollection,
      monthRevenue:
        rev.status === "fulfilled"
          ? rev.value.data.totals?.inflow ?? 0
          : prev.monthRevenue,
      monthRefunds:
        refunds.status === "fulfilled"
          ? refunds.value.data.totalRefunded ?? 0
          : prev.monthRefunds,
    }));
  }, []);

  useEffect(() => {
    if (tab === "outstanding") {
      loadOutstanding();
    } else {
      loadInvoices();
    }
  }, [tab, loadInvoices, loadOutstanding]);

  useEffect(() => {
    if (user?.role === "ADMIN" || user?.role === "RECEPTION") {
      loadSummary();
    }
  }, [user, loadSummary]);

  useEffect(() => {
    fetchRazorpayConfig().then(setRazorpay).catch(() => {
      setRazorpay({ enabled: false, isTestMode: false });
    });
  }, []);

  async function submitRecordPayment() {
    if (!payInv) return;
    setPaySubmitting(true);
    try {
      await api.post("/billing/payments", {
        invoiceId: payInv.id,
        amount: parseFloat(payAmount),
        mode: payMode,
      });
      setPayInv(null);
      setPayAmount("");
      setPayMode("CASH");
      loadInvoices();
      loadSummary();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Payment failed");
    }
    setPaySubmitting(false);
  }

  async function submitRefund() {
    if (!refundInv) return;
    setRefundSubmitting(true);
    try {
      await api.post("/billing/refunds", {
        invoiceId: refundInv.id,
        amount: parseFloat(refundAmount),
        reason: refundReason,
        mode: refundMode,
      });
      setRefundInv(null);
      setRefundAmount("");
      setRefundReason("");
      setRefundMode("CASH");
      loadInvoices();
      loadSummary();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Refund failed");
    }
    setRefundSubmitting(false);
  }

  async function submitDiscount() {
    if (!discInv) return;
    setDiscSubmitting(true);
    try {
      const body: Record<string, unknown> = { reason: discReason };
      if (discType === "percentage") body.percentage = parseFloat(discValue);
      else body.flatAmount = parseFloat(discValue);
      await api.post(`/billing/invoices/${discInv.id}/discount`, body);
      setDiscInv(null);
      setDiscValue("");
      setDiscReason("");
      loadInvoices();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Discount failed");
    }
    setDiscSubmitting(false);
  }

  function sendReminder(inv: { patient: { user: { name: string; phone: string } }; invoiceNumber: string; balance?: number }) {
    // eslint-disable-next-line no-console
    console.log(
      `[REMINDER] Sending reminder to ${inv.patient.user.name} (${inv.patient.user.phone}) for invoice ${inv.invoiceNumber}${
        inv.balance !== undefined ? ` — balance ${fmtMoney(inv.balance)}` : ""
      }`
    );
    toast.success(`Reminder queued for ${inv.patient.user.name}`);
  }

  function exportCSV() {
    const rows =
      tab === "outstanding"
        ? outstanding.map((r) => ({
            invoice: r.invoiceNumber,
            patient: r.patient.user.name,
            phone: r.patient.user.phone,
            total: r.totalAmount,
            paid: r.paid,
            balance: r.balance,
            daysOverdue: r.daysOverdue,
            status: r.paymentStatus,
            createdAt: new Date(r.createdAt).toISOString(),
          }))
        : invoices.map((inv) => {
            const paid = inv.payments
              .filter((p) => p.amount >= 0)
              .reduce((s, p) => s + p.amount, 0);
            const refunded = inv.payments
              .filter((p) => p.amount < 0)
              .reduce((s, p) => s + Math.abs(p.amount), 0);
            // CSV must match what's on screen — use the GST-corrected total
            // from computeInvoiceTotals, not the raw legacy `totalAmount`.
            const totals = computeInvoiceTotals(inv.items || [], {
              subtotal: inv.subtotal,
              taxAmount: inv.taxAmount,
              discountAmount: inv.discountAmount,
              totalAmount: inv.totalAmount,
            });
            return {
              invoice: inv.invoiceNumber,
              patient: inv.patient.user.name,
              phone: inv.patient.user.phone,
              total: totals.totalAmount,
              paid,
              refunded,
              balance: totals.totalAmount - (paid - refunded),
              status: inv.paymentStatus,
              createdAt: new Date(inv.createdAt).toISOString(),
            };
          });
    if (!rows.length) {
      toast.info("No rows to export");
      return;
    }
    const headers = Object.keys(rows[0]);
    const csv = [
      headers.join(","),
      ...rows.map((r) =>
        headers
          .map((h) => {
            const v = (r as Record<string, unknown>)[h];
            return typeof v === "string" && v.includes(",") ? `"${v}"` : String(v);
          })
          .join(",")
      ),
    ].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `billing-${tab}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const statusColors: Record<string, string> = {
    PENDING: "bg-red-100 text-red-700",
    PARTIAL: "bg-yellow-100 text-yellow-700",
    PAID: "bg-green-100 text-green-700",
    REFUNDED: "bg-gray-100 text-gray-500",
  };

  const tabs: Array<{ id: Tab; label: string }> = [
    { id: "all", label: "All" },
    { id: "PENDING", label: "Pending" },
    { id: "PARTIAL", label: "Partial" },
    { id: "PAID", label: "Paid" },
    { id: "REFUNDED", label: "Refunded" },
    { id: "outstanding", label: "Outstanding Report" },
  ];

  const isStaff = user?.role === "ADMIN" || user?.role === "RECEPTION";
  // Issue #401: when the logged-in user IS the patient, hiding their own
  // phone number on every invoice row removes redundant noise. Staff
  // (ADMIN/RECEPTION) still need it for collections.
  const isPatient = user?.role === "PATIENT";

  const enrichedInvoices = useMemo(
    () =>
      invoices.map((inv) => {
        const paid = inv.payments
          .filter((p) => p.amount >= 0)
          .reduce((s, p) => s + p.amount, 0);
        const refunded = inv.payments
          .filter((p) => p.amount < 0)
          .reduce((s, p) => s + Math.abs(p.amount), 0);
        const netPaid = paid - refunded;
        // GST-corrected total — matches the detail page's `displayTotal` so
        // the list and detail never disagree on Amount / Balance. Legacy
        // invoice rows persisted `totalAmount` as subtotal-minus-discount
        // (no GST); computeInvoiceTotals re-derives the correct figure from
        // line items + their categories. Falls back to the persisted value
        // when items are missing (older API responses).
        const totals = computeInvoiceTotals(inv.items || [], {
          subtotal: inv.subtotal,
          taxAmount: inv.taxAmount,
          discountAmount: inv.discountAmount,
          totalAmount: inv.totalAmount,
        });
        const displayTotal = totals.totalAmount;
        const balance = Math.max(0, displayTotal - netPaid);
        const age = daysAgo(inv.createdAt);
        // Issue #235: a row stored as PAID with non-zero balance must
        // display as PARTIAL — derivePaymentStatus is the single rule.
        const displayStatus = derivePaymentStatus(
          inv.paymentStatus,
          displayTotal,
          netPaid
        );
        return {
          ...inv,
          paid,
          refunded,
          netPaid,
          balance,
          age,
          displayStatus,
          displayTotal,
        };
      }),
    [invoices]
  );

  return (
    <div onClick={() => setOpenActionsFor(null)}>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{t("dashboard.billing.title")}</h1>
        <div className="flex items-center gap-2">
          <button
            onClick={(e) => {
              e.stopPropagation();
              exportCSV();
            }}
            className="flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
          >
            <Download size={14} /> Export CSV
          </button>
        </div>
      </div>

      {/* Summary cards */}
      {isStaff && (
        <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="rounded-xl bg-white p-4 shadow-sm dark:bg-gray-800">
            <p className="text-xs uppercase tracking-wider text-gray-400 dark:text-gray-500">Total Outstanding</p>
            <p className="mt-1 text-2xl font-bold text-red-600">
              {fmtMoney(summary.totalOutstanding)}
            </p>
          </div>
          <div className="rounded-xl bg-white p-4 shadow-sm dark:bg-gray-800">
            <p className="text-xs uppercase tracking-wider text-gray-400 dark:text-gray-500">Today&apos;s Collection</p>
            <p className="mt-1 text-2xl font-bold text-green-600">
              {fmtMoney(summary.todayCollection)}
            </p>
          </div>
          <div className="rounded-xl bg-white p-4 shadow-sm dark:bg-gray-800">
            <p className="text-xs uppercase tracking-wider text-gray-400 dark:text-gray-500">This Month&apos;s Revenue</p>
            <p className="mt-1 text-2xl font-bold text-primary">
              {fmtMoney(summary.monthRevenue)}
            </p>
          </div>
          <div className="rounded-xl bg-white p-4 shadow-sm dark:bg-gray-800">
            <p className="text-xs uppercase tracking-wider text-gray-400 dark:text-gray-500">Refunds This Month</p>
            <p className="mt-1 text-2xl font-bold text-orange-500">
              {fmtMoney(summary.monthRefunds)}
            </p>
          </div>
        </div>
      )}

      {/* Tabs */}
      <div className="mb-4 flex flex-wrap gap-2">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={(e) => {
              e.stopPropagation();
              setTab(t.id);
            }}
            className={`rounded-lg px-3 py-1.5 text-sm ${
              tab === t.id
                ? "bg-primary text-white"
                : "bg-white text-gray-600 hover:bg-gray-100 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="overflow-x-auto rounded-xl bg-white text-gray-900 shadow-sm dark:bg-gray-800 dark:text-gray-100">
        {loading ? (
          <div className="p-8 text-center text-gray-500 dark:text-gray-400">Loading...</div>
        ) : tab === "outstanding" ? (
          outstanding.length === 0 ? (
            <div className="p-8 text-center text-gray-500 dark:text-gray-400">
              No outstanding invoices.
            </div>
          ) : (
            <table className="w-full min-w-[920px]">
              <thead>
                <tr className="border-b border-gray-200 text-left text-sm text-gray-500 dark:border-gray-700 dark:text-gray-400">
                  <th className="px-4 py-3">Invoice #</th>
                  <th className="px-4 py-3">Patient</th>
                  <th className="min-w-36 px-4 py-3 text-right">Total</th>
                  <th className="min-w-36 px-4 py-3 text-right">Paid</th>
                  <th className="min-w-36 px-4 py-3 text-right">Balance</th>
                  <th className="px-4 py-3">Days Overdue</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Actions</th>
                </tr>
              </thead>
              <tbody>
                {outstanding.map((r) => (
                  <tr key={r.invoiceId} className="border-b border-gray-100 last:border-0 dark:border-gray-700">
                    <td className="px-4 py-3 font-mono text-sm">
                      <Link href={`/dashboard/billing/${r.invoiceId}`} className="text-primary hover:underline">
                        {r.invoiceNumber}
                      </Link>
                    </td>
                    <td className="px-4 py-3">
                      <Link
                        href={`/dashboard/billing/patient/${r.patientId}`}
                        className="font-medium hover:underline"
                      >
                        {r.patient.user.name}
                      </Link>
                      {!isPatient && (
                        <p className="text-xs text-gray-500 dark:text-gray-400">{r.patient.user.phone}</p>
                      )}
                    </td>
                    <td className="px-4 py-3 text-sm">
                      <MoneyValue amount={r.totalAmount} />
                    </td>
                    <td className="px-4 py-3 text-sm">
                      <MoneyValue amount={r.paid} />
                    </td>
                    <td className="px-4 py-3 text-sm font-semibold">
                      <MoneyValue amount={r.balance} tone="text-red-600" />
                    </td>
                    <td className={`px-4 py-3 text-sm ${overdueClass(r.daysOverdue)}`}>
                      {r.daysOverdue} days
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${statusColors[r.paymentStatus] || ""}`}
                      >
                        {r.paymentStatus}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          sendReminder({
                            patient: r.patient,
                            invoiceNumber: r.invoiceNumber,
                            balance: r.balance,
                          });
                        }}
                        className="flex items-center gap-1 rounded bg-orange-500 px-2 py-1 text-xs text-white hover:bg-orange-600"
                      >
                        <BellRing size={12} /> Remind
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        ) : invoices.length === 0 ? (
          <EmptyState
            title="No invoices yet"
            description="Invoices will appear here once they are generated from visits or admissions."
          />
        ) : (
          <table className="w-full min-w-[920px]">
            <thead>
              <tr className="border-b border-gray-200 text-left text-sm text-gray-500 dark:border-gray-700 dark:text-gray-400">
                <th className="px-4 py-3">Invoice #</th>
                <th className="px-4 py-3">Patient</th>
                <th className="min-w-36 px-4 py-3 text-right">Amount</th>
                <th className="min-w-36 px-4 py-3 text-right">Paid</th>
                <th className="min-w-36 px-4 py-3 text-right">Balance</th>
                <th className="px-4 py-3">Age</th>
                <th className="px-4 py-3">Status</th>
                {isStaff && <th className="px-4 py-3">Actions</th>}
              </tr>
            </thead>
            <tbody>
              {enrichedInvoices.map((inv) => (
                <tr key={inv.id} className="border-b border-gray-100 last:border-0 dark:border-gray-700">
                  <td className="px-4 py-3 font-mono text-sm">
                    <Link href={`/dashboard/billing/${inv.id}`} className="text-primary hover:underline">
                      {inv.invoiceNumber}
                    </Link>
                  </td>
                  <td className="px-4 py-3">
                    <Link
                      href={`/dashboard/billing/patient/${inv.patientId}`}
                      className="font-medium hover:underline"
                    >
                      {inv.patient.user.name}
                    </Link>
                    {!isPatient && (
                      <p className="text-xs text-gray-500 dark:text-gray-400">{inv.patient.user.phone}</p>
                    )}
                  </td>
                  <td className="px-4 py-3 font-medium">
                    <MoneyValue amount={inv.displayTotal} />
                  </td>
                  <td className="px-4 py-3 text-sm">
                    <MoneyValue amount={inv.netPaid} />
                  </td>
                  <td
                    className="px-4 py-3 text-sm font-semibold"
                  >
                    <MoneyValue
                      amount={inv.balance}
                      tone={
                        inv.balance > 0
                          ? "text-red-600 dark:text-red-400"
                          : "text-gray-500 dark:text-gray-400"
                      }
                    />
                  </td>
                  {/* Issue #400: Age must be computed per-row from the
                      invoice's createdAt, not a hardcoded constant. The
                      enrichedInvoices memo above runs daysAgo(inv.createdAt)
                      for every row. testid lets future tests lock that
                      uniqueness so this regression cannot reappear silently. */}
                  <td
                    data-testid={`bills-age-${inv.id}`}
                    className={`px-4 py-3 text-sm ${overdueClass(inv.age)}`}
                  >
                    {inv.age}d
                  </td>
                  <td className="px-4 py-3">
                    <span
                      data-testid={`bills-status-${inv.id}`}
                      className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${statusColors[inv.displayStatus] || ""}`}
                    >
                      {inv.displayStatus}
                    </span>
                  </td>
                  {isStaff && (
                    <td className="relative px-4 py-3">
                      <button
                        aria-label={`Actions menu for invoice ${inv.invoiceNumber}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          setOpenActionsFor(openActionsFor === inv.id ? null : inv.id);
                        }}
                        className="rounded p-1.5 hover:bg-gray-100"
                      >
                        <MoreHorizontal size={16} aria-hidden="true" />
                      </button>
                      {openActionsFor === inv.id && (
                        <div
                          onClick={(e) => e.stopPropagation()}
                          className="absolute right-4 top-10 z-10 w-52 rounded-lg border bg-white py-1 shadow-lg"
                        >
                          {inv.displayStatus !== "PAID" && (
                            <button
                              onClick={() => {
                                setPayInv(inv);
                                setOpenActionsFor(null);
                              }}
                              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-gray-50"
                            >
                              <Receipt size={14} /> Record Payment
                            </button>
                          )}
                          {inv.displayStatus !== "PAID" && razorpay.enabled && (
                            <Link
                              href={`/dashboard/billing/${inv.id}`}
                              onClick={() => setOpenActionsFor(null)}
                              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-gray-50"
                            >
                              <Globe size={14} />
                              <span>Pay Online</span>
                              {razorpay.isTestMode && (
                                <span className="ml-auto rounded bg-yellow-300 px-1 py-0.5 text-[10px] font-bold text-yellow-900">
                                  TEST
                                </span>
                              )}
                            </Link>
                          )}
                          {inv.netPaid > 0 && (
                            <button
                              onClick={() => {
                                setRefundInv(inv);
                                setRefundAmount(String(inv.netPaid));
                                setOpenActionsFor(null);
                              }}
                              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-gray-50"
                            >
                              <Undo2 size={14} /> Record Refund
                            </button>
                          )}
                          {inv.displayStatus !== "PAID" &&
                            inv.displayStatus !== "REFUNDED" && (
                              <button
                                onClick={() => {
                                  setDiscInv(inv);
                                  setOpenActionsFor(null);
                                }}
                                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-gray-50"
                              >
                                <Percent size={14} /> Apply Discount
                              </button>
                            )}
                          <Link
                            href={`/dashboard/billing/${inv.id}`}
                            className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-gray-50"
                          >
                            <Printer size={14} /> Print Invoice
                          </Link>
                          {inv.balance > 0 && (
                            <button
                              onClick={() => {
                                sendReminder({ ...inv, balance: inv.balance });
                                setOpenActionsFor(null);
                              }}
                              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-gray-50"
                            >
                              <BellRing size={14} /> Send Reminder
                            </button>
                          )}
                        </div>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Record Payment modal */}
      {payInv && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div
            onClick={(e) => e.stopPropagation()}
            className="mx-4 w-full max-w-md rounded-xl bg-white p-6 shadow-2xl"
          >
            <h2 className="mb-4 text-lg font-bold">
              Record Payment — {payInv.invoiceNumber}
            </h2>
            <div className="space-y-3">
              <div>
                <label htmlFor="bill-pay-amount" className="mb-1 block text-xs text-gray-500">Amount (Rs.)</label>
                <input
                  id="bill-pay-amount"
                  type="number"
                  step="0.01"
                  min="0.01"
                  value={payAmount}
                  onChange={(e) => setPayAmount(e.target.value)}
                  className="w-full rounded-lg border px-3 py-2 text-sm"
                  autoFocus
                />
              </div>
              <div>
                <label htmlFor="bill-pay-mode" className="mb-1 block text-xs text-gray-500">Mode</label>
                <select
                  id="bill-pay-mode"
                  value={payMode}
                  onChange={(e) => setPayMode(e.target.value)}
                  className="w-full rounded-lg border px-3 py-2 text-sm"
                >
                  {["CASH", "CARD", "UPI", "ONLINE", "INSURANCE"].map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={() => setPayInv(null)}
                className="rounded-lg px-4 py-2 text-sm text-gray-600 hover:bg-gray-100"
              >
                Cancel
              </button>
              <button
                onClick={submitRecordPayment}
                disabled={paySubmitting || !payAmount}
                className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark disabled:opacity-50"
              >
                {paySubmitting ? "Saving..." : "Save Payment"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Refund modal */}
      {refundInv && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div
            onClick={(e) => e.stopPropagation()}
            className="mx-4 w-full max-w-md rounded-xl bg-white p-6 shadow-2xl"
          >
            <h2 className="mb-4 text-lg font-bold">
              Issue Refund — {refundInv.invoiceNumber}
            </h2>
            <div className="space-y-3">
              <div>
                <label htmlFor="bill-refund-amount" className="mb-1 block text-xs text-gray-500">Amount (Rs.)</label>
                <input
                  id="bill-refund-amount"
                  type="number"
                  step="0.01"
                  min="0.01"
                  value={refundAmount}
                  onChange={(e) => setRefundAmount(e.target.value)}
                  className="w-full rounded-lg border px-3 py-2 text-sm"
                  autoFocus
                />
              </div>
              <div>
                <label htmlFor="bill-refund-mode" className="mb-1 block text-xs text-gray-500">Mode</label>
                <select
                  id="bill-refund-mode"
                  value={refundMode}
                  onChange={(e) => setRefundMode(e.target.value)}
                  className="w-full rounded-lg border px-3 py-2 text-sm"
                >
                  {["CASH", "CARD", "UPI", "ONLINE", "INSURANCE"].map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="bill-refund-reason" className="mb-1 block text-xs text-gray-500">Reason</label>
                <textarea
                  id="bill-refund-reason"
                  value={refundReason}
                  onChange={(e) => setRefundReason(e.target.value)}
                  className="w-full rounded-lg border px-3 py-2 text-sm"
                  rows={3}
                  placeholder="Reason for refund"
                />
              </div>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={() => setRefundInv(null)}
                className="rounded-lg px-4 py-2 text-sm text-gray-600 hover:bg-gray-100"
              >
                Cancel
              </button>
              <button
                onClick={submitRefund}
                disabled={
                  refundSubmitting ||
                  !refundAmount ||
                  !refundReason ||
                  parseFloat(refundAmount) <= 0
                }
                className="rounded-lg bg-orange-500 px-4 py-2 text-sm font-medium text-white hover:bg-orange-600 disabled:opacity-50"
              >
                {refundSubmitting ? "Saving..." : "Issue Refund"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Discount modal */}
      {discInv && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div
            onClick={(e) => e.stopPropagation()}
            className="mx-4 w-full max-w-md rounded-xl bg-white p-6 shadow-2xl"
          >
            <h2 className="mb-4 text-lg font-bold">
              Apply Discount — {discInv.invoiceNumber}
            </h2>
            <div className="space-y-3">
              <div className="flex gap-2">
                <button
                  onClick={() => setDiscType("percentage")}
                  className={`flex-1 rounded-lg px-3 py-2 text-sm ${
                    discType === "percentage"
                      ? "bg-primary text-white"
                      : "bg-gray-100 text-gray-600"
                  }`}
                >
                  Percentage
                </button>
                <button
                  onClick={() => setDiscType("flat")}
                  className={`flex-1 rounded-lg px-3 py-2 text-sm ${
                    discType === "flat"
                      ? "bg-primary text-white"
                      : "bg-gray-100 text-gray-600"
                  }`}
                >
                  Flat Amount
                </button>
              </div>
              <div>
                <label htmlFor="bill-disc-value" className="mb-1 block text-xs text-gray-500">
                  {discType === "percentage" ? "Percentage (%)" : "Flat Amount (Rs.)"}
                </label>
                <input
                  id="bill-disc-value"
                  type="number"
                  step="0.01"
                  min="0"
                  value={discValue}
                  onChange={(e) => setDiscValue(e.target.value)}
                  className="w-full rounded-lg border px-3 py-2 text-sm"
                  autoFocus
                />
              </div>
              <div>
                <label htmlFor="bill-disc-reason" className="mb-1 block text-xs text-gray-500">Reason</label>
                <textarea
                  id="bill-disc-reason"
                  value={discReason}
                  onChange={(e) => setDiscReason(e.target.value)}
                  className="w-full rounded-lg border px-3 py-2 text-sm"
                  rows={2}
                  placeholder="e.g. senior citizen discount"
                />
              </div>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={() => setDiscInv(null)}
                className="rounded-lg px-4 py-2 text-sm text-gray-600 hover:bg-gray-100"
              >
                Cancel
              </button>
              <button
                onClick={submitDiscount}
                disabled={
                  discSubmitting ||
                  !discValue ||
                  !discReason ||
                  parseFloat(discValue) < 0
                }
                className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark disabled:opacity-50"
              >
                {discSubmitting ? "Saving..." : "Apply Discount"}
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
