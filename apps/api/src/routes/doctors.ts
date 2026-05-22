import { Router, Request, Response, NextFunction } from "express";
// Multi-tenant wiring: `tenantScopedPrisma` is a Prisma $extends wrapper that
// auto-injects tenantId on create and auto-filters on read for the 20
// tenant-scoped models (see services/tenant-prisma.ts). We alias it to
// `prisma` so every existing call site keeps working without edits.
import { tenantScopedPrisma as prisma } from "../services/tenant-prisma";
// Raw (unscoped) prisma is needed for the bulk-update cross-tenant probe —
// we want to LOOK at every row matching the requested ids regardless of
// tenant, then explicitly compare each row's tenantId to the caller's so
// we can return 403 (instead of silently no-op'ing the cross-tenant rows
// the way `tenantScopedPrisma` would). See `/bulk-update` handler below.
import { prisma as rawPrisma } from "@medcore/db";
import {
  Role,
  doctorScheduleSchema,
  scheduleOverrideSchema,
  doctorAppointmentModeSchema,
  bulkUpdateDoctorsSchema,
  BULK_UPDATE_ALLOWED_FIELDS,
  DEFAULT_SLOT_DURATION_MINUTES,
} from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { auditLog } from "../middleware/audit";

const router = Router();
router.use(authenticate);

