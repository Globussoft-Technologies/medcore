// security(2026-04-23-med): reusable path-param validators so route handlers
// stop passing un-shaped `:id` / `:patientId` / `:sessionId` strings straight
// into `prisma.findUnique` (which produces a P2023 Prisma error instead of a
// clean 400 and leaks schema shape in the error message).
//
// Usage:
//   router.get("/:id", validateUuidParams(["id"]), handler)
//
// If validation fails the middleware short-circuits with a 400 envelope that
// matches the rest of the API (`{ success, data: null, error }`).
import { Request, Response, NextFunction } from "express";
import { z } from "zod";

const uuidSchema = z.string().uuid();

/**
 * Express middleware factory that asserts one or more `req.params.*` keys are
 * valid UUIDs. Missing keys are treated as invalid too — this middleware
 * should only be mounted on routes that actually declare those params.
 */
export function validateUuidParams(paramNames: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    for (const name of paramNames) {
      const value = req.params[name];
      if (!uuidSchema.safeParse(value).success) {
        res.status(400).json({
          success: false,
          data: null,
          error: `Invalid ${name}: expected a UUID`,
        });
        return;
      }
    }
    next();
  };
}
