// PII redaction helpers for visitor (and similar) response shaping.
//
// Why this exists:
// Issue #476 — `/api/v1/visitors/active` (and other visitor GETs) were returning
// raw Aadhaar / ID-proof numbers in the response body. Anyone with reception/
// nurse/doctor/admin access could read full government-issued IDs in plaintext
// over the wire and in browser dev-tools history. We keep the full value in the
// DB (still needed for blacklist matching on check-in), but mask it on every
// outbound read so the API surface only ever returns the last 4 digits.
//
// Usage:
//   const safe = redactVisitorPII(visitor);
//   res.json({ data: safe, ... });
// Works on a single record or an array.

export function maskIdNumber(value: string | null | undefined): string | null {
  if (!value) return null;
  const digits = String(value);
  if (digits.length <= 4) return "****";
  return "********" + digits.slice(-4);
}

type AnyVisitor = Record<string, unknown> & {
  idProofNumber?: string | null;
};

// Return type widens to `T & { idProofNumber: string | null }` because the
// function always sets `idProofNumber` on the output (normalising missing
// inputs to null). Without the explicit return shape, callers whose input
// type doesn't declare `idProofNumber` (e.g. test fixtures) get TS2339 when
// they read `safe.idProofNumber` on the result.
export function redactVisitorPII<T extends AnyVisitor>(
  visitor: T,
): T & { idProofNumber: string | null } {
  if (!visitor || typeof visitor !== "object") return visitor as T & { idProofNumber: string | null };
  return {
    ...visitor,
    idProofNumber: maskIdNumber(visitor.idProofNumber ?? null),
  };
}

export function redactVisitorListPII<T extends AnyVisitor>(
  visitors: T[],
): Array<T & { idProofNumber: string | null }> {
  if (!Array.isArray(visitors)) return visitors;
  return visitors.map((v) => redactVisitorPII(v));
}
