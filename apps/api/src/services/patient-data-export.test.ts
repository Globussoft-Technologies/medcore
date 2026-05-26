// Unit tests for the DPDP-mandated patient-data-export service.
//
// What / which modules / why:
//   - Validates `collectPatientData` aggregates rows across the full Stage-1
//     patient surface (17 sub-queries — appointments, prescriptions, lab
//     orders, invoices, AI sessions, etc.) and is partial-failure resilient
//     (one failing sub-query must NOT tank the bundle).
//   - Validates `buildJsonExport`, `buildFhirExport`, `buildPdfExport` —
//     the three artifact formats DPDP Act 2023 § Right-to-Data-Portability
//     hands out (JSON monolith, FHIR R4 transaction bundle, PDF summary).
//   - Validates `buildExport`'s format-switch dispatch + the unknown-format
//     guard rail.
//   - Validates `countRecentExports` 24h-window count + `exportFilename`
//     UUID-suffix entropy + `EXPORT_FORMATS` / `EXPORT_WINDOW_MAX` exports.
//   - Validates `runExportWorker` end-to-end: QUEUED → PROCESSING → READY
//     happy path, the non-QUEUED short-circuit, the missing-row noop, and
//     the FAILED branch on builder error. Tenant-context propagation via
//     `runWithTenant` is exercised by seeding `row.tenantId`.
//   - Prisma is mocked end-to-end at the `@medcore/db` import boundary +
//     the back-compat re-export shims (`./tenant-prisma`, `./tenant-context`).
//     No DB hit. FHIR mappers are mocked thinly so we can assert the
//     dispatch shape without depending on resource-mapper internals
//     (those have their own unit tests under fhir/).
//
// Pattern reference: `audio-retention.test.ts` (hoisted prismaMock +
// `vi.mock("@medcore/db", ...)`).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";

// ─── Hoisted Prisma + FHIR-mapper mocks ────────────────────────────────────

const { prismaMock, runWithTenantMock, fhirMocks } = vi.hoisted(() => {
  const makeFindMany = () => vi.fn().mockResolvedValue([]);
  const prismaMock = {
    patientDataExport: {
      count: vi.fn().mockResolvedValue(0),
      findUnique: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
    },
    patient: {
      findUnique: vi.fn(),
    },
    appointment: { findMany: makeFindMany() },
    consultation: { findMany: makeFindMany() },
    prescription: { findMany: makeFindMany() },
    labOrder: { findMany: makeFindMany() },
    admission: { findMany: makeFindMany() },
    patientAllergy: { findMany: makeFindMany() },
    chronicCondition: { findMany: makeFindMany() },
    familyHistory: { findMany: makeFindMany() },
    immunization: { findMany: makeFindMany() },
    medicationOrder: { findMany: makeFindMany() },
    patientDocument: { findMany: makeFindMany() },
    invoice: { findMany: makeFindMany() },
    insuranceClaim: { findMany: makeFindMany() },
    aITriageSession: { findMany: makeFindMany() },
    aIScribeSession: { findMany: makeFindMany() },
    symptomDiaryEntry: { findMany: makeFindMany() },
    adherenceSchedule: { findMany: makeFindMany() },
  };
  return {
    prismaMock,
    runWithTenantMock: vi.fn(
      async (_t: string, fn: () => Promise<unknown>) => fn(),
    ),
    fhirMocks: {
      patientToFhir: vi.fn((p: { id?: string }) => ({
        resourceType: "Patient",
        id: p?.id ?? "p1",
      })),
      doctorToFhir: vi.fn((d: { id?: string }) => ({
        resourceType: "Practitioner",
        id: d?.id ?? "d1",
      })),
      appointmentToFhir: vi.fn((a: { id?: string }) => ({
        resourceType: "Appointment",
        id: a?.id ?? "a1",
      })),
      consultationToEncounter: vi.fn((c: { id?: string }) => ({
        resourceType: "Encounter",
        id: c?.id ?? "e1",
      })),
      consultationToComposition: vi.fn((c: { id?: string }) => ({
        resourceType: "Composition",
        id: c?.id ?? "c1",
      })),
      prescriptionToMedicationRequests: vi.fn((r: { id?: string }) => [
        { resourceType: "MedicationRequest", id: `${r?.id ?? "r1"}-mr` },
      ]),
      labOrderToServiceRequest: vi.fn((o: { id?: string }) => ({
        resourceType: "ServiceRequest",
        id: o?.id ?? "sr1",
      })),
      labResultToObservation: vi.fn((r: { id?: string }) => ({
        resourceType: "Observation",
        id: r?.id ?? "obs1",
      })),
      labOrderToDiagnosticReport: vi.fn(
        (o: { id?: string }, _resultIds?: string[]) => ({
          resourceType: "DiagnosticReport",
          id: `${o?.id ?? "dr1"}-dr`,
        }),
      ),
      allergyToFhir: vi.fn((al: { id?: string }) => ({
        resourceType: "AllergyIntolerance",
        id: al?.id ?? "al1",
      })),
      toTransactionBundle: vi.fn(
        (resources: Array<{ resourceType: string; id?: string }>) => ({
          resourceType: "Bundle",
          type: "transaction",
          entry: resources.map((r) => ({ resource: r })),
        }),
      ),
    },
  };
});

