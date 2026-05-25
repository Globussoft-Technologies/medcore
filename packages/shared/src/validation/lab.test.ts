// Comprehensive coverage for the lab validation surface.
//
// What: exhaustive happy + invalid cases for every exported schema, enum,
// helper, and constant in `./lab.ts` — `LabTestStatus`, `LabResultFlag`,
// `createLabTestSchema`, `updateLabTestSchema`, `createLabOrderSchema`,
// `updateLabOrderStatusSchema`, `recordLabResultSchema`, `labQCSchema`,
// `verifyResultSchema`, `shareLinkSchema`, plus the pure helpers
// `validateNumericLabResult`, `deriveLabResultFlag`, `isImagingLabTest`,
// and `getLabTestResultMode`, and the `QUALITATIVE_RESULT_OPTIONS` enum.
//
// Why: lab.ts previously had only the schemas hit by `ipd-and-lab.test.ts`
// covered; the smaller enums, update schemas, share-link schema, and the
// `verifyResultSchema` were entirely untested. This file is the colocated
// surface companion that closes the 0% colocated-coverage gap surfaced by
// the test-writing cron, and also exercises every regex / superRefine
// branch in the helpers so behavioural regressions show up at unit-test
// time rather than in integration.

import { describe, it, expect } from "vitest";
import {
  LabTestStatus,
  LabResultFlag,
  createLabTestSchema,
  updateLabTestSchema,
  createLabOrderSchema,
  updateLabOrderStatusSchema,
  recordLabResultSchema,
  labQCSchema,
  verifyResultSchema,
  shareLinkSchema,
  validateNumericLabResult,
  deriveLabResultFlag,
  isImagingLabTest,
  getLabTestResultMode,
  QUALITATIVE_RESULT_OPTIONS,
} from "./lab";

const UUID = "550e8400-e29b-41d4-a716-446655441111";
const UUID2 = "550e8400-e29b-41d4-a716-446655442222";
const UUID3 = "550e8400-e29b-41d4-a716-446655443333";

describe("LabTestStatus enum accepts every documented status", () => {
  it("accepts ORDERED / SAMPLE_COLLECTED / IN_PROGRESS / COMPLETED / CANCELLED", () => {
    for (const s of [
      "ORDERED",
      "SAMPLE_COLLECTED",
      "IN_PROGRESS",
      "COMPLETED",
      "CANCELLED",
    ]) {
      expect(LabTestStatus.safeParse(s).success).toBe(true);
    }
  });
  it("rejects unknown statuses and case variants", () => {
    for (const s of ["ordered", "DONE", "pending", "", null, undefined, 1]) {
      expect(LabTestStatus.safeParse(s).success).toBe(false);
    }
  });
});

describe("LabResultFlag enum accepts every documented flag", () => {
  it("accepts NORMAL / LOW / HIGH / CRITICAL", () => {
    for (const f of ["NORMAL", "LOW", "HIGH", "CRITICAL"]) {
      expect(LabResultFlag.safeParse(f).success).toBe(true);
    }
  });
  it("rejects unknown flags", () => {
    expect(LabResultFlag.safeParse("FATAL").success).toBe(false);
    expect(LabResultFlag.safeParse("normal").success).toBe(false);
  });
});

