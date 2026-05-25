/**
 * Unit tests for the Pearl §2.1.4 (gap-doc row 49) prescription chip /
 * segmented-control helpers in lib/rx-form.ts. These helpers translate
 * between the structured-UX state (chips, segmented buttons, auto-qty)
 * and the wire shape that PrescriptionItem in the schema accepts (no
 * route or quantity columns — both serialized into the freetext
 * `instructions` field via `Route: XX | Qty: NN | <notes>`).
 *
 * The conversion HAS to be lossless: an Rx written with chips → submitted
 * to the API → reloaded into edit mode → must rehydrate to the same chip
 * + segment selections without surprises.
 */
import { describe, it, expect } from "vitest";
import {
  DOSE_PRESETS,
  ROUTE_OPTIONS,
  frequencyPerDay,
  durationToDays,
  computeAutoQuantity,
  composeInstructions,
  parseInstructions,
} from "../rx-form";

describe("DOSE_PRESETS catalog", () => {
  it("includes the canonical chip values from Pearl §2.1.4", () => {
    expect(DOSE_PRESETS).toEqual(["250mg", "500mg", "1g", "5ml", "10ml"]);
  });
});

describe("ROUTE_OPTIONS catalog", () => {
  it("includes PO / IV / IM / SC / Topical with tooltips", () => {
    const values = ROUTE_OPTIONS.map((r) => r.value);
    expect(values).toEqual(["PO", "IV", "IM", "SC", "Topical"]);
    for (const r of ROUTE_OPTIONS) {
      expect(r.tooltip.length).toBeGreaterThan(0);
    }
  });
});

describe("frequencyPerDay", () => {
  it("sums the X-Y-Z prefix into doses per day", () => {
    expect(frequencyPerDay("1-0-0 (Morning)")).toBe(1);
    expect(frequencyPerDay("0-1-0 (Afternoon)")).toBe(1);
    expect(frequencyPerDay("1-1-0 (Morning-Afternoon)")).toBe(2);
    expect(frequencyPerDay("1-0-1 (Morning-Night)")).toBe(2);
    expect(frequencyPerDay("1-1-1 (Three times)")).toBe(3);
  });
  it("returns 0 for SOS / unrecognised strings — no auto-calc", () => {
    expect(frequencyPerDay("SOS (As needed)")).toBe(0);
    expect(frequencyPerDay("")).toBe(0);
    expect(frequencyPerDay("every 6 hours")).toBe(0);
  });
});

describe("durationToDays", () => {
  it("parses days / d", () => {
    expect(durationToDays("5 days")).toBe(5);
    expect(durationToDays("5d")).toBe(5);
    expect(durationToDays("1 day")).toBe(1);
  });
  it("parses weeks / w / wk", () => {
    expect(durationToDays("2 weeks")).toBe(14);
    expect(durationToDays("1 wk")).toBe(7);
  });
  it("parses months / mo / m", () => {
    expect(durationToDays("1 month")).toBe(30);
    expect(durationToDays("2 mo")).toBe(60);
  });
  it("parses hours into fractional days", () => {
    expect(durationToDays("24 hours")).toBe(1);
    expect(durationToDays("12 h")).toBe(0.5);
  });
  it("returns 0 for em-dash / empty / garbage", () => {
    expect(durationToDays("—")).toBe(0);
    expect(durationToDays("")).toBe(0);
    expect(durationToDays("forever")).toBe(0);
  });
});

describe("computeAutoQuantity", () => {
  it("multiplies frequency-per-day by days and ceils", () => {
    // OD (1) × 5 days = 5 tablets
    expect(computeAutoQuantity("1-0-0 (Morning)", "5 days")).toBe("5");
    // BD (2) × 7 days = 14
    expect(computeAutoQuantity("1-0-1 (Morning-Night)", "7 days")).toBe("14");
    // TDS (3) × 5 days = 15
    expect(computeAutoQuantity("1-1-1 (Three times)", "5 days")).toBe("15");
    // BD × 2 weeks = 28
    expect(computeAutoQuantity("1-1-0 (Morning-Afternoon)", "2 weeks")).toBe("28");
  });
  it("returns '' (not 0) when frequency is SOS — never auto-calc on-demand meds", () => {
    expect(computeAutoQuantity("SOS (As needed)", "5 days")).toBe("");
  });
  it("returns '' when duration is missing / em-dash", () => {
    expect(computeAutoQuantity("1-1-1 (Three times)", "")).toBe("");
    expect(computeAutoQuantity("1-1-1 (Three times)", "—")).toBe("");
  });
});

describe("composeInstructions", () => {
  it("joins route + qty + notes with ' | ' separators", () => {
    expect(
      composeInstructions({ route: "PO", quantity: "15", notes: "after meals" })
    ).toBe("Route: PO | Qty: 15 | after meals");
  });
  it("elides empty pieces — route only", () => {
    expect(composeInstructions({ route: "IV" })).toBe("Route: IV");
  });
  it("elides empty pieces — notes only (no route, no qty)", () => {
    expect(composeInstructions({ notes: "with water" })).toBe("with water");
  });
  it("elides everything — returns ''", () => {
    expect(composeInstructions({})).toBe("");
    expect(composeInstructions({ route: "", quantity: "", notes: "" })).toBe("");
    expect(composeInstructions({ route: "   ", quantity: "   ", notes: "   " })).toBe("");
  });
});

describe("parseInstructions", () => {
  it("round-trips with composeInstructions for the full triplet", () => {
    const raw = composeInstructions({
      route: "PO",
      quantity: "15",
      notes: "after meals",
    });
    expect(parseInstructions(raw)).toEqual({
      route: "PO",
      quantity: "15",
      notes: "after meals",
    });
  });
  it("round-trips when only notes are present", () => {
    expect(parseInstructions("with water")).toEqual({
      route: "",
      quantity: "",
      notes: "with water",
    });
  });
  it("round-trips when only route is present", () => {
    expect(parseInstructions("Route: IV")).toEqual({
      route: "IV",
      quantity: "",
      notes: "",
    });
  });
  it("returns empty triplet on null / undefined / empty", () => {
    expect(parseInstructions(null)).toEqual({ route: "", quantity: "", notes: "" });
    expect(parseInstructions(undefined)).toEqual({ route: "", quantity: "", notes: "" });
    expect(parseInstructions("")).toEqual({ route: "", quantity: "", notes: "" });
  });
  it("preserves legacy free-text instructions that have no Route:/Qty: prefix", () => {
    // The doctor wrote a plain note before the chip UX shipped — must
    // still load into the notes field without dropping anything.
    expect(parseInstructions("take with food and plenty of water")).toEqual({
      route: "",
      quantity: "",
      notes: "take with food and plenty of water",
    });
  });
  it("handles multiple plain pipe-separated notes (preserves the inner pipes)", () => {
    expect(parseInstructions("Route: PO | Qty: 10 | morning dose | night dose")).toEqual({
      route: "PO",
      quantity: "10",
      notes: "morning dose | night dose",
    });
  });
});

describe("end-to-end round-trip (UI → wire → UI)", () => {
  it("a row with route + auto-qty + notes survives serialize → parse intact", () => {
    const auto = computeAutoQuantity("1-0-1 (Morning-Night)", "7 days"); // "14"
    const wire = composeInstructions({
      route: "PO",
      quantity: auto,
      notes: "after meals",
    });
    expect(wire).toBe("Route: PO | Qty: 14 | after meals");
    expect(parseInstructions(wire)).toEqual({
      route: "PO",
      quantity: "14",
      notes: "after meals",
    });
  });
});
