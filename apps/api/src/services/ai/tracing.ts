// OpenTelemetry tracing wrapper for AI/LLM call paths.
//
// Design goals:
//   1. Zero blocking. OTel exporter and Langfuse must NEVER fail or slow down
//      a request. Every external call is wrapped in try/catch + best-effort.
//   2. Zero noise in tests. When neither OTEL_EXPORTER_OTLP_ENDPOINT nor
//      LANGFUSE_PUBLIC_KEY is set, this module is a complete no-op — no
//      network calls, no warnings, no SDK loaded.
//   3. Bundle size. The heavy SDK packages (@opentelemetry/sdk-trace-node,
//      @opentelemetry/exporter-trace-otlp-http, langfuse) are LAZY LOADED
//      inside the initialiser only when their respective env vars are set.
//      In dev/test the only OTel package pulled is @opentelemetry/api (~5KB).
//
// Public surface:
//   - withSpan<T>(name, attributes, fn) — wrap an async fn in an OTel span.
//   - recordLLMSpan(opts)               — synthesize a finished span from
//                                         logAICall data so every AI call
//                                         site gets coverage automatically
//                                         even without an explicit withSpan.
//   - getCurrentTraceContext()          — { traceId, spanId } of active span,
//                                         or undefined if none. Used by
//                                         sarvam-logging.ts to stitch the
//                                         structured log line to the trace.
//   - extractTraceparentMiddleware()    — Express middleware that reads the
//                                         W3C `traceparent` header from the
//                                         inbound request and starts a root
//                                         span so AI spans appear under it.
//
// Env-var matrix:
//   OTEL_EXPORTER_OTLP_ENDPOINT  optional  Enables OTel OTLP/HTTP exporter
//                                          (e.g. http://collector:4318/v1/traces).
//                                          When unset, withSpan still runs the
//                                          fn but emits NO spans.
//   OTEL_SERVICE_NAME            optional  Service name attribute. Default
//                                          "medcore-api".
//   LANGFUSE_PUBLIC_KEY          optional  Enables Langfuse adapter.
//   LANGFUSE_SECRET_KEY          optional  Required alongside PUBLIC_KEY.
//   LANGFUSE_BASEURL             optional  Override Langfuse host (self-hosted).

import {
  trace,
  context,
  SpanStatusCode,
  type Span,
  type Tracer,
  propagation,
  type Context,
} from "@opentelemetry/api";
import type { Request, Response, NextFunction } from "express";

// ── Cost table ────────────────────────────────────────────────────────────────
// Placeholder rates. OPS: update these from the actual Sarvam contract.
// Source-of-truth: contracts/sarvam-pricing-2026-Q2.pdf (TODO upload).
// Keys are model identifiers as passed by callers.

export const INR_PER_1K_TOKENS: Record<string, { prompt: number; completion: number }> = {
  // Placeholder rates — update with real Sarvam contract numbers.
  "sarvam-105b": { prompt: 0.5, completion: 1.5 },
  // Default fallback when an unknown model id appears.
  default: { prompt: 0.5, completion: 1.5 },
};

/** Estimate cost in INR for a given (model, prompt_tokens, completion_tokens). */
export function estimateCostInr(
  model: string,
  promptTokens: number,
  completionTokens: number
): number {
  const rate = INR_PER_1K_TOKENS[model] ?? INR_PER_1K_TOKENS["default"];
  return (
    (promptTokens / 1000) * rate.prompt + (completionTokens / 1000) * rate.completion
  );
}

// ── Lazy SDK initialisation ───────────────────────────────────────────────────

const SERVICE_NAME = process.env.OTEL_SERVICE_NAME ?? "medcore-api";
const TRACER_NAME = "medcore.ai";

let _tracer: Tracer | null = null;
let _otelInitialised = false;
let _otelEnabled = false;

let _langfuse: any = null;
let _langfuseInitialised = false;
let _langfuseEnabled = false;

/**
 * Lazy-load the OTel SDK and OTLP/HTTP exporter the first time withSpan is
 * called. Idempotent — guarded by `_otelInitialised`. When the env var is
 * unset we still set the flag so subsequent calls don't repeatedly probe.
 *
 * Wrapped in try/catch: a missing or broken SDK module must not break the
 * AI call path. Worst case the caller's fn still runs and we emit no span.
 */
