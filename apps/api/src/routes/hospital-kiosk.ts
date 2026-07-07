import { Router, Request, Response, NextFunction } from "express";
import crypto from "crypto";
import QRCode from "qrcode";
import { prisma } from "@medcore/db";
import { Role, type AuthPayload } from "@medcore/shared";
import { verifyAccessToken } from "../services/jwt";
import { rateLimit } from "../middleware/rate-limit";
import { auditLog } from "../middleware/audit";
import { istNowMinutes, istTodayDateStr } from "../utils/ist-time";
import { isDoctorOnConfirmedLeave } from "../utils/doctor-leave";
import { siteBaseUrl } from "../lib/site-link";
import {
  notifyQueuePosition,
  onPatientCheckedIn,
} from "../services/notification-triggers";

export const hospitalKioskRouter = Router();
const DEFAULT_SLOT_DURATION_MINUTES = 15;

function todayYmd(): string {
  return new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function dayRange(date = todayYmd()) {
  const start = new Date(date);
  start.setUTCHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 1);
  return { start, end };
}

/** Resolve a validated, active tenant id from a raw tenant id. */
async function activeTenantId(id: string | undefined | null): Promise<string | null> {
  if (!id?.trim()) return null;
  const tenant = await prisma.tenant.findUnique({
    where: { id: id.trim() },
    select: { id: true, active: true },
  });
  return tenant?.active ? tenant.id : null;
}

/**
 * Resolve a tenant from its human-friendly hospital CODE (e.g. "PG-01").
 * The code lives in SystemConfig under `tenant:<id>:code` (display/MR use),
 * so we match value → key → id, then confirm the tenant is active. Match is
 * case-insensitive on the trimmed code.
 */
async function resolveTenantByCode(code: string | undefined | null): Promise<string | null> {
  const wanted = code?.trim();
  if (!wanted) return null;
  const rows = await prisma.systemConfig.findMany({
    where: { key: { startsWith: "tenant:", endsWith: ":code" } },
    select: { key: true, value: true },
  });
  for (const row of rows) {
    if (row.value?.trim().toLowerCase() !== wanted.toLowerCase()) continue;
    const m = row.key.match(/^tenant:([^:]+):code$/);
    if (m) return activeTenantId(m[1]);
  }
  return null;
}

/**
 * Resolve which hospital (tenant) a kiosk request is for. Priority:
 *   1. `req.tenantId` — an authenticated patient always sees THEIR hospital
 *      (Flow 3), and a header-carried X-Tenant-Id is honoured upstream.
 *   2. QR-carried `?tenantId=<uuid>` — the scanned hospital QR (guest, Flow 1/2).
 *   3. QR-carried `?code=<PG-01>` or `X-Tenant-Code` header — friendly code.
 *   4. `X-Tenant-Id` header (server-to-server / explicit).
 *   5. Fallback to the seeded `default` tenant (single-hospital deploys).
 * This is what makes ONE hospital QR route guests to the correct hospital.
 */
async function resolveTenant(req: Request): Promise<string | null> {
  if (req.tenantId) return req.tenantId;

  const queryTenantId =
    typeof req.query.tenantId === "string" ? req.query.tenantId : undefined;
  const byQueryId = await activeTenantId(queryTenantId);
  if (byQueryId) return byQueryId;

  const code =
    (typeof req.query.code === "string" ? req.query.code : undefined) ??
    req.header("X-Tenant-Code") ??
    undefined;
  const byCode = await resolveTenantByCode(code);
  if (byCode) return byCode;

  const byHeader = await activeTenantId(req.header("X-Tenant-Id"));
  if (byHeader) return byHeader;

  const fallback =
    (await prisma.tenant.findFirst({
      where: { active: true, subdomain: "default" },
      select: { id: true },
    })) ??
    (await prisma.tenant.findFirst({
      where: { active: true },
      orderBy: { createdAt: "asc" },
      select: { id: true },
    }));
  return fallback?.id ?? null;
}

