import { Request, Response, NextFunction } from "express";
import { ZodError } from "zod";

/**
 * Central Express error-handling middleware. Maps `ZodError` to HTTP 400 with
 * structured field-level messages; all other errors become HTTP 500.
 * In production the original error message is hidden from the response.
 */
export function errorHandler(
  err: Error,
  _req: Request,
  res: Response,
  _next: NextFunction
) {
  console.error("Error:", err);

  if (err instanceof ZodError) {
    res.status(400).json({
      success: false,
      data: null,
      error: "Validation failed",
      details: err.errors.map((e) => ({
        field: e.path.join("."),
        message: e.message,
      })),
    });
    return;
  }

  // Surface Prisma error code + the model/operation context even in
  // production. The message itself is generic ("Internal server error")
  // so we don't leak schema or query strings, but the code (P2002,
  // P2003, etc.) and the meta target tell a debugger which constraint
  // fired. Without this, demo 500s are unreachable without SSH access
  // to PM2 logs — every route bug becomes a "look in the API server
  // logs" hunt.
  type PrismaLikeError = {
    code?: string;
    meta?: Record<string, unknown>;
    name?: string;
  };
  const e = err as PrismaLikeError;
  const isPrismaError =
    typeof e.code === "string" && /^P\d{4}$/.test(e.code);
  res.status(500).json({
    success: false,
    data: null,
    error:
      process.env.NODE_ENV === "production" ? "Internal server error" : err.message,
    ...(isPrismaError
      ? { prismaCode: e.code, prismaMeta: e.meta ?? null }
      : {}),
  });
}
