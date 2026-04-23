import OpenAI from "openai";

// Sarvam AI — India-region servers, DPDP-compliant
const sarvam = new OpenAI({
  apiKey: process.env.SARVAM_API_KEY ?? "",
  baseURL: "https://api.sarvam.ai/v1",
});

const MODEL = "sarvam-105b";

// ── Types ─────────────────────────────────────────────────────────────────────

/** Structured AI-assisted ESI triage assessment returned by {@link assessERPatient}. */
export interface ERTriageAssessment {
  suggestedTriageLevel: number; // 1-5 (ESI: 1=resuscitation, 5=non-urgent)
  triageLevelLabel: string; // "Resuscitation" | "Emergent" | "Urgent" | "Semi-Urgent" | "Non-Urgent"
  disposition: string; // "Immediate resuscitation bay" | "Treatment room" | "Fast track" | "Waiting room"
  immediateActions: string[]; // things to do RIGHT NOW
  suggestedInvestigations: string[];
  redFlags: string[]; // concerning features identified
  calculatedMEWS: number | null; // recalculated from vitals if provided
  aiReasoning: string; // brief clinical reasoning
  disclaimer: string; // always include
}

// ── MEWS calculator ────────────────────────────────────────────────────────────

/**
 * Calculate the Modified Early Warning Score (MEWS) from raw vitals.
 * Each parameter contributes 0–3 points; higher totals indicate greater
 * physiological derangement. Returns 0 if no vitals are supplied.
 *
 * @param vitals.consciousness AVPU-derived score: 0=alert, 1=voice, 2=pain, 3=unresponsive.
 */
export function calculateMEWS(vitals: {
  respiratoryRate?: number;
  spO2?: number;
  pulse?: number;
  systolicBP?: number;
  temperature?: number;
  consciousness?: number; // GCS-derived: 0=alert, 1=voice, 2=pain, 3=unresponsive
}): number {
  let score = 0;

  // Respiratory rate scoring
  if (vitals.respiratoryRate !== undefined) {
    const rr = vitals.respiratoryRate;
    if (rr <= 8) score += 3;
    else if (rr <= 14) score += 1;
    else if (rr <= 20) score += 0; // normal 15-20
    else if (rr <= 29) score += 2;
    else score += 3;
  }

  // SpO2 scoring
  if (vitals.spO2 !== undefined) {
    const spo2 = vitals.spO2;
    if (spo2 >= 95) score += 0;
    else if (spo2 >= 90) score += 1;
    else if (spo2 >= 85) score += 2;
    else score += 3;
  }

  // Pulse scoring
  if (vitals.pulse !== undefined) {
    const hr = vitals.pulse;
    if (hr <= 40) score += 3;
    else if (hr <= 50) score += 2;
    else if (hr <= 100) score += 0; // normal
    else if (hr <= 110) score += 1;
    else if (hr <= 129) score += 2;
    else score += 3;
  }

  // Systolic BP scoring
  if (vitals.systolicBP !== undefined) {
    const sbp = vitals.systolicBP;
    if (sbp <= 70) score += 3;
    else if (sbp <= 80) score += 2;
    else if (sbp <= 100) score += 1;
    else if (sbp <= 199) score += 0; // normal
    else score += 2;
  }

  // Temperature scoring
  if (vitals.temperature !== undefined) {
    const temp = vitals.temperature;
    if (temp <= 35) score += 3;
    else if (temp <= 38.4) score += 0; // normal
    else if (temp <= 38.9) score += 1;
    else score += 2;
  }

  // Consciousness scoring (AVPU-derived)
  if (vitals.consciousness !== undefined) {
    score += vitals.consciousness; // 0=alert, 1=voice, 2=pain, 3=unresponsive
  }

  return score;
}

/** Parse "120/80" → 120 */
function parseSystolicBP(bp?: string): number | undefined {
  if (!bp) return undefined;
  const match = bp.match(/^(\d+)/);
  return match ? parseInt(match[1], 10) : undefined;
}

/** Convert GCS (3-15) to AVPU consciousness score (0-3) */
function gcsToConsciousness(gcs?: number): number | undefined {
  if (gcs === undefined) return undefined;
  if (gcs >= 15) return 0; // alert
  if (gcs >= 13) return 1; // responds to voice
  if (gcs >= 9) return 2; // responds to pain
  return 3; // unresponsive
}

// ── Retry helper ──────────────────────────────────────────────────────────────

function isRetryable(err: unknown): boolean {
  if (err instanceof Error) {
    if (
      err.message.includes("ECONNRESET") ||
      err.message.includes("ENOTFOUND") ||
      err.message.includes("ETIMEDOUT") ||
      err.message.includes("fetch failed")
    ) {
      return true;
    }
    const asAny = err as any;
    if (typeof asAny.status === "number" && asAny.status >= 500) return true;
  }
  return false;
}

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < 3; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err) || i === 2) break;
      await new Promise<void>((r) => setTimeout(r, 1000));
    }
  }
  throw lastErr;
}

// ── assessERPatient ───────────────────────────────────────────────────────────

/**
 * Produce an AI-assisted ESI triage assessment (level 1–5) for an ED patient.
 * Calculates MEWS from supplied vitals, then asks Sarvam AI to suggest a triage
 * level, disposition, immediate actions, and investigations. Falls back
 * conservatively to ESI-2 (Emergent) if the AI call fails.
 * The returned `disclaimer` field must be displayed to the user at all times.
 */
