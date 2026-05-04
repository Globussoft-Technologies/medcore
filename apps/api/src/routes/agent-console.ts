/**
 * Agent Console (PRD §3.5.6) — gives the call-center agent a dedicated
 * workstation for AI-Triage handoffs.
 *
 * When a patient taps "Talk to a person" inside the AI triage flow, the
 * `/api/v1/ai/triage/:sessionId/handoff` endpoint creates a one-on-one
 * ChatRoom between the patient and a RECEPTION/ADMIN user and persists the
 * room id on `AITriageSession.handoffChatRoomId`. The routes in this file
 * let the agent:
 *   - list all pending handoffs in the agent's tenant
 *   - pull the attached triage transcript + SOAP-style summary + top doctors
 *     so they can co-pilot the intake
 *   - drop a pre-templated doctor-suggestion message into the chat
 *   - mark a handoff resolved (archives the room + writes AuditLog)
 *
 * Auth: RECEPTION + ADMIN only. All mutations are audit-logged with
 * `AGENT_CONSOLE_*` actions for PRD §3.5.6 traceability.
 */
import { Router, Request, Response, NextFunction } from "express";
import { tenantScopedPrisma as prisma } from "../services/tenant-prisma";
import { Role } from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";
import { auditLog } from "../middleware/audit";

const router = Router();

// Agent console is strictly for reception + admin staff.
router.use(authenticate);
router.use(authorize(Role.RECEPTION, Role.ADMIN));
// #511 audit (2026-05-05, cron-tick): all handlers verified safe via
// router-level authorize() above — PATIENT is excluded fleet-wide for this
// file, so no per-row BOLA gap is reachable. No PATIENT-allowed handler
// override exists (grep confirms no Role.PATIENT references in this file).

/**
 * Best-effort audit wrapper: PHI audit writes must never take a GET response
 * down with them. If prisma is unavailable (e.g. transient DB blip), log a
 * warning and allow the request to complete.
 */
function safeAudit(
  req: Request,
  action: string,
  entity: string,
  entityId: string | undefined,
  details?: Record<string, unknown>
): void {
  auditLog(req, action, entity, entityId, details).catch((err) => {
    console.warn(
      `[audit] ${action} failed (non-fatal):`,
      (err as Error)?.message ?? err,
    );
  });
}

// ─── GET /api/v1/agent-console/handoffs ──────────────────────────────────
// Lists the active handoff ChatRooms (created by /ai/triage/:id/handoff)
// visible to the current tenant. Sorted by most-recent activity. Each row
// includes patient name, presenting complaint, language, time-since-handoff
// and an unread-message count for the logged-in agent.
router.get(
  "/handoffs",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user!.userId;

      // Only triage sessions that have actually been handed off to a ChatRoom
      // are of interest here. Tenant isolation is automatic because
      // AITriageSession is in the tenant-scoped model set.
      const sessions = await prisma.aITriageSession.findMany({
        where: {
          handoffChatRoomId: { not: null },
        },
        select: {
          id: true,
          language: true,
          chiefComplaint: true,
          symptoms: true,
          suggestedSpecialties: true,
          confidence: true,
          handoffChatRoomId: true,
          createdAt: true,
          updatedAt: true,
          patient: {
            select: {
              id: true,
              mrNumber: true,
              user: { select: { name: true } },
            },
          },
        },
        orderBy: { updatedAt: "desc" },
      });

      if (sessions.length === 0) {
        res.json({ success: true, data: [], error: null });
        return;
      }

      const roomIds = sessions
        .map((s) => s.handoffChatRoomId)
        .filter((id): id is string => !!id);

      // Pull rooms + last message in one trip; tenant scoping is automatic.
      const rooms = await prisma.chatRoom.findMany({
        where: { id: { in: roomIds } },
        include: {
          messages: {
            orderBy: { createdAt: "desc" },
            take: 1,
            include: {
              sender: { select: { id: true, name: true } },
            },
          },
          participants: {
            where: { leftAt: null },
            select: { userId: true },
          },
        },
      });
      const roomMap = new Map(rooms.map((r) => [r.id, r]));

      // Compute unread for *this* agent. Agents may not yet be participants;
      // we conservatively return 0 unread when they are not.
      const myParticipations = await prisma.chatParticipant.findMany({
        where: { userId, roomId: { in: roomIds } },
        select: { roomId: true, lastReadAt: true },
      });
      const lastReadMap = new Map(
        myParticipations.map((p) => [p.roomId, p.lastReadAt]),
      );

      const items = await Promise.all(
        sessions.map(async (s) => {
          const room = roomMap.get(s.handoffChatRoomId!);
          if (!room) return null;

          // A room is "resolved" once the agent archives it (see /resolve);
          // we mark resolution by prefixing the room name with [RESOLVED].
          // Those rooms stay queryable but are filtered out of the default
          // list so the agent's inbox shows only active work.
          const name = room.name ?? "";
          if (name.startsWith("[RESOLVED]")) return null;

          const lastReadAt = lastReadMap.get(room.id);
          const unreadWhere: Record<string, unknown> = {
            roomId: room.id,
            senderId: { not: userId },
          };
          if (lastReadAt) unreadWhere.createdAt = { gt: lastReadAt };
          const unreadCount = await prisma.chatMessage.count({
            where: unreadWhere,
          });

          const symptoms = (s.symptoms as any) ?? null;
          const presentingComplaint =
            s.chiefComplaint ||
            symptoms?.chiefComplaint ||
            "Not specified";

          const lastActivityAt =
            room.lastMessageAt ?? room.messages[0]?.createdAt ?? s.updatedAt;

          return {
            chatRoomId: room.id,
            sessionId: s.id,
            roomName: room.name,
            patient: s.patient
              ? {
                  id: s.patient.id,
                  name: s.patient.user?.name ?? "Unknown patient",
                  mrNumber: s.patient.mrNumber,
                }
              : null,
            presentingComplaint,
            language: s.language,
            confidence: s.confidence,
            handoffAt: s.updatedAt.toISOString(),
            lastActivityAt: lastActivityAt
              ? new Date(lastActivityAt).toISOString()
              : null,
            unreadCount,
            lastMessage: room.messages[0]
              ? {
                  id: room.messages[0].id,
                  content: room.messages[0].content,
                  createdAt: room.messages[0].createdAt.toISOString(),
                  senderName: room.messages[0].sender?.name ?? null,
                }
              : null,
          };
        }),
      );

      const active = items
        .filter((i): i is NonNullable<typeof i> => i !== null)
        .sort((a, b) => {
          const aAt = a.lastActivityAt ? Date.parse(a.lastActivityAt) : 0;
          const bAt = b.lastActivityAt ? Date.parse(b.lastActivityAt) : 0;
          return bAt - aAt;
        });

      safeAudit(req, "AGENT_CONSOLE_HANDOFFS_LIST", "AITriageSession", undefined, {
        count: active.length,
      });

      res.json({ success: true, data: active, error: null });
    } catch (err) {
      next(err);
    }
  },
);

