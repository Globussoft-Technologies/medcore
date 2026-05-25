/**
 * Test-cron tick (2026-05-25) — Lab Result Intelligence unit tests.
 *
 * What / which modules / why
 * ──────────────────────────
 * - WHAT: regression around the single exported entry point of
 *   `services/ai/lab-intel.ts` — `analyzeLabResult(labResultId)`. Pins:
 *   the 404 throw when the lab result is missing, the happy path with
 *   a fully-shaped LLM payload, every enum-coercion branch
 *   (invalid trend → "unknown", invalid urgency → "routine"), the
 *   missing-field defaults (interpretation/baselineComparison → "",
 *   non-array recommendedActions → []), the empty-data fallback
 *   (data === null) with and without prior history, and the
 *   LLM-throws path (which re-throws after logging the error).
 *   Also exercises the history-empty vs history-populated text
 *   formatting branches and the chronic-conditions / medications
 *   "none documented" defaults.
 *
 * - MODULES: hoisted mock of `../tenant-prisma` (which re-exports
 *   `@medcore/db.tenantScopedPrisma`) so no real Postgres is touched
 *   + mock of `./sarvam` (both `generateStructured` and `logAICall`).
 *   Mirrors the shape used by `differential.test.ts` and
 *   `previsit.test.ts` so the suite stays consistent.
 *
 * - WHY: lab-intel feeds clinician-facing interpretation onto every
 *   abnormal lab result. A silent regression in the enum-coercion
 *   branches could surface an invalid trend label downstream; a
 *   regression in the empty-data fallback could blank the output
 *   entirely; the re-throw on LLM failure must remain so the route
 *   layer can map it to 503. This suite locks each branch.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { prismaMock, generateStructuredMock, logAICallMock } = vi.hoisted(() => ({
  prismaMock: {
    labResult: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
    },
  } as any,
  generateStructuredMock: vi.fn(),
  logAICallMock: vi.fn(),
}));

vi.mock("../tenant-prisma", () => ({
  tenantScopedPrisma: prismaMock,
}));

vi.mock("@medcore/db", () => ({
  tenantScopedPrisma: prismaMock,
  getTenantId: () => undefined,
  runWithTenant: (_t: string, fn: () => unknown) => fn(),
  requireTenantId: () => {
    throw new Error("tenant ctx required");
  },
  prisma: prismaMock,
}));

vi.mock("./sarvam", () => ({
  generateStructured: generateStructuredMock,
  logAICall: logAICallMock,
}));

// `prompt-safety` is imported by lab-intel for `sanitizeUserInput`. We don't
// need to mock it — the real implementation is pure and safe in tests — but
// keeping the dep explicit here documents the surface area.
import { analyzeLabResult } from "./lab-intel";

// ─── Fixtures ─────────────────────────────────────────────────────────────

function pick<K extends string>(over: any, key: K, fallback: any) {
  // Use "in" so explicit null/undefined in `over` is honored (not replaced by default).
  return key in over ? over[key] : fallback;
}

function makeLabResult(over: Partial<any> = {}): any {
  return {
    id: pick(over, "id", "lab-1"),
    parameter: pick(over, "parameter", "Hemoglobin"),
    value: pick(over, "value", "8.2"),
    unit: pick(over, "unit", "g/dL"),
    normalRange: pick(over, "normalRange", "12.0-15.5"),
    flag: pick(over, "flag", "LOW"),
    reportedAt: pick(over, "reportedAt", new Date("2026-05-20T08:00:00Z")),
    orderItem: pick(over, "orderItem", {
      order: {
        patient: {
          id: "pat-1",
          chronicConditions: [{ condition: "Anemia" }],
          prescriptions: [
            {
              items: [
                { medicineName: "Iron Sulfate" },
                { medicineName: "Folic Acid" },
              ],
            },
          ],
        },
      },
    }),
  };
}

function makeHistoryRow(over: Partial<any> = {}) {
  return {
    value: pick(over, "value", "9.0"),
    unit: pick(over, "unit", "g/dL"),
    flag: pick(over, "flag", "LOW"),
    reportedAt: pick(over, "reportedAt", new Date("2026-04-15T08:00:00Z")),
  };
}

function makeStructuredResponse(over: Partial<any> = {}) {
  // If caller passes `data`, REPLACE (not merge) so omitted fields stay omitted —
  // important for the missing-field-defaults tests.
  const data = "data" in over
    ? over.data
    : {
        interpretation:
          "Hemoglobin remains below normal; consistent with iron-deficiency anemia.",
        trend: "improving",
        baselineComparison: "Up 0.5 g/dL from prior result.",
        recommendedActions: ["Continue iron supplementation", "Repeat CBC in 4 weeks"],
        urgency: "soon",
      };
  return {
    data,
    promptTokens: pick(over, "promptTokens", 420),
    completionTokens: pick(over, "completionTokens", 120),
  };
}

function resetAllMocks() {
  prismaMock.labResult.findUnique.mockReset();
  prismaMock.labResult.findMany.mockReset();
  generateStructuredMock.mockReset();
  logAICallMock.mockReset();
  // Safe defaults — every test that cares overrides explicitly.
  prismaMock.labResult.findUnique.mockResolvedValue(null);
  prismaMock.labResult.findMany.mockResolvedValue([]);
  generateStructuredMock.mockResolvedValue(makeStructuredResponse());
}

// ─── analyzeLabResult — missing input ─────────────────────────────────────

describe("analyzeLabResult — missing lab result", () => {
  beforeEach(resetAllMocks);

  it("throws a 404-tagged error when the lab result does not exist", async () => {
    prismaMock.labResult.findUnique.mockResolvedValue(null);

    await expect(analyzeLabResult("missing")).rejects.toMatchObject({
      message: "LabResult not found",
      statusCode: 404,
    });

    // The LLM should never have been called.
    expect(generateStructuredMock).not.toHaveBeenCalled();
    // History should not be queried either since we bailed before then.
    expect(prismaMock.labResult.findMany).not.toHaveBeenCalled();
  });
});

// ─── analyzeLabResult — happy path ────────────────────────────────────────

describe("analyzeLabResult — happy path with full LLM payload", () => {
  beforeEach(resetAllMocks);

  it("returns the fully-shaped LLM result and logs the call", async () => {
    prismaMock.labResult.findUnique.mockResolvedValue(makeLabResult());
    prismaMock.labResult.findMany.mockResolvedValue([
      makeHistoryRow(),
      makeHistoryRow({ value: "8.5", reportedAt: new Date("2026-03-10T08:00:00Z") }),
    ]);
    generateStructuredMock.mockResolvedValue(makeStructuredResponse());

    const out = await analyzeLabResult("lab-1");

    expect(out).toEqual({
      interpretation:
        "Hemoglobin remains below normal; consistent with iron-deficiency anemia.",
      trend: "improving",
      baselineComparison: "Up 0.5 g/dL from prior result.",
      recommendedActions: ["Continue iron supplementation", "Repeat CBC in 4 weeks"],
      urgency: "soon",
    });

    // logAICall was invoked once on success with token + latency fields.
    expect(logAICallMock).toHaveBeenCalledTimes(1);
    const logArg = logAICallMock.mock.calls[0][0];
    expect(logArg.feature).toBe("scribe");
    expect(logArg.model).toBe("sarvam-105b");
    expect(logArg.promptTokens).toBe(420);
    expect(logArg.completionTokens).toBe(120);
    expect(logArg.toolUsed).toBe("emit_lab_intel");
    expect(typeof logArg.latencyMs).toBe("number");
  });

  it("queries the patient's last 5 prior results for the same parameter", async () => {
    prismaMock.labResult.findUnique.mockResolvedValue(makeLabResult());
    prismaMock.labResult.findMany.mockResolvedValue([makeHistoryRow()]);

    await analyzeLabResult("lab-1");

    expect(prismaMock.labResult.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          parameter: "Hemoglobin",
          id: { not: "lab-1" },
          orderItem: { order: { patientId: "pat-1" } },
        }),
        orderBy: { reportedAt: "desc" },
        take: 5,
        select: {
          value: true,
          unit: true,
          flag: true,
          reportedAt: true,
        },
      }),
    );
  });

  it("includes chronic conditions and current medications in the prompt", async () => {
    prismaMock.labResult.findUnique.mockResolvedValue(makeLabResult());
    prismaMock.labResult.findMany.mockResolvedValue([]);

    await analyzeLabResult("lab-1");

    const callArgs = generateStructuredMock.mock.calls[0][0];
    expect(callArgs.userPrompt).toContain("Anemia");
    expect(callArgs.userPrompt).toContain("Iron Sulfate");
    expect(callArgs.userPrompt).toContain("Folic Acid");
    expect(callArgs.userPrompt).toContain("No prior results for this parameter.");
  });

  it("formats prior history rows with date / value / unit / flag", async () => {
    prismaMock.labResult.findUnique.mockResolvedValue(makeLabResult());
    prismaMock.labResult.findMany.mockResolvedValue([
      makeHistoryRow({ value: "9.5", unit: "g/dL", flag: "LOW", reportedAt: new Date("2026-04-15T08:00:00Z") }),
    ]);

    await analyzeLabResult("lab-1");

    const callArgs = generateStructuredMock.mock.calls[0][0];
    expect(callArgs.userPrompt).toContain("1. 2026-04-15: 9.5 g/dL [LOW]");
  });

  it("omits the unit gracefully when a history row has no unit", async () => {
    prismaMock.labResult.findUnique.mockResolvedValue(makeLabResult());
    prismaMock.labResult.findMany.mockResolvedValue([
      makeHistoryRow({ value: "9.5", unit: null, flag: "LOW", reportedAt: new Date("2026-04-15T08:00:00Z") }),
    ]);

    await analyzeLabResult("lab-1");

    const callArgs = generateStructuredMock.mock.calls[0][0];
    expect(callArgs.userPrompt).toContain("1. 2026-04-15: 9.5 [LOW]");
  });

  it("renders 'none documented' when chronic conditions list is empty", async () => {
    prismaMock.labResult.findUnique.mockResolvedValue(
      makeLabResult({
        orderItem: {
          order: {
            patient: {
              id: "pat-1",
              chronicConditions: [],
              prescriptions: [{ items: [{ medicineName: "Iron Sulfate" }] }],
            },
          },
        },
      }),
    );
    prismaMock.labResult.findMany.mockResolvedValue([]);

    await analyzeLabResult("lab-1");

    const callArgs = generateStructuredMock.mock.calls[0][0];
    expect(callArgs.userPrompt).toContain("Patient Chronic Conditions: none documented");
  });

  it("renders 'none documented' when the patient has no prescriptions at all", async () => {
    prismaMock.labResult.findUnique.mockResolvedValue(
      makeLabResult({
        orderItem: {
          order: {
            patient: {
              id: "pat-1",
              chronicConditions: [{ condition: "Anemia" }],
              prescriptions: [],
            },
          },
        },
      }),
    );
    prismaMock.labResult.findMany.mockResolvedValue([]);

    await analyzeLabResult("lab-1");

    const callArgs = generateStructuredMock.mock.calls[0][0];
    expect(callArgs.userPrompt).toContain("Patient Current Medications: none documented");
  });

  it("renders 'not provided' when normalRange is null", async () => {
    prismaMock.labResult.findUnique.mockResolvedValue(
      makeLabResult({ normalRange: null }),
    );
    prismaMock.labResult.findMany.mockResolvedValue([]);

    await analyzeLabResult("lab-1");

    const callArgs = generateStructuredMock.mock.calls[0][0];
    expect(callArgs.userPrompt).toContain("Normal Range: not provided");
  });

  it("omits the unit on the Current Value line when result.unit is falsy", async () => {
    prismaMock.labResult.findUnique.mockResolvedValue(
      makeLabResult({ unit: null }),
    );
    prismaMock.labResult.findMany.mockResolvedValue([]);

    await analyzeLabResult("lab-1");

    const callArgs = generateStructuredMock.mock.calls[0][0];
    // The line is "Current Value: 8.2" with no trailing unit.
    expect(callArgs.userPrompt).toMatch(/Current Value: 8\.2\n/);
  });
});

// ─── analyzeLabResult — enum coercion ─────────────────────────────────────

describe("analyzeLabResult — enum coercion fallbacks", () => {
  beforeEach(resetAllMocks);

  it("coerces an unknown trend value to 'unknown'", async () => {
    prismaMock.labResult.findUnique.mockResolvedValue(makeLabResult());
    prismaMock.labResult.findMany.mockResolvedValue([]);
    generateStructuredMock.mockResolvedValue(
      makeStructuredResponse({
        data: {
          interpretation: "x",
          trend: "skyrocketing",
          baselineComparison: "y",
          recommendedActions: ["a"],
          urgency: "soon",
        },
      }),
    );

    const out = await analyzeLabResult("lab-1");

    expect(out.trend).toBe("unknown");
  });

  it("coerces an unknown urgency value to 'routine'", async () => {
    prismaMock.labResult.findUnique.mockResolvedValue(makeLabResult());
    prismaMock.labResult.findMany.mockResolvedValue([]);
    generateStructuredMock.mockResolvedValue(
      makeStructuredResponse({
        data: {
          interpretation: "x",
          trend: "stable",
          baselineComparison: "y",
          recommendedActions: ["a"],
          urgency: "STAT-RED-ALERT",
        },
      }),
    );

    const out = await analyzeLabResult("lab-1");

    expect(out.urgency).toBe("routine");
  });

  it("preserves each valid trend value verbatim", async () => {
    prismaMock.labResult.findUnique.mockResolvedValue(makeLabResult());
    prismaMock.labResult.findMany.mockResolvedValue([]);

    for (const trend of ["improving", "stable", "worsening", "unknown"] as const) {
      generateStructuredMock.mockResolvedValueOnce(
        makeStructuredResponse({
          data: {
            interpretation: "x",
            trend,
            baselineComparison: "y",
            recommendedActions: [],
            urgency: "routine",
          },
        }),
      );
      const out = await analyzeLabResult("lab-1");
      expect(out.trend).toBe(trend);
    }
  });

  it("preserves each valid urgency value verbatim", async () => {
    prismaMock.labResult.findUnique.mockResolvedValue(makeLabResult());
    prismaMock.labResult.findMany.mockResolvedValue([]);

    for (const urgency of ["routine", "soon", "urgent"] as const) {
      generateStructuredMock.mockResolvedValueOnce(
        makeStructuredResponse({
          data: {
            interpretation: "x",
            trend: "stable",
            baselineComparison: "y",
            recommendedActions: [],
            urgency,
          },
        }),
      );
      const out = await analyzeLabResult("lab-1");
      expect(out.urgency).toBe(urgency);
    }
  });
});

// ─── analyzeLabResult — missing-field defaults ────────────────────────────

describe("analyzeLabResult — missing-field defaults", () => {
  beforeEach(resetAllMocks);

  it("defaults interpretation and baselineComparison to empty string when missing", async () => {
    prismaMock.labResult.findUnique.mockResolvedValue(makeLabResult());
    prismaMock.labResult.findMany.mockResolvedValue([]);
    generateStructuredMock.mockResolvedValue(
      makeStructuredResponse({
        data: {
          // interpretation + baselineComparison omitted
          trend: "stable",
          recommendedActions: ["a"],
          urgency: "routine",
        },
      }),
    );

    const out = await analyzeLabResult("lab-1");

    expect(out.interpretation).toBe("");
    expect(out.baselineComparison).toBe("");
  });

  it("defaults recommendedActions to empty array when missing or non-array", async () => {
    prismaMock.labResult.findUnique.mockResolvedValue(makeLabResult());
    prismaMock.labResult.findMany.mockResolvedValue([]);
    generateStructuredMock.mockResolvedValue(
      makeStructuredResponse({
        data: {
          interpretation: "x",
          trend: "stable",
          baselineComparison: "y",
          recommendedActions: "not an array",
          urgency: "routine",
        },
      }),
    );

    const out = await analyzeLabResult("lab-1");

    expect(out.recommendedActions).toEqual([]);
  });
});

// ─── analyzeLabResult — empty-data fallback ───────────────────────────────

describe("analyzeLabResult — empty-data fallback (data === null)", () => {
  beforeEach(resetAllMocks);

  it("returns the unavailable-stub with empty-history message when data is null and history is empty", async () => {
    prismaMock.labResult.findUnique.mockResolvedValue(makeLabResult());
    prismaMock.labResult.findMany.mockResolvedValue([]);
    generateStructuredMock.mockResolvedValue({
      data: null,
      promptTokens: 100,
      completionTokens: 0,
    });

    const out = await analyzeLabResult("lab-1");

    expect(out).toEqual({
      interpretation: "AI interpretation unavailable.",
      trend: "unknown",
      baselineComparison: "No prior results.",
      recommendedActions: [],
      urgency: "routine",
    });

    // logAICall still fires on the success path even when data is null.
    expect(logAICallMock).toHaveBeenCalledTimes(1);
  });

  it("returns the unavailable-stub with prior-results message when data is null but history is non-empty", async () => {
    prismaMock.labResult.findUnique.mockResolvedValue(makeLabResult());
    prismaMock.labResult.findMany.mockResolvedValue([makeHistoryRow()]);
    generateStructuredMock.mockResolvedValue({
      data: null,
      promptTokens: 100,
      completionTokens: 0,
    });

    const out = await analyzeLabResult("lab-1");

    expect(out.baselineComparison).toBe(
      "Prior results exist but no trajectory could be computed.",
    );
    expect(out.interpretation).toBe("AI interpretation unavailable.");
    expect(out.trend).toBe("unknown");
    expect(out.recommendedActions).toEqual([]);
    expect(out.urgency).toBe("routine");
  });
});

// ─── analyzeLabResult — LLM throws ────────────────────────────────────────

describe("analyzeLabResult — LLM error path", () => {
  beforeEach(resetAllMocks);

  it("re-throws the LLM error after logging the failure", async () => {
    prismaMock.labResult.findUnique.mockResolvedValue(makeLabResult());
    prismaMock.labResult.findMany.mockResolvedValue([]);
    const llmErr = new Error("sarvam timeout");
    generateStructuredMock.mockRejectedValue(llmErr);

    await expect(analyzeLabResult("lab-1")).rejects.toThrow("sarvam timeout");

    // The error-path logAICall should record promptTokens=0/completionTokens=0
    // and carry the error message.
    expect(logAICallMock).toHaveBeenCalledTimes(1);
    const logArg = logAICallMock.mock.calls[0][0];
    expect(logArg.feature).toBe("scribe");
    expect(logArg.model).toBe("sarvam-105b");
    expect(logArg.promptTokens).toBe(0);
    expect(logArg.completionTokens).toBe(0);
    expect(logArg.error).toBe("sarvam timeout");
    expect(typeof logArg.latencyMs).toBe("number");
  });

  it("stringifies non-Error rejections in the failure log", async () => {
    prismaMock.labResult.findUnique.mockResolvedValue(makeLabResult());
    prismaMock.labResult.findMany.mockResolvedValue([]);
    generateStructuredMock.mockRejectedValue("string-shaped-rejection");

    await expect(analyzeLabResult("lab-1")).rejects.toBe("string-shaped-rejection");

    expect(logAICallMock).toHaveBeenCalledTimes(1);
    const logArg = logAICallMock.mock.calls[0][0];
    expect(logArg.error).toBe("string-shaped-rejection");
  });
});
