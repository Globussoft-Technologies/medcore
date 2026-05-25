// Coverage tests for ancillary-enhancements validation schemas.
// What: exhaustive happy / invalid / edge cases for every exported Zod schema
//   in packages/shared/src/validation/ancillary-enhancements.ts — lab
//   (referenceRange, sampleReject, batchResult), pharmacy (batchRecall,
//   stockAdjustment), medicine (pediatricDoseCalc, contraindicationCheck),
//   blood bank (bloodScreening, temperatureLog, crossMatchRecord), ambulance
//   (fuelLog with the gap #10 future-date refinement, equipmentCheck, tripBill),
//   and asset (assetTransfer, assetDisposal, calibrationSchedule).
// Which modules: imports only schemas from ../ancillary-enhancements.
// Why: file shipped with 0% colocated coverage despite 15 exported schemas
//   spanning 5 ancillary subsystems. Particularly important to lock in:
//   (a) the gap #10 fuelLog.filledAt future-date refine with the 1-minute
//   skew tolerance, (b) signed-quantity acceptance on stockAdjustment (the
//   "negative for removal" semantic that distinguishes ops corrections from
//   restock), (c) tripBill's `.default(0)` on both fare components,
//   (d) the `screeningResult` reuse across 5 fields in bloodScreeningSchema
//   so any future enum drift fails loudly.
import { describe, it, expect } from "vitest";
import {
  labReferenceRangeSchema,
  sampleRejectSchema,
  batchResultSchema,
  batchRecallSchema,
  stockAdjustmentSchema,
  pediatricDoseCalcSchema,
  contraindicationCheckSchema,
  bloodScreeningSchema,
  temperatureLogSchema,
  crossMatchRecordSchema,
  fuelLogSchema,
  equipmentCheckSchema,
  tripBillSchema,
  assetTransferSchema,
  assetDisposalSchema,
  calibrationScheduleSchema,
} from "../ancillary-enhancements";

const UUID = "550e8400-e29b-41d4-a716-446655441111";
const UUID_2 = "550e8400-e29b-41d4-a716-446655442222";
const UUID_3 = "550e8400-e29b-41d4-a716-446655443333";

// ───────────────────────────────────────────────────────
// LAB
// ───────────────────────────────────────────────────────

describe("labReferenceRangeSchema", () => {
  it("accepts a minimal range (only testId)", () => {
    expect(labReferenceRangeSchema.safeParse({ testId: UUID }).success).toBe(true);
  });
  it("accepts a fully-populated range", () => {
    expect(
      labReferenceRangeSchema.safeParse({
        testId: UUID,
        parameter: "Hemoglobin",
        gender: "MALE",
        ageMin: 18,
        ageMax: 65,
        low: 13.5,
        high: 17.5,
        unit: "g/dL",
        notes: "Adult male reference",
      }).success
    ).toBe(true);
  });
  it("accepts FEMALE gender", () => {
    expect(
      labReferenceRangeSchema.safeParse({ testId: UUID, gender: "FEMALE" }).success
    ).toBe(true);
  });
  it("rejects unknown gender", () => {
    expect(
      labReferenceRangeSchema.safeParse({ testId: UUID, gender: "OTHER" as any }).success
    ).toBe(false);
  });
  it("rejects non-uuid testId", () => {
    expect(labReferenceRangeSchema.safeParse({ testId: "abc" }).success).toBe(false);
  });
  it("rejects missing testId", () => {
    expect(labReferenceRangeSchema.safeParse({}).success).toBe(false);
  });
  it("rejects non-integer ageMin", () => {
    expect(
      labReferenceRangeSchema.safeParse({ testId: UUID, ageMin: 18.5 }).success
    ).toBe(false);
  });
  it("rejects negative ageMin", () => {
    expect(
      labReferenceRangeSchema.safeParse({ testId: UUID, ageMin: -1 }).success
    ).toBe(false);
  });
  it("accepts ageMin=0 (nonnegative boundary)", () => {
    expect(
      labReferenceRangeSchema.safeParse({ testId: UUID, ageMin: 0 }).success
    ).toBe(true);
  });
  it("rejects negative ageMax", () => {
    expect(
      labReferenceRangeSchema.safeParse({ testId: UUID, ageMax: -1 }).success
    ).toBe(false);
  });
  it("accepts negative low/high (lab values can be negative, e.g. base excess)", () => {
    expect(
      labReferenceRangeSchema.safeParse({ testId: UUID, low: -3, high: 3 }).success
    ).toBe(true);
  });
});

