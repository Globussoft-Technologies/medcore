// Automated RAG ingest pipeline for MedCore.
//
// Converts clinical records (SOAP notes, lab results, prescriptions, uploaded
// patient documents) into patient-scoped KnowledgeChunks that the chart-search
// service can query. All ingest calls are meant to run fire-and-forget from
// the originating route handler — they must not throw into the request.
//
// Chunk naming & sourceId convention:
//   - sourceId uniquely identifies the origin record so re-ingest is idempotent
//     via `indexChunk` upsert-by-sourceId.
//   - Patient/doctor/date metadata lives in `tags` so FTS can filter by them.
//
// Models that would improve observability (IngestLog) are documented in
// `.prisma-models-rag.md` — DO NOT edit `schema.prisma` here.

import { prisma } from "@medcore/db";
import { indexChunk } from "./rag";

// ── Chunk metadata helpers ────────────────────────────────────────────────────

function patientTag(patientId: string): string {
  return `patient:${patientId}`;
}
function doctorTag(doctorId: string): string {
  return `doctor:${doctorId}`;
}
function dateTag(d: Date | null | undefined): string | null {
  if (!d) return null;
  return `date:${d.toISOString().slice(0, 10)}`;
}

// Split long text into ~800-char chunks on paragraph/sentence boundaries.
// Keeps KnowledgeChunk rows small enough for FTS ranking to work well.
export function splitIntoChunks(text: string, targetLen = 800): string[] {
  const cleaned = text.trim();
  if (cleaned.length === 0) return [];
  if (cleaned.length <= targetLen) return [cleaned];

  const chunks: string[] = [];
  // Prefer paragraph breaks, fall back to sentence breaks.
  const paragraphs = cleaned.split(/\n{2,}/).filter((p) => p.trim().length > 0);
  let buf = "";
  for (const p of paragraphs) {
    if ((buf + "\n\n" + p).length > targetLen && buf.length > 0) {
      chunks.push(buf.trim());
      buf = p;
    } else {
      buf = buf ? `${buf}\n\n${p}` : p;
    }
  }
  if (buf.trim().length > 0) chunks.push(buf.trim());

  // If we still have mega-paragraphs, split them on sentence boundary.
  const final: string[] = [];
  for (const c of chunks) {
    if (c.length <= targetLen * 1.5) {
      final.push(c);
      continue;
    }
    const sentences = c.split(/(?<=[.!?])\s+/);
    let inner = "";
    for (const s of sentences) {
      if ((inner + " " + s).length > targetLen && inner.length > 0) {
        final.push(inner.trim());
        inner = s;
      } else {
        inner = inner ? `${inner} ${s}` : s;
      }
    }
    if (inner.trim().length > 0) final.push(inner.trim());
  }
  return final;
}

// ── ingestConsultation ────────────────────────────────────────────────────────

/**
 * Ingest a finalized consultation (SOAP note) into the knowledge base.
 * Chunks the SOAP note by section and tags each chunk with patient, doctor
 * and the consultation date. Idempotent — re-ingesting the same consultation
 * updates existing chunks via sourceId.
 */
