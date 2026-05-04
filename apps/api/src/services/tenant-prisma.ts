/**
 * Back-compat re-export shim for the tenant-scoped Prisma client.
 *
 * A10 (2026-05-04): the wrapper now lives in `@medcore/db` so workers, cron
 * jobs, and any other secondary service can import it without crossing the
 * `apps → packages` arrow. New code should `import { tenantScopedPrisma }
 * from "@medcore/db"` directly.
 *
 * This file remains here purely so the 100+ existing
 * `import { tenantScopedPrisma } from "../services/tenant-prisma"` call
 * sites in this app keep compiling unchanged. It SHOULD NOT grow new
 * exports — anything new belongs in `@medcore/db/src/tenant-prisma.ts`.
 */

export {
  TENANT_SCOPED_MODELS,
  applyTenantScope,
  shouldScope,
  tenantScopedPrisma,
} from "@medcore/db";
export type { TenantScopedPrisma } from "@medcore/db";
