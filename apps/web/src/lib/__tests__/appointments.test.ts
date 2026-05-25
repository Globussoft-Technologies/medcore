// Unit tests for the shared appointment display helpers.
//
// Born from issues #387 / #388 / #389 / #397 — patient-facing
// "My Appointments" and the unified Calendar page were each computing
// status/time strings independently and disagreeing for the SAME row.
// These helpers (formatAppointmentTime, displayStatusForAppointment) are
// the single source of truth that both surfaces now route through.
//
// What this test file locks in:
//   - formatAppointmentTime: ISO / Date / "HH:mm" / "HH:mm:ss" inputs;
//     null/undefined/empty/garbage → "" (no "Invalid Date" leakage);
//     YYYY-MM-DD + "HH:mm" pair construction; longer date strings get
//     trimmed to the date portion.
//   - displayStatusForAppointment (Issue #388): a past BOOKED row
//     renders as COMPLETED; a future BOOKED row stays BOOKED;
//     non-BOOKED rows are passed through untouched; missing start time
//     leaves the BOOKED row untouched; falls back from startTime →
//     slotStart → date when the higher-priority field is absent.
import { describe, it, expect } from "vitest";
import {
  formatAppointmentTime,
  displayStatusForAppointment,
} from "../appointments";

describe("formatAppointmentTime", () => {
  it("returns empty string for null / undefined / empty input", () => {
    expect(formatAppointmentTime(null)).toBe("");
    expect(formatAppointmentTime(undefined)).toBe("");
    expect(formatAppointmentTime("")).toBe("");
  });

  it("returns empty string for unparseable input", () => {
    expect(formatAppointmentTime("not a date")).toBe("");
    expect(formatAppointmentTime("garbage-string")).toBe("");
  });

  it("returns empty string for an Invalid Date instance", () => {
    expect(formatAppointmentTime(new Date("not-a-date"))).toBe("");
  });

  it("formats a full ISO datetime as IST hh:mm AM/PM", () => {
    // 10:30 UTC == 16:00 IST (UTC+5:30)
    const out = formatAppointmentTime("2026-04-29T10:30:00Z");
    expect(out).not.toBe("");
    expect(out).not.toContain("Invalid");
    expect(out).toMatch(/04:00\s*(pm|PM)/);
  });

  it("formats a Date instance as IST hh:mm AM/PM", () => {
    // 00:00 UTC == 05:30 IST
    const out = formatAppointmentTime(new Date("2026-04-29T00:00:00Z"));
    expect(out).toMatch(/05:30\s*(am|AM)/);
  });

  it("formats a bare HH:mm string against today's date in IST", () => {
    // Wall-clock time gets applied directly to a local-today base; we
    // can't pin the exact rendered IST hour without knowing the host TZ,
    // but we CAN assert the formatter produced an hh:mm AM/PM string and
    // never leaked "Invalid".
    const out = formatAppointmentTime("10:30");
    expect(out).not.toBe("");
    expect(out).not.toContain("Invalid");
    expect(out).toMatch(/^\d{2}:\d{2}\s*(am|pm|AM|PM)$/);
  });

  it("accepts an HH:mm:ss variant", () => {
    const out = formatAppointmentTime("14:45:30");
    expect(out).not.toBe("");
    expect(out).not.toContain("Invalid");
    expect(out).toMatch(/^\d{2}:\d{2}\s*(am|pm|AM|PM)$/);
  });

  it("combines bare HH:mm with the optional YYYY-MM-DD date arg", () => {
    const out = formatAppointmentTime("10:30", "2026-04-29");
    expect(out).not.toBe("");
    expect(out).not.toContain("Invalid");
    expect(out).toMatch(/^\d{2}:\d{2}\s*(am|pm|AM|PM)$/);
  });

  it("trims a longer date string to its YYYY-MM-DD prefix", () => {
    // The helper's regex requires the date string to START with
    // YYYY-MM-DD but then slices to (0,10) so a full ISO is also valid.
    const out = formatAppointmentTime("10:30", "2026-04-29T05:00:00Z");
    expect(out).not.toBe("");
    expect(out).not.toContain("Invalid");
    expect(out).toMatch(/^\d{2}:\d{2}\s*(am|pm|AM|PM)$/);
  });

  it("ignores a malformed date arg and falls back to today for bare HH:mm", () => {
    // The date regex demands YYYY-MM-DD prefix; a malformed value is
    // ignored and the helper anchors against today instead.
    const out = formatAppointmentTime("10:30", "not-a-date");
    expect(out).not.toBe("");
    expect(out).not.toContain("Invalid");
    expect(out).toMatch(/^\d{2}:\d{2}\s*(am|pm|AM|PM)$/);
  });

  it("date arg is harmless when the first arg is a full ISO", () => {
    // The date arg is only used in the HH:mm branch — a full ISO ignores it.
    const out = formatAppointmentTime("2026-04-29T10:30:00Z", "2099-01-01");
    expect(out).toMatch(/04:00\s*(pm|PM)/);
  });
});

