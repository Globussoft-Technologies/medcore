// Unit tests for analyzeSymptomTrends and the deterministic fallback.
//
// symptom-diary.ts uses generateStructured() from ./sarvam. The deterministic
// fallback path is the load-bearing one (mobile UI relies on it when Sarvam
// is offline) so we cover it directly via the exported helper.
//
// NOTE: The brief asked for "cross-reference against active prescriptions",
// but the current source surface does not expose that — analyzeSymptomTrends
// only takes diary entries. Flagging here for a future session; not testing
// an API that doesn't exist.

import { describe, it, expect, beforeEach, vi } from "vitest";

const { generateStructuredMock } = vi.hoisted(() => ({
  generateStructuredMock: vi.fn(),
}));

vi.mock("./sarvam", () => ({
  generateStructured: generateStructuredMock,
  logAICall: vi.fn(),
}));

import { analyzeSymptomTrends, deterministicTrends, DayEntry } from "./symptom-diary";

beforeEach(() => {
  generateStructuredMock.mockReset();
});

function dayEntry(date: string, entries: DayEntry["entries"]): DayEntry {
  return { symptomDate: new Date(date), entries };
}

describe("analyzeSymptomTrends", () => {
  it("returns an empty-state message when there are no diary days", async () => {
    const r = await analyzeSymptomTrends([]);
    expect(r.trends).toEqual([]);
    expect(r.followUpRecommended).toBe(false);
    expect(r.reasoning).toMatch(/log symptoms/i);
    expect(generateStructuredMock).not.toHaveBeenCalled();
  });

  it("returns the Sarvam-shaped result when generateStructured succeeds", async () => {
    generateStructuredMock.mockResolvedValueOnce({
      data: {
        trends: [
          {
            symptom: "headache",
            direction: "worsening",
            averageSeverity: 5.5,
            peakSeverity: 8,
          },
        ],
        followUpRecommended: true,
        reasoning: "Headache trending up over 6 days.",
      },
      promptTokens: 100,
      completionTokens: 30,
    });

    const r = await analyzeSymptomTrends([
      dayEntry("2026-04-25", [{ symptom: "headache", severity: 4 }]),
      dayEntry("2026-04-26", [{ symptom: "headache", severity: 6 }]),
      dayEntry("2026-04-27", [{ symptom: "headache", severity: 8 }]),
    ]);

    expect(r.trends).toHaveLength(1);
    expect(r.trends[0].direction).toBe("worsening");
    expect(r.followUpRecommended).toBe(true);
    expect(r.reasoning).toMatch(/Headache/);
  });

  it("truncates long Sarvam reasoning to 240 chars", async () => {
    const longReasoning = "x".repeat(500);
    generateStructuredMock.mockResolvedValueOnce({
      data: {
        trends: [],
        followUpRecommended: false,
        reasoning: longReasoning,
      },
      promptTokens: 0,
      completionTokens: 0,
    });

    const r = await analyzeSymptomTrends([
      dayEntry("2026-04-25", [{ symptom: "headache", severity: 4 }]),
    ]);

    expect(r.reasoning.length).toBeLessThanOrEqual(240);
  });

  it("falls back to the deterministic trend computation when Sarvam throws", async () => {
    generateStructuredMock.mockRejectedValueOnce(new Error("ECONNRESET"));

    const r = await analyzeSymptomTrends([
      dayEntry("2026-04-25", [{ symptom: "headache", severity: 4 }]),
      dayEntry("2026-04-26", [{ symptom: "headache", severity: 6 }]),
      dayEntry("2026-04-27", [{ symptom: "headache", severity: 8 }]),
    ]);

    // Deterministic path picks up the same data and labels it 'worsening'.
    expect(r.trends).toHaveLength(1);
    expect(r.trends[0].symptom).toBe("headache");
    expect(r.trends[0].direction).toBe("worsening");
  });

  it("falls back when Sarvam returns null trends array", async () => {
    generateStructuredMock.mockResolvedValueOnce({
      data: { trends: null as any, followUpRecommended: false, reasoning: "x" },
      promptTokens: 0,
      completionTokens: 0,
    });

    const r = await analyzeSymptomTrends([
      dayEntry("2026-04-25", [{ symptom: "fatigue", severity: 3 }]),
    ]);
    // Falls through to deterministic — fatigue with one entry is 'stable'.
    expect(r.trends.find((t) => t.symptom === "fatigue")).toBeDefined();
  });
});

