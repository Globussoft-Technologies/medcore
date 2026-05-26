// Comprehensive colocated coverage for the IPD validation surface.
//
// What: exhaustive happy + invalid cases for every exported schema, enum
// constant, and type in `./ipd.ts` — `createWardSchema`, `createBedSchema`,
// `updateBedStatusSchema`, `admitPatientSchema`, `dischargeSchema`,
// `intakeOutputSchema` (+ INTAKE_OUTPUT_VOLUME_MAX_ML boundary),
// `transferBedSchema`, `recordIpdVitalsSchema` (all vitals fields + the
// cross-field BP refine + the unit-aware temperature refine),
// `medicationOrderSchema`, `updateMedicationOrderSchema`,
// `administerMedicationSchema`, `nurseRoundSchema`, `IsolationTypeEnum`,
// `isolationStatusSchema`, `BelongingItemSchema`, `belongingsSchema`,
// `updateBelongingsSchema`, `checkoutBelongingsSchema`, and the
// `ADMISSION_TYPES`/`CONDITION_AT_DISCHARGE`/`INTAKE_OUTPUT_TYPES` tuples.
//
// Why: ipd.ts had no colocated *.test.ts file. The pre-existing
// __tests__/ipd-and-lab.test.ts covers a subset of the schemas (ward, bed,
// admit, discharge, vitals, intake-output, medication-order, administer)
// but skips updateBedStatusSchema, transferBedSchema,
// updateMedicationOrderSchema, nurseRoundSchema, the isolation schemas,
// and the belongings schemas entirely. This file is the colocated surface
// companion that closes the gap surfaced by the test-writing cron and
// drives every refine/boundary branch in the IPD validation module.

import { describe, it, expect } from "vitest";
import {
  createWardSchema,
  createBedSchema,
  updateBedStatusSchema,
  ADMISSION_TYPES,
  CONDITION_AT_DISCHARGE,
  INTAKE_OUTPUT_TYPES,
  admitPatientSchema,
  dischargeSchema,
  INTAKE_OUTPUT_VOLUME_MAX_ML,
  intakeOutputSchema,
  transferBedSchema,
  recordIpdVitalsSchema,
  medicationOrderSchema,
  updateMedicationOrderSchema,
  administerMedicationSchema,
  nurseRoundSchema,
  IsolationTypeEnum,
  isolationStatusSchema,
  BelongingItemSchema,
  belongingsSchema,
  updateBelongingsSchema,
  checkoutBelongingsSchema,
} from "./ipd";

const UUID = "550e8400-e29b-41d4-a716-446655441111";
const UUID2 = "550e8400-e29b-41d4-a716-446655442222";

describe("createWardSchema accepts/rejects ward shape", () => {
  it("accepts a fully populated ward", () => {
    expect(
      createWardSchema.safeParse({
        name: "Ward A",
        type: "GENERAL",
        floor: "1st",
        description: "General medicine ward",
      }).success,
    ).toBe(true);
  });

  it("accepts each documented ward type", () => {
    for (const type of [
      "GENERAL",
      "PRIVATE",
      "SEMI_PRIVATE",
      "ICU",
      "NICU",
      "HDU",
      "EMERGENCY",
      "MATERNITY",
    ] as const) {
      expect(createWardSchema.safeParse({ name: "W", type }).success).toBe(true);
    }
  });

  it("accepts the minimal shape (name + type only)", () => {
    expect(
      createWardSchema.safeParse({ name: "Ward A", type: "ICU" }).success,
    ).toBe(true);
  });

  it("rejects empty name", () => {
    expect(
      createWardSchema.safeParse({ name: "", type: "GENERAL" }).success,
    ).toBe(false);
  });

  it("rejects unknown ward type", () => {
    expect(
      createWardSchema.safeParse({ name: "W", type: "BASEMENT" as unknown as "ICU" })
        .success,
    ).toBe(false);
  });

  it("rejects missing required fields", () => {
    expect(createWardSchema.safeParse({ name: "W" }).success).toBe(false);
    expect(createWardSchema.safeParse({ type: "ICU" }).success).toBe(false);
    expect(createWardSchema.safeParse({}).success).toBe(false);
  });
});

