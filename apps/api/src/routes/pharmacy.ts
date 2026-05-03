import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
// Multi-tenant wiring: `tenantScopedPrisma` is a Prisma $extends wrapper that
// auto-injects tenantId on create and auto-filters on read for the 20
// tenant-scoped models (see services/tenant-prisma.ts). We alias it to
// `prisma` so every existing call site keeps working without edits.
import { tenantScopedPrisma as prisma } from "../services/tenant-prisma";
import {
  Role,
  createInventoryItemSchema,
  updateInventoryItemSchema,
  stockMovementSchema,
  dispensePrescriptionSchema,
  batchRecallSchema,
  stockAdjustmentSchema,
  pharmacyReturnSchema,
  stockTransferSchema,
  PHARMACY_RETURN_PREFIX,
  STOCK_TRANSFER_PREFIX,
} from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { validateUuidParams } from "../middleware/validate-params";
import { auditLog } from "../middleware/audit";

// ── Zod query / path-param schemas ────────────────────────────────────────

const inventoryListQuerySchema = z.object({
  search: z.string().optional(),
  lowStock: z.enum(["true", "false"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const expiringQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(365).default(30),
});

const movementsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
  type: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
});

const reorderSuggestionsQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(365).default(30),
  leadTime: z.coerce.number().int().min(1).max(90).default(7),
});

const reportMovementsQuerySchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  type: z.string().optional(),
});

const narcoticsLedgerQuerySchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
});

const valuationQuerySchema = z.object({
  method: z.enum(["FIFO", "LIFO", "WEIGHTED_AVG"]).default("WEIGHTED_AVG"),
});

const returnsQuerySchema = z.object({
  reason: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

const transfersQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

// Shared path-param schema: UUID :id
const pharmacyIdParams = validateUuidParams(["id"]);

// Body schema for the Rx-rejection endpoint. The reason must be a real
// sentence — anything under 10 chars is almost always a placeholder
// ("no", "n/a") and would not satisfy a regulator's why-was-this-rejected
// audit trail.
const rejectPrescriptionBodySchema = z.object({
  reason: z
    .string()
    .min(10, "Rejection reason must be at least 10 characters"),
});

const router = Router();
router.use(authenticate);

// GET /api/v1/pharmacy/inventory?search=&lowStock=true
// RBAC (issue #98): RECEPTION must NOT see stock levels. Reads restricted
// to clinical + pharmacy roles only.
router.get(
  "/inventory",
  authorize(Role.ADMIN, Role.PHARMACIST, Role.DOCTOR, Role.NURSE),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = inventoryListQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ success: false, data: null, error: parsed.error.issues[0]?.message ?? "Invalid query" });
        return;
      }
      const { search, lowStock, page, limit } = parsed.data;
      const skip = (page - 1) * limit;
      const take = limit;

      const where: Record<string, unknown> = {};
      if (search) {
        where.medicine = {
          OR: [
            { name: { contains: search, mode: "insensitive" } },
            { genericName: { contains: search, mode: "insensitive" } },
            { brand: { contains: search, mode: "insensitive" } },
          ],
        };
      }

      // Fetch items first
      let items = await prisma.inventoryItem.findMany({
        where,
        include: { medicine: true },
        orderBy: { updatedAt: "desc" },
      });

      // Filter low stock in memory (quantity <= reorderLevel)
      if (lowStock === "true") {
        items = items.filter((i) => i.quantity <= i.reorderLevel);
      }

      const total = items.length;
      const paged = items.slice(skip, skip + take);

      res.json({
        success: true,
        data: paged,
        error: null,
        meta: { page, limit: take, total },
      });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/pharmacy/inventory/expiring?days=30
