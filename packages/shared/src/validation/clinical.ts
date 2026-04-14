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

export const scheduleSurgerySchema = z.object({
  patientId: z.string().uuid(),
  surgeonId: z.string().uuid(),
  otId: z.string().uuid(),
  procedure: z.string().min(1),
  scheduledAt: z.string().datetime(),
  durationMin: z.number().int().min(0).optional(),
  anaesthesiologist: z.string().optional(),
  assistants: z.string().optional(),
  preOpNotes: z.string().optional(),
  diagnosis: z.string().optional(),
  cost: z.number().min(0).optional(),
});

export const updateSurgerySchema = z.object({
  procedure: z.string().min(1).optional(),
  scheduledAt: z.string().datetime().optional(),
  durationMin: z.number().int().min(0).optional(),
  anaesthesiologist: z.string().optional(),
  assistants: z.string().optional(),
  preOpNotes: z.string().optional(),
  postOpNotes: z.string().optional(),
  diagnosis: z.string().optional(),
  cost: z.number().min(0).optional(),
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

export type CreateReferralInput = z.infer<typeof createReferralSchema>;
export type UpdateReferralStatusInput = z.infer<typeof updateReferralStatusSchema>;
export type CreateOTInput = z.infer<typeof createOTSchema>;
export type UpdateOTInput = z.infer<typeof updateOTSchema>;
export type ScheduleSurgeryInput = z.infer<typeof scheduleSurgerySchema>;
export type UpdateSurgeryInput = z.infer<typeof updateSurgerySchema>;
export type CompleteSurgeryInput = z.infer<typeof completeSurgerySchema>;
export type CancelSurgeryInput = z.infer<typeof cancelSurgerySchema>;
