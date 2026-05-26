// Coverage tests for packages/shared/src/validation/phase4-specialty.ts.
// Exercises every exported Zod schema (ANC, ultrasound, growth, partograph,
// ACOG risk, postnatal, milestone, feeding) for happy paths, per-field
// rejections, and the boundary/refinement branches that distinguish them
// (LMP-not-in-future, empty-visit superRefine, WHO weight/height envelopes).
import { describe, it, expect } from "vitest";
import {
  ANC_VISIT_TYPES,
  DELIVERY_TYPES,
  MILESTONE_DOMAINS,
  FEED_TYPES,
  createAncCaseSchema,
  updateAncCaseSchema,
  createAncVisitSchema,
  deliveryOutcomeSchema,
  ultrasoundRecordSchema,
  createGrowthRecordSchema,
  updateGrowthRecordSchema,
  partographObservationSchema,
  startPartographSchema,
  addPartographObservationSchema,
  endPartographSchema,
  acogRiskScoreSchema,
  postnatalVisitSchema,
  milestoneRecordSchema,
  feedingLogSchema,
} from "../phase4-specialty";

const UUID = "550e8400-e29b-41d4-a716-446655442222";
const UUID2 = "550e8400-e29b-41d4-a716-446655443333";

// ─── Enum exports ──────────────────────────────────────

describe("phase4-specialty enum exports", () => {
  it("ANC_VISIT_TYPES contains the 6 documented visit kinds", () => {
    expect(ANC_VISIT_TYPES).toEqual([
      "FIRST_VISIT",
      "ROUTINE",
      "HIGH_RISK_FOLLOWUP",
      "SCAN_REVIEW",
      "DELIVERY",
      "POSTNATAL",
    ]);
  });
  it("DELIVERY_TYPES has NORMAL/C_SECTION/INSTRUMENTAL", () => {
    expect(DELIVERY_TYPES).toEqual(["NORMAL", "C_SECTION", "INSTRUMENTAL"]);
  });
  it("MILESTONE_DOMAINS covers 5 developmental domains", () => {
    expect(MILESTONE_DOMAINS).toEqual([
      "GROSS_MOTOR",
      "FINE_MOTOR",
      "LANGUAGE",
      "SOCIAL",
      "COGNITIVE",
    ]);
  });
  it("FEED_TYPES covers the 5 documented feed kinds", () => {
    expect(FEED_TYPES).toEqual([
      "BREAST_LEFT",
      "BREAST_RIGHT",
      "BOTTLE_FORMULA",
      "BOTTLE_EBM",
      "SOLID_FOOD",
    ]);
  });
});

// ─── createAncCaseSchema ───────────────────────────────

