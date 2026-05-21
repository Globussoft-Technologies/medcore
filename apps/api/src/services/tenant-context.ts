import type { Request, Response, NextFunction } from "express";
import { runWithTenant } from "@medcore/db";

/**
 * Per-request context propagated across async boundaries so that code deep
 * in the call stack — most importantly Prisma middleware — can discover
 * which tenant the current request belongs to without having to thread it
 * through every function signature.
 *
 * A10 (2026-05-04): the AsyncLocalStorage instance, `runWithTenant`,
 * `getTenantId`, and `requireTenantId` now live in `@medcore/db` next to
 * the `tenantScopedPrisma` extension that consumes them. Keeping them
 * co-located guarantees a SINGLE ALS instance process-wide — splitting
 * the storage from the wrapper would silently break cross-async tenant
 * propagation, which is the exact failure mode this whole subsystem
 * exists to prevent.
 *
 * This file remains here for two reasons:
 *   1. The Express middleware `withTenantContext` belongs to the API app,
 *      not to `@medcore/db` (which intentionally has zero Express deps).
 *   2. The 7 existing call sites of
 *      `import { ... } from "../services/tenant-context"` keep compiling
 *      unchanged via the re-exports below.
 */

// Re-export the ALS primitives from `@medcore/db` so existing callers
// keep working and there is exactly one AsyncLocalStorage instance.
export {
  runWithTenant,
  getTenantId,
  requireTenantId,
  tenantAsyncStorage,
} from "@medcore/db";
export type { TenantContext } from "@medcore/db";

// Augment Express.Request so `req.tenantId` is type-safe app-wide. Declaring
// it here (rather than in the middleware file) keeps the declaration
// discoverable from the storage module that most tenant-scoped code will
// import anyway.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /**
       * Set by `tenantContextMiddleware` to the tenant id resolved from the
       * request. `undefined` on unauthenticated or cross-tenant endpoints.
       */
      tenantId?: string;
      /**
       * Pearl §7.2 — set by `branchContextMiddleware` (from `@medcore/db`)
       * to the branch id resolved from the `X-Branch-Id` header (piece 2a).
       * `undefined` on requests without the header, in which case the
       * branch-scoped Prisma extension is a no-op.
       */
      branchId?: string;
    }
  }
}

/**
 * Express middleware that wraps `next()` in an AsyncLocalStorage scope bound
 * to `req.tenantId`. Must be mounted AFTER `tenantContextMiddleware` (which
 * resolves `req.tenantId`). When no tenant is present the middleware is a
 * no-op so it is safe to mount globally.
 *
 * We delegate to `runWithTenant` (re-exported above from `@medcore/db`)
 * rather than calling `tenantAsyncStorage.run` directly, so there is exactly
 * one place that opens the ALS scope. This keeps Express-specific glue in
 * apps/api while the storage primitive stays in `@medcore/db`.
 */
export function withTenantContext(
  req: Request,
  _res: Response,
  next: NextFunction,
) {
  if (req.tenantId) {
    return runWithTenant(req.tenantId, () => next());
  }
  return next();
}
