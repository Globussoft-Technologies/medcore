/**
 * Covers `apps/web/src/app/sitemap.ts` — Next.js 15 App Router sitemap route.
 *
 * The file is a single default-exported function returning a static
 * `MetadataRoute.Sitemap` array. There are no branches, no fetches, and no
 * runtime params — coverage targets are: every public marketing URL is
 * present, each entry carries the four required keys (url, lastModified,
 * changeFrequency, priority), URLs are absolute under the BASE host,
 * lastModified is a fresh `Date` per invocation, and changeFrequency +
 * priority match the SEO contract (home daily-ish + highest priority,
 * features/pricing high, legal/auth pages low).
 *
 * Sister manifest test at `apps/web/src/app/__tests__/manifest.test.ts` is
 * the canonical neighbor pattern for static-config exports.
 */
import { describe, it, expect } from "vitest";

import sitemap from "../sitemap";

const BASE = "https://medcore.globusdemos.com";
const EXPECTED_PATHS = [
  "/",
  "/features",
  "/solutions",
  "/pricing",
  "/about",
  "/contact",
  "/login",
  "/register",
];

describe("app/sitemap — default export shape", () => {
  it("is a function that returns an array", () => {
    expect(typeof sitemap).toBe("function");
    const result = sitemap();
    expect(Array.isArray(result)).toBe(true);
  });

  it("returns 8 entries (one per public marketing surface)", () => {
    expect(sitemap()).toHaveLength(8);
  });

  it("returns a fresh Date for lastModified on each invocation", () => {
    const a = sitemap();
    const b = sitemap();
    // Different array references — pure function with no module-scope cache.
    expect(a).not.toBe(b);
    // lastModified should be a Date instance, not a string.
    for (const entry of a) {
      expect(entry.lastModified).toBeInstanceOf(Date);
    }
  });

  it("lastModified is close to 'now' (within 5s of test execution)", () => {
    const before = Date.now();
    const entries = sitemap();
    const after = Date.now();
    for (const entry of entries) {
      const ts = (entry.lastModified as Date).getTime();
      expect(ts).toBeGreaterThanOrEqual(before - 5000);
      expect(ts).toBeLessThanOrEqual(after + 5000);
    }
  });
});

describe("app/sitemap — URL entries", () => {
  const entries = sitemap();
  const urls = entries.map((e) => e.url);

  it("includes every expected public marketing path", () => {
    for (const path of EXPECTED_PATHS) {
      expect(urls).toContain(`${BASE}${path}`);
    }
  });

  it("every url is absolute under the production host", () => {
    for (const entry of entries) {
      expect(entry.url.startsWith(`${BASE}/`)).toBe(true);
    }
  });

  it("does NOT leak any dashboard / API / internal paths", () => {
    for (const entry of entries) {
      expect(entry.url).not.toMatch(/\/dashboard/);
      expect(entry.url).not.toMatch(/\/api\//);
      expect(entry.url).not.toMatch(/\/super-admin/);
      expect(entry.url).not.toMatch(/\/patient(\/|$)/);
    }
  });

  it("every entry declares the four required Sitemap keys", () => {
    for (const entry of entries) {
      expect(typeof entry.url).toBe("string");
      expect(entry.lastModified).toBeInstanceOf(Date);
      expect(typeof entry.changeFrequency).toBe("string");
      expect(typeof entry.priority).toBe("number");
    }
  });
});

describe("app/sitemap — changeFrequency + priority contract", () => {
  const byUrl = new Map(sitemap().map((e) => [e.url, e] as const));

  it("home is highest-priority + weekly cadence", () => {
    const home = byUrl.get(`${BASE}/`)!;
    expect(home.priority).toBe(1.0);
    expect(home.changeFrequency).toBe("weekly");
  });

  it("features + pricing are high-priority monthly", () => {
    for (const path of ["/features", "/pricing"]) {
      const entry = byUrl.get(`${BASE}${path}`)!;
      expect(entry.priority).toBe(0.9);
      expect(entry.changeFrequency).toBe("monthly");
    }
  });

  it("solutions + contact are mid-priority monthly", () => {
    for (const path of ["/solutions", "/contact"]) {
      const entry = byUrl.get(`${BASE}${path}`)!;
      expect(entry.priority).toBe(0.8);
      expect(entry.changeFrequency).toBe("monthly");
    }
  });

  it("about is the lowest-priority monthly page", () => {
    const about = byUrl.get(`${BASE}/about`)!;
    expect(about.priority).toBe(0.5);
    expect(about.changeFrequency).toBe("monthly");
  });

  it("auth pages (login + register) are yearly + lowest priority", () => {
    for (const path of ["/login", "/register"]) {
      const entry = byUrl.get(`${BASE}${path}`)!;
      expect(entry.priority).toBe(0.3);
      expect(entry.changeFrequency).toBe("yearly");
    }
  });

  it("every priority is within the [0, 1] sitemap spec range", () => {
    for (const entry of sitemap()) {
      expect(entry.priority).toBeGreaterThanOrEqual(0);
      expect(entry.priority).toBeLessThanOrEqual(1);
    }
  });

  it("every changeFrequency is one of the sitemap.org enum values", () => {
    const allowed = new Set([
      "always",
      "hourly",
      "daily",
      "weekly",
      "monthly",
      "yearly",
      "never",
    ]);
    for (const entry of sitemap()) {
      expect(allowed.has(entry.changeFrequency as string)).toBe(true);
    }
  });
});
