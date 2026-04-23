import OpenAI from "openai";
import type { SOAPNote, SpecialtySuggestion, SymptomCapture, TranscriptEntry } from "@medcore/shared";
import { PROMPTS } from "./prompts";
import { retrieveContext } from "./rag";

// Sarvam AI — India-region servers, DPDP-compliant
const sarvam = new OpenAI({
  apiKey: process.env.SARVAM_API_KEY ?? "",
  baseURL: "https://api.sarvam.ai/v1",
});

const MODEL = "sarvam-105b";

// ── Custom error ──────────────────────────────────────────────────────────────

/**
 * Thrown when the Sarvam AI backend is unreachable after exhausting all retry
 * attempts. Always carries HTTP status 503.
 */
export class AIServiceUnavailableError extends Error {
  readonly statusCode = 503;
  constructor() {
    super("AI service temporarily unavailable");
    this.name = "AIServiceUnavailableError";
  }
}

// ── Observability ─────────────────────────────────────────────────────────────

function logAICall(opts: {
  feature: "triage" | "scribe" | "drug-safety" | "hallucination-check";
  model: string;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  toolUsed?: string;
  error?: string;
}) {
  console.log(JSON.stringify({ level: "info", event: "ai_call", ...opts, ts: new Date().toISOString() }));
}

// ── Retry / fallback ──────────────────────────────────────────────────────────

function isRetryableError(err: unknown): boolean {
  if (err instanceof Error) {
    if (
      err.message.includes("ECONNRESET") ||
      err.message.includes("ENOTFOUND") ||
      err.message.includes("ETIMEDOUT") ||
      err.message.includes("socket hang up") ||
      err.message.includes("fetch failed")
    ) {
      return true;
    }
    const asAny = err as any;
    if (typeof asAny.status === "number" && asAny.status >= 500) {
      return true;
    }
  }
  return false;
}

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  const MAX_ATTEMPTS = 3; // 1 initial + 2 retries
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (!isRetryableError(err) || attempt === MAX_ATTEMPTS - 1) {
        break;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 1000));
    }
  }
  throw new AIServiceUnavailableError();
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function getFnCall(response: OpenAI.Chat.Completions.ChatCompletion) {
  const raw = response.choices[0]?.message?.tool_calls?.[0];
  return raw?.type === "function" ? raw : undefined;
}

// ── runTriageTurn ─────────────────────────────────────────────────────────────

/**
 * Execute one conversational turn of the AI triage assistant.
 * Calls the `flag_emergency` tool automatically if the patient describes a
 * red-flag symptom; otherwise returns a plain-text reply.
 *
 * @param messages Full conversation history (user + assistant turns).
 * @param language ISO language code — pass `"hi"` to switch the system prompt to Hindi.
 */
export async function runTriageTurn(
  messages: { role: "user" | "assistant"; content: string }[],
  language: string
): Promise<{ reply: string; isEmergency: boolean; emergencyReason?: string }> {
  const lastUserMsg = messages.at(-1)?.content ?? "";
  const ragContext = await retrieveContext(lastUserMsg, 3, ["ICD10", "MEDICINE"]).catch(() => "");

  const baseSystemPrompt =
    language === "hi"
      ? PROMPTS.TRIAGE_SYSTEM + PROMPTS.TRIAGE_SYSTEM_HINDI_SUFFIX
      : PROMPTS.TRIAGE_SYSTEM;
  const systemPrompt = baseSystemPrompt + (ragContext ? "\n\n" + ragContext : "");

  const t0 = Date.now();
  let response: OpenAI.Chat.Completions.ChatCompletion | undefined;

  try {
    response = await withRetry(() =>
      sarvam.chat.completions.create({
        model: MODEL,
        max_tokens: 1024,
        tools: [
          {
            type: "function",
            function: {
              name: "flag_emergency",
              description:
                "Call this tool IMMEDIATELY if the patient describes any emergency/red-flag symptom. Do not continue the conversation — use this tool.",
              parameters: {
                type: "object",
                properties: {
                  reason: { type: "string", description: "The specific emergency symptom detected" },
                  urgency: { type: "string", enum: ["CALL_EMERGENCY", "GO_TO_ER_NOW"] },
                },
                required: ["reason", "urgency"],
              },
            },
          },
        ],
        tool_choice: "auto",
        messages: [{ role: "system", content: systemPrompt }, ...messages],
      })
    );
  } catch (err) {
    logAICall({
      feature: "triage",
      model: MODEL,
      promptTokens: 0,
      completionTokens: 0,
      latencyMs: Date.now() - t0,
      error: err instanceof Error ? err.message : String(err),
    });
    if (err instanceof AIServiceUnavailableError) {
      return {
        reply:
          "I'm sorry, the AI assistant is temporarily unavailable. Please call our helpline or visit the OPD directly.",
        isEmergency: false,
      };
    }
    throw err;
  }

  const toolCall = getFnCall(response);
  logAICall({
    feature: "triage",
    model: MODEL,
    promptTokens: response.usage?.prompt_tokens ?? 0,
    completionTokens: response.usage?.completion_tokens ?? 0,
    latencyMs: Date.now() - t0,
    toolUsed: toolCall?.function.name,
  });

  if (toolCall?.function.name === "flag_emergency") {
    const input = JSON.parse(toolCall.function.arguments) as { reason: string; urgency: string };
    return { reply: "", isEmergency: true, emergencyReason: input.reason };
  }

  const textContent = response.choices[0]?.message?.content ?? "";
  return { reply: textContent, isEmergency: false };
}

