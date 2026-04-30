import { Router, Request, Response, NextFunction } from "express";
import { prisma } from "@medcore/db";
import { Role } from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";
// Issue #139 (2026-04-26) — canonical revenue/outstanding/refund helpers so
// /analytics/overview cannot drift away from /billing reports' definition.
import {
  getRevenue as svcGetRevenue,
  getOutstanding as svcGetOutstanding,
} from "../services/revenue";

const router = Router();
router.use(authenticate);
// Issue #83: relaxed from `(ADMIN, RECEPTION)` to also include DOCTOR so the
// AI Analytics Triage tab can render for doctors. The previously-shadowed
// per-route `authorize(ADMIN, RECEPTION, DOCTOR)` on /ai/triage and
// /ai/scribe never ran because this global guard 403'd the request — and
// the web client surfaced that as a generic "Internal server error" toast.
// Revenue routes still pin ADMIN-only at the per-route level
// (see /revenue, /revenue/breakdown, /export/revenue.csv).
router.use(authorize(Role.ADMIN, Role.RECEPTION, Role.DOCTOR));

// ─── Helpers ───────────────────────────────────────

function parseRange(req: Request): { from: Date; to: Date } {
  const fromStr = req.query.from as string | undefined;
  const toStr = req.query.to as string | undefined;

  const now = new Date();
  const defaultFrom = new Date(now);
  defaultFrom.setDate(defaultFrom.getDate() - 30);
  defaultFrom.setHours(0, 0, 0, 0);

  const from = fromStr ? new Date(fromStr) : defaultFrom;
  from.setHours(0, 0, 0, 0);

  const to = toStr ? new Date(toStr) : now;
  to.setHours(23, 59, 59, 999);

  return { from, to };
}

function parseGroupBy(req: Request): "day" | "week" | "month" {
  const g = (req.query.groupBy as string) || "day";
  if (g === "week" || g === "month") return g;
  return "day";
}

function calcAge(dob: Date | null | undefined, fallback: number | null | undefined): number | null {
  if (!dob) return fallback ?? null;
  const diff = Date.now() - new Date(dob).getTime();
  const ageDate = new Date(diff);
  return Math.abs(ageDate.getUTCFullYear() - 1970);
}

