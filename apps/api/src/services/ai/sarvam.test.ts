import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Mocks ─────────────────────────────────────────────────────────────────────

const { createMock, retrieveContextMock } = vi.hoisted(() => ({
  createMock: vi.fn(),
  retrieveContextMock: vi.fn(async () => ""),
}));

vi.mock("openai", () => {
  class OpenAI {
    chat = { completions: { create: createMock } };
    constructor(_opts: any) {}
  }
  return { default: OpenAI };
});

vi.mock("./rag", () => ({
  retrieveContext: retrieveContextMock,
}));

// Must import AFTER mocks are registered.
import {
  runTriageTurn,
  extractSymptomSummary,
  generateSOAPNote,
  generateText,
  AIServiceUnavailableError,
} from "./sarvam";

// Helpers to build OpenAI-like responses
function textResponse(content: string) {
  return {
    choices: [{ message: { content, tool_calls: undefined } }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  };
}

function toolResponse(name: string, args: any) {
  return {
    choices: [
      {
        message: {
          content: null,
          tool_calls: [{ type: "function", function: { name, arguments: JSON.stringify(args) } }],
        },
      },
    ],
    usage: { prompt_tokens: 12, completion_tokens: 7 },
  };
}

beforeEach(() => {
  createMock.mockReset();
  retrieveContextMock.mockReset();
  retrieveContextMock.mockResolvedValue("");
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── runTriageTurn ─────────────────────────────────────────────────────────────

describe("runTriageTurn", () => {
  it("returns plain text reply when no tool is invoked", async () => {
    createMock.mockResolvedValueOnce(textResponse("Hello, how can I help?"));
    const res = await runTriageTurn(
      [{ role: "user", content: "I have a mild cough" }],
      "en"
    );
    expect(res.isEmergency).toBe(false);
    expect(res.reply).toBe("Hello, how can I help?");
  });

  it("flags emergency when tool call is returned", async () => {
    createMock.mockResolvedValueOnce(
      toolResponse("flag_emergency", {
        reason: "Severe chest pain radiating to arm",
        urgency: "CALL_EMERGENCY",
      })
    );
    const res = await runTriageTurn(
      [{ role: "user", content: "I have crushing chest pain" }],
      "en"
    );
    expect(res.isEmergency).toBe(true);
    expect(res.emergencyReason).toMatch(/chest pain/i);
    expect(res.reply).toBe("");
  });

  it("uses Hindi system prompt for language='hi'", async () => {
    createMock.mockResolvedValueOnce(textResponse("नमस्ते"));
    await runTriageTurn([{ role: "user", content: "bukhar hai" }], "hi");
    const callArgs = createMock.mock.calls[0][0];
    const systemMsg = callArgs.messages.find((m: any) => m.role === "system");
    expect(systemMsg.content).toMatch(/Hindi/);
  });

  it("appends RAG context to system prompt when retrieveContext returns data", async () => {
    retrieveContextMock.mockResolvedValueOnce("[KNOWLEDGE BASE CONTEXT]\n1. [ICD10] A01");
    createMock.mockResolvedValueOnce(textResponse("ok"));
    await runTriageTurn([{ role: "user", content: "fever" }], "en");
    const sys = createMock.mock.calls[0][0].messages[0];
    expect(sys.content).toContain("KNOWLEDGE BASE CONTEXT");
  });

  it("falls back to graceful message on AIServiceUnavailableError after retries", async () => {
    const netErr = new Error("fetch failed");
    createMock.mockRejectedValue(netErr);
    const res = await runTriageTurn(
      [{ role: "user", content: "hi" }],
      "en"
    );
    expect(res.isEmergency).toBe(false);
    expect(res.reply).toMatch(/temporarily unavailable/i);
    // 3 attempts total (1 + 2 retries)
    expect(createMock).toHaveBeenCalledTimes(3);
  }, 20_000);

  it("retries on retryable 5xx error then succeeds", async () => {
    const httpErr: any = new Error("upstream 503");
    httpErr.status = 503;
    createMock
      .mockRejectedValueOnce(httpErr)
      .mockResolvedValueOnce(textResponse("recovered"));
    const res = await runTriageTurn(
      [{ role: "user", content: "hello" }],
      "en"
    );
    expect(res.reply).toBe("recovered");
    expect(createMock).toHaveBeenCalledTimes(2);
  }, 20_000);

  it("does NOT retry on non-retryable errors (e.g. 400)", async () => {
    // BUG NOTE: withRetry currently wraps ALL errors (retryable or not) into
    // AIServiceUnavailableError after the loop. That means a single 400 will
    // still surface as "service unavailable" to the caller. It does at least
    // short-circuit the retry loop, so the LLM is only invoked once.
    const err: any = new Error("bad request");
    err.status = 400;
    createMock.mockRejectedValueOnce(err);
    const res = await runTriageTurn(
      [{ role: "user", content: "hi" }],
      "en"
    );
    expect(res.reply).toMatch(/temporarily unavailable/i);
    expect(createMock).toHaveBeenCalledTimes(1);
  });
});

// ── extractSymptomSummary ─────────────────────────────────────────────────────

describe("extractSymptomSummary", () => {
  it("returns structured summary from tool call", async () => {
    createMock.mockResolvedValueOnce(
      toolResponse("structured_symptom_summary", {
        chiefComplaint: "Headache",
        duration: "2 days",
        severity: 6,
        associatedSymptoms: ["nausea"],
        specialties: [
          { specialty: "Neurologist", confidence: 0.8, reasoning: "headache + nausea" },
        ],
        overallConfidence: 0.75,
      })
    );
    const summary = await extractSymptomSummary([
      { role: "user", content: "I have a bad headache for 2 days with nausea" },
    ]);
    expect(summary.chiefComplaint).toBe("Headache");
    expect(summary.severity).toBe(6);
    expect(summary.associatedSymptoms).toEqual(["nausea"]);
    expect(summary.specialties).toHaveLength(1);
    expect(summary.specialties[0].specialty).toBe("Neurologist");
    expect(summary.confidence).toBe(0.75);
  });

  it("throws when LLM returns no tool call", async () => {
    createMock.mockResolvedValueOnce(textResponse("I cannot summarise"));
    await expect(
      extractSymptomSummary([{ role: "user", content: "headache" }])
    ).rejects.toThrow(/Failed to extract symptom summary/);
  });

  it("propagates AIServiceUnavailableError when retries exhaust", async () => {
    const err = new Error("ECONNRESET socket");
    createMock.mockRejectedValue(err);
    await expect(
      extractSymptomSummary([{ role: "user", content: "hi" }])
    ).rejects.toBeInstanceOf(AIServiceUnavailableError);
  }, 20_000);
});

// ── generateSOAPNote ──────────────────────────────────────────────────────────

describe("generateSOAPNote", () => {
  const transcript = [
    { speaker: "DOCTOR" as const, text: "What brings you here?", timestamp: "2026-01-01T10:00:00Z" },
    {
      speaker: "PATIENT" as const,
      text: "Chest pain on exertion for the past week. Started paracetamol myself.",
      timestamp: "2026-01-01T10:00:30Z",
    },
  ];

  const ctx = {
    allergies: [],
    currentMedications: [],
    chronicConditions: [],
    age: 45,
    gender: "M",
  };

  it("returns the parsed SOAP structure when no medications need verification", async () => {
    createMock.mockResolvedValueOnce(
      toolResponse("generate_soap_note", {
        subjective: { chiefComplaint: "Chest pain", hpi: "on exertion" },
        objective: {},
        assessment: { impression: "" }, // empty impression = nothing to verify
        plan: {},
      })
    );
    const soap = await generateSOAPNote(transcript, ctx);
    expect(soap.subjective.chiefComplaint).toBe("Chest pain");
    expect(soap.assessment.impression).toBe("");
    // No hallucination check triggered
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it("runs hallucination check and annotates medications not in transcript", async () => {
    createMock
      // 1. SOAP generation
      .mockResolvedValueOnce(
        toolResponse("generate_soap_note", {
          subjective: { chiefComplaint: "Chest pain", hpi: "on exertion" },
          objective: {},
          assessment: { impression: "Angina" },
          plan: {
            medications: [
              { name: "paracetamol", dose: "500mg", frequency: "TDS", duration: "3d" },
              { name: "morphine", dose: "10mg", frequency: "SOS", duration: "1d" },
            ],
          },
        })
      )
      // 2. Hallucination check
      .mockResolvedValueOnce(
        toolResponse("verify_items", {
          results: [
            { item: "Angina", found: true },
            { item: "paracetamol", found: true },
            { item: "morphine", found: false },
          ],
        })
      );
    const soap = await generateSOAPNote(transcript, ctx);
    const meds = soap.plan!.medications!;
    const paracetamol = meds.find((m) => m.name === "paracetamol")!;
    const morphine = meds.find((m) => m.name === "morphine")!;
    expect(paracetamol.notes ?? "").not.toContain("NOT CONFIRMED");
    expect(morphine.notes).toContain("NOT CONFIRMED IN TRANSCRIPT");
    expect(soap.assessment.impression).toBe("Angina");
  });

  it("annotates impression when diagnosis is not found in transcript", async () => {
    createMock
      .mockResolvedValueOnce(
        toolResponse("generate_soap_note", {
          subjective: { chiefComplaint: "headache", hpi: "2 days" },
          objective: {},
          assessment: { impression: "Meningitis" },
          plan: {},
        })
      )
      .mockResolvedValueOnce(
        toolResponse("verify_items", {
          results: [{ item: "Meningitis", found: false }],
        })
      );
    const soap = await generateSOAPNote(transcript, {
      allergies: [],
      currentMedications: [],
      chronicConditions: [],
    });
    expect(soap.assessment.impression).toContain("Meningitis");
    expect(soap.assessment.impression).toContain("NOT CONFIRMED IN TRANSCRIPT");
  });

  it("returns unmodified SOAP when hallucination check fails (non-fatal)", async () => {
    const netErr = new Error("ETIMEDOUT");
    createMock
      .mockResolvedValueOnce(
        toolResponse("generate_soap_note", {
          subjective: { chiefComplaint: "fever", hpi: "2 days" },
          objective: {},
          assessment: { impression: "Viral fever" },
          plan: {
            medications: [{ name: "paracetamol", dose: "500mg", frequency: "TDS", duration: "3d" }],
          },
        })
      )
      // Hallucination check: all 3 retries fail
      .mockRejectedValue(netErr);
    const soap = await generateSOAPNote(transcript, ctx);
    expect(soap.plan!.medications![0].notes ?? "").not.toContain("NOT CONFIRMED");
    expect(soap.assessment.impression).toBe("Viral fever");
  }, 20_000);

  it("throws when SOAP generation returns no tool call", async () => {
    createMock.mockResolvedValueOnce(textResponse("unable"));
    await expect(generateSOAPNote(transcript, ctx)).rejects.toThrow(
      /Failed to generate SOAP note/
    );
  });
});

// ── generateText ──────────────────────────────────────────────────────────────

describe("generateText", () => {
  it("returns content from the chat completion", async () => {
    createMock.mockResolvedValueOnce(textResponse("synthesised summary"));
    const out = await generateText({ systemPrompt: "sys", userPrompt: "q" });
    expect(out).toBe("synthesised summary");
  });

  it("returns empty string on transport failure", async () => {
    createMock.mockRejectedValue(new Error("ECONNRESET"));
    const out = await generateText({ systemPrompt: "s", userPrompt: "u" });
    expect(out).toBe("");
  }, 20_000);
});

// ── AIServiceUnavailableError ─────────────────────────────────────────────────

describe("AIServiceUnavailableError", () => {
  it("carries status 503 and a descriptive message", () => {
    const err = new AIServiceUnavailableError();
    expect(err.statusCode).toBe(503);
    expect(err.message).toMatch(/temporarily unavailable/i);
    expect(err.name).toBe("AIServiceUnavailableError");
  });
});
