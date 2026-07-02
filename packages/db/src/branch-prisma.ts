/**
 * Branch-scoped Prisma client + AsyncLocalStorage primitives.
 *
 * Pearl ERP Stage 1 gap item #2, piece 2a (2026-05-21). Pearl §7.2 calls
 * for "multi-tenant + branch-aware scoping". Tenants are already covered
 * by `tenantScopedPrisma`; this file is the symmetric counterpart for
 * branches. Where `tenantScopedPrisma` answers "which hospital owns this
 * row", `branchScopedPrisma` answers "which physical site of that
 * hospital owns it" — so a multi-branch chain can run one DB and let
 * each branch's Reception desk see only their own day's appointments
 * without every route having to thread `where: { branchId }` by hand.
 *
 * Shape mirrors `./tenant-prisma.ts` deliberately:
 *
 *   1. AsyncLocalStorage primitives — `branchAsyncStorage`,
 *      `runWithBranch`, `getBranchId`, `requireBranchId`.
 *   2. `branchScopedPrisma` — a Prisma `$extends` wrapper layered on TOP
 *      of `tenantScopedPrisma` so callers that use this client
 *      automatically get BOTH `tenantId` and `branchId` stamping/
 *      filtering for free.
 *
 * Scope cut (piece 2a):
 *   - The extension only acts on the models listed in `BRANCH_SCOPED_MODELS`.
 *   - That list currently contains exactly one entry — `Appointment` — so
 *     piece 2a can ship safely without touching invoicing, doctor
 *     scheduling, or any other surface that hasn't yet had its `branchId`
 *     column added. Piece 2b expands the list to Invoice/Doctor/Patient.
 *
 * Express glue (`branchContextMiddleware`) is co-located here so a single
 * file is the single source of truth for branch scoping (storage +
 * extension + middleware) — easier to audit than spreading it across
 * three packages. The middleware is purely a function on `Request`/
 * `Response`/`NextFunction` shapes — it does NOT import express, so this
 * module keeps `@medcore/db`'s zero-Express-dependency invariant.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { tenantScopedPrisma } from "./tenant-prisma";

// ── AsyncLocalStorage branch context ────────────────────────────────────────

/**
 * Per-request context propagated across async boundaries so the Prisma
 * extension below can discover which branch the current request belongs
 * to without threading it through every function signature.
 */
export interface BranchContext {
  /** Branch id resolved from `X-Branch-Id` (piece 2a) or — later, in
   *  piece 2b — from the caller's session / JWT claim. */
  branchId: string;
}

/**
 * AsyncLocalStorage instance holding the current request's branch. Use
 * {@link getBranchId} / {@link requireBranchId} from request-scoped
 * code; importing this export directly should be reserved for framework
 * glue (Prisma middleware, test setup) or pre-flight assertions that
 * verify no stray branch frame is in scope.
 */
export const branchAsyncStorage = new AsyncLocalStorage<BranchContext>();

/**
 * Runs `fn` inside an async-local scope bound to `branchId`. Every
 * Promise chain, timer, or microtask created inside `fn` sees the same
 * context via {@link getBranchId}.
 */
export function runWithBranch<T>(branchId: string, fn: () => T): T {
  return branchAsyncStorage.run({ branchId }, fn);
}

/**
 * Returns the branch id for the current async context, or `undefined`
 * when no context has been established (legacy routes, background jobs,
 * tests without `runWithBranch`). The extension treats `undefined` as
 * "branch scoping disabled" and passes through unchanged — see the
 * `$allOperations` body below.
 */
export function getBranchId(): string | undefined {
  return branchAsyncStorage.getStore()?.branchId;
}

/**
 * Like {@link getBranchId} but throws if no branch is in scope. Use
 * this from code paths that are never supposed to run outside a branch-
 * scoped request.
 */
export function requireBranchId(): string {
  const branchId = getBranchId();
  if (!branchId) {
    throw new Error(
      "No branch in async context. Ensure branchContextMiddleware ran " +
        "and that branch-scoped code is executed via runWithBranch().",
    );
  }
  return branchId;
}

