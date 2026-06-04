"use client";

/**
 * Tenant feature-flag overrides — Pearl ERP Stage 1 §8.1 (in-band).
 *
 * Per-tenant toggles for Stage 2+ surfaces and granular AI features.
 * Persists the whole flag map via PUT /super-admin/tenants/:id/feature-flags.
 *
 * Visibility: ADMIN role; the API enforces the real super-admin gate.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import {
  ArrowLeft,
  Save,
  RefreshCw,
  RotateCcw,
  CheckCircle2,
  AlertCircle,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import { useAuthStore } from "@/lib/store";
import { Skeleton, SkeletonText, SkeletonTable } from "@/components/Skeleton";

// Server-driven feature catalog row. The shape mirrors the response from
// GET /api/v1/super-admin/tenants/:id/feature-flags — that endpoint
// merges the canonical FEATURE_KEYS + FEATURE_METADATA from
// `@medcore/shared` with the tenant's stored overrides AND any
// "unknown" keys persisted in the DB. We deliberately do NOT hardcode
// the list here so we never drift when new keys are added to the
// shared package.
interface FeatureRow {
  key: string;
  label: string;
  description: string;
  defaultEnabled: boolean;
  override: boolean | null;
  effective: boolean;
  known: boolean;
}

interface TenantSummary {
  id: string;
  name: string;
  subdomain: string;
  featureFlags: Record<string, boolean> | null;
}

export default function TenantConfigPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { user } = useAuthStore();
  const tenantId = params?.id ?? "";

  const [tenant, setTenant] = useState<TenantSummary | null>(null);
  const [features, setFeatures] = useState<FeatureRow[]>([]);
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  // Standing requirement — every list/table view paginates
  // (Rows selector + Page X of Y). Pearl-branded tenants may have far
  // more flags in future stages; keep the page footprint bounded now.
  const [page, setPage] = useState(1);
  const [rowsPerPage, setRowsPerPage] = useState(10);
  const [search, setSearch] = useState("");

  // Use primitive `userRole` for effect deps — `useAuthStore()` returns
  // a fresh state-object reference on every render; depending on `user`
  // directly would re-fire the effect each render and hammer the API.
  const userRole = user?.role;

  useEffect(() => {
    if (userRole && userRole !== "ADMIN") router.replace("/dashboard");
  }, [userRole, router]);

  const load = useCallback(async () => {
    if (!tenantId) return;
    setLoading(true);
    try {
      // Fetch tenant identity AND the server-driven feature catalog in
      // parallel. The catalog endpoint returns the canonical list from
      // packages/shared (FEATURE_KEYS + FEATURE_METADATA) merged with
      // the tenant's stored overrides + any unknown keys persisted in
      // the DB, so the UI shows EVERY flag that exists for this tenant.
      const [tRes, fRes] = await Promise.all([
        api.get<{ data: TenantSummary }>(`/tenants/${tenantId}`),
        api.get<{ data: { features: FeatureRow[] } }>(
          `/super-admin/tenants/${tenantId}/feature-flags`,
        ),
      ]);
      setTenant(tRes.data);
      setFeatures(fRes.data.features ?? []);
      // Seed local override state from the server-provided rows so the
      // initial render reflects exactly what's in the DB.
      const seeded: Record<string, boolean> = {};
      for (const f of fRes.data.features ?? []) {
        if (typeof f.override === "boolean") seeded[f.key] = f.override;
      }
      setOverrides(seeded);
      setDirty(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    } finally {
      setLoading(false);
    }
  }, [tenantId]);

  useEffect(() => {
    if (userRole === "ADMIN") void load();
  }, [load, userRole]);

  function setFlag(key: string, value: boolean | null) {
    setDirty(true);
    setOverrides((prev) => {
      const next = { ...prev };
      if (value === null) delete next[key];
      else next[key] = value;
      return next;
    });
  }

  async function save() {
    if (!tenant) return;
    setSaving(true);
    setSavedAt(null);
    try {
      await api.put(`/super-admin/tenants/${tenant.id}/feature-flags`, {
        flags: overrides,
      });
      setSavedAt(new Date().toISOString());
      setDirty(false);
      toast.success("Feature flags saved");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    } finally {
      setSaving(false);
    }
  }

  function resetToDefaults() {
    setOverrides({});
    setDirty(true);
  }

  // Filter + paginate. Filtering by search term against label / key /
  // description so the operator can find one flag among many. The
  // source is `features` (fetched from the server), NOT a hardcoded
  // list, so newly-added FEATURE_KEYS or DB-only keys always appear.
  const filteredFeatures = features.filter((f) => {
    if (!search.trim()) return true;
    const q = search.trim().toLowerCase();
    return (
      f.label.toLowerCase().includes(q) ||
      f.key.toLowerCase().includes(q) ||
      f.description.toLowerCase().includes(q)
    );
  });
  const totalRows = filteredFeatures.length;
  const totalPages = Math.max(1, Math.ceil(totalRows / rowsPerPage));
  const safePage = Math.min(page, totalPages);
  const start = (safePage - 1) * rowsPerPage;
  const visibleFeatures = filteredFeatures.slice(start, start + rowsPerPage);

  if (user && user.role !== "ADMIN") return null;

  if (loading && !tenant) {
    return (
      <div data-testid="tenant-config-loading" className="space-y-6">
        <Skeleton variant="text" width="8rem" />
        <header className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex-1 space-y-2">
            <Skeleton variant="text" width="50%" height={28} />
            <SkeletonText lines={2} />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Skeleton variant="rect" width={96} height={44} className="rounded-md" />
            <Skeleton variant="rect" width={120} height={44} className="rounded-md" />
            <Skeleton variant="rect" width={120} height={44} className="rounded-md" />
          </div>
        </header>
        <Skeleton variant="rect" width="100%" height={40} className="rounded-lg" />
        <div className="overflow-x-auto rounded-xl bg-white p-4 shadow-sm dark:bg-gray-800">
          <SkeletonTable rows={6} columns={5} />
        </div>
      </div>
    );
  }

  if (!tenant) {
    return (
      <div className="space-y-4">
        <Link
          href="/dashboard/tenants"
          className="inline-flex items-center gap-1 text-sm text-gray-600 hover:text-gray-900 dark:text-gray-300 dark:hover:text-gray-100"
        >
          <ArrowLeft size={14} aria-hidden="true" /> Back to tenants
        </Link>
        <div className="rounded-md border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300">
          Tenant not found.
        </div>
      </div>
    );
  }

  return (
    <div data-testid="tenant-config-page" className="space-y-6">
      <div className="flex items-center gap-2">
        <Link
          href={`/dashboard/tenants/${tenant.id}`}
          className="inline-flex items-center gap-1 text-sm text-gray-600 hover:text-gray-900 dark:text-gray-300 dark:hover:text-gray-100"
        >
          <ArrowLeft size={14} aria-hidden="true" /> Tenant detail
        </Link>
      </div>

      <header className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Feature flags — {tenant.name}
          </h1>
          <p className="text-sm text-gray-600 dark:text-gray-400">
            Per-tenant overrides for Stage 2+ surfaces. Pearl-branded
            tenants typically disable IPD / OT / telemedicine /
            aiDischarge during the OPD-only Stage 1.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            data-testid="tenant-config-refresh"
            onClick={() => void load()}
            disabled={loading}
            className="inline-flex h-11 items-center gap-1 rounded-md border border-gray-300 bg-white px-3 text-xs font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
          >
            <RefreshCw
              size={14}
              className={loading ? "animate-spin" : ""}
              aria-hidden="true"
            />
            Refresh
          </button>
          <button
            type="button"
            data-testid="tenant-config-reset"
            onClick={resetToDefaults}
            disabled={saving}
            className="inline-flex h-11 items-center gap-1 rounded-md border border-gray-300 bg-white px-3 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
          >
            <RotateCcw size={14} aria-hidden="true" />
            Clear overrides
          </button>
          <button
            type="button"
            data-testid="tenant-config-save"
            onClick={() => void save()}
            disabled={saving || !dirty}
            className="inline-flex h-11 items-center gap-1 rounded-md bg-emerald-700 px-3 text-xs font-medium text-white hover:bg-emerald-800 disabled:opacity-50"
          >
            <Save size={14} aria-hidden="true" />
            {saving ? "Saving…" : "Save changes"}
          </button>
        </div>
      </header>

      {savedAt && (
        <div
          data-testid="tenant-config-saved"
          role="status"
          className="flex items-start gap-2 rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300"
        >
          <CheckCircle2 size={16} aria-hidden="true" />
          <span>Feature flags saved.</span>
        </div>
      )}

      {dirty && (
        <div
          data-testid="tenant-config-dirty-banner"
          role="status"
          className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-4 py-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200"
        >
          <AlertCircle size={14} aria-hidden="true" />
          You have unsaved changes — click <strong>Save changes</strong> to
          persist.
        </div>
      )}

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <input
          data-testid="tenant-config-search"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
          placeholder="Search features by name, key, or description…"
          className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 sm:max-w-md dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100 dark:placeholder:text-gray-500"
        />
        <span className="text-xs text-gray-600 dark:text-gray-400" data-testid="tenant-config-total">
          {totalRows} feature{totalRows === 1 ? "" : "s"}
        </span>
      </div>

      <div className="overflow-x-auto rounded-xl bg-white text-gray-900 shadow-sm dark:bg-gray-800 dark:text-gray-100">
        <table
          data-testid="tenant-config-table"
          className="w-full min-w-[720px] divide-y divide-gray-200 text-sm dark:divide-gray-700"
        >
          <thead className="bg-gray-50 text-left text-xs font-semibold uppercase text-gray-600 dark:bg-gray-900/50 dark:text-gray-400">
            <tr>
              <th className="px-3 py-2">Feature</th>
              <th className="px-3 py-2">Description</th>
              <th className="px-3 py-2">Default</th>
              <th className="px-3 py-2">Override</th>
              <th className="px-3 py-2">Effective</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
            {visibleFeatures.length === 0 && (
              <tr data-testid="tenant-config-empty">
                <td
                  colSpan={5}
                  className="px-3 py-6 text-center text-sm text-gray-500 dark:text-gray-400"
                >
                  No features match the current filter.
                </td>
              </tr>
            )}
            {visibleFeatures.map((f) => {
              const override = overrides[f.key];
              const hasOverride = typeof override === "boolean";
              const effective = hasOverride ? override : f.defaultEnabled;
              return (
                <tr
                  key={f.key}
                  data-testid={`tenant-config-row-${f.key}`}
                  className="hover:bg-gray-50 dark:hover:bg-gray-700/50"
                >
                  <td className="px-3 py-2 font-medium text-gray-900 dark:text-gray-100">
                    <div className="flex items-center gap-2">
                      <span>{f.label}</span>
                      {!f.known && (
                        <span
                          data-testid={`tenant-config-unknown-${f.key}`}
                          className="rounded bg-amber-100 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-amber-800 dark:bg-amber-900/50 dark:text-amber-300"
                          title="Custom or legacy key — not in the canonical catalog"
                        >
                          Custom
                        </span>
                      )}
                    </div>
                    <div className="font-mono text-[10px] text-gray-400 dark:text-gray-500">
                      {f.key}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-xs text-gray-600 dark:text-gray-400">
                    {f.description}
                  </td>
                  <td className="px-3 py-2 text-xs">
                    <span
                      className={`rounded-full px-2 py-0.5 font-medium ${
                        f.defaultEnabled
                          ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-300"
                          : "bg-gray-200 text-gray-700 dark:bg-gray-700 dark:text-gray-300"
                      }`}
                    >
                      {f.defaultEnabled ? "ON" : "OFF"}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    <select
                      data-testid={`tenant-config-select-${f.key}`}
                      value={
                        hasOverride
                          ? override
                            ? "true"
                            : "false"
                          : "default"
                      }
                      onChange={(e) => {
                        const v = e.target.value;
                        if (v === "default") setFlag(f.key, null);
                        else setFlag(f.key, v === "true");
                      }}
                      className="rounded-md border border-gray-300 bg-white px-2 py-1 text-xs text-gray-900 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
                    >
                      <option value="default">Use default</option>
                      <option value="true">Force enabled</option>
                      <option value="false">Force disabled</option>
                    </select>
                  </td>
                  <td className="px-3 py-2 text-xs">
                    <span
                      data-testid={`tenant-config-effective-${f.key}`}
                      className={`rounded-full px-2 py-0.5 font-semibold ${
                        effective
                          ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-300"
                          : "bg-rose-100 text-rose-800 dark:bg-rose-900/50 dark:text-rose-300"
                      }`}
                    >
                      {effective ? "Enabled" : "Disabled"}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Compact pagination — "Rows: [N]   1-N of Total   < >" */}
      <div
        data-testid="tenant-config-pagination"
        className="flex items-center justify-between gap-3 rounded-xl bg-white px-4 py-2 text-sm shadow-sm dark:bg-gray-800"
      >
        <div className="flex items-center gap-2 text-gray-700 dark:text-gray-300">
          <span>Rows:</span>
          <select
            data-testid="tenant-config-rows-per-page"
            value={rowsPerPage}
            onChange={(e) => {
              setRowsPerPage(Number(e.target.value));
              setPage(1);
            }}
            className="rounded-md border border-gray-300 bg-white px-2 py-1 text-sm focus:border-gray-500 focus:outline-none dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
          >
            {[10, 25, 50, 100].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-2 text-gray-700 dark:text-gray-300">
          <span data-testid="tenant-config-page-indicator">
            {totalRows === 0 ? 0 : start + 1}-
            {Math.min(start + rowsPerPage, totalRows)} of {totalRows}
          </span>
          <button
            type="button"
            data-testid="tenant-config-page-prev"
            disabled={safePage <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            aria-label="Previous page"
            className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-gray-300 bg-white text-gray-600 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-gray-700"
          >
            <ChevronLeft size={16} aria-hidden="true" />
          </button>
          <button
            type="button"
            data-testid="tenant-config-page-next"
            disabled={safePage >= totalPages}
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            aria-label="Next page"
            className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-gray-300 bg-white text-gray-600 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-gray-700"
          >
            <ChevronRight size={16} aria-hidden="true" />
          </button>
        </div>
      </div>
    </div>
  );
}
