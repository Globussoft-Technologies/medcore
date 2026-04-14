"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";

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
    temperatureUnit: "F" as "F" | "C",
    weight: "",
    height: "",
    pulseRate: "",
    spO2: "",
    respiratoryRate: "",
    painScale: "",
    notes: "",
  });
  const [saving, setSaving] = useState(false);

  // ── Derived: BMI + abnormal flags ─────────────────────
  const weightKg = form.weight ? parseFloat(form.weight) : NaN;
  const heightCm = form.height ? parseFloat(form.height) : NaN;
  const bmi =
    !isNaN(weightKg) && !isNaN(heightCm) && heightCm > 0
      ? Math.round((weightKg / Math.pow(heightCm / 100, 2)) * 10) / 10
      : null;
  const bmiCategory =
    bmi === null
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

    setSaving(true);
    try {
      await api.post(`/patients/${selectedPatient.patientId}/vitals`, {
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

      alert(
        flags.length > 0
          ? `Vitals saved (Abnormal: ${flags.join(", ")})`
          : "Vitals saved!"
      );
      setSelectedPatient(null);
      setForm({
        bloodPressureSystolic: "",
        bloodPressureDiastolic: "",
        temperature: "",
        temperatureUnit: "F",
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
      alert(err instanceof Error ? err.message : "Failed to save vitals");
    }
    setSaving(false);
  }

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="mb-6 text-2xl font-bold">Record Vitals</h1>

      {/* Doctor selection */}
      <div className="mb-6 grid grid-cols-3 gap-2">
        {doctors.map((d) => (
          <button
            key={d.id}
            onClick={() => {
              setSelectedDoctor(d.id);
              loadQueue(d.id);
            }}
            className={`rounded-lg border-2 p-3 text-left text-sm ${
              selectedDoctor === d.id
                ? "border-primary bg-blue-50"
                : "border-gray-200 hover:border-gray-300"
            }`}
          >
            <p className="font-medium">{d.user.name}</p>
            <p className="text-xs text-gray-500">{d.specialization}</p>
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
            <form onSubmit={saveVitals} className="rounded-xl bg-white p-6 shadow-sm">
              <h2 className="mb-4 font-semibold">
                Vitals — Token #{selectedPatient.tokenNumber} ({selectedPatient.patientName})
              </h2>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="mb-1 block text-sm font-medium">
                    BP Systolic (mmHg)
                  </label>
                  <input
                    type="number"
                    value={form.bloodPressureSystolic}
                    onChange={(e) =>
                      setForm({ ...form, bloodPressureSystolic: e.target.value })
                    }
                    className="w-full rounded-lg border px-3 py-2 text-sm"
                    placeholder="120"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-sm font-medium">
                    BP Diastolic (mmHg)
                  </label>
                  <input
                    type="number"
                    value={form.bloodPressureDiastolic}
                    onChange={(e) =>
                      setForm({ ...form, bloodPressureDiastolic: e.target.value })
                    }
                    className="w-full rounded-lg border px-3 py-2 text-sm"
                    placeholder="80"
                  />
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
                    value={form.temperature}
                    onChange={(e) =>
                      setForm({ ...form, temperature: e.target.value })
                    }
                    className="w-full rounded-lg border px-3 py-2 text-sm"
                    placeholder={form.temperatureUnit === "F" ? "98.6" : "37.0"}
                  />
                </div>
                <div>
                  <label className="mb-1 block text-sm font-medium">
                    Pulse Rate (bpm)
                  </label>
                  <input
                    type="number"
                    value={form.pulseRate}
                    onChange={(e) =>
                      setForm({ ...form, pulseRate: e.target.value })
                    }
                    className="w-full rounded-lg border px-3 py-2 text-sm"
                    placeholder="72"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-sm font-medium">
                    SpO2 (%)
                  </label>
                  <input
                    type="number"
                    value={form.spO2}
                    onChange={(e) =>
                      setForm({ ...form, spO2: e.target.value })
                    }
                    className="w-full rounded-lg border px-3 py-2 text-sm"
                    placeholder="98"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-sm font-medium">
                    Weight (kg)
                  </label>
                  <input
                    type="number"
                    step="0.1"
                    value={form.weight}
                    onChange={(e) =>
                      setForm({ ...form, weight: e.target.value })
                    }
                    className="w-full rounded-lg border px-3 py-2 text-sm"
                    placeholder="70"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-sm font-medium">
                    Height (cm)
                  </label>
                  <input
                    type="number"
                    step="0.1"
                    value={form.height}
                    onChange={(e) =>
                      setForm({ ...form, height: e.target.value })
                    }
                    className="w-full rounded-lg border px-3 py-2 text-sm"
                    placeholder="170"
                  />
                </div>
              </div>

              <div className="mt-4 grid grid-cols-2 gap-4">
                <div>
                  <label className="mb-1 block text-sm font-medium">
                    Respiratory Rate (/min)
                  </label>
                  <input
                    type="number"
                    value={form.respiratoryRate}
                    onChange={(e) =>
                      setForm({ ...form, respiratoryRate: e.target.value })
                    }
                    className="w-full rounded-lg border px-3 py-2 text-sm"
                    placeholder="16"
                  />
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
                disabled={saving}
                className="mt-4 w-full rounded-lg bg-secondary py-2.5 font-medium text-white hover:bg-green-700 disabled:opacity-50"
              >
                {saving ? "Saving..." : "Save Vitals"}
              </button>
            </form>
          ) : (
            <div className="flex h-64 items-center justify-center rounded-xl bg-white text-gray-400 shadow-sm">
              Select a patient to record vitals
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
