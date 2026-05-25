/**
 * Unit tests for `tenantContextMiddleware`.
 *
 * Highest-risk gap in the codebase per docs/TEST_PLAN.md §7.1: a bug in this
 * middleware is a PHI cross-tenant leak. We exercise every resolution branch:
 *   1. `X-Tenant-Id` header explicit override (highest precedence).
 *   2. `req.user.tenantId` (set by `authenticate` if it ran first).
 *   3. JWT decode fallback when neither of the above is present.
 *   4. Pass-through (`req.tenantId` left undefined) so global mounting is safe.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import jwt from "jsonwebtoken";
import { Role } from "@medcore/shared";

// security(2026-05-04): A9 — middleware now validates the resolved
// tenantId against a cached `prisma.tenant.findUnique` lookup. Mocking
// the DB up front lets every existing test that doesn't care about
// validation just hit the happy path (valid + active), while the new
// A9 cases drive specific verdicts via `mockResolvedValueOnce`.
const { findUniqueMock } = vi.hoisted(() => {
  type TenantRow = { id: string; active: boolean } | null;
  return {
    findUniqueMock: vi.fn<(args: unknown) => Promise<TenantRow>>(
      async () => ({ id: "default", active: true }),
    ),
  };
});
vi.mock("@medcore/db", () => ({
  getTenantId: () => undefined,
  runWithTenant: (_t: string, fn: () => unknown) => fn(),
  requireTenantId: () => { throw new Error("tenant ctx required"); },
  // Pearl ERP §8.2 (gap row 209, 2026-05-24): platform-role allow-list
  // bypass. The real implementation lives in `@medcore/db`; here we
  // mirror the contract — `true` for the 2 platform roles, `false`
  // otherwise — so the middleware's short-circuit branch can be
  // exercised without pulling in the whole Prisma client.
  isPlatformRole: (role: string | undefined | null) =>
    role === "PLATFORM_OPERATOR" || role === "PLATFORM_BILLING_OPERATOR",
  PLATFORM_ROLES: new Set(["PLATFORM_OPERATOR", "PLATFORM_BILLING_OPERATOR"]),
  prisma: {
    tenant: { findUnique: findUniqueMock },
  },
  tenantScopedPrisma: {
    tenant: { findUnique: findUniqueMock },
  },
}));

import {
  tenantContextMiddleware,
  __resetTenantValidationCacheForTests,
} from "./tenant";

const SECRET = "test-jwt-secret-do-not-use-in-prod";

function makeReq(overrides: Partial<{
  headers: Record<string, string>;
  user: unknown;
}> = {}): any {
  const headers = overrides.headers ?? {};
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return {
    headers: lower,
    user: overrides.user,
    header(name: string) {
      return lower[name.toLowerCase()];
    },
  };
}

beforeEach(() => {
  process.env.JWT_SECRET = SECRET;
  __resetTenantValidationCacheForTests();
  findUniqueMock.mockReset();
  findUniqueMock.mockImplementation(async () => ({ id: "default", active: true }));
});

describe("tenantContextMiddleware — header override", () => {
  it("uses X-Tenant-Id when present, ignoring everything else", async () => {
    const req = makeReq({
      headers: {
        "X-Tenant-Id": "header-tenant",
        Authorization: `Bearer ${jwt.sign(
          { userId: "u1", email: "a@b.c", role: Role.ADMIN, tenantId: "jwt-tenant" },
          SECRET,
        )}`,
      },
      user: { userId: "u1", email: "a@b.c", role: Role.ADMIN, tenantId: "user-tenant" },
    });
    const next = vi.fn();
    await tenantContextMiddleware(req, {} as any, next);
    expect(req.tenantId).toBe("header-tenant");
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("trims whitespace around the header value", async () => {
    const req = makeReq({ headers: { "X-Tenant-Id": "  spaced-tenant  " } });
    const next = vi.fn();
    await tenantContextMiddleware(req, {} as any, next);
    expect(req.tenantId).toBe("spaced-tenant");
  });

  it("ignores empty / whitespace-only header and falls through", async () => {
    const req = makeReq({ headers: { "X-Tenant-Id": "   " } });
    const next = vi.fn();
    await tenantContextMiddleware(req, {} as any, next);
    expect(req.tenantId).toBeUndefined();
    expect(next).toHaveBeenCalledTimes(1);
  });
});

describe("tenantContextMiddleware — req.user fallback", () => {
  it("uses req.user.tenantId when authenticate already ran", async () => {
    const req = makeReq({
      user: { userId: "u1", email: "a@b.c", role: Role.DOCTOR, tenantId: "user-tenant" },
    });
    const next = vi.fn();
    await tenantContextMiddleware(req, {} as any, next);
    expect(req.tenantId).toBe("user-tenant");
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("prefers req.user.tenantId over JWT bearer when both present", async () => {
    const token = jwt.sign(
      { userId: "u1", email: "a@b.c", role: Role.ADMIN, tenantId: "jwt-tenant" },
      SECRET,
    );
    const req = makeReq({
      headers: { Authorization: `Bearer ${token}` },
      user: { userId: "u1", email: "a@b.c", role: Role.ADMIN, tenantId: "user-tenant" },
    });
    const next = vi.fn();
    await tenantContextMiddleware(req, {} as any, next);
    expect(req.tenantId).toBe("user-tenant");
  });
});

describe("tenantContextMiddleware — JWT decode fallback", () => {
  it("decodes the bearer token when neither header nor req.user is present", async () => {
    const token = jwt.sign(
      { userId: "u1", email: "a@b.c", role: Role.ADMIN, tenantId: "jwt-tenant" },
      SECRET,
    );
    const req = makeReq({ headers: { Authorization: `Bearer ${token}` } });
    const next = vi.fn();
    await tenantContextMiddleware(req, {} as any, next);
    expect(req.tenantId).toBe("jwt-tenant");
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("leaves tenantId undefined for a malformed bearer token (silent)", async () => {
    const req = makeReq({ headers: { Authorization: "Bearer not.a.real.jwt" } });
    const next = vi.fn();
    await tenantContextMiddleware(req, {} as any, next);
    expect(req.tenantId).toBeUndefined();
    // Critical: middleware MUST still call next so unauthenticated/cross-tenant
    // routes (e.g. /api/health) work. Auth enforcement is downstream.
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("leaves tenantId undefined for an expired bearer token", async () => {
    const token = jwt.sign(
      { userId: "u1", email: "a@b.c", role: Role.ADMIN, tenantId: "jwt-tenant" },
      SECRET,
      { expiresIn: "-1s" },
    );
    const req = makeReq({ headers: { Authorization: `Bearer ${token}` } });
    const next = vi.fn();
    await tenantContextMiddleware(req, {} as any, next);
    expect(req.tenantId).toBeUndefined();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("leaves tenantId undefined when the JWT carries no tenantId claim", async () => {
    const token = jwt.sign(
      { userId: "u1", email: "a@b.c", role: Role.ADMIN }, // no tenantId
      SECRET,
    );
    const req = makeReq({ headers: { Authorization: `Bearer ${token}` } });
    const next = vi.fn();
    await tenantContextMiddleware(req, {} as any, next);
    expect(req.tenantId).toBeUndefined();
  });

  it("ignores Authorization headers that aren't 'Bearer <token>'", async () => {
    const req = makeReq({ headers: { Authorization: "Basic dXNlcjpwYXNz" } });
    const next = vi.fn();
    await tenantContextMiddleware(req, {} as any, next);
    expect(req.tenantId).toBeUndefined();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("rejects tokens signed with the wrong secret", async () => {
    const token = jwt.sign(
      { userId: "u1", email: "a@b.c", role: Role.ADMIN, tenantId: "evil-tenant" },
      "different-secret",
    );
    const req = makeReq({ headers: { Authorization: `Bearer ${token}` } });
    const next = vi.fn();
    await tenantContextMiddleware(req, {} as any, next);
    expect(req.tenantId).toBeUndefined();
    expect(next).toHaveBeenCalledTimes(1);
  });
});

describe("tenantContextMiddleware — pass-through", () => {
  it("calls next() with no tenantId on an unauthenticated request", async () => {
    const req = makeReq();
    const next = vi.fn();
    await tenantContextMiddleware(req, {} as any, next);
    expect(req.tenantId).toBeUndefined();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("never calls res.status/res.json — enforcement is downstream", async () => {
    const req = makeReq();
    const res: any = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    };
    const next = vi.fn();
    await tenantContextMiddleware(req, res, next);
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });
});

describe("tenantContextMiddleware — resolution-order precedence", () => {
  it("header > req.user > JWT (header wins)", async () => {
    const token = jwt.sign(
      { userId: "u1", email: "a@b.c", role: Role.ADMIN, tenantId: "jwt-tenant" },
      SECRET,
    );
    const req = makeReq({
      headers: { "X-Tenant-Id": "header-tenant", Authorization: `Bearer ${token}` },
      user: { userId: "u1", email: "a@b.c", role: Role.ADMIN, tenantId: "user-tenant" },
    });
    const next = vi.fn();
    await tenantContextMiddleware(req, {} as any, next);
    expect(req.tenantId).toBe("header-tenant");
  });

  it("req.user beats JWT when header is absent", async () => {
    const token = jwt.sign(
      { userId: "u1", email: "a@b.c", role: Role.ADMIN, tenantId: "jwt-tenant" },
      SECRET,
    );
    const req = makeReq({
      headers: { Authorization: `Bearer ${token}` },
      user: { userId: "u1", email: "a@b.c", role: Role.ADMIN, tenantId: "user-tenant" },
    });
    const next = vi.fn();
    await tenantContextMiddleware(req, {} as any, next);
    expect(req.tenantId).toBe("user-tenant");
  });
});

// security(2026-05-04): A9 — every test in this block exercises the
// existence/active validation step that runs after the resolution chain
// picks a candidate tenantId. The mock from the top of the file is
// reset per `beforeEach`; individual tests override it with
// `mockResolvedValueOnce` to drive the verdict they care about.
describe("tenantContextMiddleware — A9 tenant validation", () => {
  it("drops a header-supplied tenantId that doesn't exist in the DB", async () => {
    findUniqueMock.mockResolvedValueOnce(null);
    const req = makeReq({ headers: { "X-Tenant-Id": "ghost-tenant" } });
    const next = vi.fn();
    await tenantContextMiddleware(req, {} as any, next);
    expect(req.tenantId).toBeUndefined();
    expect(next).toHaveBeenCalledTimes(1);
    expect(findUniqueMock).toHaveBeenCalledWith({
      where: { id: "ghost-tenant" },
      select: { id: true, active: true },
    });
  });

  it("drops a JWT-supplied tenantId pointing at a deactivated tenant", async () => {
    findUniqueMock.mockResolvedValueOnce({ id: "deactivated", active: false });
    const token = jwt.sign(
      { userId: "u1", email: "a@b.c", role: Role.ADMIN, tenantId: "deactivated" },
      SECRET,
    );
    const req = makeReq({ headers: { Authorization: `Bearer ${token}` } });
    const next = vi.fn();
    await tenantContextMiddleware(req, {} as any, next);
    expect(req.tenantId).toBeUndefined();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("commits a candidate that exists and is active", async () => {
    findUniqueMock.mockResolvedValueOnce({ id: "real-tenant", active: true });
    const req = makeReq({ headers: { "X-Tenant-Id": "real-tenant" } });
    const next = vi.fn();
    await tenantContextMiddleware(req, {} as any, next);
    expect(req.tenantId).toBe("real-tenant");
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("caches the verdict — a second call with the same id does not re-query", async () => {
    findUniqueMock.mockResolvedValueOnce({ id: "real-tenant", active: true });
    const next1 = vi.fn();
    await tenantContextMiddleware(
      makeReq({ headers: { "X-Tenant-Id": "real-tenant" } }),
      {} as any,
      next1,
    );
    const next2 = vi.fn();
    await tenantContextMiddleware(
      makeReq({ headers: { "X-Tenant-Id": "real-tenant" } }),
      {} as any,
      next2,
    );
    // Cache hit — only the first request hit Prisma.
    expect(findUniqueMock).toHaveBeenCalledTimes(1);
    expect(next1).toHaveBeenCalledTimes(1);
    expect(next2).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the DB throws (transient blip → drop the tenantId)", async () => {
    findUniqueMock.mockRejectedValueOnce(new Error("connection refused"));
    const req = makeReq({ headers: { "X-Tenant-Id": "real-tenant" } });
    const next = vi.fn();
    await tenantContextMiddleware(req, {} as any, next);
    expect(req.tenantId).toBeUndefined();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("does NOT roundtrip when no candidate is resolved (no JWT, no header)", async () => {
    const req = makeReq();
    const next = vi.fn();
    await tenantContextMiddleware(req, {} as any, next);
    expect(req.tenantId).toBeUndefined();
    expect(findUniqueMock).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
  });
});

// Pearl ERP §8.2 (gap row 209, 2026-05-24): platform-role bypass. The
// middleware MUST leave req.tenantId undefined and NOT call findUnique
// when the caller's role is one of PLATFORM_OPERATOR /
// PLATFORM_BILLING_OPERATOR — these users carry `tenantId = null` and
// act across tenants by design. The short-circuit also overrides an
// otherwise-valid X-Tenant-Id header so a super-admin can't accidentally
// pin themselves to one tenant's view across multiple requests.
describe("tenantContextMiddleware — Pearl §8.2 platform-role bypass", () => {
  it("leaves req.tenantId undefined for PLATFORM_OPERATOR (req.user path)", async () => {
    const req = makeReq({
      user: { userId: "u1", email: "ops@onviqa.com", role: "PLATFORM_OPERATOR", tenantId: undefined },
    });
    const next = vi.fn();
    await tenantContextMiddleware(req, {} as any, next);
    expect(req.tenantId).toBeUndefined();
    expect(findUniqueMock).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("leaves req.tenantId undefined for PLATFORM_BILLING_OPERATOR (JWT path)", async () => {
    const token = jwt.sign(
      { userId: "u1", email: "finance@onviqa.com", role: "PLATFORM_BILLING_OPERATOR" },
      SECRET,
    );
    const req = makeReq({ headers: { Authorization: `Bearer ${token}` } });
    const next = vi.fn();
    await tenantContextMiddleware(req, {} as any, next);
    expect(req.tenantId).toBeUndefined();
    expect(findUniqueMock).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("ignores X-Tenant-Id header when the caller is a platform role", async () => {
    // A super-admin curl-ing with `-H 'X-Tenant-Id: tenant-A'` MUST NOT
    // get pinned to tenant-A; the platform-role bypass takes priority.
    const token = jwt.sign(
      { userId: "u1", email: "ops@onviqa.com", role: "PLATFORM_OPERATOR" },
      SECRET,
    );
    const req = makeReq({
      headers: { "X-Tenant-Id": "tenant-A", Authorization: `Bearer ${token}` },
    });
    const next = vi.fn();
    await tenantContextMiddleware(req, {} as any, next);
    expect(req.tenantId).toBeUndefined();
    expect(findUniqueMock).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("does NOT bypass for tenant-scoped roles (ADMIN still resolves tenant)", async () => {
    findUniqueMock.mockResolvedValueOnce({ id: "real-tenant", active: true });
    const req = makeReq({
      user: { userId: "u1", email: "a@b.c", role: "ADMIN", tenantId: "real-tenant" },
    });
    const next = vi.fn();
    await tenantContextMiddleware(req, {} as any, next);
    expect(req.tenantId).toBe("real-tenant");
    expect(findUniqueMock).toHaveBeenCalledTimes(1);
  });
});
