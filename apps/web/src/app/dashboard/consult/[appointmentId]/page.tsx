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
import { toast } from "@/lib/toast";
import { useAuthStore } from "@/lib/store";
import { ConsultRightRail } from "@/components/ConsultRightRail";
import { Skeleton, SkeletonText } from "@/components/Skeleton";
import { PatientAvatar } from "@/components/PatientAvatar";
import { Pill, FlaskConical } from "lucide-react";

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
      rows: 3,
    },
  ],
  O: [
    {
      key: "vitals",
      label: "Vitals",
      placeholder: "BP, pulse, temp, SpO2, RR, weight, height (free-text)",
      rows: 2,
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
      rows: 4,
    },
  ],
  P: [
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

  async function handleSign() {
    if (!consultation) return;
    if (consultation.status === "SIGNED") return;
    setSigning(true);
    try {
      // Flush any in-flight debounced save first. Serialize each
      // tab's sub-field map into its single on-wire column.
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        await api.patch(`/consultations/${consultation.id}`, {
          subjective: serializeSoapSections(
            soapSections.S,
            SOAP_STRUCTURE.S,
          ),
          objective: serializeSoapSections(soapSections.O, SOAP_STRUCTURE.O),
          assessment: serializeSoapSections(
            soapSections.A,
            SOAP_STRUCTURE.A,
          ),
          plan: serializeSoapSections(soapSections.P, SOAP_STRUCTURE.P),
          icd10Codes: icd10,
          snomedCodes: snomed,
        });
      }
      const res = await api.post<{ data: ConsultationRow }>(
        `/consultations/${consultation.id}/sign`,
        {},
      );
      setConsultation(res.data);
      toast.success("Consultation signed");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Sign failed");
    } finally {
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
        // Medicines paste into Patient Instructions — the natural
        // sub-field that holds prose-formatted Rx in the manual page
        // (the AI scribe stores structured medications elsewhere).
        const existing = prev.P.patientInstructions ?? "";
        const nextValue = existing ? `${existing}\n${line}` : line;
        const nextTab = { ...prev.P, patientInstructions: nextValue };
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
  const patientAge = appointment?.patient.age ?? null;
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
              MR {appointment.patient.mrNumber}
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
            {!lastVitals ? (
              <p className="text-xs text-gray-500 dark:text-gray-400">No vitals</p>
            ) : (
              <dl className="grid grid-cols-2 gap-x-2 gap-y-1 text-xs">
                {lastVitals.bloodPressureSystolic !== null && (
                  <Stat
                    label="BP"
                    value={`${lastVitals.bloodPressureSystolic}/${lastVitals.bloodPressureDiastolic ?? "—"}`}
                  />
                )}
                {lastVitals.pulseRate !== null && (
                  <Stat label="Pulse" value={`${lastVitals.pulseRate}`} />
                )}
                {lastVitals.temperature !== null && (
                  <Stat
                    label="Temp"
                    value={`${lastVitals.temperature}°`}
                  />
                )}
                {lastVitals.spO2 !== null && (
                  <Stat label="SpO2" value={`${lastVitals.spO2}%`} />
                )}
                {lastVitals.respiratoryRate !== null && (
                  <Stat label="RR" value={`${lastVitals.respiratoryRate}`} />
                )}
                {lastVitals.weight !== null && (
                  <Stat label="Wt" value={`${lastVitals.weight}kg`} />
                )}
              </dl>
            )}
          </Section>
          </div>
        </aside>

        {/* CENTRE — SOAP tabs */}
        <main className="flex w-full flex-1 min-w-0 flex-col bg-gray-50 dark:bg-gray-900">
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
            {activeTab === "O" && (
              <VitalsInline
                appointmentId={appointment.id}
                patientId={appointment.patient.id}
                disabled={isReadOnly}
                onRecorded={(v) => setLastVitals(v)}
              />
            )}

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
                  </div>
                ))}
              </div>
            </div>
          </div>
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
// Inline vitals capture (sits atop the Objective tab per Pearl §2.1.3).
// Writes to POST /patients/:id/vitals — same endpoint the nurse station
// uses. The doctor recording vitals themselves is a valid flow (small
// clinic, single-room setups).
// ─────────────────────────────────────────────────────────────────────
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
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    bloodPressureSystolic: "",
    bloodPressureDiastolic: "",
    pulseRate: "",
    temperature: "",
    spO2: "",
    respiratoryRate: "",
    weight: "",
    height: "",
  });

  async function submit() {
    const body: Record<string, number> = {};
    for (const [k, v] of Object.entries(form)) {
      const trimmed = v.trim();
      if (trimmed.length > 0) {
        const n = Number(trimmed);
        if (!Number.isNaN(n)) body[k] = n;
      }
    }
    if (Object.keys(body).length < 2) {
      toast.error("Enter at least 2 vitals before recording.");
      return;
    }
    if (
      ("bloodPressureSystolic" in body) !==
      ("bloodPressureDiastolic" in body)
    ) {
      toast.error("Both BP systolic and diastolic are required together.");
      return;
    }
    setSaving(true);
    try {
      const res = await api.post<{ data: LastVitals }>(
        `/patients/${patientId}/vitals`,
        { ...body, appointmentId },
      );
      onRecorded(res.data);
      toast.success("Vitals recorded");
      setOpen(false);
      setForm({
        bloodPressureSystolic: "",
        bloodPressureDiastolic: "",
        pulseRate: "",
        temperature: "",
        spO2: "",
        respiratoryRate: "",
        weight: "",
        height: "",
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Vitals save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mb-4 rounded-2xl border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-800">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
          Vitals capture
        </p>
        <button
          onClick={() => setOpen((v) => !v)}
          disabled={disabled}
          className="text-xs text-primary underline disabled:opacity-50"
        >
          {open ? "Cancel" : "Record vitals"}
        </button>
      </div>
      {open && (
        <div className="mt-3 grid grid-cols-2 gap-2 md:grid-cols-4">
          <Input
            label="BP Systolic"
            value={form.bloodPressureSystolic}
            onChange={(v) =>
              setForm((p) => ({ ...p, bloodPressureSystolic: v }))
            }
          />
          <Input
            label="BP Diastolic"
            value={form.bloodPressureDiastolic}
            onChange={(v) =>
              setForm((p) => ({ ...p, bloodPressureDiastolic: v }))
            }
          />
          <Input
            label="Pulse"
            value={form.pulseRate}
            onChange={(v) => setForm((p) => ({ ...p, pulseRate: v }))}
          />
          <Input
            label="Temp (°F)"
            value={form.temperature}
            onChange={(v) => setForm((p) => ({ ...p, temperature: v }))}
          />
          <Input
            label="SpO2 (%)"
            value={form.spO2}
            onChange={(v) => setForm((p) => ({ ...p, spO2: v }))}
          />
          <Input
            label="RR"
            value={form.respiratoryRate}
            onChange={(v) =>
              setForm((p) => ({ ...p, respiratoryRate: v }))
            }
          />
          <Input
            label="Weight (kg)"
            value={form.weight}
            onChange={(v) => setForm((p) => ({ ...p, weight: v }))}
          />
          <Input
            label="Height (cm)"
            value={form.height}
            onChange={(v) => setForm((p) => ({ ...p, height: v }))}
          />
          <div className="col-span-2 flex items-end md:col-span-4">
            <button
              onClick={submit}
              disabled={saving}
              className="rounded bg-primary px-4 py-1.5 text-sm font-semibold text-white hover:bg-primary/90 disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save vitals"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Input({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="block">
      <span className="block text-[10px] font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
        {label}
      </span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        inputMode="decimal"
        className="mt-1 w-full rounded border border-gray-300 bg-white px-2 py-1 text-sm focus:border-primary focus:outline-none dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
      />
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
