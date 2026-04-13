import { Router, Request, Response, NextFunction } from "express";
import { prisma } from "@medcore/db";
import { NotificationChannel } from "@medcore/shared";
import { authenticate } from "../middleware/auth";

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

export { router as notificationRouter };
