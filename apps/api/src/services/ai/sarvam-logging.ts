// Shared observability helper for AI call paths.
//
// Split out of sarvam.ts so auxiliary modules (model-router, prompt-registry,
// provider adapters) can log without triggering a circular import back into
// sarvam.ts's wrappers.
//
// Side effects on every call:
//   1. Emits a structured JSON log line to stdout (ai_call event), now
//      including OTel `traceId` / `spanId` so the log line and the trace
//      span for the same LLM call can be correlated by ID.
//   2. Bumps the Prometheus counters from services/metrics-counters.ts:
//        - medcore_ai_calls_total{feature,model,outcome}
//        - medcore_ai_call_duration_seconds{feature,model}
//        - medcore_ai_cost_inr_total{feature,model}
//   3. Synthesizes an OTel span (no-op when OTEL_EXPORTER_OTLP_ENDPOINT is
//      unset) and best-effort fires the call to Langfuse if configured.
//      All three sinks are non-blocking — see services/ai/tracing.ts.

import {
  aiCallsTotal,
  aiCallDurationSeconds,
  aiCostInrTotal,
} from "../metrics-counters";
import { recordLLMSpan, estimateCostInr } from "./tracing";

export function logAICall(opts: {
  feature:
    | "triage"
    | "scribe"
    | "drug-safety"
    | "hallucination-check"
    | "chart-search-rerank"
    | "report-explainer"
    | "letter-generator"
    | "adherence-bot"
    | "er-triage"
    | "pharmacy-forecast"
    | "model-router"
    // ASR provider path — currently Sarvam-only (AssemblyAI/Deepgram were
    // removed on 2026-04-25 due to non-India data residency).
    | "asr-sarvam";
  model: string;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  toolUsed?: string;
  error?: string;
  batchIndex?: number;
  batchSize?: number;
  chunkCount?: number;
  /**
   * Set by the multi-provider router when the primary provider failed and we
   * fell through to a backup. Flagged in logs so an alerting rule can track
   * Sarvam outage minutes without grepping for stack traces.
   */
  failover?: boolean;
  /**
   * Free-form structured context. Used by e.g. the ASR providers to log the
   * number of medical-vocabulary terms sent as `word_boost` / `keywords`, so
   * an operator can verify from logs that PRD §4.5.2 tuning actually fired
   * without a debugger attached. Kept intentionally open so new features can
   * attach a handful of call-specific fields without widening this signature.
   */
  metadata?: Record<string, unknown>;
}): void {
  // ── Trace correlation ─────────────────────────────────────────────────────
  // recordLLMSpan returns the trace_id / span_id of the synthesized span so
  // the JSON log line we emit below can carry the same IDs. When the OTel
  // exporter is unset, both are undefined and we just skip the fields.
  let traceId: string | undefined;
  let spanId: string | undefined;
  try {
    const trace = recordLLMSpan({
      feature: opts.feature,
      model: opts.model,
      promptTokens: opts.promptTokens,
      completionTokens: opts.completionTokens,
      latencyMs: opts.latencyMs,
      error: opts.error,
      toolUsed: opts.toolUsed,
      failover: opts.failover,
      metadata: opts.metadata,
    });
    traceId = trace.traceId;
    spanId = trace.spanId;
  } catch {
    // Telemetry must never break logging.
  }

  // ── Prometheus counters ───────────────────────────────────────────────────
  try {
    const outcome: "success" | "error" | "failover" = opts.failover
      ? "failover"
      : opts.error
        ? "error"
        : "success";
    aiCallsTotal.inc({ feature: opts.feature, model: opts.model, outcome });
    aiCallDurationSeconds.observe(
      { feature: opts.feature, model: opts.model },
      Math.max(0, opts.latencyMs) / 1000
    );
    const costInr = estimateCostInr(
      opts.model,
      opts.promptTokens,
      opts.completionTokens
    );
    if (costInr > 0) {
      aiCostInrTotal.inc({ feature: opts.feature, model: opts.model }, costInr);
    }
  } catch {
    // Never let a metric error mask the underlying AI call.
  }

  // ── Structured stdout log ─────────────────────────────────────────────────
  console.log(
    JSON.stringify({
      level: "info",
      event: "ai_call",
      ...opts,
      // Correlation fields are only populated when an OTel span was created.
      // Keeping them adjacent to the call data so a single jq filter can pull
      // both the log line and the corresponding trace.
      traceId,
      spanId,
      ts: new Date().toISOString(),
    })
  );
}
