import { describe, it, expect } from "vitest";
import {
  createWardSchema,
  createBedSchema,
  admitPatientSchema,
  dischargeSchema,
  recordIpdVitalsSchema,
  medicationOrderSchema,
  administerMedicationSchema,
} from "../ipd";
import {
  createLabOrderSchema,
  recordLabResultSchema,
  labQCSchema,
} from "../lab";

const UUID = "11111111-1111-1111-1111-111111111111";

describe("createWardSchema", () => {
  it("accepts valid ward", () => {
    expect(createWardSchema.safeParse({ name: "Ward A", type: "GENERAL" }).success).toBe(true);
  });
  it("rejects unknown ward type", () => {
    expect(
      createWardSchema.safeParse({ name: "x", type: "BASEMENT" as any }).success
    ).toBe(false);
  });
});

describe("createBedSchema", () => {
  it("accepts valid bed", () => {
    expect(
      createBedSchema.safeParse({ wardId: UUID, bedNumber: "B-101", dailyRate: 500 }).success
    ).toBe(true);
  });
  it("rejects negative daily rate", () => {
    expect(
      createBedSchema.safeParse({ wardId: UUID, bedNumber: "B-101", dailyRate: -1 }).success
    ).toBe(false);
  });
});

describe("admitPatientSchema", () => {
  it("accepts valid admission", () => {
    expect(
      admitPatientSchema.safeParse({
        patientId: UUID,
        doctorId: UUID,
        bedId: UUID,
        reason: "Pneumonia",
      }).success
    ).toBe(true);
  });
  it("rejects empty reason", () => {
    expect(
      admitPatientSchema.safeParse({
        patientId: UUID,
        doctorId: UUID,
        bedId: UUID,
        reason: "",
      }).success
    ).toBe(false);
  });
});

describe("dischargeSchema", () => {
  it("accepts valid discharge", () => {
    expect(
      dischargeSchema.safeParse({
        dischargeSummary: "Stable, discharged",
        conditionAtDischarge: "STABLE",
      }).success
    ).toBe(true);
  });
  it("rejects empty summary", () => {
    expect(dischargeSchema.safeParse({ dischargeSummary: "" }).success).toBe(false);
  });
});

describe("recordIpdVitalsSchema", () => {
  it("accepts valid vitals", () => {
    expect(
      recordIpdVitalsSchema.safeParse({ admissionId: UUID, pulseRate: 70 }).success
    ).toBe(true);
  });
  it("rejects pain score > 10", () => {
    expect(
      recordIpdVitalsSchema.safeParse({ admissionId: UUID, painScore: 11 }).success
    ).toBe(false);
  });
});

describe("medicationOrderSchema", () => {
  it("accepts valid medication order", () => {
    expect(
      medicationOrderSchema.safeParse({
        admissionId: UUID,
        medicineName: "Paracetamol",
        dosage: "500mg",
        frequency: "TDS",
        route: "Oral",
      }).success
    ).toBe(true);
  });
  it("rejects missing route", () => {
    expect(
      medicationOrderSchema.safeParse({
        admissionId: UUID,
        medicineName: "x",
        dosage: "1",
        frequency: "1",
      }).success
    ).toBe(false);
  });
});

describe("administerMedicationSchema", () => {
  it("accepts ADMINISTERED status", () => {
    expect(administerMedicationSchema.safeParse({ status: "ADMINISTERED" }).success).toBe(true);
  });
  it("rejects unknown status", () => {
    expect(
      administerMedicationSchema.safeParse({ status: "FORGOT" as any }).success
    ).toBe(false);
  });
});

describe("createLabOrderSchema", () => {
  it("accepts valid lab order", () => {
    expect(
      createLabOrderSchema.safeParse({
        patientId: UUID,
        doctorId: UUID,
        testIds: [UUID],
      }).success
    ).toBe(true);
  });
  it("rejects empty testIds", () => {
    expect(
      createLabOrderSchema.safeParse({
        patientId: UUID,
        doctorId: UUID,
        testIds: [],
      }).success
    ).toBe(false);
  });
});

describe("recordLabResultSchema", () => {
  it("accepts valid result", () => {
    expect(
      recordLabResultSchema.safeParse({
        orderItemId: UUID,
        parameter: "Hb",
        value: "13.5",
        flag: "NORMAL",
      }).success
    ).toBe(true);
  });
  it("rejects invalid flag", () => {
    expect(
      recordLabResultSchema.safeParse({
        orderItemId: UUID,
        parameter: "Hb",
        value: "13.5",
        flag: "WEIRD" as any,
      }).success
    ).toBe(false);
  });
});

describe("labQCSchema", () => {
  it("accepts valid QC entry", () => {
    expect(
      labQCSchema.safeParse({
        testId: UUID,
        qcLevel: "NORMAL",
        meanValue: 10,
        recordedValue: 10.2,
        withinRange: true,
      }).success
    ).toBe(true);
  });
});
