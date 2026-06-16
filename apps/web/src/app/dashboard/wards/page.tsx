"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import { useAuthStore } from "@/lib/store";
import { getSocket } from "@/lib/socket";
import { Plus, Hotel, TrendingUp } from "lucide-react";
// Issue #348 — shared bed-summary helper so Wards/Admissions/Dashboard
// all produce identical counts regardless of which `/wards` payload
// variant they happen to receive.
// Issue #507 — `bedBarSegments` returns the per-status widths the
// occupancy bar must render so colors always match the numeric counts
// (the old inline math omitted MAINTENANCE and let flex shrink the
// segments away from their declared widths).
import {
  summarizeBeds,
  getBedSummary,
  bedBarSegments,
} from "@/lib/bed-summary";
import { SkeletonCard } from "@/components/Skeleton";

interface Bed {
  id: string;
  bedNumber: string;
  status: "AVAILABLE" | "OCCUPIED" | "CLEANING" | "MAINTENANCE";
  wardId: string;
  dailyRate?: number;
}

interface Ward {
  id: string;
  name: string;
  type: string;
  floor: string | number | null;
  description?: string | null;
  beds?: Bed[];
  totalBeds?: number;
  availableBeds?: number;
  occupiedBeds?: number;
  cleaningBeds?: number;
  maintenanceBeds?: number;
}

const STATUS_COLORS: Record<string, string> = {
  AVAILABLE: "bg-green-500 hover:bg-green-600",
  OCCUPIED: "bg-red-500 hover:bg-red-600",
  CLEANING: "bg-yellow-500 hover:bg-yellow-600",
  MAINTENANCE: "bg-gray-500 hover:bg-gray-600",
};

const STATUS_LABELS: Record<string, string> = {
  AVAILABLE: "Available",
  OCCUPIED: "Occupied",
  CLEANING: "Cleaning",
  MAINTENANCE: "Maintenance",
};

