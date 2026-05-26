// Unit tests for the client-side feature-flag resolver.
// Covers:
//   - fetchFlags happy-path: API response is merged onto the
//     resolveAllFeatureFlags(null) defaults so every FEATURE_KEYS key
//     is present and unknown keys from the server pass through.
//   - fetchFlags error-path: a thrown api.get falls open to
//     "all enabled" (resolveAllFeatureFlags(null)), matching the
//     non-Pearl tenant default.
//   - In-flight dedupe: two concurrent useFeatureFlags subscribers
//     should share one underlying GET, not fire two.
//   - useFeatureFlags hook: returns defaults synchronously, then
//     transitions to fetched flags after the effect; re-fetches when
//     the auth user.id changes and uses the cached map on second
//     subscriber for the same userId.
//   - useFeatureFlag single-key wrapper returns the matching bool.
//   - Unknown / missing keys in the API payload are backfilled from
//     defaults (defensive merge).
//   - __resetFeatureFlagsClientCache clears module-scope state so a
//     fresh fetch fires next time (cleanup contract).
//   - Re-exports: FEATURE_KEYS surfaces from the module.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";

// Mock the api client so we can control GET /feature-flags without
// hitting the real fetch wrapper (auth, CSRF, 401-handling, etc.).
vi.mock("@/lib/api", () => ({
  api: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  },
}));

// Mock the auth store hook — feature-flags-client only reads `user?.id`.
// We use a module-scope mutable so tests can swap the active userId
// without re-importing the module.
let mockUserId: string | null = null;
vi.mock("@/lib/store", () => ({
  useAuthStore: (selector: (s: { user: { id: string } | null }) => unknown) =>
    selector({ user: mockUserId ? { id: mockUserId } : null }),
}));

import { api } from "@/lib/api";
import {
  useFeatureFlags,
  useFeatureFlag,
  __resetFeatureFlagsClientCache,
  FEATURE_KEYS,
} from "../feature-flags-client";

const apiGet = api.get as unknown as ReturnType<typeof vi.fn>;

// Every FEATURE_KEYS key defaults to `true` (per FEATURE_METADATA in
// packages/shared) when no tenant override exists. Tests that assert
// "all enabled" rely on this baseline.

describe("feature-flags-client — fetch + cache", () => {
  beforeEach(() => {
    __resetFeatureFlagsClientCache();
    mockUserId = null;
    apiGet.mockReset();
  });

  afterEach(() => {
    __resetFeatureFlagsClientCache();
  });

  it("re-exports FEATURE_KEYS from @medcore/shared", () => {
    expect(Array.isArray(FEATURE_KEYS)).toBe(true);
    expect(FEATURE_KEYS).toContain("ipd");
    expect(FEATURE_KEYS).toContain("voiceRx");
    expect(FEATURE_KEYS.length).toBeGreaterThanOrEqual(16);
  });

  it("useFeatureFlags returns the all-enabled default synchronously when no user is signed in", () => {
    mockUserId = null;
    const { result } = renderHook(() => useFeatureFlags());
    // No userId → no fetch → the defaults map is what we get.
    for (const key of FEATURE_KEYS) {
      expect(result.current[key]).toBe(true);
    }
    expect(apiGet).not.toHaveBeenCalled();
  });

  it("useFeatureFlags fetches once when a user signs in and merges the response into the flag map", async () => {
    mockUserId = "user-1";
    apiGet.mockResolvedValueOnce({
      data: { ipd: false, voiceRx: false, aiFraud: false },
    });

    const { result } = renderHook(() => useFeatureFlags());

    await waitFor(() => {
      expect(result.current.ipd).toBe(false);
    });
    expect(result.current.voiceRx).toBe(false);
    expect(result.current.aiFraud).toBe(false);
    // Keys not in the server response retain the default (true).
    expect(result.current.ot).toBe(true);
    expect(result.current.telemedicine).toBe(true);
    expect(apiGet).toHaveBeenCalledTimes(1);
    expect(apiGet).toHaveBeenCalledWith("/feature-flags");
  });

  it("on API error, falls open to all-enabled defaults (non-Pearl posture)", async () => {
    mockUserId = "user-err";
    apiGet.mockRejectedValueOnce(new Error("network down"));

    const { result } = renderHook(() => useFeatureFlags());

    await waitFor(() => {
      expect(apiGet).toHaveBeenCalledTimes(1);
    });
    // Defaults — every key still true.
    for (const key of FEATURE_KEYS) {
      expect(result.current[key]).toBe(true);
    }
  });

  it("backfills missing keys in the API payload with defaults (defensive merge)", async () => {
    mockUserId = "user-partial";
    // Server returns ONLY `ipd: false` — every other key must remain
    // its default (true) rather than being undefined.
    apiGet.mockResolvedValueOnce({ data: { ipd: false } });

    const { result } = renderHook(() => useFeatureFlags());

    await waitFor(() => {
      expect(result.current.ipd).toBe(false);
    });
    for (const key of FEATURE_KEYS) {
      if (key === "ipd") continue;
      expect(result.current[key]).toBe(true);
      expect(result.current[key]).not.toBeUndefined();
    }
  });

  it("dedupes concurrent fetches: two hook subscribers for the same userId trigger one GET", async () => {
    mockUserId = "user-dedupe";
    // Slow promise so both renders queue while inFlight is set.
    let resolveFn: (v: { data: Record<string, boolean> }) => void = () => {};
    const slow = new Promise<{ data: Record<string, boolean> }>((res) => {
      resolveFn = res;
    });
    apiGet.mockReturnValueOnce(slow);

    const h1 = renderHook(() => useFeatureFlags());
    const h2 = renderHook(() => useFeatureFlags());

    // Resolve the in-flight promise; both subscribers should converge.
    await act(async () => {
      resolveFn({ data: { ot: false } });
      await slow;
    });

    await waitFor(() => {
      expect(h1.result.current.ot).toBe(false);
    });
    expect(h2.result.current.ot).toBe(false);
    // One network call, two subscribers — the dedupe path was hit.
    expect(apiGet).toHaveBeenCalledTimes(1);
  });

  it("re-fetches when the auth userId changes (tenant switch case)", async () => {
    mockUserId = "user-a";
    apiGet.mockResolvedValueOnce({ data: { ipd: false } });

    const { result, rerender } = renderHook(() => useFeatureFlags());
    await waitFor(() => {
      expect(result.current.ipd).toBe(false);
    });
    expect(apiGet).toHaveBeenCalledTimes(1);

    // Simulate the auth user changing (different tenant signs in).
    mockUserId = "user-b";
    apiGet.mockResolvedValueOnce({ data: { ot: false } });
    rerender();

    await waitFor(() => {
      expect(apiGet).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(result.current.ot).toBe(false);
    });
    // The fresh fetch's data replaces the previous one — `ipd` is no
    // longer in the response, so the defensive merge restores its
    // default (true) for the new tenant.
    expect(result.current.ipd).toBe(true);
  });

  it("second subscriber for the same userId reads the cached map without a new GET", async () => {
    mockUserId = "user-cached";
    apiGet.mockResolvedValueOnce({ data: { voiceRx: false } });

    const h1 = renderHook(() => useFeatureFlags());
    await waitFor(() => {
      expect(h1.result.current.voiceRx).toBe(false);
    });
    expect(apiGet).toHaveBeenCalledTimes(1);

    // Same userId, fresh component subscribes — should read from cache,
    // not refire the GET.
    const h2 = renderHook(() => useFeatureFlags());
    await waitFor(() => {
      expect(h2.result.current.voiceRx).toBe(false);
    });
    expect(apiGet).toHaveBeenCalledTimes(1);
  });
});