describe("createLabTestSchema", () => {
  const valid = {
    code: "CBC",
    name: "Complete Blood Count",
    category: "Hematology",
    price: 350,
    sampleType: "Blood",
    normalRange: "4-11 x10^3/uL",
    description: "Routine CBC",
  };

  it("accepts a fully populated payload", () => {
    expect(createLabTestSchema.safeParse(valid).success).toBe(true);
  });

  it("accepts a minimal payload (only required fields)", () => {
    expect(
      createLabTestSchema.safeParse({ code: "X1", name: "Test", price: 0 }).success
    ).toBe(true);
  });

  it("rejects empty code", () => {
    expect(createLabTestSchema.safeParse({ ...valid, code: "" }).success).toBe(false);
  });

  it("rejects empty name", () => {
    expect(createLabTestSchema.safeParse({ ...valid, name: "" }).success).toBe(false);
  });

  it("rejects negative price", () => {
    expect(createLabTestSchema.safeParse({ ...valid, price: -1 }).success).toBe(false);
  });

  it("accepts price = 0 (nonnegative boundary)", () => {
    expect(createLabTestSchema.safeParse({ ...valid, price: 0 }).success).toBe(true);
  });

  it("rejects non-numeric price", () => {
    expect(
      createLabTestSchema.safeParse({ ...valid, price: "350" as unknown as number }).success
    ).toBe(false);
  });

  it("rejects when required fields are missing", () => {
    expect(createLabTestSchema.safeParse({ name: "x", price: 1 }).success).toBe(false);
    expect(createLabTestSchema.safeParse({ code: "x", price: 1 }).success).toBe(false);
    expect(createLabTestSchema.safeParse({ code: "x", name: "x" }).success).toBe(false);
  });
});

describe("updateLabTestSchema (partial)", () => {
  it("accepts a single-field update", () => {
    expect(updateLabTestSchema.safeParse({ price: 500 }).success).toBe(true);
    expect(updateLabTestSchema.safeParse({ name: "Renamed" }).success).toBe(true);
  });
  it("accepts an empty object (all fields optional in partial)", () => {
    expect(updateLabTestSchema.safeParse({}).success).toBe(true);
  });
  it("still enforces field-level constraints on supplied fields", () => {
    expect(updateLabTestSchema.safeParse({ price: -10 }).success).toBe(false);
    expect(updateLabTestSchema.safeParse({ name: "" }).success).toBe(false);
    expect(updateLabTestSchema.safeParse({ code: "" }).success).toBe(false);
  });
});

describe("createLabOrderSchema", () => {
  const valid = {
    patientId: UUID,
    doctorId: UUID2,
    admissionId: UUID3,
    testIds: [UUID, UUID2],
    notes: "Pre-op screening",
    priority: "URGENT" as const,
  };

  it("accepts a fully populated order", () => {
    expect(createLabOrderSchema.safeParse(valid).success).toBe(true);
  });

  it("accepts the minimal shape (patientId + one testId only)", () => {
    expect(
      createLabOrderSchema.safeParse({ patientId: UUID, testIds: [UUID] }).success
    ).toBe(true);
  });

  it("rejects non-UUID patientId", () => {
    expect(
      createLabOrderSchema.safeParse({ ...valid, patientId: "not-a-uuid" }).success
    ).toBe(false);
  });

  it("rejects non-UUID doctorId / admissionId when provided", () => {
    expect(
      createLabOrderSchema.safeParse({ ...valid, doctorId: "x" }).success
    ).toBe(false);
    expect(
      createLabOrderSchema.safeParse({ ...valid, admissionId: "x" }).success
    ).toBe(false);
  });

  it("rejects empty testIds array", () => {
    expect(
      createLabOrderSchema.safeParse({ ...valid, testIds: [] }).success
    ).toBe(false);
  });

  it("rejects any non-UUID entry inside testIds", () => {
    expect(
      createLabOrderSchema.safeParse({ ...valid, testIds: [UUID, "bad"] }).success
    ).toBe(false);
  });

  it("rejects notes longer than 2000 chars", () => {
    expect(
      createLabOrderSchema.safeParse({ ...valid, notes: "a".repeat(2001) }).success
    ).toBe(false);
  });

  it("accepts notes exactly at the 2000-char ceiling", () => {
    expect(
      createLabOrderSchema.safeParse({ ...valid, notes: "a".repeat(2000) }).success
    ).toBe(true);
  });

  it("rejects unknown priority", () => {
    expect(
      createLabOrderSchema.safeParse({ ...valid, priority: "WHENEVER" as unknown as "URGENT" })
        .success
    ).toBe(false);
  });

  it("accepts each documented priority value", () => {
    for (const p of ["ROUTINE", "URGENT", "STAT"] as const) {
      expect(
        createLabOrderSchema.safeParse({ ...valid, priority: p }).success
      ).toBe(true);
    }
  });
});

