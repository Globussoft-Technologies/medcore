/**
 * Test-cron tick (2026-05-25) — ML feature-extractor unit tests.
 *
 * What / which modules / why
 * ──────────────────────────
 * - WHAT: pure unit coverage for `extractFeatures`, `riskBucket`, and
 *   `explainFeatures` from `feature-extractor.ts`. Pins the stable feature
 *   ORDER (any swap breaks model weights trained against
 *   `NO_SHOW_FEATURE_VERSION = 1`), the Laplace-smoothed history rate, the
 *   lead-time 0..90 clamp, day-of-week + hour-of-day encodings, the 5-bucket
 *   age one-hot (incl. unknown→adult fallback), the 90-day recent-no-show
 *   window, the appointment-type one-hot, and distance clamping. Also covers
 *   every branch of the human-readable `explainFeatures` factor list.
 * - MODULES: no Prisma, no LLM, no HTTP — `feature-extractor.ts` is a pure
 *   math module. No vi.mock() needed. Reference times are passed in
 *   explicitly via the `now` parameter for deterministic 90-day windowing.
 * - WHY: the no-show predictor (`/ai/predictions`) calls these in-line for
 *   every appointment scored. Feature-order regressions or off-by-one bucket
 *   errors silently corrupt every prediction without a thrown error, so the
 *   suite locks the array shape + branch coverage as a contract.
 */
import { describe, it, expect } from "vitest";
import {
  extractFeatures,
  riskBucket,
  explainFeatures,
  FEATURE_NAMES,
  NUM_FEATURES,
  NO_SHOW_FEATURE_VERSION,
  type FeatureInput,
  type PastAppointmentSummary,
} from "./feature-extractor";

// ─── Fixtures ──────────────────────────────────────────────────────────────

// Tuesday 2026-05-12 at 10:30 IST/UTC (UTC date used so getDay() is stable
// regardless of CI tz). 2026-05-12 is a Tuesday (UTC). Created 5 days earlier.
const REF_NOW = new Date("2026-05-12T12:00:00Z");

function baseInput(over: Partial<FeatureInput> = {}): FeatureInput {
  // Use spread so an explicit `null`/`undefined` override survives — `??`
  // would coerce it back to the default and defeat the null-branch tests.
  return {
    createdAt: new Date("2026-05-07T10:00:00Z"),
    date: new Date("2026-05-12T10:00:00Z"), // Tuesday
    slotStart: "10:30",
    type: "SCHEDULED",
    patientAge: 40,
    patientAddress: "12 MG Road, Bengaluru",
    distanceKm: 8,
    pastAppointments: [],
    ...over,
  };
}

// Index map so assertions stay readable even when the array shape grows.
const IDX = FEATURE_NAMES.reduce<Record<string, number>>((acc, name, i) => {
  acc[name] = i;
  return acc;
}, {});

// ─── Module-level constants ────────────────────────────────────────────────

describe("module constants", () => {
  it("NUM_FEATURES matches FEATURE_NAMES length (contract)", () => {
    expect(NUM_FEATURES).toBe(FEATURE_NAMES.length);
    expect(NUM_FEATURES).toBe(21);
  });

  it("FEATURE_NAMES order is the documented order (regression guard)", () => {
    // Any change to this list is a breaking change and must bump
    // NO_SHOW_FEATURE_VERSION — the source comment says so explicitly.
    expect(FEATURE_NAMES).toEqual([
      "hist_no_show_rate",
      "lead_time_days",
      "dow_sun",
      "dow_mon",
      "dow_tue",
      "dow_wed",
      "dow_thu",
      "dow_fri",
      "dow_sat",
      "hour_sin",
      "hour_cos",
      "new_patient",
      "recent_no_show_90d",
      "type_scheduled",
      "type_walk_in",
      "age_lt_18",
      "age_18_34",
      "age_35_54",
      "age_55_74",
      "age_75_plus",
      "distance_km",
    ]);
  });

  it("NO_SHOW_FEATURE_VERSION is exported and = 1", () => {
    expect(NO_SHOW_FEATURE_VERSION).toBe(1);
  });
});

// ─── extractFeatures ───────────────────────────────────────────────────────