describe("sampleRejectSchema", () => {
  const reasons = [
    "INSUFFICIENT_SAMPLE",
    "HEMOLYZED",
    "CLOTTED",
    "LIPEMIC",
    "WRONG_LABEL",
    "WRONG_CONTAINER",
    "CONTAMINATED",
    "OTHER",
  ] as const;
  it("accepts every canonical rejection reason", () => {
    for (const r of reasons) {
      expect(sampleRejectSchema.safeParse({ reason: r }).success).toBe(true);
    }
  });
  it("accepts reason with notes", () => {
    expect(
      sampleRejectSchema.safeParse({ reason: "HEMOLYZED", notes: "Visible at receipt" }).success
    ).toBe(true);
  });
  it("rejects unknown reason", () => {
    expect(
      sampleRejectSchema.safeParse({ reason: "SPILLED" as any }).success
    ).toBe(false);
  });
  it("rejects missing reason", () => {
    expect(sampleRejectSchema.safeParse({}).success).toBe(false);
  });
});

describe("batchResultSchema", () => {
  const validItem = {
    orderItemId: UUID_2,
    parameter: "Hemoglobin",
    value: "14.2",
  };
  const valid = { orderId: UUID, results: [validItem] };

  it("accepts a single-result batch", () => {
    expect(batchResultSchema.safeParse(valid).success).toBe(true);
  });
  it("accepts a multi-result batch with all optional fields", () => {
    expect(
      batchResultSchema.safeParse({
        orderId: UUID,
        results: [
          {
            ...validItem,
            unit: "g/dL",
            normalRange: "13.5-17.5",
            flag: "NORMAL",
            notes: "OK",
          },
          {
            orderItemId: UUID_3,
            parameter: "WBC",
            value: "12000",
            unit: "/uL",
            flag: "HIGH",
          },
        ],
      }).success
    ).toBe(true);
  });
  it("accepts every result flag enum value", () => {
    for (const flag of ["NORMAL", "LOW", "HIGH", "CRITICAL"] as const) {
      expect(
        batchResultSchema.safeParse({
          orderId: UUID,
          results: [{ ...validItem, flag }],
        }).success
      ).toBe(true);
    }
  });
  it("rejects unknown flag", () => {
    expect(
      batchResultSchema.safeParse({
        orderId: UUID,
        results: [{ ...validItem, flag: "BORDERLINE" as any }],
      }).success
    ).toBe(false);
  });
  it("rejects non-uuid orderId", () => {
    expect(
      batchResultSchema.safeParse({ ...valid, orderId: "abc" }).success
    ).toBe(false);
  });
  it("rejects non-uuid orderItemId", () => {
    expect(
      batchResultSchema.safeParse({
        orderId: UUID,
        results: [{ ...validItem, orderItemId: "abc" }],
      }).success
    ).toBe(false);
  });
  it("rejects empty results array (min 1)", () => {
    expect(batchResultSchema.safeParse({ orderId: UUID, results: [] }).success).toBe(false);
  });
  it("rejects empty parameter (min 1)", () => {
    expect(
      batchResultSchema.safeParse({
        orderId: UUID,
        results: [{ ...validItem, parameter: "" }],
      }).success
    ).toBe(false);
  });
  it("rejects empty value (min 1)", () => {
    expect(
      batchResultSchema.safeParse({
        orderId: UUID,
        results: [{ ...validItem, value: "" }],
      }).success
    ).toBe(false);
  });
  it("rejects missing results key", () => {
    expect(batchResultSchema.safeParse({ orderId: UUID }).success).toBe(false);
  });
});

// ───────────────────────────────────────────────────────
// PHARMACY
// ───────────────────────────────────────────────────────

describe("batchRecallSchema", () => {
  it("accepts a non-empty reason", () => {
    expect(batchRecallSchema.safeParse({ reason: "FDA Class II recall" }).success).toBe(true);
  });
  it("rejects empty reason (min 1)", () => {
    expect(batchRecallSchema.safeParse({ reason: "" }).success).toBe(false);
  });
  it("rejects missing reason", () => {
    expect(batchRecallSchema.safeParse({}).success).toBe(false);
  });
  it("rejects non-string reason", () => {
    expect(batchRecallSchema.safeParse({ reason: 123 as any }).success).toBe(false);
  });
});

