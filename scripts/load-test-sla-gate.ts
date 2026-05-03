#!/usr/bin/env tsx
/**
 * Load-test SLA gate (P6).
 *
 *   tsx scripts/load-test-sla-gate.ts \
 *     --results-dir=load-test-results \
 *     --thresholds=scripts/load-test-thresholds.json
 *
 * Reads every `*.json` summary produced by `run-load-test.ts --json-out=...`
 * in `--results-dir`, compares each against the matching per-endpoint
 * threshold + the global error-rate threshold, and exits non-zero on breach.
 *
 * The gate is a CI policy, not a benchmarking tool — keep this script
 * narrow. Output is one line per check (PASS/FAIL) plus a final summary
 * the workflow log can show on failure.
 *
 * No npm deps — Node 20+ only.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

interface ThresholdBudget {
  max: number;
}

interface EndpointThresholds {
  p95Ms?: ThresholdBudget;
  p99Ms?: ThresholdBudget;
  errorRate?: ThresholdBudget;
}

interface ThresholdsFile {
  global?: { errorRate?: ThresholdBudget };
  endpoints: Record<string, EndpointThresholds>;
}

interface JsonSummary {
  schemaVersion: number;
  endpoint: string;
  completed: number;
  errorRate: number;
  latencyMs: { p50: number; p95: number; p99: number; min: number; max: number } | null;
}

interface CliArgs {
  resultsDir: string;
  thresholds: string;
}

interface CheckResult {
  pass: boolean;
  label: string;
  detail: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: Record<string, string> = {};
  for (const a of argv.slice(2)) {
    if (!a.startsWith("--")) continue;
    const eq = a.indexOf("=");
    if (eq === -1) continue;
    args[a.slice(2, eq)] = a.slice(eq + 1);
  }
  const resultsDir = args["results-dir"] ?? process.env.LOAD_TEST_RESULTS_DIR;
  const thresholds =
    args.thresholds ?? process.env.LOAD_TEST_THRESHOLDS ?? "scripts/load-test-thresholds.json";
  if (!resultsDir) {
    throw new Error("--results-dir=<path> is required (or set LOAD_TEST_RESULTS_DIR)");
  }
  return { resultsDir: resolve(resultsDir), thresholds: resolve(thresholds) };
}

function loadThresholds(path: string): ThresholdsFile {
  const raw = readFileSync(path, "utf8");
  const parsed = JSON.parse(raw) as ThresholdsFile;
  if (!parsed.endpoints || typeof parsed.endpoints !== "object") {
    throw new Error(`Thresholds file ${path} missing 'endpoints' map`);
  }
  return parsed;
}

function loadSummaries(dir: string): JsonSummary[] {
  const entries = readdirSync(dir).filter((f) => f.endsWith(".json"));
  if (entries.length === 0) {
    throw new Error(`No *.json result files found in ${dir}`);
  }
  return entries.map((f) => {
    const path = join(dir, f);
    const parsed = JSON.parse(readFileSync(path, "utf8")) as JsonSummary;
    if (!parsed.endpoint || typeof parsed.errorRate !== "number") {
      throw new Error(`${path}: missing required fields (endpoint, errorRate)`);
    }
    return parsed;
  });
}

function check(label: string, value: number, budget: ThresholdBudget | undefined, unit: string): CheckResult | null {
  if (!budget) return null;
  const pass = value <= budget.max;
  const detail = `${value.toFixed(2)}${unit} <= ${budget.max}${unit}`;
  return { pass, label, detail: pass ? detail : detail.replace("<=", ">") };
}

function evaluate(summaries: JsonSummary[], thresholds: ThresholdsFile): CheckResult[] {
  const results: CheckResult[] = [];

  // Global error-rate gate: aggregate across all summaries.
  const globalBudget = thresholds.global?.errorRate;
  if (globalBudget) {
    const totalCompleted = summaries.reduce((s, x) => s + x.completed, 0);
    const totalErrors = summaries.reduce((s, x) => s + Math.round(x.completed * x.errorRate), 0);
    const aggRate = totalCompleted === 0 ? 1 : totalErrors / totalCompleted;
    const r = check("global.errorRate", aggRate, globalBudget, "");
    if (r) results.push(r);
  }

  // Per-endpoint gates.
  for (const s of summaries) {
    const ep = thresholds.endpoints[s.endpoint];
    if (!ep) {
      results.push({ pass: false, label: `${s.endpoint}.thresholds`, detail: `no entry in thresholds file — add one or remove the run` });
      continue;
    }
    if (s.latencyMs) {
      const p95 = check(`${s.endpoint}.p95Ms`, s.latencyMs.p95, ep.p95Ms, "ms");
      if (p95) results.push(p95);
      const p99 = check(`${s.endpoint}.p99Ms`, s.latencyMs.p99, ep.p99Ms, "ms");
      if (p99) results.push(p99);
    } else if (ep.p95Ms || ep.p99Ms) {
      results.push({ pass: false, label: `${s.endpoint}.latencyMs`, detail: "no successful requests — latency budget cannot be evaluated" });
    }
    const er = check(`${s.endpoint}.errorRate`, s.errorRate, ep.errorRate, "");
    if (er) results.push(er);
  }
  return results;
}

function main(): void {
  const args = parseArgs(process.argv);
  const thresholds = loadThresholds(args.thresholds);
  const summaries = loadSummaries(args.resultsDir);

  process.stdout.write(`Load-test SLA gate — ${summaries.length} run(s) from ${args.resultsDir}\n`);
  for (const s of summaries) {
    const p95 = s.latencyMs ? `${s.latencyMs.p95.toFixed(0)}ms` : "n/a";
    process.stdout.write(`  - ${s.endpoint}: p95=${p95} errorRate=${(s.errorRate * 100).toFixed(2)}% n=${s.completed}\n`);
  }

  const results = evaluate(summaries, thresholds);
  const failed = results.filter((r) => !r.pass);
  for (const r of results) {
    process.stdout.write(`  ${r.pass ? "PASS" : "FAIL"}  ${r.label}: ${r.detail}\n`);
  }
  if (failed.length > 0) {
    process.stderr.write(`\n${failed.length} SLA breach(es) — failing build.\n`);
    process.exit(1);
  }
  process.stdout.write(`\nAll ${results.length} SLA checks passed.\n`);
}

try {
  main();
} catch (err) {
  process.stderr.write(`SLA gate error: ${(err as Error).message}\n`);
  process.exit(2);
}
