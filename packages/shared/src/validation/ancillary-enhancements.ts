import { z } from "zod";

// ───────────────────────────────────────────────────────
// LAB ENHANCEMENTS
// ───────────────────────────────────────────────────────

export const labReferenceRangeSchema = z.object({
  testId: z.string().uuid(),
  parameter: z.string().optional(),
  gender: z.enum(["MALE", "FEMALE"]).optional(),
  ageMin: z.number().int().min(0).optional(),
  ageMax: z.number().int().min(0).optional(),
  low: z.number().optional(),
  high: z.number().optional(),
  unit: z.string().optional(),
  notes: z.string().optional(),
});

export const sampleRejectSchema = z.object({
  reason: z.enum([
    "INSUFFICIENT_SAMPLE",
    "HEMOLYZED",
    "CLOTTED",
    "LIPEMIC",
    "WRONG_LABEL",
    "WRONG_CONTAINER",
    "CONTAMINATED",
    "OTHER",
  ]),
  notes: z.string().optional(),
});

export const batchResultSchema = z.object({
  orderId: z.string().uuid(),
  results: z
    .array(
      z.object({
        orderItemId: z.string().uuid(),
        parameter: z.string().min(1),
        value: z.string().min(1),
        unit: z.string().optional(),
        normalRange: z.string().optional(),
        flag: z.enum(["NORMAL", "LOW", "HIGH", "CRITICAL"]).optional(),
        notes: z.string().optional(),
      })
    )
    .min(1),
});

// ───────────────────────────────────────────────────────
// PHARMACY ENHANCEMENTS
// ───────────────────────────────────────────────────────

export const batchRecallSchema = z.object({
  reason: z.string().min(1),
});

export const stockAdjustmentSchema = z.object({
  inventoryItemId: z.string().uuid(),
  quantity: z.number().int(), // signed
  reasonCode: z.enum([
    "DAMAGE",
    "EXPIRY",
    "LOSS",
    "COUNT_CORRECTION",
    "THEFT",
    "TRANSFER_OUT",
    "TRANSFER_IN",
  ]),
  reason: z.string().optional(),
});

// ───────────────────────────────────────────────────────
// MEDICINE ENHANCEMENTS
// ───────────────────────────────────────────────────────

export const pediatricDoseCalcSchema = z.object({
  medicineId: z.string().uuid(),
  weightKg: z.number().positive(),
  frequencyPerDay: z.number().int().positive().optional(),
});

export const contraindicationCheckSchema = z.object({
  medicineIds: z.array(z.string().uuid()).min(1),
  patientConditions: z.array(z.string()).optional(), // e.g., ["Pregnancy", "Renal failure"]
  patientAllergies: z.array(z.string()).optional(),
});

// ───────────────────────────────────────────────────────
// BLOOD BANK ENHANCEMENTS
// ───────────────────────────────────────────────────────

const screeningResult = z.enum(["NEGATIVE", "POSITIVE", "INDETERMINATE"]);

export const bloodScreeningSchema = z.object({
  donationId: z.string().uuid(),
  hivResult: screeningResult,
  hcvResult: screeningResult,
  hbsAgResult: screeningResult,
  syphilisResult: screeningResult,
  malariaResult: screeningResult,
  bloodGrouping: z.string().optional(),
  method: z.string().optional(),
  notes: z.string().optional(),
});

export const temperatureLogSchema = z.object({
  location: z.string().min(1),
  temperature: z.number(),
  notes: z.string().optional(),
});

export const crossMatchRecordSchema = z.object({
  requestId: z.string().uuid(),
  unitId: z.string().uuid(),
  compatible: z.boolean(),
  method: z.string().optional(),
  notes: z.string().optional(),
});

// ───────────────────────────────────────────────────────
// AMBULANCE ENHANCEMENTS
// ───────────────────────────────────────────────────────

export const fuelLogSchema = z.object({
  ambulanceId: z.string().uuid(),
  litres: z.number().positive(),
  costTotal: z.number().nonnegative(),
  odometerKm: z.number().int().nonnegative().optional(),
  stationName: z.string().optional(),
  notes: z.string().optional(),
});

export const equipmentCheckSchema = z.object({
  equipmentChecked: z.boolean(),
  equipmentNotes: z.string().optional(),
});

export const tripBillSchema = z.object({
  baseFare: z.number().nonnegative().default(0),
  perKmRate: z.number().nonnegative().default(0),
});

// ───────────────────────────────────────────────────────
// ASSET ENHANCEMENTS
// ───────────────────────────────────────────────────────

export const assetTransferSchema = z.object({
  toDepartment: z.string().min(1),
  toLocation: z.string().optional(),
  reason: z.string().optional(),
  notes: z.string().optional(),
});

export const assetDisposalSchema = z.object({
  method: z.enum(["SOLD", "SCRAPPED", "DONATED", "LOST"]),
  disposalValue: z.number().nonnegative().optional(),
  notes: z.string().optional(),
});

export const calibrationScheduleSchema = z.object({
  calibrationInterval: z.number().int().positive(),
  lastCalibrationAt: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});

export type LabReferenceRangeInput = z.infer<typeof labReferenceRangeSchema>;
export type SampleRejectInput = z.infer<typeof sampleRejectSchema>;
export type BatchResultInput = z.infer<typeof batchResultSchema>;
export type BatchRecallInput = z.infer<typeof batchRecallSchema>;
export type StockAdjustmentInput = z.infer<typeof stockAdjustmentSchema>;
export type PediatricDoseCalcInput = z.infer<typeof pediatricDoseCalcSchema>;
export type ContraindicationCheckInput = z.infer<
  typeof contraindicationCheckSchema
>;
export type BloodScreeningInput = z.infer<typeof bloodScreeningSchema>;
export type TemperatureLogInput = z.infer<typeof temperatureLogSchema>;
export type CrossMatchRecordInput = z.infer<typeof crossMatchRecordSchema>;
export type FuelLogInput = z.infer<typeof fuelLogSchema>;
export type EquipmentCheckInput = z.infer<typeof equipmentCheckSchema>;
export type TripBillInput = z.infer<typeof tripBillSchema>;
export type AssetTransferInput = z.infer<typeof assetTransferSchema>;
export type AssetDisposalInput = z.infer<typeof assetDisposalSchema>;
export type CalibrationScheduleInput = z.infer<
  typeof calibrationScheduleSchema
>;
