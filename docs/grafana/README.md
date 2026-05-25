# MedCore — Grafana dashboards

Reference dashboard JSON for ops teams running MedCore on their own
Prometheus + Grafana stack. These are import-ready artifacts; the
MedCore repo does not run Grafana itself.

## Dashboards

| File | Title | Covers |
| --- | --- | --- |
| `medcore-api-overview.json` | MedCore — API overview | HTTP rate / latency / 5xx, Sarvam AI pipeline (latency, outcomes, INR spend), auth login outcomes, Node process health, ops gauges. 10 panels grouped into 3 rows. |

## Import instructions

1. Make sure Prometheus is scraping the MedCore API. The exposition
   endpoint is `GET /api/metrics` on the API host — see
   `docs/OBSERVABILITY.md` §2 for the `prometheus.yml` snippet.
2. In Grafana: **Settings → Data Sources → Add data source → Prometheus**,
   point at your Prometheus URL, **Save & Test**.
3. **Dashboards → New → Import → Upload JSON file**, pick
   `medcore-api-overview.json`.
4. On the import screen, the `DS_PROMETHEUS` variable will ask you to
   pick the datasource you just created.
5. Click **Import**. Done.

## Dashboard variables

The dashboard exposes two template variables that ops teams must fill in
for their cluster:

- `service` — defaults to `medcore-api` (matches the `labels.service`
  in the example `prometheus.yml` scrape config).
- `env` — defaults to `production`. Set per your scrape-config labels
  (e.g. `staging`, `demo`).

If your scrape config labels differ, edit the variable defaults from the
dashboard's gear icon before saving.

## Source of truth for metric names

The PromQL in every panel queries names exported by
`apps/api/src/services/metrics.ts` and
`apps/api/src/services/metrics-counters.ts`. If you add a new metric
there, mirror the panel here and bump the dashboard `version` field.

## Alert rules

Alert rules are **not** included in this dashboard JSON — they are
tracked separately and depend on the operator's notification stack
(Alertmanager / PagerDuty / Slack webhook / etc.). The headline thresholds
to wire up:

- `medcore_rate_limits_enabled == 0` for > 5m (someone left the kill-switch on)
- `histogram_quantile(0.95, ... medcore_http_request_duration_seconds_bucket ...) > 1` for > 10m
- 5xx ratio > 1% for > 5m
- `medcore_ai_calls_total{outcome="error"}` rate > 0.5/s for > 5m
- `medcore_prompt_cache_age_seconds > 120` (cache TTL is 60s — stuck eviction)

A drop-in `prometheus-alerts.yml` will land alongside this dashboard once
the operator decides on their notification routing.
