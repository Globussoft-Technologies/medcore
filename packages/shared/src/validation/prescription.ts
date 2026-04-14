import { z } from "zod";

const prescriptionItemSchema = z.object({
  medicineName: z.string().min(1, "Medicine name is required"),
  dosage: z.string().min(1, "Dosage is required"),
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

export type CreatePrescriptionInput = z.infer<typeof createPrescriptionSchema>;
export type CopyPrescriptionInput = z.infer<typeof copyPrescriptionSchema>;
export type SharePrescriptionInput = z.infer<typeof sharePrescriptionSchema>;
export type PrescriptionTemplateInput = z.infer<typeof prescriptionTemplateSchema>;
