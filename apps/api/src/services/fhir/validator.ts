/**
 * Hand-rolled FHIR R4 validators — rather than pulling in the 5-MB `fhir`
 * package (which is mostly TS declarations anyway), we use type guards that
 * check the minimum structural invariants FHIR R4 requires.
 *
 * These are NOT full Schematron-level validators; they catch the common
 * shape bugs that break ABDM/NDHM ingestion:
 *   • missing resourceType / id
 *   • invalid status enum values
 *   • malformed reference strings
 *
 * For stricter JSON Schema validation you can plug in HAPI FHIR server-side.
 */

import type { FhirResource } from "./resources";
import type { FhirBundle } from "./bundle";

export interface ValidationIssue {
  severity: "error" | "warning";
  path: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
}

const REFERENCE_RE = /^([A-Za-z]+\/[A-Za-z0-9\-.]+|urn:uuid:.+|https?:\/\/.+)$/;

function isString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function pushError(issues: ValidationIssue[], path: string, message: string) {
  issues.push({ severity: "error", path, message });
}

/**
 * Validate a single FHIR resource. Returns a `ValidationResult` — callers can
 * decide whether to throw or log.
 */
export function validateResource(res: unknown): ValidationResult {
  const issues: ValidationIssue[] = [];
  if (!res || typeof res !== "object") {
    pushError(issues, "$", "Resource must be an object");
    return { valid: false, issues };
  }

  const r = res as Record<string, any>;

  if (!isString(r.resourceType)) {
    pushError(issues, "resourceType", "resourceType is required and must be a non-empty string");
  }
  if (!isString(r.id)) {
    pushError(issues, "id", "id is required and must be a non-empty string");
  }

  // Per-resource-type structural checks
  switch (r.resourceType) {
    case "Patient":
      validatePatient(r, issues);
      break;
    case "Practitioner":
      validatePractitioner(r, issues);
      break;
    case "Appointment":
      validateAppointment(r, issues);
      break;
    case "Encounter":
      validateEncounter(r, issues);
      break;
    case "Composition":
      validateComposition(r, issues);
      break;
    case "MedicationRequest":
      validateMedicationRequest(r, issues);
      break;
    case "ServiceRequest":
      validateServiceRequest(r, issues);
      break;
    case "Observation":
      validateObservation(r, issues);
      break;
    case "DiagnosticReport":
      validateDiagnosticReport(r, issues);
      break;
    case "AllergyIntolerance":
      validateAllergyIntolerance(r, issues);
      break;
    default:
      issues.push({ severity: "warning", path: "resourceType", message: `Unknown/unsupported resourceType: ${r.resourceType}` });
  }

  return { valid: issues.filter((i) => i.severity === "error").length === 0, issues };
}

/** Validate a FHIR Bundle (metadata + each entry). */
export function validateBundle(bundle: unknown): ValidationResult {
  const issues: ValidationIssue[] = [];
  if (!bundle || typeof bundle !== "object") {
    pushError(issues, "$", "Bundle must be an object");
    return { valid: false, issues };
  }
  const b = bundle as Record<string, any>;
  if (b.resourceType !== "Bundle") pushError(issues, "resourceType", "Expected Bundle");
  if (!isString(b.type)) pushError(issues, "type", "Bundle.type is required");
  if (!Array.isArray(b.entry)) {
    pushError(issues, "entry", "Bundle.entry must be an array");
  } else {
    b.entry.forEach((e: any, idx: number) => {
      if (!e?.fullUrl || !isString(e.fullUrl)) pushError(issues, `entry[${idx}].fullUrl`, "fullUrl required");
      const sub = validateResource(e?.resource);
      for (const issue of sub.issues) {
        issues.push({ ...issue, path: `entry[${idx}].resource.${issue.path}` });
      }
    });
  }

  return { valid: issues.filter((i) => i.severity === "error").length === 0, issues };
}

/** Throws when invalid — useful for fail-fast at route handlers. */
export function assertValidResource(res: FhirResource): void {
  const result = validateResource(res);
  if (!result.valid) {
    const summary = result.issues
      .filter((i) => i.severity === "error")
      .map((i) => `${i.path}: ${i.message}`)
      .join("; ");
    throw new Error(`FHIR validation failed: ${summary}`);
  }
}

/** Throws when bundle is invalid. */
export function assertValidBundle(b: FhirBundle): void {
  const result = validateBundle(b);
  if (!result.valid) {
    const summary = result.issues
      .filter((i) => i.severity === "error")
      .map((i) => `${i.path}: ${i.message}`)
      .join("; ");
    throw new Error(`FHIR Bundle validation failed: ${summary}`);
  }
}

// ─── Per-resource validators ────────────────────────────────────────────────

function validatePatient(r: any, issues: ValidationIssue[]) {
  if (!Array.isArray(r.identifier) || r.identifier.length === 0) {
    pushError(issues, "identifier", "Patient.identifier must be a non-empty array");
  }
  if (!Array.isArray(r.name) || r.name.length === 0) {
    pushError(issues, "name", "Patient.name must be a non-empty array");
  }
  if (!["male", "female", "other", "unknown"].includes(r.gender)) {
    pushError(issues, "gender", `Invalid gender value: ${r.gender}`);
  }
  if (r.birthDate && !/^\d{4}-\d{2}-\d{2}$/.test(r.birthDate)) {
    pushError(issues, "birthDate", "birthDate must be YYYY-MM-DD");
  }
}

