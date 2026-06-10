"use client";

// Pearl §4.3 — Pharmacy dispensing Kanban, modelled PER MEDICINE.
// Each card is a single prescription line item (one drug) that moves
// New → Dispensing → Ready → Dispensed independently. A prescription with
// mixed stock can have some medicines dispensed while out-of-stock lines stay
// in New. Backed by GET /pharmacy/kanban (per-item cards),
// PATCH /pharmacy/prescription-items/:itemId/status (New↔Dispensing↔Ready)
// and POST /pharmacy/dispense (the final READY→DISPENSED, which deducts stock
// + bills). An OUT-OF-STOCK medicine cannot be advanced.
//
// Page-level VIEW_ALLOWED gate matches the API authorize() on
// /pharmacy/kanban: ADMIN / PHARMACIST / DOCTOR / NURSE.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { api } from "@/lib/api";
import { useAuthStore } from "@/lib/store";
import { toast } from "@/lib/toast";
import { Package, ArrowRight, ArrowLeft, RefreshCw } from "lucide-react";
import { Skeleton, SkeletonCard } from "@/components/Skeleton";

type KanbanStatus =
  | "PENDING"
  | "DISPENSING"
  | "READY"
  | "DISPENSED"
  | "REJECTED"
  | "CANCELLED";

// One card == one prescription line item (medicine).
interface MedCard {
  id: string; // prescription ITEM id
  prescriptionId: string;
  medicineId: string | null;
  medicineName: string;
  dosage: string;
  frequency: string;
  duration: string;
  instructions: string | null;
  patientId: string;
  patientLabel: string;
  doctorName: string;
  requiredQty: number;
  availableQty: number;
  inStock: boolean;
  dispensed: boolean;
  status: KanbanStatus;
  createdAt: string;
  updatedAt: string;
}