function optionalAuth(req: Request): AuthPayload | null {
  const cookieToken = (req as Request & { cookies?: Record<string, string> })
    .cookies?.medcore_at;
  const header = req.headers.authorization;
  const headerToken = header?.startsWith("Bearer ")
    ? header.slice("Bearer ".length)
    : undefined;
  const token = cookieToken || headerToken;
  if (!token) return null;
  try {
    const decoded = verifyAccessToken<
      Partial<AuthPayload> & { userId: string; email: string | null; role: Role }
    >(token);
    return {
      userId: decoded.userId,
      email: decoded.email,
      role: decoded.role,
      ...(decoded.tenantId !== undefined ? { tenantId: decoded.tenantId } : {}),
      ...(decoded.jti ? { jti: decoded.jti } : {}),
    };
  } catch {
    return null;
  }
}

async function publicDirectory(req: Request) {
  const tenantId = await resolveTenant(req);
  // Optional server-side department (specialization) filter — the kiosk's
  // department dropdown re-fetches with ?department=<name>. "All" / empty →
  // no filter. The `departments` list below is always computed UNFILTERED so
  // the dropdown keeps every department regardless of the current selection.
  const department =
    typeof req.query.department === "string" && req.query.department.trim() &&
    req.query.department.trim().toLowerCase() !== "all"
      ? req.query.department.trim()
      : null;
  // Server-side doctor search — by doctor NAME or DEPARTMENT (specialization).
  // The kiosk search box re-fetches with ?search=<term> (debounced).
  const search =
    typeof req.query.search === "string" && req.query.search.trim()
      ? req.query.search.trim()
      : null;

  const doctors = await prisma.doctor.findMany({
    where: {
      ...(tenantId ? { tenantId } : {}),
      user: { isActive: true },
      ...(department
        ? { specialization: { equals: department, mode: "insensitive" } }
        : {}),
      ...(search
        ? {
            OR: [
              { user: { name: { contains: search, mode: "insensitive" } } },
              { specialization: { contains: search, mode: "insensitive" } },
              { qualification: { contains: search, mode: "insensitive" } },
            ],
          }
        : {}),
    },
    orderBy: [{ specialization: "asc" }, { user: { name: "asc" } }],
    take: 100,
    select: {
      id: true,
      specialization: true,
      qualification: true,
      experienceYears: true,
      appointmentMode: true,
      consultationFee: true,
      averageRating: true,
      user: { select: { name: true } },
    },
  });
  // Full department list (unfiltered) so the dropdown stays complete.
  const allDoctors = department
    ? await prisma.doctor.findMany({
        where: { ...(tenantId ? { tenantId } : {}), user: { isActive: true } },
        select: { specialization: true },
      })
    : doctors;
  const departments = Array.from(
    new Set(allDoctors.map((d) => d.specialization).filter(Boolean) as string[]),
  ).sort((a, b) => a.localeCompare(b));
  const hospital = tenantId
    ? await prisma.tenant.findUnique({
        where: { id: tenantId },
        select: { id: true, name: true, subdomain: true },
      })
    : null;

  return {
    tenantId,
    hospital,
    departments,
    doctors: doctors.map((d) => ({
      ...d,
      consultationFee: d.consultationFee != null ? Number(d.consultationFee) : null,
      averageRating: d.averageRating != null ? Number(d.averageRating) : null,
    })),
  };
}

async function nextToken(doctorId: string, date: Date): Promise<number> {
  const { start, end } = dayRange(date.toISOString().slice(0, 10));
  const result = await prisma.appointment.aggregate({
    where: { doctorId, date: { gte: start, lt: end } },
    _max: { tokenNumber: true },
  });
  return (result._max.tokenNumber ?? 0) + 1;
}

async function nextArrivalSeq(doctorId: string, date: Date): Promise<number> {
  const { start, end } = dayRange(date.toISOString().slice(0, 10));
  const result = await prisma.appointment.aggregate({
    where: { doctorId, date: { gte: start, lt: end } },
    _max: { arrivalSeq: true },
  });
  return (result._max.arrivalSeq ?? 0) + 1;
}

// Average consultation length used for the queue wait estimate. Matches the
// constant used by queue.ts / notification-triggers.ts (no per-doctor config).
const AVG_CONSULT_MINUTES = 15;

/**
 * Estimate the wait (minutes) for a just-checked-in appointment: count the
 * patients AHEAD of it in the same doctor's live queue today × avg consult.
 *   • TOKEN   → active patients with a lower tokenNumber
 *   • CALLING → active patients with a lower arrivalSeq
 *   • SLOT    → 0 (the patient has a booked time)
 * "Active" = still IN_CONSULTATION or waiting (CHECKED_IN).
 */
