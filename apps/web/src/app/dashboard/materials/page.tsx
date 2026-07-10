"use client";

// Material catalog module (2026-07) — the general materials store: medicines,
// consumables, equipment, instruments, machines that departments requisition.
// One page: summary tiles + a searchable/filterable table with a single
// "Add New Item" button, inline edit, add-stock, and delete. Gated to the
// store roles (ADMIN, PHARMACIST). Modals in-DOM (no window.prompt).

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import { useAuthStore } from "@/lib/store";
import {
  Boxes,
  Plus,
  Pencil,
  Trash2,
  X,
  Search,
  PackagePlus,
  AlertTriangle,
} from "lucide-react";
import { SkeletonCard, SkeletonTable } from "@/components/Skeleton";

const VIEW_ALLOWED = new Set(["ADMIN", "PHARMACIST"]);
const CATEGORIES = ["MEDICINE", "CONSUMABLE", "EQUIPMENT", "INSTRUMENT", "MACHINE"] as const;
type Category = (typeof CATEGORIES)[number];

const CATEGORY_STYLE: Record<string, string> = {
  MEDICINE: "bg-blue-100 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300",
  CONSUMABLE: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300",
  EQUIPMENT: "bg-violet-100 text-violet-700 dark:bg-violet-950/40 dark:text-violet-300",
  INSTRUMENT: "bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300",
  MACHINE: "bg-rose-100 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300",
};

const FIELD =
  "w-full rounded-lg border bg-white px-3 py-2 text-sm text-gray-900 placeholder-gray-400 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100 dark:placeholder-gray-500";

interface Material {
  id: string;
  name: string;
  sku: string | null;
  category: Category;
  unit: string;
  quantity: number;
  reservedStock: number;
  reorderLevel: number;
  unitCost: number | null;
  location: string | null;
  active: boolean;
  // "material" = editable Material catalog row; "pharmacy" = read-only medicine
  // batch surfaced from the Pharmacy inventory (managed on the Pharmacy page).
  source?: "material" | "pharmacy";
}

