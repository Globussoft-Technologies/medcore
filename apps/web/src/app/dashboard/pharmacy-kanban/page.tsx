"use client";

// Pearl §4.3 (gap row 104) — Pharmacy dispensing Kanban.
// Four-column board (New → Dispensing → Ready → Dispensed) backed by
// GET /api/v1/pharmacy/kanban + PATCH /api/v1/pharmacy/prescriptions/
// :id/status. Cards move via HTML5 drag-and-drop on desktop AND
// explicit "Move →" / "← Back" buttons on every viewport so mobile
// (no drag) is uniformly supported without pulling in a DnD library
// (none is in package.json today and adding one is out of scope per
// the closure brief).
//
// Mobile swipe-gesture support was deliberately scope-cut to a
// follow-up — the button-pair gives the same workflow and ships
// today.
//
// Page-level VIEW_ALLOWED gate matches the API authorize() on
// /pharmacy/kanban: ADMIN / PHARMACIST / DOCTOR / NURSE.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { api } from "@/lib/api";
import { useAuthStore } from "@/lib/store";
import { toast } from "@/lib/toast";
import { Package, ArrowRight, ArrowLeft, RefreshCw } from "lucide-react";

type KanbanStatus =
  | "PENDING"
  | "DISPENSING"
  | "READY"
  | "DISPENSED"
  | "REJECTED"
  | "CANCELLED";

interface ScriptCard {
  id: string;
  status: KanbanStatus;
  patientId: string;
  patientLabel: string;
  doctorName: string;
  topItem: string;
  extraItems: number;
  createdAt: string;
  updatedAt: string;
}

interface KanbanPayload {
  columns: Record<KanbanStatus, ScriptCard[]>;
  todayOnly: boolean;
}

const ACTIVE_COLUMNS: ReadonlyArray<{
  key: KanbanStatus;
  label: string;
  accent: string;
}> = [
  { key: "PENDING", label: "New", accent: "border-amber-400" },
  { key: "DISPENSING", label: "Dispensing", accent: "border-blue-400" },
  { key: "READY", label: "Ready", accent: "border-emerald-400" },
  { key: "DISPENSED", label: "Dispensed", accent: "border-slate-400" },
];

// Forward / step-back transitions allowed by the state machine. Keep
// in lockstep with KANBAN_TRANSITIONS in apps/api/src/routes/pharmacy.ts.
// `forward` is the "advance" arrow (Move →), `back` is the "step back"
// arrow (← Back). null means no action at that boundary.
const TRANSITIONS: Record<
  KanbanStatus,
  { forward: KanbanStatus | null; back: KanbanStatus | null }
> = {
  PENDING: { forward: "DISPENSING", back: null },
  DISPENSING: { forward: "READY", back: null },
  READY: { forward: "DISPENSED", back: "DISPENSING" },
  DISPENSED: { forward: null, back: null },
  REJECTED: { forward: null, back: null },
  CANCELLED: { forward: null, back: null },
};

const VIEW_ALLOWED = new Set(["ADMIN", "PHARMACIST", "DOCTOR", "NURSE"]);
const CAN_MUTATE_ROLES = new Set(["ADMIN", "PHARMACIST"]);

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms) || ms < 0) return "just now";
  const min = Math.floor(ms / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  return `${d}d ago`;
}

