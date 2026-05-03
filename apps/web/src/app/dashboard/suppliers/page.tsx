"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import { Truck, Plus, X, Mail, Phone, MapPin, FileText } from "lucide-react";

interface SupplierRecord {
  id: string;
  name: string;
  contactPerson?: string | null;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  gstNumber?: string | null;
  paymentTerms?: string | null;
  isActive: boolean;
  createdAt: string;
  contractStart?: string | null;
  contractEnd?: string | null;
  _count?: { purchaseOrders: number };
}

interface PORecord {
  id: string;
  poNumber: string;
  status: string;
  totalAmount: number;
  createdAt: string;
  items: Array<{ id: string; description: string }>;
}

interface SupplierDetail extends SupplierRecord {
  purchaseOrders: PORecord[];
}

export default function SuppliersPage() {
  const [suppliers, setSuppliers] = useState<SupplierRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<SupplierDetail | null>(null);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  async function load() {
    setLoading(true);
    try {
      const qs = search ? `?search=${encodeURIComponent(search)}` : "";
      const res = await api.get<{ data: SupplierRecord[] }>(`/suppliers${qs}`);
      setSuppliers(res.data);
    } catch {
      setSuppliers([]);
    }
    setLoading(false);
  }

  async function openDetail(id: string) {
    setSelectedId(id);
    setDetail(null);
    try {
      const res = await api.get<{ data: SupplierDetail }>(`/suppliers/${id}`);
      setDetail(res.data);
    } catch {
      setDetail(null);
    }
  }

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold">
            <Truck className="text-primary" size={28} /> Suppliers
          </h1>
          <p className="text-sm text-gray-500">Manage medicine and equipment vendors</p>
        </div>
        <button
          onClick={() => setShowAdd(true)}
          className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark"
        >
          <Plus size={16} /> Add Supplier
        </button>
      </div>

      <div className="mb-4">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search suppliers by name, contact or GST..."
          className="w-full max-w-sm rounded-lg border px-3 py-2 text-sm"
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr,400px]">
        <div className="rounded-xl bg-white shadow-sm">
          {loading ? (
            <div className="p-8 text-center text-gray-500">Loading...</div>
          ) : suppliers.length === 0 ? (
            <div className="p-8 text-center text-gray-500">No suppliers found</div>
          ) : (
            <table className="w-full">
              <thead>
                <tr className="border-b text-left text-sm text-gray-500">
                  <th className="px-4 py-3">Supplier</th>
                  <th className="px-4 py-3">Contact</th>
                  <th className="px-4 py-3">Phone</th>
                  <th className="px-4 py-3">Email</th>
                  <th className="px-4 py-3">GST #</th>
                  <th className="px-4 py-3">POs</th>
                </tr>
              </thead>
              <tbody>
                {suppliers.map((s) => (
                  <tr
                    key={s.id}
                    onClick={() => openDetail(s.id)}
                    className={`cursor-pointer border-b last:border-0 hover:bg-gray-50 ${
                      selectedId === s.id ? "bg-blue-50" : ""
                    }`}
                  >
                    <td className="px-4 py-3">
                      <p className="font-medium">{s.name}</p>
                      {s.paymentTerms && (
                        <p className="text-xs text-gray-500">{s.paymentTerms}</p>
                      )}
                    </td>
                    <td className="px-4 py-3 text-sm">
                      {s.contactPerson || "-"}
                    </td>
                    <td className="px-4 py-3 text-sm">{s.phone || "-"}</td>
                    <td className="px-4 py-3 text-sm">{s.email || "-"}</td>
                    <td className="px-4 py-3 font-mono text-xs">
                      {s.gstNumber || "-"}
                    </td>
                    <td className="px-4 py-3 text-sm">
                      {s._count?.purchaseOrders || 0}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {selectedId && (
          <aside className="rounded-xl bg-white p-5 shadow-sm">
            {!detail ? (
              <div className="text-sm text-gray-500">Loading...</div>
            ) : (
              <>
                <div className="mb-4 flex items-start justify-between">
                  <div>
                    <h2 className="text-lg font-bold">{detail.name}</h2>
                    {detail.contactPerson && (
                      <p className="text-sm text-gray-500">{detail.contactPerson}</p>
                    )}
                  </div>
                  <button
                    onClick={() => {
                      setSelectedId(null);
                      setDetail(null);
                    }}
                    className="text-gray-400 hover:text-gray-600"
                  >
                    <X size={20} />
                  </button>
                </div>

                <div className="mb-4 space-y-2 text-sm">
                  {detail.phone && (
                    <div className="flex items-center gap-2">
                      <Phone size={14} className="text-gray-400" />
                      <span>{detail.phone}</span>
                    </div>
                  )}
                  {detail.email && (
                    <div className="flex items-center gap-2">
                      <Mail size={14} className="text-gray-400" />
                      <span>{detail.email}</span>
                    </div>
                  )}
                  {detail.address && (
                    <div className="flex items-start gap-2">
                      <MapPin size={14} className="mt-0.5 text-gray-400" />
                      <span>{detail.address}</span>
                    </div>
                  )}
                  {detail.gstNumber && (
                    <div className="flex items-center gap-2">
                      <FileText size={14} className="text-gray-400" />
                      <span className="font-mono">{detail.gstNumber}</span>
                    </div>
                  )}
                </div>

                <SupplierContractPanel
                  supplier={detail}
                  onUpdated={(s) => {
                    setDetail({ ...detail, ...s });
                  }}
                />

                <div>
                  <h3 className="mb-2 text-sm font-semibold text-gray-700">
                    Recent Purchase Orders
                  </h3>
                  {detail.purchaseOrders.length === 0 ? (
                    <p className="text-sm text-gray-500">No purchase orders yet</p>
                  ) : (
                    <ul className="space-y-2">
                      {detail.purchaseOrders.map((po) => (
                        <li
                          key={po.id}
                          className="rounded-lg border px-3 py-2 text-sm"
                        >
                          <div className="flex justify-between">
                            <span className="font-mono text-xs">{po.poNumber}</span>
                            <span
                              className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusBadge(po.status)}`}
                            >
                              {po.status}
                            </span>
                          </div>
                          <div className="mt-1 flex justify-between text-xs text-gray-500">
                            <span>{po.items.length} items</span>
                            <span>Rs. {po.totalAmount.toFixed(2)}</span>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </>
            )}
          </aside>
        )}
      </div>

      {showAdd && (
        <AddSupplierModal
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

function AddSupplierModal({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState({
    name: "",
    contactPerson: "",
    phone: "",
    email: "",
    address: "",
    gstNumber: "",
    paymentTerms: "",
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const body: Record<string, unknown> = { name: form.name };
      for (const k of [
        "contactPerson",
        "phone",
        "email",
        "address",
        "gstNumber",
        "paymentTerms",
      ] as const) {
        if (form[k]) body[k] = form[k];
      }
      await api.post("/suppliers", body);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save supplier");
    }
    setSaving(false);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-xl bg-white p-6 shadow-2xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-bold">Add Supplier</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X size={20} />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label htmlFor="add-supplier-name" className="mb-1 block text-sm font-medium">Name *</label>
            <input
              id="add-supplier-name"
              required
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              className="w-full rounded-lg border px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label htmlFor="add-supplier-contact-person" className="mb-1 block text-sm font-medium">Contact Person</label>
            <input
              id="add-supplier-contact-person"
              value={form.contactPerson}
              onChange={(e) => setForm({ ...form, contactPerson: e.target.value })}
              className="w-full rounded-lg border px-3 py-2 text-sm"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="add-supplier-phone" className="mb-1 block text-sm font-medium">Phone</label>
              <input
                id="add-supplier-phone"
                value={form.phone}
                onChange={(e) => setForm({ ...form, phone: e.target.value })}
                className="w-full rounded-lg border px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label htmlFor="add-supplier-email" className="mb-1 block text-sm font-medium">Email</label>
              <input
                id="add-supplier-email"
                type="email"
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
                className="w-full rounded-lg border px-3 py-2 text-sm"
              />
            </div>
          </div>
          <div>
            <label htmlFor="add-supplier-address" className="mb-1 block text-sm font-medium">Address</label>
            <textarea
              id="add-supplier-address"
              rows={2}
              value={form.address}
              onChange={(e) => setForm({ ...form, address: e.target.value })}
              className="w-full rounded-lg border px-3 py-2 text-sm"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="add-supplier-gst" className="mb-1 block text-sm font-medium">GST Number</label>
              <input
                id="add-supplier-gst"
                value={form.gstNumber}
                onChange={(e) => setForm({ ...form, gstNumber: e.target.value })}
                className="w-full rounded-lg border px-3 py-2 font-mono text-sm"
              />
            </div>
            <div>
              <label htmlFor="add-supplier-payment-terms" className="mb-1 block text-sm font-medium">Payment Terms</label>
              <input
                id="add-supplier-payment-terms"
                placeholder="Net 30, Net 60..."
                value={form.paymentTerms}
                onChange={(e) => setForm({ ...form, paymentTerms: e.target.value })}
                className="w-full rounded-lg border px-3 py-2 text-sm"
              />
            </div>
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
              {saving ? "Saving..." : "Create Supplier"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function SupplierContractPanel({
  supplier,
  onUpdated,
}: {
  supplier: SupplierDetail;
  onUpdated: (s: Partial<SupplierDetail>) => void;
}) {
  const [edit, setEdit] = useState(false);
  const [start, setStart] = useState(
    supplier.contractStart ? supplier.contractStart.slice(0, 10) : ""
  );
  const [end, setEnd] = useState(
    supplier.contractEnd ? supplier.contractEnd.slice(0, 10) : ""
  );
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    try {
      await api.patch(`/suppliers/${supplier.id}`, {
        contractStart: start || undefined,
        contractEnd: end || undefined,
      });
      onUpdated({ contractStart: start || null, contractEnd: end || null });
      setEdit(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Save failed");
    }
    setSaving(false);
  }

  const daysLeft = supplier.contractEnd
    ? Math.ceil(
        (new Date(supplier.contractEnd).getTime() - Date.now()) /
          (24 * 60 * 60 * 1000)
      )
    : null;
  const expiringSoon = daysLeft !== null && daysLeft >= 0 && daysLeft <= 30;
  const expired = daysLeft !== null && daysLeft < 0;

  return (
    <div className="mb-4 rounded-lg border bg-gray-50 p-3">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-700">Contract</h3>
        {!edit && (
          <button
            onClick={() => setEdit(true)}
            className="rounded border px-2 py-0.5 text-xs hover:bg-white"
          >
            {supplier.contractStart || supplier.contractEnd ? "Edit" : "Add"}
          </button>
        )}
      </div>
      {edit ? (
        <div className="space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-xs text-gray-500">Start</label>
              <input
                type="date"
                value={start}
                onChange={(e) => setStart(e.target.value)}
                className="w-full rounded border px-2 py-1 text-sm"
              />
            </div>
            <div>
              <label className="text-xs text-gray-500">End</label>
              <input
                type="date"
                value={end}
                onChange={(e) => setEnd(e.target.value)}
                className="w-full rounded border px-2 py-1 text-sm"
              />
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <button
              onClick={() => setEdit(false)}
              className="rounded border px-3 py-1 text-xs"
            >
              Cancel
            </button>
            <button
              onClick={save}
              disabled={saving}
              className="rounded bg-primary px-3 py-1 text-xs text-white disabled:opacity-50"
            >
              {saving ? "..." : "Save"}
            </button>
          </div>
        </div>
      ) : (
        <div className="text-xs text-gray-700">
          {supplier.contractStart || supplier.contractEnd ? (
            <>
              <p>
                <span className="text-gray-500">Start:</span>{" "}
                {supplier.contractStart
                  ? new Date(supplier.contractStart).toLocaleDateString()
                  : "—"}
              </p>
              <p>
                <span className="text-gray-500">End:</span>{" "}
                {supplier.contractEnd
                  ? new Date(supplier.contractEnd).toLocaleDateString()
                  : "—"}
                {expiringSoon && (
                  <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-800">
                    Expiring Soon ({daysLeft}d)
                  </span>
                )}
                {expired && (
                  <span className="ml-2 rounded-full bg-red-100 px-2 py-0.5 text-[10px] font-semibold text-red-700">
                    Expired
                  </span>
                )}
              </p>
            </>
          ) : (
            <p className="text-gray-500">No contract dates set.</p>
          )}
        </div>
      )}
    </div>
  );
}
