import OpenAI from "openai";
import type {
  SOAPNote,
  SpecialtySuggestion,
  SymptomCapture,
  TranscriptEntry,
} from "@medcore/shared";
import { PROMPTS, type PromptKey } from "./prompts";
import { retrieveContext } from "./rag";
import { sanitizeUserInput } from "./prompt-safety";
import { getChatClient, type ModelProvider } from "./model-router";
import { getActivePrompt } from "./prompt-registry";
import { logAICall } from "./sarvam-logging";
import { withSpan } from "./tracing";

// GAP-P5: the chat client comes from the multi-provider router so flipping
// `AI_PROVIDER` env var swaps backends fleet-wide without touching call sites.
// Default remains Sarvam (India-region, DPDP-compliant). Tests that mock the
// `openai` module still work because the router also constructs an `OpenAI`.
const sarvam = getChatClient();

const MODEL =
  process.env.AI_PROVIDER === "openai"
    ? (process.env.OPENAI_MODEL ?? "gpt-5.5")
    : (process.env.SARVAM_MODEL ?? "sarvam-105b");

console.log(`[sarvam] AI_PROVIDER=${process.env.AI_PROVIDER} MODEL=${MODEL}`);

// Resolve the chat client + model name for an optional per-request provider
// override. The scribe links the LLM provider to the ASR engine the doctor
// picked (Browser STT → OpenAI, Sarvam ASR → Sarvam). With no provider we fall
// back to the module-level default so every other call site is untouched.
function resolveLLM(provider?: ModelProvider): {
  client: ReturnType<typeof getChatClient>;
  model: string;
} {
  if (!provider) return { client: sarvam, model: MODEL };
  const model =
    provider === "openai"
      ? (process.env.OPENAI_MODEL ?? "gpt-5.5")
      : (process.env.SARVAM_MODEL ?? "sarvam-105b");
  return { client: getChatClient(provider), model };
}

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
    if (typeof asAny.status === "number" && (asAny.status >= 500 || asAny.status === 429)) {
      return true;
    }
  }
  return false;
}

function retryDelayMs(err: unknown, attempt: number): number {
  const asAny = err as any;
  if (asAny?.status === 429) {
    const retryAfter = Number(asAny?.headers?.["retry-after"] ?? 0);
    if (Number.isFinite(retryAfter) && retryAfter > 0) return retryAfter * 1000;
    return Math.min(2000 * 2 ** attempt, 30_000);
  }
  return 1000;
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
      await new Promise<void>((resolve) => setTimeout(resolve, retryDelayMs(err, attempt)));
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

// Sarvam's reasoning-style models (sarvam-m and friends) emit chain-of-
// thought wrapped in `<think>...</think>` tags inline in the message
// content, BEFORE the user-visible reply. The OpenAI SDK doesn't strip
// these because no OpenAI model uses that convention. We strip them
// here so downstream renderers (chat UI, audit logs) see only the
// user-intended reply. Removes both balanced and unterminated blocks
// (the latter happens on truncation by `max_tokens`).
function stripSarvamThinking(content: string): string {
  if (!content) return content;
  // Remove balanced <think>...</think> blocks first (the common case).
  let out = content.replace(/<think>[\s\S]*?<\/think>\s*/gi, "");
  // If a token-truncated response left an unclosed <think>, drop
  // everything from that tag forward so we don't show the model's
  // half-finished reasoning to a clinician/patient.
  const unterminated = out.indexOf("<think>");
  if (unterminated >= 0) {
    out = out.slice(0, unterminated);
  }
  return out.trim();
}

// Parse JSON returned by Sarvam via response_format: json_object.
// Sarvam-m doesn't support OpenAI-style function/tool calling (returns
// 400 "Tool calling is not supported for this model"), so every place
// that used `tools` + `tool_choice` for structured output now uses
// response_format: json_object instead. The model also prefixes its
// reply with a <think>...</think> chain-of-thought block that needs
// stripping before JSON.parse can succeed. Some responses occasionally
// wrap the JSON in markdown code fences (```json ... ```) — we strip
// those too. Returns null on any parse failure so callers can degrade
// gracefully (the original tool-based path also returned null when the
// tool wasn't called).
function parseSarvamJson<T>(content: string | null | undefined): T | null {
  if (!content) return null;
  let text = stripSarvamThinking(content);
  // Strip markdown code-fence wrappers the model sometimes adds even
  // under json_object mode (```json ... ``` or just ``` ... ```).
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenceMatch) text = fenceMatch[1];
  // Find the outermost JSON object — defensive against any prose the
  // model added after stripping reasoning.
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace < 0 || lastBrace < firstBrace) return null;
  const jsonSlice = text.slice(firstBrace, lastBrace + 1);
  try {
    return JSON.parse(jsonSlice) as T;
  } catch {
    return null;
  }
}