vi.mock("@medcore/db", () => ({
  prisma: prismaMock,
  tenantScopedPrisma: prismaMock,
  runWithTenant: runWithTenantMock,
  getTenantId: () => undefined,
  requireTenantId: () => {
    throw new Error("tenant ctx required");
  },
}));

vi.mock("./tenant-prisma", () => ({ tenantScopedPrisma: prismaMock }));
vi.mock("./tenant-context", () => ({ runWithTenant: runWithTenantMock }));

vi.mock("./fhir/resources", () => ({
  patientToFhir: fhirMocks.patientToFhir,
  doctorToFhir: fhirMocks.doctorToFhir,
  appointmentToFhir: fhirMocks.appointmentToFhir,
  consultationToEncounter: fhirMocks.consultationToEncounter,
  consultationToComposition: fhirMocks.consultationToComposition,
  prescriptionToMedicationRequests: fhirMocks.prescriptionToMedicationRequests,
  labOrderToServiceRequest: fhirMocks.labOrderToServiceRequest,
  labResultToObservation: fhirMocks.labResultToObservation,
  labOrderToDiagnosticReport: fhirMocks.labOrderToDiagnosticReport,
  allergyToFhir: fhirMocks.allergyToFhir,
}));

vi.mock("./fhir/bundle", () => ({
  toTransactionBundle: fhirMocks.toTransactionBundle,
}));

// ─── Import under test (after mocks are registered) ────────────────────────

import {
  EXPORT_FORMATS,
  EXPORT_WINDOW_MAX,
  EXPORT_MAX_MS,
  EXPORT_DIR,
  countRecentExports,
  collectPatientData,
  buildJsonExport,
  buildFhirExport,
  buildPdfExport,
  buildExport,
  exportFilename,
  runExportWorker,
  scheduleExportWorker,
  type PatientDataBag,
} from "./patient-data-export";

// ─── Test fixtures ─────────────────────────────────────────────────────────

const seedPatient = {
  id: "pat-1",
  userId: "user-1",
  mrNumber: "MR-001",
  gender: "FEMALE",
  dateOfBirth: new Date("1990-01-15").toISOString(),
  abhaId: "ABHA-123",
  user: {
    id: "user-1",
    name: "Test Patient",
    email: "pat@test.local",
    phone: "+91-9000000000",
  },
};

const minimalBag = (): PatientDataBag => ({
  exportedAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
  patient: seedPatient,
  appointments: [],
  consultations: [],
  prescriptions: [],
  labOrders: [],
  admissions: [],
  allergies: [],
  chronicConditions: [],
  familyHistory: [],
  immunizations: [],
  medicationOrders: [],
  documents: [],
  invoices: [],
  insuranceClaims: [],
  aiTriageSessions: [],
  aiScribeSessions: [],
  symptomDiary: [],
  adherenceSchedules: [],
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
  // Restore default behaviour after clearAllMocks wipes the implementations.
  runWithTenantMock.mockImplementation(
    async (_t: string, fn: () => Promise<unknown>) => fn(),
  );
  // Re-arm every findMany to default [] (clearAllMocks wipes return values
  // but keeps implementations registered via mockResolvedValue gone too).
  for (const k of Object.keys(prismaMock) as Array<keyof typeof prismaMock>) {
    const delegate = prismaMock[k] as Record<string, ReturnType<typeof vi.fn>>;
    if (delegate.findMany) delegate.findMany.mockResolvedValue([]);
  }
  prismaMock.patient.findUnique.mockResolvedValue(seedPatient);
  prismaMock.patientDataExport.count.mockResolvedValue(0);
  prismaMock.patientDataExport.update.mockResolvedValue({});
  fhirMocks.patientToFhir.mockImplementation((p: { id?: string }) => ({
    resourceType: "Patient",
    id: p?.id ?? "p1",
  }));
});

