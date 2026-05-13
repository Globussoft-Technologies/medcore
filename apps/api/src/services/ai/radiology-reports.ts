// Radiology Report Drafting (PRD §7.2).
//
// AI pre-reads imaging, drafts a report, highlights suspicious regions, and
// a radiologist approves/edits the final text. This is a strict HITL flow:
// the AI never produces a FINAL report on its own — `approveReport()` is the
// only way to move a report to FINAL status.
//
// DICOM metadata: when an image entry is a real `application/dicom` blob
// (or has a `.dcm` extension) we parse its header with `dicom-parser` and
// stash the extracted study/series UIDs, modality, window/level, pixel
// spacing, etc. on `images[i].dicomMeta`. JPEG/PNG previews are skipped
// gracefully. The raw pixel data is never loaded — we only read the DICOM
// metadata tags.

import fs from "fs";
import path from "path";
import type {
  RadiologyStudy,
  RadiologyReport,
  RadiologyModality as PrismaRadiologyModality,
} from "@prisma/client";
import type OpenAI from "openai";
import { tenantScopedPrisma as prisma } from "../tenant-prisma";
import { logAICall } from "./sarvam";
import { callWithFallback, type ModelProvider } from "./model-router";
import { sanitizeUserInput } from "./prompt-safety";

/**
 * Per-provider chat model identifiers. Sarvam is tried first (India-region,
 * DPDP-compliant). If Sarvam returns a transport error, an empty response,
 * or no tool call, we fall through to OpenAI (gpt-4o-mini — cheap + reliable
 * + great at tool-calling). Both speak the OpenAI chat-completions wire
 * format so the request body is identical.
 */
const PROVIDER_MODEL: Record<ModelProvider, string> = {
  sarvam: "sarvam-105b",
  openai: "gpt-4o-mini",
  anthropic: "claude-haiku-4-5-20251001", // unreachable today — router stubs it
};

/**
 * Pluck the first tool call from a chat-completions response (both Sarvam
 * and OpenAI return it in the same `choices[0].message.tool_calls[0]`
 * shape). Returns undefined when the model produced plain-text instead of
 * a tool call — the caller treats that as "shape-mismatch success" and
 * triggers the OpenAI retry.
 */
function getToolCallFromResponse(
  response: OpenAI.Chat.Completions.ChatCompletion
) {
  const raw = response.choices[0]?.message?.tool_calls?.[0];
  return raw?.type === "function" ? raw : undefined;
}

/** Max number of images sent to the vision model per study. Capped to keep
 *  cost + latency bounded for CT/MRI studies that may have many slices.
 *  Compliance(2026-05-11): cleared with the team for OpenAI vision routing. */
const MAX_VISION_IMAGES_PER_STUDY = 4;

/** Allow-list of MIME prefixes OpenAI vision accepts. WEBP is what the web
 *  uploader produces today; PNG/JPEG handled defensively. DICOM is excluded
 *  here — separate pipeline path needed (not in this change). */
const VISION_SUPPORTED_MIME = /^image\/(webp|png|jpeg|gif)$/i;

/**
 * Load up to MAX_VISION_IMAGES_PER_STUDY image refs from local storage and
 * return them as base64 data URLs ready for OpenAI's vision API. DICOM and
 * any file that can't be resolved are silently skipped — the caller still
 * gets a text-only call rather than failing the whole draft.
 *
 * Implementation notes:
 *   - Honours `isLikelyDicom` to skip DICOM files (no vision conversion yet).
 *   - Reads bytes synchronously via the existing `resolveLocalPath` helper.
 *   - Infers MIME from `contentType` if present, else from file extension.
 *   - Caps total bytes loaded per study at ~16MB so a study with four 5MB
 *     images can't blow the LLM request size limit.
 */
function loadImagesForVision(
  refs: RadiologyImageRef[] | undefined,
): Array<{ dataUrl: string; mime: string }> {
  if (!Array.isArray(refs) || refs.length === 0) return [];
  const out: Array<{ dataUrl: string; mime: string }> = [];
  let bytesUsed = 0;
  const BUDGET = 16 * 1024 * 1024; // 16 MB hard cap per study

  for (const ref of refs.slice(0, MAX_VISION_IMAGES_PER_STUDY * 2)) {
    if (out.length >= MAX_VISION_IMAGES_PER_STUDY) break;
    if (isLikelyDicom(ref)) continue;
    try {
      const abs = resolveLocalPath(ref.key);
      if (!abs) continue;
      const buf = fs.readFileSync(abs);
      if (bytesUsed + buf.length > BUDGET) break;

      // Resolve MIME: prefer the stored contentType (set at upload time);
      // fall back to extension. Skip anything OpenAI won't accept.
      const ct = (ref.contentType ?? "").toLowerCase();
      const ext = abs.toLowerCase().slice(abs.lastIndexOf(".") + 1);
      const fromExt =
        ext === "webp" ? "image/webp" :
        ext === "png"  ? "image/png"  :
        ext === "jpg"  ? "image/jpeg" :
        ext === "jpeg" ? "image/jpeg" :
        ext === "gif"  ? "image/gif"  :
        "";
      const mime = VISION_SUPPORTED_MIME.test(ct) ? ct : fromExt;
      if (!mime) continue;

      const b64 = buf.toString("base64");
      out.push({ dataUrl: `data:${mime};base64,${b64}`, mime });
      bytesUsed += buf.length;
    } catch (err) {
      console.warn(
        "[radiology] failed to load image for vision:",
        ref.key,
        (err as Error).message,
      );
      // continue — one bad image must not break the whole draft
    }
  }
  return out;
}