export default function MaterialsPage() {
  const { user, isLoading } = useAuthStore();
  const router = useRouter();

  const [rows, setRows] = useState<Material[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState("");
  const [catFilter, setCatFilter] = useState<"" | Category>("");

  // Create / edit modal
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Material | null>(null);
  const [form, setForm] = useState({
    name: "",
    sku: "",
    category: "CONSUMABLE" as Category,
    unit: "unit",
    quantity: 0,
    reorderLevel: 10,
    unitCost: "",
    location: "",
  });
  const [submitting, setSubmitting] = useState(false);

  // Add-stock modal
  const [stockFor, setStockFor] = useState<Material | null>(null);
  const [stockDelta, setStockDelta] = useState(0);
  const [stockReason, setStockReason] = useState("");

  // Delete confirm
  const [confirmDel, setConfirmDel] = useState<Material | null>(null);

  const allowed = !!user && VIEW_ALLOWED.has(user.role);

  useEffect(() => {
    if (!isLoading && user && !allowed) router.push("/dashboard");
  }, [isLoading, user, allowed, router]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams();
      if (q.trim()) qs.set("q", q.trim());
      if (catFilter) qs.set("category", catFilter);
      // Fetch BOTH sources so this page is the true central catalog: the
      // editable Material rows + the read-only pharmacy medicine batches.
      // Fetch them INDEPENDENTLY so a pharmacy failure never wipes the
      // materials list (allSettled, not all).
      const [matSettled, invSettled] = await Promise.allSettled([
        api.get<{ data: Material[] }>(`/materials?${qs.toString()}`),
        // The pharmacy endpoint caps limit at 200 — anything higher 400s.
        api.get<{ data: any }>(`/pharmacy/inventory?limit=200`),
      ]);
      const matRes = matSettled.status === "fulfilled" ? matSettled.value : null;
      const invRes = invSettled.status === "fulfilled" ? invSettled.value : null;

      const materials: Material[] = (Array.isArray(matRes?.data) ? matRes!.data : []).map((m) => ({
        ...m,
        source: "material" as const,
      }));

      // Normalize pharmacy inventory batches into the same row shape.
      const invData: any = invRes?.data;
      const invItems: any[] = Array.isArray(invData) ? invData : invData?.items ?? [];
      const pharmacy: Material[] = invItems.map((it) => ({
        id: `pharm:${it.id}`,
        name: it.medicine?.name ?? "Medicine",
        sku: it.batchNumber ?? null,
        category: "MEDICINE" as Category,
        unit: "unit",
        quantity: it.quantity ?? 0,
        reservedStock: it.reservedStock ?? 0,
        reorderLevel: it.reorderLevel ?? 0,
        unitCost: it.unitCost ?? null,
        location: it.location ?? null,
        active: true,
        source: "pharmacy" as const,
      }));

      // Apply the client-side category filter to the merged list (the pharmacy
      // rows aren't filtered server-side by our /materials query).
      let merged = [...materials, ...pharmacy];
      if (catFilter) merged = merged.filter((r) => r.category === catFilter);
      if (q.trim()) {
        const needle = q.trim().toLowerCase();
        merged = merged.filter(
          (r) =>
            r.name.toLowerCase().includes(needle) ||
            (r.sku ?? "").toLowerCase().includes(needle),
        );
      }
      merged.sort((a, b) => a.name.localeCompare(b.name));
      setRows(merged);
    } catch {
      setRows([]);
    }
    setLoading(false);
  }, [q, catFilter]);

  useEffect(() => {
    if (allowed) load();
  }, [allowed, load]);

  function openCreate() {
    setEditing(null);
    setForm({
      name: "",
      sku: "",
      category: "CONSUMABLE",
      unit: "unit",
      quantity: 0,
      reorderLevel: 10,
      unitCost: "",
      location: "",
    });
    setModalOpen(true);
  }
  function openEdit(m: Material) {
    setEditing(m);
    setForm({
      name: m.name,
      sku: m.sku ?? "",
      category: m.category,
      unit: m.unit,
      quantity: m.quantity,
      reorderLevel: m.reorderLevel,
      unitCost: m.unitCost != null ? String(m.unitCost) : "",
      location: m.location ?? "",
    });
    setModalOpen(true);
  }

  const submitForm = useCallback(async () => {
    if (form.name.trim().length < 2) {
      toast.error("Name must be at least 2 characters");
      return;
    }
    setSubmitting(true);
    try {
      const payload: Record<string, unknown> = {
        name: form.name.trim(),
        category: form.category,
        unit: form.unit.trim() || "unit",
        reorderLevel: Number(form.reorderLevel) || 0,
      };
      if (form.sku.trim()) payload.sku = form.sku.trim();
      if (form.unitCost !== "") payload.unitCost = Number(form.unitCost);
      if (form.location.trim()) payload.location = form.location.trim();

      if (editing) {
        await api.patch(`/materials/${editing.id}`, payload);
        toast.success(`"${form.name}" updated`);
      } else {
        payload.quantity = Number(form.quantity) || 0;
        await api.post("/materials", payload);
        toast.success(`"${form.name}" added`);
      }
      setModalOpen(false);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save material");
    } finally {
      setSubmitting(false);
    }
  }, [form, editing, load]);

  const submitStock = useCallback(async () => {
    if (!stockFor || !stockDelta) {
      toast.error("Enter a non-zero quantity");
      return;
    }
    try {
      await api.post(`/materials/${stockFor.id}/adjust-stock`, {
        delta: Number(stockDelta),
        reason: stockReason || undefined,
      });
      toast.success(`Stock updated for "${stockFor.name}"`);
      setStockFor(null);
      setStockDelta(0);
      setStockReason("");
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to adjust stock");
    }
  }, [stockFor, stockDelta, stockReason, load]);

  const doDelete = useCallback(async () => {
    if (!confirmDel) return;
    const m = confirmDel;
    setConfirmDel(null);
    try {
      const res = await api.delete<{ data: { softDeleted?: boolean } }>(`/materials/${m.id}`);
      toast.success(
        res?.data?.softDeleted
          ? `"${m.name}" deactivated (has requisition history)`
          : `"${m.name}" deleted`,
      );
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete");
    }
  }, [confirmDel, load]);

  const summary = useMemo(() => {
    const total = rows.length;
    const lowStock = rows.filter((m) => m.quantity <= m.reorderLevel).length;
    const totalUnits = rows.reduce((s, m) => s + m.quantity, 0);
    return { total, lowStock, totalUnits };
  }, [rows]);

  if (isLoading || (user && !allowed)) return null;

  return (
    <div>
      <div className="mb-6 flex items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold">
            <Boxes size={22} /> Materials
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Central catalog of every material departments can requisition
          </p>
        </div>
        <button
          type="button"
          onClick={openCreate}
          data-testid="material-create-btn"
          className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary/90"
        >
          <Plus size={16} /> Add New Item
        </button>
      </div>

      {/* Summary tiles */}
      {loading ? (
        <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
          <SkeletonCard />
          <SkeletonCard />
          <SkeletonCard />
        </div>
      ) : (
        <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-3" data-testid="material-summary">
          <Tile label="Total Items" value={summary.total} tone="slate" />
          <Tile label="Total Units" value={summary.totalUnits} tone="blue" />
          <Tile label="Low Stock" value={summary.lowStock} tone="amber" />
        </div>
      )}

      {/* Toolbar */}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[200px]">
          <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            type="text"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search name or SKU…"
            data-testid="material-search"
            className={`${FIELD} pl-9`}
          />
        </div>
        <select
          value={catFilter}
          onChange={(e) => setCatFilter(e.target.value as "" | Category)}
          data-testid="material-cat-filter"
          className={`${FIELD} max-w-[180px]`}
        >
          <option value="">All categories</option>
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {c.charAt(0) + c.slice(1).toLowerCase()}
            </option>
          ))}
        </select>
      </div>

      {/* Table */}
      <div className="rounded-xl bg-white shadow-sm dark:border dark:border-gray-700 dark:bg-gray-800">
        {loading ? (
          <div className="p-4" aria-busy="true">
            <SkeletonTable rows={6} columns={5} />
          </div>
        ) : rows.length === 0 ? (
          <div className="p-10 text-center text-gray-500" data-testid="material-empty">
            No materials yet.{" "}
            <button type="button" onClick={openCreate} className="font-medium text-primary hover:underline">
              Add your first item
            </button>
            .
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full" data-testid="material-table">
              <thead>
                <tr className="border-b text-left text-sm text-gray-500 dark:border-gray-700 dark:text-gray-400">
                  <th className="px-4 py-3">Name</th>
                  <th className="px-4 py-3">Category</th>
                  <th className="px-4 py-3 text-right">On hand</th>
                  <th className="px-4 py-3 text-right">Reserved</th>
                  <th className="px-4 py-3">Unit</th>
                  <th className="px-4 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((m) => {
                  const low = m.quantity <= m.reorderLevel;
                  return (
                    <tr key={m.id} data-testid="material-row" className="border-b text-sm last:border-0 dark:border-gray-700">
                      <td className="px-4 py-3">
                        <span className="font-medium">{m.name}</span>
                        {m.sku && <span className="ml-2 text-xs text-gray-400">{m.sku}</span>}
                        {m.source === "pharmacy" && (
                          <span className="ml-2 rounded-full bg-blue-100 px-2 py-0.5 text-[10px] text-blue-700 dark:bg-blue-950/40 dark:text-blue-300">
                            Pharmacy
                          </span>
                        )}
                        {!m.active && (
                          <span className="ml-2 rounded-full bg-gray-200 px-2 py-0.5 text-[10px] text-gray-600 dark:bg-gray-700 dark:text-gray-300">
                            inactive
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${CATEGORY_STYLE[m.category]}`}>
                          {m.category.charAt(0) + m.category.slice(1).toLowerCase()}
                        </span>
                      </td>
                      <td className={`px-4 py-3 text-right tabular-nums ${low ? "font-semibold text-amber-600 dark:text-amber-400" : ""}`}>
                        {m.quantity}
                        {low && <AlertTriangle size={12} className="ml-1 inline" />}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums text-gray-500">{m.reservedStock}</td>
                      <td className="px-4 py-3 text-gray-500 dark:text-gray-400">{m.unit}</td>
                      <td className="px-4 py-3">
                        {m.source === "pharmacy" ? (
                          // Medicine batches are managed on the Pharmacy page,
                          // so they're read-only here.
                          <div className="text-right text-xs text-gray-400">
                            Managed in Pharmacy
                          </div>
                        ) : (
                          <div className="flex items-center justify-end gap-1">
                            <button
                              type="button"
                              onClick={() => {
                                setStockFor(m);
                                setStockDelta(0);
                                setStockReason("");
                              }}
                              data-testid={`material-stock-${m.id}`}
                              title="Add / adjust stock"
                              className="rounded-md p-1.5 text-gray-500 hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-gray-700 dark:hover:text-gray-200"
                            >
                              <PackagePlus size={15} />
                            </button>
                            <button
                              type="button"
                              onClick={() => openEdit(m)}
                              data-testid={`material-edit-${m.id}`}
                              title="Edit"
                              className="rounded-md p-1.5 text-gray-500 hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-gray-700 dark:hover:text-gray-200"
                            >
                              <Pencil size={15} />
                            </button>
                            <button
                              type="button"
                              onClick={() => setConfirmDel(m)}
                              data-testid={`material-delete-${m.id}`}
                              title="Delete"
                              className="rounded-md p-1.5 text-red-500 hover:bg-red-50 dark:hover:bg-red-950/40"
                            >
                              <Trash2 size={15} />
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Create / edit modal */}
      {modalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" data-testid="material-modal" role="dialog" aria-modal="true">
          <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl dark:border dark:border-gray-700 dark:bg-gray-800">
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-lg font-semibold">{editing ? "Edit Item" : "Add New Item"}</h3>
              <button type="button" onClick={() => setModalOpen(false)} className="rounded-md p-1 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700">
                <X size={18} />
              </button>
            </div>
            <div className="space-y-3">
              <Labeled label="Name">
                <input type="text" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Surgical Gloves / Scalpel #10 / X-Ray Machine" data-testid="material-name-input" className={FIELD} />
              </Labeled>
              <div className="grid grid-cols-2 gap-3">
                <Labeled label="Category">
                  <select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value as Category })} data-testid="material-category-input" className={FIELD}>
                    {CATEGORIES.map((c) => (
                      <option key={c} value={c}>{c.charAt(0) + c.slice(1).toLowerCase()}</option>
                    ))}
                  </select>
                </Labeled>
                <Labeled label="Unit">
                  <input type="text" value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value })} placeholder="box / piece / set" className={FIELD} />
                </Labeled>
              </div>
              <div className="grid grid-cols-2 gap-3">
                {!editing && (
                  <Labeled label="Opening quantity">
                    <input type="number" min={0} value={form.quantity} onChange={(e) => setForm({ ...form, quantity: Number(e.target.value) })} data-testid="material-qty-input" className={FIELD} />
                  </Labeled>
                )}
                <Labeled label="Reorder level">
                  <input type="number" min={0} value={form.reorderLevel} onChange={(e) => setForm({ ...form, reorderLevel: Number(e.target.value) })} className={FIELD} />
                </Labeled>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Labeled label="SKU (optional)">
                  <input type="text" value={form.sku} onChange={(e) => setForm({ ...form, sku: e.target.value })} className={FIELD} />
                </Labeled>
                <Labeled label="Unit cost (optional)">
                  <input type="number" min={0} value={form.unitCost} onChange={(e) => setForm({ ...form, unitCost: e.target.value })} className={FIELD} />
                </Labeled>
              </div>
              <Labeled label="Location (optional)">
                <input type="text" value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} placeholder="Shelf / room" className={FIELD} />
              </Labeled>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" onClick={() => setModalOpen(false)} className="rounded-lg border px-3 py-2 text-sm font-medium hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-700">
                Cancel
              </button>
              <button type="button" onClick={submitForm} disabled={submitting} data-testid="material-submit" className="rounded-lg bg-primary px-3 py-2 text-sm font-medium text-white hover:bg-primary/90 disabled:opacity-50">
                {submitting ? "Saving…" : editing ? "Save Changes" : "Add Item"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Add-stock modal */}
      {stockFor && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" data-testid="material-stock-modal" role="dialog" aria-modal="true">
          <div className="w-full max-w-sm rounded-xl bg-white p-6 shadow-xl dark:border dark:border-gray-700 dark:bg-gray-800">
            <h3 className="mb-1 text-lg font-semibold">Adjust stock</h3>
            <p className="mb-4 text-sm text-gray-500 dark:text-gray-400">
              {stockFor.name} — on hand {stockFor.quantity} {stockFor.unit}
            </p>
            <Labeled label="Quantity change (+ add, − correct)">
              <input type="number" value={stockDelta} onChange={(e) => setStockDelta(Number(e.target.value))} data-testid="material-stock-delta" className={FIELD} />
            </Labeled>
            <div className="mt-3">
              <Labeled label="Reason (optional)">
                <input type="text" value={stockReason} onChange={(e) => setStockReason(e.target.value)} placeholder="Purchase / correction" className={FIELD} />
              </Labeled>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" onClick={() => setStockFor(null)} className="rounded-lg border px-3 py-2 text-sm font-medium hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-700">
                Cancel
              </button>
              <button type="button" onClick={submitStock} data-testid="material-stock-submit" className="rounded-lg bg-primary px-3 py-2 text-sm font-medium text-white hover:bg-primary/90">
                Apply
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete confirm */}
      {confirmDel && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4" style={{ zIndex: 60 }} data-testid="material-confirm" role="dialog" aria-modal="true">
          <div className="w-full max-w-sm rounded-xl bg-white p-6 shadow-xl dark:border dark:border-gray-700 dark:bg-gray-800">
            <div className="mb-3 flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-red-100 text-red-600 dark:bg-red-950/40 dark:text-red-300">
                <AlertTriangle size={20} />
              </div>
              <h3 className="text-lg font-semibold">Delete item?</h3>
            </div>
            <p className="mb-5 text-sm text-gray-600 dark:text-gray-300">
              <strong>{confirmDel.name}</strong> will be removed. If it has requisition history it will be deactivated (kept for records) instead of permanently deleted.
            </p>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setConfirmDel(null)} className="rounded-lg border px-3 py-2 text-sm font-medium hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-700">
                Cancel
              </button>
              <button type="button" onClick={doDelete} data-testid="material-confirm-ok" className="rounded-lg bg-red-600 px-3 py-2 text-sm font-medium text-white hover:bg-red-700">
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const TONE: Record<string, string> = {
  slate: "bg-slate-100 text-slate-600 dark:bg-slate-900/50 dark:text-slate-300",
  blue: "bg-blue-100 text-blue-600 dark:bg-blue-950/40 dark:text-blue-300",
  amber: "bg-amber-100 text-amber-600 dark:bg-amber-950/40 dark:text-amber-300",
};
function Tile({ label, value, tone }: { label: string; value: number; tone: keyof typeof TONE }) {
  return (
    <div className="rounded-xl bg-white p-4 shadow-sm dark:border dark:border-gray-700 dark:bg-gray-800">
      <div className="flex items-center gap-3">
        <div className={`flex h-10 w-10 items-center justify-center rounded-lg ${TONE[tone]}`}>
          <Boxes size={18} />
        </div>
        <div>
          <p className="text-xs text-gray-500 dark:text-gray-400">{label}</p>
          <p className="text-xl font-bold tabular-nums">{value}</p>
        </div>
      </div>
    </div>
  );
}
function Labeled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-300">{label}</label>
      {children}
    </div>
  );
}
