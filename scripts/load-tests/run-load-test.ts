#!/usr/bin/env tsx
/**
 * MedCore AI endpoint load-test orchestrator.
 *
 *   tsx scripts/load-tests/run-load-test.ts \
 *     --endpoint=triage --concurrency=10 --requests=100
 *
 * Flags:
 *   --endpoint=<triage|scribe|chart-search>   (required)
 *   --concurrency=N                           (default 10)
 *   --requests=N                              (default 100)
 *   --base-url=<url>                          (default http://localhost:4000)
 *   --mock-port=N                             (if set, overrides base-url to
 *                                              http://localhost:N and uses
 *                                              a synthetic bearer token —
 *                                              pair with mock-server.ts)
 *   --patient-id=<uuid>                       (chart-search only; required
 *                                              for real API, ignored by mock)
 *   --json-out=<path>                         (also write a machine-readable
 *                                              summary JSON to <path> for
 *                                              the SLA-gate parser)
 *   --verbose                                 (log each request result)
 *
 * No npm deps — Node 18+ `fetch`, `perf_hooks`, and built-ins only.
 */

import { performance } from "node:perf_hooks";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  triagePrompts,
  scribeTranscripts,
  chartSearchQueries,
  pickRoundRobin,
} from "./payloads";
import { authHeader } from "./auth-helper";

type Endpoint = "triage" | "scribe" | "chart-search";

interface CliArgs {
  endpoint: Endpoint;
  concurrency: number;
  requests: number;
  baseUrl: string;
  mockPort?: number;
  patientId?: string;
  jsonOut?: string;
  verbose: boolean;
}

interface RequestRecord {
  workerId: number;
  reqIndex: number;
  payloadId: string;
  startedAt: number;   // epoch ms (Date.now)
  startedHr: number;   // perf_hooks
  endedHr: number;
  latencyMs: number;
  status: number;      // 0 if transport/connect error
  ok: boolean;
  error?: string;
  // Token estimate for cost math — hardcoded ~2000 tokens/call per spec.
  tokensEstimated: number;
}

// ── Constants ───────────────────────────────────────────────────────────────
// Sarvam pricing is tier-dependent; these are *rough* public-tier numbers
// at time of writing. Treat as order-of-magnitude, not billing-accurate.
// Source: Sarvam pricing page (generalist, April 2026). Re-validate before
// using these numbers for budget decisions.
const SARVAM_PRICE_PER_1K_INPUT_TOKENS_USD = 0.0005;
const SARVAM_PRICE_PER_1K_OUTPUT_TOKENS_USD = 0.0015;
// Rough split of a 2000-token call: 1500 in, 500 out.
const TOKENS_PER_CALL = 2000;
const INPUT_RATIO = 0.75;
const OUTPUT_RATIO = 0.25;

// ── Arg parsing ─────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): CliArgs {
  const args: Record<string, string | boolean> = {};
  for (const a of argv.slice(2)) {
    if (!a.startsWith("--")) continue;
    const eq = a.indexOf("=");
    if (eq === -1) args[a.slice(2)] = true;
    else args[a.slice(2, eq)] = a.slice(eq + 1);
  }

  const endpoint = args.endpoint as string | undefined;
  if (!endpoint || !["triage", "scribe", "chart-search"].includes(endpoint)) {
    throw new Error(
      `--endpoint is required and must be one of: triage, scribe, chart-search`
    );
  }

  const concurrency = Number(args.concurrency ?? 10);
  const requests = Number(args.requests ?? 100);
  if (!Number.isFinite(concurrency) || concurrency < 1) {
    throw new Error("--concurrency must be a positive integer");
  }
  if (!Number.isFinite(requests) || requests < 1) {
    throw new Error("--requests must be a positive integer");
  }

  const mockPort = args["mock-port"]
    ? Number(args["mock-port"])
    : undefined;
  const baseUrl = mockPort
    ? `http://localhost:${mockPort}`
    : (args["base-url"] as string | undefined) ?? "http://localhost:4000";

  return {
    endpoint: endpoint as Endpoint,
    concurrency,
    requests,
    baseUrl,
    mockPort,
    patientId: args["patient-id"] as string | undefined,
    jsonOut: args["json-out"] as string | undefined,
    verbose: Boolean(args.verbose),
  };
}

