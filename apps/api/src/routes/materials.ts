// Material catalog module (2026-07) — general non-medicine materials
// (consumable, equipment, instrument, machine) that departments requisition
// against.
//
// What: CRUD + stock-adjust for Material; a low-stock helper; all reads/writes
//   via the tenant-scoped Prisma client. Stock is self-contained on the row
//   (quantity + reservedStock); the requisition module reserves on approve and
//   deducts on issue (see routes/requisitions.ts).
// Why: one catalog for non-pharmacy store items, while medicines stay in the
//   dedicated pharmacy inventory flow. The requisition picker can still merge
//   both sources independently where needed.
//
// RBAC:
//   • create / update / delete / adjust-stock → ADMIN, PHARMACIST (store side)
//   • list / get                              → the requisition READ roles
//     (ADMIN, PHARMACIST, NURSE, DOCTOR, RECEPTION, LAB_TECH)

import { Router, Request, Response, NextFunction } from "express";
import { prisma as rootPrisma, tenantScopedPrisma as prisma } from "@medcore/db";
import {
  Role,
  createMaterialSchema,
  updateMaterialSchema,
  adjustMaterialStockSchema,
  createMaterialAdjustmentRequestSchema,
  reviewMaterialAdjustmentRequestSchema,
} from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { auditLog } from "../middleware/audit";
import { allowedDepartmentIds, isMemberOf } from "../services/department-scope";

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

function canManageMaterialsDirectly(role: Role | string | undefined) {
  return role === Role.ADMIN || role === Role.PHARMACIST;
}

function canRequestDepartmentAdjustment(role: Role | string | undefined) {
  return (
    role === Role.DOCTOR ||
    role === Role.NURSE ||
    role === Role.RECEPTION ||
    role === Role.LAB_TECH
  );
}

function describeAdjustmentReason(
  reasonCode: string,
  note?: string | null,
): string {
  const base =
    {
      DAMAGED: "Damaged stock",
      CORRECTION: "Stock correction",
      FOUND: "Found stock",
      TRANSFER_IN: "Transfer in",
      TRANSFER_OUT: "Transfer out",
      OTHER: "Manual adjustment",
    }[reasonCode] ?? "Stock adjustment";
  return note?.trim() ? `${base} - ${note.trim()}` : base;
}

function movementTypeForReason(reasonCode: string, delta: number) {
  if (reasonCode === "DAMAGED") return "DAMAGED" as const;
  if (reasonCode === "TRANSFER_IN" || reasonCode === "TRANSFER_OUT") {
    return "TRANSFER" as const;
  }
  if (delta > 0) return "PURCHASE" as const;
  return "ADJUSTMENT" as const;
}

