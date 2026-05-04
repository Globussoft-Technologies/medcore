/**
 * waitForAuditFlush — poll AuditLog until a matching row appears or timeout.
 *
 * Why this exists:
 *
 * Most route handlers in apps/api/src/routes/ai-*.ts (and friends) write
 * their audit row through a `safeAudit()` wrapper that does:
 *
 *     auditLog(req, action, entity, entityId, details).catch((err) => { ... });
 *
 * i.e. the route returns its 2xx response BEFORE the underlying
 * `prisma.auditLog.create()` promise resolves. Integration tests that hit
 * the route with supertest and then immediately query AuditLog race the
 * deferred write and see 0 rows ~5% of the time. The audit-phi suite has
 * flaked twice in CI on this exact shape:
 *   - 2026-05-03 on AI_SCRIBE_READ
 *   - 2026-05-05 on INSURANCE_CLAIMS_LIST
 * (both reported `expected 0 to be greater than or equal to 1`).
 *
 * Use this helper in place of an immediate `prisma.auditLog.findFirst({...})`
 * or `findMany({...})` whenever the assertion comes right after a route
 * call. It polls every `pollMs` (default 50ms) until either a matching
 * row exists or `timeoutMs` (default 2000ms) has elapsed, at which point
 * it throws a descriptive error. The match shape mirrors the AuditLog
 * schema in packages/db/prisma/schema.prisma — note: `entity`, NOT
 * `entityType` (the column is named `entity`).
 */
import type { AuditLog, PrismaClient } from "@prisma/client";

export interface WaitForAuditMatch {
  action: string;
  entity?: string;
  entityId?: string;
  userId?: string;
}

export interface WaitForAuditOptions {
  timeoutMs?: number;
  pollMs?: number;
}

export async function waitForAuditFlush(
  prisma: PrismaClient,
  match: WaitForAuditMatch,
  opts: WaitForAuditOptions = {}
): Promise<AuditLog> {
  const timeoutMs = opts.timeoutMs ?? 2000;
  const pollMs = opts.pollMs ?? 50;
  const start = Date.now();
  // First iteration runs immediately; subsequent iterations sleep
  // pollMs between polls until we exceed timeoutMs.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const row = await prisma.auditLog.findFirst({
      where: {
        action: match.action,
        ...(match.entity ? { entity: match.entity } : {}),
        ...(match.entityId ? { entityId: match.entityId } : {}),
        ...(match.userId ? { userId: match.userId } : {}),
      },
      orderBy: { createdAt: "desc" },
    });
    if (row) return row;
    if (Date.now() - start >= timeoutMs) {
      throw new Error(
        `waitForAuditFlush timeout after ${timeoutMs}ms for ${JSON.stringify(match)}`
      );
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

/**
 * Same polling contract as waitForAuditFlush but returns ALL rows that
 * match. Use for assertions like "exactly N rows for this entityId" where
 * the test wants to count duplicates / ordering, not just "at least one".
 *
 * Resolves as soon as `minCount` (default 1) rows are visible, or throws
 * on timeout. Returns the rows newest-first, matching findMany's orderBy.
 */
export async function waitForAuditRows(
  prisma: PrismaClient,
  match: WaitForAuditMatch,
  opts: WaitForAuditOptions & { minCount?: number } = {}
): Promise<AuditLog[]> {
  const timeoutMs = opts.timeoutMs ?? 2000;
  const pollMs = opts.pollMs ?? 50;
  const minCount = opts.minCount ?? 1;
  const start = Date.now();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const rows = await prisma.auditLog.findMany({
      where: {
        action: match.action,
        ...(match.entity ? { entity: match.entity } : {}),
        ...(match.entityId ? { entityId: match.entityId } : {}),
        ...(match.userId ? { userId: match.userId } : {}),
      },
      orderBy: { createdAt: "desc" },
    });
    if (rows.length >= minCount) return rows;
    if (Date.now() - start >= timeoutMs) {
      throw new Error(
        `waitForAuditRows timeout after ${timeoutMs}ms — found ${rows.length}/${minCount} for ${JSON.stringify(match)}`
      );
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}
