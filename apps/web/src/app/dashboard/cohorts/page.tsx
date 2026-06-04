"use client";

// SOW row M4 closure — care cohorts list page.
//
// List + filter + create-cohort modal. Each row links to the detail
// page (cohorts/[id]) for member management. Archived cohorts are
// hidden by default and surfaced via a "Show archived" toggle.

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import { useAuthStore } from "@/lib/store";
import {
  Plus,
  Search,
  Users2,
  Archive,
  ArchiveRestore,
} from "lucide-react";
import { SkeletonRow } from "@/components/Skeleton";

interface Cohort {
  id: string;
  name: string;
  description: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  createdByUser?: { id: string; name: string } | null;
  _count?: { members: number };
}

const WRITE_ROLES = new Set(["ADMIN", "DOCTOR", "NURSE"]);

export default function CohortsPage() {
  const { user } = useAuthStore();
  const canWrite = !!user?.role && WRITE_ROLES.has(user.role);

  const [cohorts, setCohorts] = useState<Cohort[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState({ name: "", description: "" });
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (search.trim()) params.set("search", search.trim());
      if (showArchived) params.set("includeArchived", "true");
      const qs = params.toString();
      const res = await api.get<{ data: Cohort[] }>(
        `/cohorts${qs ? `?${qs}` : ""}`,
      );
      setCohorts(Array.isArray(res?.data) ? res.data : []);
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to load cohorts",
      );
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showArchived]);

  // Re-fetch on debounced search (300ms).
  useEffect(() => {
    const t = setTimeout(() => void load(), 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  const visible = useMemo(() => cohorts, [cohorts]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setFormError(null);
    const name = form.name.trim();
    if (name.length < 2) {
      setFormError("Name must be at least 2 characters");
      return;
    }
    setSubmitting(true);
    try {
      await api.post("/cohorts", {
        name,
        description: form.description.trim() || null,
      });
      toast.success("Cohort created");
      setCreateOpen(false);
      setForm({ name: "", description: "" });
      void load();
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : "Failed to create cohort";
      setFormError(msg);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleArchive(id: string, archived: boolean) {
    try {
      await api.post(`/cohorts/${id}/${archived ? "restore" : "archive"}`, {});
      toast.success(archived ? "Cohort restored" : "Cohort archived");
      void load();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Action failed",
      );
    }
  }

  return (
    <div
      className="p-6 text-gray-900 dark:text-gray-100"
      data-testid="cohorts-page"
    >
      {/* Header */}
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold">
            <Users2 className="h-6 w-6 text-blue-600 dark:text-blue-400" />
            Care Cohorts
          </h1>
          <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
            Named groups of patients — for outbound calls, batched reminders,
            and follow-up campaigns.
          </p>
        </div>
        {canWrite ? (
          <button
            type="button"
            onClick={() => setCreateOpen(true)}
            className="inline-flex h-11 min-w-[44px] items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 text-sm font-semibold text-white shadow-sm shadow-blue-600/20 transition hover:bg-blue-700"
            data-testid="cohorts-create-btn"
          >
            <Plus className="h-4 w-4" />
            New Cohort
          </button>
        ) : null}
      </div>

      {/* Filters */}
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
          <input
            type="text"
            placeholder="Search cohorts by name or description…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            data-testid="cohorts-search-input"
            className="block h-11 w-full rounded-xl border border-gray-300 bg-white pl-10 pr-3 text-sm text-gray-900 placeholder:text-gray-400 transition focus:border-blue-500 focus:outline-none focus:ring-4 focus:ring-blue-500/15 dark:border-gray-700 dark:bg-gray-900 dark:text-white"
          />
        </div>
        <label className="inline-flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(e) => setShowArchived(e.target.checked)}
            data-testid="cohorts-show-archived-input"
            className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
          />
          Show archived
        </label>
      </div>

      {/* List */}
      <div className="overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm dark:border-gray-800 dark:bg-gray-900">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-left text-xs font-semibold uppercase tracking-wider text-gray-600 dark:bg-gray-900/50 dark:text-gray-400">
            <tr>
              <th className="px-4 py-3">Name</th>
              <th className="px-4 py-3">Members</th>
              <th className="px-4 py-3">Created by</th>
              <th className="px-4 py-3">Created</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody data-testid="cohorts-list">
            {loading ? (
              Array.from({ length: 6 }).map((_, i) => (
                <SkeletonRow key={i} columns={5} />
              ))
            ) : visible.length === 0 ? (
              <tr>
                <td
                  colSpan={5}
                  className="p-12 text-center text-sm text-gray-500"
                  data-testid="cohorts-empty"
                >
                  {search.trim()
                    ? "No cohorts match that search."
                    : showArchived
                      ? "No cohorts yet — archived view is empty too."
                      : "No cohorts yet. Create your first one to get started."}
                </td>
              </tr>
            ) : (
              visible.map((c) => (
                <tr
                  key={c.id}
                  data-testid={`cohort-row-${c.id}`}
                  className="border-t border-gray-200 transition hover:bg-gray-50 dark:border-gray-800 dark:hover:bg-gray-900/40"
                >
                  <td className="px-4 py-3">
                    <Link
                      href={`/dashboard/cohorts/${c.id}`}
                      className="font-medium text-gray-900 hover:text-blue-600 dark:text-white dark:hover:text-blue-400"
                      data-testid={`cohort-link-${c.id}`}
                    >
                      {c.name}
                    </Link>
                    {c.archivedAt ? (
                      <span className="ml-2 inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">
                        Archived
                      </span>
                    ) : null}
                    {c.description ? (
                      <p className="mt-0.5 truncate text-xs text-gray-500 dark:text-gray-400">
                        {c.description}
                      </p>
                    ) : null}
                  </td>
                  <td className="px-4 py-3 text-gray-700 dark:text-gray-300">
                    <span className="inline-flex items-center gap-1 rounded-full bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-700 dark:bg-blue-950/40 dark:text-blue-300">
                      <Users2 className="h-3 w-3" />
                      {c._count?.members ?? 0}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-500">
                    {c.createdByUser?.name ?? "—"}
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-500">
                    {new Date(c.createdAt).toLocaleDateString("en-IN", {
                      day: "2-digit",
                      month: "short",
                      year: "numeric",
                    })}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {canWrite ? (
                      <button
                        type="button"
                        onClick={() => handleArchive(c.id, !!c.archivedAt)}
                        data-testid={`cohort-archive-${c.id}`}
                        className="inline-flex h-9 min-w-[44px] items-center justify-center gap-1 rounded-lg border border-gray-300 px-3 text-xs font-medium text-gray-700 transition hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
                      >
                        {c.archivedAt ? (
                          <>
                            <ArchiveRestore className="h-3.5 w-3.5" />
                            Restore
                          </>
                        ) : (
                          <>
                            <Archive className="h-3.5 w-3.5" />
                            Archive
                          </>
                        )}
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Create modal */}
      {createOpen ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => !submitting && setCreateOpen(false)}
          data-testid="cohort-create-modal"
        >
          <div
            className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl dark:bg-gray-900"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
              New Cohort
            </h2>
            <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
              Group patients you want to act on together.
            </p>
            <form onSubmit={handleCreate} className="mt-5 space-y-4">
              <div className="space-y-1.5">
                <label
                  htmlFor="cohort-name"
                  className="block text-sm font-medium text-gray-800 dark:text-gray-200"
                >
                  Name
                </label>
                <input
                  id="cohort-name"
                  data-testid="cohort-name-input"
                  type="text"
                  value={form.name}
                  onChange={(e) =>
                    setForm((p) => ({ ...p, name: e.target.value }))
                  }
                  placeholder="e.g. Diabetic patients on insulin"
                  className="block h-11 w-full rounded-xl border border-gray-300 bg-white px-3 text-sm text-gray-900 placeholder:text-gray-400 focus:border-blue-500 focus:outline-none focus:ring-4 focus:ring-blue-500/15 dark:border-gray-700 dark:bg-gray-950 dark:text-white"
                  disabled={submitting}
                  required
                  autoFocus
                />
              </div>
              <div className="space-y-1.5">
                <label
                  htmlFor="cohort-description"
                  className="block text-sm font-medium text-gray-800 dark:text-gray-200"
                >
                  Description{" "}
                  <span className="text-xs font-normal text-gray-500">
                    (optional)
                  </span>
                </label>
                <textarea
                  id="cohort-description"
                  data-testid="cohort-description-input"
                  rows={3}
                  value={form.description}
                  onChange={(e) =>
                    setForm((p) => ({ ...p, description: e.target.value }))
                  }
                  placeholder="What's this group for? Who belongs in it?"
                  className="block w-full rounded-xl border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:border-blue-500 focus:outline-none focus:ring-4 focus:ring-blue-500/15 dark:border-gray-700 dark:bg-gray-950 dark:text-white"
                  disabled={submitting}
                />
              </div>
              {formError ? (
                <p
                  className="rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-red-800 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-300"
                  data-testid="cohort-create-error"
                >
                  {formError}
                </p>
              ) : null}
              <div className="flex items-center justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setCreateOpen(false)}
                  disabled={submitting}
                  className="inline-flex h-11 min-w-[44px] items-center justify-center rounded-xl border border-gray-300 px-4 text-sm font-medium text-gray-700 transition hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
                  data-testid="cohort-create-cancel"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="inline-flex h-11 min-w-[44px] items-center justify-center rounded-xl bg-blue-600 px-4 text-sm font-semibold text-white shadow-sm shadow-blue-600/20 transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
                  data-testid="cohort-create-submit"
                >
                  {submitting ? "Creating…" : "Create cohort"}
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </div>
  );
}