// ── extractSymptomSummary ─────────────────────────────────────────────────────

/**
 * Analyse a completed triage conversation and produce a structured symptom
 * summary together with specialty recommendations (top 3) and an overall
 * confidence score (0–1).
 *
 * @param messages The full triage conversation history.
 */
export async function extractSymptomSummary(
  messages: { role: "user" | "assistant"; content: string }[]
): Promise<SymptomCapture & { specialties: SpecialtySuggestion[]; confidence: number }> {
  const t0 = Date.now();
  let response: OpenAI.Chat.Completions.ChatCompletion | undefined;

  try {
    response = await withRetry(() =>
      sarvam.chat.completions.create({
        model: MODEL,
        max_tokens: 2048,
        tools: [
          {
            type: "function",
            function: {
              name: "structured_symptom_summary",
              description:
                "Extract a structured symptom summary and specialty recommendations from the conversation",
              parameters: {
                type: "object",
                properties: {
                  chiefComplaint: { type: "string" },
                  onset: { type: "string" },
                  duration: { type: "string" },
                  severity: { type: "number", minimum: 1, maximum: 10 },
                  location: { type: "string" },
                  associatedSymptoms: { type: "array", items: { type: "string" } },
                  relevantHistory: { type: "string" },
                  currentMedications: { type: "array", items: { type: "string" } },
                  knownAllergies: { type: "array", items: { type: "string" } },
                  age: { type: "number" },
                  gender: { type: "string" },
                  specialties: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        specialty: { type: "string" },
                        subSpecialty: { type: "string" },
                        confidence: { type: "number", minimum: 0, maximum: 1 },
                        reasoning: { type: "string" },
                      },
                      required: ["specialty", "confidence", "reasoning"],
                    },
                  },
                  overallConfidence: { type: "number", minimum: 0, maximum: 1 },
                },
                required: ["chiefComplaint", "specialties", "overallConfidence"],
              },
            },
          },
        ],
        tool_choice: { type: "function", function: { name: "structured_symptom_summary" } },
        messages: [
          { role: "system", content: PROMPTS.TRIAGE_SYSTEM },
          ...messages,
          {
            role: "user",
            content: "Now produce a structured summary of the symptoms and recommend the top 3 specialties.",
          },
        ],
      })
    );
  } catch (err) {
    logAICall({
      feature: "triage",
      model: MODEL,
      promptTokens: 0,
      completionTokens: 0,
      latencyMs: Date.now() - t0,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }

  const toolCall = getFnCall(response);
  logAICall({
    feature: "triage",
    model: MODEL,
    promptTokens: response.usage?.prompt_tokens ?? 0,
    completionTokens: response.usage?.completion_tokens ?? 0,
    latencyMs: Date.now() - t0,
    toolUsed: toolCall?.function.name,
  });

  if (!toolCall) {
    throw new Error("Failed to extract symptom summary");
  }

  const input = JSON.parse(toolCall.function.arguments) as any;
  return {
    chiefComplaint: input.chiefComplaint,
    onset: input.onset,
    duration: input.duration,
    severity: input.severity,
    location: input.location,
    associatedSymptoms: input.associatedSymptoms,
    relevantHistory: input.relevantHistory,
    currentMedications: input.currentMedications,
    knownAllergies: input.knownAllergies,
    age: input.age,
    gender: input.gender,
    specialties: input.specialties,
    confidence: input.overallConfidence,
  };
}

// ── validateSOAPHallucinations (internal) ─────────────────────────────────────

async function validateSOAPHallucinations(soap: SOAPNote, transcriptText: string): Promise<SOAPNote> {
  const itemsToVerify: string[] = [
    ...(soap.plan?.medications?.map((m) => m.name) ?? []),
    ...(soap.assessment?.impression ? [soap.assessment.impression] : []),
  ];

  if (itemsToVerify.length === 0) {
    return soap;
  }

  const t0 = Date.now();
  let verifyResponse: OpenAI.Chat.Completions.ChatCompletion | undefined;

  try {
    verifyResponse = await withRetry(() =>
      sarvam.chat.completions.create({
        model: MODEL,
        max_tokens: 512,
        tools: [
          {
            type: "function",
            function: {
              name: "verify_items",
              description:
                "For each item, report whether it appears verbatim or as a clear paraphrase in the transcript",
              parameters: {
                type: "object",
                properties: {
                  results: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        item: { type: "string" },
                        found: { type: "boolean" },
                      },
                      required: ["item", "found"],
                    },
                  },
                },
                required: ["results"],
              },
            },
          },
        ],
        tool_choice: { type: "function", function: { name: "verify_items" } },
        messages: [
          {
            role: "user",
            content: `Transcript:\n${transcriptText}\n\nFor each item below, answer found:true only if it appears verbatim or is a clear paraphrase of what was said in the transcript.\nItems: ${JSON.stringify(itemsToVerify)}`,
          },
        ],
      })
    );
  } catch (err) {
    logAICall({
      feature: "hallucination-check",
      model: MODEL,
      promptTokens: 0,
      completionTokens: 0,
      latencyMs: Date.now() - t0,
      error: err instanceof Error ? err.message : String(err),
    });
    // Non-fatal: return original soap on failure
    return soap;
  }

  const toolCall = getFnCall(verifyResponse);
  logAICall({
    feature: "hallucination-check",
    model: MODEL,
    promptTokens: verifyResponse.usage?.prompt_tokens ?? 0,
    completionTokens: verifyResponse.usage?.completion_tokens ?? 0,
    latencyMs: Date.now() - t0,
    toolUsed: toolCall?.function.name,
  });

  if (!toolCall) return soap;

  const { results } = JSON.parse(toolCall.function.arguments) as {
    results: { item: string; found: boolean }[];
  };

  for (const { item, found } of results) {
    if (found) continue;

    const diagnosisImpression = soap.assessment?.impression;
    if (diagnosisImpression && item === diagnosisImpression) {
      soap = {
        ...soap,
        assessment: {
          ...soap.assessment,
          impression: `${soap.assessment!.impression}\n[NOT CONFIRMED IN TRANSCRIPT — please verify]`,
        },
      };
    } else if (soap.plan?.medications) {
      const medIndex = soap.plan.medications.findIndex((m) => m.name === item);
      if (medIndex !== -1) {
        const updatedMedications = soap.plan.medications.map((med, idx) =>
          idx === medIndex
            ? { ...med, notes: `${med.notes ?? ""}${med.notes ? " " : ""}[NOT CONFIRMED IN TRANSCRIPT]` }
            : med
        );
        soap = {
          ...soap,
          plan: {
            ...soap.plan,
            medications: updatedMedications,
          },
        };
      }
    }
  }

  return soap;
}

