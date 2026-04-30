import { Router, Request, Response, NextFunction } from "express";
// Multi-tenant wiring: `tenantScopedPrisma` is a Prisma $extends wrapper that
// auto-injects tenantId on create and auto-filters on read for the 20
// tenant-scoped models (see services/tenant-prisma.ts). We alias it to
// `prisma` so every existing call site keeps working without edits.
import { tenantScopedPrisma as prisma } from "../services/tenant-prisma";
import {
  Role,
  createOTSchema,
  updateOTSchema,
  scheduleSurgerySchema,
  updateSurgerySchema,
  completeSurgerySchema,
  cancelSurgerySchema,
  preOpChecklistSchema,
  intraOpTimingSchema,
  complicationsSchema,
  anesthesiaRecordSchema,
  bloodRequirementSchema,
  postOpObservationSchema,
  ssiReportSchema,
} from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { auditLog } from "../middleware/audit";

const router = Router();
router.use(authenticate);

// Issue #86 (Apr 2026): SCHEDULED surgeries whose scheduledAt is more than
// 30 minutes in the past should be reported as MISSED_SCHEDULE on read.
// The database enum doesn't include MISSED_SCHEDULE (no schema change for
// this fix) so we expose the derived flag as `effectiveStatus` and a boolean
// `isStaleSchedule` on every surgery payload. Frontend uses these to badge
// the row without needing to recompute the wall-clock comparison.
//
// Issue #160 (Apr 2026): the read-side flag is no longer enough — stale
// rows accumulate forever because nothing transitions them to a terminal
// state. The companion auto-cancel task in services/scheduled-tasks.ts
// imports {STALE_AUTO_CANCEL_AFTER_DAYS, autoCancelStaleScheduledSurgeries}
// from this file so the cutoff is co-located with the read-time grace.
export const STALE_SCHEDULE_GRACE_MS = 30 * 60 * 1000;
export const STALE_AUTO_CANCEL_AFTER_DAYS = 7;
function withStaleFlags<T extends { status: string; scheduledAt: Date | string }>(
  s: T
): T & { effectiveStatus: string; isStaleSchedule: boolean } {
  let isStale = false;
  if (s.status === "SCHEDULED") {
    const ms = new Date(s.scheduledAt).getTime();
    if (Number.isFinite(ms) && Date.now() - ms > STALE_SCHEDULE_GRACE_MS) {
      isStale = true;
    }
  }
  return {
    ...s,
    effectiveStatus: isStale ? "MISSED_SCHEDULE" : s.status,
    isStaleSchedule: isStale,
  };
}

// Generate next case number like SRG000001
async function nextCaseNumber(): Promise<string> {
  const last = await prisma.surgery.findFirst({
    orderBy: { caseNumber: "desc" },
    select: { caseNumber: true },
  });
  let n = 1;
  if (last?.caseNumber) {
    const m = last.caseNumber.match(/(\d+)$/);
    if (m) n = parseInt(m[1], 10) + 1;
  }
  return `SRG${String(n).padStart(6, "0")}`;
}

// ─── OPERATING THEATERS ─────────────────────────────────

