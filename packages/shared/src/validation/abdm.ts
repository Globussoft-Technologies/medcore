// ABDM / ABHA validation (2026-06 — HIP + HIU module).
//
// Centralises the Zod schemas for the ABDM routes (apps/api/src/routes/abdm.ts)
// so the API and the web client share one source of truth. The link/verify/
// consent/care-context schemas mirror what was previously inline in the route;
// the HIU-fetch / records / upload schemas are new for the module completion.
//
// HI-types + consent purposes match the ABDM vocabulary used by the service
// layer (services/abdm/consent.ts) — keep them in lockstep.

import { z } from "zod";

// ─── Shared vocab ─────────────────────────────────────────────────────
export const ABHA_HI_TYPES = [
  "OPConsultation",
  "Prescription",
  "DischargeSummary",
  "DiagnosticReport",
  "ImmunizationRecord",
  "HealthDocumentRecord",
  "WellnessRecord",
] as const;
export type AbhaHiType = (typeof ABHA_HI_TYPES)[number];

export const ABDM_CONSENT_PURPOSES = [
  "CAREMGT",
  "BTG",
  "PUBHLTH",
  "HPAYMT",
  "DSRCH",
  "PATRQT",
] as const;
export type AbdmConsentPurpose = (typeof ABDM_CONSENT_PURPOSES)[number];

// Care-context / record types MedCore can author as a HIP.
export const ABDM_CARE_CONTEXT_TYPES = [
  "OPConsultation",
  "DischargeSummary",
  "DiagnosticReport",
] as const;
export type AbdmCareContextType = (typeof ABDM_CARE_CONTEXT_TYPES)[number];

const abhaAddress = z
  .string()
  .trim()
  .regex(
    /^[a-zA-Z0-9._-]{3,30}@[a-zA-Z0-9]+$/,
    "ABHA address must look like handle@domain (e.g. rahul@sbx)",
  );
const abhaNumber = z
  .string()
  .trim()
  .regex(/^\d{2}-\d{4}-\d{4}-\d{4}$/, "ABHA number must be 14 digits (NN-NNNN-NNNN-NNNN)");

// ─── ABHA verify / link / delink ──────────────────────────────────────
export const sendAbhaOtpSchema = z
  .object({
    mobile: z.string().trim().regex(/^\d{10}$/, "Mobile must be 10 digits").optional(),
    aadhaar: z.string().trim().regex(/^\d{12}$/, "Aadhaar must be 12 digits").optional(),
  })
  .refine((d) => d.mobile || d.aadhaar, {
    message: "Provide a mobile or aadhaar number",
  });
export type SendAbhaOtpInput = z.infer<typeof sendAbhaOtpSchema>;

export const verifyAbhaSchema = z
  .object({
    abhaAddress: abhaAddress.optional(),
    abhaNumber: abhaNumber.optional(),
  })
  .refine((d) => d.abhaAddress || d.abhaNumber, {
    message: "Provide an ABHA address or ABHA number",
  });
export type VerifyAbhaInputDto = z.infer<typeof verifyAbhaSchema>;

export const linkAbhaSchema = z.object({
  patientId: z.string().uuid("Invalid patient"),
  abhaAddress,
  abhaNumber: abhaNumber.optional(),
});
export type LinkAbhaInputDto = z.infer<typeof linkAbhaSchema>;

export const delinkAbhaSchema = z.object({
  patientId: z.string().uuid("Invalid patient"),
  abhaAddress,
});
export type DelinkAbhaInputDto = z.infer<typeof delinkAbhaSchema>;

// ─── Consent ──────────────────────────────────────────────────────────
export const requestConsentSchema = z.object({
  patientId: z.string().uuid("Invalid patient"),
  hiuId: z.string().trim().min(1, "hiuId is required"),
  abhaAddress,
  purpose: z.enum(ABDM_CONSENT_PURPOSES),
  hiTypes: z.array(z.enum(ABHA_HI_TYPES)).min(1, "Pick at least one record type"),
  dateFrom: z.coerce.date(),
  dateTo: z.coerce.date(),
  expiresAt: z.coerce.date(),
  requesterId: z.string().trim().min(1),
  requesterName: z.string().trim().min(1),
});
export type RequestConsentInputDto = z.infer<typeof requestConsentSchema>;

// ─── Care-context link (HIP advertise) ────────────────────────────────
export const careContextLinkSchema = z.object({
  patientId: z.string().uuid("Invalid patient"),
  abhaAddress,
  careContextRef: z.string().trim().min(1, "careContextRef is required"),
  display: z.string().trim().min(1, "display is required"),
  type: z.enum(ABDM_CARE_CONTEXT_TYPES),
});
export type CareContextLinkInputDto = z.infer<typeof careContextLinkSchema>;

// ─── HIP upload (file/record → FHIR → push) — module completion ───────
export const uploadRecordSchema = z.object({
  patientId: z.string().uuid("Invalid patient"),
  abhaAddress,
  type: z.enum(ABDM_CARE_CONTEXT_TYPES),
  title: z.string().trim().min(1, "Title is required").max(200),
  // Either a structured payload OR an uploaded file key (PDF) — at least one.
  fileKey: z.string().trim().min(1).optional(),
  // Structured fields used to build the FHIR bundle when no file is supplied.
  diagnosis: z.string().trim().max(500).optional(),
  notes: z.string().trim().max(4000).optional(),
  recordDate: z.coerce.date().optional(),
});
export type UploadRecordInputDto = z.infer<typeof uploadRecordSchema>;

// ─── HIU fetch (request data-transfer for a granted consent) ──────────
export const hiuFetchSchema = z.object({
  // The GRANTED consent artefact to pull records against.
  consentId: z.string().uuid("Invalid consent"),
});
export type HiuFetchInputDto = z.infer<typeof hiuFetchSchema>;

// ─── Records list query ───────────────────────────────────────────────
export const recordsQuerySchema = z.object({
  patientId: z.string().uuid("Invalid patient").optional(),
  source: z.enum(["HIP_LOCAL", "HIU_EXTERNAL"]).optional(),
  hiType: z.string().trim().optional(),
});
export type RecordsQueryDto = z.infer<typeof recordsQuerySchema>;