describe("extractFeatures — shape + sane defaults", () => {
  it("returns a vector of NUM_FEATURES length on baseline input", () => {
    const f = extractFeatures(baseInput(), REF_NOW);
    expect(f).toHaveLength(NUM_FEATURES);
    expect(f.every((v) => typeof v === "number" && Number.isFinite(v))).toBe(true);
  });

  it("accepts ISO-string dates as well as Date objects", () => {
    const fromIso = extractFeatures(
      baseInput({
        createdAt: "2026-05-07T10:00:00Z",
        date: "2026-05-12T10:00:00Z",
      }),
      REF_NOW,
    );
    const fromDate = extractFeatures(baseInput(), REF_NOW);
    expect(fromIso).toEqual(fromDate);
  });

  it("defaults `now` to `new Date()` when not passed", () => {
    // No `now` arg — just assert it doesn't throw and returns a finite vec.
    const f = extractFeatures(baseInput());
    expect(f).toHaveLength(NUM_FEATURES);
    expect(f.every((v) => Number.isFinite(v))).toBe(true);
  });
});

describe("extractFeatures — feature 1: historical no-show rate (Laplace)", () => {
  it("emits the 0.1 baseline when no past appointments exist", () => {
    const f = extractFeatures(baseInput({ pastAppointments: [] }), REF_NOW);
    // (0.1 + 0) / (1 + 0) = 0.1
    expect(f[IDX.hist_no_show_rate]).toBeCloseTo(0.1, 6);
  });

  it("computes (0.1 + noShows) / (1 + total) — half no-shows out of 4", () => {
    const past: PastAppointmentSummary[] = [
      { status: "NO_SHOW", date: "2026-04-01" },
      { status: "NO_SHOW", date: "2026-04-02" },
      { status: "COMPLETED", date: "2026-04-03" },
      { status: "COMPLETED", date: "2026-04-04" },
    ];
    const f = extractFeatures(baseInput({ pastAppointments: past }), REF_NOW);
    // (0.1 + 2) / (1 + 4) = 2.1 / 5 = 0.42
    expect(f[IDX.hist_no_show_rate]).toBeCloseTo(0.42, 6);
  });

  it("treats missing `pastAppointments` (undefined) as empty array", () => {
    // Cast around the required-field check to drop pastAppointments entirely.
    const input = baseInput();
    delete (input as unknown as { pastAppointments?: PastAppointmentSummary[] })
      .pastAppointments;
    const f = extractFeatures(input, REF_NOW);
    expect(f[IDX.hist_no_show_rate]).toBeCloseTo(0.1, 6);
  });
});

describe("extractFeatures — feature 2: lead time clamp 0..90", () => {
  it("computes a positive lead time in days", () => {
    const f = extractFeatures(
      baseInput({
        createdAt: "2026-05-01T00:00:00Z",
        date: "2026-05-11T00:00:00Z", // 10 days later
      }),
      REF_NOW,
    );
    expect(f[IDX.lead_time_days]).toBe(10);
  });

  it("clamps to 0 when appointment was created AFTER its date (walk-in backdated)", () => {
    const f = extractFeatures(
      baseInput({
        createdAt: "2026-05-12T12:00:00Z",
        date: "2026-05-10T00:00:00Z",
      }),
      REF_NOW,
    );
    expect(f[IDX.lead_time_days]).toBe(0);
  });

  it("clamps to 90 when lead time exceeds 90 days", () => {
    const f = extractFeatures(
      baseInput({
        createdAt: "2026-01-01T00:00:00Z",
        date: "2026-12-31T00:00:00Z", // ~364 days
      }),
      REF_NOW,
    );
    expect(f[IDX.lead_time_days]).toBe(90);
  });
});

