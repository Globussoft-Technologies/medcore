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
  INVOICE_NUMBER_PREFIX,
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

// Pearl §4.3 (gap row 104) — Kanban transition body. The four Kanban
// states are the only legal targets here; REJECTED still goes through
// the dedicated /prescriptions/:id/reject endpoint (which carries the
// mandatory rejection reason) and CANCELLED is a doctor-side action on
// the prescriptions router. DISPENSED can ALSO be set here as a fast-
// path, but the canonical full-dispense path is POST /pharmacy/dispense
// which decrements stock + creates controlled-substance entries —
// flipping to DISPENSED via this endpoint is allowed for tenants that
// dispense manually and want to mark a script done.
const kanbanTransitionBodySchema = z.object({
  status: z.enum(["PENDING", "DISPENSING", "READY", "DISPENSED"]),
});

// Legal forward transitions. Keep this in lockstep with the enum value
// order in packages/db/prisma/schema.prisma:PrescriptionStatus and with
// the column order in apps/web/src/app/dashboard/pharmacy-kanban.
//   PENDING → DISPENSING → READY → DISPENSED   (forward path)
//   READY → DISPENSING                          (step-back; pharmacist
//                                                needs to re-mix /
//                                                substitute an item)
// Terminal sinks (REJECTED / CANCELLED) are NOT reachable via this
// endpoint; they have their own dedicated handlers. Any other jump
// (e.g. PENDING → DISPENSED, DISPENSED → DISPENSING, READY → PENDING)
// is rejected with 409 so the UI can refresh + decide.
const KANBAN_TRANSITIONS: Record<string, ReadonlyArray<string>> = {
  PENDING: ["DISPENSING"],
  DISPENSING: ["READY", "DISPENSED"],
  READY: ["DISPENSED", "DISPENSING"],
  DISPENSED: [],
  REJECTED: [],
  CANCELLED: [],
};

const router = Router();
router.use(authenticate);

