import { z } from "zod";

export const BLOOD_GROUPS = [
  "A_POS",
  "A_NEG",
  "B_POS",
  "B_NEG",
  "AB_POS",
  "AB_NEG",
  "O_POS",
  "O_NEG",
] as const;

export const BLOOD_COMPONENTS = [
  "WHOLE_BLOOD",
  "PACKED_RED_CELLS",
  "PLATELETS",
  "FRESH_FROZEN_PLASMA",
  "CRYOPRECIPITATE",
] as const;

export const BLOOD_UNIT_STATUSES = [
  "AVAILABLE",
  "RESERVED",
  "ISSUED",
  "EXPIRED",
  "DISCARDED",
  "IN_TESTING",
] as const;

export const BLOOD_URGENCIES = ["ROUTINE", "URGENT", "EMERGENCY"] as const;

export const GENDERS = ["MALE", "FEMALE", "OTHER"] as const;

export const AMBULANCE_STATUSES = [
  "AVAILABLE",
  "ON_TRIP",
  "MAINTENANCE",
  "OUT_OF_SERVICE",
] as const;

export const AMBULANCE_TRIP_STATUSES = [
  "REQUESTED",
  "DISPATCHED",
  "ARRIVED_SCENE",
  "EN_ROUTE_HOSPITAL",
  "COMPLETED",
  "CANCELLED",
] as const;

export const ASSET_STATUSES = [
  "IN_USE",
  "IDLE",
  "UNDER_MAINTENANCE",
  "RETIRED",
  "LOST",
] as const;

export const MAINTENANCE_TYPES = [
  "SCHEDULED",
  "BREAKDOWN",
  "CALIBRATION",
  "INSPECTION",
] as const;

// ───────────────────────────────────────────────────────
// BLOOD BANK
// ───────────────────────────────────────────────────────

// Issue #428 (Apr 30 2026): Register Donor previously accepted empty / out-of-
// range values (negative age/weight, future last-donation date, garbage blood
// groups). Tighten the schema with a refinement that enforces clinical-grade
// donor eligibility ranges. The base object is kept separate so
// `updateDonorSchema` can still call `.partial()` on it (zod's `.partial`
// is not available on a `ZodEffects` returned by `.superRefine`).
const donorBaseShape = {
  name: z
    .string()
    .trim()
    .min(2, "Name must be at least 2 characters")
    .max(120, "Name is too long"),
  phone: z
    .string()
    .trim()
    .regex(/^\+?[0-9 \-]{7,20}$/, "Phone must be 7-20 digits"),
  email: z
    .string()
    .trim()
    .email("Invalid email")
    .optional()
    .or(z.literal("").transform(() => undefined)),
  bloodGroup: z.enum(BLOOD_GROUPS, {
    errorMap: () => ({ message: "Select a valid blood group" }),
  }),
  dateOfBirth: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "dateOfBirth must be YYYY-MM-DD")
    .optional(),
  gender: z.enum(GENDERS),
  // Donor weight must be ≥ 50 kg per typical blood-bank SOP.
  weight: z
    .number()
    .min(50, "Weight must be at least 50 kg")
    .max(250, "Weight is unrealistic")
    .optional(),
  lastDonation: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "lastDonation must be YYYY-MM-DD")
    .optional(),
  address: z.string().optional(),
  notes: z.string().optional(),
} as const;

const donorBaseSchema = z.object(donorBaseShape);

function donorRefinement(
  val: { dateOfBirth?: string; lastDonation?: string },
  ctx: z.RefinementCtx
) {
  if (val.dateOfBirth) {
    const dob = new Date(val.dateOfBirth);
    if (Number.isNaN(dob.getTime()) || dob.getTime() > Date.now()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["dateOfBirth"],
        message: "Date of birth cannot be in the future",
      });
    } else {
      const ageYears =
        (Date.now() - dob.getTime()) / (365.25 * 24 * 3600 * 1000);
      if (ageYears < 17 || ageYears > 65) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["dateOfBirth"],
          message: "Donor age must be between 17 and 65",
        });
      }
    }
  }
  if (val.lastDonation) {
    const ld = new Date(val.lastDonation);
    if (Number.isNaN(ld.getTime()) || ld.getTime() > Date.now()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["lastDonation"],
        message: "Last donation date cannot be in the future",
      });
    }
  }
}

export const createDonorSchema = donorBaseSchema.superRefine(donorRefinement);

export const updateDonorSchema = donorBaseSchema
  .partial()
  .superRefine(donorRefinement);

export const createDonationSchema = z.object({
  donorId: z.string().uuid(),
  volumeMl: z.number().int().positive().default(450),
  screeningNotes: z.string().optional(),
});