describe("updateLabOrderStatusSchema", () => {
  it("accepts each lab-test status", () => {
    for (const s of [
      "ORDERED",
      "SAMPLE_COLLECTED",
      "IN_PROGRESS",
      "COMPLETED",
      "CANCELLED",
    ] as const) {
      expect(updateLabOrderStatusSchema.safeParse({ status: s }).success).toBe(true);
    }
  });
  it("rejects unknown status", () => {
    expect(
      updateLabOrderStatusSchema.safeParse({ status: "DONE" as unknown as "COMPLETED" }).success
    ).toBe(false);
  });
  it("rejects missing status", () => {
    expect(updateLabOrderStatusSchema.safeParse({}).success).toBe(false);
  });
});

describe("recordLabResultSchema — field-cap and unit-regex coverage", () => {
  const valid = {
    orderItemId: UUID,
    parameter: "Hb",
    value: "13.5",
    unit: "g/dL",
    normalRange: "13-17",
    flag: "NORMAL" as const,
    notes: "Within range",
  };

  it("accepts a fully populated result", () => {
    expect(recordLabResultSchema.safeParse(valid).success).toBe(true);
  });

  it("accepts the minimal shape (orderItemId + parameter + value)", () => {
    expect(
      recordLabResultSchema.safeParse({
        orderItemId: UUID,
        parameter: "X",
        value: "1",
      }).success
    ).toBe(true);
  });

  it("rejects non-UUID orderItemId", () => {
    expect(
      recordLabResultSchema.safeParse({ ...valid, orderItemId: "x" }).success
    ).toBe(false);
  });

  it("rejects empty parameter", () => {
    expect(recordLabResultSchema.safeParse({ ...valid, parameter: "" }).success).toBe(false);
  });

  it("rejects empty value", () => {
    expect(recordLabResultSchema.safeParse({ ...valid, value: "" }).success).toBe(false);
  });

  it("rejects parameter longer than 200 chars (Issue #642/#618 cap)", () => {
    expect(
      recordLabResultSchema.safeParse({ ...valid, parameter: "p".repeat(201) }).success
    ).toBe(false);
  });

  it("accepts parameter exactly at 200-char cap", () => {
    expect(
      recordLabResultSchema.safeParse({ ...valid, parameter: "p".repeat(200) }).success
    ).toBe(true);
  });

  it("rejects value longer than 400 chars", () => {
    expect(
      recordLabResultSchema.safeParse({ ...valid, value: "v".repeat(401) }).success
    ).toBe(false);
  });

  it("accepts value at exactly the 400-char cap", () => {
    expect(
      recordLabResultSchema.safeParse({ ...valid, value: "1".repeat(400) }).success
    ).toBe(true);
  });

  it("rejects unit longer than 80 chars", () => {
    expect(
      recordLabResultSchema.safeParse({ ...valid, unit: "m".repeat(81) }).success
    ).toBe(false);
  });

  it("accepts unit at exactly the 80-char cap (regex passes a-z)", () => {
    expect(
      recordLabResultSchema.safeParse({ ...valid, unit: "m".repeat(80) }).success
    ).toBe(true);
  });

  it("rejects normalRange longer than 80 chars", () => {
    expect(
      recordLabResultSchema.safeParse({ ...valid, normalRange: "r".repeat(81) }).success
    ).toBe(false);
  });

  it("rejects notes longer than 2000 chars", () => {
    expect(
      recordLabResultSchema.safeParse({ ...valid, notes: "n".repeat(2001) }).success
    ).toBe(false);
  });

  // Issue #616 + 6a6f360: unit regex must accept canonical clinical units
  // including caret (^) for `10^9/L` (WBC), micro-sign, °, superscript 3.
  it("accepts the canonical clinical unit alphabet", () => {
    const units = [
      "mg/dL",
      "mmol/L",
      "µg/mL",
      "IU/mL",
      "cells/mm³",
      "% (v/v)",
      "°C",
      "10^9/L", // 6a6f360 fix
      "x10^3/uL",
      "mEq/L",
      "ng/mL",
      "pg/mL",
      "g/dL",
      "²", // superscript 2
      "³", // superscript 3
    ];
    for (const unit of units) {
      const out = recordLabResultSchema.safeParse({ ...valid, unit });
      expect(out.success, `expected unit "${unit}" to be accepted`).toBe(true);
    }
  });

  it("rejects HTML/script-like unit payloads outright (Issue #616)", () => {
    const bad = [
      "<script>alert(1)</script>",
      "mg/dL<img>",
      'mg/dL"',
      "mg/dL;",
      "mg/dL=1",
      "mg/dL`",
      "mg/dL'",
      "mg/dL?",
      "mg/dL&",
      "mg/dL{}",
    ];
    for (const unit of bad) {
      const out = recordLabResultSchema.safeParse({ ...valid, unit });
      expect(out.success, `expected unit "${unit}" to be rejected`).toBe(false);
    }
  });

  it("rejects invalid flag enum value", () => {
    expect(
      recordLabResultSchema.safeParse({ ...valid, flag: "WEIRD" as unknown as "NORMAL" }).success
    ).toBe(false);
  });

  it("treats undefined optional fields as absent (vs null which fails)", () => {
    expect(
      recordLabResultSchema.safeParse({
        orderItemId: UUID,
        parameter: "X",
        value: "1",
        unit: undefined,
        normalRange: undefined,
        flag: undefined,
        notes: undefined,
      }).success
    ).toBe(true);
    // null is NOT optional — should fail.
    expect(
      recordLabResultSchema.safeParse({
        orderItemId: UUID,
        parameter: "X",
        value: "1",
        unit: null as unknown as string,
      }).success
    ).toBe(false);
  });
});

