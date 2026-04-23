import { describe, it, expect } from "vitest";
import { runTriageEval, runSoapEval } from "./eval-runner";
import { TRIAGE_CASES } from "./fixtures/triage-cases";

describe("AI Eval Harness", () => {
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
