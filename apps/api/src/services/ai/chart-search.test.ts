// Unit tests for chart search — prisma and LLM are mocked, so these verify
// access-control, scoping and extraction logic without hitting a DB or the
// Sarvam backend.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockPrisma, mockGenerateText } = vi.hoisted(() => ({
  mockPrisma: {
    doctor: { findFirst: vi.fn() },
    appointment: { findMany: vi.fn() },
    prescription: { findMany: vi.fn() },
    consultation: { findMany: vi.fn() },
    $queryRaw: vi.fn(),
  },
  mockGenerateText: vi.fn(async () => "stubbed answer [1]"),
}));

vi.mock("@medcore/db", () => ({ prisma: mockPrisma }));
vi.mock("./sarvam", () => ({ generateText: mockGenerateText }));

import { searchPatientChart, searchCohort, resolveDoctorPanel } from "./chart-search";

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.$queryRaw.mockResolvedValue([]);
});

describe("resolveDoctorPanel", () => {
  it("returns isAdmin=true with empty panel for ADMIN role", async () => {
    const r = await resolveDoctorPanel({ userId: "u-admin", role: "ADMIN" });
    expect(r.isAdmin).toBe(true);
    expect(r.patientIds).toEqual([]);
    expect(mockPrisma.doctor.findFirst).not.toHaveBeenCalled();
  });

  it("returns empty panel when user has no doctor record", async () => {
    mockPrisma.doctor.findFirst.mockResolvedValueOnce(null);
    const r = await resolveDoctorPanel({ userId: "u-nobody", role: "DOCTOR" });
    expect(r.isAdmin).toBe(false);
    expect(r.patientIds).toEqual([]);
    expect(r.doctorId).toBeNull();
  });

  it("merges patient ids from appointments + prescriptions + consultations", async () => {
    mockPrisma.doctor.findFirst.mockResolvedValueOnce({ id: "d1" });
    mockPrisma.appointment.findMany.mockResolvedValueOnce([
      { patientId: "pA" },
      { patientId: "pB" },
    ]);
    mockPrisma.prescription.findMany.mockResolvedValueOnce([{ patientId: "pB" }, { patientId: "pC" }]);
    mockPrisma.consultation.findMany.mockResolvedValueOnce([
      { appointment: { patientId: "pD" } },
    ]);

    const r = await resolveDoctorPanel({ userId: "u-d", role: "DOCTOR" });
    expect(r.isAdmin).toBe(false);
    expect(r.doctorId).toBe("d1");
    expect(r.patientIds.sort()).toEqual(["pA", "pB", "pC", "pD"]);
  });
});

