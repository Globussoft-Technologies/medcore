"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, usePathname } from "next/navigation";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import { useConfirm } from "@/lib/use-dialog";
import { useAuthStore } from "@/lib/store";
import { ShoppingCart, Plus, X, Trash2 } from "lucide-react";

// Issue #509: page-level gate matching API authorize() in
// apps/api/src/routes/purchase-orders.ts (ADMIN, RECEPTION, PHARMACIST on
// reads). Page previously had no gate, so NURSE / DOCTOR / PATIENT could
// navigate to /dashboard/purchase-orders and see the procurement chrome.
const VIEW_ALLOWED = new Set(["ADMIN", "RECEPTION", "PHARMACIST"]);

interface Supplier {
  id: string;
  name: string;
}

interface POItem {
  id: string;
  description: string;
  quantity: number;
  unitPrice: number;
  amount: number;
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
  createdAt: string;
  supplier: Supplier;
  items: POItem[];
}

interface Medicine {
  id: string;
  name: string;
  strength?: string | null;
}

const TABS = ["DRAFT", "PENDING", "APPROVED", "RECEIVED", "ALL"] as const;
type Tab = (typeof TABS)[number];

export default function PurchaseOrdersPage() {
  const { user, isLoading } = useAuthStore();
  const router = useRouter();
  const pathname = usePathname();
  const confirm = useConfirm();
  const [orders, setOrders] = useState<PORecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>("ALL");
  const [showNew, setShowNew] = useState(false);

  // Issue #509: redirect non-allowed roles to /dashboard/not-authorized.
  useEffect(() => {
    if (!isLoading && user && !VIEW_ALLOWED.has(user.role)) {
      toast.error("Purchase orders are restricted to Admin, Reception and Pharmacist.");
      router.replace(
        `/dashboard/not-authorized?from=${encodeURIComponent(pathname || "/dashboard/purchase-orders")}`,
      );
    }
  }, [user, isLoading, router, pathname]);

  useEffect(() => {
    load();
  }, [tab]);

  async function load() {
    setLoading(true);
    try {
      const qs = tab === "ALL" ? "" : `?status=${tab}`;
      const res = await api.get<{ data: PORecord[] }>(`/purchase-orders${qs}`);
      setOrders(res.data);
    } catch {
      setOrders([]);
    }
    setLoading(false);
  }

  async function actOn(id: string, action: "submit" | "approve" | "receive" | "cancel") {
    const titles: Record<string, string> = {
      submit: "Submit this PO for approval?",
      approve: "Approve this PO?",
      receive: "Mark as received?",
      cancel: "Cancel this PO?",
    };
    const messages: Record<string, string | undefined> = {
      submit: undefined,
      approve: undefined,
      receive: "This will update inventory.",
      cancel: undefined,
    };
    if (!(await confirm({ title: titles[action], message: messages[action], danger: action === "cancel" }))) return;
    try {
      await api.post(`/purchase-orders/${id}/${action}`, {});
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Action failed");
    }
  }

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold">
            <ShoppingCart className="text-primary" size={28} /> Purchase Orders
          </h1>
          <p className="text-sm text-gray-500">
            Manage procurement from suppliers
          </p>
        </div>
        <button
          onClick={() => setShowNew(true)}
          className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark"
        >
          <Plus size={16} /> New PO
        </button>
      </div>

      <div className="mb-4 flex gap-2 border-b">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium ${
              tab === t
                ? "border-b-2 border-primary text-primary"
                : "text-gray-500 hover:text-gray-700"
            }`}
          >
            {t === "ALL" ? "All" : t.charAt(0) + t.slice(1).toLowerCase()}
          </button>
        ))}
      </div>

      <div className="rounded-xl bg-white shadow-sm">
        {loading ? (
          <div className="p-8 text-center text-gray-500">Loading...</div>
        ) : orders.length === 0 ? (
          <div className="p-8 text-center text-gray-500">No purchase orders found</div>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="border-b text-left text-sm text-gray-500">
                <th className="px-4 py-3">PO #</th>
                <th className="px-4 py-3">Supplier</th>
                <th className="px-4 py-3">Items</th>
                <th className="px-4 py-3">Total</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Created</th>
                <th className="px-4 py-3">Actions</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((po) => (
                <tr key={po.id} className="border-b last:border-0 hover:bg-gray-50">
                  <td className="px-4 py-3 font-mono text-sm">
                    <Link
                      href={`/dashboard/purchase-orders/${po.id}`}
                      className="text-primary hover:underline"
                    >
                      {po.poNumber}
                    </Link>
                  </td>
                  <td className="px-4 py-3">{po.supplier.name}</td>
                  <td className="px-4 py-3 text-sm text-gray-600">
                    {po.items.length}
                  </td>
                  <td className="px-4 py-3 font-medium">
                    Rs. {po.totalAmount.toFixed(2)}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${statusBadge(po.status)}`}
                    >
                      {po.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-500">
                    {new Date(po.createdAt).toLocaleDateString("en-IN")}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1">
                      {po.status === "DRAFT" && (
                        <button
                          onClick={() => actOn(po.id, "submit")}
                          className="rounded bg-yellow-500 px-2 py-1 text-xs text-white hover:bg-yellow-600"
                        >
                          Submit
                        </button>
                      )}
                      {po.status === "PENDING" && (
                        <button
                          onClick={() => actOn(po.id, "approve")}
                          className="rounded bg-blue-600 px-2 py-1 text-xs text-white hover:bg-blue-700"
                        >
                          Approve
                        </button>
                      )}
                      {po.status === "APPROVED" && (
                        <button
                          onClick={() => actOn(po.id, "receive")}
                          className="rounded bg-green-600 px-2 py-1 text-xs text-white hover:bg-green-700"
                        >
                          Receive
                        </button>
                      )}
                      {po.status !== "CANCELLED" &&
                        po.status !== "RECEIVED" && (
                          <button
                            onClick={() => actOn(po.id, "cancel")}
                            className="rounded bg-red-500 px-2 py-1 text-xs text-white hover:bg-red-600"
                          >
                            Cancel
                          </button>
                        )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {showNew && (
        <NewPOModal
          onClose={() => setShowNew(false)}
          onSaved={() => {
            setShowNew(false);
            load();
          }}
        />
      )}
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

interface LineItem {
  description: string;
  medicineId?: string;
  quantity: string;
  unitPrice: string;
}

function NewPOModal({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: () => void;
}) {
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [medicines, setMedicines] = useState<Medicine[]>([]);
  const [supplierId, setSupplierId] = useState("");
  const [expectedAt, setExpectedAt] = useState("");
  const [notes, setNotes] = useState("");
  const [taxPercentage, setTaxPercentage] = useState("0");
  const [items, setItems] = useState<LineItem[]>([
    { description: "", quantity: "1", unitPrice: "" },
  ]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const s = await api.get<{ data: Supplier[] }>("/suppliers");
        setSuppliers(s.data);
      } catch {
        setSuppliers([]);
      }
      try {
        const m = await api.get<{ data: Medicine[] }>("/medicines?limit=200");
        setMedicines(m.data);
      } catch {
        setMedicines([]);
      }
    })();
  }, []);

  const subtotal = items.reduce((sum, it) => {
    const q = parseFloat(it.quantity) || 0;
    const p = parseFloat(it.unitPrice) || 0;
    return sum + q * p;
  }, 0);
  const tax = (subtotal * (parseFloat(taxPercentage) || 0)) / 100;
  const total = subtotal + tax;

  function addRow() {
    setItems([...items, { description: "", quantity: "1", unitPrice: "" }]);
  }

  function removeRow(i: number) {
    setItems(items.filter((_, idx) => idx !== i));
  }

  function updateRow(i: number, field: keyof LineItem, value: string) {
    const next = [...items];
    const row = { ...next[i], [field]: value };
    // If medicineId is set, auto-fill description
    if (field === "medicineId") {
      const med = medicines.find((m) => m.id === value);
      if (med) {
        row.description = med.name + (med.strength ? ` ${med.strength}` : "");
      }
    }
    next[i] = row;
    setItems(next);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const body = {
        supplierId,
        items: items.map((it) => ({
          description: it.description,
          medicineId: it.medicineId || undefined,
          quantity: parseFloat(it.quantity),
          unitPrice: parseFloat(it.unitPrice),
        })),
        taxPercentage: parseFloat(taxPercentage) || 0,
        expectedAt: expectedAt || undefined,
        notes: notes || undefined,
      };
      await api.post("/purchase-orders", body);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create PO");
    }
    setSaving(false);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-xl bg-white p-6 shadow-2xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-bold">New Purchase Order</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X size={20} />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-sm font-medium">Supplier *</label>
              <select
                required
                value={supplierId}
                onChange={(e) => setSupplierId(e.target.value)}
                className="w-full rounded-lg border px-3 py-2 text-sm"
              >
                <option value="">Select supplier</option>
                {suppliers.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium">Expected Date</label>
              <input
                type="date"
                value={expectedAt}
                onChange={(e) => setExpectedAt(e.target.value)}
                className="w-full rounded-lg border px-3 py-2 text-sm"
              />
            </div>
          </div>

          <div>
            <div className="mb-2 flex items-center justify-between">
              <label className="text-sm font-medium">Line Items</label>
              <button
                type="button"
                onClick={addRow}
                className="text-xs font-medium text-primary hover:underline"
              >
                + Add Row
              </button>
            </div>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-gray-500">
                  <th className="py-1">Medicine (optional)</th>
                  <th className="py-1">Description *</th>
                  <th className="py-1 w-20">Qty</th>
                  <th className="py-1 w-24">Unit Price</th>
                  <th className="py-1 w-24">Amount</th>
                  <th className="py-1 w-8"></th>
                </tr>
              </thead>
              <tbody>
                {items.map((it, i) => {
                  const q = parseFloat(it.quantity) || 0;
                  const p = parseFloat(it.unitPrice) || 0;
                  return (
                    <tr key={i} className="border-b last:border-0">
                      <td className="py-1 pr-2">
                        <select
                          value={it.medicineId || ""}
                          onChange={(e) => updateRow(i, "medicineId", e.target.value)}
                          className="w-full rounded border px-2 py-1 text-xs"
                        >
                          <option value="">-- custom --</option>
                          {medicines.map((m) => (
                            <option key={m.id} value={m.id}>
                              {m.name}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="py-1 pr-2">
                        <input
                          required
                          value={it.description}
                          onChange={(e) => updateRow(i, "description", e.target.value)}
                          className="w-full rounded border px-2 py-1 text-xs"
                        />
                      </td>
                      <td className="py-1 pr-2">
                        <input
                          required
                          type="number"
                          min="1"
                          value={it.quantity}
                          onChange={(e) => updateRow(i, "quantity", e.target.value)}
                          className="w-full rounded border px-2 py-1 text-xs"
                        />
                      </td>
                      <td className="py-1 pr-2">
                        <input
                          required
                          type="number"
                          min="0.01"
                          step="0.01"
                          value={it.unitPrice}
                          onChange={(e) => updateRow(i, "unitPrice", e.target.value)}
                          className="w-full rounded border px-2 py-1 text-xs"
                        />
                      </td>
                      <td className="py-1 pr-2 text-xs">
                        Rs. {(q * p).toFixed(2)}
                      </td>
                      <td className="py-1">
                        {items.length > 1 && (
                          <button
                            type="button"
                            onClick={() => removeRow(i)}
                            className="text-red-500 hover:text-red-700"
                          >
                            <Trash2 size={14} />
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-sm font-medium">Tax %</label>
              <input
                type="number"
                min="0"
                max="100"
                step="0.01"
                value={taxPercentage}
                onChange={(e) => setTaxPercentage(e.target.value)}
                className="w-full rounded-lg border px-3 py-2 text-sm"
              />
            </div>
            <div className="rounded-lg bg-gray-50 p-3 text-sm">
              <div className="flex justify-between">
                <span className="text-gray-500">Subtotal</span>
                <span>Rs. {subtotal.toFixed(2)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Tax</span>
                <span>Rs. {tax.toFixed(2)}</span>
              </div>
              <div className="mt-1 flex justify-between border-t pt-1 font-semibold">
                <span>Total</span>
                <span>Rs. {total.toFixed(2)}</span>
              </div>
            </div>
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium">Notes</label>
            <textarea
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="w-full rounded-lg border px-3 py-2 text-sm"
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
              {saving ? "Creating..." : "Create Draft PO"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