export async function ingestConsultation(consultationId: string): Promise<{ chunks: number }> {
  const consultation = await prisma.consultation.findUnique({
    where: { id: consultationId },
    include: {
      appointment: { select: { patientId: true, date: true } },
    },
  });
  if (!consultation || !consultation.appointment) return { chunks: 0 };

  const patientId = consultation.appointment.patientId;
  const doctorId = consultation.doctorId;
  const date = consultation.appointment.date ?? consultation.createdAt;

  const tags = [
    patientTag(patientId),
    doctorTag(doctorId),
    dateTag(date),
    "source:consultation",
  ].filter(Boolean) as string[];

  const fullText = [
    consultation.notes ? `Notes:\n${consultation.notes}` : "",
    consultation.findings ? `Findings:\n${consultation.findings}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  if (!fullText.trim()) return { chunks: 0 };

  const pieces = splitIntoChunks(fullText);
  let count = 0;
  for (let i = 0; i < pieces.length; i++) {
    await indexChunk({
      documentType: "CONSULTATION",
      title: `Consultation ${date.toISOString().slice(0, 10)} (part ${i + 1}/${pieces.length})`,
      content: pieces[i],
      sourceId: `consultation-${consultationId}-${i}`,
      tags,
    });
    count++;
  }
  return { chunks: count };
}

// ── ingestLabResult ───────────────────────────────────────────────────────────

/**
 * Ingest a lab result into the knowledge base. Only abnormal/critical/delta
 * results are indexed — normal values would flood the index without adding
 * clinical signal.
 */
export async function ingestLabResult(labResultId: string): Promise<{ chunks: number }> {
  const lab = await prisma.labResult.findUnique({
    where: { id: labResultId },
    include: {
      orderItem: {
        include: {
          order: { select: { patientId: true, doctorId: true, orderNumber: true } },
          test: { select: { name: true, code: true } },
        },
      },
    },
  });
  if (!lab || !lab.orderItem) return { chunks: 0 };

  const isAbnormal = lab.flag !== "NORMAL" || lab.deltaFlag;
  if (!isAbnormal) return { chunks: 0 };

  const patientId = lab.orderItem.order.patientId;
  const doctorId = lab.orderItem.order.doctorId;
  const testName = lab.orderItem.test?.name ?? lab.parameter;

  const content = [
    `Test: ${testName} (${lab.orderItem.test?.code ?? ""}).`,
    `Parameter: ${lab.parameter}.`,
    `Value: ${lab.value}${lab.unit ? " " + lab.unit : ""}.`,
    lab.normalRange ? `Normal range: ${lab.normalRange}.` : "",
    `Flag: ${lab.flag}${lab.deltaFlag ? " (significant delta vs prior)" : ""}.`,
    lab.notes ? `Notes: ${lab.notes}` : "",
  ]
    .filter(Boolean)
    .join(" ");

  await indexChunk({
    documentType: "LAB_RESULT",
    title: `Lab ${testName}: ${lab.value}${lab.unit ? " " + lab.unit : ""} [${lab.flag}]`,
    content,
    sourceId: `labresult-${lab.id}`,
    tags: [
      patientTag(patientId),
      doctorTag(doctorId),
      dateTag(lab.reportedAt) ?? "",
      `flag:${lab.flag}`,
      "source:lab",
    ].filter(Boolean) as string[],
  });
  return { chunks: 1 };
}

// ── ingestPrescription ────────────────────────────────────────────────────────

/**
 * Ingest a prescription — diagnosis + prescribed meds — into the knowledge
 * base. Used for cohort queries like "which of my patients are on metformin".
 */
export async function ingestPrescription(prescriptionId: string): Promise<{ chunks: number }> {
  const rx = await prisma.prescription.findUnique({
    where: { id: prescriptionId },
    include: { items: true },
  });
  if (!rx) return { chunks: 0 };

  const medLines = rx.items
    .map((it) => `- ${it.medicineName} ${it.dosage} ${it.frequency} x ${it.duration}${it.instructions ? " (" + it.instructions + ")" : ""}`)
    .join("\n");

  const content = [
    `Diagnosis: ${rx.diagnosis}.`,
    rx.advice ? `Advice: ${rx.advice}.` : "",
    medLines ? `Medications:\n${medLines}` : "",
    rx.followUpDate ? `Follow-up: ${rx.followUpDate.toISOString().slice(0, 10)}.` : "",
  ]
    .filter(Boolean)
    .join("\n");

  if (!content.trim()) return { chunks: 0 };

  await indexChunk({
    documentType: "PRESCRIPTION",
    title: `Rx ${rx.createdAt.toISOString().slice(0, 10)}: ${rx.diagnosis.slice(0, 80)}`,
    content,
    sourceId: `prescription-${rx.id}`,
    tags: [
      patientTag(rx.patientId),
      doctorTag(rx.doctorId),
      dateTag(rx.createdAt) ?? "",
      "source:prescription",
      ...rx.items.map((i) => `med:${i.medicineName.toLowerCase().replace(/\s+/g, "-")}`),
    ].filter(Boolean) as string[],
  });
  return { chunks: 1 };
}

// ── ingestEhrDocument ─────────────────────────────────────────────────────────

/**
 * Ingest an uploaded patient document (lab report PDF, discharge summary,
 * imaging report). Runs OCR/text extraction, then chunks + indexes.
 *
 * OCR is currently STUBBED. Production deployment must wire one of:
 *   - `tesseract.js` (OSS; add as devDep then call `recognize(file.path)`)
 *   - Google Cloud Vision (`@google-cloud/vision`) — India region supported
 *   - AWS Textract (if in AWS)
 *
 * For now we read `.txt` files directly and return an empty string for any
 * binary format, so ingest still succeeds (no hard failure) but the chunk
 * content is a placeholder until OCR is wired.
 */
export async function ingestEhrDocument(documentId: string): Promise<{ chunks: number; ocrStubbed: boolean }> {
  const doc = await prisma.patientDocument.findUnique({
    where: { id: documentId },
  });
  if (!doc) return { chunks: 0, ocrStubbed: false };

  const extracted = await extractTextFromDocument(doc.filePath, doc.mimeType ?? null);
  const ocrStubbed = extracted.ocrStubbed;
  const text = extracted.text.trim();

  const header = `Document: ${doc.title} (${doc.type}).${doc.notes ? " Notes: " + doc.notes + "." : ""}`;
  const body = text.length > 0 ? text : "[Document content not extracted — OCR pipeline pending]";

  const pieces = splitIntoChunks(`${header}\n\n${body}`);
  let count = 0;
  for (let i = 0; i < pieces.length; i++) {
    await indexChunk({
      documentType: "EHR_DOCUMENT",
      title: `${doc.title} (part ${i + 1}/${pieces.length})`,
      content: pieces[i],
      sourceId: `patientdoc-${doc.id}-${i}`,
      tags: [
        patientTag(doc.patientId),
        dateTag(doc.createdAt) ?? "",
        `doctype:${doc.type}`,
        "source:patient-document",
      ].filter(Boolean) as string[],
    });
    count++;
  }
  return { chunks: count, ocrStubbed };
}

/**
 * STUB: plain-text extraction from an uploaded file. Reads `.txt` files
 * directly. Returns `ocrStubbed: true` for anything that would need real OCR.
 * Replace this function's binary branch with a Tesseract/Vision call.
 */
async function extractTextFromDocument(
  filePath: string,
  mimeType: string | null
): Promise<{ text: string; ocrStubbed: boolean }> {
  const fs = await import("fs/promises");
  try {
    if (mimeType?.startsWith("text/") || filePath.endsWith(".txt")) {
      const buf = await fs.readFile(filePath, "utf8");
      return { text: buf, ocrStubbed: false };
    }
    return { text: "", ocrStubbed: true };
  } catch {
    return { text: "", ocrStubbed: true };
  }
}

// ── backfillIngest ────────────────────────────────────────────────────────────

export interface BackfillOptions {
  fromDate?: Date;
  toDate?: Date;
  types?: Array<"consultation" | "lab" | "prescription" | "document">;
  limit?: number; // safety bound per category
}

/**
 * One-time backfill of the knowledge base from existing records. Bounded by
 * date range and per-category limit to avoid runaway load. Safe to re-run —
 * indexChunk is idempotent via sourceId.
 */
export async function backfillIngest(
  options: BackfillOptions = {}
): Promise<{
  consultations: number;
  labResults: number;
  prescriptions: number;
  documents: number;
  errors: number;
}> {
  const fromDate = options.fromDate ?? new Date(Date.now() - 90 * 86400_000); // default: last 90 days
  const toDate = options.toDate ?? new Date();
  const limit = Math.min(options.limit ?? 500, 2000);
  const types = new Set(options.types ?? ["consultation", "lab", "prescription", "document"]);

  let consultations = 0;
  let labResults = 0;
  let prescriptions = 0;
  let documents = 0;
  let errors = 0;

  if (types.has("consultation")) {
    const rows = await prisma.consultation.findMany({
      where: { createdAt: { gte: fromDate, lte: toDate } },
      take: limit,
      select: { id: true },
    });
    for (const row of rows) {
      try {
        const r = await ingestConsultation(row.id);
        consultations += r.chunks;
      } catch {
        errors++;
      }
    }
  }

  if (types.has("lab")) {
    const rows = await prisma.labResult.findMany({
      where: {
        reportedAt: { gte: fromDate, lte: toDate },
        OR: [{ flag: { not: "NORMAL" } }, { deltaFlag: true }],
      },
      take: limit,
      select: { id: true },
    });
    for (const row of rows) {
      try {
        const r = await ingestLabResult(row.id);
        labResults += r.chunks;
      } catch {
        errors++;
      }
    }
  }

  if (types.has("prescription")) {
    const rows = await prisma.prescription.findMany({
      where: { createdAt: { gte: fromDate, lte: toDate } },
      take: limit,
      select: { id: true },
    });
    for (const row of rows) {
      try {
        const r = await ingestPrescription(row.id);
        prescriptions += r.chunks;
      } catch {
        errors++;
      }
    }
  }

  if (types.has("document")) {
    const rows = await prisma.patientDocument.findMany({
      where: { createdAt: { gte: fromDate, lte: toDate } },
      take: limit,
      select: { id: true },
    });
    for (const row of rows) {
      try {
        const r = await ingestEhrDocument(row.id);
        documents += r.chunks;
      } catch {
        errors++;
      }
    }
  }

  return { consultations, labResults, prescriptions, documents, errors };
}

// ── fireAndForget ─────────────────────────────────────────────────────────────

/**
 * Helper to call ingest functions without blocking the request. Swallows
 * errors (logs them) so the caller never fails.
 */
export function fireAndForgetIngest(label: string, fn: () => Promise<unknown>): void {
  setImmediate(() => {
    fn().catch((err) => {
      console.error(`[rag-ingest] ${label} failed (non-fatal):`, err);
    });
  });
}