// Draw down inventory for every line of a prescription when it is dispensed
// via the Kanban board (Move → Dispensed). Mirrors the FEFO (earliest-expiry-
// first) decrement + DISPENSED stock-movement that POST /pharmacy/dispense
// performs, so dispensing from the board actually reduces on-hand quantity.
//
// Idempotent: if this prescription already has DISPENSED movements (e.g. it
// was dispensed via the full POST /pharmacy/dispense path), we skip so stock
// is never double-decremented. Missing-medicine / insufficient-stock lines are
// reported as warnings rather than failing the move.
async function autoDecrementStockForPrescription(
  prescriptionId: string,
  userId: string,
): Promise<string[]> {
  const warnings: string[] = [];

  const already = await prisma.stockMovement.findFirst({
    where: { type: "DISPENSED", referenceId: prescriptionId },
    select: { id: true },
  });
  if (already) return warnings;

  const prescription = await prisma.prescription.findUnique({
    where: { id: prescriptionId },
    include: { items: true },
  });
  if (!prescription) return warnings;

  await prisma.$transaction(async (tx) => {
    for (const item of prescription.items) {
      // Quantity heuristic matches /pharmacy/dispense: pull the first integer
      // out of `duration`, default to 1 unit.
      const qtyMatch = item.duration?.match(/(\d+)/);
      const qty = qtyMatch ? parseInt(qtyMatch[1]) : 1;

      const medicine = await tx.medicine.findFirst({
        where: {
          OR: [
            { name: { equals: item.medicineName, mode: "insensitive" } },
            { genericName: { equals: item.medicineName, mode: "insensitive" } },
            { name: { contains: item.medicineName, mode: "insensitive" } },
          ],
        },
      });
      if (!medicine) {
        warnings.push(`Medicine not found: ${item.medicineName}`);
        continue;
      }

      const inv = await tx.inventoryItem.findFirst({
        where: {
          medicineId: medicine.id,
          quantity: { gte: qty },
          expiryDate: { gt: new Date() },
        },
        orderBy: { expiryDate: "asc" },
      });
      if (!inv) {
        warnings.push(`Insufficient stock for ${item.medicineName} (need ${qty})`);
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
          performedBy: userId,
          reason: `Dispensed via Kanban for prescription ${prescriptionId}`,
        },
      });
    }
  });

  return warnings;
}

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
      const {
        prescriptionId,
        witnessSignature,
        witnessUserId,
        allowPartial,
        medicineIds,
        itemIds,
      } = req.body as {
        prescriptionId: string;
        witnessSignature?: string;
        witnessUserId?: string;
        allowPartial?: boolean;
        medicineIds?: string[];
        itemIds?: string[];
      };
      // When a per-medicine subset is requested, only those medicines dispense.
      const medicineIdFilter =
        Array.isArray(medicineIds) && medicineIds.length > 0
          ? new Set(medicineIds)
          : null;
      // Per-LINE-ITEM subset (preferred by the per-medicine Kanban): dispense
      // only these PrescriptionItem ids. Targets a single prescribed line, so
      // duplicate medicines (same medicineId, different qty) stay independent.
      const itemIdFilter =
        Array.isArray(itemIds) && itemIds.length > 0 ? new Set(itemIds) : null;

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

      // ─── §65 witness pre-flight (Drugs and Cosmetics Rules 1945) ─────────
      // The full-Rx dispense path auto-creates ControlledSubstanceEntry rows
      // for any line item whose medicine has requiresRegister=true. Before
      // this gate, that auto-creation bypassed the witnessSignature check
      // applied on the standalone POST /controlled-substances endpoint —
      // Schedule-H/H1/X meds could be dispensed without a co-signer. Resolve
      // the line item → medicine mapping up-front (case-insensitive name or
      // generic match, mirroring the per-item lookup below) and refuse the
      // whole dispense if any of those medicines requires the register and
      // the caller didn't include a non-blank witnessSignature.
      const trimmedWitness =
        typeof witnessSignature === "string" ? witnessSignature.trim() : "";
      // Mirror the per-item resolver downstream: exact name (ci) → exact
      // genericName (ci) → name contains (ci). We run this once per prescription
      // item against medicines flagged requiresRegister=true so we only short-
      // circuit when at least one line definitely maps to a controlled drug.
      const scheduleHItems: Array<{
        medicineName: string;
        medicineId: string;
        scheduleClass: string | null;
      }> = [];
      for (const it of prescription.items) {
        const med = await prisma.medicine.findFirst({
          where: {
            requiresRegister: true,
            OR: [
              { name: { equals: it.medicineName, mode: "insensitive" } },
              { genericName: { equals: it.medicineName, mode: "insensitive" } },
              { name: { contains: it.medicineName, mode: "insensitive" } },
            ],
          },
          select: { id: true, scheduleClass: true },
        });
        if (med) {
          scheduleHItems.push({
            medicineName: it.medicineName,
            medicineId: med.id,
            scheduleClass: med.scheduleClass ?? null,
          });
        }
      }

      if (scheduleHItems.length > 0 && trimmedWitness.length < 3) {
        auditLog(
          req,
          "PRESCRIPTION_DISPENSE_BLOCKED_NO_WITNESS",
          "prescription",
          prescriptionId,
          {
            scheduleHItems,
            reason: "Missing witnessSignature for Schedule-H/H1/X dispense",
          }
        ).catch(console.error);
        res.status(422).json({
          success: false,
          data: null,
          error:
            "Schedule-H/H1/X medications require a witnessSignature on dispense",
          scheduleHItems,
        });
        return;
      }

      // FK-validate witnessUserId when provided so we don't surface a raw
      // Prisma P2003 to the caller.
      if (witnessUserId) {
        const witness = await prisma.user.findUnique({
          where: { id: witnessUserId },
          select: { id: true },
        });
        if (!witness) {
          res.status(400).json({
            success: false,
            data: null,
            error: "Witness user not found",
          });
          return;
        }
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

      // Idempotency: a partial dispense (e.g. one line out of stock) leaves the
      // prescription un-flipped, so a retry would deduct stock + re-bill the
      // lines that already went out. Skip any medicine that already has a
      // DISPENSED stock movement against THIS prescription so retries only
      // pick up the newly-available lines.
      const priorMovements = await prisma.stockMovement.findMany({
        where: { type: "DISPENSED", referenceId: prescription.id },
        select: { inventoryItem: { select: { medicineId: true } } },
      });
      const alreadyDispensedMedicineIds = new Set(
        priorMovements
          .map((m) => m.inventoryItem?.medicineId)
          .filter((id): id is string => Boolean(id)),
      );

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

          if (itemIdFilter) {
            // Per-line-item path: dispense exactly the requested line(s).
            // Skip lines not requested and lines already dispensed (idempotent
            // — relies on the per-item kanbanStatus, not the medicine, so a
            // duplicate medicine's other line is unaffected).
            if (!itemIdFilter.has(item.id)) continue;
            if (item.kanbanStatus === "DISPENSED") continue;
          } else {
            // Already handed out on an earlier (partial) dispense — don't
            // deduct or re-bill it again.
            if (alreadyDispensedMedicineIds.has(medicine.id)) continue;
            // Per-medicine dispense: skip anything not in the requested subset.
            if (medicineIdFilter && !medicineIdFilter.has(medicine.id)) continue;
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

          // Mark this line's Kanban card as Dispensed so the per-medicine
          // board reflects it immediately.
          await tx.prescriptionItem.update({
            where: { id: item.id },
            data: { kanbanStatus: "DISPENSED" },
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
              witnessSignature:
                trimmedWitness.length > 0 ? trimmedWitness : null,
              witnessUserId: witnessUserId ?? null,
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

      // Pharmacy billing is NO LONGER auto-attached to the appointment invoice
      // at dispense time. Per the pharmacy workflow, the dispensed medicines are
      // billed on a SEPARATE pharmacy-only invoice generated on demand from the
      // Kanban "Generate Bill" (POST /pharmacy/prescriptions/:id/invoice). That
      // keeps the consultation fee and the pharmacy charges on distinct bills.
      const autoBilled: {
        invoiceId: string | null;
        addedLines: number;
        addedAmount: number;
      } = { invoiceId: null, addedLines: 0, addedAmount: 0 };

      // Lifecycle (2026-05-03): flip Prescription.status to DISPENSED.
      // Normally requires a clean full-dispense (every line found stock). But
      // when the pharmacist passes allowPartial=true they've chosen to skip
      // the out-of-stock lines, so we complete as long as SOMETHING was given
      // (now or on an earlier partial dispense). Complements the legacy
      // `printed` boolean so dispense-log / pharmacy reports keep working.
      // Lines dispensed on an EARLIER run, by line item (kanbanStatus) so
      // duplicate medicines are counted independently. prescription.items was
      // loaded before this request's transaction, so it reflects prior runs
      // only — this run's freshly-dispensed lines come from `dispensed`.
      const priorDispensedItemCount = prescription.items.filter(
        (i) => i.kanbanStatus === "DISPENSED",
      ).length;
      const somethingDispensed =
        dispensed.length > 0 ||
        priorDispensedItemCount > 0 ||
        alreadyDispensedMedicineIds.size > 0;
      // Count this run's lines plus any dispensed on an earlier partial run so
      // a per-medicine dispense flips the Rx to DISPENSED once the LAST line is
      // handled (not only when one request dispenses everything at once). The
      // item path counts by line (handles duplicate medicines); the legacy
      // medicine path keeps its medicine-set count.
      const totalHandled = itemIdFilter
        ? dispensed.length + priorDispensedItemCount
        : dispensed.length + alreadyDispensedMedicineIds.size;
      const fullyDispensed =
        somethingDispensed &&
        warnings.length === 0 &&
        totalHandled >= prescription.items.length;
      const flipToDispensed =
        fullyDispensed || (allowPartial === true && somethingDispensed);
      if (flipToDispensed) {
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
        statusFlipped: flipToDispensed,
        allowPartial: allowPartial === true,
        // §65 audit trail: capture both signers when any line item required
        // the controlled-substance register, so the regulator can trace who
        // dispensed and who witnessed even if the CSR rows are mutated later.
        scheduleHItemCount: scheduleHItems.length,
        witnessSignature: trimmedWitness.length > 0 ? trimmedWitness : null,
        witnessUserId: witnessUserId ?? null,
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

// ───────────────────────────────────────────────────────
// PEARL §4.3 KANBAN — prescription dispensing board
// ───────────────────────────────────────────────────────

// GET /api/v1/pharmacy/kanban?todayOnly=true
// Lists active prescriptions grouped by Kanban column. Returns one
// payload with `columns: { PENDING, DISPENSING, READY, DISPENSED,
// REJECTED, CANCELLED }`. The UI lays out PENDING → DISPENSING →
// READY → DISPENSED as the 4 active columns; REJECTED + CANCELLED
// drop into a collapsible "Returned / Cancelled" footer so the
// pharmacist can still find a script they rejected.
router.get(
  "/kanban",
  authorize(Role.ADMIN, Role.PHARMACIST, Role.DOCTOR, Role.NURSE),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const todayOnly =
        typeof req.query.todayOnly === "string" &&
        req.query.todayOnly !== "false";

      const where: Record<string, unknown> = {};
      if (todayOnly) {
        const start = new Date();
        start.setHours(0, 0, 0, 0);
        where.createdAt = { gte: start };
      }
      // Terminal scripts (whole-Rx rejected/cancelled) drop out of the active
      // board; their lines still surface in the Returned/Cancelled footer.
      const rows = await prisma.prescription.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: 500,
        include: {
          patient: { include: { user: { select: { name: true } } } },
          doctor: { include: { user: { select: { name: true } } } },
          items: true,
        },
      });

      // ── Resolve each line item → medicine, then look up stock + already-
      // dispensed so the per-MEDICINE card knows whether it's movable. ──
      // 1) Resolve medicineId for items lacking the FK (legacy free-text) via
      //    a single case-insensitive name lookup.
      const namesNeedingMatch = Array.from(
        new Set(
          rows
            .flatMap((r) => r.items)
            .filter((it) => !it.medicineId)
            .map((it) => it.medicineName),
        ),
      );
      const matchedByName = namesNeedingMatch.length
        ? await prisma.medicine.findMany({
            where: {
              OR: namesNeedingMatch.flatMap((n) => [
                { name: { equals: n, mode: "insensitive" as const } },
                { genericName: { equals: n, mode: "insensitive" as const } },
              ]),
            },
            select: { id: true, name: true, genericName: true },
          })
        : [];
      const nameToMedId = new Map<string, string>();
      for (const m of matchedByName) {
        if (m.name) nameToMedId.set(m.name.toLowerCase(), m.id);
        if (m.genericName) nameToMedId.set(m.genericName.toLowerCase(), m.id);
      }
      const resolveMedId = (it: { medicineId: string | null; medicineName: string }) =>
        it.medicineId ?? nameToMedId.get(it.medicineName.toLowerCase()) ?? null;

      // 2) Stock on hand per medicine (non-expired, qty > 0).
      const allMedIds = Array.from(
        new Set(
          rows.flatMap((r) => r.items.map(resolveMedId)).filter((v): v is string => !!v),
        ),
      );
      const stock = allMedIds.length
        ? await prisma.inventoryItem.groupBy({
            by: ["medicineId"],
            where: {
              medicineId: { in: allMedIds },
              quantity: { gt: 0 },
              expiryDate: { gt: new Date() },
            },
            _sum: { quantity: true },
          })
        : [];
      const stockByMed = new Map<string, number>();
      for (const s of stock) {
        if (s.medicineId) stockByMed.set(s.medicineId, s._sum.quantity ?? 0);
      }

      const columns: Record<string, Array<unknown>> = {
        PENDING: [],
        DISPENSING: [],
        READY: [],
        DISPENSED: [],
        REJECTED: [],
        CANCELLED: [],
      };
      for (const row of rows) {
        const fullName = row.patient.user.name || "Patient";
        const parts = fullName.trim().split(/\s+/);
        const firstName = parts[0] || fullName;
        const lastInitial =
          parts.length > 1 ? `${parts[parts.length - 1][0]}.` : "";
        const patientLabel = lastInitial ? `${firstName} ${lastInitial}` : firstName;
        const doctorName = row.doctor.user.name || "Doctor";

        for (const item of row.items) {
          const medId = resolveMedId(item);
          const qtyMatch = item.instructions?.match(/Qty:\s*(\d+)/i);
          const requiredQty = qtyMatch ? parseInt(qtyMatch[1], 10) : 1;
          const availableQty = medId ? stockByMed.get(medId) ?? 0 : 0;
          // Dispensed state is tracked PER LINE ITEM via kanbanStatus — NOT by
          // medicine — so two lines of the same medicine stay independent (one
          // dispensed line doesn't drag its duplicate into the Dispensed lane).
          // Normalise to a known column key so NO line is ever silently dropped:
          // a null / legacy / unexpected kanbanStatus falls back to PENDING
          // (New) instead of vanishing from the board.
          const status =
            item.kanbanStatus && columns[item.kanbanStatus]
              ? item.kanbanStatus
              : "PENDING";
          const dispensed = status === "DISPENSED";

          const card = {
            id: item.id,
            prescriptionId: row.id,
            medicineId: medId,
            medicineName: item.medicineName,
            dosage: item.dosage,
            frequency: item.frequency,
            duration: item.duration,
            instructions: item.instructions,
            patientId: row.patientId,
            patientLabel,
            doctorName,
            requiredQty,
            availableQty,
            inStock: Boolean(medId) && availableQty >= requiredQty,
            dispensed,
            status,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
          };
          columns[status].push(card);
        }
      }

      res.json({
        success: true,
        data: { columns, todayOnly },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// Find-or-create the STANDALONE pharmacy-only invoice for a prescription.
// Pharmacy-only: appointmentId / admissionId stay null; the row is linked via
// the @unique prescriptionId so a prescription has at most one pharmacy bill.
async function ensurePharmacyInvoice(
  prescriptionId: string,
  patientId: string,
  branchId: string | null,
): Promise<{ id: string }> {
  // findFirst (not findUnique): prescriptionId is a plain indexed column, not a
  // DB UNIQUE — uniqueness is enforced here by checking for an existing row.
  const existing = await prisma.invoice.findFirst({
    where: { prescriptionId },
    select: { id: true },
  });
  if (existing) return existing;

  const dueDate = new Date();
  dueDate.setDate(dueDate.getDate() + 14);

  return prisma.$transaction(async (tx) => {
    const config = await tx.systemConfig.findUnique({
      where: { key: "next_invoice_number" },
    });
    const invSeq = config ? parseInt(config.value, 10) || 1 : 1;
    const invoiceNumber = `${INVOICE_NUMBER_PREFIX}${String(invSeq).padStart(6, "0")}`;
    const inv = await tx.invoice.create({
      data: {
        invoiceNumber,
        prescriptionId,
        patientId,
        branchId: branchId ?? undefined,
        subtotal: 0,
        taxableAmount: 0,
        totalAmount: 0,
        dueDate,
        paymentStatus: "PENDING",
        notes: "Pharmacy bill (dispensed medicines)",
      },
      select: { id: true },
    });
    if (config) {
      await tx.systemConfig.update({
        where: { key: "next_invoice_number" },
        data: { value: String(invSeq + 1) },
      });
    } else {
      await tx.systemConfig.create({
        data: { key: "next_invoice_number", value: String(invSeq + 1) },
      });
    }
    return inv;
  });
}

// GET /api/v1/pharmacy/prescriptions/:id/invoice
// Pure lookup (no side effects): returns the prescription's standalone pharmacy
// bill id and how many dispensed lines it currently carries. The Kanban uses
// this on load to decide the button: not billed → "Generate Bill"; billed and
// all dispensed lines on it → "Bill Generated" (disabled); billed but MORE
// medicines have since been dispensed → "Update Bill".
router.get(
  "/prescriptions/:id/invoice",
  authorize(Role.ADMIN, Role.PHARMACIST, Role.DOCTOR, Role.NURSE),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const inv = await prisma.invoice.findFirst({
        where: { prescriptionId: req.params.id },
        select: { id: true, _count: { select: { items: true } } },
      });
      res.json({
        success: true,
        data: {
          invoiceId: inv?.id ?? null,
          billedCount: inv?._count.items ?? 0,
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/v1/pharmacy/prescriptions/:id/invoice
// Generate (or UPDATE) the prescription's standalone PHARMACY-only bill: a
// dedicated invoice containing ONLY the dispensed medicines — never the
// consultation fee or any other section. Idempotent: it rebuilds the bill's
// lines to exactly match the current DISPENSED stock movements, so calling it
// again after another medicine is dispensed simply ADDS that line ("Update
// Bill"). Returns { invoiceId: null } when nothing has been dispensed yet.
router.post(
  "/prescriptions/:id/invoice",
  authorize(Role.ADMIN, Role.PHARMACIST),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const rx = await prisma.prescription.findUnique({
        where: { id: req.params.id },
        select: {
          patientId: true,
          appointment: { select: { branchId: true } },
          items: { select: { kanbanStatus: true } },
        },
      });
      if (!rx) {
        res
          .status(404)
          .json({ success: false, data: null, error: "Prescription not found" });
        return;
      }
      // Nothing dispensed → nothing to bill.
      const dispensedCount = rx.items.filter(
        (i) => i.kanbanStatus === "DISPENSED",
      ).length;
      if (dispensedCount === 0) {
        res.json({
          success: true,
          data: { invoiceId: null, billedCount: 0 },
          error: null,
          message: "No medicines dispensed yet — dispense before billing.",
        });
        return;
      }

      const invoice = await ensurePharmacyInvoice(
        req.params.id,
        rx.patientId,
        rx.appointment?.branchId ?? null,
      );

      // Rebuild the pharmacy bill's lines to EXACTLY match the DISPENSED stock
      // movements (qty + batch + sale price). The invoice is pharmacy-only, so
      // we clear all its lines and recreate — idempotent, and a newly-dispensed
      // medicine is picked up on the next call (Update Bill).
      const movements = await prisma.stockMovement.findMany({
        where: { type: "DISPENSED", referenceId: req.params.id },
        select: {
          quantity: true,
          inventoryItem: {
            select: {
              sellingPrice: true,
              batchNumber: true,
              medicine: { select: { name: true } },
            },
          },
        },
      });
      const desiredLines = movements
        .filter((m) => m.inventoryItem && Math.abs(m.quantity) > 0)
        .map((m) => {
          const inv = m.inventoryItem!;
          const qty = Math.abs(m.quantity);
          const unitPrice = Number(inv.sellingPrice);
          return {
            invoiceId: invoice.id,
            description: `Pharmacy: ${inv.medicine?.name ?? "Medicine"} (Batch ${inv.batchNumber})`,
            category: "PHARMACY",
            quantity: qty,
            unitPrice,
            amount: unitPrice * qty,
          };
        });
      const newSum = desiredLines.reduce((s, l) => s + l.amount, 0);

      await prisma.$transaction([
        prisma.invoiceItem.deleteMany({ where: { invoiceId: invoice.id } }),
        ...(desiredLines.length > 0
          ? [prisma.invoiceItem.createMany({ data: desiredLines })]
          : []),
        prisma.invoice.update({
          where: { id: invoice.id },
          data: {
            subtotal: newSum,
            taxableAmount: newSum,
            totalAmount: newSum,
          },
        }),
      ]);

      res.json({
        success: true,
        data: { invoiceId: invoice.id, billedCount: desiredLines.length },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/pharmacy/prescriptions/:id/availability
// For the Kanban "view" modal: returns every prescribed line with the
// quantity required vs. the quantity currently in stock, and an
// `available` flag, so the UI can flag out-of-stock medicines in red.
// Required qty is parsed from the structured "Qty: N" in instructions
// (falls back to 1); available qty sums all non-expired inventory batches
// for the matched medicine (same name-match used by /dispense).
router.get(
  "/prescriptions/:id/availability",
  authorize(Role.ADMIN, Role.PHARMACIST, Role.DOCTOR, Role.NURSE),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const prescription = await prisma.prescription.findUnique({
        where: { id: req.params.id },
        include: {
          items: true,
          patient: { include: { user: { select: { name: true } } } },
          doctor: { include: { user: { select: { name: true } } } },
        },
      });
      if (!prescription) {
        res
          .status(404)
          .json({ success: false, data: null, error: "Prescription not found" });
        return;
      }

      // Which medicines have already been handed to the patient — i.e. a
      // DISPENSED stock movement was recorded against this prescription. Used
      // to flag those lines as "Dispensed" instead of a stock count.
      const dispensedMovements = await prisma.stockMovement.findMany({
        where: { type: "DISPENSED", referenceId: prescription.id },
        select: { inventoryItem: { select: { medicineId: true } } },
      });
      const dispensedMedicineIds = new Set(
        dispensedMovements
          .map((m) => m.inventoryItem?.medicineId)
          .filter((id): id is string => Boolean(id)),
      );

      const items = await Promise.all(
        prescription.items.map(async (item) => {
          // Required qty from the "Qty: N" segment of instructions; default 1.
          const qtyMatch = item.instructions?.match(/Qty:\s*(\d+)/i);
          const requiredQty = qtyMatch ? parseInt(qtyMatch[1], 10) : 1;

          const medicine = await prisma.medicine.findFirst({
            where: {
              OR: [
                { name: { equals: item.medicineName, mode: "insensitive" } },
                { genericName: { equals: item.medicineName, mode: "insensitive" } },
                { name: { contains: item.medicineName, mode: "insensitive" } },
              ],
            },
            select: { id: true },
          });

          let availableQty = 0;
          if (medicine) {
            const batches = await prisma.inventoryItem.findMany({
              where: {
                medicineId: medicine.id,
                quantity: { gt: 0 },
                expiryDate: { gt: new Date() },
              },
              select: { quantity: true },
            });
            availableQty = batches.reduce((sum, b) => sum + b.quantity, 0);
          }

          const dispensed = Boolean(
            medicine && dispensedMedicineIds.has(medicine.id),
          );

          return {
            medicineName: item.medicineName,
            medicineId: medicine?.id ?? null,
            dosage: item.dosage,
            frequency: item.frequency,
            duration: item.duration,
            requiredQty,
            availableQty,
            matched: Boolean(medicine),
            dispensed,
            available: Boolean(medicine) && availableQty >= requiredQty,
          };
        }),
      );

      res.json({
        success: true,
        data: {
          prescriptionId: prescription.id,
          patientName: prescription.patient.user.name || "Patient",
          doctorName: prescription.doctor.user.name || "Doctor",
          diagnosis: prescription.diagnosis,
          items,
          allAvailable: items.every((i) => i.available),
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// PATCH /api/v1/pharmacy/prescriptions/:id/status
// Kanban transition endpoint — moves a prescription forward through
// PENDING → DISPENSING → READY → DISPENSED, with READY → DISPENSING
// allowed as a step-back (pharmacist needs to re-mix). All other
// transitions are rejected with 409. The actual stock decrement +
// controlled-substance register writes still happen on POST
// /pharmacy/dispense; flipping to DISPENSED via this endpoint is the
// "I already dispensed this manually" override that some tenants use.
router.patch(
  "/prescriptions/:id/status",
  authorize(Role.ADMIN, Role.PHARMACIST),
  pharmacyIdParams,
  validate(kanbanTransitionBodySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { status: target } = req.body as { status: string };
      const existing = await prisma.prescription.findUnique({
        where: { id: req.params.id },
        select: { id: true, status: true, patientId: true },
      });
      if (!existing) {
        res.status(404).json({
          success: false,
          data: null,
          error: "Prescription not found",
        });
        return;
      }
      const allowed = KANBAN_TRANSITIONS[existing.status] ?? [];
      if (!allowed.includes(target)) {
        res.status(409).json({
          success: false,
          data: null,
          error: `Invalid transition ${existing.status} → ${target}`,
        });
        return;
      }
      const updated = await prisma.prescription.update({
        where: { id: existing.id },
        data: { status: target as any },
      });
      // Dispensing from the board must actually draw down stock. When the
      // script lands in DISPENSED (and wasn't already), decrement inventory
      // FEFO-style and record DISPENSED movements — idempotent so the full
      // POST /pharmacy/dispense path doesn't double-count.
      let dispenseWarnings: string[] = [];
      if (target === "DISPENSED" && existing.status !== "DISPENSED") {
        dispenseWarnings = await autoDecrementStockForPrescription(
          existing.id,
          req.user!.userId,
        );
      }
      // Use the AWAITED auditLog (not safeAudit) so callers + tests
      // can read AuditLog immediately after the 200 — every Kanban
      // move surfaces in the per-row history with the from/to pair
      // intact, no flake (CLAUDE.md gotcha #1).
      await auditLog(
        req,
        "PRESCRIPTION_KANBAN_TRANSITION",
        "prescription",
        existing.id,
        { from: existing.status, to: target, prescriptionId: existing.id }
      );
      res.json({
        success: true,
        data: updated,
        error: null,
        ...(dispenseWarnings.length ? { warnings: dispenseWarnings } : {}),
      });
    } catch (err) {
      next(err);
    }
  }
);

// PATCH /api/v1/pharmacy/prescription-items/:itemId/status
// Per-MEDICINE Kanban transition. Each line item moves independently through
// PENDING (New) → DISPENSING → READY (and READY → DISPENSING step-back). The
// final READY → DISPENSED step is NOT done here — that goes through POST
// /pharmacy/dispense (medicineIds) so stock/billing/controlled-register run.
// An OUT-OF-STOCK medicine cannot be advanced (forward moves are rejected).
router.patch(
  "/prescription-items/:itemId/status",
  authorize(Role.ADMIN, Role.PHARMACIST),
  validateUuidParams(["itemId"]),
  validate(kanbanTransitionBodySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { status: target } = req.body as { status: string };
      const item = await prisma.prescriptionItem.findUnique({
        where: { id: req.params.itemId },
        select: {
          id: true,
          kanbanStatus: true,
          medicineId: true,
          medicineName: true,
          instructions: true,
        },
      });
      if (!item) {
        res
          .status(404)
          .json({ success: false, data: null, error: "Prescription item not found" });
        return;
      }

      const allowed = KANBAN_TRANSITIONS[item.kanbanStatus] ?? [];
      if (!allowed.includes(target)) {
        res.status(409).json({
          success: false,
          data: null,
          error: `Invalid transition ${item.kanbanStatus} → ${target}`,
        });
        return;
      }

      // DISPENSED must go through the dispense flow (stock + billing + CSR).
      if (target === "DISPENSED") {
        res.status(409).json({
          success: false,
          data: null,
          error: "Dispense this medicine via POST /pharmacy/dispense (medicineIds)",
        });
        return;
      }

      // Out-of-stock medicines aren't movable forward. Resolve the medicine and
      // its on-hand stock; a forward move while short on stock is rejected.
      const order: Record<string, number> = {
        PENDING: 0,
        DISPENSING: 1,
        READY: 2,
        DISPENSED: 3,
      };
      const isForward = (order[target] ?? 0) > (order[item.kanbanStatus] ?? 0);
      if (isForward) {
        const medicine = item.medicineId
          ? { id: item.medicineId }
          : await prisma.medicine.findFirst({
              where: {
                OR: [
                  { name: { equals: item.medicineName, mode: "insensitive" } },
                  { genericName: { equals: item.medicineName, mode: "insensitive" } },
                  { name: { contains: item.medicineName, mode: "insensitive" } },
                ],
              },
              select: { id: true },
            });
        const qtyMatch = item.instructions?.match(/Qty:\s*(\d+)/i);
        const requiredQty = qtyMatch ? parseInt(qtyMatch[1], 10) : 1;
        let availableQty = 0;
        if (medicine) {
          const agg = await prisma.inventoryItem.aggregate({
            where: {
              medicineId: medicine.id,
              quantity: { gt: 0 },
              expiryDate: { gt: new Date() },
            },
            _sum: { quantity: true },
          });
          availableQty = agg._sum.quantity ?? 0;
        }
        if (!medicine || availableQty < requiredQty) {
          res.status(409).json({
            success: false,
            data: null,
            error: "Out of stock — this medicine can't be moved until restocked",
          });
          return;
        }
      }

      const updated = await prisma.prescriptionItem.update({
        where: { id: item.id },
        data: { kanbanStatus: target as any },
        select: { id: true, kanbanStatus: true, prescriptionId: true },
      });
      await auditLog(
        req,
        "PRESCRIPTION_ITEM_KANBAN_TRANSITION",
        "prescription_item",
        item.id,
        { from: item.kanbanStatus, to: target, prescriptionItemId: item.id },
      );
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
  // #511 audit: STAFF-ONLY — exposes batch/inventory PII not relevant to PATIENT.
  authorize(Role.ADMIN, Role.PHARMACIST, Role.DOCTOR, Role.NURSE),
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
  // #511 audit: STAFF-ONLY — substitute lookup exposes inventory levels +
  // pricing per batch; not a patient-facing surface.
  authorize(Role.ADMIN, Role.PHARMACIST, Role.DOCTOR, Role.NURSE),
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
  // #511 audit: STAFF-ONLY — exposes refund/return history across all
  // patients. Pharmacy-roles only.
  authorize(Role.ADMIN, Role.PHARMACIST, Role.NURSE),
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
  // #511 audit: STAFF-ONLY — exposes stock transfer history across
  // locations; not a patient-facing surface.
  authorize(Role.ADMIN, Role.PHARMACIST, Role.NURSE),
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
