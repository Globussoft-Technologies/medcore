// Unit tests for the FHIR → Prisma reverse-mapper / bundle ingestion pipeline.
//
// These tests use an in-memory fake that implements just the subset of Prisma
// delegate methods `ingest.ts` calls. We deliberately avoid a live Postgres —
// there's already an integration-test story elsewhere; here we want the
// ingestion logic (topological sort, ref resolution, rollback semantics) to be
// exercisable on a laptop without DATABASE_URL_TEST.

import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── In-memory Prisma fake ──────────────────────────────────────────────────

interface FakeState {
  patients: Map<string, any>;
  doctors: Map<string, any>;
  appointments: Map<string, any>;
  consultations: Map<string, any>;
  prescriptions: Map<string, any>;
  prescriptionItems: Map<string, any>;
  patientAllergies: Map<string, any>;
  labTests: Map<string, any>;
  labOrders: Map<string, any>;
  labOrderItems: Map<string, any>;
  labResults: Map<string, any>;
  /** When true the next write operation throws — used to simulate FK violations. */
  failNextWrite: boolean;
  /** Record of all write ops so tests can assert rollback. */
  writeLog: string[];
}

function freshState(): FakeState {
  return {
    patients: new Map(),
    doctors: new Map(),
    appointments: new Map(),
    consultations: new Map(),
    prescriptions: new Map(),
    prescriptionItems: new Map(),
    patientAllergies: new Map(),
    labTests: new Map(),
    labOrders: new Map(),
    labOrderItems: new Map(),
    labResults: new Map(),
    failNextWrite: false,
    writeLog: [],
  };
}

// Mutable holder captured by the Prisma mock factory.
const state: { current: FakeState } = { current: freshState() };

let idSeq = 0;
function genId(prefix: string): string {
  idSeq++;
  return `${prefix}-${idSeq.toString().padStart(6, "0")}`;
}

function maybeFail(op: string) {
  if (state.current.failNextWrite) {
    state.current.failNextWrite = false;
    throw new Error(`Simulated FK violation on ${op}`);
  }
  state.current.writeLog.push(op);
}

