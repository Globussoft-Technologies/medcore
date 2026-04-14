import { z } from "zod";

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD");
const timeString = z.string().regex(/^\d{2}:\d{2}$/, "Expected HH:MM");

export const shiftTypeEnum = z.enum([
  "MORNING",
  "AFTERNOON",
  "NIGHT",
  "ON_CALL",
]);

export const shiftStatusEnum = z.enum([
  "SCHEDULED",
  "PRESENT",
  "ABSENT",
  "LATE",
  "LEAVE",
]);

export const leaveTypeEnum = z.enum([
  "CASUAL",
  "SICK",
  "EARNED",
  "MATERNITY",
  "PATERNITY",
  "UNPAID",
]);

export const leaveStatusEnum = z.enum([
  "PENDING",
  "APPROVED",
  "REJECTED",
  "CANCELLED",
]);

export const createShiftSchema = z.object({
  userId: z.string().uuid(),
  date: dateString,
  type: shiftTypeEnum,
  startTime: timeString,
  endTime: timeString,
  notes: z.string().optional(),
});

export const bulkShiftSchema = z.object({
  shifts: z.array(createShiftSchema).min(1),
});

export const updateShiftSchema = z.object({
  date: dateString.optional(),
  type: shiftTypeEnum.optional(),
  startTime: timeString.optional(),
  endTime: timeString.optional(),
  status: shiftStatusEnum.optional(),
  notes: z.string().optional(),
});

export const updateShiftStatusSchema = z.object({
  status: shiftStatusEnum,
  notes: z.string().optional(),
});

export const checkOutShiftSchema = z.object({
  notes: z.string().optional(),
});

export const createLeaveRequestSchema = z
  .object({
    type: leaveTypeEnum,
    fromDate: dateString,
    toDate: dateString,
    reason: z.string().min(1, "Reason is required"),
  })
  .refine(
    (v) => new Date(v.fromDate).getTime() <= new Date(v.toDate).getTime(),
    { message: "toDate must be on or after fromDate", path: ["toDate"] }
  );

export const approveLeaveSchema = z.object({
  status: z.enum(["APPROVED", "REJECTED"]),
  rejectionReason: z.string().optional(),
});

export const rejectLeaveSchema = z.object({
  rejectionReason: z.string().min(1, "Rejection reason is required"),
});

export type CreateShiftInput = z.infer<typeof createShiftSchema>;
export type BulkShiftInput = z.infer<typeof bulkShiftSchema>;
export type UpdateShiftInput = z.infer<typeof updateShiftSchema>;
export type UpdateShiftStatusInput = z.infer<typeof updateShiftStatusSchema>;
export type CheckOutShiftInput = z.infer<typeof checkOutShiftSchema>;
export type CreateLeaveRequestInput = z.infer<typeof createLeaveRequestSchema>;
export type ApproveLeaveInput = z.infer<typeof approveLeaveSchema>;
export type RejectLeaveInput = z.infer<typeof rejectLeaveSchema>;