// ─── Constants ─────────────────────────────────────────────────────────────

describe("module-level constants", () => {
  it("exposes the three supported export formats", () => {
    expect(EXPORT_FORMATS).toEqual(["json", "fhir", "pdf"]);
  });
  it("uses the documented 24h rate-limit window (3 per window)", () => {
    expect(EXPORT_WINDOW_MAX).toBe(3);
    expect(EXPORT_MAX_MS).toBe(10 * 60 * 1000);
  });
  it("places exports under uploads/exports/ (NOT uploads/ehr/)", () => {
    expect(EXPORT_DIR).toBe(path.join(process.cwd(), "uploads", "exports"));
    expect(EXPORT_DIR).not.toMatch(/uploads[\\/]ehr/);
  });
});

// ─── countRecentExports ────────────────────────────────────────────────────

describe("countRecentExports", () => {
  it("returns the count from Prisma for the 24h window", async () => {
    prismaMock.patientDataExport.count.mockResolvedValueOnce(2);
    const n = await countRecentExports("pat-1");
    expect(n).toBe(2);
    expect(prismaMock.patientDataExport.count).toHaveBeenCalledTimes(1);
    const args = prismaMock.patientDataExport.count.mock.calls[0][0];
    expect(args.where.patientId).toBe("pat-1");
    expect(args.where.requestedAt.gte).toBeInstanceOf(Date);
    // The "since" cutoff should be roughly 24h before now (allow 5s of skew).
    const since = args.where.requestedAt.gte as Date;
    const expected = Date.now() - 24 * 60 * 60 * 1000;
    expect(Math.abs(since.getTime() - expected)).toBeLessThan(5_000);
  });

  it("returns 0 when the patient has no recent exports", async () => {
    prismaMock.patientDataExport.count.mockResolvedValueOnce(0);
    await expect(countRecentExports("pat-2")).resolves.toBe(0);
  });
});

// ─── collectPatientData ────────────────────────────────────────────────────

describe("collectPatientData", () => {
  it("throws when the patient row is missing", async () => {
    prismaMock.patient.findUnique.mockResolvedValueOnce(null);
    await expect(collectPatientData("missing")).rejects.toThrow(
      /Patient missing not found/,
    );
  });

  it("returns a fully-populated bag with every sub-array even when seeds are empty", async () => {
    const bag = await collectPatientData("pat-1");
    expect(bag.patient).toEqual(seedPatient);
    expect(typeof bag.exportedAt).toBe("string");
    // exportedAt must be a valid ISO-8601 string
    expect(() => new Date(bag.exportedAt).toISOString()).not.toThrow();
    // Every category should exist as an array (defensive `[]` fallback).
    for (const key of [
      "appointments",
      "consultations",
      "prescriptions",
      "labOrders",
      "admissions",
      "allergies",
      "chronicConditions",
      "familyHistory",
      "immunizations",
      "medicationOrders",
      "documents",
      "invoices",
      "insuranceClaims",
      "aiTriageSessions",
      "aiScribeSessions",
      "symptomDiary",
      "adherenceSchedules",
    ] as const) {
      expect(Array.isArray(bag[key])).toBe(true);
    }
  });

  it("returns the seeded rows verbatim in the bag", async () => {
    const seedAppt = { id: "appt-1", patientId: "pat-1", date: new Date() };
    const seedRx = { id: "rx-1", items: [{ medicineName: "Paracetamol" }] };
    prismaMock.appointment.findMany.mockResolvedValueOnce([seedAppt]);
    prismaMock.prescription.findMany.mockResolvedValueOnce([seedRx]);
    const bag = await collectPatientData("pat-1");
    expect(bag.appointments).toEqual([seedAppt]);
    expect(bag.prescriptions).toEqual([seedRx]);
  });

  it("is partial-failure resilient — one sub-query throwing returns [] for that branch and the others still populate", async () => {
    prismaMock.appointment.findMany.mockRejectedValueOnce(
      new Error("missing index"),
    );
    const seedInv = { id: "inv-1", items: [], payments: [] };
    prismaMock.invoice.findMany.mockResolvedValueOnce([seedInv]);
    const bag = await collectPatientData("pat-1");
    expect(bag.appointments).toEqual([]); // failed sub-query → []
    expect(bag.invoices).toEqual([seedInv]); // succeeded
  });

  it("queries patientAllergy / chronicCondition / familyHistory / immunization by patientId", async () => {
    await collectPatientData("pat-1");
    expect(prismaMock.patientAllergy.findMany).toHaveBeenCalledWith({
      where: { patientId: "pat-1" },
    });
    expect(prismaMock.chronicCondition.findMany).toHaveBeenCalledWith({
      where: { patientId: "pat-1" },
    });
    expect(prismaMock.familyHistory.findMany).toHaveBeenCalledWith({
      where: { patientId: "pat-1" },
    });
    expect(prismaMock.immunization.findMany).toHaveBeenCalledWith({
      where: { patientId: "pat-1" },
    });
  });

  it("scopes consultation by appointment.patientId and medicationOrder by admission.patientId (relational)", async () => {
    await collectPatientData("pat-1");
    const cArgs = prismaMock.consultation.findMany.mock.calls[0][0];
    expect(cArgs.where).toEqual({ appointment: { patientId: "pat-1" } });
    const mArgs = prismaMock.medicationOrder.findMany.mock.calls[0][0];
    expect(mArgs.where).toEqual({ admission: { patientId: "pat-1" } });
  });
});

