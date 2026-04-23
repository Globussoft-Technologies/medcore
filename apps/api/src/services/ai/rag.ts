import { prisma } from "@medcore/db";

// ── retrieveContext ────────────────────────────────────────────────────────────

/**
 * Retrieve top-k relevant knowledge chunks for a query using PostgreSQL
 * full-text search. Returns a formatted context string, or empty string if
 * no results are found.
 */
export async function retrieveContext(
  query: string,
  limit = 5,
  documentTypes?: string[]
): Promise<string> {
  if (!query.trim()) return "";

  // Use $queryRaw with tagged template for safe parameter binding.
  // The ANY($1::text[]) trick handles both filtered and unfiltered cases
  // by passing either an array of types or NULL.
  type ChunkRow = { title: string; content: string; documentType: string };

  let rows: ChunkRow[];

  if (documentTypes && documentTypes.length > 0) {
    rows = await prisma.$queryRaw<ChunkRow[]>`
      SELECT title, content, "documentType"
      FROM knowledge_chunks
      WHERE active = true
        AND "documentType" = ANY(${documentTypes}::text[])
        AND to_tsvector('english', content || ' ' || title) @@ plainto_tsquery('english', ${query})
      ORDER BY ts_rank(
        to_tsvector('english', content || ' ' || title),
        plainto_tsquery('english', ${query})
      ) DESC
      LIMIT ${limit}
    `;
  } else {
    rows = await prisma.$queryRaw<ChunkRow[]>`
      SELECT title, content, "documentType"
      FROM knowledge_chunks
      WHERE active = true
        AND to_tsvector('english', content || ' ' || title) @@ plainto_tsquery('english', ${query})
      ORDER BY ts_rank(
        to_tsvector('english', content || ' ' || title),
        plainto_tsquery('english', ${query})
      ) DESC
      LIMIT ${limit}
    `;
  }

  if (!rows || rows.length === 0) return "";

  const lines = rows.map((row, idx) => {
    const tag = `[${row.documentType}]`;
    return `${idx + 1}. ${tag} ${row.title}: ${row.content}`;
  });

  return `[KNOWLEDGE BASE CONTEXT]\n${lines.join("\n")}\n---`;
}

// ── indexChunk ─────────────────────────────────────────────────────────────────

/**
 * Index a new knowledge chunk, or update an existing one keyed on `sourceId`.
 * If `sourceId` is not provided, always creates a new record.
 */
export async function indexChunk(chunk: {
  documentType: string;
  title: string;
  content: string;
  sourceId?: string;
  tags?: string[];
  language?: string;
}): Promise<void> {
  const data = {
    documentType: chunk.documentType,
    title: chunk.title,
    content: chunk.content,
    tags: chunk.tags ?? [],
    language: chunk.language ?? "en",
    active: true,
  };

  if (chunk.sourceId) {
    const existing = await prisma.knowledgeChunk.findFirst({
      where: { sourceId: chunk.sourceId },
      select: { id: true },
    });
    if (existing) {
      await prisma.knowledgeChunk.update({ where: { id: existing.id }, data });
    } else {
      await prisma.knowledgeChunk.create({ data: { ...data, sourceId: chunk.sourceId } });
    }
  } else {
    await prisma.knowledgeChunk.create({ data });
  }
}

// ── seedFromExistingData ───────────────────────────────────────────────────────

/**
 * Seed the knowledge base from existing DB tables (Icd10Code + Medicine).
 * Returns the count of records upserted for each source.
 */
export async function seedFromExistingData(): Promise<{ icd10: number; medicines: number }> {
  // ── ICD-10 codes ────────────────────────────────────────────────────────────
  const icd10Codes = await prisma.icd10Code.findMany();

  for (const record of icd10Codes) {
    await indexChunk({
      documentType: "ICD10",
      title: `${record.code} ${record.description}`,
      content: record.description + (record.category ? ` Category: ${record.category}` : ""),
      sourceId: `icd10-${record.code}`,
      tags: [record.category ?? ""],
    });
  }

  // ── Medicines ───────────────────────────────────────────────────────────────
  const medicines = await prisma.medicine.findMany({
    where: {
      OR: [
        { description: { not: null } },
        { contraindications: { not: null } },
      ],
    },
  });

  for (const med of medicines) {
    const contentParts = [
      med.description,
      med.contraindications,
      med.sideEffects,
      med.pregnancyCategory ? `Pregnancy: ${med.pregnancyCategory}` : null,
      med.renalAdjustmentNotes,
    ].filter(Boolean) as string[];

    await indexChunk({
      documentType: "MEDICINE",
      title: med.name + (med.genericName ? ` (${med.genericName})` : ""),
      content: contentParts.join(". "),
      sourceId: `medicine-${med.id}`,
      tags: [med.category ?? ""],
    });
  }

  return { icd10: icd10Codes.length, medicines: medicines.length };
}
