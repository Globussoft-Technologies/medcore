// Coverage tests for EHR validation schemas.
// What: exhaustive happy / invalid / edge cases for every exported Zod schema
//   and enum in packages/shared/src/validation/ehr.ts — allergies, conditions
//   (create + update), family history, immunizations (create + update),
//   documents, advance directives (create + update), medication reconciliation
//   (create + update + MedItem rows), and the problem-list filter query shape.
// Which modules: imports only schemas / enums from ../ehr.
// Why: file shipped with 0% colocated coverage (171 lines). The shared
//   YYYY-MM-DD `dateString` regex (lines 28-30) gates date fields across the
//   surface, so we lock in calendar-format strictness on every date input.
//   The MedItem default-stamping behavior (dosage/frequency/route empty-string
//   defaults; continued=true default) and the changes object's deep defaults
//   are easy to regress, so we assert the parsed output shape, not just
//   success/failure.
import { describe, it, expect } from "vitest";
import {
  AllergySeverityEnum,
  ConditionStatusEnum,
  DocumentTypeEnum,
  createAllergySchema,
  createConditionSchema,
  updateConditionSchema,
  createFamilyHistorySchema,
  createImmunizationSchema,
  updateImmunizationSchema,
  createDocumentSchema,
  AdvanceDirectiveTypeEnum,
  advanceDirectiveSchema,
  updateAdvanceDirectiveSchema,
  MedItemSchema,
  medReconciliationSchema,
  updateMedReconciliationSchema,
  problemListFilterSchema,
} from "../ehr";

const UUID = "550e8400-e29b-41d4-a716-446655441111";
const UUID_2 = "550e8400-e29b-41d4-a716-446655442222";
const UUID_3 = "550e8400-e29b-41d4-a716-446655443333";

// ───────────────────────────────────────────────────────
// Enums
// ───────────────────────────────────────────────────────

describe("AllergySeverityEnum", () => {
  it("accepts each canonical severity", () => {
    for (const s of ["MILD", "MODERATE", "SEVERE", "LIFE_THREATENING"]) {
      expect(AllergySeverityEnum.safeParse(s).success).toBe(true);
    }
  });
  it("rejects unknown severity", () => {
    expect(AllergySeverityEnum.safeParse("CRITICAL").success).toBe(false);
  });
  it("rejects lowercase variant", () => {
    expect(AllergySeverityEnum.safeParse("mild").success).toBe(false);
  });
  it("rejects empty string", () => {
    expect(AllergySeverityEnum.safeParse("").success).toBe(false);
  });
});

describe("ConditionStatusEnum", () => {
  it("accepts each canonical status", () => {
    for (const s of ["ACTIVE", "CONTROLLED", "RESOLVED", "RELAPSED"]) {
      expect(ConditionStatusEnum.safeParse(s).success).toBe(true);
    }
  });
  it("rejects unknown status", () => {
    expect(ConditionStatusEnum.safeParse("CHRONIC").success).toBe(false);
  });
});

describe("DocumentTypeEnum", () => {
  it("accepts each canonical document type", () => {
    for (const t of [
      "LAB_REPORT",
      "IMAGING",
      "DISCHARGE_SUMMARY",
      "CONSENT",
      "INSURANCE",
      "REFERRAL_LETTER",
      "ID_PROOF",
      "OTHER",
    ]) {
      expect(DocumentTypeEnum.safeParse(t).success).toBe(true);
    }
  });
  it("rejects unknown document type", () => {
    expect(DocumentTypeEnum.safeParse("PRESCRIPTION").success).toBe(false);
  });
});

describe("AdvanceDirectiveTypeEnum", () => {
  it("accepts each canonical directive type", () => {
    for (const t of ["DNR", "DNI", "DNA", "LIVING_WILL", "ORGAN_DONATION", "OTHER"]) {
      expect(AdvanceDirectiveTypeEnum.safeParse(t).success).toBe(true);
    }
  });
  it("rejects unknown directive type", () => {
    expect(AdvanceDirectiveTypeEnum.safeParse("POLST").success).toBe(false);
  });
});

// ───────────────────────────────────────────────────────
// Allergies
// ───────────────────────────────────────────────────────

