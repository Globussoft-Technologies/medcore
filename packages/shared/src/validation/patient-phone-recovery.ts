// Patient forgot-phone recovery schema (Pearl §5.3 / gap row 149).
//
// What:  Validates the body of POST /api/v1/patients/:id/recover-phone, the
//        reception-mediated path for a patient who has lost access to their
//        registered phone (lost SIM, switched carrier, etc.) and CANNOT use
//        the self-service phone-OTP login at `/patient-auth/otp-request`.
// Why:   DPDP / HIPAA-compliant phone recovery requires a documented
//        identity-verification artefact. Reception verifies a govt ID in
//        person, records WHAT they checked + a free-text note describing
//        the match (e.g. "Aadhaar last 4: 1234, DOB matches chart") and the
//        new phone gets attached to the patient's User row. The schema
//        enforces both: a typed identity-method enum + a 10–500 char note
//        so the audit row carries enough context to satisfy a later
//        compliance review.
// Where: Mounted on the staff /patients router (NOT the patient-auth router)
//        because the caller IS staff, not the patient. RBAC at the route
//        layer restricts to RECEPTION + ADMIN.

import { z } from "zod";

/** Same loose-accept regex used by patient-auth (10-15 digits, optional +).
 *  The route handler canonicalises to 10-digit form via
 *  `canonicalisePhone()` from `./patient-auth` before any DB write. */
const RECOVER_PHONE_REGEX = /^\+?[0-9]{10,15}$/;

/**
 * Identity-verification methods the receptionist is allowed to record.
 * Mirrors common Indian govt-ID surfaces; PHOTO_MATCH is the
 * face-against-photoUrl path for patients who only have the chart
 * photograph as proof (e.g. minors, elderly, patients without ID).
 */
export const recoverPhoneIdentityMethodSchema = z.enum([
  "AADHAAR",
  "PAN",
  "VOTER_ID",
  "DRIVING_LICENSE",
  "PHOTO_MATCH",
]);

export type RecoverPhoneIdentityMethod = z.infer<
  typeof recoverPhoneIdentityMethodSchema
>;

export const recoverPhoneSchema = z.object({
  newPhone: z
    .string()
    .trim()
    .regex(
      RECOVER_PHONE_REGEX,
      "Phone must be 10–15 digits, optional leading +",
    ),
  identityVerification: z.object({
    method: recoverPhoneIdentityMethodSchema,
    // 10-500 char note: mandatory free-text describing what was checked.
    // Lower bound stops "ok" / "verified" one-word entries that defeat
    // the audit-trail purpose; upper bound keeps the AuditLog payload
    // bounded.
    note: z
      .string()
      .trim()
      .min(10, "Identity verification note must be at least 10 characters")
      .max(500, "Identity verification note must be at most 500 characters"),
  }),
});

export type RecoverPhoneInput = z.infer<typeof recoverPhoneSchema>;
