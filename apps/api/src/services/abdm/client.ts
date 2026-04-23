/**
 * ABDM (Ayushman Bharat Digital Mission) Gateway client.
 *
 * ── What this module does ─────────────────────────────────────────────────
 * 1. Acquires an OAuth 2.0 client-credentials access token from the ABDM
 *    Gateway (`POST /v0.5/sessions`) and caches it in-process until ~30s
 *    before expiry.
 * 2. Exposes a generic `abdmRequest<T>()` helper used by `abha.ts`,
 *    `consent.ts` and `health-records.ts` — every outbound call goes through
 *    here so retries, auth-refresh and error translation happen in one place.
 *
 * ── Stub vs Real ──────────────────────────────────────────────────────────
 * The OAuth flow and the HTTP wiring are real and functional. To actually
 * exchange data with ABDM you need:
 *   • ABDM_CLIENT_ID / ABDM_CLIENT_SECRET issued via https://sandbox.abdm.gov.in
 *   • ABDM_BASE_URL pointed at the Gateway (default: sandbox)
 * Without those env vars set, `getAccessToken()` will throw an
 * `ABDMConfigError` before any network call is made.
 *
 * ── Pattern ───────────────────────────────────────────────────────────────
 * Mirrors the `withRetry` + custom-error pattern used in
 * `apps/api/src/services/ai/sarvam.ts` (ABDMError replaces
 * AIServiceUnavailableError).
 */

// ── Errors ────────────────────────────────────────────────────────────────

/** Thrown when the ABDM Gateway is unreachable after exhausting retries. */
export class ABDMError extends Error {
  readonly statusCode: number;
  readonly upstreamBody?: unknown;
  constructor(message: string, statusCode = 503, upstreamBody?: unknown) {
    super(message);
    this.name = "ABDMError";
    this.statusCode = statusCode;
    this.upstreamBody = upstreamBody;
  }
}

/** Thrown at startup when ABDM env vars are missing — non-retryable. */
export class ABDMConfigError extends Error {
  readonly statusCode = 500;
  constructor(varName: string) {
    super(`ABDM configuration error: ${varName} is not set`);
    this.name = "ABDMConfigError";
  }
}

// ── Config ────────────────────────────────────────────────────────────────

function cfg() {
  const clientId = process.env.ABDM_CLIENT_ID;
  const clientSecret = process.env.ABDM_CLIENT_SECRET;
  const baseUrl = process.env.ABDM_BASE_URL ?? "https://dev.abdm.gov.in";
  const gatewayUrl = process.env.ABDM_GATEWAY_URL ?? `${baseUrl}/gateway`;
  if (!clientId) throw new ABDMConfigError("ABDM_CLIENT_ID");
  if (!clientSecret) throw new ABDMConfigError("ABDM_CLIENT_SECRET");
  return { clientId, clientSecret, baseUrl, gatewayUrl };
}

// ── Observability ─────────────────────────────────────────────────────────

function logABDMCall(opts: {
  op: string;
  method: string;
  url: string;
  status?: number;
  latencyMs: number;
  error?: string;
}) {
  console.log(
    JSON.stringify({ level: "info", event: "abdm_call", ...opts, ts: new Date().toISOString() })
  );
}

// ── Retry ─────────────────────────────────────────────────────────────────

function isRetryable(err: unknown, status?: number): boolean {
  if (status && status >= 500) return true;
  if (err instanceof Error) {
    if (
      err.message.includes("ECONNRESET") ||
      err.message.includes("ENOTFOUND") ||
      err.message.includes("ETIMEDOUT") ||
      err.message.includes("fetch failed") ||
      err.message.includes("socket hang up")
    ) {
      return true;
    }
  }
  return false;
}

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  const MAX_ATTEMPTS = 3;
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const status = err instanceof ABDMError ? err.statusCode : undefined;
      if (!isRetryable(err, status) || attempt === MAX_ATTEMPTS - 1) break;
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
  if (lastError instanceof ABDMError) throw lastError;
  throw new ABDMError(
    lastError instanceof Error ? lastError.message : "ABDM gateway unavailable"
  );
}

// ── Token cache ───────────────────────────────────────────────────────────

interface CachedToken {
  token: string;
  /** epoch ms */
  expiresAt: number;
}

