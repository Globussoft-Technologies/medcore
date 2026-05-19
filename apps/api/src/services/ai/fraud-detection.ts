/**
 * Fraud & Anomaly Detection — primary rule-based layer with optional LLM
 * qualitative review. Scans Invoice / Payment / Prescription history for
 * suspicious patterns and writes results to the `FraudAlert` model.
 *
 * Signals detected:
 *   1. Duplicate charges  — same description, same patient, same day, in
 *      multiple invoices.
 *   2. Prescription volume outlier — a doctor whose daily prescription count
 *      over the window exceeds 3σ above their historical baseline.
 *   3. High-frequency patient — patient with unusually many invoices in a
 *      short window (> 2σ above cohort mean).
 *   4. Large refund — payment row with negative amount OR refund marker above
 *      threshold.
 *   5. Large discount — Invoice.discountAmount above configured threshold.
 *   6. Generic → brand upselling — prescriptions whose item names include
 *      branded variants when a generic was charted (heuristic — keyword hit).
 *
 * The LLM layer is OPT-IN: when `llmReview=true`, each rule hit is summarised
 * into a short natural-language reason by Sarvam. Failures are non-fatal —
 * alerts still persist without the LLM note.
 */

import { tenantScopedPrisma as prisma } from "../tenant-prisma";
import { generateStructured } from "./sarvam";

// ─── Types ────────────────────────────────────────────────────────────────

export type FraudAlertType =
  | "DUPLICATE_CHARGE"
  | "PRESCRIPTION_OUTLIER"
  | "HIGH_FREQUENCY_PATIENT"
  | "LARGE_REFUND"
  | "LARGE_DISCOUNT"
  | "GENERIC_TO_BRAND_UPSELL"
  | "OTHER";

export type FraudAlertSeverity = "INFO" | "SUSPICIOUS" | "HIGH_RISK";

export interface RawFraudHit {
  type: FraudAlertType;
  severity: FraudAlertSeverity;
  entityType: string;
  entityId: string;
  description: string;
  evidence: Record<string, unknown>;
}

export interface FraudScanResult {
  hits: RawFraudHit[];
  persisted: number;
  windowDays: number;
  scannedAt: string;
}

// ─── Config (env-tunable thresholds) ──────────────────────────────────────

const LARGE_REFUND_ABS = parseFloat(process.env.FRAUD_LARGE_REFUND_ABS ?? "10000");
const LARGE_DISCOUNT_ABS = parseFloat(process.env.FRAUD_LARGE_DISCOUNT_ABS ?? "5000");
const LARGE_DISCOUNT_PCT = parseFloat(process.env.FRAUD_LARGE_DISCOUNT_PCT ?? "40"); // % of subtotal
const HIGH_FREQ_INVOICE_THRESHOLD = parseInt(
  process.env.FRAUD_HIGH_FREQ_INVOICE_COUNT ?? "10",
  10
); // absolute fallback
const PRESCRIPTION_SIGMA_K = parseFloat(process.env.FRAUD_PRESCRIPTION_SIGMA_K ?? "3");

// Naive branded keyword hints used for the generic→brand heuristic. Real
// deployments should pull this from a curated mapping table; kept local so
// the detector runs standalone.
const BRANDED_KEYWORDS = [
  "crocin",
  "dolo",
  "calpol",
  "combiflam",
  "zincovit",
  "augmentin",
  "azithral",
  "levolin",
  "revital",
];

// ─── Helpers ──────────────────────────────────────────────────────────────

function mean(nums: number[]): number {
  if (nums.length === 0) return 0;
  return nums.reduce((s, n) => s + n, 0) / nums.length;
}

function stddev(nums: number[]): number {
  if (nums.length < 2) return 0;
  const m = mean(nums);
  const variance = nums.reduce((s, n) => s + (n - m) ** 2, 0) / nums.length;
  return Math.sqrt(variance);
}

