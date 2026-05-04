import { Request, Response, NextFunction } from "express";

// Routes whose schema enforces a stricter "reject raw HTML" contract via
// `containsHtmlOrScript` (e.g. `registerSchema.refine(...)` for #489 XSS-in-
// name). For those paths, the body must reach the schema validator unmutated
// so the refine fires and the request 400s. Stripping silently before
// validation defeats the schema's reject-not-strip intent.
//
// Other routes (e.g. emergency clinical notes — issue #424) intentionally
// rely on tag-stripping so a careless `<script>` paste doesn't blow up the
// renderer. We keep stripping the default and opt OUT of it for the few
// routes whose schema does explicit rejection.
const SCHEMA_REJECT_PATHS: readonly string[] = [
  "/api/v1/auth/register",
];

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
  // Bypass for paths whose schema explicitly rejects raw HTML (#489).
  if (SCHEMA_REJECT_PATHS.some((p) => req.path === p || req.path.startsWith(p + "/"))) {
    return next();
  }
  if (req.body && typeof req.body === "object") {
    req.body = stripHtmlTags(req.body);
  }
  next();
}