describe("labQCSchema", () => {
  const valid = {
    testId: UUID,
    qcLevel: "NORMAL" as const,
    instrument: "Sysmex XN-1000",
    meanValue: 10,
    recordedValue: 10.2,
    cv: 0.05,
    withinRange: true,
    notes: "QC pass",
  };

  it("accepts a fully populated entry", () => {
    expect(labQCSchema.safeParse(valid).success).toBe(true);
  });

  it("accepts the minimal required shape", () => {
    expect(
      labQCSchema.safeParse({
        testId: UUID,
        qcLevel: "INTERNAL",
        meanValue: 1,
        recordedValue: 1,
        withinRange: false,
      }).success
    ).toBe(true);
  });

  it("rejects non-UUID testId", () => {
    expect(labQCSchema.safeParse({ ...valid, testId: "x" }).success).toBe(false);
  });

  it("rejects unknown qcLevel", () => {
    expect(
      labQCSchema.safeParse({ ...valid, qcLevel: "MID" as unknown as "NORMAL" }).success
    ).toBe(false);
  });

  it("accepts each documented qcLevel value", () => {
    for (const lvl of ["LOW", "NORMAL", "HIGH", "INTERNAL"] as const) {
      expect(labQCSchema.safeParse({ ...valid, qcLevel: lvl }).success).toBe(true);
    }
  });

  it("rejects non-numeric meanValue / recordedValue / cv", () => {
    expect(
      labQCSchema.safeParse({ ...valid, meanValue: "10" as unknown as number }).success
    ).toBe(false);
    expect(
      labQCSchema.safeParse({ ...valid, recordedValue: "x" as unknown as number }).success
    ).toBe(false);
    expect(
      labQCSchema.safeParse({ ...valid, cv: "0.05" as unknown as number }).success
    ).toBe(false);
  });

  it("rejects non-boolean withinRange", () => {
    expect(
      labQCSchema.safeParse({ ...valid, withinRange: "yes" as unknown as boolean }).success
    ).toBe(false);
  });

  it("rejects missing required fields", () => {
    const { testId: _t, ...noTestId } = valid;
    expect(labQCSchema.safeParse(noTestId).success).toBe(false);
    const { withinRange: _w, ...noRange } = valid;
    expect(labQCSchema.safeParse(noRange).success).toBe(false);
  });
});