// ─── buildJsonExport ───────────────────────────────────────────────────────

describe("buildJsonExport", () => {
  it("returns a UTF-8 Buffer whose JSON parses back to the input bag", () => {
    const bag = minimalBag();
    const buf = buildJsonExport(bag);
    expect(Buffer.isBuffer(buf)).toBe(true);
    const parsed = JSON.parse(buf.toString("utf8"));
    expect(parsed.patient.id).toBe(seedPatient.id);
    expect(parsed.appointments).toEqual([]);
  });

  it("is pretty-printed (contains newlines / indentation)", () => {
    const buf = buildJsonExport(minimalBag());
    expect(buf.toString("utf8")).toContain("\n");
  });
});

// ─── buildFhirExport ───────────────────────────────────────────────────────

describe("buildFhirExport", () => {
  it("returns a Buffer containing a transaction Bundle including the Patient resource", () => {
    const buf = buildFhirExport(minimalBag());
    expect(Buffer.isBuffer(buf)).toBe(true);
    const parsed = JSON.parse(buf.toString("utf8"));
    expect(parsed.resourceType).toBe("Bundle");
    expect(parsed.type).toBe("transaction");
    expect(parsed.entry.some((e: { resource: { resourceType: string } }) =>
      e.resource.resourceType === "Patient")).toBe(true);
  });

  it("de-duplicates Practitioner resources across appointments sharing the same doctor id", () => {
    const bag = minimalBag();
    const docA = { id: "doc-A", user: { name: "Alice" } };
    bag.appointments = [
      { id: "ap1", doctor: docA },
      { id: "ap2", doctor: docA }, // duplicate doctor
      { id: "ap3", doctor: { id: "doc-B", user: { name: "Bob" } } },
    ];
    buildFhirExport(bag);
    expect(fhirMocks.doctorToFhir).toHaveBeenCalledTimes(2); // A + B only
    expect(fhirMocks.appointmentToFhir).toHaveBeenCalledTimes(3);
  });

  it("emits both Encounter and Composition for each consultation", () => {
    const bag = minimalBag();
    bag.consultations = [{ id: "c1" }, { id: "c2" }];
    buildFhirExport(bag);
    expect(fhirMocks.consultationToEncounter).toHaveBeenCalledTimes(2);
    expect(fhirMocks.consultationToComposition).toHaveBeenCalledTimes(2);
  });

  it("flattens prescription items into MedicationRequest array per rx", () => {
    const bag = minimalBag();
    fhirMocks.prescriptionToMedicationRequests.mockReturnValueOnce([
      { resourceType: "MedicationRequest", id: "m1" },
      { resourceType: "MedicationRequest", id: "m2" },
    ]);
    bag.prescriptions = [{ id: "rx-1" }];
    const buf = buildFhirExport(bag);
    const parsed = JSON.parse(buf.toString("utf8"));
    const mrs = parsed.entry.filter(
      (e: { resource: { resourceType: string } }) =>
        e.resource.resourceType === "MedicationRequest",
    );
    expect(mrs.length).toBe(2);
  });

  it("emits ServiceRequest + Observation(s) + DiagnosticReport for a lab order with results", () => {
    const bag = minimalBag();
    bag.labOrders = [
      {
        id: "lo-1",
        patientId: "pat-1",
        items: [
          {
            test: { code: "HGB", name: "Hemoglobin" },
            results: [
              { id: "lr-1", value: 12.5 },
              { id: "lr-2", value: 13.0 },
            ],
          },
        ],
      },
    ];
    buildFhirExport(bag);
    expect(fhirMocks.labOrderToServiceRequest).toHaveBeenCalledTimes(1);
    expect(fhirMocks.labResultToObservation).toHaveBeenCalledTimes(2);
    expect(fhirMocks.labOrderToDiagnosticReport).toHaveBeenCalledTimes(1);
    // The diagnostic-report call should receive both result ids.
    const drCall = fhirMocks.labOrderToDiagnosticReport.mock.calls[0];
    expect(drCall[1]).toEqual(["lr-1", "lr-2"]);
  });

  it("skips DiagnosticReport when a lab order has zero results", () => {
    const bag = minimalBag();
    bag.labOrders = [{ id: "lo-2", patientId: "pat-1", items: [] }];
    buildFhirExport(bag);
    expect(fhirMocks.labOrderToServiceRequest).toHaveBeenCalledTimes(1);
    expect(fhirMocks.labOrderToDiagnosticReport).not.toHaveBeenCalled();
  });

  it("survives a single mapper throwing — that resource is skipped, others still emit", () => {
    fhirMocks.appointmentToFhir.mockImplementationOnce(() => {
      throw new Error("bad appt");
    });
    const bag = minimalBag();
    bag.appointments = [
      { id: "ap-bad" },
      { id: "ap-good", doctor: null },
    ];
    const buf = buildFhirExport(bag);
    const parsed = JSON.parse(buf.toString("utf8"));
    // Good appt should still be in the bundle.
    const appts = parsed.entry.filter(
      (e: { resource: { resourceType: string } }) =>
        e.resource.resourceType === "Appointment",
    );
    expect(appts.length).toBe(1);
  });

  it("swallows patientToFhir error and still emits a bundle (warning logged)", () => {
    fhirMocks.patientToFhir.mockImplementationOnce(() => {
      throw new Error("bad patient");
    });
    const buf = buildFhirExport(minimalBag());
    const parsed = JSON.parse(buf.toString("utf8"));
    expect(parsed.resourceType).toBe("Bundle");
  });

  it("includes AllergyIntolerance entries for each allergy in the bag", () => {
    const bag = minimalBag();
    bag.allergies = [{ id: "al-1" }, { id: "al-2" }, { id: "al-3" }];
    buildFhirExport(bag);
    expect(fhirMocks.allergyToFhir).toHaveBeenCalledTimes(3);
  });
});

