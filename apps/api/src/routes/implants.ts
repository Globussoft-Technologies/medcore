// Pearl §S2.2 row 92 — Implant register (MVP).
//
// What this file ships
// --------------------
// Two endpoints that close the §S2.2 "Implant register / traceability" gap
// in `docs/PEARL_STAGE2_GAP_ANALYSIS.md`:
//
//   POST /api/v1/implants
//     Body: { surgeryId, category, manufacturer, productName, lotNumber,
//             modelNumber?, serialNumber?, expiryDate?, notes? }
//     Effect: creates one Implant row attached to the surgery. Resolves
//             tenant scope via the surgery row; rejects cross-tenant
//             POSTs because tenantScopedPrisma can't find the surgery.
//
//   GET /api/v1/implants?surgeryId=... | ?lotNumber=...
//     Filter by surgeryId (per-case view) OR lotNumber (manufacturer
//     recall sweep). At least one filter is required so the endpoint
//     never returns the whole register in one shot.
//
// Modules
// -------
// - tenantScopedPrisma  : auto-stamps tenantId on create + auto-filters
//                         on read; the cross-tenant test relies on this.
// - requireFeature("ot"): mirrors routes/surgery.ts — Pearl tenants that
//                         haven't opted into OT 404 on every implant
//                         endpoint before authorize/handler runs.
// - authorize           : ADMIN/DOCTOR/NURSE, mirroring the OT chain.
// - auditLog            : awaited (not safeAudit) — implant registers
//                         are a regulated record, the tail-latency cost
//                         is fine and the read-after-write contract is
//                         what we want.

import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { tenantScopedPrisma as prisma } from "../services/tenant-prisma";
import { Role } from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { auditLog } from "../middleware/audit";
import { requireFeature } from "../middleware/feature-flag";

const router = Router();
router.use(authenticate);
router.use(requireFeature("ot"));

const IMPLANT_CATEGORIES = [
  "ORTHOPAEDIC",
  "CARDIAC",
  "OPHTHALMIC",
  "DENTAL",
  "OTHER",
] as const;

const createImplantSchema = z.object({
  surgeryId: z.string().uuid(),
  category: z.enum(IMPLANT_CATEGORIES),
  manufacturer: z.string().min(1).max(120),
  productName: z.string().min(1).max(200),
  modelNumber: z.string().max(100).optional(),
  lotNumber: z.string().min(1).max(100),
  serialNumber: z.string().max(100).optional(),
  expiryDate: z
    .string()
    .datetime({ offset: true })
    .optional()
    .or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()),
  notes: z.string().max(2000).optional(),
});

// POST /api/v1/implants — register an implant against a surgery.
router.post(
  "/",
  authorize(Role.ADMIN, Role.DOCTOR, Role.NURSE),
  validate(createImplantSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user?.userId;
      if (!userId) {
        res.status(401).json({ success: false, data: null, error: "Unauthorized" });
        return;
      }

      // Surgery existence + tenant scope check: tenantScopedPrisma
      // auto-filters by req.tenantId, so a surgery from a different
      // tenant cannot be found here. That gives us cross-tenant write
      // isolation without an explicit branchId compare.
      const surgery = await prisma.surgery.findUnique({
        where: { id: req.body.surgeryId },
        select: { id: true },
      });
      if (!surgery) {
        res.status(404).json({
          success: false,
          data: null,
          error: "Surgery not found",
        });
        return;
      }

      const implant = await prisma.implant.create({
        data: {
          surgeryId: req.body.surgeryId,
          category: req.body.category,
          manufacturer: req.body.manufacturer,
          productName: req.body.productName,
          modelNumber: req.body.modelNumber,
          lotNumber: req.body.lotNumber,
          serialNumber: req.body.serialNumber,
          expiryDate: req.body.expiryDate ? new Date(req.body.expiryDate) : null,
          notes: req.body.notes,
          createdById: userId,
        },
      });

      await auditLog(req, "IMPLANT_REGISTER", "implant", implant.id, {
        surgeryId: implant.surgeryId,
        category: implant.category,
        manufacturer: implant.manufacturer,
        lotNumber: implant.lotNumber,
      });

      res.status(201).json({ success: true, data: implant, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/implants?surgeryId=... | ?lotNumber=...
router.get(
  "/",
  authorize(Role.ADMIN, Role.DOCTOR, Role.NURSE),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const surgeryId =
        typeof req.query.surgeryId === "string" ? req.query.surgeryId : undefined;
      const lotNumber =
        typeof req.query.lotNumber === "string" ? req.query.lotNumber : undefined;

      if (!surgeryId && !lotNumber) {
        res.status(400).json({
          success: false,
          data: null,
          error: "Either surgeryId or lotNumber query param is required",
        });
        return;
      }

      const where: Record<string, unknown> = {};
      if (surgeryId) where.surgeryId = surgeryId;
      if (lotNumber) where.lotNumber = lotNumber;

      const rows = await prisma.implant.findMany({
        where,
        orderBy: { implantedAt: "desc" },
      });

      res.json({ success: true, data: rows, error: null });
    } catch (err) {
      next(err);
    }
  }
);

export { router as implantsRouter };
