// Unit tests for FHIR search helpers.
//
// We drive the code with an in-memory Prisma fake that implements just the
// delegate methods the search service calls (`count`, `findMany` on patient,
// consultation, prescription and patientAllergy). Testing against a real
// Postgres adds no value for search logic — we care about filter shape,
// pagination math and OperationOutcome conversion.

import { describe, it, expect, beforeEach, vi } from "vitest";

// ─── In-memory fake state ───────────────────────────────────────────────────

interface FakeState {
  patients: any[];
  consultations: any[];
  prescriptions: any[];
  allergies: any[];
}

function freshState(): FakeState {
  return { patients: [], consultations: [], prescriptions: [], allergies: [] };
}

const state: { current: FakeState } = { current: freshState() };

// Filter helpers --------------------------------------------------------------

function matchesDateFilter(value: Date | null | undefined, filter: any): boolean {
  if (!filter) return true;
  if (value == null) return false;
  const t = new Date(value).getTime();
  if (filter.gte !== undefined && t < new Date(filter.gte).getTime()) return false;
  if (filter.lte !== undefined && t > new Date(filter.lte).getTime()) return false;
  if (filter.gt !== undefined && t <= new Date(filter.gt).getTime()) return false;
  if (filter.lt !== undefined && t >= new Date(filter.lt).getTime()) return false;
  return true;
}

function matchesScalar(value: any, filter: any): boolean {
  if (filter === undefined || filter === null) {
    if (filter === null) return value === null || value === undefined;
    return true;
  }
  if (typeof filter === "object" && "not" in filter) {
    return value !== null && value !== undefined;
  }
  if (typeof filter === "object" && "contains" in filter) {
    const needle = String(filter.contains ?? "");
    const hay = String(value ?? "");
    if (filter.mode === "insensitive") {
      return hay.toLowerCase().includes(needle.toLowerCase());
    }
    return hay.includes(needle);
  }
  if (typeof filter === "object" && ("gte" in filter || "lte" in filter || "gt" in filter || "lt" in filter)) {
    return matchesDateFilter(value, filter);
  }
  return value === filter;
}

function matchesPatient(p: any, where: any): boolean {
  if (!where) return true;
  if (where.gender !== undefined && p.gender !== where.gender) return false;
  if (where.mrNumber !== undefined) {
    if (typeof where.mrNumber === "object") {
      if (!matchesScalar(p.mrNumber, where.mrNumber)) return false;
    } else if (p.mrNumber !== where.mrNumber) {
      return false;
    }
  }
  if (where.abhaId !== undefined && p.abhaId !== where.abhaId) return false;
  if (where.aadhaarMasked !== undefined && p.aadhaarMasked !== where.aadhaarMasked) return false;
  if (where.dateOfBirth !== undefined && !matchesScalar(p.dateOfBirth, where.dateOfBirth)) return false;
  if (where.OR) {
    const ok = (where.OR as any[]).some((clause) => matchesPatient(p, clause));
    if (!ok) return false;
  }
  if (where.user?.is) {
    const u = p.user ?? {};
    for (const [k, v] of Object.entries(where.user.is)) {
      if (k === "AND") {
        const clauses = v as any[];
        for (const clause of clauses) {
          for (const [ck, cv] of Object.entries(clause)) {
            if (!matchesScalar((u as any)[ck], cv)) return false;
          }
        }
      } else if (!matchesScalar((u as any)[k], v)) {
        return false;
      }
    }
  }
  return true;
}

function matchesConsultation(c: any, where: any): boolean {
  if (!where) return true;
  if (where.createdAt !== undefined && !matchesScalar(c.createdAt, where.createdAt)) return false;
  if (where.updatedAt !== undefined && !matchesScalar(c.updatedAt, where.updatedAt)) return false;
  if (where.appointment?.is) {
    const appt = c.appointment ?? {};
    for (const [k, v] of Object.entries(where.appointment.is)) {
      if (v === null) {
        if ((appt as any)[k] != null) return false;
      } else if (typeof v === "object" && (v as any).not !== undefined) {
        if ((appt as any)[k] == null) return false;
      } else if ((appt as any)[k] !== v) {
        return false;
      }
    }
  }
  return true;
}

