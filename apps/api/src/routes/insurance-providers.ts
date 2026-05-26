// Issue #724 (2026-05-08): admin onboarding for insurance partners /
// TPAs. The /dashboard/insurance page now exposes an "Add Provider"
// button that POSTs here. Pre-existing claims/preauth routes used the
// hardcoded `INDIAN_INSURERS` array in packages/shared; new partners
// no longer require a code change.
//
// RBAC: ADMIN-only for create/update/deactivate (procurement / contract
// administration is a finance-admin concern). ADMIN + RECEPTION can
// list — reception needs the dropdown when creating claims/preauth.
//
// Audit: every mutation writes an INSURANCE_PROVIDER_<ACTION> row.
//
// Tenant scoping (2026-05-27): the wrapper auto-filters reads and
// auto-injects tenantId on writes for every model in
// `TENANT_SCOPED_MODELS`. InsuranceProvider has a (nullable) `tenantId`
// column and was added to the set in `packages/db/src/tenant-prisma.ts`,
// so swapping the raw client for `tenantScopedPrisma` here closes the
// cross-tenant leak surfaced by insurance-providers.test.ts.
import { Router, Request, Response, NextFunction } from "express";
import { tenantScopedPrisma as prisma } from "../services/tenant-prisma";
import {
  Role,
  createInsuranceProviderSchema,
  updateInsuranceProviderSchema,
} from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { auditLog } from "../middleware/audit";

const router = Router();
router.use(authenticate);

// GET /api/v1/insurance-providers
router.get(
  "/",
  authorize(Role.ADMIN, Role.RECEPTION),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { active, search } = req.query as Record<string, string | undefined>;
      const where: Record<string, unknown> = {};
      if (active === "true") where.isActive = true;
      else if (active === "false") where.isActive = false;
      if (search) {
        where.OR = [
          { name: { contains: search, mode: "insensitive" } },
          { code: { contains: search.toUpperCase(), mode: "insensitive" } },
          { contactPerson: { contains: search, mode: "insensitive" } },
        ];
      }
      const providers = await prisma.insuranceProvider.findMany({
        where,
        orderBy: { name: "asc" },
      });
      res.json({ success: true, data: providers, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/insurance-providers/:id
router.get(
  "/:id",
  authorize(Role.ADMIN, Role.RECEPTION),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const provider = await prisma.insuranceProvider.findUnique({
        where: { id: req.params.id },
      });
      if (!provider) {
        res
          .status(404)
          .json({ success: false, data: null, error: "Provider not found" });
        return;
      }
      res.json({ success: true, data: provider, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/v1/insurance-providers
router.post(
  "/",
  authorize(Role.ADMIN),
  validate(createInsuranceProviderSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = req.body as Record<string, unknown>;
      const provider = await prisma.insuranceProvider.create({
        data: {
          name: String(body.name),
          code: String(body.code).toUpperCase(),
          contactPerson: (body.contactPerson as string | undefined) ?? null,
          contactEmail: (body.contactEmail as string | undefined) ?? null,
          contactPhone: (body.contactPhone as string | undefined) ?? null,
          coverageDetails:
            (body.coverageDetails as string | undefined) ?? null,
        },
      });
      auditLog(
        req,
        "INSURANCE_PROVIDER_CREATE",
        "insuranceProvider",
        provider.id,
        body
      ).catch(console.error);
      res.status(201).json({ success: true, data: provider, error: null });
    } catch (err) {
      // P2002 unique-constraint (code already exists)
      if (
        err &&
        typeof err === "object" &&
        "code" in err &&
        (err as { code?: unknown }).code === "P2002"
      ) {
        res.status(409).json({
          success: false,
          data: null,
          error: "Provider code already exists",
        });
        return;
      }
      next(err);
    }
  }
);

// PATCH /api/v1/insurance-providers/:id
router.patch(
  "/:id",
  authorize(Role.ADMIN),
  validate(updateInsuranceProviderSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const existing = await prisma.insuranceProvider.findUnique({
        where: { id: req.params.id },
      });
      if (!existing) {
        res
          .status(404)
          .json({ success: false, data: null, error: "Provider not found" });
        return;
      }
      const body = req.body as Record<string, unknown>;
      const data: Record<string, unknown> = { ...body };
      if (typeof body.code === "string") data.code = body.code.toUpperCase();
      const provider = await prisma.insuranceProvider.update({
        where: { id: req.params.id },
        data,
      });
      auditLog(
        req,
        "INSURANCE_PROVIDER_UPDATE",
        "insuranceProvider",
        provider.id,
        body
      ).catch(console.error);
      res.json({ success: true, data: provider, error: null });
    } catch (err) {
      if (
        err &&
        typeof err === "object" &&
        "code" in err &&
        (err as { code?: unknown }).code === "P2002"
      ) {
        res.status(409).json({
          success: false,
          data: null,
          error: "Provider code already exists",
        });
        return;
      }
      next(err);
    }
  }
);

export const insuranceProvidersRouter = router;
