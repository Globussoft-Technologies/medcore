/**
 * FHIR Bundle round-trip test suite.
 *
 * What this tests that the existing mapper/ingest tests do NOT:
 *   • Realistic patient timelines (OP consult, chronic-care, paediatric,
 *     devanagari script, lab workup) seeded into an actual Postgres via the
 *     typed Prisma delegates.
 *   • Forward export (`exportPatientEverything`) → ingest (`processBundle`)
 *     → DB state snapshot comparison on every scenario, confirming the
 *     round-trip is a no-op on row counts and stable fields.
 *   • Bundle self-consistency (references resolve, fullUrls unique, every
 *     resource has a resourceType).
 *   • A lossy-round-trip characterisation block locking in the CURRENT lossy
 *     behaviour so a future refactor that makes it worse fails the test.
 *   • Stress scale: a 100-encounter, 50-lab-workup chronic-care graph.
 *   • ABDM encryption: export → `encryptBundleForHiu` → `decryptBundleFromHip`
 *     → `processBundle` still works.
 *
 * All integration scenarios skip when DATABASE_URL_TEST is not set (the
 * `describeIfDB` helper handles that). The pure-bundle validation sub-suite
 * runs without a DB.
 *
 * NOTE: This file intentionally does NOT touch the forward/reverse mappers
 * or the Prisma schema — it only adds coverage.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { describeIfDB, resetDB, getPrisma } from "../../test/setup";
import type { PrismaClient } from "@medcore/db";
import {
  buildOPConsultationScenario,
  buildLabWorkupScenario,
  buildChronicCareScenario,
  buildPaediatricScenario,
  buildHindiPatientScenario,
  HINDI_PATIENT_NAME,
  HINDI_PATIENT_ADDRESS,
  testPasswordHash,
  type Scenario,
} from "../../test/fixtures/fhir-scenarios";
import {
  patientToFhir,
  doctorToFhir,
  appointmentToFhir,
  consultationToEncounter,
  consultationToComposition,
  prescriptionToMedicationRequests,
  allergyToFhir,
  labOrderToServiceRequest,
  labOrderToDiagnosticReport,
  labResultToObservation,
  type FhirResource,
} from "./resources";
import { toSearchsetBundle, validateBundleSelfConsistency, type FhirBundle } from "./bundle";
import { processBundle } from "./ingest";
import {
  encryptBundleForHiu,
  decryptBundleFromHip,
  generateEphemeralKeyPair,
  generateNonceBase64,
} from "../abdm/crypto";
import { createHash } from "node:crypto";

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Reconstruct the FHIR `$everything` searchset bundle for a patient entirely
 * from Prisma data. Mirrors the handler in `routes/fhir.ts` but is callable
 * from tests without spinning up Express. We keep this inline (not exported
 * from resources.ts) to avoid coupling the route to the test harness.
 */
async function exportPatientEverything(
  prisma: PrismaClient,
  patientId: string
): Promise<FhirBundle> {
  const patient = await prisma.patient.findUnique({
    where: { id: patientId },
    include: {
      user: true,
      allergies: true,
      appointments: { include: { doctor: { include: { user: true } } } },
      prescriptions: { include: { items: true, doctor: { include: { user: true } } } },
      labOrders: {
        include: {
          items: { include: { test: true, results: true } },
          doctor: { include: { user: true } },
        },
      },
    },
  });
  if (!patient) throw new Error(`Patient ${patientId} not found`);

  const resources: FhirResource[] = [];
  resources.push(patientToFhir(patient));

  // Deduplicate doctors across all relations.
  const doctorMap = new Map<string, any>();
  for (const appt of (patient.appointments as any[]) ?? []) {
    if (appt.doctor && !doctorMap.has(appt.doctor.id)) doctorMap.set(appt.doctor.id, appt.doctor);
  }
  for (const rx of (patient.prescriptions as any[]) ?? []) {
    if (rx.doctor && !doctorMap.has(rx.doctor.id)) doctorMap.set(rx.doctor.id, rx.doctor);
  }
  for (const lo of (patient.labOrders as any[]) ?? []) {
    if (lo.doctor && !doctorMap.has(lo.doctor.id)) doctorMap.set(lo.doctor.id, lo.doctor);
  }
  for (const d of doctorMap.values()) resources.push(doctorToFhir(d));

  for (const appt of (patient.appointments as any[]) ?? []) resources.push(appointmentToFhir(appt));
  for (const allergy of (patient.allergies as any[]) ?? []) resources.push(allergyToFhir(allergy));
  for (const rx of (patient.prescriptions as any[]) ?? []) {
    resources.push(...prescriptionToMedicationRequests(rx));
  }

  const apptIds = ((patient.appointments as any[]) ?? []).map((a) => a.id);
  if (apptIds.length > 0) {
    const consultations = await prisma.consultation.findMany({
      where: { appointmentId: { in: apptIds } },
      include: { appointment: true },
    });
    for (const c of consultations as any[]) {
      resources.push(consultationToEncounter(c));
      try {
        resources.push(consultationToComposition(c));
      } catch {
        // Composition requires patientId+doctorId on the appointment include;
        // skip silently when those aren't available — mirrors route behaviour.
      }
    }
  }

  for (const lo of (patient.labOrders as any[]) ?? []) {
    resources.push(labOrderToServiceRequest(lo));
    const resultIds: string[] = [];
    for (const item of (lo.items as any[]) ?? []) {
      for (const r of (item.results as any[]) ?? []) {
        resources.push(
          labResultToObservation(r, {
            patientId,
            orderId: lo.id,
            testCode: item.test?.code,
            testName: item.test?.name,
          })
        );
        resultIds.push(r.id);
      }
    }
    resources.push(labOrderToDiagnosticReport(lo, resultIds));
  }

  return toSearchsetBundle(resources, `patient-${patientId}-everything`);
}

