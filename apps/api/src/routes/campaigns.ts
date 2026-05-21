/**
 * Campaign CRUD API — Pearl ERP Stage 1 gap item #4 (piece 1 of 4).
 *
 * What / which modules / why:
 *   - Pearl PRD §5.1 mandates a richer Campaign engine than the existing
 *     single-shot NotificationBroadcast (drip / trigger / cohort, 4-channel
 *     fan-out, send-window respect, A/B variants, conversion attribution).
 *   - The Campaign + CampaignSend + CampaignAudience schemas shipped in
 *     migration `20260520000012_pearl_campaign_engine_schema`. This file is
 *     the HTTP surface for the schema-only piece 1: create / list / get /
 *     update / soft-cancel a Campaign, plus a stubbed preview endpoint that
 *     will return real estimated recipients once the piece-2 audience
 *     compiler ships.
 *   - 6 endpoints, all ADMIN-gated (operators manage Campaigns; the public
 *     does not). tenantId is resolved from auth context (mirrors
 *     branches.ts), never accepted in the request body.
 *
 * State machine (operator-initiated transitions only — dispatcher transitions
 * SCHEDULED→RUNNING and *→COMPLETED ship in piece 2):
 *   DRAFT     → SCHEDULED | CANCELLED
 *   SCHEDULED → DRAFT     | CANCELLED
 *   RUNNING   → PAUSED    | CANCELLED
 *   PAUSED    → RUNNING   | CANCELLED
 *   COMPLETED → (terminal — 409)
 *   CANCELLED → (terminal — 409)
 *
 * Audit:
 *   - CAMPAIGN_CREATE / CAMPAIGN_UPDATE / CAMPAIGN_CANCEL on entity="campaign".
 *     Uses `auditLog(...).catch(console.error)` per the project safe-audit
 *     convention (CLAUDE.md gotcha #1).
 */

import { Router, Request, Response, NextFunction } from "express";
import { prisma } from "@medcore/db";
import {
  Role,
  createCampaignSchema,
  updateCampaignSchema,
  OPERATOR_STATUS_TRANSITIONS,
} from "@medcore/shared";
import type {
  AudienceRules,
  CreateCampaignInput,
  UpdateCampaignInput,
} from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { auditLog } from "../middleware/audit";
import { compileAudience } from "../services/audience-compiler";
import {
  dispatchCampaign,
  isWithinSendWindow,
  nextSendWindowStart,
} from "../services/campaign-dispatcher";

const router = Router();
router.use(authenticate);

// Mirror branches.ts:resolveTenantId — chain: req.tenantId → caller's
// User.tenantId → default tenant by subdomain.
async function resolveTenantId(req: Request): Promise<string | undefined> {
  let tenantId = req.tenantId;
  if (!tenantId) {
    const userTenant = await prisma.user.findUnique({
      where: { id: req.user!.userId },
      select: { tenantId: true },
    });
    tenantId = userTenant?.tenantId ?? undefined;
  }
  if (!tenantId) {
    const defaultTenant = await prisma.tenant.findUnique({
      where: { subdomain: "default" },
      select: { id: true },
    });
    tenantId = defaultTenant?.id ?? undefined;
  }
  return tenantId;
}

