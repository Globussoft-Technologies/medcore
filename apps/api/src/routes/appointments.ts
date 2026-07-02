import { Router, Request, Response, NextFunction } from "express";
// Multi-tenant + multi-branch wiring (Pearl §7.2). `branchScopedPrisma`
// is a Prisma `$extends` wrapper layered on top of `tenantScopedPrisma`,
// so every call site below gets BOTH:
//   - tenantId auto-injected on create / auto-filtered on read (for all
//     tenant-scoped models — see packages/db/src/tenant-prisma.ts), AND
//   - branchId auto-injected / auto-filtered when an `X-Branch-Id` header
//     opened a branch context on this request (Appointment only in piece
//     2a, 2026-05-21 — see packages/db/src/branch-prisma.ts).
// We alias it to `prisma` so every existing call site keeps working.
import { branchScopedPrisma as prisma } from "@medcore/db";
import {
  Role,
  bookAppointmentSchema,
  walkInSchema,
  updateAppointmentStatusSchema,
  rescheduleAppointmentSchema,
  recurringAppointmentSchema,
  transferAppointmentSchema,
  markLwbsSchema,
  createAppointmentRemarkSchema,
  updateAppointmentRemarkSchema,
  pinAppointmentRemarkSchema,
  appointmentRemarkVisibilityValues,
  DEFAULT_SLOT_DURATION_MINUTES,
} from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { assertPatientOwnsResource } from "../middleware/patient-self-only";
import { istMidnightUtc, istTodayDateStr, istNowMinutes } from "../utils/ist-time";
import { isDoctorOnConfirmedLeave } from "../utils/doctor-leave";
import { resolveFirstPhotoUrl } from "../lib/patient-photo";
// Meta Cloud WhatsApp sender (same module prescriptions + public booking
// use) so reschedule confirmations actually go out with the configured
// WHATSAPP_ACCESS_TOKEN / WHATSAPP_PHONE_NUMBER_ID env.
import { sendWhatsApp } from "../services/messaging/whatsapp";
import { patientPortalLink } from "../lib/site-link";
import { recordCampaignConversion } from "../services/campaign-conversion";
import {
  onAppointmentBooked,
  onAppointmentCancelled,
  onTokenCalled,
  notifyQueuePosition,
  onPatientCheckedIn,
  onBillGenerated,
} from "../services/notification-triggers";
import { auditLog } from "../middleware/audit";
import { notifyNextInWaitlist } from "../services/waitlist";
import { createConsultationInvoiceForAppointment } from "../services/consultation-invoice";
import { formatDoctorName } from "../lib/format-doctor-name";

const router = Router();
router.use(authenticate);

// Helper: get next token number for a doctor on a date.
//
// `Appointment.date` is `@db.Date` (postgres DATE — no time). Filtering
// by `date: { gte: midnight, lt: nextMidnight }` rather than equality
// avoids two failure modes that were producing P2002 unique-violation
// 500s on demo:
//
//   1. The caller's `today` was constructed with setHours(0,0,0,0) in
//      LOCAL time (e.g. 2026-05-06T00:00 IST = 2026-05-05T18:30Z). The
//      seed/existing rows were inserted with a different local
//      timezone alignment, so an exact-equality match returned null
//      and tokenNumber reset to 1 — colliding with the existing
//      (doctorId, date, 1) row on the @@unique index.
//   2. Even when timezones match, postgres' DATE → ISO round-trip can
//      land at 23:00 of the prior day if the connection's timezone is
//      shifted, again missing equality.
//
// A range filter on the *day boundary* normalizes both: any row whose
// stored date falls inside that 24h window is captured regardless of
// how the timestamp was originally injected.
async function getNextToken(
  doctorId: string,
  date: Date,
  startNumber?: number | null,
): Promise<number> {
// Use UTC boundaries so setHours(0,0,0,0) in local time doesn't shift the
// window and miss same-day rows stored at a different UTC offset.
  const dayStart = new Date(date);
  dayStart.setUTCHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart);
  dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);
  const result = await prisma.appointment.aggregate({
    where: { doctorId, date: { gte: dayStart, lt: dayEnd } },
    _max: { tokenNumber: true },
  });
  // Pearl §3.2 — honour the doctor's configured starting token number: the
  // FIRST booking of the day starts at `tokenStartNumber` (default 1), and
  // every subsequent booking increments the running max. Math.max guards
  // against legacy rows below the configured start.
  const start = startNumber ?? 1;
  const existingMax = result._max.tokenNumber;
  return Math.max((existingMax ?? start - 1) + 1, start);
}

// Is a given token number already claimed by a live (non-cancelled,
// non-no-show) appointment for this doctor on this date? Used by the TOKEN
// reschedule path, which preserves the patient's ORIGINAL token number to
// keep their relative order on the destination day — but must detect a clash
// with a token already sitting on that date and fall back to the queue tail.
async function isTokenTakenOnDate(
  doctorId: string,
  date: Date,
  tokenNumber: number,
  excludeAppointmentId: string,
): Promise<boolean> {
  const dayStart = new Date(date);
  dayStart.setUTCHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart);
  dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);
  const hit = await prisma.appointment.findFirst({
    where: {
      doctorId,
      date: { gte: dayStart, lt: dayEnd },
      tokenNumber,
      status: { notIn: ["CANCELLED", "NO_SHOW"] },
      id: { not: excludeAppointmentId },
    },
    select: { id: true },
  });
  return hit !== null;
}

// Pearl ERP Stage 1 §2.1.2 — CALLING-mode arrival counter, scoped per
// (doctorId, date). Mirrors getNextToken but reads arrivalSeq.
async function getNextArrivalSeq(doctorId: string, date: Date): Promise<number> {
  const dayStart = new Date(date);
  dayStart.setUTCHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart);
  dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);
  const result = await prisma.appointment.aggregate({
    where: { doctorId, date: { gte: dayStart, lt: dayEnd } },
    _max: { arrivalSeq: true },
  });
  return (result._max.arrivalSeq ?? 0) + 1;
}

// Helper: read integer SystemConfig with fallback
async function getConfigInt(key: string, fallback: number): Promise<number> {
  const row = await prisma.systemConfig.findUnique({ where: { key } });
  if (!row) return fallback;
  const n = parseInt(row.value, 10);
  return isNaN(n) ? fallback : n;
}

