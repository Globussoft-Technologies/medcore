"use client";

/**
 * Tenants admin page — operator console for creating / listing / managing
 * multi-tenant hospital installations.
 *
 * Visibility:
 *   - ADMIN role AND currently authenticated against the seeded "default"
 *     tenant (or globally tenant-less legacy accounts). The API enforces the
 *     real guard; this page only renders for ADMINs and calls the guarded
 *     endpoints which return 403 to regular tenant admins.
 *
 * UX:
 *   - List view with search + filter (plan, active/all)
 *   - "Create Tenant" modal with full form validation
 *   - Detail drawer: tenant info, usage stats, admin-user list, deactivate button
 *   - DialogProvider / useConfirm for destructive actions
 *   - data-testid hooks on every actionable element for Playwright E2E
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Plus,
  Search,
  Info,
  Power,
  X,
  PowerOff,
  SlidersHorizontal,
  ExternalLink,
  Eye,
  EyeOff,
  Loader2,
  Building2,
  UserCog,
  Sparkles,
  Phone as PhoneIcon,
  Lock,
} from "lucide-react";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import { useConfirm } from "@/lib/use-dialog";
import { useAuthStore } from "@/lib/store";
import { useTranslation } from "@/lib/i18n";
import { Skeleton } from "@/components/Skeleton";

type Plan = "BASIC" | "PRO" | "ENTERPRISE";

interface TenantStats {
  userCount: number;
  patientCount: number;
  invoicesLast30Days: number;
  storageBytes: number;
  // Pearl §8.1 row 204 — extended metrics (SoW columns).
  monthlyOpdVolume?: number;
  mrrInPaise?: number;
  billingHealth?:
    | "healthy"
    | "trial"
    | "past_due"
    | "suspended"
    | "unknown";
  subscriptionStatus?: string | null;
  lastLoginAt?: string | null;
}

interface Tenant {
  id: string;
  name: string;
  subdomain: string;
  // Pearl SoW §8.1 — short human-readable tenant code (e.g. "AHMD-01").
  // Distinct from subdomain (URL routing). Persisted in SystemConfig
  // under `tenant:<id>:code`; the list endpoint joins it into the row.
  code?: string | null;
  region?: string | null;
  plan: Plan;
  active: boolean;
  createdAt: string;
  updatedAt: string;
  // Pearl §8.1 row 233 — suspended-to-archived lifecycle. `deactivatedAt`
  // stamped on suspend; `archivedAt` stamped by the 90-day cron sweep.
  deactivatedAt?: string | null;
  archivedAt?: string | null;
  stats?: TenantStats;
  // Pearl §8.2 row 212 — per-tenant idle session timeout (minutes).
  // PATCH /api/v1/tenants/:id accepts integers in [5, 1440].
  sessionIdleMinutes?: number;
}

interface TenantAdmin {
  id: string;
  email: string;
  name: string;
  isActive: boolean;
  createdAt: string;
}

interface TenantDetail extends Tenant {
  admins: TenantAdmin[];
  config: Record<string, string>;
}

/**
 * Pearl §8.1 row 204 — per-tenant KPI rollup shape sourced from
 * `GET /api/v1/super-admin/metrics`. Capped server-side at the top-20
 * tenants by userCount, so any tenant beyond that bucket renders `—`
 * with a tooltip rather than blocking the page.
 */
interface PerTenantMetricsRow {
  tenantId: string;
  userCount: number;
  patientCount: number;
  appointmentsLast7d: number;
  invoicesLast30d: number;
}

type MetricsState =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "loaded"; byTenantId: Map<string, PerTenantMetricsRow> }
  | { phase: "failed" };

// Subdomain validation lived here while the operator chose the slug
// manually. The Create-Tenant flow now auto-derives the subdomain from
// the Hospital Name (CreateTenantModal.deriveSubdomain), so the
// validateSubdomain() / RESERVED list / SUB_RE regex were dropped along
// with the input. Reserved-slug collisions surface as a 409 from the
// backend and are shown as a name-conflict toast.

function formatBytes(n: number): string {
  if (!n) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

function formatINR(paise: number | null | undefined): string {
  if (paise == null || paise === 0) return "—";
  return `₹${(paise / 100).toLocaleString("en-IN", {
    maximumFractionDigits: 0,
  })}`;
}

function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "Never";
  try {
    const ms = Date.now() - new Date(iso).getTime();
    const min = Math.floor(ms / 60000);
    if (min < 1) return "Just now";
    if (min < 60) return `${min}m ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h ago`;
    const days = Math.floor(hr / 24);
    if (days < 30) return `${days}d ago`;
    return new Date(iso).toLocaleDateString("en-IN", {
      day: "2-digit",
      month: "short",
    });
  } catch {
    return "—";
  }
}

function billingBadge(
  h: TenantStats["billingHealth"] | undefined,
  active: boolean,
): { label: string; cls: string } {
  if (!active)
    return { label: "Susp.", cls: "bg-gray-200 text-gray-700" };
  switch (h) {
    case "healthy":
      return { label: "Healthy", cls: "bg-emerald-100 text-emerald-800" };
    case "trial":
      return { label: "Trial", cls: "bg-sky-100 text-sky-800" };
    case "past_due":
      return { label: "Past due", cls: "bg-amber-100 text-amber-800" };
    case "suspended":
      return { label: "Susp.", cls: "bg-rose-100 text-rose-800" };
    default:
      return { label: "—", cls: "bg-gray-100 text-gray-600" };
  }
}

