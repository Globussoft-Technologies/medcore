import { z } from "zod";
import { containsHtmlOrScript } from "./security";

/**
 * Dosage must be a positive numeric amount followed by an optional unit
 * (e.g. "500mg", "10 ml", "2.5 mcg"). Leading minus signs, zero, and
 * malformed free text are rejected. Any non-digit prefix (other than optional
 * whitespace) is also rejected — this specifically blocks "-100mg" (Issue #9)
 * while still accepting common shapes like "1 tab", "0.25 mg", "½" is NOT
 * accepted — only decimal notation.
 */
const DOSAGE_REGEX = /^\s*\d+(?:\.\d+)?\s*[A-Za-z%/µμ]*\s*$/;

export const dosageStringSchema = z
  .string()
  .min(1, "Dosage is required")
  .refine((v) => DOSAGE_REGEX.test(v), {
    message: "Dosage must be a positive number with an optional unit (e.g. 500mg)",
  })
  .refine(
    (v) => {
      const num = parseFloat(v);
      return Number.isFinite(num) && num > 0;
    },
    { message: "Dosage must be greater than zero" }
  );

/**
 * Issue #542: Duration must be a positive integer/decimal followed by a
 * recognised time unit (days, weeks, months, hours). The "—" placeholder used
 * by the web form when the field is left blank is also accepted so the
 * existing UX (defaulting to em-dash) keeps working. Negative ("-5 days"),
 * zero ("0 days"), and free-text garbage are rejected.
 */
const DURATION_REGEX =
  /^\s*(?:\d+(?:\.\d+)?\s*(?:hour|hours|hr|hrs|h|day|days|d|week|weeks|w|wk|wks|month|months|mo|mos|m)|—|-)\s*$/i;

export const durationStringSchema = z
  .string()
  .min(1, "Duration is required")
  .refine((v) => DURATION_REGEX.test(v), {
    message: "Duration must be a positive number with a unit (e.g. 5 days)",
  })
  .refine(
    (v) => {
      // The em-dash / hyphen placeholders skip the numeric check.
      if (/^\s*[—-]\s*$/.test(v)) return true;
      const num = parseFloat(v);
      return Number.isFinite(num) && num > 0;
    },
    { message: "Duration must be greater than zero" }
  );

const prescriptionItemSchema = z.object({
  // Issue #898 (2026-05-19): optional structured FK to the Medicine master.
  // Still optional in this wave so existing UIs that POST free-text only
  // (mobile + voice-entry) keep working; when provided, the API verifies it
  // resolves to a real row and overwrites `medicineName` from the master so
  // the snapshot stays canonical. Will be flipped to required in a follow-up
  // once every writer is converted.
  medicineId: z.string().uuid().optional(),
  // Issue #954 (2026-05-23, Critical): medicineName accepted raw HTML /
  // `<script>` payloads that were rendered onto the printed Rx PDF and
  // pharmacy-fulfilment UI (clinical-safety + XSS). Reject explicitly via
  // the canonical guard — paired with adding /api/v1/prescriptions to
  // SCHEMA_REJECT_PATHS so the global stripper doesn't launder the tag
  // into a plain-text drug name before the schema sees it.
  medicineName: z
    .string()
    .min(1, "Medicine name is required")
    .max(200, "Medicine name must be 200 characters or fewer")
    .refine((v) => !containsHtmlOrScript(v), {
      message: "Medicine name cannot contain HTML or script tags",
    }),
  dosage: dosageStringSchema,
  frequency: z.string().min(1, "Frequency is required"),
  duration: durationStringSchema,
  instructions: z
    .string()
    .optional()
    .refine((v) => v === undefined || !containsHtmlOrScript(v), {
      message: "Instructions cannot contain HTML or script tags",
    }),
  refills: z.number().int().min(0).max(12).optional(),
});

// Per-prescription doctor signature. Captured by the SignaturePad component
// on the web form (or the Sign-before-share modal). Stored on
// Prescription.signatureUrl. The share endpoint (POST /:id/share) refuses
// to ship an unsigned prescription, so this field is what unblocks the
// share flow when the doctor doesn't have a pre-saved signatureUrl on
// their Doctor row. Cap at ~512KB encoded (~370KB binary) so a stylus-heavy
// capture can't bloat the row beyond what a postgres TEXT column wants to
// hold.
const signatureDataUrlSchema = z
  .string()
  .regex(
    /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/,
    "signatureDataUrl must be a base64 PNG or JPEG data URL",
  )
  .max(524288, "Signature image is too large (>512KB)")
  .optional();

