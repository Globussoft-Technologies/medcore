/**
 * FHIR R4 resource mappers — converts MedCore Prisma entities into FHIR R4 JSON
 * resources suitable for export to ABDM/NDHM/third-party EHRs.
 *
 * Design notes:
 * - The `fhir` npm package (~5 MB of types, no runtime validation) is intentionally
 *   NOT added as a dependency. Instead we define the minimum R4 resource shapes
 *   inline — these are strict enough for ABDM compatibility and keep the bundle
 *   light. See `validator.ts` for runtime guards.
 * - All outputs are plain JSON objects; no Prisma relations are persisted.
 * - Input entities are typed as `any` since the caller may pass a Prisma object
 *   with arbitrary `include` shape. The mappers defensively read only the fields
 *   they need.
 * - Datetime fields are serialised via `Date.toISOString()` which produces the
 *   `YYYY-MM-DDThh:mm:ss.sssZ` form FHIR accepts.
 */

// ─── Minimal R4 Resource Type Definitions ───────────────────────────────────

export interface FhirReference {
  reference: string; // e.g. "Patient/abc-123"
  display?: string;
}

export interface FhirCoding {
  system?: string;
  code: string;
  display?: string;
}

export interface FhirCodeableConcept {
  coding?: FhirCoding[];
  text?: string;
}

export interface FhirIdentifier {
  system?: string;
  value: string;
  use?: "usual" | "official" | "temp" | "secondary" | "old";
}

export interface FhirHumanName {
  use?: "usual" | "official" | "nickname";
  text?: string;
  family?: string;
  given?: string[];
}

export interface FhirContactPoint {
  system: "phone" | "email" | "fax" | "sms" | "other";
  value: string;
  use?: "home" | "work" | "mobile";
}

export interface FhirAddress {
  use?: "home" | "work" | "temp";
  line?: string[];
  city?: string;
  state?: string;
  country?: string;
}

export interface FhirPeriod {
  start?: string;
  end?: string;
}

export interface FhirQuantity {
  value: number;
  unit?: string;
  system?: string;
  code?: string;
}

interface FhirResourceBase {
  resourceType: string;
  id: string;
  meta?: { lastUpdated?: string; profile?: string[] };
}

export interface FhirPatient extends FhirResourceBase {
  resourceType: "Patient";
  identifier: FhirIdentifier[];
  active: boolean;
  name: FhirHumanName[];
  telecom?: FhirContactPoint[];
  gender: "male" | "female" | "other" | "unknown";
  birthDate?: string;
  address?: FhirAddress[];
}

export interface FhirPractitioner extends FhirResourceBase {
  resourceType: "Practitioner";
  identifier: FhirIdentifier[];
  active: boolean;
  name: FhirHumanName[];
  telecom?: FhirContactPoint[];
  qualification?: Array<{ code: FhirCodeableConcept }>;
}

export interface FhirAppointment extends FhirResourceBase {
  resourceType: "Appointment";
  status: "proposed" | "pending" | "booked" | "arrived" | "fulfilled" | "cancelled" | "noshow" | "entered-in-error" | "checked-in" | "waitlist";
  appointmentType?: FhirCodeableConcept;
  priority?: number;
  description?: string;
  start?: string;
  end?: string;
  participant: Array<{
    actor: FhirReference;
    status: "accepted" | "declined" | "tentative" | "needs-action";
  }>;
}

export interface FhirEncounter extends FhirResourceBase {
  resourceType: "Encounter";
  status: "planned" | "arrived" | "triaged" | "in-progress" | "onleave" | "finished" | "cancelled";
  class: FhirCoding;
  subject: FhirReference;
  participant?: Array<{ individual: FhirReference }>;
  period?: FhirPeriod;
  reasonCode?: FhirCodeableConcept[];
}

