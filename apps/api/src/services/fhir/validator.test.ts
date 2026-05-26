// Unit tests for the FHIR R4 validator (apps/api/src/services/fhir/validator.ts).
//
// `validator.ts` is pure logic (no Prisma, no I/O, no network) — these tests are
// entirely in-memory and synthesise FHIR resources inline. The validator is
// hand-rolled to catch the common shape bugs that break ABDM/NDHM ingestion:
// missing resourceType/id, invalid status enums, malformed Reference strings.
//
// Coverage targets: validateResource, validateBundle, assertValidResource,
// assertValidBundle, and every per-resource-type branch (Patient, Practitioner,
// Appointment, Encounter, Composition, MedicationRequest, ServiceRequest,
// Observation, DiagnosticReport, AllergyIntolerance), plus the unknown-type
// warning path.

import { describe, it, expect } from "vitest";
import {
  validateResource,
  validateBundle,
  assertValidResource,
  assertValidBundle,
} from "./validator";

// ─── Fixture helpers (return minimal-valid FHIR R4 shapes) ──────────────────

function validPatient() {
  return {
    resourceType: "Patient",
    id: "pat-1",
    identifier: [{ system: "https://hospital.example/mr", value: "MR-1" }],
    name: [{ use: "official", text: "Asha Reddy", given: ["Asha"], family: "Reddy" }],
    gender: "female",
    birthDate: "1990-05-12",
  };
}

function validPractitioner() {
  return {
    resourceType: "Practitioner",
    id: "doc-1",
    identifier: [{ system: "https://hospital.example/staff", value: "S-1" }],
    name: [{ text: "Dr. Priya Iyer" }],
  };
}

function validAppointment() {
  return {
    resourceType: "Appointment",
    id: "appt-1",
    status: "booked",
    participant: [
      { actor: { reference: "Patient/pat-1" }, status: "accepted" },
      { actor: { reference: "Practitioner/doc-1" }, status: "accepted" },
    ],
  };
}

function validEncounter() {
  return {
    resourceType: "Encounter",
    id: "enc-1",
    status: "finished",
    class: { system: "http://terminology.hl7.org/CodeSystem/v3-ActCode", code: "AMB" },
    subject: { reference: "Patient/pat-1" },
  };
}

function validComposition() {
  return {
    resourceType: "Composition",
    id: "comp-1",
    status: "final",
    type: { text: "Discharge Summary" },
    subject: { reference: "Patient/pat-1" },
    date: "2026-04-22T10:30:00Z",
    author: [{ reference: "Practitioner/doc-1" }],
    title: "Discharge Summary",
  };
}

function validMedicationRequest() {
  return {
    resourceType: "MedicationRequest",
    id: "rx-1",
    status: "active",
    intent: "order",
    medicationCodeableConcept: { text: "Paracetamol 500mg" },
    subject: { reference: "Patient/pat-1" },
  };
}

function validServiceRequest() {
  return {
    resourceType: "ServiceRequest",
    id: "svc-1",
    status: "active",
    intent: "order",
    code: { text: "CBC" },
    subject: { reference: "Patient/pat-1" },
  };
}

function validObservation() {
  return {
    resourceType: "Observation",
    id: "obs-1",
    status: "final",
    code: { coding: [{ system: "http://loinc.org", code: "8867-4" }] },
    subject: { reference: "Patient/pat-1" },
  };
}

function validDiagnosticReport() {
  return {
    resourceType: "DiagnosticReport",
    id: "dr-1",
    status: "final",
    code: { text: "Lab Panel" },
    subject: { reference: "Patient/pat-1" },
  };
}

function validAllergyIntolerance() {
  return {
    resourceType: "AllergyIntolerance",
    id: "al-1",
    patient: { reference: "Patient/pat-1" },
    criticality: "high",
  };
}

// ─── validateResource — top-level guards ─────────────────────────────────────

