"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import { useConfirm } from "@/lib/use-dialog";
import { useAuthStore } from "@/lib/store";
import { Search, Plus, Pill, X, Pencil, Trash2 } from "lucide-react";
import { SkeletonTable } from "@/components/Skeleton";
import { TablePagination } from "@/components/TablePagination";

// Issue #509: page-level gate matching API authorize() in
// apps/api/src/routes/medicines.ts (writes are ADMIN/DOCTOR; the master list
// is operationally needed by clinical + pharmacy roles). Page previously had
// no gate, so PATIENT / RECEPTION / LAB_TECH could read the formulary chrome
// via the URL bar.
const VIEW_ALLOWED = new Set(["ADMIN", "DOCTOR", "NURSE", "PHARMACIST"]);

interface Medicine {
  id: string;
  name: string;
  genericName?: string | null;
  form?: string | null;
  strength?: string | null;
  category?: string | null;
  rxRequired?: boolean;
  manufacturer?: string | null;
  // 2026-05-25 — MRP (Maximum Retail Price) printed on the pack.
  // Stored as Float; null when not yet recorded.
  mrp?: number | null;
  interactions?: Interaction[];
}

interface Interaction {
  id: string;
  severity: string;
  description: string;
  interactsWith?: { id: string; name: string };
}

const CATEGORIES = [
  "",
  "Antibiotic",
  "Analgesic",
  "Antiviral",
  "Antifungal",
  "Antihypertensive",
  "Antidiabetic",
  "Cardiac",
  "Respiratory",
  "Gastrointestinal",
  "Psychiatric",
  "Other",
];

