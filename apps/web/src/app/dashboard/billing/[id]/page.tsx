"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { api } from "@/lib/api";
import { Printer, ArrowLeft } from "lucide-react";

interface InvoiceDetail {
  id: string;
  invoiceNumber: string;
  totalAmount: number;
  subtotal: number;
  tax: number;
  discount: number;
  paymentStatus: string;
  createdAt: string;
  patient: {
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
    quantity: number;
    unitPrice: number;
    amount: number;
  }>;
  payments: Array<{
    id: string;
    amount: number;
    mode: string;
    paidAt: string;
    reference: string | null;
  }>;
}

export default function InvoiceDetailPage() {
  const params = useParams();
  const id = params.id as string;
  const [invoice, setInvoice] = useState<InvoiceDetail | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadInvoice();
  }, [id]);

  async function loadInvoice() {
    setLoading(true);
    try {
      const res = await api.get<{ data: InvoiceDetail }>(
        `/billing/invoices/${id}`
      );
      setInvoice(res.data);
    } catch {
      // empty
    }
    setLoading(false);
  }

  if (loading) {
    return (
      <div className="p-8 text-center text-gray-500">Loading invoice...</div>
    );
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

  const totalPaid = invoice.payments.reduce((s, p) => s + p.amount, 0);
  const balance = invoice.totalAmount - totalPaid;

  const statusColors: Record<string, string> = {
    PENDING: "bg-red-100 text-red-700",
    PARTIAL: "bg-yellow-100 text-yellow-700",
    PAID: "bg-green-100 text-green-700",
    REFUNDED: "bg-gray-100 text-gray-500",
  };

  return (
    <>
      {/* Print styles */}
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
      <div className="no-print mb-4 flex items-center justify-between">
        <Link
          href="/dashboard/billing"
          className="flex items-center gap-2 text-sm text-gray-600 hover:text-primary"
        >
          <ArrowLeft size={16} /> Back to Billing
        </Link>
        <button
          onClick={() => window.print()}
          className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark"
        >
          <Printer size={16} /> Print Invoice
        </button>
      </div>

      {/* Invoice content */}
      <div
        id="invoice-print"
        className="mx-auto max-w-3xl rounded-xl bg-white p-8 shadow-sm"
      >
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
            </div>
            <div className="text-right">
              <h2 className="text-lg font-semibold">INVOICE</h2>
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
            <p className="text-sm text-gray-600">
              MR#: {invoice.patient.mrNumber}
            </p>
            <p className="text-sm text-gray-600">
              {invoice.patient.age ? `${invoice.patient.age} yrs, ` : ""}
              {invoice.patient.gender}
            </p>
            <p className="text-sm text-gray-600">
              {invoice.patient.user.phone}
            </p>
            {invoice.patient.user.email && (
              <p className="text-sm text-gray-600">
                {invoice.patient.user.email}
              </p>
            )}
          </div>
          {invoice.appointment && (
            <div>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-400">
                Consultation
              </h3>
              <p className="font-medium">
                Dr. {invoice.appointment.doctor.user.name}
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
              </tr>
            </thead>
            <tbody>
              {invoice.items && invoice.items.length > 0 ? (
                invoice.items.map((item, i) => (
                  <tr key={item.id} className="border-b">
                    <td className="py-3 text-sm">{i + 1}</td>
                    <td className="py-3 text-sm">{item.description}</td>
                    <td className="py-3 text-center text-sm">
                      {item.quantity}
                    </td>
                    <td className="py-3 text-right text-sm">
                      Rs. {item.unitPrice.toFixed(2)}
                    </td>
                    <td className="py-3 text-right text-sm font-medium">
                      Rs. {item.amount.toFixed(2)}
                    </td>
                  </tr>
                ))
              ) : (
                <tr className="border-b">
                  <td className="py-3 text-sm">1</td>
                  <td className="py-3 text-sm">Consultation Charges</td>
                  <td className="py-3 text-center text-sm">1</td>
                  <td className="py-3 text-right text-sm">
                    Rs. {invoice.totalAmount.toFixed(2)}
                  </td>
                  <td className="py-3 text-right text-sm font-medium">
                    Rs. {invoice.totalAmount.toFixed(2)}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Totals */}
        <div className="mb-8 flex justify-end">
          <div className="w-64 space-y-2">
            {invoice.subtotal !== undefined && invoice.subtotal !== invoice.totalAmount && (
              <div className="flex justify-between text-sm">
                <span className="text-gray-500">Subtotal</span>
                <span>Rs. {invoice.subtotal.toFixed(2)}</span>
              </div>
            )}
            {invoice.tax > 0 && (
              <div className="flex justify-between text-sm">
                <span className="text-gray-500">Tax</span>
                <span>Rs. {invoice.tax.toFixed(2)}</span>
              </div>
            )}
            {invoice.discount > 0 && (
              <div className="flex justify-between text-sm">
                <span className="text-gray-500">Discount</span>
                <span className="text-green-600">
                  - Rs. {invoice.discount.toFixed(2)}
                </span>
              </div>
            )}
            <div className="flex justify-between border-t pt-2 font-semibold">
              <span>Total</span>
              <span>Rs. {invoice.totalAmount.toFixed(2)}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-gray-500">Paid</span>
              <span className="text-green-600">Rs. {totalPaid.toFixed(2)}</span>
            </div>
            {balance > 0 && (
              <div className="flex justify-between text-sm font-medium text-danger">
                <span>Balance Due</span>
                <span>Rs. {balance.toFixed(2)}</span>
              </div>
            )}
          </div>
        </div>

        {/* Payment History */}
        {invoice.payments.length > 0 && (
          <div className="mb-6">
            <h3 className="mb-3 text-sm font-semibold text-gray-700">
              Payment History
            </h3>
            <div className="rounded-lg border">
              <table className="w-full">
                <thead>
                  <tr className="border-b text-left text-xs text-gray-500">
                    <th className="px-3 py-2">Date</th>
                    <th className="px-3 py-2">Amount</th>
                    <th className="px-3 py-2">Mode</th>
                    <th className="px-3 py-2">Reference</th>
                  </tr>
                </thead>
                <tbody>
                  {invoice.payments.map((pmt) => (
                    <tr key={pmt.id} className="border-b last:border-0">
                      <td className="px-3 py-2 text-xs">
                        {new Date(pmt.paidAt).toLocaleString("en-IN")}
                      </td>
                      <td className="px-3 py-2 text-xs font-medium">
                        Rs. {pmt.amount.toFixed(2)}
                      </td>
                      <td className="px-3 py-2 text-xs">{pmt.mode}</td>
                      <td className="px-3 py-2 text-xs text-gray-500">
                        {pmt.reference || "---"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Footer */}
        <div className="border-t pt-4 text-center text-xs text-gray-400">
          <p>Thank you for choosing MedCore.</p>
          <p>This is a computer-generated invoice.</p>
        </div>
      </div>
    </>
  );
}
