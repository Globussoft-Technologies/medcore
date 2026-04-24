"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { api, openPrintEndpoint } from "@/lib/api";
import { formatDoctorName } from "@/lib/format-doctor-name";
import { toast } from "@/lib/toast";
import { useConfirm } from "@/lib/use-dialog";
import {
  Printer,
  ArrowLeft,
  Plus,
  Trash2,
  Percent,
  Undo2,
  Receipt,
  CreditCard,
  X,
} from "lucide-react";

interface InvoiceDetail {
  id: string;
  invoiceNumber: string;
  totalAmount: number;
  subtotal: number;
  taxAmount: number;
  discountAmount: number;
  paymentStatus: string;
  lateFeeAmount: number;
  lateFeeAppliedAt?: string | null;
  notes: string | null;
  createdAt: string;
  patient: {
    id: string;
    mrNumber: string;
    age: number | null;
    gender: string;
    user: { name: string; phone: string; email: string };
  };
  appointment?: {
    date: string;
    doctor: { user: { name: string }; specialization: string };
  };
  items: Array<{
    id: string;
    description: string;
    category: string;
    quantity: number;
    unitPrice: number;
    amount: number;
  }>;
  payments: Array<{
    id: string;
    amount: number;
    mode: string;
    paidAt: string;
    transactionId: string | null;
  }>;
}

const REFUND_PREFIX = "REFUND:";

