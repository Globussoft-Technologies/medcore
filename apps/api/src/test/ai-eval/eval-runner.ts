// AI eval runner. Each public runner returns structured metrics so CI can
// post a diff-style summary and gate releases on regression.
//
// PRD §3.9 — false-negative rate on red-flag detection MUST stay < 1%.
// PRD §6 — eval harness runs on every prompt/model change; blocks release.
//
// Pure scoring helpers (jaccardSimilarity, classifyTriagePrediction, etc.)
// are exported so the runner-tests file can exercise them without spending
// Sarvam credits.

import { promises as fs } from "node:fs";
import * as path from "node:path";

import { runTriageTurn, extractSymptomSummary, generateSOAPNote } from "../../services/ai/sarvam";
import { checkDrugSafety } from "../../services/ai/drug-interactions";
import { TRIAGE_CASES, RED_FLAG_TRIAGE_CASES, ROUTINE_TRIAGE_CASES } from "./fixtures/triage-cases";
import type { TriageCase } from "./fixtures/triage-cases";
import { SOAP_CASES } from "./fixtures/soap-cases";
import type { SoapCase } from "./fixtures/soap-cases";
import { DRUG_SAFETY_CASES } from "./fixtures/drug-safety-cases";
import type { DrugSafetyCase } from "./fixtures/drug-safety-cases";

// ─── Legacy result shape (kept so existing eval.test.ts keeps passing) ───────

export interface EvalResult {
  caseId: string;
  passed: boolean;
  score: number;
  failures: string[];
  durationMs: number;
}

// ─── Pure helpers (unit-tested in eval-runner.test.ts) ────────────────────────

/** Tokenise a string into lowercase alphanumeric tokens for Jaccard scoring. */
export function tokenize(s: string): string[] {
  if (!s) return [];
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s/-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1);
}

/** Jaccard token similarity in [0,1]. Empty strings score 0. */
export function jaccardSimilarity(a: string, b: string): number {
  const ta = new Set(tokenize(a));
  const tb = new Set(tokenize(b));
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}

/** Classify a single red-flag prediction into TP/FP/TN/FN bucket. */
export type ClassificationBucket = "TP" | "FP" | "TN" | "FN";
export function classifyTriagePrediction(actual: boolean, predicted: boolean): ClassificationBucket {
  if (actual && predicted) return "TP";
  if (actual && !predicted) return "FN";
  if (!actual && predicted) return "FP";
  return "TN";
}

/** True iff any keyword (case-insensitive substring) appears in haystack. */
export function alertContains(haystack: string, keyword: string): boolean {
  return haystack.toLowerCase().includes(keyword.toLowerCase());
}

/** Compute hits/misses for a drug-safety case given alert text + flags. */
export function scoreDrugSafetyCase(
  c: DrugSafetyCase,
  alertText: string,
  hasContraindicated: boolean,
  hasSevere: boolean
): { hits: number; misses: number; missingKeywords: string[]; severityOk: boolean } {
  const missingKeywords: string[] = [];
  let hits = 0;
  for (const kw of c.expectedAlerts) {
    if (alertContains(alertText, kw)) hits++;
    else missingKeywords.push(kw);
  }
  const severityOk =
    (!c.expectContraindicated || hasContraindicated) && (!c.expectSevere || hasSevere || hasContraindicated);
  return { hits, misses: c.expectedAlerts.length - hits, missingKeywords, severityOk };
}

// ─── Structured report types ──────────────────────────────────────────────────

export interface RedFlagEvalReport {
  truePositives: number;
  falsePositives: number;
  trueNegatives: number;
  falseNegatives: number;
  total: number;
  /** false negatives / red-flag positives (PRD §3.9 target < 0.01). */
  falseNegativeRate: number;
  /** false positives / non-red-flag total. */
  falsePositiveRate: number;
  perCase: { caseId: string; expected: boolean; predicted: boolean; bucket: ClassificationBucket }[];
}

export interface RoutingEvalReport {
  total: number;
  top1Hits: number;
  top3Hits: number;
  top1Accuracy: number;
  top3Accuracy: number;
  perCase: { caseId: string; expected: string; top3: string[]; top1Hit: boolean; top3Hit: boolean }[];
}

export interface SoapEvalReport {
  total: number;
  perFieldSimilarity: {
    chiefComplaint: number;
    keyFindings: number;
    primaryDiagnosis: number;
    keyMedications: number;
  };
  belowThreshold: number;
  threshold: number;
  perCase: {
    caseId: string;
    chiefComplaint: number;
    keyFindings: number;
    primaryDiagnosis: number;
    keyMedications: number;
    overall: number;
    belowThreshold: boolean;
  }[];
}

