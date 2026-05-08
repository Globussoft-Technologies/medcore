"use client";

// Issue #715 — Patient-portal /dashboard/bills page.
//
// Modules consumed:
//   - GET  /api/v1/billing/invoices            (auto-scopes to req.user.patientId
//                                               when role === PATIENT)
//   - POST /api/v1/billing/pay-online          (creates a Razorpay order; the
//                                               returned orderId/keyId is what
//                                               the Razorpay checkout widget
//                                               consumes — staff/admin shells
//                                               render the full UI on
//                                               /dashboard/billing. This page
//                                               is a stripped-down patient
//                                               surface that opens checkout
//                                               via a redirect URL.)
//
// Why this file exists: the issue reported that authenticated patient users
// hit a hard 404 on /dashboard/bills. /dashboard/billing exists but is the
// reception/admin operational page (refunds, discounts, reminders, claims).
// Patients need a focused list of their own invoices with a Pay action. This
// page is the minimum-viable patient-facing list.

import { useEffect, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { api } from "@/lib/api";
import { useAuthStore } from "@/lib/store";
import { toast } from "@/lib/toast";
import { EmptyState } from "@/components/EmptyState";
import { Receipt } from "lucide-react";

// Issue #89: DOCTOR is excluded from billing; ADMIN + RECEPTION + PATIENT
// matches the existing /dashboard/billing gate.
const ALLOWED = new Set(["ADMIN", "RECEPTION", "PATIENT"]);

interface InvoiceRow {
  id: string;
  invoiceNumber: string;
  totalAmount: number;
  paymentStatus: "PENDING" | "PAID" | "PARTIAL" | "REFUNDED" | string;
  createdAt: string;
  dueDate?: string | null;
  payments?: Array<{ amount: number }>;
}

interface PayOrder {
  orderId: string;
  amount: number;
  currency: string;
  keyId: string;
  invoiceId: string;
  invoiceNumber: string;
}

const DATE_FMT = new Intl.DateTimeFormat("en-IN", {
  day: "2-digit",
  month: "short",
  year: "numeric",
  timeZone: "Asia/Kolkata",
});

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return DATE_FMT.format(d);
}

