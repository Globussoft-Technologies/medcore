"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, usePathname } from "next/navigation";
import { api } from "@/lib/api";
import { useAuthStore } from "@/lib/store";
import { toast } from "@/lib/toast";

// Issue #509: page-level gate matching API authorize() in
// apps/api/src/routes/billing.ts (ADMIN, RECEPTION on /reports/refunds and
// the refund-issue endpoint). Previously the page had NO gate at all, so
// PATIENT / NURSE / DOCTOR could navigate to /dashboard/refunds and see the
// refunds dashboard chrome before the API call returned 403.
const VIEW_ALLOWED = new Set(["ADMIN", "RECEPTION"]);

interface RefundRow {
  id: string;
  paidAt: string;
  amount: number;
  mode: string;
  reason: string;
  invoice: {
    id: string;
    invoiceNumber: string;
    totalAmount: number;
    patient: {
      user: { name: string; phone: string };
    };
  };
}

function fmtMoney(n: number) {
  return `Rs. ${n.toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function defaultFrom() {
  const d = new Date();
  d.setDate(d.getDate() - 30);
  return d.toISOString().slice(0, 10);
}

function defaultTo() {
  return new Date().toISOString().slice(0, 10);
}

export default function RefundsPage() {
  const { user, isLoading } = useAuthStore();
  const router = useRouter();
  const pathname = usePathname();
  const [from, setFrom] = useState(defaultFrom());
  const [to, setTo] = useState(defaultTo());
  const [rows, setRows] = useState<RefundRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);

  // Issue #509: bounce non-allowed roles to /dashboard/not-authorized.
  useEffect(() => {
    if (!isLoading && user && !VIEW_ALLOWED.has(user.role)) {
      toast.error("Refunds are restricted to Admin and Reception.");
      router.replace(
        `/dashboard/not-authorized?from=${encodeURIComponent(pathname || "/dashboard/refunds")}`,
      );
    }
  }, [user, isLoading, router, pathname]);

  const reversedRange = Boolean(from && to && from > to);

  const load = useCallback(async () => {
    if (from && to && from > to) return;
    setLoading(true);
    try {
      const res = await api.get<{
        data: { refunds: RefundRow[]; totalRefunded: number; count: number };
      }>(
        `/billing/reports/refunds?from=${new Date(from).toISOString()}&to=${new Date(
          to + "T23:59:59.999Z"
        ).toISOString()}`
      );
      setRows(res.data.refunds);
      setTotal(res.data.totalRefunded);
    } catch {
      // ignore
    }
    setLoading(false);
  }, [from, to]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold">Refunds</h1>
      </div>

      {/* Filter */}
      <div className="mb-4 flex flex-wrap items-end gap-3 rounded-xl bg-white p-4 shadow-sm">
        <div>
          <label className="mb-1 block text-xs text-gray-500">From</label>
          <input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="rounded-lg border px-3 py-2 text-sm"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs text-gray-500">To</label>
          <input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className={`rounded-lg border px-3 py-2 text-sm ${
              reversedRange ? "border-red-500" : ""
            }`}
            aria-invalid={reversedRange}
            aria-describedby={reversedRange ? "refunds-to-error" : undefined}
          />
          {reversedRange && (
            <p id="refunds-to-error" className="mt-1 text-xs text-red-600">
              End date must be on or after start date
            </p>
          )}
        </div>
        <button
          onClick={load}
          disabled={reversedRange}
          className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark disabled:cursor-not-allowed disabled:opacity-50"
        >
          Apply
        </button>
        <div className="ml-auto text-right">
          <p className="text-xs uppercase tracking-wider text-gray-400">
            Total Refunded (period)
          </p>
          <p className="mt-1 text-xl font-bold text-orange-600">
            {fmtMoney(total)}
          </p>
          <p className="text-xs text-gray-500">
            {rows.length} refund{rows.length === 1 ? "" : "s"}
          </p>
        </div>
      </div>

      <div className="rounded-xl bg-white shadow-sm">
        {loading ? (
          <div className="p-8 text-center text-gray-500">Loading...</div>
        ) : rows.length === 0 ? (
          <div className="p-8 text-center text-gray-500">
            No refunds in this period.
          </div>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="border-b text-left text-sm text-gray-500">
                <th className="px-4 py-3">Date</th>
                <th className="px-4 py-3">Invoice #</th>
                <th className="px-4 py-3">Patient</th>
                <th className="px-4 py-3">Amount</th>
                <th className="px-4 py-3">Mode</th>
                <th className="px-4 py-3">Reason</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b last:border-0">
                  <td className="px-4 py-3 text-sm">
                    {new Date(r.paidAt).toLocaleString("en-IN")}
                  </td>
                  <td className="px-4 py-3 font-mono text-sm">
                    <Link
                      href={`/dashboard/billing/${r.invoice.id}`}
                      className="text-primary hover:underline"
                    >
                      {r.invoice.invoiceNumber}
                    </Link>
                  </td>
                  <td className="px-4 py-3">
                    <p className="font-medium">{r.invoice.patient.user.name}</p>
                    <p className="text-xs text-gray-500">
                      {r.invoice.patient.user.phone}
                    </p>
                  </td>
                  <td className="px-4 py-3 text-sm font-semibold text-orange-600">
                    {fmtMoney(r.amount)}
                  </td>
                  <td className="px-4 py-3 text-sm">{r.mode}</td>
                  <td className="px-4 py-3 text-sm text-gray-600">
                    {r.reason || "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
