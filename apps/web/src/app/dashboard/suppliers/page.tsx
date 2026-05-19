"use client";

// Issue #692 (BUG-A08, 2026-05-09): admin Suppliers/Holidays/Insurance
// surfaces lacked Edit affordances; Suppliers also lacked a way to
// deactivate a vendor without DELETE'ing (we soft-deactivate via
// `isActive: false`). This file adds:
//   - per-row Edit dialog (form: name, phone, GST, address,
//     contactPerson, paymentTerms, isActive)
//   - per-row Deactivate / Activate toggle (PATCH `isActive`, NOT DELETE
//     — keeps PO history queryable)
// Both go through `PATCH /api/v1/suppliers/:id` which already exists and
// is ADMIN-only. Edit pre-fills from the row data; Deactivate is a one-
// click PATCH with a confirm prompt.

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import { useConfirm } from "@/lib/use-dialog";
import { Truck, Plus, X, Mail, Phone, MapPin, FileText, Edit2, Power, Search } from "lucide-react";

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
  // Issue #692: per-row Edit dialog state. Stores the row being edited;
  // null means the dialog is closed.
  const [editingSupplier, setEditingSupplier] =
    useState<SupplierRecord | null>(null);
  // Issue #692: toggle to show deactivated suppliers (for re-activation
  // workflows). Defaults to false so the list stays focused on active
  // vendors; flipping it queries the API with active=false.
  const [showInactive, setShowInactive] = useState(false);
  const confirm = useConfirm();

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, showInactive]);

  async function load() {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (search) params.set("search", search);
      // Issue #692: showInactive=true → request the deactivated rows so
      // admins can reactivate them. The API supports active=true|false;
      // when not set it defaults to active=true (active-only).
      if (showInactive) params.set("active", "false");
      const qs = params.toString() ? `?${params.toString()}` : "";
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

  // Issue #692: deactivate (or reactivate) a supplier. We soft-toggle
  // `isActive` rather than DELETE so PO history stays queryable. The
  // GET /suppliers list defaults to `?active=true` so deactivated rows
  // disappear from the default view; admins can re-list them with the
  // search box (or by passing `?active=false` directly).
  async function toggleActive(s: SupplierRecord) {
    const verb = s.isActive ? "Deactivate" : "Activate";
    const body = s.isActive
      ? `${s.name} will be hidden from the default suppliers list. Past POs and payments are preserved.`
      : `${s.name} will become available again for new purchase orders.`;
    if (
      !(await confirm({
        title: `${verb} ${s.name}?`,
        message: body,
        confirmLabel: verb,
        danger: s.isActive,
      }))
    ) {
      return;
    }
    try {
      await api.patch(`/suppliers/${s.id}`, { isActive: !s.isActive });
      toast.success(`${verb}d ${s.name}`);
      // If we deactivated the row currently in the detail panel, drop it
      // from the panel (it'll be hidden from the default list anyway).
      if (s.isActive && selectedId === s.id) {
        setSelectedId(null);
        setDetail(null);
      }
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : `Failed to ${verb.toLowerCase()}`);
    }
  }

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold text-gray-900 dark:text-gray-100">
            <Truck className="text-primary" size={28} /> Suppliers
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">Manage medicine and equipment vendors</p>
        </div>
        <button
          onClick={() => setShowAdd(true)}
          className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark"
        >
          <Plus size={16} /> Add Supplier
        </button>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        {/* Issue #832: left search icon to match the Asset Management /
            patients / icd10 search pattern. The relative wrapper plus the
            absolutely-positioned icon mirrors the convention so the visual
            language of "this is a search field" is consistent across
            modules. `pl-9` reserves space so the placeholder/value never
            overlaps the glyph. */}
        <div className="relative w-full max-w-sm">
          <Search
            size={16}
            aria-hidden="true"
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 dark:text-gray-400"
          />
          <label htmlFor="suppliers-search" className="sr-only">
            Search suppliers
          </label>
          <input
            id="suppliers-search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search suppliers by name, contact or GST..."
            className="w-full rounded-lg border border-gray-300 bg-white pl-9 pr-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100 dark:placeholder:text-gray-500"
          />
        </div>
        {/* Issue #692: toggle to show deactivated suppliers — needed
            for the re-activation workflow. */}
        <label className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-300">
          <input
            type="checkbox"
            checked={showInactive}
            onChange={(e) => setShowInactive(e.target.checked)}
            data-testid="suppliers-show-inactive"
            className="rounded"
          />
          Show deactivated
        </label>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr,400px]">
        <div className="rounded-xl bg-white shadow-sm dark:bg-gray-800">
          {loading ? (
            <div className="p-8 text-center text-gray-500 dark:text-gray-400">Loading...</div>
          ) : suppliers.length === 0 ? (
            <div className="p-8 text-center text-gray-500 dark:text-gray-400">No suppliers found</div>
          ) : (
            <table className="w-full">
              <thead>
                <tr className="border-b text-left text-sm text-gray-500 dark:border-gray-700 dark:text-gray-400">
                  <th className="px-4 py-3">Supplier</th>
                  <th className="px-4 py-3">Contact</th>
                  <th className="px-4 py-3">Phone</th>
                  <th className="px-4 py-3">Email</th>
                  <th className="px-4 py-3">GST #</th>
                  <th className="px-4 py-3">POs</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {suppliers.map((s) => (
                  <tr
                    key={s.id}
                    onClick={() => openDetail(s.id)}
                    data-testid={`supplier-row-${s.id}`}
                    data-entity-id={s.id}
                    className={`cursor-pointer border-b last:border-0 hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-700/50 ${
                      selectedId === s.id ? "bg-blue-50 dark:bg-blue-900/30" : ""
                    } ${!s.isActive ? "opacity-60" : ""}`}
                  >
                    <td className="px-4 py-3">
                      <p className="font-medium text-gray-900 dark:text-gray-100">{s.name}</p>
                      {s.paymentTerms && (
                        <p className="text-xs text-gray-600 dark:text-gray-400">{s.paymentTerms}</p>
                      )}
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-800 dark:text-gray-200">
                      {s.contactPerson || "-"}
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-800 dark:text-gray-200">{s.phone || "-"}</td>
                    <td className="px-4 py-3 text-sm text-gray-800 dark:text-gray-200">{s.email || "-"}</td>
                    <td className="px-4 py-3 font-mono text-xs text-gray-800 dark:text-gray-200">
                      {s.gstNumber || "-"}
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-800 dark:text-gray-200">
                      {s._count?.purchaseOrders || 0}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={
                          s.isActive
                            ? "rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300"
                            : "rounded-full bg-gray-200 px-2 py-0.5 text-xs font-medium text-gray-600 dark:bg-gray-700 dark:text-gray-300"
                        }
                      >
                        {s.isActive ? "Active" : "Inactive"}
                      </span>
                    </td>
                    {/* Issue #692: per-row Edit + Deactivate/Activate
                        actions. Stop propagation so clicking these
                        buttons does NOT open the detail panel. */}
                    <td
                      className="px-4 py-3 text-right"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <div className="flex justify-end gap-1">
                        <button
                          onClick={() => setEditingSupplier(s)}
                          data-testid={`supplier-edit-${s.id}`}
                          aria-label={`Edit ${s.name}`}
                          title="Edit"
                          className="rounded p-1 text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700"
                        >
                          <Edit2 size={14} />
                        </button>
                        <button
                          onClick={() => toggleActive(s)}
                          data-testid={`supplier-toggle-active-${s.id}`}
                          aria-label={`${s.isActive ? "Deactivate" : "Activate"} ${s.name}`}
                          title={s.isActive ? "Deactivate" : "Activate"}
                          className={`rounded p-1 ${
                            s.isActive
                              ? "text-red-500 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-900/30"
                              : "text-emerald-600 hover:bg-emerald-50 dark:text-emerald-400 dark:hover:bg-emerald-900/30"
                          }`}
                        >
                          <Power size={14} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {selectedId && (
          <aside className="rounded-xl bg-white p-5 shadow-sm dark:bg-gray-800">
            {!detail ? (
              <div className="text-sm text-gray-500 dark:text-gray-400">Loading...</div>
            ) : (
              <>
                <div className="mb-4 flex items-start justify-between">
                  <div>
                    <h2 className="text-lg font-bold text-gray-900 dark:text-gray-100">{detail.name}</h2>
                    {detail.contactPerson && (
                      <p className="text-sm text-gray-500 dark:text-gray-400">{detail.contactPerson}</p>
                    )}
                  </div>
                  <button
                    onClick={() => {
                      setSelectedId(null);
                      setDetail(null);
                    }}
                    className="text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300"
                  >
                    <X size={20} />
                  </button>
                </div>

                <div className="mb-4 space-y-2 text-sm text-gray-800 dark:text-gray-200">
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
                  <h3 className="mb-2 text-sm font-semibold text-gray-700 dark:text-gray-200">
                    Recent Purchase Orders
                  </h3>
                  {detail.purchaseOrders.length === 0 ? (
                    <p className="text-sm text-gray-500 dark:text-gray-400">No purchase orders yet</p>
                  ) : (
                    <ul className="space-y-2">
                      {detail.purchaseOrders.map((po) => (
                        <li
                          key={po.id}
                          className="rounded-lg border px-3 py-2 text-sm dark:border-gray-700 dark:text-gray-200"
                        >
                          <div className="flex justify-between">
                            <span className="font-mono text-xs">{po.poNumber}</span>
                            <span
                              className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusBadge(po.status)}`}
                            >
                              {po.status}
                            </span>
                          </div>
                          <div className="mt-1 flex justify-between text-xs text-gray-500 dark:text-gray-400">
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

      {/* Issue #692: per-row Edit modal — pre-fills with the row's
          current values and PATCHes back via /suppliers/:id. */}
      {editingSupplier && (
        <EditSupplierModal
          supplier={editingSupplier}
          onClose={() => setEditingSupplier(null)}
          onSaved={(updated) => {
            setEditingSupplier(null);
            // If the edited row is currently in the detail panel, refresh
            // it so the side panel shows the saved values immediately.
            if (selectedId === updated.id) {
              setDetail((prev) => (prev ? { ...prev, ...updated } : prev));
            }
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
    setError(null);
    if (!form.name.trim()) {
      setError("Name is required");
      return;
    }
    setSaving(true);
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
      <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-xl bg-white p-6 shadow-2xl dark:bg-gray-800">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-bold text-gray-900 dark:text-gray-100">Add Supplier</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300">
            <X size={20} />
          </button>
        </div>
        <form onSubmit={handleSubmit} noValidate className="space-y-3">
          <div>
            <label htmlFor="add-supplier-name" className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">Name *</label>
            <input
              id="add-supplier-name"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              className="w-full rounded-lg border px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
            />
          </div>
          <div>
            <label htmlFor="add-supplier-contact-person" className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">Contact Person</label>
            <input
              id="add-supplier-contact-person"
              value={form.contactPerson}
              onChange={(e) => setForm({ ...form, contactPerson: e.target.value })}
              className="w-full rounded-lg border px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="add-supplier-phone" className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">Phone</label>
              <input
                id="add-supplier-phone"
                value={form.phone}
                onChange={(e) => setForm({ ...form, phone: e.target.value })}
                className="w-full rounded-lg border px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
              />
            </div>
            <div>
              <label htmlFor="add-supplier-email" className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">Email</label>
              <input
                id="add-supplier-email"
                type="email"
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
                className="w-full rounded-lg border px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
              />
            </div>
          </div>
          <div>
            <label htmlFor="add-supplier-address" className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">Address</label>
            <textarea
              id="add-supplier-address"
              rows={2}
              value={form.address}
              onChange={(e) => setForm({ ...form, address: e.target.value })}
              className="w-full rounded-lg border px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="add-supplier-gst" className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">GST Number</label>
              <input
                id="add-supplier-gst"
                value={form.gstNumber}
                onChange={(e) => setForm({ ...form, gstNumber: e.target.value })}
                className="w-full rounded-lg border px-3 py-2 font-mono text-sm dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
              />
            </div>
            <div>
              <label htmlFor="add-supplier-payment-terms" className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">Payment Terms</label>
              <input
                id="add-supplier-payment-terms"
                placeholder="Net 30, Net 60..."
                value={form.paymentTerms}
                onChange={(e) => setForm({ ...form, paymentTerms: e.target.value })}
                className="w-full rounded-lg border px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
              />
            </div>
          </div>

          {error && (
            <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600 dark:bg-red-900/30 dark:text-red-300">
              {error}
            </div>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700"
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

// Issue #692: per-row Edit modal. Form fields cover the writable
// supplier columns (name, contactPerson, phone, email, address,
// gstNumber, paymentTerms, isActive). Submit PATCHes /suppliers/:id —
// the API path was already wired; the bug was the missing FE
// affordance.
function EditSupplierModal({
  supplier,
  onClose,
  onSaved,
}: {
  supplier: SupplierRecord;
  onClose: () => void;
  onSaved: (s: SupplierRecord) => void;
}) {
  const [form, setForm] = useState({
    name: supplier.name,
    contactPerson: supplier.contactPerson || "",
    phone: supplier.phone || "",
    email: supplier.email || "",
    address: supplier.address || "",
    gstNumber: supplier.gstNumber || "",
    paymentTerms: supplier.paymentTerms || "",
    isActive: supplier.isActive,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!form.name.trim()) {
      setError("Name is required");
      return;
    }
    setSaving(true);
    try {
      // Send the full set of editable fields. We pass empty strings as
      // empty strings (not undefined) so a previously-set field can be
      // explicitly cleared by leaving the input blank — matching the
      // server's tolerance of empty optional strings.
      const body: Record<string, unknown> = {
        name: form.name,
        contactPerson: form.contactPerson || undefined,
        phone: form.phone || undefined,
        email: form.email || undefined,
        address: form.address || undefined,
        gstNumber: form.gstNumber || undefined,
        paymentTerms: form.paymentTerms || undefined,
        isActive: form.isActive,
      };
      const res = await api.patch<{ data: SupplierRecord }>(
        `/suppliers/${supplier.id}`,
        body
      );
      toast.success("Supplier updated");
      onSaved(res.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    }
    setSaving(false);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="edit-supplier-title"
      data-testid="supplier-edit-modal"
    >
      <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-xl bg-white p-6 shadow-2xl dark:bg-gray-800">
        <div className="mb-4 flex items-center justify-between">
          <h2 id="edit-supplier-title" className="text-lg font-bold text-gray-900 dark:text-gray-100">
            Edit Supplier
          </h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300">
            <X size={20} />
          </button>
        </div>
        <form onSubmit={handleSubmit} noValidate className="space-y-3">
          <div>
            <label htmlFor="edit-supplier-name" className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">
              Name *
            </label>
            <input
              id="edit-supplier-name"
              data-testid="edit-supplier-name"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              className="w-full rounded-lg border px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
            />
          </div>
          <div>
            <label htmlFor="edit-supplier-contact-person" className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">
              Contact Person
            </label>
            <input
              id="edit-supplier-contact-person"
              value={form.contactPerson}
              onChange={(e) => setForm({ ...form, contactPerson: e.target.value })}
              className="w-full rounded-lg border px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="edit-supplier-phone" className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">
                Phone
              </label>
              <input
                id="edit-supplier-phone"
                value={form.phone}
                onChange={(e) => setForm({ ...form, phone: e.target.value })}
                className="w-full rounded-lg border px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
              />
            </div>
            <div>
              <label htmlFor="edit-supplier-email" className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">
                Email
              </label>
              <input
                id="edit-supplier-email"
                type="email"
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
                className="w-full rounded-lg border px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
              />
            </div>
          </div>
          <div>
            <label htmlFor="edit-supplier-address" className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">
              Address
            </label>
            <textarea
              id="edit-supplier-address"
              rows={2}
              value={form.address}
              onChange={(e) => setForm({ ...form, address: e.target.value })}
              className="w-full rounded-lg border px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="edit-supplier-gst" className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">
                GST Number
              </label>
              <input
                id="edit-supplier-gst"
                value={form.gstNumber}
                onChange={(e) => setForm({ ...form, gstNumber: e.target.value })}
                className="w-full rounded-lg border px-3 py-2 font-mono text-sm dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
              />
            </div>
            <div>
              <label htmlFor="edit-supplier-payment-terms" className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">
                Payment Terms
              </label>
              <input
                id="edit-supplier-payment-terms"
                placeholder="Net 30, Net 60..."
                value={form.paymentTerms}
                onChange={(e) => setForm({ ...form, paymentTerms: e.target.value })}
                className="w-full rounded-lg border px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
              />
            </div>
          </div>
          <div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.isActive}
                onChange={(e) => setForm({ ...form, isActive: e.target.checked })}
                data-testid="edit-supplier-active"
                className="rounded"
              />
              <span className="text-gray-700 dark:text-gray-300">
                Active{" "}
                <span className="text-xs text-gray-500 dark:text-gray-400">
                  (uncheck to hide from default list)
                </span>
              </span>
            </label>
          </div>

          {error && (
            <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600 dark:bg-red-900/30 dark:text-red-300">
              {error}
            </div>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              data-testid="edit-supplier-save"
              className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark disabled:opacity-50"
            >
              {saving ? "Saving..." : "Save Changes"}
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
    <div className="mb-4 rounded-lg border bg-gray-50 p-3 dark:border-gray-700 dark:bg-gray-700/40">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200">Contract</h3>
        {!edit && (
          <button
            onClick={() => setEdit(true)}
            className="rounded border px-2 py-0.5 text-xs hover:bg-white dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
          >
            {supplier.contractStart || supplier.contractEnd ? "Edit" : "Add"}
          </button>
        )}
      </div>
      {edit ? (
        <div className="space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label htmlFor={`supplier-${supplier.id}-contract-start`} className="text-xs text-gray-500 dark:text-gray-400">Start</label>
              <input
                id={`supplier-${supplier.id}-contract-start`}
                type="date"
                value={start}
                onChange={(e) => setStart(e.target.value)}
                className="w-full rounded border px-2 py-1 text-sm dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
              />
            </div>
            <div>
              <label htmlFor={`supplier-${supplier.id}-contract-end`} className="text-xs text-gray-500 dark:text-gray-400">End</label>
              <input
                id={`supplier-${supplier.id}-contract-end`}
                type="date"
                value={end}
                onChange={(e) => setEnd(e.target.value)}
                className="w-full rounded border px-2 py-1 text-sm dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
              />
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <button
              onClick={() => setEdit(false)}
              className="rounded border px-3 py-1 text-xs dark:border-gray-600 dark:text-gray-200"
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
        <div className="text-xs text-gray-700 dark:text-gray-300">
          {supplier.contractStart || supplier.contractEnd ? (
            <>
              <p>
                <span className="text-gray-500 dark:text-gray-400">Start:</span>{" "}
                {supplier.contractStart
                  ? new Date(supplier.contractStart).toLocaleDateString()
                  : "—"}
              </p>
              <p>
                <span className="text-gray-500 dark:text-gray-400">End:</span>{" "}
                {supplier.contractEnd
                  ? new Date(supplier.contractEnd).toLocaleDateString()
                  : "—"}
                {expiringSoon && (
                  <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-800 dark:bg-amber-900/40 dark:text-amber-200">
                    Expiring Soon ({daysLeft}d)
                  </span>
                )}
                {expired && (
                  <span className="ml-2 rounded-full bg-red-100 px-2 py-0.5 text-[10px] font-semibold text-red-700 dark:bg-red-900/40 dark:text-red-300">
                    Expired
                  </span>
                )}
              </p>
            </>
          ) : (
            <p className="text-gray-500 dark:text-gray-400">No contract dates set.</p>
          )}
        </div>
      )}
    </div>
  );
}
