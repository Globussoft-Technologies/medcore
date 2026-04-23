// Unit tests for the RAG ingest pipeline. Prisma and indexChunk are mocked,
// so these tests exercise the chunking + tagging logic without a database.

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted mock handles ──────────────────────────────────────────────────────
const { mockPrisma, mockIndexChunk } = vi.hoisted(() => {
  return {
    mockPrisma: {
      consultation: { findUnique: vi.fn(), findMany: vi.fn() },
      labResult: { findUnique: vi.fn(), findMany: vi.fn() },
      prescription: { findUnique: vi.fn(), findMany: vi.fn() },
      patientDocument: { findUnique: vi.fn(), findMany: vi.fn() },
    },
    mockIndexChunk: vi.fn(async (..._args: any[]) => {}),
  };
});

vi.mock("@medcore/db", () => ({ prisma: mockPrisma }));
vi.mock("./rag", () => ({ indexChunk: mockIndexChunk }));

import {
  ingestConsultation,
  ingestLabResult,
  ingestPrescription,
  ingestEhrDocument,
  backfillIngest,
  splitIntoChunks,
} from "./rag-ingest";

beforeEach(() => {
  vi.clearAllMocks();
});

// ── splitIntoChunks ───────────────────────────────────────────────────────────
describe("splitIntoChunks", () => {
  it("returns empty array for empty input", () => {
    expect(splitIntoChunks("")).toEqual([]);
    expect(splitIntoChunks("   ")).toEqual([]);
  });

  it("returns single chunk when text is short", () => {
    const chunks = splitIntoChunks("short note");
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe("short note");
  });

  it("splits long text on paragraph boundaries", () => {
    const paragraph = "A".repeat(500);
    const input = `${paragraph}\n\n${paragraph}\n\n${paragraph}`;
    const chunks = splitIntoChunks(input, 800);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(1600);
  });
});

// ── ingestConsultation ────────────────────────────────────────────────────────
describe("ingestConsultation", () => {
  it("returns 0 when consultation not found", async () => {
    mockPrisma.consultation.findUnique.mockResolvedValueOnce(null);
    const r = await ingestConsultation("missing-id");
    expect(r.chunks).toBe(0);
    expect(mockIndexChunk).not.toHaveBeenCalled();
  });

  it("indexes a consultation with patient/doctor/date tags", async () => {
    const date = new Date("2026-04-15T10:00:00Z");
    mockPrisma.consultation.findUnique.mockResolvedValueOnce({
      id: "c1",
      doctorId: "doc1",
      notes: "SOAP content: patient presented with chest pain. ECG normal.",
      findings: "Mild tenderness on palpation.",
      createdAt: date,
      appointment: { patientId: "pat1", date },
    });

    const r = await ingestConsultation("c1");
    expect(r.chunks).toBe(1);
    expect(mockIndexChunk).toHaveBeenCalledTimes(1);
    const arg = mockIndexChunk.mock.calls[0][0] as any;
    expect(arg.documentType).toBe("CONSULTATION");
    expect(arg.sourceId).toBe("consultation-c1-0");
    expect(arg.tags).toContain("patient:pat1");
    expect(arg.tags).toContain("doctor:doc1");
    expect(arg.tags).toContain("date:2026-04-15");
    expect(arg.tags).toContain("source:consultation");
    expect(arg.content).toContain("chest pain");
    expect(arg.content).toContain("tenderness");
  });

  it("returns 0 when notes and findings are both empty", async () => {
    mockPrisma.consultation.findUnique.mockResolvedValueOnce({
      id: "c2",
      doctorId: "doc1",
      notes: "",
      findings: "",
      createdAt: new Date(),
      appointment: { patientId: "pat1", date: new Date() },
    });
    const r = await ingestConsultation("c2");
    expect(r.chunks).toBe(0);
    expect(mockIndexChunk).not.toHaveBeenCalled();
  });
});