describe("stockAdjustmentSchema", () => {
  const valid = {
    inventoryItemId: UUID,
    quantity: -5,
    reasonCode: "DAMAGE" as const,
  };
  const reasonCodes = [
    "DAMAGE",
    "EXPIRY",
    "LOSS",
    "COUNT_CORRECTION",
    "THEFT",
    "TRANSFER_OUT",
    "TRANSFER_IN",
  ] as const;

  it("accepts a signed-negative quantity (removal semantic)", () => {
    expect(stockAdjustmentSchema.safeParse(valid).success).toBe(true);
  });
  it("accepts a signed-positive quantity (addition / restock)", () => {
    expect(
      stockAdjustmentSchema.safeParse({ ...valid, quantity: 10, reasonCode: "TRANSFER_IN" })
        .success
    ).toBe(true);
  });
  it("accepts quantity=0 (audit zero-out)", () => {
    expect(stockAdjustmentSchema.safeParse({ ...valid, quantity: 0 }).success).toBe(true);
  });
  it("accepts every canonical reason code", () => {
    for (const reasonCode of reasonCodes) {
      expect(
        stockAdjustmentSchema.safeParse({ ...valid, reasonCode }).success
      ).toBe(true);
    }
  });
  it("accepts a free-text reason on top of reasonCode", () => {
    expect(
      stockAdjustmentSchema.safeParse({ ...valid, reason: "Found at back of fridge" })
        .success
    ).toBe(true);
  });
  it("rejects non-integer quantity", () => {
    expect(
      stockAdjustmentSchema.safeParse({ ...valid, quantity: 1.5 }).success
    ).toBe(false);
  });
  it("rejects unknown reason code", () => {
    expect(
      stockAdjustmentSchema.safeParse({ ...valid, reasonCode: "SHRINKAGE" as any }).success
    ).toBe(false);
  });
  it("rejects non-uuid inventoryItemId", () => {
    expect(
      stockAdjustmentSchema.safeParse({ ...valid, inventoryItemId: "abc" }).success
    ).toBe(false);
  });
  it("rejects missing reasonCode", () => {
    const { reasonCode: _r, ...rest } = valid;
    expect(stockAdjustmentSchema.safeParse(rest).success).toBe(false);
  });
});

// ───────────────────────────────────────────────────────
// MEDICINE
// ───────────────────────────────────────────────────────

describe("pediatricDoseCalcSchema", () => {
  const valid = { medicineId: UUID, weightKg: 12.5 };

  it("accepts a minimal valid input", () => {
    expect(pediatricDoseCalcSchema.safeParse(valid).success).toBe(true);
  });
  it("accepts an optional frequencyPerDay", () => {
    expect(
      pediatricDoseCalcSchema.safeParse({ ...valid, frequencyPerDay: 3 }).success
    ).toBe(true);
  });
  it("rejects non-uuid medicineId", () => {
    expect(
      pediatricDoseCalcSchema.safeParse({ ...valid, medicineId: "abc" }).success
    ).toBe(false);
  });
  it("rejects weightKg=0 (positive constraint)", () => {
    expect(
      pediatricDoseCalcSchema.safeParse({ ...valid, weightKg: 0 }).success
    ).toBe(false);
  });
  it("rejects negative weightKg", () => {
    expect(
      pediatricDoseCalcSchema.safeParse({ ...valid, weightKg: -1 }).success
    ).toBe(false);
  });
  it("accepts fractional weightKg (premature neonate)", () => {
    expect(
      pediatricDoseCalcSchema.safeParse({ ...valid, weightKg: 0.85 }).success
    ).toBe(true);
  });
  it("rejects frequencyPerDay=0 (positive constraint)", () => {
    expect(
      pediatricDoseCalcSchema.safeParse({ ...valid, frequencyPerDay: 0 }).success
    ).toBe(false);
  });
  it("rejects non-integer frequencyPerDay", () => {
    expect(
      pediatricDoseCalcSchema.safeParse({ ...valid, frequencyPerDay: 2.5 }).success
    ).toBe(false);
  });
  it("rejects negative frequencyPerDay", () => {
    expect(
      pediatricDoseCalcSchema.safeParse({ ...valid, frequencyPerDay: -1 }).success
    ).toBe(false);
  });
});