function bucketKeyFor(d: Date, groupBy: "day" | "week" | "month"): string {
  const dt = new Date(d);
  if (groupBy === "month") {
    return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-01`;
  }
  if (groupBy === "week") {
    const day = dt.getUTCDay();
    const diff = dt.getUTCDate() - day;
    const weekStart = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), diff));
    return weekStart.toISOString().split("T")[0];
  }
  return dt.toISOString().split("T")[0];
}

function deltaPct(current: number, previous: number): number {
  if (!previous || previous === 0) {
    if (!current) return 0;
    return 100;
  }
  return +(((current - previous) / Math.abs(previous)) * 100).toFixed(1);
}

function computePrevRange(
  from: Date,
  to: Date,
  mode: "previous_period" | "previous_year"
): { prevFrom: Date; prevTo: Date } {
  if (mode === "previous_year") {
    const prevFrom = new Date(from);
    prevFrom.setFullYear(prevFrom.getFullYear() - 1);
    const prevTo = new Date(to);
    prevTo.setFullYear(prevTo.getFullYear() - 1);
    return { prevFrom, prevTo };
  }
  const spanMs = to.getTime() - from.getTime();
  const prevTo = new Date(from.getTime() - 1);
  const prevFrom = new Date(prevTo.getTime() - spanMs);
  return { prevFrom, prevTo };
}

async function computeOverviewSnapshot(from: Date, to: Date) {
  const [
    totalPatients,
    newPatientsInPeriod,
    totalAppointments,
    apptStatusGrouped,
    payments,
    pendingBills,
    currentlyAdmitted,
    consultDurations,
    // Issue #48 (2026-04-24): Today-Snapshot needs admissions/discharges/surgeries/erCases
    // in the same window. Previously these keys were missing so the admin-console
    // always rendered 0 regardless of real activity.
    admissionsInPeriod,
    dischargesInPeriod,
    surgeriesInPeriod,
    erCasesInPeriod,
  ] = await Promise.all([
    prisma.patient.count(),
    prisma.patient.count({
      where: { user: { createdAt: { gte: from, lte: to } } },
    }),
    prisma.appointment.count({ where: { date: { gte: from, lte: to } } }),
    prisma.appointment.groupBy({
      by: ["status"],
      where: { date: { gte: from, lte: to } },
      _count: { _all: true },
    }),
    prisma.payment.findMany({
      where: { paidAt: { gte: from, lte: to } },
      select: { amount: true, mode: true },
    }),
    prisma.invoice.count({
      where: { paymentStatus: { in: ["PENDING", "PARTIAL"] } },
    }),
    prisma.admission.count({ where: { status: "ADMITTED" } }),
    // Issue #78: avg consultation time was previously derived from the
    // Consultation row's createdAt/updatedAt, which gives a wildly inflated
    // figure (240+ hours) any time a doctor reopens a draft hours later — the
    // updatedAt bumps but the patient is long gone. Use the Appointment's
    // consultationStartedAt / consultationEndedAt timestamps instead — those
    // are the canonical "consult started" / "consult ended" beacons emitted
    // when the doctor presses the in-room start/stop controls.
    prisma.appointment.findMany({
      where: {
        date: { gte: from, lte: to },
        consultationStartedAt: { not: null },
        consultationEndedAt: { not: null },
      },
      select: { consultationStartedAt: true, consultationEndedAt: true },
    }),
    prisma.admission.count({ where: { admittedAt: { gte: from, lte: to } } }),
    prisma.admission.count({
      where: {
        status: "DISCHARGED",
        dischargedAt: { gte: from, lte: to },
      },
    }),
    prisma.surgery.count({ where: { scheduledAt: { gte: from, lte: to } } }),
    prisma.emergencyCase.count({ where: { arrivedAt: { gte: from, lte: to } } }),
  ]);

  const appointmentsByStatus: Record<string, number> = {
    BOOKED: 0,
    CHECKED_IN: 0,
    IN_CONSULTATION: 0,
    COMPLETED: 0,
    CANCELLED: 0,
    NO_SHOW: 0,
  };
  apptStatusGrouped.forEach((s) => {
    appointmentsByStatus[s.status] = s._count._all;
  });

  // Issue #139 — canonical revenue: positive payments only. Refunds
  // (negative-amount rows) are NOT subtracted from "revenue" — the UI
  // surfaces refunds separately via /billing/reports/refunds. Without
  // this filter the dashboard tile diverged from the billing module by
  // exactly the refund total.
  const revenueByMode: Record<string, number> = {
    CASH: 0,
    CARD: 0,
    UPI: 0,
    ONLINE: 0,
    INSURANCE: 0,
  };
  let totalRevenue = 0;
  payments.forEach((p) => {
    if (p.amount <= 0) return;
    totalRevenue += p.amount;
    revenueByMode[p.mode] = (revenueByMode[p.mode] || 0) + p.amount;
  });

  // Issue #78 — Avg consult math.
  //
  // Old behaviour: sum(updatedAt - createdAt) / count from Consultation rows.
  // That produced 14,431 minutes (240 hrs) on prod because draft consults
  // get re-edited days later and the updatedAt bump dominates the average.
  //
  // New behaviour: only count Appointments whose consult was actually
  // started AND ended (we already filtered for both fields above), and cap
  // each duration at a sensible upper bound so a single forgotten "stop"
  // can't blow up the average. We also skip non-positive durations
  // defensively. If after filtering there is nothing left to average, return
  // null — the UI distinguishes "no data" from "0 minutes".
  const MAX_CONSULT_MINUTES = 240; // 4 hours — anything longer is a stuck timer
  let avgConsultationTime: number | null = 0;
  const validDurationsMin = consultDurations
    .map((c) => {
      if (!c.consultationStartedAt || !c.consultationEndedAt) return null;
      const ms =
        new Date(c.consultationEndedAt).getTime() -
        new Date(c.consultationStartedAt).getTime();
      if (!Number.isFinite(ms) || ms <= 0) return null;
      return Math.min(ms / 60000, MAX_CONSULT_MINUTES);
    })
    .filter((v): v is number => v !== null);

  if (validDurationsMin.length === 0) {
    avgConsultationTime = null;
  } else {
    const totalMin = validDurationsMin.reduce((s, v) => s + v, 0);
    avgConsultationTime = Math.round(totalMin / validDurationsMin.length);
  }

  return {
    totalPatients,
    newPatientsInPeriod,
    // Alias so the admin-console Today-Snapshot widget (Issue #48) and any
    // older client code that expects `newPatients` keep working.
    newPatients: newPatientsInPeriod,
    totalAppointments,
    appointmentsByStatus,
    totalRevenue,
    revenueByMode,
    pendingBills,
    currentlyAdmitted,
    avgConsultationTime,
    admissions: admissionsInPeriod,
    discharges: dischargesInPeriod,
    surgeries: surgeriesInPeriod,
    erCases: erCasesInPeriod,
  };
}

function csvEscape(val: unknown): string {
  if (val === null || val === undefined) return "";
  const s = String(val);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function toCsv(rows: Record<string, unknown>[], columns: string[]): string {
  const header = columns.map(csvEscape).join(",");
  const lines = rows.map((row) => columns.map((c) => csvEscape(row[c])).join(","));
  return [header, ...lines].join("\r\n");
}

// ─── GET /analytics/overview ───────────────────────

// RBAC: DOCTOR is allowed at the router level for ai-triage analytics
// endpoints, but /overview surfaces revenue and operational KPIs that
// DOCTOR shouldn't see. Restrict to ADMIN + RECEPTION here (per the
// permissions-matrix contract).
router.get("/overview", authorize(Role.ADMIN, Role.RECEPTION), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { from, to } = parseRange(req);
    const compareMode = req.query.compareMode as
      | "previous_period"
      | "previous_year"
      | undefined;

    const current = await computeOverviewSnapshot(from, to);

    // RBAC (issue #90): RECEPTION must NOT see revenue/financial KPIs in
    // the overview. Strip totalRevenue + revenueByMode for non-ADMIN
    // callers. This keeps the operational counters (appointments, patients,
    // admissions, etc.) flowing to RECEPTION while hiding money.
    const stripFinancial = (snap: typeof current) => {
      if (req.user?.role === Role.ADMIN) return snap;
      const { totalRevenue: _tr, revenueByMode: _rbm, ...rest } = snap;
      void _tr;
      void _rbm;
      return rest;
    };

    if (!compareMode) {
      res.json({ success: true, data: stripFinancial(current), error: null });
      return;
    }

    const { prevFrom, prevTo } = computePrevRange(from, to, compareMode);
    const previous = await computeOverviewSnapshot(prevFrom, prevTo);

    const numericKeys: (keyof typeof current)[] = [
      "totalPatients",
      "newPatientsInPeriod",
      "totalAppointments",
      "totalRevenue",
      "pendingBills",
      "currentlyAdmitted",
      "avgConsultationTime",
      "admissions",
      "discharges",
      "surgeries",
      "erCases",
    ];
    const deltaPercent: Record<string, number> = {};
    numericKeys.forEach((k) => {
      deltaPercent[k as string] = deltaPct(
        Number(current[k] || 0),
        Number(previous[k] || 0)
      );
    });
    if (req.user?.role !== Role.ADMIN) {
      delete deltaPercent.totalRevenue;
    }

    res.json({
      success: true,
      data: {
        current: stripFinancial(current),
        previous: stripFinancial(previous),
        deltaPercent,
        compareMode,
        previousRange: {
          from: prevFrom.toISOString().split("T")[0],
          to: prevTo.toISOString().split("T")[0],
        },
      },
      error: null,
    });
  } catch (err) {
    next(err);
  }
});

// ─── GET /analytics/appointments (time series) ─────

router.get("/appointments", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { from, to } = parseRange(req);
    const groupBy = parseGroupBy(req);

    const appointments = await prisma.appointment.findMany({
      where: { date: { gte: from, lte: to } },
      select: { date: true, type: true },
    });

    const buckets = new Map<
      string,
      { date: string; count: number; scheduled: number; walkin: number }
    >();
    appointments.forEach((a) => {
      const key = bucketKeyFor(a.date, groupBy);
      if (!buckets.has(key)) {
        buckets.set(key, { date: key, count: 0, scheduled: 0, walkin: 0 });
      }
      const b = buckets.get(key)!;
      b.count++;
      if (a.type === "WALK_IN") b.walkin++;
      else b.scheduled++;
    });

    const data = Array.from(buckets.values()).sort((a, b) => a.date.localeCompare(b.date));

    res.json({ success: true, data, error: null });
  } catch (err) {
    next(err);
  }
});

// ─── GET /analytics/revenue (time series) ──────────
// RBAC (issue #90): financial KPIs are ADMIN-only. RECEPTION must NOT see
// revenue dashboards (the global router authorize allows RECEPTION; this
// per-route override re-tightens to ADMIN).

router.get("/revenue", authorize(Role.ADMIN), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { from, to } = parseRange(req);
    const groupBy = parseGroupBy(req);

    const payments = await prisma.payment.findMany({
      where: { paidAt: { gte: from, lte: to } },
      select: { amount: true, mode: true, paidAt: true },
    });

    const buckets = new Map<
      string,
      { date: string; total: number; cash: number; card: number; upi: number; online: number; insurance: number }
    >();

    payments.forEach((p) => {
      const key = bucketKeyFor(p.paidAt, groupBy);
      if (!buckets.has(key)) {
        buckets.set(key, {
          date: key,
          total: 0,
          cash: 0,
          card: 0,
          upi: 0,
          online: 0,
          insurance: 0,
        });
      }
      const b = buckets.get(key)!;
      b.total += p.amount;
      switch (p.mode) {
        case "CASH":
          b.cash += p.amount;
          break;
        case "CARD":
          b.card += p.amount;
          break;
        case "UPI":
          b.upi += p.amount;
          break;
        case "ONLINE":
          b.online += p.amount;
          break;
        case "INSURANCE":
          b.insurance += p.amount;
          break;
      }
    });

    const data = Array.from(buckets.values()).sort((a, b) => a.date.localeCompare(b.date));
    res.json({ success: true, data, error: null });
  } catch (err) {
    next(err);
  }
});

// ─── GET /analytics/revenue/breakdown ──────────────
// RBAC (issue #90): ADMIN-only.

router.get("/revenue/breakdown", authorize(Role.ADMIN), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { from, to } = parseRange(req);

    const payments = await prisma.payment.findMany({
      where: { paidAt: { gte: from, lte: to } },
      include: {
        invoice: {
          include: {
            items: true,
            appointment: {
              select: {
                type: true,
                doctorId: true,
                doctor: { select: { user: { select: { name: true } } } },
              },
            },
          },
        },
      },
    });

    const byType: Record<string, number> = { SCHEDULED: 0, WALK_IN: 0 };
    const byCategory: Record<string, number> = {};
    const byDoctor = new Map<string, { doctorId: string; doctorName: string; revenue: number }>();

    // Ward-based IPD revenue = sum of payments whose patient has an admission overlapping paid period
    for (const p of payments) {
      const inv = p.invoice;
      const apptType = inv?.appointment?.type;
      if (apptType === "WALK_IN") byType.WALK_IN += p.amount;
      else byType.SCHEDULED += p.amount;

      const subtotal = inv?.subtotal || 0;
      const totalItems = inv?.items.reduce((s, i) => s + i.amount, 0) || 0;
      const scale = totalItems > 0 ? p.amount / totalItems : 0;
      inv?.items.forEach((it) => {
        const cat = (it.category || "OTHER").toUpperCase();
        byCategory[cat] = (byCategory[cat] || 0) + it.amount * (scale || 0);
      });
      // If no items tracked, fall back to subtotal-prorated category "CONSULTATION"
      if (!inv?.items.length && subtotal > 0) {
        byCategory.CONSULTATION = (byCategory.CONSULTATION || 0) + p.amount;
      }

      const docId = inv?.appointment?.doctorId;
      const docName = inv?.appointment?.doctor?.user?.name;
      if (docId && docName) {
        const cur = byDoctor.get(docId) || { doctorId: docId, doctorName: docName, revenue: 0 };
        cur.revenue += p.amount;
        byDoctor.set(docId, cur);
      }
    }

    // Ward-based IPD revenue: sum bed dailyRate * days for admissions discharged/active in range
    const admissions = await prisma.admission.findMany({
      where: {
        OR: [
          { admittedAt: { gte: from, lte: to } },
          { dischargedAt: { gte: from, lte: to } },
          { AND: [{ admittedAt: { lte: to } }, { status: "ADMITTED" } ] },
        ],
      },
      include: {
        bed: { include: { ward: { select: { name: true } } } },
      },
    });

    const byWard = new Map<string, { wardName: string; revenue: number; admissions: number }>();
    admissions.forEach((a) => {
      const wardName = a.bed?.ward?.name || "Unknown";
      const rate = a.bed?.dailyRate || 0;
      const start = new Date(Math.max(new Date(a.admittedAt).getTime(), from.getTime()));
      const endTime = a.dischargedAt
        ? Math.min(new Date(a.dischargedAt).getTime(), to.getTime())
        : to.getTime();
      const days = Math.max(1, Math.ceil((endTime - start.getTime()) / (1000 * 60 * 60 * 24)));
      const rev = rate * days;
      const cur = byWard.get(wardName) || { wardName, revenue: 0, admissions: 0 };
      cur.revenue += rev;
      cur.admissions += 1;
      byWard.set(wardName, cur);
    });

    // Round category numbers
    Object.keys(byCategory).forEach((k) => {
      byCategory[k] = +byCategory[k].toFixed(2);
    });

    res.json({
      success: true,
      data: {
        byType,
        byCategory,
        byDoctor: Array.from(byDoctor.values()).sort((a, b) => b.revenue - a.revenue),
        byWard: Array.from(byWard.values()).sort((a, b) => b.revenue - a.revenue),
      },
      error: null,
    });
  } catch (err) {
    next(err);
  }
});

// ─── GET /analytics/doctors ────────────────────────

router.get("/doctors", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { from, to } = parseRange(req);

    const doctors = await prisma.doctor.findMany({
      include: {
        user: { select: { name: true } },
        // Issue #78 — pull the appointment's consultationStartedAt/EndedAt
        // directly. We previously joined to Consultation and used its
        // createdAt/updatedAt which is wrong for the same reason described in
        // computeOverviewSnapshot above (drafts re-edited later inflate it).
        appointments: {
          where: { date: { gte: from, lte: to } },
          include: {
            invoice: { include: { payments: true } },
          },
        },
      },
    });

    const MAX_CONSULT_MINUTES_DOC = 240; // align with overview cap
    const data = doctors.map((doc) => {
      const appts = doc.appointments;
      const appointmentCount = appts.length;
      const completedCount = appts.filter((a) => a.status === "COMPLETED").length;
      const patientIds = new Set(appts.map((a) => a.patientId));

      const validDurationsMin = appts
        .map((a) => {
          if (!a.consultationStartedAt || !a.consultationEndedAt) return null;
          const ms =
            new Date(a.consultationEndedAt).getTime() -
            new Date(a.consultationStartedAt).getTime();
          if (!Number.isFinite(ms) || ms <= 0) return null;
          return Math.min(ms / 60000, MAX_CONSULT_MINUTES_DOC);
        })
        .filter((v): v is number => v !== null);

      const avgDurationMin =
        validDurationsMin.length > 0
          ? Math.round(
              validDurationsMin.reduce((sum, d) => sum + d, 0) /
                validDurationsMin.length
            )
          : 0;

      let revenue = 0;
      appts.forEach((a) => {
        if (a.invoice) {
          a.invoice.payments.forEach((p) => {
            if (p.paidAt >= from && p.paidAt <= to) revenue += p.amount;
          });
        }
      });

      return {
        doctorId: doc.id,
        doctorName: doc.user.name,
        appointmentCount,
        completedCount,
        avgDurationMin,
        revenue,
        patientCount: patientIds.size,
      };
    });

    data.sort((a, b) => b.appointmentCount - a.appointmentCount);

    res.json({ success: true, data, error: null });
  } catch (err) {
    next(err);
  }
});

// ─── GET /analytics/top-diagnoses ──────────────────

router.get("/top-diagnoses", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { from, to } = parseRange(req);
    const limit = Math.min(parseInt((req.query.limit as string) || "10"), 50);

    const prescriptions = await prisma.prescription.findMany({
      where: { createdAt: { gte: from, lte: to } },
      select: { diagnosis: true },
    });

    const counts = new Map<string, number>();
    prescriptions.forEach((p) => {
      const key = (p.diagnosis || "").trim();
      if (!key) return;
      counts.set(key, (counts.get(key) || 0) + 1);
    });

    const data = Array.from(counts.entries())
      .map(([diagnosis, count]) => ({ diagnosis, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, limit);

    res.json({ success: true, data, error: null });
  } catch (err) {
    next(err);
  }
});

// ─── GET /analytics/patient-demographics ───────────

router.get("/patient-demographics", async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const patients = await prisma.patient.findMany({
      select: { gender: true, dateOfBirth: true, age: true },
    });

    const byGender: Record<string, number> = { MALE: 0, FEMALE: 0, OTHER: 0 };
    const byAgeGroup: Record<string, number> = {
      "0-18": 0,
      "19-35": 0,
      "36-55": 0,
      "56+": 0,
    };

    patients.forEach((p) => {
      byGender[p.gender] = (byGender[p.gender] || 0) + 1;
      const age = calcAge(p.dateOfBirth, p.age);
      if (age === null) return;
      if (age <= 18) byAgeGroup["0-18"]++;
      else if (age <= 35) byAgeGroup["19-35"]++;
      else if (age <= 55) byAgeGroup["36-55"]++;
      else byAgeGroup["56+"]++;
    });

    res.json({ success: true, data: { byGender, byAgeGroup }, error: null });
  } catch (err) {
    next(err);
  }
});

// ─── GET /analytics/patients/growth ────────────────

router.get("/patients/growth", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { from, to } = parseRange(req);
    const groupBy = parseGroupBy(req);

    const patients = await prisma.patient.findMany({
      where: { user: { createdAt: { gte: from, lte: to } } },
      include: { user: { select: { createdAt: true } } },
    });

    const buckets = new Map<string, { date: string; count: number }>();
    patients.forEach((p) => {
      const key = bucketKeyFor(p.user.createdAt, groupBy);
      if (!buckets.has(key)) buckets.set(key, { date: key, count: 0 });
      buckets.get(key)!.count++;
    });

    const data = Array.from(buckets.values()).sort((a, b) => a.date.localeCompare(b.date));

    // Running total (cumulative)
    let running = 0;
    const withCumulative = data.map((d) => {
      running += d.count;
      return { ...d, cumulative: running };
    });

    res.json({ success: true, data: withCumulative, error: null });
  } catch (err) {
    next(err);
  }
});

// ─── GET /analytics/patients/retention ─────────────

router.get("/patients/retention", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { from, to } = parseRange(req);

    const appointments = await prisma.appointment.findMany({
      where: { date: { gte: from, lte: to } },
      select: { patientId: true },
    });

    const countsByPatient = new Map<string, number>();
    appointments.forEach((a) => {
      countsByPatient.set(a.patientId, (countsByPatient.get(a.patientId) || 0) + 1);
    });

    const patientIds = Array.from(countsByPatient.keys());
    // "new" = registered within the range
    const newPatients = patientIds.length
      ? await prisma.patient.count({
          where: {
            id: { in: patientIds },
            user: { createdAt: { gte: from, lte: to } },
          },
        })
      : 0;

    const totalActive = patientIds.length;
    const returning = totalActive - newPatients;

    let oneVisit = 0;
    let twoThree = 0;
    let fourPlus = 0;
    countsByPatient.forEach((v) => {
      if (v === 1) oneVisit++;
      else if (v <= 3) twoThree++;
      else fourPlus++;
    });

    const retentionRate = totalActive > 0 ? +((returning / totalActive) * 100).toFixed(1) : 0;

    res.json({
      success: true,
      data: {
        totalActive,
        newPatients,
        returningPatients: returning,
        retentionRate,
        distribution: {
          "1": oneVisit,
          "2-3": twoThree,
          "4+": fourPlus,
        },
      },
      error: null,
    });
  } catch (err) {
    next(err);
  }
});

// ─── GET /analytics/appointments/no-show-rate ──────

router.get("/appointments/no-show-rate", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { from, to } = parseRange(req);
    const doctorId = req.query.doctorId as string | undefined;

    const where: Record<string, unknown> = { date: { gte: from, lte: to } };
    if (doctorId) where.doctorId = doctorId;

    const appts = await prisma.appointment.findMany({
      where,
      include: { doctor: { include: { user: { select: { name: true } } } } },
    });

    const total = appts.length;
    const noShowTotal = appts.filter((a) => a.status === "NO_SHOW").length;
    const overallRate = total > 0 ? +((noShowTotal / total) * 100).toFixed(1) : 0;

    // By doctor
    const byDoctor = new Map<
      string,
      { doctorId: string; doctorName: string; total: number; noShow: number; rate: number }
    >();
    appts.forEach((a) => {
      const cur =
        byDoctor.get(a.doctorId) ||
        {
          doctorId: a.doctorId,
          doctorName: a.doctor.user.name,
          total: 0,
          noShow: 0,
          rate: 0,
        };
      cur.total++;
      if (a.status === "NO_SHOW") cur.noShow++;
      byDoctor.set(a.doctorId, cur);
    });
    const byDoctorArr = Array.from(byDoctor.values()).map((d) => ({
      ...d,
      rate: d.total > 0 ? +((d.noShow / d.total) * 100).toFixed(1) : 0,
    }));
    byDoctorArr.sort((a, b) => b.rate - a.rate);

    // By day of week (0 Sun ... 6 Sat)
    const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const byDay = dayNames.map((d) => ({ day: d, total: 0, noShow: 0, rate: 0 }));
    appts.forEach((a) => {
      const d = new Date(a.date).getUTCDay();
      byDay[d].total++;
      if (a.status === "NO_SHOW") byDay[d].noShow++;
    });
    byDay.forEach((d) => {
      d.rate = d.total > 0 ? +((d.noShow / d.total) * 100).toFixed(1) : 0;
    });

    // By hour (from slotStart if present)
    const byHour: { hour: number; total: number; noShow: number; rate: number }[] = [];
    for (let h = 0; h < 24; h++) byHour.push({ hour: h, total: 0, noShow: 0, rate: 0 });
    appts.forEach((a) => {
      if (!a.slotStart) return;
      const h = parseInt(a.slotStart.split(":")[0]);
      if (Number.isNaN(h) || h < 0 || h > 23) return;
      byHour[h].total++;
      if (a.status === "NO_SHOW") byHour[h].noShow++;
    });
    byHour.forEach((h) => {
      h.rate = h.total > 0 ? +((h.noShow / h.total) * 100).toFixed(1) : 0;
    });

    res.json({
      success: true,
      data: {
        totalAppointments: total,
        noShowCount: noShowTotal,
        overallRate,
        byDoctor: byDoctorArr,
        byDayOfWeek: byDay,
        byHour,
      },
      error: null,
    });
  } catch (err) {
    next(err);
  }
});

// ─── GET /analytics/ipd/occupancy ──────────────────

router.get("/ipd/occupancy", async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const wards = await prisma.ward.findMany({
      include: { beds: true },
    });

    let totalBeds = 0;
    let occupied = 0;

    const byWard = wards.map((w) => {
      const total = w.beds.length;
      const occ = w.beds.filter((b) => b.status === "OCCUPIED").length;
      totalBeds += total;
      occupied += occ;
      return { wardName: w.name, total, occupied: occ };
    });

    res.json({
      success: true,
      data: {
        totalBeds,
        occupied,
        available: totalBeds - occupied,
        byWard,
      },
      error: null,
    });
  } catch (err) {
    next(err);
  }
});

// ─── GET /analytics/ipd/adls ───────────────────────

router.get("/ipd/adls", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { from, to } = parseRange(req);

    const admissions = await prisma.admission.findMany({
      where: {
        admittedAt: { gte: from, lte: to },
      },
      select: {
        status: true,
        admittedAt: true,
        dischargedAt: true,
      },
    });

    const totalAdmissions = admissions.length;
    const discharged = admissions.filter((a) => a.status === "DISCHARGED" && a.dischargedAt);
    const dischargeRate = totalAdmissions > 0 ? (discharged.length / totalAdmissions) * 100 : 0;

    let avgLengthOfStay = 0;
    if (discharged.length > 0) {
      const totalMs = discharged.reduce(
        (sum, a) =>
          sum + (new Date(a.dischargedAt!).getTime() - new Date(a.admittedAt).getTime()),
        0
      );
      avgLengthOfStay = +(totalMs / discharged.length / (1000 * 60 * 60 * 24)).toFixed(1);
    }

    res.json({
      success: true,
      data: {
        totalAdmissions,
        discharged: discharged.length,
        dischargeRate: +dischargeRate.toFixed(1),
        avgLengthOfStayDays: avgLengthOfStay,
      },
      error: null,
    });
  } catch (err) {
    next(err);
  }
});

// ─── GET /analytics/ipd/discharge-trends ───────────

router.get("/ipd/discharge-trends", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { from, to } = parseRange(req);

    const admissions = await prisma.admission.findMany({
      where: {
        OR: [
          { admittedAt: { gte: from, lte: to } },
          { dischargedAt: { gte: from, lte: to } },
        ],
      },
      select: {
        id: true,
        patientId: true,
        admittedAt: true,
        dischargedAt: true,
        status: true,
      },
      orderBy: { admittedAt: "asc" },
    });

    const discharged = admissions.filter((a) => a.dischargedAt && a.status === "DISCHARGED");
    // Mortality: schema doesn't model DECEASED; placeholder metric stays 0.
    const deaths: typeof admissions = [];

    let avgLos = 0;
    if (discharged.length > 0) {
      const totalMs = discharged.reduce(
        (s, a) =>
          s + (new Date(a.dischargedAt!).getTime() - new Date(a.admittedAt).getTime()),
        0
      );
      avgLos = +(totalMs / discharged.length / (1000 * 60 * 60 * 24)).toFixed(1);
    }

    const mortalityRate =
      admissions.length > 0 ? +((deaths.length / admissions.length) * 100).toFixed(1) : 0;

    // Readmission: any admission whose patient had a prior discharge within 30 days before admittedAt
    const dischargesByPatient = new Map<string, Date[]>();
    admissions.forEach((a) => {
      if (a.dischargedAt) {
        const arr = dischargesByPatient.get(a.patientId) || [];
        arr.push(new Date(a.dischargedAt));
        dischargesByPatient.set(a.patientId, arr);
      }
    });

    let readmits = 0;
    admissions.forEach((a) => {
      const priorDischarges = dischargesByPatient.get(a.patientId) || [];
      const admittedTs = new Date(a.admittedAt).getTime();
      const hasReadmit = priorDischarges.some((d) => {
        const diff = admittedTs - d.getTime();
        return diff > 0 && diff <= 30 * 24 * 60 * 60 * 1000;
      });
      if (hasReadmit) readmits++;
    });

    const readmissionRate =
      discharged.length > 0 ? +((readmits / discharged.length) * 100).toFixed(1) : 0;

    // LOS distribution
    const losBuckets = { "1-3": 0, "4-7": 0, "8-14": 0, "15+": 0 };
    discharged.forEach((a) => {
      const days =
        (new Date(a.dischargedAt!).getTime() - new Date(a.admittedAt).getTime()) /
        (1000 * 60 * 60 * 24);
      if (days <= 3) losBuckets["1-3"]++;
      else if (days <= 7) losBuckets["4-7"]++;
      else if (days <= 14) losBuckets["8-14"]++;
      else losBuckets["15+"]++;
    });

    res.json({
      success: true,
      data: {
        totalAdmissions: admissions.length,
        discharged: discharged.length,
        deaths: deaths.length,
        avgLengthOfStayDays: avgLos,
        mortalityRate,
        readmissionRate,
        readmissions: readmits,
        losDistribution: losBuckets,
      },
      error: null,
    });
  } catch (err) {
    next(err);
  }
});

// ─── GET /analytics/er/performance ─────────────────

router.get("/er/performance", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { from, to } = parseRange(req);

    const cases = await prisma.emergencyCase.findMany({
      where: { arrivedAt: { gte: from, lte: to } },
      select: {
        triageLevel: true,
        arrivedAt: true,
        triagedAt: true,
        seenAt: true,
        status: true,
        disposition: true,
      },
    });

    const totalCases = cases.length;

    const triageDurations: number[] = [];
    const doctorDurations: number[] = [];

    cases.forEach((c) => {
      if (c.triagedAt) {
        triageDurations.push(
          new Date(c.triagedAt).getTime() - new Date(c.arrivedAt).getTime()
        );
      }
      if (c.seenAt && c.triagedAt) {
        doctorDurations.push(
          new Date(c.seenAt).getTime() - new Date(c.triagedAt).getTime()
        );
      }
    });

    const avgWaitToTriageMin =
      triageDurations.length > 0
        ? +(triageDurations.reduce((a, b) => a + b, 0) / triageDurations.length / 60000).toFixed(1)
        : 0;
    const avgWaitToDoctorMin =
      doctorDurations.length > 0
        ? +(doctorDurations.reduce((a, b) => a + b, 0) / doctorDurations.length / 60000).toFixed(1)
        : 0;

    const byTriage: Record<string, number> = {
      RESUSCITATION: 0,
      EMERGENT: 0,
      URGENT: 0,
      LESS_URGENT: 0,
      NON_URGENT: 0,
      UNTRIAGED: 0,
    };
    cases.forEach((c) => {
      const key = c.triageLevel || "UNTRIAGED";
      byTriage[key] = (byTriage[key] || 0) + 1;
    });

    const byDisposition: Record<string, number> = {};
    cases.forEach((c) => {
      const key = (c.disposition || "PENDING").toUpperCase();
      byDisposition[key] = (byDisposition[key] || 0) + 1;
    });

    const criticalCases = (byTriage.RESUSCITATION || 0) + (byTriage.EMERGENT || 0);

    // ── LWBS (Left Without Being Seen) rate ──
    // LWBS appointments in the same window: NO_SHOW with lwbsReason set
    const appointmentsInRange = await prisma.appointment.count({
      where: { date: { gte: from, lte: to } },
    });
    const lwbsCount = await prisma.appointment.count({
      where: {
        date: { gte: from, lte: to },
        status: "NO_SHOW",
        lwbsReason: { not: null },
      },
    });
    const lwbsRate =
      appointmentsInRange > 0
        ? +((lwbsCount / appointmentsInRange) * 100).toFixed(2)
        : 0;

    res.json({
      success: true,
      data: {
        totalCases,
        criticalCases,
        avgWaitToTriageMin,
        avgWaitToDoctorMin,
        byTriage,
        byDisposition,
        lwbsCount,
        lwbsRate,
        appointmentsInRange,
      },
      error: null,
    });
  } catch (err) {
    next(err);
  }
});

// ─── GET /analytics/pharmacy/low-stock ─────────────

router.get("/pharmacy/low-stock", async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const items = await prisma.inventoryItem.findMany({
      include: { medicine: { select: { name: true } } },
    });

    const lowStock = items.filter((i) => i.quantity <= i.reorderLevel);

    res.json({
      success: true,
      data: {
        count: lowStock.length,
        items: lowStock.slice(0, 20).map((i) => ({
          id: i.id,
          medicineName: i.medicine.name,
          quantity: i.quantity,
          reorderLevel: i.reorderLevel,
          batchNumber: i.batchNumber,
        })),
      },
      error: null,
    });
  } catch (err) {
    next(err);
  }
});

// ─── GET /analytics/pharmacy/top-dispensed ─────────

router.get("/pharmacy/top-dispensed", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const limit = Math.min(parseInt((req.query.limit as string) || "10"), 50);

    const movements = await prisma.stockMovement.findMany({
      where: { type: "DISPENSED" },
      include: {
        inventoryItem: {
          include: { medicine: { select: { name: true } } },
        },
      },
    });

    const counts = new Map<string, number>();
    movements.forEach((m) => {
      const name = m.inventoryItem.medicine.name;
      counts.set(name, (counts.get(name) || 0) + Math.abs(m.quantity));
    });

    const data = Array.from(counts.entries())
      .map(([medicineName, dispensed]) => ({ medicineName, dispensed }))
      .sort((a, b) => b.dispensed - a.dispensed)
      .slice(0, limit);

    res.json({ success: true, data, error: null });
  } catch (err) {
    next(err);
  }
});

// ─── GET /analytics/pharmacy/expiry ────────────────

router.get("/pharmacy/expiry", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const days = Math.min(parseInt((req.query.days as string) || "30"), 365);
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    const horizon90 = new Date(now);
    horizon90.setDate(horizon90.getDate() + 90);

    const items = await prisma.inventoryItem.findMany({
      where: { expiryDate: { lte: horizon90 }, quantity: { gt: 0 } },
      include: { medicine: { select: { name: true } } },
      orderBy: { expiryDate: "asc" },
    });

    const tag = (expiry: Date): "expired" | "30" | "60" | "90" => {
      const diffDays = Math.ceil((expiry.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
      if (diffDays <= 0) return "expired";
      if (diffDays <= 30) return "30";
      if (diffDays <= 60) return "60";
      return "90";
    };

    const valueAtRisk = { expired: 0, "30": 0, "60": 0, "90": 0 };
    const countByBucket = { expired: 0, "30": 0, "60": 0, "90": 0 };

    const topItems: Array<{
      id: string;
      medicineName: string;
      batchNumber: string;
      quantity: number;
      expiryDate: string;
      daysToExpiry: number;
      valueAtRisk: number;
      bucket: string;
    }> = [];

    items.forEach((it) => {
      const bucket = tag(new Date(it.expiryDate));
      const itemValue = it.quantity * it.sellingPrice;
      valueAtRisk[bucket] += itemValue;
      countByBucket[bucket] += 1;

      const daysToExpiry = Math.ceil(
        (new Date(it.expiryDate).getTime() - now.getTime()) / (1000 * 60 * 60 * 24)
      );

      topItems.push({
        id: it.id,
        medicineName: it.medicine.name,
        batchNumber: it.batchNumber,
        quantity: it.quantity,
        expiryDate: new Date(it.expiryDate).toISOString().split("T")[0],
        daysToExpiry,
        valueAtRisk: +itemValue.toFixed(2),
        bucket,
      });
    });

    const horizon = new Date(now);
    horizon.setDate(horizon.getDate() + days);
    const focus = topItems.filter(
      (i) => new Date(i.expiryDate).getTime() <= horizon.getTime()
    );

    res.json({
      success: true,
      data: {
        horizonDays: days,
        valueAtRisk: {
          expired: +valueAtRisk.expired.toFixed(2),
          "30": +valueAtRisk["30"].toFixed(2),
          "60": +valueAtRisk["60"].toFixed(2),
          "90": +valueAtRisk["90"].toFixed(2),
        },
        countByBucket,
        totalAtRisk: +(valueAtRisk.expired + valueAtRisk["30"] + valueAtRisk["60"] + valueAtRisk["90"]).toFixed(2),
        topItems: topItems.slice(0, 50),
        focusItems: focus.slice(0, 50),
      },
      error: null,
    });
  } catch (err) {
    next(err);
  }
});

// ─── GET /analytics/feedback/trends ────────────────

router.get("/feedback/trends", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { from, to } = parseRange(req);
    const groupBy = parseGroupBy(req);

    const feedback = await prisma.patientFeedback.findMany({
      where: { submittedAt: { gte: from, lte: to } },
      select: { rating: true, nps: true, category: true, submittedAt: true },
    });

    const buckets = new Map<
      string,
      {
        date: string;
        count: number;
        ratingSum: number;
        npsPromoters: number;
        npsDetractors: number;
        npsResponses: number;
      }
    >();

    const byCategory: Record<
      string,
      { category: string; count: number; ratingSum: number; avgRating: number }
    > = {};

    feedback.forEach((f) => {
      const key = bucketKeyFor(f.submittedAt, groupBy);
      const b =
        buckets.get(key) ||
        {
          date: key,
          count: 0,
          ratingSum: 0,
          npsPromoters: 0,
          npsDetractors: 0,
          npsResponses: 0,
        };
      b.count++;
      b.ratingSum += f.rating;
      if (typeof f.nps === "number") {
        b.npsResponses++;
        if (f.nps >= 9) b.npsPromoters++;
        else if (f.nps <= 6) b.npsDetractors++;
      }
      buckets.set(key, b);

      const catKey = f.category;
      const cat =
        byCategory[catKey] ||
        { category: catKey, count: 0, ratingSum: 0, avgRating: 0 };
      cat.count++;
      cat.ratingSum += f.rating;
      byCategory[catKey] = cat;
    });

    const series = Array.from(buckets.values())
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((b) => ({
        date: b.date,
        count: b.count,
        avgRating: b.count > 0 ? +(b.ratingSum / b.count).toFixed(2) : 0,
        nps:
          b.npsResponses > 0
            ? +(((b.npsPromoters - b.npsDetractors) / b.npsResponses) * 100).toFixed(1)
            : 0,
      }));

    const categories = Object.values(byCategory).map((c) => ({
      category: c.category,
      count: c.count,
      avgRating: c.count > 0 ? +(c.ratingSum / c.count).toFixed(2) : 0,
    }));

    const totalRatings = feedback.length;
    const overallAvg =
      totalRatings > 0
        ? +(feedback.reduce((s, f) => s + f.rating, 0) / totalRatings).toFixed(2)
        : 0;
    const npsResp = feedback.filter((f) => typeof f.nps === "number");
    const overallNps =
      npsResp.length > 0
        ? +(
            ((npsResp.filter((f) => (f.nps || 0) >= 9).length -
              npsResp.filter((f) => (f.nps || 0) <= 6).length) /
              npsResp.length) *
            100
          ).toFixed(1)
        : 0;

    res.json({
      success: true,
      data: {
        totalResponses: totalRatings,
        overallAvgRating: overallAvg,
        overallNps,
        series,
        categories,
      },
      error: null,
    });
  } catch (err) {
    next(err);
  }
});

// ─── CSV Exports ───────────────────────────────────

// RBAC (issue #90): ADMIN-only — revenue CSV export contains payment data.
router.get("/export/revenue.csv", authorize(Role.ADMIN), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { from, to } = parseRange(req);

    const payments = await prisma.payment.findMany({
      where: { paidAt: { gte: from, lte: to } },
      include: {
        invoice: {
          include: {
            patient: { include: { user: { select: { name: true } } } },
            appointment: {
              include: { doctor: { include: { user: { select: { name: true } } } } },
            },
          },
        },
      },
      orderBy: { paidAt: "asc" },
    });

    const rows = payments.map((p) => ({
      paidAt: new Date(p.paidAt).toISOString(),
      invoiceNumber: p.invoice?.invoiceNumber || "",
      patientName: p.invoice?.patient?.user?.name || "",
      mrNumber: p.invoice?.patient?.mrNumber || "",
      doctorName: p.invoice?.appointment?.doctor?.user?.name || "",
      amount: p.amount.toFixed(2),
      mode: p.mode,
      transactionId: p.transactionId || "",
    }));

    const csv = toCsv(rows, [
      "paidAt",
      "invoiceNumber",
      "patientName",
      "mrNumber",
      "doctorName",
      "amount",
      "mode",
      "transactionId",
    ]);

    res.setHeader("Content-Type", "text/csv");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="revenue-${from.toISOString().split("T")[0]}-to-${to
        .toISOString()
        .split("T")[0]}.csv"`
    );
    res.send(csv);
  } catch (err) {
    next(err);
  }
});