describe("createBedSchema accepts/rejects bed shape", () => {
  it("accepts a fully populated bed", () => {
    expect(
      createBedSchema.safeParse({
        wardId: UUID,
        bedNumber: "B-101",
        dailyRate: 500,
      }).success,
    ).toBe(true);
  });

  it("defaults dailyRate to 0 when omitted", () => {
    const parsed = createBedSchema.safeParse({ wardId: UUID, bedNumber: "B-1" });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.dailyRate).toBe(0);
    }
  });

  it("rejects non-UUID wardId", () => {
    expect(
      createBedSchema.safeParse({ wardId: "not-uuid", bedNumber: "B-1" }).success,
    ).toBe(false);
  });

  it("rejects empty bedNumber", () => {
    expect(
      createBedSchema.safeParse({ wardId: UUID, bedNumber: "" }).success,
    ).toBe(false);
  });

  it("rejects negative dailyRate (nonnegative boundary)", () => {
    expect(
      createBedSchema.safeParse({ wardId: UUID, bedNumber: "B-1", dailyRate: -1 })
        .success,
    ).toBe(false);
  });

  it("accepts dailyRate = 0 (boundary)", () => {
    expect(
      createBedSchema.safeParse({ wardId: UUID, bedNumber: "B-1", dailyRate: 0 })
        .success,
    ).toBe(true);
  });
});

describe("updateBedStatusSchema accepts/rejects bed status updates", () => {
  it("accepts each documented status", () => {
    for (const status of [
      "AVAILABLE",
      "OCCUPIED",
      "CLEANING",
      "MAINTENANCE",
      "RESERVED",
    ] as const) {
      expect(updateBedStatusSchema.safeParse({ status }).success).toBe(true);
    }
  });

  it("accepts status + optional notes", () => {
    expect(
      updateBedStatusSchema.safeParse({ status: "CLEANING", notes: "Deep clean" })
        .success,
    ).toBe(true);
  });

  it("rejects unknown status", () => {
    expect(
      updateBedStatusSchema.safeParse({ status: "DIRTY" as unknown as "CLEANING" })
        .success,
    ).toBe(false);
  });

  it("rejects missing status", () => {
    expect(updateBedStatusSchema.safeParse({}).success).toBe(false);
  });
});

describe("ADMISSION_TYPES / CONDITION_AT_DISCHARGE / INTAKE_OUTPUT_TYPES tuples", () => {
  it("ADMISSION_TYPES exposes the documented values in order", () => {
    expect(ADMISSION_TYPES).toEqual([
      "ELECTIVE",
      "EMERGENCY",
      "TRANSFER",
      "MATERNITY",
      "DAY_CARE",
    ]);
  });

  it("CONDITION_AT_DISCHARGE exposes the documented values in order", () => {
    expect(CONDITION_AT_DISCHARGE).toEqual([
      "STABLE",
      "IMPROVED",
      "CRITICAL",
      "UNCHANGED",
      "DECEASED",
    ]);
  });

  it("INTAKE_OUTPUT_TYPES exposes the documented values in order", () => {
    expect(INTAKE_OUTPUT_TYPES).toEqual([
      "INTAKE_ORAL",
      "INTAKE_IV",
      "INTAKE_NG",
      "OUTPUT_URINE",
      "OUTPUT_STOOL",
      "OUTPUT_VOMIT",
      "OUTPUT_DRAIN",
      "OUTPUT_OTHER",
    ]);
  });
});

describe("admitPatientSchema accepts/rejects admission shape", () => {
  const valid = {
    patientId: UUID,
    doctorId: UUID2,
    bedId: UUID,
    reason: "Pneumonia",
    diagnosis: "Community-acquired pneumonia",
    admissionType: "EMERGENCY" as const,
    referredByDoctor: "Dr. Sharma",
  };

  it("accepts a fully populated admission", () => {
    expect(admitPatientSchema.safeParse(valid).success).toBe(true);
  });

  it("accepts the minimal shape (no diagnosis, no admissionType)", () => {
    expect(
      admitPatientSchema.safeParse({
        patientId: UUID,
        doctorId: UUID,
        bedId: UUID,
        reason: "Observation",
      }).success,
    ).toBe(true);
  });

  it("accepts each documented admissionType", () => {
    for (const t of ADMISSION_TYPES) {
      expect(
        admitPatientSchema.safeParse({ ...valid, admissionType: t }).success,
      ).toBe(true);
    }
  });

  it("rejects unknown admissionType", () => {
    expect(
      admitPatientSchema.safeParse({
        ...valid,
        admissionType: "WALK_IN" as unknown as "ELECTIVE",
      }).success,
    ).toBe(false);
  });

  it("rejects non-UUID patientId / doctorId / bedId", () => {
    expect(
      admitPatientSchema.safeParse({ ...valid, patientId: "x" }).success,
    ).toBe(false);
    expect(
      admitPatientSchema.safeParse({ ...valid, doctorId: "x" }).success,
    ).toBe(false);
    expect(
      admitPatientSchema.safeParse({ ...valid, bedId: "x" }).success,
    ).toBe(false);
  });

  it("rejects empty reason", () => {
    expect(admitPatientSchema.safeParse({ ...valid, reason: "" }).success).toBe(
      false,
    );
  });
});

