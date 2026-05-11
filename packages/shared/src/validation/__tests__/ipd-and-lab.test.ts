import { describe, it, expect } from "vitest";
import {
  createWardSchema,
  createBedSchema,
  admitPatientSchema,
  dischargeSchema,
  recordIpdVitalsSchema,
  medicationOrderSchema,
  administerMedicationSchema,
  intakeOutputSchema,
} from "../ipd";
import {
  createLabOrderSchema,
  recordLabResultSchema,
  labQCSchema,
  validateNumericLabResult,
} from "../lab";

const UUID = "550e8400-e29b-41d4-a716-446655441111";

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

  // ─── #419 (2026-04-30) Vitals form must reject impossible values ─────
  // The pre-#419 form accepted Temp=999°C, BP=999/999, HR=9999. The shared
  // schema is the last line of defense — assert each impossible value is
  // refused individually.
  it("#419 rejects Temp=999°C, BP=999/999, HR=9999 in admission Vitals", () => {
    // 999°C — far above the 32–43 °C ceiling; submit with explicit °C unit.
    expect(
      recordIpdVitalsSchema.safeParse({
        admissionId: UUID,
        temperature: 999,
        temperatureUnit: "C",
      }).success
    ).toBe(false);
    // 999/999 BP — both bounds blown.
    expect(
      recordIpdVitalsSchema.safeParse({
        admissionId: UUID,
        bloodPressureSystolic: 999,
        bloodPressureDiastolic: 999,
      }).success
    ).toBe(false);
    // 9999 bpm — pulse rate ceiling is 220.
    expect(
      recordIpdVitalsSchema.safeParse({ admissionId: UUID, pulseRate: 9999 })
        .success
    ).toBe(false);
  });

  // ─── #200 (2026-04-30) Temp unit canonical to °C in admission Vitals ─
  // A nurse trained on the doctor's °F modal could type "98.6" into the
  // °C admission field. With temperatureUnit pinned to "C" by the form,
  // 98.6 must be rejected (it lands far outside the °C ceiling of 43)
  // — and the same number tagged as "F" should pass. This is the
  // canary for the cross-unit confusion.
  it("#200 admission Vitals: 98.6 °C is rejected, 98.6 °F is accepted", () => {
    expect(
      recordIpdVitalsSchema.safeParse({
        admissionId: UUID,
        temperature: 98.6,
        temperatureUnit: "C",
      }).success
    ).toBe(false);
    expect(
      recordIpdVitalsSchema.safeParse({
        admissionId: UUID,
        temperature: 98.6,
        temperatureUnit: "F",
      }).success
    ).toBe(true);
  });

  // ─── Issue #544 — cross-field BP refine on admission Vitals ─────────
  // 120/130 has each leg in-range per the per-field bounds, but the pair
  // is physiologically wrong (diastolic >= systolic). The .superRefine()
  // is the last line of defense.
  it("#544 admission Vitals rejects diastolic >= systolic (120/130)", () => {
    const result = recordIpdVitalsSchema.safeParse({
      admissionId: UUID,
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
  it("#544 admission Vitals rejects diastolic == systolic (110/110)", () => {
    expect(
      recordIpdVitalsSchema.safeParse({
        admissionId: UUID,
        bloodPressureSystolic: 110,
        bloodPressureDiastolic: 110,
      }).success
    ).toBe(false);
  });
  it("#544 admission Vitals accepts realistic 120/80", () => {
    expect(
      recordIpdVitalsSchema.safeParse({
        admissionId: UUID,
        bloodPressureSystolic: 120,
        bloodPressureDiastolic: 80,
      }).success
    ).toBe(true);
  });
});

describe("intakeOutputSchema", () => {
  // ─── #433 (2026-04-30) I/O must reject negatives + cap per-entry vol ─
  it("#433 rejects negative volumes and over-cap volumes; accepts in-range", () => {
    // Negative — distorts running balance.
    expect(
      intakeOutputSchema.safeParse({
        admissionId: UUID,
        type: "INTAKE_ORAL",
        amountMl: -500,
      }).success
    ).toBe(false);
    // Above per-entry cap (10000 mL).
    expect(
      intakeOutputSchema.safeParse({
        admissionId: UUID,
        type: "OUTPUT_URINE",
        amountMl: 99999,
      }).success
    ).toBe(false);
    // Plausible 250 mL oral intake — accepted.
    expect(
      intakeOutputSchema.safeParse({
        admissionId: UUID,
        type: "INTAKE_ORAL",
        amountMl: 250,
      }).success
    ).toBe(true);
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
  // Issue #616: Unit must reject angle-bracket / script payloads outright,
  // not silently strip them down to `alert(1)`. The global sanitize
  // middleware bypasses /api/v1/lab/results so the schema sees the raw
  // payload and a regex mismatch fires the 400.
  it("accepts canonical clinical units", () => {
    for (const unit of ["mg/dL", "mmol/L", "µg/mL", "IU/mL", "cells/mm³", "% (v/v)", "°C"]) {
      const out = recordLabResultSchema.safeParse({
        orderItemId: UUID,
        parameter: "Hb",
        value: "13.5",
        unit,
      });
      expect(out.success, `unit "${unit}" should be accepted`).toBe(true);
    }
  });
  it("rejects HTML/script payloads in unit (Issue #616)", () => {
    for (const unit of [
      "<script>alert(1)</script>",
      "mg/dL<img src=x>",
      'mg/dL"',
      "mg/dL;",
      "mg/dL=1",
      "mg/dL`",
    ]) {
      const out = recordLabResultSchema.safeParse({
        orderItemId: UUID,
        parameter: "Hb",
        value: "13.5",
        unit,
      });
      expect(out.success, `unit "${unit}" should be rejected`).toBe(false);
    }
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

// Issue #95 (Apr 2026): a numeric test must reject free-text values to
// preserve delta-checks and panic alerts.
describe("validateNumericLabResult", () => {
  it("accepts a number when test has a unit", () => {
    expect(
      validateNumericLabResult({ value: "13.5", test: { unit: "g/dL" } })
    ).toBeNull();
  });
  it("accepts a number when test has panicLow set", () => {
    expect(
      validateNumericLabResult({
        value: "70",
        test: { unit: null, panicLow: 50, panicHigh: null },
      })
    ).toBeNull();
  });
  it("rejects free text on a numeric test", () => {
    const issue = validateNumericLabResult({
      value: "abc",
      test: { unit: "mg/dL" },
    });
    expect(issue).not.toBeNull();
    expect(issue?.field).toBe("value");
  });
  it("rejects mixed alphanumerics on a numeric test", () => {
    expect(
      validateNumericLabResult({
        value: "12abc",
        test: { unit: "mg/dL" },
      })
    ).not.toBeNull();
  });
  it("allows free text on a non-numeric test (no unit, no panic)", () => {
    expect(
      validateNumericLabResult({
        value: "Yellow, clear",
        test: { unit: null, panicLow: null, panicHigh: null },
      })
    ).toBeNull();
  });
  it("accepts decimals and accepts negatives only when panicLow < 0", () => {
    // Decimal positive is fine.
    expect(
      validateNumericLabResult({ value: "1.4", test: { unit: "mEq/L" } })
    ).toBeNull();
    // Issue #611: negative values are biologically impossible for most
    // tests — reject them unless the test's own panicLow is itself
    // negative (e.g. base excess, anion gap).
    const negOnPlainNumeric = validateNumericLabResult({
      value: "-1.4",
      test: { unit: "mEq/L" },
    });
    expect(negOnPlainNumeric).not.toBeNull();
    expect(negOnPlainNumeric?.field).toBe("value");
    expect(
      validateNumericLabResult({
        value: "-1.4",
        test: { unit: "mEq/L", panicLow: -3, panicHigh: 3 },
      })
    ).toBeNull();
  });

  // Issue #611 (May 2026): a LabTech submitting NORMAL for a value that
  // is outside the panic range must be overridden to CRITICAL by the
  // server so dangerous results cannot be buried.
  describe("deriveLabResultFlag (#611)", () => {
    it("elevates NORMAL to CRITICAL when value is below panicLow", async () => {
      const { deriveLabResultFlag } = await import("../lab");
      expect(
        deriveLabResultFlag({
          value: "0.2",
          flag: "NORMAL",
          test: { panicLow: 0.6, panicHigh: 1.3 },
        })
      ).toBe("CRITICAL");
    });
    it("elevates NORMAL to CRITICAL when value is above panicHigh", async () => {
      const { deriveLabResultFlag } = await import("../lab");
      expect(
        deriveLabResultFlag({
          value: "39",
          flag: "NORMAL",
          test: { panicLow: 0.6, panicHigh: 5 },
        })
      ).toBe("CRITICAL");
    });
    it("retains submitted flag when value is inside panic range", async () => {
      const { deriveLabResultFlag } = await import("../lab");
      expect(
        deriveLabResultFlag({
          value: "1.0",
          flag: "NORMAL",
          test: { panicLow: 0.6, panicHigh: 5 },
        })
      ).toBe("NORMAL");
    });
    it("falls through for non-numeric value (cannot evaluate threshold)", async () => {
      const { deriveLabResultFlag } = await import("../lab");
      expect(
        deriveLabResultFlag({
          value: "Yellow",
          flag: "NORMAL",
          test: { panicLow: null, panicHigh: null },
        })
      ).toBe("NORMAL");
    });
  });

  // Issue #622 (May 2026): the order detail page surfaces a file-upload
  // control instead of the numeric Add-Result form for orders that
  // contain at least one imaging / radiology test. The detection helper
  // must catch the canonical modalities (Ultrasound, X-Ray, ECG,
  // Echocardiogram, MRI, CT, etc.) without false-positives on regular
  // hematology / biochemistry panels.
  describe("isImagingLabTest (#622)", () => {
    it("matches the modalities listed in the issue body", async () => {
      const { isImagingLabTest } = await import("../lab");
      const cases = [
        "Ultrasound Abdomen",
        "Ultrasound Pelvis",
        "X-Ray Chest PA",
        "ECG",
        "2D Echocardiogram",
        "MRI Brain",
        "CT Head",
        "Mammography",
      ];
      for (const name of cases) {
        expect(
          isImagingLabTest({ name, category: "Procedure" }),
          `expected "${name}" to be detected as imaging`,
        ).toBe(true);
      }
    });
    it("matches by the category label too (Radiology / Imaging)", async () => {
      const { isImagingLabTest } = await import("../lab");
      expect(
        isImagingLabTest({ name: "Random Study 7", category: "Radiology" }),
      ).toBe(true);
      expect(
        isImagingLabTest({ name: "Random Study 7", category: "Imaging" }),
      ).toBe(true);
    });
    it("does NOT match standard panels", async () => {
      const { isImagingLabTest } = await import("../lab");
      const negatives = [
        { name: "Complete Blood Count", category: "Hematology" },
        { name: "Liver Function Test", category: "Biochemistry" },
        { name: "HbA1c", category: "Biochemistry" },
        { name: "Thyroid Panel", category: "Endocrinology" },
        { name: "Urine Routine", category: "Microbiology" },
      ];
      for (const t of negatives) {
        expect(
          isImagingLabTest(t),
          `expected "${t.name}" NOT to be detected as imaging`,
        ).toBe(false);
      }
    });
    it("handles missing / null category", async () => {
      const { isImagingLabTest } = await import("../lab");
      expect(
        isImagingLabTest({ name: "USG Abdomen", category: null }),
      ).toBe(true);
      expect(isImagingLabTest({ name: "CBC", category: null })).toBe(false);
    });
  });

  // Issue #620 (May 2026): the result-entry form decides between three
  // input modes — imaging upload, qualitative dropdown, numeric/text. The
  // detector must flag classic qualitative serology / microbiology /
  // parasitology panels (Hep B, HIV, Widal, ANA, Dengue, urine pregnancy,
  // etc.) as qualitative, while keeping numeric panels (CBC, Lipid, KFT,
  // LFT, HbA1c, TSH) on the numeric path.
  describe("getLabTestResultMode (#620)", () => {
    it("flags the modalities listed in the issue body as qualitative", async () => {
      const { getLabTestResultMode } = await import("../lab");
      const cases = [
        "Hepatitis B Surface Antigen",
        "Hepatitis C Antibody",
        "HIV I & II Screening",
        "Widal Test",
        "ANA",
        "Dengue NS1",
        "Dengue IgM",
        "Malaria Parasite",
        "Urine Pregnancy Test",
        "Stool Routine",
      ];
      for (const name of cases) {
        expect(
          getLabTestResultMode({ name, category: null }),
          `expected "${name}" to be detected as qualitative`,
        ).toBe("qualitative");
      }
    });

    it("keeps standard numeric panels on the numeric path", async () => {
      const { getLabTestResultMode } = await import("../lab");
      const cases: Array<{ name: string; unit?: string | null }> = [
        { name: "Complete Blood Count", unit: "x10^3/uL" },
        { name: "HbA1c", unit: "%" },
        { name: "Lipid Profile - Total Cholesterol", unit: "mg/dL" },
        { name: "TSH", unit: "uIU/mL" },
        { name: "Creatinine", unit: "mg/dL" },
      ];
      for (const t of cases) {
        expect(
          getLabTestResultMode({ name: t.name, category: null, unit: t.unit }),
          `expected "${t.name}" to stay numeric`,
        ).toBe("numeric");
      }
    });

    it("keeps imaging tests on the imaging path", async () => {
      const { getLabTestResultMode } = await import("../lab");
      expect(
        getLabTestResultMode({ name: "Ultrasound Abdomen", category: "Procedure" }),
      ).toBe("imaging");
      expect(
        getLabTestResultMode({ name: "X-Ray Chest", category: null }),
      ).toBe("imaging");
    });

    it("prefers numeric when the test has unit/panic thresholds even if the name matches a qualitative token", async () => {
      // "HIV-1 RNA copies/mL" is quantitative even though it mentions HIV —
      // the unit signal must win.
      const { getLabTestResultMode } = await import("../lab");
      expect(
        getLabTestResultMode({
          name: "HIV-1 RNA",
          category: null,
          unit: "copies/mL",
        }),
      ).toBe("numeric");
    });

    it("falls back to numeric for tests with no qualitative or imaging signal", async () => {
      const { getLabTestResultMode } = await import("../lab");
      expect(
        getLabTestResultMode({ name: "Sodium", category: null, unit: null }),
      ).toBe("numeric");
    });
  });
});