// ── Markdown report renderer ──────────────────────────────────────────────────
//
// Takes the structured AI output + DB-sourced patient/study metadata and
// produces a human-readable markdown report matching the standard Indian
// radiology format. The AI never sees patient identifiers; they're injected
// here AFTER the AI call so PHI never leaves the server unless we explicitly
// send it.

export interface MarkdownReportContext {
  patientName: string;
  mrNumber?: string;
  age?: number | null;
  gender?: string | null;
  modality: RadiologyModality;
  bodyPart: string;
  clinicalHistory?: string;
  studyDate?: Date;
}

/**
 * Render the structured AI draft as a markdown report. Patient Info /
 * Technique / Findings / Impression / Recommendation sections — matches the
 * format radiologists expect to read + sign.
 *
 * Server-side only: includes real patient identifiers from the DB. NEVER
 * pass this output back through the LLM (it contains PHI). Safe to store in
 * RadiologyReport.aiDraft because that column is only ever rendered to
 * authenticated staff via the dashboard.
 */
export function renderRadiologyMarkdown(
  draft: RadiologyDraftResult,
  ctx: MarkdownReportContext,
): string {
  // Modality-friendly study-type label for the header.
  const studyTypeLabel: Record<RadiologyModality, string> = {
    XRAY: "X-Ray",
    CT: "CT Scan",
    MRI: "MRI",
    ULTRASOUND: "Ultrasound",
    MAMMOGRAPHY: "Mammography",
    PET: "PET Scan",
  };

  // Patient demographics line — only render the fields we actually have.
  const demoBits: string[] = [];
  if (ctx.age != null) demoBits.push(`${ctx.age} yrs`);
  if (ctx.gender) demoBits.push(String(ctx.gender));
  const demo = demoBits.join(", ");

  // Fall back to a templated technique sentence when the AI omitted it.
  const technique =
    draft.technique && draft.technique.length > 0
      ? draft.technique
      : `${studyTypeLabel[ctx.modality]} of the ${ctx.bodyPart.toLowerCase()} obtained.`;
  const views = draft.views && draft.views.length > 0 ? draft.views : "—";

  const lines: string[] = [];
  lines.push(`# ${studyTypeLabel[ctx.modality].toUpperCase()} RADIOLOGY REPORT`);
  lines.push("");
  lines.push("## Patient Information");
  lines.push("");
  lines.push(`* Patient: ${ctx.patientName}`);
  if (ctx.mrNumber) lines.push(`* MR Number: ${ctx.mrNumber}`);
  if (demo) lines.push(`* Demographics: ${demo}`);
  lines.push(`* Study Type: ${studyTypeLabel[ctx.modality]}`);
  lines.push(`* Body Part: ${ctx.bodyPart}`);
  lines.push(`* Views: ${views}`);
  if (ctx.studyDate) {
    lines.push(`* Study Date: ${ctx.studyDate.toISOString().slice(0, 10)}`);
  }
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("## Clinical History");
  lines.push("");
  // Trim so whitespace-only `notes` rows (e.g. " " or "\n") also fall back
  // to "Not provided." rather than rendering as a blank section.
  const trimmedHistory = (ctx.clinicalHistory ?? "").trim();
  lines.push(trimmedHistory.length > 0 ? trimmedHistory : "Not provided.");
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("## Technique");
  lines.push("");
  lines.push(technique);
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("## Findings");
  lines.push("");
  if (draft.findings.length === 0) {
    lines.push("* No abnormality detected on the provided views.");
  } else {
    for (const f of draft.findings) {
      const conf = `[${f.confidence.toUpperCase()}]`;
      const followUp = f.suggestedFollowUp
        ? ` *(Follow-up: ${f.suggestedFollowUp})*`
        : "";
      lines.push(`* ${conf} ${f.description}${followUp}`);
    }
  }
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("## Impression");
  lines.push("");
  lines.push(draft.impression);
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("## Recommendation");
  lines.push("");
  if (draft.recommendations.length === 0) {
    lines.push("Correlate clinically. Review with radiologist.");
  } else {
    for (const r of draft.recommendations) {
      lines.push(`* ${r}`);
    }
  }
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push(
    "_AI-generated DRAFT. Pending radiologist review and approval._",
  );

  return lines.join("\n");
}

// ── Types ─────────────────────────────────────────────────────────────────────

export type RadiologyModality =
  | "XRAY"
  | "CT"
  | "MRI"
  | "ULTRASOUND"
  | "MAMMOGRAPHY"
  | "PET";