describe("displayStatusForAppointment (Issue #388)", () => {
  const NOW = Date.parse("2026-04-29T12:00:00.000Z");

  it("passes through non-BOOKED statuses untouched", () => {
    expect(
      displayStatusForAppointment(
        { status: "CANCELLED", startTime: "2026-04-29T10:00:00Z" },
        NOW
      )
    ).toBe("CANCELLED");
    expect(
      displayStatusForAppointment(
        { status: "NO_SHOW", startTime: "2026-04-29T10:00:00Z" },
        NOW
      )
    ).toBe("NO_SHOW");
    expect(
      displayStatusForAppointment(
        { status: "COMPLETED", startTime: "2026-04-29T10:00:00Z" },
        NOW
      )
    ).toBe("COMPLETED");
    expect(
      displayStatusForAppointment(
        { status: "IN_PROGRESS", startTime: "2030-01-01T00:00:00Z" },
        NOW
      )
    ).toBe("IN_PROGRESS");
  });

  it("renders a past BOOKED appointment as COMPLETED (#388)", () => {
    expect(
      displayStatusForAppointment(
        { status: "BOOKED", startTime: "2026-04-29T10:00:00Z" }, // 2h before NOW
        NOW
      )
    ).toBe("COMPLETED");
  });

  it("leaves a future BOOKED appointment as BOOKED", () => {
    // +48h from NOW — CLAUDE.md gotcha re: IST/UTC bucket boundaries:
    // use +48h rather than +24h for "future" anchors.
    const future = new Date(NOW + 48 * 60 * 60 * 1000).toISOString();
    expect(
      displayStatusForAppointment({ status: "BOOKED", startTime: future }, NOW)
    ).toBe("BOOKED");
  });

  it("leaves BOOKED untouched when start time is missing entirely", () => {
    expect(
      displayStatusForAppointment({ status: "BOOKED" }, NOW)
    ).toBe("BOOKED");
    expect(
      displayStatusForAppointment(
        { status: "BOOKED", startTime: null, slotStart: null, date: null },
        NOW
      )
    ).toBe("BOOKED");
  });

  it("leaves BOOKED untouched when start time is unparseable", () => {
    expect(
      displayStatusForAppointment(
        { status: "BOOKED", startTime: "garbage" },
        NOW
      )
    ).toBe("BOOKED");
  });

  it("falls back to slotStart when startTime is missing", () => {
    // slotStart is the bare HH:mm shape; with the `date` arg it anchors
    // to a real date. Past combined instant → COMPLETED.
    expect(
      displayStatusForAppointment(
        {
          status: "BOOKED",
          slotStart: "10:00",
          date: "2026-04-29",
        },
        NOW
      )
    ).toBe("COMPLETED");
  });

  it("uses startTime when both startTime and slotStart are set (startTime wins)", () => {
    // startTime is past → COMPLETED, even though slotStart says future.
    expect(
      displayStatusForAppointment(
        {
          status: "BOOKED",
          startTime: "2026-04-29T10:00:00Z",
          slotStart: "23:59",
          date: "2099-01-01",
        },
        NOW
      )
    ).toBe("COMPLETED");
  });

  it("accepts a Date instance as startTime", () => {
    expect(
      displayStatusForAppointment(
        { status: "BOOKED", startTime: new Date(NOW - 60 * 60 * 1000) },
        NOW
      )
    ).toBe("COMPLETED");
    expect(
      displayStatusForAppointment(
        { status: "BOOKED", startTime: new Date(NOW + 48 * 60 * 60 * 1000) },
        NOW
      )
    ).toBe("BOOKED");
  });

  it("defaults nowMs to Date.now() when the arg is omitted", () => {
    // A clearly-historical timestamp must read as COMPLETED regardless
    // of what Date.now() reports today.
    expect(
      displayStatusForAppointment({
        status: "BOOKED",
        startTime: "2000-01-01T00:00:00Z",
      })
    ).toBe("COMPLETED");
    // A clearly-future timestamp must stay BOOKED.
    expect(
      displayStatusForAppointment({
        status: "BOOKED",
        startTime: "2099-01-01T00:00:00Z",
      })
    ).toBe("BOOKED");
  });

  it("treats a start exactly equal to now as not-yet-completed (boundary)", () => {
    // The helper uses strict `<`, so start === now → not past → BOOKED.
    const start = new Date(NOW).toISOString();
    expect(
      displayStatusForAppointment(
        { status: "BOOKED", startTime: start },
        NOW
      )
    ).toBe("BOOKED");
  });
});
