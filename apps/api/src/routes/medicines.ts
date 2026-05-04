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
  renalDoseCalcSchema,
} from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { auditLog } from "../middleware/audit";
import {
  serializeMedicine,
  serializeMedicines,
} from "../services/medicines/serialize";

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
      data: serializeMedicines(medicines),
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
        data: { ...serializeMedicine(rest), interactions },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// Map UI-facing field names (rxRequired, manufacturer) to Prisma column names.
// The schema.prisma field names (prescriptionRequired, brand) are the source
// of truth; the UI aliases are defined in services/medicines/serialize.ts.
function mapMedicineInputToPrisma(
  body: Record<string, unknown>
): Record<string, unknown> {
  const {
    rxRequired,
    manufacturer,
    prescriptionRequired,
    brand,
    ...rest
  } = body;
  const out: Record<string, unknown> = { ...rest };
  if (rxRequired !== undefined) out.prescriptionRequired = rxRequired;
  else if (prescriptionRequired !== undefined)
    out.prescriptionRequired = prescriptionRequired;
  if (manufacturer !== undefined) out.brand = manufacturer;
  else if (brand !== undefined) out.brand = brand;
  return out;
}

// RBAC matrix for the medicine catalog (intentional asymmetry — do
// NOT collapse to a uniform allowlist):
//   POST   /api/v1/medicines           ADMIN, DOCTOR    (create — DOCTORs
//                                                       add formulary entries
//                                                       on prescribing)
//   PATCH  /api/v1/medicines/:id       ADMIN, DOCTOR    (correct dosage,
//                                                       interactions etc.)
//   DELETE /api/v1/medicines/:id       ADMIN            (remove from catalog
//                                                       — admin-only audit-
//                                                       sensitive operation)
// Client mirror: apps/web/src/app/dashboard/medicines/page.tsx
//   canEdit   = isAdmin || isDoctor (matches POST + PATCH)
//   canDelete = isAdmin             (matches DELETE)
// Issue #459 audit erroneously flagged canEdit as drift > server in
// 2026-05-05 — false positive; verified via d5a4fef. The asymmetry is
// deliberate so future RBAC audits should pin to the per-handler list,
// not assume uniform per-resource roles.

// POST /api/v1/medicines — create medicine
router.post(
  "/",
  authorize(Role.ADMIN, Role.DOCTOR),
  validate(createMedicineSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = mapMedicineInputToPrisma(req.body);
      const medicine = await prisma.medicine.create({ data: data as any });
      auditLog(req, "MEDICINE_CREATE", "medicine", medicine.id, {
        name: medicine.name,
      }).catch(console.error);
      res
        .status(201)
        .json({ success: true, data: serializeMedicine(medicine), error: null });
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
      const data = mapMedicineInputToPrisma(req.body);
      const medicine = await prisma.medicine.update({
        where: { id: req.params.id },
        data: data as any,
      });
      auditLog(req, "MEDICINE_UPDATE", "medicine", medicine.id, req.body).catch(
        console.error
      );
      res.json({ success: true, data: serializeMedicine(medicine), error: null });
    } catch (err) {
      next(err);
    }
  }
);

