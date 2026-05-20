"use client";

// Pearl ERP Stage 1 §6 + §18 (gap item #9) — client-side feature-flag
// resolver. Wraps GET /api/v1/feature-flags so the sidebar nav config,
// route guards, and conditionally-rendered UI surfaces all reference
// the same on/off state the server enforces.
//
// One global zustand-style store + a React hook. Fetches once per
// session on login, re-fetches when the auth user.id changes (so
// tenant switching gets a fresh map). Defaults to "all enabled" until
// the API responds, so UI doesn't flash-hide.

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useAuthStore } from "@/lib/store";
import {
  FEATURE_KEYS,
  type FeatureKey,
  resolveAllFeatureFlags,
} from "@medcore/shared";

type FlagMap = Record<FeatureKey, boolean>;

let cached: FlagMap | null = null;
let inFlight: Promise<FlagMap> | null = null;
let cachedForUserId: string | null = null;

async function fetchFlags(): Promise<FlagMap> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const res = await api.get<{ data: FlagMap }>("/feature-flags");
      const data = res.data;
      // Defensive: backfill any missing keys with defaults so the UI
      // never sees `undefined` when reading a flag.
      cached = { ...resolveAllFeatureFlags(null), ...data };
      return cached;
    } catch {
      // On error, default to "all enabled" — fail-open is the right
      // posture for a non-Pearl tenant (current default behaviour).
      cached = resolveAllFeatureFlags(null);
      return cached;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/** React hook — returns the full flag map. Re-fetches when the user id changes. */
export function useFeatureFlags(): FlagMap {
  const userId = useAuthStore((s) => s.user?.id ?? null);
  const [flags, setFlags] = useState<FlagMap>(
    cached ?? resolveAllFeatureFlags(null),
  );

  useEffect(() => {
    if (!userId) return;
    if (cachedForUserId === userId && cached) {
      setFlags(cached);
      return;
    }
    cached = null;
    cachedForUserId = userId;
    void fetchFlags().then(setFlags);
  }, [userId]);

  return flags;
}

/** Single-flag hook — convenience wrapper. */
export function useFeatureFlag(key: FeatureKey): boolean {
  return useFeatureFlags()[key];
}

/** Reset for tests / logout. */
export function __resetFeatureFlagsClientCache(): void {
  cached = null;
  inFlight = null;
  cachedForUserId = null;
}

export { FEATURE_KEYS };
export type { FeatureKey, FlagMap };