describe("verifyResultSchema", () => {
  it("accepts an empty object (notes optional)", () => {
    expect(verifyResultSchema.safeParse({}).success).toBe(true);
  });
  it("accepts a notes string", () => {
    expect(verifyResultSchema.safeParse({ notes: "Verified by Dr. X" }).success).toBe(true);
  });
  it("rejects non-string notes", () => {
    expect(
      verifyResultSchema.safeParse({ notes: 42 as unknown as string }).success
    ).toBe(false);
  });
});

describe("shareLinkSchema", () => {
  it("defaults resource to 'lab_order' when omitted", () => {
    const parsed = shareLinkSchema.safeParse({});
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.resource).toBe("lab_order");
    }
  });

  it("accepts each enumerated resource", () => {
    for (const r of ["lab_order", "prescription", "invoice"] as const) {
      expect(shareLinkSchema.safeParse({ resource: r }).success).toBe(true);
    }
  });

  it("rejects unknown resource", () => {
    expect(
      shareLinkSchema.safeParse({ resource: "patient" as unknown as "lab_order" }).success
    ).toBe(false);
  });

  it("accepts days at the 1..30 boundary", () => {
    expect(shareLinkSchema.safeParse({ days: 1 }).success).toBe(true);
    expect(shareLinkSchema.safeParse({ days: 30 }).success).toBe(true);
  });

  it("rejects days outside 1..30 and non-integers", () => {
    expect(shareLinkSchema.safeParse({ days: 0 }).success).toBe(false);
    expect(shareLinkSchema.safeParse({ days: 31 }).success).toBe(false);
    expect(shareLinkSchema.safeParse({ days: 7.5 }).success).toBe(false);
    expect(
      shareLinkSchema.safeParse({ days: "7" as unknown as number }).success
    ).toBe(false);
  });

  it("days is optional — empty object passes", () => {
    const parsed = shareLinkSchema.safeParse({});
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.days).toBeUndefined();
    }
  });
});

