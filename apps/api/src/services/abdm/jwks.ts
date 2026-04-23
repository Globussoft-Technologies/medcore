/**
 * ABDM Gateway JWKS signature verification.
 *
 * ABDM signs every outbound webhook callback with an RS256 JWT carried in
 * the `Authorization: Bearer <jwt>` header. The JWT header includes a `kid`
 * claim that identifies one of the keys published at
 *   `${ABDM_BASE_URL}/gateway/v0.5/certs`
 *
 * This module:
 *   • `fetchJwks(url)` — loads the JWKS, caches in-memory for 1 hour, and
 *     transparently reloads on a `kid` miss (key rotation).
 *   • `verifyGatewaySignature(authHeader, bodyBytes)` — parses the bearer
 *     JWT, finds the JWK, converts to a Node `KeyObject`, verifies RS256
 *     signature + `exp`/`nbf` claims. Returns `{valid, claims | reason}`.
 *
 * No third-party JWT library is used — everything runs on Node's built-in
 * `crypto` (`createPublicKey({key: jwk, format: "jwk"})` + `crypto.verify`).
 */

import { createPublicKey, createVerify, KeyObject } from "node:crypto";
import { ABDMError } from "./client";

// ── Types ─────────────────────────────────────────────────────────────────

export interface JsonWebKey {
  kty: string;
  kid?: string;
  use?: string;
  alg?: string;
  n?: string;
  e?: string;
  x?: string;
  y?: string;
  crv?: string;
  [k: string]: unknown;
}

export interface JWKS {
  keys: JsonWebKey[];
}

export interface JwtHeader {
  alg: string;
  typ?: string;
  kid?: string;
}

export type VerificationResult =
  | { valid: true; claims: Record<string, unknown>; kid: string | undefined }
  | { valid: false; reason: string };

// ── JWKS cache (1-hour TTL, reloaded on kid miss) ─────────────────────────

interface CachedJwks {
  jwks: JWKS;
  fetchedAt: number;
  url: string;
}

const JWKS_TTL_MS = 60 * 60 * 1000;
let cache: CachedJwks | null = null;

/** Exposed for tests. */
export function _resetJwksCache(): void {
  cache = null;
}

/** Exposed for tests. */
export function _peekJwksCache(): CachedJwks | null {
  return cache;
}

/**
 * Fetch the JWKS from ABDM. Caches result for 1 hour. Subsequent callers
 * within that TTL hit the cache. Set `forceRefresh = true` to bypass the
 * cache when a `kid` miss signals that the gateway rotated keys.
 */
export async function fetchJwks(
  url: string,
  opts: { forceRefresh?: boolean } = {}
): Promise<JWKS> {
  const now = Date.now();
  if (
    !opts.forceRefresh &&
    cache &&
    cache.url === url &&
    now - cache.fetchedAt < JWKS_TTL_MS
  ) {
    return cache.jwks;
  }

  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) {
    throw new ABDMError(`JWKS fetch failed: ${res.status}`, res.status);
  }
  const jwks = (await res.json()) as JWKS;
  if (!jwks?.keys || !Array.isArray(jwks.keys)) {
    throw new ABDMError("JWKS response missing `keys` array", 502, jwks);
  }
  cache = { jwks, fetchedAt: now, url };
  return jwks;
}

// ── JWKS helpers ──────────────────────────────────────────────────────────

function jwksUrl(): string {
  const base = process.env.ABDM_BASE_URL ?? "https://dev.abdm.gov.in";
  return process.env.ABDM_JWKS_URL ?? `${base}/gateway/v0.5/certs`;
}

/** Find a key by kid; fall back to first key if kid not present. */
function findKey(jwks: JWKS, kid: string | undefined): JsonWebKey | undefined {
  if (!kid) return jwks.keys[0];
  return jwks.keys.find((k) => k.kid === kid);
}

function jwkToPublicKey(jwk: JsonWebKey): KeyObject {
  // Node 16.9+ accepts JWK directly.
  return createPublicKey({ key: jwk as any, format: "jwk" });
}

// ── JWT parsing ───────────────────────────────────────────────────────────

function base64UrlDecode(s: string): Buffer {
  // base64url → base64
  let b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4;
  if (pad === 2) b64 += "==";
  else if (pad === 3) b64 += "=";
  else if (pad !== 0) throw new Error("invalid base64url string");
  return Buffer.from(b64, "base64");
}