// ── HTTP helpers ────────────────────────────────────────────────────────────

async function postJSON(
  url: string,
  body: unknown,
  authHdr: string
): Promise<{ status: number; body: unknown; raw: string }> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: authHdr,
    },
    body: JSON.stringify(body ?? {}),
  });
  const raw = await res.text();
  let parsed: unknown = raw;
  try {
    parsed = JSON.parse(raw);
  } catch {
    /* non-JSON error body */
  }
  return { status: res.status, body: parsed, raw };
}

// ── Endpoint-specific call strategies ───────────────────────────────────────
//
// Each strategy exposes:
//   prepare(): one-time setup per worker (e.g. create triage session)
//   call(i):   a single load-test request to record

interface CallPlan {
  payloadId: string;
  // Returns { status, ok, error? }.
  run: () => Promise<{ status: number; ok: boolean; error?: string }>;
}

interface EndpointStrategy {
  prepare: (workerId: number, authHdr: string) => Promise<void>;
  next: (workerId: number, reqIndex: number, authHdr: string) => CallPlan;
}

function makeTriageStrategy(args: CliArgs): EndpointStrategy {
  // Each worker creates its own session. We round-robin prompts.
  const sessionByWorker = new Map<number, string>();

  async function ensureSession(workerId: number, authHdr: string): Promise<string> {
    const existing = sessionByWorker.get(workerId);
    if (existing) return existing;

    const prompt = pickRoundRobin(triagePrompts, workerId);
    const startUrl = `${args.baseUrl}/api/v1/ai/triage/start`;
    const { status, body, raw } = await postJSON(
      startUrl,
      { language: prompt.language, inputMode: "TEXT", consentGiven: true },
      authHdr
    );
    if (status >= 300) {
      throw new Error(`triage/start failed ${status}: ${raw.slice(0, 200)}`);
    }
    const sessionId = (body as any)?.data?.sessionId ?? (body as any)?.data?.id;
    if (!sessionId) {
      throw new Error(`triage/start did not return sessionId: ${raw.slice(0, 200)}`);
    }
    sessionByWorker.set(workerId, sessionId);
    return sessionId;
  }

  return {
    async prepare(workerId, authHdr) {
      await ensureSession(workerId, authHdr);
    },
    next(workerId, reqIndex, authHdr) {
      const prompt = pickRoundRobin(triagePrompts, workerId + reqIndex);
      return {
        payloadId: prompt.id,
        run: async () => {
          const sessionId = await ensureSession(workerId, authHdr);
          const url = `${args.baseUrl}/api/v1/ai/triage/${sessionId}/message`;
          try {
            const { status } = await postJSON(
              url,
              { message: prompt.message, language: prompt.language },
              authHdr
            );
            return { status, ok: status < 400 };
          } catch (err) {
            return { status: 0, ok: false, error: (err as Error).message };
          }
        },
      };
    },
  };
}

function makeScribeStrategy(args: CliArgs): EndpointStrategy {
  // Scribe start requires a real appointmentId — in mock mode we skip session
  // creation entirely. In "real API" mode we'd fail fast; the load test still
  // hits the SOAP-generation path via a synthetic transcript POST.
  //
  // For simplicity and correctness vs. the live API, the load test exercises
  // the *SOAP generation* path against a fake endpoint that either:
  //   - mock mode: mock server responds at /api/v1/ai/scribe/generate
  //   - real mode: operator must pre-seed an appointment and wire `--scribe-session=<id>`
  //
  // Without a provided session, the real-API path will 400 — which IS a valid
  // smoke signal (confirms routing, auth, validation).
  return {
    async prepare() {
      /* no-op — session expected to exist in real mode, bypassed in mock */
    },
    next(workerId, reqIndex, authHdr) {
      const t = pickRoundRobin(scribeTranscripts, workerId + reqIndex);
      return {
        payloadId: t.id,
        run: async () => {
          // Shape mirrors what the mock server accepts. Against the real API
          // this will likely 400/404 — operators should adapt per their seed.
          const url = `${args.baseUrl}/api/v1/ai/scribe/generate-soap`;
          try {
            const { status } = await postJSON(
              url,
              {
                transcript: t.exchanges
                  .map((e) => `${e.speaker}: ${e.text}`)
                  .join("\n"),
                language: "en",
              },
              authHdr
            );
            return { status, ok: status < 400 };
          } catch (err) {
            return { status: 0, ok: false, error: (err as Error).message };
          }
        },
      };
    },
  };
}

