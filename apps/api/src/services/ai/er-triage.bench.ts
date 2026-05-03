// Vitest microbenchmarks for ER triage MEWS scoring.
//
// WHY THIS EXISTS (P10 — TEST_COVERAGE_AUDIT.md §5):
//   `calculateMEWS` is the deterministic core of the ER triage hot path: it
//   runs on every assessERPatient invocation, every nurse-side vitals refresh,
//   and inside the auto-rescore worker. The ESI/MEWS scoring tree is a tight
//   branchy function (~30 conditionals) — easy to accidentally pessimise with
//   a refactor. We benchmark across realistic vital-sign profiles to keep an
//   eye on regressions and trip a >10% drift alarm in PR review.
//
// HOW TO USE:
//   - Run all benches:        `npm run bench --workspace=apps/api`
//   - Save a baseline:        `npx vitest bench --run --outputJson bench-baseline.json`
//   - Compare against base:   `npx vitest bench --run --compare=bench-baseline.json`
//
// SCOPE: pure in-memory MEWS calculator. No DB, no LLM, no network.

import { bench, describe } from "vitest";
import { calculateMEWS } from "./er-triage";

// ── Fixtures ──────────────────────────────────────────────────────────────────
// Each fixture mirrors a realistic ED arrival profile so the bench exercises
// the full branch table, not just the all-zero short-circuit.

const ALL_NORMAL = {
  respiratoryRate: 16,
  spO2: 98,
  pulse: 75,
  systolicBP: 120,
  temperature: 37,
  consciousness: 0,
} as const;

const SEPSIS_PROFILE = {
  respiratoryRate: 32,
  spO2: 88,
  pulse: 132,
  systolicBP: 88,
  temperature: 39.5,
  consciousness: 1,
} as const;

const HYPOTENSIVE_BRADYCARDIA = {
  respiratoryRate: 8,
  spO2: 90,
  pulse: 38,
  systolicBP: 68,
  temperature: 34.5,
  consciousness: 3,
} as const;

const PARTIAL_VITALS = {
  // Common during fast triage — only BP and pulse captured at first.
  pulse: 110,
  systolicBP: 95,
} as const;

const EMPTY_VITALS = {} as const;

// ── Benchmarks ────────────────────────────────────────────────────────────────

describe("er-triage hot paths", () => {
  const opts = { time: 500 } as const;

  bench(
    "calculateMEWS: all-normal vitals (most common in OPD overflow)",
    () => {
      calculateMEWS(ALL_NORMAL);
    },
    opts,
  );

  bench(
    "calculateMEWS: sepsis-pattern vitals (high-acuity branch heavy)",
    () => {
      calculateMEWS(SEPSIS_PROFILE);
    },
    opts,
  );

  bench(
    "calculateMEWS: hypotensive bradycardia (worst-case branch coverage)",
    () => {
      calculateMEWS(HYPOTENSIVE_BRADYCARDIA);
    },
    opts,
  );

  bench(
    "calculateMEWS: partial vitals (typical first-pass triage)",
    () => {
      calculateMEWS(PARTIAL_VITALS);
    },
    opts,
  );

  bench(
    "calculateMEWS: empty vitals (early-exit path)",
    () => {
      calculateMEWS(EMPTY_VITALS);
    },
    opts,
  );
});
