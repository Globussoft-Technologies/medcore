import { z } from "zod";

/** Validates the request body for POST /ai/triage/sessions. `consentGiven` must be `true`. */
export const startTriageSessionSchema = z.object({
  language: z.enum(["en", "hi"]).default("en"),
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
  language: z.enum(["en", "hi"]).optional(),
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
  ).min(1),
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
