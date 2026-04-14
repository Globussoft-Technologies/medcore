"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { api } from "@/lib/api";
import { useAuthStore } from "@/lib/store";
import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  User,
  Phone,
  Mail,
  Activity,
  FileText,
  CreditCard,
  AlertTriangle,
  Heart,
  Users,
  Syringe,
  FolderOpen,
  Plus,
  Trash2,
  Download,
  Upload,
  X,
} from "lucide-react";

// ───────────────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────────────

interface PatientDetail {
  id: string;
  mrNumber: string;
  age: number | null;
  gender: string;
  bloodGroup: string | null;
  address: string | null;
  insuranceProvider: string | null;
  insuranceId: string | null;
  user: { id: string; name: string; email: string; phone: string };
}

interface VisitRecord {
  id: string;
  date: string;
  status: string;
  doctor: { user: { name: string }; specialization: string };
  diagnosis: string | null;
  vitals?: {
    bloodPressure: string | null;
    heartRate: number | null;
    temperature: number | null;
    weight: number | null;
    oxygenSaturation: number | null;
  } | null;
  prescription?: {
    items: Array<{
      medication: string;
      dosage: string;
      frequency: string;
      duration: string;
    }>;
  } | null;
  invoice?: {
    invoiceNumber: string;
    totalAmount: number;
    paymentStatus: string;
  } | null;
}

interface Allergy {
  id: string;
  allergen: string;
  severity: "MILD" | "MODERATE" | "SEVERE" | "LIFE_THREATENING";
  reaction: string | null;
  notes: string | null;
  notedAt: string;
}

interface Condition {
  id: string;
  condition: string;
  icd10Code: string | null;
  diagnosedDate: string | null;
  status: "ACTIVE" | "CONTROLLED" | "RESOLVED" | "RELAPSED";
  notes: string | null;
}

interface FamilyHist {
  id: string;
  relation: string;
  condition: string;
  notes: string | null;
}

interface Immunization {
  id: string;
  vaccine: string;
  doseNumber: number | null;
  dateGiven: string;
  nextDueDate: string | null;
  batchNumber: string | null;
  manufacturer: string | null;
  site: string | null;
  notes: string | null;
}

interface PatientDoc {
  id: string;
  type: string;
  title: string;
  fileSize: number | null;
  mimeType: string | null;
  createdAt: string;
  notes: string | null;
}

// ───────────────────────────────────────────────────────
// Color helpers
// ───────────────────────────────────────────────────────

const severityColors: Record<Allergy["severity"], string> = {
  MILD: "bg-yellow-100 text-yellow-800",
  MODERATE: "bg-orange-100 text-orange-800",
  SEVERE: "bg-red-100 text-red-700",
  LIFE_THREATENING: "bg-red-800 text-white",
};

const conditionColors: Record<Condition["status"], string> = {
  ACTIVE: "bg-red-100 text-red-700",
  CONTROLLED: "bg-yellow-100 text-yellow-800",
  RESOLVED: "bg-green-100 text-green-700",
  RELAPSED: "bg-orange-100 text-orange-800",
};

const DOC_TYPES = [
  "LAB_REPORT",
  "IMAGING",
  "DISCHARGE_SUMMARY",
  "CONSENT",
  "INSURANCE",
  "REFERRAL_LETTER",
  "ID_PROOF",
  "OTHER",
] as const;

// ───────────────────────────────────────────────────────
// Page
// ───────────────────────────────────────────────────────

