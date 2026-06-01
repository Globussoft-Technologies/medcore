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
// `sharp` is loaded lazily inside `overlayCoordinateGrid` so an environment
// without the optional native binary still boots — we just fall back to
// the raw image without a grid in that case.
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
  // 2026-05-29: sarvam retired "sarvam-105b". The current text model is
  // "sarvam-m" — read from env so a future model swap doesn't require a
  // code change. Falls back to "sarvam-m" if the env var is unset.
  sarvam: process.env.SARVAM_MODEL ?? "sarvam-m",
  openai: "gpt-4o-mini",
  anthropic: "claude-haiku-4-5-20251001", // unreachable today — router stubs it
};

/**
 * Pluck the first tool call from a chat-completions response. Only used
 * for the OpenAI fallback path now — Sarvam-m doesn't support tool
 * calling so its path uses response_format: json_object instead.
 */
function getToolCallFromResponse(
  response: OpenAI.Chat.Completions.ChatCompletion
) {
  const raw = response.choices[0]?.message?.tool_calls?.[0];
  return raw?.type === "function" ? raw : undefined;
}

// 2026-05-29: Sarvam-m emits `<think>...</think>` reasoning inline + may
// wrap JSON in markdown fences. Mirror of the helper in sarvam.ts —
// duplicated here so this file doesn't need to import from the main
// service (which has unrelated dependencies we don't want to pull in
// during the radiology path's optional vision-fallback code).
function stripSarvamThinking(content: string): string {
  if (!content) return content;
  let out = content.replace(/<think>[\s\S]*?<\/think>\s*/gi, "");
  const unterminated = out.indexOf("<think>");
  if (unterminated >= 0) out = out.slice(0, unterminated);
  return out.trim();
}

function parseSarvamJson<T>(content: string | null | undefined): T | null {
  if (!content) return null;
  let text = stripSarvamThinking(content);
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenceMatch) text = fenceMatch[1];
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace < 0 || lastBrace < firstBrace) return null;
  try {
    return JSON.parse(text.slice(firstBrace, lastBrace + 1)) as T;
  } catch {
    return null;
  }
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
 * Burn a 10×10 normalised coordinate grid + axis labels onto the image
 * before sending it to the vision model. The model reads the labels off
 * the pixels and emits boxes anchored to grid cells — empirically this
 * cuts mis-localised boxes substantially vs. a bare image, because the
 * AI no longer has to "imagine" where (0.4, 0.3) sits.
 *
 * Layout:
 *   - 10 vertical lines at x = 0.0, 0.1, … 1.0
 *   - 10 horizontal lines at y = 0.0, 0.1, … 1.0
 *   - Top edge labels: "0.0", "0.1", … "0.9" above each vertical line
 *   - Left edge labels: same, to the left of each horizontal line
 *   - Lines are faint yellow @ 30% alpha so the diagnostic detail under
 *     the grid is still readable for the model.
 *
 * Failure modes (all non-fatal — fall back to the raw image):
 *   - sharp not installed / native binary missing
 *   - Image bytes not a recognised format
 *   - Any sharp pipeline error
 */
