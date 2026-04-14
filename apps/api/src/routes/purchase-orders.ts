import { Router, Request, Response, NextFunction } from "express";
import { prisma } from "@medcore/db";
import {
  Role,
  createPOSchema,
  updatePOSchema,
  approvePOSchema,
  receivePOSchema,
  createGrnSchema,
  PO_NUMBER_PREFIX,
  GRN_NUMBER_PREFIX,
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
      const { supplierId, items, expectedAt, notes, taxPercentage, isRecurring, recurringFrequency } = req.body;

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
            isRecurring: isRecurring || false,
            recurringFrequency: recurringFrequency || undefined,
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

// ═══════════════════════════════════════════════════════
// OPS ENHANCEMENTS: GRN (Goods Receipt Note) — partial receipts
// ═══════════════════════════════════════════════════════

async function nextGrnNumber(): Promise<string> {
  const last = await prisma.grn.findFirst({
    orderBy: { grnNumber: "desc" },
    select: { grnNumber: true },
  });
  let n = 1;
  if (last?.grnNumber) {
    const m = last.grnNumber.match(/(\d+)$/);
    if (m) n = parseInt(m[1], 10) + 1;
  }
  return `${GRN_NUMBER_PREFIX}${String(n).padStart(6, "0")}`;
}

// POST /api/v1/purchase-orders/:id/grns — create a Goods Receipt Note (partial/full)
router.post(
  "/:id/grns",
  authorize(Role.ADMIN, Role.RECEPTION),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const po = await prisma.purchaseOrder.findUnique({
        where: { id: req.params.id },
        include: { items: true, grns: { include: { items: true } } },
      });
      if (!po) {
        res.status(404).json({ success: false, data: null, error: "Purchase order not found" });
        return;
      }
      if (po.status !== "APPROVED" && po.status !== "RECEIVED") {
        res.status(400).json({
          success: false,
          data: null,
          error: "GRNs can only be created against APPROVED or partially-RECEIVED POs",
        });
        return;
      }

      const parsed = createGrnSchema.safeParse({ ...req.body, poId: po.id });
      if (!parsed.success) {
        res.status(400).json({
          success: false,
          data: null,
          error: "Validation failed",
          details: parsed.error.flatten(),
        });
        return;
      }

      // Compute already-received per item
      const receivedByItem = new Map<string, number>();
      for (const g of po.grns) {
        for (const it of g.items) {
          receivedByItem.set(it.poItemId, (receivedByItem.get(it.poItemId) || 0) + it.quantity);
        }
      }

      for (const inc of parsed.data.items) {
        const poItem = po.items.find((pi) => pi.id === inc.poItemId);
        if (!poItem) {
          res.status(400).json({
            success: false,
            data: null,
            error: `PO item ${inc.poItemId} not found`,
          });
          return;
        }
        const alreadyReceived = receivedByItem.get(inc.poItemId) || 0;
        if (alreadyReceived + inc.quantity > poItem.quantity) {
          res.status(400).json({
            success: false,
            data: null,
            error: `Cannot receive ${inc.quantity} more of "${poItem.description}" (ordered ${poItem.quantity}, already received ${alreadyReceived})`,
          });
          return;
        }
      }

      const grnNumber = await nextGrnNumber();

      const result = await prisma.$transaction(async (tx) => {
        const grn = await tx.grn.create({
          data: {
            grnNumber,
            poId: po.id,
            receivedBy: req.user!.userId,
            notes: parsed.data.notes,
            invoiceNumber: parsed.data.invoiceNumber,
            items: {
              create: parsed.data.items.map((it) => ({
                poItemId: it.poItemId,
                quantity: it.quantity,
                batchNumber: it.batchNumber,
                expiryDate: it.expiryDate ? new Date(it.expiryDate) : undefined,
                notes: it.notes,
              })),
            },
          },
          include: { items: true },
        });

        // Update inventory per item linked to a medicine
        for (const gi of grn.items) {
          const poItem = po.items.find((p) => p.id === gi.poItemId);
          if (!poItem || !poItem.medicineId) continue;
          const batch = gi.batchNumber || `PO-${po.poNumber}-${poItem.id.slice(0, 6)}`;
          const expiry =
            gi.expiryDate ||
            (() => {
              const d = new Date();
              d.setFullYear(d.getFullYear() + 2);
              return d;
            })();
          const existing = await tx.inventoryItem.findUnique({
            where: { medicineId_batchNumber: { medicineId: poItem.medicineId, batchNumber: batch } },
          });
          let inv;
          if (existing) {
            inv = await tx.inventoryItem.update({
              where: { id: existing.id },
              data: { quantity: existing.quantity + gi.quantity, unitCost: poItem.unitPrice },
            });
          } else {
            inv = await tx.inventoryItem.create({
              data: {
                medicineId: poItem.medicineId,
                batchNumber: batch,
                quantity: gi.quantity,
                unitCost: poItem.unitPrice,
                sellingPrice: poItem.unitPrice * 1.2,
                expiryDate: expiry,
                reorderLevel: 10,
              },
            });
          }
          await tx.stockMovement.create({
            data: {
              inventoryItemId: inv.id,
              type: "PURCHASE",
              quantity: gi.quantity,
              referenceId: grn.id,
              performedBy: req.user!.userId,
              reason: `GRN ${grnNumber} for PO ${po.poNumber}`,
            },
          });
        }

        // Update PO status: if all items fully received, mark RECEIVED
        const updatedReceived = new Map<string, number>(receivedByItem);
        for (const it of parsed.data.items) {
          updatedReceived.set(
            it.poItemId,
            (updatedReceived.get(it.poItemId) || 0) + it.quantity
          );
        }
        const fullyReceived = po.items.every(
          (pi) => (updatedReceived.get(pi.id) || 0) >= pi.quantity
        );
        if (fullyReceived) {
          const supplier = await tx.supplier.findUnique({ where: { id: po.supplierId } });
          await tx.purchaseOrder.update({
            where: { id: po.id },
            data: { status: "RECEIVED", receivedAt: new Date() },
          });
          // Track on-time deliveries & outstanding
          const onTime =
            po.expectedAt && new Date() <= po.expectedAt ? 1 : 0;
          if (supplier) {
            await tx.supplier.update({
              where: { id: supplier.id },
              data: {
                onTimeDeliveries: { increment: onTime },
                lateDeliveries: { increment: 1 - onTime },
                outstandingAmount: { increment: po.totalAmount },
              },
            });
          }
        }

        return grn;
      });

      auditLog(req, "CREATE_GRN", "grn", result.id, {
        grnNumber,
        poNumber: po.poNumber,
      }).catch(console.error);

      res.status(201).json({ success: true, data: result, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/purchase-orders/:id/grns
router.get(
  "/:id/grns",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const grns = await prisma.grn.findMany({
        where: { poId: req.params.id },
        include: { items: true },
        orderBy: { receivedAt: "desc" },
      });
      res.json({ success: true, data: grns, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// PATCH /api/v1/purchase-orders/:id/invoice — record supplier invoice & compute variance
router.patch(
  "/:id/invoice",
  authorize(Role.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { invoiceAmount, invoiceNumber } = req.body as {
        invoiceAmount: number;
        invoiceNumber: string;
      };
      if (typeof invoiceAmount !== "number" || !invoiceNumber) {
        res.status(400).json({
          success: false,
          data: null,
          error: "invoiceAmount (number) and invoiceNumber (string) are required",
        });
        return;
      }
      const po = await prisma.purchaseOrder.findUnique({
        where: { id: req.params.id },
      });
      if (!po) {
        res.status(404).json({ success: false, data: null, error: "Purchase order not found" });
        return;
      }
      const updated = await prisma.purchaseOrder.update({
        where: { id: po.id },
        data: { invoiceAmount, invoiceNumber },
      });
      auditLog(req, "PO_INVOICE_RECORDED", "purchase_order", po.id, {
        invoiceAmount,
        variance: invoiceAmount - po.totalAmount,
      }).catch(console.error);
      res.json({
        success: true,
        data: {
          ...updated,
          variance: +(invoiceAmount - po.totalAmount).toFixed(2),
          variancePct: po.totalAmount
            ? +(((invoiceAmount - po.totalAmount) / po.totalAmount) * 100).toFixed(2)
            : 0,
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/purchase-orders/reports/variance — variance report
router.get(
  "/reports/variance",
  authorize(Role.ADMIN, Role.RECEPTION),
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const pos = await prisma.purchaseOrder.findMany({
        where: { invoiceAmount: { not: null } },
        include: { supplier: { select: { name: true } } },
        orderBy: { createdAt: "desc" },
      });
      const rows = pos.map((p) => ({
        poNumber: p.poNumber,
        supplierName: p.supplier.name,
        totalAmount: p.totalAmount,
        invoiceAmount: p.invoiceAmount,
        variance: +((p.invoiceAmount || 0) - p.totalAmount).toFixed(2),
      }));
      const totalVariance = rows.reduce((s, r) => s + r.variance, 0);
      res.json({
        success: true,
        data: { rows, totalVariance: +totalVariance.toFixed(2) },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/v1/purchase-orders/:id/regenerate-recurring — clone as a new DRAFT PO
router.post(
  "/:id/regenerate-recurring",
  authorize(Role.ADMIN, Role.RECEPTION),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parent = await prisma.purchaseOrder.findUnique({
        where: { id: req.params.id },
        include: { items: true },
      });
      if (!parent) {
        res.status(404).json({ success: false, data: null, error: "Purchase order not found" });
        return;
      }
      if (!parent.isRecurring) {
        res.status(400).json({
          success: false,
          data: null,
          error: "Parent PO is not marked as recurring",
        });
        return;
      }
      const key = "next_po_number";
      const config = await prisma.systemConfig.findUnique({ where: { key } });
      const seq = config ? parseInt(config.value) : 1;
      const poNumber = `${PO_NUMBER_PREFIX}${String(seq).padStart(6, "0")}`;
      const po = await prisma.$transaction(async (tx) => {
        const created = await tx.purchaseOrder.create({
          data: {
            poNumber,
            supplierId: parent.supplierId,
            status: "DRAFT",
            subtotal: parent.subtotal,
            taxAmount: parent.taxAmount,
            totalAmount: parent.totalAmount,
            notes: `Recurring from ${parent.poNumber}`,
            createdBy: req.user!.userId,
            parentPoId: parent.id,
            isRecurring: true,
            recurringFrequency: parent.recurringFrequency,
            items: {
              create: parent.items.map((i) => ({
                description: i.description,
                medicineId: i.medicineId,
                quantity: i.quantity,
                unitPrice: i.unitPrice,
                amount: i.amount,
              })),
            },
          },
          include: { items: true },
        });
        if (config) {
          await tx.systemConfig.update({ where: { key }, data: { value: String(seq + 1) } });
        } else {
          await tx.systemConfig.create({ data: { key, value: String(seq + 1) } });
        }
        return created;
      });
      auditLog(req, "PO_RECURRING_REGEN", "purchase_order", po.id, {
        parentPoId: parent.id,
      }).catch(console.error);
      res.status(201).json({ success: true, data: po, error: null });
    } catch (err) {
      next(err);
    }
  }
);

export { router as purchaseOrderRouter };
