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
import { authenticate } from "../middleware/auth";

const router = Router();
router.use(authenticate);

// GET /api/v1/me/tenant — caller's own tenant, friendly fields only.
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
    res.json({ success: true, data: tenant, error: null });
  } catch (err) {
    next(err);
  }
});

export { router as meTenantRouter };
