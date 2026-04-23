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

  res.status(500).json({
    success: false,
    data: null,
    error: process.env.NODE_ENV === "production"
      ? "Internal server error"
      : err.message,
  });
}
