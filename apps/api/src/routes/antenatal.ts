import { Router, Request, Response, NextFunction } from "express";
import { prisma } from "@medcore/db";
import {
  Role,
  createAncCaseSchema,
  updateAncCaseSchema,
  createAncVisitSchema,
  deliveryOutcomeSchema,
  ultrasoundRecordSchema,
  startPartographSchema,
  addPartographObservationSchema,
  endPartographSchema,
  acogRiskScoreSchema,
  postnatalVisitSchema,
} from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { auditLog } from "../middleware/audit";
import { generateBirthCertificateHTML } from "../services/pdf";

const router = Router();
router.use(authenticate);

// Generate next ANC case number like ANC000001
async function nextAncCaseNumber(): Promise<string> {
  const last = await prisma.antenatalCase.findFirst({
    orderBy: { caseNumber: "desc" },
    select: { caseNumber: true },
  });
  let n = 1;
  if (last?.caseNumber) {
    const m = last.caseNumber.match(/(\d+)$/);
    if (m) n = parseInt(m[1], 10) + 1;
  }
  return `ANC${String(n).padStart(6, "0")}`;
}

function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

// Calculate gestational age from LMP
function weeksSinceLMP(lmp: Date): number {
  const diffMs = Date.now() - new Date(lmp).getTime();
  return Math.floor(diffMs / (7 * 24 * 60 * 60 * 1000));
}

function trimesterFromWeeks(weeks: number): 1 | 2 | 3 {
  if (weeks <= 12) return 1;
  if (weeks <= 27) return 2;
  return 3;
}

// Recommended schedule: monthly until 28w, biweekly 28-36w, weekly after
function nextVisitFromWeeks(weeks: number, from: Date): Date {
  let days = 28;
  if (weeks >= 36) days = 7;
  else if (weeks >= 28) days = 14;
  return addDays(from, days);
}

// Compute high-risk score 0-10+
function highRiskScore(params: {
  ageAtConception?: number | null;
  gravida: number;
  parity: number;
  hasPrevCSection?: boolean;
  hasHypertension?: boolean;
  hasDiabetes?: boolean;
  bmi?: number | null;
}): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let score = 0;
  if (params.ageAtConception != null) {
    if (params.ageAtConception < 18) {
      score += 3;
      reasons.push("Age < 18 (teen pregnancy)");
    } else if (params.ageAtConception >= 35) {
      score += 2;
      reasons.push(`Age ${params.ageAtConception} (advanced maternal age)`);
    }
  }
  if (params.gravida >= 5) {
    score += 2;
    reasons.push(`Grand multipara (G${params.gravida})`);
  }
  if (params.hasPrevCSection) {
    score += 2;
    reasons.push("Previous C-section");
  }
  if (params.hasHypertension) {
    score += 3;
    reasons.push("Hypertension");
  }
  if (params.hasDiabetes) {
    score += 3;
    reasons.push("Diabetes");
  }
  if (params.bmi != null) {
    if (params.bmi < 18.5) {
      score += 2;
      reasons.push(`BMI ${params.bmi} (underweight)`);
    } else if (params.bmi >= 30) {
      score += 2;
      reasons.push(`BMI ${params.bmi} (obese)`);
    }
  }
  return { score, reasons };
}

