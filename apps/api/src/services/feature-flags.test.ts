// Pearl ERP Stage 1 §6+§18 (gap item #9) — unit tests for the server-side
// feature-flag resolver in `feature-flags.ts`. The pure resolution rules
// (default-enabled, boolean overrides, etc.) are pinned in the shared
// package's test suite at packages/shared/src/__tests__/feature-flags.test.ts;
// this suite's job is narrower and complementary:
//
//   1. Prisma plumbing — `loadFlags` reads only `Tenant.featureFlags` from
//      `prisma.tenant.findUnique` keyed on `id`, and tolerates a null tenant.
//   2. LRU cache — repeated reads inside the 60s TTL must NOT re-hit Prisma;
//      reads beyond the TTL must re-fetch.
//   3. `isFeatureEnabled` short-circuits when tenantId is null/undefined/""
//      (the legacy / single-tenant code path) and returns true without
//      touching the DB.
//   4. `getAllFeatureFlags` returns the full Pearl-§18 key map (every flag
//      explicit boolean) including the no-tenant default-true projection.
//   5. `invalidateFeatureFlagsCache` deletes one tenant's entry without
//      affecting siblings — the contract the PATCH endpoint relies on.
//   6. `__resetFeatureFlagsCacheForTests` clears the whole cache (used by the
//      singleFork:true isolation discipline called out in repo CLAUDE.md §2).
//
// Prisma is fully hoisted-mocked (no real DB hit). `@medcore/shared` is left
// real so we exercise the actual resolver against the canonical metadata
// defaults — this surfaces any drift between the shared resolver contract
// and the API service's expected behaviour.

import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
} from "vitest";

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    tenant: {
      findUnique: vi.fn(),
    },
  },
}));

vi.mock("@medcore/db", () => ({
  prisma: prismaMock,
}));

import {
  isFeatureEnabled,
  getAllFeatureFlags,
  invalidateFeatureFlagsCache,
  __resetFeatureFlagsCacheForTests,
} from "./feature-flags";
import { FEATURE_KEYS } from "@medcore/shared";

beforeEach(() => {
  __resetFeatureFlagsCacheForTests();
  vi.clearAllMocks();
  // Default: tenant exists with no overrides (featureFlags = null).
  prismaMock.tenant.findUnique.mockResolvedValue({ featureFlags: null });
});

afterEach(() => {
  __resetFeatureFlagsCacheForTests();
  vi.useRealTimers();
});

describe("isFeatureEnabled — tenantId short-circuit (no DB hit)", () => {
  it("returns true when tenantId is null (legacy / single-tenant path)", async () => {
    const result = await isFeatureEnabled(null, "ipd");
    expect(result).toBe(true);
    expect(prismaMock.tenant.findUnique).not.toHaveBeenCalled();
  });

  it("returns true when tenantId is undefined", async () => {
    const result = await isFeatureEnabled(undefined, "telemedicine");
    expect(result).toBe(true);
    expect(prismaMock.tenant.findUnique).not.toHaveBeenCalled();
  });

  it("returns true when tenantId is the empty string (falsy)", async () => {
    const result = await isFeatureEnabled("", "voiceRx");
    expect(result).toBe(true);
    expect(prismaMock.tenant.findUnique).not.toHaveBeenCalled();
  });
});

describe("isFeatureEnabled — Prisma plumbing", () => {
  it("queries Tenant by id and selects only featureFlags", async () => {
    prismaMock.tenant.findUnique.mockResolvedValue({ featureFlags: null });
    await isFeatureEnabled("tenant-A", "ipd");
    expect(prismaMock.tenant.findUnique).toHaveBeenCalledTimes(1);
    expect(prismaMock.tenant.findUnique).toHaveBeenCalledWith({
      where: { id: "tenant-A" },
      select: { featureFlags: true },
    });
  });

  it("defaults to true when tenant.featureFlags is null (metadata default)", async () => {
    prismaMock.tenant.findUnique.mockResolvedValue({ featureFlags: null });
    expect(await isFeatureEnabled("tenant-A", "ipd")).toBe(true);
  });

  it("honors a tenant's explicit false override (Pearl-tenant pattern)", async () => {
    prismaMock.tenant.findUnique.mockResolvedValue({
      featureFlags: { ipd: false, telemedicine: false },
    });
    expect(await isFeatureEnabled("tenant-pearl", "ipd")).toBe(false);
    expect(await isFeatureEnabled("tenant-pearl", "telemedicine")).toBe(false);
    // Sibling keys not overridden remain default-enabled.
    expect(await isFeatureEnabled("tenant-pearl", "aiFraud")).toBe(true);
  });

  it("defaults to true when the tenant row is missing entirely", async () => {
    // `findUnique` returns null when no row matches — service must NOT
    // throw, just fall back to the metadata default (treats missing
    // tenant the same as no overrides).
    prismaMock.tenant.findUnique.mockResolvedValue(null);
    expect(await isFeatureEnabled("tenant-ghost", "ipd")).toBe(true);
    expect(await isFeatureEnabled("tenant-ghost", "aiRadiology")).toBe(true);
  });

  it("propagates prisma errors (resolver does NOT swallow DB failures)", async () => {
    prismaMock.tenant.findUnique.mockRejectedValueOnce(
      new Error("connection refused"),
    );
    await expect(isFeatureEnabled("tenant-A", "ipd")).rejects.toThrow(
      "connection refused",
    );
  });
});