describe("dischargeSchema accepts/rejects discharge shape", () => {
  it("accepts a fully populated discharge", () => {
    expect(
      dischargeSchema.safeParse({
        dischargeSummary: "Patient stable, discharged",
        dischargeNotes: "F/U in 1 week",
        finalDiagnosis: "Pneumonia, resolved",
        treatmentGiven: "IV Ceftriaxone x5d",
        conditionAtDischarge: "IMPROVED",
        dischargeMedications: "Tab Amoxicillin TDS x5d",
        followUpInstructions: "OPD review",
        forceDischarge: false,
      }).success,
    ).toBe(true);
  });

  it("accepts the minimal shape (summary only)", () => {
    expect(
      dischargeSchema.safeParse({ dischargeSummary: "Discharged" }).success,
    ).toBe(true);
  });

  it("accepts each documented conditionAtDischarge", () => {
    for (const c of CONDITION_AT_DISCHARGE) {
      expect(
        dischargeSchema.safeParse({
          dischargeSummary: "x",
          conditionAtDischarge: c,
        }).success,
      ).toBe(true);
    }
  });

  it("rejects empty dischargeSummary", () => {
    expect(dischargeSchema.safeParse({ dischargeSummary: "" }).success).toBe(false);
  });

  it("rejects missing dischargeSummary", () => {
    expect(dischargeSchema.safeParse({}).success).toBe(false);
  });

  it("rejects unknown conditionAtDischarge", () => {
    expect(
      dischargeSchema.safeParse({
        dischargeSummary: "x",
        conditionAtDischarge: "WORSE" as unknown as "CRITICAL",
      }).success,
    ).toBe(false);
  });

  it("rejects non-boolean forceDischarge", () => {
    expect(
      dischargeSchema.safeParse({
        dischargeSummary: "x",
        forceDischarge: "true" as unknown as boolean,
      }).success,
    ).toBe(false);
  });
});

describe("intakeOutputSchema — Issue #433 volume bounds", () => {
  const baseValid = {
    admissionId: UUID,
    type: "INTAKE_ORAL" as const,
    amountMl: 250,
  };

  it("exposes INTAKE_OUTPUT_VOLUME_MAX_ML = 10000", () => {
    expect(INTAKE_OUTPUT_VOLUME_MAX_ML).toBe(10_000);
  });

  it("accepts a valid in-range entry", () => {
    expect(intakeOutputSchema.safeParse(baseValid).success).toBe(true);
  });

  it("accepts each documented intake/output type", () => {
    for (const t of INTAKE_OUTPUT_TYPES) {
      expect(
        intakeOutputSchema.safeParse({ ...baseValid, type: t }).success,
      ).toBe(true);
    }
  });

  it("rejects unknown type", () => {
    expect(
      intakeOutputSchema.safeParse({
        ...baseValid,
        type: "INTAKE_RECTAL" as unknown as "INTAKE_ORAL",
      }).success,
    ).toBe(false);
  });

  it("rejects non-UUID admissionId", () => {
    expect(
      intakeOutputSchema.safeParse({ ...baseValid, admissionId: "x" }).success,
    ).toBe(false);
  });

  it("accepts amountMl at the 0 lower boundary (nonnegative)", () => {
    expect(intakeOutputSchema.safeParse({ ...baseValid, amountMl: 0 }).success).toBe(
      true,
    );
  });

  it("rejects negative amountMl (Issue #433)", () => {
    expect(
      intakeOutputSchema.safeParse({ ...baseValid, amountMl: -1 }).success,
    ).toBe(false);
    expect(
      intakeOutputSchema.safeParse({ ...baseValid, amountMl: -500 }).success,
    ).toBe(false);
  });

  it("accepts amountMl at the 10000 upper boundary", () => {
    expect(
      intakeOutputSchema.safeParse({ ...baseValid, amountMl: 10_000 }).success,
    ).toBe(true);
  });

  it("rejects amountMl above the 10000 cap (Issue #433)", () => {
    expect(
      intakeOutputSchema.safeParse({ ...baseValid, amountMl: 10_001 }).success,
    ).toBe(false);
    expect(
      intakeOutputSchema.safeParse({ ...baseValid, amountMl: 99_999 }).success,
    ).toBe(false);
  });

  it("rejects non-integer (fractional) amountMl", () => {
    expect(
      intakeOutputSchema.safeParse({ ...baseValid, amountMl: 250.5 }).success,
    ).toBe(false);
  });

  it("accepts optional description and notes", () => {
    expect(
      intakeOutputSchema.safeParse({
        ...baseValid,
        description: "Sippy cup",
        notes: "Tolerated well",
      }).success,
    ).toBe(true);
  });
});

