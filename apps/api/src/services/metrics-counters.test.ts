/**
 * Unit tests for the leaf-level AI counter registry that lives in
 * services/metrics-counters.ts. The file is intentionally minimal — a shared
 * prom-client Registry plus three metric instances (two Counters and a
 * Histogram) — and exists in its own module so that
 * services/ai/sarvam-logging.ts can bump the AI counters on the hot path
 * without pulling in the heavier services/metrics.ts (which would create an
 * import cycle through prompt-registry).
 *
 * What we verify here:
 *   - Each metric is registered on the shared `registry` under the exact
 *     `medcore_ai_*` name documented in OBSERVABILITY.md (Grafana + alert
 *     rules pin these names).
 *   - Counters increment monotonically by both .inc() and .inc(N).
 *   - Each unique label tuple is a distinct series (no accidental collapse).
 *   - Histogram .observe() records into the configured bucket layout
 *     (we assert the LLM-tuned long-tail buckets explicitly because they
 *     drive the latency alerting thresholds).
 *   - Counter.dec() is rejected at runtime (prom-client guarantees
 *     monotonicity).
 *   - Re-registering a metric of the same name on the same registry throws
 *     (singleton discipline — prevents two import paths from creating
 *     parallel counter instances that would silently halve recorded values).
 *
 * The registry is a process-wide singleton (shared with services/metrics.ts
 * and any test that imported it first), so every assertion is on a DELTA
 * around the operation rather than an absolute value.
 */

import { describe, it, expect } from "vitest";
import client from "prom-client";
import {
  registry,
  aiCallsTotal,
  aiCallDurationSeconds,
  aiCostInrTotal,
} from "./metrics-counters";

/**
 * Look up the current value of a counter series under an exact label tuple.
 * Returns 0 when the series has never been incremented (prom-client lazy-
 * materialises series, so a never-touched tuple has no entry in `values`).
 */
async function getCounterValue(
  counter: client.Counter<string>,
  labels: Record<string, string>,
): Promise<number> {
  const metric = await counter.get();
  const match = metric.values.find((v) =>
    Object.entries(labels).every(
      ([k, v2]) =>
        (v.labels as Record<string, string | number | undefined>)[k] === v2,
    ),
  );
  return match?.value ?? 0;
}

/**
 * Aggregate a histogram's observation count under an exact label tuple.
 * prom-client reports per-bucket cumulative counts; the `_count` series
 * (the un-bucketed total) is what we sum to verify .observe() landed.
 */
async function getHistogramCount(
  hist: client.Histogram<string>,
  labels: Record<string, string>,
): Promise<number> {
  const metric = await hist.get();
  const countSample = metric.values.find((v) => {
    if (!v.metricName?.endsWith("_count")) return false;
    return Object.entries(labels).every(
      ([k, v2]) =>
        (v.labels as Record<string, string | number | undefined>)[k] === v2,
    );
  });
  return (countSample?.value as number | undefined) ?? 0;
}

/** Sum of all `_bucket` series for a given label tuple, keyed by `le`. */
async function getHistogramBuckets(
  hist: client.Histogram<string>,
  labels: Record<string, string>,
): Promise<Record<string, number>> {
  const metric = await hist.get();
  const out: Record<string, number> = {};
  for (const v of metric.values) {
    if (!v.metricName?.endsWith("_bucket")) continue;
    const matches = Object.entries(labels).every(
      ([k, v2]) =>
        (v.labels as Record<string, string | number | undefined>)[k] === v2,
    );
    if (!matches) continue;
    const le = String(
      (v.labels as Record<string, string | number | undefined>).le,
    );
    out[le] = v.value as number;
  }
  return out;
}