// ── GET / — list materials (search + category + active filters) ────────────
router.get(
  "/",
  authorize(...READ_ROLES),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { q, category, active, includeDepartments, forRequisition } =
        req.query as Record<string, string | undefined>;
      const requisitionPicker = forRequisition === "true";
      const where: Record<string, unknown> = {
        AND: [
          { category: { not: "MEDICINE" } },
          ...(category ? [{ category }] : []),
        ],
      };
      if (active === "true") where.active = true;
      if (active === "false") where.active = false;
      if (q && q.trim()) {
        where.OR = [
          { name: { contains: q.trim(), mode: "insensitive" } },
          { sku: { contains: q.trim(), mode: "insensitive" } },
        ];
      }
      const manageDirectly = canManageMaterialsDirectly(req.user?.role);
      const allowedDepartments = manageDirectly
        ? null
        : await allowedDepartmentIds(req.user?.userId, req.user?.role);

      if (allowedDepartments !== null && allowedDepartments.length === 0) {
        res.json({
          success: true,
          data: [],
          meta: {
            departments: [],
            canManageDirectly: false,
            canRequestAdjustments: canRequestDepartmentAdjustment(req.user?.role),
            canApproveAdjustmentRequests: false,
            notInAnyDepartment: true,
          },
          error: null,
        });
        return;
      }

      const scopedWhere =
        allowedDepartments === null || requisitionPicker
          ? where
          : {
              ...where,
              active: true,
              departmentHoldings: {
                some: {
                  departmentId: { in: allowedDepartments },
                  quantity: { gt: 0 },
                },
              },
            };

      const [materials, departments] = await Promise.all([
        prisma.material.findMany({
          where: scopedWhere,
          orderBy: [{ active: "desc" }, { name: "asc" }],
          include: {
            departmentHoldings: {
              where: {
                quantity: { gt: 0 },
                ...(allowedDepartments === null
                  ? {}
                  : { departmentId: { in: allowedDepartments } }),
              },
              select: {
                departmentId: true,
                quantity: true,
                department: {
                  select: { id: true, name: true, code: true, active: true },
                },
              },
            },
          },
        }),
        includeDepartments === "true"
          ? prisma.department.findMany({
              where: {
                active: true,
                ...(allowedDepartments === null
                  ? {}
                  : { id: { in: allowedDepartments } }),
              },
              orderBy: { name: "asc" },
              select: { id: true, name: true, code: true },
            })
          : Promise.resolve([] as Array<{ id: string; name: string; code: string }>),
      ]);

      const data = materials.map((material) => {
        const departmentQuantities = material.departmentHoldings
          .filter((holding) => holding.department?.active !== false && holding.quantity > 0)
          .map((holding) => ({
            departmentId: holding.departmentId,
            departmentName: holding.department?.name ?? "Department",
            departmentCode: holding.department?.code ?? "",
            quantity: holding.quantity,
          }));
        const departmentQuantity = departmentQuantities.reduce(
          (sum, holding) => sum + holding.quantity,
          0,
        );
        return {
          ...material,
          mainQuantity: manageDirectly || requisitionPicker ? material.quantity : 0,
          totalQuantity: manageDirectly
            ? material.quantity + departmentQuantity
            : requisitionPicker
              ? material.quantity
            : departmentQuantity,
          departmentQuantities,
        };
      });

      res.json({
        success: true,
        data,
        meta: {
          departments,
          canManageDirectly: manageDirectly,
          canRequestAdjustments: !manageDirectly && canRequestDepartmentAdjustment(req.user?.role),
          canApproveAdjustmentRequests: req.user?.role === Role.ADMIN,
          notInAnyDepartment: false,
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  },
);

router.get(
  "/adjustment-requests",
  authorize(...READ_ROLES),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const manageDirectly = canManageMaterialsDirectly(req.user?.role);
      const allowedDepartments = manageDirectly
        ? null
        : await allowedDepartmentIds(req.user?.userId, req.user?.role);
      if (allowedDepartments !== null && allowedDepartments.length === 0) {
        res.json({ success: true, data: [], error: null });
        return;
      }

      const { status } = req.query as { status?: string };
      const rows = await prisma.materialAdjustmentRequest.findMany({
        where: {
          ...(status ? { status: status as never } : {}),
          ...(allowedDepartments === null
            ? {}
            : { departmentId: { in: allowedDepartments } }),
        },
        orderBy: [{ status: "asc" }, { createdAt: "desc" }],
        include: {
          material: { select: { id: true, name: true, unit: true } },
          department: { select: { id: true, name: true, code: true } },
          requestedBy: { select: { id: true, name: true, role: true } },
          reviewedBy: { select: { id: true, name: true, role: true } },
        },
      });
      res.json({ success: true, data: rows, error: null });
    } catch (err) {
      next(err);
    }
  },
);