describe("createAncCaseSchema", () => {
  // Pick an LMP that is comfortably in the past (1990) — guaranteed valid
  // regardless of today's date.
  const valid = {
    patientId: UUID,
    doctorId: UUID2,
    lmpDate: "1990-01-15",
  };

  it("accepts a minimal valid case (gravida/parity default)", () => {
    const r = createAncCaseSchema.safeParse(valid);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.gravida).toBe(1);
      expect(r.data.parity).toBe(0);
      expect(r.data.isHighRisk).toBe(false);
    }
  });

  it("accepts a case with all optional fields populated", () => {
    expect(
      createAncCaseSchema.safeParse({
        ...valid,
        gravida: 3,
        parity: 2,
        bloodGroup: "O_POS",
        isHighRisk: true,
        riskFactors: "prior c-section",
      }).success
    ).toBe(true);
  });

  it("rejects non-uuid patientId", () => {
    expect(
      createAncCaseSchema.safeParse({ ...valid, patientId: "not-a-uuid" }).success
    ).toBe(false);
  });

  it("rejects non-uuid doctorId", () => {
    expect(
      createAncCaseSchema.safeParse({ ...valid, doctorId: "not-a-uuid" }).success
    ).toBe(false);
  });

  it("rejects malformed LMP date (wrong format)", () => {
    expect(createAncCaseSchema.safeParse({ ...valid, lmpDate: "15-01-1990" }).success).toBe(
      false
    );
  });

  it("rejects future LMP date (Issue #57)", () => {
    // year 2999 is unambiguously in the future
    const r = createAncCaseSchema.safeParse({ ...valid, lmpDate: "2999-12-31" });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0].message).toMatch(/future/i);
    }
  });

  it("accepts today's UTC date as LMP (boundary inclusive)", () => {
    const now = new Date();
    const today = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(
      2,
      "0"
    )}-${String(now.getUTCDate()).padStart(2, "0")}`;
    expect(createAncCaseSchema.safeParse({ ...valid, lmpDate: today }).success).toBe(true);
  });

  it("rejects gravida < 1", () => {
    expect(createAncCaseSchema.safeParse({ ...valid, gravida: 0 }).success).toBe(false);
  });

  it("rejects negative gravida", () => {
    expect(createAncCaseSchema.safeParse({ ...valid, gravida: -1 }).success).toBe(false);
  });

  it("rejects non-integer gravida", () => {
    expect(createAncCaseSchema.safeParse({ ...valid, gravida: 1.5 }).success).toBe(false);
  });

  it("rejects negative parity", () => {
    expect(createAncCaseSchema.safeParse({ ...valid, parity: -1 }).success).toBe(false);
  });

  it("accepts parity = 0 (boundary inclusive)", () => {
    expect(createAncCaseSchema.safeParse({ ...valid, parity: 0 }).success).toBe(true);
  });

  it("rejects unknown bloodGroup token", () => {
    expect(
      createAncCaseSchema.safeParse({ ...valid, bloodGroup: "XYZ_POS" }).success
    ).toBe(false);
  });

  it("accepts every canonical blood group", () => {
    for (const bg of ["A_POS", "A_NEG", "B_POS", "B_NEG", "AB_POS", "AB_NEG", "O_POS", "O_NEG"]) {
      expect(createAncCaseSchema.safeParse({ ...valid, bloodGroup: bg }).success).toBe(true);
    }
  });
});

// ─── updateAncCaseSchema ───────────────────────────────

describe("updateAncCaseSchema", () => {
  it("accepts an empty patch", () => {
    expect(updateAncCaseSchema.safeParse({}).success).toBe(true);
  });

  it("accepts a partial patch with one field", () => {
    expect(updateAncCaseSchema.safeParse({ isHighRisk: true }).success).toBe(true);
  });

  it("rejects gravida = 0 on update (still requires ≥ 1)", () => {
    expect(updateAncCaseSchema.safeParse({ gravida: 0 }).success).toBe(false);
  });

  it("rejects negative parity on update", () => {
    expect(updateAncCaseSchema.safeParse({ parity: -2 }).success).toBe(false);
  });

  it("rejects unknown bloodGroup on update", () => {
    expect(updateAncCaseSchema.safeParse({ bloodGroup: "ZZZ" }).success).toBe(false);
  });

  it("accepts riskFactors free text", () => {
    expect(updateAncCaseSchema.safeParse({ riskFactors: "PIH x2" }).success).toBe(true);
  });
});

// ─── createAncVisitSchema (Issue #423 empty-visit guard) ─

describe("createAncVisitSchema", () => {
  const base = { ancCaseId: UUID, type: "ROUTINE" as const };

  it("rejects a wholly-empty visit (Issue #423)", () => {
    const r = createAncVisitSchema.safeParse(base);
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0].path).toEqual(["notes"]);
      expect(r.error.issues[0].message).toMatch(/at least one observation/i);
    }
  });

  it("rejects when only whitespace-blank fields are present", () => {
    expect(
      createAncVisitSchema.safeParse({
        ...base,
        bloodPressure: "   ",
        notes: "  ",
        urineSugar: "",
      }).success
    ).toBe(false);
  });

  it("accepts visit with notes alone", () => {
    expect(createAncVisitSchema.safeParse({ ...base, notes: "patient feels well" }).success).toBe(
      true
    );
  });

  it("accepts visit with numeric weeksOfGestation alone", () => {
    expect(createAncVisitSchema.safeParse({ ...base, weeksOfGestation: 24 }).success).toBe(true);
  });

  it("accepts visit with weight alone", () => {
    expect(createAncVisitSchema.safeParse({ ...base, weight: 62.5 }).success).toBe(true);
  });

  it("accepts visit with fetalHeartRate at lower boundary 60", () => {
    expect(createAncVisitSchema.safeParse({ ...base, fetalHeartRate: 60 }).success).toBe(true);
  });

  it("accepts visit with fetalHeartRate at upper boundary 220", () => {
    expect(createAncVisitSchema.safeParse({ ...base, fetalHeartRate: 220 }).success).toBe(true);
  });

  it("rejects fetalHeartRate below 60", () => {
    expect(createAncVisitSchema.safeParse({ ...base, fetalHeartRate: 59 }).success).toBe(false);
  });

  it("rejects fetalHeartRate above 220", () => {
    expect(createAncVisitSchema.safeParse({ ...base, fetalHeartRate: 221 }).success).toBe(false);
  });

  it("rejects weeksOfGestation > 50", () => {
    expect(createAncVisitSchema.safeParse({ ...base, weeksOfGestation: 51 }).success).toBe(false);
  });

  it("rejects negative weight", () => {
    expect(createAncVisitSchema.safeParse({ ...base, weight: -1 }).success).toBe(false);
  });

  it("rejects weight = 0 (positive)", () => {
    expect(createAncVisitSchema.safeParse({ ...base, weight: 0 }).success).toBe(false);
  });

  it("rejects non-uuid ancCaseId", () => {
    expect(
      createAncVisitSchema.safeParse({ ancCaseId: "abc", type: "ROUTINE", notes: "x" }).success
    ).toBe(false);
  });

  it("rejects unknown visit type", () => {
    expect(
      createAncVisitSchema.safeParse({ ...base, type: "WEIRD" as any, notes: "x" }).success
    ).toBe(false);
  });

  it("rejects malformed nextVisitDate", () => {
    expect(
      createAncVisitSchema.safeParse({
        ...base,
        notes: "x",
        nextVisitDate: "01-01-2026",
      }).success
    ).toBe(false);
  });

  it("accepts well-formed nextVisitDate", () => {
    expect(
      createAncVisitSchema.safeParse({
        ...base,
        notes: "x",
        nextVisitDate: "2026-12-31",
      }).success
    ).toBe(true);
  });
});

// ─── deliveryOutcomeSchema ─────────────────────────────

describe("deliveryOutcomeSchema", () => {
  it("accepts the minimum payload (deliveryType only)", () => {
    expect(deliveryOutcomeSchema.safeParse({ deliveryType: "NORMAL" }).success).toBe(true);
  });

  it("accepts a fully populated delivery outcome", () => {
    expect(
      deliveryOutcomeSchema.safeParse({
        deliveryType: "C_SECTION",
        babyGender: "FEMALE",
        babyWeight: 3.2,
        outcomeNotes: "uneventful",
      }).success
    ).toBe(true);
  });

  it("rejects unknown deliveryType", () => {
    expect(
      deliveryOutcomeSchema.safeParse({ deliveryType: "TELEPORTED" as any }).success
    ).toBe(false);
  });

  it("rejects negative babyWeight", () => {
    expect(
      deliveryOutcomeSchema.safeParse({ deliveryType: "NORMAL", babyWeight: -1 }).success
    ).toBe(false);
  });

  it("rejects babyWeight = 0 (positive only)", () => {
    expect(
      deliveryOutcomeSchema.safeParse({ deliveryType: "NORMAL", babyWeight: 0 }).success
    ).toBe(false);
  });
});

// ─── ultrasoundRecordSchema ────────────────────────────

describe("ultrasoundRecordSchema", () => {
  it("accepts the minimum payload (ancCaseId only)", () => {
    expect(ultrasoundRecordSchema.safeParse({ ancCaseId: UUID }).success).toBe(true);
  });

  it("accepts a fully populated scan record", () => {
    expect(
      ultrasoundRecordSchema.safeParse({
        ancCaseId: UUID,
        scanDate: "2026-05-01",
        gestationalWeeks: 24,
        efwGrams: 700,
        afi: 12.5,
        placentaPosition: "Anterior",
        fetalHeartRate: 140,
        presentation: "Cephalic",
        findings: "normal",
        impression: "growth on track",
      }).success
    ).toBe(true);
  });

  it("rejects non-uuid ancCaseId", () => {
    expect(ultrasoundRecordSchema.safeParse({ ancCaseId: "abc" }).success).toBe(false);
  });

  it("rejects negative efwGrams", () => {
    expect(
      ultrasoundRecordSchema.safeParse({ ancCaseId: UUID, efwGrams: -1 }).success
    ).toBe(false);
  });

  it("accepts efwGrams = 0 (nonnegative inclusive)", () => {
    expect(ultrasoundRecordSchema.safeParse({ ancCaseId: UUID, efwGrams: 0 }).success).toBe(true);
  });

  it("rejects negative afi", () => {
    expect(ultrasoundRecordSchema.safeParse({ ancCaseId: UUID, afi: -0.1 }).success).toBe(false);
  });

  it("rejects fetalHeartRate above 220", () => {
    expect(
      ultrasoundRecordSchema.safeParse({ ancCaseId: UUID, fetalHeartRate: 230 }).success
    ).toBe(false);
  });

  it("rejects gestationalWeeks above 50", () => {
    expect(
      ultrasoundRecordSchema.safeParse({ ancCaseId: UUID, gestationalWeeks: 60 }).success
    ).toBe(false);
  });
});

// ─── createGrowthRecordSchema (Issue #435 WHO envelope) ─

describe("createGrowthRecordSchema", () => {
  const base = { patientId: UUID, ageMonths: 6 };

  it("accepts the minimal payload (patientId + ageMonths)", () => {
    expect(createGrowthRecordSchema.safeParse(base).success).toBe(true);
  });

  it("rejects non-uuid patientId", () => {
    expect(
      createGrowthRecordSchema.safeParse({ patientId: "abc", ageMonths: 6 }).success
    ).toBe(false);
  });

  it("rejects ageMonths < 0", () => {
    expect(
      createGrowthRecordSchema.safeParse({ patientId: UUID, ageMonths: -1 }).success
    ).toBe(false);
  });

  it("rejects ageMonths > 240 (20 yr cap)", () => {
    expect(
      createGrowthRecordSchema.safeParse({ patientId: UUID, ageMonths: 241 }).success
    ).toBe(false);
  });

  it("accepts ageMonths = 0 (newborn)", () => {
    expect(
      createGrowthRecordSchema.safeParse({ patientId: UUID, ageMonths: 0 }).success
    ).toBe(true);
  });

  it("accepts ageMonths = 240 (boundary inclusive)", () => {
    expect(
      createGrowthRecordSchema.safeParse({ patientId: UUID, ageMonths: 240 }).success
    ).toBe(true);
  });

  it("rejects non-integer ageMonths", () => {
    expect(
      createGrowthRecordSchema.safeParse({ patientId: UUID, ageMonths: 6.5 }).success
    ).toBe(false);
  });

  it("rejects weightKg below 0.5", () => {
    expect(createGrowthRecordSchema.safeParse({ ...base, weightKg: 0.4 }).success).toBe(false);
  });

  it("accepts weightKg at lower boundary 0.5", () => {
    expect(createGrowthRecordSchema.safeParse({ ...base, weightKg: 0.5 }).success).toBe(true);
  });

  it("rejects weightKg above 200", () => {
    expect(createGrowthRecordSchema.safeParse({ ...base, weightKg: 200.1 }).success).toBe(false);
  });

  it("accepts weightKg at upper boundary 200", () => {
    expect(createGrowthRecordSchema.safeParse({ ...base, weightKg: 200 }).success).toBe(true);
  });

  it("rejects heightCm below 30", () => {
    expect(createGrowthRecordSchema.safeParse({ ...base, heightCm: 29 }).success).toBe(false);
  });

  it("accepts heightCm at lower boundary 30", () => {
    expect(createGrowthRecordSchema.safeParse({ ...base, heightCm: 30 }).success).toBe(true);
  });

  it("rejects heightCm above 220", () => {
    expect(createGrowthRecordSchema.safeParse({ ...base, heightCm: 221 }).success).toBe(false);
  });

  it("accepts heightCm at upper boundary 220", () => {
    expect(createGrowthRecordSchema.safeParse({ ...base, heightCm: 220 }).success).toBe(true);
  });

  it("rejects headCircumference below 25", () => {
    expect(
      createGrowthRecordSchema.safeParse({ ...base, headCircumference: 24 }).success
    ).toBe(false);
  });

  it("accepts headCircumference at upper boundary 65", () => {
    expect(
      createGrowthRecordSchema.safeParse({ ...base, headCircumference: 65 }).success
    ).toBe(true);
  });

  it("rejects headCircumference above 65", () => {
    expect(
      createGrowthRecordSchema.safeParse({ ...base, headCircumference: 65.5 }).success
    ).toBe(false);
  });

  it("rejects malformed measurementDate", () => {
    expect(
      createGrowthRecordSchema.safeParse({ ...base, measurementDate: "01/01/2026" }).success
    ).toBe(false);
  });
});

// ─── updateGrowthRecordSchema ──────────────────────────

describe("updateGrowthRecordSchema", () => {
  it("accepts an empty patch", () => {
    expect(updateGrowthRecordSchema.safeParse({}).success).toBe(true);
  });

  it("accepts a single-field patch", () => {
    expect(updateGrowthRecordSchema.safeParse({ weightKg: 12.5 }).success).toBe(true);
  });

  it("rejects weightKg above 200 on update", () => {
    expect(updateGrowthRecordSchema.safeParse({ weightKg: 250 }).success).toBe(false);
  });

  it("rejects heightCm below 30 on update", () => {
    expect(updateGrowthRecordSchema.safeParse({ heightCm: 10 }).success).toBe(false);
  });

  it("rejects headCircumference above 65 on update", () => {
    expect(updateGrowthRecordSchema.safeParse({ headCircumference: 80 }).success).toBe(false);
  });

  it("accepts free-text milestone/developmental notes", () => {
    expect(
      updateGrowthRecordSchema.safeParse({
        milestoneNotes: "sits unsupported",
        developmentalNotes: "tracks objects across midline",
      }).success
    ).toBe(true);
  });
});

// ─── partographObservationSchema ───────────────────────

describe("partographObservationSchema", () => {
  it("accepts time-only observation", () => {
    expect(partographObservationSchema.safeParse({ time: "10:00" }).success).toBe(true);
  });

  it("accepts a fully populated observation", () => {
    expect(
      partographObservationSchema.safeParse({
        time: "10:00",
        fetalHeartRate: 140,
        cervicalDilation: 6,
        descent: 0,
        contractionsPer10Min: 3,
        contractionStrength: "MODERATE",
        maternalPulse: 80,
        maternalBP: "120/80",
        temperature: 36.8,
        notes: "labour progressing",
      }).success
    ).toBe(true);
  });

  it("rejects cervicalDilation > 10", () => {
    expect(
      partographObservationSchema.safeParse({ time: "10:00", cervicalDilation: 11 }).success
    ).toBe(false);
  });

  it("accepts cervicalDilation = 10 (boundary inclusive)", () => {
    expect(
      partographObservationSchema.safeParse({ time: "10:00", cervicalDilation: 10 }).success
    ).toBe(true);
  });

  it("rejects descent below -5", () => {
    expect(
      partographObservationSchema.safeParse({ time: "10:00", descent: -6 }).success
    ).toBe(false);
  });

  it("rejects descent above +5", () => {
    expect(
      partographObservationSchema.safeParse({ time: "10:00", descent: 6 }).success
    ).toBe(false);
  });

  it("rejects contractionsPer10Min > 10", () => {
    expect(
      partographObservationSchema.safeParse({ time: "10:00", contractionsPer10Min: 11 }).success
    ).toBe(false);
  });

  it("rejects unknown contractionStrength", () => {
    expect(
      partographObservationSchema.safeParse({
        time: "10:00",
        contractionStrength: "EXTREME" as any,
      }).success
    ).toBe(false);
  });

  it("rejects maternalPulse below 40", () => {
    expect(
      partographObservationSchema.safeParse({ time: "10:00", maternalPulse: 39 }).success
    ).toBe(false);
  });

  it("rejects maternalPulse above 200", () => {
    expect(
      partographObservationSchema.safeParse({ time: "10:00", maternalPulse: 201 }).success
    ).toBe(false);
  });

  it("rejects missing time field", () => {
    expect(partographObservationSchema.safeParse({}).success).toBe(false);
  });
});

// ─── startPartographSchema ─────────────────────────────

describe("startPartographSchema", () => {
  it("accepts an empty payload (defaults observations to [])", () => {
    const r = startPartographSchema.safeParse({});
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.observations).toEqual([]);
    }
  });

  it("accepts observations + interventions", () => {
    expect(
      startPartographSchema.safeParse({
        observations: [{ time: "10:00", cervicalDilation: 4 }],
        interventions: "syntocinon started",
      }).success
    ).toBe(true);
  });

  it("rejects observations containing an invalid entry (missing time)", () => {
    expect(
      startPartographSchema.safeParse({
        observations: [{ cervicalDilation: 4 }],
      }).success
    ).toBe(false);
  });
});

// ─── addPartographObservationSchema (alias) ────────────

describe("addPartographObservationSchema", () => {
  it("is a re-export of partographObservationSchema", () => {
    expect(addPartographObservationSchema).toBe(partographObservationSchema);
  });
});

// ─── endPartographSchema ───────────────────────────────

describe("endPartographSchema", () => {
  it("accepts a valid end payload", () => {
    expect(endPartographSchema.safeParse({ outcome: "Live birth" }).success).toBe(true);
  });

  it("accepts outcome + interventions", () => {
    expect(
      endPartographSchema.safeParse({
        outcome: "Live birth",
        interventions: "episiotomy",
      }).success
    ).toBe(true);
  });

  it("rejects empty outcome string", () => {
    expect(endPartographSchema.safeParse({ outcome: "" }).success).toBe(false);
  });

  it("rejects missing outcome", () => {
    expect(endPartographSchema.safeParse({}).success).toBe(false);
  });
});

// ─── acogRiskScoreSchema ───────────────────────────────

describe("acogRiskScoreSchema", () => {
  it("accepts an empty payload (all fields optional)", () => {
    expect(acogRiskScoreSchema.safeParse({}).success).toBe(true);
  });

  it("accepts a fully populated risk-score input", () => {
    expect(
      acogRiskScoreSchema.safeParse({
        heightCm: 160,
        weightKg: 65,
        hasPrevCSection: true,
        hasHypertension: false,
        hasDiabetes: true,
        hasPriorGDM: false,
        hasPriorStillbirth: false,
        hasPriorPreterm: false,
        hasPriorComplications: true,
        currentBleeding: false,
        currentPreeclampsia: false,
      }).success
    ).toBe(true);
  });

  it("rejects negative heightCm (positive only)", () => {
    expect(acogRiskScoreSchema.safeParse({ heightCm: -160 }).success).toBe(false);
  });

  it("rejects heightCm = 0", () => {
    expect(acogRiskScoreSchema.safeParse({ heightCm: 0 }).success).toBe(false);
  });

  it("rejects negative weightKg", () => {
    expect(acogRiskScoreSchema.safeParse({ weightKg: -1 }).success).toBe(false);
  });

  it("rejects non-boolean flag", () => {
    expect(
      acogRiskScoreSchema.safeParse({ hasPrevCSection: "yes" as any }).success
    ).toBe(false);
  });
});

// ─── postnatalVisitSchema ──────────────────────────────

describe("postnatalVisitSchema", () => {
  it("accepts the minimum payload (weekPostpartum only)", () => {
    expect(postnatalVisitSchema.safeParse({ weekPostpartum: 1 }).success).toBe(true);
  });

  it("accepts a fully populated postnatal visit", () => {
    expect(
      postnatalVisitSchema.safeParse({
        weekPostpartum: 2,
        motherBP: "118/76",
        motherWeight: 60.2,
        lochia: "NORMAL",
        uterineInvolution: "NORMAL",
        breastExam: "no engorgement",
        breastfeeding: "EXCLUSIVE",
        mentalHealth: "EPDS 4",
        babyWeight: 3.4,
        babyFeeding: "on demand",
        babyJaundice: false,
        babyExam: "normal",
        immunizationGiven: "BCG, OPV",
        notes: "routine review",
      }).success
    ).toBe(true);
  });

  it("rejects weekPostpartum < 0", () => {
    expect(postnatalVisitSchema.safeParse({ weekPostpartum: -1 }).success).toBe(false);
  });

  it("accepts weekPostpartum = 0 (day-zero discharge)", () => {
    expect(postnatalVisitSchema.safeParse({ weekPostpartum: 0 }).success).toBe(true);
  });

  it("rejects weekPostpartum > 52", () => {
    expect(postnatalVisitSchema.safeParse({ weekPostpartum: 53 }).success).toBe(false);
  });

  it("accepts weekPostpartum = 52 (boundary inclusive)", () => {
    expect(postnatalVisitSchema.safeParse({ weekPostpartum: 52 }).success).toBe(true);
  });

  it("rejects unknown lochia enum value", () => {
    expect(
      postnatalVisitSchema.safeParse({ weekPostpartum: 1, lochia: "WEIRD" as any }).success
    ).toBe(false);
  });

  it("rejects unknown uterineInvolution enum value", () => {
    expect(
      postnatalVisitSchema.safeParse({
        weekPostpartum: 1,
        uterineInvolution: "STUCK" as any,
      }).success
    ).toBe(false);
  });

  it("rejects unknown breastfeeding enum value", () => {
    expect(
      postnatalVisitSchema.safeParse({
        weekPostpartum: 1,
        breastfeeding: "PARTIAL" as any,
      }).success
    ).toBe(false);
  });

  it("rejects negative motherWeight", () => {
    expect(
      postnatalVisitSchema.safeParse({ weekPostpartum: 1, motherWeight: -1 }).success
    ).toBe(false);
  });

  it("rejects babyWeight = 0", () => {
    expect(
      postnatalVisitSchema.safeParse({ weekPostpartum: 1, babyWeight: 0 }).success
    ).toBe(false);
  });
});

// ─── milestoneRecordSchema ─────────────────────────────

describe("milestoneRecordSchema", () => {
  const valid = {
    patientId: UUID,
    ageMonths: 12,
    domain: "GROSS_MOTOR" as const,
    milestone: "walks holding furniture",
    achieved: true,
  };

  it("accepts a valid milestone record", () => {
    expect(milestoneRecordSchema.safeParse(valid).success).toBe(true);
  });

  it("accepts a record with optional achievedAt + notes", () => {
    expect(
      milestoneRecordSchema.safeParse({
        ...valid,
        achievedAt: "2026-05-25T10:00:00.000Z",
        notes: "with both hands",
      }).success
    ).toBe(true);
  });

  it("rejects non-uuid patientId", () => {
    expect(milestoneRecordSchema.safeParse({ ...valid, patientId: "abc" }).success).toBe(false);
  });

  it("rejects ageMonths < 0", () => {
    expect(milestoneRecordSchema.safeParse({ ...valid, ageMonths: -1 }).success).toBe(false);
  });

  it("rejects ageMonths > 240", () => {
    expect(milestoneRecordSchema.safeParse({ ...valid, ageMonths: 300 }).success).toBe(false);
  });

  it("rejects unknown domain", () => {
    expect(
      milestoneRecordSchema.safeParse({ ...valid, domain: "TELEPATHY" as any }).success
    ).toBe(false);
  });

  it("rejects empty milestone string", () => {
    expect(milestoneRecordSchema.safeParse({ ...valid, milestone: "" }).success).toBe(false);
  });

  it("rejects non-boolean achieved", () => {
    expect(
      milestoneRecordSchema.safeParse({ ...valid, achieved: "yes" as any }).success
    ).toBe(false);
  });

  it("rejects malformed achievedAt datetime", () => {
    expect(
      milestoneRecordSchema.safeParse({ ...valid, achievedAt: "2026-05-25" }).success
    ).toBe(false);
  });

  it("accepts every documented domain", () => {
    for (const d of MILESTONE_DOMAINS) {
      expect(milestoneRecordSchema.safeParse({ ...valid, domain: d }).success).toBe(true);
    }
  });
});

// ─── feedingLogSchema ──────────────────────────────────

describe("feedingLogSchema", () => {
  it("accepts the minimum payload (feedType only)", () => {
    expect(feedingLogSchema.safeParse({ feedType: "BREAST_LEFT" }).success).toBe(true);
  });

  it("accepts a fully populated feeding log", () => {
    expect(
      feedingLogSchema.safeParse({
        loggedAt: "2026-05-25T08:00:00.000Z",
        feedType: "BOTTLE_FORMULA",
        durationMin: 15,
        volumeMl: 120,
        foodItem: "Lactogen-1",
        notes: "fed well",
      }).success
    ).toBe(true);
  });

  it("rejects unknown feedType", () => {
    expect(feedingLogSchema.safeParse({ feedType: "IV_DRIP" as any }).success).toBe(false);
  });

  it("rejects durationMin < 0", () => {
    expect(
      feedingLogSchema.safeParse({ feedType: "BREAST_LEFT", durationMin: -1 }).success
    ).toBe(false);
  });

  it("accepts durationMin = 0 (boundary inclusive)", () => {
    expect(
      feedingLogSchema.safeParse({ feedType: "BREAST_LEFT", durationMin: 0 }).success
    ).toBe(true);
  });

  it("rejects durationMin > 300", () => {
    expect(
      feedingLogSchema.safeParse({ feedType: "BREAST_LEFT", durationMin: 301 }).success
    ).toBe(false);
  });

  it("rejects non-integer durationMin", () => {
    expect(
      feedingLogSchema.safeParse({ feedType: "BREAST_LEFT", durationMin: 12.5 }).success
    ).toBe(false);
  });

  it("rejects volumeMl > 2000", () => {
    expect(
      feedingLogSchema.safeParse({ feedType: "BOTTLE_EBM", volumeMl: 2001 }).success
    ).toBe(false);
  });

  it("accepts volumeMl = 2000 (boundary inclusive)", () => {
    expect(
      feedingLogSchema.safeParse({ feedType: "BOTTLE_EBM", volumeMl: 2000 }).success
    ).toBe(true);
  });

  it("rejects non-integer volumeMl", () => {
    expect(
      feedingLogSchema.safeParse({ feedType: "BOTTLE_EBM", volumeMl: 50.5 }).success
    ).toBe(false);
  });

  it("rejects malformed loggedAt datetime", () => {
    expect(
      feedingLogSchema.safeParse({ feedType: "BREAST_LEFT", loggedAt: "yesterday" }).success
    ).toBe(false);
  });

  it("accepts every documented feed type", () => {
    for (const f of FEED_TYPES) {
      expect(feedingLogSchema.safeParse({ feedType: f }).success).toBe(true);
    }
  });
});
