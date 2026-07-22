"use client";

// Material catalog module (2026-07) — the general materials store for
// non-medicine stock: consumables, equipment, instruments, and machines that
// departments requisition. Medicines live in the dedicated pharmacy flow.
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
  X,
  Search,
  PackagePlus,
  AlertTriangle,
  ClipboardList,
  Power,
  PowerOff,
  ShieldCheck,
} from "lucide-react";
import { SkeletonCard, SkeletonTable } from "@/components/Skeleton";

const VIEW_ALLOWED = new Set([
  "ADMIN",
  "PHARMACIST",
  "NURSE",
  "DOCTOR",
  "RECEPTION",
  "LAB_TECH",
]);
const CATEGORIES = ["CONSUMABLE", "EQUIPMENT", "INSTRUMENT", "MACHINE"] as const;
type Category = (typeof CATEGORIES)[number];

const CATEGORY_STYLE: Record<string, string> = {
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
  mainQuantity: number;
  totalQuantity: number;
  reservedStock: number;
  reorderLevel: number;
  unitCost: number | null;
  location: string | null;
  active: boolean;
  departmentQuantities: Array<{
    departmentId: string;
    departmentName: string;
    departmentCode: string;
    quantity: number;
  }>;
}

interface DepartmentOption {
  id: string;
  name: string;
  code: string;
}

interface MaterialLogEntry {
  id: string;
  kind: "AUDIT" | "MAIN_MOVEMENT" | "DEPARTMENT_MOVEMENT";
  action: string;
  actor: { id: string; name: string; role: string } | null;
  occurredAt: string;
  details?: Record<string, unknown> | null;
}

interface MaterialAdjustmentRequest {
  id: string;
  materialId: string;
  departmentId: string;
  delta: number;
  reasonCode: string;
  reasonNote: string | null;
  status: "PENDING" | "APPROVED" | "REJECTED";
  reviewedNote: string | null;
  createdAt: string;
  reviewedAt: string | null;
  material: { id: string; name: string; unit: string };
  department: { id: string; name: string; code: string };
  requestedBy: { id: string; name: string; role: string };
  reviewedBy?: { id: string; name: string; role: string } | null;
}

type StockScope = "ALL" | "MAIN" | string;
type AdjustmentLocationType = "MAIN" | "DEPARTMENT";
type AdjustmentReasonCode =
  | "DAMAGED"
  | "CORRECTION"
  | "FOUND"
  | "TRANSFER_IN"
  | "TRANSFER_OUT"
  | "OTHER";

const ADJUSTMENT_REASONS: Array<{ value: AdjustmentReasonCode; label: string }> = [
  { value: "DAMAGED", label: "Damaged" },
  { value: "CORRECTION", label: "Correction" },
  { value: "FOUND", label: "Found Stock" },
  { value: "TRANSFER_IN", label: "Transfer In" },
  { value: "TRANSFER_OUT", label: "Transfer Out" },
  { value: "OTHER", label: "Other" },
];

