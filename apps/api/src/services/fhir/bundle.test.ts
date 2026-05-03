// Unit tests for the FHIR Bundle helpers and self-consistency validator.
//
// `bundle.ts` is pure logic (no Prisma, no I/O), so these tests are entirely
// in-memory: synthesise a small Patient + Encounter fixture inline, run it
// through `toSearchsetBundle` / `toTransactionBundle` / `processTransactionBundle`,
// then exercise `validateBundleSelfConsistency` against three known-bad bundles
// (duplicate fullUrl, dangling reference, missing resourceType).

import { describe, it, expect } from "vitest";

import {
  toSearchsetBundle,
  toTransactionBundle,
  processTransactionBundle,
  validateBundleSelfConsistency,
  type FhirBundle,
} from "./bundle";
import type { FhirResource } from "./resources";

// ─── Inline FHIR fixtures (no external files per task spec) ─────────────────

function patientResource(id: string, mrNumber = "MR-0001"): FhirResource {
  return {
    resourceType: "Patient",
    id,
    identifier: [{ system: "https://hospital.example/mr", value: mrNumber, use: "official" }],
    active: true,
    name: [{ use: "official", text: "Test Patient", given: ["Test"], family: "Patient" }],
    gender: "male",
    birthDate: "1980-01-01",
  } as unknown as FhirResource;
}

function encounterResource(id: string, patientId: string): FhirResource {
  return {
    resourceType: "Encounter",
    id,
    status: "finished",
    class: { system: "http://terminology.hl7.org/CodeSystem/v3-ActCode", code: "AMB" },
    subject: { reference: `Patient/${patientId}` },
    period: {
      start: "2026-04-22T10:00:00Z",
      end: "2026-04-22T10:30:00Z",
    },
  } as unknown as FhirResource;
}

/** Small Patient + 2 Encounters fixture used across the validation suite. */
function smallPatientGraph(): FhirResource[] {
  return [
    patientResource("pat-1"),
    encounterResource("enc-1", "pat-1"),
    encounterResource("enc-2", "pat-1"),
  ];
}

// ─── toSearchsetBundle / toTransactionBundle entry-count + fullUrl shape ────

describe("toSearchsetBundle", () => {
  it("sets Bundle.total equal to entry count", () => {
    const bundle = toSearchsetBundle(smallPatientGraph());
    expect(bundle.resourceType).toBe("Bundle");
    expect(bundle.type).toBe("searchset");
    expect(bundle.total).toBe(3);
    expect(bundle.entry).toHaveLength(3);
    expect(bundle.total).toBe(bundle.entry.length);
  });

  it("emits unique urn:uuid: fullUrls for distinct (resourceType, id) pairs", () => {
    const bundle = toSearchsetBundle(smallPatientGraph());
    const fullUrls = bundle.entry.map((e) => e.fullUrl);
    expect(new Set(fullUrls).size).toBe(fullUrls.length);
    // urn:uuid: prefix per FHIR R4 §3.1.2.
    expect(fullUrls.every((u) => u.startsWith("urn:uuid:"))).toBe(true);
    // Including resourceType in the urn keeps Patient/x and Encounter/x distinct.
    expect(fullUrls).toContain("urn:uuid:Patient-pat-1");
    expect(fullUrls).toContain("urn:uuid:Encounter-enc-1");
    expect(fullUrls).toContain("urn:uuid:Encounter-enc-2");
  });
});

describe("toTransactionBundle", () => {
  it("emits PUT request entries with canonical resource URL", () => {
    const bundle = toTransactionBundle(smallPatientGraph());
    expect(bundle.type).toBe("transaction");
    expect(bundle.entry).toHaveLength(3);
    const requests = bundle.entry.map((e) => e.request);
    expect(requests[0]).toEqual({ method: "PUT", url: "Patient/pat-1" });
    expect(requests[1]).toEqual({ method: "PUT", url: "Encounter/enc-1" });
    expect(requests[2]).toEqual({ method: "PUT", url: "Encounter/enc-2" });
  });
});

describe("processTransactionBundle", () => {
  it("returns a transaction-response bundle echoing the input entries", () => {
    const txn = toTransactionBundle(smallPatientGraph());
    const response = processTransactionBundle(txn);
    expect(response.type).toBe("transaction-response");
    expect(response.entry).toHaveLength(3);
    expect(response.entry[0].fullUrl).toBe(txn.entry[0].fullUrl);
  });
});

// ─── validateBundleSelfConsistency — happy path ─────────────────────────────

