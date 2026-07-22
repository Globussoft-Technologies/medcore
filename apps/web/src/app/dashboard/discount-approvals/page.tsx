"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, usePathname } from "next/navigation";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import { useConfirm, usePrompt } from "@/lib/use-dialog";
import { useAuthStore } from "@/lib/store";
import { Percent } from "lucide-react";
import { SkeletonTable } from "@/components/Skeleton";
import { useTranslation } from "@/lib/i18n";

// Issue #509: page-level gate matching API authorize() in
// apps/api/src/routes/billing.ts on /discount-approvals (ADMIN, RECEPTION).
// Page previously had no gate, so NURSE / DOCTOR / PATIENT could navigate
// to /dashboard/discount-approvals and see the discount-approval queue.
const VIEW_ALLOWED = new Set(["ADMIN", "RECEPTION"]);

type Tab = "PENDING" | "APPROVED" | "REJECTED";

const DISCOUNT_APPROVAL_FALLBACKS: Record<string, string> = {
  "common.reason": "Reason",
  "common.status": "Status",
  "dashboard.billing.amount": "Amount",
  "dashboard.billing.patient": "Patient",
  "dashboard.paymentPlans.invoice": "Invoice",
  "dashboard.preauth.tab.pending": "Pending",
  "dashboard.preauth.tab.approved": "Approved",
  "dashboard.preauth.tab.rejected": "Rejected",
  "dashboard.discountApprovals.title": "Discount Approvals",
  "dashboard.discountApprovals.subtitle": "Approve or reject pending discount requests",
  "dashboard.discountApprovals.requested": "Requested",
  "dashboard.discountApprovals.empty.pending": "No pending approvals.",
  "dashboard.discountApprovals.empty.approved": "No approved approvals.",
  "dashboard.discountApprovals.empty.rejected": "No rejected approvals.",
  "dashboard.discountApprovals.restricted": "Discount approvals are restricted to Admin and Reception.",
  "dashboard.discountApprovals.approve": "Approve",
  "dashboard.discountApprovals.reject": "Reject",
  "dashboard.discountApprovals.approvePrompt": "Approve this discount?",
  "dashboard.discountApprovals.rejectPrompt": "Reject discount",
  "dashboard.discountApprovals.rejectionReason": "Rejection reason",
  "dashboard.discountApprovals.statusBadge.pending": "PENDING",
  "dashboard.discountApprovals.statusBadge.approved": "APPROVED",
  "dashboard.discountApprovals.statusBadge.rejected": "REJECTED",
};

