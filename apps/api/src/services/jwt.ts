// JWT signing + verification service.
//
// Why this exists: MedCore historically signed every access + refresh token
// with HS256 + `process.env.JWT_SECRET` (a shared symmetric secret). Issue
// #482 is the migration to an asymmetric algorithm (RS256 / EdDSA) so the
// signing key never has to leave the API server, and downstream verifiers
// (mobile, worker pools, the e-prescription microservice slated for Q3) can
// validate tokens with only the public half.
//
// This module centralises the sign + verify path so every consumer
// (middleware/auth.ts, middleware/tenant.ts, routes/auth.ts,
// routes/feedback.ts) hits the same code, which means swapping algorithms is
// a single env-var flip rather than a 4-file grep-and-fix.
//
// Modes (selected by env vars; defaults preserve current production behaviour):
//
//   JWT_ALG = "HS256"  (default — current behaviour)
//     Sign + verify with `JWT_SECRET`. No keypair required.
//
//   JWT_ALG = "RS256"
//     Sign with `JWT_PRIVATE_KEY` (RSA PEM).
//     Verify with `JWT_PUBLIC_KEY` (RSA PEM).
//
//   JWT_ALG = "EdDSA"
//     Sign with `JWT_PRIVATE_KEY` (Ed25519 PEM).
//     Verify with `JWT_PUBLIC_KEY` (Ed25519 PEM).
//
//   JWT_DUAL_VERIFY_HS256_FALLBACK = "1"
//     Cutover-window helper. When the primary verify fails AND this flag is
//     set, we make a second attempt with HS256 + `JWT_SECRET`. This lets a
//     deployment switch its signing algorithm without 401-ing every
//     in-flight token that was minted under the old algorithm. The flag is
//     intended to be cleared ~24h after the cutover (the access-token TTL),
//     once all live tokens have rolled over.
//
// The refresh-token path is NOT part of this migration in the first wave —
// it keeps its own `JWT_REFRESH_SECRET` + HS256 path because refresh tokens
// are server-validated against a DB row anyway (no third-party verifier
// needs the public key), so the threat model is different. Wave 2 (a
// follow-up issue) will move refresh tokens onto the same scheme.
//
// Tests: apps/api/src/services/jwt.test.ts.
// Rotation procedure: docs/JWT_ROTATION.md.

import jwt, {
  type Algorithm,
  type JwtPayload,
  type Secret,
  type SignOptions,
  type VerifyOptions,
} from "jsonwebtoken";

const SUPPORTED_ALGS = ["HS256", "RS256", "EdDSA"] as const;
type SupportedAlg = (typeof SUPPORTED_ALGS)[number];

export interface JwtConfig {
  /** Primary algorithm used for SIGNING new access tokens. */
  alg: SupportedAlg;
  /** Material used to SIGN access tokens (string secret for HS256, PEM for RS256/EdDSA). */
  signingKey: Secret;
  /** Material used to VERIFY access tokens (same as signingKey for HS256, public PEM otherwise). */
  verifyKey: Secret;
  /** When true, verify failures retry with HS256 + JWT_SECRET. Rotation cutover only. */
  dualVerifyHs256Fallback: boolean;
  /** The HS256 fallback secret (only consulted when dualVerifyHs256Fallback === true). */
  hs256FallbackSecret: string;
  /** Source identifier for diagnostics — useful in test/health output. */
  source: "env" | "default";
}

let cached: JwtConfig | null = null;

/**
 * Resolve the active JWT configuration from `process.env`. Cached for the
 * lifetime of the process; tests that mutate env vars MUST call
 * {@link __resetJwtConfigForTests} between cases (singleFork worker reuse,
 * per CLAUDE.md test-infra gotcha #2).
 */
