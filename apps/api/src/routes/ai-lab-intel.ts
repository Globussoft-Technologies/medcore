import { Router, Request, Response, NextFunction } from "express";
// Multi-tenant wiring: `tenantScopedPrisma` is a Prisma $extends wrapper that
// auto-injects tenantId on create and auto-filters on read for the 20
// tenant-scoped models (see services/tenant-prisma.ts). We alias it to
// `prisma` so every existing call site keeps working without edits.
import { tenantScopedPrisma as prisma } from "../services/tenant-prisma";
import { Role } from "@medcore/shared";
import { z, ZodError } from "zod";
import { authenticate, authorize } from "../middleware/auth";
import { auditLog } from "../middleware/audit";
import { rateLimit } from "../middleware/rate-limit";
import { analyzeLabResult } from "../services/ai/lab-intel";
import {
  computePatientBaseline,
  isBaselineDeviation,
  type PatientVitalsBaseline,
} from "../services/vitals-baseline";

const router = Router();
router.use(authenticate);

// security(2026-04-23-med): F-LAB-INTEL-1 — LLM-backed; cap to 20/min/IP.
if (process.env.NODE_ENV !== "test") {
  router.use(rateLimit(20, 60_000));
}

// ── helpers ─────────────────────────────────────────────────────────────────

/**
 * Read-only roles allowed to consume the dashboard list endpoints below.
 * Mirrors `ALLOWED_ROLES` in apps/web/src/app/dashboard/lab-intel/page.tsx
 * (issue #179 pattern): DOCTOR / ADMIN have full access, NURSE is read-only.
 * Compute/persist endpoints further down stay locked to DOCTOR / ADMIN.
 */
const READ_ROLES = [Role.DOCTOR, Role.ADMIN, Role.NURSE] as const;

function startOfDay(iso: string): Date {
  const d = new Date(`${iso}T00:00:00.000Z`);
  return d;
}

function endOfDay(iso: string): Date {
  const d = new Date(`${iso}T23:59:59.999Z`);
  return d;
}

const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

const dateRangeSchema = z
  .object({
    from: isoDateSchema.optional(),
    to: isoDateSchema.optional(),
  })
  .refine(
    (v) => !v.from || !v.to || v.from <= v.to,
    { message: "`from` must be on or before `to`" }
  );

const criticalQuerySchema = dateRangeSchema.and(
  z.object({
    severity: z.enum(["HIGH", "LOW", "CRITICAL"]).optional(),
  })
);

function parseQueryOr400<T>(
  schema: { parse: (v: unknown) => T },
  query: unknown,
  res: Response
): T | null {
  try {
    return schema.parse(query);
  } catch (err) {
    if (err instanceof ZodError) {
      res.status(400).json({
        success: false,
        data: null,
        error: err.issues.map((i) => i.message).join("; "),
      });
      return null;
    }
    throw err;
  }
}