interface ApprovalRow {
  id: string;
  amount: number;
  percentage?: number | null;
  reason: string;
  status: string;
  createdAt: string;
  rejectionReason?: string | null;
  invoice: {
    id: string;
    invoiceNumber: string;
    totalAmount: number;
    patient: {
      mrNumber: string;
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

export default function DiscountApprovalsPage() {
  const { user, isLoading } = useAuthStore();
  const router = useRouter();
  const pathname = usePathname();
  const { t: translate } = useTranslation();
  const t = useCallback(
    (key: string, fallback?: string) => {
      const resolvedFallback = fallback ?? DISCOUNT_APPROVAL_FALLBACKS[key];
      const value = translate(key, resolvedFallback);
      return value === key ? resolvedFallback ?? key : value;
    },
    [translate],
  );
  const statusBadgeLabel = useCallback(
    (status: string) => t(`dashboard.discountApprovals.statusBadge.${status.toLowerCase()}`, status),
    [t],
  );
  const confirm = useConfirm();
  const promptUser = usePrompt();
  const [tab, setTab] = useState<Tab>("PENDING");
  const [rows, setRows] = useState<ApprovalRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState<string | null>(null);

  // Issue #509: redirect non-allowed roles to /dashboard/not-authorized.
  useEffect(() => {
    if (!isLoading && user && !VIEW_ALLOWED.has(user.role)) {
      toast.error(t("dashboard.discountApprovals.restricted"));
      router.replace(
        `/dashboard/not-authorized?from=${encodeURIComponent(pathname || "/dashboard/discount-approvals")}`,
      );
    }
  }, [user, isLoading, router, pathname]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<{ data: ApprovalRow[] }>(
        `/billing/discount-approvals?status=${tab}`
      );
      setRows(res.data);
    } catch {
      // ignore
    }
    setLoading(false);
  }, [tab]);

  useEffect(() => {
    load();
  }, [load]);

  async function approve(id: string) {
    if (!(await confirm({ title: t("dashboard.discountApprovals.approvePrompt") }))) return;
    setActing(id);
    try {
      await api.post(`/billing/discount-approvals/${id}/approve`);
      await load();
    } catch (err) {
      toast.error((err as Error).message);
    }
    setActing(null);
  }

  async function reject(id: string) {
    const reason = await promptUser({
      title: t("dashboard.discountApprovals.rejectPrompt"),
      label: t("dashboard.discountApprovals.rejectionReason"),
      required: true,
      multiline: true,
    });
    if (!reason) return;
    setActing(id);
    try {
      await api.post(`/billing/discount-approvals/${id}/reject`, {
        rejectionReason: reason,
      });
      await load();
    } catch (err) {
      toast.error((err as Error).message);
    }
    setActing(null);
  }

  const tabClass = (t: Tab) =>
    `px-4 py-2 text-sm font-medium rounded-lg transition ${
      tab === t
        ? "bg-primary text-white"
        : "bg-gray-100 text-gray-600 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-200 dark:hover:bg-gray-600"
    }`;

  return (
    <div>
      <div className="mb-6">
        <h1 className="flex items-center gap-2 text-2xl font-bold">
          <Percent className="text-primary" /> {t("dashboard.discountApprovals.title")}
        </h1>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          {t("dashboard.discountApprovals.subtitle")}
        </p>
      </div>

      <div className="mb-4 flex gap-2">
        <button onClick={() => setTab("PENDING")} className={tabClass("PENDING")}>
          {t("dashboard.preauth.tab.pending")}
        </button>
        <button
          onClick={() => setTab("APPROVED")}
          className={tabClass("APPROVED")}
        >
          {t("dashboard.preauth.tab.approved")}
        </button>
        <button
          onClick={() => setTab("REJECTED")}
          className={tabClass("REJECTED")}
        >
          {t("dashboard.preauth.tab.rejected")}
        </button>
      </div>

      <div className="rounded-xl bg-white shadow-sm dark:bg-gray-800">
        {loading ? (
          <div
            data-testid="discount-approvals-loading"
            aria-busy="true"
            className="p-4"
          >
            <SkeletonTable rows={5} columns={6} />
          </div>
        ) : rows.length === 0 ? (
          <div className="p-8 text-center text-gray-500 dark:text-gray-400">
            {t(`dashboard.discountApprovals.empty.${tab.toLowerCase()}`)}
          </div>
        ) : (
          <div className="overflow-x-auto">
          <table className="w-full min-w-[760px]">
            <thead>
              <tr className="border-b text-left text-sm text-gray-500 dark:border-gray-700 dark:text-gray-400">
                <th className="px-4 py-3">{t("dashboard.discountApprovals.requested")}</th>
                <th className="px-4 py-3">{t("dashboard.paymentPlans.invoice")}</th>
                <th className="px-4 py-3">{t("dashboard.billing.patient")}</th>
                <th className="px-4 py-3">{t("dashboard.billing.amount")}</th>
                <th className="px-4 py-3">%</th>
                <th className="px-4 py-3">{t("common.reason")}</th>
                <th className="px-4 py-3">{t("common.status")}</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b last:border-0 dark:border-gray-700">
                  <td className="px-4 py-3 text-sm">
                    {new Date(r.createdAt).toLocaleString("en-IN")}
                  </td>
                  <td className="px-4 py-3">
                    <Link
                      href={`/dashboard/billing/${r.invoice.id}`}
                      className="font-mono text-sm text-primary hover:underline"
                    >
                      {r.invoice.invoiceNumber}
                    </Link>
                    <p className="text-xs text-gray-500 dark:text-gray-400">
                      {fmtMoney(r.invoice.totalAmount)}
                    </p>
                  </td>
                  <td className="px-4 py-3">
                    <p className="font-medium">
                      {r.invoice.patient.user.name}
                    </p>
                    <p className="text-xs text-gray-500 dark:text-gray-400">
                      {r.invoice.patient.mrNumber}
                    </p>
                  </td>
                  <td className="px-4 py-3 text-sm font-semibold text-orange-700 dark:text-orange-400">
                    {fmtMoney(r.amount)}
                  </td>
                  <td className="px-4 py-3 text-sm">
                    {r.percentage != null ? `${r.percentage}%` : "—"}
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-600 dark:text-gray-300">
                    {r.reason}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                        r.status === "APPROVED"
                          ? "bg-green-100 text-green-700"
                          : r.status === "REJECTED"
                            ? "bg-red-100 text-red-700"
                            : "bg-yellow-100 text-yellow-700"
                      }`}
                    >
                      {statusBadgeLabel(r.status)}
                    </span>
                    {r.rejectionReason && (
                      <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                        {r.rejectionReason}
                      </p>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {r.status === "PENDING" && (
                      <div className="flex gap-2">
                        <button
                          disabled={acting === r.id}
                          onClick={() => approve(r.id)}
                          className="rounded bg-green-500 px-3 py-1 text-xs font-medium text-white hover:bg-green-600 disabled:opacity-50"
                        >
                          {t("dashboard.discountApprovals.approve")}
                        </button>
                        <button
                          disabled={acting === r.id}
                          onClick={() => reject(r.id)}
                          className="rounded bg-red-500 px-3 py-1 text-xs font-medium text-white hover:bg-red-600 disabled:opacity-50"
                        >
                          {t("dashboard.discountApprovals.reject")}
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </div>
    </div>
  );
}
