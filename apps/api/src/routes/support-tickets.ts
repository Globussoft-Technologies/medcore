/**
 * Pearl-operator support inbox — Pearl ERP Stage 1 §8.5 (gap row 223
 * closure, 2026-05-23).
 *
 * What / which modules / why:
 *   - Orthogonal channel to the existing patient→hospital `Complaint` flow.
 *     Tenant-ADMINs raise tickets against the Pearl operator (super-admin)
 *     team; the operator triages, assigns, replies, and resolves via the
 *     /super-admin/support UI (Pearl §8.5).
 *   - Mounts at /api/v1/support-tickets. Endpoints:
 *       POST   /                 — open a new ticket (ADMIN-only).
 *       GET    /                 — list (tenant-scoped for tenant ADMINs,
 *                                 cross-tenant for super-admins).
 *       GET    /:id              — detail + ordered message thread.
 *       POST   /:id/messages     — append a reply; flips ticket status.
 *       PATCH  /:id              — super-admin only: assign / status /
 *                                 priority changes.
 *   - Audit actions: SUPPORT_TICKET_OPENED / SUPPORT_TICKET_MESSAGE_ADDED /
 *     SUPPORT_TICKET_UPDATED. All writes use the awaited `auditLog()`
 *     middleware (NOT `safeAudit`) so integration tests can read AuditLog
 *     immediately after the request resolves.
 *   - RBAC: opening + per-tenant viewing requires Role.ADMIN. Status /
 *     priority / assignee changes require super-admin (ADMIN with
 *     tenantId == null OR tenantId on the seeded "default" tenant). Tenant
 *     ADMINs reading another tenant's ticket get 403.
 */

import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
// NOT tenant-scoped: this route deliberately serves BOTH tenant ADMINs
// (own-tenant) AND super-admins (cross-tenant operator inbox), so it does its
// own tenant filtering and stays on the base client. SupportTicket is
// intentionally absent from TENANT_SCOPED_MODELS for this reason.
import { prisma } from "@medcore/db";
import { Role } from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { auditLog } from "../middleware/audit";
import { resolveSlaForTicket } from "../services/support-ticket-sla";

const router = Router();

// ─── Guards ──────────────────────────────────────────────────────────

/**
 * Decide whether the caller is a super-admin (cross-tenant operator).
 * Mirrors `routes/tenants.ts:requireSuperAdmin`: tenant-less ADMINs and
 * ADMINs on the seeded "default" tenant are super-admins. Returns false
 * for any other caller; this is a pure decision helper used inline by
 * handlers that have different behaviour for the two ADMIN flavours.
 */
async function isCallerSuperAdmin(req: Request): Promise<boolean> {
  // Pearl §8.2 — Role.SUPER_ADMIN is a wildcard "root" role: always a
  // super-admin, regardless of tenant binding.
  if (req.user?.role === Role.SUPER_ADMIN) return true;
  if (req.user?.role !== Role.ADMIN) return false;
  const callerTenantId = req.user?.tenantId ?? null;
  if (callerTenantId == null) return true;
  const callerTenant = await prisma.tenant.findUnique({
    where: { id: callerTenantId },
    select: { subdomain: true },
  });
  return callerTenant?.subdomain === "default";
}

/**
 * Express middleware variant of `isCallerSuperAdmin` — used by PATCH /:id
 * which is super-admin-only.
 */
async function requireSuperAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    if (await isCallerSuperAdmin(req)) {
      return next();
    }
    res.status(403).json({
      success: false,
      data: null,
      error: "Only super-admins can modify ticket status / priority / assignee",
    });
    return;
  } catch (err) {
    next(err);
    return;
  }
}

// ─── Schemas ─────────────────────────────────────────────────────────

const statusEnum = z.enum([
  "OPEN",
  "AWAITING_TENANT",
  "IN_PROGRESS",
  "RESOLVED",
  "CLOSED",
]);

const priorityEnum = z.enum(["LOW", "NORMAL", "HIGH", "URGENT"]);

const createTicketSchema = z.object({
  subject: z.string().trim().min(3).max(200),
  body: z.string().trim().min(3).max(8000),
  priority: priorityEnum.optional(),
});

const listQuerySchema = z.object({
  status: statusEnum.optional(),
  priority: priorityEnum.optional(),
  // Super-admin-only filter; silently ignored for tenant ADMINs (who are
  // already pinned to their own tenant).
  tenantId: z.string().trim().min(1).max(64).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.string().trim().min(1).max(64).optional(),
});

const addMessageSchema = z.object({
  body: z.string().trim().min(1).max(8000),
});

const patchTicketSchema = z
  .object({
    status: statusEnum.optional(),
    priority: priorityEnum.optional(),
    assignedToUserId: z.string().trim().min(1).max(64).nullable().optional(),
  })
  .refine(
    (val) =>
      val.status !== undefined ||
      val.priority !== undefined ||
      val.assignedToUserId !== undefined,
    { message: "At least one of status / priority / assignedToUserId required" },
  );

// ─── Routes ──────────────────────────────────────────────────────────

router.use(authenticate);
router.use(authorize(Role.ADMIN));

