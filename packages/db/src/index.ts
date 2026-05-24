// `prisma` lives in its own module to break the circular import between
// this file and `./tenant-prisma`. The cycle was: index.ts → tenant-prisma.ts
// → index.ts (for `prisma`), and tenant-prisma.ts calls `prisma.$extends()`
// synchronously at module load — which TDZ-crashes under tsx/CJS.
export { prisma } from "./client";
export { PrismaClient } from "@prisma/client";
export * from "@prisma/client";

// Shared helpers used by both seed scripts and data-correction scripts.
export * from "./lib/immunization-schedule";

// Issue #272: TEMPLATES is exported so the api regression test can pin
// the audience-scoping contract for seed-templated notifications.
export { TEMPLATES as NOTIFICATION_SEED_TEMPLATES } from "./seed-notifications-history";
export type { TemplateDef as NotificationSeedTemplateDef } from "./seed-notifications-history";

// A10 (2026-05-04): tenant-scoped Prisma client + AsyncLocalStorage
// primitives. Lifted from `apps/api/src/services/tenant-prisma.ts` so workers,
// cron jobs, and any other secondary service can consume safe scoping without
// crossing the `apps → packages` arrow. The api app keeps a thin re-export
// shim at the legacy path so the 100+ existing import sites compile
// unchanged. See `./tenant-prisma.ts` for full architectural notes.
export {
  PLATFORM_ROLES,
  TENANT_SCOPED_MODELS,
  applyTenantScope,
  getTenantId,
  isPlatformRole,
  requireTenantId,
  runWithTenant,
  shouldScope,
  tenantAsyncStorage,
  tenantScopedPrisma,
} from "./tenant-prisma";
export type { TenantContext, TenantScopedPrisma } from "./tenant-prisma";

// Pearl ERP Stage 1 gap item #2 — piece 2a (2026-05-21). Branch-scoped
// Prisma client + AsyncLocalStorage primitives, layered on top of the
// tenant-scoped client so callers get BOTH stamping/filtering for free.
// See ./branch-prisma.ts for the architectural rationale; piece 2b
// expands BRANCH_SCOPED_MODELS beyond `Appointment` once the picker UI
// ships.
export {
  BRANCH_SCOPED_MODELS,
  applyBranchScope,
  branchAsyncStorage,
  branchContextMiddleware,
  branchScopedPrisma,
  getBranchId,
  requireBranchId,
  runWithBranch,
  shouldScopeBranch,
  withBranchContext,
} from "./branch-prisma";
export type { BranchContext, BranchScopedPrisma } from "./branch-prisma";
