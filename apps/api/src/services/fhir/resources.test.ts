import { describe, it, expect } from "vitest";
import {
  patientToFhir,
  doctorToFhir,
  appointmentToFhir,
  consultationToEncounter,
  consultationToComposition,
  prescriptionToMedicationRequests,
  labOrderToServiceRequest,
  labOrderToDiagnosticReport,
  labResultToObservation,
  allergyToFhir,
  SYSTEMS,
} from "./resources";
import { toSearchsetBundle, toTransactionBundle } from "./bundle";
import { validateResource, validateBundle } from "./validator";

// ─── Fixtures (shape-compatible with Prisma outputs) ────────────────────────

const fixturePatient = {
  id: "pat-001",
  mrNumber: "MR-12345",
  dateOfBirth: new Date("1985-06-15"),
  gender: "MALE",
  address: "12 Park Street, Kolkata",
  abhaId: "14-1234-5678-9012",
  aadhaarMasked: "XXXX-XXXX-1234",
  updatedAt: new Date("2026-04-20T10:00:00Z"),
  user: {
    name: "Arjun Kumar Sharma",
    phone: "+919876543210",
    email: "arjun@example.com",
    isActive: true,
  },
};

const fixtureDoctor = {
  id: "doc-001",
  specialization: "Cardiology",
  qualification: "MBBS, MD",
  user: {
    name: "Priya Iyer",
    phone: "+919000000001",
    email: "priya@hosp.com",
    isActive: true,
  },
};

const fixtureAppointment = {
  id: "appt-001",
  patientId: "pat-001",
  doctorId: "doc-001",
  date: new Date("2026-04-22"),
  slotStart: "10:30",
  slotEnd: "10:45",
  type: "CONSULTATION",
  status: "BOOKED",
  priority: "NORMAL",
  notes: "Follow-up visit",
};

const fixtureConsultation = {
  id: "cons-001",
  appointmentId: "appt-001",
  doctorId: "doc-001",
  notes: "Patient reports chest pain improving.",
  findings: "Vitals stable. No murmurs.",
  createdAt: new Date("2026-04-22T10:30:00Z"),
  updatedAt: new Date("2026-04-22T11:00:00Z"),
  appointment: {
    patientId: "pat-001",
    doctorId: "doc-001",
    consultationStartedAt: new Date("2026-04-22T10:32:00Z"),
    consultationEndedAt: new Date("2026-04-22T10:58:00Z"),
  },
};

const fixturePrescription = {
  id: "rx-001",
  patientId: "pat-001",
  doctorId: "doc-001",
  appointmentId: "appt-001",
  diagnosis: "Hypertension",
  createdAt: new Date("2026-04-22T11:00:00Z"),
  items: [
    {
      id: "item-1",
      medicineName: "Telmisartan 40mg",
      dosage: "1 tablet",
      frequency: "Once daily",
      duration: "30 days",
      refills: 2,
    },
    {
      id: "item-2",
      medicineName: "Aspirin 75mg",
      dosage: "1 tablet",
      frequency: "Once daily",
      duration: "30 days",
      refills: 0,
    },
  ],
};

const fixtureLabOrder = {
  id: "lo-001",
  patientId: "pat-001",
  doctorId: "doc-001",
  status: "COMPLETED",
  priority: "URGENT",
  orderedAt: new Date("2026-04-22T11:05:00Z"),
  collectedAt: new Date("2026-04-22T11:30:00Z"),
  completedAt: new Date("2026-04-22T14:00:00Z"),
  items: [
    {
      id: "loi-1",
      test: { code: "CBC", name: "Complete Blood Count" },
      results: [
        {
          id: "res-1",
          parameter: "Hemoglobin",
          value: "13.5",
          unit: "g/dL",
          normalRange: "13.0-17.0",
          flag: "NORMAL",
          reportedAt: new Date("2026-04-22T14:00:00Z"),
          verifiedAt: new Date("2026-04-22T14:10:00Z"),
        },
        {
          id: "res-2",
          parameter: "WBC Count",
          value: "15000",
          unit: "cells/µL",
          normalRange: "4000-11000",
          flag: "HIGH",
          reportedAt: new Date("2026-04-22T14:00:00Z"),
          verifiedAt: null,
        },
      ],
    },
  ],
};