describe("contraindicationCheckSchema", () => {
  it("accepts a single medicineId", () => {
    expect(
      contraindicationCheckSchema.safeParse({ medicineIds: [UUID] }).success
    ).toBe(true);
  });
  it("accepts multiple medicineIds + conditions + allergies", () => {
    expect(
      contraindicationCheckSchema.safeParse({
        medicineIds: [UUID, UUID_2, UUID_3],
        patientConditions: ["Pregnancy", "Renal failure"],
        patientAllergies: ["Penicillin", "Sulfa"],
      }).success
    ).toBe(true);
  });
  it("rejects empty medicineIds array (min 1)", () => {
    expect(
      contraindicationCheckSchema.safeParse({ medicineIds: [] }).success
    ).toBe(false);
  });
  it("rejects non-uuid in medicineIds", () => {
    expect(
      contraindicationCheckSchema.safeParse({ medicineIds: [UUID, "abc"] }).success
    ).toBe(false);
  });
  it("rejects missing medicineIds key", () => {
    expect(contraindicationCheckSchema.safeParse({}).success).toBe(false);
  });
  it("accepts empty patientConditions array", () => {
    expect(
      contraindicationCheckSchema.safeParse({
        medicineIds: [UUID],
        patientConditions: [],
      }).success
    ).toBe(true);
  });
});

// ───────────────────────────────────────────────────────
// BLOOD BANK
// ───────────────────────────────────────────────────────

describe("bloodScreeningSchema", () => {
  const valid = {
    donationId: UUID,
    hivResult: "NEGATIVE" as const,
    hcvResult: "NEGATIVE" as const,
    hbsAgResult: "NEGATIVE" as const,
    syphilisResult: "NEGATIVE" as const,
    malariaResult: "NEGATIVE" as const,
  };
  const screeningResults = ["NEGATIVE", "POSITIVE", "INDETERMINATE"] as const;

  it("accepts a minimal all-negative screening", () => {
    expect(bloodScreeningSchema.safeParse(valid).success).toBe(true);
  });
  it("accepts a fully-populated screening with optional fields", () => {
    expect(
      bloodScreeningSchema.safeParse({
        ...valid,
        bloodGrouping: "O+",
        method: "ELISA",
        notes: "Re-test in 7 days for indeterminate",
      }).success
    ).toBe(true);
  });
  it("accepts each screening result on hivResult", () => {
    for (const r of screeningResults) {
      expect(
        bloodScreeningSchema.safeParse({ ...valid, hivResult: r }).success
      ).toBe(true);
    }
  });
  it("rejects unknown result on hivResult", () => {
    expect(
      bloodScreeningSchema.safeParse({ ...valid, hivResult: "PENDING" as any }).success
    ).toBe(false);
  });
  it("rejects unknown result on hcvResult", () => {
    expect(
      bloodScreeningSchema.safeParse({ ...valid, hcvResult: "PENDING" as any }).success
    ).toBe(false);
  });
  it("rejects unknown result on hbsAgResult", () => {
    expect(
      bloodScreeningSchema.safeParse({ ...valid, hbsAgResult: "PENDING" as any }).success
    ).toBe(false);
  });
  it("rejects unknown result on syphilisResult", () => {
    expect(
      bloodScreeningSchema.safeParse({ ...valid, syphilisResult: "PENDING" as any }).success
    ).toBe(false);
  });
  it("rejects unknown result on malariaResult", () => {
    expect(
      bloodScreeningSchema.safeParse({ ...valid, malariaResult: "PENDING" as any }).success
    ).toBe(false);
  });
  it("rejects non-uuid donationId", () => {
    expect(
      bloodScreeningSchema.safeParse({ ...valid, donationId: "abc" }).success
    ).toBe(false);
  });
  it("rejects missing screening field (hcvResult)", () => {
    const { hcvResult: _h, ...rest } = valid;
    expect(bloodScreeningSchema.safeParse(rest).success).toBe(false);
  });
});