describe("createAllergySchema", () => {
  const valid = {
    patientId: UUID,
    allergen: "Penicillin",
    severity: "SEVERE" as const,
  };
  it("accepts a minimal valid allergy", () => {
    expect(createAllergySchema.safeParse(valid).success).toBe(true);
  });
  it("accepts an allergy with reaction + notes", () => {
    expect(
      createAllergySchema.safeParse({
        ...valid,
        reaction: "Anaphylaxis",
        notes: "EpiPen on hand",
      }).success
    ).toBe(true);
  });
  it("rejects non-uuid patientId", () => {
    expect(
      createAllergySchema.safeParse({ ...valid, patientId: "not-a-uuid" }).success
    ).toBe(false);
  });
  it("rejects empty allergen (min 1)", () => {
    const r = createAllergySchema.safeParse({ ...valid, allergen: "" });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => /Allergen is required/.test(i.message))).toBe(true);
    }
  });
  it("rejects unknown severity", () => {
    expect(
      createAllergySchema.safeParse({ ...valid, severity: "CRITICAL" as any }).success
    ).toBe(false);
  });
  it("rejects missing patientId", () => {
    const { patientId: _p, ...rest } = valid;
    expect(createAllergySchema.safeParse(rest).success).toBe(false);
  });
  it("rejects missing severity", () => {
    const { severity: _s, ...rest } = valid;
    expect(createAllergySchema.safeParse(rest).success).toBe(false);
  });
  it("rejects non-string reaction", () => {
    expect(
      createAllergySchema.safeParse({ ...valid, reaction: 42 as any }).success
    ).toBe(false);
  });
});

// ───────────────────────────────────────────────────────
// Conditions
// ───────────────────────────────────────────────────────

describe("createConditionSchema", () => {
  const valid = {
    patientId: UUID,
    condition: "Type 2 diabetes mellitus",
    status: "ACTIVE" as const,
  };
  it("accepts a minimal valid condition", () => {
    expect(createConditionSchema.safeParse(valid).success).toBe(true);
  });
  it("accepts a fully-populated condition", () => {
    expect(
      createConditionSchema.safeParse({
        ...valid,
        icd10Code: "E11.9",
        diagnosedDate: "2024-03-15",
        notes: "Diet-controlled",
      }).success
    ).toBe(true);
  });
  it("rejects non-uuid patientId", () => {
    expect(
      createConditionSchema.safeParse({ ...valid, patientId: "abc" }).success
    ).toBe(false);
  });
  it("rejects empty condition (min 1)", () => {
    const r = createConditionSchema.safeParse({ ...valid, condition: "" });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => /Condition is required/.test(i.message))).toBe(true);
    }
  });
  it("rejects unknown status", () => {
    expect(
      createConditionSchema.safeParse({ ...valid, status: "PENDING" as any }).success
    ).toBe(false);
  });
  it("rejects malformed diagnosedDate (DD-MM-YYYY)", () => {
    expect(
      createConditionSchema.safeParse({ ...valid, diagnosedDate: "15-03-2024" }).success
    ).toBe(false);
  });
  it("rejects malformed diagnosedDate (single-digit month)", () => {
    expect(
      createConditionSchema.safeParse({ ...valid, diagnosedDate: "2024-3-15" }).success
    ).toBe(false);
  });
  it("rejects malformed diagnosedDate (slash separator)", () => {
    expect(
      createConditionSchema.safeParse({ ...valid, diagnosedDate: "2024/03/15" }).success
    ).toBe(false);
  });
  it("accepts diagnosedDate at YYYY-MM-DD format", () => {
    expect(
      createConditionSchema.safeParse({ ...valid, diagnosedDate: "2024-03-15" }).success
    ).toBe(true);
  });
  it("accepts an ICD-10 code free-text (no format enforcement)", () => {
    // Source treats icd10Code as a free string — format is NOT enforced.
    expect(
      createConditionSchema.safeParse({ ...valid, icd10Code: "anything-goes" }).success
    ).toBe(true);
  });
});