describe("extractFeatures — feature 3-9: day-of-week one-hot", () => {
  // 2026-05-10 is a Sunday in UTC; iterate forward 7 days and verify the
  // one-hot bucket exactly one slot is set, in the right position.
  const dowMap: Array<{ date: string; setIdx: string }> = [
    { date: "2026-05-10T10:00:00Z", setIdx: "dow_sun" }, // Sun
    { date: "2026-05-11T10:00:00Z", setIdx: "dow_mon" },
    { date: "2026-05-12T10:00:00Z", setIdx: "dow_tue" },
    { date: "2026-05-13T10:00:00Z", setIdx: "dow_wed" },
    { date: "2026-05-14T10:00:00Z", setIdx: "dow_thu" },
    { date: "2026-05-15T10:00:00Z", setIdx: "dow_fri" },
    { date: "2026-05-16T10:00:00Z", setIdx: "dow_sat" },
  ];

  for (const { date, setIdx } of dowMap) {
    it(`sets ${setIdx} = 1 for ${date}`, () => {
      const f = extractFeatures(
        baseInput({ createdAt: date, date }),
        REF_NOW,
      );
      const dowFields = [
        "dow_sun",
        "dow_mon",
        "dow_tue",
        "dow_wed",
        "dow_thu",
        "dow_fri",
        "dow_sat",
      ];
      for (const field of dowFields) {
        expect(f[IDX[field]]).toBe(field === setIdx ? 1 : 0);
      }
    });
  }
});

describe("extractFeatures — feature 10-11: hour sin/cos", () => {
  it("encodes noon (hour=12) → sin≈0, cos≈-1", () => {
    const f = extractFeatures(baseInput({ slotStart: "12:00" }), REF_NOW);
    expect(f[IDX.hour_sin]).toBeCloseTo(0, 6);
    expect(f[IDX.hour_cos]).toBeCloseTo(-1, 6);
  });

  it("encodes midnight (hour=0) → sin=0, cos=1", () => {
    const f = extractFeatures(baseInput({ slotStart: "00:15" }), REF_NOW);
    expect(f[IDX.hour_sin]).toBeCloseTo(0, 6);
    expect(f[IDX.hour_cos]).toBeCloseTo(1, 6);
  });

  it("encodes 6am (quarter of day) → sin=1, cos≈0", () => {
    const f = extractFeatures(baseInput({ slotStart: "06:00" }), REF_NOW);
    expect(f[IDX.hour_sin]).toBeCloseTo(1, 6);
    expect(f[IDX.hour_cos]).toBeCloseTo(0, 6);
  });

  it("falls back to hour=12 when slotStart is null", () => {
    const f = extractFeatures(baseInput({ slotStart: null }), REF_NOW);
    expect(f[IDX.hour_sin]).toBeCloseTo(0, 6);
    expect(f[IDX.hour_cos]).toBeCloseTo(-1, 6);
  });

  it("falls back to hour=12 when slotStart is undefined", () => {
    const f = extractFeatures(baseInput({ slotStart: undefined }), REF_NOW);
    expect(f[IDX.hour_sin]).toBeCloseTo(0, 6);
    expect(f[IDX.hour_cos]).toBeCloseTo(-1, 6);
  });

  it("falls back to hour=12 when slotStart is the empty string", () => {
    const f = extractFeatures(baseInput({ slotStart: "" }), REF_NOW);
    expect(f[IDX.hour_sin]).toBeCloseTo(0, 6);
    expect(f[IDX.hour_cos]).toBeCloseTo(-1, 6);
  });

  it("falls back to hour=12 when slotStart is unparseable", () => {
    const f = extractFeatures(baseInput({ slotStart: "abc:def" }), REF_NOW);
    expect(f[IDX.hour_sin]).toBeCloseTo(0, 6);
    expect(f[IDX.hour_cos]).toBeCloseTo(-1, 6);
  });

  it("falls back to hour=12 when slotStart hour is out of range (24:00)", () => {
    const f = extractFeatures(baseInput({ slotStart: "24:00" }), REF_NOW);
    expect(f[IDX.hour_sin]).toBeCloseTo(0, 6);
    expect(f[IDX.hour_cos]).toBeCloseTo(-1, 6);
  });

  it("falls back to hour=12 when slotStart hour is negative", () => {
    const f = extractFeatures(baseInput({ slotStart: "-3:00" }), REF_NOW);
    expect(f[IDX.hour_sin]).toBeCloseTo(0, 6);
    expect(f[IDX.hour_cos]).toBeCloseTo(-1, 6);
  });
});