// RBAC (issue #98): RECEPTION must NOT see stock levels.
router.get(
  "/inventory/expiring",
  authorize(Role.ADMIN, Role.PHARMACIST, Role.DOCTOR, Role.NURSE),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsedExpiring = expiringQuerySchema.safeParse(req.query);
      if (!parsedExpiring.success) {
        res.status(400).json({ success: false, data: null, error: parsedExpiring.error.issues[0]?.message ?? "Invalid query" });
        return;
      }
      const { days } = parsedExpiring.data;
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() + days);

      const items = await prisma.inventoryItem.findMany({
        where: {
          expiryDate: { lte: cutoff },
          quantity: { gt: 0 },
        },
        include: { medicine: true },
        orderBy: { expiryDate: "asc" },
      });

      res.json({ success: true, data: items, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/v1/pharmacy/inventory — add stock + create PURCHASE movement
// RBAC (issue #98): inventory writes restricted to ADMIN + PHARMACIST.
// RECEPTION used to be allowed (PO receiving workflow predates the
// PHARMACIST role) — they can still receive POs via /purchase-orders, but
// direct stock writes are pharmacy-side only now.
router.post(
  "/inventory",
  authorize(Role.ADMIN, Role.PHARMACIST),
  validate(createInventoryItemSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const {
        medicineId,
        batchNumber,
        quantity,
        unitCost,
        sellingPrice,
        expiryDate,
        supplier,
        reorderLevel,
        location,
      } = req.body;

      const result = await prisma.$transaction(async (tx) => {
        // Upsert by (medicineId, batchNumber) — if exists, add quantity
        const existing = await tx.inventoryItem.findUnique({
          where: {
            medicineId_batchNumber: { medicineId, batchNumber },
          },
        });

        let item;
        if (existing) {
          item = await tx.inventoryItem.update({
            where: { id: existing.id },
            data: {
              quantity: existing.quantity + quantity,
              unitCost,
              sellingPrice,
              expiryDate: new Date(expiryDate),
              supplier: supplier ?? existing.supplier,
              reorderLevel: reorderLevel ?? existing.reorderLevel,
              location: location ?? existing.location,
            },
            include: { medicine: true },
          });
        } else {
          item = await tx.inventoryItem.create({
            data: {
              medicineId,
              batchNumber,
              quantity,
              unitCost,
              sellingPrice,
              expiryDate: new Date(expiryDate),
              supplier,
              reorderLevel: reorderLevel ?? 10,
              location,
            },
            include: { medicine: true },
          });
        }

        await tx.stockMovement.create({
          data: {
            inventoryItemId: item.id,
            type: "PURCHASE",
            quantity,
            performedBy: req.user!.userId,
            reason: "Stock added",
          },
        });

        return item;
      });

      auditLog(req, "INVENTORY_CREATE", "inventory_item", result.id, {
        medicineId,
        batchNumber,
        quantity,
      }).catch(console.error);

      res.status(201).json({ success: true, data: result, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// PATCH /api/v1/pharmacy/inventory/:id — update location/reorderLevel/sellingPrice
// RBAC (issue #98): inventory writes restricted to ADMIN + PHARMACIST.
router.patch(
  "/inventory/:id",
  authorize(Role.ADMIN, Role.PHARMACIST),
  pharmacyIdParams,
  validate(updateInventoryItemSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const item = await prisma.inventoryItem.update({
        where: { id: req.params.id },
        data: req.body,
        include: { medicine: true },
      });
      auditLog(req, "INVENTORY_UPDATE", "inventory_item", item.id, req.body).catch(
        console.error
      );
      res.json({ success: true, data: item, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/v1/pharmacy/stock-movements — manual movement
// RBAC (issue #98): stock writes restricted to ADMIN + PHARMACIST.
router.post(
  "/stock-movements",
  authorize(Role.ADMIN, Role.PHARMACIST),
  validate(stockMovementSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { inventoryItemId, type, quantity, reason } = req.body;

      const movement = await prisma.$transaction(async (tx) => {
        const item = await tx.inventoryItem.findUnique({
          where: { id: inventoryItemId },
        });
        if (!item) throw new Error("Inventory item not found");

        // Determine signed change: inbound types add, outbound subtract
        const inbound = type === "PURCHASE" || type === "RETURNED";
        const delta = inbound ? Math.abs(quantity) : -Math.abs(quantity);
        const newQty = item.quantity + delta;

        if (newQty < 0) throw new Error("Insufficient stock");

        await tx.inventoryItem.update({
          where: { id: item.id },
          data: { quantity: newQty },
        });

        return tx.stockMovement.create({
          data: {
            inventoryItemId,
            type,
            quantity: delta,
            performedBy: req.user!.userId,
            reason,
          },
          include: { inventoryItem: { include: { medicine: true } } },
        });
      });

      auditLog(
        req,
        "STOCK_MOVE",
        "stock_movement",
        movement.id,
        { type, quantity, reason }
      ).catch(console.error);

      res.status(201).json({ success: true, data: movement, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/v1/pharmacy/dispense — dispense a prescription
router.post(
  "/dispense",
  authorize(Role.ADMIN, Role.PHARMACIST, Role.NURSE),
  validate(dispensePrescriptionSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { prescriptionId } = req.body;

      const prescription = await prisma.prescription.findUnique({
        where: { id: prescriptionId },
        include: { items: true },
      });

      if (!prescription) {
        res.status(404).json({
          success: false,
          data: null,
          error: "Prescription not found",
        });
        return;
      }

      const dispensed: Array<{
        medicineName: string;
        medicineId: string;
        requiresRegister: boolean;
        inventoryItemId: string;
        batchNumber: string;
        quantity: number;
        unitPrice: number;
        lineAmount: number;
      }> = [];
      const warnings: string[] = [];

      await prisma.$transaction(async (tx) => {
        for (const item of prescription.items) {
          // Parse numeric qty from duration/dosage — assume 1 unit per item if not derivable
          const qtyMatch = item.duration.match(/(\d+)/);
          const qty = qtyMatch ? parseInt(qtyMatch[1]) : 1;

          // Find matching medicine by name (case insensitive)
          const medicine = await tx.medicine.findFirst({
            where: {
              OR: [
                { name: { equals: item.medicineName, mode: "insensitive" } },
                {
                  genericName: {
                    equals: item.medicineName,
                    mode: "insensitive",
                  },
                },
                {
                  name: { contains: item.medicineName, mode: "insensitive" },
                },
              ],
            },
          });

          if (!medicine) {
            warnings.push(`Medicine not found: ${item.medicineName}`);
            continue;
          }

          // Find an inventory batch with enough stock, earliest expiry first
          const inv = await tx.inventoryItem.findFirst({
            where: {
              medicineId: medicine.id,
              quantity: { gte: qty },
              expiryDate: { gt: new Date() },
            },
            orderBy: { expiryDate: "asc" },
          });

          if (!inv) {
            warnings.push(
              `Insufficient stock for ${item.medicineName} (need ${qty})`
            );
            continue;
          }

          await tx.inventoryItem.update({
            where: { id: inv.id },
            data: { quantity: inv.quantity - qty },
          });

          await tx.stockMovement.create({
            data: {
              inventoryItemId: inv.id,
              type: "DISPENSED",
              quantity: -qty,
              referenceId: prescriptionId,
              performedBy: req.user!.userId,
              reason: `Dispensed for prescription ${prescriptionId}`,
            },
          });

          dispensed.push({
            medicineName: item.medicineName,
            medicineId: medicine.id,
            requiresRegister: medicine.requiresRegister === true,
            inventoryItemId: inv.id,
            batchNumber: inv.batchNumber,
            quantity: qty,
            unitPrice: inv.sellingPrice,
            lineAmount: inv.sellingPrice * qty,
          });
        }
      });

      // Auto-create controlled-substance entries for dispensed items with requiresRegister=true
      const controlledCreated: Array<{ entryNumber: string; medicineId: string }> = [];
      for (const d of dispensed.filter((x) => x.requiresRegister)) {
        try {
          const last = await prisma.controlledSubstanceEntry.findFirst({
            orderBy: { createdAt: "desc" },
            select: { entryNumber: true },
          });
          let next = 1;
          if (last?.entryNumber) {
            const m = last.entryNumber.match(/CSR(\d+)/);
            if (m) next = parseInt(m[1]) + 1;
          }
          const entryNumber = "CSR" + String(next).padStart(6, "0");

          const lastForMed = await prisma.controlledSubstanceEntry.findFirst({
            where: { medicineId: d.medicineId },
            orderBy: { dispensedAt: "desc" },
            select: { balance: true },
          });
          let balance: number;
          if (lastForMed) {
            balance = Math.max(0, lastForMed.balance - d.quantity);
          } else {
            const agg = await prisma.inventoryItem.aggregate({
              where: { medicineId: d.medicineId, recalled: false },
              _sum: { quantity: true },
            });
            balance = Math.max(0, (agg._sum.quantity ?? 0));
          }
          const entry = await prisma.controlledSubstanceEntry.create({
            data: {
              entryNumber,
              medicineId: d.medicineId,
              quantity: d.quantity,
              patientId: prescription.patientId,
              prescriptionId: prescription.id,
              doctorId: prescription.doctorId,
              dispensedBy: req.user!.userId,
              balance,
              notes: `Auto-registered on dispense of Rx ${prescription.id}`,
            },
          });
          controlledCreated.push({
            entryNumber: entry.entryNumber,
            medicineId: entry.medicineId,
          });
        } catch (e) {
          console.error("[controlled-auto-register]", e);
          warnings.push(
            `Failed to auto-register controlled substance: ${d.medicineName}`
          );
        }
      }

      // Auto-billing: if this prescription's appointment has a PENDING invoice,
      // append dispensed items as InvoiceItems.
      let autoBilled: {
        invoiceId: string | null;
        addedLines: number;
        addedAmount: number;
      } = { invoiceId: null, addedLines: 0, addedAmount: 0 };
      if (dispensed.length > 0) {
        try {
          const invoice = await prisma.invoice.findUnique({
            where: { appointmentId: prescription.appointmentId },
          });
          if (invoice && invoice.paymentStatus === "PENDING") {
            const itemsToCreate = dispensed.map((d) => ({
              invoiceId: invoice.id,
              description: `Pharmacy: ${d.medicineName} (Batch ${d.batchNumber})`,
              category: "PHARMACY",
              quantity: d.quantity,
              unitPrice: d.unitPrice,
              amount: d.lineAmount,
            }));
            const addedAmount = itemsToCreate.reduce((s, i) => s + i.amount, 0);
            await prisma.$transaction([
              prisma.invoiceItem.createMany({ data: itemsToCreate }),
              prisma.invoice.update({
                where: { id: invoice.id },
                data: {
                  subtotal: invoice.subtotal + addedAmount,
                  totalAmount: invoice.totalAmount + addedAmount,
                },
              }),
            ]);
            autoBilled = {
              invoiceId: invoice.id,
              addedLines: itemsToCreate.length,
              addedAmount,
            };
          }
        } catch (e) {
          console.error("[pharmacy-autobill]", e);
          warnings.push("Auto-billing failed; dispense completed without line items");
        }
      }

      // Lifecycle (2026-05-03): flip Prescription.status to DISPENSED on a
      // successful full-dispense (zero warnings = every line found stock).
      // This complements the legacy `printed` boolean so existing dispense-
      // log / pharmacy reports keep working. Defense in depth — neither
      // breaks if the other already exists.
      const fullyDispensed =
        dispensed.length > 0 &&
        warnings.length === 0 &&
        dispensed.length === prescription.items.length;
      if (fullyDispensed) {
        try {
          await prisma.prescription.update({
            where: { id: prescriptionId },
            data: { status: "DISPENSED" },
          });
        } catch (e) {
          console.error("[prescription-status-update]", e);
          warnings.push("Failed to update prescription status to DISPENSED");
        }
      }

      auditLog(req, "PRESCRIPTION_DISPENSE", "prescription", prescriptionId, {
        dispensedCount: dispensed.length,
        warningCount: warnings.length,
        autoBilledInvoiceId: autoBilled.invoiceId,
        autoBilledAmount: autoBilled.addedAmount,
        statusFlipped: fullyDispensed,
      }).catch(console.error);

      res.json({
        success: true,
        data: { dispensed, warnings, prescriptionId, autoBilled, controlledCreated },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/v1/pharmacy/prescriptions/:id/reject — pharmacist rejects an Rx
// State-machine guard: only PENDING prescriptions can be rejected. Already-
// DISPENSED or already-CANCELLED rows are immutable from this endpoint —
// reject the request with 409 so the caller can refresh and decide.
router.post(
  "/prescriptions/:id/reject",
  authorize(Role.ADMIN, Role.PHARMACIST),
  pharmacyIdParams,
  validate(rejectPrescriptionBodySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { reason } = req.body;
      const existing = await prisma.prescription.findUnique({
        where: { id: req.params.id },
      });
      if (!existing) {
        res.status(404).json({
          success: false,
          data: null,
          error: "Prescription not found",
        });
        return;
      }
      if (existing.status !== "PENDING") {
        res.status(409).json({
          success: false,
          data: null,
          error: `Cannot reject prescription in status ${existing.status}`,
        });
        return;
      }
      const updated = await prisma.prescription.update({
        where: { id: existing.id },
        data: {
          status: "REJECTED",
          rejectionReason: reason,
          rejectedAt: new Date(),
          rejectedBy: req.user!.userId,
        },
      });
      auditLog(req, "PRESCRIPTION_REJECTED", "prescription", existing.id, {
        reason,
      }).catch(console.error);
      res.json({ success: true, data: updated, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/pharmacy/movements?limit=100&type=
// Issue #50: Pharmacy → Movements tab in apps/web/.../pharmacy/page.tsx hits
//   `/pharmacy/movements` but only `/pharmacy/reports/movements` (admin-only)
//   existed previously, so all roles got an empty list. This adds a
//   non-admin-readable list capped at 500 rows for the inline tab view.
router.get(
  "/movements",
  // Issue #174 (Apr 30 2026): stock movements expose batch numbers + inventory
  // changes. Pharmacy module — restrict to dispensing roles.
  authorize(Role.ADMIN, Role.PHARMACIST, Role.DOCTOR, Role.NURSE),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsedMov = movementsQuerySchema.safeParse(req.query);
      if (!parsedMov.success) {
        res.status(400).json({ success: false, data: null, error: parsedMov.error.issues[0]?.message ?? "Invalid query" });
        return;
      }
      const { limit, offset, type, from, to } = parsedMov.data;
      const where: Record<string, unknown> = {};
      if (type) where.type = type;
      if (from || to) {
        const range: Record<string, Date> = {};
        if (from) range.gte = new Date(from);
        if (to) range.lte = new Date(to);
        where.createdAt = range;
      }

      const movements = await prisma.stockMovement.findMany({
        where,
        include: {
          inventoryItem: {
            select: {
              batchNumber: true,
              medicine: { select: { name: true } },
            },
          },
        },
        orderBy: { createdAt: "desc" },
        skip: offset,
        take: limit,
      });

      // Massage payload to match the FE Movement interface (notes alias).
      const data = movements.map((m) => ({
        id: m.id,
        type: m.type,
        quantity: m.quantity,
        createdAt: m.createdAt,
        notes: m.reason,
        inventory: m.inventoryItem
          ? {
              batchNumber: m.inventoryItem.batchNumber,
              medicine: { name: m.inventoryItem.medicine.name },
            }
          : null,
      }));

      res.json({ success: true, data, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/pharmacy/reports/stock-value
router.get(
  "/reports/stock-value",
  authorize(Role.ADMIN),
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const items = await prisma.inventoryItem.findMany({
        select: { quantity: true, unitCost: true, sellingPrice: true },
      });

      const costValue = items.reduce(
        (sum, i) => sum + i.quantity * i.unitCost,
        0
      );
      const sellValue = items.reduce(
        (sum, i) => sum + i.quantity * i.sellingPrice,
        0
      );
      const totalUnits = items.reduce((sum, i) => sum + i.quantity, 0);

      res.json({
        success: true,
        data: {
          totalItems: items.length,
          totalUnits,
          costValue: Math.round(costValue * 100) / 100,
          sellValue: Math.round(sellValue * 100) / 100,
          potentialProfit: Math.round((sellValue - costValue) * 100) / 100,
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/pharmacy/reports/movements?from=&to=
router.get(
  "/reports/movements",
  authorize(Role.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsedRptMov = reportMovementsQuerySchema.safeParse(req.query);
      if (!parsedRptMov.success) {
        res.status(400).json({ success: false, data: null, error: parsedRptMov.error.issues[0]?.message ?? "Invalid query" });
        return;
      }
      const { from, to, type } = parsedRptMov.data;
      const where: Record<string, unknown> = {};

      if (from || to) {
        where.createdAt = {};
        if (from) (where.createdAt as any).gte = new Date(from);
        if (to) (where.createdAt as any).lte = new Date(to);
      }
      if (type) where.type = type;

      const movements = await prisma.stockMovement.findMany({
        where,
        include: {
          inventoryItem: { include: { medicine: true } },
          user: { select: { id: true, name: true, role: true } },
        },
        orderBy: { createdAt: "desc" },
        take: 500,
      });

      res.json({ success: true, data: movements, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// ───────────────────────────────────────────────────────
// BARCODE LOOKUP
// ───────────────────────────────────────────────────────

router.get(
  "/inventory/barcode/:barcode",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const item = await prisma.inventoryItem.findFirst({
        where: { barcode: req.params.barcode },
        include: { medicine: true },
      });
      if (!item) {
        res
          .status(404)
          .json({ success: false, data: null, error: "No inventory matches that barcode" });
        return;
      }
      res.json({ success: true, data: item, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// ───────────────────────────────────────────────────────
// BATCH RECALL
// ───────────────────────────────────────────────────────

router.post(
  "/inventory/:id/recall",
  authorize(Role.ADMIN),
  pharmacyIdParams,
  validate(batchRecallSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const item = await prisma.inventoryItem.findUnique({
        where: { id: req.params.id },
      });
      if (!item) {
        res.status(404).json({ success: false, data: null, error: "Inventory item not found" });
        return;
      }

      const updated = await prisma.$transaction(async (tx) => {
        const u = await tx.inventoryItem.update({
          where: { id: item.id },
          data: {
            recalled: true,
            recalledAt: new Date(),
            recallReason: req.body.reason,
          },
        });
        // Quarantine by writing a movement that zeros the stock via ADJUSTMENT
        if (item.quantity > 0) {
          await tx.stockMovement.create({
            data: {
              inventoryItemId: item.id,
              type: "ADJUSTMENT",
              quantity: -item.quantity,
              performedBy: req.user!.userId,
              reason: `Batch recall: ${req.body.reason}`,
            },
          });
          await tx.inventoryItem.update({
            where: { id: item.id },
            data: { quantity: 0 },
          });
        }
        return u;
      });

      auditLog(req, "INVENTORY_BATCH_RECALL", "inventory_item", item.id, {
        reason: req.body.reason,
        batchNumber: item.batchNumber,
      }).catch(console.error);

      res.json({ success: true, data: updated, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// ───────────────────────────────────────────────────────
// REORDER SUGGESTIONS (consumption rate driven)
// ───────────────────────────────────────────────────────

router.get(
  "/reports/reorder-suggestions",
  // RBAC (issue #98): exposes stock counts per medicine — pharmacy roles only.
  authorize(Role.ADMIN, Role.PHARMACIST),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsedReorder = reorderSuggestionsQuerySchema.safeParse(req.query);
      if (!parsedReorder.success) {
        res.status(400).json({ success: false, data: null, error: parsedReorder.error.issues[0]?.message ?? "Invalid query" });
        return;
      }
      const { days, leadTime } = parsedReorder.data;
      const leadTimeDays = leadTime;
      const since = new Date(Date.now() - days * 24 * 3600 * 1000);

      // Aggregate DISPENSED movements per medicineId over last N days
      const movements = await prisma.stockMovement.findMany({
        where: {
          type: "DISPENSED",
          createdAt: { gte: since },
        },
        include: { inventoryItem: { select: { medicineId: true } } },
      });

      const consumed: Record<string, number> = {};
      for (const m of movements) {
        const mid = m.inventoryItem.medicineId;
        consumed[mid] = (consumed[mid] || 0) + Math.abs(m.quantity);
      }

      // Current stock + reorderLevel per medicine
      const grouped = await prisma.inventoryItem.groupBy({
        by: ["medicineId"],
        _sum: { quantity: true },
        _min: { reorderLevel: true },
      });

      const medIds = grouped.map((g) => g.medicineId);
      const medicines = await prisma.medicine.findMany({
        where: { id: { in: medIds } },
        select: { id: true, name: true, genericName: true, category: true },
      });
      const medMap = new Map(medicines.map((m) => [m.id, m]));

      const suggestions = grouped
        .map((g) => {
          const dailyUse = (consumed[g.medicineId] || 0) / days;
          const stock = g._sum.quantity || 0;
          const reorderLevel = g._min.reorderLevel || 0;
          const projectedUse = dailyUse * leadTimeDays;
          const suggestedQty = Math.max(
            0,
            Math.ceil(projectedUse * 2 + reorderLevel - stock)
          );
          const daysOfStock = dailyUse > 0 ? Math.floor(stock / dailyUse) : null;
          return {
            medicineId: g.medicineId,
            medicine: medMap.get(g.medicineId),
            currentStock: stock,
            reorderLevel,
            dailyConsumption: Math.round(dailyUse * 100) / 100,
            daysOfStockRemaining: daysOfStock,
            suggestedOrderQty: suggestedQty,
            priority:
              daysOfStock !== null && daysOfStock < leadTimeDays
                ? "HIGH"
                : stock <= reorderLevel
                  ? "MEDIUM"
                  : "LOW",
          };
        })
        .filter((s) => s.suggestedOrderQty > 0 || s.currentStock <= s.reorderLevel)
        .sort((a, b) => {
          const order = { HIGH: 0, MEDIUM: 1, LOW: 2 } as Record<string, number>;
          return order[a.priority] - order[b.priority];
        });

      res.json({
        success: true,
        data: { windowDays: days, leadTimeDays, suggestions },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ───────────────────────────────────────────────────────
// STOCK ADJUSTMENT WITH REASON CODES
// ───────────────────────────────────────────────────────

router.post(
  "/stock-adjustments",
  // RBAC (issue #98): stock writes restricted to ADMIN + PHARMACIST.
  authorize(Role.ADMIN, Role.PHARMACIST),
  validate(stockAdjustmentSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { inventoryItemId, quantity, reasonCode, reason } = req.body;

      const movement = await prisma.$transaction(async (tx) => {
        const item = await tx.inventoryItem.findUnique({
          where: { id: inventoryItemId },
        });
        if (!item) throw new Error("Inventory item not found");
        const newQty = item.quantity + quantity;
        if (newQty < 0) throw new Error("Insufficient stock for adjustment");
        await tx.inventoryItem.update({
          where: { id: item.id },
          data: { quantity: newQty },
        });
        return tx.stockMovement.create({
          data: {
            inventoryItemId,
            type: "ADJUSTMENT",
            quantity,
            performedBy: req.user!.userId,
            reason: `[${reasonCode}] ${reason ?? ""}`.trim(),
          },
          include: { inventoryItem: { include: { medicine: true } } },
        });
      });

      auditLog(req, "STOCK_ADJUST", "stock_movement", movement.id, {
        reasonCode,
        quantity,
      }).catch(console.error);

      res.status(201).json({ success: true, data: movement, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// ───────────────────────────────────────────────────────
// NARCOTIC / SCHEDULE DRUG LEDGER
// ───────────────────────────────────────────────────────

router.get(
  "/reports/narcotics-ledger",
  authorize(Role.ADMIN, Role.DOCTOR),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsedNarc = narcoticsLedgerQuerySchema.safeParse(req.query);
      if (!parsedNarc.success) {
        res.status(400).json({ success: false, data: null, error: parsedNarc.error.issues[0]?.message ?? "Invalid query" });
        return;
      }
      const { from, to } = parsedNarc.data;
      const movements = await prisma.stockMovement.findMany({
        where: {
          inventoryItem: { medicine: { isNarcotic: true } },
          ...(from || to
            ? {
                createdAt: {
                  ...(from ? { gte: new Date(from) } : {}),
                  ...(to ? { lte: new Date(to) } : {}),
                },
              }
            : {}),
        },
        include: {
          inventoryItem: { include: { medicine: true } },
          user: { select: { id: true, name: true, role: true } },
        },
        orderBy: { createdAt: "desc" },
        take: 500,
      });

      res.json({ success: true, data: movements, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// ───────────────────────────────────────────────────────
// SUBSTITUTION SUGGESTIONS (same generic, different brand)
// ───────────────────────────────────────────────────────

router.get(
  "/substitutes/:medicineId",
  validateUuidParams(["medicineId"]),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const base = await prisma.medicine.findUnique({
        where: { id: req.params.medicineId },
      });
      if (!base) {
        res.status(404).json({ success: false, data: null, error: "Medicine not found" });
        return;
      }
      const substitutes = await prisma.medicine.findMany({
        where: {
          id: { not: base.id },
          genericName: base.genericName ?? undefined,
          strength: base.strength ?? undefined,
          form: base.form ?? undefined,
        },
        include: {
          inventoryItems: {
            where: { quantity: { gt: 0 }, recalled: false },
            select: { quantity: true, sellingPrice: true, batchNumber: true },
            take: 3,
          },
        },
      });
      res.json({ success: true, data: substitutes, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// ───────────────────────────────────────────────────────
// RETURNS / EXCHANGE (Apr 2026)
// ───────────────────────────────────────────────────────

router.post(
  "/returns",
  authorize(Role.ADMIN, Role.PHARMACIST, Role.NURSE),
  validate(pharmacyReturnSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { inventoryItemId, quantity, reason, refundAmount, originalDispenseId } =
        req.body;

      const item = await prisma.inventoryItem.findUnique({
        where: { id: inventoryItemId },
      });
      if (!item) {
        res
          .status(404)
          .json({ success: false, data: null, error: "Inventory item not found" });
        return;
      }

      // Issue #51: cap return quantity at on-hand stock. Without this, the
      // backend trusted whatever quantity the form posted (zod only checked it
      // was a positive int) — pharmacists could "return" 2x what they had on
      // shelf, inflating refunds. Frontend max attribute also enforces this.
      if (quantity > item.quantity) {
        res.status(400).json({
          success: false,
          data: null,
          error: `Return quantity (${quantity}) exceeds on-hand stock (${item.quantity})`,
        });
        return;
      }

      // Generate return number
      const cfgKey = "next_pharmacy_return_number";
      const cfg = await prisma.systemConfig.findUnique({ where: { key: cfgKey } });
      const seq = cfg ? parseInt(cfg.value) : 1;
      const returnNumber = `${PHARMACY_RETURN_PREFIX}${String(seq).padStart(6, "0")}`;

      const result = await prisma.$transaction(async (tx) => {
        const rec = await tx.pharmacyReturn.create({
          data: {
            returnNumber,
            inventoryItemId,
            quantity,
            reason,
            refundAmount: refundAmount ?? 0,
            originalDispenseMovementId: originalDispenseId ?? null,
            performedBy: req.user!.userId,
          },
        });

        // Create RETURNED StockMovement + increment item qty (unless expired/damaged — still log but don't restock)
        const restock =
          reason === "PATIENT_RETURNED" || reason === "WRONG_ITEM";
        await tx.stockMovement.create({
          data: {
            inventoryItemId,
            type: "RETURNED",
            quantity: restock ? quantity : 0,
            reason: `${reason}${restock ? "" : " (not restocked)"}`,
            performedBy: req.user!.userId,
            referenceId: rec.id,
          },
        });
        if (restock) {
          await tx.inventoryItem.update({
            where: { id: inventoryItemId },
            data: { quantity: { increment: quantity } },
          });
        }

        if (cfg) {
          await tx.systemConfig.update({
            where: { key: cfgKey },
            data: { value: String(seq + 1) },
          });
        } else {
          await tx.systemConfig.create({
            data: { key: cfgKey, value: String(seq + 1) },
          });
        }
        return rec;
      });

      auditLog(req, "PHARMACY_RETURN", "pharmacy_return", result.id, {
        inventoryItemId,
        quantity,
        reason,
      }).catch(console.error);

      res.status(201).json({ success: true, data: result, error: null });
    } catch (err) {
      next(err);
    }
  }
);

router.get(
  "/returns",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Issue #367 (Apr 30 2026): pagination. The list previously fetched
      // every return ever recorded (no LIMIT), which timed out as the
      // table grew past a few thousand rows. Capped at 100 by default,
      // 200 max — the UI auto-refreshes on tab focus so newer rows show
      // up without a manual reload.
      const parsedReturns = returnsQuerySchema.safeParse(req.query);
      if (!parsedReturns.success) {
        res.status(400).json({ success: false, data: null, error: parsedReturns.error.issues[0]?.message ?? "Invalid query" });
        return;
      }
      const { reason, from, to, page, limit } = parsedReturns.data;
      const where: Record<string, unknown> = {};
      if (reason) where.reason = reason;
      if (from || to) {
        where.createdAt = {
          ...(from ? { gte: new Date(from) } : {}),
          ...(to ? { lte: new Date(to) } : {}),
        };
      }
      const take = limit;
      const skip = (page - 1) * take;
      const [rows, total] = await Promise.all([
        prisma.pharmacyReturn.findMany({
          where,
          orderBy: { createdAt: "desc" },
          include: {
            inventoryItem: { include: { medicine: true } },
          },
          skip,
          take,
        }),
        prisma.pharmacyReturn.count({ where }),
      ]);
      res.json({
        success: true,
        data: rows,
        error: null,
        meta: { page, limit: take, total },
      });
    } catch (err) {
      next(err);
    }
  }
);

// ───────────────────────────────────────────────────────
// STOCK TRANSFERS (Apr 2026)
// ───────────────────────────────────────────────────────

router.post(
  "/transfers",
  // RBAC (issue #98): stock writes restricted to ADMIN + PHARMACIST.
  authorize(Role.ADMIN, Role.PHARMACIST),
  validate(stockTransferSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { inventoryItemId, fromLocation, toLocation, quantity, notes } =
        req.body;
      const item = await prisma.inventoryItem.findUnique({
        where: { id: inventoryItemId },
      });
      if (!item) {
        res
          .status(404)
          .json({ success: false, data: null, error: "Inventory item not found" });
        return;
      }

      const cfgKey = "next_stock_transfer_number";
      const cfg = await prisma.systemConfig.findUnique({ where: { key: cfgKey } });
      const seq = cfg ? parseInt(cfg.value) : 1;
      const transferNumber = `${STOCK_TRANSFER_PREFIX}${String(seq).padStart(6, "0")}`;

      const result = await prisma.$transaction(async (tx) => {
        const rec = await tx.stockTransfer.create({
          data: {
            transferNumber,
            inventoryItemId,
            fromLocation,
            toLocation,
            quantity,
            performedBy: req.user!.userId,
            notes: notes ?? null,
          },
        });
        await tx.inventoryItem.update({
          where: { id: inventoryItemId },
          data: { location: toLocation },
        });
        await tx.stockMovement.create({
          data: {
            inventoryItemId,
            type: "ADJUSTMENT",
            quantity: 0,
            reason: `Transfer ${fromLocation} → ${toLocation}`,
            performedBy: req.user!.userId,
            referenceId: rec.id,
          },
        });
        if (cfg) {
          await tx.systemConfig.update({
            where: { key: cfgKey },
            data: { value: String(seq + 1) },
          });
        } else {
          await tx.systemConfig.create({
            data: { key: cfgKey, value: String(seq + 1) },
          });
        }
        return rec;
      });

      auditLog(req, "STOCK_TRANSFER", "stock_transfer", result.id, {
        fromLocation,
        toLocation,
        quantity,
      }).catch(console.error);
      res.status(201).json({ success: true, data: result, error: null });
    } catch (err) {
      next(err);
    }
  }
);

router.get(
  "/transfers",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Issue #367 (Apr 30 2026): pagination + total count. Mirrors /returns.
      const parsedTransfers = transfersQuerySchema.safeParse(req.query);
      if (!parsedTransfers.success) {
        res.status(400).json({ success: false, data: null, error: parsedTransfers.error.issues[0]?.message ?? "Invalid query" });
        return;
      }
      const { page, limit } = parsedTransfers.data;
      const take = limit;
      const skip = (page - 1) * take;
      const [rows, total] = await Promise.all([
        prisma.stockTransfer.findMany({
          orderBy: { transferredAt: "desc" },
          include: { inventoryItem: { include: { medicine: true } } },
          skip,
          take,
        }),
        prisma.stockTransfer.count(),
      ]);
      res.json({
        success: true,
        data: rows,
        error: null,
        meta: { page, limit: take, total },
      });
    } catch (err) {
      next(err);
    }
  }
);

// ───────────────────────────────────────────────────────
// LOW STOCK → SUPPLIER ORDER (stub)
// ───────────────────────────────────────────────────────

router.post(
  "/inventory/:id/order-from-supplier",
  // RBAC (issue #98): supplier ordering off the inventory record is a stock
  // write — pharmacy roles only.
  authorize(Role.ADMIN, Role.PHARMACIST),
  pharmacyIdParams,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const item = await prisma.inventoryItem.findUnique({
        where: { id: req.params.id },
        include: { medicine: true },
      });
      if (!item) {
        res
          .status(404)
          .json({ success: false, data: null, error: "Inventory item not found" });
        return;
      }

      // find best supplier from catalog
      const catalogMatch = await prisma.supplierCatalogItem.findFirst({
        where: { medicineId: item.medicineId, isActive: true },
        orderBy: { unitPrice: "asc" },
      });
      if (!catalogMatch) {
        res.status(404).json({
          success: false,
          data: null,
          error: "No supplier found for this medicine",
        });
        return;
      }
      const supplier = await prisma.supplier.findUnique({
        where: { id: catalogMatch.supplierId },
      });

      const qty =
        item.reorderQuantity && item.reorderQuantity > 0
          ? item.reorderQuantity
          : Math.max(catalogMatch.moq, (item.reorderLevel ?? 10) * 2);

      // Create draft PO
      const poSeqCfg = await prisma.systemConfig.findUnique({
        where: { key: "next_po_number" },
      });
      const poSeq = poSeqCfg ? parseInt(poSeqCfg.value) : 1;
      const poNumber = `PO${String(poSeq).padStart(6, "0")}`;

      const unitPrice = catalogMatch.unitPrice;
      const subtotal = unitPrice * qty;

      const po = await prisma.$transaction(async (tx) => {
        const p = await tx.purchaseOrder.create({
          data: {
            poNumber,
            supplierId: catalogMatch.supplierId,
            status: "DRAFT",
            subtotal,
            taxAmount: 0,
            totalAmount: subtotal,
            createdBy: req.user!.userId,
            items: {
              create: [
                {
                  description: item.medicine.name,
                  medicineId: item.medicineId,
                  quantity: qty,
                  unitPrice,
                  amount: subtotal,
                },
              ],
            },
          },
        });
        if (poSeqCfg) {
          await tx.systemConfig.update({
            where: { key: "next_po_number" },
            data: { value: String(poSeq + 1) },
          });
        } else {
          await tx.systemConfig.create({
            data: { key: "next_po_number", value: String(poSeq + 1) },
          });
        }
        return p;
      });

      auditLog(req, "SUPPLIER_ORDER_DRAFT", "purchase_order", po.id, {
        supplierId: catalogMatch.supplierId,
        quantity: qty,
      }).catch(console.error);

      res.status(201).json({
        success: true,
        data: {
          po,
          supplier,
          emailStub: `Email queued to ${supplier?.email ?? "(no email)"} for PO ${poNumber}`,
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ───────────────────────────────────────────────────────
// INVENTORY VALUATION (FIFO / LIFO / WEIGHTED_AVG)
// ───────────────────────────────────────────────────────

router.get(
  "/reports/valuation",
  authorize(Role.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsedValuation = valuationQuerySchema.safeParse(req.query);
      if (!parsedValuation.success) {
        res.status(400).json({
          success: false,
          data: null,
          error: parsedValuation.error.issues[0]?.message ?? "method must be FIFO | LIFO | WEIGHTED_AVG",
        });
        return;
      }
      const { method } = parsedValuation.data;

      // Group inventory by medicine with batches. For FIFO/LIFO use purchase-
      // movements ordered asc/desc to take layers up to on-hand qty. For
      // WEIGHTED_AVG use avg cost over batch rows with qty > 0.
      const medicines = await prisma.medicine.findMany({
        include: {
          inventoryItems: {
            where: { recalled: false },
            include: {
              movements: {
                where: { type: "PURCHASE" },
                orderBy: { createdAt: method === "LIFO" ? "desc" : "asc" },
              },
            },
          },
        },
      });

      const per: Array<{
        medicineId: string;
        medicineName: string;
        onHand: number;
        unitValue: number;
        totalValue: number;
      }> = [];
      let grandTotal = 0;

      for (const med of medicines) {
        const onHand = med.inventoryItems.reduce((s, b) => s + b.quantity, 0);
        if (onHand === 0) {
          per.push({
            medicineId: med.id,
            medicineName: med.name,
            onHand: 0,
            unitValue: 0,
            totalValue: 0,
          });
          continue;
        }

        let totalValue = 0;
        if (method === "WEIGHTED_AVG") {
          const totalQty = onHand;
          const totalCost = med.inventoryItems.reduce(
            (s, b) => s + b.unitCost * b.quantity,
            0
          );
          totalValue = totalCost;
          const unitValue = totalQty > 0 ? totalCost / totalQty : 0;
          per.push({
            medicineId: med.id,
            medicineName: med.name,
            onHand,
            unitValue: +unitValue.toFixed(2),
            totalValue: +totalValue.toFixed(2),
          });
        } else {
          // FIFO/LIFO — build cost layers from batches sorted by createdAt
          const batches = [...med.inventoryItems].sort((a, b) =>
            method === "LIFO"
              ? b.createdAt.getTime() - a.createdAt.getTime()
              : a.createdAt.getTime() - b.createdAt.getTime()
          );
          let remaining = onHand;
          for (const b of batches) {
            if (remaining <= 0) break;
            const take = Math.min(remaining, b.quantity);
            totalValue += take * b.unitCost;
            remaining -= take;
          }
          per.push({
            medicineId: med.id,
            medicineName: med.name,
            onHand,
            unitValue: +(totalValue / onHand).toFixed(2),
            totalValue: +totalValue.toFixed(2),
          });
        }

        grandTotal += totalValue;
      }

      res.json({
        success: true,
        data: {
          method,
          perMedicine: per.filter((p) => p.onHand > 0),
          totalValue: +grandTotal.toFixed(2),
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

export { router as pharmacyRouter };
