/**
 * PM-JAY (Ayushman Bharat) adapter — simulation-mode unit tests.
 *
 * What / which modules / why
 * ──────────────────────────
 * - WHAT: exercises `adapters/pmjay.ts` in SIMULATION mode (the default when
 *   no TPA_PMJAY_* credentials are set): submit (idempotent, deterministic
 *   `PMJAY-<hash>` ref), status read, document upload, cancel (with the
 *   settled-claim BUSINESS_RULE guard), the `enabled=false` short-circuit, and
 *   full coverage of the `__internal.mapPmjayStatus` normaliser.
 * - MODULES: imports the public `pmjayAdapter`, `__pmjayInternals` escape
 *   hatch, and `__internal`. No Prisma / network — simulation state is a
 *   module-scope Map reset in `beforeEach` (CLAUDE.md gotcha #2).
 * - WHY: PM-JAY is a first-class provider on the shared ClaimsAdapter contract;
 *   the deterministic ref + idempotency are the durable cross-system key the
 *   reconciliation worker and store rely on, exactly like the MOCK adapter.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { pmjayAdapter, __pmjayInternals, __internal } from "./pmjay";
import type {
  ClaimSubmissionInput,
  NormalisedClaimStatus,
} from "../adapter";

const ENV_KEYS = [
  "TPA_PMJAY_ENABLED",
  "TPA_PMJAY_SIMULATION",
  "TPA_PMJAY_HOSPITAL_ID",
  "TPA_PMJAY_CLIENT_ID",
  "TPA_PMJAY_CLIENT_SECRET",
  "TPA_PMJAY_BASE_URL",
  "TPA_PMJAY_AUTH_URL",
  "TPA_PMJAY_TMS_URL",
] as const;
const savedEnv: Record<string, string | undefined> = {};

function makeInput(over: Partial<ClaimSubmissionInput> = {}): ClaimSubmissionInput {
  return {
    internalClaimId: over.internalClaimId ?? "ic-1",
    invoiceId: over.invoiceId ?? "inv-1",
    patient: over.patient ?? { name: "Asha Patel", gender: "FEMALE" },
    policy: over.policy ?? {
      policyNumber: "PMJAY-CARD-001",
      insurerName: "PM-JAY",
      tpaProvider: "PMJAY",
    },
    diagnosis: over.diagnosis ?? "Pneumonia",
    amountClaimed: over.amountClaimed ?? 5000,
    ...over,
  } as ClaimSubmissionInput;
}

beforeEach(() => {
  process.env.NODE_ENV = "test";
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  // No live creds ⇒ simulation mode.
  for (const k of ENV_KEYS) delete process.env[k];
  __pmjayInternals.reset();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe("pmjayAdapter — contract shape", () => {
  it("exposes the PMJAY provider tag and the four ClaimsAdapter methods", () => {
    expect(pmjayAdapter.provider).toBe("PMJAY");
    expect(typeof pmjayAdapter.submitClaim).toBe("function");
    expect(typeof pmjayAdapter.getClaimStatus).toBe("function");
    expect(typeof pmjayAdapter.uploadDocument).toBe("function");
    expect(typeof pmjayAdapter.cancelClaim).toBe("function");
  });
});

describe("pmjayAdapter.submitClaim (simulation)", () => {
  it("rejects a non-positive amountClaimed with INVALID_INPUT", async () => {
    const r = await pmjayAdapter.submitClaim(makeInput({ amountClaimed: 0 }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("INVALID_INPUT");
  });

  it("returns TPA_UNAVAILABLE when the integration is disabled", async () => {
    process.env.TPA_PMJAY_ENABLED = "false";
    const r = await pmjayAdapter.submitClaim(makeInput());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("TPA_UNAVAILABLE");
  });

  it("creates a claim with a deterministic PMJAY-<12-hex> ref + SUBMITTED", async () => {
    const r = await pmjayAdapter.submitClaim(makeInput({ internalClaimId: "ic-happy" }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.status).toBe("SUBMITTED");
      expect(r.data.providerRef).toMatch(/^PMJAY-[0-9A-F]{12}$/);
      expect(r.data.claimId).toBe("ic-happy");
    }
  });

  it("is idempotent by internalClaimId (returns the stored status on replay)", async () => {
    const first = await pmjayAdapter.submitClaim(makeInput({ internalClaimId: "ic-idemp" }));
    if (!first.ok) throw new Error("submit failed");
    __pmjayInternals.forceStatus(first.data.providerRef, "APPROVED", { amountApproved: 4500 });
    const second = await pmjayAdapter.submitClaim(makeInput({ internalClaimId: "ic-idemp" }));
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.data.providerRef).toBe(first.data.providerRef);
      expect(second.data.status).toBe("APPROVED");
    }
  });
});

describe("pmjayAdapter.getClaimStatus / uploadDocument / cancelClaim (simulation)", () => {
  it("getClaimStatus returns NOT_FOUND for an unknown ref", async () => {
    const r = await pmjayAdapter.getClaimStatus("PMJAY-DEADBEEF0000");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("NOT_FOUND");
  });

  it("uploadDocument appends a PMJAY-DOC-<hex> id + timeline note", async () => {
    const s = await pmjayAdapter.submitClaim(makeInput({ internalClaimId: "ic-doc" }));
    if (!s.ok) throw new Error("submit failed");
    const r = await pmjayAdapter.uploadDocument(
      s.data.providerRef,
      "DISCHARGE_SUMMARY",
      Buffer.from("PDF"),
      "ds.pdf",
      "application/pdf"
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.providerDocId).toMatch(/^PMJAY-DOC-[0-9A-F]{10}$/);
  });

  it("uploadDocument rejects an empty buffer with INVALID_INPUT", async () => {
    const r = await pmjayAdapter.uploadDocument(
      "PMJAY-ANY",
      "BILL",
      Buffer.alloc(0),
      "e.pdf",
      "application/pdf"
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("INVALID_INPUT");
  });

  it("cancelClaim flips to CANCELLED, but refuses a SETTLED claim", async () => {
    const s = await pmjayAdapter.submitClaim(makeInput({ internalClaimId: "ic-cxl" }));
    if (!s.ok) throw new Error("submit failed");
    const ok = await pmjayAdapter.cancelClaim(s.data.providerRef, "duplicate");
    expect(ok.ok).toBe(true);

    const s2 = await pmjayAdapter.submitClaim(makeInput({ internalClaimId: "ic-settled" }));
    if (!s2.ok) throw new Error("submit failed");
    __pmjayInternals.forceStatus(s2.data.providerRef, "SETTLED", { amountApproved: 5000 });
    const bad = await pmjayAdapter.cancelClaim(s2.data.providerRef, "too late");
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.code).toBe("BUSINESS_RULE");
  });
});

describe("__internal.mapPmjayStatus", () => {
  const { mapPmjayStatus } = __internal;
  it.each<[string, NormalisedClaimStatus]>([
    ["INITIATED", "SUBMITTED"],
    ["RECEIVED", "SUBMITTED"],
    ["UNDER_PROCESS", "IN_REVIEW"],
    ["QUERY", "QUERY_RAISED"],
    ["ENQUIRY", "QUERY_RAISED"],
    ["APPROVED", "APPROVED"],
    ["PREAUTH_APPROVED", "APPROVED"],
    ["PART_APPROVED", "PARTIALLY_APPROVED"],
    ["REPUDIATED", "DENIED"],
    ["CLAIM_PAID", "SETTLED"],
    ["WITHDRAWN", "CANCELLED"],
  ])("maps PM-JAY raw %s → %s", (raw, expected) => {
    expect(mapPmjayStatus(raw)).toBe(expected);
  });

  it("falls back to IN_REVIEW for unknown / empty status", () => {
    expect(mapPmjayStatus("SOMETHING_ELSE")).toBe("IN_REVIEW");
    expect(mapPmjayStatus("")).toBe("IN_REVIEW");
  });

  it("is case-insensitive", () => {
    expect(mapPmjayStatus("settled")).toBe("SETTLED");
    expect(mapPmjayStatus("Approved")).toBe("APPROVED");
  });
});
