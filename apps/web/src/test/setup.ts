/* eslint-disable @typescript-eslint/no-explicit-any */
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";

// Clean DOM between tests.
afterEach(() => {
  cleanup();
  try {
    window.localStorage.clear();
    window.sessionStorage.clear();
  } catch {
    /* ignore */
  }
});

// Stable localStorage / sessionStorage implementations. jsdom supplies these,
// but we reset them between tests.
beforeEach(() => {
  try {
    window.localStorage.clear();
    window.sessionStorage.clear();
  } catch {
    /* ignore */
  }

  // Default fetch mock — tests can override.
  if (!(globalThis as any).__fetchMockLocked) {
    (globalThis as any).fetch = vi.fn(async () =>
      new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
  }
});

// matchMedia mock (jsdom does not implement it).
if (typeof window !== "undefined" && !window.matchMedia) {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(() => false),
    }),
  });
}

// IntersectionObserver stub
if (typeof window !== "undefined" && !(window as any).IntersectionObserver) {
  class IO {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  }
  (window as any).IntersectionObserver = IO;
  (globalThis as any).IntersectionObserver = IO;
}

// ResizeObserver stub
if (typeof window !== "undefined" && !(window as any).ResizeObserver) {
  class RO {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  (window as any).ResizeObserver = RO;
  (globalThis as any).ResizeObserver = RO;
}

// URL.createObjectURL for blob-download tests
if (typeof URL !== "undefined" && !URL.createObjectURL) {
  (URL as any).createObjectURL = vi.fn(() => "blob:mock");
  (URL as any).revokeObjectURL = vi.fn();
}
