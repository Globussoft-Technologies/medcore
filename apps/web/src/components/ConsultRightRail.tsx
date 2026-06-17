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
import { Star, Pill, History, Loader2, X, Activity } from "lucide-react";

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

interface RailVitals {
  bloodPressureSystolic: number | null;
  bloodPressureDiastolic: number | null;
  pulseRate: number | null;
  temperature: number | null;
  spO2: number | null;
  respiratoryRate: number | null;
  weight: number | null;
  recordedAt: string;
}

export interface Visit {
  id: string;
  createdAt: string;
  diagnosis: string;
  // Full SOAP sections (populated for signed consultations; null for plain
  // prescriptions). `advice` carries the Plan text.
  subjective?: string | null;
  objective?: string | null;
  assessment?: string | null;
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
  // Show a patient + "Last vitals" card above the Last-3-visits card (fetches
  // the patient's most recent vitals). Used by the AI scribe page, which has
  // no left-rail patient/vitals panel of its own.
  showLastVitals?: boolean;
  // Patient identity for the top card (avatar/name/gender/blood group). Shown
  // alongside Last vitals when provided.
  patient?: {
    name?: string | null;
    age?: number | null;
    gender?: string | null;
    bloodGroup?: string | null;
    phone?: string | null;
  } | null;
  // Let the Last-3-visits card grow to fill the column height (scrolling its
  // list inside) instead of hugging its rows. Used by the AI scribe rail so
  // the right column has stable, full-height cards.
  fillLastVisits?: boolean;
  // Clicking a "Last 3 visits" row calls this so the parent can render the
  // visit's full detail in the MAIN consult panel (not a popup overlay).
  onSelectVisit?: (visit: Visit) => void;
  // Lay the two cards out side-by-side (Favourites | Last 3 visits)
  // instead of stacked, and drop the narrow column-width cap. Used by
  // the manual consult page when the rail is rendered as a wide
  // bottom band on laptop viewports — without this the cards stayed
  // squeezed into a 288-px column with empty space to the right.
  horizontal?: boolean;
}

// Split markdown-ish advice/plan text ("## Heading\nbody…") into sections so the
// visit modal renders proper headings + bodies instead of one raw blob.
function parseAdviceSections(
  text: string,
): { heading: string | null; body: string }[] {
  const acc: { heading: string | null; body: string[] }[] = [];
  for (const raw of text.split("\n")) {
    const m = raw.match(/^\s*#{1,6}\s+(.+?)\s*$/);
    if (m) {
      acc.push({ heading: m[1], body: [] });
    } else {
      if (acc.length === 0) acc.push({ heading: null, body: [] });
      acc[acc.length - 1].body.push(raw);
    }
  }
  return acc
    .map((s) => ({ heading: s.heading, body: s.body.join("\n").trim() }))
    .filter((s) => s.heading || s.body);
}

// Medicine count for a visit row. Prescription visits carry structured `items`;
// consultation-note visits keep their meds as lines in the Plan's "Medications"
// section, so fall back to counting those instead of showing a wrong "0 items".
function visitItemCount(v: Visit): number {
  if (v.items.length > 0) return v.items.length;
  if (!v.advice) return 0;
  const med = parseAdviceSections(v.advice).find(
    (s) => s.heading?.trim().toLowerCase() === "medications",
  );
  if (!med?.body) return 0;
  return med.body
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean).length;
}

// Compact label/value pair for the "Last vitals" card.
function RailStat({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-gray-500 dark:text-gray-400">{label}</dt>
      <dd className="font-medium text-gray-900 dark:text-gray-100">{value}</dd>
    </>
  );
}

