import { Router, Request, Response, NextFunction } from "express";
import { prisma } from "@medcore/db";
import {
  Role,
  createAssetSchema,
  updateAssetSchema,
  assignAssetSchema,
  returnAssetSchema,
  maintenanceLogSchema,
  assetTransferSchema,
  assetDisposalSchema,
  calibrationScheduleSchema,
} from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { auditLog } from "../middleware/audit";

const router = Router();
router.use(authenticate);

// ───────────────────────────────────────────────────────
// MAINTENANCE & WARRANTY (specific routes first)
// ───────────────────────────────────────────────────────

router.get(
  "/maintenance/due",
  // Issue #174 (Apr 30 2026): assets module is admin/ops-only — clinical roles
  // do not need fleet/biomedical inventory data.
  authorize(Role.ADMIN, Role.RECEPTION),
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const now = new Date();
      const soon = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

      const assets = await prisma.asset.findMany({
        where: {
          maintenance: {
            some: { nextDueDate: { lte: soon } },
          },
        },
        include: {
          maintenance: {
            orderBy: { performedAt: "desc" },
            take: 1,
          },
        },
        orderBy: { name: "asc" },
      });

      // Filter to those whose latest nextDueDate <= soon
      const due = assets.filter((a) => {
        const latest = a.maintenance[0];
        return latest?.nextDueDate && latest.nextDueDate <= soon;
      });

      res.json({ success: true, data: due, error: null });
    } catch (err) {
      next(err);
    }
  }
);

