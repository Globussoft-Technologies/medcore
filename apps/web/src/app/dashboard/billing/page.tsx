"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { useAuthStore } from "@/lib/store";

interface InvoiceRecord {
  id: string;
  invoiceNumber: string;
  totalAmount: number;
  paymentStatus: string;
  createdAt: string;
  patient: { user: { name: string; phone: string } };
  payments: Array<{ amount: number; mode: string; paidAt: string }>;
}

interface PayOnlineData {
  orderId: string;
  amount: number;
  currency: string;
  keyId: string;
  invoiceId: string;
  invoiceNumber: string;
}

export default function BillingPage() {
  const { user } = useAuthStore();
  const [invoices, setInvoices] = useState<InvoiceRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("all");

  // Pay Online modal state
  const [payModalInvoice, setPayModalInvoice] = useState<InvoiceRecord | null>(
    null
  );
  const [payLoading, setPayLoading] = useState(false);
  const [payError, setPayError] = useState<string | null>(null);
  const [payOrderData, setPayOrderData] = useState<PayOnlineData | null>(null);

  useEffect(() => {
    loadInvoices();
  }, [filter]);

  async function loadInvoices() {
    setLoading(true);
    try {
      const q = filter !== "all" ? `?status=${filter}` : "";
      const res = await api.get<{ data: InvoiceRecord[] }>(
        `/billing/invoices${q}`
      );
      setInvoices(res.data);
    } catch {
      // empty
    }
    setLoading(false);
  }

  async function recordPayment(invoiceId: string) {
    const amountStr = prompt("Enter payment amount:");
    if (!amountStr) return;

    const mode = prompt("Payment mode (CASH/CARD/UPI):") || "CASH";

    try {
      await api.post("/billing/payments", {
        invoiceId,
        amount: parseFloat(amountStr),
        mode: mode.toUpperCase(),
      });
      loadInvoices();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Payment failed");
    }
  }

  function openPayOnlineModal(inv: InvoiceRecord) {
    setPayModalInvoice(inv);
    setPayError(null);
    setPayOrderData(null);
  }

  function closePayOnlineModal() {
    setPayModalInvoice(null);
    setPayError(null);
    setPayOrderData(null);
    setPayLoading(false);
  }

  async function handleProceedToPay() {
    if (!payModalInvoice) return;

    setPayLoading(true);
    setPayError(null);

    try {
      const res = await api.post<{ data: PayOnlineData }>(
        "/billing/pay-online",
        { invoiceId: payModalInvoice.id }
      );
      setPayOrderData(res.data);
      // In a full integration, you would load the Razorpay checkout script here:
      // const rzp = new (window as any).Razorpay({ ... });
      // rzp.open();
    } catch (err) {
      setPayError(
        err instanceof Error ? err.message : "Failed to create payment order"
      );
    } finally {
      setPayLoading(false);
    }
  }

  const statusColors: Record<string, string> = {
    PENDING: "bg-red-100 text-red-700",
    PARTIAL: "bg-yellow-100 text-yellow-700",
    PAID: "bg-green-100 text-green-700",
    REFUNDED: "bg-gray-100 text-gray-500",
  };

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold">Billing</h1>
        <div className="flex gap-2">
          {["all", "PENDING", "PARTIAL", "PAID"].map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`rounded-lg px-3 py-1.5 text-sm ${
                filter === f
                  ? "bg-primary text-white"
                  : "bg-white text-gray-600 hover:bg-gray-100"
              }`}
            >
              {f === "all" ? "All" : f}
            </button>
          ))}
        </div>
      </div>

      <div className="rounded-xl bg-white shadow-sm">
        {loading ? (
          <div className="p-8 text-center text-gray-500">Loading...</div>
        ) : invoices.length === 0 ? (
          <div className="p-8 text-center text-gray-500">No invoices found</div>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="border-b text-left text-sm text-gray-500">
                <th className="px-4 py-3">Invoice #</th>
                <th className="px-4 py-3">Patient</th>
                <th className="px-4 py-3">Amount</th>
                <th className="px-4 py-3">Paid</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Date</th>
                {(user?.role === "RECEPTION" || user?.role === "ADMIN") && (
                  <th className="px-4 py-3">Actions</th>
                )}
              </tr>
            </thead>
            <tbody>
              {invoices.map((inv) => {
                const totalPaid = inv.payments.reduce(
                  (s, p) => s + p.amount,
                  0
                );
                return (
                  <tr key={inv.id} className="border-b last:border-0">
                    <td className="px-4 py-3 font-mono text-sm">
                      <Link href={`/dashboard/billing/${inv.id}`} className="text-primary hover:underline">
                        {inv.invoiceNumber}
                      </Link>
                    </td>
                    <td className="px-4 py-3">
                      <p className="font-medium">{inv.patient.user.name}</p>
                      <p className="text-xs text-gray-500">
                        {inv.patient.user.phone}
                      </p>
                    </td>
                    <td className="px-4 py-3 font-medium">
                      Rs. {inv.totalAmount.toFixed(2)}
                    </td>
                    <td className="px-4 py-3 text-sm">
                      Rs. {totalPaid.toFixed(2)}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${statusColors[inv.paymentStatus] || ""}`}
                      >
                        {inv.paymentStatus}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-500">
                      {new Date(inv.createdAt).toLocaleDateString("en-IN")}
                    </td>
                    {(user?.role === "RECEPTION" ||
                      user?.role === "ADMIN") && (
                      <td className="px-4 py-3">
                        {inv.paymentStatus !== "PAID" && (
                          <div className="flex gap-2">
                            <button
                              onClick={() => recordPayment(inv.id)}
                              className="rounded bg-green-500 px-2 py-1 text-xs text-white hover:bg-green-600"
                            >
                              Record Payment
                            </button>
                            <button
                              onClick={() => openPayOnlineModal(inv)}
                              className="rounded bg-primary px-2 py-1 text-xs text-white hover:bg-primary-dark"
                            >
                              Pay Online
                            </button>
                          </div>
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Pay Online Modal */}
      {payModalInvoice && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="mx-4 w-full max-w-md rounded-xl bg-white p-6 shadow-2xl">
            <h2 className="mb-4 text-lg font-bold">Online Payment</h2>

            <div className="mb-4 space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-gray-500">Invoice</span>
                <span className="font-mono font-medium">
                  {payModalInvoice.invoiceNumber}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Patient</span>
                <span className="font-medium">
                  {payModalInvoice.patient.user.name}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Total Amount</span>
                <span className="font-medium">
                  Rs. {payModalInvoice.totalAmount.toFixed(2)}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Already Paid</span>
                <span>
                  Rs.{" "}
                  {payModalInvoice.payments
                    .reduce((s, p) => s + p.amount, 0)
                    .toFixed(2)}
                </span>
              </div>
              <div className="flex justify-between border-t pt-2">
                <span className="font-semibold text-gray-700">
                  Amount to Pay
                </span>
                <span className="text-lg font-bold text-primary">
                  Rs.{" "}
                  {(
                    payModalInvoice.totalAmount -
                    payModalInvoice.payments.reduce(
                      (s, p) => s + p.amount,
                      0
                    )
                  ).toFixed(2)}
                </span>
              </div>
            </div>

            {payError && (
              <div className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">
                {payError}
              </div>
            )}

            {payOrderData && (
              <div className="mb-4 rounded-lg bg-green-50 px-3 py-2 text-sm text-green-700">
                <p className="font-medium">Order created successfully</p>
                <p className="mt-1 font-mono text-xs">
                  Order ID: {payOrderData.orderId}
                </p>
                <p className="mt-2 text-xs text-gray-500">
                  Razorpay checkout will be triggered with the loaded script.
                </p>
              </div>
            )}

            <div className="flex justify-end gap-3">
              <button
                onClick={closePayOnlineModal}
                className="rounded-lg px-4 py-2 text-sm text-gray-600 hover:bg-gray-100"
              >
                Cancel
              </button>
              {!payOrderData && (
                <button
                  onClick={handleProceedToPay}
                  disabled={payLoading}
                  className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark disabled:opacity-50"
                >
                  {payLoading ? "Creating Order..." : "Proceed to Pay"}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
