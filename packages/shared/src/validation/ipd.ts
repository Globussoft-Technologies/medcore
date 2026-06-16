import { z } from "zod";
import { VITALS_RANGES } from "./patient";

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

// Edit a bed's identity/tariff (NOT its status — that's updateBedStatusSchema).
// Both fields optional so the UI can PATCH just the number, just the rate, or
// both. `.refine` rejects an empty body so a no-op PATCH surfaces a clear 400
// rather than silently succeeding.
export const updateBedSchema = z
  .object({
    bedNumber: z.string().min(1).optional(),
    dailyRate: z.number().min(0).optional(),
  })
  .refine((v) => v.bedNumber !== undefined || v.dailyRate !== undefined, {
    message: "Provide at least one of bedNumber or dailyRate",
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

// Issue #433 (2026-04-30): I/O accepted negative volumes and unbounded values
// (e.g. -500 mL, 99999 mL) which corrupted the running fluid balance.
// Enforce 0–10000 mL per entry: the upper bound matches the largest plausible
// per-event input (e.g. a 4-hour urinary catheter bag, a 2L IV infusion run).
// Anything beyond is treated as a typo. The amount is always in mL — the
// column name `amountMl` is the unit annotation. The clinical convention
// across MedCore IPD is mL only; we don't support a separate "L" unit input.
export const INTAKE_OUTPUT_VOLUME_MAX_ML = 10_000;
export const intakeOutputSchema = z.object({
  admissionId: z.string().uuid(),
  type: z.enum(INTAKE_OUTPUT_TYPES),
  amountMl: z
    .number()
    .int("Volume must be a whole number of mL")
    .nonnegative("Volume must be ≥ 0 mL")
    .max(INTAKE_OUTPUT_VOLUME_MAX_ML, "Volume must be ≤ 10000 mL per entry"),
  description: z.string().optional(),
  notes: z.string().optional(),
});

export const transferBedSchema = z.object({
  newBedId: z.string().uuid(),
  reason: z.string().optional(),
});

// Issue #366 (2026-04-26): IPD vitals previously accepted any integer
// because the fields were typed `int().optional()` only — so a clerk
// could record "-50 mmHg" or a 999°F temp. Apply the canonical ranges
// from `VITALS_RANGES` (#91 / #339) so admissions and OPD agree on what
// counts as a clinically-impossible value. Temperature is unit-aware.
export const recordIpdVitalsSchema = z
  .object({
    admissionId: z.string().uuid(),
    bloodPressureSystolic: z
      .number()
      .int()
      .min(VITALS_RANGES.bloodPressureSystolic.min, "Systolic must be at least 40 mmHg")
      .max(VITALS_RANGES.bloodPressureSystolic.max, "Systolic must be at most 300 mmHg")
      .optional(),
    bloodPressureDiastolic: z
      .number()
      .int()
      .min(VITALS_RANGES.bloodPressureDiastolic.min, "Diastolic must be at least 20 mmHg")
      .max(VITALS_RANGES.bloodPressureDiastolic.max, "Diastolic must be at most 220 mmHg")
      .optional(),
    temperature: z.number().optional(),
    temperatureUnit: z.enum(["F", "C"]).optional(),
    pulseRate: z
      .number()
      .int()
      .min(VITALS_RANGES.pulseRate.min, "Pulse must be at least 30 bpm")
      .max(VITALS_RANGES.pulseRate.max, "Pulse must be at most 220 bpm")
      .optional(),
    respiratoryRate: z
      .number()
      .int()
      .min(VITALS_RANGES.respiratoryRate.min, "Respiratory rate must be at least 5/min")
      .max(VITALS_RANGES.respiratoryRate.max, "Respiratory rate must be at most 80/min")
      .optional(),
    spO2: z
      .number()
      .int()
      .min(VITALS_RANGES.spO2.min, "SpO2 must be at least 50%")
      .max(VITALS_RANGES.spO2.max, "SpO2 must be at most 100%")
      .optional(),
    painScore: z
      .number()
      .int()
      .min(VITALS_RANGES.painScale.min)
      .max(VITALS_RANGES.painScale.max)
      .optional(),
    bloodSugar: z
      .number()
      .int()
      .min(20, "Blood sugar must be at least 20 mg/dL")
      .max(900, "Blood sugar must be at most 900 mg/dL")
      .optional(),
    notes: z.string().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.temperature !== undefined) {
      const unit = data.temperatureUnit ?? "C";
      const range =
        unit === "C" ? VITALS_RANGES.temperatureC : VITALS_RANGES.temperatureF;
      if (data.temperature < range.min || data.temperature > range.max) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["temperature"],
          message: `Temperature must be between ${range.min} and ${range.max}°${unit}`,
        });
      }
    }
    // Issue #544: diastolic must always be strictly less than systolic. The
    // per-field min/max bounds above can't catch a clinically-impossible
    // pair like 120/130 (each leg is in-range but the relationship is
    // physiologically wrong). Cross-field refine here so the IPD vitals
    // form rejects it server-side regardless of frontend state.
    if (
      data.bloodPressureSystolic !== undefined &&
      data.bloodPressureDiastolic !== undefined &&
      data.bloodPressureDiastolic >= data.bloodPressureSystolic
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["bloodPressureDiastolic"],
        message: "Diastolic must be less than systolic",
      });
    }
  });