describe("isFeatureEnabled — LRU cache (60s TTL)", () => {
  it("hits Prisma exactly once across 5 reads inside the TTL window", async () => {
    prismaMock.tenant.findUnique.mockResolvedValue({
      featureFlags: { ipd: false },
    });
    for (let i = 0; i < 5; i++) {
      await isFeatureEnabled("tenant-A", "ipd");
    }
    expect(prismaMock.tenant.findUnique).toHaveBeenCalledTimes(1);
  });

  it("caches per tenantId — sibling tenants do not share cache entries", async () => {
    prismaMock.tenant.findUnique.mockImplementation(async ({ where }) => {
      if (where.id === "tenant-A") return { featureFlags: { ipd: false } };
      if (where.id === "tenant-B") return { featureFlags: { ipd: true } };
      return null;
    });
    expect(await isFeatureEnabled("tenant-A", "ipd")).toBe(false);
    expect(await isFeatureEnabled("tenant-B", "ipd")).toBe(true);
    // Re-read both — still only 2 DB hits (one per tenant).
    expect(await isFeatureEnabled("tenant-A", "ipd")).toBe(false);
    expect(await isFeatureEnabled("tenant-B", "ipd")).toBe(true);
    expect(prismaMock.tenant.findUnique).toHaveBeenCalledTimes(2);
  });

  it("re-fetches once the TTL (60s) elapses", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    prismaMock.tenant.findUnique.mockResolvedValue({ featureFlags: null });

    await isFeatureEnabled("tenant-A", "ipd");
    expect(prismaMock.tenant.findUnique).toHaveBeenCalledTimes(1);

    // Inside TTL — still 1 hit.
    vi.advanceTimersByTime(59_000);
    await isFeatureEnabled("tenant-A", "ipd");
    expect(prismaMock.tenant.findUnique).toHaveBeenCalledTimes(1);

    // Past TTL — re-fetch.
    vi.advanceTimersByTime(2_000); // total 61s
    await isFeatureEnabled("tenant-A", "ipd");
    expect(prismaMock.tenant.findUnique).toHaveBeenCalledTimes(2);
  });

  it("caches a null tenant lookup too (does NOT keep retrying missing tenants)", async () => {
    // Defensive: if a stale tenantId floods the resolver, the cache must
    // absorb it so we don't DDoS Prisma with 1000 findUnique(null) hits.
    prismaMock.tenant.findUnique.mockResolvedValue(null);
    for (let i = 0; i < 5; i++) {
      await isFeatureEnabled("tenant-ghost", "ipd");
    }
    expect(prismaMock.tenant.findUnique).toHaveBeenCalledTimes(1);
  });
});