describe("updateConditionSchema", () => {
  it("accepts an empty patch (all fields optional)", () => {
    expect(updateConditionSchema.safeParse({}).success).toBe(true);
  });
  it("accepts a status-only patch (RESOLVED transition)", () => {
    expect(updateConditionSchema.safeParse({ status: "RESOLVED" }).success).toBe(true);
  });
  it("accepts a notes-only patch", () => {
    expect(updateConditionSchema.safeParse({ notes: "Started metformin" }).success).toBe(true);
  });
  it("accepts a full update", () => {
    expect(
      updateConditionSchema.safeParse({
        status: "CONTROLLED",
        notes: "HbA1c down to 6.2",
        icd10Code: "E11.9",
        condition: "Type 2 diabetes mellitus, controlled",
        diagnosedDate: "2024-03-15",
      }).success
    ).toBe(true);
  });
  it("rejects empty condition string (min 1 retained on update)", () => {
    expect(updateConditionSchema.safeParse({ condition: "" }).success).toBe(false);
  });
  it("rejects malformed diagnosedDate (slash separator)", () => {
    // NOTE: dateString regex only checks YYYY-MM-DD shape, NOT calendar
    // validity — "2024-13-01" actually PASSES the regex. Locking to a
    // separator-shape failure that the regex genuinely rejects.
    expect(
      updateConditionSchema.safeParse({ diagnosedDate: "2024/13/01" }).success
    ).toBe(false);
  });
  it("rejects unknown status", () => {
    expect(
      updateConditionSchema.safeParse({ status: "DORMANT" as any }).success
    ).toBe(false);
  });
});

// ───────────────────────────────────────────────────────
// Family History
// ───────────────────────────────────────────────────────

describe("createFamilyHistorySchema", () => {
  const valid = {
    patientId: UUID,
    relation: "Father",
    condition: "Coronary artery disease",
  };
  it("accepts a minimal valid family history entry", () => {
    expect(createFamilyHistorySchema.safeParse(valid).success).toBe(true);
  });
  it("accepts an entry with notes", () => {
    expect(
      createFamilyHistorySchema.safeParse({
        ...valid,
        notes: "Diagnosed at age 55, MI at 58",
      }).success
    ).toBe(true);
  });
  it("rejects non-uuid patientId", () => {
    expect(
      createFamilyHistorySchema.safeParse({ ...valid, patientId: "abc" }).success
    ).toBe(false);
  });
  it("rejects empty relation (min 1)", () => {
    const r = createFamilyHistorySchema.safeParse({ ...valid, relation: "" });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => /Relation is required/.test(i.message))).toBe(true);
    }
  });
  it("rejects empty condition (min 1)", () => {
    const r = createFamilyHistorySchema.safeParse({ ...valid, condition: "" });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => /Condition is required/.test(i.message))).toBe(true);
    }
  });
  it("rejects missing relation", () => {
    const { relation: _r, ...rest } = valid;
    expect(createFamilyHistorySchema.safeParse(rest).success).toBe(false);
  });
  it("rejects missing condition", () => {
    const { condition: _c, ...rest } = valid;
    expect(createFamilyHistorySchema.safeParse(rest).success).toBe(false);
  });
});

// ───────────────────────────────────────────────────────
// Immunizations
// ───────────────────────────────────────────────────────

describe("createImmunizationSchema", () => {
  const valid = {
    patientId: UUID,
    vaccine: "Hepatitis B",
    dateGiven: "2026-04-12",
  };
  it("accepts a minimal valid immunization (dateGiven is required)", () => {
    expect(createImmunizationSchema.safeParse(valid).success).toBe(true);
  });
  it("accepts a fully-populated immunization", () => {
    expect(
      createImmunizationSchema.safeParse({
        ...valid,
        doseNumber: 2,
        administeredBy: "Nurse Priya",
        batchNumber: "HEPB-2026-04A",
        manufacturer: "Serum Institute",
        site: "Left deltoid",
        nextDueDate: "2026-10-12",
        notes: "No adverse reaction",
      }).success
    ).toBe(true);
  });
  it("rejects non-uuid patientId", () => {
    expect(
      createImmunizationSchema.safeParse({ ...valid, patientId: "abc" }).success
    ).toBe(false);
  });
  it("rejects empty vaccine (min 1)", () => {
    const r = createImmunizationSchema.safeParse({ ...valid, vaccine: "" });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => /Vaccine is required/.test(i.message))).toBe(true);
    }
  });
  it("rejects missing dateGiven (required)", () => {
    const { dateGiven: _d, ...rest } = valid;
    expect(createImmunizationSchema.safeParse(rest).success).toBe(false);
  });
  it("rejects malformed dateGiven", () => {
    expect(
      createImmunizationSchema.safeParse({ ...valid, dateGiven: "12/04/2026" }).success
    ).toBe(false);
  });
  it("rejects malformed nextDueDate", () => {
    expect(
      createImmunizationSchema.safeParse({ ...valid, nextDueDate: "Oct 12 2026" }).success
    ).toBe(false);
  });
  it("rejects non-integer doseNumber", () => {
    expect(
      createImmunizationSchema.safeParse({ ...valid, doseNumber: 1.5 }).success
    ).toBe(false);
  });
  it("rejects zero doseNumber (positive constraint)", () => {
    expect(
      createImmunizationSchema.safeParse({ ...valid, doseNumber: 0 }).success
    ).toBe(false);
  });
  it("rejects negative doseNumber", () => {
    expect(
      createImmunizationSchema.safeParse({ ...valid, doseNumber: -1 }).success
    ).toBe(false);
  });
  it("accepts doseNumber=1 (minimum positive)", () => {
    expect(
      createImmunizationSchema.safeParse({ ...valid, doseNumber: 1 }).success
    ).toBe(true);
  });
});

