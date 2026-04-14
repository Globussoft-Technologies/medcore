import { Router, Request, Response, NextFunction } from "express";
import { prisma } from "@medcore/db";
import {
  Role,
  createMedicineSchema,
  updateMedicineSchema,
  createDrugInteractionSchema,
  checkInteractionsSchema,
  pediatricDoseCalcSchema,
  contraindicationCheckSchema,
} from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { auditLog } from "../middleware/audit";

const router = Router();
router.use(authenticate);

// GET /api/v1/medicines — list medicines with search/category filters
router.get("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { search, category, page = "1", limit = "20" } = req.query;
    const skip = (parseInt(page as string) - 1) * parseInt(limit as string);
    const take = Math.min(parseInt(limit as string), 100);

    const where: Record<string, unknown> = {};
    if (category) where.category = category;
    if (search) {
      where.OR = [
        { name: { contains: search as string, mode: "insensitive" } },
        { genericName: { contains: search as string, mode: "insensitive" } },
        { brand: { contains: search as string, mode: "insensitive" } },
      ];
    }

    const [medicines, total] = await Promise.all([
      prisma.medicine.findMany({
        where,
        skip,
        take,
        orderBy: { name: "asc" },
      }),
      prisma.medicine.count({ where }),
    ]);

    res.json({
      success: true,
      data: medicines,
      error: null,
      meta: { page: parseInt(page as string), limit: take, total },
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/medicines/:id — detail with interactions
router.get(
  "/:id",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const medicine = await prisma.medicine.findUnique({
        where: { id: req.params.id },
        include: {
          interactionsA: { include: { drugB: true } },
          interactionsB: { include: { drugA: true } },
          inventoryItems: {
            where: { quantity: { gt: 0 } },
            orderBy: { expiryDate: "asc" },
          },
        },
      });

      if (!medicine) {
        res.status(404).json({
          success: false,
          data: null,
          error: "Medicine not found",
        });
        return;
      }

      const interactions = [
        ...medicine.interactionsA.map((i) => ({
          id: i.id,
          severity: i.severity,
          description: i.description,
          otherDrug: i.drugB,
        })),
        ...medicine.interactionsB.map((i) => ({
          id: i.id,
          severity: i.severity,
          description: i.description,
          otherDrug: i.drugA,
        })),
      ];

      const { interactionsA, interactionsB, ...rest } = medicine;

      res.json({
        success: true,
        data: { ...rest, interactions },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/v1/medicines — create medicine
router.post(
  "/",
  authorize(Role.ADMIN, Role.DOCTOR),
  validate(createMedicineSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const medicine = await prisma.medicine.create({ data: req.body });
      auditLog(req, "CREATE_MEDICINE", "medicine", medicine.id, {
        name: medicine.name,
      }).catch(console.error);
      res.status(201).json({ success: true, data: medicine, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// PATCH /api/v1/medicines/:id — update medicine
router.patch(
  "/:id",
  authorize(Role.ADMIN, Role.DOCTOR),
  validate(updateMedicineSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const medicine = await prisma.medicine.update({
        where: { id: req.params.id },
        data: req.body,
      });
      auditLog(req, "UPDATE_MEDICINE", "medicine", medicine.id, req.body).catch(
        console.error
      );
      res.json({ success: true, data: medicine, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/v1/medicines/interactions — add drug interaction
router.post(
  "/interactions",
  authorize(Role.ADMIN, Role.DOCTOR),
  validate(createDrugInteractionSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { drugAId, drugBId, severity, description } = req.body;

      if (drugAId === drugBId) {
        res.status(400).json({
          success: false,
          data: null,
          error: "Cannot create self-interaction",
        });
        return;
      }

      const interaction = await prisma.drugInteraction.create({
        data: { drugAId, drugBId, severity, description },
        include: { drugA: true, drugB: true },
      });

      auditLog(
        req,
        "CREATE_DRUG_INTERACTION",
        "drug_interaction",
        interaction.id,
        { drugAId, drugBId, severity }
      ).catch(console.error);

      res.status(201).json({ success: true, data: interaction, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/v1/medicines/check-interactions — check interactions among a list
router.post(
  "/check-interactions",
  validate(checkInteractionsSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { medicineIds } = req.body as { medicineIds: string[] };

      if (medicineIds.length < 2) {
        res.json({ success: true, data: [], error: null });
        return;
      }

      const interactions = await prisma.drugInteraction.findMany({
        where: {
          AND: [
            { drugAId: { in: medicineIds } },
            { drugBId: { in: medicineIds } },
          ],
        },
        include: { drugA: true, drugB: true },
      });

      res.json({ success: true, data: interactions, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// ───────────────────────────────────────────────────────
// AUTOCOMPLETE (name / generic / brand)
// ───────────────────────────────────────────────────────

router.get(
  "/search/autocomplete",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const q = (req.query.q as string) || "";
      if (q.length < 2) {
        res.json({ success: true, data: [], error: null });
        return;
      }
      const results = await prisma.medicine.findMany({
        where: {
          OR: [
            { name: { contains: q, mode: "insensitive" } },
            { genericName: { contains: q, mode: "insensitive" } },
            { brand: { contains: q, mode: "insensitive" } },
          ],
        },
        select: {
          id: true,
          name: true,
          genericName: true,
          brand: true,
          strength: true,
          form: true,
          category: true,
          pregnancyCategory: true,
          isNarcotic: true,
        },
        take: 15,
        orderBy: { name: "asc" },
      });
      res.json({ success: true, data: results, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// ───────────────────────────────────────────────────────
// PEDIATRIC DOSE CALCULATOR
// ───────────────────────────────────────────────────────

router.post(
  "/pediatric-dose",
  validate(pediatricDoseCalcSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { medicineId, weightKg, frequencyPerDay } = req.body as {
        medicineId: string;
        weightKg: number;
        frequencyPerDay?: number;
      };
      const med = await prisma.medicine.findUnique({ where: { id: medicineId } });
      if (!med) {
        res.status(404).json({ success: false, data: null, error: "Medicine not found" });
        return;
      }
      if (!med.pediatricDoseMgPerKg) {
        res.json({
          success: true,
          data: {
            medicine: med,
            calculated: null,
            reason: "No pediatric dose (mg/kg) configured for this medicine",
          },
          error: null,
        });
        return;
      }
      const dosePerAdminMg = Math.round(med.pediatricDoseMgPerKg * weightKg * 10) / 10;
      const freq = frequencyPerDay ?? 3;
      const dailyMg = Math.round(dosePerAdminMg * freq * 10) / 10;
      const exceedsMax = med.maxDailyDoseMg ? dailyMg > med.maxDailyDoseMg : false;

      res.json({
        success: true,
        data: {
          medicine: {
            id: med.id,
            name: med.name,
            strength: med.strength,
            pediatricDoseMgPerKg: med.pediatricDoseMgPerKg,
            maxDailyDoseMg: med.maxDailyDoseMg,
          },
          weightKg,
          frequencyPerDay: freq,
          dosePerAdministrationMg: dosePerAdminMg,
          totalDailyDoseMg: dailyMg,
          exceedsMaxDaily: exceedsMax,
          warning: exceedsMax
            ? `Daily dose ${dailyMg}mg exceeds max ${med.maxDailyDoseMg}mg. Cap required.`
            : null,
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ───────────────────────────────────────────────────────
// CONTRAINDICATION CHECKER
// ───────────────────────────────────────────────────────

router.post(
  "/check-contraindications",
  validate(contraindicationCheckSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { medicineIds, patientConditions = [], patientAllergies = [] } = req.body as {
        medicineIds: string[];
        patientConditions?: string[];
        patientAllergies?: string[];
      };
      const medicines = await prisma.medicine.findMany({
        where: { id: { in: medicineIds } },
      });

      const alerts: Array<{
        medicineId: string;
        medicineName: string;
        type: "CONTRAINDICATION" | "ALLERGY" | "PREGNANCY";
        matched: string;
        detail?: string;
      }> = [];

      for (const m of medicines) {
        const ci = (m.contraindications || "").toLowerCase();
        for (const c of patientConditions) {
          if (c && ci.includes(c.toLowerCase())) {
            alerts.push({
              medicineId: m.id,
              medicineName: m.name,
              type: "CONTRAINDICATION",
              matched: c,
              detail: m.contraindications ?? undefined,
            });
          }
        }
        for (const a of patientAllergies) {
          const hit =
            (m.name || "").toLowerCase().includes(a.toLowerCase()) ||
            (m.genericName || "").toLowerCase().includes(a.toLowerCase());
          if (hit) {
            alerts.push({
              medicineId: m.id,
              medicineName: m.name,
              type: "ALLERGY",
              matched: a,
            });
          }
        }
        if (
          patientConditions.some((c) => /pregnan/i.test(c)) &&
          ["D", "X"].includes(m.pregnancyCategory || "")
        ) {
          alerts.push({
            medicineId: m.id,
            medicineName: m.name,
            type: "PREGNANCY",
            matched: "Pregnancy",
            detail: `Pregnancy category ${m.pregnancyCategory}`,
          });
        }
      }

      res.json({ success: true, data: alerts, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// ───────────────────────────────────────────────────────
// PREGNANCY CATEGORY LOOKUP
// ───────────────────────────────────────────────────────

router.get(
  "/by-category/pregnancy/:cat",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const cat = req.params.cat.toUpperCase();
      const meds = await prisma.medicine.findMany({
        where: { pregnancyCategory: cat },
        select: { id: true, name: true, genericName: true, pregnancyCategory: true },
        orderBy: { name: "asc" },
      });
      res.json({ success: true, data: meds, error: null });
    } catch (err) {
      next(err);
    }
  }
);

export { router as medicineRouter };