function validatePractitioner(r: any, issues: ValidationIssue[]) {
  if (!Array.isArray(r.identifier) || r.identifier.length === 0) {
    pushError(issues, "identifier", "Practitioner.identifier must be a non-empty array");
  }
  if (!Array.isArray(r.name) || r.name.length === 0) {
    pushError(issues, "name", "Practitioner.name must be a non-empty array");
  }
}

function validateAppointment(r: any, issues: ValidationIssue[]) {
  const allowed = ["proposed", "pending", "booked", "arrived", "fulfilled", "cancelled", "noshow", "entered-in-error", "checked-in", "waitlist"];
  if (!allowed.includes(r.status)) pushError(issues, "status", `Invalid Appointment.status: ${r.status}`);
  if (!Array.isArray(r.participant) || r.participant.length === 0) {
    pushError(issues, "participant", "Appointment.participant must be non-empty");
  } else {
    r.participant.forEach((p: any, i: number) => validateReference(p?.actor, `participant[${i}].actor`, issues));
  }
}

function validateEncounter(r: any, issues: ValidationIssue[]) {
  const allowed = ["planned", "arrived", "triaged", "in-progress", "onleave", "finished", "cancelled"];
  if (!allowed.includes(r.status)) pushError(issues, "status", `Invalid Encounter.status: ${r.status}`);
  if (!r.class?.code) pushError(issues, "class.code", "Encounter.class.code required");
  validateReference(r.subject, "subject", issues);
}

function validateComposition(r: any, issues: ValidationIssue[]) {
  const allowed = ["preliminary", "final", "amended", "entered-in-error"];
  if (!allowed.includes(r.status)) pushError(issues, "status", `Invalid Composition.status: ${r.status}`);
  if (!r.type) pushError(issues, "type", "Composition.type required");
  validateReference(r.subject, "subject", issues);
  if (!isString(r.date)) pushError(issues, "date", "Composition.date required");
  if (!Array.isArray(r.author) || r.author.length === 0) pushError(issues, "author", "Composition.author required");
  if (!isString(r.title)) pushError(issues, "title", "Composition.title required");
}

function validateMedicationRequest(r: any, issues: ValidationIssue[]) {
  const allowed = ["active", "on-hold", "cancelled", "completed", "entered-in-error", "stopped", "draft", "unknown"];
  if (!allowed.includes(r.status)) pushError(issues, "status", `Invalid MedicationRequest.status: ${r.status}`);
  if (!r.intent) pushError(issues, "intent", "MedicationRequest.intent required");
  if (!r.medicationCodeableConcept?.text && !r.medicationCodeableConcept?.coding?.length) {
    pushError(issues, "medicationCodeableConcept", "MedicationRequest.medicationCodeableConcept requires text or coding");
  }
  validateReference(r.subject, "subject", issues);
}

function validateServiceRequest(r: any, issues: ValidationIssue[]) {
  const allowed = ["draft", "active", "on-hold", "revoked", "completed", "entered-in-error", "unknown"];
  if (!allowed.includes(r.status)) pushError(issues, "status", `Invalid ServiceRequest.status: ${r.status}`);
  if (!r.intent) pushError(issues, "intent", "ServiceRequest.intent required");
  if (!r.code?.text && !r.code?.coding?.length) pushError(issues, "code", "ServiceRequest.code required");
  validateReference(r.subject, "subject", issues);
}

function validateObservation(r: any, issues: ValidationIssue[]) {
  const allowed = ["registered", "preliminary", "final", "amended", "corrected", "cancelled", "entered-in-error", "unknown"];
  if (!allowed.includes(r.status)) pushError(issues, "status", `Invalid Observation.status: ${r.status}`);
  if (!r.code?.text && !r.code?.coding?.length) pushError(issues, "code", "Observation.code required");
  validateReference(r.subject, "subject", issues);
}

function validateDiagnosticReport(r: any, issues: ValidationIssue[]) {
  const allowed = ["registered", "partial", "preliminary", "final", "amended", "corrected", "appended", "cancelled", "entered-in-error", "unknown"];
  if (!allowed.includes(r.status)) pushError(issues, "status", `Invalid DiagnosticReport.status: ${r.status}`);
  if (!r.code?.text && !r.code?.coding?.length) pushError(issues, "code", "DiagnosticReport.code required");
  validateReference(r.subject, "subject", issues);
}

function validateAllergyIntolerance(r: any, issues: ValidationIssue[]) {
  validateReference(r.patient, "patient", issues);
  if (r.criticality && !["low", "high", "unable-to-assess"].includes(r.criticality)) {
    pushError(issues, "criticality", `Invalid criticality: ${r.criticality}`);
  }
}

function validateReference(ref: any, path: string, issues: ValidationIssue[]) {
  if (!ref || !isString(ref.reference)) {
    pushError(issues, `${path}.reference`, "Reference required");
    return;
  }
  if (!REFERENCE_RE.test(ref.reference)) {
    pushError(issues, `${path}.reference`, `Malformed reference: ${ref.reference}`);
  }
}
