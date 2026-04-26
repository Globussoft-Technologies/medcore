import { z } from "zod";

export const createReferralSchema = z
  .object({
    patientId: z.string().uuid(),
    fromDoctorId: z.string().uuid(),
    toDoctorId: z.string().uuid().optional(),
    externalProvider: z.string().optional(),
    externalContact: z.string().optional(),
    specialty: z.string().optional(),
    reason: z.string().min(1, "Reason is required"),
    notes: z.string().optional(),
  })
  .refine(
    (data) => !!data.toDoctorId || !!data.externalProvider,
    {
      message: "Either toDoctorId or externalProvider is required",
      path: ["toDoctorId"],
    }
  );

export const updateReferralStatusSchema = z.object({
  status: z.enum(["PENDING", "ACCEPTED", "COMPLETED", "DECLINED", "EXPIRED"]),
  notes: z.string().optional(),
});

export const createOTSchema = z.object({
  name: z.string().min(1),
  floor: z.string().optional(),
  equipment: z.string().optional(),
  dailyRate: z.number().min(0).default(0),
});

export const updateOTSchema = z.object({
  name: z.string().min(1).optional(),
  floor: z.string().optional(),
  equipment: z.string().optional(),
  dailyRate: z.number().min(0).optional(),
  isActive: z.boolean().optional(),
});

// Issue #86 (Apr 2026): block scheduling surgeries in the past at the API
// boundary. Frontend mirrors the same constraint as a `min` on the
// datetime-local input. 5-minute clock-skew tolerance lets a "now" submission
// succeed without the user racing the clock.
export const scheduleSurgerySchema = z.object({
  patientId: z.string().uuid(),
  surgeonId: z.string().uuid(),
  otId: z.string().uuid(),
  procedure: z.string().min(1, "Procedure is required"),
  scheduledAt: z
    .string()
    .datetime({ message: "Scheduled date/time must be ISO-8601" })
    .refine(
      (s) => new Date(s).getTime() >= Date.now() - 5 * 60 * 1000,
      "Scheduled date/time cannot be in the past"
    ),
  // Issue #53 (Apr 2026): duration must be strictly positive (a 0-minute
  // surgery is meaningless); cost must be non-negative (free surgeries are
  // legal — pro-bono, charity cases — but negative cost is not).
  durationMin: z.number().int().positive("Duration must be greater than 0").optional(),
  anaesthesiologist: z.string().optional(),
  assistants: z.string().optional(),
  preOpNotes: z.string().optional(),
  diagnosis: z.string().optional(),
  cost: z.number().nonnegative("Cost cannot be negative").optional(),
});

export const updateSurgerySchema = z.object({
  procedure: z.string().min(1).optional(),
  scheduledAt: z.string().datetime().optional(),
  // Issue #53: same constraints on update path.
  durationMin: z.number().int().positive("Duration must be greater than 0").optional(),
  anaesthesiologist: z.string().optional(),
  assistants: z.string().optional(),
  preOpNotes: z.string().optional(),
  postOpNotes: z.string().optional(),
  diagnosis: z.string().optional(),
  cost: z.number().nonnegative("Cost cannot be negative").optional(),
  status: z
    .enum(["SCHEDULED", "IN_PROGRESS", "COMPLETED", "CANCELLED", "POSTPONED"])
    .optional(),
  actualStartAt: z.string().datetime().optional(),
  actualEndAt: z.string().datetime().optional(),
  otId: z.string().uuid().optional(),
  surgeonId: z.string().uuid().optional(),
});

export const completeSurgerySchema = z.object({
  postOpNotes: z.string().optional(),
  diagnosis: z.string().optional(),
});

export const cancelSurgerySchema = z.object({
  reason: z.string().min(1, "Cancellation reason is required"),
});

export const preOpChecklistSchema = z.object({
  consentSigned: z.boolean().optional(),
  npoSince: z.string().datetime().optional(),
  allergiesVerified: z.boolean().optional(),
  antibioticsGiven: z.boolean().optional(),
  antibioticsAt: z.string().datetime().optional(),
  siteMarked: z.boolean().optional(),
  bloodReserved: z.boolean().optional(),
});

export const intraOpTimingSchema = z.object({
  anesthesiaStartAt: z.string().datetime().optional(),
  anesthesiaEndAt: z.string().datetime().optional(),
  incisionAt: z.string().datetime().optional(),
  closureAt: z.string().datetime().optional(),
});

export const complicationsSchema = z.object({
  complications: z.string().min(1),
  complicationSeverity: z.enum(["MILD", "MODERATE", "SEVERE"]).optional(),
  bloodLossMl: z.number().int().nonnegative().optional(),
});

export type CreateReferralInput = z.infer<typeof createReferralSchema>;
export type UpdateReferralStatusInput = z.infer<typeof updateReferralStatusSchema>;
export type CreateOTInput = z.infer<typeof createOTSchema>;
export type UpdateOTInput = z.infer<typeof updateOTSchema>;
export type ScheduleSurgeryInput = z.infer<typeof scheduleSurgerySchema>;
export type UpdateSurgeryInput = z.infer<typeof updateSurgerySchema>;
export type CompleteSurgeryInput = z.infer<typeof completeSurgerySchema>;
export type CancelSurgeryInput = z.infer<typeof cancelSurgerySchema>;
export type PreOpChecklistInput = z.infer<typeof preOpChecklistSchema>;
export type IntraOpTimingInput = z.infer<typeof intraOpTimingSchema>;
export type ComplicationsInput = z.infer<typeof complicationsSchema>;