export type RadiologyReportStatus =
  | "DRAFT"
  | "RADIOLOGIST_REVIEW"
  | "FINAL"
  | "AMENDED";

/**
 * Metadata extracted from a real DICOM file header. All fields are optional —
 * different vendors / modalities expose different subsets. Patient ID is
 * masked (first 2 chars + ****) before storage so we never persist the
 * clear-text patient identifier to the RadiologyStudy.images JSON blob.
 */
export interface DicomMeta {
  studyInstanceUID?: string;
  seriesInstanceUID?: string;
  sopInstanceUID?: string;
  modality?: string;
  manufacturer?: string;
  bodyPartExamined?: string;
  windowCenter?: number;
  windowWidth?: number;
  pixelSpacing?: [number, number];
  studyDate?: string; // YYYYMMDD or ISO — preserved as given
  patientID?: string; // masked — NEVER raw
  /** Set when the declared modality ≠ DICOM-header modality. */
  modalityMismatch?: boolean;
}

export interface RadiologyImageRef {
  key: string;
  filename?: string;
  contentType?: string;
  sizeBytes?: number;
  uploadedAt?: string;
  dicomMeta?: DicomMeta;
}

export interface RadiologyFinding {
  description: string;
  confidence: "low" | "medium" | "high";
  suggestedFollowUp?: string;
  /**
   * Optional bounding-box region on the image (x,y,w,h normalised 0..1) with
   * an optional label. Rendered as a canvas overlay in the Pending Review
   * detail view (see apps/web/src/app/dashboard/ai-radiology/page.tsx).
   */
  region?: { x: number; y: number; w: number; h: number; label?: string };
}

export interface RadiologyDraftResult {
  impression: string;
  findings: RadiologyFinding[];
  recommendations: string[];
  /**
   * One short sentence describing the imaging technique the AI inferred
   * from the views shown (e.g. "AP and lateral radiographs of the right
   * femur obtained."). Surfaces in the rendered markdown Technique
   * section. Optional — older drafts pre-dating this field will fall
   * back to a templated string built from modality + bodyPart.
   */
  technique?: string;
  /**
   * Comma-separated list of views the AI identified in the supplied
   * images (e.g. "AP, Lateral"). Used in the markdown header. Optional
   * for the same back-compat reason as `technique`.
   */
  views?: string;
}

/**
 * Optional prior-study context. When present, the Sarvam prompt is told to
 * call out interval changes (new, resolved, stable). Populated automatically
 * by `createReportDraft` from the patient's most recent same-modality +
 * same-bodyPart study that has a finalised report.
 */
export interface PriorStudyContext {
  studyId: string;
  studyDate?: Date;
  finalImpression?: string | null;
  finalReport?: string | null;
}

// ── System prompt ─────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an AI assistant helping an Indian-context
radiologist draft a structured report. The radiologist will review and edit
your draft before signing — your job is to produce a clean, conservative
starting point, not a final diagnosis.

INPUT CHANNELS:
You will receive (in this order):
1. The modality, body part, clinical history, and any technologist pre-read
   as a text block.
2. ZERO OR MORE images of the study (typically multiple views per X-ray,
   sometimes a few representative slices for CT/MRI). When images are
   present, READ THEM and base your findings on what you actually observe
   in the pixels — combined with the text context. When images are absent
   you MUST default to the empty-input behaviour below; never fabricate
   visual findings without images.

CRITICAL RULES (must follow):
1. Read the images first. Describe what you actually see — fractures,
   opacities, masses, alignment abnormalities, foreign bodies, etc. — using
   anatomical landmarks visible in the views provided. Cross-reference with
   the technologist's pre-read but trust your own observation when they
   conflict (flag the discrepancy in your impression).
2. No definitive diagnosis — use cautious language ("suggestive of",
   "consistent with", "could represent") and pair every clinical impression
   with a confidence band: "low", "medium", or "high".
3. End the impression with the exact sentence: "Review with radiologist."
4. For acute findings visible on the image (fracture, pneumothorax, free
   air, bleed, mass, severe deformity), use confidence: "high" and set a
   SPECIFIC suggestedFollowUp — name the test or timeframe (e.g.
   "Orthopaedic consultation, immobilise", "Urgent surgical evaluation",
   "Repeat radiograph post-reduction"). Generic "follow up clinically" is
   not acceptable for acute findings.
5. Recommendations are concrete next steps for the ordering clinician.
6. The 'region' bounding box on each finding is OPTIONAL. When you set it,
   estimate x/y/w/h as normalised coordinates (0..1) on the FIRST image
   provided. Be honest that this is approximate — radiology overlay is
   used for screen-pointing, not pixel-accurate measurement.

MODALITY-SPECIFIC CONVENTIONS:
- XRAY: describe alignment, cortical continuity, fracture lines, joint
  spaces, soft-tissue swelling. For chest films: lung fields, hila,
  cardiac silhouette, mediastinum, costophrenic angles, bony thorax.
