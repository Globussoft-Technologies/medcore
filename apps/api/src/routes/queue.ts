import { Router, Request, Response, NextFunction } from "express";
// Multi-tenant wiring: `tenantScopedPrisma` is a Prisma $extends wrapper that
// auto-injects tenantId on create and auto-filters on read for the 20
// tenant-scoped models (see services/tenant-prisma.ts). We alias it to
// `prisma` so every existing call site keeps working without edits.
import { tenantScopedPrisma as prisma } from "../services/tenant-prisma";
import { authenticate, authorize } from "../middleware/auth";
import { Role } from "@medcore/shared";
import {
  notifyQueuePosition,
  broadcastQueuePositions,
} from "../services/notification-triggers";

const router = Router();

// Every queue endpoint requires auth. Issue #383 (Apr 2026 RBAC sweep) added
// per-route authorize() decorators but missed `authenticate`, so calls were
// 401-ing on req.user being undefined. Apply once at the router level.
router.use(authenticate);

// Helper: compute vulnerable-group indicators for a patient
function computeVulnerableFlags(input: {
  age: number | null;
  dob: Date | null;
  gender: string;
  activeAncCaseId?: string | null;
}): { isSenior: boolean; isChild: boolean; isPregnant: boolean; ageYears: number | null } {
  let ageYears: number | null = input.age ?? null;
  if (!ageYears && input.dob) {
    const diffMs = Date.now() - new Date(input.dob).getTime();
    ageYears = Math.floor(diffMs / (365.25 * 24 * 60 * 60 * 1000));
  }
  const isSenior = ageYears !== null && ageYears >= 65;
  const isChild = ageYears !== null && ageYears < 5;
  const isPregnant = input.gender === "FEMALE" && Boolean(input.activeAncCaseId);
  return { isSenior, isChild, isPregnant, ageYears };
}

// Priority weighting for vulnerable patients — used to re-order queue
function vulnerabilityRank(flags: {
  isSenior: boolean;
  isChild: boolean;
  isPregnant: boolean;
}): number {
  let rank = 0;
  if (flags.isChild) rank += 3;
  if (flags.isPregnant) rank += 2;
  if (flags.isSenior) rank += 1;
  return rank;
}