// ── POST / — create campaign (ADMIN) ──────────────────────────────────
router.post(
  "/",
  authorize(Role.ADMIN),
  validate(createCampaignSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = await resolveTenantId(req);
      if (!tenantId) {
        res.status(400).json({
          success: false,
          data: null,
          error: "No tenant context — campaigns require a tenant.",
        });
        return;
      }

      const body = req.body as CreateCampaignInput;

      // If audienceId provided, verify it belongs to the same tenant.
      if (body.audienceId) {
        const aud = await prisma.campaignAudience.findFirst({
          where: { id: body.audienceId, tenantId },
          select: { id: true },
        });
        if (!aud) {
          res.status(400).json({
            success: false,
            data: null,
            error: "audienceId does not exist for this tenant",
          });
          return;
        }
      }

      // Same check for templateId.
      if (body.templateId) {
        const tpl = await prisma.notificationTemplate.findFirst({
          where: { id: body.templateId, OR: [{ tenantId }, { tenantId: null }] },
          select: { id: true },
        });
        if (!tpl) {
          res.status(400).json({
            success: false,
            data: null,
            error: "templateId does not exist for this tenant",
          });
          return;
        }
      }

      const created = await prisma.campaign.create({
        data: {
          tenantId,
          name: body.name,
          description: body.description ?? null,
          status: body.status ?? "DRAFT",
          kind: body.kind ?? "BROADCAST",
          channels: body.channels,
          templateId: body.templateId ?? null,
          subject: body.subject ?? null,
          body: body.body ?? null,
          audienceId: body.audienceId ?? null,
          scheduledAt: body.scheduledAt ?? null,
          sendWindowStart: body.sendWindowStart ?? null,
          sendWindowEnd: body.sendWindowEnd ?? null,
          abVariants: body.abVariants ?? undefined,
          createdById: req.user!.userId,
        },
      });

      auditLog(req, "CAMPAIGN_CREATE", "campaign", created.id, {
        name: created.name,
        kind: created.kind,
        status: created.status,
        channels: created.channels,
      }).catch(console.error);

      res.status(201).json({ success: true, data: created, error: null });
    } catch (err) {
      next(err);
    }
  },
);

// ── GET / — list campaigns (ADMIN) ────────────────────────────────────
router.get(
  "/",
  authorize(Role.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = await resolveTenantId(req);
      if (!tenantId) {
        res.json({ success: true, data: [], error: null });
        return;
      }

      const { status } = req.query as { status?: string };
      const where: Record<string, unknown> = { tenantId };
      if (status) where.status = status;

      const campaigns = await prisma.campaign.findMany({
        where,
        orderBy: [{ createdAt: "desc" }],
        include: {
          _count: { select: { sends: true } },
        },
      });
      res.json({ success: true, data: campaigns, error: null });
    } catch (err) {
      next(err);
    }
  },
);

// ── GET /:id — get one (ADMIN) ────────────────────────────────────────
router.get(
  "/:id",
  authorize(Role.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = await resolveTenantId(req);
      if (!tenantId) {
        res.status(404).json({ success: false, data: null, error: "Campaign not found" });
        return;
      }
      const campaign = await prisma.campaign.findFirst({
        where: { id: req.params.id, tenantId },
        include: {
          audience: true,
          _count: { select: { sends: true } },
        },
      });
      if (!campaign) {
        res.status(404).json({ success: false, data: null, error: "Campaign not found" });
        return;
      }
      res.json({ success: true, data: campaign, error: null });
    } catch (err) {
      next(err);
    }
  },
);

