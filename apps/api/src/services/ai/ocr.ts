// OCR + text-extraction helpers used by the RAG ingest pipeline.
//
// Responsibility boundary:
//   - ocr.ts deals strictly with "buffer in -> text out" for known document
//     formats (PDF, PNG, JPEG, plain text). It does not touch the database,
//     Prisma, or rag.ts.
//   - rag-ingest.ts consumes the returned {text, method, confidence} and is
//     responsible for chunking + indexing.
//
// Design notes:
//   - We magic-byte sniff the buffer instead of trusting the declared MIME
//     type because EHR uploads routinely carry wrong Content-Type headers
//     (scanners emitting PNG as "application/octet-stream" etc.).
//   - Both tesseract.js and pdf-parse are heavy deps; if either fails to
//     import (e.g. OCR worker assets missing in a constrained container),
//     extractText falls back to a passthrough result so ingest still succeeds.
//   - Tests MUST mock tesseract.js — running the real worker in CI is slow
//     and flaky (cold-start ~3-6s and needs network for lang data).

export type OcrMethod = "text-layer" | "ocr-image" | "ocr-pdf" | "passthrough";

export interface ExtractResult {
  text: string;
  method: OcrMethod;
  confidence?: number;
  /** Pages that had no text layer and would need rasterized OCR (PDF only). */
  pagesWithoutText?: number[];
}

// ── Observability (mirror of logAICall in sarvam.ts) ─────────────────────────

function logOcrCall(opts: {
  method: OcrMethod | "detect";
  bytes: number;
  latencyMs: number;
  confidence?: number;
  error?: string;
}) {
  // Intentionally mirrors the JSON shape of logAICall in sarvam.ts so our
  // existing log-aggregation pipeline picks it up without any new parsers.
  console.log(
    JSON.stringify({
      level: "info",
      event: "ocr_call",
      ...opts,
      ts: new Date().toISOString(),
    })
  );
}

// ── Magic-byte detection ─────────────────────────────────────────────────────

export type DetectedMime =
  | "application/pdf"
  | "image/png"
  | "image/jpeg"
  | "text/plain"
  | "application/octet-stream";

/**
 * Detect the true MIME type of a buffer by inspecting its leading magic bytes.
 * Falls back to `application/octet-stream` when no known signature matches.
 * This intentionally recognises only the handful of formats we actually
 * process in the RAG ingest pipeline.
 */
export function detectMimeType(buffer: Buffer): DetectedMime {
  if (!buffer || buffer.length < 4) return "application/octet-stream";

  // PDF: "%PDF"
  if (
    buffer[0] === 0x25 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x44 &&
    buffer[3] === 0x46
  ) {
    return "application/pdf";
  }
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return "image/png";
  }
  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }
  // Heuristic for plain text: scan a prefix for control chars; if <5% are
  // non-printable / non-whitespace, call it text.
  const sample = buffer.subarray(0, Math.min(buffer.length, 512));
  let suspicious = 0;
  for (const byte of sample) {
    const isPrintable =
      (byte >= 0x20 && byte <= 0x7e) ||
      byte === 0x09 || // tab
      byte === 0x0a || // \n
      byte === 0x0d; // \r
    const isUtf8Cont = byte >= 0x80; // allow UTF-8 multibyte
    if (!isPrintable && !isUtf8Cont) suspicious++;
  }
  if (sample.length > 0 && suspicious / sample.length < 0.05) {
    return "text/plain";
  }
  return "application/octet-stream";
}

// ── Image OCR (tesseract.js) ─────────────────────────────────────────────────

/**
 * Run Tesseract OCR on an image buffer (PNG/JPEG). Returns the extracted text
 * and an aggregate confidence score 0..1. Uses `eng+hin` by default to cover
 * bilingual Indian prescriptions. Callers should treat very low confidence
 * (<0.4) as likely-unreliable.
 *
 * Graceful failure: returns empty text with `confidence: 0` if tesseract.js
 * is not available or the recognize call throws.
 */
export async function ocrImage(
  buffer: Buffer,
  lang?: string
): Promise<{ text: string; confidence: number }> {
  const t0 = Date.now();
  try {
    // Dynamic import so a missing install doesn't break module load.
    const tesseract: any = await import("tesseract.js");
    const recognize = tesseract.recognize ?? tesseract.default?.recognize;
    if (typeof recognize !== "function") {
      throw new Error("tesseract.js recognize() not found");
    }
    const result = await recognize(buffer, lang ?? "eng+hin");
    const text: string = result?.data?.text ?? "";
    // Tesseract reports confidence as 0..100 — normalise to 0..1.
    const rawConf: number = result?.data?.confidence ?? 0;
    const confidence = rawConf > 1 ? rawConf / 100 : rawConf;
    logOcrCall({
      method: "ocr-image",
      bytes: buffer.length,
      latencyMs: Date.now() - t0,
      confidence,
    });
    return { text: text.trim(), confidence };
  } catch (err) {
    logOcrCall({
      method: "ocr-image",
      bytes: buffer.length,
      latencyMs: Date.now() - t0,
      error: err instanceof Error ? err.message : String(err),
    });
    return { text: "", confidence: 0 };
  }
}

