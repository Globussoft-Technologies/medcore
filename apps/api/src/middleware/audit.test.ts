/**
 * Unit tests for the `auditLog` helper.
 *
 * The helper persists a row to `AuditLog`. We mock `@medcore/db` so we can
 * inspect exactly what would be sent to Prisma without touching a real DB.
 * Coverage focuses on:
 *   - userId / entityId / details / ipAddress nullability rules,
 *   - X-Forwarded-For parsing (first hop only, trimmed),
 *   - req.ip fallback when the header is absent,
 *   - that we always pass `prisma.auditLog.create` an object with a `data` key.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { auditCreate, getTenantIdMock } = vi.hoisted(() => ({
  auditCreate: vi.fn(),
  getTenantIdMock: vi.fn<() => string | undefined>(),
}));

vi.mock("@medcore/db", () => ({
  prisma: { auditLog: { create: auditCreate } },
}));

// Mock the tenant-context module so we can drive `getTenantId()` from each
// test without setting up an AsyncLocalStorage scope. Issue #456 added this
// dependency to the writer.
vi.mock("../services/tenant-context", () => ({
  getTenantId: getTenantIdMock,
}));

import { auditLog } from "./audit";

beforeEach(() => {
  auditCreate.mockReset();
  auditCreate.mockResolvedValue(undefined);
  getTenantIdMock.mockReset();
  // Default: no tenant context (matches pre-issue-#456 behaviour for the
  // existing assertions). Tests that exercise tenant-stamping override.
  getTenantIdMock.mockReturnValue(undefined);
});

function makeReq(overrides: Partial<{
  user: unknown;
  headers: Record<string, string | string[] | undefined>;
  ip: string;
}> = {}): any {
  return {
    user: overrides.user,
    headers: overrides.headers ?? {},
    ip: overrides.ip,
  };
}

describe("auditLog — payload shape", () => {
  it("writes userId from req.user.userId when authenticated", async () => {
    await auditLog(
      makeReq({ user: { userId: "u-1" }, ip: "1.2.3.4" }),
      "PATIENT_VIEW",
      "Patient",
      "p-1",
      { reason: "consultation" },
    );
    expect(auditCreate).toHaveBeenCalledTimes(1);
    expect(auditCreate.mock.calls[0][0]).toEqual({
      data: {
        userId: "u-1",
        action: "PATIENT_VIEW",
        entity: "Patient",
        entityId: "p-1",
        details: { reason: "consultation" },
        ipAddress: "1.2.3.4",
        // Issue #456: tenantId pulled from getTenantId(); bootstrap default
        // is undefined → writer falls back to req.tenantId → null.
        tenantId: null,
      },
    });
  });

  it("writes userId=null when req.user is missing (anonymous)", async () => {
    await auditLog(makeReq({ ip: "1.2.3.4" }), "LOGIN_FAIL", "Auth");
    expect(auditCreate.mock.calls[0][0].data.userId).toBeNull();
  });

  it("writes entityId=null when not provided", async () => {
    await auditLog(makeReq({ ip: "1.2.3.4" }), "LOGIN", "Auth");
    expect(auditCreate.mock.calls[0][0].data.entityId).toBeNull();
  });

  it("writes details=undefined (Prisma JSON null shorthand) when not provided", async () => {
    await auditLog(makeReq({ ip: "1.2.3.4" }), "LOGIN", "Auth", "u-1");
    expect(auditCreate.mock.calls[0][0].data.details).toBeUndefined();
  });

  it("preserves complex details payloads as-is", async () => {
    const details = {
      ip: "1.2.3.4",
      changes: { before: { name: "A" }, after: { name: "B" } },
    };
    await auditLog(makeReq({ ip: "1.2.3.4" }), "PATIENT_UPDATE", "Patient", "p-1", details);
    expect(auditCreate.mock.calls[0][0].data.details).toEqual(details);
  });
});

describe("auditLog — IP resolution", () => {
  it("uses x-forwarded-for first hop when header is set", async () => {
    await auditLog(
      makeReq({ headers: { "x-forwarded-for": "10.0.0.1, 10.0.0.2, 10.0.0.3" } }),
      "ACT",
      "E",
    );
    expect(auditCreate.mock.calls[0][0].data.ipAddress).toBe("10.0.0.1");
  });

  it("trims whitespace from the first x-forwarded-for hop", async () => {
    await auditLog(
      makeReq({ headers: { "x-forwarded-for": "  10.0.0.1  ,  10.0.0.2  " } }),
      "ACT",
      "E",
    );
    expect(auditCreate.mock.calls[0][0].data.ipAddress).toBe("10.0.0.1");
  });

  it("falls back to req.ip when x-forwarded-for is absent", async () => {
    await auditLog(makeReq({ ip: "192.168.1.1" }), "ACT", "E");
    expect(auditCreate.mock.calls[0][0].data.ipAddress).toBe("192.168.1.1");
  });

  it("writes ipAddress=null when neither header nor req.ip is available", async () => {
    await auditLog(makeReq(), "ACT", "E");
    expect(auditCreate.mock.calls[0][0].data.ipAddress).toBeNull();
  });

  it("falls back to req.ip when header is the array form (Express normalises duplicates)", async () => {
    // Express types `headers["x-forwarded-for"]` as `string | string[]`. The
    // helper guards on `typeof === 'string'`, so an array form falls through
    // to req.ip — document this contract.
    await auditLog(
      makeReq({
        headers: { "x-forwarded-for": ["10.0.0.1", "10.0.0.2"] },
        ip: "192.168.1.1",
      }),
      "ACT",
      "E",
    );
    expect(auditCreate.mock.calls[0][0].data.ipAddress).toBe("192.168.1.1");
  });
});

describe("auditLog — error propagation", () => {
  it("rejects when prisma.auditLog.create rejects (caller decides how to handle)", async () => {
    auditCreate.mockRejectedValueOnce(new Error("db down"));
    await expect(
      auditLog(makeReq({ ip: "1.2.3.4" }), "ACT", "E"),
    ).rejects.toThrow("db down");
  });
});

// ── Issue #456 — tenantId stamping ───────────────────────────────────────
describe("auditLog — tenantId resolution (Issue #456)", () => {
  it("stamps tenantId from the AsyncLocalStorage context when present", async () => {
    getTenantIdMock.mockReturnValueOnce("tenant-A");
    await auditLog(
      makeReq({ user: { userId: "u-1" }, ip: "1.2.3.4" }),
      "PATIENT_VIEW",
      "Patient",
      "p-1",
    );
    expect(auditCreate.mock.calls[0][0].data.tenantId).toBe("tenant-A");
  });

  it("falls back to req.tenantId when no ALS context is bound", async () => {
    getTenantIdMock.mockReturnValueOnce(undefined);
    const req = makeReq({ user: { userId: "u-1" }, ip: "1.2.3.4" });
    req.tenantId = "tenant-from-req";
    await auditLog(req, "ACT", "E");
    expect(auditCreate.mock.calls[0][0].data.tenantId).toBe("tenant-from-req");
  });

  it("writes tenantId=null and warns when neither source has a value (bootstrap path)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      getTenantIdMock.mockReturnValueOnce(undefined);
      await auditLog(makeReq({ ip: "1.2.3.4" }), "LOGIN_FAIL", "Auth");
      expect(auditCreate.mock.calls[0][0].data.tenantId).toBeNull();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toMatch(/tenantId missing/);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("prefers ALS context over req.tenantId when both are present", async () => {
    getTenantIdMock.mockReturnValueOnce("from-als");
    const req = makeReq({ user: { userId: "u-1" }, ip: "1.2.3.4" });
    req.tenantId = "from-req";
    await auditLog(req, "ACT", "E");
    expect(auditCreate.mock.calls[0][0].data.tenantId).toBe("from-als");
  });
});
