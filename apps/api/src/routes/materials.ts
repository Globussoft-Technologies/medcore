// Material catalog module (2026-07) — general materials (medicine, consumable,
// equipment, instrument, machine) that departments requisition against.
//
// What: CRUD + stock-adjust for Material; a low-stock helper; all reads/writes
//   via the tenant-scoped Prisma client. Stock is self-contained on the row
//   (quantity + reservedStock); the requisition module reserves on approve and
//   deducts on issue (see routes/requisitions.ts).
// Why: one catalog for every material type, feeding the requisition picker
//   alongside pharmacy inventory (the picker shows BOTH sources).
//
// RBAC:
//   • create / update / delete / adjust-stock → ADMIN, PHARMACIST (store side)
//   • list / get                              → the requisition READ roles
//     (ADMIN, PHARMACIST, NURSE, DOCTOR, RECEPTION, LAB_TECH)

import { Router, Request, Response, NextFunction } from "express";
import { tenantScopedPrisma as prisma } from "@medcore/db";
import {
  Role,
  createMaterialSchema,
  updateMaterialSchema,
  adjustMaterialStockSchema,
} from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { auditLog } from "../middleware/audit";

const router = Router();
router.use(authenticate);

const STORE_ROLES = [Role.ADMIN, Role.PHARMACIST] as const;
const READ_ROLES = [
  Role.ADMIN,
  Role.PHARMACIST,
  Role.NURSE,
  Role.DOCTOR,
  Role.RECEPTION,
  Role.LAB_TECH,
] as const;

// ── GET / — list materials (search + category + active filters) ────────────
router.get(
  "/",
  authorize(...READ_ROLES),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { q, category, active } = req.query as Record<string, string | undefined>;
      const where: Record<string, unknown> = {};
      if (category) where.category = category;
      if (active === "true") where.active = true;
      if (active === "false") where.active = false;
      if (q && q.trim()) {
        where.OR = [
          { name: { contains: q.trim(), mode: "insensitive" } },
          { sku: { contains: q.trim(), mode: "insensitive" } },
        ];
      }
      const materials = await prisma.material.findMany({
        where,
        orderBy: [{ active: "desc" }, { name: "asc" }],
      });
      res.json({ success: true, data: materials, error: null });
    } catch (err) {
      next(err);
    }
  },
);

// ── POST / — create a material (store) ─────────────────────────────────────
router.post(
  "/",
  authorize(...STORE_ROLES),
  validate(createMaterialSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = req.body as {
        name: string;
        sku?: string;
        category: string;
        unit: string;
        quantity: number;
        reorderLevel: number;
        unitCost?: number;
        location?: string;
      };

      // Friendly 409 on a duplicate NAME (case-insensitive) within the tenant.
      const nameClash = await prisma.material.findFirst({
        where: { name: { equals: body.name, mode: "insensitive" } },
        select: { id: true },
      });
      if (nameClash) {
        res.status(409).json({
          success: false,
          data: null,
          error: `A material named "${body.name}" already exists`,
        });
        return;
      }

      // Friendly 409 on the (tenant, sku) unique clash when an SKU is given.
      if (body.sku) {
        const clash = await prisma.material.findFirst({
          where: { sku: { equals: body.sku, mode: "insensitive" } },
          select: { id: true },
        });
        if (clash) {
          res.status(409).json({
            success: false,
            data: null,
            error: `A material with SKU "${body.sku}" already exists`,
          });
          return;
        }
      }

      const material = await prisma.material.create({
        data: {
          name: body.name,
          sku: body.sku ?? null,
          category: body.category as never,
          unit: body.unit,
          quantity: body.quantity ?? 0,
          reorderLevel: body.reorderLevel ?? 10,
          unitCost: body.unitCost ?? null,
          location: body.location ?? null,
        },
      });

      // Opening-stock ledger row when created with a quantity.
      if (material.quantity > 0 && req.user?.userId) {
        await prisma.materialMovement.create({
          data: {
            materialId: material.id,
            type: "PURCHASE" as never,
            quantity: material.quantity,
            reason: "Opening stock",
            performedBy: req.user.userId,
          },
        });
      }
      await auditLog(req, "MATERIAL_CREATE", "Material", material.id, {
        name: body.name,
        category: body.category,
      });
      res.status(201).json({ success: true, data: material, error: null });
    } catch (err) {
      next(err);
    }
  },
);