describe("extractFeatures — feature 12: new patient flag", () => {
  it("is 1 when patient has 0 past appointments", () => {
    const f = extractFeatures(baseInput({ pastAppointments: [] }), REF_NOW);
    expect(f[IDX.new_patient]).toBe(1);
  });

  it("is 1 when patient has fewer than 3 past appointments", () => {
    const past: PastAppointmentSummary[] = [
      { status: "COMPLETED", date: "2026-04-01" },
      { status: "COMPLETED", date: "2026-04-02" },
    ];
    const f = extractFeatures(baseInput({ pastAppointments: past }), REF_NOW);
    expect(f[IDX.new_patient]).toBe(1);
  });

  it("is 0 when patient has 3+ past appointments", () => {
    const past: PastAppointmentSummary[] = [
      { status: "COMPLETED", date: "2026-04-01" },
      { status: "COMPLETED", date: "2026-04-02" },
      { status: "COMPLETED", date: "2026-04-03" },
    ];
    const f = extractFeatures(baseInput({ pastAppointments: past }), REF_NOW);
    expect(f[IDX.new_patient]).toBe(0);
  });
});

describe("extractFeatures — feature 13: recent no-show in last 90 days", () => {
  it("is 1 when a NO_SHOW appointment is within the 90-day window", () => {
    const past: PastAppointmentSummary[] = [
      { status: "NO_SHOW", date: "2026-04-01" }, // ~41 days before REF_NOW
    ];
    const f = extractFeatures(baseInput({ pastAppointments: past }), REF_NOW);
    expect(f[IDX.recent_no_show_90d]).toBe(1);
  });

  it("is 0 when the only NO_SHOW is older than 90 days", () => {
    const past: PastAppointmentSummary[] = [
      { status: "NO_SHOW", date: "2025-01-01" }, // way older than 90d
    ];
    const f = extractFeatures(baseInput({ pastAppointments: past }), REF_NOW);
    expect(f[IDX.recent_no_show_90d]).toBe(0);
  });

  it("is 0 when recent appointments exist but none are NO_SHOW", () => {
    const past: PastAppointmentSummary[] = [
      { status: "COMPLETED", date: "2026-04-01" },
      { status: "CANCELLED", date: "2026-04-15" },
    ];
    const f = extractFeatures(baseInput({ pastAppointments: past }), REF_NOW);
    expect(f[IDX.recent_no_show_90d]).toBe(0);
  });

  it("accepts ISO-string dates inside pastAppointments", () => {
    const past: PastAppointmentSummary[] = [
      { status: "NO_SHOW", date: "2026-05-01T08:00:00Z" },
    ];
    const f = extractFeatures(baseInput({ pastAppointments: past }), REF_NOW);
    expect(f[IDX.recent_no_show_90d]).toBe(1);
  });
});

describe("extractFeatures — feature 14-15: appointment type one-hot", () => {
  it("encodes SCHEDULED → (1, 0)", () => {
    const f = extractFeatures(baseInput({ type: "SCHEDULED" }), REF_NOW);
    expect(f[IDX.type_scheduled]).toBe(1);
    expect(f[IDX.type_walk_in]).toBe(0);
  });

  it("encodes WALK_IN → (0, 1)", () => {
    const f = extractFeatures(baseInput({ type: "WALK_IN" }), REF_NOW);
    expect(f[IDX.type_scheduled]).toBe(0);
    expect(f[IDX.type_walk_in]).toBe(1);
  });

  it("encodes unknown type → (0, 0)", () => {
    const f = extractFeatures(baseInput({ type: "EMERGENCY" }), REF_NOW);
    expect(f[IDX.type_scheduled]).toBe(0);
    expect(f[IDX.type_walk_in]).toBe(0);
  });

  it("encodes null type → (0, 0)", () => {
    const f = extractFeatures(baseInput({ type: null }), REF_NOW);
    expect(f[IDX.type_scheduled]).toBe(0);
    expect(f[IDX.type_walk_in]).toBe(0);
  });
});

