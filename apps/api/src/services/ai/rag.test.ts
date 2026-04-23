import { describe, it, expect, vi, beforeEach } from "vitest";

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    $queryRaw: vi.fn(),
    knowledgeChunk: {
      findFirst: vi.fn(),
      update: vi.fn(),
      create: vi.fn(),
    },
    icd10Code: { findMany: vi.fn() },
    medicine: { findMany: vi.fn() },
  } as any,
}));

vi.mock("@medcore/db", () => ({ prisma: prismaMock }));

import { retrieveContext, indexChunk, seedFromExistingData } from "./rag";

beforeEach(() => {
  prismaMock.$queryRaw.mockReset();
  prismaMock.knowledgeChunk.findFirst.mockReset();
  prismaMock.knowledgeChunk.update.mockReset();
  prismaMock.knowledgeChunk.create.mockReset();
  prismaMock.icd10Code.findMany.mockReset();
  prismaMock.medicine.findMany.mockReset();
});

// ── retrieveContext ───────────────────────────────────────────────────────────

describe("retrieveContext", () => {
  it("returns empty string for empty/whitespace query", async () => {
    const res = await retrieveContext("");
    expect(res).toBe("");
    const res2 = await retrieveContext("   ");
    expect(res2).toBe("");
    expect(prismaMock.$queryRaw).not.toHaveBeenCalled();
  });

  it("returns empty string when FTS finds no matches", async () => {
    prismaMock.$queryRaw.mockResolvedValueOnce([]);
    const res = await retrieveContext("rare disease zzz");
    expect(res).toBe("");
  });

  it("formats results with document-type tag and numbering", async () => {
    prismaMock.$queryRaw.mockResolvedValueOnce([
      { title: "J00 Acute nasopharyngitis", content: "Common cold", documentType: "ICD10" },
      { title: "Paracetamol", content: "Analgesic", documentType: "MEDICINE" },
    ]);
    const res = await retrieveContext("cough fever");
    expect(res).toContain("[KNOWLEDGE BASE CONTEXT]");
    expect(res).toContain("1. [ICD10] J00 Acute nasopharyngitis: Common cold");
    expect(res).toContain("2. [MEDICINE] Paracetamol: Analgesic");
    expect(res).toContain("---");
  });

  it("runs the filtered FTS query when documentTypes provided", async () => {
    prismaMock.$queryRaw.mockResolvedValueOnce([]);
    await retrieveContext("fever", 3, ["ICD10", "MEDICINE"]);
    // $queryRaw tagged template: args[0] is the strings array, then interpolated values.
    const args = prismaMock.$queryRaw.mock.calls[0];
    // The filtered path passes documentTypes, query twice, and limit → 4 interpolations total.
    // args = [stringsArray, documentTypes, query, query, limit]
    expect(args).toHaveLength(5);
    expect(args[1]).toEqual(["ICD10", "MEDICINE"]);
    expect(args[4]).toBe(3);
  });

  it("runs the unfiltered FTS query when documentTypes absent", async () => {
    prismaMock.$queryRaw.mockResolvedValueOnce([]);
    await retrieveContext("sore throat", 5);
    const args = prismaMock.$queryRaw.mock.calls[0];
    // unfiltered: query, query, limit → 3 interpolations
    expect(args).toHaveLength(4);
    expect(args[3]).toBe(5);
  });

  it("accepts a long query without truncation", async () => {
    prismaMock.$queryRaw.mockResolvedValueOnce([
      { title: "Hit", content: "c", documentType: "ICD10" },
    ]);
    const bigQuery = "word ".repeat(200).trim();
    const res = await retrieveContext(bigQuery);
    expect(res).toContain("Hit");
    const args = prismaMock.$queryRaw.mock.calls[0];
    expect(args[1]).toBe(bigQuery);
  });
});

// ── indexChunk ────────────────────────────────────────────────────────────────

