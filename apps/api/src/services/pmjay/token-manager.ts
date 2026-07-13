// PM-JAY token manager.
//
// Owns the OAuth2 client-credentials lifecycle for the PM-JAY gateway so the
// adapter never has to think about authentication: obtain → cache → serve →
// auto-refresh on expiry, with a small retry budget on transient failures. In
// simulation mode it hands back a synthetic token without any network call, so
// the rest of the stack behaves identically whether or not real credentials
// exist.

import { PmjayConfig } from "./config";

interface CachedToken {
  accessToken: string;
  /** epoch ms at which we consider the token expired (with safety margin). */
  expiresAt: number;
}

/** Refresh a bit early so an in-flight request never races expiry. */
const EXPIRY_SKEW_MS = 60_000;

// Cache keyed by clientId so multiple tenants/deployments don't collide. Module
// scope — reset via `__resetTokenCacheForTests` under the test guard.
const cache = new Map<string, CachedToken>();

export interface TokenResult {
  ok: true;
  token: string;
}
export interface TokenError {
  ok: false;
  code: "AUTH_FAILED" | "TPA_UNAVAILABLE" | "RATE_LIMITED";
  message: string;
}

function nowMs(): number {
  return Date.now();
}

function cacheKey(cfg: PmjayConfig): string {
  return cfg.clientId ?? "__simulation__";
}

/** Simulation token — deterministic-ish, clearly not a real credential. */
function simulatedToken(): CachedToken {
  return {
    accessToken: "SIMULATED-PMJAY-TOKEN",
    expiresAt: nowMs() + 55 * 60_000,
  };
}

/**
 * Perform the real OAuth2 client-credentials exchange. Isolated so tests can
 * spy on it and so the retry loop in {@link getAccessToken} stays readable.
 * Live wiring target (varies by SHA deployment, hence env-driven):
 *   POST `${cfg.urls.auth}` (application/x-www-form-urlencoded)
 *   body: grant_type=client_credentials&client_id=..&client_secret=..
 *   200 → { access_token, expires_in }
 */
async function requestToken(cfg: PmjayConfig): Promise<TokenResult | TokenError> {
  if (!cfg.urls.auth || !cfg.clientId || !cfg.clientSecret) {
    return {
      ok: false,
      code: "AUTH_FAILED",
      message:
        "PM-JAY auth config incomplete: set TPA_PMJAY_AUTH_URL, TPA_PMJAY_CLIENT_ID, TPA_PMJAY_CLIENT_SECRET",
    };
  }
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
    let resp: Response;
    try {
      resp = await fetch(cfg.urls.auth, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          client_id: cfg.clientId,
          client_secret: cfg.clientSecret,
        }).toString(),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (resp.status === 429) {
      return { ok: false, code: "RATE_LIMITED", message: "PM-JAY auth rate-limited" };
    }
    if (resp.status === 401 || resp.status === 403) {
      return { ok: false, code: "AUTH_FAILED", message: "PM-JAY rejected credentials" };
    }
    if (!resp.ok) {
      return {
        ok: false,
        code: "TPA_UNAVAILABLE",
        message: `PM-JAY auth returned HTTP ${resp.status}`,
      };
    }
    const body = (await resp.json()) as {
      access_token?: string;
      expires_in?: number;
    };
    if (!body.access_token) {
      return { ok: false, code: "AUTH_FAILED", message: "PM-JAY auth response missing access_token" };
    }
    const ttlMs = (body.expires_in ?? 3600) * 1000;
    cache.set(cacheKey(cfg), {
      accessToken: body.access_token,
      expiresAt: nowMs() + ttlMs,
    });
    return { ok: true, token: body.access_token };
  } catch (err) {
    return {
      ok: false,
      code: "TPA_UNAVAILABLE",
      message: `PM-JAY auth network error: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
}

/**
 * Return a valid access token, refreshing if the cached one is missing or
 * within the expiry skew. Retries transient failures up to `cfg.retries`.
 */
export async function getAccessToken(
  cfg: PmjayConfig
): Promise<TokenResult | TokenError> {
  const key = cacheKey(cfg);

  if (cfg.simulation) {
    let tok = cache.get(key);
    if (!tok || tok.expiresAt - EXPIRY_SKEW_MS <= nowMs()) {
      tok = simulatedToken();
      cache.set(key, tok);
    }
    return { ok: true, token: tok.accessToken };
  }

  const cached = cache.get(key);
  if (cached && cached.expiresAt - EXPIRY_SKEW_MS > nowMs()) {
    return { ok: true, token: cached.accessToken };
  }

  let lastErr: TokenError = {
    ok: false,
    code: "TPA_UNAVAILABLE",
    message: "PM-JAY auth not attempted",
  };
  for (let attempt = 0; attempt <= cfg.retries; attempt++) {
    const res = await requestToken(cfg);
    if (res.ok) return res;
    lastErr = res;
    // AUTH_FAILED is not transient — bail immediately.
    if (res.code === "AUTH_FAILED") break;
  }
  return lastErr;
}

/** Force the next {@link getAccessToken} to re-authenticate (e.g. on a 401). */
export function invalidateToken(cfg: PmjayConfig): void {
  cache.delete(cacheKey(cfg));
}

/** @internal test-only — clear the module-scope token cache between files. */
export function __resetTokenCacheForTests(): void {
  if (process.env.NODE_ENV !== "test") return;
  cache.clear();
}
