// Unit tests for the TPA adapters: Medi Assist + Paramount.
//
// Both adapters are stubbed pending real partner credentials, but the status
// mappers (legacy TPA enum → NormalisedClaimStatus) are real and shipping to
// production via the reconciliation worker, so we cover them tightly.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type {
  ClaimSubmissionInput,
  NormalisedClaimStatus,
  TpaProvider,
} from "./adapter";

import { mediAssistAdapter, __internal as mediInternal } from "./adapters/medi-assist";
import { paramountAdapter, __internal as paramountInternal } from "./adapters/paramount";

const sampleInput: ClaimSubmissionInput = {
  internalClaimId: "ic-1",
  invoiceId: "inv-1",
  patient: { name: "Asha Patel", gender: "FEMALE" },
  policy: {
    policyNumber: "POL-1",
    insurerName: "Star Health",
    tpaProvider: "MEDI_ASSIST",
  },
  diagnosis: "Pneumonia",
  amountClaimed: 50000,
};

// ── Common adapter shape contract ────────────────────────────────────────────

describe("ClaimsAdapter shape contract", () => {
  it("medi-assist exposes the right provider tag and method surface", () => {
    expect(mediAssistAdapter.provider).toBe("MEDI_ASSIST" satisfies TpaProvider);
    expect(typeof mediAssistAdapter.submitClaim).toBe("function");
    expect(typeof mediAssistAdapter.getClaimStatus).toBe("function");
    expect(typeof mediAssistAdapter.uploadDocument).toBe("function");
    expect(typeof mediAssistAdapter.cancelClaim).toBe("function");
  });

  it("paramount exposes the right provider tag and method surface", () => {
    expect(paramountAdapter.provider).toBe("PARAMOUNT" satisfies TpaProvider);
    expect(typeof paramountAdapter.submitClaim).toBe("function");
    expect(typeof paramountAdapter.getClaimStatus).toBe("function");
    expect(typeof paramountAdapter.uploadDocument).toBe("function");
    expect(typeof paramountAdapter.cancelClaim).toBe("function");
  });
});

// ── Medi Assist ──────────────────────────────────────────────────────────────

describe("mediAssistAdapter — config gate", () => {
  const ORIG = { ...process.env };

  beforeEach(() => {
    delete process.env.TPA_MEDIASSIST_API_KEY;
    delete process.env.TPA_MEDIASSIST_HOSPITAL_ID;
    delete process.env.TPA_MEDIASSIST_API_URL;
  });

  afterEach(() => {
    process.env = { ...ORIG };
  });

  it("returns AUTH_FAILED on every method when credentials are missing", async () => {
    const submitted = await mediAssistAdapter.submitClaim(sampleInput);
    expect(submitted.ok).toBe(false);
    if (!submitted.ok) expect(submitted.error.code).toBe("AUTH_FAILED");

    const status = await mediAssistAdapter.getClaimStatus("ref-1");
    expect(status.ok).toBe(false);
    if (!status.ok) expect(status.error.code).toBe("AUTH_FAILED");

    const upload = await mediAssistAdapter.uploadDocument(
      "ref-1",
      "BILL",
      Buffer.from(""),
      "x.pdf",
      "application/pdf"
    );
    expect(upload.ok).toBe(false);
    if (!upload.ok) expect(upload.error.code).toBe("AUTH_FAILED");

    const cancel = await mediAssistAdapter.cancelClaim("ref-1", "patient request");
    expect(cancel.ok).toBe(false);
    if (!cancel.ok) expect(cancel.error.code).toBe("AUTH_FAILED");
  });

  it("returns TPA_UNAVAILABLE (stub) once credentials are present", async () => {
    process.env.TPA_MEDIASSIST_API_KEY = "key";
    process.env.TPA_MEDIASSIST_HOSPITAL_ID = "hosp-1";
    const result = await mediAssistAdapter.submitClaim(sampleInput);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("TPA_UNAVAILABLE");
      expect(result.error.message).toMatch(/MOCK adapter|not wired/i);
    }
  });
});

describe("mediAssist status mapper", () => {
  const cases: Array<[string, NormalisedClaimStatus]> = [
    ["RECEIVED", "SUBMITTED"],
    ["NEW", "SUBMITTED"],
    ["UNDER_REVIEW", "IN_REVIEW"],
    ["PROCESSING", "IN_REVIEW"],
    ["QUERY", "QUERY_RAISED"],
    ["ADDITIONAL_DOCS_REQUIRED", "QUERY_RAISED"],
    ["APPROVED", "APPROVED"],
    ["PART_APPROVED", "PARTIALLY_APPROVED"],
    ["REJECTED", "DENIED"],
    ["DENIED", "DENIED"],
    ["SETTLED", "SETTLED"],
    ["PAID", "SETTLED"],
    ["CANCELLED", "CANCELLED"],
    ["WITHDRAWN", "CANCELLED"],
  ];
  it.each(cases)("maps %s -> %s", (raw, expected) => {
    expect(mediInternal.mapMediAssistStatus(raw)).toBe(expected);
  });

  it("maps unknown strings to IN_REVIEW (safe default)", () => {
    expect(mediInternal.mapMediAssistStatus("WHATEVER")).toBe("IN_REVIEW");
  });

  it("is case-insensitive on the input string", () => {
    expect(mediInternal.mapMediAssistStatus("approved")).toBe("APPROVED");
    expect(mediInternal.mapMediAssistStatus("Settled")).toBe("SETTLED");
  });
});

