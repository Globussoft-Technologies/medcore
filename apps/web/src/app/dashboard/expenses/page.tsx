"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useAuthStore } from "@/lib/store";
import { Wallet, Plus, X } from "lucide-react";

interface ExpenseRecord {
  id: string;
  category: string;
  amount: number;
  description: string;
  date: string;
  paidTo?: string | null;
  referenceNo?: string | null;
  user: { id: string; name: string; role: string };
}

interface Summary {
  grandTotal: number;
  transactionCount: number;
  byCategory: Array<{ category: string; count: number; total: number }>;
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
] as const;

const CATEGORY_COLORS: Record<string, string> = {
  SALARY: "bg-purple-100 text-purple-700",
  UTILITIES: "bg-blue-100 text-blue-700",
  EQUIPMENT: "bg-indigo-100 text-indigo-700",
  MAINTENANCE: "bg-orange-100 text-orange-700",
  CONSUMABLES: "bg-pink-100 text-pink-700",
  RENT: "bg-green-100 text-green-700",
  MARKETING: "bg-yellow-100 text-yellow-700",
  OTHER: "bg-gray-100 text-gray-700",
};

const BAR_COLORS: Record<string, string> = {
  SALARY: "bg-purple-500",
  UTILITIES: "bg-blue-500",
  EQUIPMENT: "bg-indigo-500",
  MAINTENANCE: "bg-orange-500",
  CONSUMABLES: "bg-pink-500",
  RENT: "bg-green-500",
  MARKETING: "bg-yellow-500",
  OTHER: "bg-gray-500",
};

function firstOfMonth() {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1).toISOString().split("T")[0];
}
function today() {
  return new Date().toISOString().split("T")[0];
}

