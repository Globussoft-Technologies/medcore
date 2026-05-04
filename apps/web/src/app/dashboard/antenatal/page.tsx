"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import { useAuthStore } from "@/lib/store";
import { Plus, AlertTriangle, Baby, Calendar, Activity } from "lucide-react";
// Issue #57 (Apr 2026): blood-group select uses the canonical 8 ABO+Rh
// tokens shared with the blood-bank module so cross-match warnings work.
import {
  ALL_BLOOD_GROUPS,
  prettyBloodGroup,
} from "@medcore/shared";

interface AncVisit {
  id: string;
  visitDate: string;
  weeksOfGestation?: number | null;
  nextVisitDate?: string | null;
}

interface AncCase {
  id: string;
  caseNumber: string;
  patientId: string;
  doctorId: string;
  lmpDate: string;
  eddDate: string;
  gravida: number;
  parity: number;
  isHighRisk: boolean;
  riskFactors?: string | null;
  deliveredAt?: string | null;
  deliveryType?: string | null;
  patient: { id: string; mrNumber?: string; user: { name: string; phone?: string } };
  doctor: { id: string; user: { name: string } };
  visits: AncVisit[];
}

interface DashboardData {
  activeCases: number;
  highRiskCases: number;
  upcomingDeliveries: number;
  overdueDeliveries: number;
  visitsDueThisWeek: Array<{
    id: string;
    caseNumber: string;
    patient: { user: { name: string } };
    visits: AncVisit[];
  }>;
}

interface PatientSearchResult {
  id: string;
  mrNumber: string;
  gender: string;
  user: { name: string; phone: string };
}

interface Doctor {
  id: string;
  user: { name: string };
  specialization: string;
}

type Tab = "active" | "highRisk" | "delivered" | "all";

