import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Mocks ─────────────────────────────────────────────────────────────────────

const { createMock, prismaMock } = vi.hoisted(() => ({
  createMock: vi.fn(),
  prismaMock: {
    medicine: { findMany: vi.fn(async () => []) },
  } as any,
}));

vi.mock("openai", () => {
  class OpenAI {
    chat = { completions: { create: createMock } };
    constructor(_opts: any) {}
  }
  return { default: OpenAI };
});

vi.mock("@medcore/db", () => ({ prisma: prismaMock }));

import {
  checkAllergyContraindications,
  checkKnownDrugInteractions,
  checkConditionContraindications,
  checkPaediatricContraindications,
  checkRenalDosing,
  checkHepaticContraindications,
  checkDrugSafety,
} from "./drug-interactions";

const savedApiKey = process.env.SARVAM_API_KEY;

beforeEach(() => {
  createMock.mockReset();
  prismaMock.medicine.findMany.mockReset();
  prismaMock.medicine.findMany.mockResolvedValue([]);
  delete process.env.SARVAM_API_KEY; // Layer-2 off by default in unit tests
});

afterEach(() => {
  if (savedApiKey == null) delete process.env.SARVAM_API_KEY;
  else process.env.SARVAM_API_KEY = savedApiKey;
});

// ── checkAllergyContraindications ─────────────────────────────────────────────

describe("checkAllergyContraindications", () => {
  it("flags amoxicillin for penicillin-allergic patient (SEVERE via cross-reactivity)", () => {
    const alerts = checkAllergyContraindications(["Amoxicillin 500mg"], ["penicillin"]);
    expect(alerts.length).toBeGreaterThan(0);
    const sev = alerts.find((a) => a.severity === "SEVERE");
    expect(sev).toBeDefined();
    expect(sev!.drug2).toContain("penicillin");
  });

  it("flags NSAID for aspirin-allergic patient", () => {
    const alerts = checkAllergyContraindications(["Ibuprofen"], ["aspirin"]);
    expect(alerts.some((a) => /NSAID cross-reactivity/i.test(a.description))).toBe(true);
  });

  it("returns no allergy alerts when proposed med is unrelated", () => {
    const alerts = checkAllergyContraindications(["Metformin"], ["penicillin"]);
    expect(alerts).toHaveLength(0);
  });

  it("returns empty array when allergies list is empty", () => {
    expect(checkAllergyContraindications(["anything"], [])).toHaveLength(0);
  });

  it("flags direct name match as CONTRAINDICATED", () => {
    const alerts = checkAllergyContraindications(["Penicillin V 250mg"], ["penicillin"]);
    const contra = alerts.find((a) => a.severity === "CONTRAINDICATED");
    expect(contra).toBeDefined();
  });
});

// ── checkKnownDrugInteractions ────────────────────────────────────────────────

describe("checkKnownDrugInteractions", () => {
  it("flags warfarin + ibuprofen as SEVERE bleeding risk", () => {
    const alerts = checkKnownDrugInteractions(["Ibuprofen"], ["Warfarin"]);
    expect(alerts.length).toBeGreaterThan(0);
    expect(alerts[0].severity).toBe("SEVERE");
    expect(alerts[0].description).toMatch(/bleeding|NSAID/i);
  });

  it("flags sildenafil + nitrate as CONTRAINDICATED", () => {
    const alerts = checkKnownDrugInteractions(["Sildenafil"], ["Isosorbide mononitrate"]);
    expect(alerts.some((a) => a.severity === "CONTRAINDICATED")).toBe(true);
  });

  it("flags SSRI + MAOI as CONTRAINDICATED (serotonin syndrome)", () => {
    const alerts = checkKnownDrugInteractions(["Fluoxetine"], ["Phenelzine"]);
    expect(alerts.some((a) => a.severity === "CONTRAINDICATED")).toBe(true);
  });

  it("returns no alerts for ibuprofen alone (no interaction pair)", () => {
    const alerts = checkKnownDrugInteractions(["Ibuprofen"], []);
    expect(alerts).toHaveLength(0);
  });

  it("does NOT alert when both drugs are already in the current list (no proposed change)", () => {
    const alerts = checkKnownDrugInteractions([], ["Warfarin", "Ibuprofen"]);
    expect(alerts).toHaveLength(0);
  });

  it("deduplicates symmetric pair matches", () => {
    const alerts = checkKnownDrugInteractions(["Warfarin", "Ibuprofen"], []);
    // Warfarin + Ibuprofen should appear only once
    const matching = alerts.filter((a) =>
      /warfarin/i.test(`${a.drug1} ${a.drug2}`) &&
      /ibuprofen/i.test(`${a.drug1} ${a.drug2}`)
    );
    expect(matching).toHaveLength(1);
  });
});