interface KanbanPayload {
  columns: Record<KanbanStatus, MedCard[]>;
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

// Forward / step-back transitions. Mirrors KANBAN_TRANSITIONS on the API.
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

const ORDER: Record<string, number> = {
  PENDING: 0,
  DISPENSING: 1,
  READY: 2,
  DISPENSED: 3,
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
  const searchParams = useSearchParams();
  const fromPharmacy = searchParams.get("from") === "pharmacy";
  // When arriving via a prescription's "Finish in Kanban", scope the board to
  // just that prescription's medicines.
  const prescriptionFilter = searchParams.get("prescription");
  const [payload, setPayload] = useState<KanbanPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const todayOnly = true;
  const [dragId, setDragId] = useState<string | null>(null);
  // Pharmacy bill state for the scoped Rx: the generated bill id (null = not
  // billed yet) and how many dispensed lines it currently carries. When MORE
  // medicines get dispensed than are on the bill, the button offers "Update
  // Bill" instead of staying disabled.
  const [billedInvoiceId, setBilledInvoiceId] = useState<string | null>(null);
  const [billedCount, setBilledCount] = useState(0);
  // Confirmation popup before generating/updating the bill.
  const [showBillConfirm, setShowBillConfirm] = useState(false);
  const [billing, setBilling] = useState(false);
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

  // On load (and whenever the scoped Rx changes), check whether a pharmacy bill
  // already exists so "Generate Bill" can render disabled.
  useEffect(() => {
    if (!prescriptionFilter) {
      setBilledInvoiceId(null);
      setBilledCount(0);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await api.get<{
          data: { invoiceId: string | null; billedCount?: number };
        }>(`/pharmacy/prescriptions/${prescriptionFilter}/invoice`);
        if (!cancelled) {
          setBilledInvoiceId(res.data?.invoiceId ?? null);
          setBilledCount(res.data?.billedCount ?? 0);
        }
      } catch {
        if (!cancelled) {
          setBilledInvoiceId(null);
          setBilledCount(0);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [prescriptionFilter]);

  const isForwardMove = (from: KanbanStatus, target: KanbanStatus) =>
    (ORDER[target] ?? 0) > (ORDER[from] ?? 0);

  // Move ONE medicine. The final READY → DISPENSED step actually dispenses
  // that medicine (POST /pharmacy/dispense with its medicineId). Earlier steps
  // just transition the item's kanban status. Out-of-stock can't move forward.
  const move = useCallback(
    async (card: MedCard, target: KanbanStatus) => {
      if (!canMutate) {
        toast.error("Only ADMIN and PHARMACIST can move medicines.");
        return;
      }
      if (isForwardMove(card.status, target) && !card.inStock) {
        toast.error(
          `${card.medicineName} is out of stock — it can't be moved until restocked.`,
        );
        return;
      }

      if (target === "DISPENSED") {
        if (!card.medicineId) {
          toast.error(`${card.medicineName} isn't in the catalog — can't dispense.`);
          return;
        }
        try {
          // Dispense THIS line item only (by prescription-item id). Targeting
          // the item — not the medicine — keeps two lines of the same medicine
          // independent and avoids the "Invalid UUID" when a line's resolved
          // medicineId is a name-match rather than a real FK.
          await api.post("/pharmacy/dispense", {
            prescriptionId: card.prescriptionId,
            itemIds: [card.id],
          });
          toast.success(`${card.medicineName} dispensed`);
          await load();
        } catch (err) {
          toast.error(err instanceof Error ? err.message : "Failed to dispense");
        }
        return;
      }

      // Optimistic transition for New ↔ Dispensing ↔ Ready.
      if (!payload) return;
      const prev = payload;
      const nextColumns: Record<KanbanStatus, MedCard[]> = {
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
        await api.patch(`/pharmacy/prescription-items/${card.id}/status`, {
          status: target,
        });
      } catch (err) {
        setPayload(prev); // revert
        toast.error(
          (err as Error)?.message ||
            `Could not move ${card.medicineName} to ${target}. Refresh and retry.`,
        );
      }
    },
    [canMutate, payload, load],
  );

  const onDragStart = (card: MedCard) => (e: React.DragEvent) => {
    if (!canMutate) return;
    setDragId(card.id);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", card.id);
  };
  const onDragEnd = () => setDragId(null);
  const onDragOver = (target: KanbanStatus) => (e: React.DragEvent) => {
    if (!canMutate || !payload) return;
    const card = findCard(payload, dragId);
    if (!card) return;
    const legal =
      TRANSITIONS[card.status].forward === target ||
      TRANSITIONS[card.status].back === target;
    if (!legal) return;
    if (isForwardMove(card.status, target) && !card.inStock) return;
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

  // Generate (or open) the bill for the filtered prescription. The endpoint
  // ensures the invoice exists and reconciles the DISPENSED pharmacy lines onto
  // it — undispensed / out-of-stock lines are never billed.
  const goToBill = useCallback(async () => {
    if (!prescriptionFilter) return;
    setBilling(true);
    try {
      const res = await api.post<{
        data: { invoiceId: string | null; billedCount?: number };
        message?: string;
      }>(`/pharmacy/prescriptions/${prescriptionFilter}/invoice`, {});
      if (res.data?.invoiceId) {
        setBilledInvoiceId(res.data.invoiceId);
        setBilledCount(res.data.billedCount ?? 0);
        setShowBillConfirm(false);
        // Bill saved — return to the Prescriptions list to handle the next one
        // (the bill itself is viewable from the Billing section).
        toast.success("Bill generated — view it under Billing.");
        router.push("/dashboard/prescriptions");
      } else {
        toast.error(
          res.message || "No bill yet — dispense at least one medicine first.",
        );
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to generate bill");
    } finally {
      setBilling(false);
    }
  }, [prescriptionFilter, router]);

  // Patient label of the filtered prescription (for the scope banner).
  const filterPatientLabel = useMemo(() => {
    if (!payload || !prescriptionFilter) return null;
    for (const list of Object.values(payload.columns)) {
      const hit = list.find((c) => c.prescriptionId === prescriptionFilter);
      if (hit) return hit.patientLabel;
    }
    return null;
  }, [payload, prescriptionFilter]);

  // How many medicines are DISPENSED for the scoped prescription. >0 gates the
  // "Generate Bill" button; comparing it to billedCount decides Generate vs
  // Update vs disabled.
  const dispensedCount = useMemo(() => {
    if (!payload) return 0;
    return (payload.columns.DISPENSED ?? []).filter(
      (c) => !prescriptionFilter || c.prescriptionId === prescriptionFilter,
    ).length;
  }, [payload, prescriptionFilter]);
  const hasDispensed = dispensedCount > 0;
  // Billed, but more medicines have since been dispensed than are on the bill →
  // offer "Update Bill" to add the new line(s).
  const needsBillUpdate = !!billedInvoiceId && dispensedCount > billedCount;

  return (
    <div data-testid="pharmacy-kanban-page">
      {fromPharmacy && (
        <button
          type="button"
          onClick={() => router.push("/dashboard/pharmacy")}
          className="mb-4 inline-flex items-center gap-2 text-sm text-gray-600 hover:text-primary dark:text-gray-400"
          data-testid="pharmacy-kanban-back"
          aria-label="Back to Pharmacy"
        >
          <ArrowLeft size={16} aria-hidden="true" /> Back to Pharmacy
        </button>
      )}
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-bold text-gray-900 sm:text-2xl dark:text-gray-100">
            <Package className="text-primary" /> Pharmacy Kanban
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Drag each medicine between columns (or use the move buttons).
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

      {prescriptionFilter && (
        <div
          className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-sm dark:border-primary/40 dark:bg-primary/10"
          data-testid="pharmacy-kanban-scope"
        >
          <span className="text-gray-700 dark:text-gray-200">
            Showing medicines for{" "}
            <span className="font-semibold">
              {filterPatientLabel ?? "this prescription"}
            </span>
            &apos;s prescription.
          </span>
          <div className="flex items-center gap-2">
            {canMutate && hasDispensed && (
              // Bills ONLY the dispensed medicines (separate pharmacy-only bill —
              // no consultation/other lines). States:
              //   not billed              → "Generate Bill →"  (enabled)
              //   billed, new dispensed   → "Update Bill →"    (enabled)
              //   billed, nothing new     → "Bill Generated ✓" (disabled)
              <button
                type="button"
                onClick={() => setShowBillConfirm(true)}
                disabled={!!billedInvoiceId && !needsBillUpdate}
                data-testid="kanban-generate-bill"
                title={
                  billedInvoiceId && !needsBillUpdate
                    ? "Bill already generated for this prescription"
                    : needsBillUpdate
                      ? "New medicines dispensed — update the bill to add them"
                      : undefined
                }
                className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-white hover:bg-primary-dark disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-primary"
              >
                {!billedInvoiceId
                  ? "Generate Bill →"
                  : needsBillUpdate
                    ? "Update Bill →"
                    : "Bill Generated ✓"}
              </button>
            )}
            <button
              type="button"
              onClick={() => router.push("/dashboard/prescriptions")}
              data-testid="pharmacy-kanban-back-rx"
              className="rounded-md border border-gray-300 bg-white px-2.5 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
            >
              Back to Prescriptions
            </button>
          </div>
        </div>
      )}

      {!prescriptionFilter ? (
        // The board is opened PER prescription (Prescriptions → "Finish in
        // Kanban"). With no prescription scoped, don't dump every patient's
        // medicines — prompt the user to pick one.
        <div
          className="rounded-xl border border-dashed border-gray-300 bg-white p-10 text-center shadow-sm dark:border-gray-600 dark:bg-gray-800"
          data-testid="pharmacy-kanban-empty"
        >
          <p className="text-sm font-medium text-gray-700 dark:text-gray-200">
            No prescription selected.
          </p>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Open a prescription and click{" "}
            <span className="font-medium">&ldquo;Finish in Kanban&rdquo;</span>{" "}
            to manage its medicines here.
          </p>
          <button
            type="button"
            onClick={() => router.push("/dashboard/prescriptions")}
            className="mt-4 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark"
            data-testid="pharmacy-kanban-go-prescriptions"
          >
            Go to Prescriptions
          </button>
        </div>
      ) : loading ? (
        <div
          className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4"
          data-testid="pharmacy-kanban-skeleton"
        >
          {ACTIVE_COLUMNS.map((col) => (
            <section
              key={col.key}
              className={`rounded-xl border-t-4 bg-white p-3 shadow-sm dark:bg-gray-800 ${col.accent}`}
            >
              <header className="mb-3 flex items-center justify-between">
                <Skeleton variant="text" width="40%" />
                <Skeleton variant="rect" width={24} height={18} className="rounded-full" />
              </header>
              <div className="space-y-2">
                <SkeletonCard />
                <SkeletonCard />
                <SkeletonCard />
              </div>
            </section>
          ))}
        </div>
      ) : !payload ? (
        <div className="rounded-xl bg-white p-8 text-center text-gray-500 shadow-sm dark:bg-gray-800 dark:text-gray-400">
          Could not load the pharmacy Kanban. Refresh to retry.
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
          {ACTIVE_COLUMNS.map((col) => {
            const cards = (payload.columns[col.key] ?? []).filter(
              (c) => !prescriptionFilter || c.prescriptionId === prescriptionFilter,
            );
            return (
              <section
                key={col.key}
                className={`flex h-[calc(100vh-14rem)] min-h-[20rem] flex-col rounded-xl border-t-4 bg-white p-3 shadow-sm dark:bg-gray-800 ${col.accent}`}
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
                <ul className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
                  {cards.length === 0 ? (
                    <li className="rounded-md border border-dashed border-gray-200 p-4 text-center text-xs text-gray-400 dark:border-gray-600">
                      No medicines.
                    </li>
                  ) : (
                    cards.map((card) => {
                      const tr = TRANSITIONS[card.status];
                      const forwardBlocked = !card.inStock;
                      // Split the structured instructions ("Route: IM | Qty: 10
                      // | note") into route + free-text note for display.
                      const parts = (card.instructions ?? "")
                        .split("|")
                        .map((s) => s.trim())
                        .filter(Boolean);
                      const route =
                        parts
                          .find((p) => /^route:/i.test(p))
                          ?.replace(/^route:\s*/i, "") ?? "";
                      const note = parts
                        .filter((p) => !/^route:/i.test(p) && !/^qty:/i.test(p))
                        .join(" · ");
                      return (
                        <li
                          key={card.id}
                          draggable={canMutate && card.inStock}
                          onDragStart={onDragStart(card)}
                          onDragEnd={onDragEnd}
                          data-testid="kanban-card"
                          data-card-id={card.id}
                          className="rounded-md border border-gray-200 bg-gray-50 p-3 text-sm shadow-sm hover:border-primary/60 dark:border-gray-700 dark:bg-gray-900"
                        >
                          <div className="mb-1 flex items-start justify-between gap-2">
                            <span className="font-medium text-gray-900 dark:text-gray-100">
                              {card.medicineName}
                            </span>
                            <span className="shrink-0 text-xs text-gray-500 dark:text-gray-400">
                              {timeAgo(card.createdAt)}
                            </span>
                          </div>
                          <p className="text-xs text-gray-600 dark:text-gray-300">
                            {card.patientLabel} · {card.doctorName}
                          </p>
                          {/* Full prescribed detail for this line. */}
                          <div className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px] text-gray-600 dark:text-gray-300">
                            <span>
                              <span className="text-gray-400 dark:text-gray-500">Dose:</span>{" "}
                              {card.dosage || "—"}
                            </span>
                            <span>
                              <span className="text-gray-400 dark:text-gray-500">Freq:</span>{" "}
                              {card.frequency || "—"}
                            </span>
                            <span>
                              <span className="text-gray-400 dark:text-gray-500">Duration:</span>{" "}
                              {card.duration || "—"}
                            </span>
                            <span>
                              <span className="text-gray-400 dark:text-gray-500">Qty:</span>{" "}
                              {card.requiredQty}
                            </span>
                            {route && (
                              <span>
                                <span className="text-gray-400 dark:text-gray-500">Route:</span>{" "}
                                {route}
                              </span>
                            )}
                          </div>
                          {note && (
                            <p className="mt-0.5 text-[11px] italic text-gray-500 dark:text-gray-400">
                              {note}
                            </p>
                          )}
                          {/* Per-medicine stock status. */}
                          <p className="mt-1 text-xs">
                            {card.dispensed ? (
                              <span className="font-medium text-emerald-600 dark:text-emerald-400">
                                Dispensed
                              </span>
                            ) : card.inStock ? (
                              <span className="font-medium text-emerald-600 dark:text-emerald-400">
                                {card.availableQty} in stock
                              </span>
                            ) : (
                              <span className="font-medium text-red-600 dark:text-red-400">
                                Out of stock ({card.availableQty}/{card.requiredQty})
                              </span>
                            )}
                          </p>
                          {canMutate && (tr.back || tr.forward) && (
                            <div className="mt-2 flex gap-2">
                              {tr.back && (
                                <button
                                  type="button"
                                  onClick={() => void move(card, tr.back!)}
                                  className="flex h-11 min-w-[44px] flex-1 items-center justify-center gap-1 rounded-md border border-gray-300 px-2 py-1 text-xs text-gray-700 hover:bg-gray-100 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
                                  data-testid={`kanban-back-${card.id}`}
                                  aria-label={`Move ${card.medicineName} back to ${tr.back}`}
                                >
                                  <ArrowLeft size={12} /> Back
                                </button>
                              )}
                              {tr.forward && (
                                <button
                                  type="button"
                                  onClick={() => void move(card, tr.forward!)}
                                  disabled={forwardBlocked}
                                  title={
                                    forwardBlocked
                                      ? "Out of stock — can't move until restocked"
                                      : undefined
                                  }
                                  className="flex h-11 min-w-[44px] flex-1 items-center justify-center gap-1 rounded-md bg-primary px-2 py-1 text-xs font-medium text-white hover:bg-primary-dark disabled:cursor-not-allowed disabled:opacity-50"
                                  data-testid={`kanban-move-${card.id}`}
                                  aria-label={`Move ${card.medicineName} forward to ${tr.forward}`}
                                >
                                  {tr.forward === "DISPENSED" ? "Dispense" : "Move"}{" "}
                                  <ArrowRight size={12} />
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

      {/* Confirm popup before generating / updating the pharmacy bill. Lists
          the dispensed medicines that will be billed (dispensed-only). */}
      {showBillConfirm && (() => {
        const dispensedCards = (payload?.columns.DISPENSED ?? []).filter(
          (c) => c.prescriptionId === prescriptionFilter,
        );
        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
            <div
              className="max-h-[85vh] w-full max-w-md overflow-hidden rounded-xl bg-white shadow-xl dark:bg-gray-800"
              data-testid="kanban-bill-confirm-modal"
            >
              <div className="border-b border-gray-200 px-6 py-4 dark:border-gray-700">
                <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                  {billedInvoiceId ? "Update bill" : "Generate bill"}
                </h2>
                <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">
                  These {dispensedCards.length} dispensed medicine
                  {dispensedCards.length === 1 ? "" : "s"} will be billed.
                  Out-of-stock / undispensed lines are not included.
                </p>
              </div>
              <ul className="max-h-[45vh] space-y-2 overflow-y-auto p-6">
                {dispensedCards.length === 0 ? (
                  <li className="text-sm text-gray-500 dark:text-gray-400">
                    No dispensed medicines to bill.
                  </li>
                ) : (
                  dispensedCards.map((c) => (
                    <li
                      key={c.id}
                      className="flex items-center justify-between gap-3 rounded-lg border border-gray-200 bg-gray-50 p-3 text-sm dark:border-gray-700 dark:bg-gray-900"
                    >
                      <span className="font-medium text-gray-900 dark:text-gray-100">
                        {c.medicineName}
                      </span>
                      <span className="shrink-0 text-xs text-gray-500 dark:text-gray-400">
                        Qty: {c.requiredQty}
                      </span>
                    </li>
                  ))
                )}
              </ul>
              <div className="flex items-center justify-end gap-3 border-t border-gray-200 bg-gray-50 px-6 py-4 dark:border-gray-700 dark:bg-gray-900/40">
                <button
                  type="button"
                  onClick={() => setShowBillConfirm(false)}
                  disabled={billing}
                  className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
                  data-testid="kanban-bill-cancel"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => void goToBill()}
                  disabled={billing || dispensedCards.length === 0}
                  className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark disabled:cursor-not-allowed disabled:opacity-50"
                  data-testid="kanban-bill-confirm"
                >
                  {billing
                    ? "Generating…"
                    : billedInvoiceId
                      ? "Update Bill"
                      : "Generate Bill"}
                </button>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}

function findCard(payload: KanbanPayload, id: string | null): MedCard | null {
  if (!id) return null;
  for (const list of Object.values(payload.columns)) {
    const hit = list.find((c) => c.id === id);
    if (hit) return hit;
  }
  return null;
}
