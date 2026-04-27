// Prometheus-compatible metrics surface for MedCore.
//
// Scraped by Prometheus from http://localhost:4100/api/metrics (no auth — the
// endpoint is bound to localhost in prod and only accessible to the Prom
// agent on the same host). Also consumed by Grafana dashboards and the
// alerting rules documented in docs/OBSERVABILITY.md.
//
// Keep label cardinality LOW. Never label by raw user id / patient id / tenant
// id — those would explode the metric series count. Use `req.route?.path`
// (the template, e.g. `/api/v1/patients/:id`) for the http `path` label.

import type { Request, Response, NextFunction, Express } from "express";
import client from "prom-client";
import {
  registry,
  aiCallsTotal,
  aiCallDurationSeconds,
  aiCostInrTotal,
} from "./metrics-counters";
import { logAICall as rawLogAICall } from "./ai/sarvam-logging";
import { getOldestPromptCacheAgeSeconds } from "./ai/prompt-registry";
import { extractTraceparentMiddleware } from "./ai/tracing";

// ── Registry ──────────────────────────────────────────────────────────────────
// Dedicated registry (not the global default) so tests can clear/restart it
// cleanly without stomping on other services that may use prom-client. Shared
// with services/metrics-counters.ts which hosts the AI-path counters.

export { registry, aiCallsTotal, aiCallDurationSeconds, aiCostInrTotal };

// Default process metrics (event loop lag, CPU, memory, handles, etc.). These
// are tiny, cheap, and invaluable during incidents.
client.collectDefaultMetrics({ register: registry, prefix: "medcore_" });

// ── HTTP metrics ──────────────────────────────────────────────────────────────

export const httpRequestsTotal = new client.Counter({
  name: "medcore_http_requests_total",
  help: "Total HTTP requests handled, labeled by method/path/status",
  labelNames: ["method", "path", "status"] as const,
  registers: [registry],
});

export const httpRequestDurationSeconds = new client.Histogram({
  name: "medcore_http_request_duration_seconds",
  help: "HTTP request latency in seconds",
  labelNames: ["method", "path"] as const,
  // Tuned for typical API latencies (sub-second) plus tail visibility.
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

// ── AI metrics ────────────────────────────────────────────────────────────────
// aiCallsTotal / aiCallDurationSeconds live in services/metrics-counters.ts
// and are re-exported at the top of this file. They are incremented directly
// from services/ai/sarvam-logging.ts whenever logAICall() fires so every AI
// feature gets coverage without needing to thread counter imports everywhere.

// ── Auth metrics ──────────────────────────────────────────────────────────────

export const authLoginTotal = new client.Counter({
  name: "medcore_auth_login_total",
  help: "Total login attempts, labeled by outcome (success|invalid|rate_limited)",
  labelNames: ["outcome"] as const,
  registers: [registry],
});

// ── Ops gauges ────────────────────────────────────────────────────────────────

export const rateLimitsEnabled = new client.Gauge({
  name: "medcore_rate_limits_enabled",
  help: "1 when rate limiting is enforced, 0 when DISABLE_RATE_LIMITS=true",
  registers: [registry],
  collect() {
    const disabled = process.env.DISABLE_RATE_LIMITS === "true";
    this.set(disabled ? 0 : 1);
  },
});

export const promptCacheAgeSeconds = new client.Gauge({
  name: "medcore_prompt_cache_age_seconds",
  help: "Age (seconds) of the oldest entry in the in-memory prompt cache (0 when empty)",
  registers: [registry],
  collect() {
    try {
      this.set(getOldestPromptCacheAgeSeconds());
    } catch {
      // Never let a metric-collection error take down /api/metrics.
      this.set(0);
    }
  },
});

// ── logAICall re-export ───────────────────────────────────────────────────────
//
// The canonical logAICall lives in services/ai/sarvam-logging.ts and already
// bumps the aiCallsTotal / aiCallDurationSeconds counters. Re-exported here
// so callers that prefer the centralised observability import (`from
// services/metrics`) don't need to reach into the AI subtree.

export const logAICall = rawLogAICall;

// ── HTTP middleware ───────────────────────────────────────────────────────────

/**
 * Express middleware: times every request and records it under the sanitized
 * route template (not the real URL, which would explode cardinality — e.g.
 * /api/v1/patients/abc-123 collapses to /api/v1/patients/:id).
 */
export function httpMetricsMiddleware() {
  return (req: Request, res: Response, next: NextFunction) => {
    const end = httpRequestDurationSeconds.startTimer();
    res.on("finish", () => {
      // Prefer the Express route template (available after routing matched).
      // Fall back to `<unmatched>` so 404s don't pollute the `path` label
      // with every random URL a scanner tries.
      const routePath =
        (req as any).route?.path ??
        (req.baseUrl ? req.baseUrl + ((req as any).route?.path ?? "") : null) ??
        "<unmatched>";
      // baseUrl may be undefined at this point for unmatched routes. Combine
      // with route.path when both are present to produce the full template.
      const fullTemplate =
        req.baseUrl && (req as any).route?.path
          ? `${req.baseUrl}${(req as any).route.path}`
          : routePath;
      const labels = {
        method: req.method,
        path: fullTemplate,
        status: String(res.statusCode),
      };
      httpRequestsTotal.inc(labels);
      end({ method: req.method, path: fullTemplate });
    });
    next();
  };
}

// ── Public wiring ─────────────────────────────────────────────────────────────

/**
 * Mount the metrics middleware + /api/metrics endpoint onto an Express app.
 * Called once at the top of app.ts via a single `registerMetrics(app)` line —
 * see docs/OBSERVABILITY.md for the exact snippet.
 *
 * NOTE: The middleware must be registered BEFORE any router mounts so that
 * res.on("finish") fires for every route, but AFTER body-parsers is fine —
 * we only read method/path/status.
 */
export function registerMetrics(app: Express): void {
  // Bind any inbound W3C `traceparent` to the OTel context BEFORE the
  // metrics timer middleware so spans created during the request appear
  // under the upstream trace. No-op when the OTel exporter is not
  // configured (dev/test default) — see services/ai/tracing.ts.
  app.use(extractTraceparentMiddleware());
  app.use(httpMetricsMiddleware());

  app.get("/api/metrics", async (_req, res) => {
    try {
      res.setHeader("Content-Type", "text/plain; version=0.0.4");
      res.end(await registry.metrics());
    } catch (err) {
      res.status(500).end(String(err));
    }
  });
}