export interface FhirComposition extends FhirResourceBase {
  resourceType: "Composition";
  status: "preliminary" | "final" | "amended" | "entered-in-error";
  type: FhirCodeableConcept;
  subject: FhirReference;
  encounter?: FhirReference;
  date: string;
  author: FhirReference[];
  title: string;
  section?: Array<{
    title: string;
    text?: { status: "generated"; div: string };
    entry?: FhirReference[];
  }>;
}

export interface FhirMedicationRequest extends FhirResourceBase {
  resourceType: "MedicationRequest";
  status: "active" | "on-hold" | "cancelled" | "completed" | "entered-in-error" | "stopped" | "draft" | "unknown";
  intent: "proposal" | "plan" | "order" | "original-order" | "reflex-order" | "filler-order" | "instance-order" | "option";
  medicationCodeableConcept: FhirCodeableConcept;
  subject: FhirReference;
  requester?: FhirReference;
  authoredOn?: string;
  // Shared identifier across MedicationRequests that came from the same
  // Prescription. Used by the reverse mapper to recover the source
  // prescription id on round-trip without depending on resource.id encoding.
  groupIdentifier?: FhirIdentifier;
  dosageInstruction?: Array<{
    text?: string;
    timing?: { code?: FhirCodeableConcept };
    route?: FhirCodeableConcept;
  }>;
  dispenseRequest?: {
    numberOfRepeatsAllowed?: number;
    expectedSupplyDuration?: FhirQuantity;
  };
}

export interface FhirServiceRequest extends FhirResourceBase {
  resourceType: "ServiceRequest";
  status: "draft" | "active" | "on-hold" | "revoked" | "completed" | "entered-in-error" | "unknown";
  intent: "proposal" | "plan" | "directive" | "order" | "original-order" | "reflex-order" | "filler-order" | "instance-order" | "option";
  priority?: "routine" | "urgent" | "asap" | "stat";
  code: FhirCodeableConcept;
  subject: FhirReference;
  requester?: FhirReference;
  authoredOn?: string;
}

export interface FhirObservation extends FhirResourceBase {
  resourceType: "Observation";
  status: "registered" | "preliminary" | "final" | "amended" | "corrected" | "cancelled" | "entered-in-error" | "unknown";
  code: FhirCodeableConcept;
  subject: FhirReference;
  effectiveDateTime?: string;
  issued?: string;
  valueString?: string;
  valueQuantity?: FhirQuantity;
  interpretation?: FhirCodeableConcept[];
  referenceRange?: Array<{ text?: string }>;
}

export interface FhirDiagnosticReport extends FhirResourceBase {
  resourceType: "DiagnosticReport";
  status: "registered" | "partial" | "preliminary" | "final" | "amended" | "corrected" | "appended" | "cancelled" | "entered-in-error" | "unknown";
  code: FhirCodeableConcept;
  subject: FhirReference;
  effectiveDateTime?: string;
  issued?: string;
  performer?: FhirReference[];
  result?: FhirReference[];
  conclusion?: string;
  basedOn?: FhirReference[];
}

export interface FhirAllergyIntolerance extends FhirResourceBase {
  resourceType: "AllergyIntolerance";
  clinicalStatus?: FhirCodeableConcept;
  verificationStatus?: FhirCodeableConcept;
  type?: "allergy" | "intolerance";
  criticality?: "low" | "high" | "unable-to-assess";
  code?: FhirCodeableConcept;
  patient: FhirReference;
  recordedDate?: string;
  reaction?: Array<{
    manifestation: FhirCodeableConcept[];
    severity?: "mild" | "moderate" | "severe";
  }>;
}

export type FhirResource =
  | FhirPatient
  | FhirPractitioner
  | FhirAppointment
  | FhirEncounter
  | FhirComposition
  | FhirMedicationRequest
  | FhirServiceRequest
  | FhirObservation
  | FhirDiagnosticReport
  | FhirAllergyIntolerance;

// ─── Helpers ────────────────────────────────────────────────────────────────

