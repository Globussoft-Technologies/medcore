import { runTriageTurn, extractSymptomSummary, generateSOAPNote } from "../../services/ai/sarvam";
import { TRIAGE_CASES } from "./fixtures/triage-cases";
import { SOAP_CASES } from "./fixtures/soap-cases";

export interface EvalResult {
  caseId: string;
  passed: boolean;
  score: number; // 0-1
  failures: string[];
  durationMs: number;
}

// Resolve a dot-notation path against an object and return the value
function getPath(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, key) => {
    if (current !== null && typeof current === "object" && !Array.isArray(current)) {
      return (current as Record<string, unknown>)[key];
    }
    return undefined;
  }, obj);
}

// Return true when a value is non-empty (non-null, non-undefined, non-empty-string, non-empty-array)
function isNonEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value as object).length > 0;
  return true;
}

export async function runTriageEval(): Promise<EvalResult[]> {
  const results: EvalResult[] = [];

  for (const tc of TRIAGE_CASES) {
    const t0 = Date.now();
    const failures: string[] = [];

    try {
      const triageResult = await runTriageTurn(tc.messages, tc.language);

      if (tc.shouldFlagEmergency) {
        // Emergency case: pass only when isEmergency is true
        const passed = triageResult.isEmergency === true;
        if (!passed) {
          failures.push(
            `Expected emergency flag but isEmergency=${triageResult.isEmergency} (reason: ${triageResult.emergencyReason ?? "none"})`
          );
        }
        results.push({
          caseId: tc.id,
          passed,
          score: passed ? 1.0 : 0.0,
          failures,
          durationMs: Date.now() - t0,
        });
      } else {
        // Non-emergency case: also check specialty routing via extractSymptomSummary
        const summary = await extractSymptomSummary(tc.messages);

        // Collect top-3 specialties from the summary (sorted by confidence desc)
        const top3Specialties = [...summary.specialties]
          .sort((a, b) => b.confidence - a.confidence)
          .slice(0, 3)
          .map((s) => s.specialty);

        const matched =
          tc.expectedSpecialties.length === 0 ||
          tc.expectedSpecialties.some((expected) =>
            top3Specialties.some(
              (s) => s.toLowerCase().includes(expected.toLowerCase()) || expected.toLowerCase().includes(s.toLowerCase())
            )
          );

        if (!matched) {
          failures.push(
            `None of expected specialties [${tc.expectedSpecialties.join(", ")}] found in top-3: [${top3Specialties.join(", ")}]`
          );
        }

        if (triageResult.isEmergency) {
          failures.push(`Unexpectedly flagged as emergency: ${triageResult.emergencyReason ?? "no reason given"}`);
        }

        const passed = failures.length === 0;
        results.push({
          caseId: tc.id,
          passed,
          score: passed ? 1.0 : matched ? 0.5 : 0.0,
          failures,
          durationMs: Date.now() - t0,
        });
      }
    } catch (err) {
      results.push({
        caseId: tc.id,
        passed: false,
        score: 0,
        failures: [`Unexpected error: ${err instanceof Error ? err.message : String(err)}`],
        durationMs: Date.now() - t0,
      });
    }
  }

  return results;
}

export async function runSoapEval(): Promise<EvalResult[]> {
  const results: EvalResult[] = [];

  for (const sc of SOAP_CASES) {
    const t0 = Date.now();
    const failures: string[] = [];

    try {
      const soap = await generateSOAPNote(sc.transcript, sc.patientContext);
      const soapJson = JSON.stringify(soap).toLowerCase();

      // Check required fields
      let satisfiedFields = 0;
      for (const field of sc.requiredFields) {
        const value = getPath(soap, field);
        if (isNonEmpty(value)) {
          satisfiedFields++;
        } else {
          failures.push(`Required field "${field}" is missing or empty`);
        }
      }

      const fieldScore = sc.requiredFields.length > 0 ? satisfiedFields / sc.requiredFields.length : 1.0;

      // Check forbidden content (hallucination check)
      let hasForbidden = false;
      for (const forbidden of sc.forbiddenContent ?? []) {
        if (soapJson.includes(forbidden.toLowerCase())) {
          hasForbidden = true;
          failures.push(`Forbidden content "${forbidden}" found in SOAP output (possible hallucination)`);
        }
      }

      const hallucinationBonus = hasForbidden ? 0 : 0.5;
      // Normalise to 0-1: fieldScore contributes 0-0.5, hallucination bonus 0-0.5
      const score = Math.min(1.0, fieldScore * 0.5 + hallucinationBonus);
      const passed = failures.length === 0;

      results.push({
        caseId: sc.id,
        passed,
        score,
        failures,
        durationMs: Date.now() - t0,
      });
    } catch (err) {
      results.push({
        caseId: sc.id,
        passed: false,
        score: 0,
        failures: [`Unexpected error: ${err instanceof Error ? err.message : String(err)}`],
        durationMs: Date.now() - t0,
      });
    }
  }

  return results;
}

export async function runAllEvals(): Promise<{
  triage: EvalResult[];
  soap: EvalResult[];
  overallPassRate: number;
}> {
  const [triage, soap] = await Promise.all([runTriageEval(), runSoapEval()]);

  const allResults = [...triage, ...soap];
  const overallPassRate = allResults.length > 0 ? allResults.filter((r) => r.passed).length / allResults.length : 0;

  return { triage, soap, overallPassRate };
}
