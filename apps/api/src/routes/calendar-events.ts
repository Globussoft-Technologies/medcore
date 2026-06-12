// Issue #718 (2026-05-08): admin-managed CalendarEvent CRUD. The
// /dashboard/calendar page now exposes a "+ New Event" button + click-
// to-create on date cells; both POST here. Six other event archetypes
// (appointments, surgery, telemedicine, ANC, follow-ups, shifts) are
// already plotted from their own owners — this is the catch-all for
// ad-hoc admin events that don't have a clinical home.
//
// RBAC: ADMIN/DOCTOR/RECEPTION can list + create + edit (the same set
// the calendar page renders the New-Event affordance for); read is
// open to every authed staff role. Patients are intentionally excluded
// — they only see their own appointments/telemed via existing routes.
//
// Audit: every mutation writes a CALENDAR_EVENT_<ACTION> row tagged
// with the calendarEvent id.
import { Router, Request, Response, NextFunction } from "express";
// Multi-tenant: scoped client auto-filters reads + tags writes by tenantId
// for TENANT_SCOPED_MODELS (cross-tenant leak fix, 2026-06-11).
import { tenantScopedPrisma as prisma } from "@medcore/db";
import {
  Role,
  createCalendarEventSchema,
  updateCalendarEventSchema,
} from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { auditLog } from "../middleware/audit";

const router = Router();
router.use(authenticate);

// GET /api/v1/calendar-events?from=YYYY-MM-DD&to=YYYY-MM-DD
router.get(
  "/",
  authorize(
    Role.ADMIN,
    Role.DOCTOR,
    Role.RECEPTION,
    Role.NURSE,
    Role.PHARMACIST,
    Role.LAB_TECH
  ),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { from, to, limit } = req.query as Record<string, string | undefined>;
      const where: Record<string, unknown> = {};
      if (from || to) {
        const range: Record<string, Date> = {};
        if (from) range.gte = new Date(`${from}T00:00:00.000Z`);
        if (to) range.lte = new Date(`${to}T23:59:59.999Z`);
        where.startAt = range;
      }
      const take = Math.min(Math.max(Number(limit) || 200, 1), 1000);
      const events = await prisma.calendarEvent.findMany({
        where,
        orderBy: { startAt: "asc" },
        take,
      });
      res.json({ success: true, data: events, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/calendar-events/:id
router.get(
  "/:id",
  authorize(
    Role.ADMIN,
    Role.DOCTOR,
    Role.RECEPTION,
    Role.NURSE,
    Role.PHARMACIST,
    Role.LAB_TECH
  ),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const event = await prisma.calendarEvent.findUnique({
        where: { id: req.params.id },
      });
      if (!event) {
        res
          .status(404)
          .json({ success: false, data: null, error: "Calendar event not found" });
        return;
      }
      res.json({ success: true, data: event, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/v1/calendar-events
router.post(
  "/",
  authorize(Role.ADMIN, Role.DOCTOR, Role.RECEPTION),
  validate(createCalendarEventSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = req.body as Record<string, unknown>;
      const event = await prisma.calendarEvent.create({
        data: {
          title: String(body.title),
          category: (body.category as string) ?? "OTHER",
          startAt: new Date(String(body.startAt)),
          endAt: new Date(String(body.endAt)),
          color: (body.color as string | undefined) ?? null,
          description: (body.description as string | undefined) ?? null,
          createdById: req.user?.userId ?? null,
        },
      });
      auditLog(
        req,
        "CALENDAR_EVENT_CREATE",
        "calendarEvent",
        event.id,
        body
      ).catch(console.error);
      res.status(201).json({ success: true, data: event, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// PATCH /api/v1/calendar-events/:id
router.patch(
  "/:id",
  authorize(Role.ADMIN, Role.DOCTOR, Role.RECEPTION),
  validate(updateCalendarEventSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const existing = await prisma.calendarEvent.findUnique({
        where: { id: req.params.id },
      });
      if (!existing) {
        res
          .status(404)
          .json({ success: false, data: null, error: "Calendar event not found" });
        return;
      }
      const body = req.body as Record<string, unknown>;
      const data: Record<string, unknown> = { ...body };
      if (typeof body.startAt === "string") data.startAt = new Date(body.startAt);
      if (typeof body.endAt === "string") data.endAt = new Date(body.endAt);
      const event = await prisma.calendarEvent.update({
        where: { id: req.params.id },
        data,
      });
      auditLog(
        req,
        "CALENDAR_EVENT_UPDATE",
        "calendarEvent",
        event.id,
        body
      ).catch(console.error);
      res.json({ success: true, data: event, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// DELETE /api/v1/calendar-events/:id
router.delete(
  "/:id",
  authorize(Role.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const existing = await prisma.calendarEvent.findUnique({
        where: { id: req.params.id },
      });
      if (!existing) {
        res
          .status(404)
          .json({ success: false, data: null, error: "Calendar event not found" });
        return;
      }
      await prisma.calendarEvent.delete({ where: { id: req.params.id } });
      auditLog(
        req,
        "CALENDAR_EVENT_DELETE",
        "calendarEvent",
        req.params.id,
        { id: req.params.id }
      ).catch(console.error);
      res.json({ success: true, data: { id: req.params.id }, error: null });
    } catch (err) {
      next(err);
    }
  }
);

export const calendarEventsRouter = router;
