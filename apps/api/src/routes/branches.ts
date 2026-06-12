/**
 * Branches CRUD API — Pearl ERP Stage 1 gap item #2 (piece 1 of 3).
 *
 * What / which modules / why:
 *   - Pearl §7.2 + §8.1 mandate per-tenant multi-branch support.
 *     The Branch model shipped in `20260520000010_pearl_branch_model`.
 *     This file is the HTTP surface for branch management.
 *   - 5 endpoints: POST (ADMIN), GET list (any authed role),
 *     GET :id (any authed role), PATCH :id (ADMIN), DELETE :id (ADMIN
 *     soft-delete via active=false).
 *   - tenantId is resolved from the auth context — never accepted in the
 *     request body — using the same 3-step chain `feature-flags.ts` uses:
 *     (1) req.tenantId, (2) caller's User.tenantId, (3) default tenant
 *     by subdomain. This keeps single-tenant deploys working without
 *     ceremony while supporting per-tenant multi-tenant deployments.
 *
 * Invariant enforcement (one default branch per tenant):
 *   - POST: if no branches exist for this tenant, force isDefault=true
 *     regardless of body. Otherwise honour body.isDefault; if true,
 *     atomically unset the previous default in a transaction.
 *   - PATCH: if isDefault flips from false→true, atomically unset the
 *     previous default in a transaction. There is intentionally no path
 *     to flip the current default to isDefault=false directly — the
 *     UI flow is "make another branch the default", which clears this
 *     one as a side effect.
 *   - DELETE (soft-delete via active=false): refuses if branch is the
 *     current default (409). User must transfer-default first.
 *
 * Audit:
 *   - BRANCH_CREATE, BRANCH_UPDATE, BRANCH_DELETE on entity="branch".
 *     Uses `auditLog(...).catch(console.error)` per the project's
 *     safe-audit convention (see CLAUDE.md gotcha #1 — tests using
 *     these handlers may need waitForAuditFlush()).
 */

import { Router, Request, Response, NextFunction } from "express";
// Multi-tenant: scoped client auto-filters reads + tags writes by tenantId
// for TENANT_SCOPED_MODELS (cross-tenant leak fix, 2026-06-11).
import { tenantScopedPrisma as prisma } from "@medcore/db";
import { Role, createBranchSchema, updateBranchSchema } from "@medcore/shared";
import type { CreateBranchInput, UpdateBranchInput } from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { auditLog } from "../middleware/audit";

const router = Router();
router.use(authenticate);

// Mirror feature-flags.ts:55-75 tenant-resolution chain.
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

// ── POST / — create a branch (ADMIN) ──────────────────────────────────
router.post(
  "/",
  authorize(Role.ADMIN),
  validate(createBranchSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = await resolveTenantId(req);
      if (!tenantId) {
        res.status(400).json({
          success: false,
          data: null,
          error: "No tenant context — branches require a tenant.",
        });
        return;
      }

      const body = req.body as CreateBranchInput;

      // Count to decide whether this is the first branch.
      const existingCount = await prisma.branch.count({ where: { tenantId } });
      const shouldBeDefault = existingCount === 0 ? true : !!body.isDefault;

      // Atomically unset any prior default if this one is becoming the default.
      const created = await prisma.$transaction(async (tx) => {
        if (shouldBeDefault && existingCount > 0) {
          await tx.branch.updateMany({
            where: { tenantId, isDefault: true },
            data: { isDefault: false },
          });
        }
        return tx.branch.create({
          data: {
            tenantId,
            name: body.name,
            code: body.code ?? null,
            address: body.address ?? null,
            city: body.city ?? null,
            state: body.state ?? null,
            pincode: body.pincode ?? null,
            phone: body.phone ?? null,
            email: body.email ?? null,
            gstin: body.gstin ?? null,
            isDefault: shouldBeDefault,
            active: true,
          },
        });
      });

      auditLog(req, "BRANCH_CREATE", "branch", created.id, {
        name: created.name,
        code: created.code,
        isDefault: created.isDefault,
      }).catch(console.error);

      res.status(201).json({ success: true, data: created, error: null });
    } catch (err) {
      // Code unique-collision per tenant → 409.
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("Unique constraint") || msg.includes("branches_tenantId_code_key")) {
        res.status(409).json({
          success: false,
          data: null,
          error: "Branch code already in use for this tenant",
        });
        return;
      }
      next(err);
    }
  },
);