const fixtureAllergy = {
  id: "allergy-001",
  patientId: "pat-001",
  allergen: "Penicillin",
  severity: "SEVERE",
  reaction: "Anaphylaxis",
  notedAt: new Date("2023-03-15T09:00:00Z"),
};

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("patientToFhir", () => {
  it("produces a schema-compliant Patient resource with all identifiers", () => {
    const fhir = patientToFhir(fixturePatient);

    expect(fhir.resourceType).toBe("Patient");
    expect(fhir.id).toBe("pat-001");
    expect(fhir.gender).toBe("male");
    expect(fhir.birthDate).toBe("1985-06-15");
    expect(fhir.name[0].family).toBe("Sharma");
    expect(fhir.name[0].given).toEqual(["Arjun", "Kumar"]);

    // MR number, ABHA, Aadhaar — three identifiers
    expect(fhir.identifier).toHaveLength(3);
    const mr = fhir.identifier.find((i) => i.system === SYSTEMS.MR_NUMBER);
    expect(mr?.value).toBe("MR-12345");
    const abha = fhir.identifier.find((i) => i.system === SYSTEMS.ABHA);
    expect(abha?.value).toBe("14-1234-5678-9012");

    // Telecom — phone + email
    expect(fhir.telecom).toHaveLength(2);
    expect(fhir.telecom?.[0]).toEqual({ system: "phone", value: "+919876543210", use: "mobile" });

    // Validator acceptance
    expect(validateResource(fhir).valid).toBe(true);
  });

  it("maps gender OTHER and unknown correctly", () => {
    const other = patientToFhir({ ...fixturePatient, gender: "OTHER" });
    expect(other.gender).toBe("other");
    const unknown = patientToFhir({ ...fixturePatient, gender: undefined });
    expect(unknown.gender).toBe("unknown");
  });

  it("throws when id is missing", () => {
    expect(() => patientToFhir({ mrNumber: "x" })).toThrow(/missing patient.id/);
  });
});

describe("doctorToFhir", () => {
  it("produces a Practitioner with qualification and 'Dr.' prefix", () => {
    const fhir = doctorToFhir(fixtureDoctor);
    expect(fhir.resourceType).toBe("Practitioner");
    expect(fhir.name[0].text).toBe("Dr. Priya Iyer");
    expect(fhir.qualification?.[0].code.text).toBe("MBBS, MD");
    expect(fhir.qualification?.[0].code.coding?.[0].display).toBe("Cardiology");
    expect(validateResource(fhir).valid).toBe(true);
  });
});

describe("appointmentToFhir", () => {
  it("maps status + priority + slot times", () => {
    const fhir = appointmentToFhir(fixtureAppointment);
    expect(fhir.resourceType).toBe("Appointment");
    expect(fhir.status).toBe("booked");
    expect(fhir.priority).toBe(5);
    expect(fhir.participant).toHaveLength(2);
    expect(fhir.participant[0].actor.reference).toBe("Patient/pat-001");
    expect(fhir.participant[1].actor.reference).toBe("Practitioner/doc-001");
    // start is an ISO instant; exact wall-clock depends on server TZ
    expect(fhir.start).toMatch(/^2026-04-2[12]T\d{2}:\d{2}:\d{2}/);
    expect(validateResource(fhir).valid).toBe(true);
  });

  it("maps NO_SHOW and CANCELLED correctly", () => {
    expect(appointmentToFhir({ ...fixtureAppointment, status: "NO_SHOW" }).status).toBe("noshow");
    expect(appointmentToFhir({ ...fixtureAppointment, status: "CANCELLED" }).status).toBe("cancelled");
    expect(appointmentToFhir({ ...fixtureAppointment, status: "COMPLETED" }).status).toBe("fulfilled");
  });
});

