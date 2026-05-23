/**
 * Pearl ERP Stage 1 §2.1.4 (gap-doc row 49) — pure helpers for the
 * structured prescription row UX (chip + segmented controls + auto-
 * calc quantity) on /dashboard/prescriptions.
 *
 * Lives in lib/ (not in the page file) because Next.js app-router
 * page modules forbid named exports — the page imports these helpers
 * and unit tests import them too.
 *
 * Wire shape contract: PrescriptionItem in packages/db/prisma/schema.prisma
 * has no `route` or `quantity` columns. Both are serialized into the
 * existing freetext `instructions` field as `Route: XX | Qty: NN | <notes>`
 * and parsed back out on edit-load. dosage/frequency/duration stay as the
 * shared Zod-validated strings unchanged.
 */

export const DOSE_PRESETS = ["250mg", "500mg", "1g", "5ml", "10ml"] as const;

export const ROUTE_OPTIONS = [
  { value: "PO", label: "PO", tooltip: "Per os (by mouth)" },
  { value: "IV", label: "IV", tooltip: "Intravenous" },
  { value: "IM", label: "IM", tooltip: "Intramuscular" },
  { value: "SC", label: "SC", tooltip: "Subcutaneous" },
  { value: "Topical", label: "Topical", tooltip: "Topical / skin" },
] as const;

export const FREQUENCY_TOOLTIPS: Record<string, string> = {
  "1-0-0 (Morning)": "OD — Once daily (morning)",
  "0-1-0 (Afternoon)": "OD — Once daily (afternoon)",
  "0-0-1 (Night)": "OD — Once daily (night)",
  "1-1-0 (Morning-Afternoon)": "BD — Twice daily",
  "1-0-1 (Morning-Night)": "BD — Twice daily",
  "0-1-1 (Afternoon-Night)": "BD — Twice daily",
  "1-1-1 (Three times)": "TDS — Three times daily",
  "SOS (As needed)": "SOS — As needed (no auto-qty)",
};

/**
 * Frequency-per-day extracted from the FREQUENCY_OPTIONS string.
 * "1-0-0 (...)" → 1. "1-1-1 (...)" → 3. "SOS" → 0 (do not auto-calc).
 */
export function frequencyPerDay(freq: string): number {
  const m = freq.match(/^(\d)-(\d)-(\d)/);
  if (!m) return 0;
  return Number(m[1]) + Number(m[2]) + Number(m[3]);
}

/**
 * Duration string → days. Accepts the same shapes the shared
 * durationStringSchema accepts (h/d/w/m/mo/...).
 */
export function durationToDays(duration: string): number {
  const m = duration
    .trim()
    .match(/^(\d+(?:\.\d+)?)\s*(hour|hours|hr|hrs|h|day|days|d|week|weeks|w|wk|wks|month|months|mo|mos|m)$/i);
  if (!m) return 0;
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  if (unit.startsWith("h")) return n / 24;
  if (unit.startsWith("w")) return n * 7;
  if (unit === "month" || unit === "months" || unit === "mo" || unit === "mos" || unit === "m") {
    return n * 30;
  }
  return n; // days
}

/**
 * Auto-quantity = ceil(frequencyPerDay × days). Returns "" when
 * inputs are insufficient (so the field renders empty, not "0").
 */
export function computeAutoQuantity(freq: string, duration: string): string {
  const perDay = frequencyPerDay(freq);
  const days = durationToDays(duration);
  if (perDay <= 0 || days <= 0) return "";
  return String(Math.ceil(perDay * days));
}

/**
 * Compose the `instructions` wire value from the structured pieces
 * (route + qty) plus the user's free-text notes. Empty pieces are
 * elided so a no-route / no-qty / no-notes row sends "".
 */
export function composeInstructions(opts: {
  route?: string;
  quantity?: string;
  notes?: string;
}): string {
  const parts: string[] = [];
  if (opts.route && opts.route.trim()) parts.push(`Route: ${opts.route.trim()}`);
  if (opts.quantity && opts.quantity.trim()) parts.push(`Qty: ${opts.quantity.trim()}`);
  if (opts.notes && opts.notes.trim()) parts.push(opts.notes.trim());
  return parts.join(" | ");
}

/**
 * Inverse of composeInstructions — used on edit-load to repopulate
 * the structured controls from a stored instructions string.
 */
export function parseInstructions(raw: string | null | undefined): {
  route: string;
  quantity: string;
  notes: string;
} {
  const out = { route: "", quantity: "", notes: "" };
  if (!raw) return out;
  const segments = raw.split("|").map((s) => s.trim()).filter(Boolean);
  const remainder: string[] = [];
  for (const seg of segments) {
    const r = seg.match(/^Route:\s*(.+)$/i);
    if (r) {
      out.route = r[1].trim();
      continue;
    }
    const q = seg.match(/^Qty:\s*(.+)$/i);
    if (q) {
      out.quantity = q[1].trim();
      continue;
    }
    remainder.push(seg);
  }
  out.notes = remainder.join(" | ");
  return out;
}
