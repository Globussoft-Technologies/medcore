// Unit tests for the OCR + text-extraction helpers. Tesseract is mocked —
// running the real worker in CI is slow (~3-6s cold start) and flaky (needs
// network to fetch lang data). The pdf-parse path uses a small hand-crafted
// PDF generated at test time with pdfkit.

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted Tesseract mock ────────────────────────────────────────────────────
// recognize() is swapped per test to simulate success/empty/throw cases.

const { mockRecognize } = vi.hoisted(() => ({
  mockRecognize: vi.fn(),
}));

vi.mock("tesseract.js", () => ({
  // tesseract.js exports { recognize } as a named function in both CJS and
  // ESM entrypoints, so we just expose the mock in the same shape.
  recognize: mockRecognize,
  default: { recognize: mockRecognize },
}));

import { detectMimeType, ocrImage, ocrPdf, extractText } from "./ocr";

beforeEach(() => {
  mockRecognize.mockReset();
});

// ── detectMimeType ────────────────────────────────────────────────────────────

describe("detectMimeType", () => {
  it("recognises PDF magic bytes", () => {
    const buf = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
    expect(detectMimeType(buf)).toBe("application/pdf");
  });

  it("recognises PNG magic bytes", () => {
    const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(detectMimeType(buf)).toBe("image/png");
  });

  it("recognises JPEG magic bytes", () => {
    const buf = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
    expect(detectMimeType(buf)).toBe("image/jpeg");
  });

  it("recognises plain UTF-8 text", () => {
    const buf = Buffer.from(
      "Patient presents with headache and fever. BP 120/80.",
      "utf8"
    );
    expect(detectMimeType(buf)).toBe("text/plain");
  });

  it("returns octet-stream for unknown binary data", () => {
    // A short binary blob full of control chars.
    const buf = Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08]);
    expect(detectMimeType(buf)).toBe("application/octet-stream");
  });

  it("handles buffers shorter than the signature length", () => {
    expect(detectMimeType(Buffer.from([0x25]))).toBe("application/octet-stream");
    expect(detectMimeType(Buffer.alloc(0))).toBe("application/octet-stream");
  });
});

// ── ocrImage ──────────────────────────────────────────────────────────────────

describe("ocrImage", () => {
  it("returns text and normalised confidence from Tesseract", async () => {
    mockRecognize.mockResolvedValueOnce({
      data: { text: "  Rx: Paracetamol 500mg TDS\n", confidence: 87 },
    });

    const pngBuf = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const result = await ocrImage(pngBuf);

    expect(result.text).toBe("Rx: Paracetamol 500mg TDS");
    // 87 (tesseract 0..100 scale) should be normalised to 0.87.
    expect(result.confidence).toBeCloseTo(0.87, 2);
    expect(mockRecognize).toHaveBeenCalledWith(pngBuf, "eng+hin");
  });

  it("honours custom language code", async () => {
    mockRecognize.mockResolvedValueOnce({
      data: { text: "hello", confidence: 99 },
    });
    await ocrImage(Buffer.from([0xff, 0xd8, 0xff]), "eng");
    expect(mockRecognize).toHaveBeenCalledWith(expect.any(Buffer), "eng");
  });

  it("returns empty text on tesseract failure", async () => {
    mockRecognize.mockRejectedValueOnce(new Error("worker crashed"));
    const result = await ocrImage(Buffer.from([0xff, 0xd8, 0xff]));
    expect(result).toEqual({ text: "", confidence: 0 });
  });
});

// ── ocrPdf (real pdf-parse on a tiny in-process PDF) ─────────────────────────

/**
 * Build a one-page PDF with pdfkit containing the supplied text. Returns the
 * raw bytes as a Buffer. Uses pdfkit because it's already a direct dependency
 * of @medcore/api (no extra install required in tests).
 */
async function buildTestPdf(text: string): Promise<Buffer> {
  const PDFDocument = (await import("pdfkit")).default;
  return await new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 50 });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    doc.fontSize(14).text(text);
    doc.end();
  });
}

describe("ocrPdf", () => {
  it("extracts text-layer content from a hand-crafted PDF", async () => {
    const buf = await buildTestPdf(
      "Discharge Summary: Patient was admitted with chest pain and discharged after observation."
    );
    const result = await ocrPdf(buf);

    expect(result.method).toBe("text-layer");
    // pdf-parse may wrap/shift characters slightly but the key tokens must
    // be recoverable — assert on meaningful substrings rather than equality.
    expect(result.text.toLowerCase()).toContain("discharge");
    expect(result.text.toLowerCase()).toContain("chest pain");
    expect(result.confidence).toBe(1.0);
  }, 20_000);
});

// ── extractText router ────────────────────────────────────────────────────────

describe("extractText", () => {
  it("routes plain-text buffers via passthrough", async () => {
    const buf = Buffer.from("Simple clinical note: headache.", "utf8");
    const result = await extractText(buf, "text/plain");
    expect(result.method).toBe("passthrough");
    expect(result.text).toContain("clinical note");
    expect(result.confidence).toBe(1.0);
  });

  it("routes PDF buffers through ocrPdf", async () => {
    const buf = await buildTestPdf("Lab Report: CBC within normal limits.");
    const result = await extractText(buf, "application/pdf");
    expect(result.method).toBe("text-layer");
    expect(result.text.toLowerCase()).toContain("lab report");
  }, 20_000);

  it("ignores a wrong declared MIME and uses the real (magic-byte) format", async () => {
    // Upload is declared as PDF but is actually a PNG — ensure we route to
    // image OCR, not pdf-parse.
    mockRecognize.mockResolvedValueOnce({
      data: { text: "scanned prescription", confidence: 72 },
    });
    const pngBuf = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00,
    ]);
    const result = await extractText(pngBuf, "application/pdf");
    expect(result.method).toBe("ocr-image");
    expect(result.text).toBe("scanned prescription");
    expect(result.confidence).toBeCloseTo(0.72, 2);
    expect(mockRecognize).toHaveBeenCalled();
  });

  it("returns passthrough with empty text for empty buffers", async () => {
    const result = await extractText(Buffer.alloc(0), "application/pdf");
    expect(result.method).toBe("passthrough");
    expect(result.text).toBe("");
  });

  it("returns passthrough for unknown binary formats", async () => {
    const buf = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05]);
    const result = await extractText(buf, "application/octet-stream");
    expect(result.method).toBe("passthrough");
    expect(result.text).toBe("");
  });
});
