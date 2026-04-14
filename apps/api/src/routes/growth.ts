import { Router, Request, Response, NextFunction } from "express";
import { prisma } from "@medcore/db";
import {
  Role,
  createGrowthRecordSchema,
  updateGrowthRecordSchema,
} from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { auditLog } from "../middleware/audit";

const router = Router();
router.use(authenticate);

// Simplified WHO-style median weight (kg) and height (cm) by age (months) for 0-60m.
// Approximate average of male/female medians.
const MEDIAN_WEIGHT_KG: Record<number, number> = {
  0: 3.3,
  1: 4.5,
  2: 5.6,
  3: 6.4,
  4: 7.0,
  5: 7.5,
  6: 7.9,
  7: 8.3,
  8: 8.6,
  9: 8.9,
  10: 9.2,
  11: 9.4,
  12: 9.6,
  15: 10.3,
  18: 10.9,
  21: 11.5,
  24: 12.2,
  30: 13.3,
  36: 14.3,
  42: 15.3,
  48: 16.3,
  54: 17.3,
  60: 18.3,
};

const MEDIAN_HEIGHT_CM: Record<number, number> = {
  0: 49.9,
  1: 54.7,
  2: 58.4,
  3: 61.4,
  4: 63.9,
  5: 65.9,
  6: 67.6,
  7: 69.2,
  8: 70.6,
  9: 72.0,
  10: 73.3,
  11: 74.5,
  12: 75.7,
  15: 79.1,
  18: 82.3,
  21: 85.1,
  24: 87.1,
  30: 91.9,
  36: 96.1,
  42: 99.9,
  48: 103.3,
  54: 106.5,
  60: 109.4,
};

function lookupMedian(table: Record<number, number>, ageMonths: number): number | null {
  if (ageMonths < 0) return null;
  const keys = Object.keys(table)
    .map((k) => parseInt(k, 10))
    .sort((a, b) => a - b);
  if (ageMonths >= keys[keys.length - 1]) return table[keys[keys.length - 1]];
  if (ageMonths <= keys[0]) return table[keys[0]];
  // linear interpolate
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i];
    const b = keys[i + 1];
    if (ageMonths >= a && ageMonths <= b) {
      const ratio = (ageMonths - a) / (b - a);
      return table[a] + ratio * (table[b] - table[a]);
    }
  }
  return null;
}

function estimatePercentile(measured: number | null | undefined, median: number | null): number | null {
  if (measured == null || median == null || median === 0) return null;
  const p = (measured / median) * 50;
  return Math.max(1, Math.min(99, Math.round(p)));
}

