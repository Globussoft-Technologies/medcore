import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { Role, type AuthPayload } from "@medcore/shared";

// Re-export AuthPayload so downstream code that imports it from this module
// (pre-dating the shared-types refactor) keeps working.
export type { AuthPayload };

declare global {
  namespace Express {
    interface Request {
      user?: AuthPayload;
    }
  }
}

/**
 * Express middleware that verifies the auth JWT and populates `req.user`
 * with the decoded {@link AuthPayload}. Responds 401 when the token is
 * absent, invalid, or expired.
 *
 * **Issue #477 (May 2026):** access tokens moved from `localStorage` →
 * httpOnly `medcore_at` cookie. We accept both for the brief migration
 * window:
 *   - `req.cookies.medcore_at` (preferred — XSS-safe storage)
 *   - `Authorization: Bearer <token>` header (legacy — still supported
 *     so server-to-server callers, the e2e suite's `apiLogin`-and-pass-
 *     header pattern, and any rare integration-test fixture continue to
 *     work without rewrite)
 *
 * Browser clients (apps/web) send the cookie automatically once
 * `credentials: "include"` is set. The Bearer fallback is a strict
 * superset — when both are present, the cookie wins (more recent).
 *
 * Legacy tokens minted before the multi-tenant rollout do not carry a
 * `tenantId` claim — this middleware tolerates that and leaves `tenantId`
 * undefined. The tenant middleware treats absent tenant as pass-through.
 */
export function authenticate(req: Request, res: Response, next: NextFunction) {
  // Prefer cookie (XSS-safe path). Fall back to Authorization header for
  // server-to-server + legacy clients during the migration.
  const cookieToken = (req as Request & { cookies?: Record<string, string> })
    .cookies?.medcore_at;
  const header = req.headers.authorization;
  const headerToken = header?.startsWith("Bearer ")
    ? header.split(" ")[1]
    : undefined;
  const token = cookieToken || headerToken;
  if (!token) {
    res.status(401).json({ success: false, data: null, error: "Unauthorized" });
    return;
  }

  try {
    const decoded = jwt.verify(
      token,
      process.env.JWT_SECRET || "dev-secret"
    ) as Partial<AuthPayload> & { userId: string; email: string; role: Role };
    // Build the payload explicitly so `tenantId` is propagated when present
    // but stays `undefined` for legacy tokens. We do NOT want to force a
    // `null` here because that would hide the "legacy" signal from tenant.ts.
    const payload: AuthPayload = {
      userId: decoded.userId,
      email: decoded.email,
      role: decoded.role,
      ...(decoded.tenantId !== undefined ? { tenantId: decoded.tenantId } : {}),
      ...(decoded.jti ? { jti: decoded.jti } : {}),
    };
    req.user = payload;
    next();
  } catch {
    res.status(401).json({ success: false, data: null, error: "Invalid or expired token" });
  }
}

/**
 * Express middleware factory that restricts access to the given roles.
 * Must be used after {@link authenticate}. Responds 403 when the caller's
 * role is not in the allowed list.
 *
 * @param roles One or more {@link Role} values that are permitted to proceed.
 */
export function authorize(...roles: Role[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      res.status(401).json({ success: false, data: null, error: "Unauthorized" });
      return;
    }
    if (!roles.includes(req.user.role as Role)) {
      res.status(403).json({ success: false, data: null, error: "Forbidden" });
      return;
    }
    next();
  };
}
