"use client";

import { useEffect, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import { useConfirm } from "@/lib/use-dialog";
import { useAuthStore } from "@/lib/store";
// Issue #278 (Apr 2026): unify ambulance phone formatting with the rest
// of the app. Trip cards previously rendered the raw `callerPhone`
// (`+917321588452`) while the patients table renders 10-digit local
// (`9876543212`); reception couldn't tell whether the two were the same
// number or not. Route every operator-facing phone through the shared
// helper so the canonical "10-digit local with optional `+91 ` prefix"
// form is what we paint everywhere.
import { formatPhone } from "@/lib/format-phone";

// Issue #89: DOCTOR must NOT manipulate ambulance trips. Restricted to
// operational/dispatch roles. NURSE included since on-call nurses dispatch.
const AMBULANCE_ALLOWED = new Set(["ADMIN", "RECEPTION", "NURSE"]);
import {
  Ambulance as AmbulanceIcon,
  Plus,
  Phone,
  MapPin,
  Clock,
  CheckCircle2,
  XCircle,
} from "lucide-react";

// Issue #87 — client-side mirror of the server zod constraints in
// packages/shared/src/validation/phase4-ops.ts. Keeping these aligned with
// the schema is enforced by the integration tests; if the regex drifts we
// want the form to fail in the same way the API does.
const PHONE_RE = /^[+\d][\d\s().+-]{7,19}$/;
function isValidPhone(v: string): boolean {
  if (!v) return true; // optional fields treat empty as undefined
  if (!PHONE_RE.test(v)) return false;
  return v.replace(/\D/g, "").length >= 7;
}

/**
 * Pull `details: [{field, message}]` out of an api error payload (Express
 * errorHandler shape) and project onto a flat `{ field: message }` map for
 * inline rendering. Falls back to a generic toast when the payload is
 * unstructured.
 */
function extractFieldErrors(err: unknown): Record<string, string> {
  const payload = (err as { payload?: { details?: Array<{ field: string; message: string }> } })?.payload;
  if (!payload?.details || !Array.isArray(payload.details)) return {};
  const map: Record<string, string> = {};
  for (const d of payload.details) {
    if (d?.field) map[d.field] = d.message;
  }
  return map;
}

interface Ambulance {
  id: string;
  vehicleNumber: string;
  make?: string | null;
  model?: string | null;
  type: string;
  status: "AVAILABLE" | "ON_TRIP" | "MAINTENANCE" | "OUT_OF_SERVICE";
  driverName?: string | null;
  driverPhone?: string | null;
  paramedicName?: string | null;
}

interface Trip {
  id: string;
  tripNumber: string;
  status: string;
  callerName?: string | null;
  callerPhone?: string | null;
  pickupAddress: string;
  dropAddress?: string | null;
  chiefComplaint?: string | null;
  requestedAt: string;
  dispatchedAt?: string | null;
  arrivedAt?: string | null;
  completedAt?: string | null;
  distanceKm?: number | null;
  cost?: number | null;
  ambulance: Ambulance;
  patient?: { id: string; user: { name: string } } | null;
}

interface Patient {
  id: string;
  mrNumber: string;
  user: { name: string; phone: string };
}

const STATUS_COLORS: Record<string, string> = {
  AVAILABLE: "bg-green-100 text-green-700",
  ON_TRIP: "bg-blue-100 text-blue-700",
  MAINTENANCE: "bg-yellow-100 text-yellow-700",
  OUT_OF_SERVICE: "bg-gray-200 text-gray-700",
};

const TRIP_STAGES = [
  "REQUESTED",
  "DISPATCHED",
  "ARRIVED_SCENE",
  "EN_ROUTE_HOSPITAL",
  "COMPLETED",
];

type Tab = "active" | "all";

export default function AmbulancePage() {
  const { user, isLoading } = useAuthStore();
  const router = useRouter();
  const pathname = usePathname();
  const confirm = useConfirm();
  const [tab, setTab] = useState<Tab>("active");
  const [ambulances, setAmbulances] = useState<Ambulance[]>([]);
  const [trips, setTrips] = useState<Trip[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAddAmb, setShowAddAmb] = useState(false);
  const [showDispatch, setShowDispatch] = useState(false);
  const [completing, setCompleting] = useState<Trip | null>(null);

  // Issue #89: DOCTOR must not be able to manipulate trips by direct URL.
  // Issue #179: target /dashboard/not-authorized so the layout chrome stays.
  useEffect(() => {
    if (!isLoading && user && !AMBULANCE_ALLOWED.has(user.role)) {
      toast.error("Ambulance dispatch is restricted to Admin, Reception, and Nurse.");
      router.replace(
        `/dashboard/not-authorized?from=${encodeURIComponent(pathname || "/dashboard/ambulance")}`,
      );
    }
  }, [user, isLoading, router, pathname]);

  const canManage = user?.role === "ADMIN";
  // Issue #89: DOCTOR removed from canDispatch (was a footgun).
  const canDispatch =
    user?.role === "ADMIN" ||
    user?.role === "NURSE" ||
    user?.role === "RECEPTION";

  async function load() {
    setLoading(true);
    try {
      const [ambRes, tripsRes] = await Promise.all([
        api.get<{ data: Ambulance[] }>("/ambulance"),
        api.get<{ data: Trip[] }>("/ambulance/trips?limit=100"),
      ]);
      setAmbulances(ambRes.data);
      setTrips(tripsRes.data);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function tripAction(trip: Trip, action: string, body?: unknown) {
    try {
      await api.patch(`/ambulance/trips/${trip.id}/${action}`, body);
      // Issue #87: every trip transition can change fleet status — refetch
      // both lists so the fleet card reflects ON_TRIP / AVAILABLE live.
      await load();
      return true;
    } catch (err) {
      // Show the first field-level message if the server returned one,
      // otherwise the generic error.
      const fieldErrs = extractFieldErrors(err);
      const firstField = Object.keys(fieldErrs)[0];
      toast.error(
        firstField ? `${firstField}: ${fieldErrs[firstField]}` : (err as Error).message
      );
      return false;
    }
  }

  const activeTrips = trips.filter(
    (t) => t.status !== "COMPLETED" && t.status !== "CANCELLED"
  );
  const displayTrips = tab === "active" ? activeTrips : trips;

  return (
    <div>
      <div className="mb-6 flex items-center gap-3">
        <AmbulanceIcon className="text-red-600" size={28} />
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Ambulance</h1>
        <div className="ml-auto flex gap-2">
          {canDispatch && (
            <button
              onClick={() => setShowDispatch(true)}
              className="flex items-center gap-2 rounded bg-red-600 px-3 py-2 text-sm text-white hover:bg-red-700"
            >
              <Plus size={16} /> Dispatch Trip
            </button>
          )}
          {canManage && (
            <button
              onClick={() => setShowAddAmb(true)}
              className="flex items-center gap-2 rounded border border-gray-300 bg-white px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
            >
              <Plus size={16} /> Add Ambulance
            </button>
          )}
        </div>
      </div>

      {/* Ambulance fleet cards */}
      <div className="mb-6 grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
        {ambulances.map((a) => (
          <div key={a.id} className="rounded-lg bg-white p-4 text-gray-900 shadow dark:bg-gray-800 dark:text-gray-100">
            <div className="flex items-start justify-between">
              <div>
                <div className="text-lg font-bold">{a.vehicleNumber}</div>
                <div className="text-xs text-gray-600 dark:text-gray-300">
                  {a.type} {a.make && `• ${a.make} ${a.model ?? ""}`}
                </div>
              </div>
              <span
                className={`rounded px-2 py-0.5 text-xs ${
                  STATUS_COLORS[a.status] || "bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-200"
                }`}
              >
                {a.status.replace(/_/g, " ")}
              </span>
            </div>
            <div className="mt-3 space-y-1 text-xs text-gray-700 dark:text-gray-300">
              {a.driverName && (
                <div>
                  Driver: {a.driverName}
                  {a.driverPhone && ` (${formatPhone(a.driverPhone)})`}
                </div>
              )}
              {a.paramedicName && <div>Paramedic: {a.paramedicName}</div>}
            </div>
          </div>
        ))}
        {ambulances.length === 0 && (
          <p className="text-sm text-gray-500 dark:text-gray-400">No ambulances registered.</p>
        )}
      </div>

      {/* Tabs */}
      <div className="mb-4 flex gap-2 border-b border-gray-200 dark:border-gray-700">
        {(["active", "all"] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium capitalize ${
              tab === t
                ? "border-b-2 border-red-600 text-red-600 dark:text-red-400"
                : "text-gray-600 hover:text-gray-900 dark:text-gray-300 dark:hover:text-white"
            }`}
          >
            {t === "active" ? "Active Trips" : "All Trips"}
          </button>
        ))}
      </div>

      {loading ? (
        <p className="text-gray-500 dark:text-gray-400">Loading...</p>
      ) : tab === "active" ? (
        <div className="space-y-4">
          {activeTrips.length === 0 && (
            <p className="text-sm text-gray-500 dark:text-gray-400">No active trips.</p>
          )}
          {activeTrips.map((t) => {
            const stageIdx = TRIP_STAGES.indexOf(t.status);
            return (
              <div key={t.id} className="rounded-lg bg-white p-4 text-gray-900 shadow dark:bg-gray-800 dark:text-gray-100">
                <div className="flex items-start justify-between">
                  <div>
                    <div className="font-mono text-xs text-gray-500 dark:text-gray-400">{t.tripNumber}</div>
                    <div className="text-lg font-semibold">
                      {t.patient?.user.name || t.callerName || "Unknown caller"}
                    </div>
                    <div className="text-sm text-gray-600 dark:text-gray-300">
                      <AmbulanceIcon size={14} className="mr-1 inline" />
                      {t.ambulance.vehicleNumber}
                    </div>
                  </div>
                  <div className="text-xs text-gray-500 dark:text-gray-400">
                    <Clock size={12} className="mr-1 inline" />
                    {new Date(t.requestedAt).toLocaleString()}
                  </div>
                </div>

                <div className="mt-3 flex items-center gap-2 text-xs">
                  {TRIP_STAGES.map((s, i) => (
                    <div key={s} className="flex items-center gap-2">
                      <div
                        className={`flex h-6 w-6 items-center justify-center rounded-full ${
                          i <= stageIdx
                            ? "bg-red-600 text-white"
                            : "bg-gray-200 text-gray-500 dark:bg-gray-700 dark:text-gray-300"
                        }`}
                      >
                        {i + 1}
                      </div>
                      <span
                        className={
                          i <= stageIdx ? "font-medium text-gray-900 dark:text-gray-100" : "text-gray-500 dark:text-gray-400"
                        }
                      >
                        {s.replace(/_/g, " ")}
                      </span>
                      {i < TRIP_STAGES.length - 1 && (
                        <div
                          className={`h-0.5 w-8 ${
                            i < stageIdx ? "bg-red-600" : "bg-gray-200 dark:bg-gray-700"
                          }`}
                        />
                      )}
                    </div>
                  ))}
                </div>

                <div className="mt-3 space-y-1 text-sm text-gray-700 dark:text-gray-300">
                  <div>
                    <MapPin size={14} className="mr-1 inline" />
                    Pickup: {t.pickupAddress}
                  </div>
                  {t.dropAddress && (
                    <div>
                      <MapPin size={14} className="mr-1 inline" />
                      Drop: {t.dropAddress}
                    </div>
                  )}
                  {t.chiefComplaint && (
                    <div className="text-xs text-gray-500 dark:text-gray-400">
                      Complaint: {t.chiefComplaint}
                    </div>
                  )}
                  {t.callerPhone && (
                    <div data-testid="trip-callerPhone-display">
                      <Phone size={14} className="mr-1 inline" />{" "}
                      {formatPhone(t.callerPhone)}
                    </div>
                  )}
                </div>

                {canDispatch && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {t.status === "REQUESTED" && (
                      <button
                        onClick={() => tripAction(t, "dispatch")}
                        className="rounded bg-blue-600 px-3 py-1 text-xs text-white"
                      >
                        Dispatch
                      </button>
                    )}
                    {t.status === "DISPATCHED" && (
                      <button
                        onClick={() => tripAction(t, "arrived")}
                        className="rounded bg-indigo-600 px-3 py-1 text-xs text-white"
                      >
                        Arrived at Scene
                      </button>
                    )}
                    {t.status === "ARRIVED_SCENE" && (
                      <button
                        onClick={() => tripAction(t, "enroute")}
                        className="rounded bg-purple-600 px-3 py-1 text-xs text-white"
                      >
                        En Route to Hospital
                      </button>
                    )}
                    {["ARRIVED_SCENE", "EN_ROUTE_HOSPITAL", "DISPATCHED"].includes(
                      t.status
                    ) && (
                      <button
                        onClick={() => setCompleting(t)}
                        className="flex items-center gap-1 rounded bg-green-600 px-3 py-1 text-xs text-white"
                      >
                        <CheckCircle2 size={12} /> Complete
                      </button>
                    )}
                    <button
                      onClick={async () => {
                        if (await confirm({ title: "Cancel this trip?", danger: true })) tripAction(t, "cancel");
                      }}
                      className="flex items-center gap-1 rounded bg-gray-600 px-3 py-1 text-xs text-white"
                    >
                      <XCircle size={12} /> Cancel
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="rounded-lg bg-white shadow">
          <table className="w-full text-sm">
            <thead className="border-b bg-gray-50 text-left text-xs uppercase text-gray-500">
              <tr>
                <th className="p-3">Trip #</th>
                <th className="p-3">Vehicle</th>
                <th className="p-3">Patient/Caller</th>
                <th className="p-3">Pickup</th>
                <th className="p-3">Status</th>
                <th className="p-3">Requested</th>
                <th className="p-3">Distance</th>
                <th className="p-3">Cost</th>
              </tr>
            </thead>
            <tbody>
              {displayTrips.map((t) => (
                <tr key={t.id} className="border-b hover:bg-gray-50">
                  <td className="p-3 font-mono text-xs">{t.tripNumber}</td>
                  <td className="p-3">{t.ambulance.vehicleNumber}</td>
                  <td className="p-3">
                    {t.patient?.user.name || t.callerName || "—"}
                  </td>
                  <td className="p-3 text-xs text-gray-600">{t.pickupAddress}</td>
                  <td className="p-3">
                    <span className="rounded bg-gray-100 px-2 py-0.5 text-xs">
                      {t.status.replace(/_/g, " ")}
                    </span>
                  </td>
                  <td className="p-3 text-xs text-gray-500">
                    {new Date(t.requestedAt).toLocaleString()}
                  </td>
                  <td className="p-3">{t.distanceKm ? `${t.distanceKm} km` : "—"}</td>
                  <td className="p-3">{t.cost ? `₹${t.cost}` : "—"}</td>
                </tr>
              ))}
              {displayTrips.length === 0 && (
                <tr>
                  <td colSpan={8} className="p-6 text-center text-gray-400">
                    No trips
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {showAddAmb && (
        <AddAmbulanceModal
          onClose={() => setShowAddAmb(false)}
          onSaved={() => {
            setShowAddAmb(false);
            load();
          }}
        />
      )}

      {showDispatch && (
        <DispatchModal
          ambulances={ambulances.filter((a) => a.status === "AVAILABLE")}
          onClose={() => setShowDispatch(false)}
          onSaved={() => {
            setShowDispatch(false);
            load();
          }}
        />
      )}

      {completing && (
        <CompleteTripModal
          trip={completing}
          onClose={() => setCompleting(null)}
          onSaved={async (data) => {
            const ok = await tripAction(completing, "complete", data);
            if (ok) setCompleting(null);
            return ok;
          }}
        />
      )}
    </div>
  );
}

function AddAmbulanceModal({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState({
    vehicleNumber: "",
    make: "",
    model: "",
    type: "BLS",
    driverName: "",
    driverPhone: "",
    paramedicName: "",
  });
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  function validateLocal(): Record<string, string> {
    const e: Record<string, string> = {};
    if (!form.vehicleNumber.trim()) e.vehicleNumber = "Vehicle number is required";
    if (form.driverPhone && !isValidPhone(form.driverPhone)) {
      e.driverPhone = "Enter a valid phone number";
    }
    return e;
  }

  async function save() {
    const localErrs = validateLocal();
    if (Object.keys(localErrs).length > 0) {
      setErrors(localErrs);
      return;
    }
    setErrors({});
    setSaving(true);
    try {
      await api.post("/ambulance", {
        vehicleNumber: form.vehicleNumber,
        make: form.make || undefined,
        model: form.model || undefined,
        type: form.type,
        driverName: form.driverName || undefined,
        driverPhone: form.driverPhone || undefined,
        paramedicName: form.paramedicName || undefined,
      });
      onSaved();
    } catch (err) {
      const fieldErrs = extractFieldErrors(err);
      if (Object.keys(fieldErrs).length > 0) {
        setErrors(fieldErrs);
      } else {
        toast.error((err as Error).message);
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-full max-w-lg rounded-lg bg-white p-6">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-bold">Add Ambulance</h2>
          <button onClick={onClose} className="text-gray-400">✕</button>
        </div>
        <div className="space-y-3">
          <input
            placeholder="Vehicle Number"
            className="w-full rounded border p-2"
            value={form.vehicleNumber}
            onChange={(e) =>
              setForm({ ...form, vehicleNumber: e.target.value })
            }
          />
          <div className="grid grid-cols-2 gap-3">
            <input
              placeholder="Make"
              className="rounded border p-2"
              value={form.make}
              onChange={(e) => setForm({ ...form, make: e.target.value })}
            />
            <input
              placeholder="Model"
              className="rounded border p-2"
              value={form.model}
              onChange={(e) => setForm({ ...form, model: e.target.value })}
            />
          </div>
          <select
            className="w-full rounded border p-2"
            value={form.type}
            onChange={(e) => setForm({ ...form, type: e.target.value })}
          >
            <option value="BLS">BLS (Basic Life Support)</option>
            <option value="ALS">ALS (Advanced Life Support)</option>
            <option value="ICU">ICU</option>
            <option value="Patient Transport">Patient Transport</option>
          </select>
          <input
            placeholder="Driver name"
            className="w-full rounded border p-2"
            value={form.driverName}
            onChange={(e) => setForm({ ...form, driverName: e.target.value })}
          />
          <input
            placeholder="Driver phone"
            className="w-full rounded border p-2"
            value={form.driverPhone}
            onChange={(e) => setForm({ ...form, driverPhone: e.target.value })}
            data-testid="ambulance-driverPhone"
          />
          {errors.driverPhone && (
            <p
              data-testid="error-driverPhone"
              className="text-xs text-red-600"
            >
              {errors.driverPhone}
            </p>
          )}
          {errors.vehicleNumber && (
            <p
              data-testid="error-vehicleNumber"
              className="text-xs text-red-600"
            >
              {errors.vehicleNumber}
            </p>
          )}
          <input
            placeholder="Paramedic name"
            className="w-full rounded border p-2"
            value={form.paramedicName}
            onChange={(e) =>
              setForm({ ...form, paramedicName: e.target.value })
            }
          />
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onClose} className="rounded border px-4 py-2 text-sm">
            Cancel
          </button>
          <button
            onClick={save}
            disabled={saving || !form.vehicleNumber}
            className="rounded bg-red-600 px-4 py-2 text-sm text-white disabled:opacity-50"
          >
            {saving ? "Saving..." : "Add"}
          </button>
        </div>
      </div>
    </div>
  );
}

function DispatchModal({
  ambulances,
  onClose,
  onSaved,
}: {
  ambulances: Ambulance[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState({
    ambulanceId: ambulances[0]?.id || "",
    patientId: "",
    callerName: "",
    callerPhone: "",
    pickupAddress: "",
    dropAddress: "",
    chiefComplaint: "",
  });
  const [patientSearch, setPatientSearch] = useState("");
  const [patients, setPatients] = useState<Patient[]>([]);
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  async function searchPatients() {
    try {
      const res = await api.get<{ data: Patient[] }>(
        `/patients?search=${encodeURIComponent(patientSearch)}&limit=10`
      );
      setPatients(res.data);
    } catch (err) {
      console.error(err);
    }
  }

  function validateLocal(): Record<string, string> {
    const e: Record<string, string> = {};
    if (!form.ambulanceId) e.ambulanceId = "Select an ambulance";
    if (!form.pickupAddress.trim()) e.pickupAddress = "Pickup address is required";
    if (form.callerPhone && !isValidPhone(form.callerPhone)) {
      e.callerPhone = "Enter a valid phone number";
    }
    return e;
  }

  async function save() {
    const localErrs = validateLocal();
    if (Object.keys(localErrs).length > 0) {
      setErrors(localErrs);
      return;
    }
    setErrors({});
    setSaving(true);
    try {
      await api.post("/ambulance/trips", {
        ambulanceId: form.ambulanceId,
        patientId: form.patientId || undefined,
        callerName: form.callerName || undefined,
        callerPhone: form.callerPhone || undefined,
        pickupAddress: form.pickupAddress,
        dropAddress: form.dropAddress || undefined,
        chiefComplaint: form.chiefComplaint || undefined,
      });
      onSaved();
    } catch (err) {
      const fieldErrs = extractFieldErrors(err);
      if (Object.keys(fieldErrs).length > 0) {
        setErrors(fieldErrs);
      } else {
        toast.error((err as Error).message);
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div
        data-testid="dispatch-modal"
        role="dialog"
        aria-label="Dispatch Ambulance"
        className="w-full max-w-lg rounded-lg bg-white p-6"
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-bold">Dispatch Ambulance</h2>
          <button onClick={onClose} className="text-gray-400">✕</button>
        </div>
        <div className="space-y-3">
          <select
            className="w-full rounded border p-2"
            value={form.ambulanceId}
            onChange={(e) => setForm({ ...form, ambulanceId: e.target.value })}
          >
            <option value="">Select available ambulance</option>
            {ambulances.map((a) => (
              <option key={a.id} value={a.id}>
                {a.vehicleNumber} ({a.type})
              </option>
            ))}
          </select>

          <div>
            <label className="text-xs text-gray-600">Patient (optional)</label>
            <div className="flex gap-2">
              <input
                placeholder="Search patient"
                className="flex-1 rounded border p-2"
                value={patientSearch}
                onChange={(e) => setPatientSearch(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && searchPatients()}
              />
              <button onClick={searchPatients} className="rounded border px-3 text-sm">
                Search
              </button>
            </div>
            {patients.length > 0 && (
              <select
                className="mt-2 w-full rounded border p-2"
                value={form.patientId}
                onChange={(e) => setForm({ ...form, patientId: e.target.value })}
              >
                <option value="">None</option>
                {patients.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.user.name} ({p.mrNumber})
                  </option>
                ))}
              </select>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <input
              placeholder="Caller name"
              className="rounded border p-2"
              value={form.callerName}
              onChange={(e) => setForm({ ...form, callerName: e.target.value })}
            />
            <input
              placeholder="Caller phone"
              className="rounded border p-2"
              value={form.callerPhone}
              onChange={(e) =>
                setForm({ ...form, callerPhone: e.target.value })
              }
              data-testid="trip-callerPhone"
            />
          </div>
          {errors.callerPhone && (
            <p
              data-testid="error-callerPhone"
              className="text-xs text-red-600"
            >
              {errors.callerPhone}
            </p>
          )}
          <input
            placeholder="Pickup address"
            className="w-full rounded border p-2"
            value={form.pickupAddress}
            onChange={(e) =>
              setForm({ ...form, pickupAddress: e.target.value })
            }
            data-testid="trip-pickupAddress"
          />
          {errors.pickupAddress && (
            <p
              data-testid="error-pickupAddress"
              className="text-xs text-red-600"
            >
              {errors.pickupAddress}
            </p>
          )}
          <input
            placeholder="Drop address (optional)"
            className="w-full rounded border p-2"
            value={form.dropAddress}
            onChange={(e) => setForm({ ...form, dropAddress: e.target.value })}
          />
          <textarea
            placeholder="Chief complaint"
            className="w-full rounded border p-2"
            rows={2}
            value={form.chiefComplaint}
            onChange={(e) =>
              setForm({ ...form, chiefComplaint: e.target.value })
            }
          />
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onClose} className="rounded border px-4 py-2 text-sm">
            Cancel
          </button>
          <button
            onClick={save}
            disabled={saving || !form.pickupAddress || !form.ambulanceId}
            className="rounded bg-red-600 px-4 py-2 text-sm text-white disabled:opacity-50"
          >
            {saving ? "Dispatching..." : "Create Trip"}
          </button>
        </div>
      </div>
    </div>
  );
}

function CompleteTripModal({
  trip,
  onClose,
  onSaved,
}: {
  trip: Trip;
  onClose: () => void;
  onSaved: (data: {
    actualEndTime: string;
    finalDistance: number;
    finalCost: number;
    notes: string;
  }) => Promise<boolean | void>;
}) {
  // Default the end-time to now so the form is filled-in by default but the
  // user can override; we still send it as ISO to the API.
  const [actualEndTime, setActualEndTime] = useState(() => {
    const d = new Date();
    // datetime-local needs YYYY-MM-DDTHH:mm in local time, no seconds.
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  });
  const [finalDistance, setFinalDistance] = useState("");
  const [finalCost, setFinalCost] = useState("");
  const [notes, setNotes] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  function validateLocal(): Record<string, string> {
    const e: Record<string, string> = {};
    if (!actualEndTime) e.actualEndTime = "actualEndTime is required";
    const dist = Number(finalDistance);
    if (!finalDistance) {
      e.finalDistance = "finalDistance is required";
    } else if (Number.isNaN(dist)) {
      e.finalDistance = "finalDistance must be a number";
    } else if (dist <= 0) {
      e.finalDistance = "finalDistance must be greater than 0";
    }
    const c = Number(finalCost);
    if (finalCost === "") {
      e.finalCost = "finalCost is required";
    } else if (Number.isNaN(c)) {
      e.finalCost = "finalCost must be a number";
    } else if (c < 0) {
      e.finalCost = "finalCost cannot be negative";
    }
    if (!notes.trim()) e.notes = "notes is required";
    return e;
  }

  async function submit() {
    const localErrs = validateLocal();
    if (Object.keys(localErrs).length > 0) {
      setErrors(localErrs);
      return;
    }
    setErrors({});
    setSaving(true);
    try {
      // datetime-local gives us a local-time string with no zone — let the
      // browser convert to UTC ISO so the API receives a valid Date.parse-able
      // value.
      const iso = new Date(actualEndTime).toISOString();
      const ok = await onSaved({
        actualEndTime: iso,
        finalDistance: Number(finalDistance),
        finalCost: Number(finalCost),
        notes: notes.trim(),
      });
      // If the submit failed at the API layer, parent surfaced the toast;
      // we leave the modal open so the user can retry.
      if (ok === false) setSaving(false);
    } catch (err) {
      const fieldErrs = extractFieldErrors(err);
      if (Object.keys(fieldErrs).length > 0) {
        setErrors(fieldErrs);
      } else {
        toast.error((err as Error).message);
      }
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-full max-w-md rounded-lg bg-white p-6">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-bold">Complete {trip.tripNumber}</h2>
          <button onClick={onClose} className="text-gray-400">✕</button>
        </div>
        <div className="space-y-3">
          <label className="block text-xs text-gray-600">
            Actual end time
            <input
              type="datetime-local"
              className="mt-1 w-full rounded border p-2"
              value={actualEndTime}
              onChange={(e) => setActualEndTime(e.target.value)}
              data-testid="complete-actualEndTime"
            />
          </label>
          {errors.actualEndTime && (
            <p data-testid="error-actualEndTime" className="text-xs text-red-600">
              {errors.actualEndTime}
            </p>
          )}
          <input
            type="number"
            min={0}
            step="0.1"
            placeholder="Final distance (km)"
            className="w-full rounded border p-2"
            value={finalDistance}
            onChange={(e) => setFinalDistance(e.target.value)}
            data-testid="complete-finalDistance"
          />
          {errors.finalDistance && (
            <p data-testid="error-finalDistance" className="text-xs text-red-600">
              {errors.finalDistance}
            </p>
          )}
          <input
            type="number"
            min={0}
            step="0.01"
            placeholder="Final cost (₹)"
            className="w-full rounded border p-2"
            value={finalCost}
            onChange={(e) => setFinalCost(e.target.value)}
            data-testid="complete-finalCost"
          />
          {errors.finalCost && (
            <p data-testid="error-finalCost" className="text-xs text-red-600">
              {errors.finalCost}
            </p>
          )}
          <textarea
            placeholder="Notes"
            className="w-full rounded border p-2"
            rows={2}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            data-testid="complete-notes"
          />
          {errors.notes && (
            <p data-testid="error-notes" className="text-xs text-red-600">
              {errors.notes}
            </p>
          )}
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onClose} className="rounded border px-4 py-2 text-sm">
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={saving}
            data-testid="complete-submit"
            className="rounded bg-green-600 px-4 py-2 text-sm text-white disabled:opacity-50"
          >
            {saving ? "Completing..." : "Complete"}
          </button>
        </div>
      </div>
    </div>
  );
}
