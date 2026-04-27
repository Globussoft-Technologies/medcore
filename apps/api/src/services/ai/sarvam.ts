import OpenAI from "openai";
import type { SOAPNote, SpecialtySuggestion, SymptomCapture, TranscriptEntry } from "@medcore/shared";
import { PROMPTS, type PromptKey } from "./prompts";
import { retrieveContext } from "./rag";
import { sanitizeUserInput } from "./prompt-safety";
import { getChatClient } from "./model-router";
import { getActivePrompt } from "./prompt-registry";
import { logAICall } from "./sarvam-logging";
import { withSpan } from "./tracing";

// GAP-P5: the chat client comes from the multi-provider router so flipping
// `AI_PROVIDER` env var swaps backends fleet-wide without touching call sites.
// Default remains Sarvam (India-region, DPDP-compliant). Tests that mock the
// `openai` module still work because the router also constructs an `OpenAI`.
const sarvam = getChatClient();

const MODEL = "sarvam-105b";

// Re-export so existing callers that `import { logAICall } from ".../sarvam"`
// keep working after the logging split into sarvam-logging.ts.
export { logAICall };

/**
 * Resolve a prompt from the registry, falling back to the compiled constant
 * if the registry is empty or errors out. Centralised here so every prompt
 * read in this file has identical fallback semantics.
 */
async function resolvePrompt(key: PromptKey): Promise<string> {
  try {
    const value = await getActivePrompt(key);
    // getActivePrompt itself falls back to PROMPTS[key] when there is no DB
    // row, so a non-empty string here is always safe to return.
    if (value && value.length > 0) return value;
  } catch {
    // Belt-and-braces: the registry already catches its own DB errors, but
    // if something slips through (e.g. unexpected Prisma exception) we still
    // want the LLM call to succeed.
  }
  return PROMPTS[key];
}

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
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const retryable = isRetryableError(err);
      if (!retryable) {
        // Non-retryable (e.g. 400 Bad Request, 401 Unauthorized, validation
        // errors): surface the ORIGINAL error with its status code intact so
        // downstream error handlers can map it correctly.
        throw err;
      }
      if (attempt === MAX_ATTEMPTS - 1) {
        // Retries exhausted on a genuinely retryable error — degrade to 503.
        throw new AIServiceUnavailableError();
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 1000));
    }
  }
  // Unreachable — loop either returns or throws. Kept for TS exhaustiveness.
  throw new AIServiceUnavailableError();
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function getFnCall(response: OpenAI.Chat.Completions.ChatCompletion) {
  const raw = response.choices[0]?.message?.tool_calls?.[0];
  return raw?.type === "function" ? raw : undefined;
}

// ── generateText ──────────────────────────────────────────────────────────────

/**
 * Generic text-generation helper used by chart search synthesis and similar
 * open-ended LLM tasks that don't need function-calling. Returns plain text.
 * Falls back to an empty string on transport failure so callers can degrade
 * gracefully (e.g. still return raw chunks when the LLM is offline).
 */
export async function generateText(opts: {
  systemPrompt: string;
  userPrompt: string;
  maxTokens?: number;
  temperature?: number;
}): Promise<string> {
  const t0 = Date.now();
  try {
    const response = await withSpan(
      "ai.generateText",
      { "ai.feature": "scribe", "ai.model": MODEL },
      () =>
        withRetry(() =>
          sarvam.chat.completions.create({
            model: MODEL,
            max_tokens: opts.maxTokens ?? 1024,
            temperature: opts.temperature ?? 0.2,
            messages: [
              { role: "system", content: opts.systemPrompt },
              { role: "user", content: opts.userPrompt },
            ],
          })
        )
    );
    logAICall({
      feature: "scribe",
      model: MODEL,
      promptTokens: response.usage?.prompt_tokens ?? 0,
      completionTokens: response.usage?.completion_tokens ?? 0,
      latencyMs: Date.now() - t0,
    });
    return response.choices[0]?.message?.content ?? "";
  } catch (err) {
    logAICall({
      feature: "scribe",
      model: MODEL,
      promptTokens: 0,
      completionTokens: 0,
      latencyMs: Date.now() - t0,
      error: err instanceof Error ? err.message : String(err),
    });
    return "";
  }
}

// ── translateText ─────────────────────────────────────────────────────────────

/**
 * BCP-47 → human-readable language name. Used to build a tightly-scoped
 * translate prompt for {@link translateText}. Only the 8 codes MedCore supports
 * end-to-end are mapped; unknown codes fall through to "English" so callers
 * never get an opaque code echoed back to a patient.
 */
const LANGUAGE_NAMES: Record<string, string> = {
  en: "English",
  hi: "Hindi",
  ta: "Tamil",
  te: "Telugu",
  bn: "Bengali",
  mr: "Marathi",
  kn: "Kannada",
  ml: "Malayalam",
};