describe("metrics-counters registry — registration discipline", () => {
  it("registers aiCallsTotal under the canonical medcore_ai_calls_total name", () => {
    expect(registry.getSingleMetric("medcore_ai_calls_total")).toBe(
      aiCallsTotal,
    );
  });

  it("registers aiCallDurationSeconds under the canonical medcore_ai_call_duration_seconds name", () => {
    expect(
      registry.getSingleMetric("medcore_ai_call_duration_seconds"),
    ).toBe(aiCallDurationSeconds);
  });

  it("registers aiCostInrTotal under the canonical medcore_ai_cost_inr_total name", () => {
    expect(registry.getSingleMetric("medcore_ai_cost_inr_total")).toBe(
      aiCostInrTotal,
    );
  });

  it("exposes registry as a prom-client Registry instance", () => {
    // Guards against an accidental switch to the default global registry,
    // which would let counters from other modules leak into our scrape.
    expect(registry).toBeInstanceOf(client.Registry);
  });

  it("rejects re-registering a metric with a name already on the registry", () => {
    // The singleton discipline matters because two parallel Counter instances
    // for medcore_ai_calls_total would each receive half the traffic, halving
    // observed values without any visible error. prom-client guards us here.
    expect(() => {
      new client.Counter({
        name: "medcore_ai_calls_total",
        help: "duplicate — should be rejected",
        labelNames: ["feature", "model", "outcome"] as const,
        registers: [registry],
      });
    }).toThrow(/already been registered/i);
  });
});

describe("aiCallsTotal — counter semantics", () => {
  it("increments by 1 on a plain .inc() call", async () => {
    const labels = {
      feature: "ai-calls-test-plain",
      model: "test-model",
      outcome: "success",
    };
    const before = await getCounterValue(aiCallsTotal, labels);
    aiCallsTotal.inc(labels);
    const after = await getCounterValue(aiCallsTotal, labels);
    expect(after - before).toBe(1);
  });

  it("increments by N on .inc(labels, N)", async () => {
    const labels = {
      feature: "ai-calls-test-bulk",
      model: "test-model",
      outcome: "success",
    };
    const before = await getCounterValue(aiCallsTotal, labels);
    aiCallsTotal.inc(labels, 7);
    const after = await getCounterValue(aiCallsTotal, labels);
    expect(after - before).toBe(7);
  });

  it("treats each unique (feature, model, outcome) tuple as a distinct series", async () => {
    // Two label tuples that differ only in outcome must NOT pollute each other.
    const success = {
      feature: "ai-calls-test-iso",
      model: "test-model",
      outcome: "success",
    };
    const error = {
      feature: "ai-calls-test-iso",
      model: "test-model",
      outcome: "error",
    };

    const successBefore = await getCounterValue(aiCallsTotal, success);
    const errorBefore = await getCounterValue(aiCallsTotal, error);

    aiCallsTotal.inc(success, 3);
    aiCallsTotal.inc(error, 5);

    const successAfter = await getCounterValue(aiCallsTotal, success);
    const errorAfter = await getCounterValue(aiCallsTotal, error);

    expect(successAfter - successBefore).toBe(3);
    expect(errorAfter - errorBefore).toBe(5);
  });

  it("supports the documented outcome label values (success | error | failover)", async () => {
    // Per the JSDoc on metrics-counters.ts:19. Pin the contract so an
    // accidental rename in the source surfaces as a test failure rather
    // than as a silently-missing Grafana series.
    for (const outcome of ["success", "error", "failover"]) {
      const labels = {
        feature: "ai-calls-outcome-pin",
        model: "test-model",
        outcome,
      };
      const before = await getCounterValue(aiCallsTotal, labels);
      aiCallsTotal.inc(labels);
      const after = await getCounterValue(aiCallsTotal, labels);
      expect(after - before).toBe(1);
    }
  });

  it("accumulates across sequential .inc() calls (event-loop atomicity)", async () => {
    // JS is single-threaded, so back-to-back .inc() calls are atomic by
    // construction. This test pins that behaviour against a future migration
    // to a different counter backend that might lose intermediate writes.
    const labels = {
      feature: "ai-calls-test-seq",
      model: "test-model",
      outcome: "success",
    };
    const before = await getCounterValue(aiCallsTotal, labels);

    for (let i = 0; i < 100; i++) aiCallsTotal.inc(labels);

    const after = await getCounterValue(aiCallsTotal, labels);
    expect(after - before).toBe(100);
  });

  it("accumulates across concurrent (Promise.all) .inc() calls", async () => {
    // Even though the event loop serialises each .inc(), this test mirrors
    // the real call pattern from services/ai/sarvam-logging.ts which fires
    // its inc() inside an async handler. It guards against a future
    // refactor introducing an await inside the inc path that could lose
    // increments under contention.
    const labels = {
      feature: "ai-calls-test-concurrent",
      model: "test-model",
      outcome: "success",
    };
    const before = await getCounterValue(aiCallsTotal, labels);

    await Promise.all(
      Array.from({ length: 50 }, () =>
        Promise.resolve().then(() => aiCallsTotal.inc(labels)),
      ),
    );

    const after = await getCounterValue(aiCallsTotal, labels);
    expect(after - before).toBe(50);
  });

  it("throws when called with a negative increment (counters are monotonic)", () => {
    // prom-client enforces monotonicity at the API boundary; rely on this
    // so an upstream bug attempting to "subtract a call" surfaces loudly
    // instead of silently producing nonsense rate() output.
    expect(() => {
      aiCallsTotal.inc(
        {
          feature: "ai-calls-test-neg",
          model: "test-model",
          outcome: "success",
        },
        -1,
      );
    }).toThrow();
  });
});

