import { Router, Request, Response, NextFunction } from "express";
import { prisma } from "@medcore/db";
import {
  NotificationChannel,
  Role,
  notificationTemplateSchema,
  notificationScheduleSchema,
  notificationBroadcastSchema,
} from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { auditLog } from "../middleware/audit";
import { isWithinQuietHours } from "../services/ops-helpers";
import { sendNotification, retryNotification } from "../services/notification";

const router = Router();
router.use(authenticate);

// GET /api/v1/notifications — list user's notifications (paginated)
router.get("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { page = "1", limit = "20", unreadOnly } = req.query;
    const skip = (parseInt(page as string) - 1) * parseInt(limit as string);
    const take = Math.min(parseInt(limit as string), 100);

    const where: Record<string, unknown> = { userId: req.user!.userId };
    if (unreadOnly === "true") {
      where.readAt = null;
    }

    const [notifications, total] = await Promise.all([
      prisma.notification.findMany({
        where,
        skip,
        take,
        orderBy: { createdAt: "desc" },
      }),
      prisma.notification.count({ where }),
    ]);

    res.json({
      success: true,
      data: notifications,
      error: null,
      meta: { page: parseInt(page as string), limit: take, total },
    });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/v1/notifications/:id/read — mark as read
router.patch(
  "/:id/read",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const notification = await prisma.notification.findUnique({
        where: { id: req.params.id },
      });

      if (!notification) {
        res.status(404).json({ success: false, data: null, error: "Notification not found" });
        return;
      }

      if (notification.userId !== req.user!.userId) {
        res.status(403).json({ success: false, data: null, error: "Forbidden" });
        return;
      }

      const updated = await prisma.notification.update({
        where: { id: req.params.id },
        data: { readAt: new Date() },
      });

      res.json({ success: true, data: updated, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/notifications/preferences — get user's channel preferences
router.get(
  "/preferences",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const preferences = await prisma.notificationPreference.findMany({
        where: { userId: req.user!.userId },
      });

      // If no preferences exist yet, return defaults (all enabled)
      if (preferences.length === 0) {
        const defaults = Object.values(NotificationChannel).map((channel) => ({
          userId: req.user!.userId,
          channel,
          enabled: true,
        }));

        res.json({ success: true, data: defaults, error: null });
        return;
      }

      res.json({ success: true, data: preferences, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// PUT /api/v1/notifications/preferences — update preferences
router.put(
  "/preferences",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { preferences } = req.body as {
        preferences: Array<{ channel: NotificationChannel; enabled: boolean }>;
      };

      if (!Array.isArray(preferences)) {
        res.status(400).json({
          success: false,
          data: null,
          error: "preferences must be an array of { channel, enabled }",
        });
        return;
      }

      const userId = req.user!.userId;

      // Upsert each preference
      const results = await Promise.all(
        preferences.map((pref) =>
          prisma.notificationPreference.upsert({
            where: {
              userId_channel: { userId, channel: pref.channel as any },
            },
            create: {
              userId,
              channel: pref.channel as any,
              enabled: pref.enabled,
            },
            update: {
              enabled: pref.enabled,
            },
          })
        )
      );

      res.json({ success: true, data: results, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// ═══════════════════════════════════════════════════════
// OPS ENHANCEMENTS: TEMPLATES, SCHEDULE, BROADCAST, DELIVERY
// ═══════════════════════════════════════════════════════

// GET /api/v1/notifications/templates
router.get(
  "/templates",
  authorize(Role.ADMIN),
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const templates = await prisma.notificationTemplate.findMany({
        orderBy: [{ type: "asc" }, { channel: "asc" }],
      });
      res.json({ success: true, data: templates, error: null });
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  "/templates",
  authorize(Role.ADMIN),
  validate(notificationTemplateSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = req.body;
      const t = await prisma.notificationTemplate.upsert({
        where: {
          type_channel: {
            type: body.type as any,
            channel: body.channel as any,
          },
        },
        update: {
          name: body.name,
          subject: body.subject,
          body: body.body,
          isActive: body.isActive,
        },
        create: {
          type: body.type as any,
          channel: body.channel as any,
          name: body.name,
          subject: body.subject,
          body: body.body,
          isActive: body.isActive,
        },
      });
      auditLog(req, "NOTIFICATION_TEMPLATE_UPSERT", "notification_template", t.id, body).catch(
        console.error
      );
      res.status(201).json({ success: true, data: t, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/notifications/schedule
router.get(
  "/schedule",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const sched = await prisma.notificationSchedule.findUnique({
        where: { userId: req.user!.userId },
      });
      res.json({ success: true, data: sched, error: null });
    } catch (err) {
      next(err);
    }
  }
);

router.put(
  "/schedule",
  validate(notificationScheduleSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user!.userId;
      const sched = await prisma.notificationSchedule.upsert({
        where: { userId },
        update: {
          quietHoursStart: req.body.quietHoursStart,
          quietHoursEnd: req.body.quietHoursEnd,
          dndUntil: req.body.dndUntil ? new Date(req.body.dndUntil) : null,
        },
        create: {
          userId,
          quietHoursStart: req.body.quietHoursStart,
          quietHoursEnd: req.body.quietHoursEnd,
          dndUntil: req.body.dndUntil ? new Date(req.body.dndUntil) : null,
        },
      });
      res.json({ success: true, data: sched, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/v1/notifications/broadcast — admin broadcast to audience
router.post(
  "/broadcast",
  authorize(Role.ADMIN),
  validate(notificationBroadcastSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { title, message, audience, channels } = req.body;
      const where: Record<string, unknown> = { isActive: true };
      const orFilters: any[] = [];
      if (audience.userIds && audience.userIds.length > 0) {
        orFilters.push({ id: { in: audience.userIds } });
      }
      if (audience.roles && audience.roles.length > 0) {
        orFilters.push({ role: { in: audience.roles } });
      }
      if (orFilters.length > 0) where.OR = orFilters;
      const users = await prisma.user.findMany({ where, select: { id: true } });

      let sentCount = 0;
      let failedCount = 0;
      const now = new Date();
      for (const u of users) {
        // Check quiet hours
        const sched = await prisma.notificationSchedule.findUnique({
          where: { userId: u.id },
        });
        let scheduledFor: Date | null = null;
        if (sched) {
          if (sched.dndUntil && sched.dndUntil > now) {
            scheduledFor = sched.dndUntil;
          } else if (
            isWithinQuietHours(now, sched.quietHoursStart, sched.quietHoursEnd)
          ) {
            // Send after quietHoursEnd
            if (sched.quietHoursEnd) {
              const [h, m] = sched.quietHoursEnd.split(":").map((n) => parseInt(n, 10));
              const d = new Date(now);
              d.setHours(h, m, 0, 0);
              if (d < now) d.setDate(d.getDate() + 1);
              scheduledFor = d;
            }
          }
        }
        for (const ch of channels) {
          try {
            await prisma.notification.create({
              data: {
                userId: u.id,
                type: "SCHEDULE_SUMMARY",
                channel: ch as any,
                title,
                message,
                data: { broadcast: true },
                deliveryStatus: scheduledFor ? "QUEUED" : "SENT",
                scheduledFor,
                sentAt: scheduledFor ? null : now,
              },
            });
            sentCount++;
          } catch (e) {
            failedCount++;
          }
        }
      }
      const broadcast = await prisma.notificationBroadcast.create({
        data: {
          title,
          message,
          audience: JSON.stringify({ ...audience, channels }),
          sentCount,
          failedCount,
          createdBy: req.user!.userId,
        },
      });
      auditLog(req, "BROADCAST", "notification_broadcast", broadcast.id, {
        sentCount,
        failedCount,
      }).catch(console.error);
      res.status(201).json({ success: true, data: broadcast, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/notifications/broadcasts
router.get(
  "/broadcasts",
  authorize(Role.ADMIN),
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const list = await prisma.notificationBroadcast.findMany({
        orderBy: { createdAt: "desc" },
        take: 50,
      });
      res.json({ success: true, data: list, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// PATCH /api/v1/notifications/:id/delivery — gateway callback to update delivery status
router.patch(
  "/:id/delivery",
  authorize(Role.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const status = (req.body.status as string) || "DELIVERED";
      if (!["QUEUED", "SENT", "DELIVERED", "READ", "FAILED"].includes(status)) {
        res.status(400).json({ success: false, data: null, error: "Invalid status" });
        return;
      }
      const n = await prisma.notification.update({
        where: { id: req.params.id },
        data: {
          deliveryStatus: status as any,
          deliveredAt:
            status === "DELIVERED" || status === "READ" ? new Date() : undefined,
          failureReason: req.body.failureReason,
        },
      });
      res.json({ success: true, data: n, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/notifications/stats — delivery metrics summary (admin)
router.get(
  "/stats",
  authorize(Role.ADMIN),
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const all = await prisma.notification.findMany({
        select: { deliveryStatus: true, channel: true, createdAt: true, readAt: true },
      });
      const byStatus: Record<string, number> = {
        QUEUED: 0, SENT: 0, DELIVERED: 0, READ: 0, FAILED: 0,
      };
      const byChannel: Record<string, number> = {};
      for (const n of all) {
        byStatus[n.deliveryStatus] = (byStatus[n.deliveryStatus] || 0) + 1;
        byChannel[n.channel] = (byChannel[n.channel] || 0) + 1;
      }
      const readCount = all.filter((n) => n.readAt).length;
      res.json({
        success: true,
        data: {
          total: all.length,
          byStatus,
          byChannel,
          readRate:
            all.length > 0 ? +((readCount / all.length) * 100).toFixed(1) : 0,
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// PUT /api/v1/notifications/templates/:id — admin update single template
router.put(
  "/templates/:id",
  authorize(Role.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { name, subject, body, isActive } = req.body as {
        name?: string;
        subject?: string;
        body?: string;
        isActive?: boolean;
      };
      const data: Record<string, unknown> = {};
      if (name !== undefined) data.name = name;
      if (subject !== undefined) data.subject = subject;
      if (body !== undefined) data.body = body;
      if (isActive !== undefined) data.isActive = isActive;
      const updated = await prisma.notificationTemplate.update({
        where: { id: req.params.id },
        data,
      });
      auditLog(req, "NOTIFICATION_TEMPLATE_UPDATE", "notification_template", updated.id, data).catch(
        console.error
      );
      res.json({ success: true, data: updated, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/notifications/delivery — admin delivery status viewer
router.get(
  "/delivery",
  authorize(Role.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { status, channel, from, to, limit = "100" } = req.query as Record<string, string>;
      const where: Record<string, unknown> = {};
      if (status) where.deliveryStatus = status;
      if (channel) where.channel = channel;
      if (from || to) {
        where.createdAt = {
          ...(from ? { gte: new Date(from) } : {}),
          ...(to ? { lte: new Date(to) } : {}),
        };
      }
      const list = await prisma.notification.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: Math.min(parseInt(limit, 10) || 100, 500),
        include: {
          user: { select: { id: true, name: true, email: true, phone: true } },
        },
      });
      res.json({ success: true, data: list, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/v1/notifications/:id/retry — admin retry of a failed notification
router.post(
  "/:id/retry",
  authorize(Role.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await retryNotification(req.params.id);
      auditLog(req, "NOTIFICATION_RETRY", "notification", req.params.id, { ...result }).catch(
        console.error
      );
      res.json({ success: result.ok, data: result, error: result.ok ? null : result.error });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/v1/notifications/test — fire a test notification on one channel
router.post(
  "/test",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { channel } = req.body as { channel?: string };
      if (!channel || !["WHATSAPP", "SMS", "EMAIL", "PUSH"].includes(channel)) {
        res.status(400).json({ success: false, data: null, error: "Invalid channel" });
        return;
      }

      // Temporarily bypass user preferences by inserting a one-off pref override:
      // we simply call sendNotification — the dispatcher will respect prefs, so
      // ensure the channel is enabled via a quick upsert before sending.
      await prisma.notificationPreference.upsert({
        where: {
          userId_channel: {
            userId: req.user!.userId,
            channel: channel as any,
          },
        },
        update: { enabled: true },
        create: {
          userId: req.user!.userId,
          channel: channel as any,
          enabled: true,
        },
      });

      await sendNotification({
        userId: req.user!.userId,
        type: "SCHEDULE_SUMMARY" as any,
        title: "MedCore Test Notification",
        message: `This is a test ${channel} notification from MedCore.`,
      });

      res.json({ success: true, data: { sent: true, channel }, error: null });
    } catch (err) {
      next(err);
    }
  }
);

export { router as notificationRouter };
