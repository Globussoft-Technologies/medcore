/**
 * Referral-commission validation — Pearl ERP Stage 1 §4.1 (gap row 101).
 *
 * What / which modules / why:
 *   - Used by the new `/api/v1/referral-commissions` API surface to
 *     validate GET filter params and the PATCH mark-PAID body.
 *   - GET filters mirror the report query shape the §4.4 ledger-rollup
 *     piece will reuse — status + date range + referringDoctor.
 *   - PATCH only supports two state transitions for now: PENDING → PAID
 *     (with paidAt + notes) and PENDING → VOIDED (manual void; the
 *     auto-void cascade lives in billing.ts credit-notes handler).
 */
import { z } from "zod";

export const listReferralCommissionsSchema = z.object({
  status: z.enum(["PENDING", "PAID", "VOIDED"]).optional(),
  referringDoctorId: z.string().uuid().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  page: z.string().optional(),
  limit: z.string().optional(),
});

export const updateReferralCommissionSchema = z
  .object({
    status: z.enum(["PAID", "VOIDED"]),
    notes: z.string().max(500).optional(),
    // Optional explicit `paidAt`; defaults to now() server-side when the
    // status is PAID and the field is omitted. Always ISO-8601.
    paidAt: z.string().datetime().optional(),
  })
  .refine(
    (v) => v.status !== "VOIDED" || !v.paidAt,
    {
      message: "paidAt must not be set when transitioning to VOIDED",
      path: ["paidAt"],
    },
  );

export type ListReferralCommissionsInput = z.infer<typeof listReferralCommissionsSchema>;
export type UpdateReferralCommissionInput = z.infer<typeof updateReferralCommissionSchema>;