// Parse the Daily Rate text input into the number the API expects.
// Returns `undefined` for blank (so the request omits it and the schema's
// `.default(0)` applies), `null` for an invalid/negative value (caller shows
// an error), or the parsed number otherwise.
function parseDailyRate(raw: string): number | null | undefined {
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

const WARD_TYPES = [
  "GENERAL",
  "PRIVATE",
  "SEMI_PRIVATE",
  "ICU",
  "NICU",
  "PICU",
  "MATERNITY",
  "EMERGENCY",
  "ISOLATION",
];

export default function WardsPage() {
  const { user } = useAuthStore();
  const [wards, setWards] = useState<Ward[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [showWardModal, setShowWardModal] = useState(false);
  const [tab, setTab] = useState<"beds" | "forecast">("beds");
  const [showBedModal, setShowBedModal] = useState<string | null>(null);
  // Issue #719 (2026-05-08): admins reported the Add Bed button was dead
  // because it only existed INSIDE an expanded ward card. Add a top-level
  // "Add Bed" CTA that prompts the admin for both ward + bed number.
  const [showGlobalBedModal, setShowGlobalBedModal] = useState(false);
  const [globalBedForm, setGlobalBedForm] = useState({
    wardId: "",
    bedNumber: "",
    dailyRate: "",
  });
  const [creatingWard, setCreatingWard] = useState(false);
  const [creatingBed, setCreatingBed] = useState(false);
  const [wardForm, setWardForm] = useState({
    name: "",
    type: "GENERAL",
    floor: "",
    description: "",
  });
  const [bedForm, setBedForm] = useState({ bedNumber: "", dailyRate: "" });

  const isAdmin = user?.role === "ADMIN";

  useEffect(() => {
    loadWards();
  }, []);

  // Live updates when admissions change
  useEffect(() => {
    const socket = getSocket();
    if (!socket.connected) socket.connect();
    const handler = () => loadWards();
    socket.on("admission:status", handler);
    return () => {
      socket.off("admission:status", handler);
    };
  }, []);

  async function loadWards() {
    setLoading(true);
    try {
      const res = await api.get<{ data: Ward[] }>("/wards");
      setWards(res.data);
    } catch {
      // empty
    }
    setLoading(false);
  }

  // Issue #348 — delegate to the shared helper so every page that
  // displays bed counts agrees. Locally computing again here would
  // re-introduce drift the moment a new fallback path is added.
  function computeCounts(ward: Ward) {
    return summarizeBeds(ward);
  }

  const totals = getBedSummary(wards);

  async function createWard(e: React.FormEvent) {
    e.preventDefault();
    if (!wardForm.name.trim()) {
      toast.error("Ward name is required");
      return;
    }
    setCreatingWard(true);
    try {
      await api.post("/wards", {
        name: wardForm.name,
        type: wardForm.type,
        floor: wardForm.floor || undefined,
        description: wardForm.description || undefined,
      });
      // Issue #719: surface a success toast so admins know the click took.
      toast.success("Ward created");
      setShowWardModal(false);
      setWardForm({ name: "", type: "GENERAL", floor: "", description: "" });
      loadWards();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create ward");
    } finally {
      setCreatingWard(false);
    }
  }

  // Issue #719: top-level Add Bed handler — picks the ward from a dropdown.
  async function createGlobalBed(e: React.FormEvent) {
    e.preventDefault();
    if (!globalBedForm.wardId) {
      toast.error("Select a ward");
      return;
    }
    if (!globalBedForm.bedNumber.trim()) {
      toast.error("Bed number is required");
      return;
    }
    const rate = parseDailyRate(globalBedForm.dailyRate);
    if (rate === null) {
      toast.error("Daily rate must be a number ≥ 0");
      return;
    }
    setCreatingBed(true);
    try {
      await api.post(`/wards/${globalBedForm.wardId}/beds`, {
        bedNumber: globalBedForm.bedNumber,
        ...(rate !== undefined && { dailyRate: rate }),
      });
      toast.success("Bed created");
      setShowGlobalBedModal(false);
      setGlobalBedForm({ wardId: "", bedNumber: "", dailyRate: "" });
      loadWards();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to add bed");
    } finally {
      setCreatingBed(false);
    }
  }

  async function addBed(e: React.FormEvent, wardId: string) {
    e.preventDefault();
    if (!bedForm.bedNumber.trim()) {
      toast.error("Bed number is required");
      return;
    }
    const rate = parseDailyRate(bedForm.dailyRate);
    if (rate === null) {
      toast.error("Daily rate must be a number ≥ 0");
      return;
    }
    try {
      await api.post(`/wards/${wardId}/beds`, {
        bedNumber: bedForm.bedNumber,
        ...(rate !== undefined && { dailyRate: rate }),
      });
      toast.success("Bed added");
      setShowBedModal(null);
      setBedForm({ bedNumber: "", dailyRate: "" });
      loadWards();
    } catch (err) {
      // Issue #36 — the old handler only showed err.message which for a 400
      // was the generic "Validation failed". Surface field-level details
      // when the API attached them so the user can see which field is wrong.
      const e = err as Error & {
        status?: number;
        payload?: {
          error?: string;
          details?: Array<{ field: string; message: string }>;
        };
      };
      const details = e?.payload?.details;
      const detailMsg =
        Array.isArray(details) && details.length > 0
          ? details.map((d) => `${d.field || "field"}: ${d.message}`).join("; ")
          : "";
      const message = detailMsg
        ? `${e.message}: ${detailMsg}`
        : e?.message || "Failed to add bed";
      toast.error(message);
    }
  }

  async function updateBedStatus(bedId: string, status: string) {
    try {
      await api.patch(`/beds/${bedId}/status`, { status });
      loadWards();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update bed");
    }
  }

  // Edit a bed's number and/or daily rate. `patch` carries only the changed
  // fields. Surfaces the API's friendly 409 message verbatim (duplicate bed
  // number) instead of a generic failure.
  async function editBed(
    bedId: string,
    changes: { bedNumber?: string; dailyRate?: number }
  ) {
    try {
      await api.patch(`/beds/${bedId}`, changes);
      toast.success("Bed updated");
      loadWards();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update bed");
      throw err; // let the caller keep the editor open on failure
    }
  }

  // Delete a bed. The API refuses (409) if the bed is occupied; we surface
  // that message so the admin knows to discharge/transfer first.
  async function deleteBed(bedId: string, bedNumber: string) {
    if (
      !window.confirm(
        `Delete bed "${bedNumber}"? This cannot be undone.`
      )
    ) {
      return;
    }
    try {
      await api.delete(`/beds/${bedId}`);
      toast.success("Bed deleted");
      loadWards();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete bed");
    }
  }

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Wards &amp; Beds</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            {totals.available} available · {totals.occupied} occupied ·{" "}
            {totals.total} total beds
          </p>
        </div>
        {isAdmin && (
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowGlobalBedModal(true)}
              data-testid="add-bed-cta"
              className="flex items-center gap-2 rounded-lg border border-primary px-4 py-2 text-sm font-medium text-primary hover:bg-primary/10"
            >
              <Plus size={16} /> Add Bed
            </button>
            <button
              onClick={() => setShowWardModal(true)}
              data-testid="add-ward-cta"
              className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark"
            >
              <Plus size={16} /> Add Ward
            </button>
          </div>
        )}
      </div>

      {/* Tabs */}
      <div className="mb-4 flex gap-2 border-b border-slate-200 dark:border-slate-700">
        <button
          onClick={() => setTab("beds")}
          className={`px-3 py-2 text-sm border-b-2 -mb-0.5 ${
            tab === "beds"
              ? "border-primary text-primary font-semibold"
              : "border-transparent text-slate-600 dark:text-slate-300"
          }`}
        >
          Beds
        </button>
        <button
          onClick={() => setTab("forecast")}
          className={`inline-flex items-center gap-1 px-3 py-2 text-sm border-b-2 -mb-0.5 ${
            tab === "forecast"
              ? "border-primary text-primary font-semibold"
              : "border-transparent text-slate-600 dark:text-slate-300"
          }`}
        >
          <TrendingUp size={14} /> Forecast
        </button>
      </div>

      {tab === "forecast" ? (
        <OccupancyForecast />
      ) : (
        <>
      {/* Summary cards */}
      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div className="rounded-xl bg-white p-5 text-gray-900 shadow-sm dark:bg-gray-800 dark:text-gray-100">
          <p className="text-sm text-gray-500 dark:text-gray-400">Total Beds</p>
          <p className="mt-1 text-3xl font-bold">{totals.total}</p>
        </div>
        <div className="rounded-xl bg-white p-5 shadow-sm dark:bg-gray-800">
          <p className="text-sm text-gray-500 dark:text-gray-400">Available</p>
          <p className="mt-1 text-3xl font-bold text-green-600 dark:text-green-400">
            {totals.available}
          </p>
        </div>
        <div className="rounded-xl bg-white p-5 shadow-sm dark:bg-gray-800">
          <p className="text-sm text-gray-500 dark:text-gray-400">Occupied</p>
          <p className="mt-1 text-3xl font-bold text-red-600 dark:text-red-400">
            {totals.occupied}
          </p>
        </div>
      </div>

      {loading ? (
        <div data-testid="wards-loading" aria-busy="true" className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          <SkeletonCard />
          <SkeletonCard />
          <SkeletonCard />
        </div>
      ) : wards.length === 0 ? (
        <div className="rounded-xl bg-white p-8 text-center text-gray-500 shadow-sm dark:bg-gray-800 dark:text-gray-400">
          No wards yet. {isAdmin && 'Click "Add Ward" to create one.'}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {wards.map((ward) => {
            const c = computeCounts(ward);
            // Issue #507 — delegate width math to the shared helper so
            // the bar always sums to 100% (and so MAINTENANCE beds get
            // their own slice instead of silently widening "available").
            const segments = bedBarSegments(c);
            const isExpanded = expanded === ward.id;
            return (
              <div
                key={ward.id}
                className={`rounded-xl bg-white p-5 text-gray-900 shadow-sm transition dark:bg-gray-800 dark:text-gray-100 ${
                  isExpanded ? "md:col-span-2 lg:col-span-3" : ""
                }`}
              >
                <button
                  onClick={() => setExpanded(isExpanded ? null : ward.id)}
                  className="w-full text-left"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Hotel className="text-primary" size={20} />
                      <h3 className="font-semibold">{ward.name}</h3>
                    </div>
                    <span className="rounded bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                      {ward.type.replace(/_/g, " ")}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                    Floor {ward.floor ?? "—"}
                  </p>

                  <div className="mt-3 flex items-center justify-between text-xs">
                    <span>
                      <span className="font-semibold">{c.total}</span> total
                    </span>
                    <span className="text-green-600">{c.available} avail</span>
                    <span className="text-red-600">{c.occupied} occ</span>
                    <span className="text-yellow-600">{c.cleaning} clean</span>
                  </div>

                  {/* Progress bar — Issue #507. `shrink-0` is load-bearing:
                      without it flexbox shrinks each segment away from its
                      declared width and the colors stop matching the counts. */}
                  <div className="mt-2 flex h-2 w-full overflow-hidden rounded bg-gray-200 dark:bg-gray-700">
                    <div
                      className="shrink-0 bg-red-500"
                      style={{ width: segments.occupied }}
                      title={`${c.occupied} occupied`}
                    />
                    <div
                      className="shrink-0 bg-yellow-500"
                      style={{ width: segments.cleaning }}
                      title={`${c.cleaning} cleaning`}
                    />
                    <div
                      className="shrink-0 bg-gray-500"
                      style={{ width: segments.maintenance }}
                      title={`${c.maintenance} maintenance`}
                    />
                    <div
                      className="shrink-0 bg-green-500"
                      style={{ width: segments.available }}
                      title={`${c.available} available`}
                    />
                  </div>
                </button>

                {isExpanded && (
                  <div className="mt-4 border-t border-gray-200 pt-4 dark:border-gray-700">
                    <div className="mb-3 flex items-center justify-between">
                      <h4 className="text-sm font-semibold">Beds</h4>
                      {isAdmin && (
                        <button
                          onClick={() => setShowBedModal(ward.id)}
                          className="flex items-center gap-1 rounded bg-primary px-2 py-1 text-xs text-white hover:bg-primary-dark"
                          data-testid={`add-bed-inline-${ward.id}`}
                        >
                          <Plus size={12} /> Add Bed
                        </button>
                      )}
                    </div>
                    {(ward.beds || []).length === 0 ? (
                      <p className="text-sm text-gray-500 dark:text-gray-400">No beds yet.</p>
                    ) : (
                      <div className="grid grid-cols-4 gap-2 sm:grid-cols-6 md:grid-cols-8">
                        {ward.beds!.map((bed) => (
                          <BedCell
                            key={bed.id}
                            bed={bed}
                            onChange={updateBedStatus}
                            onEdit={isAdmin ? editBed : undefined}
                            onDelete={isAdmin ? deleteBed : undefined}
                          />
                        ))}
                      </div>
                    )}

                    {/* Add Bed inline form */}
                    {showBedModal === ward.id && (
                      <form
                        onSubmit={(e) => addBed(e, ward.id)}
                        noValidate
                        className="mt-4 flex gap-2"
                      >
                        <input
                          placeholder="Bed Number"
                          value={bedForm.bedNumber}
                          onChange={(e) =>
                            setBedForm({ ...bedForm, bedNumber: e.target.value })
                          }
                          className="flex-1 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 placeholder-gray-400 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 dark:placeholder-gray-500"
                        />
                        <input
                          type="number"
                          min="0"
                          step="0.01"
                          inputMode="decimal"
                          placeholder="Daily Rate (₹)"
                          value={bedForm.dailyRate}
                          onChange={(e) =>
                            setBedForm({ ...bedForm, dailyRate: e.target.value })
                          }
                          className="w-36 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 placeholder-gray-400 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 dark:placeholder-gray-500"
                        />
                        <button
                          type="submit"
                          className="rounded-lg bg-primary px-3 py-2 text-sm font-medium text-white hover:bg-primary-dark"
                        >
                          Save
                        </button>
                        <button
                          type="button"
                          onClick={() => setShowBedModal(null)}
                          className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
                        >
                          Cancel
                        </button>
                      </form>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
        </>
      )}

      {/* Issue #719 — Global Add Bed modal: picks ward + bed number */}
      {showGlobalBedModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <form
            onSubmit={createGlobalBed}
            noValidate
            data-testid="add-bed-modal"
            className="w-full max-h-[90vh] overflow-y-auto max-w-lg rounded-2xl bg-white p-6 text-gray-900 shadow-xl dark:bg-gray-800 dark:text-gray-100"
          >
            <h2 className="mb-4 text-lg font-semibold">Add Bed</h2>
            <div className="space-y-3">
              <div>
                <label
                  htmlFor="add-bed-ward"
                  className="mb-1 block text-sm font-medium"
                >
                  Ward
                </label>
                <select
                  id="add-bed-ward"
                  value={globalBedForm.wardId}
                  onChange={(e) =>
                    setGlobalBedForm({
                      ...globalBedForm,
                      wardId: e.target.value,
                    })
                  }
                  data-testid="add-bed-ward-select"
                  className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
                >
                  <option value="">Select a ward…</option>
                  {wards.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name} ({w.type.replace(/_/g, " ")})
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label
                  htmlFor="add-bed-number"
                  className="mb-1 block text-sm font-medium"
                >
                  Bed Number
                </label>
                <input
                  id="add-bed-number"
                  value={globalBedForm.bedNumber}
                  onChange={(e) =>
                    setGlobalBedForm({
                      ...globalBedForm,
                      bedNumber: e.target.value,
                    })
                  }
                  data-testid="add-bed-number"
                  className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
                />
              </div>
              <div>
                <label
                  htmlFor="add-bed-rate"
                  className="mb-1 block text-sm font-medium"
                >
                  Daily Rate (₹)
                </label>
                <input
                  id="add-bed-rate"
                  type="number"
                  min="0"
                  step="0.01"
                  inputMode="decimal"
                  placeholder="0.00"
                  value={globalBedForm.dailyRate}
                  onChange={(e) =>
                    setGlobalBedForm({
                      ...globalBedForm,
                      dailyRate: e.target.value,
                    })
                  }
                  data-testid="add-bed-rate"
                  className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
                />
                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                  Per-day charge billed while this bed is occupied. Defaults to 0
                  if left blank.
                </p>
              </div>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowGlobalBedModal(false)}
                className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={creatingBed}
                className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark disabled:opacity-50"
              >
                {creatingBed ? "Saving…" : "Create Bed"}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Add Ward Modal */}
      {showWardModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <form
            onSubmit={createWard}
            noValidate
            className="w-full max-h-[90vh] overflow-y-auto max-w-lg rounded-2xl bg-white p-6 text-gray-900 shadow-xl dark:bg-gray-800 dark:text-gray-100"
          >
            <h2 className="mb-4 text-lg font-semibold">Add New Ward</h2>
            <div className="space-y-3">
              <div>
                <label htmlFor="add-ward-name" className="mb-1 block text-sm font-medium">Name</label>
                <input
                  id="add-ward-name"
                  value={wardForm.name}
                  onChange={(e) =>
                    setWardForm({ ...wardForm, name: e.target.value })
                  }
                  className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
                />
              </div>
              <div>
                <label htmlFor="add-ward-type" className="mb-1 block text-sm font-medium">Type</label>
                <select
                  id="add-ward-type"
                  value={wardForm.type}
                  onChange={(e) =>
                    setWardForm({ ...wardForm, type: e.target.value })
                  }
                  className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
                >
                  {WARD_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {t.replace(/_/g, " ")}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="add-ward-floor" className="mb-1 block text-sm font-medium">Floor</label>
                <input
                  id="add-ward-floor"
                  value={wardForm.floor}
                  onChange={(e) =>
                    setWardForm({ ...wardForm, floor: e.target.value })
                  }
                  className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
                />
              </div>
              <div>
                <label htmlFor="add-ward-description" className="mb-1 block text-sm font-medium">
                  Description
                </label>
                <textarea
                  id="add-ward-description"
                  value={wardForm.description}
                  onChange={(e) =>
                    setWardForm({ ...wardForm, description: e.target.value })
                  }
                  rows={3}
                  className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
                />
              </div>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowWardModal(false)}
                className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={creatingWard}
                data-testid="add-ward-submit"
                className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark disabled:opacity-50"
              >
                {creatingWard ? "Saving…" : "Create Ward"}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}

interface ForecastDay {
  date: string;
  predictedOccupancy: number;
  totalBeds: number;
  occupancyPercent: number;
  incomingAdmissions: number;
  expectedDischarges: number;
}

function OccupancyForecast() {
  const [data, setData] = useState<ForecastDay[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const res = await api.get<{ data: ForecastDay[] }>(
          "/admissions/forecast?days=7"
        );
        setData(res.data || []);
      } catch {
        setData([]);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  if (loading)
    return <div className="p-8 text-center text-slate-500">Loading forecast...</div>;
  if (data.length === 0)
    return (
      <div className="p-12 text-center border border-dashed rounded-lg">
        <TrendingUp className="mx-auto mb-3 h-10 w-10 text-slate-400" />
        <h3 className="mb-1 text-base font-semibold text-slate-700 dark:text-slate-200">
          Forecast not yet available
        </h3>
        <p className="mx-auto max-w-sm text-sm text-slate-500 dark:text-slate-400">
          Predicted bed occupancy will appear here after the system has at
          least 7 days of admission and discharge data to learn from.
        </p>
      </div>
    );

  const maxOcc = Math.max(100, ...data.map((d) => d.occupancyPercent));

  return (
    <div className="space-y-4">
      <div className="rounded-xl bg-white p-4 text-gray-900 shadow-sm dark:bg-gray-800 dark:text-gray-100">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold">Next 7 Days Predicted Occupancy</h3>
          <span className="text-xs text-slate-500 dark:text-slate-300">
            based on expected LOS, scheduled surgeries, and planned admissions
          </span>
        </div>
        {/* SVG line chart */}
        <svg viewBox="0 0 700 200" className="w-full h-48">
          <polyline
            fill="none"
            stroke="#3b82f6"
            strokeWidth="2"
            points={data
              .map((d, i) => {
                const x = (i / Math.max(1, data.length - 1)) * 680 + 10;
                const y = 180 - (d.occupancyPercent / maxOcc) * 160;
                return `${x},${y}`;
              })
              .join(" ")}
          />
          {data.map((d, i) => {
            const x = (i / Math.max(1, data.length - 1)) * 680 + 10;
            const y = 180 - (d.occupancyPercent / maxOcc) * 160;
            return (
              <g key={d.date}>
                <circle cx={x} cy={y} r="3" fill="#3b82f6" />
                <text x={x} y={195} fontSize="9" textAnchor="middle" fill="#64748b">
                  {d.date.slice(5)}
                </text>
                <text x={x} y={y - 6} fontSize="9" textAnchor="middle" fill="#1e293b">
                  {d.occupancyPercent}%
                </text>
              </g>
            );
          })}
        </svg>
      </div>
      <div className="bg-white text-gray-900 border border-gray-200 rounded-lg overflow-hidden dark:bg-gray-800 dark:text-gray-100 dark:border-gray-700">
        <div className="overflow-x-auto">
        <table className="w-full text-sm min-w-[760px]">
          <thead className="bg-slate-50 text-xs text-slate-600 uppercase dark:bg-gray-900/40 dark:text-slate-300">
            <tr>
              <th className="px-3 py-2 text-left">Date</th>
              <th className="px-3 py-2 text-right">Predicted</th>
              <th className="px-3 py-2 text-right">Total Beds</th>
              <th className="px-3 py-2 text-right">Incoming</th>
              <th className="px-3 py-2 text-right">Discharges</th>
              <th className="px-3 py-2 text-right">% Occ</th>
            </tr>
          </thead>
          <tbody>
            {data.map((d) => (
              <tr key={d.date} className="border-t border-slate-100 dark:border-slate-700">
                <td className="px-3 py-2">{d.date}</td>
                <td className="px-3 py-2 text-right font-semibold">
                  {d.predictedOccupancy}
                </td>
                <td className="px-3 py-2 text-right">{d.totalBeds}</td>
                <td className="px-3 py-2 text-right text-green-700">
                  {d.incomingAdmissions}
                </td>
                <td className="px-3 py-2 text-right text-amber-700">
                  {d.expectedDischarges}
                </td>
                <td className="px-3 py-2 text-right">
                  <span
                    className={`px-2 py-0.5 rounded text-xs ${
                      d.occupancyPercent >= 90
                        ? "bg-red-100 text-red-700"
                        : d.occupancyPercent >= 75
                          ? "bg-amber-100 text-amber-700"
                          : "bg-green-100 text-green-700"
                    }`}
                  >
                    {d.occupancyPercent}%
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </div>
    </div>
  );
}

function BedCell({
  bed,
  onChange,
  onEdit,
  onDelete,
}: {
  bed: Bed;
  onChange: (id: string, status: string) => void;
  // Admin-only edit/delete. When omitted (non-admin), the bed cell only
  // offers the status menu — no rename/retariff/remove affordances.
  onEdit?: (
    id: string,
    changes: { bedNumber?: string; dailyRate?: number }
  ) => Promise<void>;
  onDelete?: (id: string, bedNumber: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [savingEdit, setSavingEdit] = useState(false);
  const [editForm, setEditForm] = useState({
    bedNumber: bed.bedNumber,
    dailyRate: bed.dailyRate != null ? String(bed.dailyRate) : "",
  });

  async function submitEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!onEdit) return;
    const trimmedNumber = editForm.bedNumber.trim();
    if (!trimmedNumber) {
      toast.error("Bed number is required");
      return;
    }
    const rate = parseDailyRate(editForm.dailyRate);
    if (rate === null) {
      toast.error("Daily rate must be a number ≥ 0");
      return;
    }
    // Only send fields that actually changed.
    const changes: { bedNumber?: string; dailyRate?: number } = {};
    if (trimmedNumber !== bed.bedNumber) changes.bedNumber = trimmedNumber;
    if (rate !== undefined && rate !== bed.dailyRate) changes.dailyRate = rate;
    if (Object.keys(changes).length === 0) {
      setEditing(false);
      return;
    }
    setSavingEdit(true);
    try {
      await onEdit(bed.id, changes);
      setEditing(false);
    } catch {
      // onEdit already toasted; keep the editor open so the user can fix it.
    } finally {
      setSavingEdit(false);
    }
  }

  if (editing) {
    return (
      <form
        onSubmit={submitEdit}
        noValidate
        data-testid={`edit-bed-form-${bed.id}`}
        className="flex h-auto w-full flex-col gap-1.5 rounded-lg border border-primary bg-white p-2 text-gray-900 dark:bg-gray-900 dark:text-gray-100"
      >
        <div>
          <label
            htmlFor={`edit-bed-number-${bed.id}`}
            className="mb-0.5 block text-[10px] font-medium text-gray-600 dark:text-gray-300"
          >
            Bed No.
          </label>
          <input
            id={`edit-bed-number-${bed.id}`}
            value={editForm.bedNumber}
            onChange={(e) =>
              setEditForm({ ...editForm, bedNumber: e.target.value })
            }
            aria-label="Bed number"
            className="w-full rounded border border-gray-300 bg-white px-1.5 py-1 text-xs text-gray-900 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
          />
        </div>
        <div>
          <label
            htmlFor={`edit-bed-rate-${bed.id}`}
            className="mb-0.5 block text-[10px] font-medium text-gray-600 dark:text-gray-300"
          >
            Bed Price (₹/day)
          </label>
          <input
            id={`edit-bed-rate-${bed.id}`}
            type="number"
            min="0"
            step="0.01"
            inputMode="decimal"
            value={editForm.dailyRate}
            onChange={(e) =>
              setEditForm({ ...editForm, dailyRate: e.target.value })
            }
            aria-label="Bed price"
            placeholder="0"
            className="w-full rounded border border-gray-300 bg-white px-1.5 py-1 text-xs text-gray-900 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
          />
          {/* Show the price the bed had before this edit, so the operator
              has a reference while typing a new one. */}
          <p className="mt-0.5 text-[10px] text-gray-400 dark:text-gray-500">
            Current: ₹{bed.dailyRate != null ? bed.dailyRate : 0}
          </p>
        </div>
        <div className="flex gap-1">
          <button
            type="submit"
            disabled={savingEdit}
            className="flex-1 rounded bg-primary px-1.5 py-1 text-[10px] font-medium text-white hover:bg-primary-dark disabled:opacity-50"
          >
            {savingEdit ? "…" : "Save"}
          </button>
          <button
            type="button"
            onClick={() => {
              setEditing(false);
              setEditForm({
                bedNumber: bed.bedNumber,
                dailyRate: bed.dailyRate != null ? String(bed.dailyRate) : "",
              });
            }}
            className="flex-1 rounded border border-gray-300 px-1.5 py-1 text-[10px] text-gray-700 dark:border-gray-600 dark:text-gray-200"
          >
            Cancel
          </button>
        </div>
      </form>
    );
  }

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className={`flex h-16 w-full flex-col items-center justify-center rounded-lg text-white ${STATUS_COLORS[bed.status]}`}
        title={STATUS_LABELS[bed.status]}
      >
        <span className="text-xs font-semibold">{bed.bedNumber}</span>
        <span className="text-[10px]">{STATUS_LABELS[bed.status]}</span>
        {bed.dailyRate != null && bed.dailyRate > 0 && (
          <span className="text-[10px] opacity-90">₹{bed.dailyRate}</span>
        )}
      </button>
      {open && (
        <div className="absolute left-0 right-0 top-full z-10 mt-1 rounded-lg border border-gray-200 bg-white shadow-lg dark:border-gray-700 dark:bg-gray-800">
          <p className="px-3 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-gray-400">
            Set status
          </p>
          {Object.keys(STATUS_COLORS).map((s) => (
            <button
              key={s}
              onClick={() => {
                onChange(bed.id, s);
                setOpen(false);
              }}
              className="block w-full px-3 py-1.5 text-left text-xs text-gray-900 hover:bg-gray-50 dark:text-gray-100 dark:hover:bg-gray-700"
            >
              {STATUS_LABELS[s]}
            </button>
          ))}
          {(onEdit || onDelete) && (
            <div className="border-t border-gray-200 dark:border-gray-700">
              {onEdit && (
                <button
                  onClick={() => {
                    setEditing(true);
                    setOpen(false);
                  }}
                  data-testid={`edit-bed-${bed.id}`}
                  className="block w-full px-3 py-1.5 text-left text-xs text-gray-900 hover:bg-gray-50 dark:text-gray-100 dark:hover:bg-gray-700"
                >
                  Edit number / rate
                </button>
              )}
              {onDelete && (
                <button
                  onClick={() => {
                    onDelete(bed.id, bed.bedNumber);
                    setOpen(false);
                  }}
                  data-testid={`delete-bed-${bed.id}`}
                  className="block w-full px-3 py-1.5 text-left text-xs text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-900/20"
                >
                  Delete bed
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
