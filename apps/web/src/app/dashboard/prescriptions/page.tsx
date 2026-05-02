"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { api } from "@/lib/api";
import { useAuthStore } from "@/lib/store";
import { useTranslation } from "@/lib/i18n";
import { FREQUENCY_OPTIONS, createPrescriptionSchema } from "@medcore/shared";
import { toast } from "@/lib/toast";
import { InfoIcon } from "@/components/Tooltip";
import { Autocomplete } from "@/components/Autocomplete";
import { EntityPicker } from "@/components/EntityPicker";
import { EmptyState } from "@/components/EmptyState";
import { FileText, ChevronLeft, ChevronRight, Search } from "lucide-react";
import { formatDoctorName } from "@/lib/format-doctor-name";

// Issue #398: render the prescription's actual issue date with explicit
// en-IN locale and Asia/Kolkata TZ, so a server in UTC doesn't shift the
// displayed date by one calendar day for late-evening prescriptions.
const RX_DATE_FMT = new Intl.DateTimeFormat("en-IN", {
  day: "2-digit",
  month: "short",
  year: "numeric",
  timeZone: "Asia/Kolkata",
});

function formatRxIssuedDate(value: string | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return RX_DATE_FMT.format(d);
}

// Issue #399: a follow-up date in the past is meaningless to the patient
// (the visit either happened or was missed). Suppress it from the detail
// pane so the row stops looking actionable. We compare in local time using
// midnight-of-today as the cutoff so "today" is still shown.
function isFollowUpPast(value: string): boolean {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return d.getTime() < today.getTime();
}

