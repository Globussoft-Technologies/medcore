// Super-admin detail + permission editor — Pearl ERP Stage 1 §8.2.
//
// Surfaces:
//   - identity (name, email, phone, created)
//   - 2FA enrolment status
//   - granular permission toggles (saved via PUT /:id/permissions)
//   - last login timestamp
//   - in-page activate / deactivate (reuses the same PATCH path the
//     list page uses)
//
// Auth: relies on the /super-admin layout's super-admin gate.

"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  ArrowLeft,
  ShieldCheck,
  Smartphone,
  KeyRound,
  CheckCircle2,
  XCircle,
  RefreshCw,
  Save,
  Power,
  PowerOff,
} from "lucide-react";
import { csrfFetch } from "@/lib/csrf-fetch";

interface PermissionsState {
  canManageTenants?: boolean;
  canOnboardTenant?: boolean;
  canViewBilling?: boolean;
  canTriggerJobs?: boolean;
  canDpdpWorkbench?: boolean;
  canViewAudit?: boolean;
  tenantScope?: string[];
  moduleScope?: string[];
}

interface SuperAdminDetail {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  role: string;
  isActive: boolean;
  twoFactorEnabled: boolean;
  tenantId: string | null;
  createdAt: string;
  permissions: PermissionsState;
  lastLoginAt: string | null;
}

const PERMISSION_OPTIONS: Array<{
  key: keyof Omit<PermissionsState, "tenantScope" | "moduleScope">;
  label: string;
  description: string;
}> = [
  {
    key: "canManageTenants",
    label: "Manage tenants",
    description: "Suspend / restore / archive tenants",
  },
  {
    key: "canOnboardTenant",
    label: "Onboard tenant",
    description: "Run the 8-step tenant onboarding wizard",
  },
  {
    key: "canViewBilling",
    label: "View billing",
    description: "Platform billing dashboard + invoices",
  },
  {
    key: "canTriggerJobs",
    label: "Trigger jobs",
    description: "Retry failed crons, manual archival",
  },
  {
    key: "canDpdpWorkbench",
    label: "DPDP workbench",
    description: "Execute right-to-erasure requests",
  },
  {
    key: "canViewAudit",
    label: "View audit trail",
    description: "Read the super-admin audit log",
  },
];

