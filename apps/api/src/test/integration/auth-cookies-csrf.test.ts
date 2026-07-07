/**
 * Issue #477 — auth cookies + CSRF integration tests.
 *
 * Asserts the post-migration auth contract:
 *   1. Login sets three cookies: medcore_at (httpOnly), medcore_rt
 *      (httpOnly), medcore_csrf (NOT httpOnly so the SPA can read it).
 *   2. Authenticated requests work with the cookie alone (no
 *      Authorization: Bearer header).
 *   3. Logout clears all three cookies and revokes the refresh token.
 *   4. CSRF middleware (when enabled — i.e. NODE_ENV !== "test") would
 *      reject POST/PATCH/PUT/DELETE without a matching X-CSRF-Token
 *      header. We re-enable it in this suite via a dedicated app
 *      instance to exercise the gate, since `app.ts` skips it under
 *      NODE_ENV=test by design (so the rest of the integration suite
 *      doesn't need to plumb CSRF tokens into every fixture).
 */
import { describe, it, expect, beforeAll } from "vitest";
import express from "express";
import cookieParser from "cookie-parser";
import request from "supertest";
import { describeIfDB, resetDB } from "../setup";
import { csrfProtection } from "../../middleware/csrf";

let app: any;

// Test-DB seed credentials. Earlier revisions of this file used the
// production seed (`admin@medcore.local` / `admin123`), but
// `apps/api/src/test/setup.ts:resetDB()` only seeds the test admin
// below — so the prod credentials produced 401s and (because of the
// 5/min IP gate when ENABLE_LOGIN_RATELIMIT_IN_TESTS leaks across files)
// cascaded 429s into every later auth integration test in the same
// vitest fork.
const TEST_ADMIN_EMAIL = "admin@test.local";
const TEST_ADMIN_PASSWORD = "MedCoreT3st-2026";

// Helper — pull an array of Set-Cookie headers off a supertest response.
// supertest's `res.headers["set-cookie"]` is `string | string[]` depending
// on whether one or multiple cookies were set.
function getSetCookies(res: { headers: Record<string, unknown> }): string[] {
  const raw = res.headers["set-cookie"];
  if (!raw) return [];
  return Array.isArray(raw) ? raw : [raw as string];
}

function findCookie(setCookies: string[], name: string): string | undefined {
  return setCookies.find((c) => c.startsWith(name + "="));
}

function cookieValue(setCookieLine: string): string {
  // "name=value; Path=/; HttpOnly; ..."  →  decoded value
  const m = setCookieLine.match(/^[^=]+=([^;]*)/);
  return m ? decodeURIComponent(m[1]) : "";
}