function ensureOtelInitialised(): void {
  if (_otelInitialised) return;
  _otelInitialised = true;

  if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
    // No exporter configured — operate in pure no-op mode. trace.getTracer
    // still returns a usable Tracer (the global no-op tracer) but spans
    // produced by it are not exported anywhere.
    _otelEnabled = false;
    _tracer = trace.getTracer(TRACER_NAME);
    return;
  }

  try {
    // Lazy require — only pulled in when an exporter endpoint is set, so
    // the dev/test bundle stays small (just @opentelemetry/api).
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const sdkModule = require("@opentelemetry/sdk-trace-node");
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const exporterModule = require("@opentelemetry/exporter-trace-otlp-http");

    const { NodeTracerProvider, BatchSpanProcessor } = sdkModule as any;
    const { OTLPTraceExporter } = exporterModule as any;

    const exporter = new OTLPTraceExporter({
      url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
    });

    const provider = new NodeTracerProvider({
      resource: undefined,
      spanProcessors: [new BatchSpanProcessor(exporter)],
    });

    // Some sdk-trace-node minor versions still expect addSpanProcessor() —
    // tolerate either pattern by trying both.
    if (typeof (provider as any).addSpanProcessor === "function") {
      try {
        (provider as any).addSpanProcessor(new BatchSpanProcessor(exporter));
      } catch {
        /* already added via constructor option */
      }
    }

    provider.register();
    _tracer = trace.getTracer(TRACER_NAME);
    _otelEnabled = true;
  } catch {
    // SDK not installed (test env), or constructor signature changed.
    // Fall back silently to no-op. We still want a Tracer so withSpan can
    // exercise the same code path; it just won't export anything.
    _otelEnabled = false;
    _tracer = trace.getTracer(TRACER_NAME);
  }
}

function ensureLangfuseInitialised(): void {
  if (_langfuseInitialised) return;
  _langfuseInitialised = true;

  const pub = process.env.LANGFUSE_PUBLIC_KEY;
  const sec = process.env.LANGFUSE_SECRET_KEY;
  if (!pub || !sec) {
    _langfuseEnabled = false;
    return;
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const langfuseModule = require("langfuse");
    const Langfuse = (langfuseModule as any).Langfuse ?? langfuseModule.default;
    _langfuse = new Langfuse({
      publicKey: pub,
      secretKey: sec,
      baseUrl: process.env.LANGFUSE_BASEURL,
      // Important: never block the request thread on flushes.
      flushAt: 1,
      flushInterval: 1000,
    });
    _langfuseEnabled = true;
  } catch {
    _langfuseEnabled = false;
    _langfuse = null;
  }
}

/**
 * Whether the Langfuse adapter is configured. Exposed for tests.
 * (`isLangfuseEnabled()` calls `ensureLangfuseInitialised` first.)
 */
export function isLangfuseEnabled(): boolean {
  ensureLangfuseInitialised();
  return _langfuseEnabled;
}

/**
 * Whether OTel exporter is configured. Exposed for tests.
 */
export function isOtelEnabled(): boolean {
  ensureOtelInitialised();
  return _otelEnabled;
}

// ── withSpan wrapper ──────────────────────────────────────────────────────────

/**
 * Run `fn` inside an OTel span named `name` with the given attributes.
 *
 * Behaviour:
 *   - When OTEL_EXPORTER_OTLP_ENDPOINT is unset: just runs `fn` (no span).
 *   - When set: starts a span, runs `fn` in its context, records errors and
 *     end time, then returns the fn's value.
 *   - On exception: span is marked ERROR with the message and re-thrown.
 *
 * Signature:
 *   `withSpan<T>(name: string, attributes: Record<string, AttributeValue>, fn: (span?: Span) => Promise<T>): Promise<T>`
 *
 * The `fn` receives the span so the caller can attach extra attributes
 * (token counts, cost, etc.) computed during execution.
 */
export async function withSpan<T>(
  name: string,
  attributes: Record<string, string | number | boolean | undefined>,
  fn: (span?: Span) => Promise<T>
): Promise<T> {
  ensureOtelInitialised();

  // No-op fast path: skip span creation entirely. This keeps the hot path
  // free of OTel overhead in dev/test where no exporter is configured.
  if (!_otelEnabled || !_tracer) {
    return fn(undefined);
  }

  // Filter out undefined values — OTel rejects them with a console warning.
  const cleanAttrs: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(attributes)) {
    if (v !== undefined) cleanAttrs[k] = v;
  }

  const span = _tracer.startSpan(name, {
    attributes: { "service.name": SERVICE_NAME, ...cleanAttrs },
  });

  try {
    const ctx = trace.setSpan(context.active(), span);
    const result = await context.with(ctx, () => fn(span));
    span.setStatus({ code: SpanStatusCode.OK });
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try {
      span.setStatus({ code: SpanStatusCode.ERROR, message });
      span.setAttribute("ai.error", message);
      if (err instanceof Error) span.recordException(err);
    } catch {
      /* never let telemetry mask the original error */
    }
    throw err;
  } finally {
    try {
      span.end();
    } catch {
      /* ignore — span may already be ended in a race */
    }
  }
}

// ── Synthesize a span from logAICall data ─────────────────────────────────────

interface RecordLLMSpanOpts {
  feature: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  error?: string;
  toolUsed?: string;
  failover?: boolean;
  metadata?: Record<string, unknown>;
}

/**
 * Synthesize a finished OTel span from the data already passed to logAICall().
 * This guarantees every AI call site gets trace coverage with zero per-site
 * refactoring — sarvam-logging.ts calls this on every logAICall().
 *
 * The span starts at (now - latencyMs) and ends at now, so it appears under
 * the active parent span (typically the inbound HTTP request span) with the
 * correct duration.
 *
 * Also fires the Langfuse adapter if configured, fire-and-forget.
 */
