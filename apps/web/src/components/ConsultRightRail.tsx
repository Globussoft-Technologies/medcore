"use client";

// Pearl ERP Stage 1 §2.1.3 (gap row 46) — right rail for the 3-column consult
// screen on /dashboard/scribe.
//
// What / which modules / why:
//   - Surfaces two compute-on-the-fly aggregates fed by `routes/consult-rail.ts`:
//       1. Derived favourites — top 5 diagnoses + top 5 medicines computed
//          from the calling doctor's last 50 prescriptions. Distinct from the
//          user-curated DoctorFavouriteMedicine list (gap row 50, kept).
//       2. Last 3 visits for the active patient — date + diagnosis + Rx item
//          summary, expandable inline.
//   - Every favourite is click-to-paste: diagnoses paste into the SOAP
//     Subjective.chiefComplaint via `onPasteDiagnosis`; medicines append to
//     SOAP Plan.medications via `onPasteMedicine`. The parent (scribe page)
//     wires those handlers to `updateSOAPField` / `setEditedSOAP` so the
//     paste lands in the active draft.
//   - 44-px minimum touch targets (CLAUDE.md §6.2 — `.touch-target` utility
//     is the shared 44×44 helper used across mobile-responsive surfaces).
//   - data-testid hooks on every interactive element so the smoke test
//     (`__tests__/ConsultRightRail.test.tsx`) can click favourites and
//     assert paste callbacks fire.

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Star, Pill, History, Loader2 } from "lucide-react";

interface Favourite {
  value: string;
  count: number;
}

interface FavouritesPayload {
  diagnoses: Favourite[];
  medicines: Favourite[];
  sampledFrom: number;
}

interface VisitRxItem {
  medicineName: string;
  dosage: string;
  frequency: string;
  duration: string;
}

interface Visit {
  id: string;
  createdAt: string;
  diagnosis: string;
  advice: string | null;
  followUpDate: string | null;
  items: VisitRxItem[];
}

export interface ConsultRightRailProps {
  doctorId: string | null;
  patientId: string | null;
  token: string | null;
  onPasteDiagnosis?: (value: string) => void;
  onPasteMedicine?: (medicine: { name: string; dose?: string; frequency?: string; duration?: string }) => void;
  // Hide the Favourites card (top diagnoses + top medicines). The AI
  // scribe page sets this true because the draft is voice/LLM-driven
  // and the click-to-paste favourites aren't part of that workflow.
  hideFavourites?: boolean;
  // Lay the two cards out side-by-side (Favourites | Last 3 visits)
  // instead of stacked, and drop the narrow column-width cap. Used by
  // the manual consult page when the rail is rendered as a wide
  // bottom band on laptop viewports — without this the cards stayed
  // squeezed into a 288-px column with empty space to the right.
  horizontal?: boolean;
}