export const approveDonationSchema = z.object({
  approved: z.boolean(),
  notes: z.string().optional(),
  components: z
    .array(
      z.object({
        component: z.enum(BLOOD_COMPONENTS),
        volumeMl: z.number().int().positive(),
        storageLocation: z.string().optional(),
        expiryDays: z.number().int().positive().optional(),
      })
    )
    .optional(),
});

export const createBloodUnitSchema = z.object({
  donationId: z.string().uuid().optional(),
  bloodGroup: z.enum(BLOOD_GROUPS),
  component: z.enum(BLOOD_COMPONENTS),
  volumeMl: z.number().int().positive(),
  collectedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  storageLocation: z.string().optional(),
  notes: z.string().optional(),
});

export const bloodRequestSchema = z.object({
  patientId: z.string().uuid(),
  bloodGroup: z.enum(BLOOD_GROUPS),
  component: z.enum(BLOOD_COMPONENTS),
  unitsRequested: z.number().int().min(1),
  reason: z.string().min(1),
  urgency: z.enum(BLOOD_URGENCIES),
  notes: z.string().optional(),
});

// Issue #93 (2026-04-26): operators can override an ABO mismatch only by
// supplying a clinical reason ≥10 chars (audit trail). Without this
// field the API rejects the issue with a 400 and the UI shows a yellow
// warning banner.
export const issueBloodSchema = z.object({
  unitIds: z.array(z.string().uuid()).min(1),
  overrideAboMismatch: z.boolean().optional(),
  clinicalReason: z.string().min(10).max(500).optional(),
});

export const crossMatchSchema = z.object({
  requestId: z.string().uuid(),
  unitId: z.string().uuid(),
  compatible: z.boolean(),
  notes: z.string().optional(),
});

// ───────────────────────────────────────────────────────
// AMBULANCE
// ───────────────────────────────────────────────────────

// India-centric phone validator. Permissive enough to accept landlines and
// numbers entered with spaces/dashes/parens, but strict enough to reject
// gibberish ("aaaaa", "12", "phone-number"). Reused by ambulance create,
// trip request, and complete-trip schemas (Issue #87).
const AMBULANCE_PHONE_RE = /^[+\d][\d\s().+-]{7,19}$/;
export const ambulancePhoneSchema = z
  .string()
  .trim()
  .min(7, "Phone number must be at least 7 digits")
  .max(20, "Phone number is too long")
  .regex(AMBULANCE_PHONE_RE, "Enter a valid phone number")
  .refine((v) => v.replace(/\D/g, "").length >= 7, {
    message: "Enter a valid phone number",
  });

const optionalPhone = z
  .union([ambulancePhoneSchema, z.literal("")])
  .optional()
  .transform((v) => (v === "" ? undefined : v));

export const createAmbulanceSchema = z.object({
  vehicleNumber: z.string().min(1),
  make: z.string().optional(),
  model: z.string().optional(),
  type: z.string().min(1),
  driverName: z.string().optional(),
  driverPhone: optionalPhone,
  paramedicName: z.string().optional(),
  lastServiceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  nextServiceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  notes: z.string().optional(),
});

export const updateAmbulanceSchema = createAmbulanceSchema.partial().extend({
  status: z.enum(AMBULANCE_STATUSES).optional(),
});

export const tripRequestSchema = z.object({
  ambulanceId: z.string().uuid(),
  patientId: z.string().uuid().optional(),
  callerName: z.string().optional(),
  callerPhone: optionalPhone,
  pickupAddress: z.string().min(1),
  pickupLat: z.number().optional(),
  pickupLng: z.number().optional(),
  dropAddress: z.string().optional(),
  dropLat: z.number().optional(),
  dropLng: z.number().optional(),
  chiefComplaint: z.string().optional(),
  priority: z.enum(["RED", "YELLOW", "GREEN"]).optional(),
});

export const updateTripStatusSchema = z.object({
  status: z.enum(AMBULANCE_TRIP_STATUSES),
  distanceKm: z
    .number({ invalid_type_error: "distanceKm must be a number" })
    .nonnegative("distanceKm cannot be negative")
    .optional(),
  cost: z
    .number({ invalid_type_error: "cost must be a number" })
    .nonnegative("cost cannot be negative")
    .optional(),
  notes: z.string().optional(),
});

