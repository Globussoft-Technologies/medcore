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

// GET /api/v1/queue/display — PUBLIC waiting-room token board (no auth).
// Powers the unattended display TV at /display. Declared BEFORE the
// router-level `authenticate` below so it stays public, and returns only
// non-PHI data (doctor name, current/next token, arrival seq, waiting count;
// any patient names are redacted to "First L." by buildDisplayBoard).
// NOTE (multi-tenant): with no auth there's no tenant context, so the query
// runs unscoped — correct for a single-hospital deployment. A multi-tenant
// rollout should pass a tenant identifier (subdomain / param) and wrap the
// call in runWithTenant().
router.get(
  "/display",
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      res.json({ success: true, data: await buildDisplayBoard(), error: null });
    } catch (err) {
      next(err);
    }
  },
);

// Every queue endpoint BELOW requires auth. Issue #383 (Apr 2026 RBAC sweep)
// added per-route authorize() decorators but missed `authenticate`, so calls
// were 401-ing on req.user being undefined. Apply once at the router level.
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
  // Child = age 5 or under (≤ 5), so a 5-year-old is flagged too.
  const isChild = ageYears !== null && ageYears <= 5;
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
      // `appointment.date` is a @db.Date column — Prisma stores/reads it at
      // UTC midnight. Build the day window with setUTCHours (NOT setHours,
      // which uses the server's LOCAL time and shifts the window on any
      // non-UTC host, leaking adjacent-day rows into the queue) and use a
      // next-midnight EXCLUSIVE upper bound. Matches appointments.ts.
      const dayStart = date ? new Date(date as string) : new Date();
      dayStart.setUTCHours(0, 0, 0, 0);
      const dayEnd = new Date(dayStart);
      dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);

      // The doctor's booking mode decides how the queue is ordered within a
      // presence tier: CALLING is a pure arrival/check-in queue (tokens are
      // ignored — a stale token from a prior mode must not jump a patient
      // ahead of someone who arrived earlier); TOKEN/SLOT order by token.
      const queueDoctor = await prisma.doctor.findUnique({
        where: { id: req.params.doctorId },
        select: { appointmentMode: true },
      });
      const isCallingMode = queueDoctor?.appointmentMode === "CALLING";

      const appointments = await prisma.appointment.findMany({
        where: {
          doctorId: req.params.doctorId,
          date: { gte: dayStart, lt: dayEnd },
          status: { notIn: ["CANCELLED", "NO_SHOW"] },
        },
        include: {
          patient: {
            include: {
              user: { select: { name: true, photoUrl: true } },
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
      const nowMs = Date.now();

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
      // Presence rank — who can actually be seen, highest first:
      //   IN_CONSULTATION (being seen) > CHECKED_IN (arrived, waiting) >
      //   BOOKED (not arrived yet) > terminal (COMPLETED, …).
      // A checked-in patient is always ahead of a booked one in the live
      // queue: you call the patient who is physically present, not one who
      // booked but hasn't shown up.
      const presenceRank = (s: string): number =>
        s === "IN_CONSULTATION" ? 3 : s === "CHECKED_IN" ? 2 : s === "BOOKED" ? 1 : 0;
      // CHECK-IN order (FIFO) — by EXACT checkInAt timestamp (millisecond
      // precision, so two patients who check in within the same minute still
      // order by their actual seconds). The actively-called patient comes
      // first; not-yet-checked-in rows fall back to arrivalSeq, then createdAt.
      const cmpCheckIn = (
        x: (typeof enriched)[number],
        y: (typeof enriched)[number],
      ): number => {
        const xCall = x.a.calledAt ? new Date(x.a.calledAt).getTime() : null;
        const yCall = y.a.calledAt ? new Date(y.a.calledAt).getTime() : null;
        if (xCall != null && yCall != null && xCall !== yCall)
          return xCall - yCall;
        if (xCall != null && yCall == null) return -1;
        if (xCall == null && yCall != null) return 1;
        const xc = x.a.checkInAt ? new Date(x.a.checkInAt).getTime() : null;
        const yc = y.a.checkInAt ? new Date(y.a.checkInAt).getTime() : null;
        if (xc != null && yc != null && xc !== yc) return xc - yc;
        if (xc != null && yc == null) return -1;
        if (xc == null && yc != null) return 1;
        const xa = x.a.arrivalSeq ?? Number.MAX_SAFE_INTEGER;
        const ya = y.a.arrivalSeq ?? Number.MAX_SAFE_INTEGER;
        if (xa !== ya) return xa - ya;
        return (
          new Date(x.a.createdAt).getTime() - new Date(y.a.createdAt).getTime()
        );
      };
      enriched.sort((x, y) => {
        // Presence first (arrived/active ahead of not-arrived / terminal).
        const presDiff = presenceRank(y.a.status) - presenceRank(x.a.status);
        if (presDiff !== 0) return presDiff;

        // CALLING is a pure arrival queue: order strictly by call → check-in
        // order. NO priority or vulnerability (child/senior/ANC) re-ranking —
        // the patient being called is next, then whoever checked in earliest.
        if (isCallingMode) return cmpCheckIn(x, y);

        // TOKEN / SLOT: explicit priority, then vulnerable-group bump.
        const pd = priorityWeight(y.a.priority) - priorityWeight(x.a.priority);
        if (pd !== 0) return pd;
        const rd = y.rank - x.rank;
        if (rd !== 0) return rd;

        // The token IS the queue position. A row with a token sorts ahead of a
        // null-token one; ties (or both null) fall back to check-in order.
        const xt = x.a.tokenNumber;
        const yt = y.a.tokenNumber;
        if (xt != null && yt != null && xt !== yt) return xt - yt;
        if (xt != null && yt == null) return -1;
        if (xt == null && yt != null) return 1;
        return cmpCheckIn(x, y);
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
        // ACTUAL minutes the patient has waited since they physically checked
        // in (checkInAt). This is the real wait time the UI surfaces for
        // CALLING / TOKEN queues — null until the patient checks in (a BOOKED
        // row hasn't started waiting in the clinic yet).
        const waitedMinutes = a.checkInAt
          ? Math.max(
              0,
              Math.floor((nowMs - new Date(a.checkInAt).getTime()) / 60000)
            )
          : null;

        return {
          tokenNumber: a.tokenNumber,
          patientName: a.patient.user.name,
          patientPhotoUrl: a.patient.user.photoUrl ?? null,
          patientId: a.patientId,
          appointmentId: a.id,
          type: a.type,
          status: a.status,
          priority: a.priority,
          slotTime: a.slotStart,
          hasVitals: !!a.vitals,
          estimatedWaitMinutes,
          waitedMinutes,
          // CALLING-mode: set when this patient is actively being called (the
          // state between check-in and consult). Null otherwise.
          calledAt: a.calledAt ? a.calledAt.toISOString() : null,
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
          date: dayStart.toISOString().split("T")[0],
          currentToken: currentPatient?.tokenNumber ?? null,
          // "In queue" = patients physically present: waiting (CHECKED_IN) or
          // being seen (IN_CONSULTATION). BOOKED (not arrived) doesn't count.
          totalInQueue: queue.filter(
            (q) =>
              q.status === "CHECKED_IN" || q.status === "IN_CONSULTATION"
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

// Shared display-board builder: per-doctor name + current/next token + waiting
// count, with any patient names redacted to "First L." (PRD §2.1.5). Safe for
// BOTH the authed staff overview (GET /) and the PUBLIC waiting-room board
// (GET /display) — no patient PII is returned.
async function buildDisplayBoard(
  // Super-admin only: optional tenant scope for the doctor query. Tenant-bound
  // callers pass nothing — `tenantScopedPrisma` already auto-filters them to
  // their own tenant; this only matters when a tenant-less super-admin wants
  // to narrow the cross-tenant board to a single tenant's doctors.
  tenantFilter: { tenantId?: string } = {},
  // SLOT-mode patient name policy. The PUBLIC waiting-room board (GET /display)
  // redacts to "First L." (PRD §2.1.5 privacy). The AUTHENTICATED staff board
  // (GET /) passes `fullNames: true` so reception sees the full patient name.
  opts: { fullNames?: boolean } = {},
) {
  const fullNames = opts.fullNames === true;
  // `appointment.date` is a @db.Date column (UTC midnight). Build the day
  // window with setUTCHours (NOT setHours — local time shifts the window on
  // a non-UTC host and either misses today or leaks adjacent days into the
  // counts) and a next-midnight EXCLUSIVE upper bound. Matches appointments.ts.
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const todayEnd = new Date(today);
  todayEnd.setUTCDate(todayEnd.getUTCDate() + 1);
  const todayRange = { gte: today, lt: todayEnd };

  const doctors = await prisma.doctor.findMany({
    where: { ...tenantFilter },
    include: {
      user: { select: { name: true } },
    },
  });

  return Promise.all(
    doctors.map(async (doc) => {
          const current = await prisma.appointment.findFirst({
            where: {
              doctorId: doc.id,
              date: todayRange,
              status: "IN_CONSULTATION",
            },
          });

          // "Waiting" = patients who have actually ARRIVED (CHECKED_IN) and
          // are waiting to be called. A BOOKED patient hasn't shown up yet, so
          // they're not in the live queue (they're still just an appointment).
          const waitingCount = await prisma.appointment.count({
            where: {
              doctorId: doc.id,
              date: todayRange,
              status: "CHECKED_IN",
            },
          });

          // Pearl ERP Stage 1 §2.1.5 — mode-aware display board data.
          // TOKEN: nextToken is the lowest waiting token; CALLING:
          // currentArrivalSeq is the active arrival counter; SLOT:
          // upcomingSlots lists the next 3 booked appointments by
          // slot time. Patient name is redacted to "First L." on the
          // public-facing display per PRD §2.1.5.
          let nextToken: number | null = null;
          let currentArrivalSeq: number | null = null;
          // CALLING mode: redacted names of the patients actively being called
          // right now (calledAt set), earliest call first.
          let callingNow: string[] = [];
          let upcomingSlots: Array<{
            slotStart: string;
            patientLabel: string;
            status: string;
          }> = [];

          if (doc.appointmentMode === "TOKEN") {
            const next = await prisma.appointment.findFirst({
              where: {
                doctorId: doc.id,
                date: todayRange,
                status: { in: ["BOOKED", "CHECKED_IN"] },
                tokenNumber: { not: null },
              },
              orderBy: { tokenNumber: "asc" },
              select: { tokenNumber: true },
            });
            nextToken = next?.tokenNumber ?? null;
          } else if (doc.appointmentMode === "CALLING") {
            currentArrivalSeq = current?.arrivalSeq ?? null;
            // Who's being called right now (the "Now Calling" line on the board).
            const calledRows = await prisma.appointment.findMany({
              where: {
                doctorId: doc.id,
                date: todayRange,
                status: "CHECKED_IN",
                calledAt: { not: null },
              },
              orderBy: { calledAt: "asc" },
              include: {
                patient: { select: { user: { select: { name: true } } } },
              },
            });
            // CALLING mode announces the patient in, so show the FULL name
            // (the board is the clinic's "name being called" display).
            callingNow = calledRows.map(
              (r) => r.patient?.user?.name?.trim() || "—",
            );
          } else if (doc.appointmentMode === "SLOT") {
            const rows = await prisma.appointment.findMany({
              where: {
                doctorId: doc.id,
                date: todayRange,
                status: { in: ["BOOKED", "CHECKED_IN"] },
                slotStart: { not: null },
              },
              orderBy: { slotStart: "asc" },
              take: 3,
              include: {
                patient: { select: { user: { select: { name: true } } } },
              },
            });
            upcomingSlots = rows
              .filter((r) => r.slotStart)
              .map((r) => {
                const fullName = (r.patient?.user?.name ?? "").trim();
                // Authed staff board → full name; public board → "First L."
                let patientLabel: string;
                if (fullNames) {
                  patientLabel = fullName || "—";
                } else {
                  const parts = fullName.split(/\s+/);
                  const first = parts[0] ?? "—";
                  const lastInitial =
                    parts.length > 1 ? `${parts[parts.length - 1][0]}.` : "";
                  patientLabel = lastInitial ? `${first} ${lastInitial}` : first;
                }
                return {
                  slotStart: r.slotStart as string,
                  patientLabel,
                  status: r.status,
                };
              });
          }

          return {
            doctorId: doc.id,
            doctorName: doc.user.name,
            specialization: doc.specialization,
            appointmentMode: doc.appointmentMode,
            currentToken: current?.tokenNumber ?? null,
            nextToken,
            currentArrivalSeq,
            callingNow,
            upcomingSlots,
            waitingCount,
          };
        })
      );
}

// GET /api/v1/queue — authed staff overview (same data as the public board).
router.get(
  "/",
  // Issue #383: staff-only. The public, redacted variant is GET /queue/display.
  authorize(Role.ADMIN, Role.RECEPTION, Role.DOCTOR, Role.NURSE),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Super-admin only: `?tenantId=` narrows the cross-tenant board to one
      // tenant's doctors. Ignored for tenant-bound callers (req.tenantId set) —
      // tenantScopedPrisma already scopes them to their own tenant.
      const tenantIdParam = req.query.tenantId;
      const tenantFilter =
        !req.tenantId &&
        typeof tenantIdParam === "string" &&
        tenantIdParam.trim().length > 0
          ? { tenantId: tenantIdParam.trim() }
          : {};
      // Authenticated staff board → show full patient names (the public
      // /display variant stays redacted to "First L.").
      res.json({
        success: true,
        data: await buildDisplayBoard(tenantFilter, { fullNames: true }),
        error: null,
      });
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
