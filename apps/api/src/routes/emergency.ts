import { Router, Request, Response, NextFunction } from "express";
import { prisma } from "@medcore/db";
import {
  Role,
  createEmergencyCaseSchema,
  triageSchema,
  assignEmergencyDoctorSchema,
  updateEmergencyStatusSchema,
  mlcDetailsSchema,
  erTreatmentOrderSchema,
  erToAdmissionSchema,
  massCasualtySchema,
} from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { auditLog } from "../middleware/audit";

const router = Router();
router.use(authenticate);

async function nextCaseNumber(): Promise<string> {
  const last = await prisma.emergencyCase.findFirst({
    orderBy: { caseNumber: "desc" },
    select: { caseNumber: true },
  });
  let n = 1;
  if (last?.caseNumber) {
    const m = last.caseNumber.match(/(\d+)$/);
    if (m) n = parseInt(m[1], 10) + 1;
  }
  return `ER${String(n).padStart(6, "0")}`;
}

const CLOSED_STATUSES: (
  | "DISCHARGED"
  | "TRANSFERRED"
  | "LEFT_WITHOUT_BEING_SEEN"
  | "DECEASED"
)[] = ["DISCHARGED", "TRANSFERRED", "LEFT_WITHOUT_BEING_SEEN", "DECEASED"];