export interface DrugSafetyEvalReport {
  total: number;
  totalKeywords: number;
  hitKeywords: number;
  hitRate: number;
  severityFailures: number;
  perCase: {
    caseId: string;
    category: DrugSafetyCase["category"];
    hits: number;
    misses: number;
    missingKeywords: string[];
    severityOk: boolean;
  }[];
}

export interface EvalRunReport {
  generatedAt: string;
  redFlag: RedFlagEvalReport;
  routing: RoutingEvalReport;
  soap: SoapEvalReport;
  drugSafety: DrugSafetyEvalReport;
  /** PRD §3.9 gate. False if falseNegativeRate > 0.01. */
  releaseBlocked: boolean;
  /** Reason(s) the release would be blocked. */
  blockReasons: string[];
}

export const RED_FLAG_FN_THRESHOLD = 0.01;
export const SOAP_SIMILARITY_THRESHOLD = 0.4;

const REPORT_PATH = path.join(__dirname, "last-run.json");

/** Persist an EvalRunReport to last-run.json. */
export async function writeReport(report: EvalRunReport, file: string = REPORT_PATH): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(report, null, 2), "utf-8");
}

// ─── Red-flag eval ────────────────────────────────────────────────────────────

export async function runRedFlagEval(): Promise<RedFlagEvalReport> {
  const cases = [...RED_FLAG_TRIAGE_CASES, ...ROUTINE_TRIAGE_CASES];
  const perCase: RedFlagEvalReport["perCase"] = [];
  let tp = 0,
    fp = 0,
    tn = 0,
    fn = 0;

  for (const tc of cases) {
    let predicted = false;
    try {
      const r = await runTriageTurn(tc.messages, tc.language === "en" ? "en" : tc.language === "hi" ? "hi" : "en");
      predicted = !!r.isEmergency;
    } catch {
      // model error — treat as no detection so it counts as FN if positive.
      predicted = false;
    }
    const bucket = classifyTriagePrediction(tc.redFlagDetected, predicted);
    if (bucket === "TP") tp++;
    else if (bucket === "FP") fp++;
    else if (bucket === "TN") tn++;
    else fn++;
    perCase.push({ caseId: tc.id, expected: tc.redFlagDetected, predicted, bucket });
  }

  const positives = tp + fn;
  const negatives = tn + fp;
  return {
    truePositives: tp,
    falsePositives: fp,
    trueNegatives: tn,
    falseNegatives: fn,
    total: cases.length,
    falseNegativeRate: positives === 0 ? 0 : fn / positives,
    falsePositiveRate: negatives === 0 ? 0 : fp / negatives,
    perCase,
  };
}

// ─── Specialty routing eval ───────────────────────────────────────────────────

export async function runSpecialtyRoutingEval(): Promise<RoutingEvalReport> {
  const perCase: RoutingEvalReport["perCase"] = [];
  let top1 = 0;
  let top3 = 0;
  let total = 0;

  for (const tc of ROUTINE_TRIAGE_CASES) {
    total++;
    const expected = tc.specialty;
    const allowed = tc.expectedSpecialties.length ? tc.expectedSpecialties : [expected];
    let top3Names: string[] = [];
    try {
      const summary = await extractSymptomSummary(tc.messages);
      top3Names = [...summary.specialties]
        .sort((a, b) => b.confidence - a.confidence)
        .slice(0, 3)
        .map((s) => s.specialty);
    } catch {
      top3Names = [];
    }

    const norm = (s: string) => s.toLowerCase();
    const top1Hit = top3Names.length > 0 && allowed.some((a) => norm(top3Names[0]).includes(norm(a)) || norm(a).includes(norm(top3Names[0])));
    const top3Hit = allowed.some((a) =>
      top3Names.some((n) => norm(n).includes(norm(a)) || norm(a).includes(norm(n)))
    );
    if (top1Hit) top1++;
    if (top3Hit) top3++;
    perCase.push({ caseId: tc.id, expected, top3: top3Names, top1Hit, top3Hit });
  }

  return {
    total,
    top1Hits: top1,
    top3Hits: top3,
    top1Accuracy: total === 0 ? 0 : top1 / total,
    top3Accuracy: total === 0 ? 0 : top3 / total,
    perCase,
  };
}

// ─── SOAP similarity eval ─────────────────────────────────────────────────────

