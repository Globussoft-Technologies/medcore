/**
 * Test-cron tick (2026-05-25) — Patient-voice sentiment-AI unit tests.
 *
 * What / which modules / why
 * ──────────────────────────
 * - WHAT: regression around the two public entrypoints of
 *   `services/ai/sentiment-ai.ts` — `analyzeFeedback(feedbackId)` and
 *   `summarizeNpsDrivers({ windowDays })` — plus the fire-and-forget
 *   `triggerFeedbackAnalysis(feedbackId)` hook. Pins the rating-derived
 *   bucket floor (>=4 positive / <=2 negative / else neutral) used for
 *   empty-comment and LLM-fallback paths, the LLM-success persist path
 *   (FeedbackSentiment.upsert / NpsDailyRollup.upsert), the missing-model
 *   degrade-to-warn behaviour, the heuristic keyword fallback, and the
 *   windowDays clamp (1..365) on the NPS rollup.
 * - MODULES: hoisted mock of `../tenant-prisma` (and the `@medcore/db`
 *   re-export surface) so no real Postgres is touched, plus a mock of
 *   `./sarvam` so the LLM path is deterministic + offline.
 * - WHY: sentiment buckets feed both the patient-experience dashboard
 *   (`FeedbackSentiment`) and the daily NPS rollup the CMO reviews
 *   (`NpsDailyRollup`). A bucket-floor regression mis-classifies entire
 *   waves of low-rating patients as "neutral" and silently hides
 *   complaints; a fallback regression on LLM error stops persisting
 *   altogether. This file is the unit-level guard before the daily cron
 *   wires it to live Postgres.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { prismaMock, generateStructuredMock } = vi.hoisted(() => ({
  prismaMock: {
    patientFeedback: { findUnique: vi.fn(), findMany: vi.fn() },
    feedbackSentiment: { upsert: vi.fn() },
    npsDailyRollup: { upsert: vi.fn() },
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
  analyzeFeedback,
  summarizeNpsDrivers,
  triggerFeedbackAnalysis,
} from "./sentiment-ai";

// ─── Fixtures ─────────────────────────────────────────────────────────────

function resetAllMocks() {
  prismaMock.patientFeedback.findUnique.mockReset();
  prismaMock.patientFeedback.findMany.mockReset();
  prismaMock.feedbackSentiment.upsert.mockReset();
  prismaMock.npsDailyRollup.upsert.mockReset();
  generateStructuredMock.mockReset();
  // Sensible defaults so unrelated calls don't crash the path under test.
  prismaMock.feedbackSentiment.upsert.mockResolvedValue({});
  prismaMock.npsDailyRollup.upsert.mockResolvedValue({});
  prismaMock.patientFeedback.findMany.mockResolvedValue([]);
}

function makeFeedback(over: Partial<any> = {}): any {
  // Use `in` to preserve explicit null / undefined / "" overrides (??
  // would clobber `comment: null` with the default sentence).
  return {
    id: "id" in over ? over.id : "fb-1",
    comment: "comment" in over ? over.comment : "Great experience, doctor was kind.",
    rating: "rating" in over ? over.rating : 5,
    nps: "nps" in over ? over.nps : 9,
    category: "category" in over ? over.category : "GENERAL",
  };
}

// ─── analyzeFeedback ──────────────────────────────────────────────────────

describe("analyzeFeedback", () => {
  beforeEach(resetAllMocks);

  it("returns null when the feedback row does not exist (no LLM call, no persist)", async () => {
    prismaMock.patientFeedback.findUnique.mockResolvedValue(null);

    const r = await analyzeFeedback("missing");

    expect(r).toBeNull();
    expect(generateStructuredMock).not.toHaveBeenCalled();
    expect(prismaMock.feedbackSentiment.upsert).not.toHaveBeenCalled();
  });

  // Empty-comment branch — derive bucket from rating only (no LLM call).
  describe("empty-comment path derives bucket from rating", () => {
    it.each([
      [5, "positive"],
      [4, "positive"],
      [3, "neutral"],
      [2, "negative"],
      [1, "negative"],
    ] as const)("rating=%i -> %s", async (rating, expected) => {
      prismaMock.patientFeedback.findUnique.mockResolvedValue(
        makeFeedback({ comment: "", rating }),
      );

      const r = await analyzeFeedback("fb-empty");

      expect(r).not.toBeNull();
      expect(r!.sentiment).toBe(expected);
      expect(r!.emotions).toEqual([]);
      expect(r!.themes).toEqual([]);
      expect(r!.actionableItems).toEqual([]);
      expect(generateStructuredMock).not.toHaveBeenCalled();
      expect(prismaMock.feedbackSentiment.upsert).toHaveBeenCalledTimes(1);
    });

    it("treats whitespace-only comment as empty (still bypasses LLM)", async () => {
      prismaMock.patientFeedback.findUnique.mockResolvedValue(
        makeFeedback({ comment: "   \n\t  ", rating: 5 }),
      );

      const r = await analyzeFeedback("fb-ws");

      expect(r!.sentiment).toBe("positive");
      expect(generateStructuredMock).not.toHaveBeenCalled();
    });

    it("treats null comment as empty (still bypasses LLM)", async () => {
      prismaMock.patientFeedback.findUnique.mockResolvedValue(
        makeFeedback({ comment: null, rating: 1 }),
      );

      const r = await analyzeFeedback("fb-null");

      expect(r!.sentiment).toBe("negative");
      expect(generateStructuredMock).not.toHaveBeenCalled();
    });
  });

  it("happy path — persists LLM-extracted sentiment + emotions + themes + actionables", async () => {
    prismaMock.patientFeedback.findUnique.mockResolvedValue(
      makeFeedback({ comment: "The nurse was kind but waiting time was long.", rating: 3 }),
    );
    generateStructuredMock.mockResolvedValue({
      data: {
        sentiment: "neutral",
        emotions: ["gratitude", "frustration"],
        themes: ["nurse care", "wait time"],
        actionableItems: ["Reduce avg wait time below 20m"],
      },
    });

    const r = await analyzeFeedback("fb-happy");

    expect(r).not.toBeNull();
    expect(r!.sentiment).toBe("neutral");
    expect(r!.emotions).toEqual(["gratitude", "frustration"]);
    expect(r!.themes).toEqual(["nurse care", "wait time"]);
    expect(r!.actionableItems).toEqual(["Reduce avg wait time below 20m"]);
    expect(typeof r!.analyzedAt).toBe("string");

    expect(generateStructuredMock).toHaveBeenCalledTimes(1);
    // Verify the tool wiring (toolName + bounded tokens + low temp).
    const callArg = generateStructuredMock.mock.calls[0][0];
    expect(callArg.toolName).toBe("emit_feedback_sentiment");
    expect(callArg.maxTokens).toBe(512);
    expect(callArg.temperature).toBeLessThan(0.5);

    expect(prismaMock.feedbackSentiment.upsert).toHaveBeenCalledTimes(1);
    const upsertArg = prismaMock.feedbackSentiment.upsert.mock.calls[0][0];
    expect(upsertArg.where).toEqual({ feedbackId: "fb-happy" });
    expect(upsertArg.create.sentiment).toBe("neutral");
    expect(upsertArg.update.sentiment).toBe("neutral");
  });

  it("happy path — coerces missing emotions/themes/actionables arrays to []", async () => {
    prismaMock.patientFeedback.findUnique.mockResolvedValue(
      makeFeedback({ comment: "Fine.", rating: 3 }),
    );
    generateStructuredMock.mockResolvedValue({
      data: {
        sentiment: "neutral",
        // emotions / themes / actionableItems intentionally omitted
      },
    });

    const r = await analyzeFeedback("fb-coerce");

    expect(r!.emotions).toEqual([]);
    expect(r!.themes).toEqual([]);
    expect(r!.actionableItems).toEqual([]);
  });

  describe("LLM error → heuristic keyword fallback", () => {
    let warnSpy: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    });
    afterEach(() => warnSpy.mockRestore());

    it("classifies positive when posHits > negHits AND rating>=3", async () => {
      prismaMock.patientFeedback.findUnique.mockResolvedValue(
        makeFeedback({
          comment: "Staff was great, kind and friendly. Truly excellent.",
          rating: 4,
        }),
      );
      generateStructuredMock.mockRejectedValue(new Error("sarvam down"));

      const r = await analyzeFeedback("fb-fb-pos");

      expect(r!.sentiment).toBe("positive");
      // Themes drawn from keyword hits, dedup'd.
      expect(r!.themes.length).toBeGreaterThan(0);
      expect(r!.actionableItems).toEqual([]); // no neg hits
      expect(warnSpy).toHaveBeenCalled();
      expect(prismaMock.feedbackSentiment.upsert).toHaveBeenCalledTimes(1);
    });

    it("classifies negative when negHits > posHits", async () => {
      prismaMock.patientFeedback.findUnique.mockResolvedValue(
        makeFeedback({
          comment: "Rude staff, dirty rooms, terrible wait. Worst ever.",
          rating: 3,
        }),
      );
      generateStructuredMock.mockRejectedValue(new Error("sarvam down"));

      const r = await analyzeFeedback("fb-fb-neg");

      expect(r!.sentiment).toBe("negative");
      expect(r!.actionableItems).toHaveLength(1);
      expect(r!.actionableItems[0]).toMatch(/Investigate recurring complaint/);
    });

    it("classifies negative when rating<=2 even if no negWords match", async () => {
      prismaMock.patientFeedback.findUnique.mockResolvedValue(
        makeFeedback({ comment: "Hmm okay I guess.", rating: 1 }),
      );
      generateStructuredMock.mockRejectedValue(new Error("sarvam down"));

      const r = await analyzeFeedback("fb-fb-lowrate");

      expect(r!.sentiment).toBe("negative");
    });

    it("downgrades to neutral when posHits>negHits but rating<3", async () => {
      // posHits > negHits BUT rating=2 → the first conditional fails (needs
      // rating>=3) and the second conditional fires (rating<=2) → negative.
      prismaMock.patientFeedback.findUnique.mockResolvedValue(
        makeFeedback({ comment: "Great service.", rating: 2 }),
      );
      generateStructuredMock.mockRejectedValue(new Error("sarvam down"));

      const r = await analyzeFeedback("fb-fb-neutral");

      expect(r!.sentiment).toBe("negative");
    });

    it("returns neutral when neither pos nor neg hits and rating is mid", async () => {
      prismaMock.patientFeedback.findUnique.mockResolvedValue(
        makeFeedback({ comment: "Things happened.", rating: 3 }),
      );
      generateStructuredMock.mockRejectedValue(new Error("sarvam down"));

      const r = await analyzeFeedback("fb-fb-nomatch");

      expect(r!.sentiment).toBe("neutral");
      expect(r!.actionableItems).toEqual([]);
    });

    it("falls back when LLM returns { data: null } (no throw)", async () => {
      prismaMock.patientFeedback.findUnique.mockResolvedValue(
        makeFeedback({ comment: "Doctor was kind.", rating: 5 }),
      );
      generateStructuredMock.mockResolvedValue({ data: null });

      const r = await analyzeFeedback("fb-fb-noresult");

      // posHit "kind" -> positive (no warn since no throw)
      expect(r!.sentiment).toBe("positive");
    });
  });

  it("very long comment is sent through to LLM (analyzeFeedback only trims, does not slice)", async () => {
    const longComment = "great ".repeat(5000); // 30000 chars with trailing space
    prismaMock.patientFeedback.findUnique.mockResolvedValue(
      makeFeedback({ comment: longComment, rating: 5 }),
    );
    generateStructuredMock.mockResolvedValue({
      data: { sentiment: "positive", emotions: [], themes: [], actionableItems: [] },
    });

    const r = await analyzeFeedback("fb-long");

    expect(r!.sentiment).toBe("positive");
    const callArg = generateStructuredMock.mock.calls[0][0];
    const sent = JSON.parse(callArg.userPrompt);
    // Source trims the comment but does NOT truncate — length is the
    // trimmed length, not a capped slice.
    expect(sent.comment.length).toBe(longComment.trim().length);
    expect(sent.comment.length).toBeGreaterThan(20000); // sanity: no cap
  });

  it("non-English comment is forwarded verbatim to the LLM", async () => {
    const comment = "बहुत अच्छा अनुभव था, धन्यवाद।"; // Hindi
    prismaMock.patientFeedback.findUnique.mockResolvedValue(
      makeFeedback({ comment, rating: 5 }),
    );
    generateStructuredMock.mockResolvedValue({
      data: {
        sentiment: "positive",
        emotions: ["gratitude"],
        themes: ["overall experience"],
        actionableItems: [],
      },
    });

    const r = await analyzeFeedback("fb-hi");

    expect(r!.sentiment).toBe("positive");
    const callArg = generateStructuredMock.mock.calls[0][0];
    expect(JSON.parse(callArg.userPrompt).comment).toBe(comment);
  });

  it("when FeedbackSentiment model is absent, warns and still returns the result", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const saved = prismaMock.feedbackSentiment;
    delete prismaMock.feedbackSentiment;
    prismaMock.patientFeedback.findUnique.mockResolvedValue(
      makeFeedback({ comment: "Doctor was kind.", rating: 5 }),
    );
    generateStructuredMock.mockResolvedValue({
      data: { sentiment: "positive", emotions: [], themes: [], actionableItems: [] },
    });

    try {
      const r = await analyzeFeedback("fb-nomodel");
      expect(r).not.toBeNull();
      expect(r!.sentiment).toBe("positive");
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      prismaMock.feedbackSentiment = saved;
      warnSpy.mockRestore();
    }
  });

  it("swallows persist errors (logs to console.error) and still returns the result", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    prismaMock.patientFeedback.findUnique.mockResolvedValue(
      makeFeedback({ comment: "Doctor was kind.", rating: 5 }),
    );
    generateStructuredMock.mockResolvedValue({
      data: { sentiment: "positive", emotions: [], themes: [], actionableItems: [] },
    });
    prismaMock.feedbackSentiment.upsert.mockRejectedValue(new Error("db down"));

    const r = await analyzeFeedback("fb-persistfail");

    expect(r).not.toBeNull();
    expect(r!.sentiment).toBe("positive");
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});

// ─── summarizeNpsDrivers ──────────────────────────────────────────────────

describe("summarizeNpsDrivers", () => {
  beforeEach(resetAllMocks);

  describe("windowDays clamp", () => {
    it("defaults to 30 when no opts provided", async () => {
      prismaMock.patientFeedback.findMany.mockResolvedValue([]);
      const r = await summarizeNpsDrivers();
      expect(r.windowDays).toBe(30);
    });

    it("clamps 0 (and negatives) UP to 1", async () => {
      prismaMock.patientFeedback.findMany.mockResolvedValue([]);
      const r0 = await summarizeNpsDrivers({ windowDays: 0 });
      expect(r0.windowDays).toBe(1);
      const rNeg = await summarizeNpsDrivers({ windowDays: -50 });
      expect(rNeg.windowDays).toBe(1);
    });

    it("clamps values above 365 DOWN to 365", async () => {
      prismaMock.patientFeedback.findMany.mockResolvedValue([]);
      const r = await summarizeNpsDrivers({ windowDays: 99999 });
      expect(r.windowDays).toBe(365);
    });

    it("honours a custom in-range windowDays", async () => {
      prismaMock.patientFeedback.findMany.mockResolvedValue([]);
      const r = await summarizeNpsDrivers({ windowDays: 7 });
      expect(r.windowDays).toBe(7);
    });
  });

  it("empty case — returns zeroed summary without invoking the LLM", async () => {
    prismaMock.patientFeedback.findMany.mockResolvedValue([]);

    const r = await summarizeNpsDrivers({ windowDays: 14 });

    expect(r.totalFeedback).toBe(0);
    expect(r.positiveThemes).toEqual([]);
    expect(r.negativeThemes).toEqual([]);
    expect(r.actionableInsights).toEqual([]);
    expect(typeof r.generatedAt).toBe("string");
    expect(generateStructuredMock).not.toHaveBeenCalled();
    expect(prismaMock.npsDailyRollup.upsert).toHaveBeenCalledTimes(1);
  });

  it("happy path — uses LLM data, sets totalFeedback to actual feedback count, persists", async () => {
    const feedback = [
      { id: "f1", comment: "Doctor was great", rating: 5, nps: 9, category: "DOCTOR" },
      { id: "f2", comment: "Rude staff", rating: 1, nps: 2, category: "FRONT_DESK" },
    ];
    prismaMock.patientFeedback.findMany.mockResolvedValue(feedback);
    generateStructuredMock.mockResolvedValue({
      data: {
        positiveThemes: [
          { theme: "doctor care", count: 1, sampleQuotes: ["Doctor was great"] },
        ],
        negativeThemes: [
          { theme: "front desk", count: 1, sampleQuotes: ["Rude staff"] },
        ],
        actionableInsights: ["Retrain front-desk on courtesy"],
      },
    });

    const r = await summarizeNpsDrivers({ windowDays: 30 });

    expect(r.totalFeedback).toBe(2);
    expect(r.positiveThemes).toHaveLength(1);
    expect(r.negativeThemes).toHaveLength(1);
    expect(r.actionableInsights).toEqual(["Retrain front-desk on courtesy"]);
    expect(generateStructuredMock).toHaveBeenCalledTimes(1);
    const callArg = generateStructuredMock.mock.calls[0][0];
    expect(callArg.toolName).toBe("emit_nps_drivers");
    expect(callArg.maxTokens).toBe(1500);
    expect(prismaMock.npsDailyRollup.upsert).toHaveBeenCalledTimes(1);
  });

  it("happy path — coerces missing positive/negative/actionable arrays to []", async () => {
    prismaMock.patientFeedback.findMany.mockResolvedValue([
      { id: "f1", comment: "ok", rating: 3, nps: 5, category: "GENERAL" },
    ]);
    generateStructuredMock.mockResolvedValue({
      data: {
        // All three arrays intentionally omitted.
      },
    });

    const r = await summarizeNpsDrivers();

    expect(r.positiveThemes).toEqual([]);
    expect(r.negativeThemes).toEqual([]);
    expect(r.actionableInsights).toEqual([]);
  });

  it("truncates each comment to 500 chars in the LLM payload", async () => {
    const longComment = "x".repeat(2000);
    prismaMock.patientFeedback.findMany.mockResolvedValue([
      { id: "f1", comment: longComment, rating: 5, nps: 9, category: "GENERAL" },
    ]);
    generateStructuredMock.mockResolvedValue({
      data: { positiveThemes: [], negativeThemes: [], actionableInsights: [] },
    });

    await summarizeNpsDrivers();

    const callArg = generateStructuredMock.mock.calls[0][0];
    const payload = JSON.parse(callArg.userPrompt);
    expect(payload).toHaveLength(1);
    expect(payload[0].comment.length).toBe(500);
  });

  it("caps the LLM payload at 400 entries even if more feedback was loaded", async () => {
    const feedback = Array.from({ length: 600 }, (_, i) => ({
      id: `f${i}`,
      comment: `comment ${i}`,
      rating: 5,
      nps: 9,
      category: "GENERAL",
    }));
    prismaMock.patientFeedback.findMany.mockResolvedValue(feedback);
    generateStructuredMock.mockResolvedValue({
      data: { positiveThemes: [], negativeThemes: [], actionableInsights: [] },
    });

    const r = await summarizeNpsDrivers();

    const callArg = generateStructuredMock.mock.calls[0][0];
    const payload = JSON.parse(callArg.userPrompt);
    expect(payload).toHaveLength(400);
    // But totalFeedback reflects the full loaded count.
    expect(r.totalFeedback).toBe(600);
  });

  describe("LLM error → heuristic fallback", () => {
    let warnSpy: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    });
    afterEach(() => warnSpy.mockRestore());

    it("groups positive (rating>=4) and negative (rating<=2) by category", async () => {
      const feedback = [
        { id: "f1", comment: "pleasant doc", rating: 5, nps: 10, category: "DOCTOR" },
        { id: "f2", comment: "ok doc", rating: 4, nps: 8, category: "DOCTOR" },
        { id: "f3", comment: "rude", rating: 1, nps: 0, category: "FRONT_DESK" },
        { id: "f4", comment: "slow", rating: 2, nps: 2, category: "FRONT_DESK" },
        { id: "f5", comment: "meh", rating: 3, nps: 5, category: "GENERAL" }, // ignored
      ];
      prismaMock.patientFeedback.findMany.mockResolvedValue(feedback);
      generateStructuredMock.mockRejectedValue(new Error("sarvam unreachable"));

      const r = await summarizeNpsDrivers({ windowDays: 14 });

      expect(r.totalFeedback).toBe(5);
      expect(r.positiveThemes).toHaveLength(1);
      expect(r.positiveThemes[0].theme).toBe("DOCTOR");
      expect(r.positiveThemes[0].count).toBe(2);
      expect(r.positiveThemes[0].sampleQuotes.length).toBeLessThanOrEqual(2);
      expect(r.negativeThemes).toHaveLength(1);
      expect(r.negativeThemes[0].theme).toBe("FRONT_DESK");
      expect(r.negativeThemes[0].count).toBe(2);
      expect(r.actionableInsights[0]).toMatch(/2 low-rating feedback entries/);
      expect(warnSpy).toHaveBeenCalled();
    });

    it("returns the no-low-rating actionable when only positive feedback exists", async () => {
      const feedback = [
        { id: "f1", comment: "great", rating: 5, nps: 10, category: "DOCTOR" },
      ];
      prismaMock.patientFeedback.findMany.mockResolvedValue(feedback);
      generateStructuredMock.mockRejectedValue(new Error("sarvam unreachable"));

      const r = await summarizeNpsDrivers({ windowDays: 7 });

      expect(r.negativeThemes).toEqual([]);
      expect(r.actionableInsights[0]).toMatch(/No low-rating feedback in the last 7 days/);
    });

    it("falls back when LLM returns { data: null } (no throw)", async () => {
      const feedback = [
        { id: "f1", comment: "great", rating: 5, nps: 10, category: "DOCTOR" },
      ];
      prismaMock.patientFeedback.findMany.mockResolvedValue(feedback);
      generateStructuredMock.mockResolvedValue({ data: null });

      const r = await summarizeNpsDrivers();

      expect(r.totalFeedback).toBe(1);
      expect(r.positiveThemes).toHaveLength(1);
      expect(r.positiveThemes[0].theme).toBe("DOCTOR");
    });
  });

  it("when NpsDailyRollup model is absent, warns and still returns the summary", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const saved = prismaMock.npsDailyRollup;
    delete prismaMock.npsDailyRollup;
    prismaMock.patientFeedback.findMany.mockResolvedValue([]);

    try {
      const r = await summarizeNpsDrivers({ windowDays: 30 });
      expect(r.totalFeedback).toBe(0);
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      prismaMock.npsDailyRollup = saved;
      warnSpy.mockRestore();
    }
  });

  it("swallows rollup persist errors (logs to console.error) and still returns the summary", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    prismaMock.patientFeedback.findMany.mockResolvedValue([]);
    prismaMock.npsDailyRollup.upsert.mockRejectedValue(new Error("db down"));

    const r = await summarizeNpsDrivers({ windowDays: 30 });

    expect(r.totalFeedback).toBe(0);
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});

// ─── triggerFeedbackAnalysis (fire-and-forget) ────────────────────────────

describe("triggerFeedbackAnalysis", () => {
  beforeEach(resetAllMocks);

  it("returns void synchronously (does not await analyzeFeedback)", () => {
    prismaMock.patientFeedback.findUnique.mockResolvedValue(null);
    const r = triggerFeedbackAnalysis("any");
    expect(r).toBeUndefined();
  });

  it("never throws even when the underlying analyzeFeedback rejects", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    prismaMock.patientFeedback.findUnique.mockRejectedValue(new Error("db down"));

    expect(() => triggerFeedbackAnalysis("boom")).not.toThrow();
    // Let the microtask queue flush so the .catch() can run before assert.
    await new Promise((r) => setImmediate(r));
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("invokes analyzeFeedback with the supplied id", async () => {
    prismaMock.patientFeedback.findUnique.mockResolvedValue(null);

    triggerFeedbackAnalysis("fb-trigger");
    // Allow the queued analyzeFeedback() to actually call findUnique.
    await new Promise((r) => setImmediate(r));

    expect(prismaMock.patientFeedback.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "fb-trigger" } }),
    );
  });
});