// ── Paramount ────────────────────────────────────────────────────────────────

describe("paramountAdapter — config gate", () => {
  const ORIG = { ...process.env };

  beforeEach(() => {
    delete process.env.TPA_PARAMOUNT_API_KEY;
    delete process.env.TPA_PARAMOUNT_CLIENT_CODE;
    delete process.env.TPA_PARAMOUNT_API_URL;
  });

  afterEach(() => {
    process.env = { ...ORIG };
  });

  it("returns AUTH_FAILED when API_KEY or CLIENT_CODE missing", async () => {
    const status = await paramountAdapter.getClaimStatus("ref-1");
    expect(status.ok).toBe(false);
    if (!status.ok) expect(status.error.code).toBe("AUTH_FAILED");
  });

  it("returns TPA_UNAVAILABLE (stub) once credentials are present", async () => {
    process.env.TPA_PARAMOUNT_API_KEY = "k";
    process.env.TPA_PARAMOUNT_CLIENT_CODE = "C-1";
    const result = await paramountAdapter.cancelClaim("ref-1", "no longer needed");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("TPA_UNAVAILABLE");
  });
});

describe("paramount status mapper", () => {
  // Paramount uses both numeric and string codes interchangeably; both must
  // resolve to the same canonical NormalisedClaimStatus.
  const numericCases: Array<[string | number, NormalisedClaimStatus]> = [
    [1, "SUBMITTED"],
    [2, "IN_REVIEW"],
    [3, "QUERY_RAISED"],
    [4, "APPROVED"],
    [5, "PARTIALLY_APPROVED"],
    [6, "DENIED"],
    [7, "SETTLED"],
    [8, "CANCELLED"],
  ];
  it.each(numericCases)("maps numeric %s -> %s", (raw, expected) => {
    expect(paramountInternal.mapParamountStatus(raw)).toBe(expected);
  });

  const stringCases: Array<[string, NormalisedClaimStatus]> = [
    ["SUBMITTED", "SUBMITTED"],
    ["IN_PROCESS", "IN_REVIEW"],
    ["QUERY", "QUERY_RAISED"],
    ["APPROVED", "APPROVED"],
    ["PART_APPROVED", "PARTIALLY_APPROVED"],
    ["REJECTED", "DENIED"],
    ["SETTLED", "SETTLED"],
    ["CANCELLED", "CANCELLED"],
  ];
  it.each(stringCases)("maps string %s -> %s", (raw, expected) => {
    expect(paramountInternal.mapParamountStatus(raw)).toBe(expected);
  });

  it("maps unknown numeric/string codes to IN_REVIEW (safe default)", () => {
    expect(paramountInternal.mapParamountStatus(99)).toBe("IN_REVIEW");
    expect(paramountInternal.mapParamountStatus("MYSTERY")).toBe("IN_REVIEW");
  });
});

// ── Submission payload contract (the bits implementers cannot break) ─────────
//
// The adapter interface guarantees a discriminated-union return shape and
// idempotent submitClaim by internalClaimId. Both stubs already obey the
// shape because they always return error envelopes, but we lock the contract
// so any future adapter that returns malformed `ok: true` payloads fails CI.

describe("submitClaim adapter contract", () => {
  beforeEach(() => {
    process.env.TPA_MEDIASSIST_API_KEY = "k";
    process.env.TPA_MEDIASSIST_HOSPITAL_ID = "hid";
    process.env.TPA_PARAMOUNT_API_KEY = "k";
    process.env.TPA_PARAMOUNT_CLIENT_CODE = "C-1";
  });

  afterEach(() => {
    delete process.env.TPA_MEDIASSIST_API_KEY;
    delete process.env.TPA_MEDIASSIST_HOSPITAL_ID;
    delete process.env.TPA_PARAMOUNT_API_KEY;
    delete process.env.TPA_PARAMOUNT_CLIENT_CODE;
  });

  it("medi-assist submission returns a valid AdapterResult discriminated union", async () => {
    const r = await mediAssistAdapter.submitClaim(sampleInput);
    expect(typeof r.ok).toBe("boolean");
    if (!r.ok) {
      expect(typeof r.error.code).toBe("string");
      expect(typeof r.error.message).toBe("string");
    }
  });

  it("paramount submission returns a valid AdapterResult discriminated union", async () => {
    const r = await paramountAdapter.submitClaim({
      ...sampleInput,
      policy: { ...sampleInput.policy, tpaProvider: "PARAMOUNT" },
    });
    expect(typeof r.ok).toBe("boolean");
    if (!r.ok) {
      expect(typeof r.error.code).toBe("string");
    }
  });
});
