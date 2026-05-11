import { Router, Request, Response, NextFunction } from "express";
import { Prisma } from "@prisma/client";
import { tenantScopedPrisma as prisma } from "../services/tenant-prisma";
import { Role } from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";
import { auditLog } from "../middleware/audit";
import {
  analyzeSymptomTrends,
  type DayEntry,
  type DiaryEntry,
} from "../services/ai/symptom-diary";

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

const router = Router();
router.use(authenticate);

// #511 audit (file-level, 2026-05-09): every handler in this file applies
// `authorize(Role.PATIENT)` AND scopes Prisma queries through
// `getCallerPatient(req)` (self-self surface — patient.id is derived from
// req.user.userId, never trusted from URL/body). PATIENT-A cannot reach
// PATIENT-B's diary entries. Staff are excluded from this surface entirely.
// Verified-safe (criterion option c — getCallerPatient self-self).

/**
 * Resolve the Patient row for the authenticated user. Only PATIENT role users
 * have a 1:1 Patient record via `userId`.
 */
async function getCallerPatient(req: Request) {
  if (!req.user) return null;
  return prisma.patient.findFirst({
    where: { userId: req.user.userId },
    select: { id: true, userId: true },
  });
}

function parseEntries(raw: unknown): DiaryEntry[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const out: DiaryEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") return null;
    const anyItem = item as Record<string, unknown>;
    const symptom = typeof anyItem.symptom === "string" ? anyItem.symptom.trim() : "";
    const severityRaw = Number(anyItem.severity);
    if (!symptom || symptom.length === 0 || symptom.length > 100) return null;
    if (!Number.isFinite(severityRaw) || severityRaw < 1 || severityRaw > 10)
      return null;
    const notes =
      typeof anyItem.notes === "string" && anyItem.notes.length > 0
        ? anyItem.notes.slice(0, 500)
        : undefined;
    out.push({ symptom, severity: Math.round(severityRaw), notes });
  }
  return out;
}

// ── POST /api/v1/ai/symptom-diary ─────────────────────────────────────────────
// body: { symptomDate: ISO, entries: [{symptom, severity 1-10, notes?}] }

router.post(
  "/",
  authorize(Role.PATIENT),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { symptomDate, entries } = (req.body ?? {}) as {
        symptomDate?: string;
        entries?: unknown;
      };

      if (!symptomDate || Number.isNaN(Date.parse(symptomDate))) {
        res.status(400).json({
          success: false,
          data: null,
          error: "symptomDate must be a valid ISO date",
        });
        return;
      }

      const parsed = parseEntries(entries);
      if (!parsed) {
        res.status(400).json({
          success: false,
          data: null,
          error: "entries must be a non-empty array of { symptom, severity (1-10), notes? }",
        });
        return;
      }

      const patient = await getCallerPatient(req);
      if (!patient) {
        res.status(404).json({ success: false, data: null, error: "Patient profile not found" });
        return;
      }

      // Normalize to date-only so the unique constraint on
      // (patientId, symptomDate) works regardless of the time component.
      const d = new Date(symptomDate);
      d.setHours(0, 0, 0, 0);

      const record = await prisma.symptomDiaryEntry.upsert({
        where: {
          patientId_symptomDate: {
            patientId: patient.id,
            symptomDate: d,
          },
        },
        create: {
          patientId: patient.id,
          symptomDate: d,
          entries: parsed as any,
        },
        update: {
          entries: parsed as any,
          // Reset cached analysis — use Prisma.DbNull for JSON columns so
          // Prisma writes a SQL NULL instead of the JSON null literal.
          lastAnalysis: Prisma.DbNull,
          lastAnalysisAt: null,
        },
      });

      await auditLog(req, "AI_SYMPTOM_DIARY_WRITE", "SymptomDiaryEntry", record.id, {
        symptomCount: parsed.length,
      });

      res.status(201).json({ success: true, data: record, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// ── GET /api/v1/ai/symptom-diary ──────────────────────────────────────────────
// Returns last 90 days for the calling patient.

router.get(
  "/",
  authorize(Role.PATIENT),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const patient = await getCallerPatient(req);
      if (!patient) {
        res.status(404).json({ success: false, data: null, error: "Patient profile not found" });
        return;
      }

      const since = new Date();
      since.setDate(since.getDate() - 90);
      since.setHours(0, 0, 0, 0);

      const entries = await prisma.symptomDiaryEntry.findMany({
        where: {
          patientId: patient.id,
          symptomDate: { gte: since },
        },
        orderBy: { symptomDate: "desc" },
      });

      safeAudit(req, "AI_SYMPTOM_DIARY_READ", "SymptomDiaryEntry", undefined, {
        count: entries.length,
      });

      res.json({ success: true, data: entries, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// ── POST /api/v1/ai/symptom-diary/analyze ─────────────────────────────────────
// Runs trend analysis over the last 30 days and persists the result on the
// most recent entry.

router.post(
  "/analyze",
  authorize(Role.PATIENT),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const patient = await getCallerPatient(req);
      if (!patient) {
        res.status(404).json({ success: false, data: null, error: "Patient profile not found" });
        return;
      }

      const since = new Date();
      since.setDate(since.getDate() - 30);
      since.setHours(0, 0, 0, 0);

      const rows = await prisma.symptomDiaryEntry.findMany({
        where: {
          patientId: patient.id,
          symptomDate: { gte: since },
        },
        orderBy: { symptomDate: "asc" },
      });

      if (rows.length === 0) {
        res.status(400).json({
          success: false,
          data: null,
          error: "No diary entries in the last 30 days — log at least one day first",
        });
        return;
      }

      const days: DayEntry[] = rows.map((r: any) => ({
        symptomDate: r.symptomDate,
        entries: Array.isArray(r.entries) ? (r.entries as DiaryEntry[]) : [],
      }));

      const result = await analyzeSymptomTrends(days);

      // Persist on the most recent entry so the mobile UI can display it.
      const latest = rows[rows.length - 1];
      await prisma.symptomDiaryEntry.update({
        where: { id: latest.id },
        data: {
          lastAnalysis: result as any,
          lastAnalysisAt: new Date(),
        },
      });

      await auditLog(req, "AI_SYMPTOM_DIARY_ANALYZE", "SymptomDiaryEntry", latest.id, {
        daysAnalyzed: rows.length,
        followUpRecommended: result.followUpRecommended,
      });

      res.json({ success: true, data: result, error: null });
    } catch (err) {
      next(err);
    }
  }
);

export { router as aiSymptomDiaryRouter };
