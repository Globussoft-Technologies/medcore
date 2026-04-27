import { describe, it, expect } from "vitest";
import {
  runTriageEval,
  runSoapEval,
  runRedFlagEval,
  runSpecialtyRoutingEval,
  runSoapSimilarityEval,
  runDrugSafetyEval,
  determineReleaseBlock,
  writeReport,
  RED_FLAG_FN_THRESHOLD,
} from "./eval-runner";
import { TRIAGE_CASES } from "./fixtures/triage-cases";

// The eval harness calls the live Sarvam + OpenAI endpoints. Without a real
// SARVAM_API_KEY configured we skip — the harness is intended for CI nightly
// runs + pre-release regression checks, not every `vitest run` on a dev box.
const HAS_LIVE_LLM = !!(process.env.SARVAM_API_KEY || process.env.OPENAI_API_KEY);
const describeLive = HAS_LIVE_LLM ? describe : describe.skip;

// CI gating: when RUN_AI_EVAL=1 we additionally hard-fail the suite if the
// red-flag false-negative rate exceeds PRD §3.9 threshold (1%).
const ENFORCE_CI_GATE = process.env.RUN_AI_EVAL === "1";
const describeGated = HAS_LIVE_LLM && ENFORCE_CI_GATE ? describe : describe.skip;

describeLive("AI Eval Harness", () => {
  it(
    "triage emergency detection: 100% pass rate",
    async () => {
      const results = await runTriageEval();
      const emergencyCaseIds = new Set(
        TRIAGE_CASES.filter((tc) => tc.shouldFlagEmergency).map((tc) => tc.id)
      );
      const emergencyResults = results.filter((r) => emergencyCaseIds.has(r.caseId));

      expect(emergencyResults.length).toBeGreaterThan(0);

      const failed = emergencyResults.filter((r) => !r.passed);
      if (failed.length > 0) {
        const details = failed.map((r) => `${r.caseId}: ${r.failures.join("; ")}`).join("\n");
        expect.fail(`Emergency detection failures:\n${details}`);
      }

      const passRate = emergencyResults.filter((r) => r.passed).length / emergencyResults.length;
      expect(passRate).toBe(1.0);
    },
    30_000
  );

  it(
    "triage specialty routing: >50% pass rate",
    async () => {
      const results = await runTriageEval();
      const routingCaseIds = new Set(
        TRIAGE_CASES.filter((tc) => !tc.shouldFlagEmergency).map((tc) => tc.id)
      );
      const routingResults = results.filter((r) => routingCaseIds.has(r.caseId));

      expect(routingResults.length).toBeGreaterThan(0);

      const passRate = routingResults.filter((r) => r.passed).length / routingResults.length;
      const failed = routingResults.filter((r) => !r.passed);
      const details = failed.map((r) => `${r.caseId}: ${r.failures.join("; ")}`).join("\n");

      expect(passRate, `Specialty routing pass rate ${(passRate * 100).toFixed(0)}% below 50% threshold.\nFailures:\n${details}`).toBeGreaterThan(0.5);
    },
    60_000
  );

  it(
    "SOAP required fields: >75% pass rate",
    async () => {
      const results = await runSoapEval();

      expect(results.length).toBeGreaterThan(0);

      // Pass rate at case level: a case passes when every required field is present
      const fieldFailureCases = results.filter((r) =>
        r.failures.some((f) => f.startsWith("Required field"))
      );
      const passRate = (results.length - fieldFailureCases.length) / results.length;
      const details = fieldFailureCases
        .map((r) => `${r.caseId}: ${r.failures.filter((f) => f.startsWith("Required field")).join("; ")}`)
        .join("\n");

      expect(
        passRate,
        `SOAP required-fields pass rate ${(passRate * 100).toFixed(0)}% below 75% threshold.\nFailures:\n${details}`
      ).toBeGreaterThan(0.75);
    },
    60_000
  );

  it(
    "SOAP hallucination check: 0 forbidden content found",
    async () => {
      const results = await runSoapEval();

      const hallucinationFailures = results
        .flatMap((r) =>
          r.failures
            .filter((f) => f.includes("Forbidden content"))
            .map((f) => `${r.caseId}: ${f}`)
        );

      expect(
        hallucinationFailures,
        `Hallucinations detected in SOAP output:\n${hallucinationFailures.join("\n")}`
      ).toHaveLength(0);
    },
    60_000
  );
});

// ─── CI release-gate: only runs when RUN_AI_EVAL=1 (set in CI nightly job) ───
// Hard-fails the build if PRD §3.9 false-negative threshold is breached.
describeGated("AI Eval Harness — release gate (PRD §3.9)", () => {
  it(
    "red-flag false-negative rate stays below 1%",
    async () => {
      const [redFlag, routing, soap, drugSafety] = await Promise.all([
        runRedFlagEval(),
        runSpecialtyRoutingEval(),
        runSoapSimilarityEval(),
        runDrugSafetyEval(),
      ]);
      const gate = determineReleaseBlock({ redFlag, routing, soap, drugSafety });
      await writeReport({
        generatedAt: new Date().toISOString(),
        redFlag,
        routing,
        soap,
        drugSafety,
        ...gate,
      });
      expect(
        redFlag.falseNegativeRate,
        `PRD §3.9: red-flag FN rate ${(redFlag.falseNegativeRate * 100).toFixed(2)}% > ${(RED_FLAG_FN_THRESHOLD * 100).toFixed(0)}%. Block reasons:\n${gate.blockReasons.join("\n")}`
      ).toBeLessThanOrEqual(RED_FLAG_FN_THRESHOLD);
      expect(gate.releaseBlocked, gate.blockReasons.join(" | ")).toBe(false);
    },
    300_000
  );
});
