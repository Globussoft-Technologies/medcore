import { Router, Request, Response, NextFunction } from "express";
import { prisma } from "@medcore/db";
import { Role, controlledSubstanceSchema } from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { auditLog } from "../middleware/audit";

const router = Router();
router.use(authenticate);
// RBAC (issue #98): the entire Controlled Substance Register (Schedule H/H1/X)
// is regulated — gate every endpoint on it to ADMIN + PHARMACIST + DOCTOR.
// RECEPTION must NOT be able to read or write entries. Per-route authorize()
// is still applied below for any tighter (e.g. audit-report = ADMIN+DOCTOR)
// restrictions.
router.use(authorize(Role.ADMIN, Role.PHARMACIST, Role.DOCTOR));

// ───────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────

async function generateEntryNumber(tx?: typeof prisma): Promise<string> {
  const client = tx ?? prisma;
  const last = await client.controlledSubstanceEntry.findFirst({
    orderBy: { createdAt: "desc" },
    select: { entryNumber: true },
  });
  let next = 1;
  if (last?.entryNumber) {
    const m = last.entryNumber.match(/CSR(\d+)/);
    if (m) next = parseInt(m[1]) + 1;
  }
  return "CSR" + String(next).padStart(6, "0");
}

/**
 * Compute running balance for a medicine.
 * Balance strategy:
 *  - start from total on-hand current inventory quantity
 *  - each entry records a DISPENSE (subtract quantity from running balance)
 *  - balance stored = balance AFTER this entry
 */
async function nextBalance(
  medicineId: string,
  quantity: number
): Promise<number> {
  // Find most recent entry for this medicine to derive the previous running balance
  const last = await prisma.controlledSubstanceEntry.findFirst({
    where: { medicineId },
    orderBy: { dispensedAt: "desc" },
    select: { balance: true },
  });
  if (last) {
    return Math.max(0, last.balance - quantity);
  }
  // No prior entry — base off current on-hand inventory
  const agg = await prisma.inventoryItem.aggregate({
    where: { medicineId, recalled: false },
    _sum: { quantity: true },
  });
  const onHand = agg._sum.quantity ?? 0;
  return Math.max(0, onHand - quantity);
}

