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
import { tenantContextMiddleware } from "./tenant";

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
});

describe("tenantContextMiddleware — header override", () => {
  it("uses X-Tenant-Id when present, ignoring everything else", () => {
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
    tenantContextMiddleware(req, {} as any, next);
    expect(req.tenantId).toBe("header-tenant");
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("trims whitespace around the header value", () => {
    const req = makeReq({ headers: { "X-Tenant-Id": "  spaced-tenant  " } });
    const next = vi.fn();
    tenantContextMiddleware(req, {} as any, next);
    expect(req.tenantId).toBe("spaced-tenant");
  });

  it("ignores empty / whitespace-only header and falls through", () => {
    const req = makeReq({ headers: { "X-Tenant-Id": "   " } });
    const next = vi.fn();
    tenantContextMiddleware(req, {} as any, next);
    expect(req.tenantId).toBeUndefined();
    expect(next).toHaveBeenCalledTimes(1);
  });
});

describe("tenantContextMiddleware — req.user fallback", () => {
  it("uses req.user.tenantId when authenticate already ran", () => {
    const req = makeReq({
      user: { userId: "u1", email: "a@b.c", role: Role.DOCTOR, tenantId: "user-tenant" },
    });
    const next = vi.fn();
    tenantContextMiddleware(req, {} as any, next);
    expect(req.tenantId).toBe("user-tenant");
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("prefers req.user.tenantId over JWT bearer when both present", () => {
    const token = jwt.sign(
      { userId: "u1", email: "a@b.c", role: Role.ADMIN, tenantId: "jwt-tenant" },
      SECRET,
    );
    const req = makeReq({
      headers: { Authorization: `Bearer ${token}` },
      user: { userId: "u1", email: "a@b.c", role: Role.ADMIN, tenantId: "user-tenant" },
    });
    const next = vi.fn();
    tenantContextMiddleware(req, {} as any, next);
    expect(req.tenantId).toBe("user-tenant");
  });
});

describe("tenantContextMiddleware — JWT decode fallback", () => {
  it("decodes the bearer token when neither header nor req.user is present", () => {
    const token = jwt.sign(
      { userId: "u1", email: "a@b.c", role: Role.ADMIN, tenantId: "jwt-tenant" },
      SECRET,
    );
    const req = makeReq({ headers: { Authorization: `Bearer ${token}` } });
    const next = vi.fn();
    tenantContextMiddleware(req, {} as any, next);
    expect(req.tenantId).toBe("jwt-tenant");
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("leaves tenantId undefined for a malformed bearer token (silent)", () => {
    const req = makeReq({ headers: { Authorization: "Bearer not.a.real.jwt" } });
    const next = vi.fn();
    tenantContextMiddleware(req, {} as any, next);
    expect(req.tenantId).toBeUndefined();
    // Critical: middleware MUST still call next so unauthenticated/cross-tenant
    // routes (e.g. /api/health) work. Auth enforcement is downstream.
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("leaves tenantId undefined for an expired bearer token", () => {
    const token = jwt.sign(
      { userId: "u1", email: "a@b.c", role: Role.ADMIN, tenantId: "jwt-tenant" },
      SECRET,
      { expiresIn: "-1s" },
    );
    const req = makeReq({ headers: { Authorization: `Bearer ${token}` } });
    const next = vi.fn();
    tenantContextMiddleware(req, {} as any, next);
    expect(req.tenantId).toBeUndefined();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("leaves tenantId undefined when the JWT carries no tenantId claim", () => {
    const token = jwt.sign(
      { userId: "u1", email: "a@b.c", role: Role.ADMIN }, // no tenantId
      SECRET,
    );
    const req = makeReq({ headers: { Authorization: `Bearer ${token}` } });
    const next = vi.fn();
    tenantContextMiddleware(req, {} as any, next);
    expect(req.tenantId).toBeUndefined();
  });

  it("ignores Authorization headers that aren't 'Bearer <token>'", () => {
    const req = makeReq({ headers: { Authorization: "Basic dXNlcjpwYXNz" } });
    const next = vi.fn();
    tenantContextMiddleware(req, {} as any, next);
    expect(req.tenantId).toBeUndefined();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("rejects tokens signed with the wrong secret", () => {
    const token = jwt.sign(
      { userId: "u1", email: "a@b.c", role: Role.ADMIN, tenantId: "evil-tenant" },
      "different-secret",
    );
    const req = makeReq({ headers: { Authorization: `Bearer ${token}` } });
    const next = vi.fn();
    tenantContextMiddleware(req, {} as any, next);
    expect(req.tenantId).toBeUndefined();
    expect(next).toHaveBeenCalledTimes(1);
  });
});

describe("tenantContextMiddleware — pass-through", () => {
  it("calls next() with no tenantId on an unauthenticated request", () => {
    const req = makeReq();
    const next = vi.fn();
    tenantContextMiddleware(req, {} as any, next);
    expect(req.tenantId).toBeUndefined();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("never calls res.status/res.json — enforcement is downstream", () => {
    const req = makeReq();
    const res: any = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    };
    const next = vi.fn();
    tenantContextMiddleware(req, res, next);
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });
});

describe("tenantContextMiddleware — resolution-order precedence", () => {
  it("header > req.user > JWT (header wins)", () => {
    const token = jwt.sign(
      { userId: "u1", email: "a@b.c", role: Role.ADMIN, tenantId: "jwt-tenant" },
      SECRET,
    );
    const req = makeReq({
      headers: { "X-Tenant-Id": "header-tenant", Authorization: `Bearer ${token}` },
      user: { userId: "u1", email: "a@b.c", role: Role.ADMIN, tenantId: "user-tenant" },
    });
    const next = vi.fn();
    tenantContextMiddleware(req, {} as any, next);
    expect(req.tenantId).toBe("header-tenant");
  });

  it("req.user beats JWT when header is absent", () => {
    const token = jwt.sign(
      { userId: "u1", email: "a@b.c", role: Role.ADMIN, tenantId: "jwt-tenant" },
      SECRET,
    );
    const req = makeReq({
      headers: { Authorization: `Bearer ${token}` },
      user: { userId: "u1", email: "a@b.c", role: Role.ADMIN, tenantId: "user-tenant" },
    });
    const next = vi.fn();
    tenantContextMiddleware(req, {} as any, next);
    expect(req.tenantId).toBe("user-tenant");
  });
});
