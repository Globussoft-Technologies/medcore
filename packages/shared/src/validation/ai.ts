import { z } from "zod";

// PRD §3.5.1 Phase 2 — regional languages.
// English + Hindi shipped in Phase 1; Tamil, Telugu, Bengali, Marathi,
// Kannada, Malayalam added in Phase 2. The tuple is the canonical list
// consumed by Zod, the shared i18n bundle, and the triage UI picker.
export const TRIAGE_LANGUAGE_CODES = [
  "en",
  "hi",
  "ta",
  "te",
  "bn",
  "mr",
  "kn",
  "ml",
] as const;
export type TriageLanguageCode = (typeof TRIAGE_LANGUAGE_CODES)[number];

/** Validates the request body for POST /ai/triage/sessions. `consentGiven` must be `true`. */
export const startTriageSessionSchema = z.object({
  language: z.enum(TRIAGE_LANGUAGE_CODES).default("en"),
  inputMode: z.enum(["text", "voice"]).default("text"),
  patientId: z.string().uuid().optional(),
  isForDependent: z.boolean().default(false),
  dependentRelationship: z.string().optional(),
  consentGiven: z.literal(true),
  bookingFor: z.enum(["SELF", "CHILD", "PARENT", "SIBLING", "OTHER"]).optional(),
  dependentPatientId: z.string().optional(),
});

/** Validates the body for POST /ai/triage/sessions/:id/message. */
export const triageMessageSchema = z.object({
  message: z.string().min(1).max(2000),
  language: z.enum(TRIAGE_LANGUAGE_CODES).optional(),
});

/** Validates the body for booking an appointment directly from a completed triage session. */
export const bookFromTriageSchema = z.object({
  doctorId: z.string().uuid(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  slotStart: z.string().regex(/^\d{2}:\d{2}$/),
  slotEnd: z.string().regex(/^\d{2}:\d{2}$/),
  patientId: z.string().uuid(),
});

/** Validates the body for POST /ai/scribe/sessions. `consentObtained` must be `true`. */
export const startScribeSessionSchema = z.object({
  appointmentId: z.string().uuid(),
  consentObtained: z.literal(true),
  audioRetentionDays: z.number().int().min(0).max(365).default(30),
});

/** Validates a batch of transcript entries pushed to an active scribe session. */
export const addTranscriptChunkSchema = z.object({
  entries: z.array(
    z.object({
      speaker: z.enum(["DOCTOR", "PATIENT", "ATTENDANT", "UNKNOWN"]),
      text: z.string().min(1),
      timestamp: z.string(),
      confidence: z.number().min(0).max(1).optional(),
    })
  ).min(0),
  forceRegen: z.boolean().optional(),
});

/** Validates the doctor's sign-off payload that finalises a scribe session and optionally approves the AI-generated prescription. */
export const scribeSignOffSchema = z.object({
  soapFinal: z.object({
    subjective: z.any(),
    objective: z.any(),
    assessment: z.any(),
    plan: z.any(),
  }),
  icd10Codes: z.array(z.any()).optional(),
  rxApproved: z.boolean().default(false),
  doctorEdits: z.array(z.any()).default([]),
});
