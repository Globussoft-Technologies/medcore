/**
 * ABDM Health Records — FHIR R4 bundle construction and push.
 *
 * As a HIP (Health Information Provider) MedCore must expose patient care
 * contexts as FHIR R4 bundles. ABDM currently supports the following
 * HI-types under the India FHIR IG (NRCES profiles):
 *
 *   • OPConsultation     — outpatient SOAP notes
 *   • DischargeSummary   — inpatient discharge summary
 *   • DiagnosticReport   — lab / imaging reports
 *
 * Flow:
 *   1. After a consultation/discharge/report, call `linkCareContext()` to
 *      advertise the new care-context to the Gateway's HIU discovery API.
 *   2. On a subsequent `health-information/request` (driven by a GRANTED
 *      consent artefact), we build and push the FHIR bundle via
 *      `pushHealthInformation()`.
 *
 * ── Stub vs Real ──────────────────────────────────────────────────────────
 * The FHIR bundle builders are real (valid R4 shape, India profiles). The
 * encryption of the HI payload (ABDM requires ECDH + AES-GCM with the HIU's
 * public key) is STUBBED — we ship the bundle as base64 JSON with a
 * placeholder key-material object. Production deploy must replace
 * `encryptBundle()` with an ECDH implementation using `node:crypto`.
 */

import { prisma } from "@medcore/db";
import { abdmRequest, ABDMError } from "./client";

// ── FHIR R4 types (minimal) ───────────────────────────────────────────────

export interface FhirBundle {
  resourceType: "Bundle";
  id: string;
  meta: { lastUpdated: string; profile: string[] };
  identifier?: { system: string; value: string };
  type: "document";
  timestamp: string;
  entry: FhirBundleEntry[];
}

export interface FhirBundleEntry {
  fullUrl: string;
  resource: Record<string, unknown>;
}

export type CareContextType = "OPConsultation" | "DischargeSummary" | "DiagnosticReport";

// ── Bundle builders ───────────────────────────────────────────────────────

const INDIA_FHIR_BASE = "https://nrces.in/ndhm/fhir/r4/StructureDefinition";

function baseBundle(
  profile: string,
  patientName: string,
  patientAbha: string,
  entries: FhirBundleEntry[]
): FhirBundle {
  const now = new Date().toISOString();
  const bundleId = crypto.randomUUID();
  return {
    resourceType: "Bundle",
    id: bundleId,
    meta: { lastUpdated: now, profile: [`${INDIA_FHIR_BASE}/${profile}`] },
    identifier: { system: "https://medcore.health/bundles", value: bundleId },
    type: "document",
    timestamp: now,
    entry: [
      {
        fullUrl: `urn:uuid:${bundleId}-composition`,
        resource: {
          resourceType: "Composition",
          id: `${bundleId}-composition`,
          status: "final",
          type: { text: profile },
          subject: { display: patientName, identifier: { system: "https://abdm.gov.in/abha", value: patientAbha } },
          date: now,
          title: profile,
          section: entries.map((e) => ({ entry: [{ reference: e.fullUrl }] })),
        },
      },
      ...entries,
    ],
  };
}

/**
 * Build an OPConsultation FHIR bundle from an AIScribeSession or manual SOAP.
 */
export function buildOPConsultationBundle(args: {
  patientName: string;
  patientAbha: string;
  chiefComplaint: string;
  diagnosis: string;
  medications: { name: string; dose: string; frequency: string; duration: string }[];
  doctorName: string;
  visitDate: Date;
}): FhirBundle {
  const entries: FhirBundleEntry[] = [
    {
      fullUrl: `urn:uuid:${crypto.randomUUID()}`,
      resource: {
        resourceType: "Condition",
        code: { text: args.diagnosis },
        subject: { display: args.patientName },
        recordedDate: args.visitDate.toISOString(),
      },
    },
    ...args.medications.map((m) => ({
      fullUrl: `urn:uuid:${crypto.randomUUID()}`,
      resource: {
        resourceType: "MedicationRequest",
        status: "active",
        intent: "order",
        medicationCodeableConcept: { text: m.name },
        subject: { display: args.patientName },
        dosageInstruction: [{ text: `${m.dose} ${m.frequency} for ${m.duration}` }],
      },
    })),
  ];
  return baseBundle("OPConsultRecord", args.patientName, args.patientAbha, entries);
}

