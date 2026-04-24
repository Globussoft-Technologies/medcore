// Radiology Report Drafting (PRD §7.2).
//
// AI pre-reads imaging, drafts a report, highlights suspicious regions, and
// a radiologist approves/edits the final text. This is a strict HITL flow:
// the AI never produces a FINAL report on its own — `approveReport()` is the
// only way to move a report to FINAL status.
//
// DICOM TODO — the first pass treats images as opaque file keys stored via
// the existing storage.ts flow (JPEG/PNG/DICOM blobs handled identically).
// Real DICOM metadata extraction (study UID, series UID, window/level, pixel
// spacing) is a follow-up; until then we only thread the free-text modality
// + body part + clinical history into the Sarvam prompt.

import { tenantScopedPrisma as prisma } from "../tenant-prisma";
import { generateStructured, logAICall } from "./sarvam";
import { sanitizeUserInput } from "./prompt-safety";

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

export interface RadiologyImageRef {
  key: string;
  filename?: string;
  contentType?: string;
  sizeBytes?: number;
  uploadedAt?: string;
}

export interface RadiologyFinding {
  description: string;
  confidence: "low" | "medium" | "high";
  suggestedFollowUp?: string;
  /**
   * Optional bounding-box region on the image (x,y,w,h normalised 0..1) with
   * an optional label. Captured but not yet rendered in the UI — overlay is
   * a deferred feature.
   */
  region?: { x: number; y: number; w: number; h: number; label?: string };
}

export interface RadiologyDraftResult {
  impression: string;
  findings: RadiologyFinding[];
  recommendations: string[];
}

// ── System prompt ─────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an AI assistant helping a radiologist draft a
report. Based on modality, body part, clinical history, and free-text findings,
produce a structured draft.

Rules:
- Flag every finding with a confidence rating: "low", "medium", or "high".
- Never produce a definitive diagnosis — your output is a draft for radiologist
  review, not a final signed report.
- If a finding is suspicious for malignancy, infection, or acute process,
  include a specific suggestedFollowUp (e.g. "Correlate with tissue biopsy",
  "Repeat in 6 weeks", "Clinical correlation recommended").
- Always include a "Review with radiologist" footer sentence in the impression.
- Recommendations should be concrete next steps (e.g. "Compare with prior
  studies", "Consider contrast-enhanced study", "Refer to surgical
  consultation").
- If the provided free-text findings are empty / trivial, generate a generic
  "no abnormalities detected on the provided views — clinical correlation
  recommended" style draft rather than fabricating findings.`;

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
  },
  required: ["impression", "findings", "recommendations"],
};

// ── generateDraftReport ───────────────────────────────────────────────────────

/**
 * Call Sarvam to produce a structured radiology-report draft. Returns the raw
 * structured response; persistence is the caller's job (see `createReportDraft`).
 *
 * Does NOT persist anything. Safe to call from preview endpoints.
 */
export async function generateDraftReport(opts: {
  studyId: string;
  modality: RadiologyModality;
  bodyPart: string;
  clinicalHistory?: string;
  findings?: string;
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

  const userPrompt = `Study context:
- Modality: ${opts.modality}
- Body part: ${safeBodyPart}
- Clinical history: ${safeHistory || "none provided"}

Free-text findings from the technologist / referring clinician:
${safeFindings || "no pre-read provided"}

Produce a structured radiology-report draft. Flag confidence on every finding.
End the impression with "Review with radiologist".`;

  const t0 = Date.now();
  try {
    const { data, promptTokens, completionTokens } =
      await generateStructured<RadiologyDraftResult>({
        systemPrompt: SYSTEM_PROMPT,
        userPrompt,
        toolName: "emit_radiology_draft",
        toolDescription:
          "Emit a structured radiology-report draft with impression, findings (each with a confidence band), and recommendations.",
        parameters: TOOL_SCHEMA,
        maxTokens: 1500,
        temperature: 0.2,
      });

    logAICall({
      feature: "scribe",
      model: "sarvam-105b",
      promptTokens,
      completionTokens,
      latencyMs: Date.now() - t0,
      toolUsed: "emit_radiology_draft",
    });

    if (!data) {
      return {
        impression:
          "Unable to produce a draft from the available input. Review with radiologist.",
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

    return {
      impression,
      findings,
      recommendations: Array.isArray(data.recommendations)
        ? data.recommendations.map((r) => String(r))
        : [],
    };
  } catch (err) {
    logAICall({
      feature: "scribe",
      model: "sarvam-105b",
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
 * references, not the blobs.
 */
export async function createStudy(params: {
  patientId: string;
  modality: RadiologyModality;
  bodyPart: string;
  images: RadiologyImageRef[];
  studyDate?: Date;
  notes?: string;
  orderId?: string;
}): Promise<any> {
  return prisma.radiologyStudy.create({
    data: {
      patientId: params.patientId,
      modality: params.modality,
      bodyPart: params.bodyPart,
      images: params.images as any,
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
 */
export async function createReportDraft(studyId: string): Promise<any> {
  const study = await prisma.radiologyStudy.findUnique({
    where: { id: studyId },
    include: { report: true },
  });
  if (!study) {
    throw new Error(`RadiologyStudy ${studyId} not found`);
  }
  if (study.report) {
    return study.report;
  }

  const draft = await generateDraftReport({
    studyId,
    modality: study.modality as RadiologyModality,
    bodyPart: study.bodyPart,
    clinicalHistory: study.notes ?? undefined,
  });

  return prisma.radiologyReport.create({
    data: {
      studyId,
      aiDraft: [
        draft.impression,
        "",
        "FINDINGS:",
        ...draft.findings.map(
          (f) =>
            `- [${f.confidence}] ${f.description}${f.suggestedFollowUp ? ` (follow-up: ${f.suggestedFollowUp})` : ""}`
        ),
        "",
        "RECOMMENDATIONS:",
        ...draft.recommendations.map((r) => `- ${r}`),
      ].join("\n"),
      aiFindings: draft.findings as any,
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
): Promise<any> {
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
): Promise<any> {
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
