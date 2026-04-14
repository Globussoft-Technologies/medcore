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

export const createDonorSchema = z.object({
  name: z.string().min(1),
  phone: z.string().min(5),
  email: z.string().email().optional(),
  bloodGroup: z.enum(BLOOD_GROUPS),
  dateOfBirth: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "dateOfBirth must be YYYY-MM-DD")
    .optional(),
  gender: z.enum(GENDERS),
  weight: z.number().positive().optional(),
  address: z.string().optional(),
  notes: z.string().optional(),
});

export const updateDonorSchema = createDonorSchema.partial();

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

export const issueBloodSchema = z.object({
  unitIds: z.array(z.string().uuid()).min(1),
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

export const createAmbulanceSchema = z.object({
  vehicleNumber: z.string().min(1),
  make: z.string().optional(),
  model: z.string().optional(),
  type: z.string().min(1),
  driverName: z.string().optional(),
  driverPhone: z.string().optional(),
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
  callerPhone: z.string().optional(),
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
  distanceKm: z.number().nonnegative().optional(),
  cost: z.number().nonnegative().optional(),
  notes: z.string().optional(),
});

export const completeTripSchema = z.object({
  distanceKm: z.number().nonnegative().optional(),
  cost: z.number().nonnegative().optional(),
  notes: z.string().optional(),
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
