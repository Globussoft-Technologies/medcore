import { z } from "zod";

// Issue #104 (Apr 2026): patient names must reject digits and most special
// characters but still allow Indian conventions:
//   - "Dr. R.K. Sharma"   (titles + initials with dots)
//   - "K. Anand-Kumar"    (hyphenated double-barrelled names)
//   - "O'Brien"           (apostrophes)
//   - "रामेश शर्मा"        (Devanagari for Hindi-speaking belt)
// We deliberately do NOT allow digits or symbols like @ # $ — those signal
// a typo or paste from a phone number / email field.
export const PATIENT_NAME_REGEX = /^[A-Za-zऀ-ॿ\s.\-']{1,100}$/;

// Issue #103 / #138 share this E.164-ish 10–15 digit format.
export const PHONE_REGEX = /^\+?\d{10,15}$/;

// Issue #167 (Apr 2026): the base shape stays as a ZodObject so existing
// `createPatientSchema.partial()` (used by updatePatientSchema) keeps
// working — only the create path layers on the adult-vs-newborn refine.
const patientBaseSchema = z.object({
  name: z
    .string()
    .trim()
    .min(2, "Name must be at least 2 characters")
    .max(100, "Name must be at most 100 characters")
    .regex(
      PATIENT_NAME_REGEX,
      "Name may only contain letters, spaces, dots, hyphens and apostrophes"
    ),
  dateOfBirth: z.string().optional(),
  // age: schema floor stays at 0 so the pediatric/newborn DOB-based path
  // still works. The "adult flow rejects 0" rule is enforced via the
  // .superRefine() on `createPatientSchema` below — that way `age=0`
  // without a DOB gets a clear field-level error, while `age=0` WITH a
  // DOB (a newborn) still passes.
  age: z.number().int().min(0).max(150).optional(),
  gender: z.enum(["MALE", "FEMALE", "OTHER"]),
  phone: z
    .string()
    .trim()
    .regex(PHONE_REGEX, "Phone must be 10–15 digits, optional leading +"),
  email: z.string().email().optional().or(z.literal("")),
  address: z.string().optional(),
  bloodGroup: z
    .enum(["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"])
    .optional(),
  emergencyContactName: z.string().optional(),
  emergencyContactPhone: z.string().optional(),
  insuranceProvider: z.string().optional(),
  insurancePolicyNumber: z.string().optional(),
  maritalStatus: z
    .enum(["SINGLE", "MARRIED", "DIVORCED", "WIDOWED", "SEPARATED"])
    .optional(),
  occupation: z.string().optional(),
  religion: z.string().optional(),
  preferredLanguage: z.string().optional(),
  abhaId: z.string().optional(),
  aadhaarMasked: z.string().optional(),
  photoUrl: z.string().url().optional().or(z.literal("")),
  pricingTier: z
    .enum(["STANDARD", "EMPLOYEE", "SENIOR_CITIZEN", "BPL", "VIP"])
    .optional(),
});

export const createPatientSchema = patientBaseSchema.superRefine((data, ctx) => {
  // Issue #167: adult-flow guard. age=0 is allowed ONLY when a DOB is
  // also supplied (a newborn). Otherwise it's the silent zero-coercion
  // bug where the number input emitted `0` for an empty field.
  if (data.age === 0 && !data.dateOfBirth) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["age"],
      message:
        "Age must be at least 1 for adult registration. For newborns, provide date of birth instead.",
    });
  }
  // DOB sanity: must be in the past (no time-travelling babies).
  if (data.dateOfBirth) {
    const dob = new Date(data.dateOfBirth);
    if (Number.isNaN(dob.getTime())) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["dateOfBirth"],
        message: "Invalid date of birth",
      });
    } else if (dob.getTime() > Date.now()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["dateOfBirth"],
        message: "Date of birth must be in the past",
      });
    }
  }
});

