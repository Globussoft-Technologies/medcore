// Pearl ERP Stage 1 §6 + §18 (gap item #9) — server-side feature-flag
// resolver. Single API for routes + middleware to ask "is feature X
// enabled for the current request's tenant?".
//
// Read path: a small in-process LRU cache (60s TTL) wraps the Prisma
// lookup so a hot path that asks 10x per request doesn't 10x the DB
// hits. Cache invalidates on the PATCH endpoint that mutates flags.

import { prisma } from "@medcore/db";
import {
  type FeatureKey,
  FEATURE_KEYS,
  isFeatureEnabled as resolveFlag,
  resolveAllFeatureFlags,
} from "@medcore/shared";

/** Every feature ON — the Main/Default hospital's full-access map. */
function allFeaturesEnabled(): Record<FeatureKey, boolean> {
  const out = {} as Record<FeatureKey, boolean>;
  for (const k of FEATURE_KEYS) out[k] = true;
  return out;
}

interface CacheEntry {
  flags: Record<string, unknown> | null;
  // The Main/Default hospital (subdomain "default") gets FULL access — it is
  // not a plan-limited customer tenant, so every feature is on regardless of
  // its plan. (Mirrors the `tenantId == null` Main-hospital case.)
  isDefault: boolean;
  expiresAt: number;
}

const TTL_MS = 60_000;
const cache = new Map<string, CacheEntry>();

async function loadTenant(
  tenantId: string,
): Promise<{ flags: Record<string, unknown> | null; isDefault: boolean }> {
  const now = Date.now();
  const cached = cache.get(tenantId);
  if (cached && cached.expiresAt > now)
    return { flags: cached.flags, isDefault: cached.isDefault };

  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { featureFlags: true, subdomain: true },
  });
  const flags = (tenant?.featureFlags ?? null) as
    | Record<string, unknown>
    | null;
  const isDefault = tenant?.subdomain === "default";
  cache.set(tenantId, { flags, isDefault, expiresAt: now + TTL_MS });
  return { flags, isDefault };
}

/**
 * Check a single feature flag for a tenant.
 *
 * Returns `true` if:
 *  - no tenantId is supplied (single-tenant deploy / legacy code path)
 *  - the tenant has no override for this key (use default)
 *  - the tenant explicitly set this key to true
 *
 * Returns `false` only when the tenant explicitly set the key to false.
 */
export async function isFeatureEnabled(
  tenantId: string | null | undefined,
  key: FeatureKey,
): Promise<boolean> {
  if (!tenantId) return true; // Main hospital (null tenant) → full access
  const { flags, isDefault } = await loadTenant(tenantId);
  if (isDefault) return true; // Default/Main hospital → full access
  return resolveFlag(flags, key);
}

/**
 * Resolve all flags for the tenant — used by the
 * `GET /api/v1/feature-flags` endpoint so the web client can mirror
 * the same on/off state in nav config + route guards.
 */
export async function getAllFeatureFlags(
  tenantId: string | null | undefined,
): Promise<Record<FeatureKey, boolean>> {
  // Main hospital (null tenant) → full access (all features on).
  if (!tenantId) return allFeaturesEnabled();
  const { flags, isDefault } = await loadTenant(tenantId);
  // Default/Main hospital → full access too.
  if (isDefault) return allFeaturesEnabled();
  return resolveAllFeatureFlags(flags);
}

/** Invalidate the cache for a tenant. Call after PATCH writes. */
export function invalidateFeatureFlagsCache(tenantId: string): void {
  cache.delete(tenantId);
}

/** Test-only reset hook (singleFork test isolation). */
export function __resetFeatureFlagsCacheForTests(): void {
  cache.clear();
}