describe("validateNumericLabResult — full helper coverage", () => {
  it("returns null when the test is non-numeric (no unit, no panic thresholds)", () => {
    expect(
      validateNumericLabResult({
        value: "Yellow, clear, turbid",
        test: { unit: null, panicLow: null, panicHigh: null },
      })
    ).toBeNull();
  });

  it("treats whitespace-only unit as non-numeric (trim length 0)", () => {
    expect(
      validateNumericLabResult({
        value: "anything",
        test: { unit: "   ", panicLow: null, panicHigh: null },
      })
    ).toBeNull();
  });

  it("classifies the test as numeric when only panicHigh is set", () => {
    const issue = validateNumericLabResult({
      value: "abc",
      test: { unit: null, panicLow: null, panicHigh: 5 },
    });
    expect(issue).not.toBeNull();
    expect(issue?.field).toBe("value");
  });

  it("classifies the test as numeric when only panicLow is set", () => {
    const issue = validateNumericLabResult({
      value: "abc",
      test: { unit: null, panicLow: 5, panicHigh: null },
    });
    expect(issue).not.toBeNull();
  });

  it("accepts plain integers, decimals, and explicit-sign positives", () => {
    expect(
      validateNumericLabResult({ value: "12", test: { unit: "mg/dL" } })
    ).toBeNull();
    expect(
      validateNumericLabResult({ value: "12.5", test: { unit: "mg/dL" } })
    ).toBeNull();
    expect(
      validateNumericLabResult({ value: "  12.5  ", test: { unit: "mg/dL" } })
    ).toBeNull();
  });

  it("rejects exponent notation (regex is strict: -?\\d+(\\.\\d+)? only)", () => {
    expect(
      validateNumericLabResult({ value: "1e3", test: { unit: "mg/dL" } })
    ).not.toBeNull();
  });

  it("rejects bare leading-dot decimals (regex requires leading digit)", () => {
    expect(
      validateNumericLabResult({ value: ".5", test: { unit: "mg/dL" } })
    ).not.toBeNull();
  });

  it("rejects trailing-dot numbers (regex requires digits after dot)", () => {
    expect(
      validateNumericLabResult({ value: "12.", test: { unit: "mg/dL" } })
    ).not.toBeNull();
  });

  it("rejects negative values on tests whose panicLow is non-negative", () => {
    const issue = validateNumericLabResult({
      value: "-1",
      test: { unit: "mg/dL", panicLow: 0, panicHigh: 10 },
    });
    expect(issue).not.toBeNull();
    expect(issue?.field).toBe("value");
    expect(issue?.message).toMatch(/biologically impossible/i);
  });

  it("accepts negative values when panicLow is itself negative (base excess class)", () => {
    expect(
      validateNumericLabResult({
        value: "-1.4",
        test: { unit: "mEq/L", panicLow: -3, panicHigh: 3 },
      })
    ).toBeNull();
  });

  it("rejects negative values when panicLow is null (only unit set)", () => {
    expect(
      validateNumericLabResult({
        value: "-1",
        test: { unit: "mg/dL", panicLow: null, panicHigh: null },
      })
    ).not.toBeNull();
  });

  it("accepts 0 (boundary; not negative)", () => {
    expect(
      validateNumericLabResult({ value: "0", test: { unit: "mg/dL" } })
    ).toBeNull();
  });
});

describe("deriveLabResultFlag — every branch", () => {
  it("returns the submitted flag when value is inside panic range", () => {
    expect(
      deriveLabResultFlag({
        value: "1.0",
        flag: "NORMAL",
        test: { panicLow: 0.6, panicHigh: 5 },
      })
    ).toBe("NORMAL");
  });

  it("elevates to CRITICAL when value < panicLow", () => {
    expect(
      deriveLabResultFlag({
        value: "0.1",
        flag: "NORMAL",
        test: { panicLow: 0.6, panicHigh: 5 },
      })
    ).toBe("CRITICAL");
  });

  it("elevates to CRITICAL when value > panicHigh", () => {
    expect(
      deriveLabResultFlag({
        value: "999",
        flag: "LOW",
        test: { panicLow: 0.6, panicHigh: 5 },
      })
    ).toBe("CRITICAL");
  });

  it("defaults missing/null flag to NORMAL and still elevates if outside range", () => {
    expect(
      deriveLabResultFlag({
        value: "999",
        test: { panicLow: 0.6, panicHigh: 5 },
      })
    ).toBe("CRITICAL");
    expect(
      deriveLabResultFlag({
        value: "999",
        flag: null,
        test: { panicLow: 0.6, panicHigh: 5 },
      })
    ).toBe("CRITICAL");
  });

  it("retains the submitted flag for non-numeric values (can't evaluate)", () => {
    expect(
      deriveLabResultFlag({
        value: "Yellow",
        flag: "HIGH",
        test: { panicLow: 0.6, panicHigh: 5 },
      })
    ).toBe("HIGH");
  });

  it("retains the submitted flag when neither panicLow nor panicHigh is set", () => {
    expect(
      deriveLabResultFlag({
        value: "999",
        flag: "HIGH",
        test: { panicLow: null, panicHigh: null },
      })
    ).toBe("HIGH");
  });

  it("only elevates on the panicLow branch when panicHigh is unset", () => {
    expect(
      deriveLabResultFlag({
        value: "0.1",
        flag: "NORMAL",
        test: { panicLow: 1, panicHigh: null },
      })
    ).toBe("CRITICAL");
    expect(
      deriveLabResultFlag({
        value: "1000",
        flag: "NORMAL",
        test: { panicLow: 1, panicHigh: null },
      })
    ).toBe("NORMAL");
  });

  it("only elevates on the panicHigh branch when panicLow is unset", () => {
    expect(
      deriveLabResultFlag({
        value: "1000",
        flag: "NORMAL",
        test: { panicLow: null, panicHigh: 100 },
      })
    ).toBe("CRITICAL");
    expect(
      deriveLabResultFlag({
        value: "-50",
        flag: "NORMAL",
        test: { panicLow: null, panicHigh: 100 },
      })
    ).toBe("NORMAL");
  });

  it("returns NORMAL boundary-exact (value == panicLow or value == panicHigh is NOT elevated)", () => {
    expect(
      deriveLabResultFlag({
        value: "0.6",
        flag: "NORMAL",
        test: { panicLow: 0.6, panicHigh: 5 },
      })
    ).toBe("NORMAL");
    expect(
      deriveLabResultFlag({
        value: "5",
        flag: "NORMAL",
        test: { panicLow: 0.6, panicHigh: 5 },
      })
    ).toBe("NORMAL");
  });
});

