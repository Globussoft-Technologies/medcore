// Radiology Report Drafting (PRD §7.2) — HITL flow.
//
// Scope: upload study metadata (image keys come from the existing storage /
// signed-URL layer), kick off AI draft, list pending reviews, approve / amend.
// DICOM parsing is intentionally deferred — see `.prisma-models-radiology.md`.
//
// Audit: every state-mutating call writes an AuditLog entry. Read-only GETs
// also audit because radiology reports are PHI.

import { Router, Request, Response, NextFunction } from "express";
// Multi-tenant wiring: `tenantScopedPrisma` auto-injects tenantId on create
// and auto-filters on read. See services/tenant-prisma.ts.
import { tenantScopedPrisma as prisma } from "../services/tenant-prisma";
import { Role } from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";
import { auditLog } from "../middleware/audit";
import { rateLimit } from "../middleware/rate-limit";
import {
  createStudy,
  createReportDraft,
  approveReport,
  amendReport,
  type RadiologyModality,
  type RadiologyImageRef,
} from "../services/ai/radiology-reports";
import { getSignedDownloadUrl } from "../services/storage";

/**
 * Best-effort audit wrapper: PHI audit writes must never take a GET response
 * down with them. If prisma is unavailable (e.g. transient DB blip), log a
 * warning and allow the request to complete.
 */
function safeAudit(
  req: Request,
  action: string,
  entity: string,
  entityId: string | undefined,
  details?: Record<string, unknown>
): void {
  auditLog(req, action, entity, entityId, details).catch((err) => {
    console.warn(`[audit] ${action} failed (non-fatal):`, (err as Error)?.message ?? err);
  });
}

const MODALITIES: RadiologyModality[] = [
  "XRAY",
  "CT",
  "MRI",
  "ULTRASOUND",
  "MAMMOGRAPHY",
  "PET",
];

/**
 * Build the absolute base URL the frontend should hit for image downloads.
 * In dev, the local-storage signer returns a relative path like
 * `/api/v1/uploads/<file>?expires=…&sig=…` — we need to prepend the API
 * host (CORS-safe, same origin the caller already trusts) so an `<img>`
 * tag on the Next.js page can resolve it. In S3 mode the signer returns
 * an absolute presigned URL already; we leave those untouched.
 *
 * Honours `process.env.API_PUBLIC_URL` for deployments where the API is
 * fronted by a CDN / different host than the request landed on; falls back
 * to the request's own origin otherwise.
 */
function originForRequest(req: Request): string {
  if (process.env.API_PUBLIC_URL) {
    return process.env.API_PUBLIC_URL.replace(/\/+$/, "");
  }
  const proto = (req.headers["x-forwarded-proto"] as string | undefined) ??
    (req.protocol || "http");
  const host = (req.headers["x-forwarded-host"] as string | undefined) ??
    req.get("host") ??
    "localhost:4000";
  return `${proto}://${host}`;
}

/**
 * Walk the `images` JSON column on a RadiologyStudy and attach a short-
 * lived `signedUrl` to each entry. Mutates a shallow copy — never the
 * original Prisma row. TTL is 5 minutes: long enough for the radiologist
 * to render the page, short enough that a leaked URL ages out fast.
 *
 * Resilient to malformed shapes (non-array, missing `key`) — those entries
 * pass through unchanged so a single bad row never breaks the response.
 */
async function attachSignedUrls(
  req: Request,
  images: unknown,
): Promise<unknown> {
  if (!Array.isArray(images)) return images;
  const origin = originForRequest(req);
  const out = await Promise.all(
    images.map(async (img) => {
      if (!img || typeof img !== "object") return img;
      const rec = img as Record<string, unknown>;
      const key = typeof rec.key === "string" ? rec.key : null;
      if (!key) return img;
      try {
        const signed = await getSignedDownloadUrl(key, 300);
        // Local-mode signer returns a relative path starting with "/" —
        // prepend origin. S3-mode returns an absolute https:// URL — pass
        // through untouched.
        const absolute = /^https?:\/\//i.test(signed)
          ? signed
          : `${origin}${signed.startsWith("/") ? "" : "/"}${signed}`;
        return { ...rec, signedUrl: absolute };
      } catch {
        // Signer transient failure — leave the entry without a signedUrl
        // rather than 500ing the whole list. Frontend will fall back to
        // showing no preview for this image.
        return img;
      }
    }),
  );
  return out;
}

export const aiRadiologyRouter = Router();

aiRadiologyRouter.use(authenticate);
// security(2026-04-24-med): F-RAD-* — draft generation is Sarvam-backed
// (one LLM call). Cap to 20/min/IP so one caller can't burn budget.
if (process.env.NODE_ENV !== "test") {
  aiRadiologyRouter.use(rateLimit(20, 60_000));
}

