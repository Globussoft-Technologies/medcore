// LLM reranker — a precision-boosting pass on top of PostgreSQL FTS hits.
//
// Pg's ts_rank is purely lexical, so medically similar terms (e.g. "HbA1c"
// vs "A1C control", "statin" vs "atorvastatin") often rank irrelevant chunks
// high, and semantically relevant chunks low. This module sends batches of
// candidate chunks to the LLM together with the original query and asks for
// a 0-10 relevance score per chunk. Results are reordered by that score.
//
// Design notes:
//   - Batched (≤ BATCH_SIZE chunks per LLM call) so we stay well under token
//     budget and can parallelise if needed later. Default BATCH_SIZE = 20.
//   - Tool-calling (via `generateStructured`) is used for reliable JSON out.
//   - NEVER blocks the user: any LLM error falls back to the original FTS order
//     and logs a warning. Reranking is an enhancement, not required.
//   - Observability: every batch emits an `ai_call` log with feature
//     "chart-search-rerank" plus `batchIndex`, `batchSize`, `chunkCount`.

import { generateStructured, logAICall } from "./sarvam";
import { sanitizeUserInput } from "./prompt-safety";

const MODEL = "sarvam-105b";

/** Shape reranker expects on input chunks. Callers map their domain hit type
 *  to this; we don't care about anything beyond id/text/FTS score. */
export interface RerankableChunk {
  id: string;
  title: string;
  content: string;
  /** Original FTS score (ts_rank). Preserved on output as a fallback when
   *  the LLM doesn't rate a given chunk. */
  ftsScore: number;
}

/** Chunk after rerank: identical to input plus an LLM relevance score 0-10.
 *  When the LLM didn't score the chunk (error / partial response), this
 *  falls back to `ftsScore` so ordering stays deterministic. */
export interface RerankedChunk extends RerankableChunk {
  /** 0-10, LLM relevance. Missing → defaults to ftsScore (scaled). */
  relevanceScore: number;
  /** True when the score came from the LLM; false when we fell back. */
  rerankedByLLM: boolean;
}

export interface RerankOptions {
  /** Default true. Set false to skip the LLM pass entirely and pass through. */
  enabled?: boolean;
  /** Only rerank the top K FTS hits; anything past K keeps FTS rank. Default 20. */
  topK?: number;
  /** Skip chunks with ftsScore below this value from being reranked. Default 0. */
  minFtsScore?: number;
  /** Chunks per LLM batch. Default 20. */
  batchSize?: number;
}

const DEFAULT_TOP_K = 20;
const DEFAULT_BATCH_SIZE = 20;

/**
 * Core reranker. Returns chunks reordered by LLM relevance (desc), with each
 * chunk carrying a `relevanceScore` (0-10) and `rerankedByLLM` flag. If the
 * LLM call throws, returns the original chunks in FTS order with
 * `rerankedByLLM=false` and `relevanceScore` = ftsScore so callers can still
 * sort consistently.
 */