export function scoreSoapCase(
  expected: SoapCase["expected"],
  generated: { chiefComplaint?: string; keyFindings?: string; primaryDiagnosis?: string; keyMedications?: string[] },
  threshold: number = SOAP_SIMILARITY_THRESHOLD
): {
  chiefComplaint: number;
  keyFindings: number;
  primaryDiagnosis: number;
  keyMedications: number;
  overall: number;
  belowThreshold: boolean;
} {
  const cc = jaccardSimilarity(expected.chiefComplaint, generated.chiefComplaint ?? "");
  const kf = jaccardSimilarity(expected.keyFindings, generated.keyFindings ?? "");
  const dx = jaccardSimilarity(expected.primaryDiagnosis, generated.primaryDiagnosis ?? "");
  const meds = jaccardSimilarity(expected.keyMedications.join(" "), (generated.keyMedications ?? []).join(" "));
  const overall = (cc + kf + dx + meds) / 4;
  return {
    chiefComplaint: cc,
    keyFindings: kf,
    primaryDiagnosis: dx,
    keyMedications: meds,
    overall,
    belowThreshold: overall < threshold,
  };
}

export async function runSoapSimilarityEval(threshold: number = SOAP_SIMILARITY_THRESHOLD): Promise<SoapEvalReport> {
  const perCase: SoapEvalReport["perCase"] = [];
  let sumCC = 0,
    sumKF = 0,
    sumDx = 0,
    sumMeds = 0,
    below = 0;

  for (const sc of SOAP_CASES) {
    let generated: { chiefComplaint?: string; keyFindings?: string; primaryDiagnosis?: string; keyMedications?: string[] } = {};
    try {
      const soap = await generateSOAPNote(sc.transcript, sc.patientContext);
      generated = {
        chiefComplaint: soap.subjective?.chiefComplaint,
        keyFindings: [soap.subjective?.hpi, soap.objective?.examinationFindings, soap.objective?.vitals]
          .filter(Boolean)
          .join(" "),
        primaryDiagnosis: soap.assessment?.impression,
        keyMedications: (soap.plan?.medications ?? []).map((m) => m.name),
      };
    } catch {
      generated = {};
    }
    const score = scoreSoapCase(sc.expected, generated, sc.similarityThreshold ?? threshold);
    sumCC += score.chiefComplaint;
    sumKF += score.keyFindings;
    sumDx += score.primaryDiagnosis;
    sumMeds += score.keyMedications;
    if (score.belowThreshold) below++;
    perCase.push({
      caseId: sc.id,
      chiefComplaint: score.chiefComplaint,
      keyFindings: score.keyFindings,
      primaryDiagnosis: score.primaryDiagnosis,
      keyMedications: score.keyMedications,
      overall: score.overall,
      belowThreshold: score.belowThreshold,
    });
  }

  const n = SOAP_CASES.length || 1;
  return {
    total: SOAP_CASES.length,
    perFieldSimilarity: {
      chiefComplaint: sumCC / n,
      keyFindings: sumKF / n,
      primaryDiagnosis: sumDx / n,
      keyMedications: sumMeds / n,
    },
    belowThreshold: below,
    threshold,
    perCase,
  };
}

// ─── Drug safety eval ─────────────────────────────────────────────────────────

export async function runDrugSafetyEval(): Promise<DrugSafetyEvalReport> {
  const perCase: DrugSafetyEvalReport["perCase"] = [];
  let totalKw = 0;
  let hits = 0;
  let severityFailures = 0;

  for (const c of DRUG_SAFETY_CASES) {
    let alertText = "";
    let hasContraindicated = false;
    let hasSevere = false;
    try {
      const report = await checkDrugSafety(
        c.prescription,
        c.patientContext.currentMedications,
        c.patientContext.allergies,
        c.patientContext.chronicConditions,
        {
          age: c.patientContext.age,
          gender: c.patientContext.gender,
          weightKg: c.patientContext.weightKg,
          eGFR: c.patientContext.eGFR,
          hepaticImpairment: c.patientContext.hepaticImpairment ?? null,
          pregnancyWeeks: c.patientContext.pregnancyWeeks,
        }
      );
      alertText = report.alerts
        .map((a) => `${a.drug1}|${a.drug2}|${a.severity}|${a.description}`)
        .join("\n");
      hasContraindicated = report.hasContraindicated;
      hasSevere = report.hasSevere;
    } catch {
      // treat as zero alerts → all keywords miss
    }

    const scored = scoreDrugSafetyCase(c, alertText, hasContraindicated, hasSevere);
    totalKw += c.expectedAlerts.length;
    hits += scored.hits;
    if (!scored.severityOk) severityFailures++;
    perCase.push({
      caseId: c.id,
      category: c.category,
      hits: scored.hits,
      misses: scored.misses,
      missingKeywords: scored.missingKeywords,
      severityOk: scored.severityOk,
    });
  }

  return {
    total: DRUG_SAFETY_CASES.length,
    totalKeywords: totalKw,
    hitKeywords: hits,
    hitRate: totalKw === 0 ? 0 : hits / totalKw,
    severityFailures,
    perCase,
  };
}

