import express, { Router, Request, Response, NextFunction } from "express";
import fs from "fs";
import path from "path";
import crypto from "crypto";
// Multi-tenant wiring: `tenantScopedPrisma` is a Prisma $extends wrapper that
// auto-injects tenantId on create and auto-filters on read for the 20
// tenant-scoped models (see services/tenant-prisma.ts). We alias it to
// `prisma` so every existing call site keeps working without edits.
import { tenantScopedPrisma as prisma } from "../services/tenant-prisma";
import { authenticate } from "../middleware/auth";
import { auditLog } from "../middleware/audit";
import {
  detectMime,
  ALLOWED_MIMES,
} from "../services/file-magic";
import {
  verifySignature,
  DEFAULT_TTL_SECONDS,
} from "../services/signed-url";
import { uploadFile, getSignedDownloadUrl, isS3Enabled } from "../services/storage";

const router = Router();

// ─── Size cap ───────────────────────────────────────────
// Hard cap: 10 MB. Must stay in sync with:
//   - nginx `client_max_body_size 10m` on medcore.globusdemos.com
//   - the web client's pre-upload size guard
// Raising this requires updating ALL THREE so requests aren't dropped
// at the proxy with a confusing 413.
export const UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
// Base64 expands ~4/3, so the JSON body must allow a little slack.
const JSON_BODY_LIMIT = "14mb";

// Allow oversize base64 uploads on this router only.
router.use(express.json({ limit: JSON_BODY_LIMIT }));

// Ensure the upload directory exists
const UPLOAD_DIR = path.join(process.cwd(), "uploads", "ehr");
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

function sanitizeFilename(name: string): string {
  const base = path.basename(name);
  return base.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 96);
}

// Internal helper: ACL check for a PatientDocument row.
// Returns null if access is allowed, or a {status, error} tuple otherwise.
async function checkDocumentAccess(
  doc: { id: string; patientId: string; uploadedBy: string },
  user: { userId: string; role: string }
): Promise<{ status: number; error: string } | null> {
  if (user.role === "ADMIN") return null;
  if (doc.uploadedBy === user.userId) return null;

  // Patient owner
  const patient = await prisma.patient.findUnique({
    where: { id: doc.patientId },
    select: { userId: true },
  });
  if (patient?.userId === user.userId) return null;

  // Treating doctor — any doctor who has had an appointment with this patient
  if (user.role === "DOCTOR") {
    const doctor = await prisma.doctor.findUnique({
      where: { userId: user.userId },
      select: { id: true },
    });
    if (doctor) {
      const appt = await prisma.appointment.findFirst({
        where: { patientId: doc.patientId, doctorId: doctor.id },
        select: { id: true },
      });
      if (appt) return null;
    }
  }

  return { status: 403, error: "Forbidden" };
}