function makeChartSearchStrategy(args: CliArgs): EndpointStrategy {
  return {
    async prepare() {
      /* no-op */
    },
    next(workerId, reqIndex, authHdr) {
      const q = pickRoundRobin(chartSearchQueries, workerId + reqIndex);
      // Against mock server we use a literal "mock-patient" id; against real
      // API the operator must pass --patient-id=<uuid>.
      const patientId =
        args.patientId ?? (args.mockPort ? "mock-patient" : "MISSING");
      return {
        payloadId: q.id,
        run: async () => {
          const url = `${args.baseUrl}/api/v1/ai/chart-search/patient/${patientId}`;
          try {
            const { status } = await postJSON(
              url,
              { query: q.query, synthesize: q.synthesize },
              authHdr
            );
            return { status, ok: status < 400 };
          } catch (err) {
            return { status: 0, ok: false, error: (err as Error).message };
          }
        },
      };
    },
  };
}

function strategyFor(args: CliArgs): EndpointStrategy {
  switch (args.endpoint) {
    case "triage":
      return makeTriageStrategy(args);
    case "scribe":
      return makeScribeStrategy(args);
    case "chart-search":
      return makeChartSearchStrategy(args);
  }
}

// ── Runner ──────────────────────────────────────────────────────────────────

async function runLoad(args: CliArgs): Promise<RequestRecord[]> {
  const authHdr = await authHeader(args.baseUrl, { mock: Boolean(args.mockPort) });
  const strategy = strategyFor(args);

  // A simple counter-based queue — each worker pulls until the total is hit.
  let nextIdx = 0;
  const records: RequestRecord[] = [];

  async function worker(workerId: number): Promise<void> {
    try {
      await strategy.prepare(workerId, authHdr);
    } catch (err) {
      // Preparation failure — record a single synthetic failure so the worker
      // doesn't silently drop all its would-be requests.
      const now = performance.now();
      records.push({
        workerId,
        reqIndex: -1,
        payloadId: "prepare",
        startedAt: Date.now(),
        startedHr: now,
        endedHr: now,
        latencyMs: 0,
        status: 0,
        ok: false,
        error: `prepare: ${(err as Error).message}`,
        tokensEstimated: 0,
      });
      return;
    }

    while (true) {
      const reqIndex = nextIdx++;
      if (reqIndex >= args.requests) return;

      const plan = strategy.next(workerId, reqIndex, authHdr);
      const startedAt = Date.now();
      const startedHr = performance.now();
      let result: { status: number; ok: boolean; error?: string };
      try {
        result = await plan.run();
      } catch (err) {
        result = { status: 0, ok: false, error: (err as Error).message };
      }
      const endedHr = performance.now();
      const rec: RequestRecord = {
        workerId,
        reqIndex,
        payloadId: plan.payloadId,
        startedAt,
        startedHr,
        endedHr,
        latencyMs: endedHr - startedHr,
        status: result.status,
        ok: result.ok,
        error: result.error,
        tokensEstimated: result.ok ? TOKENS_PER_CALL : 0,
      };
      records.push(rec);
      if (args.verbose) {
        const tag = rec.ok ? "OK " : "ERR";
        process.stdout.write(
          `  [w${workerId}#${reqIndex}] ${tag} ${rec.status} ${rec.latencyMs.toFixed(0)}ms ${rec.payloadId}${rec.error ? ` — ${rec.error}` : ""}\n`
        );
      }
    }
  }

  const startWall = performance.now();
  await Promise.all(
    Array.from({ length: args.concurrency }, (_, i) => worker(i))
  );
  const endWall = performance.now();
  (records as any).__wallMs = endWall - startWall;
  return records;
}

