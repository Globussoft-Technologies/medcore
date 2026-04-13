"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { useAuthStore } from "@/lib/store";
import { DollarSign, Receipt, AlertCircle, TrendingUp } from "lucide-react";

interface DailyReport {
  totalCollection: number;
  transactionCount: number;
  pendingInvoices: number;
  paymentModeBreakdown: Record<string, number>;
  recentPayments: Array<{
    id: string;
    amount: number;
    mode: string;
    paidAt: string;
    patient: { user: { name: string } };
  }>;
}

const MODE_COLORS: Record<string, string> = {
  CASH: "bg-green-500",
  CARD: "bg-blue-500",
  UPI: "bg-purple-500",
  ONLINE: "bg-amber-500",
};

const MODE_BG_LIGHT: Record<string, string> = {
  CASH: "bg-green-100 text-green-700",
  CARD: "bg-blue-100 text-blue-700",
  UPI: "bg-purple-100 text-purple-700",
  ONLINE: "bg-amber-100 text-amber-700",
};

export default function ReportsPage() {
  const { user } = useAuthStore();
  const router = useRouter();
  const [date, setDate] = useState(() => new Date().toISOString().split("T")[0]);
  const [report, setReport] = useState<DailyReport | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (user && user.role !== "ADMIN" && user.role !== "RECEPTION") {
      router.push("/dashboard");
      return;
    }
  }, [user, router]);

  useEffect(() => {
    loadReport();
  }, [date]);

  async function loadReport() {
    setLoading(true);
    try {
      const res = await api.get<{ data: DailyReport }>(
        `/billing/reports/daily?date=${date}`
      );
      setReport(res.data);
    } catch {
      // If the endpoint doesn't exist yet, show empty state
      setReport({
        totalCollection: 0,
        transactionCount: 0,
        pendingInvoices: 0,
        paymentModeBreakdown: {},
        recentPayments: [],
      });
    }
    setLoading(false);
  }

  if (user && user.role !== "ADMIN" && user.role !== "RECEPTION") return null;

  const maxModeAmount = report
    ? Math.max(...Object.values(report.paymentModeBreakdown), 1)
    : 1;

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Billing Reports</h1>
          <p className="text-sm text-gray-500">Daily collection summary</p>
        </div>
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="rounded-lg border px-4 py-2 text-sm"
        />
      </div>

      {loading ? (
        <div className="p-8 text-center text-gray-500">Loading...</div>
      ) : report ? (
        <>
          {/* Summary Cards */}
          <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-4">
            <div className="rounded-xl bg-white p-5 shadow-sm">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-green-100">
                  <DollarSign size={20} className="text-green-600" />
                </div>
                <div>
                  <p className="text-sm text-gray-500">Total Collection</p>
                  <p className="text-xl font-bold">
                    Rs. {report.totalCollection.toFixed(2)}
                  </p>
                </div>
              </div>
            </div>

            <div className="rounded-xl bg-white p-5 shadow-sm">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-blue-100">
                  <Receipt size={20} className="text-blue-600" />
                </div>
                <div>
                  <p className="text-sm text-gray-500">Transactions</p>
                  <p className="text-xl font-bold">{report.transactionCount}</p>
                </div>
              </div>
            </div>

            <div className="rounded-xl bg-white p-5 shadow-sm">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-amber-100">
                  <AlertCircle size={20} className="text-amber-600" />
                </div>
                <div>
                  <p className="text-sm text-gray-500">Pending Invoices</p>
                  <p className="text-xl font-bold">{report.pendingInvoices}</p>
                </div>
              </div>
            </div>

            <div className="rounded-xl bg-white p-5 shadow-sm">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-purple-100">
                  <TrendingUp size={20} className="text-purple-600" />
                </div>
                <div>
                  <p className="text-sm text-gray-500">Avg Transaction</p>
                  <p className="text-xl font-bold">
                    Rs.{" "}
                    {report.transactionCount > 0
                      ? (
                          report.totalCollection / report.transactionCount
                        ).toFixed(2)
                      : "0.00"}
                  </p>
                </div>
              </div>
            </div>
          </div>

          {/* Payment Mode Breakdown */}
          <div className="mb-6 rounded-xl bg-white p-6 shadow-sm">
            <h2 className="mb-4 font-semibold">Payment Mode Breakdown</h2>
            {Object.keys(report.paymentModeBreakdown).length === 0 ? (
              <p className="text-sm text-gray-400">No payments recorded</p>
            ) : (
              <div className="space-y-3">
                {Object.entries(report.paymentModeBreakdown).map(
                  ([mode, amount]) => (
                    <div key={mode}>
                      <div className="mb-1 flex items-center justify-between text-sm">
                        <span className="font-medium">{mode}</span>
                        <span className="text-gray-600">
                          Rs. {amount.toFixed(2)}
                        </span>
                      </div>
                      <div className="h-3 w-full overflow-hidden rounded-full bg-gray-100">
                        <div
                          className={`h-full rounded-full transition-all ${MODE_COLORS[mode] || "bg-gray-400"}`}
                          style={{
                            width: `${(amount / maxModeAmount) * 100}%`,
                          }}
                        />
                      </div>
                    </div>
                  )
                )}
              </div>
            )}
          </div>

          {/* Recent Payments */}
          <div className="rounded-xl bg-white shadow-sm">
            <div className="border-b px-6 py-4">
              <h2 className="font-semibold">Recent Payments</h2>
            </div>
            {report.recentPayments.length === 0 ? (
              <div className="p-8 text-center text-gray-400">
                No payments for this date
              </div>
            ) : (
              <table className="w-full">
                <thead>
                  <tr className="border-b text-left text-sm text-gray-500">
                    <th className="px-4 py-3">Patient</th>
                    <th className="px-4 py-3">Amount</th>
                    <th className="px-4 py-3">Mode</th>
                    <th className="px-4 py-3">Time</th>
                  </tr>
                </thead>
                <tbody>
                  {report.recentPayments.map((p) => (
                    <tr key={p.id} className="border-b last:border-0">
                      <td className="px-4 py-3 font-medium">
                        {p.patient?.user?.name || "---"}
                      </td>
                      <td className="px-4 py-3 text-sm font-medium">
                        Rs. {p.amount.toFixed(2)}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${MODE_BG_LIGHT[p.mode] || "bg-gray-100 text-gray-600"}`}
                        >
                          {p.mode}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-500">
                        {new Date(p.paidAt).toLocaleTimeString("en-IN", {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      ) : null}
    </div>
  );
}