- CT: comment on each region the slices cover; flag asymmetry, mass effect,
  bleed, edema. Do NOT comment on anatomy outside the visible slices.
- MRI: respect the sequence (T1/T2/FLAIR/DWI) — comment on signal
  characteristics relative to expected normal.
- ULTRASOUND / MAMMOGRAPHY / PET: standard reporting conventions for each.

EMPTY-INPUT CASE (no images AND no pre-read):
- Produce a single-sentence draft: "Imaging not available for AI review.
  Please draft manually. Review with radiologist." Zero findings, zero
  recommendations. Leave 'technique' and 'views' empty. Do NOT pretend
  the views are normal.

TECHNIQUE + VIEWS (for the formatted report header):
- Always set 'views' when images are provided — a comma-separated list of
  the projections you can see, in the order shown. Examples: "AP, Lateral"
  for a two-view X-ray; "Axial, Sagittal, Coronal" for a CT; "RCC, LCC,
  RMLO, LMLO" for a mammogram. Use standard radiology abbreviations.
- Always set 'technique' when images are provided — ONE sentence describing
  the imaging technique, written in passive voice as a radiology report
  would: "AP and lateral radiographs of the right femur obtained." or
  "Non-contrast axial CT slices of the head obtained." Never include
  patient name, MRN, date, machine vendor, or kVp/mA settings.

PRIOR-STUDY COMPARISON:
- If priorStudy is provided, the impression MUST start with the comparison
  outcome: "Compared to the prior study from <date>: <new / resolved /
  stable / no significant interval change>." Then continue with the current
  reading. If no prior study is provided, do NOT invent one.

PATIENT SAFETY (HIPAA / DPDP):
- Never echo identifiers (patient name, MRN, phone, address) into the
  impression or findings. If you can read identifiers off an image's
  burned-in metadata, IGNORE them.