/** System URIs for identifiers commonly used in Indian healthcare. */
export const SYSTEMS = {
  MR_NUMBER: "https://medcore.health/patient/mr-number",
  ABHA: "https://healthid.ndhm.gov.in",
  AADHAAR: "https://uidai.gov.in",
  DOCTOR_USER_ID: "https://medcore.health/practitioner/user-id",
  ICD10: "http://hl7.org/fhir/sid/icd-10",
  LOINC: "http://loinc.org",
  SNOMED: "http://snomed.info/sct",
  UCUM: "http://unitsofmeasure.org",
  INTERPRETATION: "http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation",
  ALLERGY_CLINICAL: "http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical",
  ALLERGY_VERIFICATION: "http://terminology.hl7.org/CodeSystem/allergyintolerance-verification",
  LOINC_CONSULT_NOTE: "http://loinc.org",
} as const;

/** Split a single `name` string into family / given parts, best-effort. */
function splitName(fullName: string | null | undefined): { family?: string; given?: string[]; text: string } {
  const text = (fullName || "").trim();
  if (!text) return { text: "" };
  const parts = text.split(/\s+/);
  if (parts.length === 1) return { given: [parts[0]], text };
  return { given: parts.slice(0, -1), family: parts[parts.length - 1], text };
}

/** Convert a JS Date | ISO string | null to a FHIR dateTime string. */
function toIso(d: Date | string | null | undefined): string | undefined {
  if (!d) return undefined;
  if (d instanceof Date) return d.toISOString();
  return new Date(d).toISOString();
}

/** Convert a JS Date to a FHIR date (YYYY-MM-DD). */
function toFhirDate(d: Date | string | null | undefined): string | undefined {
  const iso = toIso(d);
  return iso ? iso.slice(0, 10) : undefined;
}

/** Map MedCore gender enum (MALE|FEMALE|OTHER) → FHIR administrative gender. */
function mapGender(g: string | null | undefined): "male" | "female" | "other" | "unknown" {
  switch ((g || "").toUpperCase()) {
    case "MALE":
      return "male";
    case "FEMALE":
      return "female";
    case "OTHER":
      return "other";
    default:
      return "unknown";
  }
}

/** Map MedCore AppointmentStatus → FHIR Appointment.status. */
function mapAppointmentStatus(s: string | null | undefined): FhirAppointment["status"] {
  switch ((s || "").toUpperCase()) {
    case "BOOKED":
      return "booked";
    case "CHECKED_IN":
      return "checked-in";
    case "IN_CONSULTATION":
      return "arrived";
    case "COMPLETED":
      return "fulfilled";
    case "CANCELLED":
      return "cancelled";
    case "NO_SHOW":
      return "noshow";
    default:
      return "pending";
  }
}

/** Map lab priority → FHIR ServiceRequest priority. */
function mapLabPriority(p: string | null | undefined): "routine" | "urgent" | "asap" | "stat" {
  switch ((p || "").toUpperCase()) {
    case "STAT":
      return "stat";
    case "URGENT":
      return "urgent";
    case "ASAP":
      return "asap";
    default:
      return "routine";
  }
}

/** Map LabResultFlag → FHIR Observation interpretation coding. */
function mapResultFlag(flag: string | null | undefined): FhirCodeableConcept | undefined {
  const code = (flag || "").toUpperCase();
  const map: Record<string, { code: string; display: string }> = {
    NORMAL: { code: "N", display: "Normal" },
    HIGH: { code: "H", display: "High" },
    LOW: { code: "L", display: "Low" },
    CRITICAL_HIGH: { code: "HH", display: "Critical high" },
    CRITICAL_LOW: { code: "LL", display: "Critical low" },
    ABNORMAL: { code: "A", display: "Abnormal" },
  };
  const entry = map[code];
  if (!entry) return undefined;
  return { coding: [{ system: SYSTEMS.INTERPRETATION, ...entry }], text: entry.display };
}