describe("aiCostInrTotal — counter semantics", () => {
  it("increments by a fractional amount (INR estimates are not integers)", async () => {
    // INR_PER_1K_TOKENS produces sub-rupee per-call deltas; verify the
    // counter accepts and accumulates floats correctly.
    const labels = { feature: "ai-cost-test-frac", model: "test-model" };
    const before = await getCounterValue(aiCostInrTotal, labels);
    aiCostInrTotal.inc(labels, 0.1234);
    aiCostInrTotal.inc(labels, 0.5678);
    const after = await getCounterValue(aiCostInrTotal, labels);
    // Float arithmetic — use closeTo with 1e-9 tolerance for sum precision.
    expect(after - before).toBeCloseTo(0.6912, 9);
  });

  it("uses only (feature, model) labels — NOT outcome (cost is per-call regardless)", async () => {
    // Distinguishes aiCostInrTotal from aiCallsTotal: spend is summed per
    // model and feature without an outcome dimension. Pin the label set so
    // an accidental added label doesn't fork the time series in Grafana.
    const metric = await aiCostInrTotal.get();
    // Every emitted sample's label set must be a subset of {feature, model}.
    const allowed = new Set(["feature", "model"]);
    for (const sample of metric.values) {
      for (const key of Object.keys(sample.labels)) {
        expect(allowed.has(key)).toBe(true);
      }
    }
  });

  it("accumulates monotonically across many increments", async () => {
    const labels = { feature: "ai-cost-test-many", model: "test-model" };
    const before = await getCounterValue(aiCostInrTotal, labels);
    for (let i = 0; i < 1000; i++) aiCostInrTotal.inc(labels, 0.001);
    const after = await getCounterValue(aiCostInrTotal, labels);
    expect(after - before).toBeCloseTo(1.0, 6);
  });
});

