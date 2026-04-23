import { describe, it, expect, vi, beforeEach } from "vitest";
import jwt from "jsonwebtoken";
import { Role } from "@medcore/shared";
import { authenticate, authorize } from "./auth";

function makeRes() {
  const res: any = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

const SECRET = "test-jwt-secret-do-not-use-in-prod";

beforeEach(() => {
  process.env.JWT_SECRET = SECRET;
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
});