// Pearl ERP Stage 1 §2.1.4 — drug-allergy block must be overrideable with
// a reason. `overrideAllergies=true` requires a non-empty `allergyOverrideReason`
// so the audit trail captures WHY the prescriber went ahead.
export const createPrescriptionSchema = z
  .object({
    appointmentId: z.string().uuid(),
    patientId: z.string().uuid(),
    diagnosis: z
      .string()
      .min(1, "Diagnosis is required")
      .refine((v) => !containsHtmlOrScript(v), {
        message: "Diagnosis cannot contain HTML or script tags",
      }),
    items: z.array(prescriptionItemSchema).min(1, "At least one medicine is required"),
    advice: z
      .string()
      .optional()
      .refine((v) => v === undefined || !containsHtmlOrScript(v), {
        message: "Advice cannot contain HTML or script tags",
      }),
    followUpDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD")
      .optional(),
    overrideWarnings: z.boolean().optional(),
    overrideAllergies: z.boolean().optional(),
    allergyOverrideReason: z
      .string()
      .min(3)
      .max(500)
      .refine((v) => !containsHtmlOrScript(v), {
        message: "Allergy override reason cannot contain HTML or script tags",
      })
      .optional(),
    signatureDataUrl: signatureDataUrlSchema,
  })
  .refine(
    (val) => !val.overrideAllergies || (val.allergyOverrideReason?.trim().length ?? 0) >= 3,
    {
      path: ["allergyOverrideReason"],
      message: "allergyOverrideReason (>=3 chars) is required when overrideAllergies=true",
    },
  );

// Edit-mode counterpart of createPrescriptionSchema. Deliberately omits
// appointmentId and patientId — those are immutable identifiers on an
// existing prescription; allowing them to change would let a doctor
// silently retarget an Rx onto a different patient or visit. items is
// required because the wire-replace happens atomically (delete + recreate
// in a tx) so the caller MUST send the full desired set, not a partial.
export const updatePrescriptionSchema = z.object({
  diagnosis: z
    .string()
    .min(1, "Diagnosis is required")
    .refine((v) => !containsHtmlOrScript(v), {
      message: "Diagnosis cannot contain HTML or script tags",
    }),
  items: z.array(prescriptionItemSchema).min(1, "At least one medicine is required"),
  advice: z
    .string()
    .optional()
    .refine((v) => v === undefined || !containsHtmlOrScript(v), {
      message: "Advice cannot contain HTML or script tags",
    }),
  followUpDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD")
    .optional(),
  overrideWarnings: z.boolean().optional(),
  signatureDataUrl: signatureDataUrlSchema,
});

export const copyPrescriptionSchema = z.object({
  previousPrescriptionId: z.string().uuid(),
  appointmentId: z.string().uuid(),
});

export const sharePrescriptionSchema = z.object({
  channel: z.enum(["WHATSAPP", "EMAIL", "SMS"]),
});

export const prescriptionTemplateSchema = z.object({
  name: z.string().min(2),
  diagnosis: z.string().min(1),
  advice: z.string().optional(),
  specialty: z.string().optional(),
  items: z.array(prescriptionItemSchema).min(1),
});

export const renalDoseCalcSchema = z.object({
  medicineId: z.string().uuid(),
  creatinineMgDl: z.number().positive(),
  ageYears: z.number().int().positive(),
  weightKg: z.number().positive(),
  genderMale: z.boolean(),
});

export type CreatePrescriptionInput = z.infer<typeof createPrescriptionSchema>;
export type UpdatePrescriptionInput = z.infer<typeof updatePrescriptionSchema>;
export type CopyPrescriptionInput = z.infer<typeof copyPrescriptionSchema>;
export type SharePrescriptionInput = z.infer<typeof sharePrescriptionSchema>;
export type PrescriptionTemplateInput = z.infer<typeof prescriptionTemplateSchema>;
export type RenalDoseCalcInput = z.infer<typeof renalDoseCalcSchema>;
