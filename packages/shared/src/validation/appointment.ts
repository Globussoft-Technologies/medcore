import { z } from "zod";

export const bookAppointmentSchema = z.object({
  patientId: z.string().uuid(),
  doctorId: z.string().uuid(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD"),
  slotId: z.string().uuid(),
  notes: z.string().optional(),
});

export const walkInSchema = z.object({
  patientId: z.string().uuid(),
  doctorId: z.string().uuid(),
  priority: z.enum(["NORMAL", "URGENT", "EMERGENCY"]).default("NORMAL"),
  notes: z.string().optional(),
});

export const updateAppointmentStatusSchema = z.object({
  status: z.enum([
    "BOOKED",
    "CHECKED_IN",
    "IN_CONSULTATION",
    "COMPLETED",
    "CANCELLED",
    "NO_SHOW",
  ]),
});

// Issue #77 — the Schedule Management page submits `dayOfWeek` as a label
// ("MONDAY" .. "SUNDAY") for clarity, while the underlying Prisma column is
// an `Int` (0=Sun..6=Sat). Accept both forms here and normalise downstream.
const DAY_NAME_TO_INDEX: Record<string, number> = {
  SUNDAY: 0,
  MONDAY: 1,
  TUESDAY: 2,
  WEDNESDAY: 3,
  THURSDAY: 4,
  FRIDAY: 5,
  SATURDAY: 6,
};

export const doctorScheduleSchema = z.object({
  doctorId: z.string().uuid().optional(),
  dayOfWeek: z.union([
    z.number().int().min(0).max(6),
    z
      .string()
      .transform((s) => DAY_NAME_TO_INDEX[s.toUpperCase()])
      .refine((n) => typeof n === "number" && n >= 0 && n <= 6, {
        message:
          "dayOfWeek must be 0-6 or a day name (SUNDAY..SATURDAY)",
      }),
  ]),
  startTime: z.string().regex(/^\d{2}:\d{2}$/, "Time must be HH:MM"),
  endTime: z.string().regex(/^\d{2}:\d{2}$/, "Time must be HH:MM"),
  slotDurationMinutes: z.number().int().min(5).max(120).default(15),
  bufferMinutes: z.number().int().min(0).max(60).default(0),
});

export const scheduleOverrideSchema = z.object({
  doctorId: z.string().uuid(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD"),
  isBlocked: z.boolean().default(true),
  startTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  endTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  reason: z.string().optional(),
});

export const rescheduleAppointmentSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD"),
  slotStart: z.string().regex(/^\d{2}:\d{2}$/, "Time must be HH:MM"),
});

export const recurringAppointmentSchema = z.object({
  patientId: z.string().uuid(),
  doctorId: z.string().uuid(),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD"),
  slotStart: z.string().regex(/^\d{2}:\d{2}$/, "Time must be HH:MM"),
  frequency: z.enum(["DAILY", "WEEKLY", "MONTHLY"]),
  occurrences: z.number().int().min(2).max(52),
  notes: z.string().optional(),
});

// ─── Waitlist (Apr 2026) ─────────────────────────────
export const waitlistEntrySchema = z.object({
  patientId: z.string().uuid(),
  doctorId: z.string().uuid(),
  preferredDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD")
    .optional(),
  reason: z.string().max(500).optional(),
});

// ─── Coordinated multi-doctor visit (Apr 2026) ───────
export const coordinatedVisitSchema = z.object({
  patientId: z.string().uuid(),
  name: z.string().min(1).max(200),
  visitDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD"),
  doctorIds: z.array(z.string().uuid()).min(1).max(10),
  notes: z.string().optional(),
});

// ─── Transfer between doctors (Apr 2026) ─────────────
export const transferAppointmentSchema = z.object({
  newDoctorId: z.string().uuid(),
  reason: z.string().min(1).max(500),
});

// ─── LWBS (Left Without Being Seen) (Apr 2026) ───────
export const markLwbsSchema = z.object({
  reason: z.string().max(500).optional(),
});

// ─── Booking w/ override for no-show policy (Apr 2026) ─
export const bookAppointmentWithOverrideSchema = bookAppointmentSchema.extend({
  overrideNoShow: z.boolean().optional(),
});

export type BookAppointmentInput = z.infer<typeof bookAppointmentSchema>;
export type WalkInInput = z.infer<typeof walkInSchema>;
export type UpdateAppointmentStatusInput = z.infer<typeof updateAppointmentStatusSchema>;
export type DoctorScheduleInput = z.infer<typeof doctorScheduleSchema>;
export type ScheduleOverrideInput = z.infer<typeof scheduleOverrideSchema>;
export type RescheduleAppointmentInput = z.infer<typeof rescheduleAppointmentSchema>;
export type RecurringAppointmentInput = z.infer<typeof recurringAppointmentSchema>;
export type WaitlistEntryInput = z.infer<typeof waitlistEntrySchema>;
export type CoordinatedVisitInput = z.infer<typeof coordinatedVisitSchema>;
export type TransferAppointmentInput = z.infer<typeof transferAppointmentSchema>;
export type MarkLwbsInput = z.infer<typeof markLwbsSchema>;
