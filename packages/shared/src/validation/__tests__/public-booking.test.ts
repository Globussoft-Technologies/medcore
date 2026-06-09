// Contract tests for the public quick-booking schemas (June 2026). These pin
// the input shape the unauthenticated /public/booking endpoints accept so the
// marketing booking page and the API stay in lockstep.

import { describe, it, expect } from "vitest";
import { suggestDoctorsSchema, publicBookSchema } from "../public-booking";

describe("suggestDoctorsSchema", () => {
  it("accepts a symptom + ISO date", () => {
    expect(
      suggestDoctorsSchema.safeParse({ symptom: "fever", date: "2026-06-15" })
        .success,
    ).toBe(true);
  });
  it("accepts a generic 'general doctor' symptom", () => {
    expect(
      suggestDoctorsSchema.safeParse({
        symptom: "general doctor",
        date: "2026-06-15",
      }).success,
    ).toBe(true);
  });
  it("rejects an empty symptom", () => {
    expect(
      suggestDoctorsSchema.safeParse({ symptom: "", date: "2026-06-15" }).success,
    ).toBe(false);
  });
  it("rejects a non-ISO date", () => {
    expect(
      suggestDoctorsSchema.safeParse({ symptom: "fever", date: "15/06/2026" })
        .success,
    ).toBe(false);
  });
  it("rejects a symptom over 500 chars (prompt-stuffing guard)", () => {
    expect(
      suggestDoctorsSchema.safeParse({
        symptom: "a".repeat(501),
        date: "2026-06-15",
      }).success,
    ).toBe(false);
  });
});

describe("publicBookSchema", () => {
  const valid = {
    name: "Asha Kumari",
    phone: "+919876543210",
    doctorId: "11111111-1111-4111-8111-111111111111",
    date: "2026-06-15",
    slotId: "10:15",
    // gender + dateOfBirth are now required on the booking step.
    gender: "FEMALE",
    dateOfBirth: "1992-04-17",
  };
  it("accepts a complete booking body", () => {
    expect(publicBookSchema.safeParse(valid).success).toBe(true);
  });
  it("accepts an optional symptom", () => {
    expect(
      publicBookSchema.safeParse({ ...valid, symptom: "fever" }).success,
    ).toBe(true);
  });
  it("rejects a name with digits", () => {
    expect(
      publicBookSchema.safeParse({ ...valid, name: "Asha123" }).success,
    ).toBe(false);
  });
  it("rejects a too-short phone", () => {
    expect(
      publicBookSchema.safeParse({ ...valid, phone: "12345" }).success,
    ).toBe(false);
  });
  it("rejects a non-uuid doctorId", () => {
    expect(
      publicBookSchema.safeParse({ ...valid, doctorId: "not-a-uuid" }).success,
    ).toBe(false);
  });
  it("rejects a non-HH:MM slot", () => {
    expect(
      publicBookSchema.safeParse({ ...valid, slotId: "10am" }).success,
    ).toBe(false);
  });
  it("rejects a missing gender", () => {
    const { gender, ...noGender } = valid;
    void gender;
    expect(publicBookSchema.safeParse(noGender).success).toBe(false);
  });
  it("rejects a missing dateOfBirth", () => {
    const { dateOfBirth, ...noDob } = valid;
    void dateOfBirth;
    expect(publicBookSchema.safeParse(noDob).success).toBe(false);
  });
  it("rejects a malformed dateOfBirth", () => {
    expect(
      publicBookSchema.safeParse({ ...valid, dateOfBirth: "17-04-1992" })
        .success,
    ).toBe(false);
  });
  it("accepts an optional email (and an empty string)", () => {
    expect(
      publicBookSchema.safeParse({ ...valid, email: "a@b.com" }).success,
    ).toBe(true);
    expect(
      publicBookSchema.safeParse({ ...valid, email: "" }).success,
    ).toBe(true);
  });
  it("rejects a malformed email when provided", () => {
    expect(
      publicBookSchema.safeParse({ ...valid, email: "not-an-email" }).success,
    ).toBe(false);
  });
});
