import { describe, it, expect } from "vitest";
import {
  bookAppointmentSchema,
  walkInSchema,
  rescheduleAppointmentSchema,
  recurringAppointmentSchema,
  transferAppointmentSchema,
  markLwbsSchema,
  waitlistEntrySchema,
  coordinatedVisitSchema,
  doctorScheduleSchema,
  scheduleOverrideSchema,
} from "../appointment";

const UUID = "550e8400-e29b-41d4-a716-446655441111";

describe("bookAppointmentSchema", () => {
  // Issue #491 (2026-05-03): bookAppointmentSchema now rejects past dates,
  // so the fixture uses a far-future YYYY-MM-DD that's safely valid no
  // matter when the test runs (mirrors the pattern recurring already used
  // for #362).
  const valid = { patientId: UUID, doctorId: UUID, date: "2099-04-20", slotId: "09:00" };
  it("accepts a valid booking", () => {
    expect(bookAppointmentSchema.safeParse(valid).success).toBe(true);
  });
  it("rejects bad date format", () => {
    expect(bookAppointmentSchema.safeParse({ ...valid, date: "20-04-2026" }).success).toBe(false);
  });
  it("rejects non-uuid patientId", () => {
    expect(bookAppointmentSchema.safeParse({ ...valid, patientId: "abc" }).success).toBe(false);
  });
  // Pearl §2.1.2 (2026-05-20): slotId became optional at the schema
  // layer because CALLING-mode doctors do not take a slot at all. The
  // booking handler enforces per-mode requirements ("required for SLOT,
  // ignored for CALLING, optional for TOKEN") — the integration test
  // `Appointments API (integration) > SLOT mode: requires slotId — 400
  // when omitted` pins that behaviour. Here we just confirm the schema
  // change is intentional.
  it("accepts missing slotId (per-mode requirement enforced at route)", () => {
    const { slotId: _omit, ...rest } = valid;
    expect(bookAppointmentSchema.safeParse(rest).success).toBe(true);
  });
  it("rejects malformed slotId when present", () => {
    expect(
      bookAppointmentSchema.safeParse({ ...valid, slotId: "9 am" }).success,
    ).toBe(false);
  });
  // Issue #491: past calendar date must be rejected before slot-conflict
  // logic ever runs (the bug let "01-01-2020" populate a slot grid).
  it("rejects a past appointment date", () => {
    const r = bookAppointmentSchema.safeParse({ ...valid, date: "2020-01-01" });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => /today or later|past/i.test(i.message))).toBe(true);
    }
  });
});

describe("walkInSchema", () => {
  it("accepts default priority", () => {
    expect(walkInSchema.safeParse({ patientId: UUID, doctorId: UUID }).success).toBe(true);
  });
  it("accepts URGENT priority", () => {
    expect(
      walkInSchema.safeParse({ patientId: UUID, doctorId: UUID, priority: "URGENT" }).success
    ).toBe(true);
  });
  it("rejects unknown priority", () => {
    expect(
      walkInSchema.safeParse({ patientId: UUID, doctorId: UUID, priority: "WHENEVER" as any })
        .success
    ).toBe(false);
  });
});

describe("rescheduleAppointmentSchema", () => {
  // Pearl §3.1 (gap closed 2026-05-29) — reschedule now requires a reason
  // (3-500 chars). Tests must include it in the happy-path payload; the
  // sad-path tests still send a valid reason so the assertion isolates
  // the field being tested.
  it("accepts valid date and time", () => {
    expect(
      rescheduleAppointmentSchema.safeParse({
        date: "2099-05-01",
        slotStart: "10:30",
        reason: "Patient requested a later slot",
      }).success
    ).toBe(true);
  });
  it("rejects bad time format", () => {
    expect(
      rescheduleAppointmentSchema.safeParse({
        date: "2099-05-01",
        slotStart: "10am",
        reason: "Patient requested a later slot",
      }).success
    ).toBe(false);
  });
  it("rejects missing reason", () => {
    expect(
      rescheduleAppointmentSchema.safeParse({
        date: "2099-05-01",
        slotStart: "10:30",
      }).success
    ).toBe(false);
  });
  it("rejects reason shorter than 3 chars", () => {
    expect(
      rescheduleAppointmentSchema.safeParse({
        date: "2099-05-01",
        slotStart: "10:30",
        reason: "ab",
      }).success
    ).toBe(false);
  });
});

describe("recurringAppointmentSchema", () => {
  // Issue #362 (2026-04-26): startDate must not be in the past, so the
  // fixture uses a far-future YYYY-MM-DD that's safely valid no matter
  // when the test runs.
  const valid = {
    patientId: UUID,
    doctorId: UUID,
    startDate: "2099-04-20",
    slotStart: "09:00",
    frequency: "WEEKLY" as const,
    occurrences: 4,
  };
  it("accepts a valid recurring booking", () => {
    expect(recurringAppointmentSchema.safeParse(valid).success).toBe(true);
  });
  it("rejects occurrences < 2", () => {
    expect(recurringAppointmentSchema.safeParse({ ...valid, occurrences: 1 }).success).toBe(false);
  });
  it("rejects unknown frequency", () => {
    expect(
      recurringAppointmentSchema.safeParse({ ...valid, frequency: "HOURLY" as any }).success
    ).toBe(false);
  });
});

