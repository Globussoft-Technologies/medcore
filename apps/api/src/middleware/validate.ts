import { Request, Response, NextFunction } from "express";
import { ZodError, ZodSchema } from "zod";

/**
 * Express middleware factory that parses and validates `req.body` against a
 * Zod schema, replacing the body with the parsed (and transformed) value on
 * success. Passes a `ZodError` to `next()` on failure so {@link errorHandler}
 * can format the 400 response.
 *
 * @param schema Zod schema to validate the request body against.
 */
export function validate(schema: ZodSchema) {
  return (req: Request, _res: Response, next: NextFunction) => {
    try {
      req.body = schema.parse(req.body);
      next();
    } catch (err) {
      // Log the exact failing field(s) + endpoint so a 400 isn't a black box
      // during debugging (the client only sees a generic "Bad Request").
      if (err instanceof ZodError) {
        console.error(
          `[validate] ${req.method} ${req.originalUrl} → 400:`,
          err.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
        );
      }
      next(err);
    }
  };
}