// ── PATCH /:id — update a material (store) ─────────────────────────────────
router.patch(
  "/:id",
  authorize(...STORE_ROLES),
  validate(updateMaterialSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const current = await prisma.material.findUnique({
        where: { id: req.params.id },
        select: { id: true },
      });
      if (!current) {
        res.status(404).json({ success: false, data: null, error: "Material not found" });
        return;
      }
      const body = req.body as Record<string, unknown>;
      // Block renaming to a name another material already uses.
      if (typeof body.name === "string" && body.name) {
        const nameClash = await prisma.material.findFirst({
          where: {
            name: { equals: body.name, mode: "insensitive" },
            id: { not: req.params.id },
          },
          select: { id: true },
        });
        if (nameClash) {
          res.status(409).json({
            success: false,
            data: null,
            error: `A material named "${body.name}" already exists`,
          });
          return;
        }
      }
      if (typeof body.sku === "string" && body.sku) {
        const clash = await prisma.material.findFirst({
          where: {
            sku: { equals: body.sku, mode: "insensitive" },
            id: { not: req.params.id },
          },
          select: { id: true },
        });
        if (clash) {
          res.status(409).json({
            success: false,
            data: null,
            error: `A material with SKU "${body.sku}" already exists`,
          });
          return;
        }
      }
      const material = await prisma.material.update({
        where: { id: req.params.id },
        data: body,
      });
      await auditLog(req, "MATERIAL_UPDATE", "Material", material.id, body);
      res.json({ success: true, data: material, error: null });
    } catch (err) {
      next(err);
    }
  },
);

// ── POST /:id/adjust-stock — add / correct on-hand (store) ─────────────────
router.post(
  "/:id/adjust-stock",
  authorize(...STORE_ROLES),
  validate(adjustMaterialStockSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { delta, reason } = req.body as { delta: number; reason?: string };
      const material = await prisma.material.findUnique({
        where: { id: req.params.id },
      });
      if (!material) {
        res.status(404).json({ success: false, data: null, error: "Material not found" });
        return;
      }
      const newQty = material.quantity + delta;
      // Never let on-hand drop below what's already reserved for approvals.
      if (newQty < material.reservedStock) {
        res.status(409).json({
          success: false,
          data: null,
          error: `Cannot reduce below reserved stock (${material.reservedStock} reserved)`,
        });
        return;
      }
      const updated = await prisma.$transaction(async (tx) => {
        const m = await tx.material.update({
          where: { id: req.params.id },
          data: { quantity: { increment: delta } },
        });
        if (req.user?.userId) {
          await tx.materialMovement.create({
            data: {
              materialId: m.id,
              type: (delta > 0 ? "PURCHASE" : "ADJUSTMENT") as never,
              quantity: delta,
              reason: reason ?? (delta > 0 ? "Stock added" : "Stock correction"),
              performedBy: req.user.userId,
            },
          });
        }
        return m;
      });
      await auditLog(req, "MATERIAL_STOCK_ADJUST", "Material", updated.id, {
        delta,
        reason,
      });
      res.json({ success: true, data: updated, error: null });
    } catch (err) {
      next(err);
    }
  },
);

// ── DELETE /:id — soft-delete if used, hard-delete if never requisitioned ──
router.delete(
  "/:id",
  authorize(...STORE_ROLES),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const material = await prisma.material.findUnique({
        where: { id: req.params.id },
        include: { _count: { select: { requisitionItems: true } } },
      });
      if (!material) {
        res.status(404).json({ success: false, data: null, error: "Material not found" });
        return;
      }
      if (material._count.requisitionItems > 0) {
        const updated = await prisma.material.update({
          where: { id: req.params.id },
          data: { active: false },
        });
        await auditLog(req, "MATERIAL_DEACTIVATE", "Material", material.id, {
          reason: "has requisition history",
        });
        res.json({ success: true, data: { ...updated, softDeleted: true }, error: null });
        return;
      }
      await prisma.materialMovement.deleteMany({ where: { materialId: req.params.id } });
      await prisma.material.delete({ where: { id: req.params.id } });
      await auditLog(req, "MATERIAL_DELETE", "Material", material.id, {
        name: material.name,
      });
      res.json({ success: true, data: { id: material.id, hardDeleted: true }, error: null });
    } catch (err) {
      next(err);
    }
  },
);

export { router as materialsRouter };
