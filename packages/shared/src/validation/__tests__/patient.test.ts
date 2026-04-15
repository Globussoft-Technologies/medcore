import { describe, it, expect } from "vitest";
import {
  createPatientSchema,
  updatePatientSchema,
  mergePatientSchema,
  recordVitalsSchema,
} from "../patient";

const validPatient = {
  name: "Bob Smith",
  gender: "MALE" as const,
  phone: "9000000000",
};

describe("createPatientSchema", () => {
  it("accepts minimum valid patient", () => {
    expect(createPatientSchema.safeParse(validPatient).success).toBe(true);
  });
  it("accepts with optional email empty string", () => {
    expect(createPatientSchema.safeParse({ ...validPatient, email: "" }).success).toBe(true);
  });
  it("rejects missing name", () => {
    expect(createPatientSchema.safeParse({ ...validPatient, name: "" }).success).toBe(false);
  });
  it("rejects bad gender enum", () => {
    expect(
      createPatientSchema.safeParse({ ...validPatient, gender: "ALIEN" as any }).success
    ).toBe(false);
  });
  it("rejects invalid blood group", () => {
    expect(
      createPatientSchema.safeParse({ ...validPatient, bloodGroup: "Z+" as any }).success
    ).toBe(false);
  });
  it("rejects out-of-range age", () => {
    expect(createPatientSchema.safeParse({ ...validPatient, age: 200 }).success).toBe(false);
  });
  it("accepts with valid photoUrl", () => {
    expect(
      createPatientSchema.safeParse({ ...validPatient, photoUrl: "https://example.com/a.jpg" })
        .success
    ).toBe(true);
  });
  it("rejects bad photoUrl", () => {
    expect(
      createPatientSchema.safeParse({ ...validPatient, photoUrl: "not a url" }).success
    ).toBe(false);
  });
});

describe("updatePatientSchema", () => {
  it("accepts an empty object (all fields optional)", () => {
    expect(updatePatientSchema.safeParse({}).success).toBe(true);
  });
  it("accepts a partial update", () => {
    expect(updatePatientSchema.safeParse({ name: "New Name" }).success).toBe(true);
  });
});

describe("mergePatientSchema", () => {
  it("accepts a valid uuid", () => {
    expect(
      mergePatientSchema.safeParse({ otherPatientId: "11111111-1111-1111-1111-111111111111" })
        .success
    ).toBe(true);
  });
  it("rejects non-uuid", () => {
    expect(mergePatientSchema.safeParse({ otherPatientId: "abc" }).success).toBe(false);
  });
});

describe("recordVitalsSchema", () => {
  const valid = {
    appointmentId: "11111111-1111-1111-1111-111111111111",
    patientId: "22222222-2222-2222-2222-222222222222",
  };
  it("accepts minimal vitals", () => {
    expect(recordVitalsSchema.safeParse(valid).success).toBe(true);
  });
  it("rejects out-of-range systolic BP", () => {
    expect(
      recordVitalsSchema.safeParse({ ...valid, bloodPressureSystolic: 999 }).success
    ).toBe(false);
  });
  it("rejects pain scale > 10", () => {
    expect(recordVitalsSchema.safeParse({ ...valid, painScale: 11 }).success).toBe(false);
  });
  it("accepts realistic vitals", () => {
    expect(
      recordVitalsSchema.safeParse({
        ...valid,
        bloodPressureSystolic: 120,
        bloodPressureDiastolic: 80,
        pulseRate: 72,
        spO2: 98,
        temperature: 98.6,
        temperatureUnit: "F",
        weight: 70,
        height: 175,
      }).success
    ).toBe(true);
  });
});