// ── Branch-scoped Prisma extension ──────────────────────────────────────────

/**
 * Models whose rows are owned by exactly one branch. KEEP IN SYNC with
 * the Prisma schema — any model that gains a `branchId` column MUST be
 * added here or the extension will not scope it.
 *
 * Piece 2a (2026-05-21): `Appointment` only — POC.
 * Piece 2b (2026-05-21 follow-up): + `Invoice`, `Doctor`, `Patient`.
 *
 * 2026-07 REVERT of Doctor + Patient (bug fix): branch-scoping the DOCTOR
 * and PATIENT *identity* records broke booking. A doctor/patient is a
 * tenant-wide master record — the booking pickers list them via
 * `tenantScopedPrisma` (routes/doctors.ts, routes/patients.ts), i.e. across
 * ALL branches — but the booking handler (routes/appointments.ts, the only
 * consumer of `branchScopedPrisma`) resolved them via the branch-scoped
 * client. So a doctor created WITHOUT a branchId (the create paths never set
 * one), or assigned to a different branch than the request's `X-Branch-Id`,
 * was visible in the dropdown yet 404'd ("Doctor not found") on
 * /appointments/book and /next-token. Identity records must NOT be
 * branch-filtered; only TRANSACTIONAL rows (which branch physically owns
 * this appointment / invoice) are. Appointment + Invoice stay scoped so the
 * per-branch appointment/billing lists still isolate correctly.
 *
 * Future pieces will expand to Prescription / LabOrder / DoctorSchedule
 * etc. (transactional rows) when their per-branch UX surfaces are designed —
 * NOT to identity/master records.
 */
export const BRANCH_SCOPED_MODELS = new Set<string>([
  "Appointment",
  "Invoice",
]);

/** Operations on which we INJECT `branchId` into `args.data`. */
const CREATE_OPERATIONS = new Set<string>(["create", "createMany", "upsert"]);

/**
 * Operations on which we INJECT `branchId` into `args.where`. `upsert`
 * is deliberately in BOTH sets — we need the where clause to find the
 * row AND the create payload to tag a new row.
 */
const READ_WRITE_OPERATIONS = new Set<string>([
  "findFirst",
  "findFirstOrThrow",
  "findMany",
  "findUnique",
  "findUniqueOrThrow",
  "update",
  "updateMany",
  "delete",
  "deleteMany",
  "count",
  "aggregate",
  "groupBy",
  "upsert",
]);

/**
 * Whether the Prisma-extension `$allModels` hook should act on a given
 * (model, operation) pair. Exported for tests.
 */
export function shouldScopeBranch(
  model: string | undefined,
  operation: string,
): boolean {
  if (!model || !BRANCH_SCOPED_MODELS.has(model)) return false;
  return (
    CREATE_OPERATIONS.has(operation) || READ_WRITE_OPERATIONS.has(operation)
  );
}

/**
 * Inject `branchId` into `args.where` / `args.data` as appropriate.
 * Exposed for unit tests — the public API is {@link branchScopedPrisma}.
 *
 * Read-path safety valve: if the caller already supplied `where.branchId`
 * (e.g. an admin report intentionally querying a SPECIFIC branch other
 * than their own context), we leave it untouched. The extension's job is
 * to be a SAFE DEFAULT, not a hard wall — tenant scoping makes the same
 * choice (see `applyTenantScope` in tenant-prisma.ts).
 */