/**
 * Capture a snapshot of every table that participates in FHIR round-trip for
 * a single patient. Each row is summarised via a stable JSON hash of the
 * fields we care about — if any of those fields drift on re-ingest, the
 * hash changes and the test fails.
 */
interface DbSnapshot {
  patient: string;
  appointments: Array<{ id: string; hash: string; tokenNumber: number }>;
  consultations: Array<{ id: string; hash: string }>;
  prescriptions: Array<{ id: string; hash: string }>;
  prescriptionItems: Array<{ id: string; hash: string }>;
  allergies: Array<{ id: string; hash: string; severity: string }>;
  labOrders: Array<{ id: string; hash: string; status: string }>;
  labOrderItems: Array<{ id: string; hash: string }>;
  labResults: Array<{ id: string; hash: string; value: string }>;
  counts: Record<string, number>;
}

function hashOf(obj: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(obj, Object.keys(obj).sort())).digest("hex").slice(0, 16);
}

async function snapshotForPatient(prisma: PrismaClient, patientId: string): Promise<DbSnapshot> {
  const patient = await prisma.patient.findUniqueOrThrow({
    where: { id: patientId },
    include: { user: true },
  });
  const appointments = await prisma.appointment.findMany({
    where: { patientId },
    orderBy: { date: "asc" },
  });
  const consultations = await prisma.consultation.findMany({
    where: { appointment: { patientId } },
  });
  const prescriptions = await prisma.prescription.findMany({
    where: { patientId },
    include: { items: true },
  });
  const allergies = await prisma.patientAllergy.findMany({
    where: { patientId },
  });
  const labOrders = await prisma.labOrder.findMany({
    where: { patientId },
    include: { items: { include: { results: true } } },
  });

  return {
    patient: hashOf({
      id: patient.id,
      mrNumber: patient.mrNumber,
      gender: patient.gender,
      abhaId: patient.abhaId,
      aadhaarMasked: patient.aadhaarMasked,
      userName: patient.user.name,
      address: patient.address,
      dateOfBirth: patient.dateOfBirth?.toISOString(),
    }),
    appointments: appointments.map((a) => ({
      id: a.id,
      tokenNumber: a.tokenNumber,
      hash: hashOf({
        id: a.id,
        patientId: a.patientId,
        doctorId: a.doctorId,
        tokenNumber: a.tokenNumber,
        status: a.status,
        slotStart: a.slotStart,
        slotEnd: a.slotEnd,
      }),
    })),
    consultations: consultations.map((c) => ({
      id: c.id,
      hash: hashOf({ id: c.id, notes: c.notes, findings: c.findings }),
    })),
    prescriptions: prescriptions.map((p) => ({
      id: p.id,
      hash: hashOf({ id: p.id, diagnosis: p.diagnosis, appointmentId: p.appointmentId }),
    })),
    prescriptionItems: prescriptions.flatMap((p) =>
      p.items.map((i) => ({
        id: i.id,
        hash: hashOf({
          medicineName: i.medicineName,
          dosage: i.dosage,
          frequency: i.frequency,
          duration: i.duration,
        }),
      }))
    ),
    allergies: allergies.map((a) => ({
      id: a.id,
      severity: a.severity,
      hash: hashOf({ id: a.id, allergen: a.allergen, severity: a.severity }),
    })),
    labOrders: labOrders.map((lo) => ({
      id: lo.id,
      status: lo.status,
      hash: hashOf({ id: lo.id, patientId: lo.patientId, priority: lo.priority, stat: lo.stat }),
    })),
    labOrderItems: labOrders.flatMap((lo) =>
      lo.items.map((i) => ({
        id: i.id,
        hash: hashOf({ orderId: i.orderId, testId: i.testId }),
      }))
    ),
    labResults: labOrders.flatMap((lo) =>
      lo.items.flatMap((i) =>
        i.results.map((r) => ({
          id: r.id,
          value: r.value,
          hash: hashOf({
            id: r.id,
            parameter: r.parameter,
            value: r.value,
            unit: r.unit,
            flag: r.flag,
            normalRange: r.normalRange,
          }),
        }))
      )
    ),
    counts: {
      appointments: appointments.length,
      consultations: consultations.length,
      prescriptions: prescriptions.length,
      prescriptionItems: prescriptions.reduce((acc, p) => acc + p.items.length, 0),
      allergies: allergies.length,
      labOrders: labOrders.length,
      labOrderItems: labOrders.reduce((acc, lo) => acc + lo.items.length, 0),
      labResults: labOrders.reduce(
        (acc, lo) => acc + lo.items.reduce((a2, i) => a2 + i.results.length, 0),
        0
      ),
    },
  };
}

