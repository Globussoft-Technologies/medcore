// Unit tests for the radiology-reports service. Covers the pure
// (non-Prisma) functions:
//   - parseDicomBytes: DICOM header extraction happy path + modality mismatch
//   - isLikelyDicom: content-type + extension heuristics
//   - generateDraftReport: prior-study context threads into the prompt
//   - (compile-time) service functions return Prisma-typed objects
//
// The Sarvam/OpenAI fallback is mocked at the callWithFallback boundary so
// no network traffic. The DICOM test buffer is synthesised inline so we
// don't depend on a sample asset file landing in git.

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ─────────────────────────────────────────────────────────────────────

const { callWithFallbackMock } = vi.hoisted(() => ({
  callWithFallbackMock: vi.fn(),
}));

vi.mock("./sarvam", () => ({
  logAICall: vi.fn(),
}));

// The radiology service now calls callWithFallback(sarvam → openai). We
// intercept at that boundary so the mock returns a fully-shaped OpenAI
// ChatCompletion (with choices[0].message.tool_calls[0]) — the production
// code path parses tool_calls[0].function.arguments out of this shape.
vi.mock("./model-router", () => ({
  callWithFallback: callWithFallbackMock,
}));

/**
 * Helper: build a fake OpenAI ChatCompletion containing a single tool call
 * whose `arguments` JSON serialises to the given payload. Matches what the
 * production code at radiology-reports.ts:getToolCallFromResponse expects.
 */
// Sarvam-m doesn't support OpenAI function/tool calling. The radiology
// route now branches by provider: the Sarvam path uses
// response_format: json_object (JSON inline in message.content), the
// OpenAI fallback path keeps the tools-based call shape. Production
// code at radiology-reports.ts:extractRadiologyDraft picks the right
// parser per provider. Tests targeting the Sarvam path must use this
// helper. The old fakeToolCallResponse helper (tool_calls shape) was
// removed when all Sarvam-path tests migrated; if a future test
// exercises the OpenAI fallback branch, re-introduce a tool-call
// helper.
function fakeSarvamJsonResponse(
  payload: unknown,
  usage = { prompt: 10, completion: 5 },
) {
  return {
    choices: [
      {
        message: {
          content: JSON.stringify(payload),
          tool_calls: [],
        },
      },
    ],
    usage: {
      prompt_tokens: usage.prompt,
      completion_tokens: usage.completion,
    },
  };
}

