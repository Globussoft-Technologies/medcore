/**
 * CampaignAudience CRUD API — Pearl ERP Stage 1 gap item #4 (piece 1 of 4).
 *
 * What / which modules / why:
 *   - Saved audience rules (e.g. "all hypertensives > 55 with no visit in
 *     90d") that Campaigns reference. The `rules` field is a JSON DSL
 *     placeholder; the compiler that turns it into a Prisma `where` over
 *     Patient ships in piece 2 of 4.
 *   - 4 endpoints (POST / GET / GET :id / PATCH) — NO DELETE. Audiences
 *     may be referenced by past Campaigns and must not be hard-deleted;
 *     the soft-deactivate flow is PATCH active=false.
 *   - All ADMIN-gated. tenantId resolved from auth context (mirrors
 *     branches.ts / campaigns.ts), never accepted in the body.
 *
 * Audit: CAMPAIGN_AUDIENCE_CREATE / CAMPAIGN_AUDIENCE_UPDATE on
 *        entity="campaign_audience". Safe-audit (fire-and-forget per
 *        CLAUDE.md gotcha #1).
 */

import { Router, Request, Response, NextFunction } from "express";
// Multi-tenant: scoped client auto-filters reads + tags writes by tenantId
// for TENANT_SCOPED_MODELS (cross-tenant leak fix, 2026-06-11).
import { tenantScopedPrisma as prisma } from "@medcore/db";
import {
  Role,
  createCampaignAudienceSchema,
  updateCampaignAudienceSchema,
} from "@medcore/shared";
import type {
  AudienceRules,
  CreateCampaignAudienceInput,
  UpdateCampaignAudienceInput,
} from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { auditLog } from "../middleware/audit";
import { compileAudience } from "../services/audience-compiler";

const router = Router();
router.use(authenticate);

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

// ── POST / — create audience (ADMIN) ──────────────────────────────────
router.post(
  "/",
  authorize(Role.ADMIN),
  validate(createCampaignAudienceSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = await resolveTenantId(req);
      if (!tenantId) {
        res.status(400).json({
          success: false,
          data: null,
          error: "No tenant context — campaign audiences require a tenant.",
        });
        return;
      }
      const body = req.body as CreateCampaignAudienceInput;

      const created = await prisma.campaignAudience.create({
        data: {
          tenantId,
          name: body.name,
          description: body.description ?? null,
          rules: body.rules as any,
          active: body.active ?? true,
        },
      });

      auditLog(req, "CAMPAIGN_AUDIENCE_CREATE", "campaign_audience", created.id, {
        name: created.name,
      }).catch(console.error);

      res.status(201).json({ success: true, data: created, error: null });
    } catch (err) {
      next(err);
    }
  },
);

// ── GET / — list (ADMIN) ──────────────────────────────────────────────
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

      const { active } = req.query as { active?: string };
      const where: Record<string, unknown> = { tenantId };
      if (active === "true") where.active = true;
      else if (active === "false") where.active = false;

      const audiences = await prisma.campaignAudience.findMany({
        where,
        orderBy: [{ active: "desc" }, { name: "asc" }],
      });
      res.json({ success: true, data: audiences, error: null });
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
        res
          .status(404)
          .json({ success: false, data: null, error: "Campaign audience not found" });
        return;
      }
      const audience = await prisma.campaignAudience.findFirst({
        where: { id: req.params.id, tenantId },
      });
      if (!audience) {
        res
          .status(404)
          .json({ success: false, data: null, error: "Campaign audience not found" });
        return;
      }
      res.json({ success: true, data: audience, error: null });
    } catch (err) {
      next(err);
    }
  },
);

// ── PATCH /:id — update (ADMIN) ───────────────────────────────────────
router.patch(
  "/:id",
  authorize(Role.ADMIN),
  validate(updateCampaignAudienceSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = await resolveTenantId(req);
      if (!tenantId) {
        res
          .status(404)
          .json({ success: false, data: null, error: "Campaign audience not found" });
        return;
      }
      const body = req.body as UpdateCampaignAudienceInput;
      const existing = await prisma.campaignAudience.findFirst({
        where: { id: req.params.id, tenantId },
      });
      if (!existing) {
        res
          .status(404)
          .json({ success: false, data: null, error: "Campaign audience not found" });
        return;
      }

      const updated = await prisma.campaignAudience.update({
        where: { id: existing.id },
        data: {
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.description !== undefined ? { description: body.description } : {}),
          ...(body.rules !== undefined ? { rules: body.rules as any } : {}),
          ...(body.active !== undefined ? { active: body.active } : {}),
        },
      });

      auditLog(
        req,
        "CAMPAIGN_AUDIENCE_UPDATE",
        "campaign_audience",
        updated.id,
        body as Record<string, unknown>,
      ).catch(console.error);

      res.json({ success: true, data: updated, error: null });
    } catch (err) {
      next(err);
    }
  },
);

// ── POST /:id/compile — compute audience size + sample (ADMIN) ────────
// Pearl §5.1 piece 2a (2026-05-21). Loads the audience, compiles its
// `rules` JSON DSL into a Prisma `where` over Patient via the pure
// `compileAudience(rules)` service, runs `count` + a 5-row sample, and
// persists `estimatedSize` + `lastComputedAt` back to the audience so
// the next preview can short-circuit if the underlying patient set is
// believed unchanged (piece 2b dispatcher concern).
router.post(
  "/:id/compile",
  authorize(Role.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = await resolveTenantId(req);
      if (!tenantId) {
        res
          .status(404)
          .json({ success: false, data: null, error: "Campaign audience not found" });
        return;
      }

      const audience = await prisma.campaignAudience.findFirst({
        where: { id: req.params.id, tenantId },
      });
      if (!audience) {
        res
          .status(404)
          .json({ success: false, data: null, error: "Campaign audience not found" });
        return;
      }

      const compiledWhere = compileAudience((audience.rules ?? {}) as AudienceRules);
      const whereWithTenant = { tenantId, AND: [compiledWhere] };

      const [count, sampleRows] = await Promise.all([
        prisma.patient.count({ where: whereWithTenant }),
        prisma.patient.findMany({
          where: whereWithTenant,
          take: 5,
          select: {
            id: true,
            mrNumber: true,
            user: { select: { name: true } },
          },
        }),
      ]);

      const computedAt = new Date();
      await prisma.campaignAudience.update({
        where: { id: audience.id },
        data: { estimatedSize: count, lastComputedAt: computedAt },
      });

      const sample = sampleRows.map((p) => ({
        id: p.id,
        mrNumber: p.mrNumber,
        name: p.user?.name ?? null,
      }));

      auditLog(req, "CAMPAIGN_AUDIENCE_COMPILE", "campaign_audience", audience.id, {
        count,
      }).catch(console.error);

      res.json({
        success: true,
        data: {
          count,
          sampleIds: sample.map((s) => s.id),
          sample,
          lastComputedAt: computedAt.toISOString(),
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  },
);

export { router as campaignAudiencesRouter };