// ─── GET /api/v1/agent-console/handoffs/:chatRoomId/context ─────────────
// Returns the AITriageSession attached to a handoff ChatRoom so the agent
// can see the full transcript, SOAP-style summary, top doctor suggestions
// and language — all in the AI co-pilot pane.
router.get(
  "/handoffs/:chatRoomId/context",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { chatRoomId } = req.params;

      const session = await prisma.aITriageSession.findFirst({
        where: { handoffChatRoomId: chatRoomId },
        include: {
          patient: {
            select: {
              id: true,
              mrNumber: true,
              dateOfBirth: true,
              gender: true,
              user: { select: { id: true, name: true, phone: true } },
            },
          },
        },
      });
      if (!session) {
        res.status(404).json({
          success: false,
          data: null,
          error: "No triage context for this chat room",
        });
        return;
      }

      // Pull matching doctors for the suggested specialties so the agent can
      // click "Suggest this doctor" directly from the co-pilot pane.
      let topDoctors: any[] = [];
      const suggested = (session.suggestedSpecialties as any[]) || [];
      if (suggested.length > 0) {
        const specialties = suggested.map((s: any) => s.specialty);
        const doctors = await prisma.doctor.findMany({
          where: {
            specialization: { in: specialties },
            user: { isActive: true },
          },
          include: {
            user: { select: { id: true, name: true, phone: true } },
          },
          take: 3,
        });
        topDoctors = doctors.map((d) => ({
          doctorId: d.id,
          name: d.user?.name ?? "Doctor",
          specialty: d.specialization,
          subSpecialty: d.subSpecialty,
          qualification: d.qualification,
          experienceYears: d.experienceYears ?? null,
          consultationFee: d.consultationFee ? Number(d.consultationFee) : null,
          reasoning:
            suggested.find((s: any) => s.specialty === d.specialization)
              ?.reasoning ?? null,
        }));
      }

      // Build a SOAP-style extract from the structured symptoms blob so the
      // agent sees the same shape the attending doctor will later receive.
      const symptoms = (session.symptoms as any) ?? {};
      const soap = {
        subjective: {
          chiefComplaint:
            session.chiefComplaint || symptoms.chiefComplaint || null,
          onset: symptoms.onset ?? null,
          duration: symptoms.duration ?? null,
          severity: typeof symptoms.severity === "number"
            ? symptoms.severity
            : null,
          associatedSymptoms: Array.isArray(symptoms.associatedSymptoms)
            ? symptoms.associatedSymptoms
            : [],
          relevantHistory: symptoms.relevantHistory ?? null,
        },
        objective: null,
        assessment: {
          suggestedSpecialties: suggested,
          confidence: session.confidence,
        },
        plan: null,
      };

      safeAudit(
        req,
        "AGENT_CONSOLE_HANDOFF_CONTEXT_READ",
        "AITriageSession",
        session.id,
        { chatRoomId },
      );

      res.json({
        success: true,
        data: {
          sessionId: session.id,
          chatRoomId,
          language: session.language,
          status: session.status,
          redFlagDetected: session.redFlagDetected,
          redFlagReason: session.redFlagReason,
          patient: session.patient
            ? {
                id: session.patient.id,
                mrNumber: session.patient.mrNumber,
                name: session.patient.user?.name ?? null,
                phone: session.patient.user?.phone ?? null,
                dateOfBirth: session.patient.dateOfBirth,
                gender: session.patient.gender,
              }
            : null,
          transcript: session.messages,
          soap,
          topDoctors,
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  },
);

// ─── POST /api/v1/agent-console/handoffs/:chatRoomId/suggest-doctor ─────
// Drops a pre-templated doctor-suggestion message into the chat. The
// template includes the doctor's name + specialty + (optional) slot
// information and a booking deep link so the patient can self-book.
router.post(
  "/handoffs/:chatRoomId/suggest-doctor",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { chatRoomId } = req.params;
      const { doctorId, slotId, date, slotStart, slotEnd } = req.body as {
        doctorId?: string;
        slotId?: string;
        date?: string;
        slotStart?: string;
        slotEnd?: string;
      };

      if (!doctorId || typeof doctorId !== "string") {
        res.status(400).json({
          success: false,
          data: null,
          error: "doctorId is required",
        });
        return;
      }

      // Confirm the chatroom exists + the session that backs it so we do not
      // leak into a random room.
      const session = await prisma.aITriageSession.findFirst({
        where: { handoffChatRoomId: chatRoomId },
        select: { id: true, language: true },
      });
      if (!session) {
        res.status(404).json({
          success: false,
          data: null,
          error: "No triage context for this chat room",
        });
        return;
      }

      const doctor = await prisma.doctor.findUnique({
        where: { id: doctorId },
        include: { user: { select: { name: true } } },
      });
      if (!doctor) {
        res.status(404).json({
          success: false,
          data: null,
          error: "Doctor not found",
        });
        return;
      }

      // Compose a bilingual-friendly templated message. We keep the body in
      // English by default (agents copy/paste to other systems) but append a
      // Hindi block when the triage session was conducted in Hindi so the
      // patient sees their language too.
      const slotLine =
        date && slotStart && slotEnd
          ? `Slot: ${date} ${slotStart}–${slotEnd}`
          : slotId
            ? `Slot reference: ${slotId}`
            : "Slot: will be confirmed";
      const bookingHint =
        `Booking link: /dashboard/ai-booking?doctorId=${doctor.id}` +
        (date ? `&date=${date}` : "") +
        (slotStart ? `&slotStart=${encodeURIComponent(slotStart)}` : "");

      const englishBody = [
        `Suggested doctor: Dr. ${doctor.user?.name ?? "—"}`,
        `Specialty: ${doctor.specialization}`,
        slotLine,
        bookingHint,
        ``,
        `Shall I confirm this appointment for you?`,
      ].join("\n");

      const hindiBody = [
        ``,
        `सुझाए गए डॉक्टर: डॉ. ${doctor.user?.name ?? "—"}`,
        `विशेषज्ञता: ${doctor.specialization}`,
        `क्या मैं यह अपॉइंटमेंट कन्फर्म कर दूँ?`,
      ].join("\n");

      const content =
        session.language === "hi" ? `${englishBody}${hindiBody}` : englishBody;

      const senderId = req.user!.userId;
      const msg = await prisma.chatMessage.create({
        data: {
          roomId: chatRoomId,
          senderId,
          content,
          type: "TEXT",
        },
        include: { sender: { select: { id: true, name: true, role: true } } },
      });

      await prisma.chatRoom.update({
        where: { id: chatRoomId },
        data: { lastMessageAt: new Date() },
      });

      // Notify the existing chat socket room so patient UIs pick it up.
      const io = req.app.get("io");
      if (io) {
        io.to(`chat:${chatRoomId}`).emit("chat:message", msg);
      }

      safeAudit(req, "AGENT_CONSOLE_SUGGEST_DOCTOR", "ChatRoom", chatRoomId, {
        doctorId,
        sessionId: session.id,
        slotId: slotId ?? null,
      });

      res.status(201).json({ success: true, data: msg, error: null });
    } catch (err) {
      next(err);
    }
  },
);

