import { z } from "zod";

export const createWardSchema = z.object({
  name: z.string().min(1),
  type: z.enum([
    "GENERAL",
    "PRIVATE",
    "SEMI_PRIVATE",
    "ICU",
    "NICU",
    "HDU",
    "EMERGENCY",
    "MATERNITY",
  ]),
  floor: z.string().optional(),
  description: z.string().optional(),
});

export const createBedSchema = z.object({
  wardId: z.string().uuid(),
  bedNumber: z.string().min(1),
  dailyRate: z.number().min(0).default(0),
});

export const updateBedStatusSchema = z.object({
  status: z.enum([
    "AVAILABLE",
    "OCCUPIED",
    "CLEANING",
    "MAINTENANCE",
    "RESERVED",
  ]),
  notes: z.string().optional(),
});

export const ADMISSION_TYPES = [
  "ELECTIVE",
  "EMERGENCY",
  "TRANSFER",
  "MATERNITY",
  "DAY_CARE",
] as const;

export const CONDITION_AT_DISCHARGE = [
  "STABLE",
  "IMPROVED",
  "CRITICAL",
  "UNCHANGED",
  "DECEASED",
] as const;

export const INTAKE_OUTPUT_TYPES = [
  "INTAKE_ORAL",
  "INTAKE_IV",
  "INTAKE_NG",
  "OUTPUT_URINE",
  "OUTPUT_STOOL",
  "OUTPUT_VOMIT",
  "OUTPUT_DRAIN",
  "OUTPUT_OTHER",
] as const;

export const admitPatientSchema = z.object({
  patientId: z.string().uuid(),
  doctorId: z.string().uuid(),
  bedId: z.string().uuid(),
  reason: z.string().min(1),
  diagnosis: z.string().optional(),
  admissionType: z.enum(ADMISSION_TYPES).optional(),
  referredByDoctor: z.string().optional(),
});

export const dischargeSchema = z.object({
  dischargeSummary: z.string().min(1),
  dischargeNotes: z.string().optional(),
  finalDiagnosis: z.string().optional(),
  treatmentGiven: z.string().optional(),
  conditionAtDischarge: z.enum(CONDITION_AT_DISCHARGE).optional(),
  dischargeMedications: z.string().optional(),
  followUpInstructions: z.string().optional(),
  forceDischarge: z.boolean().optional(),
});

export const intakeOutputSchema = z.object({
  admissionId: z.string().uuid(),
  type: z.enum(INTAKE_OUTPUT_TYPES),
  amountMl: z.number().int().nonnegative(),
  description: z.string().optional(),
  notes: z.string().optional(),
});

export const transferBedSchema = z.object({
  newBedId: z.string().uuid(),
  reason: z.string().optional(),
});

export const recordIpdVitalsSchema = z.object({
  admissionId: z.string().uuid(),
  bloodPressureSystolic: z.number().int().optional(),
  bloodPressureDiastolic: z.number().int().optional(),
  temperature: z.number().optional(),
  pulseRate: z.number().int().optional(),
  respiratoryRate: z.number().int().optional(),
  spO2: z.number().int().optional(),
  painScore: z.number().int().min(0).max(10).optional(),
  bloodSugar: z.number().int().optional(),
  notes: z.string().optional(),
});

export const medicationOrderSchema = z.object({
  admissionId: z.string().uuid(),
  medicineId: z.string().uuid().optional(),
  medicineName: z.string().min(1),
  dosage: z.string().min(1),
  frequency: z.string().min(1),
  route: z.string().min(1),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  instructions: z.string().optional(),
});

export const updateMedicationOrderSchema = z.object({
  isActive: z.boolean().optional(),
  instructions: z.string().optional(),
  endDate: z.string().optional(),
});

export const administerMedicationSchema = z.object({
  status: z.enum(["ADMINISTERED", "MISSED", "REFUSED", "HELD"]),
  notes: z.string().optional(),
});

export const nurseRoundSchema = z.object({
  admissionId: z.string().uuid(),
  notes: z.string().min(1),
});

export type CreateWardInput = z.infer<typeof createWardSchema>;
export type CreateBedInput = z.infer<typeof createBedSchema>;
export type UpdateBedStatusInput = z.infer<typeof updateBedStatusSchema>;
export type AdmitPatientInput = z.infer<typeof admitPatientSchema>;
export type DischargeInput = z.infer<typeof dischargeSchema>;
export type TransferBedInput = z.infer<typeof transferBedSchema>;
export type RecordIpdVitalsInput = z.infer<typeof recordIpdVitalsSchema>;
export type MedicationOrderInput = z.infer<typeof medicationOrderSchema>;
export type UpdateMedicationOrderInput = z.infer<typeof updateMedicationOrderSchema>;
export type AdministerMedicationInput = z.infer<typeof administerMedicationSchema>;
export type NurseRoundInput = z.infer<typeof nurseRoundSchema>;
export type IntakeOutputInput = z.infer<typeof intakeOutputSchema>;
