import { Request, Response, NextFunction } from "express";

function stripHtmlTags(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replace(/<[^>]*>/g, "");
  }
  if (Array.isArray(value)) {
    return value.map(stripHtmlTags);
  }
  if (value !== null && typeof value === "object") {
    const cleaned: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      cleaned[key] = stripHtmlTags(val);
    }
    return cleaned;
  }
  return value;
}

export function sanitize(req: Request, _res: Response, next: NextFunction) {
  if (req.body && typeof req.body === "object") {
    req.body = stripHtmlTags(req.body);
  }
  next();
}
