// Pins the client-side mirror of the API's `sanitizeNextPath` helper
// (apps/api/src/routes/auth.ts:477, commit f1de292). The dashboard auth
// gate, the api-client 401 interceptor, and the login page all pass a
// `?next=` / `?redirect=` query param to `router.push()` /
// `window.location.replace()`. Without sanitisation a crafted link such
// as `/login?next=https://evil.example.com/harvest` becomes a classic
// open-redirect. These tests pin every rejection branch documented in
// the source jsdoc plus the legitimate same-origin pass-through so a
// future refactor cannot regress the gate.
import { describe, it, expect } from "vitest";
import { sanitizeNextPath } from "../utils";

const SAFE_DEFAULT = "/dashboard";

describe("sanitizeNextPath", () => {
  describe("non-string and empty inputs default to /dashboard", () => {
    it("returns the default for undefined", () => {
      expect(sanitizeNextPath(undefined)).toBe(SAFE_DEFAULT);
    });

    it("returns the default for null", () => {
      expect(sanitizeNextPath(null)).toBe(SAFE_DEFAULT);
    });

    it("returns the default for non-string primitives (number, boolean, object, array)", () => {
      expect(sanitizeNextPath(42)).toBe(SAFE_DEFAULT);
      expect(sanitizeNextPath(true)).toBe(SAFE_DEFAULT);
      expect(sanitizeNextPath({})).toBe(SAFE_DEFAULT);
      expect(sanitizeNextPath([])).toBe(SAFE_DEFAULT);
    });

    it("returns the default for the empty string", () => {
      expect(sanitizeNextPath("")).toBe(SAFE_DEFAULT);
    });

    it("returns the default for whitespace-only strings (trim then empty-check)", () => {
      expect(sanitizeNextPath("   ")).toBe(SAFE_DEFAULT);
      expect(sanitizeNextPath("\t\n")).toBe(SAFE_DEFAULT);
    });
  });

  describe("foreign-origin / open-redirect attempts default to /dashboard", () => {
    it("rejects absolute http(s) URLs", () => {
      expect(sanitizeNextPath("http://evil.example.com/harvest")).toBe(SAFE_DEFAULT);
      expect(sanitizeNextPath("https://evil.example.com/harvest")).toBe(SAFE_DEFAULT);
    });

    it("rejects absolute URLs case-insensitively (HTTP, HtTpS)", () => {
      expect(sanitizeNextPath("HTTP://evil.example.com")).toBe(SAFE_DEFAULT);
      expect(sanitizeNextPath("HtTpS://evil.example.com")).toBe(SAFE_DEFAULT);
    });

    it("rejects protocol-relative URLs (//evil.example.com)", () => {
      expect(sanitizeNextPath("//evil.example.com/harvest")).toBe(SAFE_DEFAULT);
      expect(sanitizeNextPath("//")).toBe(SAFE_DEFAULT);
    });

    it("rejects Windows UNC-style coercion (any backslash)", () => {
      expect(sanitizeNextPath("\\\\evil.example.com\\harvest")).toBe(SAFE_DEFAULT);
      expect(sanitizeNextPath("/dashboard\\foo")).toBe(SAFE_DEFAULT);
      expect(sanitizeNextPath("/\\evil.example.com")).toBe(SAFE_DEFAULT);
    });

    it("rejects relative paths that do not start with '/'", () => {
      expect(sanitizeNextPath("dashboard")).toBe(SAFE_DEFAULT);
      expect(sanitizeNextPath("./dashboard")).toBe(SAFE_DEFAULT);
      expect(sanitizeNextPath("../etc/passwd")).toBe(SAFE_DEFAULT);
      expect(sanitizeNextPath("evil.example.com")).toBe(SAFE_DEFAULT);
    });

    it("rejects redirects back to /login (would loop after sign-in)", () => {
      expect(sanitizeNextPath("/login")).toBe(SAFE_DEFAULT);
      expect(sanitizeNextPath("/login?next=/dashboard")).toBe(SAFE_DEFAULT);
      expect(sanitizeNextPath("/login/forgot")).toBe(SAFE_DEFAULT);
    });
  });

  describe("legitimate same-origin paths pass through unchanged", () => {
    it("returns a bare dashboard path", () => {
      expect(sanitizeNextPath("/dashboard")).toBe("/dashboard");
    });

    it("returns a nested dashboard path", () => {
      expect(sanitizeNextPath("/dashboard/appointments")).toBe("/dashboard/appointments");
    });

    it("preserves query strings", () => {
      expect(sanitizeNextPath("/dashboard/appointments?foo=bar")).toBe(
        "/dashboard/appointments?foo=bar",
      );
    });

    it("preserves hash fragments", () => {
      expect(sanitizeNextPath("/dashboard/appointments?foo=bar#x")).toBe(
        "/dashboard/appointments?foo=bar#x",
      );
    });

    it("preserves the root path", () => {
      expect(sanitizeNextPath("/")).toBe("/");
    });

    it("trims surrounding whitespace before evaluating the leading slash", () => {
      // The source trims first, then enforces the leading-slash rule against the trimmed value.
      expect(sanitizeNextPath("  /dashboard/x  ")).toBe("/dashboard/x");
    });
  });
});
