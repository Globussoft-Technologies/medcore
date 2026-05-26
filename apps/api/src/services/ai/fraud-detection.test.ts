/**
 * Test-cron tick (2026-05-25) — Fraud & anomaly detection unit tests.
 *
 * What / which modules / why
 * ──────────────────────────
 * - WHAT: regression around the six rule-based fraud detectors
 *   (`detectDuplicateCharges`, `detectPrescriptionOutliers`,
 *   `detectHighFrequencyPatients`, `detectLargeRefunds`,
 *   `detectLargeDiscounts`, `detectGenericToBrandUpsell`), the optional
 *   `annotateWithLLMReason` LLM annotation layer, and the
 *   `detectBillingAnomalies` orchestrator. Pins severity boundaries
 *   (SUSPICIOUS vs HIGH_RISK), threshold inclusivity, the empty-input
 *   contracts, per-rule error isolation (catch+continue), and the
 *   FraudAlert persistence + missing-model fallback.
 * - MODULES: hoisted mock of `../tenant-prisma` (re-exports from
 *   `@medcore/db`) so no real Postgres is touched, plus a mock of
 *   `./sarvam` so the LLM path is deterministic and offline.
 * - WHY: the detector writes directly to `FraudAlert` rows the
 *   compliance-audit screen reads as ground truth — wrong severity =
 *   wrong escalation, wrong threshold = miss-or-flood. This file is the
 *   unit-level guard before the daily cron wires it to live Postgres.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { prismaMock, generateStructuredMock } = vi.hoisted(() => ({
  prismaMock: {
    invoice: { findMany: vi.fn() },
    prescription: { findMany: vi.fn() },
    payment: { findMany: vi.fn() },
    fraudAlert: { create: vi.fn() },
  } as any,
  generateStructuredMock: vi.fn(),
}));

vi.mock("../tenant-prisma", () => ({
  tenantScopedPrisma: prismaMock,
}));

vi.mock("@medcore/db", () => ({
  tenantScopedPrisma: prismaMock,
  getTenantId: () => undefined,
  runWithTenant: (_t: string, fn: () => unknown) => fn(),
  requireTenantId: () => {
    throw new Error("tenant ctx required");
  },
  prisma: prismaMock,
}));

vi.mock("./sarvam", () => ({
  generateStructured: generateStructuredMock,
}));

import {
  detectDuplicateCharges,
  detectPrescriptionOutliers,
  detectHighFrequencyPatients,
  detectLargeRefunds,
  detectLargeDiscounts,
  detectGenericToBrandUpsell,
  annotateWithLLMReason,
  detectBillingAnomalies,
} from "./fraud-detection";

// ─── Fixtures ─────────────────────────────────────────────────────────────

const SINCE = new Date("2026-04-25T00:00:00.000Z");
const DAY = new Date("2026-05-01T10:00:00.000Z");

function resetAllMocks() {
  prismaMock.invoice.findMany.mockReset();
  prismaMock.prescription.findMany.mockReset();
  prismaMock.payment.findMany.mockReset();
  prismaMock.fraudAlert.create.mockReset();
  generateStructuredMock.mockReset();
  // Sensible default empty stubs so any rule not under test returns [].
  prismaMock.invoice.findMany.mockResolvedValue([]);
  prismaMock.prescription.findMany.mockResolvedValue([]);
  prismaMock.payment.findMany.mockResolvedValue([]);
}

function makeInvoice(over: Partial<any> = {}): any {
  return {
    id: over.id ?? "inv-1",
    patientId: over.patientId ?? "pat-1",
    createdAt: over.createdAt ?? DAY,
    items: over.items ?? [
      { description: "Consultation", amount: 500 },
    ],
    subtotal: over.subtotal ?? 1000,
    discountAmount: over.discountAmount ?? 0,
    totalAmount: over.totalAmount ?? 1000,
  };
}

function makePrescription(over: Partial<any> = {}): any {
  return {
    id: over.id ?? "rx-1",
    doctorId: over.doctorId ?? "doc-1",
    createdAt: over.createdAt ?? DAY,
    items: over.items ?? [{ medicineName: "Paracetamol" }],
  };
}

function makePayment(over: Partial<any> = {}): any {
  return {
    id: over.id ?? "pay-1",
    invoiceId: over.invoiceId ?? "inv-1",
    paidAt: over.paidAt ?? DAY,
    amount: over.amount ?? 100,
    mode: over.mode ?? "CASH",
    status: over.status ?? "PAID",
  };
}

// ─── Rule 1: duplicate charges ────────────────────────────────────────────

describe("detectDuplicateCharges", () => {
  beforeEach(resetAllMocks);

  it("flags two invoices with the same item description+amount on the same day", async () => {
    prismaMock.invoice.findMany.mockResolvedValue([
      makeInvoice({
        id: "inv-A",
        items: [{ description: "X-Ray Chest", amount: 800 }],
      }),
      makeInvoice({
        id: "inv-B",
        items: [{ description: "X-Ray Chest", amount: 800 }],
      }),
    ]);

    const hits = await detectDuplicateCharges(SINCE);

    expect(hits).toHaveLength(1);
    expect(hits[0].type).toBe("DUPLICATE_CHARGE");
    expect(hits[0].severity).toBe("SUSPICIOUS");
    expect(hits[0].entityType).toBe("Invoice");
    expect(hits[0].evidence.duplicateCount).toBe(2);
    expect((hits[0].evidence.invoiceIds as string[]).sort()).toEqual(["inv-A", "inv-B"]);
  });

  it("escalates to HIGH_RISK when the same charge appears 3+ times", async () => {
    const items = [{ description: "MRI Brain", amount: 5000 }];
    prismaMock.invoice.findMany.mockResolvedValue([
      makeInvoice({ id: "inv-A", items }),
      makeInvoice({ id: "inv-B", items }),
      makeInvoice({ id: "inv-C", items }),
    ]);

    const hits = await detectDuplicateCharges(SINCE);

    expect(hits).toHaveLength(1);
    expect(hits[0].severity).toBe("HIGH_RISK");
    expect(hits[0].evidence.duplicateCount).toBe(3);
  });

  it("normalises description (lowercase + trim) when bucketing", async () => {
    prismaMock.invoice.findMany.mockResolvedValue([
      makeInvoice({
        id: "inv-A",
        items: [{ description: "  Consultation  ", amount: 500 }],
      }),
      makeInvoice({
        id: "inv-B",
        items: [{ description: "CONSULTATION", amount: 500 }],
      }),
    ]);

    const hits = await detectDuplicateCharges(SINCE);

    expect(hits).toHaveLength(1);
    expect(hits[0].evidence.duplicateCount).toBe(2);
  });

  it("does NOT flag the same charge across different days", async () => {
    prismaMock.invoice.findMany.mockResolvedValue([
      makeInvoice({
        id: "inv-A",
        createdAt: new Date("2026-05-01T10:00:00Z"),
        items: [{ description: "Consultation", amount: 500 }],
      }),
      makeInvoice({
        id: "inv-B",
        createdAt: new Date("2026-05-02T10:00:00Z"),
        items: [{ description: "Consultation", amount: 500 }],
      }),
    ]);

    expect(await detectDuplicateCharges(SINCE)).toEqual([]);
  });

  it("does NOT flag the same charge across different patients", async () => {
    prismaMock.invoice.findMany.mockResolvedValue([
      makeInvoice({ id: "inv-A", patientId: "pat-1" }),
      makeInvoice({ id: "inv-B", patientId: "pat-2" }),
    ]);

    expect(await detectDuplicateCharges(SINCE)).toEqual([]);
  });

  it("returns [] when there are no invoices", async () => {
    prismaMock.invoice.findMany.mockResolvedValue([]);
    expect(await detectDuplicateCharges(SINCE)).toEqual([]);
  });

  it("does NOT flag a single invoice with two identical items (only one invoice id)", async () => {
    prismaMock.invoice.findMany.mockResolvedValue([
      makeInvoice({
        id: "inv-A",
        items: [
          { description: "Saline", amount: 100 },
          { description: "Saline", amount: 100 },
        ],
      }),
    ]);

    expect(await detectDuplicateCharges(SINCE)).toEqual([]);
  });
});

// ─── Rule 2: prescription outliers ────────────────────────────────────────

describe("detectPrescriptionOutliers", () => {
  beforeEach(resetAllMocks);

  it("flags a doctor's spike day above mean + 3σ inside the scan window", async () => {
    // 31 baseline days at 5 rx/day inside the 60-day baseline window, then a
    // moderate spike day at 30 inside the scan window. Big baseline keeps σ
    // low so 30 clearly clears the 1.5×threshold escalation gate.
    // Use noon-UTC to dodge IST/PST local-day drift in source's
    // `setHours(0,0,0,0)` bucketing.
    const rxs: any[] = [];
    for (let d = 1; d <= 31; d++) {
      const baseDay = new Date(`2026-03-${String(d).padStart(2, "0")}T12:00:00Z`);
      for (let i = 0; i < 5; i++) {
        rxs.push(
          makePrescription({ id: `rx-base-${d}-${i}`, doctorId: "doc-spike", createdAt: baseDay }),
        );
      }
    }
    const spikeDay = new Date("2026-05-01T12:00:00Z");
    for (let i = 0; i < 30; i++) {
      rxs.push(
        makePrescription({ id: `rx-spike-${i}`, doctorId: "doc-spike", createdAt: spikeDay }),
      );
    }
    prismaMock.prescription.findMany.mockResolvedValue(rxs);

    const hits = await detectPrescriptionOutliers(SINCE);

    expect(hits).toHaveLength(1);
    expect(hits[0].type).toBe("PRESCRIPTION_OUTLIER");
    expect(hits[0].entityType).toBe("Doctor");
    expect(hits[0].entityId).toBe("doc-spike");
    expect(hits[0].evidence.count).toBe(30);
    // Don't pin the exact day string — local-tz bucketing makes it ±1 day
    // depending on where CI runs. Pin the YYYY-MM shape + range instead.
    expect(hits[0].evidence.day).toMatch(/^2026-(04-30|05-01|05-02)$/);
    // 30 > threshold * 1.5 (mean≈5.4, σ≈3.2 → threshold≈15, 1.5×≈22.5) → HIGH_RISK.
    expect(hits[0].severity).toBe("HIGH_RISK");
  });

  it("skips doctors with insufficient baseline (< 5 distinct days)", async () => {
    // Only 3 distinct days even though one is huge — too thin to baseline.
    const rxs: any[] = [];
    for (let i = 0; i < 30; i++) {
      rxs.push(
        makePrescription({
          id: `rx-${i}`,
          doctorId: "doc-thin",
          createdAt: new Date("2026-05-01T08:00:00Z"),
        }),
      );
    }
    rxs.push(makePrescription({ doctorId: "doc-thin", createdAt: new Date("2026-04-01") }));
    rxs.push(makePrescription({ doctorId: "doc-thin", createdAt: new Date("2026-04-02") }));
    prismaMock.prescription.findMany.mockResolvedValue(rxs);

    expect(await detectPrescriptionOutliers(SINCE)).toEqual([]);
  });

  it("skips doctors whose per-day counts are flat (stddev = 0)", async () => {
    const rxs: any[] = [];
    for (let d = 1; d <= 8; d++) {
      const day = new Date(`2026-05-${String(d).padStart(2, "0")}T08:00:00Z`);
      rxs.push(
        makePrescription({ id: `rx-flat-${d}-a`, doctorId: "doc-flat", createdAt: day }),
        makePrescription({ id: `rx-flat-${d}-b`, doctorId: "doc-flat", createdAt: day }),
      );
    }
    prismaMock.prescription.findMany.mockResolvedValue(rxs);

    expect(await detectPrescriptionOutliers(SINCE)).toEqual([]);
  });

  it("ignores spike days that fall BEFORE the scan window", async () => {
    // Spike at 2026-03-15 (before SINCE = 2026-04-25). Baseline window
    // extends 60d back, so the prescriptions are loaded — but the spike-day
    // gate `dayDate < sinceDate` must exclude it.
    const rxs: any[] = [];
    for (let d = 1; d <= 8; d++) {
      const day = new Date(`2026-02-${String(d).padStart(2, "0")}T08:00:00Z`);
      for (let i = 0; i < 3; i++) {
        rxs.push(makePrescription({ doctorId: "doc-old", createdAt: day, id: `b${d}${i}` }));
      }
    }
    const oldSpike = new Date("2026-03-15T08:00:00Z");
    for (let i = 0; i < 40; i++) {
      rxs.push(makePrescription({ doctorId: "doc-old", createdAt: oldSpike, id: `s${i}` }));
    }
    prismaMock.prescription.findMany.mockResolvedValue(rxs);

    expect(await detectPrescriptionOutliers(SINCE)).toEqual([]);
  });

  it("returns [] when no prescriptions exist", async () => {
    prismaMock.prescription.findMany.mockResolvedValue([]);
    expect(await detectPrescriptionOutliers(SINCE)).toEqual([]);
  });
});

// ─── Rule 3: high-frequency patients ──────────────────────────────────────

describe("detectHighFrequencyPatients", () => {
  beforeEach(resetAllMocks);

  it("flags a patient whose invoice count exceeds the cohort-σ AND absolute threshold", async () => {
    // 5 cohort patients with 1 invoice each + 1 patient with 15 invoices.
    // Cohort mean ≈ 3.3, σ ≈ 5.2, cohortThreshold = mean + 2σ ≈ 13.7.
    // Max also obeys HIGH_FREQ_INVOICE_THRESHOLD=10. 15 > 13.7 → flagged.
    const invoices: any[] = [];
    for (let p = 1; p <= 5; p++) {
      invoices.push(makeInvoice({ id: `inv-q-${p}`, patientId: `pat-${p}` }));
    }
    for (let i = 0; i < 15; i++) {
      invoices.push(
        makeInvoice({ id: `inv-hot-${i}`, patientId: "pat-hot", totalAmount: 200 }),
      );
    }
    prismaMock.invoice.findMany.mockResolvedValue(invoices);

    const hits = await detectHighFrequencyPatients(SINCE);

    expect(hits).toHaveLength(1);
    expect(hits[0].type).toBe("HIGH_FREQUENCY_PATIENT");
    expect(hits[0].entityId).toBe("pat-hot");
    expect(hits[0].evidence.invoiceCount).toBe(15);
    expect(hits[0].evidence.totalBilled).toBeCloseTo(3000, 1);
    expect(Array.isArray(hits[0].evidence.sampleInvoiceIds)).toBe(true);
    expect((hits[0].evidence.sampleInvoiceIds as string[]).length).toBeLessThanOrEqual(5);
  });

  it("coerces Prisma.Decimal totals via toNumber()", async () => {
    const decimalLike = { toNumber: () => 250 };
    const invoices: any[] = [];
    for (let p = 1; p <= 5; p++) {
      invoices.push(makeInvoice({ id: `inv-q-${p}`, patientId: `pat-${p}`, totalAmount: decimalLike as any }));
    }
    for (let i = 0; i < 15; i++) {
      invoices.push(
        makeInvoice({ id: `inv-hot-${i}`, patientId: "pat-hot", totalAmount: decimalLike as any }),
      );
    }
    prismaMock.invoice.findMany.mockResolvedValue(invoices);

    const hits = await detectHighFrequencyPatients(SINCE);

    expect(hits).toHaveLength(1);
    expect(hits[0].evidence.totalBilled).toBeCloseTo(15 * 250, 1);
  });

  it("escalates to HIGH_RISK when count ≥ 1.5x cohortThreshold", async () => {
    // Big cohort of 1-invoice patients keeps σ low so cohortThreshold stays
    // moderate, while a 200-invoice outlier clearly clears 1.5×threshold.
    const invoices: any[] = [];
    for (let p = 1; p <= 50; p++) {
      invoices.push(makeInvoice({ id: `inv-q-${p}`, patientId: `pat-${p}` }));
    }
    for (let i = 0; i < 200; i++) {
      invoices.push(makeInvoice({ id: `inv-hr-${i}`, patientId: "pat-hr" }));
    }
    prismaMock.invoice.findMany.mockResolvedValue(invoices);

    const hits = await detectHighFrequencyPatients(SINCE);

    expect(hits).toHaveLength(1);
    expect(hits[0].severity).toBe("HIGH_RISK");
  });

  it("falls back to absolute threshold when stddev is 0", async () => {
    // All patients have exactly 1 invoice → s=0 → cohortThreshold = HIGH_FREQ_INVOICE_THRESHOLD=10.
    const invoices: any[] = [];
    for (let p = 1; p <= 6; p++) {
      invoices.push(makeInvoice({ id: `inv-q-${p}`, patientId: `pat-${p}` }));
    }
    prismaMock.invoice.findMany.mockResolvedValue(invoices);

    expect(await detectHighFrequencyPatients(SINCE)).toEqual([]);
  });

  it("returns [] when no invoices exist", async () => {
    prismaMock.invoice.findMany.mockResolvedValue([]);
    expect(await detectHighFrequencyPatients(SINCE)).toEqual([]);
  });
});

// ─── Rule 4: large refunds ────────────────────────────────────────────────

describe("detectLargeRefunds", () => {
  beforeEach(resetAllMocks);

  it("flags negative-amount payments above absolute threshold", async () => {
    prismaMock.payment.findMany.mockResolvedValue([
      makePayment({ id: "pay-big-refund", amount: -15000, status: "PAID" }),
    ]);

    const hits = await detectLargeRefunds(SINCE);

    expect(hits).toHaveLength(1);
    expect(hits[0].type).toBe("LARGE_REFUND");
    expect(hits[0].severity).toBe("SUSPICIOUS");
    expect(hits[0].evidence.amount).toBe(-15000);
  });

  it("flags REFUNDED-status payments even with positive amount", async () => {
    prismaMock.payment.findMany.mockResolvedValue([
      makePayment({ id: "pay-refunded", amount: 12000, status: "REFUNDED" }),
    ]);

    const hits = await detectLargeRefunds(SINCE);

    expect(hits).toHaveLength(1);
    expect(hits[0].entityId).toBe("pay-refunded");
  });

  it("escalates to HIGH_RISK when refund ≥ 2x threshold (20000)", async () => {
    prismaMock.payment.findMany.mockResolvedValue([
      makePayment({ id: "pay-huge", amount: -25000, status: "REFUNDED" }),
    ]);

    const hits = await detectLargeRefunds(SINCE);

    expect(hits).toHaveLength(1);
    expect(hits[0].severity).toBe("HIGH_RISK");
  });

  it("ignores ordinary PAID positive payments", async () => {
    prismaMock.payment.findMany.mockResolvedValue([
      makePayment({ amount: 50000, status: "PAID" }),
    ]);

    expect(await detectLargeRefunds(SINCE)).toEqual([]);
  });

  it("ignores refunds below the threshold", async () => {
    prismaMock.payment.findMany.mockResolvedValue([
      makePayment({ amount: -9999, status: "REFUNDED" }),
    ]);

    expect(await detectLargeRefunds(SINCE)).toEqual([]);
  });

  it("returns [] when no payments exist", async () => {
    prismaMock.payment.findMany.mockResolvedValue([]);
    expect(await detectLargeRefunds(SINCE)).toEqual([]);
  });
});

// ─── Rule 5: large discounts ──────────────────────────────────────────────

describe("detectLargeDiscounts", () => {
  beforeEach(resetAllMocks);

  it("flags invoices where discount exceeds absolute threshold", async () => {
    prismaMock.invoice.findMany.mockResolvedValue([
      makeInvoice({
        id: "inv-bigdiscount",
        subtotal: 20000,
        discountAmount: 6000,
        totalAmount: 14000,
      }),
    ]);

    const hits = await detectLargeDiscounts(SINCE);

    expect(hits).toHaveLength(1);
    expect(hits[0].type).toBe("LARGE_DISCOUNT");
    expect(hits[0].severity).toBe("SUSPICIOUS");
    expect(hits[0].evidence.discountPct).toBe(30);
  });

  it("flags invoices where discount ≥ percentage threshold even if small in absolute terms", async () => {
    prismaMock.invoice.findMany.mockResolvedValue([
      makeInvoice({
        id: "inv-pct",
        subtotal: 1000,
        discountAmount: 500, // 50% > LARGE_DISCOUNT_PCT=40
        totalAmount: 500,
      }),
    ]);

    const hits = await detectLargeDiscounts(SINCE);

    expect(hits).toHaveLength(1);
    expect(hits[0].severity).toBe("SUSPICIOUS");
    expect(hits[0].evidence.discountPct).toBe(50);
  });

  it("escalates to HIGH_RISK when BOTH absolute and percentage thresholds hit", async () => {
    prismaMock.invoice.findMany.mockResolvedValue([
      makeInvoice({
        id: "inv-double",
        subtotal: 10000,
        discountAmount: 6000, // 60% AND >5000 abs
        totalAmount: 4000,
      }),
    ]);

    const hits = await detectLargeDiscounts(SINCE);

    expect(hits).toHaveLength(1);
    expect(hits[0].severity).toBe("HIGH_RISK");
  });

  it("coerces Prisma.Decimal subtotal/discountAmount via toNumber()", async () => {
    prismaMock.invoice.findMany.mockResolvedValue([
      {
        id: "inv-dec",
        patientId: "pat-dec",
        subtotal: { toNumber: () => 20000, toFixed: (n: number) => (20000).toFixed(n) },
        discountAmount: { toNumber: () => 6000, toFixed: (n: number) => (6000).toFixed(n) },
        totalAmount: { toNumber: () => 14000, toFixed: (n: number) => (14000).toFixed(n) },
        createdAt: DAY,
      },
    ]);

    const hits = await detectLargeDiscounts(SINCE);

    expect(hits).toHaveLength(1);
    expect(hits[0].evidence.discountPct).toBe(30);
  });

  it("ignores invoices below both thresholds", async () => {
    prismaMock.invoice.findMany.mockResolvedValue([
      makeInvoice({
        id: "inv-small",
        subtotal: 10000,
        discountAmount: 1000, // 10% < 40 AND 1000 < 5000
        totalAmount: 9000,
      }),
    ]);

    expect(await detectLargeDiscounts(SINCE)).toEqual([]);
  });

  it("returns [] when there are no discounted invoices", async () => {
    prismaMock.invoice.findMany.mockResolvedValue([]);
    expect(await detectLargeDiscounts(SINCE)).toEqual([]);
  });
});

// ─── Rule 6: generic → brand upsell ───────────────────────────────────────

describe("detectGenericToBrandUpsell", () => {
  beforeEach(resetAllMocks);

  it("flags a doctor whose branded-item rate is ≥ 70% over ≥ 10 items", async () => {
    // 8 branded out of 10 = 80% → SUSPICIOUS.
    const items = [
      ...Array.from({ length: 8 }, () => ({ medicineName: "Crocin 500mg" })),
      ...Array.from({ length: 2 }, () => ({ medicineName: "Paracetamol IP" })),
    ];
    prismaMock.prescription.findMany.mockResolvedValue([
      makePrescription({ doctorId: "doc-upsell", items }),
    ]);

    const hits = await detectGenericToBrandUpsell(SINCE);

    expect(hits).toHaveLength(1);
    expect(hits[0].type).toBe("GENERIC_TO_BRAND_UPSELL");
    expect(hits[0].entityId).toBe("doc-upsell");
    expect(hits[0].severity).toBe("SUSPICIOUS");
    expect(hits[0].evidence.brandRate).toBeCloseTo(0.8, 2);
    expect((hits[0].evidence.sampleBrandedItems as string[]).length).toBeLessThanOrEqual(5);
  });

  it("escalates to HIGH_RISK when brand rate ≥ 90%", async () => {
    const items = Array.from({ length: 10 }, () => ({ medicineName: "Dolo 650" }));
    prismaMock.prescription.findMany.mockResolvedValue([
      makePrescription({ doctorId: "doc-pure-brand", items }),
    ]);

    const hits = await detectGenericToBrandUpsell(SINCE);

    expect(hits).toHaveLength(1);
    expect(hits[0].severity).toBe("HIGH_RISK");
  });

  it("skips doctors with fewer than 10 total items (insufficient signal)", async () => {
    const items = Array.from({ length: 9 }, () => ({ medicineName: "Augmentin 625" }));
    prismaMock.prescription.findMany.mockResolvedValue([
      makePrescription({ doctorId: "doc-thin", items }),
    ]);

    expect(await detectGenericToBrandUpsell(SINCE)).toEqual([]);
  });

  it("does NOT flag a doctor with brand rate < 70%", async () => {
    const items = [
      ...Array.from({ length: 6 }, () => ({ medicineName: "Crocin" })),
      ...Array.from({ length: 4 }, () => ({ medicineName: "Generic Paracetamol" })),
    ];
    prismaMock.prescription.findMany.mockResolvedValue([
      makePrescription({ doctorId: "doc-mid", items }),
    ]);

    expect(await detectGenericToBrandUpsell(SINCE)).toEqual([]);
  });

  it("handles items with null medicineName without crashing", async () => {
    const items = [
      ...Array.from({ length: 10 }, () => ({ medicineName: null })),
    ];
    prismaMock.prescription.findMany.mockResolvedValue([
      makePrescription({ doctorId: "doc-null", items }),
    ]);

    expect(await detectGenericToBrandUpsell(SINCE)).toEqual([]);
  });

  it("returns [] when no prescriptions exist", async () => {
    prismaMock.prescription.findMany.mockResolvedValue([]);
    expect(await detectGenericToBrandUpsell(SINCE)).toEqual([]);
  });
});

// ─── annotateWithLLMReason ────────────────────────────────────────────────

describe("annotateWithLLMReason", () => {
  beforeEach(resetAllMocks);

  it("returns the input unchanged when given an empty list (no LLM call)", async () => {
    const r = await annotateWithLLMReason([]);
    expect(r).toEqual([]);
    expect(generateStructuredMock).not.toHaveBeenCalled();
  });

  it("merges Sarvam reasons into each hit's evidence by index", async () => {
    generateStructuredMock.mockResolvedValue({
      data: {
        reasons: [
          { index: 0, reason: "Same item billed twice; check for re-submission." },
          { index: 1, reason: "Unusual frequency — verify patient identity." },
        ],
      },
    });
    const hits = [
      {
        type: "DUPLICATE_CHARGE" as const,
        severity: "SUSPICIOUS" as const,
        entityType: "Invoice",
        entityId: "inv-1",
        description: "x",
        evidence: { foo: 1 },
      },
      {
        type: "HIGH_FREQUENCY_PATIENT" as const,
        severity: "HIGH_RISK" as const,
        entityType: "Patient",
        entityId: "pat-1",
        description: "y",
        evidence: { bar: 2 },
      },
    ];

    const r = await annotateWithLLMReason(hits);

    expect(r).toHaveLength(2);
    expect(r[0].evidence.llmReason).toMatch(/billed twice/);
    expect(r[0].evidence.foo).toBe(1); // existing evidence preserved
    expect(r[1].evidence.llmReason).toMatch(/Unusual frequency/);
    expect(r[1].evidence.bar).toBe(2);
  });

  it("returns hits unchanged when LLM returns no reasons payload", async () => {
    generateStructuredMock.mockResolvedValue({ data: null });
    const hits = [
      {
        type: "OTHER" as const,
        severity: "INFO" as const,
        entityType: "x",
        entityId: "y",
        description: "z",
        evidence: { keep: true },
      },
    ];

    const r = await annotateWithLLMReason(hits);

    expect(r).toEqual(hits);
  });

  it("leaves a specific hit unchanged when its index is missing from reasons", async () => {
    generateStructuredMock.mockResolvedValue({
      data: { reasons: [{ index: 1, reason: "only the second one" }] },
    });
    const hits = [
      {
        type: "OTHER" as const,
        severity: "INFO" as const,
        entityType: "a",
        entityId: "1",
        description: "d1",
        evidence: {},
      },
      {
        type: "OTHER" as const,
        severity: "INFO" as const,
        entityType: "a",
        entityId: "2",
        description: "d2",
        evidence: {},
      },
    ];

    const r = await annotateWithLLMReason(hits);

    expect(r[0].evidence.llmReason).toBeUndefined();
    expect(r[1].evidence.llmReason).toBe("only the second one");
  });

  it("swallows LLM errors (non-fatal) and returns hits unchanged", async () => {
    generateStructuredMock.mockRejectedValue(new Error("sarvam unreachable"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const hits = [
      {
        type: "OTHER" as const,
        severity: "INFO" as const,
        entityType: "a",
        entityId: "1",
        description: "d1",
        evidence: { x: 1 },
      },
    ];

    const r = await annotateWithLLMReason(hits);

    expect(r).toEqual(hits);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

// ─── detectBillingAnomalies (orchestrator) ────────────────────────────────

describe("detectBillingAnomalies", () => {
  beforeEach(resetAllMocks);

  it("aggregates hits across rules and persists to FraudAlert by default", async () => {
    // Wire up two cheap detectors that each return one hit. The duplicate
    // detector triggers on the broad call; the large-discount detector
    // triggers on the `discountAmount: { gt: 0 }` call.
    prismaMock.invoice.findMany.mockImplementation(async (args: any) => {
      const where = args?.where ?? {};
      // Discount detector uses `discountAmount: { gt: 0 }` plus a `select`.
      if (where.discountAmount && (where.discountAmount.gt === 0 || where.discountAmount.gt != null)) {
        return [
          makeInvoice({ id: "inv-d", subtotal: 10000, discountAmount: 6000, totalAmount: 4000 }),
        ];
      }
      // Both `detectDuplicateCharges` (uses `include: { items: true }`) and
      // `detectHighFrequencyPatients` (uses `select`) hit this branch. Two
      // identical invoices → duplicate flags 1 hit; freq sees 1 patient with
      // 2 invoices (well under threshold) so no hit there.
      return [
        makeInvoice({ id: "inv-A", items: [{ description: "Item", amount: 100 }] }),
        makeInvoice({ id: "inv-B", items: [{ description: "Item", amount: 100 }] }),
      ];
    });
    prismaMock.fraudAlert.create.mockResolvedValue({ id: "alert-1" });

    const r = await detectBillingAnomalies({ windowDays: 30, persist: true, llmReview: false });

    expect(r.windowDays).toBe(30);
    expect(r.hits.length).toBeGreaterThanOrEqual(2); // duplicate + discount
    expect(r.persisted).toBe(r.hits.length);
    expect(typeof r.scannedAt).toBe("string");
    expect(prismaMock.fraudAlert.create).toHaveBeenCalled();
    // Each persisted row carries the contract fields.
    const firstCall = (prismaMock.fraudAlert.create as any).mock.calls[0][0].data;
    expect(firstCall).toHaveProperty("type");
    expect(firstCall).toHaveProperty("severity");
    expect(firstCall).toHaveProperty("status", "OPEN");
    expect(firstCall).toHaveProperty("entityType");
    expect(firstCall).toHaveProperty("entityId");
  });

  it("uses the default 30-day window when none supplied", async () => {
    const r = await detectBillingAnomalies();
    expect(r.windowDays).toBe(30);
  });

  it("honours custom windowDays", async () => {
    const r = await detectBillingAnomalies({ windowDays: 7 });
    expect(r.windowDays).toBe(7);
  });

  it("skips persistence when persist=false (FraudAlert.create never called)", async () => {
    prismaMock.invoice.findMany.mockResolvedValue([
      makeInvoice({ id: "inv-A", items: [{ description: "Same", amount: 200 }] }),
      makeInvoice({ id: "inv-B", items: [{ description: "Same", amount: 200 }] }),
    ]);

    const r = await detectBillingAnomalies({ persist: false });

    expect(r.hits.length).toBeGreaterThanOrEqual(1);
    expect(r.persisted).toBe(0);
    expect(prismaMock.fraudAlert.create).not.toHaveBeenCalled();
  });

  it("invokes the LLM annotator when llmReview=true and merges reasons into evidence", async () => {
    prismaMock.invoice.findMany.mockResolvedValue([
      makeInvoice({ id: "inv-A", items: [{ description: "Same", amount: 200 }] }),
      makeInvoice({ id: "inv-B", items: [{ description: "Same", amount: 200 }] }),
    ]);
    generateStructuredMock.mockResolvedValue({
      data: { reasons: [{ index: 0, reason: "Investigate immediately." }] },
    });

    const r = await detectBillingAnomalies({ persist: false, llmReview: true });

    expect(generateStructuredMock).toHaveBeenCalledTimes(1);
    expect(r.hits[0].evidence.llmReason).toBe("Investigate immediately.");
  });

  it("isolates per-rule errors — one failing detector does not poison the others", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // Make payment.findMany blow up (LARGE_REFUND rule).
    prismaMock.payment.findMany.mockRejectedValue(new Error("payment db down"));
    // Make duplicate detection still produce a hit so the orchestrator returns something.
    prismaMock.invoice.findMany.mockResolvedValue([
      makeInvoice({ id: "inv-A", items: [{ description: "Same", amount: 200 }] }),
      makeInvoice({ id: "inv-B", items: [{ description: "Same", amount: 200 }] }),
    ]);

    const r = await detectBillingAnomalies({ persist: false });

    expect(r.hits.length).toBeGreaterThanOrEqual(1);
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("gracefully degrades when the FraudAlert model is missing (warns, persisted=0)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Stash + delete fraudAlert from the mock for this test.
    const saved = prismaMock.fraudAlert;
    delete prismaMock.fraudAlert;
    prismaMock.invoice.findMany.mockResolvedValue([
      makeInvoice({ id: "inv-A", items: [{ description: "Same", amount: 200 }] }),
      makeInvoice({ id: "inv-B", items: [{ description: "Same", amount: 200 }] }),
    ]);

    try {
      const r = await detectBillingAnomalies({ persist: true });
      expect(r.hits.length).toBeGreaterThanOrEqual(1);
      expect(r.persisted).toBe(0);
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      prismaMock.fraudAlert = saved;
      warnSpy.mockRestore();
    }
  });

  it("continues persisting even when one FraudAlert.create call throws", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    prismaMock.invoice.findMany.mockImplementation(async (args: any) => {
      const where = args?.where ?? {};
      if (where.discountAmount && where.discountAmount.gt != null) {
        return [
          makeInvoice({ id: "inv-d", subtotal: 10000, discountAmount: 6000, totalAmount: 4000 }),
        ];
      }
      return [
        makeInvoice({ id: "inv-A", items: [{ description: "Same", amount: 200 }] }),
        makeInvoice({ id: "inv-B", items: [{ description: "Same", amount: 200 }] }),
      ];
    });
    let calls = 0;
    prismaMock.fraudAlert.create.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) throw new Error("transient");
      return { id: `alert-${calls}` };
    });

    const r = await detectBillingAnomalies({ persist: true });

    expect(r.hits.length).toBeGreaterThanOrEqual(2);
    // One throw, one success → persisted should reflect just the successes.
    expect(r.persisted).toBe(r.hits.length - 1);
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});