// ─── buildPdfExport ────────────────────────────────────────────────────────

describe("buildPdfExport", () => {
  it("returns a Buffer with a PDF magic header (%PDF-)", async () => {
    const buf = await buildPdfExport(minimalBag());
    expect(Buffer.isBuffer(buf)).toBe(true);
    // PDFs begin with %PDF-
    expect(buf.slice(0, 5).toString("ascii")).toBe("%PDF-");
    expect(buf.length).toBeGreaterThan(100);
  });

  it("renders appointment and prescription preview blocks when present", async () => {
    const bag = minimalBag();
    bag.appointments = Array.from({ length: 3 }, (_, i) => ({
      id: `ap${i}`,
      date: new Date(`2025-01-0${i + 1}`),
      doctor: { user: { name: `Doc${i}` } },
      status: "COMPLETED",
    }));
    bag.prescriptions = [
      {
        id: "rx-1",
        createdAt: new Date("2025-01-05"),
        diagnosis: "Headache",
        items: [{ medicineName: "Paracetamol" }],
      },
    ];
    const buf = await buildPdfExport(bag);
    // PDF buffer is binary but tends to embed many strings in plain ASCII.
    expect(buf.length).toBeGreaterThan(500);
    expect(buf.slice(0, 5).toString("ascii")).toBe("%PDF-");
  });

  it("renders a minimal patient block when optional fields are absent", async () => {
    const bag = minimalBag();
    bag.patient = { id: "p-bare", mrNumber: null, gender: null, user: null };
    const buf = await buildPdfExport(bag);
    expect(buf.slice(0, 5).toString("ascii")).toBe("%PDF-");
  });
});