describe("consultationToEncounter + consultationToComposition", () => {
  it("produces Encounter with subject/participant/period", () => {
    const enc = consultationToEncounter(fixtureConsultation);
    expect(enc.resourceType).toBe("Encounter");
    expect(enc.status).toBe("finished");
    expect(enc.subject.reference).toBe("Patient/pat-001");
    expect(enc.participant?.[0].individual.reference).toBe("Practitioner/doc-001");
    expect(enc.class.code).toBe("AMB");
    expect(enc.period?.start).toBeDefined();
    expect(enc.period?.end).toBeDefined();
    expect(validateResource(enc).valid).toBe(true);
  });

  it("produces Composition with LOINC consult note coding", () => {
    const comp = consultationToComposition(fixtureConsultation);
    expect(comp.resourceType).toBe("Composition");
    expect(comp.type.coding?.[0].code).toBe("11488-4");
    expect(comp.subject.reference).toBe("Patient/pat-001");
    expect(comp.encounter?.reference).toBe("Encounter/cons-001");
    expect(comp.author[0].reference).toBe("Practitioner/doc-001");
    expect(comp.section?.length ?? 0).toBeGreaterThanOrEqual(2);
    // findings contains no XML-dangerous chars but section div should still be wrapped
    expect(comp.section?.[0].text?.div).toContain("<div");
    expect(validateResource(comp).valid).toBe(true);
  });

  it("throws when appointment relation is missing for Composition", () => {
    expect(() =>
      consultationToComposition({ id: "c-x", doctorId: "d-x", appointment: null })
    ).toThrow(/requires appointment include/);
  });
});

describe("prescriptionToMedicationRequests", () => {
  it("produces one MedicationRequest per item with refills mapped", () => {
    const mrs = prescriptionToMedicationRequests(fixturePrescription);
    expect(mrs).toHaveLength(2);

    const first = mrs[0];
    expect(first.resourceType).toBe("MedicationRequest");
    expect(first.medicationCodeableConcept.text).toBe("Telmisartan 40mg");
    expect(first.status).toBe("active");
    expect(first.intent).toBe("order");
    expect(first.subject.reference).toBe("Patient/pat-001");
    expect(first.requester?.reference).toBe("Practitioner/doc-001");
    expect(first.dispenseRequest?.numberOfRepeatsAllowed).toBe(2);
    expect(first.dosageInstruction?.[0].text).toContain("Once daily");

    // Second item has 0 refills — dispenseRequest should be omitted
    expect(mrs[1].dispenseRequest).toBeUndefined();

    for (const mr of mrs) expect(validateResource(mr).valid).toBe(true);
  });
});

