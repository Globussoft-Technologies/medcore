/**
 * Operations helper utilities:
 * - GST (CGST + SGST) split calculation
 * - Very simple keyword-based sentiment scoring for feedback
 * - SLA deadline resolver for complaints
 */

import {
  SENTIMENT_POSITIVE_WORDS,
  SENTIMENT_NEGATIVE_WORDS,
  COMPLAINT_SLA_HOURS,
} from "@medcore/shared";

export type GstSplit = {
  taxAmount: number;
  cgstAmount: number;
  sgstAmount: number;
};

// CGST = SGST = half the total tax amount for intra-state invoices.
// (Used for presentation only; aggregate taxAmount is canonical.)
export function splitGst(subtotal: number, gstPercent: number): GstSplit {
  const taxAmount = +((subtotal * gstPercent) / 100).toFixed(2);
  const half = +(taxAmount / 2).toFixed(2);
  return {
    taxAmount,
    cgstAmount: half,
    sgstAmount: +(taxAmount - half).toFixed(2), // safer when rounding
  };
}

// Basic sentiment scoring (−1..+1) with labeling.
export type SentimentResult = {
  score: number;
  label: "POSITIVE" | "NEUTRAL" | "NEGATIVE";
};

export function analyzeSentiment(text?: string | null): SentimentResult | null {
  if (!text || text.trim().length === 0) return null;
  const tokens = text.toLowerCase().split(/\W+/).filter(Boolean);
  if (tokens.length === 0) return null;

  let pos = 0;
  let neg = 0;
  for (const t of tokens) {
    if (SENTIMENT_POSITIVE_WORDS.includes(t)) pos++;
    if (SENTIMENT_NEGATIVE_WORDS.includes(t)) neg++;
  }
  const matched = pos + neg;
  if (matched === 0) return { score: 0, label: "NEUTRAL" };
  const score = +((pos - neg) / matched).toFixed(2);
  const label =
    score >= 0.25 ? "POSITIVE" : score <= -0.25 ? "NEGATIVE" : "NEUTRAL";
  return { score, label };
}

// Compute SLA deadline based on complaint priority.
export function computeSlaDueAt(
  priority: string | undefined,
  from: Date = new Date()
): Date {
  const hours = COMPLAINT_SLA_HOURS[(priority || "MEDIUM").toUpperCase()] ?? 72;
  return new Date(from.getTime() + hours * 60 * 60 * 1000);
}

// Simple mention extraction: matches @[uuid] tokens in a message body.
export function extractMentions(content: string): string[] {
  const re = /@\[([0-9a-f\-]{36})\]/gi;
  const ids = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) ids.add(m[1]);
  return Array.from(ids);
}

// Quiet-hours check — returns `true` if the given time is within quiet hours.
export function isWithinQuietHours(
  now: Date,
  startHHMM?: string | null,
  endHHMM?: string | null
): boolean {
  if (!startHHMM || !endHHMM) return false;
  const [sH, sM] = startHHMM.split(":").map((n) => parseInt(n, 10));
  const [eH, eM] = endHHMM.split(":").map((n) => parseInt(n, 10));
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const sMin = sH * 60 + sM;
  const eMin = eH * 60 + eM;
  // Overnight window (e.g. 22:00 → 07:00)
  if (sMin > eMin) return nowMin >= sMin || nowMin < eMin;
  return nowMin >= sMin && nowMin < eMin;
}