export function ConsultRightRail({
  doctorId,
  patientId,
  token,
  onPasteDiagnosis,
  onPasteMedicine,
  hideFavourites = false,
  showLastVitals = false,
  patient = null,
  fillLastVisits = false,
  onSelectVisit,
  horizontal = false,
}: ConsultRightRailProps) {
  const [favourites, setFavourites] = useState<FavouritesPayload | null>(null);
  const [favLoading, setFavLoading] = useState(false);
  const [visits, setVisits] = useState<Visit[] | null>(null);
  const [visitsLoading, setVisitsLoading] = useState(false);
  const [lastVitals, setLastVitals] = useState<RailVitals | null>(null);

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

  // Fetch the patient's most recent vitals (only when asked — the manual
  // consult page already shows them in its own left rail).
  useEffect(() => {
    if (!showLastVitals || !patientId || !token) return;
    let cancelled = false;
    api
      .get<{ success: boolean; data: RailVitals[]; error: string | null }>(
        `/patients/${patientId}/vitals?limit=1`,
        { headers: { Authorization: `Bearer ${token}` } },
      )
      .then((res) => {
        if (!cancelled) setLastVitals(res.data?.[0] ?? null);
      })
      .catch(() => {
        if (!cancelled) setLastVitals(null);
      });
    return () => {
      cancelled = true;
    };
  }, [showLastVitals, patientId, token]);

  return (
    <aside
      data-testid="consult-right-rail"
      className={
        horizontal
          ? "grid w-full grid-cols-1 gap-3 sm:grid-cols-2"
          : "flex flex-col gap-3 h-full w-full"
      }
    >
      {/* ── Favourites ──────────────────────────────────────── */}
      {!hideFavourites && (
      <div className="bg-white rounded-2xl shadow border border-gray-100 p-4 flex flex-col gap-3 flex-1 min-h-0 dark:bg-gray-800 dark:border-gray-700">
        <div className="flex items-center gap-2">
          <Star className="w-4 h-4 text-amber-500" />
          <p className="font-semibold text-sm text-gray-700 dark:text-gray-200">
            Favourites
          </p>
          {favLoading && <Loader2 className="w-3.5 h-3.5 animate-spin text-gray-400" />}
        </div>

        <div
          className="flex flex-col gap-3 overflow-y-auto scrollbar-hide flex-1 min-h-0"
          data-testid="consult-rail-fav-scroll"
        >
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
      </div>
      )}

      {/* ── Patient card (own box, above vitals + visits, opt-in) ── */}
      {showLastVitals && patient && (patient.name || patient.bloodGroup) && (
        <div className="bg-white rounded-2xl shadow border border-gray-100 p-5 flex flex-col items-center gap-1 text-center shrink-0 dark:bg-gray-800 dark:border-gray-700">
          <div className="flex h-20 w-20 items-center justify-center rounded-full bg-indigo-100 text-xl font-semibold text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300">
            {(patient.name ?? "?")
              .split(" ")
              .map((w) => w[0])
              .filter(Boolean)
              .slice(0, 2)
              .join("")
              .toUpperCase() || "?"}
          </div>
          <p className="mt-2 text-base font-semibold text-gray-900 dark:text-gray-100">
            {patient.name ?? "—"}
          </p>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            {patient.age != null ? `${patient.age}y` : "—"}
            {patient.gender ? ` · ${patient.gender}` : ""}
          </p>
          {patient.phone && (
            <p className="text-xs text-gray-500 dark:text-gray-400">
              {patient.phone}
            </p>
          )}
          {patient.bloodGroup && (
            <span className="mt-1 rounded-full bg-rose-100 px-3 py-0.5 text-xs font-semibold text-rose-800 dark:bg-rose-900/40 dark:text-rose-200">
              {patient.bloodGroup}
            </span>
          )}
        </div>
      )}

      {/* ── Last vitals (own box, above Last 3 visits, opt-in) ── */}
      {showLastVitals && (
        <div className="bg-white rounded-2xl shadow border border-gray-100 p-4 flex flex-col gap-3 shrink-0 dark:bg-gray-800 dark:border-gray-700">
          <div className="flex items-center gap-2">
            <Activity className="w-4 h-4 text-rose-500" />
            <p className="font-semibold text-sm text-gray-700 dark:text-gray-200">
              Last vitals
            </p>
          </div>
          {/* Always show the key vital fields — fall back to "—" when a value
              (or the whole record) is missing, instead of an empty card. */}
          <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
            <RailStat
              label="BP"
              value={
                lastVitals?.bloodPressureSystolic != null
                  ? `${lastVitals.bloodPressureSystolic}/${lastVitals.bloodPressureDiastolic ?? "—"}`
                  : "—"
              }
            />
            <RailStat
              label="Pulse"
              value={lastVitals?.pulseRate != null ? `${lastVitals.pulseRate}` : "—"}
            />
            <RailStat
              label="Temp"
              value={
                lastVitals?.temperature != null ? `${lastVitals.temperature}°` : "—"
              }
            />
            <RailStat
              label="SpO2"
              value={lastVitals?.spO2 != null ? `${lastVitals.spO2}%` : "—"}
            />
            <RailStat
              label="RR"
              value={
                lastVitals?.respiratoryRate != null
                  ? `${lastVitals.respiratoryRate}`
                  : "—"
              }
            />
            <RailStat
              label="Wt"
              value={lastVitals?.weight != null ? `${lastVitals.weight}kg` : "—"}
            />
          </dl>
          {!lastVitals && (
            <p className="text-[11px] italic text-gray-400 dark:text-gray-500">
              No vitals recorded yet
            </p>
          )}
        </div>
      )}

      {/* ── Last 3 visits ──────────────────────────────────── */}
      {/* Content-sized (shrink-0) — capped at 3 rows, so it never stretches to
          fill the column or leave empty space; Favourites takes the slack. */}
      <div
        className={`bg-white rounded-2xl shadow border border-gray-100 p-4 flex flex-col gap-3 dark:bg-gray-800 dark:border-gray-700 ${
          fillLastVisits ? "flex-1 min-h-0" : "shrink-0"
        }`}
      >
        <div className="flex items-center gap-2">
          <History className="w-4 h-4 text-blue-600" />
          <p className="font-semibold text-sm text-gray-700 dark:text-gray-200">
            Last 3 visits
          </p>
          {visitsLoading && <Loader2 className="w-3.5 h-3.5 animate-spin text-gray-400" />}
        </div>

        <div
          className={`flex flex-col gap-2 overflow-y-auto scrollbar-hide ${
            fillLastVisits ? "flex-1 min-h-0" : ""
          }`}
          data-testid="consult-rail-visits"
        >
          {visits === null && !visitsLoading ? (
            <p className="text-xs text-gray-400 italic">Select a patient to see visits</p>
          ) : visits?.length === 0 ? (
            <p className="text-xs text-gray-400 italic">No prior visits for this patient</p>
          ) : (
            visits?.map((v) => (
              <button
                key={v.id}
                type="button"
                data-testid="consult-rail-visit"
                data-visit-id={v.id}
                onClick={() => onSelectVisit?.(v)}
                className="touch-target text-left w-full px-3 py-2 rounded-xl border border-gray-200 hover:border-blue-300 hover:bg-blue-50 dark:border-gray-700 dark:hover:bg-blue-900/20"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold text-gray-700 dark:text-gray-200 truncate">
                    {new Date(v.createdAt).toLocaleDateString()}
                  </span>
                  <span className="shrink-0 text-[10px] text-gray-400">
                    {visitItemCount(v)} medicine
                    {visitItemCount(v) === 1 ? "" : "s"}
                  </span>
                </div>
                <p className="text-xs text-gray-600 truncate dark:text-gray-300">
                  {v.diagnosis || "(no diagnosis)"}
                </p>
              </button>
            ))
          )}
        </div>
      </div>
    </aside>
  );
}