function tryNumeric(value: string): number | null {
  // LabResult.value is free-text — pull the leading numeric portion if any.
  const m = value.trim().match(/^-?\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = parseFloat(m[0]);
  return Number.isFinite(n) ? n : null;
}

// ── GET /api/v1/ai/lab-intel/aggregates ─────────────────────────────────────
//
// KPI tile counts for the dashboard header. Returns the four numbers the
// `/dashboard/lab-intel` page binds to (see `LabIntelAggregates` in
// apps/web/src/app/dashboard/lab-intel/page.tsx).

router.get(
  "/aggregates",
  authorize(...READ_ROLES),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = parseQueryOr400(dateRangeSchema, req.query, res);
      if (!parsed) return;

      // Sensible default window: last 7 days, ending today (UTC).
      const now = new Date();
      const fromDate = parsed.from
        ? startOfDay(parsed.from)
        : new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      const toDate = parsed.to ? endOfDay(parsed.to) : now;

      const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

      const [criticalsThisWeek, outsideRange, abnormalRecent] = await Promise.all([
        prisma.labResult.count({
          where: {
            flag: "CRITICAL",
            reportedAt: { gte: sevenDaysAgo, lte: now },
          },
        }),
        prisma.labResult.count({
          where: {
            flag: { in: ["HIGH", "LOW", "CRITICAL"] },
            reportedAt: { gte: fromDate, lte: toDate },
          },
        }),
        // Pull a bounded slice of recent abnormal labs to estimate avg deviation %.
        prisma.labResult.findMany({
          where: {
            flag: { in: ["HIGH", "LOW", "CRITICAL"] },
            reportedAt: { gte: fromDate, lte: toDate },
          },
          select: { value: true, normalRange: true },
          orderBy: { reportedAt: "desc" },
          take: 200,
        }),
      ]);

      // Average deviation % — how far each abnormal result lies from the
      // midpoint of its reference range. Skip rows where the range can't
      // be parsed; fall back to 0 if the slice is empty.
      const deviations: number[] = [];
      for (const row of abnormalRecent) {
        const v = tryNumeric(row.value);
        if (v === null || !row.normalRange) continue;
        const m = row.normalRange.match(
          /(-?\d+(?:\.\d+)?)\s*[-–—]\s*(-?\d+(?:\.\d+)?)/
        );
        if (!m) continue;
        const lo = parseFloat(m[1]);
        const hi = parseFloat(m[2]);
        if (!Number.isFinite(lo) || !Number.isFinite(hi)) continue;
        const mid = (lo + hi) / 2;
        if (mid === 0) continue;
        deviations.push(Math.abs(((v - mid) / mid) * 100));
      }
      const averageDeviationPct =
        deviations.length === 0
          ? 0
          : deviations.reduce((a, b) => a + b, 0) / deviations.length;

      // Count distinct patients flagged with a >20% baseline deviation on
      // any vital captured in the window. Bounded scan — per-patient
      // baselines are computed lazily via computePatientBaseline().
      const recentVitals = await prisma.vitals.findMany({
        where: { recordedAt: { gte: fromDate, lte: toDate } },
        orderBy: { recordedAt: "desc" },
        take: 500,
        select: {
          patientId: true,
          bloodPressureSystolic: true,
          bloodPressureDiastolic: true,
          pulseRate: true,
          spO2: true,
          temperature: true,
          respiratoryRate: true,
        },
      });
      const seenPatients = new Set<string>();
      const flaggedPatients = new Set<string>();
      for (const v of recentVitals) {
        if (seenPatients.has(v.patientId)) continue;
        seenPatients.add(v.patientId);
        const baseline = await computePatientBaseline(v.patientId);
        const deviates =
          isBaselineDeviation(v.bloodPressureSystolic, baseline.bpSystolic.baseline) ||
          isBaselineDeviation(v.bloodPressureDiastolic, baseline.bpDiastolic.baseline) ||
          isBaselineDeviation(v.pulseRate, baseline.pulse.baseline) ||
          isBaselineDeviation(v.spO2, baseline.spO2.baseline) ||
          isBaselineDeviation(v.temperature, baseline.temperature.baseline) ||
          isBaselineDeviation(v.respiratoryRate, baseline.respiratoryRate.baseline);
        if (deviates) flaggedPatients.add(v.patientId);
      }

      const data = {
        criticalsThisWeek,
        patientsWithTrendConcerns: flaggedPatients.size,
        testsOutsideRefRange: outsideRange,
        averageDeviationPct: +averageDeviationPct.toFixed(1),
      };

      auditLog(req, "AI_LAB_INTEL_AGGREGATES_VIEW", "LabResult", undefined, {
        from: fromDate.toISOString(),
        to: toDate.toISOString(),
      }).catch((err) => {
        console.warn(
          `[audit] AI_LAB_INTEL_AGGREGATES_VIEW failed (non-fatal):`,
          (err as Error)?.message ?? err
        );
      });

      res.json({ success: true, data, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// ── GET /api/v1/ai/lab-intel/critical ──────────────────────────────────────
//
// DataTable rows of critical-flagged lab results in the date range.
// Optional `severity` filter narrows to a single LabResultFlag value.
// Response shape matches `CriticalRow[]` in
// apps/web/src/app/dashboard/lab-intel/page.tsx.

router.get(
  "/critical",
  authorize(...READ_ROLES),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = parseQueryOr400(criticalQuerySchema, req.query, res);
      if (!parsed) return;

      const now = new Date();
      const fromDate = parsed.from
        ? startOfDay(parsed.from)
        : new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      const toDate = parsed.to ? endOfDay(parsed.to) : now;

      // Default to abnormal flags only (CRITICAL + HIGH) when the caller
      // doesn't pass `severity`. The dashboard's empty-string select value
      // is dropped client-side, so we only see real values here.
      const flagFilter = parsed.severity
        ? parsed.severity
        : { in: ["CRITICAL", "HIGH"] as ("CRITICAL" | "HIGH")[] };

      const rows = await prisma.labResult.findMany({
        where: {
          flag: flagFilter,
          reportedAt: { gte: fromDate, lte: toDate },
        },
        orderBy: { reportedAt: "desc" },
        take: 500,
        include: {
          orderItem: {
            include: {
              order: {
                select: {
                  id: true,
                  patientId: true,
                  patient: {
                    select: { user: { select: { name: true } } },
                  },
                },
              },
            },
          },
        },
      });

      // CRITICAL flag maps to "CRITICAL" severity; HIGH and LOW both surface
      // as "HIGH" in the UI badge (matching the dashboard's Severity union
      // which only allows CRITICAL | HIGH).
      const data = rows.map((r) => ({
        id: r.id,
        patientId: r.orderItem.order.patientId,
        patientName: r.orderItem.order.patient?.user?.name ?? "Unknown",
        testName: r.parameter,
        result: r.value,
        unit: r.unit,
        referenceRange: r.normalRange ?? "",
        severity: r.flag === "CRITICAL" ? "CRITICAL" : "HIGH",
        flaggedAt: r.reportedAt.toISOString(),
        labOrderId: r.orderItem.order.id,
      }));

      auditLog(req, "AI_LAB_INTEL_CRITICAL_LIST", "LabResult", undefined, {
        from: fromDate.toISOString(),
        to: toDate.toISOString(),
        severity: parsed.severity ?? null,
        count: data.length,
      }).catch((err) => {
        console.warn(
          `[audit] AI_LAB_INTEL_CRITICAL_LIST failed (non-fatal):`,
          (err as Error)?.message ?? err
        );
      });

      res.json({ success: true, data, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// ── GET /api/v1/ai/lab-intel/deviations ─────────────────────────────────────
//
// List of patients whose latest vitals deviate >20% from their personal
// baseline (per `services/vitals-baseline.ts:isBaselineDeviation`). One row
// per (patient, vital parameter) pair so multiple parameters for the same
// patient surface independently in the dashboard's deviation list.

const VITAL_FIELDS: Array<{
  key: keyof Pick<
    PatientVitalsBaseline,
    "bpSystolic" | "bpDiastolic" | "pulse" | "spO2" | "temperature" | "respiratoryRate"
  >;
  column:
    | "bloodPressureSystolic"
    | "bloodPressureDiastolic"
    | "pulseRate"
    | "spO2"
    | "temperature"
    | "respiratoryRate";
  label: string;
}> = [
  { key: "bpSystolic", column: "bloodPressureSystolic", label: "Systolic BP" },
  { key: "bpDiastolic", column: "bloodPressureDiastolic", label: "Diastolic BP" },
  { key: "pulse", column: "pulseRate", label: "Pulse" },
  { key: "spO2", column: "spO2", label: "SpO2" },
  { key: "temperature", column: "temperature", label: "Temperature" },
  { key: "respiratoryRate", column: "respiratoryRate", label: "Respiratory Rate" },
];

router.get(
  "/deviations",
  authorize(...READ_ROLES),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = parseQueryOr400(dateRangeSchema, req.query, res);
      if (!parsed) return;

      const now = new Date();
      const fromDate = parsed.from
        ? startOfDay(parsed.from)
        : new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      const toDate = parsed.to ? endOfDay(parsed.to) : now;

      // Pick up to 500 of the most recent vitals readings in the window —
      // dedupe to one (the latest) per patient so we compare only their
      // freshest reading against the baseline.
      const recent = await prisma.vitals.findMany({
        where: { recordedAt: { gte: fromDate, lte: toDate } },
        orderBy: { recordedAt: "desc" },
        take: 500,
        select: {
          patientId: true,
          bloodPressureSystolic: true,
          bloodPressureDiastolic: true,
          pulseRate: true,
          spO2: true,
          temperature: true,
          respiratoryRate: true,
          recordedAt: true,
          patient: {
            select: { user: { select: { name: true } } },
          },
        },
      });

      const latestPerPatient = new Map<string, (typeof recent)[number]>();
      for (const v of recent) {
        if (!latestPerPatient.has(v.patientId)) {
          latestPerPatient.set(v.patientId, v);
        }
      }

      const out: Array<{
        patientId: string;
        patientName: string;
        parameter: string;
        recentValues: number[];
        deviationPct: number;
        direction: "up" | "down";
      }> = [];

      for (const [patientId, latest] of latestPerPatient) {
        const baseline = await computePatientBaseline(patientId);
        const patientName = latest.patient?.user?.name ?? "Unknown";

        for (const field of VITAL_FIELDS) {
          const current = latest[field.column];
          const stat = baseline[field.key];
          if (
            typeof current !== "number" ||
            stat.baseline === null ||
            stat.baseline === 0
          ) {
            continue;
          }
          if (!isBaselineDeviation(current, stat.baseline)) continue;

          // Pull the patient's last 5 readings for this column so the
          // dashboard sparkline has something to draw.
          const history = await prisma.vitals.findMany({
            where: { patientId, [field.column]: { not: null } } as Record<
              string,
              unknown
            >,
            orderBy: { recordedAt: "desc" },
            take: 5,
            select: { [field.column]: true },
          });
          const recentValues = history
            .map((h) => (h as Record<string, unknown>)[field.column])
            .filter((n): n is number => typeof n === "number")
            .reverse();

          const deviationPct = ((current - stat.baseline) / stat.baseline) * 100;
          out.push({
            patientId,
            patientName,
            parameter: field.label,
            recentValues,
            deviationPct: +deviationPct.toFixed(1),
            direction: deviationPct >= 0 ? "up" : "down",
          });
        }
      }

      auditLog(req, "AI_LAB_INTEL_DEVIATIONS_VIEW", "Patient", undefined, {
        from: fromDate.toISOString(),
        to: toDate.toISOString(),
        count: out.length,
      }).catch((err) => {
        console.warn(
          `[audit] AI_LAB_INTEL_DEVIATIONS_VIEW failed (non-fatal):`,
          (err as Error)?.message ?? err
        );
      });

      res.json({ success: true, data: out, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/ai/lab-intel/:labResultId — compute (and return, ephemeral) analysis
router.get(
  "/:labResultId",
  authorize(Role.DOCTOR, Role.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { labResultId } = req.params;

      const existing = await prisma.labResult.findUnique({ where: { id: labResultId } });
      if (!existing) {
        res.status(404).json({ success: false, data: null, error: "LabResult not found" });
        return;
      }

      const analysis = await analyzeLabResult(labResultId);

      auditLog(req, "AI_LAB_INTEL_ANALYZE", "LabResult", labResultId, {
        urgency: analysis.urgency,
        trend: analysis.trend,
      }).catch((err) => {
        console.warn(`[audit] AI_LAB_INTEL_ANALYZE failed (non-fatal):`, (err as Error)?.message ?? err);
      });

      res.json({ success: true, data: { analysis }, error: null });
    } catch (err) {
      if ((err as any)?.statusCode === 404) {
        res.status(404).json({ success: false, data: null, error: "LabResult not found" });
        return;
      }
      next(err);
    }
  }
);

// POST /api/v1/ai/lab-intel/:labResultId/persist — store analysis on LabResult
router.post(
  "/:labResultId/persist",
  authorize(Role.DOCTOR, Role.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { labResultId } = req.params;

      const existing = await prisma.labResult.findUnique({ where: { id: labResultId } });
      if (!existing) {
        res.status(404).json({ success: false, data: null, error: "LabResult not found" });
        return;
      }

      // Allow caller to post a pre-computed analysis (e.g. from the GET call),
      // otherwise compute fresh. Both paths end up writing the same shape.
      const analysis = req.body?.analysis ?? (await analyzeLabResult(labResultId));

      // NOTE: `aiAnalysis` and `aiAnalyzedAt` columns are proposed in
      // services/.prisma-models-doctor-tools.md but not yet in schema.prisma.
      // Until they ship, we persist via the LabResult.notes field as a JSON
      // blob prefix so no schema change is required. Once the columns exist
      // the update() call should target them directly.
      const existingNotes = existing.notes ?? "";
      const serialised = `[AI_INTEL]${JSON.stringify(analysis)}[/AI_INTEL]`;
      const cleaned = existingNotes.replace(/\[AI_INTEL\][\s\S]*?\[\/AI_INTEL\]/, "").trim();
      const newNotes = [cleaned, serialised].filter(Boolean).join("\n");

      const updated = await prisma.labResult.update({
        where: { id: labResultId },
        data: { notes: newNotes },
      });

      auditLog(req, "AI_LAB_INTEL_PERSIST", "LabResult", labResultId, {
        urgency: analysis.urgency,
      }).catch((err) => {
        console.warn(`[audit] AI_LAB_INTEL_PERSIST failed (non-fatal):`, (err as Error)?.message ?? err);
      });

      res.status(201).json({
        success: true,
        data: { labResultId: updated.id, analysis, persistedAt: new Date().toISOString() },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

export { router as aiLabIntelRouter };