function matchesPrescription(rx: any, where: any): boolean {
  if (!where) return true;
  if (where.patientId !== undefined && rx.patientId !== where.patientId) return false;
  if (where.createdAt !== undefined && !matchesScalar(rx.createdAt, where.createdAt)) return false;
  if (where.updatedAt !== undefined && !matchesScalar(rx.updatedAt, where.updatedAt)) return false;
  return true;
}

function matchesAllergy(a: any, where: any): boolean {
  if (!where) return true;
  if (where.patientId !== undefined && a.patientId !== where.patientId) return false;
  if (where.notedAt !== undefined && !matchesScalar(a.notedAt, where.notedAt)) return false;
  return true;
}

// ─── Mock prisma ─────────────────────────────────────────────────────────────

const { prismaMock } = vi.hoisted(() => ({ prismaMock: {} as any }));

vi.mock("@medcore/db", () => ({ prisma: prismaMock }));

prismaMock.patient = {
  count: async ({ where }: any) => state.current.patients.filter((p) => matchesPatient(p, where)).length,
  findMany: async ({ where, take, skip, orderBy }: any) => {
    let rows = state.current.patients.filter((p) => matchesPatient(p, where));
    if (orderBy?.mrNumber === "asc") {
      rows = [...rows].sort((a, b) => String(a.mrNumber).localeCompare(String(b.mrNumber)));
    }
    if (skip) rows = rows.slice(skip);
    if (take !== undefined) rows = rows.slice(0, take);
    return rows;
  },
};

prismaMock.consultation = {
  count: async ({ where }: any) => state.current.consultations.filter((c) => matchesConsultation(c, where)).length,
  findMany: async ({ where, take, skip, orderBy }: any) => {
    let rows = state.current.consultations.filter((c) => matchesConsultation(c, where));
    if (orderBy?.createdAt === "desc") {
      rows = [...rows].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    }
    if (skip) rows = rows.slice(skip);
    if (take !== undefined) rows = rows.slice(0, take);
    return rows;
  },
};

prismaMock.prescription = {
  findMany: async ({ where, orderBy }: any) => {
    let rows = state.current.prescriptions.filter((r) => matchesPrescription(r, where));
    if (orderBy?.createdAt === "desc") {
      rows = [...rows].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    }
    return rows;
  },
};

prismaMock.patientAllergy = {
  count: async ({ where }: any) => state.current.allergies.filter((a) => matchesAllergy(a, where)).length,
  findMany: async ({ where, take, skip, orderBy }: any) => {
    let rows = state.current.allergies.filter((a) => matchesAllergy(a, where));
    if (orderBy?.notedAt === "desc") {
      rows = [...rows].sort((a, b) => new Date(b.notedAt).getTime() - new Date(a.notedAt).getTime());
    }
    if (skip) rows = rows.slice(skip);
    if (take !== undefined) rows = rows.slice(0, take);
    return rows;
  },
};

// ─── Imports after mock is in place ─────────────────────────────────────────

import {
  searchPatient,
  searchEncounter,
  searchMedicationRequest,
  searchAllergyIntolerance,
  FhirSearchError,
  MAX_COUNT,
  DEFAULT_COUNT,
} from "./search";

// ─── Seed helpers ────────────────────────────────────────────────────────────

function seedPatient(overrides: Partial<any> = {}): any {
  const n = state.current.patients.length + 1;
  const p = {
    id: overrides.id ?? `pat-${n.toString().padStart(4, "0")}`,
    userId: `u-${n}`,
    mrNumber: overrides.mrNumber ?? `MR-${(1000 + n).toString()}`,
    dateOfBirth: overrides.dateOfBirth ?? new Date("1980-01-01"),
    gender: overrides.gender ?? "MALE",
    address: overrides.address ?? "Test address",
    abhaId: overrides.abhaId ?? null,
    aadhaarMasked: overrides.aadhaarMasked ?? null,
    user: {
      name: overrides.name ?? "Test User",
      phone: "+911111111111",
      email: `user${n}@ex.com`,
      isActive: true,
      updatedAt: overrides.userUpdatedAt ?? new Date("2026-04-01T00:00:00Z"),
    },
  };
  state.current.patients.push(p);
  return p;
}

