/**
 * Unit-level surface test for the `@medcore/db` package entrypoint.
 *
 * Strategy:
 *   `packages/db/src/index.ts` is overwhelmingly a re-export hub. Per the
 *   neighbour `tenant-prisma.test.ts` / `branch-prisma.test.ts` files in
 *   the same folder, the behavioural depth lives in the per-module test
 *   files; this file's job is to lock the public surface so a future
 *   refactor (renaming, removing, or moving a re-export) trips a fast
 *   unit test instead of a downstream consumer's red CI.
 *
 *   We deliberately avoid touching real Prisma at runtime by mocking the
 *   `./client` module before importing `index`. That way:
 *     - the index module is fully evaluated (covering every `export {}`
 *       / `export *` statement),
 *     - no DATABASE_URL is required,
 *     - no `new PrismaClient()` is constructed (which would log "Failed
 *       to load env" warnings under vitest).
 *
 * Why colocated (`packages/db/src/index.test.ts`) instead of joining the
 * existing `__tests__` folder: matches the requested test-cron allowlist
 * for this file; the root `vitest.config.ts` include glob
 * (`packages/** /*.test.ts`) picks up both locations equally.
 */

import { describe, it, expect, vi } from "vitest";

// Stub `./client` BEFORE importing index so the real PrismaClient is never
// instantiated AND `tenant-prisma.ts` (which calls `prisma.$extends(...)`
// at module load) doesn't crash. We provide a sentinel `prisma` object
// that satisfies both the re-export identity check AND the $extends call
// chain in tenant-prisma.ts + branch-prisma.ts.
vi.mock("./client", () => {
  // $extends returns a new client. Our sentinel re-returns itself so the
  // chained `tenantScopedPrisma` / `branchScopedPrisma` callsites get a
  // truthy, object-shaped value.
  const mockedClient: Record<string, unknown> = {
    __mocked: true,
    $extends: vi.fn(function (_def: unknown) {
      return mockedClient;
    }),
    $use: vi.fn(),
  };
  return { prisma: mockedClient };
});

// Resolve via the same relative path the test file lives at.
import * as dbIndex from "./index";

