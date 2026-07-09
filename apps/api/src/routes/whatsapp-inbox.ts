// Pearl ERP Stage 1 §6.1 (gap row 167 — pieces 3j-iii + 3j-iv of 4).
//
// Reception-facing WhatsApp inbox endpoints — read + reply.
//
// What / which modules / why:
//   - List conversations + fetch a single conversation thread + mark-read
//     + status/assignee mutations + send OUTBOUND reply. All scoped to
//     the caller's tenant.
//   - Piece 3j-i shipped the per-tenant provider config; piece 3j-ii shipped
//     the unauthenticated inbound webhook that lands new
//     WhatsAppConversation + WhatsAppMessage rows. Piece 3j-iii (the four
//     read endpoints) exposes those rows to reception / doctors / nurses /
//     admins via /api/v1/wa/inbox. Piece 3j-iv adds the outbound reply
//     handler at POST /:id/messages.
//   - The WhatsApp models are NOT in the auto-scoped TENANT_SCOPED_MODELS
//     set in @medcore/db (the inbound webhook predated the scope wrapper),
//     so this router explicitly threads `tenantId: req.user.tenantId`
//     through every where-clause and update payload. Patient role is
//     denied — the inbox is staff-only.
//   - Audit rows:
//       WHATSAPP_CONVERSATION_READ    (POST /:id/read)
//       WHATSAPP_CONVERSATION_UPDATED (PATCH /:id)
//       WHATSAPP_OUTBOUND_SENT        (POST /:id/messages — piece 3j-iv)
//     are fire-and-forget via .catch(console.error) per the standard
//     pattern; PHI-safe — never the message body, never the full phone.
//   - Outbound send dispatches to services/whatsapp-providers.ts which
//     wraps Gupshup / WATI / AiSensei / Interakt / Meta. The route layer
//     persists the WhatsAppMessage(direction=OUTBOUND) row on success,
//     OR a FAILED row + 502 on provider error so the operator sees the
//     failure inline in the thread.

import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
// Multi-tenant: scoped client auto-filters reads + tags writes by tenantId
// for TENANT_SCOPED_MODELS (cross-tenant leak fix, 2026-06-11).
import { tenantScopedPrisma as prisma } from "@medcore/db";
import { Role } from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { auditLog } from "../middleware/audit";
import { decryptCredentials, resolveActiveCredentials } from "../services/whatsapp-crypto";
import { isIntegrationEnabled } from "../services/integration-flags";
import {
  sendOutboundMessage,
  type DecryptedProviderConfig,
  type ProviderName,
} from "../services/whatsapp-providers";

const router = Router();
router.use(authenticate);
router.use(authorize(Role.ADMIN, Role.RECEPTION, Role.DOCTOR, Role.NURSE));

function requireTenantId(req: Request, res: Response): string | null {
  const tenantId = req.user?.tenantId;
  if (!tenantId) {
    res.status(400).json({
      success: false,
      data: null,
      error: "WhatsApp inbox requires a tenant context",
    });
    return null;
  }
  return tenantId;
}

// ── Schemas ──────────────────────────────────────────────────────────

const listQuerySchema = z.object({
  status: z.enum(["OPEN", "SNOOZED", "CLOSED", "ALL"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().trim().min(1).max(64).optional(),
});

const threadQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  before: z.string().trim().min(1).max(64).optional(),
});

const patchConvoSchema = z
  .object({
    status: z.enum(["OPEN", "SNOOZED", "CLOSED"]).optional(),
    assignedToUserId: z.string().trim().min(1).max(64).nullable().optional(),
  })
  .refine((v) => v.status !== undefined || v.assignedToUserId !== undefined, {
    message: "At least one of status or assignedToUserId is required",
  });

// WhatsApp text-message hard cap is 4096 bytes; we keep an even 4096-char
// allowance for the inbox composer. Empty / whitespace-only replies rejected.
const sendReplySchema = z.object({
  body: z
    .string()
    .trim()
    .min(1, "Reply body cannot be empty")
    .max(4096, "Reply body exceeds 4096-character WhatsApp limit"),
});

function phoneSuffix(phone: string): string {
  return phone.length >= 4 ? phone.slice(-4) : phone;
}

