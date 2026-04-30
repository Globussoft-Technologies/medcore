"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import { extractFieldErrors, type FieldErrorMap } from "@/lib/field-errors";

// Issue #91 (Apr 2026): clinically sensible ranges, mirrored from
// packages/shared/src/validation/patient.ts VITALS_RANGES.
const RANGE = {
  bloodPressureSystolic: { min: 60, max: 260, label: "BP Systolic", unit: "mmHg" },
  bloodPressureDiastolic: { min: 30, max: 180, label: "BP Diastolic", unit: "mmHg" },
  temperatureF: { min: 90, max: 110, label: "Temperature", unit: "°F" },
  temperatureC: { min: 32, max: 43, label: "Temperature", unit: "°C" },
  pulseRate: { min: 30, max: 220, label: "Pulse", unit: "bpm" },
  spO2: { min: 50, max: 100, label: "SpO2", unit: "%" },
  weight: { min: 0.5, max: 300, label: "Weight", unit: "kg" },
  height: { min: 20, max: 250, label: "Height", unit: "cm" },
  respiratoryRate: { min: 5, max: 80, label: "Respiratory rate", unit: "/min" },
} as const;

function rangeError(
  raw: string,
  bounds: { min: number; max: number; unit: string },
  isInt = false
): string | null {
  if (!raw) return null;
  const n = isInt ? parseInt(raw, 10) : parseFloat(raw);
  if (Number.isNaN(n)) return "Enter a number";
  if (n < bounds.min || n > bounds.max) {
    return `Must be ${bounds.min}–${bounds.max} ${bounds.unit}`;
  }
  return null;
}

interface QueuePatient {
  tokenNumber: number;
  patientName: string;
  patientId: string;
  appointmentId: string;
  status: string;
  hasVitals: boolean;
}

interface Doctor {
  id: string;
  user: { name: string };
  specialization: string;
}

