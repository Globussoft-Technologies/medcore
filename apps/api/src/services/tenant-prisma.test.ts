// Tests for services/tenant-prisma.ts — the back-compat re-export shim left
// behind after A10 (2026-05-04) lifted the tenant-scoped Prisma wrapper into
// `@medcore/db`. The full behavioural suite for the wrapper lives at
// packages/db/src/__tests__/tenant-prisma.test.ts; this file's job is narrower:
//
//   1. Guard the contract that the shim re-exports the four named values and
//      one type the rest of the API app imports from `../services/tenant-prisma`.
//      Any drift here silently breaks 100+ call sites at runtime.
//   2. Guard that each re-export is referentially identical to the canonical
//      `@medcore/db` export — i.e. nobody slipped a wrapper / rename / shadow
//      copy into the shim. Identity matters because both paths must resolve to
//      the SAME `tenantScopedPrisma` instance (and the same `applyTenantScope`
//      function) or the scoping extension would diverge between consumers.
//   3. Smoke-test the re-exported `shouldScope` + `applyTenantScope` through
//      the shim to prove the imported references are callable and behave as
//      documented (defence-in-depth: even if identity drifts unnoticed, the
//      functional contract is still pinned at this layer).

import { describe, it, expect } from "vitest";

import * as shim from "./tenant-prisma";
import * as canonical from "@medcore/db";

describe("services/tenant-prisma (back-compat shim)", () => {
  describe("named exports surface", () => {
    it("re-exports TENANT_SCOPED_MODELS", () => {
      expect(shim.TENANT_SCOPED_MODELS).toBeInstanceOf(Set);
      expect(shim.TENANT_SCOPED_MODELS.size).toBeGreaterThan(0);
    });

    it("re-exports applyTenantScope as a function", () => {
      expect(typeof shim.applyTenantScope).toBe("function");
    });

    it("re-exports shouldScope as a function", () => {
      expect(typeof shim.shouldScope).toBe("function");
    });

    it("re-exports tenantScopedPrisma (an extended Prisma client)", () => {
      expect(shim.tenantScopedPrisma).toBeDefined();
      // Prisma's $extends returns an object exposing model delegates.
      // Pick a canonical scoped model and assert the delegate is wired up.
      expect(typeof shim.tenantScopedPrisma.patient).toBe("object");
      expect(typeof shim.tenantScopedPrisma.patient.findMany).toBe("function");
    });
  });

  describe("identity with the canonical @medcore/db exports", () => {
    // The shim MUST re-export the same instances — not copies, not wrappers.
    // If these drift, two consumers will end up with two different
    // TENANT_SCOPED_MODELS sets / two different tenantScopedPrisma extensions,
    // silently breaking the "single source of truth" invariant called out at
    // the top of packages/db/src/tenant-prisma.ts.

    it("TENANT_SCOPED_MODELS is the same Set instance", () => {
      expect(shim.TENANT_SCOPED_MODELS).toBe(canonical.TENANT_SCOPED_MODELS);
    });

    it("applyTenantScope is the same function reference", () => {
      expect(shim.applyTenantScope).toBe(canonical.applyTenantScope);
    });

    it("shouldScope is the same function reference", () => {
      expect(shim.shouldScope).toBe(canonical.shouldScope);
    });

    it("tenantScopedPrisma is the same client instance", () => {
      expect(shim.tenantScopedPrisma).toBe(canonical.tenantScopedPrisma);
    });
  });

  describe("functional smoke through the shim", () => {
    // Defence-in-depth: even if the identity guards above are weakened in
    // the future (e.g. someone wraps the export for instrumentation), these
    // make sure the re-exported callables still honour the documented
    // contract from @medcore/db. The canonical exhaustive suite lives in
    // packages/db/src/__tests__/tenant-prisma.test.ts — these are a
    // minimal subset so a shim-level regression fails this file too.

    it("shouldScope returns true for a scoped model + write op", () => {
      expect(shim.shouldScope("Patient", "create")).toBe(true);
      expect(shim.shouldScope("Patient", "findMany")).toBe(true);
    });

    it("shouldScope returns false for an unknown model", () => {
      expect(shim.shouldScope("DefinitelyNotARealModel", "findMany")).toBe(
        false,
      );
    });

    it("shouldScope returns false when model is undefined", () => {
      expect(shim.shouldScope(undefined, "findMany")).toBe(false);
    });

    it("shouldScope returns false for non-scoped operations", () => {
      // e.g. raw $queryRaw, $executeRaw are not in the op set
      expect(shim.shouldScope("Patient", "$queryRaw")).toBe(false);
    });

    it("applyTenantScope injects tenantId into args.where on read ops", () => {
      const out = shim.applyTenantScope(
        { where: { id: "p1" } },
        "findFirst",
        "tenant-A",
      );
      expect(out.where).toEqual({ id: "p1", tenantId: "tenant-A" });
    });

    it("applyTenantScope injects tenantId into args.data on create", () => {
      const out = shim.applyTenantScope(
        { data: { name: "x" } },
        "create",
        "tenant-A",
      );
      expect(out.data).toEqual({ name: "x", tenantId: "tenant-A" });
    });

    it("applyTenantScope does not mutate the caller's args object", () => {
      const original = { where: { id: "p1" } };
      const out = shim.applyTenantScope(original, "findFirst", "tenant-A");
      expect(original.where).toEqual({ id: "p1" }); // untouched
      expect(out).not.toBe(original); // new top-level object returned
    });
  });
});
