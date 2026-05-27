/**
 * Double-submit CSRF protection.
 *
 * Issue #477 follow-up: when JWTs moved from localStorage into httpOnly
 * cookies, browsers started auto-attaching them to every same-site
 * request. SameSite=Lax blocks cross-site POST/PUT/PATCH/DELETE by
 * default, but a defence-in-depth posture still requires an explicit
 * CSRF check on mutations.
 *
 * Pattern (double-submit token):
 *   1. On login/register/refresh/2fa-verify, the server mints a random
 *      CSRF token and sets it as a NON-httpOnly cookie `medcore_csrf`.
 *   2. The frontend reads that cookie value with document.cookie and
 *      echoes it back as `X-CSRF-Token` on every mutation.
 *   3. This middleware compares the cookie and the header. A mismatch
 *      (or a missing header) → 403.
 *
 * An attacker on attacker.com cannot read the cookie value (Same-Origin
 * Policy) and therefore cannot construct a valid X-CSRF-Token, so the
 * forged request fails closed.
 *
 * Skipped:
 *   - Safe methods (GET, HEAD, OPTIONS).
 *   - Endpoints that mint the CSRF cookie itself (login, register,
 *     refresh, 2fa-verify, 2fa-validate, forgot-password,
 *     reset-password). Those have other defences:
 *       - login: rate-limited + brute-force lockout (#478)
 *       - register: anti-enumeration + rate-limited (#480/#493)
 *       - refresh: requires a valid refresh-token cookie
 *       - forgot/reset: rate-limited + tokenized (#128/#493)
 */
import type { Request, Response, NextFunction } from "express";
import { COOKIE_CSRF } from "./auth-cookies";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// Path prefixes that mint or rotate the CSRF cookie themselves. Mounted
// under /api/v1 in app.ts; the API_PREFIX is stripped by the time this
// middleware runs (it's mounted on the app, after the path-based
// routers). Patterns are tested against the FULL `req.path` so we match
// "/api/v1/auth/login" reliably regardless of where the middleware sits
// in the chain.
const CSRF_BYPASS_PATHS = [
  "/api/v1/auth/login",
  "/api/v1/auth/register",
  "/api/v1/auth/refresh",
  "/api/v1/auth/2fa-verify",
  "/api/v1/auth/2fa-validate",
  "/api/v1/auth/forgot-password",
  "/api/v1/auth/reset-password",
  // Patient bootstrap endpoints — these MINT the medcore_csrf cookie
  // themselves so they cannot require it. Each has its own defence:
  //   - otp-request: per-phone rate limiter (3/10min) — see patient-auth.ts
  //   - otp-verify: bcrypt challenge with 5-min TTL + 5-attempt limit
  //   - firebase-verify: Firebase ID-token signature + audience verification
  //     (firebase-admin verifyIdToken with checkRevoked) — see
  //     services/firebase-admin.ts. The verified phone_number claim drives
  //     the patient User lookup, never the request body.
  "/api/v1/patient-auth/otp-request",
  "/api/v1/patient-auth/otp-verify",
  "/api/v1/patient-auth/firebase-verify",
  // Razorpay webhook is authenticated by signature, not CSRF — and is
  // mounted before express.json so it doesn't even pass through here,
  // but list it for documentation.
  "/api/v1/billing/webhooks/razorpay",
];

const CSRF_HEADER = "x-csrf-token";

export function csrfProtection(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (SAFE_METHODS.has(req.method)) {
    next();
    return;
  }
  if (CSRF_BYPASS_PATHS.some((p) => req.path.startsWith(p))) {
    next();
    return;
  }

  const cookieToken = req.cookies?.[COOKIE_CSRF];
  const headerToken = req.headers[CSRF_HEADER];
  if (!cookieToken || !headerToken || cookieToken !== headerToken) {
    // Issue #645: surface a user-facing message instead of leaking the
    // internal `csrf_failed` enum to non-technical clinicians. The legacy
    // `error` field keeps the old code for back-compat with tests + any
    // code that switches on it; the new `message` field is what the
    // frontend should render.
    res.status(403).json({
      success: false,
      data: null,
      error: "csrf_failed",
      code: "csrf_failed",
      message:
        "Your session is out of sync. Please refresh the page and try again.",
    });
    return;
  }
  next();
}