// ── PATCH /:id — update (ADMIN) ───────────────────────────────────────
router.patch(
  "/:id",
  authorize(Role.ADMIN),
  validate(updateCampaignSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = await resolveTenantId(req);
      if (!tenantId) {
        res.status(404).json({ success: false, data: null, error: "Campaign not found" });
        return;
      }
      const body = req.body as UpdateCampaignInput;
      const existing = await prisma.campaign.findFirst({
        where: { id: req.params.id, tenantId },
      });
      if (!existing) {
        res.status(404).json({ success: false, data: null, error: "Campaign not found" });
        return;
      }

      // State-machine guard. The Zod schema already excludes COMPLETED
      // and RUNNING from operator-writeable values; here we additionally
      // verify the (current → next) transition is allowed.
      if (body.status && body.status !== existing.status) {
        const allowed = OPERATOR_STATUS_TRANSITIONS[existing.status] ?? [];
        if (!allowed.includes(body.status)) {
          res.status(409).json({
            success: false,
            data: null,
            error: `Cannot transition campaign from ${existing.status} to ${body.status}`,
          });
          return;
        }
      }

      // Cross-reference checks for newly assigned audience / template.
      if (body.audienceId !== undefined && body.audienceId !== null) {
        const aud = await prisma.campaignAudience.findFirst({
          where: { id: body.audienceId, tenantId },
          select: { id: true },
        });
        if (!aud) {
          res.status(400).json({
            success: false,
            data: null,
            error: "audienceId does not exist for this tenant",
          });
          return;
        }
      }
      if (body.templateId !== undefined && body.templateId !== null) {
        const tpl = await prisma.notificationTemplate.findFirst({
          where: { id: body.templateId, OR: [{ tenantId }, { tenantId: null }] },
          select: { id: true },
        });
        if (!tpl) {
          res.status(400).json({
            success: false,
            data: null,
            error: "templateId does not exist for this tenant",
          });
          return;
        }
      }

      const updated = await prisma.campaign.update({
        where: { id: existing.id },
        data: {
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.description !== undefined ? { description: body.description } : {}),
          ...(body.status !== undefined ? { status: body.status } : {}),
          ...(body.kind !== undefined ? { kind: body.kind } : {}),
          ...(body.channels !== undefined ? { channels: body.channels } : {}),
          ...(body.templateId !== undefined ? { templateId: body.templateId } : {}),
          ...(body.subject !== undefined ? { subject: body.subject } : {}),
          ...(body.body !== undefined ? { body: body.body } : {}),
          ...(body.audienceId !== undefined ? { audienceId: body.audienceId } : {}),
          ...(body.scheduledAt !== undefined ? { scheduledAt: body.scheduledAt } : {}),
          ...(body.sendWindowStart !== undefined
            ? { sendWindowStart: body.sendWindowStart }
            : {}),
          ...(body.sendWindowEnd !== undefined ? { sendWindowEnd: body.sendWindowEnd } : {}),
          ...(body.abVariants !== undefined ? { abVariants: body.abVariants ?? undefined } : {}),
          ...(body.cancelReason !== undefined ? { cancelReason: body.cancelReason } : {}),
          // If the operator is transitioning to CANCELLED via PATCH (rare
          // — the dedicated DELETE is the canonical path), stamp the
          // cancelledAt as a side effect.
          ...(body.status === "CANCELLED" && existing.status !== "CANCELLED"
            ? { cancelledAt: new Date() }
            : {}),
        },
      });

      auditLog(
        req,
        "CAMPAIGN_UPDATE",
        "campaign",
        updated.id,
        body as Record<string, unknown>,
      ).catch(console.error);

      res.json({ success: true, data: updated, error: null });
    } catch (err) {
      next(err);
    }
  },
);

