import { Router, Request, Response, NextFunction } from "express";
import { randomUUID } from "crypto";
import { prisma } from "@medcore/db";
import {
  Role,
  createAllergySchema,
  createConditionSchema,
  updateConditionSchema,
  createFamilyHistorySchema,
  createImmunizationSchema,
  updateImmunizationSchema,
  createDocumentSchema,
} from "@medcore/shared";
import { authenticate, authorize } from "../middleware/auth";
import { validate } from "../middleware/validate";
import { auditLog } from "../middleware/audit";

const router = Router();
router.use(authenticate);

// ───────────────────────────────────────────────────────
// Helper: verify the current user may access a given patientId
// Patients can only access their own record. Staff can access any.
// ───────────────────────────────────────────────────────
async function assertPatientAccess(
  req: Request,
  res: Response,
  patientId: string
): Promise<boolean> {
  if (!req.user) {
    res.status(401).json({ success: false, data: null, error: "Unauthorized" });
    return false;
  }

  if (req.user.role === "PATIENT") {
    const patient = await prisma.patient.findUnique({
      where: { id: patientId },
      select: { userId: true },
    });
    if (!patient || patient.userId !== req.user.userId) {
      res
        .status(403)
        .json({ success: false, data: null, error: "Forbidden" });
      return false;
    }
  }
  return true;
}

// Resolve patientId from an existing record of a given entity, so we
// can apply the same access check on non-list routes.
async function resolvePatientIdForEntity(
  entity:
    | "allergy"
    | "condition"
    | "familyHistory"
    | "immunization"
    | "document",
  id: string
): Promise<string | null> {
  switch (entity) {
    case "allergy": {
      const r = await prisma.patientAllergy.findUnique({
        where: { id },
        select: { patientId: true },
      });
      return r?.patientId ?? null;
    }
    case "condition": {
      const r = await prisma.chronicCondition.findUnique({
        where: { id },
        select: { patientId: true },
      });
      return r?.patientId ?? null;
    }
    case "familyHistory": {
      const r = await prisma.familyHistory.findUnique({
        where: { id },
        select: { patientId: true },
      });
      return r?.patientId ?? null;
    }
    case "immunization": {
      const r = await prisma.immunization.findUnique({
        where: { id },
        select: { patientId: true },
      });
      return r?.patientId ?? null;
    }
    case "document": {
      const r = await prisma.patientDocument.findUnique({
        where: { id },
        select: { patientId: true },
      });
      return r?.patientId ?? null;
    }
  }
}

// ───────────────────────────────────────────────────────
// ALLERGIES
// ───────────────────────────────────────────────────────

router.get(
  "/patients/:patientId/allergies",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!(await assertPatientAccess(req, res, req.params.patientId))) return;
      const allergies = await prisma.patientAllergy.findMany({
        where: { patientId: req.params.patientId },
        orderBy: { notedAt: "desc" },
      });
      res.json({ success: true, data: allergies, error: null });
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  "/allergies",
  authorize(Role.DOCTOR, Role.NURSE, Role.ADMIN),
  validate(createAllergySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { patientId, allergen, severity, reaction, notes } = req.body;
      const allergy = await prisma.patientAllergy.create({
        data: {
          patientId,
          allergen,
          severity,
          reaction,
          notes,
          notedBy: req.user!.userId,
        },
      });
      auditLog(req, "CREATE_ALLERGY", "patient_allergy", allergy.id, {
        patientId,
        allergen,
        severity,
      }).catch(console.error);
      res.status(201).json({ success: true, data: allergy, error: null });
    } catch (err) {
      next(err);
    }
  }
);

