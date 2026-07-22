"use client";

// Department admin module (2026-07) — admin-only CRUD + activity dashboard.
//
// One page, two zones:
//   • Dashboard — summary tiles (total / active / inactive / open / completed
//     requests) + a per-department activity grid.
//   • Registry — searchable list with create, inline edit (name/code/active)
//     and delete (soft-delete when the department has requisition history).
// Admins manage departments; assigned staff get read-only visibility into
// their own departments.
// Modals live in-DOM (project rule: never window.prompt/alert/confirm).

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import { useAuthStore } from "@/lib/store";
import {
  Building2,
  Plus,
  Pencil,
  Power,
  Trash2,
  X,
  Search,
  PackageCheck,
  ClipboardList,
  CheckCircle2,
  Users,
  UserPlus,
  UserMinus,
  MoreVertical,
  AlertTriangle,
  ArrowRight,
} from "lucide-react";
import { SkeletonCard, SkeletonTable } from "@/components/Skeleton";

const VIEW_ALLOWED = new Set(["ADMIN", "PHARMACIST", "NURSE", "DOCTOR", "RECEPTION", "LAB_TECH"]);

const FIELD =
  "w-full rounded-lg border bg-white px-3 py-2 text-sm text-gray-900 placeholder-gray-400 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100 dark:placeholder-gray-500";

interface Department {
  id: string;
  name: string;
  code: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
  requisitionCount: number;
}

interface DashSummary {
  totalDepartments: number;
  activeDepartments: number;
  inactiveDepartments: number;
  openRequests: number;
  completedRequests: number;
}
interface DashDept {
  id: string;
  name: string;
  code: string;
  active: boolean;
  openRequests: number;
  completedRequests: number;
  totalRequests: number;
  issuedUnits: number;
}

interface StaffUser {
  id: string;
  name: string;
  email: string | null;
  role: string;
}
interface Member {
  id: string;
  userId: string;
  user: StaffUser;
}