// ─── POST /api/v1/agent-console/handoffs/:chatRoomId/escalate ───────────
// Tags a doctor on the handoff so they can follow up. We represent the
// escalation as an @mention-style system message in the chat room (so it
// appears in the transcript and triggers a notification via the existing
// chat notification pipeline) — no schema changes required.
router.post(
  "/handoffs/:chatRoomId/escalate",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { chatRoomId } = req.params;
      const { doctorId, reason } = req.body as {
        doctorId?: string;
        reason?: string;
      };

      if (!doctorId || typeof doctorId !== "string") {
        res.status(400).json({
          success: false,
          data: null,
          error: "doctorId is required",
        });
        return;
      }

      const session = await prisma.aITriageSession.findFirst({
        where: { handoffChatRoomId: chatRoomId },
        select: { id: true },
      });
      if (!session) {
        res.status(404).json({
          success: false,
          data: null,
          error: "No triage context for this chat room",
        });
        return;
      }

      const doctor = await prisma.doctor.findUnique({
        where: { id: doctorId },
        include: { user: { select: { id: true, name: true } } },
      });
      if (!doctor) {
        res.status(404).json({
          success: false,
          data: null,
          error: "Doctor not found",
        });
        return;
      }

      const content =
        `[ESCALATION] Flagged to Dr. ${doctor.user?.name ?? "—"} ` +
        `(${doctor.specialization}) for follow-up` +
        (reason ? `: ${reason}` : ".");

      const senderId = req.user!.userId;
      const msg = await prisma.chatMessage.create({
        data: {
          roomId: chatRoomId,
          senderId,
          content,
          type: "TEXT",
          mentionIds: doctor.user?.id ?? null,
        },
        include: { sender: { select: { id: true, name: true, role: true } } },
      });

      await prisma.chatRoom.update({
        where: { id: chatRoomId },
        data: { lastMessageAt: new Date() },
      });

      const io = req.app.get("io");
      if (io) {
        io.to(`chat:${chatRoomId}`).emit("chat:message", msg);
      }

      safeAudit(req, "AGENT_CONSOLE_ESCALATE", "ChatRoom", chatRoomId, {
        doctorId,
        sessionId: session.id,
        reason: reason ?? null,
      });

      res.status(201).json({ success: true, data: msg, error: null });
    } catch (err) {
      next(err);
    }
  },
);