export default function VitalsPage() {
  const [doctors, setDoctors] = useState<Doctor[]>([]);
  const [selectedDoctor, setSelectedDoctor] = useState("");
  const [queue, setQueue] = useState<QueuePatient[]>([]);
  const [selectedPatient, setSelectedPatient] = useState<QueuePatient | null>(null);
  const [form, setForm] = useState({
    bloodPressureSystolic: "",
    bloodPressureDiastolic: "",
    temperature: "",
    // Default to Celsius — Indian clinical practice uses C, and the form
    // previously rejected typed values like 36.8 because the unit defaulted
    // to F (36.8°F is below the schema's 90°F floor). Issue #418.
    temperatureUnit: "C" as "F" | "C",
    weight: "",
    height: "",
    pulseRate: "",
    spO2: "",
    respiratoryRate: "",
    painScale: "",
    notes: "",
  });
  const [saving, setSaving] = useState(false);
  const [serverFieldErrors, setServerFieldErrors] = useState<FieldErrorMap>({});

  // Patient baseline + last-recorded change summary
  const [baseline, setBaseline] = useState<{
    bpSystolic?: { baseline: number | null; sampleSize: number };
    bpDiastolic?: { baseline: number | null; sampleSize: number };
    pulse?: { baseline: number | null; sampleSize: number };
    spO2?: { baseline: number | null; sampleSize: number };
    temperature?: { baseline: number | null; sampleSize: number };
    respiratoryRate?: { baseline: number | null; sampleSize: number };
  } | null>(null);
  const [changeSummary, setChangeSummary] = useState<
    Array<{
      field: string;
      previous: number | null;
      current: number | null;
      delta: number | null;
      significant: boolean;
    }>
  >([]);

  useEffect(() => {
    if (!selectedPatient) {
      setBaseline(null);
      return;
    }
    api
      .get<{ data: typeof baseline }>(
        `/patients/${selectedPatient.patientId}/vitals-baseline`
      )
      .then((r) => setBaseline(r.data))
      .catch(() => setBaseline(null));
  }, [selectedPatient]);

  function baselineDeviation(
    field: "bpSystolic" | "bpDiastolic" | "pulse" | "spO2",
    value: number
  ): boolean {
    const b = baseline?.[field]?.baseline;
    if (typeof b !== "number" || b === 0) return false;
    return Math.abs((value - b) / b) > 0.2;
  }

  // ── Derived: BMI + abnormal flags ─────────────────────
  const weightKg = form.weight ? parseFloat(form.weight) : NaN;
  const heightCm = form.height ? parseFloat(form.height) : NaN;
  const bmi =
    !isNaN(weightKg) && !isNaN(heightCm) && heightCm > 0
      ? Math.round((weightKg / Math.pow(heightCm / 100, 2)) * 10) / 10
      : null;
  // Issue #196: BMI categories (Underweight/Normal/Overweight/Obese) only
  // apply to ages 2+. For infants and toddlers, BMI is meaningless — clinicians
  // use weight-for-age and length-for-age curves instead. Suppress the
  // category for plausible infant inputs (weight under ~10 kg AND length
  // under ~90 cm). The numeric BMI itself can still display but without a
  // misleading "Underweight" label.
  const looksInfant =
    !isNaN(weightKg) && !isNaN(heightCm) && weightKg < 10 && heightCm < 90;
  const bmiCategory =
    bmi === null || looksInfant
      ? null
      : bmi < 18.5
        ? "Underweight"
        : bmi < 25
          ? "Normal"
          : bmi < 30
            ? "Overweight"
            : "Obese";

  const flags: string[] = [];
  const sys = form.bloodPressureSystolic ? parseInt(form.bloodPressureSystolic) : NaN;
  const dia = form.bloodPressureDiastolic ? parseInt(form.bloodPressureDiastolic) : NaN;
  if (!isNaN(sys) && sys >= 140) flags.push("High BP");
  if (!isNaN(sys) && sys < 90) flags.push("Low BP");
  if (!isNaN(dia) && dia >= 90) flags.push("High Diastolic");
  const spo2 = form.spO2 ? parseInt(form.spO2) : NaN;
  if (!isNaN(spo2) && spo2 < 95) flags.push("Low SpO2");
  const pulse = form.pulseRate ? parseInt(form.pulseRate) : NaN;
  if (!isNaN(pulse) && pulse > 100) flags.push("Tachycardia");
  if (!isNaN(pulse) && pulse < 50) flags.push("Bradycardia");
  const tempNum = form.temperature ? parseFloat(form.temperature) : NaN;
  const tempF =
    !isNaN(tempNum) ? (form.temperatureUnit === "C" ? tempNum * 9 / 5 + 32 : tempNum) : NaN;
  if (!isNaN(tempF) && tempF >= 100.4) flags.push("Fever");
  if (!isNaN(tempF) && tempF < 95) flags.push("Hypothermia");

  // ── Issue #91: client-side range validation (mirrors API) ─────────────
  const tempBounds =
    form.temperatureUnit === "C" ? RANGE.temperatureC : RANGE.temperatureF;
  // Issue #419 — give temperature a single canonical error string regardless
  // of unit so QA / regression tests can assert one message; the °F vs °C
  // bounds still differ but the user-visible copy is uniform.
  const tempRangeMessage =
    form.temperature && rangeError(form.temperature, tempBounds)
      ? "Temperature out of physiological range"
      : "";
  const clientErrors: FieldErrorMap = {
    bloodPressureSystolic:
      rangeError(form.bloodPressureSystolic, RANGE.bloodPressureSystolic, true) ?? "",
    bloodPressureDiastolic:
      rangeError(form.bloodPressureDiastolic, RANGE.bloodPressureDiastolic, true) ?? "",
    temperature: tempRangeMessage,
    pulseRate: rangeError(form.pulseRate, RANGE.pulseRate, true) ?? "",
    spO2: rangeError(form.spO2, RANGE.spO2, true) ?? "",
    weight: rangeError(form.weight, RANGE.weight) ?? "",
    height: rangeError(form.height, RANGE.height) ?? "",
    respiratoryRate: rangeError(form.respiratoryRate, RANGE.respiratoryRate, true) ?? "",
  };
  // Cross-check: diastolic must not exceed systolic when both filled.
  if (
    !isNaN(sys) &&
    !isNaN(dia) &&
    !clientErrors.bloodPressureSystolic &&
    !clientErrors.bloodPressureDiastolic &&
    dia >= sys
  ) {
    clientErrors.bloodPressureDiastolic = "Diastolic must be lower than systolic";
  }
  const fieldErrors: FieldErrorMap = {};
  for (const [k, v] of Object.entries(clientErrors)) if (v) fieldErrors[k] = v;
  // Server errors take precedence so the user sees what the API rejected.
  for (const [k, v] of Object.entries(serverFieldErrors)) fieldErrors[k] = v;
  const hasFieldErrors = Object.keys(fieldErrors).length > 0;

  // ── Issue #91: critical-vitals banner trigger ─────────────────────────
  // Show an in-DOM red banner (above the form) whenever any of:
  //   SpO2 < 90, temp > 102.5°F, pulse < 40 or > 150, systolic > 200.
  const criticalReasons: string[] = [];
  if (!isNaN(spo2) && spo2 > 0 && spo2 < 90)
    criticalReasons.push(`SpO2 ${spo2}% (critical < 90)`);
  if (!isNaN(tempF) && tempF > 102.5)
    criticalReasons.push(`Temp ${tempF.toFixed(1)}°F (high fever > 102.5)`);
  if (!isNaN(pulse) && pulse > 0 && pulse < 40)
    criticalReasons.push(`Pulse ${pulse} bpm (critical bradycardia < 40)`);
  if (!isNaN(pulse) && pulse > 150)
    criticalReasons.push(`Pulse ${pulse} bpm (critical tachycardia > 150)`);
  if (!isNaN(sys) && sys > 200)
    criticalReasons.push(`Systolic ${sys} mmHg (hypertensive crisis > 200)`);

  useEffect(() => {
    api
      .get<{ data: Doctor[] }>("/doctors")
      .then((r) => setDoctors(r.data))
      .catch(() => {});
  }, []);

  async function loadQueue(doctorId: string) {
    try {
      const today = new Date().toISOString().split("T")[0];
      const res = await api.get<{
        data: { queue: QueuePatient[] };
      }>(`/queue/${doctorId}?date=${today}`);
      setQueue(
        res.data.queue.filter(
          (q) => !q.hasVitals && q.status !== "COMPLETED" && q.status !== "CANCELLED"
        )
      );
    } catch {
      setQueue([]);
    }
  }

  async function saveVitals(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedPatient) return;

    // Block submit if any client-side range errors. The fieldErrors map
    // already merges client + last-server messages, so the user can see them
    // below each field without us re-toasting.
    if (hasFieldErrors) {
      toast.error("Please fix the highlighted vitals before saving");
      return;
    }

    setSaving(true);
    setServerFieldErrors({});
    try {
      const res = await api.post<{
        data: {
          changes?: Array<{
            field: string;
            previous: number | null;
            current: number | null;
            delta: number | null;
            significant: boolean;
          }>;
        };
      }>(`/patients/${selectedPatient.patientId}/vitals`, {
        appointmentId: selectedPatient.appointmentId,
        patientId: selectedPatient.patientId,
        bloodPressureSystolic: form.bloodPressureSystolic
          ? parseInt(form.bloodPressureSystolic)
          : undefined,
        bloodPressureDiastolic: form.bloodPressureDiastolic
          ? parseInt(form.bloodPressureDiastolic)
          : undefined,
        temperature: form.temperature
          ? parseFloat(form.temperature)
          : undefined,
        temperatureUnit: form.temperatureUnit,
        weight: form.weight ? parseFloat(form.weight) : undefined,
        height: form.height ? parseFloat(form.height) : undefined,
        pulseRate: form.pulseRate ? parseInt(form.pulseRate) : undefined,
        spO2: form.spO2 ? parseInt(form.spO2) : undefined,
        respiratoryRate: form.respiratoryRate
          ? parseInt(form.respiratoryRate)
          : undefined,
        painScale: form.painScale ? parseInt(form.painScale) : undefined,
        notes: form.notes || undefined,
      });

      setChangeSummary(res.data.changes ?? []);

      if (flags.length > 0) {
        toast.warning(`Vitals saved (Abnormal: ${flags.join(", ")})`);
      } else {
        toast.success("Vitals saved");
      }
      // Keep summary visible briefly
      setTimeout(() => setSelectedPatient(null), 1500);
      setForm({
        bloodPressureSystolic: "",
        bloodPressureDiastolic: "",
        temperature: "",
        temperatureUnit: "C",
        weight: "",
        height: "",
        pulseRate: "",
        spO2: "",
        respiratoryRate: "",
        painScale: "",
        notes: "",
      });
      if (selectedDoctor) loadQueue(selectedDoctor);
    } catch (err) {
      const fields = extractFieldErrors(err);
      if (fields) {
        setServerFieldErrors(fields);
        const first = Object.values(fields)[0];
        toast.error(first || "Please fix the highlighted vitals");
      } else {
        toast.error(err instanceof Error ? err.message : "Failed to save vitals");
      }
    }
    setSaving(false);
  }

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="mb-6 text-2xl font-bold text-gray-900 dark:text-gray-100">Record Vitals</h1>

      {/* Doctor selection */}
      <div className="mb-6 grid grid-cols-3 gap-2">
        {doctors.map((d) => (
          <button
            key={d.id}
            onClick={() => {
              setSelectedDoctor(d.id);
              loadQueue(d.id);
            }}
            className={`rounded-lg border-2 p-3 text-left text-sm text-gray-900 dark:text-gray-100 ${
              selectedDoctor === d.id
                ? "border-primary bg-blue-50 dark:border-blue-400 dark:bg-blue-900/30"
                : "border-gray-200 hover:border-gray-300 dark:border-gray-700 dark:hover:border-gray-500"
            }`}
          >
            <p className="font-medium">{d.user.name}</p>
            <p className="text-xs text-gray-500 dark:text-gray-400">{d.specialization}</p>
          </button>
        ))}
      </div>

      <div className="grid grid-cols-3 gap-4">
        {/* Patient queue (no vitals yet) */}
        <div className="col-span-1">
          <h2 className="mb-3 font-semibold">Awaiting Vitals</h2>
          {queue.length === 0 ? (
            <p className="text-sm text-gray-500">
              {selectedDoctor
                ? "All patients have vitals"
                : "Select a doctor"}
            </p>
          ) : (
            <div className="space-y-2">
              {queue.map((p) => (
                <button
                  key={p.appointmentId}
                  onClick={() => setSelectedPatient(p)}
                  className={`w-full rounded-lg border-2 p-3 text-left ${
                    selectedPatient?.appointmentId === p.appointmentId
                      ? "border-primary bg-blue-50"
                      : "border-gray-200"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span className="flex h-7 w-7 items-center justify-center rounded-full bg-primary text-xs font-bold text-white">
                      {p.tokenNumber}
                    </span>
                    <span className="text-sm font-medium">{p.patientName}</span>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Vitals form */}
        <div className="col-span-2">
          {selectedPatient ? (
            <form onSubmit={saveVitals} className="rounded-xl bg-white p-6 text-gray-900 shadow-sm dark:bg-gray-800 dark:text-gray-100">
              <h2 className="mb-4 font-semibold">
                Vitals — Token #{selectedPatient.tokenNumber} ({selectedPatient.patientName})
              </h2>

              {baseline && (
                <div className="mb-4 rounded-lg bg-blue-50 p-3 text-xs text-blue-900">
                  <p className="mb-1 font-semibold">Patient Baseline (median of non-abnormal readings)</p>
                  <p>
                    BP: {baseline.bpSystolic?.baseline ?? "—"}/
                    {baseline.bpDiastolic?.baseline ?? "—"} · Pulse:{" "}
                    {baseline.pulse?.baseline ?? "—"} · SpO2:{" "}
                    {baseline.spO2?.baseline ?? "—"} (n=
                    {baseline.bpSystolic?.sampleSize ?? 0})
                  </p>
                </div>
              )}

              {changeSummary.length > 0 &&
                changeSummary.some((c) => c.significant) && (
                  <div className="mb-4 rounded-lg bg-amber-50 p-3 text-xs text-amber-900">
                    <p className="mb-1 font-semibold">Sudden changes vs last 24h reading</p>
                    {changeSummary
                      .filter((c) => c.significant)
                      .map((c) => (
                        <p key={c.field}>
                          {c.field}: {c.previous} → {c.current} (Δ{c.delta})
                        </p>
                      ))}
                  </div>
                )}

              {/* Critical-vitals banner — Issue #91 */}
              {criticalReasons.length > 0 && (
                <div
                  data-testid="critical-vitals-banner"
                  role="alert"
                  className="mb-4 rounded-lg border-l-4 border-red-600 bg-red-50 p-3 text-sm text-red-900"
                >
                  <p className="mb-1 font-semibold">
                    Critical vitals — escalate immediately
                  </p>
                  <ul className="list-disc pl-5 text-xs">
                    {criticalReasons.map((r) => (
                      <li key={r}>{r}</li>
                    ))}
                  </ul>
                  <p className="mt-1 text-xs italic">
                    Notify the attending doctor before the patient leaves the
                    triage area.
                  </p>
                </div>
              )}

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="mb-1 block text-sm font-medium">
                    BP Systolic (mmHg)
                    {baseline?.bpSystolic?.baseline != null && (
                      <span className="ml-2 text-xs font-normal text-gray-400">
                        baseline {baseline.bpSystolic.baseline}
                      </span>
                    )}
                  </label>
                  <input
                    type="number"
                    data-testid="vitals-bp-systolic"
                    aria-invalid={!!fieldErrors.bloodPressureSystolic}
                    min={RANGE.bloodPressureSystolic.min}
                    max={RANGE.bloodPressureSystolic.max}
                    value={form.bloodPressureSystolic}
                    onChange={(e) => {
                      setForm({ ...form, bloodPressureSystolic: e.target.value });
                      if (serverFieldErrors.bloodPressureSystolic)
                        setServerFieldErrors((p) => {
                          const n = { ...p };
                          delete n.bloodPressureSystolic;
                          return n;
                        });
                    }}
                    className={`w-full rounded-lg border px-3 py-2 text-sm ${
                      fieldErrors.bloodPressureSystolic
                        ? "border-red-500 bg-red-50"
                        : form.bloodPressureSystolic &&
                            baselineDeviation(
                              "bpSystolic",
                              parseFloat(form.bloodPressureSystolic)
                            )
                          ? "border-red-400 bg-red-50"
                          : ""
                    }`}
                    placeholder="120"
                  />
                  {fieldErrors.bloodPressureSystolic && (
                    <p
                      data-testid="error-bp-systolic"
                      className="mt-1 text-xs text-red-600"
                    >
                      {fieldErrors.bloodPressureSystolic}
                    </p>
                  )}
                </div>
                <div>
                  <label className="mb-1 block text-sm font-medium">
                    BP Diastolic (mmHg)
                    {baseline?.bpDiastolic?.baseline != null && (
                      <span className="ml-2 text-xs font-normal text-gray-400">
                        baseline {baseline.bpDiastolic.baseline}
                      </span>
                    )}
                  </label>
                  <input
                    type="number"
                    data-testid="vitals-bp-diastolic"
                    aria-invalid={!!fieldErrors.bloodPressureDiastolic}
                    min={RANGE.bloodPressureDiastolic.min}
                    max={RANGE.bloodPressureDiastolic.max}
                    value={form.bloodPressureDiastolic}
                    onChange={(e) => {
                      setForm({ ...form, bloodPressureDiastolic: e.target.value });
                      if (serverFieldErrors.bloodPressureDiastolic)
                        setServerFieldErrors((p) => {
                          const n = { ...p };
                          delete n.bloodPressureDiastolic;
                          return n;
                        });
                    }}
                    className={`w-full rounded-lg border px-3 py-2 text-sm ${
                      fieldErrors.bloodPressureDiastolic
                        ? "border-red-500 bg-red-50"
                        : form.bloodPressureDiastolic &&
                            baselineDeviation(
                              "bpDiastolic",
                              parseFloat(form.bloodPressureDiastolic)
                            )
                          ? "border-red-400 bg-red-50"
                          : ""
                    }`}
                    placeholder="80"
                  />
                  {fieldErrors.bloodPressureDiastolic && (
                    <p
                      data-testid="error-bp-diastolic"
                      className="mt-1 text-xs text-red-600"
                    >
                      {fieldErrors.bloodPressureDiastolic}
                    </p>
                  )}
                </div>
                <div>
                  <label className="mb-1 flex items-center justify-between text-sm font-medium">
                    <span>Temperature</span>
                    <div className="flex gap-1 text-xs">
                      <button
                        type="button"
                        onClick={() => setForm({ ...form, temperatureUnit: "F" })}
                        className={`rounded px-1.5 py-0.5 ${
                          form.temperatureUnit === "F"
                            ? "bg-primary text-white"
                            : "bg-gray-100 text-gray-600"
                        }`}
                      >
                        °F
                      </button>
                      <button
                        type="button"
                        onClick={() => setForm({ ...form, temperatureUnit: "C" })}
                        className={`rounded px-1.5 py-0.5 ${
                          form.temperatureUnit === "C"
                            ? "bg-primary text-white"
                            : "bg-gray-100 text-gray-600"
                        }`}
                      >
                        °C
                      </button>
                    </div>
                  </label>
                  <input
                    type="number"
                    step="0.1"
                    data-testid="vitals-temperature"
                    aria-invalid={!!fieldErrors.temperature}
                    min={tempBounds.min}
                    max={tempBounds.max}
                    value={form.temperature}
                    onChange={(e) => {
                      setForm({ ...form, temperature: e.target.value });
                      if (serverFieldErrors.temperature)
                        setServerFieldErrors((p) => {
                          const n = { ...p };
                          delete n.temperature;
                          return n;
                        });
                    }}
                    className={`w-full rounded-lg border px-3 py-2 text-sm ${
                      fieldErrors.temperature ? "border-red-500 bg-red-50" : ""
                    }`}
                    placeholder={form.temperatureUnit === "F" ? "98.6" : "37.0"}
                  />
                  {fieldErrors.temperature && (
                    <p
                      data-testid="error-temperature"
                      className="mt-1 text-xs text-red-600"
                    >
                      {fieldErrors.temperature}
                    </p>
                  )}
                </div>
                <div>
                  <label className="mb-1 block text-sm font-medium">
                    Pulse Rate (bpm)
                  </label>
                  <input
                    type="number"
                    data-testid="vitals-pulse"
                    aria-invalid={!!fieldErrors.pulseRate}
                    min={RANGE.pulseRate.min}
                    max={RANGE.pulseRate.max}
                    value={form.pulseRate}
                    onChange={(e) => {
                      setForm({ ...form, pulseRate: e.target.value });
                      if (serverFieldErrors.pulseRate)
                        setServerFieldErrors((p) => {
                          const n = { ...p };
                          delete n.pulseRate;
                          return n;
                        });
                    }}
                    className={`w-full rounded-lg border px-3 py-2 text-sm ${
                      fieldErrors.pulseRate ? "border-red-500 bg-red-50" : ""
                    }`}
                    placeholder="72"
                  />
                  {fieldErrors.pulseRate && (
                    <p
                      data-testid="error-pulse"
                      className="mt-1 text-xs text-red-600"
                    >
                      {fieldErrors.pulseRate}
                    </p>
                  )}
                </div>
                <div>
                  <label className="mb-1 block text-sm font-medium">
                    SpO2 (%)
                  </label>
                  <input
                    type="number"
                    data-testid="vitals-spo2"
                    aria-invalid={!!fieldErrors.spO2}
                    min={RANGE.spO2.min}
                    max={RANGE.spO2.max}
                    value={form.spO2}
                    onChange={(e) => {
                      setForm({ ...form, spO2: e.target.value });
                      if (serverFieldErrors.spO2)
                        setServerFieldErrors((p) => {
                          const n = { ...p };
                          delete n.spO2;
                          return n;
                        });
                    }}
                    className={`w-full rounded-lg border px-3 py-2 text-sm ${
                      fieldErrors.spO2 ? "border-red-500 bg-red-50" : ""
                    }`}
                    placeholder="98"
                  />
                  {fieldErrors.spO2 && (
                    <p
                      data-testid="error-spo2"
                      className="mt-1 text-xs text-red-600"
                    >
                      {fieldErrors.spO2}
                    </p>
                  )}
                </div>
                <div>
                  <label className="mb-1 block text-sm font-medium">
                    Weight (kg)
                  </label>
                  <input
                    type="number"
                    step="0.1"
                    data-testid="vitals-weight"
                    aria-invalid={!!fieldErrors.weight}
                    min={RANGE.weight.min}
                    max={RANGE.weight.max}
                    value={form.weight}
                    onChange={(e) => {
                      setForm({ ...form, weight: e.target.value });
                      if (serverFieldErrors.weight)
                        setServerFieldErrors((p) => {
                          const n = { ...p };
                          delete n.weight;
                          return n;
                        });
                    }}
                    className={`w-full rounded-lg border px-3 py-2 text-sm ${
                      fieldErrors.weight ? "border-red-500 bg-red-50" : ""
                    }`}
                    placeholder="70"
                  />
                  {fieldErrors.weight && (
                    <p
                      data-testid="error-weight"
                      className="mt-1 text-xs text-red-600"
                    >
                      {fieldErrors.weight}
                    </p>
                  )}
                </div>
                <div>
                  <label className="mb-1 block text-sm font-medium">
                    Height (cm)
                  </label>
                  <input
                    type="number"
                    step="0.1"
                    data-testid="vitals-height"
                    aria-invalid={!!fieldErrors.height}
                    min={RANGE.height.min}
                    max={RANGE.height.max}
                    value={form.height}
                    onChange={(e) => {
                      setForm({ ...form, height: e.target.value });
                      if (serverFieldErrors.height)
                        setServerFieldErrors((p) => {
                          const n = { ...p };
                          delete n.height;
                          return n;
                        });
                    }}
                    className={`w-full rounded-lg border px-3 py-2 text-sm ${
                      fieldErrors.height ? "border-red-500 bg-red-50" : ""
                    }`}
                    placeholder="170"
                  />
                  {fieldErrors.height && (
                    <p
                      data-testid="error-height"
                      className="mt-1 text-xs text-red-600"
                    >
                      {fieldErrors.height}
                    </p>
                  )}
                </div>
              </div>

              <div className="mt-4 grid grid-cols-2 gap-4">
                <div>
                  <label className="mb-1 block text-sm font-medium">
                    Respiratory Rate (/min)
                  </label>
                  <input
                    type="number"
                    data-testid="vitals-resp-rate"
                    aria-invalid={!!fieldErrors.respiratoryRate}
                    min={RANGE.respiratoryRate.min}
                    max={RANGE.respiratoryRate.max}
                    value={form.respiratoryRate}
                    onChange={(e) => {
                      setForm({ ...form, respiratoryRate: e.target.value });
                      if (serverFieldErrors.respiratoryRate)
                        setServerFieldErrors((p) => {
                          const n = { ...p };
                          delete n.respiratoryRate;
                          return n;
                        });
                    }}
                    className={`w-full rounded-lg border px-3 py-2 text-sm ${
                      fieldErrors.respiratoryRate ? "border-red-500 bg-red-50" : ""
                    }`}
                    placeholder="16"
                  />
                  {fieldErrors.respiratoryRate && (
                    <p
                      data-testid="error-resp-rate"
                      className="mt-1 text-xs text-red-600"
                    >
                      {fieldErrors.respiratoryRate}
                    </p>
                  )}
                </div>
                <div>
                  <label className="mb-1 block text-sm font-medium">
                    Pain Scale (0-10)
                  </label>
                  <div className="flex gap-1">
                    {Array.from({ length: 11 }).map((_, i) => (
                      <button
                        type="button"
                        key={i}
                        onClick={() =>
                          setForm({ ...form, painScale: String(i) })
                        }
                        className={`h-8 flex-1 rounded-md text-xs font-medium ${
                          form.painScale === String(i)
                            ? i >= 7
                              ? "bg-danger text-white"
                              : i >= 4
                                ? "bg-amber-500 text-white"
                                : "bg-secondary text-white"
                            : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                        }`}
                      >
                        {i}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {/* Derived: BMI + Abnormal flags */}
              {(bmi !== null || flags.length > 0) && (
                <div className="mt-4 grid grid-cols-2 gap-3">
                  {bmi !== null && (
                    <div className="rounded-lg bg-blue-50 p-3 text-sm">
                      <div className="text-xs text-gray-500">BMI</div>
                      <div className="font-semibold">
                        {bmi}{" "}
                        <span className="text-xs font-normal text-gray-600">
                          ({bmiCategory})
                        </span>
                      </div>
                    </div>
                  )}
                  {flags.length > 0 && (
                    <div className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
                      <div className="text-xs text-amber-600">
                        Abnormal Findings
                      </div>
                      <div className="font-semibold">{flags.join(", ")}</div>
                    </div>
                  )}
                </div>
              )}

              <div className="mt-4">
                <label className="mb-1 block text-sm font-medium">Notes</label>
                <textarea
                  value={form.notes}
                  onChange={(e) => setForm({ ...form, notes: e.target.value })}
                  className="w-full rounded-lg border px-3 py-2 text-sm"
                  rows={2}
                  placeholder="Any additional observations..."
                />
              </div>

              <button
                type="submit"
                data-testid="save-vitals-btn"
                disabled={saving || hasFieldErrors}
                className="mt-4 w-full rounded-lg bg-secondary py-2.5 font-medium text-white hover:bg-green-700 disabled:opacity-50"
              >
                {saving ? "Saving..." : "Save Vitals"}
              </button>
            </form>
          ) : (
            <div className="flex h-64 items-center justify-center rounded-xl bg-white text-gray-400 shadow-sm dark:bg-gray-800 dark:text-gray-500">
              Select a patient to record vitals
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