// ── PDF text extraction (pdf-parse) ──────────────────────────────────────────

/**
 * Extract embedded text from a PDF using pdf-parse. When a PDF has a real
 * text layer this is fast (<100ms) and perfectly accurate. Scanned PDFs
 * (image-only pages) will return empty or near-empty text — those pages are
 * reported via `pagesWithoutText` so callers can decide whether to rasterise
 * and OCR later. We deliberately do NOT call pdfjs-dist render + Tesseract
 * here because that is expensive (10s+/page) and blocks the ingest worker;
 * the follow-up pass is scheduled separately.
 */
export async function ocrPdf(buffer: Buffer): Promise<ExtractResult> {
  const t0 = Date.now();
  try {
    const mod: any = await import("pdf-parse");
    // pdf-parse v2 exports a PDFParse class; v1 exported a default function.
    const PDFParse = mod.PDFParse ?? mod.default?.PDFParse ?? mod.default;
    if (!PDFParse) {
      throw new Error("pdf-parse PDFParse class not found");
    }

    let combined = "";
    const pagesWithoutText: number[] = [];

    // v2 API: new PDFParse({ data }).getText()
    if (typeof PDFParse === "function" && PDFParse.prototype?.getText) {
      const parser = new PDFParse({ data: new Uint8Array(buffer) });
      try {
        const result = await parser.getText();
        const pages: Array<{ num: number; text: string }> = result?.pages ?? [];
        for (const p of pages) {
          if (!p.text || p.text.trim().length < 5) {
            pagesWithoutText.push(p.num);
          }
        }
        combined = (result?.text ?? "").trim();
      } finally {
        if (typeof parser.destroy === "function") {
          await parser.destroy().catch(() => {});
        }
      }
    } else if (typeof PDFParse === "function") {
      // v1 API fallback: pdfParse(buffer) -> { text }
      const result: any = await (PDFParse as any)(buffer);
      combined = (result?.text ?? "").trim();
    }

    const latencyMs = Date.now() - t0;
    logOcrCall({
      method: "text-layer",
      bytes: buffer.length,
      latencyMs,
    });

    return {
      text: combined,
      method: "text-layer",
      // Text-layer extraction is deterministic; confidence is effectively 1.0
      // unless the entire document had no extractable text (caller should
      // treat empty text as a signal to fall back to raster OCR later).
      confidence: combined.length > 0 ? 1.0 : 0,
      pagesWithoutText: pagesWithoutText.length > 0 ? pagesWithoutText : undefined,
    };
  } catch (err) {
    logOcrCall({
      method: "text-layer",
      bytes: buffer.length,
      latencyMs: Date.now() - t0,
      error: err instanceof Error ? err.message : String(err),
    });
    return { text: "", method: "text-layer", confidence: 0 };
  }
}

// ── Top-level router ─────────────────────────────────────────────────────────

/**
 * Extract text from an arbitrary document buffer. The caller passes the
 * declared MIME type (from HTTP headers or the DB), but the real format is
 * determined by magic-byte inspection — a file uploaded as "application/pdf"
 * that actually is a PNG still gets routed to image OCR.
 *
 * Returns `method: "passthrough"` and empty text when the format is not
 * supported or both libraries fail to load. Callers should treat very short
 * results (<50 chars) as likely-unreliable and skip indexing them.
 */
export async function extractText(
  buffer: Buffer,
  declaredMime?: string | null
): Promise<ExtractResult> {
  if (!buffer || buffer.length === 0) {
    return { text: "", method: "passthrough" };
  }
  const detected = detectMimeType(buffer);
  // Log when the caller's declared MIME disagrees with reality — useful for
  // debugging broken upload pipelines.
  if (declaredMime && detected !== "application/octet-stream") {
    const norm = declaredMime.split(";")[0].trim().toLowerCase();
    if (norm && norm !== detected) {
      console.log(
        JSON.stringify({
          level: "warn",
          event: "ocr_mime_mismatch",
          declared: norm,
          detected,
          ts: new Date().toISOString(),
        })
      );
    }
  }

  if (detected === "text/plain") {
    return {
      text: buffer.toString("utf8").trim(),
      method: "passthrough",
      confidence: 1.0,
    };
  }

  if (detected === "application/pdf") {
    const res = await ocrPdf(buffer);
    // If the PDF has a text layer, return that.
    if (res.text.length > 0) return res;
    // Otherwise flag it as needing raster OCR; return what little we have.
    return {
      text: res.text,
      method: "ocr-pdf",
      confidence: 0,
      pagesWithoutText: res.pagesWithoutText,
    };
  }

  if (detected === "image/png" || detected === "image/jpeg") {
    const res = await ocrImage(buffer);
    return { text: res.text, method: "ocr-image", confidence: res.confidence };
  }

  // Unknown/binary: passthrough so ingest still succeeds without content.
  return { text: "", method: "passthrough" };
}