export default function MedicinesPage() {
  const { user, isLoading } = useAuthStore();
  const router = useRouter();
  const pathname = usePathname();
  const confirm = useConfirm();
  const [medicines, setMedicines] = useState<Medicine[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("");
  const [selected, setSelected] = useState<Medicine | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  // Server-side pagination — /medicines accepts ?page=N&limit=M and returns
  // meta.total. Client-side slicing wouldn't work here because the API
  // defaults to limit=20 (caps at 100), so we'd never see medicines past
  // index 20 without explicitly walking the pages.
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [total, setTotal] = useState(0);
  // Pagination scroll behavior — direction-split per user request 2026-05-25:
  //   - NEXT (>) : after the new page renders, scroll so the grid's first
  //     card sits at the top of the scroll area. User reads top-down.
  //   - PREV (<) : anchor the pagination bar in place via the same
  //     viewport-offset capture/restore trick, so the bar stays under
  //     the user's cursor for repeated back-clicks.
  // Refs:
  //   - paginationRef → the pagination wrapper, for anchor-restore on PREV
  //   - gridRef       → the cards grid, for scroll-to-top on NEXT
  //   - pendingDirectionRef → "forward" | "backward" set on click,
  //     consumed by the layout effect once new data has rendered.
  //   - barOffsetBeforeLoadRef → captured viewport-top of the pagination
  //     bar at click time, used only on PREV.
  const paginationRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const pendingDirectionRef = useRef<"forward" | "backward" | null>(null);
  const barOffsetBeforeLoadRef = useRef<number | null>(null);

  function changePage(newPage: number) {
    pendingDirectionRef.current = newPage > page ? "forward" : "backward";
    if (pendingDirectionRef.current === "backward" && paginationRef.current) {
      barOffsetBeforeLoadRef.current =
        paginationRef.current.getBoundingClientRect().top;
    }
    setPage(newPage);
  }

  // Issue #509: redirect non-allowed roles to /dashboard/not-authorized.
  useEffect(() => {
    if (!isLoading && user && !VIEW_ALLOWED.has(user.role)) {
      toast.error("Medicines master is restricted to clinical and pharmacy roles.");
      router.replace(
        `/dashboard/not-authorized?from=${encodeURIComponent(pathname || "/dashboard/medicines")}`,
      );
    }
  }, [user, isLoading, router, pathname]);
  // Issue #85: edit/delete support — `editing` is the row currently being
  // edited (null = creating new); switching the modal between create/edit
  // reuses the same form fields.
  const [editing, setEditing] = useState<Medicine | null>(null);
  const [form, setForm] = useState({
    name: "",
    genericName: "",
    form: "",
    strength: "",
    category: "",
    rxRequired: true,
    manufacturer: "",
    // String in form state (raw input); coerced to Number on submit.
    // Empty string means "no MRP" and is sent as null on PATCH / omitted on POST.
    mrp: "",
  });

  const isAdmin = user?.role === "ADMIN";
  const isDoctor = user?.role === "DOCTOR";
  const isPharmacist = user?.role === "PHARMACIST";
  // Create/edit allowed for ADMIN + DOCTOR + PHARMACIST (matches the API
  // POST/PATCH guard — pharmacists own the medicine catalog); delete is
  // ADMIN-only.
  const canEdit = isAdmin || isDoctor || isPharmacist;
  const canDelete = isAdmin;

  // Page-window derivation. `total` comes from /medicines `meta.total`
  // (the FULL filtered count on the server); `medicines` is just the
  // current page's slice. Don't compute totalPages off medicines.length
  // — that would mistakenly bound it to ≤ pageSize and lock the user
  // on page 1 forever.
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const currentPage = Math.min(page, totalPages);

  function openEdit(m: Medicine) {
    setEditing(m);
    setForm({
      name: m.name ?? "",
      genericName: m.genericName ?? "",
      form: m.form ?? "",
      strength: m.strength ?? "",
      category: m.category ?? "",
      rxRequired: !!m.rxRequired,
      manufacturer: m.manufacturer ?? "",
      mrp: m.mrp == null ? "" : String(m.mrp),
    });
    setShowAdd(true);
  }

  async function handleDelete(m: Medicine) {
    const ok = await confirm({
      title: `Delete ${m.name}?`,
      message: "This catalog entry will be removed permanently.",
      danger: true,
    });
    if (!ok) return;
    try {
      await api.delete(`/medicines/${m.id}`);
      toast.success(`${m.name} deleted`);
      // Refresh list + close any open detail modal that might have shown the row.
      if (selected?.id === m.id) setSelected(null);
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete medicine");
    }
  }

  // Reset to page 1 when the filter changes (so switching from "Antibiotic"
  // page 3 → "Antiviral" doesn't strand the user on an empty page). The
  // separate refetch effect below handles the actual /medicines call once
  // `page` settles back to 1.
  useEffect(() => {
    setPage(1);
  }, [search, category]);

  // Fetch whenever the filter OR the page-window changes. Server-side
  // pagination — the API returns the current page + meta.total, and we
  // render those rows directly (no client-side slicing).
  useEffect(() => {
    load();
  }, [search, category, page, pageSize]);

  // After the new page lays out, do the direction-specific scroll move.
  // useLayoutEffect runs synchronously before the browser paints, so any
  // adjustment is invisible — no flash of the natural position.
  //
  // Scroll target: the dashboard layout puts the scrollable region on
  // `<main id="main-content" overflow-y-auto>` — NOT on window. window
  // scroll is a no-op here. Fall back to documentElement defensively
  // for surfaces that mount this page outside the dashboard chrome.
  useLayoutEffect(() => {
    if (loading) return;
    const direction = pendingDirectionRef.current;
    if (!direction) return;
    pendingDirectionRef.current = null;

    const scroller =
      document.getElementById("main-content") ??
      (document.scrollingElement as HTMLElement | null) ??
      document.documentElement;

    if (direction === "forward") {
      // NEXT click — bring the grid's top to the top of the scroller
      // (minus a small breathing-room offset so the search bar is still
      // visible above). Computed via getBoundingClientRect because the
      // grid's offsetTop is relative to its nearest positioned ancestor
      // which isn't necessarily the scroller.
      if (!gridRef.current) return;
      const gridTop = gridRef.current.getBoundingClientRect().top;
      const scrollerTop = scroller.getBoundingClientRect().top;
      const delta = gridTop - scrollerTop;
      // Leave ~16px of breathing room above the grid so the page header
      // and filter row peek above it — feels less jarring than slamming
      // the grid against the very top edge of the scroll region.
      const target = delta - 16;
      if (Math.abs(target) > 1) scroller.scrollTop += target;
      return;
    }

    // PREV click — restore the pagination bar to its captured offset so
    // the user can chain back-clicks without the bar moving.
    if (barOffsetBeforeLoadRef.current === null) return;
    if (!paginationRef.current) return;
    const newTop = paginationRef.current.getBoundingClientRect().top;
    const delta = newTop - barOffsetBeforeLoadRef.current;
    barOffsetBeforeLoadRef.current = null;
    if (Math.abs(delta) > 1) scroller.scrollTop += delta;
  }, [loading, medicines]);

  async function load() {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (search) params.set("search", search);
      if (category) params.set("category", category);
      params.set("page", String(page));
      params.set("limit", String(pageSize));
      const res = await api.get<{
        data: Medicine[];
        meta?: { total?: number };
      }>(`/medicines?${params.toString()}`);
      setMedicines(res.data);
      setTotal(res.meta?.total ?? res.data.length);
    } catch {
      // empty
    }
    setLoading(false);
  }

  async function openDetail(m: Medicine) {
    try {
      const res = await api.get<{ data: Medicine }>(`/medicines/${m.id}`);
      setSelected(res.data);
    } catch {
      setSelected(m);
    }
  }

  async function createMedicine(e: React.FormEvent) {
    e.preventDefault();
    // A4: parent form is `noValidate` — every required field needs a
    // React-side guard so inline toast rendering isn't short-circuited by
    // the browser's native constraint UI.
    if (!form.name.trim()) {
      toast.error("Name is required");
      return;
    }
    // Issue #41: Manufacturer is required. Guard here in addition to the
    // server-side Zod refinement (which is the source of truth).
    if (!form.manufacturer.trim()) {
      toast.error("Manufacturer is required");
      return;
    }
    // MRP coercion. Form holds a string; API expects number | null | undefined.
    // - "" → undefined on create (Zod field is optional); null on edit (so a
    //   cleared input actually clears the column).
    // - Non-numeric input rejected up-front with a clean toast.
    let mrpForApi: number | null | undefined;
    const mrpRaw = form.mrp.trim();
    if (mrpRaw === "") {
      mrpForApi = editing ? null : undefined;
    } else {
      const parsed = Number(mrpRaw);
      if (!Number.isFinite(parsed) || parsed < 0) {
        toast.error("MRP must be a non-negative number");
        return;
      }
      mrpForApi = parsed;
    }
    try {
      const payload = {
        ...form,
        genericName: form.genericName || undefined,
        form: form.form || undefined,
        strength: form.strength || undefined,
        category: form.category || undefined,
        manufacturer: form.manufacturer.trim(),
        mrp: mrpForApi,
      };
      if (editing) {
        await api.patch(`/medicines/${editing.id}`, payload);
        toast.success("Medicine updated");
      } else {
        await api.post("/medicines", payload);
        toast.success("Medicine created");
      }
      setShowAdd(false);
      setEditing(null);
      setForm({
        name: "",
        genericName: "",
        form: "",
        strength: "",
        category: "",
        rxRequired: true,
        manufacturer: "",
        mrp: "",
      });
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save medicine");
    }
  }

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Medicines</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Medicine catalog &amp; interactions
          </p>
        </div>
        {canEdit && (
          <button
            onClick={() => setShowAdd(true)}
            className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark"
          >
            <Plus size={16} /> Add Medicine
          </button>
        )}
      </div>

      <div className="mb-4 flex flex-wrap gap-3">
        <div className="relative flex-1 min-w-[200px]">
          <Search
            size={16}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400"
          />
          <input
            placeholder="Search medicines..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 pl-9 text-sm text-gray-900 placeholder-gray-400 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100 dark:placeholder-gray-500"
          />
        </div>
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
        >
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {c || "All Categories"}
            </option>
          ))}
        </select>
      </div>

      {/* Skeleton ONLY when we have no data yet (first load, filter-change
          that emptied the previous list). On chevron clicks we keep the
          old page rendered (slightly dimmed) until the new page arrives,
          so the grid's height — and therefore the pagination bar's
          position — never collapses + reflows. That was the cause of the
          "bar jumps when I click next" feel. */}
      {loading && medicines.length === 0 ? (
        <div
          data-testid="medicines-loading"
          aria-busy="true"
          className="rounded-xl bg-white p-4 shadow-sm dark:bg-gray-800"
        >
          <SkeletonTable rows={6} columns={5} />
        </div>
      ) : medicines.length === 0 ? (
        <div className="rounded-xl bg-white p-8 text-center text-gray-500 shadow-sm dark:bg-gray-800 dark:text-gray-400">
          No medicines found.
        </div>
      ) : (
        <div
          ref={gridRef}
          className={`grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 transition-opacity ${
            loading ? "opacity-60" : "opacity-100"
          }`}
          aria-busy={loading}
        >
          {medicines.map((m) => (
            // Issue #85: card wrapper is now a <div>, not a <button>, so we
            // can place real <button> children for Edit / Delete without
            // nesting interactive elements (which would prevent the inner
            // clicks from firing). The clickable detail surface is still
            // the card body — wrapped as its own button so keyboard focus
            // is preserved.
            <div
              key={m.id}
              data-testid="medicine-card"
              data-medicine-id={m.id}
              className="rounded-xl bg-white p-4 text-gray-900 shadow-sm hover:shadow dark:bg-gray-800 dark:text-gray-100"
            >
              <button
                type="button"
                onClick={() => openDetail(m)}
                className="block w-full text-left"
              >
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-2">
                    <Pill size={16} className="text-primary" />
                    <div>
                      <h3 className="font-semibold">{m.name}</h3>
                      {m.genericName && (
                        <p className="text-xs text-gray-500 dark:text-gray-400">
                          {m.genericName}
                        </p>
                      )}
                    </div>
                  </div>
                  {m.rxRequired && (
                    <span className="rounded bg-red-100 px-1.5 py-0.5 text-xs text-red-700 dark:bg-red-900/40 dark:text-red-300">
                      Rx
                    </span>
                  )}
                </div>
                <p className="mt-2 text-sm text-gray-600 dark:text-gray-300">
                  {[m.form, m.strength].filter(Boolean).join(" · ") || "—"}
                </p>
                <p
                  className="mt-1 text-xs text-gray-500 dark:text-gray-400"
                  data-testid="medicine-manufacturer"
                >
                  Mfg: {m.manufacturer || "—"}
                </p>
                {m.mrp != null && (
                  <p
                    className="mt-0.5 text-xs font-medium text-gray-700 dark:text-gray-200"
                    data-testid="medicine-mrp"
                  >
                    MRP: ₹{m.mrp.toFixed(2)}
                  </p>
                )}
                {m.category && (
                  <span className="mt-2 inline-block rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-600 dark:bg-gray-700 dark:text-gray-200">
                    {m.category}
                  </span>
                )}
              </button>
              {(canEdit || canDelete) && (
                <div className="mt-3 flex items-center justify-end gap-1 border-t border-gray-100 pt-2 dark:border-gray-700">
                  {canEdit && (
                    <button
                      type="button"
                      onClick={() => openEdit(m)}
                      data-testid="medicine-edit"
                      className="flex items-center gap-1 rounded-lg border border-gray-200 px-2 py-1 text-xs text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
                    >
                      <Pencil size={12} /> Edit
                    </button>
                  )}
                  {canDelete && (
                    <button
                      type="button"
                      onClick={() => handleDelete(m)}
                      data-testid="medicine-delete"
                      className="flex items-center gap-1 rounded-lg border border-red-200 px-2 py-1 text-xs text-red-600 hover:bg-red-50 dark:border-red-900/50 dark:text-red-400 dark:hover:bg-red-900/20"
                    >
                      <Trash2 size={12} /> Delete
                    </button>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {total > 0 && (
        <div ref={paginationRef} className="mt-3 rounded-xl bg-white shadow-sm dark:bg-gray-800">
          <TablePagination
            page={currentPage}
            totalPages={totalPages}
            pageSize={pageSize}
            totalItems={total}
            onPageChange={changePage}
            onPageSizeChange={(n) => {
              setPage(1);
              setPageSize(n);
            }}
          />
        </div>
      )}

      {/* Detail Modal */}
      {selected && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-h-[90vh] overflow-y-auto max-w-2xl rounded-2xl bg-white p-6 text-gray-900 shadow-xl dark:bg-gray-800 dark:text-gray-100">
            <div className="mb-4 flex items-start justify-between">
              <div>
                <h2 className="text-xl font-bold">{selected.name}</h2>
                {selected.genericName && (
                  <p className="text-sm text-gray-500 dark:text-gray-400">
                    {selected.genericName}
                  </p>
                )}
              </div>
              <button
                onClick={() => setSelected(null)}
                className="rounded p-1 hover:bg-gray-100 dark:hover:bg-gray-700"
              >
                <X size={20} />
              </button>
            </div>

            <div className="grid grid-cols-2 gap-3 text-sm">
              <Info label="Form" value={selected.form || "—"} />
              <Info label="Strength" value={selected.strength || "—"} />
              <Info label="Category" value={selected.category || "—"} />
              <Info
                label="Rx Required"
                value={selected.rxRequired ? "Yes" : "No"}
              />
              <Info
                label="MRP"
                value={selected.mrp != null ? `₹${selected.mrp.toFixed(2)}` : "—"}
              />
              <Info
                label="Manufacturer"
                value={selected.manufacturer || "—"}
                fullWidth
              />
            </div>

            <div className="mt-4 border-t pt-4 dark:border-gray-700">
              <h3 className="mb-2 font-semibold">Drug Interactions</h3>
              {!selected.interactions || selected.interactions.length === 0 ? (
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  No known interactions recorded.
                </p>
              ) : (
                <div className="space-y-2">
                  {selected.interactions.map((i) => (
                    <div
                      key={i.id}
                      className={`rounded-lg border-l-4 bg-gray-50 p-3 dark:bg-gray-700/40 ${
                        i.severity === "MAJOR"
                          ? "border-red-500"
                          : i.severity === "MODERATE"
                            ? "border-yellow-500"
                            : "border-blue-400"
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-medium">
                          {i.interactsWith?.name}
                        </span>
                        <span className="text-xs font-semibold">
                          {i.severity}
                        </span>
                      </div>
                      <p className="mt-1 text-xs text-gray-600 dark:text-gray-300">
                        {i.description}
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Add Medicine Modal */}
      {showAdd && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <form
            onSubmit={createMedicine}
            noValidate
            className="w-full max-h-[90vh] overflow-y-auto max-w-lg rounded-2xl bg-white p-6 text-gray-900 shadow-xl dark:bg-gray-800 dark:text-gray-100"
          >
            <h2 className="mb-4 text-lg font-semibold">
              {editing ? `Edit ${editing.name}` : "Add Medicine"}
            </h2>
            <div className="space-y-3">
              <div>
                <label htmlFor="add-medicine-name" className="mb-1 block text-sm font-medium">Name</label>
                <input
                  id="add-medicine-name"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label htmlFor="add-medicine-generic-name" className="mb-1 block text-sm font-medium">
                    Generic Name
                  </label>
                  <input
                    id="add-medicine-generic-name"
                    value={form.genericName}
                    onChange={(e) =>
                      setForm({ ...form, genericName: e.target.value })
                    }
                    className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
                  />
                </div>
                <div>
                  <label htmlFor="add-medicine-category" className="mb-1 block text-sm font-medium">
                    Category
                  </label>
                  <select
                    id="add-medicine-category"
                    value={form.category}
                    onChange={(e) =>
                      setForm({ ...form, category: e.target.value })
                    }
                    className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
                  >
                    {CATEGORIES.map((c) => (
                      <option key={c} value={c}>
                        {c || "—"}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label htmlFor="add-medicine-form" className="mb-1 block text-sm font-medium">Form</label>
                  <input
                    id="add-medicine-form"
                    placeholder="Tablet, Syrup..."
                    value={form.form}
                    onChange={(e) => setForm({ ...form, form: e.target.value })}
                    className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 placeholder-gray-400 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 dark:placeholder-gray-500"
                  />
                </div>
                <div>
                  <label htmlFor="add-medicine-strength" className="mb-1 block text-sm font-medium">
                    Strength
                  </label>
                  <input
                    id="add-medicine-strength"
                    placeholder="500mg"
                    value={form.strength}
                    onChange={(e) =>
                      setForm({ ...form, strength: e.target.value })
                    }
                    className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 placeholder-gray-400 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 dark:placeholder-gray-500"
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label htmlFor="add-medicine-manufacturer" className="mb-1 block text-sm font-medium">
                    Manufacturer <span className="text-red-500">*</span>
                  </label>
                  <input
                    id="add-medicine-manufacturer"
                    value={form.manufacturer}
                    onChange={(e) =>
                      setForm({ ...form, manufacturer: e.target.value })
                    }
                    className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
                  />
                </div>
                <div>
                  <label htmlFor="add-medicine-mrp" className="mb-1 block text-sm font-medium">
                    MRP (₹)
                  </label>
                  <input
                    id="add-medicine-mrp"
                    type="number"
                    step="0.01"
                    min="0"
                    inputMode="decimal"
                    placeholder="e.g. 25.50"
                    value={form.mrp}
                    onChange={(e) => setForm({ ...form, mrp: e.target.value })}
                    className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 placeholder-gray-400 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 dark:placeholder-gray-500"
                  />
                </div>
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={form.rxRequired}
                  onChange={(e) =>
                    setForm({ ...form, rxRequired: e.target.checked })
                  }
                />
                Prescription required (Rx)
              </label>
            </div>

            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setShowAdd(false);
                  setEditing(null);
                }}
                className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
              >
                Cancel
              </button>
              <button
                type="submit"
                data-testid="medicine-save"
                className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark"
              >
                {editing ? "Save changes" : "Create"}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}

function Info({
  label,
  value,
  fullWidth = false,
}: {
  label: string;
  value: string;
  fullWidth?: boolean;
}) {
  return (
    <div className={fullWidth ? "col-span-2" : ""}>
      <dt className="text-xs text-gray-500 dark:text-gray-400">{label}</dt>
      <dd className="mt-0.5 text-gray-900 dark:text-gray-100">{value}</dd>
    </div>
  );
}
