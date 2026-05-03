/**
 * Patient Data Export routes — DPDP Act 2023 right-to-portability.
 *
 *   POST   /api/v1/patient-data-export            create an export request (QUEUED)
 *   GET    /api/v1/patient-data-export/:id        status + downloadUrl when READY
 *   GET    /api/v1/patient-data-export/:id/download  stream the finished file
 *
 * Only PATIENT role can create + read their own exports. The download route
 * also honours HMAC signed URLs (same scheme as /uploads/:filename) so the
 * URL we hand back in `downloadUrl` can be opened in a browser without an
 * auth header. Signed URLs expire after 1 hour.
 *
 * Backed by the `PatientDataExport` Prisma model — migration shipped in
 * `20260424000004_prd_closure_models`. Tenant-scoped.
 */

import fs from "fs";
import path from "path";
import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { tenantScopedPrisma as prisma } from "../services/tenant-prisma";
import { Role } from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { auditLog } from "../middleware/audit";
import { signParts, verifySignature } from "../services/signed-url";
import {
  countRecentExports,
  scheduleExportWorker,
  EXPORT_DIR,
  EXPORT_FORMATS,
  EXPORT_WINDOW_MAX,
  type PatientDataExportFormat,
} from "../services/patient-data-export";

const router = Router();

// 1 hour signed download URL TTL per the DPDP portability spec.
const DOWNLOAD_TTL_SECONDS = 60 * 60;

// ─── Validation ────────────────────────────────────────────────────────────

const createSchema = z.object({
  format: z.enum(["json", "fhir", "pdf"]),
});

// ─── Helpers ───────────────────────────────────────────────────────────────

function safeAudit(
  req: Request,
  action: string,
  entity: string,
  entityId: string | undefined,
  details?: Record<string, unknown>
): void {
  auditLog(req, action, entity, entityId, details).catch((err) => {
    console.warn(
      `[audit] ${action} failed (non-fatal):`,
      (err as Error)?.message ?? err
    );
  });
}

/**
 * Resolve the Patient row for the authenticated user. Only PATIENT-role
 * users have a 1:1 Patient record via `userId`.
 */
async function getCallerPatient(
  req: Request
): Promise<{ id: string; tenantId?: string | null } | null> {
  if (!req.user) return null;
  return prisma.patient.findFirst({
    where: { userId: req.user.userId },
    select: { id: true, tenantId: true },
  });
}

function downloadPathFor(requestId: string): string {
  return `patient-data-export:${requestId}`;
}

/**
 * Shape returned to the mobile/web clients. `downloadUrl` is populated only
 * when the export is READY; it embeds signed query params that expire in
 * 1 hour.
 */
function toWireStatus(row: any, req: Request) {
  let downloadUrl: string | null = null;
  if (row.status === "READY") {
    const parts = signParts(downloadPathFor(row.id), DOWNLOAD_TTL_SECONDS);
    // Relative path — the client resolves against its configured API base.
    downloadUrl = `/api/v1/patient-data-export/${row.id}/download?expires=${parts.expires}&sig=${parts.sig}`;
  }
  return {
    requestId: row.id,
    format: String(row.format).toLowerCase(),
    status: row.status,
    requestedAt: row.requestedAt,
    readyAt: row.readyAt,
    errorMessage: row.errorMessage ?? null,
    fileSize: row.fileSize ?? null,
    downloadUrl,
    // echo the TTL so the UI can show "link expires in … minutes".
    downloadTtlSeconds: row.status === "READY" ? DOWNLOAD_TTL_SECONDS : null,
    // unused in the UI today but handy for callers consuming the JSON envelope
    selfUrl: `/api/v1/patient-data-export/${row.id}`,
    // `req` is unused in the body but some consumers like to embed the full
    // URL; keep a hook here rather than forcing a second render pass.
    _: req.originalUrl ? undefined : undefined,
  };
}

// ─── POST /api/v1/patient-data-export ──────────────────────────────────────

