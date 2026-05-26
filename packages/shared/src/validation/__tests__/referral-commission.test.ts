// Coverage tests for the referral-commission ledger validation schemas.
// What: exhaustive happy / invalid / edge cases for every exported Zod schema
//   in packages/shared/src/validation/referral-commission.ts — the list
//   filter (`listReferralCommissionsSchema`) and the PATCH transition
//   (`updateReferralCommissionSchema`).
// Which modules: imports only schemas from ../referral-commission.
// Why: file shipped with 0% colocated coverage (Pearl §4.1 gap row 101,
//   commit cd72635). The transition refine — "paidAt must not be set when
//   transitioning to VOIDED" — is the load-bearing guarantee here; without
//   coverage, a future schema edit could silently allow VOIDED + paidAt
//   payloads through and corrupt the ledger rollup that §4.4 builds on top.
//   Status enum + 500-char notes ceiling + UUID-shape on referringDoctorId
//   are also locked down so the GET filter contract can't drift under the
//   ledger-rollup report query.
import { describe, it, expect } from "vitest";
import {
  listReferralCommissionsSchema,
  updateReferralCommissionSchema,
} from "../referral-commission";

const UUID = "550e8400-e29b-41d4-a716-446655441111";

// ───────────────────────────────────────────────────────
// listReferralCommissionsSchema
// ───────────────────────────────────────────────────────

describe("listReferralCommissionsSchema", () => {
  it("accepts an empty filter object (all fields optional)", () => {
    const res = listReferralCommissionsSchema.safeParse({});
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data).toEqual({});
    }
  });

  it("accepts a fully populated filter", () => {
    const res = listReferralCommissionsSchema.safeParse({
      status: "PENDING",
      referringDoctorId: UUID,
      from: "2026-01-01",
      to: "2026-12-31",
      page: "2",
      limit: "50",
    });
    expect(res.success).toBe(true);
  });

  it.each(["PENDING", "PAID", "VOIDED"] as const)(
    "accepts canonical status %s",
    (status) => {
      const res = listReferralCommissionsSchema.safeParse({ status });
      expect(res.success).toBe(true);
    },
  );

  it("rejects an unknown status", () => {
    const res = listReferralCommissionsSchema.safeParse({ status: "REFUNDED" });
    expect(res.success).toBe(false);
  });

  it("rejects a lowercased status (enum is case-sensitive)", () => {
    const res = listReferralCommissionsSchema.safeParse({ status: "pending" });
    expect(res.success).toBe(false);
  });

  it("rejects a non-UUID referringDoctorId", () => {
    const res = listReferralCommissionsSchema.safeParse({
      referringDoctorId: "not-a-uuid",
    });
    expect(res.success).toBe(false);
  });

  it("accepts a UUID referringDoctorId", () => {
    const res = listReferralCommissionsSchema.safeParse({
      referringDoctorId: UUID,
    });
    expect(res.success).toBe(true);
  });

  it("rejects a non-string from/to (numeric)", () => {
    const res = listReferralCommissionsSchema.safeParse({ from: 20260101 });
    expect(res.success).toBe(false);
  });

  it("accepts string-shaped page/limit (route handler parses to int)", () => {
    // Schema is permissive on page/limit string content — the route handler
    // owns numeric coercion. Just lock that any string passes here.
    const res = listReferralCommissionsSchema.safeParse({
      page: "abc",
      limit: "xyz",
    });
    expect(res.success).toBe(true);
  });

  it("rejects numeric page/limit (must be string per schema)", () => {
    const res = listReferralCommissionsSchema.safeParse({ page: 2 });
    expect(res.success).toBe(false);
  });
});

// ───────────────────────────────────────────────────────
// updateReferralCommissionSchema
// ───────────────────────────────────────────────────────

describe("updateReferralCommissionSchema", () => {
  it("accepts a minimal PAID transition (status only)", () => {
    const res = updateReferralCommissionSchema.safeParse({ status: "PAID" });
    expect(res.success).toBe(true);
  });

  it("accepts a minimal VOIDED transition (status only)", () => {
    const res = updateReferralCommissionSchema.safeParse({ status: "VOIDED" });
    expect(res.success).toBe(true);
  });

  it("accepts PAID with explicit ISO-8601 paidAt", () => {
    const res = updateReferralCommissionSchema.safeParse({
      status: "PAID",
      paidAt: "2026-05-25T10:30:00.000Z",
      notes: "Paid by NEFT ref #ABC123",
    });
    expect(res.success).toBe(true);
  });

  it("rejects PAID with a non-ISO-8601 paidAt", () => {
    const res = updateReferralCommissionSchema.safeParse({
      status: "PAID",
      paidAt: "2026-05-25 10:30:00",
    });
    expect(res.success).toBe(false);
  });

  it("rejects PAID with a date-only paidAt (datetime() requires time component)", () => {
    const res = updateReferralCommissionSchema.safeParse({
      status: "PAID",
      paidAt: "2026-05-25",
    });
    expect(res.success).toBe(false);
  });

  it("rejects VOIDED with paidAt set (refine: paidAt forbidden on void)", () => {
    const res = updateReferralCommissionSchema.safeParse({
      status: "VOIDED",
      paidAt: "2026-05-25T10:30:00.000Z",
    });
    expect(res.success).toBe(false);
    if (!res.success) {
      const flat = res.error.flatten();
      expect(flat.fieldErrors.paidAt?.[0]).toMatch(/paidAt must not be set/i);
    }
  });

  it("accepts VOIDED with notes but no paidAt", () => {
    const res = updateReferralCommissionSchema.safeParse({
      status: "VOIDED",
      notes: "Original referral cancelled; credit note issued.",
    });
    expect(res.success).toBe(true);
  });

  it("rejects PENDING (not a valid PATCH target)", () => {
    // The PATCH surface only allows PENDING → PAID or PENDING → VOIDED.
    // PENDING itself is the starting state, not a target.
    const res = updateReferralCommissionSchema.safeParse({ status: "PENDING" });
    expect(res.success).toBe(false);
  });

  it("rejects an unknown status", () => {
    const res = updateReferralCommissionSchema.safeParse({ status: "REFUNDED" });
    expect(res.success).toBe(false);
  });

  it("rejects missing status (required)", () => {
    const res = updateReferralCommissionSchema.safeParse({
      notes: "no status here",
    });
    expect(res.success).toBe(false);
  });

  it("accepts notes at the 500-char boundary", () => {
    const res = updateReferralCommissionSchema.safeParse({
      status: "PAID",
      notes: "x".repeat(500),
    });
    expect(res.success).toBe(true);
  });

  it("rejects notes over the 500-char boundary", () => {
    const res = updateReferralCommissionSchema.safeParse({
      status: "PAID",
      notes: "x".repeat(501),
    });
    expect(res.success).toBe(false);
  });

  it("accepts empty-string notes (no min length on the field)", () => {
    const res = updateReferralCommissionSchema.safeParse({
      status: "PAID",
      notes: "",
    });
    expect(res.success).toBe(true);
  });

  it("rejects non-string notes", () => {
    const res = updateReferralCommissionSchema.safeParse({
      status: "PAID",
      notes: 12345,
    });
    expect(res.success).toBe(false);
  });
});
