// Leaf-level counter definitions used by services/ai/sarvam-logging.ts and
// re-exported via services/metrics.ts. Kept in its own file so the
// observability import graph is:
//
//   metrics.ts  ─▶  metrics-counters.ts  ◀─  sarvam-logging.ts
//
// i.e. no cycles. If you need another metric that AI code paths should bump
// on the hot path, add it here so the sarvam-logging leaf can reach it
// without pulling in the full metrics.ts (which in turn imports prompt-registry).

import client, { Registry } from "prom-client";

/** Shared registry. Singleton so every counter lands on the same scrape target. */
export const registry: Registry = new client.Registry();

export const aiCallsTotal = new client.Counter({
  name: "medcore_ai_calls_total",
  help: "Total AI/LLM calls made, labeled by feature/model/outcome",
  // outcome: "success" | "error" | "failover"
  labelNames: ["feature", "model", "outcome"] as const,
  registers: [registry],
});

export const aiCallDurationSeconds = new client.Histogram({
  name: "medcore_ai_call_duration_seconds",
  help: "AI/LLM call latency in seconds",
  labelNames: ["feature", "model"] as const,
  // LLM calls are slow — need long tail buckets for alerting.
  buckets: [0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 30, 60],
  registers: [registry],
});

/**
 * Running INR spend per (feature, model). Incremented on every logAICall()
 * by an estimate derived from a per-model rate table in services/ai/tracing.ts
 * (INR_PER_1K_TOKENS). This is a Counter, not a Gauge — Prometheus's `rate()`
 * gives spend-per-second over any time window for budgeting / alerting.
 *
 * NOTE: Uses prom-client's Counter rather than Gauge despite the .total
 * suffix in the metric name because cumulative spend is a strictly
 * monotonically-increasing quantity. `rate(...total[1h]) * 3600` yields
 * hourly INR spend and survives process restarts (Prometheus handles the
 * counter reset).
 */
export const aiCostInrTotal = new client.Counter({
  name: "medcore_ai_cost_inr_total",
  help: "Running INR cost estimate of AI/LLM calls, derived from per-model rate table",
  labelNames: ["feature", "model"] as const,
  registers: [registry],
});