export function buildDischargeSummaryBundle(args: {
  patientName: string;
  patientAbha: string;
  admittingDiagnosis: string;
  dischargeDiagnosis: string;
  proceduresPerformed: string[];
  medicationsOnDischarge: string[];
  admissionDate: Date;
  dischargeDate: Date;
  doctorName: string;
}): FhirBundle {
  const entries: FhirBundleEntry[] = [
    {
      fullUrl: `urn:uuid:${crypto.randomUUID()}`,
      resource: {
        resourceType: "Encounter",
        status: "finished",
        class: { system: "http://terminology.hl7.org/CodeSystem/v3-ActCode", code: "IMP", display: "inpatient encounter" },
        subject: { display: args.patientName },
        period: { start: args.admissionDate.toISOString(), end: args.dischargeDate.toISOString() },
        reasonCode: [{ text: args.admittingDiagnosis }],
      },
    },
    {
      fullUrl: `urn:uuid:${crypto.randomUUID()}`,
      resource: {
        resourceType: "Condition",
        code: { text: args.dischargeDiagnosis },
        subject: { display: args.patientName },
        recordedDate: args.dischargeDate.toISOString(),
      },
    },
    ...args.proceduresPerformed.map((p) => ({
      fullUrl: `urn:uuid:${crypto.randomUUID()}`,
      resource: {
        resourceType: "Procedure",
        status: "completed",
        code: { text: p },
        subject: { display: args.patientName },
        performedDateTime: args.dischargeDate.toISOString(),
      },
    })),
    ...args.medicationsOnDischarge.map((m) => ({
      fullUrl: `urn:uuid:${crypto.randomUUID()}`,
      resource: {
        resourceType: "MedicationStatement",
        status: "active",
        medicationCodeableConcept: { text: m },
        subject: { display: args.patientName },
      },
    })),
  ];
  return baseBundle("DischargeSummaryRecord", args.patientName, args.patientAbha, entries);
}

export function buildDiagnosticReportBundle(args: {
  patientName: string;
  patientAbha: string;
  reportName: string;
  conclusion: string;
  observations: { code: string; value: string; unit?: string }[];
  reportDate: Date;
  orderedBy: string;
}): FhirBundle {
  const entries: FhirBundleEntry[] = [
    {
      fullUrl: `urn:uuid:${crypto.randomUUID()}`,
      resource: {
        resourceType: "DiagnosticReport",
        status: "final",
        code: { text: args.reportName },
        subject: { display: args.patientName },
        effectiveDateTime: args.reportDate.toISOString(),
        conclusion: args.conclusion,
      },
    },
    ...args.observations.map((o) => ({
      fullUrl: `urn:uuid:${crypto.randomUUID()}`,
      resource: {
        resourceType: "Observation",
        status: "final",
        code: { text: o.code },
        subject: { display: args.patientName },
        valueQuantity: o.unit
          ? { value: Number.parseFloat(o.value) || 0, unit: o.unit }
          : undefined,
        valueString: o.unit ? undefined : o.value,
      },
    })),
  ];
  return baseBundle("DiagnosticReportRecord", args.patientName, args.patientAbha, entries);
}

// ── Care-context linking ──────────────────────────────────────────────────

/**
 * Advertise a care-context to the Gateway so the patient's ABHA app can
 * discover it. Persists a `CareContext` row with `lastPushedAt = now`.
 */
