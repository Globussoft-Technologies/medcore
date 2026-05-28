"use client";

// SOW row M4 closure — care cohorts detail page.
//
// Shows: cohort name + description (editable via inline modal), member
// list with patient details, and an Add-member surface backed by the
// shared EntityPicker (search the patient list, pick one, optional note,
// submit). Per-row remove. Archive/restore lives on the list page.

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import { useAuthStore } from "@/lib/store";
import { EntityPicker } from "@/components/EntityPicker";
import {
  ArrowLeft,
  Users2,
  UserMinus,
  Plus,
  Pencil,
  Archive,
  ArchiveRestore,
  Loader2,
} from "lucide-react";

interface MemberPatient {
  id: string;
  mrNumber: string;
  gender: string;
  age: number | null;
  dateOfBirth: string | null;
  user: { id: string; name: string; phone: string | null };
}

interface CohortMember {
  id: string;
  cohortId: string;
  patientId: string;
  note: string | null;
  addedAt: string;
  patient: MemberPatient;
  addedByUser?: { id: string; name: string } | null;
}

interface CohortDetail {
  id: string;
  name: string;
  description: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  createdByUser?: { id: string; name: string } | null;
  members: CohortMember[];
}

const WRITE_ROLES = new Set(["ADMIN", "DOCTOR", "NURSE"]);

