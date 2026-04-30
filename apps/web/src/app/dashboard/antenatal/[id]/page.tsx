"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { api, openPrintEndpoint } from "@/lib/api";
import { useAuthStore } from "@/lib/store";
import { toast } from "@/lib/toast";
import { usePrompt } from "@/lib/use-dialog";
import { formatDoctorName } from "@/lib/format-doctor-name";
import {
  ArrowLeft,
  Plus,
  AlertTriangle,
  Baby,
  Calendar,
  Activity,
  ChevronDown,
  ChevronRight,
} from "lucide-react";

interface AncVisit {
  id: string;
  type: string;
  visitDate: string;
  weeksOfGestation?: number | null;
  weight?: number | null;
  bloodPressure?: string | null;
  fundalHeight?: string | null;
  fetalHeartRate?: number | null;
  presentation?: string | null;
  hemoglobin?: number | null;
  urineProtein?: string | null;
  urineSugar?: string | null;
  notes?: string | null;
  prescribedMeds?: string | null;
  nextVisitDate?: string | null;
}

interface AncCase {
  id: string;
  caseNumber: string;
  lmpDate: string;
  eddDate: string;
  gravida: number;
  parity: number;
  bloodGroup?: string | null;
  isHighRisk: boolean;
  riskFactors?: string | null;
  deliveredAt?: string | null;
  deliveryType?: string | null;
  babyGender?: string | null;
  babyWeight?: number | null;
  outcomeNotes?: string | null;
  patient: {
    id: string;
    mrNumber?: string;
    user: { name: string; phone?: string; email?: string };
  };
  doctor: { id: string; user: { name: string } };
  visits: AncVisit[];
}

const VISIT_TYPES = [
  { value: "FIRST_VISIT", label: "First Visit" },
  { value: "ROUTINE", label: "Routine" },
  { value: "HIGH_RISK_FOLLOWUP", label: "High Risk Follow-up" },
  { value: "SCAN_REVIEW", label: "Scan Review" },
  { value: "DELIVERY", label: "Delivery" },
  { value: "POSTNATAL", label: "Postnatal" },
];