// Build the system-prompt suffix that tells Sarvam-m what JSON shape
// to return. We embed the JSON-schema parameter spec verbatim so the
// model has the same contract it would have had under tool-calling.
// Used by every structured-output Sarvam call after the tool migration.
function buildJsonModeSystemSuffix(
  toolName: string,
  toolDescription: string,
  parameters: Record<string, unknown>,
): string {
  return (
    "\n\nReturn ONLY a single JSON object (no prose, no markdown code fences) " +
    `that satisfies the following purpose: ${toolDescription}. ` +
    `The JSON object must match this JSON Schema (treat 'required' fields as mandatory):\n` +
    JSON.stringify({ name: toolName, parameters }) +
    "\n\nIf you are unsure of a field, use null for nullable fields or a reasonable default. " +
    "Do not include any explanation, only the JSON object."
  );
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
          }),
        ),
    );
    logAICall({
      feature: "scribe",
      model: MODEL,
      promptTokens: response.usage?.prompt_tokens ?? 0,
      completionTokens: response.usage?.completion_tokens ?? 0,
      latencyMs: Date.now() - t0,
    });
    // Strip Sarvam's <think>...</think> reasoning before returning so
    // callers (chart-search synthesis, etc) don't render reasoning to
    // the user.
    return stripSarvamThinking(response.choices[0]?.message?.content ?? "");
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
export async function translateText(
  text: string,
  targetLang: string,
): Promise<string> {
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
      {
        "ai.feature": "scribe",
        "ai.model": MODEL,
        "ai.target_lang": targetLang,
      },
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
          }),
        ),
    );
    logAICall({
      feature: "scribe",
      model: MODEL,
      promptTokens: response.usage?.prompt_tokens ?? 0,
      completionTokens: response.usage?.completion_tokens ?? 0,
      latencyMs: Date.now() - t0,
    });
    // Strip Sarvam's reasoning tags before returning the translation
    // — the patient gets the translated text only, never the model's
    // chain-of-thought.
    const translated = stripSarvamThinking(
      response.choices[0]?.message?.content ?? "",
    );
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
      err instanceof Error ? err.message : err,
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
  // Sarvam-m doesn't support function/tool calling. We replicate the
  // structured-output contract via response_format: json_object with
  // the JSON-schema embedded in the system prompt, then parse with the
  // same null-on-failure semantics the tool path used.
  const systemPrompt =
    opts.systemPrompt +
    buildJsonModeSystemSuffix(opts.toolName, opts.toolDescription, opts.parameters);

  const response = await withSpan(
    "ai.generateStructured",
    { "ai.feature": "scribe", "ai.model": MODEL, "ai.tool": opts.toolName },
    () =>
      withRetry(() =>
        sarvam.chat.completions.create({
          model: MODEL,
          max_tokens: opts.maxTokens ?? 1024,
          temperature: opts.temperature ?? 0,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: opts.userPrompt },
          ],
        }),
      ),
  );

  const data = parseSarvamJson<T>(response.choices[0]?.message?.content);
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
  language: string,
  // Optional caller-specific instruction appended to the system prompt. The
  // public marketing-booking flow uses this to forbid asking for location /
  // naming external hospitals (it has its own in-house doctor roster).
  systemSuffix?: string,
): Promise<{ reply: string; isEmergency: boolean; emergencyReason?: string }> {
  // security(2026-04-23-low): F-INJ-1 — sanitize every user-role message so
  // injection markers (e.g. "ignore previous instructions") are neutralised
  // before they hit the model. Assistant messages come from our own prior
  // responses and are left as-is. Latest user turn is also sanitized for RAG
  // retrieval so the vector query can't be steered either.
  //
  // 2026-05-29 (Pearl §5.2 follow-up): Sarvam-m enforces strict message
  // ordering — the FIRST non-system message must be `user`, returning 400
  // "First message must be from user (or after system message)" otherwise.
  // The triage session opens with an assistant greeting that gets prepended
  // here as the conversation history, so without this filter every first
  // user turn fails. Drop ALL leading assistant entries before the first
  // user message; assistant turns that come AFTER any user turn are
  // preserved (legitimate prior assistant replies).
  const firstUserIdx = messages.findIndex((m) => m.role === "user");
  const trimmedMessages =
    firstUserIdx > 0 ? messages.slice(firstUserIdx) : messages;
  const sanitizedMessages = trimmedMessages.map((m) =>
    m.role === "user" ? { ...m, content: sanitizeUserInput(m.content) } : m,
  );
  const lastUserMsg = sanitizedMessages.at(-1)?.content ?? "";
  const ragContext = await retrieveContext(lastUserMsg, 3, [
    "ICD10",
    "MEDICINE",
  ]).catch(() => "");

  // GAP-P3: read prompt + Hindi suffix from the versioned registry instead
  // of compiled constants. resolvePrompt transparently falls back to the
  // static PROMPTS object when the DB is empty or errors out, so this swap
  // is safe to roll out before any DB row is seeded.
  const [triageSystem, hindiSuffix] = await Promise.all([
    resolvePrompt("TRIAGE_SYSTEM"),
    language === "hi"
      ? resolvePrompt("TRIAGE_SYSTEM_HINDI_SUFFIX")
      : Promise.resolve(""),
  ]);
  const baseSystemPrompt =
    language === "hi" ? triageSystem + hindiSuffix : triageSystem;
  // Sarvam-m does NOT support OpenAI-style tool/function calling
  // (returns 400 "Tool calling is not supported for this model"). The
  // previous flag_emergency tool relied on that mechanism. We replace
  // it with a text-marker convention: the system prompt instructs the
  // model to prefix its reply with `[EMERGENCY:<reason>]` when an
  // emergency is detected; the route parses that prefix below. The
  // deterministic `checkRedFlags()` pass in apps/api/src/routes/
  // ai-triage.ts:149 remains the primary safety gate — this LLM hint
  // is the secondary net for descriptions the regex misses.
  const emergencyMarkerInstruction =
    language === "hi"
      ? "\n\nयदि मरीज़ की समस्या गंभीर लगती है (छाती में दर्द, सांस लेने में तकलीफ़, बेहोशी, गंभीर रक्तस्राव, आत्महत्या के विचार आदि), तो उत्तर की शुरुआत में [EMERGENCY:<reason>] लिखें — फिर रोगी को आपातकालीन सेवा से संपर्क करने के लिए कहें। उदाहरण: [EMERGENCY:Chest pain] कृपया तुरंत 112 पर कॉल करें।"
      : "\n\nIf the patient's description suggests an emergency (chest pain, difficulty breathing, fainting, severe bleeding, suicidal thoughts, stroke symptoms, etc), START YOUR REPLY with the literal token [EMERGENCY:<short reason>] and then tell them to seek immediate help. Example: '[EMERGENCY:Chest pain] Please call emergency services (112) right away.' Use the marker ONLY for true emergencies — routine fever, mild cough, headache, etc are NOT emergencies.";
  const systemPrompt =
    baseSystemPrompt +
    emergencyMarkerInstruction +
    (systemSuffix ? "\n\n" + systemSuffix : "") +
    (ragContext ? "\n\n" + ragContext : "");

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
            // sarvam-105b is a REASONING model: it emits a long
            // `<think>...</think>` chain-of-thought BEFORE the user-visible
            // reply (stripped by stripSarvamThinking below). At max_tokens
            // 1024 the think block alone exhausted the budget, the response
            // truncated mid-think, and stripping the unterminated block left
            // an EMPTY reply → blank chat bubble in /dashboard/ai-booking.
            // Give it enough headroom to finish thinking AND answer.
            max_tokens: 3000,
            // No `tools` / `tool_choice` — Sarvam-m doesn't support
            // function calling. Emergency detection happens via the
            // text marker convention documented above.
            messages: [
              { role: "system", content: systemPrompt },
              ...sanitizedMessages,
            ],
          }),
        ),
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

  const rawContent = response.choices[0]?.message?.content ?? "";
  const textContent = stripSarvamThinking(rawContent);

  // Parse the [EMERGENCY:<reason>] marker the system prompt instructs Sarvam to
  // emit on red-flag turns. The prompt asks for it at the START, but the model
  // (especially in non-English replies) sometimes places it MID-reply — so we
  // match it ANYWHERE, not just at the start, otherwise the raw token leaks
  // into the chat bubble. Tolerant of whitespace + case.
  const emergencyMatch = textContent.match(
    /\[EMERGENCY:\s*([^\]]+)\]/i,
  );

  logAICall({
    feature: "triage",
    model: MODEL,
    promptTokens: response.usage?.prompt_tokens ?? 0,
    completionTokens: response.usage?.completion_tokens ?? 0,
    latencyMs: Date.now() - t0,
    toolUsed: emergencyMatch ? "text:flag_emergency" : undefined,
  });

  if (emergencyMatch) {
    const reason = emergencyMatch[1].trim();
    // Strip the raw [EMERGENCY:...] token out of the visible text so it never
    // leaks into the chat bubble (the model sometimes emits it mid-reply or in
    // non-English text). The route's deterministic checkRedFlags() is the real
    // emergency gate; we surface isEmergency + the cleaned reply.
    const cleaned = textContent
      .replace(/\[EMERGENCY:[^\]]*\]/gi, "")
      .trim();
    return { reply: cleaned, isEmergency: true, emergencyReason: reason };
  }

  // Safety net: if stripping the <think> block (or a truncated response) left
  // nothing, never render an empty chat bubble — ask a sensible follow-up so
  // the conversation can continue toward a doctor suggestion.
  const reply = textContent.trim();
  if (!reply) {
    return {
      reply:
        language === "hi"
          ? "क्या आप अपने लक्षण थोड़े और विस्तार से बता सकते हैं? कब से है और कितनी तकलीफ़ है?"
          : "Could you tell me a little more about your symptoms — when it started and how severe it feels?",
      isEmergency: false,
    };
  }
  return { reply, isEmergency: false };
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
  messages: { role: "user" | "assistant"; content: string }[],
): Promise<
  SymptomCapture & { specialties: SpecialtySuggestion[]; confidence: number }
