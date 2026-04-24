"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import { useConfirm } from "@/lib/use-dialog";
import { ArrowLeft, Printer, Check, Send, Package, X } from "lucide-react";

interface POItem {
  id: string;
  description: string;
  medicineId?: string | null;
  quantity: number;
  unitPrice: number;
  amount: number;
  medicine?: { id: string; name: string; strength?: string | null } | null;
}

interface PORecord {
  id: string;
  poNumber: string;
  status: "DRAFT" | "PENDING" | "APPROVED" | "RECEIVED" | "CANCELLED";
  orderedAt: string;
  expectedAt?: string | null;
  receivedAt?: string | null;
  subtotal: number;
  taxAmount: number;
  totalAmount: number;
  notes?: string | null;
  createdAt: string;
  updatedAt: string;
  supplier: {
    id: string;
    name: string;
    contactPerson?: string | null;
    phone?: string | null;
    email?: string | null;
    gstNumber?: string | null;
    address?: string | null;
  };
  items: POItem[];
}

const STATUS_FLOW = ["DRAFT", "PENDING", "APPROVED", "RECEIVED"];

export default function PurchaseOrderDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const confirm = useConfirm();
  const [po, setPo] = useState<PORecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState(false);
  const [showReceiveModal, setShowReceiveModal] = useState(false);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params?.id]);

  async function load() {
    if (!params?.id) return;
    setLoading(true);
    try {
      const res = await api.get<{ data: PORecord }>(`/purchase-orders/${params.id}`);
      setPo(res.data);
    } catch {
      setPo(null);
    }
    setLoading(false);
  }

  async function act(action: "submit" | "approve" | "cancel") {
    if (!po) return;
    const titles: Record<string, string> = {
      submit: "Submit this PO for approval?",
      approve: "Approve this PO?",
      cancel: "Cancel this PO?",
    };
    const messages: Record<string, string | undefined> = {
      submit: undefined,
      approve: undefined,
      cancel: "This cannot be undone.",
    };
    if (!(await confirm({ title: titles[action], message: messages[action], danger: action === "cancel" }))) return;
    setActing(true);
    try {
      await api.post(`/purchase-orders/${po.id}/${action}`, {});
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Action failed");
    }
    setActing(false);
  }

  if (loading) {
    return <div className="py-16 text-center text-gray-500">Loading...</div>;
  }

  if (!po) {
    return (
      <div>
        <Link
          href="/dashboard/purchase-orders"
          className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
        >
          <ArrowLeft size={14} /> Back
        </Link>
        <div className="mt-8 text-center text-gray-500">Purchase order not found</div>
      </div>
    );
  }

  const currentStep = STATUS_FLOW.indexOf(po.status);
  const isCancelled = po.status === "CANCELLED";

  return (
    <div>
      <div className="mb-4 flex items-center justify-between print:hidden">
        <button
          onClick={() => router.back()}
          className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
        >
          <ArrowLeft size={14} /> Back
        </button>
        <div className="flex gap-2">
          <button
            onClick={() => window.print()}
            className="inline-flex items-center gap-1.5 rounded-lg border bg-white px-3 py-2 text-sm hover:bg-gray-50"
          >
            <Printer size={14} /> Print
          </button>
          {po.status === "DRAFT" && (
            <button
              onClick={() => act("submit")}
              disabled={acting}
              className="inline-flex items-center gap-1.5 rounded-lg bg-yellow-500 px-3 py-2 text-sm text-white hover:bg-yellow-600 disabled:opacity-50"
            >
              <Send size={14} /> Submit
            </button>
          )}
          {po.status === "PENDING" && (
            <button
              onClick={() => act("approve")}
              disabled={acting}
              className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-2 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
            >
              <Check size={14} /> Approve
            </button>
          )}
          {po.status === "APPROVED" && (
            <button
              onClick={() => setShowReceiveModal(true)}
              disabled={acting}
              className="inline-flex items-center gap-1.5 rounded-lg bg-green-600 px-3 py-2 text-sm text-white hover:bg-green-700 disabled:opacity-50"
            >
              <Package size={14} /> Receive
            </button>
          )}
          {!isCancelled && po.status !== "RECEIVED" && (
            <button
              onClick={() => act("cancel")}
              disabled={acting}
              className="inline-flex items-center gap-1.5 rounded-lg bg-red-500 px-3 py-2 text-sm text-white hover:bg-red-600 disabled:opacity-50"
            >
              <X size={14} /> Cancel
            </button>
          )}
        </div>
      </div>

      <div className="rounded-xl bg-white p-6 shadow-sm">
        <div className="mb-6 flex items-start justify-between border-b pb-4">
          <div>
            <p className="text-sm text-gray-500">Purchase Order</p>
            <h1 className="font-mono text-2xl font-bold">{po.poNumber}</h1>
            <p className="mt-1 text-sm text-gray-500">
              Created {new Date(po.createdAt).toLocaleString("en-IN")}
            </p>
          </div>
          <span
            className={`rounded-full px-3 py-1 text-sm font-medium ${statusBadge(po.status)}`}
          >
            {po.status}
          </span>
        </div>

        {!isCancelled && (
          <div className="mb-6 rounded-lg bg-gray-50 p-4">
            <div className="flex items-center justify-between">
              {STATUS_FLOW.map((step, i) => (
                <div key={step} className="flex flex-1 items-center">
                  <div
                    className={`flex h-8 w-8 items-center justify-center rounded-full text-xs font-bold ${
                      i <= currentStep
                        ? "bg-primary text-white"
                        : "bg-gray-200 text-gray-500"
                    }`}
                  >
                    {i + 1}
                  </div>
                  <span
                    className={`ml-2 text-xs ${
                      i <= currentStep ? "font-medium" : "text-gray-500"
                    }`}
                  >
                    {step}
                  </span>
                  {i < STATUS_FLOW.length - 1 && (
                    <div
                      className={`mx-2 h-0.5 flex-1 ${
                        i < currentStep ? "bg-primary" : "bg-gray-200"
                      }`}
                    />
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="mb-6 grid gap-6 md:grid-cols-2">
          <div>
            <h3 className="mb-2 text-sm font-semibold text-gray-700">Supplier</h3>
            <p className="font-medium">{po.supplier.name}</p>
            {po.supplier.contactPerson && (
              <p className="text-sm text-gray-600">{po.supplier.contactPerson}</p>
            )}
            {po.supplier.phone && (
              <p className="text-sm text-gray-600">{po.supplier.phone}</p>
            )}
            {po.supplier.email && (
              <p className="text-sm text-gray-600">{po.supplier.email}</p>
            )}
            {po.supplier.address && (
              <p className="mt-1 text-sm text-gray-600">{po.supplier.address}</p>
            )}
            {po.supplier.gstNumber && (
              <p className="mt-1 font-mono text-xs text-gray-500">
                GST: {po.supplier.gstNumber}
              </p>
            )}
          </div>

          <div>
            <h3 className="mb-2 text-sm font-semibold text-gray-700">Timeline</h3>
            <div className="space-y-1 text-sm">
              <div className="flex justify-between">
                <span className="text-gray-500">Ordered</span>
                <span>{new Date(po.orderedAt).toLocaleDateString("en-IN")}</span>
              </div>
              {po.expectedAt && (
                <div className="flex justify-between">
                  <span className="text-gray-500">Expected</span>
                  <span>{new Date(po.expectedAt).toLocaleDateString("en-IN")}</span>
                </div>
              )}
              {po.receivedAt && (
                <div className="flex justify-between">
                  <span className="text-gray-500">Received</span>
                  <span>{new Date(po.receivedAt).toLocaleDateString("en-IN")}</span>
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="mb-6">
          <h3 className="mb-2 text-sm font-semibold text-gray-700">Items</h3>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs text-gray-500">
                <th className="py-2">Description</th>
                <th className="py-2 w-20 text-right">Qty</th>
                <th className="py-2 w-28 text-right">Unit Price</th>
                <th className="py-2 w-28 text-right">Amount</th>
              </tr>
            </thead>
            <tbody>
              {po.items.map((it) => (
                <tr key={it.id} className="border-b last:border-0">
                  <td className="py-2">
                    <p>{it.description}</p>
                    {it.medicine && (
                      <p className="text-xs text-gray-500">
                        Linked to medicine: {it.medicine.name}
                      </p>
                    )}
                  </td>
                  <td className="py-2 text-right">{it.quantity}</td>
                  <td className="py-2 text-right">Rs. {it.unitPrice.toFixed(2)}</td>
                  <td className="py-2 text-right font-medium">
                    Rs. {it.amount.toFixed(2)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="ml-auto max-w-xs space-y-1 text-sm">
          <div className="flex justify-between">
            <span className="text-gray-500">Subtotal</span>
            <span>Rs. {po.subtotal.toFixed(2)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-500">Tax</span>
            <span>Rs. {po.taxAmount.toFixed(2)}</span>
          </div>
          <div className="flex justify-between border-t pt-1 text-base font-bold">
            <span>Total</span>
            <span>Rs. {po.totalAmount.toFixed(2)}</span>
          </div>
        </div>

        {po.notes && (
          <div className="mt-6 border-t pt-4">
            <h3 className="mb-1 text-sm font-semibold text-gray-700">Notes</h3>
            <p className="whitespace-pre-line text-sm text-gray-600">{po.notes}</p>
          </div>
        )}
      </div>

      {showReceiveModal && (
        <ReceiveGrnModal
          po={po}
          onClose={() => setShowReceiveModal(false)}
          onSaved={() => {
            setShowReceiveModal(false);
            load();
          }}
        />
      )}
    </div>
  );
}

function ReceiveGrnModal({
  po,
  onClose,
  onSaved,
}: {
  po: PORecord;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [quantities, setQuantities] = useState<Record<string, string>>(() => {
    const m: Record<string, string> = {};
    for (const it of po.items) m[it.id] = String(it.quantity);
    return m;
  });
  const [notes, setNotes] = useState("");
  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit() {
    setSaving(true);
    try {
      const receivedItems = po.items.map((it) => ({
        itemId: it.id,
        receivedQuantity: Number(quantities[it.id] || 0),
      }));
      await api.post(`/purchase-orders/${po.id}/receive`, {
        receivedItems,
        notes: notes || undefined,
        invoiceNumber: invoiceNumber || undefined,
      });
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Receipt failed");
    }
    setSaving(false);
  }

  const hasShortfall = po.items.some(
    (it) => Number(quantities[it.id] || 0) < it.quantity
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl bg-white p-6 shadow-2xl">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-lg font-semibold">Receive Goods (GRN)</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            ✕
          </button>
        </div>
        <p className="mb-4 text-xs text-gray-500">
          Enter quantities received. If less than ordered, the PO remains
          APPROVED for further partial receipts.
        </p>

        <table className="mb-4 w-full text-sm">
          <thead>
            <tr className="border-b text-left text-xs text-gray-500">
              <th className="py-2">Item</th>
              <th className="w-24 py-2 text-right">Ordered</th>
              <th className="w-32 py-2 text-right">Received Now</th>
            </tr>
          </thead>
          <tbody>
            {po.items.map((it) => (
              <tr key={it.id} className="border-b last:border-0">
                <td className="py-2">
                  <p>{it.description}</p>
                  {it.medicine && (
                    <p className="text-xs text-gray-500">{it.medicine.name}</p>
                  )}
                </td>
                <td className="py-2 text-right">{it.quantity}</td>
                <td className="py-2 text-right">
                  <input
                    type="number"
                    min={0}
                    max={it.quantity}
                    value={quantities[it.id]}
                    onChange={(e) =>
                      setQuantities((q) => ({ ...q, [it.id]: e.target.value }))
                    }
                    className="w-24 rounded border px-2 py-1 text-right"
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="mb-3 grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1 block text-xs text-gray-600">
              Supplier Invoice #
            </label>
            <input
              value={invoiceNumber}
              onChange={(e) => setInvoiceNumber(e.target.value)}
              className="w-full rounded border px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-gray-600">Notes</label>
            <input
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="w-full rounded border px-3 py-2 text-sm"
            />
          </div>
        </div>

        {hasShortfall && (
          <div className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
            Partial receipt: PO will remain APPROVED so more deliveries can be
            recorded.
          </div>
        )}

        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-lg border px-4 py-2 text-sm text-gray-600 hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={saving}
            className="rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50"
          >
            {saving ? "Saving..." : hasShortfall ? "Record Partial Receipt" : "Receive All"}
          </button>
        </div>
      </div>
    </div>
  );
}

function statusBadge(status: string) {
  switch (status) {
    case "DRAFT":
      return "bg-gray-100 text-gray-700";
    case "PENDING":
      return "bg-yellow-100 text-yellow-700";
    case "APPROVED":
      return "bg-blue-100 text-blue-700";
    case "RECEIVED":
      return "bg-green-100 text-green-700";
    case "CANCELLED":
      return "bg-red-100 text-red-700";
    default:
      return "bg-gray-100 text-gray-700";
  }
}