// ─── DASHBOARD ──────────────────────────────────────
router.get(
  "/dashboard",
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const now = new Date();
      const in30 = addDays(now, 30);
      const in7 = addDays(now, 7);

      const [activeCases, highRiskCases, upcomingDeliveries, overdueDeliveries, dueVisits] =
        await Promise.all([
          prisma.antenatalCase.count({ where: { deliveredAt: null } }),
          prisma.antenatalCase.count({
            where: { deliveredAt: null, isHighRisk: true },
          }),
          prisma.antenatalCase.count({
            where: {
              deliveredAt: null,
              eddDate: { gte: now, lte: in30 },
            },
          }),
          prisma.antenatalCase.count({
            where: {
              deliveredAt: null,
              eddDate: { lt: now },
            },
          }),
          prisma.antenatalCase.findMany({
            where: {
              deliveredAt: null,
              visits: {
                some: {
                  nextVisitDate: {
                    gte: now,
                    lte: in7,
                  },
                },
              },
            },
            include: {
              patient: {
                include: { user: { select: { name: true, phone: true } } },
              },
              visits: {
                orderBy: { visitDate: "desc" },
                take: 1,
              },
            },
            take: 50,
          }),
        ]);

      res.json({
        success: true,
        data: {
          activeCases,
          highRiskCases,
          upcomingDeliveries,
          overdueDeliveries,
          visitsDueThisWeek: dueVisits,
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─── ANC CASES ──────────────────────────────────────

// POST /antenatal/cases
router.post(
  "/cases",
  authorize(Role.ADMIN, Role.DOCTOR, Role.NURSE),
  validate(createAncCaseSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const {
        patientId,
        doctorId,
        lmpDate,
        gravida,
        parity,
        bloodGroup,
        isHighRisk,
        riskFactors,
      } = req.body;

      // Ensure patient exists and is female
      const patient = await prisma.patient.findUnique({
        where: { id: patientId },
        include: { user: { select: { name: true } } },
      });
      if (!patient) {
        res
          .status(404)
          .json({ success: false, data: null, error: "Patient not found" });
        return;
      }
      if (patient.gender !== "FEMALE") {
        res.status(400).json({
          success: false,
          data: null,
          error: "ANC cases can only be created for female patients",
        });
        return;
      }

      // Check no existing ANC case
      const existing = await prisma.antenatalCase.findUnique({
        where: { patientId },
      });
      if (existing) {
        res.status(409).json({
          success: false,
          data: null,
          error: `Patient already has an ANC case (${existing.caseNumber})`,
        });
        return;
      }

      const lmp = new Date(`${lmpDate}T00:00:00.000Z`);
      const edd = addDays(lmp, 280);
      const caseNumber = await nextAncCaseNumber();

      const created = await prisma.antenatalCase.create({
        data: {
          caseNumber,
          patientId,
          doctorId,
          lmpDate: lmp,
          eddDate: edd,
          gravida: gravida ?? 1,
          parity: parity ?? 0,
          bloodGroup,
          isHighRisk: isHighRisk ?? false,
          riskFactors,
        },
        include: {
          patient: {
            include: { user: { select: { name: true, phone: true } } },
          },
          doctor: { include: { user: { select: { name: true } } } },
        },
      });

      auditLog(req, "CREATE_ANC_CASE", "antenatalCase", created.id, {
        caseNumber,
        patientId,
      }).catch(console.error);

      res.status(201).json({ success: true, data: created, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// GET /antenatal/cases
router.get(
  "/cases",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const {
        doctorId,
        isHighRisk,
        delivered,
        page = "1",
        limit = "20",
      } = req.query;
      const pageN = parseInt(page as string) || 1;
      const takeN = Math.min(parseInt(limit as string) || 20, 100);
      const skip = (pageN - 1) * takeN;

      const where: Record<string, unknown> = {};
      if (doctorId) where.doctorId = doctorId;
      if (isHighRisk !== undefined)
        where.isHighRisk = isHighRisk === "true";
      if (delivered === "true") where.deliveredAt = { not: null };
      if (delivered === "false") where.deliveredAt = null;

      const [cases, total] = await Promise.all([
        prisma.antenatalCase.findMany({
          where,
          include: {
            patient: {
              include: { user: { select: { name: true, phone: true } } },
            },
            doctor: { include: { user: { select: { name: true } } } },
            visits: {
              orderBy: { visitDate: "desc" },
              take: 1,
            },
          },
          skip,
          take: takeN,
          orderBy: { createdAt: "desc" },
        }),
        prisma.antenatalCase.count({ where }),
      ]);

      res.json({
        success: true,
        data: cases,
        error: null,
        meta: { page: pageN, limit: takeN, total },
      });
    } catch (err) {
      next(err);
    }
  }
);

// GET /antenatal/cases/:id
router.get(
  "/cases/:id",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const c = await prisma.antenatalCase.findUnique({
        where: { id: req.params.id },
        include: {
          patient: {
            include: {
              user: { select: { name: true, phone: true, email: true } },
            },
          },
          doctor: { include: { user: { select: { name: true } } } },
          visits: { orderBy: { visitDate: "asc" } },
        },
      });
      if (!c) {
        res
          .status(404)
          .json({ success: false, data: null, error: "ANC case not found" });
        return;
      }
      res.json({ success: true, data: c, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// PATCH /antenatal/cases/:id
router.patch(
  "/cases/:id",
  authorize(Role.ADMIN, Role.DOCTOR, Role.NURSE),
  validate(updateAncCaseSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const existing = await prisma.antenatalCase.findUnique({
        where: { id: req.params.id },
      });
      if (!existing) {
        res
          .status(404)
          .json({ success: false, data: null, error: "ANC case not found" });
        return;
      }

      const updated = await prisma.antenatalCase.update({
        where: { id: req.params.id },
        data: req.body,
        include: {
          patient: {
            include: { user: { select: { name: true, phone: true } } },
          },
          doctor: { include: { user: { select: { name: true } } } },
        },
      });

      auditLog(req, "UPDATE_ANC_CASE", "antenatalCase", updated.id, req.body)
        .catch(console.error);

      res.json({ success: true, data: updated, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// PATCH /antenatal/cases/:id/delivery
router.patch(
  "/cases/:id/delivery",
  authorize(Role.ADMIN, Role.DOCTOR),
  validate(deliveryOutcomeSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const existing = await prisma.antenatalCase.findUnique({
        where: { id: req.params.id },
      });
      if (!existing) {
        res
          .status(404)
          .json({ success: false, data: null, error: "ANC case not found" });
        return;
      }
      if (existing.deliveredAt) {
        res.status(409).json({
          success: false,
          data: null,
          error: "Delivery already recorded for this case",
        });
        return;
      }

      const updated = await prisma.antenatalCase.update({
        where: { id: req.params.id },
        data: {
          deliveredAt: new Date(),
          deliveryType: req.body.deliveryType,
          babyGender: req.body.babyGender,
          babyWeight: req.body.babyWeight,
          outcomeNotes: req.body.outcomeNotes,
        },
        include: {
          patient: {
            include: { user: { select: { name: true, phone: true } } },
          },
          doctor: { include: { user: { select: { name: true } } } },
        },
      });

      auditLog(req, "RECORD_DELIVERY", "antenatalCase", updated.id, {
        deliveryType: req.body.deliveryType,
      }).catch(console.error);

      res.json({ success: true, data: updated, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// ─── ANC VISITS ─────────────────────────────────────

// POST /antenatal/visits
router.post(
  "/visits",
  authorize(Role.ADMIN, Role.DOCTOR, Role.NURSE),
  validate(createAncVisitSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { ancCaseId, nextVisitDate, ...rest } = req.body;

      const ancCase = await prisma.antenatalCase.findUnique({
        where: { id: ancCaseId },
      });
      if (!ancCase) {
        res
          .status(404)
          .json({ success: false, data: null, error: "ANC case not found" });
        return;
      }

      const visit = await prisma.ancVisit.create({
        data: {
          ancCaseId,
          ...rest,
          nextVisitDate: nextVisitDate
            ? new Date(`${nextVisitDate}T00:00:00.000Z`)
            : null,
        },
      });

      auditLog(req, "ADD_ANC_VISIT", "ancVisit", visit.id, {
        ancCaseId,
        type: visit.type,
      }).catch(console.error);

      res.status(201).json({ success: true, data: visit, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// GET /antenatal/visits?ancCaseId=
router.get(
  "/visits",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { ancCaseId } = req.query;
      const where: Record<string, unknown> = {};
      if (ancCaseId) where.ancCaseId = ancCaseId;

      const visits = await prisma.ancVisit.findMany({
        where,
        orderBy: { visitDate: "asc" },
      });
      res.json({ success: true, data: visits, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// GET /antenatal/cases/:id/trimester — current gestational status
router.get(
  "/cases/:id/trimester",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const c = await prisma.antenatalCase.findUnique({
        where: { id: req.params.id },
        include: {
          visits: { orderBy: { visitDate: "desc" }, take: 1 },
        },
      });
      if (!c) {
        res.status(404).json({ success: false, data: null, error: "ANC case not found" });
        return;
      }
      const weeks = weeksSinceLMP(c.lmpDate);
      const trimester = trimesterFromWeeks(weeks);
      const suggestedNext = nextVisitFromWeeks(weeks, new Date());
      res.json({
        success: true,
        data: {
          weeks,
          trimester,
          eddDate: c.eddDate,
          suggestedNextVisitDate: suggestedNext,
          lastVisit: c.visits[0] ?? null,
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// POST /antenatal/cases/:id/risk-score — recalc + save
router.post(
  "/cases/:id/risk-score",
  authorize(Role.ADMIN, Role.DOCTOR, Role.NURSE),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const c = await prisma.antenatalCase.findUnique({
        where: { id: req.params.id },
        include: { patient: true },
      });
      if (!c) {
        res.status(404).json({ success: false, data: null, error: "ANC case not found" });
        return;
      }

      let ageAtConception: number | null = null;
      if (c.patient.dateOfBirth) {
        const dobMs = new Date(c.patient.dateOfBirth).getTime();
        const lmpMs = new Date(c.lmpDate).getTime();
        ageAtConception = Math.floor(
          (lmpMs - dobMs) / (365.25 * 24 * 60 * 60 * 1000)
        );
      } else if (c.patient.age != null) {
        ageAtConception = c.patient.age;
      }

      const body = req.body || {};
      const { score, reasons } = highRiskScore({
        ageAtConception,
        gravida: c.gravida,
        parity: c.parity,
        hasPrevCSection: !!body.hasPrevCSection,
        hasHypertension: !!body.hasHypertension,
        hasDiabetes: !!body.hasDiabetes,
        bmi: body.bmi ?? null,
      });

      const isHighRisk = score >= 4 || c.isHighRisk;
      const updated = await prisma.antenatalCase.update({
        where: { id: c.id },
        data: {
          isHighRisk,
          riskFactors: reasons.join("; ") || c.riskFactors,
        },
      });

      auditLog(req, "ANC_RISK_SCORE", "antenatalCase", updated.id, {
        score,
        isHighRisk,
      }).catch(console.error);

      res.json({
        success: true,
        data: { score, isHighRisk, reasons, case: updated },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// POST /antenatal/cases/:id/ultrasound — create USG record
router.post(
  "/cases/:id/ultrasound",
  authorize(Role.ADMIN, Role.DOCTOR, Role.NURSE),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = ultrasoundRecordSchema.safeParse({
        ...req.body,
        ancCaseId: req.params.id,
      });
      if (!parsed.success) {
        res.status(400).json({
          success: false,
          data: null,
          error: "Validation failed",
          details: parsed.error.flatten(),
        });
        return;
      }
      const c = await prisma.antenatalCase.findUnique({
        where: { id: req.params.id },
      });
      if (!c) {
        res.status(404).json({ success: false, data: null, error: "ANC case not found" });
        return;
      }
      const usg = await prisma.ultrasoundRecord.create({
        data: {
          ancCaseId: req.params.id,
          scanDate: parsed.data.scanDate
            ? new Date(parsed.data.scanDate)
            : new Date(),
          gestationalWeeks: parsed.data.gestationalWeeks,
          efwGrams: parsed.data.efwGrams,
          afi: parsed.data.afi,
          placentaPosition: parsed.data.placentaPosition,
          fetalHeartRate: parsed.data.fetalHeartRate,
          presentation: parsed.data.presentation,
          findings: parsed.data.findings,
          impression: parsed.data.impression,
          recordedBy: req.user!.userId,
        },
      });
      auditLog(req, "ANC_USG_RECORD", "ultrasoundRecord", usg.id, {
        ancCaseId: req.params.id,
      }).catch(console.error);
      res.status(201).json({ success: true, data: usg, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// GET /antenatal/cases/:id/ultrasound — list USG records
router.get(
  "/cases/:id/ultrasound",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const rows = await prisma.ultrasoundRecord.findMany({
        where: { ancCaseId: req.params.id },
        orderBy: { scanDate: "desc" },
      });
      res.json({ success: true, data: rows, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// ─── PARTOGRAPH ─────────────────────────────────────

// POST /antenatal/cases/:id/partograph — start
router.post(
  "/cases/:id/partograph",
  authorize(Role.ADMIN, Role.DOCTOR, Role.NURSE),
  validate(startPartographSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const c = await prisma.antenatalCase.findUnique({
        where: { id: req.params.id },
        select: { id: true },
      });
      if (!c) {
        res.status(404).json({ success: false, data: null, error: "ANC case not found" });
        return;
      }
      const partograph = await prisma.partograph.create({
        data: {
          ancCaseId: req.params.id,
          observations: (req.body.observations ?? []) as never,
          interventions: req.body.interventions ?? null,
          performedBy: req.user!.userId,
        },
      });
      auditLog(req, "START_PARTOGRAPH", "partograph", partograph.id, {
        ancCaseId: req.params.id,
      }).catch(console.error);
      res.status(201).json({ success: true, data: partograph, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// PATCH /antenatal/partograph/:id/observation — append observation
router.patch(
  "/partograph/:id/observation",
  authorize(Role.ADMIN, Role.DOCTOR, Role.NURSE),
  validate(addPartographObservationSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const p = await prisma.partograph.findUnique({
        where: { id: req.params.id },
      });
      if (!p) {
        res.status(404).json({ success: false, data: null, error: "Partograph not found" });
        return;
      }
      if (p.endedAt) {
        res.status(409).json({
          success: false,
          data: null,
          error: "Partograph already ended",
        });
        return;
      }
      const existing = Array.isArray(p.observations) ? (p.observations as unknown[]) : [];
      const updated = await prisma.partograph.update({
        where: { id: p.id },
        data: {
          observations: [...existing, req.body] as never,
        },
      });
      auditLog(req, "ADD_PARTOGRAPH_OBSERVATION", "partograph", p.id, {}).catch(
        console.error
      );
      res.json({ success: true, data: updated, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// GET /antenatal/partograph/:id — full partograph + alert/action lines
router.get(
  "/partograph/:id",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const p = await prisma.partograph.findUnique({
        where: { id: req.params.id },
      });
      if (!p) {
        res.status(404).json({ success: false, data: null, error: "Partograph not found" });
        return;
      }

      // WHO Alert / Action lines for cervical dilation (active phase: starts at 4cm)
      // Alert: 1cm/hour. Action: Alert + 4 hours offset.
      const obs = Array.isArray(p.observations) ? (p.observations as Array<Record<string, unknown>>) : [];
      const start = new Date(p.startedAt).getTime();
      const dilationSeries = obs
        .filter((o) => typeof o.cervicalDilation === "number")
        .map((o) => {
          const t = o.time ? new Date(o.time as string).getTime() : start;
          return {
            hoursSinceStart: +((t - start) / 3600000).toFixed(2),
            cervicalDilation: o.cervicalDilation as number,
          };
        });

      const fhrSeries = obs
        .filter((o) => typeof o.fetalHeartRate === "number")
        .map((o) => {
          const t = o.time ? new Date(o.time as string).getTime() : start;
          return {
            hoursSinceStart: +((t - start) / 3600000).toFixed(2),
            fetalHeartRate: o.fetalHeartRate as number,
          };
        });

      // Alert line: dilation = 4 + hours (up to 10cm)
      const maxHours = dilationSeries.length > 0
        ? Math.max(...dilationSeries.map((d) => d.hoursSinceStart), 6)
        : 6;
      const alertLine: Array<{ hour: number; dilation: number }> = [];
      const actionLine: Array<{ hour: number; dilation: number }> = [];
      for (let h = 0; h <= Math.ceil(maxHours); h++) {
        alertLine.push({ hour: h, dilation: Math.min(10, 4 + h) });
        actionLine.push({ hour: h, dilation: Math.min(10, 4 + Math.max(0, h - 4)) });
      }

      // Flags
      const flags: string[] = [];
      for (const o of obs) {
        const fhr = o.fetalHeartRate as number | undefined;
        if (typeof fhr === "number" && (fhr < 110 || fhr > 160)) {
          flags.push(`Abnormal fetal HR (${fhr}) at ${o.time ?? "?"}`);
        }
      }
      // Is progress crossing action line?
      const crossedAction = dilationSeries.some(
        (d) => d.cervicalDilation < Math.max(4, 4 + (d.hoursSinceStart - 4))
      );
      if (crossedAction) flags.push("Labor progress crossed action line");

      res.json({
        success: true,
        data: {
          ...p,
          chart: {
            dilationSeries,
            fhrSeries,
            alertLine,
            actionLine,
          },
          flags,
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// PATCH /antenatal/partograph/:id/end
router.patch(
  "/partograph/:id/end",
  authorize(Role.ADMIN, Role.DOCTOR, Role.NURSE),
  validate(endPartographSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const updated = await prisma.partograph.update({
        where: { id: req.params.id },
        data: {
          endedAt: new Date(),
          outcome: req.body.outcome,
          interventions: req.body.interventions,
        },
      });
      auditLog(req, "END_PARTOGRAPH", "partograph", updated.id, {
        outcome: req.body.outcome,
      }).catch(console.error);
      res.json({ success: true, data: updated, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// ─── ACOG-BASED RISK SCORE ──────────────────────────

// POST /antenatal/cases/:id/acog-risk-score
router.post(
  "/cases/:id/acog-risk-score",
  authorize(Role.ADMIN, Role.DOCTOR, Role.NURSE),
  validate(acogRiskScoreSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const c = await prisma.antenatalCase.findUnique({
        where: { id: req.params.id },
        include: { patient: true },
      });
      if (!c) {
        res.status(404).json({ success: false, data: null, error: "ANC case not found" });
        return;
      }

      let ageAtConception: number | null = null;
      if (c.patient.dateOfBirth) {
        const dobMs = new Date(c.patient.dateOfBirth).getTime();
        const lmpMs = new Date(c.lmpDate).getTime();
        ageAtConception = Math.floor(
          (lmpMs - dobMs) / (365.25 * 24 * 60 * 60 * 1000)
        );
      } else if (c.patient.age != null) {
        ageAtConception = c.patient.age;
      }

      let bmi: number | null = null;
      const heightCm = req.body.heightCm;
      const weightKg = req.body.weightKg;
      if (heightCm && weightKg && heightCm > 0) {
        const h = heightCm / 100;
        bmi = Math.round((weightKg / (h * h)) * 10) / 10;
      }

      const riskFactors: Array<{ factor: string; points: number }> = [];
      let score = 0;
      const add = (factor: string, points: number) => {
        riskFactors.push({ factor, points });
        score += points;
      };

      if (ageAtConception != null) {
        if (ageAtConception < 18) add(`Age < 18 (${ageAtConception})`, 3);
        else if (ageAtConception >= 35) add(`Age >= 35 (${ageAtConception})`, 2);
      }
      if (bmi != null) {
        if (bmi < 18.5) add(`BMI ${bmi} (underweight)`, 2);
        else if (bmi >= 30) add(`BMI ${bmi} (obese)`, 2);
      }
      if (req.body.hasPrevCSection) add("Previous C-section", 2);
      if (req.body.hasHypertension) add("Hypertension (current/history)", 3);
      if (req.body.hasDiabetes) add("Diabetes (current GDM or prior)", 3);
      if (req.body.hasPriorGDM) add("Prior GDM", 2);
      if (c.parity > 5) add(`Grand multipara (P${c.parity})`, 2);
      if (req.body.hasPriorStillbirth) add("Prior stillbirth", 3);
      if (req.body.hasPriorPreterm) add("Prior preterm delivery", 2);
      if (req.body.hasPriorComplications) add("Prior pregnancy complications", 2);
      if (req.body.currentBleeding) add("Current bleeding in pregnancy", 4);
      if (req.body.currentPreeclampsia) add("Current pre-eclampsia", 4);

      let category: "LOW" | "MODERATE" | "HIGH" | "VERY_HIGH" = "LOW";
      if (score >= 10) category = "VERY_HIGH";
      else if (score >= 6) category = "HIGH";
      else if (score >= 3) category = "MODERATE";

      const isHighRisk = category === "HIGH" || category === "VERY_HIGH";
      const updated = await prisma.antenatalCase.update({
        where: { id: c.id },
        data: {
          isHighRisk: isHighRisk || c.isHighRisk,
          riskFactors: riskFactors.map((r) => r.factor).join("; ") || c.riskFactors,
        },
      });

      auditLog(req, "ANC_ACOG_RISK_SCORE", "antenatalCase", updated.id, {
        score,
        category,
      }).catch(console.error);

      res.json({
        success: true,
        data: {
          score,
          category,
          isHighRisk,
          bmi,
          ageAtConception,
          riskFactors,
          case: updated,
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─── POSTNATAL VISITS ───────────────────────────────

// POST /antenatal/cases/:id/postnatal-visits
router.post(
  "/cases/:id/postnatal-visits",
  authorize(Role.ADMIN, Role.DOCTOR, Role.NURSE),
  validate(postnatalVisitSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const c = await prisma.antenatalCase.findUnique({
        where: { id: req.params.id },
        select: { id: true, deliveredAt: true },
      });
      if (!c) {
        res.status(404).json({ success: false, data: null, error: "ANC case not found" });
        return;
      }
      if (!c.deliveredAt) {
        res.status(400).json({
          success: false,
          data: null,
          error: "Postnatal visits require a recorded delivery",
        });
        return;
      }

      const visit = await prisma.postnatalVisit.create({
        data: {
          ancCaseId: req.params.id,
          weekPostpartum: req.body.weekPostpartum,
          motherBP: req.body.motherBP,
          motherWeight: req.body.motherWeight,
          lochia: req.body.lochia,
          uterineInvolution: req.body.uterineInvolution,
          breastExam: req.body.breastExam,
          breastfeeding: req.body.breastfeeding,
          mentalHealth: req.body.mentalHealth,
          babyWeight: req.body.babyWeight,
          babyFeeding: req.body.babyFeeding,
          babyJaundice: req.body.babyJaundice ?? false,
          babyExam: req.body.babyExam,
          immunizationGiven: req.body.immunizationGiven,
          notes: req.body.notes,
          performedBy: req.user!.userId,
        },
      });

      auditLog(req, "POSTNATAL_VISIT", "postnatalVisit", visit.id, {
        ancCaseId: req.params.id,
        weekPostpartum: req.body.weekPostpartum,
      }).catch(console.error);

      res.status(201).json({ success: true, data: visit, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// GET /antenatal/cases/:id/postnatal-visits
router.get(
  "/cases/:id/postnatal-visits",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const rows = await prisma.postnatalVisit.findMany({
        where: { ancCaseId: req.params.id },
        orderBy: { weekPostpartum: "asc" },
      });
      res.json({ success: true, data: rows, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// PATCH /antenatal/postnatal-visits/:id
router.patch(
  "/postnatal-visits/:id",
  authorize(Role.ADMIN, Role.DOCTOR, Role.NURSE),
  validate(postnatalVisitSchema.partial()),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const v = await prisma.postnatalVisit.update({
        where: { id: req.params.id },
        data: req.body,
      });
      res.json({ success: true, data: v, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/antenatal/cases/:id/birth-certificate
router.get(
  "/cases/:id/birth-certificate",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const html = await generateBirthCertificateHTML(req.params.id);
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(html);
    } catch (err) {
      if (err instanceof Error) {
        if (err.message === "ANC case not found" || err.message.includes("Delivery")) {
          res.status(404).json({ success: false, data: null, error: err.message });
          return;
        }
      }
      next(err);
    }
  }
);

export { router as antenatalRouter };