describe("aiCallDurationSeconds — histogram semantics", () => {
  it("records a single observation under the matching label tuple", async () => {
    const labels = { feature: "ai-dur-test-one", model: "test-model" };
    const before = await getHistogramCount(aiCallDurationSeconds, labels);
    aiCallDurationSeconds.observe(labels, 0.5);
    const after = await getHistogramCount(aiCallDurationSeconds, labels);
    expect(after - before).toBe(1);
  });

  it("accumulates multiple observations", async () => {
    const labels = { feature: "ai-dur-test-many", model: "test-model" };
    const before = await getHistogramCount(aiCallDurationSeconds, labels);
    for (const v of [0.05, 0.2, 1.5, 4.2, 25]) {
      aiCallDurationSeconds.observe(labels, v);
    }
    const after = await getHistogramCount(aiCallDurationSeconds, labels);
    expect(after - before).toBe(5);
  });

  it("emits the LLM-tuned long-tail buckets (0.1 … 60s)", async () => {
    // The bucket layout drives the latency alerting rules in
    // docs/OBSERVABILITY.md. Pin the exact upper bounds — any change here
    // requires a synchronized Grafana/alert update, so we want the test
    // to fail loudly when someone tweaks them in isolation.
    const labels = { feature: "ai-dur-test-buckets", model: "test-model" };
    aiCallDurationSeconds.observe(labels, 0.01);
    const buckets = await getHistogramBuckets(aiCallDurationSeconds, labels);
    const expectedLes = [
      "0.1",
      "0.25",
      "0.5",
      "1",
      "2",
      "5",
      "10",
      "20",
      "30",
      "60",
      "+Inf",
    ];
    for (const le of expectedLes) {
      expect(buckets[le]).toBeDefined();
    }
  });

  it("places observations into the correct cumulative buckets", async () => {
    // A 0.4s observation should fall into every bucket with le >= 0.5 and
    // none with le < 0.5. This proves the bucket assignment is correct,
    // which is what makes histogram_quantile() trustworthy in alerts.
    const labels = { feature: "ai-dur-test-placement", model: "test-model" };
    const before = await getHistogramBuckets(aiCallDurationSeconds, labels);
    aiCallDurationSeconds.observe(labels, 0.4);
    const after = await getHistogramBuckets(aiCallDurationSeconds, labels);

    // Delta-per-bucket so we are robust to other tests in the run that may
    // also have used this label combo on the shared singleton registry.
    const delta = (le: string) => (after[le] ?? 0) - (before[le] ?? 0);

    // Buckets BELOW the observation must not have ticked.
    expect(delta("0.1")).toBe(0);
    expect(delta("0.25")).toBe(0);
    // Buckets AT or ABOVE 0.5 must have ticked once (cumulative semantics).
    expect(delta("0.5")).toBe(1);
    expect(delta("1")).toBe(1);
    expect(delta("60")).toBe(1);
    expect(delta("+Inf")).toBe(1);
  });

  it("treats each (feature, model) tuple as a distinct histogram series", async () => {
    const a = { feature: "ai-dur-test-iso-a", model: "test-model" };
    const b = { feature: "ai-dur-test-iso-b", model: "test-model" };

    const aBefore = await getHistogramCount(aiCallDurationSeconds, a);
    const bBefore = await getHistogramCount(aiCallDurationSeconds, b);

    aiCallDurationSeconds.observe(a, 1.0);
    aiCallDurationSeconds.observe(a, 2.0);
    aiCallDurationSeconds.observe(b, 0.5);

    const aAfter = await getHistogramCount(aiCallDurationSeconds, a);
    const bAfter = await getHistogramCount(aiCallDurationSeconds, b);

    expect(aAfter - aBefore).toBe(2);
    expect(bAfter - bBefore).toBe(1);
  });

  it("supports startTimer() / end() ergonomics for ad-hoc timing", async () => {
    // The hot path in services/ai/sarvam-logging.ts uses .observe() directly,
    // but startTimer() is the prom-client idiom and a future refactor may
    // adopt it. Pin that it works against our histogram and registers as one
    // observation.
    const labels = { feature: "ai-dur-test-timer", model: "test-model" };
    const before = await getHistogramCount(aiCallDurationSeconds, labels);
    const end = aiCallDurationSeconds.startTimer(labels);
    end();
    const after = await getHistogramCount(aiCallDurationSeconds, labels);
    expect(after - before).toBe(1);
  });
});

describe("metrics-counters — Prometheus exposition format", () => {
  it("renders all three metric names when registry.metrics() is scraped", async () => {
    // Ensure a sample exists on each metric so they are emitted in the text
    // (prom-client omits a metric from .metrics() output when no series have
    // been materialised yet).
    aiCallsTotal.inc({
      feature: "exposition-test",
      model: "test-model",
      outcome: "success",
    });
    aiCallDurationSeconds.observe(
      { feature: "exposition-test", model: "test-model" },
      0.1,
    );
    aiCostInrTotal.inc(
      { feature: "exposition-test", model: "test-model" },
      0.42,
    );

    const text = await registry.metrics();
    expect(text).toMatch(/medcore_ai_calls_total/);
    expect(text).toMatch(/medcore_ai_call_duration_seconds/);
    expect(text).toMatch(/medcore_ai_cost_inr_total/);
  });

  it("emits the configured help string on each metric (for /api/metrics readers)", async () => {
    const text = await registry.metrics();
    expect(text).toMatch(/# HELP medcore_ai_calls_total /);
    expect(text).toMatch(/# HELP medcore_ai_call_duration_seconds /);
    expect(text).toMatch(/# HELP medcore_ai_cost_inr_total /);
  });

  it("declares correct # TYPE lines (two counters + one histogram)", async () => {
    const text = await registry.metrics();
    expect(text).toMatch(/# TYPE medcore_ai_calls_total counter/);
    expect(text).toMatch(/# TYPE medcore_ai_call_duration_seconds histogram/);
    expect(text).toMatch(/# TYPE medcore_ai_cost_inr_total counter/);
  });
});
