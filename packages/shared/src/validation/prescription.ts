import { z } from "zod";

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

const prescriptionItemSchema = z.object({
  medicineName: z.string().min(1, "Medicine name is required"),
  dosage: dosageStringSchema,
  frequency: z.string().min(1, "Frequency is required"),
  duration: z.string().min(1, "Duration is required"),
  instructions: z.string().optional(),
  refills: z.number().int().min(0).max(12).optional(),
});

export const createPrescriptionSchema = z.object({
  appointmentId: z.string().uuid(),
  patientId: z.string().uuid(),
  diagnosis: z.string().min(1, "Diagnosis is required"),
  items: z.array(prescriptionItemSchema).min(1, "At least one medicine is required"),
  advice: z.string().optional(),
  followUpDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD")
    .optional(),
  overrideWarnings: z.boolean().optional(),
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
export type CopyPrescriptionInput = z.infer<typeof copyPrescriptionSchema>;
export type SharePrescriptionInput = z.infer<typeof sharePrescriptionSchema>;
export type PrescriptionTemplateInput = z.infer<typeof prescriptionTemplateSchema>;
export type RenalDoseCalcInput = z.infer<typeof renalDoseCalcSchema>;