export default function DepartmentsPage() {
  const { user, isLoading } = useAuthStore();
  const router = useRouter();

  const [rows, setRows] = useState<Department[]>([]);
  const [loading, setLoading] = useState(true);
  const [summary, setSummary] = useState<DashSummary | null>(null);
  const [perDept, setPerDept] = useState<DashDept[]>([]);
  const [dashLoading, setDashLoading] = useState(true);

  const [q, setQ] = useState("");
  // View filter: all departments, active only, or the Inactive view (where you
  // can reactivate or permanently delete).
  const [view, setView] = useState<"all" | "active" | "inactive">("all");

  // Create / edit modal — `editing` null = create mode, else edit that dept.
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Department | null>(null);
  const [formName, setFormName] = useState("");
  const [formCode, setFormCode] = useState("");
  const [formActive, setFormActive] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  // Which card's action menu is open (by dept id), and the pending
  // confirmation ("deactivate" / "delete") for the sweet-alert dialog.
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{
    dept: Department;
    kind: "deactivate" | "delete" | "permanent";
  } | null>(null);

  // Members drawer — which department's members we're managing.
  const [membersFor, setMembersFor] = useState<Department | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [membersLoading, setMembersLoading] = useState(false);
  const [memberQuery, setMemberQuery] = useState("");
  const [memberResults, setMemberResults] = useState<StaffUser[]>([]);
  const [searching, setSearching] = useState(false);

  const allowed = !!user && VIEW_ALLOWED.has(user.role);
  const canManage = user?.role === "ADMIN";
  const [notAssigned, setNotAssigned] = useState(false);

  useEffect(() => {
    if (!isLoading && user && !allowed) router.push("/dashboard");
  }, [isLoading, user, allowed, router]);

  const loadDepartments = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams();
      if (q.trim()) qs.set("q", q.trim());
      if (view === "active") qs.set("active", "true");
      if (view === "inactive") qs.set("active", "false");
      const res = await api.get<{ data: Department[]; meta?: { notInAnyDepartment?: boolean } }>(
        `/departments?${qs.toString()}`,
      );
      setRows(Array.isArray(res?.data) ? res.data : []);
      setNotAssigned(Boolean(res?.meta?.notInAnyDepartment));
    } catch {
      setRows([]);
      setNotAssigned(false);
    }
    setLoading(false);
  }, [q, view]);

  const loadDashboard = useCallback(async () => {
    setDashLoading(true);
    try {
      const res = await api.get<{
        data: { summary: DashSummary; perDepartment: DashDept[] };
      }>("/departments/dashboard");
      setSummary(res?.data?.summary ?? null);
      setPerDept(
        Array.isArray(res?.data?.perDepartment) ? res.data.perDepartment : [],
      );
    } catch {
      setSummary(null);
      setPerDept([]);
    }
    setDashLoading(false);
  }, []);

  useEffect(() => {
    if (allowed && canManage) loadDashboard();
    else setDashLoading(false);
  }, [allowed, canManage, loadDashboard]);

  useEffect(() => {
    if (allowed) loadDepartments();
  }, [allowed, loadDepartments]);

  function openCreate() {
    setEditing(null);
    setFormName("");
    setFormCode("");
    setFormActive(true);
    setModalOpen(true);
  }
  function openEdit(d: Department) {
    setEditing(d);
    setFormName(d.name);
    setFormCode(d.code);
    setFormActive(d.active);
    setModalOpen(true);
  }

  const submitForm = useCallback(async () => {
    const name = formName.trim();
    const code = formCode.trim().toUpperCase();
    if (name.length < 2) {
      toast.error("Name must be at least 2 characters");
      return;
    }
    if (!/^[A-Za-z0-9_]{2,20}$/.test(code)) {
      toast.error("Code: 2–20 letters, digits or underscores");
      return;
    }
    setSubmitting(true);
    try {
      if (editing) {
        await api.patch(`/departments/${editing.id}`, {
          name,
          code,
          active: formActive,
        });
        toast.success(`Department "${name}" updated`);
      } else {
        await api.post("/departments", { name, code });
        toast.success(`Department "${name}" created`);
      }
      setModalOpen(false);
      await Promise.all([loadDepartments(), loadDashboard()]);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save department");
    } finally {
      setSubmitting(false);
    }
  }, [formName, formCode, formActive, editing, loadDepartments, loadDashboard]);

  // Activating (turning ON) is safe — do it immediately. Deactivating goes
  // through the confirm dialog (opened from the card menu).
  const activate = useCallback(
    async (d: Department) => {
      try {
        await api.patch(`/departments/${d.id}`, { active: true });
        toast.success(`"${d.name}" activated`);
        await Promise.all([loadDepartments(), loadDashboard()]);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to update");
      }
    },
    [loadDepartments, loadDashboard],
  );

  const doDeactivate = useCallback(
    async (d: Department) => {
      try {
        await api.patch(`/departments/${d.id}`, { active: false });
        toast.success(`"${d.name}" deactivated`);
        await Promise.all([loadDepartments(), loadDashboard()]);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to update");
      }
    },
    [loadDepartments, loadDashboard],
  );

  const doDelete = useCallback(
    async (d: Department, force = false) => {
      try {
        const res = await api.delete<{ data: { softDeleted?: boolean } }>(
          `/departments/${d.id}${force ? "?force=true" : ""}`,
        );
        toast.success(
          res?.data?.softDeleted
            ? `"${d.name}" deactivated (has request history, kept for records)`
            : `"${d.name}" permanently deleted`,
        );
        await Promise.all([loadDepartments(), loadDashboard()]);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to delete");
      }
    },
    [loadDepartments, loadDashboard],
  );

  // Execute whatever the confirm dialog is asking about, then close it.
  const runConfirm = useCallback(async () => {
    if (!confirm) return;
    const { dept, kind } = confirm;
    setConfirm(null);
    if (kind === "delete") await doDelete(dept);
    else if (kind === "permanent") await doDelete(dept, true);
    else await doDeactivate(dept);
  }, [confirm, doDelete, doDeactivate]);

  // ── Members drawer ──
  const loadMembers = useCallback(async (deptId: string) => {
    setMembersLoading(true);
    try {
      const res = await api.get<{ data: Member[] }>(
        `/departments/${deptId}/members`,
      );
      setMembers(Array.isArray(res?.data) ? res.data : []);
    } catch {
      setMembers([]);
    }
    setMembersLoading(false);
  }, []);

  function openMembers(d: Department) {
    setMembersFor(d);
    setMemberQuery("");
    setMemberResults([]);
    void loadMembers(d.id);
  }

  const searchStaff = useCallback(
    async (deptId: string, q: string) => {
      setSearching(true);
      try {
        const res = await api.get<{ data: StaffUser[] }>(
          `/departments/${deptId}/members/search?q=${encodeURIComponent(q)}`,
        );
        setMemberResults(Array.isArray(res?.data) ? res.data : []);
      } catch {
        setMemberResults([]);
      }
      setSearching(false);
    },
    [],
  );

  // Debounce the member search so we don't fire a request per keystroke.
  // Only search once the admin types — an empty query returns every addable
  // staff member, which is noisy. Clear results when the box is emptied.
  useEffect(() => {
    if (!membersFor) return;
    if (!memberQuery.trim()) {
      setMemberResults([]);
      setSearching(false);
      return;
    }
    const id = setTimeout(() => void searchStaff(membersFor.id, memberQuery.trim()), 300);
    return () => clearTimeout(id);
  }, [membersFor, memberQuery, searchStaff]);

  const addMember = useCallback(
    async (u: StaffUser) => {
      if (!membersFor) return;
      try {
        await api.post(`/departments/${membersFor.id}/members`, { userId: u.id });
        toast.success(`${u.name} added to ${membersFor.name}`);
        setMemberResults((r) => r.filter((x) => x.id !== u.id));
        await loadMembers(membersFor.id);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to add member");
      }
    },
    [membersFor, loadMembers],
  );

  const removeMember = useCallback(
    async (m: Member) => {
      if (!membersFor) return;
      try {
        await api.delete(`/departments/${membersFor.id}/members/${m.userId}`);
        toast.success(`${m.user.name} removed`);
        await loadMembers(membersFor.id);
        // Re-run the search so the removed user reappears as addable.
        void searchStaff(membersFor.id, memberQuery);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to remove member");
      }
    },
    [membersFor, memberQuery, loadMembers, searchStaff],
  );

  // The registry (rows) is the source of truth for the cards — it already
  // honours the search box + active-only filter server-side. We merge in the
  // per-department activity stats (open/done/units) from the dashboard call.
  const filtered = rows;
  const statsById = useMemo(() => {
    const m = new Map<string, DashDept>();
    for (const d of perDept) m.set(d.id, d);
    return m;
  }, [perDept]);

  if (isLoading || (user && !allowed)) return null;

  return (
    <div>
      <div className="mb-6 flex items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold">
            <Building2 size={22} /> Departments
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Manage operational departments and track their material requests
          </p>
        </div>
        {canManage && (
          <button
            type="button"
            onClick={openCreate}
            data-testid="dept-create-btn"
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary/90"
          >
            <Plus size={16} /> New Department
          </button>
        )}
      </div>

      {/* ── Dashboard summary tiles ── */}
      {canManage && dashLoading ? (
        <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
          <SkeletonCard />
          <SkeletonCard />
          <SkeletonCard />
          <SkeletonCard />
          <SkeletonCard />
        </div>
      ) : canManage && summary ? (
        <div
          className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5"
          data-testid="dept-summary"
        >
          <StatTile label="Total" value={summary.totalDepartments} icon={Building2} tone="slate" />
          <StatTile label="Active" value={summary.activeDepartments} icon={CheckCircle2} tone="emerald" />
          <StatTile label="Inactive" value={summary.inactiveDepartments} icon={Power} tone="gray" />
          <StatTile label="Open Requests" value={summary.openRequests} icon={ClipboardList} tone="amber" />
          <StatTile label="Completed" value={summary.completedRequests} icon={PackageCheck} tone="blue" />
        </div>
      ) : null}

      {/* ── Toolbar: search + view filter (All / Active / Inactive) ── */}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[200px]">
          <Search
            size={16}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400"
          />
          <input
            type="text"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search name or code…"
            data-testid="dept-search"
            className={`${FIELD} pl-9`}
          />
        </div>
        <div className="inline-flex rounded-lg border p-0.5 dark:border-gray-700">
          {(
            [
              { key: "all", label: "All" },
              { key: "active", label: "Active" },
              { key: "inactive", label: "Inactive" },
            ] as const
          ).map((v) => (
            <button
              key={v.key}
              type="button"
              onClick={() => setView(v.key)}
              data-testid={`dept-view-${v.key}`}
              className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${
                view === v.key
                  ? "bg-primary text-white"
                  : "text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700"
              }`}
            >
              {v.label}
            </button>
          ))}
        </div>
      </div>

      {/* Inactive-view banner — explains the reactivate / permanent-delete flow */}
      {view === "inactive" && (
        <div
          className="mb-4 flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-300"
          data-testid="dept-inactive-banner"
        >
          <AlertTriangle size={16} className="shrink-0" />
          Deactivated departments. Reactivate to use again, or permanently delete
          (only those with no request history can be permanently removed).
        </div>
      )}

      {/* ── Department cards (single surface: stats + actions) ── */}
      {loading ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <SkeletonCard />
          <SkeletonCard />
          <SkeletonCard />
        </div>
      ) : filtered.length === 0 ? (
        <div
          className="rounded-xl border border-dashed p-10 text-center text-gray-500 dark:border-gray-700"
          data-testid="dept-empty"
        >
          {notAssigned ? (
            "No assigned department. Ask an administrator to assign you to a department."
          ) : canManage ? (
            <>
              No departments found.{" "}
              <button
                type="button"
                onClick={openCreate}
                className="font-medium text-primary hover:underline"
              >
                Add your first one
              </button>
              .
            </>
          ) : (
            "No departments found."
          )}
        </div>
      ) : (
        <div
          className="grid grid-cols-1 gap-4 xl:grid-cols-2"
          data-testid="dept-card-grid"
        >
          {filtered.map((d) => {
            const s = statsById.get(d.id);
            return (
              <div
                key={d.id}
                data-testid="dept-card"
                className="flex flex-col rounded-2xl border bg-white p-6 shadow-sm dark:border-gray-700/70 dark:bg-gray-800/60"
              >
                {/* Header: icon + name/code/description, status + actions menu */}
                <div className="mb-5 flex items-start justify-between gap-3">
                  <div className="flex items-start gap-3">
                    <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-indigo-100 text-indigo-600 dark:bg-indigo-950/50 dark:text-indigo-300">
                      <Building2 size={22} />
                    </div>
                    <div>
                      <p className="text-lg font-bold">{d.name}</p>
                      <p className="text-xs font-medium uppercase tracking-wide text-gray-400">
                        {d.code}
                      </p>
                      <p className="mt-1 max-w-xs text-xs text-gray-500 dark:text-gray-400">
                        Manage and track all material requests and activities for
                        the {d.name} department.
                      </p>
                    </div>
                  </div>
                  {/* Status pill + three-dot actions menu (top-right) */}
                  <div className="flex shrink-0 items-center gap-2">
                    <span
                      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${
                        d.active
                          ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300"
                          : "bg-gray-200 text-gray-600 dark:bg-gray-700 dark:text-gray-300"
                      }`}
                    >
                      <span
                        className={`h-1.5 w-1.5 rounded-full ${
                          d.active ? "bg-emerald-500" : "bg-gray-400"
                        }`}
                      />
                      {d.active ? "Active" : "Inactive"}
                    </span>
                    {canManage && (
                    <div className="relative">
                      <button
                        type="button"
                        onClick={() => setMenuFor(menuFor === d.id ? null : d.id)}
                        data-testid={`dept-actions-${d.id}`}
                        aria-label="Department actions"
                        className="rounded-lg p-1.5 text-gray-500 hover:bg-gray-100 hover:text-gray-700 dark:text-gray-400 dark:hover:bg-gray-700 dark:hover:text-gray-200"
                      >
                        <MoreVertical size={18} />
                      </button>
                      {menuFor === d.id && (
                        <>
                          {/* click-away backdrop */}
                          <div
                            className="fixed inset-0 z-10"
                            onClick={() => setMenuFor(null)}
                          />
                          <div
                            className="absolute right-0 z-20 mt-1 w-48 overflow-hidden rounded-lg border bg-white py-1 shadow-lg dark:border-gray-700 dark:bg-gray-800"
                            data-testid={`dept-menu-${d.id}`}
                          >
                            {d.active ? (
                              <>
                                <MenuItem
                                  icon={UserPlus}
                                  label="Add member"
                                  testid={`dept-members-${d.id}`}
                                  onClick={() => {
                                    setMenuFor(null);
                                    openMembers(d);
                                  }}
                                />
                                <MenuItem
                                  icon={Pencil}
                                  label="Edit"
                                  testid={`dept-edit-${d.id}`}
                                  onClick={() => {
                                    setMenuFor(null);
                                    openEdit(d);
                                  }}
                                />
                                <MenuItem
                                  icon={Power}
                                  label="Deactivate"
                                  testid={`dept-toggle-${d.id}`}
                                  onClick={() => {
                                    setMenuFor(null);
                                    setConfirm({ dept: d, kind: "deactivate" });
                                  }}
                                />
                                <MenuItem
                                  icon={Trash2}
                                  label="Delete"
                                  testid={`dept-delete-${d.id}`}
                                  danger
                                  onClick={() => {
                                    setMenuFor(null);
                                    setConfirm({ dept: d, kind: "delete" });
                                  }}
                                />
                              </>
                            ) : (
                              // Inactive department — reactivate or permanently delete.
                              <>
                                <MenuItem
                                  icon={Power}
                                  label="Reactivate"
                                  testid={`dept-toggle-${d.id}`}
                                  onClick={() => {
                                    setMenuFor(null);
                                    void activate(d);
                                  }}
                                />
                                <MenuItem
                                  icon={Trash2}
                                  label="Permanently delete"
                                  testid={`dept-permanent-${d.id}`}
                                  danger
                                  onClick={() => {
                                    setMenuFor(null);
                                    setConfirm({ dept: d, kind: "permanent" });
                                  }}
                                />
                              </>
                            )}
                          </div>
                        </>
                      )}
                    </div>
                    )}
                  </div>
                </div>

                {/* Stat tiles — accent bar + icon, matching the mock */}
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <CardStat
                    icon={ClipboardList}
                    value={s?.openRequests ?? 0}
                    label="Open Requests"
                    tone="violet"
                  />
                  <CardStat
                    icon={CheckCircle2}
                    value={s?.completedRequests ?? 0}
                    label="Completed"
                    tone="blue"
                  />
                  <CardStat
                    icon={PackageCheck}
                    value={s?.issuedUnits ?? 0}
                    label="Units Issued"
                    tone="emerald"
                  />
                </div>

                {/* Footer: members hint + View Details */}
                <div className="mt-5 flex items-center justify-between gap-3 border-t pt-4 dark:border-gray-700/70">
                  <div className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
                    <Users size={16} className="shrink-0" />
                    <span>
                      {canManage
                        ? "Manage members & material requests for this department."
                        : "View members, material requests, and stock for this department."}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => router.push(`/dashboard/departments/${d.id}`)}
                    data-testid={`dept-view-${d.id}`}
                    className="inline-flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-semibold text-primary hover:bg-primary/5 dark:text-blue-400 dark:hover:bg-blue-950/30"
                  >
                    View Details <ArrowRight size={16} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ── Create / Edit modal ── */}
      {modalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          data-testid="dept-modal"
          role="dialog"
          aria-modal="true"
        >
          <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl dark:border dark:border-gray-700 dark:bg-gray-800">
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-lg font-semibold">
                {editing ? "Edit Department" : "New Department"}
              </h3>
              <button
                type="button"
                onClick={() => setModalOpen(false)}
                data-testid="dept-modal-close"
                className="rounded-md p-1 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700"
              >
                <X size={18} />
              </button>
            </div>
            <div className="space-y-3">
              <div>
                <label htmlFor="dept-name" className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-300">
                  Name
                </label>
                <input
                  id="dept-name"
                  type="text"
                  value={formName}
                  onChange={(e) => setFormName(e.target.value)}
                  placeholder="e.g. Radiology"
                  data-testid="dept-name-input"
                  className={FIELD}
                />
              </div>
              <div>
                <label htmlFor="dept-code" className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-300">
                  Code
                </label>
                <input
                  id="dept-code"
                  type="text"
                  value={formCode}
                  onChange={(e) => setFormCode(e.target.value.toUpperCase())}
                  placeholder="e.g. RADIOLOGY"
                  data-testid="dept-code-input"
                  className={`${FIELD} uppercase`}
                />
                <p className="mt-1 text-xs text-gray-400">
                  Short unique code — letters, digits, underscores.
                </p>
              </div>
              {editing && (
                <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
                  <input
                    type="checkbox"
                    checked={formActive}
                    onChange={(e) => setFormActive(e.target.checked)}
                    data-testid="dept-active-input"
                  />
                  Active
                </label>
              )}
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setModalOpen(false)}
                className="rounded-lg border px-3 py-2 text-sm font-medium hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-700"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={submitForm}
                disabled={submitting}
                data-testid="dept-submit"
                className="rounded-lg bg-primary px-3 py-2 text-sm font-medium text-white hover:bg-primary/90 disabled:opacity-50"
              >
                {submitting ? "Saving…" : editing ? "Save Changes" : "Create"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Confirm dialog (deactivate / delete) ── */}
      {confirm && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4"
          style={{ zIndex: 60 }}
          data-testid="dept-confirm"
          role="dialog"
          aria-modal="true"
        >
          {(() => {
            const isDelete = confirm.kind === "delete" || confirm.kind === "permanent";
            const hasHistory = confirm.dept.requisitionCount > 0;
            // Permanent delete is blocked when the department has history.
            const blocked = confirm.kind === "permanent" && hasHistory;
            const title =
              confirm.kind === "permanent"
                ? "Permanently delete?"
                : confirm.kind === "delete"
                ? "Delete department?"
                : "Deactivate department?";
            return (
          <div className="w-full max-w-sm rounded-xl bg-white p-6 shadow-xl dark:border dark:border-gray-700 dark:bg-gray-800">
            <div className="mb-3 flex items-center gap-3">
              <div
                className={`flex h-10 w-10 items-center justify-center rounded-full ${
                  isDelete
                    ? "bg-red-100 text-red-600 dark:bg-red-950/40 dark:text-red-300"
                    : "bg-amber-100 text-amber-600 dark:bg-amber-950/40 dark:text-amber-300"
                }`}
              >
                <AlertTriangle size={20} />
              </div>
              <h3 className="text-lg font-semibold">{title}</h3>
            </div>
            <p className="mb-5 text-sm text-gray-600 dark:text-gray-300">
              {blocked ? (
                <>
                  <strong>{confirm.dept.name}</strong> has{" "}
                  {confirm.dept.requisitionCount} request(s) on record and{" "}
                  <strong>cannot be permanently deleted</strong> — that would
                  destroy the request history. Keep it deactivated instead.
                </>
              ) : confirm.kind === "permanent" ? (
                <>
                  <strong>{confirm.dept.name}</strong> will be{" "}
                  <strong>permanently deleted</strong>. This cannot be undone.
                </>
              ) : confirm.kind === "delete" ? (
                hasHistory ? (
                  <>
                    <strong>{confirm.dept.name}</strong> has{" "}
                    {confirm.dept.requisitionCount} request(s) on record, so it
                    will be <strong>deactivated</strong> (kept for history) rather
                    than permanently deleted.
                  </>
                ) : (
                  <>
                    <strong>{confirm.dept.name}</strong> has no request history and
                    will be <strong>permanently deleted</strong>. This cannot be
                    undone.
                  </>
                )
              ) : (
                <>
                  <strong>{confirm.dept.name}</strong> will be hidden from the
                  requisition picker. You can reactivate it any time.
                </>
              )}
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirm(null)}
                data-testid="dept-confirm-cancel"
                className="rounded-lg border px-3 py-2 text-sm font-medium hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-700"
              >
                {blocked ? "Close" : "Cancel"}
              </button>
              {!blocked && (
              <button
                type="button"
                onClick={() => void runConfirm()}
                data-testid="dept-confirm-ok"
                className={`rounded-lg px-3 py-2 text-sm font-medium text-white ${
                  isDelete
                    ? "bg-red-600 hover:bg-red-700"
                    : "bg-amber-500 hover:bg-amber-600"
                }`}
              >
                {confirm.kind === "permanent"
                  ? "Delete permanently"
                  : confirm.kind === "delete"
                  ? "Delete"
                  : "Deactivate"}
              </button>
              )}
            </div>
          </div>
            );
          })()}
        </div>
      )}

      {/* ── Members drawer ── */}
      {membersFor && (
        <div
          className="fixed inset-0 z-50 flex justify-end bg-black/40"
          data-testid="dept-members-drawer"
          role="dialog"
          aria-modal="true"
          onClick={() => setMembersFor(null)}
        >
          <div
            className="flex h-full w-full max-w-md flex-col bg-white shadow-xl dark:bg-gray-800"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b px-5 py-4 dark:border-gray-700">
              <div>
                <h3 className="flex items-center gap-2 text-lg font-semibold">
                  <Users size={18} /> {membersFor.name}
                </h3>
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  Members of this department
                </p>
              </div>
              <button
                type="button"
                onClick={() => setMembersFor(null)}
                data-testid="dept-members-close"
                className="rounded-md p-1 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700"
              >
                <X size={18} />
              </button>
            </div>

            {/* Search-and-add box */}
            <div className="border-b px-5 py-4 dark:border-gray-700">
              <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-300">
                Add member
              </label>
              <div className="relative">
                <Search
                  size={16}
                  className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400"
                />
                <input
                  type="text"
                  value={memberQuery}
                  onChange={(e) => setMemberQuery(e.target.value)}
                  placeholder="Search staff by name, email or phone…"
                  data-testid="dept-member-search"
                  className={`${FIELD} pl-9`}
                />
              </div>
              {/* Search results */}
              {memberQuery.trim().length > 0 && (searching || memberResults.length > 0) && (
                <div className="mt-2 max-h-56 overflow-y-auto rounded-lg border dark:border-gray-700">
                  {searching ? (
                    <p className="p-3 text-sm text-gray-400">Searching…</p>
                  ) : (
                    memberResults.map((u) => (
                      <button
                        key={u.id}
                        type="button"
                        onClick={() => addMember(u)}
                        data-testid={`dept-member-add-${u.id}`}
                        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-gray-50 dark:hover:bg-gray-700/60"
                      >
                        <span>
                          <span className="font-medium">{u.name}</span>
                          <span className="ml-2 text-xs text-gray-400">{u.role}</span>
                          {u.email && (
                            <span className="block text-xs text-gray-400">{u.email}</span>
                          )}
                        </span>
                        <UserPlus size={16} className="shrink-0 text-primary" />
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>

            {/* Current members */}
            <div className="flex-1 overflow-y-auto px-5 py-4">
              {membersLoading ? (
                <SkeletonTable rows={4} columns={2} />
              ) : members.length === 0 ? (
                <p className="py-8 text-center text-sm text-gray-400" data-testid="dept-members-empty">
                  No members yet. Search above to add staff.
                </p>
              ) : (
                <ul className="space-y-2" data-testid="dept-members-list">
                  {members.map((m) => (
                    <li
                      key={m.id}
                      className="flex items-center justify-between rounded-lg border px-3 py-2 dark:border-gray-700"
                    >
                      <div>
                        <p className="text-sm font-medium">{m.user.name}</p>
                        <p className="text-xs text-gray-400">
                          {m.user.role}
                          {m.user.email ? ` · ${m.user.email}` : ""}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => removeMember(m)}
                        data-testid={`dept-member-remove-${m.userId}`}
                        title="Remove"
                        className="rounded-md p-1.5 text-red-500 hover:bg-red-50 dark:hover:bg-red-950/40"
                      >
                        <UserMinus size={15} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Small presentational helpers ──────────────────────────────────────────
const TILE_TONE: Record<string, string> = {
  slate: "bg-slate-100 text-slate-600 dark:bg-slate-900/50 dark:text-slate-300",
  emerald: "bg-emerald-100 text-emerald-600 dark:bg-emerald-950/40 dark:text-emerald-300",
  gray: "bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300",
  amber: "bg-amber-100 text-amber-600 dark:bg-amber-950/40 dark:text-amber-300",
  blue: "bg-blue-100 text-blue-600 dark:bg-blue-950/40 dark:text-blue-300",
};

function StatTile({
  label,
  value,
  icon: Icon,
  tone,
}: {
  label: string;
  value: number;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  tone: keyof typeof TILE_TONE;
}) {
  return (
    <div className="rounded-xl bg-white p-4 shadow-sm dark:border dark:border-gray-700 dark:bg-gray-800">
      <div className="flex items-center gap-3">
        <div className={`flex h-10 w-10 items-center justify-center rounded-lg ${TILE_TONE[tone]}`}>
          <Icon size={18} />
        </div>
        <div>
          <p className="text-xs text-gray-500 dark:text-gray-400">{label}</p>
          <p className="text-xl font-bold tabular-nums">{value}</p>
        </div>
      </div>
    </div>
  );
}

// Stat tile inside a department card: a left accent bar, an icon chip, the big
// number and its label — matching the dashboard mock.
const CARD_STAT_TONE: Record<
  string,
  { bar: string; chip: string }
> = {
  violet: {
    bar: "bg-violet-500",
    chip: "bg-violet-100 text-violet-600 dark:bg-violet-950/50 dark:text-violet-300",
  },
  blue: {
    bar: "bg-blue-500",
    chip: "bg-blue-100 text-blue-600 dark:bg-blue-950/50 dark:text-blue-300",
  },
  emerald: {
    bar: "bg-emerald-500",
    chip: "bg-emerald-100 text-emerald-600 dark:bg-emerald-950/50 dark:text-emerald-300",
  },
};

function CardStat({
  icon: Icon,
  value,
  label,
  tone,
}: {
  icon: React.ComponentType<{ size?: number; className?: string }>;
  value: number;
  label: string;
  tone: keyof typeof CARD_STAT_TONE;
}) {
  const t = CARD_STAT_TONE[tone];
  return (
    <div className="relative overflow-hidden rounded-xl border bg-gray-50/60 p-4 dark:border-gray-700/60 dark:bg-gray-900/40">
      <span className={`absolute inset-y-0 left-0 w-1 ${t.bar}`} />
      <div className="flex items-center gap-3">
        <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${t.chip}`}>
          <Icon size={16} />
        </div>
        <div>
          <p className="text-2xl font-bold leading-none tabular-nums">{value}</p>
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{label}</p>
        </div>
      </div>
    </div>
  );
}

function MenuItem({
  icon: Icon,
  label,
  onClick,
  testid,
  danger,
}: {
  icon: React.ComponentType<{ size?: number; className?: string }>;
  label: string;
  onClick: () => void;
  testid?: string;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testid}
      className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-gray-50 dark:hover:bg-gray-700/60 ${
        danger ? "text-red-600 dark:text-red-400" : "text-gray-700 dark:text-gray-200"
      }`}
    >
      <Icon size={15} /> {label}
    </button>
  );
}
