"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { useAuthStore } from "@/lib/store";
import { useTranslation } from "@/lib/i18n";
import { toast } from "@/lib/toast";
import { Plus, BedDouble } from "lucide-react";
import { DataTable, Column } from "@/components/DataTable";

interface Admission {
  id: string;
  admissionNumber: string;
  admittedAt: string;
  dischargedAt?: string | null;
  status: "ADMITTED" | "DISCHARGED" | "TRANSFERRED";
  reason: string;
  diagnosis?: string | null;
  patient: { id: string; mrNumber?: string; user: { name: string; phone?: string } };
  doctor: { id: string; user: { name: string } };
  bed: {
    id: string;
    bedNumber: string;
    ward: { id: string; name: string };
  };
  // flattened for sort/filter
  patientName?: string;
  wardBed?: string;
  lengthOfStay?: number;
}

interface PatientSearchResult {
  id: string;
  mrNumber: string;
  user: { name: string; phone: string };
}

interface Doctor {
  id: string;
  user: { name: string };
  specialization: string;
}

interface Bed {
  id: string;
  bedNumber: string;
  status: string;
  ward: { id: string; name: string };
}

interface Ward {
  id: string;
  name: string;
  beds?: Bed[];
}

type Tab = "admitted" | "discharged" | "all";

const STATUS_COLORS: Record<string, string> = {
  ADMITTED: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300",
  DISCHARGED: "bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300",
  TRANSFERRED: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300",
};

function computeLOS(adm: Admission): number {
  const start = new Date(adm.admittedAt).getTime();
  const end = adm.dischargedAt ? new Date(adm.dischargedAt).getTime() : Date.now();
  return Math.max(0, Math.ceil((end - start) / (1000 * 60 * 60 * 24)));
}