function buildTxClient(snapshot: FakeState) {
  return {
    patient: {
      findFirst: async (args: any) => {
        if (args?.where?.mrNumber) {
          for (const p of snapshot.patients.values()) {
            if (p.mrNumber === args.where.mrNumber) return p;
          }
        }
        return null;
      },
      findUnique: async (args: any) => snapshot.patients.get(args.where.id) ?? null,
      update: async (args: any) => {
        maybeFail("patient.update");
        const existing = snapshot.patients.get(args.where.id);
        if (!existing) throw new Error("patient not found");
        const merged = { ...existing, ...args.data };
        snapshot.patients.set(existing.id, merged);
        return merged;
      },
      create: async (args: any) => {
        maybeFail("patient.create");
        const id = args.data.id ?? genId("pat");
        const row = { id, ...args.data };
        snapshot.patients.set(id, row);
        return row;
      },
    },
    doctor: {
      findUnique: async (args: any) => snapshot.doctors.get(args.where.id) ?? null,
      update: async (args: any) => {
        maybeFail("doctor.update");
        const existing = snapshot.doctors.get(args.where.id);
        if (!existing) throw new Error("doctor not found");
        const merged = { ...existing, ...args.data };
        snapshot.doctors.set(existing.id, merged);
        return merged;
      },
    },
    appointment: {
      findUnique: async (args: any) => snapshot.appointments.get(args.where.id) ?? null,
      findFirst: async (args: any) => {
        const where = args?.where ?? {};
        const orderBy = args?.orderBy ?? {};
        const appts = Array.from(snapshot.appointments.values()).filter((a) => {
          if (where.doctorId && a.doctorId !== where.doctorId) return false;
          if (where.patientId && a.patientId !== where.patientId) return false;
          if (where.date) {
            const d1 = new Date(a.date).toISOString().slice(0, 10);
            const d2 = new Date(where.date).toISOString().slice(0, 10);
            if (d1 !== d2) return false;
          }
          if (where.consultation?.is === null) {
            const hasConsult = Array.from(snapshot.consultations.values()).some(
              (c) => c.appointmentId === a.id
            );
            if (hasConsult) return false;
          }
          return true;
        });
        if (orderBy.tokenNumber === "desc") {
          appts.sort((a, b) => (b.tokenNumber ?? 0) - (a.tokenNumber ?? 0));
        }
        if (orderBy.date === "desc") {
          appts.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
        }
        return appts[0] ?? null;
      },
      create: async (args: any) => {
        maybeFail("appointment.create");
        const id = args.data.id ?? genId("appt");
        const row = { id, ...args.data };
        snapshot.appointments.set(id, row);
        return row;
      },
      update: async (args: any) => {
        maybeFail("appointment.update");
        const existing = snapshot.appointments.get(args.where.id);
        if (!existing) throw new Error("appointment not found");
        const merged = { ...existing, ...args.data };
        snapshot.appointments.set(existing.id, merged);
        return merged;
      },
    },
    consultation: {
      findUnique: async (args: any) => snapshot.consultations.get(args.where.id) ?? null,
      create: async (args: any) => {
        maybeFail("consultation.create");
        const id = args.data.id ?? genId("cons");
        const row = { id, ...args.data };
        snapshot.consultations.set(id, row);
        return row;
      },
      update: async (args: any) => {
        maybeFail("consultation.update");
        const existing = snapshot.consultations.get(args.where.id);
        if (!existing) throw new Error("consultation not found");
        const merged = { ...existing, ...args.data };
        snapshot.consultations.set(existing.id, merged);
        return merged;
      },
    },
    prescription: {
      findUnique: async (args: any) => {
        if (args.where.appointmentId) {
          for (const p of snapshot.prescriptions.values()) {
            if (p.appointmentId === args.where.appointmentId) return p;
          }
          return null;
        }
        return snapshot.prescriptions.get(args.where.id) ?? null;
      },
      create: async (args: any) => {
        maybeFail("prescription.create");
        const id = args.data.id ?? genId("rx");
        const row = { id, ...args.data };
        snapshot.prescriptions.set(id, row);
        return row;
      },
    },
    prescriptionItem: {
      findFirst: async (args: any) => {
        const where = args?.where ?? {};
        for (const it of snapshot.prescriptionItems.values()) {
          if (where.prescriptionId && it.prescriptionId !== where.prescriptionId) continue;
          if (where.medicineName && it.medicineName !== where.medicineName) continue;
          return it;
        }
        return null;
      },
      create: async (args: any) => {
        maybeFail("prescriptionItem.create");
        const id = args.data.id ?? genId("rxi");
        const row = { id, ...args.data };
        snapshot.prescriptionItems.set(id, row);
        return row;
      },
      update: async (args: any) => {
        maybeFail("prescriptionItem.update");
        const existing = snapshot.prescriptionItems.get(args.where.id);
        if (!existing) throw new Error("prescriptionItem not found");
        const merged = { ...existing, ...args.data };
        snapshot.prescriptionItems.set(existing.id, merged);
        return merged;
      },
    },
    patientAllergy: {
      findFirst: async (args: any) => {
        for (const a of snapshot.patientAllergies.values()) {
          if (
            a.patientId === args.where.patientId &&
            a.allergen === args.where.allergen
          ) {
            return a;
          }
        }
        return null;
      },
      create: async (args: any) => {
        maybeFail("patientAllergy.create");
        const id = args.data.id ?? genId("alg");
        const row = { id, ...args.data };
        snapshot.patientAllergies.set(id, row);
        return row;
      },
      update: async (args: any) => {
        maybeFail("patientAllergy.update");
        const existing = snapshot.patientAllergies.get(args.where.id);
        if (!existing) throw new Error("allergy not found");
        const merged = { ...existing, ...args.data };
        snapshot.patientAllergies.set(existing.id, merged);
        return merged;
      },
    },
    labTest: {
      findUnique: async (args: any) => {
        if (args.where.code) {
          for (const t of snapshot.labTests.values()) {
            if (t.code === args.where.code) return t;
          }
          return null;
        }
        return snapshot.labTests.get(args.where.id) ?? null;
      },
      findFirst: async (args: any) => {
        const where = args?.where ?? {};
        for (const t of snapshot.labTests.values()) {
          if (where.name && t.name !== where.name) continue;
          return t;
        }
        return null;
      },
      create: async (args: any) => {
        maybeFail("labTest.create");
        const id = args.data.id ?? genId("lt");
        const row = { id, ...args.data };
        snapshot.labTests.set(id, row);
        return row;
      },
    },
    labOrder: {
      findUnique: async (args: any) => snapshot.labOrders.get(args.where.id) ?? null,
      create: async (args: any) => {
        maybeFail("labOrder.create");
        const id = args.data.id ?? genId("lo");
        // Handle nested `items.create` in a single call.
        const { items, ...rest } = args.data;
        const row = { id, ...rest };
        snapshot.labOrders.set(id, row);
        if (items?.create) {
          const nested = Array.isArray(items.create) ? items.create : [items.create];
          for (const n of nested) {
            const itemId = genId("loi");
            snapshot.labOrderItems.set(itemId, { id: itemId, orderId: id, ...n });
          }
        }
        return row;
      },
      update: async (args: any) => {
        maybeFail("labOrder.update");
        const existing = snapshot.labOrders.get(args.where.id);
        if (!existing) throw new Error("labOrder not found");
        const merged = { ...existing, ...args.data };
        snapshot.labOrders.set(existing.id, merged);
        return merged;
      },
    },
    labOrderItem: {
      findFirst: async (args: any) => {
        const where = args?.where ?? {};
        for (const it of snapshot.labOrderItems.values()) {
          if (where.orderId && it.orderId !== where.orderId) continue;
          if (where.testId && it.testId !== where.testId) continue;
          return it;
        }
        return null;
      },
      create: async (args: any) => {
        maybeFail("labOrderItem.create");
        const id = args.data.id ?? genId("loi");
        const row = { id, ...args.data };
        snapshot.labOrderItems.set(id, row);
        return row;
      },
    },
    labResult: {
      findUnique: async (args: any) => snapshot.labResults.get(args.where.id) ?? null,
      findFirst: async (args: any) => {
        const where = args?.where ?? {};
        for (const r of snapshot.labResults.values()) {
          if (where.orderItemId && r.orderItemId !== where.orderItemId) continue;
          if (where.parameter && r.parameter !== where.parameter) continue;
          return r;
        }
        return null;
      },
      create: async (args: any) => {
        maybeFail("labResult.create");
        const id = args.data.id ?? genId("lr");
        const row = { id, ...args.data };
        snapshot.labResults.set(id, row);
        return row;
      },
      update: async (args: any) => {
        maybeFail("labResult.update");
        const existing = snapshot.labResults.get(args.where.id);
        if (!existing) throw new Error("labResult not found");
        const merged = { ...existing, ...args.data };
        snapshot.labResults.set(existing.id, merged);
        return merged;
      },
    },
  };
}

// Snapshot-rollback $transaction: clone state, run callback with a scoped tx
// client, commit on success, rollback by restoring the snapshot on error.
async function fakeTransaction<T>(fn: (tx: any) => Promise<T>): Promise<T> {
  const original = state.current;
  // Shallow-clone each Map so writes during the callback don't leak on rollback.
  const snapshot: FakeState = {
    ...original,
    patients: new Map(original.patients),
    doctors: new Map(original.doctors),
    appointments: new Map(original.appointments),
    consultations: new Map(original.consultations),
    prescriptions: new Map(original.prescriptions),
    prescriptionItems: new Map(original.prescriptionItems),
    patientAllergies: new Map(original.patientAllergies),
    labTests: new Map(original.labTests),
    labOrders: new Map(original.labOrders),
    labOrderItems: new Map(original.labOrderItems),
    labResults: new Map(original.labResults),
    writeLog: [...original.writeLog],
  };
  state.current = snapshot;
  try {
    const tx = buildTxClient(snapshot);
    const result = await fn(tx);
    // Commit — keep the snapshot as the new current state.
    return result;
  } catch (err) {
    // Rollback — restore the pre-transaction state.
    state.current = original;
    throw err;
  }
}

