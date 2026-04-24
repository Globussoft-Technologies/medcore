"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import { ArrowLeft, Receipt, Percent } from "lucide-react";

interface PatientInvoice {
  id: string;
  invoiceNumber: string;
  totalAmount: number;
  paymentStatus: string;
  createdAt: string;
  totalPaid: number;
  balance: number;
  daysOverdue: number;
  items: Array<{ id: string; description: string; amount: number }>;
  patient: {
    id: string;
    mrNumber: string;
    user: { name: string; phone: string; email: string };
  };
}

function fmtMoney(n: number) {
  return `Rs. ${n.toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function overdueClass(days: number) {
  if (days > 30) return "text-red-600 font-semibold";
  if (days > 7) return "text-orange-500 font-medium";
  return "text-gray-500";
}

export default function PatientBillingPage() {
  const params = useParams();
  const patientId = params.patientId as string;

  const [loading, setLoading] = useState(true);
  const [invoices, setInvoices] = useState<PatientInvoice[]>([]);
  const [totalOutstanding, setTotalOutstanding] = useState(0);
  const [selected, setSelected] = useState<Record<string, boolean>>({});

  // Bulk payment modal
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkAmount, setBulkAmount] = useState("");
  const [bulkMode, setBulkMode] = useState("CASH");
  const [bulkSubmitting, setBulkSubmitting] = useState(false);

  // Bulk discount modal
  const [discOpen, setDiscOpen] = useState(false);
  const [discType, setDiscType] = useState<"percentage" | "flat">("percentage");
  const [discValue, setDiscValue] = useState("");
  const [discReason, setDiscReason] = useState("");
  const [discSubmitting, setDiscSubmitting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<{
        data: {
          totalOutstanding: number;
          invoices: PatientInvoice[];
        };
      }>(`/billing/patients/${patientId}/outstanding`);
      setInvoices(res.data.invoices);
      setTotalOutstanding(res.data.totalOutstanding);
    } catch {
      // ignore
    }
    setLoading(false);
  }, [patientId]);

  useEffect(() => {
    load();
  }, [load]);

  const selectedInvoices = useMemo(
    () => invoices.filter((i) => selected[i.id]),
    [invoices, selected]
  );

  const selectedBalance = useMemo(
    () => selectedInvoices.reduce((s, i) => s + i.balance, 0),
    [selectedInvoices]
  );

  function toggleAll(value: boolean) {
    const next: Record<string, boolean> = {};
    if (value) invoices.forEach((i) => (next[i.id] = true));
    setSelected(next);
  }

  function toggleOne(id: string) {
    setSelected((prev) => ({ ...prev, [id]: !prev[id] }));
  }

  async function submitBulkPayment() {
    const amt = parseFloat(bulkAmount);
    if (!amt || amt <= 0 || selectedInvoices.length === 0) return;
    setBulkSubmitting(true);

    // Apply oldest-first by sorting selectedInvoices by createdAt asc
    const sorted = [...selectedInvoices].sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    );

    let remaining = amt;
    const payments: Array<{
      invoiceId: string;
      amount: number;
      mode: string;
    }> = [];
    for (const inv of sorted) {
      if (remaining <= 0) break;
      const apply = Math.min(remaining, inv.balance);
      if (apply > 0) {
        payments.push({ invoiceId: inv.id, amount: apply, mode: bulkMode });
        remaining -= apply;
      }
    }

    if (payments.length === 0) {
      toast.error("Nothing to apply");
      setBulkSubmitting(false);
      return;
    }

    try {
      await api.post("/billing/payments/bulk", {
        patientId,
        payments,
      });
      setBulkOpen(false);
      setBulkAmount("");
      setSelected({});
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Bulk payment failed");
    }
    setBulkSubmitting(false);
  }

  async function submitBulkDiscount() {
    if (selectedInvoices.length === 0 || !discValue || !discReason) return;
    setDiscSubmitting(true);
    try {
      for (const inv of selectedInvoices) {
        const body: Record<string, unknown> = { reason: discReason };
        if (discType === "percentage") body.percentage = parseFloat(discValue);
        else body.flatAmount = parseFloat(discValue);
        await api.post(`/billing/invoices/${inv.id}/discount`, body);
      }
      setDiscOpen(false);
      setDiscValue("");
      setDiscReason("");
      setSelected({});
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Discount failed");
    }
    setDiscSubmitting(false);
  }

  const statusColors: Record<string, string> = {
    PENDING: "bg-red-100 text-red-700",
    PARTIAL: "bg-yellow-100 text-yellow-700",
    PAID: "bg-green-100 text-green-700",
    REFUNDED: "bg-gray-100 text-gray-500",
  };

  const patient = invoices[0]?.patient;

  return (
    <div>
      <div className="mb-4">
        <Link
          href="/dashboard/billing"
          className="flex items-center gap-2 text-sm text-gray-600 hover:text-primary"
        >
          <ArrowLeft size={16} /> Back to Billing
        </Link>
      </div>

      {loading ? (
        <div className="p-8 text-center text-gray-500">Loading...</div>
      ) : (
        <>
          {/* Patient header */}
          <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div className="rounded-xl bg-white p-5 shadow-sm sm:col-span-2">
              {patient ? (
                <>
                  <p className="text-xs uppercase tracking-wider text-gray-400">
                    Patient
                  </p>
                  <h1 className="mt-1 text-xl font-bold">{patient.user.name}</h1>
                  <p className="text-sm text-gray-500">
                    MR#: {patient.mrNumber} • {patient.user.phone}
                    {patient.user.email ? ` • ${patient.user.email}` : ""}
                  </p>
                </>
              ) : (
                <>
                  <p className="text-xs uppercase tracking-wider text-gray-400">Patient</p>
                  <h1 className="mt-1 text-xl font-bold">—</h1>
                  <p className="text-sm text-gray-500">No outstanding invoices</p>
                </>
              )}
            </div>
            <div className="rounded-xl bg-white p-5 shadow-sm">
              <p className="text-xs uppercase tracking-wider text-gray-400">
                Total Outstanding
              </p>
              <p className="mt-1 text-2xl font-bold text-red-600">
                {fmtMoney(totalOutstanding)}
              </p>
              <p className="mt-1 text-xs text-gray-500">
                {invoices.length} unpaid invoice{invoices.length === 1 ? "" : "s"}
              </p>
            </div>
          </div>

          {/* Action bar */}
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-gray-600">
              {selectedInvoices.length > 0
                ? `${selectedInvoices.length} selected • ${fmtMoney(selectedBalance)} due`
                : "Select invoices to bulk-apply a payment or discount"}
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => setDiscOpen(true)}
                disabled={selectedInvoices.length === 0}
                className="flex items-center gap-1 rounded-lg border bg-white px-3 py-1.5 text-sm hover:bg-gray-50 disabled:opacity-50"
              >
                <Percent size={14} /> Apply Discount
              </button>
              <button
                onClick={() => {
                  setBulkAmount(String(selectedBalance));
                  setBulkOpen(true);
                }}
                disabled={selectedInvoices.length === 0}
                className="flex items-center gap-1 rounded-lg bg-primary px-3 py-1.5 text-sm text-white hover:bg-primary-dark disabled:opacity-50"
              >
                <Receipt size={14} /> Record Bulk Payment
              </button>
            </div>
          </div>

          {/* Invoices */}
          <div className="rounded-xl bg-white shadow-sm">
            {invoices.length === 0 ? (
              <div className="p-8 text-center text-gray-500">
                No outstanding invoices.
              </div>
            ) : (
              <table className="w-full">
                <thead>
                  <tr className="border-b text-left text-sm text-gray-500">
                    <th className="px-4 py-3">
                      <input
                        type="checkbox"
                        checked={
                          invoices.length > 0 &&
                          invoices.every((i) => selected[i.id])
                        }
                        onChange={(e) => toggleAll(e.target.checked)}
                      />
                    </th>
                    <th className="px-4 py-3">Invoice #</th>
                    <th className="px-4 py-3">Date</th>
                    <th className="px-4 py-3">Total</th>
                    <th className="px-4 py-3">Paid</th>
                    <th className="px-4 py-3">Balance</th>
                    <th className="px-4 py-3">Overdue</th>
                    <th className="px-4 py-3">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {invoices.map((inv) => (
                    <tr key={inv.id} className="border-b last:border-0">
                      <td className="px-4 py-3">
                        <input
                          type="checkbox"
                          checked={!!selected[inv.id]}
                          onChange={() => toggleOne(inv.id)}
                        />
                      </td>
                      <td className="px-4 py-3 font-mono text-sm">
                        <Link
                          href={`/dashboard/billing/${inv.id}`}
                          className="text-primary hover:underline"
                        >
                          {inv.invoiceNumber}
                        </Link>
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-500">
                        {new Date(inv.createdAt).toLocaleDateString("en-IN")}
                      </td>
                      <td className="px-4 py-3 text-sm">
                        {fmtMoney(inv.totalAmount)}
                      </td>
                      <td className="px-4 py-3 text-sm">
                        {fmtMoney(inv.totalPaid)}
                      </td>
                      <td className="px-4 py-3 text-sm font-semibold text-red-600">
                        {fmtMoney(inv.balance)}
                      </td>
                      <td
                        className={`px-4 py-3 text-sm ${overdueClass(inv.daysOverdue)}`}
                      >
                        {inv.daysOverdue}d
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${statusColors[inv.paymentStatus] || ""}`}
                        >
                          {inv.paymentStatus}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}

      {/* Bulk payment modal */}
      {bulkOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="mx-4 w-full max-w-md rounded-xl bg-white p-6 shadow-2xl">
            <h2 className="mb-4 text-lg font-bold">Record Bulk Payment</h2>
            <p className="mb-3 text-xs text-gray-500">
              Applied oldest-first across {selectedInvoices.length} selected
              invoice{selectedInvoices.length === 1 ? "" : "s"} (max{" "}
              {fmtMoney(selectedBalance)}).
            </p>
            <div className="space-y-3">
              <div>
                <label className="mb-1 block text-xs text-gray-500">
                  Amount (Rs.)
                </label>
                <input
                  type="number"
                  min="0.01"
                  step="0.01"
                  value={bulkAmount}
                  onChange={(e) => setBulkAmount(e.target.value)}
                  className="w-full rounded-lg border px-3 py-2 text-sm"
                  autoFocus
                />
              </div>
              <div>
                <label className="mb-1 block text-xs text-gray-500">Mode</label>
                <select
                  value={bulkMode}
                  onChange={(e) => setBulkMode(e.target.value)}
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
                onClick={() => setBulkOpen(false)}
                className="rounded-lg px-4 py-2 text-sm text-gray-600 hover:bg-gray-100"
              >
                Cancel
              </button>
              <button
                onClick={submitBulkPayment}
                disabled={bulkSubmitting || !bulkAmount}
                className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark disabled:opacity-50"
              >
                {bulkSubmitting ? "Saving..." : "Apply Payment"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Bulk discount modal */}
      {discOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="mx-4 w-full max-w-md rounded-xl bg-white p-6 shadow-2xl">
            <h2 className="mb-4 text-lg font-bold">Apply Discount</h2>
            <p className="mb-3 text-xs text-gray-500">
              Applied to each of {selectedInvoices.length} selected invoice
              {selectedInvoices.length === 1 ? "" : "s"}.
            </p>
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
                <label className="mb-1 block text-xs text-gray-500">
                  {discType === "percentage" ? "Percentage (%)" : "Flat (Rs.)"}
                </label>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={discValue}
                  onChange={(e) => setDiscValue(e.target.value)}
                  className="w-full rounded-lg border px-3 py-2 text-sm"
                  autoFocus
                />
              </div>
              <div>
                <label className="mb-1 block text-xs text-gray-500">Reason</label>
                <textarea
                  value={discReason}
                  onChange={(e) => setDiscReason(e.target.value)}
                  className="w-full rounded-lg border px-3 py-2 text-sm"
                  rows={2}
                />
              </div>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={() => setDiscOpen(false)}
                className="rounded-lg px-4 py-2 text-sm text-gray-600 hover:bg-gray-100"
              >
                Cancel
              </button>
              <button
                onClick={submitBulkDiscount}
                disabled={discSubmitting || !discValue || !discReason}
                className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark disabled:opacity-50"
              >
                {discSubmitting ? "Saving..." : "Apply"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