// ─── buildExport (dispatch) ────────────────────────────────────────────────

describe("buildExport", () => {
  it("returns a JSON artifact with the correct MIME + extension", async () => {
    const result = await buildExport("pat-1", "json");
    expect(result.extension).toBe("json");
    expect(result.mime).toBe("application/json");
    expect(result.buffer.toString("utf8").startsWith("{")).toBe(true);
  });

  it("returns a FHIR artifact with the correct MIME + extension", async () => {
    const result = await buildExport("pat-1", "fhir");
    expect(result.extension).toBe("fhir.json");
    expect(result.mime).toBe("application/fhir+json");
    const parsed = JSON.parse(result.buffer.toString("utf8"));
    expect(parsed.resourceType).toBe("Bundle");
  });

  it("returns a PDF artifact with the correct MIME + extension", async () => {
    const result = await buildExport("pat-1", "pdf");
    expect(result.extension).toBe("pdf");
    expect(result.mime).toBe("application/pdf");
    expect(result.buffer.slice(0, 5).toString("ascii")).toBe("%PDF-");
  });

  it("throws when handed an unknown format (exhaustive-never guard)", async () => {
    await expect(
      buildExport("pat-1", "xml" as unknown as "json"),
    ).rejects.toThrow(/Unknown export format/);
  });
});

// ─── exportFilename ────────────────────────────────────────────────────────

describe("exportFilename", () => {
  it("includes the request id, a 12-hex random suffix, and the extension", () => {
    const name = exportFilename("req-abc-123", "json");
    expect(name).toMatch(/^export-req-abc-123-[a-f0-9]{12}\.json$/);
  });

  it("produces different suffixes on repeat calls (entropy)", () => {
    const a = exportFilename("req-1", "pdf");
    const b = exportFilename("req-1", "pdf");
    expect(a).not.toBe(b);
  });

  it("honors compound extensions like fhir.json", () => {
    const name = exportFilename("req-x", "fhir.json");
    expect(name).toMatch(/^export-req-x-[a-f0-9]{12}\.fhir\.json$/);
  });
});

// ─── runExportWorker ───────────────────────────────────────────────────────