/** Map AllergySeverity → FHIR criticality and reaction.severity. */
function mapAllergySeverity(s: string | null | undefined): {
  criticality: "low" | "high" | "unable-to-assess";
  reactionSeverity: "mild" | "moderate" | "severe";
} {
  switch ((s || "").toUpperCase()) {
    case "SEVERE":
    case "LIFE_THREATENING":
      return { criticality: "high", reactionSeverity: "severe" };
    case "MODERATE":
      return { criticality: "low", reactionSeverity: "moderate" };
    default:
      return { criticality: "low", reactionSeverity: "mild" };
  }
}

// ─── Resource Mappers ───────────────────────────────────────────────────────

/**
 * Map a Prisma `Patient` (optionally with `user` relation) to a FHIR Patient.
 *
 * Expected input shape:
 *   { id, mrNumber, dateOfBirth, gender, address, abhaId, aadhaarMasked,
 *     user?: { name, email, phone } }
 */
export function patientToFhir(patient: any): FhirPatient {
  if (!patient?.id) throw new Error("patientToFhir: missing patient.id");

  const identifiers: FhirIdentifier[] = [];
  if (patient.mrNumber) {
    identifiers.push({ system: SYSTEMS.MR_NUMBER, value: patient.mrNumber, use: "official" });
  }
  if (patient.abhaId) {
    identifiers.push({ system: SYSTEMS.ABHA, value: patient.abhaId, use: "official" });
  }
  if (patient.aadhaarMasked) {
    identifiers.push({ system: SYSTEMS.AADHAAR, value: patient.aadhaarMasked, use: "secondary" });
  }

  const nameParts = splitName(patient.user?.name);
  const names: FhirHumanName[] = nameParts.text
    ? [{ use: "official", text: nameParts.text, family: nameParts.family, given: nameParts.given }]
    : [{ use: "official", text: `Patient ${patient.mrNumber ?? patient.id}` }];

  const telecom: FhirContactPoint[] = [];
  if (patient.user?.phone) telecom.push({ system: "phone", value: patient.user.phone, use: "mobile" });
  if (patient.user?.email) telecom.push({ system: "email", value: patient.user.email });

  const address: FhirAddress[] | undefined = patient.address
    ? [{ use: "home", line: [patient.address], country: "IN" }]
    : undefined;

  return {
    resourceType: "Patient",
    id: patient.id,
    meta: { lastUpdated: toIso(patient.updatedAt) ?? toIso(new Date()) },
    identifier: identifiers,
    active: true,
    name: names,
    telecom: telecom.length ? telecom : undefined,
    gender: mapGender(patient.gender),
    birthDate: toFhirDate(patient.dateOfBirth),
    address,
  };
}

/**
 * Map a Prisma `Doctor` (with `user` relation) to a FHIR Practitioner.
 */
export function doctorToFhir(doctor: any): FhirPractitioner {
  if (!doctor?.id) throw new Error("doctorToFhir: missing doctor.id");

  const identifiers: FhirIdentifier[] = [
    { system: SYSTEMS.DOCTOR_USER_ID, value: doctor.id, use: "official" },
  ];

  const nameParts = splitName(doctor.user?.name);
  const names: FhirHumanName[] = nameParts.text
    ? [{ use: "official", text: `Dr. ${nameParts.text}`, family: nameParts.family, given: nameParts.given }]
    : [{ use: "official", text: `Doctor ${doctor.id}` }];

  const telecom: FhirContactPoint[] = [];
  if (doctor.user?.phone) telecom.push({ system: "phone", value: doctor.user.phone, use: "work" });
  if (doctor.user?.email) telecom.push({ system: "email", value: doctor.user.email, use: "work" });

  const qualification = doctor.qualification
    ? [{ code: { text: doctor.qualification, coding: doctor.specialization ? [{ code: doctor.specialization, display: doctor.specialization }] : undefined } }]
    : undefined;

  return {
    resourceType: "Practitioner",
    id: doctor.id,
    identifier: identifiers,
    active: doctor.user?.isActive !== false,
    name: names,
    telecom: telecom.length ? telecom : undefined,
    qualification,
  };
}