// POST /api/v1/emergency/cases — register
router.post(
  "/cases",
  authorize(Role.ADMIN, Role.NURSE, Role.RECEPTION, Role.DOCTOR),
  validate(createEmergencyCaseSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const {
        patientId,
        unknownName,
        unknownAge,
        unknownGender,
        arrivalMode,
        chiefComplaint,
      } = req.body;

      if (patientId) {
        const patient = await prisma.patient.findUnique({ where: { id: patientId } });
        if (!patient) {
          res.status(404).json({ success: false, data: null, error: "Patient not found" });
          return;
        }
      } else if (!unknownName) {
        res.status(400).json({
          success: false,
          data: null,
          error: "Either patientId or unknownName is required",
        });
        return;
      }

      const caseNumber = await nextCaseNumber();

      // Detect repeat visit within 72h
      let isRepeatVisit = false;
      if (patientId) {
        const ago72 = new Date(Date.now() - 72 * 60 * 60 * 1000);
        const prev = await prisma.emergencyCase.findFirst({
          where: {
            patientId,
            arrivedAt: { gte: ago72 },
          },
        });
        if (prev) isRepeatVisit = true;
      }

      const emergencyCase = await prisma.emergencyCase.create({
        data: {
          caseNumber,
          patientId: patientId || null,
          unknownName,
          unknownAge,
          unknownGender,
          arrivalMode,
          chiefComplaint,
          arrivedAt: new Date(),
          status: "WAITING",
          isRepeatVisit,
        },
        include: {
          patient: { include: { user: { select: { name: true, phone: true } } } },
          attendingDoctor: { include: { user: { select: { name: true } } } },
        },
      });

      auditLog(req, "REGISTER_EMERGENCY_CASE", "emergencyCase", emergencyCase.id, {
        caseNumber,
        patientId: patientId || null,
      }).catch(console.error);

      res.status(201).json({ success: true, data: emergencyCase, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/emergency/cases — list
router.get("/cases", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const {
      status,
      triageLevel,
      from,
      to,
      page = "1",
      limit = "20",
      includeClosed,
    } = req.query;
    const skip = (parseInt(page as string) - 1) * parseInt(limit as string);
    const take = Math.min(parseInt(limit as string), 100);

    const where: Record<string, unknown> = {};
    if (status) where.status = status;
    if (triageLevel) where.triageLevel = triageLevel;
    if (from || to) {
      const range: Record<string, Date> = {};
      if (from) range.gte = new Date(from as string);
      if (to) range.lte = new Date(to as string);
      where.arrivedAt = range;
    }
    if (!status && !includeClosed) {
      where.status = { notIn: CLOSED_STATUSES };
    }

    const [cases, total] = await Promise.all([
      prisma.emergencyCase.findMany({
        where,
        include: {
          patient: { include: { user: { select: { name: true, phone: true } } } },
          attendingDoctor: { include: { user: { select: { name: true } } } },
        },
        skip,
        take,
        orderBy: [{ triageLevel: "asc" }, { arrivedAt: "asc" }],
      }),
      prisma.emergencyCase.count({ where }),
    ]);

    res.json({
      success: true,
      data: cases,
      error: null,
      meta: { page: parseInt(page as string), limit: take, total },
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/emergency/cases/active — currently in ER
router.get(
  "/cases/active",
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const cases = await prisma.emergencyCase.findMany({
        where: { status: { notIn: CLOSED_STATUSES } },
        include: {
          patient: { include: { user: { select: { name: true, phone: true } } } },
          attendingDoctor: { include: { user: { select: { name: true } } } },
        },
        orderBy: [{ arrivedAt: "asc" }],
      });
      res.json({ success: true, data: cases, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/emergency/stats
router.get(
  "/stats",
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const active = await prisma.emergencyCase.findMany({
        where: { status: { notIn: CLOSED_STATUSES } },
        select: {
          triageLevel: true,
          arrivedAt: true,
          seenAt: true,
          status: true,
        },
      });

      const byTriage: Record<string, number> = {
        RESUSCITATION: 0,
        EMERGENT: 0,
        URGENT: 0,
        LESS_URGENT: 0,
        NON_URGENT: 0,
        UNTRIAGED: 0,
      };
      let waitingCount = 0;
      let totalWaitMs = 0;
      let waitedSamples = 0;
      const now = Date.now();

      for (const c of active) {
        if (c.triageLevel) byTriage[c.triageLevel]++;
        else byTriage.UNTRIAGED++;

        if (c.status === "WAITING" || c.status === "TRIAGED") {
          waitingCount++;
          totalWaitMs += now - new Date(c.arrivedAt).getTime();
          waitedSamples++;
        }
      }

      const avgWaitMin =
        waitedSamples > 0 ? Math.round(totalWaitMs / waitedSamples / 60000) : 0;

      // Bed availability from beds model
      const availableBeds = await prisma.bed.count({
        where: { status: "AVAILABLE" },
      });

      // Door-to-doctor time (last 24h closed cases with seenAt)
      const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const seenCases = await prisma.emergencyCase.findMany({
        where: { seenAt: { not: null }, arrivedAt: { gte: since24h } },
        select: { arrivedAt: true, seenAt: true },
      });
      let doorToDoctorTotalMs = 0;
      for (const c of seenCases) {
        if (c.seenAt)
          doorToDoctorTotalMs +=
            new Date(c.seenAt).getTime() - new Date(c.arrivedAt).getTime();
      }
      const avgDoorToDoctorMin =
        seenCases.length > 0
          ? Math.round(doorToDoctorTotalMs / seenCases.length / 60000)
          : 0;

      // MLC & repeat counts (last 24h)
      const [mlcCount, repeatCount] = await Promise.all([
        prisma.emergencyCase.count({
          where: { isMLC: true, arrivedAt: { gte: since24h } },
        }),
        prisma.emergencyCase.count({
          where: { isRepeatVisit: true, arrivedAt: { gte: since24h } },
        }),
      ]);

      res.json({
        success: true,
        data: {
          totalActive: active.length,
          totalWaiting: waitingCount,
          byTriage,
          avgWaitMin,
          availableBeds,
          avgDoorToDoctorMin,
          mlcCount24h: mlcCount,
          repeatVisitCount24h: repeatCount,
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/emergency/cases/:id
router.get(
  "/cases/:id",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const ecase = await prisma.emergencyCase.findUnique({
        where: { id: req.params.id },
        include: {
          patient: {
            include: {
              user: { select: { name: true, phone: true, email: true } },
            },
          },
          attendingDoctor: {
            include: { user: { select: { name: true } } },
          },
        },
      });
      if (!ecase) {
        res.status(404).json({ success: false, data: null, error: "Case not found" });
        return;
      }
      res.json({ success: true, data: ecase, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// PATCH /api/v1/emergency/cases/:id/triage
router.patch(
  "/cases/:id/triage",
  authorize(Role.ADMIN, Role.NURSE, Role.DOCTOR),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = { ...req.body, caseId: req.params.id };
      const parsed = triageSchema.safeParse(body);
      if (!parsed.success) {
        res.status(400).json({
          success: false,
          data: null,
          error: "Validation failed",
          details: parsed.error.flatten(),
        });
        return;
      }

      const existing = await prisma.emergencyCase.findUnique({
        where: { id: req.params.id },
      });
      if (!existing) {
        res.status(404).json({ success: false, data: null, error: "Case not found" });
        return;
      }

      const updated = await prisma.emergencyCase.update({
        where: { id: req.params.id },
        data: {
          triageLevel: parsed.data.triageLevel,
          triagedAt: new Date(),
          triagedBy: req.user!.userId,
          vitalsBP: parsed.data.vitalsBP,
          vitalsPulse: parsed.data.vitalsPulse,
          vitalsResp: parsed.data.vitalsResp,
          vitalsSpO2: parsed.data.vitalsSpO2,
          vitalsTemp: parsed.data.vitalsTemp,
          glasgowComa: parsed.data.glasgowComa,
          mewsScore: parsed.data.mewsScore,
          status: existing.status === "WAITING" ? "TRIAGED" : existing.status,
        },
        include: {
          patient: { include: { user: { select: { name: true, phone: true } } } },
          attendingDoctor: { include: { user: { select: { name: true } } } },
        },
      });

      auditLog(req, "TRIAGE_EMERGENCY_CASE", "emergencyCase", updated.id, {
        triageLevel: parsed.data.triageLevel,
      }).catch(console.error);

      res.json({ success: true, data: updated, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// PATCH /api/v1/emergency/cases/:id/assign
router.patch(
  "/cases/:id/assign",
  authorize(Role.ADMIN, Role.DOCTOR, Role.NURSE, Role.RECEPTION),
  validate(assignEmergencyDoctorSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const existing = await prisma.emergencyCase.findUnique({
        where: { id: req.params.id },
      });
      if (!existing) {
        res.status(404).json({ success: false, data: null, error: "Case not found" });
        return;
      }

      const doctor = await prisma.doctor.findUnique({
        where: { id: req.body.attendingDoctorId },
      });
      if (!doctor) {
        res.status(404).json({ success: false, data: null, error: "Doctor not found" });
        return;
      }

      const updated = await prisma.emergencyCase.update({
        where: { id: req.params.id },
        data: {
          attendingDoctorId: req.body.attendingDoctorId,
          seenAt: existing.seenAt ?? new Date(),
          status: "IN_TREATMENT",
        },
        include: {
          patient: { include: { user: { select: { name: true, phone: true } } } },
          attendingDoctor: { include: { user: { select: { name: true } } } },
        },
      });

      auditLog(req, "ASSIGN_EMERGENCY_DOCTOR", "emergencyCase", updated.id, {
        doctorId: req.body.attendingDoctorId,
      }).catch(console.error);

      res.json({ success: true, data: updated, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// PATCH /api/v1/emergency/cases/:id/close
router.patch(
  "/cases/:id/close",
  authorize(Role.ADMIN, Role.DOCTOR),
  validate(updateEmergencyStatusSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const existing = await prisma.emergencyCase.findUnique({
        where: { id: req.params.id },
      });
      if (!existing) {
        res.status(404).json({ success: false, data: null, error: "Case not found" });
        return;
      }

      const terminal = [
        "DISCHARGED",
        "ADMITTED",
        "TRANSFERRED",
        "LEFT_WITHOUT_BEING_SEEN",
        "DECEASED",
      ];
      if (!terminal.includes(req.body.status)) {
        res.status(400).json({
          success: false,
          data: null,
          error: "Close requires a terminal status (DISCHARGED, ADMITTED, TRANSFERRED, LEFT_WITHOUT_BEING_SEEN, DECEASED)",
        });
        return;
      }

      const updated = await prisma.emergencyCase.update({
        where: { id: req.params.id },
        data: {
          status: req.body.status,
          disposition: req.body.disposition,
          outcomeNotes: req.body.outcomeNotes,
          attendingDoctorId:
            req.body.attendingDoctorId ?? existing.attendingDoctorId,
          closedAt: new Date(),
        },
        include: {
          patient: { include: { user: { select: { name: true, phone: true } } } },
          attendingDoctor: { include: { user: { select: { name: true } } } },
        },
      });

      auditLog(req, "CLOSE_EMERGENCY_CASE", "emergencyCase", updated.id, {
        status: req.body.status,
        disposition: req.body.disposition,
      }).catch(console.error);

      res.json({ success: true, data: updated, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// PATCH /api/v1/emergency/cases/:id/mlc — mark MLC
router.patch(
  "/cases/:id/mlc",
  authorize(Role.ADMIN, Role.DOCTOR, Role.NURSE),
  validate(mlcDetailsSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const existing = await prisma.emergencyCase.findUnique({
        where: { id: req.params.id },
      });
      if (!existing) {
        res.status(404).json({ success: false, data: null, error: "Case not found" });
        return;
      }
      const updated = await prisma.emergencyCase.update({
        where: { id: req.params.id },
        data: {
          isMLC: req.body.isMLC,
          mlcNumber: req.body.mlcNumber,
          mlcPoliceStation: req.body.mlcPoliceStation,
          mlcFIRNumber: req.body.mlcFIRNumber,
          mlcOfficerName: req.body.mlcOfficerName,
        },
      });
      auditLog(req, "UPDATE_MLC", "emergencyCase", updated.id, {
        isMLC: req.body.isMLC,
      }).catch(console.error);
      res.json({ success: true, data: updated, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// PATCH /api/v1/emergency/cases/:id/orders — save treatment orders
router.patch(
  "/cases/:id/orders",
  authorize(Role.ADMIN, Role.DOCTOR, Role.NURSE),
  validate(erTreatmentOrderSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const updated = await prisma.emergencyCase.update({
        where: { id: req.params.id },
        data: { treatmentOrders: JSON.stringify(req.body.orders) },
      });
      auditLog(req, "UPDATE_ER_ORDERS", "emergencyCase", updated.id, {
        orderCount: req.body.orders.length,
      }).catch(console.error);
      res.json({ success: true, data: updated, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/v1/emergency/cases/:id/admit — convert ER case to admission
router.post(
  "/cases/:id/admit",
  authorize(Role.ADMIN, Role.DOCTOR),
  validate(erToAdmissionSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const ec = await prisma.emergencyCase.findUnique({
        where: { id: req.params.id },
      });
      if (!ec) {
        res.status(404).json({ success: false, data: null, error: "ER case not found" });
        return;
      }
      if (!ec.patientId) {
        res.status(400).json({
          success: false,
          data: null,
          error: "Cannot admit unknown patient — register first",
        });
        return;
      }

      const bed = await prisma.bed.findUnique({ where: { id: req.body.bedId } });
      if (!bed || bed.status !== "AVAILABLE") {
        res.status(409).json({
          success: false,
          data: null,
          error: "Target bed is not available",
        });
        return;
      }

      const last = await prisma.admission.findFirst({
        orderBy: { admissionNumber: "desc" },
        select: { admissionNumber: true },
      });
      let n = 1;
      if (last?.admissionNumber) {
        const m = last.admissionNumber.match(/(\d+)$/);
        if (m) n = parseInt(m[1], 10) + 1;
      }
      const admissionNumber = `IPD${String(n).padStart(6, "0")}`;

      const { admission, updatedCase } = await prisma.$transaction(async (tx) => {
        const created = await tx.admission.create({
          data: {
            admissionNumber,
            patientId: ec.patientId!,
            doctorId: req.body.doctorId,
            bedId: req.body.bedId,
            reason: req.body.reason,
            diagnosis: req.body.diagnosis,
            admissionType: "EMERGENCY",
            status: "ADMITTED",
          },
        });
        await tx.bed.update({
          where: { id: req.body.bedId },
          data: { status: "OCCUPIED" },
        });
        const updatedC = await tx.emergencyCase.update({
          where: { id: req.params.id },
          data: {
            status: "ADMITTED",
            disposition: "ADMITTED",
            linkedAdmissionId: created.id,
            closedAt: new Date(),
          },
        });
        return { admission: created, updatedCase: updatedC };
      });

      auditLog(req, "ER_TO_ADMISSION", "emergencyCase", updatedCase.id, {
        admissionId: admission.id,
        admissionNumber,
      }).catch(console.error);

      res.status(201).json({
        success: true,
        data: { admission, emergencyCase: updatedCase },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/v1/emergency/mass-casualty — bulk register N unknown patients
router.post(
  "/mass-casualty",
  authorize(Role.ADMIN, Role.DOCTOR, Role.NURSE, Role.RECEPTION),
  validate(massCasualtySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { count, incidentNote, arrivalMode } = req.body;

      const last = await prisma.emergencyCase.findFirst({
        orderBy: { caseNumber: "desc" },
        select: { caseNumber: true },
      });
      let start = 1;
      if (last?.caseNumber) {
        const m = last.caseNumber.match(/(\d+)$/);
        if (m) start = parseInt(m[1], 10) + 1;
      }

      const now = new Date();
      const tag =
        incidentNote ??
        `MCI-${now.toISOString().slice(0, 10).replace(/-/g, "")}`;
      const toCreate = [];
      for (let i = 0; i < count; i++) {
        toCreate.push({
          caseNumber: `ER${String(start + i).padStart(6, "0")}`,
          unknownName: `${tag}-${String(i + 1).padStart(2, "0")}`,
          arrivalMode: arrivalMode ?? "MASS_CASUALTY",
          chiefComplaint: `Mass casualty incident: ${tag}`,
          arrivedAt: now,
          status: "WAITING" as const,
        });
      }

      await prisma.emergencyCase.createMany({ data: toCreate });

      auditLog(req, "MASS_CASUALTY_REGISTER", "emergencyCase", tag, {
        count,
        tag,
      }).catch(console.error);

      res.status(201).json({
        success: true,
        data: { tag, created: toCreate.length },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

export { router as emergencyRouter };
