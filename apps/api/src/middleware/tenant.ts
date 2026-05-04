import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import type { AuthPayload } from "@medcore/shared";
import { prisma } from "@medcore/db";

/**
 * Tenant identifier attached to every request by {@link tenantContextMiddleware}.
 * In the future this will be used by Prisma middleware (see
 * `apps/api/src/services/tenant-context.ts`) to automatically scope queries
 * to the caller's tenant.
 *
 * NOTE: The Express `Request.tenantId` augmentation is declared in
 * `apps/api/src/services/tenant-context.ts` to avoid duplicate declarations
 * across the tree; importing that module once is enough to pick it up.
 */

// security(2026-05-04): A9 — runWithTenant previously stuffed any string into
// AsyncLocalStorage with no validation. A single upstream-middleware bypass
// (forged JWT carrying a non-existent tenantId, or an X-Tenant-Id header
// pointing at a deactivated tenant) would let the rest of the app operate
// under that bogus tenantId. Worst case: tenantScopedPrisma writes new rows
// stamped with the bogus tenantId, producing orphan PHI invisible to scoped
// queries but still readable via raw client. We close the gap here, at the
// boundary where the tenantId first enters request scope.
type TenantValidationEntry = {
  valid: boolean;
  expiresAt: number;
};
const TENANT_VALIDATION_CACHE = new Map<string, TenantValidationEntry>();
const TENANT_CACHE_TTL_OK_MS = 60_000; // 1 min — exists + active
const TENANT_CACHE_TTL_BAD_MS = 30_000; // 30s — non-existent or inactive
const TENANT_CACHE_MAX_ENTRIES = 256; // bounded so a flood of bogus IDs can't grow this unbounded

async function isValidActiveTenant(tenantId: string): Promise<boolean> {
  const now = Date.now();
  const cached = TENANT_VALIDATION_CACHE.get(tenantId);
  if (cached && cached.expiresAt > now) return cached.valid;

  let valid = false;
  try {
    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true, active: true },
    });
    valid = Boolean(tenant && tenant.active);
  } catch (err) {
    // DB blip — fail closed (treat as invalid) so a transient error doesn't
    // silently expose data. A subsequent request with the same id will retry
    // because we don't cache the error path.
    console.warn(
      `[tenant] validation lookup failed for tenantId=${tenantId} — failing closed:`,
      (err as Error)?.message ?? err,
    );
    return false;
  }

  if (TENANT_VALIDATION_CACHE.size >= TENANT_CACHE_MAX_ENTRIES) {
    // Cheap bound: drop the oldest insertion. Map preserves insertion order.
    const firstKey = TENANT_VALIDATION_CACHE.keys().next().value;
    if (firstKey !== undefined) TENANT_VALIDATION_CACHE.delete(firstKey);
  }
  TENANT_VALIDATION_CACHE.set(tenantId, {
    valid,
    expiresAt: now + (valid ? TENANT_CACHE_TTL_OK_MS : TENANT_CACHE_TTL_BAD_MS),
  });
  return valid;
}

/**
 * Test hook — drop the cache between cases so existence assertions don't bleed.
 */
export function __resetTenantValidationCacheForTests(): void {
  TENANT_VALIDATION_CACHE.clear();
}

/**
 * Express middleware that resolves the current tenant for a request and sets
 * `req.tenantId`. Resolution order:
 *
 *   1. `X-Tenant-Id` header (explicit override — used for service-to-service
 *      traffic and admin tooling).
 *   2. `req.user.tenantId` — populated by {@link authenticate} from the JWT.
 *      When this middleware runs BEFORE `authenticate` (the default, because
 *      it is mounted globally in `app.ts`), we fall back to decoding the JWT
 *      ourselves so tenant resolution does not depend on middleware ordering.
 *   3. `undefined` — pass-through / cross-tenant admin endpoints.
 *
 * This middleware DOES NOT reject requests; enforcement (i.e. 400/403 when a
 * tenant-scoped route is hit without a tenant) is the caller's responsibility.
 * That keeps the middleware safe to mount globally alongside routes that
 * legitimately operate without a tenant (e.g. `/api/health`, cross-tenant
 * admin endpoints).
 */
export async function tenantContextMiddleware(
  req: Request,
  _res: Response,
  next: NextFunction,
) {
  // First pass — pick the candidate tenantId (string) without committing
  // it to req.tenantId yet. Validation against the DB happens after.
  let candidate: string | undefined;

  // 1. Explicit header override — server-to-server calls, admin tooling.
  const headerTenant = req.header("X-Tenant-Id");
  if (headerTenant && typeof headerTenant === "string" && headerTenant.trim().length > 0) {
    candidate = headerTenant.trim();
  } else if (req.user?.tenantId) {
    // 2a. If authenticate() already ran, use the typed payload directly.
    candidate = req.user.tenantId;
  } else {
    // 2b. Fall back to decoding the bearer token ourselves — this middleware
    //     is mounted globally BEFORE the per-router `authenticate` call, so
    //     `req.user` is typically still undefined here.
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith("Bearer ")) {
      const token = authHeader.slice("Bearer ".length);
      try {
        const decoded = jwt.verify(
          token,
          process.env.JWT_SECRET || "dev-secret",
        ) as Partial<AuthPayload>;
        if (decoded && typeof decoded.tenantId === "string" && decoded.tenantId.length > 0) {
          candidate = decoded.tenantId;
        }
      } catch {
        // Leave candidate undefined; upstream auth middleware will handle
        // the invalid/expired token case. We deliberately do not 401 here
        // because not all routes require authentication.
      }
    }
  }

  // No candidate → pass through. /api/health, login, register, etc. all
  // legitimately operate without a tenant. Auth enforcement is downstream.
  if (!candidate) return next();

  // security(2026-05-04): A9 — validate before committing. Non-existent or
  // deactivated tenants get silently dropped (req.tenantId stays undefined)
  // so downstream tenant-required routes 4xx as if no tenant was supplied.
  // Logging the rejection lets ops spot tampered tokens without leaking the
  // string back to the caller.
  const valid = await isValidActiveTenant(candidate);
  if (valid) {
    req.tenantId = candidate;
  } else {
    console.warn(
      `[tenant] rejected non-existent or inactive tenantId=${candidate} from ${req.ip ?? "?"}`,
    );
  }
  return next();
}
