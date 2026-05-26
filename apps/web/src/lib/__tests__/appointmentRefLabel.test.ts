// Unit tests for the appointmentRefLabel helper.
//
// Pearl ERP Stage 1 §2.1.2 — the appointments list table renders a
// single "#" column whose contents depend on the doctor's configured
// `appointmentMode`. Pre-fix the cell rendered `apt.tokenNumber` raw,
// which:
//   - showed an unprefixed bare integer (ambiguous if rows mix modes)
//   - silently lost the value for CALLING rows whose identifier lives
//     in `arrivalSeq`, not `tokenNumber`
//
// This file locks in the per-mode formatting contract so future
// refactors don't regress the appointments list / patient view.
import { describe, it, expect } from "vitest";
import { appointmentRefLabel } from "../appointments";

describe("appointmentRefLabel — mode-aware identifier rendering", () => {
  describe("CALLING mode (arrival-order queue)", () => {
    it("formats arrivalSeq with A- prefix", () => {
      expect(
        appointmentRefLabel({
          tokenNumber: null,
          arrivalSeq: 3,
          doctor: { appointmentMode: "CALLING" },
        }),
      ).toBe("A-3");
    });

    it("renders em-dash when arrivalSeq is missing", () => {
      expect(
        appointmentRefLabel({
          tokenNumber: null,
          arrivalSeq: null,
          doctor: { appointmentMode: "CALLING" },
        }),
      ).toBe("—");
    });

    it("ignores a stray tokenNumber on a CALLING row", () => {
      // Backend should never write both; defensive check that CALLING
      // mode never accidentally renders a "T-..." label even if the
      // appointment row carries a tokenNumber from legacy data.
      expect(
        appointmentRefLabel({
          tokenNumber: 99,
          arrivalSeq: 4,
          doctor: { appointmentMode: "CALLING" },
        }),
      ).toBe("A-4");
    });
  });

  describe("TOKEN mode (sequential session tokens)", () => {
    it("formats tokenNumber with T- prefix", () => {
      expect(
        appointmentRefLabel({
          tokenNumber: 7,
          arrivalSeq: null,
          doctor: { appointmentMode: "TOKEN" },
        }),
      ).toBe("T-7");
    });

    it("renders em-dash when tokenNumber is missing", () => {
      // Should only happen on malformed rows — the booking flow always
      // mints a tokenNumber in TOKEN mode. Keep the fallback explicit.
      expect(
        appointmentRefLabel({
          tokenNumber: null,
          arrivalSeq: null,
          doctor: { appointmentMode: "TOKEN" },
        }),
      ).toBe("—");
    });

    it("falls back to arrivalSeq if a TOKEN row somehow has none", () => {
      expect(
        appointmentRefLabel({
          tokenNumber: null,
          arrivalSeq: 2,
          doctor: { appointmentMode: "TOKEN" },
        }),
      ).toBe("A-2");
    });
  });

  describe("SLOT mode (fixed-time appointments)", () => {
    it("formats tokenNumber with T- prefix when populated", () => {
      // SLOT mode doesn't require a token but the booking flow may
      // still mint one for queue-ordering purposes. Surface it.
      expect(
        appointmentRefLabel({
          tokenNumber: 5,
          arrivalSeq: null,
          doctor: { appointmentMode: "SLOT" },
        }),
      ).toBe("T-5");
    });

    it("renders em-dash when there is no token (slot-only)", () => {
      // The adjacent TIME column shows the slot itself; the # cell
      // collapses to a dash so the row doesn't display "T-null" or 0.
      expect(
        appointmentRefLabel({
          tokenNumber: null,
          arrivalSeq: null,
          doctor: { appointmentMode: "SLOT" },
        }),
      ).toBe("—");
    });
  });

  describe("Unknown / legacy mode (back-compat)", () => {
    it("treats missing doctor.appointmentMode as TOKEN-like fallback", () => {
      // Legacy rows seeded before the mode field existed — surface
      // whichever scalar is populated, preferring tokenNumber.
      expect(
        appointmentRefLabel({
          tokenNumber: 11,
          arrivalSeq: null,
        }),
      ).toBe("T-11");
    });

    it("falls back to arrivalSeq when tokenNumber is absent", () => {
      expect(
        appointmentRefLabel({
          tokenNumber: null,
          arrivalSeq: 6,
        }),
      ).toBe("A-6");
    });

    it("returns em-dash when neither identifier is populated", () => {
      expect(
        appointmentRefLabel({
          tokenNumber: null,
          arrivalSeq: null,
        }),
      ).toBe("—");
    });

    it("handles an explicit null appointmentMode (back-compat)", () => {
      expect(
        appointmentRefLabel({
          tokenNumber: 8,
          arrivalSeq: null,
          doctor: { appointmentMode: null },
        }),
      ).toBe("T-8");
    });

    it("handles a doctor object with no mode field at all", () => {
      expect(
        appointmentRefLabel({
          tokenNumber: 4,
          arrivalSeq: null,
          doctor: {},
        }),
      ).toBe("T-4");
    });
  });

  describe("Edge values", () => {
    it("handles tokenNumber = 0 (some clinics start counters at 0)", () => {
      // `0` is falsy but is a valid token number. The helper must
      // check for `!= null`, not truthiness.
      expect(
        appointmentRefLabel({
          tokenNumber: 0,
          arrivalSeq: null,
          doctor: { appointmentMode: "TOKEN" },
        }),
      ).toBe("T-0");
    });

    it("handles arrivalSeq = 0 the same way", () => {
      expect(
        appointmentRefLabel({
          tokenNumber: null,
          arrivalSeq: 0,
          doctor: { appointmentMode: "CALLING" },
        }),
      ).toBe("A-0");
    });

    it("renders large numbers without truncation", () => {
      expect(
        appointmentRefLabel({
          tokenNumber: 9999,
          arrivalSeq: null,
          doctor: { appointmentMode: "TOKEN" },
        }),
      ).toBe("T-9999");
    });
  });
});