describe("updateImmunizationSchema", () => {
  it("accepts an empty patch (omit+partial → all optional)", () => {
    expect(updateImmunizationSchema.safeParse({}).success).toBe(true);
  });
  it("accepts a partial update without patientId", () => {
    expect(
      updateImmunizationSchema.safeParse({
        vaccine: "DPT booster",
        dateGiven: "2026-04-12",
      }).success
    ).toBe(true);
  });
  it("accepts a single-field update (notes only)", () => {
    expect(
      updateImmunizationSchema.safeParse({ notes: "Patient reported mild fever overnight" })
        .success
    ).toBe(true);
  });
  it("strips patientId silently (omit()'d at schema level)", () => {
    const r = updateImmunizationSchema.safeParse({ patientId: UUID_2 } as any);
    expect(r.success).toBe(true);
    if (r.success) expect((r.data as any).patientId).toBeUndefined();
  });
  it("rejects empty vaccine on update (min 1 retained via partial)", () => {
    expect(updateImmunizationSchema.safeParse({ vaccine: "" }).success).toBe(false);
  });
  it("rejects malformed dateGiven on update", () => {
    expect(
      updateImmunizationSchema.safeParse({ dateGiven: "2026/04/12" }).success
    ).toBe(false);
  });
  it("rejects non-integer doseNumber on update", () => {
    expect(updateImmunizationSchema.safeParse({ doseNumber: 2.5 }).success).toBe(false);
  });
});

// ───────────────────────────────────────────────────────
// Documents
// ───────────────────────────────────────────────────────

describe("createDocumentSchema", () => {
  const valid = {
    patientId: UUID,
    type: "LAB_REPORT" as const,
    title: "CBC report",
  };
  it("accepts a minimal valid document", () => {
    expect(createDocumentSchema.safeParse(valid).success).toBe(true);
  });
  it("accepts a fully-populated document", () => {
    expect(
      createDocumentSchema.safeParse({
        ...valid,
        notes: "Routine CBC",
        filePath: "/uploads/docs/cbc-12345.pdf",
        fileSize: 234567,
        mimeType: "application/pdf",
      }).success
    ).toBe(true);
  });
  it("rejects non-uuid patientId", () => {
    expect(
      createDocumentSchema.safeParse({ ...valid, patientId: "abc" }).success
    ).toBe(false);
  });
  it("rejects unknown document type", () => {
    expect(
      createDocumentSchema.safeParse({ ...valid, type: "PRESCRIPTION" as any }).success
    ).toBe(false);
  });
  it("rejects empty title (min 1)", () => {
    const r = createDocumentSchema.safeParse({ ...valid, title: "" });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => /Title is required/.test(i.message))).toBe(true);
    }
  });
  it("rejects non-integer fileSize", () => {
    expect(createDocumentSchema.safeParse({ ...valid, fileSize: 1024.5 }).success).toBe(false);
  });
  it("rejects negative fileSize", () => {
    expect(createDocumentSchema.safeParse({ ...valid, fileSize: -1 }).success).toBe(false);
  });
  it("accepts fileSize=0 (nonnegative boundary)", () => {
    expect(createDocumentSchema.safeParse({ ...valid, fileSize: 0 }).success).toBe(true);
  });
  it("accepts every DocumentTypeEnum value", () => {
    for (const t of [
      "LAB_REPORT",
      "IMAGING",
      "DISCHARGE_SUMMARY",
      "CONSENT",
      "INSURANCE",
      "REFERRAL_LETTER",
      "ID_PROOF",
      "OTHER",
    ] as const) {
      expect(createDocumentSchema.safeParse({ ...valid, type: t }).success).toBe(true);
    }
  });
});

