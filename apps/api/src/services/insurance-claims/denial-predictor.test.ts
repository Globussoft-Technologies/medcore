// Unit tests for the denial-risk predictor.
//
// The predictor is a deterministic rule engine plus an optional Sarvam-backed
// qualitative layer. We exercise the rule engine across every bucket and
// confirm the LLM layer is short-circuited when NODE_ENV === "test" (the
// integration smoke-test asserts the LLM path separately).

import { describe, it, expect, vi, beforeEach } from "vitest";

const { prismaMock, generateStructuredMock } = vi.hoisted(() => {
  const prismaMock = {
    invoice: {
      findUnique: vi.fn(),
    },
    aIScribeSession: {
      findUnique: vi.fn(),
    },
    insuranceClaim2: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
    },
  } as any;
  const generateStructuredMock = vi.fn();
  return { prismaMock, generateStructuredMock };
});

vi.mock("@medcore/db", () => ({ prisma: prismaMock }));
vi.mock("../ai/sarvam", () => ({
  generateStructured: generateStructuredMock,
}));

import { predictDenialRiskForClaim } from "./denial-predictor";
import type { InsuranceClaimRow } from "./store";

function makeClaim(overrides: Partial<InsuranceClaimRow> = {}): InsuranceClaimRow {
  return {
    id: "c1",
    billId: "inv-1",
    patientId: "p1",
    tpaProvider: "MOCK",
    providerClaimRef: null,
    insurerName: "Star Health",
    policyNumber: "POL-1",
    memberId: "M-1",
    preAuthRequestId: null,
    diagnosis: "Pneumonia",
    icd10Codes: ["J18.9"],
    procedureName: null,
    admissionDate: null,
    dischargeDate: null,
    amountClaimed: 10000,
    amountApproved: null,
    status: "SUBMITTED",
    deniedReason: null,
    notes: null,
    submittedAt: new Date().toISOString(),
    approvedAt: null,
    settledAt: null,
    cancelledAt: null,
    lastSyncedAt: null,
    createdBy: "u1",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  prismaMock.invoice.findUnique.mockReset();
  prismaMock.aIScribeSession.findUnique.mockReset();
  prismaMock.invoice.findUnique.mockResolvedValue({
    id: "inv-1",
    appointmentId: null,
    totalAmount: 10000,
  });
  prismaMock.aIScribeSession.findUnique.mockResolvedValue(null);
  generateStructuredMock.mockReset();
});