export default function TenantsAdminPage() {
  const { user } = useAuthStore();
  const router = useRouter();
  const confirm = useConfirm();
  const { t } = useTranslation();

  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [planFilter, setPlanFilter] = useState<"" | Plan>("");
  // Default to "active" so the operator's first view is the working
  // hospital fleet; suspended / archived tenants are one click away
  // via the segmented filter above the table.
  const [activeFilter, setActiveFilter] = useState<"all" | "active" | "inactive">(
    "active",
  );

  const [createOpen, setCreateOpen] = useState(false);
  const [detailOpen, setDetailOpen] = useState<string | null>(null);
  const [detail, setDetail] = useState<TenantDetail | null>(null);

  // Pearl §8.1 row 204 — per-tenant KPI rollup (super-admin metrics).
  // Fetched once on mount in parallel with the tenants list; failure
  // degrades to dashes rather than blocking the list.
  const [metrics, setMetrics] = useState<MetricsState>({ phase: "idle" });

  // Infinite-scroll pagination — load 25 rows at a time, expand the
  // visible window when the operator scrolls near the bottom sentinel.
  // No "Page X of Y" footer; client-side slicing only (the API already
  // returns the full filtered list).
  const PAGE_SIZE = 25;
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  // Use primitive `userRole` for effect deps. `useAuthStore()` returns a
  // fresh state-object reference on every render, so depending on `user`
  // would re-fire the effect on every render and hammer /tenants in a
  // loop (manifested as a 429 cascade from the API rate limiter).
  const userRole = user?.role;

  useEffect(() => {
    if (userRole && userRole !== "ADMIN") {
      router.push("/dashboard");
    }
  }, [userRole, router]);

  // `t` from useTranslation() is a fresh function on every render — we
  // deliberately do NOT include it in the useCallback deps, otherwise
  // `load` itself would be a fresh function on every render and the
  // useEffect below would loop. The toast fallback strings are passed
  // as the second arg to `t`, so the user-facing message is still
  // translated if/when the dictionary updates next render.
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (search.trim()) params.set("search", search.trim());
      if (planFilter) params.set("plan", planFilter);
      if (activeFilter === "active") params.set("active", "true");
      if (activeFilter === "inactive") params.set("active", "false");
      const res = await api.get<{ data: Tenant[] }>(
        `/tenants${params.toString() ? `?${params.toString()}` : ""}`,
      );
      setTenants(res.data);
    } catch (err) {
      const e = err as { status?: number; message?: string };
      if (e.status === 403) {
        toast.error(
          "Only super-admins on the default tenant can manage tenants.",
        );
      } else {
        toast.error(e.message || "Failed to load tenants");
      }
      setTenants([]);
    }
    setLoading(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, planFilter, activeFilter]);

  useEffect(() => {
    if (userRole === "ADMIN") load();
  }, [load, userRole]);

  // Pearl §8.1 row 204 — load /super-admin/metrics once for the ADMIN
  // session and index `perTenant` by tenantId. The API returns 403 for
  // anything but a super-admin (tenant-less ADMIN OR ADMIN on the
  // seeded "default" tenant); on any error we degrade the KPI cells to
  // dashes rather than failing the whole page.
  //
  // Dep is `userRole` (primitive, declared above) not `user` — the auth
  // store returns a fresh user-object reference on every render, which
  // would cause this effect to re-fire and loop with setMetrics.
  useEffect(() => {
    if (userRole !== "ADMIN") return;
    let cancelled = false;
    setMetrics({ phase: "loading" });
    (async () => {
      try {
        const res = await api.get<{
          data: { perTenant: PerTenantMetricsRow[] };
        }>("/super-admin/metrics");
        if (cancelled) return;
        const byTenantId = new Map<string, PerTenantMetricsRow>();
        for (const row of res.data.perTenant ?? []) {
          byTenantId.set(row.tenantId, row);
        }
        setMetrics({ phase: "loaded", byTenantId });
      } catch {
        if (cancelled) return;
        setMetrics({ phase: "failed" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [userRole]);

  const loadDetail = useCallback(async (id: string) => {
    try {
      const res = await api.get<{ data: TenantDetail }>(`/tenants/${id}`);
      setDetail(res.data);
    } catch {
      setDetail(null);
    }
  }, []);

  useEffect(() => {
    if (detailOpen) loadDetail(detailOpen);
    else setDetail(null);
  }, [detailOpen, loadDetail]);

  // Pearl §8.1 row 206 — suspend flips Tenant.active=false. The audit row
  // (TENANT_SUSPENDED) lands server-side. Refresh tokens are wiped so users
  // are signed out at their next refresh cycle.
  async function deactivateTenant(id: string, name: string) {
    const ok = await confirm({
      title: t("tenants.deactivate.confirm", `Suspend tenant "${name}"?`),
      message: t(
        "tenants.deactivate.warning",
        "Users won't be able to sign in. All active sessions will be signed out at their next refresh. You can restore later.",
      ),
      confirmLabel: t("tenants.deactivate.button", "Suspend"),
      danger: true,
    });
    if (!ok) return;
    try {
      await api.post(`/tenants/${id}/deactivate`);
      toast.success(t("tenants.deactivate.ok", "Tenant suspended"));
      setDetailOpen(null);
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    }
  }

  // Pearl §8.2 row 212 — PATCH the per-tenant idle session timeout
  // (minutes). The drawer input owns the staging value; this just
  // does the wire call + toast + list refresh + detail refresh.
  // JWT TTL enforcement (auth.ts) is deferred to a separate piece —
  // this only persists the configured value.
  async function updateSessionIdle(id: string, minutes: number) {
    try {
      await api.patch(`/tenants/${id}`, { sessionIdleMinutes: minutes });
      toast.success(
        t("tenants.sessionIdle.ok", "Idle timeout updated"),
      );
      load();
      if (detailOpen) loadDetail(detailOpen);
    } catch (err) {
      const e = err as { status?: number; message?: string };
      toast.error(
        e.message ||
          t(
            "tenants.sessionIdle.error",
            "Failed to update idle timeout",
          ),
      );
    }
  }

  // Pearl §8.1 row 206 — restore flips Tenant.active=true via the dedicated
  // POST /:id/restore endpoint (emits TENANT_RESTORED audit row). Mirrors
  // suspend so audit pairs cleanly per the gap-doc closure annotation.
  async function reactivateTenant(id: string, name?: string) {
    const ok = await confirm({
      title: t("tenants.reactivate.confirm", `Restore tenant${name ? ` "${name}"` : ""}?`),
      message: t(
        "tenants.reactivate.warning",
        "Users of this tenant will be able to sign in again.",
      ),
      confirmLabel: t("tenants.reactivate.button", "Restore"),
    });
    if (!ok) return;
    try {
      await api.post(`/tenants/${id}/restore`);
      toast.success(t("tenants.reactivate.ok", "Tenant restored"));
      load();
      if (detailOpen) loadDetail(detailOpen);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    }
  }

  // Reset the visible window whenever the filter set changes so the
  // operator never sees a stale tail after narrowing results.
  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [search, planFilter, activeFilter]);

  const totalRows = tenants.length;
  const visibleTenants = tenants.slice(0, visibleCount);
  const hasMore = visibleCount < totalRows;

  // IntersectionObserver — when the sentinel scrolls into view, bump
  // the visible window by PAGE_SIZE. No fetch needed because the API
  // already returned the full filtered list; this is just client-side
  // virtualisation of how many rows we paint at once.
  useEffect(() => {
    if (!hasMore) return;
    const el = sentinelRef.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisibleCount((c) => Math.min(c + PAGE_SIZE, totalRows));
        }
      },
      { rootMargin: "200px" },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [hasMore, totalRows]);

  if (user && user.role !== "ADMIN") return null;

  return (
    <div data-testid="tenants-page">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">
            {t("tenants.title", "Tenants")}
          </h1>
          <p className="text-sm text-gray-500">
            {t(
              "tenants.subtitle",
              "Manage multi-tenant hospital installations.",
            )}
          </p>
        </div>
        <button
          data-testid="tenants-create-open"
          onClick={() => setCreateOpen(true)}
          className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark"
        >
          <Plus size={16} /> {t("tenants.create", "Create Tenant")}
        </button>
      </div>

      {/* Filters — search + plan dropdown + segmented status filter, all
          on one row. Search flexes; plan & status sit on the right at
          natural width. Counts are appended to the status pill labels so
          the operator sees the breakdown at a glance. */}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[220px]">
          <Search
            size={14}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400"
          />
          <input
            data-testid="tenants-search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t(
              "tenants.search.placeholder",
              "Search by name...",
            )}
            className="w-full rounded-lg border border-gray-300 bg-white py-2 pl-9 pr-3 text-sm focus:border-slate-500 focus:outline-none"
          />
        </div>

        {/* Status filter — segmented pill control. Sits inline with the
            other filters; default = "All" so every tenant shows on first
            load. */}
        <div
          role="radiogroup"
          aria-label={t("tenants.filter.statusLabel", "Status filter")}
          data-testid="tenants-active-filter"
          className="inline-flex h-10 overflow-hidden rounded-lg border border-gray-300 bg-white shadow-sm"
        >
          {(
            [
              { key: "all", label: t("tenants.filter.all", "All") },
              {
                key: "active",
                label: t("tenants.filter.active", "Active"),
              },
              {
                key: "inactive",
                label: t("tenants.filter.inactive", "Inactive"),
              },
            ] as const
          ).map((opt, i) => {
            const active = activeFilter === opt.key;
            return (
              <button
                key={opt.key}
                type="button"
                role="radio"
                aria-checked={active}
                data-testid={`tenants-active-filter-${opt.key}`}
                onClick={() => setActiveFilter(opt.key)}
                className={`px-4 text-sm font-medium transition ${
                  i > 0 ? "border-l border-gray-300" : ""
                } ${
                  active
                    ? "bg-slate-900 text-white"
                    : "bg-white text-slate-700 hover:bg-slate-50"
                }`}
              >
                {opt.label}
              </button>
            );
          })}
        </div>

        <select
          data-testid="tenants-plan-filter"
          value={planFilter}
          onChange={(e) => setPlanFilter(e.target.value as "" | Plan)}
          className="h-10 rounded-lg border border-gray-300 bg-white px-3 text-sm focus:border-slate-500 focus:outline-none"
        >
          <option value="">{t("tenants.filter.allPlans", "All plans")}</option>
          <option value="BASIC">BASIC</option>
          <option value="PRO">PRO</option>
          <option value="ENTERPRISE">ENTERPRISE</option>
        </select>
      </div>

      <div className="rounded-xl bg-white shadow-sm">
        {loading ? (
          <div className="p-8 text-center text-gray-500">
            {t("common.loading", "Loading...")}
          </div>
        ) : tenants.length === 0 ? (
          <div className="p-8 text-center text-gray-500" data-testid="tenants-empty">
            {t("tenants.empty", "No tenants match your filters.")}
          </div>
        ) : (
          <table className="w-full" data-testid="tenants-table">
            <thead>
              <tr className="border-b text-left text-xs text-gray-500">
                <th className="px-4 py-3">{t("tenants.col.code", "Code")}</th>
                <th className="px-4 py-3">{t("tenants.col.name", "Name")}</th>
                <th className="px-4 py-3">{t("tenants.col.plan", "Plan")}</th>
                <th className="px-4 py-3">
                  {t("tenants.col.users", "Users")}
                </th>
                <th className="px-4 py-3">
                  {t("tenants.col.patients", "Patients")}
                </th>
                <th className="px-4 py-3">
                  {t("tenants.col.appts7d", "Appts 7d")}
                </th>
                <th className="px-4 py-3">
                  {t("tenants.col.opd", "Monthly OPD")}
                </th>
                <th className="px-4 py-3">
                  {t("tenants.col.mrr", "MRR")}
                </th>
                <th className="px-4 py-3">
                  {t("tenants.col.invoices30", "Inv / 30d")}
                </th>
                <th className="px-4 py-3">
                  {t("tenants.col.lastLogin", "Last login")}
                </th>
                <th className="px-4 py-3">
                  {t("tenants.col.billing", "Billing")}
                </th>
                <th className="px-4 py-3">
                  {t("tenants.col.status", "Status")}
                </th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {visibleTenants.map((tt) => (
                <tr
                  key={tt.id}
                  className={`border-b last:border-0 text-sm ${
                    tt.active ? "" : "bg-gray-50 text-gray-500 opacity-75"
                  }`}
                  data-testid={`tenant-row-${tt.subdomain}`}
                  data-tenant-active={tt.active ? "true" : "false"}
                >
                  <td
                    className="px-4 py-3"
                    data-testid={`tenant-code-${tt.subdomain}`}
                  >
                    {tt.code ? (
                      <span className="rounded bg-slate-100 px-2 py-0.5 font-mono text-xs font-semibold text-slate-700">
                        {tt.code}
                      </span>
                    ) : (
                      <span className="text-xs text-gray-400">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 font-medium">{tt.name}</td>
                  <td className="px-4 py-3">
                    <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium">
                      {tt.plan}
                    </span>
                  </td>
                  <KpiCell
                    metrics={metrics}
                    tenantId={tt.id}
                    field="userCount"
                    fallback={tt.stats?.userCount}
                    testid="tenant-kpi-users"
                    tenantSubdomain={tt.subdomain}
                  />
                  <KpiCell
                    metrics={metrics}
                    tenantId={tt.id}
                    field="patientCount"
                    fallback={tt.stats?.patientCount}
                    testid="tenant-kpi-patients"
                    tenantSubdomain={tt.subdomain}
                  />
                  <KpiCell
                    metrics={metrics}
                    tenantId={tt.id}
                    field="appointmentsLast7d"
                    testid="tenant-kpi-appts7d"
                    tenantSubdomain={tt.subdomain}
                  />
                  <td
                    className="px-4 py-3 text-xs"
                    data-testid={`tenant-kpi-opd-${tt.subdomain}`}
                  >
                    {tt.stats?.monthlyOpdVolume ?? 0}
                  </td>
                  <td
                    className="px-4 py-3 text-xs font-medium"
                    data-testid={`tenant-kpi-mrr-${tt.subdomain}`}
                  >
                    {formatINR(tt.stats?.mrrInPaise)}
                  </td>
                  <KpiCell
                    metrics={metrics}
                    tenantId={tt.id}
                    field="invoicesLast30d"
                    fallback={tt.stats?.invoicesLast30Days}
                    testid="tenant-kpi-invoices30d"
                    tenantSubdomain={tt.subdomain}
                  />
                  <td
                    className="px-4 py-3 text-xs text-gray-600"
                    title={tt.stats?.lastLoginAt ?? "Never"}
                    data-testid={`tenant-kpi-lastlogin-${tt.subdomain}`}
                  >
                    {relativeTime(tt.stats?.lastLoginAt)}
                  </td>
                  <td className="px-4 py-3 text-xs">
                    {(() => {
                      const b = billingBadge(
                        tt.stats?.billingHealth,
                        tt.active,
                      );
                      return (
                        <span
                          data-testid={`tenant-billing-${tt.subdomain}`}
                          className={`rounded-full px-2 py-0.5 font-semibold uppercase tracking-wide ${b.cls}`}
                        >
                          {b.label}
                        </span>
                      );
                    })()}
                  </td>
                  <td className="px-4 py-3">
                    {tt.active ? (
                      <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs text-green-800">
                        {t("tenants.status.active", "Active")}
                      </span>
                    ) : tt.archivedAt ? (
                      <span
                        className="rounded-full bg-slate-300 px-2 py-0.5 text-xs font-semibold text-slate-800"
                        data-testid={`tenant-archived-badge-${tt.subdomain}`}
                        title={`Archived to S3 on ${new Date(tt.archivedAt).toLocaleDateString()}`}
                      >
                        {t("tenants.status.archived", "ARCHIVED")}
                      </span>
                    ) : (
                      <span
                        className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-800"
                        data-testid={`tenant-suspended-badge-${tt.subdomain}`}
                      >
                        {t("tenants.status.suspended", "SUSPENDED")}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-1">
                      <button
                        data-testid={`tenant-detail-${tt.subdomain}`}
                        onClick={() => setDetailOpen(tt.id)}
                        className="inline-flex h-11 w-11 items-center justify-center rounded text-gray-600 hover:bg-gray-100"
                        title={t("tenants.view.details", "View details")}
                        aria-label={t("tenants.view.details", "View details")}
                      >
                        <Info size={14} />
                      </button>
                      <Link
                        data-testid={`tenant-onboarding-${tt.subdomain}`}
                        href={`/dashboard/tenants/${tt.id}/onboarding`}
                        className="inline-flex h-11 w-11 items-center justify-center rounded text-primary hover:bg-primary/10"
                        title={t("tenants.view.onboarding", "Onboarding")}
                        aria-label={t("tenants.view.onboarding", "Onboarding")}
                      >
                        <Plus size={14} />
                      </Link>
                      <Link
                        data-testid={`tenant-detail-page-${tt.subdomain}`}
                        href={`/dashboard/tenants/${tt.id}`}
                        className="inline-flex h-11 w-11 items-center justify-center rounded text-gray-600 hover:bg-gray-100"
                        title={t("tenants.view.detailPage", "Open detail page")}
                        aria-label={t(
                          "tenants.view.detailPage",
                          "Open detail page",
                        )}
                      >
                        <ExternalLink size={14} />
                      </Link>
                      <Link
                        data-testid={`tenant-config-${tt.subdomain}`}
                        href={`/dashboard/tenants/${tt.id}/config`}
                        className="inline-flex h-11 w-11 items-center justify-center rounded text-gray-600 hover:bg-gray-100"
                        title={t("tenants.view.config", "Feature flags")}
                        aria-label={t("tenants.view.config", "Feature flags")}
                      >
                        <SlidersHorizontal size={14} />
                      </Link>
                      {/* Pearl §8.1 row 206 — per-row Suspend / Restore
                          icon buttons. Suspend hidden for the default
                          tenant (server-side guard blocks it anyway, but
                          we don't render the button to avoid a confusing
                          400). 44px touch targets per spec. */}
                      {tt.active ? (
                        tt.subdomain === "default" ? null : (
                          <button
                            data-testid={`tenant-row-suspend-${tt.subdomain}`}
                            onClick={() => deactivateTenant(tt.id, tt.name)}
                            className="inline-flex h-11 w-11 items-center justify-center rounded text-red-600 hover:bg-red-50"
                            title={t("tenants.deactivate.button", "Suspend")}
                            aria-label={t(
                              "tenants.deactivate.aria",
                              `Suspend ${tt.name}`,
                            )}
                          >
                            <PowerOff size={14} />
                          </button>
                        )
                      ) : (
                        <button
                          data-testid={`tenant-row-restore-${tt.subdomain}`}
                          onClick={() => reactivateTenant(tt.id, tt.name)}
                          className="inline-flex h-11 w-11 items-center justify-center rounded text-green-600 hover:bg-green-50"
                          title={t("tenants.reactivate.button", "Restore")}
                          aria-label={t(
                            "tenants.reactivate.aria",
                            `Restore ${tt.name}`,
                          )}
                        >
                          <Power size={14} />
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

      {/* Infinite-scroll sentinel + status line. When this div scrolls
          into view the IntersectionObserver above expands the visible
          window by PAGE_SIZE until everything is rendered. */}
      {!loading && tenants.length > 0 && (
        <div
          data-testid="tenants-scroll-status"
          ref={sentinelRef}
          className="flex items-center justify-center py-4 text-xs text-gray-500"
        >
          {hasMore ? (
            <span className="inline-flex items-center gap-2">
              <Loader2 size={14} className="animate-spin" aria-hidden="true" />
              {t("tenants.scroll.loadingMore", "Loading more…")}
            </span>
          ) : (
            <span data-testid="tenants-scroll-end">
              {t("tenants.scroll.end", "Showing all")} {totalRows}{" "}
              {totalRows === 1
                ? t("tenants.scroll.tenant", "tenant")
                : t("tenants.scroll.tenants", "tenants")}
            </span>
          )}
        </div>
      )}

      {createOpen && (
        <CreateTenantModal
          onClose={() => setCreateOpen(false)}
          onCreated={(tenantId: string) => {
            setCreateOpen(false);
            load();
            router.push(`/dashboard/tenants/${tenantId}/onboarding`);
          }}
        />
      )}

      {detailOpen && (
        <TenantDetailDrawer
          tenantId={detailOpen}
          detail={detail}
          onClose={() => setDetailOpen(null)}
          onDeactivate={deactivateTenant}
          onReactivate={reactivateTenant}
          onUpdateSessionIdle={updateSessionIdle}
        />
      )}
    </div>
  );
}

// ─── Per-tenant KPI Cell (Pearl §8.1 row 204) ────────────────────────

/**
 * Renders one KPI cell sourced from the super-admin metrics rollup.
 *   - phase=loading → SkeletonText placeholder
 *   - phase=loaded + tenantId in top-20 map → KPI value
 *   - phase=loaded + NOT in top-20 → em-dash with explanatory tooltip
 *     (or per-tenant `stats` fallback when one is supplied — used for
 *     userCount/patientCount/invoicesLast30Days where the row-level
 *     stats endpoint already gave us a number)
 *   - phase=failed → em-dash (silent degrade; list still renders)
 */
function KpiCell({
  metrics,
  tenantId,
  field,
  fallback,
  testid,
  tenantSubdomain,
}: {
  metrics: MetricsState;
  tenantId: string;
  field: keyof Omit<PerTenantMetricsRow, "tenantId">;
  fallback?: number;
  testid: string;
  tenantSubdomain: string;
}) {
  const dataTestId = `${testid}-${tenantSubdomain}`;
  if (metrics.phase === "loading" || metrics.phase === "idle") {
    return (
      <td className="px-4 py-3 text-xs" data-testid={dataTestId}>
        <Skeleton variant="text" width="40px" height={14} />
      </td>
    );
  }
  if (metrics.phase === "failed") {
    return (
      <td className="px-4 py-3 text-xs" data-testid={dataTestId}>
        —
      </td>
    );
  }
  const row = metrics.byTenantId.get(tenantId);
  if (row) {
    return (
      <td className="px-4 py-3 text-xs" data-testid={dataTestId}>
        {row[field]}
      </td>
    );
  }
  if (fallback !== undefined) {
    return (
      <td className="px-4 py-3 text-xs" data-testid={dataTestId}>
        {fallback}
      </td>
    );
  }
  return (
    <td
      className="px-4 py-3 text-xs"
      data-testid={dataTestId}
      title="Metrics shown for top-20 tenants by user count"
    >
      —
    </td>
  );
}

// ─── Create Tenant Modal ─────────────────────────────────────────────

function CreateTenantModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (tenantId: string) => void;
}) {
  const { t } = useTranslation();
  const [form, setForm] = useState({
    name: "",
    plan: "BASIC" as Plan,
    adminEmail: "",
    adminPassword: "",
    adminName: "",
    hospitalPhone: "",
    hospitalEmail: "",
    hospitalGstin: "",
    hospitalAddress: "",
  });
  const [submitting, setSubmitting] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  // Stable random suffix for input `name` attrs — defeats Chromium's
  // credential autofill heuristic without changing on each render
  // (which would cause hydration mismatch + focus loss).
  const [autofillNonce] = useState(
    () => `nonce-${Math.random().toString(36).slice(2, 10)}`,
  );

  // Auto-derive the routing subdomain from Hospital Name — operators no
  // longer choose it. Slug rules mirror validateSubdomain(): lowercase
  // alphanumerics + hyphens, 3–30 chars, no leading/trailing hyphen.
  // On collision the backend returns 409 and we surface a friendly
  // "name conflict" toast (see submit() catch).
  function deriveSubdomain(name: string): string {
    const slug = name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 30);
    return slug.length < 3 ? `${slug}-hospital`.slice(0, 30) : slug;
  }

  const emailError = useMemo(() => {
    if (!form.adminEmail) return null;
    return /.+@.+\..+/.test(form.adminEmail) ? null : "Invalid email";
  }, [form.adminEmail]);

  const passwordError =
    form.adminPassword && form.adminPassword.length < 8
      ? "At least 8 characters"
      : null;

  const canSubmit =
    form.name.trim().length >= 2 &&
    form.adminEmail &&
    !emailError &&
    form.adminPassword.length >= 8 &&
    form.adminName.trim().length >= 2 &&
    !submitting;

  async function submit() {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      const res = await api.post<{ data: { tenant: { id: string } } }>(
        "/tenants",
        {
          name: form.name.trim(),
          subdomain: deriveSubdomain(form.name),
          plan: form.plan,
          adminEmail: form.adminEmail.trim(),
          adminPassword: form.adminPassword,
          adminName: form.adminName.trim(),
          hospitalConfig: {
            phone: form.hospitalPhone.trim() || undefined,
            email: form.hospitalEmail.trim() || undefined,
            gstin: form.hospitalGstin.trim() || undefined,
            address: form.hospitalAddress.trim() || undefined,
          },
        },
      );
      toast.success(
        t("tenants.create.ok", "Tenant created. Continue with onboarding."),
      );
      onCreated(res.data.tenant.id);
    } catch (err) {
      const e = err as { status?: number; message?: string };
      if (e.status === 409) {
        toast.error(
          t(
            "tenants.create.conflict",
            "A tenant with a similar name already exists. Choose a different Hospital Name.",
          ),
        );
      } else {
        toast.error(e.message || "Failed to create tenant");
      }
    }
    setSubmitting(false);
  }

  const inputCls =
    "w-full rounded-lg border border-gray-300 bg-white px-3 py-2.5 text-sm text-gray-900 shadow-sm transition focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100 dark:focus:border-primary dark:focus:ring-primary/40";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
      data-testid="tenants-create-modal"
    >
      <div className="flex max-h-[92vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl dark:bg-gray-900">
        {/* Sticky header */}
        <div className="flex items-start justify-between border-b border-gray-200 bg-gradient-to-r from-primary/5 via-white to-white px-6 py-4 dark:border-gray-700 dark:from-primary/10 dark:via-gray-900 dark:to-gray-900">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary dark:bg-primary/20">
              <Building2 size={20} />
            </div>
            <div>
              <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">
                {t("tenants.create.title", "Create Tenant")}
              </h3>
              <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                {t(
                  "tenants.create.subtitle",
                  "Spin up a new hospital tenant and seed its first admin.",
                )}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-gray-500 hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-gray-800 dark:hover:text-gray-200"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto px-6 py-5">
          {/* Honeypot inputs — eat Chromium's first-pass credential
              autofill so the real fields stay empty. Visually hidden,
              never submitted. Standard trick for create-user forms. */}
          <div
            aria-hidden="true"
            style={{
              position: "absolute",
              left: "-9999px",
              top: "-9999px",
              height: 0,
              width: 0,
              overflow: "hidden",
              opacity: 0,
            }}
          >
            <input
              type="text"
              name="fake-username"
              tabIndex={-1}
              autoComplete="username"
              readOnly
            />
            <input
              type="password"
              name="fake-password"
              tabIndex={-1}
              autoComplete="current-password"
              readOnly
            />
          </div>

          {/* Section: Hospital identity */}
          <section className="rounded-xl border border-gray-200 bg-gray-50/60 p-4 dark:border-gray-700 dark:bg-gray-800/40">
            <div className="mb-3 flex items-center gap-2">
              <Sparkles size={14} className="text-primary" />
              <h4 className="text-sm font-semibold text-gray-800 dark:text-gray-200">
                {t("tenants.create.identity", "Hospital Identity")}
              </h4>
            </div>
            <div className="space-y-3">
              <Field label={t("tenants.create.name", "Hospital Name")}>
                <input
                  data-testid="tenants-create-name"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="e.g. MedCore Apollo"
                  className={inputCls}
                />
              </Field>
              <div className="sm:max-w-xs">
                <Field label={t("tenants.create.plan", "Plan")}>
                  <select
                    data-testid="tenants-create-plan"
                    value={form.plan}
                    onChange={(e) =>
                      setForm({ ...form, plan: e.target.value as Plan })
                    }
                    className={inputCls}
                  >
                    <option value="BASIC">BASIC</option>
                    <option value="PRO">PRO</option>
                    <option value="ENTERPRISE">ENTERPRISE</option>
                  </select>
                </Field>
              </div>
            </div>
          </section>

          {/* Section: First admin user */}
          <section className="mt-4 rounded-xl border border-gray-200 bg-gray-50/60 p-4 dark:border-gray-700 dark:bg-gray-800/40">
            <div className="mb-3 flex items-center gap-2">
              <UserCog size={14} className="text-primary" />
              <h4 className="text-sm font-semibold text-gray-800 dark:text-gray-200">
                {t("tenants.create.adminSection", "First Admin User")}
              </h4>
              <span className="ml-auto rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-primary">
                Required
              </span>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label={t("tenants.create.adminName", "Name")}>
                <input
                  data-testid="tenants-create-admin-name"
                  value={form.adminName}
                  onChange={(e) =>
                    setForm({ ...form, adminName: e.target.value })
                  }
                  placeholder="Dr. Rajesh Sharma"
                  className={inputCls}
                />
              </Field>
              <Field
                label={t("tenants.create.adminEmail", "Email")}
                error={emailError}
              >
                <input
                  data-testid="tenants-create-admin-email"
                  type="email"
                  value={form.adminEmail}
                  onChange={(e) =>
                    setForm({ ...form, adminEmail: e.target.value })
                  }
                  placeholder="admin@hospital.com"
                  className={inputCls}
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  name={`tenant-new-admin-email-${autofillNonce}`}
                />
              </Field>
            </div>
            <div className="mt-3">
              <Field
                label={t("tenants.create.adminPassword", "Temporary Password")}
                error={passwordError}
                hint={t(
                  "tenants.create.adminPassword.hint",
                  "Minimum 8 characters. Admin should change on first login.",
                )}
              >
                <div className="relative">
                  <Lock
                    size={14}
                    className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400"
                    aria-hidden="true"
                  />
                  <input
                    data-testid="tenants-create-admin-password"
                    type={showPassword ? "text" : "password"}
                    value={form.adminPassword}
                    onChange={(e) =>
                      setForm({ ...form, adminPassword: e.target.value })
                    }
                    placeholder="••••••••"
                    className={`${inputCls} pl-9 pr-10`}
                    autoComplete="new-password"
                    autoCorrect="off"
                    autoCapitalize="off"
                    spellCheck={false}
                    name={`tenant-new-admin-password-${autofillNonce}`}
                  />
                  <button
                    type="button"
                    data-testid="tenants-create-admin-password-toggle"
                    onClick={() => setShowPassword((v) => !v)}
                    className="absolute right-1.5 top-1/2 inline-flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-md text-gray-500 hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-gray-700 dark:hover:text-gray-200"
                    aria-label={
                      showPassword
                        ? t("tenants.create.password.hide", "Hide password")
                        : t("tenants.create.password.show", "Show password")
                    }
                    title={
                      showPassword
                        ? t("tenants.create.password.hide", "Hide password")
                        : t("tenants.create.password.show", "Show password")
                    }
                  >
                    {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
              </Field>
            </div>
          </section>

          {/* Section: Hospital details (optional) */}
          <section className="mt-4 rounded-xl border border-dashed border-gray-300 bg-white p-4 dark:border-gray-600 dark:bg-gray-900/40">
            <div className="mb-3 flex items-center gap-2">
              <PhoneIcon size={14} className="text-gray-500" />
              <h4 className="text-sm font-semibold text-gray-800 dark:text-gray-200">
                {t("tenants.create.hospitalSection", "Hospital Details")}
              </h4>
              <span className="ml-auto text-[11px] font-medium uppercase tracking-wider text-gray-400">
                Optional
              </span>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label={t("tenants.create.hospitalPhone", "Phone")}>
                <input
                  data-testid="tenants-create-hospital-phone"
                  value={form.hospitalPhone}
                  onChange={(e) =>
                    setForm({ ...form, hospitalPhone: e.target.value })
                  }
                  placeholder="+91 98765 43210"
                  className={inputCls}
                />
              </Field>
              <Field label={t("tenants.create.hospitalEmail", "Email")}>
                <input
                  data-testid="tenants-create-hospital-email"
                  type="email"
                  value={form.hospitalEmail}
                  onChange={(e) =>
                    setForm({ ...form, hospitalEmail: e.target.value })
                  }
                  placeholder="info@hospital.com"
                  className={inputCls}
                />
              </Field>
            </div>
            <div className="mt-3">
              <Field label={t("tenants.create.hospitalGstin", "GSTIN")}>
                <input
                  data-testid="tenants-create-hospital-gstin"
                  value={form.hospitalGstin}
                  onChange={(e) =>
                    setForm({ ...form, hospitalGstin: e.target.value })
                  }
                  placeholder="22AAAAA0000A1Z5"
                  className={`${inputCls} font-mono uppercase`}
                />
              </Field>
            </div>
            <div className="mt-3">
              <Field label={t("tenants.create.hospitalAddress", "Address")}>
                <textarea
                  data-testid="tenants-create-hospital-address"
                  value={form.hospitalAddress}
                  onChange={(e) =>
                    setForm({ ...form, hospitalAddress: e.target.value })
                  }
                  rows={2}
                  placeholder="Street, City, State, PIN"
                  className={`${inputCls} resize-none`}
                />
              </Field>
            </div>
          </section>
        </div>

        {/* Sticky footer */}
        <div className="flex items-center justify-end gap-2 border-t border-gray-200 bg-gray-50 px-6 py-3 dark:border-gray-700 dark:bg-gray-800/60">
          <button
            onClick={onClose}
            className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 transition hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-200 dark:hover:bg-gray-800"
          >
            {t("common.cancel", "Cancel")}
          </button>
          <button
            data-testid="tenants-create-submit"
            disabled={!canSubmit}
            onClick={submit}
            className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-primary-dark disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting && <Loader2 size={14} className="animate-spin" />}
            {submitting
              ? t("tenants.create.submitting", "Creating...")
              : t("tenants.create.submit", "Create Tenant")}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  error,
  hint,
  children,
}: {
  label: string;
  error?: string | null;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-gray-600 dark:text-gray-400">
        {label}
      </label>
      {children}
      {hint && !error && (
        <p className="mt-1.5 text-[11px] leading-snug text-gray-500 dark:text-gray-400">
          {hint}
        </p>
      )}
      {error && (
        <p className="mt-1.5 text-[11px] font-medium text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}

// ─── Detail Drawer ───────────────────────────────────────────────────

function TenantDetailDrawer({
  tenantId,
  detail,
  onClose,
  onDeactivate,
  onReactivate,
  onUpdateSessionIdle,
}: {
  tenantId: string;
  detail: TenantDetail | null;
  onClose: () => void;
  onDeactivate: (id: string, name: string) => void;
  onReactivate: (id: string, name?: string) => void;
  onUpdateSessionIdle: (id: string, minutes: number) => void;
}) {
  const { t } = useTranslation();

  // Pearl §8.2 row 212 — staging value for the idle-timeout input
  // (controlled). Resets on detail change so opening a different
  // tenant shows that tenant's persisted value.
  const [sessionIdleDraft, setSessionIdleDraft] = useState<string>("");
  useEffect(() => {
    if (detail) {
      setSessionIdleDraft(String(detail.sessionIdleMinutes ?? 30));
    }
  }, [detail]);

  const sessionIdleError = (() => {
    if (sessionIdleDraft.trim() === "") return null;
    const n = Number(sessionIdleDraft);
    if (!Number.isFinite(n) || !Number.isInteger(n)) return "Must be an integer";
    if (n < 5) return "Minimum 5 minutes";
    if (n > 1440) return "Maximum 1440 minutes (24 h)";
    return null;
  })();

  const canSaveSessionIdle =
    !sessionIdleError &&
    sessionIdleDraft.trim() !== "" &&
    detail !== null &&
    Number(sessionIdleDraft) !== (detail.sessionIdleMinutes ?? 30);

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/30" data-testid="tenants-detail">
      <div className="h-full w-full max-w-lg overflow-y-auto bg-white p-6 shadow-xl">
        <div className="mb-4 flex items-start justify-between">
          <div>
            <h3 className="text-lg font-semibold">
              {detail?.name ?? t("common.loading", "Loading...")}
            </h3>
            {detail?.code && (
              <p className="font-mono text-xs text-gray-500">{detail.code}</p>
            )}
          </div>
          <button onClick={onClose} className="rounded p-1 hover:bg-gray-100">
            <X size={18} />
          </button>
        </div>

        {!detail ? (
          <div className="text-sm text-gray-500">
            {t("common.loading", "Loading...")}
          </div>
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3 rounded-xl bg-gray-50 p-4">
              <Stat
                label={t("tenants.col.users", "Users")}
                value={detail.stats?.userCount ?? 0}
              />
              <Stat
                label={t("tenants.col.patients", "Patients")}
                value={detail.stats?.patientCount ?? 0}
              />
              <Stat
                label={t("tenants.col.invoices30", "Invoices (30d)")}
                value={detail.stats?.invoicesLast30Days ?? 0}
              />
              <Stat
                label={t("tenants.col.storage", "Storage")}
                value={formatBytes(detail.stats?.storageBytes ?? 0)}
              />
            </div>

            <div>
              <h4 className="mb-2 text-sm font-semibold">
                {t("tenants.detail.hospitalConfig", "Hospital Config")}
              </h4>
              <dl className="rounded-xl border text-sm">
                {["hospital_name", "hospital_phone", "hospital_email", "hospital_gstin", "hospital_address"].map(
                  (k) => (
                    <div
                      key={k}
                      className="flex items-start gap-2 border-b px-3 py-2 last:border-0"
                    >
                      <dt className="w-32 text-xs text-gray-500">{k}</dt>
                      <dd className="flex-1 break-words text-xs">
                        {detail.config[k] || "—"}
                      </dd>
                    </div>
                  ),
                )}
              </dl>
            </div>

            {/* Pearl §8.2 row 212 — per-tenant idle session timeout
                (configurable). PATCH /api/v1/tenants/:id accepts
                sessionIdleMinutes in [5, 1440]. JWT TTL enforcement
                deferred (separate piece touches auth.ts). */}
            <div>
              <h4 className="mb-2 text-sm font-semibold">
                {t(
                  "tenants.detail.sessionIdle.title",
                  "Session idle timeout (minutes)",
                )}
              </h4>
              <div className="flex items-start gap-2">
                <input
                  data-testid="tenants-detail-session-idle-input"
                  type="number"
                  min={5}
                  max={1440}
                  step={1}
                  value={sessionIdleDraft}
                  onChange={(e) => setSessionIdleDraft(e.target.value)}
                  className="w-32 rounded-lg border px-3 py-2 text-sm"
                  aria-label={t(
                    "tenants.detail.sessionIdle.aria",
                    "Session idle timeout in minutes",
                  )}
                />
                <button
                  data-testid="tenants-detail-session-idle-save"
                  disabled={!canSaveSessionIdle}
                  onClick={() =>
                    onUpdateSessionIdle(tenantId, Number(sessionIdleDraft))
                  }
                  className="rounded-lg bg-primary px-3 py-2 text-sm text-white hover:bg-primary-dark disabled:opacity-50"
                >
                  {t("common.save", "Save")}
                </button>
              </div>
              <p className="mt-1 text-[11px] text-gray-500">
                {t(
                  "tenants.detail.sessionIdle.hint",
                  "Allowed range: 5–1440. JWT TTL enforcement coming in a separate release; this value is currently persisted only.",
                )}
              </p>
              {sessionIdleError && (
                <p
                  data-testid="tenants-detail-session-idle-error"
                  className="mt-1 text-[11px] text-red-600"
                >
                  {sessionIdleError}
                </p>
              )}
            </div>

            <div>
              <h4 className="mb-2 text-sm font-semibold">
                {t("tenants.detail.admins", "Admin Users")}
              </h4>
              <ul className="rounded-xl border text-sm">
                {detail.admins.length === 0 ? (
                  <li className="px-3 py-2 text-xs text-gray-500">
                    {t("tenants.detail.admins.none", "No admin users")}
                  </li>
                ) : (
                  detail.admins.map((a) => (
                    <li
                      key={a.id}
                      className="flex items-center justify-between border-b px-3 py-2 last:border-0"
                    >
                      <div>
                        <div className="font-medium">{a.name}</div>
                        <div className="text-xs text-gray-500">{a.email}</div>
                      </div>
                      <div className="text-xs text-gray-500">
                        {a.isActive
                          ? t("tenants.status.active", "Active")
                          : t("tenants.status.inactive", "Inactive")}
                      </div>
                    </li>
                  ))
                )}
              </ul>
            </div>

            <div className="flex gap-2">
              <Link
                href={`/dashboard/tenants/${tenantId}/onboarding`}
                className="rounded-lg border px-4 py-2 text-sm hover:bg-gray-50"
              >
                {t("tenants.detail.onboarding", "Open onboarding")}
              </Link>
              {detail.active ? (
                <button
                  data-testid="tenants-detail-deactivate"
                  onClick={() => onDeactivate(detail.id, detail.name)}
                  className="ml-auto flex items-center gap-1 rounded-lg bg-red-600 px-4 py-2 text-sm text-white hover:bg-red-700"
                >
                  <Power size={14} />
                  {t("tenants.deactivate.button", "Suspend")}
                </button>
              ) : (
                <button
                  data-testid="tenants-detail-reactivate"
                  onClick={() => onReactivate(detail.id, detail.name)}
                  className="ml-auto flex items-center gap-1 rounded-lg bg-green-600 px-4 py-2 text-sm text-white hover:bg-green-700"
                >
                  <Power size={14} />
                  {t("tenants.reactivate.button", "Restore")}
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div>
      <div className="text-xs text-gray-500">{label}</div>
      <div className="text-lg font-semibold">{value}</div>
    </div>
  );
}