// POST /growth
router.post(
  "/",
  authorize(Role.ADMIN, Role.DOCTOR, Role.NURSE),
  validate(createGrowthRecordSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const {
        patientId,
        measurementDate,
        ageMonths,
        weightKg,
        heightCm,
        headCircumference,
        milestoneNotes,
        developmentalNotes,
      } = req.body;

      const patient = await prisma.patient.findUnique({
        where: { id: patientId },
      });
      if (!patient) {
        res
          .status(404)
          .json({ success: false, data: null, error: "Patient not found" });
        return;
      }

      let bmi: number | null = null;
      if (weightKg && heightCm && heightCm > 0) {
        const hMeters = heightCm / 100;
        bmi = Math.round((weightKg / (hMeters * hMeters)) * 10) / 10;
      }

      const medianW = lookupMedian(MEDIAN_WEIGHT_KG, ageMonths);
      const medianH = lookupMedian(MEDIAN_HEIGHT_CM, ageMonths);

      const weightPercentile = estimatePercentile(weightKg, medianW);
      const heightPercentile = estimatePercentile(heightCm, medianH);

      const record = await prisma.growthRecord.create({
        data: {
          patientId,
          measurementDate: measurementDate
            ? new Date(`${measurementDate}T00:00:00.000Z`)
            : new Date(),
          ageMonths,
          weightKg,
          heightCm,
          headCircumference,
          bmi,
          weightPercentile,
          heightPercentile,
          milestoneNotes,
          developmentalNotes,
          recordedBy: req.user!.userId,
        },
      });

      auditLog(req, "CREATE_GROWTH_RECORD", "growthRecord", record.id, {
        patientId,
        ageMonths,
      }).catch(console.error);

      res.status(201).json({ success: true, data: record, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// GET /growth/patient/:patientId
router.get(
  "/patient/:patientId",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const records = await prisma.growthRecord.findMany({
        where: { patientId: req.params.patientId },
        orderBy: { ageMonths: "asc" },
      });
      res.json({ success: true, data: records, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// GET /growth/patient/:patientId/chart
router.get(
  "/patient/:patientId/chart",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const records = await prisma.growthRecord.findMany({
        where: { patientId: req.params.patientId },
        orderBy: { ageMonths: "asc" },
      });

      const weight = records
        .filter((r) => r.weightKg != null)
        .map((r) => ({
          ageMonths: r.ageMonths,
          value: r.weightKg,
          percentile: r.weightPercentile,
        }));
      const height = records
        .filter((r) => r.heightCm != null)
        .map((r) => ({
          ageMonths: r.ageMonths,
          value: r.heightCm,
          percentile: r.heightPercentile,
        }));
      const headCircumference = records
        .filter((r) => r.headCircumference != null)
        .map((r) => ({
          ageMonths: r.ageMonths,
          value: r.headCircumference,
        }));

      res.json({
        success: true,
        data: { weight, height, headCircumference, records },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// PATCH /growth/:id
router.patch(
  "/:id",
  authorize(Role.ADMIN, Role.DOCTOR, Role.NURSE),
  validate(updateGrowthRecordSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const existing = await prisma.growthRecord.findUnique({
        where: { id: req.params.id },
      });
      if (!existing) {
        res
          .status(404)
          .json({ success: false, data: null, error: "Growth record not found" });
        return;
      }

      // recompute BMI/percentiles if measurements changed
      const weightKg = req.body.weightKg ?? existing.weightKg;
      const heightCm = req.body.heightCm ?? existing.heightCm;
      let bmi = existing.bmi;
      if (weightKg && heightCm && heightCm > 0) {
        const hMeters = heightCm / 100;
        bmi = Math.round((weightKg / (hMeters * hMeters)) * 10) / 10;
      }
      const medianW = lookupMedian(MEDIAN_WEIGHT_KG, existing.ageMonths);
      const medianH = lookupMedian(MEDIAN_HEIGHT_CM, existing.ageMonths);
      const weightPercentile = estimatePercentile(weightKg, medianW);
      const heightPercentile = estimatePercentile(heightCm, medianH);

      const updated = await prisma.growthRecord.update({
        where: { id: req.params.id },
        data: {
          ...req.body,
          bmi,
          weightPercentile,
          heightPercentile,
        },
      });

      auditLog(req, "UPDATE_GROWTH_RECORD", "growthRecord", updated.id, req.body)
        .catch(console.error);

      res.json({ success: true, data: updated, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// DELETE /growth/:id
router.delete(
  "/:id",
  authorize(Role.ADMIN, Role.DOCTOR),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const existing = await prisma.growthRecord.findUnique({
        where: { id: req.params.id },
      });
      if (!existing) {
        res
          .status(404)
          .json({ success: false, data: null, error: "Growth record not found" });
        return;
      }
      await prisma.growthRecord.delete({ where: { id: req.params.id } });
      auditLog(req, "DELETE_GROWTH_RECORD", "growthRecord", req.params.id, {})
        .catch(console.error);
      res.json({ success: true, data: { id: req.params.id }, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// ─── MILESTONE / IMMUNIZATION HELPERS ────────────────────

// WHO milestone checklist
const MILESTONES: Array<{ ageMonths: number; skill: string }> = [
  { ageMonths: 1, skill: "Lifts head briefly when on tummy" },
  { ageMonths: 2, skill: "Smiles socially" },
  { ageMonths: 3, skill: "Holds head steady unsupported" },
  { ageMonths: 4, skill: "Rolls over (tummy to back)" },
  { ageMonths: 6, skill: "Sits with support; babbles" },
  { ageMonths: 9, skill: "Sits without support; crawls" },
  { ageMonths: 12, skill: "Stands with support; says mama/dada" },
  { ageMonths: 15, skill: "Walks independently" },
  { ageMonths: 18, skill: "Uses 10+ words; points at objects" },
  { ageMonths: 24, skill: "2-word phrases; runs" },
  { ageMonths: 36, skill: "Speaks short sentences; climbs stairs" },
  { ageMonths: 48, skill: "Draws simple shapes; counts to 10" },
  { ageMonths: 60, skill: "Tells simple stories; dresses self" },
];

// India UIP immunization schedule (simplified)
const IMMUNIZATION_SCHEDULE: Array<{ vaccine: string; dueMonths: number }> = [
  { vaccine: "BCG", dueMonths: 0 },
  { vaccine: "OPV-0", dueMonths: 0 },
  { vaccine: "Hepatitis B-0", dueMonths: 0 },
  { vaccine: "OPV-1", dueMonths: 1.5 },
  { vaccine: "Pentavalent-1", dueMonths: 1.5 },
  { vaccine: "Rotavirus-1", dueMonths: 1.5 },
  { vaccine: "PCV-1", dueMonths: 1.5 },
  { vaccine: "OPV-2", dueMonths: 2.5 },
  { vaccine: "Pentavalent-2", dueMonths: 2.5 },
  { vaccine: "Rotavirus-2", dueMonths: 2.5 },
  { vaccine: "PCV-2", dueMonths: 2.5 },
  { vaccine: "OPV-3", dueMonths: 3.5 },
  { vaccine: "Pentavalent-3", dueMonths: 3.5 },
  { vaccine: "Rotavirus-3", dueMonths: 3.5 },
  { vaccine: "IPV", dueMonths: 3.5 },
  { vaccine: "Measles-Rubella-1", dueMonths: 9 },
  { vaccine: "JE-1", dueMonths: 9 },
  { vaccine: "PCV-Booster", dueMonths: 9 },
  { vaccine: "Vitamin A-1", dueMonths: 9 },
  { vaccine: "DPT-Booster-1", dueMonths: 16 },
  { vaccine: "OPV-Booster", dueMonths: 16 },
  { vaccine: "MR-2", dueMonths: 16 },
  { vaccine: "JE-2", dueMonths: 16 },
  { vaccine: "DPT-Booster-2", dueMonths: 60 },
];

function computeAgeMonths(dob: Date | null): number | null {
  if (!dob) return null;
  const now = Date.now();
  const dobMs = new Date(dob).getTime();
  return Math.floor((now - dobMs) / (30.4375 * 24 * 60 * 60 * 1000));
}

// GET /growth/patient/:patientId/milestones
router.get(
  "/patient/:patientId/milestones",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const patient = await prisma.patient.findUnique({
        where: { id: req.params.patientId },
      });
      if (!patient) {
        res.status(404).json({ success: false, data: null, error: "Patient not found" });
        return;
      }
      const ageM = computeAgeMonths(patient.dateOfBirth);
      const records = await prisma.growthRecord.findMany({
        where: { patientId: req.params.patientId },
        orderBy: { ageMonths: "desc" },
      });
      const noteBlob = records
        .map((r) => `${r.milestoneNotes ?? ""} ${r.developmentalNotes ?? ""}`)
        .join(" ")
        .toLowerCase();

      const checklist = MILESTONES.map((m) => {
        const achieved = noteBlob.includes(m.skill.toLowerCase().split(";")[0]);
        const due = ageM != null && ageM >= m.ageMonths;
        return {
          ageMonths: m.ageMonths,
          skill: m.skill,
          status: achieved ? "ACHIEVED" : due ? "OVERDUE" : "PENDING",
        };
      });

      res.json({
        success: true,
        data: {
          ageMonths: ageM,
          checklist,
          achieved: checklist.filter((c) => c.status === "ACHIEVED").length,
          overdue: checklist.filter((c) => c.status === "OVERDUE").length,
          total: checklist.length,
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// GET /growth/patient/:patientId/immunization-compliance
router.get(
  "/patient/:patientId/immunization-compliance",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const patient = await prisma.patient.findUnique({
        where: { id: req.params.patientId },
      });
      if (!patient) {
        res.status(404).json({ success: false, data: null, error: "Patient not found" });
        return;
      }
      const ageM = computeAgeMonths(patient.dateOfBirth);
      const given = await prisma.immunization.findMany({
        where: { patientId: req.params.patientId },
      });
      const givenSet = new Set(
        given.map((g) => g.vaccine.toLowerCase().replace(/\s+/g, ""))
      );

      const schedule = IMMUNIZATION_SCHEDULE.map((v) => {
        const key = v.vaccine.toLowerCase().replace(/\s+/g, "");
        const done = givenSet.has(key);
        const isDue = ageM != null && ageM >= v.dueMonths;
        return {
          vaccine: v.vaccine,
          dueMonths: v.dueMonths,
          status: done
            ? "GIVEN"
            : isDue
              ? "OVERDUE"
              : "UPCOMING",
          dueDateApprox:
            patient.dateOfBirth != null
              ? new Date(
                  new Date(patient.dateOfBirth).getTime() +
                    v.dueMonths * 30.4375 * 24 * 60 * 60 * 1000
                )
                  .toISOString()
                  .slice(0, 10)
              : null,
        };
      });

      const given_count = schedule.filter((s) => s.status === "GIVEN").length;
      const overdue_count = schedule.filter((s) => s.status === "OVERDUE").length;

      res.json({
        success: true,
        data: {
          ageMonths: ageM,
          schedule,
          givenCount: given_count,
          overdueCount: overdue_count,
          totalRequired: schedule.length,
          compliancePct:
            schedule.length > 0
              ? Math.round(
                  (given_count /
                    Math.max(
                      1,
                      schedule.filter((s) => s.status !== "UPCOMING").length
                    )) *
                    100
                )
              : 0,
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// GET /growth/patient/:patientId/velocity — weight gain per month
router.get(
  "/patient/:patientId/velocity",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const records = await prisma.growthRecord.findMany({
        where: { patientId: req.params.patientId, weightKg: { not: null } },
        orderBy: { ageMonths: "asc" },
      });
      if (records.length < 2) {
        res.json({
          success: true,
          data: { velocity: [], summary: { avgGainPerMonth: null } },
          error: null,
        });
        return;
      }
      const velocity: Array<{
        fromAge: number;
        toAge: number;
        weightGainKg: number;
        gainKgPerMonth: number;
      }> = [];
      for (let i = 1; i < records.length; i++) {
        const a = records[i - 1];
        const b = records[i];
        const months = Math.max(1, b.ageMonths - a.ageMonths);
        const gain = (b.weightKg ?? 0) - (a.weightKg ?? 0);
        velocity.push({
          fromAge: a.ageMonths,
          toAge: b.ageMonths,
          weightGainKg: Math.round(gain * 100) / 100,
          gainKgPerMonth: Math.round((gain / months) * 100) / 100,
        });
      }
      const avg =
        velocity.reduce((s, v) => s + v.gainKgPerMonth, 0) / velocity.length;
      res.json({
        success: true,
        data: {
          velocity,
          summary: { avgGainPerMonth: Math.round(avg * 100) / 100 },
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

export { router as growthRouter };
