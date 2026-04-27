# MedCore Observability

MedCore exports runtime health, request, and AI-pipeline metrics in
Prometheus exposition format on `GET /api/metrics` (no authentication — the
endpoint is bound to localhost in production and scraped by the Prometheus
agent running on the same host).

This document covers:

1. What metrics are exported
2. How to scrape with Prometheus
3. A starter Grafana panel JSON
4. Alerting rule templates

---

## 1. Exported metrics

| Metric | Type | Labels | Purpose |
| --- | --- | --- | --- |
| `medcore_http_requests_total` | Counter | `method, path, status` | Count of HTTP requests. `path` is the route template (e.g. `/api/v1/patients/:id`), never the raw URL — keeps cardinality low. |
| `medcore_http_request_duration_seconds` | Histogram | `method, path` | Per-request latency. Buckets are tuned for sub-second API traffic with tail visibility up to 10s. |
| `medcore_ai_calls_total` | Counter | `feature, model, outcome` | One increment per `logAICall()` firing. `outcome` is `success`, `error`, or `failover` (primary LLM provider failed, backup answered). |
| `medcore_ai_call_duration_seconds` | Histogram | `feature, model` | LLM call latency. Buckets extend to 60s because medical reasoning prompts can run long. |
| `medcore_ai_cost_inr_total` | Counter | `feature, model` | Running INR cost estimate of LLM calls. Derived from a per-model rate table in `services/ai/tracing.ts`. See §5.3 for spend queries. |
| `medcore_auth_login_total` | Counter | `outcome` | `success`, `invalid` (bad user/password), or `rate_limited` (hit the auth rate limiter). |
| `medcore_rate_limits_enabled` | Gauge | — | `1` when rate limiting is active, `0` when the `DISABLE_RATE_LIMITS=true` escape hatch is set. Alert if this stays at 0 outside a maintenance window. |
| `medcore_prompt_cache_age_seconds` | Gauge | — | Age of the oldest prompt cached in memory by the prompt registry. Sanity check — should stay under the cache TTL (60s). |
| `medcore_process_*` / `medcore_nodejs_*` | various | — | Default Node.js process metrics: event loop lag, CPU, memory RSS, open handles, GC. Supplied by `prom-client`'s `collectDefaultMetrics`. |

### AI pipeline coverage

Every MedCore AI feature routes through `services/ai/sarvam-logging.ts::logAICall()`.
That single helper:

- emits a structured JSON log line (consumed by the existing log aggregator), AND
- bumps `medcore_ai_calls_total` and `medcore_ai_call_duration_seconds`.

New AI features are automatically covered as long as they call `logAICall()` —
no per-feature wiring required.

---

## 2. Prometheus scrape config

Add to your Prometheus `prometheus.yml`:

```yaml
scrape_configs:
  - job_name: medcore-api
    metrics_path: /api/metrics
    scrape_interval: 15s
    scrape_timeout: 10s
    static_configs:
      - targets: ["localhost:4100"]
        labels:
          service: medcore-api
          env: production
```

Change `4100` to whatever `PORT` the API is running on (`apps/api` listens on
`PORT` from env, default `4000`). On the prod server the API is fronted by
nginx which does NOT expose `/api/metrics` to the public — internal-only.

---

## 3. Grafana panel snippets

Drop either of these into the "Add panel → Query" box of a new dashboard. They
use PromQL — no plugin required.

### 3.1 Request rate by route (top 10)

```json
{
  "type": "timeseries",
  "title": "MedCore: Request rate by route",
  "targets": [
    {
      "expr": "topk(10, sum by (path) (rate(medcore_http_requests_total[5m])))",
      "legendFormat": "{{path}}"
    }
  ]
}
```

### 3.2 AI call success ratio