// GET /api/v1/queue/:doctorId?date=YYYY-MM-DD&dedupePatient=1
// Public endpoint for token display.
// `dedupePatient=1` collapses repeat patients to a single entry — the most
// recent appointment per patientId (Issue #91 Apr 2026: Anita Deshpande
// appearing 3x in the vitals queue). The full multi-row form remains the
// default so the consultation queue is unaffected.
router.get(
  "/:doctorId",
  // Issue #383 (CRITICAL prod RBAC bypass, Apr 29 2026): every authenticated
  // user — including PATIENT — could read another doctor's full queue
  // (token #, patient name, status). Restrict to clinical/operational staff.
  authorize(Role.ADMIN, Role.RECEPTION, Role.DOCTOR, Role.NURSE),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { date, dedupePatient } = req.query;
      const dateObj = date ? new Date(date as string) : new Date();
      dateObj.setHours(0, 0, 0, 0);

      const appointments = await prisma.appointment.findMany({
        where: {
          doctorId: req.params.doctorId,
          date: dateObj,
          status: { notIn: ["CANCELLED", "NO_SHOW"] },
        },
        include: {
          patient: {
            include: {
              user: { select: { name: true } },
              ancCase: { select: { id: true, deliveredAt: true } },
            },
          },
          vitals: true,
        },
        orderBy: [
          { priority: "desc" },
          { tokenNumber: "asc" },
        ],
      });

      const currentPatient = appointments.find(
        (a) => a.status === "IN_CONSULTATION"
      );
      const avgConsultTime = 15; // minutes — can be made dynamic later

      // Compute vulnerable flags and re-sort (active consultation stays on top)
      const enriched = appointments.map((a) => {
        const activeAncCaseId = a.patient.ancCase && !a.patient.ancCase.deliveredAt
          ? a.patient.ancCase.id
          : null;
        const flags = computeVulnerableFlags({
          age: a.patient.age ?? null,
          dob: a.patient.dateOfBirth ?? null,
          gender: a.patient.gender,
          activeAncCaseId,
        });
        return { a, flags, rank: vulnerabilityRank(flags) };
      });

      // Keep IN_CONSULTATION + existing explicit priority, then vulnerable group rank
      const priorityWeight = (p: string): number =>
        p === "EMERGENCY" ? 3 : p === "HIGH" ? 2 : p === "NORMAL" ? 1 : 0;
      enriched.sort((x, y) => {
        // Active consultation first
        if (x.a.status === "IN_CONSULTATION" && y.a.status !== "IN_CONSULTATION") return -1;
        if (y.a.status === "IN_CONSULTATION" && x.a.status !== "IN_CONSULTATION") return 1;
        // Explicit priority
        const pd = priorityWeight(y.a.priority) - priorityWeight(x.a.priority);
        if (pd !== 0) return pd;
        // Vulnerability bump
        const rd = y.rank - x.rank;
        if (rd !== 0) return rd;
        // Fall back to token order
        return x.a.tokenNumber - y.a.tokenNumber;
      });

      // Dedupe-per-patient mode: keep the highest-priority entry (already
      // sorted), drop later occurrences of the same patientId.
      const enrichedFinal = (() => {
        if (dedupePatient !== "1" && dedupePatient !== "true") return enriched;
        const seen = new Set<string>();
        return enriched.filter((e) => {
          if (seen.has(e.a.patientId)) return false;
          seen.add(e.a.patientId);
          return true;
        });
      })();

      const queue = enrichedFinal.map(({ a, flags }, idx) => {
        let estimatedWaitMinutes = 0;
        if (a.status === "BOOKED" || a.status === "CHECKED_IN") {
          const ahead = enrichedFinal
            .slice(0, idx)
            .filter(
              ({ a: ap }) =>
                ap.status === "BOOKED" ||
                ap.status === "CHECKED_IN" ||
                ap.status === "IN_CONSULTATION"
            ).length;
          estimatedWaitMinutes = ahead * avgConsultTime;
        }

        return {
          tokenNumber: a.tokenNumber,
          patientName: a.patient.user.name,
          patientId: a.patientId,
          appointmentId: a.id,
          type: a.type,
          status: a.status,
          priority: a.priority,
          slotTime: a.slotStart,
          hasVitals: !!a.vitals,
          estimatedWaitMinutes,
          vulnerableFlags: {
            isSenior: flags.isSenior,
            isChild: flags.isChild,
            isPregnant: flags.isPregnant,
            ageYears: flags.ageYears,
          },
        };
      });

      res.json({
        success: true,
        data: {
          doctorId: req.params.doctorId,
          date: dateObj.toISOString().split("T")[0],
          currentToken: currentPatient?.tokenNumber ?? null,
          totalInQueue: queue.filter(
            (q) =>
              q.status === "BOOKED" ||
              q.status === "CHECKED_IN" ||
              q.status === "IN_CONSULTATION"
          ).length,
          queue,
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/queue — all doctors' current tokens (for display board)
router.get(
  "/",
  // Issue #383: see above. Same role set.
  authorize(Role.ADMIN, Role.RECEPTION, Role.DOCTOR, Role.NURSE),
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      const doctors = await prisma.doctor.findMany({
        include: {
          user: { select: { name: true } },
        },
      });

      const display = await Promise.all(
        doctors.map(async (doc) => {
          const current = await prisma.appointment.findFirst({
            where: {
              doctorId: doc.id,
              date: today,
              status: "IN_CONSULTATION",
            },
          });

          const waitingCount = await prisma.appointment.count({
            where: {
              doctorId: doc.id,
              date: today,
              status: { in: ["BOOKED", "CHECKED_IN"] },
            },
          });

          return {
            doctorId: doc.id,
            doctorName: doc.user.name,
            specialization: doc.specialization,
            currentToken: current?.tokenNumber ?? null,
            waitingCount,
          };
        })
      );

      res.json({ success: true, data: display, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/v1/queue/notify-position/:appointmentId — manual position SMS
router.post(
  "/notify-position/:appointmentId",
  authenticate,
  authorize(Role.ADMIN, Role.RECEPTION, Role.DOCTOR, Role.NURSE),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await notifyQueuePosition(req.params.appointmentId);
      res.json({ success: true, data: { notified: true }, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/v1/queue/broadcast-positions — cron stub: re-send to all waiting
router.post(
  "/broadcast-positions",
  authenticate,
  authorize(Role.ADMIN, Role.RECEPTION),
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      await broadcastQueuePositions();
      res.json({ success: true, data: { broadcast: true }, error: null });
    } catch (err) {
      next(err);
    }
  }
);

export { router as queueRouter };