router.get(
  "/warranty/expiring",
  // Issue #174: warranty data is admin/ops only.
  authorize(Role.ADMIN, Role.RECEPTION),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { days = "30" } = req.query as Record<string, string | undefined>;
      const n = parseInt(days || "30");
      const now = new Date();
      const soon = new Date(now.getTime() + n * 24 * 60 * 60 * 1000);

      const assets = await prisma.asset.findMany({
        where: {
          warrantyExpiry: { lte: soon, gte: now },
        },
        orderBy: { warrantyExpiry: "asc" },
      });

      res.json({ success: true, data: assets, error: null });
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  "/maintenance",
  authorize(Role.ADMIN),
  validate(maintenanceLogSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { assetId, nextDueDate, ...rest } = req.body;

      const log = await prisma.$transaction(async (tx) => {
        const m = await tx.assetMaintenance.create({
          data: {
            assetId,
            ...rest,
            performedBy: req.user!.userId,
            nextDueDate: nextDueDate ? new Date(nextDueDate) : null,
          },
        });

        // Maintenance just logged — asset goes back to IDLE (or stays IN_USE if assigned)
        const activeAssignment = await tx.assetAssignment.findFirst({
          where: { assetId, returnedAt: null },
        });
        await tx.asset.update({
          where: { id: assetId },
          data: { status: activeAssignment ? "IN_USE" : "IDLE" },
        });

        return m;
      });

      auditLog(req, "ASSET_MAINTENANCE_LOG", "asset_maintenance", log.id, {
        assetId,
        type: rest.type,
      }).catch(console.error);

      res.status(201).json({ success: true, data: log, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// ───────────────────────────────────────────────────────
// ASSETS
// ───────────────────────────────────────────────────────

router.get("/", authorize(Role.ADMIN, Role.RECEPTION), async (req: Request, res: Response, next: NextFunction) => {
  // Issue #174 (Apr 30 2026): asset list exposes serial numbers, purchase
  // costs, current assignees. Restrict to admin + reception (the two roles
  // that own assignment + procurement workflows).
  try {
    const {
      search,
      category,
      status,
      page = "1",
      limit = "20",
    } = req.query as Record<string, string | undefined>;
    const skip = (parseInt(page || "1") - 1) * parseInt(limit || "20");
    const take = Math.min(parseInt(limit || "20"), 100);

    const where: Record<string, unknown> = {};
    if (category) where.category = category;
    if (status) where.status = status;
    if (search) {
      where.OR = [
        { name: { contains: search, mode: "insensitive" } },
        { assetTag: { contains: search, mode: "insensitive" } },
        { serialNumber: { contains: search, mode: "insensitive" } },
      ];
    }

    const [assets, total] = await Promise.all([
      prisma.asset.findMany({
        where,
        skip,
        take,
        orderBy: { createdAt: "desc" },
        include: {
          assignments: {
            where: { returnedAt: null },
            take: 1,
            include: {
              assignee: { select: { id: true, name: true, role: true } },
            },
          },
        },
      }),
      prisma.asset.count({ where }),
    ]);

    res.json({
      success: true,
      data: assets,
      error: null,
      meta: { page: parseInt(page || "1"), limit: take, total },
    });
  } catch (err) {
    next(err);
  }
});

router.post(
  "/",
  authorize(Role.ADMIN),
  validate(createAssetSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { purchaseDate, warrantyExpiry, amcExpiryDate, ...rest } = req.body;
      const asset = await prisma.asset.create({
        data: {
          ...rest,
          purchaseDate: purchaseDate ? new Date(purchaseDate) : null,
          warrantyExpiry: warrantyExpiry ? new Date(warrantyExpiry) : null,
          amcExpiryDate: amcExpiryDate ? new Date(amcExpiryDate) : null,
        },
      });

      auditLog(req, "ASSET_CREATE", "asset", asset.id, {
        assetTag: asset.assetTag,
      }).catch(console.error);

      res.status(201).json({ success: true, data: asset, error: null });
    } catch (err) {
      next(err);
    }
  }
);

router.get("/:id", authorize(Role.ADMIN, Role.RECEPTION), async (req: Request, res: Response, next: NextFunction) => {
  // Issue #174: detail view includes assignment history + maintenance log.
  try {
    const asset = await prisma.asset.findUnique({
      where: { id: req.params.id },
      include: {
        assignments: {
          orderBy: { assignedAt: "desc" },
          include: {
            assignee: { select: { id: true, name: true, role: true } },
          },
        },
        maintenance: {
          orderBy: { performedAt: "desc" },
          include: {
            technician: { select: { id: true, name: true } },
          },
        },
      },
    });
    if (!asset) {
      res
        .status(404)
        .json({ success: false, data: null, error: "Asset not found" });
      return;
    }
    res.json({ success: true, data: asset, error: null });
  } catch (err) {
    next(err);
  }
});

router.patch(
  "/:id",
  authorize(Role.ADMIN),
  validate(updateAssetSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { purchaseDate, warrantyExpiry, amcExpiryDate, ...rest } = req.body;

      // Issue #59 (Apr 2026): when an asset transitions to RETIRED, any
      // active assignment must be closed. Previously the assignment row
      // stayed open with returnedAt=null so the asset list still rendered
      // the (now meaningless) "Assigned to: Dr. Foo" column for retired
      // gear. Wrap the update in a tx so the closure is atomic with the
      // status change.
      const asset = await prisma.$transaction(async (tx) => {
        const updated = await tx.asset.update({
          where: { id: req.params.id },
          data: {
            ...rest,
            ...(purchaseDate !== undefined
              ? { purchaseDate: purchaseDate ? new Date(purchaseDate) : null }
              : {}),
            ...(warrantyExpiry !== undefined
              ? { warrantyExpiry: warrantyExpiry ? new Date(warrantyExpiry) : null }
              : {}),
            ...(amcExpiryDate !== undefined
              ? { amcExpiryDate: amcExpiryDate ? new Date(amcExpiryDate) : null }
              : {}),
          },
        });
        if (rest.status === "RETIRED") {
          await tx.assetAssignment.updateMany({
            where: { assetId: updated.id, returnedAt: null },
            data: {
              returnedAt: new Date(),
              notes: "Auto-closed: asset retired",
            },
          });
        }
        return updated;
      });

      auditLog(req, "ASSET_UPDATE", "asset", asset.id, req.body).catch(
        console.error
      );

      res.json({ success: true, data: asset, error: null });
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  "/:id/assign",
  authorize(Role.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const assetId = req.params.id;
      const parsed = assignAssetSchema.parse({ ...req.body, assetId });

      const result = await prisma.$transaction(async (tx) => {
        // Close any active assignment
        await tx.assetAssignment.updateMany({
          where: { assetId, returnedAt: null },
          data: { returnedAt: new Date() },
        });

        const assignment = await tx.assetAssignment.create({
          data: {
            assetId,
            assignedTo: parsed.assignedTo,
            location: parsed.location,
            notes: parsed.notes,
          },
          include: {
            assignee: { select: { id: true, name: true, role: true } },
          },
        });

        await tx.asset.update({
          where: { id: assetId },
          data: {
            status: "IN_USE",
            ...(parsed.location ? { location: parsed.location } : {}),
          },
        });

        return assignment;
      });

      auditLog(req, "ASSET_ASSIGN", "asset", assetId, {
        assignedTo: parsed.assignedTo,
      }).catch(console.error);

      res.status(201).json({ success: true, data: result, error: null });
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  "/:id/return",
  authorize(Role.ADMIN),
  validate(returnAssetSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const assetId = req.params.id;

      const active = await prisma.assetAssignment.findFirst({
        where: { assetId, returnedAt: null },
      });
      if (!active) {
        res.status(400).json({
          success: false,
          data: null,
          error: "No active assignment to return",
        });
        return;
      }

      const result = await prisma.$transaction(async (tx) => {
        const a = await tx.assetAssignment.update({
          where: { id: active.id },
          data: {
            returnedAt: new Date(),
            notes: req.body.notes ?? active.notes,
          },
        });
        await tx.asset.update({
          where: { id: assetId },
          data: { status: "IDLE" },
        });
        return a;
      });

      auditLog(req, "ASSET_RETURN", "asset", assetId).catch(console.error);

      res.json({ success: true, data: result, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// ───────────────────────────────────────────────────────
// DEPRECIATION (straight-line)
// ───────────────────────────────────────────────────────

router.get(
  "/:id/depreciation",
  // Issue #174: depreciation = financial data, ADMIN only.
  authorize(Role.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const asset = await prisma.asset.findUnique({
        where: { id: req.params.id },
      });
      if (!asset) {
        res.status(404).json({ success: false, data: null, error: "Asset not found" });
        return;
      }
      if (!asset.purchaseCost || !asset.purchaseDate || !asset.usefulLifeYears) {
        res.json({
          success: true,
          data: {
            asset,
            calculable: false,
            reason: "Requires purchaseCost, purchaseDate and usefulLifeYears",
          },
          error: null,
        });
        return;
      }
      const salvage = asset.salvageValue ?? 0;
      const perYear = (asset.purchaseCost - salvage) / asset.usefulLifeYears;
      const ageYears =
        (Date.now() - asset.purchaseDate.getTime()) / (365.25 * 24 * 3600 * 1000);
      const accumulated = Math.min(perYear * ageYears, asset.purchaseCost - salvage);
      const bookValue = Math.max(salvage, asset.purchaseCost - accumulated);
      res.json({
        success: true,
        data: {
          method: asset.depreciationMethod ?? "STRAIGHT_LINE",
          purchaseCost: asset.purchaseCost,
          salvageValue: salvage,
          usefulLifeYears: asset.usefulLifeYears,
          ageYears: Math.round(ageYears * 10) / 10,
          annualDepreciation: Math.round(perYear * 100) / 100,
          accumulatedDepreciation: Math.round(accumulated * 100) / 100,
          bookValue: Math.round(bookValue * 100) / 100,
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ───────────────────────────────────────────────────────
// AMC / CALIBRATION ALERTS
// ───────────────────────────────────────────────────────

router.get(
  "/amc/expiring",
  // Issue #174: AMC contract data — admin/ops only.
  authorize(Role.ADMIN, Role.RECEPTION),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { days = "60" } = req.query as Record<string, string | undefined>;
      const n = parseInt(days || "60");
      const now = new Date();
      const soon = new Date(now.getTime() + n * 24 * 3600 * 1000);
      const assets = await prisma.asset.findMany({
        where: { amcExpiryDate: { lte: soon, gte: now } },
        orderBy: { amcExpiryDate: "asc" },
      });
      res.json({ success: true, data: assets, error: null });
    } catch (err) {
      next(err);
    }
  }
);

router.get(
  "/calibration/due",
  // Issue #174: ops-only (biomedical engineer / admin).
  authorize(Role.ADMIN, Role.RECEPTION),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { days = "30" } = req.query as Record<string, string | undefined>;
      const n = parseInt(days || "30");
      const now = new Date();
      const soon = new Date(now.getTime() + n * 24 * 3600 * 1000);
      const assets = await prisma.asset.findMany({
        where: { nextCalibrationAt: { lte: soon } },
        orderBy: { nextCalibrationAt: "asc" },
      });
      res.json({ success: true, data: assets, error: null });
    } catch (err) {
      next(err);
    }
  }
);

router.patch(
  "/:id/calibration-schedule",
  authorize(Role.ADMIN),
  validate(calibrationScheduleSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { calibrationInterval, lastCalibrationAt } = req.body as {
        calibrationInterval: number;
        lastCalibrationAt?: string;
      };
      const last = lastCalibrationAt ? new Date(lastCalibrationAt) : new Date();
      const next = new Date(last.getTime() + calibrationInterval * 24 * 3600 * 1000);

      const asset = await prisma.asset.update({
        where: { id: req.params.id },
        data: {
          calibrationInterval,
          lastCalibrationAt: last,
          nextCalibrationAt: next,
        },
      });
      auditLog(req, "ASSET_CALIBRATION_SCHEDULE_SET", "asset", asset.id, {
        calibrationInterval,
      }).catch(console.error);
      res.json({ success: true, data: asset, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// ───────────────────────────────────────────────────────
// ASSET TRANSFER
// ───────────────────────────────────────────────────────

router.post(
  "/:id/transfer",
  authorize(Role.ADMIN),
  validate(assetTransferSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const asset = await prisma.asset.findUnique({ where: { id: req.params.id } });
      if (!asset) {
        res.status(404).json({ success: false, data: null, error: "Asset not found" });
        return;
      }

      const { toDepartment, toLocation, reason, notes } = req.body;
      const result = await prisma.$transaction(async (tx) => {
        const transfer = await tx.assetTransfer.create({
          data: {
            assetId: asset.id,
            fromDepartment: asset.department,
            toDepartment,
            fromLocation: asset.location,
            toLocation,
            reason,
            notes,
            transferredBy: req.user!.userId,
          },
        });
        await tx.asset.update({
          where: { id: asset.id },
          data: {
            department: toDepartment,
            ...(toLocation ? { location: toLocation } : {}),
          },
        });
        return transfer;
      });

      auditLog(req, "ASSET_TRANSFER", "asset", asset.id, {
        from: asset.department,
        to: toDepartment,
      }).catch(console.error);

      res.status(201).json({ success: true, data: result, error: null });
    } catch (err) {
      next(err);
    }
  }
);

router.get(
  "/:id/transfers",
  // Issue #174: ops-only.
  authorize(Role.ADMIN, Role.RECEPTION),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const transfers = await prisma.assetTransfer.findMany({
        where: { assetId: req.params.id },
        orderBy: { transferredAt: "desc" },
      });
      res.json({ success: true, data: transfers, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// ───────────────────────────────────────────────────────
// ASSET DISPOSAL
// ───────────────────────────────────────────────────────

router.post(
  "/:id/dispose",
  authorize(Role.ADMIN),
  validate(assetDisposalSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { method, disposalValue, notes } = req.body;
      // Issue #59: disposing == retiring. Close any active assignment in the
      // same tx so the asset doesn't keep its old assignee on the dashboard.
      const asset = await prisma.$transaction(async (tx) => {
        const a = await tx.asset.update({
          where: { id: req.params.id },
          data: {
            status: "RETIRED",
            disposedAt: new Date(),
            disposalMethod: method,
            disposalValue: disposalValue,
            disposalNotes: notes,
          },
        });
        await tx.assetAssignment.updateMany({
          where: { assetId: a.id, returnedAt: null },
          data: {
            returnedAt: new Date(),
            notes: "Auto-closed: asset disposed",
          },
        });
        return a;
      });
      auditLog(req, "ASSET_DISPOSE", "asset", asset.id, { method, disposalValue }).catch(
        console.error
      );
      res.json({ success: true, data: asset, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// ───────────────────────────────────────────────────────
// QR CODE PAYLOAD (client renders QR)
// ───────────────────────────────────────────────────────

router.get(
  "/:id/qr-payload",
  // Issue #174: QR payload reveals asset serial + tag.
  authorize(Role.ADMIN, Role.RECEPTION),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const asset = await prisma.asset.findUnique({
        where: { id: req.params.id },
        select: {
          id: true,
          assetTag: true,
          name: true,
          category: true,
          department: true,
          serialNumber: true,
        },
      });
      if (!asset) {
        res.status(404).json({ success: false, data: null, error: "Asset not found" });
        return;
      }
      // Include a URL the client can encode as QR
      const payload = {
        type: "ASSET",
        assetTag: asset.assetTag,
        id: asset.id,
        name: asset.name,
        url: `medcore://asset/${asset.id}`,
      };
      res.json({
        success: true,
        data: { asset, payload, qrText: JSON.stringify(payload) },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

export { router as assetsRouter };