describe("labOrderToServiceRequest + labResultToObservation + labOrderToDiagnosticReport", () => {
  it("ServiceRequest maps priority and status correctly", () => {
    const sr = labOrderToServiceRequest(fixtureLabOrder);
    expect(sr.resourceType).toBe("ServiceRequest");
    expect(sr.status).toBe("completed");
    expect(sr.priority).toBe("urgent");
    expect(sr.code.coding?.[0].code).toBe("CBC");
    expect(sr.code.text).toBe("Complete Blood Count");
    expect(sr.subject.reference).toBe("Patient/pat-001");
    expect(validateResource(sr).valid).toBe(true);
  });

  it("Observation uses valueQuantity when numeric + unit are present", () => {
    const item = fixtureLabOrder.items[0];
    const obs = labResultToObservation(item.results[0], {
      patientId: "pat-001",
      testCode: item.test.code,
      testName: item.test.name,
    });
    expect(obs.valueQuantity?.value).toBe(13.5);
    expect(obs.valueQuantity?.unit).toBe("g/dL");
    expect(obs.status).toBe("final");
    expect(obs.interpretation?.[0].coding?.[0].code).toBe("N");
    expect(validateResource(obs).valid).toBe(true);
  });

  it("Observation uses valueString when value is non-numeric", () => {
    const obs = labResultToObservation(
      { id: "r-x", parameter: "Culture", value: "E. coli present", unit: null, reportedAt: new Date() },
      { patientId: "pat-001" }
    );
    expect(obs.valueString).toBe("E. coli present");
    expect(obs.valueQuantity).toBeUndefined();
    expect(obs.status).toBe("preliminary"); // no verifiedAt
  });

  it("Observation flags HIGH interpretation correctly", () => {
    const item = fixtureLabOrder.items[0];
    const obs = labResultToObservation(item.results[1], { patientId: "pat-001" });
    expect(obs.interpretation?.[0].coding?.[0].code).toBe("H");
  });

  it("DiagnosticReport references the ServiceRequest and result Observations", () => {
    const report = labOrderToDiagnosticReport(fixtureLabOrder, ["res-1", "res-2"]);
    expect(report.resourceType).toBe("DiagnosticReport");
    expect(report.status).toBe("final");
    expect(report.basedOn?.[0].reference).toBe("ServiceRequest/lo-001");
    expect(report.result).toHaveLength(2);
    expect(report.result?.[0].reference).toBe("Observation/res-1");
    expect(validateResource(report).valid).toBe(true);
  });
});

describe("allergyToFhir", () => {
  it("maps severity SEVERE → criticality high + reaction severe", () => {
    const ai = allergyToFhir(fixtureAllergy);
    expect(ai.resourceType).toBe("AllergyIntolerance");
    expect(ai.criticality).toBe("high");
    expect(ai.reaction?.[0].severity).toBe("severe");
    expect(ai.patient.reference).toBe("Patient/pat-001");
    expect(ai.code?.text).toBe("Penicillin");
    expect(validateResource(ai).valid).toBe(true);
  });

  it("defaults to low/mild when severity unknown", () => {
    const ai = allergyToFhir({ ...fixtureAllergy, severity: undefined, reaction: null });
    expect(ai.criticality).toBe("low");
    expect(ai.reaction).toBeUndefined(); // no reaction text → no reaction entry
  });
});

describe("Bundle helpers", () => {
  it("toSearchsetBundle wraps resources with urn:uuid fullUrls", () => {
    const bundle = toSearchsetBundle([patientToFhir(fixturePatient), doctorToFhir(fixtureDoctor)]);
    expect(bundle.resourceType).toBe("Bundle");
    expect(bundle.type).toBe("searchset");
    expect(bundle.total).toBe(2);
    expect(bundle.entry[0].fullUrl).toMatch(/^urn:uuid:Patient-pat-001$/);
    expect(bundle.entry[1].fullUrl).toMatch(/^urn:uuid:Practitioner-doc-001$/);
    expect(validateBundle(bundle).valid).toBe(true);
  });

  it("toTransactionBundle adds PUT requests for each entry", () => {
    const bundle = toTransactionBundle([patientToFhir(fixturePatient)]);
    expect(bundle.type).toBe("transaction");
    expect(bundle.entry[0].request).toEqual({ method: "PUT", url: "Patient/pat-001" });
  });
});

describe("Validator", () => {
  it("rejects a Patient with invalid gender", () => {
    const bad = patientToFhir(fixturePatient);
    (bad as any).gender = "helicopter";
    const result = validateResource(bad);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.path === "gender")).toBe(true);
  });

  it("rejects a Patient with malformed birthDate", () => {
    const bad = patientToFhir(fixturePatient);
    (bad as any).birthDate = "not-a-date";
    const result = validateResource(bad);
    expect(result.valid).toBe(false);
  });

  it("flags malformed reference in Encounter.subject", () => {
    const bad = consultationToEncounter(fixtureConsultation);
    (bad as any).subject = { reference: "not a ref!" };
    const result = validateResource(bad);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.path.includes("subject"))).toBe(true);
  });
});