// POST /api/v1/appointments/book — book scheduled appointment
router.post(
  "/book",
  validate(bookAppointmentSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { patientId, doctorId, date, slotId, notes } = req.body;
      const overrideNoShow: boolean = Boolean(req.body.overrideNoShow);
      const dateObj = new Date(date);

      // Issue #491 (2026-05-03): Zod refuses past calendar dates, but a
      // today-dated booking with a slot start that's already elapsed
      // (e.g. it's 14:30 and the caller asks for 09:00) was still
      // accepted. Reject same-day past-time slots before we touch the
      // DB. `slotId` from the booking form is HH:MM (the route comment
      // notes this); only block when it parses as a real time so any
      // legacy callers passing a true UUID slotId are unaffected.
      // IST-anchored: slotId is a clinic-local IST HH:MM, so both the
      // "today" comparison and the elapsed-time cutoff must be IST. A
      // server-local cutoff on a UTC host accepts already-past slots.
      const todayStr = istTodayDateStr();
      if (date === todayStr && /^\d{2}:\d{2}$/.test(slotId)) {
        const [sh, sm] = slotId.split(":").map(Number);
        const slotMin = sh * 60 + sm;
        const nowMin = istNowMinutes();
        if (slotMin < nowMin) {
          res.status(400).json({
            success: false,
            data: null,
            error: "Cannot book a slot in the past",
          });
          return;
        }
      }

      // Confirmed (APPROVED) doctor leave blocks booking on that date —
      // mirrors the slot grid, which hides all slots for a leave day.
      if (await isDoctorOnConfirmedLeave(doctorId, dateObj)) {
        res.status(409).json({
          success: false,
          data: null,
          error: "Doctor is on leave on the selected date",
        });
        return;
      }

      // ── No-show policy enforcement ──
      const patient = await prisma.patient.findUnique({
        where: { id: patientId },
        select: { noShowCount: true, tenantId: true },
      });
      const threshold = await getConfigInt("no_show_threshold", 3);
      if (
        patient &&
        patient.noShowCount >= threshold &&
        !overrideNoShow
      ) {
        // Reception/Admin can override via flag; patients cannot.
        if (req.user!.role === Role.PATIENT) {
          res.status(400).json({
            success: false,
            data: null,
            error:
              "Patient has exceeded no-show threshold. Please contact reception.",
          });
          return;
        }
        if (
          req.user!.role !== Role.ADMIN &&
          req.user!.role !== Role.SUPER_ADMIN &&
          req.user!.role !== Role.RECEPTION
        ) {
          res.status(400).json({
            success: false,
            data: null,
            error:
              "Patient has exceeded no-show threshold. Please contact reception.",
          });
          return;
        }
        // admin/reception without overrideNoShow flag also blocked — they must
        // explicitly override.
        res.status(400).json({
          success: false,
          data: null,
          error:
            "Patient has exceeded no-show threshold. Please contact reception.",
        });
        return;
      }

      // Pearl ERP Stage 1 §2.1.2 — branch by the doctor's appointmentMode.
      // TOKEN = legacy MedCore behaviour (sequential tokenNumber, slot
      //   optional). SLOT = HH:MM slotId is required, no token, double-
      //   booking blocked by @@unique (doctorId, date, slotStart).
      //   CALLING = arrival-order queue, no token, no slot — arrivalSeq
      //   minted as a per-(doctor, date) counter.
      // Also pull the Pearl §3.2 booking-policy knobs (tokenPrefix,
      // dailyAppointmentLimit, lastHourPolicy) so the per-doctor caps
      // can be enforced before we commit a row.
      const doctor = await prisma.doctor.findUnique({
        where: { id: doctorId },
        select: {
          appointmentMode: true,
          tokenPrefix: true,
          tokenStartNumber: true,
          dailyAppointmentLimit: true,
          lastHourPolicy: true,
          tenantId: true,
        },
      });
      if (!doctor) {
        res.status(404).json({ success: false, data: null, error: "Doctor not found" });
        return;
      }

      // Multi-tenant integrity: an appointment's tenant is authoritative from
      // the DOCTOR (a doctor belongs to exactly one tenant). Block a GENUINE
      // cross-tenant pairing — both sides assigned to DIFFERENT real tenants —
      // rather than silently misfiling. We deliberately tolerate a null on
      // either side (un-migrated / default-tenant rows) so this guard doesn't
      // break transitional data; the explicit tenant pin below still files the
      // row under the doctor's tenant in that case.
      if (
        patient &&
        patient.tenantId != null &&
        doctor.tenantId != null &&
        patient.tenantId !== doctor.tenantId
      ) {
        res.status(400).json({
          success: false,
          data: null,
          error: "Patient and doctor belong to different tenants",
        });
        return;
      }
      // The tenant this row must be tagged with. We set it EXPLICITLY on the
      // create below (rather than relying on branch/tenantScopedPrisma's
      // auto-injection) because a platform/super-admin caller has no tenant
      // context — the scoping extension is a pass-through in that case, so
      // without this the appointment would save with tenantId=null (the
      // default tenant) and never surface for the doctor's real tenant.
      const appointmentTenantId = doctor.tenantId ?? null;
      const mode = doctor.appointmentMode;

      if (mode === "SLOT" && !slotId) {
        res.status(400).json({
          success: false,
          data: null,
          error: "SLOT-mode bookings require a slotId (HH:MM)",
        });
        return;
      }

      // Pearl ERP Stage 1 §3.2 — per-doctor daily appointment cap. Null =
      // unlimited; otherwise count same-day, non-cancelled appointments and
      // reject the (N+1)th booking with 409. Cancelled / no-show rows do
      // NOT consume the cap so a no-show patient's slot frees up.
      if (
        doctor.dailyAppointmentLimit !== null &&
        doctor.dailyAppointmentLimit !== undefined
      ) {
        const dayStart = new Date(dateObj);
        dayStart.setUTCHours(0, 0, 0, 0);
        const dayEnd = new Date(dayStart);
        dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);
        const sameDayCount = await prisma.appointment.count({
          where: {
            doctorId,
            date: { gte: dayStart, lt: dayEnd },
            status: { notIn: ["CANCELLED", "NO_SHOW"] },
          },
        });
        if (sameDayCount >= doctor.dailyAppointmentLimit) {
          res.status(409).json({
            success: false,
            data: null,
            error: `Doctor daily appointment limit (${doctor.dailyAppointmentLimit}) reached for ${date}`,
          });
          return;
        }
      }

      // Pearl ERP Stage 1 §3.2 — last-hour booking policy. BLOCK_NEW =
      // reject any booking whose slotId falls within the last 60 min of
      // the doctor's working day for that weekday (read from
      // DoctorSchedule.endTime; the latest endTime across overlapping
      // shifts wins). ACCEPT_ALL / WALK_IN_ONLY / null = handler does
      // not gate here (WALK_IN_ONLY restricts to the walk-in route, which
      // is a separate concern). CALLING-mode has no slotId so the policy
      // can't apply.
      if (
        doctor.lastHourPolicy === "BLOCK_NEW" &&
        slotId &&
        /^\d{2}:\d{2}$/.test(slotId)
      ) {
        const dayOfWeek = dateObj.getUTCDay(); // 0=Sun..6=Sat — matches DoctorSchedule
        const schedules = await prisma.doctorSchedule.findMany({
          where: { doctorId, dayOfWeek },
          select: { endTime: true },
        });
        if (schedules.length > 0) {
          const [sh, sm] = slotId.split(":").map(Number);
          const slotMin = sh * 60 + sm;
          // Find the latest endTime to define the last-hour window. A
          // doctor with two shifts (morning + evening) gets one last-hour
          // gate per shift; reject if the slot falls within the last-hour
          // window of ANY shift it lands inside.
          for (const sched of schedules) {
            const m = /^(\d{2}):(\d{2})$/.exec(sched.endTime);
            if (!m) continue;
            const endMin = Number(m[1]) * 60 + Number(m[2]);
            if (slotMin >= endMin - 60 && slotMin < endMin) {
              res.status(409).json({
                success: false,
                data: null,
                error: "Last-hour bookings are blocked for this doctor",
              });
              return;
            }
          }
        }
      }

      // Slot-collision pre-check applies to TOKEN (if a slot is provided)
      // and SLOT modes. CALLING ignores slot.
      if (slotId && mode !== "CALLING") {
        const existing = await prisma.appointment.findFirst({
          where: {
            doctorId,
            date: dateObj,
            slotStart: slotId,
            status: { notIn: ["CANCELLED", "NO_SHOW"] },
          },
        });
        if (existing) {
          res.status(409).json({
            success: false,
            data: null,
            error: "This slot is already booked",
          });
          return;
        }
      }

      // Mode-specific token / arrival / slot assignment.
      let tokenNumber: number | null = null;
      let arrivalSeq: number | null = null;
      let slotStartToUse: string | null = null;
      if (mode === "TOKEN") {
        tokenNumber = await getNextToken(
          doctorId,
          dateObj,
          doctor.tokenStartNumber,
        );
        slotStartToUse = slotId ?? null;
      } else if (mode === "SLOT") {
        slotStartToUse = slotId!; // required-for-SLOT, validated above
      } else {
        // CALLING — no token, no slot, just an arrival counter.
        arrivalSeq = await getNextArrivalSeq(doctorId, dateObj);
      }

      let appointment: any;
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          appointment = await prisma.appointment.create({
            data: {
              patientId,
              doctorId,
              date: dateObj,
              slotStart: slotStartToUse,
              tokenNumber,
              arrivalSeq,
              type: "SCHEDULED",
              status: "BOOKED",
              notes,
              tenantId: appointmentTenantId,
            },
            include: {
              patient: {
                include: { user: { select: { name: true, phone: true } } },
              },
              doctor: {
                include: { user: { select: { name: true } } },
              },
            },
          });
          break;
        } catch (err: any) {
          if (err?.code === "P2002" && attempt < 4) {
            // P2002 retry: bump the appropriate counter for TOKEN /
            // CALLING. For SLOT mode the conflict means the slot is
            // genuinely double-booked (the @@unique on slotStart fired)
            // and there is nothing to bump — return 409 cleanly.
            if (mode === "TOKEN" && tokenNumber !== null) { tokenNumber++; continue; }
            if (mode === "CALLING" && arrivalSeq !== null) { arrivalSeq++; continue; }
            // SLOT mode P2002
            res.status(409).json({
              success: false,
              data: null,
              error: "This slot is already booked",
            });
            return;
          }
          throw err;
        }
      }

      // Emit socket event for queue update
      const io = req.app.get("io");
      if (io) {
        io.to(`queue:${doctorId}`).emit("queue-updated", {
          doctorId,
          date,
        });
      }

      // Fire-and-forget notification
      onAppointmentBooked(appointment as any, patientPortalLink(req)).catch(console.error);
      auditLog(req, "APPOINTMENT_CREATE", "appointment", appointment.id, { patientId, doctorId, date }).catch(console.error);

      // Pearl §5.1 piece 3c — campaign conversion attribution.
      // If this patient recently clicked a campaign link (default
      // 7-day window), credit the most-recent click. Fire-and-forget;
      // never blocks the booking response.
      recordCampaignConversion(prisma as any, {
        patientId,
        type: "APPOINTMENT",
        refId: appointment.id,
      }).catch((err) => console.error("[campaign attribution] ", err));

      // Pearl ERP Stage 1 §3.2 — user-facing token. Doctors with a
      // tokenPrefix get "<prefix><n>" (e.g. "A12") in the response;
      // the raw integer column is unchanged. displayToken is null for
      // CALLING / SLOT (no token at all).
      const displayToken =
        appointment.tokenNumber !== null && appointment.tokenNumber !== undefined
          ? `${doctor.tokenPrefix ?? ""}${appointment.tokenNumber}`
          : null;
      res.status(201).json({
        success: true,
        data: { ...appointment, displayToken },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/v1/appointments/walk-in — register walk-in
// Allowed roles: RECEPTION + ADMIN (front-desk) + DOCTOR (solo clinics
// where the doctor IS the front desk, and the per-doctor booking-channel
// UI in apps/web exposes the Walk-in option on the doctor's own panel).
// The standard /book route below is open to any authed role; gating
// /walk-in to just front-desk roles was inconsistent and silently 403'd
// the Walk-in button when a doctor clicked it (2026-05-25).
router.post(
  "/walk-in",
  authorize(Role.RECEPTION, Role.ADMIN, Role.DOCTOR),
  validate(walkInSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { patientId, doctorId, priority, notes } = req.body;
      // A11 partial-revert (2026-05-17): istMidnightUtc(0) returns
      // the UTC instant of IST midnight (e.g. yesterday-UTC at 18:30
      // when called from a UTC server in the IST evening). Postgres
      // @db.Date extracts the UTC date PORTION of that instant — so
      // the stored row lands on YESTERDAY-UTC, not today-IST. The
      // original `setHours(0,0,0,0)` gives the server's local-day
      // midnight which matches what existing tests assert and what
      // getNextToken's UTC-bounded query (line ~56) compares against.
      // True IST-day storage would require either DATE-as-text in IST
      // or a daystart-of-IST-as-UTC-midnight helper (different shape
      // than istMidnightUtc); both are out of scope. Reverting to
      // pre-A11 behavior here keeps tests green; the cross-tz drift
      // class is documented for follow-up.
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      // Pearl §3.1 (gap closed 2026-05-29) — mode-aware walk-in. The SOW
      // §2.1.2 says CALLING-mode doctors don't issue tokens: they use an
      // arrival counter. Until now /walk-in always stamped a tokenNumber
      // regardless of mode, which polluted CALLING-mode displays and
      // made the §2.1.5 token board show fake tokens for arrival-order
      // doctors. Branch on the doctor's `appointmentMode`:
      //   - CALLING  → arrivalSeq, tokenNumber = null
      //   - TOKEN    → tokenNumber, arrivalSeq = null  (legacy default)
      //   - SLOT     → tokenNumber for now (SLOT-mode walk-ins are rare;
      //                a future cleanup may reject them outright)
      const doctorRow = await prisma.doctor.findUnique({
        where: { id: doctorId },
        select: { appointmentMode: true, tokenStartNumber: true, tenantId: true },
      });
      const mode = doctorRow?.appointmentMode ?? "TOKEN";
      // Pin the doctor's tenant explicitly — see the SCHEDULED-booking route
      // above for why (platform/super-admin callers have no req.tenantId, so
      // the scoping extension can't auto-inject it).
      const walkInTenantId = doctorRow?.tenantId ?? null;

      let tokenNumber: number | null = null;
      let arrivalSeq: number | null = null;
      if (mode === "CALLING") {
        arrivalSeq = await getNextArrivalSeq(doctorId, today);
      } else {
        tokenNumber = await getNextToken(
          doctorId,
          today,
          doctorRow?.tokenStartNumber,
        );
      }

      let appointment: any;
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          appointment = await prisma.appointment.create({
            data: {
              patientId,
              doctorId,
              date: today,
              tokenNumber,
              arrivalSeq,
              type: "WALK_IN",
              status: "BOOKED",
              priority: priority || "NORMAL",
              notes,
              tenantId: walkInTenantId,
            },
            include: {
              patient: {
                include: { user: { select: { name: true, phone: true } } },
              },
              doctor: {
                include: { user: { select: { name: true } } },
              },
            },
          });
          break;
        } catch (err: any) {
          if (err?.code === "P2002" && attempt < 4) {
            // Bump whichever counter we're using; the other stays null.
            if (mode === "CALLING") {
              arrivalSeq = (arrivalSeq ?? 0) + 1;
            } else {
              tokenNumber = (tokenNumber ?? 0) + 1;
            }
            continue;
          }
          throw err;
        }
      }

      const io = req.app.get("io");
      if (io) {
        io.to(`queue:${doctorId}`).emit("queue-updated", {
          doctorId,
          date: today.toISOString().split("T")[0],
        });
        io.to("token-display").emit("token-updated", {
          doctorId,
          // Send whichever counter actually moved so the token-board
          // can keep its mode-specific renderer in sync. Either field
          // may be null on the payload.
          tokenNumber,
          arrivalSeq,
        });
      }

      // Fire-and-forget notification
      onAppointmentBooked(appointment as any, patientPortalLink(req)).catch(console.error);
      auditLog(req, "WALK_IN_REGISTER", "appointment", appointment.id, { patientId, doctorId }).catch(console.error);

      res.status(201).json({ success: true, data: appointment, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/appointments — list appointments
router.get("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { doctorId, patientId, date, status, page = "1", limit = "20" } = req.query;
    const skip = (parseInt(page as string) - 1) * parseInt(limit as string);
    const take = Math.min(parseInt(limit as string), 100);

    // Super-admin tenant filter: a cross-tenant (req.tenantId unset) caller
    // may narrow the list to one tenant via `?tenantId=`. Tenant-bound
    // callers are already scoped by tenantScopedPrisma, so the param is
    // ignored for them.
    const tenantIdParam = req.query.tenantId;
    const where: Record<string, unknown> = {
      ...(!req.tenantId && typeof tenantIdParam === "string" && tenantIdParam.trim().length > 0
        ? { tenantId: tenantIdParam.trim() }
        : {}),
    };
    // Doctors may only see their own appointments — ignore any doctorId
    // query param and auto-scope to the authenticated doctor's record.
    if (req.user?.role === Role.DOCTOR) {
      const doctorRecord = await prisma.doctor.findFirst({ where: { userId: req.user.userId }, select: { id: true } });
      if (!doctorRecord) {
        res.status(403).json({ success: false, data: null, error: "Doctor profile not found" });
        return;
      }
      where.doctorId = doctorRecord.id;
    } else if (doctorId) {
      where.doctorId = doctorId;
    }

    if (patientId) where.patientId = patientId;
    if (date) {
      // Issue #156: Today's-Patients in the AI Scribe page sends an ISO
      // date (e.g. "2026-04-26"). `new Date("2026-04-26")` parses to
      // 00:00 UTC, but appointment rows store local-day timestamps that
      // can land just before midnight UTC the previous day. Match the
      // whole calendar day rather than an exact equality so the picker
      // doesn't return an empty list (or 500 on a bad ISO string).
      try {
        // Caller passed `?date=YYYY-MM-DD`. Match getNextToken's UTC
        // convention so the filter window aligns with stored DATE
        // values regardless of host timezone (per A11). Prior:
        // `setHours(0,0,0,0)` / `setHours(23,59,...)` on local time
        // shifted the window by the host offset, dropping rows on
        // UTC hosts.
        const day = new Date(date as string);
        if (Number.isNaN(day.getTime())) {
          res.status(400).json({
            success: false,
            data: null,
            error: "Invalid date",
          });
          return;
        }
        const start = new Date(day);
        start.setUTCHours(0, 0, 0, 0);
        const end = new Date(start);
        end.setUTCDate(end.getUTCDate() + 1);
        where.date = { gte: start, lt: end };
      } catch {
        res.status(400).json({
          success: false,
          data: null,
          error: "Invalid date",
        });
        return;
      }
    }
    if (status) {
      // Issue #156: scribe Today's-Patients sends a comma-separated
      // status filter (e.g. `status=CHECKED_IN,BOOKED`). Prisma rejected
      // the literal "CHECKED_IN,BOOKED" string against the
      // AppointmentStatus enum and threw a 500. Normalise to `{ in: […] }`
      // when a comma is present, otherwise fall through to a single
      // equality match.
      //
      // Validate against the canonical AppointmentStatus enum so a typo
      // in the caller (e.g. `IN_PROGRESS` instead of `IN_CONSULTATION` —
      // a real bug surfaced from the prescriptions appointment picker)
      // produces a 400 with a clear list of allowed values, NOT a 500
      // from Prisma's enum-validation layer.
      const ALLOWED_APPT_STATUSES = new Set([
        "BOOKED",
        "CHECKED_IN",
        "IN_CONSULTATION",
        "COMPLETED",
        "CANCELLED",
        "NO_SHOW",
      ]);
      const raw = String(status);
      const requested = raw.includes(",")
        ? raw.split(",").map((s) => s.trim()).filter(Boolean)
        : [raw.trim()];
      const invalid = requested.filter((s) => !ALLOWED_APPT_STATUSES.has(s));
      if (invalid.length > 0) {
        res.status(400).json({
          success: false,
          data: null,
          error: `Invalid status value(s): ${invalid.join(", ")}. ` +
            `Allowed: ${[...ALLOWED_APPT_STATUSES].join(", ")}`,
        });
        return;
      }
      where.status = requested.length > 1 ? { in: requested } : requested[0];
    }

    // If patient role, only show own appointments
    if (req.user!.role === "PATIENT") {
      const patient = await prisma.patient.findUnique({
        where: { userId: req.user!.userId },
      });
      if (patient) where.patientId = patient.id;
    }

    // Issue #194: free-text `?search=` filter so the prescription page's
    // EntityPicker can narrow same-day appointments by token number, slot
    // time prefix, or doctor name. The list endpoint quietly accepted (and
    // ignored) `search=` previously, which is why typing in the picker
    // produced "No matches" while the unfiltered list contained the row.
    const searchRaw = req.query.search;
    if (typeof searchRaw === "string" && searchRaw.trim().length > 0) {
      const q = searchRaw.trim();
      const tokenN = Number.parseInt(q, 10);
      const orClauses: Record<string, unknown>[] = [
        { slotStart: { contains: q } },
        {
          doctor: {
            user: { name: { contains: q, mode: "insensitive" } },
          },
        },
      ];
      if (Number.isFinite(tokenN)) orClauses.push({ tokenNumber: tokenN });
      where.OR = orClauses;
    }

    const [appointments, total] = await Promise.all([
      prisma.appointment.findMany({
        where,
        include: {
          patient: {
            include: { user: { select: { name: true, phone: true } } },
          },
          doctor: {
            include: { user: { select: { name: true } } },
          },
          vitals: true,
          // Pearl §2.1.3 — include the consultation status so the
          // appointments table can hide the Re-consult / Complete
          // buttons once the doctor has SIGNED the encounter. The
          // sign endpoint now atomically completes the appointment
          // too, but this projection is a defensive fallback for any
          // rows where appointment.status drifted from the
          // consultation lifecycle (e.g. pre-§2.1.3 data, partial
          // tenant-scope failure).
          consultation: {
            select: { id: true, status: true, signedAt: true },
          },
          // Pearl §2.1.7 — surface a remark count so the list can badge the
          // Remarks button. Counts all threaded remarks on the row (the
          // badge reveals only "how many", never content; the modal still
          // applies per-viewer visibility scoping when opened).
          _count: { select: { remarks: true } },
        },
        skip,
        take,
        orderBy: [{ date: "desc" }, { tokenNumber: "asc" }],
      }),
      prisma.appointment.count({ where }),
    ]);

    res.json({
      success: true,
      data: appointments,
      error: null,
      meta: { page: parseInt(page as string), limit: take, total },
    });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/v1/appointments/:id/status — update status
//
// PATIENT is allowed here to:
//   (a) self-cancel their own appointment from the "My Appointments" UI, or
//   (b) self-check-in ("I've arrived" button on the patient PWA) for TODAY's
//       own BOOKED appointment only — Pearl PRD §6.3 row 340.
//
// Any other status transition (IN_CONSULTATION, COMPLETED, NO_SHOW, BOOKED)
// stays staff-only. The CHECKED_IN branch is constrained by:
//   - per-row ownership (`assertPatientOwnsResource`),
//   - appointment.date must match TODAY in IST (no pre-arriving for tomorrow,
//     no back-arriving for yesterday — uses `istMidnightUtc(0|1)` window so the
//     check is stable across UTC vs IST hosts),
//   - current status MUST be BOOKED (no idempotent re-check-in, no resurrecting
//     CANCELLED / COMPLETED).
// On success the existing CHECKED_IN side-effects (checkInAt stamp at L687,
// queue-updated emit + notifyQueuePosition + onPatientCheckedIn) fire as
// they would for staff-initiated check-in. We additionally emit a
// `PATIENT_SELF_CHECKIN` audit row so this distinct provenance is grep-able.
//
// Per CLAUDE.md gotcha #14: adding Role.PATIENT to authorize() does NOT
// exempt the handler from per-row scoping, so we also load the row and run
// assertPatientOwnsResource against its patientId.
router.patch(
  "/:id/status",
  authorize(Role.ADMIN, Role.DOCTOR, Role.RECEPTION, Role.NURSE, Role.PATIENT),
  validate(updateAppointmentStatusSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Capture previous state to only fire side-effects on state transitions.
      // Pulled BEFORE the update so we can also (a) check 404 cleanly and
      // (b) enforce per-row ownership for PATIENT callers.
      const prev = await prisma.appointment.findUnique({
        where: { id: req.params.id },
        select: { status: true, patientId: true },
      });
      if (!prev) {
        res.status(404).json({ success: false, data: null, error: "Appointment not found" });
        return;
      }

      // PATIENT scoping: must own the row AND can only self-cancel or
      // self-check-in (the latter constrained to today's own BOOKED row —
      // Pearl PRD §6.3 row 340).
      if (req.user?.role === Role.PATIENT) {
        if (!(await assertPatientOwnsResource(req, res, prev.patientId))) return;
        const nextStatus = req.body.status;
        if (nextStatus === "CANCELLED") {
          // existing allowed transition — falls through to update.
        } else if (nextStatus === "CHECKED_IN") {
          // Self-check-in window: appointment.date must equal "today IST".
          // `Appointment.date` is `@db.Date` (postgres DATE), which drops
          // the time component on round-trip. Comparing on instant bounds
          // (`istMidnightUtc(0)` vs the loaded Date) drifts by one
          // calendar day because Postgres returns UTC-midnight regardless
          // of how the row was inserted. Compare as `YYYY-MM-DD` strings
          // instead — the Postgres-stored DATE and the IST "today" both
          // yield clean string identities with no tz drift.
          const dateRow = await prisma.appointment.findUnique({
            where: { id: req.params.id },
            select: { date: true },
          });
          const apptDateStr =
            dateRow?.date instanceof Date
              ? dateRow.date.toISOString().slice(0, 10)
              : typeof dateRow?.date === "string"
                ? String(dateRow.date).slice(0, 10)
                : "";
          // Today in IST as YYYY-MM-DD: shift UTC now by +5.5h, then
          // slice the date portion.
          const istNow = new Date(Date.now() + 5.5 * 3600 * 1000);
          const istTodayStr = istNow.toISOString().slice(0, 10);
          if (!apptDateStr || apptDateStr !== istTodayStr) {
            res.status(403).json({
              success: false,
              data: null,
              error:
                "You can only check in for an appointment scheduled for today.",
            });
            return;
          }
          if (prev.status !== "BOOKED") {
            res.status(403).json({
              success: false,
              data: null,
              error:
                "Self check-in is only allowed for appointments that are still BOOKED.",
            });
            return;
          }
          // falls through to update.
        } else {
          res.status(403).json({
            success: false,
            data: null,
            error:
              "Patients can only cancel or check in to their own appointments.",
          });
          return;
        }
      }

      // Auto-stamp timing fields on status transitions
      const extraData: Record<string, unknown> = { status: req.body.status };
      const now = new Date();
      if (req.body.status === "CHECKED_IN") extraData.checkInAt = now;
      // Reverting a row back to BOOKED clears the stale lifecycle fields so it
      // reads as a fresh booking again: the arrival timestamp from a mistaken
      // check-in, the no-show reason when undoing a NO_SHOW, and the cancel
      // reason when restoring a CANCELLED appointment.
      if (req.body.status === "BOOKED") {
        extraData.checkInAt = null;
        extraData.calledAt = null;
        extraData.noShowReason = null;
        extraData.cancellationReason = null;
      }
      if (req.body.status === "IN_CONSULTATION") {
        extraData.consultationStartedAt = now;
        // The patient is now with the doctor — they're no longer "being called".
        extraData.calledAt = null;
      }
      if (req.body.status === "COMPLETED") extraData.consultationEndedAt = now;
      // Pearl §3.1 (gap closed 2026-05-29) — persist the cancel/no-show
      // reason. Zod already enforces presence when status is CANCELLED
      // or NO_SHOW so by the time we reach here the field is guaranteed
      // valid; for any other status the field is absent and we don't
      // overwrite the column (preserves a previously-recorded reason if
      // an admin re-flips status, which is rare but possible).
      if (req.body.status === "CANCELLED" && req.body.cancellationReason) {
        extraData.cancellationReason = req.body.cancellationReason;
      }
      if (req.body.status === "NO_SHOW" && req.body.noShowReason) {
        extraData.noShowReason = req.body.noShowReason;
      }

      const appointment = await prisma.appointment.update({
        where: { id: req.params.id },
        data: extraData,
        include: {
          patient: {
            include: { user: { select: { name: true, phone: true } } },
          },
          doctor: {
            include: { user: { select: { name: true } } },
          },
        },
      });

      const io = req.app.get("io");
      if (io) {
        io.to(`queue:${appointment.doctorId}`).emit("queue-updated", {
          doctorId: appointment.doctorId,
          date: appointment.date.toISOString().split("T")[0],
        });

        // If a patient is being called, emit token-called
        if (req.body.status === "IN_CONSULTATION") {
          const apt = appointment as any;
          io.to("token-display").emit("token-called", {
            doctorId: appointment.doctorId,
            doctorName: apt.doctor?.user?.name,
            tokenNumber: appointment.tokenNumber,
            patientName: apt.patient?.user?.name,
          });
        }
      }

      // Fire-and-forget notifications based on status
      if (req.body.status === "CANCELLED" && prev?.status !== "CANCELLED") {
        // Mirror the cancellation reason into the threaded Remarks so it
        // surfaces in the Remarks panel. Best-effort; staff only.
        if (
          req.body.cancellationReason &&
          req.user &&
          req.user.role !== Role.PATIENT
        ) {
          prisma.appointmentRemark
            .create({
              data: {
                appointmentId: appointment.id,
                authorUserId: req.user.userId,
                parentRemarkId: null,
                body: `Cancelled: ${req.body.cancellationReason}`,
                visibility: "ALL_STAFF",
                tenantId: req.tenantId ?? appointment.tenantId,
              },
            })
            .catch(console.error);
        }
        onAppointmentCancelled(appointment as any).catch(console.error);
        // Auto-notify next waitlisted patient for this doctor
        notifyNextInWaitlist(appointment.doctorId).catch(console.error);
      }
      if (req.body.status === "IN_CONSULTATION") {
        onTokenCalled(appointment as any).catch(console.error);
      }
      // Consult-fee billing: when a consult completes, auto-raise the
      // consultation invoice so it surfaces in the Billing section. Fee comes
      // from Doctor.consultationFee → `default_consultation_fee` admin config;
      // if neither is set, nothing is billed (helper returns null). Idempotent
      // via Invoice.appointmentId @unique, so a re-flip to COMPLETED won't
      // double-bill. Best-effort: a billing hiccup must not fail the status
      // update itself.
      if (req.body.status === "COMPLETED" && prev?.status !== "COMPLETED") {
        try {
          const consultInvoice =
            await createConsultationInvoiceForAppointment(appointment.id);
          if (consultInvoice?.created) {
            onBillGenerated(consultInvoice).catch(console.error);
            auditLog(
              req,
              "CONSULTATION_INVOICE_AUTO_CREATED",
              "invoice",
              consultInvoice.id,
              {
                invoiceNumber: consultInvoice.invoiceNumber,
                appointmentId: appointment.id,
                totalAmount: consultInvoice.totalAmount,
              },
            ).catch(console.error);
          }
        } catch (e) {
          console.error("Failed to auto-create consultation invoice", e);
        }
      }
      if (req.body.status === "CHECKED_IN" && prev?.status !== "CHECKED_IN") {
        notifyQueuePosition(appointment.id).catch(console.error);
        // Pearl §5.2 row 145 — advance the patient's chronic-care
        // sequence on check-in (skip-and-advance pattern).
        onPatientCheckedIn(appointment.patientId).catch(console.error);
      }

      // No-show policy: increment counter (analytics) when transitioning to
      // NO_SHOW. No consultation/no-show FEE is billed — only COMPLETED
      // appointments generate a consultation charge; a no-show invoice may
      // still carry pharmacy/medicine lines, but nothing is auto-added here.
      if (req.body.status === "NO_SHOW" && prev?.status !== "NO_SHOW") {
        // Mirror the no-show reason into the threaded Remarks so it surfaces in
        // the Remarks panel alongside the audit trail. Best-effort; staff only.
        if (req.body.noShowReason && req.user && req.user.role !== Role.PATIENT) {
          prisma.appointmentRemark
            .create({
              data: {
                appointmentId: appointment.id,
                authorUserId: req.user.userId,
                parentRemarkId: null,
                body: `Marked no-show: ${req.body.noShowReason}`,
                visibility: "ALL_STAFF",
                tenantId: req.tenantId ?? appointment.tenantId,
              },
            })
            .catch(console.error);
        }
        try {
          await prisma.patient.update({
            where: { id: appointment.patientId },
            data: { noShowCount: { increment: 1 } },
          });
        } catch (e) {
          console.error("Failed to increment noShowCount", e);
        }
      }

      // Pearl §3.1 — include the cancel / no-show reason in the audit
      // payload so the audit log is a single source of truth for WHY
      // this row's status changed.
      auditLog(req, "APPOINTMENT_STATUS_UPDATE", "appointment", req.params.id, {
        status: req.body.status,
        ...(req.body.status === "CANCELLED" && req.body.cancellationReason
          ? { cancellationReason: req.body.cancellationReason }
          : {}),
        ...(req.body.status === "NO_SHOW" && req.body.noShowReason
          ? { noShowReason: req.body.noShowReason }
          : {}),
      }).catch(console.error);

      // Pearl PRD §6.3 row 340 — distinct audit provenance for patient-driven
      // arrivals (vs reception staff marking arrival). Only fires for the
      // PATIENT → CHECKED_IN flow that the branch above just authorised.
      if (
        req.user?.role === Role.PATIENT &&
        req.body.status === "CHECKED_IN" &&
        prev?.status !== "CHECKED_IN"
      ) {
        auditLog(req, "PATIENT_SELF_CHECKIN", "appointment", req.params.id, {
          patientId: appointment.patientId,
          appointmentDate: appointment.date.toISOString().slice(0, 10),
        }).catch(console.error);
      }

      res.json({ success: true, data: appointment, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/v1/appointments/:id/call — CALLING-mode only.
// Marks a CHECKED_IN patient as "being called" (the transient state between
// check-in and the consult starting). The doctor may call patients in ANY
// order — not just FIFO. Only one patient per doctor+date is actively being
// called at a time, so calling a new patient clears the prior one's call.
router.post(
  "/:id/call",
  // Only a DOCTOR can call a patient in. Other staff (reception/admin/nurse)
  // have read-only visibility of the live queue + calling state.
  authorize(Role.DOCTOR),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const existing = await prisma.appointment.findUnique({
        where: { id: req.params.id },
        select: {
          id: true,
          doctorId: true,
          date: true,
          status: true,
          calledAt: true,
          doctor: { select: { appointmentMode: true } },
        },
      });
      if (!existing) {
        res
          .status(404)
          .json({ success: false, data: null, error: "Appointment not found" });
        return;
      }
      if (existing.doctor?.appointmentMode !== "CALLING") {
        res.status(400).json({
          success: false,
          data: null,
          error: "Calling a patient is only available for calling-mode doctors.",
        });
        return;
      }
      if (existing.status !== "CHECKED_IN") {
        res.status(400).json({
          success: false,
          data: null,
          error: "Only a checked-in patient can be called.",
        });
        return;
      }
      // Single active call: a doctor calls ONE patient at a time. If another
      // patient is already being called, block this until that call is
      // cancelled (the bell-off / uncall action). Re-calling the same patient
      // is a harmless no-op.
      if (!existing.calledAt) {
        const otherCalled = await prisma.appointment.findFirst({
          where: {
            doctorId: existing.doctorId,
            date: existing.date,
            status: "CHECKED_IN",
            calledAt: { not: null },
            id: { not: existing.id },
          },
          select: { id: true },
        });
        if (otherCalled) {
          res.status(409).json({
            success: false,
            data: null,
            error:
              "Another patient is already being called. Cancel that call first.",
          });
          return;
        }
      }
      const updated = await prisma.appointment.update({
        where: { id: existing.id },
        data: existing.calledAt ? {} : { calledAt: new Date() },
      });
      res.json({ success: true, data: updated, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/v1/appointments/:id/uncall — DOCTOR only.
// Cancel an in-progress call: clear calledAt so the patient drops out of the
// "calling" state back to plain CHECKED_IN (still waiting). The reverse of
// /call. No-op if the patient wasn't being called.
router.post(
  "/:id/uncall",
  authorize(Role.DOCTOR),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const existing = await prisma.appointment.findUnique({
        where: { id: req.params.id },
        select: { id: true },
      });
      if (!existing) {
        res
          .status(404)
          .json({ success: false, data: null, error: "Appointment not found" });
        return;
      }
      const updated = await prisma.appointment.update({
        where: { id: existing.id },
        data: { calledAt: null },
      });
      res.json({ success: true, data: updated, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// Reschedule notification trigger (fire-and-forget). Fires on EVERY
// reschedule regardless of who did it — the patient via the PWA or a
// MedCore staff member (reception/doctor/nurse/admin) — because both go
// through the single PATCH /:id/reschedule handler that calls this.
async function onAppointmentRescheduled(
  appointment: {
    id: string;
    tokenNumber: number | null;
    date: Date;
    slotStart?: string | null;
    patient: { user: { name: string; phone?: string | null } };
    doctor: { user: { name: string } };
  },
  // Pre-computed from the request at the call site (where `req` exists) so the
  // WhatsApp link uses the host the user is actually on — works on both the
  // software + demos environments without env config.
  portalLink: string,
): Promise<void> {
  const dateStr = new Date(appointment.date).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
  const timeStr = appointment.slotStart ? ` at ${appointment.slotStart}` : "";
  const doctorName = formatDoctorName(appointment.doctor.user.name);
  console.log(
    `[notification] Appointment rescheduled: ${appointment.patient.user.name} with ${doctorName} → ${dateStr}${timeStr} (Token #${appointment.tokenNumber})`
  );

  // WhatsApp confirmation to the patient (non-fatal — a send failure must
  // never unwind the reschedule). The sender normalises the phone itself.
  const phone = appointment.patient.user.phone;
  if (phone) {
    const tokenLine =
      appointment.tokenNumber != null
        ? `\nYour token: ${appointment.tokenNumber}`
        : "";
    const body =
      `Hi ${appointment.patient.user.name}, your appointment with ${doctorName} ` +
      `has been rescheduled to ${dateStr}${timeStr}.${tokenLine}\n\n` +
      `View or manage it here: ${portalLink} — MedCore`;
    try {
      await sendWhatsApp({ to: phone, body });
    } catch (e) {
      console.error("[reschedule] WhatsApp confirm failed (non-fatal)", e);
    }
  }
}

// PATCH /api/v1/appointments/:id/reschedule — reschedule appointment
router.patch(
  "/:id/reschedule",
  authorize(Role.ADMIN, Role.DOCTOR, Role.RECEPTION, Role.NURSE, Role.PATIENT),
  validate(rescheduleAppointmentSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { date, slotStart } = req.body;
      const dateObj = new Date(date);

      const existing = await prisma.appointment.findUnique({
        where: { id: req.params.id },
      });

      if (!existing) {
        res
          .status(404)
          .json({ success: false, data: null, error: "Appointment not found" });
        return;
      }

      // #511 BOLA fix: authorize() includes PATIENT for self-service
      // reschedule, but didn't gate per-row ownership — a PATIENT could
      // reschedule any appointment by UUID. Lock to own row.
      if (!(await assertPatientOwnsResource(req, res, existing.patientId))) return;

      if (!["BOOKED", "CHECKED_IN"].includes(existing.status)) {
        res.status(400).json({
          success: false,
          data: null,
          error: `Cannot reschedule an appointment with status ${existing.status}`,
        });
        return;
      }

      // Resolve the doctor's booking mode. TOKEN-mode doctors have no slot
      // grid — a reschedule just moves the row to a new date and mints the
      // next sequential token for that date (honouring the configured start
      // number), so the patient joins the tail of that day's queue.
      const doctor = await prisma.doctor.findUnique({
        where: { id: existing.doctorId },
        select: { appointmentMode: true, tokenStartNumber: true },
      });
      const isTokenDoctor = doctor?.appointmentMode === "TOKEN";
      const isCallingDoctor = doctor?.appointmentMode === "CALLING";
      const sameDate = existing.date.toISOString().split("T")[0] === date;
      // TOKEN and CALLING rows never store a slotStart (CALLING is an
      // arrival-order queue, not a timed slot); only SLOT keeps the chosen one.
      const effectiveSlot = isTokenDoctor || isCallingDoctor ? null : slotStart;

      // Verify the new slot is available — only meaningful when an actual
      // slot is being claimed (SLOT mode). TOKEN reschedules skip this.
      if (effectiveSlot) {
        const conflict = await prisma.appointment.findFirst({
          where: {
            doctorId: existing.doctorId,
            date: dateObj,
            slotStart: effectiveSlot,
            status: { notIn: ["CANCELLED", "NO_SHOW"] },
            id: { not: existing.id },
          },
        });

        if (conflict) {
          res.status(409).json({
            success: false,
            data: null,
            error: "The requested slot is already booked",
          });
          return;
        }
      }

      // Token assignment on reschedule:
      //   • Same date          → keep the existing token (no-op move).
      //   • TOKEN doctor, new date → KEEP the patient's ORIGINAL token number
      //     so their position relative to other moved patients is preserved
      //     regardless of the order staff reschedule them (the one who held
      //     the smaller token on the old day stays ahead on the new day).
      //     Only if that exact number is already taken on the target date do
      //     we fall back to the next free token at/after the configured start.
      //   • CALLING, new date → no token; append to the target day's arrival
      //     queue so the FIRST patient rescheduled lands ahead of later ones
      //     (FIFO by reschedule order). arrivalSeq drives the queue order.
      //   • SLOT, new date → next sequential token for that date.
      let tokenNumber: number | null;
      // undefined = leave arrivalSeq untouched (TOKEN/SLOT rows don't use it).
      let arrivalSeq: number | undefined;
      if (sameDate) {
        tokenNumber = existing.tokenNumber;
      } else if (isCallingDoctor) {
        tokenNumber = null;
        arrivalSeq = await getNextArrivalSeq(existing.doctorId, dateObj);
      } else if (isTokenDoctor && existing.tokenNumber != null) {
        const clash = await isTokenTakenOnDate(
          existing.doctorId,
          dateObj,
          existing.tokenNumber,
          existing.id,
        );
        tokenNumber = clash
          ? await getNextToken(existing.doctorId, dateObj, doctor?.tokenStartNumber)
          : existing.tokenNumber;
      } else {
        tokenNumber = await getNextToken(
          existing.doctorId,
          dateObj,
          isTokenDoctor ? doctor?.tokenStartNumber : undefined,
        );
      }

      // Pearl §3.1 (gap closed 2026-05-29) — persist the reschedule
      // reason on the row (Zod enforces presence + length 3-500 at the
      // boundary) so the column carries WHY this row's slot moved.
      const appointment = await prisma.appointment.update({
        where: { id: req.params.id },
        data: {
          date: dateObj,
          slotStart: effectiveSlot,
          tokenNumber,
          ...(arrivalSeq !== undefined ? { arrivalSeq } : {}),
          rescheduleReason: req.body.reason,
        },
        include: {
          patient: {
            include: { user: { select: { name: true, phone: true } } },
          },
          doctor: {
            include: { user: { select: { name: true } } },
          },
          vitals: true,
        },
      });

      // Record the reschedule reason as a remark on the appointment so it
      // surfaces in the threaded Remarks history (visible to staff) rather
      // than only living in the rescheduleReason column / audit log. Best
      // effort — a remark failure must not fail the reschedule itself.
      if (req.user && req.user.role !== Role.PATIENT) {
        const movedTo = effectiveSlot ? `${date} ${effectiveSlot}` : date;
        prisma.appointmentRemark
          .create({
            data: {
              appointmentId: appointment.id,
              authorUserId: req.user.userId,
              parentRemarkId: null,
              body: `Rescheduled to ${movedTo}: ${req.body.reason}`,
              visibility: "ALL_STAFF",
              tenantId: req.tenantId ?? existing.tenantId,
            },
          })
          .catch(console.error);
      }

      const io = req.app.get("io");
      if (io) {
        io.to(`queue:${appointment.doctorId}`).emit("queue-updated", {
          doctorId: appointment.doctorId,
          date,
        });
      }

      onAppointmentRescheduled(appointment as any, patientPortalLink(req)).catch(console.error);
      auditLog(req, "APPOINTMENT_RESCHEDULE", "appointment", appointment.id, {
        oldDate: existing.date.toISOString().split("T")[0],
        oldSlotStart: existing.slotStart,
        newDate: date,
        newSlotStart: effectiveSlot,
        reason: req.body.reason,
      }).catch(console.error);

      res.json({ success: true, data: appointment, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/v1/appointments/recurring — create N appointments on a schedule
router.post(
  "/recurring",
  authorize(Role.ADMIN, Role.RECEPTION),
  validate(recurringAppointmentSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { patientId, doctorId, startDate, slotStart, frequency, occurrences, notes } =
        req.body as {
          patientId: string;
          doctorId: string;
          startDate: string;
          slotStart: string;
          frequency: "DAILY" | "WEEKLY" | "MONTHLY";
          occurrences: number;
          notes?: string;
        };

      // A11 partial-revert (2026-05-17): IST-midnight rebase produced
      // the same off-by-one as the walk-in path above when @db.Date
      // extracted the UTC date portion of an IST-instant. Reverting
      // to pre-A11 setHours(0,0,0,0) which matches existing tests +
      // the conventional input shape from the recurring-series UI.
      // Cross-tz drift class documented for follow-up.
      const dates: Date[] = [];
      const base = new Date(startDate);
      base.setHours(0, 0, 0, 0);
      for (let i = 0; i < occurrences; i++) {
        const d = new Date(base);
        if (frequency === "DAILY") {
          d.setDate(base.getDate() + i);
        } else if (frequency === "WEEKLY") {
          d.setDate(base.getDate() + i * 7);
        } else {
          d.setMonth(base.getMonth() + i);
        }
        dates.push(d);
      }

      // Check that none of the slots conflict
      const conflicts = await prisma.appointment.findMany({
        where: {
          doctorId,
          slotStart,
          date: { in: dates },
          status: { notIn: ["CANCELLED", "NO_SHOW"] },
        },
        select: { date: true },
      });

      if (conflicts.length > 0) {
        res.status(409).json({
          success: false,
          data: null,
          error: `Slot conflicts on: ${conflicts
            .map((c) => c.date.toISOString().split("T")[0])
            .join(", ")}`,
        });
        return;
      }

      // Pin the doctor's tenant explicitly on every occurrence — a platform/
      // super-admin caller has no req.tenantId, so the scoping extension
      // can't auto-inject it (see the SCHEDULED-booking route above).
      const recurDoctor = await prisma.doctor.findUnique({
        where: { id: doctorId },
        select: { tenantId: true },
      });
      const recurTenantId = recurDoctor?.tenantId ?? null;

      // Single transaction — compute token numbers sequentially
      const created = await prisma.$transaction(async (tx) => {
        const results = [];
        for (const d of dates) {
          const last = await tx.appointment.findFirst({
            where: { doctorId, date: d },
            orderBy: { tokenNumber: "desc" },
          });
          const tokenNumber = (last?.tokenNumber ?? 0) + 1;

          const apt = await tx.appointment.create({
            data: {
              patientId,
              doctorId,
              date: d,
              slotStart,
              tokenNumber,
              type: "SCHEDULED",
              status: "BOOKED",
              notes,
              tenantId: recurTenantId,
            },
            include: {
              patient: {
                include: { user: { select: { name: true, phone: true } } },
              },
              doctor: {
                include: { user: { select: { name: true } } },
              },
            },
          });
          results.push(apt);
        }
        return results;
      });

      // Fire-and-forget notifications for each
      for (const apt of created) {
        onAppointmentBooked(apt as any, patientPortalLink(req)).catch(console.error);
      }

      auditLog(req, "RECURRING_APPOINTMENT_CREATE", "appointment", undefined, {
        patientId,
        doctorId,
        startDate,
        slotStart,
        frequency,
        occurrences,
        count: created.length,
      }).catch(console.error);

      res.status(201).json({ success: true, data: created, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/appointments/calendar — calendar-optimized list
router.get(
  "/calendar",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { doctorId, from, to } = req.query;

      // Super-admin tenant filter (see GET / above): narrow a cross-tenant
      // calendar to one tenant via `?tenantId=`. Ignored for tenant-bound
      // callers (already scoped by tenantScopedPrisma).
      const tenantIdParam = req.query.tenantId;
      const where: Record<string, unknown> = {
        ...(!req.tenantId && typeof tenantIdParam === "string" && tenantIdParam.trim().length > 0
          ? { tenantId: tenantIdParam.trim() }
          : {}),
      };
      if (doctorId) where.doctorId = doctorId;
      if (from || to) {
        const range: Record<string, Date> = {};
        if (from) range.gte = new Date(from as string);
        if (to) range.lte = new Date(to as string);
        where.date = range;
      }

      // Patients only see their own
      if (req.user!.role === "PATIENT") {
        const patient = await prisma.patient.findUnique({
          where: { userId: req.user!.userId },
        });
        if (patient) where.patientId = patient.id;
      }

      const appointments = await prisma.appointment.findMany({
        where,
        include: {
          patient: { include: { user: { select: { name: true } } } },
          doctor: { include: { user: { select: { name: true } } } },
        },
        orderBy: [{ date: "asc" }, { slotStart: "asc" }],
      });

      const data = appointments.map((a) => {
        const dateStr = a.date.toISOString().split("T")[0];
        const start = a.slotStart ?? "00:00";
        const [sh, sm] = start.split(":").map((n) => parseInt(n, 10));
        const startDt = new Date(`${dateStr}T${start}:00.000Z`);
        const endDt = new Date(startDt.getTime() + 15 * 60 * 1000);
        const endH = String(endDt.getUTCHours()).padStart(2, "0");
        const endM = String(endDt.getUTCMinutes()).padStart(2, "0");
        void sh;
        void sm;
        return {
          id: a.id,
          patientName: a.patient.user.name,
          doctorId: a.doctorId,
          doctorName: a.doctor.user.name,
          startDateTime: `${dateStr}T${start}:00.000Z`,
          endDateTime: `${dateStr}T${endH}:${endM}:00.000Z`,
          status: a.status,
          tokenNumber: a.tokenNumber,
          type: a.type,
          priority: a.priority,
        };
      });

      res.json({ success: true, data, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/appointments/no-shows — list missed appointments
router.get(
  "/no-shows",
  authorize(Role.ADMIN, Role.DOCTOR, Role.RECEPTION),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { from, to, doctorId } = req.query;
      const where: Record<string, unknown> = { status: "NO_SHOW" };
      if (doctorId) where.doctorId = doctorId;
      if (from || to) {
        const range: Record<string, Date> = {};
        if (from) range.gte = new Date(from as string);
        if (to) range.lte = new Date(to as string);
        where.date = range;
      } else {
        // default: last 30 days
        const thirtyAgo = new Date();
        thirtyAgo.setDate(thirtyAgo.getDate() - 30);
        where.date = { gte: thirtyAgo };
      }

      const noShows = await prisma.appointment.findMany({
        where,
        include: {
          patient: {
            include: { user: { select: { name: true, phone: true } } },
          },
          doctor: { include: { user: { select: { name: true } } } },
        },
        orderBy: { date: "desc" },
        take: 500,
      });

      res.json({ success: true, data: noShows, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/appointments/check-conflict?patientId=&date=&slotStart=
// Detects double-booking of same patient at same time across doctors
router.get(
  "/check-conflict",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { patientId, date, slotStart, excludeId } = req.query;
      if (!patientId || !date || !slotStart) {
        res.status(400).json({
          success: false,
          data: null,
          error: "patientId, date, slotStart are required",
        });
        return;
      }
      const conflicts = await prisma.appointment.findMany({
        where: {
          patientId: patientId as string,
          date: new Date(date as string),
          slotStart: slotStart as string,
          status: { notIn: ["CANCELLED", "NO_SHOW"] },
          ...(excludeId ? { id: { not: excludeId as string } } : {}),
        },
        include: {
          doctor: { include: { user: { select: { name: true } } } },
        },
      });
      res.json({
        success: true,
        data: { hasConflict: conflicts.length > 0, conflicts },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/appointments/next-token?doctorId=&date=YYYY-MM-DD
// Preview the next sequential token a TOKEN-mode doctor would mint on a given
// date. Reads the doctor's tokenPrefix / tokenStartNumber / dailyAppointmentLimit
// from the DB so the booking confirm dialog can show the exact token (e.g.
// "R5") that will be assigned, and flag when the daily cap is already reached.
router.get(
  "/next-token",
  authorize(Role.ADMIN, Role.DOCTOR, Role.RECEPTION, Role.NURSE),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const doctorId = String(req.query.doctorId ?? "");
      const dateStr = String(req.query.date ?? "");
      if (!doctorId || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
        res.status(400).json({
          success: false,
          data: null,
          error: "doctorId and date (YYYY-MM-DD) are required",
        });
        return;
      }
      const doctor = await prisma.doctor.findUnique({
        where: { id: doctorId },
        select: {
          appointmentMode: true,
          tokenPrefix: true,
          tokenStartNumber: true,
          dailyAppointmentLimit: true,
        },
      });
      if (!doctor) {
        res.status(404).json({ success: false, data: null, error: "Doctor not found" });
        return;
      }
      const dateObj = new Date(`${dateStr}T00:00:00.000Z`);
      const dayStart = new Date(dateObj);
      dayStart.setUTCHours(0, 0, 0, 0);
      const dayEnd = new Date(dayStart);
      dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);
      const bookedCount = await prisma.appointment.count({
        where: {
          doctorId,
          date: { gte: dayStart, lt: dayEnd },
          status: { notIn: ["CANCELLED", "NO_SHOW"] },
        },
      });
      const dailyLimit = doctor.dailyAppointmentLimit ?? null;
      const limitReached = dailyLimit !== null && bookedCount >= dailyLimit;
      let tokenNumber: number | null = null;
      let tokenLabel: string | null = null;
      if (doctor.appointmentMode === "TOKEN" && !limitReached) {
        tokenNumber = await getNextToken(doctorId, dateObj, doctor.tokenStartNumber);
        // Hyphenate prefix + number for the booking-confirm preview (e.g.
        // "R-5"); bare number when no prefix is configured.
        tokenLabel = doctor.tokenPrefix
          ? `${doctor.tokenPrefix}-${tokenNumber}`
          : `${tokenNumber}`;
      }
      res.json({
        success: true,
        data: {
          mode: doctor.appointmentMode,
          tokenNumber,
          tokenLabel,
          dailyLimit,
          bookedCount,
          limitReached,
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/appointments/stats — aggregate statistics
router.get(
  "/stats",
  authorize(Role.ADMIN, Role.DOCTOR, Role.RECEPTION),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { from, to, doctorId } = req.query;

      // Super-admin tenant filter (see GET / above): narrow cross-tenant
      // stats to one tenant via `?tenantId=`. Ignored for tenant-bound
      // callers (already scoped by tenantScopedPrisma). Only the top-level
      // appointment where is filtered — the aggregation is unchanged.
      const tenantIdParam = req.query.tenantId;
      const where: Record<string, unknown> = {
        ...(!req.tenantId && typeof tenantIdParam === "string" && tenantIdParam.trim().length > 0
          ? { tenantId: tenantIdParam.trim() }
          : {}),
      };
      if (doctorId) where.doctorId = doctorId;
      if (from || to) {
        const range: Record<string, Date> = {};
        if (from) range.gte = new Date(from as string);
        if (to) range.lte = new Date(to as string);
        where.date = range;
      }

      const appointments = await prisma.appointment.findMany({
        where,
        select: {
          id: true,
          status: true,
          slotStart: true,
          date: true,
          doctorId: true,
          checkInAt: true,
          consultationStartedAt: true,
          consultationEndedAt: true,
        },
      });

      const totalCount = appointments.length;
      const byStatus: Record<string, number> = {
        BOOKED: 0,
        CHECKED_IN: 0,
        IN_CONSULTATION: 0,
        COMPLETED: 0,
        CANCELLED: 0,
        NO_SHOW: 0,
      };
      const hourBuckets: Record<number, number> = {};
      let waitSumMin = 0;
      let waitCount = 0;
      let consSumMin = 0;
      let consCount = 0;

      for (const a of appointments) {
        byStatus[a.status] = (byStatus[a.status] ?? 0) + 1;
        if (a.slotStart) {
          const h = parseInt(a.slotStart.split(":")[0], 10);
          if (!isNaN(h)) hourBuckets[h] = (hourBuckets[h] ?? 0) + 1;
        }
        if (a.checkInAt && a.consultationStartedAt) {
          const diff =
            (a.consultationStartedAt.getTime() - a.checkInAt.getTime()) / 60000;
          if (diff >= 0 && diff < 480) {
            waitSumMin += diff;
            waitCount += 1;
          }
        }
        if (a.consultationStartedAt && a.consultationEndedAt) {
          const diff =
            (a.consultationEndedAt.getTime() - a.consultationStartedAt.getTime()) /
            60000;
          if (diff >= 0 && diff < 240) {
            consSumMin += diff;
            consCount += 1;
          }
        }
      }

      let peakHour: number | null = null;
      let peakCount = -1;
      for (const [h, c] of Object.entries(hourBuckets)) {
        if (c > peakCount) {
          peakCount = c;
          peakHour = parseInt(h, 10);
        }
      }

      res.json({
        success: true,
        data: {
          totalCount,
          byStatus,
          completedCount: byStatus.COMPLETED,
          cancelledCount: byStatus.CANCELLED,
          noShowCount: byStatus.NO_SHOW,
          avgWaitTimeMin:
            waitCount > 0 ? Math.round((waitSumMin / waitCount) * 10) / 10 : null,
          avgConsultationTimeMin:
            consCount > 0 ? Math.round((consSumMin / consCount) * 10) / 10 : 15,
          peakHour,
          peakHourCount: peakCount >= 0 ? peakCount : 0,
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/appointments/:id
// #511 BOLA fix: previously any authenticated PATIENT could fetch any
// appointment by UUID. Now gated via assertPatientOwnsResource so a
// PATIENT only sees their own appointment row (staff roles unaffected).
router.get(
  "/:id",
  async (req: Request, res: Response, next: NextFunction) => {
    // Avoid capturing static route names as an appointment id
    if (req.params.id === "next-available") {
      next();
      return;
    }
    try {
      const appointment = await prisma.appointment.findUnique({
        where: { id: req.params.id },
        include: {
          patient: {
            // photoUrl from BOTH the User row (Settings) and Patient row
            // (registration/edit) so the consult rail avatar resolves from
            // either. See resolveFirstPhotoUrl below.
            include: {
              user: {
                select: { name: true, phone: true, email: true, photoUrl: true },
              },
            },
          },
          doctor: {
            include: { user: { select: { name: true } } },
          },
          vitals: true,
          consultation: true,
          prescription: { include: { items: true } },
          invoice: { include: { items: true, payments: true } },
        },
      });

      if (!appointment) {
        res.status(404).json({ success: false, data: null, error: "Appointment not found" });
        return;
      }

      if (!(await assertPatientOwnsResource(req, res, appointment.patientId))) return;

      // Attach a resolved signed avatar URL onto the patient for the
      // consult rail + any other appointment-detail consumer.
      const photoSignedUrl = await resolveFirstPhotoUrl(
        appointment.patient?.photoUrl,
        appointment.patient?.user?.photoUrl,
      );
      res.json({
        success: true,
        data: {
          ...appointment,
          patient: appointment.patient
            ? { ...appointment.patient, photoSignedUrl }
            : appointment.patient,
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─── GROUP APPOINTMENTS (therapy / training sessions) ─────
// POST /api/v1/appointments/group — create N appointments with same groupId
router.post(
  "/group",
  authorize(Role.RECEPTION, Role.ADMIN, Role.DOCTOR),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { doctorId, date, slotStart, patientIds, notes } = req.body as {
        doctorId: string;
        date: string;
        slotStart?: string;
        patientIds: string[];
        notes?: string;
      };
      if (!doctorId || !date || !Array.isArray(patientIds) || patientIds.length === 0) {
        res.status(400).json({
          success: false,
          data: null,
          error: "doctorId, date, and at least one patientId required",
        });
        return;
      }
      const dateObj = new Date(date);
      const groupId = `GRP-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

      // Pearl §2.1.2 added `@@unique([doctorId, date, slotStart])` to block
      // solo SLOT-mode double-booking. Group bookings intentionally share a
      // start time across N patients (yoga therapy, group counselling), so
      // they must store `slotStart = null` to dodge the unique constraint.
      // The intended start time is preserved in `notes` so the frontend can
      // still display it and the original `slotStart` query parameter is
      // honored for audit-log payload + downstream reminder cascades.
      const groupNoteTime = slotStart ? ` @ ${slotStart}` : "";
      const groupNotes = notes
        ? `[GROUP${groupNoteTime}] ${notes}`
        : `[GROUP ${groupId}${groupNoteTime}]`;

      // tokenNumber is nullable since the Pearl §2.1.2 schema change for
      // CALLING/SLOT-mode bookings; the group-booking flow itself always
      // sets it, but the type now honestly reflects the schema.
      // Pin the doctor's tenant explicitly on every row — a platform/
      // super-admin caller has no req.tenantId, so the scoping extension
      // can't auto-inject it (see the SCHEDULED-booking route above).
      const groupDoctor = await prisma.doctor.findUnique({
        where: { id: doctorId },
        select: { tenantId: true },
      });
      const groupTenantId = groupDoctor?.tenantId ?? null;

      const created: Array<{ id: string; tokenNumber: number | null; patientId: string }> = [];
      let nextToken = await getNextToken(doctorId, dateObj);
      for (const patientId of patientIds) {
        const appt = await prisma.appointment.create({
          data: {
            patientId,
            doctorId,
            date: dateObj,
            // Null intentional — see comment above.
            slotStart: null,
            tokenNumber: nextToken,
            type: "SCHEDULED",
            status: "BOOKED",
            notes: groupNotes,
            groupId,
            tenantId: groupTenantId,
          },
        });
        created.push({ id: appt.id, tokenNumber: appt.tokenNumber, patientId });
        nextToken += 1;
      }

      auditLog(req, "GROUP_APPOINTMENT_CREATE", "appointment", groupId, {
        doctorId,
        date,
        patientCount: patientIds.length,
      }).catch(console.error);

      res.status(201).json({
        success: true,
        data: { groupId, appointments: created },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─── CALENDAR INVITE (.ics) ─────────────────────────────
// GET /api/v1/appointments/:id/calendar.ics — return iCalendar file
router.get(
  "/:id/calendar.ics",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const appointment = await prisma.appointment.findUnique({
        where: { id: req.params.id },
        include: {
          patient: {
            include: { user: { select: { name: true, email: true } } },
          },
          doctor: {
            include: { user: { select: { name: true } } },
          },
        },
      });
      if (!appointment) {
        res.status(404).json({ success: false, data: null, error: "Not found" });
        return;
      }

      // #511 audit: VERIFIED-SAFE — gated by assertPatientOwnsResource so a
      // PATIENT only downloads their own .ics. .ics is a publicly-shareable
      // format once issued, so we MUST keep the issue itself patient-self-only.
      // Refactored from inline check to the canonical helper for drift
      // prevention (was a hand-rolled equivalent before the #511 sweep).
      if (!(await assertPatientOwnsResource(req, res, appointment.patientId))) return;

      const slotStart = appointment.slotStart ?? "09:00";
      const [sh, sm] = slotStart.split(":").map((n) => parseInt(n, 10));
      const durationMin = 15;
      const startUtc = new Date(
        Date.UTC(
          appointment.date.getUTCFullYear(),
          appointment.date.getUTCMonth(),
          appointment.date.getUTCDate(),
          sh,
          sm,
          0
        )
      );
      const endUtc = new Date(startUtc.getTime() + durationMin * 60 * 1000);
      const fmtUtc = (d: Date): string =>
        `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(
          d.getUTCDate()
        ).padStart(2, "0")}T${String(d.getUTCHours()).padStart(2, "0")}${String(
          d.getUTCMinutes()
        ).padStart(2, "0")}${String(d.getUTCSeconds()).padStart(2, "0")}Z`;

      const dtStart = fmtUtc(startUtc);
      const dtEnd = fmtUtc(endUtc);
      const dtStamp = fmtUtc(new Date());

      const uid = `${appointment.id}@medcore`;
      const doctorName = appointment.doctor.user.name;
      const patientName = appointment.patient.user.name;
      const summary = `Appointment with ${formatDoctorName(doctorName)}`;
      const description = `Token #${appointment.tokenNumber}. Patient: ${patientName}. Status: ${appointment.status}.`;

      const esc = (s: string): string =>
        s.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/,/g, "\\,").replace(/;/g, "\\;");

      const ics = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//MedCore//Appointment//EN",
        "CALSCALE:GREGORIAN",
        "METHOD:PUBLISH",
        "BEGIN:VEVENT",
        `UID:${uid}`,
        `DTSTAMP:${dtStamp}`,
        `DTSTART:${dtStart}`,
        `DTEND:${dtEnd}`,
        `SUMMARY:${esc(summary)}`,
        `DESCRIPTION:${esc(description)}`,
        "LOCATION:MedCore Hospital",
        "STATUS:CONFIRMED",
        "END:VEVENT",
        "END:VCALENDAR",
      ].join("\r\n");

      res.setHeader("Content-Type", "text/calendar; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="appointment-${appointment.id.slice(0, 8)}.ics"`
      );
      res.send(ics);
    } catch (err) {
      next(err);
    }
  }
);

// ─── NEXT AVAILABLE SLOT ────────────────────────────────
// GET /api/v1/appointments/next-available?fromDate=YYYY-MM-DD&specialty=&anyDoctor=true
router.get(
  "/next-available",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const fromDateStr = (req.query.fromDate as string) || undefined;
      const specialty = (req.query.specialty as string) || undefined;
      // Match getNextToken's UTC convention for the forward-search
      // window so day-boundary comparisons against stored DATE values
      // are consistent across host timezones (A11). Prior: local-tz
      // `setHours(0,0,0,0)` shifted the window by host offset.
      const fromDate = fromDateStr ? new Date(fromDateStr) : new Date();
      fromDate.setUTCHours(0, 0, 0, 0);

      const doctorWhere: Record<string, unknown> = {};
      if (specialty) doctorWhere.specialization = specialty;
      const doctors = await prisma.doctor.findMany({
        where: doctorWhere,
        include: {
          schedules: true,
          user: { select: { name: true } },
        },
      });

      if (doctors.length === 0) {
        res.json({
          success: true,
          data: { slot: null, reason: "No doctors found" },
          error: null,
        });
        return;
      }

      const DAYS = 14;
      let best: {
        doctorId: string;
        doctorName: string;
        specialization: string | null;
        date: string;
        startTime: string;
        endTime: string;
      } | null = null;

      // `todayIso` stays on the SAME UTC basis as `dIso` (both derive from
      // toISOString on UTC-midnight dates) so the same-day gate at line
      // ~1746 lines up. Only `nowMin` was the real bug — the elapsed-slot
      // cutoff must be the IST clock, not the UTC-host server clock, or
      // already-past slots get returned as "next available".
      const todayIso = new Date().toISOString().split("T")[0];
      const nowMin = istNowMinutes();

      for (const doc of doctors) {
        for (let i = 0; i < DAYS; i++) {
          const d = new Date(fromDate);
          d.setDate(fromDate.getDate() + i);
          const dayOfWeek = d.getDay();
          const daySchedules = doc.schedules.filter((s) => s.dayOfWeek === dayOfWeek);
          if (daySchedules.length === 0) continue;

          const override = await prisma.scheduleOverride.findUnique({
            where: { doctorId_date: { doctorId: doc.id, date: d } },
          });
          if (override?.isBlocked) continue;

          // Skip days the doctor is on confirmed (APPROVED) leave — never
          // suggest a "next available" slot the doctor can't honour.
          if (await isDoctorOnConfirmedLeave(doc.id, d)) continue;

          const booked = await prisma.appointment.findMany({
            where: {
              doctorId: doc.id,
              date: d,
              status: { notIn: ["CANCELLED", "NO_SHOW"] },
            },
            select: { slotStart: true },
          });
          const bookedSet = new Set(booked.map((b) => b.slotStart));
          const dIso = d.toISOString().split("T")[0];

          let foundForDay: { startStr: string; endStr: string } | null = null;
          for (const sch of daySchedules) {
            const startTime = override?.startTime || sch.startTime;
            const endTime = override?.endTime || sch.endTime;
            const duration = sch.slotDurationMinutes || DEFAULT_SLOT_DURATION_MINUTES;
            const buffer = sch.bufferMinutes || 0;
            const step = duration + buffer;

            const [ssh, ssm] = startTime.split(":").map(Number);
            const [eh, em] = endTime.split(":").map(Number);
            const startMin = ssh * 60 + ssm;
            const endMin = eh * 60 + em;

            for (let m = startMin; m + duration <= endMin; m += step) {
              const startStr = `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(
                m % 60
              ).padStart(2, "0")}`;
              const endM = m + duration;
              const endStr = `${String(Math.floor(endM / 60)).padStart(2, "0")}:${String(
                endM % 60
              ).padStart(2, "0")}`;

              if (dIso === todayIso && m < nowMin) continue;
              if (!bookedSet.has(startStr)) {
                foundForDay = { startStr, endStr };
                break;
              }
            }
            if (foundForDay) break;
          }

          if (foundForDay) {
            const candidate = {
              doctorId: doc.id,
              doctorName: doc.user.name,
              specialization: doc.specialization,
              date: dIso,
              startTime: foundForDay.startStr,
              endTime: foundForDay.endStr,
            };
            if (
              !best ||
              candidate.date < best.date ||
              (candidate.date === best.date && candidate.startTime < best.startTime)
            ) {
              best = candidate;
            }
            break; // earliest day for this doctor found
          }
        }
      }

      res.json({
        success: true,
        data: { slot: best, searchedDoctors: doctors.length, windowDays: DAYS },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─── TRANSFER APPOINTMENT TO ANOTHER DOCTOR ─────────────
// PATCH /api/v1/appointments/:id/transfer-doctor
router.patch(
  "/:id/transfer-doctor",
  authorize(Role.ADMIN, Role.RECEPTION),
  validate(transferAppointmentSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { newDoctorId, reason } = req.body as {
        newDoctorId: string;
        reason: string;
      };

      const existing = await prisma.appointment.findUnique({
        where: { id: req.params.id },
      });
      if (!existing) {
        res.status(404).json({ success: false, data: null, error: "Not found" });
        return;
      }
      if (existing.doctorId === newDoctorId) {
        res.status(400).json({
          success: false,
          data: null,
          error: "Appointment is already with this doctor",
        });
        return;
      }
      if (["COMPLETED", "CANCELLED", "NO_SHOW"].includes(existing.status)) {
        res.status(400).json({
          success: false,
          data: null,
          error: `Cannot transfer an appointment with status ${existing.status}`,
        });
        return;
      }

      const newToken = await getNextToken(newDoctorId, existing.date);

      const oldDoctorId = existing.doctorId;
      const appointment = await prisma.appointment.update({
        where: { id: req.params.id },
        data: {
          doctorId: newDoctorId,
          tokenNumber: newToken,
          notes: existing.notes
            ? `${existing.notes}\n[TRANSFERRED] ${reason}`
            : `[TRANSFERRED] ${reason}`,
        },
        include: {
          patient: { include: { user: { select: { name: true, phone: true } } } },
          doctor: { include: { user: { select: { name: true } } } },
        },
      });

      const io = req.app.get("io");
      if (io) {
        const dateStr = appointment.date.toISOString().split("T")[0];
        io.to(`queue:${oldDoctorId}`).emit("queue-updated", {
          doctorId: oldDoctorId,
          date: dateStr,
        });
        io.to(`queue:${newDoctorId}`).emit("queue-updated", {
          doctorId: newDoctorId,
          date: dateStr,
        });
      }

      auditLog(req, "APPOINTMENT_TRANSFER", "appointment", appointment.id, {
        oldDoctorId,
        newDoctorId,
        reason,
      }).catch(console.error);

      res.json({ success: true, data: appointment, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// ─── LWBS (Left Without Being Seen) ─────────────────────
// PATCH /api/v1/appointments/:id/mark-lwbs
router.patch(
  "/:id/mark-lwbs",
  authorize(Role.ADMIN, Role.DOCTOR, Role.RECEPTION, Role.NURSE),
  validate(markLwbsSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { reason } = req.body as { reason?: string };

      const existing = await prisma.appointment.findUnique({
        where: { id: req.params.id },
        select: { status: true, patientId: true, doctorId: true },
      });
      if (!existing) {
        res.status(404).json({ success: false, data: null, error: "Not found" });
        return;
      }

      const appointment = await prisma.appointment.update({
        where: { id: req.params.id },
        data: {
          status: "NO_SHOW",
          lwbsReason: reason ?? "Left without being seen",
        },
        include: {
          patient: { include: { user: { select: { name: true, phone: true } } } },
          doctor: { include: { user: { select: { name: true } } } },
        },
      });

      if (existing.status !== "NO_SHOW") {
        prisma.patient
          .update({
            where: { id: existing.patientId },
            data: { noShowCount: { increment: 1 } },
          })
          .catch(console.error);
      }

      const io = req.app.get("io");
      if (io) {
        io.to(`queue:${appointment.doctorId}`).emit("queue-updated", {
          doctorId: appointment.doctorId,
          date: appointment.date.toISOString().split("T")[0],
        });
      }

      auditLog(req, "APPOINTMENT_LWBS_MARK", "appointment", appointment.id, { reason }).catch(
        console.error
      );

      res.json({ success: true, data: appointment, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/appointments/group/:groupId — all members
// #511 BOLA fix: group appointments are intended for coordinated visits
// (e.g. group therapy / family vaccination). Members of a group are
// expected to see each other, but a non-member PATIENT must NOT be able
// to read the roster by enumerating groupIds. We require the calling
// PATIENT to themselves be a member of the group before we return its
// roster. Staff roles (ADMIN/DOCTOR/RECEPTION/NURSE) bypass this check
// — they need to see all groups for coordination.
router.get(
  "/group/:groupId",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const members = await prisma.appointment.findMany({
        where: { groupId: req.params.groupId },
        include: {
          patient: { include: { user: { select: { name: true, phone: true } } } },
          doctor: { include: { user: { select: { name: true } } } },
        },
        orderBy: { tokenNumber: "asc" },
      });

      if (members.length === 0) {
        res.status(404).json({ success: false, data: null, error: "Group not found" });
        return;
      }

      // PATIENT membership gate: caller must be one of the member patients.
      if (req.user!.role === Role.PATIENT) {
        const self = await prisma.patient.findUnique({
          where: { userId: req.user!.userId },
          select: { id: true },
        });
        const isMember = !!self && members.some((m) => m.patientId === self.id);
        if (!isMember) {
          res.status(403).json({ success: false, data: null, error: "Forbidden" });
          return;
        }
      }

      res.json({
        success: true,
        data: { groupId: req.params.groupId, members },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─── BULK OPERATIONS ─────────────────────────────────
// POST /api/v1/appointments/bulk-action
// Body: { appointmentIds: string[], action: "CANCEL" | "NO_SHOW" | "SEND_REMINDER" }
router.post(
  "/bulk-action",
  authorize(Role.ADMIN, Role.RECEPTION, Role.DOCTOR, Role.NURSE),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { appointmentIds, action, reason } = req.body as {
        appointmentIds?: string[];
        action?: string;
        // Pearl §3.1 — optional bulk reason. The single-row PATCH /status
        // requires a reason per row; the bulk endpoint accepts ONE
        // reason that applies to every row in the batch (admins
        // running batch cleanups typically have a single rationale).
        // Stored on each affected row's cancellationReason /
        // noShowReason column and included in the per-row audit.
        reason?: string;
      };

      if (
        !Array.isArray(appointmentIds) ||
        appointmentIds.length === 0 ||
        !appointmentIds.every((id) => typeof id === "string")
      ) {
        res.status(400).json({
          success: false,
          data: null,
          error: "appointmentIds must be a non-empty string array",
        });
        return;
      }

      const allowed = ["CANCEL", "NO_SHOW", "SEND_REMINDER"];
      if (!action || !allowed.includes(action)) {
        res.status(400).json({
          success: false,
          data: null,
          error: `action must be one of: ${allowed.join(", ")}`,
        });
        return;
      }
      // Light validation of the optional reason (matches the single-row
      // Zod constraint: 3-500 chars if present).
      const trimmedReason = typeof reason === "string" ? reason.trim() : "";
      if (
        trimmedReason &&
        (trimmedReason.length < 3 || trimmedReason.length > 500)
      ) {
        res.status(400).json({
          success: false,
          data: null,
          error: "reason must be 3-500 characters when provided",
        });
        return;
      }

      // Fetch existing appointments to validate & filter
      const found = await prisma.appointment.findMany({
        where: { id: { in: appointmentIds } },
        include: {
          patient: { include: { user: { select: { name: true, phone: true, email: true } } } },
          doctor: { include: { user: { select: { name: true } } } },
        },
      });

      const results: Array<{ id: string; status: "ok" | "skipped" | "error"; message?: string }> = [];

      if (action === "CANCEL") {
        for (const apt of found) {
          if (["COMPLETED", "CANCELLED"].includes(apt.status)) {
            results.push({ id: apt.id, status: "skipped", message: "already finalized" });
            continue;
          }
          try {
            await prisma.appointment.update({
              where: { id: apt.id },
              data: {
                status: "CANCELLED",
                ...(trimmedReason
                  ? { cancellationReason: trimmedReason }
                  : {}),
              },
            });
            onAppointmentCancelled(apt as any).catch(console.error);
            results.push({ id: apt.id, status: "ok" });
          } catch (e) {
            results.push({
              id: apt.id,
              status: "error",
              message: e instanceof Error ? e.message : "failed",
            });
          }
        }
      } else if (action === "NO_SHOW") {
        for (const apt of found) {
          if (!["BOOKED", "CHECKED_IN"].includes(apt.status)) {
            results.push({ id: apt.id, status: "skipped", message: "not active" });
            continue;
          }
          try {
            await prisma.$transaction([
              prisma.appointment.update({
                where: { id: apt.id },
                data: {
                  status: "NO_SHOW",
                  ...(trimmedReason
                    ? { noShowReason: trimmedReason }
                    : {}),
                },
              }),
              prisma.patient.update({
                where: { id: apt.patientId },
                data: { noShowCount: { increment: 1 } },
              }),
            ]);
            results.push({ id: apt.id, status: "ok" });
          } catch (e) {
            results.push({
              id: apt.id,
              status: "error",
              message: e instanceof Error ? e.message : "failed",
            });
          }
        }
      } else if (action === "SEND_REMINDER") {
        // Fire-and-forget reminder notifications (re-use onAppointmentBooked path which
        // queues an SMS/email via notification-triggers). If you have a dedicated
        // reminder function, call it here instead.
        for (const apt of found) {
          try {
            onAppointmentBooked(apt as any, patientPortalLink(req)).catch(console.error);
            results.push({ id: apt.id, status: "ok" });
          } catch (e) {
            results.push({
              id: apt.id,
              status: "error",
              message: e instanceof Error ? e.message : "failed",
            });
          }
        }
      }

      // Audit log
      auditLog(
        req,
        `APPOINTMENT_BULK_${action}`,
        "appointment",
        undefined,
        { count: appointmentIds.length, action, results }
      ).catch(console.error);

      const okCount = results.filter((r) => r.status === "ok").length;
      const skippedCount = results.filter((r) => r.status === "skipped").length;
      const errorCount = results.filter((r) => r.status === "error").length;

      res.json({
        success: true,
        data: {
          requested: appointmentIds.length,
          processed: okCount,
          skipped: skippedCount,
          errors: errorCount,
          results,
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ─── TRANSFER APPOINTMENT TO ANOTHER DOCTOR (Apr 2026) ──
router.post(
  "/:id/transfer",
  authorize(Role.ADMIN, Role.DOCTOR, Role.RECEPTION),
  validate(transferAppointmentSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const existing = await prisma.appointment.findUnique({
        where: { id: req.params.id },
      });
      if (!existing) {
        res.status(404).json({ success: false, data: null, error: "Appointment not found" });
        return;
      }
      if (existing.status === "COMPLETED" || existing.status === "CANCELLED") {
        res.status(409).json({
          success: false,
          data: null,
          error: `Cannot transfer ${existing.status} appointment`,
        });
        return;
      }

      const { newDoctorId, reason } = req.body as { newDoctorId: string; reason: string };
      const newDoctor = await prisma.doctor.findUnique({
        where: { id: newDoctorId },
      });
      if (!newDoctor) {
        res.status(404).json({
          success: false,
          data: null,
          error: "Target doctor not found",
        });
        return;
      }
      if (newDoctorId === existing.doctorId) {
        res.status(400).json({
          success: false,
          data: null,
          error: "Target doctor is the same as current doctor",
        });
        return;
      }

      const last = await prisma.appointment.findFirst({
        where: { doctorId: newDoctorId, date: existing.date },
        orderBy: { tokenNumber: "desc" },
        select: { tokenNumber: true },
      });
      const nextToken = (last?.tokenNumber ?? 0) + 1;

      // Issue #842: embed FRIENDLY names in the transfer note rather than
      // the raw doctorId / userId UUIDs. The previous note shape
      // `[TRANSFERRED from <doctorUuid> by <userUuid>] <reason>` surfaced
      // verbatim in the patient timeline / Recent Activity widget, leaking
      // internal identifiers AND being unreadable at a glance for
      // reception. Resolve both UUIDs to display names server-side here.
      const [fromDoctor, actor] = await Promise.all([
        prisma.doctor.findUnique({
          where: { id: existing.doctorId },
          include: { user: { select: { name: true } } },
        }),
        prisma.user.findUnique({
          where: { id: req.user!.userId },
          select: { name: true },
        }),
      ]);
      const fromName = fromDoctor?.user?.name
        ? `Dr. ${fromDoctor.user.name.replace(/^Dr\.?\s+/i, "")}`
        : "previous doctor";
      const actorName = actor?.name || "staff";
      const transferNote = `[TRANSFERRED from ${fromName} by ${actorName}] ${reason}`;

      const updated = await prisma.appointment.update({
        where: { id: existing.id },
        data: {
          doctorId: newDoctorId,
          tokenNumber: nextToken,
          status: "BOOKED",
          notes: existing.notes
            ? `${existing.notes}\n${transferNote}`
            : transferNote,
        },
        include: {
          patient: { include: { user: { select: { name: true, phone: true } } } },
          doctor: { include: { user: { select: { name: true } } } },
        },
      });

      auditLog(req, "APPOINTMENT_TRANSFER", "appointment", updated.id, {
        fromDoctorId: existing.doctorId,
        toDoctorId: newDoctorId,
        reason,
      }).catch(console.error);

      res.json({ success: true, data: updated, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// ─── MARK LWBS (Left Without Being Seen) (Apr 2026) ─────
router.patch(
  "/:id/lwbs",
  authorize(Role.ADMIN, Role.DOCTOR, Role.NURSE, Role.RECEPTION),
  validate(markLwbsSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const existing = await prisma.appointment.findUnique({
        where: { id: req.params.id },
      });
      if (!existing) {
        res.status(404).json({ success: false, data: null, error: "Appointment not found" });
        return;
      }
      if (existing.status === "COMPLETED" || existing.status === "CANCELLED") {
        res.status(409).json({
          success: false,
          data: null,
          error: `Cannot mark ${existing.status} appointment as LWBS`,
        });
        return;
      }

      const updated = await prisma.appointment.update({
        where: { id: existing.id },
        data: {
          status: "NO_SHOW",
          lwbsReason: req.body.reason ?? "Left without being seen",
        },
      });

      auditLog(req, "APPOINTMENT_LWBS_MARK", "appointment", updated.id, {
        reason: req.body.reason,
      }).catch(console.error);

      res.json({ success: true, data: updated, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// ─── Pearl ERP Stage 1 §2.1.7 — threaded appointment remarks ──────────
//
// What / which modules / why:
//   - Replaces Appointment.notes (single string) with a multi-author
//     conversation under the AppointmentRemark model (#20260520000004).
//   - Visibility model: ALL_STAFF (default), DOCTOR_ONLY, RECEPTION_ONLY,
//     PRIVATE. PATIENT role never reaches these handlers (no
//     Role.PATIENT in authorize()).
//   - Threading via parentRemarkId; replies inherit the parent's
//     visibility at write time so a PRIVATE thread can't leak via reply.
//   - Pinning is DOCTOR/ADMIN-only (only those roles drive triage of
//     "what's the latest important note on this case").
//   - Audited via auditLog() — every create/edit/delete/pin emits a
//     row keyed by entity=appointment_remark for greppability.

const REMARK_VISIBILITY_TO_ROLES: Record<
  (typeof appointmentRemarkVisibilityValues)[number] | string,
  Set<string>
> = {
  ALL_STAFF: new Set([
    Role.ADMIN,
    Role.DOCTOR,
    Role.NURSE,
    Role.RECEPTION,
    Role.PHARMACIST,
    Role.LAB_TECH,
  ]),
  DOCTOR_ONLY: new Set([Role.ADMIN, Role.DOCTOR]),
  RECEPTION_ONLY: new Set([Role.ADMIN, Role.RECEPTION]),
  PRIVATE: new Set([Role.ADMIN]), // + author override checked at runtime
};

// Whether the caller is allowed to read a remark of the given visibility.
// PRIVATE-scoped remarks are visible to the author and ADMIN; everything
// else is role-keyed via the table above.
function canViewRemark(
  visibility: string,
  role: string,
  isAuthor: boolean,
): boolean {
  if (isAuthor) return true;
  const roles = REMARK_VISIBILITY_TO_ROLES[visibility];
  if (!roles) return false;
  return roles.has(role);
}

// POST /api/v1/appointments/:id/remarks — create a remark
router.post(
  "/:id/remarks",
  authorize(
    Role.ADMIN,
    Role.DOCTOR,
    Role.NURSE,
    Role.RECEPTION,
    Role.PHARMACIST,
    Role.LAB_TECH,
  ),
  validate(createAppointmentRemarkSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const appt = await prisma.appointment.findUnique({
        where: { id: req.params.id },
        select: { id: true, tenantId: true },
      });
      if (!appt) {
        res.status(404).json({
          success: false,
          data: null,
          error: "Appointment not found",
        });
        return;
      }

      // Inherit parent's visibility on a reply so PRIVATE threads can't
      // leak via a child remark that picks a more-open scope.
      let visibility = req.body.visibility ?? "ALL_STAFF";
      if (req.body.parentRemarkId) {
        const parent = await prisma.appointmentRemark.findUnique({
          where: { id: req.body.parentRemarkId },
          select: { visibility: true, appointmentId: true },
        });
        if (!parent || parent.appointmentId !== appt.id) {
          res.status(400).json({
            success: false,
            data: null,
            error: "Parent remark does not belong to this appointment",
          });
          return;
        }
        visibility = parent.visibility;
      }

      const remark = await prisma.appointmentRemark.create({
        data: {
          appointmentId: appt.id,
          authorUserId: req.user!.userId,
          parentRemarkId: req.body.parentRemarkId ?? null,
          body: req.body.body.trim(),
          visibility,
          tenantId: req.tenantId ?? appt.tenantId,
        },
        include: {
          author: { select: { id: true, name: true, role: true } },
        },
      });

      auditLog(
        req,
        "APPOINTMENT_REMARK_CREATE",
        "appointment_remark",
        remark.id,
        {
          appointmentId: appt.id,
          visibility,
          parentRemarkId: req.body.parentRemarkId ?? null,
        },
      ).catch(console.error);

      res.status(201).json({ success: true, data: remark, error: null });
    } catch (err) {
      next(err);
    }
  },
);

// GET /api/v1/appointments/:id/remarks — list (viewer-filtered)
router.get(
  "/:id/remarks",
  authorize(
    Role.ADMIN,
    Role.DOCTOR,
    Role.NURSE,
    Role.RECEPTION,
    Role.PHARMACIST,
    Role.LAB_TECH,
  ),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const appt = await prisma.appointment.findUnique({
        where: { id: req.params.id },
        select: { id: true },
      });
      if (!appt) {
        res.status(404).json({
          success: false,
          data: null,
          error: "Appointment not found",
        });
        return;
      }

      const role = req.user!.role;
      const callerId = req.user!.userId;

      const all = await prisma.appointmentRemark.findMany({
        where: { appointmentId: appt.id },
        include: {
          author: { select: { id: true, name: true, role: true } },
        },
        // Pinned first, then newest first.
        orderBy: [{ isPinned: "desc" }, { createdAt: "desc" }],
      });

      const visible = all.filter((r) =>
        canViewRemark(r.visibility, role, r.authorUserId === callerId),
      );

      res.json({ success: true, data: visible, error: null });
    } catch (err) {
      next(err);
    }
  },
);

// PATCH /api/v1/appointments/:id/remarks/:remarkId — edit body (author-only)
router.patch(
  "/:id/remarks/:remarkId",
  authorize(
    Role.ADMIN,
    Role.DOCTOR,
    Role.NURSE,
    Role.RECEPTION,
    Role.PHARMACIST,
    Role.LAB_TECH,
  ),
  validate(updateAppointmentRemarkSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const remark = await prisma.appointmentRemark.findUnique({
        where: { id: req.params.remarkId },
        select: {
          id: true,
          appointmentId: true,
          authorUserId: true,
        },
      });
      if (!remark || remark.appointmentId !== req.params.id) {
        res
          .status(404)
          .json({ success: false, data: null, error: "Remark not found" });
        return;
      }

      const callerId = req.user!.userId;
      const role = req.user!.role;
      // Only the author can edit body (ADMIN can NOT edit someone else's
      // body — clinical-record integrity. ADMIN can DELETE though).
      if (remark.authorUserId !== callerId) {
        res.status(403).json({
          success: false,
          data: null,
          error: "Only the remark's author can edit its body",
        });
        return;
      }
      void role;

      const updated = await prisma.appointmentRemark.update({
        where: { id: remark.id },
        data: {
          body: req.body.body.trim(),
          editedAt: new Date(),
        },
        include: {
          author: { select: { id: true, name: true, role: true } },
        },
      });

      auditLog(
        req,
        "APPOINTMENT_REMARK_EDIT",
        "appointment_remark",
        updated.id,
        { appointmentId: req.params.id },
      ).catch(console.error);

      res.json({ success: true, data: updated, error: null });
    } catch (err) {
      next(err);
    }
  },
);

// DELETE /api/v1/appointments/:id/remarks/:remarkId — author + ADMIN
router.delete(
  "/:id/remarks/:remarkId",
  authorize(
    Role.ADMIN,
    Role.DOCTOR,
    Role.NURSE,
    Role.RECEPTION,
    Role.PHARMACIST,
    Role.LAB_TECH,
  ),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const remark = await prisma.appointmentRemark.findUnique({
        where: { id: req.params.remarkId },
        select: { id: true, appointmentId: true, authorUserId: true },
      });
      if (!remark || remark.appointmentId !== req.params.id) {
        res
          .status(404)
          .json({ success: false, data: null, error: "Remark not found" });
        return;
      }

      const callerId = req.user!.userId;
      const role = req.user!.role;
      if (
        remark.authorUserId !== callerId &&
        role !== Role.ADMIN &&
        role !== Role.SUPER_ADMIN
      ) {
        res.status(403).json({
          success: false,
          data: null,
          error: "Only the author or an ADMIN can delete this remark",
        });
        return;
      }

      await prisma.appointmentRemark.delete({ where: { id: remark.id } });

      auditLog(
        req,
        "APPOINTMENT_REMARK_DELETE",
        "appointment_remark",
        remark.id,
        { appointmentId: req.params.id, deletedBy: role },
      ).catch(console.error);

      res.status(204).end();
    } catch (err) {
      next(err);
    }
  },
);

// PATCH /api/v1/appointments/:id/remarks/:remarkId/pin — DOCTOR + ADMIN
router.patch(
  "/:id/remarks/:remarkId/pin",
  authorize(Role.ADMIN, Role.DOCTOR),
  validate(pinAppointmentRemarkSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const remark = await prisma.appointmentRemark.findUnique({
        where: { id: req.params.remarkId },
        select: { id: true, appointmentId: true },
      });
      if (!remark || remark.appointmentId !== req.params.id) {
        res
          .status(404)
          .json({ success: false, data: null, error: "Remark not found" });
        return;
      }

      const updated = await prisma.appointmentRemark.update({
        where: { id: remark.id },
        data: { isPinned: req.body.isPinned },
        include: {
          author: { select: { id: true, name: true, role: true } },
        },
      });

      auditLog(
        req,
        req.body.isPinned ? "APPOINTMENT_REMARK_PIN" : "APPOINTMENT_REMARK_UNPIN",
        "appointment_remark",
        updated.id,
        { appointmentId: req.params.id },
      ).catch(console.error);

      res.json({ success: true, data: updated, error: null });
    } catch (err) {
      next(err);
    }
  },
);

export { router as appointmentRouter };
