// Unit tests for analyzeDifferential.
//
// differential.ts uses generateStructured() from ./sarvam, so we mock that
// module surface directly. No OpenAI client needs to be stubbed out because
// the SUT never imports openai.

import { describe, it, expect, beforeEach, vi } from "vitest";

const { generateStructuredMock, logAICallMock } = vi.hoisted(() => ({
  generateStructuredMock: vi.fn(),
  logAICallMock: vi.fn(),
}));

vi.mock("./sarvam", () => ({
  generateStructured: generateStructuredMock,
  logAICall: logAICallMock,
}));

import { analyzeDifferential } from "./differential";

function structuredOk(data: any) {
  return { data, promptTokens: 100, completionTokens: 50 };
}

beforeEach(() => {
  generateStructuredMock.mockReset();
  logAICallMock.mockReset();
});

describe("analyzeDifferential", () => {
  it("returns a ranked list with confidence bands and recommended tests", async () => {
    generateStructuredMock.mockResolvedValueOnce(
      structuredOk({
        differentials: [
          {
            diagnosis: "Acute coronary syndrome",
            icd10: "I20.9",
            probability: "high",
            reasoning: "Chest pain + risk factors",
            recommendedTests: ["ECG", "Troponin"],
            redFlags: ["Radiating to arm"],
          },
          {
            diagnosis: "GERD",
            icd10: "K21.9",
            probability: "low",
            reasoning: "Burning epigastric pain after meals",
            recommendedTests: ["PPI trial"],
            redFlags: [],
          },
        ],
        guidelineReferences: ["NICE CG95"],
      })
    );

    const r = await analyzeDifferential({
      chiefComplaint: "chest pain radiating to left arm",
      vitals: { bp: "150/95", pulse: 110 },
      age: 58,
      gender: "M",
    });

    expect(r.differentials).toHaveLength(2);
    expect(r.differentials[0].diagnosis).toBe("Acute coronary syndrome");
    expect(r.differentials[0].probability).toBe("high");
    expect(r.differentials[0].recommendedTests).toContain("ECG");
    expect(r.differentials[0].redFlags).toContain("Radiating to arm");
    expect(r.guidelineReferences).toContain("NICE CG95");
  });

  it("normalises an unknown probability label to 'low'", async () => {
    generateStructuredMock.mockResolvedValueOnce(
      structuredOk({
        differentials: [
          {
            diagnosis: "Migraine",
            probability: "maybe", // not in [high, medium, low]
            reasoning: "Throbbing unilateral",
            recommendedTests: [],
            redFlags: [],
          },
        ],
        guidelineReferences: [],
      })
    );

    const r = await analyzeDifferential({ chiefComplaint: "headache" });
    expect(r.differentials[0].probability).toBe("low");
  });

  it("coerces missing redFlags / recommendedTests arrays to []", async () => {
    generateStructuredMock.mockResolvedValueOnce(
      structuredOk({
        differentials: [
          {
            diagnosis: "Tension headache",
            probability: "medium",
            reasoning: "x",
            // recommendedTests and redFlags omitted entirely
          },
        ],
        guidelineReferences: undefined,
      })
    );

    const r = await analyzeDifferential({ chiefComplaint: "headache" });
    expect(r.differentials[0].recommendedTests).toEqual([]);
    expect(r.differentials[0].redFlags).toEqual([]);
    expect(r.guidelineReferences).toEqual([]);
  });

  it("returns an empty result when Sarvam returns no data", async () => {
    generateStructuredMock.mockResolvedValueOnce({
      data: undefined,
      promptTokens: 0,
      completionTokens: 0,
    });
    const r = await analyzeDifferential({ chiefComplaint: "fatigue" });
    expect(r.differentials).toEqual([]);
    expect(r.guidelineReferences).toEqual([]);
  });

  it("propagates Sarvam errors after logging", async () => {
    const err = new Error("upstream 503");
    generateStructuredMock.mockRejectedValueOnce(err);
    await expect(
      analyzeDifferential({ chiefComplaint: "syncope" })
    ).rejects.toBe(err);
    expect(logAICallMock).toHaveBeenCalled();
    const callArgs = logAICallMock.mock.calls.at(-1)?.[0];
    expect(callArgs?.error).toMatch(/upstream 503/);
  });

  it("includes patient context (allergies, chronic conditions, meds) in the user prompt", async () => {
    generateStructuredMock.mockResolvedValueOnce(
      structuredOk({ differentials: [], guidelineReferences: [] })
    );

    await analyzeDifferential({
      chiefComplaint: "shortness of breath",
      allergies: ["penicillin"],
      chronicConditions: ["asthma"],
      currentMedications: ["salbutamol"],
      age: 30,
      gender: "F",
    });

    const opts = generateStructuredMock.mock.calls[0][0];
    expect(opts.userPrompt).toMatch(/penicillin/);
    expect(opts.userPrompt).toMatch(/asthma/);
    expect(opts.userPrompt).toMatch(/salbutamol/);
    expect(opts.userPrompt).toMatch(/Age: 30/);
  });

  it("forwards vitals as a comma-joined key:value list", async () => {
    generateStructuredMock.mockResolvedValueOnce(
      structuredOk({ differentials: [], guidelineReferences: [] })
    );

    await analyzeDifferential({
      chiefComplaint: "fever",
      vitals: { temp: 39.2, pulse: 110 },
    });

    const opts = generateStructuredMock.mock.calls[0][0];
    expect(opts.userPrompt).toMatch(/temp: 39.2/);
    expect(opts.userPrompt).toMatch(/pulse: 110/);
  });

  it("renders 'not provided' when vitals object is omitted", async () => {
    generateStructuredMock.mockResolvedValueOnce(
      structuredOk({ differentials: [], guidelineReferences: [] })
    );
    await analyzeDifferential({ chiefComplaint: "fatigue" });
    const opts = generateStructuredMock.mock.calls[0][0];
    expect(opts.userPrompt).toMatch(/Vitals: not provided/);
  });

  it("requests structured output with the emit_differentials tool", async () => {
    generateStructuredMock.mockResolvedValueOnce(
      structuredOk({ differentials: [], guidelineReferences: [] })
    );

    await analyzeDifferential({ chiefComplaint: "rash" });

    const opts = generateStructuredMock.mock.calls[0][0];
    expect(opts.toolName).toBe("emit_differentials");
    expect(opts.parameters).toBeDefined();
    expect(opts.maxTokens).toBeGreaterThan(0);
  });
});