function fmtMoney(n: number) {
  return `Rs. ${n.toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export default function InvoiceDetailPage() {
  const params = useParams();
  const id = params.id as string;
  const confirm = useConfirm();
  const [invoice, setInvoice] = useState<InvoiceDetail | null>(null);
  const [loading, setLoading] = useState(true);

  // Add item form
  const [newDesc, setNewDesc] = useState("");
  const [newCategory, setNewCategory] = useState("CONSULTATION");
  const [newQty, setNewQty] = useState("1");
  const [newPrice, setNewPrice] = useState("");
  const [adding, setAdding] = useState(false);

  // Discount modal
  const [discOpen, setDiscOpen] = useState(false);
  const [discType, setDiscType] = useState<"percentage" | "flat">("percentage");
  const [discValue, setDiscValue] = useState("");
  const [discReason, setDiscReason] = useState("");
  const [discSubmitting, setDiscSubmitting] = useState(false);

  // Record payment
  const [payOpen, setPayOpen] = useState(false);
  const [payAmount, setPayAmount] = useState("");
  const [payMode, setPayMode] = useState("CASH");
  const [paySubmitting, setPaySubmitting] = useState(false);

  // Refund
  const [refundOpen, setRefundOpen] = useState(false);
  const [refundAmount, setRefundAmount] = useState("");
  const [refundMode, setRefundMode] = useState("CASH");
  const [refundReason, setRefundReason] = useState("");
  const [refundSubmitting, setRefundSubmitting] = useState(false);

  // Pending discount approvals + payment plan modal
  const [pendingApprovals, setPendingApprovals] = useState<Array<{
    id: string;
    amount: number;
    percentage?: number | null;
    reason: string;
  }>>([]);
  const [planOpen, setPlanOpen] = useState(false);

  const loadInvoice = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<{ data: InvoiceDetail }>(
        `/billing/invoices/${id}`
      );
      setInvoice(res.data);
      try {
        const a = await api.get<{
          data: Array<{
            id: string;
            amount: number;
            percentage?: number | null;
            reason: string;
          }>;
        }>(`/billing/discount-approvals?status=PENDING&invoiceId=${id}`);
        setPendingApprovals(a.data || []);
      } catch {
        setPendingApprovals([]);
      }
    } catch {
      // empty
    }
    setLoading(false);
  }, [id]);

  useEffect(() => {
    loadInvoice();
  }, [loadInvoice]);

  async function addItem() {
    if (!newDesc.trim()) {
      toast.error("Description is required for the line item");
      return;
    }
    const qty = parseInt(newQty || "0", 10);
    const price = parseFloat(newPrice || "0");
    if (Number.isNaN(qty) || qty < 1) {
      toast.error("Quantity must be at least 1");
      return;
    }
    if (Number.isNaN(price) || price <= 0) {
      toast.error("Unit price must be greater than 0");
      return;
    }
    setAdding(true);
    try {
      await api.post(`/billing/invoices/${id}/items`, {
        description: newDesc,
        category: newCategory,
        quantity: parseInt(newQty),
        unitPrice: parseFloat(newPrice),
      });
      setNewDesc("");
      setNewQty("1");
      setNewPrice("");
      loadInvoice();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to add item");
    }
    setAdding(false);
  }

  async function removeItem(itemId: string) {
    if (!(await confirm({ title: "Remove this line item?", danger: true }))) return;
    try {
      await api.delete(`/billing/invoices/${id}/items/${itemId}`);
      loadInvoice();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to remove item");
    }
  }

  async function submitDiscount() {
    setDiscSubmitting(true);
    try {
      const body: Record<string, unknown> = { reason: discReason };
      if (discType === "percentage") body.percentage = parseFloat(discValue);
      else body.flatAmount = parseFloat(discValue);
      await api.post(`/billing/invoices/${id}/discount`, body);
      setDiscOpen(false);
      setDiscValue("");
      setDiscReason("");
      loadInvoice();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Discount failed");
    }
    setDiscSubmitting(false);
  }

  async function submitPayment() {
    setPaySubmitting(true);
    try {
      await api.post("/billing/payments", {
        invoiceId: id,
        amount: parseFloat(payAmount),
        mode: payMode,
      });
      setPayOpen(false);
      setPayAmount("");
      setPayMode("CASH");
      loadInvoice();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Payment failed");
    }
    setPaySubmitting(false);
  }

  async function submitRefund() {
    setRefundSubmitting(true);
    try {
      await api.post("/billing/refunds", {
        invoiceId: id,
        amount: parseFloat(refundAmount),
        reason: refundReason,
        mode: refundMode,
      });
      setRefundOpen(false);
      setRefundAmount("");
      setRefundReason("");
      setRefundMode("CASH");
      loadInvoice();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Refund failed");
    }
    setRefundSubmitting(false);
  }

  if (loading) {
    return <div className="p-8 text-center text-gray-500">Loading invoice...</div>;
  }

  if (!invoice) {
    return (
      <div className="p-8 text-center">
        <p className="text-gray-500">Invoice not found</p>
        <Link
          href="/dashboard/billing"
          className="mt-4 inline-block text-primary hover:underline"
        >
          Back to Billing
        </Link>
      </div>
    );
  }

  const positivePayments = invoice.payments.filter((p) => p.amount >= 0);
  const refunds = invoice.payments.filter((p) => p.amount < 0);
  const grossPaid = positivePayments.reduce((s, p) => s + p.amount, 0);
  const totalRefunded = refunds.reduce((s, p) => s + Math.abs(p.amount), 0);
  const netPaid = grossPaid - totalRefunded;
  const balance = Math.max(0, invoice.totalAmount - netPaid);

  const statusColors: Record<string, string> = {
    PENDING: "bg-red-100 text-red-700",
    PARTIAL: "bg-yellow-100 text-yellow-700",
    PAID: "bg-green-100 text-green-700",
    REFUNDED: "bg-gray-100 text-gray-500",
  };

  // Timeline (payments + refunds) sorted by date
  const timeline = [...invoice.payments].sort(
    (a, b) => new Date(a.paidAt).getTime() - new Date(b.paidAt).getTime()
  );

  const isPending = invoice.paymentStatus === "PENDING";

  return (
    <>
      <style jsx global>{`
        @media print {
          body * {
            visibility: hidden;
          }
          #invoice-print,
          #invoice-print * {
            visibility: visible;
          }
          #invoice-print {
            position: absolute;
            left: 0;
            top: 0;
            width: 100%;
            padding: 20px;
          }
          .no-print {
            display: none !important;
          }
        }
      `}</style>

      {/* Action bar */}
      <div className="no-print mb-4 flex flex-wrap items-center justify-between gap-2">
        <Link
          href="/dashboard/billing"
          className="flex items-center gap-2 text-sm text-gray-600 hover:text-primary"
        >
          <ArrowLeft size={16} /> Back to Billing
        </Link>
        <div className="flex flex-wrap items-center gap-2">
          {invoice.paymentStatus !== "PAID" &&
            invoice.paymentStatus !== "REFUNDED" && (
              <button
                onClick={() => setDiscOpen(true)}
                className="flex items-center gap-1 rounded-lg border bg-white px-3 py-1.5 text-sm hover:bg-gray-50"
              >
                <Percent size={14} /> Apply Discount
              </button>
            )}
          {balance > 0 && (
            <button
              onClick={() => {
                setPayAmount(String(balance));
                setPayOpen(true);
              }}
              className="flex items-center gap-1 rounded-lg bg-green-500 px-3 py-1.5 text-sm text-white hover:bg-green-600"
            >
              <Receipt size={14} /> Record Payment
            </button>
          )}
          {netPaid > 0 && (
            <button
              onClick={() => {
                setRefundAmount(String(netPaid));
                setRefundOpen(true);
              }}
              className="flex items-center gap-1 rounded-lg bg-orange-500 px-3 py-1.5 text-sm text-white hover:bg-orange-600"
            >
              <Undo2 size={14} /> Record Refund
            </button>
          )}
          {balance > 0 && (
            <button
              onClick={() => setPlanOpen(true)}
              className="flex items-center gap-1 rounded-lg border bg-white px-3 py-1.5 text-sm hover:bg-gray-50"
            >
              <CreditCard size={14} /> Create Plan
            </button>
          )}
          <button
            onClick={() => openPrintEndpoint(`/billing/invoices/${invoice.id}/pdf`)}
            className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark"
          >
            <Printer size={16} /> Print Invoice
          </button>
        </div>
      </div>

      {/* Pending discount approval badge */}
      {pendingApprovals.length > 0 && (
        <div className="no-print mx-auto mb-3 max-w-3xl rounded-lg border border-orange-300 bg-orange-50 p-3 text-sm text-orange-800">
          <strong>Discount Pending Approval:</strong>{" "}
          {pendingApprovals.map((p) => (
            <span key={p.id}>
              Rs.{p.amount.toFixed(2)}
              {p.percentage != null ? ` (${p.percentage}%)` : ""} — {p.reason};{" "}
            </span>
          ))}
        </div>
      )}

      {invoice.lateFeeAmount > 0 && (
        <div className="no-print mx-auto mb-3 max-w-3xl rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-800">
          <strong>Late fee:</strong> Rs.{invoice.lateFeeAmount.toFixed(2)}{" "}
          applied.
        </div>
      )}

      {/* Invoice content */}
      <div
        id="invoice-print"
        className="relative mx-auto max-w-3xl overflow-hidden rounded-xl bg-white p-8 shadow-sm"
      >
        {/* Watermark overlays */}
        {invoice.paymentStatus === "CANCELLED" && (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
            <span className="select-none rotate-[-30deg] text-[8rem] font-black text-red-500/20">
              CANCELLED
            </span>
          </div>
        )}
        {invoice.paymentStatus === "PAID" && (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
            <span className="select-none rotate-[-30deg] text-[8rem] font-black text-green-500/15">
              PAID
            </span>
          </div>
        )}
        {pendingApprovals.length > 0 && (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
            <span className="select-none rotate-[-30deg] text-[8rem] font-black text-orange-500/20">
              DRAFT
            </span>
          </div>
        )}
        {/* Header */}
        <div className="mb-8 border-b pb-6">
          <div className="flex items-start justify-between">
            <div>
              <h1 className="text-2xl font-bold text-primary">MedCore</h1>
              <p className="mt-1 text-sm text-gray-500">
                Hospital Operations Automation
              </p>
              <p className="text-sm text-gray-500">
                123 Medical Center Road, Healthcare District
              </p>
              <p className="text-sm text-gray-500">Phone: +91-XXXXXXXXXX</p>
              <p className="mt-1 text-xs font-semibold text-gray-700">
                GSTIN: 29ABCDE1234F1Z5
              </p>
            </div>
            <div className="text-right">
              <h2 className="text-lg font-semibold">TAX INVOICE</h2>
              <p className="font-mono text-sm font-medium text-primary">
                {invoice.invoiceNumber}
              </p>
              <p className="mt-1 text-sm text-gray-500">
                Date:{" "}
                {new Date(invoice.createdAt).toLocaleDateString("en-IN", {
                  year: "numeric",
                  month: "long",
                  day: "numeric",
                })}
              </p>
              <span
                className={`mt-2 inline-block rounded-full px-3 py-0.5 text-xs font-medium ${statusColors[invoice.paymentStatus] || ""}`}
              >
                {invoice.paymentStatus}
              </span>
            </div>
          </div>
        </div>

        {/* Patient & Doctor Info */}
        <div className="mb-6 grid grid-cols-2 gap-6">
          <div>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-400">
              Bill To
            </h3>
            <p className="font-medium">{invoice.patient.user.name}</p>
            <p className="text-sm text-gray-600">MR#: {invoice.patient.mrNumber}</p>
            <p className="text-sm text-gray-600">
              {invoice.patient.age ? `${invoice.patient.age} yrs, ` : ""}
              {invoice.patient.gender}
            </p>
            <p className="text-sm text-gray-600">{invoice.patient.user.phone}</p>
            {invoice.patient.user.email && (
              <p className="text-sm text-gray-600">{invoice.patient.user.email}</p>
            )}
            <Link
              href={`/dashboard/billing/patient/${invoice.patient.id}`}
              className="no-print mt-2 inline-block text-xs text-primary hover:underline"
            >
              View all patient invoices →
            </Link>
          </div>
          {invoice.appointment && (
            <div>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-400">
                Consultation
              </h3>
              <p className="font-medium">
                {formatDoctorName(invoice.appointment.doctor.user.name)}
              </p>
              <p className="text-sm text-gray-600">
                {invoice.appointment.doctor.specialization}
              </p>
              <p className="text-sm text-gray-600">
                {new Date(invoice.appointment.date).toLocaleDateString("en-IN")}
              </p>
            </div>
          )}
        </div>

        {/* Line Items */}
        <div className="mb-6">
          <table className="w-full">
            <thead>
              <tr className="border-b border-t text-left text-sm text-gray-500">
                <th className="py-3">#</th>
                <th className="py-3">Description</th>
                <th className="py-3 text-center">Qty</th>
                <th className="py-3 text-right">Unit Price</th>
                <th className="py-3 text-right">Amount</th>
                {isPending && <th className="no-print py-3" />}
              </tr>
            </thead>
            <tbody>
              {invoice.items && invoice.items.length > 0 ? (
                invoice.items.map((item, i) => (
                  <tr key={item.id} className="border-b">
                    <td className="py-3 text-sm">{i + 1}</td>
                    <td className="py-3 text-sm">
                      {item.description}
                      <p className="text-xs text-gray-400">{item.category}</p>
                    </td>
                    <td className="py-3 text-center text-sm">{item.quantity}</td>
                    <td className="py-3 text-right text-sm">
                      {fmtMoney(item.unitPrice)}
                    </td>
                    <td className="py-3 text-right text-sm font-medium">
                      {fmtMoney(item.amount)}
                    </td>
                    {isPending && (
                      <td className="no-print py-3 text-right">
                        {invoice.items.length > 1 && (
                          <button
                            onClick={() => removeItem(item.id)}
                            className="rounded p-1 text-red-500 hover:bg-red-50"
                            title="Remove item"
                          >
                            <Trash2 size={14} />
                          </button>
                        )}
                      </td>
                    )}
                  </tr>
                ))
              ) : (
                <tr className="border-b">
                  <td className="py-3 text-sm" colSpan={5}>
                    No items
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Add item form (only for PENDING invoices) */}
        {isPending && (
          <div className="no-print mb-6 rounded-lg border border-dashed bg-gray-50 p-4">
            <h3 className="mb-3 text-sm font-semibold text-gray-700">Add Line Item</h3>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-12">
              <input
                type="text"
                placeholder="Description"
                value={newDesc}
                onChange={(e) => setNewDesc(e.target.value)}
                className="rounded-lg border px-3 py-2 text-sm sm:col-span-5"
              />
              <select
                value={newCategory}
                onChange={(e) => setNewCategory(e.target.value)}
                className="rounded-lg border px-3 py-2 text-sm sm:col-span-3"
              >
                {[
                  "CONSULTATION",
                  "PROCEDURE",
                  "LAB",
                  "PHARMACY",
                  "ROOM",
                  "SURGERY",
                  "OTHER",
                ].map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
              <input
                type="number"
                min="1"
                placeholder="Qty"
                value={newQty}
                onChange={(e) => setNewQty(e.target.value)}
                className="rounded-lg border px-3 py-2 text-sm sm:col-span-1"
              />
              <input
                type="number"
                min="0"
                step="0.01"
                placeholder="Unit Price"
                value={newPrice}
                onChange={(e) => setNewPrice(e.target.value)}
                className="rounded-lg border px-3 py-2 text-sm sm:col-span-2"
              />
              <button
                onClick={addItem}
                disabled={adding || !newDesc || !newPrice}
                className="flex items-center justify-center gap-1 rounded-lg bg-primary px-3 py-2 text-sm text-white hover:bg-primary-dark disabled:opacity-50 sm:col-span-1"
              >
                <Plus size={14} />
              </button>
            </div>
          </div>
        )}

        {/* Totals */}
        <div className="mb-8 flex justify-end">
          <div className="w-72 space-y-2">
            <div className="flex justify-between text-sm">
              <span className="text-gray-500">Subtotal</span>
              <span>{fmtMoney(invoice.subtotal)}</span>
            </div>
            {invoice.taxAmount > 0 && (
              <>
                <div className="flex justify-between text-sm">
                  <span className="text-gray-500">CGST (9%)</span>
                  <span>{fmtMoney(invoice.taxAmount / 2)}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-gray-500">SGST (9%)</span>
                  <span>{fmtMoney(invoice.taxAmount / 2)}</span>
                </div>
                <div className="flex justify-between border-t pt-1 text-sm font-medium">
                  <span className="text-gray-600">Total GST (18%)</span>
                  <span>{fmtMoney(invoice.taxAmount)}</span>
                </div>
              </>
            )}
            {invoice.discountAmount > 0 && (
              <div className="flex justify-between text-sm">
                <span className="text-gray-500">Discount</span>
                <span className="text-green-600">
                  - {fmtMoney(invoice.discountAmount)}
                </span>
              </div>
            )}
            <div className="flex justify-between border-t pt-2 font-semibold">
              <span>Total</span>
              <span>{fmtMoney(invoice.totalAmount)}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-gray-500">Payments</span>
              <span className="text-green-600">{fmtMoney(grossPaid)}</span>
            </div>
            {totalRefunded > 0 && (
              <div className="flex justify-between text-sm">
                <span className="text-gray-500">Refunds</span>
                <span className="text-orange-500">
                  - {fmtMoney(totalRefunded)}
                </span>
              </div>
            )}
            <div className="flex justify-between text-sm">
              <span className="text-gray-500">Net Paid</span>
              <span>{fmtMoney(netPaid)}</span>
            </div>
            <div
              className={`flex justify-between border-t pt-2 text-sm font-semibold ${
                balance > 0 ? "text-red-600" : "text-gray-500"
              }`}
            >
              <span>Running Balance</span>
              <span>{fmtMoney(balance)}</span>
            </div>
          </div>
        </div>

        {/* Refunds section */}
        {refunds.length > 0 && (
          <div className="mb-6">
            <h3 className="mb-3 text-sm font-semibold text-gray-700">Refunds Issued</h3>
            <div className="rounded-lg border border-orange-100 bg-orange-50/40">
              <table className="w-full">
                <thead>
                  <tr className="border-b text-left text-xs text-gray-500">
                    <th className="px-3 py-2">Date</th>
                    <th className="px-3 py-2">Amount</th>
                    <th className="px-3 py-2">Mode</th>
                    <th className="px-3 py-2">Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {refunds.map((r) => (
                    <tr key={r.id} className="border-b last:border-0">
                      <td className="px-3 py-2 text-xs">
                        {new Date(r.paidAt).toLocaleString("en-IN")}
                      </td>
                      <td className="px-3 py-2 text-xs font-medium text-orange-600">
                        {fmtMoney(Math.abs(r.amount))}
                      </td>
                      <td className="px-3 py-2 text-xs">{r.mode}</td>
                      <td className="px-3 py-2 text-xs text-gray-600">
                        {r.transactionId?.startsWith(REFUND_PREFIX)
                          ? r.transactionId.slice(REFUND_PREFIX.length)
                          : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Payment timeline */}
        {timeline.length > 0 && (
          <div className="mb-6">
            <h3 className="mb-3 text-sm font-semibold text-gray-700">Payment Timeline</h3>
            <ol className="relative border-l-2 border-gray-200 pl-4">
              {timeline.map((e) => {
                const isRefund = e.amount < 0;
                return (
                  <li key={e.id} className="mb-4 last:mb-0">
                    <span
                      className={`absolute -left-1.75 h-3 w-3 rounded-full ${
                        isRefund ? "bg-orange-500" : "bg-green-500"
                      }`}
                    />
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-sm font-medium">
                          {isRefund ? "Refund issued" : "Payment received"} —{" "}
                          <span className={isRefund ? "text-orange-600" : "text-green-600"}>
                            {fmtMoney(Math.abs(e.amount))}
                          </span>
                          <span className="ml-2 text-xs text-gray-500">({e.mode})</span>
                        </p>
                        {e.transactionId && (
                          <p className="text-xs text-gray-500">
                            {e.transactionId.startsWith(REFUND_PREFIX)
                              ? `Reason: ${e.transactionId.slice(REFUND_PREFIX.length)}`
                              : `Ref: ${e.transactionId}`}
                          </p>
                        )}
                      </div>
                      <p className="text-xs text-gray-400">
                        {new Date(e.paidAt).toLocaleString("en-IN")}
                      </p>
                    </div>
                  </li>
                );
              })}
            </ol>
          </div>
        )}

        {invoice.notes && (
          <div className="mb-6 rounded-lg bg-gray-50 p-3 text-xs text-gray-600 whitespace-pre-line">
            <p className="mb-1 font-semibold text-gray-700">Notes</p>
            {invoice.notes}
          </div>
        )}

        <div className="border-t pt-4 text-center text-xs text-gray-400">
          <p>Thank you for choosing MedCore.</p>
          <p>This is a computer-generated invoice.</p>
        </div>
      </div>

      {/* Discount modal */}
      {discOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="mx-4 w-full max-w-md rounded-xl bg-white p-6 shadow-2xl">
            <h2 className="mb-4 text-lg font-bold">Apply Discount</h2>
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
                  {discType === "percentage" ? "Percentage (%)" : "Flat Amount (Rs.)"}
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
                onClick={submitDiscount}
                disabled={discSubmitting || !discValue || !discReason}
                className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark disabled:opacity-50"
              >
                {discSubmitting ? "Saving..." : "Apply"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Payment modal */}
      {payOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="mx-4 w-full max-w-md rounded-xl bg-white p-6 shadow-2xl">
            <h2 className="mb-4 text-lg font-bold">Record Payment</h2>
            <div className="space-y-3">
              <div>
                <label className="mb-1 block text-xs text-gray-500">Amount (Rs.)</label>
                <input
                  type="number"
                  min="0.01"
                  step="0.01"
                  value={payAmount}
                  onChange={(e) => setPayAmount(e.target.value)}
                  className="w-full rounded-lg border px-3 py-2 text-sm"
                  autoFocus
                />
              </div>
              <div>
                <label className="mb-1 block text-xs text-gray-500">Mode</label>
                <select
                  value={payMode}
                  onChange={(e) => setPayMode(e.target.value)}
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
                onClick={() => setPayOpen(false)}
                className="rounded-lg px-4 py-2 text-sm text-gray-600 hover:bg-gray-100"
              >
                Cancel
              </button>
              <button
                onClick={submitPayment}
                disabled={paySubmitting || !payAmount}
                className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark disabled:opacity-50"
              >
                {paySubmitting ? "Saving..." : "Save Payment"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Refund modal */}
      {refundOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="mx-4 w-full max-w-md rounded-xl bg-white p-6 shadow-2xl">
            <h2 className="mb-4 text-lg font-bold">Issue Refund</h2>
            <div className="space-y-3">
              <div>
                <label className="mb-1 block text-xs text-gray-500">Amount (Rs.)</label>
                <input
                  type="number"
                  min="0.01"
                  step="0.01"
                  value={refundAmount}
                  onChange={(e) => setRefundAmount(e.target.value)}
                  className="w-full rounded-lg border px-3 py-2 text-sm"
                  autoFocus
                />
              </div>
              <div>
                <label className="mb-1 block text-xs text-gray-500">Mode</label>
                <select
                  value={refundMode}
                  onChange={(e) => setRefundMode(e.target.value)}
                  className="w-full rounded-lg border px-3 py-2 text-sm"
                >
                  {["CASH", "CARD", "UPI", "ONLINE", "INSURANCE"].map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="mb-1 block text-xs text-gray-500">Reason</label>
                <textarea
                  value={refundReason}
                  onChange={(e) => setRefundReason(e.target.value)}
                  className="w-full rounded-lg border px-3 py-2 text-sm"
                  rows={3}
                />
              </div>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={() => setRefundOpen(false)}
                className="rounded-lg px-4 py-2 text-sm text-gray-600 hover:bg-gray-100"
              >
                Cancel
              </button>
              <button
                onClick={submitRefund}
                disabled={
                  refundSubmitting ||
                  !refundAmount ||
                  !refundReason ||
                  parseFloat(refundAmount) <= 0
                }
                className="rounded-lg bg-orange-500 px-4 py-2 text-sm font-medium text-white hover:bg-orange-600 disabled:opacity-50"
              >
                {refundSubmitting ? "Saving..." : "Issue Refund"}
              </button>
            </div>
          </div>
        </div>
      )}

      {planOpen && invoice && (
        <CreatePlanModal
          invoiceId={invoice.id}
          balance={balance}
          onClose={() => setPlanOpen(false)}
          onSaved={loadInvoice}
        />
      )}
    </>
  );
}

function CreatePlanModal({
  invoiceId,
  balance,
  onClose,
  onSaved,
}: {
  invoiceId: string;
  balance: number;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [downPayment, setDownPayment] = useState("0");
  const [installments, setInstallments] = useState("3");
  const [frequency, setFrequency] = useState("MONTHLY");
  const [startDate, setStartDate] = useState(
    new Date(Date.now() + 86400000).toISOString().slice(0, 10)
  );
  const [saving, setSaving] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      await api.post("/payment-plans", {
        invoiceId,
        downPayment: parseFloat(downPayment || "0"),
        installments: parseInt(installments, 10),
        frequency,
        startDate,
      });
      onSaved();
      onClose();
    } catch (err) {
      toast.error((err as Error).message);
    }
    setSaving(false);
  }

  const afterDown = Math.max(0, balance - parseFloat(downPayment || "0"));
  const n = parseInt(installments, 10) || 1;
  const each = afterDown / n;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <form
        onSubmit={submit}
        className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl"
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-bold">Create Payment Plan</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full p-1 hover:bg-gray-100"
          >
            <X size={18} />
          </button>
        </div>
        <div className="space-y-3 text-sm">
          <p className="rounded bg-gray-50 p-2 text-xs text-gray-600">
            Outstanding balance: {fmtMoney(balance)}
          </p>
          <div>
            <label className="mb-1 block text-xs text-gray-500">
              Down Payment
            </label>
            <input
              type="number"
              step="0.01"
              value={downPayment}
              onChange={(e) => setDownPayment(e.target.value)}
              className="w-full rounded border px-3 py-2"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-gray-500">
              Installments
            </label>
            <input
              type="number"
              min={2}
              max={60}
              value={installments}
              onChange={(e) => setInstallments(e.target.value)}
              className="w-full rounded border px-3 py-2"
              required
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-gray-500">Frequency</label>
            <select
              value={frequency}
              onChange={(e) => setFrequency(e.target.value)}
              className="w-full rounded border px-3 py-2"
            >
              <option value="MONTHLY">Monthly</option>
              <option value="BIWEEKLY">Bi-weekly</option>
              <option value="WEEKLY">Weekly</option>
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs text-gray-500">
              Start Date
            </label>
            <input
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              className="w-full rounded border px-3 py-2"
              required
            />
          </div>
          <p className="rounded bg-blue-50 p-2 text-xs text-blue-700">
            Each installment: {fmtMoney(each)}
          </p>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded border px-4 py-2 text-sm"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={saving}
            className="rounded bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark disabled:opacity-50"
          >
            {saving ? "Creating..." : "Create Plan"}
          </button>
        </div>
      </form>
    </div>
  );
}
