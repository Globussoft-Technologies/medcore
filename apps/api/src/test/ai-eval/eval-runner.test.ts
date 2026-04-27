// Pure-function tests for the AI eval runner. These are CHEAP and run on
// every CI push: they do NOT call Sarvam. They exercise the scoring helpers
// (`tokenize`, `jaccardSimilarity`, `classifyTriagePrediction`,
// `scoreSoapCase`, `scoreDrugSafetyCase`, `determineReleaseBlock`) plus the
// JSON report writer with mocked LLM outputs.
//
// The live-LLM path is exercised separately by eval.test.ts (which auto-skips
// without SARVAM_API_KEY).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  tokenize,
  jaccardSimilarity,
  classifyTriagePrediction,
  scoreDrugSafetyCase,
  scoreSoapCase,
  determineReleaseBlock,
  writeReport,
  RED_FLAG_FN_THRESHOLD,
  SOAP_SIMILARITY_THRESHOLD,
} from "./eval-runner";
import type { DrugSafetyCase } from "./fixtures/drug-safety-cases";

describe("tokenize", () => {
  it("lowercases, strips punctuation, drops short tokens", () => {
    const out = tokenize("Severe Chest pain, radiating to the LEFT arm!");
    expect(out).toEqual(["severe", "chest", "pain", "radiating", "to", "the", "left", "arm"]);
  });
  it("returns [] for empty/null-ish input", () => {
    expect(tokenize("")).toEqual([]);
    expect(tokenize("   ")).toEqual([]);
  });
});

describe("jaccardSimilarity", () => {
  it("returns 1.0 for identical token sets", () => {
    expect(jaccardSimilarity("uncontrolled hypertension", "hypertension uncontrolled")).toBeCloseTo(1, 5);
  });
  it("returns 0 when one side is empty", () => {
    expect(jaccardSimilarity("anything", "")).toBe(0);
    expect(jaccardSimilarity("", "anything")).toBe(0);
  });
  it("computes intersection/union correctly for partial overlap", () => {
    // {a,b,c} vs {b,c,d}: inter=2, union=4 → 0.5
    expect(jaccardSimilarity("aa bb cc", "bb cc dd")).toBeCloseTo(0.5, 5);
  });
});

describe("classifyTriagePrediction", () => {
  it.each([
    [true, true, "TP"],
    [true, false, "FN"],
    [false, true, "FP"],
    [false, false, "TN"],
  ] as const)("actual=%s predicted=%s → %s", (actual, predicted, bucket) => {
    expect(classifyTriagePrediction(actual, predicted)).toBe(bucket);
  });
});

describe("scoreSoapCase", () => {
  const expected = {
    chiefComplaint: "uncontrolled hypertension",
    keyFindings: "bp 162/98 home bp elevated",
    primaryDiagnosis: "uncontrolled hypertension",
    keyMedications: ["amlodipine", "telmisartan"],
  };
  it("scores perfect match at overall=1", () => {
    const r = scoreSoapCase(expected, {
      chiefComplaint: "uncontrolled hypertension",
      keyFindings: "BP 162/98 home BP elevated",
      primaryDiagnosis: "uncontrolled hypertension",
      keyMedications: ["amlodipine", "telmisartan"],
    });
    expect(r.overall).toBeGreaterThan(0.9);
    expect(r.belowThreshold).toBe(false);
  });
  it("flags missing fields below threshold", () => {
    const r = scoreSoapCase(expected, {});
    expect(r.overall).toBe(0);
    expect(r.belowThreshold).toBe(true);
  });
  it("uses custom threshold when provided", () => {
    const r = scoreSoapCase(expected, { chiefComplaint: "hypertension" }, 0.05);
    expect(r.belowThreshold).toBe(false);
  });
});