describe("searchPatientChart", () => {
  it("throws 403 when patient is not in the doctor's panel", async () => {
    mockPrisma.doctor.findFirst.mockResolvedValueOnce({ id: "d1" });
    mockPrisma.appointment.findMany.mockResolvedValueOnce([{ patientId: "pOther" }]);
    mockPrisma.prescription.findMany.mockResolvedValueOnce([]);
    mockPrisma.consultation.findMany.mockResolvedValueOnce([]);

    await expect(
      searchPatientChart("chest pain", "pTarget", { userId: "u-d", role: "DOCTOR" })
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("returns ranked hits + synthesized answer when access is granted", async () => {
    mockPrisma.doctor.findFirst.mockResolvedValueOnce({ id: "d1" });
    mockPrisma.appointment.findMany.mockResolvedValueOnce([{ patientId: "pTarget" }]);
    mockPrisma.prescription.findMany.mockResolvedValueOnce([]);
    mockPrisma.consultation.findMany.mockResolvedValueOnce([]);

    mockPrisma.$queryRaw.mockResolvedValueOnce([
      {
        id: "chunk-1",
        documentType: "LAB_RESULT",
        title: "Lab HbA1c: 9.2 % [HIGH]",
        content: "HbA1c 9.2 — poor control",
        tags: ["patient:pTarget", "doctor:d1", "date:2026-04-10", "flag:HIGH"],
        rank: 0.85,
      },
    ]);

    const r = await searchPatientChart("HbA1c", "pTarget", { userId: "u-d", role: "DOCTOR" });
    expect(r.hits).toHaveLength(1);
    expect(r.hits[0].patientId).toBe("pTarget");
    expect(r.hits[0].doctorId).toBe("d1");
    expect(r.hits[0].date).toBe("2026-04-10");
    expect(r.answer).toBe("stubbed answer [1]");
    expect(r.citedChunkIds).toEqual(["chunk-1"]);
  });

  it("allows admin to bypass panel check", async () => {
    mockPrisma.$queryRaw.mockResolvedValueOnce([]);
    const r = await searchPatientChart("any", "pAny", { userId: "u-a", role: "ADMIN" });
    expect(r.hits).toEqual([]);
    // doctor.findFirst must NOT have been called for admin
    expect(mockPrisma.doctor.findFirst).not.toHaveBeenCalled();
  });
});

describe("searchCohort", () => {
  it("returns empty result when doctor has no patients", async () => {
    mockPrisma.doctor.findFirst.mockResolvedValueOnce({ id: "d1" });
    mockPrisma.appointment.findMany.mockResolvedValueOnce([]);
    mockPrisma.prescription.findMany.mockResolvedValueOnce([]);
    mockPrisma.consultation.findMany.mockResolvedValueOnce([]);

    const r = await searchCohort("diabetic CKD", { userId: "u-d", role: "DOCTOR" });
    expect(r.totalHits).toBe(0);
    expect(r.hits).toEqual([]);
    // No FTS call when there is no panel to scope to
    expect(mockPrisma.$queryRaw).not.toHaveBeenCalled();
  });

  it("scopes FTS query to the doctor's panel", async () => {
    mockPrisma.doctor.findFirst.mockResolvedValueOnce({ id: "d1" });
    mockPrisma.appointment.findMany.mockResolvedValueOnce([
      { patientId: "pA" },
      { patientId: "pB" },
    ]);
    mockPrisma.prescription.findMany.mockResolvedValueOnce([]);
    mockPrisma.consultation.findMany.mockResolvedValueOnce([]);

    mockPrisma.$queryRaw.mockResolvedValueOnce([
      {
        id: "c-xyz",
        documentType: "PRESCRIPTION",
        title: "Rx",
        content: "metformin",
        tags: ["patient:pA", "doctor:d1", "date:2026-04-01"],
        rank: 0.5,
      },
    ]);

    const r = await searchCohort("metformin", { userId: "u-d", role: "DOCTOR" });
    expect(r.totalHits).toBe(1);
    expect(r.patientIds).toEqual(["pA"]);
    expect(mockPrisma.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it("filters results by dateFrom/dateTo after FTS", async () => {
    mockPrisma.doctor.findFirst.mockResolvedValueOnce({ id: "d1" });
    mockPrisma.appointment.findMany.mockResolvedValueOnce([{ patientId: "pA" }]);
    mockPrisma.prescription.findMany.mockResolvedValueOnce([]);
    mockPrisma.consultation.findMany.mockResolvedValueOnce([]);

    mockPrisma.$queryRaw.mockResolvedValueOnce([
      {
        id: "old",
        documentType: "LAB_RESULT",
        title: "Old",
        content: "old",
        tags: ["patient:pA", "date:2026-01-01"],
        rank: 0.9,
      },
      {
        id: "new",
        documentType: "LAB_RESULT",
        title: "New",
        content: "new",
        tags: ["patient:pA", "date:2026-04-15"],
        rank: 0.8,
      },
    ]);

    const r = await searchCohort(
      "lab",
      { userId: "u-d", role: "DOCTOR" },
      { dateFrom: new Date("2026-04-01") }
    );
    expect(r.hits.map((h) => h.id)).toEqual(["new"]);
  });
});
