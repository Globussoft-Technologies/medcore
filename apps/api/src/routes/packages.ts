import { Router, Request, Response, NextFunction } from "express";
import { prisma } from "@medcore/db";
import {
  Role,
  createPackageSchema,
  updatePackageSchema,
  purchasePackageSchema,
  PACKAGE_NUMBER_PREFIX,
} from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { auditLog } from "../middleware/audit";

const router = Router();
router.use(authenticate);

// GET /api/v1/packages — list active packages (?category=)
router.get("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { category, includeInactive } = req.query as Record<string, string | undefined>;
    const where: Record<string, unknown> = {};
    if (!includeInactive) where.isActive = true;
    if (category) where.category = category;

    const packages = await prisma.healthPackage.findMany({
      where,
      orderBy: { createdAt: "desc" },
      include: { _count: { select: { purchases: true } } },
    });

    res.json({ success: true, data: packages, error: null });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/packages/purchases — list package purchases
router.get(
  "/purchases",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const {
        patientId,
        active,
        page = "1",
        limit = "20",
      } = req.query as Record<string, string | undefined>;

      const where: Record<string, unknown> = {};
      if (patientId) where.patientId = patientId;
      if (active === "true") {
        where.expiresAt = { gt: new Date() };
        where.isFullyUsed = false;
      }

      const skip = (parseInt(page || "1") - 1) * parseInt(limit || "20");
      const take = Math.min(parseInt(limit || "20"), 100);

      const [purchases, total] = await Promise.all([
        prisma.packagePurchase.findMany({
          where,
          include: {
            package: true,
            patient: {
              include: { user: { select: { name: true, phone: true } } },
            },
          },
          skip,
          take,
          orderBy: { purchasedAt: "desc" },
        }),
        prisma.packagePurchase.count({ where }),
      ]);

      res.json({
        success: true,
        data: purchases,
        error: null,
        meta: { page: parseInt(page || "1"), limit: take, total },
      });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/packages/purchases/:id
router.get(
  "/purchases/:id",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const purchase = await prisma.packagePurchase.findUnique({
        where: { id: req.params.id },
        include: {
          package: true,
          patient: {
            include: { user: { select: { name: true, phone: true, email: true } } },
          },
        },
      });
      if (!purchase) {
        res.status(404).json({ success: false, data: null, error: "Purchase not found" });
        return;
      }
      res.json({ success: true, data: purchase, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/v1/packages/purchase — patient purchases a package
router.post(
  "/purchase",
  authorize(Role.ADMIN, Role.RECEPTION),
  validate(purchasePackageSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { packageId, patientId, amountPaid } = req.body;

      const pkg = await prisma.healthPackage.findUnique({ where: { id: packageId } });
      if (!pkg || !pkg.isActive) {
        res.status(404).json({ success: false, data: null, error: "Package not found or inactive" });
        return;
      }

      const patient = await prisma.patient.findUnique({ where: { id: patientId } });
      if (!patient) {
        res.status(404).json({ success: false, data: null, error: "Patient not found" });
        return;
      }

      // Generate purchase number
      const key = "next_package_purchase_number";
      const config = await prisma.systemConfig.findUnique({ where: { key } });
      const seq = config ? parseInt(config.value) : 1;
      const purchaseNumber = `${PACKAGE_NUMBER_PREFIX}${String(seq).padStart(6, "0")}`;

      const purchasedAt = new Date();
      const expiresAt = new Date(purchasedAt);
      expiresAt.setDate(expiresAt.getDate() + pkg.validityDays);

      const purchase = await prisma.$transaction(async (tx) => {
        const created = await tx.packagePurchase.create({
          data: {
            purchaseNumber,
            packageId,
            patientId,
            purchasedAt,
            expiresAt,
            amountPaid,
          },
          include: {
            package: true,
            patient: { include: { user: { select: { name: true, phone: true } } } },
          },
        });

        if (config) {
          await tx.systemConfig.update({
            where: { key },
            data: { value: String(seq + 1) },
          });
        } else {
          await tx.systemConfig.create({
            data: { key, value: String(seq + 1) },
          });
        }

        return created;
      });

      auditLog(req, "PURCHASE_PACKAGE", "package_purchase", purchase.id, {
        purchaseNumber,
        packageId,
        patientId,
        amountPaid,
      }).catch(console.error);

      res.status(201).json({ success: true, data: purchase, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/packages/:id
router.get("/:id", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const pkg = await prisma.healthPackage.findUnique({
      where: { id: req.params.id },
      include: {
        purchases: {
          take: 10,
          orderBy: { purchasedAt: "desc" },
          include: {
            patient: { include: { user: { select: { name: true, phone: true } } } },
          },
        },
      },
    });
    if (!pkg) {
      res.status(404).json({ success: false, data: null, error: "Package not found" });
      return;
    }
    res.json({ success: true, data: pkg, error: null });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/packages — create (ADMIN)
router.post(
  "/",
  authorize(Role.ADMIN),
  validate(createPackageSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const pkg = await prisma.healthPackage.create({ data: req.body });
      auditLog(req, "CREATE_PACKAGE", "health_package", pkg.id, req.body).catch(console.error);
      res.status(201).json({ success: true, data: pkg, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// PATCH /api/v1/packages/:id — update
router.patch(
  "/:id",
  authorize(Role.ADMIN),
  validate(updatePackageSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const pkg = await prisma.healthPackage.update({
        where: { id: req.params.id },
        data: req.body,
      });
      auditLog(req, "UPDATE_PACKAGE", "health_package", pkg.id, req.body).catch(console.error);
      res.json({ success: true, data: pkg, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// DELETE /api/v1/packages/:id — soft-delete
router.delete(
  "/:id",
  authorize(Role.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const pkg = await prisma.healthPackage.update({
        where: { id: req.params.id },
        data: { isActive: false },
      });
      auditLog(req, "DELETE_PACKAGE", "health_package", pkg.id).catch(console.error);
      res.json({ success: true, data: pkg, error: null });
    } catch (err) {
      next(err);
    }
  }
);

export { router as packageRouter };