async function overlayCoordinateGrid(
  bytes: Buffer,
  mime: string,
): Promise<{ bytes: Buffer; mime: string }> {
  try {
    // Lazy require so a missing optional dep doesn't crash module load.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sharp = require("sharp") as typeof import("sharp");
    const img = sharp(bytes);
    const meta = await img.metadata();
    const width = meta.width ?? 0;
    const height = meta.height ?? 0;
    if (!width || !height) return { bytes, mime };

    // Build SVG overlay. Stroke width scales with image so the grid is
    // visible on both tiny and large studies. Font size also scales.
    const stroke = Math.max(1, Math.round(Math.min(width, height) / 400));
    const fontSize = Math.max(10, Math.round(Math.min(width, height) / 60));
    const labelPad = fontSize + 2;
    const lines: string[] = [];
    for (let i = 0; i <= 10; i++) {
      const f = i / 10;
      const x = Math.round(f * width);
      const y = Math.round(f * height);
      // Vertical grid line
      lines.push(
        `<line x1="${x}" y1="0" x2="${x}" y2="${height}" stroke="yellow" stroke-opacity="0.30" stroke-width="${stroke}" />`,
      );
      // Horizontal grid line
      lines.push(
        `<line x1="0" y1="${y}" x2="${width}" y2="${y}" stroke="yellow" stroke-opacity="0.30" stroke-width="${stroke}" />`,
      );
      // Axis label at the top — slightly inset so f=1.0 doesn't clip
      const lbl = f.toFixed(1);
      const xLbl = i === 10 ? width - labelPad : x + 2;
      lines.push(
        `<text x="${xLbl}" y="${fontSize + 2}" font-family="monospace" font-size="${fontSize}" fill="yellow" fill-opacity="0.9" stroke="black" stroke-width="0.5">${lbl}</text>`,
      );
      // Axis label at the left
      const yLbl = i === 10 ? height - 4 : y + fontSize + 2;
      lines.push(
        `<text x="2" y="${yLbl}" font-family="monospace" font-size="${fontSize}" fill="yellow" fill-opacity="0.9" stroke="black" stroke-width="0.5">${lbl}</text>`,
      );
    }
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${lines.join("")}</svg>`;

    // Composite the SVG onto the image, then re-encode as PNG (lossless —
    // keeps the radiological detail intact for the model).
    const out = await img
      .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
      .png()
      .toBuffer();
    return { bytes: out, mime: "image/png" };
  } catch (err) {
    console.warn(
      "[radiology] grid overlay failed (non-fatal, sending raw image):",
      (err as Error)?.message ?? err,
    );
    return { bytes, mime };
  }
}

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
async function loadImagesForVision(
  refs: RadiologyImageRef[] | undefined,
): Promise<Array<{ dataUrl: string; mime: string }>> {
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

      // Burn a 10×10 normalised coordinate grid + axis labels onto the
      // image. The vision model reads the labels off the pixels and emits
      // far more accurate (x, y, w, h) values — this is the single biggest
      // lever on bounding-box accuracy for general LLMs.
      const overlaid = await overlayCoordinateGrid(buf, mime);
      bytesUsed += overlaid.bytes.length;
      const b64 = overlaid.bytes.toString("base64");
      out.push({
        dataUrl: `data:${overlaid.mime};base64,${b64}`,
        mime: overlaid.mime,
      });
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
6. BOUNDING BOXES — draw them like a human radiologist would, one per
   defect, tightly hugging the abnormality. Think of how a teaching atlas
   draws a colored box around the finding: it covers the defect with a
   small margin and NOTHING else. Your boxes must match that quality.

   For EVERY visible defect (fracture line, lucency, opacity, mass,
   foreign body, dislocation, soft-tissue wound, free air, effusion,
   pneumothorax, joint subluxation, etc.) emit a SEPARATE finding object
   with its OWN 'region'. Two defects = two findings = two boxes. Never
   merge two defects into one box.

   Coordinate system (read carefully — this is the #1 source of error):
   - Origin (0, 0) is the TOP-LEFT pixel of the image.
   - Point  (1, 1) is the BOTTOM-RIGHT pixel.
   - x increases to the RIGHT. y increases DOWNWARD.
   - x = horizontal offset of the box's LEFT edge.
   - y = vertical   offset of the box's TOP  edge.
   - w = box width  as a fraction of the full image width.
   - h = box height as a fraction of the full image height.
   - HARD CONSTRAINTS: 0 ≤ x ≤ 1, 0 ≤ y ≤ 1, x + w ≤ 1, y + h ≤ 1.
   - Coordinates apply to the FIRST image provided. If the defect is only
     visible on a non-first image, omit the region (do NOT guess a box on
     the first image).

   COORDINATE GRID OVERLAY (use this — it is your ground truth):
   - The first image has a faint YELLOW 10×10 grid burned onto it, with
     numeric labels "0.0", "0.1", "0.2", … "1.0" along the TOP edge
     (x-axis) and along the LEFT edge (y-axis).
   - Use the grid to READ the defect's coordinates directly off the image.
     Do NOT estimate from anatomy — look at which yellow labels the defect
     sits between.
   - Procedure:
       1. Find the defect on the image.
       2. Read the x-label JUST LEFT of the defect's left edge   → that's x.
       3. Read the y-label JUST ABOVE the defect's top edge      → that's y.
       4. Read the x-label JUST RIGHT of the defect's right edge → call it x2.
       5. Read the y-label JUST BELOW the defect's bottom edge   → call it y2.
       6. Set w = x2 - x  and  h = y2 - y.
   - The grid is the primary signal. Trust the yellow labels over any
     anatomical intuition. If the grid says the defect is at x=0.45, the
     correct answer is 0.45 — not 0.30, not 0.60.

   Localisation procedure (follow this every time):
   a. Identify the defect's CENTER on the image — call it (cx, cy) in
      0..1 image fractions.
   b. Measure the defect's extent: how wide (dw) and how tall (dh) is
      the defect itself, as image fractions?
   c. Pad by ~10% on each side: w = dw * 1.2, h = dh * 1.2.
   d. Compute the top-left corner: x = cx - w/2, y = cy - h/2.
   e. Clamp into [0,1] so the box stays inside the image.

   Sizing sanity (the box must HUG the defect, not the region of anatomy):
   - Fracture line on a finger / small bone: w and h typically 0.04–0.12.
   - Focal mass / lytic lesion: square-ish, sized to the lesion itself.
   - Open wound / soft-tissue defect: box around the visible disruption,
     NOT the whole finger or limb.
   - Pneumothorax / effusion: box the abnormal lucency / fluid line only.
   - A box larger than 35% of either image dimension (w > 0.35 OR
     h > 0.35) is almost certainly wrong — re-measure and shrink, unless
     the defect genuinely spans that much of the image.
   - A box that contains mostly normal anatomy with the defect in one
     corner is wrong — recenter on the defect.

   Per-finding label:
   - Set 'region.label' to a SHORT noun phrase naming the defect
     ("Closed fracture", "Open skin wound", "Lytic lesion",
     "Pneumothorax", "Dislocation"). Maximum 4 words. This is what the
     radiologist sees on the overlay tooltip.

   Worked example (hand X-ray with a fracture AND an adjacent open wound):
   - Image shows a transverse fracture of the middle phalanx AND a
     soft-tissue wound along the lateral aspect of the SAME or an
     ADJACENT finger.
   - Because the soft-tissue defect lies next to the fracture, you must
     NOT label the fracture as "closed". The correct clinical phrasing is
     "concerning for open fracture" (or "open fracture" if communication
     is unambiguous on the image — see clinical-reasoning rule 7 below).
   - Correct output: TWO findings, TWO regions.
       finding[0]: description "Displaced transverse fracture of the
                   middle phalanx. Adjacent lateral soft-tissue
                   disruption is concerning for open fracture.",
                   confidence: "high",
                   suggestedFollowUp: "Orthopaedic consultation and
                                       immobilisation; assess for open
                                       fracture; consider infection
                                       prophylaxis",
                   region { x: 0.42, y: 0.30, w: 0.10, h: 0.12,
                            label: "Fracture (?open)" }
       finding[1]: description "Open soft-tissue wound on the lateral
                   aspect with disruption of the skin contour, lying
                   adjacent to the fracture site (see finding 1).",
                   confidence: "high",
                   suggestedFollowUp: "Surgical/wound evaluation; tetanus
                                       and infection prophylaxis as
                                       clinically indicated",
                   region { x: 0.70, y: 0.38, w: 0.12, h: 0.14,
                            label: "Open wound" }
   - WRONG output (do NOT do this):
       * Calling the bony injury "closed fracture" when a soft-tissue
         wound sits adjacent on the same image. That is a clinical
         contradiction and a safety bug.
       * One finding with a giant box covering both defects.
       * One finding with a box on the WRONG anatomy.
       * Two findings but both with the same coordinates.

   Self-check before emitting EVERY finding:
   1. Did I count the defects? Emit exactly that many findings with regions.
   2. Is the box anchored from the TOP-LEFT corner of the image (not centre,
      not bottom-left)?
   3. Do x + w ≤ 1 and y + h ≤ 1?
   4. Does the box HUG the defect with ~10% padding, not engulf the anatomy?
   5. Does the label name the defect, not the body part?
   If any answer is no, FIX the coordinates before emitting. Do not emit a
   region you are not confident about — better to omit it than to point at
   the wrong place.

7. CLINICAL CONSISTENCY — relate findings to each other before emitting.
   After you have listed all the visible defects, re-read the list and ask:
   "Do any of these findings interact in a way that changes how I should
   describe them?" Adjacent findings often imply a single combined
   diagnosis. Common patterns the report MUST get right:

   a. Fracture + adjacent soft-tissue disruption / open wound on the same
      bone or finger / limb segment → "OPEN fracture" (NOT closed). If the
      communication between wound and fracture is not unambiguously
      visible, use the safer "concerning for open fracture" phrasing. The
      word "closed" is FORBIDDEN in the same study as a visible adjacent
      soft-tissue wound.

   b. Fracture + dislocation at the same joint → "fracture-dislocation"
      (one combined diagnosis), not two unrelated findings.

   c. Lung opacity + pleural effusion + same hemithorax → consider
      "pneumonia with parapneumonic effusion" rather than two unlinked
      findings.

   d. Pneumothorax + rib fracture on the same side → relate them: the
      pneumothorax is likely traumatic from the rib fracture.

   e. Bone lytic lesion + soft-tissue mass adjacent → relate them:
      "lytic lesion with associated soft-tissue component", suggestive of
      an aggressive process.

   How to apply:
   - Each individual finding still gets its own object + region (so the
     overlay shows each defect).
   - But the DESCRIPTION text of the related findings must mention the
     relationship: "lying adjacent to the fracture site (see finding 1)",
     "concerning for open fracture", "fracture-dislocation", etc.
   - The IMPRESSION must synthesise the combined diagnosis, not just list
     the defects. For the fracture + open wound case, the impression
     should be: "Acute displaced fracture of the <bone> with associated
     soft-tissue injury, concerning for open fracture. Review with
     radiologist."

   Safety rationale: a "closed fracture" diagnosis next to an open wound
   is a clinical contradiction with real management consequences — open
   fractures need surgical washout and antibiotics within hours. Getting
   this wrong is a patient-safety bug, not a wording nit.

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
            description:
              "Tight bounding box around ONE visible defect on the FIRST image. Coordinates are normalised image fractions in [0,1]. Origin (0,0) is the TOP-LEFT pixel. Must satisfy x+w ≤ 1 and y+h ≤ 1. The box must HUG the defect (≈10% padding), not engulf the surrounding anatomy. Emit a SEPARATE finding+region per defect; never merge.",
            properties: {
              x: {
                type: "number",
                description:
                  "Left edge of the box as a fraction of image width. 0 = image's left edge, 1 = image's right edge.",
                minimum: 0,
                maximum: 1,
              },
              y: {
                type: "number",
                description:
                  "Top edge of the box as a fraction of image height. 0 = image's top edge, 1 = image's bottom edge. y increases DOWNWARD.",
                minimum: 0,
                maximum: 1,
              },
              w: {
                type: "number",
                description:
                  "Box width as a fraction of image width. Typical defect: 0.04–0.20. A value > 0.35 is almost always wrong.",
                minimum: 0,
                maximum: 1,
              },
              h: {
                type: "number",
                description:
                  "Box height as a fraction of image height. Typical defect: 0.04–0.20. A value > 0.35 is almost always wrong.",
                minimum: 0,
                maximum: 1,
              },
              label: {
                type: "string",
                description:
                  "Short noun phrase naming the defect (max 4 words). Examples: 'Closed fracture', 'Open skin wound', 'Lytic lesion', 'Pneumothorax'.",
              },
            },
            required: ["x", "y", "w", "h"],
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
  // `loadImagesForVision` is async because it burns a coordinate grid
  // overlay onto each image (sharp pipeline) for better localisation.
  const visionImages = await loadImagesForVision(opts.images);
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
  // Vision model is the strongest image-capable OpenAI model. `gpt-4o` is
  // the default; ops can override via OPENAI_VISION_MODEL when a newer /
  // better localiser becomes available (e.g. `gpt-4o-2024-11-20`) without
  // a code change.
  const visionModel = process.env.OPENAI_VISION_MODEL || "gpt-4o";

  const t0 = Date.now();
  try {
    let usedProvider: ModelProvider = providers[0];
    // 2026-05-29: branch the API call shape on provider. Sarvam-m
    // doesn't support OpenAI function/tool calling — we use
    // response_format: json_object + a JSON-schema-in-system-prompt and
    // parse the reply directly. OpenAI keeps the original tools path
    // for the vision-fallback case.
    const jsonSchemaInstruction =
      "\n\nReturn ONLY a single JSON object (no prose, no markdown code fences) " +
      "for the radiology-report draft — impression, findings (each with a confidence band), " +
      "and recommendations. Match this JSON Schema (treat 'required' fields as mandatory):\n" +
      JSON.stringify(TOOL_SCHEMA);

    let response = await callWithFallback(
      (client, provider) => {
        usedProvider = provider;
        const model = useVision ? visionModel : PROVIDER_MODEL[provider];
        if (provider === "sarvam") {
          return client.chat.completions.create({
            model,
            max_tokens: 1500,
            temperature: 0.2,
            response_format: { type: "json_object" },
            messages: [
              { role: "system", content: SYSTEM_PROMPT + jsonSchemaInstruction },
              { role: "user", content: userMessageContent as any },
            ],
          });
        }
        return client.chat.completions.create({
          model,
          max_tokens: 1500,
          temperature: useVision ? 0 : 0.2,
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

    // Parse helper that handles BOTH wire shapes — tool_call (OpenAI)
    // and json content (Sarvam json_object mode).
    function extractRadiologyDraft(
      r: OpenAI.Chat.Completions.ChatCompletion,
      provider: ModelProvider,
    ): RadiologyDraftResult | null {
      if (provider === "sarvam") {
        return parseSarvamJson<RadiologyDraftResult>(
          r.choices[0]?.message?.content,
        );
      }
      const tc = getToolCallFromResponse(r);
      if (!tc) return null;
      try {
        return JSON.parse(tc.function.arguments) as RadiologyDraftResult;
      } catch {
        return null;
      }
    }

    let data = extractRadiologyDraft(response, usedProvider);
    let toolCall = usedProvider === "openai" ? getToolCallFromResponse(response) : undefined;
    // Empty-result fallback only applies to the text-only path. When
    // vision is in play we already used OpenAI directly — there's no
    // alternative provider to retry against.
    if (!data && !useVision && usedProvider === "sarvam") {
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
      data = extractRadiologyDraft(response, usedProvider);
      toolCall = getToolCallFromResponse(response);
    }

    const promptTokens = response.usage?.prompt_tokens ?? 0;
    const completionTokens = response.usage?.completion_tokens ?? 0;

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
