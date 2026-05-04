import { Router, Request, Response, NextFunction } from "express";
// Multi-tenant wiring: `tenantScopedPrisma` is a Prisma $extends wrapper that
// auto-injects tenantId on create and auto-filters on read for the 20
// tenant-scoped models (see services/tenant-prisma.ts). We alias it to
// `prisma` so every existing call site keeps working without edits.
import { tenantScopedPrisma as prisma } from "../services/tenant-prisma";
import {
  Role,
  createGrowthRecordSchema,
  updateGrowthRecordSchema,
  milestoneRecordSchema,
  feedingLogSchema,
  MILESTONE_DOMAINS,
} from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { auditLog } from "../middleware/audit";
import { assertPatientOwnsResource } from "../middleware/patient-self-only";

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

      auditLog(req, "GROWTH_RECORD_CREATE", "growthRecord", record.id, {
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
// #511: PATCHED — verify PATIENT callers own :patientId before
// returning growth chart records (pediatric PHI).
router.get(
  "/patient/:patientId",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (
        !(await assertPatientOwnsResource(req, res, req.params.patientId))
      )
        return;
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
// #511: PATCHED — verify PATIENT ownership of :patientId before
// returning growth-chart aggregates.
router.get(
  "/patient/:patientId/chart",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (
        !(await assertPatientOwnsResource(req, res, req.params.patientId))
      )
        return;
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

      auditLog(req, "GROWTH_RECORD_UPDATE", "growthRecord", updated.id, req.body)
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
      auditLog(req, "GROWTH_RECORD_DELETE", "growthRecord", req.params.id, {})
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
// #511: PATCHED — verify PATIENT ownership of :patientId before
// returning developmental milestone history (pediatric PHI).
router.get(
  "/patient/:patientId/milestones",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (
        !(await assertPatientOwnsResource(req, res, req.params.patientId))
      )
        return;
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
// #511: PATCHED — verify PATIENT ownership of :patientId before
// returning immunization compliance status.
router.get(
  "/patient/:patientId/immunization-compliance",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (
        !(await assertPatientOwnsResource(req, res, req.params.patientId))
      )
        return;
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
// #511: PATCHED — verify PATIENT ownership of :patientId before
// returning weight-velocity metrics.
router.get(
  "/patient/:patientId/velocity",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (
        !(await assertPatientOwnsResource(req, res, req.params.patientId))
      )
        return;
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

// ─── FAILURE-TO-THRIVE DETECTION ───────────────────────

// GET /growth/patient/:id/ftt-check
// #511: PATCHED — verify PATIENT ownership of :id before returning
// failure-to-thrive screening output (pediatric PHI).
router.get(
  "/patient/:id/ftt-check",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!(await assertPatientOwnsResource(req, res, req.params.id))) return;
      const records = await prisma.growthRecord.findMany({
        where: { patientId: req.params.id, weightKg: { not: null } },
        orderBy: { measurementDate: "asc" },
      });

      if (records.length === 0) {
        res.json({
          success: true,
          data: {
            isFTT: false,
            reasons: [],
            suggestions: ["Record growth measurements to enable FTT screening"],
            currentPercentile: null,
            velocityKgPerMonth: null,
          },
          error: null,
        });
        return;
      }

      const latest = records[records.length - 1];
      const currentPercentile = latest.weightPercentile ?? null;

      // Percentile band drop: compare earliest with latest
      const earliest = records[0];
      // Issue #214: round to 1 decimal so the FTT alert never leaks an
      // IEEE 754 binary-float artifact like "28.800000000000004 points"
      // back into the UI.
      const percentileDropRaw =
        (earliest.weightPercentile ?? 50) - (latest.weightPercentile ?? 50);
      const percentileDrop = Math.round(percentileDropRaw * 10) / 10;

      // Velocity check — kg/month in last interval
      let velocityKgPerMonth: number | null = null;
      if (records.length >= 2) {
        const a = records[records.length - 2];
        const b = latest;
        const months = Math.max(1, b.ageMonths - a.ageMonths);
        const gain = (b.weightKg ?? 0) - (a.weightKg ?? 0);
        velocityKgPerMonth = Math.round((gain / months) * 100) / 100;
      }

      // Expected monthly gain table (WHO, averaged)
      // 0-3m: 0.8kg/mo, 3-6m: 0.5, 6-12m: 0.35, 12-24m: 0.2, 24+m: 0.15
      const ageM = latest.ageMonths;
      let expectedVelocity = 0.2;
      if (ageM < 3) expectedVelocity = 0.8;
      else if (ageM < 6) expectedVelocity = 0.5;
      else if (ageM < 12) expectedVelocity = 0.35;
      else if (ageM < 24) expectedVelocity = 0.25;

      const reasons: string[] = [];
      if (currentPercentile !== null && currentPercentile < 5) {
        reasons.push(`Current weight percentile ${currentPercentile}% (< 5th)`);
      }
      // 2-percentile-band drop — ~25 percentile points
      if (percentileDrop >= 25) {
        reasons.push(
          `Weight percentile dropped ${percentileDrop} points (${earliest.weightPercentile}% → ${latest.weightPercentile}%)`
        );
      }
      if (velocityKgPerMonth !== null && velocityKgPerMonth < expectedVelocity * 0.5) {
        reasons.push(
          `Velocity ${velocityKgPerMonth} kg/mo is below 50% of expected (${expectedVelocity} kg/mo)`
        );
      }

      const isFTT = reasons.length > 0;

      const suggestions: string[] = [];
      if (isFTT) {
        suggestions.push("Evaluate feeding practices and caloric intake");
        suggestions.push("Screen for underlying medical conditions (celiac, GERD, infections)");
        suggestions.push("Refer to nutritionist for dietary plan");
        suggestions.push("Consider social/environmental factors (food security, caregiver stress)");
        suggestions.push("Schedule close follow-up (2-4 weeks)");
      }

      res.json({
        success: true,
        data: {
          isFTT,
          reasons,
          suggestions,
          currentPercentile,
          velocityKgPerMonth,
          expectedVelocityKgPerMonth: expectedVelocity,
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─── MILESTONE CATALOG ────────────────────────────────

// Hardcoded catalog — 30+ CDC/WHO milestones across domains
type MilestoneCatalogItem = { ageMonths: number; domain: string; milestone: string };
const MILESTONE_CATALOG: MilestoneCatalogItem[] = [
  // Gross motor
  { ageMonths: 2, domain: "GROSS_MOTOR", milestone: "Lifts head 45° when on tummy" },
  { ageMonths: 4, domain: "GROSS_MOTOR", milestone: "Holds head steady without support" },
  { ageMonths: 6, domain: "GROSS_MOTOR", milestone: "Rolls from tummy to back" },
  { ageMonths: 9, domain: "GROSS_MOTOR", milestone: "Sits without support" },
  { ageMonths: 9, domain: "GROSS_MOTOR", milestone: "Crawls" },
  { ageMonths: 12, domain: "GROSS_MOTOR", milestone: "Stands with support" },
  { ageMonths: 15, domain: "GROSS_MOTOR", milestone: "Walks independently" },
  { ageMonths: 24, domain: "GROSS_MOTOR", milestone: "Runs and kicks a ball" },
  { ageMonths: 36, domain: "GROSS_MOTOR", milestone: "Pedals a tricycle" },
  // Fine motor
  { ageMonths: 4, domain: "FINE_MOTOR", milestone: "Brings hands to mouth" },
  { ageMonths: 6, domain: "FINE_MOTOR", milestone: "Transfers object hand-to-hand" },
  { ageMonths: 9, domain: "FINE_MOTOR", milestone: "Pincer grasp developing" },
  { ageMonths: 12, domain: "FINE_MOTOR", milestone: "Uses pincer grasp" },
  { ageMonths: 18, domain: "FINE_MOTOR", milestone: "Scribbles with crayon" },
  { ageMonths: 24, domain: "FINE_MOTOR", milestone: "Stacks 4 blocks" },
  { ageMonths: 36, domain: "FINE_MOTOR", milestone: "Draws a circle" },
  { ageMonths: 48, domain: "FINE_MOTOR", milestone: "Draws a person with 3 parts" },
  // Language
  { ageMonths: 2, domain: "LANGUAGE", milestone: "Coos and makes gurgling sounds" },
  { ageMonths: 6, domain: "LANGUAGE", milestone: "Babbles consonant sounds" },
  { ageMonths: 12, domain: "LANGUAGE", milestone: "Says mama/dada with meaning" },
  { ageMonths: 18, domain: "LANGUAGE", milestone: "Uses 10+ single words" },
  { ageMonths: 24, domain: "LANGUAGE", milestone: "2-word phrases" },
  { ageMonths: 36, domain: "LANGUAGE", milestone: "Speaks 3-4 word sentences" },
  { ageMonths: 48, domain: "LANGUAGE", milestone: "Tells a simple story" },
  { ageMonths: 60, domain: "LANGUAGE", milestone: "Speaks clearly in full sentences" },
  // Social
  { ageMonths: 2, domain: "SOCIAL", milestone: "Smiles socially" },
  { ageMonths: 6, domain: "SOCIAL", milestone: "Responds to own name" },
  { ageMonths: 9, domain: "SOCIAL", milestone: "Stranger anxiety; plays peek-a-boo" },
  { ageMonths: 18, domain: "SOCIAL", milestone: "Imitates household tasks" },
  { ageMonths: 24, domain: "SOCIAL", milestone: "Parallel play with peers" },
  { ageMonths: 36, domain: "SOCIAL", milestone: "Shares toys; cooperative play" },
  { ageMonths: 48, domain: "SOCIAL", milestone: "Plays make-believe; follows rules" },
  // Cognitive
  { ageMonths: 6, domain: "COGNITIVE", milestone: "Looks for dropped objects" },
  { ageMonths: 9, domain: "COGNITIVE", milestone: "Object permanence" },
  { ageMonths: 18, domain: "COGNITIVE", milestone: "Points to body parts" },
  { ageMonths: 24, domain: "COGNITIVE", milestone: "Sorts shapes and colors" },
  { ageMonths: 36, domain: "COGNITIVE", milestone: "Understands concept of 2" },
  { ageMonths: 48, domain: "COGNITIVE", milestone: "Counts to 10; names colors" },
  { ageMonths: 60, domain: "COGNITIVE", milestone: "Knows address and phone" },
];

// GET /growth/milestones/catalog?ageMonths=
router.get(
  "/milestones/catalog",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const ageMonths = req.query.ageMonths
        ? parseInt(req.query.ageMonths as string, 10)
        : null;
      const items = ageMonths !== null
        ? MILESTONE_CATALOG.filter((m) => m.ageMonths <= ageMonths)
        : MILESTONE_CATALOG;
      res.json({
        success: true,
        data: {
          ageMonths,
          domains: MILESTONE_DOMAINS,
          milestones: items,
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// POST /growth/milestones
router.post(
  "/milestones",
  authorize(Role.ADMIN, Role.DOCTOR, Role.NURSE),
  validate(milestoneRecordSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { patientId, ageMonths, domain, milestone, achieved, achievedAt, notes } =
        req.body;
      // Upsert by patient + milestone string
      const existing = await prisma.milestoneRecord.findFirst({
        where: { patientId, milestone },
      });
      let record;
      if (existing) {
        record = await prisma.milestoneRecord.update({
          where: { id: existing.id },
          data: {
            ageMonths,
            domain,
            achieved,
            achievedAt: achievedAt ? new Date(achievedAt) : achieved ? new Date() : null,
            notes,
            recordedBy: req.user!.userId,
          },
        });
      } else {
        record = await prisma.milestoneRecord.create({
          data: {
            patientId,
            ageMonths,
            domain,
            milestone,
            achieved,
            achievedAt: achievedAt ? new Date(achievedAt) : achieved ? new Date() : null,
            notes,
            recordedBy: req.user!.userId,
          },
        });
      }
      auditLog(req, "MILESTONE_CREATE", "milestoneRecord", record.id, {
        patientId,
        milestone,
        achieved,
      }).catch(console.error);
      res.status(201).json({ success: true, data: record, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// GET /growth/patient/:id/milestones — list + catalog diff
// #511: PATCHED — verify PATIENT ownership of :id before returning
// milestone catalog diff. Note: an earlier `/patient/:patientId/milestones`
// handler currently shadows this route in Express's matcher; keeping the
// guard here defends against future re-ordering.
router.get(
  "/patient/:id/milestones",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!(await assertPatientOwnsResource(req, res, req.params.id))) return;
      const patient = await prisma.patient.findUnique({
        where: { id: req.params.id },
      });
      if (!patient) {
        res.status(404).json({ success: false, data: null, error: "Patient not found" });
        return;
      }
      const ageM = computeAgeMonths(patient.dateOfBirth);
      const records = await prisma.milestoneRecord.findMany({
        where: { patientId: req.params.id },
        orderBy: { ageMonths: "asc" },
      });
      const byMilestone = new Map<string, (typeof records)[number]>();
      records.forEach((r) => byMilestone.set(r.milestone, r));

      const diff = MILESTONE_CATALOG.map((m) => {
        const rec = byMilestone.get(m.milestone);
        const expected = ageM != null && ageM >= m.ageMonths;
        let status: "ACHIEVED" | "EXPECTED_NOT_ACHIEVED" | "UPCOMING" | "NOT_YET" = "UPCOMING";
        if (rec?.achieved) status = "ACHIEVED";
        else if (expected) status = "EXPECTED_NOT_ACHIEVED";
        else status = "UPCOMING";
        return {
          ...m,
          status,
          achieved: !!rec?.achieved,
          achievedAt: rec?.achievedAt ?? null,
          notes: rec?.notes ?? null,
        };
      });

      const summary = {
        total: diff.length,
        achieved: diff.filter((d) => d.status === "ACHIEVED").length,
        expectedNotAchieved: diff.filter((d) => d.status === "EXPECTED_NOT_ACHIEVED").length,
      };

      res.json({
        success: true,
        data: { ageMonths: ageM, summary, diff },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─── FEEDING LOG ───────────────────────────────────────

// POST /growth/patient/:id/feeding
// #511: PATCHED — PATIENT is in the authorize() list (parents log
// feeds for their own child) but the handler had no per-row ownership
// check, so PATIENT-A could log feeds against PATIENT-B's record.
router.post(
  "/patient/:id/feeding",
  authorize(Role.ADMIN, Role.DOCTOR, Role.NURSE, Role.PATIENT),
  validate(feedingLogSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!(await assertPatientOwnsResource(req, res, req.params.id))) return;
      const patient = await prisma.patient.findUnique({
        where: { id: req.params.id },
        select: { id: true },
      });
      if (!patient) {
        res.status(404).json({ success: false, data: null, error: "Patient not found" });
        return;
      }
      const log = await prisma.feedingLog.create({
        data: {
          patientId: req.params.id,
          loggedAt: req.body.loggedAt ? new Date(req.body.loggedAt) : new Date(),
          feedType: req.body.feedType,
          durationMin: req.body.durationMin,
          volumeMl: req.body.volumeMl,
          foodItem: req.body.foodItem,
          notes: req.body.notes,
          loggedBy: req.user!.userId,
        },
      });
      auditLog(req, "FEEDING_LOG_CREATE", "feedingLog", log.id, {
        patientId: req.params.id,
        feedType: req.body.feedType,
      }).catch(console.error);
      res.status(201).json({ success: true, data: log, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// GET /growth/patient/:id/feeding — list + daily summary
// #511: PATCHED — verify PATIENT ownership of :id before returning
// feeding logs.
router.get(
  "/patient/:id/feeding",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!(await assertPatientOwnsResource(req, res, req.params.id))) return;
      const { from, to, limit = "100" } = req.query as Record<string, string | undefined>;
      const take = Math.min(parseInt(limit || "100"), 500);
      const where: Record<string, unknown> = { patientId: req.params.id };
      if (from || to) {
        const range: Record<string, Date> = {};
        if (from) range.gte = new Date(from);
        if (to) range.lte = new Date(to);
        where.loggedAt = range;
      }
      const logs = await prisma.feedingLog.findMany({
        where,
        orderBy: { loggedAt: "desc" },
        take,
      });

      // Daily summary
      const dailyMap = new Map<
        string,
        { date: string; feeds: number; totalVolumeMl: number; totalDurationMin: number }
      >();
      for (const l of logs) {
        const day = new Date(l.loggedAt).toISOString().slice(0, 10);
        const cur = dailyMap.get(day) ?? {
          date: day,
          feeds: 0,
          totalVolumeMl: 0,
          totalDurationMin: 0,
        };
        cur.feeds += 1;
        cur.totalVolumeMl += l.volumeMl ?? 0;
        cur.totalDurationMin += l.durationMin ?? 0;
        dailyMap.set(day, cur);
      }
      const daily = Array.from(dailyMap.values()).sort((a, b) =>
        a.date.localeCompare(b.date)
      );

      res.json({
        success: true,
        data: {
          logs,
          daily,
          totalLogs: logs.length,
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// DELETE /growth/feeding/:id
router.delete(
  "/feeding/:id",
  authorize(Role.ADMIN, Role.DOCTOR, Role.NURSE),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await prisma.feedingLog.delete({ where: { id: req.params.id } });
      auditLog(req, "FEEDING_LOG_DELETE", "feedingLog", req.params.id, {}).catch(
        console.error
      );
      res.json({ success: true, data: { id: req.params.id }, error: null });
    } catch (err) {
      next(err);
    }
  }
);

export { router as growthRouter };
