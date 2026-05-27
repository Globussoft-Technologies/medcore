/**
 * Pearl ERP Stage 1 §8.2 — super-admin session idle timeout.
 *
 * Enforces a sliding idle-window on cross-tenant super-admins
 * (`role=ADMIN AND tenantId IS NULL`). The window length is read from
 * SystemConfig under `super_admin_session_idle_minutes` (default 30,
 * clamped to [5, 1440]).
 *
 * Implementation
 * ──────────────
 *   - An in-memory `Map<userId, lastActivityMs>` records the timestamp
 *     of every authenticated request.
 *   - On each request, if `now - lastActivity > idleWindowMs`, the
 *     request is rejected with 401 and a `session_idle` error code so
 *     the frontend can pop a "signed out for inactivity" toast and
 *     redirect to /login.
 *   - The map updates on EVERY successful request — this is the
 *     "sliding" part; activity keeps the session alive.
 *
 * Caveats
 * ───────
 *   - In-memory state — does NOT persist across server restarts and
 *     does NOT sync across multiple API instances. For a multi-instance
 *     deploy swap this for a Redis store keyed by userId.
 *   - Tenant-bound users are NOT affected — only `tenantId == null`.
 *     Tenant idle-timeout is read from `Tenant.sessionIdleMinutes` and
 *     enforced by a separate piece (still deferred per CLAUDE.md).
 */

import type { Request, Response, NextFunction } from "express";
import { prisma } from "@medcore/db";

const SUPER_ADMIN_IDLE_KEY = "super_admin_session_idle_minutes";
const DEFAULT_IDLE_MINUTES = 30;
const MIN_IDLE_MINUTES = 5;
const MAX_IDLE_MINUTES = 1440;

// userId → epoch ms of last authenticated request.
const lastActivityByUser = new Map<string, number>();

// Cache the configured idle-window for 60s so we don't hit the DB on
// every request just to read a setting that rarely changes.
let cachedIdleMs: number | null = null;
let cacheExpiresAt = 0;
const CACHE_TTL_MS = 60_000;

async function getIdleWindowMs(): Promise<number> {
  const now = Date.now();
  if (cachedIdleMs !== null && now < cacheExpiresAt) return cachedIdleMs;
  try {
    const row = await prisma.systemConfig.findUnique({
      where: { key: SUPER_ADMIN_IDLE_KEY },
      select: { value: true },
    });
    const raw = parseInt(row?.value ?? String(DEFAULT_IDLE_MINUTES), 10);
    const minutes = Number.isFinite(raw)
      ? Math.min(Math.max(raw, MIN_IDLE_MINUTES), MAX_IDLE_MINUTES)
      : DEFAULT_IDLE_MINUTES;
    cachedIdleMs = minutes * 60_000;
    cacheExpiresAt = now + CACHE_TTL_MS;
    return cachedIdleMs;
  } catch {
    // DB hiccup → fall through with the default; never block legitimate
    // traffic because of a config read.
    cachedIdleMs = DEFAULT_IDLE_MINUTES * 60_000;
    cacheExpiresAt = now + CACHE_TTL_MS;
    return cachedIdleMs;
  }
}

/**
 * Sliding idle-timeout enforcement for super-admins. Mount AFTER
 * `authenticate` so `req.user` is populated.
 */
export async function enforceSuperAdminIdleTimeout(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const user = req.user;
  if (!user) return next();
  // Only super-admins are gated. Tenant-bound users pass through — their
  // idle policy is per-tenant (separate piece). Recognised shapes:
  //   - Role.SUPER_ADMIN (new dedicated role, always cross-tenant)
  //   - Role.ADMIN + tenantId=null (legacy Onviqa operator shape)
  const isSuperAdmin =
    user.role === "SUPER_ADMIN" ||
    (user.role === "ADMIN" && (user.tenantId ?? null) === null);
  if (!isSuperAdmin) return next();

  const idleMs = await getIdleWindowMs();
  const now = Date.now();
  const last = lastActivityByUser.get(user.userId);
  if (last !== undefined && now - last > idleMs) {
    lastActivityByUser.delete(user.userId);
    res.status(401).json({
      success: false,
      data: null,
      error: "session_idle",
      code: "session_idle",
      message:
        "Your super-admin session expired due to inactivity. Please sign in again.",
    });
    return;
  }
  lastActivityByUser.set(user.userId, now);
  return next();
}

/**
 * Test helpers — reset the in-memory state between cases.
 */
export function __resetSessionIdleStateForTests(): void {
  lastActivityByUser.clear();
  cachedIdleMs = null;
  cacheExpiresAt = 0;
}

/**
 * Read/write helpers for the configured idle window. Exposed so the
 * super-admin settings route can read + persist the value.
 */
export async function getSuperAdminIdleMinutes(): Promise<number> {
  const ms = await getIdleWindowMs();
  return Math.round(ms / 60_000);
}

export async function setSuperAdminIdleMinutes(
  minutes: number,
): Promise<number> {
  const clamped = Math.min(
    Math.max(Math.round(minutes), MIN_IDLE_MINUTES),
    MAX_IDLE_MINUTES,
  );
  await prisma.systemConfig.upsert({
    where: { key: SUPER_ADMIN_IDLE_KEY },
    create: { key: SUPER_ADMIN_IDLE_KEY, value: String(clamped) },
    update: { value: String(clamped) },
  });
  // Bust the cache so the next request sees the new value immediately.
  cachedIdleMs = null;
  cacheExpiresAt = 0;
  return clamped;
}

export const SUPER_ADMIN_IDLE_LIMITS = {
  default: DEFAULT_IDLE_MINUTES,
  min: MIN_IDLE_MINUTES,
  max: MAX_IDLE_MINUTES,
} as const;