describe("validateBundleSelfConsistency — happy path", () => {
  it("accepts a Patient + 2 Encounters bundle whose Encounter.subject points at the Patient.id", () => {
    // Use Patient/<id> reference style; the validator resolves via byTypeId.
    const bundle: FhirBundle = {
      resourceType: "Bundle",
      id: "ok-1",
      type: "transaction",
      timestamp: new Date().toISOString(),
      entry: [
        { fullUrl: "urn:uuid:Patient-pat-1", resource: patientResource("pat-1") },
        { fullUrl: "urn:uuid:Encounter-enc-1", resource: encounterResource("enc-1", "pat-1") },
        { fullUrl: "urn:uuid:Encounter-enc-2", resource: encounterResource("enc-2", "pat-1") },
      ],
    };
    const result = validateBundleSelfConsistency(bundle);
    expect(result.valid).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it("resolves urn:uuid: fullUrl references when entries don't use Type/id form", () => {
    const patUrn = "urn:uuid:abcd-pat";
    const encUrn = "urn:uuid:abcd-enc";
    const bundle: FhirBundle = {
      resourceType: "Bundle",
      id: "ok-2",
      type: "searchset",
      timestamp: new Date().toISOString(),
      entry: [
        { fullUrl: patUrn, resource: patientResource("pat-1") },
        {
          fullUrl: encUrn,
          // Encounter references the Patient by its urn:uuid: fullUrl rather than Patient/pat-1.
          resource: {
            ...(encounterResource("enc-1", "pat-1") as any),
            subject: { reference: patUrn },
          } as FhirResource,
        },
      ],
    };
    const result = validateBundleSelfConsistency(bundle);
    expect(result.valid).toBe(true);
  });

  it("tolerates absolute https:// references as external (not flagged unresolved)", () => {
    const bundle: FhirBundle = {
      resourceType: "Bundle",
      id: "ok-3",
      type: "searchset",
      timestamp: new Date().toISOString(),
      entry: [
        { fullUrl: "urn:uuid:Patient-pat-1", resource: patientResource("pat-1") },
        {
          fullUrl: "urn:uuid:Encounter-enc-1",
          resource: {
            ...(encounterResource("enc-1", "pat-1") as any),
            // External reference to a Practitioner on another server.
            participant: [{ individual: { reference: "https://hapi.fhir.org/baseR4/Practitioner/123" } }],
          } as FhirResource,
        },
      ],
    };
    const result = validateBundleSelfConsistency(bundle);
    expect(result.valid).toBe(true);
    expect(result.issues.filter((i) => i.code === "unresolved-reference")).toHaveLength(0);
  });
});

// ─── validateBundleSelfConsistency — known-bad fixtures ─────────────────────

describe("validateBundleSelfConsistency — known-bad fixtures", () => {
  it("flags duplicate fullUrl (BAD #1)", () => {
    const dup = "urn:uuid:Patient-pat-1";
    const bundle: FhirBundle = {
      resourceType: "Bundle",
      id: "bad-dup",
      type: "transaction",
      timestamp: new Date().toISOString(),
      entry: [
        { fullUrl: dup, resource: patientResource("pat-1") },
        // Same fullUrl as the first entry — must be flagged.
        { fullUrl: dup, resource: encounterResource("enc-1", "pat-1") },
      ],
    };
    const result = validateBundleSelfConsistency(bundle);
    expect(result.valid).toBe(false);
    const dupIssues = result.issues.filter((i) => i.code === "duplicate-fullurl");
    expect(dupIssues).toHaveLength(1);
    expect(dupIssues[0].severity).toBe("error");
    expect(dupIssues[0].entryIndex).toBe(1);
    expect(dupIssues[0].message).toContain(dup);
  });

  it("flags reference to a Patient.id that's not in the bundle (BAD #2)", () => {
    // Encounter.subject points at Patient/pat-MISSING which has no entry.
    const bundle: FhirBundle = {
      resourceType: "Bundle",
      id: "bad-ref",
      type: "transaction",
      timestamp: new Date().toISOString(),
      entry: [
        { fullUrl: "urn:uuid:Patient-pat-1", resource: patientResource("pat-1") },
        {
          fullUrl: "urn:uuid:Encounter-enc-1",
          resource: encounterResource("enc-1", "pat-MISSING"),
        },
      ],
    };
    const result = validateBundleSelfConsistency(bundle);
    expect(result.valid).toBe(false);
    const refIssues = result.issues.filter((i) => i.code === "unresolved-reference");
    expect(refIssues).toHaveLength(1);
    expect(refIssues[0].severity).toBe("error");
    expect(refIssues[0].entryIndex).toBe(1);
    expect(refIssues[0].message).toContain("Patient/pat-MISSING");
  });

  it("flags an entry with missing resourceType — wrong resource shape (BAD #3)", () => {
    // Entry whose resource lacks the required resourceType discriminator.
    const bundle: FhirBundle = {
      resourceType: "Bundle",
      id: "bad-type",
      type: "transaction",
      timestamp: new Date().toISOString(),
      entry: [
        { fullUrl: "urn:uuid:Patient-pat-1", resource: patientResource("pat-1") },
        {
          fullUrl: "urn:uuid:something-bogus",
          // Missing resourceType — the validator must flag it instead of letting it
          // through as if it were a valid Encounter / Patient / etc.
          resource: { id: "no-type" } as unknown as FhirResource,
        },
      ],
    };
    const result = validateBundleSelfConsistency(bundle);
    expect(result.valid).toBe(false);
    const typeIssues = result.issues.filter((i) => i.code === "missing-resource-type");
    expect(typeIssues).toHaveLength(1);
    expect(typeIssues[0].severity).toBe("error");
    expect(typeIssues[0].entryIndex).toBe(1);
  });

  it("flags an unknown Bundle.type as invalid", () => {
    const bundle = {
      resourceType: "Bundle",
      id: "bad-bundle-type",
      type: "not-a-real-type",
      timestamp: new Date().toISOString(),
      entry: [
        { fullUrl: "urn:uuid:Patient-pat-1", resource: patientResource("pat-1") },
      ],
    } as unknown as FhirBundle;
    const result = validateBundleSelfConsistency(bundle);
    expect(result.valid).toBe(false);
    const typeIssues = result.issues.filter((i) => i.code === "invalid-type");
    expect(typeIssues).toHaveLength(1);
    expect(typeIssues[0].severity).toBe("error");
  });
});