export default function AntenatalPage() {
  const { user } = useAuthStore();
  const [cases, setCases] = useState<AncCase[]>([]);
  const [dashboard, setDashboard] = useState<DashboardData | null>(null);
  const [tab, setTab] = useState<Tab>("active");
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);

  const [patientSearch, setPatientSearch] = useState("");
  const [patientResults, setPatientResults] = useState<PatientSearchResult[]>([]);
  const [selectedPatient, setSelectedPatient] = useState<PatientSearchResult | null>(null);
  const [doctors, setDoctors] = useState<Doctor[]>([]);
  const [form, setForm] = useState({
    doctorId: "",
    lmpDate: "",
    gravida: "1",
    parity: "0",
    bloodGroup: "",
    isHighRisk: false,
    riskFactors: "",
  });

  // Issue #459 (A5 RBAC drift, May 2026): NURSE is allowed server-side
  // (`POST /antenatal/cases` accepts ADMIN, DOCTOR, NURSE — see
  // antenatal.ts:191) and antenatal is a nurse-led workflow in most clinics
  // (visit recording, partograph, postnatal). The UI was hiding the "New
  // case" CTA from a high-volume clinical role; align with server intent.
  const canCreate =
    user?.role === "DOCTOR" || user?.role === "ADMIN" || user?.role === "NURSE";

  useEffect(() => {
    loadCases();
    loadDashboard();
  }, [tab]);

  useEffect(() => {
    if (showModal) loadDoctors();
  }, [showModal]);

  useEffect(() => {
    if (patientSearch.length < 2) {
      setPatientResults([]);
      return;
    }
    const t = setTimeout(() => searchPatients(patientSearch), 300);
    return () => clearTimeout(t);
  }, [patientSearch]);

  async function loadCases() {
    setLoading(true);
    try {
      let qs = "";
      if (tab === "active") qs = "?delivered=false";
      else if (tab === "highRisk") qs = "?isHighRisk=true&delivered=false";
      else if (tab === "delivered") qs = "?delivered=true";
      const res = await api.get<{ data: AncCase[] }>(`/antenatal/cases${qs}`);
      setCases(res.data);
    } catch {
      // empty
    }
    setLoading(false);
  }

  async function loadDashboard() {
    try {
      const res = await api.get<{ data: DashboardData }>("/antenatal/dashboard");
      setDashboard(res.data);
    } catch {
      // empty
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

  async function searchPatients(q: string) {
    try {
      const res = await api.get<{ data: PatientSearchResult[] }>(
        `/patients?search=${encodeURIComponent(q)}&limit=10`
      );
      // filter only female patients
      setPatientResults(res.data.filter((p) => p.gender === "FEMALE"));
    } catch {
      setPatientResults([]);
    }
  }

  // Issue #57: HTML date input `max` for the LMP field — local YYYY-MM-DD
  // form, computed once per render so a stale string can't slip through.
  const todayIso = (() => {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  })();

  async function submitCase(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedPatient) {
      toast.error("Select a patient");
      return;
    }
    // Issue #57: client-side parity with the zod refine — block future LMPs
    // before the API rejects them.
    if (form.lmpDate && form.lmpDate > todayIso) {
      toast.error("Last Menstrual Period date cannot be in the future");
      return;
    }
    const gravidaN = parseInt(form.gravida, 10);
    const parityN = parseInt(form.parity, 10);
    if (!Number.isFinite(gravidaN) || gravidaN < 1) {
      toast.error("Gravida must be at least 1");
      return;
    }
    if (!Number.isFinite(parityN) || parityN < 0) {
      toast.error("Parity cannot be negative");
      return;
    }
    try {
      await api.post("/antenatal/cases", {
        patientId: selectedPatient.id,
        doctorId: form.doctorId,
        lmpDate: form.lmpDate,
        gravida: parseInt(form.gravida) || 1,
        parity: parseInt(form.parity) || 0,
        bloodGroup: form.bloodGroup || undefined,
        isHighRisk: form.isHighRisk,
        riskFactors: form.riskFactors || undefined,
      });
      setShowModal(false);
      setSelectedPatient(null);
      setPatientSearch("");
      setForm({
        doctorId: "",
        lmpDate: "",
        gravida: "1",
        parity: "0",
        bloodGroup: "",
        isHighRisk: false,
        riskFactors: "",
      });
      loadCases();
      loadDashboard();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create ANC case");
    }
  }

  function weeksBetween(a: Date, b: Date): number {
    return Math.round((b.getTime() - a.getTime()) / (7 * 24 * 60 * 60 * 1000));
  }

  function daysUntil(dateStr: string): number {
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    const d = new Date(dateStr);
    d.setHours(0, 0, 0, 0);
    return Math.round((d.getTime() - now.getTime()) / (24 * 60 * 60 * 1000));
  }

  function weeksGestation(lmpDate: string): number {
    return weeksBetween(new Date(lmpDate), new Date());
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
          <h1 className="text-2xl font-bold">Antenatal Care</h1>
          <p className="text-sm text-gray-500">
            Pregnancy monitoring and maternity management
          </p>
        </div>
        {canCreate && (
          <button
            onClick={() => setShowModal(true)}
            className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark"
          >
            <Plus size={16} /> New ANC Case
          </button>
        )}
      </div>

      {/* Stats */}
      {dashboard && (
        <div className="mb-6 grid grid-cols-1 gap-4 md:grid-cols-4">
          <div className="rounded-xl bg-white p-5 shadow-sm">
            <div className="flex items-center gap-3">
              <div className="rounded-lg bg-blue-100 p-2 text-blue-700">
                <Baby size={20} />
              </div>
              <div>
                <p className="text-xs text-gray-500">Active Cases</p>
                <p className="text-2xl font-bold">{dashboard.activeCases}</p>
              </div>
            </div>
          </div>
          <div className="rounded-xl bg-white p-5 shadow-sm">
            <div className="flex items-center gap-3">
              <div className="rounded-lg bg-red-100 p-2 text-red-700">
                <AlertTriangle size={20} />
              </div>
              <div>
                <p className="text-xs text-gray-500">High Risk</p>
                <p className="text-2xl font-bold">{dashboard.highRiskCases}</p>
              </div>
            </div>
          </div>
          <div className="rounded-xl bg-white p-5 shadow-sm">
            <div className="flex items-center gap-3">
              <div className="rounded-lg bg-green-100 p-2 text-green-700">
                <Calendar size={20} />
              </div>
              <div>
                <p className="text-xs text-gray-500">Upcoming Deliveries (30d)</p>
                <p className="text-2xl font-bold">{dashboard.upcomingDeliveries}</p>
              </div>
            </div>
          </div>
          <div className="rounded-xl bg-white p-5 shadow-sm">
            <div className="flex items-center gap-3">
              <div className="rounded-lg bg-amber-100 p-2 text-amber-700">
                <Activity size={20} />
              </div>
              <div>
                <p className="text-xs text-gray-500">Overdue Deliveries</p>
                <p className="text-2xl font-bold">{dashboard.overdueDeliveries}</p>
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="mb-4 flex gap-2">
        <button onClick={() => setTab("active")} className={tabClasses("active")}>
          Active
        </button>
        <button onClick={() => setTab("highRisk")} className={tabClasses("highRisk")}>
          High Risk
        </button>
        <button onClick={() => setTab("delivered")} className={tabClasses("delivered")}>
          Delivered
        </button>
        <button onClick={() => setTab("all")} className={tabClasses("all")}>
          All
        </button>
      </div>

      <div className="rounded-xl bg-white shadow-sm">
        {loading ? (
          <div className="p-8 text-center text-gray-500">Loading...</div>
        ) : cases.length === 0 ? (
          <div className="p-8 text-center text-gray-500">No ANC cases found.</div>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="border-b text-left text-sm text-gray-500">
                <th className="px-4 py-3">Case #</th>
                <th className="px-4 py-3">Patient</th>
                <th className="px-4 py-3">EDD</th>
                <th className="px-4 py-3">G / P</th>
                <th className="px-4 py-3">Weeks</th>
                <th className="px-4 py-3">Risk</th>
                <th className="px-4 py-3">Last Visit</th>
                <th className="px-4 py-3">Action</th>
              </tr>
            </thead>
            <tbody>
              {cases.map((c) => {
                const lastVisit = c.visits?.[0];
                const daysToEdd = daysUntil(c.eddDate);
                const weeks = weeksGestation(c.lmpDate);
                return (
                  <tr key={c.id} className="border-b last:border-0">
                    <td className="px-4 py-3 font-medium">{c.caseNumber}</td>
                    <td className="px-4 py-3">
                      <Link
                        href={`/dashboard/antenatal/${c.id}`}
                        className="font-medium text-primary hover:underline"
                      >
                        {c.patient.user.name}
                      </Link>
                      <p className="text-xs text-gray-500">{c.patient.mrNumber}</p>
                    </td>
                    <td className="px-4 py-3 text-sm">
                      {new Date(c.eddDate).toLocaleDateString()}
                      {!c.deliveredAt && (
                        <p
                          className={`text-xs ${
                            daysToEdd < 0 ? "text-red-600" : "text-gray-500"
                          }`}
                        >
                          {daysToEdd < 0
                            ? `${Math.abs(daysToEdd)}d overdue`
                            : `${daysToEdd}d to go`}
                        </p>
                      )}
                    </td>
                    <td className="px-4 py-3 text-sm">
                      G{c.gravida} P{c.parity}
                    </td>
                    <td className="px-4 py-3 text-sm">
                      {c.deliveredAt ? "—" : `${weeks}w`}
                    </td>
                    <td className="px-4 py-3">
                      {c.isHighRisk ? (
                        <span className="rounded-full bg-red-100 px-2.5 py-0.5 text-xs font-medium text-red-700">
                          High Risk
                        </span>
                      ) : (
                        <span className="rounded-full bg-green-100 px-2.5 py-0.5 text-xs font-medium text-green-700">
                          Normal
                        </span>
                      )}
                      {c.deliveredAt && (
                        <span className="ml-1 rounded-full bg-blue-100 px-2.5 py-0.5 text-xs font-medium text-blue-700">
                          Delivered
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-sm">
                      {lastVisit
                        ? new Date(lastVisit.visitDate).toLocaleDateString()
                        : "—"}
                    </td>
                    <td className="px-4 py-3">
                      <Link
                        href={`/dashboard/antenatal/${c.id}`}
                        className="rounded bg-primary px-2 py-1 text-xs text-white hover:bg-primary-dark"
                      >
                        View
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <form
            onSubmit={submitCase}
            className="w-full max-w-2xl rounded-2xl bg-white p-6 shadow-xl"
          >
            <h2 className="mb-4 text-lg font-semibold">New Antenatal Case</h2>

            <div className="space-y-4">
              <div>
                <label className="mb-1 block text-sm font-medium">
                  Patient (female only) <span className="text-red-600" aria-hidden="true">*</span>
                </label>
                {selectedPatient ? (
                  <div
                    data-testid="anc-patient-selected"
                    className="flex items-center justify-between rounded-lg border bg-gray-50 px-3 py-2 text-sm"
                  >
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
                      className="text-xs text-red-600"
                    >
                      Change
                    </button>
                  </div>
                ) : (
                  <>
                    <input
                      // Issue #171 (Apr 2026): patient picker is required —
                      // without a selected patient the case is an orphan.
                      // We can't put `required` on a search field that
                      // becomes hidden once the choice is made, so we
                      // rely on `aria-required` for AT + the
                      // submitCase() guard for actual blocking.
                      aria-required="true"
                      data-testid="anc-patient-search"
                      placeholder="Search by name or MR number (required)"
                      value={patientSearch}
                      onChange={(e) => setPatientSearch(e.target.value)}
                      className="w-full rounded-lg border px-3 py-2 text-sm"
                    />
                    {patientResults.length > 0 && (
                      <div className="mt-1 max-h-40 overflow-y-auto rounded-lg border bg-white shadow-sm">
                        {patientResults.map((p) => (
                          <button
                            key={p.id}
                            type="button"
                            onClick={() => {
                              setSelectedPatient(p);
                              setPatientResults([]);
                            }}
                            className="block w-full px-3 py-2 text-left text-sm hover:bg-gray-50"
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

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="mb-1 block text-sm font-medium">Doctor</label>
                  <select
                    required
                    value={form.doctorId}
                    onChange={(e) => setForm({ ...form, doctorId: e.target.value })}
                    className="w-full rounded-lg border px-3 py-2 text-sm"
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
                  <label className="mb-1 block text-sm font-medium">LMP Date</label>
                  <input
                    type="date"
                    required
                    // Issue #57: LMP must be in the past — set max to today.
                    max={todayIso}
                    data-testid="anc-lmp-date"
                    value={form.lmpDate}
                    onChange={(e) => setForm({ ...form, lmpDate: e.target.value })}
                    className="w-full rounded-lg border px-3 py-2 text-sm"
                  />
                </div>
              </div>

              <div className="grid grid-cols-3 gap-4">
                <div>
                  <label className="mb-1 block text-sm font-medium">Gravida</label>
                  <input
                    type="number"
                    // Issue #57: gravida is a positive int (min 1 — case row
                    // implies an active pregnancy). Step=1 disables decimals.
                    min={1}
                    step={1}
                    data-testid="anc-gravida"
                    value={form.gravida}
                    onChange={(e) => setForm({ ...form, gravida: e.target.value })}
                    className="w-full rounded-lg border px-3 py-2 text-sm"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-sm font-medium">Parity</label>
                  <input
                    type="number"
                    // Issue #57: parity is a non-negative int (a primigravida
                    // has parity 0).
                    min={0}
                    step={1}
                    data-testid="anc-parity"
                    value={form.parity}
                    onChange={(e) => setForm({ ...form, parity: e.target.value })}
                    className="w-full rounded-lg border px-3 py-2 text-sm"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-sm font-medium">Blood Group</label>
                  {/* Issue #57: replace free-text input with the canonical
                      ABO+Rh select so the value joins the blood-bank tables. */}
                  <select
                    data-testid="anc-blood-group"
                    value={form.bloodGroup}
                    onChange={(e) =>
                      setForm({ ...form, bloodGroup: e.target.value })
                    }
                    className="w-full rounded-lg border px-3 py-2 text-sm"
                  >
                    <option value="">Unknown</option>
                    {ALL_BLOOD_GROUPS.map((g) => (
                      <option key={g} value={g}>
                        {prettyBloodGroup(g)}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={form.isHighRisk}
                    onChange={(e) =>
                      setForm({ ...form, isHighRisk: e.target.checked })
                    }
                  />
                  Mark as High Risk Pregnancy
                </label>
              </div>

              {form.isHighRisk && (
                <div>
                  <label className="mb-1 block text-sm font-medium">
                    Risk Factors
                  </label>
                  <textarea
                    value={form.riskFactors}
                    onChange={(e) =>
                      setForm({ ...form, riskFactors: e.target.value })
                    }
                    rows={2}
                    placeholder="e.g. Hypertension, Previous C-section, Diabetes"
                    className="w-full rounded-lg border px-3 py-2 text-sm"
                  />
                </div>
              )}
            </div>

            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowModal(false)}
                className="rounded-lg border px-4 py-2 text-sm"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark"
              >
                Create ANC Case
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
