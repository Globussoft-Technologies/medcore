import { z } from "zod";

// Issue #491 (2026-05-03): the booking form let users pick `01-01-2020` and
// the API happily wrote a row for it. We piggy-back on the existing #362
// helper (recurring appts already do this) — compare the YYYY-MM-DD string
// against the user's local today rather than constructing Date objects, so
// a clerk in IST isn't tripped up by a UTC midnight boundary off-by-one.
function isBookingDateNotPast(yyyyMmDd: string): boolean {
  const today = new Date();
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  return yyyyMmDd >= todayStr;
}

export const bookAppointmentSchema = z.object({
  patientId: z.string().uuid(),
  doctorId: z.string().uuid(),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD")
    .refine(isBookingDateNotPast, "Appointment date must be today or later"),
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

// Issue #213-A: previously the only ordering check on schedule slots was at
// slot-generation time, where a `start > end` row silently produced zero
// slots — but the row itself persisted, polluting the schedule grid with
// nonsense like "20:00 → 08:00 (15min)". A 12-hour overnight row also makes
// no sense for an OPD: a 15-min slot at 03:00 AM has no clinical meaning.
//
// We reject the slot at write-time on three axes:
//   1. endTime must be strictly AFTER startTime (no zero-length, no overnight
//      wrap). Admins who want night-shift coverage create two separate slots:
//      one before midnight and one after.
//   2. The slot's duration must fit at least one configured `slotDurationMinutes`
//      block (so 09:00→09:10 with a 15-min slot duration is rejected, since
//      it would generate zero bookable slots).
//   3. The slot's total duration is capped at MAX_SCHEDULE_SLOT_MINUTES (8 h).
//      OPD shifts longer than that should be split.
const MAX_SCHEDULE_SLOT_MINUTES = 8 * 60; // 8 hours

function parseHHMM(t: string): number | null {
  const m = /^(\d{2}):(\d{2})$/.exec(t);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

export const doctorScheduleSchema = z
  .object({
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
  })
  .superRefine((val, ctx) => {
    const start = parseHHMM(val.startTime);
    const end = parseHHMM(val.endTime);
    if (start === null || end === null) return; // earlier regex already errored
    if (end <= start) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["endTime"],
        message:
          "Schedule slots must end on the same day as they start; for night shifts, create separate slots before midnight and after midnight",
      });
      return;
    }
    const span = end - start;
    if (span > MAX_SCHEDULE_SLOT_MINUTES) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["endTime"],
        message: `Schedule slot is too long (${span} min); max is ${MAX_SCHEDULE_SLOT_MINUTES} min — split into multiple slots`,
      });
    }
    const dur = val.slotDurationMinutes ?? 15;
    if (span < dur) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["endTime"],
        message: `Slot window (${span} min) is shorter than the configured slot duration (${dur} min)`,
      });
    }
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
  // Issue #491 (2026-05-03): same fix as bookAppointmentSchema — reject
  // a reschedule that lands on a past calendar date.
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD")
    .refine(isBookingDateNotPast, "Appointment date must be today or later"),
  slotStart: z.string().regex(/^\d{2}:\d{2}$/, "Time must be HH:MM"),
});

// Issue #362 (2026-04-26): recurring appointments accepted past-dated
// startDate values, which let receptionists "back-date" a series and
// instantly populate the calendar with already-overdue rows. Compare
// against the user's local YYYY-MM-DD (timezone-agnostic string compare)
// so a clerk in IST can still book up to today's date.
function isStartDateNotPast(yyyyMmDd: string): boolean {
  const today = new Date();
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  return yyyyMmDd >= todayStr;
}

export const recurringAppointmentSchema = z.object({
  patientId: z.string().uuid(),
  doctorId: z.string().uuid(),
  startDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD")
    .refine(isStartDateNotPast, "Start date cannot be in the past"),
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
