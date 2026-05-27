import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import jwt from "jsonwebtoken";
import { Role } from "@medcore/shared";
import { authenticate, authorize, isAdminLike } from "./auth";
// Issue #482: services/jwt.ts caches getJwtConfig() at module scope. Under
// vitest's singleFork: true the cache survives across files, so we MUST
// reset it after every case that mutates env vars (per CLAUDE.md test-infra
// gotcha #2). Also clear any RS256/dual-verify state another test file
// might have left behind so this suite stays on the HS256 default path.
import { __resetJwtConfigForTests } from "../services/jwt";

function makeRes() {
  const res: any = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

const SECRET = "test-jwt-secret-do-not-use-in-prod";

beforeEach(() => {
  // Wipe any RS256 / dual-verify env vars another test may have set.
  delete process.env.JWT_ALG;
  delete process.env.JWT_PRIVATE_KEY;
  delete process.env.JWT_PUBLIC_KEY;
  delete process.env.JWT_DUAL_VERIFY_HS256_FALLBACK;
  process.env.JWT_SECRET = SECRET;
  __resetJwtConfigForTests();
});

afterEach(() => {
  __resetJwtConfigForTests();
});

describe("authenticate", () => {
  it("responds 401 when Authorization header is missing", () => {
    const req: any = { headers: {} };
    const res = makeRes();
    const next = vi.fn();
    authenticate(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, error: "Unauthorized" })
    );
    expect(next).not.toHaveBeenCalled();
  });

  it("responds 401 when header does not start with 'Bearer '", () => {
    const req: any = { headers: { authorization: "Basic abc" } };
    const res = makeRes();
    const next = vi.fn();
    authenticate(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("responds 401 with 'Invalid or expired token' for garbage token", () => {
    const req: any = { headers: { authorization: "Bearer garbage.garbage.garbage" } };
    const res = makeRes();
    const next = vi.fn();
    authenticate(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: "Invalid or expired token" })
    );
  });

  it("responds 401 for an expired token", () => {
    const token = jwt.sign(
      { userId: "u1", email: "a@b.c", role: Role.ADMIN },
      SECRET,
      { expiresIn: "-1s" }
    );
    const req: any = { headers: { authorization: `Bearer ${token}` } };
    const res = makeRes();
    const next = vi.fn();
    authenticate(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("attaches decoded payload to req.user and calls next for valid token", () => {
    const token = jwt.sign(
      { userId: "u1", email: "a@b.c", role: Role.DOCTOR },
      SECRET
    );
    const req: any = { headers: { authorization: `Bearer ${token}` } };
    const res = makeRes();
    const next = vi.fn();
    authenticate(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(req.user).toMatchObject({
      userId: "u1",
      email: "a@b.c",
      role: Role.DOCTOR,
    });
    expect(res.status).not.toHaveBeenCalled();
  });
});

describe("authorize", () => {
  it("responds 401 when req.user is missing (authenticate not run)", () => {
    const mw = authorize(Role.ADMIN);
    const req: any = { headers: {} };
    const res = makeRes();
    const next = vi.fn();
    mw(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("calls next() when user role is in allowed list", () => {
    const mw = authorize(Role.ADMIN, Role.DOCTOR);
    const req: any = { user: { userId: "u", email: "e", role: Role.DOCTOR } };
    const res = makeRes();
    const next = vi.fn();
    mw(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it("responds 403 when user role is not allowed", () => {
    const mw = authorize(Role.ADMIN);
    const req: any = { user: { userId: "u", email: "e", role: Role.PATIENT } };
    const res = makeRes();
    const next = vi.fn();
    mw(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: "Forbidden" })
    );
    expect(next).not.toHaveBeenCalled();
  });

  it("accepts multiple roles and allows any match", () => {
    const mw = authorize(Role.NURSE, Role.RECEPTION, Role.ADMIN);
    const req: any = { user: { userId: "u", email: "e", role: Role.RECEPTION } };
    const res = makeRes();
    const next = vi.fn();
    mw(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  // ─── Pearl §8.2 — SUPER_ADMIN mirrors ADMIN exactly ────────────────
  //
  // The contract: SUPER_ADMIN passes any authorize() check that includes
  // ADMIN in its allowlist, and is blocked from any check that does NOT
  // include ADMIN. This is the "if some access is not having for admin
  // those access dont give to the super admin as well" rule the operator
  // explicitly requested — SUPER_ADMIN is never a wildcard root, just an
  // exact mirror of ADMIN's scope.

  it("allows SUPER_ADMIN when ADMIN is in the allowlist (Pearl §8.2)", () => {
    const mw = authorize(Role.ADMIN, Role.DOCTOR);
    const req: any = {
      user: { userId: "u", email: "e", role: "SUPER_ADMIN" as Role },
    };
    const res = makeRes();
    const next = vi.fn();
    mw(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it("allows SUPER_ADMIN on an ADMIN-only route (Pearl §8.2)", () => {
    const mw = authorize(Role.ADMIN);
    const req: any = {
      user: { userId: "u", email: "e", role: "SUPER_ADMIN" as Role },
    };
    const res = makeRes();
    const next = vi.fn();
    mw(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("REJECTS SUPER_ADMIN when ADMIN is NOT in the allowlist (Pearl §8.2 mirror rule)", () => {
    // DOCTOR-only and NURSE-only routes do not grant ADMIN access. By the
    // mirror rule, SUPER_ADMIN must also be blocked — otherwise SUPER_ADMIN
    // would have MORE access than ADMIN, which the operator forbade.
    const mw = authorize(Role.DOCTOR, Role.NURSE);
    const req: any = {
      user: { userId: "u", email: "e", role: "SUPER_ADMIN" as Role },
    };
    const res = makeRes();
    const next = vi.fn();
    mw(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("REJECTS SUPER_ADMIN on a PATIENT-only route (Pearl §8.2 mirror rule)", () => {
    const mw = authorize(Role.PATIENT);
    const req: any = {
      user: { userId: "u", email: "e", role: "SUPER_ADMIN" as Role },
    };
    const res = makeRes();
    const next = vi.fn();
    mw(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
  });
});

describe("isAdminLike", () => {
  it("returns true for Role.ADMIN", () => {
    expect(isAdminLike(Role.ADMIN)).toBe(true);
  });

  it("returns true for Role.SUPER_ADMIN", () => {
    expect(isAdminLike("SUPER_ADMIN")).toBe(true);
  });

  it("returns false for other roles", () => {
    expect(isAdminLike(Role.DOCTOR)).toBe(false);
    expect(isAdminLike(Role.NURSE)).toBe(false);
    expect(isAdminLike(Role.RECEPTION)).toBe(false);
    expect(isAdminLike(Role.PATIENT)).toBe(false);
    expect(isAdminLike(Role.PHARMACIST)).toBe(false);
    expect(isAdminLike(Role.LAB_TECH)).toBe(false);
  });

  it("returns false for null/undefined inputs", () => {
    expect(isAdminLike(null)).toBe(false);
    expect(isAdminLike(undefined)).toBe(false);
  });

  it("accepts an Express Request and reads req.user.role", () => {
    expect(isAdminLike({ user: { role: Role.ADMIN } } as never)).toBe(true);
    expect(isAdminLike({ user: { role: "SUPER_ADMIN" } } as never)).toBe(true);
    expect(isAdminLike({ user: { role: Role.DOCTOR } } as never)).toBe(false);
    expect(isAdminLike({} as never)).toBe(false);
  });
});