// POST /api/v1/support-tickets — open a new ticket.
router.post(
  "/",
  validate(createTicketSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = req.body as z.infer<typeof createTicketSchema>;
      // tenantId comes off the caller's JWT. Super-admins with no tenant
      // can also file tickets (stored with tenantId=null — represents an
      // internal-only ticket).
      const tenantId = req.user?.tenantId ?? null;
      const priority = (body.priority ?? "NORMAL") as
        | "LOW"
        | "NORMAL"
        | "HIGH"
        | "URGENT";
      // Pearl §8.5 — compute the SLA deadline from the tenant's plan +
      // ticket priority. Persists `slaDueAt` + `slaPlan` so the operator
      // UI can render the deadline / sort the queue by it.
      const sla = await resolveSlaForTicket(prisma, tenantId, priority);
      // Cast required until `prisma generate` re-runs on the dev box
      // (DLL lock by running dev server). DB columns exist via db push.
      const ticket = await prisma.supportTicket.create({
        data: {
          tenantId,
          openedByUserId: req.user!.userId,
          subject: body.subject,
          body: body.body,
          priority,
          status: "OPEN",
          slaDueAt: sla.slaDueAt,
          slaPlan: sla.slaPlan,
        } as never,
      });
      await auditLog(
        req,
        "SUPPORT_TICKET_OPENED",
        "support_ticket",
        ticket.id,
        {
          tenantId: ticket.tenantId,
          subject: ticket.subject,
          priority: ticket.priority,
          slaPlan: sla.slaPlan,
          slaHours: sla.slaHours,
        },
      );
      res.status(201).json({
        success: true,
        data: ticket,
        error: null,
      });
    } catch (err) {
      next(err);
    }
  },
);

// GET /api/v1/support-tickets — list. Tenant ADMINs see own-tenant rows;
// super-admins see everything, optionally filtered by tenantId.
router.get(
  "/",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = listQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({
          success: false,
          data: null,
          error: parsed.error.issues[0]?.message ?? "Invalid query",
        });
        return;
      }
      const { status, priority, tenantId, limit, cursor } = parsed.data;
      const superAdmin = await isCallerSuperAdmin(req);
      const where: Record<string, unknown> = {};
      if (status) where.status = status;
      if (priority) where.priority = priority;
      if (superAdmin) {
        if (tenantId) where.tenantId = tenantId;
      } else {
        // Tenant ADMIN — hard-pin to own tenant. Silently ignore any
        // tenantId query param (don't 400 — Pearl gap docs explicitly
        // call out the silent-ignore pattern for cross-tenant query
        // probes).
        where.tenantId = req.user?.tenantId ?? null;
      }
      const take = limit ?? 50;
      const rows = await prisma.supportTicket.findMany({
        where,
        orderBy: { updatedAt: "desc" },
        take: take + 1,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        include: {
          tenant: { select: { id: true, name: true, subdomain: true } },
          openedBy: { select: { id: true, name: true, email: true } },
          assignedTo: { select: { id: true, name: true, email: true } },
        },
      });
      const hasMore = rows.length > take;
      const slice = hasMore ? rows.slice(0, take) : rows;
      res.status(200).json({
        success: true,
        data: {
          tickets: slice,
          nextCursor: hasMore ? (slice[slice.length - 1]?.id ?? null) : null,
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  },
);

// GET /api/v1/support-tickets/:id — detail + messages (ASC by createdAt).
router.get(
  "/:id",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const ticket = await prisma.supportTicket.findUnique({
        where: { id: req.params.id },
        include: {
          tenant: { select: { id: true, name: true, subdomain: true } },
          openedBy: { select: { id: true, name: true, email: true } },
          assignedTo: { select: { id: true, name: true, email: true } },
          messages: {
            orderBy: { createdAt: "asc" },
            include: {
              author: { select: { id: true, name: true, email: true, role: true } },
            },
          },
        },
      });
      if (!ticket) {
        res.status(404).json({
          success: false,
          data: null,
          error: "Support ticket not found",
        });
        return;
      }
      // Per-row scoping: tenant ADMINs can only read their own tenant's
      // tickets. Super-admins see everything.
      const superAdmin = await isCallerSuperAdmin(req);
      if (
        !superAdmin &&
        ticket.tenantId !== (req.user?.tenantId ?? null)
      ) {
        res.status(403).json({
          success: false,
          data: null,
          error: "Cross-tenant ticket access denied",
        });
        return;
      }
      res.status(200).json({
        success: true,
        data: ticket,
        error: null,
      });
    } catch (err) {
      next(err);
    }
  },
);