// ── POST /studies ─────────────────────────────────────────────────────────────
// Upload study metadata. Image bytes come from the existing /uploads flow;
// we persist opaque file keys in RadiologyStudy.images.

aiRadiologyRouter.post(
  "/studies",
  authorize(Role.DOCTOR, Role.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const {
        patientId,
        modality,
        bodyPart,
        imageKeys,
        images: imagesBody,
        studyDate,
        notes,
        orderId,
      } = req.body as {
        patientId: string;
        modality: RadiologyModality;
        bodyPart: string;
        imageKeys?: string[];
        images?: Array<{
          key: string;
          filename?: string;
          contentType?: string;
          sizeBytes?: number;
        }>;
        studyDate?: string;
        notes?: string;
        orderId?: string;
      };

      // Accept either the lightweight `imageKeys` (existing callers) or the
      // richer `images` array (clients that already know filename /
      // contentType — enables DICOM parsing downstream).
      const rawImages: RadiologyImageRef[] =
        Array.isArray(imagesBody) && imagesBody.length > 0
          ? imagesBody.map((i) => ({
              key: String(i.key),
              filename: i.filename ? String(i.filename) : undefined,
              contentType: i.contentType ? String(i.contentType) : undefined,
              sizeBytes: typeof i.sizeBytes === "number" ? i.sizeBytes : undefined,
              uploadedAt: new Date().toISOString(),
            }))
          : Array.isArray(imageKeys)
          ? imageKeys.map((k) => ({
              key: String(k),
              uploadedAt: new Date().toISOString(),
            }))
          : [];

      if (!patientId || !modality || !bodyPart || rawImages.length === 0) {
        res.status(400).json({
          success: false,
          data: null,
          error: "patientId, modality, bodyPart and at least one imageKey are required",
        });
        return;
      }
      if (!MODALITIES.includes(modality)) {
        res.status(400).json({
          success: false,
          data: null,
          error: `modality must be one of ${MODALITIES.join(", ")}`,
        });
        return;
      }

      // Resolve `patientId` to the canonical Patient.id. Accept either:
      //   • the internal UUID/cuid (legacy + frontend EntityPicker output), or
      //   • the human-facing MR number (e.g. "MRN-2026-0042") for callers
      //     that only know the hospital number — curl, integration scripts,
      //     manual ops. The MR field has a `@unique` constraint so this is
      //     a safe O(1) lookup. Falls back to id-lookup if the MR-number
      //     branch misses, so a UUID that happens to look MR-shaped still
      //     works.
      //
      // Both lookups go through `tenantScopedPrisma`, so a caller can never
      // resolve to a patient outside their own tenant — the lookup just
      // returns null in that case and we 404 the same way as a missing row.
      const isMrNumberShape = /^MRN?[-_]/i.test(patientId);
      let patient = isMrNumberShape
        ? await prisma.patient.findFirst({ where: { mrNumber: patientId } })
        : await prisma.patient.findUnique({ where: { id: patientId } });
      if (!patient && isMrNumberShape) {
        // MR-shaped string didn't match — try as id (rare but possible).
        patient = await prisma.patient.findUnique({ where: { id: patientId } });
      }
      if (!patient) {
        res.status(404).json({ success: false, data: null, error: "Patient not found" });
        return;
      }

      // From here on, always use the resolved internal id. createStudy + the
      // study row's FK relations + the audit log all need the DB primary
      // key, not whatever the caller typed.
      const resolvedPatientId = patient.id;

      const images: RadiologyImageRef[] = rawImages;

      const study = await createStudy({
        patientId: resolvedPatientId,
        modality,
        bodyPart,
        images,
        studyDate: studyDate ? new Date(studyDate) : undefined,
        notes,
        orderId,
      });

      safeAudit(req, "RADIOLOGY_STUDY_CREATE", "RadiologyStudy", study.id, {
        modality,
        bodyPart,
        imageCount: images.length,
      });

      res.status(201).json({ success: true, data: study, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// ── POST /:studyId/draft ──────────────────────────────────────────────────────
// Kick off AI draft generation for a study. Creates a RadiologyReport with
// status = DRAFT. Idempotent — re-calling returns the existing draft.

aiRadiologyRouter.post(
  "/:studyId/draft",
  authorize(Role.DOCTOR, Role.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { studyId } = req.params;

      // Verify the study exists & is in the caller's tenant before firing the
      // expensive LLM call.
      const study = await prisma.radiologyStudy.findUnique({
        where: { id: studyId },
      });
      if (!study) {
        res.status(404).json({ success: false, data: null, error: "Study not found" });
        return;
      }

      const report = await createReportDraft(studyId);

      safeAudit(req, "RADIOLOGY_DRAFT_CREATE", "RadiologyReport", report.id, {
        studyId,
      });

      res.status(201).json({ success: true, data: report, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// ── GET /studies/:studyId ─────────────────────────────────────────────────────
// Return the study + its report (if any). Doctor, admin, and reception can
// view. RADIOLOGIST role does not exist in the enum yet — DOCTOR/ADMIN only.

aiRadiologyRouter.get(
  "/studies/:studyId",
  authorize(Role.DOCTOR, Role.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { studyId } = req.params;
      const study = await prisma.radiologyStudy.findUnique({
        where: { id: studyId },
        include: {
          report: true,
          patient: { include: { user: { select: { name: true } } } },
        },
      });
      if (!study) {
        res.status(404).json({ success: false, data: null, error: "Study not found" });
        return;
      }

      safeAudit(req, "RADIOLOGY_STUDY_READ", "RadiologyStudy", studyId);

      // Attach short-lived signed URLs so the dashboard's <img> tag can
      // render the imaging without sending an Authorization header.
      const studyWithUrls = {
        ...study,
        images: await attachSignedUrls(req, study.images),
      };

      res.json({ success: true, data: studyWithUrls, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// ── GET /pending-review ───────────────────────────────────────────────────────
// Triage queue: DRAFT + RADIOLOGIST_REVIEW reports, tenant-scoped.

aiRadiologyRouter.get(
  "/pending-review",
  authorize(Role.DOCTOR, Role.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const reports = await prisma.radiologyReport.findMany({
        where: { status: { in: ["DRAFT", "RADIOLOGIST_REVIEW"] } },
        orderBy: { createdAt: "desc" },
        take: 100,
        include: {
          study: {
            include: {
              patient: { include: { user: { select: { name: true } } } },
            },
          },
        },
      });

      // Attach short-lived signed URLs to each report's primary-image set
      // so the dashboard preview can render with a plain <img>. We do this
      // in parallel — 100 reports × ~1 ms per signature is negligible.
      const reportsWithUrls = await Promise.all(
        reports.map(async (r) => {
          if (!r.study) return r;
          return {
            ...r,
            study: {
              ...r.study,
              images: await attachSignedUrls(req, r.study.images),
            },
          };
        }),
      );

      res.json({ success: true, data: reportsWithUrls, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// ── POST /:reportId/approve ───────────────────────────────────────────────────
// HITL approval. Moves DRAFT / RADIOLOGIST_REVIEW → FINAL.

aiRadiologyRouter.post(
  "/:reportId/approve",
  authorize(Role.DOCTOR, Role.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { reportId } = req.params;
      const { finalReport, finalImpression } = req.body as {
        finalReport: string;
        finalImpression?: string;
      };

      if (!finalReport || finalReport.trim().length < 10) {
        res.status(400).json({
          success: false,
          data: null,
          error: "finalReport is required and must be at least 10 characters",
        });
        return;
      }

      const userId = req.user?.userId;
      if (!userId) {
        res.status(401).json({ success: false, data: null, error: "Unauthorized" });
        return;
      }

      try {
        const updated = await approveReport(reportId, finalReport, userId, finalImpression);

        safeAudit(req, "RADIOLOGY_REPORT_APPROVE", "RadiologyReport", reportId, {
          approvedBy: userId,
        });

        res.json({ success: true, data: updated, error: null });
      } catch (err) {
        const msg = (err as Error).message ?? String(err);
        if (msg.includes("not found")) {
          res.status(404).json({ success: false, data: null, error: msg });
          return;
        }
        if (msg.includes("already")) {
          res.status(409).json({ success: false, data: null, error: msg });
          return;
        }
        throw err;
      }
    } catch (err) {
      next(err);
    }
  }
);

// ── POST /:reportId/amend ─────────────────────────────────────────────────────
// Post-FINAL amendment.

aiRadiologyRouter.post(
  "/:reportId/amend",
  authorize(Role.DOCTOR, Role.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { reportId } = req.params;
      const { finalReport, finalImpression } = req.body as {
        finalReport: string;
        finalImpression?: string;
      };

      if (!finalReport || finalReport.trim().length < 10) {
        res.status(400).json({
          success: false,
          data: null,
          error: "finalReport is required and must be at least 10 characters",
        });
        return;
      }

      const userId = req.user?.userId;
      if (!userId) {
        res.status(401).json({ success: false, data: null, error: "Unauthorized" });
        return;
      }

      try {
        const updated = await amendReport(reportId, finalReport, userId, finalImpression);

        safeAudit(req, "RADIOLOGY_REPORT_AMEND", "RadiologyReport", reportId, {
          amendedBy: userId,
        });

        res.json({ success: true, data: updated, error: null });
      } catch (err) {
        const msg = (err as Error).message ?? String(err);
        if (msg.includes("not found")) {
          res.status(404).json({ success: false, data: null, error: msg });
          return;
        }
        if (msg.includes("must be FINAL")) {
          res.status(409).json({ success: false, data: null, error: msg });
          return;
        }
        throw err;
      }
    } catch (err) {
      next(err);
    }
  }
);