describe("deterministicTrends — pure fallback", () => {
  it("clusters the same symptom across multiple days into one trend", () => {
    const r = deterministicTrends([
      dayEntry("2026-04-25", [{ symptom: "Headache", severity: 4 }]),
      dayEntry("2026-04-26", [{ symptom: "headache ", severity: 6 }]), // case + ws
      dayEntry("2026-04-27", [{ symptom: "HEADACHE", severity: 8 }]),
    ]);
    expect(r.trends).toHaveLength(1);
    expect(r.trends[0].symptom).toBe("headache");
    expect(r.trends[0].peakSeverity).toBe(8);
  });

  it("labels a rising trend across >= 3 days as 'worsening'", () => {
    const r = deterministicTrends([
      dayEntry("2026-04-25", [{ symptom: "cough", severity: 2 }]),
      dayEntry("2026-04-26", [{ symptom: "cough", severity: 5 }]),
      dayEntry("2026-04-27", [{ symptom: "cough", severity: 7 }]),
    ]);
    const cough = r.trends.find((t) => t.symptom === "cough")!;
    expect(cough.direction).toBe("worsening");
    expect(r.followUpRecommended).toBe(true);
  });

  it("labels a falling trend as 'improving'", () => {
    const r = deterministicTrends([
      dayEntry("2026-04-25", [{ symptom: "fever", severity: 8 }]),
      dayEntry("2026-04-26", [{ symptom: "fever", severity: 5 }]),
      dayEntry("2026-04-27", [{ symptom: "fever", severity: 2 }]),
    ]);
    const fever = r.trends.find((t) => t.symptom === "fever")!;
    expect(fever.direction).toBe("improving");
  });

  it("recommends follow-up when severity >= 8 logged on 2+ days", () => {
    const r = deterministicTrends([
      dayEntry("2026-04-25", [{ symptom: "pain", severity: 9 }]),
      dayEntry("2026-04-26", [{ symptom: "pain", severity: 4 }]),
      dayEntry("2026-04-27", [{ symptom: "pain", severity: 8 }]),
    ]);
    expect(r.followUpRecommended).toBe(true);
    expect(r.reasoning).toMatch(/severe on multiple days|trending up/i);
  });

  it("flags a high-amplitude swing as 'fluctuating'", () => {
    const r = deterministicTrends([
      dayEntry("2026-04-25", [{ symptom: "nausea", severity: 1 }]),
      dayEntry("2026-04-26", [{ symptom: "nausea", severity: 6 }]),
      dayEntry("2026-04-27", [{ symptom: "nausea", severity: 6 }]),
      dayEntry("2026-04-28", [{ symptom: "nausea", severity: 1 }]),
      dayEntry("2026-04-29", [{ symptom: "nausea", severity: 6 }]),
    ]);
    const nausea = r.trends.find((t) => t.symptom === "nausea")!;
    expect(nausea.direction).toBe("fluctuating");
  });

  it("labels stable mild symptoms as 'stable' with no follow-up", () => {
    const r = deterministicTrends([
      dayEntry("2026-04-25", [{ symptom: "itch", severity: 2 }]),
      dayEntry("2026-04-26", [{ symptom: "itch", severity: 2 }]),
      dayEntry("2026-04-27", [{ symptom: "itch", severity: 2 }]),
    ]);
    const itch = r.trends.find((t) => t.symptom === "itch")!;
    expect(itch.direction).toBe("stable");
    expect(r.followUpRecommended).toBe(false);
  });

  it("rolls multiple symptoms per day into separate trend rows", () => {
    const r = deterministicTrends([
      dayEntry("2026-04-25", [
        { symptom: "headache", severity: 5 },
        { symptom: "nausea", severity: 4 },
      ]),
    ]);
    expect(r.trends.map((t) => t.symptom).sort()).toEqual(["headache", "nausea"]);
  });
});