describe("temperatureLogSchema", () => {
  it("accepts a minimal log", () => {
    expect(
      temperatureLogSchema.safeParse({ location: "Fridge A", temperature: 4.2 }).success
    ).toBe(true);
  });
  it("accepts log with notes", () => {
    expect(
      temperatureLogSchema.safeParse({
        location: "Plasma freezer",
        temperature: -30,
        notes: "Daily check",
      }).success
    ).toBe(true);
  });
  it("accepts negative temperature (freezer scenarios)", () => {
    expect(
      temperatureLogSchema.safeParse({ location: "Freezer B", temperature: -80 }).success
    ).toBe(true);
  });
  it("accepts temperature=0 (ice slurry edge)", () => {
    expect(
      temperatureLogSchema.safeParse({ location: "Cooler", temperature: 0 }).success
    ).toBe(true);
  });
  it("rejects empty location (min 1)", () => {
    expect(
      temperatureLogSchema.safeParse({ location: "", temperature: 4 }).success
    ).toBe(false);
  });
  it("rejects missing temperature", () => {
    expect(temperatureLogSchema.safeParse({ location: "Fridge A" }).success).toBe(false);
  });
  it("rejects non-number temperature", () => {
    expect(
      temperatureLogSchema.safeParse({ location: "Fridge A", temperature: "4.2" as any })
        .success
    ).toBe(false);
  });
});

describe("crossMatchRecordSchema", () => {
  const valid = {
    requestId: UUID,
    unitId: UUID_2,
    compatible: true,
  };
  it("accepts a minimal compatible record", () => {
    expect(crossMatchRecordSchema.safeParse(valid).success).toBe(true);
  });
  it("accepts an incompatible record", () => {
    expect(
      crossMatchRecordSchema.safeParse({ ...valid, compatible: false }).success
    ).toBe(true);
  });
  it("accepts a fully-populated record", () => {
    expect(
      crossMatchRecordSchema.safeParse({
        ...valid,
        method: "Saline + AHG",
        notes: "Major crossmatch, room temperature",
      }).success
    ).toBe(true);
  });
  it("rejects non-uuid requestId", () => {
    expect(
      crossMatchRecordSchema.safeParse({ ...valid, requestId: "abc" }).success
    ).toBe(false);
  });
  it("rejects non-uuid unitId", () => {
    expect(
      crossMatchRecordSchema.safeParse({ ...valid, unitId: "abc" }).success
    ).toBe(false);
  });
  it("rejects missing compatible flag", () => {
    const { compatible: _c, ...rest } = valid;
    expect(crossMatchRecordSchema.safeParse(rest).success).toBe(false);
  });
  it("rejects non-boolean compatible", () => {
    expect(
      crossMatchRecordSchema.safeParse({ ...valid, compatible: "yes" as any }).success
    ).toBe(false);
  });
});

// ───────────────────────────────────────────────────────
// AMBULANCE — fuelLog gap #10 refinement focus
// ───────────────────────────────────────────────────────

