import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { Role } from "@medcore/shared";

/** The decoded JWT payload attached to every authenticated request as `req.user`. */
export interface AuthPayload {
  userId: string;
  email: string;
  role: Role;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthPayload;
    }
  }
}

/**
 * Express middleware that verifies the `Authorization: Bearer <token>` header
 * and populates `req.user` with the decoded {@link AuthPayload}. Responds 401
 * when the header is absent or the token is invalid/expired.
 */
export function authenticate(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    res.status(401).json({ success: false, data: null, error: "Unauthorized" });
    return;
  }

  const token = header.split(" ")[1];
  try {
    const payload = jwt.verify(
      token,
      process.env.JWT_SECRET || "dev-secret"
    ) as AuthPayload;
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