describe("validateResource — top-level structural guards", () => {
  it("rejects non-object inputs (null)", () => {
    const result = validateResource(null);
    expect(result.valid).toBe(false);
    expect(result.issues).toContainEqual({
      severity: "error",
      path: "$",
      message: "Resource must be an object",
    });
  });

  it("rejects non-object inputs (string)", () => {
    const result = validateResource("not-an-object");
    expect(result.valid).toBe(false);
    expect(result.issues[0].path).toBe("$");
  });

  it("rejects undefined", () => {
    const result = validateResource(undefined);
    expect(result.valid).toBe(false);
  });

  it("flags missing resourceType", () => {
    const result = validateResource({ id: "x" });
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.path === "resourceType")).toBe(true);
  });

  it("flags missing id", () => {
    const result = validateResource({ ...validPatient(), id: "" });
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.path === "id")).toBe(true);
  });

  it("emits a warning (not an error) for unknown resourceType", () => {
    const result = validateResource({ resourceType: "Foo", id: "x" });
    // Warning does NOT invalidate
    expect(result.valid).toBe(true);
    expect(result.issues.some((i) => i.severity === "warning" && i.path === "resourceType")).toBe(true);
  });
});

// ─── Patient ────────────────────────────────────────────────────────────────

describe("validateResource — Patient", () => {
  it("passes a valid Patient", () => {
    const result = validateResource(validPatient());
    expect(result.valid).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it("rejects Patient missing identifier", () => {
    const p = validPatient();
    delete (p as any).identifier;
    const result = validateResource(p);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.path === "identifier")).toBe(true);
  });

  it("rejects Patient with empty identifier array", () => {
    const p = { ...validPatient(), identifier: [] };
    const result = validateResource(p);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.path === "identifier")).toBe(true);
  });

  it("rejects Patient missing name", () => {
    const p = validPatient();
    delete (p as any).name;
    const result = validateResource(p);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.path === "name")).toBe(true);
  });

  it("rejects Patient with invalid gender", () => {
    const p = { ...validPatient(), gender: "M" };
    const result = validateResource(p);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.path === "gender")).toBe(true);
  });

  it("accepts all canonical gender values", () => {
    for (const gender of ["male", "female", "other", "unknown"]) {
      const result = validateResource({ ...validPatient(), gender });
      expect(result.valid).toBe(true);
    }
  });

  it("rejects malformed birthDate", () => {
    const result = validateResource({ ...validPatient(), birthDate: "12/05/1990" });
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.path === "birthDate")).toBe(true);
  });

  it("allows missing birthDate (optional)", () => {
    const p = validPatient();
    delete (p as any).birthDate;
    const result = validateResource(p);
    expect(result.valid).toBe(true);
  });
});

// ─── Practitioner ───────────────────────────────────────────────────────────

describe("validateResource — Practitioner", () => {
  it("passes a valid Practitioner", () => {
    expect(validateResource(validPractitioner()).valid).toBe(true);
  });

  it("rejects Practitioner missing identifier", () => {
    const p = validPractitioner();
    delete (p as any).identifier;
    const result = validateResource(p);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.path === "identifier")).toBe(true);
  });

  it("rejects Practitioner missing name", () => {
    const p = validPractitioner();
    delete (p as any).name;
    const result = validateResource(p);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.path === "name")).toBe(true);
  });
});

// ─── Appointment ────────────────────────────────────────────────────────────