// ───────────────────────────────────────────────────────
// Advance Directives
// ───────────────────────────────────────────────────────

describe("advanceDirectiveSchema", () => {
  const valid = {
    type: "DNR" as const,
    effectiveDate: "2026-05-01",
    notes: "Patient has discussed with family and care team",
  };
  it("accepts a minimal valid directive", () => {
    expect(advanceDirectiveSchema.safeParse(valid).success).toBe(true);
  });
  it("accepts a fully-populated directive", () => {
    expect(
      advanceDirectiveSchema.safeParse({
        ...valid,
        type: "LIVING_WILL",
        expiryDate: "2031-05-01",
        documentPath: "/uploads/directives/lw-12345.pdf",
        witnessedBy: "Dr. Iyer, Mr. Kapoor",
        notes: "Living will signed in presence of two witnesses",
      }).success
    ).toBe(true);
  });
  it("rejects unknown directive type", () => {
    expect(
      advanceDirectiveSchema.safeParse({ ...valid, type: "POLST" as any }).success
    ).toBe(false);
  });
  it("rejects missing effectiveDate (required)", () => {
    const { effectiveDate: _e, ...rest } = valid;
    expect(advanceDirectiveSchema.safeParse(rest).success).toBe(false);
  });
  it("rejects malformed effectiveDate", () => {
    expect(
      advanceDirectiveSchema.safeParse({ ...valid, effectiveDate: "May 1 2026" }).success
    ).toBe(false);
  });
  it("rejects malformed expiryDate", () => {
    expect(
      advanceDirectiveSchema.safeParse({ ...valid, expiryDate: "2031" }).success
    ).toBe(false);
  });
  it("rejects empty notes (min 1 — directives must be reasoned)", () => {
    const r = advanceDirectiveSchema.safeParse({ ...valid, notes: "" });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => /Notes are required/.test(i.message))).toBe(true);
    }
  });
  it("rejects missing notes", () => {
    const { notes: _n, ...rest } = valid;
    expect(advanceDirectiveSchema.safeParse(rest).success).toBe(false);
  });
  it("accepts every directive type", () => {
    for (const t of ["DNR", "DNI", "DNA", "LIVING_WILL", "ORGAN_DONATION", "OTHER"] as const) {
      expect(advanceDirectiveSchema.safeParse({ ...valid, type: t }).success).toBe(true);
    }
  });
});

describe("updateAdvanceDirectiveSchema", () => {
  it("accepts an empty patch (partial → all optional)", () => {
    expect(updateAdvanceDirectiveSchema.safeParse({}).success).toBe(true);
  });
  it("accepts an active-only patch (extension field)", () => {
    expect(updateAdvanceDirectiveSchema.safeParse({ active: false }).success).toBe(true);
  });
  it("accepts active=true", () => {
    expect(updateAdvanceDirectiveSchema.safeParse({ active: true }).success).toBe(true);
  });
  it("rejects non-boolean active", () => {
    expect(
      updateAdvanceDirectiveSchema.safeParse({ active: "yes" as any }).success
    ).toBe(false);
  });
  it("accepts a notes-only patch (partial drops min 1 — undefined is allowed)", () => {
    expect(
      updateAdvanceDirectiveSchema.safeParse({ notes: "Patient amended directive" }).success
    ).toBe(true);
  });
  it("rejects empty notes on update (partial keeps the min(1) refine when present)", () => {
    expect(updateAdvanceDirectiveSchema.safeParse({ notes: "" }).success).toBe(false);
  });
  it("rejects malformed effectiveDate on update", () => {
    expect(
      updateAdvanceDirectiveSchema.safeParse({ effectiveDate: "tomorrow" }).success
    ).toBe(false);
  });
  it("rejects unknown directive type on update", () => {
    expect(
      updateAdvanceDirectiveSchema.safeParse({ type: "POLST" as any }).success
    ).toBe(false);
  });
});