describe("predictDenialRiskForClaim — rule engine buckets", () => {
  it("rates a clean claim as low risk", async () => {
    const claim = makeClaim();
    const r = await predictDenialRiskForClaim(claim);
    expect(r.risk).toBe("low");
    expect(r.reasons).toEqual([]);
  });

  it("escalates to high when ICD missing AND scribe has codes available", async () => {
    prismaMock.invoice.findUnique.mockResolvedValue({
      id: "inv-1",
      appointmentId: "appt-1",
      totalAmount: 10000,
    });
    prismaMock.aIScribeSession.findUnique.mockResolvedValue({
      icd10Codes: ["J18.9", "B34.9"],
    });
    const claim = makeClaim({ icd10Codes: [] });
    const r = await predictDenialRiskForClaim(claim);
    expect(r.risk).toBe("high");
    expect(r.fixOps.some((op) => op.type === "ADD_ICD_FROM_SOAP")).toBe(true);
    // Auto-fix should propose the actual scribe codes.
    const op = r.fixOps.find((o) => o.type === "ADD_ICD_FROM_SOAP");
    if (op?.type === "ADD_ICD_FROM_SOAP") {
      expect(op.codes).toEqual(["J18.9", "B34.9"]);
    }
  });

  it("rates ICD missing without scribe codes as medium", async () => {
    const claim = makeClaim({ icd10Codes: [] });
    const r = await predictDenialRiskForClaim(claim);
    expect(r.risk).toBe("medium");
    expect(r.reasons.some((reason) => /No ICD-10/.test(reason))).toBe(true);
  });

  it("flags malformed ICD-10 codes at medium with a clear reason", async () => {
    const claim = makeClaim({ icd10Codes: ["NOT_AN_ICD"] });
    const r = await predictDenialRiskForClaim(claim);
    expect(r.risk).toBe("medium");
    expect(r.reasons.some((reason) => /format check/i.test(reason))).toBe(true);
  });

  it("emits a ROUND_AMOUNT_TO_INR fixOp for amounts with > 2 decimals", async () => {
    const claim = makeClaim({ amountClaimed: 1234.567 });
    const r = await predictDenialRiskForClaim(claim);
    const op = r.fixOps.find((o) => o.type === "ROUND_AMOUNT_TO_INR");
    expect(op).toBeDefined();
    if (op?.type === "ROUND_AMOUNT_TO_INR") {
      expect(op.from).toBeCloseTo(1234.567);
      expect(op.to).toBeCloseTo(1234.57);
    }
    expect(r.risk).toBe("medium");
  });

  it("escalates to high when amountClaimed exceeds 3x invoice total", async () => {
    prismaMock.invoice.findUnique.mockResolvedValue({
      id: "inv-1",
      appointmentId: null,
      totalAmount: 1000,
    });
    const claim = makeClaim({ amountClaimed: 5000 });
    const r = await predictDenialRiskForClaim(claim);
    expect(r.risk).toBe("high");
    expect(r.reasons.some((reason) => /3x the invoice total/i.test(reason))).toBe(true);
  });

  it("flags moderate amount overage (1.25x) as medium", async () => {
    prismaMock.invoice.findUnique.mockResolvedValue({
      id: "inv-1",
      appointmentId: null,
      totalAmount: 1000,
    });
    const claim = makeClaim({ amountClaimed: 1500 });
    const r = await predictDenialRiskForClaim(claim);
    expect(r.risk).toBe("medium");
  });

  it("flags Medi Assist policyNumber whitespace at medium", async () => {
    const claim = makeClaim({
      tpaProvider: "MEDI_ASSIST",
      policyNumber: "POL 123",
    });
    const r = await predictDenialRiskForClaim(claim);
    expect(r.risk).toBe("medium");
    expect(r.reasons.some((reason) => /whitespace/i.test(reason))).toBe(true);
  });

  it("flags Paramount missing memberId at medium", async () => {
    const claim = makeClaim({ tpaProvider: "PARAMOUNT", memberId: null });
    const r = await predictDenialRiskForClaim(claim);
    expect(r.risk).toBe("medium");
    expect(r.reasons.some((reason) => /memberId/i.test(reason))).toBe(true);
  });

  it("escalates to high when diagnosis is empty", async () => {
    const claim = makeClaim({ diagnosis: "  " });
    const r = await predictDenialRiskForClaim(claim);
    expect(r.risk).toBe("high");
    expect(r.reasons.some((reason) => /Diagnosis field is empty/i.test(reason))).toBe(true);
  });

  it("emits a TRIM_DIAGNOSIS_WHITESPACE fixOp when diagnosis has leading/trailing spaces", async () => {
    const claim = makeClaim({ diagnosis: " Fever " });
    const r = await predictDenialRiskForClaim(claim);
    expect(r.fixOps.some((op) => op.type === "TRIM_DIAGNOSIS_WHITESPACE")).toBe(true);
  });

  it("flags diagnosis/procedure mismatch at medium", async () => {
    const claim = makeClaim({
      diagnosis: "Appendicitis acute",
      procedureName: "Coronary bypass surgery",
    });
    const r = await predictDenialRiskForClaim(claim);
    expect(r.risk).toBe("medium");
    expect(r.reasons.some((reason) => /shares no keywords/i.test(reason))).toBe(true);
  });
});

describe("predictDenialRiskForClaim — LLM gating", () => {
  it("skips the Sarvam call entirely when skipLlm is set", async () => {
    const claim = makeClaim();
    await predictDenialRiskForClaim(claim, { skipLlm: true });
    expect(generateStructuredMock).not.toHaveBeenCalled();
  });

  it("skips the Sarvam call when NODE_ENV === 'test' (default in CI)", async () => {
    // setup-env.ts already sets NODE_ENV=test for the suite
    expect(process.env.NODE_ENV).toBe("test");
    const claim = makeClaim();
    await predictDenialRiskForClaim(claim);
    expect(generateStructuredMock).not.toHaveBeenCalled();
  });
});
