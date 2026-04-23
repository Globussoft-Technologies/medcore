import OpenAI from "openai";

const sarvam = new OpenAI({
  apiKey: process.env.SARVAM_API_KEY ?? "",
  baseURL: "https://api.sarvam.ai/v1",
});

const MODEL = "sarvam-105b";

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

  // Build result lines for the prompt
  const resultLines = labResults
    .map((r) => {
      const parts = [`${r.parameter}: ${r.value}`];
      if (r.unit) parts.push(r.unit);
      if (r.normalRange) parts.push(`(normal: ${r.normalRange})`);
      parts.push(`[${r.flag}]`);
      return parts.join(" ");
    })
    .join("\n");

  const patientContext: string[] = [];
  if (patientAge) patientContext.push(`Patient Age: ${patientAge}`);
  if (patientGender) patientContext.push(`Patient Gender: ${patientGender}`);
  const contextBlock = patientContext.length > 0 ? patientContext.join("\n") + "\n\n" : "";

  const userContent = `${contextBlock}Lab Results:\n${resultLines}\n\nLanguage: ${language === "hi" ? "Hindi" : "English"}`;

  const response = await sarvam.chat.completions.create({
    model: MODEL,
    max_tokens: 2048,
    tools: [
      {
        type: "function",
        function: {
          name: "explain_report",
          description:
            "Return a plain-language explanation of lab results for the patient, along with structured flagged values.",
          parameters: {
            type: "object",
            properties: {
              summary: {
                type: "string",
                description:
                  "Full plain-language explanation of the lab report addressed to the patient. Must end with 'Please discuss these results with your doctor.'",
              },
              flaggedValues: {
                type: "array",
                description: "List of abnormal/flagged results with plain language explanations.",
                items: {
                  type: "object",
                  properties: {
                    parameter: { type: "string" },
                    value: { type: "string" },
                    flag: { type: "string" },
                    plainLanguage: {
                      type: "string",
                      description: "Simple, jargon-free explanation of what this abnormal value means.",
                    },
                  },
                  required: ["parameter", "value", "flag", "plainLanguage"],
                },
              },
            },
            required: ["summary", "flaggedValues"],
          },
        },
      },
    ],
    tool_choice: { type: "function", function: { name: "explain_report" } },
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userContent },
    ],
  });

  const toolCall = response.choices[0]?.message?.tool_calls?.[0];
  if (!toolCall || toolCall.type !== "function") {
    throw new Error("AI service failed to return a structured report explanation");
  }

  const parsed = JSON.parse(toolCall.function.arguments) as {
    summary: string;
    flaggedValues: FlaggedValue[];
  };

  return {
    explanation: parsed.summary,
    flaggedValues: parsed.flaggedValues ?? [],
  };
}