/**
 * Map a Prisma `Appointment` to a FHIR Appointment resource.
 */
export function appointmentToFhir(appt: any): FhirAppointment {
  if (!appt?.id) throw new Error("appointmentToFhir: missing appointment.id");

  // Compose a start datetime from (date + slotStart) when available.
  let start: string | undefined;
  let end: string | undefined;
  if (appt.date) {
    const baseDate = toFhirDate(appt.date);
    if (baseDate && appt.slotStart) {
      start = new Date(`${baseDate}T${appt.slotStart}:00`).toISOString();
    }
    if (baseDate && appt.slotEnd) {
      end = new Date(`${baseDate}T${appt.slotEnd}:00`).toISOString();
    }
  }
  if (appt.consultationStartedAt) start = toIso(appt.consultationStartedAt);
  if (appt.consultationEndedAt) end = toIso(appt.consultationEndedAt);

  const priorityMap: Record<string, number> = { URGENT: 1, HIGH: 2, NORMAL: 5, LOW: 9 };

  return {
    resourceType: "Appointment",
    id: appt.id,
    status: mapAppointmentStatus(appt.status),
    appointmentType: appt.type ? { text: String(appt.type) } : undefined,
    priority: priorityMap[String(appt.priority || "NORMAL").toUpperCase()] ?? 5,
    description: appt.notes ?? undefined,
    start,
    end,
    participant: [
      {
        actor: { reference: `Patient/${appt.patientId}` },
        status: "accepted",
      },
      {
        actor: { reference: `Practitioner/${appt.doctorId}` },
        status: "accepted",
      },
    ],
  };
}

/**
 * Map a Prisma `Consultation` (with `appointment` include) to a FHIR Encounter.
 * Requires appointment.patientId, appointment.doctorId on the relation.
 */
export function consultationToEncounter(consultation: any): FhirEncounter {
  if (!consultation?.id) throw new Error("consultationToEncounter: missing consultation.id");
  const patientId = consultation.appointment?.patientId ?? consultation.patientId;
  const doctorId = consultation.doctorId ?? consultation.appointment?.doctorId;
  if (!patientId) throw new Error("consultationToEncounter: missing patientId (need appointment include)");

  const start = toIso(consultation.appointment?.consultationStartedAt) ?? toIso(consultation.createdAt);
  const end = toIso(consultation.appointment?.consultationEndedAt);

  return {
    resourceType: "Encounter",
    id: consultation.id,
    status: end ? "finished" : "in-progress",
    class: {
      system: "http://terminology.hl7.org/CodeSystem/v3-ActCode",
      code: "AMB",
      display: "ambulatory",
    },
    subject: { reference: `Patient/${patientId}` },
    participant: doctorId ? [{ individual: { reference: `Practitioner/${doctorId}` } }] : undefined,
    period: start || end ? { start, end } : undefined,
    reasonCode: consultation.findings ? [{ text: consultation.findings }] : undefined,
  };
}

/**
 * Build a FHIR Composition (OP Consultation bundle header per NDHM profile).
 */
export function consultationToComposition(consultation: any): FhirComposition {
  if (!consultation?.id) throw new Error("consultationToComposition: missing consultation.id");
  const patientId = consultation.appointment?.patientId ?? consultation.patientId;
  const doctorId = consultation.doctorId ?? consultation.appointment?.doctorId;
  if (!patientId || !doctorId) {
    throw new Error("consultationToComposition: requires appointment include with patientId/doctorId");
  }

  return {
    resourceType: "Composition",
    id: `comp-${consultation.id}`,
    status: "final",
    type: {
      coding: [
        { system: SYSTEMS.LOINC_CONSULT_NOTE, code: "11488-4", display: "Consult note" },
      ],
      text: "OP Consultation",
    },
    subject: { reference: `Patient/${patientId}` },
    encounter: { reference: `Encounter/${consultation.id}` },
    date: toIso(consultation.updatedAt) ?? toIso(consultation.createdAt) ?? toIso(new Date())!,
    author: [{ reference: `Practitioner/${doctorId}` }],
    title: "OP Consultation Record",
    section: [
      consultation.findings
        ? {
            title: "Clinical findings",
            text: { status: "generated" as const, div: `<div xmlns="http://www.w3.org/1999/xhtml">${escapeXml(consultation.findings)}</div>` },
          }
        : null,
      consultation.notes
        ? {
            title: "Consultation note",
            text: { status: "generated" as const, div: `<div xmlns="http://www.w3.org/1999/xhtml">${escapeXml(consultation.notes)}</div>` },
          }
        : null,
    ].filter(Boolean) as FhirComposition["section"],
  };
}