describe("transferBedSchema accepts/rejects transfer shape", () => {
  it("accepts a valid transfer", () => {
    expect(
      transferBedSchema.safeParse({ newBedId: UUID, reason: "Stepdown from ICU" })
        .success,
    ).toBe(true);
  });

  it("accepts the minimal shape (newBedId only)", () => {
    expect(transferBedSchema.safeParse({ newBedId: UUID }).success).toBe(true);
  });

  it("rejects non-UUID newBedId", () => {
    expect(transferBedSchema.safeParse({ newBedId: "x" }).success).toBe(false);
  });

  it("rejects missing newBedId", () => {
    expect(transferBedSchema.safeParse({}).success).toBe(false);
  });
});

describe("recordIpdVitalsSchema — boundaries per vital field", () => {
  const base = { admissionId: UUID };

  it("accepts an empty vitals entry (only admissionId)", () => {
    expect(recordIpdVitalsSchema.safeParse(base).success).toBe(true);
  });

  it("rejects non-UUID admissionId", () => {
    expect(
      recordIpdVitalsSchema.safeParse({ admissionId: "x", pulseRate: 70 }).success,
    ).toBe(false);
  });

  it("systolic accepts 60 and 260 boundaries; rejects 59 and 261", () => {
    expect(
      recordIpdVitalsSchema.safeParse({ ...base, bloodPressureSystolic: 60 }).success,
    ).toBe(true);
    expect(
      recordIpdVitalsSchema.safeParse({ ...base, bloodPressureSystolic: 260 })
        .success,
    ).toBe(true);
    expect(
      recordIpdVitalsSchema.safeParse({ ...base, bloodPressureSystolic: 59 }).success,
    ).toBe(false);
    expect(
      recordIpdVitalsSchema.safeParse({ ...base, bloodPressureSystolic: 261 })
        .success,
    ).toBe(false);
  });

  it("diastolic accepts 30 and 180 boundaries; rejects 29 and 181", () => {
    // Pair with a high systolic so the cross-field refine doesn't reject.
    expect(
      recordIpdVitalsSchema.safeParse({
        ...base,
        bloodPressureSystolic: 200,
        bloodPressureDiastolic: 30,
      }).success,
    ).toBe(true);
    expect(
      recordIpdVitalsSchema.safeParse({
        ...base,
        bloodPressureSystolic: 200,
        bloodPressureDiastolic: 180,
      }).success,
    ).toBe(true);
    expect(
      recordIpdVitalsSchema.safeParse({ ...base, bloodPressureDiastolic: 29 }).success,
    ).toBe(false);
    expect(
      recordIpdVitalsSchema.safeParse({ ...base, bloodPressureDiastolic: 181 })
        .success,
    ).toBe(false);
  });

  it("pulseRate accepts 30 and 220 boundaries; rejects 29 and 221", () => {
    expect(recordIpdVitalsSchema.safeParse({ ...base, pulseRate: 30 }).success).toBe(
      true,
    );
    expect(recordIpdVitalsSchema.safeParse({ ...base, pulseRate: 220 }).success).toBe(
      true,
    );
    expect(recordIpdVitalsSchema.safeParse({ ...base, pulseRate: 29 }).success).toBe(
      false,
    );
    expect(recordIpdVitalsSchema.safeParse({ ...base, pulseRate: 221 }).success).toBe(
      false,
    );
  });

  it("respiratoryRate accepts 5 and 80 boundaries; rejects 4 and 81", () => {
    expect(
      recordIpdVitalsSchema.safeParse({ ...base, respiratoryRate: 5 }).success,
    ).toBe(true);
    expect(
      recordIpdVitalsSchema.safeParse({ ...base, respiratoryRate: 80 }).success,
    ).toBe(true);
    expect(
      recordIpdVitalsSchema.safeParse({ ...base, respiratoryRate: 4 }).success,
    ).toBe(false);
    expect(
      recordIpdVitalsSchema.safeParse({ ...base, respiratoryRate: 81 }).success,
    ).toBe(false);
  });

  it("spO2 accepts 50 and 100 boundaries; rejects 49 and 101", () => {
    expect(recordIpdVitalsSchema.safeParse({ ...base, spO2: 50 }).success).toBe(true);
    expect(recordIpdVitalsSchema.safeParse({ ...base, spO2: 100 }).success).toBe(
      true,
    );
    expect(recordIpdVitalsSchema.safeParse({ ...base, spO2: 49 }).success).toBe(
      false,
    );
    expect(recordIpdVitalsSchema.safeParse({ ...base, spO2: 101 }).success).toBe(
      false,
    );
  });

  it("painScore accepts 0 and 10 boundaries; rejects -1 and 11", () => {
    expect(recordIpdVitalsSchema.safeParse({ ...base, painScore: 0 }).success).toBe(
      true,
    );
    expect(recordIpdVitalsSchema.safeParse({ ...base, painScore: 10 }).success).toBe(
      true,
    );
    expect(recordIpdVitalsSchema.safeParse({ ...base, painScore: -1 }).success).toBe(
      false,
    );
    expect(recordIpdVitalsSchema.safeParse({ ...base, painScore: 11 }).success).toBe(
      false,
    );
  });

  it("bloodSugar accepts 20 and 900 boundaries; rejects 19 and 901", () => {
    expect(recordIpdVitalsSchema.safeParse({ ...base, bloodSugar: 20 }).success).toBe(
      true,
    );
    expect(recordIpdVitalsSchema.safeParse({ ...base, bloodSugar: 900 }).success).toBe(
      true,
    );
    expect(recordIpdVitalsSchema.safeParse({ ...base, bloodSugar: 19 }).success).toBe(
      false,
    );
    expect(recordIpdVitalsSchema.safeParse({ ...base, bloodSugar: 901 }).success).toBe(
      false,
    );
  });

  it("rejects non-integer values on integer-typed fields", () => {
    expect(
      recordIpdVitalsSchema.safeParse({ ...base, pulseRate: 70.5 }).success,
    ).toBe(false);
    expect(
      recordIpdVitalsSchema.safeParse({ ...base, spO2: 97.4 }).success,
    ).toBe(false);
  });

  it("accepts optional notes", () => {
    expect(
      recordIpdVitalsSchema.safeParse({ ...base, notes: "Patient calm" }).success,
    ).toBe(true);
  });

  // ─── Temperature unit-aware refine ───────────────────────────────────
  describe("temperature superRefine", () => {
    it("defaults to °C when temperatureUnit omitted and rejects out-of-range C", () => {
      expect(
        recordIpdVitalsSchema.safeParse({ ...base, temperature: 50 }).success,
      ).toBe(false); // 50 > 43 °C max
    });

    it("accepts 37 °C (in-range default-unit happy path)", () => {
      expect(
        recordIpdVitalsSchema.safeParse({ ...base, temperature: 37 }).success,
      ).toBe(true);
    });

    it("accepts 32 and 43 °C boundaries", () => {
      expect(
        recordIpdVitalsSchema.safeParse({
          ...base,
          temperature: 32,
          temperatureUnit: "C",
        }).success,
      ).toBe(true);
      expect(
        recordIpdVitalsSchema.safeParse({
          ...base,
          temperature: 43,
          temperatureUnit: "C",
        }).success,
      ).toBe(true);
    });

    it("rejects 31.9 and 43.1 °C (just outside boundary)", () => {
      expect(
        recordIpdVitalsSchema.safeParse({
          ...base,
          temperature: 31.9,
          temperatureUnit: "C",
        }).success,
      ).toBe(false);
      expect(
        recordIpdVitalsSchema.safeParse({
          ...base,
          temperature: 43.1,
          temperatureUnit: "C",
        }).success,
      ).toBe(false);
    });

    it("accepts 90 and 110 °F boundaries; rejects 89.9 and 110.1", () => {
      expect(
        recordIpdVitalsSchema.safeParse({
          ...base,
          temperature: 90,
          temperatureUnit: "F",
        }).success,
      ).toBe(true);
      expect(
        recordIpdVitalsSchema.safeParse({
          ...base,
          temperature: 110,
          temperatureUnit: "F",
        }).success,
      ).toBe(true);
      expect(
        recordIpdVitalsSchema.safeParse({
          ...base,
          temperature: 89.9,
          temperatureUnit: "F",
        }).success,
      ).toBe(false);
      expect(
        recordIpdVitalsSchema.safeParse({
          ...base,
          temperature: 110.1,
          temperatureUnit: "F",
        }).success,
      ).toBe(false);
    });

    it("Issue #200: 98.6 °C is rejected, 98.6 °F is accepted", () => {
      expect(
        recordIpdVitalsSchema.safeParse({
          ...base,
          temperature: 98.6,
          temperatureUnit: "C",
        }).success,
      ).toBe(false);
      expect(
        recordIpdVitalsSchema.safeParse({
          ...base,
          temperature: 98.6,
          temperatureUnit: "F",
        }).success,
      ).toBe(true);
    });

    it("rejects unknown temperatureUnit", () => {
      expect(
        recordIpdVitalsSchema.safeParse({
          ...base,
          temperature: 37,
          temperatureUnit: "K" as unknown as "C",
        }).success,
      ).toBe(false);
    });

    it("skips the temperature refine when temperature is undefined", () => {
      // No temperature means the superRefine branch is a no-op; the parse
      // should succeed even with a unit that would otherwise be irrelevant.
      expect(
        recordIpdVitalsSchema.safeParse({
          ...base,
          temperatureUnit: "F",
        }).success,
      ).toBe(true);
    });
  });

  // ─── Cross-field BP refine (Issue #544) ──────────────────────────────
  describe("BP cross-field refine (#544)", () => {
    it("rejects diastolic > systolic (120/130)", () => {
      const result = recordIpdVitalsSchema.safeParse({
        ...base,
        bloodPressureSystolic: 120,
        bloodPressureDiastolic: 130,
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(
          result.error.issues.some(
            (i) =>
              i.path.includes("bloodPressureDiastolic") &&
              /less than systolic/i.test(i.message),
          ),
        ).toBe(true);
      }
    });

    it("rejects diastolic == systolic (110/110)", () => {
      expect(
        recordIpdVitalsSchema.safeParse({
          ...base,
          bloodPressureSystolic: 110,
          bloodPressureDiastolic: 110,
        }).success,
      ).toBe(false);
    });

    it("accepts diastolic < systolic (120/80)", () => {
      expect(
        recordIpdVitalsSchema.safeParse({
          ...base,
          bloodPressureSystolic: 120,
          bloodPressureDiastolic: 80,
        }).success,
      ).toBe(true);
    });

    it("skips refine when only one of the two BP fields is supplied", () => {
      expect(
        recordIpdVitalsSchema.safeParse({ ...base, bloodPressureSystolic: 120 })
          .success,
      ).toBe(true);
      expect(
        recordIpdVitalsSchema.safeParse({ ...base, bloodPressureDiastolic: 80 })
          .success,
      ).toBe(true);
    });
  });
});

describe("medicationOrderSchema accepts/rejects order shape", () => {
  const valid = {
    admissionId: UUID,
    medicineName: "Paracetamol",
    dosage: "500mg",
    frequency: "TDS",
    route: "Oral",
  };

  it("accepts a fully populated order (with medicineId)", () => {
    expect(
      medicationOrderSchema.safeParse({
        ...valid,
        medicineId: UUID2,
        startDate: "2026-05-01",
        endDate: "2026-05-08",
        instructions: "After meals",
      }).success,
    ).toBe(true);
  });

  it("accepts the minimal shape (with medicineName, no medicineId)", () => {
    expect(medicationOrderSchema.safeParse(valid).success).toBe(true);
  });

  it("rejects non-UUID admissionId", () => {
    expect(
      medicationOrderSchema.safeParse({ ...valid, admissionId: "x" }).success,
    ).toBe(false);
  });

  it("rejects non-UUID medicineId when supplied", () => {
    expect(
      medicationOrderSchema.safeParse({ ...valid, medicineId: "x" }).success,
    ).toBe(false);
  });

  it("rejects empty dosage / frequency / route", () => {
    expect(
      medicationOrderSchema.safeParse({ ...valid, dosage: "" }).success,
    ).toBe(false);
    expect(
      medicationOrderSchema.safeParse({ ...valid, frequency: "" }).success,
    ).toBe(false);
    expect(
      medicationOrderSchema.safeParse({ ...valid, route: "" }).success,
    ).toBe(false);
  });

  it("rejects empty medicineName when supplied (min(1) on optional field)", () => {
    expect(
      medicationOrderSchema.safeParse({ ...valid, medicineName: "" }).success,
    ).toBe(false);
  });

  it("rejects missing required dosage/frequency/route", () => {
    const { dosage: _d, ...noDosage } = valid;
    expect(medicationOrderSchema.safeParse(noDosage).success).toBe(false);
  });
});

describe("updateMedicationOrderSchema accepts/rejects partial updates", () => {
  it("accepts an empty object (all fields optional)", () => {
    expect(updateMedicationOrderSchema.safeParse({}).success).toBe(true);
  });

  it("accepts a single-field update", () => {
    expect(
      updateMedicationOrderSchema.safeParse({ isActive: false }).success,
    ).toBe(true);
    expect(
      updateMedicationOrderSchema.safeParse({ instructions: "After food" }).success,
    ).toBe(true);
    expect(
      updateMedicationOrderSchema.safeParse({ endDate: "2026-05-30" }).success,
    ).toBe(true);
  });

  it("rejects non-boolean isActive", () => {
    expect(
      updateMedicationOrderSchema.safeParse({
        isActive: "false" as unknown as boolean,
      }).success,
    ).toBe(false);
  });
});

describe("administerMedicationSchema accepts/rejects administration status", () => {
  it("accepts each documented status", () => {
    for (const status of ["ADMINISTERED", "MISSED", "REFUSED", "HELD"] as const) {
      expect(administerMedicationSchema.safeParse({ status }).success).toBe(true);
    }
  });

  it("accepts status + optional notes", () => {
    expect(
      administerMedicationSchema.safeParse({
        status: "REFUSED",
        notes: "Patient declined",
      }).success,
    ).toBe(true);
  });

  it("rejects unknown status", () => {
    expect(
      administerMedicationSchema.safeParse({
        status: "FORGOT" as unknown as "MISSED",
      }).success,
    ).toBe(false);
  });

  it("rejects missing status", () => {
    expect(administerMedicationSchema.safeParse({}).success).toBe(false);
  });
});

describe("nurseRoundSchema accepts/rejects nurse round shape", () => {
  it("accepts a valid nurse round", () => {
    expect(
      nurseRoundSchema.safeParse({ admissionId: UUID, notes: "Patient comfortable" })
        .success,
    ).toBe(true);
  });

  it("rejects non-UUID admissionId", () => {
    expect(
      nurseRoundSchema.safeParse({ admissionId: "x", notes: "n" }).success,
    ).toBe(false);
  });

  it("rejects empty notes", () => {
    expect(
      nurseRoundSchema.safeParse({ admissionId: UUID, notes: "" }).success,
    ).toBe(false);
  });

  it("rejects missing required fields", () => {
    expect(nurseRoundSchema.safeParse({ admissionId: UUID }).success).toBe(false);
    expect(nurseRoundSchema.safeParse({ notes: "x" }).success).toBe(false);
  });
});

describe("IsolationTypeEnum accepts each documented isolation type", () => {
  it("accepts all five enum values", () => {
    for (const t of [
      "STANDARD",
      "CONTACT",
      "DROPLET",
      "AIRBORNE",
      "REVERSE_ISOLATION",
    ] as const) {
      expect(IsolationTypeEnum.safeParse(t).success).toBe(true);
    }
  });

  it("rejects unknown isolation type", () => {
    expect(
      IsolationTypeEnum.safeParse("QUARANTINE" as unknown as "STANDARD").success,
    ).toBe(false);
  });
});

describe("isolationStatusSchema accepts/rejects isolation shape", () => {
  it("accepts an empty object (all fields optional)", () => {
    expect(isolationStatusSchema.safeParse({}).success).toBe(true);
  });

  it("accepts a fully populated entry", () => {
    expect(
      isolationStatusSchema.safeParse({
        isolationType: "AIRBORNE",
        isolationReason: "Suspected TB",
        isolationStartDate: "2026-05-01",
        isolationEndDate: "2026-05-08",
        clear: false,
      }).success,
    ).toBe(true);
  });

  it("accepts null isolationType (nullable)", () => {
    expect(isolationStatusSchema.safeParse({ isolationType: null }).success).toBe(
      true,
    );
  });

  it("accepts a clear-only payload", () => {
    expect(isolationStatusSchema.safeParse({ clear: true }).success).toBe(true);
  });

  it("rejects invalid isolationType", () => {
    expect(
      isolationStatusSchema.safeParse({
        isolationType: "QUARANTINE" as unknown as "CONTACT",
      }).success,
    ).toBe(false);
  });

  it("rejects non-boolean clear", () => {
    expect(
      isolationStatusSchema.safeParse({ clear: "yes" as unknown as boolean }).success,
    ).toBe(false);
  });
});

describe("BelongingItemSchema accepts/rejects item shape", () => {
  it("accepts a fully populated item", () => {
    expect(
      BelongingItemSchema.safeParse({
        name: "Wallet",
        description: "Brown leather",
        value: 500,
        checkedIn: true,
        checkedInAt: "2026-05-01T10:00:00Z",
        checkedOutAt: "2026-05-08T15:30:00Z",
      }).success,
    ).toBe(true);
  });

  it("accepts the minimal shape (name only) and defaults checkedIn=true", () => {
    const parsed = BelongingItemSchema.safeParse({ name: "Phone" });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.checkedIn).toBe(true);
    }
  });

  it("rejects empty name", () => {
    expect(BelongingItemSchema.safeParse({ name: "" }).success).toBe(false);
  });

  it("rejects negative value (nonnegative refine)", () => {
    expect(
      BelongingItemSchema.safeParse({ name: "Watch", value: -1 }).success,
    ).toBe(false);
  });

  it("accepts value = 0 boundary", () => {
    expect(
      BelongingItemSchema.safeParse({ name: "Comb", value: 0 }).success,
    ).toBe(true);
  });

  it("rejects non-boolean checkedIn", () => {
    expect(
      BelongingItemSchema.safeParse({
        name: "Ring",
        checkedIn: "yes" as unknown as boolean,
      }).success,
    ).toBe(false);
  });
});

