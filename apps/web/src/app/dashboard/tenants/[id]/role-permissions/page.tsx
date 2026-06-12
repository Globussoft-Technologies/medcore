"use client";

/**
 * Per-tenant role → permission catalog (Pearl §8.1 wizard step 3).
 *
 * Surfaced by the tenant onboarding step "Review default permissions &
 * roles". The catalog is fetched from /api/v1/tenants/:id/role-permissions
 * which reads the relational `role_catalog_entries` + `role_permission_items`
 * tables (initial 10 roles inserted by the migration
 * `20260530000001_add_role_permissions`). Edits flow through the same
 * endpoints — POST appends, DELETE removes — and update those rows
 * directly. No JSON blob, no in-process constant fallback.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import {
  ArrowLeft,
  Check,
  Pencil,
  Plus,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Stethoscope,
  HeartPulse,
  UserPlus,
  Pill,
  FlaskConical,
  Receipt,
  Building2,
  CreditCard,
  X,
  type LucideIcon,
} from "lucide-react";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import { useAuthStore } from "@/lib/store";
import { useTranslation } from "@/lib/i18n";
import { useConfirm } from "@/lib/use-dialog";
import { SkeletonCard } from "@/components/Skeleton";

interface RolePermissionEntry {
  role: string;
  label: string;
  summary: string;
  permissions: string[];
}

// Per-role visual identity. Colours mirror the chip palette already used on
// /dashboard/users (page.tsx:517-529) so a user staring at "ADMIN" on both
// surfaces sees the same purple; the icon column is the only new affordance.
// Missing roles in the catalog fall through to the gray Shield default.
interface RoleVisual {
  icon: LucideIcon;
  /** Tailwind classes for the rounded icon tile background + foreground. */
  iconWrap: string;
  /** Tailwind classes for the small enum chip next to the role label. */
  badge: string;
}

const ROLE_VISUALS: Record<string, RoleVisual> = {
  ADMIN: {
    icon: ShieldAlert,
    iconWrap: "bg-purple-100 text-purple-700 dark:bg-purple-950/50 dark:text-purple-300",
    badge: "bg-purple-100 text-purple-700 dark:bg-purple-950/50 dark:text-purple-300",
  },
  DOCTOR: {
    icon: Stethoscope,
    iconWrap: "bg-blue-100 text-blue-700 dark:bg-blue-950/50 dark:text-blue-300",
    badge: "bg-blue-100 text-blue-700 dark:bg-blue-950/50 dark:text-blue-300",
  },
  NURSE: {
    icon: HeartPulse,
    iconWrap: "bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300",
    badge: "bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300",
  },
  RECEPTION: {
    icon: UserPlus,
    iconWrap: "bg-green-100 text-green-700 dark:bg-green-950/50 dark:text-green-300",
    badge: "bg-green-100 text-green-700 dark:bg-green-950/50 dark:text-green-300",
  },
  PHARMACIST: {
    icon: Pill,
    iconWrap: "bg-teal-100 text-teal-700 dark:bg-teal-950/50 dark:text-teal-300",
    badge: "bg-teal-100 text-teal-700 dark:bg-teal-950/50 dark:text-teal-300",
  },
  LAB_TECH: {
    icon: FlaskConical,
    iconWrap: "bg-rose-100 text-rose-700 dark:bg-rose-950/50 dark:text-rose-300",
    badge: "bg-rose-100 text-rose-700 dark:bg-rose-950/50 dark:text-rose-300",
  },
  BILLING: {
    icon: Receipt,
    iconWrap: "bg-orange-100 text-orange-700 dark:bg-orange-950/50 dark:text-orange-300",
    badge: "bg-orange-100 text-orange-700 dark:bg-orange-950/50 dark:text-orange-300",
  },
  PLATFORM_OPERATOR: {
    icon: Building2,
    iconWrap: "bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-200",
    badge: "bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-200",
  },
  PLATFORM_BILLING_OPERATOR: {
    icon: CreditCard,
    iconWrap: "bg-orange-100 text-orange-800 dark:bg-orange-950/50 dark:text-orange-200",
    badge: "bg-orange-100 text-orange-800 dark:bg-orange-950/50 dark:text-orange-200",
  },
  SUPER_ADMIN: {
    icon: ShieldCheck,
    iconWrap: "bg-indigo-100 text-indigo-700 dark:bg-indigo-950/50 dark:text-indigo-300",
    badge: "bg-indigo-100 text-indigo-700 dark:bg-indigo-950/50 dark:text-indigo-300",
  },
};

const FALLBACK_VISUAL: RoleVisual = {
  icon: Shield,
  iconWrap: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300",
  badge: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300",
};

