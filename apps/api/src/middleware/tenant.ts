import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

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

/**
 * Express middleware that resolves the current tenant for a request and sets
 * `req.tenantId`. Resolution order:
 *
 *   1. `X-Tenant-Id` header (explicit override — used for service-to-service
 *      traffic and admin tooling).
 *   2. `tenantId` claim inside the JWT in `Authorization: Bearer <token>`.
 *
 * When neither source yields a tenant, `req.tenantId` is left `undefined`.
 * This middleware DOES NOT reject requests; enforcement (i.e. 400/403 when a
 * tenant-scoped route is hit without a tenant) is the caller's responsibility.
 * That keeps the middleware safe to mount globally alongside routes that
 * legitimately operate without a tenant (e.g. `/api/health`, cross-tenant
 * admin endpoints).
 *
 * The middleware must run AFTER any JWT parsing middleware if JWT-based
 * resolution is desired, or can decode the token itself as a fallback. Here
 * we decode independently so the middleware does not couple to auth ordering.
 */
export function tenantContextMiddleware(
  req: Request,
  _res: Response,
  next: NextFunction,
) {
  // 1. Explicit header override.
  const headerTenant = req.header("X-Tenant-Id");
  if (headerTenant && typeof headerTenant === "string" && headerTenant.trim().length > 0) {
    req.tenantId = headerTenant.trim();
    return next();
  }

  // 2. JWT claim fallback.
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice("Bearer ".length);
    try {
      const decoded = jwt.verify(
        token,
        process.env.JWT_SECRET || "dev-secret",
      ) as { tenantId?: unknown };
      if (decoded && typeof decoded.tenantId === "string" && decoded.tenantId.length > 0) {
        req.tenantId = decoded.tenantId;
      }
    } catch {
      // Leave tenantId undefined; upstream auth middleware will handle the
      // invalid/expired token case. We deliberately do not 401 here because
      // not all routes require authentication.
    }
  }

  return next();
}