/**
 * Translate a clinical patient-summary into the patient's preferred language.
 *
 * Used by the AI Scribe sign-off path (PRD §4.5.5) to deliver the post-visit
 * notification body in `Patient.preferredLanguage`. Medication names, dosages
 * and units are preserved verbatim so the translated text still maps
 * unambiguously back to what was prescribed.
 *
 * Wraps the underlying Sarvam call with {@link withRetry}; on exhausted retries
 * (or any other transport failure) the helper returns the ORIGINAL English
 * text and emits a warning so the caller can dispatch the notification rather
 * than silently dropping it. Patients are better served by an English message
 * than by no message at all.
 *
 * @param text       The English patient-summary body.
 * @param targetLang BCP-47 code (`hi`, `ta`, `te`, `bn`, `mr`, `kn`, `ml`).
 *                   `en`, missing or unknown codes are no-ops and return `text`
 *                   unchanged without making an LLM call.
 */
export async function translateText(text: string, targetLang: string): Promise<string> {
  // Fast-path: nothing to translate, or target language is English / unknown.
  if (!text || !targetLang || targetLang === "en") return text;
  const languageName = LANGUAGE_NAMES[targetLang];
  if (!languageName || languageName === "English") return text;

  const systemPrompt =
    `Translate the following clinical patient-summary text to ${languageName}. ` +
    `Preserve medication names, dosages, and units verbatim. ` +
    `Keep medical terms accurate. ` +
    `Output ONLY the translated text, no preamble.`;

  const t0 = Date.now();
  try {
    const response = await withSpan(
      "ai.translateText",
      { "ai.feature": "scribe", "ai.model": MODEL, "ai.target_lang": targetLang },
      () =>
        withRetry(() =>
          sarvam.chat.completions.create({
            model: MODEL,
            max_tokens: 1024,
            temperature: 0.1,
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: text },
            ],
          })
        )
    );
    logAICall({
      feature: "scribe",
      model: MODEL,
      promptTokens: response.usage?.prompt_tokens ?? 0,
      completionTokens: response.usage?.completion_tokens ?? 0,
      latencyMs: Date.now() - t0,
    });
    const translated = response.choices[0]?.message?.content?.trim();
    return translated && translated.length > 0 ? translated : text;
  } catch (err) {
    // Fall back to English: the patient still gets the summary, just not in
    // their preferred language. Better than dropping the notification entirely.
    logAICall({
      feature: "scribe",
      model: MODEL,
      promptTokens: 0,
      completionTokens: 0,
      latencyMs: Date.now() - t0,
      error: err instanceof Error ? err.message : String(err),
    });
    console.warn(
      `[translateText] Sarvam translate failed for targetLang=${targetLang}; falling back to English. Reason:`,
      err instanceof Error ? err.message : err
    );
    return text;
  }
}

// ── generateStructured ────────────────────────────────────────────────────────

/**
 * Tool-calling helper that forces the model to emit structured JSON via a named
 * function tool. Returns the parsed tool arguments (typed as T) plus token usage.
 * Throws on transport failure — callers that want graceful degradation should
 * wrap in try/catch.
 *
 * Intended for small, repetitive structured tasks (reranker batches, verification
 * checks) where writing tool-call boilerplate inline would balloon the service.
 */
