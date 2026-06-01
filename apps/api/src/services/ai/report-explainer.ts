import { sanitizeUserInput } from "./prompt-safety";
import { getChatClient } from "./model-router";

// Pearl §5.2 follow-up (2026-05-29): Sarvam-m doesn't support OpenAI
// function/tool calling. We use response_format: json_object + a
// JSON-schema-in-system-prompt and parse the reply directly.
// Also: this module previously hardcoded the model name "sarvam-105b"
// which Sarvam has since retired. Reading from env (with the same
// AI_PROVIDER router the rest of the codebase uses) keeps every
// Sarvam call site aligned on one model id.
const sarvam = getChatClient();
const MODEL =
  process.env.AI_PROVIDER === "openai"
    ? (process.env.OPENAI_MODEL ?? "gpt-5.5")
    : (process.env.SARVAM_MODEL ?? "sarvam-m");

function stripSarvamThinking(content: string): string {
  if (!content) return content;
  let out = content.replace(/<think>[\s\S]*?<\/think>\s*/gi, "");
  const unterminated = out.indexOf("<think>");
  if (unterminated >= 0) out = out.slice(0, unterminated);
  return out.trim();
}

function parseSarvamJson<T>(content: string | null | undefined): T | null {
  if (!content) return null;
  let text = stripSarvamThinking(content);
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenceMatch) text = fenceMatch[1];
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace < 0 || lastBrace < firstBrace) return null;
  try {
    return JSON.parse(text.slice(firstBrace, lastBrace + 1)) as T;
  } catch {
    return null;
  }
}

/** A single lab test result row passed to the report explainer. */
export interface LabResultInput {
  parameter: string;
  value: string;
  unit?: string;
  normalRange?: string;
  flag: string;
}

/** One abnormal result with a plain-language patient-facing explanation. */
export interface FlaggedValue {
  parameter: string;
  value: string;
  flag: string;
  plainLanguage: string;
}

/** Return type of {@link explainLabReport}. */
export interface ExplainLabReportResult {
  explanation: string;
  flaggedValues: FlaggedValue[];
}

const SYSTEM_PROMPT =
  "You are MedCore's AI report explainer. Given lab results, write a clear, empathetic plain-language explanation for the patient (NOT a doctor). Avoid jargon. For each abnormal value, explain what it means in simple terms and what they might expect next. End with: 'Please discuss these results with your doctor.' Do NOT recommend treatment.";

/**
 * Translate a set of lab results into a plain-language patient explanation
 * using Sarvam AI. Abnormal values are listed separately in `flaggedValues`.
 * Always ends with a doctor-consultation reminder; never recommends treatment.
 *
 * @param opts.language Pass `"hi"` to return the explanation in Hindi.
 */
export async function explainLabReport(opts: {
  labResults: LabResultInput[];
  patientAge?: number;
  patientGender?: string;
  language: "en" | "hi";
}): Promise<ExplainLabReportResult> {
  const { labResults, patientAge, patientGender, language } = opts;

  // security(2026-04-23-low): F-INJ-1 — patient-facing flow; sanitize every
  // free-text lab field before concatenating into the prompt. Units and ranges
  // are usually LIS-controlled vocab but are still scrubbed defensively.
  const resultLines = labResults
    .map((r) => {
      const parts = [
        `${sanitizeUserInput(r.parameter, { maxLen: 200 })}: ${sanitizeUserInput(r.value, { maxLen: 200 })}`,
      ];
      if (r.unit) parts.push(sanitizeUserInput(r.unit, { maxLen: 50 }));
      if (r.normalRange) parts.push(`(normal: ${sanitizeUserInput(r.normalRange, { maxLen: 100 })})`);
      parts.push(`[${sanitizeUserInput(r.flag, { maxLen: 40 })}]`);
      return parts.join(" ");
    })
    .join("\n");

  const patientContext: string[] = [];
  if (patientAge) patientContext.push(`Patient Age: ${patientAge}`);
  if (patientGender) patientContext.push(`Patient Gender: ${patientGender}`);
  const contextBlock = patientContext.length > 0 ? patientContext.join("\n") + "\n\n" : "";

  const userContent = `${contextBlock}Lab Results:\n${resultLines}\n\nLanguage: ${language === "hi" ? "Hindi" : "English"}`;

  const jsonSchemaInstruction =
    '\n\nReturn ONLY a single JSON object (no prose, no markdown code fences) with this shape: ' +
    '{"summary": string ending with "Please discuss these results with your doctor.", ' +
    '"flaggedValues": [{"parameter": string, "value": string, "flag": string, "plainLanguage": string}]}. ' +
    "Required fields on each flaggedValues entry: parameter, value, flag, plainLanguage.";

  const response = await sarvam.chat.completions.create({
    model: MODEL,
    max_tokens: 2048,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: SYSTEM_PROMPT + jsonSchemaInstruction },
      { role: "user", content: userContent },
    ],
  });

  const parsed = parseSarvamJson<{
    summary: string;
    flaggedValues: FlaggedValue[];
  }>(response.choices[0]?.message?.content);

  if (!parsed) {
    throw new Error("AI service failed to return a structured report explanation");
  }

  return {
    explanation: parsed.summary,
    flaggedValues: parsed.flaggedValues ?? [],
  };
}