describe("validateResource — Appointment", () => {
  it("passes a valid Appointment", () => {
    expect(validateResource(validAppointment()).valid).toBe(true);
  });

  it("rejects Appointment with invalid status", () => {
    const result = validateResource({ ...validAppointment(), status: "scheduled" });
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.path === "status")).toBe(true);
  });

  it("rejects Appointment with empty participant array", () => {
    const result = validateResource({ ...validAppointment(), participant: [] });
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.path === "participant")).toBe(true);
  });

  it("rejects Appointment with malformed participant actor reference", () => {
    const a = validAppointment();
    a.participant = [{ actor: { reference: "not a valid ref!" }, status: "accepted" }];
    const result = validateResource(a);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.path.startsWith("participant[0].actor"))).toBe(true);
  });

  it("rejects Appointment with missing actor on participant", () => {
    const a = validAppointment();
    a.participant = [{ status: "accepted" } as any];
    const result = validateResource(a);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.path.startsWith("participant[0].actor"))).toBe(true);
  });
});

// ─── Encounter ──────────────────────────────────────────────────────────────

describe("validateResource — Encounter", () => {
  it("passes a valid Encounter", () => {
    expect(validateResource(validEncounter()).valid).toBe(true);
  });

  it("rejects Encounter with invalid status", () => {
    const result = validateResource({ ...validEncounter(), status: "done" });
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.path === "status")).toBe(true);
  });

  it("rejects Encounter missing class.code", () => {
    const e = validEncounter();
    delete (e as any).class;
    const result = validateResource(e);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.path === "class.code")).toBe(true);
  });

  it("rejects Encounter with malformed subject reference", () => {
    const result = validateResource({ ...validEncounter(), subject: { reference: "?!" } });
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.path.startsWith("subject"))).toBe(true);
  });
});

// ─── Composition ────────────────────────────────────────────────────────────

describe("validateResource — Composition", () => {
  it("passes a valid Composition", () => {
    expect(validateResource(validComposition()).valid).toBe(true);
  });

  it("rejects Composition with invalid status", () => {
    const result = validateResource({ ...validComposition(), status: "draft" });
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.path === "status")).toBe(true);
  });

  it("rejects Composition missing type", () => {
    const c = validComposition();
    delete (c as any).type;
    const result = validateResource(c);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.path === "type")).toBe(true);
  });

  it("rejects Composition missing date", () => {
    const c = validComposition();
    delete (c as any).date;
    const result = validateResource(c);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.path === "date")).toBe(true);
  });

  it("rejects Composition with empty author", () => {
    const result = validateResource({ ...validComposition(), author: [] });
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.path === "author")).toBe(true);
  });

  it("rejects Composition missing title", () => {
    const c = validComposition();
    delete (c as any).title;
    const result = validateResource(c);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.path === "title")).toBe(true);
  });
});

// ─── MedicationRequest ──────────────────────────────────────────────────────

describe("validateResource — MedicationRequest", () => {
  it("passes a valid MedicationRequest", () => {
    expect(validateResource(validMedicationRequest()).valid).toBe(true);
  });

  it("rejects MedicationRequest with invalid status", () => {
    const result = validateResource({ ...validMedicationRequest(), status: "ordered" });
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.path === "status")).toBe(true);
  });

  it("rejects MedicationRequest missing intent", () => {
    const m = validMedicationRequest();
    delete (m as any).intent;
    const result = validateResource(m);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.path === "intent")).toBe(true);
  });

  it("rejects MedicationRequest missing both text and coding on medicationCodeableConcept", () => {
    const result = validateResource({
      ...validMedicationRequest(),
      medicationCodeableConcept: {},
    });
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.path === "medicationCodeableConcept")).toBe(true);
  });

  it("accepts MedicationRequest with coding (no text)", () => {
    const result = validateResource({
      ...validMedicationRequest(),
      medicationCodeableConcept: { coding: [{ system: "http://snomed.info/sct", code: "387517004" }] },
    });
    expect(result.valid).toBe(true);
  });

  it("rejects MedicationRequest with malformed subject reference", () => {
    const result = validateResource({ ...validMedicationRequest(), subject: { reference: "" } });
    expect(result.valid).toBe(false);
  });
});

// ─── ServiceRequest ─────────────────────────────────────────────────────────

