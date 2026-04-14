import { Router, Request, Response, NextFunction } from "express";
import { prisma } from "@medcore/db";
import {
  Role,
  createPOSchema,
  updatePOSchema,
  approvePOSchema,
  receivePOSchema,
  PO_NUMBER_PREFIX,
} from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { auditLog } from "../middleware/audit";

const router = Router();
router.use(authenticate);

// GET /api/v1/purchase-orders — list
router.get("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { status, supplierId, from, to, page = "1", limit = "20" } =
      req.query as Record<string, string | undefined>;

    const where: Record<string, unknown> = {};
    if (status) where.status = status;
    if (supplierId) where.supplierId = supplierId;
    if (from || to) {
      where.createdAt = {};
      if (from) (where.createdAt as Record<string, unknown>).gte = new Date(from);
      if (to) (where.createdAt as Record<string, unknown>).lte = new Date(to);
    }

    const skip = (parseInt(page || "1") - 1) * parseInt(limit || "20");
    const take = Math.min(parseInt(limit || "20"), 100);

    const [orders, total] = await Promise.all([
      prisma.purchaseOrder.findMany({
        where,
        include: {
          supplier: true,
          items: true,
        },
        skip,
        take,
        orderBy: { createdAt: "desc" },
      }),
      prisma.purchaseOrder.count({ where }),
    ]);

    res.json({
      success: true,
      data: orders,
      error: null,
      meta: { page: parseInt(page || "1"), limit: take, total },
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/purchase-orders/:id
router.get("/:id", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const po = await prisma.purchaseOrder.findUnique({
      where: { id: req.params.id },
      include: {
        supplier: true,
        items: true,
      },
    });
    if (!po) {
      res.status(404).json({ success: false, data: null, error: "Purchase order not found" });
      return;
    }

    // Fetch medicines separately
    const medicineIds = po.items.map((i) => i.medicineId).filter(Boolean) as string[];
    const medicines =
      medicineIds.length > 0
        ? await prisma.medicine.findMany({ where: { id: { in: medicineIds } } })
        : [];
    const medMap = new Map(medicines.map((m) => [m.id, m]));
    const itemsWithMedicine = po.items.map((i) => ({
      ...i,
      medicine: i.medicineId ? medMap.get(i.medicineId) : null,
    }));

    res.json({
      success: true,
      data: { ...po, items: itemsWithMedicine },
      error: null,
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/purchase-orders — create DRAFT
router.post(
  "/",
  authorize(Role.ADMIN, Role.RECEPTION),
  validate(createPOSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { supplierId, items, expectedAt, notes, taxPercentage } = req.body;

      const supplier = await prisma.supplier.findUnique({ where: { id: supplierId } });
      if (!supplier) {
        res.status(404).json({ success: false, data: null, error: "Supplier not found" });
        return;
      }

      // Calculate totals
      const subtotal = items.reduce(
        (sum: number, it: { quantity: number; unitPrice: number }) =>
          sum + it.quantity * it.unitPrice,
        0
      );
      const taxAmount = (subtotal * (taxPercentage || 0)) / 100;
      const totalAmount = subtotal + taxAmount;

      // Generate PO number
      const key = "next_po_number";
      const config = await prisma.systemConfig.findUnique({ where: { key } });
      const seq = config ? parseInt(config.value) : 1;
      const poNumber = `${PO_NUMBER_PREFIX}${String(seq).padStart(6, "0")}`;

      const po = await prisma.$transaction(async (tx) => {
        const created = await tx.purchaseOrder.create({
          data: {
            poNumber,
            supplierId,
            status: "DRAFT",
            expectedAt: expectedAt ? new Date(expectedAt) : undefined,
            notes,
            subtotal,
            taxAmount,
            totalAmount,
            createdBy: req.user!.userId,
            items: {
              create: items.map(
                (it: {
                  description: string;
                  medicineId?: string;
                  quantity: number;
                  unitPrice: number;
                }) => ({
                  description: it.description,
                  medicineId: it.medicineId,
                  quantity: it.quantity,
                  unitPrice: it.unitPrice,
                  amount: it.quantity * it.unitPrice,
                })
              ),
            },
          },
          include: { supplier: true, items: true },
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

      auditLog(req, "CREATE_PO", "purchase_order", po.id, {
        poNumber,
        supplierId,
        totalAmount,
      }).catch(console.error);

      res.status(201).json({ success: true, data: po, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// PATCH /api/v1/purchase-orders/:id — update items (DRAFT only)
router.patch(
  "/:id",
  authorize(Role.ADMIN, Role.RECEPTION),
  validate(updatePOSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const po = await prisma.purchaseOrder.findUnique({
        where: { id: req.params.id },
        include: { items: true },
      });
      if (!po) {
        res.status(404).json({ success: false, data: null, error: "Purchase order not found" });
        return;
      }
      if (po.status !== "DRAFT") {
        res.status(400).json({
          success: false,
          data: null,
          error: "Only DRAFT orders can be updated",
        });
        return;
      }

      const { items, expectedAt, notes, taxPercentage } = req.body;

      const updated = await prisma.$transaction(async (tx) => {
        const data: Record<string, unknown> = {};

        if (expectedAt !== undefined)
          data.expectedAt = expectedAt ? new Date(expectedAt) : null;
        if (notes !== undefined) data.notes = notes;

        if (items) {
          await tx.purchaseOrderItem.deleteMany({ where: { poId: po.id } });

          const subtotal = items.reduce(
            (sum: number, it: { quantity: number; unitPrice: number }) =>
              sum + it.quantity * it.unitPrice,
            0
          );
          const taxPct = taxPercentage ?? (po.subtotal ? (po.taxAmount / po.subtotal) * 100 : 0);
          const taxAmount = (subtotal * taxPct) / 100;
          const totalAmount = subtotal + taxAmount;

          data.subtotal = subtotal;
          data.taxAmount = taxAmount;
          data.totalAmount = totalAmount;
          data.items = {
            create: items.map(
              (it: {
                description: string;
                medicineId?: string;
                quantity: number;
                unitPrice: number;
              }) => ({
                description: it.description,
                medicineId: it.medicineId,
                quantity: it.quantity,
                unitPrice: it.unitPrice,
                amount: it.quantity * it.unitPrice,
              })
            ),
          };
        } else if (taxPercentage !== undefined) {
          const taxAmount = (po.subtotal * taxPercentage) / 100;
          data.taxAmount = taxAmount;
          data.totalAmount = po.subtotal + taxAmount;
        }

        return tx.purchaseOrder.update({
          where: { id: po.id },
          data,
          include: { supplier: true, items: true },
        });
      });

      auditLog(req, "UPDATE_PO", "purchase_order", po.id, req.body).catch(console.error);

      res.json({ success: true, data: updated, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/v1/purchase-orders/:id/submit — DRAFT → PENDING
router.post(
  "/:id/submit",
  authorize(Role.ADMIN, Role.RECEPTION),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const po = await prisma.purchaseOrder.findUnique({ where: { id: req.params.id } });
      if (!po) {
        res.status(404).json({ success: false, data: null, error: "Purchase order not found" });
        return;
      }
      if (po.status !== "DRAFT") {
        res.status(400).json({
          success: false,
          data: null,
          error: "Only DRAFT orders can be submitted",
        });
        return;
      }

      const updated = await prisma.purchaseOrder.update({
        where: { id: po.id },
        data: { status: "PENDING" },
        include: { supplier: true, items: true },
      });

      auditLog(req, "SUBMIT_PO", "purchase_order", po.id).catch(console.error);

      res.json({ success: true, data: updated, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/v1/purchase-orders/:id/approve — PENDING → APPROVED
router.post(
  "/:id/approve",
  authorize(Role.ADMIN),
  validate(approvePOSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const po = await prisma.purchaseOrder.findUnique({ where: { id: req.params.id } });
      if (!po) {
        res.status(404).json({ success: false, data: null, error: "Purchase order not found" });
        return;
      }
      if (po.status !== "PENDING") {
        res.status(400).json({
          success: false,
          data: null,
          error: "Only PENDING orders can be approved",
        });
        return;
      }

      const updated = await prisma.purchaseOrder.update({
        where: { id: po.id },
        data: { status: "APPROVED", approvedBy: req.user!.userId },
        include: { supplier: true, items: true },
      });

      auditLog(req, "APPROVE_PO", "purchase_order", po.id).catch(console.error);

      res.json({ success: true, data: updated, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/v1/purchase-orders/:id/receive — APPROVED → RECEIVED
router.post(
  "/:id/receive",
  authorize(Role.ADMIN, Role.RECEPTION),
  validate(receivePOSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const po = await prisma.purchaseOrder.findUnique({
        where: { id: req.params.id },
        include: { items: true },
      });
      if (!po) {
        res.status(404).json({ success: false, data: null, error: "Purchase order not found" });
        return;
      }
      if (po.status !== "APPROVED") {
        res.status(400).json({
          success: false,
          data: null,
          error: "Only APPROVED orders can be received",
        });
        return;
      }

      const receivedItemsMap = new Map<string, number>();
      if (req.body.receivedItems) {
        for (const ri of req.body.receivedItems as Array<{
          itemId: string;
          receivedQuantity: number;
        }>) {
          receivedItemsMap.set(ri.itemId, ri.receivedQuantity);
        }
      }

      const result = await prisma.$transaction(async (tx) => {
        const updated = await tx.purchaseOrder.update({
          where: { id: po.id },
          data: { status: "RECEIVED", receivedAt: new Date() },
          include: { supplier: true, items: true },
        });

        // For items that link to medicines, create inventory + stock movements
        for (const item of po.items) {
          if (!item.medicineId) continue;

          const qty =
            receivedItemsMap.has(item.id)
              ? receivedItemsMap.get(item.id)!
              : item.quantity;

          if (qty <= 0) continue;

          // Auto-generate batch number and default 2-year expiry
          const batchNumber = `PO-${po.poNumber}-${item.id.slice(0, 6)}`;
          const expiryDate = new Date();
          expiryDate.setFullYear(expiryDate.getFullYear() + 2);

          const existing = await tx.inventoryItem.findUnique({
            where: {
              medicineId_batchNumber: {
                medicineId: item.medicineId,
                batchNumber,
              },
            },
          });

          let inv;
          if (existing) {
            inv = await tx.inventoryItem.update({
              where: { id: existing.id },
              data: {
                quantity: existing.quantity + qty,
                unitCost: item.unitPrice,
              },
            });
          } else {
            inv = await tx.inventoryItem.create({
              data: {
                medicineId: item.medicineId,
                batchNumber,
                quantity: qty,
                unitCost: item.unitPrice,
                sellingPrice: item.unitPrice * 1.2, // 20% markup default
                expiryDate,
                supplier: updated.supplier.name,
                reorderLevel: 10,
              },
            });
          }

          await tx.stockMovement.create({
            data: {
              inventoryItemId: inv.id,
              type: "PURCHASE",
              quantity: qty,
              referenceId: po.id,
              performedBy: req.user!.userId,
              reason: `Received via PO ${po.poNumber}`,
            },
          });
        }

        return updated;
      });

      auditLog(req, "RECEIVE_PO", "purchase_order", po.id, {
        poNumber: po.poNumber,
      }).catch(console.error);

      res.json({ success: true, data: result, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/v1/purchase-orders/:id/cancel
router.post(
  "/:id/cancel",
  authorize(Role.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const po = await prisma.purchaseOrder.findUnique({ where: { id: req.params.id } });
      if (!po) {
        res.status(404).json({ success: false, data: null, error: "Purchase order not found" });
        return;
      }
      if (po.status === "CANCELLED" || po.status === "RECEIVED") {
        res.status(400).json({
          success: false,
          data: null,
          error: `Cannot cancel a ${po.status} order`,
        });
        return;
      }

      const updated = await prisma.purchaseOrder.update({
        where: { id: po.id },
        data: { status: "CANCELLED" },
        include: { supplier: true, items: true },
      });

      auditLog(req, "CANCEL_PO", "purchase_order", po.id).catch(console.error);

      res.json({ success: true, data: updated, error: null });
    } catch (err) {
      next(err);
    }
  }
);

export { router as purchaseOrderRouter };
