import { z } from "zod";
import { ALL_BLOOD_GROUPS } from "../abo-compatibility";

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

// Issue #57 (Apr 2026): tighten ANC create-form validation.
// • LMP must be on or before today (a future LMP is biologically impossible
//   and produced absurd EDD calculations).
// • Gravida and parity must be int + nonnegative (negative pregnancies aren't
//   a thing). Note we previously required gravida ≥ 1; we keep that since a
//   case row only exists when the patient is currently pregnant.
// • Blood group is restricted to the 8 canonical ABO+Rh tokens (A_POS, A_NEG,
//   B_POS, B_NEG, AB_POS, AB_NEG, O_POS, O_NEG) so it joins the same lookup
//   tables the blood-bank cross-match uses.
const lmpDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "lmpDate must be YYYY-MM-DD")
  .refine((s) => {
    const lmp = new Date(`${s}T00:00:00.000Z`);
    if (Number.isNaN(lmp.getTime())) return false;
    const now = new Date();
    // compare on UTC date only — the user is in some local TZ and the picker
    // submits a YYYY-MM-DD; we accept "today" anywhere on Earth.
    const todayUtcEnd = Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      23,
      59,
      59,
      999
    );
    return lmp.getTime() <= todayUtcEnd;
  }, "Last Menstrual Period date cannot be in the future");

export const createAncCaseSchema = z.object({
  patientId: z.string().uuid(),
  doctorId: z.string().uuid(),
  lmpDate: lmpDateSchema,
  gravida: z.number().int().nonnegative("Gravida cannot be negative").min(1).default(1),
  parity: z.number().int().nonnegative("Parity cannot be negative").default(0),
  bloodGroup: z.enum(ALL_BLOOD_GROUPS as unknown as [string, ...string[]]).optional(),
  isHighRisk: z.boolean().default(false),
  riskFactors: z.string().optional(),
});

export const updateAncCaseSchema = z.object({
  isHighRisk: z.boolean().optional(),
  riskFactors: z.string().optional(),
  bloodGroup: z.enum(ALL_BLOOD_GROUPS as unknown as [string, ...string[]]).optional(),
  gravida: z.number().int().nonnegative("Gravida cannot be negative").min(1).optional(),
  parity: z.number().int().nonnegative("Parity cannot be negative").optional(),
});

// Issue #423 (Apr 2026): the existing schema let a "completely empty"
// visit through — every clinical field is optional, so a click of Save
// with nothing filled in created a blank row that polluted the patient's
// antenatal timeline. The web form has its own guard, but other clients
// (Postman, scripts, future native app) hit this route too. Enforce the
// same rule at the schema layer so the API rejects a zero-observation
// visit regardless of caller. Notes alone count — clinicians sometimes
// jot a free-form observation rather than a numeric vital.
export const createAncVisitSchema = z
  .object({
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
  })
  .superRefine((data, ctx) => {
    const hasContent =
      data.weeksOfGestation != null ||
      data.weight != null ||
      (data.bloodPressure?.trim() ?? "") !== "" ||
      (data.fundalHeight?.trim() ?? "") !== "" ||
      data.fetalHeartRate != null ||
      (data.presentation?.trim() ?? "") !== "" ||
      data.hemoglobin != null ||
      (data.urineProtein?.trim() ?? "") !== "" ||
      (data.urineSugar?.trim() ?? "") !== "" ||
      (data.notes?.trim() ?? "") !== "";
    if (!hasContent) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["notes"],
        message:
          "Record at least one observation (vitals, fetal HR, urine, hemoglobin, or notes) before saving the visit.",
      });
    }
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

// Issue #435: WHO p3-p97 envelope plus a defensive margin. Negative or
// absurdly large measurements (e.g. -3 kg, 999 cm, -15 cm head circ) used
// to be accepted and plotted nonsense points on the percentile chart.
// These bounds cover newborn through late adolescent (0-20 years).
const WEIGHT_KG_MIN = 0.5;
const WEIGHT_KG_MAX = 200;
const HEIGHT_CM_MIN = 30;
const HEIGHT_CM_MAX = 220;
const HEAD_CIRC_MIN = 25;
const HEAD_CIRC_MAX = 65;

export const createGrowthRecordSchema = z.object({
  patientId: z.string().uuid(),
  measurementDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "measurementDate must be YYYY-MM-DD")
    .optional(),
  ageMonths: z.number().int().min(0).max(240),
  weightKg: z
    .number()
    .min(WEIGHT_KG_MIN, `weightKg must be ≥ ${WEIGHT_KG_MIN} kg`)
    .max(WEIGHT_KG_MAX, `weightKg must be ≤ ${WEIGHT_KG_MAX} kg`)
    .optional(),
  heightCm: z
    .number()
    .min(HEIGHT_CM_MIN, `heightCm must be ≥ ${HEIGHT_CM_MIN} cm`)
    .max(HEIGHT_CM_MAX, `heightCm must be ≤ ${HEIGHT_CM_MAX} cm`)
    .optional(),
  headCircumference: z
    .number()
    .min(HEAD_CIRC_MIN, `headCircumference must be ≥ ${HEAD_CIRC_MIN} cm`)
    .max(HEAD_CIRC_MAX, `headCircumference must be ≤ ${HEAD_CIRC_MAX} cm`)
    .optional(),
  milestoneNotes: z.string().optional(),
  developmentalNotes: z.string().optional(),
});