export const medicationOrderSchema = z.object({
  admissionId: z.string().uuid(),
  // 2026-05-25 — relaxed from .uuid() to an id-like string. Some Medicine
  // rows in the catalog were seeded with arbitrary 36-char hex strings
  // (UUID-shaped but missing the RFC 4122 version digit at position 14),
  // which fail strict .uuid() validation even though they're valid
  // Medicine.id values. The route handler still validates existence by
  // doing a Prisma lookup, so accepting "any non-empty ≤64-char id" here
  // is safe. Mirrors the same idLike convention in
  // validation/doctor-favourite-medicine.ts.
  medicineId: z.string().min(1).max(64).optional(),
  medicineName: z.string().min(1).optional(),
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
export type UpdateBedInput = z.infer<typeof updateBedSchema>;
export type AdmitPatientInput = z.infer<typeof admitPatientSchema>;
export type DischargeInput = z.infer<typeof dischargeSchema>;
export type TransferBedInput = z.infer<typeof transferBedSchema>;
export type RecordIpdVitalsInput = z.infer<typeof recordIpdVitalsSchema>;
export type MedicationOrderInput = z.infer<typeof medicationOrderSchema>;
export type UpdateMedicationOrderInput = z.infer<typeof updateMedicationOrderSchema>;
export type AdministerMedicationInput = z.infer<typeof administerMedicationSchema>;
export type NurseRoundInput = z.infer<typeof nurseRoundSchema>;
export type IntakeOutputInput = z.infer<typeof intakeOutputSchema>;

// ─── ISOLATION STATUS ───────────────────────────────────

export const IsolationTypeEnum = z.enum([
  "STANDARD",
  "CONTACT",
  "DROPLET",
  "AIRBORNE",
  "REVERSE_ISOLATION",
]);

export const isolationStatusSchema = z.object({
  isolationType: IsolationTypeEnum.nullable().optional(),
  isolationReason: z.string().optional(),
  isolationStartDate: z.string().optional(),
  isolationEndDate: z.string().optional(),
  clear: z.boolean().optional(),
});

export type IsolationStatusInput = z.infer<typeof isolationStatusSchema>;

// ─── PATIENT BELONGINGS ─────────────────────────────────

export const BelongingItemSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  value: z.number().nonnegative().optional(),
  checkedIn: z.boolean().default(true),
  checkedInAt: z.string().optional(),
  checkedOutAt: z.string().optional(),
});

export const belongingsSchema = z.object({
  items: z.array(BelongingItemSchema).default([]),
  notes: z.string().optional(),
});

export const updateBelongingsSchema = belongingsSchema.partial();

export const checkoutBelongingsSchema = z.object({
  items: z.array(BelongingItemSchema).optional(),
  notes: z.string().optional(),
});

export type BelongingItemInput = z.infer<typeof BelongingItemSchema>;
export type BelongingsInput = z.infer<typeof belongingsSchema>;
export type UpdateBelongingsInput = z.infer<typeof updateBelongingsSchema>;
