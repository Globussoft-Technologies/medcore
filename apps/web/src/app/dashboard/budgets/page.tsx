"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { TrendingUp, TrendingDown, Plus, Edit2, Eye } from "lucide-react";
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
  // Issue #723 (2026-05-08): the per-row Edit + View Details actions were
  // dead. Edit re-uses the same form (POST upserts by category+year+month
  // server-side) but pre-populates with the row's data and locks the
  // category select. View Details renders a read-only modal with the full
  // KPI breakdown for the row.
  const [editingRow, setEditingRow] = useState<BudgetRow | null>(null);
  const [viewingRow, setViewingRow] = useState<BudgetRow | null>(null);

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
    if (!formAmount) {
      toast.warning("Enter a budget amount");
      return;
    }
    const amount = parseFloat(formAmount);
    if (Number.isNaN(amount) || amount < 0) {
      toast.warning("Amount must be a positive number");
      return;
    }
    const [y, m] = month.split("-").map((n) => parseInt(n, 10));
    try {
      await api.post("/expenses/budgets", {
        category: formCategory,
        year: y,
        month: m,
        amount,
        notes: formNotes || undefined,
      });
      // Issue #723: surface success so admins know the upsert took, and
      // close BOTH the create and edit dialog flows.
      toast.success(editingRow ? "Budget updated" : "Budget saved");
      setShowForm(false);
      setEditingRow(null);
      setFormAmount("");
      setFormNotes("");
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    }
  }

  // Issue #723: open the same form pre-populated with the row's data.
  function openEdit(row: BudgetRow) {
    setEditingRow(row);
    setFormCategory(row.category);
    setFormAmount(String(row.budget));
    setFormNotes("");
    setShowForm(true);
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
              // Issue #699 (BUG-A19) + #296: utilisation is now computed
              // ONCE on the server (round(actual/budget*100)) and consumed
              // verbatim here. variancePct is derived from the SAME field
              // so the row pill and the "Utilisation: N%" label below
              // cannot drift. Display: utilisation 110% ⇒ variance pill
              // "10% over" — always internally consistent.
              const utilisationPct = r.utilisation;
              const variancePct = utilisationPct - 100;
              return (
                <div
                  key={r.category}
                  data-testid={`budget-row-${r.category}`}
                >
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
                      {/* Issue #723: per-row Edit + View Details actions */}
                      <button
                        onClick={() => openEdit(r)}
                        data-testid={`budget-edit-${r.category}`}
                        title="Edit budget"
                        className="flex items-center gap-1 rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-700 hover:bg-gray-200"
                      >
                        <Edit2 size={11} /> Edit
                      </button>
                      <button
                        onClick={() => setViewingRow(r)}
                        data-testid={`budget-view-${r.category}`}
                        title="View details"
                        className="flex items-center gap-1 rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-700 hover:bg-gray-200"
                      >
                        <Eye size={11} /> View
                      </button>
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
                      {/* Issue #296: derive from the same formula as
                          variancePct above so the two figures cannot
                          contradict each other. */}
                      Utilisation: {utilisationPct}%
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
            <h3 className="mb-4 text-lg font-semibold">
              {editingRow ? `Edit Budget — ${editingRow.category}` : "Set Monthly Budget"}
            </h3>
            <div className="space-y-3">
              <div>
                <label htmlFor="add-budget-category" className="mb-1 block text-xs font-medium text-gray-600">
                  Category
                </label>
                <select
                  id="add-budget-category"
                  value={formCategory}
                  onChange={(e) => setFormCategory(e.target.value)}
                  // Issue #723: when editing an existing row the category
                  // is the upsert key — locking it prevents accidentally
                  // creating a new row instead of updating.
                  disabled={!!editingRow}
                  className="w-full rounded-lg border px-3 py-2 text-sm disabled:bg-gray-100 disabled:text-gray-500"
                >
                  {CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="add-budget-amount" className="mb-1 block text-xs font-medium text-gray-600">
                  Amount (Rs.)
                </label>
                <input
                  id="add-budget-amount"
                  type="number"
                  min="0"
                  step="0.01"
                  value={formAmount}
                  onChange={(e) => setFormAmount(e.target.value)}
                  className="w-full rounded-lg border px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label htmlFor="add-budget-notes" className="mb-1 block text-xs font-medium text-gray-600">
                  Notes
                </label>
                <textarea
                  id="add-budget-notes"
                  value={formNotes}
                  onChange={(e) => setFormNotes(e.target.value)}
                  rows={2}
                  className="w-full rounded-lg border px-3 py-2 text-sm"
                />
              </div>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={() => {
                  setShowForm(false);
                  setEditingRow(null);
                }}
                className="rounded-lg border px-4 py-2 text-sm text-gray-600 hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={submitBudget}
                data-testid="budget-save"
                className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark"
              >
                {editingRow ? "Update Budget" : "Save Budget"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Issue #723: View Details modal — read-only KPI breakdown for a row */}
      {viewingRow && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div
            className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl"
            data-testid="budget-view-modal"
          >
            <h3 className="mb-1 text-lg font-semibold">
              {viewingRow.category} — {month}
            </h3>
            <p className="mb-4 text-xs text-gray-500">
              Read-only snapshot of this row&apos;s allocation and spend.
            </p>
            <dl className="space-y-2 text-sm">
              <div className="flex justify-between">
                <dt className="text-gray-500">Allocated Budget</dt>
                <dd className="font-semibold">{fmtMoney(viewingRow.budget)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-gray-500">Actual Spend</dt>
                <dd className="font-semibold">{fmtMoney(viewingRow.actual)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-gray-500">Variance</dt>
                <dd
                  className={`font-semibold ${
                    viewingRow.variance > 0
                      ? "text-red-600"
                      : "text-green-600"
                  }`}
                >
                  {viewingRow.variance > 0 ? "+" : ""}
                  {fmtMoney(viewingRow.variance)}
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-gray-500">Utilisation</dt>
                {/* Issue #699: read the server-computed canonical
                    utilisation field so the modal always agrees with
                    the row pill and chart label above. */}
                <dd className="font-semibold">{viewingRow.utilisation}%</dd>
              </div>
            </dl>
            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={() => setViewingRow(null)}
                className="rounded-lg border px-4 py-2 text-sm text-gray-600 hover:bg-gray-50"
              >
                Close
              </button>
              <button
                onClick={() => {
                  const r = viewingRow;
                  setViewingRow(null);
                  openEdit(r);
                }}
                className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark"
              >
                Edit Budget
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