describe("scoreDrugSafetyCase", () => {
  const baseCase: DrugSafetyCase = {
    id: "ds-test",
    description: "test",
    category: "DDI",
    patientContext: { allergies: [], currentMedications: [], chronicConditions: [] },
    prescription: [],
    expectedAlerts: ["warfarin", "aspirin", "bleeding"],
    expectSevere: true,
    clinicalRationale: "test",
  };
  it("counts hits and lists missing keywords", () => {
    const text = "warfarin and aspirin together raise bleeding risk";
    const out = scoreDrugSafetyCase(baseCase, text, false, true);
    expect(out.hits).toBe(3);
    expect(out.misses).toBe(0);
    expect(out.missingKeywords).toEqual([]);
    expect(out.severityOk).toBe(true);
  });
  it("severityOk false when expectSevere but neither severe nor contraindicated raised", () => {
    const out = scoreDrugSafetyCase(baseCase, "warfarin aspirin bleeding", false, false);
    expect(out.severityOk).toBe(false);
  });
  it("contraindicated implies severe-OK for severityOk", () => {
    const out = scoreDrugSafetyCase(baseCase, "warfarin aspirin bleeding", true, false);
    expect(out.severityOk).toBe(true);
  });
  it("partial keyword match leaves the rest in missingKeywords", () => {
    const out = scoreDrugSafetyCase(baseCase, "warfarin only here", false, true);
    expect(out.hits).toBe(1);
    expect(out.misses).toBe(2);
    expect(out.missingKeywords).toEqual(["aspirin", "bleeding"]);
  });
});

describe("determineReleaseBlock (PRD §3.9 gate)", () => {
  const baseRouting = { total: 0, top1Hits: 0, top3Hits: 0, top1Accuracy: 1, top3Accuracy: 1, perCase: [] };
  const baseSoap = {
    total: 0,
    perFieldSimilarity: { chiefComplaint: 1, keyFindings: 1, primaryDiagnosis: 1, keyMedications: 1 },
    belowThreshold: 0,
    threshold: SOAP_SIMILARITY_THRESHOLD,
    perCase: [],
  };
  const baseDrugSafety = { total: 0, totalKeywords: 0, hitKeywords: 0, hitRate: 1, severityFailures: 0, perCase: [] };

  it("does NOT block when falseNegativeRate <= 0.01", () => {
    const r = determineReleaseBlock({
      redFlag: {
        truePositives: 100,
        falsePositives: 0,
        trueNegatives: 100,
        falseNegatives: 1,
        total: 201,
        falseNegativeRate: 1 / 101,
        falsePositiveRate: 0,
        perCase: [],
      },
      routing: baseRouting,
      soap: baseSoap,
      drugSafety: baseDrugSafety,
    });
    expect(r.releaseBlocked).toBe(false);
    expect(r.blockReasons).toEqual([]);
  });

  it("BLOCKS when falseNegativeRate > 0.01", () => {
    const r = determineReleaseBlock({
      redFlag: {
        truePositives: 90,
        falsePositives: 0,
        trueNegatives: 100,
        falseNegatives: 10,
        total: 200,
        falseNegativeRate: 0.1, // 10%
        falsePositiveRate: 0,
        perCase: [],
      },
      routing: baseRouting,
      soap: baseSoap,
      drugSafety: baseDrugSafety,
    });
    expect(r.releaseBlocked).toBe(true);
    expect(r.blockReasons[0]).toMatch(/false-negative rate/i);
    expect(r.blockReasons[0]).toMatch(/PRD §3.9/);
  });

  it("threshold matches PRD §3.9 (1%)", () => {
    expect(RED_FLAG_FN_THRESHOLD).toBeCloseTo(0.01, 5);
  });
});