describe("extractFeatures — feature 16-20: age bucket one-hot", () => {
  const ageCases: Array<{ age: number | null | undefined; set: string }> = [
    { age: 5, set: "age_lt_18" },
    { age: 17, set: "age_lt_18" },
    { age: 18, set: "age_18_34" },
    { age: 34, set: "age_18_34" },
    { age: 35, set: "age_35_54" },
    { age: 54, set: "age_35_54" },
    { age: 55, set: "age_55_74" },
    { age: 74, set: "age_55_74" },
    { age: 75, set: "age_75_plus" },
    { age: 200, set: "age_75_plus" },
    // unknown / negative → adult fallback 35-54
    { age: null, set: "age_35_54" },
    { age: undefined, set: "age_35_54" },
    { age: -5, set: "age_35_54" },
  ];

  for (const { age, set } of ageCases) {
    it(`age=${String(age)} → ${set}`, () => {
      const f = extractFeatures(baseInput({ patientAge: age }), REF_NOW);
      const bucketFields = [
        "age_lt_18",
        "age_18_34",
        "age_35_54",
        "age_55_74",
        "age_75_plus",
      ];
      for (const field of bucketFields) {
        expect(f[IDX[field]]).toBe(field === set ? 1 : 0);
      }
    });
  }
});

describe("extractFeatures — feature 21: distance clamp", () => {
  it("passes a normal distance through", () => {
    const f = extractFeatures(baseInput({ distanceKm: 12.5 }), REF_NOW);
    expect(f[IDX.distance_km]).toBe(12.5);
  });

  it("clamps a negative distance to 0", () => {
    const f = extractFeatures(baseInput({ distanceKm: -3 }), REF_NOW);
    expect(f[IDX.distance_km]).toBe(0);
  });

  it("clamps a very large distance to 100", () => {
    const f = extractFeatures(baseInput({ distanceKm: 999 }), REF_NOW);
    expect(f[IDX.distance_km]).toBe(100);
  });

  it("emits 0 when distance is null", () => {
    const f = extractFeatures(baseInput({ distanceKm: null }), REF_NOW);
    expect(f[IDX.distance_km]).toBe(0);
  });

  it("emits 0 when distance is undefined", () => {
    const f = extractFeatures(baseInput({ distanceKm: undefined }), REF_NOW);
    expect(f[IDX.distance_km]).toBe(0);
  });

  it("emits 0 when distance is NaN (non-finite)", () => {
    const f = extractFeatures(baseInput({ distanceKm: Number.NaN }), REF_NOW);
    expect(f[IDX.distance_km]).toBe(0);
  });

  it("emits 0 when distance is Infinity (non-finite)", () => {
    const f = extractFeatures(
      baseInput({ distanceKm: Number.POSITIVE_INFINITY }),
      REF_NOW,
    );
    expect(f[IDX.distance_km]).toBe(0);
  });
});

// ─── riskBucket ────────────────────────────────────────────────────────────

describe("riskBucket — probability → bucket", () => {
  it("returns 'low' for p < 0.25", () => {
    expect(riskBucket(0)).toBe("low");
    expect(riskBucket(0.1)).toBe("low");
    expect(riskBucket(0.249)).toBe("low");
  });

  it("returns 'medium' for 0.25 <= p < 0.55", () => {
    expect(riskBucket(0.25)).toBe("medium");
    expect(riskBucket(0.4)).toBe("medium");
    expect(riskBucket(0.549)).toBe("medium");
  });

  it("returns 'high' for p >= 0.55", () => {
    expect(riskBucket(0.55)).toBe("high");
    expect(riskBucket(0.8)).toBe("high");
    expect(riskBucket(1)).toBe("high");
  });
});

// ─── explainFeatures ───────────────────────────────────────────────────────