// POST /api/v1/support-tickets/:id/messages — append a reply.
// Tenant ADMIN reply flips status → OPEN (the operator now owes a reply).
// Super-admin reply flips status → AWAITING_TENANT (the tenant now owes
// a reply). updatedAt always bumps.
router.post(
  "/:id/messages",
  validate(addMessageSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const ticket = await prisma.supportTicket.findUnique({
        where: { id: req.params.id },
        select: { id: true, tenantId: true, status: true },
      });
      if (!ticket) {
        res.status(404).json({
          success: false,
          data: null,
          error: "Support ticket not found",
        });
        return;
      }
      const superAdmin = await isCallerSuperAdmin(req);
      if (
        !superAdmin &&
        ticket.tenantId !== (req.user?.tenantId ?? null)
      ) {
        res.status(403).json({
          success: false,
          data: null,
          error: "Cross-tenant ticket access denied",
        });
        return;
      }
      // RESOLVED / CLOSED tickets reject new messages — surface a 409 so
      // the UI can show a clear "reopen first" affordance rather than
      // silently swallowing the post.
      if (ticket.status === "RESOLVED" || ticket.status === "CLOSED") {
        res.status(409).json({
          success: false,
          data: null,
          error: `Cannot post to a ${ticket.status} ticket; reopen first`,
        });
        return;
      }
      const body = req.body as z.infer<typeof addMessageSchema>;
      const nextStatus = superAdmin ? "AWAITING_TENANT" : "OPEN";
      const message = await prisma.supportTicketMessage.create({
        data: {
          ticketId: ticket.id,
          authorUserId: req.user!.userId,
          body: body.body,
        },
      });
      const updated = await prisma.supportTicket.update({
        where: { id: ticket.id },
        data: { status: nextStatus },
      });
      await auditLog(
        req,
        "SUPPORT_TICKET_MESSAGE_ADDED",
        "support_ticket",
        ticket.id,
        {
          messageId: message.id,
          authorRole: superAdmin ? "SUPER_ADMIN" : "TENANT_ADMIN",
          newStatus: nextStatus,
        },
      );
      res.status(201).json({
        success: true,
        data: { message, ticket: updated },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  },
);

// PATCH /api/v1/support-tickets/:id — super-admin only. Update any combination
// of status / priority / assignedToUserId. Setting status to RESOLVED also
// stamps resolvedAt; clearing it (re-opening) clears resolvedAt.
router.patch(
  "/:id",
  requireSuperAdmin,
  validate(patchTicketSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const ticket = (await prisma.supportTicket.findUnique({
        where: { id: req.params.id },
        select: {
          id: true,
          status: true,
          tenantId: true,
          priority: true,
          slaPlan: true,
        } as never,
      })) as
        | {
            id: string;
            status: string;
            tenantId: string | null;
            priority: "LOW" | "NORMAL" | "HIGH" | "URGENT";
            slaPlan: string | null;
          }
        | null;
      if (!ticket) {
        res.status(404).json({
          success: false,
          data: null,
          error: "Support ticket not found",
        });
        return;
      }
      const body = req.body as z.infer<typeof patchTicketSchema>;

      // If an assignee was provided, sanity-check they exist (and pull
      // their name for the audit row — avoids cluttering the JSON with
      // null after the fact).
      if (body.assignedToUserId) {
        const assignee = await prisma.user.findUnique({
          where: { id: body.assignedToUserId },
          select: { id: true },
        });
        if (!assignee) {
          res.status(400).json({
            success: false,
            data: null,
            error: "assignedToUserId does not refer to an existing user",
          });
          return;
        }
      }

      const data: Record<string, unknown> = {};
      if (body.status !== undefined) {
        data.status = body.status;
        if (body.status === "RESOLVED" || body.status === "CLOSED") {
          data.resolvedAt = new Date();
        } else if (
          ticket.status === "RESOLVED" ||
          ticket.status === "CLOSED"
        ) {
          // Re-opening — clear the resolvedAt stamp.
          data.resolvedAt = null;
        }
      }
      if (body.priority !== undefined) {
        data.priority = body.priority;
        // Pearl §8.5 — priority changes re-anchor the SLA from NOW so a
        // legitimate URGENT escalation gets the matching shorter
        // deadline. Plan is read from the existing slaPlan stamp (or
        // re-resolved if the ticket pre-dates the SLA fields).
        const sla = ticket.slaPlan
          ? {
              slaDueAt: new Date(
                Date.now() +
                  // Re-use the helper so all SLA computation paths
                  // share one source of truth.
                  (
                    await resolveSlaForTicket(prisma,
                      ticket.tenantId,
                      body.priority,
                    )
                  ).slaHours *
                    60 *
                    60 *
                    1000,
              ),
              slaPlan: ticket.slaPlan,
            }
          : await resolveSlaForTicket(prisma, ticket.tenantId, body.priority);
        data.slaDueAt = sla.slaDueAt;
        data.slaPlan = sla.slaPlan;
      }
      if (body.assignedToUserId !== undefined) {
        data.assignedToUserId = body.assignedToUserId;
      }

      const updated = await prisma.supportTicket.update({
        where: { id: ticket.id },
        data,
      });
      await auditLog(
        req,
        "SUPPORT_TICKET_UPDATED",
        "support_ticket",
        ticket.id,
        {
          changed: Object.keys(data),
          newStatus: updated.status,
          newPriority: updated.priority,
          newAssignee: updated.assignedToUserId,
        },
      );
      res.status(200).json({
        success: true,
        data: updated,
        error: null,
      });
    } catch (err) {
      next(err);
    }
  },
);

export const supportTicketsRouter = router;