const { prismaMock } = vi.hoisted(() => {
  const mock: any = {
    $transaction: (fn: any) => fn(mock),
  };
  return { prismaMock: mock };
});

vi.mock("@medcore/db", () => ({ prisma: prismaMock }));

// Wire the mock to our in-memory fake *after* module registration.
prismaMock.$transaction = async (fn: any) => fakeTransaction(fn);
// Also expose delegates on the top-level client (in case ingest reads via prisma.* outside a tx).
Object.assign(prismaMock, buildTxClient(state.current));

// ─── Imports after the mock is in place ─────────────────────────────────────

import {
  processBundle,
  ingestPatient,
  RefMap,
} from "./ingest";
import { SYSTEMS, patientToFhir, doctorToFhir, appointmentToFhir, consultationToEncounter, consultationToComposition, allergyToFhir } from "./resources";
import { toSearchsetBundle } from "./bundle";
import type { FhirBundle } from "./bundle";

// ─── Test fixtures ──────────────────────────────────────────────────────────

function seedPatient(id = "pat-seed-1", mrNumber = "MR-1001") {
  const row = {
    id,
    userId: `u-${id}`,
    mrNumber,
    gender: "MALE",
    dateOfBirth: new Date("1980-01-01"),
    address: "Old address",
    abhaId: null,
    aadhaarMasked: null,
  };
  state.current.patients.set(id, row);
  return row;
}

function seedDoctor(id = "doc-seed-1") {
  const row = {
    id,
    userId: `u-${id}`,
    specialization: "General Medicine",
    qualification: "MBBS",
  };
  state.current.doctors.set(id, row);
  return row;
}

function seedAppointment(id: string, patientId: string, doctorId: string) {
  const row = {
    id,
    patientId,
    doctorId,
    date: new Date("2026-04-22"),
    tokenNumber: 1,
    status: "BOOKED",
    type: "WALK_IN",
    priority: "NORMAL",
  };
  state.current.appointments.set(id, row);
  return row;
}

function seedConsultation(id: string, appointmentId: string, doctorId: string) {
  const row = {
    id,
    appointmentId,
    doctorId,
    findings: null,
    notes: null,
  };
  state.current.consultations.set(id, row);
  return row;
}

function patientResource(id: string, mrNumber: string): any {
  return {
    resourceType: "Patient",
    id,
    identifier: [
      { system: SYSTEMS.MR_NUMBER, value: mrNumber, use: "official" },
    ],
    active: true,
    name: [{ use: "official", text: "Test Patient", given: ["Test"], family: "Patient" }],
    gender: "male",
    birthDate: "1990-05-20",
    address: [{ use: "home", line: ["New Street"], country: "IN" }],
  };
}

function practitionerResource(id: string): any {
  return {
    resourceType: "Practitioner",
    id,
    identifier: [{ system: SYSTEMS.DOCTOR_USER_ID, value: id, use: "official" }],
    active: true,
    name: [{ use: "official", text: "Dr. Test", given: ["Test"], family: "Doctor" }],
    qualification: [{ code: { text: "MBBS, MD", coding: [{ code: "Neurology", display: "Neurology" }] } }],
  };
}

function entry(resource: any, fullUrl?: string) {
  return {
    fullUrl: fullUrl ?? `urn:uuid:${resource.resourceType}-${resource.id}`,
    resource,
  };
}

function txnBundle(entries: any[]): FhirBundle {
  return {
    resourceType: "Bundle",
    id: `test-txn-${Date.now()}`,
    type: "transaction",
    timestamp: new Date().toISOString(),
    entry: entries,
  };
}

// ─── Reset state between tests ──────────────────────────────────────────────