describe("fuelLogSchema (gap #10 future-date refine)", () => {
  const valid = {
    ambulanceId: UUID,
    litres: 42.5,
    costTotal: 4500,
  };

  it("accepts a minimal log without filledAt (Prisma @default(now()) takes over)", () => {
    expect(fuelLogSchema.safeParse(valid).success).toBe(true);
  });
  it("accepts a fully-populated log", () => {
    expect(
      fuelLogSchema.safeParse({
        ...valid,
        odometerKm: 12345,
        stationName: "BPCL Outer Ring",
        notes: "Standard refuel",
        filledAt: "2026-05-20T14:30:00.000Z",
      }).success
    ).toBe(true);
  });
  it("accepts a backdated filledAt (retroactive logging — primary use case for gap #10)", () => {
    const yesterday = new Date(Date.now() - 86_400_000).toISOString();
    expect(
      fuelLogSchema.safeParse({ ...valid, filledAt: yesterday }).success
    ).toBe(true);
  });
  it("accepts filledAt within the 1-minute skew tolerance (now + 30s)", () => {
    const slightlyFuture = new Date(Date.now() + 30_000).toISOString();
    expect(
      fuelLogSchema.safeParse({ ...valid, filledAt: slightlyFuture }).success
    ).toBe(true);
  });
  it("rejects filledAt beyond the 1-minute skew tolerance (now + 5 min)", () => {
    const future = new Date(Date.now() + 5 * 60_000).toISOString();
    const r = fuelLogSchema.safeParse({ ...valid, filledAt: future });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(
        r.error.issues.some((i) => /filledAt cannot be in the future/.test(i.message))
      ).toBe(true);
    }
  });
  it("rejects far-future filledAt (typo defense)", () => {
    const farFuture = new Date(Date.now() + 365 * 86_400_000).toISOString();
    expect(
      fuelLogSchema.safeParse({ ...valid, filledAt: farFuture }).success
    ).toBe(false);
  });
  it("coerces a Date instance for filledAt", () => {
    expect(
      fuelLogSchema.safeParse({ ...valid, filledAt: new Date(Date.now() - 1000) }).success
    ).toBe(true);
  });
  it("rejects an unparseable filledAt string", () => {
    expect(
      fuelLogSchema.safeParse({ ...valid, filledAt: "not-a-date" }).success
    ).toBe(false);
  });
  it("rejects non-uuid ambulanceId", () => {
    expect(fuelLogSchema.safeParse({ ...valid, ambulanceId: "abc" }).success).toBe(false);
  });
  it("rejects litres=0 (positive constraint)", () => {
    expect(fuelLogSchema.safeParse({ ...valid, litres: 0 }).success).toBe(false);
  });
  it("rejects negative litres", () => {
    expect(fuelLogSchema.safeParse({ ...valid, litres: -1 }).success).toBe(false);
  });
  it("rejects negative costTotal", () => {
    expect(fuelLogSchema.safeParse({ ...valid, costTotal: -1 }).success).toBe(false);
  });
  it("accepts costTotal=0 (free/sponsored fill)", () => {
    expect(fuelLogSchema.safeParse({ ...valid, costTotal: 0 }).success).toBe(true);
  });
  it("rejects negative odometerKm", () => {
    expect(fuelLogSchema.safeParse({ ...valid, odometerKm: -1 }).success).toBe(false);
  });
  it("accepts odometerKm=0 (brand new ambulance)", () => {
    expect(fuelLogSchema.safeParse({ ...valid, odometerKm: 0 }).success).toBe(true);
  });
  it("rejects non-integer odometerKm", () => {
    expect(
      fuelLogSchema.safeParse({ ...valid, odometerKm: 12345.5 }).success
    ).toBe(false);
  });
});

describe("equipmentCheckSchema", () => {
  it("accepts equipmentChecked=true", () => {
    expect(equipmentCheckSchema.safeParse({ equipmentChecked: true }).success).toBe(true);
  });
  it("accepts equipmentChecked=false", () => {
    expect(equipmentCheckSchema.safeParse({ equipmentChecked: false }).success).toBe(true);
  });
  it("accepts equipmentChecked with notes", () => {
    expect(
      equipmentCheckSchema.safeParse({
        equipmentChecked: false,
        equipmentNotes: "AED battery low",
      }).success
    ).toBe(true);
  });
  it("rejects missing equipmentChecked", () => {
    expect(equipmentCheckSchema.safeParse({}).success).toBe(false);
  });
  it("rejects non-boolean equipmentChecked", () => {
    expect(
      equipmentCheckSchema.safeParse({ equipmentChecked: "yes" as any }).success
    ).toBe(false);
  });
});

describe("tripBillSchema", () => {
  it("accepts an empty body and applies defaults (0, 0)", () => {
    const r = tripBillSchema.safeParse({});
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.baseFare).toBe(0);
      expect(r.data.perKmRate).toBe(0);
    }
  });
  it("accepts an explicit baseFare", () => {
    const r = tripBillSchema.safeParse({ baseFare: 250 });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.baseFare).toBe(250);
      expect(r.data.perKmRate).toBe(0);
    }
  });
  it("accepts both fields", () => {
    expect(
      tripBillSchema.safeParse({ baseFare: 250, perKmRate: 15.5 }).success
    ).toBe(true);
  });
  it("rejects negative baseFare", () => {
    expect(tripBillSchema.safeParse({ baseFare: -1 }).success).toBe(false);
  });
  it("rejects negative perKmRate", () => {
    expect(tripBillSchema.safeParse({ perKmRate: -1 }).success).toBe(false);
  });
});

