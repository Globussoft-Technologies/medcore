import { Router, Request, Response, NextFunction } from "express";
import { prisma } from "@medcore/db";
import {
  Role,
  createSupplierSchema,
  updateSupplierSchema,
  supplierPaymentSchema,
  supplierCatalogItemSchema,
} from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { auditLog } from "../middleware/audit";

const router = Router();
router.use(authenticate);

// GET /api/v1/suppliers
// Issue #174 (Apr 30 2026): supplier list exposes vendor PII (gstNumber,
// contactPerson, outstandingAmount). DOCTOR/NURSE/PATIENT have no business
// reading procurement data — restrict to ops + finance roles.
router.get("/", authorize(Role.ADMIN, Role.RECEPTION, Role.PHARMACIST), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { active = "true", search } = req.query as Record<string, string | undefined>;

    const where: Record<string, unknown> = {};
    if (active === "true") where.isActive = true;
    if (search) {
      where.OR = [
        { name: { contains: search, mode: "insensitive" } },
        { contactPerson: { contains: search, mode: "insensitive" } },
        { gstNumber: { contains: search, mode: "insensitive" } },
      ];
    }

    const suppliers = await prisma.supplier.findMany({
      where,
      orderBy: { name: "asc" },
      include: { _count: { select: { purchaseOrders: true } } },
    });

    res.json({ success: true, data: suppliers, error: null });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/suppliers/:id
// Issue #174: same rationale as list — vendor PII + outstanding balance.
router.get("/:id", authorize(Role.ADMIN, Role.RECEPTION, Role.PHARMACIST), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const supplier = await prisma.supplier.findUnique({
      where: { id: req.params.id },
      include: {
        purchaseOrders: {
          take: 10,
          orderBy: { createdAt: "desc" },
          include: { items: true },
        },
      },
    });
    if (!supplier) {
      res.status(404).json({ success: false, data: null, error: "Supplier not found" });
      return;
    }
    res.json({ success: true, data: supplier, error: null });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/suppliers
router.post(
  "/",
  authorize(Role.ADMIN),
  validate(createSupplierSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = { ...req.body };
      if (data.email === "") delete data.email;
      if (data.contractStart) data.contractStart = new Date(data.contractStart);
      if (data.contractEnd) data.contractEnd = new Date(data.contractEnd);
      const supplier = await prisma.supplier.create({ data });
      auditLog(req, "SUPPLIER_CREATE", "supplier", supplier.id, data).catch(
        console.error
      );
      res.status(201).json({ success: true, data: supplier, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// PATCH /api/v1/suppliers/:id
router.patch(
  "/:id",
  authorize(Role.ADMIN),
  validate(updateSupplierSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = { ...req.body };
      if (data.email === "") delete data.email;
      if (data.contractStart) data.contractStart = new Date(data.contractStart);
      if (data.contractEnd) data.contractEnd = new Date(data.contractEnd);
      const supplier = await prisma.supplier.update({
        where: { id: req.params.id },
        data,
      });
      auditLog(req, "SUPPLIER_UPDATE", "supplier", supplier.id, data).catch(
        console.error
      );
      res.json({ success: true, data: supplier, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// ═══════════════════════════════════════════════════════
// OPS ENHANCEMENTS: PAYMENTS, CATALOG, PERFORMANCE
// ═══════════════════════════════════════════════════════

// GET /api/v1/suppliers/:id/payments
// Issue #174: payment history is finance-only PII.
router.get(
  "/:id/payments",
  authorize(Role.ADMIN, Role.RECEPTION),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const [supplier, payments] = await Promise.all([
        prisma.supplier.findUnique({ where: { id: req.params.id } }),
        prisma.supplierPayment.findMany({
          where: { supplierId: req.params.id },
          orderBy: { paidAt: "desc" },
        }),
      ]);
      if (!supplier) {
        res.status(404).json({ success: false, data: null, error: "Supplier not found" });
        return;
      }
      const totalPaid = payments.reduce((s, p) => s + p.amount, 0);
      res.json({
        success: true,
        data: {
          supplier: { id: supplier.id, name: supplier.name, outstandingAmount: supplier.outstandingAmount },
          payments,
          totalPaid: +totalPaid.toFixed(2),
          outstanding: supplier.outstandingAmount,
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/v1/suppliers/:id/payments
router.post(
  "/:id/payments",
  authorize(Role.ADMIN, Role.RECEPTION),
  validate(supplierPaymentSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const supplier = await prisma.supplier.findUnique({ where: { id: req.params.id } });
      if (!supplier) {
        res.status(404).json({ success: false, data: null, error: "Supplier not found" });
        return;
      }
      const body = req.body;
      const pay = await prisma.$transaction(async (tx) => {
        const p = await tx.supplierPayment.create({
          data: {
            supplierId: supplier.id,
            poId: body.poId,
            amount: body.amount,
            mode: body.mode,
            reference: body.reference,
            notes: body.notes,
            recordedBy: req.user!.userId,
          },
        });
        await tx.supplier.update({
          where: { id: supplier.id },
          data: { outstandingAmount: { decrement: body.amount } },
        });
        return p;
      });
      auditLog(req, "SUPPLIER_PAYMENT", "supplier_payment", pay.id, {
        supplierId: supplier.id,
        amount: body.amount,
      }).catch(console.error);
      res.status(201).json({ success: true, data: pay, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/suppliers/:id/performance — on-time rate & rating
// Issue #174: KPI tile for procurement, not clinical.
router.get(
  "/:id/performance",
  authorize(Role.ADMIN, Role.RECEPTION, Role.PHARMACIST),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const [supplier, pos] = await Promise.all([
        prisma.supplier.findUnique({ where: { id: req.params.id } }),
        prisma.purchaseOrder.findMany({
          where: { supplierId: req.params.id, status: "RECEIVED" },
          select: { expectedAt: true, receivedAt: true, totalAmount: true, invoiceAmount: true },
        }),
      ]);
      if (!supplier) {
        res.status(404).json({ success: false, data: null, error: "Supplier not found" });
        return;
      }
      let onTime = 0;
      let late = 0;
      let varianceTotal = 0;
      let varianceCount = 0;
      for (const po of pos) {
        if (po.receivedAt && po.expectedAt) {
          if (po.receivedAt <= po.expectedAt) onTime++;
          else late++;
        }
        if (po.invoiceAmount != null && po.totalAmount) {
          varianceTotal += po.invoiceAmount - po.totalAmount;
          varianceCount++;
        }
      }
      const delivered = onTime + late;
      const onTimeRate = delivered > 0 ? +((onTime / delivered) * 100).toFixed(1) : 0;
      const avgVariance = varianceCount > 0 ? +(varianceTotal / varianceCount).toFixed(2) : 0;
      res.json({
        success: true,
        data: {
          supplierId: supplier.id,
          rating: supplier.rating,
          onTimeDeliveries: onTime,
          lateDeliveries: late,
          onTimeRate,
          totalOrders: pos.length,
          outstanding: supplier.outstandingAmount,
          avgInvoiceVariance: avgVariance,
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/suppliers/:id/catalog
// Issue #174: pricing data — restrict to ops/pharmacist.
router.get(
  "/:id/catalog",
  authorize(Role.ADMIN, Role.RECEPTION, Role.PHARMACIST),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const items = await prisma.supplierCatalogItem.findMany({
        where: { supplierId: req.params.id, isActive: true },
        orderBy: { itemName: "asc" },
      });
      res.json({ success: true, data: items, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/v1/suppliers/:id/catalog
router.post(
  "/:id/catalog",
  authorize(Role.ADMIN),
  validate(supplierCatalogItemSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const item = await prisma.supplierCatalogItem.create({
        data: { ...req.body, supplierId: req.params.id },
      });
      auditLog(req, "SUPPLIER_CATALOG_ADD", "supplier_catalog_item", item.id, req.body).catch(
        console.error
      );
      res.status(201).json({ success: true, data: item, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/suppliers/contracts/expiring?days=60
router.get(
  "/contracts/expiring",
  authorize(Role.ADMIN, Role.RECEPTION),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const days = parseInt((req.query.days as string) || "60", 10);
      const now = new Date();
      const end = new Date();
      end.setDate(end.getDate() + days);
      const suppliers = await prisma.supplier.findMany({
        where: {
          isActive: true,
          contractEnd: { gte: now, lte: end },
        },
        orderBy: { contractEnd: "asc" },
      });
      res.json({ success: true, data: suppliers, error: null });
    } catch (err) {
      next(err);
    }
  }
);

export { router as supplierRouter };
