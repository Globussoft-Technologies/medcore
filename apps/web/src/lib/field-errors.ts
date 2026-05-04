/**
 * Helpers for surfacing per-field zod validation errors returned by the
 * MedCore API.
 *
 * The backend (apps/api/src/middleware/error.ts) maps `ZodError` to:
 *   { error: "Validation failed", details: [{ field, message }] }
 *
 * `extractFieldErrors` turns that flat list into a `{ field: message }` map
 * that pages can consume to render `<p data-testid="error-foo">…</p>` hints
 * below each input. If the error wasn't a validation error, returns null so
 * the caller can fall back to a generic toast.
 *
 * Issues #487 / #490 (May 2026): the API serialises raw Zod messages, which
 * leak Zod-internal language ("Required", "Invalid uuid", "Expected string,
 * received number") to clinicians. Two specific bugs:
 *
 *   #487 — every Zod issue with no override message defaults to "Required",
 *          so a wrong-shape value (e.g. number where string is expected) was
 *          rendered as "X is required" even though the user *did* type a
 *          value. We now distinguish "value missing" from "value wrong type"
 *          by inspecting the message text and only fall back to "required"
 *          when the message really means missing.
 *
 *   #490 — `z.string().uuid()` produces "Invalid uuid", which the prescription
 *          form was wrapping into "Patient ID must be a valid UUID". UUIDs
 *          are an implementation detail that should never reach a clinician.
 *          We rewrite anything mentioning "uuid" to "Invalid selection" so
 *          callers can override with a context-specific phrase like
 *          "Please select a patient" if they want.
 *
 * The humanisation lives in `humanizeZodMessage`, exported separately so
 * pages that compose their own per-field errors (prescriptions, walk-in,
 * ambulance) can reuse it instead of pattern-matching strings inline.
 */
export interface ApiErrorLike {
  payload?: unknown;
  message?: string;
  status?: number;
}

export type FieldErrorMap = Record<string, string>;

/**
 * Map a single raw Zod issue message into clinician-facing copy.
 *
 * The mapping is intentionally conservative: only well-known Zod phrasing
 * is rewritten; custom messages a developer wrote into a schema (e.g.
 * "Phone must be 10 digits") pass through unchanged so the original
 * intent survives.
 */
export function humanizeZodMessage(raw: string): string {
  if (!raw || typeof raw !== "string") return "Invalid value";
  const m = raw.trim();
  const lower = m.toLowerCase();

  // #487 — only treat the literal Zod default "Required" as missing.
  // A wrong-type error (e.g. "Expected string, received number") used to
  // also surface as "is required" because callers fell through to a
  // generic "required" branch; route those to "Invalid value" instead.
  if (m === "Required") return "This field is required";

  // Wrong-type errors: "Expected string, received number" / "Expected
  // number, received nan" / "Expected array, received undefined" etc.
  if (/^expected\s+\w+,\s*received\s+/i.test(m)) {
    if (/received undefined|received null/i.test(m)) {
      return "This field is required";
    }
    return "Invalid value";
  }

  // #490 — never expose "UUID" to the user. Covers Zod's "Invalid uuid"
  // and any caller that wrote "must be a valid UUID" themselves.
  if (lower.includes("uuid")) return "Invalid selection";

  // Other Zod default invalid_string variants we want to soften.
  if (m === "Invalid email") return "Enter a valid email address";
  if (m === "Invalid url") return "Enter a valid URL";
  if (m === "Invalid date" || m === "Invalid date string") {
    return "Enter a valid date";
  }
  if (m === "Invalid") return "Invalid value";

  // too_small / too_big on strings come through as
  //   "String must contain at least N character(s)"
  //   "String must contain at most N character(s)"
  // We keep the limit but trim the awkward "(s)" plural.
  const tooSmall = m.match(
    /^String must contain at least (\d+) character\(s\)$/,
  );
  if (tooSmall) {
    const n = tooSmall[1];
    return `Must be at least ${n} character${n === "1" ? "" : "s"}`;
  }
  const tooBig = m.match(/^String must contain at most (\d+) character\(s\)$/);
  if (tooBig) {
    const n = tooBig[1];
    return `Must be at most ${n} character${n === "1" ? "" : "s"}`;
  }

  // Number bounds: "Number must be greater than or equal to N" /
  // "Number must be less than or equal to N".
  const numGte = m.match(/^Number must be greater than or equal to (-?\d+\.?\d*)$/);
  if (numGte) return `Must be at least ${numGte[1]}`;
  const numLte = m.match(/^Number must be less than or equal to (-?\d+\.?\d*)$/);
  if (numLte) return `Must be at most ${numLte[1]}`;

  // Anything else (including custom messages a developer wrote into a
  // schema) is assumed to already be user-facing and is returned as-is.
  return m;
}

export function extractFieldErrors(err: unknown): FieldErrorMap | null {
  if (!err || typeof err !== "object") return null;
  const payload = (err as ApiErrorLike).payload as
    | { details?: unknown }
    | undefined;
  const details = payload?.details;
  if (!Array.isArray(details)) return null;
  const out: FieldErrorMap = {};
  for (const d of details) {
    if (
      d &&
      typeof d === "object" &&
      "field" in d &&
      "message" in d &&
      typeof (d as { field: unknown }).field === "string" &&
      typeof (d as { message: unknown }).message === "string"
    ) {
      const f = (d as { field: string }).field;
      const m = humanizeZodMessage((d as { message: string }).message);
      // Keep the first message per field — usually the most specific.
      if (!(f in out)) out[f] = m;
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Picks a flat top-line error message suitable for a toast — uses the first
 * field-level message if present, otherwise the generic Error.message.
 */
export function topLineError(err: unknown, fallback = "Request failed"): string {
  const fields = extractFieldErrors(err);
  if (fields) {
    const [first] = Object.values(fields);
    if (first) return first;
  }
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}