interface CatalogResponse {
  data: {
    tenantId: string;
    roles: RolePermissionEntry[];
  };
}

interface TenantDetail {
  id: string;
  name: string;
  subdomain: string;
}

export default function RolePermissionsPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { user } = useAuthStore();
  const { t } = useTranslation();
  const tenantId = params.id;
  // `?from=tenants` — sent by the "Permissions catalog" entry on the
  // /dashboard/tenants list page. When present, the Back link returns to
  // the tenants list instead of the per-tenant onboarding checklist
  // (which is the default and what the onboarding step deep-links into).
  const searchParams = useSearchParams();
  const fromTenantsList = searchParams?.get("from") === "tenants";
  const backHref = fromTenantsList
    ? "/dashboard/tenants"
    : `/dashboard/tenants/${tenantId}/onboarding`;
  const backLabel = fromTenantsList
    ? t("rolePermissions.backToTenants", "Back to tenants")
    : t("rolePermissions.back", "Back to onboarding");

  // VIEW vs EDIT split.
  //   - VIEW: any ADMIN or SUPER_ADMIN can review the catalog.
  //   - EDIT: only SUPER_ADMIN, AND only when reached via the global
  //     `/dashboard/tenants → Permissions catalog` entry (which appends
  //     `?from=tenants`). The same page reached from the onboarding
  //     step is a read-only review surface — operators going through
  //     onboarding shouldn't see Edit / Add / × controls. The backend
  //     also enforces the SUPER_ADMIN gate so disabling the UI is a
  //     UX nicety, not a security boundary.
  //
  // IMPORTANT — the auth store coerces SUPER_ADMIN → role="ADMIN" so the
  // ~100 inline `user.role === "ADMIN"` checks across the dashboard work
  // for super admins automatically (see lib/store.ts:coerceUser). The DB
  // value lives on `user.actualRole`, so any check that genuinely needs
  // to distinguish ADMIN from SUPER_ADMIN must read from there.
  const effectiveRole = user?.actualRole ?? user?.role;
  const canView = effectiveRole === "ADMIN" || effectiveRole === "SUPER_ADMIN";
  // canEdit folds in `fromTenantsList`: the catalog is mutable only when
  // entered from the Tenants list, not from a tenant's onboarding flow.
  const canEdit = effectiveRole === "SUPER_ADMIN" && fromTenantsList;
  const confirm = useConfirm();

  const [catalog, setCatalog] = useState<RolePermissionEntry[]>([]);
  const [detail, setDetail] = useState<TenantDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  // Per-role text being typed into the "Add permission" input. Indexed by
  // role enum string so the inputs stay isolated across cards.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  // Dirty-draft model — clicking the × marks an existing permission for
  // deletion, clicking "+ Add" queues a new permission. Nothing hits the
  // DB until Save fires. The user-asked-for-it shape (see chat 2026-05-30).
  // pendingDeleteKeys uses `"ROLE:idx"` so the same index across roles
  // doesn't collide.
  const [pendingAdds, setPendingAdds] = useState<Record<string, string[]>>({});
  const [pendingDeleteKeys, setPendingDeleteKeys] = useState<Set<string>>(
    () => new Set(),
  );
  const [saving, setSaving] = useState(false);
  // "+ Add new role" modal state — the modal renders over the catalog
  // when `showAddRole` is true. Save runs immediately (not deferred)
  // because creating a role is an explicit one-shot action. The modal
  // can optionally seed initial permission rows so the role is
  // populated in one round-trip.
  const [showAddRole, setShowAddRole] = useState(false);
  const [newRoleName, setNewRoleName] = useState("");
  const [newRoleLabel, setNewRoleLabel] = useState("");
  const [newRoleSummary, setNewRoleSummary] = useState("");
  const [newRolePermissions, setNewRolePermissions] = useState<string[]>([]);
  const [newRolePermissionDraft, setNewRolePermissionDraft] = useState("");
  const [creatingRole, setCreatingRole] = useState(false);

  function resetAddRoleForm() {
    setNewRoleName("");
    setNewRoleLabel("");
    setNewRoleSummary("");
    setNewRolePermissions([]);
    setNewRolePermissionDraft("");
  }

  function queueNewRolePermission() {
    const draft = newRolePermissionDraft.trim();
    if (!draft) return;
    if (draft.length > 200) {
      toast.error(
        t(
          "rolePermissions.permTooLong",
          "Permission must be 200 characters or fewer",
        ),
      );
      return;
    }
    if (newRolePermissions.includes(draft)) {
      setNewRolePermissionDraft("");
      return;
    }
    setNewRolePermissions((prev) => [...prev, draft]);
    setNewRolePermissionDraft("");
  }

  function unqueueNewRolePermission(idx: number) {
    setNewRolePermissions((prev) => prev.filter((_, i) => i !== idx));
  }

  useEffect(() => {
    if (user && !canView) router.push("/dashboard");
  }, [user, canView, router]);

  const load = useCallback(async () => {
    if (!tenantId) return;
    setLoading(true);
    setLoadError(null);
    try {
      // GET /api/v1/role-permissions — global catalog endpoint. The tenant
      // detail fetch is ONLY for the header chip in the per-tenant (onboarding)
      // flow; in the global flow (?from=tenants) the chip is hidden, so we skip
      // it entirely — that's what lets the catalog open with zero tenants / a
      // "catalog" sentinel id without the detail call 404ing the whole load.
      const catRes = await api.get<CatalogResponse>(`/role-permissions`);
      setCatalog(catRes.data.roles || []);
      if (!fromTenantsList) {
        const detailRes = await api
          .get<{ data: TenantDetail }>(`/tenants/${tenantId}`)
          .catch(() => null);
        if (detailRes) setDetail(detailRes.data);
      }
    } catch (err) {
      // Preserve the server message so the page can render an
      // actionable error rather than a misleading "empty catalog"
      // panel when the GET itself failed (e.g. stale Prisma client
      // on the API server, missing migration, DB connection down).
      const msg =
        err instanceof Error ? err.message : "Failed to load role permissions";
      setLoadError(msg);
      toast.error(msg);
    }
    setLoading(false);
  }, [tenantId, fromTenantsList]);

  useEffect(() => {
    if (canView) load();
  }, [load, canView]);

  // ─── Dirty-draft handlers (no API calls until Save) ─────────────────
  // queueAdd / queueDelete only touch local state. The actual POST/DELETE
  // fires in saveChanges() below.

  function queueAdd(role: string) {
    const draft = (drafts[role] ?? "").trim();
    if (!draft) return;
    setPendingAdds((prev) => {
      const existing = prev[role] ?? [];
      // Same string already queued → no-op. Same string already in the
      // saved catalog → also no-op (the operator clearly wanted that
      // permission and it's already there).
      if (existing.includes(draft)) return prev;
      const inCatalog = catalog
        .find((e) => e.role === role)
        ?.permissions.includes(draft);
      if (inCatalog) return prev;
      return { ...prev, [role]: [...existing, draft] };
    });
    setDrafts((d) => ({ ...d, [role]: "" }));
  }

  function unqueueAdd(role: string, draftIdx: number) {
    setPendingAdds((prev) => {
      const existing = prev[role] ?? [];
      const next = existing.filter((_, i) => i !== draftIdx);
      if (next.length === 0) {
        // Drop the key entirely so hasPending() stays accurate.
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { [role]: _, ...rest } = prev;
        return rest;
      }
      return { ...prev, [role]: next };
    });
  }

  function toggleDelete(role: string, index: number) {
    const key = `${role}:${index}`;
    setPendingDeleteKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function isPendingDelete(role: string, index: number): boolean {
    return pendingDeleteKeys.has(`${role}:${index}`);
  }

  function hasPending(): boolean {
    if (pendingDeleteKeys.size > 0) return true;
    return Object.values(pendingAdds).some((arr) => arr.length > 0);
  }

  // Flush all queued mutations to the API, then reload the catalog.
  // Order matters: DELETE highest indices first so the lower indices stay
  // valid as rows disappear. POSTs run after the deletes complete.
  async function saveChanges() {
    if (saving) return;
    setSaving(true);
    try {
      // Group deletes per role and sort descending so we remove from the
      // bottom of each list — that way every subsequent index is still
      // valid against the server-side row order.
      const deletesByRole = new Map<string, number[]>();
      for (const key of pendingDeleteKeys) {
        const [role, idxStr] = key.split(":");
        const idx = Number(idxStr);
        if (!Number.isInteger(idx)) continue;
        if (!deletesByRole.has(role)) deletesByRole.set(role, []);
        deletesByRole.get(role)!.push(idx);
      }
      for (const [role, indices] of deletesByRole) {
        indices.sort((a, b) => b - a);
        for (const idx of indices) {
          await api.delete(
            `/role-permissions/${role}/permissions/${idx}`,
          );
        }
      }
      for (const [role, additions] of Object.entries(pendingAdds)) {
        for (const permission of additions) {
          await api.post(`/role-permissions/${role}/permissions`, {
            permission,
          });
        }
      }
      toast.success(t("rolePermissions.saved", "Changes saved"));
      setPendingAdds({});
      setPendingDeleteKeys(new Set());
      setDrafts({});
      setEditing(false);
      await load();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to save changes",
      );
    }
    setSaving(false);
  }

  function cancelEdit() {
    setPendingAdds({});
    setPendingDeleteKeys(new Set());
    setDrafts({});
    setEditing(false);
  }

  // Create-role flow — POST hits the API immediately rather than
  // queueing because the operator clearly intended the action (they had
  // to type into three fields and click Save). Validation mirrors the
  // backend so the toast carries a clear message instead of a generic
  // 400 round-trip.
  async function createRole() {
    if (creatingRole) return;
    const role = newRoleName.trim().toUpperCase();
    const label = newRoleLabel.trim();
    const summary = newRoleSummary.trim();
    if (!/^[A-Z][A-Z0-9_]{1,39}$/.test(role)) {
      toast.error(
        t(
          "rolePermissions.invalidRoleName",
          "Role must be UPPER_SNAKE format (2–40 chars).",
        ),
      );
      return;
    }
    if (label.length < 2) {
      toast.error(
        t("rolePermissions.invalidLabel", "Label must be at least 2 chars."),
      );
      return;
    }
    if (summary.length === 0) {
      toast.error(
        t("rolePermissions.invalidSummary", "Summary is required."),
      );
      return;
    }
    setCreatingRole(true);
    try {
      // Flush any half-typed permission draft into the queued list so an
      // operator who clicked Save without first pressing "Add" still
      // gets that permission persisted.
      const pendingDraft = newRolePermissionDraft.trim();
      const permissions =
        pendingDraft && !newRolePermissions.includes(pendingDraft)
          ? [...newRolePermissions, pendingDraft]
          : newRolePermissions;

      const res = await api.post<CatalogResponse>(`/role-permissions/entries`, {
        role,
        label,
        summary,
        permissions,
      });
      setCatalog(res.data.roles || []);
      resetAddRoleForm();
      setShowAddRole(false);
      toast.success(t("rolePermissions.roleCreated", "Role added"));
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to add role",
      );
    }
    setCreatingRole(false);
  }

  async function deleteRole(role: string) {
    if (saving || creatingRole) return;
    // Styled `useConfirm()` modal — matches the destructive-action UX
    // used elsewhere (e.g. Tenants suspend). The catalog row + every
    // permission row under it goes away via the FK cascade on the
    // backend.
    const ok = await confirm({
      title: t("rolePermissions.confirmDeleteRoleTitle", `Delete role ${role}?`),
      message: t(
        "rolePermissions.confirmDeleteRole",
        "This removes the catalog entry and every permission listed under it. This action cannot be undone.",
      ),
      confirmLabel: t("rolePermissions.deleteRoleConfirm", "Delete role"),
      cancelLabel: t("rolePermissions.cancel", "Cancel"),
      danger: true,
    });
    if (!ok) return;
    try {
      const res = await api.delete<CatalogResponse>(
        `/role-permissions/entries/${role}`,
      );
      setCatalog(res.data.roles || []);
      // Clear any pending edits that targeted the now-gone role.
      setPendingAdds((prev) => {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { [role]: _, ...rest } = prev;
        return rest;
      });
      setPendingDeleteKeys((prev) => {
        const next = new Set(prev);
        for (const key of next) {
          if (key.startsWith(`${role}:`)) next.delete(key);
        }
        return next;
      });
      toast.success(t("rolePermissions.roleDeleted", "Role removed"));
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to remove role",
      );
    }
  }

  if (user && !canView) return null;

  return (
    <div data-testid="role-permissions">
      <div className="mb-4">
        <Link
          href={backHref}
          data-testid="role-permissions-back"
          className="mb-2 inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700"
        >
          <ArrowLeft size={14} /> {backLabel}
        </Link>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold">
              {t("rolePermissions.title", "Default permissions & roles")}
            </h1>
            {/* The tenant chip is only meaningful in the per-tenant onboarding
                flow. When the super admin reached this page through the
                global "Permissions catalog" entry on /dashboard/tenants
                (?from=tenants), the URL's [id] segment was just whichever
                tenant rendered first in the list — not a real scope — so
                showing its name here would mislead. Hide it in that case. */}
            {detail && !fromTenantsList && (
              <p
                className="text-sm text-gray-500"
                data-testid="role-permissions-tenant-chip"
              >
                <span className="font-medium">{detail.name}</span> ·{" "}
                <span className="font-mono">{detail.subdomain}</span>
              </p>
            )}
          </div>
          {/* Edit affordances render only for SUPER_ADMIN. Everyone else
              sees the catalog without any edit slot — no Edit button, no
              Save/Cancel, no Add-role.
              "Add new role" lives outside `editing` mode by design: the
              dirty-draft per-role permissions flow (queue ×/+) is one
              orthogonal action; creating a brand-new role row is another.
              Keeping them separate avoids the "I clicked Edit but didn't
              want to add a role" confusion. */}
          {canEdit && (
            <div className="flex flex-wrap gap-2">
              {editing ? (
                <>
                  <button
                    type="button"
                    data-testid="role-permissions-cancel"
                    onClick={cancelEdit}
                    disabled={saving}
                    className="inline-flex items-center gap-1 rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                  >
                    {t("rolePermissions.cancel", "Cancel")}
                  </button>
                  <button
                    type="button"
                    data-testid="role-permissions-save"
                    onClick={saveChanges}
                    disabled={saving || !hasPending()}
                    className="inline-flex items-center gap-1 rounded-lg border border-primary bg-primary px-3 py-1.5 text-sm font-medium text-white hover:bg-primary-dark disabled:opacity-50"
                  >
                    {saving
                      ? t("rolePermissions.saving", "Saving…")
                      : t("rolePermissions.save", "Save changes")}
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    data-testid="role-permissions-add-role-toggle"
                    onClick={() => setShowAddRole((v) => !v)}
                    disabled={creatingRole}
                    className="inline-flex items-center gap-1 rounded-lg border border-emerald-300 bg-white px-3 py-1.5 text-sm font-medium text-emerald-700 hover:bg-emerald-50 disabled:opacity-50 dark:border-emerald-800 dark:bg-gray-800 dark:text-emerald-300 dark:hover:bg-emerald-950/30"
                  >
                    <Plus size={14} />
                    {t("rolePermissions.addRole", "Add new role")}
                  </button>
                  <button
                    type="button"
                    data-testid="role-permissions-edit-toggle"
                    onClick={() => setEditing(true)}
                    className="inline-flex items-center gap-1 rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
                  >
                    <Pencil size={14} />
                    {t("rolePermissions.edit", "Edit catalog")}
                  </button>
                </>
              )}
            </div>
          )}
        </div>

        {/* "Add new role" modal — centred overlay, super-admin-only.
            NOT gated on `editing` because creating a brand-new role is a
            separate one-shot action. Includes an "Initial permissions"
            section so the role is created with starter permissions in
            one round-trip; the backend accepts the optional
            `permissions[]` array on POST /role-permissions/entries. */}
        {canEdit && showAddRole && (
          <div
            data-testid="role-permissions-add-role-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="role-permissions-add-role-title"
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
            onClick={(e) => {
              // Backdrop click closes — but not when a save is in flight,
              // so the user can't accidentally lose a half-typed entry.
              if (e.target === e.currentTarget && !creatingRole) {
                setShowAddRole(false);
                resetAddRoleForm();
              }
            }}
          >
            <form
              data-testid="role-permissions-add-role-form"
              onSubmit={(e) => {
                e.preventDefault();
                createRole();
              }}
              className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl dark:bg-gray-900"
            >
              {/* Modal header */}
              <div className="flex items-start justify-between gap-3 border-b border-gray-200 p-5 dark:border-gray-700">
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300">
                    <Plus size={20} />
                  </div>
                  <div>
                    <h2
                      id="role-permissions-add-role-title"
                      className="text-lg font-bold text-gray-900 dark:text-gray-100"
                    >
                      {t("rolePermissions.addRoleTitle", "Add a new role")}
                    </h2>
                    <p className="text-xs text-gray-500 dark:text-gray-400">
                      {t(
                        "rolePermissions.addRoleSubtitle",
                        "Name + label + summary required. Initial permissions optional.",
                      )}
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setShowAddRole(false);
                    resetAddRoleForm();
                  }}
                  disabled={creatingRole}
                  aria-label={t("rolePermissions.close", "Close") as string}
                  className="rounded-lg p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600 disabled:opacity-50 dark:hover:bg-gray-800 dark:hover:text-gray-200"
                >
                  <X size={18} />
                </button>
              </div>

              {/* Modal body — scrolls if the permissions list gets long */}
              <div className="flex-1 overflow-y-auto p-5">
                <div className="grid gap-4 md:grid-cols-2">
                  <label className="block text-xs font-semibold uppercase tracking-wide text-gray-600 dark:text-gray-400">
                    {t(
                      "rolePermissions.fieldRoleName",
                      "Role name (UPPER_SNAKE)",
                    )}
                    <input
                      type="text"
                      value={newRoleName}
                      onChange={(e) => setNewRoleName(e.target.value)}
                      maxLength={40}
                      placeholder="e.g. DEPUTY_MANAGER"
                      data-testid="role-permissions-add-role-name"
                      className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-mono text-gray-900 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/40 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
                      disabled={creatingRole}
                      autoFocus
                    />
                  </label>
                  <label className="block text-xs font-semibold uppercase tracking-wide text-gray-600 dark:text-gray-400">
                    {t("rolePermissions.fieldLabel", "Display label")}
                    <input
                      type="text"
                      value={newRoleLabel}
                      onChange={(e) => setNewRoleLabel(e.target.value)}
                      maxLength={100}
                      placeholder="e.g. Deputy Manager"
                      data-testid="role-permissions-add-role-label"
                      className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/40 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
                      disabled={creatingRole}
                    />
                  </label>
                  <label className="block text-xs font-semibold uppercase tracking-wide text-gray-600 md:col-span-2 dark:text-gray-400">
                    {t("rolePermissions.fieldSummary", "Summary")}
                    <textarea
                      value={newRoleSummary}
                      onChange={(e) => setNewRoleSummary(e.target.value)}
                      maxLength={300}
                      rows={2}
                      placeholder={
                        t(
                          "rolePermissions.fieldSummaryPlaceholder",
                          "One-line description of what this role does.",
                        ) as string
                      }
                      data-testid="role-permissions-add-role-summary"
                      className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/40 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
                      disabled={creatingRole}
                    />
                  </label>
                </div>

                {/* Initial permissions */}
                <div className="mt-5">
                  <p className="text-xs font-semibold uppercase tracking-wide text-gray-600 dark:text-gray-400">
                    {t(
                      "rolePermissions.fieldInitialPerms",
                      "Initial permissions (optional)",
                    )}
                  </p>
                  <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                    {t(
                      "rolePermissions.fieldInitialPermsHint",
                      "Press Enter or click Add to queue each permission. They're created together with the role.",
                    )}
                  </p>

                  {newRolePermissions.length > 0 && (
                    <ul
                      data-testid="role-permissions-add-role-perms-list"
                      className="mt-2 space-y-1 rounded-lg border border-gray-200 bg-gray-50 p-2 text-sm dark:border-gray-700 dark:bg-gray-800"
                    >
                      {newRolePermissions.map((perm, idx) => (
                        <li
                          key={`${perm}-${idx}`}
                          data-testid={`role-permissions-add-role-perm-${idx}`}
                          className="flex items-start gap-2"
                        >
                          <Check
                            size={14}
                            className="mt-0.5 flex-shrink-0 text-emerald-600"
                          />
                          <span className="flex-1 text-gray-800 dark:text-gray-100">
                            {perm}
                          </span>
                          <button
                            type="button"
                            onClick={() => unqueueNewRolePermission(idx)}
                            disabled={creatingRole}
                            aria-label={
                              t(
                                "rolePermissions.removeQueued",
                                "Remove queued permission",
                              ) as string
                            }
                            data-testid={`role-permissions-add-role-perm-remove-${idx}`}
                            className="mt-0.5 inline-flex h-5 w-5 flex-shrink-0 items-center justify-center rounded text-gray-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-50 dark:hover:bg-red-950/30"
                          >
                            <X size={14} />
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}

                  <div className="mt-2 flex gap-2">
                    <input
                      type="text"
                      value={newRolePermissionDraft}
                      onChange={(e) =>
                        setNewRolePermissionDraft(e.target.value)
                      }
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          queueNewRolePermission();
                        }
                      }}
                      maxLength={200}
                      placeholder={
                        t(
                          "rolePermissions.addInitialPermPlaceholder",
                          "Add a permission…",
                        ) as string
                      }
                      data-testid="role-permissions-add-role-perm-input"
                      className="flex-1 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/40 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
                      disabled={creatingRole}
                    />
                    <button
                      type="button"
                      onClick={queueNewRolePermission}
                      disabled={creatingRole || !newRolePermissionDraft.trim()}
                      data-testid="role-permissions-add-role-perm-queue"
                      className="inline-flex items-center gap-1 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200"
                    >
                      <Plus size={14} />
                      {t("rolePermissions.add", "Add")}
                    </button>
                  </div>
                </div>
              </div>

              {/* Modal footer — Save anchored at the bottom */}
              <div className="flex items-center justify-end gap-2 border-t border-gray-200 bg-gray-50 px-5 py-3 dark:border-gray-700 dark:bg-gray-800/50">
                <button
                  type="button"
                  onClick={() => {
                    setShowAddRole(false);
                    resetAddRoleForm();
                  }}
                  disabled={creatingRole}
                  className="inline-flex items-center gap-1 rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-200"
                >
                  {t("rolePermissions.cancel", "Cancel")}
                </button>
                <button
                  type="submit"
                  data-testid="role-permissions-add-role-submit"
                  disabled={
                    creatingRole ||
                    !newRoleName.trim() ||
                    !newRoleLabel.trim() ||
                    !newRoleSummary.trim()
                  }
                  className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
                >
                  <Plus size={14} />
                  {creatingRole
                    ? t("rolePermissions.adding", "Saving…")
                    : t("rolePermissions.save", "Save")}
                </button>
              </div>
            </form>
          </div>
        )}
        <p className="mt-2 max-w-3xl text-sm text-gray-600">
          {fromTenantsList
            ? t(
                "rolePermissions.introGlobal",
                "Platform-wide default permissions for each role. Changes apply across every tenant.",
              )
            : t(
                "rolePermissions.intro",
                "Default permissions for each role on this tenant. Review them before inviting staff.",
              )}
        </p>
      </div>

      {loading ? (
        <div
          data-testid="role-permissions-loading"
          aria-busy="true"
          className="space-y-3"
        >
          <SkeletonCard />
          <SkeletonCard />
          <SkeletonCard />
        </div>
      ) : loadError ? (
        <div
          data-testid="role-permissions-error"
          role="alert"
          className="rounded-xl border border-red-200 bg-red-50 p-6 text-sm text-red-800 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-200"
        >
          <p className="font-semibold">
            {t(
              "rolePermissions.errorTitle",
              "Could not load the role-permission catalog",
            )}
          </p>
          <p className="mt-1">
            <span className="font-mono text-xs">{loadError}</span>
          </p>
          <button
            type="button"
            onClick={() => load()}
            className="mt-3 inline-flex items-center gap-1 rounded-lg border border-red-300 bg-white px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-100 dark:border-red-800 dark:bg-red-950 dark:text-red-200 dark:hover:bg-red-900/60"
          >
            {t("rolePermissions.retry", "Retry")}
          </button>
        </div>
      ) : catalog.length === 0 ? (
        <p
          data-testid="role-permissions-empty"
          className="rounded-xl border bg-white p-6 text-sm text-gray-500 dark:bg-gray-800 dark:text-gray-300"
        >
          {t(
            "rolePermissions.empty",
            "The catalog tables are empty. From `packages/db/`, run `npx prisma db execute --file prisma/migrations/20260530000001_add_role_permissions/data-only.sql --schema prisma/schema.prisma` to insert the install-default rows.",
          )}
        </p>
      ) : (
        <ul className="grid gap-3 md:grid-cols-2">
          {catalog.map((entry) => {
            const visual = ROLE_VISUALS[entry.role] ?? FALLBACK_VISUAL;
            const Icon = visual.icon;
            return (
              <li
                key={entry.role}
                data-testid={`role-permissions-card-${entry.role}`}
                data-role={entry.role}
                // `h-full` lets the grid-row baseline + `items-stretch` (CSS
                // grid default) align each card to the row's tallest peer,
                // so a 4-permission card and a 6-permission card render
                // the same height. The internal flex column pushes the
                // optional "Add a permission" form to the bottom.
                className="flex h-full flex-col gap-2 rounded-xl border bg-white p-4 shadow-sm dark:bg-gray-800"
              >
                <div className="flex items-start gap-3">
                  <div
                    className={`flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full ${visual.iconWrap}`}
                    data-testid={`role-permissions-icon-${entry.role}`}
                  >
                    <Icon size={20} />
                  </div>
                  <div className="flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="font-semibold">{entry.label}</h3>
                      <span
                        className={`rounded-full px-1.5 py-0.5 font-mono text-[10px] uppercase ${visual.badge}`}
                        data-testid={`role-permissions-badge-${entry.role}`}
                      >
                        {entry.role.replace(/_/g, " ")}
                      </span>
                    </div>
                    <p className="mt-0.5 text-xs text-gray-600 dark:text-gray-300">
                      {entry.summary}
                    </p>
                  </div>
                  {/* Per-card delete button — visible in both display and
                      edit modes when the operator can edit (super admin
                      from the global Tenants entry). Deleting a role is
                      a one-shot action like "Add new role", not part of
                      the dirty-draft per-permission flow, so we don't
                      hide it behind the Edit toggle. */}
                  {canEdit && (
                    <button
                      type="button"
                      data-testid={`role-permissions-delete-role-${entry.role}`}
                      onClick={() => deleteRole(entry.role)}
                      disabled={saving || creatingRole}
                      title={
                        t(
                          "rolePermissions.deleteRoleAria",
                          "Delete this role from the catalog",
                        ) as string
                      }
                      aria-label={
                        t(
                          "rolePermissions.deleteRoleAria",
                          "Delete this role from the catalog",
                        ) as string
                      }
                      className="ml-1 inline-flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg border border-red-200 bg-white text-red-500 hover:bg-red-50 disabled:opacity-50 dark:border-red-900/60 dark:bg-gray-800 dark:text-red-400 dark:hover:bg-red-950/30"
                    >
                      <X size={14} />
                    </button>
                  )}
                </div>
                <ul
                  data-testid={`role-permissions-list-${entry.role}`}
                  // `flex-1` so the permissions list absorbs the vertical
                  // slack; the input form (if any) is then anchored to the
                  // bottom of the card, keeping the per-card silhouette
                  // consistent regardless of how many permissions a role
                  // has.
                  className="mt-1 flex-1 space-y-1 pl-1 text-sm text-gray-700 dark:text-gray-200"
                >
                  {entry.permissions.map((perm, idx) => {
                    const pendingDel = isPendingDelete(entry.role, idx);
                    return (
                      <li
                        key={`${entry.role}-${idx}`}
                        data-testid={`role-permissions-item-${entry.role}-${idx}`}
                        data-pending-delete={pendingDel || undefined}
                        className="flex items-start gap-2"
                      >
                        <Check
                          size={14}
                          className={`mt-0.5 flex-shrink-0 ${
                            pendingDel ? "text-gray-300" : "text-green-600"
                          }`}
                        />
                        <span
                          className={`flex-1 ${
                            pendingDel
                              ? "text-gray-400 line-through dark:text-gray-500"
                              : ""
                          }`}
                        >
                          {perm}
                        </span>
                        {editing && (
                          <button
                            type="button"
                            data-testid={`role-permissions-remove-${entry.role}-${idx}`}
                            onClick={() => toggleDelete(entry.role, idx)}
                            disabled={saving}
                            aria-label={
                              pendingDel
                                ? (t(
                                    "rolePermissions.undoRemoveAria",
                                    "Undo remove",
                                  ) as string)
                                : (t(
                                    "rolePermissions.removeAria",
                                    "Mark permission for removal",
                                  ) as string)
                            }
                            title={
                              pendingDel
                                ? (t(
                                    "rolePermissions.undoRemove",
                                    "Undo (click Save to discard)",
                                  ) as string)
                                : (t(
                                    "rolePermissions.markRemove",
                                    "Mark for removal — Save to commit",
                                  ) as string)
                            }
                            className={`mt-0.5 inline-flex h-5 w-5 flex-shrink-0 items-center justify-center rounded disabled:opacity-50 ${
                              pendingDel
                                ? "text-amber-600 hover:bg-amber-50 dark:hover:bg-amber-950/30"
                                : "text-gray-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950/30"
                            }`}
                          >
                            <X size={14} />
                          </button>
                        )}
                      </li>
                    );
                  })}
                  {/* Queued (unsaved) adds rendered below the saved list so
                      the operator sees what they're about to commit. */}
                  {editing &&
                    (pendingAdds[entry.role] ?? []).map((draft, dIdx) => (
                      <li
                        key={`${entry.role}-pending-${dIdx}`}
                        data-testid={`role-permissions-pending-add-${entry.role}-${dIdx}`}
                        className="flex items-start gap-2"
                      >
                        <Plus
                          size={14}
                          className="mt-0.5 flex-shrink-0 text-emerald-500"
                        />
                        <span className="flex-1 italic text-emerald-700 dark:text-emerald-300">
                          {draft}
                        </span>
                        <button
                          type="button"
                          data-testid={`role-permissions-unqueue-add-${entry.role}-${dIdx}`}
                          onClick={() => unqueueAdd(entry.role, dIdx)}
                          disabled={saving}
                          aria-label={
                            t(
                              "rolePermissions.unqueueAria",
                              "Drop this queued permission",
                            ) as string
                          }
                          className="mt-0.5 inline-flex h-5 w-5 flex-shrink-0 items-center justify-center rounded text-gray-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-50 dark:hover:bg-red-950/30"
                        >
                          <X size={14} />
                        </button>
                      </li>
                    ))}
                </ul>
                {editing && (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      queueAdd(entry.role);
                    }}
                    className="mt-2 flex gap-2"
                    data-testid={`role-permissions-add-form-${entry.role}`}
                  >
                    <input
                      type="text"
                      maxLength={200}
                      value={drafts[entry.role] ?? ""}
                      onChange={(e) =>
                        setDrafts((d) => ({ ...d, [entry.role]: e.target.value }))
                      }
                      placeholder={
                        t(
                          "rolePermissions.addPlaceholder",
                          "Add a permission…",
                        ) as string
                      }
                      data-testid={`role-permissions-add-input-${entry.role}`}
                      className="flex-1 rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-900 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/40 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
                      disabled={saving}
                    />
                    <button
                      type="submit"
                      disabled={saving || !(drafts[entry.role] ?? "").trim()}
                      data-testid={`role-permissions-add-btn-${entry.role}`}
                      className="inline-flex items-center gap-1 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-white hover:bg-primary-dark disabled:opacity-50"
                    >
                      <Plus size={14} />{" "}
                      {t("rolePermissions.add", "Add")}
                    </button>
                  </form>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
