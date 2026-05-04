"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, usePathname } from "next/navigation";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import { useConfirm, usePrompt } from "@/lib/use-dialog";
import { useAuthStore } from "@/lib/store";
import { Percent } from "lucide-react";

// Issue #509: page-level gate matching API authorize() in
// apps/api/src/routes/billing.ts on /discount-approvals (ADMIN, RECEPTION).
// Page previously had no gate, so NURSE / DOCTOR / PATIENT could navigate
// to /dashboard/discount-approvals and see the discount-approval queue.
const VIEW_ALLOWED = new Set(["ADMIN", "RECEPTION"]);

type Tab = "PENDING" | "APPROVED" | "REJECTED";

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
  const confirm = useConfirm();
  const promptUser = usePrompt();
  const [tab, setTab] = useState<Tab>("PENDING");
  const [rows, setRows] = useState<ApprovalRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState<string | null>(null);

  // Issue #509: redirect non-allowed roles to /dashboard/not-authorized.
  useEffect(() => {
    if (!isLoading && user && !VIEW_ALLOWED.has(user.role)) {
      toast.error("Discount approvals are restricted to Admin and Reception.");
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
    if (!(await confirm({ title: "Approve this discount?" }))) return;
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
      title: "Reject discount",
      label: "Rejection reason",
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
        : "bg-gray-100 text-gray-600 hover:bg-gray-200"
    }`;

  return (
    <div>
      <div className="mb-6">
        <h1 className="flex items-center gap-2 text-2xl font-bold">
          <Percent className="text-primary" /> Discount Approvals
        </h1>
        <p className="text-sm text-gray-500">
          Approve or reject pending discount requests
        </p>
      </div>

      <div className="mb-4 flex gap-2">
        <button onClick={() => setTab("PENDING")} className={tabClass("PENDING")}>
          Pending
        </button>
        <button
          onClick={() => setTab("APPROVED")}
          className={tabClass("APPROVED")}
        >
          Approved
        </button>
        <button
          onClick={() => setTab("REJECTED")}
          className={tabClass("REJECTED")}
        >
          Rejected
        </button>
      </div>

      <div className="rounded-xl bg-white shadow-sm">
        {loading ? (
          <div className="p-8 text-center text-gray-500">Loading...</div>
        ) : rows.length === 0 ? (
          <div className="p-8 text-center text-gray-500">
            No {tab.toLowerCase()} approvals.
          </div>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="border-b text-left text-sm text-gray-500">
                <th className="px-4 py-3">Requested</th>
                <th className="px-4 py-3">Invoice</th>
                <th className="px-4 py-3">Patient</th>
                <th className="px-4 py-3">Amount</th>
                <th className="px-4 py-3">%</th>
                <th className="px-4 py-3">Reason</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b last:border-0">
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
                    <p className="text-xs text-gray-500">
                      {fmtMoney(r.invoice.totalAmount)}
                    </p>
                  </td>
                  <td className="px-4 py-3">
                    <p className="font-medium">
                      {r.invoice.patient.user.name}
                    </p>
                    <p className="text-xs text-gray-500">
                      {r.invoice.patient.mrNumber}
                    </p>
                  </td>
                  <td className="px-4 py-3 text-sm font-semibold text-orange-700">
                    {fmtMoney(r.amount)}
                  </td>
                  <td className="px-4 py-3 text-sm">
                    {r.percentage != null ? `${r.percentage}%` : "—"}
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-600">
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
                      {r.status}
                    </span>
                    {r.rejectionReason && (
                      <p className="mt-1 text-xs text-gray-500">
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
                          Approve
                        </button>
                        <button
                          disabled={acting === r.id}
                          onClick={() => reject(r.id)}
                          className="rounded bg-red-500 px-3 py-1 text-xs font-medium text-white hover:bg-red-600 disabled:opacity-50"
                        >
                          Reject
                        </button>
                      </div>
                    )}
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
