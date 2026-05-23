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
// Issues #708, #712 (May 2026): both /register and /forgot-password use the
// strict email-format refine. The global stripper would not normally touch a
// valid-looking email, but addresses like `<a@b.com>` (RFC 5322 angle-bracket
// form) get truncated by the tag stripper and silently re-formed into a string
// that passes the regex. Bypassing the global stripper for these auth paths
// keeps the schema's reject-not-mutate intent intact.
//
// Issue #616 (partial-XSS on Lab Add Result Unit): the lab `unit` field has
// a strict allowlist regex (LAB_UNIT_REGEX) but the global stripper was
// silently rewriting `<script>alert(1)</script>` to `alert(1)` BEFORE the
// schema ran, defeating the regex's reject-not-strip intent. Bypass the
// stripper for /api/v1/lab/results so the schema can reject angle-bracket
// payloads with a 400 instead of laundering them.
// Issue #577 (May 2026): /api/v1/complaints uses createComplaintSchema with
// containsHtmlOrScript refines on name / category / description. Without the
// bypass the global stripper turned `<script>alert(1)</script>` into
// `alert(1)` BEFORE the schema saw it, so the refine never fired and the
// laundered residue ended up in the DB.
//
// Issue #938 (2026-05-23): /api/v1/settings/branding rejects HTML in
// hospitalName + javascript: in logoUrl via updateBrandingSchema. The global
// stripper would launder `<script>alert(1)</script>` into `alert(1)` and the
// refines never fire — so bypass for the whole /settings tree.
//
// Issue #947 (2026-05-23): /api/v1/appointments (notably the threaded-remarks
// endpoint) gets clinical free-text. Per Pearl §2.2 we reject rather than
// silently strip so the clinician sees an explicit error instead of the
// payload getting laundered into the chart.
//
// Issue #954 (2026-05-23): /api/v1/prescriptions takes per-item `medicineName`
// which must reject HTML — the global stripper was laundering tags. Bypass
// the whole prescriptions tree so the schema-level refine fires.
const SCHEMA_REJECT_PATHS: readonly string[] = [
  "/api/v1/auth/register",
  "/api/v1/auth/forgot-password",
  "/api/v1/lab/results",
  "/api/v1/complaints",
  "/api/v1/settings/branding",
  "/api/v1/appointments",
  "/api/v1/prescriptions",
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
  // `req.path` is set by Express in production but tests sometimes mock the
  // request without it — fall back to empty string so the startsWith check
  // is a no-op (every SCHEMA_REJECT_PATH is non-empty), not a TypeError.
  const reqPath = req.path ?? "";
  if (SCHEMA_REJECT_PATHS.some((p) => reqPath === p || reqPath.startsWith(p + "/"))) {
    return next();
  }
  if (req.body && typeof req.body === "object") {
    req.body = stripHtmlTags(req.body);
  }
  next();
}