export default function ExpensesPage() {
  const { user } = useAuthStore();
  const [expenses, setExpenses] = useState<ExpenseRecord[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [from, setFrom] = useState(firstOfMonth());
  const [to, setTo] = useState(today());
  const [categoryFilter, setCategoryFilter] = useState("");
  const [showAdd, setShowAdd] = useState(false);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, to, categoryFilter]);

  async function load() {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (from) params.set("from", from);
      if (to) params.set("to", to);
      if (categoryFilter) params.set("category", categoryFilter);
      const [ex, sum] = await Promise.all([
        api.get<{ data: ExpenseRecord[] }>(`/expenses?${params.toString()}`),
        api.get<{ data: Summary }>(
          `/expenses/summary?${new URLSearchParams({ from, to }).toString()}`
        ),
      ]);
      setExpenses(ex.data);
      setSummary(sum.data);
    } catch {
      setExpenses([]);
      setSummary(null);
    }
    setLoading(false);
  }

  async function handleDelete(id: string) {
    if (!confirm("Delete this expense?")) return;
    try {
      await api.delete(`/expenses/${id}`);
      load();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Delete failed");
    }
  }

  const canAdd = user?.role === "ADMIN" || user?.role === "RECEPTION";
  const canDelete = user?.role === "ADMIN";
  const maxCategoryTotal = Math.max(
    1,
    ...(summary?.byCategory.map((c) => c.total) || [1])
  );

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold">
            <Wallet className="text-primary" size={28} /> Expenses
          </h1>
          <p className="text-sm text-gray-500">Track operational spending</p>
        </div>
        {canAdd && (
          <button
            onClick={() => setShowAdd(true)}
            className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark"
          >
            <Plus size={16} /> Add Expense
          </button>
        )}
      </div>

      <div className="mb-6 grid gap-4 md:grid-cols-3">
        <div className="rounded-xl bg-white p-5 shadow-sm">
          <p className="text-sm text-gray-500">Total (selected range)</p>
          <p className="mt-2 text-3xl font-bold">
            Rs. {summary?.grandTotal.toFixed(2) || "0.00"}
          </p>
          <p className="mt-1 text-xs text-gray-500">
            {summary?.transactionCount || 0} transactions
          </p>
        </div>
        <div className="rounded-xl bg-white p-5 shadow-sm md:col-span-2">
          <p className="mb-3 text-sm font-semibold text-gray-700">
            Breakdown by Category
          </p>
          {!summary || summary.byCategory.length === 0 ? (
            <p className="text-sm text-gray-500">No data</p>
          ) : (
            <div className="space-y-2">
              {summary.byCategory.map((c) => (
                <div key={c.category}>
                  <div className="mb-0.5 flex justify-between text-xs">
                    <span className="font-medium">{c.category}</span>
                    <span className="text-gray-500">
                      Rs. {c.total.toFixed(2)} ({c.count})
                    </span>
                  </div>
                  <div className="h-2 rounded-full bg-gray-100">
                    <div
                      className={`h-2 rounded-full ${BAR_COLORS[c.category] || "bg-gray-500"}`}
                      style={{
                        width: `${(c.total / maxCategoryTotal) * 100}%`,
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="mb-4 flex flex-wrap gap-3">
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
            className="rounded-lg border px-3 py-2 text-sm"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs text-gray-500">Category</label>
          <select
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value)}
            className="rounded-lg border px-3 py-2 text-sm"
          >
            <option value="">All</option>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="rounded-xl bg-white shadow-sm">
        {loading ? (
          <div className="p-8 text-center text-gray-500">Loading...</div>
        ) : expenses.length === 0 ? (
          <div className="p-8 text-center text-gray-500">No expenses found</div>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="border-b text-left text-sm text-gray-500">
                <th className="px-4 py-3">Date</th>
                <th className="px-4 py-3">Category</th>
                <th className="px-4 py-3">Description</th>
                <th className="px-4 py-3">Paid To</th>
                <th className="px-4 py-3">Reference</th>
                <th className="px-4 py-3">Amount</th>
                <th className="px-4 py-3">Recorded By</th>
                {canDelete && <th className="px-4 py-3"></th>}
              </tr>
            </thead>
            <tbody>
              {expenses.map((e) => (
                <tr key={e.id} className="border-b last:border-0">
                  <td className="px-4 py-3 text-sm">
                    {new Date(e.date).toLocaleDateString("en-IN")}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-medium ${CATEGORY_COLORS[e.category] || ""}`}
                    >
                      {e.category}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-sm">{e.description}</td>
                  <td className="px-4 py-3 text-sm text-gray-600">
                    {e.paidTo || "-"}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-gray-500">
                    {e.referenceNo || "-"}
                  </td>
                  <td className="px-4 py-3 font-medium">
                    Rs. {e.amount.toFixed(2)}
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-600">
                    {e.user?.name || "-"}
                  </td>
                  {canDelete && (
                    <td className="px-4 py-3">
                      <button
                        onClick={() => handleDelete(e.id)}
                        className="text-xs text-red-500 hover:text-red-700"
                      >
                        Delete
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {showAdd && (
        <AddExpenseModal
          onClose={() => setShowAdd(false)}
          onSaved={() => {
            setShowAdd(false);
            load();
          }}
        />
      )}
    </div>
  );
}

function AddExpenseModal({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState({
    category: "OTHER",
    amount: "",
    description: "",
    date: today(),
    paidTo: "",
    referenceNo: "",
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        category: form.category,
        amount: parseFloat(form.amount),
        description: form.description,
        date: form.date,
      };
      if (form.paidTo) body.paidTo = form.paidTo;
      if (form.referenceNo) body.referenceNo = form.referenceNo;
      await api.post("/expenses", body);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save expense");
    }
    setSaving(false);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-2xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-bold">Add Expense</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X size={20} />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label className="mb-1 block text-sm font-medium">Category *</label>
            <div className="grid grid-cols-4 gap-2">
              {CATEGORIES.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setForm({ ...form, category: c })}
                  className={`rounded-lg border px-2 py-1.5 text-xs font-medium transition ${
                    form.category === c
                      ? `${CATEGORY_COLORS[c]} border-current`
                      : "border-gray-200 text-gray-500 hover:bg-gray-50"
                  }`}
                >
                  {c}
                </button>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-sm font-medium">Amount *</label>
              <input
                required
                type="number"
                min="0.01"
                step="0.01"
                value={form.amount}
                onChange={(e) => setForm({ ...form, amount: e.target.value })}
                className="w-full rounded-lg border px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium">Date *</label>
              <input
                required
                type="date"
                value={form.date}
                onChange={(e) => setForm({ ...form, date: e.target.value })}
                className="w-full rounded-lg border px-3 py-2 text-sm"
              />
            </div>
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium">Description *</label>
            <input
              required
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              className="w-full rounded-lg border px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium">Paid To</label>
            <input
              value={form.paidTo}
              onChange={(e) => setForm({ ...form, paidTo: e.target.value })}
              className="w-full rounded-lg border px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium">Reference No</label>
            <input
              value={form.referenceNo}
              onChange={(e) => setForm({ ...form, referenceNo: e.target.value })}
              className="w-full rounded-lg border px-3 py-2 font-mono text-sm"
            />
          </div>
          {error && (
            <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">
              {error}
            </div>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg px-4 py-2 text-sm text-gray-600 hover:bg-gray-100"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark disabled:opacity-50"
            >
              {saving ? "Saving..." : "Add Expense"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
