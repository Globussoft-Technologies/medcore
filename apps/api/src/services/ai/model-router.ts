import OpenAI from "openai";
import { logAICall } from "./sarvam-logging";

// ── Types ─────────────────────────────────────────────────────────────────────

export type ModelProvider = "sarvam" | "openai" | "anthropic";

/**
 * Minimum OpenAI-compatible surface the LLM wrappers in `sarvam.ts` rely on.
 * Exported so failover callers can hold provider clients in a typed array
 * without pulling in the full `OpenAI` type (which is a class, not an
 * interface — easy to leak implementation details).
 */
export interface ChatClient {
  chat: {
    completions: {
      create: OpenAI["chat"]["completions"]["create"];
    };
  };
}

// ── Client factories ──────────────────────────────────────────────────────────
//
// Each factory is deliberately simple: read env vars, new up an OpenAI-compat
// client with a provider-specific base URL. This module's only job is "which
// endpoint are we calling?", so the wrappers can keep the same shape whether
// we're hitting Sarvam, OpenAI proper, or (eventually) Anthropic.
//
// PRODUCTION RELIABILITY (2026-07): the OpenAI SDK defaults to a 10-MINUTE
// per-request timeout and 2 internal retries. On the live server the hop to
// the AI provider is slower/flakier than localhost, so a hung request would
// sit for minutes — well past a proxy read-timeout — and the browser would see
// a 502/504 (the classic "works locally, breaks on server" symptom). We
// therefore:
//   • set an explicit, env-tunable request TIMEOUT (default 100s) — generous
//     enough for a slow production SOAP generation (reasoning model + long
//     transcript) to finish, while still bounded so a truly hung call fails
//     cleanly instead of sitting for minutes; and
//   • set `maxRetries: 0` so the SDK doesn't silently retry on top of the
//     `withRetry` wrapper in sarvam.ts (the single source of retry policy) —
//     and note that withRetry does NOT re-attempt on a TIMEOUT (a timeout
//     already consumed the full budget; retrying would double the wall-time
//     and blow past the proxy ceiling). It only re-tries FAST failures
//     (connection reset / 429 / 5xx).
// Keep the reverse-proxy read-timeout ABOVE this value (see docs/DEPLOY.md):
// e.g. Nginx `proxy_read_timeout 120s`. NOTE: Cloudflare's hard cap is ~100s,
// so a 100s single-attempt budget sits right AT that edge — if you serve
// through a Cloudflare tunnel, drop this to ~90s (or front prod with Nginx,
// which has no such cap).