function parseJwt(jwt: string): {
  header: JwtHeader;
  payload: Record<string, unknown>;
  signingInput: Buffer;
  signature: Buffer;
} {
  const parts = jwt.split(".");
  if (parts.length !== 3) {
    throw new Error("JWT must have 3 parts");
  }
  const [headerB64, payloadB64, sigB64] = parts as [string, string, string];
  const header = JSON.parse(base64UrlDecode(headerB64).toString("utf8")) as JwtHeader;
  const payload = JSON.parse(base64UrlDecode(payloadB64).toString("utf8")) as Record<
    string,
    unknown
  >;
  const signingInput = Buffer.from(`${headerB64}.${payloadB64}`, "utf8");
  const signature = base64UrlDecode(sigB64);
  return { header, payload, signingInput, signature };
}

function verifyRsa(alg: string, key: KeyObject, input: Buffer, sig: Buffer): boolean {
  const hashAlg =
    alg === "RS256" ? "RSA-SHA256" : alg === "RS384" ? "RSA-SHA384" : alg === "RS512" ? "RSA-SHA512" : null;
  if (!hashAlg) return false;
  const verifier = createVerify(hashAlg);
  verifier.update(input);
  verifier.end();
  return verifier.verify(key, sig);
}

// ── Public API ────────────────────────────────────────────────────────────

export interface VerifyOptions {
  /** Override JWKS URL for tests. */
  jwksUrl?: string;
  /** Current time in ms (injected for tests). */
  now?: number;
  /** Leeway (ms) for `exp` / `nbf`. Defaults to 5s. */
  clockToleranceMs?: number;
}

/**
 * Verify a bearer JWT supplied in an `Authorization` header against ABDM's
 * JWKS. Returns a discriminated union — callers must always check
 * `result.valid` before trusting claims.
 *
 * The `bodyBytes` argument is currently unused but kept in the signature so
 * callers can enable detached-payload verification (ABDM does not use it
 * today, but the CM-side digest pattern is on the roadmap).
 */
export async function verifyGatewaySignature(
  authHeader: string | undefined,
  _bodyBytes: Buffer | string | undefined,
  opts: VerifyOptions = {}
): Promise<VerificationResult> {
  if (!authHeader || typeof authHeader !== "string") {
    return { valid: false, reason: "missing Authorization header" };
  }
  const m = authHeader.match(/^Bearer\s+(\S+)$/i);
  if (!m) {
    return { valid: false, reason: "Authorization header must be `Bearer <jwt>`" };
  }
  const jwt = m[1]!;

  let header: JwtHeader;
  let payload: Record<string, unknown>;
  let signingInput: Buffer;
  let signature: Buffer;
  try {
    ({ header, payload, signingInput, signature } = parseJwt(jwt));
  } catch (err) {
    return { valid: false, reason: `malformed JWT: ${(err as Error).message}` };
  }

  if (!header.alg || !header.alg.startsWith("RS")) {
    return { valid: false, reason: `unsupported alg: ${header.alg}` };
  }

  const url = opts.jwksUrl ?? jwksUrl();

  // Load JWKS (cache may satisfy). If `kid` miss → force refresh once.
  let jwks: JWKS;
  try {
    jwks = await fetchJwks(url);
  } catch (err) {
    return { valid: false, reason: `JWKS fetch failed: ${(err as Error).message}` };
  }

  let jwk = findKey(jwks, header.kid);
  if (!jwk && header.kid) {
    try {
      jwks = await fetchJwks(url, { forceRefresh: true });
      jwk = findKey(jwks, header.kid);
    } catch (err) {
      return { valid: false, reason: `JWKS refresh failed: ${(err as Error).message}` };
    }
  }
  if (!jwk) {
    return { valid: false, reason: `kid "${header.kid ?? ""}" not in JWKS` };
  }

  let publicKey: KeyObject;
  try {
    publicKey = jwkToPublicKey(jwk);
  } catch (err) {
    return { valid: false, reason: `JWK→PEM conversion failed: ${(err as Error).message}` };
  }

  let sigValid = false;
  try {
    sigValid = verifyRsa(header.alg, publicKey, signingInput, signature);
  } catch (err) {
    return { valid: false, reason: `signature verify threw: ${(err as Error).message}` };
  }
  if (!sigValid) {
    return { valid: false, reason: "signature mismatch" };
  }

  // Claim-time checks (exp, nbf).
  const now = opts.now ?? Date.now();
  const leeway = opts.clockToleranceMs ?? 5_000;
  const expMs = typeof payload.exp === "number" ? (payload.exp as number) * 1000 : undefined;
  const nbfMs = typeof payload.nbf === "number" ? (payload.nbf as number) * 1000 : undefined;
  if (expMs !== undefined && now - leeway > expMs) {
    return { valid: false, reason: "JWT expired" };
  }
  if (nbfMs !== undefined && now + leeway < nbfMs) {
    return { valid: false, reason: "JWT not yet valid (nbf)" };
  }

  return { valid: true, claims: payload, kid: header.kid };
}