// GET /api/v1/doctors — list all doctors
//
// #511 audit (2026-05-05, cron-tick): PATCHED — catalog endpoint surface.
// PATIENTs need to read doctor profiles to pick whom to book with, so the
// route stays PATIENT-reachable (intentional). BUT the previous shape
// exposed `user.email` and `user.phone` of every doctor to any authed
// user — that's HR-class PII a patient does not need to book a slot. Per
// the `3beeeaf` precedent (eager-include leak in catalog endpoints),
// branch the projection by caller role: PATIENTs see only `id + name +
// isActive`; staff (ADMIN, DOCTOR, RECEPTION, NURSE, PHARMACIST) keep
// the full email + phone for the directory page.
router.get("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const isPatient = req.user?.role === "PATIENT";
    const doctors = await prisma.doctor.findMany({
      include: {
        user: {
          select: isPatient
            ? { id: true, name: true, isActive: true }
            : { id: true, name: true, email: true, phone: true, isActive: true },
        },
        schedules: true,
      },
    });

    res.json({ success: true, data: doctors, error: null });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/doctors/bulk-update
//
// Pearl ERP Stage 1 §3.1 (gap row 74) — bulk-edit dialog for admins.
// Applies the same subset of appointment-mode knobs to N doctors at once
// inside a single $transaction so the batch is all-or-nothing (if any one
// row fails Prisma rolls the whole thing back; tests assert this).
//
// Mounted BEFORE any `/:id`-shaped route per the static-before-dynamic
// gotcha (CLAUDE.md §14): otherwise Express would route POST /bulk-update
// to a dynamic `:id` handler whose pattern happens to match.
//
// Tenant scoping: the route loads every doctorId via the RAW (unscoped)
// prisma client and explicitly compares each row's `tenantId` against the
// caller's. We deliberately do NOT use `tenantScopedPrisma` for this probe
// because its ALS-driven filter is a no-op when the caller's JWT carries no
// tenantId (legacy admins, the test admin@test.local seed) — under that
// regime the auto-filter would let foreign-tenant rows through silently.
// The unscoped lookup + explicit comparison treats `null === null` and
// `tenant-A !== tenant-B` correctly in BOTH regimes. Set-difference reveals
// any cross-tenant or bogus id without leaking which it was → 403 + 0 rows
// modified. This is the BOLA / IDOR guard for the bulk surface.
//
// Allowlist: the Zod schema is `.strict()` so unknown keys 400 before we
// even reach the handler — mass-assignment of unrelated columns (e.g.
// `isActive: false` to deactivate a competitor's doctors) is impossible.
router.post(
  "/bulk-update",
  authorize(Role.ADMIN),
  validate(bulkUpdateDoctorsSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { doctorIds, updates } = req.body as {
        doctorIds: string[];
        updates: Record<string, unknown>;
      };

      // Step 1 — tenant-scope check via explicit per-row comparison on the
      // unscoped client. `rawPrisma.doctor.findMany` returns every matching
      // row regardless of tenant, then we keep only the rows whose
      // `tenantId` equals the caller's (with `null === null` honoured for
      // legacy un-tenanted admins). Any requested id that's either bogus
      // (no row) or owned by a different tenant ends up "missing" → 403,
      // and we never reach the update step, so the cross-tenant rows stay
      // untouched. We do NOT leak which ids failed which check.
      const callerTenantId = req.user?.tenantId ?? null;
      const candidates = await rawPrisma.doctor.findMany({
        where: { id: { in: doctorIds } },
        select: { id: true, tenantId: true },
      });
      const ownedIds = new Set(
        candidates
          .filter((d) => (d.tenantId ?? null) === callerTenantId)
          .map((d) => d.id),
      );
      const missing = doctorIds.filter((id) => !ownedIds.has(id));
      if (missing.length > 0) {
        res.status(403).json({
          success: false,
          data: null,
          error: "Some doctorIds are not in your tenant",
        });
        return;
      }

      // Step 2 — build the column payload from the allowlist. Re-using
      // the shared constant guarantees the route and the schema can never
      // drift on what's editable. `undefined` is dropped (PATCH-style
      // partial update); `null` is preserved (explicit clear).
      const data: Record<string, unknown> = {};
      for (const field of BULK_UPDATE_ALLOWED_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(updates, field)) {
          data[field] = updates[field];
        }
      }

      // Step 3 — single $transaction so the batch is atomic. If any one
      // update throws (e.g. concurrent delete), Prisma rolls back all.
      const updateOps = doctorIds.map((id) =>
        prisma.doctor.update({ where: { id }, data, select: { id: true } }),
      );
      const updated = await prisma.$transaction(updateOps);

      // auditLog is awaited (NOT safeAudit) so the bulk operation's audit
      // row is durable before the 200 lands — the bulk surface is rare +
      // high-impact, callers should see the row in the audit log
      // immediately after the response.
      await auditLog(req, "DOCTORS_BULK_UPDATE", "doctor", "bulk", {
        doctorIds,
        updates: data,
        updatedCount: updated.length,
      });

      res.json({
        success: true,
        data: {
          updatedCount: updated.length,
          updatedDoctorIds: updated.map((u) => u.id),
          updates: data,
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  },
);

// GET /api/v1/doctors/:id/schedule — list weekly schedule slots
//
// Issue #56 / #77 — the Schedule Management page calls this endpoint to render
// the per-day grid; previously only POST existed, so the GET 404'd silently
// and the grid stayed empty. We expose a thin read-only wrapper around
// `DoctorSchedule` that also normalises the wire shape to what the page
// expects (slotDuration, dayOfWeek as a label so the existing UI grid keys
// match without a Number→Name mapping in the page).
// #511 audit: VERIFIED-SAFE — authorize() excludes PATIENT.
router.get(
  "/:id/schedule",
  authorize(Role.ADMIN, Role.DOCTOR, Role.RECEPTION, Role.NURSE),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const rows = await prisma.doctorSchedule.findMany({
        where: { doctorId: req.params.id },
        orderBy: [{ dayOfWeek: "asc" }, { startTime: "asc" }],
      });

      const DAY_NAMES = [
        "SUNDAY",
        "MONDAY",
        "TUESDAY",
        "WEDNESDAY",
        "THURSDAY",
        "FRIDAY",
        "SATURDAY",
      ];

      const data = rows.map((r) => ({
        id: r.id,
        doctorId: r.doctorId,
        dayOfWeek: DAY_NAMES[r.dayOfWeek] ?? String(r.dayOfWeek),
        dayOfWeekIndex: r.dayOfWeek,
        startTime: r.startTime,
        endTime: r.endTime,
        slotDuration: r.slotDurationMinutes,
        slotDurationMinutes: r.slotDurationMinutes,
        bufferMinutes: r.bufferMinutes,
      }));

      res.json({ success: true, data, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/doctors/:id/overrides — list schedule overrides
// #511 audit: VERIFIED-SAFE — authorize() excludes PATIENT.
router.get(
  "/:id/overrides",
  authorize(Role.ADMIN, Role.DOCTOR, Role.RECEPTION, Role.NURSE),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const rows = await prisma.scheduleOverride.findMany({
        where: { doctorId: req.params.id },
        orderBy: { date: "desc" },
      });
      res.json({ success: true, data: rows, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/doctors/:id/slots?date=YYYY-MM-DD — get available slots
// #511 audit: VERIFIED-SAFE — intentional PATIENT-reachable booking
// surface. Returns only schedule + booked-slot mask per requested date;
// no patient-identifying data leaks (booked slots are returned as a
// boolean `isAvailable`, never as appointment details or patient names).
router.get(
  "/:id/slots",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { date } = req.query;
      if (!date) {
        res.status(400).json({ success: false, data: null, error: "date query param required" });
        return;
      }

      const dateObj = new Date(date as string);
      const dayOfWeek = dateObj.getDay();

      // Check for override
      const override = await prisma.scheduleOverride.findUnique({
        where: {
          doctorId_date: {
            doctorId: req.params.id,
            date: dateObj,
          },
        },
      });

      if (override?.isBlocked) {
        res.json({
          success: true,
          data: { date, slots: [], blocked: true, reason: override.reason },
          error: null,
        });
        return;
      }

      // Get schedule for day of week
      const schedules = await prisma.doctorSchedule.findMany({
        where: { doctorId: req.params.id, dayOfWeek },
      });

      if (schedules.length === 0) {
        res.json({
          success: true,
          data: { date, slots: [], blocked: false, reason: "No schedule for this day" },
          error: null,
        });
        return;
      }

      // Get existing appointments for this date
      const existingAppointments = await prisma.appointment.findMany({
        where: {
          doctorId: req.params.id,
          date: dateObj,
          status: { notIn: ["CANCELLED", "NO_SHOW"] },
        },
        select: { slotStart: true },
      });
      const bookedSlots = new Set(existingAppointments.map((a) => a.slotStart));

      // Generate slots
      const slots: Array<{
        startTime: string;
        endTime: string;
        isAvailable: boolean;
      }> = [];

      // Issue #491 (2026-05-03): if the requested date is a *past* calendar
      // day, no slot is bookable; return an empty grid (the previous code
      // happily rendered "09:00–20:00" for 01-01-2020). For today, drop slots
      // whose start time has already elapsed so the patient never sees a row
      // they can't actually book. We string-compare YYYY-MM-DD against the
      // server's local today; the route never received timezone info from
      // the caller, so this stays consistent with the new Zod refine.
      const now = new Date();
      const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
      const reqDateStr = String(date);
      if (reqDateStr < todayStr) {
        res.json({
          success: true,
          data: { date, slots: [], blocked: false, reason: "Date is in the past" },
          error: null,
        });
        return;
      }
      const isToday = reqDateStr === todayStr;
      const nowMin = now.getHours() * 60 + now.getMinutes();

      for (const schedule of schedules) {
        const startTime = override?.startTime || schedule.startTime;
        const endTime = override?.endTime || schedule.endTime;
        const duration = schedule.slotDurationMinutes || DEFAULT_SLOT_DURATION_MINUTES;
        const buffer = schedule.bufferMinutes || 0;
        const step = duration + buffer;

        const [startH, startM] = startTime.split(":").map(Number);
        const [endH, endM] = endTime.split(":").map(Number);
        const startMinutes = startH * 60 + startM;
        const endMinutes = endH * 60 + endM;

        for (let m = startMinutes; m + duration <= endMinutes; m += step) {
          if (isToday && m < nowMin) continue;
          const slotStart = `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
          const slotEndMin = m + duration;
          const slotEnd = `${String(Math.floor(slotEndMin / 60)).padStart(2, "0")}:${String(slotEndMin % 60).padStart(2, "0")}`;

          slots.push({
            startTime: slotStart,
            endTime: slotEnd,
            isAvailable: !bookedSlots.has(slotStart),
          });
        }
      }

      res.json({
        success: true,
        data: { date, slots, blocked: false },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/v1/doctors/:id/schedule — set schedule
// #511 audit: VERIFIED-SAFE — authorize() excludes PATIENT.
router.post(
  "/:id/schedule",
  authorize(Role.ADMIN, Role.DOCTOR),
  validate(doctorScheduleSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const schedule = await prisma.doctorSchedule.upsert({
        where: {
          doctorId_dayOfWeek_startTime: {
            doctorId: req.params.id,
            dayOfWeek: req.body.dayOfWeek,
            startTime: req.body.startTime,
          },
        },
        update: {
          endTime: req.body.endTime,
          slotDurationMinutes: req.body.slotDurationMinutes,
          bufferMinutes: req.body.bufferMinutes ?? 0,
        },
        create: {
          doctorId: req.params.id,
          dayOfWeek: req.body.dayOfWeek,
          startTime: req.body.startTime,
          endTime: req.body.endTime,
          slotDurationMinutes: req.body.slotDurationMinutes,
          bufferMinutes: req.body.bufferMinutes ?? 0,
        },
      });

      res.json({ success: true, data: schedule, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/v1/doctors/:id/override — block date or modify hours
// #511 audit: VERIFIED-SAFE — authorize() excludes PATIENT.
router.post(
  "/:id/override",
  authorize(Role.ADMIN, Role.DOCTOR, Role.RECEPTION),
  validate(scheduleOverrideSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const override = await prisma.scheduleOverride.upsert({
        where: {
          doctorId_date: {
            doctorId: req.params.id,
            date: new Date(req.body.date),
          },
        },
        update: {
          isBlocked: req.body.isBlocked,
          startTime: req.body.startTime,
          endTime: req.body.endTime,
          reason: req.body.reason,
        },
        create: {
          doctorId: req.params.id,
          date: new Date(req.body.date),
          isBlocked: req.body.isBlocked,
          startTime: req.body.startTime,
          endTime: req.body.endTime,
          reason: req.body.reason,
        },
      });

      res.json({ success: true, data: override, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// PATCH /api/v1/doctors/:id/appointment-mode
//
// Pearl ERP Stage 1 §2.1.2 + §3.2 — set per-doctor appointment mode
// (CALLING / TOKEN / SLOT) and the booking-knobs that come with it
// (tokenPrefix, tokenStartNumber, dailyAppointmentLimit,
// nearTurnAlertThreshold, lastHourPolicy).
//
// Patch semantics: every field is optional. `undefined` leaves the
// column untouched; `null` explicitly clears a knob. Role-gated to
// ADMIN (DOCTOR can edit their OWN row — looked up via doctor.userId).
router.patch(
  "/:id/appointment-mode",
  authorize(Role.ADMIN, Role.DOCTOR),
  validate(doctorAppointmentModeSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // DOCTOR role may only edit their own appointment mode. ADMIN can edit any.
      if (req.user?.role === Role.DOCTOR) {
        const target = await prisma.doctor.findUnique({
          where: { id: req.params.id },
          select: { userId: true },
        });
        if (!target || target.userId !== req.user.userId) {
          res.status(403).json({
            success: false,
            data: null,
            error: "Doctors may only update their own appointment mode",
          });
          return;
        }
      }

      // Build the update payload explicitly so undefined fields don't
      // accidentally clobber existing values (PATCH semantics).
      const data: Record<string, unknown> = {};
      if (req.body.appointmentMode !== undefined) data.appointmentMode = req.body.appointmentMode;
      if (req.body.tokenPrefix !== undefined) data.tokenPrefix = req.body.tokenPrefix;
      if (req.body.tokenStartNumber !== undefined) data.tokenStartNumber = req.body.tokenStartNumber;
      if (req.body.dailyAppointmentLimit !== undefined) data.dailyAppointmentLimit = req.body.dailyAppointmentLimit;
      if (req.body.nearTurnAlertThreshold !== undefined) data.nearTurnAlertThreshold = req.body.nearTurnAlertThreshold;
      if (req.body.lastHourPolicy !== undefined) data.lastHourPolicy = req.body.lastHourPolicy;
      if (req.body.nmcRegNumber !== undefined) data.nmcRegNumber = req.body.nmcRegNumber;
      // Pearl §4.1 (gap row 101) — default commission % for invoices
      // this doctor referred. PATCH semantics: undefined leaves unchanged,
      // null explicitly clears (no commission rows auto-created).
      if (req.body.commissionPercent !== undefined) data.commissionPercent = req.body.commissionPercent;

      const updated = await prisma.doctor.update({
        where: { id: req.params.id },
        data,
        select: {
          id: true,
          appointmentMode: true,
          tokenPrefix: true,
          tokenStartNumber: true,
          dailyAppointmentLimit: true,
          nearTurnAlertThreshold: true,
          lastHourPolicy: true,
          nmcRegNumber: true,
          commissionPercent: true,
        },
      });

      auditLog(req, "DOCTOR_APPOINTMENT_MODE_UPDATE", "doctor", req.params.id, {
        changes: data,
      }).catch(console.error);

      res.json({ success: true, data: updated, error: null });
    } catch (err) {
      next(err);
    }
  }
);

export { router as doctorRouter };