describe("validateResource — ServiceRequest", () => {
  it("passes a valid ServiceRequest", () => {
    expect(validateResource(validServiceRequest()).valid).toBe(true);
  });

  it("rejects ServiceRequest with invalid status", () => {
    const result = validateResource({ ...validServiceRequest(), status: "done" });
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.path === "status")).toBe(true);
  });

  it("rejects ServiceRequest missing intent", () => {
    const s = validServiceRequest();
    delete (s as any).intent;
    const result = validateResource(s);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.path === "intent")).toBe(true);
  });

  it("rejects ServiceRequest missing code text and coding", () => {
    const result = validateResource({ ...validServiceRequest(), code: {} });
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.path === "code")).toBe(true);
  });
});

// ─── Observation ────────────────────────────────────────────────────────────

describe("validateResource — Observation", () => {
  it("passes a valid Observation", () => {
    expect(validateResource(validObservation()).valid).toBe(true);
  });

  it("rejects Observation with invalid status", () => {
    const result = validateResource({ ...validObservation(), status: "draft" });
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.path === "status")).toBe(true);
  });

  it("rejects Observation missing code", () => {
    const result = validateResource({ ...validObservation(), code: {} });
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.path === "code")).toBe(true);
  });

  it("accepts Observation with code.text only", () => {
    const result = validateResource({
      ...validObservation(),
      code: { text: "Systolic BP" },
    });
    expect(result.valid).toBe(true);
  });

  it("rejects Observation with malformed subject reference", () => {
    const result = validateResource({ ...validObservation(), subject: { reference: "<bad>" } });
    expect(result.valid).toBe(false);
  });
});

// ─── DiagnosticReport ───────────────────────────────────────────────────────

describe("validateResource — DiagnosticReport", () => {
  it("passes a valid DiagnosticReport", () => {
    expect(validateResource(validDiagnosticReport()).valid).toBe(true);
  });

  it("rejects DiagnosticReport with invalid status", () => {
    const result = validateResource({ ...validDiagnosticReport(), status: "done" });
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.path === "status")).toBe(true);
  });

  it("rejects DiagnosticReport missing code", () => {
    const result = validateResource({ ...validDiagnosticReport(), code: {} });
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.path === "code")).toBe(true);
  });
});

// ─── AllergyIntolerance ─────────────────────────────────────────────────────

describe("validateResource — AllergyIntolerance", () => {
  it("passes a valid AllergyIntolerance", () => {
    expect(validateResource(validAllergyIntolerance()).valid).toBe(true);
  });

  it("rejects AllergyIntolerance missing patient reference", () => {
    const a = validAllergyIntolerance();
    delete (a as any).patient;
    const result = validateResource(a);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.path.startsWith("patient"))).toBe(true);
  });

  it("rejects AllergyIntolerance with invalid criticality", () => {
    const result = validateResource({ ...validAllergyIntolerance(), criticality: "extreme" });
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.path === "criticality")).toBe(true);
  });

  it("accepts AllergyIntolerance with no criticality (optional)", () => {
    const a = validAllergyIntolerance();
    delete (a as any).criticality;
    expect(validateResource(a).valid).toBe(true);
  });

  it("accepts all canonical criticality values", () => {
    for (const criticality of ["low", "high", "unable-to-assess"]) {
      expect(validateResource({ ...validAllergyIntolerance(), criticality }).valid).toBe(true);
    }
  });
});

// ─── Reference regex coverage ───────────────────────────────────────────────

