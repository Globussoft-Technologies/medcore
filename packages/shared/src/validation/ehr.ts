import { z } from "zod";

export const AllergySeverityEnum = z.enum([
  "MILD",
  "MODERATE",
  "SEVERE",
  "LIFE_THREATENING",
]);

export const ConditionStatusEnum = z.enum([
  "ACTIVE",
  "CONTROLLED",
  "RESOLVED",
  "RELAPSED",
]);

export const DocumentTypeEnum = z.enum([
  "LAB_REPORT",
  "IMAGING",
  "DISCHARGE_SUMMARY",
  "CONSENT",
  "INSURANCE",
  "REFERRAL_LETTER",
  "ID_PROOF",
  "OTHER",
]);

const dateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD");

export const createAllergySchema = z.object({
  patientId: z.string().uuid(),
  allergen: z.string().min(1, "Allergen is required"),
  severity: AllergySeverityEnum,
  reaction: z.string().optional(),
  notes: z.string().optional(),
});

export const createConditionSchema = z.object({
  patientId: z.string().uuid(),
  condition: z.string().min(1, "Condition is required"),
  icd10Code: z.string().optional(),
  diagnosedDate: dateString.optional(),
  status: ConditionStatusEnum,
  notes: z.string().optional(),
});

export const updateConditionSchema = z.object({
  status: ConditionStatusEnum.optional(),
  notes: z.string().optional(),
  icd10Code: z.string().optional(),
  condition: z.string().min(1).optional(),
  diagnosedDate: dateString.optional(),
});

export const createFamilyHistorySchema = z.object({
  patientId: z.string().uuid(),
  relation: z.string().min(1, "Relation is required"),
  condition: z.string().min(1, "Condition is required"),
  notes: z.string().optional(),
});

export const createImmunizationSchema = z.object({
  patientId: z.string().uuid(),
  vaccine: z.string().min(1, "Vaccine is required"),
  doseNumber: z.number().int().positive().optional(),
  dateGiven: dateString,
  administeredBy: z.string().optional(),
  batchNumber: z.string().optional(),
  manufacturer: z.string().optional(),
  site: z.string().optional(),
  nextDueDate: dateString.optional(),
  notes: z.string().optional(),
});

export const updateImmunizationSchema = createImmunizationSchema
  .omit({ patientId: true })
  .partial();

export const createDocumentSchema = z.object({
  patientId: z.string().uuid(),
  type: DocumentTypeEnum,
  title: z.string().min(1, "Title is required"),
  notes: z.string().optional(),
  filePath: z.string().optional(),
  fileSize: z.number().int().nonnegative().optional(),
  mimeType: z.string().optional(),
});

export type CreateAllergyInput = z.infer<typeof createAllergySchema>;
export type CreateConditionInput = z.infer<typeof createConditionSchema>;
export type UpdateConditionInput = z.infer<typeof updateConditionSchema>;
export type CreateFamilyHistoryInput = z.infer<typeof createFamilyHistorySchema>;
export type CreateImmunizationInput = z.infer<typeof createImmunizationSchema>;
export type UpdateImmunizationInput = z.infer<typeof updateImmunizationSchema>;
export type CreateDocumentInput = z.infer<typeof createDocumentSchema>;
