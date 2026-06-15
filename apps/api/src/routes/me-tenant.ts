/**
 * Issue #744 — friendly-tenant resolver for the dashboard chrome.
 *
 * The web app needed a way to render the caller's tenant by FRIENDLY NAME +
 * SHORT SLUG (e.g. "Globus Hospital (#globus)") rather than the raw
 * `tenantId` UUID that was leaking into the admin-console UI as
 * "clinicId: 4f8a-..." style strings. The existing /api/v1/tenants endpoints
 * are scoped to super-admins on the default tenant — a regular hospital
 * admin cannot call them. This route exposes JUST the caller's own tenant
 * (name + subdomain + plan + active flag), authenticated for any logged-in
 * user, so the dashboard chrome can resolve tenantId → name without
 * needing super-admin grants.
 *
 * Returns 200 with `{ data: null }` for tenant-less legacy users (the
 * caller renders nothing in that case, which matches the old behaviour of
 * showing no tenant banner).
 */

import { Router, Request, Response, NextFunction } from "express";
import { prisma } from "@medcore/db";
import { PLAN_FEATURE_CATALOG, resolvePlanFeatures } from "@medcore/shared";
import { authenticate } from "../middleware/auth";

const router = Router();
router.use(authenticate);

// Catalog keys we recognise — used to tell genuine plan selections (which we
// gate on) apart from LEGACY free-text includedFeatures (e.g. "opd") that
// predate the route-slug catalog. If a plan's includedFeatures contain no
// recognised catalog key, we fail OPEN (planFeatures = null → no gating) so a
// never-migrated plan never locks a tenant out of its whole sidebar.
const CATALOG_KEY_SET = new Set(PLAN_FEATURE_CATALOG.map((f) => f.key));

// GET /api/v1/me/tenant — caller's own tenant, friendly fields only.
// Also returns `planFeatures`: the resolved set of feature keys the tenant's
// plan unlocks (common baseline ∪ plan picks ∪ deps), or null when the plan is
// unknown / legacy (caller treats null as "show everything").
router.get("/tenant", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.userId },
      select: { tenantId: true },
    });
    if (!user?.tenantId) {
      res.json({ success: true, data: null, error: null });
      return;
    }
    const tenant = await prisma.tenant.findUnique({
      where: { id: user.tenantId },
      select: {
        id: true,
        name: true,
        subdomain: true,
        plan: true,
        active: true,
      },
    });

    let planFeatures: string[] | null = null;
    // The default tenant ("MedCore Hospital", subdomain "default") is the
    // platform's own house tenant — it always gets full access regardless of
    // plan, so we never gate it (null → caller shows everything).
    if (tenant?.plan && tenant.subdomain !== "default") {
      const plan = await prisma.platformPlan.findUnique({
        where: { key: tenant.plan },
        select: { includedFeatures: true },
      });
      if (plan) {
        const included = plan.includedFeatures ?? [];
        const recognised = included.filter((k) => CATALOG_KEY_SET.has(k));
        if (recognised.length > 0) {
          // Plan has genuine catalog picks → gate to those (+ common + deps).
          planFeatures = Array.from(resolvePlanFeatures(recognised));
        } else if (included.length === 0) {
          // Plan deliberately has NO add-ons → tenant gets ONLY the common
          // baseline (resolvePlanFeatures([]) === the common keys). This is the
          // "feature-less plan" case shown as common-only in the plan editor.
          planFeatures = Array.from(resolvePlanFeatures([]));
        }
        // else: non-empty but purely LEGACY free-text includedFeatures (e.g.
        // "opd") that predate the catalog → leave null (fail open) so a
        // never-migrated plan never locks a tenant out of its whole sidebar.
      }
    }

    // `isDefault` lets the dashboard chrome treat the Main/Default hospital
    // specially: show "Full Access" instead of a plan badge and suppress the
    // onboarding nudge (the house tenant is already set up + un-gated).
    const isDefault = tenant?.subdomain === "default";
    res.json({
      success: true,
      data: tenant ? { ...tenant, planFeatures, isDefault } : null,
      error: null,
    });
  } catch (err) {
    next(err);
  }
});

export { router as meTenantRouter };
