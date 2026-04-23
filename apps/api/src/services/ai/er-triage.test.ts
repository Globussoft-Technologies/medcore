import { describe, it, expect, vi, beforeEach } from "vitest";

const { createMock } = vi.hoisted(() => ({ createMock: vi.fn() }));

vi.mock("openai", () => {
  class OpenAI {
    chat = { completions: { create: createMock } };
    constructor(_opts: any) {}
  }
  return { default: OpenAI };
});

import { calculateMEWS, assessERPatient } from "./er-triage";

function triageToolReply(args: object) {
  return {
    choices: [
      {
        message: {
          content: null,
          tool_calls: [
            {
              type: "function",
              function: { name: "suggest_triage", arguments: JSON.stringify(args) },
            },
          ],
        },
      },
    ],
  };
}

beforeEach(() => {
  createMock.mockReset();
});

// ── calculateMEWS ─────────────────────────────────────────────────────────────

describe("calculateMEWS", () => {
  it("returns 0 for all-normal vitals", () => {
    const score = calculateMEWS({
      respiratoryRate: 16,
      spO2: 98,
      pulse: 75,
      systolicBP: 120,
      temperature: 37,
      consciousness: 0,
    });
    expect(score).toBe(0);
  });

  it("scores critically low BP, tachycardia, hypoxia correctly", () => {
    const score = calculateMEWS({
      respiratoryRate: 35, // +3
      spO2: 80, // +3 (<85)
      pulse: 140, // +3 (>=130)
      systolicBP: 65, // +3 (<=70)
      temperature: 34, // +3 (<=35)
      consciousness: 3, // +3 unresponsive
    });
    expect(score).toBe(18);
  });

  it("returns 0 when no vitals are supplied", () => {
    expect(calculateMEWS({})).toBe(0);
  });

  it("boundary: RR=8 scores 3 but RR=9 scores 1", () => {
    expect(calculateMEWS({ respiratoryRate: 8 })).toBe(3);
    expect(calculateMEWS({ respiratoryRate: 9 })).toBe(1);
  });

  it("boundary: pulse 101 scores 1 (tachy starts)", () => {
    expect(calculateMEWS({ pulse: 100 })).toBe(0);
    expect(calculateMEWS({ pulse: 101 })).toBe(1);
  });

  it("boundary: systolicBP 200 scores 2 (hypertensive)", () => {
    expect(calculateMEWS({ systolicBP: 199 })).toBe(0);
    expect(calculateMEWS({ systolicBP: 200 })).toBe(2);
  });
});

// ── assessERPatient ───────────────────────────────────────────────────────────

describe("assessERPatient", () => {
  it("returns parsed assessment and attaches calculated MEWS", async () => {
    createMock.mockResolvedValueOnce(
      triageToolReply({
        suggestedTriageLevel: 2,
        triageLevelLabel: "Emergent",
        disposition: "Treatment room",
        immediateActions: ["IV access"],
        suggestedInvestigations: ["ECG"],
        redFlags: ["Tachycardia"],
        aiReasoning: "Tachy + CP",
      })
    );
    const result = await assessERPatient({
      chiefComplaint: "chest pain",
      vitals: { bp: "140/90", pulse: 110, resp: 20, spO2: 96, temp: 37, gcs: 15 },
      patientAge: 55,
      patientGender: "M",
    });
    expect(result.suggestedTriageLevel).toBe(2);
    expect(result.disposition).toBe("Treatment room");
    // MEWS recalculated: pulse 110 → +1, rest normal → 1
    expect(result.calculatedMEWS).toBe(1);
    expect(result.disclaimer).toMatch(/Final triage decision/i);
  });

  it("returns conservative Level-2 fallback when model emits no tool call", async () => {
    createMock.mockResolvedValueOnce({
      choices: [{ message: { content: "cannot help", tool_calls: undefined } }],
    });
    const result = await assessERPatient({
      chiefComplaint: "abdominal pain",
      vitals: {},
    });
    expect(result.suggestedTriageLevel).toBe(2);
    expect(result.triageLevelLabel).toBe("Emergent");
    expect(result.aiReasoning).toMatch(/fallback/i);
    expect(result.calculatedMEWS).toBeNull();
  });

  it("parses systolic BP from BP string for MEWS calculation", async () => {
    createMock.mockResolvedValueOnce(
      triageToolReply({
        suggestedTriageLevel: 1,
        triageLevelLabel: "Resuscitation",
        disposition: "Immediate resuscitation bay",
        immediateActions: [],
        suggestedInvestigations: [],
        redFlags: [],
        aiReasoning: "shock",
      })
    );
    const result = await assessERPatient({
      chiefComplaint: "collapsed",
      vitals: { bp: "70/40", pulse: 150, gcs: 8 }, // GCS 8 → consciousness 3 (unresponsive)
    });
    // pulse 150 → +3, systolic 70 → +3, consciousness 3 → +3 = 9
    expect(result.calculatedMEWS).toBe(9);
  });

  it("maps GCS 15 to alert (consciousness 0)", async () => {
    createMock.mockResolvedValueOnce(
      triageToolReply({
        suggestedTriageLevel: 3,
        triageLevelLabel: "Urgent",
        disposition: "Treatment room",
        immediateActions: [],
        suggestedInvestigations: [],
        redFlags: [],
        aiReasoning: "",
      })
    );
    const r = await assessERPatient({
      chiefComplaint: "cough",
      vitals: { gcs: 15 },
    });
    // Only consciousness 0 → MEWS 0
    expect(r.calculatedMEWS).toBe(0);
  });

  it("returns null MEWS when no vitals provided", async () => {
    createMock.mockResolvedValueOnce(
      triageToolReply({
        suggestedTriageLevel: 5,
        triageLevelLabel: "Non-Urgent",
        disposition: "Waiting room",
        immediateActions: [],
        suggestedInvestigations: [],
        redFlags: [],
        aiReasoning: "routine",
      })
    );
    const r = await assessERPatient({ chiefComplaint: "minor laceration", vitals: {} });
    expect(r.calculatedMEWS).toBeNull();
  });
});
