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

  // Issue #104 (Apr 2026): name regex.
  describe("name regex", () => {
    it("accepts honorifics with dots", () => {
      expect(
        createPatientSchema.safeParse({ ...validPatient, name: "Dr. R.K. Sharma" }).success
      ).toBe(true);
    });
    it("accepts apostrophes", () => {
      expect(
        createPatientSchema.safeParse({ ...validPatient, name: "O'Brien" }).success
      ).toBe(true);
    });
    it("accepts hyphenated double-barrelled names", () => {
      expect(
        createPatientSchema.safeParse({ ...validPatient, name: "K. Anand-Kumar" }).success
      ).toBe(true);
    });
    it("accepts Devanagari script for Hindi names", () => {
      expect(
        createPatientSchema.safeParse({ ...validPatient, name: "रामेश शर्मा" }).success
      ).toBe(true);
    });
    it("rejects digits in name", () => {
      expect(
        createPatientSchema.safeParse({ ...validPatient, name: "John1" }).success
      ).toBe(false);
    });
    it("rejects @, #, or other symbols", () => {
      expect(
        createPatientSchema.safeParse({ ...validPatient, name: "John@home" }).success
      ).toBe(false);
    });
    it("rejects email-shaped paste", () => {
      expect(
        createPatientSchema.safeParse({ ...validPatient, name: "a@b.com" }).success
      ).toBe(false);
    });
  });

  // Issue #103 (Apr 2026): phone regex tightened.
  describe("phone regex", () => {
    it("accepts a 10-digit phone", () => {
      expect(
        createPatientSchema.safeParse({ ...validPatient, phone: "9876543210" }).success
      ).toBe(true);
    });
    it("accepts a +country-code phone", () => {
      expect(
        createPatientSchema.safeParse({ ...validPatient, phone: "+919876543210" })
          .success
      ).toBe(true);
    });
    it("rejects 'abc'", () => {
      expect(
        createPatientSchema.safeParse({ ...validPatient, phone: "abc" }).success
      ).toBe(false);
    });
    it("rejects spaces in phone", () => {
      expect(
        createPatientSchema.safeParse({ ...validPatient, phone: "987 654 3210" })
          .success
      ).toBe(false);
    });
  });
});

// Issue #167 (Apr 2026): adult registration must reject age=0; pediatric
// flow (DOB-based newborn) must still accept it.
describe("createPatientSchema age=0 guard (Issue #167)", () => {
  it("rejects age=0 without dateOfBirth (adult flow)", () => {
    const r = createPatientSchema.safeParse({ ...validPatient, age: 0 });
    expect(r.success).toBe(false);
    if (!r.success) {
      const ageIssue = r.error.issues.find((i) => i.path.includes("age"));
      expect(ageIssue?.message).toMatch(/Age must be at least 1/i);
    }
  });
  it("accepts age=0 with dateOfBirth (pediatric/newborn flow)", () => {
    const r = createPatientSchema.safeParse({
      ...validPatient,
      age: 0,
      dateOfBirth: "2026-04-25",
    });
    expect(r.success).toBe(true);
  });
  it("rejects future dateOfBirth", () => {
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const r = createPatientSchema.safeParse({
      ...validPatient,
      dateOfBirth: tomorrow,
    });
    expect(r.success).toBe(false);
  });
  it("accepts adult age >= 1", () => {
    expect(
      createPatientSchema.safeParse({ ...validPatient, age: 1 }).success
    ).toBe(true);
    expect(
      createPatientSchema.safeParse({ ...validPatient, age: 35 }).success
    ).toBe(true);
  });
  it("accepts when age is omitted entirely", () => {
    // Reception may register a walk-in chart and fill DOB later; the
    // refine should NOT block the no-age path.
    expect(createPatientSchema.safeParse(validPatient).success).toBe(true);
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
      mergePatientSchema.safeParse({ otherPatientId: "550e8400-e29b-41d4-a716-446655441111" })
        .success
    ).toBe(true);
  });
  it("rejects non-uuid", () => {
    expect(mergePatientSchema.safeParse({ otherPatientId: "abc" }).success).toBe(false);
  });
});

describe("recordVitalsSchema", () => {
  const valid = {
    appointmentId: "550e8400-e29b-41d4-a716-446655441111",
    patientId: "550e8400-e29b-41d4-a716-446655442222",
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
  // Issue #544: cross-field BP refine — diastolic must be < systolic.
  // Each leg below is in-range per the per-field bounds, but the pair is
  // physiologically wrong. The .superRefine() catches it.
  it("#544 rejects diastolic >= systolic (120/130)", () => {
    const result = recordVitalsSchema.safeParse({
      ...valid,
      bloodPressureSystolic: 120,
      bloodPressureDiastolic: 130,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some(
          (i) =>
            i.path.includes("bloodPressureDiastolic") &&
            /less than systolic/i.test(i.message)
        )
      ).toBe(true);
    }
  });
  it("#544 rejects diastolic == systolic (110/110)", () => {
    expect(
      recordVitalsSchema.safeParse({
        ...valid,
        bloodPressureSystolic: 110,
        bloodPressureDiastolic: 110,
      }).success
    ).toBe(false);
  });
});
