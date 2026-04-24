import { describe, it, expect } from "vitest";
import {
  createPrescriptionSchema,
  copyPrescriptionSchema,
  prescriptionTemplateSchema,
  renalDoseCalcSchema,
} from "../prescription";
import { createReferralSchema, scheduleSurgerySchema } from "../clinical";

const UUID = "11111111-1111-1111-1111-111111111111";
const item = {
  medicineName: "Paracetamol",
  dosage: "500mg",
  frequency: "TDS",
  duration: "5 days",
};

describe("createPrescriptionSchema", () => {
  const valid = {
    appointmentId: UUID,
    patientId: UUID,
    diagnosis: "Fever",
    items: [item],
  };
  it("accepts valid prescription", () => {
    expect(createPrescriptionSchema.safeParse(valid).success).toBe(true);
  });
  it("rejects empty items", () => {
    expect(createPrescriptionSchema.safeParse({ ...valid, items: [] }).success).toBe(false);
  });
  it("rejects missing diagnosis", () => {
    expect(createPrescriptionSchema.safeParse({ ...valid, diagnosis: "" }).success).toBe(false);
  });
  it("rejects bad followUpDate format", () => {
    expect(
      createPrescriptionSchema.safeParse({ ...valid, followUpDate: "next monday" }).success
    ).toBe(false);
  });

  // ─── Issue #9 (negative / zero dosage) ──────────────────────────
  it("rejects negative dosage -100mg", () => {
    expect(
      createPrescriptionSchema.safeParse({
        ...valid,
        items: [{ ...item, dosage: "-100mg" }],
      }).success
    ).toBe(false);
  });
  it("rejects zero dosage 0mg", () => {
    expect(
      createPrescriptionSchema.safeParse({
        ...valid,
        items: [{ ...item, dosage: "0mg" }],
      }).success
    ).toBe(false);
  });
  it("rejects plain text dosage 'lots'", () => {
    expect(
      createPrescriptionSchema.safeParse({
        ...valid,
        items: [{ ...item, dosage: "lots" }],
      }).success
    ).toBe(false);
  });
  it("accepts decimal dosage 0.25 mg", () => {
    expect(
      createPrescriptionSchema.safeParse({
        ...valid,
        items: [{ ...item, dosage: "0.25 mg" }],
      }).success
    ).toBe(true);
  });
  it("accepts unitless positive dosage '1'", () => {
    expect(
      createPrescriptionSchema.safeParse({
        ...valid,
        items: [{ ...item, dosage: "1" }],
      }).success
    ).toBe(true);
  });

  // ─── Issue #17 (UUID validation on appointmentId / patientId) ─────
  it("rejects malformed appointmentId 'abc'", () => {
    expect(
      createPrescriptionSchema.safeParse({ ...valid, appointmentId: "abc" }).success
    ).toBe(false);
  });
  it("rejects malformed patientId 'xyz'", () => {
    expect(
      createPrescriptionSchema.safeParse({ ...valid, patientId: "xyz" }).success
    ).toBe(false);
  });
});

describe("copyPrescriptionSchema", () => {
  it("accepts valid copy", () => {
    expect(
      copyPrescriptionSchema.safeParse({
        previousPrescriptionId: UUID,
        appointmentId: UUID,
      }).success
    ).toBe(true);
  });
  it("rejects non-uuid", () => {
    expect(
      copyPrescriptionSchema.safeParse({ previousPrescriptionId: "x", appointmentId: UUID }).success
    ).toBe(false);
  });
});

describe("prescriptionTemplateSchema", () => {
  it("accepts valid template", () => {
    expect(
      prescriptionTemplateSchema.safeParse({
        name: "Common Cold",
        diagnosis: "URI",
        items: [item],
      }).success
    ).toBe(true);
  });
});

describe("renalDoseCalcSchema", () => {
  it("accepts valid input", () => {
    expect(
      renalDoseCalcSchema.safeParse({
        medicineId: UUID,
        creatinineMgDl: 1.2,
        ageYears: 50,
        weightKg: 70,
        genderMale: true,
      }).success
    ).toBe(true);
  });
  it("rejects negative creatinine", () => {
    expect(
      renalDoseCalcSchema.safeParse({
        medicineId: UUID,
        creatinineMgDl: -1,
        ageYears: 50,
        weightKg: 70,
        genderMale: true,
      }).success
    ).toBe(false);
  });
});

describe("createReferralSchema", () => {
  it("accepts internal referral", () => {
    expect(
      createReferralSchema.safeParse({
        patientId: UUID,
        fromDoctorId: UUID,
        toDoctorId: UUID,
        reason: "Cardiology consult",
      }).success
    ).toBe(true);
  });
  it("accepts external referral", () => {
    expect(
      createReferralSchema.safeParse({
        patientId: UUID,
        fromDoctorId: UUID,
        externalProvider: "City Hospital",
        reason: "Specialty",
      }).success
    ).toBe(true);
  });
  it("rejects when neither toDoctorId nor externalProvider provided", () => {
    expect(
      createReferralSchema.safeParse({
        patientId: UUID,
        fromDoctorId: UUID,
        reason: "x",
      }).success
    ).toBe(false);
  });
  // Issue #10: reason is a required field — confirm empty reason is rejected
  // even when every other destination field is valid.
  it("rejects empty reason (issue #10)", () => {
    const result = createReferralSchema.safeParse({
      patientId: UUID,
      fromDoctorId: UUID,
      toDoctorId: UUID,
      reason: "",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path[0] === "reason")).toBe(true);
    }
  });
  it("rejects missing reason field entirely", () => {
    expect(
      createReferralSchema.safeParse({
        patientId: UUID,
        fromDoctorId: UUID,
        toDoctorId: UUID,
      }).success
    ).toBe(false);
  });
});

describe("scheduleSurgerySchema", () => {
  it("accepts a valid surgery schedule", () => {
    expect(
      scheduleSurgerySchema.safeParse({
        patientId: UUID,
        surgeonId: UUID,
        otId: UUID,
        procedure: "Appendectomy",
        scheduledAt: new Date().toISOString(),
      }).success
    ).toBe(true);
  });
  it("rejects bad scheduledAt", () => {
    expect(
      scheduleSurgerySchema.safeParse({
        patientId: UUID,
        surgeonId: UUID,
        otId: UUID,
        procedure: "x",
        scheduledAt: "not-a-date",
      }).success
    ).toBe(false);
  });
});