describe("runExportWorker", () => {
  // Each test that produces a file cleans up to keep CI artifact dir tidy.
  const writtenFiles: string[] = [];
  afterEach(async () => {
    for (const f of writtenFiles.splice(0)) {
      try {
        await fs.promises.unlink(f);
      } catch {
        // ignore
      }
    }
  });

  it("noops silently when the requested export row does not exist", async () => {
    prismaMock.patientDataExport.findUnique.mockResolvedValueOnce(null);
    await expect(runExportWorker("missing-req")).resolves.toBeUndefined();
    // No status update should have fired.
    expect(prismaMock.patientDataExport.update).not.toHaveBeenCalled();
  });

  it("short-circuits when the row is no longer QUEUED (idempotency guard)", async () => {
    prismaMock.patientDataExport.findUnique.mockResolvedValueOnce({
      id: "req-1",
      status: "PROCESSING",
      patientId: "pat-1",
      format: "JSON",
      tenantId: "ten-1",
    });
    await runExportWorker("req-1");
    expect(prismaMock.patientDataExport.update).not.toHaveBeenCalled();
  });

  it("happy path: QUEUED → PROCESSING → READY, writes file, records size, runs inside tenant context", async () => {
    prismaMock.patientDataExport.findUnique.mockResolvedValueOnce({
      id: "req-happy",
      status: "QUEUED",
      patientId: "pat-1",
      format: "JSON",
      tenantId: "ten-XYZ",
    });

    await runExportWorker("req-happy");

    // Two updates: PROCESSING then READY.
    const calls = prismaMock.patientDataExport.update.mock.calls;
    expect(calls.length).toBe(2);
    expect(calls[0][0].data.status).toBe("PROCESSING");
    expect(calls[0][0].data.startedAt).toBeInstanceOf(Date);
    expect(calls[1][0].data.status).toBe("READY");
    expect(calls[1][0].data.readyAt).toBeInstanceOf(Date);
    expect(typeof calls[1][0].data.filePath).toBe("string");
    expect(calls[1][0].data.filePath).toMatch(/^export-req-happy-[a-f0-9]{12}\.json$/);
    expect(calls[1][0].data.fileSize).toBeGreaterThan(0);

    // Tenant context was honored.
    expect(runWithTenantMock).toHaveBeenCalledTimes(1);
    expect(runWithTenantMock.mock.calls[0][0]).toBe("ten-XYZ");

    // The file should physically exist on disk.
    const written = path.join(EXPORT_DIR, calls[1][0].data.filePath);
    writtenFiles.push(written);
    expect(fs.existsSync(written)).toBe(true);
  });

  it("skips runWithTenant when row.tenantId is null/undefined (admin-style row)", async () => {
    prismaMock.patientDataExport.findUnique.mockResolvedValueOnce({
      id: "req-no-tenant",
      status: "QUEUED",
      patientId: "pat-1",
      format: "JSON",
      tenantId: null,
    });

    await runExportWorker("req-no-tenant");

    // runWithTenant must NOT be invoked when tenantId is falsy.
    expect(runWithTenantMock).not.toHaveBeenCalled();
    // Worker still completes successfully.
    const readyCall = prismaMock.patientDataExport.update.mock.calls.find(
      (c) => c[0].data.status === "READY",
    );
    expect(readyCall).toBeDefined();
    if (readyCall) {
      writtenFiles.push(path.join(EXPORT_DIR, readyCall[0].data.filePath));
    }
  });

  it("marks the export FAILED when buildExport throws (e.g. patient missing)", async () => {
    prismaMock.patientDataExport.findUnique.mockResolvedValueOnce({
      id: "req-fail",
      status: "QUEUED",
      patientId: "pat-NOT-THERE",
      format: "JSON",
      tenantId: null,
    });
    prismaMock.patient.findUnique.mockResolvedValueOnce(null);

    await runExportWorker("req-fail");

    const failedCall = prismaMock.patientDataExport.update.mock.calls.find(
      (c) => c[0].data.status === "FAILED",
    );
    expect(failedCall).toBeDefined();
    expect(failedCall![0].data.errorMessage).toContain("not found");
  });

  it("truncates a long error message to 1000 chars when marking FAILED", async () => {
    const longMsg = "X".repeat(5000);
    prismaMock.patientDataExport.findUnique.mockResolvedValueOnce({
      id: "req-long-err",
      status: "QUEUED",
      patientId: "pat-1",
      format: "JSON",
      tenantId: null,
    });
    prismaMock.patient.findUnique.mockRejectedValueOnce(new Error(longMsg));

    await runExportWorker("req-long-err");

    const failedCall = prismaMock.patientDataExport.update.mock.calls.find(
      (c) => c[0].data.status === "FAILED",
    );
    expect(failedCall).toBeDefined();
    expect(failedCall![0].data.errorMessage.length).toBeLessThanOrEqual(1000);
  });

  it("normalises row.format casing — 'JSON' becomes 'json' dispatch", async () => {
    prismaMock.patientDataExport.findUnique.mockResolvedValueOnce({
      id: "req-case",
      status: "QUEUED",
      patientId: "pat-1",
      format: "FHIR", // upstream stores uppercase enum
      tenantId: null,
    });
    await runExportWorker("req-case");
    const readyCall = prismaMock.patientDataExport.update.mock.calls.find(
      (c) => c[0].data.status === "READY",
    );
    expect(readyCall).toBeDefined();
    expect(readyCall![0].data.filePath).toMatch(/\.fhir\.json$/);
    if (readyCall) {
      writtenFiles.push(path.join(EXPORT_DIR, readyCall[0].data.filePath));
    }
  });
});

// ─── scheduleExportWorker ──────────────────────────────────────────────────

describe("scheduleExportWorker", () => {
  it("returns synchronously and schedules the worker via setImmediate", async () => {
    prismaMock.patientDataExport.findUnique.mockResolvedValueOnce(null);
    const ret = scheduleExportWorker("req-schedule");
    // Fire-and-forget: must not return a Promise.
    expect(ret).toBeUndefined();
    // Allow the queued setImmediate to drain.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(prismaMock.patientDataExport.findUnique).toHaveBeenCalledWith({
      where: { id: "req-schedule" },
    });
  });
});
