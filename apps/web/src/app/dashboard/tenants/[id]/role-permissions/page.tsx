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
import { useParams, useRouter } from "next/navigation";
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

  // SUPER_ADMIN gets the same access surface as ADMIN — the backend treats
  // both as "tenant owner / Onviqa operator" for this catalog (Pearl §8.2
  // SUPER_ADMIN mirrors ADMIN). Anything else bounces.
  const canView = user?.role === "ADMIN" || user?.role === "SUPER_ADMIN";

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

  useEffect(() => {
    if (user && !canView) router.push("/dashboard");
  }, [user, canView, router]);

  const load = useCallback(async () => {
    if (!tenantId) return;
    setLoading(true);
    setLoadError(null);
    try {
      const [catRes, detailRes] = await Promise.all([
        api.get<CatalogResponse>(`/tenants/${tenantId}/role-permissions`),
        api.get<{ data: TenantDetail }>(`/tenants/${tenantId}`),
      ]);
      setCatalog(catRes.data.roles || []);
      setDetail(detailRes.data);
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
  }, [tenantId]);

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
            `/tenants/${tenantId}/role-permissions/${role}/permissions/${idx}`,
          );
        }
      }
      for (const [role, additions] of Object.entries(pendingAdds)) {
        for (const permission of additions) {
          await api.post(
            `/tenants/${tenantId}/role-permissions/${role}/permissions`,
            { permission },
          );
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

  if (user && !canView) return null;

  return (
    <div data-testid="role-permissions">
      <div className="mb-4">
        <Link
          href={`/dashboard/tenants/${tenantId}/onboarding`}
          className="mb-2 inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700"
        >
          <ArrowLeft size={14} />{" "}
          {t("rolePermissions.back", "Back to onboarding")}
        </Link>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold">
              {t("rolePermissions.title", "Default permissions & roles")}
            </h1>
            {detail && (
              <p className="text-sm text-gray-500">
                <span className="font-medium">{detail.name}</span> ·{" "}
                <span className="font-mono">{detail.subdomain}</span>
              </p>
            )}
          </div>
          {editing ? (
            <div className="flex flex-wrap gap-2">
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
            </div>
          ) : (
            <button
              type="button"
              data-testid="role-permissions-edit-toggle"
              onClick={() => setEditing(true)}
              className="inline-flex items-center gap-1 rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
            >
              <Pencil size={14} />
              {t("rolePermissions.edit", "Edit catalog")}
            </button>
          )}
        </div>
        <p className="mt-2 max-w-3xl text-sm text-gray-600">
          {t(
            "rolePermissions.intro",
            "These are the default permissions for each role on this tenant. Review them before inviting staff — anything you flag here can be customised by your hospital admin later.",
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
          <p className="mt-3 text-xs leading-relaxed">
            {t(
              "rolePermissions.errorHint",
              "If you just ran the migration `20260530000001_add_role_permissions`, the API server is still using its previously generated Prisma client and doesn't know about the new tables yet. From `packages/db/`, run `npx prisma generate`, then restart the API server (the dev process in `apps/api/`). Reload this page after the API restarts.",
            )}
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
                className="flex flex-col gap-2 rounded-xl border bg-white p-4 shadow-sm dark:bg-gray-800"
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
                </div>
                <ul
                  data-testid={`role-permissions-list-${entry.role}`}
                  className="mt-1 space-y-1 pl-1 text-sm text-gray-700 dark:text-gray-200"
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