function formatDate(iso: string | null): string {
  if (!iso) return "Never";
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

export default function SuperAdminDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id ?? "";

  const [user, setUser] = useState<SuperAdminDetail | null>(null);
  const [permissions, setPermissions] = useState<PermissionsState>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [toggleBusy, setToggleBusy] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      const res = await csrfFetch(`/api/v1/super-admin/users/${id}`);
      const body = await res.json();
      if (!res.ok || !body.success) {
        setError(body.error ?? `Failed (HTTP ${res.status})`);
        setUser(null);
        return;
      }
      setUser(body.data);
      setPermissions(body.data.permissions ?? {});
      setDirty(false);
    } catch (err) {
      setError(
        `Network error: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  function setFlag(
    key: keyof Omit<PermissionsState, "tenantScope" | "moduleScope">,
    value: boolean,
  ) {
    setDirty(true);
    setPermissions((prev) => ({ ...prev, [key]: value }));
  }

  async function savePermissions() {
    if (!user) return;
    setSaving(true);
    setError(null);
    setSavedAt(null);
    try {
      const res = await csrfFetch(
        `/api/v1/super-admin/users/${user.id}/permissions`,
        {
          method: "PUT",
          body: JSON.stringify(permissions),
        },
      );
      const body = await res.json();
      if (!res.ok || !body.success) {
        setError(body.error ?? `Failed (HTTP ${res.status})`);
        return;
      }
      setSavedAt(new Date().toISOString());
      setDirty(false);
      await load();
    } catch (err) {
      setError(
        `Network error: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setSaving(false);
    }
  }

  async function toggleActive() {
    if (!user) return;
    setToggleBusy(true);
    setError(null);
    try {
      const res = await csrfFetch(`/api/v1/super-admin/users/${user.id}`, {
        method: "PATCH",
        body: JSON.stringify({ active: !user.isActive }),
      });
      const body = await res.json();
      if (!res.ok || !body.success) {
        setError(body.error ?? `Failed (HTTP ${res.status})`);
        return;
      }
      await load();
    } catch (err) {
      setError(
        `Network error: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setToggleBusy(false);
    }
  }

  if (loading && !user) {
    return (
      <div className="py-12 text-center text-sm text-slate-500">Loading…</div>
    );
  }

  if (!user) {
    return (
      <section className="space-y-4 py-4">
        <Link
          href="/super-admin/users"
          className="inline-flex items-center gap-1 text-sm text-slate-600 hover:text-slate-900"
        >
          <ArrowLeft size={14} aria-hidden="true" /> All super-admins
        </Link>
        <div className="rounded-md border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
          {error ?? "Super-admin not found."}
        </div>
      </section>
    );
  }

  return (
    <section
      data-testid="super-admin-detail"
      className="mx-auto max-w-3xl space-y-6 py-4"
    >
      <Link
        href="/super-admin/users"
        className="inline-flex items-center gap-1 text-sm text-slate-600 hover:text-slate-900"
      >
        <ArrowLeft size={14} aria-hidden="true" /> All super-admins
      </Link>

      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <ShieldCheck size={22} aria-hidden="true" />
            {user.name}
          </h1>
          <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-slate-500">
            <span className="font-mono">{user.email ?? "—"}</span>
            {user.phone && (
              <>
                <span>•</span>
                <span>{user.phone}</span>
              </>
            )}
            <span>•</span>
            <span>Created {formatDate(user.createdAt)}</span>
            <span>•</span>
            <span>Last login {formatDate(user.lastLoginAt)}</span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            data-testid="super-admin-detail-refresh"
            onClick={() => void load()}
            className="inline-flex h-11 items-center gap-1 rounded-md border border-slate-300 bg-white px-3 text-xs font-medium text-slate-700 hover:bg-slate-50"
          >
            <RefreshCw size={14} aria-hidden="true" />
            Refresh
          </button>
          <button
            type="button"
            data-testid="super-admin-detail-toggle"
            disabled={toggleBusy}
            onClick={() => void toggleActive()}
            className={`inline-flex h-11 items-center gap-1 rounded-md border px-3 text-xs font-medium disabled:opacity-50 ${
              user.isActive
                ? "border-rose-300 bg-white text-rose-700 hover:bg-rose-50"
                : "border-emerald-300 bg-white text-emerald-700 hover:bg-emerald-50"
            }`}
          >
            {user.isActive ? (
              <>
                <PowerOff size={14} aria-hidden="true" /> Deactivate
              </>
            ) : (
              <>
                <Power size={14} aria-hidden="true" /> Reactivate
              </>
            )}
          </button>
        </div>
      </header>

      {error && (
        <div
          role="alert"
          className="rounded-md border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800"
        >
          {error}
        </div>
      )}

      {/* Status cards */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="rounded-lg border border-slate-200 bg-white p-3 shadow-sm">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
            Status
          </div>
          <div className="mt-1 flex items-center gap-2 text-base font-semibold">
            {user.isActive ? (
              <>
                <CheckCircle2 size={16} className="text-emerald-600" />
                <span className="text-emerald-700">Active</span>
              </>
            ) : (
              <>
                <XCircle size={16} className="text-slate-400" />
                <span className="text-slate-500">Deactivated</span>
              </>
            )}
          </div>
        </div>
        <div className="rounded-lg border border-slate-200 bg-white p-3 shadow-sm">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
            Two-factor
          </div>
          <div className="mt-1 flex items-center gap-2 text-base font-semibold">
            {user.twoFactorEnabled ? (
              <>
                <Smartphone size={16} className="text-emerald-600" />
                <span className="text-emerald-700">Enrolled</span>
              </>
            ) : (
              <>
                <KeyRound size={16} className="text-amber-600" />
                <span className="text-amber-700">Required</span>
              </>
            )}
          </div>
        </div>
        <div className="rounded-lg border border-slate-200 bg-white p-3 shadow-sm">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
            Scope
          </div>
          <div className="mt-1 text-base font-semibold text-slate-900">
            {user.tenantId === null ? "Cross-tenant" : "Tenant-bound"}
          </div>
        </div>
      </div>

      {/* Permission editor */}
      <section
        data-testid="super-admin-detail-permissions"
        className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm"
      >
        <div className="mb-4 flex items-center justify-between gap-2">
          <div>
            <h2 className="text-base font-semibold">Permission grants</h2>
            <p className="text-xs text-slate-500">
              Check the surfaces this super-admin can access.
            </p>
          </div>
          <button
            type="button"
            data-testid="super-admin-detail-save"
            disabled={saving || !dirty}
            onClick={() => void savePermissions()}
            className="inline-flex h-10 items-center gap-1 rounded-md bg-emerald-700 px-3 text-xs font-medium text-white hover:bg-emerald-800 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Save size={14} aria-hidden="true" />
            {saving ? "Saving…" : "Save"}
          </button>
        </div>

        {savedAt && (
          <div
            data-testid="super-admin-detail-saved"
            role="status"
            className="mb-3 flex items-center gap-2 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800"
          >
            <CheckCircle2 size={14} aria-hidden="true" /> Permissions saved.
          </div>
        )}

        {dirty && (
          <div
            data-testid="super-admin-detail-dirty"
            role="status"
            className="mb-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900"
          >
            Unsaved changes — click <strong>Save</strong> to persist.
          </div>
        )}

        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {PERMISSION_OPTIONS.map((opt) => (
            <label
              key={opt.key}
              className="flex items-start gap-3 rounded-md border border-slate-100 px-3 py-2 text-sm hover:bg-slate-50"
            >
              <input
                type="checkbox"
                data-testid={`super-admin-detail-perm-${opt.key}`}
                checked={!!permissions[opt.key]}
                onChange={(e) => setFlag(opt.key, e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-slate-300"
              />
              <span>
                <span className="font-medium text-slate-900">{opt.label}</span>
                <span className="mt-0.5 block text-xs text-slate-500">
                  {opt.description}
                </span>
              </span>
            </label>
          ))}
        </div>
      </section>
    </section>
  );
}