// ── generateSOAPNote ──────────────────────────────────────────────────────────

/**
 * Generate a structured SOAP note from a consultation transcript.
 * Runs a post-generation hallucination check that annotates any medications
 * or diagnoses not traceable to the transcript with a visible warning.
 *
 * @param transcript Ordered list of speaker-attributed transcript entries.
 * @param patientContext Known patient data used to enrich the prompt context.
 */
export async function generateSOAPNote(
  transcript: TranscriptEntry[],
  patientContext: {
    allergies: string[];
    currentMedications: string[];
    chronicConditions: string[];
    age?: number;
    gender?: string;
  }
): Promise<SOAPNote> {
  const transcriptText = transcript.map((e) => `[${e.speaker}]: ${e.text}`).join("\n");

  const contextText = `
Patient Context:
- Age: ${patientContext.age ?? "unknown"}
- Gender: ${patientContext.gender ?? "unknown"}
- Known Allergies: ${patientContext.allergies.join(", ") || "none"}
- Current Medications: ${patientContext.currentMedications.join(", ") || "none"}
- Chronic Conditions: ${patientContext.chronicConditions.join(", ") || "none"}
`;

  const ragContext = await retrieveContext(transcriptText, 4).catch(() => "");

  const t0 = Date.now();
  let response: OpenAI.Chat.Completions.ChatCompletion | undefined;

  try {
    response = await withRetry(() =>
      sarvam.chat.completions.create({
        model: MODEL,
        max_tokens: 4096,
        tools: [
          {
            type: "function",
            function: {
              name: "generate_soap_note",
              description: "Generate a structured SOAP note from the consultation transcript",
              parameters: {
                type: "object",
                properties: {
                  subjective: {
                    type: "object",
                    properties: {
                      chiefComplaint: { type: "string" },
                      hpi: { type: "string" },
                      pastMedicalHistory: { type: "string" },
                      medications: { type: "array", items: { type: "string" } },
                      allergies: { type: "array", items: { type: "string" } },
                      socialHistory: { type: "string" },
                      familyHistory: { type: "string" },
                      confidence: {
                        type: "number",
                        minimum: 0,
                        maximum: 1,
                        description: "Confidence 0-1 that this section is well-supported by the transcript",
                      },
                      evidenceSpan: {
                        type: "string",
                        description: "Verbatim quote from transcript most strongly supporting this section",
                      },
                    },
                    required: ["chiefComplaint", "hpi"],
                  },
                  objective: {
                    type: "object",
                    properties: {
                      vitals: { type: "string" },
                      examinationFindings: { type: "string" },
                      confidence: {
                        type: "number",
                        minimum: 0,
                        maximum: 1,
                        description: "Confidence 0-1 that this section is well-supported by the transcript",
                      },
                      evidenceSpan: {
                        type: "string",
                        description: "Verbatim quote from transcript most strongly supporting this section",
                      },
                    },
                  },
                  assessment: {
                    type: "object",
                    properties: {
                      impression: { type: "string" },
                      icd10Codes: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: {
                            code: { type: "string" },
                            description: { type: "string" },
                            confidence: { type: "number" },
                            evidenceSpan: { type: "string" },
                          },
                          required: ["code", "description", "confidence"],
                        },
                      },
                      confidence: {
                        type: "number",
                        minimum: 0,
                        maximum: 1,
                        description: "Confidence 0-1 that this section is well-supported by the transcript",
                      },
                      evidenceSpan: {
                        type: "string",
                        description: "Verbatim quote from transcript most strongly supporting this section",
                      },
                    },
                    required: ["impression"],
                  },
                  plan: {
                    type: "object",
                    properties: {
                      medications: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: {
                            name: { type: "string" },
                            dose: { type: "string" },
                            frequency: { type: "string" },
                            duration: { type: "string" },
                            notes: { type: "string" },
                          },
                          required: ["name", "dose", "frequency", "duration"],
                        },
                      },
                      investigations: { type: "array", items: { type: "string" } },
                      procedures: { type: "array", items: { type: "string" } },
                      referrals: { type: "array", items: { type: "string" } },
                      followUpTimeline: { type: "string" },
                      patientInstructions: { type: "string" },
                      cptCodes: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: {
                            code: { type: "string" },
                            description: { type: "string" },
                            justification: { type: "string" },
                          },
                          required: ["code", "description", "justification"],
                        },
                      },
                      confidence: {
                        type: "number",
                        minimum: 0,
                        maximum: 1,
                        description: "Confidence 0-1 that this section is well-supported by the transcript",
                      },
                      evidenceSpan: {
                        type: "string",
                        description: "Verbatim quote from transcript most strongly supporting this section",
                      },
                    },
                  },
                },
                required: ["subjective", "objective", "assessment", "plan"],
              },
            },
          },
        ],
        tool_choice: { type: "function", function: { name: "generate_soap_note" } },
        messages: [
          { role: "system", content: PROMPTS.SCRIBE_SYSTEM },
          {
            role: "user",
            content: `${contextText}${ragContext ? "\n\n" + ragContext + "\n" : ""}\n\nConsultation Transcript:\n${transcriptText}\n\nGenerate the SOAP note. Only include information explicitly stated in the transcript.`,
          },
        ],
      })
    );
  } catch (err) {
    logAICall({
      feature: "scribe",
      model: MODEL,
      promptTokens: 0,
      completionTokens: 0,
      latencyMs: Date.now() - t0,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }

  const toolCall = getFnCall(response);
  logAICall({
    feature: "scribe",
    model: MODEL,
    promptTokens: response.usage?.prompt_tokens ?? 0,
    completionTokens: response.usage?.completion_tokens ?? 0,
    latencyMs: Date.now() - t0,
    toolUsed: toolCall?.function.name,
  });

  if (!toolCall) {
    throw new Error("Failed to generate SOAP note");
  }

  const raw = JSON.parse(toolCall.function.arguments) as SOAPNote;
  return validateSOAPHallucinations(raw, transcriptText);
}
