"use client";

// Pearl ERP Stage 1 §2.1.3 — manual SOAP consult screen.
//
// What / which modules / why:
//   - 3-column layout backed by /api/v1/consultations (Consultation row
//     extended with subjective/objective/assessment/plan columns +
//     icd10Codes/snomedCodes JSON arrays in migration
//     20260526000001_add_consultation_soap_fields).
//   - Left rail: patient card (photo placeholder, name, age, sex,
//     phone, allergies, active medications, last vitals).
//   - Centre: SOAP tabs (Subjective / Objective / Assessment / Plan).
//     Objective opens with an inline vitals capture form (writes to
//     /patients/:id/vitals). Assessment hosts the ICD-10 + SNOMED
//     autocompletes.
//   - Right: <ConsultRightRail> (favourite Rx templates + last 3 visits)
//     — reused from the AI scribe page so click-to-paste keeps working.
//   - Sits parallel to /dashboard/scribe (voice-driven). The "Start
//     Consult" button on the Appointments page navigates here.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { api } from "@/lib/api";
import { VITALS_RANGES } from "@medcore/shared";
import { toast } from "@/lib/toast";
import { ageFromDOB } from "@/lib/format";
import { useAuthStore } from "@/lib/store";
import { ConsultRightRail, VisitDetail, type Visit } from "@/components/ConsultRightRail";
import { Skeleton, SkeletonText } from "@/components/Skeleton";
import { PatientAvatar } from "@/components/PatientAvatar";
import { Pill, FlaskConical, Check, Plus } from "lucide-react";

interface AppointmentDetail {
  id: string;
  status: string;
  date: string;
  slotStart: string | null;
  type: string;
  doctorId: string;
  patient: {
    id: string;
    mrNumber: string;
    age: number | null;
    dateOfBirth?: string | null;
    gender: string | null;
    bloodGroup: string | null;
    address: string | null;
    // Resolved signed avatar URL (from User or Patient photoUrl).
    photoSignedUrl?: string | null;
    user: { name: string; phone: string | null };
  };
  doctor: {
    id: string;
    specialization: string | null;
    user: { name: string };
  };
}

interface ConsultationRow {
  id: string;
  appointmentId: string;
  doctorId: string;
  subjective: string | null;
  objective: string | null;
  assessment: string | null;
  plan: string | null;
  icd10Codes: DiagnosisCode[] | null;
  snomedCodes: DiagnosisCode[] | null;
  notes: string | null;
  findings: string | null;
  status: string;
  signedAt: string | null;
}

interface DiagnosisCode {
  code: string;
  description: string;
}

interface Allergy {
  id: string;
  allergen: string;
  severity: string | null;
}

interface MedicationItem {
  medicineName: string;
  dosage: string | null;
  frequency: string | null;
}

interface LastVitals {
  bloodPressureSystolic: number | null;
  bloodPressureDiastolic: number | null;
  pulseRate: number | null;
  temperature: number | null;
  spO2: number | null;
  respiratoryRate: number | null;
  weight: number | null;
  height: number | null;
  recordedAt: string;
}

const SOAP_TABS = ["S", "O", "A", "P"] as const;
type SoapTab = (typeof SOAP_TABS)[number];
const TAB_LABEL: Record<SoapTab, string> = {
  S: "Subjective",
  O: "Objective",
  A: "Assessment",
  P: "Plan",
};

// Pearl §2.1.3 — each SOAP tab is a structured form of sub-fields
// instead of one freeform textarea. Doctors get prompted sections
// (chief complaint, HPI, ROS, etc.) that match the standard SOAP
// template, instead of an empty box to compose from scratch.
//
// On the wire the four columns (subjective / objective / assessment /
// plan) still store a single string — we serialize sub-fields with
// `## <Label>` markdown headers so the column remains
// human-readable when a doctor exports a chart or another viewer
// reads the row. Parse on load reverses the operation.
interface SoapField {
  key: string;
  label: string;
  placeholder: string;
  rows: number;
}
// Field keys + labels mirror the AI scribe SOAP schema exactly
// (apps/web/src/app/dashboard/scribe/page.tsx) so manual + AI-driven
// consults produce structurally-identical notes. Anything the AI
// scribe drafts can be exported / read by this manual page and vice
// versa.
const SOAP_STRUCTURE: Record<SoapTab, SoapField[]> = {
  S: [
    {
      key: "chiefComplaint",
      label: "Chief Complaint",
      placeholder: "Primary reason for visit, in the patient's own words",
      rows: 2,
    },
    {
      key: "hpi",
      label: "History of Present Illness",
      placeholder:
        "Onset, location, duration, character, aggravating / relieving factors, associated symptoms",
      rows: 5,
    },
    {
      key: "pastMedicalHistory",
      label: "Past Medical History",
      placeholder:
        "Chronic conditions, prior surgeries, hospitalizations, allergies",
      rows: 6,
    },
  ],
  O: [
    {
      key: "vitals",
      label: "Vitals",
      placeholder: "BP, pulse, temp, SpO2, RR, weight, height",
      rows: 3,
    },
    {
      key: "examinationFindings",
      label: "Examination Findings",
      placeholder:
        "System-specific findings (HEENT, CV, lungs, abdomen, etc.)",
      rows: 6,
    },
  ],
  A: [
    {
      key: "impression",
      label: "Clinical Impression / Diagnosis",
      placeholder: "Primary diagnosis and severity",
      rows: 10,
    },
  ],
  P: [
    {
      key: "medications",
      label: "Medications",
      placeholder:
        "Drug name, strength/form, dose, frequency, duration — one per line",
      rows: 4,
    },
    {
      key: "investigations",
      label: "Investigations Ordered",
      placeholder: "Labs, imaging, ECG, etc.",
      rows: 3,
    },
    {
      key: "followUpTimeline",
      label: "Follow-up",
      placeholder: "Return visit, referrals, labs to repeat",
      rows: 2,
    },
    {
      key: "patientInstructions",
      label: "Patient Instructions",
      placeholder: "Warning signs, when to seek emergency care, advice",
      rows: 3,
    },
  ],
};

// Serialize a sub-field map back into the on-wire column. Empty
// sub-fields are dropped so we don't write "## Chief Complaint\n\n##
// HPI\n…" with blank bodies between headers.
function serializeSoapSections(
  sections: Record<string, string>,
  structure: SoapField[],
): string {
  const parts: string[] = [];
  for (const f of structure) {
    const body = (sections[f.key] ?? "").trim();
    if (body) parts.push(`## ${f.label}\n${body}`);
  }
  return parts.join("\n\n");
}

// Parse the on-wire column back into sub-fields. Falls back to dumping
// the whole blob into the first sub-field for legacy / pre-structure
// consultations so nothing is lost.
function parseSoapSections(
  text: string | null | undefined,
  structure: SoapField[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of structure) out[f.key] = "";
  if (!text) return out;

  const regex = /^## (.+?)\r?\n([\s\S]*?)(?=\r?\n## |$)/gm;
  let m: RegExpExecArray | null;
  let anyMatched = false;
  while ((m = regex.exec(text)) !== null) {
    const label = m[1].trim();
    const body = m[2].trim();
    const f = structure.find((s) => s.label === label);
    if (f) {
      out[f.key] = body;
      anyMatched = true;
    }
  }

  if (!anyMatched && text.trim() && structure.length > 0) {
    out[structure[0].key] = text.trim();
  }
  return out;
}

