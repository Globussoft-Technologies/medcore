/**
 * Test-cron tick (2026-05-25) — Documentation-QA service unit tests.
 *
 * What / which modules / why
 * ──────────────────────────
 * - WHAT: regression around the three exported entry points of the doc-QA
 *   service — `sampleConsultationsForQA` (random sampling of recent
 *   consultations with `samplePct` / `windowDays` / `max` clamps),
 *   `auditConsultation` (LLM-graded report with deterministic heuristic
 *   fallback + best-effort persistence to `DocQAReport`), and the daily
 *   batch driver `runDailyDocQASample`. Pins null-return on missing
 *   consultations, score-rounding contract, heuristic shape when LLM
 *   throws, missing-model graceful degrade for persistence, and
 *   per-sample error isolation in the orchestrator.
 * - MODULES: hoisted mock of `../tenant-prisma` (which re-exports from
 *   `@medcore/db`) so no real Postgres is touched + a mock of `./sarvam`
 *   so the LLM call is deterministic and offline. Mirrors the shape used
 *   by `fraud-detection.test.ts` so the suite stays consistent.
 * - WHY: doc-QA writes `DocQAReport` rows the audit screen treats as
 *   ground-truth quality grades. Wrong fallback path = silent zero-coverage
 *   regression; wrong score rounding = drifting dashboards. This is the
 *   unit-level guard before the daily scheduler wires it to live Postgres.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { prismaMock, generateStructuredMock } = vi.hoisted(() => ({
  prismaMock: {
    consultation: { findMany: vi.fn(), findUnique: vi.fn() },
    docQAReport: { upsert: vi.fn() } as any,
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
  sampleConsultationsForQA,
  auditConsultation,
  runDailyDocQASample,
} from "./doc-qa";

// ─── Fixtures ─────────────────────────────────────────────────────────────

function makeConsultationRow(over: Partial<any> = {}): any {
  return {
    id: over.id ?? "cons-1",
    doctorId: over.doctorId ?? "doc-1",
    createdAt: over.createdAt ?? new Date("2026-05-20T10:00:00Z"),
  };
}

function makeConsultationDetail(over: Partial<any> = {}): any {
  return {
    id: over.id ?? "cons-1",
    notes: over.notes ?? "Patient reports headache for 3 days, mild fever.",
    findings: over.findings ?? "BP 120/80, throat clear, no neck stiffness.",
    appointment:
      over.appointment === undefined
        ? {
            prescription: {
              diagnosis: over.diagnosis ?? "Viral fever (J11.1)",
              advice: over.advice ?? "Rest 3 days. Hydrate. Return if worse.",
              items: over.items ?? [
                { medicineName: "Paracetamol", dosage: "500mg", frequency: "TID", duration: "3d" },
              ],
            },
          }
        : over.appointment,
  };
}

function resetAllMocks() {
  prismaMock.consultation.findMany.mockReset();
  prismaMock.consultation.findUnique.mockReset();
  prismaMock.docQAReport.upsert.mockReset();
  generateStructuredMock.mockReset();
  prismaMock.consultation.findMany.mockResolvedValue([]);
  prismaMock.consultation.findUnique.mockResolvedValue(null);
  prismaMock.docQAReport.upsert.mockResolvedValue({ id: "rep-1" });
}

// ─── sampleConsultationsForQA ─────────────────────────────────────────────

describe("sampleConsultationsForQA", () => {
  beforeEach(resetAllMocks);

  it("returns [] when there are no consultations in the window", async () => {
    prismaMock.consultation.findMany.mockResolvedValue([]);
    const r = await sampleConsultationsForQA();
    expect(r).toEqual([]);
  });

  it("samples ~samplePct of the rows (ceil), deduplicated, capped by `max`", async () => {
    // 100 consultations, default samplePct=10 → ceil(100*10/100) = 10 picks.
    const rows = Array.from({ length: 100 }, (_, i) =>
      makeConsultationRow({ id: `c-${i}` }),
    );
    prismaMock.consultation.findMany.mockResolvedValue(rows);

    const r = await sampleConsultationsForQA();

    expect(r.length).toBe(10);
    // All picks must be from the original set and unique.
    const ids = new Set(r.map((x) => x.id));
    expect(ids.size).toBe(r.length);
    for (const x of r) expect(rows).toContain(x);
  });

  it("clamps samplePct into [1, 100] (200 → 100 = entire population)", async () => {
    const rows = Array.from({ length: 5 }, (_, i) =>
      makeConsultationRow({ id: `c-${i}` }),
    );
    prismaMock.consultation.findMany.mockResolvedValue(rows);

    const r = await sampleConsultationsForQA({ samplePct: 200 });

    expect(r.length).toBe(5);
  });

  it("clamps samplePct floor (0 → 1 → at least one pick)", async () => {
    const rows = Array.from({ length: 50 }, (_, i) =>
      makeConsultationRow({ id: `c-${i}` }),
    );
    prismaMock.consultation.findMany.mockResolvedValue(rows);

    const r = await sampleConsultationsForQA({ samplePct: 0 });

    // samplePct clamped to 1 → ceil(50 * 1 / 100) = 1 pick.
    expect(r.length).toBe(1);
  });

  it("honours `max` cap even when samplePct would yield more", async () => {
    const rows = Array.from({ length: 1000 }, (_, i) =>
      makeConsultationRow({ id: `c-${i}` }),
    );
    prismaMock.consultation.findMany.mockResolvedValue(rows);

    // 50% of 1000 = 500 desired, but max=10 should cap it.
    const r = await sampleConsultationsForQA({ samplePct: 50, max: 10 });

    expect(r.length).toBe(10);
  });

  it("applies the `windowDays` clamp [1, 90] to the `createdAt` filter", async () => {
    prismaMock.consultation.findMany.mockResolvedValue([]);

    await sampleConsultationsForQA({ windowDays: 1000 });

    const call = prismaMock.consultation.findMany.mock.calls[0][0];
    const since = call.where.createdAt.gte as Date;
    const expected = new Date();
    expected.setDate(expected.getDate() - 90);
    // Within ~2s tolerance (test execution drift).
    expect(Math.abs(since.getTime() - expected.getTime())).toBeLessThan(2000);
  });

  it("requests a bounded page (take: 5000) and minimal projection", async () => {
    prismaMock.consultation.findMany.mockResolvedValue([]);

    await sampleConsultationsForQA();

    const call = prismaMock.consultation.findMany.mock.calls[0][0];
    expect(call.take).toBe(5000);
    expect(call.select).toEqual({ id: true, doctorId: true, createdAt: true });
  });
});

// ─── auditConsultation ────────────────────────────────────────────────────

describe("auditConsultation", () => {
  beforeEach(resetAllMocks);

  it("returns null when the consultation does not exist", async () => {
    prismaMock.consultation.findUnique.mockResolvedValue(null);

    const r = await auditConsultation("missing-id");

    expect(r).toBeNull();
    expect(generateStructuredMock).not.toHaveBeenCalled();
    expect(prismaMock.docQAReport.upsert).not.toHaveBeenCalled();
  });

  it("returns the LLM-graded report and persists it on success", async () => {
    prismaMock.consultation.findUnique.mockResolvedValue(makeConsultationDetail());
    generateStructuredMock.mockResolvedValue({
      data: {
        score: 87.6,
        completenessScore: 90,
        icdAccuracyScore: 85.4,
        medicationScore: 88,
        clarityScore: 86.9,
        issues: [
          { category: "CLARITY", severity: "LOW", description: "Minor handwriting note" },
        ],
        recommendations: ["Add follow-up date."],
      },
    });

    const r = await auditConsultation("cons-1");

    expect(r).not.toBeNull();
    expect(r!.consultationId).toBe("cons-1");
    // Scores must be rounded to integers.
    expect(r!.score).toBe(88);
    expect(r!.completenessScore).toBe(90);
    expect(r!.icdAccuracyScore).toBe(85);
    expect(r!.clarityScore).toBe(87);
    expect(r!.issues).toHaveLength(1);
    expect(r!.recommendations[0]).toMatch(/follow-up/);
    expect(typeof r!.auditedAt).toBe("string");
    expect(() => new Date(r!.auditedAt).toISOString()).not.toThrow();

    expect(prismaMock.docQAReport.upsert).toHaveBeenCalledTimes(1);
    const upsertArg = prismaMock.docQAReport.upsert.mock.calls[0][0];
    expect(upsertArg.where).toEqual({ consultationId: "cons-1" });
    expect(upsertArg.create.score).toBe(88);
    expect(upsertArg.create.auditedBy).toBe("SYSTEM");
    expect(upsertArg.update.score).toBe(88);
  });

  it("defaults issues/recommendations to [] when LLM omits them", async () => {
    prismaMock.consultation.findUnique.mockResolvedValue(makeConsultationDetail());
    generateStructuredMock.mockResolvedValue({
      data: {
        score: 80,
        completenessScore: 80,
        icdAccuracyScore: 80,
        medicationScore: 80,
        clarityScore: 80,
        // issues + recommendations missing.
      },
    });

    const r = await auditConsultation("cons-1");

    expect(r!.issues).toEqual([]);
    expect(r!.recommendations).toEqual([]);
  });

  it("falls back to the heuristic when LLM throws (warns; persists fallback report)", async () => {
    prismaMock.consultation.findUnique.mockResolvedValue(makeConsultationDetail());
    generateStructuredMock.mockRejectedValue(new Error("sarvam down"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const r = await auditConsultation("cons-1");

    try {
      expect(r).not.toBeNull();
      expect(r!.consultationId).toBe("cons-1");
      // Heuristic with fully-populated notes/findings/diagnosis/advice +
      // medication present + diagnosis>5 chars + notes>40 chars:
      // completeness = 25*4 = 100; icd = 70; medication = 70; clarity = 80
      // score = round((100+70+70+80)/4) = 80
      expect(r!.completenessScore).toBe(100);
      expect(r!.icdAccuracyScore).toBe(70);
      expect(r!.medicationScore).toBe(70);
      expect(r!.clarityScore).toBe(80);
      expect(r!.score).toBe(80);
      expect(r!.issues).toEqual([]);
      expect(r!.recommendations[0]).toMatch(/baseline/i);
      expect(warnSpy).toHaveBeenCalled();
      expect(prismaMock.docQAReport.upsert).toHaveBeenCalledTimes(1);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("heuristic returns null-data fallback also (LLM returns no data → heuristic)", async () => {
    prismaMock.consultation.findUnique.mockResolvedValue(makeConsultationDetail());
    generateStructuredMock.mockResolvedValue({ data: null });

    const r = await auditConsultation("cons-1");

    expect(r).not.toBeNull();
    // Heuristic path → score derived from fixture (same shape as above).
    expect(r!.score).toBe(80);
  });

  it("heuristic flags HIGH-severity gaps when key sections are empty", async () => {
    prismaMock.consultation.findUnique.mockResolvedValue(
      makeConsultationDetail({
        notes: "",
        findings: "",
        appointment: {
          prescription: { diagnosis: "", advice: "", items: [] },
        },
      }),
    );
    generateStructuredMock.mockRejectedValue(new Error("force-fallback"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const r = await auditConsultation("cons-1");

      expect(r).not.toBeNull();
      // Each section empty → completeness 0, icd 30, medication 40, clarity 50.
      expect(r!.completenessScore).toBe(0);
      expect(r!.icdAccuracyScore).toBe(30);
      expect(r!.medicationScore).toBe(40);
      expect(r!.clarityScore).toBe(50);
      expect(r!.score).toBe(Math.round((0 + 30 + 40 + 50) / 4));
      // Two HIGH issues (notes + diagnosis missing); medication issue only
      // fires when there's a diagnosis but no meds — here diagnosis is also
      // empty so it's skipped.
      const high = r!.issues.filter((i) => i.severity === "HIGH");
      expect(high.length).toBeGreaterThanOrEqual(2);
      expect(r!.issues.some((i) => i.category === "COMPLETENESS")).toBe(true);
      expect(r!.issues.some((i) => i.category === "ICD")).toBe(true);
      expect(r!.recommendations.length).toBe(r!.issues.length);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("heuristic flags MEDICATION gap when diagnosis present but no meds charted", async () => {
    prismaMock.consultation.findUnique.mockResolvedValue(
      makeConsultationDetail({
        notes: "short note",
        findings: "minor finding",
        appointment: {
          prescription: { diagnosis: "Diabetes mellitus type 2", advice: "diet", items: [] },
        },
      }),
    );
    generateStructuredMock.mockRejectedValue(new Error("force-fallback"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const r = await auditConsultation("cons-1");

      expect(r).not.toBeNull();
      const medIssue = r!.issues.find((i) => i.category === "MEDICATION");
      expect(medIssue).toBeDefined();
      expect(medIssue!.severity).toBe("MEDIUM");
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("handles consultations without an appointment/prescription (empty meds, empty diagnosis)", async () => {
    prismaMock.consultation.findUnique.mockResolvedValue(
      makeConsultationDetail({ appointment: null }),
    );
    generateStructuredMock.mockRejectedValue(new Error("force-fallback"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const r = await auditConsultation("cons-1");

      expect(r).not.toBeNull();
      // notes + findings populated; diagnosis + advice empty → completeness = 50.
      expect(r!.completenessScore).toBe(50);
      expect(r!.icdAccuracyScore).toBe(30);
      expect(r!.medicationScore).toBe(40);
      // Notes from fixture is > 40 chars → clarity = 80.
      expect(r!.clarityScore).toBe(80);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("gracefully degrades when DocQAReport model is missing (warns; still returns report)", async () => {
    prismaMock.consultation.findUnique.mockResolvedValue(makeConsultationDetail());
    generateStructuredMock.mockResolvedValue({
      data: {
        score: 70,
        completenessScore: 70,
        icdAccuracyScore: 70,
        medicationScore: 70,
        clarityScore: 70,
        issues: [],
        recommendations: [],
      },
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const saved = prismaMock.docQAReport;
    delete prismaMock.docQAReport;

    try {
      const r = await auditConsultation("cons-1");

      expect(r).not.toBeNull();
      expect(r!.score).toBe(70);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("DocQAReport model not present"),
      );
    } finally {
      prismaMock.docQAReport = saved;
      warnSpy.mockRestore();
    }
  });

  it("swallows persistence errors (errors logged; report still returned)", async () => {
    prismaMock.consultation.findUnique.mockResolvedValue(makeConsultationDetail());
    generateStructuredMock.mockResolvedValue({
      data: {
        score: 75,
        completenessScore: 75,
        icdAccuracyScore: 75,
        medicationScore: 75,
        clarityScore: 75,
        issues: [],
        recommendations: [],
      },
    });
    prismaMock.docQAReport.upsert.mockRejectedValue(new Error("db unreachable"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const r = await auditConsultation("cons-1");

      expect(r).not.toBeNull();
      expect(r!.score).toBe(75);
      expect(errSpy).toHaveBeenCalledWith(
        expect.stringContaining("persist failed"),
        expect.any(String),
      );
    } finally {
      errSpy.mockRestore();
    }
  });

  it("submits the correct LLM tool name + score-range schema to Sarvam", async () => {
    prismaMock.consultation.findUnique.mockResolvedValue(makeConsultationDetail());
    generateStructuredMock.mockResolvedValue({
      data: {
        score: 80,
        completenessScore: 80,
        icdAccuracyScore: 80,
        medicationScore: 80,
        clarityScore: 80,
        issues: [],
        recommendations: [],
      },
    });

    await auditConsultation("cons-1");

    expect(generateStructuredMock).toHaveBeenCalledTimes(1);
    const opts = generateStructuredMock.mock.calls[0][0];
    expect(opts.toolName).toBe("emit_doc_qa_report");
    expect(opts.temperature).toBe(0.1);
    expect(opts.maxTokens).toBe(1024);
    expect(opts.parameters.required).toEqual(
      expect.arrayContaining([
        "score",
        "completenessScore",
        "icdAccuracyScore",
        "medicationScore",
        "clarityScore",
        "issues",
        "recommendations",
      ]),
    );
    // The user prompt is the JSON-serialized payload, so it must round-trip.
    const parsed = JSON.parse(opts.userPrompt);
    expect(parsed).toHaveProperty("notes");
    expect(parsed).toHaveProperty("medications");
    expect(Array.isArray(parsed.medications)).toBe(true);
    expect(parsed.medications[0]).toMatch(/Paracetamol/);
  });
});

// ─── runDailyDocQASample ──────────────────────────────────────────────────

describe("runDailyDocQASample", () => {
  beforeEach(resetAllMocks);
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns {sampled:0, audited:0} when no consultations in window", async () => {
    prismaMock.consultation.findMany.mockResolvedValue([]);

    const r = await runDailyDocQASample();

    expect(r).toEqual({ sampled: 0, audited: 0 });
  });

  it("counts a successful audit per sampled consultation", async () => {
    // 10 candidate consultations → default samplePct=10 → 1 sampled.
    const rows = Array.from({ length: 10 }, (_, i) =>
      makeConsultationRow({ id: `c-${i}` }),
    );
    prismaMock.consultation.findMany.mockResolvedValue(rows);
    prismaMock.consultation.findUnique.mockImplementation(async ({ where }: any) =>
      makeConsultationDetail({ id: where.id }),
    );
    generateStructuredMock.mockResolvedValue({
      data: {
        score: 80,
        completenessScore: 80,
        icdAccuracyScore: 80,
        medicationScore: 80,
        clarityScore: 80,
        issues: [],
        recommendations: [],
      },
    });

    const r = await runDailyDocQASample();

    expect(r.sampled).toBe(1);
    expect(r.audited).toBe(1);
  });

  it("does not count an audit when consultation lookup returns null", async () => {
    prismaMock.consultation.findMany.mockResolvedValue([
      makeConsultationRow({ id: "c-vanished" }),
    ]);
    prismaMock.consultation.findUnique.mockResolvedValue(null);

    const r = await runDailyDocQASample({ samplePct: 100 });

    expect(r.sampled).toBe(1);
    expect(r.audited).toBe(0);
  });

  it("isolates per-sample errors — one throw does not poison the batch", async () => {
    const rows = [
      makeConsultationRow({ id: "c-bad" }),
      makeConsultationRow({ id: "c-good" }),
    ];
    prismaMock.consultation.findMany.mockResolvedValue(rows);
    // First findUnique throws; second returns a valid detail.
    prismaMock.consultation.findUnique
      .mockRejectedValueOnce(new Error("transient db error"))
      .mockResolvedValueOnce(makeConsultationDetail({ id: "c-good" }));
    generateStructuredMock.mockResolvedValue({
      data: {
        score: 80,
        completenessScore: 80,
        icdAccuracyScore: 80,
        medicationScore: 80,
        clarityScore: 80,
        issues: [],
        recommendations: [],
      },
    });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const r = await runDailyDocQASample({ samplePct: 100 });

    expect(r.sampled).toBe(2);
    // Exactly one succeeded.
    expect(r.audited).toBe(1);
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("forwards samplePct and windowDays to the underlying sampler", async () => {
    prismaMock.consultation.findMany.mockResolvedValue([]);

    await runDailyDocQASample({ samplePct: 25, windowDays: 3 });

    const findManyArgs = prismaMock.consultation.findMany.mock.calls[0][0];
    const since = findManyArgs.where.createdAt.gte as Date;
    const expected = new Date();
    expected.setDate(expected.getDate() - 3);
    expect(Math.abs(since.getTime() - expected.getTime())).toBeLessThan(2000);
  });

  it("defaults to windowDays=1 (one-day rolling window)", async () => {
    prismaMock.consultation.findMany.mockResolvedValue([]);

    await runDailyDocQASample();

    const findManyArgs = prismaMock.consultation.findMany.mock.calls[0][0];
    const since = findManyArgs.where.createdAt.gte as Date;
    const expected = new Date();
    expected.setDate(expected.getDate() - 1);
    expect(Math.abs(since.getTime() - expected.getTime())).toBeLessThan(2000);
  });
});