router.get("/export/appointments.csv", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { from, to } = parseRange(req);
    const doctorId = req.query.doctorId as string | undefined;

    const where: Record<string, unknown> = { date: { gte: from, lte: to } };
    if (doctorId) where.doctorId = doctorId;

    const appts = await prisma.appointment.findMany({
      where,
      include: {
        patient: { include: { user: { select: { name: true } } } },
        doctor: { include: { user: { select: { name: true } } } },
      },
      orderBy: { date: "asc" },
    });

    const rows = appts.map((a) => ({
      date: new Date(a.date).toISOString().split("T")[0],
      tokenNumber: a.tokenNumber,
      patientName: a.patient?.user?.name || "",
      mrNumber: a.patient?.mrNumber || "",
      doctorName: a.doctor?.user?.name || "",
      type: a.type,
      status: a.status,
      priority: a.priority,
      slotStart: a.slotStart || "",
      slotEnd: a.slotEnd || "",
      notes: a.notes || "",
    }));

    const csv = toCsv(rows, [
      "date",
      "tokenNumber",
      "patientName",
      "mrNumber",
      "doctorName",
      "type",
      "status",
      "priority",
      "slotStart",
      "slotEnd",
      "notes",
    ]);

    res.setHeader("Content-Type", "text/csv");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="appointments-${from.toISOString().split("T")[0]}-to-${to
        .toISOString()
        .split("T")[0]}.csv"`
    );
    res.send(csv);
  } catch (err) {
    next(err);
  }
});