describe("indexChunk", () => {
  it("creates a new chunk when no sourceId is provided", async () => {
    prismaMock.knowledgeChunk.create.mockResolvedValue({ id: "k1" });
    await indexChunk({ documentType: "NOTE", title: "T", content: "C" });
    expect(prismaMock.knowledgeChunk.create).toHaveBeenCalledTimes(1);
    expect(prismaMock.knowledgeChunk.findFirst).not.toHaveBeenCalled();
  });

  it("creates a new chunk when sourceId provided but no existing record", async () => {
    prismaMock.knowledgeChunk.findFirst.mockResolvedValueOnce(null);
    prismaMock.knowledgeChunk.create.mockResolvedValueOnce({ id: "new" });
    await indexChunk({
      documentType: "ICD10",
      title: "A01",
      content: "Typhoid",
      sourceId: "icd10-A01",
    });
    expect(prismaMock.knowledgeChunk.findFirst).toHaveBeenCalledWith({
      where: { sourceId: "icd10-A01" },
      select: { id: true },
    });
    const createArgs = prismaMock.knowledgeChunk.create.mock.calls[0][0];
    expect(createArgs.data.sourceId).toBe("icd10-A01");
    expect(createArgs.data.documentType).toBe("ICD10");
  });

  it("updates existing chunk when sourceId match is found", async () => {
    prismaMock.knowledgeChunk.findFirst.mockResolvedValueOnce({ id: "existing-1" });
    prismaMock.knowledgeChunk.update.mockResolvedValueOnce({ id: "existing-1" });
    await indexChunk({
      documentType: "MEDICINE",
      title: "Aspirin",
      content: "NSAID",
      sourceId: "med-1",
    });
    expect(prismaMock.knowledgeChunk.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "existing-1" } })
    );
    expect(prismaMock.knowledgeChunk.create).not.toHaveBeenCalled();
  });

  it("defaults language to 'en' and tags to empty array", async () => {
    prismaMock.knowledgeChunk.create.mockResolvedValue({ id: "new" });
    await indexChunk({ documentType: "X", title: "t", content: "c" });
    const args = prismaMock.knowledgeChunk.create.mock.calls[0][0];
    expect(args.data.language).toBe("en");
    expect(args.data.tags).toEqual([]);
    expect(args.data.active).toBe(true);
  });
});

// ── seedFromExistingData ──────────────────────────────────────────────────────

describe("seedFromExistingData", () => {
  it("returns counts and indexes ICD10 + medicines", async () => {
    prismaMock.icd10Code.findMany.mockResolvedValueOnce([
      { code: "A01", description: "Typhoid", category: "Infectious" },
      { code: "B02", description: "Herpes zoster", category: null },
    ]);
    prismaMock.medicine.findMany.mockResolvedValueOnce([
      {
        id: "m1",
        name: "Aspirin",
        genericName: "acetylsalicylic acid",
        description: "NSAID",
        contraindications: null,
        sideEffects: null,
        pregnancyCategory: null,
        renalAdjustmentNotes: null,
        category: "NSAID",
      },
    ]);
    prismaMock.knowledgeChunk.findFirst.mockResolvedValue(null);
    prismaMock.knowledgeChunk.create.mockResolvedValue({ id: "k" });

    const out = await seedFromExistingData();
    expect(out).toEqual({ icd10: 2, medicines: 1 });
    // 2 ICD + 1 med = 3 creates
    expect(prismaMock.knowledgeChunk.create).toHaveBeenCalledTimes(3);
  });

  it("returns zero counts when catalogues are empty", async () => {
    prismaMock.icd10Code.findMany.mockResolvedValueOnce([]);
    prismaMock.medicine.findMany.mockResolvedValueOnce([]);
    const out = await seedFromExistingData();
    expect(out).toEqual({ icd10: 0, medicines: 0 });
    expect(prismaMock.knowledgeChunk.create).not.toHaveBeenCalled();
  });
});