router.post(
  "/:id/adjustment-requests",
  authorize(...READ_ROLES),
  validate(createMaterialAdjustmentRequestSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!canRequestDepartmentAdjustment(req.user?.role)) {
        res.status(403).json({
          success: false,
          data: null,
          error: "Only assigned department staff can request stock reductions",
        });
        return;
      }

      const material = await prisma.material.findUnique({
        where: { id: req.params.id },
        select: { id: true, name: true, active: true, category: true },
      });
      if (!material || !material.active || material.category === "MEDICINE") {
        res.status(404).json({ success: false, data: null, error: "Material not found" });
        return;
      }

      const { departmentId, delta, reasonCode, reasonNote } = req.body as {
        departmentId: string;
        delta: number;
        reasonCode: string;
        reasonNote?: string;
      };
      if (!(await isMemberOf(req.user?.userId, req.user?.role, departmentId))) {
        res.status(403).json({
          success: false,
          data: null,
          error: "You can only request an adjustment for your assigned department",
        });
        return;
      }

      const holding = await prisma.departmentMaterialHolding.findUnique({
        where: { departmentId_materialId: { departmentId, materialId: material.id } },
        include: { department: { select: { name: true } } },
      });
      const currentQty = holding?.quantity ?? 0;
      if (currentQty + delta < 0) {
        res.status(409).json({
          success: false,
          data: null,
          error: `Cannot request more than ${currentQty} units from ${holding?.department.name ?? "this department"}`,
        });
        return;
      }

      const requestRow = await prisma.materialAdjustmentRequest.create({
        data: {
          materialId: material.id,
          departmentId,
          requestedById: req.user!.userId,
          delta,
          reasonCode,
          reasonNote: reasonNote ?? null,
          tenantId: req.tenantId ?? null,
        },
        include: {
          material: { select: { id: true, name: true, unit: true } },
          department: { select: { id: true, name: true, code: true } },
          requestedBy: { select: { id: true, name: true, role: true } },
        },
      });

      await auditLog(req, "MATERIAL_ADJUSTMENT_REQUEST_CREATE", "Material", material.id, {
        requestId: requestRow.id,
        departmentId,
        delta,
        reasonCode,
        reasonNote: reasonNote ?? null,
      });

      res.status(201).json({ success: true, data: requestRow, error: null });
    } catch (err) {
      next(err);
    }
  },
);

router.post(
  "/adjustment-requests/:requestId/review",
  authorize(Role.ADMIN),
  validate(reviewMaterialAdjustmentRequestSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const requestRow = await prisma.materialAdjustmentRequest.findUnique({
        where: { id: req.params.requestId },
        include: {
          material: { select: { id: true, name: true } },
          department: { select: { id: true, name: true } },
        },
      });
      if (!requestRow) {
        res.status(404).json({ success: false, data: null, error: "Adjustment request not found" });
        return;
      }
      if (requestRow.status !== "PENDING") {
        res.status(409).json({ success: false, data: null, error: "Adjustment request already reviewed" });
        return;
      }

      const { status, reviewedNote } = req.body as {
        status: "APPROVED" | "REJECTED";
        reviewedNote?: string;
      };

      const updated = await prisma.$transaction(async (tx) => {
        if (status === "APPROVED") {
          const holding = await tx.departmentMaterialHolding.findUnique({
            where: {
              departmentId_materialId: {
                departmentId: requestRow.departmentId,
                materialId: requestRow.materialId,
              },
            },
          });
          const currentQty = holding?.quantity ?? 0;
          const nextQty = currentQty + requestRow.delta;
          if (nextQty < 0) {
            throw new Error(
              `Cannot approve request: ${requestRow.department.name} only has ${currentQty} units on hand`,
            );
          }

          await tx.departmentMaterialHolding.upsert({
            where: {
              departmentId_materialId: {
                departmentId: requestRow.departmentId,
                materialId: requestRow.materialId,
              },
            },
            update: { quantity: nextQty },
            create: {
              departmentId: requestRow.departmentId,
              materialId: requestRow.materialId,
              quantity: nextQty,
              tenantId: req.tenantId ?? null,
            },
          });

          await tx.departmentMaterialMovement.create({
            data: {
              departmentId: requestRow.departmentId,
              materialId: requestRow.materialId,
              type: movementTypeForReason(requestRow.reasonCode, requestRow.delta) as never,
              quantity: requestRow.delta,
              referenceId: requestRow.id,
              reason: describeAdjustmentReason(requestRow.reasonCode, requestRow.reasonNote),
              performedBy: req.user!.userId,
              tenantId: req.tenantId ?? null,
            },
          });
        }

        return tx.materialAdjustmentRequest.update({
          where: { id: requestRow.id },
          data: {
            status,
            reviewedById: req.user!.userId,
            reviewedAt: new Date(),
            reviewedNote: reviewedNote ?? null,
          },
          include: {
            material: { select: { id: true, name: true, unit: true } },
            department: { select: { id: true, name: true, code: true } },
            requestedBy: { select: { id: true, name: true, role: true } },
            reviewedBy: { select: { id: true, name: true, role: true } },
          },
        });
      });

      await auditLog(req, `MATERIAL_ADJUSTMENT_REQUEST_${status}`, "Material", requestRow.materialId, {
        requestId: requestRow.id,
        departmentId: requestRow.departmentId,
        delta: requestRow.delta,
        reasonCode: requestRow.reasonCode,
        reviewedNote: reviewedNote ?? null,
      });

      res.json({ success: true, data: updated, error: null });
    } catch (err) {
      if (err instanceof Error) {
        res.status(409).json({ success: false, data: null, error: err.message });
        return;
      }
      next(err);
    }
  },
);

