"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import { useAuthStore } from "@/lib/store";
import { CreditCard, Plus, X } from "lucide-react";
import { EntityPicker } from "@/components/EntityPicker";

type Tab = "ACTIVE" | "OVERDUE" | "COMPLETED" | "ALL";

interface InstallmentRec {
  id: string;
  dueDate: string;
  amount: number;
  status: string;
  paidAt?: string | null;
}

interface PlanRow {
  id: string;
  planNumber: string;
  totalAmount: number;
  downPayment: number;
  installments: number;
  installmentAmount: number;
  frequency: string;
  startDate: string;
  status: string;
  paidCount?: number;
  nextDue?: string | null;
  invoice: { id: string; invoiceNumber: string; totalAmount: number };
  patient: {
    id: string;
    mrNumber: string;
    user: { name: string; phone: string };
  };
  installmentRecords: InstallmentRec[];
}

interface OverdueRow {
  id: string;
  dueDate: string;
  amount: number;
  status: string;
  plan: {
    id: string;
    planNumber: string;
    patient: {
      mrNumber: string;
      user: { name: string; phone: string };
    };
    invoice: { id: string; invoiceNumber: string };
  };
}

function fmtMoney(n: number) {
  return `Rs. ${n.toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export default function PaymentPlansPage() {
  const { user } = useAuthStore();
  const [tab, setTab] = useState<Tab>("ACTIVE");
  const [plans, setPlans] = useState<PlanRow[]>([]);
  const [overdue, setOverdue] = useState<OverdueRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [detailId, setDetailId] = useState<string | null>(null);
  // Issue #60 (Apr 2026): Plans list was read-only — wire a "+ New Plan"
  // modal so reception/admin can create plans without dropping into the
  // billing detail view. The modal is gated to ADMIN + RECEPTION (matches
  // the API authorize() rule on POST /payment-plans).
  const [showCreate, setShowCreate] = useState(false);
  const canCreate = user?.role === "ADMIN" || user?.role === "RECEPTION";

  const load = useCallback(async () => {
    setLoading(true);
    try {
      if (tab === "OVERDUE") {
        const res = await api.get<{ data: OverdueRow[] }>(
          "/payment-plans/overdue"
        );
        setOverdue(res.data);
      } else {
        const params = new URLSearchParams();
        if (tab !== "ALL") params.set("status", tab);
        const res = await api.get<{ data: PlanRow[] }>(
          `/payment-plans?${params.toString()}`
        );
        setPlans(res.data);
      }
    } catch {
      // empty
    }
    setLoading(false);
  }, [tab]);

  useEffect(() => {
    load();
  }, [load]);

  const tabClass = (t: Tab) =>
    `px-4 py-2 text-sm font-medium rounded-lg transition ${
      tab === t
        ? "bg-primary text-white"
        : "bg-gray-100 text-gray-600 hover:bg-gray-200"
    }`;

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold">
            <CreditCard className="text-primary" /> Payment Plans
          </h1>
          <p className="text-sm text-gray-500">
            Installment / EMI plans for outstanding invoices
          </p>
        </div>
        {canCreate && (
          <button
            type="button"
            data-testid="open-new-plan"
            onClick={() => setShowCreate(true)}
            className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark"
          >
            <Plus size={16} /> New Plan
          </button>
        )}
      </div>

      <div className="mb-4 flex flex-wrap gap-2">
        <button onClick={() => setTab("ACTIVE")} className={tabClass("ACTIVE")}>
          Active
        </button>
        <button onClick={() => setTab("OVERDUE")} className={tabClass("OVERDUE")}>
          Overdue
        </button>
        <button
          onClick={() => setTab("COMPLETED")}
          className={tabClass("COMPLETED")}
        >
          Completed
        </button>
        <button onClick={() => setTab("ALL")} className={tabClass("ALL")}>
          All
        </button>
      </div>

      <div className="rounded-xl bg-white shadow-sm">
        {loading ? (
          <div className="p-8 text-center text-gray-500">Loading...</div>
        ) : tab === "OVERDUE" ? (
          overdue.length === 0 ? (
            <div className="p-8 text-center text-gray-500">
              No overdue installments.
            </div>
          ) : (
            <table className="w-full">
              <thead>
                <tr className="border-b text-left text-sm text-gray-500">
                  <th className="px-4 py-3">Plan #</th>
                  <th className="px-4 py-3">Patient</th>
                  <th className="px-4 py-3">Invoice</th>
                  <th className="px-4 py-3">Due Date</th>
                  <th className="px-4 py-3">Amount</th>
                  <th className="px-4 py-3">Status</th>
                </tr>
              </thead>
              <tbody>
                {overdue.map((r) => (
                  <tr
                    key={r.id}
                    className="cursor-pointer border-b last:border-0 hover:bg-gray-50"
                    onClick={() => setDetailId(r.plan.id)}
                  >
                    <td className="px-4 py-3 font-mono text-sm">
                      {r.plan.planNumber}
                    </td>
                    <td className="px-4 py-3">
                      <p className="font-medium">{r.plan.patient.user.name}</p>
                      <p className="text-xs text-gray-500">
                        {r.plan.patient.user.phone}
                      </p>
                    </td>
                    <td className="px-4 py-3 text-sm">
                      {r.plan.invoice.invoiceNumber}
                    </td>
                    <td className="px-4 py-3 text-sm text-red-600">
                      {new Date(r.dueDate).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-3 text-sm font-semibold">
                      {fmtMoney(r.amount)}
                    </td>
                    <td className="px-4 py-3">
                      <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700">
                        OVERDUE
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        ) : plans.length === 0 ? (
          <div className="p-8 text-center text-gray-500">
            No plans in this category.
          </div>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="border-b text-left text-sm text-gray-500">
                <th className="px-4 py-3">Plan #</th>
                <th className="px-4 py-3">Patient</th>
                <th className="px-4 py-3">Invoice</th>
                <th className="px-4 py-3">Total</th>
                <th className="px-4 py-3">Progress</th>
                <th className="px-4 py-3">Next Due</th>
                <th className="px-4 py-3">Status</th>
              </tr>
            </thead>
            <tbody>
              {plans.map((p) => {
                const paid = p.paidCount ?? 0;
                const pct = p.installments
                  ? (paid / p.installments) * 100
                  : 0;
                return (
                  <tr
                    key={p.id}
                    className="cursor-pointer border-b last:border-0 hover:bg-gray-50"
                    onClick={() => setDetailId(p.id)}
                  >
                    <td className="px-4 py-3 font-mono text-sm">
                      {p.planNumber}
                    </td>
                    <td className="px-4 py-3">
                      <p className="font-medium">{p.patient.user.name}</p>
                      <p className="text-xs text-gray-500">
                        {p.patient.mrNumber}
                      </p>
                    </td>
                    <td className="px-4 py-3 text-sm">
                      <Link
                        href={`/dashboard/billing/${p.invoice.id}`}
                        className="text-primary hover:underline"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {p.invoice.invoiceNumber}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-sm">
                      {fmtMoney(p.totalAmount)}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <div className="h-2 w-24 rounded-full bg-gray-200">
                          <div
                            className="h-2 rounded-full bg-green-500"
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                        <span className="text-xs text-gray-500">
                          {paid}/{p.installments}
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-sm">
                      {p.nextDue
                        ? new Date(p.nextDue).toLocaleDateString()
                        : "—"}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                          p.status === "ACTIVE"
                            ? "bg-blue-100 text-blue-700"
                            : p.status === "COMPLETED"
                              ? "bg-green-100 text-green-700"
                              : p.status === "DEFAULTED"
                                ? "bg-red-100 text-red-700"
                                : "bg-gray-100 text-gray-700"
                        }`}
                      >
                        {p.status}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {detailId && (
        <PlanDetailModal
          id={detailId}
          onClose={() => setDetailId(null)}
          onRefresh={load}
        />
      )}

      {showCreate && (
        <NewPlanModal
          onClose={() => setShowCreate(false)}
          onCreated={() => {
            setShowCreate(false);
            load();
          }}
        />
      )}
    </div>
  );
}

