"use client";

// Requisition module (2026-07) — store ↔ department material-issuance UI.
//
// One page covering the whole workflow, role-gated to match the API:
//   • department staff (NURSE/DOCTOR/RECEPTION/ADMIN) → create + receive
//   • store manager (PHARMACIST/ADMIN)              → approve/reject + issue
//   • read (all above + LAB_TECH)                    → view
// Status tabs + a create modal (department + inventory-item picker) + inline
// approve/issue/receive actions driven by the requisition's current status.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import { useAuthStore } from "@/lib/store";
import { ClipboardList, Plus, X, Trash2, Check, Truck, PackageCheck } from "lucide-react";
import { SkeletonTable } from "@/components/Skeleton";

const VIEW_ALLOWED = new Set([
  "ADMIN",
  "PHARMACIST",
  "NURSE",
  "DOCTOR",
  "RECEPTION",
  "LAB_TECH",
]);
const STORE_ROLES = new Set(["ADMIN", "PHARMACIST"]);
const DEPT_ROLES = new Set(["ADMIN", "NURSE", "DOCTOR", "RECEPTION"]);

const MODAL_FIELD =
  "w-full rounded-lg border bg-white px-3 py-2 text-sm text-gray-900 placeholder-gray-400 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100 dark:placeholder-gray-500";

interface Department {
  id: string;
  name: string;
  code: string;
  isMine?: boolean; // caller is a member of this department → pre-select it
}
interface InventoryItem {
  id: string;
  batchNumber: string;
  quantity: number;
  reservedStock: number;
  medicine?: { name: string } | null;
}
interface MaterialRef {
  id: string;
  name: string;
  unit: string;
  category?: string;
  quantity?: number;
  reservedStock?: number;
  totalQuantity?: number;
  mainQuantity?: number;
  departmentQuantities?: Array<{
    departmentId: string;
    departmentName: string;
    departmentCode: string;
    quantity: number;
  }>;
  active?: boolean;
}
interface ReqItem {
  id: string;
  requestedQty: number;
  approvedQty: number;
  issuedQty: number;
  receivedQty: number;
  inventoryItem: InventoryItem | null;
  material: MaterialRef | null;
}
interface Requisition {
  id: string;
  requisitionNumber: string;
  status: string;
  notes?: string | null;
  remarks?: string | null;
  createdAt: string;
  department: Department;
  requestedBy: { id: string; name: string };
  items: ReqItem[];
}

const TABS = ["SUBMITTED", "APPROVED", "PARTIALLY_ISSUED", "ISSUED", "COMPLETED", "ALL"] as const;
type Tab = (typeof TABS)[number];

const STATUS_STYLE: Record<string, string> = {
  SUBMITTED: "bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300",
  APPROVED: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300",
  PARTIALLY_APPROVED: "bg-teal-100 text-teal-700 dark:bg-teal-950/40 dark:text-teal-300",
  PARTIALLY_ISSUED: "bg-blue-100 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300",
  ISSUED: "bg-indigo-100 text-indigo-700 dark:bg-indigo-950/40 dark:text-indigo-300",
  COMPLETED: "bg-gray-200 text-gray-700 dark:bg-gray-700 dark:text-gray-200",
  REJECTED: "bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-300",
  CANCELLED: "bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-300",
};