router.get(
  "/:id/logs",
  authorize(...READ_ROLES),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const material = await prisma.material.findUnique({
        where: { id: req.params.id },
        select: { id: true, name: true },
      });
      if (!material) {
        res.status(404).json({ success: false, data: null, error: "Material not found" });
        return;
      }

      const manageDirectly = canManageMaterialsDirectly(req.user?.role);
      const allowedDepartments = manageDirectly
        ? null
        : await allowedDepartmentIds(req.user?.userId, req.user?.role);
      if (allowedDepartments !== null) {
        if (allowedDepartments.length === 0) {
          res.status(404).json({ success: false, data: null, error: "Material not found" });
          return;
        }
        const visibleHolding = await prisma.departmentMaterialHolding.findFirst({
          where: {
            materialId: material.id,
            departmentId: { in: allowedDepartments },
            quantity: { gt: 0 },
          },
          select: { id: true },
        });
        if (!visibleHolding) {
          res.status(404).json({ success: false, data: null, error: "Material not found" });
          return;
        }
      }

      const [auditRows, mainMovements, departmentMovements] = await Promise.all([
        rootPrisma.auditLog.findMany({
          where: {
            tenantId: req.tenantId ?? null,
            entity: "Material",
            entityId: material.id,
          },
          orderBy: { createdAt: "desc" },
          take: 50,
        }),
        manageDirectly
          ? prisma.materialMovement.findMany({
              where: { materialId: material.id },
              orderBy: { createdAt: "desc" },
              take: 50,
            })
          : Promise.resolve([]),
        prisma.departmentMaterialMovement.findMany({
          where: {
            materialId: material.id,
            ...(allowedDepartments === null
              ? {}
              : { departmentId: { in: allowedDepartments } }),
          },
          include: { department: { select: { name: true, code: true } } },
          orderBy: { createdAt: "desc" },
          take: 50,
        }),
      ]);

      const actorIds = new Set<string>();
      for (const row of auditRows) if (row.userId) actorIds.add(row.userId);
      for (const row of mainMovements) actorIds.add(row.performedBy);
      for (const row of departmentMovements) actorIds.add(row.performedBy);

      const users = actorIds.size
        ? await prisma.user.findMany({
            where: { id: { in: [...actorIds] } },
            select: { id: true, name: true, role: true },
          })
        : [];
      const userMap = new Map(users.map((user) => [user.id, user]));

      const timeline = [
        ...auditRows.map((row) => ({
          id: `audit-${row.id}`,
          kind: "AUDIT",
          action: row.action,
          actor: row.userId ? userMap.get(row.userId) ?? { id: row.userId, name: row.userId, role: "USER" } : null,
          occurredAt: row.createdAt,
          details: row.details,
        })),
        ...mainMovements.map((row) => ({
          id: `main-${row.id}`,
          kind: "MAIN_MOVEMENT",
          action: row.type,
          actor: userMap.get(row.performedBy) ?? { id: row.performedBy, name: row.performedBy, role: "USER" },
          occurredAt: row.createdAt,
          details: { quantity: row.quantity, reason: row.reason, referenceId: row.referenceId },
        })),
        ...departmentMovements.map((row) => ({
          id: `dept-${row.id}`,
          kind: "DEPARTMENT_MOVEMENT",
          action: row.type,
          actor: userMap.get(row.performedBy) ?? { id: row.performedBy, name: row.performedBy, role: "USER" },
          occurredAt: row.createdAt,
          details: {
            quantity: row.quantity,
            reason: row.reason,
            referenceId: row.referenceId,
            departmentName: row.department.name,
            departmentCode: row.department.code,
          },
        })),
      ].sort((a, b) => +new Date(b.occurredAt) - +new Date(a.occurredAt));

      res.json({ success: true, data: { material, timeline }, error: null });
    } catch (err) {
      next(err);
    }
  },
);

