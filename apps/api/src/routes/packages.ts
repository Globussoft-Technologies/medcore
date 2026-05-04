import { Router, Request, Response, NextFunction } from "express";
// Multi-tenant wiring: `tenantScopedPrisma` is a Prisma $extends wrapper that
// auto-injects tenantId on create and auto-filters on read for the 20
// tenant-scoped models (see services/tenant-prisma.ts). We alias it to
// `prisma` so every existing call site keeps working without edits.
import { tenantScopedPrisma as prisma } from "../services/tenant-prisma";
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
import { assertPatientOwnsResource } from "../middleware/patient-self-only";
import { validate } from "../middleware/validate";
import { auditLog } from "../middleware/audit";

const router = Router();
router.use(authenticate);

// GET /api/v1/packages — list active packages (?category=)
// #511 audit: VERIFIED-SAFE — HealthPackage is a catalog (no patientId FK).
// Browsing the catalog is a legitimate PATIENT surface (purchase shopping UI).
// `_count.purchases` is an aggregate count, not per-patient PHI.
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
// #511 audit: PATCHED — PATIENT callers were able to list ALL purchases across
// patients (cross-patient PHI: name + phone + package + amount). Now hard-scoped
// to caller's own Patient row when role is PATIENT.
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

      // PATIENT self-scope — override any caller-supplied patientId filter.
      if (req.user?.role === "PATIENT") {
        const self = await prisma.patient.findUnique({
          where: { userId: req.user.userId },
          select: { id: true },
        });
        if (!self) {
          res
            .status(403)
            .json({ success: false, data: null, error: "Forbidden" });
          return;
        }
        where.patientId = self.id;
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
// #511 audit: PATCHED — PATIENT callers could read any purchase by id (BOLA).
// Now per-row gated via assertPatientOwnsResource against purchase.patientId.
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
      if (!(await assertPatientOwnsResource(req, res, purchase.patientId))) return;
      res.json({ success: true, data: purchase, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/v1/packages/purchase — patient purchases a package
// #511 audit: VERIFIED-SAFE — authorize(ADMIN, RECEPTION) excludes PATIENT.
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

      auditLog(req, "PACKAGE_PURCHASE", "package_purchase", purchase.id, {
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
// #511 audit: PATCHED — HealthPackage itself is catalog (no patientId), but
// the original `include: purchases.patient.user` leaked the names/phones of
// every patient who bought this package to any PATIENT-role caller. We now
// drop the purchases include entirely for PATIENT callers; staff still see it.
router.get("/:id", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const isStaff = req.user?.role !== "PATIENT";
    const pkg = await prisma.healthPackage.findUnique({
      where: { id: req.params.id },
      include: isStaff
        ? {
            purchases: {
              take: 10,
              orderBy: { purchasedAt: "desc" },
              include: {
                patient: {
                  include: { user: { select: { name: true, phone: true } } },
                },
              },
            },
          }
        : undefined,
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
// #511 audit: VERIFIED-SAFE — authorize(ADMIN) excludes PATIENT.
router.post(
  "/",
  authorize(Role.ADMIN),
  validate(createPackageSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const pkg = await prisma.healthPackage.create({ data: req.body });
      auditLog(req, "PACKAGE_CREATE", "health_package", pkg.id, req.body).catch(console.error);
      res.status(201).json({ success: true, data: pkg, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// PATCH /api/v1/packages/:id — update
// #511 audit: VERIFIED-SAFE — authorize(ADMIN) excludes PATIENT.
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
      auditLog(req, "PACKAGE_UPDATE", "health_package", pkg.id, req.body).catch(console.error);
      res.json({ success: true, data: pkg, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// DELETE /api/v1/packages/:id — soft-delete
// #511 audit: VERIFIED-SAFE — authorize(ADMIN) excludes PATIENT.
router.delete(
  "/:id",
  authorize(Role.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const pkg = await prisma.healthPackage.update({
        where: { id: req.params.id },
        data: { isActive: false },
      });
      auditLog(req, "PACKAGE_DELETE", "health_package", pkg.id).catch(console.error);
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
// #511 audit: VERIFIED-SAFE — authorize(ADMIN, RECEPTION) excludes PATIENT.
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
// #511 audit: VERIFIED-SAFE — authorize(ADMIN, RECEPTION) excludes PATIENT.
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
// #511 audit: VERIFIED-SAFE — authorize(ADMIN, RECEPTION) excludes PATIENT.
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
// #511 audit: VERIFIED-SAFE — authorize(ADMIN, RECEPTION, DOCTOR, NURSE)
// excludes PATIENT.
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
// #511 audit: VERIFIED-SAFE — authorize(ADMIN, RECEPTION) excludes PATIENT.
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