export default function RequisitionsPage() {
  const { user, isLoading } = useAuthStore();
  const router = useRouter();
  const pathname = usePathname();

  const [rows, setRows] = useState<Requisition[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>("ALL");
  const [showNew, setShowNew] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  const canStore = user ? STORE_ROLES.has(user.role) : false;
  const canDept = user ? DEPT_ROLES.has(user.role) : false;

  useEffect(() => {
    if (!isLoading && user && !VIEW_ALLOWED.has(user.role)) {
      toast.error("Requisitions are restricted to store and department staff.");
      router.replace(
        `/dashboard/not-authorized?from=${encodeURIComponent(pathname || "/dashboard/requisitions")}`,
      );
    }
  }, [user, isLoading, router, pathname]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs = tab === "ALL" ? "" : `?status=${tab}`;
      const res = await api.get<{ data: Requisition[] }>(`/requisitions${qs}`);
      setRows(Array.isArray(res?.data) ? res.data : []);
    } catch {
      setRows([]);
    }
    setLoading(false);
  }, [tab]);

  useEffect(() => {
    void load();
  }, [load]);

  if (user && !VIEW_ALLOWED.has(user.role)) return null;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ClipboardList className="h-6 w-6 text-primary" />
          <div>
            <h1 className="text-2xl font-bold">Requisitions</h1>
            <p className="text-sm text-gray-500 dark:text-gray-400">
              Department material requests from the central store
            </p>
          </div>
        </div>
        {canDept && (
          <button
            type="button"
            onClick={() => setShowNew(true)}
            data-testid="req-new-btn"
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary/90"
          >
            <Plus size={16} /> New Requisition
          </button>
        )}
      </div>

      {/* Tabs */}
      <div className="flex flex-wrap gap-2 border-b dark:border-gray-700">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-3 py-2 text-sm font-medium ${
              tab === t
                ? "border-b-2 border-primary text-primary dark:border-blue-400 dark:text-blue-400"
                : "text-gray-500 hover:text-gray-700 dark:text-gray-300"
            }`}
          >
            {t.replace(/_/g, " ")}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="rounded-xl bg-white p-4 shadow-sm dark:bg-gray-800">
          <SkeletonTable rows={5} columns={5} />
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-xl border border-dashed p-8 text-center text-gray-500 dark:border-gray-700">
          No requisitions in this view.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl bg-white shadow-sm dark:border dark:border-gray-700 dark:bg-gray-800">
          <table className="w-full" data-testid="req-table">
            <thead>
              <tr className="border-b text-left text-sm text-gray-500 dark:border-gray-700 dark:text-gray-400">
                <th className="px-4 py-3">Requisition</th>
                <th className="px-4 py-3">Department</th>
                <th className="px-4 py-3">Requested by</th>
                <th className="px-4 py-3 text-right">Items</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <RequisitionRow
                  key={r.id}
                  req={r}
                  expanded={expanded === r.id}
                  onToggle={() => setExpanded(expanded === r.id ? null : r.id)}
                  canStore={canStore}
                  canDept={canDept}
                  onChanged={load}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showNew && (
        <NewRequisitionModal
          onClose={() => setShowNew(false)}
          onCreated={() => {
            setShowNew(false);
            void load();
          }}
        />
      )}
    </div>
  );
}

function RequisitionRow({
  req,
  expanded,
  onToggle,
  canStore,
  canDept,
  onChanged,
}: {
  req: Requisition;
  expanded: boolean;
  onToggle: () => void;
  canStore: boolean;
  canDept: boolean;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  // Local editable quantities for approve/issue.
  const [qtys, setQtys] = useState<Record<string, number>>(() =>
    Object.fromEntries(req.items.map((i) => [i.id, i.requestedQty])),
  );

  const canApprove = canStore && (req.status === "SUBMITTED" || req.status === "PENDING_APPROVAL");
  const canIssue =
    canStore && ["APPROVED", "PARTIALLY_APPROVED", "PARTIALLY_ISSUED"].includes(req.status);
  const canReceive = canDept && (req.status === "ISSUED" || req.status === "PARTIALLY_ISSUED");

  async function act(path: string, body: unknown, label: string) {
    setBusy(true);
    try {
      await api.post(`/requisitions/${req.id}/${path}`, body);
      toast.success(`Requisition ${label}`);
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : `Could not ${label}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <tr
        className="cursor-pointer border-b text-sm last:border-0 hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-700/40"
        onClick={onToggle}
        data-testid="req-row"
      >
        <td className="px-4 py-3 font-mono font-medium text-primary dark:text-blue-400">
          {req.requisitionNumber}
        </td>
        <td className="px-4 py-3">{req.department?.name}</td>
        <td className="px-4 py-3">{req.requestedBy?.name}</td>
        <td className="px-4 py-3 text-right">{req.items.length}</td>
        <td className="px-4 py-3">
          <span className={`rounded px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[req.status] ?? ""}`}>
            {req.status.replace(/_/g, " ")}
          </span>
        </td>
        <td className="px-4 py-3 text-right text-xs text-gray-400">
          {expanded ? "▲" : "▼"}
        </td>
      </tr>
      {expanded && (
        <tr className="border-b dark:border-gray-700">
          <td colSpan={6} className="bg-gray-50 px-4 py-4 dark:bg-gray-900/40">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-gray-500 dark:text-gray-400">
                  <th className="py-1">Item</th>
                  <th className="py-1 text-right">Requested</th>
                  <th className="py-1 text-right">Approved</th>
                  <th className="py-1 text-right">Issued</th>
                  <th className="py-1 text-right">Available</th>
                  {(canApprove || canIssue) && <th className="py-1 text-right">Qty</th>}
                </tr>
              </thead>
              <tbody>
                {req.items.map((it) => {
                  // A line's source is either a pharmacy batch or a material.
                  const src = it.inventoryItem ?? it.material;
                  const available = (src?.quantity ?? 0) - (src?.reservedStock ?? 0);
                  const label = it.inventoryItem
                    ? it.inventoryItem.medicine?.name ?? "Item"
                    : it.material?.name ?? "Material";
                  const sub = it.inventoryItem
                    ? it.inventoryItem.batchNumber
                    : it.material?.unit ?? "";
                  return (
                    <tr key={it.id} className="border-t dark:border-gray-700/50">
                      <td className="py-1.5">
                        {label}{" "}
                        {sub && <span className="text-xs text-gray-400">({sub})</span>}
                      </td>
                      <td className="py-1.5 text-right">{it.requestedQty}</td>
                      <td className="py-1.5 text-right">{it.approvedQty}</td>
                      <td className="py-1.5 text-right">{it.issuedQty}</td>
                      <td className="py-1.5 text-right">{available}</td>
                      {(canApprove || canIssue) && (
                        <td className="py-1.5 text-right">
                          <input
                            type="number"
                            min={0}
                            value={qtys[it.id] ?? 0}
                            onChange={(e) =>
                              setQtys((q) => ({ ...q, [it.id]: parseInt(e.target.value || "0", 10) }))
                            }
                            onClick={(e) => e.stopPropagation()}
                            className="w-20 rounded border px-2 py-1 text-right dark:border-gray-600 dark:bg-gray-900"
                          />
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>

            {req.remarks && (
              <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">Remarks: {req.remarks}</p>
            )}

            {/* Action buttons by role + status */}
            <div className="mt-3 flex flex-wrap gap-2">
              {canApprove && (
                <>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      act(
                        "approve",
                        { items: req.items.map((i) => ({ itemId: i.id, approvedQty: qtys[i.id] ?? 0 })) },
                        "approved",
                      )
                    }
                    data-testid="req-approve"
                    className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
                  >
                    <Check size={14} /> Approve
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => setRejecting((v) => !v)}
                    className="inline-flex items-center gap-1 rounded-lg border border-red-300 px-3 py-1.5 text-xs text-red-600 hover:bg-red-50 disabled:opacity-50 dark:border-red-900"
                  >
                    <X size={14} /> Reject
                  </button>
                </>
              )}
              {canIssue && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    act(
                      "issue",
                      { items: req.items.map((i) => ({ itemId: i.id, issuedQty: qtys[i.id] ?? 0 })) },
                      "issued",
                    )
                  }
                  data-testid="req-issue"
                  className="inline-flex items-center gap-1 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
                >
                  <Truck size={14} /> Issue
                </button>
              )}
              {canReceive && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => act("receive", {}, "received")}
                  data-testid="req-receive"
                  className="inline-flex items-center gap-1 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  <PackageCheck size={14} /> Confirm Receipt
                </button>
              )}
            </div>

            {rejecting && (
              <div className="mt-3 flex gap-2">
                <input
                  type="text"
                  value={rejectReason}
                  onChange={(e) => setRejectReason(e.target.value)}
                  placeholder="Reason for rejection…"
                  className="flex-1 rounded-lg border px-3 py-1.5 text-xs dark:border-gray-600 dark:bg-gray-900"
                />
                <button
                  type="button"
                  disabled={busy || !rejectReason.trim()}
                  onClick={() => act("reject", { remarks: rejectReason.trim() }, "rejected")}
                  className="rounded-lg bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50"
                >
                  Confirm reject
                </button>
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

function NewRequisitionModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const [departments, setDepartments] = useState<Department[]>([]);
  // Unified picker options from BOTH sources. `key` is "inv:<id>" or
  // "mat:<id>"; the submit step splits it back into the right field.
  const [options, setOptions] = useState<
    Array<{ key: string; label: string; avail: number }>
  >([]);
  const [departmentId, setDepartmentId] = useState("");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<Array<{ key: string; requestedQty: number }>>([
    { key: "", requestedQty: 1 },
  ]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const [d, mat] = await Promise.all([
          api.get<{ data: Department[] }>("/requisitions/departments"),
          api.get<{ data: MaterialRef[] }>("/materials?active=true&forRequisition=true"),
        ]);
        const depts = Array.isArray(d?.data) ? d.data : [];
        setDepartments(depts);
        const mine = depts.find((x) => x.isMine);
        if (mine) setDepartmentId(mine.id);

        const invItems: InventoryItem[] = [];
        const materials = Array.isArray(mat?.data) ? mat.data : [];
        const inventoryOptions = invItems.map((it) => ({
          key: `inv:${it.id}`,
          label: `[Pharmacy] ${it.medicine?.name ?? "Item"} (${it.batchNumber}) - ${it.quantity - it.reservedStock} avail`,
          avail: it.quantity - it.reservedStock,
        }));
        const materialOptions = materials
          .map((m) => {
            const mainQty =
              typeof m.mainQuantity === "number"
                ? m.mainQuantity
                : typeof m.quantity === "number"
                  ? m.quantity
                  : typeof m.totalQuantity === "number"
                    ? m.totalQuantity
                    : 0;
            const avail = Math.max(0, mainQty - (m.reservedStock ?? 0));
            return {
              key: `mat:${m.id}`,
              label: `[Material] ${m.name} - ${avail} ${m.unit} avail`,
              avail,
            };
          })
          .filter((option) => option.avail > 0);
        setOptions([...inventoryOptions, ...materialOptions]);
      } catch {
        /* leave empty */
      }
    })();
  }, [departmentId]);

  const canSubmit = useMemo(
    () => !!departmentId && lines.some((l) => l.key && l.requestedQty > 0),
    [departmentId, lines],
  );

  async function submit() {
    setSaving(true);
    try {
      // Split the composite key back into the correct source field.
      const items = lines
        .filter((l) => l.key && l.requestedQty > 0)
        .map((l) => {
          const [kind, id] = l.key.split(":");
          return kind === "mat"
            ? { materialId: id, requestedQty: l.requestedQty }
            : { inventoryItemId: id, requestedQty: l.requestedQty };
        });
      await api.post("/requisitions", {
        departmentId,
        notes: notes || undefined,
        items,
      });
      toast.success("Requisition submitted");
      onCreated();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not create requisition");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-xl bg-white p-6 shadow-xl dark:bg-gray-800">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">New Requisition</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X size={20} />
          </button>
        </div>

        <label className="mb-1 block text-sm font-medium">Department</label>
        {departments.length === 0 ? (
          <div
            data-testid="req-no-department"
            className="mb-4 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-700 dark:bg-amber-900/20 dark:text-amber-300"
          >
            You are not added to any department yet. Ask an administrator to add
            you to a department before raising a requisition.
          </div>
        ) : (
          <select
            value={departmentId}
            onChange={(e) => setDepartmentId(e.target.value)}
            data-testid="req-department"
            className={`${MODAL_FIELD} mb-4`}
          >
            <option value="">Select department…</option>
            {departments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        )}

        <label className="mb-1 block text-sm font-medium">Items</label>
        <div className="space-y-2">
          {lines.map((l, idx) => (
            <div
              key={idx}
              className="grid items-center gap-2"
              style={{ gridTemplateColumns: "minmax(0,1fr) 5rem 2.5rem" }}
            >
              <select
                value={l.key}
                onChange={(e) =>
                  setLines((ls) => ls.map((x, i) => (i === idx ? { ...x, key: e.target.value } : x)))
                }
                data-testid={`req-item-${idx}`}
                className="w-full min-w-0 rounded-lg border bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
              >
                <option value="">Select item…</option>
                {options.map((o) => (
                  <option key={o.key} value={o.key}>
                    {o.label}
                  </option>
                ))}
              </select>
              <input
                type="number"
                min={1}
                value={l.requestedQty}
                title="Quantity"
                onChange={(e) =>
                  setLines((ls) =>
                    ls.map((x, i) => (i === idx ? { ...x, requestedQty: parseInt(e.target.value || "1", 10) } : x)),
                  )
                }
                className="w-full min-w-0 rounded-lg border bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
              />
              <button
                type="button"
                onClick={() => setLines((ls) => ls.filter((_, i) => i !== idx))}
                className="flex h-full items-center justify-center rounded-lg border border-red-300 text-red-600 hover:bg-red-50 dark:border-red-900"
              >
                <Trash2 size={16} />
              </button>
            </div>
          ))}
        </div>
        <button
          type="button"
          onClick={() => setLines((ls) => [...ls, { key: "", requestedQty: 1 }])}
          className="mt-2 text-sm text-primary hover:underline dark:text-blue-400"
        >
          + Add item
        </button>

        <label className="mb-1 mt-4 block text-sm font-medium">Notes (optional)</label>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={2}
          className={MODAL_FIELD}
        />

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border px-4 py-2 text-sm dark:border-gray-600"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={!canSubmit || saving}
            data-testid="req-submit"
            className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary/90 disabled:opacity-50"
          >
            {saving ? "Submitting…" : "Submit Requisition"}
          </button>
        </div>
      </div>
    </div>
  );
}