// ════════════════════════════════════════════════════════
// POST /api/v1/uploads
// ════════════════════════════════════════════════════════
//
// JSON body: { filename, base64Content, patientId?, type? }
//
// Stores the decoded file under ./uploads/ehr/ and returns the relative
// path the caller should persist on PatientDocument.filePath, plus a
// short-lived signed URL for immediate download.
//
// Enforces:
//   - 10 MB hard size cap (UPLOAD_MAX_BYTES)
//   - magic-byte content sniffing against the medical-file allow-list
//     (PDF, JPEG, PNG, WEBP, DICOM). EXE / HTML / scripts / unknown → 400.
//
// NOTE: this route still requires authentication. The legacy GET-by-filename
// endpoint below also requires authentication; for cross-tenant safety,
// callers should prefer GET /:documentId which performs row-level ACL.
router.post(
  "/",
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { filename, base64Content, patientId, type } = req.body as {
        filename?: string;
        base64Content?: string;
        patientId?: string;
        type?: string;
      };

      if (!filename || !base64Content) {
        res.status(400).json({
          success: false,
          data: null,
          error: "filename and base64Content are required",
        });
        return;
      }

      // Accept data URLs like "data:application/pdf;base64,...."
      const commaIdx = base64Content.indexOf(",");
      const rawB64 =
        base64Content.startsWith("data:") && commaIdx > -1
          ? base64Content.slice(commaIdx + 1)
          : base64Content;

      let buffer: Buffer;
      try {
        buffer = Buffer.from(rawB64, "base64");
      } catch {
        res.status(400).json({
          success: false,
          data: null,
          error: "Invalid base64 content",
        });
        return;
      }

      if (buffer.length === 0) {
        res.status(400).json({
          success: false,
          data: null,
          error: "Empty file",
        });
        return;
      }

      if (buffer.length > UPLOAD_MAX_BYTES) {
        res.status(413).json({
          success: false,
          data: null,
          error: `File exceeds ${UPLOAD_MAX_BYTES} bytes (10 MB)`,
        });
        return;
      }

      // ─── MIME sniffing & allow-list ─────────────────────
      // For medical documents (patientId or type provided) we strictly
      // enforce the allow-list. Non-medical uploads (avatars, free-form
      // notes) skip the allow-list but still reject known-dangerous
      // executables / HTML / scripts.
      const isMedical = !!patientId || !!type;
      const sniffed = detectMime(buffer);

      if (isMedical) {
        if (!sniffed || !ALLOWED_MIMES.has(sniffed)) {
          res.status(400).json({
            success: false,
            data: null,
            error: `File type not allowed (detected: ${sniffed ?? "unknown"})`,
          });
          return;
        }
      } else if (sniffed) {
        const blocked = new Set([
          "application/x-msdownload",
          "application/x-executable",
          "text/html",
          "application/x-sh",
        ]);
        if (blocked.has(sniffed)) {
          res.status(400).json({
            success: false,
            data: null,
            error: `File type not allowed (detected: ${sniffed})`,
          });
          return;
        }
      }

      const uuid = crypto.randomUUID();
      const safeName = sanitizeFilename(filename);
      const storedName = `${uuid}-${safeName}`;

      const stored = await uploadFile(buffer, storedName, sniffed || "application/octet-stream");
      const signedUrl = await getSignedDownloadUrl(stored.key);

      auditLog(req, "UPLOAD_FILE", "file", storedName, {
        patientId,
        type,
        size: buffer.length,
        sniffedMime: sniffed,
        storageProvider: isS3Enabled() ? "s3" : "local",
      }).catch(console.error);

      res.status(201).json({
        success: true,
        data: {
          filename: storedName,
          originalName: filename,
          filePath: stored.key,
          fileSize: buffer.length,
          mimeType: sniffed,
          signedUrl,
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ════════════════════════════════════════════════════════
// GET /api/v1/uploads/document/:documentId
// ════════════════════════════════════════════════════════
//
// Authenticated, row-level-authorized download for PatientDocument rows.
// Allowed: ADMIN | uploader | treating doctor | the patient themselves.
// Everyone else gets 403. Use this in preference to the legacy
// filename-based route for any medical file.
router.get(
  "/document/:documentId",
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const documentId = req.params.documentId;
      if (!req.user) {
        res.status(401).json({ success: false, data: null, error: "Unauthorized" });
        return;
      }
      const doc = await prisma.patientDocument.findUnique({
        where: { id: documentId },
        select: {
          id: true,
          patientId: true,
          uploadedBy: true,
          filePath: true,
          mimeType: true,
          title: true,
        },
      });
      if (!doc) {
        res.status(404).json({ success: false, data: null, error: "Document not found" });
        return;
      }
      const denied = await checkDocumentAccess(doc, req.user);
      if (denied) {
        res.status(denied.status).json({ success: false, data: null, error: denied.error });
        return;
      }

      auditLog(req, "DOWNLOAD_FILE", "patient_document", doc.id, {
        patientId: doc.patientId,
      }).catch(console.error);

      if (isS3Enabled()) {
        const url = await getSignedDownloadUrl(doc.filePath, 300);
        res.redirect(302, url);
        return;
      }

      // Local disk fallback
      const stored = path.basename(doc.filePath);
      const fullPath = path.join(UPLOAD_DIR, stored);
      if (!fullPath.startsWith(UPLOAD_DIR) || !fs.existsSync(fullPath)) {
        res.status(404).json({ success: false, data: null, error: "File missing on storage" });
        return;
      }
      if (doc.mimeType) res.type(doc.mimeType);
      res.sendFile(fullPath);
    } catch (err) {
      next(err);
    }
  }
);

// ════════════════════════════════════════════════════════
// GET /api/v1/uploads/document/:documentId/signed-url
// ════════════════════════════════════════════════════════
//
// Issues a short-lived signed URL for the document, after the same ACL
// check as GET /document/:documentId. Useful when the client wants to embed
// the URL in an <img> / <iframe> / share link without leaking the bearer
// token.
router.get(
  "/document/:documentId/signed-url",
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const documentId = req.params.documentId;
      if (!req.user) {
        res.status(401).json({ success: false, data: null, error: "Unauthorized" });
        return;
      }
      const doc = await prisma.patientDocument.findUnique({
        where: { id: documentId },
        select: { id: true, patientId: true, uploadedBy: true, filePath: true },
      });
      if (!doc) {
        res.status(404).json({ success: false, data: null, error: "Document not found" });
        return;
      }
      const denied = await checkDocumentAccess(doc, req.user);
      if (denied) {
        res.status(denied.status).json({ success: false, data: null, error: denied.error });
        return;
      }
      const ttl = Math.min(
        Math.max(parseInt(String(req.query.ttl ?? ""), 10) || DEFAULT_TTL_SECONDS, 30),
        60 * 60 // cap at 1 hour
      );
      const url = await getSignedDownloadUrl(doc.filePath, ttl);
      res.json({
        success: true,
        data: { url, expires: Math.floor(Date.now() / 1000) + ttl },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ════════════════════════════════════════════════════════
// GET /api/v1/uploads/:filename — legacy filename endpoint
// ════════════════════════════════════════════════════════
//
// Kept for backward compatibility with already-stored URLs and avatar /
// logo style non-medical files. Two access modes:
//
//   1. Authenticated bearer token (legacy behaviour) — returns the file.
//   2. Signed-URL with ?expires=…&sig=… (no auth required, but signature
//      must verify and not be expired).
//
// Future migration path: move medical PatientDocument downloads behind
// /document/:documentId only and drop this route.
router.get("/:filename", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const name = path.basename(req.params.filename);
    const fullPath = path.join(UPLOAD_DIR, name);
    if (!fullPath.startsWith(UPLOAD_DIR) || !fs.existsSync(fullPath)) {
      res.status(404).json({ success: false, data: null, error: "File not found" });
      return;
    }

    const expires = req.query.expires;
    const sig = req.query.sig;
    if (expires && sig) {
      const ok = verifySignature(`file:${name}`, expires as string, sig as string);
      if (!ok) {
        res.status(403).json({ success: false, data: null, error: "Invalid or expired signature" });
        return;
      }
      res.sendFile(fullPath);
      return;
    }

    // Fall back to bearer auth.
    return authenticate(req, res, () => {
      res.sendFile(fullPath);
    });
  } catch (err) {
    next(err);
  }
});

export { router as uploadsRouter };