describe("validateReference (via Encounter.subject)", () => {
  it("accepts ResourceType/id form", () => {
    expect(validateResource({ ...validEncounter(), subject: { reference: "Patient/abc-123" } }).valid).toBe(true);
  });

  it("accepts urn:uuid form", () => {
    expect(
      validateResource({
        ...validEncounter(),
        subject: { reference: "urn:uuid:550e8400-e29b-41d4-a716-446655440000" },
      }).valid,
    ).toBe(true);
  });

  it("accepts absolute https URL form", () => {
    expect(
      validateResource({
        ...validEncounter(),
        subject: { reference: "https://fhir.example.com/Patient/abc" },
      }).valid,
    ).toBe(true);
  });

  it("rejects relative path without ResourceType prefix", () => {
    expect(validateResource({ ...validEncounter(), subject: { reference: "abc-123" } }).valid).toBe(false);
  });

  it("rejects empty reference string", () => {
    expect(validateResource({ ...validEncounter(), subject: { reference: "" } }).valid).toBe(false);
  });
});

// ─── validateBundle ─────────────────────────────────────────────────────────

describe("validateBundle", () => {
  it("rejects non-object bundle", () => {
    const result = validateBundle(null);
    expect(result.valid).toBe(false);
    expect(result.issues[0].path).toBe("$");
  });

  it("rejects bundle with wrong resourceType", () => {
    const result = validateBundle({ resourceType: "Patient", type: "collection", entry: [] });
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.path === "resourceType")).toBe(true);
  });

  it("rejects bundle missing type", () => {
    const result = validateBundle({ resourceType: "Bundle", entry: [] });
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.path === "type")).toBe(true);
  });

  it("rejects bundle with non-array entry", () => {
    const result = validateBundle({ resourceType: "Bundle", type: "collection", entry: "nope" });
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.path === "entry")).toBe(true);
  });

  it("passes a valid bundle with one Patient entry", () => {
    const result = validateBundle({
      resourceType: "Bundle",
      type: "collection",
      entry: [
        {
          fullUrl: "urn:uuid:pat-1",
          resource: validPatient(),
        },
      ],
    });
    expect(result.valid).toBe(true);
  });

  it("flags entries missing fullUrl", () => {
    const result = validateBundle({
      resourceType: "Bundle",
      type: "collection",
      entry: [{ resource: validPatient() }],
    });
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.path.startsWith("entry[0].fullUrl"))).toBe(true);
  });

  it("propagates per-entry resource validation errors with indexed path", () => {
    const badPatient = { ...validPatient(), gender: "M" };
    const result = validateBundle({
      resourceType: "Bundle",
      type: "collection",
      entry: [
        { fullUrl: "urn:uuid:1", resource: validPatient() },
        { fullUrl: "urn:uuid:2", resource: badPatient },
      ],
    });
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.path === "entry[1].resource.gender")).toBe(true);
  });
});

// ─── assertValidResource / assertValidBundle ────────────────────────────────

describe("assertValidResource", () => {
  it("does not throw for a valid resource", () => {
    expect(() => assertValidResource(validPatient() as any)).not.toThrow();
  });

  it("throws with a summary message for an invalid resource", () => {
    const bad = { ...validPatient(), gender: "X" };
    expect(() => assertValidResource(bad as any)).toThrow(/FHIR validation failed/);
    expect(() => assertValidResource(bad as any)).toThrow(/gender/);
  });

  it("includes all error paths in the thrown message", () => {
    const bad = { resourceType: "Patient", id: "p" } as any;
    try {
      assertValidResource(bad);
      throw new Error("should have thrown");
    } catch (e: any) {
      expect(e.message).toMatch(/identifier/);
      expect(e.message).toMatch(/name/);
      expect(e.message).toMatch(/gender/);
    }
  });
});

describe("assertValidBundle", () => {
  it("does not throw for a valid bundle", () => {
    const bundle = {
      resourceType: "Bundle",
      type: "collection",
      entry: [{ fullUrl: "urn:uuid:p", resource: validPatient() }],
    } as any;
    expect(() => assertValidBundle(bundle)).not.toThrow();
  });

  it("throws with a summary message for an invalid bundle", () => {
    const bundle = { resourceType: "Bundle", type: "collection", entry: "nope" } as any;
    expect(() => assertValidBundle(bundle)).toThrow(/FHIR Bundle validation failed/);
  });
});
