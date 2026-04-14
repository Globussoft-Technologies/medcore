import { Router, Request, Response, NextFunction } from "express";
import { prisma } from "@medcore/db";
import { Role } from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";

const router = Router();
router.use(authenticate);
router.use(authorize(Role.ADMIN, Role.RECEPTION));

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
    consultations,
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
    prisma.consultation.findMany({
      where: { createdAt: { gte: from, lte: to } },
      select: { createdAt: true, updatedAt: true },
    }),
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

  const revenueByMode: Record<string, number> = {
    CASH: 0,
    CARD: 0,
    UPI: 0,
    ONLINE: 0,
    INSURANCE: 0,
  };
  let totalRevenue = 0;
  payments.forEach((p) => {
    totalRevenue += p.amount;
    revenueByMode[p.mode] = (revenueByMode[p.mode] || 0) + p.amount;
  });

  let avgConsultationTime = 0;
  if (consultations.length > 0) {
    const totalMs = consultations.reduce(
      (sum, c) => sum + (new Date(c.updatedAt).getTime() - new Date(c.createdAt).getTime()),
      0
    );
    avgConsultationTime = Math.round(totalMs / consultations.length / 60000);
  }

  return {
    totalPatients,
    newPatientsInPeriod,
    totalAppointments,
    appointmentsByStatus,
    totalRevenue,
    revenueByMode,
    pendingBills,
    currentlyAdmitted,
    avgConsultationTime,
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

router.get("/overview", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { from, to } = parseRange(req);
    const compareMode = req.query.compareMode as
      | "previous_period"
      | "previous_year"
      | undefined;

    const current = await computeOverviewSnapshot(from, to);

    if (!compareMode) {
      res.json({ success: true, data: current, error: null });
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
    ];
    const deltaPercent: Record<string, number> = {};
    numericKeys.forEach((k) => {
      deltaPercent[k as string] = deltaPct(
        Number(current[k] || 0),
        Number(previous[k] || 0)
      );
    });

    res.json({
      success: true,
      data: {
        current,
        previous,
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

router.get("/revenue", async (req: Request, res: Response, next: NextFunction) => {
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

router.get("/revenue/breakdown", async (req: Request, res: Response, next: NextFunction) => {
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
        appointments: {
          where: { date: { gte: from, lte: to } },
          include: {
            consultation: { select: { createdAt: true, updatedAt: true } },
            invoice: { include: { payments: true } },
          },
        },
      },
    });

    const data = doctors.map((doc) => {
      const appts = doc.appointments;
      const appointmentCount = appts.length;
      const completedCount = appts.filter((a) => a.status === "COMPLETED").length;
      const patientIds = new Set(appts.map((a) => a.patientId));

      const consultationDurations = appts
        .map((a) => a.consultation)
        .filter((c): c is NonNullable<typeof c> => !!c)
        .map((c) => new Date(c.updatedAt).getTime() - new Date(c.createdAt).getTime());

      const avgDurationMin =
        consultationDurations.length > 0
          ? Math.round(
              consultationDurations.reduce((sum, d) => sum + d, 0) /
                consultationDurations.length /
                60000
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

    res.json({
      success: true,
      data: {
        totalCases,
        criticalCases,
        avgWaitToTriageMin,
        avgWaitToDoctorMin,
        byTriage,
        byDisposition,
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

router.get("/export/revenue.csv", async (req: Request, res: Response, next: NextFunction) => {
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

export { router as analyticsRouter };