describe("belongingsSchema accepts/rejects belongings container", () => {
  it("accepts the empty default (items defaults to [])", () => {
    const parsed = belongingsSchema.safeParse({});
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.items).toEqual([]);
    }
  });

  it("accepts items + notes", () => {
    expect(
      belongingsSchema.safeParse({
        items: [{ name: "Phone" }, { name: "Wallet", value: 500 }],
        notes: "Sealed in locker B-3",
      }).success,
    ).toBe(true);
  });

  it("rejects an invalid item inside items array", () => {
    expect(
      belongingsSchema.safeParse({ items: [{ name: "" }] }).success,
    ).toBe(false);
  });

  it("rejects items not an array", () => {
    expect(
      belongingsSchema.safeParse({
        items: "not-array" as unknown as Array<{ name: string }>,
      }).success,
    ).toBe(false);
  });
});

describe("updateBelongingsSchema (partial of belongingsSchema)", () => {
  it("accepts an empty object", () => {
    expect(updateBelongingsSchema.safeParse({}).success).toBe(true);
  });

  it("accepts a notes-only update", () => {
    expect(updateBelongingsSchema.safeParse({ notes: "Updated" }).success).toBe(
      true,
    );
  });

  it("accepts an items-only update", () => {
    expect(
      updateBelongingsSchema.safeParse({ items: [{ name: "Glasses" }] }).success,
    ).toBe(true);
  });

  it("still enforces field-level constraints on supplied items", () => {
    expect(
      updateBelongingsSchema.safeParse({ items: [{ name: "" }] }).success,
    ).toBe(false);
  });
});

describe("checkoutBelongingsSchema accepts/rejects checkout shape", () => {
  it("accepts an empty object (items + notes optional)", () => {
    expect(checkoutBelongingsSchema.safeParse({}).success).toBe(true);
  });

  it("accepts items + notes", () => {
    expect(
      checkoutBelongingsSchema.safeParse({
        items: [{ name: "Phone", checkedIn: false }],
        notes: "Handed back to patient",
      }).success,
    ).toBe(true);
  });

  it("rejects an invalid item inside the optional items array", () => {
    expect(
      checkoutBelongingsSchema.safeParse({ items: [{ name: "" }] }).success,
    ).toBe(false);
  });
});