describe("explainFeatures — produces human-readable factors", () => {
  it("returns [] when nothing notable is true (established patient, short lead, midday Tue, near hospital)", () => {
    // Need >= 3 past appointments (none in last 90d as NO_SHOW) so the
    // new-patient and recent-no-show gates stay quiet.
    const past: PastAppointmentSummary[] = [
      { status: "COMPLETED", date: "2025-01-01" },
      { status: "COMPLETED", date: "2025-02-01" },
      { status: "COMPLETED", date: "2025-03-01" },
    ];
    const factors = explainFeatures(
      baseInput({ pastAppointments: past }),
      REF_NOW,
    );
    expect(factors).toEqual([]);
  });

  it("flags high historical no-show rate (>=5 past, >=20% no-shows)", () => {
    const past: PastAppointmentSummary[] = [
      { status: "NO_SHOW", date: "2026-04-01" },
      { status: "NO_SHOW", date: "2026-04-02" },
      { status: "COMPLETED", date: "2026-04-03" },
      { status: "COMPLETED", date: "2026-04-04" },
      { status: "COMPLETED", date: "2026-04-05" },
    ];
    const factors = explainFeatures(
      baseInput({ pastAppointments: past }),
      REF_NOW,
    );
    expect(factors.some((s) => /High historical no-show rate \(40%\)/.test(s))).toBe(
      true,
    );
  });

  it("does NOT flag historical rate when fewer than 5 past appointments exist", () => {
    const past: PastAppointmentSummary[] = [
      { status: "NO_SHOW", date: "2026-04-01" },
      { status: "NO_SHOW", date: "2026-04-02" },
      { status: "COMPLETED", date: "2026-04-03" },
      { status: "COMPLETED", date: "2026-04-04" },
    ];
    const factors = explainFeatures(
      baseInput({ pastAppointments: past }),
      REF_NOW,
    );
    expect(factors.some((s) => /historical no-show/i.test(s))).toBe(false);
  });

  it("does NOT flag historical rate when count >=5 but rate < 20%", () => {
    const past: PastAppointmentSummary[] = [
      { status: "NO_SHOW", date: "2026-04-01" },
      ...Array.from({ length: 9 }, (_, i) => ({
        status: "COMPLETED",
        date: `2026-04-${String(i + 2).padStart(2, "0")}`,
      })),
    ];
    const factors = explainFeatures(
      baseInput({ pastAppointments: past }),
      REF_NOW,
    );
    expect(factors.some((s) => /historical no-show/i.test(s))).toBe(false);
  });

  it("flags long-lead-time appointments (> 14 days)", () => {
    const factors = explainFeatures(
      baseInput({
        createdAt: "2026-04-01T00:00:00Z",
        date: "2026-05-01T00:00:00Z", // 30 days
      }),
      REF_NOW,
    );
    expect(
      factors.some((s) => /booked 30 days in advance \(long lead time\)/.test(s)),
    ).toBe(true);
  });

  it("flags medium-lead-time appointments (8-14 days)", () => {
    const factors = explainFeatures(
      baseInput({
        createdAt: "2026-04-22T00:00:00Z",
        date: "2026-05-01T00:00:00Z", // 9 days
      }),
      REF_NOW,
    );
    expect(factors.some((s) => /booked 9 days in advance$/.test(s))).toBe(true);
  });

  it("does NOT add a lead-time factor for short leads (<= 7 days)", () => {
    const factors = explainFeatures(
      baseInput({
        createdAt: "2026-05-01T00:00:00Z",
        date: "2026-05-05T00:00:00Z",
      }),
      REF_NOW,
    );
    expect(factors.some((s) => /booked .* in advance/.test(s))).toBe(false);
  });

  it("flags Monday appointments", () => {
    const factors = explainFeatures(
      baseInput({
        createdAt: "2026-05-11T00:00:00Z",
        date: "2026-05-11T10:00:00Z", // Monday
      }),
      REF_NOW,
    );
    expect(factors.some((s) => /Monday appointment/.test(s))).toBe(true);
  });

  it("flags Friday appointments", () => {
    const factors = explainFeatures(
      baseInput({
        createdAt: "2026-05-15T00:00:00Z",
        date: "2026-05-15T10:00:00Z", // Friday
      }),
      REF_NOW,
    );
    expect(factors.some((s) => /Friday appointment/.test(s))).toBe(true);
  });

  it("does NOT flag Tue/Wed/Thu/Sat/Sun appointments as a high day", () => {
    const factors = explainFeatures(baseInput(), REF_NOW); // Tuesday
    expect(factors.some((s) => /(Monday|Friday) appointment/.test(s))).toBe(false);
  });

  it("flags late-afternoon slots (>= 5 PM)", () => {
    const factors = explainFeatures(
      baseInput({ slotStart: "17:30" }),
      REF_NOW,
    );
    expect(factors.some((s) => /Late afternoon slot/.test(s))).toBe(true);
  });

  it("flags very-early-morning slots (<= 8 AM)", () => {
    const factors = explainFeatures(
      baseInput({ slotStart: "07:00" }),
      REF_NOW,
    );
    expect(factors.some((s) => /Very early morning slot/.test(s))).toBe(true);
  });

  it("flags new-patient (< 3 prior appointments)", () => {
    const factors = explainFeatures(
      baseInput({ pastAppointments: [] }),
      REF_NOW,
    );
    expect(factors.some((s) => /New patient/.test(s))).toBe(true);
  });

  it("does NOT flag new-patient when >= 3 past appointments", () => {
    const past: PastAppointmentSummary[] = [
      { status: "COMPLETED", date: "2026-04-01" },
      { status: "COMPLETED", date: "2026-04-02" },
      { status: "COMPLETED", date: "2026-04-03" },
    ];
    const factors = explainFeatures(
      baseInput({ pastAppointments: past }),
      REF_NOW,
    );
    expect(factors.some((s) => /New patient/.test(s))).toBe(false);
  });

  it("flags a recent (<= 90 days) NO_SHOW", () => {
    const past: PastAppointmentSummary[] = [
      { status: "NO_SHOW", date: "2026-04-01" },
    ];
    const factors = explainFeatures(
      baseInput({ pastAppointments: past }),
      REF_NOW,
    );
    expect(factors.some((s) => /no-show in the last 90 days/.test(s))).toBe(true);
  });

  it("flags distance >= 20 km", () => {
    const factors = explainFeatures(
      baseInput({ distanceKm: 35.4 }),
      REF_NOW,
    );
    expect(factors.some((s) => /lives 35 km/.test(s))).toBe(true);
  });

  it("does NOT flag distance < 20 km", () => {
    const factors = explainFeatures(
      baseInput({ distanceKm: 5 }),
      REF_NOW,
    );
    expect(factors.some((s) => /km from the hospital/.test(s))).toBe(false);
  });

  it("does NOT flag distance when undefined", () => {
    const factors = explainFeatures(
      baseInput({ distanceKm: undefined }),
      REF_NOW,
    );
    expect(factors.some((s) => /km from the hospital/.test(s))).toBe(false);
  });

  it("defaults `now` to `new Date()` when not passed (smoke)", () => {
    const factors = explainFeatures(baseInput({ pastAppointments: [] }));
    // At minimum, the new-patient factor should still fire.
    expect(factors.some((s) => /New patient/.test(s))).toBe(true);
  });

  it("treats undefined pastAppointments as empty for new-patient detection", () => {
    const input = baseInput();
    delete (input as unknown as { pastAppointments?: PastAppointmentSummary[] })
      .pastAppointments;
    const factors = explainFeatures(input, REF_NOW);
    expect(factors.some((s) => /New patient/.test(s))).toBe(true);
  });

  it("stacks multiple factors when many gates fire at once", () => {
    const past: PastAppointmentSummary[] = [
      { status: "NO_SHOW", date: "2026-04-01" },
      { status: "NO_SHOW", date: "2026-04-02" },
      { status: "COMPLETED", date: "2026-04-03" },
      { status: "COMPLETED", date: "2026-04-04" },
      { status: "COMPLETED", date: "2026-04-05" },
    ];
    const factors = explainFeatures(
      {
        createdAt: "2026-04-01T00:00:00Z",
        date: "2026-05-15T18:00:00Z", // Friday, 6 PM, 44d lead
        slotStart: "18:00",
        type: "SCHEDULED",
        patientAge: 30,
        patientAddress: null,
        distanceKm: 25,
        pastAppointments: past,
      },
      REF_NOW,
    );
    // Expect at least: historical, long-lead, Friday, late afternoon, recent no-show, distance.
    expect(factors.length).toBeGreaterThanOrEqual(6);
    expect(factors.some((s) => /historical no-show/i.test(s))).toBe(true);
    expect(factors.some((s) => /long lead time/.test(s))).toBe(true);
    expect(factors.some((s) => /Friday/.test(s))).toBe(true);
    expect(factors.some((s) => /Late afternoon/.test(s))).toBe(true);
    expect(factors.some((s) => /no-show in the last 90 days/.test(s))).toBe(true);
    expect(factors.some((s) => /km from the hospital/.test(s))).toBe(true);
  });
});
