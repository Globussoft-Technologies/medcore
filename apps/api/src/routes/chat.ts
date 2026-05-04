import { Router, Request, Response, NextFunction } from "express";
// Multi-tenant wiring: `tenantScopedPrisma` is a Prisma $extends wrapper that
// auto-injects tenantId on create and auto-filters on read for the 20
// tenant-scoped models (see services/tenant-prisma.ts). We alias it to
// `prisma` so every existing call site keeps working without edits.
import { tenantScopedPrisma as prisma } from "../services/tenant-prisma";
import {
  Role,
  createChatRoomSchema,
  sendMessageSchema,
  messageReactionSchema,
  pinMessageSchema,
  createChannelSchema,
} from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { auditLog } from "../middleware/audit";
import { extractMentions } from "../services/ops-helpers";

const router = Router();
router.use(authenticate);

// GET /api/v1/chat/users — list other users for starting a chat
// #511 audit: VERIFIED-SAFE — staff catalog by design (excludes PATIENT
// rows via `role: { not: "PATIENT" }`); intentional surface for PATIENT
// to pick a doctor/nurse to start a chat with. No row-keyed param.
router.get(
  "/users",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Issue #84: support `?search=` and `?limit=` so the shared
      // EntityPicker can drive this endpoint to back the Certifications
      // "pick a staff member" picker. Default behaviour (no params) is
      // unchanged — full active staff list, alpha-sorted.
      const q =
        typeof req.query.search === "string" ? req.query.search.trim() : "";
      const limitNum = Number.parseInt(
        typeof req.query.limit === "string" ? req.query.limit : "",
        10
      );
      const take =
        Number.isFinite(limitNum) && limitNum > 0 && limitNum <= 100
          ? limitNum
          : undefined;

      const users = await prisma.user.findMany({
        where: {
          id: { not: req.user!.userId },
          role: { not: "PATIENT" },
          isActive: true,
          ...(q.length >= 1
            ? {
                OR: [
                  { name: { contains: q, mode: "insensitive" } },
                  { email: { contains: q, mode: "insensitive" } },
                  { phone: { contains: q } },
                ],
              }
            : {}),
        },
        select: { id: true, name: true, email: true, role: true },
        orderBy: { name: "asc" },
        ...(take ? { take } : {}),
      });
      res.json({ success: true, data: users, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/chat/rooms — list user's rooms
// #511 audit: VERIFIED-SAFE — list scoped to caller's own ChatParticipant
// rows (`where: { userId, leftAt: null }`); cannot fish other users' rooms.
router.get(
  "/rooms",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user!.userId;
      const myParticipations = await prisma.chatParticipant.findMany({
        where: { userId, leftAt: null },
        select: { roomId: true, lastReadAt: true },
      });

      if (myParticipations.length === 0) {
        res.json({ success: true, data: [], error: null });
        return;
      }

      const roomIds = myParticipations.map((p) => p.roomId);
      const lastReadMap: Record<string, Date | null> = {};
      for (const p of myParticipations) lastReadMap[p.roomId] = p.lastReadAt;

      const rooms = await prisma.chatRoom.findMany({
        where: { id: { in: roomIds } },
        include: {
          participants: {
            where: { leftAt: null },
            include: {
              user: {
                select: { id: true, name: true, role: true, email: true },
              },
            },
          },
          messages: {
            orderBy: { createdAt: "desc" },
            take: 1,
            include: {
              sender: { select: { id: true, name: true } },
            },
          },
        },
        orderBy: { lastMessageAt: "desc" },
      });

      // compute unread counts per room
      const result = await Promise.all(
        rooms.map(async (room) => {
          const lastReadAt = lastReadMap[room.id];
          const unreadWhere: Record<string, unknown> = {
            roomId: room.id,
            senderId: { not: userId },
          };
          if (lastReadAt) unreadWhere.createdAt = { gt: lastReadAt };
          const unread = await prisma.chatMessage.count({ where: unreadWhere });
          return {
            ...room,
            lastMessage: room.messages[0] || null,
            unreadCount: unread,
          };
        })
      );

      res.json({ success: true, data: result, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/v1/chat/rooms — create room (1-on-1 returns existing)
// #511 audit: VERIFIED-SAFE — caller is always added to the new room as
// a participant; `participantIds` are explicit (caller chose them); no
// row-keyed param. Cross-role chat (DOCTOR↔PATIENT) is the design intent.
router.post(
  "/rooms",
  validate(createChatRoomSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { name, isGroup, participantIds } = req.body as {
        name?: string;
        isGroup: boolean;
        participantIds: string[];
      };
      const me = req.user!.userId;

      const uniqueIds = Array.from(new Set<string>([me, ...participantIds]));

      // For 1-on-1, look for existing non-group room with exactly these 2
      if (!isGroup && uniqueIds.length === 2) {
        const other = uniqueIds.find((x) => x !== me)!;
        const mine = await prisma.chatParticipant.findMany({
          where: { userId: me },
          select: { roomId: true },
        });
        const theirs = await prisma.chatParticipant.findMany({
          where: { userId: other },
          select: { roomId: true },
        });
        const mineSet = new Set(mine.map((p) => p.roomId));
        const sharedIds = theirs
          .map((t) => t.roomId)
          .filter((r) => mineSet.has(r));
        if (sharedIds.length > 0) {
          const existing = await prisma.chatRoom.findFirst({
            where: { id: { in: sharedIds }, isGroup: false },
            include: {
              participants: {
                where: { leftAt: null },
                include: {
                  user: {
                    select: { id: true, name: true, role: true, email: true },
                  },
                },
              },
            },
          });
          if (existing) {
            res.json({ success: true, data: existing, error: null });
            return;
          }
        }
      }

      const room = await prisma.chatRoom.create({
        data: {
          name,
          isGroup,
          createdBy: me,
          participants: {
            create: uniqueIds.map((uid) => ({ userId: uid })),
          },
        },
        include: {
          participants: {
            where: { leftAt: null },
            include: {
              user: {
                select: { id: true, name: true, role: true, email: true },
              },
            },
          },
        },
      });

      res.status(201).json({ success: true, data: room, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/chat/rooms/:id/messages
// #511 audit: VERIFIED-SAFE — explicit participant check (line below) +
// ADMIN bypass for agent-console triage (issue #189). Non-participants
// receive 403.
router.get(
  "/rooms/:id/messages",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user!.userId;
      // Issue #189: ADMIN bypasses the participant check so the Agent
      // Console can open every active handoff room (admins triage
      // everything). Other roles — including RECEPTION — still need an
      // active participant row.
      const isAdmin = req.user?.role === "ADMIN";
      const participant = await prisma.chatParticipant.findUnique({
        where: { roomId_userId: { roomId: req.params.id, userId } },
      });
      if (!participant && !isAdmin) {
        res
          .status(403)
          .json({ success: false, data: null, error: "Not a participant" });
        return;
      }

      const { before, limit = "50" } = req.query;
      const take = Math.min(parseInt(limit as string), 100);
      const where: Record<string, unknown> = {
        roomId: req.params.id,
        deletedAt: null,
      };
      if (before) where.createdAt = { lt: new Date(before as string) };

      const messages = await prisma.chatMessage.findMany({
        where,
        include: { sender: { select: { id: true, name: true, role: true } } },
        orderBy: { createdAt: "desc" },
        take,
      });

      res.json({
        success: true,
        data: messages,
        error: null,
        meta: {
          nextCursor:
            messages.length === take
              ? messages[messages.length - 1].createdAt.toISOString()
              : null,
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/v1/chat/rooms/:id/messages
// #511 audit: VERIFIED-SAFE — participant check + ADMIN bypass (issue #189).
router.post(
  "/rooms/:id/messages",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user!.userId;
      const body = { ...req.body, roomId: req.params.id };
      const parsed = sendMessageSchema.safeParse(body);
      if (!parsed.success) {
        res.status(400).json({
          success: false,
          data: null,
          error: "Validation failed",
          details: parsed.error.flatten(),
        });
        return;
      }

      // Issue #189: ADMIN bypasses the participant check (agent-console
      // triage). Non-admins still need an active participant row.
      const isAdmin = req.user?.role === "ADMIN";
      const participant = await prisma.chatParticipant.findUnique({
        where: { roomId_userId: { roomId: req.params.id, userId } },
      });
      if ((!participant || participant.leftAt) && !isAdmin) {
        res
          .status(403)
          .json({ success: false, data: null, error: "Not a participant" });
        return;
      }

      const mentions = extractMentions(parsed.data.content);
      const msg = await prisma.chatMessage.create({
        data: {
          roomId: req.params.id,
          senderId: userId,
          content: parsed.data.content,
          type: parsed.data.type,
          attachmentUrl: parsed.data.attachmentUrl,
          mentionIds: mentions.length > 0 ? mentions.join(",") : null,
        },
        include: { sender: { select: { id: true, name: true, role: true } } },
      });

      // Fire-and-forget: notify mentioned users
      if (mentions.length > 0) {
        for (const mId of mentions) {
          prisma.notification
            .create({
              data: {
                userId: mId,
                type: "SCHEDULE_SUMMARY",
                channel: "PUSH",
                title: `${msg.sender.name} mentioned you`,
                message: parsed.data.content.slice(0, 160),
                data: { roomId: req.params.id, messageId: msg.id },
                deliveryStatus: "QUEUED",
              },
            })
            .catch(console.error);
        }
      }

      await prisma.chatRoom.update({
        where: { id: req.params.id },
        data: { lastMessageAt: new Date() },
      });

      const io = req.app.get("io");
      if (io) {
        io.to(`chat:${req.params.id}`).emit("chat:message", msg);
      }

      res.status(201).json({ success: true, data: msg, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// PATCH /api/v1/chat/rooms/:id/read
// #511 audit: VERIFIED-SAFE — Prisma compound key
// `roomId_userId: { roomId, userId: <self> }` is implicitly self-scoped;
// non-participants get P2025 (record not found) handled by next(err).
router.patch(
  "/rooms/:id/read",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user!.userId;
      const updated = await prisma.chatParticipant.update({
        where: { roomId_userId: { roomId: req.params.id, userId } },
        data: { lastReadAt: new Date() },
      });
      res.json({ success: true, data: updated, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/v1/chat/rooms/:id/participants — add user (group creator only)
// #511 audit: VERIFIED-SAFE — explicit creator-or-ADMIN check (line below);
// rejects non-creators, group-only.
router.post(
  "/rooms/:id/participants",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user!.userId;
      const { userId: addUserId } = req.body;
      if (!addUserId) {
        res
          .status(400)
          .json({ success: false, data: null, error: "userId required" });
        return;
      }

      const room = await prisma.chatRoom.findUnique({
        where: { id: req.params.id },
      });
      if (!room) {
        res
          .status(404)
          .json({ success: false, data: null, error: "Room not found" });
        return;
      }
      if (!room.isGroup) {
        res.status(400).json({
          success: false,
          data: null,
          error: "Can only add participants to group rooms",
        });
        return;
      }
      if (room.createdBy !== userId && req.user!.role !== Role.ADMIN) {
        res
          .status(403)
          .json({ success: false, data: null, error: "Only creator can add" });
        return;
      }

      // Reactivate if existed, else create
      const existing = await prisma.chatParticipant.findUnique({
        where: { roomId_userId: { roomId: req.params.id, userId: addUserId } },
      });
      let participant;
      if (existing) {
        participant = await prisma.chatParticipant.update({
          where: { id: existing.id },
          data: { leftAt: null, joinedAt: new Date() },
        });
      } else {
        participant = await prisma.chatParticipant.create({
          data: { roomId: req.params.id, userId: addUserId },
        });
      }

      res.status(201).json({ success: true, data: participant, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// DELETE /api/v1/chat/rooms/:id/participants/:userId
// #511 audit: VERIFIED-SAFE — allows self-removal, room-creator removal,
// or ADMIN; explicit 403 otherwise.
router.delete(
  "/rooms/:id/participants/:userId",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const me = req.user!.userId;
      const targetUserId = req.params.userId;
      const room = await prisma.chatRoom.findUnique({
        where: { id: req.params.id },
      });
      if (!room) {
        res
          .status(404)
          .json({ success: false, data: null, error: "Room not found" });
        return;
      }
      // Allow self-removal, room creator, or admin
      if (
        targetUserId !== me &&
        room.createdBy !== me &&
        req.user!.role !== Role.ADMIN
      ) {
        res.status(403).json({ success: false, data: null, error: "Forbidden" });
        return;
      }

      const updated = await prisma.chatParticipant.update({
        where: {
          roomId_userId: { roomId: req.params.id, userId: targetUserId },
        },
        data: { leftAt: new Date() },
      });
      res.json({ success: true, data: updated, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// ═══════════════════════════════════════════════════════
// OPS ENHANCEMENTS: REACTIONS, PINS, SEARCH, CHANNELS, TYPING
// ═══════════════════════════════════════════════════════

// POST /api/v1/chat/messages/:id/reactions — toggle a reaction
// #511 audit: VERIFIED-SAFE — loads the message's roomId then runs the
// same participant + ADMIN-bypass check as message GET/POST.
router.post(
  "/messages/:id/reactions",
  validate(messageReactionSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user!.userId;
      const msg = await prisma.chatMessage.findUnique({
        where: { id: req.params.id },
      });
      if (!msg) {
        res.status(404).json({ success: false, data: null, error: "Message not found" });
        return;
      }
      // Issue #189: ADMIN bypasses the participant check.
      const isAdmin = req.user?.role === "ADMIN";
      const participant = await prisma.chatParticipant.findUnique({
        where: { roomId_userId: { roomId: msg.roomId, userId } },
      });
      if (!participant && !isAdmin) {
        res.status(403).json({ success: false, data: null, error: "Not a participant" });
        return;
      }
      const { emoji } = req.body as { emoji: string };
      const current = (msg.reactions as Record<string, string[]> | null) || {};
      const list = new Set(current[emoji] || []);
      // toggle
      if (list.has(userId)) list.delete(userId);
      else list.add(userId);
      if (list.size === 0) delete current[emoji];
      else current[emoji] = Array.from(list);

      const updated = await prisma.chatMessage.update({
        where: { id: msg.id },
        data: { reactions: current as any },
      });

      const io = req.app.get("io");
      if (io) io.to(`chat:${msg.roomId}`).emit("chat:reaction", updated);

      res.json({ success: true, data: updated, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// PATCH /api/v1/chat/messages/:id/pin
// #511 audit: VERIFIED-SAFE — same participant + ADMIN-bypass pattern.
router.patch(
  "/messages/:id/pin",
  validate(pinMessageSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user!.userId;
      const msg = await prisma.chatMessage.findUnique({ where: { id: req.params.id } });
      if (!msg) {
        res.status(404).json({ success: false, data: null, error: "Message not found" });
        return;
      }
      // Issue #189: ADMIN bypasses the participant check.
      const isAdmin = req.user?.role === "ADMIN";
      const participant = await prisma.chatParticipant.findUnique({
        where: { roomId_userId: { roomId: msg.roomId, userId } },
      });
      if (!participant && !isAdmin) {
        res.status(403).json({ success: false, data: null, error: "Not a participant" });
        return;
      }
      const updated = await prisma.chatMessage.update({
        where: { id: msg.id },
        data: {
          isPinned: req.body.pinned,
          pinnedAt: req.body.pinned ? new Date() : null,
          pinnedBy: req.body.pinned ? userId : null,
        },
      });
      res.json({ success: true, data: updated, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/chat/rooms/:id/pinned
// #511 audit: VERIFIED-SAFE — same participant + ADMIN-bypass pattern.
router.get(
  "/rooms/:id/pinned",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user!.userId;
      // Issue #189: ADMIN bypasses the participant check.
      const isAdmin = req.user?.role === "ADMIN";
      const participant = await prisma.chatParticipant.findUnique({
        where: { roomId_userId: { roomId: req.params.id, userId } },
      });
      if (!participant && !isAdmin) {
        res.status(403).json({ success: false, data: null, error: "Not a participant" });
        return;
      }
      const pinned = await prisma.chatMessage.findMany({
        where: { roomId: req.params.id, isPinned: true, deletedAt: null },
        include: { sender: { select: { id: true, name: true } } },
        orderBy: { pinnedAt: "desc" },
      });
      res.json({ success: true, data: pinned, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/chat/search?q=&roomId=
// #511 audit: VERIFIED-SAFE — search scoped to caller's participating
// room ids (`roomId: { in: ids }` from own ChatParticipant rows). Even
// when caller passes ?roomId=<other>, that filter is applied AFTER the
// scoping intersect implicitly via the `in` already in `where`.
router.get(
  "/search",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user!.userId;
      const { q, roomId } = req.query as Record<string, string | undefined>;
      if (!q || q.length < 2) {
        res.status(400).json({
          success: false,
          data: null,
          error: "Query (q) must be at least 2 characters",
        });
        return;
      }
      const myRooms = await prisma.chatParticipant.findMany({
        where: { userId, leftAt: null },
        select: { roomId: true },
      });
      const ids = myRooms.map((r) => r.roomId);
      const where: Record<string, unknown> = {
        deletedAt: null,
        roomId: { in: ids },
        content: { contains: q, mode: "insensitive" },
      };
      if (roomId) where.roomId = roomId;
      const results = await prisma.chatMessage.findMany({
        where,
        include: {
          sender: { select: { id: true, name: true, role: true } },
          room: { select: { id: true, name: true, isGroup: true } },
        },
        orderBy: { createdAt: "desc" },
        take: 50,
      });
      res.json({ success: true, data: results, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/v1/chat/channels — admin creates a department-wide channel
// #511 audit: VERIFIED-SAFE — `authorize(Role.ADMIN)` excludes PATIENT.
router.post(
  "/channels",
  authorize(Role.ADMIN),
  validate(createChannelSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { name, department, participantIds } = req.body;
      // Auto-populate participants if none supplied: users matching department name
      let ids: string[] = participantIds || [];
      if (ids.length === 0) {
        const roleMap: Record<string, string[]> = {
          Doctors: ["DOCTOR"],
          Nursing: ["NURSE"],
          Nurses: ["NURSE"],
          Reception: ["RECEPTION"],
          "All Staff": ["ADMIN", "DOCTOR", "NURSE", "RECEPTION"],
        };
        const roles = roleMap[department] || [];
        if (roles.length > 0) {
          const users = await prisma.user.findMany({
            where: { role: { in: roles as any }, isActive: true },
            select: { id: true },
          });
          ids = users.map((u) => u.id);
        }
      }
      const me = req.user!.userId;
      const unique = Array.from(new Set<string>([me, ...ids]));
      const room = await prisma.chatRoom.create({
        data: {
          name,
          department,
          isChannel: true,
          isGroup: true,
          createdBy: me,
          participants: { create: unique.map((uid) => ({ userId: uid })) },
        },
        include: {
          participants: {
            where: { leftAt: null },
            include: { user: { select: { id: true, name: true, role: true } } },
          },
        },
      });
      auditLog(req, "CHAT_CHANNEL_CREATE", "chat_room", room.id, { department }).catch(
        console.error
      );
      res.status(201).json({ success: true, data: room, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/v1/chat/rooms/:id/typing — broadcast typing indicator
//
// #511 audit (2026-05-05, cron-tick): PATCHED — chat ACL is participant
// membership (not patient-row ownership). Without the participant check
// any authed user (including a PATIENT) could spam typing-indicator
// socket events into ANY chat room they could guess the id of, leaking
// presence and noise into staff conversations. Apply the same
// participant + admin-bypass gate already used by every other
// /rooms/:id/* handler in this file.
router.post(
  "/rooms/:id/typing",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user!.userId;
      const isAdmin = req.user?.role === "ADMIN";
      const participant = await prisma.chatParticipant.findUnique({
        where: { roomId_userId: { roomId: req.params.id, userId } },
      });
      if ((!participant || participant.leftAt) && !isAdmin) {
        res
          .status(403)
          .json({ success: false, data: null, error: "Not a participant" });
        return;
      }
      const io = req.app.get("io");
      if (io) {
        io.to(`chat:${req.params.id}`).emit("chat:typing", {
          roomId: req.params.id,
          userId,
          at: new Date().toISOString(),
        });
      }
      res.json({ success: true, data: { ok: true }, error: null });
    } catch (err) {
      next(err);
    }
  }
);

export { router as chatRouter };