export default function MaterialsPage() {
  const { user, isLoading } = useAuthStore();
  const router = useRouter();

  const [rows, setRows] = useState<Material[]>([]);
  const [departments, setDepartments] = useState<DepartmentOption[]>([]);
  const [canManageDirectly, setCanManageDirectly] = useState(false);
  const [canRequestAdjustments, setCanRequestAdjustments] = useState(false);
  const [canApproveAdjustmentRequests, setCanApproveAdjustmentRequests] = useState(false);
  const [notInAnyDepartment, setNotInAnyDepartment] = useState(false);
  const [requests, setRequests] = useState<MaterialAdjustmentRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState("");
  const [catFilter, setCatFilter] = useState<"" | Category>("");
  const [stockScope, setStockScope] = useState<StockScope>("ALL");

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
  const [stockLocationType, setStockLocationType] = useState<AdjustmentLocationType>("MAIN");
  const [stockDepartmentId, setStockDepartmentId] = useState("");
  const [stockReasonCode, setStockReasonCode] = useState<AdjustmentReasonCode>("CORRECTION");
  const [stockReasonNote, setStockReasonNote] = useState("");

  // Activation confirm
  const [statusFor, setStatusFor] = useState<Material | null>(null);

  // Department adjustment request modal
  const [requestFor, setRequestFor] = useState<Material | null>(null);
  const [requestDepartmentId, setRequestDepartmentId] = useState("");
  const [requestDelta, setRequestDelta] = useState(-1);
  const [requestReasonCode, setRequestReasonCode] = useState<AdjustmentReasonCode>("DAMAGED");
  const [requestReasonNote, setRequestReasonNote] = useState("");

  // Log modal
  const [logFor, setLogFor] = useState<Material | null>(null);
  const [logLoading, setLogLoading] = useState(false);
  const [timeline, setTimeline] = useState<MaterialLogEntry[]>([]);

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
      qs.set("includeDepartments", "true");
      const res = await api.get<{
        data: Material[];
        meta?: {
          departments?: DepartmentOption[];
          canManageDirectly?: boolean;
          canRequestAdjustments?: boolean;
          canApproveAdjustmentRequests?: boolean;
          notInAnyDepartment?: boolean;
        };
      }>(`/materials?${qs.toString()}`);
      const materials = Array.isArray(res?.data) ? res.data : [];
      const deptOptions = Array.isArray(res?.meta?.departments) ? res.meta.departments : [];
      const direct = !!res?.meta?.canManageDirectly;
      const canRequest = !!res?.meta?.canRequestAdjustments;
      const canApprove = !!res?.meta?.canApproveAdjustmentRequests;
      const noDepartments = !!res?.meta?.notInAnyDepartment;
      setDepartments(deptOptions);
      setCanManageDirectly(direct);
      setCanRequestAdjustments(canRequest);
      setCanApproveAdjustmentRequests(canApprove);
      setNotInAnyDepartment(noDepartments);
      setRows([...materials].sort((a, b) => a.name.localeCompare(b.name)));
      if (!direct && deptOptions.length > 0 && (stockScope === "MAIN" || stockScope === "ALL")) {
        setStockScope("ALL");
      }
      if (direct || canRequest || canApprove) {
        const reqRes = await api.get<{ data: MaterialAdjustmentRequest[] }>("/materials/adjustment-requests");
        setRequests(Array.isArray(reqRes?.data) ? reqRes.data : []);
      } else {
        setRequests([]);
      }
    } catch {
      setRows([]);
      setDepartments([]);
      setCanManageDirectly(false);
      setCanRequestAdjustments(false);
      setCanApproveAdjustmentRequests(false);
      setNotInAnyDepartment(false);
      setRequests([]);
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

  function openAdjust(m: Material) {
    setStockFor(m);
    setStockDelta(0);
    if (stockScope !== "ALL" && stockScope !== "MAIN") {
      setStockLocationType("DEPARTMENT");
      setStockDepartmentId(stockScope);
    } else {
      setStockLocationType("MAIN");
      setStockDepartmentId("");
    }
    setStockReasonCode("CORRECTION");
    setStockReasonNote("");
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
        locationType: stockLocationType,
        departmentId:
          stockLocationType === "DEPARTMENT" ? stockDepartmentId || undefined : undefined,
        delta: Number(stockDelta),
        reasonCode: stockReasonCode,
        reasonNote: stockReasonNote || undefined,
      });
      toast.success(`Stock updated for "${stockFor.name}"`);
      setStockFor(null);
      setStockDelta(0);
      setStockLocationType("MAIN");
      setStockDepartmentId("");
      setStockReasonCode("CORRECTION");
      setStockReasonNote("");
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to adjust stock");
    }
  }, [
    stockFor,
    stockDelta,
    stockLocationType,
    stockDepartmentId,
    stockReasonCode,
    stockReasonNote,
    load,
  ]);

  const setActiveState = useCallback(async () => {
    if (!statusFor) return;
    const m = statusFor;
    setStatusFor(null);
    try {
      await api.post(`/materials/${m.id}/set-active`, { active: !m.active });
      toast.success(`"${m.name}" ${m.active ? "deactivated" : "activated"}`);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update status");
    }
  }, [statusFor, load]);

  const openRequestAdjust = useCallback(
    (material: Material) => {
      setRequestFor(material);
      if (stockScope !== "ALL" && stockScope !== "MAIN") {
        setRequestDepartmentId(stockScope);
      } else {
        setRequestDepartmentId(material.departmentQuantities[0]?.departmentId ?? "");
      }
      setRequestDelta(-1);
      setRequestReasonCode("DAMAGED");
      setRequestReasonNote("");
    },
    [stockScope],
  );

  const submitAdjustmentRequest = useCallback(async () => {
    if (!requestFor) return;
    if (!requestDepartmentId) {
      toast.error("Select a department");
      return;
    }
    if (requestDelta >= 0) {
      toast.error("Request quantity must reduce stock");
      return;
    }
    try {
      await api.post(`/materials/${requestFor.id}/adjustment-requests`, {
        departmentId: requestDepartmentId,
        delta: requestDelta,
        reasonCode: requestReasonCode,
        reasonNote: requestReasonNote || undefined,
      });
      toast.success(`Adjustment request sent for "${requestFor.name}"`);
      setRequestFor(null);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to submit adjustment request");
    }
  }, [
    requestFor,
    requestDepartmentId,
    requestDelta,
    requestReasonCode,
    requestReasonNote,
    load,
  ]);

  const reviewAdjustmentRequest = useCallback(
    async (requestId: string, status: "APPROVED" | "REJECTED") => {
      try {
        await api.post(`/materials/adjustment-requests/${requestId}/review`, { status });
        toast.success(`Request ${status === "APPROVED" ? "approved" : "rejected"}`);
        await load();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to review request");
      }
    },
    [load],
  );

  const openLog = useCallback(async (material: Material) => {
    setLogFor(material);
    setLogLoading(true);
    try {
      const res = await api.get<{ data?: { timeline?: MaterialLogEntry[] } }>(
        `/materials/${material.id}/logs`,
      );
      setTimeline(Array.isArray(res?.data?.timeline) ? res.data.timeline : []);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load material log");
      setTimeline([]);
    } finally {
      setLogLoading(false);
    }
  }, []);

  const filteredRows = useMemo(() => {
    if (stockScope === "ALL" || stockScope === "MAIN") return rows;
    return rows.filter((m) =>
      m.departmentQuantities.some(
        (holding) => holding.departmentId === stockScope && holding.quantity > 0,
      ),
    );
  }, [rows, stockScope]);

  const quantityForScope = useCallback(
    (material: Material) => {
      if (stockScope === "ALL") return material.totalQuantity;
      if (stockScope === "MAIN") return material.mainQuantity;
      return (
        material.departmentQuantities.find((holding) => holding.departmentId === stockScope)
          ?.quantity ?? 0
      );
    },
    [stockScope],
  );

  const summary = useMemo(() => {
    const total = filteredRows.length;
    const lowStock = filteredRows.filter((m) => quantityForScope(m) <= m.reorderLevel).length;
    const totalUnits = filteredRows.reduce((s, m) => s + quantityForScope(m), 0);
    return { total, lowStock, totalUnits };
  }, [filteredRows, quantityForScope]);

  if (isLoading || (user && !allowed)) return null;

  return (
    <div>
      <div className="mb-6 flex items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold">
            <Boxes size={22} /> Materials
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Central catalog of non-medicine items departments can requisition
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-3">
          <select
            value={stockScope}
            onChange={(e) => setStockScope(e.target.value)}
            className={`${FIELD} min-w-[220px]`}
            data-testid="material-stock-scope"
          >
            <option value="ALL">All</option>
            {canManageDirectly && <option value="MAIN">Main Inventory</option>}
            {departments.map((department) => (
              <option key={department.id} value={department.id}>
                {department.name} ({department.code})
              </option>
            ))}
          </select>
          {canManageDirectly && (
            <button
              type="button"
              onClick={openCreate}
              data-testid="material-create-btn"
              className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary/90"
            >
              <Plus size={16} /> Add New Item
            </button>
          )}
        </div>
      </div>

      {notInAnyDepartment && !canManageDirectly && (
        <div className="mb-6 rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-800 dark:border-amber-700 dark:bg-amber-950/20 dark:text-amber-300">
          You are not assigned to any department yet, so no department stock is visible here.
        </div>
      )}

      {canApproveAdjustmentRequests && requests.length > 0 && (
        <section className="mb-6 rounded-xl bg-white p-4 shadow-sm dark:border dark:border-gray-700 dark:bg-gray-800">
          <div className="mb-3 flex items-center gap-2 text-sm font-semibold">
            <ShieldCheck size={16} /> Pending adjustment requests
          </div>
          <div className="space-y-2">
            {requests
              .filter((request) => request.status === "PENDING")
              .map((request) => (
                <div
                  key={request.id}
                  className="flex flex-col gap-3 rounded-lg border p-3 text-sm dark:border-gray-700 lg:flex-row lg:items-center lg:justify-between"
                >
                  <div>
                    <div className="font-medium">
                      {request.material.name} - {request.department.name} ({request.department.code})
                    </div>
                    <div className="text-xs text-gray-500 dark:text-gray-400">
                      Requested by {request.requestedBy.name} ({request.requestedBy.role}) | {Math.abs(request.delta)} {request.material.unit} | {request.reasonCode}
                    </div>
                    {request.reasonNote && (
                      <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">{request.reasonNote}</div>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => reviewAdjustmentRequest(request.id, "APPROVED")}
                      className="rounded-lg bg-emerald-600 px-3 py-2 text-xs font-medium text-white hover:bg-emerald-700"
                    >
                      Approve
                    </button>
                    <button
                      type="button"
                      onClick={() => reviewAdjustmentRequest(request.id, "REJECTED")}
                      className="rounded-lg bg-red-600 px-3 py-2 text-xs font-medium text-white hover:bg-red-700"
                    >
                      Reject
                    </button>
                  </div>
                </div>
              ))}
          </div>
        </section>
      )}

      {canRequestAdjustments && requests.length > 0 && (
        <section className="mb-6 rounded-xl bg-white p-4 shadow-sm dark:border dark:border-gray-700 dark:bg-gray-800">
          <div className="mb-3 flex items-center gap-2 text-sm font-semibold">
            <ShieldCheck size={16} /> My adjustment requests
          </div>
          <div className="space-y-2">
            {requests.slice(0, 6).map((request) => (
              <div key={request.id} className="flex flex-col gap-2 rounded-lg border p-3 text-sm dark:border-gray-700 lg:flex-row lg:items-center lg:justify-between">
                <div>
                  <div className="font-medium">
                    {request.material.name} - {request.department.name}
                  </div>
                  <div className="text-xs text-gray-500 dark:text-gray-400">
                    {Math.abs(request.delta)} {request.material.unit} | {request.reasonCode} | {new Date(request.createdAt).toLocaleString()}
                  </div>
                </div>
                <span className={`inline-flex rounded-full px-2 py-1 text-xs font-medium ${
                  request.status === "APPROVED"
                    ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300"
                    : request.status === "REJECTED"
                      ? "bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-300"
                      : "bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300"
                }`}>
                  {request.status}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

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
            placeholder="Search name or SKU..."
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
            <SkeletonTable rows={6} columns={7} />
          </div>
        ) : filteredRows.length === 0 ? (
          <div className="p-10 text-center text-gray-500" data-testid="material-empty">
            No materials in this view yet.
            {canManageDirectly && (
              <>
                {" "}
                <button type="button" onClick={openCreate} className="font-medium text-primary hover:underline">
                  Add your first item
                </button>
                .
              </>
            )}
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
                  <th className="px-4 py-3">Distribution</th>
                  <th className="px-4 py-3">Unit</th>
                  <th className="px-4 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredRows.map((m) => {
                  const visibleQuantity = quantityForScope(m);
                  const low = visibleQuantity <= m.reorderLevel;
                  return (
                    <tr key={m.id} data-testid="material-row" className="border-b text-sm last:border-0 dark:border-gray-700">
                      <td className="px-4 py-3">
                        <span className="font-medium">{m.name}</span>
                        {m.sku && <span className="ml-2 text-xs text-gray-400">{m.sku}</span>}
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
                        {visibleQuantity}
                        {low && <AlertTriangle size={12} className="ml-1 inline" />}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums text-gray-500">
                        {canManageDirectly ? m.reservedStock : "-"}
                      </td>
                      <td className="px-4 py-3 text-xs text-gray-500 dark:text-gray-400">
                        {stockScope === "ALL" ? (
                          <span>
                            {canManageDirectly ? `Main: ${m.mainQuantity}` : ""}
                            {m.departmentQuantities.map((holding) => (
                              <span key={holding.departmentId}>
                                {canManageDirectly || holding.departmentId !== m.departmentQuantities[0]?.departmentId ? " | " : ""}
                                {holding.departmentCode || holding.departmentName}: {holding.quantity}
                              </span>
                            ))}
                          </span>
                        ) : stockScope === "MAIN" ? (
                          <span>Central store</span>
                        ) : (
                          <span>
                            {m.departmentQuantities.find((holding) => holding.departmentId === stockScope)
                              ?.departmentName ?? "Department"}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-gray-500 dark:text-gray-400">{m.unit}</td>
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-end gap-1">
                          <button
                            type="button"
                            onClick={() => openLog(m)}
                            data-testid={`material-log-${m.id}`}
                            title="Log"
                            className="rounded-md p-1.5 text-gray-500 hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-gray-700 dark:hover:text-gray-200"
                          >
                            <ClipboardList size={15} />
                          </button>
                          {canManageDirectly ? (
                            <>
                              <button
                                type="button"
                                onClick={() => openAdjust(m)}
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
                                onClick={() => setStatusFor(m)}
                                data-testid={`material-active-${m.id}`}
                                title={m.active ? "Deactivate" : "Activate"}
                                className={`rounded-md p-1.5 ${
                                  m.active
                                    ? "text-amber-500 hover:bg-amber-50 dark:hover:bg-amber-950/40"
                                    : "text-emerald-500 hover:bg-emerald-50 dark:hover:bg-emerald-950/40"
                                }`}
                              >
                                {m.active ? <PowerOff size={15} /> : <Power size={15} />}
                              </button>
                            </>
                          ) : canRequestAdjustments ? (
                            <button
                              type="button"
                              onClick={() => openRequestAdjust(m)}
                              data-testid={`material-request-${m.id}`}
                              title="Request adjustment"
                              className="rounded-md p-1.5 text-amber-500 hover:bg-amber-50 dark:hover:bg-amber-950/40"
                            >
                              <ShieldCheck size={15} />
                            </button>
                          ) : null}
                        </div>
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
                {submitting ? "Saving..." : editing ? "Save Changes" : "Add Item"}
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
              {stockFor.name} - current view on hand {quantityForScope(stockFor)} {stockFor.unit}
            </p>
            <Labeled label="Location">
              <select
                value={stockLocationType === "MAIN" ? "MAIN" : stockDepartmentId}
                onChange={(e) => {
                  if (e.target.value === "MAIN") {
                    setStockLocationType("MAIN");
                    setStockDepartmentId("");
                  } else {
                    setStockLocationType("DEPARTMENT");
                    setStockDepartmentId(e.target.value);
                  }
                }}
                className={FIELD}
              >
                <option value="MAIN">Main Inventory</option>
                {departments.map((department) => (
                  <option key={department.id} value={department.id}>
                    {department.name} ({department.code})
                  </option>
                ))}
              </select>
            </Labeled>
            <div className="mt-3 grid grid-cols-2 gap-3">
              <Labeled label="Reason">
                <select
                  value={stockReasonCode}
                  onChange={(e) => setStockReasonCode(e.target.value as AdjustmentReasonCode)}
                  className={FIELD}
                >
                  {ADJUSTMENT_REASONS.map((reason) => (
                    <option key={reason.value} value={reason.value}>
                      {reason.label}
                    </option>
                  ))}
                </select>
              </Labeled>
              <Labeled label="Quantity change">
                <input type="number" value={stockDelta} onChange={(e) => setStockDelta(Number(e.target.value))} data-testid="material-stock-delta" className={FIELD} />
              </Labeled>
            </div>
            <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
              Use negative quantities for damage or reductions, positive quantities for found stock or increases.
            </p>
            <div className="mt-3">
              <Labeled label="Reason note">
                <input
                  type="text"
                  value={stockReasonNote}
                  onChange={(e) => setStockReasonNote(e.target.value)}
                  placeholder="Add detail, especially for Other"
                  className={FIELD}
                />
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

      {/* Department adjustment request */}
      {requestFor && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true">
          <div className="w-full max-w-sm rounded-xl bg-white p-6 shadow-xl dark:border dark:border-gray-700 dark:bg-gray-800">
            <h3 className="mb-1 text-lg font-semibold">Request stock reduction</h3>
            <p className="mb-4 text-sm text-gray-500 dark:text-gray-400">
              {requestFor.name} - submit a damage/missing request for admin approval
            </p>
            <Labeled label="Department">
              <select
                value={requestDepartmentId}
                onChange={(e) => setRequestDepartmentId(e.target.value)}
                className={FIELD}
              >
                <option value="">Select department</option>
                {departments.map((department) => (
                  <option key={department.id} value={department.id}>
                    {department.name} ({department.code})
                  </option>
                ))}
              </select>
            </Labeled>
            <div className="mt-3 grid grid-cols-2 gap-3">
              <Labeled label="Reason">
                <select
                  value={requestReasonCode}
                  onChange={(e) => setRequestReasonCode(e.target.value as AdjustmentReasonCode)}
                  className={FIELD}
                >
                  {ADJUSTMENT_REASONS.filter((reason) => !["FOUND", "TRANSFER_IN"].includes(reason.value)).map((reason) => (
                    <option key={reason.value} value={reason.value}>
                      {reason.label}
                    </option>
                  ))}
                </select>
              </Labeled>
              <Labeled label="Quantity reduce">
                <input
                  type="number"
                  value={requestDelta}
                  onChange={(e) => setRequestDelta(Number(e.target.value))}
                  className={FIELD}
                />
              </Labeled>
            </div>
            <div className="mt-3">
              <Labeled label="Reason note">
                <input
                  type="text"
                  value={requestReasonNote}
                  onChange={(e) => setRequestReasonNote(e.target.value)}
                  placeholder="Explain the damage, missing unit, or correction"
                  className={FIELD}
                />
              </Labeled>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" onClick={() => setRequestFor(null)} className="rounded-lg border px-3 py-2 text-sm font-medium hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-700">
                Cancel
              </button>
              <button type="button" onClick={submitAdjustmentRequest} className="rounded-lg bg-primary px-3 py-2 text-sm font-medium text-white hover:bg-primary/90">
                Submit request
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Material log */}
      {logFor && (
        <div className="fixed inset-0 z-[55] flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true">
          <div className="w-full max-w-3xl rounded-xl bg-white p-6 shadow-xl dark:border dark:border-gray-700 dark:bg-gray-800">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h3 className="text-lg font-semibold">Material log</h3>
                <p className="text-sm text-gray-500 dark:text-gray-400">{logFor.name}</p>
              </div>
              <button type="button" onClick={() => setLogFor(null)} className="rounded-md p-1 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700">
                <X size={18} />
              </button>
            </div>
            {logLoading ? (
              <div className="space-y-2">
                <SkeletonCard />
                <SkeletonCard />
              </div>
            ) : timeline.length === 0 ? (
              <p className="py-8 text-center text-sm text-gray-400">No log entries yet.</p>
            ) : (
              <div className="max-h-[60vh] space-y-2 overflow-y-auto">
                {timeline.map((entry) => (
                  <div key={entry.id} className="rounded-lg border p-3 text-sm dark:border-gray-700">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="font-medium">{entry.action.replaceAll("_", " ")}</div>
                      <div className="text-xs text-gray-500 dark:text-gray-400">
                        {new Date(entry.occurredAt).toLocaleString()}
                      </div>
                    </div>
                    <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                      {entry.actor ? `${entry.actor.name} (${entry.actor.role})` : "System"}
                    </div>
                    <div className="mt-2 text-xs text-gray-600 dark:text-gray-300">
                      {formatLogDetails(entry.details)}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Activate / deactivate confirm */}
      {statusFor && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4" style={{ zIndex: 60 }} data-testid="material-confirm" role="dialog" aria-modal="true">
          <div className="w-full max-w-sm rounded-xl bg-white p-6 shadow-xl dark:border dark:border-gray-700 dark:bg-gray-800">
            <div className="mb-3 flex items-center gap-3">
              <div className={`flex h-10 w-10 items-center justify-center rounded-full ${
                statusFor.active
                  ? "bg-amber-100 text-amber-600 dark:bg-amber-950/40 dark:text-amber-300"
                  : "bg-emerald-100 text-emerald-600 dark:bg-emerald-950/40 dark:text-emerald-300"
              }`}>
                {statusFor.active ? <PowerOff size={20} /> : <Power size={20} />}
              </div>
              <h3 className="text-lg font-semibold">{statusFor.active ? "Deactivate item?" : "Activate item?"}</h3>
            </div>
            <p className="mb-5 text-sm text-gray-600 dark:text-gray-300">
              <strong>{statusFor.name}</strong> will be {statusFor.active ? "hidden from new use" : "made active again"}.
            </p>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setStatusFor(null)} className="rounded-lg border px-3 py-2 text-sm font-medium hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-700">
                Cancel
              </button>
              <button
                type="button"
                onClick={setActiveState}
                data-testid="material-confirm-ok"
                className={`rounded-lg px-3 py-2 text-sm font-medium text-white ${
                  statusFor.active ? "bg-amber-600 hover:bg-amber-700" : "bg-emerald-600 hover:bg-emerald-700"
                }`}
              >
                {statusFor.active ? "Deactivate" : "Activate"}
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

function formatLogDetails(details: Record<string, unknown> | null | undefined) {
  if (!details) return "No extra details";
  return Object.entries(details)
    .map(([key, value]) => `${key}: ${String(value)}`)
    .join(" | ");
}