export function ConsultRightRail({
  doctorId,
  patientId,
  token,
  onPasteDiagnosis,
  onPasteMedicine,
  hideFavourites = false,
  horizontal = false,
}: ConsultRightRailProps) {
  const [favourites, setFavourites] = useState<FavouritesPayload | null>(null);
  const [favLoading, setFavLoading] = useState(false);
  const [visits, setVisits] = useState<Visit[] | null>(null);
  const [visitsLoading, setVisitsLoading] = useState(false);
  const [expandedVisitId, setExpandedVisitId] = useState<string | null>(null);

  // Fetch derived favourites whenever the doctor changes. Doctor identity
  // is stable across a session so this typically fires once. Skipped
  // entirely when hideFavourites is true to avoid an unused HTTP call.
  useEffect(() => {
    if (hideFavourites) return;
    if (!doctorId || !token) return;
    let cancelled = false;
    setFavLoading(true);
    api
      .get<{ success: boolean; data: FavouritesPayload | null; error: string | null }>(
        `/consult-rail/favourites/${doctorId}`,
        { headers: { Authorization: `Bearer ${token}` } },
      )
      .then((res) => {
        if (!cancelled) setFavourites(res.data ?? null);
      })
      .catch(() => {
        if (!cancelled) setFavourites(null);
      })
      .finally(() => {
        if (!cancelled) setFavLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [doctorId, token, hideFavourites]);

  // Re-fetch last-3 visits whenever the active patient changes (selecting a
  // new appointment in the left rail rebinds patientId).
  useEffect(() => {
    if (!patientId || !token) return;
    let cancelled = false;
    setVisitsLoading(true);
    api
      .get<{ success: boolean; data: Visit[]; error: string | null }>(
        `/consult-rail/visits/${patientId}`,
        { headers: { Authorization: `Bearer ${token}` } },
      )
      .then((res) => {
        if (!cancelled) setVisits(res.data ?? []);
      })
      .catch(() => {
        if (!cancelled) setVisits([]);
      })
      .finally(() => {
        if (!cancelled) setVisitsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [patientId, token]);

  return (
    <aside
      data-testid="consult-right-rail"
      className={
        horizontal
          ? "grid w-full grid-cols-1 gap-3 sm:grid-cols-2"
          : "flex flex-col gap-3 h-full w-full lg:w-72 lg:max-w-xs"
      }
    >
      {/* ── Favourites ──────────────────────────────────────── */}
      {!hideFavourites && (
      <div className="bg-white rounded-2xl shadow border border-gray-100 p-4 flex flex-col gap-3 dark:bg-gray-800 dark:border-gray-700">
        <div className="flex items-center gap-2">
          <Star className="w-4 h-4 text-amber-500" />
          <p className="font-semibold text-sm text-gray-700 dark:text-gray-200">
            Favourites
          </p>
          {favLoading && <Loader2 className="w-3.5 h-3.5 animate-spin text-gray-400" />}
        </div>

        <div className="space-y-2">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
            Top diagnoses
          </p>
          {favourites?.diagnoses?.length ? (
            <div className="flex flex-col gap-1.5" data-testid="consult-rail-fav-diagnoses">
              {favourites.diagnoses.map((d) => (
                <button
                  key={d.value}
                  type="button"
                  data-testid="consult-rail-fav-diagnosis"
                  data-value={d.value}
                  onClick={() => onPasteDiagnosis?.(d.value)}
                  disabled={!onPasteDiagnosis}
                  className="touch-target flex items-center justify-between gap-2 w-full text-left px-3 py-2 rounded-xl border border-gray-200 text-xs text-gray-700 hover:border-blue-300 hover:bg-blue-50 disabled:opacity-50 disabled:cursor-not-allowed dark:border-gray-700 dark:text-gray-200 dark:hover:bg-blue-900/20"
                  title={`Paste "${d.value}" into Chief Complaint`}
                >
                  <span className="truncate">{d.value}</span>
                  <span className="shrink-0 text-[10px] text-gray-400">×{d.count}</span>
                </button>
              ))}
            </div>
          ) : (
            <p className="text-xs text-gray-400 italic">
              {favLoading ? "Loading…" : "No history yet"}
            </p>
          )}
        </div>

        <div className="space-y-2 pt-2 border-t border-gray-100 dark:border-gray-700">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400 flex items-center gap-1.5">
            <Pill className="w-3 h-3" /> Top medicines
          </p>
          {favourites?.medicines?.length ? (
            <div className="flex flex-col gap-1.5" data-testid="consult-rail-fav-medicines">
              {favourites.medicines.map((m) => (
                <button
                  key={m.value}
                  type="button"
                  data-testid="consult-rail-fav-medicine"
                  data-value={m.value}
                  onClick={() => onPasteMedicine?.({ name: m.value })}
                  disabled={!onPasteMedicine}
                  className="touch-target flex items-center justify-between gap-2 w-full text-left px-3 py-2 rounded-xl border border-gray-200 text-xs text-gray-700 hover:border-green-300 hover:bg-green-50 disabled:opacity-50 disabled:cursor-not-allowed dark:border-gray-700 dark:text-gray-200 dark:hover:bg-green-900/20"
                  title={`Append "${m.value}" to Plan medications`}
                >
                  <span className="truncate">{m.value}</span>
                  <span className="shrink-0 text-[10px] text-gray-400">×{m.count}</span>
                </button>
              ))}
            </div>
          ) : (
            <p className="text-xs text-gray-400 italic">
              {favLoading ? "Loading…" : "No history yet"}
            </p>
          )}
        </div>
      </div>
      )}

      {/* ── Last 3 visits ──────────────────────────────────── */}
      <div className="bg-white rounded-2xl shadow border border-gray-100 p-4 flex flex-col gap-3 flex-1 overflow-hidden dark:bg-gray-800 dark:border-gray-700">
        <div className="flex items-center gap-2">
          <History className="w-4 h-4 text-blue-600" />
          <p className="font-semibold text-sm text-gray-700 dark:text-gray-200">
            Last 3 visits
          </p>
          {visitsLoading && <Loader2 className="w-3.5 h-3.5 animate-spin text-gray-400" />}
        </div>

        <div
          className="flex flex-col gap-2 overflow-y-auto"
          data-testid="consult-rail-visits"
        >
          {visits === null && !visitsLoading ? (
            <p className="text-xs text-gray-400 italic">Select a patient to see visits</p>
          ) : visits?.length === 0 ? (
            <p className="text-xs text-gray-400 italic">No prior visits for this patient</p>
          ) : (
            visits?.map((v) => {
              const isOpen = expandedVisitId === v.id;
              return (
                <button
                  key={v.id}
                  type="button"
                  data-testid="consult-rail-visit"
                  data-visit-id={v.id}
                  onClick={() => setExpandedVisitId(isOpen ? null : v.id)}
                  className="touch-target text-left w-full px-3 py-2 rounded-xl border border-gray-200 hover:border-blue-300 hover:bg-blue-50 dark:border-gray-700 dark:hover:bg-blue-900/20"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-semibold text-gray-700 dark:text-gray-200 truncate">
                      {new Date(v.createdAt).toLocaleDateString()}
                    </span>
                    <span className="shrink-0 text-[10px] text-gray-400">
                      {v.items.length} item{v.items.length === 1 ? "" : "s"}
                    </span>
                  </div>
                  <p className="text-xs text-gray-600 truncate dark:text-gray-300">
                    {v.diagnosis || "(no diagnosis)"}
                  </p>
                  {isOpen && (
                    <div
                      className="mt-2 pt-2 border-t border-gray-100 space-y-1 dark:border-gray-700"
                      data-testid="consult-rail-visit-detail"
                    >
                      {v.items.length === 0 ? (
                        <p className="text-[11px] text-gray-400 italic">No medicines on this visit</p>
                      ) : (
                        v.items.map((it, i) => (
                          <p
                            key={i}
                            className="text-[11px] text-gray-600 dark:text-gray-300"
                          >
                            <span className="font-medium">{it.medicineName}</span> · {it.dosage} ·{" "}
                            {it.frequency} · {it.duration}
                          </p>
                        ))
                      )}
                      {v.advice && (
                        <p className="text-[11px] text-gray-500 italic dark:text-gray-400">
                          Advice: {v.advice}
                        </p>
                      )}
                    </div>
                  )}
                </button>
              );
            })
          )}
        </div>
      </div>
    </aside>
  );
}
