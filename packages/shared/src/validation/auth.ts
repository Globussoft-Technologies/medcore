import { z } from "zod";
import { containsHtmlOrScript, validatePasswordStrength } from "./security";

// Issues #266 + #285 (Apr 2026): the standalone strong-password Zod check.
// The previous "min 6" rule was both too short and missing a denylist —
// `123456` and `password1` both passed. We now require:
//   - >= 8 characters
//   - >= 1 letter AND >= 1 digit
//   - NOT in the curated top-100 common-password list
const strongPassword = z.string().superRefine((pw, ctx) => {
  const r = validatePasswordStrength(pw);
  if (!r.ok) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: r.error || "Password is too weak",
    });
  }
});

export const loginSchema = z.object({
  email: z.string().email("Invalid email address"),
  // Login accepts the legacy-min-6 password so users with pre-#266 accounts
  // can still log in to change their password. The strong-password rule
  // applies only to register / change / reset.
  password: z.string().min(6, "Password must be at least 6 characters"),
  // Issue #1: when true, the server mints a refresh token that lasts 30 days
  // instead of the default 7. Optional so existing callers (older web builds,
  // integration tests) keep working unchanged.
  rememberMe: z.boolean().optional(),
});

// Issue #473 (CRITICAL, May 2026): mass-assignment privilege escalation.
// `role` was previously a REQUIRED field that accepted ANY value from the
// Role enum, including ADMIN. Combined with the route handler doing
// `prisma.user.create({ data: { ..., role } })` on the unauthenticated
// /auth/register endpoint, an attacker could POST `{ ..., role: "ADMIN" }`
// and walk away with an admin account.
//
// Fix: `role` is now OPTIONAL at the schema level — patient self-registration
// can omit it entirely. The actual authorization decision (whether a caller
// is allowed to specify a non-PATIENT role) lives in the route handler in
// apps/api/src/routes/auth.ts, which only honours `role` when the request
// is authenticated as an ADMIN. Anonymous requests are always coerced to
// PATIENT regardless of what was submitted in the body.
//
// The legacy admin-staff-creation flow (dashboard /users page) still POSTs
// to /auth/register with the desired role — that path keeps working because
// the dashboard sends a Bearer token and the handler honours the submitted
// role for ADMIN callers. See route handler comments for the full story.
// Issue #489 (HIGH/PII, May 2026): /auth/register accepted XSS payloads in
// `name` and out-of-range `age`. The schema-level fixes here:
//   - name: trim, max 100, reject any HTML/script vector via `containsHtmlOrScript`
//     so payloads like `<script>alert(1)</script>` are 400'd at validation time
//     before they ever reach the DB. (The route handler also calls
//     `sanitizeUserInput()` as a defence-in-depth second pass.)
//   - age: when supplied, must be an integer in [1, 150]. age=0 is rejected at
//     this surface — the newborn/DOB path lives on `createPatientSchema` in
//     patient.ts, not on the public auth-register endpoint.
export const registerSchema = z.object({
  name: z
    .string()
    .trim()
    .min(2, "Name must be at least 2 characters")
    .max(100, "Name must be at most 100 characters")
    .refine((v) => !containsHtmlOrScript(v), {
      message: "Name contains characters that aren't allowed (e.g. < > or HTML tags)",
    }),
  email: z.string().email("Invalid email address"),
  phone: z.string().min(10, "Phone number must be at least 10 digits"),
  password: strongPassword,
  // Issue #489: bound `age` so negatives, zero, and > 150 are rejected up
  // front. Optional because the historical patient-self-register flow does
  // not send it (DOB-based path).
  age: z
    .number()
    .int("Age must be a whole number")
    .min(1, "Age must be at least 1")
    .max(150, "Age must be at most 150")
    .optional(),
  // Issue #190: keep this list in lockstep with the Role enum in
  // packages/shared/src/types/roles.ts. PHARMACIST + LAB_TECH were
  // missing here, which silently rejected admin-created staff in
  // those roles with a confusing "Validation failed" toast.
  // Issue #473: optional — the route handler decides whether to trust it.
  role: z
    .enum([
      "ADMIN",
      "DOCTOR",
      "RECEPTION",
      "NURSE",
      "PATIENT",
      "PHARMACIST",
      "LAB_TECH",
    ])
    .optional(),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, "Current password is required"),
  newPassword: strongPassword,
});

export const forgotPasswordSchema = z.object({
  email: z.string().email("Invalid email address"),
});

export const resetPasswordSchema = z.object({
  email: z.string().email("Invalid email address"),
  code: z.string().length(6, "Reset code must be 6 digits"),
  newPassword: strongPassword,
});

// Issue #138 (Apr 2026): PATCH /api/v1/auth/me previously accepted an empty
// trimmed name and "abc" as a phone — both shipped through with no field-
// level error. Mirrors the patient-phone regex used by Issue #87 cleanup so
// receptionists, doctors and patients all get the same input contract.
//
// - name: required, trimmed, min 1 (we keep min 1 so existing single-word
//   names like "Anand" are preserved; 2 was too aggressive and broke a few
//   prod rows).
// - phone: optional E.164-ish: 10–15 digits, optional leading "+".
// - photoUrl / preferredLanguage / defaultLandingPage: tolerated but
//   cleaned of stray whitespace.
//
// Issues #392, #393 (Apr 2026): when the keys are present on the patch
// body (the Settings → Profile form always sends both), reject empty
// strings outright with the field-specific message. `.optional()` still
// allows the key to be omitted entirely (used by Preferences tab which
// only sends preferredLanguage / defaultLandingPage).
export const updateProfileSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, "Name cannot be empty")
      .max(100, "Name must be at most 100 characters")
      .optional(),
    phone: z
      .string()
      .trim()
      .regex(/^\+?\d{10,15}$/, "Phone must be 10–15 digits, optional leading +")
      .optional(),
    photoUrl: z.string().nullable().optional(),
    preferredLanguage: z.string().nullable().optional(),
    defaultLandingPage: z.string().nullable().optional(),
  })
  .refine(
    (v) =>
      v.name !== undefined ||
      v.phone !== undefined ||
      v.photoUrl !== undefined ||
      v.preferredLanguage !== undefined ||
      v.defaultLandingPage !== undefined,
    { message: "Nothing to update" }
  );

export type LoginInput = z.infer<typeof loginSchema>;
export type RegisterInput = z.infer<typeof registerSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;