function fmtMoney(n: number): string {
  return `Rs. ${n.toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function statusTone(status: string): string {
  switch (status) {
    case "PAID":
      return "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300";
    case "PARTIAL":
      return "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300";
    case "REFUNDED":
      return "bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300";
    case "PENDING":
    default:
      return "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300";
  }
}

export default function BillsPage() {
  const { user, isLoading } = useAuthStore();
  const router = useRouter();
  const pathname = usePathname();
  const [invoices, setInvoices] = useState<InvoiceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [payingId, setPayingId] = useState<string | null>(null);

  // Issue #179 convention: redirect non-allowed roles to the chrome-wrapped
  // not-authorized page so the dashboard layout stays mounted.
  useEffect(() => {
    if (!isLoading && user && !ALLOWED.has(user.role)) {
      toast.error("Bills are restricted.");
      router.replace(
        `/dashboard/not-authorized?from=${encodeURIComponent(pathname || "/dashboard/bills")}`,
      );
    }
  }, [user, isLoading, router, pathname]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setLoadError(null);
      try {
        const res = await api.get<{ data: InvoiceRow[] }>(
          "/billing/invoices?page=1&limit=50",
        );
        if (cancelled) return;
        setInvoices(res.data ?? []);
      } catch (err) {
        if (cancelled) return;
        setLoadError(
          err instanceof Error ? err.message : "Failed to load invoices",
        );
        setInvoices([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    if (user && ALLOWED.has(user.role)) load();
    return () => {
      cancelled = true;
    };
  }, [user]);

  function balanceFor(inv: InvoiceRow): number {
    const paid = (inv.payments ?? []).reduce((s, p) => s + (p.amount || 0), 0);
    return Math.max(0, inv.totalAmount - paid);
  }

  async function payNow(inv: InvoiceRow) {
    setPayingId(inv.id);
    try {
      const res = await api.post<{ data: PayOrder }>("/billing/pay-online", {
        invoiceId: inv.id,
      });
      const order = res.data;
      // Surface the Razorpay handoff to the patient. The staff billing page
      // owns the in-page checkout widget — for the lean patient view we
      // open Razorpay's hosted checkout in a new tab via the standard
      // pay-by-link URL. If env-var or future change wires a custom
      // checkout, swap this redirect for the SDK invocation.
      const checkoutUrl = `https://checkout.razorpay.com/v1/checkout.html?key_id=${encodeURIComponent(order.keyId)}&order_id=${encodeURIComponent(order.orderId)}&amount=${order.amount}&currency=${encodeURIComponent(order.currency)}`;
      window.open(checkoutUrl, "_blank", "noopener,noreferrer");
      toast.success(
        `Payment initiated for ${order.invoiceNumber}. Complete checkout in the new tab.`,
      );
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to start payment",
      );
    } finally {
      setPayingId(null);
    }
  }

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
          Bills
        </h1>
      </div>

      {loading ? (
        <div
          className="rounded-xl bg-white p-8 text-center text-gray-500 dark:bg-gray-800 dark:text-gray-400"
          data-testid="bills-loading"
        >
          Loading...
        </div>
      ) : loadError ? (
        <div
          className="rounded-xl border border-red-200 bg-red-50 p-6 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300"
          data-testid="bills-error"
          role="alert"
        >
          <p className="font-medium">Could not load bills.</p>
          <p className="mt-1 text-xs opacity-80">{loadError}</p>
        </div>
      ) : invoices.length === 0 ? (
        <EmptyState
          icon={<Receipt size={28} aria-hidden="true" />}
          title="No bills yet"
          description="Invoices for your visits and procedures will appear here."
        />
      ) : (
        <div
          className="overflow-x-auto rounded-xl bg-white shadow-sm dark:bg-gray-800"
          data-testid="bills-table-wrap"
        >
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 text-left text-xs uppercase tracking-wide text-gray-500 dark:border-gray-700 dark:text-gray-400">
                <th className="px-4 py-3">Invoice #</th>
                <th className="px-4 py-3">Date</th>
                <th className="px-4 py-3">Amount</th>
                <th className="px-4 py-3">Balance</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3 text-right">Action</th>
              </tr>
            </thead>
            <tbody>
              {invoices.map((inv) => {
                const balance = balanceFor(inv);
                const canPay =
                  inv.paymentStatus !== "PAID" &&
                  inv.paymentStatus !== "REFUNDED" &&
                  balance > 0;
                return (
                  <tr
                    key={inv.id}
                    data-testid={`bills-row-${inv.id}`}
                    className="border-b border-gray-100 last:border-b-0 hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-700/40"
                  >
                    <td className="px-4 py-3 font-mono text-xs text-gray-700 dark:text-gray-200">
                      {inv.invoiceNumber}
                    </td>
                    <td className="px-4 py-3 text-gray-700 dark:text-gray-200">
                      {formatDate(inv.createdAt)}
                    </td>
                    <td className="px-4 py-3 font-medium text-gray-900 tabular-nums dark:text-gray-100">
                      {fmtMoney(inv.totalAmount)}
                    </td>
                    <td className="px-4 py-3 tabular-nums text-gray-700 dark:text-gray-200">
                      {fmtMoney(balance)}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${statusTone(inv.paymentStatus)}`}
                      >
                        {inv.paymentStatus}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      {canPay ? (
                        <button
                          type="button"
                          onClick={() => payNow(inv)}
                          disabled={payingId === inv.id}
                          data-testid={`bills-pay-${inv.id}`}
                          className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-white hover:bg-primary-dark disabled:opacity-50"
                        >
                          {payingId === inv.id ? "Starting..." : "Pay"}
                        </button>
                      ) : (
                        <span className="text-xs text-gray-400">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