export default function AdmissionsPage() {
  const { user } = useAuthStore();
  const { t } = useTranslation();
  const [admissions, setAdmissions] = useState<Admission[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>("admitted");
  const [showModal, setShowModal] = useState(false);

  // Form state
  const [patientSearch, setPatientSearch] = useState("");
  const [patientResults, setPatientResults] = useState<PatientSearchResult[]>(
    []
  );
  const [selectedPatient, setSelectedPatient] =
    useState<PatientSearchResult | null>(null);
  const [doctors, setDoctors] = useState<Doctor[]>([]);
  const [wards, setWards] = useState<Ward[]>([]);
  const [form, setForm] = useState({
    doctorId: "",
    bedId: "",
    reason: "",
    diagnosis: "",
  });

  const canAdmit =
    user?.role === "ADMIN" ||
    user?.role === "RECEPTION" ||
    user?.role === "DOCTOR";

  // Issue #16: pre-load bed availability so the "Admit Patient" button can be
  // disabled with an explanatory tooltip when no beds are free, instead of
  // opening a modal with an empty dropdown.
  const availableBedCount = wards.reduce(
    (sum, w) => sum + (w.beds || []).filter((b) => b.status === "AVAILABLE").length,
    0
  );
  const hasBedCensus = wards.length > 0;
  const bedsUnavailable = hasBedCensus && availableBedCount === 0;

  useEffect(() => {
    loadAdmissions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  // Always pre-fetch wards for the availability badge on the Admit button
  // (Issue #16). Doctors/other roles still only fetch wards once per page load.
  useEffect(() => {
    if (canAdmit) {
      loadWards();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canAdmit]);

  useEffect(() => {
    if (showModal) {
      loadDoctors();
      // refresh wards each time the modal opens so bed status is up to date
      loadWards();
    }
  }, [showModal]);

  useEffect(() => {
    if (patientSearch.length < 2) {
      setPatientResults([]);
      return;
    }
    const t = setTimeout(() => {
      searchPatients(patientSearch);
    }, 300);
    return () => clearTimeout(t);
  }, [patientSearch]);

  async function loadAdmissions() {
    setLoading(true);
    try {
      const statusParam =
        tab === "admitted"
          ? "?status=ADMITTED"
          : tab === "discharged"
            ? "?status=DISCHARGED"
            : "";
      const res = await api.get<{ data: Admission[] }>(
        `/admissions${statusParam}`
      );
      const flat = (res.data || []).map((a) => ({
        ...a,
        patientName: a.patient?.user?.name,
        wardBed: `${a.bed?.ward?.name ?? ""} / ${a.bed?.bedNumber ?? ""}`,
        lengthOfStay: computeLOS(a),
      }));
      setAdmissions(flat);
    } catch {
      // empty
    }
    setLoading(false);
  }

  async function searchPatients(q: string) {
    try {
      const res = await api.get<{ data: PatientSearchResult[] }>(
        `/patients?search=${encodeURIComponent(q)}&limit=10`
      );
      setPatientResults(res.data);
    } catch {
      setPatientResults([]);
    }
  }

  async function loadDoctors() {
    try {
      const res = await api.get<{ data: Doctor[] }>("/doctors");
      setDoctors(res.data);
    } catch {
      // empty
    }
  }

  async function loadWards() {
    try {
      const res = await api.get<{ data: Ward[] }>("/wards");
      setWards(res.data);
    } catch {
      // empty
    }
  }

  async function submitAdmission(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedPatient) {
      toast.error("Select a patient");
      return;
    }
    try {
      await api.post("/admissions", {
        patientId: selectedPatient.id,
        doctorId: form.doctorId,
        bedId: form.bedId,
        reason: form.reason,
        diagnosis: form.diagnosis || undefined,
      });
      toast.success("Patient admitted");
      setShowModal(false);
      setSelectedPatient(null);
      setPatientSearch("");
      setForm({ doctorId: "", bedId: "", reason: "", diagnosis: "" });
      loadAdmissions();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Admission failed");
    }
  }

  const tabClasses = (t: Tab) =>
    `px-4 py-2 text-sm font-medium rounded-lg transition ${
      tab === t
        ? "bg-primary text-white"
        : "bg-gray-100 text-gray-600 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600"
    }`;

  const columns: Column<Admission>[] = [
    {
      key: "admissionNumber",
      label: "Admission #",
      sortable: true,
      filterable: true,
      render: (a) => <span className="font-mono font-medium">{a.admissionNumber}</span>,
    },
    {
      key: "patientName",
      label: "Patient",
      sortable: true,
      filterable: true,
      render: (a) => (
        <div>
          <Link
            href={`/dashboard/admissions/${a.id}`}
            className="font-medium text-primary hover:underline"
            onClick={(e) => e.stopPropagation()}
          >
            {a.patient.user.name}
          </Link>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            {a.patient.mrNumber}
          </p>
        </div>
      ),
    },
    {
      key: "wardBed",
      label: "Ward / Bed",
      sortable: true,
      filterable: true,
      hideMobile: true,
      render: (a) => (
        <div className="flex items-center gap-1 text-sm">
          <BedDouble size={14} className="text-gray-600 dark:text-gray-300" />
          {a.bed.ward.name} / {a.bed.bedNumber}
        </div>
      ),
    },
    {
      key: "admittedAt",
      label: "Admitted",
      sortable: true,
      render: (a) => new Date(a.admittedAt).toLocaleDateString(),
    },
    {
      key: "diagnosis",
      label: "Diagnosis",
      filterable: true,
      render: (a) => a.diagnosis || "—",
    },
    {
      key: "status",
      label: "Status",
      sortable: true,
      filterable: true,
      render: (a) => (
        <span
          className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_COLORS[a.status] || ""}`}
        >
          {a.status}
        </span>
      ),
    },
    {
      key: "lengthOfStay",
      label: "LOS (d)",
      sortable: true,
      hideMobile: true,
    },
    {
      key: "actions",
      label: "Actions",
      render: (a) => (
        <Link
          href={`/dashboard/admissions/${a.id}`}
          onClick={(e) => e.stopPropagation()}
          className="rounded bg-primary px-2 py-1 text-xs text-white hover:bg-primary-dark"
        >
          View Chart
        </Link>
      ),
    },
  ];

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
            {t("dashboard.admissions.title")}
          </h1>
          <p className="text-sm text-gray-700 dark:text-gray-300">
            In-patient admission management
          </p>
        </div>
        {canAdmit && (
          <button
            onClick={() => {
              if (bedsUnavailable) {
                toast.warning(
                  "No beds available. Please free a bed first."
                );
                return;
              }
              setShowModal(true);
            }}
            disabled={bedsUnavailable}
            title={
              bedsUnavailable
                ? "No beds available. Please free a bed first."
                : undefined
            }
            aria-disabled={bedsUnavailable}
            className={
              "flex min-h-[44px] items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium text-white " +
              (bedsUnavailable
                ? "cursor-not-allowed bg-gray-400"
                : "bg-primary hover:bg-primary-dark")
            }
          >
            <Plus size={16} /> Admit Patient
            {bedsUnavailable && (
              <span className="ml-1 rounded bg-white/20 px-1 text-xs">
                no beds
              </span>
            )}
          </button>
        )}
      </div>

      <div className="mb-4 flex gap-2">
        <button onClick={() => setTab("admitted")} className={tabClasses("admitted")}>
          Currently Admitted
        </button>
        <button
          onClick={() => setTab("discharged")}
          className={tabClasses("discharged")}
        >
          Discharged
        </button>
        <button onClick={() => setTab("all")} className={tabClasses("all")}>
          All
        </button>
      </div>

      <DataTable<Admission>
        data={admissions}
        columns={columns}
        keyField="id"
        loading={loading}
        defaultSort={{ key: "admittedAt", dir: "desc" }}
        csvName="admissions"
        empty={{
          icon: <BedDouble size={28} />,
          title:
            tab === "admitted"
              ? "No current admissions"
              : tab === "discharged"
                ? "No discharged records"
                : "No admissions yet",
          description:
            tab === "admitted"
              ? "There are no active in-patient admissions."
              : "Records will appear here when available.",
          action:
            canAdmit && tab === "admitted"
              ? {
                  label: bedsUnavailable
                    ? "No beds available"
                    : "Admit Patient",
                  onClick: () => {
                    if (bedsUnavailable) {
                      toast.warning(
                        "No beds available. Please free a bed first."
                      );
                      return;
                    }
                    setShowModal(true);
                  },
                }
              : undefined,
        }}
      />

      {/* Admit Modal */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <form
            onSubmit={submitAdmission}
            className="w-full max-w-2xl rounded-2xl bg-white p-6 shadow-xl dark:bg-gray-800"
          >
            <h2 className="mb-4 text-lg font-semibold text-gray-900 dark:text-gray-100">
              Admit Patient
            </h2>

            <div className="space-y-4">
              {/* Patient search */}
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">
                  Patient
                </label>
                {selectedPatient ? (
                  <div className="flex items-center justify-between rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100">
                    <span>
                      <strong>{selectedPatient.user.name}</strong> —{" "}
                      {selectedPatient.mrNumber}
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedPatient(null);
                        setPatientSearch("");
                      }}
                      className="text-xs text-red-600 dark:text-red-400"
                    >
                      Change
                    </button>
                  </div>
                ) : (
                  <>
                    <input
                      placeholder="Search by name or MR number"
                      value={patientSearch}
                      onChange={(e) => setPatientSearch(e.target.value)}
                      className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100 dark:placeholder-gray-500"
                    />
                    {patientResults.length > 0 && (
                      <div className="mt-1 max-h-40 overflow-y-auto rounded-lg border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-800">
                        {patientResults.map((p) => (
                          <button
                            key={p.id}
                            type="button"
                            onClick={() => {
                              setSelectedPatient(p);
                              setPatientResults([]);
                            }}
                            className="block w-full px-3 py-2 text-left text-sm text-gray-900 hover:bg-gray-50 dark:text-gray-100 dark:hover:bg-gray-700"
                          >
                            <strong>{p.user.name}</strong> · {p.mrNumber} ·{" "}
                            {p.user.phone}
                          </button>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </div>

              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">Doctor</label>
                <select
                  aria-label="Doctor"
                  required
                  value={form.doctorId}
                  onChange={(e) =>
                    setForm({ ...form, doctorId: e.target.value })
                  }
                  className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
                >
                  <option value="">Select Doctor</option>
                  {doctors.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.user.name} — {d.specialization}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">
                  Available Bed
                </label>
                {bedsUnavailable ? (
                  // Issue #16: fallback empty-state inside the modal with a
                  // link to the ward management page.
                  <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-700 dark:bg-amber-900/20 dark:text-amber-200">
                    No beds available. Free a bed from the{" "}
                    <Link
                      href="/dashboard/wards"
                      className="font-medium underline hover:text-amber-900"
                    >
                      ward management page
                    </Link>{" "}
                    before admitting a patient.
                  </div>
                ) : (
                  <select
                    aria-label="Available Bed"
                    required
                    value={form.bedId}
                    onChange={(e) => setForm({ ...form, bedId: e.target.value })}
                    className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
                  >
                    <option value="">Select Bed</option>
                    {wards.map((w) => (
                      <optgroup key={w.id} label={w.name}>
                        {(w.beds || [])
                          .filter((b) => b.status === "AVAILABLE")
                          .map((b) => (
                            <option key={b.id} value={b.id}>
                              {w.name} / Bed {b.bedNumber}
                            </option>
                          ))}
                      </optgroup>
                    ))}
                  </select>
                )}
              </div>

              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">
                  Reason for Admission
                </label>
                <textarea
                  required
                  value={form.reason}
                  onChange={(e) => setForm({ ...form, reason: e.target.value })}
                  rows={2}
                  className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
                />
              </div>

              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">
                  Diagnosis (optional)
                </label>
                <input
                  value={form.diagnosis}
                  onChange={(e) =>
                    setForm({ ...form, diagnosis: e.target.value })
                  }
                  className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
                />
              </div>
            </div>

            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowModal(false)}
                className="rounded-lg border border-gray-200 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-700"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark"
              >
                Admit Patient
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
