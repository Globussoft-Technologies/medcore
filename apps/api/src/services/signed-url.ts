// HMAC-SHA256 signed-URL helper for short-lived access to medical files.
//
// Used by /api/v1/uploads list/show endpoints to expose PatientDocument
// download URLs that expire after a short TTL (default 15 minutes). The
// secret defaults to UPLOAD_SIGNING_SECRET, falling back to JWT_SECRET so
// existing deployments keep working without new env vars.
//
// Tokens are NOT a substitute for ACL — the verify endpoint must still
// re-check that the requester is allowed to read the document.

import crypto from "crypto";

export const DEFAULT_TTL_SECONDS = 15 * 60;

function getSecret(): string {
  return (
    process.env.UPLOAD_SIGNING_SECRET ||
    process.env.JWT_SECRET ||
    "dev-secret"
  );
}

function hmac(input: string): string {
  return crypto
    .createHmac("sha256", getSecret())
    .update(input)
    .digest("hex");
}

export interface SignedUrlParts {
  expires: number; // epoch seconds
  sig: string;
}

/**
 * Sign a logical resource path (eg. a documentId or relative file path) for
 * download. Returns the query-string fragment the client should append.
 *
 * Example:
 *   const qs = signUrl("doc:" + documentId);   // "expires=..&sig=.."
 *   `/api/v1/uploads/${documentId}?${qs}`
 */
export function signUrl(
  path: string,
  ttlSeconds: number = DEFAULT_TTL_SECONDS
): string {
  const expires = Math.floor(Date.now() / 1000) + Math.max(1, ttlSeconds);
  const sig = hmac(`${path}.${expires}`);
  return `expires=${expires}&sig=${sig}`;
}

/**
 * Produce only the parts (expires + sig) — useful when the caller wants to
 * embed them in JSON instead of appending to a URL.
 */
export function signParts(
  path: string,
  ttlSeconds: number = DEFAULT_TTL_SECONDS
): SignedUrlParts {
  const expires = Math.floor(Date.now() / 1000) + Math.max(1, ttlSeconds);
  const sig = hmac(`${path}.${expires}`);
  return { expires, sig };
}

/**
 * Verify a signature for a logical path. Returns true iff:
 *   - expires is a finite, non-expired epoch seconds value
 *   - sig matches HMAC(secret, `${path}.${expires}`)
 *
 * Uses crypto.timingSafeEqual to avoid leaking via timing.
 */
export function verifySignature(
  path: string,
  expires: number | string,
  sig: string | undefined
): boolean {
  if (!sig || typeof sig !== "string") return false;
  const expNum =
    typeof expires === "string" ? parseInt(expires, 10) : expires;
  if (!Number.isFinite(expNum)) return false;
  if (expNum < Math.floor(Date.now() / 1000)) return false;

  const expected = hmac(`${path}.${expNum}`);
  // Both buffers must be equal length for timingSafeEqual.
  const a = Buffer.from(expected, "hex");
  let b: Buffer;
  try {
    b = Buffer.from(sig, "hex");
  } catch {
    return false;
  }
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
