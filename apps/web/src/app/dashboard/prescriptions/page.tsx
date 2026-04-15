"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useAuthStore } from "@/lib/store";
import { useTranslation } from "@/lib/i18n";
import { FREQUENCY_OPTIONS } from "@medcore/shared";
import { toast } from "@/lib/toast";
import { InfoIcon } from "@/components/Tooltip";
import { Autocomplete } from "@/components/Autocomplete";
import { EmptyState } from "@/components/EmptyState";
import { FileText } from "lucide-react";

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
  const { t } = useTranslation();
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

  // Generic substitution
  interface GenericAlt {
    id: string;
    name: string;
    brand?: string | null;
    strength?: string | null;
    form?: string | null;
    availableStock: number;
    sellingPrice: number | null;
    savingsVsBrand: number | null;
  }
  const [genericRowIdx, setGenericRowIdx] = useState<number | null>(null);
  const [renalDoseRow, setRenalDoseRow] = useState<number | null>(null);
  const [genericData, setGenericData] = useState<{
    base: { id: string; name: string; brand?: string | null };
    basePrice: number | null;
    alternatives: GenericAlt[];
  } | null>(null);
  const [genericLoading, setGenericLoading] = useState(false);

  // Inline form errors
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});

  async function openGenericsModal(idx: number, medicineName: string) {
    setGenericRowIdx(idx);
    setGenericData(null);
    setGenericLoading(true);
    try {
      // First resolve medicine by autocomplete
      const ac = await api.get<{ data: Array<{ id: string; name: string }> }>(
        `/medicines/search/autocomplete?q=${encodeURIComponent(medicineName)}`
      );
      const match = (ac.data ?? []).find(
        (m) => m.name.toLowerCase() === medicineName.toLowerCase()
      );
      if (!match) {
        toast.error("Could not resolve medicine for substitution lookup");
        return;
      }
      const resp = await api.get<{ data: typeof genericData }>(
        `/medicines/${match.id}/generics`
      );
      setGenericData(resp.data ?? null);
    } catch (e) {
      console.error(e);
    } finally {
      setGenericLoading(false);
    }
  }

  // Patient renal function banner
  interface RenalStatus {
    crClMlPerMin: number | null;
    ckdStage: string | null;
    latestCreatinine: { value: number; reportedAt: string } | null;
  }
  const [renalStatus, setRenalStatus] = useState<RenalStatus | null>(null);
  useEffect(() => {
    if (!form.patientId) {
      setRenalStatus(null);
      return;
    }
    (async () => {
      try {
        const resp = await api.get<{ data: RenalStatus }>(
          `/patients/${form.patientId}/renal-function`
        );
        setRenalStatus(resp.data ?? null);
      } catch (e) {
        console.error(e);
      }
    })();
  }, [form.patientId]);

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
      toast.success(`Prescription shared via ${channel}`);
      loadPrescriptions();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to share");
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
      toast.error(err instanceof Error ? err.message : "Failed to create prescription");
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (!form.appointmentId) errs.appointmentId = "Appointment ID is required";
    if (!form.patientId) errs.patientId = "Select a patient before saving";
    if (!form.diagnosis) errs.diagnosis = "Diagnosis is required (ICD-10 recommended)";
    const items = medicines.filter((m) => m.medicineName.trim());
    if (items.length === 0) {
      errs.medicines = "Add at least one medicine with a name";
    } else {
      const bad = items.find((m) => !m.dosage.trim() || !m.frequency.trim());
      if (bad) errs.medicines = "Each medicine needs a dosage and frequency";
    }
    setFormErrors(errs);
    if (Object.keys(errs).length > 0) {
      toast.warning("Please fix the highlighted fields");
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
        <h1 className="text-2xl font-bold">{t("dashboard.prescriptions.title")}</h1>
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
            <div>
              <input
                placeholder="Appointment ID"
                value={form.appointmentId}
                onChange={(e) => setForm({ ...form, appointmentId: e.target.value })}
                className={
                  "w-full rounded-lg border px-3 py-2 text-sm " +
                  (formErrors.appointmentId ? "border-red-500" : "")
                }
              />
              {formErrors.appointmentId && (
                <p className="mt-1 text-xs text-red-600">{formErrors.appointmentId}</p>
              )}
            </div>
            <div>
              <input
                placeholder="Patient ID"
                value={form.patientId}
                onChange={(e) => setForm({ ...form, patientId: e.target.value })}
                className={
                  "w-full rounded-lg border px-3 py-2 text-sm " +
                  (formErrors.patientId ? "border-red-500" : "")
                }
              />
              {formErrors.patientId && (
                <p className="mt-1 text-xs text-red-600">{formErrors.patientId}</p>
              )}
            </div>
            <div className="col-span-2">
              <label className="mb-1 flex items-center text-sm font-medium text-gray-700">
                Diagnosis
                <InfoIcon tooltip="ICD-10 codes are international standard diagnosis codes (e.g. E11.9 = Type 2 diabetes). Type to search." />
              </label>
              <Autocomplete<{ code: string; description: string }>
                value={form.diagnosis}
                onChange={(val, item) =>
                  setForm({
                    ...form,
                    diagnosis: item ? `${item.code} — ${item.description}` : val,
                  })
                }
                fetchOptions={async (q) => {
                  const r = await api.get<{
                    data: Array<{ code: string; description: string }>;
                  }>(`/icd10?q=${encodeURIComponent(q)}`);
                  return r.data ?? [];
                }}
                getOptionLabel={(o) => `${o.code} — ${o.description}`}
                renderOption={(o) => (
                  <div>
                    <span className="font-mono text-xs text-primary">{o.code}</span>{" "}
                    <span>{o.description}</span>
                  </div>
                )}
                placeholder="Search ICD-10 (e.g. diabetes)"
                inputClassName={formErrors.diagnosis ? "border-red-500" : ""}
              />
              {formErrors.diagnosis && (
                <p className="mt-1 text-xs text-red-600">{formErrors.diagnosis}</p>
              )}
            </div>
          </div>

          {/* Medicines */}
          <div className="mb-4">
            <div className="mb-2 flex items-center justify-between">
              <p className="flex items-center text-sm font-medium">
                Medicines
                <InfoIcon tooltip="At least one medicine is required. Use the autocomplete to pick from formulary." />
              </p>
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
                <div className="col-span-2">
                  <Autocomplete<{
                    id: string;
                    name: string;
                    genericName?: string | null;
                    strength?: string | null;
                    form?: string | null;
                  }>
                    value={med.medicineName}
                    onChange={(val, item) =>
                      updateMedicine(idx, "medicineName", item ? item.name : val)
                    }
                    fetchOptions={async (q) => {
                      const r = await api.get<{
                        data: Array<{
                          id: string;
                          name: string;
                          genericName?: string | null;
                          strength?: string | null;
                          form?: string | null;
                        }>;
                      }>(`/medicines/search/autocomplete?q=${encodeURIComponent(q)}`);
                      return r.data ?? [];
                    }}
                    getOptionLabel={(o) => o.name}
                    renderOption={(o) => (
                      <div>
                        <div className="font-medium">{o.name}</div>
                        <div className="text-xs text-gray-500">
                          {[o.genericName, o.strength, o.form]
                            .filter(Boolean)
                            .join(" • ")}
                        </div>
                      </div>
                    )}
                    placeholder="Medicine name"
                    inputClassName="py-1.5 text-sm"
                  />
                </div>
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
                {med.medicineName ? (
                  <div className="col-span-6 mt-1 flex flex-wrap gap-3">
                    <button
                      type="button"
                      onClick={() => openGenericsModal(idx, med.medicineName)}
                      className="text-left text-xs text-emerald-700 hover:underline"
                    >
                      💰 Check for cheaper generics
                    </button>
                    <button
                      type="button"
                      onClick={() => setRenalDoseRow(idx)}
                      className="text-left text-xs text-amber-700 hover:underline"
                    >
                      🧪 Calculate Renal Dose
                    </button>
                  </div>
                ) : null}
              </div>
            ))}
            {formErrors.medicines && (
              <p className="mt-1 text-xs text-red-600">{formErrors.medicines}</p>
            )}
          </div>

          {renalStatus &&
          renalStatus.crClMlPerMin !== null &&
          renalStatus.crClMlPerMin < 60 ? (
            <div className="mb-4 rounded-lg border border-amber-400 bg-amber-50 p-3 text-sm text-amber-800">
              <strong className="flex items-center">
                Renal dose adjustment needed
                <InfoIcon tooltip="CrCl (Creatinine Clearance) estimates kidney filtration rate. Below 60 mL/min may require dose reduction for many medicines." />
              </strong>
              <div className="mt-1">
                Patient CrCl {renalStatus.crClMlPerMin} mL/min ({renalStatus.ckdStage}).
                Review dosing for renally-cleared medicines before prescribing.
              </div>
            </div>
          ) : null}

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
          <EmptyState
            icon={<FileText size={28} aria-hidden="true" />}
            title="No prescriptions yet"
            description="Prescriptions you write will appear here."
            action={
              user?.role === "DOCTOR"
                ? { label: "Write prescription", onClick: () => setShowForm(true) }
                : undefined
            }
          />
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

      {genericRowIdx !== null && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4">
          <div className="max-h-[80vh] w-full max-w-2xl overflow-auto rounded-xl bg-white p-5 shadow-xl">
            <div className="mb-3 flex items-start justify-between">
              <div>
                <h3 className="text-lg font-semibold">Cheaper Generic Alternatives</h3>
                {genericData?.base ? (
                  <p className="text-sm text-gray-500">
                    Base: {genericData.base.name}
                    {genericData.basePrice ? ` — ₹${genericData.basePrice}` : ""}
                  </p>
                ) : null}
              </div>
              <button
                onClick={() => {
                  setGenericRowIdx(null);
                  setGenericData(null);
                }}
                className="text-gray-400 hover:text-gray-700"
              >
                ✕
              </button>
            </div>
            {genericLoading ? (
              <p className="text-gray-500">Loading...</p>
            ) : !genericData || genericData.alternatives.length === 0 ? (
              <p className="text-gray-500">No cheaper generics in stock.</p>
            ) : (
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-left text-xs uppercase text-gray-500">
                  <tr>
                    <th className="p-2">Brand</th>
                    <th className="p-2">Strength/Form</th>
                    <th className="p-2">Stock</th>
                    <th className="p-2">Price</th>
                    <th className="p-2">Savings</th>
                    <th className="p-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {genericData.alternatives.map((alt) => (
                    <tr key={alt.id} className="border-t">
                      <td className="p-2">
                        {alt.name}
                        {alt.brand ? (
                          <span className="ml-1 text-xs text-gray-500">({alt.brand})</span>
                        ) : null}
                      </td>
                      <td className="p-2 text-xs text-gray-600">
                        {alt.strength ?? ""} {alt.form ?? ""}
                      </td>
                      <td className="p-2">{alt.availableStock}</td>
                      <td className="p-2">₹{alt.sellingPrice ?? "—"}</td>
                      <td className="p-2 text-green-700">
                        {alt.savingsVsBrand !== null && alt.savingsVsBrand > 0
                          ? `₹${alt.savingsVsBrand}`
                          : "—"}
                      </td>
                      <td className="p-2">
                        <button
                          onClick={() => {
                            if (genericRowIdx === null) return;
                            const updated = [...medicines];
                            updated[genericRowIdx] = {
                              ...updated[genericRowIdx],
                              medicineName: alt.name,
                            };
                            setMedicines(updated);
                            setGenericRowIdx(null);
                            setGenericData(null);
                          }}
                          className="rounded bg-primary px-3 py-1 text-xs text-white"
                        >
                          Switch
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {renalDoseRow !== null && (
        <RenalDoseModal
          medicineName={medicines[renalDoseRow]?.medicineName || ""}
          patientId={form.patientId}
          onClose={() => setRenalDoseRow(null)}
          onApply={(dosage) => {
            if (renalDoseRow !== null) {
              updateMedicine(renalDoseRow, "dosage", dosage);
              toast.success("Dose applied");
            }
            setRenalDoseRow(null);
          }}
        />
      )}
    </div>
  );
}

// ─── Renal Dose Calculator Modal ──────────────────────

interface RenalDoseResult {
  medicine: {
    id: string;
    name: string;
    requiresRenalAdjustment: boolean;
    renalAdjustmentNotes: string | null;
  };
  crClMlPerMin: number;
  ckdStage: string;
  recommendedDoseFactor: number;
  recommendation: string;
  warning: string | null;
}

function RenalDoseModal({
  medicineName,
  patientId,
  onClose,
  onApply,
}: {
  medicineName: string;
  patientId: string;
  onClose: () => void;
  onApply: (dosage: string) => void;
}) {
  const [medicineId, setMedicineId] = useState<string | null>(null);
  const [age, setAge] = useState("");
  const [weight, setWeight] = useState("");
  const [creatinine, setCreatinine] = useState("");
  const [genderMale, setGenderMale] = useState(true);
  const [result, setResult] = useState<RenalDoseResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Resolve medicine and pre-fill patient context
  useEffect(() => {
    (async () => {
      try {
        const ac = await api.get<{
          data: Array<{ id: string; name: string }>;
        }>(
          `/medicines/search/autocomplete?q=${encodeURIComponent(medicineName)}`
        );
        const match = (ac.data || []).find(
          (m) => m.name.toLowerCase() === medicineName.toLowerCase()
        );
        if (match) setMedicineId(match.id);
      } catch {
        // noop
      }

      if (!patientId) return;
      try {
        const p = await api.get<{
          data: { age: number | null; gender: string };
        }>(`/patients/${patientId}`);
        if (p.data.age != null) setAge(String(p.data.age));
        setGenderMale(p.data.gender === "MALE");
      } catch {
        // noop
      }
      try {
        const rf = await api.get<{
          data: {
            latestCreatinine: { value: number } | null;
            weightKg: number | null;
          };
        }>(`/patients/${patientId}/renal-function`);
        if (rf.data.latestCreatinine)
          setCreatinine(String(rf.data.latestCreatinine.value));
        if (rf.data.weightKg) setWeight(String(rf.data.weightKg));
      } catch {
        // noop
      }
    })();
  }, [medicineName, patientId]);

  async function calculate() {
    setError(null);
    setResult(null);
    if (!medicineId) {
      setError("Medicine not found in formulary");
      return;
    }
    setLoading(true);
    try {
      const res = await api.post<{ data: RenalDoseResult }>(
        "/medicines/calculate-renal-dose",
        {
          medicineId,
          ageYears: parseFloat(age),
          weightKg: parseFloat(weight),
          creatinineMgDl: parseFloat(creatinine),
          genderMale,
        }
      );
      setResult(res.data);
    } catch (e) {
      setError((e as Error).message);
    }
    setLoading(false);
  }

  const stageColor =
    result?.ckdStage === "NORMAL"
      ? "bg-green-50 border-green-300 text-green-800"
      : result?.ckdStage === "MILD"
        ? "bg-lime-50 border-lime-300 text-lime-800"
        : result?.ckdStage === "MODERATE"
          ? "bg-amber-50 border-amber-300 text-amber-800"
          : "bg-red-50 border-red-300 text-red-800";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-2xl bg-white p-6 shadow-xl">
        <div className="mb-3 flex items-start justify-between">
          <h3 className="text-lg font-semibold">Renal Dose Calculator</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700">
            ✕
          </button>
        </div>
        <p className="mb-3 text-sm text-gray-600">
          For: <span className="font-medium">{medicineName}</span>
        </p>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs text-gray-600">Age (years)</label>
            <input
              type="number"
              value={age}
              onChange={(e) => setAge(e.target.value)}
              className="mt-1 w-full rounded-lg border px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="text-xs text-gray-600">Weight (kg)</label>
            <input
              type="number"
              value={weight}
              onChange={(e) => setWeight(e.target.value)}
              className="mt-1 w-full rounded-lg border px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="text-xs text-gray-600">Creatinine (mg/dL)</label>
            <input
              type="number"
              step="0.1"
              value={creatinine}
              onChange={(e) => setCreatinine(e.target.value)}
              className="mt-1 w-full rounded-lg border px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="text-xs text-gray-600">Gender</label>
            <select
              value={genderMale ? "M" : "F"}
              onChange={(e) => setGenderMale(e.target.value === "M")}
              className="mt-1 w-full rounded-lg border px-3 py-2 text-sm"
            >
              <option value="M">Male</option>
              <option value="F">Female</option>
            </select>
          </div>
        </div>
        <button
          onClick={calculate}
          disabled={loading || !age || !weight || !creatinine}
          className="mt-4 w-full rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {loading ? "Calculating..." : "Calculate"}
        </button>
        {error && (
          <div className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-700">
            {error}
          </div>
        )}
        {result && (
          <div className={`mt-4 rounded-xl border-2 p-4 ${stageColor}`}>
            <div className="text-xs font-semibold uppercase">
              CrCl {result.crClMlPerMin} mL/min · {result.ckdStage}
            </div>
            <div className="mt-2 text-sm">
              Recommended dose factor:{" "}
              <span className="font-bold">
                {(result.recommendedDoseFactor * 100).toFixed(0)}%
              </span>{" "}
              of normal dose
            </div>
            <div className="mt-2 text-xs">{result.recommendation}</div>
            {result.warning && (
              <div className="mt-2 rounded bg-white/60 p-2 text-xs font-medium">
                ⚠️ {result.warning}
              </div>
            )}
            <button
              onClick={() =>
                onApply(
                  `${(result.recommendedDoseFactor * 100).toFixed(0)}% of normal (CrCl ${result.crClMlPerMin})`
                )
              }
              className="mt-3 w-full rounded-lg bg-white px-3 py-2 text-sm font-medium text-gray-800 hover:bg-gray-100"
            >
              Apply Dose
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