// ── GET /conversations — list for the caller's tenant ───────────────
router.get(
  "/conversations",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = requireTenantId(req, res);
      if (!tenantId) return;

      const parsed = listQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({
          success: false,
          data: null,
          error: parsed.error.issues[0]?.message ?? "Invalid query",
        });
        return;
      }
      const { status, limit, cursor } = parsed.data;
      const take = limit ?? 30;

      // Default behaviour: when the caller omits `status`, the inbox should
      // surface only OPEN conversations — that's the reception triage queue.
      // SNOOZED / CLOSED rows still need to be reachable explicitly, hence
      // the `ALL` escape hatch. The integration test at
      // apps/api/src/test/integration/whatsapp-inbox.test.ts pins this
      // contract ("GET /conversations defaults to OPEN status and lists
      // tenant A's 2 open convos").
      const where: Record<string, unknown> = { tenantId };
      const effectiveStatus = status ?? "OPEN";
      if (effectiveStatus !== "ALL") where.status = effectiveStatus;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rows = await (prisma as any).whatsAppConversation.findMany({
        where,
        orderBy: [{ lastMessageAt: "desc" }, { createdAt: "desc" }],
        take: take + 1, // peek for cursor
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        include: {
          patient: {
            select: {
              id: true,
              mrNumber: true,
              user: { select: { id: true, name: true } },
            },
          },
          _count: { select: { messages: true } },
        },
      });

      const hasMore = rows.length > take;
      const page = hasMore ? rows.slice(0, take) : rows;
      const nextCursor = hasMore ? page[page.length - 1].id : null;

      res.json({
        success: true,
        data: {
          conversations: page,
          nextCursor,
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  },
);

// ── GET /conversations/:id — fetch one with messages ────────────────
router.get(
  "/conversations/:id",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = requireTenantId(req, res);
      if (!tenantId) return;

      const parsed = threadQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({
          success: false,
          data: null,
          error: parsed.error.issues[0]?.message ?? "Invalid query",
        });
        return;
      }
      const { limit, before } = parsed.data;
      const take = limit ?? 50;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const convo = await (prisma as any).whatsAppConversation.findFirst({
        where: { id: req.params.id, tenantId },
        include: {
          patient: {
            select: {
              id: true,
              mrNumber: true,
              user: { select: { id: true, name: true } },
            },
          },
        },
      });
      if (!convo) {
        res.status(404).json({
          success: false,
          data: null,
          error: "Conversation not found",
        });
        return;
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const messages = await (prisma as any).whatsAppMessage.findMany({
        where: {
          conversationId: convo.id,
          tenantId,
          ...(before ? { id: { lt: before } } : {}),
        },
        orderBy: { createdAt: "desc" },
        take: take + 1,
      });
      const hasMoreOlder = messages.length > take;
      const pageDesc = hasMoreOlder ? messages.slice(0, take) : messages;
      // Return chronological for the UI (oldest first).
      const ordered = [...pageDesc].reverse();
      const olderCursor = hasMoreOlder ? pageDesc[pageDesc.length - 1].id : null;

      res.json({
        success: true,
        data: {
          conversation: convo,
          messages: ordered,
          olderCursor,
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  },
);

// ── POST /conversations/:id/read — clear unread count ───────────────
router.post(
  "/conversations/:id/read",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = requireTenantId(req, res);
      if (!tenantId) return;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const convo = await (prisma as any).whatsAppConversation.findFirst({
        where: { id: req.params.id, tenantId },
        select: { id: true, unreadCount: true },
      });
      if (!convo) {
        res.status(404).json({
          success: false,
          data: null,
          error: "Conversation not found",
        });
        return;
      }

      const now = new Date();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (prisma as any).whatsAppMessage.updateMany({
        where: {
          conversationId: convo.id,
          tenantId,
          direction: "INBOUND",
          readAt: null,
        },
        data: { status: "READ", readAt: now },
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const updated = await (prisma as any).whatsAppConversation.update({
        where: { id: convo.id },
        data: { unreadCount: 0 },
        select: {
          id: true,
          unreadCount: true,
          status: true,
          updatedAt: true,
        },
      });

      auditLog(
        req,
        "WHATSAPP_CONVERSATION_READ",
        "whatsapp_conversation",
        convo.id,
        { previousUnreadCount: convo.unreadCount },
      ).catch(console.error);

      res.json({
        success: true,
        data: { conversation: updated },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  },
);

// ── PATCH /conversations/:id — update status / assignee ─────────────
router.patch(
  "/conversations/:id",
  validate(patchConvoSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = requireTenantId(req, res);
      if (!tenantId) return;

      const body = req.body as {
        status?: "OPEN" | "SNOOZED" | "CLOSED";
        assignedToUserId?: string | null;
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const convo = await (prisma as any).whatsAppConversation.findFirst({
        where: { id: req.params.id, tenantId },
        select: { id: true, status: true, assignedToUserId: true },
      });
      if (!convo) {
        res.status(404).json({
          success: false,
          data: null,
          error: "Conversation not found",
        });
        return;
      }

      const data: Record<string, unknown> = {};
      if (body.status !== undefined) data.status = body.status;
      if (body.assignedToUserId !== undefined) {
        data.assignedToUserId = body.assignedToUserId;
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const updated = await (prisma as any).whatsAppConversation.update({
        where: { id: convo.id },
        data,
        select: {
          id: true,
          status: true,
          assignedToUserId: true,
          updatedAt: true,
        },
      });

      auditLog(
        req,
        "WHATSAPP_CONVERSATION_UPDATED",
        "whatsapp_conversation",
        convo.id,
        {
          ...(body.status !== undefined
            ? { previousStatus: convo.status, status: body.status }
            : {}),
          ...(body.assignedToUserId !== undefined
            ? {
                previousAssignee: convo.assignedToUserId,
                assignedToUserId: body.assignedToUserId,
              }
            : {}),
        },
      ).catch(console.error);

      res.json({
        success: true,
        data: { conversation: updated },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  },
);

// ── POST /conversations/:id/messages — send an OUTBOUND reply ───────
// Piece 3j-iv: the reception inbox composer hits this. Persists the
// WhatsAppMessage(direction=OUTBOUND) row either with status=SENT (on
// successful provider dispatch) or status=FAILED (on provider error,
// surfacing the failure inline in the thread so the operator can retry).
router.post(
  "/conversations/:id/messages",
  validate(sendReplySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = requireTenantId(req, res);
      if (!tenantId) return;

      const { body } = req.body as { body: string };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const convo = await (prisma as any).whatsAppConversation.findFirst({
        where: { id: req.params.id, tenantId },
        select: { id: true, tenantId: true, phone: true },
      });
      if (!convo) {
        res.status(404).json({
          success: false,
          data: null,
          error: "Conversation not found",
        });
        return;
      }

      // Settings → Integrations master switch for WhatsApp.
      if (!(await isIntegrationEnabled(tenantId, "whatsapp"))) {
        res.status(503).json({
          success: false,
          data: null,
          error:
            "WhatsApp is turned off for this hospital. Enable it under Settings → Integrations.",
        });
        return;
      }

      // Load the per-tenant provider config; without it we can't dispatch.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const config = await (prisma as any).whatsAppConfig.findUnique({
        where: { tenantId },
        select: {
          provider: true,
          credentialsEncrypted: true,
          active: true,
        },
      });
      if (!config || !config.active || !config.credentialsEncrypted) {
        res.status(503).json({
          success: false,
          data: null,
          error:
            "WhatsApp not configured for this tenant. Go to Settings → WhatsApp.",
        });
        return;
      }

      let creds: DecryptedProviderConfig;
      try {
        // Active provider's creds from the per-provider vault (legacy flat ok).
        const active = resolveActiveCredentials(
          decryptCredentials(config.credentialsEncrypted),
          config.provider,
        );
        if (!active) throw new Error(`no creds for active provider ${config.provider}`);
        creds = active as DecryptedProviderConfig;
      } catch (e) {
        console.error("[wa-inbox reply] decrypt failed", e);
        res.status(503).json({
          success: false,
          data: null,
          error:
            "WhatsApp credentials could not be decrypted — re-save the provider config.",
        });
        return;
      }

      const provider = config.provider as ProviderName;

      try {
        const result = await sendOutboundMessage(
          provider,
          creds,
          convo.phone,
          body,
        );

        const now = result.sentAt;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const message = await (prisma as any).whatsAppMessage.create({
          data: {
            conversationId: convo.id,
            tenantId,
            direction: "OUTBOUND",
            body,
            status: "SENT",
            sentAt: now,
            providerMessageId: result.providerMessageId,
          },
        });

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (prisma as any).whatsAppConversation.update({
          where: { id: convo.id },
          data: { lastMessageAt: now },
        });

        auditLog(
          req,
          "WHATSAPP_OUTBOUND_SENT",
          "whatsapp_message",
          message.id,
          {
            provider,
            conversationId: convo.id,
            phoneSuffix: phoneSuffix(convo.phone),
            byUserId: req.user?.userId ?? null,
          },
        ).catch(console.error);

        res.status(201).json({
          success: true,
          data: { message },
          error: null,
        });
      } catch (err) {
        const reason =
          err instanceof Error ? err.message : String(err);
        // Persist a FAILED row so the operator sees it in the thread.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const failedMessage = await (prisma as any).whatsAppMessage.create({
          data: {
            conversationId: convo.id,
            tenantId,
            direction: "OUTBOUND",
            body,
            status: "FAILED",
            failedAt: new Date(),
            failureReason: reason.slice(0, 500),
          },
        });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (prisma as any).whatsAppConversation.update({
          where: { id: convo.id },
          data: { lastMessageAt: new Date() },
        });
        auditLog(
          req,
          "WHATSAPP_OUTBOUND_SENT",
          "whatsapp_message",
          failedMessage.id,
          {
            provider,
            conversationId: convo.id,
            phoneSuffix: phoneSuffix(convo.phone),
            byUserId: req.user?.userId ?? null,
            status: "FAILED",
          },
        ).catch(console.error);

        res.status(502).json({
          success: false,
          data: { message: failedMessage },
          error: `Provider send failed: ${reason}`,
        });
      }
    } catch (err) {
      next(err);
    }
  },
);

export { router as whatsappInboxRouter };