// updatePatientSchema is built from the base ZodObject so .partial() works
// (ZodEffects from .superRefine() doesn't expose .partial()). The adult
// `age=0` guard isn't relevant on PATCH — receptionists fixing typos
// shouldn't be blocked by a refine that's only meaningful at registration.
// Issue #551 (2026-05-05): Edit Patient previously accepted future DOB —
// the create-side superRefine wasn't replicated on update. Re-apply the
// "DOB must be in the past" guard here so a typo like "2030-01-01" is
// caught at write time on PATCH too.
export const updatePatientSchema = patientBaseSchema.partial().superRefine((data, ctx) => {
  if (data.dateOfBirth) {
    const dob = new Date(data.dateOfBirth);
    if (Number.isNaN(dob.getTime())) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["dateOfBirth"],
        message: "Invalid date of birth",
      });
    } else if (dob.getTime() > Date.now()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["dateOfBirth"],
        message: "Date of birth must be in the past",
      });
    }
  }
});

export const mergePatientSchema = z.object({
  otherPatientId: z.string().uuid(),
});

// Clinically-sensible vital sign ranges — adult inpatient bounds.
// Anything outside these ranges is rejected as data-entry error.
// Issue #91 (Apr 2026): reject impossible values like -50 systolic, 999°F, 500 bpm.
export const VITALS_RANGES = {
  bloodPressureSystolic: { min: 60, max: 260 },
  bloodPressureDiastolic: { min: 30, max: 180 },
  temperatureF: { min: 90, max: 110 },
  temperatureC: { min: 32, max: 43 },
  pulseRate: { min: 30, max: 220 },
  spO2: { min: 50, max: 100 },
  weight: { min: 0.5, max: 300 },
  height: { min: 20, max: 250 },
  respiratoryRate: { min: 5, max: 80 },
  painScale: { min: 0, max: 10 },
} as const;

export const recordVitalsSchema = z
  .object({
    appointmentId: z.string().uuid(),
    patientId: z.string().uuid(),
    bloodPressureSystolic: z
      .number()
      .int()
      .min(VITALS_RANGES.bloodPressureSystolic.min, "Systolic must be at least 60 mmHg")
      .max(VITALS_RANGES.bloodPressureSystolic.max, "Systolic must be at most 260 mmHg")
      .optional(),
    bloodPressureDiastolic: z
      .number()
      .int()
      .min(VITALS_RANGES.bloodPressureDiastolic.min, "Diastolic must be at least 30 mmHg")
      .max(VITALS_RANGES.bloodPressureDiastolic.max, "Diastolic must be at most 180 mmHg")
      .optional(),
    // Temperature bounds depend on the unit. We use a permissive numeric range
    // here and validate the unit-specific bounds in the .superRefine() below
    // so the user gets a clear "out of range for °F/°C" message.
    temperature: z.number().optional(),
    temperatureUnit: z.enum(["F", "C"]).optional(),
    weight: z
      .number()
      .min(VITALS_RANGES.weight.min, "Weight must be at least 0.5 kg")
      .max(VITALS_RANGES.weight.max, "Weight must be at most 300 kg")
      .optional(),
    height: z
      .number()
      .min(VITALS_RANGES.height.min, "Height must be at least 20 cm")
      .max(VITALS_RANGES.height.max, "Height must be at most 250 cm")
      .optional(),
    pulseRate: z
      .number()
      .int()
      .min(VITALS_RANGES.pulseRate.min, "Pulse must be at least 30 bpm")
      .max(VITALS_RANGES.pulseRate.max, "Pulse must be at most 220 bpm")
      .optional(),
    spO2: z
      .number()
      .int()
      .min(VITALS_RANGES.spO2.min, "SpO2 must be at least 50%")
      .max(VITALS_RANGES.spO2.max, "SpO2 must be at most 100%")
      .optional(),
    respiratoryRate: z
      .number()
      .int()
      .min(VITALS_RANGES.respiratoryRate.min, "Respiratory rate must be at least 5/min")
      .max(VITALS_RANGES.respiratoryRate.max, "Respiratory rate must be at most 80/min")
      .optional(),
    painScale: z.number().int().min(0).max(10).optional(),
    notes: z.string().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.temperature !== undefined) {
      const unit = data.temperatureUnit ?? "F";
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
    // physiologically wrong). Cross-field refine here so the nurse vitals
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

export type CreatePatientInput = z.infer<typeof createPatientSchema>;
export type UpdatePatientInput = z.infer<typeof updatePatientSchema>;
export type MergePatientInput = z.infer<typeof mergePatientSchema>;
export type RecordVitalsInput = z.infer<typeof recordVitalsSchema>;
