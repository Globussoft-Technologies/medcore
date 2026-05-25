import { Router, Request, Response, NextFunction } from "express";
import { tenantScopedPrisma as prisma } from "../services/tenant-prisma";
import { Role } from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";
import { auditLog } from "../middleware/audit";
import { validateUuidParams } from "../middleware/validate-params";
import { assertPatientOwnsResource } from "../middleware/patient-self-only";
import { requireFeature } from "../middleware/feature-flag";
import { evaluateThresholds } from "../services/chronic-care-scheduler";

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
// Pearl §6 + §18 (gap item #9 — audit fix-up #3, 2026-05-25): chronic-care
// AI coaching is a Stage-2 paid feature. Pearl-branded tenants set
// `aiCoaching=false` and every coaching route 404s before authorize runs.
router.use(requireFeature("aiCoaching"));
// #511 audit (file-level, 2026-05-09): /enroll is staff-only
// (`authorize(Role.DOCTOR, Role.ADMIN)`). /plans/:patientId admits PATIENT
// and uses `assertPatientOwnsResource` against the URL `:patientId`.
// /plans/:id/check-in is `authorize(Role.PATIENT)`-only and verifies the
// loaded plan's `patientId` via `assertPatientOwnsResource` so a patient
// cannot post check-ins against another patient's plan. Verified-safe.

const VALID_CONDITIONS = new Set([
  "DIABETES",
  "HYPERTENSION",
  "ASTHMA",
  "TB",
  "OTHER",
]);

const VALID_FREQUENCIES = new Set([1, 3, 7]);

// ── POST /api/v1/ai/coaching/enroll ───────────────────────────────────────────

router.post(
  "/enroll",
  authorize(Role.DOCTOR, Role.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { patientId, condition, checkInFrequencyDays, thresholds } =
        (req.body ?? {}) as {
          patientId?: string;
          condition?: string;
          checkInFrequencyDays?: number;
          thresholds?: Record<string, unknown>;
        };

      if (!patientId || typeof patientId !== "string") {
        res.status(400).json({ success: false, data: null, error: "patientId is required" });
        return;
      }
      if (!condition || !VALID_CONDITIONS.has(condition)) {
        res.status(400).json({
          success: false,
          data: null,
          error: "condition must be one of DIABETES, HYPERTENSION, ASTHMA, TB, OTHER",
        });
        return;
      }
      const freq = Number(checkInFrequencyDays);
      if (!VALID_FREQUENCIES.has(freq)) {
        res.status(400).json({
          success: false,
          data: null,
          error: "checkInFrequencyDays must be 1, 3, or 7",
        });
        return;
      }

      const patient = await prisma.patient.findUnique({
        where: { id: patientId },
        select: { id: true },
      });
      if (!patient) {
        res.status(404).json({ success: false, data: null, error: "Patient not found" });
        return;
      }

      const plan = await prisma.chronicCarePlan.create({
        data: {
          patientId,
          condition: condition as any,
          checkInFrequencyDays: freq,
          thresholds: (thresholds ?? {}) as any,
          active: true,
          createdBy: req.user!.userId,
        },
      });

      await auditLog(req, "CHRONIC_CARE_ENROLL", "ChronicCarePlan", plan.id, {
        patientId,
        condition,
        checkInFrequencyDays: freq,
      });

      res.status(201).json({ success: true, data: plan, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// ── GET /api/v1/ai/coaching/plans/:patientId ──────────────────────────────────

router.get(
  "/plans/:patientId",
  validateUuidParams(["patientId"]),
  // security(2026-05-04-med): issue #511 BOLA sweep — pre-gate role at the
  // mount. PATIENT falls through to the per-row owner check below; staff
  // (ADMIN/DOCTOR/NURSE) pass `assertPatientOwnsResource` unconditionally.
  authorize(Role.ADMIN, Role.DOCTOR, Role.NURSE, Role.PATIENT),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { patientId } = req.params;

      // security(2026-05-04-med): issue #511 — canonical per-row ownership
      // helper. Staff roles (ADMIN/DOCTOR/NURSE) cleared the authorize gate
      // and short-circuit to true; PATIENT must own the patient row keyed
      // by `:patientId` or receive a 403.
      if (!(await assertPatientOwnsResource(req, res, patientId))) return;

      const plans = await prisma.chronicCarePlan.findMany({
        where: { patientId, active: true },
        orderBy: { createdAt: "desc" },
      });

      safeAudit(req, "CHRONIC_CARE_READ", "ChronicCarePlan", undefined, {
        patientId,
        count: plans.length,
      });

      res.json({ success: true, data: plans, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// ── POST /api/v1/ai/coaching/plans/:id/check-in ───────────────────────────────

router.post(
  "/plans/:id/check-in",
  validateUuidParams(["id"]),
  authorize(Role.PATIENT),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const { responses } = (req.body ?? {}) as {
        responses?: Record<string, unknown>;
      };

      if (!responses || typeof responses !== "object" || Array.isArray(responses)) {
        res.status(400).json({
          success: false,
          data: null,
          error: "responses must be an object mapping metric -> value",
        });
        return;
      }

      const plan = await prisma.chronicCarePlan.findUnique({
        where: { id },
      });
      if (!plan) {
        res.status(404).json({ success: false, data: null, error: "Plan not found" });
        return;
      }

      // security(2026-05-04-med): issue #511 — canonical per-row ownership
      // helper. The route-level `authorize(Role.PATIENT)` ensures only
      // patients reach this point; the helper then asserts the plan's
      // patientId resolves to the caller's own user row.
      if (!(await assertPatientOwnsResource(req, res, plan.patientId))) return;

      const thresholds = (plan.thresholds as Record<string, number>) || {};
      const breaches = evaluateThresholds(thresholds, responses);

      const checkIn = await prisma.chronicCareCheckIn.create({
        data: {
          planId: plan.id,
          patientId: plan.patientId,
          responses: responses as any,
          thresholdsBreached: (breaches as any) ?? undefined,
        },
      });

      let alert: any = null;
      if (breaches && breaches.length > 0) {
        const severity =
          breaches.length >= 3
            ? "CRITICAL"
            : breaches.length === 2
            ? "HIGH"
            : "MEDIUM";
        const reason = breaches
          .map((b) => `${b.key} observed ${b.observed} (>= threshold ${b.threshold})`)
          .join("; ");
        alert = await prisma.chronicCareAlert.create({
          data: {
            planId: plan.id,
            patientId: plan.patientId,
            severity: severity as any,
            reason,
          },
        });
      }

      await auditLog(req, "CHRONIC_CARE_CHECKIN", "ChronicCareCheckIn", checkIn.id, {
        planId: plan.id,
        breachCount: breaches?.length ?? 0,
        alertCreated: !!alert,
      });

      res.status(201).json({
        success: true,
        data: { checkIn, alert },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

export { router as aiCoachingRouter };
