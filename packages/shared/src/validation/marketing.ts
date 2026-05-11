// Shared Zod schema for the public marketing "Request a Demo" enquiry form.
//
// Exists in @medcore/shared (not in apps/api or apps/web) so:
//   - The browser form runs IDENTICAL validation to the server (no drift).
//   - Test suites on either side can import the same schema and error codes.
//
// The web app maps Zod issues onto inline field errors (Issue #45); the API
// maps them onto a structured `{ errors: [{ field, message }] }` 400 response
// and the form re-displays each error under the offending field. The old
// generic "Invalid enquiry payload" toast is gone.
import { z } from "zod";

// India-centric but permissive: accepts an optional `+91` or `0` prefix,
// then 10 digits starting 6-9 (IRTP mobile series). Landlines, non-Indian
// numbers, and empty strings all pass because `phone` is optional on the
// public marketing form.
const INDIAN_MOBILE_RE = /^(?:\+?91[\s-]?|0)?[6-9]\d{9}$/;

export const marketingEnquirySchema = z.object({
  fullName: z
    .string()
    .trim()
    .min(2, "Name must be at least 2 characters")
    .max(100, "Name is too long"),
  email: z
    .string()
    .trim()
    .email("Enter a valid email address")
    .max(200, "Email is too long"),
  // Phone is optional on the public form, but when present it must look
  // like an Indian mobile. Blank strings are normalized to undefined.
  phone: z
    .string()
    .trim()
    .max(30, "Phone number is too long")
    .optional()
    .or(z.literal(""))
    .transform((v) => (v === "" ? undefined : v))
    .refine(
      (v) => v === undefined || INDIAN_MOBILE_RE.test(v.replace(/\s|-/g, "")),
      { message: "Enter a valid Indian mobile number" }
    ),
  hospitalName: z
    .string()
    .trim()
    .min(2, "Hospital name must be at least 2 characters")
    .max(200, "Hospital name is too long"),
  // zod 4: errorMap → error (function returning a string or an issue-shaped
  // object; bare string also accepted).
  hospitalSize: z.enum(["1-10", "10-50", "50-200", "200+"], {
    error: () => "Select a hospital size",
  }),
  role: z.enum(["Administrator", "Doctor", "IT", "Other"], {
    error: () => "Select your role",
  }),
  message: z
    .string()
    .trim()
    .min(10, "Message must be at least 10 characters")
    .max(2000, "Message is too long"),
  preferredContactTime: z
    .enum(["Morning", "Afternoon", "Evening", "Anytime"])
    .optional(),
  // Honeypot — real users leave this empty; bots fill it in.
  website: z.string().optional(),
});

export type MarketingEnquiryInput = z.infer<typeof marketingEnquirySchema>;

// Normalized error shape returned by POST /marketing/enquiry on 400.
// Web form maps each entry back onto its field for inline display.
export interface MarketingEnquiryFieldError {
  field: string;
  message: string;
}

export interface MarketingEnquiryErrorResponse {
  success: false;
  data: null;
  error: string;
  errors: MarketingEnquiryFieldError[];
}

// Flatten a ZodError.issues[] into the FieldError[] shape. Dotted paths are
// joined with "." so `message` stays `message` and nested paths remain
// addressable (`address.city`) if we ever extend the schema.
export function zodIssuesToFieldErrors(
  issues: z.ZodIssue[]
): MarketingEnquiryFieldError[] {
  return issues.map((iss) => ({
    field: iss.path.length > 0 ? iss.path.join(".") : "_root",
    message: iss.message,
  }));
}
