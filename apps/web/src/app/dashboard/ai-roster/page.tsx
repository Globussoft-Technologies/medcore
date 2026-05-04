"use client";

// AI-generated staff roster dashboard (PRD §7.3).  Admin-only flow:
//   1. Pick department + start date + length (7/14 days).
//   2. POST /ai/roster/propose → view proposal, warnings, violations.
//   3. Click "Apply" → confirm modal → POST /ai/roster/apply with confirm:true.
//   4. History tab lists past proposals with status.

import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  CalendarDays,
  CheckCircle,
  Clock,
  History,
  Loader2,
  Play,
  ShieldAlert,
  Sparkles,
} from "lucide-react";
import { api } from "@/lib/api";
import { useAuthStore } from "@/lib/store";

// ─── Types ─────────────────────────────────────────────

type ShiftType = "MORNING" | "AFTERNOON" | "NIGHT" | "ON_CALL";

interface StaffAssignment {
  userId: string;
  name: string;
  role: string;
  reason?: string;
}

interface ShiftProposal {
  shiftType: ShiftType;
  requiredCount: number;
  assignedStaff: StaffAssignment[];
  understaffed: boolean;
}

interface DayProposal {
  date: string;
  shifts: ShiftProposal[];
}

interface ProposalPayload {
  id: string;
  status: "PROPOSED" | "APPLIED" | "REJECTED";
  startDate: string;
  days: number;
  department: string;
  proposals: DayProposal[];
  warnings: string[];
  violationsIfApplied: string[];
}

interface HistoryRow {
  id: string;
  status: "PROPOSED" | "APPLIED" | "REJECTED";
  startDate: string;
  days: number;
  department: string;
  createdAt: string;
  appliedAt?: string;
  warnings: number;
  violationsIfApplied: number;
}

const SHIFT_ORDER: ShiftType[] = ["MORNING", "AFTERNOON", "NIGHT", "ON_CALL"];

function statusBadge(s: HistoryRow["status"]) {
  if (s === "APPLIED")
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-green-100 px-2 py-0.5 text-xs font-semibold text-green-800">
        <CheckCircle className="h-3 w-3" /> APPLIED
      </span>
    );
  if (s === "REJECTED")
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-xs font-semibold text-gray-700">
        REJECTED
      </span>
    );
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-blue-100 px-2 py-0.5 text-xs font-semibold text-blue-800">
      <Clock className="h-3 w-3" /> PROPOSED
    </span>
  );
}

