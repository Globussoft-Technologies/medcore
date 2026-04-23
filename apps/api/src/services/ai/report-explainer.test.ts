import { describe, it, expect, vi, beforeEach } from "vitest";

const { createMock } = vi.hoisted(() => ({ createMock: vi.fn() }));

vi.mock("openai", () => {
  class OpenAI {
    chat = { completions: { create: createMock } };
    constructor(_opts: any) {}
  }
  return { default: OpenAI };
});

import { explainLabReport } from "./report-explainer";

function toolReply(name: string, args: object) {
  return {
    choices: [
      {
        message: {
          content: null,
          tool_calls: [{ type: "function", function: { name, arguments: JSON.stringify(args) } }],
        },
      },
    ],
  };
}

beforeEach(() => {
  createMock.mockReset();
});

describe("explainLabReport", () => {
  it("returns parsed summary and flagged values from tool call", async () => {
    createMock.mockResolvedValueOnce(
      toolReply("explain_report", {
        summary:
          "Your haemoglobin is slightly low... Please discuss these results with your doctor.",
        flaggedValues: [
          {
            parameter: "Haemoglobin",
            value: "10.5",
            flag: "LOW",
            plainLanguage: "Your red blood cells are below the normal range.",
          },
        ],
      })
    );
    const res = await explainLabReport({
      labResults: [
        { parameter: "Haemoglobin", value: "10.5", unit: "g/dL", normalRange: "12-16", flag: "LOW" },
      ],
      patientAge: 30,
      patientGender: "F",
      language: "en",
    });
    expect(res.explanation).toMatch(/Please discuss/);
    expect(res.flaggedValues).toHaveLength(1);
    expect(res.flaggedValues[0].parameter).toBe("Haemoglobin");
  });

  it("throws when model returns no structured tool call", async () => {
    createMock.mockResolvedValueOnce({
      choices: [{ message: { content: "plain text only", tool_calls: undefined } }],
    });
    await expect(
      explainLabReport({
        labResults: [{ parameter: "HB", value: "12", flag: "NORMAL" }],
        language: "en",
      })
    ).rejects.toThrow(/structured report/i);
  });

  it("sends Hindi indicator to the user prompt when language='hi'", async () => {
    createMock.mockResolvedValueOnce(
      toolReply("explain_report", { summary: "Please discuss these results with your doctor.", flaggedValues: [] })
    );
    await explainLabReport({
      labResults: [{ parameter: "FBS", value: "180", unit: "mg/dL", flag: "HIGH" }],
      language: "hi",
    });
    const userMsg = createMock.mock.calls[0][0].messages[1].content;
    expect(userMsg).toContain("Hindi");
  });

  it("includes patient age and gender in prompt when provided", async () => {
    createMock.mockResolvedValueOnce(
      toolReply("explain_report", { summary: "Please discuss these results with your doctor.", flaggedValues: [] })
    );
    await explainLabReport({
      labResults: [{ parameter: "TSH", value: "5.5", flag: "HIGH" }],
      patientAge: 45,
      patientGender: "M",
      language: "en",
    });
    const userMsg = createMock.mock.calls[0][0].messages[1].content;
    expect(userMsg).toContain("Age: 45");
    expect(userMsg).toContain("Gender: M");
  });

  it("defaults flaggedValues to empty array when omitted by model", async () => {
    createMock.mockResolvedValueOnce(
      toolReply("explain_report", {
        summary: "Everything looks normal. Please discuss these results with your doctor.",
      })
    );
    const res = await explainLabReport({
      labResults: [{ parameter: "HB", value: "13", flag: "NORMAL" }],
      language: "en",
    });
    expect(res.flaggedValues).toEqual([]);
  });
});