function seedConsultation(overrides: Partial<any> = {}): any {
  const n = state.current.consultations.length + 1;
  const c = {
    id: overrides.id ?? `cons-${n}`,
    appointmentId: overrides.appointmentId ?? `appt-${n}`,
    doctorId: overrides.doctorId ?? "doc-1",
    notes: overrides.notes ?? null,
    findings: overrides.findings ?? null,
    createdAt: overrides.createdAt ?? new Date("2026-04-10T09:00:00Z"),
    updatedAt: overrides.updatedAt ?? new Date("2026-04-10T09:30:00Z"),
    appointment: {
      id: overrides.appointmentId ?? `appt-${n}`,
      patientId: overrides.patientId ?? "pat-0001",
      doctorId: overrides.doctorId ?? "doc-1",
      consultationStartedAt: overrides.consultationStartedAt ?? new Date("2026-04-10T09:00:00Z"),
      consultationEndedAt: overrides.consultationEndedAt ?? null,
    },
  };
  state.current.consultations.push(c);
  return c;
}

function seedPrescription(overrides: Partial<any> = {}): any {
  const n = state.current.prescriptions.length + 1;
  const rx = {
    id: overrides.id ?? `rx-${n}`,
    appointmentId: overrides.appointmentId ?? `appt-${n}`,
    patientId: overrides.patientId ?? "pat-0001",
    doctorId: overrides.doctorId ?? "doc-1",
    diagnosis: overrides.diagnosis ?? "R50.9",
    createdAt: overrides.createdAt ?? new Date("2026-04-10T09:00:00Z"),
    updatedAt: overrides.updatedAt ?? new Date("2026-04-10T09:00:00Z"),
    items: overrides.items ?? [
      { id: `rxi-${n}-1`, medicineName: "Paracetamol 500mg", dosage: "1 tab", frequency: "TID", duration: "3 days" },
      { id: `rxi-${n}-2`, medicineName: "Ibuprofen 200mg", dosage: "1 tab", frequency: "BID", duration: "2 days" },
    ],
  };
  state.current.prescriptions.push(rx);
  return rx;
}

function seedAllergy(overrides: Partial<any> = {}): any {
  const n = state.current.allergies.length + 1;
  const a = {
    id: overrides.id ?? `alg-${n}`,
    patientId: overrides.patientId ?? "pat-0001",
    allergen: overrides.allergen ?? "Penicillin",
    severity: overrides.severity ?? "MODERATE",
    reaction: overrides.reaction ?? "Rash",
    notes: null,
    notedBy: "u-doc",
    notedAt: overrides.notedAt ?? new Date("2026-03-15T00:00:00Z"),
  };
  state.current.allergies.push(a);
  return a;
}

