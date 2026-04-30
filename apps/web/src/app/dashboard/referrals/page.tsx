"use client";

import { useEffect, useState, useCallback } from "react";
import { api } from "@/lib/api";
import { useAuthStore } from "@/lib/store";
import { toast } from "@/lib/toast";
import { Autocomplete } from "@/components/Autocomplete";
import { createReferralSchema } from "@medcore/shared";
import { Plus, ArrowRightLeft } from "lucide-react";

// Issue #173: replace the free-text Specialty <input> with the same coded
// Autocomplete pattern Surgery uses for ICD-10 (Issue #97). The canonical
// list mirrors `apps/web/src/app/dashboard/ai-letters/page.tsx` SPECIALTIES.
// Filtered locally so no new API is required; the form still persists the
// rendered string into the existing free-text `specialty` column.
const SPECIALTY_OPTIONS = [
  "Cardiologist",
  "Neurologist",
  "Pulmonologist",
  "Gastroenterologist",
  "Orthopedic",
  "Dermatologist",
  "ENT",
  "Ophthalmologist",
  "Gynecologist",
  "Urologist",
  "Endocrinologist",
  "Psychiatrist",
  "Oncologist",
  "Nephrologist",
];

interface Doctor {
  id: string;
  userId: string;
  user: { name: string };
  specialization?: string;
}

interface PatientSearchResult {
  id: string;
  mrNumber?: string;
  user: { name: string; phone?: string };
}

interface Referral {
  id: string;
  referralNumber: string;
  patientId: string;
  fromDoctorId: string;
  toDoctorId?: string | null;
  externalProvider?: string | null;
  externalContact?: string | null;
  specialty?: string | null;
  reason: string;
  notes?: string | null;
  status: "PENDING" | "ACCEPTED" | "COMPLETED" | "DECLINED" | "EXPIRED";
  referredAt: string;
  respondedAt?: string | null;
  patient: { id: string; mrNumber?: string; user: { name: string; phone?: string } };
  fromDoctor: { id: string; user: { name: string } };
  toDoctor?: { id: string; user: { name: string } } | null;
}

type Tab = "outgoing" | "incoming" | "all";

const STATUS_COLORS: Record<string, string> = {
  PENDING: "bg-yellow-100 text-yellow-700",
  ACCEPTED: "bg-blue-100 text-blue-700",
  COMPLETED: "bg-green-100 text-green-700",
  DECLINED: "bg-red-100 text-red-700",
  EXPIRED: "bg-gray-100 text-gray-700",
};

