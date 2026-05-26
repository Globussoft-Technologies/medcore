/**
 * Test-cron tick (2026-05-25) — AI claim-coder unit tests.
 *
 * What / which modules / why
 * ──────────────────────────
 * - WHAT: regression around `draftClaimFromConsultation` (the AI Scribe →
 *   InsuranceClaim2 draft bridge) and `listPendingDrafts` (the review-queue
 *   filter). Pins the warning-emission contract (missing ICD codes, no
 *   recognisable TPA, no policy number, no insurer name, zero invoice total,
 *   placeholder diagnosis), the impression-extraction fallback ladder
 *   (soapFinal → soapDraft → notes Assessment:/Diagnosis: → placeholder),
 *   the `inferTpaProvider` brand-alias mapping, the `extractIcdCodes`
 *   tolerant-shape parser, the missing-linkage error paths, and the
 *   `listPendingDrafts` ISO-stringification round-trip.
 * - MODULES: hoisted mock of `@medcore/db` (no real Postgres) and a hoisted
 *   mock of `./store#createClaim` so we can spy on the row shape passed in
 *   and pin the AI_CODER / opts.createdBy fallback. We assert against the
 *   `createClaim` call arguments rather than the returned row because the
 *   draftClaim contract is "what gets persisted", not "what comes back".
 * - WHY: the AI coder is the entry point reception relies on to skip
 *   re-keying. Wrong defaults (TPA, status marker, policy fallback) =
 *   silent garbage rows in the pending-drafts queue. Threshold drift on
 *   the warnings list = reviewers miss the "needs manual attention" cues.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { prismaMock, createClaimMock } = vi.hoisted(() => ({
  prismaMock: {
    consultation: { findUnique: vi.fn() },
    aIScribeSession: { findUnique: vi.fn() },
    insuranceClaim2: { findMany: vi.fn() },
  } as any,
  createClaimMock: vi.fn(),
}));

vi.mock("@medcore/db", () => ({
  prisma: prismaMock,
  tenantScopedPrisma: prismaMock,
  getTenantId: () => undefined,
  runWithTenant: (_t: string, fn: () => unknown) => fn(),
  requireTenantId: () => {
    throw new Error("tenant ctx required");
  },
}));

vi.mock("./store", () => ({
  createClaim: createClaimMock,
}));

import {
  draftClaimFromConsultation,
  listPendingDrafts,
  DRAFT_STATUS,
  DRAFT_MARKER,
} from "./ai-coder";

// ─── Fixtures ─────────────────────────────────────────────────────────────

function makeConsultation(over: any = {}): any {
  return {
    id: over.id ?? "cons-1",
    notes: over.notes ?? null,
    appointment: over.appointment ?? {
      id: "appt-1",
      patient: {
        id: "pat-1",
        insuranceProvider: "Star Health",
        insurancePolicyNumber: "POL-001",
      },
      invoice: { id: "inv-1", totalAmount: 5000 },
    },
  };
}

function resetAll() {
  prismaMock.consultation.findUnique.mockReset();
  prismaMock.aIScribeSession.findUnique.mockReset();
  prismaMock.insuranceClaim2.findMany.mockReset();
  createClaimMock.mockReset();
  // Default: createClaim echoes back a stub row so callers can read .claim.
  createClaimMock.mockImplementation(async (row: any) => ({
    ...row,
    id: "claim-new",
    createdAt: new Date("2026-05-25T00:00:00Z").toISOString(),
    updatedAt: new Date("2026-05-25T00:00:00Z").toISOString(),
  }));
  prismaMock.aIScribeSession.findUnique.mockResolvedValue(null);
}

// ─── draftClaimFromConsultation — error paths ─────────────────────────────

describe("draftClaimFromConsultation — missing-linkage errors", () => {
  beforeEach(resetAll);

  it("throws when the consultation is not found", async () => {
    prismaMock.consultation.findUnique.mockResolvedValue(null);
    await expect(draftClaimFromConsultation("missing")).rejects.toThrow(
      /Consultation not found/,
    );
    expect(createClaimMock).not.toHaveBeenCalled();
  });

  it("throws when the consultation has no linked appointment", async () => {
    prismaMock.consultation.findUnique.mockResolvedValue({
      id: "cons-1",
      notes: null,
      appointment: null,
    });
    await expect(draftClaimFromConsultation("cons-1")).rejects.toThrow(
      /no appointment linkage/,
    );
  });

  it("throws when the appointment has no invoice attached", async () => {
    prismaMock.consultation.findUnique.mockResolvedValue({
      id: "cons-1",
      notes: null,
      appointment: {
        id: "appt-1",
        patient: { id: "pat-1", insuranceProvider: "Star Health", insurancePolicyNumber: "POL-1" },
        invoice: null,
      },
    });
    await expect(draftClaimFromConsultation("cons-1")).rejects.toThrow(
      /no invoice/,
    );
  });
});

// ─── draftClaimFromConsultation — happy paths + warnings ─────────────────

describe("draftClaimFromConsultation — happy paths and warnings", () => {
  beforeEach(resetAll);

  it("drafts a clean claim with no warnings when SOAP, codes, TPA and bill are present", async () => {
    prismaMock.consultation.findUnique.mockResolvedValue(makeConsultation());
    prismaMock.aIScribeSession.findUnique.mockResolvedValue({
      icd10Codes: [{ code: "J18.9", description: "Pneumonia, unspecified" }],
      soapFinal: { assessment: { impression: "Community-acquired pneumonia" } },
      soapDraft: null,
    });

    const { claim, warnings } = await draftClaimFromConsultation("cons-1", {
      createdBy: "user-recep",
    });

    expect(warnings).toEqual([]);
    expect(createClaimMock).toHaveBeenCalledTimes(1);
    const row = createClaimMock.mock.calls[0][0];
    expect(row.diagnosis).toBe("Community-acquired pneumonia");
    expect(row.icd10Codes).toEqual(["J18.9"]);
    expect(row.tpaProvider).toBe("STAR_HEALTH");
    expect(row.insurerName).toBe("Star Health");
    expect(row.policyNumber).toBe("POL-001");
    expect(row.amountClaimed).toBe(5000);
    expect(row.status).toBe(DRAFT_STATUS);
    expect(row.notes).toContain(DRAFT_MARKER);
    expect(row.notes).toContain("consultationId=cons-1");
    expect(row.createdBy).toBe("user-recep");
    expect(claim.id).toBe("claim-new");
  });

  it("defaults createdBy to 'AI_CODER' when opts.createdBy is omitted", async () => {
    prismaMock.consultation.findUnique.mockResolvedValue(makeConsultation());
    prismaMock.aIScribeSession.findUnique.mockResolvedValue({
      icd10Codes: ["J18.9"],
      soapFinal: { assessment: { impression: "Pneumonia" } },
    });

    await draftClaimFromConsultation("cons-1");

    expect(createClaimMock.mock.calls[0][0].createdBy).toBe("AI_CODER");
  });

  it("warns when no ICD codes are present (no scribe session at all)", async () => {
    prismaMock.consultation.findUnique.mockResolvedValue(
      makeConsultation({ notes: "Assessment: Hypertension" }),
    );
    prismaMock.aIScribeSession.findUnique.mockResolvedValue(null);

    const { warnings } = await draftClaimFromConsultation("cons-1");

    expect(warnings.some((w) => /No ICD-10 codes/.test(w))).toBe(true);
    expect(createClaimMock.mock.calls[0][0].icd10Codes).toEqual([]);
    expect(createClaimMock.mock.calls[0][0].diagnosis).toBe("Hypertension");
  });

  it("falls back to soapDraft.assessment.impression when soapFinal has none", async () => {
    prismaMock.consultation.findUnique.mockResolvedValue(makeConsultation());
    prismaMock.aIScribeSession.findUnique.mockResolvedValue({
      icd10Codes: ["E11.9"],
      soapFinal: null,
      soapDraft: { assessment: { impression: "Type 2 diabetes" } },
    });

    const { warnings } = await draftClaimFromConsultation("cons-1");

    expect(createClaimMock.mock.calls[0][0].diagnosis).toBe("Type 2 diabetes");
    expect(warnings.some((w) => /No assessment impression/.test(w))).toBe(false);
  });

  it("falls back to consultation.notes 'Assessment:' regex when no SOAP impression", async () => {
    prismaMock.consultation.findUnique.mockResolvedValue(
      makeConsultation({
        notes: "S: cough\nO: ronchi\nAssessment: Acute bronchitis\nPlan: ...",
      }),
    );
    prismaMock.aIScribeSession.findUnique.mockResolvedValue({
      icd10Codes: ["J20"],
      soapFinal: { assessment: {} },
      soapDraft: null,
    });

    await draftClaimFromConsultation("cons-1");

    expect(createClaimMock.mock.calls[0][0].diagnosis).toBe("Acute bronchitis");
  });

  it("falls back to 'Diagnosis:' marker in notes when Assessment: is absent", async () => {
    prismaMock.consultation.findUnique.mockResolvedValue(
      makeConsultation({
        notes: "Patient reports fever.\nDiagnosis: Viral fever\nRx as below.",
      }),
    );
    prismaMock.aIScribeSession.findUnique.mockResolvedValue({
      icd10Codes: ["A99"],
      soapFinal: null,
      soapDraft: null,
    });

    await draftClaimFromConsultation("cons-1");

    expect(createClaimMock.mock.calls[0][0].diagnosis).toBe("Viral fever");
  });

  it("uses the placeholder diagnosis (and warns) when no impression source exists", async () => {
    prismaMock.consultation.findUnique.mockResolvedValue(
      makeConsultation({ notes: null }),
    );
    prismaMock.aIScribeSession.findUnique.mockResolvedValue({
      icd10Codes: ["R69"],
      soapFinal: null,
      soapDraft: null,
    });

    const { warnings } = await draftClaimFromConsultation("cons-1");

    expect(createClaimMock.mock.calls[0][0].diagnosis).toMatch(
      /^Diagnosis pending/,
    );
    expect(warnings.some((w) => /No assessment impression/.test(w))).toBe(true);
  });

  it("warns and defaults TPA to MOCK when insuranceProvider is unrecognised", async () => {
    prismaMock.consultation.findUnique.mockResolvedValue(
      makeConsultation({
        appointment: {
          id: "appt-1",
          patient: {
            id: "pat-1",
            insuranceProvider: "Some Random Insurer Co.",
            insurancePolicyNumber: "POL-1",
          },
          invoice: { id: "inv-1", totalAmount: 5000 },
        },
      }),
    );
    prismaMock.aIScribeSession.findUnique.mockResolvedValue({
      icd10Codes: ["J18.9"],
      soapFinal: { assessment: { impression: "Pneumonia" } },
    });

    const { warnings } = await draftClaimFromConsultation("cons-1");

    expect(createClaimMock.mock.calls[0][0].tpaProvider).toBe("MOCK");
    expect(warnings.some((w) => /no recognised TPA/.test(w))).toBe(true);
  });

  it("warns when patient has no policyNumber and defaults to 'UNKNOWN'", async () => {
    prismaMock.consultation.findUnique.mockResolvedValue(
      makeConsultation({
        appointment: {
          id: "appt-1",
          patient: {
            id: "pat-1",
            insuranceProvider: "Star Health",
            insurancePolicyNumber: null,
          },
          invoice: { id: "inv-1", totalAmount: 5000 },
        },
      }),
    );
    prismaMock.aIScribeSession.findUnique.mockResolvedValue({
      icd10Codes: ["J18.9"],
      soapFinal: { assessment: { impression: "Pneumonia" } },
    });

    const { warnings } = await draftClaimFromConsultation("cons-1");

    expect(createClaimMock.mock.calls[0][0].policyNumber).toBe("UNKNOWN");
    expect(warnings.some((w) => /no policyNumber/.test(w))).toBe(true);
  });

  it("warns and defaults insurerName to 'Unknown Insurer' when insuranceProvider is null", async () => {
    prismaMock.consultation.findUnique.mockResolvedValue(
      makeConsultation({
        appointment: {
          id: "appt-1",
          patient: {
            id: "pat-1",
            insuranceProvider: null,
            insurancePolicyNumber: "POL-1",
          },
          invoice: { id: "inv-1", totalAmount: 5000 },
        },
      }),
    );
    prismaMock.aIScribeSession.findUnique.mockResolvedValue({
      icd10Codes: ["J18.9"],
      soapFinal: { assessment: { impression: "Pneumonia" } },
    });

    const { warnings } = await draftClaimFromConsultation("cons-1");

    expect(createClaimMock.mock.calls[0][0].insurerName).toBe("Unknown Insurer");
    expect(warnings.some((w) => /no insurerName/.test(w))).toBe(true);
  });

  it("warns when invoice total is zero", async () => {
    prismaMock.consultation.findUnique.mockResolvedValue(
      makeConsultation({
        appointment: {
          id: "appt-1",
          patient: {
            id: "pat-1",
            insuranceProvider: "Star Health",
            insurancePolicyNumber: "POL-1",
          },
          invoice: { id: "inv-1", totalAmount: 0 },
        },
      }),
    );
    prismaMock.aIScribeSession.findUnique.mockResolvedValue({
      icd10Codes: ["J18.9"],
      soapFinal: { assessment: { impression: "Pneumonia" } },
    });

    const { warnings } = await draftClaimFromConsultation("cons-1");

    expect(createClaimMock.mock.calls[0][0].amountClaimed).toBe(0);
    expect(warnings.some((w) => /Invoice total is zero/.test(w))).toBe(true);
  });

  it("coerces an invoice totalAmount of null to 0 and emits the zero-warning", async () => {
    prismaMock.consultation.findUnique.mockResolvedValue(
      makeConsultation({
        appointment: {
          id: "appt-1",
          patient: {
            id: "pat-1",
            insuranceProvider: "Star Health",
            insurancePolicyNumber: "POL-1",
          },
          invoice: { id: "inv-1", totalAmount: null },
        },
      }),
    );
    prismaMock.aIScribeSession.findUnique.mockResolvedValue({
      icd10Codes: ["J18.9"],
      soapFinal: { assessment: { impression: "Pneumonia" } },
    });

    const { warnings } = await draftClaimFromConsultation("cons-1");

    expect(createClaimMock.mock.calls[0][0].amountClaimed).toBe(0);
    expect(warnings.some((w) => /Invoice total is zero/.test(w))).toBe(true);
  });
});

// ─── extractIcdCodes (exercised via draftClaim) ───────────────────────────

describe("draftClaimFromConsultation — ICD-code shape tolerance", () => {
  beforeEach(resetAll);

  it("accepts an array of plain string codes", async () => {
    prismaMock.consultation.findUnique.mockResolvedValue(makeConsultation());
    prismaMock.aIScribeSession.findUnique.mockResolvedValue({
      icd10Codes: ["J18.9", "  E11.9  ", ""],
      soapFinal: { assessment: { impression: "Multi-dx" } },
    });

    await draftClaimFromConsultation("cons-1");

    expect(createClaimMock.mock.calls[0][0].icd10Codes).toEqual(["J18.9", "E11.9"]);
  });

  it("accepts an array of {code, description} objects and trims codes", async () => {
    prismaMock.consultation.findUnique.mockResolvedValue(makeConsultation());
    prismaMock.aIScribeSession.findUnique.mockResolvedValue({
      icd10Codes: [
        { code: " J18.9 ", description: "Pneumonia" },
        { code: "E11.9", description: "T2DM" },
      ],
      soapFinal: { assessment: { impression: "Multi-dx" } },
    });

    await draftClaimFromConsultation("cons-1");

    expect(createClaimMock.mock.calls[0][0].icd10Codes).toEqual(["J18.9", "E11.9"]);
  });

  it("returns [] when icd10Codes is not an array", async () => {
    prismaMock.consultation.findUnique.mockResolvedValue(makeConsultation());
    prismaMock.aIScribeSession.findUnique.mockResolvedValue({
      icd10Codes: { not: "an array" },
      soapFinal: { assessment: { impression: "Dx" } },
    });

    const { warnings } = await draftClaimFromConsultation("cons-1");

    expect(createClaimMock.mock.calls[0][0].icd10Codes).toEqual([]);
    expect(warnings.some((w) => /No ICD-10 codes/.test(w))).toBe(true);
  });

  it("returns [] when icd10Codes is null", async () => {
    prismaMock.consultation.findUnique.mockResolvedValue(makeConsultation());
    prismaMock.aIScribeSession.findUnique.mockResolvedValue({
      icd10Codes: null,
      soapFinal: { assessment: { impression: "Dx" } },
    });

    await draftClaimFromConsultation("cons-1");

    expect(createClaimMock.mock.calls[0][0].icd10Codes).toEqual([]);
  });

  it("skips entries that are neither string nor {code}-shaped object", async () => {
    prismaMock.consultation.findUnique.mockResolvedValue(makeConsultation());
    prismaMock.aIScribeSession.findUnique.mockResolvedValue({
      icd10Codes: [42, true, null, { description: "no code field" }, "J45"],
      soapFinal: { assessment: { impression: "Dx" } },
    });

    await draftClaimFromConsultation("cons-1");

    expect(createClaimMock.mock.calls[0][0].icd10Codes).toEqual(["J45"]);
  });
});

// ─── inferTpaProvider — every brand-alias branch ──────────────────────────

describe("draftClaimFromConsultation — TPA inference branches", () => {
  beforeEach(resetAll);

  async function runWith(insuranceProvider: string | null) {
    prismaMock.consultation.findUnique.mockResolvedValue(
      makeConsultation({
        appointment: {
          id: "appt-1",
          patient: {
            id: "pat-1",
            insuranceProvider,
            insurancePolicyNumber: "POL-1",
          },
          invoice: { id: "inv-1", totalAmount: 1000 },
        },
      }),
    );
    prismaMock.aIScribeSession.findUnique.mockResolvedValue({
      icd10Codes: ["J18.9"],
      soapFinal: { assessment: { impression: "Dx" } },
    });
    await draftClaimFromConsultation("cons-1");
    return createClaimMock.mock.calls[0][0].tpaProvider;
  }

  it("matches MEDI_ASSIST directly", async () => {
    expect(await runWith("MEDI_ASSIST")).toBe("MEDI_ASSIST");
  });

  it("matches PARAMOUNT brand alias", async () => {
    expect(await runWith("Paramount Health Services")).toBe("PARAMOUNT");
  });

  it("matches VIDAL brand alias", async () => {
    expect(await runWith("Vidal Healthcare")).toBe("VIDAL");
  });

  it("matches FHPL brand alias", async () => {
    expect(await runWith("Family Health Plan Limited (FHPL)")).toBe("FHPL");
  });

  it("matches ICICI_LOMBARD via the ICICI alias", async () => {
    expect(await runWith("ICICI Lombard General Insurance")).toBe("ICICI_LOMBARD");
  });

  it("matches STAR_HEALTH via the STAR alias", async () => {
    expect(await runWith("Star Health Insurance")).toBe("STAR_HEALTH");
  });

  it("matches the MEDI + ASSIST split alias", async () => {
    expect(await runWith("Medi-Assist India Pvt Ltd")).toBe("MEDI_ASSIST");
  });

  it("matches MOCK directly", async () => {
    expect(await runWith("MOCK")).toBe("MOCK");
  });

  it("returns null (defaults caller to MOCK) on completely unknown provider", async () => {
    expect(await runWith("Acme Insurance Co.")).toBe("MOCK");
  });
});

// ─── listPendingDrafts ────────────────────────────────────────────────────

describe("listPendingDrafts", () => {
  beforeEach(resetAll);

  it("queries InsuranceClaim2 with the DRAFT_STATUS + [AI DRAFT] marker", async () => {
    prismaMock.insuranceClaim2.findMany.mockResolvedValue([]);

    await listPendingDrafts();

    expect(prismaMock.insuranceClaim2.findMany).toHaveBeenCalledTimes(1);
    const args = prismaMock.insuranceClaim2.findMany.mock.calls[0][0];
    expect(args.where.status).toBe(DRAFT_STATUS);
    expect(args.where.notes).toEqual({ contains: "[AI DRAFT]" });
    expect(args.orderBy).toEqual({ createdAt: "desc" });
  });

  it("maps Prisma rows into ISO-stringified InsuranceClaimRow shape", async () => {
    const created = new Date("2026-05-20T10:00:00Z");
    const updated = new Date("2026-05-21T10:00:00Z");
    const submitted = new Date("2026-05-20T11:00:00Z");
    const approved = new Date("2026-05-22T10:00:00Z");
    prismaMock.insuranceClaim2.findMany.mockResolvedValue([
      {
        id: "claim-1",
        billId: "inv-1",
        patientId: "pat-1",
        tpaProvider: "STAR_HEALTH",
        providerClaimRef: "REF-A",
        insurerName: "Star Health",
        policyNumber: "POL-1",
        memberId: "M-1",
        preAuthRequestId: null,
        diagnosis: "Pneumonia",
        icd10Codes: ["J18.9", 42, null, "E11.9"],
        procedureName: "Chest XR",
        admissionDate: new Date("2026-05-18T00:00:00Z"),
        dischargeDate: new Date("2026-05-19T00:00:00Z"),
        amountClaimed: { toString: () => "5000" }, // Number() coerces
        amountApproved: 4500,
        status: "SUBMITTED",
        deniedReason: null,
        notes: "[AI DRAFT] Needs review",
        submittedAt: submitted,
        approvedAt: approved,
        settledAt: null,
        cancelledAt: null,
        lastSyncedAt: null,
        createdBy: "AI_CODER",
        createdAt: created,
        updatedAt: updated,
      },
    ]);

    const rows = await listPendingDrafts();

    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r.id).toBe("claim-1");
    expect(r.tpaProvider).toBe("STAR_HEALTH");
    expect(r.icd10Codes).toEqual(["J18.9", "E11.9"]); // non-strings filtered
    expect(r.amountClaimed).toBe(5000);
    expect(r.amountApproved).toBe(4500);
    expect(r.submittedAt).toBe(submitted.toISOString());
    expect(r.approvedAt).toBe(approved.toISOString());
    expect(r.settledAt).toBeNull();
    expect(r.admissionDate).toBe("2026-05-18T00:00:00.000Z");
    expect(r.dischargeDate).toBe("2026-05-19T00:00:00.000Z");
    expect(r.createdAt).toBe(created.toISOString());
    expect(r.updatedAt).toBe(updated.toISOString());
  });

  it("falls back to 'now' when submittedAt is missing", async () => {
    const before = Date.now();
    prismaMock.insuranceClaim2.findMany.mockResolvedValue([
      {
        id: "claim-2",
        billId: "inv-2",
        patientId: "pat-2",
        tpaProvider: "MOCK",
        providerClaimRef: null,
        insurerName: "X",
        policyNumber: "P",
        memberId: null,
        preAuthRequestId: null,
        diagnosis: "Dx",
        icd10Codes: [],
        procedureName: null,
        admissionDate: null,
        dischargeDate: null,
        amountClaimed: 100,
        amountApproved: null,
        status: "SUBMITTED",
        deniedReason: null,
        notes: "[AI DRAFT] Needs review",
        submittedAt: null,
        approvedAt: null,
        settledAt: null,
        cancelledAt: null,
        lastSyncedAt: null,
        createdBy: "AI_CODER",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    const rows = await listPendingDrafts();

    expect(rows[0].submittedAt).toBeDefined();
    const submittedMs = new Date(rows[0].submittedAt).getTime();
    expect(submittedMs).toBeGreaterThanOrEqual(before);
    expect(submittedMs).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it("handles non-array icd10Codes from Prisma (JSON column) by returning []", async () => {
    prismaMock.insuranceClaim2.findMany.mockResolvedValue([
      {
        id: "claim-3",
        billId: "inv-3",
        patientId: "pat-3",
        tpaProvider: "MOCK",
        providerClaimRef: null,
        insurerName: "X",
        policyNumber: "P",
        memberId: null,
        preAuthRequestId: null,
        diagnosis: "Dx",
        icd10Codes: { not: "array" } as any,
        procedureName: null,
        admissionDate: null,
        dischargeDate: null,
        amountClaimed: 100,
        amountApproved: null,
        status: "SUBMITTED",
        deniedReason: null,
        notes: "[AI DRAFT] Needs review",
        submittedAt: new Date(),
        approvedAt: null,
        settledAt: null,
        cancelledAt: null,
        lastSyncedAt: null,
        createdBy: "AI_CODER",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    const rows = await listPendingDrafts();

    expect(rows[0].icd10Codes).toEqual([]);
  });

  it("returns an empty list when the table has no pending drafts", async () => {
    prismaMock.insuranceClaim2.findMany.mockResolvedValue([]);
    const rows = await listPendingDrafts();
    expect(rows).toEqual([]);
  });
});

// ─── Constants ────────────────────────────────────────────────────────────

describe("module constants", () => {
  it("pins DRAFT_STATUS to SUBMITTED until DRAFT_PENDING_REVIEW lands", () => {
    expect(DRAFT_STATUS).toBe("SUBMITTED");
  });

  it("pins DRAFT_MARKER so listPendingDrafts and the notes-marker filter stay in sync", () => {
    expect(DRAFT_MARKER).toBe("[AI DRAFT] Needs review");
    expect(DRAFT_MARKER).toContain("[AI DRAFT]");
  });
});
