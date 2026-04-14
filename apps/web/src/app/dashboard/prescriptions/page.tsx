"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useAuthStore } from "@/lib/store";
import { FREQUENCY_OPTIONS } from "@medcore/shared";

interface PrescriptionRecord {
  id: string;
  diagnosis: string;
  advice: string | null;
  followUpDate: string | null;
  createdAt: string;
  printed?: boolean;
  sharedVia?: string | null;
  items: Array<{
    id?: string;
    medicineName: string;
    dosage: string;
    frequency: string;
    duration: string;
    instructions: string | null;
    refills?: number;
    refillsUsed?: number;
  }>;
  doctor: { user: { name: string } };
  patient: { user: { name: string; phone: string } };
}

interface Template {
  id: string;
  name: string;
  diagnosis: string;
  advice: string | null;
  items: Array<{
    medicineName: string;
    dosage: string;
    frequency: string;
    duration: string;
    instructions?: string;
  }>;
}

export default function PrescriptionsPage() {
  const { user } = useAuthStore();
  const [prescriptions, setPrescriptions] = useState<PrescriptionRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  // Form state
  const [form, setForm] = useState({
    appointmentId: "",
    patientId: "",
    diagnosis: "",
    advice: "",
    followUpDate: "",
  });
  const [medicines, setMedicines] = useState([
    { medicineName: "", dosage: "", frequency: "", duration: "", instructions: "" },
  ]);

  const [templates, setTemplates] = useState<Template[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState("");

  // Drug interaction warning state
  interface InteractionWarning {
    drugA: string;
    drugB: string;
    severity: string;
    description: string;
    source: string;
  }
  const [interactionWarnings, setInteractionWarnings] = useState<InteractionWarning[]>([]);
  const [showInteractionModal, setShowInteractionModal] = useState(false);
  const [checkingInteractions, setCheckingInteractions] = useState(false);

  useEffect(() => {
    loadPrescriptions();
    api
      .get<{ data: Template[] }>("/prescriptions/templates/list")
      .then((r) => setTemplates(r.data))
      .catch(() => {});
  }, []);

  function applyTemplate(tplId: string) {
    const tpl = templates.find((t) => t.id === tplId);
    if (!tpl) return;
    setForm((f) => ({
      ...f,
      diagnosis: tpl.diagnosis,
      advice: tpl.advice ?? "",
    }));
    setMedicines(
      tpl.items.map((i) => ({
        medicineName: i.medicineName,
        dosage: i.dosage,
        frequency: i.frequency,
        duration: i.duration,
        instructions: i.instructions ?? "",
      }))
    );
  }

  async function markPrinted(id: string) {
    try {
      await api.post(`/prescriptions/${id}/print`, {});
      // Open printable view
      window.open(`/api/v1/prescriptions/${id}/pdf`, "_blank");
      loadPrescriptions();
    } catch {
      /* noop */
    }
  }

  async function shareVia(id: string, channel: "WHATSAPP" | "EMAIL" | "SMS") {
    try {
      await api.post(`/prescriptions/${id}/share`, { channel });
      alert(`Prescription shared via ${channel}`);
      loadPrescriptions();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to share");
    }
  }

  async function loadPrescriptions() {
    setLoading(true);
    try {
      const res = await api.get<{ data: PrescriptionRecord[] }>(
        "/prescriptions?limit=50"
      );
      setPrescriptions(res.data);
    } catch {
      // empty
    }
    setLoading(false);
  }

  function addMedicine() {
    setMedicines([
      ...medicines,
      { medicineName: "", dosage: "", frequency: "", duration: "", instructions: "" },
    ]);
  }

  function removeMedicine(idx: number) {
    setMedicines(medicines.filter((_, i) => i !== idx));
  }

  function updateMedicine(idx: number, field: string, value: string) {
    const updated = [...medicines];
    (updated[idx] as Record<string, string>)[field] = value;
    setMedicines(updated);
  }

  async function submitPrescription(override: boolean) {
    try {
      await api.post("/prescriptions", {
        appointmentId: form.appointmentId,
        patientId: form.patientId,
        diagnosis: form.diagnosis,
        items: medicines.filter((m) => m.medicineName),
        advice: form.advice || undefined,
        followUpDate: form.followUpDate || undefined,
        overrideWarnings: override,
      });
      setShowForm(false);
      setShowInteractionModal(false);
      setInteractionWarnings([]);
      setForm({ appointmentId: "", patientId: "", diagnosis: "", advice: "", followUpDate: "" });
      setMedicines([{ medicineName: "", dosage: "", frequency: "", duration: "", instructions: "" }]);
      loadPrescriptions();
    } catch (err) {
      const anyErr = err as Error & { payload?: { warnings?: InteractionWarning[]; error?: string } };
      if (anyErr.payload?.warnings && anyErr.payload.warnings.length > 0) {
        setInteractionWarnings(anyErr.payload.warnings);
        setShowInteractionModal(true);
        return;
      }
      alert(err instanceof Error ? err.message : "Failed to create prescription");
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.patientId) return;
    const items = medicines.filter((m) => m.medicineName);
    if (items.length === 0) {
      alert("Add at least one medicine");
      return;
    }
    // Preview interaction check before saving
    setCheckingInteractions(true);
    try {
      const preview = await api.post<{
        data: { warnings: InteractionWarning[]; hasBlocking: boolean };
      }>("/prescriptions/check-interactions", {
        patientId: form.patientId,
        items,
      });
      setCheckingInteractions(false);
      if (preview.data.hasBlocking) {
        setInteractionWarnings(preview.data.warnings);
        setShowInteractionModal(true);
        return;
      }
      // Non-blocking: proceed; warnings (if any) will still be returned in response
      await submitPrescription(false);
    } catch (err) {
      setCheckingInteractions(false);
      // If preview itself fails, fall back to normal POST
      await submitPrescription(false);
    }
  }

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold">Prescriptions</h1>
        {user?.role === "DOCTOR" && (
          <button
            onClick={() => setShowForm(!showForm)}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark"
          >
            Write Prescription
          </button>
        )}
      </div>

      {/* Prescription form */}
      {showForm && (
        <form
          onSubmit={handleSubmit}
          className="mb-6 rounded-xl bg-white p-6 shadow-sm"
        >
          <h2 className="mb-4 font-semibold">New Prescription</h2>

          {templates.length > 0 && (
            <div className="mb-4 flex items-center gap-2 rounded-lg bg-blue-50 p-3">
              <label className="text-sm font-medium">Use Template:</label>
              <select
                value={selectedTemplateId}
                onChange={(e) => {
                  setSelectedTemplateId(e.target.value);
                  if (e.target.value) applyTemplate(e.target.value);
                }}
                className="flex-1 rounded border px-2 py-1 text-sm"
              >
                <option value="">— Select a template —</option>
                {templates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div className="mb-4 grid grid-cols-2 gap-4">
            <input
              required
              placeholder="Appointment ID"
              value={form.appointmentId}
              onChange={(e) => setForm({ ...form, appointmentId: e.target.value })}
              className="rounded-lg border px-3 py-2 text-sm"
            />
            <input
              required
              placeholder="Patient ID"
              value={form.patientId}
              onChange={(e) => setForm({ ...form, patientId: e.target.value })}
              className="rounded-lg border px-3 py-2 text-sm"
            />
            <input
              required
              placeholder="Diagnosis"
              value={form.diagnosis}
              onChange={(e) => setForm({ ...form, diagnosis: e.target.value })}
              className="col-span-2 rounded-lg border px-3 py-2 text-sm"
            />
          </div>

          {/* Medicines */}
          <div className="mb-4">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-sm font-medium">Medicines</p>
              <button
                type="button"
                onClick={addMedicine}
                className="text-sm font-medium text-primary"
              >
                + Add Medicine
              </button>
            </div>
            {medicines.map((med, idx) => (
              <div
                key={idx}
                className="mb-2 grid grid-cols-6 gap-2 rounded-lg border bg-gray-50 p-3"
              >
                <input
                  placeholder="Medicine name"
                  value={med.medicineName}
                  onChange={(e) => updateMedicine(idx, "medicineName", e.target.value)}
                  className="col-span-2 rounded border px-2 py-1.5 text-sm"
                />
                <input
                  placeholder="Dosage"
                  value={med.dosage}
                  onChange={(e) => updateMedicine(idx, "dosage", e.target.value)}
                  className="rounded border px-2 py-1.5 text-sm"
                />
                <select
                  value={med.frequency}
                  onChange={(e) => updateMedicine(idx, "frequency", e.target.value)}
                  className="rounded border px-2 py-1.5 text-sm"
                >
                  <option value="">Frequency</option>
                  {FREQUENCY_OPTIONS.map((f) => (
                    <option key={f} value={f}>
                      {f}
                    </option>
                  ))}
                </select>
                <input
                  placeholder="Duration"
                  value={med.duration}
                  onChange={(e) => updateMedicine(idx, "duration", e.target.value)}
                  className="rounded border px-2 py-1.5 text-sm"
                />
                <button
                  type="button"
                  onClick={() => removeMedicine(idx)}
                  className="text-sm text-red-500"
                >
                  Remove
                </button>
              </div>
            ))}
          </div>

          <div className="mb-4 grid grid-cols-2 gap-4">
            <textarea
              placeholder="Advice / Notes"
              value={form.advice}
              onChange={(e) => setForm({ ...form, advice: e.target.value })}
              className="rounded-lg border px-3 py-2 text-sm"
              rows={2}
            />
            <div>
              <label className="mb-1 block text-sm">Follow-up Date</label>
              <input
                type="date"
                value={form.followUpDate}
                onChange={(e) => setForm({ ...form, followUpDate: e.target.value })}
                className="w-full rounded-lg border px-3 py-2 text-sm"
              />
            </div>
          </div>

          <div className="flex gap-2">
            <button
              type="submit"
              className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white"
            >
              Save Prescription
            </button>
            <button
              type="button"
              onClick={() => setShowForm(false)}
              className="rounded-lg border px-4 py-2 text-sm"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {/* Prescriptions list */}
      <div className="space-y-3">
        {loading ? (
          <div className="rounded-xl bg-white p-8 text-center text-gray-500">
            Loading...
          </div>
        ) : prescriptions.length === 0 ? (
          <div className="rounded-xl bg-white p-8 text-center text-gray-500">
            No prescriptions found
          </div>
        ) : (
          prescriptions.map((rx) => (
            <div key={rx.id} className="rounded-xl bg-white p-4 shadow-sm">
              <button
                onClick={() =>
                  setExpanded(expanded === rx.id ? null : rx.id)
                }
                className="w-full text-left"
              >
                <div className="flex items-center justify-between">
                  <div>
                    <p className="font-medium">{rx.patient.user.name}</p>
                    <p className="text-sm text-gray-500">
                      Diagnosis: {rx.diagnosis}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-sm font-medium">
                      {rx.doctor.user.name}
                    </p>
                    <p className="text-xs text-gray-500">
                      {new Date(rx.createdAt).toLocaleDateString("en-IN")}
                    </p>
                  </div>
                </div>
              </button>

              {expanded === rx.id && (
                <div className="mt-4 border-t pt-4">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-gray-500">
                        <th className="pb-2">Medicine</th>
                        <th className="pb-2">Dosage</th>
                        <th className="pb-2">Frequency</th>
                        <th className="pb-2">Duration</th>
                        <th className="pb-2">Instructions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rx.items.map((item, i) => (
                        <tr key={i} className="border-t">
                          <td className="py-2 font-medium">
                            {item.medicineName}
                          </td>
                          <td className="py-2">{item.dosage}</td>
                          <td className="py-2">{item.frequency}</td>
                          <td className="py-2">{item.duration}</td>
                          <td className="py-2 text-gray-500">
                            {item.instructions || "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {rx.advice && (
                    <p className="mt-3 text-sm">
                      <span className="font-medium">Advice:</span> {rx.advice}
                    </p>
                  )}
                  {rx.followUpDate && (
                    <p className="mt-1 text-sm">
                      <span className="font-medium">Follow-up:</span>{" "}
                      {new Date(rx.followUpDate).toLocaleDateString("en-IN")}
                    </p>
                  )}
                  <div className="mt-4 flex flex-wrap gap-2">
                    <button
                      onClick={() => markPrinted(rx.id)}
                      className="rounded-lg border px-3 py-1.5 text-xs hover:bg-gray-50"
                    >
                      {rx.printed ? "Re-Print" : "Print"}
                    </button>
                    <button
                      onClick={() => shareVia(rx.id, "WHATSAPP")}
                      className="rounded-lg border px-3 py-1.5 text-xs text-green-700 hover:bg-green-50"
                    >
                      Share via WhatsApp
                    </button>
                    <button
                      onClick={() => shareVia(rx.id, "EMAIL")}
                      className="rounded-lg border px-3 py-1.5 text-xs text-blue-700 hover:bg-blue-50"
                    >
                      Share via Email
                    </button>
                    {rx.sharedVia && (
                      <span className="ml-auto self-center text-xs text-gray-500">
                        Shared: {rx.sharedVia}
                      </span>
                    )}
                  </div>
                </div>
              )}
            </div>
          ))
        )}
      </div>

      {/* Drug Interaction Alert Modal */}
      {showInteractionModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-2xl overflow-hidden rounded-xl bg-white shadow-xl">
            <div className="border-b border-red-200 bg-red-50 px-6 py-4">
              <h2 className="text-lg font-semibold text-red-800">
                Drug Interaction Warning
              </h2>
              <p className="mt-1 text-sm text-red-700">
                The following interactions were detected between the prescribed medicines and the patient&apos;s active medications:
              </p>
            </div>
            <div className="max-h-[50vh] overflow-y-auto p-6">
              <ul className="space-y-3">
                {interactionWarnings.map((w, i) => (
                  <li
                    key={i}
                    className={`rounded-lg border-l-4 p-3 ${
                      w.severity === "CONTRAINDICATED" || w.severity === "SEVERE"
                        ? "border-red-500 bg-red-50"
                        : w.severity === "MODERATE"
                        ? "border-orange-400 bg-orange-50"
                        : "border-yellow-400 bg-yellow-50"
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-medium">
                        {w.drugA} ↔ {w.drugB}
                      </span>
                      <span
                        className={`rounded px-2 py-0.5 text-xs font-semibold ${
                          w.severity === "CONTRAINDICATED" || w.severity === "SEVERE"
                            ? "bg-red-600 text-white"
                            : w.severity === "MODERATE"
                            ? "bg-orange-500 text-white"
                            : "bg-yellow-500 text-white"
                        }`}
                      >
                        {w.severity}
                      </span>
                    </div>
                    <p className="mt-1 text-sm text-gray-700">{w.description}</p>
                    <p className="mt-0.5 text-xs text-gray-500">
                      {w.source === "NEW_VS_NEW"
                        ? "Both medicines in this prescription"
                        : "Patient already on one of these"}
                    </p>
                  </li>
                ))}
              </ul>
            </div>
            <div className="flex items-center justify-end gap-3 border-t bg-gray-50 px-6 py-4">
              <button
                onClick={() => setShowInteractionModal(false)}
                className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                Cancel and revise
              </button>
              <button
                onClick={() => submitPrescription(true)}
                className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700"
              >
                Override and continue
              </button>
            </div>
          </div>
        </div>
      )}

      {checkingInteractions && (
        <div className="fixed bottom-6 right-6 rounded-lg bg-blue-600 px-4 py-2 text-sm text-white shadow-lg">
          Checking drug interactions...
        </div>
      )}
    </div>
  );
}
