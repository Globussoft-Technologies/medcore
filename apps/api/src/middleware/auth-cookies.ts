/**
 * Auth cookie helpers — single source of truth for the cookie attributes
 * we set on login / register / refresh / 2fa-verify, and clear on logout.
 *
 * Issue #477 (HIGH, May 2026): JWTs were stored in localStorage. Any
 * successful XSS could exfiltrate the user's access AND refresh token,
 * compromising the session indefinitely. We migrated to httpOnly cookies:
 * the access + refresh tokens are httpOnly (unreadable from JS) and the
 * CSRF token is non-httpOnly (the frontend reads it and echoes it back
 * as `X-CSRF-Token` on every mutation — see middleware/csrf.ts).
 *
 * Cookie attributes (locked):
 *   - httpOnly:  true for access + refresh; false for csrf (must be readable)
 *   - secure:    process.env.NODE_ENV === "production" (so localhost dev still works on http)
 *   - sameSite:  "lax" — allows the email-link → dashboard entry flow while
 *                 still blocking XSRF mutations (browsers exclude cookies on
 *                 cross-origin POSTs by default with Lax)
 *   - path:      "/"
 *   - maxAge:    matches the corresponding JWT TTL
 */
import type { Response } from "express";
import crypto from "crypto";

export const COOKIE_AT = "medcore_at";
export const COOKIE_RT = "medcore_rt";
export const COOKIE_CSRF = "medcore_csrf";

const ACCESS_TTL_SECONDS = 24 * 60 * 60; // 24h, matches generateTokens accessToken
const REFRESH_TTL_SECONDS_DEFAULT = 7 * 24 * 60 * 60; // 7d default (login can request shorter for non-persistent)

/** Generate a fresh CSRF token. 32 bytes of entropy → 64 hex chars. */
export function newCsrfToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

/**
 * Set the three auth cookies on `res`. Call this immediately after
 * minting tokens in any of: login, register, refresh, 2fa-verify.
 *
 * @param refreshTtlSeconds caller-supplied (login may use a shorter TTL
 *   for non-persistent sessions). Defaults to the standard 7d.
 */
export function setAuthCookies(
  res: Response,
  tokens: { accessToken: string; refreshToken: string },
  refreshTtlSeconds: number = REFRESH_TTL_SECONDS_DEFAULT,
): { csrfToken: string } {
  const isProd = process.env.NODE_ENV === "production";
  const base = {
    httpOnly: true,
    secure: isProd,
    sameSite: "lax" as const,
    path: "/",
  };

  res.cookie(COOKIE_AT, tokens.accessToken, {
    ...base,
    maxAge: ACCESS_TTL_SECONDS * 1000,
  });
  res.cookie(COOKIE_RT, tokens.refreshToken, {
    ...base,
    maxAge: refreshTtlSeconds * 1000,
  });

  // CSRF cookie: NOT httpOnly — the frontend reads its value and echoes
  // it back as X-CSRF-Token on mutations. Same SameSite + Secure
  // posture so it travels with the access token but is independently
  // readable.
  const csrfToken = newCsrfToken();
  res.cookie(COOKIE_CSRF, csrfToken, {
    httpOnly: false,
    secure: isProd,
    sameSite: "lax",
    path: "/",
    // Match access-token lifetime — refreshing a session rotates the CSRF
    // cookie too, so we never have a stale CSRF outliving its access pair.
    maxAge: ACCESS_TTL_SECONDS * 1000,
  });

  return { csrfToken };
}

/**
 * Clear all three auth cookies. Call on logout.
 *
 * `clearCookie` only emits a Set-Cookie with an expired date if it can
 * find the cookie's options on the response — passing the same path/secure
 * matrix here makes the clear reliable across browsers.
 */
export function clearAuthCookies(res: Response): void {
  const isProd = process.env.NODE_ENV === "production";
  const base = {
    secure: isProd,
    sameSite: "lax" as const,
    path: "/",
  };
  res.clearCookie(COOKIE_AT, { ...base, httpOnly: true });
  res.clearCookie(COOKIE_RT, { ...base, httpOnly: true });
  res.clearCookie(COOKIE_CSRF, { ...base, httpOnly: false });
}