// tenant-prisma is not exercised here (unit-level), but the module transitively
// imports it — give it a harmless stub.
vi.mock("../tenant-prisma", () => ({
  tenantScopedPrisma: {
    radiologyStudy: {
      create: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
    },
    radiologyReport: {
      create: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  },
}));

import {
  parseDicomBytes,
  isLikelyDicom,
  generateDraftReport,
  type RadiologyImageRef,
} from "./radiology-reports";

// ── DICOM buffer synthesis ────────────────────────────────────────────────────

/**
 * Build a minimal but valid DICOM Part-10 file as a Uint8Array. Uses the
 * explicit little-endian transfer syntax so we don't need a metadata group.
 * Each element layout: [group, element, VR (2 bytes), length (2 bytes), value].
 * Tags longer than 8-byte-VR use a 4-byte length — we skip those here.
 */
function synthDicom(tags: Array<{ group: number; element: number; vr: string; value: string | number[] }>): Uint8Array {
  const chunks: Uint8Array[] = [];

  // 128-byte preamble + "DICM"
  const preamble = new Uint8Array(128);
  chunks.push(preamble);
  chunks.push(new TextEncoder().encode("DICM"));

  // File Meta Information Group Length (0002,0000) UL 4 bytes value 0 —
  // empty-meta so dicom-parser knows we're in Part-10 mode but has no
  // transfer-syntax-switch block to parse. We use implicit little-endian
  // for the rest (no VR tag, 4-byte length fields).
  // Actually: dicom-parser needs a TransferSyntax in meta group to decide
  // how to parse the dataset. Easiest path: include (0002,0010) with
  // UI value "1.2.840.10008.1.2.1" (Explicit VR Little Endian).

  // --- Meta group ---
  // element (0002,0000) GroupLength  UL 4 bytes
  const metaBody: number[] = [];

  function pushExplicit(group: number, element: number, vr: string, value: Uint8Array) {
    // Group/Element little-endian
    metaBody.push(group & 0xff, (group >> 8) & 0xff);
    metaBody.push(element & 0xff, (element >> 8) & 0xff);
    metaBody.push(vr.charCodeAt(0), vr.charCodeAt(1));
    // length (2 bytes) for short VRs
    metaBody.push(value.length & 0xff, (value.length >> 8) & 0xff);
    for (const b of value) metaBody.push(b);
  }

  // (0002,0010) Transfer Syntax UID — UI VR
  const tsuid = padEvenLen("1.2.840.10008.1.2.1"); // Explicit VR Little Endian
  pushExplicit(0x0002, 0x0010, "UI", new TextEncoder().encode(tsuid));

  // GroupLength goes first, then other meta elements. We'll prepend it.
  const groupLengthValue = new Uint8Array(4);
  const metaBodyLen = metaBody.length;
  groupLengthValue[0] = metaBodyLen & 0xff;
  groupLengthValue[1] = (metaBodyLen >> 8) & 0xff;
  groupLengthValue[2] = (metaBodyLen >> 16) & 0xff;
  groupLengthValue[3] = (metaBodyLen >> 24) & 0xff;
  const metaHeader: number[] = [];
  // (0002,0000) UL 4 bytes
  metaHeader.push(0x02, 0x00, 0x00, 0x00);
  metaHeader.push("U".charCodeAt(0), "L".charCodeAt(0));
  metaHeader.push(0x04, 0x00);
  metaHeader.push(...groupLengthValue);

  chunks.push(new Uint8Array(metaHeader));
  chunks.push(new Uint8Array(metaBody));

  // --- Dataset (explicit VR little-endian) ---
  const dsBody: number[] = [];
  function pushExplicitDS(group: number, element: number, vr: string, value: Uint8Array) {
    dsBody.push(group & 0xff, (group >> 8) & 0xff);
    dsBody.push(element & 0xff, (element >> 8) & 0xff);
    dsBody.push(vr.charCodeAt(0), vr.charCodeAt(1));
    // Short-VR: 2-byte length.
    dsBody.push(value.length & 0xff, (value.length >> 8) & 0xff);
    for (const b of value) dsBody.push(b);
  }

  for (const t of tags) {
    let bytes: Uint8Array;
    if (typeof t.value === "string") {
      bytes = new TextEncoder().encode(padEvenLen(t.value));
    } else {
      bytes = new Uint8Array(t.value);
    }
    pushExplicitDS(t.group, t.element, t.vr, bytes);
  }
  chunks.push(new Uint8Array(dsBody));

  // Concatenate
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

/** Pad a DICOM string value to even length (spec rule). */
function padEvenLen(s: string): string {
  return s.length % 2 === 0 ? s : s + " ";
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("radiology-reports — DICOM helpers", () => {
  beforeEach(() => {
    callWithFallbackMock.mockReset();
  });

  it("isLikelyDicom recognises .dcm extension and application/dicom mime", () => {
    expect(
      isLikelyDicom({ key: "uploads/ehr/scan.dcm" } as RadiologyImageRef)
    ).toBe(true);
    expect(
      isLikelyDicom({
        key: "uploads/ehr/scan.bin",
        contentType: "application/dicom",
      } as RadiologyImageRef)
    ).toBe(true);
    expect(
      isLikelyDicom({
        key: "uploads/ehr/scan.jpg",
        contentType: "image/jpeg",
      } as RadiologyImageRef)
    ).toBe(false);
  });

  it("parseDicomBytes extracts a full set of metadata fields (happy path)", () => {
    const bytes = synthDicom([
      { group: 0x0008, element: 0x0018, vr: "UI", value: "1.2.3.4.5.sop" },
      { group: 0x0008, element: 0x0020, vr: "DA", value: "20260424" },
      { group: 0x0008, element: 0x0060, vr: "CS", value: "CT" },
      { group: 0x0008, element: 0x0070, vr: "LO", value: "SIEMENS" },
      { group: 0x0010, element: 0x0020, vr: "LO", value: "PATIENT12345" },
      { group: 0x0018, element: 0x0015, vr: "CS", value: "CHEST" },
      { group: 0x0020, element: 0x000d, vr: "UI", value: "1.2.3.4.study" },
      { group: 0x0020, element: 0x000e, vr: "UI", value: "1.2.3.4.series" },
      { group: 0x0028, element: 0x0030, vr: "DS", value: "0.5\\0.5" },
      { group: 0x0028, element: 0x1050, vr: "DS", value: "40" },
      { group: 0x0028, element: 0x1051, vr: "DS", value: "400" },
    ]);

    const meta = parseDicomBytes(bytes, "CT");
    expect(meta).not.toBeNull();
    if (!meta) return;

    expect(meta.sopInstanceUID).toBe("1.2.3.4.5.sop");
    expect(meta.studyInstanceUID).toBe("1.2.3.4.study");
    expect(meta.seriesInstanceUID).toBe("1.2.3.4.series");
    expect(meta.modality).toBe("CT");
    expect(meta.manufacturer).toBe("SIEMENS");
    expect(meta.bodyPartExamined).toBe("CHEST");
    expect(meta.studyDate).toBe("20260424");
    expect(meta.patientID).toMatch(/^PA\*+$/);
    expect(meta.patientID).not.toContain("12345");
    expect(meta.windowCenter).toBe(40);
    expect(meta.windowWidth).toBe(400);
    expect(meta.pixelSpacing?.[0]).toBe(0.5);
    expect(meta.pixelSpacing?.[1]).toBe(0.5);
    // Modality matches — no mismatch flag.
    expect(meta.modalityMismatch).toBeUndefined();
  });

  it("parseDicomBytes surfaces modalityMismatch when declared ≠ DICOM", () => {
    const bytes = synthDicom([
      { group: 0x0008, element: 0x0060, vr: "CS", value: "CT" },
      { group: 0x0020, element: 0x000d, vr: "UI", value: "1.2.3.4" },
    ]);
    const meta = parseDicomBytes(bytes, "XRAY");
    expect(meta).not.toBeNull();
    expect(meta!.modalityMismatch).toBe(true);
    expect(meta!.modality).toBe("CT");
  });

  it("parseDicomBytes returns null for non-DICOM bytes (JPEG header)", () => {
    // 0xff 0xd8 0xff 0xe0 = JPEG SOI + APP0 marker
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x00, 0x00]);
    const meta = parseDicomBytes(jpeg);
    expect(meta).toBeNull();
  });
});

describe("radiology-reports — prior-study prompt injection", () => {
  /**
   * Sniff out the user prompt that was sent to the LLM. With the new
   * callWithFallback wiring, the test mock receives a CALLBACK
   * `(client, provider) => Promise<ChatCompletion>`. We invoke that callback
   * with a stub client to capture what `messages[]` was assembled, then
   * resolve with a synthetic tool-call response. This is more layered than
   * the old generateStructured-direct mock but it matches the production
   * call path exactly.
   */
  function captureLastUserPrompt(): string {
    const callbackArg = callWithFallbackMock.mock.calls[0][0] as (
      client: { chat: { completions: { create: ReturnType<typeof vi.fn> } } },
      provider: string,
    ) => Promise<unknown>;
    const createSpy = vi.fn().mockResolvedValue({});
    void callbackArg({ chat: { completions: { create: createSpy } } }, "sarvam");
    const req = createSpy.mock.calls[0]?.[0];
    const userMsg = req?.messages?.find(
      (m: { role: string }) => m.role === "user",
    );
    return (userMsg?.content as string) ?? "";
  }

  beforeEach(() => {
    callWithFallbackMock.mockReset();
    callWithFallbackMock.mockImplementation(async (fn) => {
      // Default: invoke the callback so production code sees a successful
      // ChatCompletion with the standard "No acute change." payload.
      // Sarvam path expects JSON inline in message.content (json_object
      // mode) — the production extractRadiologyDraft routes by provider
      // and uses parseSarvamJson for "sarvam", getToolCallFromResponse
      // for "openai".
      const stubClient = {
        chat: {
          completions: {
            create: vi.fn().mockResolvedValue(
              fakeSarvamJsonResponse({
                impression: "No acute change.",
                findings: [],
                recommendations: [],
              }),
            ),
          },
        },
      };
      return fn(stubClient, "sarvam");
    });
  });

  it("threads priorStudy final impression + report into the Sarvam prompt", async () => {
    const priorDate = new Date("2026-01-15");
    await generateDraftReport({
      studyId: "study-b",
      modality: "XRAY",
      bodyPart: "Chest",
      priorStudy: {
        studyId: "study-a",
        studyDate: priorDate,
        finalImpression: "Mild cardiomegaly, stable.",
        finalReport: "Heart size at upper limits of normal; no acute infiltrate.",
      },
    });

    expect(callWithFallbackMock).toHaveBeenCalledOnce();
    const userPrompt = captureLastUserPrompt();
    expect(userPrompt).toContain("Prior study");
    expect(userPrompt).toContain("2026-01-15");
    expect(userPrompt).toContain("Mild cardiomegaly");
    expect(userPrompt).toContain("no acute infiltrate");
    expect(userPrompt).toContain("interval changes");
  });

  it('emits "No prior study available for comparison." when priorStudy is omitted', async () => {
    await generateDraftReport({
      studyId: "study-c",
      modality: "CT",
      bodyPart: "Abdomen",
    });
    expect(callWithFallbackMock).toHaveBeenCalledOnce();
    const userPrompt = captureLastUserPrompt();
    expect(userPrompt).toContain("No prior study available for comparison.");
    expect(userPrompt).not.toContain("interval changes");
  });

  it("appends 'Review with radiologist' to impression when the LLM omits it", async () => {
    callWithFallbackMock.mockImplementationOnce(async (fn) => {
      const stubClient = {
        chat: {
          completions: {
            create: vi.fn().mockResolvedValue(
              fakeSarvamJsonResponse({
                impression: "Unremarkable exam",
                findings: [],
                recommendations: [],
              }),
            ),
          },
        },
      };
      return fn(stubClient, "sarvam");
    });
    const res = await generateDraftReport({
      studyId: "x",
      modality: "XRAY",
      bodyPart: "Knee",
    });
    expect(res.impression).toMatch(/review with radiologist/i);
  });
});