function daysAgo(n: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(0, 0, 0, 0);
  return d;
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

// ─── Rule 1: duplicate charges ────────────────────────────────────────────

export async function detectDuplicateCharges(sinceDate: Date): Promise<RawFraudHit[]> {
  // Pull recent invoices with items + patient. In practice this is bounded by
  // the window; for very large installs we'd paginate, but the daily cron
  // caps work to ~30 days of invoices.
  const invoices = await prisma.invoice.findMany({
    where: { createdAt: { gte: sinceDate } },
    include: { items: true },
    take: 5000,
  });

  // Bucket by patientId|YYYY-MM-DD|normalised description+amount
  const buckets = new Map<string, { invoiceIds: Set<string>; description: string; count: number; patientId: string }>();
  for (const inv of invoices) {
    const day = new Date(inv.createdAt);
    day.setHours(0, 0, 0, 0);
    for (const item of inv.items) {
      const key = `${inv.patientId}|${day.toISOString().slice(0, 10)}|${item.description.toLowerCase().trim()}|${item.amount}`;
      const entry = buckets.get(key) ?? {
        invoiceIds: new Set<string>(),
        description: item.description,
        count: 0,
        patientId: inv.patientId,
      };
      entry.invoiceIds.add(inv.id);
      entry.count += 1;
      buckets.set(key, entry);
    }
  }

  const hits: RawFraudHit[] = [];
  for (const [key, b] of buckets.entries()) {
    if (b.invoiceIds.size >= 2) {
      const ids = Array.from(b.invoiceIds);
      hits.push({
        type: "DUPLICATE_CHARGE",
        severity: b.invoiceIds.size >= 3 ? "HIGH_RISK" : "SUSPICIOUS",
        entityType: "Invoice",
        entityId: ids[0],
        description: `Duplicate charge "${b.description}" billed ${b.invoiceIds.size} times to same patient on same day`,
        evidence: {
          bucketKey: key,
          invoiceIds: ids,
          patientId: b.patientId,
          duplicateCount: b.invoiceIds.size,
          itemCount: b.count,
        },
      });
    }
  }
  return hits;
}

// ─── Rule 2: prescription outliers (>3σ above doctor baseline) ────────────

export async function detectPrescriptionOutliers(sinceDate: Date): Promise<RawFraudHit[]> {
  // Daily prescription count per doctor over a longer baseline window (90d),
  // then compare the window's peak day to doctor's mean + k·σ.
  const baselineSince = new Date(sinceDate);
  baselineSince.setDate(baselineSince.getDate() - 60); // extra 60d of baseline context

  const rxs = await prisma.prescription.findMany({
    where: { createdAt: { gte: baselineSince } },
    select: { doctorId: true, createdAt: true, id: true },
    take: 50000,
  });

  // Group by doctor → per-day counts
  const byDoctor = new Map<string, Map<string, number>>();
  for (const r of rxs) {
    const day = new Date(r.createdAt);
    day.setHours(0, 0, 0, 0);
    const dayKey = day.toISOString().slice(0, 10);
    let doctorMap = byDoctor.get(r.doctorId);
    if (!doctorMap) {
      doctorMap = new Map();
      byDoctor.set(r.doctorId, doctorMap);
    }
    doctorMap.set(dayKey, (doctorMap.get(dayKey) ?? 0) + 1);
  }

  const hits: RawFraudHit[] = [];
  for (const [doctorId, dayCounts] of byDoctor.entries()) {
    const counts = Array.from(dayCounts.values());
    if (counts.length < 5) continue; // insufficient baseline — skip
    const m = mean(counts);
    const s = stddev(counts);
    if (s === 0) continue;
    const threshold = m + PRESCRIPTION_SIGMA_K * s;
    for (const [day, c] of dayCounts.entries()) {
      if (c <= threshold) continue;
      const dayDate = new Date(day);
      if (dayDate < sinceDate) continue; // outside scan window
      hits.push({
        type: "PRESCRIPTION_OUTLIER",
        severity: c > threshold * 1.5 ? "HIGH_RISK" : "SUSPICIOUS",
        entityType: "Doctor",
        entityId: doctorId,
        description: `Doctor prescribed ${c} prescriptions on ${day} — baseline mean ${m.toFixed(1)}/day, +${PRESCRIPTION_SIGMA_K}σ = ${threshold.toFixed(1)}`,
        evidence: {
          doctorId,
          day,
          count: c,
          baselineMean: +m.toFixed(2),
          baselineStddev: +s.toFixed(2),
          sigmaK: PRESCRIPTION_SIGMA_K,
          threshold: +threshold.toFixed(2),
        },
      });
    }
  }
  return hits;
}

// ─── Rule 3: high-frequency patients ──────────────────────────────────────

export async function detectHighFrequencyPatients(sinceDate: Date): Promise<RawFraudHit[]> {
  const invoices = await prisma.invoice.findMany({
    where: { createdAt: { gte: sinceDate } },
    select: { patientId: true, id: true, totalAmount: true },
    take: 20000,
  });
  const counts = new Map<string, { count: number; total: number; invoiceIds: string[] }>();
  for (const inv of invoices) {
    const e = counts.get(inv.patientId) ?? { count: 0, total: 0, invoiceIds: [] };
    e.count += 1;
    // Issue #901: Invoice.totalAmount is Prisma.Decimal — coerce.
    e.total += typeof (inv.totalAmount as unknown) === "number"
      ? (inv.totalAmount as unknown as number)
      : (inv.totalAmount as unknown as { toNumber: () => number }).toNumber();
    e.invoiceIds.push(inv.id);
    counts.set(inv.patientId, e);
  }
  const arr = Array.from(counts.values()).map((v) => v.count);
  const m = mean(arr);
  const s = stddev(arr);
  const cohortThreshold = s > 0 ? m + 2 * s : HIGH_FREQ_INVOICE_THRESHOLD;

  const hits: RawFraudHit[] = [];
  for (const [patientId, e] of counts.entries()) {
    if (e.count >= Math.max(cohortThreshold, HIGH_FREQ_INVOICE_THRESHOLD)) {
      hits.push({
        type: "HIGH_FREQUENCY_PATIENT",
        severity: e.count >= cohortThreshold * 1.5 ? "HIGH_RISK" : "SUSPICIOUS",
        entityType: "Patient",
        entityId: patientId,
        description: `Patient generated ${e.count} invoices (cohort mean ${m.toFixed(1)}, threshold ${cohortThreshold.toFixed(1)}) in the window`,
        evidence: {
          patientId,
          invoiceCount: e.count,
          totalBilled: +e.total.toFixed(2),
          cohortMean: +m.toFixed(2),
          cohortStddev: +s.toFixed(2),
          cohortThreshold: +cohortThreshold.toFixed(2),
          sampleInvoiceIds: e.invoiceIds.slice(0, 5),
        },
      });
    }
  }
  return hits;
}

// ─── Rule 4: large refunds ────────────────────────────────────────────────

export async function detectLargeRefunds(sinceDate: Date): Promise<RawFraudHit[]> {
  const payments = await prisma.payment.findMany({
    where: { paidAt: { gte: sinceDate } },
    take: 10000,
  });
  const hits: RawFraudHit[] = [];
  for (const p of payments) {
    // Negative amount or explicit REFUNDED status treated as refund
    const isRefund = p.amount < 0 || p.status === "REFUNDED";
    if (!isRefund) continue;
    const abs = Math.abs(p.amount);
    if (abs < LARGE_REFUND_ABS) continue;
    hits.push({
      type: "LARGE_REFUND",
      severity: abs >= LARGE_REFUND_ABS * 2 ? "HIGH_RISK" : "SUSPICIOUS",
      entityType: "Payment",
      entityId: p.id,
      description: `Large refund of ₹${abs.toFixed(2)} processed`,
      evidence: {
        paymentId: p.id,
        invoiceId: p.invoiceId,
        amount: p.amount,
        mode: p.mode,
        status: p.status,
        threshold: LARGE_REFUND_ABS,
      },
    });
  }
  return hits;
}

// ─── Rule 5: large discounts ──────────────────────────────────────────────

export async function detectLargeDiscounts(sinceDate: Date): Promise<RawFraudHit[]> {
  const invoices = await prisma.invoice.findMany({
    where: {
      createdAt: { gte: sinceDate },
      discountAmount: { gt: 0 },
    },
    select: {
      id: true,
      patientId: true,
      subtotal: true,
      discountAmount: true,
      totalAmount: true,
      createdAt: true,
    },
    take: 10000,
  });
  const hits: RawFraudHit[] = [];
  // Issue #901: Invoice money columns are now Prisma.Decimal — coerce.
  const toN = (v: unknown): number => {
    if (v == null) return 0;
    if (typeof v === "number") return v;
    const av = v as { toNumber?: () => number };
    return typeof av.toNumber === "function" ? av.toNumber() : Number(v);
  };
  for (const inv of invoices) {
    const subN = toN(inv.subtotal);
    const discN = toN(inv.discountAmount);
    const pct = subN > 0 ? (discN / subN) * 100 : 0;
    const absHit = discN >= LARGE_DISCOUNT_ABS;
    const pctHit = pct >= LARGE_DISCOUNT_PCT;
    if (!absHit && !pctHit) continue;
    hits.push({
      type: "LARGE_DISCOUNT",
      severity: absHit && pctHit ? "HIGH_RISK" : "SUSPICIOUS",
      entityType: "Invoice",
      entityId: inv.id,
      description: `Invoice discount ₹${inv.discountAmount.toFixed(2)} (${pct.toFixed(1)}% of subtotal)`,
      evidence: {
        invoiceId: inv.id,
        patientId: inv.patientId,
        subtotal: inv.subtotal,
        discountAmount: inv.discountAmount,
        discountPct: +pct.toFixed(2),
        totalAmount: inv.totalAmount,
        thresholdAbs: LARGE_DISCOUNT_ABS,
        thresholdPct: LARGE_DISCOUNT_PCT,
      },
    });
  }
  return hits;
}

// ─── Rule 6: generic → brand upsell heuristic ─────────────────────────────

export async function detectGenericToBrandUpsell(sinceDate: Date): Promise<RawFraudHit[]> {
  // Inspect prescription items for branded-keyword hits. The heuristic is
  // intentionally simple — real logic would consult a formulary / payer
  // preferred-drug list.
  const rxs = await prisma.prescription.findMany({
    where: { createdAt: { gte: sinceDate } },
    include: { items: true },
    take: 10000,
  });

  // Compute per-doctor brand-rate
  const doctorStats = new Map<string, { brand: number; total: number; samples: string[] }>();
  for (const rx of rxs) {
    const e = doctorStats.get(rx.doctorId) ?? { brand: 0, total: 0, samples: [] };
    for (const it of rx.items) {
      e.total += 1;
      const name = (it.medicineName ?? "").toLowerCase();
      if (BRANDED_KEYWORDS.some((kw) => name.includes(kw))) {
        e.brand += 1;
        if (e.samples.length < 5) e.samples.push(it.medicineName);
      }
    }
    doctorStats.set(rx.doctorId, e);
  }

  const hits: RawFraudHit[] = [];
  for (const [doctorId, e] of doctorStats.entries()) {
    if (e.total < 10) continue; // insufficient signal
    const rate = e.brand / e.total;
    if (rate < 0.7) continue; // >=70% branded → upsell signal
    hits.push({
      type: "GENERIC_TO_BRAND_UPSELL",
      severity: rate >= 0.9 ? "HIGH_RISK" : "SUSPICIOUS",
      entityType: "Doctor",
      entityId: doctorId,
      description: `Doctor prescribed branded variant in ${(rate * 100).toFixed(0)}% of items (${e.brand}/${e.total})`,
      evidence: {
        doctorId,
        brandedCount: e.brand,
        totalCount: e.total,
        brandRate: +rate.toFixed(3),
        sampleBrandedItems: e.samples,
        keywords: BRANDED_KEYWORDS,
      },
    });
  }
  return hits;
}

// ─── Optional LLM qualitative review ──────────────────────────────────────

/**
 * For each rule hit, ask Sarvam for a 1-2 sentence natural-language
 * explanation. Failures are swallowed (returns the input unchanged) so the
 * detector never blocks on LLM availability.
 */
export async function annotateWithLLMReason(hits: RawFraudHit[]): Promise<RawFraudHit[]> {
  if (hits.length === 0) return hits;
  try {
    const { data } = await generateStructured<{
      reasons: { index: number; reason: string }[];
    }>({
      systemPrompt:
        "You are a hospital billing fraud analyst. Given a list of detected billing anomalies, write a crisp 1-2 sentence qualitative explanation each — what this looks like to a trained auditor and what a reviewer should check first. Never invent facts. Return strictly via the tool.",
      userPrompt: JSON.stringify(
        hits.map((h, i) => ({
          index: i,
          type: h.type,
          severity: h.severity,
          description: h.description,
          evidence: h.evidence,
        }))
      ),
      toolName: "emit_reasons",
      toolDescription: "Emit qualitative reviewer notes for each anomaly by index",
      parameters: {
        type: "object",
        properties: {
          reasons: {
            type: "array",
            items: {
              type: "object",
              properties: {
                index: { type: "number" },
                reason: { type: "string" },
              },
              required: ["index", "reason"],
            },
          },
        },
        required: ["reasons"],
      },
      maxTokens: 1024,
      temperature: 0.1,
    });
    if (!data?.reasons) return hits;
    return hits.map((h, i) => {
      const match = data.reasons.find((r) => r.index === i);
      if (!match) return h;
      return { ...h, evidence: { ...h.evidence, llmReason: match.reason } };
    });
  } catch (err) {
    console.warn("[fraud-detection] LLM annotation failed (non-fatal)", (err as Error).message);
    return hits;
  }
}

// ─── Public entrypoint ────────────────────────────────────────────────────

export async function detectBillingAnomalies(opts?: {
  windowDays?: number;
  llmReview?: boolean;
  persist?: boolean;
}): Promise<FraudScanResult> {
  const windowDays = opts?.windowDays ?? 30;
  const llmReview = opts?.llmReview ?? false;
  const persist = opts?.persist ?? true;
  const since = daysAgo(windowDays);

  const [dup, rxOut, freq, refunds, discounts, upsell] = await Promise.all([
    detectDuplicateCharges(since).catch((e) => {
      console.error("[fraud] dup", e);
      return [];
    }),
    detectPrescriptionOutliers(since).catch((e) => {
      console.error("[fraud] rxOut", e);
      return [];
    }),
    detectHighFrequencyPatients(since).catch((e) => {
      console.error("[fraud] freq", e);
      return [];
    }),
    detectLargeRefunds(since).catch((e) => {
      console.error("[fraud] refunds", e);
      return [];
    }),
    detectLargeDiscounts(since).catch((e) => {
      console.error("[fraud] discounts", e);
      return [];
    }),
    detectGenericToBrandUpsell(since).catch((e) => {
      console.error("[fraud] upsell", e);
      return [];
    }),
  ]);

  let hits: RawFraudHit[] = [...dup, ...rxOut, ...freq, ...refunds, ...discounts, ...upsell];
  if (llmReview) {
    hits = await annotateWithLLMReason(hits);
  }

  let persisted = 0;
  if (persist) {
    const fraudAlert = (prisma as unknown as { fraudAlert?: any }).fraudAlert;
    if (fraudAlert?.create) {
      for (const h of hits) {
        try {
          await fraudAlert.create({
            data: {
              type: h.type,
              severity: h.severity,
              status: "OPEN",
              entityType: h.entityType,
              entityId: h.entityId,
              description: h.description,
              evidence: h.evidence,
            },
          });
          persisted += 1;
        } catch (err) {
          console.error("[fraud] persist failed", (err as Error).message);
        }
      }
    } else {
      // Model not yet migrated — surface hits to caller without persisting.
      console.warn("[fraud-detection] FraudAlert model not present; skipping persist");
    }
  }

  return {
    hits,
    persisted,
    windowDays,
    scannedAt: new Date().toISOString(),
  };
}