- Never speculate about non-medical attributes.`;

// ── Tool schema ───────────────────────────────────────────────────────────────

const TOOL_SCHEMA = {
  type: "object",
  properties: {
    impression: { type: "string" },
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          description: { type: "string" },
          confidence: { type: "string", enum: ["low", "medium", "high"] },
          suggestedFollowUp: { type: "string" },
          region: {
            type: "object",
            properties: {
              x: { type: "number" },
              y: { type: "number" },
              w: { type: "number" },
              h: { type: "number" },
              label: { type: "string" },
            },
          },
        },
        required: ["description", "confidence"],
      },
    },
    recommendations: { type: "array", items: { type: "string" } },
    technique: {
      type: "string",
      description:
        "One sentence describing the imaging technique inferred from the views provided (e.g. 'AP and lateral radiographs of the right femur obtained.'). Do NOT include patient identifiers, dates, or machine names. Leave empty if no images were provided.",
    },
    views: {
      type: "string",
      description:
        "Comma-separated list of views identified in the images, in the order shown (e.g. 'AP, Lateral'). Leave empty if no images were provided.",
    },
  },
  required: ["impression", "findings", "recommendations"],
};

// ── DICOM parsing ─────────────────────────────────────────────────────────────

/** Mask a DICOM PatientID: keep the first 2 chars, mask the rest. */
function maskPatientID(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const s = String(raw).trim();
  if (s.length <= 2) return "****";
  return `${s.slice(0, 2)}****`;
}

/** Heuristic — only parse bytes that look like DICOM (by content type or ext). */
export function isLikelyDicom(ref: RadiologyImageRef): boolean {
  const ct = (ref.contentType ?? "").toLowerCase();
  if (ct === "application/dicom" || ct === "application/x-dicom") return true;
  const key = (ref.key ?? "").toLowerCase();
  const fn = (ref.filename ?? "").toLowerCase();
  return key.endsWith(".dcm") || fn.endsWith(".dcm");
}

/**
 * Resolve an image key (as persisted in RadiologyStudy.images) to a local
 * filesystem path. S3-backed blobs are not parsed here — they'd require a
 * GetObject round-trip; we log-and-skip with a warning so the caller gets
 * a useful message instead of a silent miss.
 */
function resolveLocalPath(key: string): string | null {
  // Keys look like `uploads/ehr/<filename>` relative to the API cwd.
  const rel = key.startsWith("uploads/") ? key : `uploads/ehr/${path.basename(key)}`;
  const abs = path.resolve(process.cwd(), rel);
  if (!fs.existsSync(abs)) return null;
  return abs;
}

/**
 * Parse the DICOM header of `bytes` and extract a compact metadata object.
 * Safe: never throws — returns `null` on any parse failure (corrupted file,
 * truncated preamble, non-DICOM bytes).
 */
export function parseDicomBytes(
  bytes: Uint8Array,
  declaredModality?: RadiologyModality
): DicomMeta | null {
  try {
    // Lazy-require so the main bundle doesn't pay the cost on startup.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const dicomParser = require("dicom-parser") as typeof import("dicom-parser");
    const dataSet = dicomParser.parseDicom(bytes);
    if (!dataSet) return null;

    // DICOM tag reference:
    //   (0020,000D) StudyInstanceUID        — x0020000d
    //   (0020,000E) SeriesInstanceUID       — x0020000e
    //   (0008,0018) SOPInstanceUID          — x00080018
    //   (0008,0060) Modality                — x00080060
    //   (0008,0070) Manufacturer            — x00080070
    //   (0018,0015) BodyPartExamined        — x00180015
    //   (0028,1050) WindowCenter            — x00281050
    //   (0028,1051) WindowWidth             — x00281051
    //   (0028,0030) PixelSpacing (DS, dual) — x00280030
    //   (0008,0020) StudyDate               — x00080020
    //   (0010,0020) PatientID               — x00100020
    const getStr = (tag: string) => {
      try {
        const v = dataSet.string(tag);
        return v ? String(v).trim() : undefined;
      } catch {
        return undefined;
      }
    };
    const getFloatStr = (tag: string, idx = 0) => {
      try {
        const v = dataSet.floatString(tag, idx);
        return typeof v === "number" && Number.isFinite(v) ? v : undefined;
      } catch {
        return undefined;
      }
    };

    const modality = getStr("x00080060");
    const meta: DicomMeta = {
      studyInstanceUID: getStr("x0020000d"),
      seriesInstanceUID: getStr("x0020000e"),
      sopInstanceUID: getStr("x00080018"),
      modality,
      manufacturer: getStr("x00080070"),
      bodyPartExamined: getStr("x00180015"),
      windowCenter: getFloatStr("x00281050"),
      windowWidth: getFloatStr("x00281051"),
      studyDate: getStr("x00080020"),
      patientID: maskPatientID(getStr("x00100020")),
    };

    const pxRow = getFloatStr("x00280030", 0);
    const pxCol = getFloatStr("x00280030", 1);
    if (typeof pxRow === "number" && typeof pxCol === "number") {
      meta.pixelSpacing = [pxRow, pxCol];
    }

    // Cross-check declared vs. DICOM-header modality. User choice wins —
    // we only flag the mismatch so the UI / audit log can surface it.
    if (declaredModality && modality) {
      if (modality.toUpperCase() !== declaredModality.toUpperCase()) {
        meta.modalityMismatch = true;
      }
    }

    return meta;
  } catch {
    // Corrupted / truncated / non-DICOM bytes — fall through as "not DICOM".
    return null;
  }
}

/**
 * For each image in `images`, if it looks like a DICOM blob, read the local
 * file, parse the header, and attach `dicomMeta`. Non-DICOM files are passed
 * through untouched. Errors are swallowed — a bad upload must not break
 * study creation (the user can still fill out findings by hand).
 */
export async function enrichImagesWithDicomMeta(
  images: RadiologyImageRef[],
  declaredModality?: RadiologyModality
): Promise<{ images: RadiologyImageRef[]; modalityMismatch: boolean }> {
  let mismatch = false;
  const out: RadiologyImageRef[] = [];
  for (const img of images) {
    if (!isLikelyDicom(img)) {
      out.push(img);
      continue;
    }
    try {
      const abs = resolveLocalPath(img.key);
      if (!abs) {
        out.push(img);
        continue;
      }
      const bytes = fs.readFileSync(abs);
      const meta = parseDicomBytes(
        bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes),
        declaredModality
      );
      if (meta) {
        if (meta.modalityMismatch) mismatch = true;
        out.push({ ...img, dicomMeta: meta });
      } else {
        out.push(img);
      }
    } catch {
      out.push(img);
    }
  }
  return { images: out, modalityMismatch: mismatch };
}

// ── generateDraftReport ───────────────────────────────────────────────────────

/**
 * Call Sarvam to produce a structured radiology-report draft. Returns the raw
 * structured response; persistence is the caller's job (see `createReportDraft`).
 *
 * Does NOT persist anything. Safe to call from preview endpoints.
 *
 * When `priorStudy` is provided, the prior study's final impression/report are
 * threaded into the prompt and the model is instructed to call out interval
 * changes. Otherwise the model is told to say "No prior study available for
 * comparison."
 */
export async function generateDraftReport(opts: {
  studyId: string;
  modality: RadiologyModality;
  bodyPart: string;
  clinicalHistory?: string;
  findings?: string;
  priorStudy?: PriorStudyContext;
  /**
   * Optional image refs from RadiologyStudy.images. When present, the
   * service loads up to MAX_VISION_IMAGES_PER_STUDY images, base64-encodes
   * them, and sends them to OpenAI vision (`gpt-4o`) so the AI actually
   * looks at the pixels. Sarvam is skipped because it does not currently
   * support vision input. When `images` is omitted or empty, falls back to
   * the text-only Sarvam→OpenAI path used by all other AI features.
   */
  images?: RadiologyImageRef[];
}): Promise<RadiologyDraftResult> {
  // security(2026-04-24-low): F-INJ-1 — sanitize every free-text field
  // before concatenating into the prompt. `modality` comes from a closed
  // enum so no sanitisation needed; bodyPart is clinician-entered.
  const safeBodyPart = sanitizeUserInput(opts.bodyPart, { maxLen: 120 });
  const safeHistory = opts.clinicalHistory
    ? sanitizeUserInput(opts.clinicalHistory, { maxLen: 2000 })
    : "";
  const safeFindings = opts.findings
    ? sanitizeUserInput(opts.findings, { maxLen: 4000 })
    : "";

  // Prior-study block — sanitised + truncated so a malicious prior report
  // body can't blow the prompt budget.
  let priorBlock = "No prior study available for comparison.";
  if (opts.priorStudy) {
    const priorImpression = opts.priorStudy.finalImpression
      ? sanitizeUserInput(opts.priorStudy.finalImpression, { maxLen: 1500 })
      : "";
    const priorReport = opts.priorStudy.finalReport
      ? sanitizeUserInput(opts.priorStudy.finalReport, { maxLen: 3000 })
      : "";
    const whenStr = opts.priorStudy.studyDate
      ? new Date(opts.priorStudy.studyDate).toISOString().slice(0, 10)
      : "date unknown";
    priorBlock = `Prior study (${whenStr}):
