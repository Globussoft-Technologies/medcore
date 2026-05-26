/**
 * Unit tests for the auth-cookie helpers (issue #477 — JWTs moved from
 * localStorage to httpOnly cookies + non-httpOnly CSRF). The contract these
 * tests lock is the cookie attributes the rest of the system relies on:
 *   - access + refresh cookies are httpOnly (unreadable from JS)
 *   - csrf cookie is NOT httpOnly (frontend reads it and echoes to header)
 *   - secure flips with NODE_ENV=production
 *   - sameSite is always "lax"
 *   - maxAge matches the declared TTLs (24h access / caller-controlled refresh)
 * Pure helpers with no external deps beyond Node `crypto` — mock the
 * Express Response with vi.fn() spies on `cookie` / `clearCookie`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  COOKIE_AT,
  COOKIE_RT,
  COOKIE_CSRF,
  newCsrfToken,
  setAuthCookies,
  clearAuthCookies,
} from "./auth-cookies";

const ACCESS_TTL_MS = 24 * 60 * 60 * 1000;
const REFRESH_TTL_DEFAULT_MS = 7 * 24 * 60 * 60 * 1000;

function makeRes() {
  const res: any = {};
  res.cookie = vi.fn().mockReturnValue(res);
  res.clearCookie = vi.fn().mockReturnValue(res);
  return res;
}

describe("auth-cookies — exported constants", () => {
  it("uses the medcore_ prefix for all three cookie names", () => {
    expect(COOKIE_AT).toBe("medcore_at");
    expect(COOKIE_RT).toBe("medcore_rt");
    expect(COOKIE_CSRF).toBe("medcore_csrf");
  });

  it("uses three distinct names so cookies do not collide", () => {
    const names = new Set([COOKIE_AT, COOKIE_RT, COOKIE_CSRF]);
    expect(names.size).toBe(3);
  });
});

describe("newCsrfToken", () => {
  it("returns a 64-character hex string (32 bytes of entropy)", () => {
    const token = newCsrfToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns a different value on every call (cryptographically random)", () => {
    const tokens = new Set<string>();
    for (let i = 0; i < 100; i++) tokens.add(newCsrfToken());
    // 100 random 256-bit values colliding is astronomically improbable
    expect(tokens.size).toBe(100);
  });
});

describe("setAuthCookies — base behaviour", () => {
  const originalEnv = process.env.NODE_ENV;

  beforeEach(() => {
    // Default to non-production so the secure flag is false in most cases.
    process.env.NODE_ENV = "development";
  });

  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
  });

  it("sets all three cookies (access, refresh, csrf) in one call", () => {
    const res = makeRes();
    setAuthCookies(res, { accessToken: "AT", refreshToken: "RT" });

    expect(res.cookie).toHaveBeenCalledTimes(3);
    const names = res.cookie.mock.calls.map((c: any[]) => c[0]);
    expect(names).toEqual([COOKIE_AT, COOKIE_RT, COOKIE_CSRF]);
  });

  it("returns the freshly-minted CSRF token to the caller", () => {
    const res = makeRes();
    const result = setAuthCookies(res, { accessToken: "AT", refreshToken: "RT" });

    expect(result.csrfToken).toMatch(/^[0-9a-f]{64}$/);
    // And the same value is what was written into the cookie
    const csrfCall = res.cookie.mock.calls.find((c: any[]) => c[0] === COOKIE_CSRF);
    expect(csrfCall[1]).toBe(result.csrfToken);
  });

  it("writes the access token value verbatim into the access cookie", () => {
    const res = makeRes();
    setAuthCookies(res, { accessToken: "my-access-jwt", refreshToken: "my-refresh-jwt" });

    const atCall = res.cookie.mock.calls.find((c: any[]) => c[0] === COOKIE_AT);
    expect(atCall[1]).toBe("my-access-jwt");
    const rtCall = res.cookie.mock.calls.find((c: any[]) => c[0] === COOKIE_RT);
    expect(rtCall[1]).toBe("my-refresh-jwt");
  });
});

describe("setAuthCookies — cookie attributes (httpOnly / secure / sameSite / path)", () => {
  const originalEnv = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
  });

  it("access + refresh cookies are httpOnly; csrf is NOT httpOnly", () => {
    process.env.NODE_ENV = "development";
    const res = makeRes();
    setAuthCookies(res, { accessToken: "AT", refreshToken: "RT" });

    const calls = Object.fromEntries(
      res.cookie.mock.calls.map((c: any[]) => [c[0], c[2]]),
    );
    expect(calls[COOKIE_AT].httpOnly).toBe(true);
    expect(calls[COOKIE_RT].httpOnly).toBe(true);
    // CSRF must be readable by the frontend so it can echo as X-CSRF-Token
    expect(calls[COOKIE_CSRF].httpOnly).toBe(false);
  });

  it("all three cookies use sameSite=lax", () => {
    process.env.NODE_ENV = "development";
    const res = makeRes();
    setAuthCookies(res, { accessToken: "AT", refreshToken: "RT" });

    for (const call of res.cookie.mock.calls) {
      expect(call[2].sameSite).toBe("lax");
    }
  });

  it("all three cookies use path=/", () => {
    process.env.NODE_ENV = "development";
    const res = makeRes();
    setAuthCookies(res, { accessToken: "AT", refreshToken: "RT" });

    for (const call of res.cookie.mock.calls) {
      expect(call[2].path).toBe("/");
    }
  });

  it("secure=false when NODE_ENV is not production (localhost dev http)", () => {
    process.env.NODE_ENV = "development";
    const res = makeRes();
    setAuthCookies(res, { accessToken: "AT", refreshToken: "RT" });

    for (const call of res.cookie.mock.calls) {
      expect(call[2].secure).toBe(false);
    }
  });

  it("secure=true when NODE_ENV=production", () => {
    process.env.NODE_ENV = "production";
    const res = makeRes();
    setAuthCookies(res, { accessToken: "AT", refreshToken: "RT" });

    for (const call of res.cookie.mock.calls) {
      expect(call[2].secure).toBe(true);
    }
  });

  it("secure=false when NODE_ENV=test (CI runs)", () => {
    process.env.NODE_ENV = "test";
    const res = makeRes();
    setAuthCookies(res, { accessToken: "AT", refreshToken: "RT" });

    for (const call of res.cookie.mock.calls) {
      expect(call[2].secure).toBe(false);
    }
  });
});

describe("setAuthCookies — maxAge / TTL handling", () => {
  const originalEnv = process.env.NODE_ENV;
  beforeEach(() => {
    process.env.NODE_ENV = "development";
  });
  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
  });

  it("access cookie maxAge is 24h in ms", () => {
    const res = makeRes();
    setAuthCookies(res, { accessToken: "AT", refreshToken: "RT" });

    const atCall = res.cookie.mock.calls.find((c: any[]) => c[0] === COOKIE_AT);
    expect(atCall[2].maxAge).toBe(ACCESS_TTL_MS);
  });

  it("refresh cookie maxAge defaults to 7d when no TTL is supplied", () => {
    const res = makeRes();
    setAuthCookies(res, { accessToken: "AT", refreshToken: "RT" });

    const rtCall = res.cookie.mock.calls.find((c: any[]) => c[0] === COOKIE_RT);
    expect(rtCall[2].maxAge).toBe(REFRESH_TTL_DEFAULT_MS);
  });

  it("refresh cookie maxAge honours a caller-supplied shorter TTL (non-persistent session)", () => {
    const res = makeRes();
    const shortTtl = 60 * 60; // 1h
    setAuthCookies(res, { accessToken: "AT", refreshToken: "RT" }, shortTtl);

    const rtCall = res.cookie.mock.calls.find((c: any[]) => c[0] === COOKIE_RT);
    expect(rtCall[2].maxAge).toBe(shortTtl * 1000);
  });

  it("refresh cookie maxAge honours a caller-supplied longer TTL (extended persistence)", () => {
    const res = makeRes();
    const longTtl = 30 * 24 * 60 * 60; // 30d
    setAuthCookies(res, { accessToken: "AT", refreshToken: "RT" }, longTtl);

    const rtCall = res.cookie.mock.calls.find((c: any[]) => c[0] === COOKIE_RT);
    expect(rtCall[2].maxAge).toBe(longTtl * 1000);
  });

  it("csrf cookie maxAge matches the access cookie TTL (rotates together)", () => {
    const res = makeRes();
    setAuthCookies(res, { accessToken: "AT", refreshToken: "RT" });

    const csrfCall = res.cookie.mock.calls.find((c: any[]) => c[0] === COOKIE_CSRF);
    expect(csrfCall[2].maxAge).toBe(ACCESS_TTL_MS);
  });

  it("csrf cookie TTL is NOT affected by the refresh-cookie TTL override", () => {
    const res = makeRes();
    setAuthCookies(res, { accessToken: "AT", refreshToken: "RT" }, 30 * 24 * 60 * 60);

    const csrfCall = res.cookie.mock.calls.find((c: any[]) => c[0] === COOKIE_CSRF);
    expect(csrfCall[2].maxAge).toBe(ACCESS_TTL_MS);
  });
});

describe("setAuthCookies — CSRF token freshness", () => {
  it("mints a different CSRF token on each invocation", () => {
    const res1 = makeRes();
    const res2 = makeRes();
    const r1 = setAuthCookies(res1, { accessToken: "AT", refreshToken: "RT" });
    const r2 = setAuthCookies(res2, { accessToken: "AT", refreshToken: "RT" });
    expect(r1.csrfToken).not.toBe(r2.csrfToken);
  });
});

describe("clearAuthCookies", () => {
  const originalEnv = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
  });

  it("clears all three cookies in one call", () => {
    process.env.NODE_ENV = "development";
    const res = makeRes();
    clearAuthCookies(res);

    expect(res.clearCookie).toHaveBeenCalledTimes(3);
    const names = res.clearCookie.mock.calls.map((c: any[]) => c[0]);
    expect(names).toEqual([COOKIE_AT, COOKIE_RT, COOKIE_CSRF]);
  });

  it("returns void", () => {
    const res = makeRes();
    const result = clearAuthCookies(res);
    expect(result).toBeUndefined();
  });

  it("clears access + refresh with httpOnly=true; csrf with httpOnly=false (matches set)", () => {
    process.env.NODE_ENV = "development";
    const res = makeRes();
    clearAuthCookies(res);

    const calls = Object.fromEntries(
      res.clearCookie.mock.calls.map((c: any[]) => [c[0], c[1]]),
    );
    expect(calls[COOKIE_AT].httpOnly).toBe(true);
    expect(calls[COOKIE_RT].httpOnly).toBe(true);
    expect(calls[COOKIE_CSRF].httpOnly).toBe(false);
  });

  it("clears all three with sameSite=lax and path=/", () => {
    process.env.NODE_ENV = "development";
    const res = makeRes();
    clearAuthCookies(res);

    for (const call of res.clearCookie.mock.calls) {
      expect(call[1].sameSite).toBe("lax");
      expect(call[1].path).toBe("/");
    }
  });

  it("secure=false on clear when NODE_ENV is not production", () => {
    process.env.NODE_ENV = "development";
    const res = makeRes();
    clearAuthCookies(res);

    for (const call of res.clearCookie.mock.calls) {
      expect(call[1].secure).toBe(false);
    }
  });

  it("secure=true on clear when NODE_ENV=production (so the browser actually matches the set cookie)", () => {
    process.env.NODE_ENV = "production";
    const res = makeRes();
    clearAuthCookies(res);

    for (const call of res.clearCookie.mock.calls) {
      expect(call[1].secure).toBe(true);
    }
  });
});