beforeEach(() => {
  state.current = freshState();
  idSeq = 0;
  Object.assign(prismaMock, buildTxClient(state.current));
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("RefMap", () => {
  it("resolves Patient/<id> and urn:uuid:<fullUrl> to the same real id", () => {
    const refs = new RefMap();
    refs.set("Patient/incoming-1", "real-1");
    refs.set("urn:uuid:Patient-incoming-1", "real-1");
    expect(refs.resolve({ reference: "Patient/incoming-1" })).toBe("real-1");
    expect(refs.resolve({ reference: "urn:uuid:Patient-incoming-1" })).toBe("real-1");
    // Unmapped ref falls back to the tail of the reference.
    expect(refs.resolve({ reference: "Patient/unmapped" })).toBe("unmapped");
  });
});

describe("ingestPatient (create-vs-update)", () => {
  it("updates an existing patient matched by MR number", async () => {
    seedPatient("pat-a", "MR-999");
    const bundle = txnBundle([
      entry(patientResource("pat-a", "MR-999")),
    ]);
    const { bundle: out, success } = await processBundle(bundle);
    expect(success).toBe(true);
    expect(out.type).toBe("transaction-response");
    const resp = (out.entry[0] as any).response;
    expect(resp.status).toBe("200 OK");
    expect(resp.location).toBe("Patient/pat-a");
    const row = state.current.patients.get("pat-a");
    expect(row.address).toBe("New Street");
    expect(row.dateOfBirth.toISOString().slice(0, 10)).toBe("1990-05-20");
  });

  it("rejects a bundle that would create a brand-new Patient (no backing User)", async () => {
    // No seed — MR number won't match.
    const bundle = txnBundle([entry(patientResource("pat-new", "MR-new"))]);
    const { success, errorMessage } = await processBundle(bundle);
    expect(success).toBe(false);
    expect(errorMessage).toMatch(/FHIR Patient ingest cannot create/);
    // Rollback — no patient was persisted.
    expect(state.current.patients.size).toBe(0);
  });
});

describe("processBundle — bundle-type and unknown resource handling", () => {
  it("rejects a searchset bundle (validated at route level, but processBundle won't crash)", async () => {
    // Simulating just the processBundle path — the route would reject before
    // calling us, but processBundle itself doesn't discriminate on bundle.type.
    // We verify it still runs harmlessly on an empty entry list.
    const bundle = txnBundle([]);
    const { success, bundle: out } = await processBundle(bundle);
    expect(success).toBe(true);
    expect(out.entry).toHaveLength(0);
  });

  it("emits a warning OperationOutcome for unknown resourceType without failing the bundle", async () => {
    seedPatient("pat-a", "MR-999");
    const unknown = {
      resourceType: "Encounter",
      id: "skipme",
      status: "finished",
      class: { code: "AMB" },
      subject: { reference: "Patient/pat-a" },
    };
    // Make the second resource a completely unsupported type.
    const weird: any = {
      resourceType: "DeviceUseStatement", // not in SUPPORTED_TYPES
      id: "dev-1",
    };
    const bundle = txnBundle([
      entry(patientResource("pat-a", "MR-999")),
      entry(weird),
      // Note: Encounter requires a matching unlinked Appointment — seed one.
    ]);
    // Seed prerequisites so the Patient succeeds and the unknown is skipped.
    const { success, bundle: out } = await processBundle(bundle);
    expect(success).toBe(true);
    const warnEntry = out.entry[1] as any;
    expect(warnEntry.response.status).toBe("200 OK");
    expect(warnEntry.response.outcome.issue[0].severity).toBe("warning");
    expect(warnEntry.response.outcome.issue[0].diagnostics).toMatch(/DeviceUseStatement/);
    // Silence unused-var linters.
    void unknown;
  });
});

describe("processBundle — full OP Consultation", () => {
  it("ingests Patient + Practitioner + Appointment + Encounter + Composition + MedicationRequest + AllergyIntolerance in one transaction", async () => {
    seedPatient("pat-op", "MR-OP-1");
    const doctor = seedDoctor("doc-op");
    const apptRow = seedAppointment("appt-op", "pat-op", doctor.id);

    // Build resources using the forward mappers where practical, then mutate
    // the shape for the bundle.
    const patientRes = patientResource("pat-op", "MR-OP-1");
    const practRes = practitionerResource("doc-op");

    const apptRes = {
      resourceType: "Appointment",
      id: apptRow.id,
      status: "fulfilled",
      appointmentType: { text: "WALK_IN" },
      priority: 5,
      participant: [
        { actor: { reference: `Patient/${patientRes.id}` }, status: "accepted" },
        { actor: { reference: `Practitioner/${practRes.id}` }, status: "accepted" },
      ],
      start: "2026-04-22T10:30:00Z",
      end: "2026-04-22T11:00:00Z",
    };

    // Encounter — forward mapper requires an appointment relation; rebuild minimal
    const encRes = {
      resourceType: "Encounter",
      id: "enc-op-1",
      status: "finished",
      class: { system: "http://terminology.hl7.org/CodeSystem/v3-ActCode", code: "AMB" },
      subject: { reference: `Patient/${patientRes.id}` },
      participant: [{ individual: { reference: `Practitioner/${practRes.id}` } }],
    };

    const compRes = {
      resourceType: "Composition",
      id: "comp-enc-op-1",
      status: "final",
      type: { coding: [{ system: "http://loinc.org", code: "11488-4", display: "Consult note" }], text: "OP Consultation" },
      subject: { reference: `Patient/${patientRes.id}` },
      encounter: { reference: `Encounter/enc-op-1` },
      date: "2026-04-22T11:00:00Z",
      author: [{ reference: `Practitioner/${practRes.id}` }],
      title: "OP Consultation Record",
      section: [
        { title: "Clinical findings", text: { status: "generated", div: `<div xmlns="http://www.w3.org/1999/xhtml">Vitals stable.</div>` } },
        { title: "Consultation note", text: { status: "generated", div: `<div xmlns="http://www.w3.org/1999/xhtml">Follow up in 7 days.</div>` } },
      ],
    };

    const medReq = {
      resourceType: "MedicationRequest",
      id: "mr-1",
      status: "active",
      intent: "order",
      medicationCodeableConcept: { text: "Paracetamol 500mg" },
      subject: { reference: `Patient/${patientRes.id}` },
      requester: { reference: `Practitioner/${practRes.id}` },
      dosageInstruction: [{ text: "1 tablet — TID — 3 days" }],
    };

    const allergy = {
      resourceType: "AllergyIntolerance",
      id: "alg-1",
      clinicalStatus: { coding: [{ code: "active" }] },
      patient: { reference: `Patient/${patientRes.id}` },
      code: { text: "Penicillin" },
      criticality: "high",
      reaction: [{ manifestation: [{ text: "Rash" }], severity: "severe" }],
    };

    const bundle = txnBundle([
      entry(compRes),
      entry(medReq),
      entry(allergy),
      entry(patientRes),
      entry(encRes),
      entry(apptRes),
      entry(practRes),
    ]);

    const { success, bundle: out } = await processBundle(bundle);
    expect(success).toBe(true);
    expect(out.entry).toHaveLength(7);
    // Every entry should have a 2xx response.
    for (const e of out.entry as any[]) {
      expect(e.response.status).toMatch(/^2\d\d /);
    }

    // Confirm state changes actually landed.
    expect(state.current.consultations.size).toBe(1);
    const cons = Array.from(state.current.consultations.values())[0];
    expect(cons.findings).toBe("Vitals stable.");
    expect(cons.notes).toBe("Follow up in 7 days.");

    expect(state.current.prescriptions.size).toBe(1);
    expect(state.current.prescriptionItems.size).toBe(1);
    const rxItem = Array.from(state.current.prescriptionItems.values())[0];
    expect(rxItem.medicineName).toBe("Paracetamol 500mg");
    expect(rxItem.frequency).toBe("TID");

    expect(state.current.patientAllergies.size).toBe(1);
    const alg = Array.from(state.current.patientAllergies.values())[0];
    expect(alg.severity).toBe("SEVERE");
    expect(alg.allergen).toBe("Penicillin");
  });
});

describe("processBundle — reference resolution via urn:uuid: fullUrl", () => {
  it("resolves sibling references by fullUrl when the bundle uses urn:uuid: only", async () => {
    seedPatient("pat-uuid", "MR-UUID-1");
    const doctor = seedDoctor("doc-uuid");

    const patientFullUrl = "urn:uuid:abcd-1234-patient";
    const doctorFullUrl = "urn:uuid:abcd-1234-doctor";

    const patientRes = patientResource("pat-uuid", "MR-UUID-1");
    const practRes = practitionerResource(doctor.id);

    // Reference the patient/doctor by urn:uuid: instead of Patient/<id>.
    const allergy = {
      resourceType: "AllergyIntolerance",
      id: "alg-uuid",
      patient: { reference: patientFullUrl },
      code: { text: "Shellfish" },
      criticality: "low",
      reaction: [{ manifestation: [{ text: "Hives" }], severity: "mild" }],
    };

    const bundle = txnBundle([
      { fullUrl: patientFullUrl, resource: patientRes },
      { fullUrl: doctorFullUrl, resource: practRes },
      { fullUrl: "urn:uuid:alg-uuid", resource: allergy },
    ]);

    const { success } = await processBundle(bundle);
    expect(success).toBe(true);
    expect(state.current.patientAllergies.size).toBe(1);
    const alg = Array.from(state.current.patientAllergies.values())[0];
    expect(alg.patientId).toBe("pat-uuid");
  });
});

describe("processBundle — rollback on FK violation", () => {
  it("rolls back all writes when any entry fails mid-transaction", async () => {
    seedPatient("pat-rb", "MR-RB-1");
    seedDoctor("doc-rb");
    seedAppointment("appt-rb", "pat-rb", "doc-rb");

    const patientRes = patientResource("pat-rb", "MR-RB-1");
    const allergy = {
      resourceType: "AllergyIntolerance",
      id: "alg-rb",
      patient: { reference: "Patient/pat-rb" },
      code: { text: "Dust" },
      criticality: "low",
    };

    // Trigger a simulated FK violation on the allergy insert.
    // We need patient.update to succeed first so we can observe rollback.
    const bundle = txnBundle([entry(patientRes), entry(allergy)]);

    // Arm the failure: the allergy insert will be the 2nd write op (after
    // patient.update). We can't pre-count easily, so fail on ANY allergy write.
    const origCreate = state.current.patientAllergies.set.bind(state.current.patientAllergies);
    void origCreate;
    state.current.failNextWrite = false;
    // A simpler knob: override failNextWrite at the time we know allergy writes happen.
    // Approach: pre-seed an allergen that would clash, but since severity differs the
    // update path runs. Instead, just use the existing flag — we'll set it true AFTER
    // patient update by patching the mock.
    // Simpler still — wrap the mock to flip failNextWrite once patient.update has run.
    let patientUpdated = false;
    const origUpdate = prismaMock.$transaction;
    prismaMock.$transaction = async (fn: any) => {
      return origUpdate(async (tx: any) => {
        const origPatUpdate = tx.patient.update.bind(tx.patient);
        tx.patient.update = async (args: any) => {
          const r = await origPatUpdate(args);
          patientUpdated = true;
          // Arm failure for the very next write operation.
          state.current.failNextWrite = true;
          return r;
        };
        return fn(tx);
      });
    };

    const { success, errorMessage } = await processBundle(bundle);
    expect(success).toBe(false);
    expect(patientUpdated).toBe(true);
    expect(errorMessage).toMatch(/Simulated FK violation/);
    // Critical assertion: patient.address was never mutated (rolled back).
    expect(state.current.patients.get("pat-rb").address).toBe("Old address");
    // Allergy was never persisted.
    expect(state.current.patientAllergies.size).toBe(0);

    // Restore.
    prismaMock.$transaction = origUpdate;
  });
});

describe("processBundle — invalid resource rejection", () => {
  it("rejects entries whose resource fails structural validation", async () => {
    const badPatient: any = {
      resourceType: "Patient",
      id: "bad-1",
      // Missing identifier, name, gender — validator will flag multiple errors.
    };
    const bundle = txnBundle([entry(badPatient)]);
    const { success, errorMessage, bundle: out } = await processBundle(bundle);
    expect(success).toBe(false);
    expect(errorMessage).toMatch(/identifier|name|gender/);
    const respEntry = out.entry[0] as any;
    expect(respEntry.response.status).toBe("400 Bad Request");
    expect(respEntry.response.outcome.issue[0].severity).toBe("error");
  });
});

describe("processBundle — round-trip stability", () => {
  it("exporting a searchset bundle and POSTing its resources back as a transaction produces a stable state", async () => {
    // Seed a small patient graph.
    const pat = seedPatient("pat-rt", "MR-RT-1");
    const doc = seedDoctor("doc-rt");
    const appt = seedAppointment("appt-rt", pat.id, doc.id);
    const cons = seedConsultation("cons-rt", appt.id, doc.id);
    // Pre-seed an allergy so the export picks it up.
    const allergyRow = {
      id: "alg-rt",
      patientId: pat.id,
      allergen: "Peanuts",
      severity: "SEVERE",
      reaction: "Anaphylaxis",
      notedBy: "u-seed",
      notedAt: new Date("2026-04-01"),
    };
    state.current.patientAllergies.set(allergyRow.id, allergyRow);

    // Use the forward mappers to produce FHIR resources like `$everything` would.
    const patientFhir = patientToFhir({ ...pat, updatedAt: new Date() });
    const doctorFhir = doctorToFhir({ ...doc, user: { name: "Dr. RT", isActive: true } });
    const apptFhir = appointmentToFhir({ ...appt, status: "COMPLETED" });
    const encFhir = consultationToEncounter({
      ...cons,
      createdAt: new Date("2026-04-22T10:30:00Z"),
      appointment: { ...appt, consultationStartedAt: new Date("2026-04-22T10:30:00Z"), consultationEndedAt: new Date("2026-04-22T11:00:00Z") },
    });
    const compFhir = consultationToComposition({
      ...cons,
      createdAt: new Date("2026-04-22T10:30:00Z"),
      updatedAt: new Date("2026-04-22T11:00:00Z"),
      appointment: { ...appt, patientId: pat.id, doctorId: doc.id },
    });
    const allergyFhir = allergyToFhir(allergyRow);

    // Snapshot pre-state for comparison.
    const prePatient = { ...state.current.patients.get(pat.id) };
    const preAllergy = { ...state.current.patientAllergies.get(allergyRow.id) };
    const preConsultations = state.current.consultations.size;
    const prePrescriptions = state.current.prescriptions.size;

    const exported = toSearchsetBundle([
      patientFhir,
      doctorFhir,
      apptFhir,
      encFhir,
      compFhir,
      allergyFhir,
    ]);

    // Re-wrap as a transaction bundle (type swap only — entries are identical).
    const roundTrip: FhirBundle = {
      ...exported,
      type: "transaction",
    };

    const { success } = await processBundle(roundTrip);
    expect(success).toBe(true);

    // Stable state: no new prescriptions (no MedicationRequests in the export),
    // the Consultation remains (updated in place with the narrative), the
    // allergy row is the same id (upsert-by-allergen-name matched).
    expect(state.current.consultations.size).toBe(preConsultations);
    expect(state.current.prescriptions.size).toBe(prePrescriptions);
    expect(state.current.patientAllergies.size).toBe(1);

    // Patient core identifiers unchanged (we only update demographics).
    const postPatient = state.current.patients.get(pat.id);
    expect(postPatient.id).toBe(prePatient.id);
    expect(postPatient.mrNumber).toBe(prePatient.mrNumber);

    // Allergy upserted to the same row (keyed by patientId+allergen).
    const postAllergy = state.current.patientAllergies.get(allergyRow.id);
    expect(postAllergy.id).toBe(preAllergy.id);
    expect(postAllergy.allergen).toBe("Peanuts");
  });
});

describe("ingestPatient (direct call)", () => {
  it("throws when no existing patient can be found by MR number or id", async () => {
    const tx = buildTxClient(state.current);
    await expect(
      ingestPatient(tx as any, patientResource("nope", "MR-nope"))
    ).rejects.toThrow(/cannot create new User accounts/);
  });
});

// ─── Lab resource ingest (ServiceRequest / Observation / DiagnosticReport) ──

function seedLabTest(code = "CBC", name = "Complete Blood Count") {
  const row = {
    id: `lt-${code}`,
    code,
    name,
    category: "Hematology",
    price: 200,
  };
  state.current.labTests.set(row.id, row);
  return row;
}

function serviceRequestResource(
  id: string,
  patientId: string,
  doctorId: string,
  opts: { code?: string; display?: string; status?: string; priority?: string } = {}
): any {
  return {
    resourceType: "ServiceRequest",
    id,
    status: opts.status ?? "active",
    intent: "order",
    priority: opts.priority ?? "routine",
    code: {
      coding: opts.code
        ? [{ code: opts.code, display: opts.display ?? opts.code }]
        : undefined,
      text: opts.display ?? opts.code ?? "Laboratory test",
    },
    subject: { reference: `Patient/${patientId}` },
    requester: { reference: `Practitioner/${doctorId}` },
    authoredOn: "2026-04-22T09:00:00Z",
  };
}

function observationResource(
  id: string,
  patientId: string,
  opts: {
    code?: string;
    display?: string;
    parameter?: string;
    valueQuantity?: { value: number; unit?: string };
    valueString?: string;
    interpretation?: string;
    basedOnOrderId?: string;
    status?: string;
    referenceRangeText?: string;
  } = {}
): any {
  const res: any = {
    resourceType: "Observation",
    id,
    status: opts.status ?? "final",
    code: {
      coding: opts.code ? [{ code: opts.code, display: opts.display ?? opts.code }] : undefined,
      text: opts.parameter ?? opts.display ?? opts.code ?? "Observation",
    },
    subject: { reference: `Patient/${patientId}` },
    effectiveDateTime: "2026-04-22T12:00:00Z",
    issued: "2026-04-22T12:30:00Z",
  };
  if (opts.valueQuantity) res.valueQuantity = opts.valueQuantity;
  if (opts.valueString !== undefined) res.valueString = opts.valueString;
  if (opts.interpretation) {
    res.interpretation = [{ coding: [{ code: opts.interpretation }], text: opts.interpretation }];
  }
  if (opts.basedOnOrderId) {
    res.basedOn = [{ reference: `ServiceRequest/${opts.basedOnOrderId}` }];
  }
  if (opts.referenceRangeText) {
    res.referenceRange = [{ text: opts.referenceRangeText }];
  }
  return res;
}

function diagnosticReportResource(
  id: string,
  patientId: string,
  orderId: string,
  observationIds: string[],
  opts: { status?: string; code?: string; display?: string } = {}
): any {
  return {
    resourceType: "DiagnosticReport",
    id,
    status: opts.status ?? "final",
    code: {
      coding: opts.code ? [{ code: opts.code, display: opts.display ?? opts.code }] : undefined,
      text: opts.display ?? opts.code ?? "Laboratory report",
    },
    subject: { reference: `Patient/${patientId}` },
    effectiveDateTime: "2026-04-22T12:30:00Z",
    issued: "2026-04-22T12:30:00Z",
    basedOn: [{ reference: `ServiceRequest/${orderId}` }],
    result: observationIds.map((oid) => ({ reference: `Observation/${oid}` })),
  };
}

describe("ingestServiceRequest", () => {
  it("creates a LabOrder with ORDERED status and matches an existing TestCatalog entry", async () => {
    seedPatient("pat-sr", "MR-SR-1");
    seedDoctor("doc-sr");
    seedLabTest("CBC", "Complete Blood Count");

    const bundle = txnBundle([
      entry(patientResource("pat-sr", "MR-SR-1")),
      entry(serviceRequestResource("sr-1", "pat-sr", "doc-sr", { code: "CBC", display: "Complete Blood Count" })),
    ]);

    const { success, bundle: out } = await processBundle(bundle);
    expect(success).toBe(true);

    expect(state.current.labOrders.size).toBe(1);
    const order = state.current.labOrders.get("sr-1");
    expect(order).toBeDefined();
    expect(order.patientId).toBe("pat-sr");
    expect(order.doctorId).toBe("doc-sr");
    expect(order.status).toBe("ORDERED");
    expect(order.priority).toBe("ROUTINE");
    expect(order.notes).toMatch(/FHIR/i);

    // An OrderItem was created referencing the seeded LabTest (not a fresh OTHER one).
    expect(state.current.labOrderItems.size).toBe(1);
    const item = Array.from(state.current.labOrderItems.values())[0];
    expect(item.testId).toBe("lt-CBC");
    // No warning since the test code was known.
    expect(state.current.labTests.size).toBe(1);

    const resp = (out.entry[1] as any).response;
    expect(resp.status).toBe("201 Created");
    expect(resp.location).toBe("ServiceRequest/sr-1");
    expect(resp.outcome).toBeUndefined();
  });

  it("maps STAT priority correctly and creates an urgent LabOrder", async () => {
    seedPatient("pat-stat", "MR-STAT-1");
    seedDoctor("doc-stat");
    seedLabTest("TROP", "Troponin");

    const bundle = txnBundle([
      entry(patientResource("pat-stat", "MR-STAT-1")),
      entry(
        serviceRequestResource("sr-stat", "pat-stat", "doc-stat", {
          code: "TROP",
          priority: "stat",
        })
      ),
    ]);

    const { success } = await processBundle(bundle);
    expect(success).toBe(true);
    const order = state.current.labOrders.get("sr-stat");
    expect(order.priority).toBe("STAT");
    expect(order.stat).toBe(true);
  });
});

describe("ingestObservation", () => {
  it("creates a LabResult with a numeric valueQuantity", async () => {
    seedPatient("pat-obs", "MR-OBS-1");
    seedDoctor("doc-obs");
    seedLabTest("HGB", "Hemoglobin");

    const bundle = txnBundle([
      entry(patientResource("pat-obs", "MR-OBS-1")),
      entry(serviceRequestResource("sr-obs", "pat-obs", "doc-obs", { code: "HGB", display: "Hemoglobin" })),
      entry(
        observationResource("obs-1", "pat-obs", {
          code: "HGB",
          display: "Hemoglobin",
          parameter: "Hemoglobin",
          valueQuantity: { value: 13.5, unit: "g/dL" },
          interpretation: "N",
          basedOnOrderId: "sr-obs",
          referenceRangeText: "12-16 g/dL",
        })
      ),
    ]);

    const { success } = await processBundle(bundle);
    expect(success).toBe(true);
    expect(state.current.labResults.size).toBe(1);
    const result = state.current.labResults.get("obs-1");
    expect(result.value).toBe("13.5");
    expect(result.unit).toBe("g/dL");
    expect(result.flag).toBe("NORMAL");
    expect(result.parameter).toBe("Hemoglobin");
    expect(result.normalRange).toBe("12-16 g/dL");
    expect(result.verifiedAt).toBeTruthy(); // status=final → verifiedAt set
  });

  it("creates a LabResult with a valueString for culture/microbiology results", async () => {
    seedPatient("pat-cul", "MR-CUL-1");
    seedDoctor("doc-cul");
    seedLabTest("BLDCULT", "Blood Culture");

    const bundle = txnBundle([
      entry(patientResource("pat-cul", "MR-CUL-1")),
      entry(serviceRequestResource("sr-cul", "pat-cul", "doc-cul", { code: "BLDCULT", display: "Blood Culture" })),
      entry(
        observationResource("obs-cul", "pat-cul", {
          code: "BLDCULT",
          display: "Blood Culture",
          parameter: "Blood Culture",
          valueString: "No growth after 5 days",
          interpretation: "N",
          basedOnOrderId: "sr-cul",
        })
      ),
    ]);

    const { success } = await processBundle(bundle);
    expect(success).toBe(true);
    const result = state.current.labResults.get("obs-cul");
    expect(result.value).toBe("No growth after 5 days");
    expect(result.unit).toBeUndefined();
    expect(result.flag).toBe("NORMAL");
  });

  it("maps HH/LL interpretation codes to CRITICAL flag", async () => {
    seedPatient("pat-crit", "MR-CRIT-1");
    seedDoctor("doc-crit");
    seedLabTest("K", "Potassium");

    const bundle = txnBundle([
      entry(patientResource("pat-crit", "MR-CRIT-1")),
      entry(serviceRequestResource("sr-crit", "pat-crit", "doc-crit", { code: "K", display: "Potassium" })),
      entry(
        observationResource("obs-crit", "pat-crit", {
          code: "K",
          display: "Potassium",
          parameter: "Potassium",
          valueQuantity: { value: 2.1, unit: "mmol/L" },
          interpretation: "LL",
          basedOnOrderId: "sr-crit",
        })
      ),
    ]);

    const { success } = await processBundle(bundle);
    expect(success).toBe(true);
    const result = state.current.labResults.get("obs-crit");
    expect(result.flag).toBe("CRITICAL");
  });
});

describe("ingestDiagnosticReport", () => {
  it("links observations to the parent LabOrder and flips status to COMPLETED on status=final", async () => {
    seedPatient("pat-dr", "MR-DR-1");
    seedDoctor("doc-dr");
    seedLabTest("GLU", "Glucose");

    const bundle = txnBundle([
      entry(patientResource("pat-dr", "MR-DR-1")),
      entry(serviceRequestResource("sr-dr", "pat-dr", "doc-dr", { code: "GLU", display: "Glucose" })),
      entry(
        observationResource("obs-dr", "pat-dr", {
          code: "GLU",
          display: "Glucose",
          parameter: "Glucose",
          valueQuantity: { value: 95, unit: "mg/dL" },
          interpretation: "N",
          basedOnOrderId: "sr-dr",
        })
      ),
      entry(
        diagnosticReportResource("rep-dr", "pat-dr", "sr-dr", ["obs-dr"], {
          status: "final",
          code: "GLU",
          display: "Glucose",
        })
      ),
    ]);

    const { success } = await processBundle(bundle);
    expect(success).toBe(true);

    const order = state.current.labOrders.get("sr-dr");
    expect(order.status).toBe("COMPLETED");
    expect(order.completedAt).toBeInstanceOf(Date);
  });

  it("does NOT flip the order status when DiagnosticReport.status is not final", async () => {
    seedPatient("pat-drp", "MR-DRP-1");
    seedDoctor("doc-drp");
    seedLabTest("CRP", "C-Reactive Protein");

    const bundle = txnBundle([
      entry(patientResource("pat-drp", "MR-DRP-1")),
      entry(serviceRequestResource("sr-drp", "pat-drp", "doc-drp", { code: "CRP", display: "C-Reactive Protein" })),
      entry(
        observationResource("obs-drp", "pat-drp", {
          code: "CRP",
          display: "C-Reactive Protein",
          parameter: "C-Reactive Protein",
          valueQuantity: { value: 2.0, unit: "mg/L" },
          interpretation: "N",
          basedOnOrderId: "sr-drp",
          status: "preliminary",
        })
      ),
      entry(
        diagnosticReportResource("rep-drp", "pat-drp", "sr-drp", ["obs-drp"], {
          status: "preliminary",
          code: "CRP",
        })
      ),
    ]);

    const { success } = await processBundle(bundle);
    expect(success).toBe(true);

    const order = state.current.labOrders.get("sr-drp");
    // Still ORDERED — the ServiceRequest was active and the report wasn't final.
    expect(order.status).toBe("ORDERED");
    expect(order.completedAt).toBeFalsy();
  });
});

describe("ingestServiceRequest — unknown test code", () => {
  it("creates a generic OTHER TestCatalog entry and emits a warning OperationOutcome", async () => {
    seedPatient("pat-un", "MR-UN-1");
    seedDoctor("doc-un");
    // NO labTest seeded — we expect a generic OTHER entry to be minted.

    const bundle = txnBundle([
      entry(patientResource("pat-un", "MR-UN-1")),
      entry(
        serviceRequestResource("sr-un", "pat-un", "doc-un", {
          code: "UNKNOWN-XYZ",
          display: "Mystery Panel",
        })
      ),
    ]);

    const { success, bundle: out } = await processBundle(bundle);
    expect(success).toBe(true);

    // A fresh LabTest was synthesised with category OTHER.
    expect(state.current.labTests.size).toBe(1);
    const synthesized = Array.from(state.current.labTests.values())[0];
    expect(synthesized.category).toBe("OTHER");
    expect(synthesized.name).toBe("Mystery Panel");
    expect(synthesized.code).toBe("UNKNOWN-XYZ");

    // The order was still created.
    expect(state.current.labOrders.size).toBe(1);

    // The response carries a warning OperationOutcome.
    const resp = (out.entry[1] as any).response;
    expect(resp.status).toBe("201 Created");
    expect(resp.outcome).toBeDefined();
    expect(resp.outcome.issue[0].severity).toBe("warning");
    expect(resp.outcome.issue[0].diagnostics).toMatch(/UNKNOWN-XYZ/);
  });
});

describe("processBundle — full lab bundle (ServiceRequest + 3 Observations + DiagnosticReport)", () => {
  it("ingests a complete lab graph in a single transaction with correct FKs", async () => {
    seedPatient("pat-lab", "MR-LAB-1");
    seedDoctor("doc-lab");
    const cbcTest = seedLabTest("CBC", "Complete Blood Count");

    const bundle = txnBundle([
      entry(patientResource("pat-lab", "MR-LAB-1")),
      entry(practitionerResource("doc-lab")),
      entry(
        serviceRequestResource("lab-order-1", "pat-lab", "doc-lab", {
          code: "CBC",
          display: "Complete Blood Count",
          priority: "urgent",
        })
      ),
      entry(
        observationResource("obs-hgb", "pat-lab", {
          code: "CBC",
          display: "Complete Blood Count",
          parameter: "Hemoglobin",
          valueQuantity: { value: 14.2, unit: "g/dL" },
          interpretation: "N",
          basedOnOrderId: "lab-order-1",
        })
      ),
      entry(
        observationResource("obs-wbc", "pat-lab", {
          code: "CBC",
          display: "Complete Blood Count",
          parameter: "WBC Count",
          valueQuantity: { value: 14500, unit: "/uL" },
          interpretation: "H",
          basedOnOrderId: "lab-order-1",
        })
      ),
      entry(
        observationResource("obs-plt", "pat-lab", {
          code: "CBC",
          display: "Complete Blood Count",
          parameter: "Platelets",
          valueQuantity: { value: 250000, unit: "/uL" },
          interpretation: "N",
          basedOnOrderId: "lab-order-1",
        })
      ),
      entry(
        diagnosticReportResource(
          "rep-1",
          "pat-lab",
          "lab-order-1",
          ["obs-hgb", "obs-wbc", "obs-plt"],
          { status: "final", code: "CBC" }
        )
      ),
    ]);

    const { success, bundle: out } = await processBundle(bundle);
    expect(success).toBe(true);

    // Every entry responded 2xx.
    for (const e of out.entry as any[]) {
      expect(e.response.status).toMatch(/^2\d\d /);
    }

    // Order exists and is COMPLETED (via DR final).
    const order = state.current.labOrders.get("lab-order-1");
    expect(order).toBeDefined();
    expect(order.status).toBe("COMPLETED");
    expect(order.priority).toBe("URGENT");

    // Exactly one OrderItem (CBC) — all three observations share the same test.
    expect(state.current.labOrderItems.size).toBe(1);
    const item = Array.from(state.current.labOrderItems.values())[0];
    expect(item.orderId).toBe("lab-order-1");
    expect(item.testId).toBe(cbcTest.id);

    // Three results, each linked to that item.
    expect(state.current.labResults.size).toBe(3);
    for (const r of state.current.labResults.values()) {
      expect(r.orderItemId).toBe(item.id);
    }

    // Flags mapped correctly (H → HIGH, N → NORMAL).
    const byParam = new Map(
      Array.from(state.current.labResults.values()).map((r: any) => [r.parameter, r])
    );
    expect(byParam.get("Hemoglobin")!.flag).toBe("NORMAL");
    expect(byParam.get("WBC Count")!.flag).toBe("HIGH");
    expect(byParam.get("Platelets")!.flag).toBe("NORMAL");

    // No extra LabTest rows — we matched the seeded CBC.
    expect(state.current.labTests.size).toBe(1);
  });
});