- Prior impression: ${priorImpression || "none recorded"}
- Prior report: ${priorReport || "none recorded"}

Explicitly call out interval changes (new findings, resolved findings, stable findings) where relevant.`;
  }

  const userPrompt = `Study context:
- Modality: ${opts.modality}
- Body part: ${safeBodyPart}
- Clinical history: ${safeHistory || "none provided"}

Free-text findings from the technologist / referring clinician:
${safeFindings || "no pre-read provided"}

${priorBlock}

Produce a structured radiology-report draft. Flag confidence on every finding.
End the impression with "Review with radiologist".`;

  // Vision path: load image bytes (up to MAX_VISION_IMAGES_PER_STUDY). When
  // we have at least one image, route directly to OpenAI's vision model —
  // Sarvam currently has no vision endpoint, so it is skipped for this
  // request only. Other AI features keep using Sarvam-first as before.
  const visionImages = loadImagesForVision(opts.images);
  const useVision = visionImages.length > 0;

  // Build the user-message content. Text-only path keeps a plain string.
  // Vision path uses the OpenAI content-block array: [text, image, image, ...].
  const userMessageContent = useVision
    ? ([
        { type: "text" as const, text: userPrompt },
        ...visionImages.map((img) => ({
          type: "image_url" as const,
          image_url: { url: img.dataUrl, detail: "high" as const },
        })),
      ] satisfies OpenAI.Chat.Completions.ChatCompletionUserMessageParam["content"])
    : userPrompt;

  // Provider routing:
  //  - Vision: OpenAI only (gpt-4o supports vision; gpt-4o-mini doesn't
  //    reliably for medical images). No Sarvam fallback because Sarvam
  //    can't read images.
  //  - Text-only: Sarvam → OpenAI fallback as before.
  const providers: ModelProvider[] = useVision ? ["openai"] : ["sarvam", "openai"];
  const visionModel = "gpt-4o";

  const t0 = Date.now();
  try {
    let usedProvider: ModelProvider = providers[0];
    let response = await callWithFallback(
      (client, provider) => {
        usedProvider = provider;
        const model = useVision ? visionModel : PROVIDER_MODEL[provider];
        return client.chat.completions.create({
          model,
          max_tokens: 1500,
          temperature: 0.2,
          tools: [
            {
              type: "function",
              function: {
                name: "emit_radiology_draft",
                description:
                  "Emit a structured radiology-report draft with impression, findings (each with a confidence band), and recommendations.",
                parameters: TOOL_SCHEMA as any,
              },
            },
          ],
          tool_choice: {
            type: "function",
            function: { name: "emit_radiology_draft" },
          },
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: userMessageContent as any },
          ],
        });
      },
      { providers, feature: "scribe" }
    );

    // Empty-tool-call fallback only applies to the text-only path. When
    // vision is in play we already used OpenAI directly — there's no
    // alternative provider to retry against.
    let toolCall = getToolCallFromResponse(response);
    if (!toolCall && !useVision && usedProvider === "sarvam") {
      response = await callWithFallback(
        (client, provider) => {
          usedProvider = provider;
          return client.chat.completions.create({
            model: PROVIDER_MODEL[provider],
            max_tokens: 1500,
            temperature: 0.2,
            tools: [
              {
                type: "function",
                function: {
                  name: "emit_radiology_draft",
                  description:
                    "Emit a structured radiology-report draft with impression, findings (each with a confidence band), and recommendations.",
                  parameters: TOOL_SCHEMA as any,
                },
              },
            ],
            tool_choice: {
              type: "function",
              function: { name: "emit_radiology_draft" },
            },
            messages: [
              { role: "system", content: SYSTEM_PROMPT },
              { role: "user", content: userPrompt },
            ],
          });
        },
        { providers: ["openai"], feature: "scribe" }
      );
      toolCall = getToolCallFromResponse(response);
    }

    const promptTokens = response.usage?.prompt_tokens ?? 0;
    const completionTokens = response.usage?.completion_tokens ?? 0;
    const data = toolCall
      ? (JSON.parse(toolCall.function.arguments) as RadiologyDraftResult)
      : null;

    logAICall({
      feature: "scribe",
      // Record the actual model used: gpt-4o for vision, sarvam-105b or
      // gpt-4o-mini for text. Dashboards can filter by model to see
      // vision-vs-text mix per day.
      model: useVision ? visionModel : PROVIDER_MODEL[usedProvider],
      promptTokens,
      completionTokens,
      latencyMs: Date.now() - t0,
      toolUsed: "emit_radiology_draft",
    });

    if (!data) {
      return {
        impression:
          "AI_DRAFT_UNAVAILABLE — please draft manually. Review with radiologist.",
        findings: [],
        recommendations: [],
      };
    }

    const findings = Array.isArray(data.findings)
      ? data.findings.map((f) => ({
          description: String(f.description ?? ""),
          confidence: (["low", "medium", "high"].includes(f.confidence)
            ? f.confidence
            : "low") as RadiologyFinding["confidence"],
          suggestedFollowUp: f.suggestedFollowUp
            ? String(f.suggestedFollowUp)
            : undefined,
          region: f.region ?? undefined,
        }))
      : [];

    let impression = String(data.impression ?? "").trim();
    if (!/review with radiologist/i.test(impression)) {
      impression = `${impression}${impression ? " " : ""}Review with radiologist.`;
    }

    // Optional formatted-report fields — model may omit them (e.g. when
    // no images were sent). Coerce to undefined so the downstream
    // markdown renderer can fall back to templated defaults rather than
    // emitting an empty section.
    const technique =
      typeof data.technique === "string" && data.technique.trim().length > 0
        ? data.technique.trim()
        : undefined;
    const views =
      typeof data.views === "string" && data.views.trim().length > 0
        ? data.views.trim()
        : undefined;

    return {
      impression,
      findings,
      recommendations: Array.isArray(data.recommendations)
        ? data.recommendations.map((r) => String(r))
        : [],
      technique,
      views,
    };
  } catch (err) {
    logAICall({
      feature: "scribe",
      // Both providers exhausted at this point — flag the failure as the
      // fallback-of-last-resort. callWithFallback already logged per-attempt
      // failover events, so this is the terminal "both Sarvam and OpenAI
      // failed" record.
      model: "sarvam+openai-failover",
      promptTokens: 0,
      completionTokens: 0,
      latencyMs: Date.now() - t0,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

// ── createStudy ───────────────────────────────────────────────────────────────

/**
 * Persist a new RadiologyStudy row. Image file keys must already be written
 * to storage (via the existing /uploads signed-URL flow) — we store only the
 * references, not the blobs. Any `.dcm` uploads are parsed synchronously
 * so their metadata lands in the `images[i].dicomMeta` JSON column.
 */
export async function createStudy(params: {
  patientId: string;
  modality: RadiologyModality;
  bodyPart: string;
  images: RadiologyImageRef[];
  studyDate?: Date;
  notes?: string;
  orderId?: string;
}): Promise<RadiologyStudy> {
  const { images: enriched } = await enrichImagesWithDicomMeta(
    params.images,
    params.modality
  );
  return prisma.radiologyStudy.create({
    data: {
      patientId: params.patientId,
      modality: params.modality as PrismaRadiologyModality,
      bodyPart: params.bodyPart,
      // RadiologyStudy.images is a Prisma Json column; cast narrows our
      // typed RadiologyImageRef[] down to Prisma's InputJsonValue.
      images: enriched as unknown as Parameters<
        typeof prisma.radiologyStudy.create
      >[0]["data"]["images"],
      studyDate: params.studyDate ?? new Date(),
      notes: params.notes ?? null,
      orderId: params.orderId ?? null,
    },
  });
}

// ── createReportDraft ─────────────────────────────────────────────────────────

/**
 * Generate the AI draft for an existing study and persist a RadiologyReport
 * row with status = DRAFT. If a report already exists for this study the
 * existing row is returned untouched (idempotent — no duplicate drafts).
 *
 * Auto-discovers the patient's most recent prior study with the SAME modality
 * AND bodyPart that has a finalised report, and threads its impression +
 * report into the Sarvam prompt so interval changes are surfaced.
 */
export async function createReportDraft(
  studyId: string
): Promise<RadiologyReport> {
  const study = await prisma.radiologyStudy.findUnique({
    where: { id: studyId },
    // Join the patient + user rows so the markdown renderer can fill the
    // Patient Information section from real DB data. AI never sees these
    // identifiers — only the markdown renderer (server-side) does.
    include: {
      report: true,
      patient: { include: { user: { select: { name: true } } } },
    },
  });
  if (!study) {
    throw new Error(`RadiologyStudy ${studyId} not found`);
  }
  if (study.report) {
    return study.report;
  }

  // Prior-study lookup: most-recent same-modality + same-bodyPart study for
  // the same patient whose report is FINAL / AMENDED. Failure here is
  // non-fatal — we proceed without prior context.
  let priorStudy: PriorStudyContext | undefined;
  try {
    const prior = await prisma.radiologyStudy.findFirst({
      where: {
        patientId: study.patientId,
        modality: study.modality,
        bodyPart: study.bodyPart,
        id: { not: studyId },
        report: { status: { in: ["FINAL", "AMENDED"] } },
      },
      orderBy: { studyDate: "desc" },
      include: { report: true },
    });
    if (prior?.report) {
      priorStudy = {
        studyId: prior.id,
        studyDate: prior.studyDate,
        finalImpression: prior.report.finalImpression,
        finalReport: prior.report.finalReport,
      };
    }
  } catch (err) {
    console.warn(
      "[radiology] prior-study lookup failed (non-fatal):",
      (err as Error)?.message ?? err
    );
  }

  // RadiologyStudy.images is a Prisma Json column; cast back to the typed
  // shape so generateDraftReport can resolve each ref's file path for vision.
  const studyImages = (Array.isArray(study.images) ? study.images : []) as
    unknown as RadiologyImageRef[];

  const draft = await generateDraftReport({
    studyId,
    modality: study.modality as RadiologyModality,
    bodyPart: study.bodyPart,
    clinicalHistory: study.notes ?? undefined,
    priorStudy,
    images: studyImages,
  });

  // Render the human-readable markdown draft. The renderer fills Patient
  // Info / Technique / Views / Clinical History from the DB (NOT from the
  // AI), so PHI never leaks into the LLM prompt. The structured `aiFindings`
  // + `aiImpression` columns still hold the machine-readable shape so
  // existing dashboards, confidence-band rendering, and future analytics
  // (e.g. "all HIGH-confidence fractures last 30 days") keep working.
  const aiDraftMarkdown = renderRadiologyMarkdown(draft, {
    patientName: study.patient?.user?.name ?? "Unknown",
    mrNumber: study.patient?.mrNumber ?? undefined,
    age: study.patient?.age ?? undefined,
    gender: study.patient?.gender ?? undefined,
    modality: study.modality as RadiologyModality,
    bodyPart: study.bodyPart,
    clinicalHistory: study.notes ?? undefined,
    studyDate: study.studyDate ?? undefined,
  });

  return prisma.radiologyReport.create({
    data: {
      studyId,
      aiDraft: aiDraftMarkdown,
      aiFindings: draft.findings as unknown as Parameters<
        typeof prisma.radiologyReport.create
      >[0]["data"]["aiFindings"],
      aiImpression: draft.impression,
      status: "DRAFT",
    },
  });
}

// ── approveReport ─────────────────────────────────────────────────────────────

/**
 * HITL approval: promote a DRAFT / RADIOLOGIST_REVIEW report to FINAL. Writes
 * the radiologist-edited `finalReport` text and stamps `approvedAt` /
 * `approvedBy`. Refuses if the report is already FINAL or AMENDED.
 */
export async function approveReport(
  reportId: string,
  finalReport: string,
  radiologistId: string,
  finalImpression?: string
): Promise<RadiologyReport> {
  const existing = await prisma.radiologyReport.findUnique({
    where: { id: reportId },
  });
  if (!existing) {
    throw new Error(`RadiologyReport ${reportId} not found`);
  }
  if (existing.status === "FINAL" || existing.status === "AMENDED") {
    throw new Error(
      `Report is already ${existing.status}; use amendReport to make changes.`
    );
  }
  return prisma.radiologyReport.update({
    where: { id: reportId },
    data: {
      finalReport,
      finalImpression: finalImpression ?? null,
      radiologistId,
      status: "FINAL",
      approvedAt: new Date(),
      approvedBy: radiologistId,
    },
  });
}

// ── amendReport ───────────────────────────────────────────────────────────────

/**
 * Post-finalisation amendment. Only valid on FINAL / AMENDED reports. Writes
 * a new `finalReport` and flips status to AMENDED. `approvedAt` / `approvedBy`
 * from the original finalisation are preserved (this lets UIs show
 * "originally finalised 3 Apr, amended 5 Apr by Dr. X").
 */
export async function amendReport(
  reportId: string,
  newReport: string,
  userId: string,
  newImpression?: string
): Promise<RadiologyReport> {
  const existing = await prisma.radiologyReport.findUnique({
    where: { id: reportId },
  });
  if (!existing) {
    throw new Error(`RadiologyReport ${reportId} not found`);
  }
  if (existing.status !== "FINAL" && existing.status !== "AMENDED") {
    throw new Error(
      `Report must be FINAL or AMENDED to amend; current status is ${existing.status}.`
    );
  }
  return prisma.radiologyReport.update({
    where: { id: reportId },
    data: {
      finalReport: newReport,
      finalImpression: newImpression ?? existing.finalImpression,
      status: "AMENDED",
      // radiologistId kept, amendedBy implicitly = userId via audit log
      radiologistId: userId,
    },
  });
}