router.post(
  "/",
  authenticate,
  authorize(Role.PATIENT),
  validate(createSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { format } = req.body as { format: PatientDataExportFormat };
      if (!EXPORT_FORMATS.includes(format)) {
        res.status(400).json({
          success: false,
          data: null,
          error: `Unsupported format: ${format}`,
        });
        return;
      }

      const patient = await getCallerPatient(req);
      if (!patient) {
        res.status(400).json({
          success: false,
          data: null,
          error:
            "Please complete your patient profile before requesting a data export.",
        });
        return;
      }

      // Per-patient 3-per-24h rate limit. Enforced at the application layer
      // (not the IP-based `rateLimit` middleware) because a household may
      // share a single NAT'd IP and each patient is entitled to their own
      // portability allowance.
      const recent = await countRecentExports(patient.id);
      if (recent >= EXPORT_WINDOW_MAX) {
        res.status(429).json({
          success: false,
          data: null,
          error: `You have reached the daily limit of ${EXPORT_WINDOW_MAX} data exports. Please try again in 24 hours.`,
        });
        safeAudit(req, "PATIENT_DATA_EXPORT_RATE_LIMIT", "Patient", patient.id, {
          recentCount: recent,
        });
        return;
      }

      const row = await prisma.patientDataExport.create({
        data: {
          patientId: patient.id,
          format: format.toUpperCase() as "JSON" | "FHIR" | "PDF",
          status: "QUEUED",
        },
      });

      // Fire-and-forget background job. Tenant context is carried through by
      // the service via runWithTenant on the row's tenantId.
      scheduleExportWorker(row.id);

      safeAudit(req, "PATIENT_DATA_EXPORT_REQUEST", "PatientDataExport", row.id, {
        format,
        patientId: patient.id,
      });

      res.status(201).json({
        success: true,
        data: {
          requestId: row.id,
          status: "QUEUED",
          format,
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /api/v1/patient-data-export/:requestId ────────────────────────────

router.get(
  "/:requestId",
  authenticate,
  authorize(Role.PATIENT),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { requestId } = req.params;
      const patient = await getCallerPatient(req);
      if (!patient) {
        res.status(403).json({ success: false, data: null, error: "Forbidden" });
        return;
      }

      const row = await prisma.patientDataExport.findUnique({
        where: { id: requestId },
      });
      if (!row) {
        res.status(404).json({
          success: false,
          data: null,
          error: "Export request not found",
        });
        return;
      }
      if (row.patientId !== patient.id) {
        // Don't leak whether the row exists to other patients.
        res.status(403).json({ success: false, data: null, error: "Forbidden" });
        return;
      }

      safeAudit(
        req,
        "PATIENT_DATA_EXPORT_STATUS",
        "PatientDataExport",
        row.id,
        { status: row.status }
      );

      res.json({
        success: true,
        data: toWireStatus(row, req),
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /api/v1/patient-data-export/:requestId/download ───────────────────
//
// Two access modes, same as /uploads/:filename:
//
//   1. Signed URL   — ?expires=…&sig=…            (stateless, browser-openable)
//   2. Bearer token — Authorization: Bearer …     (fall-through for API clients)
//
router.get(
  "/:requestId/download",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { requestId } = req.params;
      const expires = req.query.expires;
      const sig = req.query.sig;

      const signedValid =
        typeof expires === "string" &&
        typeof sig === "string" &&
        verifySignature(downloadPathFor(requestId), expires, sig);

      // If no signed URL, fall back to bearer auth + ownership check.
      if (!signedValid) {
        return authenticate(req, res, async () => {
          if (!req.user || req.user.role !== Role.PATIENT) {
            res
              .status(403)
              .json({ success: false, data: null, error: "Forbidden" });
            return;
          }
          const patient = await getCallerPatient(req);
          if (!patient) {
            res
              .status(403)
              .json({ success: false, data: null, error: "Forbidden" });
            return;
          }
          const row = await prisma.patientDataExport.findUnique({
            where: { id: requestId },
          });
          if (!row || row.patientId !== patient.id) {
            res
              .status(403)
              .json({ success: false, data: null, error: "Forbidden" });
            return;
          }
          await streamExport(req, res, row);
        });
      }

      // Signed URL path — load row directly (no tenant scoping because the
      // signature is the authoritative access grant, and tenant-scoped
      // prisma would return null for a signed link hit before auth has
      // populated tenant context).
      const { prisma: rawPrisma } = await import("@medcore/db");
      const row = await rawPrisma.patientDataExport.findUnique({
        where: { id: requestId },
      });
      if (!row) {
        res.status(404).json({
          success: false,
          data: null,
          error: "Export not found",
        });
        return;
      }
      await streamExport(req, res, row);
    } catch (err) {
      next(err);
    }
  }
);

async function streamExport(req: Request, res: Response, row: any): Promise<void> {
  if (row.status !== "READY" || !row.filePath) {
    res.status(409).json({
      success: false,
      data: null,
      error: `Export is ${row.status}; not yet ready for download.`,
    });
    return;
  }
  const safeName = path.basename(row.filePath);
  const fullPath = path.join(EXPORT_DIR, safeName);
  if (!fullPath.startsWith(EXPORT_DIR) || !fs.existsSync(fullPath)) {
    res.status(410).json({
      success: false,
      data: null,
      error: "Export file is no longer available on disk.",
    });
    return;
  }

  const mime =
    row.format === "PDF"
      ? "application/pdf"
      : row.format === "FHIR"
        ? "application/fhir+json"
        : "application/json";
  const downloadName =
    row.format === "PDF"
      ? `medcore-export-${row.id}.pdf`
      : row.format === "FHIR"
        ? `medcore-export-${row.id}.fhir.json`
        : `medcore-export-${row.id}.json`;

  res.setHeader("Content-Type", mime);
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${downloadName}"`
  );
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");

  // Best-effort update of downloadedAt on first download. Don't hold the
  // response waiting for it.
  (async () => {
    try {
      const { prisma: rawPrisma } = await import("@medcore/db");
      if (!row.downloadedAt) {
        await rawPrisma.patientDataExport.update({
          where: { id: row.id },
          data: { downloadedAt: new Date() },
        });
      }
    } catch {
      // non-fatal
    }
  })();

  safeAudit(req, "PATIENT_DATA_EXPORT_DOWNLOAD", "PatientDataExport", row.id, {
    format: row.format,
  });

  res.sendFile(fullPath);
}

export { router as patientDataExportRouter };
