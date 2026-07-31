/**
 * Unit tests for the double-submit CSRF middleware (issue #477 follow-up).
 *
 * What's locked here:
 *   - Safe methods (GET/HEAD/OPTIONS) always pass through.
 *   - Auth bootstrap endpoints (login/register/refresh/2fa-*) bypass CSRF
 *     because they MINT the CSRF cookie — they have other defences (rate-
 *     limit, brute-force lockout, signed webhooks).
 *   - For all other mutations, the X-CSRF-Token header MUST equal the
 *     medcore_csrf cookie value. Missing header, missing cookie, or
 *     mismatch returns a 403 with the user-facing message envelope from
 *     issue #645 (legacy `error: "csrf_failed"` PLUS the new `message`).
 *
 * Pure middleware with no external deps — mock the Express
 * Request/Response with plain objects + vi.fn() spies.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { csrfProtection } from "./csrf";
import { COOKIE_CSRF } from "./auth-cookies";

type MockReq = {
  method: string;
  path: string;
  cookies: Record<string, string>;
  headers: Record<string, string | string[] | undefined>;
};

function makeReq(overrides: Partial<MockReq> = {}): MockReq {
  return {
    method: "POST",
    path: "/api/v1/patients",
    cookies: {},
    headers: {},
    ...overrides,
  };
}

function makeRes() {
  const res: any = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

describe("csrfProtection — safe-method bypass", () => {
  let next: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    next = vi.fn();
  });

  it("calls next() for GET without inspecting cookies or headers", () => {
    const req = makeReq({ method: "GET" });
    const res = makeRes();
    csrfProtection(req as any, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it("calls next() for HEAD requests", () => {
    const req = makeReq({ method: "HEAD" });
    const res = makeRes();
    csrfProtection(req as any, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it("calls next() for OPTIONS requests (CORS preflight)", () => {
    const req = makeReq({ method: "OPTIONS" });
    const res = makeRes();
    csrfProtection(req as any, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it("does NOT bypass for safe-method-lookalikes (e.g. lowercase 'get')", () => {
    // Express normalizes method to uppercase, but be defensive: lowercase
    // must fall through to the cookie check (and 403 here, no cookie).
    const req = makeReq({ method: "get" });
    const res = makeRes();
    csrfProtection(req as any, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });
});

describe("csrfProtection — path-based bypass for auth bootstrap routes", () => {
  let next: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    next = vi.fn();
  });

  const bypassPaths = [
    "/api/v1/auth/login",
    "/api/v1/auth/register",
    "/api/v1/auth/refresh",
    "/api/v1/auth/2fa-verify",
    "/api/v1/auth/2fa-validate",
    "/api/v1/auth/forgot-password",
    "/api/v1/auth/reset-password",
    // Pearl §8.2 — the login-time 2FA code-entry + the mandatory TOTP
    // enrolment endpoints. All three run BEFORE the caller has a
    // session cookie (so no medcore_csrf to echo back); each has its
    // own one-shot temp-token defence.
    "/api/v1/auth/2fa/verify-login",
    "/api/v1/auth/2fa/enrol-setup",
    "/api/v1/auth/2fa/enrol-verify",
    "/api/v1/billing/webhooks/razorpay",
    "/api/v1/public/booking/recommend-hospitals",
    // Public ABHA (ABDM M1 V3) Aadhaar flow — unauthenticated booking surface,
    // no session/CSRF cookie. startsWith covers request-otp / verify-otp /
    // login/* / profile / card. See routes/public-abha.ts.
    "/api/v1/public/abha/request-otp",
    "/api/v1/public/abha/verify-otp",
    "/api/v1/public/abha/login/request-otp",
    "/api/v1/public/abha/login/verify-otp",
  ];

  for (const path of bypassPaths) {
    it(`bypasses CSRF for POST ${path} (mint/refresh endpoint)`, () => {
      const req = makeReq({ method: "POST", path });
      const res = makeRes();
      csrfProtection(req as any, res, next);
      expect(next).toHaveBeenCalledTimes(1);
      expect(res.status).not.toHaveBeenCalled();
    });
  }

  it("uses startsWith semantics — sub-paths of bypass routes also bypass", () => {
    // e.g. /api/v1/auth/login/anything-suffixed still bypasses.
    const req = makeReq({ method: "POST", path: "/api/v1/auth/login/extra" });
    const res = makeRes();
    csrfProtection(req as any, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("does NOT bypass for unrelated /api/v1/auth/* mutation endpoints", () => {
    // Session-management mutations like /api/v1/auth/sessions/logout-others are
    // NOT in the bypass list — they MUST require a valid CSRF token. (Logout
    // itself IS bypassed so it can always clear cookies even with a stale CSRF
    // token — see CSRF_BYPASS_PATHS.)
    const req = makeReq({
      method: "POST",
      path: "/api/v1/auth/sessions/logout-others",
    });
    const res = makeRes();
    csrfProtection(req as any, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("does NOT bypass for arbitrary non-auth mutations even on similar path prefixes", () => {
    // /api/v1/audit-logs is NOT /api/v1/auth/* — must enforce.
    const req = makeReq({ method: "POST", path: "/api/v1/audit-logs" });
    const res = makeRes();
    csrfProtection(req as any, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });
});

describe("csrfProtection — double-submit happy path", () => {
  let next: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    next = vi.fn();
  });

  it("calls next() when X-CSRF-Token header matches the medcore_csrf cookie", () => {
    const token = "abc123def456";
    const req = makeReq({
      cookies: { [COOKIE_CSRF]: token },
      headers: { "x-csrf-token": token },
    });
    const res = makeRes();
    csrfProtection(req as any, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it("accepts arbitrary token shapes — only equality matters", () => {
    // The middleware doesn't validate token format; it just compares.
    const token = "!@#$%^&*()_+ a token with spaces and symbols";
    const req = makeReq({
      cookies: { [COOKIE_CSRF]: token },
      headers: { "x-csrf-token": token },
    });
    const res = makeRes();
    csrfProtection(req as any, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("works across all unsafe methods (POST, PUT, PATCH, DELETE)", () => {
    const token = "matched-token";
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const localNext = vi.fn();
      const req = makeReq({
        method,
        cookies: { [COOKIE_CSRF]: token },
        headers: { "x-csrf-token": token },
      });
      const res = makeRes();
      csrfProtection(req as any, res, localNext);
      expect(localNext).toHaveBeenCalledTimes(1);
      expect(res.status).not.toHaveBeenCalled();
    }
  });
});

describe("csrfProtection — rejection scenarios (403)", () => {
  let next: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    next = vi.fn();
  });

  it("rejects when the X-CSRF-Token header is missing", () => {
    const req = makeReq({
      cookies: { [COOKIE_CSRF]: "real-token" },
      headers: {},
    });
    const res = makeRes();
    csrfProtection(req as any, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("rejects when the medcore_csrf cookie is missing", () => {
    const req = makeReq({
      cookies: {},
      headers: { "x-csrf-token": "some-token" },
    });
    const res = makeRes();
    csrfProtection(req as any, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("rejects when both header and cookie are missing", () => {
    const req = makeReq({ cookies: {}, headers: {} });
    const res = makeRes();
    csrfProtection(req as any, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("rejects when header and cookie are present but differ", () => {
    const req = makeReq({
      cookies: { [COOKIE_CSRF]: "real-token" },
      headers: { "x-csrf-token": "forged-token" },
    });
    const res = makeRes();
    csrfProtection(req as any, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("rejects when the cookie value is the empty string (falsy)", () => {
    const req = makeReq({
      cookies: { [COOKIE_CSRF]: "" },
      headers: { "x-csrf-token": "" },
    });
    const res = makeRes();
    csrfProtection(req as any, res, next);
    // Empty string is falsy → !cookieToken triggers, so 403 even though
    // they match. This prevents the "both blank" trivial forgery.
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("rejects when req.cookies is undefined (no cookie-parser ran)", () => {
    // Defensive: the optional-chain `req.cookies?.[...]` must short-circuit
    // gracefully to undefined rather than throw.
    const req = {
      method: "POST",
      path: "/api/v1/patients",
      cookies: undefined,
      headers: { "x-csrf-token": "anything" },
    };
    const res = makeRes();
    csrfProtection(req as any, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("is case-sensitive on token comparison (matching attacker-tampered casing)", () => {
    const req = makeReq({
      cookies: { [COOKIE_CSRF]: "AbCdEf" },
      headers: { "x-csrf-token": "abcdef" },
    });
    const res = makeRes();
    csrfProtection(req as any, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });
});

describe("csrfProtection — 403 response envelope (issue #645)", () => {
  let next: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    next = vi.fn();
  });

  it("returns the legacy csrf_failed error code (back-compat)", () => {
    const req = makeReq();
    const res = makeRes();
    csrfProtection(req as any, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    const body = res.json.mock.calls[0][0];
    expect(body.error).toBe("csrf_failed");
    expect(body.code).toBe("csrf_failed");
  });

  it("returns success:false and data:null per the standard error envelope", () => {
    const req = makeReq();
    const res = makeRes();
    csrfProtection(req as any, res, next);

    const body = res.json.mock.calls[0][0];
    expect(body.success).toBe(false);
    expect(body.data).toBeNull();
  });

  it("returns a user-facing message (NOT the raw csrf_failed enum) for clinicians", () => {
    const req = makeReq();
    const res = makeRes();
    csrfProtection(req as any, res, next);

    const body = res.json.mock.calls[0][0];
    expect(body.message).toBe(
      "Your session is out of sync. Please refresh the page and try again.",
    );
    // Critical: message must NOT just be the enum code (issue #645 fix).
    expect(body.message).not.toBe("csrf_failed");
  });
});