// Issue #87: completing a trip MUST capture actual distance, cost, end time,
// and a notes field. Missing/blank/negative values are rejected with clear
// field-level errors so the UI can render inline error hints.
export const completeTripSchema = z.object({
  actualEndTime: z
    .string({ required_error: "actualEndTime is required" })
    .min(1, "actualEndTime is required")
    .refine((v) => !Number.isNaN(Date.parse(v)), {
      message: "actualEndTime must be a valid ISO date-time",
    }),
  finalDistance: z
    .number({
      required_error: "finalDistance is required",
      invalid_type_error: "finalDistance must be a number",
    })
    .positive("finalDistance must be greater than 0"),
  finalCost: z
    .number({
      required_error: "finalCost is required",
      invalid_type_error: "finalCost must be a number",
    })
    .nonnegative("finalCost cannot be negative"),
  notes: z
    .string({ required_error: "notes is required" })
    .trim()
    .min(1, "notes is required"),
});

// ───────────────────────────────────────────────────────
// ASSETS
// ───────────────────────────────────────────────────────

export const createAssetSchema = z.object({
  assetTag: z.string().min(1),
  name: z.string().min(1),
  category: z.string().min(1),
  manufacturer: z.string().optional(),
  modelNumber: z.string().optional(),
  serialNumber: z.string().optional(),
  purchaseDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  purchaseCost: z.number().nonnegative().optional(),
  warrantyExpiry: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  location: z.string().optional(),
  department: z.string().optional(),
  amcProvider: z.string().optional(),
  amcExpiryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  notes: z.string().optional(),
});

export const updateAssetSchema = createAssetSchema.partial().extend({
  status: z.enum(ASSET_STATUSES).optional(),
});

export const assignAssetSchema = z.object({
  assetId: z.string().uuid(),
  assignedTo: z.string().uuid(),
  location: z.string().optional(),
  notes: z.string().optional(),
});

export const returnAssetSchema = z.object({
  notes: z.string().optional(),
});

export const maintenanceLogSchema = z.object({
  assetId: z.string().uuid(),
  type: z.enum(MAINTENANCE_TYPES),
  vendor: z.string().optional(),
  cost: z.number().nonnegative().optional(),
  description: z.string().min(1),
  nextDueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

// ───────────────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────────────

export type CreateDonorInput = z.infer<typeof createDonorSchema>;
export type UpdateDonorInput = z.infer<typeof updateDonorSchema>;
export type CreateDonationInput = z.infer<typeof createDonationSchema>;
export type ApproveDonationInput = z.infer<typeof approveDonationSchema>;
export type CreateBloodUnitInput = z.infer<typeof createBloodUnitSchema>;
export type BloodRequestInput = z.infer<typeof bloodRequestSchema>;
export type IssueBloodInput = z.infer<typeof issueBloodSchema>;
export type CrossMatchInput = z.infer<typeof crossMatchSchema>;

export type CreateAmbulanceInput = z.infer<typeof createAmbulanceSchema>;
export type UpdateAmbulanceInput = z.infer<typeof updateAmbulanceSchema>;
export type TripRequestInput = z.infer<typeof tripRequestSchema>;
export type UpdateTripStatusInput = z.infer<typeof updateTripStatusSchema>;
export type CompleteTripInput = z.infer<typeof completeTripSchema>;

export type CreateAssetInput = z.infer<typeof createAssetSchema>;
export type UpdateAssetInput = z.infer<typeof updateAssetSchema>;
export type AssignAssetInput = z.infer<typeof assignAssetSchema>;
export type ReturnAssetInput = z.infer<typeof returnAssetSchema>;
export type MaintenanceLogInput = z.infer<typeof maintenanceLogSchema>;

// ───────────────────────────────────────────────────────
// BLOOD BANK — DEFERRAL & COMPONENT SEPARATION (Apr 2026)
// ───────────────────────────────────────────────────────

export const DEFERRAL_TYPES = ["TEMPORARY", "PERMANENT"] as const;

export const donorDeferralSchema = z.object({
  reason: z.string().min(1),
  deferralType: z.enum(DEFERRAL_TYPES),
  startDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "startDate must be YYYY-MM-DD")
    .optional(),
  endDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "endDate must be YYYY-MM-DD")
    .optional(),
  notes: z.string().optional(),
});

export const SEPARATION_COMPONENTS = [
  "PRBC",
  "PLATELETS",
  "FFP",
  "CRYO",
] as const;

export const componentSeparationSchema = z.object({
  components: z
    .array(
      z.object({
        component: z.enum(SEPARATION_COMPONENTS),
        unitsProduced: z.number().int().min(1).max(10),
        volumeMl: z.number().int().positive().optional(),
        notes: z.string().optional(),
      })
    )
    .min(1),
});

export type DonorDeferralInput = z.infer<typeof donorDeferralSchema>;
export type ComponentSeparationInput = z.infer<typeof componentSeparationSchema>;
