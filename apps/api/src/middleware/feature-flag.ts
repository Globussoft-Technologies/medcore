// Pearl ERP Stage 1 §6 + §18 (gap item #9) — Express middleware that
// rejects requests for features the current tenant has disabled.
//
// Returns 404 (not 403) on a disabled feature: a Pearl tenant
// shouldn't even learn that the route exists. Existing 403 semantics
// are reserved for role/RBAC denials within enabled features.
//
// Usage in a route file:
//   router.use(requireFeature("ipd"));
// or per-handler:
//   router.post("/", requireFeature("ipd"), authorize(...), handler)

import type { Request, Response, NextFunction } from "express";
import { type FeatureKey } from "@medcore/shared";
import { isFeatureEnabled } from "../services/feature-flags";

export function requireFeature(key: FeatureKey) {
  return async function featureFlagGate(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const enabled = await isFeatureEnabled(req.tenantId, key);
      if (!enabled) {
        res.status(404).json({
          success: false,
          data: null,
          error: "Not found",
        });
        return;
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}