export function applyBranchScope<A extends Record<string, unknown>>(
  args: A | undefined,
  operation: string,
  branchId: string,
): A {
  const next: Record<string, unknown> = { ...(args ?? {}) };

  if (READ_WRITE_OPERATIONS.has(operation)) {
    const existing =
      (next.where as Record<string, unknown> | undefined) ?? undefined;
    // Don't clobber an explicit branchId filter — admin queries that
    // explicitly scope to another branch must pass through unchanged.
    if (existing && "branchId" in existing) {
      next.where = existing;
    } else {
      next.where = existing ? { ...existing, branchId } : { branchId };
    }
  }

  if (CREATE_OPERATIONS.has(operation)) {
    const data = next.data;
    if (Array.isArray(data)) {
      next.data = data.map((row) => {
        if (!row || typeof row !== "object") return row;
        const r = row as Record<string, unknown>;
        // Don't clobber an explicit branchId in the payload.
        return "branchId" in r ? r : { ...r, branchId };
      });
    } else if (data && typeof data === "object") {
      const d = data as Record<string, unknown>;
      next.data = "branchId" in d ? d : { ...d, branchId };
    } else if (operation === "create" || operation === "createMany") {
      next.data = { branchId };
    }

    if (operation === "upsert") {
      const create = next.create;
      if (create && typeof create === "object") {
        const c = create as Record<string, unknown>;
        next.create = "branchId" in c ? c : { ...c, branchId };
      } else {
        next.create = { branchId };
      }
    }
  }

  return next as A;
}

/**
 * Prisma client with automatic branch scoping ON TOP OF tenant scoping.
 *
 * Layering: `prisma → tenantScopedPrisma.$extends(...) → this`. So a
 * single call to `branchScopedPrisma.appointment.findMany()` automatically:
 *   1. filters by `tenantId` (from the tenant ALS), then
 *   2. filters by `branchId` (from the branch ALS) when one is set.
 *
 * Usage:
 *
 * ```ts
 * import { branchScopedPrisma } from "@medcore/db";
 *
 * const mine = await branchScopedPrisma.appointment.findMany();
 * //   ^ filtered by caller's tenantId AND branchId (if any)
 * ```
 */
export const branchScopedPrisma = tenantScopedPrisma.$extends({
  name: "branch-scoping",
  query: {
    $allModels: {
      async $allOperations({ model, operation, args, query }) {
        const branchId = getBranchId();
        if (!branchId || !shouldScopeBranch(model, operation)) {
          return query(args);
        }
        const scoped = applyBranchScope(
          args as Record<string, unknown>,
          operation,
          branchId,
        );
        return query(scoped);
      },
    },
  },
});

export type BranchScopedPrisma = typeof branchScopedPrisma;

// ── Express-shape middleware (zero express dependency) ──────────────────────

/**
 * Minimal Request/Response/Next shapes — typed structurally so this
 * module does NOT import `express` (preserving `@medcore/db`'s zero-
 * framework-dependency invariant). The Express app casts these at the
 * call site; runtime shape is identical.
 */
type BranchAwareRequest = {
  header(name: string): string | undefined;
  branchId?: string;
};
type BranchAwareNext = (err?: unknown) => void;

/**
 * Express middleware that resolves the current branch for a request and
 * sets `req.branchId`. Piece 2a resolution source: `X-Branch-Id` header
 * only. JWT-claim resolution + session-derived fallback ship in piece 2b
 * alongside the picker UI.
 *
 * Like `tenantContextMiddleware`, this middleware NEVER rejects — when
 * no branch header is present it is a no-op, and downstream legacy
 * routes behave exactly as before. That makes it safe to mount globally
 * even though most existing routes don't yet know what a branch is.
 *
 * Mount AFTER `withTenantContext` so the tenant ALS scope is already
 * open when we open the branch ALS scope inside it — that way Prisma
 * sees BOTH contexts for the duration of the request.
 */
export function branchContextMiddleware(
  req: BranchAwareRequest,
  _res: unknown,
  next: BranchAwareNext,
): void {
  const header = req.header("X-Branch-Id");
  if (header && typeof header === "string" && header.trim().length > 0) {
    req.branchId = header.trim();
  }
  return next();
}

/**
 * Express middleware that wraps `next()` in an AsyncLocalStorage scope
 * bound to `req.branchId`. No-op when `req.branchId` is undefined so
 * legacy routes pass through untouched. Mount AFTER
 * `branchContextMiddleware` (which sets the field).
 */
export function withBranchContext(
  req: BranchAwareRequest,
  _res: unknown,
  next: BranchAwareNext,
): void {
  if (req.branchId) {
    return runWithBranch(req.branchId, () => next());
  }
  return next();
}
