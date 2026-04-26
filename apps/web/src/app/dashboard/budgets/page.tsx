"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { TrendingUp, TrendingDown, Plus } from "lucide-react";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import { useAuthStore } from "@/lib/store";

interface BudgetRow {
  category: string;
  budget: number;
  actual: number;
  variance: number;
  utilisation: number;
}

interface BudgetsResp {
  year: number;
  month: number;
  rows: BudgetRow[];
  // Issue #76 (Apr 2026): server now returns the FULL month spend (including
  // categories without a budget set) plus a budgeted-only variance so the
  // KPI doesn't silently hide uncategorised spend.
  totalBudget?: number;
  totalSpent?: number;
  totalVarianceBudgetedOnly?: number;
  uncategorizedActual: Array<{ category: string; actual: number }>;
}

const CATEGORIES = [
  "SALARY",
  "UTILITIES",
  "EQUIPMENT",
  "MAINTENANCE",
  "CONSUMABLES",
  "RENT",
  "MARKETING",
  "OTHER",
];

function fmtMoney(n: number) {
  return `Rs. ${n.toLocaleString("en-IN", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  })}`;
}

function currentMonthStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export default function BudgetsPage() {
  const { user } = useAuthStore();
  const router = useRouter();
  const [month, setMonth] = useState(currentMonthStr());
  const [data, setData] = useState<BudgetsResp | null>(null);
  const [loading, setLoading] = useState(true);

  const [showForm, setShowForm] = useState(false);
  const [formCategory, setFormCategory] = useState("SALARY");
  const [formAmount, setFormAmount] = useState("");
  const [formNotes, setFormNotes] = useState("");

  useEffect(() => {
    if (user && user.role !== "ADMIN") {
      router.push("/dashboard");
    }
  }, [user, router]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [y, m] = month.split("-").map((n) => parseInt(n, 10));
      const res = await api.get<{ data: BudgetsResp }>(
        `/expenses/budgets?year=${y}&month=${m}`
      );
      setData(res.data);
    } catch {
      setData(null);
    }
    setLoading(false);
  }, [month]);

  useEffect(() => {
    if (user?.role === "ADMIN") load();
  }, [load, user]);

  async function submitBudget() {
    if (!formAmount) return;
    const [y, m] = month.split("-").map((n) => parseInt(n, 10));
    try {
      await api.post("/expenses/budgets", {
        category: formCategory,
        year: y,
        month: m,
        amount: parseFloat(formAmount),
        notes: formNotes || undefined,
      });
      setShowForm(false);
      setFormAmount("");
      setFormNotes("");
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    }
  }

  if (user && user.role !== "ADMIN") return null;

  const rows = data?.rows || [];
  const maxValue = Math.max(
    1,
    ...rows.flatMap((r) => [r.budget, r.actual])
  );

  // Issue #76: prefer server-side totals (which include uncategorised spend)
  // and fall back to the local roll-up for older API builds.
  const totalBudget =
    data?.totalBudget ?? rows.reduce((s, r) => s + r.budget, 0);
  const totalBudgetedActual = rows.reduce((s, r) => s + r.actual, 0);
  const totalActual = data?.totalSpent ?? totalBudgetedActual;
  // Variance is reported against budgeted-only spend so a missing budget
  // doesn't artificially inflate the overrun. The KPI copy below makes that
  // distinction explicit.
  const totalVariance =
    data?.totalVarianceBudgetedOnly ?? totalBudgetedActual - totalBudget;
  const uncategorisedTotal = (data?.uncategorizedActual || []).reduce(
    (s, u) => s + u.actual,
    0
  );

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">Budgets</h1>
        <div className="flex items-center gap-2">
          <input
            type="month"
            value={month}
            onChange={(e) => setMonth(e.target.value)}
            className="rounded-lg border bg-white px-3 py-2 text-sm"
          />
          <button
            onClick={() => setShowForm(true)}
            className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark"
          >
            <Plus size={16} /> Set Budget
          </button>
        </div>
      </div>

      {/* Summary */}
      <div className="mb-6 grid grid-cols-1 gap-4 md:grid-cols-3">
        <div className="rounded-xl bg-white p-5 shadow-sm">
          <p className="text-xs text-gray-500">Total Budget</p>
          <p className="text-2xl font-bold">{fmtMoney(totalBudget)}</p>
        </div>
        <div className="rounded-xl bg-white p-5 shadow-sm">
          <p className="text-xs text-gray-500">Total Spent</p>
          <p
            className="text-2xl font-bold text-blue-600"
            data-testid="kpi-total-spent"
          >
            {fmtMoney(totalActual)}
          </p>
          {/* Issue #76: surface uncategorised spend in the KPI subtitle so
              users know why Total Spent ≠ sum(budgeted actual). */}
          {uncategorisedTotal > 0 && (
            <p className="mt-1 text-xs text-gray-500">
              Includes {fmtMoney(uncategorisedTotal)} in categories without a
              budget set
            </p>
          )}
        </div>
        <div className="rounded-xl bg-white p-5 shadow-sm">
          <p className="text-xs text-gray-500">Variance</p>
          <p
            className={`flex items-center gap-2 text-2xl font-bold ${
              totalVariance > 0 ? "text-red-600" : "text-green-600"
            }`}
            data-testid="kpi-variance"
          >
            {totalVariance > 0 ? (
              <TrendingUp size={20} />
            ) : (
              <TrendingDown size={20} />
            )}
            {fmtMoney(Math.abs(totalVariance))}
          </p>
          {/* Issue #76: clarify that Variance compares against budgeted-only
              spend — Total Spent above is the full picture. */}
          <p className="mt-1 text-xs text-gray-500">
            Variance vs budgeted only — see Total Spent for full picture.
          </p>
        </div>
      </div>

      {/* Chart */}
      <div className="mb-6 rounded-xl bg-white p-5 shadow-sm">
        <h3 className="mb-4 font-semibold">Budget vs Actual by Category</h3>
        {loading ? (
          <div className="p-8 text-center text-gray-500">Loading...</div>
        ) : rows.length === 0 ? (
          <p className="py-6 text-center text-sm text-gray-500">
            No budgets set for this month. Click &ldquo;Set Budget&rdquo; to start.
          </p>
        ) : (
          <div className="space-y-4">
            {rows.map((r) => {
              const budgetPct = (r.budget / maxValue) * 100;
              const actualPct = (r.actual / maxValue) * 100;
              const overBudget = r.variance > 0;
              const variancePct =
                r.budget > 0
                  ? Math.round((r.variance / r.budget) * 100)
                  : 0;
              return (
                <div key={r.category} className="">
                  <div className="mb-1 flex items-center justify-between text-sm">
                    <span className="font-medium">{r.category}</span>
                    <div className="flex items-center gap-2 text-xs">
                      <span className="text-gray-500">
                        {fmtMoney(r.actual)} / {fmtMoney(r.budget)}
                      </span>
                      <span
                        className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${
                          overBudget
                            ? "bg-red-100 text-red-700"
                            : "bg-green-100 text-green-700"
                        }`}
                      >
                        {overBudget ? (
                          <TrendingUp size={12} />
                        ) : (
                          <TrendingDown size={12} />
                        )}
                        {Math.abs(variancePct)}%
                      </span>
                    </div>
                  </div>
                  <svg className="w-full" height="40" viewBox="0 0 100 40" preserveAspectRatio="none">
                    {/* Budget bar */}
                    <rect
                      x="0"
                      y="4"
                      width={budgetPct}
                      height="14"
                      className="fill-blue-300"
                    />
                    {/* Actual bar */}
                    <rect
                      x="0"
                      y="22"
                      width={actualPct}
                      height="14"
                      className={
                        overBudget ? "fill-red-500" : "fill-green-500"
                      }
                    />
                  </svg>
                  <div className="flex gap-4 text-xs text-gray-500">
                    <span className="flex items-center gap-1">
                      <span className="h-2 w-2 bg-blue-300" /> Budget
                    </span>
                    <span className="flex items-center gap-1">
                      <span
                        className={`h-2 w-2 ${overBudget ? "bg-red-500" : "bg-green-500"}`}
                      />{" "}
                      Actual
                    </span>
                    <span className="ml-auto">
                      Utilisation: {r.utilisation}%
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Uncategorized */}
      {data && data.uncategorizedActual.length > 0 && (
        <div className="mb-6 rounded-xl bg-yellow-50 p-4 text-sm shadow-sm">
          <p className="mb-2 font-semibold text-yellow-800">
            Spending without budgets set
          </p>
          <div className="space-y-1">
            {data.uncategorizedActual.map((u) => (
              <div
                key={u.category}
                className="flex justify-between text-xs text-yellow-900"
              >
                <span>{u.category}</span>
                <span className="font-semibold">{fmtMoney(u.actual)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {showForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl">
            <h3 className="mb-4 text-lg font-semibold">Set Monthly Budget</h3>
            <div className="space-y-3">
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-600">
                  Category
                </label>
                <select
                  value={formCategory}
                  onChange={(e) => setFormCategory(e.target.value)}
                  className="w-full rounded-lg border px-3 py-2 text-sm"
                >
                  {CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-600">
                  Amount (Rs.)
                </label>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={formAmount}
                  onChange={(e) => setFormAmount(e.target.value)}
                  className="w-full rounded-lg border px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-600">
                  Notes
                </label>
                <textarea
                  value={formNotes}
                  onChange={(e) => setFormNotes(e.target.value)}
                  rows={2}
                  className="w-full rounded-lg border px-3 py-2 text-sm"
                />
              </div>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={() => setShowForm(false)}
                className="rounded-lg border px-4 py-2 text-sm text-gray-600 hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={submitBudget}
                className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark"
              >
                Save Budget
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