export default function ReferralsPage() {
  const { user } = useAuthStore();
  const [referrals, setReferrals] = useState<Referral[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>("outgoing");
  const [showCreate, setShowCreate] = useState(false);
  const [selected, setSelected] = useState<Referral | null>(null);

  // Form state
  const [doctors, setDoctors] = useState<Doctor[]>([]);
  const [patientSearch, setPatientSearch] = useState("");
  const [patientResults, setPatientResults] = useState<PatientSearchResult[]>([]);
  const [selectedPatient, setSelectedPatient] =
    useState<PatientSearchResult | null>(null);
  const [mode, setMode] = useState<"internal" | "external">("internal");
  const [form, setForm] = useState({
    fromDoctorId: "",
    toDoctorId: "",
    externalProvider: "",
    externalContact: "",
    specialty: "",
    reason: "",
    notes: "",
  });
  // Issue #10: surface field-level validation errors under each input instead
  // of relying on the server's generic error toast.
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});

  const isAdmin = user?.role === "ADMIN";
  const isDoctor = user?.role === "DOCTOR";
  const [myDoctorId, setMyDoctorId] = useState<string>("");

  const loadReferrals = useCallback(async () => {
    setLoading(true);
    try {
      let endpoint = "/referrals?limit=100";
      if (isDoctor && myDoctorId) {
        if (tab === "outgoing") {
          endpoint = `/referrals?fromDoctorId=${myDoctorId}&limit=100`;
        } else if (tab === "incoming") {
          endpoint = `/referrals/inbox?doctorId=${myDoctorId}&limit=100`;
        }
      } else if (isAdmin) {
        endpoint = `/referrals?limit=100`;
      }
      const res = await api.get<{ data: Referral[] }>(endpoint);
      setReferrals(res.data);
    } catch {
      setReferrals([]);
    }
    setLoading(false);
  }, [tab, isDoctor, isAdmin, myDoctorId]);

  const loadMyDoctor = useCallback(async () => {
    if (!isDoctor || !user?.id) return;
    try {
      const res = await api.get<{ data: Doctor[] }>(`/doctors`);
      const me = res.data.find((d) => d.userId === user.id);
      if (me) setMyDoctorId(me.id);
    } catch {
      // empty
    }
  }, [isDoctor, user?.id]);

  useEffect(() => {
    loadMyDoctor();
  }, [loadMyDoctor]);

  useEffect(() => {
    if (isDoctor && !myDoctorId) return;
    loadReferrals();
  }, [loadReferrals, isDoctor, myDoctorId]);

  useEffect(() => {
    if (showCreate) {
      api
        .get<{ data: Doctor[] }>("/doctors")
        .then((res) => setDoctors(res.data))
        .catch(() => setDoctors([]));
    }
  }, [showCreate]);

  useEffect(() => {
    if (patientSearch.length < 2) {
      setPatientResults([]);
      return;
    }
    const t = setTimeout(async () => {
      try {
        const res = await api.get<{ data: PatientSearchResult[] }>(
          `/patients?search=${encodeURIComponent(patientSearch)}&limit=10`
        );
        setPatientResults(res.data);
      } catch {
        setPatientResults([]);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [patientSearch]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (!selectedPatient) {
      errs.patient = "Select a patient";
    }

    const fromDoctorId = isDoctor ? myDoctorId : form.fromDoctorId;
    if (!fromDoctorId) {
      errs.fromDoctorId = isDoctor
        ? "Unable to determine your doctor record"
        : "Select referring doctor";
    }

    const body: Record<string, unknown> = {
      patientId: selectedPatient?.id ?? "",
      fromDoctorId: fromDoctorId || "",
      reason: form.reason,
      specialty: form.specialty || undefined,
      notes: form.notes || undefined,
    };
    if (mode === "internal") {
      body.toDoctorId = form.toDoctorId || undefined;
    } else {
      body.externalProvider = form.externalProvider || undefined;
      body.externalContact = form.externalContact || undefined;
    }

    // Issue #10: client-side Reason validation via the shared Zod schema so
    // the server's defense-in-depth 400 no longer needs to be the first line
    // of feedback.
    const parsed = createReferralSchema.safeParse(body);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const field = String(issue.path[0] ?? "_");
        if (!errs[field]) errs[field] = issue.message;
      }
    }
    setFormErrors(errs);
    if (Object.keys(errs).length > 0) {
      return;
    }

    try {
      await api.post("/referrals", body);
      setShowCreate(false);
      setSelectedPatient(null);
      setPatientSearch("");
      setForm({
        fromDoctorId: "",
        toDoctorId: "",
        externalProvider: "",
        externalContact: "",
        specialty: "",
        reason: "",
        notes: "",
      });
      setFormErrors({});
      loadReferrals();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create referral");
    }
  }

  async function updateStatus(
    id: string,
    status: "ACCEPTED" | "COMPLETED" | "DECLINED"
  ) {
    try {
      await api.patch(`/referrals/${id}`, { status });
      setSelected(null);
      loadReferrals();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Update failed");
    }
  }

  const tabClasses = (t: Tab) =>
    `px-4 py-2 text-sm font-medium rounded-lg transition ${
      tab === t
        ? "bg-primary text-white"
        : "bg-gray-100 text-gray-600 hover:bg-gray-200"
    }`;

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Referrals</h1>
          <p className="text-sm text-gray-500">
            Specialist referrals — internal and external
          </p>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark"
        >
          <Plus size={16} /> New Referral
        </button>
      </div>

      {isDoctor && (
        <div className="mb-4 flex gap-2">
          <button onClick={() => setTab("outgoing")} className={tabClasses("outgoing")}>
            Outgoing
          </button>
          <button onClick={() => setTab("incoming")} className={tabClasses("incoming")}>
            Incoming
          </button>
          <button onClick={() => setTab("all")} className={tabClasses("all")}>
            All
          </button>
        </div>
      )}

      <div className="rounded-xl bg-white shadow-sm">
        {loading ? (
          <div className="p-8 text-center text-gray-500">Loading...</div>
        ) : referrals.length === 0 ? (
          <div className="p-8 text-center text-gray-500">No referrals found.</div>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="border-b text-left text-sm text-gray-500">
                <th className="px-4 py-3">Referral #</th>
                <th className="px-4 py-3">Patient</th>
                <th className="px-4 py-3">From</th>
                <th className="px-4 py-3">To</th>
                <th className="px-4 py-3">Specialty</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Date</th>
              </tr>
            </thead>
            <tbody>
              {referrals.map((r) => (
                <tr
                  key={r.id}
                  onClick={() => setSelected(r)}
                  className="cursor-pointer border-b last:border-0 hover:bg-gray-50"
                >
                  <td className="px-4 py-3 font-medium">{r.referralNumber}</td>
                  <td className="px-4 py-3">
                    <p className="font-medium">{r.patient.user.name}</p>
                    <p className="text-xs text-gray-500">{r.patient.mrNumber}</p>
                  </td>
                  <td className="px-4 py-3 text-sm">{r.fromDoctor.user.name}</td>
                  <td className="px-4 py-3 text-sm">
                    {r.toDoctor ? (
                      <span>{r.toDoctor.user.name}</span>
                    ) : (
                      <span className="flex items-center gap-1">
                        <ArrowRightLeft size={12} className="text-gray-400" />
                        {r.externalProvider || "External"}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-sm">{r.specialty || "—"}</td>
                  <td className="px-4 py-3">
                    <span
                      className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_COLORS[r.status] || ""}`}
                    >
                      {r.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-sm">
                    {new Date(r.referredAt).toLocaleDateString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Create modal */}
      {showCreate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <form
            onSubmit={submit}
            className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl bg-white p-6 shadow-xl"
          >
            <h2 className="mb-4 text-lg font-semibold">New Referral</h2>

            <div className="mb-4">
              <label className="mb-1 block text-sm font-medium">Patient</label>
              {formErrors.patient && !selectedPatient && (
                <p className="mb-1 text-xs text-red-600">{formErrors.patient}</p>
              )}
              {selectedPatient ? (
                <div className="flex items-center justify-between rounded-lg border bg-gray-50 px-3 py-2">
                  <div>
                    <p className="text-sm font-medium">{selectedPatient.user.name}</p>
                    <p className="text-xs text-gray-500">
                      {selectedPatient.mrNumber} · {selectedPatient.user.phone}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setSelectedPatient(null)}
                    className="text-xs text-red-600 hover:underline"
                  >
                    Change
                  </button>
                </div>
              ) : (
                <>
                  <input
                    type="text"
                    placeholder="Search by name or phone..."
                    value={patientSearch}
                    onChange={(e) => setPatientSearch(e.target.value)}
                    className="w-full rounded-lg border px-3 py-2 text-sm"
                  />
                  {patientResults.length > 0 && (
                    <div className="mt-1 max-h-40 overflow-y-auto rounded-lg border bg-white">
                      {patientResults.map((p) => (
                        <button
                          key={p.id}
                          type="button"
                          onClick={() => {
                            setSelectedPatient(p);
                            setPatientResults([]);
                            setPatientSearch("");
                          }}
                          className="block w-full border-b px-3 py-2 text-left text-sm last:border-0 hover:bg-gray-50"
                        >
                          <p className="font-medium">{p.user.name}</p>
                          <p className="text-xs text-gray-500">
                            {p.mrNumber} · {p.user.phone}
                          </p>
                        </button>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>

            {!isDoctor && (
              <div className="mb-4">
                <label className="mb-1 block text-sm font-medium">
                  Referring Doctor (From)
                </label>
                <select
                  value={form.fromDoctorId}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, fromDoctorId: e.target.value }))
                  }
                  className={
                    "w-full rounded-lg border px-3 py-2 text-sm " +
                    (formErrors.fromDoctorId ? "border-red-500" : "")
                  }
                >
                  <option value="">Select doctor</option>
                  {doctors.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.user.name} — {d.specialization}
                    </option>
                  ))}
                </select>
                {formErrors.fromDoctorId && (
                  <p className="mt-1 text-xs text-red-600">
                    {formErrors.fromDoctorId}
                  </p>
                )}
              </div>
            )}

            <div className="mb-4">
              <label className="mb-1 block text-sm font-medium">Referral Type</label>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setMode("internal")}
                  className={`rounded-lg px-3 py-1.5 text-sm ${
                    mode === "internal"
                      ? "bg-primary text-white"
                      : "bg-gray-100 text-gray-700"
                  }`}
                >
                  Internal (Doctor)
                </button>
                <button
                  type="button"
                  onClick={() => setMode("external")}
                  className={`rounded-lg px-3 py-1.5 text-sm ${
                    mode === "external"
                      ? "bg-primary text-white"
                      : "bg-gray-100 text-gray-700"
                  }`}
                >
                  External Provider
                </button>
              </div>
            </div>

            {mode === "internal" ? (
              <div className="mb-4">
                <label className="mb-1 block text-sm font-medium">To Doctor</label>
                <select
                  value={form.toDoctorId}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, toDoctorId: e.target.value }))
                  }
                  className={
                    "w-full rounded-lg border px-3 py-2 text-sm " +
                    (formErrors.toDoctorId ? "border-red-500" : "")
                  }
                >
                  <option value="">Select specialist</option>
                  {doctors.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.user.name} — {d.specialization}
                    </option>
                  ))}
                </select>
                {formErrors.toDoctorId && (
                  <p className="mt-1 text-xs text-red-600">{formErrors.toDoctorId}</p>
                )}
              </div>
            ) : (
              <div className="mb-4 grid grid-cols-2 gap-4">
                <div>
                  <label className="mb-1 block text-sm font-medium">
                    Hospital / Specialist
                  </label>
                  <input
                    type="text"
                    value={form.externalProvider}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, externalProvider: e.target.value }))
                    }
                    className="w-full rounded-lg border px-3 py-2 text-sm"
                    required
                  />
                </div>
                <div>
                  <label className="mb-1 block text-sm font-medium">Contact</label>
                  <input
                    type="text"
                    value={form.externalContact}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, externalContact: e.target.value }))
                    }
                    className="w-full rounded-lg border px-3 py-2 text-sm"
                    placeholder="Phone / email"
                  />
                </div>
              </div>
            )}

            <div className="mb-4" data-testid="referral-specialty-picker">
              <label className="mb-1 block text-sm font-medium">Specialty</label>
              <Autocomplete<string>
                value={form.specialty}
                onChange={(val, item) =>
                  setForm((f) => ({ ...f, specialty: item ?? val }))
                }
                fetchOptions={async (q) => {
                  const needle = q.trim().toLowerCase();
                  if (!needle) return SPECIALTY_OPTIONS;
                  return SPECIALTY_OPTIONS.filter((s) =>
                    s.toLowerCase().includes(needle)
                  );
                }}
                getOptionLabel={(s) => s}
                renderOption={(s) => <span>{s}</span>}
                placeholder="e.g. Cardiologist"
                minChars={0}
              />
            </div>

            <div className="mb-4">
              <label className="mb-1 block text-sm font-medium">
                Reason <span className="text-red-600">*</span>
              </label>
              <textarea
                value={form.reason}
                onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))}
                className={
                  "w-full rounded-lg border px-3 py-2 text-sm " +
                  (formErrors.reason ? "border-red-500" : "")
                }
                rows={2}
                aria-invalid={!!formErrors.reason}
                aria-describedby={formErrors.reason ? "referral-reason-error" : undefined}
              />
              {formErrors.reason && (
                <p id="referral-reason-error" className="mt-1 text-xs text-red-600">
                  {formErrors.reason}
                </p>
              )}
            </div>

            <div className="mb-4">
              <label className="mb-1 block text-sm font-medium">Notes</label>
              <textarea
                value={form.notes}
                onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
                className="w-full rounded-lg border px-3 py-2 text-sm"
                rows={3}
              />
            </div>

            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowCreate(false)}
                className="rounded-lg border px-4 py-2 text-sm"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark"
              >
                Create Referral
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Detail modal */}
      {selected && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => setSelected(null)}
        >
          <div
            className="w-full max-w-xl rounded-2xl bg-white p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-4 flex items-start justify-between">
              <div>
                <h2 className="text-lg font-semibold">{selected.referralNumber}</h2>
                <p className="text-sm text-gray-500">
                  {new Date(selected.referredAt).toLocaleString()}
                </p>
              </div>
              <span
                className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_COLORS[selected.status]}`}
              >
                {selected.status}
              </span>
            </div>

            <div className="mb-4 space-y-2 text-sm">
              <div>
                <span className="text-gray-500">Patient: </span>
                <span className="font-medium">{selected.patient.user.name}</span>
              </div>
              <div>
                <span className="text-gray-500">From: </span>
                <span>{selected.fromDoctor.user.name}</span>
              </div>
              <div>
                <span className="text-gray-500">To: </span>
                <span>
                  {selected.toDoctor
                    ? selected.toDoctor.user.name
                    : `${selected.externalProvider} (external)`}
                </span>
              </div>
              {selected.specialty && (
                <div>
                  <span className="text-gray-500">Specialty: </span>
                  <span>{selected.specialty}</span>
                </div>
              )}
              <div>
                <span className="text-gray-500">Reason: </span>
                <p className="mt-1 whitespace-pre-wrap rounded-lg bg-gray-50 p-3">
                  {selected.reason}
                </p>
              </div>
              {selected.notes && (
                <div>
                  <span className="text-gray-500">Notes: </span>
                  <p className="mt-1 whitespace-pre-wrap rounded-lg bg-gray-50 p-3">
                    {selected.notes}
                  </p>
                </div>
              )}
            </div>

            <div className="flex flex-wrap justify-end gap-2">
              {selected.status === "PENDING" && (
                <>
                  <button
                    onClick={() => updateStatus(selected.id, "ACCEPTED")}
                    className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700"
                  >
                    Accept
                  </button>
                  <button
                    onClick={() => updateStatus(selected.id, "DECLINED")}
                    className="rounded-lg bg-red-600 px-3 py-1.5 text-sm text-white hover:bg-red-700"
                  >
                    Decline
                  </button>
                </>
              )}
              {selected.status === "ACCEPTED" && (
                <button
                  onClick={() => updateStatus(selected.id, "COMPLETED")}
                  className="rounded-lg bg-green-600 px-3 py-1.5 text-sm text-white hover:bg-green-700"
                >
                  Mark Completed
                </button>
              )}
              <button
                onClick={() => setSelected(null)}
                className="rounded-lg border px-3 py-1.5 text-sm"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
