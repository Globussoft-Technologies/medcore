/**
 * Unit tests for the Prometheus metrics middleware. Verifies the cardinality
 * discipline that is critical to keeping the Prom scrape sane:
 *   - the path label uses the route TEMPLATE (`/users/:id`), not the literal
 *     URL, so a parametrised endpoint produces ONE series, not N.
 *   - unmatched routes collapse to `<unmatched>` so 404 scanners cannot
 *     explode the series count.
 *   - HTTP method and status code propagate to the labels.
 *
 * The shared registry is a process-wide singleton; tests inspect counter
 * deltas around each invocation rather than asserting absolute values, so
 * they do not interact with whatever else may have ticked the counter
 * earlier in the run.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import {
  httpMetricsMiddleware,
  httpRequestsTotal,
  httpRequestDurationSeconds,
  registry,
} from "./metrics";

function makeReq(overrides: Partial<{
  method: string;
  baseUrl: string;
  routePath: string;
}> = {}): any {
  return {
    method: overrides.method ?? "GET",
    baseUrl: overrides.baseUrl ?? "",
    route: overrides.routePath ? { path: overrides.routePath } : undefined,
  };
}

function makeRes(statusCode = 200): any {
  const ee: any = new EventEmitter();
  ee.statusCode = statusCode;
  return ee;
}

async function getCounterValue(labels: Record<string, string>): Promise<number> {
  const metric = await httpRequestsTotal.get();
  const match = metric.values.find((v) =>
    Object.entries(labels).every(([k, v2]) => v.labels[k] === v2),
  );
  return match?.value ?? 0;
}

describe("httpMetricsMiddleware", () => {
  let mw: ReturnType<typeof httpMetricsMiddleware>;

  beforeEach(() => {
    mw = httpMetricsMiddleware();
  });

  it("calls next() synchronously (does not block the request)", () => {
    const req = makeReq();
    const res = makeRes();
    let called = 0;
    mw(req, res, () => called++);
    expect(called).toBe(1);
  });

  it("uses baseUrl + route.path as the path label on a matched route", async () => {
    const labels = { method: "GET", path: "/api/v1/patients/:id", status: "200" };
    const before = await getCounterValue(labels);

    const req = makeReq({
      method: "GET",
      baseUrl: "/api/v1/patients",
      routePath: "/:id",
    });
    const res = makeRes(200);
    mw(req, res, () => {});
    res.emit("finish");

    const after = await getCounterValue(labels);
    expect(after - before).toBe(1);
  });

  it("collapses unmatched routes to '<unmatched>' (cardinality firewall)", async () => {
    const labels = { method: "GET", path: "<unmatched>", status: "404" };
    const before = await getCounterValue(labels);

    const req = makeReq({ method: "GET" }); // no baseUrl, no route
    const res = makeRes(404);
    mw(req, res, () => {});
    res.emit("finish");

    const after = await getCounterValue(labels);
    expect(after - before).toBe(1);
  });

  it("propagates HTTP method through to the label", async () => {
    const labels = { method: "POST", path: "/api/v1/items/:id", status: "201" };
    const before = await getCounterValue(labels);

    const req = makeReq({
      method: "POST",
      baseUrl: "/api/v1/items",
      routePath: "/:id",
    });
    const res = makeRes(201);
    mw(req, res, () => {});
    res.emit("finish");

    const after = await getCounterValue(labels);
    expect(after - before).toBe(1);
  });

  it("propagates non-2xx status codes (5xx, 4xx) through to the label", async () => {
    const labels = { method: "GET", path: "/api/v1/things/:id", status: "503" };
    const before = await getCounterValue(labels);

    const req = makeReq({
      method: "GET",
      baseUrl: "/api/v1/things",
      routePath: "/:id",
    });
    const res = makeRes(503);
    mw(req, res, () => {});
    res.emit("finish");

    const after = await getCounterValue(labels);
    expect(after - before).toBe(1);
  });

  it("two requests with different concrete IDs collapse to one series", async () => {
    const labels = { method: "GET", path: "/api/v1/patients/:id", status: "200" };
    const before = await getCounterValue(labels);

    for (let i = 0; i < 5; i++) {
      const req = makeReq({
        method: "GET",
        baseUrl: "/api/v1/patients",
        routePath: "/:id",
      });
      const res = makeRes(200);
      mw(req, res, () => {});
      res.emit("finish");
    }

    const after = await getCounterValue(labels);
    expect(after - before).toBe(5);
  });

  it("does not record anything until res.emit('finish') fires", async () => {
    const labels = { method: "GET", path: "/api/v1/lab/:id", status: "200" };
    const before = await getCounterValue(labels);

    const req = makeReq({
      method: "GET",
      baseUrl: "/api/v1/lab",
      routePath: "/:id",
    });
    const res = makeRes(200);
    mw(req, res, () => {});
    // No finish event — counter must remain unchanged.

    const between = await getCounterValue(labels);
    expect(between - before).toBe(0);

    res.emit("finish");
    const after = await getCounterValue(labels);
    expect(after - before).toBe(1);
  });
});

describe("metrics registry — sanity", () => {
  it("registers the http counter and histogram by name", () => {
    expect(registry.getSingleMetric("medcore_http_requests_total")).toBe(
      httpRequestsTotal,
    );
    expect(registry.getSingleMetric("medcore_http_request_duration_seconds")).toBe(
      httpRequestDurationSeconds,
    );
  });

  it("default-process metrics (event loop, mem, cpu) are also registered under medcore_*", async () => {
    const text = await registry.metrics();
    expect(text).toMatch(/medcore_process_cpu_user_seconds_total/);
    expect(text).toMatch(/medcore_nodejs_eventloop_lag_seconds/);
  });
});
