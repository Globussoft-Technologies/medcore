// Patient phone-OTP login schemas (Pearl §5.3 / §6.1 — gap #5 piece 2 of 4).
//
// These are intentionally a separate validation surface from the staff
// /auth/login schemas (`packages/shared/src/validation/auth.ts`) because:
//   - Staff log in with email + password ± TOTP. Patients log in with
//     phone + a one-time 6-digit code.
//   - Patient phones are the lookup key (User.phone, already @@index in
//     the schema). Staff phones are decorative.
//   - The two flows audit-log to different actions and rate-limit on
//     different buckets — keeping the schemas separate avoids a future
//     mistake of swapping one for the other.
//
// Phone normalisation: the canonical stored form is a bare 10-digit
// Indian number. The schema accepts the three input shapes seen in
// production (`+919876543210`, `919876543210`, `09876543210`,
// `9876543210`) and the route handler calls `canonicalisePhone()` to
// strip them down before DB lookup or persistence. We export the
// canonicaliser alongside the schemas so the API and any future client
// validator share one implementation.

import { z } from "zod";

/**
 * Loose accept-shape used at the schema layer. The route handler normalises
 * to a 10-digit Indian form via {@link canonicalisePhone} before any DB
 * lookup. Accepts:
 *   - "9876543210"      → 10 digits
 *   - "09876543210"     → 11 digits w/ leading 0
 *   - "919876543210"    → 12 digits w/ "91" country prefix
 *   - "+919876543210"   → E.164 form
 *   - "+1234567890123"  → other-country E.164 (10-15 digits)
 *
 * The route is currently India-only (per Pearl scope), but we keep the
 * shape permissive so the same schema can serve future overseas tenants
 * without a wire-level schema bump.
 */
const PATIENT_PHONE_REGEX = /^\+?[0-9]{10,15}$/;

/**
 * Reduce any of the accepted phone input shapes to a canonical 10-digit
 * Indian form (the form persisted in `User.phone` per current production
 * data — see schema.prisma `User.phone` column + the existing
 * `PHONE_REGEX = /^\+?\d{10,15}$/` at validation/patient.ts:14). When the
 * input has more than 10 digits we strip a leading "+91", "91", or "0"
 * once; anything else is returned as-is so callers see a deterministic
 * value they can compare or store.
 */
export function canonicalisePhone(raw: string): string {
  const trimmed = raw.trim();
  // Drop leading + and country-code 91 — most production rows look like
  // "9876543210" (10 digits), so we collapse the +91 / 91 / leading-0
  // variants to that shape.
  let s = trimmed.startsWith("+") ? trimmed.slice(1) : trimmed;
  if (s.length === 12 && s.startsWith("91")) s = s.slice(2);
  else if (s.length === 11 && s.startsWith("0")) s = s.slice(1);
  return s;
}

export const requestPatientOtpSchema = z.object({
  phone: z
    .string()
    .trim()
    .regex(
      PATIENT_PHONE_REGEX,
      "Phone must be 10–15 digits, optional leading +",
    ),
});

export type RequestPatientOtpInput = z.infer<typeof requestPatientOtpSchema>;

export const verifyPatientOtpSchema = z.object({
  phone: z
    .string()
    .trim()
    .regex(
      PATIENT_PHONE_REGEX,
      "Phone must be 10–15 digits, optional leading +",
    ),
  otp: z
    .string()
    .trim()
    .length(6, "OTP must be exactly 6 digits")
    .regex(/^\d{6}$/, "OTP must be 6 digits"),
});

export type VerifyPatientOtpInput = z.infer<typeof verifyPatientOtpSchema>;

/**
 * Firebase Phone Auth exchange schema. The patient frontend completes
 * Firebase's signInWithPhoneNumber → confirm() handshake, receives an ID
 * token, and POSTs it here. The route handler verifies the token with the
 * firebase-admin SDK (signature, audience, issuer, expiry, revocation),
 * extracts the verified `phone_number` claim, and uses THAT phone to find
 * the patient User row — never the body. The token itself is the only
 * thing the client supplies; the phone is read from the verified claim so
 * a malicious client can't tunnel "I just verified phone X but please log
 * me in as patient Y".
 *
 * Length cap is generous (4096 chars) because Firebase ID tokens are
 * standard JWTs — ours typically run ~1200-1800 chars. Tighter than no cap
 * (DoS surface for `verifyIdToken`).
 */
export const firebaseVerifyPatientSchema = z.object({
  idToken: z
    .string()
    .trim()
    .min(1, "ID token is required")
    .max(4096, "ID token is too long"),
});

export type FirebaseVerifyPatientInput = z.infer<
  typeof firebaseVerifyPatientSchema
>;