export default function CohortDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const cohortId = params?.id;
  const { user } = useAuthStore();
  const canWrite = !!user?.role && WRITE_ROLES.has(user.role);

  const [cohort, setCohort] = useState<CohortDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  // Add-member form
  const [selectedPatientId, setSelectedPatientId] = useState("");
  const [memberNote, setMemberNote] = useState("");
  const [adding, setAdding] = useState(false);

  // Rename modal
  const [editOpen, setEditOpen] = useState(false);
  const [editForm, setEditForm] = useState({ name: "", description: "" });
  const [editing, setEditing] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  const load = async () => {
    if (!cohortId) return;
    setLoading(true);
    try {
      const res = await api.get<{ data: CohortDetail }>(`/cohorts/${cohortId}`);
      if (res?.data) {
        setCohort(res.data);
        setNotFound(false);
      } else {
        setNotFound(true);
      }
    } catch (err) {
      const status =
        err && typeof err === "object" && "status" in err
          ? (err as { status?: number }).status
          : undefined;
      if (status === 404) {
        setNotFound(true);
      } else {
        toast.error(
          err instanceof Error ? err.message : "Failed to load cohort",
        );
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cohortId]);

  async function handleAddMember(e: React.FormEvent) {
    e.preventDefault();
    if (adding || !selectedPatientId || !cohortId) return;
    setAdding(true);
    try {
      await api.post(`/cohorts/${cohortId}/members`, {
        patientId: selectedPatientId,
        note: memberNote.trim() || null,
      });
      toast.success("Patient added to cohort");
      setSelectedPatientId("");
      setMemberNote("");
      void load();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to add patient",
      );
    } finally {
      setAdding(false);
    }
  }

  async function handleRemoveMember(patientId: string, patientName: string) {
    if (!cohortId) return;
    if (
      !window.confirm(
        `Remove ${patientName} from "${cohort?.name}"? They can be re-added later.`,
      )
    )
      return;
    try {
      await api.delete(`/cohorts/${cohortId}/members/${patientId}`);
      toast.success("Patient removed");
      void load();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to remove patient",
      );
    }
  }

  function openEdit() {
    if (!cohort) return;
    setEditForm({
      name: cohort.name,
      description: cohort.description ?? "",
    });
    setEditError(null);
    setEditOpen(true);
  }

  async function handleEdit(e: React.FormEvent) {
    e.preventDefault();
    if (editing || !cohortId) return;
    setEditError(null);
    const name = editForm.name.trim();
    if (name.length < 2) {
      setEditError("Name must be at least 2 characters");
      return;
    }
    setEditing(true);
    try {
      await api.patch(`/cohorts/${cohortId}`, {
        name,
        description: editForm.description.trim() || null,
      });
      toast.success("Cohort updated");
      setEditOpen(false);
      void load();
    } catch (err) {
      setEditError(
        err instanceof Error ? err.message : "Failed to update cohort",
      );
    } finally {
      setEditing(false);
    }
  }

  async function handleArchiveToggle() {
    if (!cohort || !cohortId) return;
    const action = cohort.archivedAt ? "restore" : "archive";
    try {
      await api.post(`/cohorts/${cohortId}/${action}`, {});
      toast.success(`Cohort ${action}d`);
      void load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Action failed");
    }
  }

  if (loading) {
    return (
      <div className="p-6" data-testid="cohort-detail-loading">
        <Loader2 className="mx-auto mt-12 h-6 w-6 animate-spin text-gray-400" />
      </div>
    );
  }

  if (notFound || !cohort) {
    return (
      <div className="p-6" data-testid="cohort-detail-notfound">
        <div className="mx-auto max-w-md rounded-2xl border border-gray-200 bg-white p-8 text-center shadow-sm dark:border-gray-800 dark:bg-gray-900">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
            Cohort not found
          </h2>
          <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
            It may have been deleted, or you don&apos;t have access.
          </p>
          <button
            type="button"
            onClick={() => router.push("/dashboard/cohorts")}
            className="mt-5 inline-flex h-11 items-center justify-center rounded-xl bg-blue-600 px-4 text-sm font-semibold text-white"
          >
            Back to cohorts
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      className="p-6 text-gray-900 dark:text-gray-100"
      data-testid="cohort-detail-page"
    >
      {/* Breadcrumb */}
      <Link
        href="/dashboard/cohorts"
        className="mb-4 inline-flex items-center gap-1 text-sm text-gray-600 hover:text-blue-600 dark:text-gray-400 dark:hover:text-blue-400"
        data-testid="cohort-back-link"
      >
        <ArrowLeft className="h-4 w-4" />
        All cohorts
      </Link>

      {/* Header */}
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h1
            className="flex items-center gap-2 text-2xl font-semibold"
            data-testid="cohort-detail-name"
          >
            <Users2 className="h-6 w-6 text-blue-600 dark:text-blue-400" />
            {cohort.name}
            {cohort.archivedAt ? (
              <span className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">
                Archived
              </span>
            ) : null}
          </h1>
          {cohort.description ? (
            <p
              className="mt-2 max-w-3xl text-sm text-gray-600 dark:text-gray-400"
              data-testid="cohort-detail-description"
            >
              {cohort.description}
            </p>
          ) : null}
          <p className="mt-2 text-xs text-gray-500">
            {cohort.members.length} {cohort.members.length === 1 ? "member" : "members"}
            {cohort.createdByUser?.name
              ? ` · Created by ${cohort.createdByUser.name}`
              : ""}
            {" · "}
            {new Date(cohort.createdAt).toLocaleDateString("en-IN", {
              day: "2-digit",
              month: "short",
              year: "numeric",
            })}
          </p>
        </div>
        {canWrite ? (
          <div className="flex flex-shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={openEdit}
              className="inline-flex h-11 min-w-[44px] items-center justify-center gap-1.5 rounded-xl border border-gray-300 px-4 text-sm font-medium text-gray-700 transition hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
              data-testid="cohort-edit-btn"
            >
              <Pencil className="h-4 w-4" />
              Edit
            </button>
            <button
              type="button"
              onClick={handleArchiveToggle}
              className="inline-flex h-11 min-w-[44px] items-center justify-center gap-1.5 rounded-xl border border-gray-300 px-4 text-sm font-medium text-gray-700 transition hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
              data-testid="cohort-archive-toggle"
            >
              {cohort.archivedAt ? (
                <>
                  <ArchiveRestore className="h-4 w-4" />
                  Restore
                </>
              ) : (
                <>
                  <Archive className="h-4 w-4" />
                  Archive
                </>
              )}
            </button>
          </div>
        ) : null}
      </div>

      {/* Add member */}
      {canWrite && !cohort.archivedAt ? (
        <div
          className="mb-6 rounded-2xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-800 dark:bg-gray-900"
          data-testid="cohort-add-member-card"
        >
          <h2 className="text-sm font-semibold uppercase tracking-wider text-gray-700 dark:text-gray-300">
            Add a patient
          </h2>
          <form
            onSubmit={handleAddMember}
            className="mt-4 grid gap-3 sm:grid-cols-[2fr_2fr_auto]"
          >
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">
                Patient
              </label>
              <EntityPicker
                endpoint="/patients"
                searchParam="search"
                labelField="user.name"
                subtitleField="mrNumber"
                hintField="user.phone"
                value={selectedPatientId}
                onChange={(id) => setSelectedPatientId(id)}
                searchPlaceholder="Search by name, MR number, phone…"
                testIdPrefix="cohort-add-patient"
                disabled={adding}
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">
                Note <span className="text-gray-400">(optional)</span>
              </label>
              <input
                type="text"
                value={memberNote}
                onChange={(e) => setMemberNote(e.target.value)}
                placeholder="e.g. HbA1c > 8.0"
                disabled={adding}
                className="block h-11 w-full rounded-xl border border-gray-300 bg-white px-3 text-sm text-gray-900 placeholder:text-gray-400 focus:border-blue-500 focus:outline-none focus:ring-4 focus:ring-blue-500/15 dark:border-gray-700 dark:bg-gray-950 dark:text-white"
                data-testid="cohort-add-note-input"
              />
            </div>
            <div className="flex items-end">
              <button
                type="submit"
                disabled={adding || !selectedPatientId}
                className="inline-flex h-11 min-w-[44px] items-center justify-center gap-1.5 rounded-xl bg-blue-600 px-4 text-sm font-semibold text-white shadow-sm shadow-blue-600/20 transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
                data-testid="cohort-add-submit"
              >
                <Plus className="h-4 w-4" />
                {adding ? "Adding…" : "Add"}
              </button>
            </div>
          </form>
        </div>
      ) : null}

      {/* Member list */}
      <div className="overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm dark:border-gray-800 dark:bg-gray-900">
        <div className="border-b border-gray-200 px-5 py-3 dark:border-gray-800">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-gray-700 dark:text-gray-300">
            Members
          </h2>
        </div>
        {cohort.members.length === 0 ? (
          <div
            className="p-12 text-center text-sm text-gray-500"
            data-testid="cohort-members-empty"
          >
            No members yet.
            {canWrite && !cohort.archivedAt
              ? " Use the form above to add patients."
              : ""}
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-left text-xs font-semibold uppercase tracking-wider text-gray-600 dark:bg-gray-900/50 dark:text-gray-400">
              <tr>
                <th className="px-5 py-3">Patient</th>
                <th className="px-5 py-3">MR number</th>
                <th className="px-5 py-3">Phone</th>
                <th className="px-5 py-3">Note</th>
                <th className="px-5 py-3">Added</th>
                {canWrite ? (
                  <th className="px-5 py-3 text-right">Actions</th>
                ) : null}
              </tr>
            </thead>
            <tbody data-testid="cohort-members-list">
              {cohort.members.map((m) => (
                <tr
                  key={m.id}
                  data-testid={`cohort-member-row-${m.patient.id}`}
                  className="border-t border-gray-200 transition hover:bg-gray-50 dark:border-gray-800 dark:hover:bg-gray-900/40"
                >
                  <td className="px-5 py-3">
                    <Link
                      href={`/dashboard/patients/${m.patient.id}`}
                      className="font-medium text-gray-900 hover:text-blue-600 dark:text-white dark:hover:text-blue-400"
                    >
                      {m.patient.user.name}
                    </Link>
                    <p className="text-xs text-gray-500">
                      {m.patient.gender}
                      {m.patient.age != null ? ` · ${m.patient.age}y` : ""}
                    </p>
                  </td>
                  <td className="px-5 py-3 font-mono text-xs text-gray-700 dark:text-gray-300">
                    {m.patient.mrNumber}
                  </td>
                  <td className="px-5 py-3 text-xs text-gray-700 dark:text-gray-300">
                    {m.patient.user.phone ?? "—"}
                  </td>
                  <td className="px-5 py-3 text-xs text-gray-600 dark:text-gray-400">
                    {m.note ?? "—"}
                  </td>
                  <td className="px-5 py-3 text-xs text-gray-500">
                    {new Date(m.addedAt).toLocaleDateString("en-IN", {
                      day: "2-digit",
                      month: "short",
                      year: "numeric",
                    })}
                    {m.addedByUser?.name ? (
                      <p className="text-[11px] text-gray-400">
                        by {m.addedByUser.name}
                      </p>
                    ) : null}
                  </td>
                  {canWrite ? (
                    <td className="px-5 py-3 text-right">
                      <button
                        type="button"
                        onClick={() =>
                          handleRemoveMember(m.patient.id, m.patient.user.name)
                        }
                        data-testid={`cohort-remove-${m.patient.id}`}
                        className="inline-flex h-9 min-w-[44px] items-center justify-center gap-1 rounded-lg border border-red-200 px-3 text-xs font-medium text-red-700 transition hover:bg-red-50 dark:border-red-900/50 dark:text-red-300 dark:hover:bg-red-950/30"
                      >
                        <UserMinus className="h-3.5 w-3.5" />
                        Remove
                      </button>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Edit modal */}
      {editOpen ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => !editing && setEditOpen(false)}
          data-testid="cohort-edit-modal"
        >
          <div
            className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl dark:bg-gray-900"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
              Edit cohort
            </h2>
            <form onSubmit={handleEdit} className="mt-5 space-y-4">
              <div className="space-y-1.5">
                <label
                  htmlFor="cohort-edit-name"
                  className="block text-sm font-medium text-gray-800 dark:text-gray-200"
                >
                  Name
                </label>
                <input
                  id="cohort-edit-name"
                  data-testid="cohort-edit-name-input"
                  type="text"
                  value={editForm.name}
                  onChange={(e) =>
                    setEditForm((p) => ({ ...p, name: e.target.value }))
                  }
                  className="block h-11 w-full rounded-xl border border-gray-300 bg-white px-3 text-sm text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-4 focus:ring-blue-500/15 dark:border-gray-700 dark:bg-gray-950 dark:text-white"
                  disabled={editing}
                  required
                  autoFocus
                />
              </div>
              <div className="space-y-1.5">
                <label
                  htmlFor="cohort-edit-description"
                  className="block text-sm font-medium text-gray-800 dark:text-gray-200"
                >
                  Description
                </label>
                <textarea
                  id="cohort-edit-description"
                  data-testid="cohort-edit-description-input"
                  rows={3}
                  value={editForm.description}
                  onChange={(e) =>
                    setEditForm((p) => ({ ...p, description: e.target.value }))
                  }
                  className="block w-full rounded-xl border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-4 focus:ring-blue-500/15 dark:border-gray-700 dark:bg-gray-950 dark:text-white"
                  disabled={editing}
                />
              </div>
              {editError ? (
                <p
                  className="rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-red-800 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-300"
                  data-testid="cohort-edit-error"
                >
                  {editError}
                </p>
              ) : null}
              <div className="flex items-center justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setEditOpen(false)}
                  disabled={editing}
                  className="inline-flex h-11 min-w-[44px] items-center justify-center rounded-xl border border-gray-300 px-4 text-sm font-medium text-gray-700 transition hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
                  data-testid="cohort-edit-cancel"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={editing}
                  className="inline-flex h-11 min-w-[44px] items-center justify-center rounded-xl bg-blue-600 px-4 text-sm font-semibold text-white shadow-sm shadow-blue-600/20 transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
                  data-testid="cohort-edit-submit"
                >
                  {editing ? "Saving…" : "Save changes"}
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </div>
  );
}