// ─── New plan modal ───────────────────────────────────────────────────────
// Issue #60: lives next to the read-only list so admins/reception can create
// a plan without round-tripping through Billing. The PaymentPlan model
// requires `invoiceId` (FK), so the modal is two-step: pick a patient via
// the shared <EntityPicker>, then pick one of that patient's outstanding
// invoices. Once an invoice is locked in we infer `totalAmount` from it
// (the API computes installmentAmount = (total - downPayment) / N) and the
// user just enters numInstallments + frequency + startDate.
interface InvoiceLite {
  id: string;
  invoiceNumber: string;
  totalAmount: number;
  paymentStatus: string;
}

function NewPlanModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const [patientId, setPatientId] = useState("");
  const [invoices, setInvoices] = useState<InvoiceLite[]>([]);
  const [loadingInv, setLoadingInv] = useState(false);
  const [invoiceId, setInvoiceId] = useState("");
  const [downPayment, setDownPayment] = useState("0");
  const [installments, setInstallments] = useState("3");
  const [frequency, setFrequency] = useState<"WEEKLY" | "BIWEEKLY" | "MONTHLY">(
    "MONTHLY"
  );
  const [startDate, setStartDate] = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Whenever the patient changes, reload their open invoices.
  useEffect(() => {
    if (!patientId) {
      setInvoices([]);
      setInvoiceId("");
      return;
    }
    setLoadingInv(true);
    api
      .get<{ data: InvoiceLite[] }>(
        `/billing/invoices?patientId=${encodeURIComponent(patientId)}&limit=50`
      )
      .then((r) => {
        // Only invoices that still have outstanding balance are eligible
        // for an installment plan.
        const open = (r.data || []).filter(
          (i) => i.paymentStatus !== "PAID"
        );
        setInvoices(open);
        if (open.length === 1) setInvoiceId(open[0].id);
      })
      .catch(() => setInvoices([]))
      .finally(() => setLoadingInv(false));
  }, [patientId]);

  const selectedInvoice = invoices.find((i) => i.id === invoiceId) ?? null;
  const totalAmount = selectedInvoice?.totalAmount ?? 0;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!patientId) {
      setError("Select a patient");
      return;
    }
    if (!invoiceId) {
      setError("Select an outstanding invoice");
      return;
    }
    const n = parseInt(installments, 10);
    if (!Number.isFinite(n) || n < 2 || n > 60) {
      setError("Installments must be between 2 and 60");
      return;
    }
    const dp = parseFloat(downPayment);
    if (!Number.isFinite(dp) || dp < 0) {
      setError("Down payment cannot be negative");
      return;
    }
    if (dp > totalAmount) {
      setError("Down payment cannot exceed invoice total");
      return;
    }
    setSubmitting(true);
    try {
      await api.post("/payment-plans", {
        invoiceId,
        downPayment: dp,
        installments: n,
        frequency,
        startDate,
      });
      toast.success("Payment plan created");
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create plan");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <form
        onSubmit={submit}
        className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-xl bg-white shadow-xl"
        data-testid="new-plan-modal"
      >
        <div className="flex items-center justify-between border-b px-6 py-4">
          <h2 className="text-lg font-bold">New Payment Plan</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full p-1 hover:bg-gray-100"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        <div className="space-y-4 p-6">
          <div>
            <label className="mb-1 block text-sm font-medium">Patient</label>
            <EntityPicker
              endpoint="/patients"
              labelField="user.name"
              subtitleField="user.phone"
              hintField="mrNumber"
              value={patientId}
              onChange={(id) => {
                setPatientId(id);
                setInvoiceId("");
              }}
              searchPlaceholder="Search patient by name, phone, MR..."
              testIdPrefix="new-plan-patient"
              required
            />
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium">
              Outstanding Invoice
            </label>
            {!patientId ? (
              <p className="rounded border border-dashed bg-gray-50 px-3 py-2 text-xs text-gray-500">
                Select a patient first.
              </p>
            ) : loadingInv ? (
              <p className="text-xs text-gray-500">Loading invoices...</p>
            ) : invoices.length === 0 ? (
              <p
                data-testid="new-plan-no-invoices"
                className="rounded border border-dashed bg-yellow-50 px-3 py-2 text-xs text-yellow-700"
              >
                Patient has no outstanding invoice. Create / load an invoice in
                Billing first.
              </p>
            ) : (
              <select
                value={invoiceId}
                onChange={(e) => setInvoiceId(e.target.value)}
                data-testid="new-plan-invoice"
                className="w-full rounded-lg border px-3 py-2 text-sm"
              >
                <option value="">Select invoice...</option>
                {invoices.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.invoiceNumber} — {fmtMoney(i.totalAmount)} (
                    {i.paymentStatus})
                  </option>
                ))}
              </select>
            )}
          </div>

          {selectedInvoice && (
            <div className="rounded border bg-gray-50 px-3 py-2 text-xs">
              <div className="flex justify-between">
                <span className="text-gray-500">Total amount</span>
                <span
                  className="font-medium"
                  data-testid="new-plan-total"
                >
                  {fmtMoney(totalAmount)}
                </span>
              </div>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-sm font-medium">
                Installments
              </label>
              <input
                type="number"
                min={2}
                max={60}
                step={1}
                data-testid="new-plan-installments"
                value={installments}
                onChange={(e) => setInstallments(e.target.value)}
                className="w-full rounded-lg border px-3 py-2 text-sm"
                required
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium">Frequency</label>
              <select
                value={frequency}
                onChange={(e) =>
                  setFrequency(
                    e.target.value as "WEEKLY" | "BIWEEKLY" | "MONTHLY"
                  )
                }
                data-testid="new-plan-frequency"
                className="w-full rounded-lg border px-3 py-2 text-sm"
              >
                <option value="WEEKLY">Weekly</option>
                <option value="BIWEEKLY">Biweekly</option>
                <option value="MONTHLY">Monthly</option>
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-sm font-medium">
                Start Date
              </label>
              <input
                type="date"
                value={startDate}
                data-testid="new-plan-start"
                onChange={(e) => setStartDate(e.target.value)}
                className="w-full rounded-lg border px-3 py-2 text-sm"
                required
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium">
                Down Payment (optional)
              </label>
              <input
                type="number"
                min={0}
                step="0.01"
                data-testid="new-plan-down-payment"
                value={downPayment}
                onChange={(e) => setDownPayment(e.target.value)}
                className="w-full rounded-lg border px-3 py-2 text-sm"
              />
            </div>
          </div>

          {error && (
            <p
              data-testid="new-plan-error"
              className="rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700"
            >
              {error}
            </p>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t bg-gray-50 px-6 py-3">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="rounded-lg border bg-white px-4 py-2 text-sm"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting || !invoiceId}
            data-testid="new-plan-submit"
            className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark disabled:opacity-50"
          >
            {submitting ? "Creating..." : "Create Plan"}
          </button>
        </div>
      </form>
    </div>
  );
}

function PlanDetailModal({
  id,
  onClose,
  onRefresh,
}: {
  id: string;
  onClose: () => void;
  onRefresh: () => void;
}) {
  const [plan, setPlan] = useState<PlanRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [paying, setPaying] = useState<string | null>(null);
  const [mode, setMode] = useState("CASH");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<{ data: PlanRow }>(`/payment-plans/${id}`);
      setPlan(res.data);
    } catch {
      // ignore
    }
    setLoading(false);
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  async function payInstallment(instId: string, amt: number) {
    setPaying(instId);
    try {
      await api.patch(`/payment-plans/${id}/pay-installment`, {
        installmentId: instId,
        amount: amt,
        mode,
      });
      await load();
      onRefresh();
    } catch (err) {
      toast.error((err as Error).message);
    }
    setPaying(null);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-xl bg-white shadow-xl">
        <div className="flex items-center justify-between border-b px-6 py-4">
          <h2 className="text-lg font-bold">
            Payment Plan {plan?.planNumber ?? ""}
          </h2>
          <button
            onClick={onClose}
            className="rounded-full p-1 hover:bg-gray-100"
          >
            <X size={18} />
          </button>
        </div>

        {loading ? (
          <div className="p-8 text-center text-gray-500">Loading...</div>
        ) : !plan ? (
          <div className="p-8 text-center text-gray-500">Not found.</div>
        ) : (
          <div className="space-y-4 p-6">
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <p className="text-xs text-gray-500">Patient</p>
                <p className="font-medium">{plan.patient.user.name}</p>
                <p className="text-xs text-gray-500">{plan.patient.mrNumber}</p>
              </div>
              <div>
                <p className="text-xs text-gray-500">Invoice</p>
                <Link
                  href={`/dashboard/billing/${plan.invoice.id}`}
                  className="font-medium text-primary hover:underline"
                >
                  {plan.invoice.invoiceNumber}
                </Link>
                <p className="text-xs text-gray-500">
                  Total: {fmtMoney(plan.invoice.totalAmount)}
                </p>
              </div>
              <div>
                <p className="text-xs text-gray-500">Installments</p>
                <p className="font-medium">
                  {plan.installments} × {fmtMoney(plan.installmentAmount)} (
                  {plan.frequency})
                </p>
              </div>
              <div>
                <p className="text-xs text-gray-500">Down Payment</p>
                <p className="font-medium">{fmtMoney(plan.downPayment)}</p>
              </div>
            </div>

            <div className="mt-2 flex items-center gap-2 text-sm">
              <label>Pay mode:</label>
              <select
                value={mode}
                onChange={(e) => setMode(e.target.value)}
                className="rounded border px-2 py-1 text-sm"
              >
                {["CASH", "CARD", "UPI", "ONLINE", "INSURANCE"].map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </div>

            <div className="overflow-hidden rounded-lg border">
              <table className="w-full">
                <thead className="bg-gray-50">
                  <tr className="text-left text-sm text-gray-500">
                    <th className="px-3 py-2">#</th>
                    <th className="px-3 py-2">Due Date</th>
                    <th className="px-3 py-2">Amount</th>
                    <th className="px-3 py-2">Status</th>
                    <th className="px-3 py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {plan.installmentRecords
                    .slice()
                    .sort(
                      (a, b) =>
                        new Date(a.dueDate).getTime() -
                        new Date(b.dueDate).getTime()
                    )
                    .map((r, i) => (
                      <tr key={r.id} className="border-t">
                        <td className="px-3 py-2 text-sm">{i + 1}</td>
                        <td className="px-3 py-2 text-sm">
                          {new Date(r.dueDate).toLocaleDateString()}
                        </td>
                        <td className="px-3 py-2 text-sm">
                          {fmtMoney(r.amount)}
                        </td>
                        <td className="px-3 py-2">
                          <span
                            className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                              r.status === "PAID"
                                ? "bg-green-100 text-green-700"
                                : r.status === "OVERDUE"
                                  ? "bg-red-100 text-red-700"
                                  : r.status === "WAIVED"
                                    ? "bg-gray-100 text-gray-600"
                                    : "bg-yellow-100 text-yellow-700"
                            }`}
                          >
                            {r.status}
                          </span>
                        </td>
                        <td className="px-3 py-2">
                          {r.status === "PENDING" ||
                          r.status === "OVERDUE" ? (
                            <button
                              disabled={paying === r.id}
                              onClick={() => payInstallment(r.id, r.amount)}
                              className="rounded bg-green-500 px-3 py-1 text-xs font-medium text-white hover:bg-green-600 disabled:opacity-50"
                            >
                              {paying === r.id ? "..." : "Pay"}
                            </button>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