// ───────────────────────────────────────────────────────
// Medication Reconciliation — MedItem rows
// ───────────────────────────────────────────────────────

describe("MedItemSchema", () => {
  it("accepts a minimal med item with just name and stamps defaults", () => {
    const r = MedItemSchema.safeParse({ name: "Metformin" });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.dosage).toBe("");
      expect(r.data.frequency).toBe("");
      expect(r.data.route).toBe("");
      expect(r.data.continued).toBe(true);
      expect(r.data.notes).toBeUndefined();
    }
  });
  it("accepts a fully-populated med item", () => {
    const r = MedItemSchema.safeParse({
      name: "Atorvastatin",
      dosage: "20mg",
      frequency: "HS",
      route: "PO",
      continued: false,
      notes: "Discontinued due to myalgia",
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.continued).toBe(false);
      expect(r.data.dosage).toBe("20mg");
    }
  });
  it("rejects empty name (min 1)", () => {
    expect(MedItemSchema.safeParse({ name: "" }).success).toBe(false);
  });
  it("rejects missing name", () => {
    expect(MedItemSchema.safeParse({}).success).toBe(false);
  });
  it("rejects non-boolean continued", () => {
    expect(
      MedItemSchema.safeParse({ name: "X", continued: "yes" as any }).success
    ).toBe(false);
  });
  it("rejects non-string dosage", () => {
    expect(MedItemSchema.safeParse({ name: "X", dosage: 20 as any }).success).toBe(false);
  });
});

describe("medReconciliationSchema", () => {
  const valid = {
    patientId: UUID,
    reconciliationType: "ADMISSION" as const,
  };
  it("accepts a minimal valid record and stamps all array/object defaults", () => {
    const r = medReconciliationSchema.safeParse(valid);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.homeMedications).toEqual([]);
      expect(r.data.hospitalMedications).toEqual([]);
      expect(r.data.dischargeMedications).toEqual([]);
      expect(r.data.changes).toEqual({ added: [], removed: [], modified: [] });
      expect(r.data.patientCounseled).toBe(false);
    }
  });
  it("accepts a DISCHARGE reconciliation type", () => {
    expect(
      medReconciliationSchema.safeParse({ ...valid, reconciliationType: "DISCHARGE" }).success
    ).toBe(true);
  });
  it("rejects unknown reconciliationType", () => {
    expect(
      medReconciliationSchema.safeParse({
        ...valid,
        reconciliationType: "TRANSFER" as any,
      }).success
    ).toBe(false);
  });
  it("accepts an admissionId UUID linkage", () => {
    expect(
      medReconciliationSchema.safeParse({ ...valid, admissionId: UUID_2 }).success
    ).toBe(true);
  });
  it("accepts a dischargeId UUID linkage", () => {
    expect(
      medReconciliationSchema.safeParse({ ...valid, dischargeId: UUID_3 }).success
    ).toBe(true);
  });
  it("rejects non-uuid admissionId", () => {
    expect(
      medReconciliationSchema.safeParse({ ...valid, admissionId: "not-uuid" }).success
    ).toBe(false);
  });
  it("rejects non-uuid dischargeId", () => {
    expect(
      medReconciliationSchema.safeParse({ ...valid, dischargeId: "not-uuid" }).success
    ).toBe(false);
  });
  it("rejects non-uuid patientId", () => {
    expect(
      medReconciliationSchema.safeParse({ ...valid, patientId: "abc" }).success
    ).toBe(false);
  });
  it("accepts populated home/hospital/discharge medication arrays", () => {
    const r = medReconciliationSchema.safeParse({
      ...valid,
      homeMedications: [{ name: "Metformin", dosage: "500mg" }],
      hospitalMedications: [{ name: "Insulin sliding scale" }],
      dischargeMedications: [{ name: "Metformin", dosage: "1g", continued: true }],
      changes: { added: ["Lisinopril"], removed: [], modified: ["Metformin (dose ↑)"] },
      patientCounseled: true,
      notes: "Discussed with patient and family",
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.homeMedications).toHaveLength(1);
      expect(r.data.changes.added).toContain("Lisinopril");
      expect(r.data.patientCounseled).toBe(true);
    }
  });
  it("rejects an invalid med item nested in homeMedications", () => {
    expect(
      medReconciliationSchema.safeParse({
        ...valid,
        homeMedications: [{ name: "" }],
      }).success
    ).toBe(false);
  });
  it("rejects non-array homeMedications", () => {
    expect(
      medReconciliationSchema.safeParse({
        ...valid,
        homeMedications: "not-an-array" as any,
      }).success
    ).toBe(false);
  });
  it("rejects non-boolean patientCounseled", () => {
    expect(
      medReconciliationSchema.safeParse({
        ...valid,
        patientCounseled: "yes" as any,
      }).success
    ).toBe(false);
  });
  it("rejects non-string entries in changes.added", () => {
    expect(
      medReconciliationSchema.safeParse({
        ...valid,
        changes: { added: [42 as any], removed: [], modified: [] },
      }).success
    ).toBe(false);
  });
});