describe("@medcore/db package index — public surface", () => {
  describe("Prisma client + base re-exports", () => {
    it("re-exports `prisma` from ./client", () => {
      expect(dbIndex.prisma).toBeDefined();
      // The mocked sentinel above proves the re-export wiring is correct.
      expect((dbIndex.prisma as unknown as { __mocked: boolean }).__mocked).toBe(true);
    });

    it("re-exports the `PrismaClient` constructor from @prisma/client", () => {
      expect(dbIndex.PrismaClient).toBeDefined();
      expect(typeof dbIndex.PrismaClient).toBe("function");
    });

    it("re-exports `Prisma` namespace + enums from @prisma/client (via `export *`)", () => {
      // `Prisma` is the top-level namespace symbol every Prisma client ships.
      // Its presence here proves the `export * from "@prisma/client"` wiring.
      expect((dbIndex as Record<string, unknown>).Prisma).toBeDefined();
    });

    it("re-exports the `Role` enum from @prisma/client (used by audience filtering)", () => {
      const Role = (dbIndex as Record<string, unknown>).Role;
      expect(Role).toBeDefined();
      // Role is a Prisma enum — at runtime it is a plain object whose
      // values are uppercase strings.
      expect(typeof Role).toBe("object");
      expect((Role as Record<string, string>).ADMIN).toBe("ADMIN");
      expect((Role as Record<string, string>).PATIENT).toBe("PATIENT");
    });

    it("re-exports the `NotificationType` enum from @prisma/client", () => {
      const NotificationType = (dbIndex as Record<string, unknown>).NotificationType;
      expect(NotificationType).toBeDefined();
      expect(typeof NotificationType).toBe("object");
    });
  });

  describe("Immunization-schedule re-exports (./lib/immunization-schedule)", () => {
    it("re-exports `UIP_SCHEDULE` as a non-empty array of UIPEntry rows", () => {
      const schedule = (dbIndex as Record<string, unknown>).UIP_SCHEDULE as Array<{
        vaccine: string;
        dueAgeDays: number;
      }>;
      expect(Array.isArray(schedule)).toBe(true);
      expect(schedule.length).toBeGreaterThan(0);
      expect(typeof schedule[0].vaccine).toBe("string");
      expect(typeof schedule[0].dueAgeDays).toBe("number");
    });

    it("re-exports `ADULT_THRESHOLD_DAYS` and `ADULT_PATIENT_AGE_DAYS` as numeric constants", () => {
      expect((dbIndex as Record<string, unknown>).ADULT_THRESHOLD_DAYS).toBe(16 * 365);
      expect((dbIndex as Record<string, unknown>).ADULT_PATIENT_AGE_DAYS).toBe(18 * 365);
    });

    it("re-exports `findUIPEntry` and `recomputeImmunizationDue` as functions", () => {
      expect(typeof (dbIndex as Record<string, unknown>).findUIPEntry).toBe("function");
      expect(typeof (dbIndex as Record<string, unknown>).recomputeImmunizationDue).toBe("function");
    });
  });

  describe("Notification-seed templates re-export", () => {
    it("re-exports `TEMPLATES` (aliased to `NOTIFICATION_SEED_TEMPLATES`) as a non-empty array", () => {
      expect(Array.isArray(dbIndex.NOTIFICATION_SEED_TEMPLATES)).toBe(true);
      expect(dbIndex.NOTIFICATION_SEED_TEMPLATES.length).toBeGreaterThan(0);
    });

    it("each template carries the audience-scoping contract (type, title, audience[], messageFn)", () => {
      // Locks in the Issue #272 audience-scoping contract: without this
      // assertion a future refactor that drops `audience` would let
      // patient-targeted notifications leak into staff inboxes.
      for (const tpl of dbIndex.NOTIFICATION_SEED_TEMPLATES) {
        expect(typeof tpl.type).toBe("string");
        expect(typeof tpl.title).toBe("string");
        expect(Array.isArray(tpl.audience)).toBe(true);
        expect(tpl.audience.length).toBeGreaterThan(0);
        expect(typeof tpl.messageFn).toBe("function");
        // Calling messageFn() must yield a non-empty string.
        expect(typeof tpl.messageFn()).toBe("string");
      }
    });
  });

  describe("Tenant-scoping re-exports (./tenant-prisma — A10 lift)", () => {
    // Per CLAUDE.md "Source-side gotchas" #6: new consumers should import
    // these from @medcore/db directly without crossing the apps→packages
    // arrow. These assertions are the regression guard for that contract.
    it("re-exports `PLATFORM_ROLES` as a Set (or iterable) of role strings", () => {
      const platformRoles = (dbIndex as Record<string, unknown>).PLATFORM_ROLES;
      expect(platformRoles).toBeDefined();
      // Implementation uses a Set — assert iterability + .has surface.
      expect(typeof (platformRoles as Set<string>).has).toBe("function");
    });

    it("re-exports `TENANT_SCOPED_MODELS` as a Set with the expected shape", () => {
      const scoped = (dbIndex as Record<string, unknown>).TENANT_SCOPED_MODELS as Set<string>;
      expect(scoped).toBeDefined();
      expect(typeof scoped.has).toBe("function");
      expect(scoped.size).toBeGreaterThan(0);
    });

    it("re-exports the tenant-context primitives as functions", () => {
      expect(typeof (dbIndex as Record<string, unknown>).applyTenantScope).toBe("function");
      expect(typeof (dbIndex as Record<string, unknown>).getTenantId).toBe("function");
      expect(typeof (dbIndex as Record<string, unknown>).isPlatformRole).toBe("function");
      expect(typeof (dbIndex as Record<string, unknown>).requireTenantId).toBe("function");
      expect(typeof (dbIndex as Record<string, unknown>).runWithTenant).toBe("function");
      expect(typeof (dbIndex as Record<string, unknown>).shouldScope).toBe("function");
    });

    it("re-exports `tenantAsyncStorage` and `tenantScopedPrisma`", () => {
      expect((dbIndex as Record<string, unknown>).tenantAsyncStorage).toBeDefined();
      expect((dbIndex as Record<string, unknown>).tenantScopedPrisma).toBeDefined();
    });
  });

  describe("Branch-scoping re-exports (./branch-prisma — Pearl ERP piece 2a)", () => {
    it("re-exports `BRANCH_SCOPED_MODELS` as a Set", () => {
      const scoped = (dbIndex as Record<string, unknown>).BRANCH_SCOPED_MODELS as Set<string>;
      expect(scoped).toBeDefined();
      expect(typeof scoped.has).toBe("function");
      // Per branch-prisma.test.ts pieces 2a + 2b, at minimum Appointment
      // must be in the allow-list.
      expect(scoped.has("Appointment")).toBe(true);
    });

    it("re-exports the branch-context primitives as functions", () => {
      expect(typeof (dbIndex as Record<string, unknown>).applyBranchScope).toBe("function");
      expect(typeof (dbIndex as Record<string, unknown>).branchContextMiddleware).toBe("function");
      expect(typeof (dbIndex as Record<string, unknown>).getBranchId).toBe("function");
      expect(typeof (dbIndex as Record<string, unknown>).requireBranchId).toBe("function");
      expect(typeof (dbIndex as Record<string, unknown>).runWithBranch).toBe("function");
      expect(typeof (dbIndex as Record<string, unknown>).shouldScopeBranch).toBe("function");
      expect(typeof (dbIndex as Record<string, unknown>).withBranchContext).toBe("function");
    });

    it("re-exports `branchAsyncStorage` and `branchScopedPrisma`", () => {
      expect((dbIndex as Record<string, unknown>).branchAsyncStorage).toBeDefined();
      expect((dbIndex as Record<string, unknown>).branchScopedPrisma).toBeDefined();
    });
  });

  describe("Surface inventory (regression guard)", () => {
    // Cheapest possible "did someone drop a named export?" check.
    // If this fails, look at index.ts vs the names listed below.
    it("ships every named export the api app + workers expect", () => {
      const expected = [
        // base
        "prisma",
        "PrismaClient",
        // notification seeds
        "NOTIFICATION_SEED_TEMPLATES",
        // immunization
        "UIP_SCHEDULE",
        "ADULT_THRESHOLD_DAYS",
        "ADULT_PATIENT_AGE_DAYS",
        "findUIPEntry",
        "recomputeImmunizationDue",
        // tenant
        "PLATFORM_ROLES",
        "TENANT_SCOPED_MODELS",
        "applyTenantScope",
        "getTenantId",
        "isPlatformRole",
        "requireTenantId",
        "runWithTenant",
        "shouldScope",
        "tenantAsyncStorage",
        "tenantScopedPrisma",
        // branch
        "BRANCH_SCOPED_MODELS",
        "applyBranchScope",
        "branchAsyncStorage",
        "branchContextMiddleware",
        "branchScopedPrisma",
        "getBranchId",
        "requireBranchId",
        "runWithBranch",
        "shouldScopeBranch",
        "withBranchContext",
      ];
      const surface = Object.keys(dbIndex as Record<string, unknown>);
      const missing = expected.filter((name) => !surface.includes(name));
      expect(missing).toEqual([]);
    });
  });
});