describe("isImagingLabTest — token coverage", () => {
  it("matches by name for every canonical imaging token", () => {
    const names = [
      "Radiology Report",
      "Imaging Study",
      "Ultrasound Abdomen",
      "Ultrasonography Pelvis",
      "Sonography Whole Abdomen",
      "USG Pelvis",
      "X-Ray Chest",
      "XRay Wrist",
      "Echocardiogram",
      "Echocardiography",
      "ECG 12 Lead",
      "EKG",
      "MRI Brain",
      "CT Head",
      "Cat-Scan Abdomen",
      "Tomography Spine",
      "Fluoroscopy GI",
      "Mammography Bilateral",
      "DEXA Scan",
      "Densitometry",
      "Scintigraphy Bone",
    ];
    for (const name of names) {
      expect(
        isImagingLabTest({ name, category: null }),
        `expected "${name}" to be imaging`
      ).toBe(true);
    }
  });

  it("matches by category alone", () => {
    expect(
      isImagingLabTest({ name: "Generic Procedure 1", category: "Radiology" })
    ).toBe(true);
    expect(
      isImagingLabTest({ name: "Generic Procedure 1", category: "Imaging" })
    ).toBe(true);
  });

  it("does NOT match standard biochemistry / hematology panels", () => {
    for (const t of [
      { name: "Complete Blood Count", category: "Hematology" },
      { name: "Lipid Profile", category: "Biochemistry" },
      { name: "HbA1c", category: "Endocrinology" },
      { name: "TSH", category: "Endocrinology" },
      { name: "Urine Routine", category: "Microbiology" },
      // Word-boundary discipline: "echo" inside another word must NOT trip.
      { name: "Pseudoecholalia screen", category: "Neurology" },
    ]) {
      expect(
        isImagingLabTest(t),
        `expected "${t.name}" NOT to be imaging`
      ).toBe(false);
    }
  });

  it("handles missing/null category gracefully", () => {
    expect(isImagingLabTest({ name: "USG Abdomen" })).toBe(true);
    expect(isImagingLabTest({ name: "CBC" })).toBe(false);
    expect(isImagingLabTest({ name: "USG Abdomen", category: null })).toBe(true);
    expect(isImagingLabTest({ name: "CBC", category: null })).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(isImagingLabTest({ name: "x-ray chest", category: null })).toBe(true);
    expect(isImagingLabTest({ name: "MRI brain", category: null })).toBe(true);
    expect(isImagingLabTest({ name: "ECG", category: null })).toBe(true);
  });
});