export async function assessERPatient(opts: {
  chiefComplaint: string;
  vitals: {
    bp?: string;
    pulse?: number;
    resp?: number;
    spO2?: number;
    temp?: number;
    gcs?: number;
  };
  patientAge?: number;
  patientGender?: string;
  briefHistory?: string;
}): Promise<ERTriageAssessment> {
  const { chiefComplaint, vitals, patientAge, patientGender, briefHistory } = opts;

  // 1. Calculate MEWS
  const systolicBP = parseSystolicBP(vitals.bp);
  const consciousness = gcsToConsciousness(vitals.gcs);

  const mewsInput = {
    respiratoryRate: vitals.resp,
    spO2: vitals.spO2,
    pulse: vitals.pulse,
    systolicBP,
    temperature: vitals.temp,
    consciousness,
  };

  const hasAnyVital = Object.values(mewsInput).some((v) => v !== undefined);
  const calculatedMEWS = hasAnyVital ? calculateMEWS(mewsInput) : null;

  // 2. Build concise clinical summary
  const vitalLines: string[] = [];
  if (vitals.bp) vitalLines.push(`BP: ${vitals.bp}`);
  if (vitals.pulse !== undefined) vitalLines.push(`HR: ${vitals.pulse} bpm`);
  if (vitals.resp !== undefined) vitalLines.push(`RR: ${vitals.resp}/min`);
  if (vitals.spO2 !== undefined) vitalLines.push(`SpO2: ${vitals.spO2}%`);
  if (vitals.temp !== undefined) vitalLines.push(`Temp: ${vitals.temp}°C`);
  if (vitals.gcs !== undefined) vitalLines.push(`GCS: ${vitals.gcs}/15`);

  const clinicalSummary = [
    `Chief Complaint: ${chiefComplaint}`,
    patientAge !== undefined || patientGender
      ? `Patient: ${patientAge !== undefined ? `${patientAge}y` : "unknown age"} ${patientGender ?? ""}`.trim()
      : null,
    vitalLines.length > 0 ? `Vitals: ${vitalLines.join(", ")}` : null,
    calculatedMEWS !== null ? `MEWS Score: ${calculatedMEWS}` : null,
    briefHistory ? `History: ${briefHistory}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  // 3. Call Sarvam AI with tool suggest_triage
  const response = await withRetry(() =>
    sarvam.chat.completions.create({
      model: MODEL,
      max_tokens: 2048,
      tools: [
        {
          type: "function",
          function: {
            name: "suggest_triage",
            description:
              "Suggest ESI triage level and immediate clinical actions for an emergency department patient",
            parameters: {
              type: "object",
              properties: {
                suggestedTriageLevel: {
                  type: "number",
                  description: "ESI triage level 1-5 (1=Resuscitation, 5=Non-Urgent)",
                  minimum: 1,
                  maximum: 5,
                },
                triageLevelLabel: {
                  type: "string",
                  enum: ["Resuscitation", "Emergent", "Urgent", "Semi-Urgent", "Non-Urgent"],
                },
                disposition: {
                  type: "string",
                  description: "Where to send the patient",
                  enum: [
                    "Immediate resuscitation bay",
                    "Treatment room",
                    "Fast track",
                    "Waiting room",
                  ],
                },
                immediateActions: {
                  type: "array",
                  items: { type: "string" },
                  description: "Actions to take right now",
                },
                suggestedInvestigations: {
                  type: "array",
                  items: { type: "string" },
                  description: "Investigations to order",
                },
                redFlags: {
                  type: "array",
                  items: { type: "string" },
                  description: "Concerning features identified",
                },
                aiReasoning: {
                  type: "string",
                  description: "Brief clinical reasoning for the triage decision",
                },
              },
              required: [
                "suggestedTriageLevel",
                "triageLevelLabel",
                "disposition",
                "immediateActions",
                "suggestedInvestigations",
                "redFlags",
                "aiReasoning",
              ],
            },
          },
        },
      ],
      tool_choice: { type: "function", function: { name: "suggest_triage" } },
      messages: [
        {
          role: "system",
          content:
            "You are an emergency medicine AI assistant. Analyze patient presentation and suggest ESI triage level (1-5). Be conservative — when in doubt, assign higher acuity. You assist human clinical judgment only.",
        },
        {
          role: "user",
          content: clinicalSummary,
        },
      ],
    })
  );

  // 4. Parse tool call response
  const raw = response.choices[0]?.message?.tool_calls?.[0];
  const toolCall = raw?.type === "function" ? raw : undefined;

  if (!toolCall) {
    // Fallback if tool call fails — return a safe conservative assessment
    return {
      suggestedTriageLevel: 2,
      triageLevelLabel: "Emergent",
      disposition: "Treatment room",
      immediateActions: ["Immediate physician assessment", "Continuous monitoring"],
      suggestedInvestigations: ["ECG", "Full blood count", "Basic metabolic panel"],
      redFlags: [],
      calculatedMEWS,
      aiReasoning: "Unable to complete AI assessment — defaulting to Emergent (Level 2) as conservative fallback.",
      disclaimer:
        "AI-assisted triage suggestion only. Final triage decision must be made by a qualified nurse or physician.",
    };
  }

  const parsed = JSON.parse(toolCall.function.arguments) as {
    suggestedTriageLevel: number;
    triageLevelLabel: string;
    disposition: string;
    immediateActions: string[];
    suggestedInvestigations: string[];
    redFlags: string[];
    aiReasoning: string;
  };

  return {
    ...parsed,
    calculatedMEWS,
    disclaimer:
      "AI-assisted triage suggestion only. Final triage decision must be made by a qualified nurse or physician.",
  };
}
