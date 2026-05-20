// Pearl ERP Stage 1 §6 + §18 (gap item #9) — feature-flags API.
//
// GET   /api/v1/feature-flags                 — any authed user (resolves their tenant)
// PATCH /api/v1/feature-flags                 — ADMIN-only, sets overrides for their own tenant
// PATCH /api/v1/feature-flags/tenants/:id     — super-admin (TODO: gate by future PEARL_ADMIN role)
//
// Both PATCH paths write an AuditLog row keyed by entity=tenant so the
// flag-change history is queryable without joining through audit.

import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { prisma } from "@medcore/db";
import { Role, FEATURE_KEYS } from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { auditLog } from "../middleware/audit";
import {
  getAllFeatureFlags,
  invalidateFeatureFlagsCache,
} from "../services/feature-flags";

const router = Router();
router.use(authenticate);

// PATCH body shape: partial map of FeatureKey → boolean. Server merges
// with the existing stored object (null overrides clear individual keys).
//
// Zod 4 quirk: `z.record(enum, value)` requires EVERY enum key to be
// present (strictness changed from Zod 3). We want a partial body, so
// use `z.record(z.string(), value)` and validate the keys at runtime
// against FEATURE_KEYS in the handler — gives us partial semantics +
// keeps the type-narrow on the value side.
const updateFeatureFlagsSchema = z.object({
  flags: z.record(z.string(), z.boolean().nullable()),
});
const VALID_KEYS = new Set<string>(FEATURE_KEYS as readonly string[]);

// GET — return effective resolved flags for the caller's tenant.
router.get("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const resolved = await getAllFeatureFlags(req.tenantId);
    res.json({ success: true, data: resolved, error: null });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/v1/feature-flags — ADMIN sets overrides for their own tenant.
router.patch(
  "/",
  authorize(Role.ADMIN),
  validate(updateFeatureFlagsSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = req.tenantId;
      if (!tenantId) {
        res.status(400).json({
          success: false,
          data: null,
          error: "No tenant context — feature flags are tenant-scoped.",
        });
        return;
      }

      const tenant = await prisma.tenant.findUnique({
        where: { id: tenantId },
        select: { featureFlags: true },
      });
      if (!tenant) {
        res.status(404).json({ success: false, data: null, error: "Tenant not found" });
        return;
      }

      // Reject any unknown keys (since the Zod schema can't enum-validate
      // partial records in Zod 4).
      for (const k of Object.keys(req.body.flags)) {
        if (!VALID_KEYS.has(k)) {
          res.status(400).json({
            success: false,
            data: null,
            error: `Unknown feature key: ${k}`,
          });
          return;
        }
      }

      const current = (tenant.featureFlags ?? {}) as Record<string, unknown>;
      const merged: Record<string, unknown> = { ...current };
      for (const [k, v] of Object.entries(req.body.flags)) {
        if (v === null) {
          delete merged[k];
        } else {
          merged[k] = v;
        }
      }

      await prisma.tenant.update({
        where: { id: tenantId },
        data: { featureFlags: merged as never },
      });
      invalidateFeatureFlagsCache(tenantId);

      auditLog(req, "TENANT_FEATURE_FLAGS_UPDATE", "tenant", tenantId, {
        changedKeys: Object.keys(req.body.flags),
      }).catch(console.error);

      const resolved = await getAllFeatureFlags(tenantId);
      res.json({ success: true, data: resolved, error: null });
    } catch (err) {
      next(err);
    }
  },
);

export { router as featureFlagsRouter };