// ── GET / — list branches (any authed role) ───────────────────────────
router.get("/", async (req: Request, res: Response, next: NextFunction) => {
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

    const branches = await prisma.branch.findMany({
      where,
      orderBy: [{ isDefault: "desc" }, { name: "asc" }],
    });
    res.json({ success: true, data: branches, error: null });
  } catch (err) {
    next(err);
  }
});

// ── GET /:id — get one branch (any authed role) ───────────────────────
router.get("/:id", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tenantId = await resolveTenantId(req);
    if (!tenantId) {
      res.status(404).json({ success: false, data: null, error: "Branch not found" });
      return;
    }
    const branch = await prisma.branch.findFirst({
      where: { id: req.params.id, tenantId },
    });
    if (!branch) {
      res.status(404).json({ success: false, data: null, error: "Branch not found" });
      return;
    }
    res.json({ success: true, data: branch, error: null });
  } catch (err) {
    next(err);
  }
});

// ── PATCH /:id — update branch (ADMIN) ────────────────────────────────
router.patch(
  "/:id",
  authorize(Role.ADMIN),
  validate(updateBranchSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = await resolveTenantId(req);
      if (!tenantId) {
        res.status(404).json({ success: false, data: null, error: "Branch not found" });
        return;
      }
      const body = req.body as UpdateBranchInput;
      const branch = await prisma.branch.findFirst({
        where: { id: req.params.id, tenantId },
      });
      if (!branch) {
        res.status(404).json({ success: false, data: null, error: "Branch not found" });
        return;
      }

      // Disallow flipping the current default to isDefault=false directly.
      // The flow is "make another branch the default" — that automatically
      // clears this one (see the transaction below). This keeps the
      // invariant "exactly one default per tenant" unbreakable from
      // the API surface.
      if (branch.isDefault && body.isDefault === false) {
        res.status(409).json({
          success: false,
          data: null,
          error:
            "Cannot clear the default flag directly — set isDefault=true on another branch to transfer the default.",
        });
        return;
      }

      // Atomic flip: if this branch is becoming the default, unset any
      // prior default in the same transaction.
      const updated = await prisma.$transaction(async (tx) => {
        if (body.isDefault === true && !branch.isDefault) {
          await tx.branch.updateMany({
            where: { tenantId, isDefault: true, NOT: { id: branch.id } },
            data: { isDefault: false },
          });
        }
        return tx.branch.update({
          where: { id: branch.id },
          data: {
            ...(body.name !== undefined ? { name: body.name } : {}),
            ...(body.code !== undefined ? { code: body.code } : {}),
            ...(body.address !== undefined ? { address: body.address } : {}),
            ...(body.city !== undefined ? { city: body.city } : {}),
            ...(body.state !== undefined ? { state: body.state } : {}),
            ...(body.pincode !== undefined ? { pincode: body.pincode } : {}),
            ...(body.phone !== undefined ? { phone: body.phone } : {}),
            ...(body.email !== undefined ? { email: body.email } : {}),
            ...(body.gstin !== undefined ? { gstin: body.gstin } : {}),
            ...(body.isDefault !== undefined ? { isDefault: body.isDefault } : {}),
            ...(body.active !== undefined ? { active: body.active } : {}),
          },
        });
      });

      auditLog(req, "BRANCH_UPDATE", "branch", updated.id, body as Record<string, unknown>).catch(
        console.error,
      );

      res.json({ success: true, data: updated, error: null });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("Unique constraint") || msg.includes("branches_tenantId_code_key")) {
        res.status(409).json({
          success: false,
          data: null,
          error: "Branch code already in use for this tenant",
        });
        return;
      }
      next(err);
    }
  },
);

// ── DELETE /:id — soft-delete branch (ADMIN) ──────────────────────────
router.delete(
  "/:id",
  authorize(Role.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = await resolveTenantId(req);
      if (!tenantId) {
        res.status(404).json({ success: false, data: null, error: "Branch not found" });
        return;
      }
      const branch = await prisma.branch.findFirst({
        where: { id: req.params.id, tenantId },
      });
      if (!branch) {
        res.status(404).json({ success: false, data: null, error: "Branch not found" });
        return;
      }
      if (branch.isDefault) {
        res.status(409).json({
          success: false,
          data: null,
          error: "Cannot soft-delete the default branch — transfer the default to another branch first.",
        });
        return;
      }

      const updated = await prisma.branch.update({
        where: { id: branch.id },
        data: { active: false },
      });

      auditLog(req, "BRANCH_DELETE", "branch", updated.id, {
        name: updated.name,
        code: updated.code,
      }).catch(console.error);

      res.json({
        success: true,
        data: { id: updated.id, active: updated.active },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  },
);

export { router as branchesRouter };
