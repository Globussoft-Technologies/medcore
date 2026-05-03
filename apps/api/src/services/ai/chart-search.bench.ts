// Vitest microbenchmarks for chart-search synthesis assembly.
//
// WHY THIS EXISTS (P10 — TEST_COVERAGE_AUDIT.md §5):
//   `synthesizeAnswer` is the doctor-facing chart-search hot path: it builds
//   a sources block from up to 10 ranked KnowledgeChunks, sanitizes each
//   field, and concatenates the final user prompt before handing off to the
//   LLM. The LLM call itself is network-bound and excluded from the bench
//   (mocked); we measure ONLY the deterministic prompt-assembly work, which
//   is what regresses when we touch the sanitizer or the formatting logic.
//   A >10% drift here moves p95 chart-search latency end-to-end.
//
// HOW TO USE:
//   - Run all benches:        `npm run bench --workspace=apps/api`
//   - Save a baseline:        `npx vitest bench --run --outputJson bench-baseline.json`
//   - Compare against base:   `npx vitest bench --run --compare=bench-baseline.json`
//
// SCOPE: in-memory string assembly of `synthesizeAnswer`. The Sarvam LLM
//        call is stubbed via `vi.mock("./sarvam")` so the bench measures our
//        code, not the network.

import { bench, describe, vi } from "vitest";

// Stub the Sarvam client so synthesizeAnswer's deterministic prompt-assembly
// can be benched in isolation. The mock returns immediately with a fixed
// string — measuring the LLM round-trip is the load-test suite's job, not
// this microbench. See scripts/load-tests for end-to-end latency baselines.
vi.mock("./sarvam", () => ({
  generateText: vi.fn(async () => "Stubbed answer [1] [2]."),
  logAICall: vi.fn(),
}));

import { synthesizeAnswer, type ChartSearchHit } from "./chart-search";

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeHit(i: number, contentLen: number): ChartSearchHit {
  // Realistic-shape chunk: title from a clinical note + variable-length body.
  const title = `Consultation note ${i} — chest pain follow-up, T2DM review`;
  const content =
    `Patient seen on 2026-04-${String((i % 28) + 1).padStart(2, "0")}. ` +
    `Reports improvement in symptoms, BP 132/84, HR 78, SpO2 98%. ` +
    `Continued metformin 500 BD, atorvastatin 10 HS. `.repeat(
      Math.max(1, Math.floor(contentLen / 100)),
    );
  return {
    id: `chunk-${i}`,
    documentType: i % 2 === 0 ? "CONSULTATION" : "LAB_RESULT",
    title,
    content,
    tags: [`patient:p-${i % 5}`, `doctor:d-1`, `date:2026-04-${(i % 28) + 1}`],
    rank: 1 - i * 0.05,
    ftsScore: 1 - i * 0.05,
    rerankScore: null,
    patientId: `p-${i % 5}`,
    doctorId: "d-1",
    date: `2026-04-${(i % 28) + 1}`,
  };
}

const QUERY = "Has the patient's BP been controlled over the last 6 months?";

// 10 hits is the production cap inside synthesizeAnswer (`hits.slice(0, 10)`).
// Vary content length to exercise the truncation branch in sanitizeUserInput.
const TEN_HITS_SMALL = Array.from({ length: 10 }, (_, i) => makeHit(i, 200));
const TEN_HITS_MEDIUM = Array.from({ length: 10 }, (_, i) => makeHit(i, 800));
const TEN_HITS_LARGE = Array.from({ length: 10 }, (_, i) => makeHit(i, 1500));

// ── Benchmarks ────────────────────────────────────────────────────────────────

describe("chart-search hot paths (LLM stubbed)", () => {
  const opts = { time: 500 } as const;

  bench(
    "synthesizeAnswer: 10 hits × ~200B content (typical OPD case)",
    async () => {
      await synthesizeAnswer(QUERY, TEN_HITS_SMALL);
    },
    opts,
  );

  bench(
    "synthesizeAnswer: 10 hits × ~800B content (multi-encounter chart)",
    async () => {
      await synthesizeAnswer(QUERY, TEN_HITS_MEDIUM);
    },
    opts,
  );

  bench(
    "synthesizeAnswer: 10 hits × ~1500B content (truncation branch)",
    async () => {
      await synthesizeAnswer(QUERY, TEN_HITS_LARGE);
    },
    opts,
  );
});
