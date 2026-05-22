"use client";

// Pearl ERP Stage 1 §3.3 (gap item #3) — CRM lead pipeline list page.
//
// Minimal MVP shape: list view + filter chips + create-lead modal +
// quick status pill that opens an inline status menu. Detail view +
// activity timeline + convert-to-patient modal are scaffolded as
// stub buttons that link to /dashboard/leads/:id (page deferred to
// the next scope-cut tick per the gap-doc TODO).

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import { useAuthStore } from "@/lib/store";
import {
  LEAD_STATUS_VALUES,
  LEAD_SOURCE_VALUES,
  type LeadStatus,
  type LeadSource,
} from "@medcore/shared";
import { Plus, Search, UserCheck } from "lucide-react";

interface Lead {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  source: LeadSource;
  status: LeadStatus;
  notes: string | null;
  createdAt: string;
  assignedToUser?: { id: string; name: string; role: string } | null;
  preferredDoctor?: { id: string; user: { name: string } } | null;
  _count?: { activities: number };
}

const STATUS_COLORS: Record<LeadStatus, string> = {
  NEW: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200",
  QUALIFIED: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-200",
  ENGAGED: "bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-200",
  BOOKED: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-200",
  CONVERTED: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-200",
  LOST: "bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-200",
};

export default function LeadsPage() {
  const { user } = useAuthStore();
  const [leads, setLeads] = useState<Lead[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<LeadStatus | "ALL">("ALL");
  const [sourceFilter, setSourceFilter] = useState<LeadSource | "ALL">("ALL");
  const [search, setSearch] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [newLead, setNewLead] = useState({
    name: "",
    phone: "",
    email: "",
    source: "PHONE" as LeadSource,
    notes: "",
  });

  const isStaff = !!user?.role && user.role !== "PATIENT";

  const load = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (statusFilter !== "ALL") params.set("status", statusFilter);
      if (sourceFilter !== "ALL") params.set("source", sourceFilter);
      if (search.trim()) params.set("q", search.trim());
      const res = await api.get<{ data: Lead[] }>(
        `/leads?${params.toString()}`,
      );
      setLeads(res.data ?? []);
    } catch (err: any) {
      toast.error(err?.message ?? "Failed to load leads");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter, sourceFilter]);

  const counts = useMemo(() => {
    const map: Record<string, number> = { ALL: leads.length };
    for (const s of LEAD_STATUS_VALUES) {
      map[s] = leads.filter((l) => l.status === s).length;
    }
    return map;
  }, [leads]);

  const handleCreate = async () => {
    if (!newLead.name.trim()) {
      toast.error("Name is required");
      return;
    }
    try {
      await api.post("/leads", {
        name: newLead.name.trim(),
        phone: newLead.phone.trim() || undefined,
        email: newLead.email.trim() || undefined,
        source: newLead.source,
        notes: newLead.notes.trim() || undefined,
      });
      toast.success("Lead created");
      setCreateOpen(false);
      setNewLead({ name: "", phone: "", email: "", source: "PHONE", notes: "" });
      void load();
    } catch (err: any) {
      toast.error(err?.message ?? "Failed to create lead");
    }
  };

  const handleStatusChange = async (lead: Lead, status: LeadStatus) => {
    if (lead.status === status) return;
    try {
      await api.patch(`/leads/${lead.id}`, { status });
      toast.success(`Moved to ${status}`);
      void load();
    } catch (err: any) {
      toast.error(err?.message ?? "Failed to update status");
    }
  };

  if (!isStaff) {
    return (
      <div className="p-6 text-sm text-gray-500 dark:text-gray-400">
        Lead pipeline is staff-only.
      </div>
    );
  }

  return (
    <div className="p-6 text-gray-900 dark:text-gray-100">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Leads</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            6-stage CRM pipeline · Pearl §3.3
          </p>
        </div>
        <button
          onClick={() => setCreateOpen(true)}
          className="flex items-center gap-2 rounded bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700"
          data-testid="leads-create-btn"
        >
          <Plus size={16} /> New lead
        </button>
      </div>

      {/* Stage chips */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <button
          onClick={() => setStatusFilter("ALL")}
          className={`rounded-full border px-3 py-1 text-xs ${statusFilter === "ALL" ? "border-blue-500 bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-200" : "border-gray-300 dark:border-gray-600"}`}
        >
          All ({counts.ALL ?? 0})
        </button>
        {LEAD_STATUS_VALUES.map((s) => (
          <button
            key={s}
            onClick={() => setStatusFilter(s)}
            className={`rounded-full border px-3 py-1 text-xs ${statusFilter === s ? "border-blue-500 bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-200" : "border-gray-300 dark:border-gray-600"}`}
          >
            {s.replace(/_/g, " ")} ({counts[s] ?? 0})
          </button>
        ))}
        <span className="ml-4 mr-1 h-5 w-px bg-gray-300 dark:bg-gray-600" aria-hidden="true" />
        <select
          value={sourceFilter}
          onChange={(e) => setSourceFilter(e.target.value as any)}
          className="rounded border border-gray-300 px-2 py-1 text-xs dark:border-gray-600 dark:bg-gray-800"
        >
          <option value="ALL">All sources</option>
          {LEAD_SOURCE_VALUES.map((s) => (
            <option key={s} value={s}>
              {s.replace(/_/g, " ")}
            </option>
          ))}
        </select>
        <div className="ml-auto flex items-center gap-2">
          <Search size={16} className="text-gray-400" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void load()}
            placeholder="Search name / phone / email"
            className="rounded border border-gray-300 px-2 py-1 text-sm dark:border-gray-600 dark:bg-gray-800"
          />
        </div>
      </div>

      {/* Table */}
      <div className="overflow-x-auto rounded-xl bg-white shadow-sm dark:bg-gray-800">
        <table className="w-full min-w-[820px] text-sm">
          <thead className="bg-gray-50 text-xs uppercase text-gray-500 dark:bg-gray-900/50 dark:text-gray-400">
            <tr>
              <th className="px-4 py-3 text-left">Name</th>
              <th className="px-4 py-3 text-left">Contact</th>
              <th className="px-4 py-3 text-left">Source</th>
              <th className="px-4 py-3 text-left">Stage</th>
              <th className="px-4 py-3 text-left">Assigned</th>
              <th className="px-4 py-3 text-left">Activities</th>
              <th className="px-4 py-3 text-left">Created</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={7} className="p-8 text-center text-gray-500">
                  Loading…
                </td>
              </tr>
            ) : leads.length === 0 ? (
              <tr>
                <td colSpan={7} className="p-8 text-center text-gray-500">
                  No leads match the current filter.
                </td>
              </tr>
            ) : (
              leads.map((lead) => (
                <tr
                  key={lead.id}
                  className="border-t border-gray-200 dark:border-gray-700"
                >
                  <td className="px-4 py-3 font-medium">
                    <Link
                      href={`/dashboard/leads/${lead.id}`}
                      className="hover:underline"
                    >
                      {lead.name}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-500 dark:text-gray-400">
                    {lead.phone}
                    {lead.email && <div>{lead.email}</div>}
                  </td>
                  <td className="px-4 py-3 text-xs">
                    {lead.source.replace(/_/g, " ")}
                  </td>
                  <td className="px-4 py-3">
                    <select
                      value={lead.status}
                      onChange={(e) =>
                        handleStatusChange(lead, e.target.value as LeadStatus)
                      }
                      className={`rounded-full border-0 px-2 py-0.5 text-xs ${STATUS_COLORS[lead.status]}`}
                      data-testid={`lead-status-${lead.id}`}
                    >
                      {LEAD_STATUS_VALUES.map((s) => (
                        <option key={s} value={s}>
                          {s.replace(/_/g, " ")}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="px-4 py-3 text-xs">
                    {lead.assignedToUser?.name ?? (
                      <span className="text-gray-400">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-xs">
                    {lead._count?.activities ?? 0}
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-500 dark:text-gray-400">
                    {new Date(lead.createdAt).toLocaleDateString()}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Create modal */}
      {createOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md max-h-[90vh] overflow-y-auto rounded-2xl bg-white p-6 shadow-xl dark:bg-gray-800">
            <h2 className="mb-3 flex items-center gap-2 text-lg font-semibold">
              <UserCheck size={18} /> New lead
            </h2>
            <div className="space-y-3">
              <div>
                <label className="text-xs text-gray-500 dark:text-gray-400">
                  Name <span className="text-red-500">*</span>
                </label>
                <input
                  value={newLead.name}
                  onChange={(e) =>
                    setNewLead((p) => ({ ...p, name: e.target.value }))
                  }
                  className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-900"
                  data-testid="lead-create-name"
                />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-gray-500 dark:text-gray-400">Phone</label>
                  <input
                    value={newLead.phone}
                    onChange={(e) =>
                      setNewLead((p) => ({ ...p, phone: e.target.value }))
                    }
                    className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-900"
                  />
                </div>
                <div>
                  <label className="text-xs text-gray-500 dark:text-gray-400">Email</label>
                  <input
                    value={newLead.email}
                    onChange={(e) =>
                      setNewLead((p) => ({ ...p, email: e.target.value }))
                    }
                    className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-900"
                  />
                </div>
              </div>
              <div>
                <label className="text-xs text-gray-500 dark:text-gray-400">Source</label>
                <select
                  value={newLead.source}
                  onChange={(e) =>
                    setNewLead((p) => ({ ...p, source: e.target.value as LeadSource }))
                  }
                  className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-900"
                >
                  {LEAD_SOURCE_VALUES.map((s) => (
                    <option key={s} value={s}>
                      {s.replace(/_/g, " ")}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-xs text-gray-500 dark:text-gray-400">Notes</label>
                <textarea
                  value={newLead.notes}
                  onChange={(e) =>
                    setNewLead((p) => ({ ...p, notes: e.target.value }))
                  }
                  rows={2}
                  className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-900"
                />
              </div>
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => setCreateOpen(false)}
                className="rounded border border-gray-300 px-3 py-1.5 text-sm dark:border-gray-600"
              >
                Cancel
              </button>
              <button
                onClick={handleCreate}
                className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
                data-testid="lead-create-submit"
              >
                Create
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
