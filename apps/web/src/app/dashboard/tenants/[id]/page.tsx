"use client";

/**
 * Tenant detail page — Pearl ERP Stage 1 §8.1 (gap row 207 closure,
 * in-band dashboard surface).
 *
 * Renders alongside the existing /dashboard/tenants list (drawer view
 * stays; this is the deep-link full-page view). Surfaces:
 *   - identity + stats (users, patients, monthly OPD, MRR, last login)
 *   - onboarding checklist (which wizard steps completed)
 *   - default doctor mode editor (CALLING / TOKEN / SLOT)
 *   - integration cards (WhatsApp / Razorpay / ABDM)
 *   - admin user roster
 *   - suspend / restore actions (with confirmation toast)
 *
 * Visibility: ADMIN role; the API enforces the real super-admin gate.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import {
  ArrowLeft,
  Building2,
  RefreshCw,
  CheckCircle2,
  XCircle,
  Settings,
  Pause,
  Play,
  Stethoscope,
  MessageSquare,
  CreditCard,
  ShieldCheck,
  Archive,
} from "lucide-react";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import { useConfirm } from "@/lib/use-dialog";
import { useAuthStore } from "@/lib/store";
import { Skeleton, SkeletonText, SkeletonCard } from "@/components/Skeleton";

interface TenantStats {
  userCount: number;
  patientCount: number;
  invoicesLast30Days: number;
  storageBytes: number;
  monthlyOpdVolume?: number;
  mrrInPaise?: number;
  billingHealth?: string;
  subscriptionStatus?: string | null;
  lastLoginAt?: string | null;
}

interface TenantDetail {
  id: string;
  name: string;
  subdomain: string;
  // Dynamic `PlatformPlan.key` (STARTER/GROWTH/ENTERPRISE or a custom slug).
  plan: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
  deactivatedAt: string | null;
  archivedAt: string | null;
  archiveS3Key: string | null;
  archiveSizeBytes: number | null;
  archiveChecksum: string | null;
  razorpayKeyId: string | null;
  razorpayMode: string | null;
  requireAdminTOTP: boolean;
  sessionIdleMinutes: number;
  featureFlags: Record<string, boolean> | null;
  stats: TenantStats;
  admins: Array<{
    id: string;
    email: string | null;
    name: string;
    isActive: boolean;
    createdAt: string;
  }>;
  config: Record<string, string>;
}

interface TenantConfigBundle {
  tenantId: string;
  defaultDoctorMode: string | null;
  abdm: {
    hfr: { facilityName?: string; hfrId?: string } | null;
    hpr: { hprId?: string; doctorName?: string } | null;
    checklist: Record<string, boolean> | null;
  };
  whatsapp: {
    provider: string;
    defaultProductId: string | null;
    autoReply: boolean;
    active: boolean;
    updatedAt: string;
  } | null;
  paymentGateway: {
    razorpay: { keyIdPrefix: string; mode: string | null } | null;
    cashfree: { mode: string; keyIdPrefix: string } | null;
    businessName: string | null;
  };
  steps: Record<string, string>;
}

const WIZARD_STEPS = [
  { key: "doctor_modes", label: "Doctor modes" },
  { key: "abdm", label: "ABDM HFR / HPR" },
  { key: "whatsapp", label: "WhatsApp Business" },
  { key: "payment_gateway", label: "Payment gateway" },
  // "Go-live" (SOW §8 step 8) is deferred — the onboarding wizard has no
  // go_live step to complete it (see onboarding/page.tsx header), so it would
  // always read "Not started". Omitted from the checklist until implemented.
];

function formatINR(paise: number | null | undefined): string {
  if (paise == null) return "—";
  return `₹${(paise / 100).toLocaleString("en-IN", {
    maximumFractionDigits: 0,
  })}`;
}

// Human-readable storage: scales the raw byte total to B / KB / MB / GB / TB so
// small tenants don't all read "0 MB". Picks the largest unit that keeps the
// value >= 1, with one decimal for KB and up (bytes show as a whole number).
function formatStorage(bytes: number | null | undefined): string {
  const b = Number(bytes);
  if (!Number.isFinite(b) || b <= 0) return "0 KB";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = b;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  // Bytes: whole number; KB and up: up to 1 decimal (trimmed if .0).
  const rounded = i === 0 ? Math.round(v) : Math.round(v * 10) / 10;
  return `${rounded} ${units[i]}`;
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("en-IN", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "—";
  }
}

export default function DashboardTenantDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const confirm = useConfirm();
  const { user } = useAuthStore();
  const tenantId = params?.id ?? "";

  const [tenant, setTenant] = useState<TenantDetail | null>(null);
  const [config, setConfig] = useState<TenantConfigBundle | null>(null);
  const [loading, setLoading] = useState(true);
  const [doctorModeBusy, setDoctorModeBusy] = useState(false);

  // Use primitive `userRole` for effect deps — `useAuthStore()` returns
  // a fresh state-object reference on every render, so depending on
  // `user` directly would re-fire the effect each render and hammer
  // the API in a loop (429 cascade).
  const userRole = user?.role;

  useEffect(() => {
    if (userRole && userRole !== "ADMIN") {
      router.replace("/dashboard");
    }
  }, [userRole, router]);

  const load = useCallback(async () => {
    if (!tenantId) return;
    setLoading(true);
    try {
      const [tRes, cRes] = await Promise.allSettled([
        api.get<{ data: TenantDetail }>(`/tenants/${tenantId}`),
        api.get<{ data: TenantConfigBundle }>(
          `/super-admin/tenants/${tenantId}/config`,
        ),
      ]);
      if (tRes.status === "fulfilled") {
        setTenant(tRes.value.data);
      } else {
        toast.error(
          (tRes.reason as { message?: string })?.message ??
            "Failed to load tenant",
        );
        setTenant(null);
      }
      if (cRes.status === "fulfilled") {
        setConfig(cRes.value.data);
      } else {
        setConfig(null);
      }
    } finally {
      setLoading(false);
    }
  }, [tenantId]);

  useEffect(() => {
    if (userRole === "ADMIN") void load();
  }, [load, userRole]);

  async function suspendTenant() {
    if (!tenant) return;
    const ok = await confirm({
      title: `Suspend tenant "${tenant.name}"?`,
      message:
        "Users won't be able to sign in. All active sessions will be signed out at their next refresh. You can restore later.",
      confirmLabel: "Suspend",
      danger: true,
    });
    if (!ok) return;
    try {
      await api.post(`/tenants/${tenant.id}/deactivate`);
      toast.success("Tenant suspended");
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    }
  }

  async function restoreTenant() {
    if (!tenant) return;
    const ok = await confirm({
      title: `Restore tenant "${tenant.name}"?`,
      message: "Users of this tenant will be able to sign in again.",
      confirmLabel: "Restore",
    });
    if (!ok) return;
    try {
      await api.post(`/tenants/${tenant.id}/restore`);
      toast.success("Tenant restored");
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    }
  }

  // Pearl §8.1 row 233 — manual archive. Suspended tenants are
  // auto-archived to S3 by the daily cron once they're 90 days old,
  // but the operator can trigger it earlier. `force=true` (advanced)
  // bypasses the 90-day floor — gated behind a stronger confirmation.
  async function archiveTenant(force: boolean) {
    if (!tenant) return;
    const ok = await confirm({
      title: force
        ? `Force-archive "${tenant.name}" now?`
        : `Archive "${tenant.name}"?`,
      message: force
        ? "This bypasses the 90-day waiting period and ships tenant data to S3 immediately. Use only when you understand the consequences."
        : "Suspended-tenant data is shipped to S3 cold storage. The live DB rows stay until you explicitly purge. This action is reversible only by restoring from S3.",
      confirmLabel: force ? "Force archive" : "Archive",
      danger: true,
    });
    if (!ok) return;
    try {
      const res = await api.post<{
        data: {
          archivedAt: string;
          archiveS3Key: string;
          archiveSizeBytes: number;
          rowCounts: Record<string, number>;
        };
      }>(`/super-admin/tenants/${tenant.id}/archive`, { force });
      toast.success(
        `Archived to ${res.data.archiveS3Key} (${Math.round(
          res.data.archiveSizeBytes / 1024,
        )} KB)`,
      );
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to archive");
    }
  }

  async function applyDoctorMode(mode: "CALLING" | "TOKEN" | "SLOT") {
    if (!tenant) return;
    setDoctorModeBusy(true);
    try {
      const res = await api.post<{
        data: { updatedDoctors: number; defaultMode: string };
      }>(`/super-admin/tenants/${tenant.id}/doctor-modes`, {
        defaultMode: mode,
        applyToExistingDoctors: true,
      });
      toast.success(
        `Default doctor mode set to ${mode} (${res.data.updatedDoctors} doctors updated)`,
      );
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    } finally {
      setDoctorModeBusy(false);
    }
  }

  if (user && user.role !== "ADMIN") return null;

  if (loading && !tenant) {
    return (
      <div data-testid="tenant-detail-loading" className="space-y-6">
        <Skeleton variant="text" width="8rem" />
        <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex-1 space-y-2">
            <Skeleton variant="text" width="40%" height={28} />
            <SkeletonText lines={1} />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Skeleton variant="rect" width={96} height={44} className="rounded-md" />
            <Skeleton variant="rect" width={120} height={44} className="rounded-md" />
          </div>
        </header>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} variant="rect" width="100%" height={64} className="rounded-lg" />
          ))}
        </div>
        <SkeletonCard />
        <SkeletonCard />
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
          <SkeletonCard />
          <SkeletonCard />
          <SkeletonCard />
        </div>
      </div>
    );
  }

  if (!tenant) {
    return (
      <div className="space-y-4 py-4">
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
    <div data-testid="tenant-detail-page" className="space-y-6">
      <div className="flex items-center gap-2">
        <Link
          href="/dashboard/tenants"
          className="inline-flex items-center gap-1 text-sm text-gray-600 hover:text-gray-900 dark:text-gray-300 dark:hover:text-gray-100"
        >
          <ArrowLeft size={14} aria-hidden="true" /> All tenants
        </Link>
      </div>

      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-3">
            <Building2 size={24} aria-hidden="true" />
            <h1 className="text-2xl font-semibold tracking-tight">
              {tenant.name}
            </h1>
            <span
              className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                tenant.active
                  ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-300"
                  : "bg-rose-100 text-rose-800 dark:bg-rose-900/50 dark:text-rose-300"
              }`}
              data-testid="tenant-detail-status"
            >
              {tenant.active ? "Active" : "Suspended"}
            </span>
            <span className="rounded-full bg-gray-200 px-2 py-0.5 text-xs font-semibold text-gray-800 dark:bg-gray-700 dark:text-gray-200">
              {tenant.plan}
            </span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-gray-500 dark:text-gray-400">
            {tenant.config?.code && (
              <>
                <span
                  data-testid="tenant-detail-code"
                  className="whitespace-nowrap rounded bg-slate-100 px-2 py-0.5 font-mono font-semibold text-slate-700 dark:bg-slate-700 dark:text-slate-200"
                >
                  {tenant.config.code}
                </span>
                <span>•</span>
              </>
            )}
            <span className="font-mono">{tenant.subdomain}</span>
            {tenant.config?.region && (
              <>
                <span>•</span>
                <span data-testid="tenant-detail-region">
                  {tenant.config.region}
                </span>
              </>
            )}
            <span>•</span>
            <span>Created {formatDate(tenant.createdAt)}</span>
            {tenant.archivedAt && (
              <>
                <span>•</span>
                <span className="text-rose-600 dark:text-rose-400">
                  Archived {formatDate(tenant.archivedAt)}
                </span>
              </>
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            data-testid="tenant-detail-refresh"
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
          <Link
            href={`/dashboard/tenants/${tenant.id}/config`}
            data-testid="tenant-detail-config-link"
            className="inline-flex h-11 items-center gap-1 rounded-md border border-gray-300 bg-white px-3 text-xs font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
          >
            <Settings size={14} aria-hidden="true" />
            Feature flags
          </Link>
          <Link
            href={`/dashboard/tenants/${tenant.id}/onboarding`}
            className="inline-flex h-11 items-center gap-1 rounded-md border border-gray-300 bg-white px-3 text-xs font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
          >
            Onboarding
          </Link>
          {tenant.active ? (
            <button
              type="button"
              data-testid="tenant-detail-suspend"
              disabled={tenant.subdomain === "default"}
              onClick={() => void suspendTenant()}
              className="inline-flex h-11 items-center gap-1 rounded-md border border-rose-300 bg-white px-3 text-xs font-medium text-rose-700 hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-rose-800 dark:bg-gray-800 dark:text-rose-400 dark:hover:bg-rose-950/40"
              title={
                tenant.subdomain === "default"
                  ? "Cannot suspend the default tenant"
                  : "Suspend tenant"
              }
            >
              <Pause size={14} aria-hidden="true" />
              Suspend
            </button>
          ) : (
            <>
              <button
                type="button"
                data-testid="tenant-detail-restore"
                onClick={() => void restoreTenant()}
                className="inline-flex h-11 items-center gap-1 rounded-md border border-emerald-300 bg-white px-3 text-xs font-medium text-emerald-700 hover:bg-emerald-50 dark:border-emerald-800 dark:bg-gray-800 dark:text-emerald-400 dark:hover:bg-emerald-950/40"
              >
                <Play size={14} aria-hidden="true" />
                Restore
              </button>
              {/* Pearl §8.1 row 233 — manual archive. Visible only on
                  suspended (not active, not yet archived) tenants. */}
              {!tenant.archivedAt && (
                <button
                  type="button"
                  data-testid="tenant-detail-archive"
                  onClick={() => void archiveTenant(false)}
                  className="inline-flex h-11 items-center gap-1 rounded-md border border-slate-300 bg-white px-3 text-xs font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-600 dark:bg-gray-800 dark:text-slate-200 dark:hover:bg-gray-700"
                  title="Ship tenant data to S3 cold storage"
                >
                  <Archive size={14} aria-hidden="true" />
                  Archive now
                </button>
              )}
            </>
          )}
        </div>
      </header>

      {/* Stats grid */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Users" value={String(tenant.stats.userCount)} />
        <Stat label="Patients" value={String(tenant.stats.patientCount)} />
        <Stat
          label="Monthly OPD"
          value={String(tenant.stats.monthlyOpdVolume ?? 0)}
        />
        <Stat label="MRR" value={formatINR(tenant.stats.mrrInPaise)} />
        <Stat
          label="Invoices (30d)"
          value={String(tenant.stats.invoicesLast30Days)}
        />
        <Stat
          label="Storage"
          value={formatStorage(tenant.stats.storageBytes)}
        />
        <Stat label="Billing" value={tenant.stats.billingHealth ?? "—"} />
        <Stat
          label="Last login"
          value={formatDate(tenant.stats.lastLoginAt)}
        />
      </div>

      {/* Pearl §8.1 row 233 — suspend/archive lifecycle card. Visible
          only when the tenant has been suspended; shows the countdown
          to auto-archival (or the archive metadata if already archived). */}
      {!tenant.active && (
        <ArchiveLifecycleCard
          tenant={tenant}
          onArchive={() => void archiveTenant(false)}
          onForceArchive={() => void archiveTenant(true)}
        />
      )}

      {/* Onboarding checklist */}
      <section
        data-testid="tenant-detail-checklist"
        className="rounded-xl bg-white p-4 shadow-sm dark:bg-gray-800"
      >
        <h2 className="mb-3 text-base font-semibold">Onboarding checklist</h2>
        <ul className="space-y-2 text-sm">
          {WIZARD_STEPS.map((step) => {
            const completedAt = config?.steps?.[step.key];
            return (
              <li
                key={step.key}
                data-testid={`checklist-${step.key}`}
                className="flex items-center justify-between gap-2 rounded-md border border-gray-100 px-3 py-2 dark:border-gray-700"
              >
                <span className="flex items-center gap-2">
                  {completedAt ? (
                    <CheckCircle2
                      size={16}
                      className="text-emerald-600 dark:text-emerald-400"
                      aria-hidden="true"
                    />
                  ) : (
                    <XCircle
                      size={16}
                      className="text-gray-300 dark:text-gray-600"
                      aria-hidden="true"
                    />
                  )}
                  <span
                    className={
                      completedAt
                        ? "text-gray-900 dark:text-gray-100"
                        : "text-gray-500 dark:text-gray-400"
                    }
                  >
                    {step.label}
                  </span>
                </span>
                <span className="text-xs text-gray-500 dark:text-gray-400">
                  {completedAt ? formatDate(completedAt) : "Not started"}
                </span>
              </li>
            );
          })}
        </ul>
      </section>

      {/* Doctor modes */}
      <section
        data-testid="tenant-detail-doctor-modes"
        className="rounded-xl bg-white p-4 shadow-sm dark:bg-gray-800"
      >
        <div className="mb-3 flex items-center gap-2">
          <Stethoscope size={16} aria-hidden="true" />
          <h2 className="text-base font-semibold">Default doctor mode</h2>
        </div>
        <p className="mb-3 text-xs text-gray-600 dark:text-gray-400">
          Current default:{" "}
          <span className="font-mono">
            {config?.defaultDoctorMode ?? "TOKEN (system default)"}
          </span>
          . Changing this also updates every doctor in the tenant.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {(["CALLING", "TOKEN", "SLOT"] as const).map((m) => (
            <button
              key={m}
              type="button"
              data-testid={`tenant-detail-set-mode-${m.toLowerCase()}`}
              disabled={doctorModeBusy}
              onClick={() => void applyDoctorMode(m)}
              className={`h-10 rounded-md border px-4 text-xs font-medium disabled:opacity-50 ${
                config?.defaultDoctorMode === m
                  ? "border-emerald-500 bg-emerald-50 text-emerald-700 dark:border-emerald-500 dark:bg-emerald-950/40 dark:text-emerald-300"
                  : "border-gray-300 bg-white text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
              }`}
            >
              {m}
            </button>
          ))}
        </div>
      </section>

      {/* Integrations */}
      <section className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        <IntegrationCard
          testId="tenant-detail-whatsapp"
          icon={<MessageSquare size={16} aria-hidden="true" />}
          title="WhatsApp"
          rows={
            config?.whatsapp
              ? [
                  ["Provider", config.whatsapp.provider],
                  ["Auto reply", config.whatsapp.autoReply ? "On" : "Off"],
                  ["Active", config.whatsapp.active ? "Yes" : "No"],
                  ["Updated", formatDate(config.whatsapp.updatedAt)],
                ]
              : [["", "Not configured"]]
          }
        />
        <IntegrationCard
          testId="tenant-detail-razorpay"
          icon={<CreditCard size={16} aria-hidden="true" />}
          title="Razorpay"
          rows={
            tenant.razorpayKeyId
              ? [
                  ["Key ID", tenant.razorpayKeyId.slice(0, 12) + "…"],
                  ["Mode", tenant.razorpayMode ?? "—"],
                  [
                    "Business",
                    config?.paymentGateway?.businessName ?? tenant.name,
                  ],
                ]
              : [["", "Not configured"]]
          }
        />
        <IntegrationCard
          testId="tenant-detail-abdm"
          icon={<ShieldCheck size={16} aria-hidden="true" />}
          title="ABDM"
          rows={
            config?.abdm?.hfr || config?.abdm?.hpr
              ? [
                  ["HFR", config?.abdm?.hfr?.hfrId ?? "—"],
                  ["HPR", config?.abdm?.hpr?.hprId ?? "—"],
                  ["Facility", config?.abdm?.hfr?.facilityName ?? "—"],
                ]
              : [["", "Not configured"]]
          }
        />
      </section>

      {/* Admin roster */}
      <section
        data-testid="tenant-detail-admins"
        className="rounded-xl bg-white p-4 shadow-sm dark:bg-gray-800"
      >
        <h2 className="mb-3 text-base font-semibold">Admin users</h2>
        {tenant.admins.length === 0 ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">No admin users yet.</p>
        ) : (
          <ul className="space-y-2 text-sm">
            {tenant.admins.map((a) => (
              <li
                key={a.id}
                className="flex items-center justify-between gap-2 rounded-md border border-gray-100 px-3 py-2 dark:border-gray-700"
              >
                <div>
                  <div className="font-medium text-gray-900 dark:text-gray-100">{a.name}</div>
                  <div className="text-xs text-gray-500 dark:text-gray-400">{a.email ?? "—"}</div>
                </div>
                <span
                  className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                    a.isActive
                      ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-300"
                      : "bg-gray-200 text-gray-700 dark:bg-gray-700 dark:text-gray-300"
                  }`}
                >
                  {a.isActive ? "Active" : "Disabled"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

// Pearl §8.1 row 233 — archive lifecycle card. Three visual states:
//   1. Suspended, not yet archived, <90 days since deactivatedAt:
//      shows countdown + "Archive now" CTA + advanced "Force archive".
//   2. Suspended, eligible (>=90 days): same UI but the CTA is the
//      primary action (operator should have archived already).
//   3. Already archived: shows the S3 key + size + checksum + date.
function ArchiveLifecycleCard(props: {
  tenant: TenantDetail;
  onArchive: () => void;
  onForceArchive: () => void;
}) {
  const { tenant, onArchive, onForceArchive } = props;
  const ARCHIVE_FLOOR_DAYS = 90;

  if (tenant.archivedAt) {
    const sizeKB = tenant.archiveSizeBytes
      ? Math.round(tenant.archiveSizeBytes / 1024)
      : null;
    return (
      <section
        data-testid="tenant-detail-archive-card"
        data-archive-state="archived"
        className="rounded-xl border border-slate-300 bg-slate-50 p-4 shadow-sm dark:border-slate-700 dark:bg-slate-900/40"
      >
        <div className="mb-3 flex items-center gap-2">
          <Archive size={16} aria-hidden="true" />
          <h2 className="text-base font-semibold">Archived to S3</h2>
          <span className="rounded-full bg-slate-300 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-800 dark:bg-slate-600 dark:text-slate-100">
            Archived
          </span>
        </div>
        <dl className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-xs text-gray-500 dark:text-gray-400">Archived at</dt>
            <dd className="font-medium">
              {formatDate(tenant.archivedAt)}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-gray-500 dark:text-gray-400">Size</dt>
            <dd className="font-medium">{sizeKB ? `${sizeKB} KB` : "—"}</dd>
          </div>
          <div className="sm:col-span-2">
            <dt className="text-xs text-gray-500 dark:text-gray-400">S3 key</dt>
            <dd className="break-all font-mono text-xs">
              {tenant.archiveS3Key ?? "—"}
            </dd>
          </div>
          <div className="sm:col-span-2">
            <dt className="text-xs text-gray-500 dark:text-gray-400">SHA-256 checksum</dt>
            <dd className="break-all font-mono text-[10px]">
              {tenant.archiveChecksum ?? "—"}
            </dd>
          </div>
        </dl>
        <p className="mt-3 text-xs text-gray-600 dark:text-gray-400">
          The live DB rows for this tenant still exist. Purge is a separate
          operator action and not auto-wired.
        </p>
      </section>
    );
  }

  // Suspended but not archived — show countdown + archive CTA.
  const deactivatedAt = tenant.deactivatedAt
    ? new Date(tenant.deactivatedAt).getTime()
    : null;
  const daysSinceSuspend = deactivatedAt
    ? Math.floor((Date.now() - deactivatedAt) / (24 * 60 * 60 * 1000))
    : 0;
  const daysUntilArchive = Math.max(0, ARCHIVE_FLOOR_DAYS - daysSinceSuspend);
  const eligible = daysUntilArchive === 0;

  return (
    <section
      data-testid="tenant-detail-archive-card"
      data-archive-state={eligible ? "eligible" : "pending"}
      className="rounded-xl border border-amber-200 bg-amber-50 p-4 shadow-sm dark:border-amber-800 dark:bg-amber-950/30"
    >
      <div className="mb-3 flex items-center gap-2">
        <Archive size={16} className="text-amber-700 dark:text-amber-400" aria-hidden="true" />
        <h2 className="text-base font-semibold text-amber-900 dark:text-amber-200">
          {eligible ? "Eligible for archive" : "Pending archive"}
        </h2>
      </div>
      <dl className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-3">
        <div>
          <dt className="text-xs text-amber-800 dark:text-amber-300">Suspended on</dt>
          <dd className="font-medium text-gray-900">
            {formatDate(tenant.deactivatedAt)}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-amber-800 dark:text-amber-300">Days since suspend</dt>
          <dd
            className="font-medium text-gray-900 dark:text-gray-100"
            data-testid="tenant-detail-archive-days-since"
          >
            {daysSinceSuspend}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-amber-800 dark:text-amber-300">Auto-archive in</dt>
          <dd
            className="font-medium text-gray-900 dark:text-gray-100"
            data-testid="tenant-detail-archive-days-until"
          >
            {eligible
              ? "Eligible now"
              : `${daysUntilArchive} day${daysUntilArchive === 1 ? "" : "s"}`}
          </dd>
        </div>
      </dl>
      <p className="mt-3 text-xs text-amber-900 dark:text-amber-200">
        {eligible
          ? "This tenant has passed the 90-day suspension floor — the daily 04:00 UTC cron will archive it automatically on the next run, or you can archive it now."
          : "Suspended tenants are auto-archived to S3 cold storage after 90 days. Restore re-enables logins; archive ships the data and clears live rows."}
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          data-testid="tenant-detail-archive-now"
          onClick={onArchive}
          disabled={!eligible}
          className="inline-flex h-10 items-center gap-1 rounded-md bg-slate-900 px-3 text-xs font-medium text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
          title={
            eligible
              ? "Archive this tenant to S3 now"
              : `Available after ${daysUntilArchive} more days`
          }
        >
          <Archive size={14} aria-hidden="true" />
          Archive now
        </button>
        {!eligible && (
          <button
            type="button"
            data-testid="tenant-detail-archive-force"
            onClick={onForceArchive}
            className="inline-flex h-10 items-center gap-1 rounded-md border border-rose-300 bg-white px-3 text-xs font-medium text-rose-700 hover:bg-rose-50 dark:border-rose-800 dark:bg-gray-800 dark:text-rose-400 dark:hover:bg-rose-950/40"
            title="Bypass the 90-day floor — use sparingly"
          >
            Force archive
          </button>
        )}
      </div>
    </section>
  );
}

function Stat(props: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-white p-3 shadow-sm dark:bg-gray-800">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
        {props.label}
      </div>
      <div className="mt-1 text-base font-semibold text-gray-900 dark:text-gray-100">
        {props.value}
      </div>
    </div>
  );
}

function IntegrationCard(props: {
  testId: string;
  icon: React.ReactNode;
  title: string;
  rows: Array<[string, string]>;
}) {
  return (
    <div
      data-testid={props.testId}
      className="rounded-xl bg-white p-4 shadow-sm dark:bg-gray-800"
    >
      <div className="mb-2 flex items-center gap-2">
        {props.icon}
        <h3 className="text-sm font-semibold">{props.title}</h3>
      </div>
      <dl className="space-y-1 text-xs">
        {props.rows.map(([k, v], i) => (
          <div key={i} className="flex gap-2">
            {k ? (
              <dt className="min-w-[5rem] font-medium text-gray-500 dark:text-gray-400">{k}</dt>
            ) : null}
            <dd className="text-gray-800 dark:text-gray-200">{v || "—"}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