```json
{
  "type": "stat",
  "title": "AI call success ratio (1h)",
  "targets": [
    {
      "expr": "sum(rate(medcore_ai_calls_total{outcome=\"success\"}[1h])) / sum(rate(medcore_ai_calls_total[1h]))"
    }
  ],
  "options": { "unit": "percentunit", "reduceOptions": { "values": false } }
}
```

### 3.3 p95 request latency

```promql
histogram_quantile(0.95,
  sum by (le, path) (rate(medcore_http_request_duration_seconds_bucket[5m]))
)
```

---

## 4. Alerting rule templates

Drop into a Prometheus rule file (e.g. `medcore.rules.yml`) and include it
under `rule_files:` in `prometheus.yml`. Alerts route into your existing
PagerDuty / Alertmanager config.

```yaml
groups:
  - name: medcore-http
    rules:
      - alert: MedCoreHigh5xxRate
        # More than 1% of requests returning 5xx over the last 5 minutes.
        expr: |
          sum(rate(medcore_http_requests_total{status=~"5.."}[5m]))
            /
          sum(rate(medcore_http_requests_total[5m]))
            > 0.01
        for: 5m
        labels:
          severity: page
          team: backend
        annotations:
          summary: "MedCore API 5xx rate > 1% for 5m"
          runbook: "docs/OPERATIONS_FAQ.md#5xx-spike"

      - alert: MedCoreHighLatencyP95
        expr: |
          histogram_quantile(0.95,
            sum by (le) (rate(medcore_http_request_duration_seconds_bucket[5m]))
          ) > 2
        for: 10m
        labels: { severity: warn, team: backend }
        annotations:
          summary: "MedCore p95 latency > 2s for 10m"

  - name: medcore-ai
    rules:
      - alert: MedCoreAIErrorRate
        # AI calls erroring at > 5% over 10 minutes.
        expr: |
          sum(rate(medcore_ai_calls_total{outcome="error"}[10m]))
            /
          sum(rate(medcore_ai_calls_total[10m]))
            > 0.05
        for: 10m
        labels: { severity: page, team: ai }
        annotations:
          summary: "MedCore AI error rate > 5%"
          runbook: "docs/AI_ARCHITECTURE.md#incident-response"

      - alert: MedCoreAIFailoverActive
        # Any failover activity — primary LLM provider likely degraded.
        expr: sum(rate(medcore_ai_calls_total{outcome="failover"}[5m])) > 0
        for: 5m
        labels: { severity: warn, team: ai }
        annotations:
          summary: "MedCore LLM primary provider failing over to backup"

  - name: medcore-auth
    rules:
      - alert: MedCoreAuthAttack
        # >20 rate-limited logins per minute — likely a credential-stuffing run.
        expr: sum(rate(medcore_auth_login_total{outcome="rate_limited"}[1m])) > 20
        for: 2m
        labels: { severity: page, team: security }
        annotations:
          summary: "Elevated rate-limited login attempts"

  - name: medcore-ops
    rules:
      - alert: MedCoreRateLimitsOff
        # Rate limiting disabled outside a planned-window. The gauge is 0 only
        # when DISABLE_RATE_LIMITS=true — should be temporary.
        expr: medcore_rate_limits_enabled == 0
        for: 1h
        labels: { severity: warn, team: ops }
        annotations:
          summary: "Rate limits disabled for >1h — verify this is intentional"
```

---

## 5. AI tracing (OpenTelemetry + Langfuse)

PRD §6 requires "per-request trace including prompt, model, RAG hits,
latency, cost." MedCore satisfies this with:

- **OpenTelemetry traces** around every LLM call (OTLP/HTTP exporter).
- A **Langfuse adapter** for prompt/output inspection when debugging
  hallucinations or regressions.
- Structured `ai_call` log lines that carry the OTel `trace_id` /
  `span_id`, so `grep`-the-logs and the trace UI stay correlated.
- A new Prometheus counter, `medcore_ai_cost_inr_total{feature,model}`,
  for budgeting and burn-rate alerting.