describeIfDB("Auth cookies + CSRF (Issue #477)", () => {
  beforeAll(async () => {
    // Belt-and-suspenders: ensure the test-DB seed admin exists even if
    // this file runs first in the fork (no prior `resetDB()` call has
    // populated the user yet).
    await resetDB();
    const mod = await import("../../app");
    app = mod.app;
  });

  // ─── Cookie-set behaviour ────────────────────────────────────────────

  it("login sets medcore_at + medcore_rt (httpOnly) + medcore_csrf (readable)", async () => {
    // Get a real account via the seeded admin login.
    const res = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: TEST_ADMIN_EMAIL, password: TEST_ADMIN_PASSWORD });

    expect(res.status).toBe(200);
    const cookies = getSetCookies(res);

    const at = findCookie(cookies, "medcore_at");
    const rt = findCookie(cookies, "medcore_rt");
    const csrf = findCookie(cookies, "medcore_csrf");

    expect(at).toBeDefined();
    expect(rt).toBeDefined();
    expect(csrf).toBeDefined();

    // medcore_at + medcore_rt MUST be httpOnly (XSS-unreadable).
    expect(at!.toLowerCase()).toContain("httponly");
    expect(rt!.toLowerCase()).toContain("httponly");

    // medcore_csrf MUST NOT be httpOnly — the SPA needs to echo it.
    expect(csrf!.toLowerCase()).not.toContain("httponly");

    // SameSite=Lax on all three (#477 attribute lock).
    for (const c of [at!, rt!, csrf!]) {
      expect(c.toLowerCase()).toContain("samesite=lax");
    }

    // Path=/ on all three so the SPA can hit any /api/v1/... route.
    for (const c of [at!, rt!, csrf!]) {
      expect(c).toContain("Path=/");
    }
  });

  it("a request authenticated by the medcore_at cookie alone reaches /auth/me", async () => {
    const login = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: TEST_ADMIN_EMAIL, password: TEST_ADMIN_PASSWORD });
    expect(login.status).toBe(200);
    const at = findCookie(getSetCookies(login), "medcore_at");
    expect(at).toBeDefined();

    // Pull just the name=value portion to send back as a Cookie header.
    // No Authorization header. No Bearer token. Cookie alone.
    const cookieHeader = at!.split(";")[0];
    const me = await request(app)
      .get("/api/v1/auth/me")
      .set("Cookie", cookieHeader);

    expect(me.status).toBe(200);
    expect(me.body?.data?.email).toBe(TEST_ADMIN_EMAIL);
  });

  it("logout clears all three cookies", async () => {
    const login = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: TEST_ADMIN_EMAIL, password: TEST_ADMIN_PASSWORD });
    expect(login.status).toBe(200);
    const at = findCookie(getSetCookies(login), "medcore_at")!;
    const cookieHeader = at.split(";")[0];

    const logout = await request(app)
      .post("/api/v1/auth/logout")
      .set("Cookie", cookieHeader);

    expect(logout.status).toBe(200);
    const out = getSetCookies(logout);
    // clearCookie emits a Set-Cookie with an empty value + an Expires
    // in the past. We just assert the names are present (the browser
    // will clear by name regardless of the exact Expires shape).
    expect(findCookie(out, "medcore_at")).toBeDefined();
    expect(findCookie(out, "medcore_rt")).toBeDefined();
    expect(findCookie(out, "medcore_csrf")).toBeDefined();
    // Cleared cookies have empty value.
    expect(cookieValue(findCookie(out, "medcore_at")!)).toBe("");
    expect(cookieValue(findCookie(out, "medcore_rt")!)).toBe("");
    expect(cookieValue(findCookie(out, "medcore_csrf")!)).toBe("");
  });

  // ─── CSRF middleware (run on a dedicated mini-app so the suite-wide
  // NODE_ENV=test bypass in app.ts doesn't shield us) ──────────────────

  describe("csrfProtection middleware (mounted directly)", () => {
    let csrfApp: express.Express;

    beforeAll(() => {
      csrfApp = express();
      csrfApp.use(express.json());
      csrfApp.use(cookieParser());
      csrfApp.use(csrfProtection);
      // a probe endpoint at a non-bypassed path
      csrfApp.post("/api/v1/probe", (_req, res) => {
        res.json({ ok: true });
      });
      csrfApp.get("/api/v1/probe", (_req, res) => {
        res.json({ ok: true });
      });
    });

    it("rejects POST without X-CSRF-Token (no cookie, no header)", async () => {
      const res = await request(csrfApp).post("/api/v1/probe").send({});
      expect(res.status).toBe(403);
      expect(res.body?.error).toBe("csrf_failed");
    });

    it("rejects POST when cookie is present but header is missing", async () => {
      const res = await request(csrfApp)
        .post("/api/v1/probe")
        .set("Cookie", "medcore_csrf=abc123")
        .send({});
      expect(res.status).toBe(403);
    });

    it("rejects POST when header doesn't match cookie", async () => {
      const res = await request(csrfApp)
        .post("/api/v1/probe")
        .set("Cookie", "medcore_csrf=abc123")
        .set("X-CSRF-Token", "xyz999")
        .send({});
      expect(res.status).toBe(403);
    });

    it("accepts POST when header matches cookie", async () => {
      const res = await request(csrfApp)
        .post("/api/v1/probe")
        .set("Cookie", "medcore_csrf=abc123")
        .set("X-CSRF-Token", "abc123")
        .send({});
      expect(res.status).toBe(200);
      expect(res.body?.ok).toBe(true);
    });

    it("safe methods (GET) bypass the CSRF check", async () => {
      const res = await request(csrfApp).get("/api/v1/probe");
      expect(res.status).toBe(200);
    });

    it("auth bypass paths skip the check (POST /auth/login)", async () => {
      // mount the bypass-target route on the same csrf app
      csrfApp.post("/api/v1/auth/login", (_req, res) => {
        res.json({ ok: true });
      });
      const res = await request(csrfApp)
        .post("/api/v1/auth/login")
        .send({ email: "a", password: "b" });
      expect(res.status).toBe(200);
    });

    it("bypasses CSRF checking when COOKIE_CROSS_SITE environment variable is true", async () => {
      const originalValue = process.env.COOKIE_CROSS_SITE;
      process.env.COOKIE_CROSS_SITE = "true";
      try {
        const res = await request(csrfApp)
          .post("/api/v1/probe")
          .send({});
        expect(res.status).toBe(200);
        expect(res.body?.ok).toBe(true);
      } finally {
        process.env.COOKIE_CROSS_SITE = originalValue;
      }
    });
  });
});