// ─── All-in-one runner + gating ───────────────────────────────────────────────

export function determineReleaseBlock(report: Omit<EvalRunReport, "releaseBlocked" | "blockReasons" | "generatedAt">): {
  releaseBlocked: boolean;
  blockReasons: string[];
} {
  const reasons: string[] = [];
  if (report.redFlag.falseNegativeRate > RED_FLAG_FN_THRESHOLD) {
    reasons.push(
      `Red-flag false-negative rate ${(report.redFlag.falseNegativeRate * 100).toFixed(2)}% exceeds PRD §3.9 threshold of ${(RED_FLAG_FN_THRESHOLD * 100).toFixed(0)}%`
    );
  }
  return { releaseBlocked: reasons.length > 0, blockReasons: reasons };
}

export async function runAllEvalsStructured(opts: { write?: boolean } = { write: true }): Promise<EvalRunReport> {
  const [redFlag, routing, soap, drugSafety] = await Promise.all([
    runRedFlagEval(),
    runSpecialtyRoutingEval(),
    runSoapSimilarityEval(),
    runDrugSafetyEval(),
  ]);

  const partial = { redFlag, routing, soap, drugSafety };
  const { releaseBlocked, blockReasons } = determineReleaseBlock(partial);

  const report: EvalRunReport = {
    generatedAt: new Date().toISOString(),
    ...partial,
    releaseBlocked,
    blockReasons,
  };

  if (opts.write) await writeReport(report);
  return report;
}

// ─── Legacy runners — keep eval.test.ts working ───────────────────────────────

function getPath(obj: unknown, p: string): unknown {
  return p.split(".").reduce<unknown>((current, key) => {
    if (current !== null && typeof current === "object" && !Array.isArray(current)) {
      return (current as Record<string, unknown>)[key];
    }
    return undefined;
  }, obj);
}
function isNonEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value as object).length > 0;
  return true;
}

export async function runTriageEval(): Promise<EvalResult[]> {
  const results: EvalResult[] = [];
  for (const tc of TRIAGE_CASES as TriageCase[]) {
    const t0 = Date.now();
    const failures: string[] = [];
    try {
      const triageResult = await runTriageTurn(
        tc.messages,
        tc.language === "en" ? "en" : tc.language === "hi" ? "hi" : "en"
      );
      if (tc.shouldFlagEmergency) {
        const passed = triageResult.isEmergency === true;
        if (!passed) {
          failures.push(
            `Expected emergency flag but isEmergency=${triageResult.isEmergency} (reason: ${triageResult.emergencyReason ?? "none"})`
          );
        }
        results.push({ caseId: tc.id, passed, score: passed ? 1 : 0, failures, durationMs: Date.now() - t0 });
      } else {
        const summary = await extractSymptomSummary(tc.messages);
        const top3 = [...summary.specialties]
          .sort((a, b) => b.confidence - a.confidence)
          .slice(0, 3)
          .map((s) => s.specialty);
        const matched =
          tc.expectedSpecialties.length === 0 ||
          tc.expectedSpecialties.some((expected) =>
            top3.some(
              (s) => s.toLowerCase().includes(expected.toLowerCase()) || expected.toLowerCase().includes(s.toLowerCase())
            )
          );
        if (!matched) {
          failures.push(
            `None of expected specialties [${tc.expectedSpecialties.join(", ")}] found in top-3: [${top3.join(", ")}]`
          );
        }
        if (triageResult.isEmergency) {
          failures.push(`Unexpectedly flagged as emergency: ${triageResult.emergencyReason ?? "no reason given"}`);
        }
        const passed = failures.length === 0;
        results.push({
          caseId: tc.id,
          passed,
          score: passed ? 1 : matched ? 0.5 : 0,
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
      let satisfied = 0;
      for (const f of sc.requiredFields) {
        const v = getPath(soap, f);
        if (isNonEmpty(v)) satisfied++;
        else failures.push(`Required field "${f}" is missing or empty`);
      }
      const fieldScore = sc.requiredFields.length > 0 ? satisfied / sc.requiredFields.length : 1;
      let hasForbidden = false;
      for (const f of sc.forbiddenContent ?? []) {
        if (soapJson.includes(f.toLowerCase())) {
          hasForbidden = true;
          failures.push(`Forbidden content "${f}" found in SOAP output (possible hallucination)`);
        }
      }
      const score = Math.min(1, fieldScore * 0.5 + (hasForbidden ? 0 : 0.5));
      results.push({
        caseId: sc.id,
        passed: failures.length === 0,
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
  const all = [...triage, ...soap];
  const overallPassRate = all.length > 0 ? all.filter((r) => r.passed).length / all.length : 0;
  return { triage, soap, overallPassRate };
}