export default function PharmacyKanbanPage() {
  const { user, isLoading } = useAuthStore();
  const router = useRouter();
  const pathname = usePathname();
  const [payload, setPayload] = useState<KanbanPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [todayOnly, setTodayOnly] = useState(true);
  const [dragId, setDragId] = useState<string | null>(null);
  const [showReturned, setShowReturned] = useState(false);
  const canMutate = !!user && CAN_MUTATE_ROLES.has(user.role);

  useEffect(() => {
    if (!isLoading && user && !VIEW_ALLOWED.has(user.role)) {
      toast.error("Pharmacy Kanban is restricted to clinical and pharmacy roles.");
      router.replace(
        `/dashboard/not-authorized?from=${encodeURIComponent(
          pathname || "/dashboard/pharmacy-kanban",
        )}`,
      );
    }
  }, [user, isLoading, router, pathname]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<{ data: KanbanPayload }>(
        `/pharmacy/kanban?todayOnly=${todayOnly ? "true" : "false"}`,
      );
      setPayload(res.data);
    } catch {
      setPayload(null);
    }
    setLoading(false);
  }, [todayOnly]);

  useEffect(() => {
    void load();
  }, [load]);

  // Optimistic move: shift the card to the target column locally,
  // POST the PATCH, revert + toast on failure.
  const move = useCallback(
    async (card: ScriptCard, target: KanbanStatus) => {
      if (!canMutate) {
        toast.error("Only ADMIN and PHARMACIST can move scripts.");
        return;
      }
      if (!payload) return;
      const prev = payload;
      const nextColumns: Record<KanbanStatus, ScriptCard[]> = {
        PENDING: [...prev.columns.PENDING],
        DISPENSING: [...prev.columns.DISPENSING],
        READY: [...prev.columns.READY],
        DISPENSED: [...prev.columns.DISPENSED],
        REJECTED: [...prev.columns.REJECTED],
        CANCELLED: [...prev.columns.CANCELLED],
      };
      nextColumns[card.status] = nextColumns[card.status].filter(
        (c) => c.id !== card.id,
      );
      nextColumns[target] = [{ ...card, status: target }, ...nextColumns[target]];
      setPayload({ ...prev, columns: nextColumns });
      try {
        await api.patch(`/pharmacy/prescriptions/${card.id}/status`, {
          status: target,
        });
      } catch (err) {
        setPayload(prev); // revert
        toast.error(
          (err as Error)?.message ||
            `Could not move script to ${target}. The status may have changed elsewhere — refresh and retry.`,
        );
      }
    },
    [canMutate, payload],
  );

  const onDragStart = (card: ScriptCard) => (e: React.DragEvent) => {
    if (!canMutate) return;
    setDragId(card.id);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", card.id);
  };
  const onDragEnd = () => setDragId(null);
  const onDragOver = (target: KanbanStatus) => (e: React.DragEvent) => {
    if (!canMutate) return;
    // Only show the drop affordance for legal transitions; everything
    // else gets the no-drop cursor.
    if (!payload) return;
    const card = findCard(payload, dragId);
    if (!card) return;
    const legal =
      TRANSITIONS[card.status].forward === target ||
      TRANSITIONS[card.status].back === target;
    if (!legal) return;
    e.preventDefault();
  };
  const onDrop = (target: KanbanStatus) => (e: React.DragEvent) => {
    e.preventDefault();
    if (!canMutate || !payload) return;
    const id = e.dataTransfer.getData("text/plain") || dragId;
    if (!id) return;
    const card = findCard(payload, id);
    if (!card) return;
    const legal =
      TRANSITIONS[card.status].forward === target ||
      TRANSITIONS[card.status].back === target;
    if (!legal) {
      toast.error(`Cannot move from ${card.status} to ${target}.`);
      return;
    }
    void move(card, target);
  };

  const returnedRows = useMemo(() => {
    if (!payload) return [] as ScriptCard[];
    return [...payload.columns.REJECTED, ...payload.columns.CANCELLED];
  }, [payload]);

  return (
    <div data-testid="pharmacy-kanban-page">
      <button
        type="button"
        onClick={() => router.push("/dashboard/pharmacy")}
        className="mb-4 inline-flex items-center gap-2 text-sm text-gray-600 hover:text-primary dark:text-gray-400"
        data-testid="pharmacy-kanban-back"
        aria-label="Back to Pharmacy"
      >
        <ArrowLeft size={16} aria-hidden="true" /> Back to Pharmacy
      </button>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-bold text-gray-900 sm:text-2xl dark:text-gray-100">
            <Package className="text-primary" /> Pharmacy Kanban
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Drag scripts between columns (or use the move buttons).
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          className="flex h-11 min-w-[44px] items-center gap-2 rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
          data-testid="pharmacy-kanban-refresh"
          aria-label="Refresh board"
        >
          <RefreshCw size={16} /> Refresh
        </button>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setTodayOnly(true)}
          className={`h-11 min-w-[44px] rounded-full px-4 py-2 text-sm font-medium transition ${
            todayOnly
              ? "bg-primary text-white"
              : "bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-200 dark:hover:bg-gray-600"
          }`}
          data-testid="pharmacy-kanban-filter-today"
          aria-pressed={todayOnly}
        >
          Today only
        </button>
        <button
          type="button"
          onClick={() => setTodayOnly(false)}
          className={`h-11 min-w-[44px] rounded-full px-4 py-2 text-sm font-medium transition ${
            !todayOnly
              ? "bg-primary text-white"
              : "bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-200 dark:hover:bg-gray-600"
          }`}
          data-testid="pharmacy-kanban-filter-all"
          aria-pressed={!todayOnly}
        >
          All open
        </button>
      </div>

      {loading ? (
        <div
          className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4"
          data-testid="pharmacy-kanban-skeleton"
        >
          {ACTIVE_COLUMNS.map((col) => (
            <div
              key={col.key}
              className="h-64 animate-pulse rounded-xl bg-gray-100 dark:bg-gray-700"
            />
          ))}
        </div>
      ) : !payload ? (
        <div className="rounded-xl bg-white p-8 text-center text-gray-500 shadow-sm dark:bg-gray-800 dark:text-gray-400">
          Could not load the pharmacy Kanban. Refresh to retry.
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
          {ACTIVE_COLUMNS.map((col) => {
            const cards = payload.columns[col.key] ?? [];
            return (
              <section
                key={col.key}
                className={`rounded-xl border-t-4 bg-white p-3 shadow-sm dark:bg-gray-800 ${col.accent}`}
                data-testid={`kanban-column-${col.key}`}
                onDragOver={onDragOver(col.key)}
                onDrop={onDrop(col.key)}
              >
                <header className="mb-3 flex items-center justify-between">
                  <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                    {col.label}
                  </h2>
                  <span
                    className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-700 dark:bg-gray-700 dark:text-gray-200"
                    data-testid={`kanban-count-${col.key}`}
                  >
                    {cards.length}
                  </span>
                </header>
                <ul className="max-h-[60vh] space-y-2 overflow-y-auto pr-1">
                  {cards.length === 0 ? (
                    <li className="rounded-md border border-dashed border-gray-200 p-4 text-center text-xs text-gray-400 dark:border-gray-600">
                      No scripts.
                    </li>
                  ) : (
                    cards.map((card) => {
                      const tr = TRANSITIONS[card.status];
                      return (
                        <li
                          key={card.id}
                          draggable={canMutate}
                          onDragStart={onDragStart(card)}
                          onDragEnd={onDragEnd}
                          data-testid="kanban-card"
                          data-card-id={card.id}
                          className="cursor-grab rounded-md border border-gray-200 bg-gray-50 p-3 text-sm shadow-sm hover:border-primary/60 dark:border-gray-700 dark:bg-gray-900"
                        >
                          <div className="mb-1 flex items-center justify-between gap-2">
                            <span className="font-medium text-gray-900 dark:text-gray-100">
                              {card.patientLabel}
                            </span>
                            <span className="text-xs text-gray-500 dark:text-gray-400">
                              {timeAgo(card.createdAt)}
                            </span>
                          </div>
                          <p className="text-xs text-gray-600 dark:text-gray-300">
                            {card.doctorName}
                          </p>
                          <p className="mt-1 text-xs text-gray-700 dark:text-gray-200">
                            {card.topItem}
                            {card.extraItems > 0
                              ? ` + ${card.extraItems} more`
                              : ""}
                          </p>
                          {canMutate && (tr.back || tr.forward) && (
                            <div className="mt-2 flex gap-2">
                              {tr.back && (
                                <button
                                  type="button"
                                  onClick={() => void move(card, tr.back!)}
                                  className="flex h-11 min-w-[44px] flex-1 items-center justify-center gap-1 rounded-md border border-gray-300 px-2 py-1 text-xs text-gray-700 hover:bg-gray-100 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
                                  data-testid={`kanban-back-${card.id}`}
                                  aria-label={`Move script back to ${tr.back}`}
                                >
                                  <ArrowLeft size={12} /> Back
                                </button>
                              )}
                              {tr.forward && (
                                <button
                                  type="button"
                                  onClick={() => void move(card, tr.forward!)}
                                  className="flex h-11 min-w-[44px] flex-1 items-center justify-center gap-1 rounded-md bg-primary px-2 py-1 text-xs font-medium text-white hover:bg-primary-dark"
                                  data-testid={`kanban-move-${card.id}`}
                                  aria-label={`Move script forward to ${tr.forward}`}
                                >
                                  Move <ArrowRight size={12} />
                                </button>
                              )}
                            </div>
                          )}
                        </li>
                      );
                    })
                  )}
                </ul>
              </section>
            );
          })}
        </div>
      )}

      {/* Returned / Cancelled footer — collapsible so a pharmacist can
          still find a script that was rejected without it cluttering the
          main board. */}
      <details
        className="mt-6 rounded-xl bg-white p-3 shadow-sm dark:bg-gray-800"
        data-testid="kanban-returned-section"
      >
        <summary
          className="cursor-pointer text-sm font-medium text-gray-700 dark:text-gray-200"
          onClick={() => setShowReturned((v) => !v)}
        >
          Returned / Cancelled ({returnedRows.length})
        </summary>
        {showReturned && (
          <ul className="mt-3 space-y-2">
            {returnedRows.length === 0 ? (
              <li className="text-xs text-gray-500 dark:text-gray-400">
                No returned or cancelled scripts.
              </li>
            ) : (
              returnedRows.map((card) => (
                <li
                  key={card.id}
                  className="rounded-md border border-gray-200 bg-gray-50 p-2 text-xs dark:border-gray-700 dark:bg-gray-900"
                  data-testid="kanban-returned-row"
                >
                  <span className="font-medium text-gray-900 dark:text-gray-100">
                    {card.patientLabel}
                  </span>{" "}
                  · {card.doctorName} · {card.topItem} ·{" "}
                  <span className="font-semibold text-red-600 dark:text-red-400">
                    {card.status}
                  </span>
                </li>
              ))
            )}
          </ul>
        )}
      </details>
    </div>
  );
}

function findCard(
  payload: KanbanPayload,
  id: string | null,
): ScriptCard | null {
  if (!id) return null;
  for (const list of Object.values(payload.columns)) {
    const hit = list.find((c) => c.id === id);
    if (hit) return hit;
  }
  return null;
}