// ── ingestLabResult ───────────────────────────────────────────────────────────
describe("ingestLabResult", () => {
  it("skips NORMAL results without a delta flag", async () => {
    mockPrisma.labResult.findUnique.mockResolvedValueOnce({
      id: "l1",
      flag: "NORMAL",
      deltaFlag: false,
      parameter: "Hb",
      value: "14",
      unit: "g/dL",
      normalRange: "13-17",
      notes: null,
      reportedAt: new Date(),
      orderItem: {
        order: { patientId: "pat1", doctorId: "doc1", orderNumber: "L1" },
        test: { name: "CBC", code: "CBC001" },
      },
    });

    const r = await ingestLabResult("l1");
    expect(r.chunks).toBe(0);
    expect(mockIndexChunk).not.toHaveBeenCalled();
  });

  it("indexes HIGH-flag results with the correct flag tag", async () => {
    mockPrisma.labResult.findUnique.mockResolvedValueOnce({
      id: "l2",
      flag: "HIGH",
      deltaFlag: false,
      parameter: "HbA1c",
      value: "9.2",
      unit: "%",
      normalRange: "4-5.6",
      notes: "Poor glycaemic control",
      reportedAt: new Date("2026-04-20"),
      orderItem: {
        order: { patientId: "pat1", doctorId: "doc1", orderNumber: "L2" },
        test: { name: "HbA1c", code: "HBA1C" },
      },
    });

    const r = await ingestLabResult("l2");
    expect(r.chunks).toBe(1);
    const arg = mockIndexChunk.mock.calls[0][0] as any;
    expect(arg.documentType).toBe("LAB_RESULT");
    expect(arg.tags).toContain("patient:pat1");
    expect(arg.tags).toContain("doctor:doc1");
    expect(arg.tags).toContain("flag:HIGH");
    expect(arg.content).toContain("HbA1c");
    expect(arg.content).toContain("9.2");
  });

  it("indexes delta-flagged normal results", async () => {
    mockPrisma.labResult.findUnique.mockResolvedValueOnce({
      id: "l3",
      flag: "NORMAL",
      deltaFlag: true,
      parameter: "Creatinine",
      value: "1.4",
      unit: "mg/dL",
      normalRange: "0.6-1.3",
      notes: null,
      reportedAt: new Date(),
      orderItem: {
        order: { patientId: "pat1", doctorId: "doc1", orderNumber: "L3" },
        test: { name: "Creatinine", code: "CR" },
      },
    });

    const r = await ingestLabResult("l3");
    expect(r.chunks).toBe(1);
    expect(mockIndexChunk).toHaveBeenCalledTimes(1);
  });
});

// ── ingestPrescription ────────────────────────────────────────────────────────
describe("ingestPrescription", () => {
  it("indexes prescription with diagnosis + medication tags", async () => {
    mockPrisma.prescription.findUnique.mockResolvedValueOnce({
      id: "rx1",
      patientId: "pat1",
      doctorId: "doc1",
      diagnosis: "Type 2 diabetes mellitus",
      advice: "Low-carb diet, daily walks",
      followUpDate: null,
      createdAt: new Date("2026-04-10"),
      items: [
        {
          medicineName: "Metformin",
          dosage: "500mg",
          frequency: "BID",
          duration: "30 days",
          instructions: "After meals",
        },
      ],
    });

    const r = await ingestPrescription("rx1");
    expect(r.chunks).toBe(1);
    const arg = mockIndexChunk.mock.calls[0][0] as any;
    expect(arg.documentType).toBe("PRESCRIPTION");
    expect(arg.tags).toContain("patient:pat1");
    expect(arg.tags).toContain("doctor:doc1");
    expect(arg.tags).toContain("med:metformin");
    expect(arg.content).toContain("diabetes");
    expect(arg.content).toContain("Metformin");
  });

  it("returns 0 when prescription not found", async () => {
    mockPrisma.prescription.findUnique.mockResolvedValueOnce(null);
    const r = await ingestPrescription("missing");
    expect(r.chunks).toBe(0);
  });
});

