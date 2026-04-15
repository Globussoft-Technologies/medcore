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
} from "../appointment";

const UUID = "11111111-1111-1111-1111-111111111111";

describe("bookAppointmentSchema", () => {
  const valid = { patientId: UUID, doctorId: UUID, date: "2026-04-20", slotId: UUID };
  it("accepts a valid booking", () => {
    expect(bookAppointmentSchema.safeParse(valid).success).toBe(true);
  });
  it("rejects bad date format", () => {
    expect(bookAppointmentSchema.safeParse({ ...valid, date: "20-04-2026" }).success).toBe(false);
  });
  it("rejects non-uuid patientId", () => {
    expect(bookAppointmentSchema.safeParse({ ...valid, patientId: "abc" }).success).toBe(false);
  });
  it("rejects missing slotId", () => {
    const { slotId, ...rest } = valid;
    expect(bookAppointmentSchema.safeParse(rest).success).toBe(false);
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
  it("accepts valid date and time", () => {
    expect(
      rescheduleAppointmentSchema.safeParse({ date: "2026-05-01", slotStart: "10:30" }).success
    ).toBe(true);
  });
  it("rejects bad time format", () => {
    expect(
      rescheduleAppointmentSchema.safeParse({ date: "2026-05-01", slotStart: "10am" }).success
    ).toBe(false);
  });
});

describe("recurringAppointmentSchema", () => {
  const valid = {
    patientId: UUID,
    doctorId: UUID,
    startDate: "2026-04-20",
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
