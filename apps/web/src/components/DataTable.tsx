"use client";

import React, { useMemo, useState, useEffect, useCallback } from "react";
import {
  ArrowUp,
  ArrowDown,
  ArrowUpDown,
  Filter as FilterIcon,
  Download,
  Settings as SettingsIcon,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { SkeletonRow } from "./Skeleton";
import { EmptyState } from "./EmptyState";

/* ------------------------------------------------------------------ */
/*  Types                                                             */
/* ------------------------------------------------------------------ */

export interface Column<T> {
  key: keyof T | string;
  label: string;
  sortable?: boolean;
  filterable?: boolean;
  render?: (row: T) => React.ReactNode;
  className?: string;
  hideMobile?: boolean;
}

export interface BulkAction<T> {
  label: string;
  onAction: (selected: T[]) => void;
}

export interface DataTableProps<T> {
  data: T[];
  columns: Column<T>[];
  keyField: keyof T;
  loading?: boolean;
  empty?: {
    icon?: React.ReactNode;
    title: string;
    description?: string;
    action?: { label: string; onClick: () => void };
  };
  bulkActions?: BulkAction<T>[];
  onRowClick?: (row: T) => void;
  defaultSort?: { key: string; dir: "asc" | "desc" };
  pageSize?: number;
  /** Persist sort/filter state in URL query */
  urlState?: boolean;
  /** CSV filename (without extension) */
  csvName?: string;
  /** Optional heading/toolbar extra content */
  toolbarExtras?: React.ReactNode;
  className?: string;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

function getValue<T>(row: T, key: keyof T | string): unknown {
  if (typeof key === "string" && key.includes(".")) {
    return key.split(".").reduce<unknown>(
      (acc, k) => (acc == null ? acc : (acc as Record<string, unknown>)[k]),
      row as unknown
    );
  }
  return (row as Record<string, unknown>)[key as string];
}

function toCsv<T>(rows: T[], columns: Column<T>[]): string {
  const header = columns.map((c) => `"${c.label.replace(/"/g, '""')}"`).join(",");
  const body = rows
    .map((r) =>
      columns
        .map((c) => {
          const v = getValue(r, c.key);
          const s =
            v == null
              ? ""
              : typeof v === "object"
                ? JSON.stringify(v)
                : String(v);
          return `"${s.replace(/"/g, '""')}"`;
        })
        .join(",")
    )
    .join("\n");
  return `${header}\n${body}`;
}

function downloadCsv(name: string, csv: string) {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${name}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/* ------------------------------------------------------------------ */
/*  Component                                                         */
/* ------------------------------------------------------------------ */

export function DataTable<T>({
  data,
  columns,
  keyField,
  loading,
  empty,
  bulkActions,
  onRowClick,
  defaultSort,
  pageSize: initialPageSize = 25,
  urlState = false,
  csvName = "export",
  toolbarExtras,
  className,
}: DataTableProps<T>) {
  /* ---------- state ---------- */
  const [sort, setSort] = useState<{ key: string; dir: "asc" | "desc" } | null>(
    defaultSort ?? null
  );
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [showFilters, setShowFilters] = useState(false);
  const [selected, setSelected] = useState<Set<unknown>>(new Set());
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(initialPageSize);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [showColMenu, setShowColMenu] = useState(false);

  /* ---------- URL state (read once) ---------- */
  useEffect(() => {
    if (!urlState || typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const s = params.get("sort");
    const d = params.get("dir");
    if (s) setSort({ key: s, dir: d === "desc" ? "desc" : "asc" });
    const f: Record<string, string> = {};
    params.forEach((v, k) => {
      if (k.startsWith("filter_")) f[k.slice(7)] = v;
    });
    if (Object.keys(f).length) {
      setFilters(f);
      setShowFilters(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---------- URL state (write) ---------- */
  useEffect(() => {
    if (!urlState || typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    // clear existing
    Array.from(params.keys()).forEach((k) => {
      if (k === "sort" || k === "dir" || k.startsWith("filter_")) params.delete(k);
    });
    if (sort) {
      params.set("sort", sort.key);
      params.set("dir", sort.dir);
    }
    Object.entries(filters).forEach(([k, v]) => {
      if (v) params.set(`filter_${k}`, v);
    });
    const qs = params.toString();
    const url = window.location.pathname + (qs ? `?${qs}` : "");
    window.history.replaceState(null, "", url);
  }, [sort, filters, urlState]);

  /* ---------- derived data ---------- */
  const filtered = useMemo(() => {
    let rows = data;
    const active = Object.entries(filters).filter(([, v]) => v);
    if (active.length) {
      rows = rows.filter((r) =>
        active.every(([k, v]) => {
          const val = getValue(r, k);
          return val != null && String(val).toLowerCase().includes(v.toLowerCase());
        })
      );
    }
    if (sort) {
      const dir = sort.dir === "asc" ? 1 : -1;
      rows = [...rows].sort((a, b) => {
        const av = getValue(a, sort.key);
        const bv = getValue(b, sort.key);
        if (av == null && bv == null) return 0;
        if (av == null) return -1 * dir;
        if (bv == null) return 1 * dir;
        if (typeof av === "number" && typeof bv === "number")
          return (av - bv) * dir;
        return String(av).localeCompare(String(bv)) * dir;
      });
    }
    return rows;
  }, [data, filters, sort]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const paged = useMemo(
    () =>
      filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize),
    [filtered, currentPage, pageSize]
  );

  const visibleColumns = columns.filter((c) => !hidden.has(String(c.key)));

  /* ---------- selection helpers ---------- */
  const pageKeys = paged.map((r) => r[keyField]);
  const allOnPageSelected =
    paged.length > 0 && pageKeys.every((k) => selected.has(k));

  const toggleRow = useCallback((key: unknown) => {
    setSelected((s) => {
      const ns = new Set(s);
      if (ns.has(key)) ns.delete(key);
      else ns.add(key);
      return ns;
    });
  }, []);

  const toggleAllOnPage = useCallback(() => {
    setSelected((s) => {
      const ns = new Set(s);
      if (allOnPageSelected) {
        pageKeys.forEach((k) => ns.delete(k));
      } else {
        pageKeys.forEach((k) => ns.add(k));
      }
      return ns;
    });
  }, [allOnPageSelected, pageKeys]);

  const selectedRows = useMemo(
    () => data.filter((r) => selected.has(r[keyField])),
    [data, selected, keyField]
  );

  /* ---------- handlers ---------- */
  function onSortClick(col: Column<T>) {
    if (!col.sortable) return;
    const k = String(col.key);
    setSort((s) => {
      if (!s || s.key !== k) return { key: k, dir: "asc" };
      if (s.dir === "asc") return { key: k, dir: "desc" };
      return null;
    });
  }

  function onExport() {
    downloadCsv(csvName, toCsv(filtered, visibleColumns));
  }

  function toggleColVisibility(key: string) {
    setHidden((h) => {
      const ns = new Set(h);
      if (ns.has(key)) ns.delete(key);
      else ns.add(key);
      return ns;
    });
  }

  /* ---------- render ---------- */
  const colSpan = visibleColumns.length + (bulkActions ? 1 : 0);

  return (
    <div
      className={
        "rounded-xl border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-800 " +
        (className ?? "")
      }
    >
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 border-b border-gray-200 p-3 dark:border-gray-700">
        {toolbarExtras}
        <div className="ml-auto flex items-center gap-2">
          {columns.some((c) => c.filterable) && (
            <button
              type="button"
              onClick={() => setShowFilters((v) => !v)}
              aria-label="Toggle filters"
              title="Toggle filters"
              className="flex min-h-[40px] min-w-[40px] items-center justify-center rounded-lg border border-gray-200 p-2 text-gray-600 transition hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-700"
            >
              <FilterIcon size={16} />
            </button>
          )}
          <button
            type="button"
            onClick={onExport}
            aria-label="Export CSV"
            title="Export CSV"
            className="flex min-h-[40px] items-center gap-1 rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-600 transition hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-700"
          >
            <Download size={16} /> <span className="hidden sm:inline">Export</span>
          </button>
          <div className="relative">
            <button
              type="button"
              onClick={() => setShowColMenu((v) => !v)}
              aria-label="Column visibility"
              title="Columns"
              className="flex min-h-[40px] min-w-[40px] items-center justify-center rounded-lg border border-gray-200 p-2 text-gray-600 transition hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-700"
            >
              <SettingsIcon size={16} />
            </button>
            {showColMenu && (
              <div className="absolute right-0 z-20 mt-1 w-56 rounded-lg border border-gray-200 bg-white p-2 shadow-lg dark:border-gray-700 dark:bg-gray-800">
                {columns.map((c) => {
                  const k = String(c.key);
                  return (
                    <label
                      key={k}
                      className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm text-gray-700 hover:bg-gray-50 dark:text-gray-200 dark:hover:bg-gray-700"
                    >
                      <input
                        type="checkbox"
                        checked={!hidden.has(k)}
                        onChange={() => toggleColVisibility(k)}
                      />
                      {c.label}
                    </label>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Bulk action bar */}
      {bulkActions && selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 border-b border-gray-200 bg-primary/5 px-3 py-2 dark:border-gray-700 dark:bg-primary/10">
          <span className="text-sm font-medium text-gray-700 dark:text-gray-200">
            {selected.size} selected
          </span>
          <div className="ml-auto flex flex-wrap gap-2">
            {bulkActions.map((a) => (
              <button
                key={a.label}
                type="button"
                onClick={() => {
                  a.onAction(selectedRows);
                  setSelected(new Set());
                }}
                className="min-h-[36px] rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-white hover:bg-primary-dark"
              >
                {a.label}
              </button>
            ))}
            <button
              type="button"
              onClick={() => setSelected(new Set())}
              className="min-h-[36px] rounded-lg border border-gray-200 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-700"
            >
              Clear
            </button>
          </div>
        </div>
      )}

      {/* Desktop table */}
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full">
          <thead>
            <tr className="border-b border-gray-200 bg-gray-50 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:border-gray-700 dark:bg-gray-900/40 dark:text-gray-400">
              {bulkActions && (
                <th className="w-10 px-3 py-3">
                  <input
                    type="checkbox"
                    aria-label="Select all on page"
                    checked={allOnPageSelected}
                    onChange={toggleAllOnPage}
                  />
                </th>
              )}
              {visibleColumns.map((col) => {
                const k = String(col.key);
                const isSorted = sort?.key === k;
                return (
                  <th
                    key={k}
                    className={`px-4 py-3 ${col.className ?? ""}`}
                    scope="col"
                  >
                    <div className="flex items-center gap-1">
                      {col.sortable ? (
                        <button
                          type="button"
                          onClick={() => onSortClick(col)}
                          className="flex items-center gap-1 hover:text-gray-700 dark:hover:text-gray-200"
                        >
                          {col.label}
                          {isSorted ? (
                            sort.dir === "asc" ? (
                              <ArrowUp size={12} />
                            ) : (
                              <ArrowDown size={12} />
                            )
                          ) : (
                            <ArrowUpDown size={12} className="opacity-40" />
                          )}
                        </button>
                      ) : (
                        col.label
                      )}
                    </div>
                  </th>
                );
              })}
            </tr>
            {showFilters && (
              <tr className="border-b border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800">
                {bulkActions && <th />}
                {visibleColumns.map((col) => {
                  const k = String(col.key);
                  return (
                    <th key={k} className="px-4 py-2">
                      {col.filterable ? (
                        <input
                          type="text"
                          value={filters[k] ?? ""}
                          onChange={(e) =>
                            setFilters((f) => ({ ...f, [k]: e.target.value }))
                          }
                          placeholder={`Filter ${col.label}`}
                          className="w-full rounded border border-gray-200 bg-white px-2 py-1 text-xs text-gray-900 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
                        />
                      ) : null}
                    </th>
                  );
                })}
              </tr>
            )}
          </thead>
          <tbody>
            {loading ? (
              Array.from({ length: 5 }).map((_, i) => (
                <SkeletonRow key={i} columns={colSpan || 1} />
              ))
            ) : paged.length === 0 ? (
              <tr>
                <td colSpan={colSpan || 1} className="p-0">
                  <EmptyState
                    icon={empty?.icon}
                    title={empty?.title ?? "No data"}
                    description={empty?.description}
                    action={empty?.action}
                    className="rounded-none border-0"
                  />
                </td>
              </tr>
            ) : (
              paged.map((row) => {
                const key = row[keyField] as unknown as React.Key;
                const isSelected = selected.has(row[keyField]);
                return (
                  <tr
                    key={key}
                    onClick={() => onRowClick?.(row)}
                    className={`border-b border-gray-100 text-sm dark:border-gray-700 ${
                      onRowClick ? "cursor-pointer" : ""
                    } ${
                      isSelected
                        ? "bg-primary/5 dark:bg-primary/10"
                        : "hover:bg-gray-50 dark:hover:bg-gray-700"
                    }`}
                  >
                    {bulkActions && (
                      <td
                        className="w-10 px-3 py-3"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <input
                          type="checkbox"
                          aria-label="Select row"
                          checked={isSelected}
                          onChange={() => toggleRow(row[keyField])}
                        />
                      </td>
                    )}
                    {visibleColumns.map((col) => (
                      <td
                        key={String(col.key)}
                        className={`px-4 py-3 text-gray-900 dark:text-gray-100 ${col.className ?? ""}`}
                      >
                        {col.render
                          ? col.render(row)
                          : (getValue(row, col.key) as React.ReactNode) ?? "—"}
                      </td>
                    ))}
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Mobile cards */}
      <div className="space-y-2 p-3 md:hidden">
        {loading ? (
          Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="h-24 animate-pulse rounded-lg bg-gray-100 dark:bg-gray-700"
            />
          ))
        ) : paged.length === 0 ? (
          <EmptyState
            icon={empty?.icon}
            title={empty?.title ?? "No data"}
            description={empty?.description}
          />
        ) : (
          paged.map((row) => {
            const key = row[keyField] as unknown as React.Key;
            const isSelected = selected.has(row[keyField]);
            const mobileCols = visibleColumns.filter((c) => !c.hideMobile);
            return (
              <div
                key={key}
                onClick={() => onRowClick?.(row)}
                className={`rounded-lg border p-3 ${
                  isSelected
                    ? "border-primary bg-primary/5 dark:bg-primary/10"
                    : "border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800"
                }`}
              >
                {bulkActions && (
                  <div className="mb-2 flex justify-end">
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onClick={(e) => e.stopPropagation()}
                      onChange={() => toggleRow(row[keyField])}
                      aria-label="Select row"
                    />
                  </div>
                )}
                <dl className="space-y-1.5">
                  {mobileCols.map((col) => (
                    <div
                      key={String(col.key)}
                      className="flex items-start justify-between gap-3 text-sm"
                    >
                      <dt className="text-xs font-medium uppercase text-gray-500 dark:text-gray-400">
                        {col.label}
                      </dt>
                      <dd className="text-right text-gray-900 dark:text-gray-100">
                        {col.render
                          ? col.render(row)
                          : (getValue(row, col.key) as React.ReactNode) ?? "—"}
                      </dd>
                    </div>
                  ))}
                </dl>
              </div>
            );
          })
        )}
      </div>

      {/* Pagination */}
      {!loading && filtered.length > 0 && (
        <div className="flex flex-wrap items-center gap-3 border-t border-gray-200 px-3 py-2 text-sm text-gray-600 dark:border-gray-700 dark:text-gray-300">
          <div className="flex items-center gap-2">
            <span>Rows:</span>
            <select
              value={pageSize}
              onChange={(e) => {
                setPageSize(Number(e.target.value));
                setPage(1);
              }}
              className="min-h-[36px] rounded border border-gray-200 bg-white px-2 py-1 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
            >
              {[10, 25, 50, 100].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <span>
              {(currentPage - 1) * pageSize + 1}-
              {Math.min(currentPage * pageSize, filtered.length)} of{" "}
              {filtered.length}
            </span>
            <button
              type="button"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={currentPage <= 1}
              aria-label="Previous page"
              className="flex min-h-[36px] min-w-[36px] items-center justify-center rounded border border-gray-200 p-1 disabled:opacity-40 dark:border-gray-700"
            >
              <ChevronLeft size={16} />
            </button>
            <button
              type="button"
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={currentPage >= totalPages}
              aria-label="Next page"
              className="flex min-h-[36px] min-w-[36px] items-center justify-center rounded border border-gray-200 p-1 disabled:opacity-40 dark:border-gray-700"
            >
              <ChevronRight size={16} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default DataTable;
