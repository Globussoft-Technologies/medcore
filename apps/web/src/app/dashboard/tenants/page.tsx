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

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Plus, Search, Info, Power, X } from "lucide-react";
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
}

interface Tenant {
  id: string;
  name: string;
  subdomain: string;
  plan: Plan;
  active: boolean;
  createdAt: string;
  updatedAt: string;
  stats?: TenantStats;
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

const RESERVED = new Set([
  "admin",
  "api",
  "app",
  "auth",
  "console",
  "dashboard",
  "default",
  "docs",
  "help",
  "mail",
  "medcore",
  "public",
  "root",
  "status",
  "support",
  "system",
  "www",
]);
const SUB_RE = /^[a-z0-9]([a-z0-9-]{1,28}[a-z0-9])?$/;

function validateSubdomain(s: string): string | null {
  const v = (s || "").trim().toLowerCase();
  if (v.length < 3 || v.length > 30) return "Subdomain must be 3–30 characters";
  if (!SUB_RE.test(v))
    return "Use lowercase letters, digits, and hyphens (no leading/trailing hyphen)";
  if (RESERVED.has(v)) return "This subdomain is reserved";
  return null;
}

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

export default function TenantsAdminPage() {
  const { user } = useAuthStore();
  const router = useRouter();
  const confirm = useConfirm();
  const { t } = useTranslation();

  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [planFilter, setPlanFilter] = useState<"" | Plan>("");
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

  useEffect(() => {
    if (user && user.role !== "ADMIN") {
      router.push("/dashboard");
    }
  }, [user, router]);

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
          t(
            "tenants.error.forbidden",
            "Only super-admins on the default tenant can manage tenants.",
          ),
        );
      } else {
        toast.error(e.message || "Failed to load tenants");
      }
      setTenants([]);
    }
    setLoading(false);
  }, [search, planFilter, activeFilter, t]);

  useEffect(() => {
    if (user?.role === "ADMIN") load();
  }, [load, user]);

  // Pearl §8.1 row 204 — load /super-admin/metrics once for the ADMIN
  // session and index `perTenant` by tenantId. The API returns 403 for
  // anything but a super-admin (tenant-less ADMIN OR ADMIN on the
  // seeded "default" tenant); on any error we degrade the KPI cells to
  // dashes rather than failing the whole page.
  //
  // Dep is `user?.role` (primitive) not `user` — the auth store
  // returns a fresh user-object reference on every render, which would
  // cause this effect to re-fire and loop with setMetrics.
  const userRole = user?.role;
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

  async function deactivateTenant(id: string, name: string) {
    const ok = await confirm({
      title: t("tenants.deactivate.confirm", `Deactivate tenant "${name}"?`),
      message: t(
        "tenants.deactivate.warning",
        "All users of this tenant will be signed out at their next refresh. You can reactivate later.",
      ),
      confirmLabel: t("tenants.deactivate.button", "Deactivate"),
      danger: true,
    });
    if (!ok) return;
    try {
      await api.post(`/tenants/${id}/deactivate`);
      toast.success(t("tenants.deactivate.ok", "Tenant deactivated"));
      setDetailOpen(null);
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    }
  }

  async function reactivateTenant(id: string) {
    try {
      await api.patch(`/tenants/${id}`, { active: true });
      toast.success(t("tenants.reactivate.ok", "Tenant reactivated"));
      load();
      if (detailOpen) loadDetail(detailOpen);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    }
  }

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

      {/* Filters */}
      <div className="mb-4 flex flex-wrap gap-2">
        <div className="relative flex-1 min-w-[200px]">
          <Search
            size={14}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400"
          />
          <input
            data-testid="tenants-search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("tenants.search.placeholder", "Search by name or subdomain...")}
            className="w-full rounded-lg border bg-white px-9 py-2 text-sm"
          />
        </div>
        <select
          data-testid="tenants-plan-filter"
          value={planFilter}
          onChange={(e) => setPlanFilter(e.target.value as "" | Plan)}
          className="rounded-lg border bg-white px-3 py-2 text-sm"
        >
          <option value="">{t("tenants.filter.allPlans", "All plans")}</option>
          <option value="BASIC">BASIC</option>
          <option value="PRO">PRO</option>
          <option value="ENTERPRISE">ENTERPRISE</option>
        </select>
        <select
          data-testid="tenants-active-filter"
          value={activeFilter}
          onChange={(e) => setActiveFilter(e.target.value as typeof activeFilter)}
          className="rounded-lg border bg-white px-3 py-2 text-sm"
        >
          <option value="active">{t("tenants.filter.active", "Active only")}</option>
          <option value="inactive">{t("tenants.filter.inactive", "Inactive only")}</option>
          <option value="all">{t("tenants.filter.all", "All")}</option>
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
                <th className="px-4 py-3">{t("tenants.col.name", "Name")}</th>
                <th className="px-4 py-3">
                  {t("tenants.col.subdomain", "Subdomain")}
                </th>
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
                  {t("tenants.col.invoices30", "Inv / 30d")}
                </th>
                <th className="px-4 py-3">
                  {t("tenants.col.storage", "Storage")}
                </th>
                <th className="px-4 py-3">
                  {t("tenants.col.status", "Status")}
                </th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {tenants.map((tt) => (
                <tr
                  key={tt.id}
                  className="border-b last:border-0 text-sm"
                  data-testid={`tenant-row-${tt.subdomain}`}
                >
                  <td className="px-4 py-3 font-medium">{tt.name}</td>
                  <td className="px-4 py-3 font-mono text-xs text-gray-600">
                    {tt.subdomain}
                  </td>
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
                  <KpiCell
                    metrics={metrics}
                    tenantId={tt.id}
                    field="invoicesLast30d"
                    fallback={tt.stats?.invoicesLast30Days}
                    testid="tenant-kpi-invoices30d"
                    tenantSubdomain={tt.subdomain}
                  />
                  <td className="px-4 py-3 text-xs">
                    {formatBytes(tt.stats?.storageBytes ?? 0)}
                  </td>
                  <td className="px-4 py-3">
                    {tt.active ? (
                      <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs text-green-800">
                        {t("tenants.status.active", "Active")}
                      </span>
                    ) : (
                      <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs text-red-800">
                        {t("tenants.status.inactive", "Inactive")}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      data-testid={`tenant-detail-${tt.subdomain}`}
                      onClick={() => setDetailOpen(tt.id)}
                      className="mr-2 rounded p-1 text-gray-600 hover:bg-gray-100"
                      title={t("tenants.view.details", "View details")}
                    >
                      <Info size={14} />
                    </button>
                    <Link
                      data-testid={`tenant-onboarding-${tt.subdomain}`}
                      href={`/dashboard/tenants/${tt.id}/onboarding`}
                      className="rounded p-1 text-primary hover:bg-primary/10"
                      title={t("tenants.view.onboarding", "Onboarding")}
                    >
                      <Plus size={14} />
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

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
    subdomain: "",
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

  const subdomainError = useMemo(
    () => (form.subdomain ? validateSubdomain(form.subdomain) : null),
    [form.subdomain],
  );

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
    form.subdomain &&
    !subdomainError &&
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
          subdomain: form.subdomain.trim().toLowerCase(),
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
          t("tenants.create.conflict", "Subdomain already in use."),
        );
      } else {
        toast.error(e.message || "Failed to create tenant");
      }
    }
    setSubmitting(false);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      data-testid="tenants-create-modal"
    >
      <div className="max-h-[90vh] w-full max-w-xl overflow-y-auto rounded-2xl bg-white p-6 shadow-xl">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-lg font-semibold">
            {t("tenants.create.title", "Create Tenant")}
          </h3>
          <button onClick={onClose} className="rounded p-1 hover:bg-gray-100">
            <X size={18} />
          </button>
        </div>
        <div className="space-y-3">
          <Field label={t("tenants.create.name", "Hospital Name")}>
            <input
              data-testid="tenants-create-name"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              className="w-full rounded-lg border px-3 py-2 text-sm"
            />
          </Field>
          <Field
            label={t("tenants.create.subdomain", "Subdomain")}
            error={subdomainError}
            hint={t(
              "tenants.create.subdomain.hint",
              "Will be accessible at <subdomain>.medcore.globusdemos.com (immutable).",
            )}
          >
            <input
              data-testid="tenants-create-subdomain"
              value={form.subdomain}
              onChange={(e) =>
                setForm({
                  ...form,
                  subdomain: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""),
                })
              }
              className="w-full rounded-lg border px-3 py-2 text-sm font-mono"
            />
          </Field>
          <Field label={t("tenants.create.plan", "Plan")}>
            <select
              data-testid="tenants-create-plan"
              value={form.plan}
              onChange={(e) => setForm({ ...form, plan: e.target.value as Plan })}
              className="w-full rounded-lg border px-3 py-2 text-sm"
            >
              <option value="BASIC">BASIC</option>
              <option value="PRO">PRO</option>
              <option value="ENTERPRISE">ENTERPRISE</option>
            </select>
          </Field>
          <div className="my-4 border-t pt-3">
            <h4 className="mb-2 text-sm font-semibold text-gray-700">
              {t("tenants.create.adminSection", "First Admin User")}
            </h4>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field label={t("tenants.create.adminName", "Name")}>
                <input
                  data-testid="tenants-create-admin-name"
                  value={form.adminName}
                  onChange={(e) => setForm({ ...form, adminName: e.target.value })}
                  className="w-full rounded-lg border px-3 py-2 text-sm"
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
                  className="w-full rounded-lg border px-3 py-2 text-sm"
                />
              </Field>
            </div>
            <Field
              label={t("tenants.create.adminPassword", "Temporary Password")}
              error={passwordError}
              hint={t(
                "tenants.create.adminPassword.hint",
                "Minimum 8 characters. Admin should change on first login.",
              )}
            >
              <input
                data-testid="tenants-create-admin-password"
                type="password"
                value={form.adminPassword}
                onChange={(e) =>
                  setForm({ ...form, adminPassword: e.target.value })
                }
                className="w-full rounded-lg border px-3 py-2 text-sm"
              />
            </Field>
          </div>
          <div className="my-4 border-t pt-3">
            <h4 className="mb-2 text-sm font-semibold text-gray-700">
              {t("tenants.create.hospitalSection", "Hospital Details (optional)")}
            </h4>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field label={t("tenants.create.hospitalPhone", "Phone")}>
                <input
                  data-testid="tenants-create-hospital-phone"
                  value={form.hospitalPhone}
                  onChange={(e) =>
                    setForm({ ...form, hospitalPhone: e.target.value })
                  }
                  className="w-full rounded-lg border px-3 py-2 text-sm"
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
                  className="w-full rounded-lg border px-3 py-2 text-sm"
                />
              </Field>
            </div>
            <Field label={t("tenants.create.hospitalGstin", "GSTIN")}>
              <input
                data-testid="tenants-create-hospital-gstin"
                value={form.hospitalGstin}
                onChange={(e) =>
                  setForm({ ...form, hospitalGstin: e.target.value })
                }
                className="w-full rounded-lg border px-3 py-2 text-sm"
              />
            </Field>
            <Field label={t("tenants.create.hospitalAddress", "Address")}>
              <textarea
                data-testid="tenants-create-hospital-address"
                value={form.hospitalAddress}
                onChange={(e) =>
                  setForm({ ...form, hospitalAddress: e.target.value })
                }
                rows={2}
                className="w-full rounded-lg border px-3 py-2 text-sm"
              />
            </Field>
          </div>
        </div>
        <div className="mt-6 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-lg border px-4 py-2 text-sm hover:bg-gray-50"
          >
            {t("common.cancel", "Cancel")}
          </button>
          <button
            data-testid="tenants-create-submit"
            disabled={!canSubmit}
            onClick={submit}
            className="rounded-lg bg-primary px-4 py-2 text-sm text-white hover:bg-primary-dark disabled:opacity-50"
          >
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
      <label className="mb-1 block text-xs font-medium text-gray-600">
        {label}
      </label>
      {children}
      {hint && !error && (
        <p className="mt-1 text-[11px] text-gray-500">{hint}</p>
      )}
      {error && <p className="mt-1 text-[11px] text-red-600">{error}</p>}
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
}: {
  tenantId: string;
  detail: TenantDetail | null;
  onClose: () => void;
  onDeactivate: (id: string, name: string) => void;
  onReactivate: (id: string) => void;
}) {
  const { t } = useTranslation();

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/30" data-testid="tenants-detail">
      <div className="h-full w-full max-w-lg overflow-y-auto bg-white p-6 shadow-xl">
        <div className="mb-4 flex items-start justify-between">
          <div>
            <h3 className="text-lg font-semibold">
              {detail?.name ?? t("common.loading", "Loading...")}
            </h3>
            {detail && (
              <p className="font-mono text-xs text-gray-500">
                {detail.subdomain}.medcore.globusdemos.com
              </p>
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
                  {t("tenants.deactivate.button", "Deactivate")}
                </button>
              ) : (
                <button
                  data-testid="tenants-detail-reactivate"
                  onClick={() => onReactivate(detail.id)}
                  className="ml-auto flex items-center gap-1 rounded-lg bg-green-600 px-4 py-2 text-sm text-white hover:bg-green-700"
                >
                  <Power size={14} />
                  {t("tenants.reactivate.button", "Reactivate")}
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