/** Per-request timeout for AI provider calls (ms). Env-tunable; 100s default. */
const AI_REQUEST_TIMEOUT_MS = (() => {
  const raw = Number(process.env.AI_REQUEST_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 100_000;
})();

// ── [SCRIBE-DBG] init diagnostics ───────────────────────────────────────────
// Log ONCE per provider which endpoint + key we're wired to. This is the
// single most useful production check: a missing / placeholder API key (env
// not set on the server) is the #1 reason the scribe "works locally, fails on
// prod". We NEVER print the key — only whether it's present and a masked tail.
function maskKey(k: string | undefined): string {
  if (!k) return "MISSING";
  if (k === "sk-medcore-placeholder") return "PLACEHOLDER(env-unset)";
  return `present(len=${k.length}, …${k.slice(-4)})`;
}
const _loggedInit = new Set<string>();
function logClientInit(provider: string, key: string | undefined, baseURL: string) {
  if (_loggedInit.has(provider)) return;
  _loggedInit.add(provider);
  // eslint-disable-next-line no-console
  console.log(
    `[SCRIBE-DBG] client-init provider=${provider} baseURL=${baseURL} key=${maskKey(key)} timeoutMs=${AI_REQUEST_TIMEOUT_MS}`,
  );
}

function buildSarvamClient(): ChatClient {
  const key = process.env.SARVAM_API_KEY || "sk-medcore-placeholder";
  const baseURL = "https://api.sarvam.ai/v1";
  logClientInit("sarvam", key, baseURL);
  return new OpenAI({
    // openai@6 throws "Missing credentials" at construction when apiKey
    // is empty; placeholder lets the factory succeed when env is unset.
    apiKey: key,
    baseURL,
    timeout: AI_REQUEST_TIMEOUT_MS,
    maxRetries: 0,
  });
}

function buildOpenAIClient(): ChatClient {
  const key = process.env.OPENAI_API_KEY || "sk-medcore-placeholder";
  const baseURL = process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
  logClientInit("openai", key, baseURL);
  return new OpenAI({
    apiKey: key,
    baseURL,
    timeout: AI_REQUEST_TIMEOUT_MS,
    maxRetries: 0,
  });
}

/**
 * Anthropic provider.
 *
 * Currently a stub: the Claude Messages API is NOT OpenAI-compatible (different
 * request/response shape, no `/chat/completions` endpoint, no function-calling
 * via `tools` in the same format), and `@anthropic-ai/sdk` was intentionally
 * removed from the dependency tree as part of the Sarvam-first consolidation.
 *
 * To re-enable (future work):
 *   1. `npm install @anthropic-ai/sdk` in `apps/api/package.json`.
 *   2. Replace this function with a real `Anthropic` client wrapped in an
 *      adapter that maps `chat.completions.create(...)` → `messages.create(...)`.
 *   3. The adapter needs to translate OpenAI-shape `tools` + `tool_choice`
 *      into Anthropic's `tools` + `tool_choice`, and map Anthropic's
 *      `content` blocks back into `choices[0].message.content` + `tool_calls`.
 *   4. Add `ANTHROPIC_API_KEY` check here.
 *
 * Until that adapter lands, attempting to use this provider throws a clear
 * error at startup rather than silently routing to a broken client.
 */
function buildAnthropicClient(): ChatClient {
  throw new Error(
    "Anthropic provider not yet implemented. Install @anthropic-ai/sdk and add an OpenAI-compat adapter in model-router.ts (see docstring)."
  );
}

/**
 * Return an OpenAI-compatible chat client for the requested provider. When
 * `provider` is omitted, reads `AI_PROVIDER` env var (default: `"sarvam"`).
 * Throws a descriptive error for unknown providers so misconfiguration is
 * caught at the first LLM call rather than producing a hard-to-debug runtime
 * shape mismatch.
 */
export function getChatClient(provider?: ModelProvider): ChatClient {
  const resolved: ModelProvider = (provider ??
    (process.env.AI_PROVIDER as ModelProvider | undefined) ??
    "sarvam") as ModelProvider;

  switch (resolved) {
    case "sarvam":
      return buildSarvamClient();
    case "openai":
      return buildOpenAIClient();
    case "anthropic":
      return buildAnthropicClient();
    default:
      throw new Error(
        `Unknown AI_PROVIDER "${resolved}". Expected one of: sarvam, openai, anthropic.`
      );
  }
}

// ── Failover ──────────────────────────────────────────────────────────────────

export interface FailoverOptions {
  /** Ordered list of providers to try. First success wins. */
  providers: ModelProvider[];
  /** Feature label so failover events land in the right bucket in logs. */
  feature: Parameters<typeof logAICall>[0]["feature"];
}

/**
 * Try `fn` against each provider in order. Returns on first success. On
 * failure, emits a `failover: true` ai_call log and moves to the next
 * provider. If every provider fails, re-throws the final error so the
 * caller's existing retry / graceful-degradation logic still fires.
 *
 * This is opt-in — existing call sites that only speak Sarvam keep working
 * unchanged. New call sites wrap their LLM call in
 * `callWithFallback(client => client.chat.completions.create(...), { providers, feature })`.
 */
export async function callWithFallback<T>(
  fn: (client: ChatClient, provider: ModelProvider) => Promise<T>,
  opts: FailoverOptions
): Promise<T> {
  const { providers, feature } = opts;
  if (providers.length === 0) {
    throw new Error("callWithFallback: providers array must not be empty");
  }

  let lastError: unknown;
  for (let i = 0; i < providers.length; i++) {
    const provider = providers[i];
    const isLast = i === providers.length - 1;
    try {
      const client = getChatClient(provider);
      return await fn(client, provider);
    } catch (err) {
      lastError = err;
      logAICall({
        feature,
        model: provider,
        promptTokens: 0,
        completionTokens: 0,
        latencyMs: 0,
        failover: true,
        error: err instanceof Error ? err.message : String(err),
      });
      if (isLast) {
        throw err;
      }
      // otherwise loop to next provider
    }
  }
  // Unreachable — loop either returns or throws on last iteration.
  throw lastError ?? new Error("callWithFallback: exhausted providers");
}