// ── ingestEhrDocument ─────────────────────────────────────────────────────────
describe("ingestEhrDocument", () => {
  it("skips indexing when extracted text is empty (missing file)", async () => {
    mockPrisma.patientDocument.findUnique.mockResolvedValueOnce({
      id: "d1",
      patientId: "pat1",
      type: "LAB_REPORT",
      title: "CBC PDF",
      filePath: "/tmp/does-not-exist.pdf",
      mimeType: "application/pdf",
      notes: null,
      createdAt: new Date("2026-04-01"),
    });

    const r = await ingestEhrDocument("d1");
    // File doesn't exist -> extraction fails -> below MIN_USEFUL_TEXT_LEN.
    expect(r.ocrSkipped).toBe(true);
    expect(r.chunks).toBe(0);
    expect(mockIndexChunk).not.toHaveBeenCalled();
  });

  it("indexes .txt documents with ocr provenance tags", async () => {
    const fs = await import("fs/promises");
    const path = await import("path");
    const os = await import("os");
    const tmpFile = path.join(os.tmpdir(), `medcore-ingest-${Date.now()}.txt`);
    const body =
      "Patient presents with fever 101F, persistent dry cough for 3 days. " +
      "BP 120/80, PR 88. Plan: rest, hydration, paracetamol 500mg TDS.";
    await fs.writeFile(tmpFile, body, "utf8");

    try {
      mockPrisma.patientDocument.findUnique.mockResolvedValueOnce({
        id: "d2",
        patientId: "pat1",
        type: "DISCHARGE_SUMMARY",
        title: "Discharge Notes",
        filePath: tmpFile,
        mimeType: "text/plain",
        notes: null,
        createdAt: new Date("2026-04-01"),
      });

      const r = await ingestEhrDocument("d2");
      expect(r.ocrSkipped).toBe(false);
      expect(r.chunks).toBeGreaterThan(0);
      expect(r.method).toBe("passthrough");
      const arg = mockIndexChunk.mock.calls[0][0] as any;
      expect(arg.documentType).toBe("EHR_DOCUMENT");
      expect(arg.tags).toContain("patient:pat1");
      expect(arg.tags).toContain("doctype:DISCHARGE_SUMMARY");
      expect(arg.tags).toContain("ocr:passthrough");
      expect(arg.tags.some((t: string) => t.startsWith("confidence:"))).toBe(true);
    } finally {
      await fs.unlink(tmpFile).catch(() => {});
    }
  });
});

// ── backfillIngest ────────────────────────────────────────────────────────────
describe("backfillIngest", () => {
  it("iterates across all four categories within date window", async () => {
    mockPrisma.consultation.findMany.mockResolvedValueOnce([]);
    mockPrisma.labResult.findMany.mockResolvedValueOnce([]);
    mockPrisma.prescription.findMany.mockResolvedValueOnce([]);
    mockPrisma.patientDocument.findMany.mockResolvedValueOnce([]);

    const r = await backfillIngest({
      fromDate: new Date("2026-01-01"),
      toDate: new Date("2026-04-23"),
      limit: 10,
    });

    expect(mockPrisma.consultation.findMany).toHaveBeenCalledTimes(1);
    expect(mockPrisma.labResult.findMany).toHaveBeenCalledTimes(1);
    expect(mockPrisma.prescription.findMany).toHaveBeenCalledTimes(1);
    expect(mockPrisma.patientDocument.findMany).toHaveBeenCalledTimes(1);
    expect(r).toEqual({
      consultations: 0,
      labResults: 0,
      prescriptions: 0,
      documents: 0,
      errors: 0,
    });
  });

  it("honours the `types` filter (only lab)", async () => {
    mockPrisma.labResult.findMany.mockResolvedValueOnce([]);
    await backfillIngest({ types: ["lab"], limit: 5 });

    expect(mockPrisma.consultation.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.labResult.findMany).toHaveBeenCalledTimes(1);
    expect(mockPrisma.prescription.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.patientDocument.findMany).not.toHaveBeenCalled();
  });
});