router.post(
  "/:id/set-active",
  authorize(...STORE_ROLES),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const active = Boolean((req.body as { active?: boolean }).active);
      const material = await prisma.material.findUnique({
        where: { id: req.params.id },
        select: { id: true, name: true, active: true },
      });
      if (!material) {
        res.status(404).json({ success: false, data: null, error: "Material not found" });
        return;
      }
      if (material.active === active) {
        res.json({ success: true, data: material, error: null });
        return;
      }
      const updated = await prisma.material.update({
        where: { id: material.id },
        data: { active },
      });
      await auditLog(
        req,
        active ? "MATERIAL_ACTIVATE" : "MATERIAL_DEACTIVATE",
        "Material",
        material.id,
        { name: material.name },
      );
      res.json({ success: true, data: updated, error: null });
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
      const {
        locationType,
        departmentId,
        delta,
        reasonCode,
        reasonNote,
      } = req.body as {
        locationType: "MAIN" | "DEPARTMENT";
        departmentId?: string;
        delta: number;
        reasonCode: string;
        reasonNote?: string;
      };
      const material = await prisma.material.findUnique({
        where: { id: req.params.id },
      });
      if (!material) {
        res.status(404).json({ success: false, data: null, error: "Material not found" });
        return;
      }
      const reason = describeAdjustmentReason(reasonCode, reasonNote);
      const movementType = movementTypeForReason(reasonCode, delta);

      const updated = await prisma.$transaction(async (tx) => {
        if (locationType === "MAIN") {
          const newQty = material.quantity + delta;
          if (newQty < material.reservedStock) {
            throw new Error(
              `Cannot reduce below reserved stock (${material.reservedStock} reserved)`,
            );
          }
          const m = await tx.material.update({
            where: { id: req.params.id },
            data: { quantity: { increment: delta } },
          });
          if (req.user?.userId) {
            await tx.materialMovement.create({
              data: {
                materialId: m.id,
                type: movementType as never,
                quantity: delta,
                reason,
                performedBy: req.user.userId,
                tenantId: req.tenantId ?? null,
              },
            });
          }
          return {
            id: m.id,
            locationType,
            departmentId: null,
            quantity: m.quantity,
          };
        }

        const department = await tx.department.findUnique({
          where: { id: departmentId! },
          select: { id: true, name: true },
        });
        if (!department) throw new Error("Department not found");

        const currentHolding = await tx.departmentMaterialHolding.findUnique({
          where: {
            departmentId_materialId: {
              departmentId: department.id,
              materialId: material.id,
            },
          },
        });
        const currentQty = currentHolding?.quantity ?? 0;
        const nextQty = currentQty + delta;
        if (nextQty < 0) {
          throw new Error(
            `Cannot reduce below zero for ${department.name} (${currentQty} on hand)`,
          );
        }

        const holding = currentHolding
          ? await tx.departmentMaterialHolding.update({
              where: { id: currentHolding.id },
              data: { quantity: nextQty },
            })
          : await tx.departmentMaterialHolding.create({
              data: {
                departmentId: department.id,
                materialId: material.id,
                quantity: nextQty,
                tenantId: req.tenantId ?? null,
              },
            });
        if (req.user?.userId) {
          await tx.departmentMaterialMovement.create({
            data: {
              departmentId: department.id,
              materialId: material.id,
              type: movementType as never,
              quantity: delta,
              referenceId: material.id,
              reason,
              performedBy: req.user.userId,
              tenantId: req.tenantId ?? null,
            },
          });
        }
        return {
          id: material.id,
          locationType,
          departmentId: department.id,
          quantity: holding.quantity,
        };
      });
      await auditLog(req, "MATERIAL_STOCK_ADJUST", "Material", updated.id, {
        locationType,
        departmentId: departmentId ?? null,
        delta,
        reasonCode,
        reason,
      });
      res.json({ success: true, data: updated, error: null });
    } catch (err) {
      if (err instanceof Error) {
        const status = /not found/i.test(err.message) ? 404 : 409;
        res.status(status).json({ success: false, data: null, error: err.message });
        return;
      }
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