// ─── POST /api/v1/agent-console/handoffs/:chatRoomId/resolve ─────────────
// Marks the handoff room as resolved. Because the current Prisma schema
// has no archivedAt column on ChatRoom, we mark resolution by prefixing the
// room name with `[RESOLVED]` and writing a system message in the chat.
// The room stays readable for audit but disappears from the active list.
router.post(
  "/handoffs/:chatRoomId/resolve",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { chatRoomId } = req.params;
      const { note } = req.body as { note?: string };

      const session = await prisma.aITriageSession.findFirst({
        where: { handoffChatRoomId: chatRoomId },
        select: { id: true },
      });
      if (!session) {
        res.status(404).json({
          success: false,
          data: null,
          error: "No triage context for this chat room",
        });
        return;
      }

      const room = await prisma.chatRoom.findUnique({
        where: { id: chatRoomId },
      });
      if (!room) {
        res.status(404).json({
          success: false,
          data: null,
          error: "Chat room not found",
        });
        return;
      }

      const currentName = room.name ?? `Handoff ${chatRoomId.slice(0, 8)}`;
      const resolvedName = currentName.startsWith("[RESOLVED]")
        ? currentName
        : `[RESOLVED] ${currentName}`;

      // Mark the room resolved by prefixing the name; active-list filter
      // hides `[RESOLVED]` prefixed rooms from the agent inbox.
      await prisma.chatRoom.update({
        where: { id: chatRoomId },
        data: { name: resolvedName, lastMessageAt: new Date() },
      });

      const systemContent = note
        ? `[RESOLVED] Handoff marked resolved by agent: ${note}`
        : `[RESOLVED] Handoff marked resolved by agent.`;

      const senderId = req.user!.userId;
      await prisma.chatMessage.create({
        data: {
          roomId: chatRoomId,
          senderId,
          content: systemContent,
          type: "TEXT",
        },
      });

      await auditLog(
        req,
        "AGENT_CONSOLE_RESOLVE",
        "ChatRoom",
        chatRoomId,
        { sessionId: session.id, note: note ?? null },
      );

      res.json({
        success: true,
        data: { chatRoomId, resolvedName },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  },
);

export { router as agentConsoleRouter };
