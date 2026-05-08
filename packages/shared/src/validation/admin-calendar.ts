// Shared Zod schemas for two admin-management tables introduced together
// to close GitHub issues #718 (Calendar New Event) and #724 (Insurance
// Add Provider). Lives in @medcore/shared so the browser-side form and
// the Express handler reject the same shapes with the same error copy
// (no drift).
import { z } from "zod";

// ─── #718 — admin calendar events ──────────────────────────────────────
// The calendar already plots six other event archetypes (appointments,
// surgery, telemedicine, ANC, follow-ups, shifts), each owned by its
// own model. `CalendarEvent` is the catch-all for ad-hoc events: staff
// training, town halls, public-holiday closures the Holiday table doesn't
// already have, marketing campaigns. Title + start + end + free-text
// category + optional color hint (Tailwind class). End must strictly
// exceed start (matches the Lane C #731 server contract on appointments
// so the calendar's local validation skips a 400 round-trip).
export const CALENDAR_EVENT_CATEGORIES = [
  "TRAINING",
  "CLOSURE",
  "TOWN_HALL",
  "MAINTENANCE",
  "MARKETING",
  "OTHER",
] as const;

export const createCalendarEventSchema = z
  .object({
    title: z
      .string()
      .trim()
      .min(2, "Title must be at least 2 characters")
      .max(200, "Title is too long"),
    category: z.enum(CALENDAR_EVENT_CATEGORIES).default("OTHER"),
    startAt: z
      .string()
      .datetime({ offset: true, message: "startAt must be an ISO datetime" }),
    endAt: z
      .string()
      .datetime({ offset: true, message: "endAt must be an ISO datetime" }),
    color: z
      .string()
      .trim()
      .max(40, "Color hint is too long")
      .optional()
      .or(z.literal(""))
      .transform((v) => (v === "" ? undefined : v)),
    description: z
      .string()
      .trim()
      .max(2000, "Description is too long")
      .optional()
      .or(z.literal(""))
      .transform((v) => (v === "" ? undefined : v)),
  })
  .superRefine((val, ctx) => {
    const start = Date.parse(val.startAt);
    const end = Date.parse(val.endAt);
    if (Number.isFinite(start) && Number.isFinite(end) && end <= start) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["endAt"],
        message: "endAt must be after startAt",
      });
    }
  });

export const updateCalendarEventSchema = z
  .object({
    title: z.string().trim().min(2).max(200).optional(),
    category: z.enum(CALENDAR_EVENT_CATEGORIES).optional(),
    startAt: z.string().datetime({ offset: true }).optional(),
    endAt: z.string().datetime({ offset: true }).optional(),
    color: z.string().trim().max(40).optional().nullable(),
    description: z.string().trim().max(2000).optional().nullable(),
  })
  .superRefine((val, ctx) => {
    if (val.startAt && val.endAt) {
      const start = Date.parse(val.startAt);
      const end = Date.parse(val.endAt);
      if (Number.isFinite(start) && Number.isFinite(end) && end <= start) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["endAt"],
          message: "endAt must be after startAt",
        });
      }
    }
  });

// ─── #724 — insurance providers (TPAs) ─────────────────────────────────
// Backs the admin Insurance Providers page so new TPAs can be onboarded
// without touching the curated `INDIAN_INSURERS` constant in
// packages/shared/src/constants.ts. Code is the short identifier used in
// claims/preauth (e.g. MEDI_ASSIST, VIDAL); name is the display label;
// contact + coverage are free text the admin can paste from the partner
// agreement.
const PROVIDER_CODE_RE = /^[A-Z][A-Z0-9_]{1,30}$/;

export const createInsuranceProviderSchema = z.object({
  name: z
    .string()
    .trim()
    .min(2, "Provider name must be at least 2 characters")
    .max(200, "Provider name is too long"),
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(
      PROVIDER_CODE_RE,
      "Code must be 2–31 chars, uppercase letters/digits/underscore, starting with a letter"
    ),
  contactPerson: z
    .string()
    .trim()
    .max(200)
    .optional()
    .or(z.literal(""))
    .transform((v) => (v === "" ? undefined : v)),
  contactEmail: z
    .string()
    .trim()
    .email("Enter a valid email address")
    .max(200)
    .optional()
    .or(z.literal(""))
    .transform((v) => (v === "" ? undefined : v)),
  contactPhone: z
    .string()
    .trim()
    .max(30)
    .optional()
    .or(z.literal(""))
    .transform((v) => (v === "" ? undefined : v))
    .refine(
      (v) => v === undefined || /^\+?\d[\d\s\-]{6,29}$/.test(v),
      "Enter a valid phone number"
    ),
  coverageDetails: z
    .string()
    .trim()
    .max(4000, "Coverage details are too long")
    .optional()
    .or(z.literal(""))
    .transform((v) => (v === "" ? undefined : v)),
});

export const updateInsuranceProviderSchema = z.object({
  name: z.string().trim().min(2).max(200).optional(),
  code: z.string().trim().toUpperCase().regex(PROVIDER_CODE_RE).optional(),
  contactPerson: z.string().trim().max(200).optional().nullable(),
  contactEmail: z.string().trim().email().max(200).optional().nullable(),
  contactPhone: z
    .string()
    .trim()
    .max(30)
    .optional()
    .nullable()
    .refine(
      (v) =>
        v === undefined ||
        v === null ||
        v === "" ||
        /^\+?\d[\d\s\-]{6,29}$/.test(v),
      "Enter a valid phone number"
    ),
  coverageDetails: z.string().trim().max(4000).optional().nullable(),
  isActive: z.boolean().optional(),
});

export type CreateCalendarEventInput = z.infer<typeof createCalendarEventSchema>;
export type UpdateCalendarEventInput = z.infer<typeof updateCalendarEventSchema>;
export type CreateInsuranceProviderInput = z.infer<typeof createInsuranceProviderSchema>;
export type UpdateInsuranceProviderInput = z.infer<typeof updateInsuranceProviderSchema>;