// ── Stats ───────────────────────────────────────────────────────────────────

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  const frac = rank - lo;
  return sorted[lo] * (1 - frac) + sorted[hi] * frac;
}

function summarise(records: RequestRecord[], args: CliArgs): void {
  const completed = records.filter((r) => r.reqIndex >= 0);
  const ok = completed.filter((r) => r.ok);
  const errs = completed.filter((r) => !r.ok);
  const prepareFailures = records.filter((r) => r.reqIndex < 0);

  const latencies = ok.map((r) => r.latencyMs).sort((a, b) => a - b);
  const wallMs = (records as any).__wallMs ?? 0;
  const throughput = wallMs > 0 ? (completed.length / wallMs) * 1000 : 0;

  const totalTokens = ok.length * TOKENS_PER_CALL;
  const inputTokens = totalTokens * INPUT_RATIO;
  const outputTokens = totalTokens * OUTPUT_RATIO;
  const estCostUsd =
    (inputTokens / 1000) * SARVAM_PRICE_PER_1K_INPUT_TOKENS_USD +
    (outputTokens / 1000) * SARVAM_PRICE_PER_1K_OUTPUT_TOKENS_USD;

  // Group error status codes
  const statusCounts = new Map<number, number>();
  for (const r of errs) {
    statusCounts.set(r.status, (statusCounts.get(r.status) ?? 0) + 1);
  }

  const bar = "─".repeat(68);
  process.stdout.write(`\n${bar}\n`);
  process.stdout.write(`MedCore AI load test — ${args.endpoint}\n`);
  process.stdout.write(`${bar}\n`);
  process.stdout.write(`  base url         ${args.baseUrl}\n`);
  process.stdout.write(`  concurrency      ${args.concurrency}\n`);
  process.stdout.write(`  requests         ${args.requests}\n`);
  process.stdout.write(`  mock mode        ${args.mockPort ? `yes (port ${args.mockPort})` : "no"}\n`);
  process.stdout.write(`\n`);
  process.stdout.write(`  wall time        ${wallMs.toFixed(0)} ms\n`);
  process.stdout.write(`  completed        ${completed.length}\n`);
  process.stdout.write(`  ok               ${ok.length}\n`);
  process.stdout.write(`  errors           ${errs.length}\n`);
  if (prepareFailures.length) {
    process.stdout.write(`  prepare failures ${prepareFailures.length}\n`);
  }
  process.stdout.write(
    `  error rate       ${completed.length === 0 ? "n/a" : ((errs.length / completed.length) * 100).toFixed(2) + "%"}\n`
  );
  process.stdout.write(`  throughput       ${throughput.toFixed(2)} req/s\n`);
  process.stdout.write(`\n`);
  process.stdout.write(`  latency (ok only)\n`);
  if (latencies.length === 0) {
    process.stdout.write(`    no successful requests to report\n`);
  } else {
    process.stdout.write(`    min            ${latencies[0].toFixed(0)} ms\n`);
    process.stdout.write(`    p50            ${percentile(latencies, 50).toFixed(0)} ms\n`);
    process.stdout.write(`    p95            ${percentile(latencies, 95).toFixed(0)} ms\n`);
    process.stdout.write(`    p99            ${percentile(latencies, 99).toFixed(0)} ms\n`);
    process.stdout.write(`    max            ${latencies[latencies.length - 1].toFixed(0)} ms\n`);
  }
  process.stdout.write(`\n`);
  process.stdout.write(`  cost estimate (Sarvam, ~${TOKENS_PER_CALL} tok/call)\n`);
  process.stdout.write(`    total tokens   ${totalTokens}\n`);
  process.stdout.write(`    est. USD       $${estCostUsd.toFixed(4)}\n`);

  if (statusCounts.size > 0) {
    process.stdout.write(`\n  error status breakdown\n`);
    for (const [status, count] of [...statusCounts.entries()].sort()) {
      process.stdout.write(`    ${status.toString().padStart(3)}          ${count}\n`);
    }
    // Surface first few error messages for triage.
    const sample = errs.slice(0, 3).map((e) => e.error ?? "—");
    if (sample.some(Boolean)) {
      process.stdout.write(`  sample errors\n`);
      for (const s of sample) {
        process.stdout.write(`    - ${String(s).slice(0, 160)}\n`);
      }
    }
  }

  process.stdout.write(`${bar}\n`);
}

