import { describe, it, expect } from "vitest";
import { appointmentRefLabel } from "../appointments";

describe("appointmentRefLabel — booking-time identifier rendering", () => {
  describe("token present → show the token (regardless of current mode)", () => {
    it("formats tokenNumber with the default T- prefix", () => {
      expect(
        appointmentRefLabel({
          tokenNumber: 7,
          arrivalSeq: null,
          doctor: { appointmentMode: "TOKEN" },
        }),
      ).toBe("T-7");
    });

    it("uses the doctor's configured token prefix", () => {
      expect(
        appointmentRefLabel({
          tokenNumber: 5,
          arrivalSeq: null,
          doctor: { appointmentMode: "TOKEN", tokenPrefix: "R" },
        }),
      ).toBe("R-5");
    });

    it("shows the token for a SLOT booking that minted one", () => {
      expect(
        appointmentRefLabel({
          tokenNumber: 5,
          arrivalSeq: null,
          doctor: { appointmentMode: "SLOT" },
        }),
      ).toBe("T-5");
    });

    it("KEEPS the token even if the doctor has since switched to CALLING", () => {
      // The patient booked under TOKEN (tokenNumber minted). The doctor later
      // flipped to CALLING — the row must still show its original token, not
      // collapse to a dash.
      expect(
        appointmentRefLabel({
          tokenNumber: 5,
          arrivalSeq: null,
          doctor: { appointmentMode: "CALLING", tokenPrefix: "R" },
        }),
      ).toBe("R-5");
    });
  });

  describe("no token → em-dash (CALLING / arrival-order / slot-only)", () => {
    it("renders em-dash for a CALLING booking (arrivalSeq set, no token)", () => {
      // Booked under CALLING — no token was ever minted, so the # column shows
      // nothing even though arrivalSeq drives the live-queue order.
      expect(
        appointmentRefLabel({
          tokenNumber: null,
          arrivalSeq: 3,
          doctor: { appointmentMode: "CALLING" },
        }),
      ).toBe("—");
    });

    it("KEEPS the em-dash even if the doctor has since switched to TOKEN", () => {
      // The patient booked under CALLING (arrivalSeq only). The doctor later
      // flipped to TOKEN — the row must NOT invent an "A-…" / token label.
      expect(
        appointmentRefLabel({
          tokenNumber: null,
          arrivalSeq: 1,
          doctor: { appointmentMode: "TOKEN" },
        }),
      ).toBe("—");
    });

    it("renders em-dash when arrivalSeq is missing too", () => {
      expect(
        appointmentRefLabel({
          tokenNumber: null,
          arrivalSeq: null,
          doctor: { appointmentMode: "CALLING" },
        }),
      ).toBe("—");
    });

    it("renders em-dash for a slot-only row (no token)", () => {
      // The adjacent TIME column shows the slot itself; the # cell collapses
      // to a dash so the row doesn't display "T-null".
      expect(
        appointmentRefLabel({
          tokenNumber: null,
          arrivalSeq: null,
          doctor: { appointmentMode: "SLOT" },
        }),
      ).toBe("—");
    });
  });

  describe("back-compat (missing / null appointmentMode)", () => {
    it("shows the token when one is present on a legacy row", () => {
      expect(
        appointmentRefLabel({
          tokenNumber: 11,
          arrivalSeq: null,
        }),
      ).toBe("T-11");
    });

    it("renders em-dash when only arrivalSeq is present (no token)", () => {
      expect(
        appointmentRefLabel({
          tokenNumber: null,
          arrivalSeq: 6,
        }),
      ).toBe("—");
    });

    it("returns em-dash when neither identifier is populated", () => {
      expect(
        appointmentRefLabel({
          tokenNumber: null,
          arrivalSeq: null,
        }),
      ).toBe("—");
    });

    it("handles an explicit null appointmentMode", () => {
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
      // `0` is falsy but is a valid token number. The helper must check for
      // `!= null`, not truthiness.
      expect(
        appointmentRefLabel({
          tokenNumber: 0,
          arrivalSeq: null,
          doctor: { appointmentMode: "TOKEN" },
        }),
      ).toBe("T-0");
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
