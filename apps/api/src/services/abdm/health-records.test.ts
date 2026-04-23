import { describe, it, expect } from "vitest";
import {
  buildOPConsultationBundle,
  buildDischargeSummaryBundle,
  buildDiagnosticReportBundle,
} from "./health-records";

describe("buildOPConsultationBundle", () => {
  it("produces a FHIR R4 document bundle with Composition + Condition + MedicationRequests", () => {
    const bundle = buildOPConsultationBundle({
      patientName: "Jane Doe",
      patientAbha: "jane@sbx",
      chiefComplaint: "Headache x 3 days",
      diagnosis: "Migraine without aura",
      medications: [
        { name: "Sumatriptan", dose: "50mg", frequency: "PRN", duration: "30d" },
      ],
      doctorName: "Dr. Smith",
      visitDate: new Date("2026-04-23T10:00:00Z"),
    });

    expect(bundle.resourceType).toBe("Bundle");
    expect(bundle.type).toBe("document");
    expect(bundle.meta.profile[0]).toContain("OPConsultRecord");

    const types = bundle.entry.map((e) => (e.resource as any).resourceType);
    expect(types).toContain("Composition");
    expect(types).toContain("Condition");
    expect(types.filter((t) => t === "MedicationRequest")).toHaveLength(1);

    // Composition must be the first entry.
    expect((bundle.entry[0].resource as any).resourceType).toBe("Composition");
  });

  it("includes the patient's ABHA identifier in the Composition subject", () => {
    const bundle = buildOPConsultationBundle({
      patientName: "Jane Doe",
      patientAbha: "jane@sbx",
      chiefComplaint: "c/o",
      diagnosis: "dx",
      medications: [],
      doctorName: "doc",
      visitDate: new Date(),
    });
    const comp = bundle.entry[0].resource as any;
    expect(comp.subject.identifier.value).toBe("jane@sbx");
    expect(comp.subject.identifier.system).toContain("abdm.gov.in");
  });
});

describe("buildDischargeSummaryBundle", () => {
  it("contains Encounter + discharge Condition + Procedure + MedicationStatement entries", () => {
    const bundle = buildDischargeSummaryBundle({
      patientName: "John Roe",
      patientAbha: "john@sbx",
      admittingDiagnosis: "Chest pain",
      dischargeDiagnosis: "Stable angina",
      proceduresPerformed: ["Coronary angiography"],
      medicationsOnDischarge: ["Aspirin 75mg OD", "Atorvastatin 40mg HS"],
      admissionDate: new Date("2026-04-20T08:00:00Z"),
      dischargeDate: new Date("2026-04-23T14:00:00Z"),
      doctorName: "Dr. Smith",
    });

    const types = bundle.entry.map((e) => (e.resource as any).resourceType);
    expect(types).toContain("Encounter");
    expect(types).toContain("Condition");
    expect(types).toContain("Procedure");
    expect(types.filter((t) => t === "MedicationStatement")).toHaveLength(2);

    const encounter = bundle.entry.find(
      (e) => (e.resource as any).resourceType === "Encounter"
    )!.resource as any;
    expect(encounter.class.code).toBe("IMP");
    expect(encounter.period.start).toBeDefined();
    expect(encounter.period.end).toBeDefined();
  });
});

describe("buildDiagnosticReportBundle", () => {
  it("emits a DiagnosticReport with Observation entries", () => {
    const bundle = buildDiagnosticReportBundle({
      patientName: "Jane Doe",
      patientAbha: "jane@sbx",
      reportName: "CBC",
      conclusion: "Within normal limits",
      observations: [
        { code: "Hemoglobin", value: "14.2", unit: "g/dL" },
        { code: "WBC Morphology", value: "Normal" },
      ],
      reportDate: new Date("2026-04-23T09:00:00Z"),
      orderedBy: "Dr. Smith",
    });

    const types = bundle.entry.map((e) => (e.resource as any).resourceType);
    expect(types.filter((t) => t === "DiagnosticReport")).toHaveLength(1);
    expect(types.filter((t) => t === "Observation")).toHaveLength(2);

    const obsQuantitative = (bundle.entry.find(
      (e) => (e.resource as any).resourceType === "Observation" && (e.resource as any).valueQuantity
    )!.resource as any).valueQuantity;
    expect(obsQuantitative.value).toBeCloseTo(14.2);
    expect(obsQuantitative.unit).toBe("g/dL");

    const obsQualitative = bundle.entry.find(
      (e) => (e.resource as any).resourceType === "Observation" && (e.resource as any).valueString
    )!.resource as any;
    expect(obsQualitative.valueString).toBe("Normal");
  });
});