export async function rerankChunks(
  query: string,
  chunks: RerankableChunk[],
  opts: RerankOptions = {}
): Promise<RerankedChunk[]> {
  const enabled = opts.enabled !== false; // default true
  const topK = opts.topK ?? DEFAULT_TOP_K;
  const minFtsScore = opts.minFtsScore ?? 0;
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;

  if (chunks.length === 0) return [];

  // Fast-path: rerank disabled — return chunks as-is with FTS-derived scores.
  if (!enabled || !query.trim()) {
    return chunks.map((c) => ({
      ...c,
      relevanceScore: c.ftsScore,
      rerankedByLLM: false,
    }));
  }

  // Partition into "to-rerank" and "pass-through" based on topK + minFtsScore.
  const sortedByFts = [...chunks].sort((a, b) => b.ftsScore - a.ftsScore);
  const candidates: RerankableChunk[] = [];
  const passThrough: RerankableChunk[] = [];
  for (let i = 0; i < sortedByFts.length; i++) {
    const c = sortedByFts[i];
    if (i < topK && c.ftsScore >= minFtsScore) {
      candidates.push(c);
    } else {
      passThrough.push(c);
    }
  }

  if (candidates.length === 0) {
    // All filtered out — nothing to rerank; preserve FTS order.
    return sortedByFts.map((c) => ({
      ...c,
      relevanceScore: c.ftsScore,
      rerankedByLLM: false,
    }));
  }

  // Track LLM scores by chunk id; anything missing at the end falls back.
  const scoreById = new Map<string, number>();

  try {
    const batches: RerankableChunk[][] = [];
    for (let i = 0; i < candidates.length; i += batchSize) {
      batches.push(candidates.slice(i, i + batchSize));
    }

    for (let bIdx = 0; bIdx < batches.length; bIdx++) {
      const batch = batches[bIdx];
      const t0 = Date.now();
      try {
        const result = await scoreBatch(query, batch);
        for (const s of result.scores) {
          if (typeof s.index === "number" && s.index >= 0 && s.index < batch.length) {
            const chunkId = batch[s.index].id;
            const score = clampScore(s.score);
            scoreById.set(chunkId, score);
          }
        }
        logAICall({
          feature: "chart-search-rerank",
          model: MODEL,
          promptTokens: result.promptTokens,
          completionTokens: result.completionTokens,
          latencyMs: Date.now() - t0,
          toolUsed: "score_chunks",
          batchIndex: bIdx,
          batchSize: batch.length,
          chunkCount: result.scores.length,
        });
      } catch (err) {
        // Per-batch failure: log, skip this batch (its chunks will fall back),
        // and keep processing remaining batches.
        logAICall({
          feature: "chart-search-rerank",
          model: MODEL,
          promptTokens: 0,
          completionTokens: 0,
          latencyMs: Date.now() - t0,
          error: err instanceof Error ? err.message : String(err),
          batchIndex: bIdx,
          batchSize: batch.length,
          chunkCount: 0,
        });
        console.warn(
          `[reranker] batch ${bIdx} failed, falling back to FTS order: ` +
            (err instanceof Error ? err.message : String(err))
        );
      }
    }
  } catch (err) {
    // Outer catch (shouldn't really hit — batching loop handles per-batch).
    console.warn(
      `[reranker] unexpected failure, falling back to FTS order: ` +
        (err instanceof Error ? err.message : String(err))
    );
  }

  // Compose result:
  //  - Reranked candidates (those with an LLM score) sorted desc by that score.
  //  - Candidates that got no LLM score fall back to ftsScore ordering.
  //  - Pass-through chunks (below topK / minFtsScore) come after, FTS order.
  const rerankedCandidates: RerankedChunk[] = candidates.map((c) => {
    const llmScore = scoreById.get(c.id);
    if (typeof llmScore === "number") {
      return { ...c, relevanceScore: llmScore, rerankedByLLM: true };
    }
    return { ...c, relevanceScore: c.ftsScore, rerankedByLLM: false };
  });

  // Sort: LLM-scored chunks go on top (sorted desc by LLM score), then
  // fell-back candidates (sorted desc by fts), then pass-through.
  rerankedCandidates.sort((a, b) => {
    if (a.rerankedByLLM && !b.rerankedByLLM) return -1;
    if (!a.rerankedByLLM && b.rerankedByLLM) return 1;
    return b.relevanceScore - a.relevanceScore;
  });

  const passThroughOut: RerankedChunk[] = passThrough.map((c) => ({
    ...c,
    relevanceScore: c.ftsScore,
    rerankedByLLM: false,
  }));

  return [...rerankedCandidates, ...passThroughOut];
}

// ── Internals ─────────────────────────────────────────────────────────────────

function clampScore(n: unknown): number {
  const x = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 10) return 10;
  return x;
}

/** Truncate each chunk's content so a batch of 20 fits comfortably in context. */
function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n) + "…";
}

interface BatchScoreResponse {
  scores: { index: number; score: number }[];
}

/**
 * Send one batch of chunks to the LLM and receive 0-10 relevance scores.
 * Uses tool-calling for structured output — failure raises, caller handles
 * fallback.
 */
async function scoreBatch(
  query: string,
  batch: RerankableChunk[]
): Promise<{ scores: { index: number; score: number }[]; promptTokens: number; completionTokens: number }> {
  const systemPrompt =
    "You are a clinical relevance scorer. Given a doctor's natural-language query " +
    "and a numbered list of chart chunks, score each chunk on a 0-10 scale for " +
    "how directly it helps answer the query. 10 = answers the query; " +
    "0 = completely irrelevant. Use the full 0-10 range. Reply ONLY by calling " +
    "the score_chunks tool with one entry per chunk (index starting at 0).";

  // security(2026-04-23-low): F-INJ-1 — chunk text is ingested EHR content
  // and therefore partly user-authored. Sanitize both title + content and the
  // query so an adversarial note can't steer the relevance scorer into
  // outputting arbitrary JSON (tool-calling bounds us further, but layered
  // defence is cheap here).
  const safeQuery = sanitizeUserInput(query, { maxLen: 500 });
  const chunkBlocks = batch
    .map((c, i) => {
      const title = truncate(sanitizeUserInput(c.title ?? "", { maxLen: 400 }), 200);
      const content = truncate(sanitizeUserInput(c.content ?? "", { maxLen: 1200 }), 600);
      return `[${i}] ${title}\n${content}`;
    })
    .join("\n\n---\n\n");

  const userPrompt = `Query: ${safeQuery}\n\nChunks:\n${chunkBlocks}\n\nScore every chunk 0-10.`;

  const parameters = {
    type: "object",
    properties: {
      scores: {
        type: "array",
        description: "One entry per chunk, with the chunk's index and its 0-10 score.",
        items: {
          type: "object",
          properties: {
            index: { type: "integer", minimum: 0 },
            score: { type: "number", minimum: 0, maximum: 10 },
          },
          required: ["index", "score"],
        },
      },
    },
    required: ["scores"],
  };

  const { data, promptTokens, completionTokens } = await generateStructured<BatchScoreResponse>({
    systemPrompt,
    userPrompt,
    toolName: "score_chunks",
    toolDescription:
      "Return a list of {index, score} pairs — one per chunk — with score in 0-10.",
    parameters,
    maxTokens: 512,
    temperature: 0,
  });

  if (!data || !Array.isArray(data.scores)) {
    throw new Error("LLM returned no structured scores");
  }

  return { scores: data.scores, promptTokens, completionTokens };
}