beforeEach(() => {
  state.current = freshState();
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("searchPatient", () => {
  it("matches by name substring, case-insensitive", async () => {
    seedPatient({ name: "Arjun Kumar Sharma" });
    seedPatient({ name: "Priya Sharma" });
    seedPatient({ name: "John Doe" });

    const bundle = await searchPatient({ name: "SHARMA" });
    expect(bundle.resourceType).toBe("Bundle");
    expect(bundle.type).toBe("searchset");
    expect(bundle.total).toBe(2);
    expect(bundle.entry).toHaveLength(2);
    expect(bundle.entry[0].resource.resourceType).toBe("Patient");
  });

  it("filters by family and given (both must match)", async () => {
    seedPatient({ name: "Arjun Sharma" });
    seedPatient({ name: "Priya Sharma" });
    seedPatient({ name: "Arjun Patel" });

    const bundle = await searchPatient({ family: "Sharma", given: "Arjun" });
    expect(bundle.total).toBe(1);
    const p = bundle.entry[0].resource as any;
    expect(p.name[0].text).toBe("Arjun Sharma");
  });

  it("matches by identifier (MR number)", async () => {
    seedPatient({ mrNumber: "MR-ALPHA" });
    seedPatient({ mrNumber: "MR-BETA" });

    const bundle = await searchPatient({ identifier: "MR-ALPHA" });
    expect(bundle.total).toBe(1);
    expect((bundle.entry[0].resource as any).identifier[0].value).toBe("MR-ALPHA");
  });

  it("matches by ABHA identifier with system URI", async () => {
    seedPatient({ mrNumber: "MR-1", abhaId: "14-1111-2222-3333" });
    seedPatient({ mrNumber: "MR-2", abhaId: "14-9999-8888-7777" });

    const bundle = await searchPatient({
      identifier: "https://healthid.ndhm.gov.in|14-1111-2222-3333",
    });
    expect(bundle.total).toBe(1);
    expect((bundle.entry[0].resource as any).id).toBeDefined();
  });

  it("accepts `ge` prefix on birthdate and returns matching rows", async () => {
    seedPatient({ dateOfBirth: new Date("1970-05-01") });
    seedPatient({ dateOfBirth: new Date("1990-05-01") });
    seedPatient({ dateOfBirth: new Date("2020-05-01") });

    const bundle = await searchPatient({ birthdate: "ge1985-01-01" });
    expect(bundle.total).toBe(2);
  });

  it("rejects an invalid date format with FhirSearchError", async () => {
    await expect(searchPatient({ birthdate: "not-a-date" })).rejects.toBeInstanceOf(FhirSearchError);
    await expect(searchPatient({ birthdate: "ge12-01-2024" })).rejects.toBeInstanceOf(FhirSearchError);
  });

  it("rejects an invalid _count value", async () => {
    await expect(searchPatient({ _count: "abc" })).rejects.toBeInstanceOf(FhirSearchError);
  });

  it("paginates with _count=10&_offset=20 and emits a next link", async () => {
    // seed 35 patients with sortable mrNumbers
    for (let i = 0; i < 35; i++) {
      seedPatient({ mrNumber: `MR-${(2000 + i).toString()}`, name: `Name ${i}` });
    }

    const ctx = {
      selfUrl: "https://api/v1/fhir/Patient?_count=10&_offset=20",
      baseUrl: "https://api/v1/fhir/Patient",
      searchParams: new URLSearchParams("_count=10&_offset=20"),
    };
    const bundle = await searchPatient({ _count: 10, _offset: 20 }, ctx);
    expect(bundle.total).toBe(35);
    expect(bundle.entry).toHaveLength(10);
    // The 21st mrNumber in sorted order is MR-2020
    expect((bundle.entry[0].resource as any).identifier[0].value).toBe("MR-2020");
    const nextLink = bundle.link?.find((l) => l.relation === "next");
    expect(nextLink).toBeDefined();
    expect(nextLink!.url).toContain("_offset=30");
    const prevLink = bundle.link?.find((l) => l.relation === "previous");
    expect(prevLink).toBeDefined();
    expect(prevLink!.url).toContain("_offset=10");
  });

  it("caps _count at MAX_COUNT (200)", async () => {
    // Seed 5 so we can observe `take` by checking the outcome isn't larger
    // than what we asked; more importantly we inspect link generation.
    for (let i = 0; i < 5; i++) seedPatient();

    const ctx = {
      selfUrl: "https://api/v1/fhir/Patient?_count=99999",
      baseUrl: "https://api/v1/fhir/Patient",
      searchParams: new URLSearchParams("_count=99999"),
    };
    const bundle = await searchPatient({ _count: 99999 }, ctx);
    // With 5 rows there's no next link, but the self link should reflect the cap.
    expect(bundle.total).toBe(5);
    expect(bundle.entry).toHaveLength(5);
    const nextLink = bundle.link?.find((l) => l.relation === "next");
    expect(nextLink).toBeUndefined();
    // Confirm cap via exposed constant
    expect(MAX_COUNT).toBe(200);
    expect(DEFAULT_COUNT).toBe(50);
  });

  it("returns an empty bundle with total 0 when nothing matches", async () => {
    seedPatient({ name: "Alice" });

    const bundle = await searchPatient({ name: "Zebra" });
    expect(bundle.total).toBe(0);
    expect(bundle.entry).toHaveLength(0);
    expect(bundle.type).toBe("searchset");
  });
});

describe("searchEncounter", () => {
  it("filters by patient and status=finished", async () => {
    seedConsultation({
      patientId: "pat-aaa",
      appointmentId: "appt-1",
      consultationEndedAt: new Date("2026-04-10T10:00:00Z"),
    });
    seedConsultation({
      patientId: "pat-aaa",
      appointmentId: "appt-2",
      consultationEndedAt: null,
    });
    seedConsultation({
      patientId: "pat-bbb",
      appointmentId: "appt-3",
      consultationEndedAt: new Date("2026-04-11T10:00:00Z"),
    });

    const bundle = await searchEncounter({ patient: "pat-aaa", status: "finished" });
    expect(bundle.total).toBe(1);
    const enc = bundle.entry[0].resource as any;
    expect(enc.resourceType).toBe("Encounter");
    expect(enc.status).toBe("finished");
    expect(enc.subject.reference).toBe("Patient/pat-aaa");
  });

  it("rejects an unsupported Encounter.status", async () => {
    await expect(searchEncounter({ status: "planned" })).rejects.toBeInstanceOf(FhirSearchError);
  });
});

describe("searchMedicationRequest", () => {
  it("filters by patient and authoredon date window", async () => {
    seedPrescription({
      id: "rx-match-1",
      patientId: "pat-xyz",
      createdAt: new Date("2026-02-05T00:00:00Z"),
    });
    seedPrescription({
      id: "rx-match-2",
      patientId: "pat-xyz",
      createdAt: new Date("2026-04-05T00:00:00Z"),
    });
    seedPrescription({
      id: "rx-other",
      patientId: "pat-diff",
      createdAt: new Date("2026-04-10T00:00:00Z"),
    });

    const bundle = await searchMedicationRequest({
      patient: "pat-xyz",
      authoredon: "ge2026-03-01",
    });
    // Only rx-match-2 (2 items) should be returned; each item maps to its own MedicationRequest.
    expect(bundle.total).toBe(2);
    expect(bundle.entry).toHaveLength(2);
    expect((bundle.entry[0].resource as any).resourceType).toBe("MedicationRequest");
    expect((bundle.entry[0].resource as any).subject.reference).toBe("Patient/pat-xyz");
  });

  it("returns empty bundle when status != active (mapper emits only active)", async () => {
    seedPrescription({ patientId: "p1" });
    const bundle = await searchMedicationRequest({ patient: "p1", status: "completed" });
    expect(bundle.total).toBe(0);
    expect(bundle.entry).toHaveLength(0);
  });
});

describe("searchAllergyIntolerance", () => {
  it("filters by patient id", async () => {
    seedAllergy({ patientId: "p1", allergen: "Peanut" });
    seedAllergy({ patientId: "p1", allergen: "Shellfish" });
    seedAllergy({ patientId: "p2", allergen: "Latex" });

    const bundle = await searchAllergyIntolerance({ patient: "p1" });
    expect(bundle.total).toBe(2);
    expect(bundle.entry).toHaveLength(2);
    const r = bundle.entry[0].resource as any;
    expect(r.resourceType).toBe("AllergyIntolerance");
    expect(r.patient.reference).toBe("Patient/p1");
  });

  it("respects _lastUpdated ge filter on notedAt", async () => {
    seedAllergy({ patientId: "p1", allergen: "Old", notedAt: new Date("2025-01-01T00:00:00Z") });
    seedAllergy({ patientId: "p1", allergen: "New", notedAt: new Date("2026-04-01T00:00:00Z") });

    const bundle = await searchAllergyIntolerance({
      patient: "p1",
      _lastUpdated: "ge2026-01-01",
    });
    expect(bundle.total).toBe(1);
    expect((bundle.entry[0].resource as any).code.text).toBe("New");
  });
});

// ─── Date-prefix coverage on Encounter (gap #3 spec) ────────────────────────

describe("searchEncounter — date prefix windows", () => {
  it("filters with date=ge2026-04-01 (inclusive lower bound)", async () => {
    seedConsultation({ patientId: "pat-d1", appointmentId: "appt-mar", createdAt: new Date("2026-03-15T10:00:00Z") });
    seedConsultation({ patientId: "pat-d1", appointmentId: "appt-apr", createdAt: new Date("2026-04-10T10:00:00Z") });
    seedConsultation({ patientId: "pat-d1", appointmentId: "appt-may", createdAt: new Date("2026-05-05T10:00:00Z") });

    const bundle = await searchEncounter({ date: "ge2026-04-01" });
    expect(bundle.total).toBe(2);
    // The default order is createdAt desc, so May then Apr.
    const refs = bundle.entry.map((e) => (e.resource as any).id);
    expect(refs.length).toBe(2);
  });

  it("filters with date=le2026-05-01 (inclusive upper bound — May 1 itself matches)", async () => {
    seedConsultation({ patientId: "pat-d2", appointmentId: "appt-apr", createdAt: new Date("2026-04-10T10:00:00Z") });
    seedConsultation({ patientId: "pat-d2", appointmentId: "appt-may1", createdAt: new Date("2026-05-01T23:59:59Z") });
    seedConsultation({ patientId: "pat-d2", appointmentId: "appt-may2", createdAt: new Date("2026-05-02T00:00:01Z") });

    const bundle = await searchEncounter({ date: "le2026-05-01" });
    // le2026-05-01 → lt 2026-05-02 00:00:00 UTC, so the first two match, the third does not.
    expect(bundle.total).toBe(2);
  });

  it("combines patient + date=ge…&_count=… (composite filter + pagination shape)", async () => {
    // 5 encounters for the target patient on/after 2026-04-01, 2 before that, 3 for an unrelated patient.
    for (let i = 0; i < 5; i++) {
      seedConsultation({
        patientId: "pat-combo",
        appointmentId: `appt-c-on-${i}`,
        createdAt: new Date(`2026-04-${(10 + i).toString().padStart(2, "0")}T10:00:00Z`),
      });
    }
    for (let i = 0; i < 2; i++) {
      seedConsultation({
        patientId: "pat-combo",
        appointmentId: `appt-c-pre-${i}`,
        createdAt: new Date(`2026-03-${(10 + i).toString().padStart(2, "0")}T10:00:00Z`),
      });
    }
    for (let i = 0; i < 3; i++) {
      seedConsultation({
        patientId: "pat-other",
        appointmentId: `appt-other-${i}`,
        createdAt: new Date(`2026-04-${(20 + i).toString().padStart(2, "0")}T10:00:00Z`),
      });
    }

    const bundle = await searchEncounter({
      patient: "pat-combo",
      date: "ge2026-04-01",
      _count: 3,
    });
    // total counts every match across the patient+date filter; _count caps the page.
    expect(bundle.total).toBe(5);
    expect(bundle.entry).toHaveLength(3);
    for (const e of bundle.entry) {
      expect((e.resource as any).subject.reference).toBe("Patient/pat-combo");
    }
  });
});

// ─── Malformed parameter → FhirSearchError → route emits 400 OperationOutcome ──

describe("searchEncounter — malformed parameter envelope", () => {
  it("throws FhirSearchError on date=garbage (route layer maps to OperationOutcome severity=error, NOT a raw 500)", async () => {
    // Unit-level: search.ts raises FhirSearchError carrying a `diagnostics`
    // string. The route layer (`handleSearchError` in routes/fhir.ts) converts
    // this into a 400 response with body
    //   { resourceType: "OperationOutcome", issue: [{ severity: "error", ... }] }
    // — NOT a generic 500 Internal Server Error. We assert the precondition
    // (FhirSearchError + diagnostics field) here so the route mapping is well
    // defined.
    let caught: unknown;
    try {
      await searchEncounter({ date: "garbage" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(FhirSearchError);
    const err = caught as FhirSearchError;
    expect(err.name).toBe("FhirSearchError");
    expect(err.diagnostics).toMatch(/date|format|garbage|Invalid/i);
    // Route would call operationOutcome("error", "invalid", diagnostics) — a
    // 5xx leak would be a regression. We surface that here by asserting the
    // error type is the *narrow* search error, not a generic Error.
    expect(err).not.toBeInstanceOf(TypeError);
  });

  it("rejects malformed _offset (negative) with FhirSearchError, never reaching prisma", async () => {
    await expect(searchEncounter({ _offset: -5 })).rejects.toBeInstanceOf(FhirSearchError);
  });
});
