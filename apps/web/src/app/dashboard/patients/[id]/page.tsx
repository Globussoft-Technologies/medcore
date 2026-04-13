"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { api } from "@/lib/api";
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
} from "lucide-react";

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

export default function PatientDetailPage() {
  const params = useParams();
  const id = params.id as string;
  const [patient, setPatient] = useState<PatientDetail | null>(null);
  const [visits, setVisits] = useState<VisitRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedVisit, setExpandedVisit] = useState<string | null>(null);

  useEffect(() => {
    loadPatient();
  }, [id]);

  async function loadPatient() {
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
      // empty
    }
    setLoading(false);
  }

  function toggleVisit(visitId: string) {
    setExpandedVisit(expandedVisit === visitId ? null : visitId);
  }

  if (loading) {
    return (
      <div className="p-8 text-center text-gray-500">
        Loading patient details...
      </div>
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

      {/* Visit History Timeline */}
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
              <div
                key={visit.id}
                className="rounded-xl bg-white shadow-sm"
              >
                {/* Visit header */}
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
                        className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${statusColors[visit.status] || "bg-gray-100 text-gray-600"}`}
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

                {/* Expanded details */}
                {isExpanded && (
                  <div className="border-t px-6 py-4">
                    <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
                      {/* Vitals */}
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
                                <span className="text-gray-500">Weight:</span>{" "}
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

                      {/* Prescription */}
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

                      {/* Invoice */}
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
    </div>
  );
}
