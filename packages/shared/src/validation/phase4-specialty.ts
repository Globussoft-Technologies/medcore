import { z } from "zod";

export const ANC_VISIT_TYPES = [
  "FIRST_VISIT",
  "ROUTINE",
  "HIGH_RISK_FOLLOWUP",
  "SCAN_REVIEW",
  "DELIVERY",
  "POSTNATAL",
] as const;

export const DELIVERY_TYPES = [
  "NORMAL",
  "C_SECTION",
  "INSTRUMENTAL",
] as const;

// ─── ANTENATAL CARE ─────────────────────────────────

export const createAncCaseSchema = z.object({
  patientId: z.string().uuid(),
  doctorId: z.string().uuid(),
  lmpDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "lmpDate must be YYYY-MM-DD"),
  gravida: z.number().int().min(1).default(1),
  parity: z.number().int().min(0).default(0),
  bloodGroup: z.string().optional(),
  isHighRisk: z.boolean().default(false),
  riskFactors: z.string().optional(),
});

export const updateAncCaseSchema = z.object({
  isHighRisk: z.boolean().optional(),
  riskFactors: z.string().optional(),
  bloodGroup: z.string().optional(),
  gravida: z.number().int().min(1).optional(),
  parity: z.number().int().min(0).optional(),
});

export const createAncVisitSchema = z.object({
  ancCaseId: z.string().uuid(),
  type: z.enum(ANC_VISIT_TYPES),
  weeksOfGestation: z.number().int().min(0).max(50).optional(),
  weight: z.number().positive().optional(),
  bloodPressure: z.string().optional(),
  fundalHeight: z.string().optional(),
  fetalHeartRate: z.number().int().min(60).max(220).optional(),
  presentation: z.string().optional(),
  hemoglobin: z.number().positive().optional(),
  urineProtein: z.string().optional(),
  urineSugar: z.string().optional(),
  notes: z.string().optional(),
  prescribedMeds: z.string().optional(),
  nextVisitDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "nextVisitDate must be YYYY-MM-DD")
    .optional(),
});

export const deliveryOutcomeSchema = z.object({
  deliveryType: z.enum(DELIVERY_TYPES),
  babyGender: z.string().optional(),
  babyWeight: z.number().positive().optional(),
  outcomeNotes: z.string().optional(),
});

export const ultrasoundRecordSchema = z.object({
  ancCaseId: z.string().uuid(),
  scanDate: z.string().optional(),
  gestationalWeeks: z.number().int().min(0).max(50).optional(),
  efwGrams: z.number().int().nonnegative().optional(),
  afi: z.number().nonnegative().optional(),
  placentaPosition: z.string().optional(),
  fetalHeartRate: z.number().int().min(60).max(220).optional(),
  presentation: z.string().optional(),
  findings: z.string().optional(),
  impression: z.string().optional(),
});

// ─── PEDIATRIC GROWTH ───────────────────────────────

export const createGrowthRecordSchema = z.object({
  patientId: z.string().uuid(),
  measurementDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "measurementDate must be YYYY-MM-DD")
    .optional(),
  ageMonths: z.number().int().min(0).max(240),
  weightKg: z.number().positive().optional(),
  heightCm: z.number().positive().optional(),
  headCircumference: z.number().positive().optional(),
  milestoneNotes: z.string().optional(),
  developmentalNotes: z.string().optional(),
});

export const updateGrowthRecordSchema = z.object({
  weightKg: z.number().positive().optional(),
  heightCm: z.number().positive().optional(),
  headCircumference: z.number().positive().optional(),
  milestoneNotes: z.string().optional(),
  developmentalNotes: z.string().optional(),
});

export type CreateAncCaseInput = z.infer<typeof createAncCaseSchema>;
export type UpdateAncCaseInput = z.infer<typeof updateAncCaseSchema>;
export type CreateAncVisitInput = z.infer<typeof createAncVisitSchema>;
export type DeliveryOutcomeInput = z.infer<typeof deliveryOutcomeSchema>;
export type CreateGrowthRecordInput = z.infer<typeof createGrowthRecordSchema>;
export type UpdateGrowthRecordInput = z.infer<typeof updateGrowthRecordSchema>;
export type UltrasoundRecordInput = z.infer<typeof ultrasoundRecordSchema>;