/** Count resource-type occurrences in a bundle. */
function countTypes(bundle: FhirBundle): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of bundle.entry) {
    const t = (e.resource as { resourceType?: string }).resourceType;
    if (!t) continue;
    out[t] = (out[t] ?? 0) + 1;
  }
  return out;
}

// ─── Pure bundle validation (no DB) ─────────────────────────────────────────

describe("validateBundleSelfConsistency (pure)", () => {
  it("accepts a minimal well-formed searchset bundle", () => {
    const bundle: FhirBundle = {
      resourceType: "Bundle",
      id: "b-1",
      type: "searchset",
      timestamp: new Date().toISOString(),
      total: 1,
      entry: [
        {
          fullUrl: "urn:uuid:Patient-p-1",
          resource: {
            resourceType: "Patient",
            id: "p-1",
            identifier: [{ system: "https://medcore.health/patient/mr-number", value: "MR-1" }],
            active: true,
            name: [{ text: "Test" }],
            gender: "male",
          } as any,
        },
      ],
    };
    const result = validateBundleSelfConsistency(bundle);
    expect(result.valid).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it("flags a bundle with a dangling reference", () => {
    const bundle: FhirBundle = {
      resourceType: "Bundle",
      id: "b-2",
      type: "transaction",
      timestamp: new Date().toISOString(),
      entry: [
        {
          fullUrl: "urn:uuid:AllergyIntolerance-a-1",
          resource: {
            resourceType: "AllergyIntolerance",
            id: "a-1",
            patient: { reference: "Patient/missing-patient" },
            code: { text: "Dust" },
          } as any,
        },
      ],
    };
    const result = validateBundleSelfConsistency(bundle);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.code === "unresolved-reference")).toBe(true);
  });

  it("flags duplicate fullUrls", () => {
    const dup: FhirBundle = {
      resourceType: "Bundle",
      id: "b-3",
      type: "searchset",
      timestamp: new Date().toISOString(),
      entry: [
        {
          fullUrl: "urn:uuid:same",
          resource: { resourceType: "Patient", id: "a" } as any,
        },
        {
          fullUrl: "urn:uuid:same",
          resource: { resourceType: "Patient", id: "b" } as any,
        },
      ],
    };
    const result = validateBundleSelfConsistency(dup);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.code === "duplicate-fullurl")).toBe(true);
  });

  it("flags bundle.type values outside the FHIR R4 set", () => {
    const bogus = {
      resourceType: "Bundle",
      id: "b-4",
      type: "garbage",
      timestamp: new Date().toISOString(),
      entry: [],
    } as unknown as FhirBundle;
    const result = validateBundleSelfConsistency(bogus);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.code === "invalid-type")).toBe(true);
  });

  it("accepts Type/id style refs AND urn:uuid: style refs in the same bundle", () => {
    const bundle: FhirBundle = {
      resourceType: "Bundle",
      id: "b-5",
      type: "transaction",
      timestamp: new Date().toISOString(),
      entry: [
        {
          fullUrl: "Patient/p-1",
          resource: {
            resourceType: "Patient",
            id: "p-1",
            identifier: [{ system: "x", value: "v" }],
            active: true,
            name: [{ text: "T" }],
            gender: "male",
          } as any,
        },
        {
          fullUrl: "urn:uuid:Allergy-a-1",
          resource: {
            resourceType: "AllergyIntolerance",
            id: "a-1",
            patient: { reference: "Patient/p-1" },
            code: { text: "Eggs" },
          } as any,
        },
      ],
    };
    const result = validateBundleSelfConsistency(bundle);
    expect(result.valid).toBe(true);
  });
});

