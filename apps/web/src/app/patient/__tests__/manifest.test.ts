/**
 * Covers `apps/web/src/app/patient/manifest.ts` — the segment-scoped Next.js
 * 15 App Router PWA manifest for the patient surface (Pearl §6.2 — gap #5
 * piece 1 of 4).
 *
 * The file is a single default-exported function returning a static
 * `MetadataRoute.Manifest` object. There are no branches, no fetches, and no
 * runtime params — coverage targets are: every top-level field is present and
 * matches the spec (PWA installability requirements: name, short_name,
 * start_url, display, icons), the patient-specific branding (different name,
 * `start_url` + `scope` + `id` all under `/patient`), and the icons array
 * carries the four canonical entries (192/512 px × any/maskable purpose)
 * Next.js's PWA audit and the iOS install-prompt expect.
 *
 * Sister manifest at `apps/web/src/app/manifest.ts` is the root staff-shell
 * variant and is covered by `apps/web/src/app/__tests__/manifest.test.ts`.
 */
import { describe, it, expect } from "vitest";

import manifest from "../manifest";

describe("app/patient/manifest — default export shape", () => {
  it("is a function that returns a plain object", () => {
    expect(typeof manifest).toBe("function");
    const result = manifest();
    expect(result).not.toBeNull();
    expect(typeof result).toBe("object");
    expect(Array.isArray(result)).toBe(false);
  });

  it("returns a stable object across invocations (pure config function)", () => {
    const a = manifest();
    const b = manifest();
    // Deep-equal but distinct references — guards against accidental
    // module-scope mutation if the file is ever refactored.
    expect(a).toEqual(b);
  });
});

describe("app/patient/manifest — required PWA installability fields", () => {
  const m = manifest();

  it("declares the patient-portal product names (distinct from root staff shell)", () => {
    expect(m.name).toBe("MedCore — Patient Portal");
    expect(m.short_name).toBe("Patient Portal");
  });

  it("declares a non-empty description mentioning core patient capabilities", () => {
    expect(typeof m.description).toBe("string");
    expect(m.description!.length).toBeGreaterThan(0);
    // Spot-check the patient-facing capabilities the marketing copy promises.
    expect(m.description).toMatch(/appointment/i);
    expect(m.description).toMatch(/prescription/i);
    expect(m.description).toMatch(/bill/i);
  });

  it("declares start_url under /patient (installed app lands on patient portal)", () => {
    expect(m.start_url).toBe("/patient");
  });

  it("declares scope locked to /patient (cannot leak into staff dashboard routes)", () => {
    expect(m.scope).toBe("/patient");
  });

  it("declares id under /patient (distinct PWA install identity from root manifest)", () => {
    expect(m.id).toBe("/patient");
  });

  it("ties start_url, scope, and id together at /patient (installability invariant)", () => {
    // The three URL-shaped fields MUST agree so the browser treats the
    // installed patient PWA as a separate app from the staff shell rather
    // than collapsing them into a single install entry.
    expect(m.start_url).toBe(m.scope);
    expect(m.id).toBe(m.scope);
  });

  it("declares display: standalone (full-screen installed app)", () => {
    expect(m.display).toBe("standalone");
  });

  it("declares portrait orientation (mobile-first patient surface)", () => {
    expect(m.orientation).toBe("portrait");
  });

  it("declares background_color and theme_color as 6-digit hex strings", () => {
    expect(m.background_color).toBe("#ffffff");
    expect(m.theme_color).toBe("#0f172a");
    expect(m.background_color).toMatch(/^#[0-9a-f]{6}$/i);
    expect(m.theme_color).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it("declares categories including 'medical' and 'health'", () => {
    expect(Array.isArray(m.categories)).toBe(true);
    expect(m.categories).toEqual(["medical", "health", "productivity"]);
  });
});

describe("app/patient/manifest — icons array (PWA install + iOS home-screen)", () => {
  const m = manifest();
  const icons = m.icons ?? [];

  it("declares an array of 4 icon entries", () => {
    expect(Array.isArray(icons)).toBe(true);
    expect(icons).toHaveLength(4);
  });

  it("every entry carries the required src / sizes / type / purpose keys", () => {
    for (const icon of icons) {
      expect(typeof icon.src).toBe("string");
      expect(icon.src!.length).toBeGreaterThan(0);
      expect(typeof icon.sizes).toBe("string");
      expect(icon.sizes).toMatch(/^\d+x\d+$/);
      expect(icon.type).toBe("image/png");
      expect(typeof icon.purpose).toBe("string");
    }
  });

  it("every src is a root-relative PNG path under /icon-*.png", () => {
    for (const icon of icons) {
      expect(icon.src).toMatch(/^\/icon-\d+\.png$/);
    }
  });

  it("provides a 192x192 + 512x512 entry for purpose='any' (installability)", () => {
    const anyIcons = icons.filter((i) => i.purpose === "any");
    expect(anyIcons).toHaveLength(2);
    const sizes = anyIcons.map((i) => i.sizes).sort();
    expect(sizes).toEqual(["192x192", "512x512"]);
    expect(anyIcons.find((i) => i.sizes === "192x192")!.src).toBe(
      "/icon-192.png",
    );
    expect(anyIcons.find((i) => i.sizes === "512x512")!.src).toBe(
      "/icon-512.png",
    );
  });

  it("provides a 192x192 + 512x512 entry for purpose='maskable' (Android adaptive icons)", () => {
    const maskable = icons.filter((i) => i.purpose === "maskable");
    expect(maskable).toHaveLength(2);
    const sizes = maskable.map((i) => i.sizes).sort();
    expect(sizes).toEqual(["192x192", "512x512"]);
    expect(maskable.find((i) => i.sizes === "192x192")!.src).toBe(
      "/icon-192.png",
    );
    expect(maskable.find((i) => i.sizes === "512x512")!.src).toBe(
      "/icon-512.png",
    );
  });

  it("does NOT declare any unknown / unexpected icon purposes", () => {
    const purposes = new Set(icons.map((i) => i.purpose));
    expect(purposes).toEqual(new Set(["any", "maskable"]));
  });

  it("shares the icon asset paths with the root manifest (per piece-1 contract; per-tenant hydration is piece 3)", () => {
    // The current tick intentionally re-uses /icon-192.png + /icon-512.png
    // from the root manifest. Lock that down so a future agent doesn't
    // silently swap in patient-specific assets without also wiring the
    // per-tenant hydration pipe.
    const srcs = new Set(icons.map((i) => i.src));
    expect(srcs).toEqual(new Set(["/icon-192.png", "/icon-512.png"]));
  });
});
