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

const { auditCreate } = vi.hoisted(() => ({ auditCreate: vi.fn() }));

vi.mock("@medcore/db", () => ({
  prisma: { auditLog: { create: auditCreate } },
}));

import { auditLog } from "./audit";

beforeEach(() => {
  auditCreate.mockReset();
  auditCreate.mockResolvedValue(undefined);
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