// DELETE /api/v1/medicines/:id — delete medicine (Issue #85).
// Only ADMIN may delete from the catalog; FK-protected so any prescription
// rows still pointing at this row will surface as a 409 from Prisma which we
// translate to a clean message.
router.delete(
  "/:id",
  authorize(Role.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const medicine = await prisma.medicine.findUnique({
        where: { id: req.params.id },
        select: { id: true, name: true },
      });
      if (!medicine) {
        res
          .status(404)
          .json({ success: false, data: null, error: "Medicine not found" });
        return;
      }

      try {
        await prisma.medicine.delete({ where: { id: req.params.id } });
      } catch (err: unknown) {
        const code = (err as { code?: string }).code;
        if (code === "P2003") {
          // FK violation — medicine is in use somewhere (prescriptions,
          // pharmacy stock, …). Tell the caller in plain English.
          res.status(409).json({
            success: false,
            data: null,
            error:
              "Cannot delete: medicine is referenced by prescriptions or stock records.",
          });
          return;
        }
        throw err;
      }

      auditLog(req, "MEDICINE_DELETE", "medicine", medicine.id, {
        name: medicine.name,
      }).catch(console.error);

      res.json({ success: true, data: { id: medicine.id }, error: null });
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
        "DRUG_INTERACTION_CREATE",
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

// ───────────────────────────────────────────────────────
// GENERIC SUBSTITUTION SUGGESTIONS WITH PRICING
// GET /api/v1/medicines/:id/generics
// ───────────────────────────────────────────────────────
router.get(
  "/:id/generics",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const base = await prisma.medicine.findUnique({
        where: { id: req.params.id },
        include: {
          inventoryItems: {
            where: { quantity: { gt: 0 }, recalled: false },
            orderBy: { expiryDate: "asc" },
          },
        },
      });
      if (!base) {
        res
          .status(404)
          .json({ success: false, data: null, error: "Medicine not found" });
        return;
      }

      // Current reference (brand) sellingPrice: best-available stock price
      const basePrice =
        base.inventoryItems.length > 0
          ? Math.min(...base.inventoryItems.map((i) => i.sellingPrice))
          : null;

      if (!base.genericName) {
        res.json({
          success: true,
          data: {
            basePrice,
            base: {
              id: base.id,
              name: base.name,
              brand: base.brand,
              genericName: base.genericName,
            },
            alternatives: [],
          },
          error: null,
        });
        return;
      }

      const alternatives = await prisma.medicine.findMany({
        where: {
          id: { not: base.id },
          genericName: { equals: base.genericName, mode: "insensitive" },
          ...(base.strength ? { strength: base.strength } : {}),
          ...(base.form ? { form: base.form } : {}),
        },
        include: {
          inventoryItems: {
            where: { quantity: { gt: 0 }, recalled: false },
            orderBy: { sellingPrice: "asc" },
          },
        },
      });

      const out = alternatives
        .map((m) => {
          const stock = m.inventoryItems.reduce((s, i) => s + i.quantity, 0);
          const price =
            m.inventoryItems.length > 0
              ? Math.min(...m.inventoryItems.map((i) => i.sellingPrice))
              : null;
          const savings =
            basePrice !== null && price !== null
              ? Math.round((basePrice - price) * 100) / 100
              : null;
          return {
            id: m.id,
            name: m.name,
            brand: m.brand,
            strength: m.strength,
            form: m.form,
            availableStock: stock,
            sellingPrice: price,
            savingsVsBrand: savings,
          };
        })
        .filter((x) => x.availableStock > 0)
        .sort((a, b) => {
          const ap = a.sellingPrice ?? Number.MAX_VALUE;
          const bp = b.sellingPrice ?? Number.MAX_VALUE;
          return ap - bp;
        });

      res.json({
        success: true,
        data: {
          base: {
            id: base.id,
            name: base.name,
            brand: base.brand,
            genericName: base.genericName,
            strength: base.strength,
            form: base.form,
          },
          basePrice,
          alternatives: out,
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ───────────────────────────────────────────────────────
// PATIENT LEAFLET
// GET /api/v1/medicines/:id/leaflet
// ───────────────────────────────────────────────────────
router.get(
  "/:id/leaflet",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const m = await prisma.medicine.findUnique({
        where: { id: req.params.id },
        select: {
          id: true,
          name: true,
          genericName: true,
          brand: true,
          strength: true,
          form: true,
          patientInstructions: true,
          sideEffects: true,
          contraindications: true,
          pregnancyCategory: true,
        },
      });
      if (!m) {
        res
          .status(404)
          .json({ success: false, data: null, error: "Medicine not found" });
        return;
      }
      res.json({ success: true, data: m, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// ───────────────────────────────────────────────────────
// RENAL DOSE CALCULATOR — Cockcroft-Gault
// POST /api/v1/medicines/calculate-renal-dose
// ───────────────────────────────────────────────────────
router.post(
  "/calculate-renal-dose",
  validate(renalDoseCalcSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const {
        medicineId,
        creatinineMgDl,
        ageYears,
        weightKg,
        genderMale,
      } = req.body as {
        medicineId: string;
        creatinineMgDl: number;
        ageYears: number;
        weightKg: number;
        genderMale: boolean;
      };
      const med = await prisma.medicine.findUnique({
        where: { id: medicineId },
      });
      if (!med) {
        res
          .status(404)
          .json({ success: false, data: null, error: "Medicine not found" });
        return;
      }
      // Cockcroft-Gault: CrCl = ((140 - age) * weight) / (72 * Scr) * (0.85 if female)
      let crcl = ((140 - ageYears) * weightKg) / (72 * creatinineMgDl);
      if (!genderMale) crcl *= 0.85;
      crcl = Math.round(crcl * 10) / 10;

      let stage = "NORMAL";
      if (crcl < 15) stage = "KIDNEY_FAILURE";
      else if (crcl < 30) stage = "SEVERE";
      else if (crcl < 60) stage = "MODERATE";
      else if (crcl < 90) stage = "MILD";

      let recommendation = "No dose adjustment typically required.";
      if (med.renalAdjustmentNotes) {
        recommendation = med.renalAdjustmentNotes;
      }
      // Simple heuristic recommendation on top of free-text notes
      let recommendedFactor = 1;
      if (crcl < 30) recommendedFactor = 0.5;
      else if (crcl < 60) recommendedFactor = 0.75;

      res.json({
        success: true,
        data: {
          medicine: {
            id: med.id,
            name: med.name,
            requiresRenalAdjustment: med.requiresRenalAdjustment,
            renalAdjustmentNotes: med.renalAdjustmentNotes,
          },
          inputs: { creatinineMgDl, ageYears, weightKg, genderMale },
          crClMlPerMin: crcl,
          ckdStage: stage,
          recommendedDoseFactor: recommendedFactor,
          recommendation,
          warning:
            med.requiresRenalAdjustment && crcl < 60
              ? `Renal impairment detected (CrCl ${crcl} mL/min) — dose adjustment advised.`
              : null,
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

export { router as medicineRouter };
