import express, { Router, Request, Response, NextFunction } from "express";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { authenticate } from "../middleware/auth";
import { auditLog } from "../middleware/audit";

const router = Router();

// Allow oversize base64 uploads on this router only.
// The base Express JSON parser is 100 KB by default.
router.use(express.json({ limit: "25mb" }));
router.use(authenticate);

// Ensure the upload directory exists
const UPLOAD_DIR = path.join(process.cwd(), "uploads", "ehr");
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

function sanitizeFilename(name: string): string {
  const base = path.basename(name);
  return base.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 96);
}

/**
 * POST /api/v1/uploads
 * JSON body: { filename, base64Content, patientId?, type? }
 * Stores the decoded file under ./uploads/ehr/ and returns
 * the relative path the caller should persist on PatientDocument.filePath.
 */
router.post("/", async (req: Request, res: Response, next: NextFunction) => {
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

    const uuid = crypto.randomUUID();
    const safeName = sanitizeFilename(filename);
    const storedName = `${uuid}-${safeName}`;
    const fullPath = path.join(UPLOAD_DIR, storedName);
    fs.writeFileSync(fullPath, buffer);

    const relativePath = `uploads/ehr/${storedName}`;

    auditLog(req, "UPLOAD_FILE", "file", storedName, {
      patientId,
      type,
      size: buffer.length,
    }).catch(console.error);

    res.status(201).json({
      success: true,
      data: {
        filename: storedName,
        originalName: filename,
        filePath: relativePath,
        fileSize: buffer.length,
      },
      error: null,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/v1/uploads/:filename — serve a stored file.
 * Authenticated, but no row-level access check: paths contain a uuid so
 * they are unguessable, and filenames are enumerated only through the
 * authenticated documents API.
 */
router.get("/:filename", (req: Request, res: Response) => {
  const name = path.basename(req.params.filename);
  const fullPath = path.join(UPLOAD_DIR, name);
  if (!fullPath.startsWith(UPLOAD_DIR) || !fs.existsSync(fullPath)) {
    res.status(404).json({ success: false, data: null, error: "File not found" });
    return;
  }
  res.sendFile(fullPath);
});

export { router as uploadsRouter };