describe("feature-flags-client — single-flag hook", () => {
  beforeEach(() => {
    __resetFeatureFlagsClientCache();
    mockUserId = null;
    apiGet.mockReset();
  });

  afterEach(() => {
    __resetFeatureFlagsClientCache();
  });

  it("useFeatureFlag returns the boolean for the requested key (default = true)", () => {
    mockUserId = null;
    const { result } = renderHook(() => useFeatureFlag("ipd"));
    expect(result.current).toBe(true);
  });

  it("useFeatureFlag reflects the fetched value after the API resolves", async () => {
    mockUserId = "user-single";
    apiGet.mockResolvedValueOnce({ data: { aiRadiology: false } });

    const { result } = renderHook(() => useFeatureFlag("aiRadiology"));
    await waitFor(() => {
      expect(result.current).toBe(false);
    });
  });

  it("useFeatureFlag for an unknown-in-payload key still returns the default (defensive merge)", async () => {
    mockUserId = "user-unknown";
    // Server returns NOTHING for `hl7Inbound` — the defensive merge
    // backfills the default (true), so the hook sees true.
    apiGet.mockResolvedValueOnce({ data: { ipd: false } });

    const { result } = renderHook(() => useFeatureFlag("hl7Inbound"));
    await waitFor(() => {
      // First await for the fetch to land:
      expect(apiGet).toHaveBeenCalled();
    });
    expect(result.current).toBe(true);
  });
});

describe("feature-flags-client — __resetFeatureFlagsClientCache", () => {
  beforeEach(() => {
    mockUserId = null;
    apiGet.mockReset();
  });

  it("clears module-scope cache so the next subscriber re-fetches", async () => {
    mockUserId = "user-reset";
    apiGet.mockResolvedValueOnce({ data: { ipd: false } });

    const h1 = renderHook(() => useFeatureFlags());
    await waitFor(() => {
      expect(h1.result.current.ipd).toBe(false);
    });
    expect(apiGet).toHaveBeenCalledTimes(1);

    // Reset — next mount for the same userId should fire a new GET,
    // not read the now-cleared cache.
    __resetFeatureFlagsClientCache();
    apiGet.mockResolvedValueOnce({ data: { ot: false } });

    const h2 = renderHook(() => useFeatureFlags());
    await waitFor(() => {
      expect(apiGet).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(h2.result.current.ot).toBe(false);
    });
  });
});