/**
 * Map a Prisma `Prescription` + `PrescriptionItem[]` to one MedicationRequest
 * per item. MedicationRequest is per-medication in FHIR.
 */
export function prescriptionToMedicationRequests(prescription: any): FhirMedicationRequest[] {
  if (!prescription?.id) throw new Error("prescriptionToMedicationRequests: missing prescription.id");
  if (!Array.isArray(prescription.items)) return [];

  return prescription.items.map((item: any, idx: number): FhirMedicationRequest => ({
    resourceType: "MedicationRequest",
    id: `${prescription.id}-${item.id ?? idx}`,
    status: "active",
    intent: "order",
    medicationCodeableConcept: { text: item.medicineName },
    subject: { reference: `Patient/${prescription.patientId}` },
    requester: { reference: `Practitioner/${prescription.doctorId}` },
    authoredOn: toIso(prescription.createdAt),
    groupIdentifier: {
      system: "http://medcore/prescription-id",
      value: prescription.id,
    },
    dosageInstruction: [
      {
        text: [item.dosage, item.frequency, item.duration].filter(Boolean).join(" — "),
        timing: item.frequency ? { code: { text: item.frequency } } : undefined,
      },
    ],
    dispenseRequest:
      item.refills && item.refills > 0
        ? { numberOfRepeatsAllowed: item.refills }
        : undefined,
  }));
}

/**
 * Map a Prisma `LabOrder` (with items + test relation) to a FHIR ServiceRequest.
 */
export function labOrderToServiceRequest(order: any): FhirServiceRequest {
  if (!order?.id) throw new Error("labOrderToServiceRequest: missing order.id");

  // If multiple items, use the first test's name; otherwise fall back to notes.
  const firstTest = Array.isArray(order.items) ? order.items[0]?.test : undefined;
  const code: FhirCodeableConcept = firstTest
    ? {
        coding: firstTest.code ? [{ code: firstTest.code, display: firstTest.name }] : undefined,
        text: firstTest.name ?? order.notes ?? "Laboratory test",
      }
    : { text: order.notes ?? "Laboratory test" };

  const statusMap: Record<string, FhirServiceRequest["status"]> = {
    ORDERED: "active",
    SAMPLE_COLLECTED: "active",
    IN_PROGRESS: "active",
    COMPLETED: "completed",
    CANCELLED: "revoked",
    REJECTED: "entered-in-error",
  };

  return {
    resourceType: "ServiceRequest",
    id: order.id,
    status: statusMap[String(order.status || "ORDERED").toUpperCase()] ?? "active",
    intent: "order",
    priority: mapLabPriority(order.priority),
    code,
    subject: { reference: `Patient/${order.patientId}` },
    requester: { reference: `Practitioner/${order.doctorId}` },
    authoredOn: toIso(order.orderedAt),
  };
}

/**
 * Map a single Prisma `LabResult` to a FHIR Observation.
 * `patientId` must be passed explicitly because LabResult.orderItem doesn't
 * carry the patient reference natively.
 */