router.delete(
  "/allergies/:id",
  authorize(Role.DOCTOR, Role.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const allergy = await prisma.patientAllergy.findUnique({
        where: { id: req.params.id },
      });
      if (!allergy) {
        res
          .status(404)
          .json({ success: false, data: null, error: "Allergy not found" });
        return;
      }
      await prisma.patientAllergy.delete({ where: { id: req.params.id } });
      auditLog(
        req,
        "DELETE_ALLERGY",
        "patient_allergy",
        req.params.id
      ).catch(console.error);
      res.json({ success: true, data: { id: req.params.id }, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// ───────────────────────────────────────────────────────
// CHRONIC CONDITIONS
// ───────────────────────────────────────────────────────

router.get(
  "/patients/:patientId/conditions",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!(await assertPatientAccess(req, res, req.params.patientId))) return;
      const conditions = await prisma.chronicCondition.findMany({
        where: { patientId: req.params.patientId },
        orderBy: { createdAt: "desc" },
      });
      res.json({ success: true, data: conditions, error: null });
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  "/conditions",
  authorize(Role.DOCTOR, Role.ADMIN),
  validate(createConditionSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { patientId, condition, icd10Code, diagnosedDate, status, notes } =
        req.body;
      const created = await prisma.chronicCondition.create({
        data: {
          patientId,
          condition,
          icd10Code,
          diagnosedDate: diagnosedDate ? new Date(diagnosedDate) : null,
          status,
          notes,
        },
      });
      auditLog(req, "CREATE_CONDITION", "chronic_condition", created.id, {
        patientId,
        condition,
      }).catch(console.error);
      res.status(201).json({ success: true, data: created, error: null });
    } catch (err) {
      next(err);
    }
  }
);

router.patch(
  "/conditions/:id",
  authorize(Role.DOCTOR, Role.ADMIN),
  validate(updateConditionSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data: Record<string, unknown> = { ...req.body };
      if (data.diagnosedDate)
        data.diagnosedDate = new Date(data.diagnosedDate as string);
      const updated = await prisma.chronicCondition.update({
        where: { id: req.params.id },
        data,
      });
      auditLog(
        req,
        "UPDATE_CONDITION",
        "chronic_condition",
        updated.id,
        req.body
      ).catch(console.error);
      res.json({ success: true, data: updated, error: null });
    } catch (err) {
      next(err);
    }
  }
);

router.delete(
  "/conditions/:id",
  authorize(Role.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await prisma.chronicCondition.delete({ where: { id: req.params.id } });
      auditLog(
        req,
        "DELETE_CONDITION",
        "chronic_condition",
        req.params.id
      ).catch(console.error);
      res.json({ success: true, data: { id: req.params.id }, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// ───────────────────────────────────────────────────────
// FAMILY HISTORY
// ───────────────────────────────────────────────────────

router.get(
  "/patients/:patientId/family-history",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!(await assertPatientAccess(req, res, req.params.patientId))) return;
      const rows = await prisma.familyHistory.findMany({
        where: { patientId: req.params.patientId },
      });
      res.json({ success: true, data: rows, error: null });
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  "/family-history",
  authorize(Role.DOCTOR, Role.NURSE, Role.ADMIN),
  validate(createFamilyHistorySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const created = await prisma.familyHistory.create({ data: req.body });
      auditLog(
        req,
        "CREATE_FAMILY_HISTORY",
        "family_history",
        created.id,
        req.body
      ).catch(console.error);
      res.status(201).json({ success: true, data: created, error: null });
    } catch (err) {
      next(err);
    }
  }
);

router.delete(
  "/family-history/:id",
  authorize(Role.DOCTOR, Role.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await prisma.familyHistory.delete({ where: { id: req.params.id } });
      auditLog(
        req,
        "DELETE_FAMILY_HISTORY",
        "family_history",
        req.params.id
      ).catch(console.error);
      res.json({ success: true, data: { id: req.params.id }, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// ───────────────────────────────────────────────────────
// IMMUNIZATIONS
// ───────────────────────────────────────────────────────

router.get(
  "/patients/:patientId/immunizations",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!(await assertPatientAccess(req, res, req.params.patientId))) return;
      const rows = await prisma.immunization.findMany({
        where: { patientId: req.params.patientId },
        orderBy: { dateGiven: "desc" },
      });
      res.json({ success: true, data: rows, error: null });
    } catch (err) {
      next(err);
    }
  }
);

router.get(
  "/patients/:patientId/immunizations/due",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!(await assertPatientAccess(req, res, req.params.patientId))) return;
      const now = new Date();
      const rows = await prisma.immunization.findMany({
        where: {
          patientId: req.params.patientId,
          nextDueDate: { gte: now },
        },
        orderBy: { nextDueDate: "asc" },
      });
      res.json({ success: true, data: rows, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// Cross-patient schedule endpoint used by the Immunization Schedule page
router.get(
  "/immunizations/schedule",
  authorize(Role.DOCTOR, Role.NURSE, Role.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { filter = "month" } = req.query as Record<string, string>;
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      const where: Record<string, unknown> = {};
      if (filter === "week") {
        const end = new Date(today);
        end.setDate(end.getDate() + 7);
        where.nextDueDate = { gte: today, lte: end };
      } else if (filter === "month") {
        const end = new Date(today);
        end.setDate(end.getDate() + 30);
        where.nextDueDate = { gte: today, lte: end };
      } else if (filter === "overdue") {
        where.nextDueDate = { lt: today };
      } else {
        where.nextDueDate = { not: null };
      }

      const rows = await prisma.immunization.findMany({
        where,
        include: {
          patient: {
            include: { user: { select: { name: true, phone: true } } },
          },
        },
        orderBy: { nextDueDate: "asc" },
        take: 200,
      });
      res.json({ success: true, data: rows, error: null });
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  "/immunizations",
  authorize(Role.NURSE, Role.DOCTOR, Role.ADMIN),
  validate(createImmunizationSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = req.body;
      const created = await prisma.immunization.create({
        data: {
          patientId: body.patientId,
          vaccine: body.vaccine,
          doseNumber: body.doseNumber,
          dateGiven: new Date(body.dateGiven),
          administeredBy: body.administeredBy ?? req.user!.userId,
          batchNumber: body.batchNumber,
          manufacturer: body.manufacturer,
          site: body.site,
          nextDueDate: body.nextDueDate ? new Date(body.nextDueDate) : null,
          notes: body.notes,
        },
      });
      auditLog(req, "CREATE_IMMUNIZATION", "immunization", created.id, {
        patientId: body.patientId,
        vaccine: body.vaccine,
      }).catch(console.error);
      res.status(201).json({ success: true, data: created, error: null });
    } catch (err) {
      next(err);
    }
  }
);

router.patch(
  "/immunizations/:id",
  authorize(Role.NURSE, Role.DOCTOR, Role.ADMIN),
  validate(updateImmunizationSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data: Record<string, unknown> = { ...req.body };
      if (data.dateGiven) data.dateGiven = new Date(data.dateGiven as string);
      if (data.nextDueDate)
        data.nextDueDate = new Date(data.nextDueDate as string);
      const updated = await prisma.immunization.update({
        where: { id: req.params.id },
        data,
      });
      auditLog(
        req,
        "UPDATE_IMMUNIZATION",
        "immunization",
        updated.id,
        req.body
      ).catch(console.error);
      res.json({ success: true, data: updated, error: null });
    } catch (err) {
      next(err);
    }
  }
);

router.delete(
  "/immunizations/:id",
  authorize(Role.DOCTOR, Role.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await prisma.immunization.delete({ where: { id: req.params.id } });
      auditLog(
        req,
        "DELETE_IMMUNIZATION",
        "immunization",
        req.params.id
      ).catch(console.error);
      res.json({ success: true, data: { id: req.params.id }, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// ───────────────────────────────────────────────────────
// DOCUMENTS
// ───────────────────────────────────────────────────────

router.get(
  "/patients/:patientId/documents",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!(await assertPatientAccess(req, res, req.params.patientId))) return;
      const docs = await prisma.patientDocument.findMany({
        where: { patientId: req.params.patientId },
        select: {
          id: true,
          patientId: true,
          type: true,
          title: true,
          fileSize: true,
          mimeType: true,
          uploadedBy: true,
          notes: true,
          createdAt: true,
        },
        orderBy: { createdAt: "desc" },
      });
      res.json({ success: true, data: docs, error: null });
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  "/documents",
  authorize(Role.DOCTOR, Role.NURSE, Role.ADMIN, Role.RECEPTION),
  validate(createDocumentSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { patientId, type, title, notes, filePath, fileSize, mimeType } =
        req.body;

      // If the client hasn't uploaded a file yet (filePath not provided),
      // stamp a placeholder path so we can store metadata up-front.
      const sanitizedTitle = title
        .replace(/[^a-zA-Z0-9._-]+/g, "-")
        .slice(0, 64);
      const uuid = randomUUID();
      const resolvedPath =
        filePath || `uploads/ehr/${uuid}-${sanitizedTitle}`;

      const doc = await prisma.patientDocument.create({
        data: {
          patientId,
          type,
          title,
          filePath: resolvedPath,
          fileSize: fileSize ?? null,
          mimeType: mimeType ?? null,
          uploadedBy: req.user!.userId,
          notes,
        },
      });
      auditLog(req, "CREATE_DOCUMENT", "patient_document", doc.id, {
        patientId,
        type,
        title,
      }).catch(console.error);
      res.status(201).json({ success: true, data: doc, error: null });
    } catch (err) {
      next(err);
    }
  }
);

router.get(
  "/documents/:id",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const doc = await prisma.patientDocument.findUnique({
        where: { id: req.params.id },
      });
      if (!doc) {
        res
          .status(404)
          .json({ success: false, data: null, error: "Document not found" });
        return;
      }
      if (!(await assertPatientAccess(req, res, doc.patientId))) return;

      const filename = doc.filePath.split(/[\\/]/).pop() || "";
      const downloadUrl = `/api/v1/uploads/${encodeURIComponent(filename)}`;

      res.json({
        success: true,
        data: { ...doc, downloadUrl },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

router.delete(
  "/documents/:id",
  authorize(Role.DOCTOR, Role.ADMIN),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const patientId = await resolvePatientIdForEntity(
        "document",
        req.params.id
      );
      if (!patientId) {
        res
          .status(404)
          .json({ success: false, data: null, error: "Document not found" });
        return;
      }
      await prisma.patientDocument.delete({ where: { id: req.params.id } });
      auditLog(
        req,
        "DELETE_DOCUMENT",
        "patient_document",
        req.params.id
      ).catch(console.error);
      res.json({ success: true, data: { id: req.params.id }, error: null });
    } catch (err) {
      next(err);
    }
  }
);

// ───────────────────────────────────────────────────────
// PATIENT SUMMARY (dashboard)
// ───────────────────────────────────────────────────────

router.get(
  "/patients/:patientId/summary",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const patientId = req.params.patientId;
      if (!(await assertPatientAccess(req, res, patientId))) return;

      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const in90 = new Date(today);
      in90.setDate(in90.getDate() + 90);

      const [
        allergyCount,
        conditionCount,
        familyCount,
        immunizationCount,
        documentCount,
        severeAllergies,
        activeConditions,
        upcomingImmunizations,
      ] = await Promise.all([
        prisma.patientAllergy.count({ where: { patientId } }),
        prisma.chronicCondition.count({ where: { patientId } }),
        prisma.familyHistory.count({ where: { patientId } }),
        prisma.immunization.count({ where: { patientId } }),
        prisma.patientDocument.count({ where: { patientId } }),
        prisma.patientAllergy.findMany({
          where: {
            patientId,
            severity: { in: ["SEVERE", "LIFE_THREATENING"] },
          },
          orderBy: { notedAt: "desc" },
        }),
        prisma.chronicCondition.findMany({
          where: { patientId, status: "ACTIVE" },
          orderBy: { createdAt: "desc" },
        }),
        prisma.immunization.findMany({
          where: {
            patientId,
            nextDueDate: { gte: today, lte: in90 },
          },
          orderBy: { nextDueDate: "asc" },
        }),
      ]);

      res.json({
        success: true,
        data: {
          counts: {
            allergies: allergyCount,
            conditions: conditionCount,
            familyHistory: familyCount,
            immunizations: immunizationCount,
            documents: documentCount,
          },
          severeAllergies,
          activeConditions,
          upcomingImmunizations,
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  }
);

export { router as ehrRouter };