export default function AncCaseDetailPage() {
  const params = useParams();
  const id = params.id as string;
  const { user } = useAuthStore();

  const [caseData, setCaseData] = useState<AncCase | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<
    "visits" | "delivery" | "partograph" | "postnatal" | "risk"
  >("visits");
  const [expandedVisits, setExpandedVisits] = useState<Set<string>>(new Set());
  const [showVisitForm, setShowVisitForm] = useState(false);
  const [showDeliveryForm, setShowDeliveryForm] = useState(false);

  const [visitForm, setVisitForm] = useState({
    type: "ROUTINE",
    weeksOfGestation: "",
    weight: "",
    bloodPressure: "",
    fundalHeight: "",
    fetalHeartRate: "",
    presentation: "",
    hemoglobin: "",
    urineProtein: "",
    urineSugar: "",
    notes: "",
    prescribedMeds: "",
    nextVisitDate: "",
  });

  const [deliveryForm, setDeliveryForm] = useState({
    deliveryType: "NORMAL",
    babyGender: "",
    babyWeight: "",
    outcomeNotes: "",
  });

  const canEdit =
    user?.role === "DOCTOR" || user?.role === "ADMIN" || user?.role === "NURSE";
  const canDeliver = user?.role === "DOCTOR" || user?.role === "ADMIN";

  useEffect(() => {
    load();
  }, [id]);

  async function load() {
    setLoading(true);
    try {
      const res = await api.get<{ data: AncCase }>(`/antenatal/cases/${id}`);
      setCaseData(res.data);
    } catch {
      // empty
    }
    setLoading(false);
  }

  function toggleVisit(id: string) {
    const s = new Set(expandedVisits);
    if (s.has(id)) s.delete(id);
    else s.add(id);
    setExpandedVisits(s);
  }

  async function submitVisit(e: React.FormEvent) {
    e.preventDefault();
    if (!caseData) return;
    // Issue #219: don't create a blank ANC visit row. Require at least one
    // clinical observation beyond the visit type so the timeline isn't
    // polluted with content-free entries.
    const hasClinicalContent =
      !!visitForm.weeksOfGestation ||
      !!visitForm.weight ||
      !!visitForm.bloodPressure ||
      !!visitForm.fundalHeight ||
      !!visitForm.fetalHeartRate ||
      !!visitForm.hemoglobin ||
      !!visitForm.urineProtein ||
      !!visitForm.urineSugar ||
      !!visitForm.notes;
    if (!hasClinicalContent) {
      toast.error(
        "Record at least one observation (vitals, fetal HR, urine, hemoglobin, or notes) before saving the visit."
      );
      return;
    }
    try {
      await api.post("/antenatal/visits", {
        ancCaseId: caseData.id,
        type: visitForm.type,
        weeksOfGestation: visitForm.weeksOfGestation
          ? parseInt(visitForm.weeksOfGestation)
          : undefined,
        weight: visitForm.weight ? parseFloat(visitForm.weight) : undefined,
        bloodPressure: visitForm.bloodPressure || undefined,
        fundalHeight: visitForm.fundalHeight || undefined,
        fetalHeartRate: visitForm.fetalHeartRate
          ? parseInt(visitForm.fetalHeartRate)
          : undefined,
        presentation: visitForm.presentation || undefined,
        hemoglobin: visitForm.hemoglobin
          ? parseFloat(visitForm.hemoglobin)
          : undefined,
        urineProtein: visitForm.urineProtein || undefined,
        urineSugar: visitForm.urineSugar || undefined,
        notes: visitForm.notes || undefined,
        prescribedMeds: visitForm.prescribedMeds || undefined,
        nextVisitDate: visitForm.nextVisitDate || undefined,
      });
      setShowVisitForm(false);
      setVisitForm({
        type: "ROUTINE",
        weeksOfGestation: "",
        weight: "",
        bloodPressure: "",
        fundalHeight: "",
        fetalHeartRate: "",
        presentation: "",
        hemoglobin: "",
        urineProtein: "",
        urineSugar: "",
        notes: "",
        prescribedMeds: "",
        nextVisitDate: "",
      });
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to add visit");
    }
  }

  async function submitDelivery(e: React.FormEvent) {
    e.preventDefault();
    if (!caseData) return;
    try {
      await api.patch(`/antenatal/cases/${caseData.id}/delivery`, {
        deliveryType: deliveryForm.deliveryType,
        babyGender: deliveryForm.babyGender || undefined,
        babyWeight: deliveryForm.babyWeight
          ? parseFloat(deliveryForm.babyWeight)
          : undefined,
        outcomeNotes: deliveryForm.outcomeNotes || undefined,
      });
      setShowDeliveryForm(false);
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to record delivery");
    }
  }

  if (loading || !caseData) {
    return <div className="p-8 text-center text-gray-500">Loading...</div>;
  }

  const weeksGestation = Math.round(
    (new Date().getTime() - new Date(caseData.lmpDate).getTime()) /
      (7 * 24 * 60 * 60 * 1000)
  );
  const daysToEdd = Math.round(
    (new Date(caseData.eddDate).getTime() - new Date().getTime()) /
      (24 * 60 * 60 * 1000)
  );

  // Timeline points
  const lmpDate = new Date(caseData.lmpDate);
  const eddDate = new Date(caseData.eddDate);
  const totalMs = eddDate.getTime() - lmpDate.getTime();

  return (
    <div>
      <Link
        href="/dashboard/antenatal"
        className="mb-4 inline-flex items-center gap-1 text-sm text-gray-500 hover:text-primary"
      >
        <ArrowLeft size={14} /> Back to ANC
      </Link>

      <div className="mb-6 flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold">
            {caseData.caseNumber}
            {caseData.isHighRisk && (
              <span className="ml-3 rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700">
                High Risk
              </span>
            )}
            {caseData.deliveredAt && (
              <span className="ml-2 rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-700">
                Delivered
              </span>
            )}
          </h1>
          <p className="text-sm text-gray-500">
            {caseData.patient.user.name} · {caseData.patient.mrNumber}
          </p>
        </div>
        {caseData.deliveredAt && (
          <button
            onClick={() =>
              openPrintEndpoint(`/antenatal/cases/${caseData.id}/birth-certificate`)
            }
            className="inline-flex items-center gap-1.5 rounded-lg border border-blue-300 bg-blue-50 px-3 py-1.5 text-sm font-medium text-blue-800 hover:bg-blue-100"
          >
            Print Birth Certificate
          </button>
        )}
      </div>

      {/* Summary Cards */}
      <div className="mb-6 grid grid-cols-1 gap-4 md:grid-cols-2">
        <div className="rounded-xl bg-white p-5 shadow-sm">
          <h3 className="mb-3 text-sm font-semibold text-gray-500">Patient Info</h3>
          <p className="text-lg font-semibold">{caseData.patient.user.name}</p>
          <p className="text-sm text-gray-500">MR: {caseData.patient.mrNumber}</p>
          {caseData.patient.user.phone && (
            <p className="text-sm text-gray-500">
              Phone: {caseData.patient.user.phone}
            </p>
          )}
          <p className="mt-2 text-sm">
            Doctor: <strong>{formatDoctorName(caseData.doctor.user.name)}</strong>
          </p>
        </div>

        <div className="rounded-xl bg-white p-5 shadow-sm">
          <h3 className="mb-3 text-sm font-semibold text-gray-500">ANC Summary</h3>
          <div className="grid grid-cols-2 gap-y-2 text-sm">
            <div>
              <span className="text-gray-500">LMP:</span>{" "}
              <strong>{new Date(caseData.lmpDate).toLocaleDateString()}</strong>
            </div>
            <div>
              <span className="text-gray-500">EDD:</span>{" "}
              <strong>{new Date(caseData.eddDate).toLocaleDateString()}</strong>
            </div>
            <div>
              <span className="text-gray-500">Gravida/Parity:</span>{" "}
              <strong>
                G{caseData.gravida} P{caseData.parity}
              </strong>
            </div>
            <div>
              <span className="text-gray-500">Blood Group:</span>{" "}
              <strong>{caseData.bloodGroup || "—"}</strong>
            </div>
            {!caseData.deliveredAt && (
              <>
                <div>
                  <span className="text-gray-500">Gestation:</span>{" "}
                  <strong>{weeksGestation}w</strong>
                </div>
                <div>
                  <span className="text-gray-500">Days to EDD:</span>{" "}
                  <strong className={daysToEdd < 0 ? "text-red-600" : ""}>
                    {daysToEdd < 0 ? `${Math.abs(daysToEdd)}d overdue` : `${daysToEdd}d`}
                  </strong>
                </div>
              </>
            )}
          </div>
          {caseData.isHighRisk && caseData.riskFactors && (
            <div className="mt-3 rounded-lg bg-red-50 p-2 text-xs">
              <strong className="text-red-700 flex items-center gap-1">
                <AlertTriangle size={14} /> Risk Factors:
              </strong>
              <p className="text-red-700">{caseData.riskFactors}</p>
            </div>
          )}
        </div>
      </div>

      {/* Timeline */}
      <div className="mb-6 rounded-xl bg-white p-5 shadow-sm">
        <h3 className="mb-3 text-sm font-semibold text-gray-500">Timeline</h3>
        <div className="relative">
          <div className="h-2 rounded-full bg-gray-200">
            <div
              className="h-2 rounded-full bg-primary"
              style={{
                width: `${Math.min(
                  100,
                  Math.max(
                    0,
                    ((new Date().getTime() - lmpDate.getTime()) / totalMs) * 100
                  )
                )}%`,
              }}
            />
          </div>
          <div className="mt-2 flex justify-between text-xs text-gray-500">
            <span>LMP {lmpDate.toLocaleDateString()}</span>
            <span>Today · {weeksGestation}w</span>
            <span>EDD {eddDate.toLocaleDateString()}</span>
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            {caseData.visits.map((v) => (
              <span
                key={v.id}
                className="inline-flex items-center gap-1 rounded-full bg-blue-50 px-2 py-0.5 text-xs text-blue-700"
              >
                <Activity size={12} />
                {v.weeksOfGestation != null ? `${v.weeksOfGestation}w ` : ""}
                {new Date(v.visitDate).toLocaleDateString()}
              </span>
            ))}
          </div>
        </div>
      </div>

      <div className="mb-4 flex gap-2">
        <button
          onClick={() => setTab("visits")}
          className={`px-4 py-2 text-sm font-medium rounded-lg transition ${
            tab === "visits"
              ? "bg-primary text-white"
              : "bg-gray-100 text-gray-600 hover:bg-gray-200"
          }`}
        >
          Visits ({caseData.visits.length})
        </button>
        <button
          onClick={() => setTab("delivery")}
          className={`px-4 py-2 text-sm font-medium rounded-lg transition ${
            tab === "delivery"
              ? "bg-primary text-white"
              : "bg-gray-100 text-gray-600 hover:bg-gray-200"
          }`}
        >
          Delivery
        </button>
        <button
          onClick={() => setTab("partograph")}
          className={`px-4 py-2 text-sm font-medium rounded-lg transition ${
            tab === "partograph"
              ? "bg-primary text-white"
              : "bg-gray-100 text-gray-600 hover:bg-gray-200"
          }`}
        >
          Partograph
        </button>
        <button
          onClick={() => setTab("risk")}
          className={`px-4 py-2 text-sm font-medium rounded-lg transition ${
            tab === "risk"
              ? "bg-primary text-white"
              : "bg-gray-100 text-gray-600 hover:bg-gray-200"
          }`}
        >
          ACOG Risk
        </button>
        {caseData.deliveredAt && (
          <button
            onClick={() => setTab("postnatal")}
            className={`px-4 py-2 text-sm font-medium rounded-lg transition ${
              tab === "postnatal"
                ? "bg-primary text-white"
                : "bg-gray-100 text-gray-600 hover:bg-gray-200"
            }`}
          >
            Postnatal Visits
          </button>
        )}
      </div>

      {tab === "partograph" && <PartographTab caseId={id} canEdit={canEdit} />}
      {tab === "risk" && (
        <AcogRiskTab caseId={id} canEdit={canEdit} onUpdated={load} />
      )}
      {tab === "postnatal" && (
        <PostnatalTab caseId={id} canEdit={canEdit} />
      )}

      {tab === "visits" && (
        <div className="rounded-xl bg-white p-5 shadow-sm">
          <div className="mb-4 flex items-center justify-between">
            <h3 className="font-semibold">Antenatal Visits</h3>
            {canEdit && !caseData.deliveredAt && (
              <button
                onClick={() => setShowVisitForm(!showVisitForm)}
                className="flex items-center gap-1 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-white hover:bg-primary-dark"
              >
                <Plus size={14} /> Add Visit
              </button>
            )}
          </div>

          {showVisitForm && (
            <form
              onSubmit={submitVisit}
              className="mb-4 rounded-lg border bg-gray-50 p-4"
            >
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="mb-1 block text-xs font-medium">Type</label>
                  <select
                    value={visitForm.type}
                    onChange={(e) => setVisitForm({ ...visitForm, type: e.target.value })}
                    className="w-full rounded border px-2 py-1.5 text-sm"
                  >
                    {VISIT_TYPES.map((t) => (
                      <option key={t.value} value={t.value}>
                        {t.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium">Weeks Gestation</label>
                  <input
                    type="number"
                    value={visitForm.weeksOfGestation}
                    onChange={(e) =>
                      setVisitForm({ ...visitForm, weeksOfGestation: e.target.value })
                    }
                    className="w-full rounded border px-2 py-1.5 text-sm"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium">Weight (kg)</label>
                  <input
                    type="number"
                    step="0.1"
                    value={visitForm.weight}
                    onChange={(e) => setVisitForm({ ...visitForm, weight: e.target.value })}
                    className="w-full rounded border px-2 py-1.5 text-sm"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium">Blood Pressure</label>
                  <input
                    placeholder="e.g. 120/80"
                    value={visitForm.bloodPressure}
                    onChange={(e) =>
                      setVisitForm({ ...visitForm, bloodPressure: e.target.value })
                    }
                    className="w-full rounded border px-2 py-1.5 text-sm"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium">Fundal Height (cm)</label>
                  <input
                    value={visitForm.fundalHeight}
                    onChange={(e) =>
                      setVisitForm({ ...visitForm, fundalHeight: e.target.value })
                    }
                    className="w-full rounded border px-2 py-1.5 text-sm"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium">FHR (bpm)</label>
                  <input
                    type="number"
                    value={visitForm.fetalHeartRate}
                    onChange={(e) =>
                      setVisitForm({ ...visitForm, fetalHeartRate: e.target.value })
                    }
                    className="w-full rounded border px-2 py-1.5 text-sm"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium">Presentation</label>
                  <input
                    placeholder="e.g. Cephalic"
                    value={visitForm.presentation}
                    onChange={(e) =>
                      setVisitForm({ ...visitForm, presentation: e.target.value })
                    }
                    className="w-full rounded border px-2 py-1.5 text-sm"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium">Hb (g/dl)</label>
                  <input
                    type="number"
                    step="0.1"
                    value={visitForm.hemoglobin}
                    onChange={(e) =>
                      setVisitForm({ ...visitForm, hemoglobin: e.target.value })
                    }
                    className="w-full rounded border px-2 py-1.5 text-sm"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium">Urine Protein</label>
                  <input
                    placeholder="nil/+/++/+++"
                    value={visitForm.urineProtein}
                    onChange={(e) =>
                      setVisitForm({ ...visitForm, urineProtein: e.target.value })
                    }
                    className="w-full rounded border px-2 py-1.5 text-sm"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium">Urine Sugar</label>
                  <input
                    placeholder="nil/+/++/+++"
                    value={visitForm.urineSugar}
                    onChange={(e) =>
                      setVisitForm({ ...visitForm, urineSugar: e.target.value })
                    }
                    className="w-full rounded border px-2 py-1.5 text-sm"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium">Next Visit</label>
                  <input
                    type="date"
                    value={visitForm.nextVisitDate}
                    onChange={(e) =>
                      setVisitForm({ ...visitForm, nextVisitDate: e.target.value })
                    }
                    className="w-full rounded border px-2 py-1.5 text-sm"
                  />
                </div>
              </div>
              <div className="mt-3">
                <label className="mb-1 block text-xs font-medium">Prescribed Meds</label>
                <input
                  value={visitForm.prescribedMeds}
                  onChange={(e) =>
                    setVisitForm({ ...visitForm, prescribedMeds: e.target.value })
                  }
                  placeholder="e.g. Folic acid, Iron, Calcium"
                  className="w-full rounded border px-2 py-1.5 text-sm"
                />
              </div>
              <div className="mt-3">
                <label className="mb-1 block text-xs font-medium">Notes</label>
                <textarea
                  rows={2}
                  value={visitForm.notes}
                  onChange={(e) => setVisitForm({ ...visitForm, notes: e.target.value })}
                  className="w-full rounded border px-2 py-1.5 text-sm"
                />
              </div>
              <div className="mt-3 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setShowVisitForm(false)}
                  className="rounded border px-3 py-1.5 text-sm"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="rounded bg-primary px-3 py-1.5 text-sm font-medium text-white hover:bg-primary-dark"
                >
                  Save Visit
                </button>
              </div>
            </form>
          )}

          {caseData.visits.length === 0 ? (
            <p className="py-8 text-center text-sm text-gray-500">
              No visits recorded yet.
            </p>
          ) : (
            <div className="space-y-2">
              {caseData.visits.map((v) => {
                const isOpen = expandedVisits.has(v.id);
                return (
                  <div
                    key={v.id}
                    className="rounded-lg border bg-white"
                  >
                    <button
                      onClick={() => toggleVisit(v.id)}
                      className="flex w-full items-center justify-between px-4 py-3 text-left hover:bg-gray-50"
                    >
                      <div className="flex items-center gap-3">
                        {isOpen ? (
                          <ChevronDown size={16} className="text-gray-400" />
                        ) : (
                          <ChevronRight size={16} className="text-gray-400" />
                        )}
                        <div>
                          <p className="text-sm font-medium">
                            {v.type.replace(/_/g, " ")} ·{" "}
                            {new Date(v.visitDate).toLocaleDateString()}
                          </p>
                          <p className="text-xs text-gray-500">
                            {v.weeksOfGestation != null &&
                              `${v.weeksOfGestation}w · `}
                            {v.bloodPressure && `BP ${v.bloodPressure} · `}
                            {v.weight && `${v.weight} kg`}
                          </p>
                        </div>
                      </div>
                      {v.nextVisitDate && (
                        <span className="text-xs text-gray-500">
                          Next: {new Date(v.nextVisitDate).toLocaleDateString()}
                        </span>
                      )}
                    </button>
                    {isOpen && (
                      <div className="grid grid-cols-2 gap-3 border-t bg-gray-50 px-4 py-3 text-xs md:grid-cols-3">
                        {v.fundalHeight && (
                          <div>
                            <span className="text-gray-500">Fundal:</span>{" "}
                            <strong>{v.fundalHeight}</strong>
                          </div>
                        )}
                        {v.fetalHeartRate && (
                          <div>
                            <span className="text-gray-500">FHR:</span>{" "}
                            <strong>{v.fetalHeartRate} bpm</strong>
                          </div>
                        )}
                        {v.presentation && (
                          <div>
                            <span className="text-gray-500">Presentation:</span>{" "}
                            <strong>{v.presentation}</strong>
                          </div>
                        )}
                        {v.hemoglobin && (
                          <div>
                            <span className="text-gray-500">Hb:</span>{" "}
                            <strong>{v.hemoglobin} g/dl</strong>
                          </div>
                        )}
                        {v.urineProtein && (
                          <div>
                            <span className="text-gray-500">Urine protein:</span>{" "}
                            <strong>{v.urineProtein}</strong>
                          </div>
                        )}
                        {v.urineSugar && (
                          <div>
                            <span className="text-gray-500">Urine sugar:</span>{" "}
                            <strong>{v.urineSugar}</strong>
                          </div>
                        )}
                        {v.prescribedMeds && (
                          <div className="col-span-full">
                            <span className="text-gray-500">Prescribed:</span>{" "}
                            <strong>{v.prescribedMeds}</strong>
                          </div>
                        )}
                        {v.notes && (
                          <div className="col-span-full">
                            <span className="text-gray-500">Notes:</span>{" "}
                            {v.notes}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {tab === "delivery" && (
        <div className="rounded-xl bg-white p-5 shadow-sm">
          {caseData.deliveredAt ? (
            <div>
              <h3 className="mb-3 flex items-center gap-2 font-semibold">
                <Baby size={18} /> Delivery Details
              </h3>
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div>
                  <span className="text-gray-500">Delivered At:</span>{" "}
                  <strong>
                    {new Date(caseData.deliveredAt).toLocaleString()}
                  </strong>
                </div>
                <div>
                  <span className="text-gray-500">Type:</span>{" "}
                  <strong>{caseData.deliveryType?.replace(/_/g, " ")}</strong>
                </div>
                <div>
                  <span className="text-gray-500">Baby Gender:</span>{" "}
                  <strong>{caseData.babyGender || "—"}</strong>
                </div>
                <div>
                  <span className="text-gray-500">Baby Weight:</span>{" "}
                  <strong>
                    {caseData.babyWeight ? `${caseData.babyWeight} kg` : "—"}
                  </strong>
                </div>
              </div>
              {caseData.outcomeNotes && (
                <div className="mt-4">
                  <p className="text-xs text-gray-500">Outcome Notes</p>
                  <p className="mt-1 text-sm">{caseData.outcomeNotes}</p>
                </div>
              )}
            </div>
          ) : canDeliver ? (
            showDeliveryForm ? (
              <form onSubmit={submitDelivery}>
                <h3 className="mb-3 font-semibold">Record Delivery</h3>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="mb-1 block text-sm font-medium">
                      Delivery Type
                    </label>
                    <select
                      value={deliveryForm.deliveryType}
                      onChange={(e) =>
                        setDeliveryForm({
                          ...deliveryForm,
                          deliveryType: e.target.value,
                        })
                      }
                      className="w-full rounded-lg border px-3 py-2 text-sm"
                    >
                      <option value="NORMAL">Normal</option>
                      <option value="C_SECTION">C-Section</option>
                      <option value="INSTRUMENTAL">Instrumental</option>
                    </select>
                  </div>
                  <div>
                    <label className="mb-1 block text-sm font-medium">
                      Baby Gender
                    </label>
                    <select
                      value={deliveryForm.babyGender}
                      onChange={(e) =>
                        setDeliveryForm({
                          ...deliveryForm,
                          babyGender: e.target.value,
                        })
                      }
                      className="w-full rounded-lg border px-3 py-2 text-sm"
                    >
                      <option value="">—</option>
                      <option value="MALE">Male</option>
                      <option value="FEMALE">Female</option>
                      <option value="OTHER">Other</option>
                    </select>
                  </div>
                  <div>
                    <label className="mb-1 block text-sm font-medium">
                      Baby Weight (kg)
                    </label>
                    <input
                      type="number"
                      step="0.01"
                      value={deliveryForm.babyWeight}
                      onChange={(e) =>
                        setDeliveryForm({
                          ...deliveryForm,
                          babyWeight: e.target.value,
                        })
                      }
                      className="w-full rounded-lg border px-3 py-2 text-sm"
                    />
                  </div>
                </div>
                <div className="mt-4">
                  <label className="mb-1 block text-sm font-medium">
                    Outcome Notes
                  </label>
                  <textarea
                    rows={3}
                    value={deliveryForm.outcomeNotes}
                    onChange={(e) =>
                      setDeliveryForm({
                        ...deliveryForm,
                        outcomeNotes: e.target.value,
                      })
                    }
                    className="w-full rounded-lg border px-3 py-2 text-sm"
                  />
                </div>
                <div className="mt-4 flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setShowDeliveryForm(false)}
                    className="rounded-lg border px-4 py-2 text-sm"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark"
                  >
                    Record Delivery
                  </button>
                </div>
              </form>
            ) : (
              <div className="py-8 text-center">
                <Calendar size={36} className="mx-auto mb-3 text-gray-300" />
                <p className="mb-4 text-gray-500">No delivery recorded yet.</p>
                <button
                  onClick={() => setShowDeliveryForm(true)}
                  className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark"
                >
                  Record Delivery
                </button>
              </div>
            )
          ) : (
            <p className="py-8 text-center text-gray-500">Delivery not yet recorded.</p>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Partograph Tab ─────────────────────────────────

interface PartographObs {
  time: string;
  fetalHeartRate?: number;
  cervicalDilation?: number;
  descent?: number;
  contractionsPer10Min?: number;
  contractionStrength?: string;
  maternalPulse?: number;
  maternalBP?: string;
  temperature?: number;
  notes?: string;
}

interface Partograph {
  id: string;
  startedAt: string;
  endedAt?: string | null;
  observations: PartographObs[];
  interventions?: string | null;
  outcome?: string | null;
  chart?: {
    dilationSeries: Array<{ hoursSinceStart: number; cervicalDilation: number }>;
    fhrSeries: Array<{ hoursSinceStart: number; fetalHeartRate: number }>;
    alertLine: Array<{ hour: number; dilation: number }>;
    actionLine: Array<{ hour: number; dilation: number }>;
  };
  flags?: string[];
}

function PartographTab({ caseId, canEdit }: { caseId: string; canEdit: boolean }) {
  const promptUser = usePrompt();
  const [list, setList] = useState<Partograph[]>([]);
  const [active, setActive] = useState<Partograph | null>(null);
  const [loading, setLoading] = useState(true);
  const [obs, setObs] = useState<PartographObs>({
    time: new Date().toISOString().slice(0, 16),
  });

  async function loadList() {
    setLoading(true);
    try {
      // Fetch full case with partographs via /antenatal/cases/:id
      const res = await api.get<{
        data: { partographs?: Partograph[] } & Record<string, unknown>;
      }>(`/antenatal/cases/${caseId}`);
      const ps = (res.data.partographs as Partograph[]) ?? [];
      setList(ps);
      if (ps.length > 0) {
        const latest = ps[ps.length - 1];
        const detail = await api.get<{ data: Partograph }>(
          `/antenatal/partograph/${latest.id}`
        );
        setActive(detail.data);
      } else {
        setActive(null);
      }
    } catch {
      setList([]);
      setActive(null);
    }
    setLoading(false);
  }

  useEffect(() => {
    loadList();
  }, [caseId]);

  async function startNew() {
    try {
      await api.post(`/antenatal/cases/${caseId}/partograph`, { observations: [] });
      loadList();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    }
  }

  async function addObs() {
    if (!active) return;
    try {
      const payload: Record<string, unknown> = { time: obs.time || new Date().toISOString() };
      if (obs.fetalHeartRate) payload.fetalHeartRate = Number(obs.fetalHeartRate);
      if (obs.cervicalDilation != null)
        payload.cervicalDilation = Number(obs.cervicalDilation);
      if (obs.descent != null) payload.descent = Number(obs.descent);
      if (obs.contractionsPer10Min)
        payload.contractionsPer10Min = Number(obs.contractionsPer10Min);
      if (obs.contractionStrength) payload.contractionStrength = obs.contractionStrength;
      if (obs.maternalPulse) payload.maternalPulse = Number(obs.maternalPulse);
      if (obs.maternalBP) payload.maternalBP = obs.maternalBP;
      if (obs.temperature) payload.temperature = Number(obs.temperature);
      if (obs.notes) payload.notes = obs.notes;

      await api.patch(`/antenatal/partograph/${active.id}/observation`, payload);
      setObs({ time: new Date().toISOString().slice(0, 16) });
      loadList();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    }
  }

  async function endPg() {
    if (!active) return;
    const outcome = await promptUser({
      title: "End partograph",
      label: "Outcome",
      placeholder: "e.g., Normal delivery, C-section",
      required: true,
    });
    if (!outcome) return;
    try {
      await api.patch(`/antenatal/partograph/${active.id}/end`, { outcome });
      loadList();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    }
  }

  return (
    <div className="rounded-xl bg-white p-5 shadow-sm">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="font-semibold">Partograph</h3>
        {canEdit && (!active || active.endedAt) && (
          <button
            onClick={startNew}
            className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-white"
          >
            Start New Partograph
          </button>
        )}
      </div>

      {loading ? (
        <p className="text-sm text-gray-500">Loading...</p>
      ) : !active ? (
        <p className="text-sm text-gray-500">No partograph started.</p>
      ) : (
        <>
          <div className="mb-3 text-xs text-gray-600">
            Started: {new Date(active.startedAt).toLocaleString()}
            {active.endedAt && (
              <span className="ml-3">
                · Ended: {new Date(active.endedAt).toLocaleString()} ·{" "}
                <b>{active.outcome}</b>
              </span>
            )}
          </div>

          {active.flags && active.flags.length > 0 && (
            <div className="mb-3 rounded-lg border-l-4 border-amber-500 bg-amber-50 p-2 text-xs">
              <p className="font-semibold text-amber-900">Flags</p>
              <ul className="list-disc pl-4 text-amber-800">
                {active.flags.map((f, i) => (
                  <li key={i}>{f}</li>
                ))}
              </ul>
            </div>
          )}

          {/* SVG chart: cervical dilation + FHR */}
          {active.chart && (
            <PartographChart chart={active.chart} />
          )}

          {canEdit && !active.endedAt && (
            <div className="mt-4 rounded-lg border p-3">
              <p className="mb-2 text-xs font-semibold text-gray-600">
                Add Observation
              </p>
              <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
                <input
                  type="datetime-local"
                  value={obs.time}
                  onChange={(e) => setObs({ ...obs, time: e.target.value })}
                  className="rounded-lg border px-3 py-2 text-sm"
                />
                <input
                  type="number"
                  placeholder="FHR (bpm)"
                  value={obs.fetalHeartRate ?? ""}
                  onChange={(e) => setObs({ ...obs, fetalHeartRate: Number(e.target.value) || undefined })}
                  className="rounded-lg border px-3 py-2 text-sm"
                />
                <input
                  type="number"
                  step="0.5"
                  placeholder="Dilation (cm)"
                  value={obs.cervicalDilation ?? ""}
                  onChange={(e) => setObs({ ...obs, cervicalDilation: Number(e.target.value) || undefined })}
                  className="rounded-lg border px-3 py-2 text-sm"
                />
                <input
                  type="number"
                  placeholder="Contractions /10min"
                  value={obs.contractionsPer10Min ?? ""}
                  onChange={(e) => setObs({ ...obs, contractionsPer10Min: Number(e.target.value) || undefined })}
                  className="rounded-lg border px-3 py-2 text-sm"
                />
                <input
                  placeholder="Maternal BP"
                  value={obs.maternalBP ?? ""}
                  onChange={(e) => setObs({ ...obs, maternalBP: e.target.value })}
                  className="rounded-lg border px-3 py-2 text-sm"
                />
                <input
                  type="number"
                  placeholder="Maternal pulse"
                  value={obs.maternalPulse ?? ""}
                  onChange={(e) => setObs({ ...obs, maternalPulse: Number(e.target.value) || undefined })}
                  className="rounded-lg border px-3 py-2 text-sm"
                />
                <input
                  type="number"
                  step="0.1"
                  placeholder="Temp °C"
                  value={obs.temperature ?? ""}
                  onChange={(e) => setObs({ ...obs, temperature: Number(e.target.value) || undefined })}
                  className="rounded-lg border px-3 py-2 text-sm"
                />
                <select
                  value={obs.contractionStrength ?? ""}
                  onChange={(e) => setObs({ ...obs, contractionStrength: e.target.value || undefined })}
                  className="rounded-lg border px-3 py-2 text-sm"
                >
                  <option value="">Strength</option>
                  <option value="MILD">Mild</option>
                  <option value="MODERATE">Moderate</option>
                  <option value="STRONG">Strong</option>
                </select>
              </div>
              <div className="mt-2 flex justify-end gap-2">
                <button
                  onClick={endPg}
                  className="rounded-lg border border-red-300 px-3 py-1 text-xs text-red-700"
                >
                  End Partograph
                </button>
                <button
                  onClick={addObs}
                  className="rounded-lg bg-primary px-3 py-1 text-xs text-white"
                >
                  Add Observation
                </button>
              </div>
            </div>
          )}

          {active.observations.length > 0 && (
            <div className="mt-4 max-h-60 overflow-y-auto">
              <table className="min-w-full text-xs">
                <thead className="sticky top-0 bg-gray-50 text-gray-600">
                  <tr>
                    <th className="px-2 py-1 text-left">Time</th>
                    <th className="px-2 py-1">FHR</th>
                    <th className="px-2 py-1">Dilation</th>
                    <th className="px-2 py-1">Cx /10m</th>
                    <th className="px-2 py-1">BP</th>
                    <th className="px-2 py-1">Pulse</th>
                  </tr>
                </thead>
                <tbody>
                  {active.observations.map((o, i) => (
                    <tr key={i} className="border-t">
                      <td className="px-2 py-1">{o.time}</td>
                      <td className="px-2 py-1 text-center">{o.fetalHeartRate ?? "-"}</td>
                      <td className="px-2 py-1 text-center">{o.cervicalDilation ?? "-"}</td>
                      <td className="px-2 py-1 text-center">{o.contractionsPer10Min ?? "-"}</td>
                      <td className="px-2 py-1 text-center">{o.maternalBP ?? "-"}</td>
                      <td className="px-2 py-1 text-center">{o.maternalPulse ?? "-"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function PartographChart({
  chart,
}: {
  chart: NonNullable<Partograph["chart"]>;
}) {
  const W = 600;
  const H = 260;
  const padL = 40;
  const padR = 20;
  const padT = 20;
  const padB = 30;
  const maxHours = Math.max(
    12,
    ...chart.alertLine.map((a) => a.hour),
    ...chart.dilationSeries.map((d) => d.hoursSinceStart)
  );
  const xScale = (h: number): number => padL + (h / maxHours) * (W - padL - padR);
  const yDilScale = (d: number): number => H - padB - (d / 10) * (H - padT - padB);
  const fhrMin = 60;
  const fhrMax = 200;
  const yFhrScale = (f: number): number =>
    H - padB - ((f - fhrMin) / (fhrMax - fhrMin)) * (H - padT - padB);

  const poly = (pts: Array<{ x: number; y: number }>): string =>
    pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");

  const alertPoints = chart.alertLine.map((a) => ({
    x: xScale(a.hour),
    y: yDilScale(a.dilation),
  }));
  const actionPoints = chart.actionLine.map((a) => ({
    x: xScale(a.hour),
    y: yDilScale(a.dilation),
  }));
  const dilPoints = chart.dilationSeries.map((d) => ({
    x: xScale(d.hoursSinceStart),
    y: yDilScale(d.cervicalDilation),
  }));
  const fhrPoints = chart.fhrSeries.map((f) => ({
    x: xScale(f.hoursSinceStart),
    y: yFhrScale(f.fetalHeartRate),
  }));

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full">
      {/* Grid lines */}
      {[0, 2, 4, 6, 8, 10].map((d) => (
        <line
          key={d}
          x1={padL}
          y1={yDilScale(d)}
          x2={W - padR}
          y2={yDilScale(d)}
          stroke="#eee"
        />
      ))}
      {/* Y labels */}
      {[0, 2, 4, 6, 8, 10].map((d) => (
        <text key={d} x={padL - 6} y={yDilScale(d) + 3} fontSize={9} textAnchor="end" fill="#888">
          {d}cm
        </text>
      ))}
      {/* X labels */}
      {Array.from({ length: Math.ceil(maxHours) + 1 }).map((_, i) => (
        <text
          key={i}
          x={xScale(i)}
          y={H - padB + 12}
          fontSize={9}
          textAnchor="middle"
          fill="#888"
        >
          {i}h
        </text>
      ))}
      {/* Alert line */}
      <polyline points={poly(alertPoints)} fill="none" stroke="#f59e0b" strokeWidth={1.5} strokeDasharray="4,2" />
      {/* Action line */}
      <polyline points={poly(actionPoints)} fill="none" stroke="#dc2626" strokeWidth={1.5} strokeDasharray="4,2" />
      {/* Dilation series */}
      {dilPoints.length > 1 && (
        <polyline points={poly(dilPoints)} fill="none" stroke="#2563eb" strokeWidth={2} />
      )}
      {dilPoints.map((p, i) => (
        <circle key={i} cx={p.x} cy={p.y} r={3} fill="#2563eb" />
      ))}
      {/* FHR series */}
      {fhrPoints.length > 1 && (
        <polyline points={poly(fhrPoints)} fill="none" stroke="#10b981" strokeWidth={1.5} opacity={0.7} />
      )}
      {/* Legend */}
      <g transform={`translate(${W - padR - 140}, ${padT})`}>
        <rect width={140} height={60} fill="white" stroke="#ddd" />
        <line x1={6} y1={12} x2={22} y2={12} stroke="#2563eb" strokeWidth={2} />
        <text x={26} y={15} fontSize={9}>
          Cervical Dilation
        </text>
        <line x1={6} y1={26} x2={22} y2={26} stroke="#f59e0b" strokeDasharray="4,2" />
        <text x={26} y={29} fontSize={9}>
          Alert Line
        </text>
        <line x1={6} y1={40} x2={22} y2={40} stroke="#dc2626" strokeDasharray="4,2" />
        <text x={26} y={43} fontSize={9}>
          Action Line
        </text>
        <line x1={6} y1={54} x2={22} y2={54} stroke="#10b981" />
        <text x={26} y={57} fontSize={9}>
          Fetal HR (60-200)
        </text>
      </g>
    </svg>
  );
}

// ─── ACOG Risk Score Tab ────────────────────────────

interface AcogResult {
  score: number;
  category: string;
  isHighRisk: boolean;
  bmi: number | null;
  ageAtConception: number | null;
  riskFactors: Array<{ factor: string; points: number }>;
}

function AcogRiskTab({
  caseId,
  canEdit,
  onUpdated,
}: {
  caseId: string;
  canEdit: boolean;
  onUpdated: () => void;
}) {
  const [form, setForm] = useState({
    heightCm: "",
    weightKg: "",
    hasPrevCSection: false,
    hasHypertension: false,
    hasDiabetes: false,
    hasPriorGDM: false,
    hasPriorStillbirth: false,
    hasPriorPreterm: false,
    hasPriorComplications: false,
    currentBleeding: false,
    currentPreeclampsia: false,
  });
  const [result, setResult] = useState<AcogResult | null>(null);
  const [loading, setLoading] = useState(false);

  async function calculate() {
    setLoading(true);
    try {
      const payload: Record<string, unknown> = {};
      if (form.heightCm) payload.heightCm = Number(form.heightCm);
      if (form.weightKg) payload.weightKg = Number(form.weightKg);
      for (const k of [
        "hasPrevCSection",
        "hasHypertension",
        "hasDiabetes",
        "hasPriorGDM",
        "hasPriorStillbirth",
        "hasPriorPreterm",
        "hasPriorComplications",
        "currentBleeding",
        "currentPreeclampsia",
      ] as const) {
        if (form[k]) payload[k] = true;
      }
      const res = await api.post<{ data: AcogResult }>(
        `/antenatal/cases/${caseId}/acog-risk-score`,
        payload
      );
      setResult(res.data);
      onUpdated();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    }
    setLoading(false);
  }

  const catColor =
    result?.category === "VERY_HIGH"
      ? "bg-red-100 text-red-800 border-red-300"
      : result?.category === "HIGH"
        ? "bg-orange-100 text-orange-800 border-orange-300"
        : result?.category === "MODERATE"
          ? "bg-amber-100 text-amber-800 border-amber-300"
          : "bg-green-100 text-green-800 border-green-300";

  return (
    <div className="rounded-xl bg-white p-5 shadow-sm">
      <h3 className="mb-4 font-semibold">ACOG-Based Risk Score</h3>
      {canEdit && (
        <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
          <input
            type="number"
            step="0.1"
            placeholder="Height (cm)"
            value={form.heightCm}
            onChange={(e) => setForm({ ...form, heightCm: e.target.value })}
            className="rounded-lg border px-3 py-2 text-sm"
          />
          <input
            type="number"
            step="0.1"
            placeholder="Weight (kg)"
            value={form.weightKg}
            onChange={(e) => setForm({ ...form, weightKg: e.target.value })}
            className="rounded-lg border px-3 py-2 text-sm"
          />
          {[
            { k: "hasPrevCSection", l: "Previous C-section" },
            { k: "hasHypertension", l: "Hypertension" },
            { k: "hasDiabetes", l: "Diabetes / GDM" },
            { k: "hasPriorGDM", l: "Prior GDM" },
            { k: "hasPriorStillbirth", l: "Prior stillbirth" },
            { k: "hasPriorPreterm", l: "Prior preterm" },
            { k: "hasPriorComplications", l: "Prior complications" },
            { k: "currentBleeding", l: "Current bleeding" },
            { k: "currentPreeclampsia", l: "Current pre-eclampsia" },
          ].map((opt) => (
            <label
              key={opt.k}
              className="flex items-center gap-2 rounded-lg border px-3 py-2 text-sm"
            >
              <input
                type="checkbox"
                checked={form[opt.k as keyof typeof form] as boolean}
                onChange={(e) =>
                  setForm({ ...form, [opt.k]: e.target.checked } as typeof form)
                }
              />
              {opt.l}
            </label>
          ))}
        </div>
      )}
      {canEdit && (
        <button
          onClick={calculate}
          disabled={loading}
          className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {loading ? "Calculating..." : "Calculate ACOG Risk Score"}
        </button>
      )}

      {result && (
        <div className="mt-4 space-y-2">
          <div className={`rounded-lg border-l-4 p-4 ${catColor}`}>
            <p className="text-lg font-bold">
              Score: {result.score} · {result.category.replace("_", " ")}
            </p>
            {result.bmi != null && (
              <p className="text-xs">
                BMI: {result.bmi}
                {result.ageAtConception != null && (
                  <> · Age at conception: {result.ageAtConception}</>
                )}
              </p>
            )}
          </div>
          {result.riskFactors.length > 0 && (
            <ul className="space-y-1 text-sm">
              {result.riskFactors.map((r, i) => (
                <li
                  key={i}
                  className="flex justify-between rounded border-l-4 border-gray-300 bg-gray-50 px-3 py-1.5"
                >
                  <span>{r.factor}</span>
                  <span className="font-semibold text-gray-600">+{r.points}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Postnatal Visits Tab ───────────────────────────

interface PostnatalVisit {
  id: string;
  visitDate: string;
  weekPostpartum: number;
  motherBP?: string | null;
  motherWeight?: number | null;
  lochia?: string | null;
  uterineInvolution?: string | null;
  breastfeeding?: string | null;
  babyWeight?: number | null;
  babyJaundice?: boolean;
  notes?: string | null;
}

function PostnatalTab({ caseId, canEdit }: { caseId: string; canEdit: boolean }) {
  const [rows, setRows] = useState<PostnatalVisit[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState({
    weekPostpartum: 1,
    motherBP: "",
    motherWeight: "",
    lochia: "",
    uterineInvolution: "",
    breastfeeding: "",
    babyWeight: "",
    babyJaundice: false,
    notes: "",
  });

  async function load() {
    setLoading(true);
    try {
      const res = await api.get<{ data: PostnatalVisit[] }>(
        `/antenatal/cases/${caseId}/postnatal-visits`
      );
      setRows(res.data);
    } catch {
      setRows([]);
    }
    setLoading(false);
  }

  useEffect(() => {
    load();
  }, [caseId]);

  async function submit() {
    try {
      await api.post(`/antenatal/cases/${caseId}/postnatal-visits`, {
        weekPostpartum: Number(form.weekPostpartum),
        motherBP: form.motherBP || undefined,
        motherWeight: form.motherWeight ? Number(form.motherWeight) : undefined,
        lochia: form.lochia || undefined,
        uterineInvolution: form.uterineInvolution || undefined,
        breastfeeding: form.breastfeeding || undefined,
        babyWeight: form.babyWeight ? Number(form.babyWeight) : undefined,
        babyJaundice: form.babyJaundice,
        notes: form.notes || undefined,
      });
      setForm({
        weekPostpartum: 1,
        motherBP: "",
        motherWeight: "",
        lochia: "",
        uterineInvolution: "",
        breastfeeding: "",
        babyWeight: "",
        babyJaundice: false,
        notes: "",
      });
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    }
  }

  return (
    <div className="rounded-xl bg-white p-5 shadow-sm">
      <h3 className="mb-4 font-semibold">Postnatal Visits</h3>
      {canEdit && (
        <div className="mb-4 rounded-lg border bg-gray-50 p-4">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <input
              type="number"
              min={1}
              max={52}
              placeholder="Week postpartum"
              value={form.weekPostpartum}
              onChange={(e) =>
                setForm({ ...form, weekPostpartum: Number(e.target.value) || 1 })
              }
              className="rounded-lg border px-3 py-2 text-sm"
            />
            <input
              placeholder="Mother BP"
              value={form.motherBP}
              onChange={(e) => setForm({ ...form, motherBP: e.target.value })}
              className="rounded-lg border px-3 py-2 text-sm"
            />
            <input
              type="number"
              step="0.1"
              placeholder="Mother weight (kg)"
              value={form.motherWeight}
              onChange={(e) => setForm({ ...form, motherWeight: e.target.value })}
              className="rounded-lg border px-3 py-2 text-sm"
            />
            <select
              value={form.lochia}
              onChange={(e) => setForm({ ...form, lochia: e.target.value })}
              className="rounded-lg border px-3 py-2 text-sm"
            >
              <option value="">Lochia</option>
              <option value="NORMAL">Normal</option>
              <option value="HEAVY">Heavy</option>
              <option value="ABSENT">Absent</option>
              <option value="ABNORMAL_COLOR">Abnormal color</option>
            </select>
            <select
              value={form.uterineInvolution}
              onChange={(e) =>
                setForm({ ...form, uterineInvolution: e.target.value })
              }
              className="rounded-lg border px-3 py-2 text-sm"
            >
              <option value="">Uterine involution</option>
              <option value="NORMAL">Normal</option>
              <option value="DELAYED">Delayed</option>
            </select>
            <select
              value={form.breastfeeding}
              onChange={(e) =>
                setForm({ ...form, breastfeeding: e.target.value })
              }
              className="rounded-lg border px-3 py-2 text-sm"
            >
              <option value="">Breastfeeding</option>
              <option value="EXCLUSIVE">Exclusive</option>
              <option value="MIXED">Mixed</option>
              <option value="NONE">None</option>
            </select>
            <input
              type="number"
              step="0.1"
              placeholder="Baby weight (kg)"
              value={form.babyWeight}
              onChange={(e) => setForm({ ...form, babyWeight: e.target.value })}
              className="rounded-lg border px-3 py-2 text-sm"
            />
            <label className="flex items-center gap-2 rounded-lg border px-3 py-2 text-sm">
              <input
                type="checkbox"
                checked={form.babyJaundice}
                onChange={(e) => setForm({ ...form, babyJaundice: e.target.checked })}
              />
              Baby jaundice
            </label>
          </div>
          <textarea
            rows={2}
            placeholder="Notes"
            value={form.notes}
            onChange={(e) => setForm({ ...form, notes: e.target.value })}
            className="mt-2 w-full rounded-lg border px-3 py-2 text-sm"
          />
          <div className="mt-2 flex justify-end">
            <button
              onClick={submit}
              className="rounded-lg bg-primary px-3 py-1 text-xs text-white"
            >
              Record Visit
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <p className="text-sm text-gray-500">Loading...</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-gray-500">No postnatal visits recorded.</p>
      ) : (
        <div className="space-y-2">
          {rows.map((v) => (
            <div key={v.id} className="rounded-lg border p-3 text-sm">
              <div className="flex items-center justify-between">
                <p className="font-medium">
                  Week {v.weekPostpartum} · {new Date(v.visitDate).toLocaleDateString()}
                </p>
                {v.babyJaundice && (
                  <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-700">
                    Jaundice
                  </span>
                )}
              </div>
              <div className="mt-1 grid grid-cols-2 gap-x-4 text-xs text-gray-600 md:grid-cols-4">
                {v.motherBP && <p>Mother BP: {v.motherBP}</p>}
                {v.motherWeight != null && <p>Mother wt: {v.motherWeight} kg</p>}
                {v.lochia && <p>Lochia: {v.lochia}</p>}
                {v.uterineInvolution && <p>Uterus: {v.uterineInvolution}</p>}
                {v.breastfeeding && <p>Feeding: {v.breastfeeding}</p>}
                {v.babyWeight != null && <p>Baby wt: {v.babyWeight} kg</p>}
              </div>
              {v.notes && <p className="mt-1 text-xs italic text-gray-500">{v.notes}</p>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