// Issue #90: RECEPTION must NOT see prescriptions / clinical diagnoses.
// PHARMACIST + NURSE keep read access (dispensing + admin); PATIENT keeps
// own-data view.
const RX_ALLOWED = new Set(["ADMIN", "DOCTOR", "NURSE", "PHARMACIST", "PATIENT"]);

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
  const { user, isLoading } = useAuthStore();
  const router = useRouter();
  const pathname = usePathname();
  const { t } = useTranslation();

  // Issue #90: redirect RECEPTION (and any non-clinical role) away.
  // Issue #179: target /dashboard/not-authorized so the layout chrome stays.
  useEffect(() => {
    if (!isLoading && user && !RX_ALLOWED.has(user.role)) {
      toast.error("Prescriptions are restricted to clinical staff.");
      router.replace(
        `/dashboard/not-authorized?from=${encodeURIComponent(pathname || "/dashboard/prescriptions")}`,
      );
    }
  }, [user, isLoading, router, pathname]);
  const [prescriptions, setPrescriptions] = useState<PrescriptionRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  // ─── Issue #169: list toolbar (search / status / date / sort / paginate) ──
  // Backend `/api/v1/prescriptions` supports `?page=&limit=&patientId=&doctorId=`
  // but does NOT honour `?search=`, `?status=`, or date range yet. We do
  // server-side pagination and apply search/status/date filters client-side
  // over the loaded page.  Sort is also client-side via DataTable-style
  // toggling (default: issuedAt desc).
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"" | "ISSUED" | "PRINTED">("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [sortKey, setSortKey] = useState<"issuedAt" | "patient" | "doctor">(
    "issuedAt",
  );
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [page, setPage] = useState(1);
  const [pageLimit, setPageLimit] = useState(25);
  const [total, setTotal] = useState(0);

  // Debounce search input — 300 ms.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  // Reset to page 1 whenever a filter changes — otherwise we'd land on an
  // empty trailing page.
  useEffect(() => {
    setPage(1);
  }, [debouncedSearch, statusFilter, dateFrom, dateTo, pageLimit]);

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, pageLimit]);

  // Auto-open the Rx form when the doctor workspace quick-action links here
  // with ?new=1 (issue #11). Issue #439: also accept ?patientId=… so the
  // "Write Prescription" quick-action on the patient chart pre-fills the
  // form (this is the route the patient detail page links to).
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("new") === "1") setShowForm(true);
    const pid = params.get("patientId");
    if (pid) {
      setShowForm(true);
      setForm((f) => ({ ...f, patientId: pid }));
    }
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
    setLoadError(null);
    try {
      const res = await api.get<{
        data: PrescriptionRecord[];
        meta?: { total?: number };
      }>(`/prescriptions?page=${page}&limit=${pageLimit}`);
      setPrescriptions(res.data ?? []);
      setTotal(res.meta?.total ?? (res.data?.length ?? 0));
    } catch (err) {
      setLoadError(
        err instanceof Error ? err.message : "Failed to load prescriptions",
      );
      setPrescriptions([]);
      setTotal(0);
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
    const items = medicines.filter((m) => m.medicineName.trim());

    // Defense-in-depth: share the Zod schema used by the API so client-side
    // rejects bad UUIDs (Issue #17) and bad dosage shapes (Issue #9) before
    // the network round-trip.
    const parsed = createPrescriptionSchema.safeParse({
      appointmentId: form.appointmentId,
      patientId: form.patientId,
      diagnosis: form.diagnosis,
      items: items.map((m) => ({
        medicineName: m.medicineName,
        dosage: m.dosage,
        frequency: m.frequency,
        duration: m.duration || "—",
        instructions: m.instructions || undefined,
      })),
      advice: form.advice || undefined,
      followUpDate: form.followUpDate || undefined,
    });
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const first = issue.path[0];
        if (first === "appointmentId") {
          errs.appointmentId =
            issue.message.includes("uuid") ||
            issue.message.toLowerCase().includes("invalid")
              ? "Appointment ID must be a valid UUID"
              : issue.message;
        } else if (first === "patientId") {
          errs.patientId =
            issue.message.includes("uuid") ||
            issue.message.toLowerCase().includes("invalid")
              ? "Patient ID must be a valid UUID"
              : issue.message;
        } else if (first === "diagnosis") {
          errs.diagnosis = "Diagnosis is required (ICD-10 recommended)";
        } else if (first === "items") {
          // Either top-level "at least one" or a per-row dosage/frequency error.
          if (!errs.medicines) {
            errs.medicines =
              issue.path.length > 1
                ? `Medicine ${Number(issue.path[1]) + 1}: ${issue.message}`
                : issue.message;
          }
        } else if (first === "followUpDate") {
          errs.followUpDate = issue.message;
        }
      }
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

  // ─── Issue #169: derive filtered + sorted view of the loaded page ────────
  // Backend doesn't support `?search=`, status, or date range yet, so the
  // toolbar filters apply on the client over the current page of results.
  // The exposed `total` count reflects the server-side total *before* these
  // client filters — that's fine; the per-page hit list is what the user
  // sees, and the surface area where this matters most is search-as-you-type
  // (always on the current 25 rows).
  const visiblePrescriptions = useMemo(() => {
    const q = debouncedSearch.toLowerCase();
    const fromTs = dateFrom ? new Date(`${dateFrom}T00:00:00`).getTime() : null;
    const toTs = dateTo ? new Date(`${dateTo}T23:59:59`).getTime() : null;

    let rows = prescriptions.filter((rx) => {
      // Search across patient name + doctor name + medication names.
      if (q) {
        const hay = [
          rx.patient?.user?.name,
          rx.doctor?.user?.name,
          rx.diagnosis,
          ...(rx.items?.map((i) => i.medicineName) ?? []),
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }
      // Status filter (printed boolean → ISSUED / PRINTED).
      if (statusFilter === "PRINTED" && !rx.printed) return false;
      if (statusFilter === "ISSUED" && rx.printed) return false;
      // Date range on createdAt (issuedAt).
      if (fromTs || toTs) {
        const t = new Date(rx.createdAt).getTime();
        if (Number.isNaN(t)) return false;
        if (fromTs && t < fromTs) return false;
        if (toTs && t > toTs) return false;
      }
      return true;
    });

    const dir = sortDir === "asc" ? 1 : -1;
    rows = [...rows].sort((a, b) => {
      let av: string | number = "";
      let bv: string | number = "";
      if (sortKey === "issuedAt") {
        av = new Date(a.createdAt).getTime();
        bv = new Date(b.createdAt).getTime();
        return ((av as number) - (bv as number)) * dir;
      }
      if (sortKey === "patient") {
        av = a.patient?.user?.name ?? "";
        bv = b.patient?.user?.name ?? "";
      } else if (sortKey === "doctor") {
        av = a.doctor?.user?.name ?? "";
        bv = b.doctor?.user?.name ?? "";
      }
      return String(av).localeCompare(String(bv)) * dir;
    });
    return rows;
  }, [prescriptions, debouncedSearch, statusFilter, dateFrom, dateTo, sortKey, sortDir]);

  function toggleSort(next: typeof sortKey) {
    if (sortKey === next) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(next);
      setSortDir(next === "issuedAt" ? "desc" : "asc");
    }
  }

  const hasActiveFilters =
    !!debouncedSearch || !!statusFilter || !!dateFrom || !!dateTo;
  const totalPages = Math.max(1, Math.ceil(total / pageLimit));

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{t("dashboard.prescriptions.title")}</h1>
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
          data-testid="rx-new-form"
          onSubmit={handleSubmit}
          className="mb-6 rounded-xl bg-white p-6 text-gray-900 shadow-sm dark:bg-gray-800 dark:text-gray-100"
        >
          <h2 className="mb-4 font-semibold">New Prescription</h2>

          {templates.length > 0 && (
            <div className="mb-4 flex items-center gap-2 rounded-lg bg-blue-50 p-3 dark:bg-blue-900/30">
              <label className="text-sm font-medium">Use Template:</label>
              <select
                value={selectedTemplateId}
                onChange={(e) => {
                  setSelectedTemplateId(e.target.value);
                  if (e.target.value) applyTemplate(e.target.value);
                }}
                className="flex-1 rounded border border-gray-300 bg-white px-2 py-1 text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
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
            {/* Issue #120 (Apr 2026): replace raw "paste a UUID" inputs with
                the shared EntityPicker. Patient picker comes first so the
                appointment picker can scope to that patient — picking a
                patient automatically clears any previously selected
                appointment to prevent cross-patient prescriptions. */}
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-300">
                Patient
              </label>
              <EntityPicker
                endpoint="/patients"
                searchParam="search"
                labelField="user.name"
                subtitleField="user.phone"
                hintField="mrNumber"
                value={form.patientId}
                onChange={(id) => {
                  setForm((f) => ({
                    ...f,
                    patientId: id,
                    // Clear appointment when patient changes — avoids
                    // accidentally writing an Rx for the wrong patient.
                    appointmentId: "",
                  }));
                  if (formErrors.patientId)
                    setFormErrors((p) => ({ ...p, patientId: "" }));
                }}
                searchPlaceholder="Search patient by name, phone or MR..."
                testIdPrefix="rx-patient-picker"
                required
              />
              {formErrors.patientId && (
                <p
                  data-testid="error-rx-patient"
                  className="mt-1 text-xs text-red-600"
                >
                  {formErrors.patientId}
                </p>
              )}
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-300">
                Appointment
              </label>
              {/* Issue #194: scope the appointment picker to *today*, the
                  selected patient, and only "live" statuses
                  (BOOKED / CHECKED_IN / IN_PROGRESS) so the doctor sees the
                  active visit instead of a stale "No matches" because of an
                  off-by-one date or a CANCELLED row. The placeholder drops
                  the "Paste UUID" wording — patients shouldn't see
                  database concepts in clinical UI. */}
              {form.patientId ? (
                <EntityPicker
                  endpoint={`/appointments?patientId=${form.patientId}&date=${
                    new Date().toISOString().split("T")[0]
                  }&status=BOOKED,CHECKED_IN,IN_PROGRESS`}
                  searchParam="search"
                  labelField="slotStart"
                  subtitleField="doctor.user.name"
                  hintField="tokenNumber"
                  value={form.appointmentId}
                  onChange={(id) => {
                    setForm((f) => ({ ...f, appointmentId: id }));
                    if (formErrors.appointmentId)
                      setFormErrors((p) => ({ ...p, appointmentId: "" }));
                  }}
                  searchPlaceholder="Search by token / time"
                  testIdPrefix="rx-appointment-picker"
                  // Issue #194: pre-filtered URL → show today's list on
                  // focus instead of forcing 2+ chars of typing.
                  minQueryLength={0}
                  required
                />
              ) : (
                <p
                  className="rounded-lg border border-dashed border-gray-300 px-3 py-2 text-xs text-gray-500 dark:border-gray-600 dark:text-gray-400"
                  data-testid="rx-appointment-picker-hint"
                >
                  Select a patient first to choose their appointment.
                </p>
              )}
              {formErrors.appointmentId && (
                <p
                  data-testid="error-rx-appointment"
                  className="mt-1 text-xs text-red-600"
                >
                  {formErrors.appointmentId}
                </p>
              )}
            </div>
            <div className="col-span-2">
              <label className="mb-1 flex items-center text-sm font-medium text-gray-700 dark:text-gray-200">
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
                className="mb-2 grid grid-cols-6 gap-2 rounded-lg border border-gray-200 bg-gray-50 p-3 dark:border-gray-700 dark:bg-gray-900/40"
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
                  className="rounded border border-gray-300 bg-white px-2 py-1.5 text-sm text-gray-900 placeholder-gray-400 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 dark:placeholder-gray-500"
                />
                <select
                  value={med.frequency}
                  onChange={(e) => updateMedicine(idx, "frequency", e.target.value)}
                  className="rounded border border-gray-300 bg-white px-2 py-1.5 text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
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
                  className="rounded border border-gray-300 bg-white px-2 py-1.5 text-sm text-gray-900 placeholder-gray-400 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 dark:placeholder-gray-500"
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
              className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 placeholder-gray-400 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 dark:placeholder-gray-500"
              rows={2}
            />
            <div>
              <label className="mb-1 block text-sm">Follow-up Date</label>
              <input
                type="date"
                value={form.followUpDate}
                onChange={(e) => setForm({ ...form, followUpDate: e.target.value })}
                className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
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
              className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {/* ── Toolbar (Issue #169): search + status + date range ──────────── */}
      <div className="mb-4 grid gap-3 rounded-xl border border-gray-200 bg-white p-3 shadow-sm md:grid-cols-12 dark:border-gray-700 dark:bg-gray-800">
        <div className="md:col-span-5">
          <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-300">
            Search
          </label>
          <div className="relative">
            <Search
              size={14}
              aria-hidden="true"
              className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-gray-400"
            />
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by patient, doctor, medicine…"
              data-testid="rx-search-input"
              aria-label="Search prescriptions"
              className="w-full rounded-lg border border-gray-300 bg-white py-2 pl-7 pr-3 text-sm text-gray-900 placeholder-gray-400 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
            />
          </div>
        </div>
        <div className="md:col-span-3">
          <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-300">
            Status
          </label>
          <select
            value={statusFilter}
            onChange={(e) =>
              setStatusFilter(e.target.value as "" | "ISSUED" | "PRINTED")
            }
            data-testid="rx-status-filter"
            aria-label="Filter by status"
            className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
          >
            <option value="">All statuses</option>
            <option value="ISSUED">Issued</option>
            <option value="PRINTED">Printed</option>
          </select>
        </div>
        <div className="md:col-span-2">
          <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-300">
            From
          </label>
          <input
            type="date"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            data-testid="rx-date-from"
            aria-label="Issued on or after"
            className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
          />
        </div>
        <div className="md:col-span-2">
          <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-300">
            To
          </label>
          <input
            type="date"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            data-testid="rx-date-to"
            aria-label="Issued on or before"
            className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
          />
        </div>
      </div>

      {/* Sort buttons (live above the list — DataTable-style headers don't
          fit our card layout, so we expose them as a small toolbar). */}
      <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
        <span className="text-gray-500 dark:text-gray-400">Sort:</span>
        {(
          [
            { key: "issuedAt" as const, label: "Issued" },
            { key: "patient" as const, label: "Patient" },
            { key: "doctor" as const, label: "Doctor" },
          ]
        ).map((s) => {
          const active = sortKey === s.key;
          return (
            <button
              key={s.key}
              type="button"
              onClick={() => toggleSort(s.key)}
              data-testid={`rx-sort-${s.key}`}
              className={`rounded-full border px-3 py-1 ${
                active
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-gray-200 text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-700"
              }`}
            >
              {s.label}
              {active ? (sortDir === "asc" ? " ↑" : " ↓") : ""}
            </button>
          );
        })}
        <span
          className="ml-auto text-gray-500 dark:text-gray-400"
          data-testid="rx-total-count"
        >
          {hasActiveFilters
            ? `${visiblePrescriptions.length} of ${total} shown`
            : `${total} prescription${total === 1 ? "" : "s"}`}
        </span>
      </div>

      {/* Prescriptions list */}
      <div className="space-y-3">
        {loading ? (
          <div
            className="rounded-xl bg-white p-8 text-center text-gray-500 dark:bg-gray-800 dark:text-gray-400"
            data-testid="rx-loading"
          >
            Loading...
          </div>
        ) : loadError ? (
          <div
            className="rounded-xl border border-red-200 bg-red-50 p-6 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300"
            data-testid="rx-error"
            role="alert"
          >
            <p className="font-medium">Could not load prescriptions.</p>
            <p className="mt-1 text-xs opacity-80">{loadError}</p>
            <button
              onClick={loadPrescriptions}
              className="mt-3 rounded-lg border border-red-300 bg-white px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-50 dark:border-red-800 dark:bg-transparent"
            >
              Retry
            </button>
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
        ) : visiblePrescriptions.length === 0 ? (
          <EmptyState
            icon={<Search size={28} aria-hidden="true" />}
            title="No matches"
            description="No prescriptions match the current search or filter. Try clearing them."
            action={{
              label: "Clear filters",
              onClick: () => {
                setSearch("");
                setStatusFilter("");
                setDateFrom("");
                setDateTo("");
              },
            }}
          />
        ) : (
          visiblePrescriptions.map((rx) => (
            <div
              key={rx.id}
              data-testid={`rx-row-${rx.id}`}
              className="rounded-xl bg-white p-4 text-gray-900 shadow-sm dark:bg-gray-800 dark:text-gray-100"
            >
              <button
                onClick={() =>
                  setExpanded(expanded === rx.id ? null : rx.id)
                }
                className="w-full text-left"
              >
                <div className="flex items-center justify-between">
                  <div>
                    <p className="font-medium">{rx.patient.user.name}</p>
                    <p className="text-sm text-gray-500 dark:text-gray-400">
                      Diagnosis: {rx.diagnosis}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-sm font-medium">
                      {formatDoctorName(rx.doctor.user.name)}
                    </p>
                    <p
                      className="text-xs text-gray-500 dark:text-gray-400"
                      data-testid={`rx-issued-${rx.id}`}
                    >
                      Issued: {formatRxIssuedDate(rx.createdAt)}
                    </p>
                  </div>
                </div>
              </button>

              {expanded === rx.id && (
                <div className="mt-4 border-t border-gray-200 pt-4 dark:border-gray-700">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-gray-500 dark:text-gray-400">
                        <th className="pb-2">Medicine</th>
                        <th className="pb-2">Dosage</th>
                        <th className="pb-2">Frequency</th>
                        <th className="pb-2">Duration</th>
                        <th className="pb-2">Instructions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rx.items.map((item, i) => (
                        <tr key={i} className="border-t border-gray-100 dark:border-gray-700">
                          <td className="py-2 font-medium">
                            {item.medicineName}
                          </td>
                          <td className="py-2">{item.dosage}</td>
                          <td className="py-2">{item.frequency}</td>
                          <td className="py-2">{item.duration}</td>
                          <td className="py-2 text-gray-500 dark:text-gray-400">
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
                  {rx.followUpDate && !isFollowUpPast(rx.followUpDate) && (
                    <p className="mt-1 text-sm">
                      <span className="font-medium">Follow-up:</span>{" "}
                      {formatRxIssuedDate(rx.followUpDate)}
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

      {/* ── Pagination (Issue #169) ─────────────────────────────────────── */}
      {!loading && !loadError && total > 0 && (
        <div
          className="mt-4 flex flex-wrap items-center gap-3 rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm text-gray-600 shadow-sm dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300"
          data-testid="rx-pagination"
        >
          <div className="flex items-center gap-2">
            <label htmlFor="rx-page-size" className="text-xs">
              Rows:
            </label>
            <select
              id="rx-page-size"
              value={pageLimit}
              onChange={(e) => setPageLimit(Number(e.target.value))}
              data-testid="rx-page-size"
              aria-label="Rows per page"
              className="rounded border border-gray-300 bg-white px-2 py-1 text-sm dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
            >
              {[10, 25, 50, 100].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <span data-testid="rx-page-status">
              Page {page} of {totalPages}
            </span>
            <button
              type="button"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1}
              data-testid="rx-page-prev"
              aria-label="Previous page"
              className="flex min-h-[32px] min-w-[32px] items-center justify-center rounded border border-gray-200 p-1 disabled:opacity-40 dark:border-gray-700"
            >
              <ChevronLeft size={16} />
            </button>
            <button
              type="button"
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page >= totalPages}
              data-testid="rx-page-next"
              aria-label="Next page"
              className="flex min-h-[32px] min-w-[32px] items-center justify-center rounded border border-gray-200 p-1 disabled:opacity-40 dark:border-gray-700"
            >
              <ChevronRight size={16} />
            </button>
          </div>
        </div>
      )}

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
