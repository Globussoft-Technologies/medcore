import { Router, Request, Response, NextFunction } from "express";
import { prisma } from "@medcore/db";
import {
  Role,
  createPackageSchema,
  updatePackageSchema,
  purchasePackageSchema,
  packageConsumptionSchema,
  renewPackageSchema,
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

// ═══════════════════════════════════════════════════════
// OPS ENHANCEMENTS: ANALYTICS, CONSUMPTION, RENEWAL, EXPIRY
// ═══════════════════════════════════════════════════════

// GET /api/v1/packages/analytics — per-package revenue & most-sold
router.get(
  "/stats/analytics",
  authorize(Role.ADMIN, Role.RECEPTION),
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const pkgs = await prisma.healthPackage.findMany({
        include: {
          purchases: { select: { amountPaid: true, purchasedAt: true, isFullyUsed: true } },
        },
      });

      const rows = pkgs
        .map((p) => {
          const sold = p.purchases.length;
          const revenue = p.purchases.reduce((s, x) => s + x.amountPaid, 0);
          const used = p.purchases.filter((x) => x.isFullyUsed).length;
          const lastPurchaseAt = p.purchases
            .map((x) => x.purchasedAt.getTime())
            .sort((a, b) => b - a)[0];
          return {
            packageId: p.id,
            name: p.name,
            category: p.category,
            price: p.price,
            sold,
            revenue: +revenue.toFixed(2),
            fullyUsed: used,
            lastPurchaseAt: lastPurchaseAt ? new Date(lastPurchaseAt) : null,
          };
        })
        .sort((a, b) => b.revenue - a.revenue);

      const totals = rows.reduce(
        (acc, r) => ({
          totalRevenue: acc.totalRevenue + r.revenue,
          totalSold: acc.totalSold + r.sold,
        }),
        { totalRevenue: 0, totalSold: 0 }
      );

      res.json({
        success: true,
        data: {
          rows,
          topByRevenue: rows.slice(0, 5),
          topBySold: [...rows].sort((a, b) => b.sold - a.sold).slice(0, 5),
          totals,
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/packages/purchases/expiring?days=30 — purchases expiring soon
router.get(
  "/purchases/expiring",
  authorize(Role.ADMIN, Role.RECEPTION),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const days = parseInt((req.query.days as string) || "30", 10);
      const now = new Date();
      const end = new Date();
      end.setDate(end.getDate() + days);

      const purchases = await prisma.packagePurchase.findMany({
        where: {
          expiresAt: { gt: now, lte: end },
          isFullyUsed: false,
        },
        include: {
          package: true,
          patient: {
            include: { user: { select: { name: true, phone: true, email: true } } },
          },
        },
        orderBy: { expiresAt: "asc" },
      });

      res.json({
        success: true,
        data: purchases.map((p) => ({
          ...p,
          daysRemaining: Math.ceil(
            (p.expiresAt.getTime() - now.getTime()) / 86400000
          ),
        })),
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/v1/packages/purchases/:id/reminder — send expiry reminder
router.post(
  "/purchases/:id/reminder",
  authorize(Role.ADMIN, Role.RECEPTION),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const p = await prisma.packagePurchase.findUnique({
        where: { id: req.params.id },
        include: {
          package: true,
          patient: { include: { user: true } },
        },
      });
      if (!p) {
        res.status(404).json({ success: false, data: null, error: "Purchase not found" });
        return;
      }
      const daysRemaining = Math.ceil(
        (p.expiresAt.getTime() - Date.now()) / 86400000
      );
      await prisma.notification.create({
        data: {
          userId: p.patient.userId,
          type: "BILL_GENERATED",
          channel: "SMS",
          title: `Your ${p.package.name} expires in ${daysRemaining} days`,
          message: `Hi ${p.patient.user.name}, your health package "${p.package.name}" expires on ${p.expiresAt.toDateString()}. Please use remaining services before expiry.`,
          data: { packagePurchaseId: p.id, expiresAt: p.expiresAt },
          deliveryStatus: "QUEUED",
        },
      });
      await prisma.packagePurchase.update({
        where: { id: p.id },
        data: { reminderSentAt: new Date() },
      });
      auditLog(req, "PACKAGE_EXPIRY_REMINDER", "package_purchase", p.id).catch(
        console.error
      );
      res.status(201).json({ success: true, data: { daysRemaining }, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/v1/packages/purchases/:id/consume — mark a service as consumed
router.post(
  "/purchases/:id/consume",
  authorize(Role.ADMIN, Role.RECEPTION, Role.DOCTOR, Role.NURSE),
  validate(packageConsumptionSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const p = await prisma.packagePurchase.findUnique({
        where: { id: req.params.id },
        include: { package: true },
      });
      if (!p) {
        res.status(404).json({ success: false, data: null, error: "Purchase not found" });
        return;
      }
      if (p.expiresAt < new Date()) {
        res.status(400).json({ success: false, data: null, error: "Package has expired" });
        return;
      }
      const services = (p.package.services || "")
        .split(/[,;]/)
        .map((s) => s.trim())
        .filter(Boolean);
      const used: Array<{ service: string; usedAt: string; patientId?: string; appointmentId?: string; notes?: string }> =
        p.servicesUsed ? JSON.parse(p.servicesUsed) : [];

      used.push({
        service: req.body.service,
        usedAt: new Date().toISOString(),
        patientId: req.body.patientId,
        appointmentId: req.body.appointmentId,
        notes: req.body.notes,
      });

      // Check if all services are exhausted
      const uniqueUsed = new Set(used.map((u) => u.service.toLowerCase()));
      const isFullyUsed =
        services.length > 0 &&
        services.every((s) => uniqueUsed.has(s.toLowerCase()));

      const updated = await prisma.packagePurchase.update({
        where: { id: p.id },
        data: {
          servicesUsed: JSON.stringify(used),
          isFullyUsed,
        },
      });
      auditLog(req, "PACKAGE_CONSUME", "package_purchase", p.id, {
        service: req.body.service,
      }).catch(console.error);
      res.status(201).json({ success: true, data: updated, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/v1/packages/purchases/:id/renew — create a new purchase referencing prior
router.post(
  "/purchases/:id/renew",
  authorize(Role.ADMIN, Role.RECEPTION),
  validate(renewPackageSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const prev = await prisma.packagePurchase.findUnique({
        where: { id: req.params.id },
        include: { package: true },
      });
      if (!prev) {
        res.status(404).json({ success: false, data: null, error: "Prior purchase not found" });
        return;
      }
      const key = "next_package_purchase_number";
      const config = await prisma.systemConfig.findUnique({ where: { key } });
      const seq = config ? parseInt(config.value) : 1;
      const purchaseNumber = `${PACKAGE_NUMBER_PREFIX}${String(seq).padStart(6, "0")}`;
      const purchasedAt = new Date();
      const expiresAt = new Date(purchasedAt);
      expiresAt.setDate(expiresAt.getDate() + prev.package.validityDays);

      const renewed = await prisma.$transaction(async (tx) => {
        const created = await tx.packagePurchase.create({
          data: {
            purchaseNumber,
            packageId: prev.packageId,
            patientId: prev.patientId,
            familyMemberIds: prev.familyMemberIds,
            purchasedAt,
            expiresAt,
            amountPaid: req.body.amountPaid,
            renewedFromId: prev.id,
          },
          include: { package: true },
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
      auditLog(req, "PACKAGE_RENEW", "package_purchase", renewed.id, {
        priorId: prev.id,
      }).catch(console.error);
      res.status(201).json({ success: true, data: renewed, error: null });
    } catch (err) {
      next(err);
    }
  }
);

export { router as packageRouter };