describe("updateMedReconciliationSchema", () => {
  it("accepts an empty patch (omit+partial → all optional)", () => {
    expect(updateMedReconciliationSchema.safeParse({}).success).toBe(true);
  });
  it("accepts a single-field patch (patientCounseled only)", () => {
    expect(
      updateMedReconciliationSchema.safeParse({ patientCounseled: true }).success
    ).toBe(true);
  });
  it("accepts a notes-only patch", () => {
    expect(
      updateMedReconciliationSchema.safeParse({ notes: "Re-counseled at bedside" }).success
    ).toBe(true);
  });
  it("strips patientId silently (omit()'d at schema level)", () => {
    const r = updateMedReconciliationSchema.safeParse({ patientId: UUID_2 } as any);
    expect(r.success).toBe(true);
    if (r.success) expect((r.data as any).patientId).toBeUndefined();
  });
  it("rejects unknown reconciliationType on update", () => {
    expect(
      updateMedReconciliationSchema.safeParse({
        reconciliationType: "TRANSFER" as any,
      }).success
    ).toBe(false);
  });
  it("rejects invalid nested med item on update", () => {
    expect(
      updateMedReconciliationSchema.safeParse({
        homeMedications: [{ name: "" }],
      }).success
    ).toBe(false);
  });
});

// ───────────────────────────────────────────────────────
// Problem List Filter
// ───────────────────────────────────────────────────────

describe("problemListFilterSchema", () => {
  it("accepts an empty filter (all fields optional)", () => {
    expect(problemListFilterSchema.safeParse({}).success).toBe(true);
  });
  it("accepts each canonical type filter", () => {
    for (const t of ["condition", "allergy", "diagnosis", "admission"] as const) {
      expect(problemListFilterSchema.safeParse({ type: t }).success).toBe(true);
    }
  });
  it("rejects unknown type filter", () => {
    expect(
      problemListFilterSchema.safeParse({ type: "vital" as any }).success
    ).toBe(false);
  });
  it("coerces string 'true' to boolean true (z.coerce.boolean)", () => {
    const r = problemListFilterSchema.safeParse({ activeOnly: "true" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.activeOnly).toBe(true);
  });
  it("coerces empty string to false (z.coerce.boolean semantics)", () => {
    const r = problemListFilterSchema.safeParse({ activeOnly: "" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.activeOnly).toBe(false);
  });
  it("coerces non-empty string 'false' to true (truthy-string coercion)", () => {
    // z.coerce.boolean uses JS Boolean() — any non-empty string is truthy,
    // INCLUDING the literal string "false". Asserting the actual behavior
    // so the contract is locked, not an idealized expectation.
    const r = problemListFilterSchema.safeParse({ activeOnly: "false" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.activeOnly).toBe(true);
  });
  it("accepts true boolean directly", () => {
    const r = problemListFilterSchema.safeParse({ activeOnly: true });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.activeOnly).toBe(true);
  });
  it("accepts both filters together", () => {
    const r = problemListFilterSchema.safeParse({ activeOnly: "true", type: "allergy" });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.activeOnly).toBe(true);
      expect(r.data.type).toBe("allergy");
    }
  });
});
