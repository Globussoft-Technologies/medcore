import { describe, it, expect } from "vitest";
import {
  dosageStringSchema,
  durationStringSchema,
  createPrescriptionSchema,
  copyPrescriptionSchema,
  sharePrescriptionSchema,
  prescriptionTemplateSchema,
  renalDoseCalcSchema,
} from "../prescription";

const UUID = "11111111-1111-1111-1111-111111111111";

describe("dosageStringSchema", () => {
  it("accepts canonical dosage strings", () => {
    expect(dosageStringSchema.safeParse("500mg").success).toBe(true);
    expect(dosageStringSchema.safeParse("0.25 mg").success).toBe(true);
    expect(dosageStringSchema.safeParse("1 tab").success).toBe(true);
  });
  it("rejects negative dosage (Issue #9)", () => {
    expect(dosageStringSchema.safeParse("-100mg").success).toBe(false);
  });
  it("rejects zero dosage", () => {
    expect(dosageStringSchema.safeParse("0mg").success).toBe(false);
  });
  it("rejects free-text junk", () => {
    expect(dosageStringSchema.safeParse("a few drops").success).toBe(false);
  });
  it("rejects empty string", () => {
    expect(dosageStringSchema.safeParse("").success).toBe(false);
  });
});

describe("durationStringSchema (Issue #542)", () => {
  it("accepts canonical duration strings", () => {
    expect(durationStringSchema.safeParse("5 days").success).toBe(true);
    expect(durationStringSchema.safeParse("2 weeks").success).toBe(true);
    expect(durationStringSchema.safeParse("1 month").success).toBe(true);
    expect(durationStringSchema.safeParse("8 hours").success).toBe(true);
    expect(durationStringSchema.safeParse("3d").success).toBe(true);
  });
  it("accepts the em-dash placeholder used by the form", () => {
    expect(durationStringSchema.safeParse("—").success).toBe(true);
  });
  it("rejects negative duration", () => {
    expect(durationStringSchema.safeParse("-5 days").success).toBe(false);
  });
  it("rejects zero duration", () => {
    expect(durationStringSchema.safeParse("0 days").success).toBe(false);
  });
  it("rejects free-text junk", () => {
    expect(durationStringSchema.safeParse("a while").success).toBe(false);
    expect(durationStringSchema.safeParse("forever").success).toBe(false);
  });
});

describe("createPrescriptionSchema", () => {
  const validItem = {
    medicineName: "Paracetamol",
    dosage: "500mg",
    frequency: "TDS",
    duration: "3 days",
  };
  const valid = {
    appointmentId: UUID,
    patientId: UUID,
    diagnosis: "Viral fever",
    items: [validItem],
  };
  it("accepts a valid prescription", () => {
    expect(createPrescriptionSchema.safeParse(valid).success).toBe(true);
  });
  it("rejects empty items array", () => {
    expect(createPrescriptionSchema.safeParse({ ...valid, items: [] }).success).toBe(false);
  });
  it("rejects empty diagnosis", () => {
    expect(createPrescriptionSchema.safeParse({ ...valid, diagnosis: "" }).success).toBe(false);
  });
  it("rejects bad followUpDate format", () => {
    expect(
      createPrescriptionSchema.safeParse({ ...valid, followUpDate: "next-week" }).success
    ).toBe(false);
  });
  it("rejects refills > 12", () => {
    const bad = { ...valid, items: [{ ...validItem, refills: 20 }] };
    expect(createPrescriptionSchema.safeParse(bad).success).toBe(false);
  });
  it("rejects negative refills", () => {
    const bad = { ...valid, items: [{ ...validItem, refills: -1 }] };
    expect(createPrescriptionSchema.safeParse(bad).success).toBe(false);
  });
});

describe("copyPrescriptionSchema", () => {
  it("accepts valid copy input", () => {
    expect(
      copyPrescriptionSchema.safeParse({
        previousPrescriptionId: UUID,
        appointmentId: UUID,
      }).success
    ).toBe(true);
  });
  it("rejects non-uuid previousPrescriptionId", () => {
    expect(
      copyPrescriptionSchema.safeParse({
        previousPrescriptionId: "not-a-uuid",
        appointmentId: UUID,
      }).success
    ).toBe(false);
  });
});

describe("sharePrescriptionSchema", () => {
  it("accepts WHATSAPP channel", () => {
    expect(sharePrescriptionSchema.safeParse({ channel: "WHATSAPP" }).success).toBe(true);
  });
  it("rejects unknown channel", () => {
    expect(sharePrescriptionSchema.safeParse({ channel: "FAX" as any }).success).toBe(false);
  });
});

describe("prescriptionTemplateSchema", () => {
  const validItem = {
    medicineName: "Amoxicillin",
    dosage: "500mg",
    frequency: "BD",
    duration: "5 days",
  };
  it("accepts a valid template", () => {
    expect(
      prescriptionTemplateSchema.safeParse({
        name: "URTI",
        diagnosis: "Upper respiratory infection",
        items: [validItem],
      }).success
    ).toBe(true);
  });
  it("rejects name shorter than 2 chars", () => {
    expect(
      prescriptionTemplateSchema.safeParse({
        name: "X",
        diagnosis: "URTI",
        items: [validItem],
      }).success
    ).toBe(false);
  });
});

describe("renalDoseCalcSchema", () => {
  const valid = {
    medicineId: UUID,
    creatinineMgDl: 1.2,
    ageYears: 60,
    weightKg: 70,
    genderMale: true,
  };
  it("accepts valid input", () => {
    expect(renalDoseCalcSchema.safeParse(valid).success).toBe(true);
  });
  it("rejects non-positive creatinine", () => {
    expect(renalDoseCalcSchema.safeParse({ ...valid, creatinineMgDl: 0 }).success).toBe(false);
  });
  it("rejects non-integer ageYears", () => {
    expect(renalDoseCalcSchema.safeParse({ ...valid, ageYears: 60.5 }).success).toBe(false);
  });
});