// ── DELETE /:id — soft-cancel (ADMIN) ─────────────────────────────────
// Cannot cancel a COMPLETED campaign (it's already over).
router.delete(
  "/:id",
  authorize(Role.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = await resolveTenantId(req);
      if (!tenantId) {
        res.status(404).json({ success: false, data: null, error: "Campaign not found" });
        return;
      }
      const existing = await prisma.campaign.findFirst({
        where: { id: req.params.id, tenantId },
      });
      if (!existing) {
        res.status(404).json({ success: false, data: null, error: "Campaign not found" });
        return;
      }
      if (existing.status === "COMPLETED") {
        res.status(409).json({
          success: false,
          data: null,
          error: "Cannot cancel a COMPLETED campaign.",
        });
        return;
      }
      if (existing.status === "CANCELLED") {
        // Idempotent — already cancelled.
        res.json({
          success: true,
          data: { id: existing.id, status: existing.status, cancelledAt: existing.cancelledAt },
          error: null,
        });
        return;
      }

      const reason =
        typeof req.body?.cancelReason === "string" ? req.body.cancelReason : undefined;

      const updated = await prisma.campaign.update({
        where: { id: existing.id },
        data: {
          status: "CANCELLED",
          cancelledAt: new Date(),
          ...(reason ? { cancelReason: reason } : {}),
        },
      });

      auditLog(req, "CAMPAIGN_CANCEL", "campaign", updated.id, {
        previousStatus: existing.status,
        cancelReason: reason ?? null,
      }).catch(console.error);

      res.json({
        success: true,
        data: {
          id: updated.id,
          status: updated.status,
          cancelledAt: updated.cancelledAt,
          cancelReason: updated.cancelReason,
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  },
);

// ── POST /:id/sends/preview — estimate recipients (ADMIN) ─────────────
// Pearl §5.1 piece 2a (2026-05-21). If the campaign has an audience
// attached, compile its rules → Patient `where`, run a count + 5-row
// sample, and persist (estimatedSize, lastComputedAt) on the audience
// as a side effect (so a subsequent compile-from-the-audience route
// short-circuits this work). If no audience is attached, return 0 with
// a clarifying note — operators see "you haven't picked a target yet".
router.post(
  "/:id/sends/preview",
  authorize(Role.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = await resolveTenantId(req);
      if (!tenantId) {
        res.status(404).json({ success: false, data: null, error: "Campaign not found" });
        return;
      }
      const campaign = await prisma.campaign.findFirst({
        where: { id: req.params.id, tenantId },
        select: { id: true, audienceId: true },
      });
      if (!campaign) {
        res.status(404).json({ success: false, data: null, error: "Campaign not found" });
        return;
      }
      if (!campaign.audienceId) {
        res.json({
          success: true,
          data: {
            estimatedRecipients: 0,
            note: "No audience attached to this campaign.",
          },
          error: null,
        });
        return;
      }

      const audience = await prisma.campaignAudience.findFirst({
        where: { id: campaign.audienceId, tenantId },
      });
      if (!audience) {
        // Audience deleted after campaign linked, or cross-tenant id smuggled.
        res.json({
          success: true,
          data: {
            estimatedRecipients: 0,
            note: "Audience referenced by this campaign no longer exists.",
          },
          error: null,
        });
        return;
      }

      const compiledWhere = compileAudience((audience.rules ?? {}) as AudienceRules);
      const whereWithTenant = { tenantId, AND: [compiledWhere] };

      const [count, sampleRows] = await Promise.all([
        prisma.patient.count({ where: whereWithTenant }),
        prisma.patient.findMany({
          where: whereWithTenant,
          take: 5,
          select: { id: true },
        }),
      ]);

      const computedAt = new Date();
      await prisma.campaignAudience.update({
        where: { id: audience.id },
        data: { estimatedSize: count, lastComputedAt: computedAt },
      });

      res.json({
        success: true,
        data: {
          estimatedRecipients: count,
          audienceName: audience.name,
          audienceComputedAt: computedAt.toISOString(),
          sampleIds: sampleRows.map((p) => p.id),
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  },
);

// ── POST /:id/dispatch — Pearl §5.1 piece 2b sync dispatcher (ADMIN) ──
//
// Drives a Campaign from DRAFT/SCHEDULED → RUNNING → COMPLETED in one
// request. Audience must already be attached + the send-window (if any)
// must be open NOW; otherwise 400/409 with a clarifying body. Body is
// empty — all state lives on the Campaign + its CampaignAudience.
//
// The actual fan-out (audience compile → per-(patient,channel) channel
// adapter call → CampaignSend row write) lives in services/campaign-
// dispatcher.ts so it can later be lifted into a background worker
// (piece 3) without re-shaping the endpoint contract. Sync today gives
// the operator immediate feedback on a 1k-patient pilot.
router.post(
  "/:id/dispatch",
  authorize(Role.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = await resolveTenantId(req);
      if (!tenantId) {
        res.status(404).json({ success: false, data: null, error: "Campaign not found" });
        return;
      }
      const campaign = await prisma.campaign.findFirst({
        where: { id: req.params.id, tenantId },
      });
      if (!campaign) {
        res.status(404).json({ success: false, data: null, error: "Campaign not found" });
        return;
      }

      // State-machine guard. RUNNING means a prior dispatch is in flight
      // (or paused mid-flight); COMPLETED/CANCELLED are terminal.
      if (campaign.status === "RUNNING") {
        res.status(409).json({
          success: false,
          data: null,
          error: "Campaign is already RUNNING; wait for it to complete or PAUSE it first",
        });
        return;
      }
      if (campaign.status === "COMPLETED" || campaign.status === "CANCELLED") {
        res.status(409).json({
          success: false,
          data: null,
          error: `Campaign is in terminal state ${campaign.status} and cannot be re-dispatched`,
        });
        return;
      }

      if (!campaign.audienceId) {
        res.status(400).json({
          success: false,
          data: null,
          error: "Cannot dispatch a campaign with no audience attached",
        });
        return;
      }
      if (!campaign.channels || campaign.channels.length === 0) {
        res.status(400).json({
          success: false,
          data: null,
          error: "Cannot dispatch a campaign with no channels enabled",
        });
        return;
      }

      // Pearl §5.1 send-window clamp. Reject (not queue) — keeps the
      // sync contract simple; piece 3's background worker is the right
      // place to auto-queue an out-of-window dispatch.
      if (!isWithinSendWindow(campaign.sendWindowStart, campaign.sendWindowEnd)) {
        const nextStart = nextSendWindowStart(campaign.sendWindowStart as number);
        res.status(409).json({
          success: false,
          data: null,
          error: "Outside the campaign's configured send window (IST quiet-hour clamp)",
          nextWindowStart: nextStart.toISOString(),
        });
        return;
      }

      // Flip status BEFORE running the sync fan-out so a parallel
      // dispatch request hits the RUNNING guard above.
      const startedAt = new Date();
      await prisma.campaign.update({
        where: { id: campaign.id },
        data: { status: "RUNNING", startedAt },
      });

      let summary;
      try {
        summary = await dispatchCampaign(prisma, {
          campaignId: campaign.id,
          tenantId,
        });
      } catch (err) {
        // Roll the campaign back to PAUSED so the operator can resume
        // after investigating; preserve the partial CampaignSend rows
        // already written by the dispatcher.
        await prisma.campaign.update({
          where: { id: campaign.id },
          data: { status: "PAUSED" },
        });
        throw err;
      }

      const completedAt = new Date();
      await prisma.campaign.update({
        where: { id: campaign.id },
        data: { status: "COMPLETED", completedAt },
      });

      auditLog(req, "CAMPAIGN_DISPATCH", "campaign", campaign.id, {
        startedAt: startedAt.toISOString(),
        completedAt: completedAt.toISOString(),
        summary,
      }).catch(console.error);

      res.json({
        success: true,
        data: {
          campaignId: campaign.id,
          startedAt: startedAt.toISOString(),
          completedAt: completedAt.toISOString(),
          summary,
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  },
);

// ── GET /:id/stats — Pearl §5.1 piece 3 tracking aggregates (ADMIN) ──
//
// Returns a rollup of CampaignSend rows for one Campaign: overall
// totals + per-status counts + per-channel matrix + per-variant counts
// (when A/B variants are configured). Reads only; no side effects. The
// per-variant block is empty when the campaign has no abVariants — the
// operator can still see channel-level performance without an A/B.
router.get(
  "/:id/stats",
  authorize(Role.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = await resolveTenantId(req);
      if (!tenantId) {
        res.status(404).json({ success: false, data: null, error: "Campaign not found" });
        return;
      }
      const campaign = await prisma.campaign.findFirst({
        where: { id: req.params.id, tenantId },
        select: { id: true, name: true, status: true, channels: true },
      });
      if (!campaign) {
        res.status(404).json({ success: false, data: null, error: "Campaign not found" });
        return;
      }

      // Pearl §5.1 piece 3c — add click + conversion counts to the
      // rollup. Both are simple where-filtered counts on the same
      // CampaignSend table; the byVariant matrix is augmented with
      // per-variant clicks + conversions so the operator can compare
      // variant performance end-to-end (impressions → clicks → conv).
      const [byStatus, byChannelStatus, byVariant, clicked, converted, clickedByVariant, convertedByVariant] = await Promise.all([
        prisma.campaignSend.groupBy({
          by: ["status"],
          where: { campaignId: campaign.id, tenantId },
          _count: { _all: true },
        }),
        prisma.campaignSend.groupBy({
          by: ["channel", "status"],
          where: { campaignId: campaign.id, tenantId },
          _count: { _all: true },
        }),
        prisma.campaignSend.groupBy({
          by: ["variantId", "status"],
          where: { campaignId: campaign.id, tenantId, variantId: { not: null } },
          _count: { _all: true },
        }),
        prisma.campaignSend.count({
          where: { campaignId: campaign.id, tenantId, clickedAt: { not: null } },
        }),
        prisma.campaignSend.count({
          where: { campaignId: campaign.id, tenantId, convertedAt: { not: null } },
        }),
        prisma.campaignSend.groupBy({
          by: ["variantId"],
          where: { campaignId: campaign.id, tenantId, variantId: { not: null }, clickedAt: { not: null } },
          _count: { _all: true },
        }),
        prisma.campaignSend.groupBy({
          by: ["variantId"],
          where: { campaignId: campaign.id, tenantId, variantId: { not: null }, convertedAt: { not: null } },
          _count: { _all: true },
        }),
      ]);

      const statusTotals: Record<string, number> = {
        QUEUED: 0, SENT: 0, DELIVERED: 0, READ: 0,
        BOUNCED: 0, FAILED: 0, SUPPRESSED: 0,
      };
      let total = 0;
      for (const row of byStatus) {
        statusTotals[row.status] = row._count._all;
        total += row._count._all;
      }

      // Pivot per-channel × status into { channel: { status: count } }
      // so the UI can render a matrix without further reshaping.
      const channelMatrix: Record<string, Record<string, number>> = {};
      for (const row of byChannelStatus) {
        if (!channelMatrix[row.channel]) {
          channelMatrix[row.channel] = {
            QUEUED: 0, SENT: 0, DELIVERED: 0, READ: 0,
            BOUNCED: 0, FAILED: 0, SUPPRESSED: 0, total: 0,
          };
        }
        channelMatrix[row.channel][row.status] = row._count._all;
        channelMatrix[row.channel].total += row._count._all;
      }

      const variantMatrix: Record<string, Record<string, number>> = {};
      for (const row of byVariant) {
        if (!row.variantId) continue;
        if (!variantMatrix[row.variantId]) {
          variantMatrix[row.variantId] = {
            QUEUED: 0, SENT: 0, DELIVERED: 0, READ: 0,
            BOUNCED: 0, FAILED: 0, SUPPRESSED: 0, total: 0,
            clicked: 0, converted: 0,
          };
        }
        variantMatrix[row.variantId][row.status] = row._count._all;
        variantMatrix[row.variantId].total += row._count._all;
      }
      for (const row of clickedByVariant) {
        if (row.variantId && variantMatrix[row.variantId]) {
          variantMatrix[row.variantId].clicked = row._count._all;
        }
      }
      for (const row of convertedByVariant) {
        if (row.variantId && variantMatrix[row.variantId]) {
          variantMatrix[row.variantId].converted = row._count._all;
        }
      }

      res.json({
        success: true,
        data: {
          campaignId: campaign.id,
          campaignName: campaign.name,
          status: campaign.status,
          total,
          byStatus: statusTotals,
          byChannel: channelMatrix,
          byVariant: variantMatrix,
          clicked,
          converted,
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  },
);

export { router as campaignsRouter };

// ── publicCampaignsRouter — Pearl §5.1 piece 3c click tracker ────────
//
// Mounted UNAUTHENTICATED at /api/v1/public/campaigns alongside the
// existing Rx-QR verify router (services/pdf-generator.ts pattern).
// Recipients tap a link inside a WhatsApp/SMS/email message that the
// dispatcher minted at send time — there is no auth context, the
// signature is the obscurity of the `sendId` cuid plus the audit row
// (an attacker guessing a sendId reveals only that *somebody*
// received that send; no PII leaks via this endpoint).
import { prisma as rawPrisma } from "@medcore/db";

const publicRouter = Router();

publicRouter.get(
  "/campaigns/click/:sendId",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const send = await rawPrisma.campaignSend.findUnique({
        where: { id: req.params.sendId },
        select: {
          id: true,
          clickedAt: true,
          campaign: { select: { id: true, linkTargetUrl: true } },
        },
      });
      if (!send) {
        res.status(404).type("text/plain").send("Not found");
        return;
      }

      // Record clickedAt only on the FIRST tap (so a refresh / re-share
      // doesn't move the attribution-window anchor forward). Subsequent
      // taps still redirect — they just don't update the timestamp.
      if (!send.clickedAt) {
        await rawPrisma.campaignSend.update({
          where: { id: send.id },
          data: { clickedAt: new Date() },
        });
      }

      const target = send.campaign?.linkTargetUrl;
      if (target) {
        res.redirect(302, target);
        return;
      }
      res.status(200).type("text/plain").send("Click recorded. Thank you.");
    } catch (err) {
      next(err);
    }
  },
);

export { publicRouter as publicCampaignsRouter };