export const updateGrowthRecordSchema = z.object({
  weightKg: z
    .number()
    .min(WEIGHT_KG_MIN, `weightKg must be ≥ ${WEIGHT_KG_MIN} kg`)
    .max(WEIGHT_KG_MAX, `weightKg must be ≤ ${WEIGHT_KG_MAX} kg`)
    .optional(),
  heightCm: z
    .number()
    .min(HEIGHT_CM_MIN, `heightCm must be ≥ ${HEIGHT_CM_MIN} cm`)
    .max(HEIGHT_CM_MAX, `heightCm must be ≤ ${HEIGHT_CM_MAX} cm`)
    .optional(),
  headCircumference: z
    .number()
    .min(HEAD_CIRC_MIN, `headCircumference must be ≥ ${HEAD_CIRC_MIN} cm`)
    .max(HEAD_CIRC_MAX, `headCircumference must be ≤ ${HEAD_CIRC_MAX} cm`)
    .optional(),
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

// ─── PARTOGRAPH ─────────────────────────────────────
export const partographObservationSchema = z.object({
  time: z.string(),
  fetalHeartRate: z.number().int().min(60).max(220).optional(),
  cervicalDilation: z.number().min(0).max(10).optional(), // cm
  descent: z.number().int().min(-5).max(5).optional(), // station -5..+5
  contractionsPer10Min: z.number().int().min(0).max(10).optional(),
  contractionStrength: z.enum(["MILD", "MODERATE", "STRONG"]).optional(),
  maternalPulse: z.number().int().min(40).max(200).optional(),
  maternalBP: z.string().optional(),
  temperature: z.number().optional(),
  notes: z.string().optional(),
});

export const startPartographSchema = z.object({
  observations: z.array(partographObservationSchema).optional().default([]),
  interventions: z.string().optional(),
});

export const addPartographObservationSchema = partographObservationSchema;

export const endPartographSchema = z.object({
  outcome: z.string().min(1),
  interventions: z.string().optional(),
});

// ─── ACOG RISK SCORE ────────────────────────────────
export const acogRiskScoreSchema = z.object({
  heightCm: z.number().positive().optional(),
  weightKg: z.number().positive().optional(),
  hasPrevCSection: z.boolean().optional(),
  hasHypertension: z.boolean().optional(),
  hasDiabetes: z.boolean().optional(),
  hasPriorGDM: z.boolean().optional(),
  hasPriorStillbirth: z.boolean().optional(),
  hasPriorPreterm: z.boolean().optional(),
  hasPriorComplications: z.boolean().optional(),
  currentBleeding: z.boolean().optional(),
  currentPreeclampsia: z.boolean().optional(),
});

// ─── POSTNATAL VISIT ────────────────────────────────
export const postnatalVisitSchema = z.object({
  weekPostpartum: z.number().int().min(0).max(52),
  motherBP: z.string().optional(),
  motherWeight: z.number().positive().optional(),
  lochia: z.enum(["NORMAL", "HEAVY", "ABSENT", "ABNORMAL_COLOR"]).optional(),
  uterineInvolution: z.enum(["NORMAL", "DELAYED"]).optional(),
  breastExam: z.string().optional(),
  breastfeeding: z.enum(["EXCLUSIVE", "MIXED", "NONE"]).optional(),
  mentalHealth: z.string().optional(),
  babyWeight: z.number().positive().optional(),
  babyFeeding: z.string().optional(),
  babyJaundice: z.boolean().optional(),
  babyExam: z.string().optional(),
  immunizationGiven: z.string().optional(),
  notes: z.string().optional(),
});

// ─── MILESTONE RECORD ───────────────────────────────
export const MILESTONE_DOMAINS = [
  "GROSS_MOTOR",
  "FINE_MOTOR",
  "LANGUAGE",
  "SOCIAL",
  "COGNITIVE",
] as const;

export const milestoneRecordSchema = z.object({
  patientId: z.string().uuid(),
  ageMonths: z.number().int().min(0).max(240),
  domain: z.enum(MILESTONE_DOMAINS),
  milestone: z.string().min(1),
  achieved: z.boolean(),
  achievedAt: z.string().datetime().optional(),
  notes: z.string().optional(),
});

// ─── FEEDING LOG ────────────────────────────────────
export const FEED_TYPES = [
  "BREAST_LEFT",
  "BREAST_RIGHT",
  "BOTTLE_FORMULA",
  "BOTTLE_EBM",
  "SOLID_FOOD",
] as const;

export const feedingLogSchema = z.object({
  loggedAt: z.string().datetime().optional(),
  feedType: z.enum(FEED_TYPES),
  durationMin: z.number().int().min(0).max(300).optional(),
  volumeMl: z.number().int().min(0).max(2000).optional(),
  foodItem: z.string().optional(),
  notes: z.string().optional(),
});

export type PartographObservationInput = z.infer<typeof partographObservationSchema>;
export type StartPartographInput = z.infer<typeof startPartographSchema>;
export type EndPartographInput = z.infer<typeof endPartographSchema>;
export type AcogRiskScoreInput = z.infer<typeof acogRiskScoreSchema>;
export type PostnatalVisitInput = z.infer<typeof postnatalVisitSchema>;
export type MilestoneRecordInput = z.infer<typeof milestoneRecordSchema>;
export type FeedingLogInput = z.infer<typeof feedingLogSchema>;