export async function generateStructured<T>(opts: {
  systemPrompt: string;
  userPrompt: string;
  toolName: string;
  toolDescription: string;
  parameters: Record<string, unknown>;
  maxTokens?: number;
  temperature?: number;
}): Promise<{
  data: T | null;
  promptTokens: number;
  completionTokens: number;
}> {
  const response = await withSpan(
    "ai.generateStructured",
    { "ai.feature": "scribe", "ai.model": MODEL, "ai.tool": opts.toolName },
    () =>
      withRetry(() =>
        sarvam.chat.completions.create({
          model: MODEL,
          max_tokens: opts.maxTokens ?? 1024,
          temperature: opts.temperature ?? 0,
          tools: [
            {
              type: "function",
              function: {
                name: opts.toolName,
                description: opts.toolDescription,
                parameters: opts.parameters as any,
              },
            },
          ],
          tool_choice: { type: "function", function: { name: opts.toolName } },
          messages: [
            { role: "system", content: opts.systemPrompt },
            { role: "user", content: opts.userPrompt },
          ],
        })
      )
  );

  const toolCall = getFnCall(response);
  const data = toolCall ? (JSON.parse(toolCall.function.arguments) as T) : null;
  return {
    data,
    promptTokens: response.usage?.prompt_tokens ?? 0,
    completionTokens: response.usage?.completion_tokens ?? 0,
  };
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
  // security(2026-04-23-low): F-INJ-1 — sanitize every user-role message so
  // injection markers (e.g. "ignore previous instructions") are neutralised
  // before they hit the model. Assistant messages come from our own prior
  // responses and are left as-is. Latest user turn is also sanitized for RAG
  // retrieval so the vector query can't be steered either.
  const sanitizedMessages = messages.map((m) =>
    m.role === "user" ? { ...m, content: sanitizeUserInput(m.content) } : m
  );
  const lastUserMsg = sanitizedMessages.at(-1)?.content ?? "";
  const ragContext = await retrieveContext(lastUserMsg, 3, ["ICD10", "MEDICINE"]).catch(() => "");

  // GAP-P3: read prompt + Hindi suffix from the versioned registry instead
  // of compiled constants. resolvePrompt transparently falls back to the
  // static PROMPTS object when the DB is empty or errors out, so this swap
  // is safe to roll out before any DB row is seeded.
  const [triageSystem, hindiSuffix] = await Promise.all([
    resolvePrompt("TRIAGE_SYSTEM"),
    language === "hi" ? resolvePrompt("TRIAGE_SYSTEM_HINDI_SUFFIX") : Promise.resolve(""),
  ]);
  const baseSystemPrompt = language === "hi" ? triageSystem + hindiSuffix : triageSystem;
  const systemPrompt = baseSystemPrompt + (ragContext ? "\n\n" + ragContext : "");

  const t0 = Date.now();
  let response: OpenAI.Chat.Completions.ChatCompletion | undefined;

  try {
    response = await withSpan(
      "ai.runTriageTurn",
      { "ai.feature": "triage", "ai.model": MODEL, "ai.language": language },
      () =>
        withRetry(() =>
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
            messages: [{ role: "system", content: systemPrompt }, ...sanitizedMessages],
          })
        )
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

  // GAP-P3: resolve versioned prompt BEFORE withRetry so the non-async arrow
  // doesn't need to await.
  const triageSystemPrompt = await resolvePrompt("TRIAGE_SYSTEM");

  try {
    response = await withSpan(
      "ai.extractSymptomSummary",
      { "ai.feature": "triage", "ai.model": MODEL },
      () =>
        withRetry(() =>
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
          // GAP-P3: versioned prompt via registry (fallback to PROMPTS constant).
          { role: "system", content: triageSystemPrompt },
          ...messages,
          {
            role: "user",
            content: "Now produce a structured summary of the symptoms and recommend the top 3 specialties.",
          },
        ],
          })
        )
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

  // GAP-T8: GP fallback on low confidence. If the overall confidence score
  // indicates Claude is uncertain about the specialty match, prepend a General
  // Physician so the patient starts there rather than with a potentially
  // mis-matched specialist. The route layer additionally inspects the live
  // doctor pool and may prepend GP again when fewer than 2 matching doctors
  // exist for the suggested specialty; `isGPFallback` + dedup guards protect
  // against duplicates.
  const specialties: SpecialtySuggestion[] = Array.isArray(input.specialties)
    ? (input.specialties as SpecialtySuggestion[])
    : [];
  const confidenceNum = typeof input.overallConfidence === "number" ? input.overallConfidence : 0;
  const alreadyHasGP = specialties.some(
    (s) => s?.specialty?.toLowerCase?.().includes("general physician")
      || s?.specialty?.toLowerCase?.().includes("general practitioner"),
  );
  const finalSpecialties: SpecialtySuggestion[] =
    confidenceNum < 0.5 && !alreadyHasGP
      ? [
          {
            specialty: "General Physician",
            subSpecialty: null as any,
            confidence: 0.9,
            reasoning:
              "Starting with a General Physician given the complexity/uncertainty of your symptoms.",
            isGPFallback: true,
          } as unknown as SpecialtySuggestion,
          ...specialties,
        ]
      : specialties;

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
    specialties: finalSpecialties,
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
    verifyResponse = await withSpan(
      "ai.validateSOAPHallucinations",
      { "ai.feature": "hallucination-check", "ai.model": MODEL },
      () =>
        withRetry(() =>
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
        )
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

  // GAP-P3: resolve versioned scribe prompt before the retry-wrapped call.
  const scribeSystemPrompt = await resolvePrompt("SCRIBE_SYSTEM");

  const t0 = Date.now();
  let response: OpenAI.Chat.Completions.ChatCompletion | undefined;

  try {
    response = await withSpan(
      "ai.generateSOAPNote",
      { "ai.feature": "scribe", "ai.model": MODEL },
      () =>
        withRetry(() =>
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
          // GAP-P3: versioned prompt via registry (fallback to PROMPTS constant).
          { role: "system", content: scribeSystemPrompt },
          {
            role: "user",
            content: `${contextText}${ragContext ? "\n\n" + ragContext + "\n" : ""}\n\nConsultation Transcript:\n${transcriptText}\n\nGenerate the SOAP note. Only include information explicitly stated in the transcript.\n\nSPEAKER-ROLE GUIDANCE (GAP-S4):\n- The Subjective section should be drawn primarily from [PATIENT] speech — symptom narrative, history, what the patient reports.\n- The Objective, Assessment and Plan sections should be drawn primarily from [DOCTOR] speech — exam findings, impressions and treatment decisions.\n- [ATTENDANT] utterances (family members, caregivers) may supplement either section but should never be the sole source for Assessment or Plan.`,
          },
        ],
          })
        )
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
