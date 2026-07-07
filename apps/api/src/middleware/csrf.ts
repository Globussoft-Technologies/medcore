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
  // Pre-signup email/phone availability probe. Caller has no session/CSRF
  // cookie yet (it runs on the register form before submit), and it's a
  // read-only existence check — rate-limited at the route.
  "/api/v1/auth/check-availability",
  "/api/v1/auth/refresh",
  "/api/v1/auth/logout",
  "/api/v1/auth/2fa-verify",
  "/api/v1/auth/2fa-validate",
  "/api/v1/auth/forgot-password",
  "/api/v1/auth/reset-password",
  // Login-time second factor for already-enrolled users. /auth/login
  // returns { twoFactorRequired: true, tempToken } and the operator
  // POSTs back to /auth/2fa/verify-login with the 6-digit code. They
  // still don't have a session cookie at this point — the tempToken
  // is the auth factor; it's single-shot with a 5-min TTL.
  "/api/v1/auth/2fa/verify-login",
  // Pearl §8.2 mandatory-TOTP enrolment-at-login. Caller has no
  // session yet (the login response was 412 + enrolToken), so the
  // medcore_csrf cookie doesn't exist. Defence in lieu of CSRF: the
  // `enrolToken` is minted only after valid credentials at /auth/login,
  // has a 5-minute TTL, and is single-shot on verify (consumed on
  // every verify attempt — wrong code burns it).
  "/api/v1/auth/2fa/enrol-setup",
  "/api/v1/auth/2fa/enrol-verify",
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
  // Public quick-appointment booking (June 2026). Fully unauthenticated —
  // the caller has no session and therefore no medcore_csrf cookie to echo,
  // so CSRF can't apply. Defence in lieu of CSRF: per-IP rate limiting
  // (suggest 20/min, book 10/min) + strict Zod validation on every body, and
  // the booking only ever creates a PATIENT row keyed by the supplied phone
  // (no privilege to escalate). See routes/public-booking.ts.
  "/api/v1/public/booking/suggest-doctors",
  "/api/v1/public/booking/book",
  // Read-only pre-submit duplicate check for the kiosk booking modal.
  "/api/v1/public/booking/check-appointment",
  // Voice symptom input — unauthenticated, no session/CSRF cookie. Locked
  // down by a tight per-IP rate limit (5/min) + a small audio cap. See
  // routes/public-booking.ts POST /transcribe.
  "/api/v1/public/booking/transcribe",
  // AI triage chat — unauthenticated, no session/CSRF cookie. Rate-limited
  // (15/min) + turn/length-capped. See routes/public-booking.ts POST /chat.
  "/api/v1/public/booking/chat",
  // Public ABHA (ABDM M1 V3) Aadhaar flow for the pre-login booking page —
  // fully unauthenticated, so there is no medcore_csrf cookie to echo and
  // CSRF cannot apply. Defence in lieu of CSRF: per-IP rate limiting (OTP
  // sends 3/min) + strict Zod validation; Aadhaar/OTP are RSA-encrypted
  // server-side and the ABDM X-Token never reaches the browser. The prefix
  // covers request-otp / verify-otp / login/* / profile / card. See
  // routes/public-abha.ts.
  "/api/v1/public/abha",
  // Razorpay webhook is authenticated by signature, not CSRF — and is
  // mounted before express.json so it doesn't even pass through here,
  // but list it for documentation.
  "/api/v1/billing/webhooks/razorpay",
  // ABDM gateway webhooks — server-to-server POSTs from the ABDM gateway (or
  // the local mock), carrying NO session/CSRF cookie. They're authenticated by
  // the gateway's RS256 JWT signature (verifyAbdmSignature in routes/abdm.ts),
  // not CSRF. Without this bypass the link/consent/HI callbacks 403, leaving
  // AbhaLink rows stuck PENDING and consents un-granted.
  "/api/v1/abdm/gateway/callback",
  "/api/v1/abdm/hiu/data-push",
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

  // Cross-site mode (COOKIE_CROSS_SITE=true):
  // When the frontend (e.g. localhost:3000) and API are served from different
  // origins (e.g. dev tunnels), Same-Origin Policy prevents JavaScript from
  // reading the `medcore_csrf` cookie from the API domain. Since the client
  // cannot read the cookie, it cannot attach the `X-CSRF-Token` header.
  // We bypass CSRF checks in this mode to enable cross-site local testing.
  if (process.env.COOKIE_CROSS_SITE === "true") {
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
