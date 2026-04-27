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
  checkHepaticRisk,
  checkPediatricDose,
  inferHepaticImpairment,
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

  it("flags methotrexate in mild hepatic impairment as CONTRAINDICATED", () => {
    const alerts = checkHepaticContraindications(["Methotrexate"], "mild");
    expect(alerts.length).toBeGreaterThan(0);
    // Methotrexate is an absolute contraindication in any active liver
    // disease (Stockley / Goodman & Gilman), not merely SEVERE.
    expect(alerts[0].severity).toBe("CONTRAINDICATED");
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

// ── checkHepaticRisk (per-drug structured lookup) ─────────────────────────────

describe("checkHepaticRisk", () => {
  it("returns null when impairment is NONE", () => {
    expect(checkHepaticRisk("Paracetamol 500mg", "NONE")).toBeNull();
  });

  it("returns null for a drug with no hepatic rule", () => {
    expect(checkHepaticRisk("Vitamin C", "MODERATE")).toBeNull();
  });

  it("flags paracetamol DOSE_REDUCE with max-dose rationale in cirrhosis (MODERATE)", () => {
    const r = checkHepaticRisk("Paracetamol 500mg", "MODERATE");
    expect(r).not.toBeNull();
    expect(r!.action).toBe("DOSE_REDUCE");
    expect(r!.rationale).toMatch(/2 g\/day|3 g\/day/i);
    expect(r!.severity).toBe("MODERATE");
  });

  it("flags ibuprofen AVOID in moderate hepatic impairment with severity SEVERE", () => {
    const r = checkHepaticRisk("Ibuprofen 400mg", "MODERATE");
    expect(r).not.toBeNull();
    expect(r!.action).toBe("AVOID");
    expect(r!.severity).toBe("SEVERE");
    expect(r!.alternatives.length).toBeGreaterThan(0);
  });

  it("does NOT flag ibuprofen in MILD impairment (rule threshold is moderate)", () => {
    expect(checkHepaticRisk("Ibuprofen", "MILD")).toBeNull();
  });

  it("flags valproate as CONTRAINDICATED even in MILD impairment", () => {
    const r = checkHepaticRisk("Sodium valproate 500mg", "MILD");
    expect(r).not.toBeNull();
    expect(r!.severity).toBe("CONTRAINDICATED");
    expect(r!.action).toBe("AVOID");
  });

  it("flags amiodarone AVOID in moderate impairment", () => {
    const r = checkHepaticRisk("Amiodarone 200mg", "MODERATE");
    expect(r).not.toBeNull();
    expect(r!.action).toBe("AVOID");
  });

  it("flags erythromycin AVOID in moderate impairment (cholestatic jaundice)", () => {
    const r = checkHepaticRisk("Erythromycin 250mg", "MODERATE");
    expect(r).not.toBeNull();
    expect(r!.rationale).toMatch(/cholestatic/i);
  });

  it("flags tramadol DOSE_REDUCE in moderate impairment", () => {
    const r = checkHepaticRisk("Tramadol 50mg", "MODERATE");
    expect(r).not.toBeNull();
    expect(r!.action).toBe("DOSE_REDUCE");
  });

  it("flags metronidazole only in SEVERE (not moderate)", () => {
    expect(checkHepaticRisk("Metronidazole 400mg", "MODERATE")).toBeNull();
    const r = checkHepaticRisk("Metronidazole 400mg", "SEVERE");
    expect(r).not.toBeNull();
    expect(r!.action).toBe("DOSE_REDUCE");
  });

  it("flags ketoconazole CONTRAINDICATED even in MILD impairment (oral azole)", () => {
    const r = checkHepaticRisk("Ketoconazole 200mg", "MILD");
    expect(r).not.toBeNull();
    expect(r!.severity).toBe("CONTRAINDICATED");
  });
});

// ── checkPediatricDose (weight-based) ─────────────────────────────────────────

describe("checkPediatricDose", () => {
  it("returns null for a non-pediatric drug not in the rule set", () => {
    expect(checkPediatricDose("Vitamin D drops", 400, "OD", 10, 24)).toBeNull();
  });

  it("returns null on missing/invalid inputs", () => {
    expect(checkPediatricDose("Paracetamol", 0, "Q6H", 10, 24)).toBeNull();
    expect(checkPediatricDose("Paracetamol", 100, "Q6H", 0, 24)).toBeNull();
  });

  it("accepts paracetamol 100mg Q6H for a 6-month-old at ~7 kg as OK (15 mg/kg)", () => {
    const r = checkPediatricDose("Paracetamol", 100, "Q6H", 7, 6);
    expect(r).not.toBeNull();
    expect(r!.status).toBe("OK");
  });

  it("flags paracetamol 500mg Q6H over-dose for a 6-month-old at 7 kg (~105 mg expected)", () => {
    const r = checkPediatricDose("Paracetamol", 500, "Q6H", 7, 6);
    expect(r).not.toBeNull();
    expect(r!.status).toMatch(/OVER_DOSE_SINGLE|OVER_DAILY_CAP/);
    expect(r!.severity === "SEVERE" || r!.severity === "MODERATE").toBe(true);
  });

  it("flags ibuprofen as AGE_OUT_OF_BAND for a 2-month-old infant", () => {
    const r = checkPediatricDose("Ibuprofen", 50, "Q8H", 5, 2);
    expect(r).not.toBeNull();
    expect(r!.status).toBe("AGE_OUT_OF_BAND");
  });

  it("flags amoxicillin under-dose: 50mg BD for 4-year-old at 16 kg (expected ~400 mg)", () => {
    const r = checkPediatricDose("Amoxicillin", 50, "BD", 16, 48);
    expect(r).not.toBeNull();
    expect(r!.status).toBe("UNDER_DOSE");
    expect(r!.severity).toBe("MODERATE");
    expect(r!.rationale).toMatch(/treatment failure|below the expected/i);
  });

  it("accepts amoxicillin 400mg BD for 4-year-old at 16 kg as OK (25 mg/kg)", () => {
    const r = checkPediatricDose("Amoxicillin", 400, "BD", 16, 48);
    expect(r).not.toBeNull();
    expect(r!.status).toBe("OK");
  });

  it("flags amoxicillin over-dose: 1500 mg BD for 16 kg child (exceeds 1 g/dose cap)", () => {
    const r = checkPediatricDose("Amoxicillin", 1500, "BD", 16, 48);
    expect(r).not.toBeNull();
    expect(r!.status).toBe("OVER_DOSE_SINGLE");
    expect(r!.severity).toBe("SEVERE");
  });

  it("flags ondansetron over-cap: 8 mg for a 30 kg child (absolute ceiling 4 mg/dose)", () => {
    const r = checkPediatricDose("Ondansetron", 8, "Q8H", 30, 60);
    expect(r).not.toBeNull();
    expect(r!.status).toBe("OVER_DOSE_SINGLE");
    expect(r!.severity).toBe("SEVERE");
  });

  it("accepts ondansetron 2 mg single dose for a 12 kg toddler (0.15 mg/kg = 1.8 mg)", () => {
    const r = checkPediatricDose("Ondansetron", 2, "Q8H", 12, 24);
    expect(r).not.toBeNull();
    expect(r!.status).toBe("OK");
  });

  it("flags albendazole 200 mg as UNDER_DOSE for a 4-year-old (fixed 400 mg expected)", () => {
    const r = checkPediatricDose("Albendazole", 200, "OD", 16, 48);
    expect(r).not.toBeNull();
    expect(r!.status).toBe("UNDER_DOSE");
  });

  it("accepts albendazole 200 mg single dose for an 18-month-old (fixed 200 mg)", () => {
    const r = checkPediatricDose("Albendazole", 200, "OD", 11, 18);
    expect(r).not.toBeNull();
    expect(r!.status).toBe("OK");
  });

  it("flags azithromycin over the 500 mg/dose cap for a 60 kg adolescent", () => {
    const r = checkPediatricDose("Azithromycin", 1000, "OD", 60, 12 * 14);
    expect(r).not.toBeNull();
    expect(r!.status).toBe("OVER_DOSE_SINGLE");
    expect(r!.severity).toBe("SEVERE");
  });
});

// ── inferHepaticImpairment ────────────────────────────────────────────────────

describe("inferHepaticImpairment", () => {
  it("returns NONE for empty/no-match conditions", () => {
    expect(inferHepaticImpairment([])).toBe("NONE");
    expect(inferHepaticImpairment(["Hypertension", "T2DM"])).toBe("NONE");
  });

  it("returns MODERATE for plain cirrhosis mention", () => {
    expect(inferHepaticImpairment(["Cirrhosis"])).toBe("MODERATE");
  });

  it("returns SEVERE for decompensated cirrhosis", () => {
    expect(inferHepaticImpairment(["Decompensated cirrhosis"])).toBe("SEVERE");
  });

  it("returns MILD for compensated cirrhosis / Child-Pugh A", () => {
    expect(inferHepaticImpairment(["Child-Pugh A cirrhosis"])).toBe("MILD");
  });
});

// ── checkDrugSafety integrations: hepatic + pediatric ─────────────────────────

describe("checkDrugSafety — hepatic + pediatric integrations", () => {
  it("scribe-flagged cirrhotic patient + paracetamol surfaces a hepatic alert", async () => {
    const report = await checkDrugSafety(
      [{ name: "Paracetamol 500mg", dose: "500mg", frequency: "QDS", duration: "3d" }],
      [],
      [],
      ["Decompensated cirrhosis"],
      { age: 55, gender: "M" }
    );
    expect(report.hepaticRiskChecks).toBeDefined();
    expect(report.hepaticRiskChecks!.length).toBeGreaterThan(0);
    expect(report.hepaticRiskChecks![0].patientImpairment).toBe("SEVERE");
    expect(report.alerts.some((a) => /hepatic/i.test(a.drug2))).toBe(true);
  });

  it("scribe-flagged 4-year-old + amoxicillin runs pediatric checks (OK case)", async () => {
    const report = await checkDrugSafety(
      [{ name: "Amoxicillin", dose: "400mg", frequency: "BD", duration: "5d" }],
      [],
      [],
      [],
      { age: 4, weightKg: 16 }
    );
    expect(report.pediatricDoseChecks).toBeDefined();
    const amox = report.pediatricDoseChecks!.find((c) => /amoxicillin/i.test(c.drugName));
    expect(amox).toBeDefined();
    expect(amox!.status).toBe("OK");
  });

  it("scribe-flagged 4-year-old + amoxicillin under-dose surfaces a pediatric alert", async () => {
    const report = await checkDrugSafety(
      [{ name: "Amoxicillin", dose: "50mg", frequency: "BD", duration: "5d" }],
      [],
      [],
      [],
      { age: 4, weightKg: 16 }
    );
    expect(report.pediatricDoseChecks).toBeDefined();
    const amox = report.pediatricDoseChecks!.find((c) => /amoxicillin/i.test(c.drugName));
    expect(amox).toBeDefined();
    expect(amox!.status).toBe("UNDER_DOSE");
    expect(report.alerts.some((a) => /PEDIATRIC/.test(a.drug2))).toBe(true);
  });

  it("does not run pediatric checks for adult patients", async () => {
    const report = await checkDrugSafety(
      [{ name: "Paracetamol", dose: "500mg", frequency: "QDS", duration: "3d" }],
      [],
      [],
      [],
      { age: 35, weightKg: 70 }
    );
    expect(report.pediatricDoseChecks).toBeUndefined();
  });

  it("explicit hepaticImpairment in patientMeta wins over inference", async () => {
    const report = await checkDrugSafety(
      [{ name: "Paracetamol 500mg", dose: "500mg", frequency: "QDS", duration: "3d" }],
      [],
      [],
      [], // no hepatic conditions in chronic list
      { age: 55, hepaticImpairment: "severe" }
    );
    expect(report.hepaticRiskChecks).toBeDefined();
    expect(report.hepaticRiskChecks![0].patientImpairment).toBe("SEVERE");
  });
});
