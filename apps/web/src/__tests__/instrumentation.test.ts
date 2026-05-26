// Tests for the Next.js instrumentation hook at src/instrumentation.ts.
// What  : verifies the boot-time `register()` export wires Sentry only when the
//         DSN is set, picks the right `init()` shape per runtime (nodejs gets
//         tracesSampleRate, edge does not), prefers SENTRY_RELEASE over the
//         NEXT_PUBLIC_SENTRY_RELEASE alias, and falls back to "production" when
//         NODE_ENV is unset.
// How   : mocks `@sentry/nextjs` via `vi.mock` (top-level hoisted), then drives
//         `register()` once per env-permutation, resetting modules between
//         arrangements so the dynamic `import("@sentry/nextjs")` inside the
//         conditional branches always resolves to the same captured spy.
// Why   : drift here silently breaks Sentry observability on prod — the hook
//         is invisible (no UI), and SENTRY_RELEASE/runtime-shape regressions
//         would otherwise only surface via missing release tags in the Sentry
//         dashboard weeks later (CI hardening Phase 4.2).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const initSpy = vi.fn();

vi.mock("@sentry/nextjs", () => ({
  init: initSpy,
}));

const ENV_KEYS = [
  "NEXT_PUBLIC_SENTRY_DSN",
  "SENTRY_RELEASE",
  "NEXT_PUBLIC_SENTRY_RELEASE",
  "NEXT_RUNTIME",
  "NODE_ENV",
] as const;

type SavedEnv = Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>;
let saved: SavedEnv = {};

function loadRegister() {
  return import("../instrumentation").then((m) => m.register);
}

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    // NODE_ENV is typed read-only; route through vi.stubEnv. Other keys can be
    // deleted directly.
    if (k === "NODE_ENV") {
      vi.stubEnv("NODE_ENV", "");
    } else {
      delete process.env[k];
    }
  }
  initSpy.mockReset();
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const k of ENV_KEYS) {
    if (k === "NODE_ENV") continue; // restored by unstubAllEnvs
    if (saved[k] === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = saved[k];
    }
  }
});

describe("instrumentation.register — Sentry boot wiring", () => {
  it("exports an async register() function", async () => {
    const register = await loadRegister();
    expect(typeof register).toBe("function");
    const out = register();
    expect(out).toBeInstanceOf(Promise);
    await out;
  });

  it("is a no-op when NEXT_PUBLIC_SENTRY_DSN is unset", async () => {
    process.env.NEXT_RUNTIME = "nodejs";
    const register = await loadRegister();
    await register();
    expect(initSpy).not.toHaveBeenCalled();
  });

  it("initializes Sentry with tracesSampleRate 0.1 in the nodejs runtime", async () => {
    process.env.NEXT_PUBLIC_SENTRY_DSN = "https://example@sentry.io/1";
    process.env.NEXT_RUNTIME = "nodejs";
    vi.stubEnv("NODE_ENV", "production");
    process.env.SENTRY_RELEASE = "abc1234";

    const register = await loadRegister();
    await register();

    expect(initSpy).toHaveBeenCalledTimes(1);
    expect(initSpy).toHaveBeenCalledWith({
      dsn: "https://example@sentry.io/1",
      environment: "production",
      release: "abc1234",
      tracesSampleRate: 0.1,
    });
  });

  it("initializes Sentry WITHOUT tracesSampleRate in the edge runtime", async () => {
    process.env.NEXT_PUBLIC_SENTRY_DSN = "https://example@sentry.io/2";
    process.env.NEXT_RUNTIME = "edge";
    vi.stubEnv("NODE_ENV", "production");
    process.env.SENTRY_RELEASE = "edge-sha";

    const register = await loadRegister();
    await register();

    expect(initSpy).toHaveBeenCalledTimes(1);
    const call = initSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call).toEqual({
      dsn: "https://example@sentry.io/2",
      environment: "production",
      release: "edge-sha",
    });
    expect(call).not.toHaveProperty("tracesSampleRate");
  });

  it("falls back to environment 'production' when NODE_ENV is unset", async () => {
    process.env.NEXT_PUBLIC_SENTRY_DSN = "https://example@sentry.io/3";
    process.env.NEXT_RUNTIME = "nodejs";
    // NODE_ENV deliberately unset
    const register = await loadRegister();
    await register();
    expect(initSpy).toHaveBeenCalledTimes(1);
    expect(initSpy.mock.calls[0]?.[0]).toMatchObject({
      environment: "production",
    });
  });

  it("uses NODE_ENV when set (e.g. 'staging') rather than the production fallback", async () => {
    process.env.NEXT_PUBLIC_SENTRY_DSN = "https://example@sentry.io/4";
    process.env.NEXT_RUNTIME = "nodejs";
    vi.stubEnv("NODE_ENV", "staging");
    const register = await loadRegister();
    await register();
    expect(initSpy.mock.calls[0]?.[0]).toMatchObject({
      environment: "staging",
    });
  });

  it("prefers SENTRY_RELEASE over NEXT_PUBLIC_SENTRY_RELEASE when both are set", async () => {
    process.env.NEXT_PUBLIC_SENTRY_DSN = "https://example@sentry.io/5";
    process.env.NEXT_RUNTIME = "nodejs";
    process.env.SENTRY_RELEASE = "server-sha";
    process.env.NEXT_PUBLIC_SENTRY_RELEASE = "public-sha";

    const register = await loadRegister();
    await register();

    expect(initSpy.mock.calls[0]?.[0]).toMatchObject({
      release: "server-sha",
    });
  });

  it("falls back to NEXT_PUBLIC_SENTRY_RELEASE when SENTRY_RELEASE is unset", async () => {
    process.env.NEXT_PUBLIC_SENTRY_DSN = "https://example@sentry.io/6";
    process.env.NEXT_RUNTIME = "edge";
    process.env.NEXT_PUBLIC_SENTRY_RELEASE = "public-only-sha";

    const register = await loadRegister();
    await register();

    expect(initSpy.mock.calls[0]?.[0]).toMatchObject({
      release: "public-only-sha",
    });
  });

  it("passes release=undefined when neither release env is set", async () => {
    process.env.NEXT_PUBLIC_SENTRY_DSN = "https://example@sentry.io/7";
    process.env.NEXT_RUNTIME = "nodejs";

    const register = await loadRegister();
    await register();

    expect(initSpy).toHaveBeenCalledTimes(1);
    const call = initSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.release).toBeUndefined();
  });

  it("does NOT initialize Sentry for an unknown runtime (neither nodejs nor edge)", async () => {
    process.env.NEXT_PUBLIC_SENTRY_DSN = "https://example@sentry.io/8";
    process.env.NEXT_RUNTIME = "browser";

    const register = await loadRegister();
    await register();

    expect(initSpy).not.toHaveBeenCalled();
  });

  it("does NOT initialize Sentry when NEXT_RUNTIME is unset", async () => {
    process.env.NEXT_PUBLIC_SENTRY_DSN = "https://example@sentry.io/9";
    // NEXT_RUNTIME deliberately unset

    const register = await loadRegister();
    await register();

    expect(initSpy).not.toHaveBeenCalled();
  });
});