export default function AIRosterPage() {
  const { token } = useAuthStore();

  const [startDate, setStartDate] = useState<string>(() =>
    new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  );
  const [days, setDays] = useState<7 | 14>(7);
  const [department, setDepartment] = useState("general");
  const [proposal, setProposal] = useState<ProposalPayload | null>(null);
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const loadHistory = useCallback(async () => {
    try {
      const res = await api.get<{ success: boolean; data: HistoryRow[] }>(
        "/ai/roster/history",
        { token: token ?? undefined }
      );
      if (res.success) setHistory(res.data);
    } catch {
      // non-fatal
    }
  }, [token]);

  useEffect(() => {
    loadHistory();
  }, [loadHistory]);

  async function propose() {
    setLoading(true);
    setError(null);
    setProposal(null);
    try {
      const res = await api.post<{ success: boolean; data: ProposalPayload; error: string | null }>(
        "/ai/roster/propose",
        { startDate, days, department },
        { token: token ?? undefined }
      );
      if (res.success) setProposal(res.data);
      else setError(res.error ?? "Failed to generate roster");
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to generate roster");
    } finally {
      setLoading(false);
    }
  }

  async function applyProposal() {
    if (!proposal) return;
    setApplying(true);
    setError(null);
    try {
      const res = await api.post<{
        success: boolean;
        data: { id: string; status: string; createdShifts: number };
        error: string | null;
      }>(
        "/ai/roster/apply",
        { id: proposal.id, confirm: true },
        { token: token ?? undefined }
      );
      if (res.success) {
        setToast(`Applied — ${res.data.createdShifts} shifts created.`);
        setProposal({ ...proposal, status: "APPLIED" });
        loadHistory();
      } else {
        setError(res.error ?? "Failed to apply roster");
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to apply roster");
    } finally {
      setApplying(false);
      setConfirmOpen(false);
    }
  }

  const totalAssigned = proposal
    ? proposal.proposals.reduce(
        (s, d) => s + d.shifts.reduce((t, sh) => t + sh.assignedStaff.length, 0),
        0
      )
    : 0;

  return (
    <div className="mx-auto max-w-7xl space-y-6 p-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-indigo-600 text-white">
            <Sparkles className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-gray-900">AI Staff Roster</h1>
            <p className="text-sm text-gray-500">
              Generate a 7-/14-day roster proposal, review conflicts, then apply.
            </p>
          </div>
        </div>
      </div>

      {/* Proposal form */}
      <div className="rounded-lg border border-gray-200 bg-white p-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
          <div>
            <label htmlFor="ai-roster-start-date" className="block text-xs font-semibold uppercase text-gray-600">
              Start date
            </label>
            <input
              id="ai-roster-start-date"
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm"
            />
          </div>
          <div>
            <label htmlFor="ai-roster-days" className="block text-xs font-semibold uppercase text-gray-600">Days</label>
            <select
              id="ai-roster-days"
              value={days}
              onChange={(e) => setDays(Number(e.target.value) as 7 | 14)}
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm"
            >
              <option value={7}>7 days</option>
              <option value={14}>14 days</option>
            </select>
          </div>
          <div>
            <label htmlFor="ai-roster-department" className="block text-xs font-semibold uppercase text-gray-600">
              Department
            </label>
            <input
              id="ai-roster-department"
              type="text"
              value={department}
              onChange={(e) => setDepartment(e.target.value)}
              placeholder="cardiology, icu, general…"
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm"
            />
          </div>
          <div className="flex items-end">
            <button
              onClick={propose}
              disabled={loading}
              className="flex w-full items-center justify-center gap-2 rounded-md bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-60"
            >
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <CalendarDays className="h-4 w-4" />}
              Generate
            </button>
          </div>
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <strong>Error:</strong> {error}
        </div>
      )}
      {toast && (
        <div className="rounded-md border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">
          {toast}
        </div>
      )}

      {/* Proposal review */}
      {proposal && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-3 rounded-lg border border-gray-200 bg-white p-4">
            <div>
              <div className="text-xs uppercase text-gray-500">Proposal</div>
              <div className="text-sm font-semibold text-gray-900">
                {proposal.department} · {proposal.days} days · starts {proposal.startDate}
              </div>
            </div>
            <div className="ml-auto flex items-center gap-3">
              {statusBadge(proposal.status)}
              <span className="text-xs text-gray-500">{totalAssigned} shift slots filled</span>
              <button
                disabled={proposal.status !== "PROPOSED"}
                onClick={() => setConfirmOpen(true)}
                className="flex items-center gap-2 rounded-md bg-green-600 px-4 py-2 text-sm font-semibold text-white hover:bg-green-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Play className="h-4 w-4" />
                Apply
              </button>
            </div>
          </div>

          {proposal.warnings.length > 0 && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-4">
              <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-amber-800">
                <AlertTriangle className="h-4 w-4" /> Warnings ({proposal.warnings.length})
              </div>
              <ul className="list-disc pl-5 text-sm text-amber-900">
                {proposal.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </div>
          )}

          {proposal.violationsIfApplied.length > 0 && (
            <div className="rounded-lg border border-red-200 bg-red-50 p-4">
              <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-red-800">
                <ShieldAlert className="h-4 w-4" /> Violations if applied (
                {proposal.violationsIfApplied.length})
              </div>
              <ul className="list-disc pl-5 text-sm text-red-900">
                {proposal.violationsIfApplied.map((v, i) => (
                  <li key={i}>{v}</li>
                ))}
              </ul>
            </div>
          )}

          {/* Day-by-day grid */}
          <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
            <table className="min-w-full divide-y divide-gray-200 text-sm">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-3 py-2 text-left text-xs font-semibold uppercase text-gray-600">
                    Date
                  </th>
                  {SHIFT_ORDER.map((st) => (
                    <th
                      key={st}
                      className="px-3 py-2 text-left text-xs font-semibold uppercase text-gray-600"
                    >
                      {st}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {proposal.proposals.map((d) => {
                  const byType: Record<ShiftType, ShiftProposal | undefined> = {
                    MORNING: undefined,
                    AFTERNOON: undefined,
                    NIGHT: undefined,
                    ON_CALL: undefined,
                  };
                  for (const sh of d.shifts) byType[sh.shiftType] = sh;
                  return (
                    <tr key={d.date}>
                      <td className="whitespace-nowrap px-3 py-2 font-medium text-gray-900">
                        {d.date}
                      </td>
                      {SHIFT_ORDER.map((st) => {
                        const sh = byType[st];
                        if (!sh || sh.requiredCount === 0)
                          return (
                            <td key={st} className="px-3 py-2 text-xs text-gray-400">
                              —
                            </td>
                          );
                        return (
                          <td key={st} className="px-3 py-2 align-top">
                            <div
                              className={`rounded border p-1.5 text-xs ${
                                sh.understaffed
                                  ? "border-red-200 bg-red-50"
                                  : "border-gray-200 bg-gray-50"
                              }`}
                            >
                              <div className="mb-1 font-semibold text-gray-700">
                                {sh.assignedStaff.length}/{sh.requiredCount}
                              </div>
                              <ul className="space-y-0.5">
                                {sh.assignedStaff.map((s) => (
                                  <li key={s.userId} className="truncate">
                                    {s.name}{" "}
                                    <span className="text-[10px] text-gray-500">({s.role})</span>
                                  </li>
                                ))}
                                {sh.assignedStaff.length === 0 && (
                                  <li className="text-red-700">unfilled</li>
                                )}
                              </ul>
                            </div>
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* History */}
      <div className="rounded-lg border border-gray-200 bg-white p-4">
        <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-gray-900">
          <History className="h-4 w-4" /> History
        </div>
        {history.length === 0 ? (
          <div className="text-sm text-gray-500">No past proposals yet.</div>
        ) : (
          <table className="min-w-full divide-y divide-gray-200 text-sm">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-3 py-2 text-left text-xs font-semibold uppercase text-gray-600">
                  Start
                </th>
                <th className="px-3 py-2 text-left text-xs font-semibold uppercase text-gray-600">
                  Dept
                </th>
                <th className="px-3 py-2 text-left text-xs font-semibold uppercase text-gray-600">
                  Days
                </th>
                <th className="px-3 py-2 text-left text-xs font-semibold uppercase text-gray-600">
                  Created
                </th>
                <th className="px-3 py-2 text-left text-xs font-semibold uppercase text-gray-600">
                  Status
                </th>
                <th className="px-3 py-2 text-left text-xs font-semibold uppercase text-gray-600">
                  Warnings
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {history.map((h) => (
                <tr key={h.id}>
                  <td className="px-3 py-2">{h.startDate}</td>
                  <td className="px-3 py-2">{h.department}</td>
                  <td className="px-3 py-2">{h.days}</td>
                  <td className="px-3 py-2 text-xs text-gray-500">
                    {new Date(h.createdAt).toLocaleString()}
                  </td>
                  <td className="px-3 py-2">{statusBadge(h.status)}</td>
                  <td className="px-3 py-2 text-xs">
                    {h.warnings} / {h.violationsIfApplied} violations
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Confirm dialog */}
      {confirmOpen && proposal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-xl">
            <h2 className="mb-2 text-lg font-bold text-gray-900">Apply roster?</h2>
            <p className="text-sm text-gray-600">
              This will create StaffShift rows for{" "}
              <strong>{proposal.department}</strong> from{" "}
              <strong>{proposal.startDate}</strong> for <strong>{proposal.days}</strong> days.
              {proposal.violationsIfApplied.length > 0 && (
                <span className="mt-2 block font-semibold text-red-700">
                  {proposal.violationsIfApplied.length} coverage violations will remain unfilled.
                </span>
              )}
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => setConfirmOpen(false)}
                className="rounded-md border border-gray-300 px-4 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={applyProposal}
                disabled={applying}
                className="flex items-center gap-2 rounded-md bg-green-600 px-4 py-2 text-sm font-semibold text-white hover:bg-green-700 disabled:opacity-60"
              >
                {applying ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                Confirm apply
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