export function recordLLMSpan(opts: RecordLLMSpanOpts): { traceId?: string; spanId?: string } {
  ensureOtelInitialised();
  ensureLangfuseInitialised();

  const costInr = estimateCostInr(opts.model, opts.promptTokens, opts.completionTokens);

  const attrs: Record<string, string | number | boolean> = {
    "ai.feature": opts.feature,
    "ai.model": opts.model,
    "ai.prompt_tokens": opts.promptTokens,
    "ai.completion_tokens": opts.completionTokens,
    "ai.latency_ms": opts.latencyMs,
    "ai.cost_inr": costInr,
  };
  if (opts.error) attrs["ai.error"] = opts.error;
  if (opts.toolUsed) attrs["ai.tool_used"] = opts.toolUsed;
  if (opts.failover) attrs["ai.failover"] = true;

  let traceId: string | undefined;
  let spanId: string | undefined;

  // OTel: fire only if exporter configured. Errors are swallowed.
  if (_otelEnabled && _tracer) {
    try {
      const startTime = Date.now() - Math.max(0, opts.latencyMs);
      const span = _tracer.startSpan(
        `ai.${opts.feature}`,
        {
          attributes: { "service.name": SERVICE_NAME, ...attrs },
          startTime,
        }
      );
      const sc = span.spanContext();
      traceId = sc.traceId;
      spanId = sc.spanId;
      if (opts.error) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: opts.error });
      } else {
        span.setStatus({ code: SpanStatusCode.OK });
      }
      span.end();
    } catch {
      /* never block the log path */
    }
  } else {
    // Even when OTel exporter is off, an active span (set by an explicit
    // withSpan up the stack) is still discoverable via the context API.
    const active = trace.getActiveSpan();
    if (active) {
      const sc = active.spanContext();
      traceId = sc.traceId;
      spanId = sc.spanId;
    }
  }

  // Langfuse: fire-and-forget. 100ms timeout enforced by Promise.race.
  if (_langfuseEnabled && _langfuse) {
    sendToLangfuse(opts, costInr).catch(() => {
      /* swallowed by design */
    });
  }

  return { traceId, spanId };
}

async function sendToLangfuse(opts: RecordLLMSpanOpts, costInr: number): Promise<void> {
  try {
    const generation = _langfuse?.generation?.({
      name: `ai.${opts.feature}`,
      model: opts.model,
      input: opts.metadata,
      usage: {
        input: opts.promptTokens,
        output: opts.completionTokens,
        total: opts.promptTokens + opts.completionTokens,
        unit: "TOKENS",
      },
      metadata: {
        feature: opts.feature,
        toolUsed: opts.toolUsed,
        failover: !!opts.failover,
        latencyMs: opts.latencyMs,
        costInr,
        error: opts.error,
      },
    });
    if (opts.error) {
      generation?.update?.({ statusMessage: opts.error, level: "ERROR" });
    }
    generation?.end?.();

    // Best-effort flush with a 100ms hard timeout so we never block.
    const flushPromise = _langfuse?.flushAsync?.() ?? Promise.resolve();
    await Promise.race([
      flushPromise,
      new Promise<void>((resolve) => setTimeout(resolve, 100)),
    ]);
  } catch {
    /* swallow — Langfuse send must never affect the request path */
  }
}

// ── Trace context helpers ─────────────────────────────────────────────────────

/**
 * Pull the trace_id and span_id of the currently-active span (if any).
 * Returns undefined fields when there's no active span — callers must
 * handle that case (e.g. omit the field from their log line).
 *
 * Used by sarvam-logging.ts so structured logs carry the same trace_id
 * as the OTel span for a given LLM call.
 */
export function getCurrentTraceContext(): { traceId?: string; spanId?: string } {
  const span = trace.getActiveSpan();
  if (!span) return {};
  const sc = span.spanContext();
  return { traceId: sc.traceId, spanId: sc.spanId };
}

/**
 * Express middleware: read the W3C `traceparent` header from the inbound
 * request and bind it to the OTel context for the lifetime of that request.
 * Subsequent withSpan / recordLLMSpan calls produced while serving the
 * request will appear as children of the inbound trace in the trace UI.
 *
 * Always safe to mount — when no `traceparent` header is present, OTel's
 * propagator returns the active context unchanged.
 */
export function extractTraceparentMiddleware() {
  return (req: Request, _res: Response, next: NextFunction) => {
    try {
      const carrier: Record<string, string> = {};
      const tp = req.headers["traceparent"];
      const ts = req.headers["tracestate"];
      if (typeof tp === "string") carrier["traceparent"] = tp;
      if (typeof ts === "string") carrier["tracestate"] = ts;

      const extractedCtx: Context = propagation.extract(context.active(), carrier);
      // Run the rest of the request inside the extracted context so any
      // span created by withSpan downstream becomes a child of the inbound
      // trace. context.with's callback is invoked synchronously; Express
      // continues the chain inside it via next().
      context.with(extractedCtx, () => next());
    } catch {
      // If header parsing throws for any reason, fall through unchanged
      // rather than 500-ing the request.
      next();
    }
  };
}
