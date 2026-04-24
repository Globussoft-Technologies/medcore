"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import { useConfirm } from "@/lib/use-dialog";
import { useAuthStore } from "@/lib/store";
import {
  Ambulance as AmbulanceIcon,
  Plus,
  Phone,
  MapPin,
  Clock,
  CheckCircle2,
  XCircle,
} from "lucide-react";

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
  const { user } = useAuthStore();
  const confirm = useConfirm();
  const [tab, setTab] = useState<Tab>("active");
  const [ambulances, setAmbulances] = useState<Ambulance[]>([]);
  const [trips, setTrips] = useState<Trip[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAddAmb, setShowAddAmb] = useState(false);
  const [showDispatch, setShowDispatch] = useState(false);
  const [completing, setCompleting] = useState<Trip | null>(null);

  const canManage = user?.role === "ADMIN";
  const canDispatch =
    user?.role === "ADMIN" ||
    user?.role === "NURSE" ||
    user?.role === "RECEPTION" ||
    user?.role === "DOCTOR";

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
      load();
    } catch (err) {
      toast.error((err as Error).message);
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
        <h1 className="text-2xl font-bold">Ambulance</h1>
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
              className="flex items-center gap-2 rounded border bg-white px-3 py-2 text-sm hover:bg-gray-50"
            >
              <Plus size={16} /> Add Ambulance
            </button>
          )}
        </div>
      </div>

      {/* Ambulance fleet cards */}
      <div className="mb-6 grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
        {ambulances.map((a) => (
          <div key={a.id} className="rounded-lg bg-white p-4 shadow">
            <div className="flex items-start justify-between">
              <div>
                <div className="text-lg font-bold">{a.vehicleNumber}</div>
                <div className="text-xs text-gray-500">
                  {a.type} {a.make && `• ${a.make} ${a.model ?? ""}`}
                </div>
              </div>
              <span
                className={`rounded px-2 py-0.5 text-xs ${
                  STATUS_COLORS[a.status] || "bg-gray-100 text-gray-700"
                }`}
              >
                {a.status.replace(/_/g, " ")}
              </span>
            </div>
            <div className="mt-3 space-y-1 text-xs text-gray-600">
              {a.driverName && (
                <div>Driver: {a.driverName} {a.driverPhone && `(${a.driverPhone})`}</div>
              )}
              {a.paramedicName && <div>Paramedic: {a.paramedicName}</div>}
            </div>
          </div>
        ))}
        {ambulances.length === 0 && (
          <p className="text-sm text-gray-400">No ambulances registered.</p>
        )}
      </div>

      {/* Tabs */}
      <div className="mb-4 flex gap-2 border-b">
        {(["active", "all"] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium capitalize ${
              tab === t
                ? "border-b-2 border-red-600 text-red-600"
                : "text-gray-600 hover:text-gray-900"
            }`}
          >
            {t === "active" ? "Active Trips" : "All Trips"}
          </button>
        ))}
      </div>

      {loading ? (
        <p className="text-gray-500">Loading...</p>
      ) : tab === "active" ? (
        <div className="space-y-4">
          {activeTrips.length === 0 && (
            <p className="text-sm text-gray-400">No active trips.</p>
          )}
          {activeTrips.map((t) => {
            const stageIdx = TRIP_STAGES.indexOf(t.status);
            return (
              <div key={t.id} className="rounded-lg bg-white p-4 shadow">
                <div className="flex items-start justify-between">
                  <div>
                    <div className="font-mono text-xs text-gray-500">{t.tripNumber}</div>
                    <div className="text-lg font-semibold">
                      {t.patient?.user.name || t.callerName || "Unknown caller"}
                    </div>
                    <div className="text-sm text-gray-600">
                      <AmbulanceIcon size={14} className="mr-1 inline" />
                      {t.ambulance.vehicleNumber}
                    </div>
                  </div>
                  <div className="text-xs text-gray-500">
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
                            : "bg-gray-200 text-gray-500"
                        }`}
                      >
                        {i + 1}
                      </div>
                      <span
                        className={
                          i <= stageIdx ? "font-medium" : "text-gray-400"
                        }
                      >
                        {s.replace(/_/g, " ")}
                      </span>
                      {i < TRIP_STAGES.length - 1 && (
                        <div
                          className={`h-0.5 w-8 ${
                            i < stageIdx ? "bg-red-600" : "bg-gray-200"
                          }`}
                        />
                      )}
                    </div>
                  ))}
                </div>

                <div className="mt-3 space-y-1 text-sm text-gray-700">
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
                    <div className="text-xs text-gray-500">
                      Complaint: {t.chiefComplaint}
                    </div>
                  )}
                  {t.callerPhone && (
                    <div>
                      <Phone size={14} className="mr-1 inline" /> {t.callerPhone}
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
            await tripAction(completing, "complete", data);
            setCompleting(null);
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

  async function save() {
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
      toast.error((err as Error).message);
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
          />
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

  async function save() {
    if (!form.ambulanceId) {
      toast.error("Select an ambulance");
      return;
    }
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
      toast.error((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-full max-w-lg rounded-lg bg-white p-6">
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
            />
          </div>
          <input
            placeholder="Pickup address"
            className="w-full rounded border p-2"
            value={form.pickupAddress}
            onChange={(e) =>
              setForm({ ...form, pickupAddress: e.target.value })
            }
          />
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
  onSaved: (data: { distanceKm?: number; cost?: number; notes?: string }) => void;
}) {
  const [distanceKm, setDistanceKm] = useState("");
  const [cost, setCost] = useState("");
  const [notes, setNotes] = useState("");

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-full max-w-md rounded-lg bg-white p-6">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-bold">Complete {trip.tripNumber}</h2>
          <button onClick={onClose} className="text-gray-400">✕</button>
        </div>
        <div className="space-y-3">
          <input
            type="number"
            placeholder="Distance (km)"
            className="w-full rounded border p-2"
            value={distanceKm}
            onChange={(e) => setDistanceKm(e.target.value)}
          />
          <input
            type="number"
            placeholder="Cost (₹)"
            className="w-full rounded border p-2"
            value={cost}
            onChange={(e) => setCost(e.target.value)}
          />
          <textarea
            placeholder="Notes"
            className="w-full rounded border p-2"
            rows={2}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onClose} className="rounded border px-4 py-2 text-sm">
            Cancel
          </button>
          <button
            onClick={() =>
              onSaved({
                distanceKm: distanceKm ? Number(distanceKm) : undefined,
                cost: cost ? Number(cost) : undefined,
                notes: notes || undefined,
              })
            }
            className="rounded bg-green-600 px-4 py-2 text-sm text-white"
          >
            Complete
          </button>
        </div>
      </div>
    </div>
  );
}