export async function linkCareContext(args: {
  patientId: string;
  abhaAddress: string;
  careContextRef: string;   // opaque local id, e.g. "scribe:<sessionId>"
  display: string;          // human label: "OP Consultation, 23 Apr 2026"
  type: CareContextType;
}): Promise<{ requestId: string }> {
  const requestId = crypto.randomUUID();

  await abdmRequest<void>({
    method: "POST",
    path: "/v0.5/links/context/notify",
    requestId,
    body: {
      requestId,
      timestamp: new Date().toISOString(),
      notification: {
        patient: { id: args.abhaAddress, referenceNumber: args.patientId },
        careContexts: [{ referenceNumber: args.careContextRef, display: args.display }],
      },
    },
  });

  await (prisma as any).careContext.upsert({
    where: { careContextRef: args.careContextRef },
    update: { lastPushedAt: new Date(), abhaAddress: args.abhaAddress, type: args.type },
    create: {
      patientId: args.patientId,
      abhaAddress: args.abhaAddress,
      careContextRef: args.careContextRef,
      type: args.type,
      lastPushedAt: new Date(),
    },
  });

  return { requestId };
}

// ── Push health information ───────────────────────────────────────────────

/**
 * ⚠ STUB: real ABDM requires ECDH (X25519) + AES-GCM encryption of the
 * bundle against the HIU's transient public key. The actual crypto is
 * not wired — this helper just base64-encodes the JSON so the HTTP wiring
 * can be tested end-to-end in the sandbox.
 */
function encryptBundle(
  bundle: FhirBundle,
  _hiuPublicKeyPem: string
): { encryptedContent: string; keyMaterial: { cryptoAlg: string; curve: string; dhPublicKey: { expiry: string; parameters: string; keyValue: string }; nonce: string } } {
  const content = Buffer.from(JSON.stringify(bundle)).toString("base64");
  return {
    encryptedContent: content,
    keyMaterial: {
      cryptoAlg: "ECDH",
      curve: "Curve25519",
      dhPublicKey: {
        expiry: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        parameters: "Curve25519/32byte random key",
        keyValue: "STUB_REPLACE_IN_PROD",
      },
      nonce: "STUB_REPLACE_IN_PROD",
    },
  };
}

/**
 * Push an FHIR bundle to the HIU's `dataPushUrl` (provided in the
 * `health-information/request` callback). Marked idempotent by caller.
 */
export async function pushHealthInformation(args: {
  dataPushUrl: string;
  bundle: FhirBundle;
  hiuPublicKey: string;     // PEM — supplied by HIU on request
  transactionId: string;    // supplied by HIU
  careContextRef: string;
}): Promise<void> {
  const encrypted = encryptBundle(args.bundle, args.hiuPublicKey);

  await abdmRequest<void>({
    method: "POST",
    path: args.dataPushUrl,
    absoluteUrl: true,
    body: {
      pageNumber: 1,
      pageCount: 1,
      transactionId: args.transactionId,
      entries: [
        {
          content: encrypted.encryptedContent,
          media: "application/fhir+json",
          checksum: "",
          careContextReference: args.careContextRef,
        },
      ],
      keyMaterial: encrypted.keyMaterial,
    },
    parseJson: false,
  });

  // Mark the care-context as freshly pushed.
  await (prisma as any).careContext
    .update({
      where: { careContextRef: args.careContextRef },
      data: { lastPushedAt: new Date() },
    })
    .catch(() => {
      // Best-effort: missing row should not fail the push.
    });
}

/**
 * Raised by the Gateway when a new `health-information/request` arrives.
 * In a real deployment the handler would load the consent artefact,
 * verify the signature, build the bundle, and call `pushHealthInformation`.
 * Here we expose a hook so `routes/abdm.ts` can dispatch to it.
 */
export async function handleHealthInformationRequest(payload: {
  consentId: string;
  transactionId: string;
  dataPushUrl: string;
  hiuPublicKey: string;
  hiTypes: CareContextType[];
  dateRange: { from: string; to: string };
}): Promise<{ queued: true }> {
  // Actual implementation: enqueue a job that fans out care-context bundles.
  // For the scaffold, we just log and return — real logic lives in the
  // worker that also respects the consent's dateRange and hiTypes filter.
  console.log(
    JSON.stringify({
      level: "info",
      event: "abdm_health_information_request_queued",
      consentId: payload.consentId,
      transactionId: payload.transactionId,
      hiTypes: payload.hiTypes,
      ts: new Date().toISOString(),
    })
  );
  if (!payload.dataPushUrl || !payload.hiuPublicKey) {
    throw new ABDMError("HIU did not supply dataPushUrl / public key", 400);
  }
  return { queued: true };
}