// ───────────────────────────────────────────────────────
// ASSET
// ───────────────────────────────────────────────────────

describe("assetTransferSchema", () => {
  it("accepts a minimal transfer (only toDepartment)", () => {
    expect(
      assetTransferSchema.safeParse({ toDepartment: "Radiology" }).success
    ).toBe(true);
  });
  it("accepts a fully-populated transfer", () => {
    expect(
      assetTransferSchema.safeParse({
        toDepartment: "Radiology",
        toLocation: "Room 204",
        reason: "Reassignment",
        notes: "Approved by HOD",
      }).success
    ).toBe(true);
  });
  it("rejects empty toDepartment (min 1)", () => {
    expect(assetTransferSchema.safeParse({ toDepartment: "" }).success).toBe(false);
  });
  it("rejects missing toDepartment", () => {
    expect(assetTransferSchema.safeParse({}).success).toBe(false);
  });
});

describe("assetDisposalSchema", () => {
  const methods = ["SOLD", "SCRAPPED", "DONATED", "LOST"] as const;

  it("accepts every canonical disposal method", () => {
    for (const method of methods) {
      expect(assetDisposalSchema.safeParse({ method }).success).toBe(true);
    }
  });
  it("accepts disposal with value + notes", () => {
    expect(
      assetDisposalSchema.safeParse({
        method: "SOLD",
        disposalValue: 12500,
        notes: "Sold via auction",
      }).success
    ).toBe(true);
  });
  it("accepts disposalValue=0 (nonnegative boundary)", () => {
    expect(
      assetDisposalSchema.safeParse({ method: "SCRAPPED", disposalValue: 0 }).success
    ).toBe(true);
  });
  it("rejects negative disposalValue", () => {
    expect(
      assetDisposalSchema.safeParse({ method: "SOLD", disposalValue: -1 }).success
    ).toBe(false);
  });
  it("rejects unknown method", () => {
    expect(
      assetDisposalSchema.safeParse({ method: "RECYCLED" as any }).success
    ).toBe(false);
  });
  it("rejects missing method", () => {
    expect(assetDisposalSchema.safeParse({}).success).toBe(false);
  });
});

describe("calibrationScheduleSchema", () => {
  it("accepts a minimal schedule (only interval)", () => {
    expect(
      calibrationScheduleSchema.safeParse({ calibrationInterval: 90 }).success
    ).toBe(true);
  });
  it("accepts a schedule with lastCalibrationAt", () => {
    expect(
      calibrationScheduleSchema.safeParse({
        calibrationInterval: 180,
        lastCalibrationAt: "2026-01-15",
      }).success
    ).toBe(true);
  });
  it("rejects calibrationInterval=0 (positive constraint)", () => {
    expect(
      calibrationScheduleSchema.safeParse({ calibrationInterval: 0 }).success
    ).toBe(false);
  });
  it("rejects negative calibrationInterval", () => {
    expect(
      calibrationScheduleSchema.safeParse({ calibrationInterval: -1 }).success
    ).toBe(false);
  });
  it("rejects non-integer calibrationInterval", () => {
    expect(
      calibrationScheduleSchema.safeParse({ calibrationInterval: 30.5 }).success
    ).toBe(false);
  });
  it("rejects missing calibrationInterval", () => {
    expect(calibrationScheduleSchema.safeParse({}).success).toBe(false);
  });
  it("rejects malformed lastCalibrationAt (not YYYY-MM-DD)", () => {
    expect(
      calibrationScheduleSchema.safeParse({
        calibrationInterval: 90,
        lastCalibrationAt: "15/01/2026",
      }).success
    ).toBe(false);
  });
  it("rejects lastCalibrationAt with single-digit month", () => {
    expect(
      calibrationScheduleSchema.safeParse({
        calibrationInterval: 90,
        lastCalibrationAt: "2026-1-15",
      }).success
    ).toBe(false);
  });
  it("rejects lastCalibrationAt with timestamp suffix", () => {
    expect(
      calibrationScheduleSchema.safeParse({
        calibrationInterval: 90,
        lastCalibrationAt: "2026-01-15T00:00:00Z",
      }).success
    ).toBe(false);
  });
});