describe("writeReport", () => {
  let tmpFile: string;

  beforeEach(async () => {
    tmpFile = path.join(os.tmpdir(), `medcore-eval-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  });

  afterEach(async () => {
    await fs.rm(tmpFile, { force: true });
  });

  it("writes a parseable JSON report to the given path", async () => {
    const report = {
      generatedAt: new Date().toISOString(),
      redFlag: {
        truePositives: 1,
        falsePositives: 0,
        trueNegatives: 1,
        falseNegatives: 0,
        total: 2,
        falseNegativeRate: 0,
        falsePositiveRate: 0,
        perCase: [],
      },
      routing: { total: 0, top1Hits: 0, top3Hits: 0, top1Accuracy: 0, top3Accuracy: 0, perCase: [] },
      soap: {
        total: 0,
        perFieldSimilarity: { chiefComplaint: 0, keyFindings: 0, primaryDiagnosis: 0, keyMedications: 0 },
        belowThreshold: 0,
        threshold: SOAP_SIMILARITY_THRESHOLD,
        perCase: [],
      },
      drugSafety: { total: 0, totalKeywords: 0, hitKeywords: 0, hitRate: 0, severityFailures: 0, perCase: [] },
      releaseBlocked: false,
      blockReasons: [],
    };
    await writeReport(report, tmpFile);
    const round = JSON.parse(await fs.readFile(tmpFile, "utf-8"));
    expect(round.releaseBlocked).toBe(false);
    expect(round.redFlag.total).toBe(2);
  });
});

// ─── Runner integration tests with mocked Sarvam ──────────────────────────────
//
// We mock the sarvam service so the four runner functions actually execute
// against fixtures, but no external API is called. This proves the runner
// wiring works (fixture loop, classification buckets, FN-rate calc) without
// burning Sarvam credits in CI.

vi.mock("../../services/ai/sarvam", () => ({
  runTriageTurn: vi.fn(async (messages: { role: string; content: string }[]) => {
    // Heuristic: any message containing "chest pain", "stroke", "anaphyl", "bleed",
    // "suicid", "eclamps", "ectopic", "neonate", "dka", "asthma", "seizure", "sepsis",
    // "torsion", "peritonitis", "thunderclap", "tia", or non-Latin scripts representing
    // emergencies → emergency. Crude but enough to confirm wiring.
    const txt = messages.map((m) => m.content).join(" ").toLowerCase();
    const emergency =
      /chest pain|crushing|radiat|stroke|fast|droop|slurred|थ्थ|থ্যা|انتقال|anaphyl|peanut|throat feels tight|haematemes|melaena|soaking pad|suicid|kill myself|कोल्ल|eclamps|ectopic|abruption|pre-eclampsia|preeclampsia|fetal mov|neonat|jaundice|meningism|dka|fruity-smell|status|status epilept|silent chest|sepsis|septic|torsion|peritonitis|thunderclap|tia|seizure|seene me|heart attack|उप|গেছে|பொ|गटिप/i.test(
        txt
      );
    return { reply: "", isEmergency: emergency, emergencyReason: emergency ? "mocked" : undefined };
  }),
  extractSymptomSummary: vi.fn(async () => ({
    chiefComplaint: "mock",
    onset: "",
    duration: "",
    severity: 5,
    location: "",
    associatedSymptoms: [],
    relevantHistory: "",
    currentMedications: [],
    knownAllergies: [],
    specialties: [
      { specialty: "General Physician", confidence: 0.6, reasoning: "mock" },
    ],
    confidence: 0.6,
  })),
  generateSOAPNote: vi.fn(async () => ({
    subjective: { chiefComplaint: "mock complaint", hpi: "mock hpi" },
    objective: { examinationFindings: "mock findings", vitals: "" },
    assessment: { impression: "mock diagnosis" },
    plan: { medications: [{ name: "mock-med", dose: "1mg", frequency: "OD", duration: "1d" }] },
  })),
}));

vi.mock("../../services/ai/drug-interactions", () => ({
  checkDrugSafety: vi.fn(async () => ({
    alerts: [
      { drug1: "mock", drug2: "mock", severity: "MILD", description: "mock alert" },
    ],
    hasContraindicated: false,
    hasSevere: false,
    checkedAt: new Date().toISOString(),
    checkedMeds: [],
    genericAlternatives: [],
  })),
}));

describe("runner integration (mocked LLM)", () => {
  it("runRedFlagEval returns counts that sum to total", async () => {
    const { runRedFlagEval } = await import("./eval-runner");
    const r = await runRedFlagEval();
    expect(r.truePositives + r.falsePositives + r.trueNegatives + r.falseNegatives).toBe(r.total);
    expect(r.total).toBeGreaterThan(0);
    // falseNegativeRate is well-formed
    expect(r.falseNegativeRate).toBeGreaterThanOrEqual(0);
    expect(r.falseNegativeRate).toBeLessThanOrEqual(1);
  });

  it("runDrugSafetyEval reports hit/miss per case", async () => {
    const { runDrugSafetyEval } = await import("./eval-runner");
    const r = await runDrugSafetyEval();
    expect(r.total).toBeGreaterThan(0);
    expect(r.totalKeywords).toBeGreaterThan(0);
    expect(r.perCase.length).toBe(r.total);
  });
});
