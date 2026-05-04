import { Router, Request, Response, NextFunction } from "express";
// Multi-tenant wiring: `tenantScopedPrisma` is a Prisma $extends wrapper that
// auto-injects tenantId on create and auto-filters on read for the 20
// tenant-scoped models (see services/tenant-prisma.ts). We alias it to
// `prisma` so every existing call site keeps working without edits.
import { tenantScopedPrisma as prisma } from "../services/tenant-prisma";
import {
  Role,
  medReconciliationSchema,
  updateMedReconciliationSchema,
} from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { auditLog } from "../middleware/audit";

const router = Router();
router.use(authenticate);

// GET /api/v1/med-reconciliation?patientId=&admissionId=
// #511 BOLA: clinical PHI list — staff-only (matches POST/PATCH gating
// already on this file). Without an authorize() the bare `authenticate`
// allowed any PATIENT JWT to query reconciliations across all patients
// by passing ?patientId=<other>. Restricted to clinical roles.
router.get(
  "/",
  authorize(Role.DOCTOR, Role.NURSE, Role.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { patientId, admissionId, type } = req.query as Record<string, string>;
      const where: Record<string, unknown> = {};
      if (patientId) where.patientId = patientId;
      if (admissionId) where.admissionId = admissionId;
      if (type) where.reconciliationType = type;

      const rows = await prisma.medReconciliation.findMany({
        where,
        orderBy: { performedAt: "desc" },
        take: 100,
      });
      res.json({ success: true, data: rows, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/med-reconciliation/suggest?patientId=&admissionId=
// Auto-extract home medications from last 90 days of prescriptions.
// #511 BOLA: returns 90-day prescription history for any patientId in the
// query string — pure clinical PHI, staff-only.
router.get(
  "/suggest",
  authorize(Role.DOCTOR, Role.NURSE, Role.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { patientId, admissionId } = req.query as Record<string, string>;
      if (!patientId) {
        res.status(400).json({ success: false, data: null, error: "patientId required" });
        return;
      }
      const ninetyDaysAgo = new Date();
      ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);

      const prescriptions = await prisma.prescription.findMany({
        where: { patientId, createdAt: { gte: ninetyDaysAgo } },
        include: { items: true },
        orderBy: { createdAt: "desc" },
      });

      const seen = new Map<string, any>();
      for (const p of prescriptions) {
        for (const it of p.items) {
          const key = it.medicineName.trim().toLowerCase();
          if (!seen.has(key)) {
            seen.set(key, {
              name: it.medicineName,
              dosage: it.dosage,
              frequency: it.frequency,
              route: "",
              continued: true,
            });
          }
        }
      }

      let hospitalMeds: any[] = [];
      if (admissionId) {
        const orders = await prisma.medicationOrder.findMany({
          where: { admissionId, isActive: true },
        });
        hospitalMeds = orders.map((o) => ({
          name: o.medicineName,
          dosage: o.dosage,
          frequency: o.frequency,
          route: o.route,
          continued: true,
        }));
      }

      res.json({
        success: true,
        data: {
          homeMedications: Array.from(seen.values()),
          hospitalMedications: hospitalMeds,
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/v1/med-reconciliation/:id
// #511 BOLA: row-keyed read of full home/hospital/discharge medication
// triple — clinical reconciliation surface, staff-only (matches the rest
// of this file's authorize() gating).
router.get(
  "/:id",
  authorize(Role.DOCTOR, Role.NURSE, Role.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const rec = await prisma.medReconciliation.findUnique({
        where: { id: req.params.id },
      });
      if (!rec) {
        res.status(404).json({ success: false, data: null, error: "Not found" });
        return;
      }

      // compute diff
      const home = (rec.homeMedications as any[]) || [];
      const hospital = (rec.hospitalMedications as any[]) || [];
      const discharge = (rec.dischargeMedications as any[]) || [];
      const nameSet = (arr: any[]) => new Set(arr.map((x) => (x.name || "").toLowerCase()));
      const homeSet = nameSet(home);
      const dischargeSet = nameSet(discharge);
      const hospitalSet = nameSet(hospital);
      const diff = {
        homeContinuedOnDischarge: home.filter((x) =>
          dischargeSet.has((x.name || "").toLowerCase())
        ).map((x) => x.name),
        homeDiscontinued: home.filter((x) =>
          !dischargeSet.has((x.name || "").toLowerCase())
        ).map((x) => x.name),
        newOnDischarge: discharge.filter((x) =>
          !homeSet.has((x.name || "").toLowerCase()) &&
          !hospitalSet.has((x.name || "").toLowerCase())
        ).map((x) => x.name),
        hospitalOnly: hospital.filter((x) =>
          !homeSet.has((x.name || "").toLowerCase()) &&
          !dischargeSet.has((x.name || "").toLowerCase())
        ).map((x) => x.name),
      };

      res.json({ success: true, data: { ...rec, diff }, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/v1/med-reconciliation — create
router.post(
  "/",
  authorize(Role.DOCTOR, Role.NURSE, Role.ADMIN),
  validate(medReconciliationSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = req.body;
      // Auto-extract home meds if not provided
      let homeMedications = body.homeMedications;
      if (!homeMedications || homeMedications.length === 0) {
        const ninetyDaysAgo = new Date();
        ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
        const prescriptions = await prisma.prescription.findMany({
          where: { patientId: body.patientId, createdAt: { gte: ninetyDaysAgo } },
          include: { items: true },
        });
        const seen = new Map<string, any>();
        for (const p of prescriptions) {
          for (const it of p.items) {
            const key = it.medicineName.trim().toLowerCase();
            if (!seen.has(key)) {
              seen.set(key, {
                name: it.medicineName,
                dosage: it.dosage,
                frequency: it.frequency,
                route: "",
                continued: true,
              });
            }
          }
        }
        homeMedications = Array.from(seen.values());
      }

      const created = await prisma.medReconciliation.create({
        data: {
          patientId: body.patientId,
          admissionId: body.admissionId ?? null,
          dischargeId:
            body.reconciliationType === "DISCHARGE"
              ? body.admissionId ?? body.dischargeId ?? null
              : body.dischargeId ?? null,
          reconciliationType: body.reconciliationType,
          performedBy: req.user!.userId,
          homeMedications,
          hospitalMedications: body.hospitalMedications ?? [],
          dischargeMedications: body.dischargeMedications ?? [],
          changes: body.changes ?? { added: [], removed: [], modified: [] },
          patientCounseled: body.patientCounseled ?? false,
          notes: body.notes ?? null,
        },
      });
      auditLog(req, "MED_RECONCILIATION_CREATE", "med_reconciliation", created.id, {
        patientId: body.patientId,
        type: body.reconciliationType,
      }).catch(console.error);
      res.status(201).json({ success: true, data: created, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// PATCH /api/v1/med-reconciliation/:id
router.patch(
  "/:id",
  authorize(Role.DOCTOR, Role.NURSE, Role.ADMIN),
  validate(updateMedReconciliationSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data: Record<string, unknown> = { ...req.body };
      const updated = await prisma.medReconciliation.update({
        where: { id: req.params.id },
        data,
      });
      auditLog(
        req,
        "MED_RECONCILIATION_UPDATE",
        "med_reconciliation",
        updated.id,
        req.body
      ).catch(console.error);
      res.json({ success: true, data: updated, error: null });
    } catch (err) {
      next(err);
    }
  }
);

export { router as medReconciliationRouter };