// ── checkConditionContraindications ───────────────────────────────────────────

describe("checkConditionContraindications", () => {
  it("flags propranolol in asthma as SEVERE", () => {
    const alerts = checkConditionContraindications(["Propranolol"], ["Asthma"]);
    expect(alerts[0].severity).toBe("SEVERE");
  });

  it("flags warfarin in pregnancy as CONTRAINDICATED", () => {
    const alerts = checkConditionContraindications(["Warfarin"], ["pregnancy"]);
    expect(alerts.some((a) => a.severity === "CONTRAINDICATED")).toBe(true);
  });

  it("returns empty when condition doesn't match any rule", () => {
    const alerts = checkConditionContraindications(["Paracetamol"], ["common cold"]);
    expect(alerts).toHaveLength(0);
  });

  it("flags NSAIDs in CKD", () => {
    const alerts = checkConditionContraindications(["Diclofenac"], ["CKD stage 3"]);
    expect(alerts.some((a) => a.severity === "SEVERE")).toBe(true);
  });
});

// ── checkPaediatricContraindications ──────────────────────────────────────────

describe("checkPaediatricContraindications", () => {
  it("flags aspirin for children < 16 years", () => {
    const alerts = checkPaediatricContraindications(["Aspirin 75mg"], 8);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].description).toMatch(/Reye/i);
  });

  it("does NOT flag aspirin for age >= 16", () => {
    expect(checkPaediatricContraindications(["Aspirin"], 18)).toHaveLength(0);
  });

  it("returns empty array when age is undefined", () => {
    expect(checkPaediatricContraindications(["Aspirin"], undefined)).toHaveLength(0);
  });

  it("flags codeine for age 10", () => {
    const alerts = checkPaediatricContraindications(["Codeine phosphate"], 10);
    expect(alerts.length).toBeGreaterThan(0);
  });
});

// ── checkRenalDosing ──────────────────────────────────────────────────────────

describe("checkRenalDosing", () => {
  it("flags metformin CONTRAINDICATED at eGFR 25", () => {
    const alerts = checkRenalDosing(["Metformin"], 25);
    expect(alerts.some((a) => a.severity === "CONTRAINDICATED")).toBe(true);
  });

  it("does NOT flag metformin at normal eGFR 90", () => {
    expect(checkRenalDosing(["Metformin"], 90)).toHaveLength(0);
  });

  it("returns empty array when eGFR undefined", () => {
    expect(checkRenalDosing(["Metformin", "Ibuprofen"], undefined)).toHaveLength(0);
  });

  it("flags NSAID SEVERE when eGFR < 60", () => {
    const alerts = checkRenalDosing(["Ibuprofen"], 45);
    expect(alerts.some((a) => a.severity === "SEVERE")).toBe(true);
  });
});

// ── checkHepaticContraindications ─────────────────────────────────────────────