describe("transferAppointmentSchema", () => {
  it("accepts valid transfer", () => {
    expect(
      transferAppointmentSchema.safeParse({ newDoctorId: UUID, reason: "Specialty" }).success
    ).toBe(true);
  });
  it("rejects empty reason", () => {
    expect(
      transferAppointmentSchema.safeParse({ newDoctorId: UUID, reason: "" }).success
    ).toBe(false);
  });
});

describe("markLwbsSchema", () => {
  it("accepts empty input", () => {
    expect(markLwbsSchema.safeParse({}).success).toBe(true);
  });
  it("rejects too-long reason", () => {
    expect(markLwbsSchema.safeParse({ reason: "x".repeat(501) }).success).toBe(false);
  });
});

describe("waitlistEntrySchema", () => {
  it("accepts minimal valid entry", () => {
    expect(waitlistEntrySchema.safeParse({ patientId: UUID, doctorId: UUID }).success).toBe(true);
  });
  it("rejects bad preferredDate", () => {
    expect(
      waitlistEntrySchema.safeParse({ patientId: UUID, doctorId: UUID, preferredDate: "yesterday" })
        .success
    ).toBe(false);
  });
});

describe("coordinatedVisitSchema", () => {
  it("accepts valid coordinated visit", () => {
    expect(
      coordinatedVisitSchema.safeParse({
        patientId: UUID,
        name: "Multi-specialty review",
        visitDate: "2026-05-01",
        doctorIds: [UUID, UUID],
      }).success
    ).toBe(true);
  });
  it("rejects empty doctorIds", () => {
    expect(
      coordinatedVisitSchema.safeParse({
        patientId: UUID,
        name: "x",
        visitDate: "2026-05-01",
        doctorIds: [],
      }).success
    ).toBe(false);
  });
});

// Issue #213-A: doctor schedule slots — must be intra-day and have a sensible
// duration. Previously a 20:00→08:00 row was silently accepted and rendered
// as 12 hours of nonsense 15-min slots.
describe("doctorScheduleSchema (Issue #213-A)", () => {
  const base = {
    dayOfWeek: 1,
    slotDurationMinutes: 15,
    bufferMinutes: 0,
  } as const;
  it("accepts a normal morning slot 09:00 -> 17:00", () => {
    expect(
      doctorScheduleSchema.safeParse({ ...base, startTime: "09:00", endTime: "17:00" }).success
    ).toBe(true);
  });
  it("accepts a short evening slot 20:00 -> 22:00", () => {
    expect(
      doctorScheduleSchema.safeParse({ ...base, startTime: "20:00", endTime: "22:00" }).success
    ).toBe(true);
  });
  it("rejects an overnight slot 20:00 -> 08:00", () => {
    const r = doctorScheduleSchema.safeParse({
      ...base,
      startTime: "20:00",
      endTime: "08:00",
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => /same day|night shift/i.test(i.message))).toBe(true);
    }
  });
  it("rejects a zero-length slot 09:00 -> 09:00", () => {
    expect(
      doctorScheduleSchema.safeParse({ ...base, startTime: "09:00", endTime: "09:00" }).success
    ).toBe(false);
  });
  it("rejects a slot longer than 8 hours (e.g. 06:00 -> 18:00)", () => {
    const r = doctorScheduleSchema.safeParse({
      ...base,
      startTime: "06:00",
      endTime: "18:00",
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => /too long|max is/i.test(i.message))).toBe(true);
    }
  });
  it("rejects a slot shorter than its slotDuration", () => {
    expect(
      doctorScheduleSchema.safeParse({
        ...base,
        startTime: "09:00",
        endTime: "09:10",
        slotDurationMinutes: 15,
      }).success
    ).toBe(false);
  });
});

// Issue #731 (2026-05-08): Schedule overrides in "Modify Hours" mode were
// previously accepted with End < Start (e.g. start 17:00, end 09:00 same
// day), which produced negative-duration windows that broke conflict
// detection and reporting. The schema now rejects reverse ranges; "Block
// Entire Day" mode is unaffected because times are absent in that branch.
describe("scheduleOverrideSchema (Issue #731)", () => {
  const baseDate = "2099-04-20";
  it("accepts a Block-Entire-Day override (no times)", () => {
    expect(
      scheduleOverrideSchema.safeParse({
        doctorId: UUID,
        date: baseDate,
        isBlocked: true,
      }).success
    ).toBe(true);
  });
  it("accepts a Modify-Hours override with end > start", () => {
    expect(
      scheduleOverrideSchema.safeParse({
        doctorId: UUID,
        date: baseDate,
        isBlocked: false,
        startTime: "09:00",
        endTime: "13:00",
      }).success
    ).toBe(true);
  });
  it("rejects a Modify-Hours override with end < start (reverse range)", () => {
    const r = scheduleOverrideSchema.safeParse({
      doctorId: UUID,
      date: baseDate,
      isBlocked: false,
      startTime: "17:00",
      endTime: "09:00",
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(
        r.error.issues.some((i) => /end time must be after start/i.test(i.message))
      ).toBe(true);
    }
  });
  it("rejects a Modify-Hours override with end == start (zero length)", () => {
    expect(
      scheduleOverrideSchema.safeParse({
        doctorId: UUID,
        date: baseDate,
        isBlocked: false,
        startTime: "09:00",
        endTime: "09:00",
      }).success
    ).toBe(false);
  });
});