export default function PatientDetailPage() {
  const params = useParams();
  const id = params.id as string;
  const { user } = useAuthStore();
  const [patient, setPatient] = useState<PatientDetail | null>(null);
  const [visits, setVisits] = useState<VisitRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedVisit, setExpandedVisit] = useState<string | null>(null);
  const [tab, setTab] = useState<"overview" | "medical" | "documents">(
    "overview"
  );

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const [patRes, histRes] = await Promise.all([
          api.get<{ data: PatientDetail }>(`/patients/${id}`),
          api
            .get<{ data: VisitRecord[] }>(`/patients/${id}/history`)
            .catch(() => ({ data: [] })),
        ]);
        setPatient(patRes.data);
        setVisits(histRes.data);
      } catch {
        // noop
      }
      setLoading(false);
    })();
  }, [id]);

  function toggleVisit(visitId: string) {
    setExpandedVisit(expandedVisit === visitId ? null : visitId);
  }

  if (loading) {
    return (
      <div className="p-8 text-center text-gray-500">Loading...</div>
    );
  }

  if (!patient) {
    return (
      <div className="p-8 text-center">
        <p className="text-gray-500">Patient not found</p>
        <Link
          href="/dashboard/patients"
          className="mt-4 inline-block text-primary hover:underline"
        >
          Back to Patients
        </Link>
      </div>
    );
  }

  const statusColors: Record<string, string> = {
    COMPLETED: "bg-green-100 text-green-700",
    IN_PROGRESS: "bg-blue-100 text-blue-700",
    CHECKED_IN: "bg-amber-100 text-amber-700",
    SCHEDULED: "bg-gray-100 text-gray-600",
    CANCELLED: "bg-red-100 text-red-700",
    NO_SHOW: "bg-red-100 text-red-600",
  };

  const canEdit =
    user?.role === "DOCTOR" ||
    user?.role === "NURSE" ||
    user?.role === "ADMIN" ||
    user?.role === "RECEPTION";

  return (
    <div>
      {/* Back link */}
      <Link
        href="/dashboard/patients"
        className="mb-4 inline-flex items-center gap-2 text-sm text-gray-600 hover:text-primary"
      >
        <ArrowLeft size={16} /> Back to Patients
      </Link>

      {/* Patient Info Card */}
      <div className="mb-6 rounded-xl bg-white p-6 shadow-sm">
        <div className="flex items-start gap-6">
          <div className="flex h-16 w-16 items-center justify-center rounded-full bg-primary/10">
            <User size={28} className="text-primary" />
          </div>
          <div className="flex-1">
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-bold">{patient.user.name}</h1>
              <span className="rounded-full bg-primary/10 px-3 py-0.5 font-mono text-sm font-medium text-primary">
                {patient.mrNumber}
              </span>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-x-8 gap-y-2 sm:grid-cols-4">
              {patient.age != null && (
                <div>
                  <p className="text-xs text-gray-400">Age</p>
                  <p className="text-sm font-medium">{patient.age} yrs</p>
                </div>
              )}
              <div>
                <p className="text-xs text-gray-400">Gender</p>
                <p className="text-sm font-medium">{patient.gender}</p>
              </div>
              {patient.bloodGroup && (
                <div>
                  <p className="text-xs text-gray-400">Blood Group</p>
                  <p className="text-sm font-medium">{patient.bloodGroup}</p>
                </div>
              )}
              <div className="flex items-center gap-1.5">
                <Phone size={13} className="text-gray-400" />
                <p className="text-sm">{patient.user.phone}</p>
              </div>
              {patient.user.email && (
                <div className="flex items-center gap-1.5">
                  <Mail size={13} className="text-gray-400" />
                  <p className="text-sm">{patient.user.email}</p>
                </div>
              )}
              {patient.insuranceProvider && (
                <div>
                  <p className="text-xs text-gray-400">Insurance</p>
                  <p className="text-sm font-medium">
                    {patient.insuranceProvider}
                    {patient.insuranceId ? ` (${patient.insuranceId})` : ""}
                  </p>
                </div>
              )}
              {patient.address && (
                <div className="col-span-2">
                  <p className="text-xs text-gray-400">Address</p>
                  <p className="text-sm">{patient.address}</p>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="mb-6 flex gap-1 border-b">
        {(
          [
            { key: "overview", label: "Overview" },
            { key: "medical", label: "Medical Records" },
            { key: "documents", label: "Documents" },
          ] as const
        ).map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-4 py-2 text-sm font-medium transition ${
              tab === t.key
                ? "border-b-2 border-primary text-primary"
                : "text-gray-500 hover:text-gray-800"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Overview */}
      {tab === "overview" && (
        <>
          <h2 className="mb-4 text-lg font-semibold">Visit History</h2>
          {visits.length === 0 ? (
            <div className="rounded-xl bg-white p-8 text-center shadow-sm">
              <p className="text-gray-400">No visit history found</p>
            </div>
          ) : (
            <div className="space-y-3">
              {visits.map((visit) => {
                const isExpanded = expandedVisit === visit.id;
                return (
                  <div key={visit.id} className="rounded-xl bg-white shadow-sm">
                    <button
                      onClick={() => toggleVisit(visit.id)}
                      className="flex w-full items-center gap-4 px-6 py-4 text-left hover:bg-gray-50"
                    >
                      {isExpanded ? (
                        <ChevronDown size={18} className="text-gray-400" />
                      ) : (
                        <ChevronRight size={18} className="text-gray-400" />
                      )}
                      <div className="flex-1">
                        <div className="flex items-center gap-3">
                          <p className="font-medium">
                            {new Date(visit.date).toLocaleDateString("en-IN", {
                              weekday: "short",
                              year: "numeric",
                              month: "short",
                              day: "numeric",
                            })}
                          </p>
                          <span
                            className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
                              statusColors[visit.status] ||
                              "bg-gray-100 text-gray-600"
                            }`}
                          >
                            {visit.status.replace(/_/g, " ")}
                          </span>
                        </div>
                        <p className="mt-0.5 text-sm text-gray-500">
                          Dr. {visit.doctor?.user?.name || "---"}{" "}
                          {visit.doctor?.specialization
                            ? `(${visit.doctor.specialization})`
                            : ""}
                        </p>
                        {visit.diagnosis && (
                          <p className="mt-1 text-sm text-gray-600">
                            Diagnosis: {visit.diagnosis}
                          </p>
                        )}
                      </div>
                    </button>

                    {isExpanded && (
                      <div className="border-t px-6 py-4">
                        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
                          {visit.vitals && (
                            <div className="rounded-lg bg-blue-50 p-4">
                              <h4 className="mb-2 flex items-center gap-2 text-sm font-semibold text-blue-700">
                                <Activity size={14} /> Vitals
                              </h4>
                              <div className="space-y-1 text-sm">
                                {visit.vitals.bloodPressure && (
                                  <p>
                                    <span className="text-gray-500">BP:</span>{" "}
                                    {visit.vitals.bloodPressure} mmHg
                                  </p>
                                )}
                                {visit.vitals.heartRate && (
                                  <p>
                                    <span className="text-gray-500">HR:</span>{" "}
                                    {visit.vitals.heartRate} bpm
                                  </p>
                                )}
                                {visit.vitals.temperature && (
                                  <p>
                                    <span className="text-gray-500">Temp:</span>{" "}
                                    {visit.vitals.temperature}°F
                                  </p>
                                )}
                                {visit.vitals.weight && (
                                  <p>
                                    <span className="text-gray-500">
                                      Weight:
                                    </span>{" "}
                                    {visit.vitals.weight} kg
                                  </p>
                                )}
                                {visit.vitals.oxygenSaturation && (
                                  <p>
                                    <span className="text-gray-500">SpO2:</span>{" "}
                                    {visit.vitals.oxygenSaturation}%
                                  </p>
                                )}
                              </div>
                            </div>
                          )}

                          {visit.prescription &&
                            visit.prescription.items &&
                            visit.prescription.items.length > 0 && (
                              <div className="rounded-lg bg-green-50 p-4">
                                <h4 className="mb-2 flex items-center gap-2 text-sm font-semibold text-green-700">
                                  <FileText size={14} /> Prescription
                                </h4>
                                <div className="space-y-2">
                                  {visit.prescription.items.map((item, i) => (
                                    <div key={i} className="text-sm">
                                      <p className="font-medium">
                                        {item.medication}
                                      </p>
                                      <p className="text-xs text-gray-600">
                                        {item.dosage} | {item.frequency} |{" "}
                                        {item.duration}
                                      </p>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            )}

                          {visit.invoice && (
                            <div className="rounded-lg bg-amber-50 p-4">
                              <h4 className="mb-2 flex items-center gap-2 text-sm font-semibold text-amber-700">
                                <CreditCard size={14} /> Invoice
                              </h4>
                              <div className="text-sm">
                                <p>
                                  <span className="text-gray-500">#</span>{" "}
                                  {visit.invoice.invoiceNumber}
                                </p>
                                <p className="mt-1 text-lg font-semibold">
                                  Rs. {visit.invoice.totalAmount.toFixed(2)}
                                </p>
                                <span
                                  className={`mt-1 inline-block rounded-full px-2 py-0.5 text-xs font-medium ${
                                    visit.invoice.paymentStatus === "PAID"
                                      ? "bg-green-100 text-green-700"
                                      : "bg-red-100 text-red-700"
                                  }`}
                                >
                                  {visit.invoice.paymentStatus}
                                </span>
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      {/* Medical Records */}
      {tab === "medical" && (
        <MedicalRecordsTab patientId={id} canEdit={canEdit} />
      )}

      {/* Documents */}
      {tab === "documents" && (
        <DocumentsTab patientId={id} canEdit={canEdit} />
      )}
    </div>
  );
}

// ───────────────────────────────────────────────────────
// Modal helper
// ───────────────────────────────────────────────────────

function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40">
      <div className="w-full max-w-md rounded-xl bg-white shadow-xl">
        <div className="flex items-center justify-between border-b px-5 py-3">
          <h3 className="font-semibold">{title}</h3>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-700"
          >
            <X size={18} />
          </button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

// ───────────────────────────────────────────────────────
// Medical Records Tab
// ───────────────────────────────────────────────────────

function MedicalRecordsTab({
  patientId,
  canEdit,
}: {
  patientId: string;
  canEdit: boolean;
}) {
  const [allergies, setAllergies] = useState<Allergy[]>([]);
  const [conditions, setConditions] = useState<Condition[]>([]);
  const [family, setFamily] = useState<FamilyHist[]>([]);
  const [immunizations, setImmunizations] = useState<Immunization[]>([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState<
    "allergy" | "condition" | "family" | "immunization" | null
  >(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [a, c, f, i] = await Promise.all([
        api.get<{ data: Allergy[] }>(`/ehr/patients/${patientId}/allergies`),
        api.get<{ data: Condition[] }>(
          `/ehr/patients/${patientId}/conditions`
        ),
        api.get<{ data: FamilyHist[] }>(
          `/ehr/patients/${patientId}/family-history`
        ),
        api.get<{ data: Immunization[] }>(
          `/ehr/patients/${patientId}/immunizations`
        ),
      ]);
      setAllergies(a.data);
      setConditions(c.data);
      setFamily(f.data);
      setImmunizations(i.data);
    } catch {
      // noop
    }
    setLoading(false);
  }, [patientId]);

  useEffect(() => {
    load();
  }, [load]);

  async function del(url: string) {
    if (!confirm("Delete this record?")) return;
    try {
      await api.delete(url);
      load();
    } catch (e) {
      alert((e as Error).message);
    }
  }

  if (loading) {
    return <div className="p-6 text-gray-500">Loading...</div>;
  }

  return (
    <div className="space-y-6">
      {/* Allergies */}
      <section className="rounded-xl bg-white p-6 shadow-sm">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="flex items-center gap-2 text-lg font-semibold">
            <AlertTriangle size={18} className="text-red-600" /> Allergies
          </h3>
          {canEdit && (
            <button
              onClick={() => setModal("allergy")}
              className="flex items-center gap-1 rounded-lg bg-primary px-3 py-1.5 text-sm text-white hover:opacity-90"
            >
              <Plus size={14} /> Add
            </button>
          )}
        </div>
        {allergies.length === 0 ? (
          <p className="text-sm text-gray-400">No allergies recorded</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {allergies.map((a) => (
              <div
                key={a.id}
                className={`flex items-center gap-2 rounded-full px-3 py-1.5 text-sm ${severityColors[a.severity]}`}
              >
                <span className="font-medium">{a.allergen}</span>
                <span className="text-xs opacity-80">
                  ({a.severity.replace("_", " ")})
                </span>
                {a.reaction && (
                  <span className="text-xs opacity-80">- {a.reaction}</span>
                )}
                {canEdit && (
                  <button
                    onClick={() => del(`/ehr/allergies/${a.id}`)}
                    className="ml-1 opacity-60 hover:opacity-100"
                  >
                    <Trash2 size={12} />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Chronic Conditions */}
      <section className="rounded-xl bg-white p-6 shadow-sm">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="flex items-center gap-2 text-lg font-semibold">
            <Heart size={18} className="text-red-500" /> Chronic Conditions
          </h3>
          {canEdit && (
            <button
              onClick={() => setModal("condition")}
              className="flex items-center gap-1 rounded-lg bg-primary px-3 py-1.5 text-sm text-white hover:opacity-90"
            >
              <Plus size={14} /> Add
            </button>
          )}
        </div>
        {conditions.length === 0 ? (
          <p className="text-sm text-gray-400">No chronic conditions</p>
        ) : (
          <div className="space-y-2">
            {conditions.map((c) => (
              <div
                key={c.id}
                className="flex items-center justify-between rounded-lg border border-gray-100 p-3"
              >
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{c.condition}</span>
                    {c.icd10Code && (
                      <span className="font-mono text-xs text-gray-500">
                        {c.icd10Code}
                      </span>
                    )}
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-medium ${conditionColors[c.status]}`}
                    >
                      {c.status}
                    </span>
                  </div>
                  {c.diagnosedDate && (
                    <p className="mt-0.5 text-xs text-gray-500">
                      Diagnosed:{" "}
                      {new Date(c.diagnosedDate).toLocaleDateString()}
                    </p>
                  )}
                  {c.notes && (
                    <p className="mt-1 text-sm text-gray-600">{c.notes}</p>
                  )}
                </div>
                {canEdit && (
                  <button
                    onClick={() => del(`/ehr/conditions/${c.id}`)}
                    className="text-gray-400 hover:text-red-600"
                  >
                    <Trash2 size={14} />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Family History */}
      <section className="rounded-xl bg-white p-6 shadow-sm">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="flex items-center gap-2 text-lg font-semibold">
            <Users size={18} className="text-blue-500" /> Family History
          </h3>
          {canEdit && (
            <button
              onClick={() => setModal("family")}
              className="flex items-center gap-1 rounded-lg bg-primary px-3 py-1.5 text-sm text-white hover:opacity-90"
            >
              <Plus size={14} /> Add
            </button>
          )}
        </div>
        {family.length === 0 ? (
          <p className="text-sm text-gray-400">No family history</p>
        ) : (
          <ul className="space-y-2 text-sm">
            {family.map((f) => (
              <li
                key={f.id}
                className="flex items-center justify-between border-b border-gray-100 pb-2"
              >
                <div>
                  <span className="font-medium">{f.relation}:</span>{" "}
                  {f.condition}
                  {f.notes && (
                    <span className="ml-2 text-xs text-gray-500">
                      ({f.notes})
                    </span>
                  )}
                </div>
                {canEdit && (
                  <button
                    onClick={() => del(`/ehr/family-history/${f.id}`)}
                    className="text-gray-400 hover:text-red-600"
                  >
                    <Trash2 size={14} />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Immunizations */}
      <section className="rounded-xl bg-white p-6 shadow-sm">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="flex items-center gap-2 text-lg font-semibold">
            <Syringe size={18} className="text-green-600" /> Immunizations
          </h3>
          {canEdit && (
            <button
              onClick={() => setModal("immunization")}
              className="flex items-center gap-1 rounded-lg bg-primary px-3 py-1.5 text-sm text-white hover:opacity-90"
            >
              <Plus size={14} /> Add
            </button>
          )}
        </div>
        {immunizations.length === 0 ? (
          <p className="text-sm text-gray-400">No immunizations recorded</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-xs text-gray-500">
                <tr className="border-b">
                  <th className="py-2 text-left">Vaccine</th>
                  <th className="py-2 text-left">Dose</th>
                  <th className="py-2 text-left">Date Given</th>
                  <th className="py-2 text-left">Next Due</th>
                  <th className="py-2 text-left">Batch</th>
                  {canEdit && <th />}
                </tr>
              </thead>
              <tbody>
                {immunizations.map((im) => {
                  const due = im.nextDueDate
                    ? new Date(im.nextDueDate)
                    : null;
                  const today = new Date();
                  today.setHours(0, 0, 0, 0);
                  const soon =
                    due &&
                    due.getTime() - today.getTime() < 30 * 86400_000 &&
                    due.getTime() >= today.getTime();
                  const overdue = due && due.getTime() < today.getTime();
                  return (
                    <tr
                      key={im.id}
                      className="border-b border-gray-50 hover:bg-gray-50"
                    >
                      <td className="py-2 font-medium">{im.vaccine}</td>
                      <td>{im.doseNumber ?? "-"}</td>
                      <td>{new Date(im.dateGiven).toLocaleDateString()}</td>
                      <td>
                        {due ? (
                          <span
                            className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                              overdue
                                ? "bg-red-100 text-red-700"
                                : soon
                                  ? "bg-amber-100 text-amber-800"
                                  : "bg-green-100 text-green-700"
                            }`}
                          >
                            {due.toLocaleDateString()}
                          </span>
                        ) : (
                          <span className="text-gray-400">-</span>
                        )}
                      </td>
                      <td className="text-xs text-gray-500">
                        {im.batchNumber || "-"}
                      </td>
                      {canEdit && (
                        <td>
                          <button
                            onClick={() =>
                              del(`/ehr/immunizations/${im.id}`)
                            }
                            className="text-gray-400 hover:text-red-600"
                          >
                            <Trash2 size={14} />
                          </button>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {modal === "allergy" && (
        <AllergyForm
          patientId={patientId}
          onClose={() => setModal(null)}
          onSaved={() => {
            setModal(null);
            load();
          }}
        />
      )}
      {modal === "condition" && (
        <ConditionForm
          patientId={patientId}
          onClose={() => setModal(null)}
          onSaved={() => {
            setModal(null);
            load();
          }}
        />
      )}
      {modal === "family" && (
        <FamilyForm
          patientId={patientId}
          onClose={() => setModal(null)}
          onSaved={() => {
            setModal(null);
            load();
          }}
        />
      )}
      {modal === "immunization" && (
        <ImmunizationForm
          patientId={patientId}
          onClose={() => setModal(null)}
          onSaved={() => {
            setModal(null);
            load();
          }}
        />
      )}
    </div>
  );
}

// ───────────────────────────────────────────────────────
// Add-record forms
// ───────────────────────────────────────────────────────

function AllergyForm({
  patientId,
  onClose,
  onSaved,
}: {
  patientId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [allergen, setAllergen] = useState("");
  const [severity, setSeverity] = useState<Allergy["severity"]>("MILD");
  const [reaction, setReaction] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      await api.post("/ehr/allergies", {
        patientId,
        allergen,
        severity,
        reaction: reaction || undefined,
        notes: notes || undefined,
      });
      onSaved();
    } catch (e) {
      alert((e as Error).message);
    }
    setSaving(false);
  }

  return (
    <Modal title="Add Allergy" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <div>
          <label className="text-xs text-gray-600">Allergen *</label>
          <input
            className="w-full rounded-md border px-3 py-2 text-sm"
            required
            value={allergen}
            onChange={(e) => setAllergen(e.target.value)}
          />
        </div>
        <div>
          <label className="text-xs text-gray-600">Severity *</label>
          <select
            className="w-full rounded-md border px-3 py-2 text-sm"
            value={severity}
            onChange={(e) =>
              setSeverity(e.target.value as Allergy["severity"])
            }
          >
            <option value="MILD">Mild</option>
            <option value="MODERATE">Moderate</option>
            <option value="SEVERE">Severe</option>
            <option value="LIFE_THREATENING">Life Threatening</option>
          </select>
        </div>
        <div>
          <label className="text-xs text-gray-600">Reaction</label>
          <input
            className="w-full rounded-md border px-3 py-2 text-sm"
            value={reaction}
            onChange={(e) => setReaction(e.target.value)}
          />
        </div>
        <div>
          <label className="text-xs text-gray-600">Notes</label>
          <textarea
            className="w-full rounded-md border px-3 py-2 text-sm"
            rows={2}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border px-3 py-1.5 text-sm"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={saving}
            className="rounded-md bg-primary px-3 py-1.5 text-sm text-white hover:opacity-90 disabled:opacity-50"
          >
            {saving ? "Saving..." : "Save"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function ConditionForm({
  patientId,
  onClose,
  onSaved,
}: {
  patientId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [condition, setCondition] = useState("");
  const [icd10Code, setIcd10] = useState("");
  const [diagnosedDate, setDate] = useState("");
  const [status, setStatus] = useState<Condition["status"]>("ACTIVE");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      await api.post("/ehr/conditions", {
        patientId,
        condition,
        icd10Code: icd10Code || undefined,
        diagnosedDate: diagnosedDate || undefined,
        status,
        notes: notes || undefined,
      });
      onSaved();
    } catch (e) {
      alert((e as Error).message);
    }
    setSaving(false);
  }

  return (
    <Modal title="Add Chronic Condition" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <div>
          <label className="text-xs text-gray-600">Condition *</label>
          <input
            className="w-full rounded-md border px-3 py-2 text-sm"
            required
            value={condition}
            onChange={(e) => setCondition(e.target.value)}
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs text-gray-600">ICD-10</label>
            <input
              className="w-full rounded-md border px-3 py-2 text-sm"
              value={icd10Code}
              onChange={(e) => setIcd10(e.target.value)}
            />
          </div>
          <div>
            <label className="text-xs text-gray-600">Diagnosed</label>
            <input
              type="date"
              className="w-full rounded-md border px-3 py-2 text-sm"
              value={diagnosedDate}
              onChange={(e) => setDate(e.target.value)}
            />
          </div>
        </div>
        <div>
          <label className="text-xs text-gray-600">Status *</label>
          <select
            className="w-full rounded-md border px-3 py-2 text-sm"
            value={status}
            onChange={(e) =>
              setStatus(e.target.value as Condition["status"])
            }
          >
            <option value="ACTIVE">Active</option>
            <option value="CONTROLLED">Controlled</option>
            <option value="RESOLVED">Resolved</option>
            <option value="RELAPSED">Relapsed</option>
          </select>
        </div>
        <div>
          <label className="text-xs text-gray-600">Notes</label>
          <textarea
            className="w-full rounded-md border px-3 py-2 text-sm"
            rows={2}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border px-3 py-1.5 text-sm"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={saving}
            className="rounded-md bg-primary px-3 py-1.5 text-sm text-white hover:opacity-90 disabled:opacity-50"
          >
            {saving ? "Saving..." : "Save"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function FamilyForm({
  patientId,
  onClose,
  onSaved,
}: {
  patientId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [relation, setRelation] = useState("");
  const [condition, setCondition] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      await api.post("/ehr/family-history", {
        patientId,
        relation,
        condition,
        notes: notes || undefined,
      });
      onSaved();
    } catch (e) {
      alert((e as Error).message);
    }
    setSaving(false);
  }

  return (
    <Modal title="Add Family History" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <div>
          <label className="text-xs text-gray-600">Relation *</label>
          <input
            placeholder="Mother, Father, Sibling..."
            className="w-full rounded-md border px-3 py-2 text-sm"
            required
            value={relation}
            onChange={(e) => setRelation(e.target.value)}
          />
        </div>
        <div>
          <label className="text-xs text-gray-600">Condition *</label>
          <input
            className="w-full rounded-md border px-3 py-2 text-sm"
            required
            value={condition}
            onChange={(e) => setCondition(e.target.value)}
          />
        </div>
        <div>
          <label className="text-xs text-gray-600">Notes</label>
          <textarea
            className="w-full rounded-md border px-3 py-2 text-sm"
            rows={2}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border px-3 py-1.5 text-sm"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={saving}
            className="rounded-md bg-primary px-3 py-1.5 text-sm text-white hover:opacity-90 disabled:opacity-50"
          >
            {saving ? "Saving..." : "Save"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function ImmunizationForm({
  patientId,
  onClose,
  onSaved,
}: {
  patientId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [vaccine, setVaccine] = useState("");
  const [doseNumber, setDose] = useState("");
  const [dateGiven, setDateGiven] = useState("");
  const [nextDueDate, setNextDue] = useState("");
  const [batchNumber, setBatch] = useState("");
  const [manufacturer, setMfg] = useState("");
  const [site, setSite] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      await api.post("/ehr/immunizations", {
        patientId,
        vaccine,
        doseNumber: doseNumber ? parseInt(doseNumber) : undefined,
        dateGiven,
        nextDueDate: nextDueDate || undefined,
        batchNumber: batchNumber || undefined,
        manufacturer: manufacturer || undefined,
        site: site || undefined,
        notes: notes || undefined,
      });
      onSaved();
    } catch (e) {
      alert((e as Error).message);
    }
    setSaving(false);
  }

  return (
    <Modal title="Record Immunization" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <div>
          <label className="text-xs text-gray-600">Vaccine *</label>
          <input
            className="w-full rounded-md border px-3 py-2 text-sm"
            required
            value={vaccine}
            onChange={(e) => setVaccine(e.target.value)}
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs text-gray-600">Dose #</label>
            <input
              type="number"
              min={1}
              className="w-full rounded-md border px-3 py-2 text-sm"
              value={doseNumber}
              onChange={(e) => setDose(e.target.value)}
            />
          </div>
          <div>
            <label className="text-xs text-gray-600">Date Given *</label>
            <input
              type="date"
              required
              className="w-full rounded-md border px-3 py-2 text-sm"
              value={dateGiven}
              onChange={(e) => setDateGiven(e.target.value)}
            />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs text-gray-600">Next Due</label>
            <input
              type="date"
              className="w-full rounded-md border px-3 py-2 text-sm"
              value={nextDueDate}
              onChange={(e) => setNextDue(e.target.value)}
            />
          </div>
          <div>
            <label className="text-xs text-gray-600">Site</label>
            <input
              placeholder="Left arm"
              className="w-full rounded-md border px-3 py-2 text-sm"
              value={site}
              onChange={(e) => setSite(e.target.value)}
            />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs text-gray-600">Batch #</label>
            <input
              className="w-full rounded-md border px-3 py-2 text-sm"
              value={batchNumber}
              onChange={(e) => setBatch(e.target.value)}
            />
          </div>
          <div>
            <label className="text-xs text-gray-600">Manufacturer</label>
            <input
              className="w-full rounded-md border px-3 py-2 text-sm"
              value={manufacturer}
              onChange={(e) => setMfg(e.target.value)}
            />
          </div>
        </div>
        <div>
          <label className="text-xs text-gray-600">Notes</label>
          <textarea
            className="w-full rounded-md border px-3 py-2 text-sm"
            rows={2}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border px-3 py-1.5 text-sm"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={saving}
            className="rounded-md bg-primary px-3 py-1.5 text-sm text-white hover:opacity-90 disabled:opacity-50"
          >
            {saving ? "Saving..." : "Save"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ───────────────────────────────────────────────────────
// Documents Tab
// ───────────────────────────────────────────────────────

function DocumentsTab({
  patientId,
  canEdit,
}: {
  patientId: string;
  canEdit: boolean;
}) {
  const [docs, setDocs] = useState<PatientDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [showUpload, setShowUpload] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<{ data: PatientDoc[] }>(
        `/ehr/patients/${patientId}/documents`
      );
      setDocs(res.data);
    } catch {
      // noop
    }
    setLoading(false);
  }, [patientId]);

  useEffect(() => {
    load();
  }, [load]);

  async function openDoc(id: string) {
    try {
      const res = await api.get<{
        data: PatientDoc & { downloadUrl: string };
      }>(`/ehr/documents/${id}`);
      const url = res.data.downloadUrl;
      if (url) {
        const base =
          process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000/api/v1";
        // downloadUrl already starts with /api/v1 — strip to avoid duplication
        const origin = base.replace(/\/api\/v1$/, "");
        window.open(origin + url, "_blank");
      }
    } catch (e) {
      alert((e as Error).message);
    }
  }

  async function del(id: string) {
    if (!confirm("Delete this document?")) return;
    try {
      await api.delete(`/ehr/documents/${id}`);
      load();
    } catch (e) {
      alert((e as Error).message);
    }
  }

  if (loading) {
    return <div className="p-6 text-gray-500">Loading...</div>;
  }

  const grouped = DOC_TYPES.reduce<Record<string, PatientDoc[]>>((acc, t) => {
    acc[t] = docs.filter((d) => d.type === t);
    return acc;
  }, {});

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-lg font-semibold">
          <FolderOpen size={18} className="text-primary" /> Documents
        </h3>
        {canEdit && (
          <button
            onClick={() => setShowUpload(true)}
            className="flex items-center gap-1 rounded-lg bg-primary px-3 py-1.5 text-sm text-white hover:opacity-90"
          >
            <Upload size={14} /> Upload
          </button>
        )}
      </div>

      {docs.length === 0 ? (
        <div className="rounded-xl bg-white p-8 text-center shadow-sm">
          <p className="text-gray-400">No documents uploaded</p>
        </div>
      ) : (
        <div className="space-y-4">
          {DOC_TYPES.map((t) => {
            const group = grouped[t];
            if (group.length === 0) return null;
            return (
              <div key={t} className="rounded-xl bg-white p-5 shadow-sm">
                <h4 className="mb-3 text-sm font-semibold text-gray-600">
                  {t.replace(/_/g, " ")}
                </h4>
                <ul className="space-y-2">
                  {group.map((d) => (
                    <li
                      key={d.id}
                      className="flex items-center justify-between rounded-lg border border-gray-100 p-3"
                    >
                      <div>
                        <p className="font-medium">{d.title}</p>
                        <p className="text-xs text-gray-500">
                          {new Date(d.createdAt).toLocaleString()}
                          {d.fileSize
                            ? ` · ${Math.round(d.fileSize / 1024)} KB`
                            : ""}
                          {d.mimeType ? ` · ${d.mimeType}` : ""}
                        </p>
                        {d.notes && (
                          <p className="mt-1 text-xs text-gray-600">
                            {d.notes}
                          </p>
                        )}
                      </div>
                      <div className="flex gap-2">
                        <button
                          onClick={() => openDoc(d.id)}
                          className="rounded-md p-1.5 text-gray-500 hover:bg-gray-100 hover:text-primary"
                          title="Download"
                        >
                          <Download size={14} />
                        </button>
                        {canEdit && (
                          <button
                            onClick={() => del(d.id)}
                            className="rounded-md p-1.5 text-gray-500 hover:bg-gray-100 hover:text-red-600"
                            title="Delete"
                          >
                            <Trash2 size={14} />
                          </button>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      )}

      {showUpload && (
        <DocumentUploadForm
          patientId={patientId}
          onClose={() => setShowUpload(false)}
          onSaved={() => {
            setShowUpload(false);
            load();
          }}
        />
      )}
    </div>
  );
}

function DocumentUploadForm({
  patientId,
  onClose,
  onSaved,
}: {
  patientId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [title, setTitle] = useState("");
  const [type, setType] = useState<(typeof DOC_TYPES)[number]>("LAB_REPORT");
  const [notes, setNotes] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return alert("Please choose a file");
    setSaving(true);
    try {
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const r = reader.result as string;
          resolve(r.split(",")[1] || r);
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });

      const upload = await api.post<{
        data: { filePath: string; fileSize: number };
      }>("/uploads", {
        filename: file.name,
        base64Content: base64,
        patientId,
        type,
      });

      await api.post("/ehr/documents", {
        patientId,
        type,
        title: title || file.name,
        notes: notes || undefined,
        filePath: upload.data.filePath,
        fileSize: upload.data.fileSize,
        mimeType: file.type,
      });
      onSaved();
    } catch (e) {
      alert((e as Error).message);
    }
    setSaving(false);
  }

  return (
    <Modal title="Upload Document" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <div>
          <label className="text-xs text-gray-600">Type *</label>
          <select
            className="w-full rounded-md border px-3 py-2 text-sm"
            value={type}
            onChange={(e) =>
              setType(e.target.value as (typeof DOC_TYPES)[number])
            }
          >
            {DOC_TYPES.map((t) => (
              <option key={t} value={t}>
                {t.replace(/_/g, " ")}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="text-xs text-gray-600">Title</label>
          <input
            className="w-full rounded-md border px-3 py-2 text-sm"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Optional – defaults to filename"
          />
        </div>
        <div>
          <label className="text-xs text-gray-600">File *</label>
          <input
            type="file"
            required
            className="w-full text-sm"
            onChange={(e) => setFile(e.target.files?.[0] || null)}
          />
        </div>
        <div>
          <label className="text-xs text-gray-600">Notes</label>
          <textarea
            className="w-full rounded-md border px-3 py-2 text-sm"
            rows={2}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border px-3 py-1.5 text-sm"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={saving}
            className="rounded-md bg-primary px-3 py-1.5 text-sm text-white hover:opacity-90 disabled:opacity-50"
          >
            {saving ? "Uploading..." : "Upload"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