// ───────────────────────────────────────────────────────
// POST /controlled-substances — record an entry
// ───────────────────────────────────────────────────────
router.post(
  "/",
  // RBAC (issue #98): Schedule H/H1/X drugs are regulated — RECEPTION must
  // not be able to record dispenses against the register. ADMIN +
  // PHARMACIST + DOCTOR only.
  authorize(Role.ADMIN, Role.PHARMACIST, Role.DOCTOR),
  validate(controlledSubstanceSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const {
        medicineId,
        quantity,
        patientId,
        prescriptionId,
        doctorId,
        notes,
        witnessSignature,
        witnessUserId,
      } = req.body as {
        medicineId: string;
        quantity: number;
        patientId?: string;
        prescriptionId?: string;
        doctorId?: string;
        notes?: string;
        witnessSignature?: string;
        witnessUserId?: string;
      };

      const medicine = await prisma.medicine.findUnique({
        where: { id: medicineId },
      });
      if (!medicine) {
        res
          .status(404)
          .json({ success: false, data: null, error: "Medicine not found" });
        return;
      }

      // ─── Witness co-signing rule (Drugs and Cosmetics Rules 1945 §65) ───
      // Schedule-H / H1 / X dispenses MUST capture a witness's printed name
      // + role. The Zod schema already trims + min(3) when present; here we
      // enforce that it's actually present for regulated classes. For
      // non-controlled meds (no scheduleClass set) the field is optional —
      // a non-narcotic dispense via this route is unusual but tolerated for
      // backwards compatibility with the pre-2026-05-03 register.
      const trimmedWitness =
        typeof witnessSignature === "string" ? witnessSignature.trim() : "";
      const requiresWitness =
        medicine.scheduleClass === "H" ||
        medicine.scheduleClass === "H1" ||
        medicine.scheduleClass === "X";
      if (requiresWitness && trimmedWitness.length < 3) {
        res.status(422).json({
          success: false,
          data: null,
          error:
            "witnessSignature is required for Schedule-" +
            (medicine.scheduleClass ?? "H") +
            " dispense (printed name + role of the witnessing pharmacist or staff)",
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
          res
            .status(404)
            .json({ success: false, data: null, error: "Witness user not found" });
          return;
        }
      }

      const entryNumber = await generateEntryNumber();
      const balance = await nextBalance(medicineId, quantity);

      const entry = await prisma.controlledSubstanceEntry.create({
        data: {
          entryNumber,
          medicineId,
          quantity,
          patientId,
          prescriptionId,
          doctorId,
          dispensedBy: req.user!.userId,
          balance,
          notes,
          witnessSignature: trimmedWitness.length > 0 ? trimmedWitness : null,
          witnessUserId: witnessUserId ?? null,
        },
        include: {
          medicine: true,
          patient: { include: { user: { select: { name: true } } } },
          doctor: { include: { user: { select: { name: true } } } },
          user: { select: { id: true, name: true, role: true } },
          witness: { select: { id: true, name: true, role: true } },
        },
      });

      auditLog(req, "CONTROLLED_ENTRY_CREATE", "controlled_substance_entry", entry.id, {
        entryNumber,
        medicineId,
        quantity,
        scheduleClass: medicine.scheduleClass ?? null,
        witnessSignature: trimmedWitness.length > 0 ? trimmedWitness : null,
        witnessUserId: witnessUserId ?? null,
      }).catch(console.error);

      res.status(201).json({ success: true, data: entry, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// ───────────────────────────────────────────────────────
// GET /controlled-substances — list with filters
// ───────────────────────────────────────────────────────
router.get("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const {
      medicineId,
      patientId,
      from,
      to,
      page = "1",
      limit = "50",
    } = req.query as Record<string, string | undefined>;

    const where: Record<string, unknown> = {};
    if (medicineId) where.medicineId = medicineId;
    if (patientId) where.patientId = patientId;
    if (from || to) {
      const d: Record<string, Date> = {};
      if (from) d.gte = new Date(from);
      if (to) d.lte = new Date(to);
      where.dispensedAt = d;
    }

    const skip = (parseInt(page || "1") - 1) * parseInt(limit || "50");
    const take = Math.min(parseInt(limit || "50"), 200);

    const [entries, total] = await Promise.all([
      prisma.controlledSubstanceEntry.findMany({
        where,
        include: {
          medicine: {
            select: { id: true, name: true, scheduleClass: true, strength: true, form: true },
          },
          patient: {
            select: { id: true, mrNumber: true, user: { select: { name: true } } },
          },
          doctor: {
            select: { id: true, user: { select: { name: true } } },
          },
          user: { select: { id: true, name: true, role: true } },
          witness: { select: { id: true, name: true, role: true } },
        },
        orderBy: { dispensedAt: "desc" },
        skip,
        take,
      }),
      prisma.controlledSubstanceEntry.count({ where }),
    ]);

    res.json({
      success: true,
      data: entries,
      error: null,
      meta: { page: parseInt(page || "1"), limit: take, total },
    });
  } catch (err) {
    next(err);
  }
});

// ───────────────────────────────────────────────────────
// GET /controlled-substances/register/:medicineId
// Full chronological register for a specific medicine
// ───────────────────────────────────────────────────────
router.get(
  "/register/:medicineId",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const medicine = await prisma.medicine.findUnique({
        where: { id: req.params.medicineId },
      });
      if (!medicine) {
        res
          .status(404)
          .json({ success: false, data: null, error: "Medicine not found" });
        return;
      }

      const entries = await prisma.controlledSubstanceEntry.findMany({
        where: { medicineId: req.params.medicineId },
        include: {
          patient: {
            select: { id: true, mrNumber: true, user: { select: { name: true } } },
          },
          doctor: { select: { id: true, user: { select: { name: true } } } },
          user: { select: { id: true, name: true, role: true } },
          witness: { select: { id: true, name: true, role: true } },
        },
        orderBy: { dispensedAt: "asc" },
      });

      const onHand = await prisma.inventoryItem.aggregate({
        where: { medicineId: req.params.medicineId, recalled: false },
        _sum: { quantity: true },
      });

      res.json({
        success: true,
        data: {
          medicine,
          currentOnHand: onHand._sum.quantity ?? 0,
          entries,
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ───────────────────────────────────────────────────────
// GET /controlled-substances/audit-report
// Total dispensed per medicine + discrepancy check
// ───────────────────────────────────────────────────────
router.get(
  "/audit-report",
  authorize(Role.ADMIN, Role.DOCTOR),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { from, to } = req.query as Record<string, string | undefined>;
      const where: Record<string, unknown> = {};
      if (from || to) {
        const d: Record<string, Date> = {};
        if (from) d.gte = new Date(from);
        if (to) d.lte = new Date(to);
        where.dispensedAt = d;
      }

      const grouped = await prisma.controlledSubstanceEntry.groupBy({
        by: ["medicineId"],
        _sum: { quantity: true },
        _count: { id: true },
        where,
      });

      const medIds = grouped.map((g) => g.medicineId);
      const medicines = await prisma.medicine.findMany({
        where: { id: { in: medIds } },
        include: {
          inventoryItems: {
            where: { recalled: false },
            select: { quantity: true },
          },
        },
      });
      const medMap = new Map(medicines.map((m) => [m.id, m]));

      // Discrepancy: last register balance vs current on-hand stock
      const rows = await Promise.all(
        grouped.map(async (g) => {
          const med = medMap.get(g.medicineId);
          const onHand = (med?.inventoryItems ?? []).reduce(
            (s, i) => s + i.quantity,
            0
          );
          const last = await prisma.controlledSubstanceEntry.findFirst({
            where: { medicineId: g.medicineId },
            orderBy: { dispensedAt: "desc" },
            select: { balance: true },
          });
          const registerBalance = last?.balance ?? null;
          const discrepancy =
            registerBalance !== null ? onHand - registerBalance : null;
          return {
            medicineId: g.medicineId,
            medicineName: med?.name,
            scheduleClass: med?.scheduleClass,
            totalDispensed: g._sum.quantity ?? 0,
            entryCount: g._count.id,
            currentOnHand: onHand,
            registerBalance,
            discrepancy,
          };
        })
      );

      const flagged = rows.filter(
        (r) => r.discrepancy !== null && Math.abs(r.discrepancy) > 0
      );

      res.json({
        success: true,
        data: {
          windowFrom: from ?? null,
          windowTo: to ?? null,
          rows,
          discrepancies: flagged,
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

export { router as controlledSubstancesRouter };