export default function ConsultPage() {
  const params = useParams<{ appointmentId: string }>();
  const appointmentId = params?.appointmentId ?? "";
  const router = useRouter();
  const searchParams = useSearchParams();
  const user = useAuthStore((s) => s.user);
  const token = useAuthStore((s) => s.token);

  // Context-aware back navigation. Callers pass `?from=patient&
  // patientId=<id>` (patient profile) or `?from=appointments`
  // (appointments page). Default falls back to /dashboard/appointments
  // for direct hits and legacy links so the back button always works.
  //
  // When `from=patient`, the patient profile may itself have been
  // opened from another surface (queue, admissions, etc). Those echo
  // their origin to us as `returnFrom=<surface>` + `previewDoctor=
  // <id>` so we can round-trip them back onto the patient profile URL
  // — that page's OWN back link then returns to the original surface.
  // Without this, Queue → Patient → Consult → Back stranded the user
  // on a plain patient profile whose Back went to /patients.
  const fromParam = searchParams?.get("from") ?? null;
  const patientIdParam = searchParams?.get("patientId") ?? null;
  const returnFromParam = searchParams?.get("returnFrom") ?? null;
  const previewDoctorParam = searchParams?.get("previewDoctor") ?? null;
  const patientBackHref = (() => {
    if (!patientIdParam) return "/dashboard/patients";
    const qs: string[] = [];
    if (returnFromParam) qs.push(`from=${encodeURIComponent(returnFromParam)}`);
    if (previewDoctorParam)
      qs.push(`previewDoctor=${encodeURIComponent(previewDoctorParam)}`);
    return qs.length > 0
      ? `/dashboard/patients/${patientIdParam}?${qs.join("&")}`
      : `/dashboard/patients/${patientIdParam}`;
  })();
  const backLink =
    fromParam === "patient" && patientIdParam
      ? {
          href: patientBackHref,
          label: "Back to patient",
        }
      : {
          href: "/dashboard/appointments",
          label: "Back to appointments",
        };

  const [appointment, setAppointment] = useState<AppointmentDetail | null>(null);
  const [consultation, setConsultation] = useState<ConsultationRow | null>(null);
  const [allergies, setAllergies] = useState<Allergy[]>([]);
  const [medications, setMedications] = useState<MedicationItem[]>([]);
  const [lastVitals, setLastVitals] = useState<LastVitals | null>(null);
  const [activeTab, setActiveTab] = useState<SoapTab>("S");
  // When set, the main panel shows this past visit's full detail (in place of
  // the SOAP editor) instead of a popup; "Back to consult" clears it.
  const [viewingVisit, setViewingVisit] = useState<Visit | null>(null);
  // After Sign & Finalize, swap the editor for a read-only review of the signed
  // note with a "Complete" button that returns to the appointments list.
  const [signedSummary, setSignedSummary] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [signing, setSigning] = useState(false);
  // Capture the appointment-fetch error separately so the page can
  // distinguish "appointment really doesn't exist" (red error block)
  // from "appointment loaded but consultation/sidebar fetches blew up"
  // (page still renders, banner shows what's degraded).
  const [appointmentError, setAppointmentError] = useState<string | null>(null);
  const [consultationError, setConsultationError] = useState<string | null>(
    null,
  );

  // Local edit state — debounced into a PATCH on the server. Each
  // SOAP tab holds a map of sub-field-key → text so the form can
  // render labeled inputs (Chief Complaint, HPI, etc.) instead of a
  // single freeform textarea. Serialized to a single column on save.
  const [soapSections, setSoapSections] = useState<
    Record<SoapTab, Record<string, string>>
  >({
    S: {},
    O: {},
    A: {},
    P: {},
  });
  const [icd10, setIcd10] = useState<DiagnosisCode[]>([]);
  const [snomed, setSnomed] = useState<DiagnosisCode[]>([]);

  // Initial load: appointment + consultation (lazy-create) + sidebar
  // enrichments. Each fetch is independent — a failure on any one
  // doesn't blank the others. The appointment is the only hard
  // dependency: without it there's no patient to show.
  useEffect(() => {
    if (!appointmentId) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setAppointmentError(null);
      setConsultationError(null);

      // 1) Appointment — hard dependency.
      let apt: AppointmentDetail | null = null;
      try {
        const aptRes = await api.get<{ data: AppointmentDetail }>(
          `/appointments/${appointmentId}`,
        );
        apt = aptRes.data;
        if (!cancelled) setAppointment(apt);
      } catch (err) {
        if (!cancelled) {
          const msg =
            err instanceof Error ? err.message : "Appointment lookup failed";
          setAppointmentError(msg);
          setLoading(false);
        }
        return;
      }

      // 2) Consultation — soft. If this fails (e.g. backend route not
      //    yet deployed / Prisma client missing fields), the page
      //    still renders with patient context; banner explains.
      try {
        const consultRes = await api.get<{ data: ConsultationRow }>(
          `/consultations/by-appointment/${appointmentId}`,
        );
        if (cancelled) return;
        setConsultation(consultRes.data);
        // Already signed (e.g. after a page refresh) → land on the read-only
        // review screen, not the editor, so the state survives a reload.
        if (consultRes.data.status === "SIGNED") setSignedSummary(true);
        setSoapSections({
          S: parseSoapSections(consultRes.data.subjective, SOAP_STRUCTURE.S),
          O: parseSoapSections(consultRes.data.objective, SOAP_STRUCTURE.O),
          A: parseSoapSections(consultRes.data.assessment, SOAP_STRUCTURE.A),
          P: parseSoapSections(consultRes.data.plan, SOAP_STRUCTURE.P),
        });
        setIcd10(consultRes.data.icd10Codes ?? []);
        setSnomed(consultRes.data.snomedCodes ?? []);
      } catch (err) {
        if (!cancelled) {
          setConsultationError(
            err instanceof Error
              ? err.message
              : "Consultation draft unavailable",
          );
        }
      }

      // 3) Sidebar enrichments — all soft.
      const patientId = apt.patient.id;
      void api
        .get<{ data: Allergy[] }>(`/patients/${patientId}/allergies`)
        .then((r) => {
          if (!cancelled) setAllergies(r.data ?? []);
        })
        .catch(() => {});
      void api
        .get<{ data: { items: MedicationItem[] }[] }>(
          `/patients/${patientId}/prescriptions?limit=5`,
        )
        .then((r) => {
          if (cancelled) return;
          const flat: MedicationItem[] = [];
          for (const rx of r.data ?? []) {
            for (const it of rx.items ?? []) flat.push(it);
          }
          setMedications(flat.slice(0, 6));
        })
        .catch(() => {});
      void api
        .get<{ data: LastVitals[] }>(`/patients/${patientId}/vitals?limit=1`)
        .then((r) => {
          if (!cancelled && r.data && r.data.length > 0) {
            setLastVitals(r.data[0]);
          }
        })
        .catch(() => {});

      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [appointmentId]);

  // Auto-save debounce — fires 800ms after the last keystroke. Avoids
  // pummelling the API while the doctor types but keeps the draft
  // durable. No-op once SIGNED.
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const queueSave = useCallback(
    (patch: Partial<{
      subjective: string;
      objective: string;
      assessment: string;
      plan: string;
      icd10Codes: DiagnosisCode[];
      snomedCodes: DiagnosisCode[];
    }>) => {
      if (!consultation || consultation.status === "SIGNED") return;
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(async () => {
        try {
          setSaving(true);
          const res = await api.patch<{ data: ConsultationRow }>(
            `/consultations/${consultation.id}`,
            patch,
          );
          setConsultation(res.data);
        } catch (err) {
          toast.error(
            err instanceof Error ? err.message : "Save failed",
          );
        } finally {
          setSaving(false);
        }
      }, 800);
    },
    [consultation],
  );

  // Update one sub-field within a SOAP tab. Re-serializes the whole
  // tab's sections into the single column on save.
  function updateSoapField(tab: SoapTab, key: string, value: string) {
    setSoapSections((prev) => {
      const nextTab = { ...prev[tab], [key]: value };
      const serialized = serializeSoapSections(nextTab, SOAP_STRUCTURE[tab]);
      const field =
        tab === "S"
          ? "subjective"
          : tab === "O"
            ? "objective"
            : tab === "A"
              ? "assessment"
              : "plan";
      queueSave({ [field]: serialized } as Parameters<typeof queueSave>[0]);
      return { ...prev, [tab]: nextTab };
    });
  }

  function addIcd10(code: DiagnosisCode) {
    if (icd10.some((c) => c.code === code.code)) return;
    const next = [...icd10, code];
    setIcd10(next);
    queueSave({ icd10Codes: next });
  }
  function removeIcd10(code: string) {
    const next = icd10.filter((c) => c.code !== code);
    setIcd10(next);
    queueSave({ icd10Codes: next });
  }
  function addSnomed(code: DiagnosisCode) {
    if (snomed.some((c) => c.code === code.code)) return;
    const next = [...snomed, code];
    setSnomed(next);
    queueSave({ snomedCodes: next });
  }
  function removeSnomed(code: string) {
    const next = snomed.filter((c) => c.code !== code);
    setSnomed(next);
    queueSave({ snomedCodes: next });
  }

  // "Sign & Finalize" signs the note immediately (flush draft → POST /sign), so
  // the header flips to the "✓ Signed · <time>" badge, then opens the read-only
  // review screen with Back-to-edit / Complete.
  async function handleSign() {
    if (!consultation) return;
    if (consultation.status === "SIGNED") {
      setSignedSummary(true);
      return;
    }
    setSigning(true);
    try {
      // Flush any in-flight debounced save first so we sign the latest content.
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        await api.patch(`/consultations/${consultation.id}`, {
          subjective: serializeSoapSections(soapSections.S, SOAP_STRUCTURE.S),
          objective: serializeSoapSections(soapSections.O, SOAP_STRUCTURE.O),
          assessment: serializeSoapSections(soapSections.A, SOAP_STRUCTURE.A),
          plan: serializeSoapSections(soapSections.P, SOAP_STRUCTURE.P),
          icd10Codes: icd10,
          snomedCodes: snomed,
        });
      }
      // Sign only finalizes the NOTE — do NOT auto-complete the appointment
      // here. The appointment is marked COMPLETED separately when the doctor
      // clicks "Complete" on the review screen.
      const res = await api.post<{ data: ConsultationRow }>(
        `/consultations/${consultation.id}/sign`,
        { advanceAppointment: false },
      );
      setConsultation(res.data);
      setSignedSummary(true);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Sign failed");
    } finally {
      setSigning(false);
    }
  }

  // "Back to edit" on the review screen — unsigns (SIGNED → DRAFT), reverting
  // the header to the "Sign & Finalize" button, and drops back into the editor.
  async function handleUnsign() {
    if (!consultation) return;
    setSigning(true);
    try {
      const res = await api.post<{ data: ConsultationRow }>(
        `/consultations/${consultation.id}/unsign`,
        {},
      );
      setConsultation(res.data);
      setSignedSummary(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not reopen");
    } finally {
      setSigning(false);
    }
  }

  // "Complete" — THIS is what finishes the encounter: mark the appointment
  // COMPLETED (which also fires the consult-fee invoice, idempotently), then
  // return to the appointments list. The note was already signed on finalize.
  async function handleComplete() {
    const apptId = appointment?.id ?? consultation?.appointmentId;
    if (!apptId) {
      router.push("/dashboard/appointments");
      return;
    }
    setSigning(true);
    try {
      await api.patch(`/appointments/${apptId}/status`, {
        status: "COMPLETED",
      });
      toast.success("Consultation completed");
      router.push("/dashboard/appointments");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not complete");
      setSigning(false);
    }
  }

  // Click-to-paste from the right rail: appends diagnoses to
  // Assessment → Clinical Impression and medicines to Plan → Treatment
  // (the natural sub-fields for each), mirroring the AI scribe page
  // convention but routed into the structured form.
  const handlePasteDiagnosis = useCallback(
    (value: string) => {
      setActiveTab("A");
      setSoapSections((prev) => {
        const existing = prev.A.impression ?? "";
        // No duplicates — skip if this exact diagnosis line is already listed.
        const alreadyListed = existing
          .split("\n")
          .some((l) => l.trim().toLowerCase() === value.trim().toLowerCase());
        if (alreadyListed) return prev;
        const nextValue = existing ? `${existing}\n${value}` : value;
        const nextTab = { ...prev.A, impression: nextValue };
        queueSave({
          assessment: serializeSoapSections(nextTab, SOAP_STRUCTURE.A),
        });
        return { ...prev, A: nextTab };
      });
    },
    [queueSave],
  );
  const handlePasteMedicine = useCallback(
    (m: {
      name: string;
      dose?: string;
      frequency?: string;
      duration?: string;
    }) => {
      const line = [m.name, m.dose, m.frequency, m.duration]
        .filter(Boolean)
        .join(" • ");
      setActiveTab("P");
      setSoapSections((prev) => {
        // Medicines paste into the dedicated Medications field in the Plan
        // section (one drug per line) — the field a doctor uses to give
        // medicine to the patient.
        const existing = prev.P.medications ?? "";
        // No duplicates — skip if this exact medicine line is already listed.
        const alreadyListed = existing
          .split("\n")
          .some((l) => l.trim().toLowerCase() === line.toLowerCase());
        if (alreadyListed) return prev;
        const nextValue = existing ? `${existing}\n${line}` : line;
        const nextTab = { ...prev.P, medications: nextValue };
        queueSave({
          plan: serializeSoapSections(nextTab, SOAP_STRUCTURE.P),
        });
        return { ...prev, P: nextTab };
      });
    },
    [queueSave],
  );

  const isReadOnly = consultation?.status === "SIGNED";
  const patientName = appointment?.patient.user.name ?? "—";
  // Prefer age derived from date-of-birth (always accurate); fall back to any
  // legacy stored integer age. Patients now register with DOB, not age.
  const patientAge =
    ageFromDOB(appointment?.patient.dateOfBirth ?? null) ??
    appointment?.patient.age ??
    null;
  const patientSex = appointment?.patient.gender ?? null;
  const patientPhone = appointment?.patient.user.phone ?? null;
  // Initials now derived inside <PatientAvatar>; no local computation.

  if (loading) {
    return (
      <div className="flex h-[calc(100vh-4rem)] flex-col bg-gray-50 dark:bg-gray-900">
        {/* Header skeleton */}
        <header className="flex items-center gap-3 border-b border-gray-200 bg-white px-4 py-3 dark:border-gray-700 dark:bg-gray-800 sm:px-6 sm:py-4">
          <Skeleton variant="circle" width={36} height={36} />
          <div className="flex-1 space-y-2">
            <Skeleton variant="text" width="40%" />
            <Skeleton variant="text" width="60%" />
          </div>
          <Skeleton variant="rect" width={120} height={40} className="rounded-lg" />
        </header>

        <div className="flex flex-1 min-h-0 flex-col md:flex-row">
          {/* Left rail skeleton */}
          <aside className="w-full shrink-0 border-b border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800 md:w-56 md:border-b-0 md:border-r xl:w-72 xl:p-5">
            <div className="flex flex-col items-center gap-3 rounded-2xl border border-gray-100 p-4 dark:border-gray-700">
              <Skeleton variant="circle" width={56} height={56} />
              <Skeleton variant="text" width="70%" />
              <Skeleton variant="text" width="40%" />
            </div>
            <div className="mt-4 space-y-4">
              <SkeletonText lines={2} />
              <SkeletonText lines={3} />
            </div>
          </aside>

          {/* Centre skeleton */}
          <main className="flex w-full flex-1 min-w-0 flex-col">
            <div className="flex gap-1 border-b border-gray-200 bg-white px-3 py-3 dark:border-gray-700 dark:bg-gray-800 sm:px-6">
              {["S", "O", "A", "P"].map((t) => (
                <Skeleton key={t} variant="rect" width={72} height={20} className="rounded" />
              ))}
            </div>
            <div className="p-3 sm:p-5 lg:p-6">
              <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-700 dark:bg-gray-800">
                <Skeleton variant="text" width="30%" className="mb-4" />
                <SkeletonText lines={5} />
              </div>
            </div>
          </main>
        </div>
      </div>
    );
  }
  if (!appointment) {
    return (
      <div className="p-8">
        <p className="text-red-600">
          {appointmentError
            ? `Could not load appointment: ${appointmentError}`
            : "Appointment not found."}
        </p>
        <Link
          href={backLink.href}
          className="mt-4 inline-block text-primary underline"
        >
          {backLink.label}
        </Link>
      </div>
    );
  }

  return (
    <div className="flex h-[calc(100vh-4rem)] flex-col bg-gray-50 dark:bg-gray-900">
      {/* Top bar — patient summary + sign action. Stacks the Sign
          button BELOW the title block on every viewport narrower
          than xl (≤1280) so the title gets full width to breathe and
          the action sits prominently as its own row. At xl+ the two
          blocks return to a single-row left/right split. */}
      <header className="flex flex-col items-stretch gap-3 border-b border-gray-200 bg-white px-4 py-3 dark:border-gray-700 dark:bg-gray-800 sm:px-6 sm:py-4 xl:flex-row xl:items-center xl:justify-between xl:gap-4">
        <div className="flex items-center gap-3 min-w-0 sm:gap-4">
          <Link
            href={backLink.href}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-gray-200 text-gray-600 transition hover:border-gray-300 hover:bg-gray-50 hover:text-gray-900 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-700 dark:hover:text-gray-100"
            aria-label={backLink.label}
          >
            <span className="text-base leading-none">←</span>
          </Link>
          <div className="min-w-0">
            <h1 className="truncate text-base font-semibold text-gray-900 dark:text-gray-100">
              Consult · {patientName}
            </h1>
            <p className="mt-0.5 truncate text-xs text-gray-500 dark:text-gray-400">
              {appointment.patient.mrNumber}
              <span className="mx-2 text-gray-300 dark:text-gray-600">|</span>
              {appointment.doctor.user.name}
              <span className="mx-2 text-gray-300 dark:text-gray-600">|</span>
              {appointment.date.slice(0, 10)}
              {appointment.slotStart ? ` · ${appointment.slotStart}` : ""}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-3 xl:self-auto">
          {saving && (
            <span className="flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-gray-400" />
              Saving…
            </span>
          )}
          {consultation?.status === "SIGNED" ? (
            <span className="rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-800 dark:border-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-200">
              ✓ Signed
              {consultation.signedAt
                ? ` · ${new Date(consultation.signedAt).toLocaleString()}`
                : ""}
            </span>
          ) : (
            <button
              onClick={handleSign}
              disabled={signing}
              className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-emerald-700 disabled:opacity-50"
            >
              {signing ? "Signing…" : "Sign & Finalize"}
            </button>
          )}
        </div>
      </header>

      {consultationError && (
        <div className="border-b border-amber-300 bg-amber-50 px-6 py-2 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-900/30 dark:text-amber-200">
          Consultation draft is unavailable ({consultationError}). Patient
          context still loads, but SOAP edits won't persist. Restart the API
          dev server / run db:generate + db:migrate if you've just added the
          consultations route.
        </div>
      )}

      {/* Responsive shell — three-stage layout so the page never
          crowds, regardless of viewport (factoring in the ~256-px
          dashboard sidebar already in the chrome):
            - <md (<768): everything stacks single column. Left rail
              becomes a compact patient strip at top, SOAP centre
              full-width, right rail at bottom.
            - md–xl (768–1280): TWO columns — left rail sits on the
              left as a slim summary, SOAP centre takes the rest,
              right rail stacks BELOW the row to give the SOAP form
              breathing room (this is the laptop ~1024-px case).
            - xl+ (≥1280): classic 3-column flex (left | centre | right). */}
      <div className="flex flex-1 min-h-0 flex-col overflow-y-auto md:flex-row md:flex-wrap xl:flex-nowrap xl:overflow-hidden">
        {/* LEFT RAIL — patient card */}
        <aside className="w-full shrink-0 border-b border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800 md:w-56 md:border-b-0 md:border-r md:overflow-y-auto md:p-4 xl:w-72 xl:p-5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {/* Horizontal card on <md (mobile/tablet stack), vertical
              centered card on md+ where the rail is its own column. */}
          <div className="flex items-center gap-3 rounded-2xl border border-gray-100 bg-gradient-to-b from-gray-50 to-white p-3 text-left dark:border-gray-700 dark:from-gray-900 dark:to-gray-800 md:flex-col md:items-center md:p-4 md:text-center">
            <PatientAvatar
              photoUrl={appointment?.patient.photoSignedUrl ?? null}
              name={patientName}
              size={56}
              className="shadow-md"
            />
            <div className="min-w-0 flex-1 md:flex-none">
              <p className="truncate text-sm font-semibold text-gray-900 dark:text-gray-100 md:mt-2 md:whitespace-normal">
                {patientName}
              </p>
              <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                {patientAge !== null ? `${patientAge}y` : "—"}
                {patientSex ? ` · ${patientSex}` : ""}
              </p>
              {patientPhone && (
                <p className="truncate text-xs text-gray-500 dark:text-gray-400">
                  {patientPhone}
                </p>
              )}
            </div>
            {appointment.patient.bloodGroup && (
              <span className="shrink-0 rounded-full bg-rose-100 px-2.5 py-0.5 text-[11px] font-semibold text-rose-800 dark:bg-rose-900/40 dark:text-rose-200 md:mt-2">
                {appointment.patient.bloodGroup}
              </span>
            )}
          </div>

          {/* Below-the-fold sections (Allergies / Active medications /
              Last vitals) hide on mobile to save vertical space — the
              compact patient card above already shows identity. They
              reappear at md+ where the left rail is its own column. */}
          <div className="hidden md:block">
          <Section title="Allergies">
            {allergies.length === 0 ? (
              <p className="text-xs text-gray-500 dark:text-gray-400">None on file</p>
            ) : (
              <div className="flex flex-wrap gap-1">
                {allergies.map((a) => (
                  <span
                    key={a.id}
                    className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-800 dark:bg-red-900/40 dark:text-red-200"
                    title={a.severity ?? ""}
                  >
                    {a.allergen}
                  </span>
                ))}
              </div>
            )}
          </Section>

          <Section title="Active medications">
            {medications.length === 0 ? (
              <p className="text-xs text-gray-500 dark:text-gray-400">None</p>
            ) : (
              <ul className="space-y-1">
                {medications.map((m, i) => (
                  <li
                    key={`${m.medicineName}-${i}`}
                    className="text-xs text-gray-700 dark:text-gray-300"
                  >
                    <span className="font-medium">{m.medicineName}</span>
                    {m.dosage ? ` · ${m.dosage}` : ""}
                    {m.frequency ? ` · ${m.frequency}` : ""}
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <Section title="Last vitals">
            {/* Always show the key vital fields — fall back to "—" when a value
                (or the whole record) is missing, instead of an empty section. */}
            <dl className="grid grid-cols-2 gap-x-2 gap-y-1 text-xs">
              <Stat
                label="BP"
                value={
                  lastVitals?.bloodPressureSystolic != null
                    ? `${lastVitals.bloodPressureSystolic}/${lastVitals.bloodPressureDiastolic ?? "—"}`
                    : "—"
                }
              />
              <Stat
                label="Pulse"
                value={lastVitals?.pulseRate != null ? `${lastVitals.pulseRate}` : "—"}
              />
              <Stat
                label="Temp"
                value={
                  lastVitals?.temperature != null ? `${lastVitals.temperature}°` : "—"
                }
              />
              <Stat
                label="SpO2"
                value={lastVitals?.spO2 != null ? `${lastVitals.spO2}%` : "—"}
              />
              <Stat
                label="RR"
                value={
                  lastVitals?.respiratoryRate != null
                    ? `${lastVitals.respiratoryRate}`
                    : "—"
                }
              />
              <Stat
                label="Wt"
                value={lastVitals?.weight != null ? `${lastVitals.weight}kg` : "—"}
              />
            </dl>
            {!lastVitals && (
              <p className="mt-1.5 text-[11px] italic text-gray-400 dark:text-gray-500">
                No vitals recorded yet
              </p>
            )}
          </Section>
          </div>
        </aside>

        {/* CENTRE — SOAP tabs */}
        <main className="flex w-full flex-1 min-h-0 min-w-0 flex-col bg-gray-50 dark:bg-gray-900">
          {signedSummary ? (
            <div className="flex-1 overflow-y-auto p-3 sm:p-5 lg:p-6 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              <SignedSummary
                soapSections={soapSections}
                icd10={icd10}
                saving={signing}
                onBackToEdit={handleUnsign}
                onComplete={handleComplete}
              />
            </div>
          ) : viewingVisit ? (
            <div className="flex-1 overflow-y-auto p-3 sm:p-5 lg:p-6 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              <VisitDetail
                visit={viewingVisit}
                onBack={() => setViewingVisit(null)}
              />
            </div>
          ) : (
          <>
          <div className="flex items-center justify-between gap-2 border-b border-gray-200 bg-white px-3 dark:border-gray-700 dark:bg-gray-800 sm:px-6">
            <div className="flex flex-1 min-w-0 gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {SOAP_TABS.map((tab) => (
                <button
                  key={tab}
                  onClick={() => setActiveTab(tab)}
                  className={`relative whitespace-nowrap px-4 py-3 text-sm font-medium transition sm:px-5 ${
                    activeTab === tab
                      ? "text-primary"
                      : "text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100"
                  }`}
                >
                  {TAB_LABEL[tab]}
                  {activeTab === tab && (
                    <span className="absolute inset-x-3 -bottom-px h-0.5 rounded-full bg-primary" />
                  )}
                </button>
              ))}
            </div>
            {/* Quick-action icon group — visible on md+ (laptops and
                up). Mobile hides them to keep the tab strip clean. */}
            <div className="hidden shrink-0 items-center gap-1 md:flex">
              <Link
                href={`/dashboard/prescriptions/new?patientId=${appointment.patient.id}&appointmentId=${appointment.id}&from=consult`}
                title="Write prescription"
                aria-label="Write prescription"
                className="flex h-9 w-9 items-center justify-center rounded-md text-gray-500 transition hover:bg-green-50 hover:text-green-700 dark:text-gray-400 dark:hover:bg-green-900/30 dark:hover:text-green-300"
              >
                <Pill className="h-4 w-4" />
              </Link>
              <Link
                href={`/dashboard/lab/new?patientId=${appointment.patient.id}&appointmentId=${appointment.id}&from=consult`}
                title="Order lab tests"
                aria-label="Order lab tests"
                className="flex h-9 w-9 items-center justify-center rounded-md text-gray-500 transition hover:bg-purple-50 hover:text-purple-700 dark:text-gray-400 dark:hover:bg-purple-900/30 dark:hover:text-purple-300"
              >
                <FlaskConical className="h-4 w-4" />
              </Link>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-3 sm:p-5 lg:p-6 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {activeTab === "A" && (
              <DiagnosisCoding
                icd10={icd10}
                snomed={snomed}
                disabled={isReadOnly}
                onAddIcd10={addIcd10}
                onRemoveIcd10={removeIcd10}
                onAddSnomed={addSnomed}
                onRemoveSnomed={removeSnomed}
              />
            )}

            {/* Vitals capture is its own collapsible card above the Objective note. */}
            {activeTab === "O" && (
              <VitalsInline
                appointmentId={appointment.id}
                patientId={appointment.patient.id}
                disabled={isReadOnly}
                onRecorded={(v) => setLastVitals(v)}
              />
            )}

            <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-700 dark:bg-gray-800">
              <div className="mb-4 flex items-center justify-between">
                <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">
                  {TAB_LABEL[activeTab]}
                </h3>
                <span className="text-[10px] uppercase tracking-wider text-gray-400 dark:text-gray-500">
                  {SOAP_STRUCTURE[activeTab].length} field
                  {SOAP_STRUCTURE[activeTab].length === 1 ? "" : "s"}
                </span>
              </div>
              <div className="space-y-4">
                {SOAP_STRUCTURE[activeTab].map((field) => (
                  <div key={field.key}>
                    <label className="mb-1.5 block text-xs font-semibold text-gray-700 dark:text-gray-300">
                      {field.label}
                    </label>
                    {activeTab === "P" && field.key === "medications" ? (
                      <MedicationsEditor
                        value={soapSections.P.medications ?? ""}
                        disabled={isReadOnly}
                        onChange={(v) =>
                          updateSoapField("P", "medications", v)
                        }
                      />
                    ) : (
                      <textarea
                        value={soapSections[activeTab][field.key] ?? ""}
                        onChange={(e) =>
                          updateSoapField(activeTab, field.key, e.target.value)
                        }
                        disabled={isReadOnly}
                        placeholder={field.placeholder}
                        rows={field.rows}
                        className="w-full resize-y rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm leading-relaxed text-gray-900 placeholder-gray-400 transition focus:border-gray-400 focus:bg-white focus:outline-none focus:ring-0 dark:border-gray-700 dark:bg-gray-900/40 dark:text-gray-100 dark:placeholder-gray-500 dark:focus:border-gray-500 dark:focus:bg-gray-900 disabled:bg-gray-100 dark:disabled:bg-gray-800"
                      />
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
          </>
          )}
        </main>

        {/* RIGHT RAIL — favourites + last 3 visits. The inner
            ConsultRightRail provides its own white cards with rounded
            corners + shadow, so the wrapper stays transparent (just
            the gray background bleeds through) to avoid the
            "card-on-card" look.
            <md: full-width band at the bottom of the stack.
            md–xl: stays full-width, wraps below the left+centre row
                   (because the row uses flex-wrap at md).
            xl+: sits as a 320-px right column. */}
        <div className="w-full shrink-0 border-t border-gray-200 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-900 xl:hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {/* Bottom-band rail: side-by-side cards so they fill the
              full row width on laptop sizes instead of staying
              squeezed into a 288-px column with empty space beside. */}
          <ConsultRightRail
            doctorId={appointment.doctorId}
            patientId={appointment.patient.id}
            token={token}
            onPasteDiagnosis={handlePasteDiagnosis}
            onPasteMedicine={handlePasteMedicine}
            onSelectVisit={setViewingVisit}
            horizontal
          />
        </div>
        {/* xl+ side rail — narrow column on the right, original
            stacked layout. */}
        <div className="hidden xl:flex xl:w-80 xl:shrink-0 xl:flex-col xl:overflow-y-auto xl:border-l xl:border-gray-200 xl:bg-gray-50 xl:p-4 xl:dark:border-gray-700 xl:dark:bg-gray-900 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <ConsultRightRail
            doctorId={appointment.doctorId}
            patientId={appointment.patient.id}
            token={token}
            onPasteDiagnosis={handlePasteDiagnosis}
            onPasteMedicine={handlePasteMedicine}
            onSelectVisit={setViewingVisit}
          />
        </div>
      </div>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mt-4 border-t border-gray-200 pt-3 dark:border-gray-700">
      <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
        {title}
      </p>
      {children}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-gray-500 dark:text-gray-400">{label}</dt>
      <dd className="font-medium text-gray-900 dark:text-gray-100">{value}</dd>
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Structured medications editor (Plan tab) — one row of fields per drug with
// an "Add medicine" button, instead of a single free-text box. Each medicine
// serializes to one line "<name> • <strength> • <dose> • <frequency> •
// <duration>" (non-empty parts only), matching the favourites click-to-paste
// format, so the value still round-trips through the plan column and shows
// cleanly in the review / past-visit screens.
// ─────────────────────────────────────────────────────────────────────
interface MedRow {
  name: string;
  strength: string;
  dose: string;
  frequency: string;
  duration: string;
}
const EMPTY_MED_ROW: MedRow = {
  name: "",
  strength: "",
  dose: "",
  frequency: "",
  duration: "",
};
const MED_SEP = " • ";

function parseMedicationRows(value: string): MedRow[] {
  const lines = value
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return [{ ...EMPTY_MED_ROW }];
  return lines.map((line) => {
    const parts = line.split(MED_SEP.trim()).map((p) => p.trim());
    return {
      name: parts[0] ?? "",
      strength: parts[1] ?? "",
      dose: parts[2] ?? "",
      frequency: parts[3] ?? "",
      duration: parts[4] ?? "",
    };
  });
}

function serializeMedicationRows(rows: MedRow[]): string {
  return rows
    .map((r) =>
      [r.name, r.strength, r.dose, r.frequency, r.duration]
        .map((x) => x.trim())
        .filter(Boolean)
        .join(MED_SEP),
    )
    .filter((line) => line.length > 0)
    .join("\n");
}

// One hit from the medicines catalog typeahead (GET /medicines?search=).
interface MedicineHit {
  id: string;
  name: string;
  genericName?: string | null;
  strength?: string | null;
  form?: string | null;
}

function MedicationsEditor({
  value,
  disabled,
  onChange,
}: {
  value: string;
  disabled: boolean;
  onChange: (v: string) => void;
}) {
  const [rows, setRows] = useState<MedRow[]>(() => parseMedicationRows(value));
  // Track the last string WE emitted so external changes (loading a note,
  // favourites click-to-paste) re-parse into rows, while our own keystrokes
  // don't bounce back and steal input focus.
  const lastEmitted = useRef(value);
  useEffect(() => {
    if (value !== lastEmitted.current) {
      setRows(parseMedicationRows(value));
      lastEmitted.current = value;
    }
  }, [value]);

  // Medicine typeahead: which row's name box is searching, its results, and
  // whether the dropdown is open. Debounced so we don't fire per keystroke.
  const [search, setSearch] = useState<{
    row: number;
    results: MedicineHit[];
    open: boolean;
  }>({ row: -1, results: [], open: false });
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function commit(next: MedRow[]) {
    setRows(next);
    const serialized = serializeMedicationRows(next);
    lastEmitted.current = serialized;
    onChange(serialized);
  }
  const setField = (i: number, key: keyof MedRow, v: string) =>
    commit(rows.map((r, idx) => (idx === i ? { ...r, [key]: v } : r)));
  // Patch several fields on a row in ONE commit (used when a search result
  // fills name + strength together).
  const setRowFields = (i: number, patch: Partial<MedRow>) =>
    commit(rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));

  // Type in the name box → update the row AND (debounced) query the catalog.
  function onNameChange(i: number, v: string) {
    setField(i, "name", v);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    const q = v.trim();
    if (q.length < 2) {
      setSearch({ row: -1, results: [], open: false });
      return;
    }
    searchTimer.current = setTimeout(async () => {
      try {
        const res = await api.get<{ data: MedicineHit[] }>(
          `/medicines?search=${encodeURIComponent(q)}&limit=8`,
        );
        setSearch({ row: i, results: res.data ?? [], open: true });
      } catch {
        setSearch({ row: -1, results: [], open: false });
      }
    }, 250);
  }

  // Pick a catalog medicine → fill the name, and its strength/form if the
  // strength box is still empty (never clobber what the doctor typed).
  function pickMedicine(i: number, med: MedicineHit) {
    const strengthForm = [med.strength, med.form]
      .map((x) => (x ?? "").trim())
      .filter(Boolean)
      .join(" ");
    setRowFields(i, {
      name: med.name,
      ...(rows[i].strength.trim() || !strengthForm ? {} : { strength: strengthForm }),
    });
    setSearch({ row: -1, results: [], open: false });
  }

  const addRow = () => commit([...rows, { ...EMPTY_MED_ROW }]);
  const removeRow = (i: number) =>
    commit(
      rows.length > 1 ? rows.filter((_, idx) => idx !== i) : [{ ...EMPTY_MED_ROW }],
    );

  const inputCls =
    "w-full rounded-md border border-gray-200 bg-gray-50 px-2.5 py-1.5 text-sm text-gray-900 placeholder-gray-400 focus:border-gray-400 focus:bg-white focus:outline-none dark:border-gray-700 dark:bg-gray-900/40 dark:text-gray-100 dark:placeholder-gray-500 dark:focus:border-gray-500 dark:focus:bg-gray-900 disabled:bg-gray-100 dark:disabled:bg-gray-800";

  return (
    <div className="space-y-3">
      {rows.map((row, i) => (
        <div
          key={i}
          className="rounded-lg border border-gray-200 p-3 dark:border-gray-700"
        >
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500">
              Medicine {i + 1}
            </span>
            {!disabled && (
              <button
                type="button"
                onClick={() => removeRow(i)}
                className="text-xs font-medium text-red-500 hover:underline"
              >
                Remove
              </button>
            )}
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {/* Searchable drug-name field — typeahead against the medicines
                catalog. Picking a result fills the name (+ strength/form). */}
            <div className="relative sm:col-span-2">
              <input
                type="text"
                value={row.name}
                disabled={disabled}
                autoComplete="off"
                onChange={(e) => onNameChange(i, e.target.value)}
                onFocus={() =>
                  setSearch((s) =>
                    s.row === i && s.results.length > 0
                      ? { ...s, open: true }
                      : s,
                  )
                }
                onBlur={() =>
                  // Delay so a mousedown on a result registers before we close.
                  setTimeout(
                    () =>
                      setSearch((s) => (s.row === i ? { ...s, open: false } : s)),
                    150,
                  )
                }
                placeholder="Search medicine (e.g. para)…"
                className={inputCls}
              />
              {search.open &&
                search.row === i &&
                search.results.length > 0 && (
                  <ul className="absolute z-20 mt-1 max-h-56 w-full overflow-auto rounded-md border border-gray-200 bg-white py-1 shadow-lg dark:border-gray-700 dark:bg-gray-800">
                    {search.results.map((m) => {
                      const sub = [
                        m.genericName,
                        [m.strength, m.form].filter(Boolean).join(" "),
                      ]
                        .filter(Boolean)
                        .join(" · ");
                      return (
                        <li key={m.id}>
                          <button
                            type="button"
                            onMouseDown={(e) => {
                              e.preventDefault();
                              pickMedicine(i, m);
                            }}
                            className="flex w-full flex-col items-start px-3 py-1.5 text-left hover:bg-indigo-50 dark:hover:bg-gray-700"
                          >
                            <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
                              {m.name}
                            </span>
                            {sub && (
                              <span className="text-xs text-gray-500 dark:text-gray-400">
                                {sub}
                              </span>
                            )}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
            </div>
            <input
              type="text"
              value={row.strength}
              disabled={disabled}
              onChange={(e) => setField(i, "strength", e.target.value)}
              placeholder="Strength / form"
              className={inputCls}
            />
            <input
              type="text"
              value={row.dose}
              disabled={disabled}
              onChange={(e) => setField(i, "dose", e.target.value)}
              placeholder="Dose"
              className={inputCls}
            />
            <input
              type="text"
              value={row.frequency}
              disabled={disabled}
              onChange={(e) => setField(i, "frequency", e.target.value)}
              placeholder="Frequency"
              className={inputCls}
            />
            <input
              type="text"
              value={row.duration}
              disabled={disabled}
              onChange={(e) => setField(i, "duration", e.target.value)}
              placeholder="Duration"
              className={inputCls}
            />
          </div>
        </div>
      ))}
      {!disabled && (
        <button
          type="button"
          onClick={addRow}
          className="flex items-center gap-1.5 rounded-md border border-dashed border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-600 transition hover:border-indigo-400 hover:text-indigo-600 dark:border-gray-600 dark:text-gray-300 dark:hover:border-indigo-500 dark:hover:text-indigo-400"
        >
          <Plus className="h-3.5 w-3.5" /> Add medicine
        </button>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Review screen — shown after "Sign & Finalize". Renders the note read-only
// (straight from the in-memory SOAP field maps, so it matches exactly what's
// about to be saved). "Back to edit" returns to the editor without any API
// call; "Complete" is what actually signs + saves and leaves the page.
// ─────────────────────────────────────────────────────────────────────
function SignedSummary({
  soapSections,
  icd10,
  saving,
  onBackToEdit,
  onComplete,
}: {
  soapSections: Record<SoapTab, Record<string, string>>;
  icd10: DiagnosisCode[];
  saving: boolean;
  onBackToEdit: () => void;
  onComplete: () => void;
}) {
  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-700 dark:bg-gray-800">
      <div className="mb-5 flex items-start justify-between gap-3 border-b border-gray-100 pb-4 dark:border-gray-700">
        <div className="min-w-0">
          <h3 className="flex items-center gap-2 text-base font-semibold text-gray-900 dark:text-gray-100">
            <Check className="h-5 w-5 text-emerald-600" />
            Consultation Signed
          </h3>
          <p className="mt-0.5 text-sm text-gray-500 dark:text-gray-400">
            Complete to finish, or Unsign to edit to reopen the note.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={onBackToEdit}
            disabled={saving}
            data-testid="consult-back-to-edit"
            className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 transition hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
          >
            {saving ? "Unsigning…" : "Unsign to edit"}
          </button>
          <button
            type="button"
            onClick={onComplete}
            disabled={saving}
            data-testid="consult-complete"
            className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {saving ? "Completing…" : "Complete"}
          </button>
        </div>
      </div>

      <div className="space-y-5">
        {SOAP_TABS.map((tab) => {
          const fields = SOAP_STRUCTURE[tab].filter(
            (f) => (soapSections[tab][f.key] ?? "").trim() !== "",
          );
          const showIcd = tab === "A" && icd10.length > 0;
          if (fields.length === 0 && !showIcd) return null;
          return (
            <section
              key={tab}
              className="rounded-xl border border-gray-200 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-900/40"
            >
              <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                {TAB_LABEL[tab]}
              </p>
              <div className="space-y-3">
                {fields.map((f) => (
                  <div key={f.key}>
                    <p className="text-sm font-semibold text-gray-800 dark:text-gray-100">
                      {f.label}
                    </p>
                    <p className="mt-0.5 whitespace-pre-wrap break-words text-sm text-gray-600 dark:text-gray-300">
                      {soapSections[tab][f.key]}
                    </p>
                  </div>
                ))}
                {showIcd && (
                  <div>
                    <p className="text-sm font-semibold text-gray-800 dark:text-gray-100">
                      ICD-10 Codes
                    </p>
                    <div className="mt-1 flex flex-wrap gap-1.5">
                      {icd10.map((c) => (
                        <span
                          key={c.code}
                          className="rounded-full bg-blue-100 px-2.5 py-0.5 text-xs font-medium text-blue-800 dark:bg-blue-900/40 dark:text-blue-200"
                        >
                          {c.code} — {c.description}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Inline vitals capture (sits atop the Objective tab per Pearl §2.1.3).
// Writes to POST /patients/:id/vitals — same endpoint the nurse station
// uses. The doctor recording vitals themselves is a valid flow (small
// clinic, single-room setups).
// ─────────────────────────────────────────────────────────────────────

// Per-field label + valid range for client-side vitals validation. Ranges are
// the SAME VITALS_RANGES the server's recordVitalsSchema enforces, so the form
// rejects exactly what the API would (issue #1090). Temperature maps to the °F
// range to match the field's unit.
const VITAL_FIELD_META: Record<
  string,
  { label: string; range: { min: number; max: number }; unit: string }
> = {
  bloodPressureSystolic: {
    label: "BP Systolic",
    range: VITALS_RANGES.bloodPressureSystolic,
    unit: "mmHg",
  },
  bloodPressureDiastolic: {
    label: "BP Diastolic",
    range: VITALS_RANGES.bloodPressureDiastolic,
    unit: "mmHg",
  },
  pulseRate: { label: "Pulse", range: VITALS_RANGES.pulseRate, unit: "bpm" },
  temperature: {
    label: "Temp (°F)",
    range: VITALS_RANGES.temperatureF,
    unit: "°F",
  },
  spO2: { label: "SpO2 (%)", range: VITALS_RANGES.spO2, unit: "%" },
  respiratoryRate: {
    label: "RR",
    range: VITALS_RANGES.respiratoryRate,
    unit: "/min",
  },
  weight: { label: "Weight (kg)", range: VITALS_RANGES.weight, unit: "kg" },
  height: { label: "Height (cm)", range: VITALS_RANGES.height, unit: "cm" },
};
const EMPTY_VITALS = {
  bloodPressureSystolic: "",
  bloodPressureDiastolic: "",
  pulseRate: "",
  temperature: "",
  spO2: "",
  respiratoryRate: "",
  weight: "",
  height: "",
};
function VitalsInline({
  appointmentId,
  patientId,
  disabled,
  onRecorded,
}: {
  appointmentId: string;
  patientId: string;
  disabled: boolean;
  onRecorded: (v: LastVitals) => void;
}) {
  const [saving, setSaving] = useState(false);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ ...EMPTY_VITALS });

  async function submit() {
    if (disabled) return;
    // Issue #1090 (BUG-005): validate numerically + against the SAME ranges the
    // server enforces (VITALS_RANGES) so impossible values (letters, negatives,
    // out-of-range) are rejected up front with a clear message instead of being
    // silently dropped or bounced by a 400 with no feedback.
    const body: Record<string, number> = {};
    for (const [k, v] of Object.entries(form)) {
      const trimmed = v.trim();
      if (trimmed.length === 0) continue;
      const meta = VITAL_FIELD_META[k];
      const n = Number(trimmed);
      if (!Number.isFinite(n)) {
        toast.error(`${meta?.label ?? k} must be a number.`);
        return;
      }
      if (meta && (n < meta.range.min || n > meta.range.max)) {
        toast.error(
          `${meta.label} must be between ${meta.range.min} and ${meta.range.max}.`,
        );
        return;
      }
      body[k] = n;
    }
    // Runs on Sign & Finalize (via flush()). Incomplete entries (fewer than 2
    // vitals, or only one half of the BP pair) are silently skipped — no error
    // toast — so a note with no/partial vitals still signs without nagging.
    if (Object.keys(body).length < 2) return;
    if (
      ("bloodPressureSystolic" in body) !==
      ("bloodPressureDiastolic" in body)
    ) {
      return;
    }
    if (
      "bloodPressureSystolic" in body &&
      "bloodPressureDiastolic" in body &&
      body.bloodPressureDiastolic >= body.bloodPressureSystolic
    ) {
      toast.error("Diastolic must be lower than systolic.");
      return;
    }
    setSaving(true);
    try {
      const res = await api.post<{ data: LastVitals }>(
        `/patients/${patientId}/vitals`,
        {
          ...body,
          // recordVitalsSchema requires patientId in the body too (not just the
          // URL) — omitting it 400s with "patientId: expected string, received
          // undefined". Send it explicitly alongside the appointment link.
          patientId,
          // Temperature is captured in °F (per the field label); pin the unit
          // so the server validates against the °F range, not the °C default.
          ...("temperature" in body ? { temperatureUnit: "F" } : {}),
          appointmentId,
        },
      );
      onRecorded(res.data);
      toast.success("Vitals recorded");
      setForm({ ...EMPTY_VITALS });
      setOpen(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Vitals save failed");
    } finally {
      setSaving(false);
    }
  }

  // Live per-field validation (issue #1090) — surfaced inline under each input
  // as the doctor types, instead of only as toasts on Save. Same ranges the
  // server enforces (VITALS_RANGES), so the UI rejects exactly what the API would.
  const errors: Record<string, string> = {};
  for (const [k, v] of Object.entries(form)) {
    const trimmed = v.trim();
    if (trimmed.length === 0) continue;
    const meta = VITAL_FIELD_META[k];
    const n = Number(trimmed);
    if (!Number.isFinite(n)) {
      errors[k] = "Enter a number";
    } else if (meta && (n < meta.range.min || n > meta.range.max)) {
      errors[k] = `Must be ${meta.range.min}–${meta.range.max}${
        meta.unit ? " " + meta.unit : ""
      }`;
    }
  }
  // Cross-field: diastolic must be lower than systolic (when both are valid).
  const sys = Number(form.bloodPressureSystolic.trim());
  const dia = Number(form.bloodPressureDiastolic.trim());
  if (
    !errors.bloodPressureSystolic &&
    !errors.bloodPressureDiastolic &&
    form.bloodPressureSystolic.trim() &&
    form.bloodPressureDiastolic.trim() &&
    dia >= sys
  ) {
    errors.bloodPressureDiastolic = "Diastolic must be lower than systolic";
  }
  // BP is a pair — recording only one half is clinically incomplete. Attach the
  // "required" error to the EMPTY side so the doctor knows which input to fill.
  const sysFilled = form.bloodPressureSystolic.trim() !== "";
  const diaFilled = form.bloodPressureDiastolic.trim() !== "";
  if (sysFilled && !diaFilled && !errors.bloodPressureDiastolic) {
    errors.bloodPressureDiastolic = "Required when BP Systolic is filled";
  }
  if (diaFilled && !sysFilled && !errors.bloodPressureSystolic) {
    errors.bloodPressureSystolic = "Required when BP Diastolic is filled";
  }
  const hasErrors = Object.keys(errors).length > 0;

  // Require at least 2 vital values before allowing save — a single isolated
  // reading is rarely useful; 2+ catches the common BP-pair / BP+pulse combos.
  const MIN_VITALS = 2;
  const filledVitalCount = Object.values(form).filter(
    (v) => v.trim() !== "",
  ).length;
  const hasMinimumVitals = filledVitalCount >= MIN_VITALS;

  return (
    <div className="mb-4 rounded-2xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-700 dark:bg-gray-800">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
          Vitals capture
        </p>
        {open ? (
          <button
            type="button"
            onClick={() => {
              setForm({ ...EMPTY_VITALS });
              setOpen(false);
            }}
            className="text-xs font-medium text-indigo-600 hover:underline dark:text-indigo-400"
          >
            Cancel
          </button>
        ) : (
          <button
            type="button"
            onClick={() => setOpen(true)}
            disabled={disabled}
            className="text-xs font-medium text-indigo-600 hover:underline disabled:cursor-not-allowed disabled:opacity-50 dark:text-indigo-400"
          >
            Record vitals
          </button>
        )}
      </div>
      {open && (
        <>
      <div className="mt-3 grid grid-cols-2 gap-2 md:grid-cols-4">
          <Input
            label="BP Systolic"
            value={form.bloodPressureSystolic}
            error={errors.bloodPressureSystolic}
            onChange={(v) =>
              setForm((p) => ({ ...p, bloodPressureSystolic: v }))
            }
          />
          <Input
            label="BP Diastolic"
            value={form.bloodPressureDiastolic}
            error={errors.bloodPressureDiastolic}
            onChange={(v) =>
              setForm((p) => ({ ...p, bloodPressureDiastolic: v }))
            }
          />
          <Input
            label="Pulse"
            value={form.pulseRate}
            error={errors.pulseRate}
            onChange={(v) => setForm((p) => ({ ...p, pulseRate: v }))}
          />
          <Input
            label="Temp (°F)"
            value={form.temperature}
            error={errors.temperature}
            onChange={(v) => setForm((p) => ({ ...p, temperature: v }))}
          />
          <Input
            label="SpO2 (%)"
            value={form.spO2}
            error={errors.spO2}
            onChange={(v) => setForm((p) => ({ ...p, spO2: v }))}
          />
          <Input
            label="RR"
            value={form.respiratoryRate}
            error={errors.respiratoryRate}
            onChange={(v) =>
              setForm((p) => ({ ...p, respiratoryRate: v }))
            }
          />
          <Input
            label="Weight (kg)"
            value={form.weight}
            error={errors.weight}
            onChange={(v) => setForm((p) => ({ ...p, weight: v }))}
          />
          <Input
            label="Height (cm)"
            value={form.height}
            error={errors.height}
            onChange={(v) => setForm((p) => ({ ...p, height: v }))}
          />
        </div>
          <div className="mt-3 flex items-center gap-3">
            <button
              type="button"
              onClick={submit}
              disabled={disabled || saving || hasErrors || !hasMinimumVitals}
              className="rounded-md bg-indigo-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save vitals"}
            </button>
            {!hasMinimumVitals && (
              <span className="text-xs text-gray-500 dark:text-gray-400">
                Enter at least {MIN_VITALS} vital values to save
                {filledVitalCount > 0
                  ? ` (${filledVitalCount}/${MIN_VITALS})`
                  : ""}
              </span>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function Input({
  label,
  value,
  onChange,
  error,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  error?: string | null;
}) {
  return (
    <label className="block">
      <span className="block text-[10px] font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
        {label}
      </span>
      <input
        type="number"
        step="any"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        inputMode="decimal"
        aria-invalid={error ? true : undefined}
        className={`mt-1 w-full rounded border bg-white px-2 py-1 text-sm focus:outline-none dark:bg-gray-800 dark:text-gray-100 ${
          error
            ? "border-red-400 focus:border-red-500 dark:border-red-500"
            : "border-gray-300 focus:border-primary dark:border-gray-600"
        }`}
      />
      {error && (
        <span className="mt-0.5 block text-[10px] font-medium text-red-500">
          {error}
        </span>
      )}
    </label>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Diagnosis coding (Assessment tab) — ICD-10 + SNOMED CT autocompletes.
// Hits /icd10?q= (real ~14k catalogue) and /snomed?q= (starter dataset
// pending C-DAC ETL). Selected codes accumulate as chips.
// ─────────────────────────────────────────────────────────────────────
function DiagnosisCoding({
  icd10,
  snomed,
  disabled,
  onAddIcd10,
  onRemoveIcd10,
  onAddSnomed,
  onRemoveSnomed,
}: {
  icd10: DiagnosisCode[];
  snomed: DiagnosisCode[];
  disabled: boolean;
  onAddIcd10: (c: DiagnosisCode) => void;
  onRemoveIcd10: (code: string) => void;
  onAddSnomed: (c: DiagnosisCode) => void;
  onRemoveSnomed: (code: string) => void;
}) {
  return (
    <div className="mb-4 grid gap-3 md:grid-cols-2">
      <CodeAutocomplete
        title="ICD-10 diagnosis"
        endpoint="/icd10"
        selected={icd10}
        disabled={disabled}
        onAdd={onAddIcd10}
        onRemove={onRemoveIcd10}
        chipColor="indigo"
      />
      <CodeAutocomplete
        title="SNOMED CT"
        endpoint="/snomed"
        selected={snomed}
        disabled={disabled}
        onAdd={onAddSnomed}
        onRemove={onRemoveSnomed}
        chipColor="teal"
      />
    </div>
  );
}

function CodeAutocomplete({
  title,
  endpoint,
  selected,
  disabled,
  onAdd,
  onRemove,
  chipColor,
}: {
  title: string;
  endpoint: string;
  selected: DiagnosisCode[];
  disabled: boolean;
  onAdd: (c: DiagnosisCode) => void;
  onRemove: (code: string) => void;
  chipColor: "indigo" | "teal";
}) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<DiagnosisCode[]>([]);
  const [searching, setSearching] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (q.trim().length < 2) {
      setResults([]);
      return;
    }
    debounceRef.current = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await api.get<{ data: DiagnosisCode[] }>(
          `${endpoint}?q=${encodeURIComponent(q.trim())}&limit=8`,
        );
        setResults(res.data ?? []);
      } catch {
        /* noop */
      } finally {
        setSearching(false);
      }
    }, 250);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [q, endpoint]);

  const chipClasses =
    chipColor === "indigo"
      ? "bg-indigo-100 text-indigo-800 dark:bg-indigo-900/40 dark:text-indigo-200"
      : "bg-teal-100 text-teal-800 dark:bg-teal-900/40 dark:text-teal-200";

  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-800">
      <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
        {title}
      </p>
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search code or term…"
        disabled={disabled}
        className="w-full rounded border border-gray-300 bg-white px-2 py-1 text-sm focus:border-primary focus:outline-none dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
      />
      {results.length > 0 && (
        <ul className="mt-2 max-h-48 overflow-y-auto rounded border border-gray-200 bg-white text-sm dark:border-gray-700 dark:bg-gray-800">
          {results.map((r) => (
            <li key={r.code}>
              <button
                onClick={() => {
                  onAdd(r);
                  setQ("");
                  setResults([]);
                }}
                className="block w-full px-2 py-1 text-left hover:bg-gray-50 dark:hover:bg-gray-700"
              >
                <span className="font-mono text-xs text-primary">{r.code}</span>
                <span className="ml-2 text-gray-800 dark:text-gray-200">
                  {r.description}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {searching && q.trim().length >= 2 && results.length === 0 && (
        <p className="mt-2 text-xs text-gray-500">Searching…</p>
      )}
      <div className="mt-2 flex flex-wrap gap-1">
        {selected.map((c) => (
          <span
            key={c.code}
            className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs ${chipClasses}`}
          >
            <span className="font-mono">{c.code}</span>
            <span className="truncate max-w-[160px]" title={c.description}>
              {c.description}
            </span>
            {!disabled && (
              <button
                onClick={() => onRemove(c.code)}
                className="ml-1 text-current opacity-60 hover:opacity-100"
                aria-label={`Remove ${c.code}`}
              >
                ×
              </button>
            )}
          </span>
        ))}
      </div>
    </div>
  );
}