export function labResultToObservation(
  result: any,
  ctx: { patientId: string; orderId?: string; testCode?: string; testName?: string }
): FhirObservation {
  if (!result?.id) throw new Error("labResultToObservation: missing result.id");
  if (!ctx.patientId) throw new Error("labResultToObservation: missing patientId context");

  // Attempt numeric coercion for valueQuantity; fall back to valueString.
  const numeric = Number(result.value);
  const useQuantity = result.value != null && !Number.isNaN(numeric) && result.unit;

  return {
    resourceType: "Observation",
    id: result.id,
    status: result.verifiedAt ? "final" : "preliminary",
    code: {
      coding: ctx.testCode ? [{ code: ctx.testCode, display: ctx.testName ?? result.parameter }] : undefined,
      text: result.parameter,
    },
    subject: { reference: `Patient/${ctx.patientId}` },
    effectiveDateTime: toIso(result.reportedAt),
    issued: toIso(result.verifiedAt ?? result.reportedAt),
    ...(useQuantity
      ? { valueQuantity: { value: numeric, unit: result.unit ?? undefined } }
      : { valueString: String(result.value) }),
    interpretation: (() => {
      const interp = mapResultFlag(result.flag);
      return interp ? [interp] : undefined;
    })(),
    referenceRange: result.normalRange ? [{ text: result.normalRange }] : undefined,
  };
}

/**
 * Bundle a LabOrder plus its results into a FHIR DiagnosticReport that references
 * the corresponding ServiceRequest and Observations.
 */
export function labOrderToDiagnosticReport(
  order: any,
  resultIds: string[]
): FhirDiagnosticReport {
  if (!order?.id) throw new Error("labOrderToDiagnosticReport: missing order.id");

  const firstTest = Array.isArray(order.items) ? order.items[0]?.test : undefined;
  const code: FhirCodeableConcept = firstTest
    ? { coding: firstTest.code ? [{ code: firstTest.code, display: firstTest.name }] : undefined, text: firstTest.name ?? "Laboratory report" }
    : { text: "Laboratory report" };

  const statusMap: Record<string, FhirDiagnosticReport["status"]> = {
    ORDERED: "registered",
    SAMPLE_COLLECTED: "partial",
    IN_PROGRESS: "partial",
    COMPLETED: "final",
    CANCELLED: "cancelled",
    REJECTED: "entered-in-error",
  };

  return {
    resourceType: "DiagnosticReport",
    id: `report-${order.id}`,
    status: statusMap[String(order.status || "ORDERED").toUpperCase()] ?? "partial",
    code,
    subject: { reference: `Patient/${order.patientId}` },
    effectiveDateTime: toIso(order.completedAt ?? order.collectedAt ?? order.orderedAt),
    issued: toIso(order.completedAt ?? order.orderedAt),
    performer: [{ reference: `Practitioner/${order.doctorId}` }],
    basedOn: [{ reference: `ServiceRequest/${order.id}` }],
    result: resultIds.map((id) => ({ reference: `Observation/${id}` })),
  };
}

/**
 * Map a Prisma `PatientAllergy` to a FHIR AllergyIntolerance.
 */
export function allergyToFhir(allergy: any): FhirAllergyIntolerance {
  if (!allergy?.id) throw new Error("allergyToFhir: missing allergy.id");
  if (!allergy.patientId) throw new Error("allergyToFhir: missing patientId");

  const { criticality, reactionSeverity } = mapAllergySeverity(allergy.severity);

  return {
    resourceType: "AllergyIntolerance",
    id: allergy.id,
    clinicalStatus: {
      coding: [{ system: SYSTEMS.ALLERGY_CLINICAL, code: "active", display: "Active" }],
    },
    verificationStatus: {
      coding: [{ system: SYSTEMS.ALLERGY_VERIFICATION, code: "confirmed", display: "Confirmed" }],
    },
    type: "allergy",
    criticality,
    code: { text: allergy.allergen },
    patient: { reference: `Patient/${allergy.patientId}` },
    recordedDate: toIso(allergy.notedAt),
    reaction: allergy.reaction
      ? [{ manifestation: [{ text: allergy.reaction }], severity: reactionSeverity }]
      : undefined,
  };
}

// ─── Internal helpers ───────────────────────────────────────────────────────

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