let cached: CachedToken | null = null;

/** Exposed for tests only. */
export function _resetTokenCache(): void {
  cached = null;
}

/** Exposed for tests only. */
export function _peekCache(): CachedToken | null {
  return cached;
}

/**
 * Return a valid access token, fetching a new one from the Gateway if the
 * cached token is absent or within 30 seconds of expiry.
 */
export async function getAccessToken(): Promise<string> {
  const now = Date.now();
  if (cached && cached.expiresAt - 30_000 > now) {
    return cached.token;
  }

  const { clientId, clientSecret, gatewayUrl } = cfg();
  const url = `${gatewayUrl}/v0.5/sessions`;
  const t0 = now;

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        clientId,
        clientSecret,
        grantType: "client_credentials",
      }),
    });
  } catch (err) {
    logABDMCall({
      op: "token",
      method: "POST",
      url,
      latencyMs: Date.now() - t0,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    logABDMCall({ op: "token", method: "POST", url, status: res.status, latencyMs: Date.now() - t0 });
    throw new ABDMError(`ABDM token request failed: ${res.status}`, res.status, body);
  }

  const json = (await res.json()) as { accessToken: string; expiresIn?: number; tokenType?: string };
  if (!json?.accessToken) {
    throw new ABDMError("ABDM token response missing accessToken", 502, json);
  }

  // Default TTL = 30 min if gateway does not say otherwise.
  const ttlSec = typeof json.expiresIn === "number" && json.expiresIn > 0 ? json.expiresIn : 1800;
  cached = { token: json.accessToken, expiresAt: Date.now() + ttlSec * 1000 };
  logABDMCall({ op: "token", method: "POST", url, status: res.status, latencyMs: Date.now() - t0 });
  return cached.token;
}

// ── Generic request helper ────────────────────────────────────────────────

export interface ABDMRequestInit {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  path: string; // e.g. "/v0.5/users/auth/init"
  body?: unknown;
  /** Optional correlation header required by some ABDM endpoints. */
  requestId?: string;
  /** Optional extra headers (X-CM-ID, X-HIP-ID, etc.). */
  headers?: Record<string, string>;
  /** When true, skip prepending gateway base URL — use for HIP/HIU direct calls. */
  absoluteUrl?: boolean;
  /** Parse response as JSON (true) or return raw Response (false). Default true. */
  parseJson?: boolean;
}

/**
 * Make an authenticated request to the ABDM Gateway. Automatically refreshes
 * the OAuth token once on a 401 response.
 */
export async function abdmRequest<T = unknown>(init: ABDMRequestInit): Promise<T> {
  const { method = "GET", path, body, requestId, headers = {}, absoluteUrl, parseJson = true } = init;
  const { gatewayUrl } = cfg();
  const url = absoluteUrl ? path : `${gatewayUrl}${path}`;

  const doCall = async (token: string): Promise<Response> => {
    const t0 = Date.now();
    const reqId = requestId ?? crypto.randomUUID();
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "application/json",
          "X-CM-ID": process.env.ABDM_CM_ID ?? "sbx",
          "REQUEST-ID": reqId,
          TIMESTAMP: new Date().toISOString(),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      logABDMCall({
        op: path,
        method,
        url,
        latencyMs: Date.now() - t0,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
    logABDMCall({ op: path, method, url, status: res.status, latencyMs: Date.now() - t0 });
    return res;
  };

  return withRetry(async () => {
    let token = await getAccessToken();
    let res = await doCall(token);

    if (res.status === 401) {
      // Token might have been revoked — force refresh and retry once.
      _resetTokenCache();
      token = await getAccessToken();
      res = await doCall(token);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      let parsed: unknown = text;
      try {
        parsed = JSON.parse(text);
      } catch {
        /* leave as text */
      }
      throw new ABDMError(
        `ABDM ${method} ${path} failed: ${res.status}`,
        res.status,
        parsed
      );
    }

    if (!parseJson) {
      return res as unknown as T;
    }

    // Some ABDM endpoints reply 202 with no body (async callback pattern).
    const ct = res.headers.get("content-type") ?? "";
    if (res.status === 202 || !ct.includes("application/json")) {
      return {} as T;
    }
    return (await res.json()) as T;
  });
}