router.get("/export/patients.csv", async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const patients = await prisma.patient.findMany({
      include: { user: { select: { name: true, email: true, phone: true, createdAt: true } } },
      orderBy: { user: { createdAt: "desc" } },
    });

    const rows = patients.map((p) => ({
      mrNumber: p.mrNumber,
      name: p.user?.name || "",
      email: p.user?.email || "",
      phone: p.user?.phone || "",
      gender: p.gender,
      dateOfBirth: p.dateOfBirth ? new Date(p.dateOfBirth).toISOString().split("T")[0] : "",
      age: p.age ?? "",
      bloodGroup: p.bloodGroup || "",
      address: p.address || "",
      insuranceProvider: p.insuranceProvider || "",
      insurancePolicyNumber: p.insurancePolicyNumber || "",
      registeredAt: p.user ? new Date(p.user.createdAt).toISOString() : "",
    }));

    const csv = toCsv(rows, [
      "mrNumber",
      "name",
      "email",
      "phone",
      "gender",
      "dateOfBirth",
      "age",
      "bloodGroup",
      "address",
      "insuranceProvider",
      "insurancePolicyNumber",
      "registeredAt",
    ]);

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="patients.csv"`);
    res.send(csv);
  } catch (err) {
    next(err);
  }
});

// ─── GET /analytics/benchmarks ──────────────────────

async function metricTotalForRange(
  metric: string,
  from: Date,
  to: Date
): Promise<number> {
  if (metric === "revenue") {
    const agg = await prisma.payment.aggregate({
      where: { paidAt: { gte: from, lte: to } },
      _sum: { amount: true },
    });
    return agg._sum.amount ?? 0;
  }
  if (metric === "appointments") {
    return prisma.appointment.count({ where: { date: { gte: from, lte: to } } });
  }
  if (metric === "admissions") {
    return prisma.admission.count({
      where: { admittedAt: { gte: from, lte: to } },
    });
  }
  return 0;
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (sorted[base + 1] !== undefined) {
    return sorted[base] + rest * (sorted[base + 1] - sorted[base]);
  }
  return sorted[base];
}

router.get(
  "/benchmarks",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const metric = (req.query.metric as string) || "revenue";
      if (!["revenue", "appointments", "admissions"].includes(metric)) {
        res.status(400).json({
          success: false,
          data: null,
          error: "metric must be revenue | appointments | admissions",
        });
        return;
      }
      const period = (req.query.period as string) || "day"; // day | week | month

      const periodDays = period === "week" ? 7 : period === "month" ? 30 : 1;
      const now = new Date();
      const currentTo = new Date(now);
      const currentFrom = new Date(now);
      currentFrom.setDate(currentFrom.getDate() - periodDays + 1);
      currentFrom.setHours(0, 0, 0, 0);

      const priorTo = new Date(currentFrom.getTime() - 1);
      const priorFrom = new Date(priorTo);
      priorFrom.setDate(priorFrom.getDate() - periodDays + 1);
      priorFrom.setHours(0, 0, 0, 0);

      const yoyFrom = new Date(currentFrom);
      yoyFrom.setFullYear(yoyFrom.getFullYear() - 1);
      const yoyTo = new Date(currentTo);
      yoyTo.setFullYear(yoyTo.getFullYear() - 1);

      const [current, prior, yoy] = await Promise.all([
        metricTotalForRange(metric, currentFrom, currentTo),
        metricTotalForRange(metric, priorFrom, priorTo),
        metricTotalForRange(metric, yoyFrom, yoyTo),
      ]);

      const yearAgo = new Date(now);
      yearAgo.setFullYear(yearAgo.getFullYear() - 1);
      yearAgo.setHours(0, 0, 0, 0);

      const samples: number[] = [];
      const sampleCount = period === "day" ? 90 : period === "week" ? 52 : 12;
      for (let i = 1; i <= sampleCount; i++) {
        const sTo = new Date(currentFrom);
        sTo.setDate(sTo.getDate() - i * periodDays);
        sTo.setHours(23, 59, 59, 999);
        const sFrom = new Date(sTo);
        sFrom.setDate(sFrom.getDate() - periodDays + 1);
        sFrom.setHours(0, 0, 0, 0);
        if (sFrom < yearAgo) break;
        const v = await metricTotalForRange(metric, sFrom, sTo);
        samples.push(v);
      }

      const rolling3 =
        samples.length >= 3
          ? samples.slice(0, 3).reduce((a, b) => a + b, 0) / 3
          : samples.length
          ? samples.reduce((a, b) => a + b, 0) / samples.length
          : 0;

      const sortedSamples = [...samples].sort((a, b) => a - b);
      const belowOrEqual = sortedSamples.filter((v) => v <= current).length;
      const percentile = sortedSamples.length
        ? Math.round((belowOrEqual / sortedSamples.length) * 100)
        : 50;

      let label = "Typical";
      if (percentile >= 90) label = "Above 90th percentile";
      else if (percentile >= 75) label = "Above typical";
      else if (percentile <= 10) label = "Below 10th percentile";
      else if (percentile <= 25) label = "Below typical";

      res.json({
        success: true,
        data: {
          metric,
          period,
          current,
          prior,
          yoy,
          rolling3Avg: +rolling3.toFixed(2),
          percentile,
          label,
          deltaVsPriorPct: deltaPct(current, prior),
          deltaVsYoyPct: deltaPct(current, yoy),
          p10: +quantile(sortedSamples, 0.1).toFixed(2),
          p25: +quantile(sortedSamples, 0.25).toFixed(2),
          p50: +quantile(sortedSamples, 0.5).toFixed(2),
          p75: +quantile(sortedSamples, 0.75).toFixed(2),
          p90: +quantile(sortedSamples, 0.9).toFixed(2),
          sampleCount: sortedSamples.length,
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /analytics/forecast ────────────────────────

router.get(
  "/forecast",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const metric = (req.query.metric as string) || "appointments";
      if (!["appointments", "revenue"].includes(metric)) {
        res.status(400).json({
          success: false,
          data: null,
          error: "metric must be appointments | revenue",
        });
        return;
      }
      const periods = Math.max(
        1,
        Math.min(30, parseInt((req.query.periods as string) || "7", 10))
      );
      const groupBy = parseGroupBy(req);

      const now = new Date();
      const points: { date: string; value: number }[] = [];
      const dayMs = 24 * 60 * 60 * 1000;
      const stepDays = groupBy === "week" ? 7 : groupBy === "month" ? 30 : 1;

      for (let i = 29; i >= 0; i--) {
        const to = new Date(now.getTime() - i * stepDays * dayMs);
        to.setHours(23, 59, 59, 999);
        const from = new Date(to);
        from.setDate(from.getDate() - stepDays + 1);
        from.setHours(0, 0, 0, 0);
        const v = await metricTotalForRange(metric, from, to);
        points.push({ date: bucketKeyFor(to, groupBy), value: v });
      }

      const n = points.length;
      const xs = points.map((_, i) => i);
      const ys = points.map((p) => p.value);
      const xMean = xs.reduce((a, b) => a + b, 0) / n;
      const yMean = ys.reduce((a, b) => a + b, 0) / n;
      let num = 0,
        den = 0;
      for (let i = 0; i < n; i++) {
        num += (xs[i] - xMean) * (ys[i] - yMean);
        den += (xs[i] - xMean) ** 2;
      }
      const slope = den === 0 ? 0 : num / den;
      const intercept = yMean - slope * xMean;

      let ssRes = 0,
        ssTot = 0;
      for (let i = 0; i < n; i++) {
        const pred = slope * xs[i] + intercept;
        ssRes += (ys[i] - pred) ** 2;
        ssTot += (ys[i] - yMean) ** 2;
      }
      const r2 = ssTot === 0 ? 0 : 1 - ssRes / ssTot;
      const confidence = r2 >= 0.75 ? "high" : r2 >= 0.4 ? "medium" : "low";

      const forecast: { period: string; value: number; confidence: string }[] = [];
      for (let i = 1; i <= periods; i++) {
        const x = n - 1 + i;
        const raw = slope * x + intercept;
        const futureDate = new Date(now.getTime() + i * stepDays * dayMs);
        forecast.push({
          period: bucketKeyFor(futureDate, groupBy),
          value: Math.max(0, +raw.toFixed(2)),
          confidence,
        });
      }

      res.json({
        success: true,
        data: {
          metric,
          groupBy,
          historical: points,
          forecast,
          model: {
            slope: +slope.toFixed(4),
            intercept: +intercept.toFixed(2),
            r2: +r2.toFixed(3),
          },
          confidence,
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─── Report runs (tracking) ────────────────────────

router.post(
  "/report-runs",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { reportType, parameters, snapshot, status = "SUCCESS", error } =
        req.body as {
          reportType: string;
          parameters?: Record<string, unknown>;
          snapshot?: Record<string, unknown>;
          status?: string;
          error?: string;
        };
      if (!reportType) {
        res
          .status(400)
          .json({ success: false, data: null, error: "reportType required" });
        return;
      }
      const row = await prisma.reportRun.create({
        data: {
          reportType,
          parameters: (parameters as any) ?? undefined,
          snapshot: (snapshot as any) ?? undefined,
          generatedBy: req.user!.userId,
          status,
          error: error ?? null,
        },
      });
      res.status(201).json({ success: true, data: row, error: null });
    } catch (err) {
      next(err);
    }
  }
);

router.get(
  "/report-runs",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const page = Math.max(1, parseInt((req.query.page as string) || "1", 10));
      const limit = Math.min(
        100,
        Math.max(1, parseInt((req.query.limit as string) || "50", 10))
      );
      const skip = (page - 1) * limit;

      const where: Record<string, unknown> = {};
      if (req.query.type) where.reportType = req.query.type;
      if (req.query.status) where.status = req.query.status;

      const gte = req.query.from ? new Date(req.query.from as string) : null;
      const lte = req.query.to ? new Date(req.query.to as string) : null;
      if (gte || lte) {
        where.generatedAt = {
          ...(gte ? { gte } : {}),
          ...(lte ? { lte } : {}),
        };
      }

      const [rows, total] = await Promise.all([
        prisma.reportRun.findMany({
          where: where as any,
          skip,
          take: limit,
          orderBy: { generatedAt: "desc" },
          include: {
            scheduledReport: { select: { id: true, name: true } },
          },
        }),
        prisma.reportRun.count({ where: where as any }),
      ]);

      res.json({
        success: true,
        data: rows,
        error: null,
        meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
      });
    } catch (err) {
      next(err);
    }
  }
);

router.get(
  "/report-runs/:id",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const row = await prisma.reportRun.findUnique({
        where: { id: req.params.id },
        include: {
          scheduledReport: { select: { id: true, name: true } },
        },
      });
      if (!row) {
        res
          .status(404)
          .json({ success: false, data: null, error: "Report run not found" });
        return;
      }
      res.json({ success: true, data: row, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// ─── GET /analytics/ai/triage ──────────────────────────

router.get(
  "/ai/triage",
  authenticate,
  authorize(Role.ADMIN, Role.RECEPTION, Role.DOCTOR),
  async (req: Request, res: Response, _next: NextFunction) => {
    // Issue #157: an unparseable row (new JSON shape, malformed
    // `messages`, missing column after a hot-reload) used to take the
    // whole tab down with a 500. Wrap the entire handler in a guard so
    // the worst case is a 200 with `data: null` + a `warning` string —
    // the AI Analytics tab can render an inline notice instead of
    // showing a generic error toast.
    try {
      const { from, to } = parseRange(req);

      const sessions = await prisma.aITriageSession.findMany({
        where: { createdAt: { gte: from, lte: to } },
      });

      const totalSessions = sessions.length;
      const completedSessions = sessions.filter((s) => s.status === "COMPLETED").length;
      const completionRate =
        totalSessions > 0 ? +(completedSessions / totalSessions).toFixed(4) : 0;

      const emergencyDetected = sessions.filter(
        (s) => s.status === "EMERGENCY_DETECTED" || s.redFlagDetected
      ).length;

      const bookingConversions = sessions.filter((s) => s.appointmentId != null).length;
      const conversionRate =
        totalSessions > 0 ? +(bookingConversions / totalSessions).toFixed(4) : 0;

      // avgTurnsToRecommendation: count of user-role messages per session
      let totalUserTurns = 0;
      let sessionCount = 0;
      const chiefComplaintCounts = new Map<string, number>();
      const specialtyCounts = new Map<string, number>();
      const languageCounts = new Map<string, number>();
      const statusCounts = new Map<string, number>();
      let totalConfidence = 0;
      let confidenceCount = 0;

      for (const s of sessions) {
        // Messages is a JSON array of { role, content } objects. Defensive:
        // older rows wrote a JSON-stringified array — coerce both shapes.
        // (Issue #83: the un-coerced read raised "messages.filter is not a
        // function" → 500.)
        let msgs: Array<{ role: string }> = [];
        const rawMsgs: unknown = s.messages;
        if (Array.isArray(rawMsgs)) {
          msgs = rawMsgs as Array<{ role: string }>;
        } else if (typeof rawMsgs === "string") {
          try {
            const parsed = JSON.parse(rawMsgs);
            if (Array.isArray(parsed)) msgs = parsed as Array<{ role: string }>;
          } catch {
            msgs = [];
          }
        }
        const userTurns = msgs.filter((m) => m && m.role === "user").length;
        totalUserTurns += userTurns;
        sessionCount++;

        // Chief complaint
        const cc = (s.chiefComplaint || "").trim();
        if (cc) chiefComplaintCounts.set(cc, (chiefComplaintCounts.get(cc) || 0) + 1);

        // Suggested specialties — flatten JSON array. The schema stores a
        // mix of `string[]` (older rows) and `Array<{ specialty: string }>`
        // (current shape from kpi-metrics top1AcceptanceRate). Handle both.
        if (s.suggestedSpecialties) {
          const raw = s.suggestedSpecialties as unknown;
          const specs = Array.isArray(raw) ? raw : [];
          for (const sp of specs) {
            if (typeof sp === "string") {
              specialtyCounts.set(sp, (specialtyCounts.get(sp) || 0) + 1);
            } else if (
              sp &&
              typeof sp === "object" &&
              typeof (sp as { specialty?: unknown }).specialty === "string"
            ) {
              const name = (sp as { specialty: string }).specialty;
              specialtyCounts.set(name, (specialtyCounts.get(name) || 0) + 1);
            }
          }
        }

        // Language
        const lang = (s.language || "en").toLowerCase();
        languageCounts.set(lang, (languageCounts.get(lang) || 0) + 1);

        // Status
        const st = s.status as string;
        statusCounts.set(st, (statusCounts.get(st) || 0) + 1);

        // Confidence
        if (typeof s.confidence === "number") {
          totalConfidence += s.confidence;
          confidenceCount++;
        }
      }

      const avgTurnsToRecommendation =
        sessionCount > 0 ? +(totalUserTurns / sessionCount).toFixed(2) : 0;
      const avgConfidence =
        confidenceCount > 0 ? +(totalConfidence / confidenceCount).toFixed(4) : 0;

      const topChiefComplaints = Array.from(chiefComplaintCounts.entries())
        .map(([complaint, count]) => ({ complaint, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 10);

      const specialtyDistribution = Array.from(specialtyCounts.entries())
        .map(([specialty, count]) => ({ specialty, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 10);

      const languageBreakdown = Array.from(languageCounts.entries())
        .map(([language, count]) => ({ language, count }))
        .sort((a, b) => b.count - a.count);

      const statusBreakdown = Array.from(statusCounts.entries())
        .map(([status, count]) => ({ status, count }))
        .sort((a, b) => b.count - a.count);

      res.json({
        success: true,
        data: {
          totalSessions,
          completedSessions,
          completionRate,
          emergencyDetected,
          bookingConversions,
          conversionRate,
          avgTurnsToRecommendation,
          avgConfidence,
          topChiefComplaints,
          specialtyDistribution,
          languageBreakdown,
          statusBreakdown,
        },
        error: null,
      });
    } catch (err) {
      // Issue #157: never let a single malformed row take the analytics
      // tab down with a 500. Log and degrade to an empty payload + warn.
      console.error("[analytics:/ai/triage] degraded:", err);
      res.status(200).json({
        success: true,
        data: null,
        warning: "Some sessions could not be parsed",
        error: null,
      });
    }
  }
);

// ─── GET /analytics/ai/scribe ───────────────────────────

router.get(
  "/ai/scribe",
  authenticate,
  authorize(Role.ADMIN, Role.RECEPTION, Role.DOCTOR),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { from, to } = parseRange(req);

      const sessions = await prisma.aIScribeSession.findMany({
        where: { createdAt: { gte: from, lte: to } },
      });

      const totalSessions = sessions.length;
      const completedSessions = sessions.filter((s) => s.status === "COMPLETED").length;
      const consentWithdrawnSessions = sessions.filter(
        (s) => s.status === "CONSENT_WITHDRAWN"
      ).length;

      // avgDoctorEditRate: average of doctorEdits array length across completed sessions
      const completed = sessions.filter((s) => s.status === "COMPLETED");
      let totalEdits = 0;
      for (const s of completed) {
        const edits = Array.isArray(s.doctorEdits) ? (s.doctorEdits as unknown[]) : [];
        totalEdits += edits.length;
      }
      const avgDoctorEditRate =
        completed.length > 0 ? +(totalEdits / completed.length).toFixed(2) : 0;

      // drugAlertRate: sessions where rxDraft has alerts field (non-empty array) / total
      let sessionsWithDrugAlerts = 0;
      let totalDrugAlerts = 0;
      for (const s of sessions) {
        if (!s.rxDraft) continue;
        const rx = s.rxDraft as Record<string, unknown>;
        const alerts = Array.isArray(rx.alerts) ? (rx.alerts as unknown[]) : [];
        if (alerts.length > 0) {
          sessionsWithDrugAlerts++;
          totalDrugAlerts += alerts.length;
        }
      }
      const drugAlertRate =
        totalSessions > 0
          ? +(sessionsWithDrugAlerts / totalSessions).toFixed(4)
          : 0;

      const statusCounts = new Map<string, number>();
      for (const s of sessions) {
        const st = s.status as string;
        statusCounts.set(st, (statusCounts.get(st) || 0) + 1);
      }
      const statusBreakdown = Array.from(statusCounts.entries())
        .map(([status, count]) => ({ status, count }))
        .sort((a, b) => b.count - a.count);

      res.json({
        success: true,
        data: {
          totalSessions,
          completedSessions,
          consentWithdrawnSessions,
          avgDoctorEditRate,
          drugAlertRate,
          totalDrugAlerts,
          statusBreakdown,
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─── LWBS / QUEUE WALKOUTS (Apr 2026) ──────────────────
// GET /analytics/queue-walkouts?from=&to=
router.get(
  "/queue-walkouts",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { from, to } = parseRange(req);
      const appts = await prisma.appointment.findMany({
        where: {
          date: { gte: from, lte: to },
          status: "NO_SHOW",
          lwbsReason: { not: null },
        },
        include: {
          doctor: { include: { user: { select: { name: true } } } },
          patient: { include: { user: { select: { name: true } } } },
        },
      });

      const totalLwbs = appts.length;

      // Group by doctor
      const byDoctor = new Map<
        string,
        { doctorId: string; doctorName: string; count: number }
      >();
      for (const a of appts) {
        const cur =
          byDoctor.get(a.doctorId) || {
            doctorId: a.doctorId,
            doctorName: a.doctor.user.name,
            count: 0,
          };
        cur.count += 1;
        byDoctor.set(a.doctorId, cur);
      }
      const byDoctorArr = Array.from(byDoctor.values()).sort(
        (a, b) => b.count - a.count
      );

      // Group by hour-of-day
      const byHour: Array<{ hour: number; count: number }> = [];
      for (let h = 0; h < 24; h++) byHour.push({ hour: h, count: 0 });
      for (const a of appts) {
        let hour: number | null = null;
        if (a.slotStart) {
          hour = parseInt(a.slotStart.split(":")[0], 10);
        } else if (a.checkInAt) {
          hour = new Date(a.checkInAt).getUTCHours();
        }
        if (hour !== null && hour >= 0 && hour < 24) {
          byHour[hour].count += 1;
        }
      }

      // Group by reason
      const byReason = new Map<string, number>();
      for (const a of appts) {
        const r = (a.lwbsReason || "Not specified").trim();
        byReason.set(r, (byReason.get(r) || 0) + 1);
      }
      const byReasonArr = Array.from(byReason.entries())
        .map(([reason, count]) => ({ reason, count }))
        .sort((a, b) => b.count - a.count);

      res.json({
        success: true,
        data: {
          from,
          to,
          totalLwbs,
          byDoctor: byDoctorArr,
          byHour,
          byReason: byReasonArr,
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

export { router as analyticsRouter };
