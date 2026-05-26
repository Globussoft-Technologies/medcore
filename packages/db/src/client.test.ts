/**
 * Unit test for the Prisma client singleton at `packages/db/src/client.ts`.
 *
 * Strategy:
 *   `client.ts` is 18 lines but encodes three load-time behaviours that
 *   matter to every service in the monorepo:
 *     1. `prisma` is exported as a singleton — repeated imports yield the
 *        same instance. This is the classic Next.js / dev-HMR pattern that
 *        prevents "Too many Prisma clients" warnings.
 *     2. The PrismaClient is constructed with NODE_ENV-dependent `log`
 *        levels (development: query + error + warn; otherwise: error).
 *     3. In non-production, the instance is stashed on `globalThis.prisma`
 *        so subsequent imports (or HMR reloads) reuse it. In production,
 *        the global is NOT written, so each fresh process starts clean.
 *
 *   We mock `@prisma/client` so no real DB connection is attempted, then
 *   exercise the three NODE_ENV branches (development, production,
 *   undefined/test) via `vi.resetModules()` + a fresh dynamic import per
 *   case. The mocked constructor records its options so we can assert the
 *   `log` array passed in.
 *
 * Why colocated (`packages/db/src/client.test.ts`) instead of joining the
 * existing `__tests__` folder: matches the requested test-cron allowlist
 * + mirrors the sibling `packages/db/src/index.test.ts` convention. The
 * root `vitest.config.ts` include glob (`packages/** /*.test.ts`) picks
 * up this location.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Hoisted mock store — vitest hoists `vi.mock()` above imports, so the
// factory itself can't close over outer scope. We expose the captured
// constructor calls via a hoisted ref.
const mockState = vi.hoisted(() => {
  return {
    constructorCalls: [] as Array<Record<string, unknown>>,
  };
});

vi.mock("@prisma/client", () => {
  class MockPrismaClient {
    public readonly __mocked = true;
    public readonly options: Record<string, unknown>;
    constructor(options: Record<string, unknown> = {}) {
      this.options = options;
      mockState.constructorCalls.push(options);
    }
  }
  return { PrismaClient: MockPrismaClient };
});

type GlobalWithPrisma = typeof globalThis & {
  prisma?: { __mocked?: boolean; options?: Record<string, unknown> } | undefined;
};

const originalNodeEnv = process.env.NODE_ENV;

describe("@medcore/db client.ts — Prisma singleton + log-level wiring", () => {
  beforeEach(() => {
    // Reset module cache so each test re-evaluates `client.ts` from scratch
    // with the NODE_ENV the test sets. Without this, the first import's
    // captured branch sticks for the rest of the file.
    vi.resetModules();
    mockState.constructorCalls = [];
    // Wipe any prior singleton stash so the "uses existing singleton" test
    // is the only one that pre-seeds it.
    delete (globalThis as GlobalWithPrisma).prisma;
  });

  afterEach(() => {
    // Restore for the next test file in the singleFork worker.
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
    delete (globalThis as GlobalWithPrisma).prisma;
  });

  describe("module surface", () => {
    it("exports a defined `prisma` instance", async () => {
      process.env.NODE_ENV = "test";
      const mod = await import("./client");
      expect(mod.prisma).toBeDefined();
      expect((mod.prisma as unknown as { __mocked: boolean }).__mocked).toBe(true);
    });
  });

  describe("NODE_ENV branching (log levels)", () => {
    it("development → log = ['query', 'error', 'warn']", async () => {
      process.env.NODE_ENV = "development";
      await import("./client");
      expect(mockState.constructorCalls).toHaveLength(1);
      expect(mockState.constructorCalls[0].log).toEqual(["query", "error", "warn"]);
    });

    it("production → log = ['error'] only (no query noise in prod logs)", async () => {
      process.env.NODE_ENV = "production";
      await import("./client");
      expect(mockState.constructorCalls).toHaveLength(1);
      expect(mockState.constructorCalls[0].log).toEqual(["error"]);
    });

    it("test → log = ['error'] (matches the non-development fallback)", async () => {
      process.env.NODE_ENV = "test";
      await import("./client");
      expect(mockState.constructorCalls).toHaveLength(1);
      expect(mockState.constructorCalls[0].log).toEqual(["error"]);
    });

    it("undefined NODE_ENV → log = ['error'] (defensive default)", async () => {
      delete process.env.NODE_ENV;
      await import("./client");
      expect(mockState.constructorCalls).toHaveLength(1);
      expect(mockState.constructorCalls[0].log).toEqual(["error"]);
    });
  });

  describe("singleton + globalThis stash behaviour", () => {
    it("non-production: stashes the new instance onto globalThis.prisma", async () => {
      process.env.NODE_ENV = "development";
      const mod = await import("./client");
      const stashed = (globalThis as GlobalWithPrisma).prisma;
      expect(stashed).toBeDefined();
      // Identity check — the export and the global stash are the same object.
      expect(stashed).toBe(mod.prisma);
    });

    it("production: does NOT stash onto globalThis.prisma (fresh per process)", async () => {
      process.env.NODE_ENV = "production";
      await import("./client");
      expect((globalThis as GlobalWithPrisma).prisma).toBeUndefined();
    });

    it("reuses an existing globalThis.prisma instead of constructing a new one", async () => {
      // Pre-seed a sentinel singleton — simulates a hot-reload where a prior
      // module evaluation already left a client on the global.
      const sentinel = { __mocked: true, options: { log: ["pre-seeded"] } };
      (globalThis as GlobalWithPrisma).prisma = sentinel as unknown as GlobalWithPrisma["prisma"];

      process.env.NODE_ENV = "development";
      const mod = await import("./client");

      // The exported `prisma` must be the pre-seeded sentinel, not a new
      // instance — this is the whole point of the `??` fallback.
      expect(mod.prisma).toBe(sentinel);
      // And the mocked PrismaClient constructor must NOT have been called,
      // because the `??` short-circuited on the pre-seeded value.
      expect(mockState.constructorCalls).toHaveLength(0);
    });

    it("repeated imports within the same module graph return the same instance", async () => {
      process.env.NODE_ENV = "test";
      const first = await import("./client");
      const second = await import("./client");
      // ESM module cache guarantees identity for the same specifier inside
      // a single module graph — this assertion locks that property in.
      expect(first.prisma).toBe(second.prisma);
      // And exactly one constructor call across both imports.
      expect(mockState.constructorCalls).toHaveLength(1);
    });
  });
});