describe("getAllFeatureFlags — full Pearl-§18 key projection", () => {
  it("returns every FEATURE_KEY when tenantId is null (all-true default map)", async () => {
    const flags = await getAllFeatureFlags(null);
    expect(Object.keys(flags).sort()).toEqual([...FEATURE_KEYS].sort());
    for (const key of FEATURE_KEYS) {
      expect(flags[key]).toBe(true);
    }
    expect(prismaMock.tenant.findUnique).not.toHaveBeenCalled();
  });

  it("returns every FEATURE_KEY when tenantId is undefined", async () => {
    const flags = await getAllFeatureFlags(undefined);
    expect(Object.keys(flags).sort()).toEqual([...FEATURE_KEYS].sort());
    for (const key of FEATURE_KEYS) {
      expect(flags[key]).toBe(true);
    }
  });

  it("merges per-tenant overrides with metadata defaults (Pearl-pilot shape)", async () => {
    prismaMock.tenant.findUnique.mockResolvedValue({
      featureFlags: {
        ipd: false,
        ot: false,
        hrmsPayroll: false,
      },
    });
    const flags = await getAllFeatureFlags("tenant-pearl");
    expect(flags.ipd).toBe(false);
    expect(flags.ot).toBe(false);
    expect(flags.hrmsPayroll).toBe(false);
    // Unset keys stay at metadata default (true).
    expect(flags.telemedicine).toBe(true);
    expect(flags.aiCoaching).toBe(true);
    expect(flags.aiFraud).toBe(true);
  });

  it("emits explicit booleans for every key (no nulls / undefineds)", async () => {
    prismaMock.tenant.findUnique.mockResolvedValue({
      featureFlags: { ipd: false },
    });
    const flags = await getAllFeatureFlags("tenant-A");
    for (const key of FEATURE_KEYS) {
      expect(typeof flags[key]).toBe("boolean");
    }
  });

  it("returns the same cached flags as isFeatureEnabled (single DB hit shared)", async () => {
    prismaMock.tenant.findUnique.mockResolvedValue({
      featureFlags: { ipd: false },
    });
    expect(await isFeatureEnabled("tenant-A", "ipd")).toBe(false);
    const flags = await getAllFeatureFlags("tenant-A");
    expect(flags.ipd).toBe(false);
    expect(prismaMock.tenant.findUnique).toHaveBeenCalledTimes(1);
  });
});

describe("invalidateFeatureFlagsCache — PATCH-endpoint contract", () => {
  it("forces the NEXT read to re-fetch from Prisma", async () => {
    prismaMock.tenant.findUnique
      .mockResolvedValueOnce({ featureFlags: { ipd: true } })
      .mockResolvedValueOnce({ featureFlags: { ipd: false } });

    expect(await isFeatureEnabled("tenant-A", "ipd")).toBe(true);
    invalidateFeatureFlagsCache("tenant-A");
    expect(await isFeatureEnabled("tenant-A", "ipd")).toBe(false);
    expect(prismaMock.tenant.findUnique).toHaveBeenCalledTimes(2);
  });

  it("only evicts the targeted tenant — siblings stay cached", async () => {
    prismaMock.tenant.findUnique.mockImplementation(async ({ where }) => {
      if (where.id === "tenant-A") return { featureFlags: { ipd: false } };
      if (where.id === "tenant-B") return { featureFlags: { ipd: true } };
      return null;
    });
    // Warm both caches.
    await isFeatureEnabled("tenant-A", "ipd");
    await isFeatureEnabled("tenant-B", "ipd");
    expect(prismaMock.tenant.findUnique).toHaveBeenCalledTimes(2);

    invalidateFeatureFlagsCache("tenant-A");

    // Reading B again must NOT trigger another DB hit.
    await isFeatureEnabled("tenant-B", "ipd");
    expect(prismaMock.tenant.findUnique).toHaveBeenCalledTimes(2);

    // Reading A re-fetches.
    await isFeatureEnabled("tenant-A", "ipd");
    expect(prismaMock.tenant.findUnique).toHaveBeenCalledTimes(3);
  });

  it("is idempotent on an unknown tenantId (no throw)", () => {
    expect(() => invalidateFeatureFlagsCache("tenant-never-cached")).not.toThrow();
  });
});

describe("__resetFeatureFlagsCacheForTests — test isolation hook", () => {
  it("clears every cached tenant (used by singleFork:true suites)", async () => {
    prismaMock.tenant.findUnique.mockResolvedValue({ featureFlags: null });
    await isFeatureEnabled("tenant-A", "ipd");
    await isFeatureEnabled("tenant-B", "ipd");
    await isFeatureEnabled("tenant-C", "ipd");
    expect(prismaMock.tenant.findUnique).toHaveBeenCalledTimes(3);

    __resetFeatureFlagsCacheForTests();

    // All three must re-fetch now.
    await isFeatureEnabled("tenant-A", "ipd");
    await isFeatureEnabled("tenant-B", "ipd");
    await isFeatureEnabled("tenant-C", "ipd");
    expect(prismaMock.tenant.findUnique).toHaveBeenCalledTimes(6);
  });
});
