"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, usePathname } from "next/navigation";
import { api } from "@/lib/api";
import { TenantSelect } from "@/components/TenantSelect";
import { useAuthStore } from "@/lib/store";
import { toast } from "@/lib/toast";
import { formatDateTime } from "@/lib/format";
import { SkeletonTable } from "@/components/Skeleton";
import { useTranslation } from "@/lib/i18n";

// Issue #509: page-level gate matching API authorize() in
// apps/api/src/routes/billing.ts (ADMIN, RECEPTION on /reports/refunds and
// the refund-issue endpoint). Previously the page had NO gate at all, so
// PATIENT / NURSE / DOCTOR could navigate to /dashboard/refunds and see the
// refunds dashboard chrome before the API call returned 403.
const VIEW_ALLOWED = new Set(["ADMIN", "RECEPTION"]);

const REFUNDS_FALLBACKS: Record<string, string> = {
  "common.apply": "Apply",
  "common.date": "Date",
  "common.from": "From",
  "common.reason": "Reason",
  "common.to": "To",
  "dashboard.billing.allTenants": "All tenants",
  "dashboard.billing.amount": "Amount",
  "dashboard.billing.invoiceNumber": "Invoice #",
  "dashboard.billing.patient": "Patient",
  "dashboard.refunds.title": "Refunds",
  "dashboard.refunds.mode": "Mode",
  "dashboard.refunds.totalRefundedPeriod": "Total Refunded (period)",
  "dashboard.refunds.count.singular": "refund",
  "dashboard.refunds.count.plural": "refunds",
  "dashboard.refunds.empty": "No refunds in this period.",
  "dashboard.refunds.rangeError": "End date must be on or after start date",
  "dashboard.refunds.restricted": "Refunds are restricted to Admin and Reception.",
};

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
  const { t: translate } = useTranslation();
  const t = useCallback(
    (key: string, fallback?: string) => {
      const resolvedFallback = fallback ?? REFUNDS_FALLBACKS[key];
      const value = translate(key, resolvedFallback);
      return value === key ? resolvedFallback ?? key : value;
    },
    [translate],
  );
  const [from, setFrom] = useState(defaultFrom());
  const [to, setTo] = useState(defaultTo());
  const [rows, setRows] = useState<RefundRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  // Refunds are financial data → cross-tenant view is MAIN-super-admin-only
  // (matches Billing). The dropdown lets the main super admin scope to one
  // tenant; the /billing/reports/refunds endpoint enforces the same gate.
  const isMainSuperAdmin = user?.isMainSuperAdmin === true;
  const [tenants, setTenants] = useState<
    Array<{ id: string; name: string; subdomain: string }>
  >([]);
  const [selectedTenantId, setSelectedTenantId] = useState("");

  // Issue #509: bounce non-allowed roles to /dashboard/not-authorized.
  useEffect(() => {
    if (!isLoading && user && !VIEW_ALLOWED.has(user.role)) {
      toast.error(t("dashboard.refunds.restricted"));
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
      const tenantParam =
        isMainSuperAdmin && selectedTenantId
          ? `&tenantId=${encodeURIComponent(selectedTenantId)}`
          : "";
      const res = await api.get<{
        data: { refunds: RefundRow[]; totalRefunded: number; count: number };
      }>(
        `/billing/reports/refunds?from=${new Date(from).toISOString()}&to=${new Date(
          to + "T23:59:59.999Z"
        ).toISOString()}${tenantParam}`
      );
      setRows(res.data.refunds);
      setTotal(res.data.totalRefunded);
    } catch {
      // ignore
    }
    setLoading(false);
  }, [from, to, isMainSuperAdmin, selectedTenantId]);

  useEffect(() => {
    load();
  }, [load]);

  // Load the tenant list for the super-admin filter (super-admin-only endpoint).
  useEffect(() => {
    if (!isMainSuperAdmin) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await api.get<{
          data: Array<{ id: string; name: string; subdomain: string }>;
        }>("/tenants");
        if (!cancelled) setTenants(res.data || []);
      } catch {
        // ignore
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isMainSuperAdmin]);

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{t("dashboard.refunds.title")}</h1>
        {isMainSuperAdmin && (
          <TenantSelect
            tenants={tenants}
            value={selectedTenantId}
            onChange={setSelectedTenantId}
            allLabel={t("dashboard.billing.allTenants")}
            className="w-full sm:w-64"
            testId="refunds-tenant-filter"
          />
        )}
      </div>

      {/* Filter */}
      <div className="mb-4 flex flex-wrap items-end gap-3 rounded-xl bg-white p-4 shadow-sm dark:bg-gray-800">
        <div>
          <label htmlFor="refunds-from" className="mb-1 block text-xs text-gray-500 dark:text-gray-400">{t("common.from")}</label>
          <input
            id="refunds-from"
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
          />
        </div>
        <div>
          <label htmlFor="refunds-to" className="mb-1 block text-xs text-gray-500 dark:text-gray-400">{t("common.to")}</label>
          <input
            id="refunds-to"
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className={`rounded-lg border px-3 py-2 text-sm text-gray-900 dark:text-gray-100 ${
              reversedRange
                ? "border-red-500 bg-white dark:bg-gray-900"
                : "border-gray-300 bg-white dark:border-gray-700 dark:bg-gray-900"
            }`}
            aria-invalid={reversedRange}
            aria-describedby={reversedRange ? "refunds-to-error" : undefined}
          />
          {reversedRange && (
            <p id="refunds-to-error" className="mt-1 text-xs text-red-600 dark:text-red-400">
              {t("dashboard.refunds.rangeError")}
            </p>
          )}
        </div>
        <button
          onClick={load}
          disabled={reversedRange}
          className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark disabled:cursor-not-allowed disabled:opacity-50"
        >
          {t("common.apply")}
        </button>
        <div className="ml-auto text-right">
          <p className="text-xs uppercase tracking-wider text-gray-400 dark:text-gray-500">
            {t("dashboard.refunds.totalRefundedPeriod")}
          </p>
          <p className="mt-1 text-xl font-bold text-orange-600 dark:text-orange-400">
            {fmtMoney(total)}
          </p>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            {rows.length} {t(rows.length === 1 ? "dashboard.refunds.count.singular" : "dashboard.refunds.count.plural")}
          </p>
        </div>
      </div>

      <div className="overflow-x-auto rounded-xl bg-white text-gray-900 shadow-sm dark:bg-gray-800 dark:text-gray-100">
        {loading ? (
          <div className="p-4" data-testid="refunds-loading" aria-busy="true">
            <SkeletonTable rows={5} columns={6} />
          </div>
        ) : rows.length === 0 ? (
          <div className="p-8 text-center text-gray-500 dark:text-gray-400">
            {t("dashboard.refunds.empty")}
          </div>
        ) : (
          <table className="w-full table-fixed">
            <thead>
              <tr className="border-b border-gray-200 text-left text-sm text-gray-500 dark:border-gray-700 dark:text-gray-400">
                <th className="w-36 px-4 py-3">{t("common.date")}</th>
                <th className="w-28 px-4 py-3">{t("dashboard.billing.invoiceNumber")}</th>
                <th className="w-44 px-4 py-3">{t("dashboard.billing.patient")}</th>
                <th className="w-28 px-4 py-3">{t("dashboard.billing.amount")}</th>
                <th className="w-20 px-4 py-3">{t("dashboard.refunds.mode")}</th>
                <th className="px-4 py-3">{t("common.reason")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.id}
                  className="border-b border-gray-200 last:border-0 dark:border-gray-700"
                >
                  <td className="px-4 py-3 text-sm">
                    {formatDateTime(r.paidAt)}
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
                    <p className="text-xs text-gray-500 dark:text-gray-400">
                      {r.invoice.patient.user.phone}
                    </p>
                  </td>
                  <td className="px-4 py-3 text-sm font-semibold text-orange-600 dark:text-orange-400">
                    {fmtMoney(r.amount)}
                  </td>
                  <td className="px-4 py-3 text-sm">{r.mode}</td>
                  <td className="whitespace-normal break-words px-4 py-3 text-sm text-gray-600 dark:text-gray-300">
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
