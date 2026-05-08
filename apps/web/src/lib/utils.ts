/**
 * Frontend mirror of the API-side `sanitizeNextPath` helper at
 * `apps/api/src/routes/auth.ts:477` (commit f1de292). The dashboard auth
 * gate, the api-client 401 interceptor, and the login page all read a
 * `?next=` / `?redirect=` query param and pass it to `router.push()` /
 * `window.location.replace()`. Without sanitisation, an attacker can craft
 *
 *     /login?next=https://evil.example.com/harvest
 *     /login?next=//evil.example.com/harvest        (protocol-relative)
 *     /login?next=\\evil.example.com\harvest        (Windows UNC variant)
 *
 * and our login page would happily call `router.push("https://evil.example.com/...")`
 * after a successful sign-in — a classic open-redirect. The server already
 * sanitises any next-style param; this client-side helper applies the
 * same rule before navigation so a malicious link cannot reach the
 * Next.js router with a foreign-origin URL even briefly.
 *
 * Same logic as the server helper:
 *   - Reject non-strings, empty strings, missing values
 *   - Reject paths containing backslashes (Windows UNC coercion)
 *   - Require leading "/" (relative anchored at site root)
 *   - Reject "//" (protocol-relative)
 *   - Reject absolute http(s) URLs even after a malformed prefix
 *   - Default to "/dashboard"
 *
 * Anything else passes through unchanged so legitimate same-origin paths
 * like "/dashboard/appointments?foo=bar#x" survive the round-trip.
 */
export function sanitizeNextPath(next: unknown): string {
  const SAFE_DEFAULT = "/dashboard";
  if (typeof next !== "string") return SAFE_DEFAULT;
  const trimmed = next.trim();
  if (trimmed.length === 0) return SAFE_DEFAULT;
  if (trimmed.includes("\\")) return SAFE_DEFAULT;
  if (!trimmed.startsWith("/")) return SAFE_DEFAULT;
  if (trimmed.startsWith("//")) return SAFE_DEFAULT;
  if (/^https?:/i.test(trimmed)) return SAFE_DEFAULT;
  // Never bounce back to /login itself — would loop after sign-in.
  if (trimmed.startsWith("/login")) return SAFE_DEFAULT;
  return trimmed;
}