> {
  const t0 = Date.now();
  let response: OpenAI.Chat.Completions.ChatCompletion | undefined;

  // GAP-P3: resolve versioned prompt BEFORE withRetry so the non-async arrow
  // doesn't need to await.
  const triageSystemPrompt = await resolvePrompt("TRIAGE_SYSTEM");

  // Sarvam-m doesn't support function/tool calling — we use the same
  // json_object + JSON-schema-in-prompt strategy as `generateStructured`.
  // The schema is what the old `tools` block had; we just embed it via
  // buildJsonModeSystemSuffix so the model sees the same contract.
  const symptomSummaryParameters: Record<string, unknown> = {
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
  };
  const systemPromptWithSchema =
    triageSystemPrompt +
    buildJsonModeSystemSuffix(
      "structured_symptom_summary",
      "Extract a structured symptom summary and specialty recommendations from the conversation",
      symptomSummaryParameters,
    );

  // 2026-05-29: Sarvam-m enforces strict ordering — first non-system
  // message must be `user`. Drop any leading assistant entries (e.g.
  // the initial greeting from session.messages) to satisfy the rule.
  const firstUserIdx2 = messages.findIndex((m) => m.role === "user");
  const trimmedHistory =
    firstUserIdx2 > 0 ? messages.slice(firstUserIdx2) : messages;

  try {
    response = await withSpan(
      "ai.extractSymptomSummary",
      { "ai.feature": "triage", "ai.model": MODEL },
      () =>
        withRetry(() =>
          sarvam.chat.completions.create({
            model: MODEL,
            max_tokens: 2048,
            response_format: { type: "json_object" },
            messages: [
              { role: "system", content: systemPromptWithSchema },
              ...trimmedHistory,
              {
                role: "user",
                content:
                  "Now produce a structured summary of the symptoms and recommend the top 3 specialties.",
              },
            ],
          }),
        ),
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

  const input = parseSarvamJson<any>(response.choices[0]?.message?.content);
  logAICall({
    feature: "triage",
    model: MODEL,
    promptTokens: response.usage?.prompt_tokens ?? 0,
    completionTokens: response.usage?.completion_tokens ?? 0,
    latencyMs: Date.now() - t0,
    toolUsed: input ? "json:structured_symptom_summary" : undefined,
  });

  if (!input) {
    throw new Error("Failed to extract symptom summary");
  }

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
  const confidenceNum =
    typeof input.overallConfidence === "number" ? input.overallConfidence : 0;
  const alreadyHasGP = specialties.some(
    (s) =>
      s?.specialty?.toLowerCase?.().includes("general physician") ||
      s?.specialty?.toLowerCase?.().includes("general practitioner"),
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

async function validateSOAPHallucinations(
  soap: SOAPNote,
  transcriptText: string,
): Promise<SOAPNote> {
  const itemsToVerify: string[] = [
    ...(soap.plan?.medications?.map((m) => m.name) ?? []),
    ...(soap.assessment?.impression ? [soap.assessment.impression] : []),
  ];

  if (itemsToVerify.length === 0) {
    return soap;
  }

  const t0 = Date.now();
  let verifyResponse: OpenAI.Chat.Completions.ChatCompletion | undefined;

  const verifyItemsParameters: Record<string, unknown> = {
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
  };
  const verifySystemPrompt = buildJsonModeSystemSuffix(
    "verify_items",
    "For each item, report whether it appears verbatim or as a clear paraphrase in the transcript",
    verifyItemsParameters,
  );

  try {
    verifyResponse = await withSpan(
      "ai.validateSOAPHallucinations",
      { "ai.feature": "hallucination-check", "ai.model": MODEL },
      () =>
        withRetry(() =>
          sarvam.chat.completions.create({
            model: MODEL,
            max_tokens: 512,
            response_format: { type: "json_object" },
            messages: [
              { role: "system", content: verifySystemPrompt.trim() },
              {
                role: "user",
                content: `Transcript:\n${transcriptText}\n\nFor each item below, answer found:true only if it appears verbatim or is a clear paraphrase of what was said in the transcript.\nItems: ${JSON.stringify(itemsToVerify)}`,
              },
            ],
          }),
        ),
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

  const parsed = parseSarvamJson<{
    results: { item: string; found: boolean }[];
  }>(verifyResponse.choices[0]?.message?.content);
  logAICall({
    feature: "hallucination-check",
    model: MODEL,
    promptTokens: verifyResponse.usage?.prompt_tokens ?? 0,
    completionTokens: verifyResponse.usage?.completion_tokens ?? 0,
    latencyMs: Date.now() - t0,
    toolUsed: parsed ? "json:verify_items" : undefined,
  });

  if (!parsed || !Array.isArray(parsed.results)) return soap;
  const { results } = parsed;

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
            ? {
                ...med,
                notes: `${med.notes ?? ""}${med.notes ? " " : ""}[NOT CONFIRMED IN TRANSCRIPT]`,
              }
            : med,
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
  },
  options?: {
    /** LLM provider for this draft — linked to the doctor's ASR engine
     *  (Browser STT → "openai", Sarvam ASR → "sarvam"). Omitted → AI_PROVIDER default. */
    provider?: ModelProvider;
    /** Run the second-pass hallucination verifier (extra LLM round-trip).
     *  Defaults to true. Live drafting passes false for a single, fast call. */
    verifyHallucinations?: boolean;
    /** Medicines already in the current draft — the model is told to KEEP these
     *  unchanged and only APPEND new ones, so prescriptions stay stable across regens. */
    existingMedications?: {
      name?: string;
      dose?: string;
      frequency?: string;
      duration?: string;
      notes?: string;
    }[];
    /** Complaints already captured in the current draft — the model is told to
     *  PRESERVE these and only ADD newly-mentioned ones, so a multi-complaint
     *  visit accumulates instead of the draft snapping to a single complaint. */
    existingComplaints?: { chiefComplaint?: string; hpi?: string };
  },
): Promise<SOAPNote> {
  const { client, model } = resolveLLM(options?.provider);
  // Build the "keep these unchanged" block from the existing plan (if any) so
  // earlier prescriptions don't get swapped/re-ordered as the transcript grows.
  const existingMeds = (options?.existingMedications ?? []).filter(
    (m) => m && (m.name ?? "").trim().length > 0,
  );
  const medStability = existingMeds.length
    ? `\n\nALREADY-PRESCRIBED MEDICINES — KEEP THESE EXACTLY:\n${existingMeds
        .map(
          (m) =>
            `- ${m.name}${m.dose ? " " + m.dose : ""}${m.frequency ? " " + m.frequency : ""}${m.duration ? " " + m.duration : ""}`,
        )
        .join(
          "\n",
        )}\nReturn every one of the above medicines UNCHANGED in plan.medications (same name and dosing). Do NOT replace, remove, re-pick, or re-order them. Then, ONLY IF the transcript now mentions a NEW symptom or condition not already covered, APPEND additional medicine(s) for the new finding.`
    : "";
  // Complaint stability — preserve complaints already captured in earlier
  // regens and only ADD new ones, so a visit with several complaints (often
  // across mixed languages) accumulates instead of collapsing to one.
  const existingCC = (options?.existingComplaints?.chiefComplaint ?? "").trim();
  const existingHpi = (options?.existingComplaints?.hpi ?? "").trim();
  const ccIsPlaceholder =
    existingCC.toLowerCase() === "no clinical complaint stated yet";
  const complaintStability =
    existingCC && !ccIsPlaceholder
      ? `\n\nALREADY-CAPTURED COMPLAINTS — KEEP AND BUILD ON THESE (never drop them):\n- Chief complaint so far: ${existingCC}${existingHpi ? `\n- HPI so far: ${existingHpi}` : ""}\nThe chiefComplaint you return MUST still include every complaint listed above, PLUS any NEW complaint mentioned anywhere in the transcript (translate non-English complaints to English). Never replace the earlier complaints with only the most recent one, and address each in the assessment + plan.`
      : "";
  const stabilityInstruction = medStability + complaintStability;
  const transcriptText = transcript
    .map((e) => `[${e.speaker}]: ${e.text}`)
    .join("\n");

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
        withRetry(() => {
          const soapParameters: Record<string, unknown> = {
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
                  confidence: { type: "number", minimum: 0, maximum: 1 },
                  evidenceSpan: { type: "string" },
                },
                required: ["chiefComplaint", "hpi"],
              },
              objective: {
                type: "object",
                properties: {
                  vitals: { type: "string" },
                  examinationFindings: { type: "string" },
                  confidence: { type: "number", minimum: 0, maximum: 1 },
                  evidenceSpan: { type: "string" },
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
                  confidence: { type: "number", minimum: 0, maximum: 1 },
                  evidenceSpan: { type: "string" },
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
                  confidence: { type: "number", minimum: 0, maximum: 1 },
                  evidenceSpan: { type: "string" },
                },
              },
            },
            required: ["subjective", "objective", "assessment", "plan"],
          };
          const systemPromptWithSchema =
            scribeSystemPrompt +
            buildJsonModeSystemSuffix(
              "generate_soap_note",
              "Generate a structured SOAP note from the consultation transcript",
              soapParameters,
            );
          return client.chat.completions.create({
            model,
            // sarvam-105b is a REASONING model: it emits a `<think>...</think>`
            // chain (stripped by parseSarvamJson) BEFORE the JSON, and those
            // tokens count against max_tokens. A full multi-section SOAP note
            // PLUS the think block can blow past 4096 → the JSON truncates →
            // parseSarvamJson returns null → "Failed to generate SOAP note" →
            // an EMPTY draft ("no proper data"). Give ample headroom so the
            // think block AND the JSON both complete. This is a CEILING, not a
            // target — the model stops at the natural end, so concise notes are
            // unaffected in latency.
            max_tokens: 8192,
            response_format: { type: "json_object" },
            messages: [
              { role: "system", content: systemPromptWithSchema },
              {
                role: "user",
                content: `${contextText}${ragContext ? "\n\n" + ragContext + "\n" : ""}\n\nConsultation Transcript:\n${transcriptText}\n\nGenerate the SOAP note. Only include information explicitly stated in the transcript.\n\nSPEAKER-ROLE GUIDANCE (GAP-S4):\n- The Subjective section should be drawn primarily from [PATIENT] speech — symptom narrative, history, what the patient reports.\n- The Objective, Assessment and Plan sections should be drawn primarily from [DOCTOR] speech — exam findings, impressions and treatment decisions.\n- [ATTENDANT] utterances (family members, caregivers) may supplement either section but should never be the sole source for Assessment or Plan.${stabilityInstruction}`,
              },
            ],
          });
        }),
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

  const raw = parseSarvamJson<SOAPNote>(response.choices[0]?.message?.content);
  logAICall({
    feature: "scribe",
    model: MODEL,
    promptTokens: response.usage?.prompt_tokens ?? 0,
    completionTokens: response.usage?.completion_tokens ?? 0,
    latencyMs: Date.now() - t0,
    toolUsed: raw ? "json:generate_soap_note" : undefined,
  });

  if (!raw) {
    throw new Error("Failed to generate SOAP note");
  }

  // Live drafting passes verifyHallucinations:false for a single, fast call —
  // the SCRIBE_SYSTEM prompt already grounds the note and every draft still
  // goes through mandatory doctor Review & Sign-Off. Default (true) keeps the
  // verbatim-vs-transcript verifier for explicit/final generations.
  if (options?.verifyHallucinations === false) return raw;
  return validateSOAPHallucinations(raw, transcriptText);
}