### 5.1 Env-var matrix

| Variable | Required? | Effect |
| --- | --- | --- |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | optional | When set (e.g. `http://otel-collector:4318/v1/traces`), `withSpan` and `recordLLMSpan` export OTel spans via OTLP/HTTP. When unset, both are no-ops — dev/test default. |
| `OTEL_SERVICE_NAME` | optional | Service-name attribute on every span. Default `medcore-api`. |
| `LANGFUSE_PUBLIC_KEY` + `LANGFUSE_SECRET_KEY` | optional | When both set, every LLM call is fire-and-forget mirrored to Langfuse with a 100ms timeout. Either missing → adapter disabled, no SDK loaded. |
| `LANGFUSE_BASEURL` | optional | Self-hosted Langfuse host. Default is Langfuse Cloud. |

The OTel SDK packages (`@opentelemetry/sdk-trace-node`,
`@opentelemetry/exporter-trace-otlp-http`) and the `langfuse` SDK are
**lazy-loaded** the first time a span is recorded — when the env vars are
unset, none of them are pulled into memory.

### 5.2 What you get per call

Every `logAICall()` invocation produces:

1. A structured stdout log line (already in place) now augmented with
   `traceId` / `spanId`.
2. A finished OTel span named `ai.<feature>` with attributes:
   `ai.feature`, `ai.model`, `ai.prompt_tokens`, `ai.completion_tokens`,
   `ai.latency_ms`, `ai.cost_inr` (and `ai.error` / `ai.tool_used` /
   `ai.failover` when applicable).
3. An increment to `medcore_ai_cost_inr_total{feature, model}` derived
   from a per-model rate table in `services/ai/tracing.ts`
   (`INR_PER_1K_TOKENS`). **OPS:** update those rates from the actual
   Sarvam contract.
4. A best-effort Langfuse `generation` event when the adapter is
   configured.

Inbound HTTP requests' `traceparent` header is bound to the OTel context
by middleware mounted in `registerMetrics(app)`, so AI spans appear under
the request span in your trace UI without any per-route wiring.

### 5.3 Computing spend from the cost gauge

```promql
# INR / hour, by feature
sum by (feature) (rate(medcore_ai_cost_inr_total[1h])) * 3600

# Total spend in the last 24h
sum(increase(medcore_ai_cost_inr_total[24h]))

# Burn rate (alert if > ₹X / hour for 30 min)
sum(rate(medcore_ai_cost_inr_total[5m])) * 3600 > 500
```

Because `medcore_ai_cost_inr_total` is a Counter, it survives process
restarts via Prometheus's standard counter-reset handling.

### 5.4 Debugging a misbehaving prompt via Langfuse

1. Find the offending request in stdout logs by searching for
   `event":"ai_call"`. Capture the `traceId` from the JSON line.
2. In the Langfuse UI, search for the same trace ID — every LLM call we
   make is annotated with the feature name and metadata (failover flag,
   tool used, latency, estimated cost).
3. Inspect the prompt template (versioned in `prompt-registry`) and the
   model output side-by-side. If the prompt has drifted from the SLA
   baseline, roll back via the registry rather than a code change — see
   `docs/PROMPT_ROLLOUT.md`.
4. For OTel-only setups (no Langfuse), use the same `traceId` against
   your trace backend (Tempo / Jaeger / Honeycomb) — the `ai.<feature>`
   spans carry every attribute except the prompt body itself.

---

## 6. Wiring into `apps/api/src/app.ts`

The metrics module exports a single `registerMetrics(app)` function. Wire it
near the top of `buildApp()` — after `app.use(cors(...))` and before the
route mounts — with these two lines:

```ts
import { registerMetrics } from "./services/metrics";
// ...inside buildApp(), after cors/body-parser/sanitize middleware:
registerMetrics(app);
```

That registers the HTTP timing middleware and mounts `GET /api/metrics`.
