import { AsyncLocalStorage } from "node:async_hooks";
import type { Request, Response, NextFunction } from "express";

/**
 * Per-request context propagated across async boundaries so that code deep in
 * the call stack — most importantly Prisma middleware — can discover which
 * tenant the current request belongs to without having to thread it through
 * every function signature.
 */
export interface TenantContext {
  /** Tenant id resolved from the JWT or `X-Tenant-Id` header. */
  tenantId: string;
}

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
    }
  }
}

/**
 * AsyncLocalStorage instance holding the current request's tenant. Use
 * {@link getTenantId} / {@link requireTenantId} from request-scoped code —
 * importing this export directly should be reserved for framework glue such
 * as Prisma middleware or tests.
 */
export const tenantAsyncStorage = new AsyncLocalStorage<TenantContext>();

/**
 * Runs `fn` inside an async-local scope bound to `tenantId`. Every Promise
 * chain, timer, or microtask created inside `fn` sees the same context via
 * {@link getTenantId}.
 */
export function runWithTenant<T>(tenantId: string, fn: () => T): T {
  return tenantAsyncStorage.run({ tenantId }, fn);
}

/**
 * Returns the tenant id for the current async context, or `undefined` if no
 * context has been established (e.g. background jobs, tests, requests where
 * the middleware did not run).
 */
export function getTenantId(): string | undefined {
  return tenantAsyncStorage.getStore()?.tenantId;
}

/**
 * Like {@link getTenantId} but throws if no tenant is in scope. Use this from
 * code paths that are never supposed to run outside a tenant-scoped request
 * (e.g. Prisma middleware attached to tenant-owned models).
 */
export function requireTenantId(): string {
  const tenantId = getTenantId();
  if (!tenantId) {
    throw new Error(
      "No tenant in async context. Ensure tenantContextMiddleware ran and " +
        "that tenant-scoped code is executed via runWithTenant()/withTenantContext.",
    );
  }
  return tenantId;
}

/**
 * Express middleware that wraps `next()` in an AsyncLocalStorage scope bound
 * to `req.tenantId`. Must be mounted AFTER `tenantContextMiddleware` (which
 * resolves `req.tenantId`). When no tenant is present the middleware is a
 * no-op so it is safe to mount globally.
 */
export function withTenantContext(
  req: Request,
  _res: Response,
  next: NextFunction,
) {
  if (req.tenantId) {
    return tenantAsyncStorage.run({ tenantId: req.tenantId }, () => next());
  }
  return next();
}
