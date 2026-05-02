/**
 * Unit tests for the tenant async-local-storage helpers in `tenant-context.ts`.
 *
 * `tenantContextMiddleware` (in middleware/tenant.ts) resolves the tenant id;
 * `withTenantContext` then opens an AsyncLocalStorage scope so deep call sites
 * (most importantly the tenant-scoped Prisma extension) can read it via
 * `getTenantId()`. A bug in the ALS scoping is a cross-tenant data leak, so we
 * exercise the scope/un-scope, nesting, and async-boundary semantics.
 */

import { describe, it, expect, vi } from "vitest";
import {
  runWithTenant,
  getTenantId,
  requireTenantId,
  withTenantContext,
  tenantAsyncStorage,
} from "./tenant-context";

describe("getTenantId / runWithTenant", () => {
  it("returns undefined outside any scope", () => {
    expect(getTenantId()).toBeUndefined();
  });

  it("returns the bound id inside runWithTenant", () => {
    runWithTenant("t1", () => {
      expect(getTenantId()).toBe("t1");
    });
  });

  it("clears the tenant id after the scope exits", () => {
    runWithTenant("t1", () => {});
    expect(getTenantId()).toBeUndefined();
  });

  it("propagates the scope across awaited async work", async () => {
    await runWithTenant("t1", async () => {
      await Promise.resolve();
      expect(getTenantId()).toBe("t1");
      await new Promise((r) => setTimeout(r, 1));
      expect(getTenantId()).toBe("t1");
    });
  });

  it("nested scopes shadow the outer scope and restore it on exit", () => {
    runWithTenant("outer", () => {
      expect(getTenantId()).toBe("outer");
      runWithTenant("inner", () => {
        expect(getTenantId()).toBe("inner");
      });
      expect(getTenantId()).toBe("outer");
    });
  });

  it("forwards the inner function's return value", () => {
    const result = runWithTenant("t1", () => 42);
    expect(result).toBe(42);
  });

  it("isolates concurrent scopes (tenant A and tenant B do not bleed)", async () => {
    const seen: Array<{ tag: string; tenant: string | undefined }> = [];
    await Promise.all([
      runWithTenant("A", async () => {
        await new Promise((r) => setTimeout(r, 5));
        seen.push({ tag: "A", tenant: getTenantId() });
      }),
      runWithTenant("B", async () => {
        await new Promise((r) => setTimeout(r, 1));
        seen.push({ tag: "B", tenant: getTenantId() });
      }),
    ]);
    const a = seen.find((s) => s.tag === "A");
    const b = seen.find((s) => s.tag === "B");
    expect(a?.tenant).toBe("A");
    expect(b?.tenant).toBe("B");
  });

  it("propagates errors thrown inside the scope to the caller", () => {
    expect(() =>
      runWithTenant("t1", () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(getTenantId()).toBeUndefined();
  });
});

describe("requireTenantId", () => {
  it("returns the bound id inside a scope", () => {
    runWithTenant("t1", () => {
      expect(requireTenantId()).toBe("t1");
    });
  });

  it("throws outside any scope", () => {
    expect(() => requireTenantId()).toThrow(/No tenant in async context/);
  });
});

describe("withTenantContext middleware", () => {
  it("opens an ALS scope when req.tenantId is set", () => {
    const req: any = { tenantId: "t1" };
    const next = vi.fn(() => {
      expect(getTenantId()).toBe("t1");
    });
    withTenantContext(req, {} as any, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(getTenantId()).toBeUndefined();
  });

  it("is a no-op when req.tenantId is missing (so global mounting is safe)", () => {
    const req: any = {};
    const next = vi.fn(() => {
      expect(getTenantId()).toBeUndefined();
    });
    withTenantContext(req, {} as any, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("preserves the scope through async work started inside next()", async () => {
    const req: any = { tenantId: "t1" };
    let captured: string | undefined;
    await new Promise<void>((resolve) => {
      withTenantContext(req, {} as any, async () => {
        await Promise.resolve();
        captured = getTenantId();
        resolve();
      });
    });
    expect(captured).toBe("t1");
    expect(getTenantId()).toBeUndefined();
  });
});

describe("tenantAsyncStorage (low-level export)", () => {
  it("is the AsyncLocalStorage instance backing runWithTenant", () => {
    runWithTenant("t1", () => {
      expect(tenantAsyncStorage.getStore()).toEqual({ tenantId: "t1" });
    });
  });
});