// ── JSON export for SLA gate ────────────────────────────────────────────────
//
// The SLA-gate parser (`scripts/load-test-sla-gate.ts`) reads this shape.
// Keep it stable; bump `schemaVersion` if you change the layout.

interface JsonSummary {
  schemaVersion: 1;
  endpoint: Endpoint;
  baseUrl: string;
  mockMode: boolean;
  concurrency: number;
  requests: number;
  completed: number;
  ok: number;
  errors: number;
  errorRate: number; // 0..1
  wallMs: number;
  throughputRps: number;
  latencyMs: {
    min: number;
    p50: number;
    p95: number;
    p99: number;
    max: number;
  } | null;
  errorStatusBreakdown: Record<string, number>;
  generatedAt: string;
}

function buildJsonSummary(records: RequestRecord[], args: CliArgs): JsonSummary {
  const completed = records.filter((r) => r.reqIndex >= 0);
  const ok = completed.filter((r) => r.ok);
  const errs = completed.filter((r) => !r.ok);
  const latencies = ok.map((r) => r.latencyMs).sort((a, b) => a - b);
  const wallMs = (records as { __wallMs?: number } & RequestRecord[]).__wallMs ?? 0;
  const errorStatusBreakdown: Record<string, number> = {};
  for (const r of errs) {
    const key = String(r.status);
    errorStatusBreakdown[key] = (errorStatusBreakdown[key] ?? 0) + 1;
  }

  return {
    schemaVersion: 1,
    endpoint: args.endpoint,
    baseUrl: args.baseUrl,
    mockMode: Boolean(args.mockPort),
    concurrency: args.concurrency,
    requests: args.requests,
    completed: completed.length,
    ok: ok.length,
    errors: errs.length,
    errorRate: completed.length === 0 ? 1 : errs.length / completed.length,
    wallMs,
    throughputRps: wallMs > 0 ? (completed.length / wallMs) * 1000 : 0,
    latencyMs:
      latencies.length === 0
        ? null
        : {
            min: latencies[0],
            p50: percentile(latencies, 50),
            p95: percentile(latencies, 95),
            p99: percentile(latencies, 99),
            max: latencies[latencies.length - 1],
          },
    errorStatusBreakdown,
    generatedAt: new Date().toISOString(),
  };
}

function writeJsonSummary(path: string, summary: JsonSummary): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(summary, null, 2) + "\n", "utf8");
}

// ── Entry ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv);
  } catch (err) {
    process.stderr.write(`Error: ${(err as Error).message}\n\n`);
    process.stderr.write(
      `Usage: tsx scripts/load-tests/run-load-test.ts --endpoint=<triage|scribe|chart-search> [--concurrency=N] [--requests=N] [--base-url=<url>] [--mock-port=N] [--patient-id=<uuid>] [--json-out=<path>] [--verbose]\n`
    );
    process.exit(2);
    return;
  }

  const t0 = performance.now();
  const records = await runLoad(args);
  const t1 = performance.now();
  if (!(records as any).__wallMs) (records as any).__wallMs = t1 - t0;

  summarise(records, args);

  if (args.jsonOut) {
    try {
      const summary = buildJsonSummary(records, args);
      writeJsonSummary(args.jsonOut, summary);
      process.stdout.write(`  json summary    ${args.jsonOut}\n`);
    } catch (err) {
      process.stderr.write(
        `Warning: failed to write json summary to ${args.jsonOut}: ${(err as Error).message}\n`
      );
    }
  }

  const completed = records.filter((r) => r.reqIndex >= 0);
  const errRate =
    completed.length === 0
      ? 1
      : completed.filter((r) => !r.ok).length / completed.length;
  // Exit non-zero if error rate is >= 50% — useful signal in CI, still
  // lets normal rate-limit-induced errors (<50%) pass.
  process.exit(errRate >= 0.5 ? 1 : 0);
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${(err as Error).stack ?? err}\n`);
  process.exit(1);
});