// ─── DB-backed round-trip suite ─────────────────────────────────────────────

/**
 * Wipe every per-patient table so each scenario seeds into a clean slate.
 * `resetDB` (in setup.ts) would also work but it re-creates the whole schema
 * — running it per-scenario would be slow. Instead we delete only the tables
 * our scenarios touch, in FK-safe order.
 */
async function truncatePatientData(prisma: PrismaClient): Promise<void> {
  await prisma.labResult.deleteMany({});
  await prisma.labOrderItem.deleteMany({});
  await prisma.labOrder.deleteMany({});
  await prisma.labTest.deleteMany({});
  await prisma.prescriptionItem.deleteMany({});
  await prisma.prescription.deleteMany({});
  await prisma.consultation.deleteMany({});
  await prisma.appointment.deleteMany({});
  await prisma.patientAllergy.deleteMany({});
  await prisma.immunization.deleteMany({});
  await prisma.growthRecord.deleteMany({});
  await prisma.patient.deleteMany({});
  await prisma.doctor.deleteMany({});
  // Leave any admin seed row the resetDB step installed; only remove users we
  // might have created with the "roundtrip" password hash.
  await prisma.user.deleteMany({ where: { passwordHash: testPasswordHash() } });
}

describeIfDB("FHIR Bundle round-trip (integration)", () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    await resetDB();
    prisma = (await getPrisma()) as PrismaClient;
  });

  const scenarios: Array<{ label: string; build: () => Scenario }> = [
    { label: "OPConsultation", build: buildOPConsultationScenario },
    { label: "LabWorkup", build: buildLabWorkupScenario },
    { label: "ChronicCare", build: buildChronicCareScenario },
    { label: "Paediatric", build: buildPaediatricScenario },
    { label: "HindiPatient", build: buildHindiPatientScenario },
  ];

  for (const { label, build } of scenarios) {
    describe(`scenario: ${label}`, () => {
      let scenario: Scenario;
      let exportedBundle: FhirBundle;
      let preSnap: DbSnapshot;
      let postSnap: DbSnapshot;

      beforeAll(async () => {
        await truncatePatientData(prisma);
        scenario = build();
        await scenario.prismaSeeds(prisma);

        preSnap = await snapshotForPatient(prisma, scenario.patientId);
        exportedBundle = await exportPatientEverything(prisma, scenario.patientId);

        // Re-ingest the exported bundle as a transaction.
        const txnBundle: FhirBundle = { ...exportedBundle, type: "transaction" };
        const result = await processBundle(txnBundle, { recordedBy: "roundtrip-test" });
        expect(result.success, `processBundle failed: ${result.errorMessage}`).toBe(true);

        postSnap = await snapshotForPatient(prisma, scenario.patientId);
      });

      it("exports a bundle that matches the expected shape", () => {
        expect(exportedBundle.entry.length).toBeGreaterThanOrEqual(scenario.expectedBundleShape.minEntries);
        const actualCounts = countTypes(exportedBundle);
        for (const [type, expectedMin] of Object.entries(scenario.expectedBundleShape.resourceCounts)) {
          expect(
            actualCounts[type] ?? 0,
            `expected at least ${expectedMin} ${type} in bundle, got ${actualCounts[type] ?? 0}`
          ).toBeGreaterThanOrEqual(expectedMin as number);
        }
      });

      it("exported bundle is self-consistent (refs resolve, unique fullUrls, resourceType set)", () => {
        const result = validateBundleSelfConsistency(exportedBundle);
        if (!result.valid) {
          // Surface the specific issues for faster triage.
          for (const issue of result.issues) {
            // eslint-disable-next-line no-console
            console.warn(`[${label}] bundle issue: ${issue.code} entry=${issue.entryIndex} — ${issue.message}`);
          }
        }
        expect(result.valid).toBe(true);
      });

      it("bundle type is searchset (export) and every entry has a resourceType", () => {
        expect(["searchset", "transaction"]).toContain(exportedBundle.type);
        for (const e of exportedBundle.entry) {
          expect((e.resource as any).resourceType).toBeTruthy();
          expect(e.fullUrl).toBeTruthy();
        }
      });

      it("ingest is idempotent — row counts unchanged after round-trip", () => {
        expect(postSnap.counts).toEqual(preSnap.counts);
      });

      it("patient core identifiers are stable", () => {
        expect(postSnap.patient).toBe(preSnap.patient);
      });

      it("appointment.tokenNumber does not drift on re-ingest", () => {
        for (const pre of preSnap.appointments) {
          const post = postSnap.appointments.find((p) => p.id === pre.id);
          expect(post, `appointment ${pre.id} missing after round-trip`).toBeTruthy();
          expect(post!.tokenNumber).toBe(pre.tokenNumber);
        }
      });

      it("consultation narrative fields survive the XML escape + strip cycle", () => {
        expect(postSnap.consultations.length).toBe(preSnap.consultations.length);
        for (const pre of preSnap.consultations) {
          const post = postSnap.consultations.find((p) => p.id === pre.id);
          expect(post, `consultation ${pre.id} missing`).toBeTruthy();
          expect(post!.hash).toBe(pre.hash);
        }
      });

      it("allergy severity enum is preserved", () => {
        for (const pre of preSnap.allergies) {
          const post = postSnap.allergies.find((p) => p.id === pre.id);
          expect(post, `allergy ${pre.id} missing`).toBeTruthy();
          expect(post!.severity).toBe(pre.severity);
        }
      });

      it("lab result numeric values preserved exactly (no float drift)", () => {
        for (const pre of preSnap.labResults) {
          const post = postSnap.labResults.find((p) => p.id === pre.id);
          expect(post, `lab result ${pre.id} missing`).toBeTruthy();
          expect(post!.value).toBe(pre.value);
        }
      });
    });
  }

  // ─── Hindi-specific byte-identity test ────────────────────────────────────

  describe("HindiPatient — byte-identical devanagari", () => {
    let scenario: Scenario;
    let exportedBundle: FhirBundle;

    beforeAll(async () => {
      await truncatePatientData(prisma);
      scenario = buildHindiPatientScenario();
      await scenario.prismaSeeds(prisma);
      exportedBundle = await exportPatientEverything(prisma, scenario.patientId);
      const txn: FhirBundle = { ...exportedBundle, type: "transaction" };
      const res = await processBundle(txn, { recordedBy: "roundtrip-test" });
      expect(res.success).toBe(true);
    });

    it("name in exported bundle matches the seeded devanagari string byte-for-byte", () => {
      const patient = exportedBundle.entry.find(
        (e) => (e.resource as any).resourceType === "Patient"
      )?.resource as any;
      expect(patient).toBeTruthy();
      const hasName = patient.name.some(
        (n: any) => n.text === HINDI_PATIENT_NAME || (Array.isArray(n.given) && n.given.join(" ").includes("रमेश"))
      );
      expect(hasName).toBe(true);
    });

    it("DB state after round-trip still has the devanagari address byte-for-byte", async () => {
      const row = await prisma.patient.findUniqueOrThrow({ where: { id: scenario.patientId } });
      expect(row.address).toBe(HINDI_PATIENT_ADDRESS);
      const user = await prisma.user.findUniqueOrThrow({ where: { id: row.userId } });
      expect(user.name).toBe(HINDI_PATIENT_NAME);
    });

    it("JSON roundtrip via serialise/parse keeps the devanagari untouched (no mojibake)", () => {
      const json = JSON.stringify(exportedBundle);
      const parsed = JSON.parse(json) as FhirBundle;
      const patient = parsed.entry.find(
        (e) => (e.resource as any).resourceType === "Patient"
      )?.resource as any;
      expect(patient?.address?.[0]?.line?.[0]).toBe(HINDI_PATIENT_ADDRESS);
    });
  });

  // ─── Lossy round-trip characterisation ────────────────────────────────────
  //
  // Each test here locks in a CURRENT lossy behaviour. If a future PR makes
  // the drift worse, these tests fail; if a PR eliminates the drift (e.g.
  // adds SAMPLE_COLLECTED mapping through ServiceRequest.status), the
  // corresponding test must be updated. Each `it` is annotated with the
  // rationale + a file:line anchor to the mapper that owns the behaviour.

  describe("lossy round-trip (locked in characterisation — see comment anchors)", () => {
    beforeAll(async () => {
      await truncatePatientData(prisma);
    });

    it(
      "LabOrder status narrows SAMPLE_COLLECTED → ORDERED on reingest " +
        "(resources.ts statusMap collapses SAMPLE_COLLECTED to 'active'; ingest.ts " +
        "mapServiceRequestStatusBack lands on ORDERED)",
      async () => {
        const scenario = buildLabWorkupScenario();
        await scenario.prismaSeeds(prisma);
        // Force the order to SAMPLE_COLLECTED to exercise the lossy branch.
        // DiagnosticReport won't fire (exporter emits status=partial then;
        // ingest leaves the order status alone since it's non-final).
        await prisma.labOrder.update({
          where: { id: "rt-lab-lo" },
          data: { status: "SAMPLE_COLLECTED", completedAt: null },
        });
        // Also reset any verifiedAt on results so the whole workflow is
        // in-flight; otherwise DiagnosticReport is still status=final.
        await prisma.labResult.updateMany({
          where: { orderItem: { order: { id: "rt-lab-lo" } } },
          data: { verifiedAt: null, verifiedBy: null },
        });

        const bundle = await exportPatientEverything(prisma, scenario.patientId);
        const txn: FhirBundle = { ...bundle, type: "transaction" };
        const result = await processBundle(txn, { recordedBy: "roundtrip-test" });
        expect(result.success).toBe(true);

        const after = await prisma.labOrder.findUniqueOrThrow({ where: { id: "rt-lab-lo" } });
        // LOCKED: was SAMPLE_COLLECTED, lands on ORDERED (narrowing).
        expect(after.status).toBe("ORDERED");
      }
    );

    it(
      "LabOrder.notes accumulates an 'Imported/updated via FHIR bundle' provenance stamp " +
        "(ingest.ts ingestServiceRequest update path) — this is intentional, so downstream " +
        "finance reconciliation can see the order arrived via FHIR",
      async () => {
        await truncatePatientData(prisma);
        const scenario = buildLabWorkupScenario();
        await scenario.prismaSeeds(prisma);
        const bundle = await exportPatientEverything(prisma, scenario.patientId);
        const txn: FhirBundle = { ...bundle, type: "transaction" };
        const result = await processBundle(txn, { recordedBy: "roundtrip-test" });
        expect(result.success).toBe(true);

        const after = await prisma.labOrder.findUniqueOrThrow({ where: { id: "rt-lab-lo" } });
        // Fresh order had no notes; after ingest it carries the provenance string.
        expect(after.notes ?? "").toMatch(/FHIR/i);
      }
    );

    it(
      "Re-ingesting MedicationRequests is idempotent on PrescriptionItems " +
        "(ingest.ts ingestMedicationRequest dedupes by (prescriptionId, medicineName)).",
      async () => {
        await truncatePatientData(prisma);
        const scenario = buildOPConsultationScenario();
        await scenario.prismaSeeds(prisma);
        const pre = await prisma.prescriptionItem.count({
          where: { prescription: { patientId: scenario.patientId } },
        });
        const bundle = await exportPatientEverything(prisma, scenario.patientId);
        const txn: FhirBundle = { ...bundle, type: "transaction" };
        const res = await processBundle(txn, { recordedBy: "roundtrip-test" });
        expect(res.success).toBe(true);
        const post = await prisma.prescriptionItem.count({
          where: { prescription: { patientId: scenario.patientId } },
        });
        expect(post).toBe(pre);
      }
    );
  });

  // ─── Bundle validation on the real exports ────────────────────────────────

  describe("bundle validation — every exported scenario passes self-consistency", () => {
    beforeAll(async () => {
      await truncatePatientData(prisma);
    });

    for (const { label, build } of scenarios) {
      it(`${label} — exported bundle is self-consistent`, async () => {
        await truncatePatientData(prisma);
        const scenario = build();
        await scenario.prismaSeeds(prisma);
        const bundle = await exportPatientEverything(prisma, scenario.patientId);
        const result = validateBundleSelfConsistency(bundle);
        if (!result.valid) {
          for (const iss of result.issues) {
            // eslint-disable-next-line no-console
            console.warn(`[${label}] ${iss.code} @${iss.entryIndex}: ${iss.message}`);
          }
        }
        expect(result.valid).toBe(true);
      });
    }
  });

  // ─── Stress scenario ──────────────────────────────────────────────────────

  describe("stress — 100 encounters + 50 lab workups", () => {
    const STRESS_PREFIX = "rt-stress";
    const STRESS_PATIENT = `${STRESS_PREFIX}-pat`;
    const ENCOUNTER_COUNT = 100;
    const LAB_COUNT = 50;
    const PERF_WARN_MS = 5_000;

    beforeAll(async () => {
      await truncatePatientData(prisma);

      const patientUserId = `${STRESS_PREFIX}-pat-user`;
      const doctorUserId = `${STRESS_PREFIX}-doc-user`;
      const doctorId = `${STRESS_PREFIX}-doc`;

      await prisma.user.create({
        data: {
          id: patientUserId,
          email: `${STRESS_PREFIX}-pat@roundtrip.test.local`,
          name: "Stress Test Patient",
          phone: "9000009999",
          passwordHash: testPasswordHash(),
          role: "PATIENT",
        },
      });
      await prisma.user.create({
        data: {
          id: doctorUserId,
          email: `${STRESS_PREFIX}-doc@roundtrip.test.local`,
          name: "Stress Test Doctor",
          phone: "9000009998",
          passwordHash: testPasswordHash(),
          role: "DOCTOR",
        },
      });
      await prisma.patient.create({
        data: {
          id: STRESS_PATIENT,
          userId: patientUserId,
          mrNumber: `${STRESS_PREFIX}-MR-9001`,
          dateOfBirth: new Date("1960-06-15"),
          gender: "MALE",
          address: "Stress Test Ave",
          bloodGroup: "O+",
        },
      });
      await prisma.doctor.create({
        data: {
          id: doctorId,
          userId: doctorUserId,
          specialization: "Chronic Disease Management",
          qualification: "MBBS, MD",
        },
      });

      // 100 appointments/encounters.
      for (let i = 0; i < ENCOUNTER_COUNT; i++) {
        const apptId = `${STRESS_PREFIX}-appt-${i}`;
        const d = new Date("2020-01-01");
        d.setDate(d.getDate() + i * 7);
        await prisma.appointment.create({
          data: {
            id: apptId,
            patientId: STRESS_PATIENT,
            doctorId,
            date: d,
            slotStart: "10:00",
            slotEnd: "10:10",
            tokenNumber: (i % 20) + 1,
            type: "SCHEDULED",
            status: "COMPLETED",
            priority: "NORMAL",
            consultationStartedAt: d,
            consultationEndedAt: new Date(d.getTime() + 10 * 60_000),
          },
        });
        await prisma.consultation.create({
          data: {
            id: `${STRESS_PREFIX}-cons-${i}`,
            appointmentId: apptId,
            doctorId,
            findings: `Visit ${i + 1}/${ENCOUNTER_COUNT}: BP stable.`,
            notes: "Continue current regimen.",
          },
        });
      }

      // 50 lab orders, each with one CBC-like result.
      await prisma.labTest.create({
        data: {
          id: `${STRESS_PREFIX}-test`,
          code: `${STRESS_PREFIX}-CBC`,
          name: "CBC Stress",
          category: "Hematology",
          price: 100,
        },
      });
      for (let i = 0; i < LAB_COUNT; i++) {
        const orderId = `${STRESS_PREFIX}-lo-${i}`;
        const itemId = `${STRESS_PREFIX}-loi-${i}`;
        await prisma.labOrder.create({
          data: {
            id: orderId,
            orderNumber: `LO-${STRESS_PREFIX}-${i}`,
            patientId: STRESS_PATIENT,
            doctorId,
            status: "COMPLETED",
            priority: "ROUTINE",
            stat: false,
            orderedAt: new Date("2026-03-01"),
            completedAt: new Date("2026-03-02"),
            items: {
              create: [{ id: itemId, testId: `${STRESS_PREFIX}-test`, status: "COMPLETED" }],
            },
          },
        });
        await prisma.labResult.create({
          data: {
            id: `${STRESS_PREFIX}-res-${i}`,
            orderItemId: itemId,
            parameter: "Hemoglobin",
            value: String(13 + (i % 5) * 0.25),
            unit: "g/dL",
            normalRange: "13.0-17.0 g/dL",
            flag: "NORMAL",
            enteredBy: doctorUserId,
            reportedAt: new Date("2026-03-02"),
            verifiedAt: new Date("2026-03-02T02:00:00Z"),
            verifiedBy: doctorUserId,
          },
        });
      }
    }, 120_000);

    it(
      "exports + re-ingests a 100-encounter + 50-lab graph without DB drift (perf >5s is a warning only)",
      async () => {
        const pre = await snapshotForPatient(prisma, STRESS_PATIENT);

        const tExport = Date.now();
        const bundle = await exportPatientEverything(prisma, STRESS_PATIENT);
        const exportMs = Date.now() - tExport;

        expect(bundle.entry.length).toBeGreaterThan(ENCOUNTER_COUNT);
        expect(validateBundleSelfConsistency(bundle).valid).toBe(true);

        const tIngest = Date.now();
        const txn: FhirBundle = { ...bundle, type: "transaction" };
        const result = await processBundle(txn, { recordedBy: "stress-test" });
        const ingestMs = Date.now() - tIngest;
        expect(result.success).toBe(true);

        const post = await snapshotForPatient(prisma, STRESS_PATIENT);
        // Row counts for counts we control (we don't assert prescriptionItems —
        // those can grow per the lossy-round-trip tests; stress uses no rx).
        expect(post.counts.appointments).toBe(pre.counts.appointments);
        expect(post.counts.consultations).toBe(pre.counts.consultations);
        expect(post.counts.labOrders).toBe(pre.counts.labOrders);
        expect(post.counts.labResults).toBe(pre.counts.labResults);

        // eslint-disable-next-line no-console
        console.log(
          `[stress] export=${exportMs}ms ingest=${ingestMs}ms (entries=${bundle.entry.length})`
        );
        if (exportMs > PERF_WARN_MS) {
          // eslint-disable-next-line no-console
          console.warn(`[stress] WARN: export exceeded ${PERF_WARN_MS}ms (${exportMs}ms)`);
        }
        if (ingestMs > PERF_WARN_MS) {
          // eslint-disable-next-line no-console
          console.warn(`[stress] WARN: ingest exceeded ${PERF_WARN_MS}ms (${ingestMs}ms)`);
        }
      },
      120_000
    );
  });

  // ─── ABDM encryption round-trip ───────────────────────────────────────────

  describe("ABDM encryption layer preserves ingest", () => {
    it(
      "exported bundle → encryptBundleForHiu → decryptBundleFromHip → processBundle still succeeds",
      async () => {
        await truncatePatientData(prisma);
        const scenario = buildOPConsultationScenario();
        await scenario.prismaSeeds(prisma);

        const bundle = await exportPatientEverything(prisma, scenario.patientId);

        // Simulate an HIU that generates an ephemeral keypair and nonce.
        const hiuKeyPair = generateEphemeralKeyPair();
        const hiuNonce = generateNonceBase64();

        const envelope = encryptBundleForHiu({
          bundle,
          hiuPublicKey: hiuKeyPair.publicKeyBase64,
          hiuNonce,
        });

        // On the HIU side, decrypt.
        const plaintext = decryptBundleFromHip({
          envelope,
          recipientPrivateKey: hiuKeyPair.privateKey,
          recipientNonce: hiuNonce,
        });
        const decoded = JSON.parse(plaintext.toString("utf8")) as FhirBundle;

        // Validate round-trip of bundle bytes.
        expect(decoded.resourceType).toBe("Bundle");
        expect(decoded.entry.length).toBe(bundle.entry.length);
        expect(validateBundleSelfConsistency(decoded).valid).toBe(true);

        // Feed the decrypted bundle back through processBundle. Because the
        // encrypt/decrypt is lossless the ingest result must mirror the
        // plain-text round-trip.
        const txn: FhirBundle = { ...decoded, type: "transaction" };
        const result = await processBundle(txn, { recordedBy: "abdm-roundtrip-test" });
        expect(result.success, `processBundle after decrypt failed: ${result.errorMessage}`).toBe(true);
      }
    );
  });
});
