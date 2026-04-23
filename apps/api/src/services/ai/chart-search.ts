// Ambient chart search — natural-language queries over a doctor's patients.
//
// Two entry points:
//   - searchPatientChart: single-patient search, returns ranked KnowledgeChunks
//     plus an LLM-synthesized answer that cites chunk IDs.
//   - searchCohort: cross-patient search, scoped to the doctor's panel
//     (patients seen via Appointment OR currently/recently prescribed-for).
//
// Access control is enforced INSIDE these functions, not only at the route
// layer, so any future caller (worker, scheduled job, admin UI) inherits the
// same guardrails.

import { prisma } from "@medcore/db";
import { generateText } from "./sarvam";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ChartSearchHit {
  id: string;
  documentType: string;
  title: string;
  content: string;
  tags: string[];
  rank: number;
  patientId: string | null;
  doctorId: string | null;
  date: string | null;
}

export interface ChartSearchResult {
  answer: string;
  hits: ChartSearchHit[];
  citedChunkIds: string[];
  patientIds: string[];
  totalHits: number;
}

export interface CohortFilters {
  // Optional extra filters the doctor can layer on top of the panel scope.
  dateFrom?: Date;
  dateTo?: Date;
  documentTypes?: string[]; // e.g. ["LAB_RESULT", "CONSULTATION"]
  limit?: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function extractTag(tags: string[], prefix: string): string | null {
  const pref = `${prefix}:`;
  const hit = tags.find((t) => t.startsWith(pref));
  return hit ? hit.slice(pref.length) : null;
}

function toHit(row: {
  id: string;
  documentType: string;
  title: string;
  content: string;
  tags: string[];
  rank: number;
}): ChartSearchHit {
  return {
    id: row.id,
    documentType: row.documentType,
    title: row.title,
    content: row.content,
    tags: row.tags,
    rank: row.rank,
    patientId: extractTag(row.tags, "patient"),
    doctorId: extractTag(row.tags, "doctor"),
    date: extractTag(row.tags, "date"),
  };
}

// Compile patientId tags as a safely-typed string[] for the raw FTS query.
function patientTagList(patientIds: string[]): string[] {
  return patientIds.map((p) => `patient:${p}`);
}

// ── Low-level FTS ─────────────────────────────────────────────────────────────

/**
 * Run a FTS query scoped to the given patient tags. Returns up to `limit`
 * ranked chunks. Exported so cohort/patient entry points can both reuse it.
 */
export async function ftsSearchScoped(
  query: string,
  patientTags: string[],
  limit: number,
  documentTypes?: string[]
): Promise<ChartSearchHit[]> {
  if (!query.trim() || patientTags.length === 0) return [];

  type Row = {
    id: string;
    documentType: string;
    title: string;
    content: string;
    tags: string[];
    rank: number;
  };

  // We require tags && patientTags (array overlap) to enforce access scope.
  const rows = await (documentTypes && documentTypes.length > 0
    ? prisma.$queryRaw<Row[]>`
        SELECT id, "documentType", title, content, tags,
          ts_rank(
            to_tsvector('english', content || ' ' || title),
            plainto_tsquery('english', ${query})
          ) AS rank
        FROM knowledge_chunks
        WHERE active = true
          AND tags && ${patientTags}::text[]
          AND "documentType" = ANY(${documentTypes}::text[])
          AND to_tsvector('english', content || ' ' || title) @@ plainto_tsquery('english', ${query})
        ORDER BY rank DESC
        LIMIT ${limit}
      `
    : prisma.$queryRaw<Row[]>`
        SELECT id, "documentType", title, content, tags,
          ts_rank(
            to_tsvector('english', content || ' ' || title),
            plainto_tsquery('english', ${query})
          ) AS rank
        FROM knowledge_chunks
        WHERE active = true
          AND tags && ${patientTags}::text[]
          AND to_tsvector('english', content || ' ' || title) @@ plainto_tsquery('english', ${query})
        ORDER BY rank DESC
        LIMIT ${limit}
      `);

  return rows.map(toHit);
}

// ── LLM synthesis ─────────────────────────────────────────────────────────────

/**
 * Ask the LLM to synthesize a short answer citing chunk IDs. Returns an empty
 * string if the LLM is unreachable; callers should still return the raw hits.
 * Each source line is prefixed with the chunk id and a short context line so
 * the model can cite by id.
 */
export async function synthesizeAnswer(
  query: string,
  hits: ChartSearchHit[]
): Promise<string> {
  if (hits.length === 0) return "";
  const sources = hits
    .slice(0, 10)
    .map((h, i) => {
      const meta = [h.documentType, h.date, h.patientId ? `patient=${h.patientId}` : ""]
        .filter(Boolean)
        .join(" | ");
      return `[${i + 1}] id=${h.id} | ${meta}\n${h.title}\n${h.content}`;
    })
    .join("\n\n---\n\n");

  const systemPrompt =
    "You are a clinical decision-support assistant reading a doctor's own patient chart notes. " +
    "Answer the doctor's question using ONLY the numbered sources provided. " +
    "When you mention a fact, cite the source using square brackets like [1] or [2]. " +
    "If the sources do not contain the answer, say so plainly — do not invent facts. " +
    "Be concise (2-5 sentences).";

  const userPrompt = `Question: ${query}\n\nSources:\n${sources}\n\nAnswer:`;

  return await generateText({
    systemPrompt,
    userPrompt,
    maxTokens: 512,
    temperature: 0.1,
  });
}

// Pull chunk ids (as dumped by the LLM in [n] references) back out of an
// answer so the client can highlight them.
function extractCitedChunkIds(answer: string, hits: ChartSearchHit[]): string[] {
  const ids = new Set<string>();
  const matches = answer.matchAll(/\[(\d+)\]/g);
  for (const m of matches) {
    const idx = parseInt(m[1], 10) - 1;
    if (idx >= 0 && idx < hits.length) ids.add(hits[idx].id);
  }
  return Array.from(ids);
}

// ── Access control ────────────────────────────────────────────────────────────

/**
 * Resolve the set of patient IDs a given doctor is allowed to search.
 * A patient is in the panel if the doctor has ANY appointment with them OR
 * has authored a prescription/consultation for them. Admins pass through.
 */
export async function resolveDoctorPanel(
  user: { userId: string; role: string }
): Promise<{ isAdmin: boolean; patientIds: string[]; doctorId: string | null }> {
  if (user.role === "ADMIN") {
    return { isAdmin: true, patientIds: [], doctorId: null };
  }

  const doctor = await prisma.doctor.findFirst({
    where: { userId: user.userId },
    select: { id: true },
  });
  if (!doctor) return { isAdmin: false, patientIds: [], doctorId: null };

  // Union of patient ids from appointments + prescriptions + consultations.
  const [appts, rx, cons] = await Promise.all([
    prisma.appointment.findMany({
      where: { doctorId: doctor.id },
      select: { patientId: true },
      distinct: ["patientId"],
    }),
    prisma.prescription.findMany({
      where: { doctorId: doctor.id },
      select: { patientId: true },
      distinct: ["patientId"],
    }),
    prisma.consultation.findMany({
      where: { doctorId: doctor.id },
      select: { appointment: { select: { patientId: true } } },
    }),
  ]);

  const set = new Set<string>();
  for (const a of appts) set.add(a.patientId);
  for (const r of rx) set.add(r.patientId);
  for (const c of cons) if (c.appointment?.patientId) set.add(c.appointment.patientId);

  return { isAdmin: false, patientIds: Array.from(set), doctorId: doctor.id };
}

// ── searchPatientChart ────────────────────────────────────────────────────────

/**
 * Natural-language search over a single patient's chart. Enforces that the
 * caller is either ADMIN or the attending doctor (patient must be in the
 * doctor's panel).
 */
export async function searchPatientChart(
  query: string,
  patientId: string,
  user: { userId: string; role: string },
  opts: { limit?: number; documentTypes?: string[]; synthesize?: boolean } = {}
): Promise<ChartSearchResult> {
  const limit = Math.min(opts.limit ?? 10, 50);

  // Access check
  const panel = await resolveDoctorPanel(user);
  if (!panel.isAdmin) {
    if (!panel.patientIds.includes(patientId)) {
      throw Object.assign(new Error("Forbidden: patient is not in your panel"), {
        statusCode: 403,
      });
    }
  }

  const hits = await ftsSearchScoped(query, [`patient:${patientId}`], limit, opts.documentTypes);

  let answer = "";
  if (opts.synthesize !== false && hits.length > 0) {
    answer = await synthesizeAnswer(query, hits);
  }

  return {
    answer,
    hits,
    citedChunkIds: extractCitedChunkIds(answer, hits),
    patientIds: [patientId],
    totalHits: hits.length,
  };
}

// ── searchCohort ──────────────────────────────────────────────────────────────

/**
 * Cross-patient cohort search scoped to the doctor's panel. The doctor can
 * only search across patients they've seen; admin can search all patients.
 *
 * Returns chunks and, if synthesize is not disabled, a short LLM answer that
 * cites chunk IDs. Does NOT return patient PII beyond IDs — the caller is
 * expected to resolve names server-side if needed.
 */
export async function searchCohort(
  query: string,
  user: { userId: string; role: string },
  filters: CohortFilters & { synthesize?: boolean } = {}
): Promise<ChartSearchResult> {
  const limit = Math.min(filters.limit ?? 25, 100);
  const panel = await resolveDoctorPanel(user);

  // Admin — unbounded patient scope. We still apply the "patient:" tag filter
  // because ingested chunks are all patient-tagged; a NULL patient tag means
  // it's a global knowledge chunk (ICD10, medicine) which is NOT what cohort
  // search is for. So admins pass through without the tag filter.
  let hits: ChartSearchHit[];
  if (panel.isAdmin) {
    hits = await ftsSearchAllPatients(query, limit, filters.documentTypes);
  } else {
    if (panel.patientIds.length === 0) {
      return {
        answer: "",
        hits: [],
        citedChunkIds: [],
        patientIds: [],
        totalHits: 0,
      };
    }
    hits = await ftsSearchScoped(
      query,
      patientTagList(panel.patientIds),
      limit,
      filters.documentTypes
    );
  }

  // Optional date filter post-query (date is stored as a tag).
  if (filters.dateFrom || filters.dateTo) {
    const fromISO = filters.dateFrom?.toISOString().slice(0, 10);
    const toISO = filters.dateTo?.toISOString().slice(0, 10);
    hits = hits.filter((h) => {
      if (!h.date) return false;
      if (fromISO && h.date < fromISO) return false;
      if (toISO && h.date > toISO) return false;
      return true;
    });
  }

  let answer = "";
  if (filters.synthesize !== false && hits.length > 0) {
    answer = await synthesizeAnswer(query, hits);
  }

  const patientIds = Array.from(
    new Set(hits.map((h) => h.patientId).filter((p): p is string => Boolean(p)))
  );

  return {
    answer,
    hits,
    citedChunkIds: extractCitedChunkIds(answer, hits),
    patientIds,
    totalHits: hits.length,
  };
}

/**
 * Admin-only FTS across every patient-tagged chunk. Still requires chunks to
 * carry a `patient:<id>` tag so we never return global knowledge-base chunks
 * (ICD10, MEDICINE) from a cohort search.
 */
async function ftsSearchAllPatients(
  query: string,
  limit: number,
  documentTypes?: string[]
): Promise<ChartSearchHit[]> {
  if (!query.trim()) return [];
  type Row = {
    id: string;
    documentType: string;
    title: string;
    content: string;
    tags: string[];
    rank: number;
  };
  const rows = await (documentTypes && documentTypes.length > 0
    ? prisma.$queryRaw<Row[]>`
        SELECT id, "documentType", title, content, tags,
          ts_rank(
            to_tsvector('english', content || ' ' || title),
            plainto_tsquery('english', ${query})
          ) AS rank
        FROM knowledge_chunks
        WHERE active = true
          AND EXISTS (SELECT 1 FROM unnest(tags) t WHERE t LIKE 'patient:%')
          AND "documentType" = ANY(${documentTypes}::text[])
          AND to_tsvector('english', content || ' ' || title) @@ plainto_tsquery('english', ${query})
        ORDER BY rank DESC
        LIMIT ${limit}
      `
    : prisma.$queryRaw<Row[]>`
        SELECT id, "documentType", title, content, tags,
          ts_rank(
            to_tsvector('english', content || ' ' || title),
            plainto_tsquery('english', ${query})
          ) AS rank
        FROM knowledge_chunks
        WHERE active = true
          AND EXISTS (SELECT 1 FROM unnest(tags) t WHERE t LIKE 'patient:%')
          AND to_tsvector('english', content || ' ' || title) @@ plainto_tsquery('english', ${query})
        ORDER BY rank DESC
        LIMIT ${limit}
      `);
  return rows.map(toHit);
}