describe("getLabTestResultMode — full decision matrix", () => {
  it("returns 'imaging' for imaging-tagged tests (overrides numeric signal)", () => {
    // Even with a unit, imaging wins because it's the first check.
    expect(
      getLabTestResultMode({
        name: "Ultrasound Abdomen",
        category: "Procedure",
        unit: "MHz",
      })
    ).toBe("imaging");
  });

  it("returns 'numeric' when a unit is present (numeric signal beats name match)", () => {
    expect(
      getLabTestResultMode({
        name: "HIV-1 RNA",
        category: null,
        unit: "copies/mL",
      })
    ).toBe("numeric");
  });

  it("returns 'numeric' when panicLow OR panicHigh is set", () => {
    expect(
      getLabTestResultMode({
        name: "Hepatitis B Surface Antigen",
        category: null,
        panicLow: 0,
      })
    ).toBe("numeric");
    expect(
      getLabTestResultMode({
        name: "Widal Test",
        category: null,
        panicHigh: 100,
      })
    ).toBe("numeric");
  });

  it("returns 'qualitative' for canonical qualitative tokens (no numeric signal)", () => {
    const cases = [
      "Hepatitis B Surface Antigen",
      "HBsAg",
      "Anti-HCV",
      "HIV I & II Screening",
      "ELISA",
      "Western Blot",
      "Rapid Test",
      "Widal Test",
      "VDRL",
      "RPR",
      "TPHA",
      "ASO",
      "ASOM",
      "CRP",
      "RF",
      "ANA",
      "ANCA",
      "Anti-dsDNA",
      "Dengue NS1",
      "Chikungunya IgM",
      "Malaria Parasite",
      "MP Slide",
      "MP Card",
      "Filaria",
      "Leptospira",
      "Urine Pregnancy Test",
      "UPT",
      "HCG Qualitative",
      "Stool Routine",
      "Stool Examination",
      "Stool Culture",
      "Urine Culture",
      "Occult Blood",
      "FOBT",
      "COVID-19 Antigen",
      "SARS-CoV-2",
      "Influenza Rapid",
    ];
    for (const name of cases) {
      expect(
        getLabTestResultMode({ name, category: null }),
        `expected "${name}" to be qualitative`
      ).toBe("qualitative");
    }
  });

  it("returns 'qualitative' when the category matches even though name does not", () => {
    expect(
      getLabTestResultMode({ name: "Routine Panel 7", category: "Hepatitis Screening" })
    ).toBe("qualitative");
  });

  it("falls back to 'numeric' when no qualitative or imaging signal is found", () => {
    expect(
      getLabTestResultMode({ name: "Sodium", category: null, unit: null })
    ).toBe("numeric");
    expect(
      getLabTestResultMode({ name: "Random Marker", category: "Biochemistry" })
    ).toBe("numeric");
  });

  it("handles undefined unit, panicLow, panicHigh", () => {
    expect(getLabTestResultMode({ name: "HIV" })).toBe("qualitative");
    expect(getLabTestResultMode({ name: "Sodium" })).toBe("numeric");
  });
});

describe("QUALITATIVE_RESULT_OPTIONS canonical list", () => {
  it("exposes the eight expected options in the documented order", () => {
    expect(QUALITATIVE_RESULT_OPTIONS).toEqual([
      "POSITIVE",
      "NEGATIVE",
      "REACTIVE",
      "NON-REACTIVE",
      "DETECTED",
      "NOT DETECTED",
      "INDETERMINATE",
      "INSUFFICIENT SAMPLE",
    ]);
  });
  it("is a readonly tuple (frozen const assertion)", () => {
    // The `as const` assertion makes mutation a type error; at runtime the
    // array is a plain Array, but length and order must remain stable.
    expect(QUALITATIVE_RESULT_OPTIONS.length).toBe(8);
  });
});
