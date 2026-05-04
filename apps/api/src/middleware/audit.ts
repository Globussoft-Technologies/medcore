import { Request } from "express";
import { prisma } from "@medcore/db";
import { getTenantId } from "../services/tenant-context";

/**
 * Persist a single audit row.
 *
 * Issue #456 — `tenantId` is pulled from the current `runWithTenant`
 * AsyncLocalStorage context so every audit row is scoped to the tenant whose
 * request triggered it. We deliberately use the un-scoped `prisma` here
 * (instead of `tenantScopedPrisma`) so we can:
 *   1. Stamp the column ourselves explicitly (clearer intent at the call
 *      site than relying on the auto-injection extension).
 *   2. Tolerate the rare bootstrap path where the writer fires before any
 *      tenant context exists — e.g. a login attempt from an unknown email,
 *      a forgot-password code resolution that happens before a JWT can set
 *      `req.tenantId`, or a cron job that runs outside an HTTP request.
 *      In those cases we log a warn and insert NULL; the column is
 *      nullable on purpose for exactly this scenario.
 */
export async function auditLog(
  req: Request,
  action: string,
  entity: string,
  entityId?: string,
  details?: Record<string, unknown>
): Promise<void> {
  const userId = req.user?.userId ?? null;
  const forwarded = req.headers["x-forwarded-for"];
  const ipAddress =
    (typeof forwarded === "string" ? forwarded.split(",")[0].trim() : req.ip) ??
    null;

  // Prefer the AsyncLocalStorage value (set by `withTenantContext`) because
  // that's the same source `tenantScopedPrisma` reads from — keeping both
  // paths consistent. Fall back to `req.tenantId` (set by
  // `tenantContextMiddleware` directly on the request) for callers that
  // bypassed the ALS wrap (some test apps don't mount it).
  const tenantId = getTenantId() ?? req.tenantId ?? null;
  if (!tenantId) {
    // Bootstrap / system path — known and tolerated. We still emit a warn
    // so a sustained spike (which would indicate the tenant middleware is
    // not running on a route that should be tenant-scoped) is visible in
    // the logs.
    console.warn(
      `[audit] tenantId missing for action=${action} entity=${entity} ` +
        `userId=${userId ?? "null"} — writing NULL.`
    );
  }

  await prisma.auditLog.create({
    data: {
      userId,
      action,
      entity,
      entityId: entityId ?? null,
      details: (details as any) ?? undefined,
      ipAddress,
      tenantId,
    },
  });
}