// GET /api/v1/surgery/ots — list OTs
// Issue #174 (Apr 30 2026): OT (Operating Theater) catalog is admin/ops/clinical
// — explicitly exclude PATIENT (was previously readable to anyone authenticated).
router.get(
  "/ots",
  authorize(Role.ADMIN, Role.DOCTOR, Role.NURSE, Role.RECEPTION),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { includeInactive } = req.query;
      const where: Record<string, unknown> = {};
      if (includeInactive !== "true") where.isActive = true;

      const ots = await prisma.operatingTheater.findMany({
        where,
        orderBy: { name: "asc" },
      });

      res.json({ success: true, data: ots, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/v1/surgery/ots — create OT
router.post(
  "/ots",
  authorize(Role.ADMIN),
  validate(createOTSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const ot = await prisma.operatingTheater.create({
        data: req.body,
      });
      auditLog(req, "OT_CREATE", "operatingTheater", ot.id, {
        name: ot.name,
      }).catch(console.error);
      res.status(201).json({ success: true, data: ot, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// PATCH /api/v1/surgery/ots/:id — update OT
router.patch(
  "/ots/:id",
  authorize(Role.ADMIN),
  validate(updateOTSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const ot = await prisma.operatingTheater.update({
        where: { id: req.params.id },
        data: req.body,
      });
      auditLog(req, "OT_UPDATE", "operatingTheater", ot.id, req.body).catch(
        console.error
      );
      res.json({ success: true, data: ot, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/surgery/ots/:id/schedule?date=YYYY-MM-DD
// Issue #174: schedule reveals patient names + phone for every surgery.
router.get(
  "/ots/:id/schedule",
  authorize(Role.ADMIN, Role.DOCTOR, Role.NURSE, Role.RECEPTION),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const date = (req.query.date as string) || new Date().toISOString().split("T")[0];
      const start = new Date(`${date}T00:00:00.000Z`);
      const end = new Date(`${date}T23:59:59.999Z`);

      const surgeries = await prisma.surgery.findMany({
        where: {
          otId: req.params.id,
          scheduledAt: { gte: start, lte: end },
        },
        include: {
          patient: {
            include: { user: { select: { name: true, phone: true } } },
          },
          surgeon: { include: { user: { select: { name: true } } } },
          ot: true,
        },
        orderBy: { scheduledAt: "asc" },
      });

      res.json({ success: true, data: surgeries, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// ─── SURGERIES ──────────────────────────────────────────

// POST /api/v1/surgery — schedule a surgery
router.post(
  "/",
  authorize(Role.DOCTOR, Role.ADMIN),
  validate(scheduleSurgerySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const {
        patientId,
        surgeonId,
        otId,
        procedure,
        scheduledAt,
        durationMin,
        anaesthesiologist,
        assistants,
        preOpNotes,
        diagnosis,
        cost,
      } = req.body;

      const ot = await prisma.operatingTheater.findUnique({ where: { id: otId } });
      if (!ot) {
        res.status(404).json({
          success: false,
          data: null,
          error: "Operating theater not found",
        });
        return;
      }
      if (!ot.isActive) {
        res.status(409).json({
          success: false,
          data: null,
          error: "Operating theater is inactive",
        });
        return;
      }

      const caseNumber = await nextCaseNumber();

      const surgery = await prisma.surgery.create({
        data: {
          caseNumber,
          patientId,
          surgeonId,
          otId,
          procedure,
          scheduledAt: new Date(scheduledAt),
          durationMin,
          anaesthesiologist,
          assistants,
          preOpNotes,
          diagnosis,
          cost,
          status: "SCHEDULED",
        },
        include: {
          patient: {
            include: { user: { select: { name: true, phone: true } } },
          },
          surgeon: { include: { user: { select: { name: true } } } },
          ot: true,
        },
      });

      auditLog(req, "SURGERY_SCHEDULE", "surgery", surgery.id, {
        caseNumber,
        patientId,
        surgeonId,
        otId,
      }).catch(console.error);

      res.status(201).json({ success: true, data: surgery, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/surgery — list surgeries
router.get("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const {
      patientId,
      surgeonId,
      otId,
      status,
      from,
      to,
      page = "1",
      limit = "20",
    } = req.query;

    const skip = (parseInt(page as string) - 1) * parseInt(limit as string);
    const take = Math.min(parseInt(limit as string), 100);

    const where: Record<string, unknown> = {};
    if (patientId) where.patientId = patientId;
    if (surgeonId) where.surgeonId = surgeonId;
    if (otId) where.otId = otId;
    if (status) where.status = status;

    if (from || to) {
      const range: Record<string, Date> = {};
      if (from) range.gte = new Date(from as string);
      if (to) range.lte = new Date(to as string);
      where.scheduledAt = range;
    }

    // PATIENT role: scope to own patient record
    if (req.user!.role === Role.PATIENT) {
      const patient = await prisma.patient.findUnique({
        where: { userId: req.user!.userId },
      });
      if (!patient) {
        res.json({
          success: true,
          data: [],
          error: null,
          meta: { page: 1, limit: take, total: 0 },
        });
        return;
      }
      where.patientId = patient.id;
    }

    const [surgeries, total] = await Promise.all([
      prisma.surgery.findMany({
        where,
        include: {
          patient: {
            include: { user: { select: { name: true, phone: true } } },
          },
          surgeon: { include: { user: { select: { name: true } } } },
          ot: true,
        },
        skip,
        take,
        orderBy: { scheduledAt: "desc" },
      }),
      prisma.surgery.count({ where }),
    ]);

    res.json({
      success: true,
      data: surgeries.map((s) => withStaleFlags(s)),
      error: null,
      meta: { page: parseInt(page as string), limit: take, total },
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/surgery/:id
router.get(
  "/:id",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const surgery = await prisma.surgery.findUnique({
        where: { id: req.params.id },
        include: {
          patient: {
            include: {
              user: { select: { name: true, phone: true, email: true } },
            },
          },
          surgeon: {
            include: { user: { select: { name: true, email: true } } },
          },
          ot: true,
        },
      });

      if (!surgery) {
        res.status(404).json({
          success: false,
          data: null,
          error: "Surgery not found",
        });
        return;
      }

      res.json({ success: true, data: withStaleFlags(surgery), error: null });
    } catch (err) {
      next(err);
    }
  }
);

// PATCH /api/v1/surgery/:id — update
router.patch(
  "/:id",
  authorize(Role.DOCTOR, Role.ADMIN, Role.NURSE),
  validate(updateSurgerySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data: Record<string, unknown> = { ...req.body };
      if (req.body.scheduledAt) data.scheduledAt = new Date(req.body.scheduledAt);
      if (req.body.actualStartAt) data.actualStartAt = new Date(req.body.actualStartAt);
      if (req.body.actualEndAt) data.actualEndAt = new Date(req.body.actualEndAt);

      const surgery = await prisma.surgery.update({
        where: { id: req.params.id },
        data,
        include: {
          patient: {
            include: { user: { select: { name: true, phone: true } } },
          },
          surgeon: { include: { user: { select: { name: true } } } },
          ot: true,
        },
      });

      auditLog(req, "SURGERY_UPDATE", "surgery", surgery.id, req.body).catch(
        console.error
      );

      // Realtime: notify OT board + surgery list
      const io = req.app.get("io");
      if (io && req.body.status) {
        io.emit("surgery:status", {
          surgeryId: surgery.id,
          status: surgery.status,
          otId: surgery.otId,
        });
      }

      res.json({ success: true, data: surgery, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// PATCH /api/v1/surgery/:id/start — enforces pre-op checklist
router.patch(
  "/:id/start",
  authorize(Role.DOCTOR, Role.ADMIN, Role.NURSE),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const existing = await prisma.surgery.findUnique({
        where: { id: req.params.id },
      });
      if (!existing) {
        res.status(404).json({ success: false, data: null, error: "Surgery not found" });
        return;
      }

      const missing: string[] = [];
      if (!existing.consentSigned) missing.push("Consent signed");
      if (!existing.npoSince) missing.push("NPO (nil per oral) start time");
      if (!existing.allergiesVerified) missing.push("Allergies verified");
      if (!existing.siteMarked) missing.push("Surgical site marked");

      const overrideChecklist = req.body?.overrideChecklist === true;
      if (missing.length > 0 && !overrideChecklist) {
        res.status(400).json({
          success: false,
          data: null,
          error: "Pre-op checklist incomplete",
          missing,
        });
        return;
      }

      // Identify previous surgery in same OT (for turnaround tracking)
      const prev = await prisma.surgery.findFirst({
        where: {
          otId: existing.otId,
          id: { not: existing.id },
          actualEndAt: { not: null },
          status: "COMPLETED",
        },
        orderBy: { actualEndAt: "desc" },
      });

      const surgery = await prisma.surgery.update({
        where: { id: req.params.id },
        data: {
          status: "IN_PROGRESS",
          actualStartAt: new Date(),
          previousSurgeryId: prev?.id ?? null,
        },
        include: {
          patient: {
            include: { user: { select: { name: true, phone: true } } },
          },
          surgeon: { include: { user: { select: { name: true } } } },
          ot: true,
        },
      });

      auditLog(req, "SURGERY_START", "surgery", surgery.id, {
        caseNumber: surgery.caseNumber,
        overrideChecklist,
        previousSurgeryId: prev?.id ?? null,
      }).catch(console.error);

      const io = req.app.get("io");
      if (io) {
        io.emit("surgery:status", {
          surgeryId: surgery.id,
          status: "IN_PROGRESS",
          otId: surgery.otId,
        });
      }

      res.json({ success: true, data: surgery, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// PATCH /api/v1/surgery/:id/complete
router.patch(
  "/:id/complete",
  authorize(Role.DOCTOR, Role.ADMIN),
  validate(completeSurgerySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Enforce post-op notes
      const postOp: string | undefined = req.body.postOpNotes;
      if (!postOp || postOp.trim().length === 0) {
        res.status(400).json({
          success: false,
          data: null,
          error: "postOpNotes are required before completing a surgery",
        });
        return;
      }
      const data: Record<string, unknown> = {
        status: "COMPLETED",
        actualEndAt: new Date(),
        postOpNotes: postOp,
        postOpChecklistBy: req.user!.userId,
      };
      if (req.body.diagnosis !== undefined) data.diagnosis = req.body.diagnosis;
      if (typeof req.body.spongeCountCorrect === "boolean")
        data.sponge_countCorrect = req.body.spongeCountCorrect;
      if (typeof req.body.instrumentCountCorrect === "boolean")
        data.instrumentCountCorrect = req.body.instrumentCountCorrect;
      if (typeof req.body.specimenLabeled === "boolean")
        data.specimenLabeled = req.body.specimenLabeled;
      if (typeof req.body.patientStable === "boolean")
        data.patientStable = req.body.patientStable;

      const surgery = await prisma.surgery.update({
        where: { id: req.params.id },
        data,
        include: {
          patient: {
            include: { user: { select: { name: true, phone: true } } },
          },
          surgeon: { include: { user: { select: { name: true } } } },
          ot: true,
        },
      });

      auditLog(req, "SURGERY_COMPLETE", "surgery", surgery.id, {
        caseNumber: surgery.caseNumber,
      }).catch(console.error);

      const io = req.app.get("io");
      if (io) {
        io.emit("surgery:status", {
          surgeryId: surgery.id,
          status: "COMPLETED",
          otId: surgery.otId,
        });
      }

      res.json({ success: true, data: surgery, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// PATCH /api/v1/surgery/:id/cancel
router.patch(
  "/:id/cancel",
  authorize(Role.DOCTOR, Role.ADMIN),
  validate(cancelSurgerySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const existing = await prisma.surgery.findUnique({
        where: { id: req.params.id },
      });
      if (!existing) {
        res.status(404).json({
          success: false,
          data: null,
          error: "Surgery not found",
        });
        return;
      }

      const existingNotes = existing.postOpNotes ?? "";
      const cancelNote = `[CANCELLED] ${req.body.reason}`;
      const postOpNotes = existingNotes
        ? `${existingNotes}\n${cancelNote}`
        : cancelNote;

      const surgery = await prisma.surgery.update({
        where: { id: req.params.id },
        data: {
          status: "CANCELLED",
          postOpNotes,
        },
        include: {
          patient: {
            include: { user: { select: { name: true, phone: true } } },
          },
          surgeon: { include: { user: { select: { name: true } } } },
          ot: true,
        },
      });

      auditLog(req, "SURGERY_CANCEL", "surgery", surgery.id, {
        caseNumber: surgery.caseNumber,
        reason: req.body.reason,
      }).catch(console.error);

      res.json({ success: true, data: surgery, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// PATCH /api/v1/surgery/:id/preop — update pre-op checklist
router.patch(
  "/:id/preop",
  authorize(Role.ADMIN, Role.DOCTOR, Role.NURSE),
  validate(preOpChecklistSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data: Record<string, unknown> = {};
      if (typeof req.body.consentSigned === "boolean") {
        data.consentSigned = req.body.consentSigned;
        if (req.body.consentSigned) data.consentSignedAt = new Date();
      }
      if (req.body.npoSince) data.npoSince = new Date(req.body.npoSince);
      if (typeof req.body.allergiesVerified === "boolean")
        data.allergiesVerified = req.body.allergiesVerified;
      if (typeof req.body.antibioticsGiven === "boolean") {
        data.antibioticsGiven = req.body.antibioticsGiven;
        if (req.body.antibioticsGiven && req.body.antibioticsAt)
          data.antibioticsAt = new Date(req.body.antibioticsAt);
        else if (req.body.antibioticsGiven)
          data.antibioticsAt = new Date();
      }
      if (typeof req.body.siteMarked === "boolean") data.siteMarked = req.body.siteMarked;
      if (typeof req.body.bloodReserved === "boolean")
        data.bloodReserved = req.body.bloodReserved;
      data.preOpChecklistBy = req.user!.userId;

      const surgery = await prisma.surgery.update({
        where: { id: req.params.id },
        data,
        include: {
          patient: { include: { user: { select: { name: true } } } },
          surgeon: { include: { user: { select: { name: true } } } },
          ot: true,
        },
      });

      auditLog(req, "PREOP_CHECKLIST_UPDATE", "surgery", surgery.id, data).catch(
        console.error
      );
      res.json({ success: true, data: surgery, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// PATCH /api/v1/surgery/:id/intraop — intra-op timings
router.patch(
  "/:id/intraop",
  authorize(Role.ADMIN, Role.DOCTOR, Role.NURSE),
  validate(intraOpTimingSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data: Record<string, unknown> = {};
      for (const k of [
        "anesthesiaStartAt",
        "anesthesiaEndAt",
        "incisionAt",
        "closureAt",
      ]) {
        if (req.body[k]) data[k] = new Date(req.body[k]);
      }
      const surgery = await prisma.surgery.update({
        where: { id: req.params.id },
        data,
      });
      auditLog(req, "INTRAOP_TIMING_UPDATE", "surgery", surgery.id, data).catch(
        console.error
      );
      res.json({ success: true, data: surgery, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// PATCH /api/v1/surgery/:id/complications
router.patch(
  "/:id/complications",
  authorize(Role.ADMIN, Role.DOCTOR),
  validate(complicationsSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const surgery = await prisma.surgery.update({
        where: { id: req.params.id },
        data: {
          complications: req.body.complications,
          complicationSeverity: req.body.complicationSeverity,
          bloodLossMl: req.body.bloodLossMl,
        },
      });
      auditLog(req, "SURGERY_COMPLICATION_CREATE", "surgery", surgery.id, {
        severity: req.body.complicationSeverity,
      }).catch(console.error);
      res.json({ success: true, data: surgery, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/surgery/ots/:id/utilization?from=&to=
// Daily utilization (hours used / available) per day in range
router.get(
  "/ots/:id/utilization",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const from = req.query.from
        ? new Date(req.query.from as string)
        : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const to = req.query.to ? new Date(req.query.to as string) : new Date();

      const ot = await prisma.operatingTheater.findUnique({
        where: { id: req.params.id },
      });
      if (!ot) {
        res.status(404).json({ success: false, data: null, error: "OT not found" });
        return;
      }

      const surgeries = await prisma.surgery.findMany({
        where: {
          otId: req.params.id,
          scheduledAt: { gte: from, lte: to },
          status: { in: ["COMPLETED", "IN_PROGRESS"] as const },
        },
        select: {
          id: true,
          caseNumber: true,
          procedure: true,
          scheduledAt: true,
          durationMin: true,
          actualStartAt: true,
          actualEndAt: true,
        },
      });

      // Group by date (YYYY-MM-DD)
      const byDay = new Map<string, { hoursUsed: number; caseCount: number }>();
      for (const s of surgeries) {
        const day = (s.actualStartAt ?? s.scheduledAt).toISOString().slice(0, 10);
        let hours = 0;
        if (s.actualStartAt && s.actualEndAt) {
          hours =
            (s.actualEndAt.getTime() - s.actualStartAt.getTime()) /
            (60 * 60 * 1000);
        } else if (s.durationMin) {
          hours = s.durationMin / 60;
        }
        const cur = byDay.get(day) ?? { hoursUsed: 0, caseCount: 0 };
        cur.hoursUsed += hours;
        cur.caseCount += 1;
        byDay.set(day, cur);
      }

      const dailyAvailable = 12; // 12 operating hours per day standard
      const utilization = Array.from(byDay.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, v]) => ({
          date,
          hoursUsed: Math.round(v.hoursUsed * 10) / 10,
          caseCount: v.caseCount,
          utilizationPct: Math.min(
            100,
            Math.round((v.hoursUsed / dailyAvailable) * 100)
          ),
        }));

      res.json({
        success: true,
        data: {
          otId: ot.id,
          otName: ot.name,
          from,
          to,
          dailyAvailableHours: dailyAvailable,
          utilization,
          totalCases: surgeries.length,
          totalHoursUsed:
            Math.round(
              utilization.reduce((acc, d) => acc + d.hoursUsed, 0) * 10
            ) / 10,
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/surgery/ots/:id/turnaround?date=YYYY-MM-DD — OT turnaround time
// For each pair of sequential completed surgeries that day, measure gap
// between prev.actualEndAt and next.actualStartAt
router.get(
  "/ots/:id/turnaround",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const date = (req.query.date as string) || new Date().toISOString().split("T")[0];
      const start = new Date(`${date}T00:00:00.000Z`);
      const end = new Date(`${date}T23:59:59.999Z`);

      const surgeries = await prisma.surgery.findMany({
        where: {
          otId: req.params.id,
          actualStartAt: { gte: start, lte: end },
        },
        orderBy: { actualStartAt: "asc" },
        select: {
          id: true,
          caseNumber: true,
          actualStartAt: true,
          actualEndAt: true,
          previousSurgeryId: true,
        },
      });

      const gaps: Array<{
        fromCase: string;
        toCase: string;
        gapMinutes: number;
      }> = [];
      for (let i = 1; i < surgeries.length; i++) {
        const prev = surgeries[i - 1];
        const cur = surgeries[i];
        if (prev.actualEndAt && cur.actualStartAt) {
          const gap = (cur.actualStartAt.getTime() - prev.actualEndAt.getTime()) / 60000;
          if (gap >= 0) {
            gaps.push({
              fromCase: prev.caseNumber,
              toCase: cur.caseNumber,
              gapMinutes: Math.round(gap),
            });
          }
        }
      }
      const avg =
        gaps.length > 0
          ? Math.round(gaps.reduce((s, g) => s + g.gapMinutes, 0) / gaps.length)
          : 0;

      res.json({
        success: true,
        data: {
          otId: req.params.id,
          date,
          surgeryCount: surgeries.length,
          gaps,
          averageTurnaroundMinutes: avg,
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─── ANESTHESIA RECORD ──────────────────────────────────

// POST /api/v1/surgery/:id/anesthesia-record — create/update
router.post(
  "/:id/anesthesia-record",
  authorize(Role.ADMIN, Role.DOCTOR, Role.NURSE),
  validate(anesthesiaRecordSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const surgery = await prisma.surgery.findUnique({
        where: { id: req.params.id },
        select: { id: true },
      });
      if (!surgery) {
        res.status(404).json({ success: false, data: null, error: "Surgery not found" });
        return;
      }

      const data: Record<string, unknown> = {
        anesthetist: req.body.anesthetist,
        anesthesiaType: req.body.anesthesiaType,
        inductionAt: req.body.inductionAt ? new Date(req.body.inductionAt) : null,
        extubationAt: req.body.extubationAt ? new Date(req.body.extubationAt) : null,
        agents: req.body.agents ?? null,
        vitalsLog: req.body.vitalsLog ?? null,
        ivFluids: req.body.ivFluids ?? null,
        bloodLossMl: req.body.bloodLossMl ?? null,
        urineOutputMl: req.body.urineOutputMl ?? null,
        complications: req.body.complications,
        recoveryNotes: req.body.recoveryNotes,
        performedBy: req.user!.userId,
      };

      const record = await prisma.anesthesiaRecord.upsert({
        where: { surgeryId: req.params.id },
        create: { surgeryId: req.params.id, ...data } as never,
        update: data as never,
      });

      auditLog(req, "ANESTHESIA_RECORD_UPSERT", "anesthesiaRecord", record.id, {
        surgeryId: req.params.id,
      }).catch(console.error);

      res.status(201).json({ success: true, data: record, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/surgery/:id/anesthesia-record
router.get(
  "/:id/anesthesia-record",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const record = await prisma.anesthesiaRecord.findUnique({
        where: { surgeryId: req.params.id },
      });
      res.json({ success: true, data: record, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// ─── BLOOD REQUIREMENT CROSS-CHECK ──────────────────────

// Map surgery request component names to BloodComponent enum values
const BLOOD_COMP_MAP: Record<string, string[]> = {
  A_POS: ["A_POS", "A_NEG", "O_POS", "O_NEG"],
  A_NEG: ["A_NEG", "O_NEG"],
  B_POS: ["B_POS", "B_NEG", "O_POS", "O_NEG"],
  B_NEG: ["B_NEG", "O_NEG"],
  AB_POS: ["A_POS", "A_NEG", "B_POS", "B_NEG", "AB_POS", "AB_NEG", "O_POS", "O_NEG"],
  AB_NEG: ["A_NEG", "B_NEG", "AB_NEG", "O_NEG"],
  O_POS: ["O_POS", "O_NEG"],
  O_NEG: ["O_NEG"],
};

// Convert Patient.bloodGroup string (e.g. "O+") to BloodGroupType enum format
function normalizeBloodGroup(bg?: string | null): string | null {
  if (!bg) return null;
  const cleaned = bg.trim().toUpperCase().replace(/\s+/g, "");
  const map: Record<string, string> = {
    "A+": "A_POS", "A-": "A_NEG",
    "B+": "B_POS", "B-": "B_NEG",
    "AB+": "AB_POS", "AB-": "AB_NEG",
    "O+": "O_POS", "O-": "O_NEG",
    A_POS: "A_POS", A_NEG: "A_NEG",
    B_POS: "B_POS", B_NEG: "B_NEG",
    AB_POS: "AB_POS", AB_NEG: "AB_NEG",
    O_POS: "O_POS", O_NEG: "O_NEG",
  };
  return map[cleaned] ?? null;
}

// POST /api/v1/surgery/:id/blood-requirement
router.post(
  "/:id/blood-requirement",
  authorize(Role.ADMIN, Role.DOCTOR, Role.NURSE),
  validate(bloodRequirementSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const surgery = await prisma.surgery.findUnique({
        where: { id: req.params.id },
        include: { patient: true },
      });
      if (!surgery) {
        res.status(404).json({ success: false, data: null, error: "Surgery not found" });
        return;
      }
      const patientGroup = normalizeBloodGroup(surgery.patient.bloodGroup);
      if (!patientGroup) {
        res.status(400).json({
          success: false,
          data: null,
          error: "Patient blood group not set or invalid",
        });
        return;
      }

      const compatibleGroups = BLOOD_COMP_MAP[patientGroup] || [patientGroup];
      const needed = req.body.units as number;
      const component = req.body.component as string;
      const autoReserve = req.body.autoReserve !== false;

      // Find available units of matching component & compatible group, nearest expiry first
      const units = await prisma.bloodUnit.findMany({
        where: {
          status: "AVAILABLE",
          component: component as never,
          bloodGroup: { in: compatibleGroups as never },
          expiresAt: { gt: new Date() },
        },
        orderBy: { expiresAt: "asc" },
        take: needed,
      });

      const available = units.length;
      const shortfall = Math.max(0, needed - available);

      let reservedUnits: typeof units = [];
      if (autoReserve && available > 0) {
        const reservedUntil = new Date(Date.now() + 24 * 60 * 60 * 1000);
        await prisma.bloodUnit.updateMany({
          where: { id: { in: units.map((u) => u.id) } },
          data: {
            status: "RESERVED",
            reservedUntil,
            reservedBy: req.user!.userId,
          },
        });
        reservedUnits = units;

        // Mark on surgery if reservation at least partly fulfills
        if (available >= needed && !surgery.bloodReserved) {
          await prisma.surgery.update({
            where: { id: surgery.id },
            data: { bloodReserved: true },
          });
        }
      }

      auditLog(req, "SURGERY_BLOOD_REQ_CHECK", "surgery", surgery.id, {
        component,
        needed,
        available,
        shortfall,
        autoReserved: autoReserve ? available : 0,
      }).catch(console.error);

      res.json({
        success: true,
        data: {
          patientBloodGroup: patientGroup,
          compatibleGroups,
          component,
          unitsRequested: needed,
          unitsAvailable: available,
          shortfall,
          canProceed: shortfall === 0,
          reserved: reservedUnits.map((u) => ({
            id: u.id,
            unitNumber: u.unitNumber,
            bloodGroup: u.bloodGroup,
            expiresAt: u.expiresAt,
          })),
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─── POST-OP OBSERVATIONS (PACU) ────────────────────────

// POST /api/v1/surgery/:id/observations
router.post(
  "/:id/observations",
  authorize(Role.ADMIN, Role.DOCTOR, Role.NURSE),
  validate(postOpObservationSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const surgery = await prisma.surgery.findUnique({
        where: { id: req.params.id },
        select: { id: true },
      });
      if (!surgery) {
        res.status(404).json({ success: false, data: null, error: "Surgery not found" });
        return;
      }

      const obs = await prisma.postOpObservation.create({
        data: {
          surgeryId: req.params.id,
          bpSystolic: req.body.bpSystolic,
          bpDiastolic: req.body.bpDiastolic,
          pulse: req.body.pulse,
          spO2: req.body.spO2,
          painScore: req.body.painScore,
          consciousness: req.body.consciousness,
          nausea: req.body.nausea ?? false,
          notes: req.body.notes,
          observedBy: req.user!.userId,
        },
      });

      auditLog(req, "POSTOP_OBSERVATION_CREATE", "postOpObservation", obs.id, {
        surgeryId: req.params.id,
      }).catch(console.error);

      res.status(201).json({ success: true, data: obs, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/surgery/:id/observations
router.get(
  "/:id/observations",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const rows = await prisma.postOpObservation.findMany({
        where: { surgeryId: req.params.id },
        orderBy: { observedAt: "asc" },
      });
      res.json({ success: true, data: rows, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// ─── SSI REPORT ─────────────────────────────────────────

// PATCH /api/v1/surgery/:id/ssi-report
router.patch(
  "/:id/ssi-report",
  authorize(Role.ADMIN, Role.DOCTOR),
  validate(ssiReportSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const surgery = await prisma.surgery.update({
        where: { id: req.params.id },
        data: {
          ssiDetected: true,
          ssiType: req.body.ssiType,
          ssiDetectedDate: new Date(req.body.detectedDate),
          ssiTreatment: req.body.treatment,
        },
      });
      auditLog(req, "SSI_REPORT", "surgery", surgery.id, {
        ssiType: req.body.ssiType,
      }).catch(console.error);
      res.json({ success: true, data: surgery, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/surgery/analytics/ssi-rate
router.get(
  "/analytics/ssi-rate",
  authorize(Role.ADMIN, Role.DOCTOR),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const from = req.query.from
        ? new Date(req.query.from as string)
        : new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
      const to = req.query.to ? new Date(req.query.to as string) : new Date();

      const surgeries = await prisma.surgery.findMany({
        where: {
          status: "COMPLETED",
          actualEndAt: { gte: from, lte: to },
        },
        select: {
          id: true,
          caseNumber: true,
          procedure: true,
          ssiDetected: true,
          ssiType: true,
          ssiDetectedDate: true,
        },
      });

      const total = surgeries.length;
      const ssiCases = surgeries.filter((s) => s.ssiDetected);
      const byType: Record<string, number> = {
        SUPERFICIAL: 0,
        DEEP: 0,
        ORGAN_SPACE: 0,
      };
      ssiCases.forEach((s) => {
        if (s.ssiType && byType[s.ssiType] !== undefined) byType[s.ssiType] += 1;
      });

      res.json({
        success: true,
        data: {
          from,
          to,
          totalSurgeries: total,
          ssiCount: ssiCases.length,
          ssiRate: total > 0 ? +((ssiCases.length / total) * 100).toFixed(2) : 0,
          byType,
          cases: ssiCases,
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

export { router as surgeryRouter };