describe("checkHepaticContraindications", () => {
  it("returns empty when hepaticImpairment is null", () => {
    expect(checkHepaticContraindications(["Methotrexate"], null)).toHaveLength(0);
  });

  it("flags methotrexate in mild hepatic impairment", () => {
    const alerts = checkHepaticContraindications(["Methotrexate"], "mild");
    expect(alerts.length).toBeGreaterThan(0);
    expect(alerts[0].severity).toBe("SEVERE");
  });

  it("does NOT flag statins in mild but DOES in moderate impairment", () => {
    expect(checkHepaticContraindications(["Atorvastatin"], "mild")).toHaveLength(0);
    expect(checkHepaticContraindications(["Atorvastatin"], "moderate").length).toBeGreaterThan(0);
  });

  it("flags azoles in moderate impairment", () => {
    const alerts = checkHepaticContraindications(["Fluconazole"], "severe");
    expect(alerts.length).toBeGreaterThan(0);
  });
});

// ── checkDrugSafety (aggregate) ───────────────────────────────────────────────

describe("checkDrugSafety", () => {
  it("aggregates deterministic alerts and flags hasContraindicated/hasSevere correctly", async () => {
    const report = await checkDrugSafety(
      [{ name: "Ibuprofen", dose: "400mg", frequency: "TDS", duration: "3d" }],
      ["Warfarin"],
      [],
      [],
      {}
    );
    expect(report.checkedMeds).toEqual(["Ibuprofen"]);
    expect(report.hasSevere).toBe(true);
    expect(report.hasContraindicated).toBe(false);
    expect(report.alerts.length).toBeGreaterThan(0);
    expect(report.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("returns no alerts for a safe single medication", async () => {
    const report = await checkDrugSafety(
      [{ name: "Paracetamol", dose: "500mg", frequency: "QDS", duration: "5d" }],
      [],
      [],
      [],
      {}
    );
    expect(report.alerts).toHaveLength(0);
    expect(report.hasContraindicated).toBe(false);
    expect(report.hasSevere).toBe(false);
  });

  it("skips LLM layer when SARVAM_API_KEY is absent", async () => {
    await checkDrugSafety(
      [{ name: "Amoxicillin", dose: "500mg", frequency: "TDS", duration: "5d" }],
      [],
      [],
      [],
      {}
    );
    expect(createMock).not.toHaveBeenCalled();
  });

  it("tolerates LLM layer failure and still returns deterministic alerts", async () => {
    process.env.SARVAM_API_KEY = "x";
    createMock.mockRejectedValueOnce(new Error("LLM boom"));
    const report = await checkDrugSafety(
      [{ name: "Ibuprofen", dose: "400mg", frequency: "TDS", duration: "3d" }],
      ["Warfarin"],
      [],
      [],
      {}
    );
    expect(report.alerts.length).toBeGreaterThan(0);
    expect(report.hasSevere).toBe(true);
  });

  it("merges LLM-discovered interactions not already in deterministic list", async () => {
    process.env.SARVAM_API_KEY = "x";
    createMock.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              {
                type: "function",
                function: {
                  name: "report_drug_interactions",
                  arguments: JSON.stringify({
                    interactions: [
                      {
                        drug1: "DrugA",
                        drug2: "DrugB",
                        severity: "MODERATE",
                        description: "Novel pair",
                      },
                    ],
                  }),
                },
              },
            ],
          },
        },
      ],
    });
    const report = await checkDrugSafety(
      [{ name: "DrugA", dose: "1", frequency: "OD", duration: "1d" }],
      ["DrugB"],
      [],
      [],
      {}
    );
    const novel = report.alerts.find((a) => a.drug1 === "DrugA" && a.drug2 === "DrugB");
    expect(novel).toBeDefined();
    expect(novel!.severity).toBe("MODERATE");
  });

  it("surfaces generic alternatives from the medicine catalogue", async () => {
    prismaMock.medicine.findMany.mockResolvedValueOnce([
      { name: "Crocin", genericName: "paracetamol" },
      { name: "Dolopar", genericName: "paracetamol" },
    ]);
    const report = await checkDrugSafety(
      [{ name: "Calpol", dose: "500mg", frequency: "QDS", duration: "5d" }],
      [],
      [],
      [],
      {}
    );
    expect(report.genericAlternatives.length).toBe(1);
    expect(report.genericAlternatives[0].brandName).toBe("Calpol");
    expect(report.genericAlternatives[0].generics.length).toBeGreaterThan(0);
  });
});