export function getJwtConfig(): JwtConfig {
  if (cached) return cached;

  const rawAlg = (process.env.JWT_ALG || "HS256").trim();
  if (!SUPPORTED_ALGS.includes(rawAlg as SupportedAlg)) {
    throw new Error(
      `[jwt] unsupported JWT_ALG="${rawAlg}". Supported: ${SUPPORTED_ALGS.join(", ")}.`,
    );
  }
  const alg = rawAlg as SupportedAlg;

  const hs256FallbackSecret = process.env.JWT_SECRET || "dev-secret";
  const dualVerifyHs256Fallback = process.env.JWT_DUAL_VERIFY_HS256_FALLBACK === "1";

  let signingKey: Secret;
  let verifyKey: Secret;

  if (alg === "HS256") {
    signingKey = hs256FallbackSecret;
    verifyKey = hs256FallbackSecret;
  } else {
    // RS256 / EdDSA both require the asymmetric pair.
    const priv = process.env.JWT_PRIVATE_KEY;
    const pub = process.env.JWT_PUBLIC_KEY;
    if (!priv || !pub) {
      throw new Error(
        `[jwt] JWT_ALG="${alg}" requires both JWT_PRIVATE_KEY and JWT_PUBLIC_KEY to be set ` +
          `(PEM-encoded). Got privateKey=${priv ? "set" : "missing"}, publicKey=${pub ? "set" : "missing"}. ` +
          `See docs/JWT_ROTATION.md for the cutover procedure.`,
      );
    }
    signingKey = priv;
    verifyKey = pub;
  }

  cached = {
    alg,
    signingKey,
    verifyKey,
    dualVerifyHs256Fallback,
    hs256FallbackSecret,
    source: process.env.JWT_ALG ? "env" : "default",
  };
  return cached;
}

/**
 * Clear the cached JWT config. Tests that mutate `JWT_ALG`, `JWT_PRIVATE_KEY`,
 * `JWT_PUBLIC_KEY`, `JWT_DUAL_VERIFY_HS256_FALLBACK`, or `JWT_SECRET` between
 * cases MUST call this; otherwise the first config wins for the whole worker
 * (singleFork: true shares one process across files).
 */
export function __resetJwtConfigForTests(): void {
  cached = null;
}

/**
 * Sign an access token using the active primary algorithm. Drop-in
 * replacement for the previous `jwt.sign(payload, process.env.JWT_SECRET, opts)`
 * calls, with the algorithm + key wired from {@link getJwtConfig}.
 */
export function signAccessToken(
  payload: string | object | Buffer,
  options: SignOptions = {},
): string {
  const cfg = getJwtConfig();
  return jwt.sign(payload, cfg.signingKey, {
    algorithm: cfg.alg as Algorithm,
    ...options,
  });
}

/**
 * Verify an access token. Returns the decoded payload on success, throws
 * jwt.JsonWebTokenError / jwt.TokenExpiredError on failure (same as
 * `jsonwebtoken.verify` directly).
 *
 * Behaviour:
 *   1. Try verifying with the primary algorithm + key.
 *   2. If that throws AND `JWT_DUAL_VERIFY_HS256_FALLBACK=1`, retry with
 *      HS256 + `JWT_SECRET`. This handles the rotation cutover window — see
 *      docs/JWT_ROTATION.md.
 *   3. If the fallback also throws, re-throw the ORIGINAL primary error
 *      (so the caller's 401 message matches what they'd see post-cutover).
 *
 * @throws {jwt.JsonWebTokenError} on signature failure
 * @throws {jwt.TokenExpiredError} on expiry
 */
export function verifyAccessToken<T = JwtPayload>(token: string): T {
  const cfg = getJwtConfig();
  const primaryOpts: VerifyOptions = { algorithms: [cfg.alg as Algorithm] };
  try {
    return jwt.verify(token, cfg.verifyKey, primaryOpts) as T;
  } catch (primaryErr) {
    if (!cfg.dualVerifyHs256Fallback) throw primaryErr;
    // Cutover-window fallback. Only attempt when the primary alg is NOT
    // already HS256 (otherwise we'd just retry the same op).
    if (cfg.alg === "HS256") throw primaryErr;
    try {
      return jwt.verify(token, cfg.hs256FallbackSecret, {
        algorithms: ["HS256"],
      }) as T;
    } catch {
      // Re-throw the PRIMARY error — that's the one we want callers to log,
      // not the noisy "tried HS256 too" path.
      throw primaryErr;
    }
  }
}

/**
 * Sign a refresh token. Refresh tokens are not part of the wave-1 RS256
 * migration (see top-of-file doc), so this stays on HS256 +
 * `JWT_REFRESH_SECRET`. Kept here so all sign/verify code lives in one
 * module — wave 2 will fold this onto the same scheme as access tokens.
 */
export function signRefreshToken(
  payload: string | object | Buffer,
  options: SignOptions = {},
): string {
  return jwt.sign(
    payload,
    process.env.JWT_REFRESH_SECRET || "dev-refresh-secret",
    { algorithm: "HS256", ...options },
  );
}

/**
 * Verify a refresh token. HS256 with `JWT_REFRESH_SECRET`. See
 * {@link signRefreshToken} for the rationale.
 */
export function verifyRefreshToken<T = JwtPayload>(token: string): T {
  return jwt.verify(
    token,
    process.env.JWT_REFRESH_SECRET || "dev-refresh-secret",
    { algorithms: ["HS256"] },
  ) as T;
}