async function estimateWaitMinutes(appt: {
  doctorId: string;
  date: Date;
  tokenNumber: number | null;
  arrivalSeq: number | null;
  mode: string;
}): Promise<number> {
  const { start, end } = dayRange(appt.date.toISOString().slice(0, 10));
  const activeStatuses = ["CHECKED_IN", "IN_CONSULTATION"] as const;
  let ahead = 0;
  if (appt.mode === "TOKEN" && appt.tokenNumber != null) {
    ahead = await prisma.appointment.count({
      where: {
        doctorId: appt.doctorId,
        date: { gte: start, lt: end },
        status: { in: [...activeStatuses] },
        tokenNumber: { lt: appt.tokenNumber, not: null },
      },
    });
  } else if (appt.mode === "CALLING" && appt.arrivalSeq != null) {
    ahead = await prisma.appointment.count({
      where: {
        doctorId: appt.doctorId,
        date: { gte: start, lt: end },
        status: { in: [...activeStatuses] },
        arrivalSeq: { lt: appt.arrivalSeq, not: null },
      },
    });
  }
  return ahead * AVG_CONSULT_MINUTES;
}

hospitalKioskRouter.get(
  "/session",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const directory = await publicDirectory(req);
      const datePart = todayYmd().replace(/-/g, "");
      res.json({
        success: true,
        data: {
          ...directory,
          guest: {
            temporaryPatientId: `TMP-${datePart}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`,
          },
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  },
);

// GET /hospital-kiosk/qr — STAFF ONLY. Returns the scannable hospital QR for
// the caller's hospital. Reception opens the "Hospital QR" screen to display /
// print this; a patient scans it with their phone camera → the encoded URL
// (/hospital/qr?tenantId=<this hospital>) opens the kiosk scoped to THIS
// hospital. The QR encodes only a public URL — no PHI.
hospitalKioskRouter.get(
  "/qr",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = optionalAuth(req);
      const STAFF_ROLES = [Role.ADMIN, Role.RECEPTION, Role.DOCTOR, Role.NURSE];
      if (!user || !STAFF_ROLES.includes(user.role)) {
        res.status(401).json({
          success: false,
          data: null,
          error: "Staff sign-in required to view the hospital QR.",
        });
        return;
      }
      const tenantId = user.tenantId ?? (await resolveTenant(req));
      if (!tenantId) {
        res.status(404).json({
          success: false,
          data: null,
          error: "No hospital could be resolved for this account.",
        });
        return;
      }
      const hospital = await prisma.tenant.findUnique({
        where: { id: tenantId },
        select: { name: true },
      });
      const url = `${siteBaseUrl(req)}/hospital/qr?tenantId=${encodeURIComponent(tenantId)}`;
      const qrDataUrl = await QRCode.toDataURL(url, {
        type: "image/png",
        errorCorrectionLevel: "M",
        width: 512,
        margin: 2,
      });
      res.json({
        success: true,
        data: { tenantId, hospitalName: hospital?.name ?? null, url, qrDataUrl },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  },
);

hospitalKioskRouter.get(
  "/doctors/:id/slots",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const date = typeof req.query.date === "string" ? req.query.date : todayYmd();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        res.status(400).json({ success: false, data: null, error: "date must be YYYY-MM-DD" });
        return;
      }
      if (date < istTodayDateStr()) {
        res.json({ success: true, data: { date, slots: [] }, error: null });
        return;
      }
      const dateObj = new Date(date);
      if (await isDoctorOnConfirmedLeave(req.params.id, dateObj)) {
        res.json({
          success: true,
          data: { date, slots: [], blocked: true, reason: "Doctor is unavailable on this date" },
          error: null,
        });
        return;
      }
      const dayOfWeek = dateObj.getDay();
      const override = await prisma.scheduleOverride.findUnique({
        where: { doctorId_date: { doctorId: req.params.id, date: dateObj } },
      });
      if (override?.isBlocked) {
        res.json({
          success: true,
          data: { date, slots: [], blocked: true, reason: override.reason ?? "Doctor unavailable" },
          error: null,
        });
        return;
      }
      const schedules = await prisma.doctorSchedule.findMany({
        where: { doctorId: req.params.id, dayOfWeek },
      });
      const existing = await prisma.appointment.findMany({
        where: {
          doctorId: req.params.id,
          date: dateObj,
          status: { notIn: ["CANCELLED", "NO_SHOW"] },
        },
        select: { slotStart: true },
      });
      const booked = new Set(existing.map((a) => a.slotStart).filter(Boolean));
      const isToday = date === istTodayDateStr();
      const nowMin = istNowMinutes();
      const slots: Array<{ startTime: string; endTime: string; isAvailable: boolean }> = [];
      for (const schedule of schedules) {
        const startTime = override?.startTime || schedule.startTime;
        const endTime = override?.endTime || schedule.endTime;
        const duration = schedule.slotDurationMinutes || DEFAULT_SLOT_DURATION_MINUTES;
        const step = duration + (schedule.bufferMinutes || 0);
        const [sh, sm] = startTime.split(":").map(Number);
        const [eh, em] = endTime.split(":").map(Number);
        for (let m = sh * 60 + sm; m + duration <= eh * 60 + em; m += step) {
          if (isToday && m < nowMin) continue;
          const startSlot = `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
          const endSlot = `${String(Math.floor((m + duration) / 60)).padStart(2, "0")}:${String((m + duration) % 60).padStart(2, "0")}`;
          slots.push({ startTime: startSlot, endTime: endSlot, isAvailable: !booked.has(startSlot) });
        }
      }
      res.json({ success: true, data: { date, slots }, error: null });
    } catch (err) {
      next(err);
    }
  },
);

hospitalKioskRouter.get(
  "/me",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = optionalAuth(req);
      const directory = await publicDirectory(req);
      if (!user || user.role !== Role.PATIENT) {
        res.json({ success: true, data: { authenticated: false, ...directory }, error: null });
        return;
      }

      const patient = await prisma.patient.findUnique({
        where: { userId: user.userId },
        include: { user: { select: { name: true, phone: true, email: true } } },
      });
      if (!patient) {
        res.json({ success: true, data: { authenticated: false, ...directory }, error: null });
        return;
      }

      const { start, end } = dayRange();
      const [
        todaysAppointments,
        upcomingAppointments,
        prescriptions,
        pendingBills,
        labReports,
        referrals,
        notifications,
      ] = await Promise.all([
        prisma.appointment.findMany({
          where: {
            patientId: patient.id,
            date: { gte: start, lt: end },
            status: { notIn: ["CANCELLED", "NO_SHOW", "COMPLETED"] },
          },
          include: { doctor: { include: { user: { select: { name: true } } } } },
          orderBy: [{ slotStart: "asc" }, { tokenNumber: "asc" }],
        }),
        prisma.appointment.findMany({
          where: {
            patientId: patient.id,
            date: { gte: start },
            status: { in: ["BOOKED", "CHECKED_IN", "IN_CONSULTATION"] },
          },
          include: { doctor: { include: { user: { select: { name: true } } } } },
          orderBy: [{ date: "asc" }, { slotStart: "asc" }],
          take: 8,
        }),
        prisma.prescription.findMany({
          where: { patientId: patient.id },
          include: { doctor: { include: { user: { select: { name: true } } } } },
          orderBy: { createdAt: "desc" },
          take: 5,
        }),
        prisma.invoice.findMany({
          where: { patientId: patient.id, paymentStatus: { in: ["PENDING", "PARTIAL"] } },
          orderBy: { createdAt: "desc" },
          take: 5,
        }),
        prisma.labOrder.findMany({
          where: { patientId: patient.id },
          include: { items: { include: { test: { select: { name: true } } } } },
          orderBy: { orderedAt: "desc" },
          take: 5,
        }),
        prisma.referral.findMany({
          where: { patientId: patient.id },
          orderBy: { referredAt: "desc" },
          take: 5,
        }),
        prisma.notification.findMany({
          where: { userId: user.userId, readAt: null },
          orderBy: { createdAt: "desc" },
          take: 5,
        }),
      ]);

      res.json({
        success: true,
        data: {
          authenticated: true,
          ...directory,
          patient: {
            id: patient.id,
            name: patient.user.name,
            patientId: patient.mrNumber,
            phone: patient.user.phone,
            email: patient.contactEmail ?? patient.user.email,
            // Demographics so the kiosk booking form can auto-fill + lock them
            // for a logged-in patient (only Reason-for-visit stays editable).
            gender: patient.gender,
            dateOfBirth: patient.dateOfBirth
              ? patient.dateOfBirth.toISOString().slice(0, 10)
              : null,
          },
          todaysAppointments,
          upcomingAppointments,
          prescriptions,
          pendingBills: pendingBills.map((b) => ({
            ...b,
            subtotal: Number(b.subtotal),
            totalAmount: Number(b.totalAmount),
            taxAmount: Number(b.taxAmount),
          })),
          labReports,
          medicalHistory: {
            prescriptions: prescriptions.length,
            labReports: labReports.length,
            pendingBills: pendingBills.length,
          },
          referrals,
          notifications,
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  },
);

hospitalKioskRouter.post(
  "/check-in",
  rateLimit(30, 60_000),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = optionalAuth(req);
      if (!user || user.role !== Role.PATIENT) {
        res.status(401).json({ success: false, data: null, error: "Please sign in to check in." });
        return;
      }
      const appointmentId =
        typeof req.body?.appointmentId === "string" ? req.body.appointmentId : "";
      if (!appointmentId) {
        res.status(400).json({ success: false, data: null, error: "appointmentId is required" });
        return;
      }
      const patient = await prisma.patient.findUnique({
        where: { userId: user.userId },
        select: { id: true },
      });
      if (!patient) {
        res.status(403).json({ success: false, data: null, error: "Patient profile not found" });
        return;
      }
      const { start, end } = dayRange();
      const existing = await prisma.appointment.findFirst({
        where: {
          id: appointmentId,
          patientId: patient.id,
          date: { gte: start, lt: end },
        },
        include: { doctor: { include: { user: { select: { name: true } } } } },
      });
      if (!existing) {
        res.status(404).json({
          success: false,
          data: null,
          error: "No appointment for today was found.",
        });
        return;
      }
      if (existing.status !== "BOOKED") {
        res.status(409).json({
          success: false,
          data: null,
          error: "This appointment is not available for self check-in.",
        });
        return;
      }

      const data: Record<string, unknown> = {
        status: "CHECKED_IN",
        checkInAt: new Date(),
      };
      if (existing.doctor.appointmentMode === "TOKEN" && existing.tokenNumber == null) {
        data.tokenNumber = await nextToken(existing.doctorId, existing.date);
      }
      if (existing.doctor.appointmentMode === "CALLING" && existing.arrivalSeq == null) {
        data.arrivalSeq = await nextArrivalSeq(existing.doctorId, existing.date);
      }

      const appointment = await prisma.appointment.update({
        where: { id: existing.id },
        data,
        include: { doctor: { include: { user: { select: { name: true } } } } },
      });

      const io = req.app.get("io");
      if (io) {
        io.to(`queue:${appointment.doctorId}`).emit("queue-updated", {
          doctorId: appointment.doctorId,
          date: appointment.date.toISOString().slice(0, 10),
        });
        io.to("token-display").emit("queue-updated", {
          doctorId: appointment.doctorId,
          date: appointment.date.toISOString().slice(0, 10),
        });
      }
      notifyQueuePosition(appointment.id).catch(console.error);
      onPatientCheckedIn(appointment.patientId).catch(console.error);
      auditLog(req, "KIOSK_PATIENT_SELF_CHECKIN", "appointment", appointment.id, {
        patientId: appointment.patientId,
      }).catch(console.error);

      const estimatedWaitMinutes = await estimateWaitMinutes({
        doctorId: appointment.doctorId,
        date: appointment.date,
        tokenNumber: appointment.tokenNumber,
        arrivalSeq: appointment.arrivalSeq,
        mode: appointment.doctor.appointmentMode,
      });

      res.json({
        success: true,
        data: {
          appointment,
          tokenNumber: appointment.tokenNumber,
          arrivalSeq: appointment.arrivalSeq,
          department: appointment.doctor.specialization,
          doctorName: appointment.doctor.user.name,
          roomNumber: appointment.doctor.specialization
            ? `${appointment.doctor.specialization} OPD`
            : "OPD",
          estimatedWaitMinutes,
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  },
);
