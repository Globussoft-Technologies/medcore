import { Router, Request, Response, NextFunction } from "express";
import { prisma } from "@medcore/db";
import { authenticate } from "../middleware/auth";

const router = Router();

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

// GET /api/v1/queue/:doctorId?date=YYYY-MM-DD — get doctor's queue for a date
// Public endpoint for token display
router.get(
  "/:doctorId",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { date } = req.query;
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

      const queue = enriched.map(({ a, flags }, idx) => {
        let estimatedWaitMinutes = 0;
        if (a.status === "BOOKED" || a.status === "CHECKED_IN") {
          const ahead = enriched
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

export { router as queueRouter };