// Full detail for a single past visit, rendered INLINE in the main consult
// panel (not a popup) when the doctor clicks a "Last 3 visits" row. The
// advice/plan text ("## Heading" blocks) is parsed into proper sections, long
// text wraps, and a "Back to consult" button returns to the SOAP editor.
// One labelled SOAP section. Its body is split on "## " sub-headings so
// multi-part text (e.g. a Plan with Investigations / Follow-up / Instructions)
// stays structured; long lines wrap.
function SoapSectionBlock({ title, text }: { title: string; text: string }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-900/40">
      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
        {title}
      </p>
      <div className="space-y-3">
        {parseAdviceSections(text).map((s, i) => (
          <div key={i}>
            {s.heading && (
              <p className="text-sm font-semibold text-gray-800 dark:text-gray-100">
                {s.heading}
              </p>
            )}
            {s.body && (
              <p className="mt-0.5 whitespace-pre-wrap break-words text-sm text-gray-600 dark:text-gray-300">
                {s.body}
              </p>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

export function VisitDetail({
  visit,
  onBack,
}: {
  visit: Visit;
  onBack: () => void;
}) {
  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-700 dark:bg-gray-800">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">
            Past Visit · {new Date(visit.createdAt).toLocaleDateString()}
          </h3>
          <p className="mt-0.5 break-words text-sm text-gray-500 dark:text-gray-400">
            {visit.diagnosis || "(no diagnosis)"}
          </p>
        </div>
        <button
          type="button"
          onClick={onBack}
          data-testid="consult-visit-detail-back"
          title="Back to consult"
          aria-label="Back to consult"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-gray-200 text-gray-600 transition hover:border-gray-300 hover:bg-gray-50 hover:text-gray-900 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-700 dark:hover:text-gray-100"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="space-y-5">
        {visit.subjective && (
          <SoapSectionBlock title="Subjective" text={visit.subjective} />
        )}
        {visit.objective && (
          <SoapSectionBlock title="Objective" text={visit.objective} />
        )}
        {visit.assessment && (
          <SoapSectionBlock title="Assessment" text={visit.assessment} />
        )}

        {(() => {
          // The Plan is serialized with `## <Label>` headers, so the SOAP
          // "Medications" field comes back as one of these advice sections.
          // Render Medications ONCE — prefer structured Rx items (prescription
          // visits), else the SOAP plan's "Medications" text (consult-note
          // visits) — and never show the parsed "Medications" section twice.
          const adviceSections = visit.advice
            ? parseAdviceSections(visit.advice)
            : [];
          const medSection = adviceSections.find(
            (s) => s.heading?.trim().toLowerCase() === "medications",
          );
          const otherSections = adviceSections.filter(
            (s) => s.heading?.trim().toLowerCase() !== "medications",
          );
          return (
            <div className="rounded-xl border border-gray-200 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-900/40">
              <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                Plan
              </p>

              {/* Medications are part of the Plan */}
              <div className="mb-4">
                <p className="mb-1.5 text-sm font-semibold text-gray-800 dark:text-gray-100">
                  Medications
                </p>
                {visit.items.length > 0 ? (
                  <div className="space-y-2">
                    {visit.items.map((it, i) => (
                      <div
                        key={i}
                        className="border-b border-gray-200 pb-2 last:border-0 last:pb-0 dark:border-gray-700"
                      >
                        <p className="break-words text-sm font-medium text-gray-800 dark:text-gray-100">
                          {it.medicineName}
                        </p>
                        <p className="break-words text-xs text-gray-500 dark:text-gray-400">
                          {it.dosage} · {it.frequency} · {it.duration}
                        </p>
                      </div>
                    ))}
                  </div>
                ) : medSection?.body ? (
                  <p className="whitespace-pre-wrap break-words text-sm text-gray-700 dark:text-gray-200">
                    {medSection.body}
                  </p>
                ) : (
                  <p className="text-sm italic text-gray-400">
                    No medicines on this visit
                  </p>
                )}
              </div>

              {/* Plan text — Investigations / Follow-up / Patient Instructions */}
              {otherSections.map((s, i) => (
                <div key={i} className="mt-3">
                  {s.heading && (
                    <p className="text-sm font-semibold text-gray-800 dark:text-gray-100">
                      {s.heading}
                    </p>
                  )}
                  {s.body && (
                    <p className="mt-0.5 whitespace-pre-wrap break-words text-sm text-gray-600 dark:text-gray-300">
                      {s.body}
                    </p>
                  )}
                </div>
              ))}
            </div>
          );
        })()}

        {visit.followUpDate && (
          <div className="rounded-xl border border-gray-200 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-900/40">
            <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
              Follow-up
            </p>
            <p className="text-sm text-gray-600 dark:text-gray-300">
              {new Date(visit.followUpDate).toLocaleDateString()}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
