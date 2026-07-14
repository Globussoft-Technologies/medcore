// PM-JAY (Ayushman Bharat) request validation schemas.
//
// Zod schemas + inferred types for the PM-JAY routes: beneficiary search /
// verify, family lookup, package master queries, and the inbound TMS webhook.
// Kept in @medcore/shared so both the API routes and the web client can share
// the exact same shapes.

import { z } from "zod";

/** Ayushman card numbers are alphanumeric with dashes; keep it permissive. */
export const AYUSHMAN_CARD_REGEX = /^[A-Za-z0-9-]{4,40}$/;

export const searchBeneficiarySchema = z
  .object({
    ayushmanCardNumber: z
      .string()
      .trim()
      .regex(AYUSHMAN_CARD_REGEX, "Invalid Ayushman card number")
      .optional(),
    beneficiaryId: z.string().trim().min(2).max(40).optional(),
    familyId: z.string().trim().min(2).max(40).optional(),
    mobile: z.string().trim().regex(/^[0-9]{10}$/, "Mobile must be 10 digits").optional(),
    abhaNumber: z.string().trim().min(4).max(40).optional(),
    name: z.string().trim().min(2).max(120).optional(),
  })
  .refine(
    (v) =>
      Boolean(
        v.ayushmanCardNumber || v.beneficiaryId || v.familyId || v.mobile || v.abhaNumber || v.name
      ),
    { message: "Provide at least one identifier (card, beneficiary/family id, mobile, ABHA, or name) to search" }
  );
export type SearchBeneficiaryInput = z.infer<typeof searchBeneficiarySchema>;

export const verifyBeneficiarySchema = z.object({
  patientId: z.string().uuid(),
  ayushmanCardNumber: z
    .string()
    .trim()
    .regex(AYUSHMAN_CARD_REGEX, "Invalid Ayushman card number"),
});
export type VerifyBeneficiaryInput = z.infer<typeof verifyBeneficiarySchema>;

/** Optional PM-JAY fields that a PM-JAY pre-authorisation carries (Stage C UI). */
export const pmjayPreAuthFieldsSchema = z.object({
  packageCode: z.string().trim().min(2).max(40).optional(),
  pmjayRequestId: z.string().trim().max(64).optional(),
  pmjayTransactionId: z.string().trim().max(64).optional(),
  approvalNumber: z.string().trim().max(64).optional(),
});
export type PmjayPreAuthFields = z.infer<typeof pmjayPreAuthFieldsSchema>;

/**
 * Inbound PM-JAY TMS webhook (refinement #4). Verified + mapped by the route;
 * even when async callbacks aren't enabled yet, pinning the shape now keeps the
 * endpoint future-proof.
 */
/**
 * Per-tenant PM-JAY configuration (Settings → PM-JAY). All fields optional so
 * the admin can save partial updates. `clientSecret` is write-only — it is
 * accepted here but NEVER returned by the GET endpoint; an empty/omitted value
 * leaves the stored secret unchanged. URLs are plain strings (state gateways
 * vary and may be non-standard hosts); empty string clears the field.
 */
export const pmjayConfigSchema = z.object({
  enabled: z.boolean().optional(),
  simulationMode: z.boolean().optional(),
  hospitalId: z.string().trim().max(200).optional(),
  clientId: z.string().trim().max(200).optional(),
  clientSecret: z.string().trim().max(1000).optional(),
  baseUrl: z.string().trim().max(500).optional(),
  authUrl: z.string().trim().max(500).optional(),
  bisUrl: z.string().trim().max(500).optional(),
  tmsUrl: z.string().trim().max(500).optional(),
  packageUrl: z.string().trim().max(500).optional(),
  timeout: z.number().int().min(1000).max(120000).optional(),
  retryCount: z.number().int().min(0).max(10).optional(),
  batchSize: z.number().int().min(1).max(5000).optional(),
  logging: z.boolean().optional(),
});
export type PmjayConfigInput = z.infer<typeof pmjayConfigSchema>;

export const pmjayWebhookSchema = z.object({
  claimRef: z.string().trim().min(1),
  status: z.string().trim().min(1),
  approvedAmount: z.number().nonnegative().optional(),
  deniedReason: z.string().trim().max(500).optional(),
  timestamp: z.string().trim().optional(),
  note: z.string().trim().max(500).optional(),
});
export type PmjayWebhookInput = z.infer<typeof pmjayWebhookSchema>;
