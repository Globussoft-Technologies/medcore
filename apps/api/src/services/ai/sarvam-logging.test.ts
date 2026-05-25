/**
 * Test-cron tick (2026-05-25) — sarvam-logging unit tests.
 *
 * What / which modules / why
 * ──────────────────────────
 * - WHAT: regression around the single exported entry point of
 *   `services/ai/sarvam-logging.ts` — `logAICall(opts)`. Pins:
 *   the three outcome buckets (success/error/failover) on the Prometheus
 *   counter, the latency histogram (clamped to >= 0 seconds), the cost
 *   counter being skipped when estimated cost <= 0, the trace-correlation
 *   fields being populated from `recordLLMSpan` (and silently dropped when
 *   it throws — telemetry must never break logging), the metrics try/catch
 *   that prevents a counter error from masking the AI call, and the
 *   structured stdout log line carrying `event: "ai_call"`, all opts
 *   fields, traceId/spanId, and an ISO `ts`.
 *
 * - MODULES: hoisted mocks of `../metrics-counters` (counters + histogram
 *   + cost counter) and `./tracing` (recordLLMSpan + estimateCostInr) so
 *   no Prometheus registry collisions and no OTel SDK init. console.log
 *   is stubbed per-test so we can assert the JSON shape without polluting
 *   test output. Mirrors the hoist pattern from `lab-intel.test.ts`.
 *
 * - WHY: this leaf module is on the hot path of every AI/LLM call site
 *   in the API. A regression that lets a metrics-error bubble out would
 *   take down every AI route at once; a regression that breaks the
 *   outcome bucket would silently corrupt the alerting view; a
 *   regression that stops emitting `traceId`/`spanId` would break the
 *   "click log → see trace" operator workflow. Each branch locked.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const {
  aiCallsTotalMock,
  aiCallDurationSecondsMock,
  aiCostInrTotalMock,
  recordLLMSpanMock,
  estimateCostInrMock,
} = vi.hoisted(() => ({
  aiCallsTotalMock: { inc: vi.fn() },
  aiCallDurationSecondsMock: { observe: vi.fn() },
  aiCostInrTotalMock: { inc: vi.fn() },
  recordLLMSpanMock: vi.fn(),
  estimateCostInrMock: vi.fn(),
}));

vi.mock("../metrics-counters", () => ({
  aiCallsTotal: aiCallsTotalMock,
  aiCallDurationSeconds: aiCallDurationSecondsMock,
  aiCostInrTotal: aiCostInrTotalMock,
}));

vi.mock("./tracing", () => ({
  recordLLMSpan: recordLLMSpanMock,
  estimateCostInr: estimateCostInrMock,
}));

import { logAICall } from "./sarvam-logging";

// ─── Helpers ──────────────────────────────────────────────────────────────

function baseOpts(over: Partial<Parameters<typeof logAICall>[0]> = {}) {
  return {
    feature: "scribe" as const,
    model: "sarvam-105b",
    promptTokens: 100,
    completionTokens: 50,
    latencyMs: 1234,
    ...over,
  };
}

function lastLogLine(): any {
  const spy = console.log as unknown as ReturnType<typeof vi.fn>;
  const last = spy.mock.calls[spy.mock.calls.length - 1];
  return JSON.parse(last[0] as string);
}

let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  aiCallsTotalMock.inc.mockReset();
  aiCallDurationSecondsMock.observe.mockReset();
  aiCostInrTotalMock.inc.mockReset();
  recordLLMSpanMock.mockReset();
  estimateCostInrMock.mockReset();
  // Safe defaults — tests that care override explicitly.
  recordLLMSpanMock.mockReturnValue({ traceId: "trace-abc", spanId: "span-xyz" });
  estimateCostInrMock.mockReturnValue(0.42);
  logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  logSpy.mockRestore();
});

// ─── Trace correlation ────────────────────────────────────────────────────

describe("logAICall — trace correlation", () => {
  it("populates traceId and spanId from recordLLMSpan", () => {
    recordLLMSpanMock.mockReturnValue({ traceId: "t-1", spanId: "s-1" });

    logAICall(baseOpts());

    const line = lastLogLine();
    expect(line.traceId).toBe("t-1");
    expect(line.spanId).toBe("s-1");
  });

  it("forwards every option field into recordLLMSpan", () => {
    logAICall(
      baseOpts({
        toolUsed: "emit_lab_intel",
        failover: true,
        metadata: { wordBoostCount: 7 },
      })
    );

    expect(recordLLMSpanMock).toHaveBeenCalledTimes(1);
    expect(recordLLMSpanMock).toHaveBeenCalledWith(
      expect.objectContaining({
        feature: "scribe",
        model: "sarvam-105b",
        promptTokens: 100,
        completionTokens: 50,
        latencyMs: 1234,
        toolUsed: "emit_lab_intel",
        failover: true,
        metadata: { wordBoostCount: 7 },
      })
    );
  });

  it("leaves traceId and spanId undefined when recordLLMSpan throws", () => {
    recordLLMSpanMock.mockImplementation(() => {
      throw new Error("otel boom");
    });

    expect(() => logAICall(baseOpts())).not.toThrow();

    const line = lastLogLine();
    expect(line.traceId).toBeUndefined();
    expect(line.spanId).toBeUndefined();
    // Metrics + stdout log still happen.
    expect(aiCallsTotalMock.inc).toHaveBeenCalledTimes(1);
    expect(line.event).toBe("ai_call");
  });

  it("leaves traceId/spanId undefined when recordLLMSpan returns an empty object", () => {
    recordLLMSpanMock.mockReturnValue({});

    logAICall(baseOpts());

    const line = lastLogLine();
    expect(line.traceId).toBeUndefined();
    expect(line.spanId).toBeUndefined();
  });
});

// ─── Outcome bucket ───────────────────────────────────────────────────────

describe("logAICall — outcome bucket on aiCallsTotal", () => {
  it("records outcome=success when there is no error and no failover", () => {
    logAICall(baseOpts());

    expect(aiCallsTotalMock.inc).toHaveBeenCalledWith({
      feature: "scribe",
      model: "sarvam-105b",
      outcome: "success",
    });
  });

  it("records outcome=error when an error message is present", () => {
    logAICall(baseOpts({ error: "sarvam timeout" }));

    expect(aiCallsTotalMock.inc).toHaveBeenCalledWith({
      feature: "scribe",
      model: "sarvam-105b",
      outcome: "error",
    });
  });

  it("records outcome=failover when failover=true (regardless of error)", () => {
    logAICall(baseOpts({ error: "primary down", failover: true }));

    expect(aiCallsTotalMock.inc).toHaveBeenCalledWith({
      feature: "scribe",
      model: "sarvam-105b",
      outcome: "failover",
    });
  });
});

// ─── Latency histogram ────────────────────────────────────────────────────

describe("logAICall — latency histogram", () => {
  it("observes latency converted from ms to seconds", () => {
    logAICall(baseOpts({ latencyMs: 2500 }));

    expect(aiCallDurationSecondsMock.observe).toHaveBeenCalledWith(
      { feature: "scribe", model: "sarvam-105b" },
      2.5
    );
  });

  it("clamps negative latency to 0 seconds", () => {
    logAICall(baseOpts({ latencyMs: -100 }));

    expect(aiCallDurationSecondsMock.observe).toHaveBeenCalledWith(
      { feature: "scribe", model: "sarvam-105b" },
      0
    );
  });

  it("handles latency of exactly 0", () => {
    logAICall(baseOpts({ latencyMs: 0 }));

    expect(aiCallDurationSecondsMock.observe).toHaveBeenCalledWith(
      { feature: "scribe", model: "sarvam-105b" },
      0
    );
  });
});

// ─── Cost counter ─────────────────────────────────────────────────────────

describe("logAICall — cost counter", () => {
  it("increments aiCostInrTotal when estimated cost is positive", () => {
    estimateCostInrMock.mockReturnValue(0.75);

    logAICall(baseOpts());

    expect(estimateCostInrMock).toHaveBeenCalledWith("sarvam-105b", 100, 50);
    expect(aiCostInrTotalMock.inc).toHaveBeenCalledWith(
      { feature: "scribe", model: "sarvam-105b" },
      0.75
    );
  });

  it("does NOT increment aiCostInrTotal when estimated cost is 0", () => {
    estimateCostInrMock.mockReturnValue(0);

    logAICall(baseOpts());

    expect(aiCostInrTotalMock.inc).not.toHaveBeenCalled();
  });

  it("does NOT increment aiCostInrTotal when estimated cost is negative", () => {
    estimateCostInrMock.mockReturnValue(-1);

    logAICall(baseOpts());

    expect(aiCostInrTotalMock.inc).not.toHaveBeenCalled();
  });
});

// ─── Metrics fault tolerance ──────────────────────────────────────────────

describe("logAICall — metrics try/catch", () => {
  it("swallows a counter exception and still emits the stdout log line", () => {
    aiCallsTotalMock.inc.mockImplementation(() => {
      throw new Error("registry exploded");
    });

    expect(() => logAICall(baseOpts())).not.toThrow();

    const line = lastLogLine();
    expect(line.event).toBe("ai_call");
    expect(line.feature).toBe("scribe");
  });

  it("swallows an estimateCostInr exception", () => {
    estimateCostInrMock.mockImplementation(() => {
      throw new Error("cost table missing");
    });

    expect(() => logAICall(baseOpts())).not.toThrow();

    // The cost counter must NOT be touched since the throw happened first.
    expect(aiCostInrTotalMock.inc).not.toHaveBeenCalled();
    // The stdout log still fires.
    expect(lastLogLine().event).toBe("ai_call");
  });
});

// ─── Structured stdout log ────────────────────────────────────────────────

describe("logAICall — structured stdout log", () => {
  it("emits a JSON line with the canonical event shape", () => {
    logAICall(
      baseOpts({
        toolUsed: "emit_x",
        failover: false,
        metadata: { k: "v" },
      })
    );

    const line = lastLogLine();
    expect(line.level).toBe("info");
    expect(line.event).toBe("ai_call");
    expect(line.feature).toBe("scribe");
    expect(line.model).toBe("sarvam-105b");
    expect(line.promptTokens).toBe(100);
    expect(line.completionTokens).toBe(50);
    expect(line.latencyMs).toBe(1234);
    expect(line.toolUsed).toBe("emit_x");
    expect(line.failover).toBe(false);
    expect(line.metadata).toEqual({ k: "v" });
    expect(line.traceId).toBe("trace-abc");
    expect(line.spanId).toBe("span-xyz");
    expect(typeof line.ts).toBe("string");
    // ISO-8601 — Date.prototype.toISOString shape.
    expect(line.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("emits the error field on the stdout log when error is set", () => {
    logAICall(baseOpts({ error: "sarvam 503" }));

    const line = lastLogLine();
    expect(line.error).toBe("sarvam 503");
  });

  it("emits batchIndex / batchSize / chunkCount when provided", () => {
    logAICall(
      baseOpts({
        batchIndex: 2,
        batchSize: 10,
        chunkCount: 4,
      })
    );

    const line = lastLogLine();
    expect(line.batchIndex).toBe(2);
    expect(line.batchSize).toBe(10);
    expect(line.chunkCount).toBe(4);
  });

  it("preserves the asr-sarvam feature through to all sinks", () => {
    logAICall(baseOpts({ feature: "asr-sarvam" }));

    expect(aiCallsTotalMock.inc).toHaveBeenCalledWith(
      expect.objectContaining({ feature: "asr-sarvam" })
    );
    expect(aiCallDurationSecondsMock.observe).toHaveBeenCalledWith(
      expect.objectContaining({ feature: "asr-sarvam" }),
      expect.any(Number)
    );
    expect(lastLogLine().feature).toBe("asr-sarvam");
  });

  it("invokes recordLLMSpan, all three counter sinks, and console.log exactly once each", () => {
    logAICall(baseOpts());

    expect(recordLLMSpanMock).toHaveBeenCalledTimes(1);
    expect(aiCallsTotalMock.inc).toHaveBeenCalledTimes(1);
    expect(aiCallDurationSecondsMock.observe).toHaveBeenCalledTimes(1);
    expect(aiCostInrTotalMock.inc).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledTimes(1);
  });
});
